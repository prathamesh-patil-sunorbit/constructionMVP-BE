// Turns the flattened drawing into a floor plan the 3D builder can extrude.
//
// Everything is read from the drawing itself: wall outlines become boxes, door and window
// blocks become openings, "BED ROOM 1 3.05X3.65" labels become rooms, and the furniture blocks
// the architect drew are classified by the room they sit in. Rooms the drawing leaves bare get a
// simple template layout so the flat still reads as furnished.
//
// Output coordinates are metres. x runs along the sheet, z runs down the sheet (the plan as you
// see it from above), so the 3D scene needs no mirroring.

import { Grid, cellsToMask } from './grid.js';

const LAYERS = {
  wall: /wall/i,
  skipWall: /parapet|retaining|stair/i,
  parapet: /parapet/i,
  door: /door/i,
  window: /window|glaz/i,
  column: /column/i,
  furniture: /furnit/i,
  sanitary: /sanit/i,
  stairs: /stair/i,
  rooms: /room.?name|room.?label|space/i,
};

export const symbolLayer = (l) => LAYERS.door.test(l) || LAYERS.window.test(l) || LAYERS.furniture.test(l) || LAYERS.sanitary.test(l);

const KINDS = [
  ['lift', /^lift$/i],
  ['stair', /stair|^fire$/i],
  ['bath', /toilet|bath|\bwc\b|w\.c|powder|wash\s*room/i],
  ['kitchen', /kitchen|pantry/i],
  ['balcony', /balcony|\bbal\b|\bbal\.|terrace|deck|verandah/i],
  ['bedroom', /bed\s*room|bedroom|master|guest\s*room|\bbr\b/i],
  ['dining', /^dining/i],
  ['living', /living|lounge|drawing|hall\b/i],
  ['passage', /passage|corridor|lobby|foyer|entrance|\bent\./i],
  ['utility', /odu|utility|duct|shaft|store|service|\bdry\b/i],
];

export const kindOf = (name) => KINDS.find(([, re]) => re.test(name))?.[0] || 'room';

const round = (n, p = 2) => Math.round(n * 10 ** p) / 10 ** p;
const bboxOf = (pts) => {
  const xs = pts.map((p) => p[0]);
  const zs = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
};
const clean = (t) => t.replace(/\\[WwQqTtAaHhCcFf][^;]*;/g, '').replace(/\\[A-Za-z][^;\\]*;/g, '').trim();

/** Title blocks on the sheet: every text like "TYPICAL FLOOR PLAN" with the frame that holds it. */
export function findSheets(prims) {
  const frames = prims
    .filter((p) => p.kind === 'line' && p.closed && p.pts.length >= 4 && /sheet|border|frame|title/i.test(p.layer))
    .map((p) => ({ box: bboxOf(p.pts), layer: p.layer }))
    .filter((f) => f.box[2] - f.box[0] > 15 && f.box[3] - f.box[1] > 10)
    .sort((a, b) => (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]) - (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]));
  const titles = prims.filter((p) => p.kind === 'text' && /floor\s*plan|typical|refuge|ground|podium|plan\b/i.test(p.text) && !/\n/.test(p.text) && p.text.length < 40);
  const sheets = [];
  for (const t of titles) {
    const frame = frames.find((f) => t.x >= f.box[0] && t.x <= f.box[2] && t.y >= f.box[1] && t.y <= f.box[3]);
    if (!frame || sheets.some((s) => s.box === frame.box)) continue;
    sheets.push({ title: t.text, box: frame.box });
  }
  return sheets;
}

const sheetKey = (title) => (/refuge/i.test(title) ? 'refuge' : /typical|standard|floor\s*plan/i.test(title) ? 'typical' : null);

/** Which floors each sheet applies to: "TYPICAL FLOORS - 2, 3, 5 ..." and "REFUGE FLOORS - 4, 9 ...". */
export function floorLists(prims, box) {
  const out = { typical: [], refuge: [] };
  for (const p of prims) {
    if (p.kind !== 'text' || p.x < box[0] || p.x > box[2] || p.y < box[1] || p.y > box[3]) continue;
    const m = p.text.match(/(typical|refuge)\s*floors?\s*[-–:]\s*([\d,\s]+)/i);
    if (m) out[m[1].toLowerCase()] = m[2].split(',').map((n) => Number(n.trim())).filter(Number.isFinite);
  }
  return out;
}

