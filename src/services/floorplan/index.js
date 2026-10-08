// Floor-plan import: a DWG / DXF drawing in, interpreted floor plans out.

import { readDrawing, flatten, unitScale } from './dxf.js';
import { symbolLayer, findSheets, interpretSheet, floorLists, sheetKey } from './plan.js';

const COUNTS = ['walls', 'openings', 'rooms', 'furniture', 'stairs', 'lifts', 'columns', 'flats'];

export async function importDrawing(file) {
  const dxf = await readDrawing(file);
  const prims = flatten(dxf, { symbolLayer });
  const scale = unitScale(dxf, prims);

  let sheets = findSheets(prims);
  if (!sheets.length) {
    // No title blocks: treat the whole drawing as one typical floor.
    const xs = prims.flatMap((p) => (p.pts ? p.pts.map((q) => q[0]) : [p.x]));
    const ys = prims.flatMap((p) => (p.pts ? p.pts.map((q) => q[1]) : [p.y]));
    sheets = [{ title: 'Typical floor plan', box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] }];
  }

  const plans = {};
  const floors = { typical: [], refuge: [] };
  const skipped = [];
  for (const sheet of sheets) {
    const key = sheetKey(sheet.title) || (plans.typical ? null : 'typical');
    if (!key || plans[key]) { skipped.push(sheet.title); continue; }
    try {
      plans[key] = { title: sheet.title, ...interpretSheet(prims, sheet.box, scale) };
    } catch (e) {
      if (e.status !== 422) throw e;
      skipped.push(`${sheet.title} (${e.message})`);
      continue;
    }
    const lists = floorLists(prims, sheet.box);
    floors.typical.push(...lists.typical);
    floors.refuge.push(...lists.refuge);
  }
  if (!plans.typical && plans.refuge) plans.typical = plans.refuge;
  if (!plans.typical) {
    const err = new Error('No floor plan could be read from this drawing. Check that walls are on a layer whose name contains "wall".');
    err.status = 422;
    throw err;
  }

  const stats = Object.fromEntries(Object.entries(plans).map(([k, p]) => [k, {
    title: p.title,
    widthM: p.widthM,
    depthM: p.depthM,
    ...Object.fromEntries(COUNTS.map((c) => [c, p[c].length])),
  }]));
  return { plans, floors, stats, skipped, units: scale };
}
