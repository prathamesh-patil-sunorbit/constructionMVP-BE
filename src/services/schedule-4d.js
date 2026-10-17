// 4D building model from an uploaded MS Project schedule.
//
// Each wing (A-WING, B-WING …) becomes a tower of levels: basement, stilt, podiums, typical floors,
// terrace and the rooms above it. Every task is placed on its wing, its level (from names such as
// "05 SLAB ( 1ST FLOOR)", "01 FLOOR", "PODIUM 3 FLOOR LEVEL", "11 TO 20 FLOOR") and its trade (the
// work package it sits under: RCC, BLOCKWORK, PLUMBING …). The screen then colours each level by
// what is happening on it at any date, using the schedule's own dates. Nothing is estimated here.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { structure } from './schedule-sim.js';

// Building profiles (floor plan, flats, facade) traced from a project's drawings, in src/data/buildings.
const PROFILE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/buildings');
export function buildingProfile(...names) {
  let files = [];
  try { files = fs.readdirSync(PROFILE_DIR).filter((f) => f.endsWith('.json')); } catch { return null; }
  const text = names.filter(Boolean).join(' ').toUpperCase();
  for (const f of files) {
    const p = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, f), 'utf8'));
    if (p.match && text.includes(String(p.match).toUpperCase())) return p;
  }
  return null;
}

// Order of work on a floor; the stage a level shows is the last of these that has started.
export const STAGES = [
  { key: 'structure', label: 'Structure (RCC)', match: /rcc|sub-?\s*structure|super-?\s*structure|excavation/i },
  { key: 'masonry', label: 'Blockwork & plaster', match: /blockwork|plaster|grinding/i },
  { key: 'services', label: 'Waterproofing & services', match: /waterproof|plumbing|electrical|fire\s*fighting|lift/i },
  { key: 'finishes', label: 'Tiling, doors & windows', match: /tiling|carpentry|fabrication|alumin|window|false\s*ceiling|sanitary|^cp$|vdp/i },
  { key: 'painting', label: 'Painting & handover', match: /painting|acid|grouting|snag|clean|elevation|solar|other\s*service|noc/i },
];
const stageOf = (pkg) => STAGES.find((s) => s.match.test(pkg || ''))?.key ?? null;

const ORDINAL = /(\d{1,2})\s*(?:st|nd|rd|th)?\s*floor/i;

/** Level keys a task name refers to (several for "11 TO 20 FLOOR"). */
export function levelsIn(name) {
  const n = String(name || '').toUpperCase();
  const range = /(\d{1,2})\s*TO\s*(\d{1,2})\s*FLOOR/.exec(n);
  if (range) {
    const out = [];
    for (let f = Number(range[1]); f <= Number(range[2]); f++) out.push(`F${f}`);
    return out;
  }
  // The level a slab task names is in its brackets: "05 SLAB ( 1ST FLOOR)".
  const inner = /SLAB\s*\(([^)]*)\)/.exec(n)?.[1] ?? n;
  if (/ABOVE\s*TERRACE|MUMTY|LMR|\bOHT\b/.test(inner)) return ['ABOVE'];
  if (/TERRACE\s*FLOOR|TOP\s*TERRACE|\(\s*TERRACE/.test(inner) || /^\s*TERRACE/.test(inner)) return ['TERRACE'];
  const podium = /PODIUM\s*(\d)/.exec(inner);
  if (podium) return [`P${podium[1]}`];
  if (/STILT/.test(inner)) return ['STILT'];
  if (/BASEMENT/.test(inner)) return ['B1'];
  const floor = ORDINAL.exec(inner);
  if (floor) return [`F${Number(floor[1])}`];
  return [];
}

const LEVEL_ORDER = (key) => {
  if (key === 'B1') return 0;
  if (key === 'STILT') return 1;
  if (key[0] === 'P') return 10 + Number(key.slice(1));
  if (key[0] === 'F') return 100 + Number(key.slice(1));
  if (key === 'TERRACE') return 200;
  return 300; // ABOVE
};
const LEVEL_NAME = (key) => ({ B1: 'Basement', STILT: 'Stilt', TERRACE: 'Terrace', ABOVE: 'Above terrace (LMR / OHT)' })[key]
  || (key[0] === 'P' ? `Podium ${key.slice(1)}` : `Floor ${key.slice(1)}`);
const LEVEL_KIND = (key) => (key === 'B1' ? 'basement' : key === 'STILT' || key[0] === 'P' ? 'podium' : key[0] === 'F' ? 'floor' : key === 'TERRACE' ? 'terrace' : 'above');

