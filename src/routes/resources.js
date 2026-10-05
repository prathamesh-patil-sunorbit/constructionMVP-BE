// Labour attendance, inventory, daily site reports and camera observations.
// Mounted behind requireAuth. None of these routes talk to Gemini except camera analyse
// and the optional site-report summary, which go through the backend AI services.

import fs from 'node:fs';
import { Router } from 'express';
import multer from 'multer';
import {
  InventoryItem, InventoryTxn, LabourAttendance, SiteReport, CameraObservation,
  Activity, Estimate, ExecutionLog,
} from '../models/index.js';
import { MANAGER_ROLES, INVENTORY_TXN_TYPES, LABOUR_CATEGORIES } from '../models/constants.js';
import { requireRole } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { today, toDay } from '../utils/dates.js';
import { onProjectEvent } from '../services/ai/orchestrator.js';
import { dailySummary } from '../services/ai/analytics.js';
import { analyseSitePhoto } from '../services/ai/vision.js';
import { loadDemoCameras } from '../services/ai/demo-camera.js';
import { askGemini, aiConfig } from '../services/ai/gemini.js';
import { AGENTS } from '../services/ai/agents.js';
import { UPLOAD_DIR } from './activities.js';

const router = Router();
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.-]+/g, '_')}`),
  }),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files are accepted'));
    cb(null, true);
  },
});

// ---------- Inventory ----------
router.get('/inventory', async (req, res) => {
  const project = req.query.project;
  if (!project) return res.status(400).json({ error: 'project is required' });
  const [items, txns] = await Promise.all([
    InventoryItem.find({ project }).sort({ name: 1 }).lean(),
    InventoryTxn.find({ project }).sort({ date: -1, createdAt: -1 }).limit(80)
      .populate('recordedBy', 'name').populate('activity', 'code name').populate('item', 'name unit').lean(),
  ]);
  res.json({ items, transactions: txns });
});

router.post('/inventory', requireRole(...MANAGER_ROLES, 'estimation_engineer'), async (req, res) => {
  const { project, name, unit, stock = 0, minStock = 0, reorderLevel = 0, supplier, notes } = req.body || {};
  if (!project || !name || !unit) return res.status(400).json({ error: 'project, name and unit are required' });
  const item = await InventoryItem.create({
    project, name: String(name).trim(), unit, stock: Number(stock) || 0,
    minStock: Number(minStock) || 0, reorderLevel: Number(reorderLevel) || 0, supplier, notes,
  });
  if (Number(stock) > 0) {
    await InventoryTxn.create({
      project, item: item._id, type: 'opening', quantity: Number(stock), date: today(),
      recordedBy: req.user._id, note: 'Opening stock',
    });
  }
  await audit(req.user, 'Inventory item created', { entityType: 'InventoryItem', entityId: item._id, project, newValue: { name, stock } });
  res.status(201).json(item);
});

router.patch('/inventory/:id', requireRole(...MANAGER_ROLES, 'estimation_engineer'), async (req, res) => {
  const item = await InventoryItem.findById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  for (const f of ['name', 'unit', 'minStock', 'reorderLevel', 'supplier', 'notes']) {
    if (req.body[f] !== undefined) item[f] = req.body[f];
  }
  await item.save();
  res.json(item);
});

router.post('/inventory/:id/txn', requireRole(...MANAGER_ROLES, 'estimation_engineer', 'site_engineer', 'site_manager'), async (req, res) => {
  const item = await InventoryItem.findById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const { type, quantity, date, activity, supplier, note } = req.body || {};
  if (!INVENTORY_TXN_TYPES.includes(type)) return res.status(400).json({ error: `type must be one of ${INVENTORY_TXN_TYPES.join(', ')}` });
  const qty = Number(quantity);
  if (!qty || qty <= 0) return res.status(400).json({ error: 'quantity must be greater than 0' });
  const signed = type === 'consumed' || type === 'wastage' ? -qty : type === 'adjustment' ? qty : qty;
  item.stock = Math.max(0, (item.stock || 0) + signed);
  await item.save();
  const txn = await InventoryTxn.create({
    project: item.project, item: item._id, type, quantity: qty, date: toDay(date || today()),
    activity, supplier, note, recordedBy: req.user._id,
  });
  await audit(req.user, `Inventory ${type}`, {
    entityType: 'InventoryTxn', entityId: txn._id, project: item.project, activity, newValue: { name: item.name, quantity: qty, stock: item.stock },
  });
  onProjectEvent(item.project, { reason: `Inventory ${type} on ${item.name}` });
  res.status(201).json({ item, txn });
});

// Create empty catalogue rows from estimate material names (stock stays 0).
router.post('/inventory/from-estimates', requireRole(...MANAGER_ROLES, 'estimation_engineer'), async (req, res) => {
  const project = req.body?.project;
  if (!project) return res.status(400).json({ error: 'project is required' });
  const estimates = await Estimate.find({ project }).lean();
  const names = new Map();
  for (const e of estimates) {
    for (const m of e.materials || []) {
      if (m.name && !names.has(m.name.toLowerCase())) names.set(m.name.toLowerCase(), { name: m.name, unit: m.unit || 'unit' });
    }
  }
  let created = 0;
  for (const { name, unit } of names.values()) {
    const existing = await InventoryItem.findOne({ project, name });
    if (existing) continue;
    await InventoryItem.create({ project, name, unit, stock: 0, minStock: 0, reorderLevel: 0, source: 'estimate' });
    created += 1;
  }
  res.json({ created, catalogueSize: names.size });
});

// ---------- Attendance ----------
router.get('/attendance', async (req, res) => {
  const project = req.query.project;
  if (!project) return res.status(400).json({ error: 'project is required' });
  const filter = { project };
  if (req.query.date) filter.date = toDay(req.query.date);
  const rows = await LabourAttendance.find(filter).populate('reportedBy', 'name').populate('activity', 'code name')
    .sort({ date: -1, trade: 1 }).limit(200).lean();
  res.json(rows);
});

router.post('/attendance', requireRole(...MANAGER_ROLES, 'site_engineer'), async (req, res) => {
  const { project, date, trade, category, contractor, planned, present, checkIn, checkOut, activity } = req.body || {};
  if (!project || !trade) return res.status(400).json({ error: 'project and trade are required' });
  if (category && !LABOUR_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of ${LABOUR_CATEGORIES.join(', ')}` });
  }
  const row = await LabourAttendance.findOneAndUpdate(
    { project, date: toDay(date || today()), trade, contractor: contractor || null },
    {
      $set: {
        category: category || 'Skilled', planned: Number(planned) || 0, present: Number(present) || 0,
        checkIn, checkOut, activity, reportedBy: req.user._id,
      },
    },
    { new: true, upsert: true, runValidators: true },
  );
  await audit(req.user, 'Labour attendance recorded', {
    entityType: 'LabourAttendance', entityId: row._id, project, newValue: { trade, present, date: date || today() },
  });
  onProjectEvent(project, { reason: `Attendance for ${trade}` });
  res.status(201).json(row);
});

