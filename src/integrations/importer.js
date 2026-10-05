// Maps external (Colab-format) payloads onto Krisala models. Every import is idempotent:
// records are matched on external IDs, so re-running a sync updates rather than duplicates.
import {
  Activity, Dependency, Estimate, ExecutionLog, IntegrationSync, Project, ProgressUpdate, StructureNode, Team, User,
} from '../models/index.js';
import { SYNC_TYPES } from '../models/constants.js';
import { audit } from '../services/audit.js';
import { evaluateProject, plannedDuration, plannedProgressOn } from '../services/engine.js';
import { toDay } from '../utils/dates.js';
import { fetchColab } from './colab/client.js';

const TEAM_TYPE = { planning: 'Planning', estimation: 'Estimation', execution: 'Execution' };
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];

async function userIndex() {
  const users = await User.find({}, 'email name').lean();
  return new Map(users.map((u) => [u.email.toLowerCase(), u]));
}

function sameDate(a, b) {
  return (!a && !b) || (a && b && toDay(a).getTime() === toDay(b).getTime());
}

async function ensureLocation(projectId, path, cache) {
  let parent = null;
  for (const [i, level] of (path || []).entries()) {
    const key = `${parent}|${level.name}`;
    if (!cache.has(key)) {
      let node = await StructureNode.findOne({ project: projectId, parent, name: level.name });
      if (!node) node = await StructureNode.create({ project: projectId, parent, name: level.name, type: level.type || 'Zone', order: i });
      cache.set(key, node._id);
    }
    parent = cache.get(key);
  }
  return parent;
}

async function findActivity(projectId, taskId) {
  return Activity.findOne({ project: projectId, $or: [{ externalRef: taskId }, { code: taskId }] });
}

// ---------- Teams ----------
async function importTeams(project, payload, ctx) {
  const stats = { created: 0, updated: 0, unmatchedUsers: [] };
  const users = await userIndex();
  const resolve = (email) => {
    const u = email && users.get(email.toLowerCase());
    if (email && !u) stats.unmatchedUsers.push(email);
    return u?._id;
  };
  for (const t of payload.teams || []) {
    const type = TEAM_TYPE[String(t.type).toLowerCase()];
    if (!type) { ctx.errors.push(`Team ${t.team_code}: unknown type ${t.type}`); continue; }
    const data = {
      name: t.name, type, lead: resolve(t.lead_email),
      members: (t.members || []).map((m) => resolve(m.email)).filter(Boolean),
      source: ctx.source, externalRef: t.team_code, lastSyncedAt: new Date(),
    };
    const existing = await Team.findOne({ project: project._id, code: t.team_code });
    if (existing) { Object.assign(existing, data); await existing.save(); stats.updated++; }
    else { await Team.create({ project: project._id, code: t.team_code, ...data }); stats.created++; }
  }
  stats.unmatchedUsers = [...new Set(stats.unmatchedUsers)];
  return stats;
}

