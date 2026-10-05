import { Router } from 'express';
import crypto from 'node:crypto';
import { IntegrationSync, Team, User } from '../models/index.js';
import { SYNC_TYPES, TEAM_TYPES } from '../models/constants.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { colabStatus } from '../integrations/colab/client.js';
import { importPayload, syncFromColab } from '../integrations/importer.js';

const router = Router();

// Machine-to-machine pushes (webhooks, scripts) authenticate with INTEGRATION_API_KEY;
// people authenticate with their normal login.
function keyMatches(given) {
  const expected = process.env.INTEGRATION_API_KEY;
  if (!expected || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authUserOrKey(req, res, next) {
  if (keyMatches(req.headers['x-integration-key'])) return next();
  requireAuth(req, res, () => requireRole('admin', 'project_manager')(req, res, next));
}

router.post('/import/:type', authUserOrKey, async (req, res) => {
  const { project, source } = req.query;
  if (!project) return res.status(400).json({ error: 'project query parameter is required' });
  if (!SYNC_TYPES.includes(req.params.type)) return res.status(400).json({ error: `type must be one of ${SYNC_TYPES.join(', ')}` });
  const sync = await importPayload(project, req.params.type, req.body, { user: req.user, source: source || 'import' });
  res.status(sync.status === 'Failed' ? 422 : 201).json(sync);
});

router.use(requireAuth);

router.get('/sources', (req, res) => res.json([colabStatus()]));

router.post('/colab/sync', requireRole('admin', 'project_manager'), async (req, res) => {
  const { project, types } = req.body || {};
  if (!project) return res.status(400).json({ error: 'project is required' });
  const sync = await syncFromColab(project, { types, user: req.user });
  res.status(sync.status === 'Failed' ? 502 : 201).json(sync);
});

router.get('/syncs', async (req, res) => {
  const filter = req.query.project ? { project: req.query.project } : {};
  res.json(await IntegrationSync.find(filter).populate('triggeredBy', 'name').sort({ startedAt: -1 }).limit(30).lean());
});

// ---------- Teams ----------
router.get('/teams', async (req, res) => {
  const filter = req.query.project ? { project: req.query.project } : {};
  res.json(await Team.find(filter).populate('lead members', 'name email role').sort({ type: 1, name: 1 }).lean());
});

router.post('/teams', requireRole('admin', 'project_manager'), async (req, res) => {
  const { project, code, name, type, lead, members } = req.body || {};
  if (!project || !code || !name || !TEAM_TYPES.includes(type)) {
    return res.status(400).json({ error: `project, code, name and type (${TEAM_TYPES.join('/')}) are required` });
  }
  const team = await Team.create({ project, code, name, type, lead: lead || undefined, members: members || [] });
  await audit(req.user, 'Team created', { entityType: 'Team', entityId: team._id, project, newValue: { code, name, type } });
  res.status(201).json(team);
});

router.patch('/teams/:id', requireRole('admin', 'project_manager'), async (req, res) => {
  const team = await Team.findById(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  for (const f of ['name', 'lead', 'members']) if (req.body[f] !== undefined) team[f] = req.body[f] || undefined;
  if (req.body.members) {
    const count = await User.countDocuments({ _id: { $in: req.body.members } });
    if (count !== req.body.members.length) return res.status(400).json({ error: 'Unknown member' });
  }
  await team.save();
  await audit(req.user, 'Team updated', { entityType: 'Team', entityId: team._id, project: team.project, newValue: { name: team.name, members: team.members.length } });
  res.json(team);
});

export default router;
