// AI planning advisor for an uploaded MS Project schedule.
//
// Everything with a number in it — the pace forecast, the cost breakdown and each what-if
// scenario — is calculated by services/schedule-sim.js. Gemini reads those results and writes the
// advice: what is driving the finish, which option buys the most days for the money, and the risks.
// It is told never to produce a number of its own; if it is unavailable the figures stand alone.

import { Type } from '@google/genai';
import { AiRun } from '../models/index.js';
import { askGemini, aiConfig } from './ai/gemini.js';
import { PRESETS, costBreakdown, pacePrediction, simulate } from './schedule-sim.js';
import { toDay } from '../utils/dates.js';

// "09 Dec 2029": the schedule spans years, so the year is always written.
const fmt = (d) => (d ? toDay(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : null);

const SYSTEM = `You are a construction planning advisor for a residential high-rise project in India, talking to the site
and project managers. The JSON holds results ALREADY calculated from the project's MS Project schedule: the pace forecast
(SPI), the cost breakdown in rupees, the tasks that drive the finish, and what-if scenarios (more labour, overlapping
sequential work) with days saved and money. Use only those numbers; never calculate, change or invent a number, date or
amount. Write rupees as given (crore = Cr, lakh = L). Compare the scenarios on days saved against net cost, say which you
would choose and why, and what must be true on site for it to work (crews, materials, approvals). Mention risks honestly.
Short, concrete sentences. No emoji.`;

const schema = {
  type: Type.OBJECT,
  properties: {
    headline: { type: Type.STRING, description: 'One sentence: when the project will really finish and the single best lever.' },
    situation: { type: Type.STRING, description: 'Two or three sentences on pace, delay and what drives the finish date.' },
    recommendations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          action: { type: Type.STRING },
          scenarioKey: { type: Type.STRING, description: 'key of the scenario this is based on, if any' },
          rationale: { type: Type.STRING },
          prerequisites: { type: Type.STRING, description: 'what must be arranged on site first' },
        },
        required: ['action', 'rationale'],
      },
    },
    risks: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ['headline', 'situation', 'recommendations'],
};

const cr = (n) => (n == null ? null : `₹${(n / 1e7).toFixed(2)} Cr`);
const lakh = (n) => (n == null ? null : `₹${(n / 1e5).toFixed(1)} L`);

/** All the calculated inputs for the planner screen (no model call). */
export function planInputs(doc, rules) {
  const base = simulate(doc, {}, rules);
  const scenarios = PRESETS.map((p) => ({ ...p, result: simulate(doc, p.scenario, rules) }));
  return { pace: pacePrediction(doc), costs: costBreakdown(doc), base, scenarios };
}

export async function adviseOnSchedule(doc, rules, { user, projectName } = {}) {
  const inputs = planInputs(doc, rules);
  if (!aiConfig().configured) return { inputs, advice: null, error: 'GEMINI_API_KEY is not configured: the calculated figures are shown without AI advice.' };
  const s = doc.summary;
  const payload = {
    project: projectName || doc.title,
    statusDate: fmt(doc.statusDate),
    schedule: {
      percentComplete: s.percent, finish: fmt(s.finish), baselineFinish: fmt(s.baselineFinish), daysLateVsBaseline: s.delayDays,
      overdueTasks: s.overdue, tasksBehindPlan: s.behindPlan,
    },
    pace: { ...inputs.pace, scheduledFinish: fmt(inputs.pace.scheduledFinish), predictedFinish: fmt(inputs.pace.predictedFinish) },
    money: {
      currentCost: cr(s.cost), baselineCost: cr(s.baselineCost), spent: cr(s.actualCost), remaining: cr(s.remainingCost),
      byArea: inputs.costs.areas.map((a) => ({ area: a.name, cost: cr(a.cost), baseline: cr(a.baselineCost), spent: cr(a.actualCost) })),
    },
    drivesTheFinish: inputs.base.criticalPath.map((t) => `${t.name}${t.area ? ` (${t.area})` : ''}`),
    scenarios: inputs.scenarios.map((x) => ({
      key: x.key, label: x.label, newFinish: fmt(x.result.finish), calendarDaysSaved: x.result.calendarDaysSaved,
      extraLabourCost: lakh(x.result.cost.extraLabourCost), reworkAllowance: lakh(x.result.cost.reworkCost),
      overheadSaving: lakh(x.result.cost.overheadSaving), netCost: lakh(-x.result.cost.net), tasksSpedUp: x.result.tasksSpedUp,
    })),
    assumptions: inputs.scenarios.at(-1).result.assumptions,
  };
  const started = Date.now();
  try {
    const res = await askGemini({ system: SYSTEM, payload, schema, temperature: 0.3, retry: { attempts: 3, timeoutMs: 90_000, backoffMs: 2000 } });
    const advice = { ...res.data, aiGenerated: true, model: res.model, at: new Date() };
    await AiRun.create({
      project: doc.project, agent: 'scheduling', trigger: 'manual', user: user?._id,
      question: `Schedule advice: ${doc.file?.originalName}`, context: payload, output: advice,
      model: res.model, usage: res.usage, latencyMs: res.latencyMs ?? Date.now() - started, status: 'Success',
    });
    return { inputs, advice };
  } catch (error) {
    await AiRun.create({
      project: doc.project, agent: 'scheduling', trigger: 'manual', user: user?._id, question: `Schedule advice: ${doc.file?.originalName}`,
      context: payload, output: { aiGenerated: false }, latencyMs: Date.now() - started, status: 'Failed', errorMessage: error.message,
    }).catch(() => {});
    return { inputs, advice: null, error: `AI advice is not available right now (${error.providerStatus === 429 ? 'quota used up' : error.providerStatus === 503 ? 'service busy' : error.message}). The calculated figures below are complete.` };
  }
}
