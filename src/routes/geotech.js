// Plinth estimate from a geotechnical report. Mounted behind requireAuth.
// Site engineers are excluded: the estimate is a planning and management decision.

import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { Router } from 'express';
import multer from 'multer';
import { AiPrediction, GeotechReport, PlinthDay, Project } from '../models/index.js';
import { MANAGER_ROLES } from '../models/constants.js';
import { requireRole, HttpError } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { aiConfig, checkRateLimit, quotaStatus } from '../services/ai/gemini.js';
import { runGeotechAgent, learningSummary } from '../services/ai/geotech.js';
import { createPlan, replan, withdrawPlan } from '../services/plinth-plan.js';
import { readWeatherReport, weatherFor } from '../services/weather.js';
import { addDays, toDay, today } from '../utils/dates.js';
import { UPLOAD_DIR } from './activities.js';

const router = Router();
const GEOTECH_ROLES = [...MANAGER_ROLES, 'planning_engineer', 'estimation_engineer'];
router.use(requireRole(...GEOTECH_ROLES));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.-]+/g, '_')}`),
  }),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new HttpError(400, 'Upload the report as a PDF or an image'));
  },
});
// Turn multer's own errors (e.g. file too large) into 400s instead of 500s.
const multerErrors = (next) => (err) => {
  if (err instanceof multer.MulterError) return next(new HttpError(400, err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 12 MB' : err.message));
  next(err);
};
const uploadReport = (req, res, next) => upload.single('file')(req, res, multerErrors(next));
// New estimate: the soil report, plus an optional weather report for the rain buffer.
const uploadEstimate = (req, res, next) => upload.fields([{ name: 'file', maxCount: 1 }, { name: 'weather', maxCount: 1 }])(req, res, (err) => {
  if (!err) req.file = req.files?.file?.[0];
  multerErrors(next)(err);
});

function limitModelCalls(req, res, next) {
  if (!aiConfig().configured) return next();
  const { ok, retryInSec } = checkRateLimit(req.user._id);
  if (!ok) return res.status(429).json({ error: `AI rate limit reached. Try again in ${retryInSec}s.` });
  next();
}

async function parseInputs(body) {
  const { project } = body;
  if (!project || !mongoose.isValidObjectId(project) || !(await Project.exists({ _id: project }))) {
    throw new HttpError(400, 'A valid project is required');
  }
  let area = null;
  if (body.plinthAreaSqm !== undefined && body.plinthAreaSqm !== null && body.plinthAreaSqm !== '') {
    area = Number(body.plinthAreaSqm);
    if (!Number.isFinite(area) || area <= 0 || area > 100000) throw new HttpError(400, 'Plinth area must be between 1 and 100,000 m²');
  }
  let depth = null;
  if (body.depthM !== undefined && body.depthM !== null && body.depthM !== '') {
    depth = Number(body.depthM);
    if (!Number.isFinite(depth) || depth < 0.3 || depth > 15) throw new HttpError(400, 'Excavation depth must be between 0.3 and 15 m');
  }
  return { project, plinthAreaSqm: area, depthM: depth };
}

// Rain buffer from `startDate` (today until the estimate is accepted). If the weather cannot be
// worked out the estimate simply has no buffer; it is never blocked by it.
async function addWeather(report, startDate) {
  if (!report?.estimate) return report;
  try {
    report.weather = await weatherFor(report, { startDate });
    report.markModified('weather');
    await report.save();
  } catch (error) {
    console.info(`Weather buffer for ${report._id} failed: ${error.message}`);
  }
  return report;
}

// Read an uploaded weather report onto the report; it replaces any earlier one.
async function attachWeather(report, upload, user) {
  const read = await readWeatherReport({
    fileBase64: fs.readFileSync(upload.path).toString('base64'), mimeType: upload.mimetype, originalName: upload.originalname,
  });
  const previous = report.weatherUpload?.file?.filename;
  report.weatherUpload = {
    file: { originalName: upload.originalname, filename: upload.filename, url: `/uploads/${upload.filename}`, mimetype: upload.mimetype, size: upload.size },
    status: read.status, reason: read.reason, title: read.title, location: read.location, days: read.days || [], by: user._id, at: new Date(),
  };
  await report.save();
  if (previous && previous !== upload.filename) fs.rm(path.join(UPLOAD_DIR, path.basename(previous)), { force: true }, () => {});
  await audit(user, 'Weather report uploaded', {
    entityType: 'GeotechReport', entityId: report._id, project: report.project, comment: upload.originalname,
    newValue: { read: read.status, days: read.days?.length ?? 0 },
  });
  return read;
}

// Start of the schedule the buffer is laid on: the published plan's first day, else today.
async function scheduleStart(report) {
  if (report.verification?.status === 'Accepted') {
    const first = await PlinthDay.findOne({ report: report._id }).sort({ day: 1 }).lean();
    if (first) return first.date;
  }
  return today();
}

const populated = (id) => GeotechReport.findById(id)
  .populate('uploadedBy', 'name role').populate('verification.by', 'name role').populate('actual.recordedBy', 'name role')
  .populate('prediction', 'status override confidence').lean();

router.get('/', async (req, res) => {
  const { project } = req.query;
  if (!project) return res.status(400).json({ error: 'project is required' });
  const [reports, learning] = await Promise.all([
    GeotechReport.find({ project }).sort({ createdAt: -1 }).limit(20)
      .populate('uploadedBy', 'name role').populate('verification.by', 'name role').populate('actual.recordedBy', 'name role')
      .populate('prediction', 'status override confidence').lean(),
    learningSummary(),
  ]);
  res.json({ reports, learning, ai: { configured: aiConfig().configured, quota: quotaStatus() } });
});

router.post('/', uploadEstimate, limitModelCalls, async (req, res) => {
  const weather = req.files?.weather?.[0];
  try {
    if (!req.file) throw new HttpError(400, 'Attach the geotechnical report (PDF or image)');
    const inputs = await parseInputs(req.body);
    const file = {
      originalName: req.file.originalname, filename: req.file.filename, url: `/uploads/${req.file.filename}`,
      mimetype: req.file.mimetype, size: req.file.size,
      base64: fs.readFileSync(req.file.path).toString('base64'),
    };
    const report = await runGeotechAgent({ projectId: inputs.project, user: req.user, file, source: 'upload', ...inputs });
    // The weather report only matters once there is an estimate to put a buffer on.
    if (weather && report.estimate) await attachWeather(report, weather, req.user);
    else if (weather) fs.rm(weather.path, { force: true }, () => {});
    await addWeather(report, today());
    await audit(req.user, 'Geotechnical report uploaded', {
      entityType: 'GeotechReport', entityId: report._id, project: inputs.project,
      newValue: { plinthAreaSqm: inputs.plinthAreaSqm, depthM: inputs.depthM, read: report.extraction.status }, comment: file.originalName,
    });
    res.status(201).json(await populated(report._id));
  } catch (error) {
    // A rejected request should not leave an orphaned upload behind.
    if (req.file && !(await GeotechReport.exists({ 'file.filename': req.file.filename }))) fs.rm(req.file.path, { force: true }, () => {});
    if (weather && !(await GeotechReport.exists({ 'weatherUpload.file.filename': weather.filename }))) fs.rm(weather.path, { force: true }, () => {});
    throw error;
  }
});

router.post('/sample', limitModelCalls, async (req, res) => {
  const inputs = await parseInputs(req.body || {});
  const report = await addWeather(await runGeotechAgent({ projectId: inputs.project, user: req.user, source: 'sample', ...inputs }), today());
  await audit(req.user, 'Sample plinth estimate run', {
    entityType: 'GeotechReport', entityId: report._id, project: inputs.project, newValue: { plinthAreaSqm: inputs.plinthAreaSqm, depthM: inputs.depthM },
  });
  res.status(201).json(await populated(report._id));
});

// Re-read an uploaded report from the file already saved: one that could not be read (AI busy,
// quota, timeout), or a weak read (fewer than 3 of the 5 key facts) that nobody has decided on yet.
router.post('/:id/retry', limitModelCalls, async (req, res) => {
  const old = await GeotechReport.findById(req.params.id);
  if (!old) return res.status(404).json({ error: 'Report not found' });
  if (old.source !== 'upload' || !old.file?.filename) return res.status(400).json({ error: 'Only an uploaded report can be read again' });
  const weak = old.estimate && (old.extraction?.facts?.completeness?.found ?? 0) < 3;
  if (old.estimate && !weak) return res.status(400).json({ error: 'This report was read well; nothing to re-read' });
  if (old.estimate && old.verification?.status !== 'Pending') return res.status(400).json({ error: 'This estimate has already been accepted or rejected' });
  const filePath = path.join(UPLOAD_DIR, path.basename(old.file.filename));
  if (!fs.existsSync(filePath)) return res.status(410).json({ error: 'The saved file is no longer on the server. Upload it again.' });
  const file = { ...old.file.toObject(), base64: fs.readFileSync(filePath).toString('base64') };
  const report = await runGeotechAgent({
    projectId: old.project, user: req.user, file, source: 'upload',
    // Re-use the area only if the user typed it; a report or default area is worked out again.
    plinthAreaSqm: !old.inputs.areaSource || old.inputs.areaSource === 'user' ? old.inputs.plinthAreaSqm ?? null : null,
    depthM: old.inputs.depthM ?? null,
  });
  if (old.weatherUpload?.status) report.weatherUpload = old.weatherUpload.toObject();
  await addWeather(report, today());
  // The earlier attempt is replaced by the new one; its AiRun stays for the audit trail.
  if (old.prediction) await AiPrediction.deleteOne({ _id: old.prediction, status: 'Proposed' });
  await old.deleteOne();
  await audit(req.user, 'Geotechnical report re-read', {
    entityType: 'GeotechReport', entityId: report._id, project: report.project,
    previousValue: { report: old._id, reason: old.extraction?.reason }, newValue: { read: report.extraction.status }, comment: old.file.originalName,
  });
  res.status(201).json(await populated(report._id));
});

// Start date for the site plan when an estimate is accepted: today by default, up to two weeks
// back (work already under way) or three months ahead.
function planStart(value) {
  if (value === undefined || value === null || value === '') return today();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'Start date is not a valid date');
  const day = toDay(d);
  if (day < addDays(today(), -14) || day > addDays(today(), 90)) throw new HttpError(400, 'Start date must be within the last 14 days or the next 90 days');
  return day;
}

router.patch('/:id/verify', async (req, res) => {
  const { status, note } = req.body || {};
  if (!['Accepted', 'Rejected'].includes(status)) return res.status(400).json({ error: 'status must be Accepted or Rejected' });
  const startDate = status === 'Accepted' ? planStart(req.body?.startDate) : null;
  const report = await GeotechReport.findById(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  if (!report.estimate) return res.status(400).json({ error: 'This report was not read, so there is no estimate to verify' });
  const previous = report.verification?.status;
  report.verification = { status, note, by: req.user._id, at: new Date() };
  await report.save();
  if (report.prediction) {
    await AiPrediction.updateOne({ _id: report.prediction }, { $set: { status, decidedBy: req.user._id, decidedAt: new Date() } });
  }
  await audit(req.user, `Plinth estimate ${status.toLowerCase()}`, {
    entityType: 'GeotechReport', entityId: report._id, project: report.project, field: 'verification',
    previousValue: previous, newValue: status, comment: note,
  });
  // The rain buffer is laid on the chosen start date before the plan is built from it.
  if (status === 'Accepted') await addWeather(report, startDate);
  // Accepting puts the day-by-day plan in front of the site engineer; rejecting takes it back.
  const plan = status === 'Accepted'
    ? await createPlan(report, { startDate, user: req.user })
    : await withdrawPlan(report._id);
  if (plan.created) {
    await audit(req.user, 'Plinth plan published to site', {
      entityType: 'GeotechReport', entityId: report._id, project: report.project, newValue: { days: plan.created, start: startDate },
    });
  }
  res.json({ ...(await populated(report._id)), plan });
});

// ---------- Weather ----------

// Upload a weather report for the site. Its daily rain replaces the forecast on the days it covers.
router.post('/:id/weather', uploadReport, limitModelCalls, async (req, res) => {
  const report = await GeotechReport.findById(req.params.id);
  try {
    if (!report) throw new HttpError(404, 'Report not found');
    if (!report.estimate) throw new HttpError(400, 'This report has no estimate to add weather to');
    if (!req.file) throw new HttpError(400, 'Attach the weather report (PDF or image)');
  } catch (error) {
    if (req.file) fs.rm(req.file.path, { force: true }, () => {});
    throw error;
  }
  await attachWeather(report, req.file, req.user);
  await addWeather(report, await scheduleStart(report));
  const plan = await replan(report);
  res.json({ ...(await populated(report._id)), plan });
});

// Remove the uploaded weather report and go back to the forecast.
router.delete('/:id/weather', async (req, res) => {
  const report = await GeotechReport.findById(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  const filename = report.weatherUpload?.file?.filename;
  report.weatherUpload = undefined;
  await report.save();
  if (filename) fs.rm(path.join(UPLOAD_DIR, path.basename(filename)), { force: true }, () => {});
  await addWeather(report, await scheduleStart(report));
  const plan = await replan(report);
  await audit(req.user, 'Weather report removed', { entityType: 'GeotechReport', entityId: report._id, project: report.project });
  res.json({ ...(await populated(report._id)), plan });
});

// Fetch the latest forecast and work the buffer out again.
router.post('/:id/weather/refresh', async (req, res) => {
  const report = await GeotechReport.findById(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  if (!report.estimate) return res.status(400).json({ error: 'This report has no estimate' });
  await addWeather(report, await scheduleStart(report));
  const plan = await replan(report);
  res.json({ ...(await populated(report._id)), plan });
});

// What the job actually took. This is what the agent learns its JCB rate and schedule factor from.
router.patch('/:id/actuals', async (req, res) => {
  const report = await GeotechReport.findById(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  if (!report.estimate) return res.status(400).json({ error: 'This report has no estimate' });
  if (report.verification?.status === 'Rejected') return res.status(400).json({ error: 'Rejected estimates are not used for learning' });
  if (report.source === 'sample') return res.status(400).json({ error: 'Actuals cannot be recorded against the sample profile' });
  const excavationDays = Number(req.body?.excavationDays);
  const jcbCount = Number(req.body?.jcbCount);
  const totalDays = req.body?.totalDays === '' || req.body?.totalDays == null ? null : Number(req.body.totalDays);
  if (!Number.isFinite(excavationDays) || excavationDays <= 0 || excavationDays > 365) return res.status(400).json({ error: 'Actual excavation days must be between 1 and 365' });
  if (!Number.isInteger(jcbCount) || jcbCount < 1 || jcbCount > 20) return res.status(400).json({ error: 'Actual JCB count must be a whole number between 1 and 20' });
  if (totalDays !== null && (!Number.isFinite(totalDays) || totalDays < excavationDays || totalDays > 730)) {
    return res.status(400).json({ error: 'Actual total days must be at least the excavation days' });
  }
  const previous = report.actual?.excavationDays ? { ...report.actual.toObject?.() } : null;
  report.actual = { excavationDays, jcbCount, totalDays, note: req.body?.note, recordedBy: req.user._id, at: new Date() };
  await report.save();
  await audit(req.user, 'Plinth actuals recorded', {
    entityType: 'GeotechReport', entityId: report._id, project: report.project, field: 'actual',
    previousValue: previous && { excavationDays: previous.excavationDays, jcbCount: previous.jcbCount, totalDays: previous.totalDays },
    newValue: { excavationDays, jcbCount, totalDays }, comment: req.body?.note,
  });
  res.json(await populated(report._id));
});

export default router;
