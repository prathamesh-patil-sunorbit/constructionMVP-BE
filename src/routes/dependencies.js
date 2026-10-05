import { Router } from 'express';
import { Activity, Dependency } from '../models/index.js';
import { MANAGER_ROLES } from '../models/constants.js';
import { requireRole } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { evaluateProject } from '../services/engine.js';

const router = Router();

async function createsCycle(projectId, predecessor, successor) {
  // Adding predecessor -> successor creates a cycle if predecessor is reachable from successor.
  const deps = await Dependency.find({ project: projectId }, 'predecessor successor').lean();
  const stack = [String(successor)];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (cur === String(predecessor)) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const d of deps) if (String(d.predecessor) === cur) stack.push(String(d.successor));
  }
  return false;
}

router.get('/', async (req, res) => {
  const filter = req.query.project ? { project: req.query.project } : {};
  res.json(await Dependency.find(filter).populate('predecessor successor', 'code name status health').lean());
});

router.post('/', requireRole(...MANAGER_ROLES), async (req, res) => {
  const { predecessor, successor, lagDays } = req.body;
  if (!predecessor || !successor || predecessor === successor) return res.status(400).json({ error: 'Choose two different activities' });
  const [pred, succ] = await Promise.all([Activity.findById(predecessor), Activity.findById(successor)]);
  if (!pred || !succ) return res.status(404).json({ error: 'Activity not found' });
  if (String(pred.project) !== String(succ.project)) return res.status(400).json({ error: 'Activities must belong to the same project' });
  if (await Dependency.exists({ predecessor, successor })) return res.status(409).json({ error: 'Dependency already exists' });
  if (await createsCycle(pred.project, predecessor, successor)) return res.status(400).json({ error: 'This dependency would create a cycle' });
  const dep = await Dependency.create({ project: pred.project, predecessor, successor, type: 'FS', lagDays: Number(lagDays) || 0 });
  await audit(req.user, 'Dependency created', {
    entityType: 'Dependency', entityId: dep._id, project: pred.project, activity: succ._id,
    newValue: `${pred.name} → ${succ.name} (FS)`,
  });
  await evaluateProject(pred.project);
  res.status(201).json(dep);
});

router.delete('/:id', requireRole(...MANAGER_ROLES), async (req, res) => {
  const dep = await Dependency.findById(req.params.id).populate('predecessor successor', 'name');
  if (!dep) return res.status(404).json({ error: 'Dependency not found' });
  await dep.deleteOne();
  await audit(req.user, 'Dependency deleted', {
    entityType: 'Dependency', entityId: dep._id, project: dep.project, activity: dep.successor?._id,
    previousValue: `${dep.predecessor?.name} → ${dep.successor?.name}`,
  });
  await evaluateProject(dep.project);
  res.json({ ok: true });
});

export default router;
