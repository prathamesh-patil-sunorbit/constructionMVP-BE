// Seeds the MVP sample scenario (doc section 24):
// Krisala Project A -> Tower A -> Floors 17, 18, 19
// Chain per floor: Column -> Reinforcement -> Formwork -> MEP Sleeves -> Concrete -> Curing -> Blockwork
// plus Floor N Concrete -> Floor N+1 Column. Dates are relative to today so the demo always looks live.
// Team data (planning / estimation / execution) is pulled via the Colab connector; site-level
// data (progress, blockers, comments) is entered here as engineers would in the app.
import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { connectDb } from '../src/config/db.js';
import {
  User, Project, StructureNode, Activity, Dependency, ProgressUpdate, Blocker, Risk, Escalation,
  Notification, Comment, Attachment, AuditLog, Setting, Team, Estimate, ExecutionLog, IntegrationSync, GeotechReport, PlinthDay,
} from '../src/models/index.js';
import { evaluateProject, plannedProgressOn } from '../src/services/engine.js';
import { DEFAULT_RULES } from '../src/services/settings.js';
import { syncFromColab } from '../src/integrations/importer.js';
import { today, addDays } from '../src/utils/dates.js';

await connectDb();
await Promise.all([User, Project, StructureNode, Activity, Dependency, ProgressUpdate, Blocker, Risk, Escalation,
  Notification, Comment, Attachment, AuditLog, Setting, Team, Estimate, ExecutionLog, IntegrationSync, GeotechReport, PlinthDay].map((m) => m.deleteMany({})));

const T = today();
const d = (offset) => addDays(T, offset);
const passwordHash = await bcrypt.hash('password123', 10);

const [, pm, sm, rahul] = await User.create([
  { name: 'Admin User', email: 'admin@krisala.test', role: 'admin', passwordHash },
  { name: 'Priya Deshmukh', email: 'pm@krisala.test', role: 'project_manager', passwordHash },
  { name: 'Amit Kulkarni', email: 'sm@krisala.test', role: 'site_manager', passwordHash },
  { name: 'Rahul Shinde', email: 'engineer@krisala.test', role: 'site_engineer', passwordHash },
  { name: 'Sneha Joshi', email: 'engineer2@krisala.test', role: 'site_engineer', passwordHash },
  { name: 'Neha Kale', email: 'planning@krisala.test', role: 'planning_engineer', passwordHash },
  { name: 'Vikram Rao', email: 'estimation@krisala.test', role: 'estimation_engineer', passwordHash },
]);

await Setting.create({ key: 'rules', value: DEFAULT_RULES });

const project = await Project.create({
  code: 'KRS-A', name: 'Krisala Project A', location: 'Pune, Maharashtra', projectType: 'Residential High-rise',
  startDate: d(-30), plannedCompletionDate: d(180), status: 'Active', projectManager: pm._id, siteManager: sm._id,
});

// Planning, estimation and execution team data comes from Colab (mock feed unless COLAB_API_URL is set).
// The sync creates Tower A / Floors 17-19, the activity schedule with baselines, dependencies,
// BOQ estimates with planned resources, and daily execution reports.
const sync = await syncFromColab(project._id, { types: ['teams', 'planning', 'estimation', 'execution'], evaluate: false });
console.log(`Colab sync: ${sync.status}`, JSON.stringify(sync.stats));
if (sync.errorMessages.length) console.log('Sync warnings:', sync.errorMessages);

const acts = {};
for (const a of await Activity.find({ project: project._id })) acts[a.code.replace(/^TA-F/, '')] = a;

// Ground-level activity added on site, not part of the Colab plan.
const floor17 = await StructureNode.findOne({ project: project._id, name: 'Floor 17' });
acts['17-ELE'] = await Activity.create({
  code: 'TA-F17-ELE', name: 'Electrical Conduiting', project: project._id, structureNode: floor17._id,
  wbs: '1.1.9', plannedStart: d(-1), plannedFinish: d(1), plannedDuration: 3, plannedQuantity: 600, unit: 'rmt',
  responsible: rahul._id, priority: 'Medium', source: 'manual',
});
await Dependency.create({ project: project._id, predecessor: acts['17-CUR']._id, successor: acts['17-ELE']._id, type: 'FS' });

