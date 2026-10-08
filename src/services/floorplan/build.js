// Stacks an imported floor plan into a tower: one set of components per storey, in the same shape
// the parametric City Life generator emits, so the viewer, the 4D timeline and the component
// drill-down all work unchanged.

const round = (n) => Math.round(n * 100) / 100;

// Facade tints in vertical blocks, like the differently shaded towers on the elevation render.
const FACADE = ['#f3ede2', '#dfe7f1', '#f8f8f5', '#d4dce8', '#efe4d2'];
const facadeTint = (x, z) => FACADE[(Math.floor(x / 7) + Math.floor(z / 17)) % FACADE.length];

// Floor numbers each plan applies to, from the drawing's "TYPICAL FLOORS - ..." notes.
export function planLevels(floorplan, dbFloors) {
  const byName = new Map(dbFloors.map((f) => [f.name, f]));
  const refuge = new Set(floorplan.floors?.refuge || []);
  const listed = [...(floorplan.floors?.typical || []), ...(floorplan.floors?.refuge || [])];
  const top = Math.max(floorplan.floorCount || 0, ...listed, 1);
  const hasRefuge = Boolean(floorplan.plans.refuge);
  const levels = [{ name: 'Ground', kind: 'ground', plan: 'typical' }, { name: 'Podium', kind: 'podium', plan: 'typical' }];
  for (let n = 1; n <= top; n++) {
    const isRefuge = hasRefuge && refuge.has(n);
    levels.push({ name: `Floor ${n}`, kind: isRefuge ? 'refuge' : 'residential', storey: n, plan: isRefuge ? 'refuge' : 'typical' });
  }
  return levels.map((l) => ({ ...l, node: byName.get(l.name) || null, detail: Boolean(byName.get(l.name)) }));
}

export function planFootprint(floorplan) {
  const p = floorplan.plans.typical;
  return { width: p.widthM, depth: p.depthM };
}

/**
 * Components for one storey.
 * @param {object} a.plan   interpreted sheet (see plan.js)
 * @param {boolean} a.furnish  emit rooms, furniture and interior walls (large; viewer hides them until a floor is opened)
 */
