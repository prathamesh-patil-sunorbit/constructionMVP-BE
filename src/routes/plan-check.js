import { Router } from 'express';
import { runPlanCheck } from '../services/plan-check.js';

const router = Router();

router.get('/city-life', (req, res) => {
  res.json(runPlanCheck());
});

export default router;
