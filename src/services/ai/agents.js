// Agent definitions.
//
// An agent is a small declarative unit: which deterministic findings it reads, what it asks the
// model to explain, and which predictions it writes back. Adding an agent means adding an entry
// here - the orchestrator needs no change.

import { Type } from '@google/genai';
import { fmt } from '../../utils/dates.js';

const GUARDRAILS = `
You are an analyst inside a construction project management system used on Indian residential and
commercial sites. You receive a JSON object of figures that have ALREADY been calculated from the
project database by a deterministic rules engine.

Absolute rules:
- Use ONLY the numbers, dates and names present in the JSON. Never calculate, adjust or invent a
  number, quantity, cost, date, labour count or percentage that is not in the JSON.
- If a section contains "insufficientData": true, say plainly what data is missing and what the
  team must record to get the answer. Do not estimate it anyway.
- Never claim camera, drone, computer-vision or 3D-model findings: that data is not in the payload.
- Refer to activities by their name and code as given.
- Write for a site manager: short, concrete sentences, no marketing language, no emoji.
- Quantities keep their units exactly as supplied.
`.trim();

const narrationSchema = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING, description: 'Two or three sentences stating the situation and its cause.' },
    findings: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          detail: { type: Type.STRING },
          evidence: { type: Type.STRING, description: 'The figure or record from the JSON that supports this.' },
        },
        required: ['title', 'detail', 'evidence'],
      },
    },
    recommendations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          action: { type: Type.STRING },
          rationale: { type: Type.STRING },
          owner: { type: Type.STRING, description: 'Role or person named in the JSON who should act.' },
        },
        required: ['action', 'rationale'],
      },
    },
    dataGaps: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Data the team must record for a better answer.' },
  },
  required: ['summary', 'findings', 'recommendations'],
};