export function addPlanStorey({ push, plan, meta, y0, H, slabT, xOffset, floorLabel, kind, ids, furnish, top }) {
  const wallH = H - slabT;
  const X = (cx) => round(xOffset + cx);
  const podium = kind === 'ground' || kind === 'podium';
  // Refuge floors get a warm band so they read as a stripe on the facade.
  const tint = (x, z) => (kind === 'refuge' ? '#ecdfc2' : facadeTint(x, z));

  for (const [x, z, w, d] of plan.slab) {
    push({
      ...meta, type: 'slab', category: 'slab',
      position: [X(x + w / 2), round(y0 + H - slabT / 2), round(z + d / 2)],
      size: [round(w + 0.04), slabT, round(d + 0.04)],
      label: `${floorLabel} slab`, activityIds: ids.slab,
    });
  }

  for (const c of plan.columns) {
    push({
      ...meta, type: 'column', category: 'structure',
      position: [X(c.cx), round(y0 + wallH / 2), c.cz],
      size: [c.w, wallH, c.d],
      label: `${floorLabel} column`, activityIds: ids.structure,
    });
  }

  for (const w of plan.walls) {
    if (!w.exterior && !furnish) continue;
    push({
      ...meta, type: 'wall', category: 'masonry',
      position: [X(w.cx), round(y0 + wallH / 2), w.cz],
      size: [w.w, wallH, w.d],
      ...(w.exterior && !podium ? { color: tint(w.cx, w.cz) } : {}),
      label: w.exterior ? `${floorLabel} facade wall` : w.flat ? `${floorLabel} flat ${w.flat} wall` : `${floorLabel} core wall`,
      activityIds: ids.masonry,
    });
  }

  // Parapets at balcony edges, and a roof parapet on the top storey.
  for (const p of plan.parapets) {
    push({
      ...meta, type: 'parapet', category: 'masonry', ...(podium ? {} : { subtype: 'glass' }),
      position: [X(p.cx), round(y0 + 0.5), p.cz],
      size: [p.w, 1.0, p.d],
      label: `${floorLabel} balcony parapet`, activityIds: ids.masonry,
    });
  }
  if (top) {
    for (const p of plan.parapets) {
      push({
        ...meta, type: 'parapet', category: 'masonry', subtype: 'gold',
        position: [X(p.cx), round(y0 + H + 0.9), p.cz],
        size: [round(p.w + 0.1), 1.8, round(p.d + 0.1)],
        label: `${floorLabel} roof crown`, activityIds: ids.masonry,
      });
    }
  }

  plan.openings.forEach((o) => {
    const alongX = o.w >= o.d;
    const len = Math.max(o.w, o.d);
    const thick = podium ? 0.2 : 0.23;
    const dims = (along, high, t) => (alongX ? [along, high, t] : [t, high, along]);
    const where = o.exterior ? null : o.flat;
    const tag = where ? `${floorLabel} flat ${where}` : o.exterior ? floorLabel : `${floorLabel} core`;
    if (o.type === 'window') {
      if (!o.exterior && !furnish) return;
      const full = len >= 1.7;
      const sill = full ? 0.12 : 0.9;
      const head = 2.1;
      push({
        ...meta, type: 'window', category: 'openings',
        position: [X(o.cx), round(y0 + (sill + head) / 2), o.cz],
        size: dims(round(len), round(head - sill), 0.06),
        label: `${tag} ${o.room ? `${o.room} ` : ''}window`, activityIds: ids.openings,
      });
      if (!full) {
        push({
          ...meta, type: 'wall', category: 'masonry',
          position: [X(o.cx), round(y0 + sill / 2), o.cz],
          size: dims(round(len), sill, thick),
          ...(o.exterior && !podium ? { color: tint(o.cx, o.cz) } : {}),
          label: o.exterior ? `${floorLabel} facade wall` : `${tag} wall`, activityIds: ids.masonry,
        });
      }
      push({
        ...meta, type: 'wall', category: 'masonry',
        position: [X(o.cx), round(y0 + (head + wallH) / 2), o.cz],
        size: dims(round(len), round(wallH - head), thick),
        ...(o.exterior && !podium ? { color: tint(o.cx, o.cz) } : {}),
        label: o.exterior ? `${floorLabel} facade wall` : `${tag} wall`, activityIds: ids.masonry,
      });
    } else {
      if (!furnish) return;
      const leaf = Math.min(len, 1.05);
      push({
        ...meta, type: 'door', category: 'openings',
        position: [X(o.cx), round(y0 + 1.05), o.cz],
        size: dims(round(leaf), 2.1, 0.05),
        label: `${tag} door`, activityIds: ids.openings,
      });
      push({
        ...meta, type: 'wall', category: 'masonry',
        position: [X(o.cx), round(y0 + (2.1 + wallH) / 2), o.cz],
        size: dims(round(len), round(wallH - 2.1), thick),
        label: `${tag} wall`, activityIds: ids.masonry,
      });
    }
  });

  if (!furnish) return;

  // Finish under the corridors, lobbies and cores, which no room label covers. Room floors sit above it.
  for (const [x, z, w, d] of plan.slab) {
    push({
      ...meta, type: 'flooring', subtype: 'tile', category: 'finishes',
      position: [X(x + w / 2), round(y0 + 0.012), round(z + d / 2)],
      size: [round(w), 0.024, round(d)],
      label: `${floorLabel} corridor floor`, activityIds: ids.finishes,
    });
  }

  for (const room of plan.rooms) {
    if (['balcony', 'utility', 'lift', 'stair'].includes(room.kind) && !room.flat) continue;
    const tag = room.flat ? `${floorLabel} flat ${room.flat} ${room.name}` : `${floorLabel} corridor ${room.name}`;
    const subtype = room.kind === 'bath' ? 'bath' : room.kind === 'kitchen' ? 'kitchen-tile' : room.kind === 'passage' ? 'tile' : undefined;
    for (const [x, z, w, d] of room.rects) {
      push({
        ...meta, type: 'flooring', subtype, category: 'finishes',
        position: [X(x + w / 2), round(y0 + 0.03), round(z + d / 2)],
        size: [round(Math.max(0.1, w - 0.04)), 0.04, round(Math.max(0.1, d - 0.04))],
        label: tag, activityIds: ids.finishes,
      });
    }
  }

  for (const f of plan.furniture) {
    push({
      ...meta, type: 'furniture', subtype: f.subtype, category: 'finishes',
      position: [X(f.cx), round(y0 + 0.04 + f.h / 2), f.cz],
      size: [f.w, f.h, f.d],
      ...(f.rot ? { rotation: f.rot } : {}),
      label: `${floorLabel} ${f.flat ? `flat ${f.flat}` : 'common'} ${f.room || ''} ${f.subtype}`.replace(/\s+/g, ' '),
      activityIds: ids.finishes,
    });
  }

  for (const lift of plan.lifts) {
    push({
      ...meta, type: 'base', subtype: 'lift', category: 'structure',
      position: [X(lift.cx), round(y0 + wallH * 0.45), lift.cz],
      size: [lift.w, round(wallH * 0.9), lift.d],
      label: `${floorLabel} core lift`, activityIds: ids.masonry,
    });
  }
  plan.stairs.forEach((s, si) => {
    const run = s.axis === 'x' ? s.w : s.d;
    const across = s.axis === 'x' ? s.d : s.w;
    const step = run / s.steps;
    for (let i = 0; i < s.steps; i++) {
      const along = -run / 2 + step * (i + 0.5);
      push({
        ...meta, type: 'stair', category: 'structure',
        position: [X(s.cx + (s.axis === 'x' ? along : 0)), round(y0 + 0.1 + (i * (H - 0.4)) / s.steps / 2), round(s.cz + (s.axis === 'z' ? along : 0))],
        size: s.axis === 'x' ? [round(step - 0.02), 0.08, round(across * 0.9)] : [round(across * 0.9), 0.08, round(step - 0.02)],
        label: `${floorLabel} core stair ${si + 1} tread ${i + 1}`, activityIds: ids.structure,
      });
    }
  });
}

