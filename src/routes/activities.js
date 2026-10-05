import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import {
  Activity, Dependency, ProgressUpdate, Blocker, Risk, Escalation, Comment, Attachment, AuditLog, StructureNode,
  Estimate, ExecutionLog, Team,
} from '../models/index.js';
import { MANAGER_ROLES, BLOCKER_TYPES } from '../models/constants.js';
import { requireRole, HttpError } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { evaluateProject, plannedDuration, plannedProgressOn, buildLocationMap } from '../services/engine.js';
import { onProjectEvent } from '../services/ai/orchestrator.js';
import { today, toDay } from '../utils/dates.js';

const router = Router();
const ACTIVITY_FIELDS = ['code', 'name', 'structureNode', 'wbs', 'plannedStart', 'plannedFinish', 'plannedQuantity', 'unit', 'responsible', 'priority'];

export const UPLOAD_DIR = path.resolve('uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.-]+/g, '_')}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

async function descendantNodeIds(nodeId) {
  const ids = [String(nodeId)];
  for (let i = 0; i < ids.length; i++) {
    const children = await StructureNode.find({ parent: ids[i] }, '_id').lean();
    ids.push(...children.map((c) => String(c._id)));
  }
  return ids;
}

async function loadActivity(id) {
  const activity = await Activity.findById(id);
  if (!activity) throw new HttpError(404, 'Activity not found');
  return activity;
}

function canUpdateExecution(user, activity) {
  return MANAGER_ROLES.includes(user.role) || String(activity.responsible) === String(user._id);
}

async function activityDetail(id) {
  const activity = await Activity.findById(id)
    .populate('responsible', 'name email role')
    .populate({ path: 'project', populate: { path: 'projectManager siteManager', select: 'name email role' } })
    .populate('structureNode')
    .lean();
  if (!activity) throw new HttpError(404, 'Activity not found');
  const [predDeps, succDeps, history, blockers, risks, escalations, comments, attachments, auditLogs, location, estimates, executionLogs, teams] = await Promise.all([
    Dependency.find({ successor: id }).populate('predecessor', 'code name status health plannedStart plannedFinish metrics').lean(),
    Dependency.find({ predecessor: id }).populate('successor', 'code name status health plannedStart plannedFinish metrics').lean(),
    ProgressUpdate.find({ activity: id }).populate('reportedBy', 'name role').sort({ date: -1, createdAt: -1 }).lean(),
    Blocker.find({ activity: id }).populate('reportedBy assignedTo history.by', 'name role').sort({ createdAt: -1 }).lean(),
    Risk.find({ activity: id }).populate('escalatedTo', 'name role').sort({ createdAt: -1 }).lean(),
    Escalation.find({ activity: id }).populate('escalatedTo acknowledgedBy', 'name role').sort({ createdAt: -1 }).lean(),
    Comment.find({ activity: id }).populate('user', 'name role').sort({ createdAt: -1 }).lean(),
    Attachment.find({ activity: id }).populate('uploadedBy', 'name role').sort({ createdAt: -1 }).lean(),
    AuditLog.find({ activity: id }).sort({ createdAt: -1 }).limit(100).lean(),
    buildLocationMap(activity.project._id),
    Estimate.find({ activity: id }).populate('preparedBy', 'name role').lean(),
    ExecutionLog.find({ activity: id }).populate('reportedBy', 'name role').sort({ date: -1 }).lean(),
    Team.find({ project: activity.project._id }).populate('lead', 'name role').lean(),
  ]);
  return {
    ...activity,
    location: location.path(activity.structureNode?._id),
    predecessors: predDeps.map((d) => ({ dependencyId: d._id, type: d.type, lagDays: d.lagDays, activity: d.predecessor })),
    successors: succDeps.map((d) => ({ dependencyId: d._id, type: d.type, lagDays: d.lagDays, activity: d.successor })),
    history, blockers, risks, escalations, comments, attachments, auditLogs, estimates, executionLogs,
    teams: teams.map((t) => ({ _id: t._id, name: t.name, type: t.type, lead: t.lead })),
  };
}

router.get('/', async (req, res) => {
  const filter = {};
  if (req.query.project) filter.project = req.query.project;
  if (req.query.node) filter.structureNode = { $in: await descendantNodeIds(req.query.node) };
  if (req.query.health) filter.health = { $in: String(req.query.health).split(',') };
  if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };
  if (req.query.responsible) filter.responsible = req.query.responsible === 'me' ? req.user._id : req.query.responsible;
  const activities = await Activity.find(filter)
    .populate('responsible', 'name role')
    .populate('structureNode', 'name type')
    .sort({ plannedStart: 1, code: 1 })
    .lean();
  res.json(activities);
});

