// 3D / 4D model endpoints. Geometry is generated server-side so the viewer only renders.

import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { Router } from 'express';
import multer from 'multer';
import { BuildingSpec, Project } from '../models/index.js';
import { MANAGER_ROLES } from '../models/constants.js';
import { requireRole, HttpError } from '../middleware/auth.js';
import { importDrawing } from '../services/floorplan/index.js';
import { UPLOAD_DIR } from './activities.js';
import { audit } from '../services/audit.js';
import { buildModel, DEFAULTS } from '../services/building.js';

const router = Router();

const PLAN_DIR = path.join(UPLOAD_DIR, 'floorplans');
fs.mkdirSync(PLAN_DIR, { recursive: true });
const PLAN_ROLES = [...MANAGER_ROLES, 'planning_engineer'];
const upload = multer({
  storage: multer.diskStorage({
    destination: PLAN_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.-]+/g, '_')}`),
  }),
  limits: { fileSize: 40 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(dwg|dxf)$/i.test(file.originalname)) return cb(null, true);
    cb(new HttpError(400, 'Upload the floor plan as a DWG or DXF file'));
  },
});
const uploadPlan = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (err instanceof multer.MulterError) return next(new HttpError(400, err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 40 MB' : err.message));
  next(err);
});

const SPEC_FIELDS = [
  'plateAreaSqm', 'aspectRatio', 'floorHeightM', 'slabThicknessM', 'columnSizeM', 'wallThicknessM',
  'baysX', 'baysZ', 'floorsBelow', 'balconySide', 'balconyDepthM', 'hasParking', 'towerGapM', 'wallColor', 'notes',
];

router.get('/projects/:id/model', async (req, res) => {
  res.json(await buildModel(req.params.id));
});

router.get('/defaults', (req, res) => res.json({ defaults: DEFAULTS, fields: SPEC_FIELDS }));

// Managers and planning engineers can tune the parameters; everything else stays derived.
router.put('/projects/:id/spec', requireRole(...MANAGER_ROLES, 'planning_engineer'), async (req, res) => {
  const update = {};
  for (const f of SPEC_FIELDS) {
    if (req.body[f] === undefined) continue;
    // An empty value clears the override so the figure goes back to being derived.
    update[f] = req.body[f] === '' || req.body[f] === null ? null : req.body[f];
  }
  const before = await BuildingSpec.findOne({ project: req.params.id }).lean();
  const spec = await BuildingSpec.findOneAndUpdate(
    { project: req.params.id },
    { $set: { ...update, project: req.params.id, updatedBy: req.user._id } },
    { new: true, upsert: true, runValidators: true },
  );
  await audit(req.user, 'Building model parameters updated', {
    entityType: 'BuildingSpec', entityId: spec._id, project: req.params.id,
    previousValue: before || null, newValue: update, comment: req.body.notes,
  });
  res.json(await buildModel(req.params.id));
});

router.delete('/projects/:id/spec', requireRole(...MANAGER_ROLES, 'planning_engineer'), async (req, res) => {
  await BuildingSpec.deleteOne({ project: req.params.id });
  await audit(req.user, 'Building model parameters reset', { entityType: 'BuildingSpec', project: req.params.id });
  res.json(await buildModel(req.params.id));
});

// Upload a DWG / DXF floor plan. The drawing is interpreted once and the result stored on the
// project's building spec; the 3D model is then generated from it instead of the default massing.
router.post('/projects/:id/floorplan', requireRole(...PLAN_ROLES), uploadPlan, async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id) || !(await Project.exists({ _id: id }))) throw new HttpError(404, 'Project not found');
  if (!req.file) throw new HttpError(400, 'Choose a DWG or DXF file to upload');
  const discard = () => fs.promises.rm(req.file.path, { force: true }).catch(() => {});
  const floorCount = req.body.floorCount ? Math.round(Number(req.body.floorCount)) : null;
  if (floorCount !== null && (!Number.isFinite(floorCount) || floorCount < 1 || floorCount > 120)) {
    await discard();
    throw new HttpError(400, 'Floors must be between 1 and 120');
  }
  let result;
  try {
    result = await importDrawing(req.file.path);
  } catch (e) {
    await discard();
    throw e.status ? new HttpError(e.status, e.message) : e;
  }
  const floorplan = {
    source: {
      originalName: req.file.originalname,
      filename: req.file.filename,
      url: `/uploads/floorplans/${req.file.filename}`,
      uploadedAt: new Date(),
      uploadedBy: req.user._id,
    },
    plans: result.plans,
    floors: result.floors,
    floorCount,
    stats: result.stats,
    skipped: result.skipped,
  };
  const before = await BuildingSpec.findOne({ project: id }, 'floorplan.source').lean();
  await BuildingSpec.findOneAndUpdate(
    { project: id },
    { $set: { floorplan, project: id, updatedBy: req.user._id } },
    { new: true, upsert: true },
  );
  await audit(req.user, 'Floor plan imported for 3D model', {
    entityType: 'BuildingSpec', project: id,
    previousValue: before?.floorplan?.source?.originalName || null,
    newValue: { file: req.file.originalname, stats: result.stats },
  });
  res.status(201).json(await buildModel(id));
});

router.delete('/projects/:id/floorplan', requireRole(...PLAN_ROLES), async (req, res) => {
  await BuildingSpec.updateOne({ project: req.params.id }, { $unset: { floorplan: 1 } });
  await audit(req.user, 'Imported floor plan removed from 3D model', { entityType: 'BuildingSpec', project: req.params.id });
  res.json(await buildModel(req.params.id));
});

export default router;
