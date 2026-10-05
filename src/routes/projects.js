import { Router } from 'express';
import { Project, StructureNode, Activity, Risk, Blocker } from '../models/index.js';
import { MANAGER_ROLES, OPEN_BLOCKER_STATUSES } from '../models/constants.js';
import { requireRole } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { evaluateProject } from '../services/engine.js';
import { toDay } from '../utils/dates.js';

const router = Router();
const PROJECT_FIELDS = ['code', 'name', 'location', 'projectType', 'startDate', 'plannedCompletionDate', 'status', 'projectManager', 'siteManager'];
const pick = (body, fields) => Object.fromEntries(fields.filter((f) => body[f] !== undefined).map((f) => [f, body[f] === '' ? null : body[f]]));

router.get('/', async (req, res) => {
  const projects = await Project.find().populate('projectManager siteManager', 'name email role').sort({ createdAt: -1 }).lean();
  const counts = await Activity.aggregate([{ $group: { _id: { project: '$project', health: '$health' }, n: { $sum: 1 } } }]);
  for (const p of projects) {
    p.health = {};
    for (const c of counts) if (String(c._id.project) === String(p._id)) p.health[c._id.health] = c.n;
    p.totalActivities = Object.values(p.health).reduce((a, b) => a + b, 0);
  }
  res.json(projects);
});

router.post('/', requireRole('admin'), async (req, res) => {
  const data = pick(req.body, PROJECT_FIELDS);
  for (const f of ['startDate', 'plannedCompletionDate']) if (data[f]) data[f] = toDay(data[f]);
  const project = await Project.create(data);
  await audit(req.user, 'Project created', { entityType: 'Project', entityId: project._id, project: project._id, newValue: data });
  res.status(201).json(project);
});

router.get('/:id', async (req, res) => {
  const project = await Project.findById(req.params.id).populate('projectManager siteManager', 'name email role');
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(project);
});

router.patch('/:id', requireRole('admin', 'project_manager'), async (req, res) => {
  const project = await Project.findById(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const data = pick(req.body, PROJECT_FIELDS);
  for (const f of ['startDate', 'plannedCompletionDate']) if (data[f]) data[f] = toDay(data[f]);
  const before = pick(project.toObject(), Object.keys(data));
  Object.assign(project, data);
  await project.save();
  await audit(req.user, 'Project updated', { entityType: 'Project', entityId: project._id, project: project._id, previousValue: before, newValue: data });
  res.json(project);
});

router.post('/:id/evaluate', requireRole(...MANAGER_ROLES), async (req, res) => {
  res.json(await evaluateProject(req.params.id));
});

// Drill-down tree: Project -> Tower -> Floor (any depth), with health rolled up per node.
router.get('/:id/tree', async (req, res) => {
  const projectId = req.params.id;
  const [nodes, activities, risks, blockers] = await Promise.all([
    StructureNode.find({ project: projectId }).sort({ order: 1, name: 1 }).lean(),
    Activity.find({ project: projectId }, 'structureNode health status').lean(),
    Risk.find({ project: projectId, status: 'Open' }, 'activity severity').lean(),
    Blocker.find({ project: projectId, status: { $in: OPEN_BLOCKER_STATUSES } }, 'activity').lean(),
  ]);
  const actNode = new Map(activities.map((a) => [String(a._id), String(a.structureNode)]));
  const byId = new Map(nodes.map((n) => [String(n._id), { ...n, children: [], summary: { total: 0, 'On Track': 0, 'At Risk': 0, Delayed: 0, Blocked: 0, Completed: 0, risks: 0, blockers: 0 } }]));
  const bubble = (nodeId, fn) => {
    let n = byId.get(nodeId);
    while (n) { fn(n.summary); n = n.parent ? byId.get(String(n.parent)) : null; }
  };
  for (const a of activities) {
    bubble(String(a.structureNode), (s) => { s.total += 1; s[a.health] += 1; if (a.status === 'Completed') s.Completed += 1; });
  }
  for (const r of risks) bubble(actNode.get(String(r.activity)), (s) => { s.risks += 1; });
  for (const b of blockers) bubble(actNode.get(String(b.activity)), (s) => { s.blockers += 1; });
  const roots = [];
  for (const n of byId.values()) {
    if (n.parent && byId.has(String(n.parent))) byId.get(String(n.parent)).children.push(n);
    else roots.push(n);
  }
  res.json(roots);
});

router.post('/:id/structure', requireRole(...MANAGER_ROLES), async (req, res) => {
  const { name, type, parent, order } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const node = await StructureNode.create({ project: req.params.id, name, type: type || 'Zone', parent: parent || null, order: order || 0 });
  await audit(req.user, 'Structure node created', { entityType: 'StructureNode', entityId: node._id, project: req.params.id, newValue: { name, type } });
  res.status(201).json(node);
});

router.delete('/:id/structure/:nodeId', requireRole(...MANAGER_ROLES), async (req, res) => {
  const hasChildren = await StructureNode.exists({ parent: req.params.nodeId });
  const hasActivities = await Activity.exists({ structureNode: req.params.nodeId });
  if (hasChildren || hasActivities) return res.status(400).json({ error: 'Node has child nodes or activities' });
  await StructureNode.deleteOne({ _id: req.params.nodeId, project: req.params.id });
  await audit(req.user, 'Structure node deleted', { entityType: 'StructureNode', entityId: req.params.nodeId, project: req.params.id });
  res.json({ ok: true });
});

export default router;