// Copy latest execution-log manpower into today's attendance (no invented numbers).
router.post('/attendance/from-execution', requireRole(...MANAGER_ROLES, 'site_engineer'), async (req, res) => {
  const project = req.body?.project;
  if (!project) return res.status(400).json({ error: 'project is required' });
  const logs = await ExecutionLog.find({ project }).sort({ date: -1 }).limit(40).lean();
  if (!logs.length) return res.status(400).json({ error: 'No execution reports exist to copy from.' });
  const latest = logs[0].date;
  const dayLogs = logs.filter((l) => String(l.date) === String(latest));
  const byTrade = new Map();
  for (const l of dayLogs) {
    for (const m of l.manpower || []) {
      const row = byTrade.get(m.trade) || { trade: m.trade, planned: 0, present: 0 };
      row.planned += m.planned || 0;
      row.present += m.actual || 0;
      byTrade.set(m.trade, row);
    }
  }
  const created = [];
  for (const r of byTrade.values()) {
    created.push(await LabourAttendance.findOneAndUpdate(
      { project, date: toDay(req.body.date || today()), trade: r.trade, contractor: null },
      { $set: { planned: r.planned, present: r.present, reportedBy: req.user._id, source: 'execution' } },
      { new: true, upsert: true },
    ));
  }
  res.json({ sourceDate: latest, rows: created });
});

// ---------- Site reports ----------
router.get('/site-reports', async (req, res) => {
  const project = req.query.project;
  if (!project) return res.status(400).json({ error: 'project is required' });
  res.json(await SiteReport.find({ project }).sort({ date: -1 }).limit(60)
    .populate('reportedBy', 'name role').lean());
});

