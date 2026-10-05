// 3D / 4D model endpoints. Geometry is generated server-side so the viewer only renders.

import { Router } from 'express';
import { BuildingSpec } from '../models/index.js';
import { MANAGER_ROLES } from '../models/constants.js';
import { requireRole } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { buildModel, DEFAULTS } from '../services/building.js';

const router = Router();

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

export default router;
