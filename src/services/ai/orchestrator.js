// AI orchestration layer.
//
//   request -> intent -> agent -> deterministic analytics -> Gemini narration -> validation
//           -> AiRun / AiPrediction / AiAlert -> dashboard
//
// The deterministic analytics always run. The model is optional: if GEMINI_API_KEY is absent or
// the call fails, the agent still returns its calculated figures and a deterministic headline,
// and the run is recorded as Degraded.

import { Type } from '@google/genai';
import { AiRun, AiPrediction, AiAlert, AiConversation, Project } from '../../models/index.js';
import { AI_AGENTS } from '../../models/constants.js';
import { askGemini, aiConfig } from './gemini.js';
import { buildAnalysis, modelContext, dailySummary } from './analytics.js';
import { simulate, SCENARIOS } from './simulation.js';
import {
  AGENTS, COPILOT_SYSTEM, copilotSchema, SIMULATION_SYSTEM, simulationSchema, deterministicHeadline,
} from './agents.js';
import { fmt } from '../../utils/dates.js';

// Which agents each role may run. Keeps AI output aligned with existing permissions.
const ROLE_AGENTS = {
  admin: Object.keys(AGENTS),
  project_manager: Object.keys(AGENTS),
  site_manager: Object.keys(AGENTS),
  planning_engineer: ['progress', 'planning', 'scheduling', 'completion', 'delay', 'equipment', 'ground', 'risk', 'reporting'],
  estimation_engineer: ['progress', 'material', 'inventory', 'labour', 'equipment', 'reporting'],
  site_engineer: ['progress', 'delay', 'labour', 'material', 'inventory', 'ground', 'camera'],
};

export function agentsForRole(role) {
  return (ROLE_AGENTS[role] || ['progress']).map((key) => ({ key, ...AGENTS[key] }))
    .map(({ key, title, description }) => ({ key, title, description }));
}

export function canRunAgent(role, agentKey) {
  return (ROLE_AGENTS[role] || []).includes(agentKey);
}

// Short-lived cache so a dashboard load does not recompute (or re-narrate) for every widget.
const cache = new Map();
function cached(projectId, ttlMinutes) {
  const hit = cache.get(String(projectId));
  if (hit && Date.now() - hit.at < ttlMinutes * 60_000) return hit.analysis;
  return null;
}

export async function analysisFor(projectId, { refresh = false } = {}) {
  if (!refresh) {
    const hit = cached(projectId, 2); // the deterministic pass is cheap; a short TTL avoids thrashing
    if (hit) return hit;
  }
  const analysis = await buildAnalysis(projectId);
  cache.set(String(projectId), { at: Date.now(), analysis });
  await syncAlerts(projectId, analysis.parts);
  return analysis;
}

/**
 * Run one agent: deterministic figures first, then narration, then persistence.
 */
export async function runAgent({ projectId, agentKey, user, trigger = 'manual', analysis }) {
  const agent = AGENTS[agentKey];
  if (!agent) {
    const err = new Error(`Unknown agent "${agentKey}". Available: ${AI_AGENTS.join(', ')}`);
    err.status = 400;
    throw err;
  }
  const { snap, parts } = analysis || await analysisFor(projectId, { refresh: true });
  const context = modelContext(snap, parts, { include: agent.include });
  const headline = deterministicHeadline(agentKey, parts);

  let output = { headline, aiGenerated: false };
  let status = 'Degraded';
  let model = null;
  let usage = {};
  let latencyMs = 0;
  let errorMessage = aiConfig().configured ? null : 'GEMINI_API_KEY not configured: deterministic figures only.';

  if (aiConfig().configured) {
    try {
      const res = await askGemini({ system: agent.system, payload: context, schema: agent.schema });
      output = { headline, aiGenerated: true, ...res.data };
      status = 'Success';
      model = res.model;
      usage = res.usage;
      latencyMs = res.latencyMs;
    } catch (error) {
      errorMessage = error.message;
    }
  }

  const run = await AiRun.create({
    project: projectId, agent: agentKey, trigger, user: user?._id,
    context, output, model, usage, latencyMs, status, errorMessage,
  });

  // Predictions carry the deterministic values; the narration is attached for explanation only.
  const predictions = [];
  for (const p of agent.predictions(parts)) {
    predictions.push(await AiPrediction.create({
      ...p, project: projectId, agent: agentKey, run: run._id, narration: output.summary || headline,
    }));
  }

  return { agent: agentKey, title: agent.title, run, output, parts, predictions };
}

