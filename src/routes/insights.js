import { Router } from 'express';
import {
  Activity, Blocker, Risk, Escalation, Notification, AuditLog,
} from '../models/index.js';
import { OPEN_BLOCKER_STATUSES, BLOCKER_TYPES, SEVERITIES } from '../models/constants.js';
import { requireRole } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { plannedProgressOn, buildLocationMap } from '../services/engine.js';
import { getRules, saveRules } from '../services/settings.js';
import { today, toDay, addDays, sameDay } from '../utils/dates.js';

const router = Router();

// ---------- Daily plan: today + next N days (derived from the activity plan) ----------
router.get('/daily-plan', async (req, res) => {
  const start = toDay(req.query.date || today());
  const days = Math.min(14, Number(req.query.days ?? 5));
  const end = addDays(start, days);
  const filter = {
    $or: [
      { plannedStart: { $lte: end }, plannedFinish: { $gte: start } },
      // Overdue / still-running work shows up on today's plan until completed.
      { plannedFinish: { $lt: start }, status: { $ne: 'Completed' } },
    ],
  };
  if (req.query.project) filter.project = req.query.project;
  const mine = req.query.mine === 'true' || (req.query.mine === undefined && req.user.role === 'site_engineer');
  if (mine) filter.responsible = req.user._id;

  const activities = await Activity.find(filter).populate('responsible', 'name').populate('project', 'name').sort({ plannedStart: 1 }).lean();
  const locations = new Map();
  for (const a of activities) {
    const pid = String(a.project._id);
    if (!locations.has(pid)) locations.set(pid, await buildLocationMap(pid));
  }
  const blockers = await Blocker.find({ activity: { $in: activities.map((a) => a._id) }, status: { $in: OPEN_BLOCKER_STATUSES } }).lean();

  const row = (a, day) => {
    let target;
    if (sameDay(day, a.plannedStart) && sameDay(day, a.plannedFinish)) target = 'Start & finish';
    else if (sameDay(day, a.plannedStart)) target = 'Start';
    else if (toDay(day) > toDay(a.plannedFinish)) target = 'Overdue';
    else target = `${plannedProgressOn(a, day)}%`;
    return {
      _id: a._id, code: a.code, name: a.name, project: a.project.name,
      location: locations.get(String(a.project._id)).path(a.structureNode),
      target, targetProgress: plannedProgressOn(a, day), status: a.status, health: a.health,
      actualProgress: a.metrics?.actualProgress ?? 0, plannedStart: a.plannedStart, plannedFinish: a.plannedFinish,
      plannedQuantity: a.plannedQuantity, unit: a.unit, responsible: a.responsible?.name,
      blockers: blockers.filter((b) => String(b.activity) === String(a._id)).map((b) => ({ type: b.type, description: b.description })),
    };
  };

  const plan = [];
  for (let i = 0; i <= days; i++) {
    const day = addDays(start, i);
    const items = activities
      .filter((a) => {
        const active = toDay(a.plannedStart) <= day && toDay(a.plannedFinish) >= day;
        const overdue = i === 0 && toDay(a.plannedFinish) < day && a.status !== 'Completed';
        return active || overdue;
      })
      .filter((a) => i === 0 || a.status !== 'Completed')
      .map((a) => row(a, day));
    plan.push({ date: day, items });
  }
  res.json({ date: start, today: plan[0], upcoming: plan.slice(1) });
});

