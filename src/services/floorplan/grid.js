// A boolean raster over the plan, in metres. Wall outlines are filled into it so that walls,
// enclosed rooms and the slab outline can be recovered as axis-aligned boxes, which is what the
// 3D viewer draws.

export class Grid {
  constructor(width, depth, res = 0.1) {
    this.res = res;
    this.nx = Math.max(1, Math.ceil(width / res));
    this.nz = Math.max(1, Math.ceil(depth / res));
    this.a = new Uint8Array(this.nx * this.nz);
  }

  clone() {
    const g = new Grid(this.nx * this.res, this.nz * this.res, this.res);
    g.a.set(this.a);
    return g;
  }

  inside(ix, iz) { return ix >= 0 && iz >= 0 && ix < this.nx && iz < this.nz; }
  get(ix, iz) { return this.inside(ix, iz) ? this.a[iz * this.nx + ix] : 0; }
  set(ix, iz, v = 1) { if (this.inside(ix, iz)) this.a[iz * this.nx + ix] = v; }
  ix(x) { return Math.floor(x / this.res); }
  iz(z) { return Math.floor(z / this.res); }
  at(x, z) { return this.get(this.ix(x), this.iz(z)); }

  fillRect(x0, z0, x1, z1, v = 1) {
    const ax = Math.max(0, this.ix(Math.min(x0, x1)));
    const bx = Math.min(this.nx - 1, this.ix(Math.max(x0, x1)));
    const az = Math.max(0, this.iz(Math.min(z0, z1)));
    const bz = Math.min(this.nz - 1, this.iz(Math.max(z0, z1)));
    for (let z = az; z <= bz; z++) for (let x = ax; x <= bx; x++) this.a[z * this.nx + x] = v;
  }

