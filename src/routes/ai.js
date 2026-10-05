// AI endpoints. Mounted behind requireAuth: the browser never talks to Gemini directly, and the
// API key never leaves the server process.

import { Router } from 'express';
import { AiRun, AiPrediction, AiAlert, AiConversation, AiReport, Project, Activity, ExecutionLog, InventoryItem } from '../models/index.js';
import { generateReport } from '../services/ai/reports.js';
import { MANAGER_ROLES } from '../models/constants.js';
import { requireRole } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { aiConfig, checkRateLimit } from '../services/ai/gemini.js';
import {
  projectInsights, analyzeProject, runAgent, askCopilot, agentsForRole, canRunAgent,
  analysisFor, dailySummary, simulate, SCENARIOS,
} from '../services/ai/orchestrator.js';

const router = Router();

// Only requests that actually reach Gemini are rate limited; deterministic reads are not.
function limitModelCalls(req, res, next) {
  if (!aiConfig().configured) return next();
  const { ok, retryInSec } = checkRateLimit(req.user._id);
  if (!ok) {
    return res.status(429).json({ error: `AI rate limit reached. Try again in ${retryInSec}s.` });
  }
  next();
}

// ---------- Capability discovery ----------
router.get('/status', (req, res) => {
  const { configured, model, rateLimitPerMin } = aiConfig();
  res.json({
    configured,
    model: configured ? model : null,
    rateLimitPerMin,
    agents: agentsForRole(req.user.role),
    scenarios: Object.entries(SCENARIOS).map(([key, v]) => ({ key, ...v })),
    note: configured ? null : 'Set GEMINI_API_KEY in the backend environment to enable narration. Calculated figures work without it.',
  });
});

// ---------- Insights (deterministic, no model call) ----------
router.get('/projects/:id/insights', async (req, res) => {
  res.json(await projectInsights(req.params.id, { role: req.user.role }));
});

router.get('/projects/:id/daily-summary', async (req, res) => {
  res.json(await dailySummary(req.params.id, req.query.date));
});

router.get('/projects/:id/health', async (req, res) => {
  const { parts } = await analysisFor(req.params.id);
  res.json(parts.health);
});

// ---------- Agent runs (model calls) ----------
router.post('/projects/:id/analyze', requireRole(...MANAGER_ROLES, 'planning_engineer'), limitModelCalls, async (req, res) => {
  const keys = (req.body?.agents || []).filter((k) => canRunAgent(req.user.role, k));
  const { results } = await analyzeProject({
    projectId: req.params.id, user: req.user, agentKeys: keys, trigger: 'manual',
  });
  await audit(req.user, 'AI analysis run', {
    entityType: 'Project', entityId: req.params.id, project: req.params.id,
    newValue: { agents: results.map((r) => r.agent) },
  });
  res.json(await projectInsights(req.params.id, { role: req.user.role }));
});

router.post('/projects/:id/agents/:agent', limitModelCalls, async (req, res) => {
  if (!canRunAgent(req.user.role, req.params.agent)) {
    return res.status(403).json({ error: `The ${req.params.agent} agent is not available for your role` });
  }
  const { agent, title, output, run } = await runAgent({
    projectId: req.params.id, agentKey: req.params.agent, user: req.user, trigger: 'manual',
  });
  res.json({ agent, title, output, runId: run._id, status: run.status, ranAt: run.createdAt });
});

// ---------- What-if simulation ----------
router.post('/projects/:id/simulate', requireRole(...MANAGER_ROLES, 'planning_engineer'), async (req, res) => {
  const result = await simulate(req.params.id, req.body || {});
  await AiRun.create({
    project: req.params.id, agent: 'copilot', trigger: 'manual', user: req.user._id,
    question: `Simulation: ${req.body?.type}`, context: req.body, output: result, status: 'Success',
  });
  res.json(result);
});

// ---------- Copilot ----------
router.post('/ask', limitModelCalls, async (req, res) => {
  const question = String(req.body?.question || '').trim();
  if (!question) return res.status(400).json({ error: 'question is required' });
  if (question.length > 1000) return res.status(400).json({ error: 'question must be 1000 characters or fewer' });
  res.json(await askCopilot({
    question, projectId: req.body.project || null, user: req.user, conversationId: req.body.conversation,
  }));
});

router.get('/conversations', async (req, res) => {
  res.json(await AiConversation.find({ user: req.user._id }).sort({ updatedAt: -1 }).limit(20).lean());
});

// ---------- Predictions: accept / reject / override (§33, §34) ----------
router.get('/projects/:id/predictions', async (req, res) => {
  res.json(await AiPrediction.find({ project: req.params.id }).sort({ createdAt: -1 }).limit(50)
    .populate('decidedBy', 'name role').lean());
});

