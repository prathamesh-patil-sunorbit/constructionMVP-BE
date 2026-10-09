// Day-by-day plinth plan that site engineers work through. Mounted behind requireAuth.
// Anyone signed in can read it; site engineers and managers can update it.

import mongoose from 'mongoose';
import { Router } from 'express';
import { PlinthDay } from '../models/index.js';
import { MANAGER_ROLES, HINDRANCE_TYPES } from '../models/constants.js';
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
  const { done, text, reason, reasonType, hoursLost } = req.body || {};
  let reasonChange = null;
  if (reason !== undefined) {
    const r = String(reason || '').trim().slice(0, 500);
    if (!r) {
      item.reason = undefined; item.reasonType = undefined; item.hoursLost = undefined; item.reasonByName = undefined; item.reasonAt = undefined;
      reasonChange = 'cleared';
    } else {
      if (reasonType !== undefined && !HINDRANCE_TYPES.includes(reasonType)) throw new HttpError(400, 'Choose one of the listed reasons');
      let hours;
      if (hoursLost !== undefined && hoursLost !== null && hoursLost !== '') {
        hours = Number(hoursLost);
        if (!Number.isFinite(hours) || hours < 0 || hours > 240) throw new HttpError(400, 'Hours lost must be between 0 and 240');
      }
      item.reason = r;
      item.reasonType = HINDRANCE_TYPES.includes(reasonType) ? reasonType : 'Other';
      item.hoursLost = hours;
      item.reasonByName = req.user.name;
      item.reasonAt = new Date();
      reasonChange = `${item.reasonType} — ${r}${hours ? ` (${hours} h lost)` : ''}`;
    }
  }
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
  if (reasonChange) {
    await audit(req.user, reasonChange === 'cleared' ? 'Plinth item reason removed' : 'Plinth item reason recorded', {
      entityType: 'PlinthDay', entityId: day._id, project: day.project, comment: `${describe(day)}: ${item.text}${reasonChange === 'cleared' ? '' : ` — ${reasonChange}`}`,
    });
  }
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

// What was really on site today: crew and machine counts that differ from the plan.
// Only trades and machines that are in the plan can be changed; the engineer cannot invent new ones here.
router.patch('/days/:id/actuals', canUpdate, async (req, res) => {
  const day = await loadDay(req.params.id);
  const { crew, machines } = req.body || {};
  const prev = { crew: day.actualCrew?.toObject?.() ?? day.actualCrew, machines: day.actualMachines?.toObject?.() ?? day.actualMachines };
  const count = (v, what) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 500) throw new HttpError(400, `${what}: enter a whole number from 0 to 500`);
    return n;
  };
  if (crew !== undefined) {
    if (crew === null) day.actualCrew = [];
    else {
      const plan = new Map(day.crew.map((c) => [c.trade, c.count]));
      const next = (Array.isArray(crew) ? crew : []).map((c) => {
        if (!plan.has(c.trade)) throw new HttpError(400, `${c.trade} is not in today's plan`);
        return { trade: c.trade, count: count(c.count, c.trade) };
      });
      // Keep the full list when anything differs from the plan, nothing when it all matches.
      const full = day.crew.map((c) => ({ trade: c.trade, count: next.find((n) => n.trade === c.trade)?.count ?? c.count }));
      day.actualCrew = full.some((c, i) => c.count !== day.crew[i].count) ? full : [];
    }
  }
  if (machines !== undefined) {
    if (machines === null) day.actualMachines = [];
    else {
      const plan = new Map(day.machines.map((m) => [m.name, m]));
      const next = (Array.isArray(machines) ? machines : []).map((m) => {
        if (!plan.has(m.name)) throw new HttpError(400, `${m.name} is not in today's plan`);
        return { name: m.name, count: count(m.count, m.name) };
      });
      const full = day.machines.map((m) => ({ name: m.name, kind: m.kind, count: next.find((n) => n.name === m.name)?.count ?? m.count }));
      day.actualMachines = full.some((m, i) => m.count !== day.machines[i].count) ? full : [];
    }
  }
  await save(day, req.user);
  await audit(req.user, 'Plinth day crew / machines changed', {
    entityType: 'PlinthDay', entityId: day._id, project: day.project, field: 'actualCrewMachines',
    previousValue: prev, newValue: { crew: day.actualCrew, machines: day.actualMachines }, comment: describe(day),
  });
  res.json(day);
});

export default router;