// Progress history: [activityKey, dayOffset, actual%, comment?, status?]
const HISTORY = [
  ['17-COL', -18, 50], ['17-COL', -17, 100],
  ['17-RNF', -16, 35], ['17-RNF', -15, 70], ['17-RNF', -14, 100],
  ['17-FWK', -13, 50], ['17-FWK', -12, 100],
  ['17-MEP', -11, 100], ['17-CON', -10, 100, 'Pour completed, cubes taken'],
  ['17-CUR', -9, 33], ['17-CUR', -8, 66, 'Water supply interrupted for 2 hours'], ['17-CUR', -7, 100],
  ['17-BLK', -2, 15], ['17-BLK', -1, 30], ['17-BLK', 0, 45, 'Masons short by 3, productivity low'],
  ['17-ELE', -1, 33, 'Conduits laid in 4 flats'],
  ['18-COL', -8, 50], ['18-COL', -7, 100],
  ['18-RNF', -6, 30], ['18-RNF', -5, 55, 'Bar benders short by 4'], ['18-RNF', -4, 100, 'Extra gang deployed'],
  ['18-FWK', -3, 20], ['18-FWK', -2, 40], ['18-FWK', -1, 55, 'Shuttering panels short'],
  ['18-FWK', 0, 70, 'Material received late.', 'Blocked'],
];
for (const [key, offset, actual, comment, status] of HISTORY) {
  const a = acts[key];
  await ProgressUpdate.create({
    project: project._id, activity: a._id, date: d(offset), plannedQuantity: a.plannedQuantity,
    actualQuantity: Math.round((actual / 100) * a.plannedQuantity * 100) / 100,
    plannedProgress: plannedProgressOn(a, d(offset)), actualProgress: actual,
    status: status || (actual >= 100 ? 'Completed' : 'In Progress'), comment, reportedBy: a.responsible,
  });
}

// Resolved historical blockers + one open blocker driving the live early warning.
await Blocker.create([
  {
    project: project._id, activity: acts['17-CUR']._id, type: 'Site Condition', description: 'Water supply line damaged',
    reportedBy: rahul._id, reportedDate: d(-8), expectedResolution: d(-8), severity: 'Low', status: 'Closed',
    resolvedAt: d(-8), resolutionNote: 'Line repaired by plumbing team',
    history: [{ status: 'Open', by: rahul._id, at: d(-8) }, { status: 'Resolved', note: 'Line repaired', by: rahul._id, at: d(-8) }, { status: 'Closed', by: sm._id, at: d(-7) }],
  },
  {
    project: project._id, activity: acts['18-RNF']._id, type: 'Labour', description: 'Bar bender gang short by 4 people',
    reportedBy: rahul._id, reportedDate: d(-5), expectedResolution: d(-4), severity: 'Medium', status: 'Resolved',
    resolvedAt: d(-4), resolutionNote: 'Additional gang deployed from Tower B', assignedTo: sm._id,
    history: [{ status: 'Open', by: rahul._id, at: d(-5) }, { status: 'Assigned', by: sm._id, at: d(-5) }, { status: 'Resolved', note: 'Extra gang deployed', by: sm._id, at: d(-4) }],
  },
  {
    project: project._id, activity: acts['18-FWK']._id, type: 'Material', description: 'Shuttering material unavailable',
    reportedBy: rahul._id, reportedDate: d(-1), expectedResolution: d(1), severity: 'High', status: 'Open',
    history: [{ status: 'Open', note: 'Vendor delivery delayed', by: rahul._id, at: d(-1) }],
  },
]);

await Comment.create([
  { activity: acts['18-FWK']._id, project: project._id, user: rahul._id, text: 'Only 70% of Mivan panels on site. Vendor confirms balance by tomorrow.' },
  { activity: acts['18-FWK']._id, project: project._id, user: sm._id, text: 'Following up with vendor. Check if Tower B panels can be shifted.' },
]);

await evaluateProject(project._id);

const counts = await Promise.all([Activity.countDocuments(), Risk.countDocuments({ status: 'Open' }), Escalation.countDocuments(), Notification.countDocuments()]);
console.log(`Seeded: ${counts[0]} activities, ${counts[1]} open risks, ${counts[2]} escalations, ${counts[3]} notifications`);
console.log('Logins (password: password123): admin@, pm@, sm@, engineer@, engineer2@, planning@, estimation@krisala.test');
await mongoose.disconnect();