router.post('/site-reports', requireRole(...MANAGER_ROLES, 'site_engineer'), async (req, res) => {
  const project = req.body?.project;
  if (!project) return res.status(400).json({ error: 'project is required' });
  const date = toDay(req.body.date || today());
  const doc = await SiteReport.findOneAndUpdate(
    { project, date, reportedBy: req.user._id },
    {
      $set: {
        workCompleted: req.body.workCompleted || [],
        labour: req.body.labour || [],
        materialsReceived: req.body.materialsReceived || [],
        materialsConsumed: req.body.materialsConsumed || [],
        equipment: req.body.equipment || [],
        weather: req.body.weather, issues: req.body.issues, remarks: req.body.remarks,
      },
    },
    { new: true, upsert: true, runValidators: true },
  );

  for (const row of doc.labour || []) {
    if (!row.trade) continue;
    await LabourAttendance.findOneAndUpdate(
      { project, date, trade: row.trade, contractor: null },
      { $set: { category: row.category || 'Skilled', planned: row.planned || 0, present: row.present || 0, reportedBy: req.user._id, source: 'site_report' } },
      { upsert: true },
    );
  }
  for (const m of doc.materialsReceived || []) {
    if (!m.name || !m.quantity) continue;
    let item = await InventoryItem.findOne({ project, name: m.name });
    if (!item) item = await InventoryItem.create({ project, name: m.name, unit: m.unit || 'unit', stock: 0, source: 'site_report' });
    item.stock += m.quantity;
    await item.save();
    await InventoryTxn.create({ project, item: item._id, type: 'received', quantity: m.quantity, date, recordedBy: req.user._id, source: 'site_report' });
  }
  for (const m of doc.materialsConsumed || []) {
    if (!m.name || !m.quantity) continue;
    let item = await InventoryItem.findOne({ project, name: m.name });
    if (!item) item = await InventoryItem.create({ project, name: m.name, unit: m.unit || 'unit', stock: 0, source: 'site_report' });
    item.stock = Math.max(0, item.stock - m.quantity);
    await item.save();
    await InventoryTxn.create({ project, item: item._id, type: 'consumed', quantity: m.quantity, date, recordedBy: req.user._id, source: 'site_report' });
  }

  const summary = await dailySummary(project, date);
  let aiSummary = { aiGenerated: false, headline: `${summary.labour.present} workers reported, ${summary.progressUpdates.length} progress update(s).` };
  if (aiConfig().configured) {
    try {
      const resGemini = await askGemini({
        system: AGENTS.progress.system,
        payload: { daily: summary, remarks: doc.remarks, issues: doc.issues, weather: doc.weather },
        schema: AGENTS.progress.schema,
      });
      aiSummary = { aiGenerated: true, ...resGemini.data };
    } catch { /* keep deterministic headline */ }
  }
  doc.aiSummary = aiSummary;
  await doc.save();
  await audit(req.user, 'Site report submitted', { entityType: 'SiteReport', entityId: doc._id, project, comment: req.body.remarks });
  onProjectEvent(project, { reason: 'Site report submitted' });
  res.status(201).json(doc);
});

// ---------- Camera ----------
router.get('/camera', async (req, res) => {
  const project = req.query.project;
  if (!project) return res.status(400).json({ error: 'project is required' });
  res.json(await CameraObservation.find({ project }).sort({ createdAt: -1 }).limit(40)
    .populate('uploadedBy', 'name').populate('activity', 'code name')
    .populate('verification.by', 'name').lean());
});

router.post('/camera/demo', requireRole(...MANAGER_ROLES, 'site_engineer'), async (req, res) => {
  const project = req.body?.project || req.query.project;
  if (!project) return res.status(400).json({ error: 'project is required' });
  const created = await loadDemoCameras(project, req.user);
  await audit(req.user, 'Demo camera stills loaded', {
    entityType: 'CameraObservation', project, comment: `${created.length} sample photographs`,
  });
  res.status(201).json({ created: created.length });
});

router.post('/camera', requireRole(...MANAGER_ROLES, 'site_engineer'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'image file is required' });
  const project = req.body.project;
  if (!project) return res.status(400).json({ error: 'project is required' });
  const activity = req.body.activity ? await Activity.findById(req.body.activity).lean() : null;
  const previous = await CameraObservation.findOne({ project, activity: activity?._id || null }).sort({ createdAt: -1 });
  const imageBase64 = fs.readFileSync(req.file.path).toString('base64');
  let analysis;
  try {
    analysis = await analyseSitePhoto({
      imageBase64, mimeType: req.file.mimetype, caption: req.body.caption, activity, previous,
    });
  } catch (error) {
    analysis = { insufficientData: true, reason: error.message, aiGenerated: true };
  }
  const obs = await CameraObservation.create({
    project, activity: activity?._id, uploadedBy: req.user._id,
    originalName: req.file.originalname, filename: req.file.filename,
    url: `/uploads/${req.file.filename}`, mimetype: req.file.mimetype,
    caption: req.body.caption, previous: previous?._id, analysis,
    source: req.body.source || 'upload',
  });
  await audit(req.user, 'Camera observation uploaded', { entityType: 'CameraObservation', entityId: obs._id, project, activity: activity?._id });
  res.status(201).json(obs);
});

router.patch('/camera/:id/verify', requireRole(...MANAGER_ROLES, 'site_engineer'), async (req, res) => {
  const obs = await CameraObservation.findById(req.params.id);
  if (!obs) return res.status(404).json({ error: 'Observation not found' });
  const { status, note, edited } = req.body || {};
  if (!['Accepted', 'Rejected', 'Edited'].includes(status)) {
    return res.status(400).json({ error: 'status must be Accepted, Rejected or Edited' });
  }
  obs.verification = { status, note, edited: edited || null, by: req.user._id, at: new Date() };
  await obs.save();
  await audit(req.user, `Camera observation ${status.toLowerCase()}`, {
    entityType: 'CameraObservation', entityId: obs._id, project: obs.project, comment: note,
  });
  res.json(obs);
});

export default router;
