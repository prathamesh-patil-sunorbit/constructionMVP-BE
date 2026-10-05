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

const SQFT_TO_SQM = 0.092903;

export const DEFAULTS = {
  plateAreaSqm: 100,
  aspectRatio: 1.3,
  floorHeightM: 3,
  slabThicknessM: 0.15,
  columnSizeM: 0.45,
  wallThicknessM: 0.28,
  baysX: 3,
  baysZ: 2,
  balconyDepthM: 1.4,
  towerGapM: 12,
  balconySide: 'front',
  hasParking: true,
  wallColor: '#f4e4c8',
};

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

const area = (qty, unit = '') => {
  if (!qty) return null;
  if (/sq\.?\s?f|sqft|sft/i.test(unit)) return qty * SQFT_TO_SQM;
  if (/sq\.?\s?m|sqm|m2/i.test(unit)) return qty;
  return null;
};

// Factor a column count into a plausible grid matching the plate's aspect ratio.
function columnGrid(count, aspect) {
  if (!count || count < 4) return null;
  let best = null;
  for (let nx = 2; nx <= count / 2; nx++) {
    if (count % nx) continue;
    const nz = count / nx;
    if (nz < 2) continue;
    const error = Math.abs((nx - 1) / Math.max(1, nz - 1) - aspect);
    if (!best || error < best.error) best = { nx, nz, error };
  }
  return best;
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

  // Floor plate area from the largest slab/formwork quantity recorded in an area unit.
  const slabActs = activities.filter((a) => categoryOf(a.name) === 'slab' && area(a.plannedQuantity, a.unit));
  const biggest = slabActs.map((a) => ({ a, m2: area(a.plannedQuantity, a.unit) })).sort((x, y) => y.m2 - x.m2)[0];
  const plateAreaSqm = take(
    'plateAreaSqm',
    biggest ? Math.round(biggest.m2 * 10) / 10 : null,
    biggest ? `${biggest.a.plannedQuantity} ${biggest.a.unit} on ${biggest.a.code} (${biggest.a.name})` : null,
  );
  const aspectRatio = take('aspectRatio', null, null);

  // Column grid from a column activity's count.
  const colAct = activities.find((a) => /column/i.test(a.name) && a.plannedQuantity >= 4 && /nos?|no\.|each/i.test(a.unit || 'Nos'));
  const grid = colAct ? columnGrid(colAct.plannedQuantity, aspectRatio) : null;
  const baysX = take('baysX', grid ? grid.nx - 1 : null, colAct && grid ? `${colAct.plannedQuantity} columns on ${colAct.code} → ${grid.nx}×${grid.nz} grid` : null);
  const baysZ = take('baysZ', grid ? grid.nz - 1 : null, colAct && grid ? `${colAct.plannedQuantity} columns on ${colAct.code} → ${grid.nx}×${grid.nz} grid` : null);

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
      balconyDepthM: take('balconyDepthM', null, null),
      towerGapM: take('towerGapM', null, null),
      balconySide: stored?.balconySide || DEFAULTS.balconySide,
      hasParking: stored?.hasParking ?? DEFAULTS.hasParking,
      wallColor: stored?.wallColor || DEFAULTS.wallColor,
    },
    sources,
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

  // Plate dimensions from area and aspect ratio.
  const width = Math.sqrt(spec.plateAreaSqm * spec.aspectRatio);
  const depth = spec.plateAreaSqm / width;
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
    components.push({ id: `c${components.length}`, ...c });
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

  for (const tower of roots) {
    const floors = floorsOf(tower._id);
    const detailed = floors.length ? floors : [tower];
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
    push({
      type: 'step', category: 'site', tower: tower.name, floorName: null, floorIndex: -1,
      position: [cx, 0.12, -0.45], size: [2.2, 0.24, 0.9],
      label: `${tower.name}: entrance steps`, activityIds: siteIds,
    });
    push({
      type: 'canopy', category: 'structure', tower: tower.name, floorName: null, floorIndex: -1,
      position: [cx, 2.55, -0.55], size: [3.2, 0.12, 1.4],
      label: `${tower.name}: entrance canopy`, activityIds: [],
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

    detailed.forEach((floor, i) => {
      const y0 = baseHeight + i * H;
      const floorLabel = floor.name;
      const link = (category) => linkFor(floor._id, tower._id, category);
      const meta = {
        tower: tower.name, floorName: floorLabel, floorIndex: i, floorNode: String(floor._id),
        storey: storeyNumber(floorLabel),
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
          const isEntrance = i === 0 && side.key === 'front' && b === Math.floor(side.bays / 2);
          const openW = bayLen - pierW;
          const sillH = isEntrance ? 0.08 : (i === 0 ? 0.72 : 0.9);
          const openH = isEntrance ? wallH * 0.88 : wallH * 0.56;
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

      // Interior partitions so rooms read through the glass.
      push({
        ...meta, type: 'wall', category: 'masonry',
        position: [cx, y0 + wallH / 2, cz],
        size: [width - t * 2.4, wallH * 0.92, 0.12],
        label: `${floorLabel} internal partition`, activityIds: wallIds,
        callout: i === 0 ? 'WALL' : undefined,
      });
      push({
        ...meta, type: 'wall', category: 'masonry',
        position: [xOffset + width * 0.38, y0 + wallH / 2, cz],
        size: [0.12, wallH * 0.92, depth - t * 2.4],
        label: `${floorLabel} cross wall`, activityIds: wallIds,
      });

      push({
        ...meta, type: 'flooring', category: 'finishes',
        position: [cx, y0 + 0.035, cz],
        size: [width - t * 2.2, 0.05, depth - t * 2.2],
        label: `${floorLabel} floor finish`, activityIds: finishIds,
      });
      push({
        ...meta, type: 'flooring', category: 'finishes', subtype: 'tile', engineering: true,
        position: [xOffset + width * 0.78, y0 + 0.055, depth * 0.78],
        size: [width * 0.32, 0.04, depth * 0.32],
        label: `${floorLabel} bathroom tiles`, activityIds: finishIds,
        callout: i === 0 ? 'TILES' : undefined,
      });

      for (let r = 0; r < spec.baysX; r++) {
        const rx = xOffset + (r + 0.5) * bayW;
        push({
          ...meta, type: 'furniture', category: 'finishes',
          position: [rx, y0 + 0.28, 1.2],
          size: [bayW * 0.4, 0.42, 0.65],
          label: `${floorLabel} sofa ${r + 1}`, activityIds: finishIds,
        });
        push({
          ...meta, type: 'furniture', category: 'finishes',
          position: [rx, y0 + 0.36, 1.85],
          size: [0.38, 0.52, 0.38],
          label: `${floorLabel} table ${r + 1}`, activityIds: finishIds,
        });
      }

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

      // Service risers and branches. Hidden until the viewer opens the engineering cutaway.
      // Vertical runs are a full storey tall so they pass through the slab into the floor above.
      {
        const shaftX = xOffset + width * 0.78;
        const shaftZ = depth * 0.78;
        const dia = 0.08;
        const yMid = y0 + H / 2;
        const pipe = (subtype, position, length, rotation, label, callout) => push({
          ...meta, type: 'pipe', category: 'mep', subtype, engineering: true,
          position, size: [dia, length, dia], rotation, label, activityIds: mepIds, callout,
        });
        push({
          ...meta, type: 'shaft', category: 'structure', engineering: true,
          position: [shaftX, y0 + wallH / 2, shaftZ],
          size: [1.05, wallH * 0.92, 1.05],
          label: `${floorLabel} service shaft`, activityIds: colIds,
          callout: i === 0 ? 'SHAFT' : undefined,
        });
        const riserZ = shaftZ - 0.95;
        pipe('cold', [shaftX - 0.22, yMid, riserZ], H, [0, 0, 0], `${floorLabel} cold-water riser`, i === 0 ? 'PLUMBING PIPE' : undefined);
        pipe('hot', [shaftX, yMid, riserZ], H, [0, 0, 0], `${floorLabel} hot-water riser`, undefined);
        pipe('drain', [shaftX + 0.22, yMid, riserZ], H, [0, 0, 0], `${floorLabel} drainage stack`, i === 0 ? 'DRAINAGE PIPE' : undefined);
        pipe('conduit', [shaftX + 0.55, yMid, shaftZ], H * 0.92, [0, 0, 0], `${floorLabel} electrical riser`, undefined);

        const bathX = shaftX - 0.55;
        const run = Math.abs(bathX - (shaftX - 0.22));
        pipe('cold', [(bathX + shaftX - 0.22) / 2, y0 + 1.15, riserZ], run, [0, 0, Math.PI / 2], `${floorLabel} cold branch`, undefined);
        pipe('hot', [(bathX + shaftX) / 2, y0 + 1.0, riserZ], Math.abs(bathX - shaftX) || 0.2, [0, 0, Math.PI / 2], `${floorLabel} hot branch`, undefined);
        pipe('drain', [shaftX + 0.22, y0 + 0.28, (riserZ + shaftZ) / 2], Math.abs(shaftZ - riserZ), [Math.PI / 2, 0, 0], `${floorLabel} waste branch`, undefined);
        pipe('cold', [bathX, y0 + 0.62, riserZ], 1.05, [0, 0, 0], `${floorLabel} bathroom drop`, undefined);

        const kitX = xOffset + width * 0.55;
        const kitZ = depth * 0.28;
        const kitRun = Math.abs(kitZ - riserZ);
        pipe('cold', [shaftX - 0.22, y0 + 0.9, (kitZ + riserZ) / 2], kitRun, [Math.PI / 2, 0, 0], `${floorLabel} kitchen cold`, undefined);
        pipe('drain', [kitX, y0 + 0.22, (kitZ + depth * 0.5) / 2], Math.abs(kitZ - depth * 0.5), [Math.PI / 2, 0, 0], `${floorLabel} kitchen waste`, undefined);

        const ceilY = y0 + wallH - 0.35;
        pipe('conduit', [cx, ceilY, depth * 0.35], width * 0.72, [0, 0, Math.PI / 2], `${floorLabel} ceiling conduit`, i === 0 ? 'ELECTRICAL CONDUIT' : undefined);
        pipe('conduit', [cx, ceilY - 0.12, depth * 0.62], width * 0.55, [0, 0, Math.PI / 2], `${floorLabel} ceiling conduit 2`, undefined);
        if (i === 0) {
          push({
            ...meta, type: 'board', category: 'mep', subtype: 'board', engineering: true,
            position: [xOffset + t + 0.06, y0 + 1.35, depth * 0.42],
            size: [0.1, 0.62, 0.42],
            label: `${floorLabel} distribution board`, activityIds: mepIds,
          });
        }
      }

      // AC outdoor units on the side wall.
      push({
        ...meta, type: 'ac', category: 'mep',
        position: [xOffset + width + 0.18, y0 + 1.35, depth * 0.35],
        size: [0.28, 0.45, 0.7],
        label: `${floorLabel} AC unit`, activityIds: mepIds,
      });

      // Straight flight inside the plate, clear of the front windows so the
      // steps do not punch through the glazing. Treads only — not a solid core.
      {
        const stepCount = 14;
        const rise = wallH / stepCount;
        const going = 0.26;
        const stairW = 1.05;
        const flight = stepCount * going;
        const x = xOffset + t + 0.7 + stairW / 2;
        const zStart = Math.max(t + 1.4, (depth - flight) / 2);
        for (let s = 0; s < stepCount; s++) {
          push({
            ...meta, type: 'stair', category: 'structure',
            position: [x, y0 + rise * (s + 1), zStart + s * going + going / 2],
            size: [stairW, 0.06, going + 0.01],
            label: `${floorLabel} tread ${s + 1}`, activityIds: colIds,
          });
        }
        const railZ0 = zStart;
        const railZ1 = zStart + flight;
        const railPosts = 5;
        for (let p = 0; p < railPosts; p++) {
          const z = railZ0 + (p / (railPosts - 1)) * (railZ1 - railZ0);
          const y = y0 + (p / (railPosts - 1)) * wallH + 0.45;
          push({
            ...meta, type: 'railing', category: 'openings',
            position: [x + stairW / 2 - 0.04, y, z],
            size: [0.04, 0.9, 0.04],
            label: `${floorLabel} stair post ${p + 1}`, activityIds: openingIds,
          });
        }
        push({
          ...meta, type: 'railing', category: 'openings',
          position: [x + stairW / 2 - 0.04, y0 + wallH / 2 + 0.85, zStart + flight / 2],
          size: [0.04, 0.04, flight],
          rotation: [-Math.atan2(wallH, flight), 0, 0],
          label: `${floorLabel} stair handrail`, activityIds: openingIds,
        });
      }

      if (spec.balconySide !== 'none' && i > 0) {
        const faces = spec.balconySide === 'both' ? ['front', 'back'] : [spec.balconySide];
        for (const face of faces) {
          const bz = face === 'front' ? -spec.balconyDepthM / 2 : depth + spec.balconyDepthM / 2;
          const bw = width * 0.55;
          push({
            ...meta, type: 'balcony', category: 'slab', side: face,
            position: [cx, y0 + 0.08, bz],
            size: [bw, 0.12, spec.balconyDepthM],
            label: `${floorLabel} ${face} balcony deck`, activityIds: link('slab'),
          });
          const railZ = face === 'front' ? bz - spec.balconyDepthM / 2 + 0.04 : bz + spec.balconyDepthM / 2 - 0.04;
          push({
            ...meta, type: 'railing', category: 'openings', side: face,
            position: [cx, y0 + 0.58, railZ],
            size: [bw, 0.04, 0.04],
            label: `${floorLabel} balcony rail`, activityIds: openingIds,
          });
          const posts = 6;
          for (let p = 0; p < posts; p++) {
            const px = cx - bw / 2 + (p / (posts - 1)) * bw;
            push({
              ...meta, type: 'railing', category: 'openings', side: face,
              position: [px, y0 + 0.35, railZ],
              size: [0.04, 0.5, 0.04],
              label: `${floorLabel} balcony post ${p + 1}`, activityIds: openingIds,
            });
          }
        }
      }

      if (i === detailed.length - 1) {
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
      }
    });

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

  return {
    project: { id: String(project._id), code: project.code, name: project.name },
    spec,
    sources,
    stored: Boolean(stored),
    dimensions: {
      plateWidthM: Math.round(width * 10) / 10,
      plateDepthM: Math.round(depth * 10) / 10,
      floorHeightM: H,
      towers: roots.length,
      detailedFloors: allFloors.length,
      totalHeightM: Math.round((spec.floorsBelow + Math.max(1, floorsOf(roots[0]?._id).length || 1)) * H * 10) / 10,
    },
    towers: roots.map((t) => ({
      id: String(t._id),
      name: t.name,
      floors: floorsOf(t._id).map((f) => ({ id: String(f._id), name: f.name, storey: storeyNumber(f.name) })),
    })),
    components,
    activities: activityPayload,
    timeline: span && { start: span.start, end: span.end, days: diffDays(span.end, span.start) + 1 },
    categories: COMPONENT_CATEGORIES,
    disclaimer: 'Parametric massing model generated from the activity plan and recorded quantities. It is an approximate representation for progress visualisation, not an architectural or BIM model, and it carries no surveyed or design accuracy.',
  };
}
