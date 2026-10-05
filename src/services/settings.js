import { Setting } from '../models/index.js';

// Initial thresholds. These are deliberately configurable (Admin > Rules) until validated
// against actual Krisala operations.
export const DEFAULT_RULES = {
  status: {
    atRiskProgressVariance: 10, // % behind plan => At Risk
    delayedProgressVariance: 20, // % behind plan => Delayed
    atRiskDelayDays: 1, // expected finish slips by N days => At Risk
    delayedDelayDays: 2, // expected finish slips by N days => Delayed
  },
  forecast: {
    // Floor on observed productivity when forecasting finish, as a fraction of planned rate.
    minProductivityFactor: 0.5,
  },
  execution: {
    // Latest daily report with actual/planned manpower below this ratio is flagged as a cause.
    manpowerShortfallRatio: 0.85,
  },
  risk: {
    // An At Risk activity (not Delayed/Blocked) raises a risk only if downstream impact >= N days.
    minImpactDaysForAtRisk: 2,
  },
  severity: {
    high: { delayDays: 3, progressVariance: 30, impactDays: 3 },
    medium: { delayDays: 1, progressVariance: 15, impactDays: 1 },
  },
  // Parameters for the AI analytics layer. Every AI number traces back to one of these.
  ai: {
    lookaheadDays: 7, // window used for labour/material/equipment requirements
    // If the planned activities end more than this many days before the project's completion
    // date, the plan does not yet cover full scope and the forecast says so.
    scheduleCoverageToleranceDays: 30,
    freshUpdateDays: 3, // an update older than this no longer counts as "reported"
    cacheMinutes: 30, // reuse a stored analysis instead of calling the model again
    scenarios: {
      bestRateMultiplier: 1, // best case: remaining work at planned productivity
      worstRateMultiplier: 0.75, // worst case: observed productivity drops further
      worstBlockerBufferDays: 3, // worst case: blockers clear this many days late
    },
    delayRisk: {
      mediumSlipDays: 2,
      highSlipDays: 5,
      criticalSlipDays: 10,
      mediumBehindCount: 3, // activities behind plan before risk becomes Medium
    },
    equipment: {
      workingHoursPerDay: 8, // denominator for utilisation
    },
    // What-if simulation parameters. Rates are placeholders until commercial rates are loaded.
    simulation: {
      maxLabourSpeedup: 1.6, // extra crew never scales output one-for-one
      equipmentSpeedupPerMachine: 0.35,
      overtimeEfficiency: 0.85, // overtime hours are less productive than day hours
      labourDayRate: 850, // INR per worker per day
      equipmentDayRate: 12000, // INR per machine per day
      overtimeHourRate: 140, // INR per worker per overtime hour
    },
    ground: {
      // Productivity multiplier when hard strata / rock is encountered.
      hardStrataProductivityFactor: 0.45,
      extraDaysRecoveredPerMachine: 5, // one extra breaker/machine recovers this many days
      labourPerAdditionalMachine: 3,
    },
    inventory: {
      criticalDays: 2, // days of cover at current consumption before stock is Critical
      lowDays: 5,
      excessDays: 30,
    },
  },
  escalation: {
    minSeverity: 'Low',
    // Severity -> role to escalate to. Real Krisala hierarchy can be configured later.
    map: { Low: 'site_engineer', Medium: 'site_manager', High: 'project_manager' },
  },
};

function merge(base, override) {
  if (!override || typeof override !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] ? merge(base[k], v) : v;
  }
  return out;
}

export async function getRules() {
  const doc = await Setting.findOne({ key: 'rules' }).lean();
  return merge(DEFAULT_RULES, doc?.value);
}

export async function saveRules(value) {
  const merged = merge(DEFAULT_RULES, value);
  await Setting.updateOne({ key: 'rules' }, { $set: { value: merged } }, { upsert: true });
  return merged;
}
