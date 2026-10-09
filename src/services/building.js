// Parametric building model for the 3D / 4D viewer.
//
// There is no BIM or IFC source in this system, so the geometry is generated from what the
// project actually records: the Tower → Floor structure tree and the planned quantities on the
// activities (slab area, column count, concrete volume). Every derived dimension carries the
// record it came from, and anything that cannot be derived falls back to a documented default
// that a manager can override per project.
//
// Each component is linked to the real activities for its floor and trade, which is what makes
// the 4D timeline and the component drill-down work.

import { Activity, BuildingSpec, Project, ProgressUpdate, StructureNode, Estimate, ExecutionLog } from '../models/index.js';
import { COMPONENT_CATEGORIES } from '../models/constants.js';
import { toDay, diffDays } from '../utils/dates.js';
import { planLevels, planFootprint, addPlanTower } from './floorplan/build.js';

// Massing envelope taken from the City Life marketing issue (job 2184), not from a survey.
// 2184-021 is a long double-loaded plate: five bays along a 1.50 m corridor, flats both sides.
// 2184-023 gives the 1.30 m open-balcony depth. 2184-001 Rev D is LGF+G+3P+21 floors.
export const CITY_LIFE = {
  plateLengthM: 52,
  plateDepthM: 16.5,
  balconyDepthM: 1.3,
  baysX: 5,
  baysZ: 2,
  corridorM: 1.5,
  residentialFloors: 21,
  podiumFloors: 3,
  refugeFloors: [4, 9, 14, 19],
};

export const DEFAULTS = {
  plateAreaSqm: CITY_LIFE.plateLengthM * CITY_LIFE.plateDepthM,
  aspectRatio: CITY_LIFE.plateLengthM / CITY_LIFE.plateDepthM,
  floorHeightM: 3,
  slabThicknessM: 0.15,
  columnSizeM: 0.45,
  wallThicknessM: 0.28,
  baysX: CITY_LIFE.baysX,
  baysZ: CITY_LIFE.baysZ,
  balconyDepthM: CITY_LIFE.balconyDepthM,
  towerGapM: 12,
  balconySide: 'both',
  hasParking: true,
  wallColor: '#f6f3ee',
};

// Each flat is split into the rooms on the unit plan.
// Local origin is the exterior-left corner: +x along the plate, +z toward the corridor.
// 3 BHK is the end flat (11.70 × 7.50). 2 BHK is a middle flat (9.53 × 7.50).
// A room item is [subtype, xFraction, zFraction, width, depth, height, name].
const FLAT_PLANS = {
  '3bhk': {
    w: 11.7,
    d: 7.5,
    rooms: [
      { name: 'Master bedroom', x: 0, z: 2.3, w: 3.3, d: 5.2, floor: 'room', items: [
        ['bed', 0.55, 0.4, 2.0, 1.5, 0.45, 'bed'],
        ['wardrobe', 0.14, 0.82, 0.45, 1.5, 2.1, 'wardrobe'],
        ['side', 0.18, 0.28, 0.42, 0.42, 0.5, 'bedside table'],
        ['side', 0.86, 0.28, 0.42, 0.42, 0.5, 'bedside table'],
      ] },
      { name: 'Toilet', x: 0, z: 0, w: 1.6, d: 2.3, floor: 'bath', items: [
        ['wc', 0.42, 0.32, 0.42, 0.65, 0.42, 'toilet'],
        ['basin', 0.72, 0.78, 0.5, 0.4, 0.8, 'wash basin'],
      ] },
      { name: 'Living', x: 3.3, z: 0, w: 3.5, d: 7.5, floor: 'room', items: [
        ['curtain', 0.5, 0.07, 3.1, 0.16, 2.15, 'curtains'],
        ['sofa', 0.4, 0.38, 1.8, 0.85, 0.42, 'sofa'],
        ['coffee', 0.42, 0.55, 0.9, 0.5, 0.32, 'coffee table'],
        ['tv', 0.86, 0.32, 0.4, 1.1, 0.7, 'TV'],
        ['dining', 0.48, 0.8, 1.2, 0.75, 0.75, 'dining table'],
      ] },
      { name: 'Bedroom 2', x: 6.8, z: 0, w: 4.9, d: 3.15, floor: 'room', items: [
        ['curtain', 0.5, 0.1, 3.4, 0.16, 2.15, 'curtains'],
        ['bed', 0.42, 0.55, 1.9, 1.45, 0.45, 'bed'],
        ['wardrobe', 0.88, 0.28, 1.2, 0.42, 2.1, 'wardrobe'],
        ['side', 0.22, 0.78, 0.42, 0.42, 0.5, 'bedside table'],
      ] },
      { name: 'Bedroom 3', x: 6.8, z: 3.15, w: 2.7, d: 4.35, floor: 'room', items: [
        ['bed', 0.52, 0.4, 1.8, 1.35, 0.45, 'bed'],
        ['wardrobe', 0.16, 0.84, 0.42, 1.2, 2.1, 'wardrobe'],
        ['side', 0.82, 0.22, 0.4, 0.4, 0.5, 'bedside table'],
      ] },
      { name: 'Kitchen', x: 9.5, z: 3.15, w: 2.2, d: 2.7, floor: 'kitchen', items: [
        ['kitchen', 0.42, 0.35, 1.5, 0.55, 0.9, 'kitchen'],
        ['fridge', 0.82, 0.78, 0.55, 0.55, 1.7, 'fridge'],
      ] },
      { name: 'Toilet', x: 9.5, z: 5.85, w: 2.2, d: 1.65, floor: 'bath', items: [
        ['wc', 0.35, 0.4, 0.42, 0.6, 0.42, 'toilet'],
        ['basin', 0.75, 0.62, 0.5, 0.38, 0.8, 'wash basin'],
      ] },
    ],
    // [x1, z1, x2, z2, door distance along the wall, or null]
    walls: [
      [0, 2.3, 1.6, 2.3, 0.8],
      [1.6, 0, 1.6, 2.3, null],
      [3.3, 2.3, 3.3, 7.5, 4.8],
      [6.8, 0, 6.8, 3.15, 1.6],
      [6.8, 3.15, 6.8, 7.5, 5.2],
      [6.8, 3.15, 11.7, 3.15, 8.1],
      [9.5, 3.15, 9.5, 7.5, 4.3],
      [9.5, 5.85, 11.7, 5.85, 10.5],
    ],
  },
  '2bhk': {
    w: 9.53,
    d: 7.5,
    rooms: [
      { name: 'Bedroom 1', x: 0, z: 2.4, w: 3.2, d: 5.1, floor: 'room', items: [
        ['bed', 0.55, 0.4, 2.0, 1.45, 0.45, 'bed'],
        ['wardrobe', 0.12, 0.82, 0.4, 1.3, 2.1, 'wardrobe'],
        ['side', 0.18, 0.28, 0.4, 0.4, 0.5, 'bedside table'],
        ['side', 0.86, 0.28, 0.4, 0.4, 0.5, 'bedside table'],
      ] },
      { name: 'Toilet', x: 0, z: 0, w: 1.55, d: 2.4, floor: 'bath', items: [
        ['wc', 0.4, 0.32, 0.4, 0.6, 0.42, 'toilet'],
        ['basin', 0.7, 0.78, 0.48, 0.38, 0.8, 'wash basin'],
      ] },
      { name: 'Living', x: 3.2, z: 0, w: 3.1, d: 7.5, floor: 'room', items: [
        ['curtain', 0.5, 0.07, 2.7, 0.16, 2.15, 'curtains'],
        ['sofa', 0.42, 0.36, 1.7, 0.8, 0.42, 'sofa'],
        ['coffee', 0.45, 0.52, 0.85, 0.48, 0.32, 'coffee table'],
        ['tv', 0.88, 0.3, 0.38, 1.0, 0.7, 'TV'],
        ['dining', 0.48, 0.78, 1.1, 0.7, 0.75, 'dining table'],
      ] },
      { name: 'Kitchen', x: 6.3, z: 0, w: 1.9, d: 3.4, floor: 'kitchen', items: [
        ['curtain', 0.5, 0.1, 1.5, 0.14, 1.6, 'curtains'],
        ['kitchen', 0.45, 0.4, 1.4, 0.55, 0.9, 'kitchen'],
        ['fridge', 0.78, 0.8, 0.5, 0.5, 1.7, 'fridge'],
      ] },
      { name: 'Toilet', x: 8.2, z: 0, w: 1.33, d: 3.4, floor: 'bath', items: [
        ['wc', 0.45, 0.28, 0.38, 0.58, 0.42, 'toilet'],
        ['basin', 0.55, 0.78, 0.46, 0.36, 0.8, 'wash basin'],
      ] },
      { name: 'Bedroom 2', x: 6.3, z: 3.4, w: 3.23, d: 4.1, floor: 'room', items: [
        ['bed', 0.52, 0.42, 1.85, 1.4, 0.45, 'bed'],
        ['wardrobe', 0.88, 0.82, 0.4, 1.2, 2.1, 'wardrobe'],
        ['side', 0.18, 0.25, 0.4, 0.4, 0.5, 'bedside table'],
      ] },
    ],
    walls: [
      [0, 2.4, 1.55, 2.4, 0.75],
      [1.55, 0, 1.55, 2.4, null],
      [3.2, 2.4, 3.2, 7.5, 4.8],
      [6.3, 0, 6.3, 3.4, 1.6],
      [6.3, 3.4, 6.3, 7.5, 5.2],
      [6.3, 3.4, 9.53, 3.4, 7.3],
      [8.2, 0, 8.2, 3.4, 1.7],
    ],
  },
};