function parseRoom(text) {
  const lines = text.split('\n').map((l) => clean(l)).filter(Boolean);
  if (!lines.length) return null;
  const name = lines[0].replace(/\s+/g, ' ').replace(/\d+'\d+"?\s*X.*$/i, '').trim();
  let dims = null;
  for (const l of lines.slice(1)) {
    const m = l.match(/^(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)/);
    if (m && !/'|"/.test(l.slice(0, m[0].length))) { dims = [Number(m[1]), Number(m[2])]; break; }
  }
  return { name, dims };
}

// ---- furniture ----
const HEIGHT = { bed: 0.5, wardrobe: 2.1, side: 0.5, sofa: 0.85, dining: 0.78, tv: 0.7, coffee: 0.35, kitchen: 0.9, fridge: 1.7, wc: 0.42, basin: 0.8, curtain: 2.15 };

function classify(kind, w, d, name) {
  const long = Math.max(w, d);
  const short = Math.min(w, d);
  if (LAYERS.sanitary.test(name.layer) || name.sanitary) return /w\.?c|toilet/i.test(name.block) ? 'wc' : 'basin';
  if (long > 3.6 || short < 0.12) return null;
  if (kind === 'bedroom') {
    if (short >= 1.2 && w * d >= 2.2) return 'bed';
    if (long >= 0.9 && short <= 0.75) return 'wardrobe';
    return 'side';
  }
  if (kind === 'living' || kind === 'dining' || kind === 'room') {
    if (long >= 1.5 && short <= 1.05) return short <= 0.5 ? 'tv' : 'sofa';
    if (long >= 1.05 && short >= 0.85 && long <= 1.7) return 'dining';
    if (long >= 0.55 && short >= 0.45 && long <= 1.05) return 'coffee';
    return 'side';
  }
  if (kind === 'kitchen') return long >= 1.0 && short <= 0.8 ? 'kitchen' : short >= 0.45 && long <= 0.85 ? 'fridge' : 'kitchen';
  if (kind === 'bath') return 'basin';
  return null;
}

// Which wall is nearest, so beds, sofas and wardrobes sit with their backs to it.
function backwall(walls, cx, cz, w, d) {
  const probes = [[1, 0, w / 2], [-1, 0, w / 2], [0, 1, d / 2], [0, -1, d / 2]];
  let best = null;
  for (const [dx, dz, half] of probes) {
    for (let t = half; t < half + 1.0; t += walls.res) {
      if (walls.at(cx + dx * t, cz + dz * t)) {
        if (!best || t - half < best.gap) best = { dx, dz, gap: t - half };
        break;
      }
    }
  }
  return best;
}

// Viewer shapes have a fixed "back" in their own frame. Pick the Y rotation that points it at the wall.
const BACKS = {
  bed: (w, d) => (w >= d ? [-1, 0] : [0, 1]),
  sofa: (w, d) => (w >= d ? [0, -1] : [-1, 0]),
  wardrobe: (w, d) => (d <= w ? [0, -1] : [-1, 0]),
  kitchen: null,
};
function faceRotation(subtype, w, d, wall) {
  const own = BACKS[subtype]?.(w, d);
  if (!own || !wall) return null;
  let best = 0;
  let bestDot = -2;
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    const rx = own[0] * Math.cos(a) + own[1] * Math.sin(a);
    const rz = -own[0] * Math.sin(a) + own[1] * Math.cos(a);
    const dot = rx * wall.dx + rz * wall.dz;
    if (dot > bestDot) { bestDot = dot; best = a; }
  }
  return best ? [0, round(best), 0] : null;
}

function templateFurniture(room, walls) {
  const [x0, z0, w, d] = room.bbox;
  const out = [];
  const add = (subtype, cx, cz, fw, fd) => out.push({ subtype, cx: round(cx), cz: round(cz), w: round(fw), d: round(fd), h: HEIGHT[subtype], auto: true });
  const kind = room.kind;
  if (kind === 'bedroom' && w >= 2.4 && d >= 2.4) {
    const alongX = w >= d;
    const bedL = Math.min(2.05, Math.max(w, d) * 0.55);
    const bedW = Math.min(1.7, Math.min(w, d) * 0.62);
    if (alongX) add('bed', x0 + 0.1 + bedL / 2, z0 + d / 2, bedL, bedW);
    else add('bed', x0 + w / 2, z0 + 0.1 + bedL / 2, bedW, bedL);
    add('wardrobe', x0 + w - 0.3, z0 + d - 0.9, 0.55, Math.min(1.6, d * 0.4));
    add('side', alongX ? x0 + 0.35 : x0 + w / 2 + bedW / 2 + 0.3, alongX ? z0 + d / 2 + bedW / 2 + 0.3 : z0 + 0.35, 0.42, 0.42);
  } else if ((kind === 'living' || kind === 'dining') && w >= 2.2 && d >= 2.2) {
    add('sofa', x0 + w / 2, z0 + 0.5, Math.min(2.0, w * 0.6), 0.85);
    add('coffee', x0 + w / 2, z0 + 1.45, 0.9, 0.5);
    add('tv', x0 + w / 2, z0 + d - 0.3, Math.min(1.4, w * 0.4), 0.4);
    if (/din/i.test(room.name) || d > 4.5) add('dining', x0 + w / 2, z0 + d - 1.4, 1.2, 0.9);
  } else if (kind === 'kitchen' && w >= 1.4 && d >= 1.4) {
    add('kitchen', x0 + w / 2, z0 + 0.3, Math.min(2.2, w - 0.2), 0.6);
    add('fridge', x0 + w - 0.4, z0 + d - 0.4, 0.6, 0.6);
  } else if (kind === 'bath' && w >= 1.0 && d >= 1.0) {
    add('wc', x0 + 0.4, z0 + 0.5, 0.4, 0.65);
    add('basin', x0 + w - 0.4, z0 + 0.4, 0.5, 0.4);
  }
  return out.filter((f) => walls.at(f.cx, f.cz) === 0);
}

// Slab edges do not need 10 cm accuracy; snapping to a coarser grid keeps the box count down.
function coarsen(grid, mask, factor) {
  const g = new Grid(grid.nx * grid.res, grid.nz * grid.res, grid.res * factor);
  for (let z = 0; z < g.nz; z++) {
    for (let x = 0; x < g.nx; x++) {
      let on = 0;
      for (let dz = 0; dz < factor; dz++) for (let dx = 0; dx < factor; dx++) on += mask[(z * factor + dz) * grid.nx + x * factor + dx] || 0;
      if (on >= (factor * factor) / 2) g.a[z * g.nx + x] = 1;
    }
  }
  return g.rects(g.a, 0.6);
}

/**
 * Interpret one sheet of the drawing.
 * @param {object[]} prims flattened drawing primitives
 * @param {number[]} box   sheet frame [x0, y0, x1, y1] in drawing units
 * @param {number} scale   metres per drawing unit
 */
export function interpretSheet(prims, box, scale = 1) {
  const inBox = (x, y) => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
  const here = prims.filter((p) => (p.kind === 'line' ? p.pts.some(([x, y]) => inBox(x, y)) : inBox(p.x, p.y)));

  const isWall = (l) => LAYERS.wall.test(l) && !LAYERS.skipWall.test(l);
  const shell = here.filter((p) => p.kind === 'line' && (isWall(p.layer) || LAYERS.parapet.test(p.layer)));
  if (!shell.length) {
    const err = new Error('No wall layer found on this sheet. Name the wall layer "WALLS" (or similar) in the drawing and upload again.');
    err.status = 422;
    throw err;
  }
  const all = shell.flatMap((p) => p.pts);
  const minX = Math.min(...all.map((p) => p[0])) - 1.5;
  const maxX = Math.max(...all.map((p) => p[0])) + 1.5;
  const minY = Math.min(...all.map((p) => p[1])) - 1.5;
  const maxY = Math.max(...all.map((p) => p[1])) + 1.5;
  const W = (maxX - minX) * scale;
  const D = (maxY - minY) * scale;
  const px = ([x, y]) => [(x - minX) * scale, (maxY - y) * scale];

  const walls = new Grid(W, D, 0.1);
  const parapets = new Grid(W, D, 0.1);
  const paint = (grid, p, thick) => {
    const pts = p.pts.map(px);
    if (p.closed && pts.length >= 3) grid.fillPolygon(pts);
    else for (let i = 0; i + 1 < pts.length; i++) grid.strokeSegment(pts[i], pts[i + 1], thick);
  };
  for (const p of shell) paint(isWall(p.layer) ? walls : parapets, p, isWall(p.layer) ? 0.12 : 0.1);

  // ---- openings ----
  const openings = [];
  for (const s of here.filter((p) => p.kind === 'symbol' && p.bbox && (LAYERS.window.test(p.layer) || LAYERS.door.test(p.layer)))) {
    const [bx0, bz0, bx1, bz1] = [...px([s.bbox[0], s.bbox[3]]), ...px([s.bbox[2], s.bbox[1]])];
    const w = bx1 - bx0;
    const d = bz1 - bz0;
    const cx = (bx0 + bx1) / 2;
    const cz = (bz0 + bz1) / 2;
    if (LAYERS.window.test(s.layer)) {
      const alongX = w >= d;
      const len = Math.max(w, d);
      if (len < 0.4 || len > 6) continue;
      openings.push({ type: 'window', cx, cz, w: alongX ? len : 0.3, d: alongX ? 0.3 : len });
    } else {
      const reach = Math.min(1.2, Math.max(w, d));
      const probe = (dx, dz) => walls.at(cx + dx, cz + dz) || parapets.at(cx + dx, cz + dz);
      const along = probe(-reach / 2 - 0.15, 0) && probe(reach / 2 + 0.15, 0) ? 'x'
        : probe(0, -reach / 2 - 0.15) && probe(0, reach / 2 + 0.15) ? 'z' : (w >= d ? 'x' : 'z');
      openings.push({ type: 'door', cx, cz, w: along === 'x' ? reach : 0.3, d: along === 'x' ? 0.3 : reach, exterior: /external|main|entrance/i.test(s.layer) });
    }
  }
  for (const o of openings) walls.fillRect(o.cx - o.w / 2, o.cz - o.d / 2, o.cx + o.w / 2, o.cz + o.d / 2, 0);

  // ---- rooms ----
  const barrier = walls.clone();
  for (const o of openings) barrier.fillRect(o.cx - o.w / 2, o.cz - o.d / 2, o.cx + o.w / 2, o.cz + o.d / 2, 1);
  for (let i = 0; i < parapets.a.length; i++) if (parapets.a[i]) barrier.a[i] = 1;

  const labels = here.filter((p) => p.kind === 'text' && LAYERS.rooms.test(p.layer));
  const tags = [];
  const types = [];
  const roomLabels = [];
  for (const t of labels) {
    const parsed = parseRoom(t.text);
    if (!parsed?.name) continue;
    const [x, z] = px([t.x, t.y]);
    if (/^\d{1,2}$/.test(parsed.name)) tags.push({ tag: parsed.name, x, z });
    else if (/\bBHK\b/i.test(parsed.name)) types.push({ type: parsed.name.replace(/\s+S\s*T\d+.*$/i, '').replace(/\s+L$/i, '').trim(), x, z });
    else if (!/^\\|^ent\.|\bwide passage\b|^odu$|^[-.\d\s]+$/i.test(parsed.name) || /passage/i.test(parsed.name)) roomLabels.push({ ...parsed, x, z });
  }

  // Wings: the sheet is often two mirrored wings; the "WING A / WING B" labels say where each starts.
  const wingLabels = here.filter((p) => p.kind === 'text' && /^wing\s*[a-z]$/i.test(p.text.trim())).map((p) => ({ name: p.text.trim().toUpperCase(), z: px([p.x, p.y])[1] }));
  const wingAt = (z) => (wingLabels.length ? wingLabels.reduce((b, w) => (Math.abs(w.z - z) < Math.abs(b.z - z) ? w : b)).name : 'WING A');

  const flats = [];
  const seenWing = new Map();
  [...tags].sort((a, b) => a.z - b.z || a.x - b.x).forEach((t) => {
    const wing = wingAt(t.z);
    const idx = seenWing.get(wing) || [...new Set(wingLabels.map((w) => w.name))].sort().indexOf(wing);
    seenWing.set(wing, idx);
    const number = idx * 9 + Number(t.tag);
    const type = types.length ? types.reduce((b, c) => (Math.hypot(c.x - t.x, c.z - t.z) < Math.hypot(b.x - t.x, b.z - t.z) ? c : b)).type : 'Flat';
    flats.push({ id: String(Math.max(1, number)).padStart(2, '0'), tag: t.tag, wing, type, x: t.x, z: t.z });
  });
  const flatAt = (x, z) => {
    const wing = wingAt(z);
    const pool = flats.filter((f) => f.wing === wing);
    if (!pool.length) return null;
    const f = pool.reduce((b, c) => (Math.hypot(c.x - x, c.z - z) < Math.hypot(b.x - x, b.z - z) ? c : b));
    return Math.hypot(f.x - x, f.z - z) < 14 ? f : null;
  };

  const owner = new Int16Array(walls.a.length).fill(-1);
  const rooms = [];
  for (const l of roomLabels) {
    const kind = kindOf(l.name);
    const expect = l.dims ? l.dims[0] * l.dims[1] : null;
    let cells = barrier.flood(l.x, l.z, { box: 7, maxCells: Math.round((expect ? expect * 2 : 45) / (barrier.res ** 2)) });
    let bbox = null;
    if (cells) {
      const area = cells.length * barrier.res ** 2;
      if (expect && (area < expect * 0.45 || area > expect * 1.8)) cells = null;
      else if (area < 0.9) cells = null;
    }
    if (cells) {
      const xs = cells.map((c) => (c % barrier.nx) * barrier.res);
      const zs = cells.map((c) => Math.floor(c / barrier.nx) * barrier.res);
      bbox = [Math.min(...xs), Math.min(...zs), Math.max(...xs) - Math.min(...xs) + barrier.res, Math.max(...zs) - Math.min(...zs) + barrier.res];
    } else if (expect) {
      const [dw, dd] = l.dims;
      bbox = [l.x - dw / 2, l.z - dd / 2, dw, dd];
      cells = [];
      for (let iz = barrier.iz(bbox[1]); iz <= barrier.iz(bbox[1] + dd); iz++) {
        for (let ix = barrier.ix(bbox[0]); ix <= barrier.ix(bbox[0] + dw); ix++) if (barrier.inside(ix, iz) && !barrier.get(ix, iz)) cells.push(iz * barrier.nx + ix);
      }
    }
    if (!bbox && kind === 'lift') { bbox = [l.x - 1, l.z - 1, 2, 2]; cells = []; }
    if (!bbox) continue;
    const flat = flatAt(l.x, l.z);
    const room = { name: l.name, kind, flat: flat?.id || null, bbox: bbox.map((v) => round(v)), cells, rects: [] };
    rooms.push(room);
    const idx = rooms.length - 1;
    for (const c of cells) if (owner[c] < 0) owner[c] = idx;
    // One floor box when the room is close to a rectangle, otherwise its three biggest pieces.
    const area = cells.length * barrier.res ** 2;
    if (!cells.length || area >= bbox[2] * bbox[3] * 0.8) room.rects = [room.bbox];
    else {
      room.rects = barrier.rects(cellsToMask(barrier, cells), 0.3)
        .sort((a, b) => b[2] * b[3] - a[2] * a[3]).slice(0, 3)
        .filter((r) => r[2] * r[3] >= 0.4).map((r) => r.map((v) => round(v)));
    }
  }
  const roomAt = (x, z, slack = 1.2) => {
    const i = owner[barrier.iz(z) * barrier.nx + barrier.ix(x)];
    if (i >= 0) return rooms[i];
    let best = null;
    for (const r of rooms) {
      const gap = Math.hypot(Math.max(r.bbox[0] - x, 0, x - r.bbox[0] - r.bbox[2]), Math.max(r.bbox[1] - z, 0, z - r.bbox[1] - r.bbox[3]));
      if (gap < slack && (!best || gap < best.gap)) best = { r, gap };
    }
    return best?.r || null;
  };

  // ---- furniture the drawing already contains ----
  const furniture = [];
  const seen = new Set();
  for (const s of here.filter((p) => p.kind === 'symbol' && p.bbox && (LAYERS.furniture.test(p.layer) || LAYERS.sanitary.test(p.layer)))) {
    const [x0, z0, x1, z1] = [...px([s.bbox[0], s.bbox[3]]), ...px([s.bbox[2], s.bbox[1]])];
    const w = x1 - x0;
    const d = z1 - z0;
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const key = `${Math.round(cx * 20)}:${Math.round(cz * 20)}:${s.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const room = roomAt(cx, cz);
    const subtype = classify(room?.kind || 'room', w, d, { layer: s.layer, block: s.name, sanitary: LAYERS.sanitary.test(s.layer) });
    if (!subtype || (!room && subtype !== 'wc' && subtype !== 'basin')) continue;
    const fw = subtype === 'basin' ? Math.min(w, 0.55) : subtype === 'wc' ? Math.min(w, 0.5) : w;
    const fd = subtype === 'basin' ? Math.min(d, 0.45) : subtype === 'wc' ? Math.min(d, 0.7) : d;
    const rot = faceRotation(subtype, fw, fd, backwall(walls, cx, cz, fw, fd));
    furniture.push({ subtype, cx: round(cx), cz: round(cz), w: round(fw), d: round(fd), h: HEIGHT[subtype] || 0.5, rot, room: room?.name || null, flat: room?.flat || flatAt(cx, cz)?.id || null });
  }
  const furnished = new Set(furniture.map((f) => f.room));
  for (const room of rooms) {
    if (furnished.has(room.name) && room.kind !== 'bedroom') continue;
    const has = furniture.some((f) => f.room === room.name && f.subtype === 'bed');
    if (room.kind === 'bedroom' && has) continue;
    if (!['bedroom', 'living', 'dining', 'kitchen', 'bath'].includes(room.kind)) continue;
    if (furniture.some((f) => f.room === room.name && f.flat === room.flat && !f.auto) && room.kind !== 'bedroom') continue;
    for (const f of templateFurniture(room, walls)) furniture.push({ ...f, room: room.name, flat: room.flat, rot: null });
  }

  // ---- columns, stairs, lifts ----
  const columns = [];
  for (const p of here.filter((q) => q.kind === 'line' && q.closed && LAYERS.column.test(q.layer))) {
    const [a, b, c, d] = bboxOf(p.pts.map(px));
    const w = c - a;
    const h = d - b;
    if (w < 0.15 || h < 0.15 || w > 1.6 || h > 1.6) continue;
    const key = `${Math.round(a * 10)}:${Math.round(b * 10)}`;
    if (seen.has(`col${key}`)) continue;
    seen.add(`col${key}`);
    columns.push({ cx: round((a + c) / 2), cz: round((b + d) / 2), w: round(w), d: round(h) });
  }

  const stairBoxes = here.filter((p) => p.kind === 'line' && LAYERS.stairs.test(p.layer)).map((p) => bboxOf(p.pts.map(px)));
  const clusters = [];
  for (const b of stairBoxes) {
    const hit = clusters.filter((c) => b[0] <= c[2] + 0.4 && b[2] >= c[0] - 0.4 && b[1] <= c[3] + 0.4 && b[3] >= c[1] - 0.4);
    const merged = hit.reduce((m, c) => [Math.min(m[0], c[0]), Math.min(m[1], c[1]), Math.max(m[2], c[2]), Math.max(m[3], c[3])], b);
    for (const c of hit) clusters.splice(clusters.indexOf(c), 1);
    clusters.push(merged);
  }
  const stairs = clusters
    .filter((c) => c[2] - c[0] >= 1.0 && c[3] - c[1] >= 1.0 && (c[2] - c[0]) * (c[3] - c[1]) >= 2.5 && c[2] - c[0] < 9 && c[3] - c[1] < 9)
    .map((c) => {
      const w = c[2] - c[0];
      const d = c[3] - c[1];
      const axis = w >= d ? 'x' : 'z';
      return { cx: round((c[0] + c[2]) / 2), cz: round((c[1] + c[3]) / 2), w: round(w), d: round(d), axis, steps: Math.max(6, Math.min(16, Math.round((axis === 'x' ? w : d) / 0.28))) };
    });

  const lifts = rooms.filter((r) => r.kind === 'lift').map((r) => ({ cx: round(r.bbox[0] + r.bbox[2] / 2), cz: round(r.bbox[1] + r.bbox[3] / 2), w: round(Math.min(r.bbox[2], 2.2)), d: round(Math.min(r.bbox[3], 2.2)) }));

  // ---- slab: everything inside the outer walls, closed over door and wall gaps ----
  const solid = barrier.clone();
  for (const r of rooms) for (const c of r.cells) solid.a[c] = 1;
  const outside = solid.dilate(0.7).outside();
  const outGrid = barrier.clone();
  outGrid.a.set(outside);
  const trimmed = outGrid.dilate(0.5);
  const slabMask = new Uint8Array(walls.a.length);
  for (let i = 0; i < slabMask.length; i++) slabMask[i] = trimmed.a[i] ? 0 : 1;
  const slab = coarsen(walls, slabMask, 4).map((r) => r.map((v) => round(v)));
  columns.splice(0, columns.length, ...columns.filter((c) => slabMask[walls.iz(c.cz) * walls.nx + walls.ix(c.cx)] || walls.at(c.cx, c.cz)));

  // ---- wall boxes, tagged exterior / interior and by flat ----
  // Facade test: outside the slab outline, or facing a balcony (open to the sky behind its parapet).
  const outsideGrid = barrier.clone();
  outsideGrid.a.set(outside);
  for (const r of rooms) if (r.kind === 'balcony') for (const c of r.cells) outsideGrid.a[c] = 1;
  const touchesOutside = (x, z, w, d) => {
    for (let iz = outsideGrid.iz(z - 0.8); iz <= outsideGrid.iz(z + d + 0.8); iz++) {
      for (let ix = outsideGrid.ix(x - 0.8); ix <= outsideGrid.ix(x + w + 0.8); ix++) if (outsideGrid.get(ix, iz)) return true;
    }
    return false;
  };
  const wallBoxes = walls.rects(walls.a, 0.1).filter(([, , w, d]) => Math.max(w, d) >= 0.2).map(([x, z, w, d]) => {
    const exterior = touchesOutside(x, z, w, d);
    return { cx: round(x + w / 2), cz: round(z + d / 2), w: round(w), d: round(d), exterior, flat: exterior ? null : (flatAt(x + w / 2, z + d / 2)?.id || null) };
  });
  const parapetBoxes = parapets.dilate(0.1).rects(parapets.dilate(0.1).a, 0.08).filter(([, , w, d]) => Math.max(w, d) >= 0.6).map(([x, z, w, d]) => ({ cx: round(x + w / 2), cz: round(z + d / 2), w: round(w), d: round(d) }));

  const finalOpenings = openings.map((o) => {
    const exterior = o.type === 'window' ? touchesOutside(o.cx - o.w / 2, o.cz - o.d / 2, o.w, o.d) : false;
    const room = roomAt(o.cx, o.cz, 1.6);
    return { ...o, cx: round(o.cx), cz: round(o.cz), w: round(o.w), d: round(o.d), exterior, flat: exterior ? null : (room?.flat || flatAt(o.cx, o.cz)?.id || null), room: room?.name || null, roomKind: room?.kind || null };
  });

  return {
    widthM: round(W, 1),
    depthM: round(D, 1),
    slab,
    walls: wallBoxes,
    parapets: parapetBoxes,
    openings: finalOpenings,
    columns,
    rooms: rooms.map(({ cells, ...r }) => r),
    furniture,
    stairs,
    lifts,
    flats: flats.map(({ id, type, wing, tag, x, z }) => ({ id, type, wing, tag, x: round(x), z: round(z) })),
  };
}

export { sheetKey };
