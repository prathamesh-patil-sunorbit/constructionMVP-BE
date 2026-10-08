// DWG / DXF reading for the floor-plan importer.
//
// DWG is a closed binary format, so it is converted to DXF with LibreDWG's `dwg2dxf` (install:
// `brew install libredwg` or `apt install libredwg-tools`). The DXF is then parsed and every
// block INSERT is expanded into world-coordinate primitives, because architects draw a flat
// once and insert it many times, rotated and mirrored.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import DxfParser from 'dxf-parser';

const run = promisify(execFile);
const MAX_DEPTH = 6;

export async function dwgToDxf(file) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dwg-'));
  const out = path.join(dir, 'plan.dxf');
  try {
    // execFile, no shell: the uploaded file name is never interpreted by a shell.
    await run('dwg2dxf', ['-y', '-o', out, file], { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (e.code === 'ENOENT') {
      const err = new Error('DWG conversion needs LibreDWG (dwg2dxf) on the server. Install it, or upload the plan as DXF.');
      err.status = 501;
      throw err;
    }
    // dwg2dxf exits non-zero on harmless warnings; only fail when it wrote nothing.
    if (!fs.existsSync(out)) {
      const err = new Error(`Could not read this DWG: ${String(e.stderr || e.message).split('\n').slice(-3).join(' ').trim()}`);
      err.status = 422;
      throw err;
    }
  }
  try {
    return await fs.promises.readFile(out, 'utf8');
  } finally {
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function readDrawing(file) {
  const ext = path.extname(file).toLowerCase();
  const text = ext === '.dwg' ? await dwgToDxf(file) : await fs.promises.readFile(file, 'utf8');
  let dxf;
  try {
    dxf = new DxfParser().parseSync(text);
  } catch (e) {
    const err = new Error(`Could not parse the drawing: ${e.message}`);
    err.status = 422;
    throw err;
  }
  return dxf;
}

// ---- affine transforms: [a, b, c, d, e, f] so x' = a x + c y + e, y' = b x + d y + f ----
const IDENT = [1, 0, 0, 1, 0, 0];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const mul = (p, c) => [
  p[0] * c[0] + p[2] * c[1], p[1] * c[0] + p[3] * c[1],
  p[0] * c[2] + p[2] * c[3], p[1] * c[2] + p[3] * c[3],
  p[0] * c[4] + p[2] * c[5] + p[4], p[1] * c[4] + p[3] * c[5] + p[5],
];

function insertMatrix(ins, base) {
  const sx = ins.xScale ?? 1;
  const sy = ins.yScale ?? 1;
  const r = ((ins.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const bx = base?.x || 0;
  const by = base?.y || 0;
  // translate(-base) → scale → rotate → translate(position)
  const local = [sx * cos, sx * sin, -sy * sin, sy * cos, 0, 0];
  const [ox, oy] = apply(local, -bx, -by);
  local[4] = ox + (ins.position?.x || 0);
  local[5] = oy + (ins.position?.y || 0);
  return local;
}

function arcPoints(cx, cy, r, a0, a1, steps = 12) {
  let end = a1;
  if (end <= a0) end += Math.PI * 2;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = a0 + ((end - a0) * i) / steps;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
}

const cleanText = (t = '') => t
  .replace(/\\p[^;]*;/gi, '')
  .replace(/\\[Ff][^;]*;/g, '')
  .replace(/\\[Cc]\d+;/g, '')
  .replace(/\\P/g, '\n')
  .replace(/\\~/g, ' ')
  .replace(/[{}]/g, '')
  .replace(/%%[Cc]/g, 'Ø')
  .replace(/%%[Dd]/g, '°')
  .trim();

/**
 * Flatten a parsed DXF into world-space primitives.
 *   line   { layer, pts: [[x,y]...], closed }   polylines, lines, arcs, circles
 *   text   { layer, text, x, y }
 *   symbol { layer, name, x, y, rot, sx, sy, bbox }  a block INSERT on a door / window / column layer
 */
export function flatten(dxf, { symbolLayer } = {}) {
  const prims = [];
  const blocks = dxf.blocks || {};

  const walk = (entities, m, inheritedLayer, depth, viaSymbol) => {
    for (const e of entities || []) {
      const layer = !e.layer || e.layer === '0' ? inheritedLayer || '0' : e.layer;
      switch (e.type) {
        case 'LINE':
          if (e.vertices?.length >= 2) {
            prims.push({ kind: 'line', layer, pts: e.vertices.slice(0, 2).map((v) => apply(m, v.x, v.y)), closed: false, viaSymbol });
          }
          break;
        case 'LWPOLYLINE':
        case 'POLYLINE':
          if (e.vertices?.length >= 2) {
            prims.push({
              kind: 'line', layer, closed: Boolean(e.shape), viaSymbol,
              pts: e.vertices.map((v) => apply(m, v.x, v.y)),
            });
          }
          break;
        case 'ARC':
          prims.push({
            kind: 'line', layer, closed: false, viaSymbol,
            pts: arcPoints(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle).map(([x, y]) => apply(m, x, y)),
          });
          break;
        case 'CIRCLE':
          prims.push({
            kind: 'line', layer, closed: true, viaSymbol,
            pts: arcPoints(e.center.x, e.center.y, e.radius, 0, Math.PI * 2, 16).map(([x, y]) => apply(m, x, y)),
          });
          break;
        case 'TEXT':
        case 'MTEXT': {
          const p = e.position || e.startPoint;
          if (!p || viaSymbol) break;
          const [x, y] = apply(m, p.x, p.y);
          prims.push({ kind: 'text', layer, text: cleanText(e.text), x, y });
          break;
        }
        case 'INSERT': {
          const block = blocks[e.name];
          if (!block || depth >= MAX_DEPTH) break;
          const cols = Math.max(1, e.columnCount || 1);
          const rows = Math.max(1, e.rowCount || 1);
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const ins = {
                ...e,
                position: { x: (e.position?.x || 0) + c * (e.columnSpacing || 0), y: (e.position?.y || 0) + r * (e.rowSpacing || 0) },
              };
              const mm = mul(m, insertMatrix(ins, block.position));
              const isSymbol = symbolLayer?.(layer);
              if (isSymbol && !viaSymbol) {
                const before = prims.length;
                walk(block.entities, mm, layer, depth + 1, true);
                const inner = prims.splice(before);
                const xs = inner.flatMap((p) => (p.pts || []).map((q) => q[0]));
                const ys = inner.flatMap((p) => (p.pts || []).map((q) => q[1]));
                const [px, py] = apply(m, ins.position.x, ins.position.y);
                prims.push({
                  kind: 'symbol', layer, name: e.name, x: px, y: py,
                  rot: ((e.rotation || 0) + 360) % 360, sx: e.xScale ?? 1, sy: e.yScale ?? 1,
                  bbox: xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : null,
                });
              } else {
                walk(block.entities, mm, layer, depth + 1, viaSymbol);
              }
            }
          }
          break;
        }
        default:
          break;
      }
    }
  };

  walk(dxf.entities, IDENT, '0', 0, false);
  return prims;
}

/** Metres per drawing unit from $INSUNITS, with a sanity check against the drawing extent. */
export function unitScale(dxf, prims) {
  const units = dxf.header?.$INSUNITS;
  const table = { 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1 };
  if (table[units]) return table[units];
  // Unitless: a building plate is tens of metres, so a bay of several thousand units means mm.
  const rooms = prims.filter((p) => p.kind === 'text' && /\d+(\.\d+)?\s*[xX]\s*\d+(\.\d+)?/.test(p.text));
  return rooms.some((r) => /\d{4}\s*[xX]\s*\d{4}/.test(r.text)) ? 0.001 : 1;
}
