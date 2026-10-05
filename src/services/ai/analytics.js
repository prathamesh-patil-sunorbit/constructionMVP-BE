// Deterministic project analytics: the single source of every number the AI layer reports.
//
// Nothing here calls a language model. Dates, quantities, percentages, costs, labour, material
// and equipment figures are computed in JavaScript from MongoDB so they are reproducible and
// auditable. The agents in agents.js turn this output into language; they may not invent values.
//
// Where the data needed for a calculation does not exist, the result carries
// `insufficientData: true` plus the reason, instead of a guess.

import {
  Activity, Dependency, Project, Blocker, ProgressUpdate, Estimate, ExecutionLog, Risk,
  InventoryItem, InventoryTxn, LabourAttendance, SiteReport, CameraObservation,
} from '../../models/index.js';
import { categoryOf } from '../building.js';
import { OPEN_BLOCKER_STATUSES } from '../../models/constants.js';
import { getRules } from '../settings.js';
import { buildLocationMap, plannedDuration } from '../engine.js';
import { today, toDay, addDays, diffDays, maxDate, fmt, sameDay } from '../../utils/dates.js';

const round = (n, dp = 0) => {
  const f = 10 ** dp;
  return Math.round((Number(n) || 0) * f) / f;
};
const sum = (items, pick) => items.reduce((t, x) => t + (Number(pick(x)) || 0), 0);
const share = (part, whole) => (whole > 0 ? part / whole : 0);

