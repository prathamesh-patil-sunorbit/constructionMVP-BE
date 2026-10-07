// Day-by-day plinth plan for site engineers.
//
// When a manager accepts a plinth estimate, each phase's days are turned into dated working days,
// each with a checklist the site engineer ticks off. The checklist text is generated from the
// calculated estimate by fixed templates (no model call), so it never says anything the numbers
// do not support. Engineers can add their own items on top.

import { GeotechReport, Notification, PlinthDay, User } from '../models/index.js';
import { addDays, fmt, toDay, today } from '../utils/dates.js';

const round1 = (n) => Math.round(n * 10) / 10;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// "1 JCB operators" reads wrong; trade and machine names are plurals, so drop the s for a single one.
const label = (x) => { const n = x.name ?? x.trade; return x.count === 1 && /s$/.test(n) && !/ss$/.test(n) ? n.slice(0, -1) : n; };
const list = (items) => items.map((x) => `${x.count} ${label(x)}`).join(', ');

const VERBS = {
  excavation: 'Dig out the plinth excavation',
  pcc: 'Lay the PCC (plain cement concrete) base',
  plinthBeam: 'Cast the plinth beam',
  backfill: 'Backfill and compact around the foundation',
};
const GERUNDS = {
  excavation: 'digging out the plinth excavation',
  pcc: 'laying the PCC (plain cement concrete) base',
  plinthBeam: 'casting the plinth beam',
  backfill: 'backfilling and compacting around the foundation',
};
const gerundFor = (p) => GERUNDS[p.key] || (p.key === 'foundation' ? `casting the ${p.name.toLowerCase()}` : `working on ${p.name.toLowerCase()}`);
const verbFor = (p) => VERBS[p.key] || (p.key === 'foundation' ? `Cast the ${p.name.toLowerCase()}` : `Work on ${p.name.toLowerCase()}`);

// What the engineer has to get done on one day of one phase.
function itemsFor(p, d, est) {
  const first = d === 1;
  const last = d === p.days;
  const equipment = [...p.machines, ...p.vehicles];
  const q = p.quantity;
  const target = q ? `${round1(q.value / p.days)} ${q.unit}` : null;
  const items = [];
  const add = (text) => items.push(text);

  if (first && equipment.length) add(`Mobilise on site: ${list(equipment)}`);
  add(`Crew present: ${p.workerTotal} workers (${list(p.workers)})`);

  switch (p.key) {
    case 'excavation':
      add(`${verbFor(p)} — target about ${target} today`);
      add(`Tippers hauling spoil away; keep the pit edge clear`);
      if (est.soil.class === 'rock') add('Rock breaker working; barricade the area and keep people clear of flying debris');
      if (est.soil.dewatering) add('Dewatering pump running; pit kept dry');
      if (first) add(`Check the excavation depth against the ${est.inputs.depthM} m the plan assumes`);
      if (last) add('Check pit bottom level and clean it before PCC');
      break;
    case 'pcc':
      add(`${verbFor(p)}${target ? ` — about ${target} today` : ''}`);
      if (first) add('Check the pit bottom is level, clean and free of standing water');
      if (last) add('PCC finished and levelled; set out footing centre lines');
      break;
    case 'foundation':
    case 'plinthBeam':
      add(`${verbFor(p)}${target ? ` — about ${target} of concrete over the phase, share for today` : ''}`);
      if (first) add('Check reinforcement, cover blocks and shuttering against the drawing before concreting');
      add('Steel fixing and shuttering progress recorded');
      if (last) {
        add('Concrete poured and compacted with needle vibrators');
        add('Cube samples taken and curing started');
      }
      break;
    case 'backfill':
      add(`${verbFor(p)} — about ${target} today`);
      add('Fill laid in layers and compacted with the plate compactor');
      if (last) add('Plinth level checked and area handed over');
      break;
    default:
      add(`${verbFor(p)}${target ? ` — about ${target} today` : ''}`);
  }
  if (last) add(`${p.name} complete and signed off`);
  return items;
}

function titleFor(p, d) {
  const stage = p.days === 1 ? 'Start and finish' : d === 1 ? 'Start' : d === p.days ? 'Finish' : 'Keep';
  const q = p.quantity;
  const per = q ? ` — about ${round1(q.value / p.days)} ${q.unit} today` : '';
  return `${stage} ${gerundFor(p)}${per}`;
}