function unitWidths(plateLength) {
  const end = 11.7;
  const mid = (plateLength - end * 2) / 3;
  return [end, mid, mid, mid, end];
}

function wallPieces(length, doorAt) {
  if (doorAt == null) return [[length / 2, length]];
  const gap = 0.75;
  const a = Math.max(0, doorAt - gap / 2);
  const b = Math.min(length, doorAt + gap / 2);
  const pieces = [];
  if (a > 0.25) pieces.push([a / 2, a]);
  if (length - b > 0.25) pieces.push([b + (length - b) / 2, length - b]);
  return pieces;
}

// Building services for one storey, laid out the way a coordinated MEP model reads:
// mains along the corridor ceiling, risers at both cores, and a branch set into every flat.
// Everything is `engineering`, so it only shows in the MEP / engineering views.
// Labels say "bay", never "flat NN", so the services do not join a flat's hit box.
export function serviceNetwork({ push, meta, y0, H, wallH, xOffset, width, depth, floorLabel, mepIds, colIds, residential, first }) {
  const corridorZ = depth / 2;
  const sideDepth = (depth - CITY_LIFE.corridorM) / 2;
  const ceilY = y0 + wallH - 0.22;
  const x0 = xOffset + 0.9;
  const x1 = xOffset + width - 0.9;
  const base = { ...meta, category: 'mep', engineering: true, activityIds: mepIds };
  const pipe = (subtype, position, length, rotation, dia, label, callout) => push({
    ...base, type: 'pipe', subtype, position, size: [dia, Math.max(0.05, length), dia], rotation, label, callout,
  });
  const runX = (subtype, a, b, y, z, dia, label, callout) => pipe(subtype, [(a + b) / 2, y, z], Math.abs(b - a), [0, 0, Math.PI / 2], dia, label, callout);
  const runZ = (subtype, x, y, a, b, dia, label) => pipe(subtype, [x, y, (a + b) / 2], Math.abs(b - a), [Math.PI / 2, 0, 0], dia, label);
  const runY = (subtype, x, a, b, z, dia, label) => pipe(subtype, [x, (a + b) / 2, z], Math.abs(b - a), [0, 0, 0], dia, label);
  const duct = (subtype, position, size, label, callout) => push({ ...base, type: 'duct', subtype, position, size, label, callout });

  // Corridor mains. The corridor is 1.50 m wide, so the services stack in two layers.
  const len = x1 - x0;
  const mx = (x0 + x1) / 2;
  duct('supply', [mx, ceilY - 0.02, corridorZ - 0.38], [len, 0.3, 0.55], `${floorLabel} AC supply duct main`, first ? 'AC SUPPLY DUCT' : undefined);
  duct('return', [mx, ceilY - 0.04, corridorZ + 0.4], [len, 0.26, 0.45], `${floorLabel} return air duct main`, first ? 'RETURN AIR DUCT' : undefined);
  runX('sprinkler', x0, x1, ceilY - 0.32, corridorZ - 0.05, 0.11, `${floorLabel} sprinkler main`, first ? 'FIRE SPRINKLER' : undefined);
  duct('tray', [mx, ceilY - 0.34, corridorZ + 0.45], [len, 0.07, 0.3], `${floorLabel} cable tray`, first ? 'CABLE TRAY' : undefined);
  runX('cold', x0, x1, ceilY - 0.46, corridorZ - 0.45, 0.09, `${floorLabel} domestic water main`, first ? 'PLUMBING PIPE' : undefined);
  runX('hot', x0, x1, ceilY - 0.46, corridorZ - 0.25, 0.07, `${floorLabel} hot water main`);

  // Risers beside both cores. Full storey height so they run through the slab.
  const yMid = y0 + H / 2;
  [0.25, 0.75].forEach((f, ci) => {
    const rx = xOffset + width * f + 2.8 + 0.55;
    const tag = `${floorLabel} core ${ci + 1}`;
    push({
      ...meta, type: 'shaft', category: 'structure', engineering: true,
      position: [rx + 0.25, y0 + wallH / 2, corridorZ], size: [1.2, wallH * 0.94, 1.3],
      label: `${tag} service shaft`, activityIds: colIds, callout: first && ci === 0 ? 'SHAFT' : undefined,
    });
    runY('sprinkler', rx, y0, y0 + H, corridorZ - 0.45, 0.15, `${tag} fire riser`);
    runY('cold', rx + 0.25, y0, y0 + H, corridorZ - 0.45, 0.12, `${tag} water riser`);
    runY('hot', rx + 0.5, y0, y0 + H, corridorZ - 0.45, 0.09, `${tag} hot water riser`);
    runY('drain', rx, y0, y0 + H, corridorZ + 0.45, 0.15, `${tag} soil stack`, first && ci === 0 ? 'DRAINAGE PIPE' : undefined);
    runY('conduit', rx + 0.5, y0, y0 + H, corridorZ + 0.45, 0.1, `${tag} electrical riser`);
    duct('supply', [rx + 0.25, yMid, corridorZ], [0.45, H, 0.35], `${tag} AC duct riser`);
  });

  // Branches into each flat, both sides of the corridor.
  if (!residential) return;
  const widths = unitWidths(width);
  ['front', 'back'].forEach((side) => {
    const dir = side === 'front' ? -1 : 1;
    const wall = corridorZ + dir * (CITY_LIFE.corridorM / 2);
    const at = (fraction) => corridorZ + dir * (CITY_LIFE.corridorM / 2 + sideDepth * fraction);
    let bx0 = xOffset;
    widths.forEach((unitW, u) => {
      const bx = bx0 + unitW / 2;
      bx0 += unitW;
      const tag = `${floorLabel} ${side} bay ${u + 1}`;
      const far = at(0.78);
      const mid = at(0.42);
      const wet = at(0.3);

      const sx = bx - unitW * 0.2;
      duct('supply', [sx, ceilY - 0.02, (corridorZ - 0.38 + far) / 2], [0.32, 0.22, Math.abs(far - (corridorZ - 0.38))], `${tag} AC supply branch`);
      duct('diffuser', [sx, ceilY - 0.17, mid], [0.5, 0.06, 0.5], `${tag} supply diffuser`);
      duct('diffuser', [sx, ceilY - 0.17, far], [0.5, 0.06, 0.5], `${tag} supply diffuser 2`);
      const rx = bx + unitW * 0.12;
      duct('return', [rx, ceilY - 0.04, (corridorZ + 0.4 + mid) / 2], [0.28, 0.2, Math.abs(mid - (corridorZ + 0.4))], `${tag} return air branch`);

      runZ('sprinkler', bx, ceilY - 0.32, corridorZ - 0.05, far, 0.06, `${tag} sprinkler branch`);
      runX('sprinkler', bx - unitW * 0.34, bx + unitW * 0.34, ceilY - 0.32, mid, 0.05, `${tag} sprinkler line`);
      [-0.34, 0.34].forEach((k, n) => runY('sprinkler', bx + unitW * k, ceilY - 0.55, ceilY - 0.32, mid, 0.05, `${tag} sprinkler drop ${n + 1}`));

      const px = bx + unitW * 0.32;
      runZ('cold', px, ceilY - 0.46, corridorZ - 0.45, wet, 0.05, `${tag} cold water branch`);
      runZ('hot', px + 0.16, ceilY - 0.46, corridorZ - 0.25, wet, 0.04, `${tag} hot water branch`);
      runY('cold', px, y0 + 0.45, ceilY - 0.46, wet, 0.05, `${tag} cold water drop`);
      runY('hot', px + 0.16, y0 + 0.45, ceilY - 0.46, wet, 0.04, `${tag} hot water drop`);
      runY('drain', px + 0.4, y0, y0 + H, wet, 0.11, `${tag} waste stack`);
      runX('drain', bx + unitW * 0.08, px + 0.4, y0 + 0.14, wet, 0.08, `${tag} WC waste`);
      runZ('conduit', bx - unitW * 0.36, ceilY - 0.2, wall, far, 0.04, `${tag} lighting conduit`);
      runZ('exhaust', px + 0.4, ceilY - 0.12, wet, at(0.02), 0.16, `${tag} toilet exhaust`);
    });
  });
}

