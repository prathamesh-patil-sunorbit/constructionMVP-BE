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
    // Plinth estimate from a geotechnical report (services/ai/geotech.js). Placeholder rates
    // until the estimation team confirms them; every figure in an estimate names its rate.
    geotech: {
      defaultDepthM: 1.5, // used when neither the user nor the report gives a depth
      defaultPlinthAreaSqm: 400, // used when neither the user nor the report gives a plinth area
      softSbcBelowKnM2: 100, // safe bearing capacity below this => soft soil
      hardSbcFromKnM2: 250, // at or above this => hard strata
      raftBelowSbcKnM2: 100, // below this a raft is assumed even if the report does not say so
      bulkingFactor: { soft: 1.2, ordinary: 1.25, hard: 1.3, rock: 1.5 },
      jcbM3PerDay: { soft: 200, ordinary: 160, hard: 100, rock: 45 }, // loose m³ per JCB per 8 h day
      dewateringProductivityFactor: 0.8, // wet excavation is slower
      targetExcavationDays: 5,
      maxJcbs: 3,
      plinthAreaPerJcbSqm: 150, // working room each JCB needs
      pcc: { thicknessM: 0.1, offsetM: 0.15, m3PerDay: 20, masons: 2, helpers: 6 },
      footing: { perHundredSqm: 4, sizeM: 2, depthM: 0.6, steelKgPerM3: 80 },
      raft: { thicknessM: 0.45, steelKgPerM3: 100 },
      plinthBeam: { widthM: 0.23, depthM: 0.45, aspectRatio: 1.5, lengthFactor: 1.6, steelKgPerM3: 130 },
      rcc: {
        m3PerGangUnit: 20, // concrete volume one gang unit handles
        maxGangUnits: 4,
        gangUnit: { masons: 2, barBenders: 3, carpenters: 2, helpers: 4 },
        steelKgPerBarBenderDay: 300,
        shutteringSqmPerCarpenterDay: 12,
        mixerM3PerDay: 20,
        pumpFromM3: 40, // at or above this volume, concrete is pumped from transit mixers
        pumpM3PerDay: 150,
        transitMixerM3: 6,
        transitMixerTripsPerDay: 5,
        curingDays: 3, // before the next phase loads the member
      },
      backfill: { m3PerJcbDay: 100, helpers: 4 },
      // Learning from recorded actuals: each default rate counts as this many observations.
      learning: { priorWeight: 3, minFactor: 0.4, maxFactor: 2 },
      // Rain buffer on the plinth schedule (services/weather.js). Known days come from an uploaded
      // weather report or the Open-Meteo forecast; later days use the monthly rainy-day normals.
      weather: {
        site: { name: 'Hinjewadi, Pune', latitude: 18.59, longitude: 73.74 }, // used when the project location cannot be found
        heavyRainMm: 10, // a day with at least this much rain stops rain-sensitive work
        lightRainMm: 2.5, // at least this much slows it down
        // Share of a day's output lost to heavy / light rain, and dry-out days after heavy rain.
        phases: {
          excavation: { heavy: 1, light: 0.5, recoveryDays: 1 },
          pcc: { heavy: 1, light: 0.5, recoveryDays: 0 },
          foundation: { heavy: 0.5, light: 0, recoveryDays: 0 }, // steel and shuttering go on; the pour waits
          plinthBeam: { heavy: 0.5, light: 0, recoveryDays: 0 },
          backfill: { heavy: 1, light: 1, recoveryDays: 1 }, // wet soil cannot be compacted
        },
        wetGroundExtraRecoveryDays: 1, // more excavation dry-out when dewatering is needed or the soil is soft
        // Average days with 2.5 mm+ of rain per month, Jan..Dec (Pune normals, IMD).
        rainyDaysByMonth: [0.2, 0.2, 0.4, 1.1, 2.6, 9.6, 15.4, 13.4, 8.9, 4.8, 1.8, 0.4],
        heavyShareOfRainyDays: 0.4, // of those, the share that are heavy (10 mm+); the rest count as light
      },
    },
  },
  // What-if planning on an uploaded MS Project schedule (services/schedule-sim.js). Placeholder
  // rates until the planning team confirms them; every scenario lists the ones it used.
  schedule: {
    labourEfficiency: 0.7, // +10% people gives +7% output: crews crowd each other
    maxCompression: 0.4, // a task gets at most 40% shorter however many people are added
    maxOverlap: 0.75,
    labourShareOfCost: 0.3, // share of a task's cost that is labour
    overlapReworkShare: 0.03, // rework / coordination allowance at 50% overlap, of the overlapped tasks' cost
    siteOverheadPerDay: 150000, // ₹ per calendar day: staff, security, equipment hire, power
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
