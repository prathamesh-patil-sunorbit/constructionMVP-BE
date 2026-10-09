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

/**
 * Building services for one imported storey: risers beside each lift core, mains across the plate
 * through every core lobby plus a spine joining the cores, and L-shaped branches from the nearest
 * main into every room. Everything is `engineering`, so it only shows in the MEP / engineering views.
 * Labels name the flat as "unit", not "flat NN", so services do not join a flat's hit box.
 */
export function addPlanServices({ push, plan, meta, y0, H, slabT, xOffset, floorLabel, mepIds, rooms, first }) {
  const wallH = H - slabT;
  const ceilY = y0 + wallH - 0.22;
  const X = (x) => round(xOffset + x);
  const base = { ...meta, category: 'mep', engineering: true, activityIds: mepIds };
  const pipe = (subtype, x, y, z, length, rotation, dia, label, callout) => push({
    ...base, type: 'pipe', subtype, position: [X(x), round(y), round(z)], size: [dia, round(Math.max(0.05, length)), dia],
    rotation, label, ...(callout ? { callout } : {}),
  });
  const runX = (subtype, a, b, y, z, dia, label, callout) => pipe(subtype, (a + b) / 2, y, z, Math.abs(b - a), [0, 0, Math.PI / 2], dia, label, callout);
  const runZ = (subtype, x, y, a, b, dia, label) => pipe(subtype, x, y, (a + b) / 2, Math.abs(b - a), [Math.PI / 2, 0, 0], dia, label);
  const runY = (subtype, x, a, b, z, dia, label) => pipe(subtype, x, (a + b) / 2, z, Math.abs(b - a), [0, 0, 0], dia, label);
  const duct = (subtype, x, y, z, size, label, callout) => push({
    ...base, type: 'duct', subtype, position: [X(x), round(y), round(z)], size: size.map(round), label, ...(callout ? { callout } : {}),
  });
  const ductX = (subtype, a, b, y, z, w, h, label, callout) => duct(subtype, (a + b) / 2, y, z, [Math.abs(b - a), h, w], label, callout);
  const ductZ = (subtype, x, y, a, b, w, h, label) => duct(subtype, x, y, (a + b) / 2, [w, h, Math.abs(b - a)], label);

  // Lift cores: lifts closer than 6 m belong to the same core.
  const cores = [];
  for (const l of plan.lifts) {
    const core = cores.find((c) => Math.hypot(c.cx - l.cx, c.cz - l.cz) < 6);
    if (core) {
      core.x1 = Math.max(core.x1, l.cx + l.w / 2);
      core.lifts.push(l);
      core.cx = core.lifts.reduce((t, k) => t + k.cx, 0) / core.lifts.length;
      core.cz = core.lifts.reduce((t, k) => t + k.cz, 0) / core.lifts.length;
    } else {
      cores.push({ cx: l.cx, cz: l.cz, x1: l.cx + l.w / 2, lifts: [l] });
    }
  }
  if (!cores.length) cores.push({ cx: plan.widthM / 2, cz: plan.depthM / 2, x1: plan.widthM / 2 + 1 });
  cores.sort((a, b) => a.cz - b.cz);

  const a = 1.2;
  const b = plan.widthM - 1.2;
  const mains = [];
  cores.forEach((core, ci) => {
    const z = core.cz;
    const tag = `${floorLabel} core ${ci + 1}`;
    const lead = first && ci === 0;
    ductX('supply', a, b, ceilY - 0.02, z - 0.4, 0.55, 0.3, `${tag} AC supply duct main`, lead ? 'AC SUPPLY DUCT' : undefined);
    ductX('return', a, b, ceilY - 0.04, z + 0.45, 0.45, 0.26, `${tag} return air duct main`, lead ? 'RETURN AIR DUCT' : undefined);
    runX('sprinkler', a, b, ceilY - 0.32, z - 0.05, 0.11, `${tag} sprinkler main`, lead ? 'FIRE SPRINKLER' : undefined);
    ductX('tray', a, b, ceilY - 0.34, z + 0.5, 0.3, 0.07, `${tag} cable tray`, lead ? 'CABLE TRAY' : undefined);
    runX('cold', a, b, ceilY - 0.46, z - 0.5, 0.09, `${tag} domestic water main`, lead ? 'PLUMBING PIPE' : undefined);
    runX('hot', a, b, ceilY - 0.46, z - 0.3, 0.07, `${tag} hot water main`);
    mains.push({ axis: 'x', at: z, a, b });

    // Risers just past the lifts, full storey height so they run through the slab.
    const rx = core.x1 + 0.7;
    push({
      ...meta, type: 'shaft', category: 'structure', engineering: true,
      position: [X(rx + 0.25), round(y0 + wallH / 2), round(z)], size: [1.2, round(wallH * 0.94), 1.4],
      label: `${tag} service shaft`, activityIds: mepIds, ...(lead ? { callout: 'SHAFT' } : {}),
    });
    runY('sprinkler', rx, y0, y0 + H, z - 0.5, 0.15, `${tag} fire riser`);
    runY('cold', rx + 0.25, y0, y0 + H, z - 0.5, 0.12, `${tag} water riser`);
    runY('hot', rx + 0.5, y0, y0 + H, z - 0.5, 0.09, `${tag} hot water riser`);
    runY('drain', rx, y0, y0 + H, z + 0.5, 0.15, `${tag} soil stack`);
    runY('conduit', rx + 0.5, y0, y0 + H, z + 0.5, 0.1, `${tag} electrical riser`);
    duct('supply', rx + 0.25, y0 + H / 2, z, [0.45, H, 0.35], `${tag} AC duct riser`);
  });
  // Spine between neighbouring cores.
  for (let ci = 1; ci < cores.length; ci++) {
    const z0 = cores[ci - 1].cz;
    const z1 = cores[ci].cz;
    const x = Math.max(cores[ci - 1].x1, cores[ci].x1) + 2;
    ductZ('supply', x, ceilY - 0.02, z0, z1, 0.5, 0.3, `${floorLabel} AC supply spine`);
    runZ('sprinkler', x + 0.45, ceilY - 0.32, z0, z1, 0.1, `${floorLabel} sprinkler spine`);
    runZ('cold', x - 0.45, ceilY - 0.46, z0, z1, 0.08, `${floorLabel} water spine`);
    ductZ('tray', x + 0.75, ceilY - 0.34, z0, z1, 0.3, 0.07, `${floorLabel} cable tray spine`);
    mains.push({ axis: 'z', at: x, a: Math.min(z0, z1), b: Math.max(z0, z1) });
  }

  if (!rooms) return;

  const nearest = (x, z) => {
    let best = null;
    for (const m of mains) {
      const px = m.axis === 'x' ? Math.min(m.b, Math.max(m.a, x)) : m.at;
      const pz = m.axis === 'x' ? m.at : Math.min(m.b, Math.max(m.a, z));
      const d = Math.hypot(px - x, pz - z);
      if (!best || d < best.d) best = { m, px, pz, d };
    }
    return best;
  };
  // An L from the nearest main to (x, z): across the main first, then along it. `off` keeps systems apart.
  const branch = (subtype, x, z, y, off, dia, label, box) => {
    const hit = nearest(x, z);
    if (!hit) return;
    if (hit.m.axis === 'x') {
      const bx = x + off;
      if (Math.abs(z - hit.pz) > 0.1) {
        if (box) ductZ(subtype, bx, y, hit.pz, z, dia, dia * 0.7, label);
        else runZ(subtype, bx, y, hit.pz, z, dia, label);
      }
      if (Math.abs(bx - hit.px) > 0.1 && hit.px !== x) {
        if (box) ductX(subtype, hit.px, bx, y, hit.pz, dia, dia * 0.7, `${label} take-off`);
        else runX(subtype, hit.px, bx, y, hit.pz, dia, `${label} take-off`);
      }
    } else {
      const bz = z + off;
      if (Math.abs(x - hit.px) > 0.1) {
        if (box) ductX(subtype, hit.px, x, y, bz, dia, dia * 0.7, label);
        else runX(subtype, hit.px, x, y, bz, dia, label);
      }
      if (Math.abs(bz - hit.pz) > 0.1 && hit.pz !== z) {
        if (box) ductZ(subtype, hit.px, y, hit.pz, bz, dia, dia * 0.7, `${label} take-off`);
        else runZ(subtype, hit.px, y, hit.pz, bz, dia, `${label} take-off`);
      }
    }
  };

  for (const room of plan.rooms) {
    if (!room.flat || ['balcony', 'utility', 'lift', 'stair'].includes(room.kind)) continue;
    const [bx, bz, bw, bd] = room.bbox;
    const x = bx + bw / 2;
    const z = bz + bd / 2;
    const tag = `${floorLabel} unit ${room.flat} ${room.name.toLowerCase()}`;
    const wet = room.kind === 'bath' || room.kind === 'kitchen';
    if (room.kind === 'passage') {
      branch('sprinkler', x, z, ceilY - 0.32, 0.3, 0.08, `${tag} sprinkler branch`);
      continue;
    }
    if (!wet || room.kind === 'kitchen') {
      branch('sprinkler', x, z, ceilY - 0.32, 0.3, 0.08, `${tag} sprinkler branch`);
      runY('sprinkler', x + 0.3, ceilY - 0.6, ceilY - 0.32, z, 0.07, `${tag} sprinkler head`);
    }
    if (!wet) {
      branch('supply', x, z, ceilY - 0.02, 0, 0.32, `${tag} AC supply branch`, true);
      duct('diffuser', x, ceilY - 0.17, z, [0.55, 0.06, 0.55], `${tag} supply diffuser`);
      branch('conduit', x, z, ceilY - 0.12, -0.35, 0.06, `${tag} lighting conduit`);
      continue;
    }
    // Wet rooms: water in, waste stack down through every floor, exhaust out.
    const px = bx + Math.min(0.35, bw / 3);
    const pz = bz + Math.min(0.35, bd / 3);
    branch('cold', px, pz, ceilY - 0.46, 0.45, 0.08, `${tag} cold water branch`);
    runY('cold', px + 0.45, y0 + 0.45, ceilY - 0.46, pz, 0.08, `${tag} cold water drop`);
    if (room.kind === 'bath') {
      branch('hot', px, pz, ceilY - 0.46, 0.6, 0.07, `${tag} hot water branch`);
      runY('hot', px + 0.6, y0 + 0.45, ceilY - 0.46, pz, 0.07, `${tag} hot water drop`);
    }
    runY('drain', bx + bw - 0.2, y0, y0 + H, bz + 0.2, 0.11, `${tag} waste stack`);
    duct('exhaust', x, ceilY - 0.1, z, [Math.max(0.3, bw * 0.7), 0.16, 0.2], `${tag} exhaust duct`);
  }
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
    addPlanServices({
      push,
      plan: floorplan.plans[level.plan] || floorplan.plans.typical,
      meta,
      y0: i * H,
      H,
      slabT,
      xOffset,
      floorLabel: floor.name,
      mepIds: link('mep'),
      rooms: level.kind !== 'ground' && level.kind !== 'podium',
      first: i === 0,
    });
  });
}