// ---------- Planning (schedule + baseline + dependencies) ----------
async function importPlanning(project, payload, ctx) {
  const stats = { created: 0, updated: 0, unchanged: 0, replanned: 0, dependenciesCreated: 0 };
  const users = await userIndex();
  const locCache = new Map();
  const byTask = new Map();

  for (const t of payload.tasks || []) {
    if (!t.task_id || !t.planned_start || !t.planned_finish) { ctx.errors.push(`Task ${t.task_id || '?'}: missing id or planned dates`); continue; }
    const structureNode = await ensureLocation(project._id, t.location, locCache);
    const owner = t.owner_email && users.get(t.owner_email.toLowerCase());
    const fields = {
      name: t.task_name, wbs: t.wbs, structureNode,
      plannedStart: toDay(t.planned_start), plannedFinish: toDay(t.planned_finish),
      plannedQuantity: t.qty, unit: t.uom,
      priority: PRIORITIES.includes(t.priority) ? t.priority : 'Medium',
      ...(owner ? { responsible: owner._id } : {}),
      baseline: {
        start: t.baseline_start ? toDay(t.baseline_start) : toDay(t.planned_start),
        finish: t.baseline_finish ? toDay(t.baseline_finish) : toDay(t.planned_finish),
        version: t.baseline_version, approvedBy: t.approved_by, source: ctx.source, setAt: new Date(),
      },
    };

    let act = await findActivity(project._id, t.task_id);
    if (!act) {
      act = new Activity({ project: project._id, code: t.task_id, externalRef: t.task_id, source: ctx.source, ...fields });
      act.plannedDuration = plannedDuration(act);
      act.lastSyncedAt = new Date();
      await act.save();
      await audit(ctx.user, 'Activity imported', {
        entityType: 'Activity', entityId: act._id, project: project._id, activity: act._id,
        newValue: { name: act.name, plannedStart: act.plannedStart, plannedFinish: act.plannedFinish }, comment: `From ${ctx.source} planning (${payload.schedule_version || 'latest'})`,
      });
      stats.created++;
    } else {
      const datesChanged = !sameDate(act.plannedStart, fields.plannedStart) || !sameDate(act.plannedFinish, fields.plannedFinish);
      if (datesChanged) {
        await audit(ctx.user, 'Plan updated from planning team', {
          entityType: 'Activity', entityId: act._id, project: project._id, activity: act._id, field: 'planned dates',
          previousValue: `${toDay(act.plannedStart).toISOString().slice(0, 10)} → ${toDay(act.plannedFinish).toISOString().slice(0, 10)}`,
          newValue: `${fields.plannedStart.toISOString().slice(0, 10)} → ${fields.plannedFinish.toISOString().slice(0, 10)}`,
          comment: `${ctx.source} schedule ${payload.schedule_version || ''}`.trim(),
        });
        stats.replanned++;
      }
      const prevBaseline = act.baseline || {};
      if (sameDate(prevBaseline.start, fields.baseline.start) && sameDate(prevBaseline.finish, fields.baseline.finish) && prevBaseline.version === fields.baseline.version) {
        fields.baseline.setAt = prevBaseline.setAt;
      }
      Object.assign(act, fields, { externalRef: t.task_id });
      act.plannedDuration = plannedDuration(act);
      const modified = act.isModified();
      act.lastSyncedAt = new Date();
      await act.save();
      if (modified) stats.updated++; else stats.unchanged++;
    }
    byTask.set(t.task_id, act);
  }

  // Dependencies: add any missing Finish -> Start links. Local links are never removed by a sync.
  const existing = await Dependency.find({ project: project._id }, 'predecessor successor').lean();
  const have = new Set(existing.map((d) => `${d.predecessor}>${d.successor}`));
  for (const t of payload.tasks || []) {
    const succ = byTask.get(t.task_id);
    for (const p of t.predecessors || []) {
      if (p.type && p.type !== 'FS') { ctx.errors.push(`${t.task_id}: dependency type ${p.type} not supported (FS only)`); continue; }
      const pred = byTask.get(p.task_id) || await findActivity(project._id, p.task_id);
      if (!pred || !succ) { ctx.errors.push(`${t.task_id}: predecessor ${p.task_id} not found`); continue; }
      const key = `${pred._id}>${succ._id}`;
      if (have.has(key)) continue;
      await Dependency.create({ project: project._id, predecessor: pred._id, successor: succ._id, type: 'FS', lagDays: p.lag || 0 });
      have.add(key);
      stats.dependenciesCreated++;
    }
  }
  return stats;
}

// ---------- Estimation (BOQ, cost, planned resources) ----------
async function importEstimation(project, payload, ctx) {
  const stats = { created: 0, updated: 0, unmatchedTasks: [] };
  const users = await userIndex();
  for (const it of payload.items || []) {
    const act = await findActivity(project._id, it.task_id);
    if (!act) { stats.unmatchedTasks.push(it.task_id); continue; }
    const data = {
      project: project._id, description: it.description, quantity: it.qty, unit: it.uom, rate: it.rate,
      amount: it.amount ?? (it.qty && it.rate ? it.qty * it.rate : undefined),
      estimatedDurationDays: it.est_duration_days, productivityPerDay: it.productivity_per_day,
      labour: (it.labour || []).map((l) => ({ trade: l.trade, count: l.count })),
      materials: (it.materials || []).map((m) => ({ name: m.item, quantity: m.qty, unit: m.uom })),
      machinery: (it.equipment || []).map((m) => ({ name: m.name, count: m.count })),
      version: payload.estimate_version, status: String(it.status).toLowerCase() === 'draft' ? 'Draft' : 'Approved',
      preparedBy: it.estimator_email ? users.get(it.estimator_email.toLowerCase())?._id : undefined,
      source: ctx.source, externalRef: it.boq_code, lastSyncedAt: new Date(),
    };
    const res = await Estimate.updateOne({ activity: act._id, boqCode: it.boq_code }, { $set: data }, { upsert: true });
    if (res.upsertedCount) stats.created++; else stats.updated++;
  }
  return stats;
}

