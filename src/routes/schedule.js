// MS Project schedule: managers upload the .mpp (or its Excel export) and see every task;
// site engineers see the tasks that fall on each day. Mounted behind requireAuth.

import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { Router } from 'express';
import multer from 'multer';
import { Project, ScheduleImport } from '../models/index.js';
import { requireRole, HttpError } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { enrich, parseSchedule, summarise } from '../services/schedule-import.js';
import { PACKAGES, simulate } from '../services/schedule-sim.js';
import { adviseOnSchedule, planInputs } from '../services/schedule-ai.js';
import { getRules } from '../services/settings.js';
import { checkRateLimit } from '../services/ai/gemini.js';
import { DAY_MS, addDays, toDay, today } from '../utils/dates.js';
import { UPLOAD_DIR } from './activities.js';

const router = Router();
const UPLOADERS = ['admin', 'project_manager', 'site_manager'];

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.-]+/g, '_')}`),
  }),
  limits: { fileSize: 40 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['.mpp', '.xlsx'].includes(path.extname(file.originalname).toLowerCase())) return cb(null, true);
    cb(new HttpError(400, 'Upload a Microsoft Project .mpp file or its Excel (.xlsx) export'));
  },
});
const uploadFile = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (err instanceof multer.MulterError) return next(new HttpError(400, err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 40 MB' : err.message));
  next(err);
});

// Status and variance depend on today, so they are worked out on every read.
function fresh(doc) {
  const parsed = enrich({ tasks: doc.tasks.map((t) => ({ ...t })) });
  return { ...doc, tasks: parsed.tasks, summary: { ...doc.summary, ...summarise(parsed) } };
}

const META = '-tasks';

router.post('/imports', requireRole(...UPLOADERS), uploadFile, async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Attach the schedule file (.mpp or .xlsx)');
  const { project } = req.body || {};
  try {
    if (!project || !mongoose.isValidObjectId(project) || !(await Project.exists({ _id: project }))) throw new HttpError(400, 'A valid project is required');
    let parsed;
    try {
      parsed = await parseSchedule(req.file.path, req.file.originalname);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    const doc = await ScheduleImport.create({
      project, uploadedBy: req.user._id,
      file: { originalName: req.file.originalname, filename: req.file.filename, url: `/uploads/${req.file.filename}`, size: req.file.size },
      format: parsed.format, title: parsed.title, sheet: parsed.sheet, statusDate: parsed.statusDate, author: parsed.author,
      application: parsed.application, workDaysPerWeek: parsed.workDaysPerWeek, calendarName: parsed.calendarName, holidays: parsed.holidays || [],
      summary: parsed.summary, tasks: parsed.tasks,
    });
    await audit(req.user, 'Schedule uploaded', {
      entityType: 'ScheduleImport', entityId: doc._id, project, comment: req.file.originalname,
      newValue: { format: parsed.format, tasks: parsed.summary.tasks, finish: parsed.summary.finish },
    });
    const out = await ScheduleImport.findById(doc._id).populate('uploadedBy', 'name role').lean();
    res.status(201).json(fresh(out));
  } catch (error) {
    fs.rm(req.file.path, { force: true }, () => {});
    throw error;
  }
});

router.get('/imports', async (req, res) => {
  const { project } = req.query;
  if (!project) return res.status(400).json({ error: 'project is required' });
  res.json(await ScheduleImport.find({ project }).select(META).sort({ createdAt: -1 }).limit(30).populate('uploadedBy', 'name role').lean());
});

router.get('/imports/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Schedule not found' });
  const doc = await ScheduleImport.findById(req.params.id).populate('uploadedBy', 'name role').lean();
  if (!doc) return res.status(404).json({ error: 'Schedule not found' });
  res.json(fresh(doc));
});

router.delete('/imports/:id', requireRole(...UPLOADERS), async (req, res) => {
  const doc = await ScheduleImport.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Schedule not found' });
  await doc.deleteOne();
  if (doc.file?.filename) fs.rm(path.join(UPLOAD_DIR, path.basename(doc.file.filename)), { force: true }, () => {});
  await audit(req.user, 'Schedule removed', { entityType: 'ScheduleImport', entityId: doc._id, project: doc.project, comment: doc.file?.originalName });
  res.json({ ok: true });
});

// ---------- AI planner: forecast, cost, what-if ----------

const PLANNERS = [...UPLOADERS];
async function loadDoc(id) {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'Schedule not found');
  const doc = await ScheduleImport.findById(id).lean();
  if (!doc) throw new HttpError(404, 'Schedule not found');
  if (doc.format !== 'mpp') throw new HttpError(400, 'The AI planner needs the .mpp file: the Excel export has no task links, costs or materials. Upload the .mpp.');
  return fresh(doc);
}

// Everything calculated: pace forecast, cost breakdown, the critical path and the ready-made scenarios.
router.get('/imports/:id/plan', requireRole(...PLANNERS), async (req, res) => {
  const doc = await loadDoc(req.params.id);
  const rules = await getRules();
  res.json({ ...planInputs(doc, rules), options: PACKAGES(doc), advice: doc.advice || null, rules: rules.schedule });
});

// One custom scenario.
router.post('/imports/:id/simulate', requireRole(...PLANNERS), async (req, res) => {
  const doc = await loadDoc(req.params.id);
  const { labourPct = 0, overlapPct = 0, scope = {} } = req.body || {};
  const clean = {
    labourPct: Number(labourPct) || 0, overlapPct: Number(overlapPct) || 0,
    scope: {
      areas: Array.isArray(scope.areas) ? scope.areas.map(Number).filter(Number.isFinite) : [],
      packages: Array.isArray(scope.packages) ? scope.packages.map(String) : [],
      criticalOnly: !!scope.criticalOnly,
    },
  };
  res.json(simulate(doc, clean, await getRules()));
});

// Gemini reads the calculated results and writes the advice; kept on the schedule.
router.post('/imports/:id/advice', requireRole(...PLANNERS), async (req, res) => {
  const { ok, retryInSec } = checkRateLimit(req.user._id);
  if (!ok) return res.status(429).json({ error: `AI rate limit reached. Try again in ${retryInSec}s.` });
  const doc = await loadDoc(req.params.id);
  const project = await Project.findById(doc.project, 'name').lean();
  const out = await adviseOnSchedule(doc, await getRules(), { user: req.user, projectName: project?.name });
  if (out.advice) await ScheduleImport.updateOne({ _id: doc._id }, { $set: { advice: out.advice } });
  res.json({ advice: out.advice, error: out.error || null });
});

// ---------- Day-wise tasks (site engineers) ----------

// Sunday is off on a 6-day week; Saturday too on a 5-day week; plus the site holidays.
// `cal` = { perWeek, holidays: Map(YYYY-MM-DD -> name) }.
const isWorkDay = (d, cal) => {
  const wd = d.getUTCDay();
  return !(wd === 0 || (cal.perWeek <= 5 && wd === 6) || cal.holidays.has(d.toISOString().slice(0, 10)));
};
function workDaysBetween(a, b, cal) {
  let n = 0;
  for (let d = toDay(a); d <= b; d = addDays(d, 1)) if (isWorkDay(d, cal)) n += 1;
  return n;
}

/**
 * The latest schedule's work tasks on each day of a window: what is running, starting and due,
 * with how far through its dates the task should be by then. Plus everything already overdue.
 */
router.get('/day-tasks', async (req, res) => {
  const { project } = req.query;
  if (!project) return res.status(400).json({ error: 'project is required' });
  const doc = req.query.import && mongoose.isValidObjectId(req.query.import)
    ? await ScheduleImport.findById(req.query.import).populate('uploadedBy', 'name').lean()
    : await ScheduleImport.findOne({ project }).sort({ createdAt: -1 }).populate('uploadedBy', 'name').lean();
  if (!doc) return res.json({ import: null, days: [], overdue: [] });

  const now = today();
  const from = req.query.from ? toDay(req.query.from) : now;
  if (!from || Number.isNaN(from.getTime())) throw new HttpError(400, 'from must be a date');
  const span = Math.min(31, Math.max(1, Number(req.query.days) || 7));
  const perWeek = doc.workDaysPerWeek || 6;
  const cal = { perWeek, holidays: new Map((doc.holidays || []).map((h) => [h.date, h.name])) };
  const { tasks } = fresh(doc);
  const byUid = new Map(tasks.map((t) => [t.uid, t]));
  const work = tasks.filter((t) => !t.summary && t.start && t.finish);

  const brief = (t, on) => {
    const start = toDay(t.start);
    const finish = toDay(t.finish);
    const total = Math.max(1, workDaysBetween(start, finish, cal));
    const dayNo = on ? Math.min(total, workDaysBetween(start, on, cal)) : null;
    return {
      uid: t.uid, wbs: t.wbs, name: t.name, path: t.path, start: t.start, finish: t.finish,
      baselineStart: t.baselineStart, baselineFinish: t.baselineFinish, actualStart: t.actualStart,
      durationDays: t.durationDays, percent: t.percent, status: t.status, critical: t.critical, milestone: t.milestone,
      finishVarianceDays: t.finishVarianceDays, resources: t.resources,
      remainingDurationDays: t.remainingDurationDays ?? null, totalSlackDays: t.totalSlackDays ?? null, note: t.note ?? null,
      cost: t.cost ?? null, actualCost: t.actualCost ?? null, constraint: t.constraint ?? null,
      // Daily share: what is still to use, spread over the working days left from this day to the finish.
      materials: (t.materials || []).map((m) => {
        const left = Math.max(1, workDaysBetween(on && on > start ? on : start, finish, cal));
        return { ...m, perDay: Math.round((m.remainingQuantity / left) * 10) / 10 };
      }),
      predecessors: t.predecessors.map((p) => ({ ...p, name: byUid.get(p.uid)?.name ?? null, status: byUid.get(p.uid)?.status ?? null })),
      dayNo, totalDays: total,
      // Where the task should be by the end of this day if it runs evenly over its working days.
      expectedPercent: on ? Math.round((dayNo / total) * 100) : null,
      isStart: on ? start.getTime() === on.getTime() : false,
      isFinish: on ? finish.getTime() === on.getTime() : false,
    };
  };

  const days = [];
  for (let i = 0; i < span; i++) {
    const on = addDays(from, i);
    const list = work
      .filter((t) => toDay(t.start) <= on && toDay(t.finish) >= on)
      .sort((a, b) => Number(b.critical) - Number(a.critical) || toDay(a.finish) - toDay(b.finish))
      .map((t) => brief(t, on));
    days.push({
      date: on, workDay: isWorkDay(on, cal), holiday: cal.holidays.get(on.toISOString().slice(0, 10)) || null, tasks: list,
      starting: list.filter((t) => t.isStart).length, finishing: list.filter((t) => t.isFinish).length,
    });
  }
  const overdue = work.filter((t) => t.status === 'Overdue').sort((a, b) => toDay(a.finish) - toDay(b.finish)).map((t) => ({
    ...brief(t, null), daysLate: Math.round((now - toDay(t.finish)) / DAY_MS),
  }));
  const { tasks: _tasks, ...meta } = doc;
  res.json({ import: { ...meta, summary: fresh(doc).summary }, from, days, overdue, workDaysPerWeek: perWeek });
});

export default router;