function groupBy(items, key) {
  const map = new Map();
  for (const item of items) {
    const k = String(typeof key === 'function' ? key(item) : item[key]);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Schedule forecasting
// ---------------------------------------------------------------------------

/**
 * Re-runs the rules engine's forecast under a productivity scenario, so best/worst cases and
 * what-if simulations come from the same dependency propagation as the live figures.
 *
 * @param {object} opts
 * @param {number} opts.rateMultiplier     Applied to the planned (or observed) rate.
 * @param {number} opts.blockerBufferDays  Extra days before a blocker is assumed to clear.
 * @param {boolean} opts.useObservedRate   Scale observed productivity instead of planned.
 * @param {Function} [opts.adjust]         Per-activity override: id => {rateMultiplier, extraDays}.
 * @param {number} [opts.startFloorShiftDays] Pushes the earliest possible start for all work,
 *   used for site-wide stoppages so the loss is counted once instead of per activity.
 * @returns {{finish: Date, perActivity: Map<string, Date>}|null}
 */
export function scenarioForecast(activities, deps, state, {
  rateMultiplier, blockerBufferDays, useObservedRate, adjust, startFloorShiftDays = 0,
}) {
  const asOf = addDays(today(), startFloorShiftDays);
  const byId = new Map(activities.map((a) => [String(a._id), a]));
  const preds = groupBy(deps, 'successor');
  const indegree = new Map(activities.map((a) => [String(a._id), 0]));
  for (const d of deps) {
    const k = String(d.successor);
    if (indegree.has(k)) indegree.set(k, indegree.get(k) + 1);
  }
  const succs = groupBy(deps, 'predecessor');
  const queue = activities.filter((a) => indegree.get(String(a._id)) === 0);
  const order = [];
  while (queue.length) {
    const a = queue.shift();
    order.push(a);
    for (const d of succs.get(String(a._id)) || []) {
      const k = String(d.successor);
      indegree.set(k, indegree.get(k) - 1);
      if (indegree.get(k) === 0 && byId.has(k)) queue.push(byId.get(k));
    }
  }
  for (const a of activities) if (!order.includes(a)) order.push(a);

  const finishes = new Map();
  for (const a of order) {
    const id = String(a._id);
    const s = state.get(id);
    const duration = plannedDuration(a);
    if (s.completed) {
      finishes.set(id, s.actualFinish || toDay(a.plannedFinish));
      continue;
    }
    const tweak = adjust?.(id) || {};
    const rate0 = (tweak.rateMultiplier ?? 1) * rateMultiplier;
    const extraDays = tweak.extraDays || 0;

    let predConstraint = null;
    for (const d of preds.get(id) || []) {
      const pf = finishes.get(String(d.predecessor));
      if (pf) predConstraint = maxDate(predConstraint, addDays(pf, 1 + (d.lagDays || 0)));
    }
    const resume = s.blockerResume ? addDays(s.blockerResume, blockerBufferDays) : null;

    let finish;
    if (s.actualStart && s.lastUpdateDate) {
      const plannedRate = 100 / duration;
      const elapsed = Math.max(1, diffDays(s.lastUpdateDate, s.actualStart) + 1);
      const observed = s.actualProgress / elapsed;
      const rate = Math.max(
        useObservedRate ? observed * rate0 : plannedRate * rate0,
        plannedRate * 0.1,
      );
      const remainingDays = Math.max(1, Math.ceil((100 - s.actualProgress) / rate - 0.1));
      const start = maxDate(addDays(s.lastUpdateDate, 1), asOf, resume);
      finish = addDays(start, remainingDays - 1 + extraDays);
    } else {
      const start = maxDate(a.plannedStart, asOf, predConstraint, resume);
      const scaled = Math.max(1, Math.ceil(duration / Math.max(rate0, 0.1)));
      finish = addDays(start, scaled - 1 + extraDays);
    }
    finishes.set(id, maxDate(finish, predConstraint));
  }
  const open = activities.filter((a) => !state.get(String(a._id)).completed);
  if (!open.length) return null;
  return { finish: maxDate(...open.map((a) => finishes.get(String(a._id)))), perActivity: finishes };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * Normalised, compact view of one project. This is the only context passed to the model: the
 * whole database is never sent.
 */
export async function buildProjectSnapshot(projectId) {
  const rules = await getRules();
  const asOf = today();
  const project = await Project.findById(projectId).populate('projectManager siteManager', 'name role').lean();
  if (!project) {
    const err = new Error('Project not found');
    err.status = 404;
    throw err;
  }

  const [activities, deps, blockers, updates, estimates, execLogs, risks, location, inventory, inventoryTxns, attendance, siteReports, cameras] = await Promise.all([
    Activity.find({ project: projectId }).populate('responsible', 'name').lean(),
    Dependency.find({ project: projectId }).lean(),
    Blocker.find({ project: projectId }).sort({ reportedDate: -1 }).lean(),
    ProgressUpdate.find({ project: projectId }).sort({ date: 1, createdAt: 1 }).lean(),
    Estimate.find({ project: projectId }).lean(),
    ExecutionLog.find({ project: projectId }).sort({ date: 1 }).lean(),
    Risk.find({ project: projectId, status: 'Open' }).populate('escalatedTo', 'name role').lean(),
    buildLocationMap(projectId),
    InventoryItem.find({ project: projectId }).lean(),
    InventoryTxn.find({ project: projectId }).sort({ date: 1 }).lean(),
    LabourAttendance.find({ project: projectId }).sort({ date: 1 }).lean(),
    SiteReport.find({ project: projectId }).sort({ date: -1 }).limit(30).populate('reportedBy', 'name').lean(),
    CameraObservation.find({ project: projectId }).sort({ createdAt: -1 }).limit(20).lean(),
  ]);

  const openBlockers = blockers.filter((b) => OPEN_BLOCKER_STATUSES.includes(b.status));
  const estimatesBy = groupBy(estimates, 'activity');
  const logsBy = groupBy(execLogs, 'activity');
  const updatesBy = groupBy(updates, 'activity');
  const blockersBy = groupBy(openBlockers, 'activity');

  // Per-activity state for forecasting, plus the weight used for progress roll-up.
  const state = new Map();
  const rows = activities.map((a) => {
    const id = String(a._id);
    const ups = updatesBy.get(id) || [];
    const latest = ups.at(-1);
    const started = ups.find((u) => u.actualProgress > 0);
    const done = ups.find((u) => u.actualProgress >= 100);
    const actualProgress = latest?.actualProgress ?? 0;
    const acts = blockersBy.get(id) || [];
    const est = estimatesBy.get(id) || [];
    const amount = sum(est, (e) => e.amount);
    state.set(id, {
      completed: actualProgress >= 100,
      actualStart: started ? toDay(started.date) : null,
      actualFinish: done ? toDay(done.date) : null,
      lastUpdateDate: latest ? toDay(latest.date) : null,
      actualProgress,
      blockerResume: acts.length ? maxDate(addDays(asOf, 1), ...acts.map((b) => b.expectedResolution)) : null,
    });
    return {
      id,
      code: a.code,
      name: a.name,
      location: location.path(a.structureNode),
      responsible: a.responsible?.name || null,
      priority: a.priority,
      status: a.status,
      health: a.health,
      healthReason: a.metrics?.healthReason || null,
      plannedStart: a.plannedStart,
      plannedFinish: a.plannedFinish,
      expectedFinish: a.metrics?.expectedFinish || null,
      baselineFinish: a.baseline?.finish || null,
      plannedProgress: a.metrics?.plannedProgress ?? 0,
      actualProgress,
      progressVariance: a.metrics?.progressVariance ?? 0,
      slipDays: Math.max(0, a.metrics?.scheduleVarianceDays ?? 0),
      plannedQuantity: a.plannedQuantity ?? null,
      actualQuantity: a.metrics?.actualQuantity ?? 0,
      unit: a.unit || null,
      lastUpdateAt: a.metrics?.lastUpdateAt || null,
      manpower: a.metrics?.manpower || null,
      impactedBy: (a.metrics?.impactedBy || []).map((i) => i.name).filter(Boolean),
      blockers: acts.map((b) => ({ type: b.type, description: b.description, severity: b.severity, status: b.status, expectedResolution: b.expectedResolution })),
      estimateAmount: amount || null,
      // Estimated cost is the only comparable weight across trades; planned quantities are not
      // (2,400 sq.ft of blockwork against 12 MT of steel), so duration is the fallback.
      weight: amount || plannedDuration(a),
      plannedDurationDays: plannedDuration(a),
      structureNode: a.structureNode ? String(a.structureNode) : null,
      activeInWindow: toDay(a.plannedStart) <= addDays(asOf, rules.ai.lookaheadDays) && toDay(a.plannedFinish) >= asOf && actualProgress < 100,
    };
  });

  const totalWeight = sum(rows, (r) => r.weight);
  const overallProgress = round(sum(rows, (r) => r.weight * r.actualProgress) / (totalWeight || 1), 1);
  const plannedProgress = round(sum(rows, (r) => r.weight * r.plannedProgress) / (totalWeight || 1), 1);

  return {
    asOf,
    rules,
    project: {
      id: String(project._id),
      code: project.code,
      name: project.name,
      location: project.location,
      status: project.status,
      startDate: project.startDate,
      plannedCompletionDate: project.plannedCompletionDate,
      projectManager: project.projectManager?.name || null,
      siteManager: project.siteManager?.name || null,
      lastEvaluatedAt: project.lastEvaluatedAt,
    },
    progress: {
      overall: overallProgress,
      planned: plannedProgress,
      variance: round(overallProgress - plannedProgress, 1),
      weightBasis: estimates.length ? 'estimated cost' : 'planned duration',
      counts: rows.reduce((acc, r) => {
        acc.total += 1;
        acc[r.health] = (acc[r.health] || 0) + 1;
        if (r.status === 'Completed') acc.Completed += 1;
        return acc;
      }, { total: 0, 'On Track': 0, 'At Risk': 0, Delayed: 0, Blocked: 0, Completed: 0 }),
    },
    activities: rows,
    dependencies: deps.map((d) => ({ predecessor: String(d.predecessor), successor: String(d.successor), lagDays: d.lagDays })),
    blockers: blockers.map((b) => ({
      id: String(b._id), activity: String(b.activity), type: b.type, description: b.description,
      severity: b.severity, status: b.status, reportedDate: b.reportedDate, expectedResolution: b.expectedResolution,
    })),
    risks: risks.map((r) => ({
      id: String(r._id), activity: String(r.activity), severity: r.severity, message: r.message,
      delayDays: r.delayDays, expectedImpactDays: r.expectedImpactDays, escalatedTo: r.escalatedTo?.name || null,
    })),
    estimates,
    execLogs,
    inventory,
    inventoryTxns,
    attendance,
    siteReports: siteReports.map((r) => ({
      id: String(r._id), date: r.date, reportedBy: r.reportedBy?.name || null,
      labourPresent: (r.labour || []).reduce((t, l) => t + (l.present || 0), 0),
      remarks: r.remarks, weather: r.weather, issues: r.issues,
    })),
    cameras: cameras.map((c) => ({
      id: String(c._id), caption: c.caption, createdAt: c.createdAt,
      verification: c.verification?.status, aiGenerated: c.analysis?.aiGenerated,
      workers: c.analysis?.workers, progressEstimate: c.analysis?.progressEstimate,
    })),
    _internal: { state, activityDocs: activities, deps, estimatesBy, logsBy, updatesBy, inventory, inventoryTxns, attendance },
  };
}

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

// Confidence reflects how much of the project is actually reported, not how sure the model feels.
export function dataConfidence(snap) {
  const { activities, execLogs, estimates, asOf, rules } = snap;
  const open = activities.filter((a) => a.actualProgress < 100);
  const started = activities.filter((a) => a.actualProgress > 0 && a.actualProgress < 100);
  const freshDays = rules.ai.freshUpdateDays;
  const freshlyReported = started.filter((a) => a.lastUpdateAt && diffDays(asOf, a.lastUpdateAt) <= freshDays);
  const recentLogs = execLogs.filter((l) => diffDays(asOf, l.date) <= 7);
  const loggedActivities = new Set(recentLogs.map((l) => String(l.activity)));
  const estimated = new Set(estimates.map((e) => String(e.activity)));

  const components = {
    reporting: round(share(freshlyReported.length, started.length || 1), 2),
    estimateCoverage: round(share(activities.filter((a) => estimated.has(a.id)).length, activities.length || 1), 2),
    executionReporting: round(share(open.filter((a) => loggedActivities.has(a.id)).length, open.length || 1), 2),
    blockerClarity: round(share(
      snap.blockers.filter((b) => OPEN_BLOCKER_STATUSES.includes(b.status) && b.expectedResolution).length,
      snap.blockers.filter((b) => OPEN_BLOCKER_STATUSES.includes(b.status)).length || 1,
    ), 2),
  };
  const score = 0.45 * components.reporting
    + 0.2 * components.estimateCoverage
    + 0.2 * components.executionReporting
    + 0.15 * components.blockerClarity;
  const confidence = Math.max(10, Math.min(95, Math.round(score * 100)));
  const insufficient = started.length > 0 && components.reporting < 0.2;
  return {
    confidence,
    components,
    insufficientData: insufficient,
    reason: insufficient
      ? `Only ${freshlyReported.length} of ${started.length} in-progress activities were updated in the last ${freshDays} days.`
      : null,
    basis: [
      `${freshlyReported.length} of ${started.length || 0} in-progress activities reported within ${freshDays} days`,
      `${Math.round(components.estimateCoverage * 100)}% of activities have an approved estimate`,
      `${recentLogs.length} execution reports in the last 7 days`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Completion prediction
// ---------------------------------------------------------------------------

export function completionForecast(snap) {
  const { activities, _internal, rules } = snap;
  const open = activities.filter((a) => a.actualProgress < 100);
  // The forecast is compared against the end of the planned activities, not the project's
  // contractual completion date: those are only the same once the plan covers the full scope.
  const scheduleEnd = maxDate(...activities.map((a) => a.plannedFinish));
  const projectCompletion = snap.project.plannedCompletionDate ? toDay(snap.project.plannedCompletionDate) : null;
  const coversFullScope = !projectCompletion || !scheduleEnd
    || Math.abs(diffDays(projectCompletion, scheduleEnd)) <= rules.ai.scheduleCoverageToleranceDays;

  if (!open.length) {
    return {
      plannedCompletion: scheduleEnd, projectCompletion, coversFullScope,
      expected: null, best: null, worst: null, delayDays: 0,
      complete: true, basis: ['All activities are complete.'],
    };
  }
  const expected = maxDate(...open.map((a) => a.expectedFinish || a.plannedFinish));
  const scenarios = rules.ai.scenarios;
  const rawBest = scenarioForecast(_internal.activityDocs, _internal.deps, _internal.state, {
    rateMultiplier: scenarios.bestRateMultiplier, blockerBufferDays: 0, useObservedRate: false,
  });
  const rawWorst = scenarioForecast(_internal.activityDocs, _internal.deps, _internal.state, {
    rateMultiplier: scenarios.worstRateMultiplier, blockerBufferDays: scenarios.worstBlockerBufferDays, useObservedRate: true,
  });
  // Keep the three cases ordered: the live engine figure is always the expected case.
  const best = maxDate(minDate(rawBest?.finish, expected), snap.asOf);
  const worst = maxDate(rawWorst?.finish, expected);

  const driver = [...open].sort((a, b) => b.slipDays - a.slipDays)[0];
  return {
    plannedCompletion: scheduleEnd,
    projectCompletion,
    coversFullScope,
    scopeNote: coversFullScope ? null
      : `The activity plan currently ends ${fmt(scheduleEnd)}, well before the project completion date of ${fmt(projectCompletion)}. The forecast below covers only the ${activities.length} activities that have been planned, not the remaining scope.`,
    expected,
    best,
    worst,
    delayDays: expected && scheduleEnd ? diffDays(expected, scheduleEnd) : 0,
    bestDelayDays: best && scheduleEnd ? diffDays(best, scheduleEnd) : 0,
    worstDelayDays: worst && scheduleEnd ? diffDays(worst, scheduleEnd) : 0,
    criticalActivity: driver ? { code: driver.code, name: driver.name, slipDays: driver.slipDays } : null,
    complete: false,
    basis: [
      `Compared against the end of the planned activities (${fmt(scheduleEnd)}), which is the only like-for-like baseline.`,
      `Expected case uses the live schedule forecast; last run ${snap.project.lastEvaluatedAt ? fmt(snap.project.lastEvaluatedAt) : 'not yet'}.`,
      `Best case assumes remaining work runs at ${Math.round(scenarios.bestRateMultiplier * 100)}% of planned productivity and open blockers clear on their expected date.`,
      `Worst case assumes current observed productivity falls to ${Math.round(scenarios.worstRateMultiplier * 100)}% and blockers clear ${scenarios.worstBlockerBufferDays} days late.`,
      driver ? `Latest finish is driven by ${driver.name} (${driver.code}), currently +${driver.slipDays}d.` : 'No activity is behind schedule.',
    ].concat(coversFullScope ? [] : ['The plan does not yet cover the full project duration, so this is not a project hand-over forecast.']),
  };
}

function minDate(...values) {
  const valid = values.filter(Boolean).map(toDay);
  if (!valid.length) return null;
  return new Date(Math.min(...valid.map((d) => d.getTime())));
}

// ---------------------------------------------------------------------------
// Delay intelligence
// ---------------------------------------------------------------------------

export function delayAnalysis(snap) {
  const { activities, rules } = snap;
  const open = activities.filter((a) => a.actualProgress < 100);
  // Only activities with a cause of their own; "waiting on predecessor" is an effect, not a cause.
  const causes = open
    .filter((a) => a.slipDays > 0 || a.progressVariance < -rules.status.atRiskProgressVariance || a.blockers.length)
    .filter((a) => a.blockers.length || a.progressVariance < 0 || !a.impactedBy.length)
    .map((a) => {
      const reasons = [];
      if (a.blockers.length) reasons.push(`${a.blockers[0].type} blocker: ${a.blockers[0].description}`);
      if (a.progressVariance < 0) reasons.push(`${a.actualProgress}% complete against ${a.plannedProgress}% planned (${a.progressVariance}%)`);
      if (a.manpower?.short) reasons.push(`${a.manpower.trade || 'Manpower'} shortfall: ${a.manpower.actual} of ${a.manpower.planned} planned`);
      if (a.impactedBy.length) reasons.push(`Waiting on ${a.impactedBy.join(', ')}`);
      return {
        code: a.code, name: a.name, location: a.location, health: a.health,
        slipDays: a.slipDays, progressVariance: a.progressVariance,
        productivityGapPercent: productivityGap(a),
        reasons,
      };
    })
    .sort((a, b) => b.slipDays - a.slipDays || a.progressVariance - b.progressVariance);

  const blockersByType = {};
  for (const b of snap.blockers.filter((x) => OPEN_BLOCKER_STATUSES.includes(x.status))) {
    blockersByType[b.type] = (blockersByType[b.type] || 0) + 1;
  }
  const maxSlip = open.length ? Math.max(0, ...open.map((a) => a.slipDays)) : 0;
  const behind = open.filter((a) => a.progressVariance < 0).length;
  const t = rules.ai.delayRisk;
  const highRisk = snap.risks.find((r) => r.severity === 'High');
  let level = 'Low';
  let levelReason = `Largest forecast slip is ${maxSlip} day(s), under the ${t.mediumSlipDays}-day Medium threshold.`;
  if (maxSlip >= t.mediumSlipDays || behind >= t.mediumBehindCount) {
    level = 'Medium';
    levelReason = maxSlip >= t.mediumSlipDays
      ? `Largest forecast slip is ${maxSlip} day(s), at or above the ${t.mediumSlipDays}-day Medium threshold.`
      : `${behind} activities are behind plan, at or above the Medium threshold of ${t.mediumBehindCount}.`;
  }
  if (maxSlip >= t.highSlipDays || highRisk) {
    level = 'High';
    levelReason = maxSlip >= t.highSlipDays
      ? `Largest forecast slip is ${maxSlip} day(s), at or above the ${t.highSlipDays}-day High threshold.`
      : `An open risk is already High severity: ${highRisk.message}`;
  }
  if (maxSlip >= t.criticalSlipDays) {
    level = 'Critical';
    levelReason = `Largest forecast slip is ${maxSlip} day(s), at or above the ${t.criticalSlipDays}-day Critical threshold.`;
  }

  return {
    level,
    levelReason,
    maxSlipDays: maxSlip,
    activitiesBehind: behind,
    activitiesBlocked: open.filter((a) => a.blockers.length).length,
    waitingOnPredecessor: open.filter((a) => a.impactedBy.length && !a.blockers.length && a.progressVariance >= 0).length,
    blockersByType,
    contributors: causes.slice(0, 8),
    basis: [
      levelReason,
      `${behind} open activities are behind their planned progress.`,
      `Thresholds: Medium ≥ ${t.mediumSlipDays}d, High ≥ ${t.highSlipDays}d, Critical ≥ ${t.criticalSlipDays}d (Admin → Business rules).`,
    ],
  };
}

// Observed productivity against planned, as a percentage gap (negative = slower than planned).
function productivityGap(a) {
  if (!a.lastUpdateAt || !a.plannedProgress) return null;
  const ratio = a.plannedProgress > 0 ? a.actualProgress / a.plannedProgress : null;
  return ratio === null ? null : round((ratio - 1) * 100, 1);
}

// ---------------------------------------------------------------------------
// Labour
// ---------------------------------------------------------------------------

// Walks the lookahead day by day. Crews only add up when activities actually overlap, so the
// requirement is the peak concurrent demand, never the sum of everything in the window.
function demandByDay(snap, pick) {
  const { activities, _internal, rules, asOf } = snap;
  const open = activities.filter((a) => a.actualProgress < 100);
  const days = [];
  for (let i = 0; i <= rules.ai.lookaheadDays; i++) {
    const date = addDays(asOf, i);
    const active = open.filter((a) => toDay(a.plannedStart) <= date && toDay(a.plannedFinish) >= date);
    const byKey = new Map();
    for (const a of active) {
      for (const e of _internal.estimatesBy.get(a.id) || []) {
        for (const line of pick(e) || []) {
          byKey.set(line.key, (byKey.get(line.key) || 0) + (line.count || 0));
        }
      }
    }
    days.push({ date, activities: active.length, byKey, total: sum([...byKey.values()], (v) => v) });
  }
  const peak = days.reduce((best, d) => (d.total > best.total ? d : best), days[0]);
  // Per-key peak: the largest concurrent demand for each trade or machine across the window.
  const peakByKey = new Map();
  for (const d of days) {
    for (const [k, v] of d.byKey) peakByKey.set(k, Math.max(peakByKey.get(k) || 0, v));
  }
  return { days, peak, today: days[0], peakByKey };
}

export function labourAnalysis(snap) {
  const { activities, _internal, rules, asOf } = snap;
  const window = activities.filter((a) => a.activeInWindow);
  if (!window.length) {
    return { insufficientData: true, reason: `No activities are scheduled in the next ${rules.ai.lookaheadDays} days.`, trades: [], basis: [] };
  }
  const demand = demandByDay(snap, (e) => (e.labour || []).map((l) => ({ key: l.trade, count: l.count })));
  if (!demand.peakByKey.size) {
    return {
      insufficientData: true,
      reason: 'No estimated labour requirement exists for the upcoming activities. Add labour lines to the estimates (or sync them from Colab) to calculate the requirement.',
      trades: [], basis: [],
    };
  }
  // Labour actually deployed: attendance register first, then the latest execution report.
  const present = new Map();
  let reportDate = null;
  const recentAttendance = (snap.attendance || []).filter((r) => diffDays(asOf, r.date) <= rules.ai.freshUpdateDays);
  if (recentAttendance.length) {
    const latestDay = recentAttendance.reduce((best, r) => (toDay(r.date) > toDay(best) ? r.date : best), recentAttendance[0].date);
    reportDate = latestDay;
    for (const r of recentAttendance.filter((x) => sameDay(x.date, latestDay))) {
      present.set(r.trade, (present.get(r.trade) || 0) + (r.present || 0));
    }
  } else {
    for (const a of activities.filter((x) => x.actualProgress < 100)) {
      const log = (_internal.logsBy.get(a.id) || []).at(-1);
      if (!log || diffDays(asOf, log.date) > rules.ai.freshUpdateDays) continue;
      reportDate = maxDate(reportDate, log.date);
      for (const m of log.manpower || []) {
        present.set(m.trade, (present.get(m.trade) || 0) + (m.actual || 0));
      }
    }
  }
  const trades = [...new Set([...demand.peakByKey.keys(), ...present.keys()])].map((trade) => {
    const todayReq = demand.today.byKey.get(trade) || 0;
    const peakReq = demand.peakByKey.get(trade) || 0;
    const now = present.get(trade) || 0;
    return {
      trade,
      requiredToday: todayReq,
      requiredPeak: peakReq,
      present: now,
      shortfallToday: Math.max(0, todayReq - now),
      shortfallPeak: Math.max(0, peakReq - now),
      surplus: Math.max(0, now - peakReq),
    };
  }).sort((a, b) => b.shortfallPeak - a.shortfallPeak);

  const totalPresent = sum(trades, (t) => t.present);
  return {
    insufficientData: !present.size,
    reason: present.size ? null : 'No execution report within the freshness window, so deployed labour is unknown.',
    windowDays: rules.ai.lookaheadDays,
    asOfReport: reportDate,
    requiredToday: demand.today.total,
    requiredPeak: demand.peak.total,
    peakDate: demand.peak.date,
    totalPresent,
    shortfall: Math.max(0, demand.today.total - totalPresent),
    shortfallPeak: Math.max(0, demand.peak.total - totalPresent),
    utilisationPercent: demand.today.total ? round(share(totalPresent, demand.today.total) * 100, 1) : null,
    trades,
    source: recentAttendance.length ? 'attendance' : 'execution',
    basis: [
      `Requirement is the peak concurrent crew across the next ${rules.ai.lookaheadDays} days: ${demand.peak.total} workers on ${fmt(demand.peak.date)} across ${demand.peak.activities} overlapping activities.`,
      `Today ${demand.today.activities} activities are active, needing ${demand.today.total} workers.`,
      reportDate
        ? `Deployed labour taken from ${recentAttendance.length ? 'the attendance register' : 'execution reports'} dated ${fmt(reportDate)}.`
        : 'No recent attendance or execution report found.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Material
// ---------------------------------------------------------------------------

export function materialAnalysis(snap) {
  const { activities, _internal, rules } = snap;
  const window = activities.filter((a) => a.activeInWindow);
  const required = new Map();
  for (const a of window) {
    for (const e of _internal.estimatesBy.get(a.id) || []) {
      for (const m of e.materials || []) {
        const key = m.name;
        const row = required.get(key) || { name: m.name, unit: m.unit, required: 0, consumed: 0 };
        // Pro-rate the remaining share of the activity's estimated material.
        row.required += (m.quantity || 0) * (1 - Math.min(1, a.actualProgress / 100));
        row.unit = row.unit || m.unit;
        required.set(key, row);
      }
    }
  }
  for (const log of snap.execLogs) {
    for (const m of log.materialsConsumed || []) {
      const row = required.get(m.name);
      if (row) row.consumed += m.quantity || 0;
    }
  }
  if (!required.size) {
    return {
      insufficientData: true,
      reason: 'No estimated material quantities exist for the upcoming activities, so the requirement cannot be calculated.',
      materials: [], stockTracked: false, basis: [],
    };
  }
  const stockBy = new Map((snap.inventory || []).map((i) => [i.name.toLowerCase(), i]));
  const txns = snap.inventoryTxns || [];
  const consumeTxns = txns.filter((t) => t.type === 'consumed' || t.type === 'wastage');
  const daysCovered = new Set(consumeTxns.filter((t) => diffDays(snap.asOf, t.date) <= 14).map((t) => fmt(t.date)));
  const dailyRate = (name) => {
    const recent = consumeTxns.filter((t) => {
      const item = snap.inventory.find((i) => String(i._id) === String(t.item));
      return item && item.name.toLowerCase() === name.toLowerCase() && diffDays(snap.asOf, t.date) <= 14;
    });
    const qty = sum(recent, (t) => t.quantity);
    return daysCovered.size ? qty / Math.max(1, daysCovered.size) : 0;
  };

  const materials = [...required.values()].map((r) => {
    const stock = stockBy.get(r.name.toLowerCase());
    const rate = stock ? dailyRate(r.name) : 0;
    const daysLeft = stock && rate > 0 ? round(stock.stock / rate, 1) : null;
    let stockRisk = null;
    if (stock) {
      const t = snap.rules.ai.inventory;
      if (stock.stock <= stock.minStock || (daysLeft !== null && daysLeft <= t.criticalDays)) stockRisk = 'Critical';
      else if (stock.stock <= stock.reorderLevel || (daysLeft !== null && daysLeft <= t.lowDays)) stockRisk = 'Low';
      else if (daysLeft !== null && daysLeft >= t.excessDays) stockRisk = 'Excess';
      else stockRisk = 'Normal';
    }
    return {
      name: r.name,
      unit: r.unit || stock?.unit || null,
      requiredNextWindow: round(r.required, 2),
      consumedToDate: round(r.consumed, 2),
      stock: stock ? round(stock.stock, 2) : null,
      minStock: stock?.minStock ?? null,
      reorderLevel: stock?.reorderLevel ?? null,
      supplier: stock?.supplier || null,
      dailyConsumption: rate ? round(rate, 2) : null,
      daysOfCover: daysLeft,
      recommendedPurchase: stock ? Math.max(0, round(r.required - stock.stock, 2)) : null,
      stockRisk,
    };
  }).sort((a, b) => b.requiredNextWindow - a.requiredNextWindow);

  const stockTracked = (snap.inventory || []).length > 0;
  return {
    insufficientData: false,
    stockTracked,
    stockNote: stockTracked
      ? null
      : 'Inventory stock, reorder levels and purchase orders are not yet recorded. Requirement and consumption below are from estimates and execution reports. Record opening stock on the Inventory tab to calculate shortage and procurement dates.',
    windowDays: rules.ai.lookaheadDays,
    materials: materials.slice(0, 15),
    basis: [
      `Requirement pro-rated by remaining progress for ${window.length} activities active in the next ${rules.ai.lookaheadDays} days.`,
      `Consumption summed from ${snap.execLogs.length} execution reports${stockTracked ? ` and ${consumeTxns.length} inventory transactions` : ''}.`,
      stockTracked ? `${snap.inventory.length} inventory item(s) have recorded stock.` : 'No inventory items recorded.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Equipment
// ---------------------------------------------------------------------------

export function equipmentAnalysis(snap) {
  const { activities, rules, asOf } = snap;
  const window = activities.filter((a) => a.activeInWindow);
  // Machines are shared between activities, so the requirement is peak concurrent demand.
  const demand = demandByDay(snap, (e) => (e.machinery || []).map((m) => ({ key: m.name, count: m.count })));
  const required = demand.peakByKey;
  const deployed = new Map();
  const hours = new Map();
  const days = new Set();
  for (const log of snap.execLogs.filter((l) => diffDays(asOf, l.date) <= 7)) {
    days.add(fmt(log.date));
    for (const m of log.machinery || []) {
      deployed.set(m.name, Math.max(deployed.get(m.name) || 0, m.count || 0));
      hours.set(m.name, (hours.get(m.name) || 0) + (m.hours || 0));
    }
  }
  if (!required.size && !deployed.size) {
    return {
      insufficientData: true,
      reason: 'No machinery lines exist on the estimates and no equipment hours have been reported, so equipment demand cannot be calculated.',
      items: [], basis: [],
    };
  }
  const workingHours = rules.ai.equipment.workingHoursPerDay;
  const dayCount = Math.max(1, days.size);
  const items = [...new Set([...required.keys(), ...deployed.keys()])].map((name) => {
    const req = required.get(name) || 0;
    const have = deployed.get(name) || 0;
    const loggedHours = round(hours.get(name) || 0, 1);
    const capacityHours = have * workingHours * dayCount;
    return {
      name,
      required: req,
      requiredToday: demand.today.byKey.get(name) || 0,
      deployed: have,
      shortfall: Math.max(0, req - have),
      hoursLast7Days: loggedHours,
      utilisationPercent: capacityHours ? round(share(loggedHours, capacityHours) * 100, 1) : null,
    };
  }).sort((a, b) => b.shortfall - a.shortfall || b.hoursLast7Days - a.hoursLast7Days);

  return {
    insufficientData: false,
    items,
    workingHoursPerDay: workingHours,
    reportedDays: dayCount,
    peakDate: demand.peak.date,
    basis: [
      `Requirement is the peak concurrent machinery demand across the next ${rules.ai.lookaheadDays} days (${window.length} activities in the window), not the sum of every activity.`,
      `Utilisation = reported hours ÷ (machines × ${workingHours}h × ${dayCount} reported day(s)).`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Ground conditions (rock / soil / excavation)
// ---------------------------------------------------------------------------

const GROUND_PATTERN = /\b(rock|boulder|hard strata|water table|soil|strata|excavat)\w*/i;

export function groundConditionAnalysis(snap) {
  const { rules, _internal } = snap;
  const byActivity = new Map(snap.activities.map((a) => [a.id, a]));
  const reports = snap.blockers
    .filter((b) => OPEN_BLOCKER_STATUSES.includes(b.status))
    .filter((b) => b.type === 'Site Condition' || GROUND_PATTERN.test(b.description || ''))
    .map((b) => {
      const a = byActivity.get(String(b.activity));
      if (!a) return null;
      const est = (_internal.estimatesBy.get(a.id) || []).find((e) => e.productivityPerDay);
      const remainingQty = a.plannedQuantity ? a.plannedQuantity * (1 - a.actualProgress / 100) : null;
      const factor = rules.ai.ground.hardStrataProductivityFactor;

      if (!est?.productivityPerDay || !remainingQty) {
        return {
          activity: { code: a.code, name: a.name, location: a.location },
          condition: b.description,
          insufficientData: true,
          reason: 'Estimated productivity per day or planned quantity is missing for this activity, so the slowdown cannot be quantified.',
        };
      }
      const normalDays = Math.ceil(remainingQty / est.productivityPerDay);
      const slowDays = Math.ceil(remainingQty / (est.productivityPerDay * factor));
      const extraDays = slowDays - normalDays;
      const extraMachines = extraDays > 0
        ? Math.max(1, Math.ceil(extraDays / rules.ai.ground.extraDaysRecoveredPerMachine))
        : 0;
      return {
        activity: { code: a.code, name: a.name, location: a.location },
        condition: b.description,
        severity: b.severity,
        insufficientData: false,
        remainingQuantity: round(remainingQty, 2),
        unit: a.unit,
        normalDurationDays: normalDays,
        affectedDurationDays: slowDays,
        additionalDays: extraDays,
        additionalBreakerOrMachines: extraMachines,
        additionalLabour: extraMachines * rules.ai.ground.labourPerAdditionalMachine,
        basis: [
          `Estimated productivity ${est.productivityPerDay} ${a.unit || 'unit'}/day, remaining quantity ${round(remainingQty, 2)} ${a.unit || ''}.`,
          `Hard-strata productivity factor ${factor} (configurable in Admin → Business rules).`,
          `One additional machine is assumed to recover ${rules.ai.ground.extraDaysRecoveredPerMachine} days with ${rules.ai.ground.labourPerAdditionalMachine} workers each.`,
        ],
      };
    })
    .filter(Boolean);

  return {
    detected: reports.length > 0,
    reports,
    basis: reports.length ? [] : ['No open site-condition blocker or ground-related description found.'],
  };
}

// ---------------------------------------------------------------------------
// Inventory (stock risk from recorded stock + consumption rate)
// ---------------------------------------------------------------------------

export function inventoryAnalysis(snap) {
  const items = snap.inventory || [];
  if (!items.length) {
    return {
      insufficientData: true,
      reason: 'No inventory items have been recorded for this project, so stock risk cannot be calculated.',
      items: [], basis: [],
    };
  }
  const materials = materialAnalysis(snap).materials;
  const byName = new Map(materials.map((m) => [m.name.toLowerCase(), m]));
  const rows = items.map((i) => {
    const m = byName.get(i.name.toLowerCase());
    return {
      name: i.name,
      unit: i.unit,
      stock: i.stock,
      minStock: i.minStock,
      reorderLevel: i.reorderLevel,
      supplier: i.supplier || null,
      requiredNextWindow: m?.requiredNextWindow ?? 0,
      dailyConsumption: m?.dailyConsumption ?? null,
      daysOfCover: m?.daysOfCover ?? null,
      recommendedPurchase: m?.recommendedPurchase ?? Math.max(0, (i.reorderLevel || 0) - i.stock),
      stockRisk: m?.stockRisk || (i.stock <= i.minStock ? 'Critical' : i.stock <= i.reorderLevel ? 'Low' : 'Normal'),
    };
  }).sort((a, b) => {
    const rank = { Critical: 3, Low: 2, Normal: 1, Excess: 0 };
    return (rank[b.stockRisk] || 0) - (rank[a.stockRisk] || 0);
  });
  return {
    insufficientData: false,
    items: rows,
    critical: rows.filter((r) => r.stockRisk === 'Critical').length,
    low: rows.filter((r) => r.stockRisk === 'Low').length,
    basis: [
      `Stock risk uses recorded stock against min/reorder levels and, when consumption exists, days of cover (Critical ≤ ${snap.rules.ai.inventory.criticalDays}d, Low ≤ ${snap.rules.ai.inventory.lowDays}d).`,
      `${items.length} inventory item(s), ${snap.inventoryTxns?.length || 0} transaction(s).`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Planning (scope, phases, critical path)
// ---------------------------------------------------------------------------

export function planningAnalysis(snap) {
  const { activities, dependencies } = snap;
  const phases = {};
  for (const a of activities) {
    const cat = categoryOf(a.name);
    if (!phases[cat]) phases[cat] = { category: cat, activities: 0, actual: 0, planned: 0, remaining: 0 };
    phases[cat].activities += 1;
    phases[cat].actual += a.actualProgress;
    phases[cat].planned += a.plannedProgress;
    if (a.actualProgress < 100) phases[cat].remaining += 1;
  }
  const phaseList = Object.values(phases).map((p) => ({
    ...p,
    actual: round(p.actual / p.activities, 1),
    planned: round(p.planned / p.activities, 1),
  })).sort((a, b) => b.remaining - a.remaining);

  const byId = new Map(activities.map((a) => [a.id, a]));
  const succs = groupBy(dependencies, 'predecessor');
  const remainingDays = (a) => Math.max(1, Math.ceil(a.plannedDurationDays * (1 - a.actualProgress / 100)));
  const memo = new Map();
  const pathFrom = (id, seen = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (seen.has(id)) return { days: 0, chain: [] };
    const a = byId.get(id);
    if (!a || a.actualProgress >= 100) return { days: 0, chain: [] };
    seen.add(id);
    let best = { days: 0, chain: [] };
    for (const d of succs.get(id) || []) {
      const next = pathFrom(String(d.successor), seen);
      if (next.days > best.days) best = next;
    }
    const result = { days: remainingDays(a) + best.days, chain: [a, ...best.chain] };
    memo.set(id, result);
    return result;
  };
  let critical = { days: 0, chain: [] };
  for (const a of activities) {
    const p = pathFrom(a.id);
    if (p.days > critical.days) critical = p;
  }

  const milestones = activities
    .filter((a) => a.priority === 'Critical' || a.actualProgress < 100)
    .sort((a, b) => new Date(a.plannedFinish) - new Date(b.plannedFinish))
    .slice(0, 8)
    .map((a) => ({ code: a.code, name: a.name, plannedFinish: a.plannedFinish, expectedFinish: a.expectedFinish, health: a.health, priority: a.priority }));

  return {
    phases: phaseList,
    criticalPath: {
      remainingDays: critical.days,
      activities: critical.chain.map((a) => ({ code: a.code, name: a.name, remainingDays: remainingDays(a), health: a.health })),
    },
    dependencies: dependencies.length,
    milestones,
    basis: [
      `${activities.length} activities, ${dependencies.length} Finish→Start links.`,
      critical.chain.length
        ? `Critical path remaining ${critical.days} day(s): ${critical.chain.map((a) => a.code).join(' → ')}.`
        : 'No remaining critical path (all activities complete).',
    ],
  };
}

// ---------------------------------------------------------------------------
// Scheduling (conflicts + recovery options from live forecast)
// ---------------------------------------------------------------------------

export function schedulingAnalysis(snap, labour, equipment) {
  const open = snap.activities.filter((a) => a.actualProgress < 100);
  const conflicts = [];
  for (let i = 0; i < open.length; i++) {
    for (let j = i + 1; j < open.length; j++) {
      const a = open[i];
      const b = open[j];
      const overlap = toDay(a.plannedStart) <= toDay(b.plannedFinish) && toDay(b.plannedStart) <= toDay(a.plannedFinish);
      if (!overlap) continue;
      if (a.responsible && b.responsible && a.responsible === b.responsible) {
        conflicts.push({
          type: 'engineer',
          a: { code: a.code, name: a.name },
          b: { code: b.code, name: b.name },
          detail: `${a.responsible} is assigned to overlapping activities.`,
        });
      }
    }
  }
  const labourShort = (labour.trades || []).filter((t) => t.shortfallPeak > 0);
  const equipShort = (equipment.items || []).filter((i) => i.shortfall > 0);
  const delayed = open.filter((a) => a.slipDays > 0).sort((a, b) => b.slipDays - a.slipDays);
  return {
    openActivities: open.length,
    conflicts: conflicts.slice(0, 8),
    delayed: delayed.slice(0, 8).map((a) => ({
      code: a.code, name: a.name, slipDays: a.slipDays,
      expectedFinish: a.expectedFinish, plannedFinish: a.plannedFinish,
    })),
    labourShortfall: labourShort,
    equipmentShortfall: equipShort,
    recoveryOptions: [
      labourShort.length ? { type: 'add_labour', label: 'Add labour on the short trades', workers: labour.shortfallPeak } : null,
      equipShort.length ? { type: 'add_equipment', label: 'Add the short machines', count: sum(equipShort, (i) => i.shortfall) } : null,
      delayed.length ? { type: 'increase_hours', label: 'Increase working hours on delayed activities', hours: 2 } : null,
    ].filter(Boolean),
    basis: [
      `${conflicts.length} overlapping-assignment conflict(s) among open activities.`,
      `${delayed.length} open activit${delayed.length === 1 ? 'y is' : 'ies are'} behind the planned finish.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Daily site summary
// ---------------------------------------------------------------------------

export async function dailySummary(projectId, date) {
  const snap = await buildProjectSnapshot(projectId);
  const day = toDay(date || snap.asOf);
  const logs = snap.execLogs.filter((l) => diffDays(l.date, day) === 0);
  const [updates, newBlockers] = await Promise.all([
    ProgressUpdate.find({ project: projectId, date: day }).populate('activity', 'code name unit').populate('reportedBy', 'name').lean(),
    Blocker.find({ project: projectId, reportedDate: day }).populate('activity', 'code name').lean(),
  ]);
  const labourPresent = sum(logs.flatMap((l) => l.manpower || []), (m) => m.actual);
  const labourPlanned = sum(logs.flatMap((l) => l.manpower || []), (m) => m.planned);
  const machineHours = sum(logs.flatMap((l) => l.machinery || []), (m) => m.hours);
  const machines = sum(logs.flatMap((l) => l.machinery || []), (m) => m.count);

  return {
    date: day,
    reported: logs.length > 0 || updates.length > 0,
    progressUpdates: updates.map((u) => ({
      activity: u.activity?.name, code: u.activity?.code,
      actualProgress: u.actualProgress, plannedProgress: u.plannedProgress,
      quantity: u.actualQuantity, unit: u.activity?.unit, status: u.status,
      comment: u.comment, reportedBy: u.reportedBy?.name,
    })),
    labour: { planned: labourPlanned, present: labourPresent, attendancePercent: labourPlanned ? round(share(labourPresent, labourPlanned) * 100, 1) : null },
    equipment: { machines, hours: round(machineHours, 1) },
    materialsConsumed: logs.flatMap((l) => (l.materialsConsumed || []).map((m) => ({ name: m.name, quantity: m.quantity, unit: m.unit }))),
    issues: newBlockers.map((b) => ({ activity: b.activity?.name, type: b.type, description: b.description, severity: b.severity })),
    remarks: logs.map((l) => l.remarks).filter(Boolean),
    weather: logs.map((l) => l.weather).filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// Project health score (transparent breakdown, §29)
// ---------------------------------------------------------------------------

export function healthScore(snap, parts) {
  const { progress, activities, rules } = snap;
  const open = activities.filter((a) => a.actualProgress < 100);
  const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

  const scheduleHealth = clamp(100 - (parts.delay.maxSlipDays / rules.ai.delayRisk.criticalSlipDays) * 100);
  const progressHealth = clamp(100 + progress.variance * 2.5);
  const riskHealth = clamp(100 - snap.risks.reduce((t, r) => t + ({ Low: 5, Medium: 15, High: 30 }[r.severity] || 0), 0));
  const labourHealth = parts.labour.insufficientData || parts.labour.utilisationPercent === null
    ? null
    : clamp(Math.min(100, parts.labour.utilisationPercent));
  const materialBlockers = parts.delay.blockersByType.Material || 0;
  const stockCritical = (parts.inventory?.items || []).filter((i) => i.stockRisk === 'Critical').length;
  const materialHealth = parts.material.insufficientData
    ? null
    : clamp(100 - materialBlockers * 20 - stockCritical * 15);
  const equipmentHealth = parts.equipment.insufficientData
    ? null
    : clamp(100 - sum(parts.equipment.items, (i) => i.shortfall) * 15);
  const blockedShare = share(open.filter((a) => a.blockers.length).length, open.length || 1);
  const executionHealth = clamp(100 - blockedShare * 100);

  const dimensions = [
    { key: 'Schedule', score: scheduleHealth, basis: `Largest forecast slip ${parts.delay.maxSlipDays}d against a critical threshold of ${rules.ai.delayRisk.criticalSlipDays}d` },
    { key: 'Progress', score: progressHealth, basis: `${progress.overall}% actual against ${progress.planned}% planned (${progress.variance}%)` },
    { key: 'Risk', score: riskHealth, basis: `${snap.risks.length} open risk(s): ${snap.risks.map((r) => r.severity).join(', ') || 'none'}` },
    { key: 'Labour', score: labourHealth, basis: labourHealth === null ? parts.labour.reason : `Deployed labour is ${parts.labour.utilisationPercent}% of today's requirement` },
    { key: 'Material', score: materialHealth, basis: materialHealth === null ? parts.material.reason : `${materialBlockers} open material blocker(s)${stockCritical ? `, ${stockCritical} critical stock item(s)` : ''}` },
    { key: 'Equipment', score: equipmentHealth, basis: equipmentHealth === null ? parts.equipment.reason : `Equipment shortfall of ${sum(parts.equipment.items, (i) => i.shortfall)} machine(s)` },
    { key: 'Execution', score: executionHealth, basis: `${Math.round(blockedShare * 100)}% of open activities are blocked` },
  ];
  const scored = dimensions.filter((d) => d.score !== null);
  return {
    overall: Math.round(sum(scored, (d) => d.score) / (scored.length || 1)),
    dimensions,
    note: 'Each dimension is a deterministic formula over project records; dimensions without data are excluded from the overall score.',
  };
}

// ---------------------------------------------------------------------------
// Alert candidates (§26) - threshold driven, no model involved
// ---------------------------------------------------------------------------

export function alertCandidates(snap, parts) {
  const { rules } = snap;
  const out = [];
  const add = (level, category, key, title, message, basis = []) => out.push({ level, category, key, title, message, basis });

  const c = parts.completion;
  if (!c.complete && c.delayDays >= rules.ai.delayRisk.highSlipDays) {
    add('critical', 'Schedule', 'completion-delay',
      `Project completion may slip by ${c.delayDays} day(s)`,
      `Forecast completion ${fmt(c.expected)} against a planned ${fmt(c.plannedCompletion)}.`,
      c.basis);
  } else if (!c.complete && c.delayDays > 0) {
    add('warning', 'Schedule', 'completion-delay',
      `Project completion may slip by ${c.delayDays} day(s)`,
      `Forecast completion ${fmt(c.expected)} against a planned ${fmt(c.plannedCompletion)}.`,
      c.basis);
  }
  for (const con of parts.delay.contributors.slice(0, 3)) {
    if (con.slipDays <= 0) continue;
    add(con.slipDays >= rules.ai.delayRisk.highSlipDays ? 'critical' : 'warning', 'Delay', `delay-${con.code}`,
      `${con.name} is ${con.slipDays} day(s) behind`, con.reasons.join('; '), []);
  }
  if (!parts.labour.insufficientData && parts.labour.shortfallPeak > 0) {
    add(parts.labour.shortfall > 0 ? 'warning' : 'attention', 'Labour', 'labour-shortfall',
      `Labour shortfall of ${parts.labour.shortfallPeak} worker(s) at peak`,
      `${parts.labour.totalPresent} deployed against a peak requirement of ${parts.labour.requiredPeak} on ${fmt(parts.labour.peakDate)} (${parts.labour.requiredToday} needed today).`,
      parts.labour.basis);
  }
  for (const item of (parts.equipment.items || []).filter((i) => i.shortfall > 0).slice(0, 3)) {
    add('attention', 'Equipment', `equipment-${item.name}`,
      `${item.name}: ${item.shortfall} short of requirement`,
      `${item.deployed} deployed against ${item.required} required.`, parts.equipment.basis);
  }
  for (const item of (parts.inventory?.items || []).filter((i) => i.stockRisk === 'Critical' || i.stockRisk === 'Low').slice(0, 5)) {
    add(item.stockRisk === 'Critical' ? 'critical' : 'warning', 'Inventory', `stock-${item.name}`,
      `${item.name} stock is ${item.stockRisk.toLowerCase()}`,
      item.daysOfCover !== null
        ? `${item.stock} ${item.unit} on hand; about ${item.daysOfCover} day(s) of cover. Recommended purchase ${item.recommendedPurchase} ${item.unit}.`
        : `${item.stock} ${item.unit} on hand against reorder ${item.reorderLevel}. Recommended purchase ${item.recommendedPurchase} ${item.unit}.`,
      parts.inventory.basis);
  }
  for (const g of (parts.ground.reports || []).filter((r) => !r.insufficientData)) {
    add('critical', 'Ground condition', `ground-${g.activity.code}`,
      `Ground condition may add ${g.additionalDays} day(s) on ${g.activity.name}`,
      `${g.condition}. Duration moves from ${g.normalDurationDays} to ${g.affectedDurationDays} days.`, g.basis);
  }
  if (snap.progress.variance >= 0 && snap.progress.counts.total > 0) {
    add('positive', 'Progress', 'progress-ahead',
      `Progress is at or ahead of plan (${snap.progress.variance >= 0 ? '+' : ''}${snap.progress.variance}%)`,
      `${snap.progress.overall}% actual against ${snap.progress.planned}% planned.`, []);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Everything, assembled
// ---------------------------------------------------------------------------

export async function buildAnalysis(projectId) {
  const snap = await buildProjectSnapshot(projectId);
  const parts = {
    confidence: dataConfidence(snap),
    completion: completionForecast(snap),
    delay: delayAnalysis(snap),
    labour: labourAnalysis(snap),
    material: materialAnalysis(snap),
    inventory: inventoryAnalysis(snap),
    equipment: equipmentAnalysis(snap),
    ground: groundConditionAnalysis(snap),
  };
  parts.planning = planningAnalysis(snap);
  parts.scheduling = schedulingAnalysis(snap, parts.labour, parts.equipment);
  parts.health = healthScore(snap, parts);
  parts.alerts = alertCandidates(snap, parts);
  return { snap, parts };
}

// Compact context for the model: identifiers and numbers only, no raw documents.
export function modelContext(snap, parts, { include } = {}) {
  const pick = (keys) => Object.fromEntries(keys.filter((k) => !include || include.includes(k)).map((k) => [k, parts[k]]));
  return {
    asOf: fmt(snap.asOf),
    project: snap.project,
    progress: snap.progress,
    openRisks: snap.risks,
    openBlockers: snap.blockers.filter((b) => OPEN_BLOCKER_STATUSES.includes(b.status)),
    cameraObservations: snap.cameras,
    activities: snap.activities.map((a) => ({
      code: a.code, name: a.name, location: a.location, health: a.health, status: a.status,
      plannedFinish: fmt(a.plannedFinish), expectedFinish: a.expectedFinish ? fmt(a.expectedFinish) : null,
      plannedProgress: a.plannedProgress, actualProgress: a.actualProgress, slipDays: a.slipDays,
      reason: a.healthReason, responsible: a.responsible,
    })),
    ...pick(['confidence', 'completion', 'delay', 'labour', 'material', 'inventory', 'equipment', 'ground', 'planning', 'scheduling', 'health']),
  };
}