router.patch('/predictions/:id/decision', requireRole(...MANAGER_ROLES, 'planning_engineer'), async (req, res) => {
  const { decision, value, reason } = req.body || {};
  if (!['Accepted', 'Rejected', 'Overridden'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be Accepted, Rejected or Overridden' });
  }
  const prediction = await AiPrediction.findById(req.params.id);
  if (!prediction) return res.status(404).json({ error: 'Prediction not found' });
  if (decision === 'Overridden' && value === undefined) {
    return res.status(400).json({ error: 'value is required when overriding a prediction' });
  }
  prediction.status = decision;
  prediction.decidedBy = req.user._id;
  prediction.decidedAt = new Date();
  if (decision === 'Overridden') prediction.override = { value, reason };
  await prediction.save();
  await audit(req.user, `AI prediction ${decision.toLowerCase()}`, {
    entityType: 'AiPrediction', entityId: prediction._id, project: prediction.project,
    activity: prediction.activity, field: prediction.kind,
    previousValue: prediction.value, newValue: decision === 'Overridden' ? value : decision, comment: reason,
  });
  res.json(await prediction.populate('decidedBy', 'name role'));
});

// ---------- Alert centre ----------
router.get('/alerts', async (req, res) => {
  const filter = { status: req.query.status || 'Open' };
  if (req.query.project) filter.project = req.query.project;
  res.json(await AiAlert.find(filter).populate('project', 'code name').populate('acknowledgedBy', 'name')
    .sort({ createdAt: -1 }).limit(100).lean());
});

router.patch('/alerts/:id/acknowledge', async (req, res) => {
  const alert = await AiAlert.findById(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  alert.status = 'Acknowledged';
  alert.acknowledgedBy = req.user._id;
  alert.acknowledgedAt = new Date();
  await alert.save();
  await audit(req.user, 'AI alert acknowledged', {
    entityType: 'AiAlert', entityId: alert._id, project: alert.project, comment: alert.title,
  });
  res.json(alert);
});

// ---------- Run log (auditability) ----------
router.get('/runs', requireRole(...MANAGER_ROLES), async (req, res) => {
  const filter = {};
  if (req.query.project) filter.project = req.query.project;
  if (req.query.agent) filter.agent = req.query.agent;
  const runs = await AiRun.find(filter, '-context').populate('user', 'name role').populate('project', 'code name')
    .sort({ createdAt: -1 }).limit(Number(req.query.limit) || 50).lean();
  res.json(runs);
});

router.get('/runs/:id', requireRole(...MANAGER_ROLES), async (req, res) => {
  const run = await AiRun.findById(req.params.id).populate('user', 'name role').lean();
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(run);
});

// ---------- Reports ----------
router.post('/projects/:id/reports', requireRole(...MANAGER_ROLES, 'planning_engineer', 'estimation_engineer'), limitModelCalls, async (req, res) => {
  const kind = req.body?.kind || 'health';
  const doc = await generateReport({ projectId: req.params.id, kind, user: req.user, date: req.body?.date });
  res.status(201).json(doc);
});

router.get('/projects/:id/reports', async (req, res) => {
  res.json(await AiReport.find({ project: req.params.id }).sort({ createdAt: -1 }).limit(20)
    .populate('generatedBy', 'name role').lean());
});

// ---------- Portfolio snapshot for the management dashboard (deterministic) ----------
router.get('/portfolio', async (req, res) => {
  const projects = await Project.find({ status: { $in: ['Active', 'Planning'] } }).lean();
  const [activities, alerts, logs, stock] = await Promise.all([
    Activity.find({ project: { $in: projects.map((p) => p._id) } }).lean(),
    AiAlert.find({ status: 'Open' }).populate('project', 'code name').sort({ createdAt: -1 }).limit(20).lean(),
    ExecutionLog.find({}).sort({ date: -1 }).limit(80).lean(),
    InventoryItem.find({}).lean(),
  ]);
  const byProject = new Map();
  for (const a of activities) {
    const pid = String(a.project);
    if (!byProject.has(pid)) byProject.set(pid, { actual: 0, planned: 0, n: 0, atRisk: 0 });
    const row = byProject.get(pid);
    row.actual += a.metrics?.actualProgress ?? 0;
    row.planned += a.metrics?.plannedProgress ?? 0;
    row.n += 1;
    if (['At Risk', 'Delayed', 'Blocked'].includes(a.health)) row.atRisk += 1;
  }
  const progress = [...byProject.values()].map((r) => r.n ? r.actual / r.n : 0);
  const latestDay = logs[0]?.date;
  const todayLogs = latestDay ? logs.filter((l) => String(l.date) === String(latestDay)) : [];
  const labourToday = todayLogs.reduce((t, l) => t + (l.manpower || []).reduce((s, m) => s + (m.actual || 0), 0), 0);
  const lowStock = stock.filter((i) => i.stock <= i.reorderLevel || i.stock <= i.minStock).length;
  res.json({
    projects: projects.length,
    averageProgress: progress.length ? Math.round(progress.reduce((a, b) => a + b, 0) / progress.length) : 0,
    projectsAtRisk: [...byProject.values()].filter((r) => r.atRisk > 0).length,
    labourToday,
    labourAsOf: latestDay || null,
    lowStockItems: lowStock,
    criticalAlerts: alerts.filter((a) => a.level === 'critical').length,
    alerts,
  });
});

export default router;