export const copilotSchema = {
  type: Type.OBJECT,
  properties: {
    answer: { type: Type.STRING },
    sources: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Activity codes, blocker types or record names from the JSON that back the answer.' },
    followUps: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ['answer', 'sources'],
};

export const COPILOT_SYSTEM = `${GUARDRAILS}

You are answering a question from project management. Answer the question directly in the first
sentence, then give the supporting figures. If the JSON does not contain what is needed, say
"Insufficient project data to answer this" and list exactly what is missing.`;

// Each agent names the analysis sections it is allowed to see, keeping the payload small.
export const AGENTS = {
  progress: {
    title: 'Progress Agent',
    description: 'Planned vs actual progress across the project and where it stands by location.',
    include: ['confidence', 'health', 'planning'],
    system: `${GUARDRAILS}\n\nExplain the current progress position: what is complete, what is behind, and where. Lead with the weighted project percentages.`,
    schema: narrationSchema,
    predictions: () => [],
  },

  planning: {
    title: 'Planning Agent',
    description: 'Scope, phases, dependencies and the remaining critical path.',
    include: ['planning', 'completion', 'confidence'],
    system: `${GUARDRAILS}\n\nExplain the execution plan: phases still open, the critical path, and which milestones drive completion. Do not invent activities that are not listed.`,
    schema: narrationSchema,
    predictions: (parts) => [{
      kind: 'criticalPath',
      label: 'Remaining critical path',
      value: { remainingDays: parts.planning.criticalPath.remainingDays, activities: parts.planning.criticalPath.activities.map((a) => a.code) },
      unit: 'days',
      confidence: parts.confidence.confidence,
      basis: parts.planning.basis,
    }],
  },

  scheduling: {
    title: 'Scheduling Agent',
    description: 'Overlaps, delayed activities and recovery options from the live forecast.',
    include: ['scheduling', 'completion', 'labour', 'equipment', 'confidence'],
    system: `${GUARDRAILS}\n\nExplain schedule conflicts and what would recover the delay. Only recommend the recovery options listed, with the numbers given.`,
    schema: narrationSchema,
    predictions: (parts) => [{
      kind: 'scheduleConflicts',
      label: 'Open schedule conflicts',
      value: { conflicts: parts.scheduling.conflicts.length, delayed: parts.scheduling.delayed.length },
      unit: 'count',
      confidence: parts.confidence.confidence,
      basis: parts.scheduling.basis,
    }],
  },

  completion: {
    title: 'Completion Prediction Agent',
    description: 'Best, expected and worst-case completion dates with a data-coverage confidence.',
    include: ['completion', 'confidence'],
    system: `${GUARDRAILS}\n\nExplain the completion forecast. State the expected date first, then the best and worst case and what separates them. Mention the confidence figure and what limits it.`,
    schema: narrationSchema,
    predictions: (parts) => {
      if (parts.completion.complete) return [];
      return [{
        kind: 'completionDate',
        label: 'AI predicted completion',
        value: {
          expected: parts.completion.expected,
          best: parts.completion.best,
          worst: parts.completion.worst,
          plannedCompletion: parts.completion.plannedCompletion,
          delayDays: parts.completion.delayDays,
        },
        unit: 'date',
        confidence: parts.confidence.confidence,
        basis: [...parts.completion.basis, ...parts.confidence.basis],
      }];
    },
  },

  delay: {
    title: 'Delay Intelligence Agent',
    description: 'Delay risk level, the activities causing it and the downstream effect.',
    include: ['delay', 'completion', 'confidence'],
    system: `${GUARDRAILS}\n\nExplain why the project is behind. Separate causes (blockers, productivity, manpower) from effects (activities waiting on a predecessor). Name the single biggest contributor first.`,
    schema: narrationSchema,
    predictions: (parts) => [{
      kind: 'delayRisk',
      label: 'Delay risk level',
      value: { level: parts.delay.level, maxSlipDays: parts.delay.maxSlipDays, activitiesBehind: parts.delay.activitiesBehind },
      unit: 'level',
      confidence: parts.confidence.confidence,
      basis: parts.delay.basis,
    }],
  },

  labour: {
    title: 'Labour Agent',
    description: 'Required versus deployed labour by trade for the lookahead window.',
    include: ['labour', 'confidence'],
    system: `${GUARDRAILS}\n\nExplain the labour position by trade. If there is a shortfall, say how many workers of which trade are needed and before which activity.`,
    schema: narrationSchema,
    predictions: (parts) => (parts.labour.insufficientData ? [] : [{
      kind: 'labourShortfall',
      label: 'Labour shortfall for the lookahead window',
      value: {
        shortfallToday: parts.labour.shortfall,
        shortfallPeak: parts.labour.shortfallPeak,
        requiredToday: parts.labour.requiredToday,
        requiredPeak: parts.labour.requiredPeak,
        peakDate: parts.labour.peakDate,
        present: parts.labour.totalPresent,
        trades: parts.labour.trades,
      },
      unit: 'workers',
      confidence: parts.confidence.confidence,
      basis: parts.labour.basis,
    }]),
  },

  material: {
    title: 'Material Agent',
    description: 'Material requirement from estimates against consumption reported on site.',
    include: ['material', 'inventory', 'confidence'],
    system: `${GUARDRAILS}\n\nExplain the material position. If stockTracked is false, say that stock cannot be calculated yet. If stock figures are present, use only those numbers.`,
    schema: narrationSchema,
    predictions: () => [],
  },

  inventory: {
    title: 'Inventory Agent',
    description: 'Recorded stock, days of cover, reorder risk and recommended purchase quantities.',
    include: ['inventory', 'material', 'confidence'],
    system: `${GUARDRAILS}\n\nExplain stock risk. If insufficientData is true, say so. Never invent a stock figure.`,
    schema: narrationSchema,
    predictions: (parts) => (parts.inventory.insufficientData ? [] : [{
      kind: 'stockRisk',
      label: 'Inventory stock risk',
      value: { critical: parts.inventory.critical, low: parts.inventory.low, items: parts.inventory.items.filter((i) => i.stockRisk === 'Critical' || i.stockRisk === 'Low') },
      unit: 'items',
      confidence: parts.confidence.confidence,
      basis: parts.inventory.basis,
    }]),
  },

  camera: {
    title: 'Camera Agent',
    description: 'Computer-vision estimates from uploaded site photographs, pending human verification.',
    include: ['confidence'],
    system: `${GUARDRAILS}\n\nThe payload may include camera observations. Treat every detection as an AI estimate. If no observations exist, say so. Never claim a live CCTV feed.`,
    schema: narrationSchema,
    predictions: () => [],
  },

  reporting: {
    title: 'Reporting Agent',
    description: 'Professional daily / weekly / health reports compiled from project records.',
    include: ['completion', 'delay', 'labour', 'material', 'equipment', 'health', 'confidence'],
    system: `${GUARDRAILS}\n\nWrite a concise management report from the figures. Do not add a section that has no data.`,
    schema: narrationSchema,
    predictions: () => [],
  },

  equipment: {
    title: 'Equipment Agent',
    description: 'Machinery required against deployed, with utilisation from reported hours.',
    include: ['equipment', 'confidence'],
    system: `${GUARDRAILS}\n\nExplain the equipment position: which machines are short, which are under-utilised, and what that means for the activities in the window.`,
    schema: narrationSchema,
    predictions: (parts) => (parts.equipment.insufficientData ? [] : [{
      kind: 'equipmentUtilisation',
      label: 'Equipment utilisation and shortfall',
      value: { items: parts.equipment.items },
      unit: 'machines',
      confidence: parts.confidence.confidence,
      basis: parts.equipment.basis,
    }]),
  },

  ground: {
    title: 'Ground Condition Agent',
    description: 'Rock, soil and excavation conditions reported from site and their schedule effect.',
    include: ['ground', 'confidence'],
    system: `${GUARDRAILS}\n\nExplain the ground conditions reported from site and their calculated effect on duration, machinery and labour. If no ground condition is reported, say so in one line.`,
    schema: narrationSchema,
    predictions: (parts) => parts.ground.reports.filter((r) => !r.insufficientData).map((r) => ({
      kind: 'groundConditionImpact',
      label: `Ground condition impact on ${r.activity.name}`,
      value: {
        additionalDays: r.additionalDays,
        additionalMachines: r.additionalBreakerOrMachines,
        additionalLabour: r.additionalLabour,
        normalDurationDays: r.normalDurationDays,
        affectedDurationDays: r.affectedDurationDays,
      },
      unit: 'days',
      confidence: parts.confidence.confidence,
      basis: r.basis,
    })),
  },

  risk: {
    title: 'Risk Agent',
    description: 'Open risks with probability, impact and the recommended action.',
    include: ['delay', 'completion', 'labour', 'equipment', 'ground', 'health', 'confidence'],
    system: `${GUARDRAILS}\n\nFor each open risk in the payload give the impact in days, the affected activities and one concrete action. Do not invent risks that the payload does not support.`,
    schema: narrationSchema,
    predictions: () => [],
  },
};

export const simulationSchema = narrationSchema;

export const SIMULATION_SYSTEM = `${GUARDRAILS}

You are explaining a what-if simulation whose arithmetic is already done. State the revised
completion date and the days gained or lost, then the assumptions that produced it, then whether
the move is worth the cost shown. Never re-calculate the dates.`;

// Short deterministic headline so the UI has something useful even when the model is unavailable.
export function deterministicHeadline(agentKey, parts) {
  switch (agentKey) {
    case 'planning': {
      const p = parts.planning;
      const chain = p.criticalPath.activities.map((a) => a.code).join(' → ') || 'none';
      return `Critical path remaining ${p.criticalPath.remainingDays} day(s): ${chain}. ${p.phases.length} phase group(s) in the plan.`;
    }
    case 'scheduling':
      return `${parts.scheduling.delayed.length} delayed activit${parts.scheduling.delayed.length === 1 ? 'y' : 'ies'}, ${parts.scheduling.conflicts.length} assignment conflict(s).`;
    case 'inventory':
      return parts.inventory.insufficientData
        ? parts.inventory.reason
        : `${parts.inventory.critical} critical and ${parts.inventory.low} low-stock item(s) of ${parts.inventory.items.length} tracked.`;
    case 'camera':
      return 'Camera findings are AI estimates from uploaded photographs and need human verification.';
    case 'reporting':
      return `Project health ${parts.health.overall}/100; delay risk ${parts.delay.level}.`;
    case 'completion': {
      const c = parts.completion;
      if (c.complete) return 'All activities are complete.';
      return `Expected completion ${fmt(c.expected)} against a planned ${fmt(c.plannedCompletion)} (${c.delayDays >= 0 ? '+' : ''}${c.delayDays} days). Best case ${fmt(c.best)}, worst case ${fmt(c.worst)}.`;
    }
    case 'delay':
      return `Delay risk ${parts.delay.level}: largest slip ${parts.delay.maxSlipDays} day(s), ${parts.delay.activitiesBehind} activity(ies) behind plan, ${parts.delay.activitiesBlocked} blocked.`;
    case 'labour':
      return parts.labour.insufficientData
        ? parts.labour.reason
        : `${parts.labour.totalPresent} workers deployed against ${parts.labour.requiredToday} needed today; peak requirement ${parts.labour.requiredPeak} on ${fmt(parts.labour.peakDate)} (shortfall ${parts.labour.shortfallPeak}).`;
    case 'material':
      return parts.material.insufficientData ? parts.material.reason : parts.material.stockNote;
    case 'equipment':
      return parts.equipment.insufficientData
        ? parts.equipment.reason
        : parts.equipment.items.map((i) => `${i.name}: ${i.deployed}/${i.required} deployed`).join('; ');
    case 'ground':
      return parts.ground.detected
        ? `${parts.ground.reports.length} ground condition report(s) affecting the schedule.`
        : 'No ground condition reported.';
    case 'risk':
      return `Project health ${parts.health.overall}/100; delay risk ${parts.delay.level}.`;
    default:
      return null;
  }
}
