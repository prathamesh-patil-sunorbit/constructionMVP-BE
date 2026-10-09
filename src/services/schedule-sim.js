// What-if engine for an uploaded MS Project schedule.
//
// The schedule is re-run with the critical path method over the real task links (FS / SS / FF / SF
// with lags, links to group rows resolved to the tasks inside them, "start no earlier than"
// constraints), in working days from the status date. A scenario changes the inputs — more labour
// shortens labour-driven tasks, overlap lets sequential tasks run partly in parallel — and the
// schedule is run again. Days saved = scenario finish − unchanged finish, so the method's own
// simplifications cancel out. Cost effects use the rates in rules.schedule; every assumption is
// listed in the result. No model call happens here.

import { DAY_MS, toDay } from '../utils/dates.js';

const round1 = (n) => Math.round(n * 10) / 10;

// Work that more people cannot make faster (curing, approvals, deliveries, testing, checks).
const FIXED_WORK = /curing|deliver|noc|approval|permission|testing|commission|finali[sz]|consultant|architect|checking|inspection|handover|survey|mock\s*up|lead time/i;
// Work a following task cannot overlap: it must be fully finished first.
const NO_OVERLAP = /concret|curing|testing|commission|noc|handover|snag|deep clean|waterproof.*test/i;

// ---------------------------------------------------------------------------
// Working-day calendar from the status date (Sunday off on a 6-day week, site holidays off)
// ---------------------------------------------------------------------------

