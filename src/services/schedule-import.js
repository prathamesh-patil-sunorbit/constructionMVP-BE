// Read an MS Project schedule (.mpp, via MPXJ on Java) or its Excel export (.xlsx) into one flat,
// ordered task list with the outline kept (level + parent). Nothing is calculated by a model:
// dates, durations, % complete and links are taken from the file as they are.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ExcelJS from 'exceljs';
import { DAY_MS, toDay, today } from '../utils/dates.js';

const run = promisify(execFile);
const MPXJ_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../vendor/mpxj');

const round1 = (n) => Math.round(n * 10) / 10;
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// "2025-07-01T09:00:00.0" or a Date -> UTC midnight of that calendar day.
const dayOf = (v) => {
  if (!v || v === 'NA') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : toDay(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(String(v)); // 06-10-2026 (DMY, as Indian exports write it)
  if (dmy) return new Date(Date.UTC(+dmy[3] < 100 ? 2000 + +dmy[3] : +dmy[3], +dmy[2] - 1, +dmy[1]));
  return null;
};

// ---------------------------------------------------------------------------
// .mpp
// ---------------------------------------------------------------------------

async function mppToJson(filePath) {
  const out = path.join(os.tmpdir(), `mpxj-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    await run(process.env.JAVA_BIN || 'java', ['-cp', `${MPXJ_DIR}/*`, 'org.mpxj.sample.MpxjConvert', filePath, out], { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Java is not installed on the server, so .mpp files cannot be read. Install Java 11+ or upload the Excel export instead.');
    throw new Error(`The .mpp file could not be read (${clean(error.stderr || error.message).slice(0, 200)})`);
  } finally {
    fs.rm(out, { force: true }, () => {});
  }
}

export async function parseMpp(filePath) {
  const data = await mppToJson(filePath);
  const pv = data.property_values || {};
  const secPerDay = (pv.minutes_per_day || 480) * 60;
  const days = (s) => (s == null ? null : round1(s / secPerDay));
  const resources = new Map((data.resources || []).filter((r) => r.unique_id != null)
    .map((r) => [r.unique_id, { name: clean(r.name), type: r.type, unit: clean(r.material_label) || null }]));
  const byTask = new Map();
  const materialsByTask = new Map();
  const money = (n) => (n == null ? null : Math.round(n));
  for (const a of data.assignments || []) {
    const r = resources.get(a.resource_unique_id);
    if (!r?.name) continue;
    if (!byTask.has(a.task_unique_id)) byTask.set(a.task_unique_id, []);
    byTask.get(a.task_unique_id).push(r.name);
    // A material's "work" is its quantity in hours (1 unit = 3600), e.g. 3450 Sqm of shuttering = 12,420,000.
    if (r.type === 'MATERIAL') {
      const qty = (w) => (w == null ? 0 : round1(w / 3600));
      if (!materialsByTask.has(a.task_unique_id)) materialsByTask.set(a.task_unique_id, []);
      materialsByTask.get(a.task_unique_id).push({
        name: r.name, unit: r.unit, quantity: qty(a.work), actualQuantity: qty(a.actual_work),
        remainingQuantity: a.remaining_work != null ? qty(a.remaining_work) : round1(qty(a.work) - qty(a.actual_work)),
        cost: money(a.cost), actualCost: money(a.actual_cost),
      });
    }
  }
  // unique_id 0 is MS Project's own project summary row; the real outline starts below it.
  const raw = (data.tasks || []).filter((t) => t.unique_id !== 0 && clean(t.name));
  const tasks = raw.map((t) => ({
    uid: t.unique_id,
    wbs: t.outline_number || t.wbs || null,
    level: t.outline_level ?? 1,
    parentUid: t.parent_task_unique_id && t.parent_task_unique_id !== 0 ? t.parent_task_unique_id : null,
    name: clean(t.name),
    summary: !!t.summary,
    milestone: !!t.milestone || t.duration === 0 || t.duration == null,
    critical: !!t.critical,
    start: dayOf(t.start),
    finish: dayOf(t.finish),
    baselineStart: dayOf(t.baseline_start),
    baselineFinish: dayOf(t.baseline_finish),
    actualStart: dayOf(t.actual_start),
    actualFinish: dayOf(t.actual_finish),
    durationDays: days(t.duration),
    baselineDurationDays: days(t.baseline_duration),
    percent: t.percent_complete ?? 0,
    totalSlackDays: days(t.total_slack),
    predecessors: (t.predecessors || []).map((p) => ({ uid: p.predecessor_task_unique_id, type: p.type || 'FS', lagDays: p.lag ? days(p.lag) : 0 })),
    resources: [...new Set(byTask.get(t.unique_id) || [])],
    materials: materialsByTask.get(t.unique_id) || [],
    cost: money(t.cost),
    baselineCost: money(t.baseline_cost),
    actualCost: money(t.actual_cost),
    remainingCost: money(t.remaining_cost),
    actualDurationDays: days(t.actual_duration),
    remainingDurationDays: days(t.remaining_duration),
    freeSlackDays: days(t.free_slack),
    earlyStart: dayOf(t.early_start),
    earlyFinish: dayOf(t.early_finish),
    lateStart: dayOf(t.late_start),
    lateFinish: dayOf(t.late_finish),
    plannedPercent: t.schedule_percent_complete ?? null, // what MS Project expected done by the status date
    constraint: t.constraint_type && t.constraint_type !== 'AS_SOON_AS_POSSIBLE'
      ? { type: t.constraint_type.toLowerCase().replace(/_/g, ' '), date: dayOf(t.constraint_date) } : null,
    note: clean(t.notes) || clean(t.text10) || null,
    created: dayOf(t.created),
  }));
  const minutesPerDay = pv.minutes_per_day || 480;
  // Site holidays from the project calendar (dated ones and yearly ones like Republic Day).
  const projectCal = (data.calendars || []).find((c) => c.unique_id === pv.default_calendar_unique_id);
  const holidays = new Map();
  for (const e of projectCal?.exceptions || []) {
    if (e.type && e.type !== 'non_working') continue;
    const name = clean(e.name) || 'Holiday';
    if (e.from) {
      for (let d = dayOf(e.from); d <= dayOf(e.to || e.from); d = new Date(d.getTime() + DAY_MS)) holidays.set(d.toISOString().slice(0, 10), name);
    } else if (e.recurrence?.type === 'yearly' && e.recurrence.month_number && e.recurrence.day_number) {
      const from = Number(String(e.recurrence.start_date).slice(0, 4));
      const to = Number(String(e.recurrence.finish_date).slice(0, 4));
      for (let y = from; y <= to; y++) {
        const k = new Date(Date.UTC(y, e.recurrence.month_number - 1, e.recurrence.day_number)).toISOString().slice(0, 10);
        if (!holidays.has(k)) holidays.set(k, name);
      }
    }
  }
  return {
    format: 'mpp',
    // "msproj11" and the like are MS Project's default file titles; the top task names the project.
    title: (!/^msproj\d*$/i.test(clean(pv.project_title)) && clean(pv.project_title)) || tasks.find((t) => t.level === 1)?.name || null,
    workDaysPerWeek: pv.minutes_per_week ? Math.round(pv.minutes_per_week / minutesPerDay) : 6,
    calendarName: clean(projectCal?.name) || null,
    holidays: [...holidays.entries()].sort().map(([date, name]) => ({ date, name })),
    statusDate: dayOf(pv.status_date),
    author: clean(pv.last_author) || null,
    application: clean(pv.full_application_name) || null,
    tasks,
  };
}

// ---------------------------------------------------------------------------
// .xlsx (MS Project "Export to Excel" or a similar tracker sheet)
// ---------------------------------------------------------------------------

const COLS = {
  sr: /^(sr\.?\s*no\.?|id|s\.?\s*no\.?|#)$/i,
  wbs: /^(wbs|outline( number)?)$/i,
  name: /^(task\s*name|activity(\s*name)?|name|description)$/i,
  baselineStart: /^baseline\s*start/i,
  baselineFinish: /^baseline\s*finish/i,
  duration: /^duration$/i,
  start: /^(start|planned\s*start|current\s*start)$/i,
  finish: /^(finish|end|planned\s*finish|current\s*finish)$/i,
  actualStart: /^actual\s*start/i,
  actualFinish: /^actual\s*finish/i,
  percent: /^%?\s*(complete|progress)|^% complete$/i,
  predecessors: /^predecessors?$/i,
  resources: /^resource\s*names?$/i,
};

const cellValue = (c) => {
  if (c == null) return null;
  if (c instanceof Date) return c;
  if (typeof c === 'object') return c.result ?? c.text ?? c.richText?.map((r) => r.text).join('') ?? null;
  return c;
};

export async function parseXlsx(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  for (const ws of wb.worksheets) {
    // The header row is the first one with a task-name column and a start or finish column.
    let header = null;
    let headerRow = 0;
    for (let i = 1; i <= Math.min(ws.rowCount, 20) && !header; i++) {
      const vals = ws.getRow(i).values.map((v) => clean(cellValue(v)));
      const map = {};
      vals.forEach((v, col) => {
        for (const [key, re] of Object.entries(COLS)) if (map[key] == null && re.test(v)) { map[key] = col; break; }
      });
      if (map.name != null && (map.start != null || map.finish != null || map.baselineStart != null)) { header = map; headerRow = i; }
    }
    if (!header) continue;

    const tasks = [];
    const stack = []; // last task seen at each level
    let indentUnit = null;
    for (let i = headerRow + 1; i <= ws.rowCount; i++) {
      const row = ws.getRow(i);
      const get = (k) => (header[k] == null ? null : cellValue(row.getCell(header[k]).value));
      const rawName = String(get('name') ?? '');
      if (!clean(rawName)) continue;
      // MS Project exports show the outline by indenting the name with spaces.
      const indent = rawName.length - rawName.trimStart().length;
      if (indent > 0 && indentUnit == null) indentUnit = indent;
      const wbs = clean(get('wbs')) || null;
      const level = wbs ? wbs.split('.').length : 1 + (indentUnit ? Math.round(indent / indentUnit) : 0);
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      const parent = stack[stack.length - 1] || null;
      const dur = clean(get('duration'));
      const durNum = dur ? Number(/-?[\d.]+/.exec(dur)?.[0]) : null;
      const pct = get('percent');
      const percent = pct == null || pct === 'NA' ? 0 : typeof pct === 'number' ? (pct <= 1 ? pct * 100 : pct) : Number(String(pct).replace('%', '')) || 0;
      const sr = get('sr');
      const task = {
        uid: Number.isFinite(Number(sr)) && sr !== null ? Number(sr) : i,
        wbs,
        level,
        parentUid: parent?.uid ?? null,
        name: clean(rawName),
        summary: false,
        milestone: durNum === 0,
        critical: false,
        start: dayOf(get('start')),
        finish: dayOf(get('finish')),
        baselineStart: dayOf(get('baselineStart')),
        baselineFinish: dayOf(get('baselineFinish')),
        actualStart: dayOf(get('actualStart')),
        actualFinish: dayOf(get('actualFinish')),
        durationDays: Number.isFinite(durNum) ? round1(/w/i.test(dur) ? durNum * 6 : durNum) : null,
        baselineDurationDays: null,
        percent: round1(percent),
        totalSlackDays: null,
        predecessors: [],
        resources: clean(get('resources')) ? clean(get('resources')).split(/[,;]/).map(clean).filter(Boolean) : [],
        predecessorText: clean(get('predecessors')) || null,
        materials: [],
        note: null,
      };
      if (parent) parent.summary = true;
      tasks.push(task);
      stack.push(task);
    }
    // "3FS+2 days,5" -> links by Sr. No.
    const ids = new Set(tasks.map((t) => t.uid));
    for (const t of tasks) {
      for (const part of (t.predecessorText || '').split(/[,;]/)) {
        const m = /^\s*(\d+)\s*(FS|SS|FF|SF)?\s*([+-]\s*[\d.]+)?/i.exec(part);
        if (m && ids.has(Number(m[1]))) t.predecessors.push({ uid: Number(m[1]), type: (m[2] || 'FS').toUpperCase(), lagDays: m[3] ? Number(m[3].replace(/\s/g, '')) : 0 });
      }
      delete t.predecessorText;
    }
    if (tasks.length) return { format: 'xlsx', title: tasks[0].level === 1 ? tasks[0].name : null, workDaysPerWeek: 6, statusDate: null, author: null, application: 'Excel', sheet: ws.name, tasks };
  }
  throw new Error('No schedule found in the workbook: expected a header row with "Task Name" and "Start" / "Finish" columns.');
}

// ---------------------------------------------------------------------------
// Derived fields and summary
// ---------------------------------------------------------------------------

const diff = (a, b) => (a && b ? Math.round((toDay(a) - toDay(b)) / DAY_MS) : null);

export function taskStatus(t, on = today()) {
  if (t.percent >= 100 || t.actualFinish) return 'Completed';
  if (t.finish && toDay(t.finish) < on) return 'Overdue';
  if (t.percent > 0 || t.actualStart || (t.start && toDay(t.start) <= on)) return 'In Progress';
  return 'Not Started';
}

/** Adds path (names of the parents), variance against the baseline and status. */
export function enrich(parsed, on = today()) {
  const byUid = new Map(parsed.tasks.map((t) => [t.uid, t]));
  const parents = new Set(parsed.tasks.map((t) => t.parentUid).filter((u) => u != null));
  for (const t of parsed.tasks) {
    if (parents.has(t.uid)) t.summary = true;
    const names = [];
    let p = byUid.get(t.parentUid);
    while (p) {
      names.unshift(p.name);
      p = byUid.get(p.parentUid);
    }
    t.path = names;
    t.finishVarianceDays = diff(t.finish, t.baselineFinish); // + = later than the baseline
    t.startVarianceDays = diff(t.start, t.baselineStart);
    t.status = taskStatus(t, on);
  }
  return parsed;
}

export function summarise(parsed, on = today()) {
  const tasks = parsed.tasks;
  const work = tasks.filter((t) => !t.summary);
  const root = tasks.find((t) => t.level === Math.min(...tasks.map((x) => x.level)));
  const count = (s) => work.filter((t) => t.status === s).length;
  const starts = tasks.map((t) => t.start).filter(Boolean).map(Number);
  const finishes = tasks.map((t) => t.finish).filter(Boolean).map(Number);
  const baselineFinishes = tasks.map((t) => t.baselineFinish).filter(Boolean).map(Number);
  const week = new Date(on.getTime() + 7 * DAY_MS);
  // Material totals across the work tasks (planned, used, still to use).
  const materials = new Map();
  for (const m of work.flatMap((t) => t.materials || [])) {
    const k = `${m.name}|${m.unit}`;
    const x = materials.get(k) || { name: m.name, unit: m.unit, quantity: 0, actualQuantity: 0, remainingQuantity: 0, cost: 0, actualCost: 0, tasks: 0 };
    x.quantity += m.quantity; x.actualQuantity += m.actualQuantity; x.remainingQuantity += m.remainingQuantity;
    x.cost += m.cost || 0; x.actualCost += m.actualCost || 0; x.tasks += 1;
    materials.set(k, x);
  }
  return {
    tasks: tasks.length,
    workTasks: work.length,
    summaries: tasks.length - work.length,
    milestones: work.filter((t) => t.milestone).length,
    critical: work.filter((t) => t.critical).length,
    completed: count('Completed'),
    inProgress: count('In Progress'),
    overdue: count('Overdue'),
    notStarted: count('Not Started'),
    percent: root?.percent ?? (work.length ? round1(work.reduce((n, t) => n + t.percent, 0) / work.length) : 0),
    start: starts.length ? new Date(Math.min(...starts)) : null,
    finish: finishes.length ? new Date(Math.max(...finishes)) : null,
    baselineFinish: baselineFinishes.length ? new Date(Math.max(...baselineFinishes)) : null,
    delayDays: finishes.length && baselineFinishes.length ? diff(new Date(Math.max(...finishes)), new Date(Math.max(...baselineFinishes))) : null,
    startingThisWeek: work.filter((t) => t.status === 'Not Started' && t.start && t.start >= on && t.start < week).length,
    resources: [...new Set(work.flatMap((t) => t.resources))],
    materials: [...materials.values()].map((m) => ({ ...m, quantity: round1(m.quantity), actualQuantity: round1(m.actualQuantity), remainingQuantity: round1(m.remainingQuantity) })),
    cost: root?.cost ?? null,
    baselineCost: root?.baselineCost ?? null,
    actualCost: root?.actualCost ?? null,
    remainingCost: root?.remainingCost ?? null,
    behindPlan: work.filter((t) => t.plannedPercent != null && t.percent + 5 < t.plannedPercent).length,
  };
}

/** Read any supported schedule file. */
export async function parseSchedule(filePath, originalName) {
  const ext = path.extname(originalName || filePath).toLowerCase();
  const parsed = ext === '.mpp' ? await parseMpp(filePath) : ext === '.xlsx' ? await parseXlsx(filePath) : null;
  if (!parsed) throw new Error('Upload a Microsoft Project .mpp file or its Excel (.xlsx) export');
  if (!parsed.tasks.length) throw new Error('The file has no tasks');
  enrich(parsed);
  return { ...parsed, summary: summarise(parsed) };
}
