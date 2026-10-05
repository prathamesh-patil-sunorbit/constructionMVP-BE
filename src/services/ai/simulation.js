// What-if simulation engine.
//
// Every scenario is a deterministic re-run of the schedule forecast with one input changed, so
// "days saved" and "revised completion" are calculated, not estimated by a language model.
// Cost figures only appear when a rate for them exists in the rules; otherwise they are reported
// as not calculable.

import { buildProjectSnapshot, completionForecast, scenarioForecast, labourAnalysis } from './analytics.js';
import { diffDays, fmt, toDay } from '../../utils/dates.js';

export const SCENARIOS = {
  add_labour: { label: 'Add labour', params: { workers: 'number', activityCode: 'string?' } },
  remove_labour: { label: 'Labour absent', params: { workers: 'number', days: 'number?' } },
  add_equipment: { label: 'Add equipment', params: { count: 'number', machine: 'string?' } },
  material_late: { label: 'Material arrives late', params: { days: 'number', activityCode: 'string?' } },
  weather_stop: { label: 'Rain stops work', params: { days: 'number' } },
  rock_found: { label: 'Rock found during excavation', params: { activityCode: 'string' } },
  increase_hours: { label: 'Increase working hours', params: { hours: 'number' } },
};

const clampFactor = (n, lo = 0.2, hi = 2.5) => Math.max(lo, Math.min(hi, n));

/**
 * Run one scenario against live project data.
 * @returns {Promise<object>} deterministic result, ready for narration.
 */
