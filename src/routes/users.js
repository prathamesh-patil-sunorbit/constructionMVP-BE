import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { User } from '../models/index.js';
import { requireRole } from '../middleware/auth.js';
import { HIDDEN_ROLES } from '../models/constants.js';
import { audit } from '../services/audit.js';

const router = Router();

router.get('/', async (req, res) => {
  const filter = { role: { $nin: HIDDEN_ROLES, ...(req.query.role ? { $eq: req.query.role } : {}) } };
  res.json(await User.find(filter).sort({ role: 1, name: 1 }));
});

router.post('/', requireRole('admin'), async (req, res) => {
  const { name, email, password, role, phone } = req.body;
  if (!name || !email || !password || !role) return res.status(400).json({ error: 'name, email, password and role are required' });
  const user = await User.create({ name, email, role, phone, passwordHash: await bcrypt.hash(password, 10) });
  await audit(req.user, 'User created', { entityType: 'User', entityId: user._id, newValue: { name, email, role } });
  res.status(201).json(user);
});

router.patch('/:id', requireRole('admin'), async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const before = { name: user.name, role: user.role, active: user.active };
  for (const f of ['name', 'role', 'phone', 'active']) if (req.body[f] !== undefined) user[f] = req.body[f];
  if (req.body.password) user.passwordHash = await bcrypt.hash(req.body.password, 10);
  await user.save();
  await audit(req.user, 'User updated', {
    entityType: 'User', entityId: user._id, previousValue: before,
    newValue: { name: user.name, role: user.role, active: user.active },
  });
  res.json(user);
});

export default router;