export function furnishFloor({ push, meta, y0, wallH, xOffset, width, depth, floorLabel, wallIds, finishIds, openingIds, storey }) {
  const sideDepth = (depth - CITY_LIFE.corridorM) / 2;
  const widths = unitWidths(width);
  const coreW = 5.6;
  const cores = [width * 0.25, width * 0.75].map((cx) => [xOffset + cx - coreW / 2, xOffset + cx + coreW / 2]);
  const hitsCore = (x) => cores.some(([a, b]) => x > a + 0.3 && x < b - 0.3);

  const placeSide = (side) => {
    let x0 = 0;
    widths.forEach((unitW, u) => {
      const kind = u === 0 || u === widths.length - 1 ? '3bhk' : '2bhk';
      const plan = FLAT_PLANS[kind];
      const flatNo = side === 'front' ? u + 1 : u + 6;
      const tag = `${floorLabel} flat ${String(flatNo).padStart(2, '0')} ${kind === '3bhk' ? '3 BHK' : '2 BHK'}`;
      const sx = unitW / plan.w;
      const sz = sideDepth / plan.d;
      const world = (lx, lz) => [
        xOffset + x0 + lx * sx,
        side === 'front' ? lz * sz : depth - lz * sz,
      ];
      for (const room of plan.rooms) {
        const [fx, fz] = world(room.x + room.w / 2, room.z + room.d / 2);
        push({
          ...meta, type: 'flooring', subtype: room.floor === 'bath' ? 'bath' : room.floor === 'kitchen' ? 'kitchen-tile' : undefined, category: 'finishes',
          position: [fx, y0 + 0.03, fz],
          size: [room.w * sx - 0.08, 0.04, room.d * sz - 0.08],
          label: `${tag} ${room.name}`,
          activityIds: finishIds,
        });
        for (const [subtype, fxr, fzr, iw, id, ih, name] of room.items) {
          const [x, z] = world(room.x + room.w * fxr, room.z + room.d * fzr);
          push({
            ...meta, type: 'furniture', subtype, category: 'finishes',
            position: [x, y0 + ih / 2, z],
            size: [Math.min(iw, room.w * sx * 0.85), ih, Math.min(id, room.d * sz * 0.8)],
            label: `${tag} ${room.name} ${name}`,
            activityIds: finishIds,
          });
        }
      }
      for (const [x1, z1, x2, z2, doorAt] of plan.walls) {
        const horizontal = Math.abs(z1 - z2) < 0.01;
        const length = horizontal ? Math.abs(x2 - x1) * sx : Math.abs(z2 - z1) * sz;
        const origin = horizontal ? Math.min(x1, x2) : Math.min(z1, z2);
        const scale = horizontal ? sx : sz;
        const doorDist = doorAt == null ? null : (doorAt - origin) * scale;
        for (const [mid, len] of wallPieces(length, doorDist)) {
          const along = origin + mid / (horizontal ? sx : sz);
          const [x, z] = horizontal
            ? world(along, z1)
            : world(x1, along);
          push({
            ...meta, type: 'wall', category: 'masonry',
            position: [x, y0 + wallH * 0.46, z],
            size: horizontal ? [len, wallH * 0.92, 0.1] : [0.1, wallH * 0.92, len],
            label: `${tag} room wall`,
            activityIds: wallIds,
          });
        }
        if (doorDist != null && doorDist > 0.3 && doorDist < length - 0.3) {
          const along = origin + doorDist / scale;
          const [x, z] = horizontal ? world(along, z1) : world(x1, along);
          const leaf = 0.75;
          push({
            ...meta, type: 'door', subtype: 'room', category: 'openings',
            position: [x, y0 + 1.02, z],
            size: horizontal ? [leaf, 2.04, 0.05] : [0.05, 2.04, leaf],
            label: `${tag} room door`,
            activityIds: openingIds,
          });
        }
      }
      if (u > 0) {
        const zc = side === 'front' ? sideDepth / 2 : depth - sideDepth / 2;
        push({
          ...meta, type: 'wall', category: 'masonry',
          position: [xOffset + x0, y0 + wallH * 0.46, zc],
          size: [0.12, wallH * 0.92, sideDepth],
          label: `${tag} party wall`,
          activityIds: wallIds,
        });
      }
      const doorX = unitW * (kind === '3bhk' ? 0.48 : 0.5);
      const doorW = 0.9;
      const doorCenter = xOffset + x0 + doorX + doorW / 2;
      const wallZ = side === 'front' ? sideDepth : depth - sideDepth;
      if (!hitsCore(doorCenter)) {
        const segments = [
          [doorX / 2, doorX],
          [doorX + doorW + (unitW - doorX - doorW) / 2, unitW - doorX - doorW],
        ];
        for (const [cxLocal, len] of segments) {
          if (len < 0.2) continue;
          push({
            ...meta, type: 'wall', category: 'masonry',
            position: [xOffset + x0 + cxLocal, y0 + wallH * 0.46, wallZ],
            size: [len, wallH * 0.92, 0.12],
            label: `${tag} corridor wall`,
            activityIds: wallIds,
          });
        }
        push({
          ...meta, type: 'door', category: 'openings',
          position: [doorCenter, y0 + 1.05, wallZ],
          size: [doorW, 2.1, 0.06],
          label: `${tag} entrance door`,
          activityIds: openingIds,
        });
      }
      x0 += unitW;
    });
  };
  placeSide('front');
  placeSide('back');

  const corridorZ = depth / 2;
  const coreSpans = cores.map(([a]) => a - xOffset);
  const corridorCuts = [0, ...coreSpans.flatMap((x) => [x, x + coreW]), width];
  for (let i = 0; i < corridorCuts.length; i += 2) {
    const a = corridorCuts[i];
    const b = corridorCuts[i + 1];
    if (b - a < 0.4) continue;
    push({
      ...meta, type: 'flooring', subtype: 'tile', category: 'finishes',
      position: [xOffset + (a + b) / 2, y0 + 0.025, corridorZ],
      size: [b - a - 0.08, 0.03, CITY_LIFE.corridorM - 0.08],
      label: `${floorLabel} corridor`,
      activityIds: finishIds,
      callout: storey === 2 && i === 0 ? 'CORRIDOR' : undefined,
    });
  }

  cores.forEach(([xL, xR], coreIndex) => {
    const coreD = 2.7;
    const z0 = corridorZ - coreD / 2;
    const cx = (xL + xR) / 2;
    const name = `${floorLabel} core ${coreIndex + 1}`;
    const wallY = y0 + wallH * 0.46;
    const shell = [
      { position: [cx, wallY, z0], size: [coreW, wallH * 0.92, 0.12] },
      { position: [cx, wallY, z0 + coreD], size: [coreW, wallH * 0.92, 0.12] },
    ];
    shell.forEach((p, idx) => push({
      ...meta, type: 'wall', category: 'masonry',
      ...p, label: `${name} wall ${idx + 1}`, activityIds: wallIds,
    }));
    for (const x of [xL, xR]) {
      const gap = 1.05;
      const sideLen = (coreD - gap) / 2;
      for (const z of [z0 + sideLen / 2, z0 + coreD - sideLen / 2]) {
        push({
          ...meta, type: 'wall', category: 'masonry',
          position: [x, wallY, z],
          size: [0.12, wallH * 0.92, sideLen],
          label: `${name} jamb`,
          activityIds: wallIds,
        });
      }
      push({
        ...meta, type: 'door', subtype: 'room', category: 'openings',
        position: [x, y0 + 1.02, corridorZ],
        size: [0.05, 2.04, 0.9],
        label: `${name} stair door`,
        activityIds: openingIds,
      });
    }
    push({
      ...meta, type: 'flooring', category: 'finishes',
      position: [cx, y0 + 0.04, corridorZ],
      size: [coreW - 0.2, 0.05, coreD - 0.2],
      label: `${name} stair hall`,
      activityIds: finishIds,
      callout: storey === 2 && coreIndex === 0 ? 'STAIR' : undefined,
    });
    const liftW = 1.45;
    const liftD = 1.7;
    [0, 1].forEach((n) => {
      push({
        ...meta, type: 'base', subtype: 'lift', category: 'structure',
        position: [xR - 0.95, y0 + wallH * 0.45, corridorZ + (n === 0 ? -0.55 : 0.55)],
        size: [liftW, wallH * 0.88, liftD * 0.55],
        label: `${name} lift ${n + 1}`,
        activityIds: wallIds,
        callout: storey === 2 && coreIndex === 0 && n === 0 ? 'LIFT' : undefined,
      });
    });
    const steps = 9;
    const going = 0.28;
    const flight = steps * going;
    const stairX = xL + 0.45 + flight / 2;
    for (let s = 0; s < steps; s++) {
      push({
        ...meta, type: 'stair', category: 'structure',
        position: [xL + 0.4 + s * going + going / 2, y0 + 0.12 + s * 0.16, corridorZ],
        size: [going - 0.02, 0.08, 1.15],
        label: `${name} tread ${s + 1}`,
        activityIds: wallIds,
      });
    }
    push({
      ...meta, type: 'railing', category: 'openings',
      position: [stairX, y0 + 0.95, corridorZ - 0.62],
      size: [flight, 0.05, 0.04],
      label: `${name} handrail`,
      activityIds: openingIds,
    });
  });
}