// ---------- Management dashboard ----------
router.get('/dashboard', async (req, res) => {
  const scope = req.query.project ? { project: req.query.project } : {};
  const [activities, blockers, risks, escalations] = await Promise.all([
    Activity.find(scope).populate('structureNode', 'name').lean(),
    Blocker.find({ ...scope, status: { $in: OPEN_BLOCKER_STATUSES } }).lean(),
    Risk.find({ ...scope, status: 'Open' }).populate('escalatedTo', 'name role').populate('activity', 'name code').sort({ updatedAt: -1 }).lean(),
    Escalation.find({ ...scope, status: 'Open' }).populate('escalatedTo', 'name role').populate('activity', 'name').sort({ createdAt: -1 }).limit(10).lean(),
  ]);

  const status = { total: activities.length, 'On Track': 0, 'At Risk': 0, Delayed: 0, Blocked: 0, Completed: 0 };
  for (const a of activities) {
    status[a.health] += 1;
    if (a.status === 'Completed') status.Completed += 1;
  }
  const blockersByType = Object.fromEntries(BLOCKER_TYPES.map((t) => [t, 0]));
  for (const b of blockers) blockersByType[b.type] += 1;
  const risksBySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const r of risks) risksBySeverity[r.severity] += 1;

  const locationMaps = new Map();
  const locate = async (a) => {
    const pid = String(a.project);
    if (!locationMaps.has(pid)) locationMaps.set(pid, await buildLocationMap(pid));
    return locationMaps.get(pid).path(a.structureNode?._id);
  };
  const riskByActivity = new Map(risks.map((r) => [String(r.activity?._id), r]));
  const delayed = [];
  for (const a of activities.filter((x) => ['Delayed', 'Blocked'].includes(x.health) || (x.health === 'At Risk' && riskByActivity.has(String(x._id))))) {
    const blocker = blockers.find((b) => String(b.activity) === String(a._id));
    const risk = riskByActivity.get(String(a._id));
    delayed.push({
      _id: a._id, name: a.name, code: a.code, location: await locate(a),
      delayDays: Math.max(0, a.metrics?.scheduleVarianceDays ?? 0),
      progressVariance: a.metrics?.progressVariance ?? 0,
      reason: blocker ? `${blocker.type}: ${blocker.description}` : a.metrics?.healthReason,
      impact: risk?.impacted?.map((i) => i.name) ?? [],
      health: a.health, status: a.status, severity: risk?.severity,
    });
  }
  const rank = (s) => (s ? SEVERITIES.indexOf(s) : -1);
  delayed.sort((x, y) => rank(y.severity) - rank(x.severity) || y.delayDays - x.delayDays);

  res.json({ asOf: today(), status, blockersByType, risksBySeverity, delayed, risks, escalations });
});

// ---------- Risks & escalations ----------
router.get('/risks', async (req, res) => {
  const filter = {};
  if (req.query.project) filter.project = req.query.project;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.severity) filter.severity = req.query.severity;
  res.json(await Risk.find(filter).populate('activity', 'code name health status').populate('escalatedTo', 'name role').sort({ status: -1, updatedAt: -1 }).lean());
});

router.get('/escalations', async (req, res) => {
  const filter = {};
  if (req.query.project) filter.project = req.query.project;
  if (req.query.mine === 'true') filter.escalatedTo = req.user._id;
  res.json(await Escalation.find(filter).populate('activity', 'code name').populate('escalatedTo acknowledgedBy', 'name role').sort({ createdAt: -1 }).lean());
});

router.patch('/escalations/:id/acknowledge', async (req, res) => {
  const esc = await Escalation.findById(req.params.id);
  if (!esc) return res.status(404).json({ error: 'Escalation not found' });
  esc.status = 'Acknowledged';
  esc.acknowledgedAt = new Date();
  esc.acknowledgedBy = req.user._id;
  await esc.save();
  await audit(req.user, 'Escalation acknowledged', { entityType: 'Escalation', entityId: esc._id, project: esc.project, activity: esc.activity, comment: req.body?.note });
  res.json(esc);
});

// ---------- Notifications (in-app only for MVP) ----------
router.get('/notifications', async (req, res) => {
  const [items, unread] = await Promise.all([
    Notification.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(100).lean(),
    Notification.countDocuments({ user: req.user._id, read: false }),
  ]);
  res.json({ items, unread });
});

router.patch('/notifications/read-all', async (req, res) => {
  await Notification.updateMany({ user: req.user._id, read: false }, { $set: { read: true } });
  res.json({ ok: true });
});

router.patch('/notifications/:id/read', async (req, res) => {
  await Notification.updateOne({ _id: req.params.id, user: req.user._id }, { $set: { read: true } });
  res.json({ ok: true });
});

// ---------- Audit trail ----------
router.get('/audit-logs', requireRole('admin', 'project_manager', 'site_manager'), async (req, res) => {
  const filter = {};
  if (req.query.project) filter.project = req.query.project;
  if (req.query.activity) filter.activity = req.query.activity;
  res.json(await AuditLog.find(filter).populate('activity', 'code name').sort({ createdAt: -1 }).limit(Number(req.query.limit) || 200).lean());
});

// ---------- Configurable rules ----------
router.get('/settings/rules', async (req, res) => res.json(await getRules()));

router.put('/settings/rules', requireRole('admin'), async (req, res) => {
  const before = await getRules();
  const rules = await saveRules(req.body);
  await audit(req.user, 'Rules updated', { entityType: 'Setting', previousValue: before, newValue: rules });
  res.json(rules);
});

export default router;