export async function simulate(projectId, scenario) {
  const snap = await buildProjectSnapshot(projectId);
  const baseline = completionForecast(snap);
  const rules = snap.rules;
  const { type } = scenario;
  if (!SCENARIOS[type]) {
    const err = new Error(`Unknown scenario "${type}". Supported: ${Object.keys(SCENARIOS).join(', ')}`);
    err.status = 400;
    throw err;
  }
  if (baseline.complete) {
    return { type, insufficientData: true, reason: 'All activities are complete, so there is nothing left to simulate.' };
  }

  const open = snap.activities.filter((a) => a.actualProgress < 100);
  const target = scenario.activityCode
    ? open.find((a) => a.code === scenario.activityCode || a.name === scenario.activityCode)
    : null;
  if (scenario.activityCode && !target) {
    const err = new Error(`Activity "${scenario.activityCode}" not found among open activities`);
    err.status = 400;
    throw err;
  }
  const scope = target ? [target] : open.filter((a) => a.activeInWindow) ;
  const scopeIds = new Set((scope.length ? scope : open).map((a) => a.id));

  const labour = labourAnalysis(snap);
  const assumptions = [];
  let adjust = () => ({});
  let costImpact = null;
  let startFloorShiftDays = 0;

  switch (type) {
    case 'add_labour': {
      const workers = Number(scenario.workers) || 0;
      if (workers <= 0) throw badRequest('workers must be greater than 0');
      const crew = labour.insufficientData ? null : labour.requiredToday;
      if (!crew) {
        return {
          type, insufficientData: true,
          reason: 'The current crew size is unknown (no labour lines on the estimates, or no recent execution report), so the productivity effect of extra workers cannot be calculated.',
        };
      }
      // Productivity is assumed to scale with crew size, capped: doubling a crew rarely doubles output.
      const raw = 1 + workers / crew;
      const factor = clampFactor(Math.min(raw, rules.ai.simulation.maxLabourSpeedup));
      assumptions.push(`Current crew requirement across the window is ${crew} workers; adding ${workers} scales productivity by ×${factor.toFixed(2)} (capped at ×${rules.ai.simulation.maxLabourSpeedup}).`);
      adjust = (id) => (scopeIds.has(id) ? { rateMultiplier: factor } : {});
      costImpact = cost(workers * rules.ai.simulation.labourDayRate, `${workers} workers × ₹${rules.ai.simulation.labourDayRate}/day`, 'per day');
      break;
    }
    case 'remove_labour': {
      const workers = Number(scenario.workers) || 0;
      if (workers <= 0) throw badRequest('workers must be greater than 0');
      const crew = labour.insufficientData ? null : labour.totalPresent || labour.requiredToday;
      if (!crew) {
        return { type, insufficientData: true, reason: 'Deployed labour is unknown, so the effect of absence cannot be calculated.' };
      }
      const factor = clampFactor(Math.max(0.1, 1 - workers / crew));
      assumptions.push(`${workers} of ${crew} workers absent scales productivity by ×${factor.toFixed(2)}.`);
      if (scenario.days) assumptions.push(`Absence assumed for ${scenario.days} day(s); the forecast applies the reduced rate to remaining work.`);
      adjust = (id) => (scopeIds.has(id) ? { rateMultiplier: factor } : {});
      break;
    }
    case 'add_equipment': {
      const count = Number(scenario.count) || 0;
      if (count <= 0) throw badRequest('count must be greater than 0');
      const factor = clampFactor(1 + count * rules.ai.simulation.equipmentSpeedupPerMachine);
      assumptions.push(`Each additional machine adds ${Math.round(rules.ai.simulation.equipmentSpeedupPerMachine * 100)}% capacity (configurable), so ${count} machine(s) scale productivity by ×${factor.toFixed(2)}.`);
      adjust = (id) => (scopeIds.has(id) ? { rateMultiplier: factor } : {});
      costImpact = cost(count * rules.ai.simulation.equipmentDayRate, `${count} machine(s) × ₹${rules.ai.simulation.equipmentDayRate}/day`, 'per day');
      break;
    }
    case 'material_late': {
      const days = Number(scenario.days) || 0;
      if (days <= 0) throw badRequest('days must be greater than 0');
      if (target) {
        assumptions.push(`${days} day(s) of material delay on ${target.name}; the knock-on effect follows the dependency chain.`);
        adjust = (id) => (id === target.id ? { extraDays: days } : {});
      } else {
        // Without a named activity this is a site-wide delivery delay: one shift, not a repeated
        // penalty on every activity in the chain.
        assumptions.push(`A site-wide material delay of ${days} day(s): nothing can start earlier than ${fmt(new Date(Date.now() + days * 86400000))}. Name an activity to model a delay on one delivery only.`);
        startFloorShiftDays = days;
      }
      break;
    }
    case 'weather_stop': {
      const days = Number(scenario.days) || 0;
      if (days <= 0) throw badRequest('days must be greater than 0');
      // A site-wide stoppage shifts the whole programme once; it is not an extra delay on each
      // activity in the chain.
      assumptions.push(`The whole site stops for ${days} day(s), so no work can start before ${fmt(new Date(Date.now() + days * 86400000))}.`);
      startFloorShiftDays = days;
      break;
    }
    case 'rock_found': {
      if (!target) throw badRequest('activityCode is required for the rock_found scenario');
      const factor = rules.ai.ground.hardStrataProductivityFactor;
      assumptions.push(`Hard strata reduces productivity on ${target.name} to ×${factor} of planned (Admin → Business rules).`);
      adjust = (id) => (id === target.id ? { rateMultiplier: factor } : {});
      break;
    }
    case 'increase_hours': {
      const hours = Number(scenario.hours) || 0;
      const base = rules.ai.equipment.workingHoursPerDay;
      if (hours <= 0) throw badRequest('hours must be greater than 0');
      const factor = clampFactor((base + hours) / base * rules.ai.simulation.overtimeEfficiency);
      assumptions.push(`Working day moves from ${base}h to ${base + hours}h at ${Math.round(rules.ai.simulation.overtimeEfficiency * 100)}% overtime efficiency, scaling productivity by ×${factor.toFixed(2)}.`);
      adjust = (id) => (scopeIds.has(id) ? { rateMultiplier: factor } : {});
      costImpact = cost(
        hours * rules.ai.simulation.overtimeHourRate * (labour.totalPresent || labour.requiredToday || 0),
        `${hours}h × ₹${rules.ai.simulation.overtimeHourRate}/h × ${labour.totalPresent || labour.requiredToday || 0} workers`,
        'per day',
      );
      break;
    }
    default:
      break;
  }

  const result = scenarioForecast(snap._internal.activityDocs, snap._internal.deps, snap._internal.state, {
    rateMultiplier: 1, blockerBufferDays: 0, useObservedRate: true, adjust, startFloorShiftDays,
  });
  const revised = result?.finish ? toDay(result.finish) : null;
  const daysSaved = revised && baseline.expected ? diffDays(baseline.expected, revised) : 0;

  return {
    type,
    label: SCENARIOS[type].label,
    insufficientData: false,
    scope: target ? { code: target.code, name: target.name } : { activities: scopeIds.size, description: 'activities active in the lookahead window' },
    baselineCompletion: baseline.expected,
    revisedCompletion: revised,
    plannedCompletion: baseline.plannedCompletion,
    daysSaved,
    daysLost: daysSaved < 0 ? -daysSaved : 0,
    delayVsPlanAfter: revised && baseline.plannedCompletion ? diffDays(revised, baseline.plannedCompletion) : null,
    delayVsPlanBefore: baseline.delayDays,
    costImpact,
    assumptions: [
      ...assumptions,
      'Forecast re-run through the same Finish→Start dependency chain as the live schedule.',
    ],
    summaryLine: revised
      ? `${SCENARIOS[type].label}: completion moves from ${fmt(baseline.expected)} to ${fmt(revised)} (${daysSaved > 0 ? `${daysSaved} day(s) earlier` : daysSaved < 0 ? `${-daysSaved} day(s) later` : 'no change'}).`
      : 'No open activities to forecast.',
  };
}

function cost(amount, formula, period) {
  if (!amount || Number.isNaN(amount)) {
    return { calculable: false, note: 'No rate configured for this resource, so the cost impact cannot be calculated.' };
  }
  return { calculable: true, amount: Math.round(amount), currency: 'INR', period, formula };
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}