/** Pure: one document body per working day, in order. */
export function buildDays(report, startDate) {
  const est = report.estimate;
  const start = toDay(startDate);
  const out = [];
  for (const p of est.phases) {
    if (p.insufficientData) continue; // nothing to plan; the estimate already says what is missing
    for (let d = 1; d <= p.days; d++) {
      const day = p.startDay + d;
      out.push({
        report: report._id,
        project: report.project,
        day,
        date: addDays(start, day - 1),
        phaseKey: p.key,
        phaseName: p.name,
        dayInPhase: d,
        phaseDays: p.days,
        title: titleFor(p, d),
        planned: p.quantity ? { quantity: round1(p.quantity.value / p.days), unit: p.quantity.unit, label: p.quantity.label } : undefined,
        crew: p.workers.map(({ trade, count }) => ({ trade, count })),
        machines: [
          ...p.machines.map((m) => ({ name: m.name, count: m.count, kind: 'machine' })),
          ...p.vehicles.map((v) => ({ name: v.name, count: v.count, kind: 'vehicle' })),
        ],
        items: itemsFor(p, d, est).map((text) => ({ text, done: false, source: 'plan' })),
      });
    }
  }
  // Days are numbered across the plan; with a skipped (insufficient) phase the numbers have a gap, so renumber.
  return out.map((doc, i) => ({ ...doc, day: i + 1, date: addDays(start, i) }));
}

export function dayStatus(items) {
  const done = items.filter((i) => i.done).length;
  if (!items.length || done === 0) return 'Pending';
  return done === items.length ? 'Done' : 'In Progress';
}

/** Create the plan for an accepted report. Idempotent: an existing plan is left untouched. */
export async function createPlan(report, { startDate, user } = {}) {
  if (!report.estimate) return { created: 0, existing: 0 };
  const existing = await PlinthDay.countDocuments({ report: report._id });
  if (existing) return { created: 0, existing };
  const start = toDay(startDate || today());
  const docs = buildDays(report, start);
  await PlinthDay.insertMany(docs);

  const engineers = await User.find({ role: 'site_engineer', active: true }, '_id').lean();
  if (engineers.length) {
    await Notification.insertMany(engineers.map((u) => ({
      user: u._id, type: 'info',
      title: 'Plinth plan approved',
      message: `${plural(docs.length, 'working day')} planned from ${fmt(start)}. Open the plan to see each day's checklist and update your progress.`,
      link: '/plinth-plan',
    })));
  }
  return { created: docs.length, existing: 0, start, by: user?._id };
}

/**
 * A rejected estimate should not leave a plan on site. Days that nobody has touched are removed;
 * if work has already been recorded, the plan stays so that record is not lost.
 */
export async function withdrawPlan(reportId) {
  const days = await PlinthDay.find({ report: reportId });
  const touched = days.filter((d) => d.actualQuantity != null || d.note || d.items.some((i) => i.done || i.source === 'added'));
  if (touched.length) return { removed: 0, kept: days.length };
  await PlinthDay.deleteMany({ report: reportId });
  return { removed: days.length, kept: 0 };
}

/** Plans for a project (or every project) with their days, newest accepted first. */
export async function listPlans({ project } = {}) {
  const filter = project ? { project } : {};
  const days = await PlinthDay.find(filter).sort({ report: 1, day: 1 }).lean();
  if (!days.length) return [];
  const reportIds = [...new Set(days.map((d) => String(d.report)))];
  const reports = await GeotechReport.find({ _id: { $in: reportIds } }, 'project file extraction.facts.reportTitle inputs verification source createdAt')
    .populate('project', 'name code').populate('verification.by', 'name').lean();
  const byReport = new Map(reports.map((r) => [String(r._id), r]));
  const t = today().getTime();
  return reportIds.map((id) => {
    const r = byReport.get(id);
    const mine = days.filter((d) => String(d.report) === id);
    const done = mine.filter((d) => d.status === 'Done').length;
    const items = mine.reduce((n, d) => n + d.items.length, 0);
    const itemsDone = mine.reduce((n, d) => n + d.items.filter((i) => i.done).length, 0);
    const behind = mine.filter((d) => d.status !== 'Done' && toDay(d.date).getTime() < t).length;
    const todayDay = mine.find((d) => toDay(d.date).getTime() === t);
    return {
      report: {
        _id: id,
        title: r?.extraction?.facts?.reportTitle || r?.file?.originalName || 'Plinth estimate',
        project: r?.project,
        plinthAreaSqm: r?.inputs?.plinthAreaSqm,
        acceptedBy: r?.verification?.by?.name,
        acceptedAt: r?.verification?.at,
      },
      start: mine[0].date,
      end: mine[mine.length - 1].date,
      summary: {
        totalDays: mine.length, doneDays: done, behindDays: behind,
        items, itemsDone, percent: items ? Math.round((itemsDone / items) * 100) : 0,
        todayDay: todayDay?.day ?? null,
      },
      days: mine,
    };
  }).sort((a, b) => new Date(b.report.acceptedAt || 0) - new Date(a.report.acceptedAt || 0));
}
