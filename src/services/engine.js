// Construction intelligence rules engine.
// Plan -> Actual -> Plan vs Actual -> Blocker -> Dependency impact -> Risk -> Escalation -> Notification.
// Deliberately rules-based and transparent: every output carries a human-readable reason.

import {
  Activity, Dependency, Blocker, ProgressUpdate, Risk, Escalation, Notification, Project, StructureNode, ExecutionLog,
} from '../models/index.js';
import { OPEN_BLOCKER_STATUSES, severityRank } from '../models/constants.js';
import { getRules } from './settings.js';
import { audit } from './audit.js';
import { today, toDay, addDays, diffDays, maxDate, fmt } from '../utils/dates.js';

export function plannedDuration(activity) {
  return Math.max(1, diffDays(activity.plannedFinish, activity.plannedStart) + 1);
}

// Linear planned progress, measured at the end of the given day.
export function plannedProgressOn(activity, day) {
  const d = toDay(day);
  if (d < toDay(activity.plannedStart)) return 0;
  if (d >= toDay(activity.plannedFinish)) return 100;
  return Math.round(((diffDays(d, activity.plannedStart) + 1) / plannedDuration(activity)) * 100);
}

function groupBy(items, key) {
  const map = new Map();
  for (const item of items) {
    const k = String(item[key]);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

function topoSort(activities, deps) {
  const indegree = new Map(activities.map((a) => [a.id, 0]));
  const succ = groupBy(deps, 'predecessor');
  for (const d of deps) {
    const k = String(d.successor);
    if (indegree.has(k)) indegree.set(k, indegree.get(k) + 1);
  }
  const byId = new Map(activities.map((a) => [a.id, a]));
  const queue = activities.filter((a) => indegree.get(a.id) === 0);
  const order = [];
  while (queue.length) {
    const a = queue.shift();
    order.push(a);
    for (const d of succ.get(a.id) || []) {
      const k = String(d.successor);
      indegree.set(k, indegree.get(k) - 1);
      if (indegree.get(k) === 0 && byId.has(k)) queue.push(byId.get(k));
    }
  }
  // Any remaining (cycle) activities are appended so they are still evaluated.
  for (const a of activities) if (!order.includes(a)) order.push(a);
  return order;
}

export async function buildLocationMap(projectId) {
  const nodes = await StructureNode.find({ project: projectId }).lean();
  const byId = new Map(nodes.map((n) => [String(n._id), n]));
  const path = (id) => {
    const parts = [];
    let n = byId.get(String(id));
    while (n) {
      parts.unshift(n.name);
      n = n.parent ? byId.get(String(n.parent)) : null;
    }
    return parts.join(' › ');
  };
  return { path, nodes };
}

function classifySeverity({ delayDays, progressVariance, impactDays, blocker }, rules) {
  const { high, medium } = rules.severity;
  const behind = -Math.min(0, progressVariance);
  let sev = 'Low';
  if (delayDays >= medium.delayDays || behind >= medium.progressVariance || impactDays >= medium.impactDays) sev = 'Medium';
  if (delayDays >= high.delayDays || behind >= high.progressVariance || impactDays >= high.impactDays) sev = 'High';
  if (blocker && severityRank(blocker.severity) > severityRank(sev)) sev = blocker.severity;
  return sev;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function manpowerText(mp) {
  return `${mp.trade ? `${mp.trade} ` : ''}manpower shortfall (${mp.actual} of ${mp.planned} planned)`;
}

function buildRiskMessage({ activity, location, m, blocker, impacted }) {
  const where = location ? ` (${location})` : '';
  let msg;
  if (m.scheduleVarianceDays > 0) msg = `${activity.name}${where} is ${plural(m.scheduleVarianceDays, 'day')} behind schedule`;
  else if (blocker) msg = `${activity.name}${where} is blocked`;
  else msg = `${activity.name}${where} is behind plan`;
  if (m.progressVariance < 0) msg += ` (${m.actualProgress}% done vs ${m.plannedProgress}% planned)`;
  if (blocker) msg += ` because of a ${blocker.type} blocker: ${blocker.description}`;
  if (m.manpower?.short) msg += `${blocker ? ', with a' : ' because of a'} ${manpowerText(m.manpower)}`;
  if (impacted.length) {
    const names = impacted.slice(0, 3).map((i) => `${i.name} (+${i.delayDays}d)`);
    const more = impacted.length > 3 ? ` and ${impacted.length - 3} more` : '';
    msg += `. This may affect ${names.join(', ')}${more}.`;
  } else {
    msg += '.';
  }
  return msg;
}

function buildNotificationText({ activity, m, blocker, impacted }) {
  const head = m.scheduleVarianceDays > 0
    ? `${activity.name} delayed by ${plural(m.scheduleVarianceDays, 'day')}.`
    : `${activity.name} ${blocker ? 'blocked' : 'behind plan'} (${m.progressVariance}%).`;
  let reason = blocker ? ` Reason: ${blocker.type} - ${blocker.description}.` : ` Reason: progress ${m.actualProgress}% vs ${m.plannedProgress}% planned.`;
  if (m.manpower?.short) reason += ` ${manpowerText(m.manpower).replace(/^./, (c) => c.toUpperCase())}.`;
  const impact = impacted.length ? ` Potential impact: ${impacted.map((i) => i.name).slice(0, 3).join(', ')}.` : '';
  return `${head}${reason}${impact} Action required: Review.`;
}

async function resolveEscalationTarget(role, activity, project) {
  if (role === 'site_engineer') return activity.responsible || project.siteManager || project.projectManager;
  if (role === 'site_manager') return project.siteManager || project.projectManager;
  if (role === 'project_manager') return project.projectManager || project.siteManager;
  return project.projectManager;
}

async function escalate(risk, activity, project, rules, notificationText) {
  if (severityRank(risk.severity) < severityRank(rules.escalation.minSeverity)) return;
  const role = rules.escalation.map[risk.severity];
  const target = await resolveEscalationTarget(role, activity, project);
  if (!target) return;
  const esc = await Escalation.create({
    project: project._id, risk: risk._id, activity: activity._id,
    severity: risk.severity, level: role, escalatedTo: target, reason: risk.message,
  });
  risk.escalatedTo = target;
  risk.history.push({ event: `Escalated to ${role.replace('_', ' ')}`, severity: risk.severity, message: risk.message });
  await Notification.create({
    user: target, type: risk.severity === 'High' ? 'critical' : 'warning',
    title: `${risk.severity} risk: ${activity.name}`,
    message: notificationText, link: `/activities/${activity._id}`,
    risk: risk._id, activity: activity._id,
  });
  await audit(null, 'Risk escalated', {
    entityType: 'Escalation', entityId: esc._id, project: project._id, activity: activity._id,
    newValue: { severity: risk.severity, level: role }, comment: risk.message,
  });
}

// Serialise evaluations per project so concurrent requests can't double-create risks.
const locks = new Map();
export function evaluateProject(projectId) {
  const key = String(projectId);
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => runEvaluation(projectId));
  locks.set(key, next);
  return next;
}

async function runEvaluation(projectId) {
  const rules = await getRules();
  const asOf = today();
  const project = await Project.findById(projectId);
  if (!project) return null;

  const [activities, deps, openBlockers, updates, openRisks, location, execLogs] = await Promise.all([
    Activity.find({ project: projectId }),
    Dependency.find({ project: projectId }).lean(),
    Blocker.find({ project: projectId, status: { $in: OPEN_BLOCKER_STATUSES } }).sort({ reportedDate: 1 }).lean(),
    ProgressUpdate.find({ project: projectId }).sort({ date: 1, createdAt: 1 }).lean(),
    Risk.find({ project: projectId, status: 'Open' }),
    buildLocationMap(projectId),
    ExecutionLog.find({ project: projectId, date: { $lte: asOf } }, 'activity date manpower').sort({ date: 1 }).lean(),
  ]);
  const execBy = groupBy(execLogs, 'activity');

  const byId = new Map(activities.map((a) => [a.id, a]));
  const preds = groupBy(deps, 'successor');
  const succs = groupBy(deps, 'predecessor');
  const updatesBy = groupBy(updates, 'activity');
  const blockersBy = groupBy(openBlockers, 'activity');
  const metrics = new Map();
  const { status: S, forecast } = rules;

  // ---- Pass 1: plan vs actual + forecast, in dependency order so delays propagate downstream.
  for (const a of topoSort(activities, deps)) {
    const duration = plannedDuration(a);
    const ups = updatesBy.get(a.id) || [];
    const latest = ups.at(-1);
    const actual = latest?.actualProgress ?? 0;
    const started = ups.find((u) => u.actualProgress > 0);
    const done = ups.find((u) => u.actualProgress >= 100);
    const completed = actual >= 100;
    const actualStart = started ? toDay(started.date) : null;
    const actualFinish = completed && done ? toDay(done.date) : null;
    // Today's work isn't due until end of day: until today's update arrives, compare against yesterday's plan.
    const reportedToday = latest && toDay(latest.date).getTime() === asOf.getTime();
    const plannedProgress = plannedProgressOn(a, reportedToday ? asOf : addDays(asOf, -1));
    const blockers = blockersBy.get(a.id) || [];
    const blockerResume = blockers.length
      ? maxDate(addDays(asOf, 1), ...blockers.map((b) => b.expectedResolution))
      : null;

    // Earliest start allowed by Finish -> Start predecessors.
    let predConstraint = null;
    const impactedBy = [];
    for (const d of preds.get(a.id) || []) {
      const pm = metrics.get(String(d.predecessor));
      if (!pm) continue;
      const pf = pm.actualFinish || pm.expectedFinish;
      const allowed = addDays(pf, 1 + (d.lagDays || 0));
      predConstraint = maxDate(predConstraint, allowed);
      if (!actualStart && allowed > toDay(a.plannedStart)) {
        impactedBy.push({ activity: d.predecessor, name: byId.get(String(d.predecessor))?.name, delayDays: diffDays(allowed, a.plannedStart) });
      }
    }

    let expectedStart;
    let expectedFinish;
    if (completed) {
      expectedStart = actualStart || actualFinish;
      expectedFinish = actualFinish;
    } else if (actualStart) {
      const ref = toDay(latest.date);
      const elapsed = Math.max(1, diffDays(ref, actualStart) + 1);
      const plannedRate = 100 / duration;
      const rate = Math.max(actual / elapsed, plannedRate * forecast.minProductivityFactor);
      // Small tolerance so rounded percentages (e.g. 33% of a 3-day task) don't add a phantom day.
      const remainingDays = Math.max(1, Math.ceil((100 - actual) / rate - 0.1));
      const resume = maxDate(addDays(ref, 1), asOf, blockerResume);
      expectedStart = actualStart;
      expectedFinish = addDays(resume, remainingDays - 1);
    } else {
      expectedStart = maxDate(a.plannedStart, asOf, predConstraint, blockerResume);
      expectedFinish = addDays(expectedStart, duration - 1);
    }

    const scheduleVarianceDays = diffDays(expectedFinish, a.plannedFinish);
    const baselineVarianceDays = a.baseline?.finish ? diffDays(expectedFinish, a.baseline.finish) : null;
    const progressVariance = actual - plannedProgress;

    // Execution team's latest daily report: manpower deployed vs planned (worst trade).
    let manpower = null;
    const lastLog = (execBy.get(a.id) || []).at(-1);
    if (lastLog?.manpower?.length && !completed) {
      const planned = lastLog.manpower.reduce((s, x) => s + (x.planned || 0), 0);
      const actualMp = lastLog.manpower.reduce((s, x) => s + (x.actual || 0), 0);
      const worst = [...lastLog.manpower].filter((x) => x.planned).sort((x, y) => x.actual / x.planned - y.actual / y.planned)[0];
      const short = worst && worst.actual / worst.planned < rules.execution.manpowerShortfallRatio;
      manpower = short
        ? { date: lastLog.date, trade: worst.trade, planned: worst.planned, actual: worst.actual, short: true }
        : { date: lastLog.date, planned, actual: actualMp, short: false };
    }
    const waitingOnPredecessor = !actualStart && predConstraint && predConstraint > maxDate(a.plannedStart, asOf);

    let health = 'On Track';
    let ownCause = false;
    let healthReason = 'Progressing as planned';
    if (blockers.length) {
      health = 'Blocked';
      ownCause = true;
      healthReason = `${blockers[0].type} blocker: ${blockers[0].description}`;
    } else if (completed) {
      healthReason = actualFinish ? `Completed on ${fmt(actualFinish)}` : 'Completed';
    } else if (waitingOnPredecessor || toDay(a.plannedStart) > asOf) {
      // Not yet due to start: can only be affected by upstream delays.
      if (scheduleVarianceDays >= S.atRiskDelayDays) {
        health = 'At Risk';
        healthReason = `Waiting on ${impactedBy.map((i) => i.name).join(', ') || 'predecessor'} (+${scheduleVarianceDays}d)`;
      }
    } else if (-progressVariance >= S.delayedProgressVariance || scheduleVarianceDays >= S.delayedDelayDays) {
      health = 'Delayed';
      ownCause = true;
      healthReason = `Progress ${actual}% vs ${plannedProgress}% planned; expected finish +${Math.max(0, scheduleVarianceDays)}d`;
    } else if (-progressVariance >= S.atRiskProgressVariance || scheduleVarianceDays >= S.atRiskDelayDays) {
      health = 'At Risk';
      ownCause = true;
      healthReason = `Progress ${actual}% vs ${plannedProgress}% planned`;
    }

    if (ownCause && manpower?.short && health !== 'On Track') healthReason += `; ${manpowerText(manpower)}`;

    let status = 'Planned';
    if (blockers.length) status = 'Blocked';
    else if (completed) status = 'Completed';
    else if (health === 'Delayed') status = 'Delayed';
    else if (actualStart) status = 'In Progress';

    metrics.set(a.id, {
      plannedProgress, actualProgress: actual, actualQuantity: latest?.actualQuantity ?? 0,
      progressVariance, actualStart, actualFinish, expectedStart, expectedFinish,
      scheduleVarianceDays, baselineVarianceDays, manpower, impactedBy, healthReason, lastUpdateAt: latest?.date || null,
      evaluatedAt: new Date(), health, status, ownCause, completed, blockers,
    });
  }

  // ---- Pass 2: persist activity state, recording status changes in the audit trail.
  for (const a of activities) {
    const m = metrics.get(a.id);
    const prevStatus = a.status;
    const prevHealth = a.health;
    a.status = m.status;
    a.health = m.health;
    a.plannedDuration = plannedDuration(a);
    a.metrics = {
      plannedProgress: m.plannedProgress, actualProgress: m.actualProgress, actualQuantity: m.actualQuantity,
      progressVariance: m.progressVariance, actualStart: m.actualStart, actualFinish: m.actualFinish,
      expectedStart: m.expectedStart, expectedFinish: m.expectedFinish,
      scheduleVarianceDays: m.scheduleVarianceDays, baselineVarianceDays: m.baselineVarianceDays,
      manpower: m.manpower, impactedBy: m.impactedBy,
      healthReason: m.healthReason, lastUpdateAt: m.lastUpdateAt, evaluatedAt: m.evaluatedAt,
    };
    await a.save();
    if (prevStatus !== m.status || prevHealth !== m.health) {
      await audit(null, 'Status changed', {
        entityType: 'Activity', entityId: a._id, project: projectId, activity: a._id, field: 'status/health',
        previousValue: `${prevStatus} / ${prevHealth}`, newValue: `${m.status} / ${m.health}`, comment: m.healthReason,
      });
    }
  }

  // ---- Pass 3: dependency impact -> risk -> escalation.
  const descendants = (id) => {
    const seen = new Set();
    const stack = [id];
    while (stack.length) {
      for (const d of succs.get(stack.pop()) || []) {
        const k = String(d.successor);
        if (!seen.has(k)) { seen.add(k); stack.push(k); }
      }
    }
    return [...seen];
  };

  const risksByActivity = new Map(openRisks.map((r) => [String(r.activity), r]));
  const stillOpen = new Set();

  for (const a of activities) {
    const m = metrics.get(a.id);
    const impacted = descendants(a.id)
      .map((id) => ({ id, act: byId.get(id), mm: metrics.get(id) }))
      .filter(({ act, mm }) => act && mm && !mm.completed && mm.scheduleVarianceDays > 0)
      .map(({ act, mm }) => ({ activity: act._id, name: act.name, delayDays: mm.scheduleVarianceDays }));
    const impactDays = impacted.length ? Math.max(...impacted.map((i) => i.delayDays)) : 0;

    const raise = m.ownCause && (
      m.health === 'Delayed' || m.health === 'Blocked'
      || (m.health === 'At Risk' && impactDays >= rules.risk.minImpactDaysForAtRisk)
    );
    if (!raise) continue;

    const blocker = m.blockers[0] || null;
    const ctx = { activity: a, location: location.path(a.structureNode), m, blocker, impacted };
    const severity = classifySeverity({
      delayDays: Math.max(0, m.scheduleVarianceDays), progressVariance: m.progressVariance, impactDays, blocker,
    }, rules);
    const message = buildRiskMessage(ctx);
    const notificationText = buildNotificationText(ctx);
    const fields = {
      activityHealth: m.health, progressVariance: m.progressVariance,
      delayDays: Math.max(0, m.scheduleVarianceDays), blocker: blocker?._id || null,
      blockerType: blocker?.type || null, impacted, expectedImpactDays: impactDays || Math.max(0, m.scheduleVarianceDays),
      message,
    };

    let risk = risksByActivity.get(a.id);
    if (!risk) {
      risk = new Risk({ project: projectId, activity: a._id, severity, ...fields });
      risk.history.push({ event: 'Risk raised', severity, message });
      await risk.save();
      await audit(null, 'Risk created', {
        entityType: 'Risk', entityId: risk._id, project: projectId, activity: a._id,
        newValue: { severity, health: m.health }, comment: message,
      });
      await escalate(risk, a, project, rules, notificationText);
      await risk.save();
    } else {
      const prevSeverity = risk.severity;
      const changed = risk.message !== message || prevSeverity !== severity;
      Object.assign(risk, fields, { severity });
      if (changed) {
        risk.history.push({ event: prevSeverity !== severity ? `Severity ${prevSeverity} → ${severity}` : 'Risk updated', severity, message });
      }
      if (severityRank(severity) > severityRank(prevSeverity)) await escalate(risk, a, project, rules, notificationText);
      await risk.save();
    }
    stillOpen.add(String(risk._id));
  }

  // Close risks whose triggering condition no longer holds (e.g. blocker resolved, progress recovered).
  for (const risk of openRisks) {
    if (stillOpen.has(String(risk._id))) continue;
    const act = byId.get(String(risk.activity));
    const m = act && metrics.get(act.id);
    const reason = m ? `Condition cleared: ${act.name} is now ${m.health} (${m.healthReason}).` : 'Activity removed.';
    risk.status = 'Closed';
    risk.closedAt = new Date();
    risk.history.push({ event: 'Risk closed', severity: risk.severity, message: reason });
    await risk.save();
    await audit(null, 'Risk closed', { entityType: 'Risk', entityId: risk._id, project: projectId, activity: risk.activity, comment: reason });
    if (risk.escalatedTo) {
      await Notification.create({
        user: risk.escalatedTo, type: 'success', title: `Risk closed: ${act?.name || 'activity'}`,
        message: reason, link: act ? `/activities/${act._id}` : undefined, risk: risk._id, activity: risk.activity,
      });
    }
  }

  project.lastEvaluatedAt = new Date();
  await project.save();
  return { evaluated: activities.length, openRisks: stillOpen.size };
}

export async function evaluateAllProjects() {
  const projects = await Project.find({}, '_id').lean();
  for (const p of projects) await evaluateProject(p._id);
}
