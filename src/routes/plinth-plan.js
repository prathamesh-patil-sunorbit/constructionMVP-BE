// Day-by-day plinth plan that site engineers work through. Mounted behind requireAuth.
// Anyone signed in can read it; site engineers and managers can update it.

import mongoose from 'mongoose';
import { Router } from 'express';
import { PlinthDay } from '../models/index.js';
import { MANAGER_ROLES } from '../models/constants.js';
import { requireRole, HttpError } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { dayStatus, listPlans } from '../services/plinth-plan.js';

const router = Router();
const canUpdate = requireRole(...MANAGER_ROLES, 'site_engineer');

router.get('/', async (req, res) => {
  const { project } = req.query;
  if (project && !mongoose.isValidObjectId(project)) throw new HttpError(400, 'Invalid project');
  res.json({ plans: await listPlans({ project: project || undefined }) });
});

async function loadDay(id) {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'Day not found');
  const day = await PlinthDay.findById(id);
  if (!day) throw new HttpError(404, 'Day not found');
  return day;
}

// Save a change and keep the day's status in step with its checklist.
async function save(day, user) {
  const before = day.status;
  day.status = dayStatus(day.items);
  day.completedAt = day.status === 'Done' ? (day.completedAt || new Date()) : null;
  day.updatedBy = user._id;
  await day.save();
  return before;
}

const describe = (day) => `Day ${day.day} · ${day.phaseName}`;

// Actual quantity and a note for the day.
router.patch('/days/:id', canUpdate, async (req, res) => {
  const day = await loadDay(req.params.id);
  const { actualQuantity, note } = req.body || {};
  const prev = { actualQuantity: day.actualQuantity, note: day.note };
  if (actualQuantity !== undefined) {
    if (actualQuantity === null || actualQuantity === '') day.actualQuantity = undefined;
    else {
      const q = Number(actualQuantity);
      if (!Number.isFinite(q) || q < 0 || q > 1_000_000) throw new HttpError(400, 'Actual quantity must be a number of 0 or more');
      day.actualQuantity = q;
    }
  }
  if (note !== undefined) day.note = String(note || '').trim().slice(0, 1000) || undefined;
  await save(day, req.user);
  await audit(req.user, 'Plinth day updated', {
    entityType: 'PlinthDay', entityId: day._id, project: day.project, field: 'actual',
    previousValue: prev, newValue: { actualQuantity: day.actualQuantity, note: day.note }, comment: describe(day),
  });
  res.json(day);
});

// Tick or untick one item.
router.patch('/days/:id/items/:itemId', canUpdate, async (req, res) => {
  const day = await loadDay(req.params.id);
  const item = day.items.id(req.params.itemId);
  if (!item) throw new HttpError(404, 'Item not found');
  const { done, text } = req.body || {};
  if (done !== undefined) {
    item.done = Boolean(done);
    item.doneBy = item.done ? req.user._id : undefined;
    item.doneAt = item.done ? new Date() : undefined;
  }
  if (text !== undefined) {
    if (item.source !== 'added') throw new HttpError(400, 'Only items you added can be reworded');
    const t = String(text).trim().slice(0, 200);
    if (!t) throw new HttpError(400, 'Item text is required');
    item.text = t;
  }
  const before = await save(day, req.user);
  if (done !== undefined) {
    await audit(req.user, item.done ? 'Plinth item done' : 'Plinth item reopened', {
      entityType: 'PlinthDay', entityId: day._id, project: day.project, comment: `${describe(day)}: ${item.text}`,
    });
  }
  if (before !== day.status && day.status === 'Done') {
    await audit(req.user, 'Plinth day completed', { entityType: 'PlinthDay', entityId: day._id, project: day.project, comment: describe(day) });
  }
  res.json(day);
});

// Add a checklist item of your own.
router.post('/days/:id/items', canUpdate, async (req, res) => {
  const day = await loadDay(req.params.id);
  const text = String(req.body?.text || '').trim().slice(0, 200);
  if (!text) throw new HttpError(400, 'Item text is required');
  if (day.items.length >= 40) throw new HttpError(400, 'A day can have at most 40 checklist items');
  day.items.push({ text, source: 'added', addedBy: req.user._id, done: false });
  await save(day, req.user);
  await audit(req.user, 'Plinth item added', { entityType: 'PlinthDay', entityId: day._id, project: day.project, comment: `${describe(day)}: ${text}` });
  res.status(201).json(day);
});

// Remove an item you added (planned items stay; tick them instead).
router.delete('/days/:id/items/:itemId', canUpdate, async (req, res) => {
  const day = await loadDay(req.params.id);
  const item = day.items.id(req.params.itemId);
  if (!item) throw new HttpError(404, 'Item not found');
  if (item.source !== 'added') throw new HttpError(400, 'Planned items cannot be removed; tick them off instead');
  const text = item.text;
  item.deleteOne();
  await save(day, req.user);
  await audit(req.user, 'Plinth item removed', { entityType: 'PlinthDay', entityId: day._id, project: day.project, comment: `${describe(day)}: ${text}` });
  res.json(day);
});

// Tick everything that is left on the day.
router.post('/days/:id/complete', canUpdate, async (req, res) => {
  const day = await loadDay(req.params.id);
  const now = new Date();
  for (const item of day.items) {
    if (!item.done) { item.done = true; item.doneBy = req.user._id; item.doneAt = now; }
  }
  const before = await save(day, req.user);
  if (before !== 'Done') {
    await audit(req.user, 'Plinth day completed', { entityType: 'PlinthDay', entityId: day._id, project: day.project, comment: describe(day) });
  }
  res.json(day);
});

export default router;
