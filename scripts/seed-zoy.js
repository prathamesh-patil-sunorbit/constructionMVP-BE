// Adds a sample schedule to the "Krisala ZOY+" project (code KRS-Z): Floors 1-3 under the existing
// tower, a seven-activity structural chain per floor, dependencies, BOQ estimates and first progress.
// Safe to re-run: existing floors and activity codes are skipped. Nothing is deleted.
//   node scripts/seed-zoy.js [PROJECT_CODE]
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDb } from '../src/config/db.js';
import { Project, StructureNode, Activity, Dependency, Estimate, ProgressUpdate, User } from '../src/models/index.js';
import { evaluateProject, plannedProgressOn } from '../src/services/engine.js';
import { today, addDays } from '../src/utils/dates.js';

const code = process.argv[2] || 'KRS-Z';
await connectDb();
const project = await Project.findOne({ code });
if (!project) throw new Error(`Project ${code} not found. Create it in the app first.`);
const root = await StructureNode.findOne({ project: project._id, parent: null }).sort({ order: 1, createdAt: 1 });
if (!root) throw new Error('Add a tower first (Add tower/floor).');
const users = Object.fromEntries((await User.find({}, 'email').lean()).map((u) => [u.email.split('@')[0], u._id]));
const T = project.startDate ? new Date(project.startDate) : today();

// [suffix, name, days, quantity, unit, labour, materials, machinery, rate]
const CHAIN = [
  ['COL', 'Column Casting', 3, 24, 'cum', [{ trade: 'Carpenter', count: 6 }, { trade: 'Mason', count: 4 }], [{ name: 'RMC M40', quantity: 24, unit: 'cum' }], [{ name: 'Concrete pump', count: 1 }], 8200],
  ['RNF', 'Reinforcement', 3, 9500, 'kg', [{ trade: 'Bar bender', count: 8 }, { trade: 'Helper', count: 4 }], [{ name: 'TMT Fe500D', quantity: 9500, unit: 'kg' }], [], 72],
  ['FWK', 'Formwork', 3, 620, 'sqm', [{ trade: 'Carpenter', count: 10 }, { trade: 'Helper', count: 6 }], [{ name: 'Mivan aluminium panels', quantity: 620, unit: 'sqm' }], [{ name: 'Tower crane', count: 1 }], 640],
  ['MEP', 'MEP Sleeves', 2, 180, 'nos', [{ trade: 'Plumber', count: 3 }, { trade: 'Electrician', count: 3 }], [{ name: 'PVC sleeves', quantity: 180, unit: 'nos' }], [], 260],
  ['CON', 'Slab Concrete', 1, 95, 'cum', [{ trade: 'Mason', count: 8 }, { trade: 'Helper', count: 10 }], [{ name: 'RMC M30', quantity: 95, unit: 'cum' }], [{ name: 'Concrete pump', count: 1 }, { name: 'Vibrator', count: 4 }], 7600],
  ['CUR', 'Curing', 7, 620, 'sqm', [{ trade: 'Helper', count: 3 }], [{ name: 'Water', quantity: 40, unit: 'kl' }], [], 25],
  ['BLK', 'Blockwork', 6, 410, 'cum', [{ trade: 'Mason', count: 12 }, { trade: 'Helper', count: 8 }], [{ name: 'AAC blocks', quantity: 410, unit: 'cum' }, { name: 'Cement', quantity: 1500, unit: 'kg' }], [], 5200],
];

let made = 0;
let prevConcrete = null;
const first = {};
for (const f of [1, 2, 3]) {
  const name = `Floor ${f}`;
  let floor = await StructureNode.findOne({ project: project._id, parent: root._id, name });
  if (!floor) floor = await StructureNode.create({ project: project._id, parent: root._id, name, type: 'Floor', order: f });
  const codeOf = (s) => `ZY-F${f}-${s}`;
  const by = {};
  let start = addDays(T, 12 * (f - 1));
  for (const [i, [suf, title, days, qty, unit, labour, materials, machinery, rate]] of CHAIN.entries()) {
    const c = codeOf(suf);
    let a = await Activity.findOne({ project: project._id, code: c });
    // Chain: Column → Reinforcement → Formwork → MEP → Concrete, then Curing and Blockwork after concrete.
    if (suf === 'CUR' || suf === 'BLK') start = by.CON ? addDays(by.CON.plannedFinish, 1) : start;
    const finish = addDays(start, days - 1);
    if (!a) {
      a = await Activity.create({
        code: c, name: title, project: project._id, structureNode: floor._id, wbs: `1.${f}.${i + 1}`,
        plannedStart: start, plannedFinish: finish, plannedDuration: days, plannedQuantity: qty, unit,
        responsible: f === 2 ? users.engineer2 : users.engineer, priority: suf === 'CON' || suf === 'COL' ? 'High' : 'Medium', source: 'manual',
        baseline: { start, finish, version: 'v1', approvedBy: 'Neha Kale', source: 'manual', setAt: new Date() },
      });
      await Estimate.create({
        project: project._id, activity: a._id, boqCode: `BOQ-${c}`, description: title, quantity: qty, unit, rate,
        amount: Math.round(qty * rate), estimatedDurationDays: days, productivityPerDay: Math.round((qty / days) * 100) / 100,
        labour, materials, machinery, version: 'v1', status: 'Approved',
      });
      made++;
    }
    by[suf] = a;
    first[codeOf(suf)] = a;
    if (['COL', 'RNF', 'FWK', 'MEP'].includes(suf)) start = addDays(finish, 1);
  }
  const links = [['COL', 'RNF'], ['RNF', 'FWK'], ['FWK', 'MEP'], ['MEP', 'CON'], ['CON', 'CUR'], ['CON', 'BLK']]
    .map(([p, s]) => [by[p], by[s]]);
  // The floor below must be concreted before this floor's columns.
  if (prevConcrete) links.push([prevConcrete, by.COL]);
  for (const [pred, succ] of links) {
    if (!(await Dependency.exists({ predecessor: pred._id, successor: succ._id }))) {
      await Dependency.create({ project: project._id, predecessor: pred._id, successor: succ._id, type: 'FS' });
    }
  }
  prevConcrete = by.CON;
}

// First day on site: Floor 1 column casting is half done.
const col = first['ZY-F1-COL'];
if (col && !(await ProgressUpdate.exists({ activity: col._id }))) {
  await ProgressUpdate.create({
    project: project._id, activity: col._id, date: T, plannedQuantity: col.plannedQuantity, actualQuantity: col.plannedQuantity / 2,
    plannedProgress: plannedProgressOn(col, T), actualProgress: 50, status: 'In Progress', comment: 'First column lift poured', reportedBy: col.responsible,
  });
}
await evaluateProject(project._id);
console.log(`${project.name}: ${made} activities added (${await Activity.countDocuments({ project: project._id })} total), ${await Dependency.countDocuments({ project: project._id })} dependencies.`);
await mongoose.disconnect();