// "05 FLOOR" on its own says nothing; the group it sits in says what the work is.
const FLOOR_ONLY = /^\s*(\d{1,2}\s*(st|nd|rd|th)?\s*floor|(stilt|podium\s*\d|basement\s*\d?)[\w\s()+]*level|\d{1,2}\s*to\s*\d{1,2}\s*floor)/i;
const brief = (t, pkg, stage, s) => ({
  uid: t.uid, name: t.name, trade: pkg, stage, wbs: t.wbs,
  activity: FLOOR_ONLY.test(t.name) ? (s.byUid.get(t.parentUid)?.level > s.minLevel + 2 ? s.byUid.get(t.parentUid).name : pkg) : t.name,
  start: t.start, finish: t.finish, baselineStart: t.baselineStart, baselineFinish: t.baselineFinish,
  actualStart: t.actualStart ?? null, actualFinish: t.actualFinish ?? null,
  percent: t.percent, status: t.status, critical: !!t.critical,
});

export function build4d(doc) {
  const tasks = doc.tasks;
  const s = structure(tasks);
  const leaves = tasks.filter((t) => !t.summary && t.start && t.finish);
  const wings = tasks.filter((t) => t.level === s.minLevel + 1 && /wing|tower|block/i.test(t.name));

  const towers = wings.map((w) => {
    const levels = new Map();
    const level = (key) => {
      if (!levels.has(key)) levels.set(key, { key, name: LEVEL_NAME(key), kind: LEVEL_KIND(key), order: LEVEL_ORDER(key), tasks: [] });
      return levels.get(key);
    };
    const general = [];
    for (const t of leaves) {
      if (s.areaOf(t)?.uid !== w.uid) continue;
      const pkg = s.packageOf(t)?.name ?? t.name;
      const stage = stageOf(pkg);
      // A floor can be named on the task itself or on the group it sits in (e.g. a slab's activities).
      let keys = levelsIn(t.name);
      for (let p = s.byUid.get(t.parentUid); !keys.length && p && p.level > s.minLevel + 1; p = s.byUid.get(p.parentUid)) keys = levelsIn(p.name);
      // The sub-structure (raft, footings, retaining wall) is the basement.
      if (!keys.length && /sub-?\s*structure|excavation/i.test([pkg, ...t.path].join(' '))) keys = ['B1'];
      if (!keys.length) { general.push(brief(t, pkg, stage, s)); continue; }
      for (const k of keys) level(k).tasks.push(brief(t, pkg, stage, s));
    }
    // Every typical floor up to the highest one named, even if only the slab mentions it.
    const top = Math.max(0, ...[...levels.keys()].filter((k) => k[0] === 'F').map((k) => Number(k.slice(1))));
    for (let f = 1; f <= top; f++) level(`F${f}`);
    const list = [...levels.values()].sort((a, b) => a.order - b.order).map((l) => {
      const structureTasks = l.tasks.filter((t) => t.stage === 'structure');
      const span = (arr, a, b) => (arr.length ? { start: new Date(Math.min(...arr.map((x) => +new Date(x[a])))), finish: new Date(Math.max(...arr.map((x) => +new Date(x[b])))) } : null);
      return {
        key: l.key, name: l.name, kind: l.kind,
        structure: span(structureTasks, 'start', 'finish'),
        structureBaseline: span(structureTasks.filter((t) => t.baselineStart && t.baselineFinish), 'baselineStart', 'baselineFinish'),
        tasks: l.tasks.sort((a, b) => new Date(a.start) - new Date(b.start)),
      };
    });
    // A level with no slab of its own (Podium 4 here) is cast with the slab above it.
    for (let i = list.length - 1; i >= 0; i--) {
      if (!list[i].structure && list[i + 1]?.structure) {
        list[i].structure = list[i + 1].structure;
        list[i].structureBaseline = list[i + 1].structureBaseline;
        list[i].structureFrom = list[i + 1].name;
        // The shared slab's own task (with its actual progress) drives this level too.
        list[i].tasks.unshift(...list[i + 1].tasks.filter((t) => t.stage === 'structure').map((t) => ({ ...t, sharedWith: list[i + 1].name })));
      }
    }
    return {
      uid: w.uid,
      name: /^([A-Z])\s*-?\s*WING/i.test(w.name) ? `${w.name.match(/^([A-Z])/i)[1].toUpperCase()}-Wing` : w.name,
      fullName: w.name,
      start: w.start, finish: w.finish, baselineFinish: w.baselineFinish, percent: w.percent,
      levels: list,
      general: general.sort((a, b) => new Date(a.start) - new Date(b.start)),
    };
  });

  const starts = leaves.map((t) => +new Date(t.start));
  const finishes = leaves.map((t) => +new Date(t.finish));
  const baselineFinishes = leaves.map((t) => t.baselineFinish && +new Date(t.baselineFinish)).filter(Boolean);
  return {
    title: doc.title,
    statusDate: doc.statusDate,
    start: new Date(Math.min(...starts)),
    finish: new Date(Math.max(...finishes)),
    baselineFinish: baselineFinishes.length ? new Date(Math.max(...baselineFinishes)) : null,
    stages: STAGES.map(({ key, label }) => ({ key, label })),
    towers,
    other: tasks.filter((t) => t.level === s.minLevel + 1 && !wings.includes(t)).map((a) => ({ uid: a.uid, name: a.name, start: a.start, finish: a.finish, percent: a.percent })),
  };
}