// Activity name -> component category. Drives which activities govern which geometry.
const CATEGORY_RULES = [
  { category: 'slab', pattern: /slab|formwork|shuttering|concret|curing|deck|reinforce|rebar|rcc\b/i },
  { category: 'structure', pattern: /column|beam|core|shear wall|footing|pile|foundation/i },
  { category: 'masonry', pattern: /block|brick|masonry|\bwall\b|partition/i },
  { category: 'mep', pattern: /mep|electric|conduit|plumb|sleeve|duct|fire|hvac|drain/i },
  { category: 'openings', pattern: /window|door|frame|glaz|shutter|railing/i },
  { category: 'finishes', pattern: /plaster|paint|putty|tile|flooring|finish|waterproof|polish/i },
  { category: 'site', pattern: /parking|landscap|road|boundary|external|podium/i },
];

export function categoryOf(name = '') {
  return CATEGORY_RULES.find((r) => r.pattern.test(name))?.category || 'structure';
}

// Floor name -> storey number, so "Floor 18" sits at its real elevation.
function storeyNumber(name = '') {
  const match = name.match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

// LGF + Ground + 3 podium + floors 1–21, from 2184-001 Rev D. A database floor with the
// same name (Floor 17, for example) keeps its activities; the other storeys are massing only.
function cityLifeLevels(dbFloors) {
  const byName = new Map(dbFloors.map((f) => [f.name, f]));
  const refuge = new Set(CITY_LIFE.refugeFloors);
  const levels = [
    { name: 'Lower Ground', kind: 'lgf' },
    { name: 'Ground', kind: 'ground' },
  ];
  for (let i = 1; i <= CITY_LIFE.podiumFloors; i++) levels.push({ name: `Podium ${i}`, kind: 'podium' });
  for (let n = 1; n <= CITY_LIFE.residentialFloors; n++) {
    levels.push({ name: `Floor ${n}`, kind: refuge.has(n) ? 'refuge' : 'residential', storey: n });
  }
  return levels.map((level) => ({ ...level, node: byName.get(level.name) || null, detail: Boolean(byName.get(level.name)) }));
}

/**
 * Resolve the geometry parameters for a project: stored overrides first, then values derived
 * from the activity plan, then defaults. Returns the values plus where each one came from.
 */
export function resolveSpec({ stored, activities, floors }) {
  const sources = {};
  const take = (key, derived, source) => {
    if (stored?.[key] !== undefined && stored?.[key] !== null) {
      sources[key] = 'set for this project';
      return stored[key];
    }
    if (derived !== null && derived !== undefined && Number.isFinite(derived) ? true : derived) {
      sources[key] = source;
      return derived;
    }
    sources[key] = `default (${DEFAULTS[key]})`;
    return DEFAULTS[key];
  };

  // The activity quantities are one trade on one floor (for example 1,000 sq.ft of formwork).
  // They are not the building plate. The plate comes from the City Life typical-floor drawing.
  const plateAreaSqm = take(
    'plateAreaSqm',
    Math.round(CITY_LIFE.plateLengthM * CITY_LIFE.plateDepthM * 10) / 10,
    `2184-021 typical floor massing, ${CITY_LIFE.plateLengthM} m × ${CITY_LIFE.plateDepthM} m`,
  );
  const aspectRatio = take(
    'aspectRatio',
    Math.round((CITY_LIFE.plateLengthM / CITY_LIFE.plateDepthM) * 100) / 100,
    '2184-021 long slab: length ÷ depth',
  );
  const baysX = take('baysX', CITY_LIFE.baysX, '2184-021: five flat bays along the corridor');
  const baysZ = take('baysZ', CITY_LIFE.baysZ, '2184-021: flats both sides of the 1.50 m corridor');

  // Slab thickness from concrete volume ÷ plate area, when that lands in a believable range.
  const conc = activities.find((a) => /concret/i.test(a.name) && /cum|m3|cu\.?m/i.test(a.unit || ''));
  const derivedSlab = conc && plateAreaSqm ? conc.plannedQuantity / plateAreaSqm : null;
  const slabThicknessM = take(
    'slabThicknessM',
    derivedSlab && derivedSlab >= 0.1 && derivedSlab <= 0.35 ? Math.round(derivedSlab * 100) / 100 : null,
    conc ? `${conc.plannedQuantity} ${conc.unit} on ${conc.code} ÷ ${plateAreaSqm} m² plate` : null,
  );

  // Do not invent a grey shaft of "existing" storeys. Floor 20 on a high-rise would otherwise
  // draw 19 empty floors and hide the real walls. Managers can still set floorsBelow on the spec.
  const floorsBelow = take(
    'floorsBelow',
    0,
    'planned floors are drawn from ground / podium; set floorsBelow on the project to show a podium mass',
  );

  return {
    spec: {
      plateAreaSqm,
      aspectRatio,
      baysX,
      baysZ,
      slabThicknessM,
      floorsBelow,
      floorHeightM: take('floorHeightM', null, null),
      columnSizeM: take('columnSizeM', null, null),
      wallThicknessM: take('wallThicknessM', null, null),
      balconyDepthM: take('balconyDepthM', CITY_LIFE.balconyDepthM, '2184-023 open balcony depth 1.30 m'),
      towerGapM: take('towerGapM', null, null),
      balconySide: stored?.balconySide || DEFAULTS.balconySide,
      hasParking: stored?.hasParking ?? DEFAULTS.hasParking,
      wallColor: stored?.wallColor || DEFAULTS.wallColor,
    },
    sources: {
      ...sources,
      stack: '2184-001 Rev D: lower ground, ground, 3 podium, floors 1–21. Refuge on 4, 9, 14, 19 (2184-022).',
    },
  };
}

/**
 * Build the component list for a project.
 * @returns {Promise<object>} spec, derivation sources, towers, components and linked activities.
 */
export async function buildModel(projectId) {
  const project = await Project.findById(projectId).lean();
  if (!project) {
    const err = new Error('Project not found');
    err.status = 404;
    throw err;
  }
  const [nodes, activities, stored, updates, estimates, logs] = await Promise.all([
    StructureNode.find({ project: projectId }).sort({ order: 1, createdAt: 1 }).lean(),
    Activity.find({ project: projectId }).populate('responsible', 'name').lean(),
    BuildingSpec.findOne({ project: projectId }).lean(),
    ProgressUpdate.find({ project: projectId }, 'activity date actualProgress').sort({ date: 1 }).lean(),
    Estimate.find({ project: projectId }, 'activity labour materials machinery amount').lean(),
    ExecutionLog.find({ project: projectId }, 'activity date manpower materialsConsumed machinery').lean(),
  ]);

  const byParent = new Map();
  for (const n of nodes) {
    const key = String(n.parent || 'root');
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(n);
  }
  const roots = byParent.get('root') || [];
  const floorsOf = (towerId) => (byParent.get(String(towerId)) || []);

  const allFloors = roots.flatMap((t) => (floorsOf(t._id).length ? floorsOf(t._id) : [t]));
  const { spec, sources } = resolveSpec({ stored, activities, floors: allFloors });

  // An imported floor plan (DWG / DXF) replaces the City Life massing. Its footprint is the plate.
  const floorplan = stored?.floorplan?.plans?.typical ? stored.floorplan : null;
  const footprint = floorplan ? planFootprint(floorplan) : null;

  // Plate dimensions from area and aspect ratio.
  const width = footprint ? footprint.width : Math.sqrt(spec.plateAreaSqm * spec.aspectRatio);
  const depth = footprint ? footprint.depth : spec.plateAreaSqm / width;
  const H = spec.floorHeightM;

  // Activity lookup per floor node and category.
  const actByNode = new Map();
  for (const a of activities) {
    const key = String(a.structureNode || 'tower');
    if (!actByNode.has(key)) actByNode.set(key, []);
    actByNode.get(key).push(a);
  }
  const historyBy = new Map();
  for (const u of updates) {
    const k = String(u.activity);
    if (!historyBy.has(k)) historyBy.set(k, []);
    historyBy.get(k).push({ date: u.date, progress: u.actualProgress });
  }
  const estBy = new Map();
  for (const e of estimates) {
    const k = String(e.activity);
    estBy.set(k, [...(estBy.get(k) || []), e]);
  }
  const logBy = new Map();
  for (const l of logs) {
    const k = String(l.activity);
    logBy.set(k, [...(logBy.get(k) || []), l]);
  }

  const components = [];
  const usedActivities = new Set();
  let xOffset = 0;

  const push = (c) => {
    const unitMatch = typeof c.label === 'string' ? c.label.match(/flat (\d{2})/) : null;
    components.push({ id: `c${components.length}`, ...c, unit: unitMatch ? unitMatch[1] : null });
    return components[components.length - 1];
  };

  // Links a component to the activities that actually build it.
  const linkFor = (floorNodeId, towerNodeId, category) => {
    const candidates = [
      ...(actByNode.get(String(floorNodeId)) || []),
      ...(floorNodeId === towerNodeId ? [] : (actByNode.get(String(towerNodeId)) || [])),
    ];
    const matched = candidates.filter((a) => categoryOf(a.name) === category);
    for (const a of matched) usedActivities.add(String(a._id));
    return matched.map((a) => String(a._id));
  };

  const massing = [];
  for (const tower of roots) {
    const levels = floorplan ? planLevels(floorplan, floorsOf(tower._id)) : cityLifeLevels(floorsOf(tower._id));
    massing.push({ tower, levels });
    if (floorplan) {
      addPlanTower({ push, tower, levels, floorplan, xOffset, spec, linkFor });
      xOffset += width + spec.towerGapM;
      continue;
    }
    const cx = xOffset + width / 2;
    const cz = depth / 2;
    const baseHeight = spec.floorsBelow * H;

    if (baseHeight > 0) {
      push({
        type: 'base', category: 'structure', tower: tower.name, floorName: null, floorIndex: -1,
        position: [cx, baseHeight / 2, cz], size: [width, baseHeight, depth],
        label: `${tower.name}: ${spec.floorsBelow} existing storeys below the planned work`,
        activityIds: [], derived: true,
      });
    }
    if (spec.hasParking) {
      push({
        type: 'parking', category: 'site', tower: tower.name, floorName: null, floorIndex: -1,
        position: [cx, 0.05, -1.6], size: [width + 2.4, 0.1, 3.4],
        label: `${tower.name}: front driveway`, activityIds: [],
      });
    }

    // Site dressing (hedge, trees, path) — visual only, not a survey.
    const siteIds = [];
    push({
      type: 'hedge', category: 'site', tower: tower.name, floorName: null, floorIndex: -1,
      position: [cx, 0.45, depth + 1.1], size: [width + 1.2, 0.9, 0.45],
      label: `${tower.name}: rear hedge`, activityIds: siteIds,
    });
    [[xOffset - 2.2, 0], [xOffset + width + 2.2, 0], [xOffset - 2.2, depth], [xOffset + width + 2.2, depth]].forEach((p, idx) => {
      push({
        type: 'tree', category: 'site', tower: tower.name, floorName: null, floorIndex: -1,
        position: [p[0], 1.1, p[1]], size: [0.35, 2.2, 0.35],
        label: `${tower.name}: tree ${idx + 1}`, activityIds: siteIds, subtype: 'trunk',
      });
      push({
        type: 'tree', category: 'site', tower: tower.name, floorName: null, floorIndex: -1,
        position: [p[0], 2.7, p[1]], size: [1.8, 1.8, 1.8],
        label: `${tower.name}: canopy ${idx + 1}`, activityIds: siteIds, subtype: 'crown',
      });
    });
    // Ground-floor entry sits one storey up, above the lower ground (2184-001).
    const stepCount = 8;
    const rise = H / stepCount;
    const going = 0.36;
    for (let s = 0; s < stepCount; s++) {
      push({
        type: 'step', category: 'site', tower: tower.name, floorName: null, floorIndex: -1,
        position: [cx, rise * (s + 0.5), -(0.2 + (stepCount - s) * going)],
        size: [5.2, rise, going + 0.02],
        label: `${tower.name}: entrance step ${s + 1}`, activityIds: siteIds,
      });
    }
    push({
      type: 'canopy', category: 'structure', tower: tower.name, floorName: null, floorIndex: -1,
      position: [cx, H + 2.65, -0.85], size: [7.2, 0.14, 2.4],
      label: `${tower.name}: ground floor entrance canopy`, activityIds: [],
    });
    push({
      type: 'base', category: 'structure', tower: tower.name, floorName: null, floorIndex: -1,
      position: [cx, 0.1, cz], size: [width + 0.6, 0.2, depth + 0.6],
      label: `${tower.name}: plinth`, activityIds: [],
    });
    [[cx - width / 2 - 1.5, -2.5], [cx + width / 2 + 1.5, -2.5]].forEach((p, idx) => {
      push({
        type: 'column', category: 'site', tower: tower.name, floorName: null, floorIndex: -1,
        position: [p[0], 1.2, p[1]], size: [0.12, 2.4, 0.12],
        label: `${tower.name}: lamp post ${idx + 1}`, activityIds: siteIds,
      });
      push({
        type: 'light', category: 'site', tower: tower.name, floorName: null, floorIndex: -1,
        position: [p[0], 2.5, p[1]], size: [0.3, 0.3, 0.3],
        label: `${tower.name}: lamp ${idx + 1}`, activityIds: siteIds, emit: true,
      });
    });
    [[cx - 3.4, -3.2], [cx + 3.4, -3.2]].forEach((p, idx) => {
      push({
        type: 'tree', category: 'site', tower: tower.name, floorName: null, floorIndex: -1,
        position: [p[0], 1.0, p[1]], size: [0.32, 2.0, 0.32],
        label: `${tower.name}: front tree ${idx + 1}`, activityIds: siteIds, subtype: 'trunk',
      });
      push({
        type: 'tree', category: 'site', tower: tower.name, floorName: null, floorIndex: -1,
        position: [p[0], 2.55, p[1]], size: [1.6, 1.6, 1.6],
        label: `${tower.name}: front canopy ${idx + 1}`, activityIds: siteIds, subtype: 'crown',
      });
    });
    push({
      type: 'hedge', category: 'site', tower: tower.name, floorName: null, floorIndex: -1,
      position: [xOffset - 1.4, 0.4, cz], size: [0.4, 0.8, depth * 0.7],
      label: `${tower.name}: side hedge`, activityIds: siteIds,
    });

    levels.forEach((level, i) => {
      const floor = level.node || { _id: `city-${tower._id}-${level.name}`, name: level.name };
      const y0 = baseHeight + i * H;
      const floorLabel = floor.name;
      const link = (category) => linkFor(floor._id, tower._id, category);
      const meta = {
        tower: tower.name, floorName: floorLabel, floorIndex: i, floorNode: String(floor._id),
        storey: level.storey ?? null,
        skin: level.kind === 'residential' || level.kind === 'refuge' ? 'tower' : 'podium',
      };
      const wallIds = link('masonry');
      const openingIds = link('openings');
      const colIds = link('structure');
      const finishIds = link('finishes');
      const mepIds = link('mep');
      const wallH = H - spec.slabThicknessM;
      const t = spec.wallThicknessM;
      const bayW = width / spec.baysX;
      const bayD = depth / spec.baysZ;

      const nx = spec.baysX + 1;
      const nz = spec.baysZ + 1;
      for (let ix = 0; ix < nx; ix++) {
        for (let iz = 0; iz < nz; iz++) {
          push({
            ...meta, type: 'column', category: 'structure',
            position: [
              xOffset + (ix / spec.baysX) * (width - spec.columnSizeM) + spec.columnSizeM / 2,
              y0 + wallH / 2,
              (iz / spec.baysZ) * (depth - spec.columnSizeM) + spec.columnSizeM / 2,
            ],
            size: [spec.columnSizeM * 0.85, wallH, spec.columnSizeM * 0.85],
            label: `${floorLabel} column ${ix + 1}-${iz + 1}`, activityIds: colIds,
            callout: i === 0 && ix === 1 && iz === 1 ? 'COLUMN' : undefined,
          });
        }
      }

      push({
        ...meta, type: 'slab', category: 'slab',
        position: [cx, y0 + H - spec.slabThicknessM / 2, cz],
        size: [width + 0.16, spec.slabThicknessM, depth + 0.16],
        label: `${floorLabel} slab`, activityIds: link('slab'),
        callout: i === 0 ? 'SLAB' : undefined,
      });

      const beamH = 0.3;
      const beamW = Math.max(0.22, spec.columnSizeM * 0.65);
      const beamY = y0 + wallH - beamH / 2 - 0.02;
      for (let iz = 0; iz <= spec.baysZ; iz++) {
        const z = (iz / spec.baysZ) * (depth - spec.columnSizeM) + spec.columnSizeM / 2;
        push({
          ...meta, type: 'beam', category: 'structure', engineering: true,
          position: [cx, beamY, z],
          size: [width - spec.columnSizeM, beamH, beamW],
          label: `${floorLabel} longitudinal beam ${iz + 1}`, activityIds: colIds,
          callout: i === 0 && iz === 0 ? 'BEAM' : undefined,
        });
      }
      for (let ix = 0; ix <= spec.baysX; ix++) {
        const x = xOffset + (ix / spec.baysX) * (width - spec.columnSizeM) + spec.columnSizeM / 2;
        push({
          ...meta, type: 'beam', category: 'structure', engineering: true,
          position: [x, beamY, cz],
          size: [beamW, beamH, depth - spec.columnSizeM],
          label: `${floorLabel} cross beam ${ix + 1}`, activityIds: colIds,
        });
      }
      // Visible floor band on the facade.
      push({
        ...meta, type: 'band', category: 'slab',
        position: [cx, y0 + H - spec.slabThicknessM / 2, -0.02],
        size: [width + 0.2, spec.slabThicknessM + 0.04, 0.12],
        label: `${floorLabel} slab edge`, activityIds: link('slab'),
      });

      const sides = [
        { key: 'front', axis: 'x', bays: spec.baysX, z: t / 2 },
        { key: 'back', axis: 'x', bays: spec.baysX, z: depth - t / 2 },
        { key: 'left', axis: 'z', bays: spec.baysZ, x: xOffset + t / 2 },
        { key: 'right', axis: 'z', bays: spec.baysZ, x: xOffset + width - t / 2 },
      ];

      const posOn = (side, centre, y, out = 0) => {
        if (side.axis === 'x') {
          const z = side.key === 'front' ? side.z - out : side.z + out;
          return [xOffset + centre, y, z];
        }
        const x = side.key === 'left' ? side.x - out : side.x + out;
        return [x, y, centre];
      };
      const sizeOn = (side, along, high, thick) => (
        side.axis === 'x' ? [along, high, thick] : [thick, high, along]
      );

      for (const side of sides) {
        const span = side.axis === 'x' ? width : depth;
        const bayLen = span / side.bays;
        const pierW = Math.max(0.34, bayLen * 0.18);

        for (let p = 0; p <= side.bays; p++) {
          const centre = p === 0 ? pierW / 2 : p === side.bays ? span - pierW / 2 : p * bayLen;
          push({
            ...meta, type: 'wall', category: 'masonry', side: side.key,
            position: posOn(side, centre, y0 + wallH / 2),
            size: sizeOn(side, pierW, wallH, t),
            label: `${floorLabel} ${side.key} pier ${p + 1}`, activityIds: wallIds,
          });
        }

        for (let b = 0; b < side.bays; b++) {
          const centre = bayLen * (b + 0.5);
          const isEntrance = level.kind === 'ground' && side.key === 'front' && b === Math.floor(side.bays / 2);
          const shop = level.kind === 'ground';
          const slot = level.kind === 'podium' || level.kind === 'lgf';
          const openW = bayLen - pierW;
          const sillH = isEntrance ? 0.08 : shop ? 0.25 : slot ? wallH * 0.45 : 0.85;
          const openH = isEntrance ? wallH * 0.78 : shop ? wallH * 0.68 : slot ? wallH * 0.16 : wallH * 0.52;
          const lintelH = Math.max(0.2, wallH - sillH - openH);

          push({
            ...meta, type: 'wall', category: 'masonry', side: side.key,
            position: posOn(side, centre, y0 + sillH / 2),
            size: sizeOn(side, openW, sillH, t),
            label: `${floorLabel} ${side.key} sill ${b + 1}`, activityIds: wallIds,
          });
          push({
            ...meta, type: 'wall', category: 'masonry', side: side.key,
            position: posOn(side, centre, y0 + wallH - lintelH / 2),
            size: sizeOn(side, openW, lintelH, t),
            label: `${floorLabel} ${side.key} lintel ${b + 1}`, activityIds: wallIds,
          });

          const glassY = y0 + sillH + openH / 2;
          push({
            ...meta, type: isEntrance ? 'door' : 'window', category: 'openings', side: side.key,
            position: posOn(side, centre, glassY, t * 0.32),
            size: sizeOn(side, openW - 0.1, openH - 0.1, 0.045),
            label: `${floorLabel} ${side.key} ${isEntrance ? 'entrance' : `window ${b + 1}`}`,
            activityIds: openingIds,
          });
          if (!level.detail) continue;
          const ft = 0.07;
          const outF = t * 0.48;
          [
            { c: centre, y: y0 + sillH + ft / 2, a: openW, h: ft },
            { c: centre, y: y0 + sillH + openH - ft / 2, a: openW, h: ft },
            { c: centre - openW / 2 + ft / 2, y: glassY, a: ft, h: openH },
            { c: centre + openW / 2 - ft / 2, y: glassY, a: ft, h: openH },
          ].forEach((f, fi) => push({
            ...meta, type: 'frame', category: 'openings', side: side.key,
            position: posOn(side, f.c, f.y, outF),
            size: sizeOn(side, f.a, f.h, 0.08),
            label: `${floorLabel} ${side.key} frame ${b + 1}.${fi}`, activityIds: openingIds,
          }));
          if (!isEntrance) {
            [-openW / 6, openW / 6].forEach((dx, mi) => push({
              ...meta, type: 'mullion', category: 'openings', side: side.key,
              position: posOn(side, centre + dx, glassY, t * 0.45),
              size: sizeOn(side, 0.045, openH - 0.12, 0.04),
              label: `${floorLabel} ${side.key} mullion V ${b + 1}.${mi}`, activityIds: openingIds,
            }));
            push({
              ...meta, type: 'mullion', category: 'openings', side: side.key,
              position: posOn(side, centre, y0 + sillH + openH * 0.62, t * 0.45),
              size: sizeOn(side, openW - 0.14, 0.045, 0.04),
              label: `${floorLabel} ${side.key} mullion H ${b + 1}`, activityIds: openingIds,
            });
            push({
              ...meta, type: 'band', category: 'masonry', side: side.key,
              position: posOn(side, centre, y0 + sillH + 0.035, t * 0.62),
              size: sizeOn(side, openW + 0.16, 0.07, 0.2),
              label: `${floorLabel} ${side.key} sill ledge ${b + 1}`, activityIds: wallIds,
            });
            if (side.key === 'front') {
              push({
                ...meta, type: 'canopy', category: 'structure', side: side.key,
                position: posOn(side, centre, y0 + sillH + openH + 0.05, 0.3),
                size: sizeOn(side, openW + 0.18, 0.06, 0.34),
                label: `${floorLabel} window hood ${b + 1}`, activityIds: wallIds,
              });
            }
          }
        }
      }

      if (level.kind === 'residential' || level.kind === 'refuge') {
        furnishFloor({
          push, meta, y0, wallH, xOffset, width, depth, floorLabel, wallIds, finishIds, openingIds,
          storey: level.storey,
        });
      }

      if (level.detail) {
      const lightIds = mepIds.length ? mepIds : finishIds;
      for (let lx = 0; lx < spec.baysX; lx++) {
        for (let lz = 0; lz < spec.baysZ; lz++) {
          const lxpos = xOffset + (lx + 0.5) * bayW;
          const lzpos = (lz + 0.5) * bayD;
          push({
            ...meta, type: 'light', category: 'mep',
            position: [lxpos, y0 + wallH - 0.06, lzpos],
            size: [0.42, 0.05, 0.42],
            label: `${floorLabel} ceiling light ${lx + 1}-${lz + 1}`,
            activityIds: lightIds, emit: true,
          });
          push({
            ...meta, type: 'light', category: 'mep',
            position: [lxpos, y0 + wallH - 0.22, lzpos],
            size: [0.08, 0.22, 0.08],
            label: `${floorLabel} pendant ${lx + 1}-${lz + 1}`,
            activityIds: lightIds, emit: true,
          });
        }
      }

      // Service risers, corridor mains and flat branches. Hidden until the MEP or engineering view is open.
      serviceNetwork({
        push, meta, y0, H, wallH, xOffset, width, depth, floorLabel, mepIds, colIds,
        residential: level.kind === 'residential' || level.kind === 'refuge', first: i === 0,
      });
      if (i === 0) {
        push({
          ...meta, type: 'board', category: 'mep', subtype: 'board', engineering: true,
          position: [xOffset + t + 0.06, y0 + 1.35, depth * 0.42],
          size: [0.1, 0.62, 0.42],
          label: `${floorLabel} distribution board`, activityIds: mepIds,
        });
      }

      // AC outdoor units on the side wall.
      push({
        ...meta, type: 'ac', category: 'mep',
        position: [xOffset + width + 0.18, y0 + 1.35, depth * 0.35],
        size: [0.28, 0.45, 0.7],
        label: `${floorLabel} AC unit`, activityIds: mepIds,
      });

      }

      const residential = level.kind === 'residential' || level.kind === 'refuge';
      if (spec.balconySide !== 'none' && residential) {
        // One deck per flat bay, not one slab across the whole floor.
        // End bays are the 3 BHK / convertible balcony (5.05 × 1.30). Middle bays are the 2 BHK balcony (3.05 × 1.53).
        const faces = spec.balconySide === 'both' ? ['front', 'back'] : [spec.balconySide];
        for (let b = 0; b < spec.baysX; b++) {
          const end = b === 0 || b === spec.baysX - 1;
          const deckW = end ? 5.05 : 3.05;
          const deckD = end ? spec.balconyDepthM : 1.53;
          const x = xOffset + bayW * (b + 0.5);
          for (const face of faces) {
            const z = face === 'front' ? -deckD / 2 : depth + deckD / 2;
            const railZ = face === 'front' ? -deckD + 0.04 : depth + deckD - 0.04;
            push({
              ...meta, type: 'balcony', category: 'slab', side: face,
              position: [x, y0 + 0.1, z],
              size: [deckW, 0.14, deckD],
              label: `${floorLabel} ${face} balcony ${b + 1} (${end ? '3 BHK 5.05 × 1.30' : '2 BHK 3.05 × 1.53'})`,
              activityIds: link('slab'),
            });
            push({
              ...meta, type: 'railing', subtype: 'glass', category: 'openings', side: face,
              position: [x, y0 + 0.62, railZ],
              size: [deckW - 0.08, 1.05, 0.04],
              label: `${floorLabel} ${face} balcony glass ${b + 1}`, activityIds: openingIds,
            });
            for (const sideX of [x - deckW / 2 + 0.03, x + deckW / 2 - 0.03]) {
              const sideZ = face === 'front' ? -deckD / 2 : depth + deckD / 2;
              push({
                ...meta, type: 'railing', subtype: 'glass', category: 'openings', side: face,
                position: [sideX, y0 + 0.62, sideZ],
                size: [0.04, 1.05, deckD - 0.08],
                label: `${floorLabel} balcony side glass`, activityIds: openingIds,
              });
            }
          }
        }
        // Narrow side balcony on the 3 BHK / convertible (0.90 × 4.08), one each end.
        for (const end of ['left', 'right']) {
          const x = end === 'left' ? xOffset - 0.45 : xOffset + width + 0.45;
          const z = depth * 0.72;
          push({
            ...meta, type: 'balcony', category: 'slab', side: end,
            position: [x, y0 + 0.1, z],
            size: [0.9, 0.14, 4.08],
            label: `${floorLabel} ${end} side balcony 0.90 × 4.08`, activityIds: link('slab'),
          });
          const railX = end === 'left' ? xOffset - 0.86 : xOffset + width + 0.86;
          push({
            ...meta, type: 'railing', subtype: 'glass', category: 'openings', side: end,
            position: [railX, y0 + 0.62, z],
            size: [0.04, 1.05, 3.9],
            label: `${floorLabel} ${end} side balcony glass`, activityIds: openingIds,
          });
        }
        if (level.kind === 'refuge') {
          push({
            ...meta, type: 'band', subtype: 'marker', category: 'masonry', side: 'front',
            position: [cx, y0 + wallH - 0.08, -0.08],
            size: [width, 0.16, 0.08],
            label: `${floorLabel} refuge band`, activityIds: wallIds,
          });
        }
      }

      if (i === levels.length - 1) {
        const ph = 0.7;
        const pt = 0.16;
        const topY = y0 + H + ph / 2;
        [
          { position: [cx, topY, pt / 2], size: [width + 0.1, ph, pt] },
          { position: [cx, topY, depth - pt / 2], size: [width + 0.1, ph, pt] },
          { position: [xOffset + pt / 2, topY, cz], size: [pt, ph, depth] },
          { position: [xOffset + width - pt / 2, topY, cz], size: [pt, ph, depth] },
        ].forEach((p, idx) => push({
          ...meta, type: 'parapet', category: 'masonry',
          ...p, label: `${floorLabel} parapet ${idx + 1}`, activityIds: wallIds,
        }));
        push({
          ...meta, type: 'slab', category: 'slab',
          position: [cx, y0 + H + 0.06, cz],
          size: [width + 0.55, 0.12, depth + 0.55],
          label: `${floorLabel} roof overhang`, activityIds: link('slab'),
        });
        push({
          ...meta, type: 'ac', category: 'mep',
          position: [xOffset + width * 0.74, y0 + H + 0.8, depth * 0.58],
          size: [1.35, 1.05, 1.35],
          label: `${floorLabel} roof tank`, activityIds: mepIds,
        });
        for (let p = 0; p < spec.baysX; p++) {
          push({
            ...meta, type: 'hedge', category: 'site',
            position: [xOffset + bayW * (p + 0.5), y0 + H + 0.45, depth * 0.22],
            size: [1.6, 0.7, 1.1],
            label: `${floorLabel} roof planter ${p + 1}`, activityIds: [],
          });
        }
      }
    });

    // Dark vertical fins between balcony stacks, from the top of the podium to the roof.
    const podiumTop = (2 + CITY_LIFE.podiumFloors) * H;
    const finH = levels.length * H - podiumTop;
    for (let b = 1; b < spec.baysX; b++) {
      const x = xOffset + (b / spec.baysX) * width;
      for (const z of [-0.28, depth + 0.28]) {
        push({
          type: 'fin', subtype: 'fin', category: 'masonry', tower: tower.name, floorName: null, floorIndex: -1,
          position: [x, podiumTop + finH / 2, z],
          size: [0.45, finH, 0.85],
          label: `${tower.name} facade fin ${b}`, activityIds: [],
        });
      }
    }

    xOffset += width + spec.towerGapM;
  }

  // Compact activity payload: enough for the 4D slider and the component drill-down.
  const activityPayload = activities.map((a) => {
    const id = String(a._id);
    const est = estBy.get(id) || [];
    const logsFor = logBy.get(id) || [];
    return {
      id,
      code: a.code,
      name: a.name,
      category: categoryOf(a.name),
      floorNode: a.structureNode ? String(a.structureNode) : null,
      status: a.status,
      health: a.health,
      healthReason: a.metrics?.healthReason || null,
      responsible: a.responsible?.name || null,
      plannedStart: a.plannedStart,
      plannedFinish: a.plannedFinish,
      actualStart: a.metrics?.actualStart || null,
      actualFinish: a.metrics?.actualFinish || null,
      expectedFinish: a.metrics?.expectedFinish || null,
      plannedProgress: a.metrics?.plannedProgress ?? 0,
      actualProgress: a.metrics?.actualProgress ?? 0,
      slipDays: Math.max(0, a.metrics?.scheduleVarianceDays ?? 0),
      plannedQuantity: a.plannedQuantity ?? null,
      unit: a.unit || null,
      history: historyBy.get(id) || [],
      labour: est.flatMap((e) => e.labour || []),
      materials: est.flatMap((e) => e.materials || []),
      estimatedAmount: est.reduce((t, e) => t + (e.amount || 0), 0) || null,
      manpowerReported: logsFor.flatMap((l) => l.manpower || []).reduce((t, m) => t + (m.actual || 0), 0) || null,
      materialsConsumed: logsFor.flatMap((l) => l.materialsConsumed || []),
      linked: usedActivities.has(id),
    };
  });

  const span = activities.length
    ? {
      start: toDay(new Date(Math.min(...activities.map((a) => new Date(a.plannedStart).getTime())))),
      end: toDay(new Date(Math.max(...activities.map((a) => new Date(a.metrics?.expectedFinish || a.plannedFinish).getTime())))),
    }
    : null;

  const planInfo = floorplan ? {
    source: floorplan.source,
    stats: floorplan.stats,
    floors: floorplan.floors,
    floorCount: massing[0]?.levels.filter((l) => l.storey).length || 0,
  } : null;
  if (floorplan) {
    spec.plateAreaSqm = Math.round(width * depth * 10) / 10;
    spec.aspectRatio = Math.round((width / depth) * 100) / 100;
    sources.plateAreaSqm = `imported plan: ${floorplan.source?.originalName || 'floor plan'}`;
    sources.aspectRatio = sources.plateAreaSqm;
    delete sources.baysX;
    delete sources.baysZ;
    sources.stack = `imported plan: ${planInfo.floorCount} storeys above ground; refuge floors ${(floorplan.floors?.refuge || []).join(', ') || 'none'}`;
  }
  return {
    project: { id: String(project._id), code: project.code, name: project.name },
    spec,
    sources,
    floorplan: planInfo,
    stored: Boolean(stored),
    dimensions: {
      plateWidthM: Math.round(width * 10) / 10,
      plateDepthM: Math.round(depth * 10) / 10,
      floorHeightM: H,
      towers: roots.length,
      detailedFloors: massing[0]?.levels.length || 0,
      totalHeightM: Math.round((spec.floorsBelow + (massing[0]?.levels.length || 1)) * H * 10) / 10,
    },
    towers: massing.map(({ tower, levels: towerLevels }) => ({
      id: String(tower._id),
      name: tower.name,
      floors: towerLevels.map((f) => ({ id: f.node ? String(f.node._id) : f.name, name: f.name, storey: f.storey ?? null })),
    })),
    components,
    activities: activityPayload,
    timeline: span && { start: span.start, end: span.end, days: diffDays(span.end, span.start) + 1 },
    categories: COMPONENT_CATEGORIES,
    disclaimer: floorplan
      ? `Generated from the uploaded floor plan (${floorplan.source?.originalName || 'drawing'}): walls, openings, rooms and furniture are read from the drawing, and floors are stacked at ${spec.floorHeightM} m. Structure above the floor plan, facade finishes and anything the drawing does not show are not modelled. It is not a surveyed or BIM model. Activity progress still attaches only to the floors that exist in the schedule.`
      : 'Massing of iTREND City Life from job 2184: long slab (2184-021), balconies both sides (2184-023), stack LGF + Ground + 3 podium + 21 floors (2184-001 Rev D). Floors 4, 9, 14 and 19 are refuge floors. It is not a surveyed or BIM model. Activity progress still attaches only to the floors that exist in the schedule.',
  };
}