// ---------- Execution (daily reports: manpower, machinery, materials) ----------
async function importExecution(project, payload, ctx) {
  const stats = { created: 0, updated: 0, progressUpdates: 0, unmatchedTasks: [] };
  const users = await userIndex();
  for (const r of payload.reports || []) {
    const act = await findActivity(project._id, r.task_id);
    if (!act) { stats.unmatchedTasks.push(r.task_id); continue; }
    const date = toDay(r.date);
    const reporter = r.reported_by_email ? users.get(r.reported_by_email.toLowerCase())?._id : undefined;
    const res = await ExecutionLog.updateOne(
      { activity: act._id, date, source: ctx.source },
      {
        $set: {
          project: project._id, contractor: r.contractor,
          manpower: (r.manpower || []).map((m) => ({ trade: m.trade, planned: m.planned, actual: m.actual })),
          machinery: (r.equipment || []).map((m) => ({ name: m.name, count: m.count, hours: m.hours })),
          materialsConsumed: (r.materials_consumed || []).map((m) => ({ name: m.item, quantity: m.qty, unit: m.uom })),
          weather: r.weather, workingHours: r.working_hours, remarks: r.remarks, reportedBy: reporter, externalRef: r.report_id,
        },
      },
      { upsert: true },
    );
    if (res.upsertedCount) stats.created++; else stats.updated++;

    // Optional progress reported in the DPR feeds the same append-only progress history.
    if (r.progress_pct != null && !(await ProgressUpdate.exists({ externalRef: r.report_id }))) {
      await ProgressUpdate.create({
        project: project._id, activity: act._id, date, actualProgress: Math.max(0, Math.min(100, Number(r.progress_pct))),
        plannedQuantity: act.plannedQuantity, plannedProgress: plannedProgressOn(act, date),
        comment: r.remarks, reportedBy: reporter, source: ctx.source, externalRef: r.report_id,
      });
      stats.progressUpdates++;
    }
  }
  stats.unmatchedTasks = [...new Set(stats.unmatchedTasks)];
  return stats;
}

const IMPORTERS = { teams: importTeams, planning: importPlanning, estimation: importEstimation, execution: importExecution };

// Planning first so estimates and DPRs can match newly created activities.
const ORDER = ['teams', 'planning', 'estimation', 'execution'];

async function run(project, { source, mode, types, user, getPayload, evaluate = true }) {
  const sync = await IntegrationSync.create({ project: project._id, source, mode, types, triggeredBy: user?._id });
  const ctx = { source, user, errors: [] };
  const stats = {};
  for (const type of ORDER.filter((t) => types.includes(t))) {
    try {
      stats[type] = await IMPORTERS[type](project, await getPayload(type), ctx);
    } catch (e) {
      ctx.errors.push(`${type}: ${e.message}`);
    }
  }
  if (evaluate) await evaluateProject(project._id);
  const failed = Object.keys(stats).length === 0;
  sync.status = failed ? 'Failed' : ctx.errors.length ? 'Partial' : 'Success';
  sync.stats = stats;
  sync.errorMessages = ctx.errors.slice(0, 50);
  sync.finishedAt = new Date();
  await sync.save();
  await audit(user, 'Integration sync', { entityType: 'IntegrationSync', entityId: sync._id, project: project._id, newValue: { source, types, status: sync.status } });
  return sync;
}

function validTypes(types) {
  const list = (types?.length ? types : SYNC_TYPES).filter((t) => SYNC_TYPES.includes(t));
  if (!list.length) throw new Error(`types must be any of: ${SYNC_TYPES.join(', ')}`);
  return list;
}

// Pull from Colab (live API or mock feed).
export async function syncFromColab(projectId, { types, user, evaluate } = {}) {
  const project = await Project.findById(projectId);
  if (!project) throw new Error('Project not found');
  return run(project, { source: 'colab', mode: 'pull', types: validTypes(types), user, evaluate, getPayload: (type) => fetchColab(type, project.code) });
}

// Push: an external system (or webhook) posts a Colab-format payload directly.
export async function importPayload(projectId, type, payload, { user, source = 'import' } = {}) {
  const project = await Project.findById(projectId);
  if (!project) throw new Error('Project not found');
  return run(project, { source, mode: 'push', types: validTypes([type]), user, getPayload: async () => payload });
}
