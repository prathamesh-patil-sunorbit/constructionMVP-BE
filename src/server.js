import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { connectDb } from './config/db.js';
import { requireAuth } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import projectRoutes from './routes/projects.js';
import activityRoutes, { UPLOAD_DIR } from './routes/activities.js';
import dependencyRoutes from './routes/dependencies.js';
import blockerRoutes from './routes/blockers.js';
import insightRoutes from './routes/insights.js';
import integrationRoutes from './routes/integrations.js';
import aiRoutes from './routes/ai.js';
import buildingRoutes from './routes/building.js';
import planCheckRoutes from './routes/plan-check.js';
import resourceRoutes from './routes/resources.js';
import { evaluateAllProjects } from './services/engine.js';
import { hourlyAlertSweep, dailyAgentPass } from './services/ai/orchestrator.js';
import { BLOCKER_TYPES, BLOCKER_STATUSES, ACTIVITY_STATUSES, HEALTH_STATES, ROLES, SEVERITIES, PRIORITIES } from './models/constants.js';

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || true }));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));
app.use('/uploads', express.static(UPLOAD_DIR));

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/meta', (req, res) => res.json({
  roles: ROLES, blockerTypes: BLOCKER_TYPES, blockerStatuses: BLOCKER_STATUSES,
  activityStatuses: ACTIVITY_STATUSES, healthStates: HEALTH_STATES, severities: SEVERITIES, priorities: PRIORITIES,
}));
app.use('/api/auth', authRoutes);
app.use('/api/users', requireAuth, userRoutes);
app.use('/api/projects', requireAuth, projectRoutes);
app.use('/api/activities', requireAuth, activityRoutes);
app.use('/api/dependencies', requireAuth, dependencyRoutes);
app.use('/api/blockers', requireAuth, blockerRoutes);
app.use('/api/integrations', integrationRoutes);
app.use('/api/ai', requireAuth, aiRoutes);
app.use('/api/building', requireAuth, buildingRoutes);
app.use('/api/plans', requireAuth, planCheckRoutes);
app.use('/api/resources', requireAuth, resourceRoutes);
app.use('/api', requireAuth, insightRoutes);

app.use((err, req, res, next) => {
  const status = err.status || (err.name === 'ValidationError' || err.name === 'CastError' ? 400 : err.code === 11000 ? 409 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.code === 11000 ? 'Duplicate value' : err.message || 'Server error' });
});

const port = Number(process.env.PORT) || 4000;
await connectDb();
app.listen(port, (err) => {
  if (err) {
    console.error(`Could not start API on port ${port}: ${err.message}`);
    process.exit(1);
  }
  console.log(`API listening on http://localhost:${port}`);
});

// Planned progress moves with the calendar, so re-run the rules engine periodically. The AI
// sweep that follows is deterministic (no model calls); narration runs once a day after 18:00.
const tick = async () => {
  try {
    await evaluateAllProjects();
    await hourlyAlertSweep();
    await dailyAgentPass({ hour: Number(process.env.AI_DAILY_HOUR) || 18 });
  } catch (e) {
    console.error('Scheduled evaluation failed', e);
  }
};
tick();
setInterval(tick, 60 * 60 * 1000);