  // Even-odd scanline fill at cell centres.
  fillPolygon(pts, v = 1) {
    if (pts.length < 3) return;
    const zs = pts.map((p) => p[1]);
    const z0 = Math.max(0, this.iz(Math.min(...zs)));
    const z1 = Math.min(this.nz - 1, this.iz(Math.max(...zs)));
    for (let iz = z0; iz <= z1; iz++) {
      const zc = (iz + 0.5) * this.res;
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const [xa, za] = pts[i];
        const [xb, zb] = pts[(i + 1) % pts.length];
        if ((za <= zc && zb > zc) || (zb <= zc && za > zc)) xs.push(xa + ((zc - za) / (zb - za)) * (xb - xa));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const a = Math.max(0, Math.ceil(xs[k] / this.res - 0.5));
        const b = Math.min(this.nx - 1, Math.floor(xs[k + 1] / this.res - 0.5));
        for (let ix = a; ix <= b; ix++) this.a[iz * this.nx + ix] = v;
      }
    }
  }

  // A line drawn as a wall of the given thickness.
  strokeSegment([xa, za], [xb, zb], thick = 0.1, v = 1) {
    const h = thick / 2;
    const a = Math.max(0, this.ix(Math.min(xa, xb) - h));
    const b = Math.min(this.nx - 1, this.ix(Math.max(xa, xb) + h));
    const c = Math.max(0, this.iz(Math.min(za, zb) - h));
    const d = Math.min(this.nz - 1, this.iz(Math.max(za, zb) + h));
    const dx = xb - xa;
    const dz = zb - za;
    const len2 = dx * dx + dz * dz || 1e-9;
    for (let iz = c; iz <= d; iz++) {
      for (let ix = a; ix <= b; ix++) {
        const px = (ix + 0.5) * this.res;
        const pz = (iz + 0.5) * this.res;
        const t = Math.max(0, Math.min(1, ((px - xa) * dx + (pz - za) * dz) / len2));
        if (Math.hypot(px - (xa + t * dx), pz - (za + t * dz)) <= h) this.a[iz * this.nx + ix] = v;
      }
    }
  }

  // Square structuring element: cheap, and plans are orthogonal.
  dilate(r) {
    const n = Math.max(1, Math.round(r / this.res));
    const tmp = new Uint8Array(this.a.length);
    const out = new Grid(this.nx * this.res, this.nz * this.res, this.res);
    for (let z = 0; z < this.nz; z++) {
      for (let x = 0; x < this.nx; x++) {
        if (!this.a[z * this.nx + x]) continue;
        const a = Math.max(0, x - n);
        const b = Math.min(this.nx - 1, x + n);
        for (let k = a; k <= b; k++) tmp[z * this.nx + k] = 1;
      }
    }
    for (let z = 0; z < this.nz; z++) {
      for (let x = 0; x < this.nx; x++) {
        if (!tmp[z * this.nx + x]) continue;
        const a = Math.max(0, z - n);
        const b = Math.min(this.nz - 1, z + n);
        for (let k = a; k <= b; k++) out.a[k * this.nx + x] = 1;
      }
    }
    return out;
  }

  // Cells reachable from the border without crossing a set cell.
  outside() {
    const out = new Uint8Array(this.a.length);
    const stack = [];
    const push = (x, z) => {
      const i = z * this.nx + x;
      if (!this.a[i] && !out[i]) { out[i] = 1; stack.push(i); }
    };
    for (let x = 0; x < this.nx; x++) { push(x, 0); push(x, this.nz - 1); }
    for (let z = 0; z < this.nz; z++) { push(0, z); push(this.nx - 1, z); }
    while (stack.length) {
      const i = stack.pop();
      const x = i % this.nx;
      const z = (i - x) / this.nx;
      if (x > 0) push(x - 1, z);
      if (x < this.nx - 1) push(x + 1, z);
      if (z > 0) push(x, z - 1);
      if (z < this.nz - 1) push(x, z + 1);
    }
    return out;
  }

  // Flood fill from a point, bounded by a box and a cell budget. Returns cell indices, or null
  // when the region leaks past the budget (an open-plan room, or a gap in the walls).
  flood(x, z, { box = 6, maxCells = 4000 } = {}) {
    let sx = this.ix(x);
    let sz = this.iz(z);
    if (this.get(sx, sz)) {
      let found = false;
      for (let r = 1; r <= 6 && !found; r++) {
        for (let dz = -r; dz <= r && !found; dz++) {
          for (let dx = -r; dx <= r && !found; dx++) {
            if (this.inside(sx + dx, sz + dz) && !this.get(sx + dx, sz + dz)) { sx += dx; sz += dz; found = true; }
          }
        }
      }
      if (!found) return null;
    }
    const lim = Math.round(box / this.res);
    const seen = new Set([sz * this.nx + sx]);
    const stack = [[sx, sz]];
    while (stack.length) {
      const [cx, cz] = stack.pop();
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (!this.inside(nx, nz) || this.get(nx, nz)) continue;
        if (Math.abs(nx - sx) > lim || Math.abs(nz - sz) > lim) return null;
        const key = nz * this.nx + nx;
        if (seen.has(key)) continue;
        seen.add(key);
        if (seen.size > maxCells) return null;
        stack.push([nx, nz]);
      }
    }
    return [...seen];
  }

  // Greedy merge of set cells into boxes: [x, z, w, d] in metres.
  rects(source = this.a, minSide = 0) {
    const out = [];
    let active = new Map();
    for (let z = 0; z <= this.nz; z++) {
      const next = new Map();
      if (z < this.nz) {
        let x = 0;
        while (x < this.nx) {
          if (!source[z * this.nx + x]) { x++; continue; }
          const start = x;
          while (x < this.nx && source[z * this.nx + x]) x++;
          const key = `${start}:${x}`;
          const prev = active.get(key);
          if (prev) { prev.z1 = z + 1; next.set(key, prev); active.delete(key); } else next.set(key, { x0: start, x1: x, z0: z, z1: z + 1 });
        }
      }
      for (const r of active.values()) out.push(r);
      active = next;
    }
    return out
      .map((r) => [r.x0 * this.res, r.z0 * this.res, (r.x1 - r.x0) * this.res, (r.z1 - r.z0) * this.res])
      .filter(([, , w, d]) => Math.min(w, d) >= minSide);
  }
}

export const cellsToMask = (grid, cells) => {
  const m = new Uint8Array(grid.a.length);
  for (const c of cells) m[c] = 1;
  return m;
};
