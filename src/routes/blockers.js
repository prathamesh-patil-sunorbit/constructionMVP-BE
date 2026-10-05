import { Router } from 'express';
import { Activity, Blocker } from '../models/index.js';
import { MANAGER_ROLES, BLOCKER_TYPES, BLOCKER_STATUSES } from '../models/constants.js';
import { audit } from '../services/audit.js';
import { evaluateProject } from '../services/engine.js';
import { onProjectEvent } from '../services/ai/orchestrator.js';
import { today, toDay } from '../utils/dates.js';

const router = Router();

// Allowed lifecycle transitions: Open -> Assigned -> In Progress -> Resolved -> Closed.
const TRANSITIONS = {
  Open: ['Assigned', 'In Progress', 'Resolved'],
  Assigned: ['In Progress', 'Resolved'],
  'In Progress': ['Resolved'],
  Resolved: ['Closed', 'Open'],
  Closed: [],
};

router.get('/', async (req, res) => {
  const filter = {};
  if (req.query.project) filter.project = req.query.project;
  if (req.query.activity) filter.activity = req.query.activity;
  if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };
  if (req.query.type) filter.type = req.query.type;
  if (req.query.mine === 'true') {
    const mine = await Activity.find({ responsible: req.user._id }, '_id').lean();
    filter.activity = { $in: mine.map((a) => a._id) };
  }
  res.json(await Blocker.find(filter)
    .populate('activity', 'code name health status')
    .populate('reportedBy assignedTo', 'name role')
    .sort({ createdAt: -1 })
    .lean());
});

router.post('/', async (req, res) => {
  const { activity: activityId, type, description, severity, expectedResolution, reportedDate } = req.body;
  const activity = await Activity.findById(activityId);
  if (!activity) return res.status(404).json({ error: 'Activity not found' });
  if (!BLOCKER_TYPES.includes(type) || !description) return res.status(400).json({ error: 'Valid blocker type and description are required' });
  const blocker = await Blocker.create({
    project: activity.project, activity: activity._id, type, description, severity: severity || 'Medium',
    expectedResolution: expectedResolution ? toDay(expectedResolution) : undefined,
    reportedBy: req.user._id, reportedDate: toDay(reportedDate || today()),
    history: [{ status: 'Open', note: 'Blocker reported', by: req.user._id }],
  });
  await audit(req.user, 'Blocker created', {
    entityType: 'Blocker', entityId: blocker._id, project: activity.project, activity: activity._id,
    newValue: { type, severity: blocker.severity }, comment: description,
  });
  await evaluateProject(activity.project);
  onProjectEvent(activity.project, { reason: `Blocker reported on ${activity.code}` });
  res.status(201).json(blocker);
});

router.patch('/:id', async (req, res) => {
  const blocker = await Blocker.findById(req.params.id);
  if (!blocker) return res.status(404).json({ error: 'Blocker not found' });
  const { status, note, assignedTo, expectedResolution, severity } = req.body;
  const isManager = MANAGER_ROLES.includes(req.user.role);

  if (status && status !== blocker.status) {
    if (!BLOCKER_STATUSES.includes(status) || !TRANSITIONS[blocker.status].includes(status)) {
      return res.status(400).json({ error: `Cannot move blocker from ${blocker.status} to ${status}` });
    }
    if (status === 'Closed' && !isManager) return res.status(403).json({ error: 'Only managers can close blockers' });
    const prev = blocker.status;
    blocker.status = status;
    if (status === 'Resolved') { blocker.resolvedAt = new Date(); blocker.resolutionNote = note; }
    blocker.history.push({ status, note, by: req.user._id });
    await audit(req.user, status === 'Resolved' ? 'Blocker resolved' : 'Blocker status changed', {
      entityType: 'Blocker', entityId: blocker._id, project: blocker.project, activity: blocker.activity,
      field: 'status', previousValue: prev, newValue: status, comment: note,
    });
  }
  if (assignedTo !== undefined && isManager) {
    blocker.assignedTo = assignedTo || null;
    if (blocker.status === 'Open' && assignedTo) {
      blocker.status = 'Assigned';
      blocker.history.push({ status: 'Assigned', note: note || 'Assigned', by: req.user._id });
    }
  }
  if (expectedResolution !== undefined) blocker.expectedResolution = expectedResolution ? toDay(expectedResolution) : null;
  if (severity) blocker.severity = severity;
  await blocker.save();
  await evaluateProject(blocker.project);
  res.json(await Blocker.findById(blocker._id).populate('activity', 'code name').populate('reportedBy assignedTo', 'name role'));
});

export default router;