/** One tower built from the imported plan: site dressing plus every storey. */
export function addPlanTower({ push, tower, levels, floorplan, xOffset, spec, linkFor, furnishAll = true }) {
  const { width, depth } = planFootprint(floorplan);
  const H = spec.floorHeightM;
  const slabT = spec.slabThicknessM;
  const cx = xOffset + width / 2;
  const cz = depth / 2;
  const site = { tower: tower.name, floorName: null, floorIndex: -1, category: 'site', activityIds: [] };

  push({ ...site, type: 'base', category: 'structure', position: [round(cx), 0.1, round(cz)], size: [round(width + 0.6), 0.2, round(depth + 0.6)], label: `${tower.name}: plinth`, derived: true });
  [[xOffset - 2.2, -2.2], [xOffset + width + 2.2, -2.2], [xOffset - 2.2, depth + 2.2], [xOffset + width + 2.2, depth + 2.2]].forEach(([x, z], i) => {
    push({ ...site, type: 'tree', subtype: 'trunk', position: [round(x), 1.1, round(z)], size: [0.35, 2.2, 0.35], label: `${tower.name}: tree ${i + 1}` });
    push({ ...site, type: 'tree', subtype: 'crown', position: [round(x), 2.7, round(z)], size: [1.8, 1.8, 1.8], label: `${tower.name}: canopy ${i + 1}` });
  });

  const podiumLevels = levels.filter((l) => l.kind === 'ground' || l.kind === 'podium').length;
  const podiumTop = podiumLevels * H;
  const towerH = (levels.length - podiumLevels) * H;
  const typical = floorplan.plans.typical;

  // Gold vertical fins at the ends of the balcony runs, one tall piece per position (not per floor),
  // rising a little above the roof like the crown on the elevation render.
  const fins = new Map();
  for (const q of typical.parapets) {
    if (Math.max(q.w, q.d) < 2) continue;
    const alongX = q.w >= q.d;
    for (const sign of [-1, 1]) {
      const fx = alongX ? q.cx + (sign * q.w) / 2 : q.cx;
      const fz = alongX ? q.cz : q.cz + (sign * q.d) / 2;
      const key = `${Math.round(fx / 1.8)}:${Math.round(fz / 1.8)}`;
      if (!fins.has(key)) fins.set(key, { fx, fz, alongX, span: alongX ? q.d : q.w });
    }
  }
  for (const f of fins.values()) {
    const height = towerH + 3;
    push({
      tower: tower.name, floorName: null, floorIndex: -1, category: 'masonry', activityIds: [],
      type: 'fin', subtype: 'gold',
      position: [round(xOffset + f.fx), round(podiumTop + height / 2), round(f.fz)],
      size: f.alongX ? [0.55, height, round(Math.max(0.5, f.span) + 0.6)] : [round(Math.max(0.5, f.span) + 0.6), height, 0.55],
      label: `${tower.name} facade fin`,
    });
  }

  // Podium deck on the front with a pool, hedges and trees, as on the render.
  const deckD = 14;
  const deckW = width + 8;
  const deckZ = depth + deckD / 2 - 0.5;
  push({ ...site, type: 'band', category: 'structure', skin: 'podium', position: [round(cx), round(podiumTop / 2), round(deckZ)], size: [round(deckW), round(podiumTop), deckD], label: `${tower.name}: podium front` });
  push({ ...site, type: 'band', category: 'structure', subtype: 'gold', position: [round(cx), round(podiumTop + 0.1), round(deckZ)], size: [round(deckW + 0.4), 0.2, deckD + 0.4], label: `${tower.name}: podium deck edge` });
  push({ ...site, type: 'base', subtype: 'pool', position: [round(cx + width * 0.12), round(podiumTop + 0.18), round(depth + 6)], size: [round(Math.min(18, width * 0.4)), 0.16, 5.5], label: `${tower.name}: swimming pool` });
  for (let k = 0; k < 6; k++) {
    const tx = xOffset - 2 + (k + 0.5) * ((width + 4) / 6);
    const tz = depth + 12;
    push({ ...site, type: 'tree', subtype: 'trunk', position: [round(tx), round(podiumTop + 0.9), round(tz)], size: [0.3, 1.8, 0.3], label: `${tower.name}: deck tree ${k + 1}` });
    push({ ...site, type: 'tree', subtype: 'crown', position: [round(tx), round(podiumTop + 2.6), round(tz)], size: [2.2, 2.2, 2.2], label: `${tower.name}: deck canopy ${k + 1}` });
  }
  push({ ...site, type: 'hedge', position: [round(cx), round(podiumTop + 0.5), round(depth + deckD - 1)], size: [round(deckW - 1), 0.8, 0.7], label: `${tower.name}: deck hedge` });

  levels.forEach((level, i) => {
    const floor = level.node || { _id: `plan-${tower._id}-${level.name}`, name: level.name };
    const link = (category) => linkFor(floor._id, tower._id, category);
    const meta = {
      tower: tower.name, floorName: floor.name, floorIndex: i, floorNode: String(floor._id),
      storey: level.storey ?? null,
      skin: level.kind === 'ground' || level.kind === 'podium' ? 'podium' : 'tower',
    };
    addPlanStorey({
      push,
      plan: floorplan.plans[level.plan] || floorplan.plans.typical,
      meta,
      y0: i * H,
      H,
      slabT,
      xOffset,
      floorLabel: floor.name,
      kind: level.kind,
      ids: { slab: link('slab'), structure: link('structure'), masonry: link('masonry'), openings: link('openings'), finishes: link('finishes') },
      furnish: level.kind !== 'ground' && level.kind !== 'podium' && (furnishAll || level.detail),
      top: i === levels.length - 1,
    });
  });
}