/**
 * Run several agents for a project. Used by the Analyse button and the scheduled jobs.
 */
export async function analyzeProject({ projectId, user, agentKeys, trigger = 'manual' }) {
  const analysis = await analysisFor(projectId, { refresh: true });
  const keys = (agentKeys?.length ? agentKeys : ['planning', 'scheduling', 'completion', 'delay', 'labour', 'inventory', 'equipment', 'ground'])
    .filter((k) => AGENTS[k]);
  const results = [];
  for (const key of keys) {
    // Sequential on purpose: keeps us inside the per-user rate limit and the provider's quota.
    results.push(await runAgent({ projectId, agentKey: key, user, trigger, analysis }));
  }
  return { analysis, results };
}

/**
 * Deterministic figures plus the most recent narration per agent. Cheap: no model call.
 */
export async function projectInsights(projectId, { role } = {}) {
  const { snap, parts } = await analysisFor(projectId);
  const allowed = (ROLE_AGENTS[role] || Object.keys(AGENTS));
  const runs = await AiRun.find({ project: projectId, agent: { $in: allowed } }).sort({ createdAt: -1 }).limit(60).lean();
  const latest = {};
  for (const r of runs) if (!latest[r.agent]) latest[r.agent] = r;

  const [predictions, alerts] = await Promise.all([
    AiPrediction.find({ project: projectId }).sort({ createdAt: -1 }).limit(40).populate('decidedBy', 'name role').lean(),
    AiAlert.find({ project: projectId, status: 'Open' }).sort({ createdAt: -1 }).lean(),
  ]);
  const seen = new Set();
  const latestPredictions = predictions.filter((p) => {
    const key = `${p.agent}:${p.kind}:${p.activity || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    asOf: snap.asOf,
    project: snap.project,
    ai: { ...aiConfig(), configured: aiConfig().configured }, // never includes the key itself
    progress: snap.progress,
    analysis: {
      confidence: parts.confidence,
      completion: parts.completion,
      delay: parts.delay,
      labour: parts.labour,
      material: parts.material,
      inventory: parts.inventory,
      equipment: parts.equipment,
      ground: parts.ground,
      planning: parts.planning,
      scheduling: parts.scheduling,
      health: parts.health,
    },
    agents: allowed.map((key) => ({
      key,
      title: AGENTS[key].title,
      description: AGENTS[key].description,
      headline: deterministicHeadline(key, parts),
      narration: latest[key]?.output || null,
      ranAt: latest[key]?.createdAt || null,
      status: latest[key]?.status || null,
    })),
    predictions: latestPredictions,
    alerts,
  };
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

// Upsert by key so a persistent condition updates one alert instead of creating a new one hourly,
// and resolve alerts whose condition has cleared.
export async function syncAlerts(projectId, parts) {
  const candidates = parts.alerts || [];
  const open = await AiAlert.find({ project: projectId, status: { $ne: 'Resolved' } });
  const byKey = new Map(open.map((a) => [a.key, a]));

  for (const c of candidates) {
    const existing = byKey.get(c.key);
    if (existing) {
      existing.level = c.level;
      existing.title = c.title;
      existing.message = c.message;
      existing.basis = c.basis;
      await existing.save();
    } else {
      await AiAlert.create({ project: projectId, agent: 'analytics', ...c });
    }
  }
  const liveKeys = new Set(candidates.map((c) => c.key));
  for (const a of open) {
    if (liveKeys.has(a.key)) continue;
    a.status = 'Resolved';
    a.resolvedAt = new Date();
    await a.save();
  }
  return candidates.length;
}

// ---------------------------------------------------------------------------
// Copilot
// ---------------------------------------------------------------------------

const INTENTS = [
  { agent: 'simulation', patterns: [/what (if|happens if)/i, /\bif (i|we) (add|remove|increase|reduce)/i, /\bsimulate\b/i] },
  { agent: 'completion', patterns: [/when will/i, /completion/i, /finish (date|by)/i, /hand ?over/i] },
  { agent: 'delay', patterns: [/delay/i, /behind/i, /late/i, /why.*(slow|slip)/i, /critical path/i, /holding up/i] },
  { agent: 'planning', patterns: [/critical path|phase|milestone|baseline|dependenc|plan the/i] },
  { agent: 'scheduling', patterns: [/reschedule|recover|conflict|working hours/i] },
  { agent: 'labour', patterns: [/labour|labor|worker|manpower|mason|crew|attendance/i] },
  { agent: 'inventory', patterns: [/inventory|stock|reorder|warehouse|store/i] },
  { agent: 'material', patterns: [/material|cement|steel|sand|aggregate|brick|block|tile|paint|run out|procure/i] },
  { agent: 'camera', patterns: [/camera|cctv|photo|drone|helmet|vision/i] },
  { agent: 'equipment', patterns: [/jcb|excavator|crane|machine|equipment|mixer|pump|roller|truck/i] },
  { agent: 'ground', patterns: [/rock|soil|strata|boulder|water table|excavat/i] },
  { agent: 'progress', patterns: [/progress|status|how (is|are)|today|complete/i] },
  { agent: 'risk', patterns: [/risk|safety|exposure|worst/i] },
];

export function detectIntent(question) {
  for (const { agent, patterns } of INTENTS) {
    if (patterns.some((p) => p.test(question))) return agent;
  }
  return 'risk'; // broadest context
}

const scenarioSchema = {
  type: Type.OBJECT,
  properties: {
    type: { type: Type.STRING, enum: Object.keys(SCENARIOS) },
    workers: { type: Type.NUMBER },
    count: { type: Type.NUMBER },
    days: { type: Type.NUMBER },
    hours: { type: Type.NUMBER },
    activityCode: { type: Type.STRING, description: 'Activity code or name, only if the question names one.' },
  },
  required: ['type'],
};

// The model is used only to map the sentence onto a scenario and its numbers; the simulation
// arithmetic stays in simulation.js.
async function extractScenario(question, snap) {
  const { data } = await askGemini({
    system: `Map the user's what-if question onto one simulation scenario and its numeric parameters.
Use only numbers stated in the question. Pick activityCode only if the question clearly names an activity from the list.
Scenarios: ${Object.entries(SCENARIOS).map(([k, v]) => `${k} (${v.label})`).join(', ')}.`,
    payload: {
      question,
      activities: snap.activities.filter((a) => a.actualProgress < 100).map((a) => ({ code: a.code, name: a.name })),
    },
    schema: scenarioSchema,
  });
  return data;
}

async function resolveProject(projectId, question) {
  if (projectId) return projectId;
  const projects = await Project.find({}, 'code name').lean();
  const named = projects.find((p) => new RegExp(`\\b${p.code}\\b`, 'i').test(question) || new RegExp(p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(question));
  if (named) return named._id;
  if (projects.length === 1) return projects[0]._id;
  return null;
}

/**
 * Answer a management question. Routes to one agent, gives it only that agent's context, and
 * records the exchange with the records it cited.
 */
export async function askCopilot({ question, projectId, user, conversationId }) {
  const resolved = await resolveProject(projectId, question);
  if (!resolved) {
    const projects = await Project.find({}, 'code name').lean();
    return {
      answer: `Which project do you mean? Available: ${projects.map((p) => `${p.name} (${p.code})`).join(', ')}.`,
      sources: [], agent: 'copilot', needsProject: true, aiGenerated: false,
    };
  }
  const intent = detectIntent(question);
  const analysis = await analysisFor(resolved);
  const { snap, parts } = analysis;
  const fallbackKey = intent === 'simulation' ? 'completion' : intent;

  // A missing key, an exhausted quota or a provider outage must still produce the figures.
  const degrade = (reason) => ({
    answer: `${reason} Calculated figures: ${deterministicHeadline(fallbackKey, parts) || 'no analysis available for this project.'}`,
    sources: [], agent: fallbackKey, aiGenerated: false, degraded: true,
  });

  if (!aiConfig().configured) {
    return {
      ...degrade('Gemini is not configured on the server, so a written answer is unavailable.'),
      project: { id: String(resolved), name: snap.project.name, code: snap.project.code },
    };
  }

  let result;
  let status = 'Success';
  let errorMessage = null;

  try {
    if (intent === 'simulation') {
      const scenario = await extractScenario(question, snap);
      const sim = await simulate(resolved, scenario);
      const res = await askGemini({
        system: SIMULATION_SYSTEM,
        payload: { question, simulation: sim, project: snap.project, confidence: parts.confidence },
        schema: simulationSchema,
      });
      result = {
        answer: res.data.summary,
        findings: res.data.findings,
        recommendations: res.data.recommendations,
        sources: [sim.summaryLine],
        simulation: sim,
        model: res.model, usage: res.usage, latencyMs: res.latencyMs,
      };
    } else {
      const agent = AGENTS[intent];
      const context = { question, ...modelContext(snap, parts, { include: agent.include }) };
      const res = await askGemini({ system: COPILOT_SYSTEM, payload: context, schema: copilotSchema });
      result = { ...res.data, model: res.model, usage: res.usage, latencyMs: res.latencyMs };
    }
  } catch (error) {
    status = 'Degraded';
    errorMessage = error.message;
    result = degrade('The AI service is unavailable right now, so a written answer could not be generated.');
  }

  const run = await AiRun.create({
    project: resolved, agent: intent === 'simulation' ? 'copilot' : intent, trigger: 'copilot',
    user: user?._id, question, context: { intent }, output: result,
    model: result.model, usage: result.usage, latencyMs: result.latencyMs, status, errorMessage,
  });

  const conversation = conversationId
    ? await AiConversation.findOne({ _id: conversationId, user: user._id })
    : null;
  const thread = conversation || new AiConversation({
    user: user._id, project: resolved, title: question.slice(0, 80),
  });
  thread.messages.push({ role: 'user', text: question });
  thread.messages.push({
    role: 'assistant', text: result.answer, agent: intent, sources: result.sources || [], run: run._id,
  });
  await thread.save();

  return {
    ...result, agent: intent, aiGenerated: status === 'Success', conversationId: String(thread._id),
    project: { id: String(resolved), name: snap.project.name, code: snap.project.code },
  };
}

// ---------------------------------------------------------------------------
// Scheduled and event-driven processing (§35, §36)
// ---------------------------------------------------------------------------

let lastDailyRun = null;

// Hourly: recompute deterministic analytics and refresh the alert centre for every project.
// No model calls, so this is free to run often.
export async function hourlyAlertSweep() {
  const projects = await Project.find({}, '_id').lean();
  for (const p of projects) {
    try {
      await analysisFor(p._id, { refresh: true });
    } catch (error) {
      console.error(`AI alert sweep failed for project ${p._id}:`, error.message);
    }
  }
}

// Daily: full agent pass with narration, once per calendar day after the configured hour.
export async function dailyAgentPass({ hour = 18 } = {}) {
  const now = new Date();
  const stamp = now.toDateString();
  if (lastDailyRun === stamp || now.getHours() < hour) return;
  lastDailyRun = stamp;
  if (!aiConfig().configured) return;
  const projects = await Project.find({ status: { $in: ['Active', 'Planning'] } }, '_id').lean();
  for (const p of projects) {
    try {
      await analyzeProject({ projectId: p._id, trigger: 'scheduled' });
    } catch (error) {
      console.error(`Daily AI pass failed for project ${p._id}:`, error.message);
    }
  }
}

// Event-driven: called after a progress update or blocker change. Deterministic refresh always;
// narration only when the delay picture is materially bad, to keep token usage down.
export async function onProjectEvent(projectId, { reason } = {}) {
  try {
    const { parts } = await analysisFor(projectId, { refresh: true });
    const severe = parts.delay.level === 'High' || parts.delay.level === 'Critical';
    if (severe && aiConfig().configured) {
      await runAgent({ projectId, agentKey: 'delay', trigger: 'event' });
    }
    return { reason, delayRisk: parts.delay.level, alerts: parts.alerts.length };
  } catch (error) {
    console.error(`AI event processing failed for project ${projectId}:`, error.message);
    return null;
  }
}

export { dailySummary, simulate, SCENARIOS, fmt };
