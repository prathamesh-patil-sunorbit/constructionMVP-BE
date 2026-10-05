// Deterministic report bodies. Gemini only narrates; every figure comes from analytics.

import { AiReport, AiRun } from '../../models/index.js';
import { REPORT_KINDS } from '../../models/constants.js';
import { buildAnalysis, dailySummary } from './analytics.js';
import { AGENTS } from './agents.js';
import { askGemini, aiConfig } from './gemini.js';
import { fmt, addDays, today } from '../../utils/dates.js';

export async function generateReport({ projectId, kind, user, date }) {
  if (!REPORT_KINDS.includes(kind)) {
    const err = new Error(`Unknown report kind "${kind}". Available: ${REPORT_KINDS.join(', ')}`);
    err.status = 400;
    throw err;
  }
  const { snap, parts } = await buildAnalysis(projectId);
  const day = date || snap.asOf;
  const daily = await dailySummary(projectId, day);

  const data = {
    kind,
    asOf: snap.asOf,
    project: snap.project,
    progress: snap.progress,
    completion: parts.completion,
    delay: parts.delay,
    labour: parts.labour,
    material: parts.material,
    inventory: parts.inventory,
    equipment: parts.equipment,
    ground: parts.ground,
    health: parts.health,
    planning: parts.planning,
    daily: kind === 'daily' ? daily : null,
    period: kind === 'weekly'
      ? { start: addDays(today(), -6), end: today() }
      : kind === 'monthly'
        ? { start: addDays(today(), -29), end: today() }
        : { start: day, end: day },
  };

  let narration = { headline: `Health ${parts.health.overall}/100 · delay risk ${parts.delay.level}`, aiGenerated: false };
  let run = null;
  if (aiConfig().configured) {
    try {
      const res = await askGemini({
        system: AGENTS.reporting.system,
        payload: data,
        schema: AGENTS.reporting.schema,
      });
      narration = { headline: narration.headline, aiGenerated: true, ...res.data };
      run = await AiRun.create({
        project: projectId, agent: 'reporting', trigger: 'manual', user: user?._id,
        question: `${kind} report`, context: { kind }, output: narration,
        model: res.model, usage: res.usage, latencyMs: res.latencyMs, status: 'Success',
      });
    } catch (error) {
      run = await AiRun.create({
        project: projectId, agent: 'reporting', trigger: 'manual', user: user?._id,
        question: `${kind} report`, status: 'Degraded', errorMessage: error.message, output: narration,
      });
    }
  }

  const doc = await AiReport.create({
    project: projectId, kind, periodStart: data.period.start, periodEnd: data.period.end,
    data, narration, generatedBy: user?._id, run: run?._id,
  });
  return doc;
}

export { fmt };