router.post('/', requireRole(...MANAGER_ROLES), async (req, res) => {
  const data = Object.fromEntries(ACTIVITY_FIELDS.filter((f) => req.body[f] !== undefined && req.body[f] !== '').map((f) => [f, req.body[f]]));
  if (!req.body.project || !data.name || !data.plannedStart || !data.plannedFinish) {
    return res.status(400).json({ error: 'project, name, plannedStart and plannedFinish are required' });
  }
  data.plannedStart = toDay(data.plannedStart);
  data.plannedFinish = toDay(data.plannedFinish);
  if (data.plannedFinish < data.plannedStart) return res.status(400).json({ error: 'Planned finish must be on or after planned start' });
  if (!data.code) data.code = `ACT-${String((await Activity.countDocuments({ project: req.body.project })) + 1).padStart(3, '0')}`;
  const activity = new Activity({ ...data, project: req.body.project });
  activity.plannedDuration = plannedDuration(activity);
  await activity.save();
  await audit(req.user, 'Activity created', { entityType: 'Activity', entityId: activity._id, project: activity.project, activity: activity._id, newValue: data });
  await evaluateProject(activity.project);
  res.status(201).json(await Activity.findById(activity._id));
});

router.get('/:id', async (req, res) => {
  res.json(await activityDetail(req.params.id));
});

router.patch('/:id', requireRole(...MANAGER_ROLES), async (req, res) => {
  const activity = await loadActivity(req.params.id);
  for (const f of ACTIVITY_FIELDS) {
    if (req.body[f] === undefined) continue;
    let value = req.body[f] === '' ? null : req.body[f];
    if (['plannedStart', 'plannedFinish'].includes(f) && value) value = toDay(value);
    const prev = activity[f];
    if (String(prev ?? '') === String(value ?? '')) continue;
    activity[f] = value;
    await audit(req.user, 'Activity changed', {
      entityType: 'Activity', entityId: activity._id, project: activity.project, activity: activity._id,
      field: f, previousValue: prev, newValue: value, comment: req.body.comment,
    });
  }
  if (activity.plannedFinish < activity.plannedStart) return res.status(400).json({ error: 'Planned finish must be on or after planned start' });
  activity.plannedDuration = plannedDuration(activity);
  await activity.save();
  await evaluateProject(activity.project);
  res.json(await activityDetail(activity._id));
});

router.delete('/:id', requireRole(...MANAGER_ROLES), async (req, res) => {
  const activity = await loadActivity(req.params.id);
  await Dependency.deleteMany({ $or: [{ predecessor: activity._id }, { successor: activity._id }] });
  await Estimate.deleteMany({ activity: activity._id });
  await ExecutionLog.deleteMany({ activity: activity._id });
  await activity.deleteOne();
  await audit(req.user, 'Activity deleted', { entityType: 'Activity', entityId: activity._id, project: activity.project, previousValue: { code: activity.code, name: activity.name } });
  await evaluateProject(activity.project);
  res.json({ ok: true });
});