function calendar(statusDate, perWeek = 6, holidays = []) {
  const origin = toDay(statusDate);
  const off = new Set(holidays.map((h) => h.date));
  const isWork = (d) => { const wd = d.getUTCDay(); return !(wd === 0 || (perWeek <= 5 && wd === 6) || off.has(d.toISOString().slice(0, 10))); };
  const index = (date) => {
    // working days from origin to date (negative before the origin)
    const d = toDay(date);
    const step = d >= origin ? 1 : -1;
    let n = 0;
    for (let x = new Date(origin); step > 0 ? x < d : x > d; x = new Date(x.getTime() + step * DAY_MS)) if (isWork(x)) n += step;
    return n;
  };
  const date = (idx) => {
    // the working day that holds index idx (fractions round up to the day the work ends on)
    let n = Math.max(0, Math.ceil(idx - 1e-9));
    let x = new Date(origin);
    while (!isWork(x)) x = new Date(x.getTime() + DAY_MS);
    while (n > 0) { x = new Date(x.getTime() + DAY_MS); if (isWork(x)) n -= 1; }
    return x;
  };
  return { origin, index, date };
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/** Area (wing) = the level under the project; package = the level under that (RCC WORK, BLOCKWORK…). */
export function structure(tasks) {
  const byUid = new Map(tasks.map((t) => [t.uid, t]));
  const minLevel = Math.min(...tasks.map((t) => t.level));
  const ancestorAt = (t, level) => { let p = t; while (p && p.level > level) p = byUid.get(p.parentUid); return p && p.level === level ? p : null; };
  const areaOf = (t) => ancestorAt(t, minLevel + 1);
  const packageOf = (t) => ancestorAt(t, minLevel + 2);
  return { byUid, minLevel, areaOf, packageOf };
}

function inScope(t, scope, s) {
  if (scope?.areas?.length && !scope.areas.includes(s.areaOf(t)?.uid)) return false;
  if (scope?.packages?.length && !scope.packages.includes(s.packageOf(t)?.name)) return false;
  if (scope?.criticalOnly && !t._critical) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Forward pass
// ---------------------------------------------------------------------------

function run(tasks, cal, { durations, links }) {
  const leaves = tasks.filter((t) => !t.summary);
  const children = new Map();
  for (const t of tasks) if (t.parentUid != null) children.set(t.parentUid, [...(children.get(t.parentUid) || []), t]);
  const leafDesc = new Map();
  const descend = (uid) => {
    if (leafDesc.has(uid)) return leafDesc.get(uid);
    const kids = children.get(uid) || [];
    const out = kids.flatMap((k) => (k.summary ? descend(k.uid) : [k]));
    leafDesc.set(uid, out);
    return out;
  };
  const ES = new Map();
  const EF = new Map();
  const driver = new Map();
  for (const t of leaves) {
    const R = durations.get(t.uid);
    if (t._done) { ES.set(t.uid, cal.index(t.actualStart || t.start)); EF.set(t.uid, cal.index(t.actualFinish || t.finish)); }
    // Under way: MS Project's own finish holds (the rest may wait on linked work); a shorter remainder moves it in.
    else if (t._started) { const es = Math.max(0, cal.index(t.finish) - t._remaining); ES.set(t.uid, es); EF.set(t.uid, es + R); }
    else { ES.set(t.uid, 0); EF.set(t.uid, R); }
  }
  const timesOf = (uid) => {
    const node = tasks.find((x) => x.uid === uid);
    if (!node?.summary) return { es: ES.get(uid) ?? 0, ef: EF.get(uid) ?? 0 };
    const ls = descend(uid);
    return ls.length ? { es: Math.min(...ls.map((l) => ES.get(l.uid))), ef: Math.max(...ls.map((l) => EF.get(l.uid))) } : { es: 0, ef: 0 };
  };
  const summaryTimes = new Map();
  const open = leaves.filter((t) => !t._done && !t._started);
  for (let pass = 0; pass < 200; pass++) {
    summaryTimes.clear();
    const tOf = (uid) => { if (!summaryTimes.has(uid)) summaryTimes.set(uid, timesOf(uid)); return summaryTimes.get(uid); };
    let changed = false;
    for (const t of open) {
      const R = durations.get(t.uid);
      let es = t._snet ?? 0;
      let by = null;
      for (const l of links.get(t.uid) || []) {
        const p = tOf(l.uid);
        const need = l.type === 'SS' ? p.es + l.lag : l.type === 'FF' ? p.ef + l.lag - R : l.type === 'SF' ? p.es + l.lag - R : p.ef + l.lag;
        if (need > es + 1e-9) { es = need; by = l.uid; }
      }
      es = Math.max(0, es);
      if (Math.abs(es - ES.get(t.uid)) > 1e-6) { ES.set(t.uid, es); EF.set(t.uid, es + R); driver.set(t.uid, by); changed = true; summaryTimes.clear(); }
    }
    if (!changed) break;
  }
  // Driving chain back from a task: the tasks that set its date.
  const chainFrom = (end) => {
    const chain = [];
    const seen = new Set();
    let cur = end;
    while (cur && !seen.has(cur.uid) && chain.length < 400) {
      seen.add(cur.uid);
      chain.unshift(cur.uid);
      const d = driver.get(cur.uid);
      if (d == null) break;
      const node = tasks.find((x) => x.uid === d);
      // a driving group row: continue from its last-finishing task
      cur = node?.summary ? descend(d).reduce((a, b) => (EF.get(b.uid) > EF.get(a.uid) ? b : a), descend(d)[0]) : node;
    }
    return chain;
  };
  let last = null;
  for (const t of leaves) if (!last || EF.get(t.uid) > EF.get(last.uid)) last = t;
  return { ES, EF, finish: last ? EF.get(last.uid) : 0, chain: last ? chainFrom(last) : [], chainFrom };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function prepare(doc) {
  const tasks = doc.tasks.map((t) => ({ ...t }));
  const statusDate = doc.statusDate || new Date();
  const cal = calendar(statusDate, doc.workDaysPerWeek || 6, doc.holidays || []);
  for (const t of tasks) {
    t._done = t.percent >= 100 || !!t.actualFinish;
    t._started = !t._done && (t.percent > 0 || !!t.actualStart);
    const full = t.durationDays ?? 0;
    t._remaining = t._done ? 0 : t._started ? (t.remainingDurationDays ?? full * (1 - t.percent / 100)) : full;
    t._snet = t.constraint?.date && /no earlier/.test(t.constraint.type) ? cal.index(t.constraint.date) : null;
    t._critical = !!t.critical || (t.totalSlackDays != null && t.totalSlackDays <= 0);
  }
  return { tasks, cal, s: structure(tasks) };
}

const baseLinks = (tasks) => new Map(tasks.filter((t) => !t.summary).map((t) => [t.uid, t.predecessors.map((p) => ({ uid: p.uid, type: p.type, lag: p.lagDays || 0 }))]));
const baseDurations = (tasks) => new Map(tasks.filter((t) => !t.summary).map((t) => [t.uid, t._remaining]));

/**
 * scenario = { labourPct: 0..100, overlapPct: 0..75, scope: { areas: [uid], packages: [name], criticalOnly } }
 */
/** Unchanged re-run: per-area finish from the calculation next to MS Project's own (a fidelity check). */
export function checkFidelity(doc) {
  const { tasks, cal, s } = prepare(doc);
  const base = run(tasks, cal, { durations: baseDurations(tasks), links: baseLinks(tasks) });
  return tasks.filter((t) => t.level === s.minLevel + 1).map((a) => {
    const leaves = tasks.filter((t) => !t.summary && s.areaOf(t)?.uid === a.uid);
    const ef = Math.max(...leaves.map((l) => base.EF.get(l.uid)));
    const diffs = leaves.filter((l) => !l._done && l.finish).map((l) => ({ name: l.name, wbs: l.wbs, started: l._started, pct: l.percent, mppStart: l.start, calcStart: cal.date(base.ES.get(l.uid)), mpp: toDay(l.finish), calc: cal.date(base.EF.get(l.uid)) }));
    return { area: a.name, mpp: toDay(a.finish), calculated: cal.date(ef), diffs };
  });
}

export function simulate(doc, scenario, rules) {
  const r = rules.schedule;
  const { tasks, cal, s } = prepare(doc);
  const base = run(tasks, cal, { durations: baseDurations(tasks), links: baseLinks(tasks) });
  // Critical = the chain that sets the project finish plus the chain that sets each area's finish
  // (speeding up only the first one just hands the finish date to the next wing).
  const critical = new Set(base.chain);
  for (const a of tasks.filter((t) => t.level === s.minLevel + 1)) {
    const leaves = tasks.filter((t) => !t.summary && !t._done && s.areaOf(t)?.uid === a.uid);
    const end = leaves.reduce((x, y) => (!x || base.EF.get(y.uid) > base.EF.get(x.uid) ? y : x), null);
    if (end) for (const uid of base.chainFrom(end)) critical.add(uid);
  }
  for (const t of tasks) if (critical.has(t.uid)) t._critical = true;

  const labour = Math.max(0, Math.min(200, Number(scenario.labourPct) || 0)) / 100;
  const overlap = Math.max(0, Math.min(r.maxOverlap, (Number(scenario.overlapPct) || 0) / 100));
  const durations = baseDurations(tasks);
  const links = baseLinks(tasks);
  let compressed = 0;
  let overlappedLinks = 0;
  let labourCostBase = 0;
  let overlappedCost = 0;

  // More labour: duration ÷ (1 + extra × efficiency), never below (1 − maxCompression) of the original.
  const speed = 1 + labour * r.labourEfficiency;
  for (const t of tasks) {
    if (t.summary || t._done || !labour || !inScope(t, scenario.scope, s) || FIXED_WORK.test(t.name) || t.milestone) continue;
    const R = durations.get(t.uid);
    if (!R) continue;
    const next = Math.max(R * (1 - r.maxCompression), R / speed);
    if (next < R) {
      durations.set(t.uid, next);
      compressed += 1;
      labourCostBase += (t.cost || 0) * (t._started ? (1 - t.percent / 100) : 1) * r.labourShareOfCost;
    }
  }
  // Parallel work: a finish→start link between two tasks in scope becomes start→start with a lag,
  // so the next task starts when (1 − overlap) of the previous one is done.
  if (overlap) {
    for (const t of tasks) {
      if (t.summary || t._done || !inScope(t, scenario.scope, s) || NO_OVERLAP.test(t.name)) continue;
      const list = links.get(t.uid).map((l) => {
        const p = s.byUid.get(l.uid);
        if (l.type !== 'FS' || !p || p.summary || p._done || NO_OVERLAP.test(p.name) || !inScope(p, scenario.scope, s)) return l;
        overlappedLinks += 1;
        overlappedCost += t.cost || 0;
        return { uid: l.uid, type: 'SS', lag: Math.max(0, l.lag) + durations.get(p.uid) * (1 - overlap) };
      });
      links.set(t.uid, list);
    }
  }
  const next = run(tasks, cal, { durations, links });

  // Dates: the unchanged run is anchored on MS Project's own finish, and the scenario moves it by the difference.
  const mppFinish = toDay(doc.summary?.finish || cal.date(base.finish));
  const saved = round1(base.finish - next.finish);
  const finish = new Date(mppFinish.getTime() - Math.round(saved * (7 / (doc.workDaysPerWeek || 6))) * DAY_MS);
  const calendarDaysSaved = Math.round((mppFinish - finish) / DAY_MS);

  // Money: extra labour costs more than it saves in time (crowding), earlier finish saves site overheads.
  const extraLabourCost = Math.round(labourCostBase * ((1 + labour) / speed - 1));
  const reworkCost = Math.round(overlappedCost * r.overlapReworkShare * (overlap / 0.5));
  const overheadSaving = Math.round(calendarDaysSaved * r.siteOverheadPerDay);
  const net = overheadSaving - extraLabourCost - reworkCost;

  return {
    scenario: { labourPct: Math.round(labour * 100), overlapPct: Math.round(overlap * 100), scope: scenario.scope || {} },
    finish,
    baseFinish: mppFinish,
    workDaysSaved: saved,
    calendarDaysSaved,
    tasksSpedUp: compressed,
    linksOverlapped: overlappedLinks,
    cost: { extraLabourCost, reworkCost, overheadSaving, net },
    criticalTasks: critical.size,
    criticalPath: next.chain.map((uid) => s.byUid.get(uid)).filter(Boolean).map((t) => ({ uid: t.uid, name: t.name, wbs: t.wbs, area: s.areaOf(t)?.name ?? null })),
    assumptions: [
      `Schedule re-run from the status date over ${tasks.filter((t) => !t.summary).length} tasks and their links (${doc.workDaysPerWeek || 6}-day week).`,
      labour ? `+${Math.round(labour * 100)}% labour makes a task ${round1((1 - 1 / speed) * 100)}% shorter (efficiency ${r.labourEfficiency}: crews get in each other's way), at most ${Math.round(r.maxCompression * 100)}% shorter. Curing, deliveries, approvals, testing and milestones do not get faster.` : null,
      overlap ? `${Math.round(overlap * 100)}% overlap: a following task starts when ${Math.round((1 - overlap) * 100)}% of the one before is done. Concreting, curing, testing, NOCs and handover are never overlapped.` : null,
      labour ? `Labour is taken as ${Math.round(r.labourShareOfCost * 100)}% of each task's cost.` : null,
      overlap ? `Overlap adds a rework/coordination allowance of ${Math.round(r.overlapReworkShare * 100)}% of the overlapped tasks' cost at 50% overlap.` : null,
      `Each calendar day saved saves ₹${r.siteOverheadPerDay.toLocaleString('en-IN')} of site overheads (staff, security, equipment hire, power).`,
    ].filter(Boolean),
  };
}

/** If the work so far is any guide: schedule performance from MS Project's planned % against actual %. */
export function pacePrediction(doc) {
  const work = doc.tasks.filter((t) => !t.summary && t.plannedPercent != null && (t.baselineDurationDays || t.durationDays));
  let earned = 0;
  let planned = 0;
  for (const t of work) {
    const d = t.baselineDurationDays || t.durationDays;
    earned += (t.percent / 100) * d;
    planned += (t.plannedPercent / 100) * d;
  }
  const spi = planned ? Math.round((earned / planned) * 100) / 100 : null;
  const finish = toDay(doc.summary.finish);
  const statusDate = toDay(doc.statusDate || new Date());
  const remaining = Math.max(0, Math.round((finish - statusDate) / DAY_MS));
  // At the same pace the remaining calendar time stretches by 1 / SPI (capped so one bad month does not dominate).
  const factor = spi ? Math.min(1.5, Math.max(0.8, 1 / spi)) : 1;
  const predicted = new Date(statusDate.getTime() + Math.round(remaining * factor) * DAY_MS);
  return {
    spi,
    tasksMeasured: work.length,
    behind: work.filter((t) => t.percent + 5 < t.plannedPercent).length,
    scheduledFinish: finish,
    predictedFinish: predicted,
    extraDays: Math.round((predicted - finish) / DAY_MS),
    basis: spi == null
      ? 'MS Project has no planned % for the tasks, so the pace cannot be measured.'
      : `Work done is ${Math.round(spi * 100)}% of what MS Project planned by the status date across ${work.length} measured tasks (SPI ${spi}). If the rest goes at the same pace, the remaining ${remaining} days become about ${Math.round(remaining * factor)}.`,
  };
}

/** Rupees by area (wing) and work package, as stored in the schedule. */
export function costBreakdown(doc) {
  const { tasks } = prepare(doc);
  const s = structure(tasks);
  const row = (t) => ({
    uid: t.uid, name: t.name, cost: t.cost ?? null, baselineCost: t.baselineCost ?? null, actualCost: t.actualCost ?? 0,
    remainingCost: t.remainingCost ?? (t.cost != null ? t.cost - (t.actualCost || 0) : null), percent: t.percent,
    start: t.start, finish: t.finish, finishVarianceDays: t.finishVarianceDays ?? null,
  });
  const areas = tasks.filter((t) => t.level === s.minLevel + 1).map((a) => ({
    ...row(a),
    packages: tasks.filter((t) => t.parentUid === a.uid).map(row).filter((p) => p.cost || p.baselineCost),
  }));
  return { areas: areas.filter((a) => a.cost || a.baselineCost || a.packages.length) };
}

export const PACKAGES = (doc) => {
  const s = structure(doc.tasks);
  return {
    areas: doc.tasks.filter((t) => t.level === s.minLevel + 1).map((t) => ({ uid: t.uid, name: t.name })),
    packages: [...new Set(doc.tasks.filter((t) => t.level === s.minLevel + 2 && t.summary).map((t) => t.name))],
  };
};

/** Ready-made scenarios the planner compares and the AI advisor ranks. */
export const PRESETS = [
  { key: 'crit25', label: '+25% labour on the critical work', scenario: { labourPct: 25, scope: { criticalOnly: true } } },
  { key: 'crit50', label: '+50% labour on the critical work', scenario: { labourPct: 50, scope: { criticalOnly: true } } },
  { key: 'rcc2', label: 'Double crew on RCC work (slab cycle)', scenario: { labourPct: 100, scope: { packages: ['RCC WORK'] } } },
  { key: 'all25', label: '+25% labour on all remaining work', scenario: { labourPct: 25 } },
  { key: 'ovl30', label: '30% overlap of sequential work', scenario: { overlapPct: 30 } },
  { key: 'mix', label: '+25% labour and 30% overlap everywhere', scenario: { labourPct: 25, overlapPct: 30 } },
];