// Daily actual update. Always appends a new ProgressUpdate (history is never overwritten).
router.post('/:id/progress', async (req, res) => {
  const activity = await loadActivity(req.params.id);
  if (!canUpdateExecution(req.user, activity)) return res.status(403).json({ error: 'Only the responsible engineer or a manager can update this activity' });

  const date = toDay(req.body.date || today());
  if (date > today()) return res.status(400).json({ error: 'Cannot report progress for a future date' });
  let actualProgress = req.body.actualProgress === '' || req.body.actualProgress == null ? null : Number(req.body.actualProgress);
  const actualQuantity = req.body.actualQuantity === '' || req.body.actualQuantity == null ? null : Number(req.body.actualQuantity);
  if (actualProgress == null && actualQuantity != null && activity.plannedQuantity) {
    actualProgress = Math.min(100, Math.round((actualQuantity / activity.plannedQuantity) * 100));
  }
  if (actualProgress == null || Number.isNaN(actualProgress) || actualProgress < 0 || actualProgress > 100) {
    return res.status(400).json({ error: 'Actual progress must be between 0 and 100 (or provide actual quantity)' });
  }

  const status = req.body.status || undefined;
  if (status === 'Blocked') {
    const b = req.body.blocker || {};
    if (!BLOCKER_TYPES.includes(b.type) || !b.description) {
      return res.status(400).json({ error: 'Marking an activity Blocked requires a blocker type and description' });
    }
  }

  const previous = activity.metrics?.actualProgress ?? 0;
  const update = await ProgressUpdate.create({
    project: activity.project, activity: activity._id, date,
    plannedQuantity: activity.plannedQuantity, actualQuantity: actualQuantity ?? (activity.plannedQuantity ? Math.round((actualProgress / 100) * activity.plannedQuantity) : undefined),
    plannedProgress: plannedProgressOn(activity, date), actualProgress, status, comment: req.body.comment,
    reportedBy: req.user._id,
  });
  await audit(req.user, 'Updated progress', {
    entityType: 'ProgressUpdate', entityId: update._id, project: activity.project, activity: activity._id,
    field: 'actualProgress', previousValue: `${previous}%`, newValue: `${actualProgress}%`, comment: req.body.comment,
  });

  // Business rule: activity is blocked -> create blocker.
  if (status === 'Blocked') {
    const b = req.body.blocker;
    const blocker = await Blocker.create({
      project: activity.project, activity: activity._id, type: b.type, description: b.description,
      severity: b.severity || 'Medium', expectedResolution: b.expectedResolution ? toDay(b.expectedResolution) : undefined,
      reportedBy: req.user._id, reportedDate: date,
      history: [{ status: 'Open', note: 'Reported with progress update', by: req.user._id }],
    });
    await audit(req.user, 'Blocker created', {
      entityType: 'Blocker', entityId: blocker._id, project: activity.project, activity: activity._id,
      newValue: { type: b.type, severity: blocker.severity }, comment: b.description,
    });
  }

  await evaluateProject(activity.project);
  // AI re-analysis runs in the background: the engineer's update must not wait on it.
  onProjectEvent(activity.project, { reason: `Progress update on ${activity.code}` });
  res.status(201).json(await activityDetail(activity._id));
});

router.post('/:id/comments', async (req, res) => {
  const activity = await loadActivity(req.params.id);
  if (!req.body.text) return res.status(400).json({ error: 'Comment text is required' });
  const comment = await Comment.create({ activity: activity._id, project: activity.project, user: req.user._id, text: req.body.text });
  await audit(req.user, 'Comment added', { entityType: 'Comment', entityId: comment._id, project: activity.project, activity: activity._id, comment: req.body.text });
  res.status(201).json(await Comment.findById(comment._id).populate('user', 'name role'));
});

router.post('/:id/attachments', upload.single('file'), async (req, res) => {
  const activity = await loadActivity(req.params.id);
  if (!req.file) return res.status(400).json({ error: 'A file is required' });
  const att = await Attachment.create({
    activity: activity._id, project: activity.project, uploadedBy: req.user._id,
    originalName: req.file.originalname, filename: req.file.filename, url: `/uploads/${req.file.filename}`,
    mimetype: req.file.mimetype, size: req.file.size, caption: req.body.caption,
  });
  await audit(req.user, 'Evidence uploaded', { entityType: 'Attachment', entityId: att._id, project: activity.project, activity: activity._id, newValue: req.file.originalname, comment: req.body.caption });
  res.status(201).json(await Attachment.findById(att._id).populate('uploadedBy', 'name role'));
});

export default router;
