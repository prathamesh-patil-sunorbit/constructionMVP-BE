// Geotech agent: plinth estimate from a geotechnical report.
//
//   report (PDF / photo) -> Gemini extracts soil facts -> rules calculate each phase
//   -> calibrated by recorded site actuals -> Gemini explains -> a person accepts or rejects
//
// Gemini reads the document and writes the explanation. It never produces days, machines or
// worker counts: those come from the rates under rules.ai.geotech, adjusted by what earlier
// estimates actually took on site (see calibrate()). Every phase lists the formula it used.

import { Type } from '@google/genai';
import { extractText, getDocumentProxy } from 'unpdf';
import { AiPrediction, AiRun, GeotechReport, Project } from '../../models/index.js';
import { askGemini, aiConfig } from './gemini.js';
import { getRules } from '../settings.js';
import { fmt } from '../../utils/dates.js';

const round = (n, dp = 1) => {
  const f = 10 ** dp;
  return Math.round((Number(n) || 0) * f) / f;
};
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const ceil = (n) => Math.max(1, Math.ceil(n - 1e-9));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const SOIL_LABELS = { soft: 'Soft soil', ordinary: 'Ordinary soil', hard: 'Hard strata', rock: 'Rock' };
const FOUNDATION_LABELS = { isolated: 'Isolated footings', raft: 'Raft', pile: 'Pile foundation' };

// ---------------------------------------------------------------------------
// 1. Extraction (the only step where the model reads the report)
// ---------------------------------------------------------------------------

// The JSON shape is described in the prompt rather than enforced as a response schema: with a
// strict number-typed schema, Gemini 3 often falls into a digit loop on the first depth and
// returns an almost empty answer. Plain JSON mode reads the same reports reliably, and
// normaliseFacts() validates every field anyway.
const EXTRACTION_SHAPE = `Return one JSON object with exactly these keys (use null where the report does not say):
{
  "isGeotechnicalReport": true,
  "reportTitle": "string or null",
  "boreholes": number or null,
  "layers": [{ "fromDepthM": number or null, "toDepthM": number or null, "description": "string", "sptN": number or null, "sourceText": "short quote", "page": number or null }],
  "groundwaterDepthM": number or null,
  "groundwaterNote": "string or null",
  "rockOrBoulderPresent": true, false or null,
  "rockDepthM": number or null,
  "bearingCapacity": { "value": number, "unit": "kN/m2" | "t/m2" | "kg/cm2", "depthM": number or null, "sourceText": "short quote", "page": number or null } or null,
  "recommendedFoundation": "isolated" | "raft" | "pile" | null,
  "recommendedDepthM": number or null,
  "evidence": { "groundwater": { "quote": "string", "page": number } or null, "rock": same or null, "foundation": same or null, "depth": same or null },
  "keyFindings": [{ "label": "string", "value": "string as printed", "page": number or null }],
  "notes": "string or null"
}`;

const EXTRACTION_SYSTEM = `You are reading a geotechnical (soil investigation) report for a building site in India.
Read every page: the summary text, tables and borehole logs. Extract only facts that are printed in the document.
Use null for anything the document does not state.
- layers: one entry per stratum, top to bottom, depths in metres below existing ground level. Layers described in the
  text (for example "LAYER I: FILL ... lower boundary at 1.5 m") count as layers. If depths differ between boreholes,
  give the shallowest top and deepest bottom stated for that layer, and quote the range in sourceText.
- groundwaterDepthM: depth of the water table in metres. If a range is given, use the shallowest value and put the full
  range in groundwaterNote. Use null only if it was not encountered, and say so in groundwaterNote.
- rockOrBoulderPresent / rockDepthM: whether hard rock (not completely weathered rock) or boulders were met, and the
  shallowest depth where they start.
- bearingCapacity: the recommended safe or net allowable bearing capacity, its unit (kN/m2, t/m2 or kg/cm2) and depth.
- recommendedFoundation: "isolated" for isolated, pad, spread, strip or combined footings; "raft" for raft or mat;
  "pile" for piles; null if the report does not recommend one.
- recommendedDepthM: the recommended founding or excavation depth in metres, or the depth of the stratum the report
  says the foundation should rest on.
- page: the PDF page number the fact is printed on (1 = first page of the file).
- evidence: a short quote and page for the groundwater, rock, foundation and depth facts.
- keyFindings: other useful engineering facts as printed (settlement, slopes, concrete grade, exposure, rock strength).
Write every depth as a plain decimal with at most two decimal places.
Never estimate excavation days, number of JCBs or excavators, worker counts, quantities or costs. Those are calculated
elsewhere from your facts. If the file is not a soil report, set isGeotechnicalReport to false.

${EXTRACTION_SHAPE}`;

const FACT_KEYS = ['layers', 'groundwaterDepthM', 'rockOrBoulderPresent', 'bearingCapacity', 'recommendedFoundation'];

function toKnM2(bc) {
  const value = num(bc?.value);
  if (value === null || value <= 0) return null;
  const factor = { 'kN/m2': 1, 't/m2': 9.80665, 'kg/cm2': 98.0665 }[bc.unit] ?? null;
  return factor ? round(value * factor, 0) : null;
}

// A depth must be a believable number of metres; anything else is treated as not stated.
function depth(v) {
  const d = num(v);
  if (d === null || d < 0 || d > 150) return null;
  return round(d, 2);
}
const page = (v) => {
  const n = num(v);
  return n !== null && n >= 1 && n <= 2000 ? Math.round(n) : null;
};
const quote = (v) => (v ? String(v).trim().slice(0, 160) : null);

function evidenceOf(e) {
  return e && quote(e.quote) ? { quote: quote(e.quote), page: page(e.page) } : null;
}

// Clean the model output: numbers stay numbers, unknown stays null, nothing is filled in.
export function normaliseFacts(raw = {}) {
  const layers = (Array.isArray(raw.layers) ? raw.layers : [])
    .filter((l) => l && String(l.description || '').trim())
    .map((l) => {
      const from = depth(l.fromDepthM);
      let to = depth(l.toDepthM);
      // A layer thinner than 5 cm, or ending above where it starts, is a misread bottom depth.
      if (from !== null && to !== null && to - from < 0.05) to = null;
      return {
        fromDepthM: from,
        toDepthM: to,
        description: String(l.description).trim().slice(0, 200),
        sptN: num(l.sptN),
        sourceText: quote(l.sourceText),
        page: page(l.page),
      };
    });
  const bc = raw.bearingCapacity && num(raw.bearingCapacity.value) !== null && num(raw.bearingCapacity.value) > 0
    ? {
      value: num(raw.bearingCapacity.value),
      unit: raw.bearingCapacity.unit,
      depthM: depth(raw.bearingCapacity.depthM),
      sourceText: quote(raw.bearingCapacity.sourceText),
      page: page(raw.bearingCapacity.page),
      kNm2: toKnM2(raw.bearingCapacity),
    }
    : null;
  const foundation = ['isolated', 'raft', 'pile'].includes(raw.recommendedFoundation) ? raw.recommendedFoundation : null;
  const ev = raw.evidence || {};
  const facts = {
    isGeotechnicalReport: raw.isGeotechnicalReport !== false,
    reportTitle: raw.reportTitle || null,
    boreholes: num(raw.boreholes),
    layers,
    groundwaterDepthM: depth(raw.groundwaterDepthM),
    groundwaterNote: raw.groundwaterNote || null,
    rockOrBoulderPresent: typeof raw.rockOrBoulderPresent === 'boolean' ? raw.rockOrBoulderPresent : null,
    rockDepthM: depth(raw.rockDepthM),
    bearingCapacity: bc,
    recommendedFoundation: foundation,
    recommendedDepthM: depth(raw.recommendedDepthM),
    evidence: {
      groundwater: evidenceOf(ev.groundwater),
      rock: evidenceOf(ev.rock),
      foundation: evidenceOf(ev.foundation),
      depth: evidenceOf(ev.depth),
    },
    keyFindings: (Array.isArray(raw.keyFindings) ? raw.keyFindings : [])
      .filter((k) => k && String(k.label || '').trim() && String(k.value || '').trim())
      .slice(0, 10)
      .map((k) => ({ label: String(k.label).trim().slice(0, 60), value: String(k.value).trim().slice(0, 120), page: page(k.page) })),
    notes: raw.notes || null,
  };
  // "Not encountered" is an answer about groundwater, not a gap.
  const has = { layers: layers.length > 0, groundwaterDepthM: facts.groundwaterDepthM !== null || !!facts.groundwaterNote };
  const present = FACT_KEYS.filter((k) => has[k] ?? facts[k] !== null);
  facts.completeness = { found: present.length, of: FACT_KEYS.length, missing: FACT_KEYS.filter((k) => !present.includes(k)) };
  return facts;
}

// Signs that a read went wrong, judged on the raw model output before cleaning. A model can
// fall into a repetition loop (e.g. "0.0000150383838…") and return a near-empty answer; that
// must trigger a re-read, not be shown as the report's content.
function readIssues(raw) {
  const issues = [];
  const layers = Array.isArray(raw?.layers) ? raw.layers : [];
  const depths = [
    ...layers.flatMap((l) => [l?.fromDepthM, l?.toDepthM]),
    raw?.groundwaterDepthM, raw?.rockDepthM, raw?.recommendedDepthM, raw?.bearingCapacity?.depthM,
  ].map(num).filter((d) => d !== null);
  if (depths.some((d) => d < 0 || d > 150)) issues.push('a depth outside 0–150 m');
  if (depths.some((d) => Math.abs(d * 100 - Math.round(d * 100)) > 1e-6)) issues.push('a depth with more than two decimals');
  if (layers.some((l) => num(l?.fromDepthM) !== null && num(l?.toDepthM) !== null && num(l.toDepthM) - num(l.fromDepthM) < 0.05)) {
    issues.push('a layer thinner than 5 cm');
  }
  return issues;
}

const readScore = (facts, issues) => facts.completeness.found * 10 + Math.min(facts.layers.length, 8) - issues.length * 15;

// Pull the text layer out of a PDF ourselves, page by page. Some PDFs are slightly malformed and
// make the model's own PDF reader return almost nothing, while their text is perfectly readable.
// Returns null for scanned PDFs with no usable text, which then go to the model as a file.
const MAX_TEXT_CHARS = 200_000;
async function pdfText(fileBase64) {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(Buffer.from(fileBase64, 'base64')));
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const chars = text.reduce((n, t) => n + t.trim().length, 0);
    if (chars < 300 || chars / Math.max(1, totalPages) < 80) return null;
    const joined = text.map((t, i) => `=== PAGE ${i + 1} ===\n${t.trim()}`).join('\n\n').slice(0, MAX_TEXT_CHARS);
    return { pages: totalPages, base64: Buffer.from(joined, 'utf8').toString('base64') };
  } catch {
    return null;
  }
}

const RE_READ_HINT = 'The previous reading of this report came back incomplete or malformed. Read every page again carefully, '
  + 'including the subsurface conditions, groundwater, foundation recommendation sections and tables.';

/**
 * Read the report. Returns { status: 'Read', facts } or { status: 'Not read', reason } — never
 * invented soil data. A weak or malformed answer is re-read (up to 3 attempts, the later ones
 * with a note asking for a careful re-read, and older models at a higher temperature) and the best is kept.
 */
export async function extractFacts({ fileBase64, mimeType, originalName }) {
  if (!aiConfig().configured) {
    return { status: 'Not read', reason: 'GEMINI_API_KEY is not configured, so the report cannot be read. The file has been saved.' };
  }
  // Text-based PDFs: read the extracted text (page markers keep page numbers), and keep the
  // original PDF as the last fallback. Scanned PDFs and photos: the model reads the file itself.
  const text = mimeType === 'application/pdf' ? await pdfText(fileBase64) : null;
  const asFile = { mimeType, data: fileBase64 };
  const asText = text && { mimeType: 'text/plain', data: text.base64 };
  const attempts = text
    ? [{ file: asText, via: 'text', temperature: 0.2 }, { file: asText, via: 'text', temperature: 0.5, hint: true }, { file: asFile, via: 'pdf', temperature: 0.2, hint: true }]
    : [{ file: asFile, via: 'file', temperature: 0.2 }, { file: asFile, via: 'file', temperature: 0.5, hint: true }, { file: asFile, via: 'file', temperature: 0.8, hint: true }];
  let best = null;
  let usage = {};
  let latencyMs = 0;
  let model = null;
  let lastError = null;
  let tried = 0;

  for (const a of attempts) {
    tried += 1;
    const startedAt = Date.now();
    try {
      const res = await askGemini({
        system: EXTRACTION_SYSTEM,
        payload: {
          task: 'Extract soil facts from the attached report',
          fileName: originalName || null,
          ...(a.via === 'text' ? { format: 'The attachment is the text of the PDF; "=== PAGE n ===" marks the start of page n.' } : {}),
          ...(a.hint ? { note: RE_READ_HINT } : {}),
        },
        schema: null,
        file: a.file,
        temperature: a.temperature,
        // A multi-page PDF is slow to read and the provider is often briefly overloaded.
        retry: { attempts: 3, timeoutMs: 120_000, backoffMs: 3000 },
      });
      usage = addUsage(usage, res.usage);
      latencyMs += res.latencyMs || 0;
      model = res.model;
      const issues = readIssues(res.data);
      const facts = normaliseFacts(res.data);
      const score = readScore(facts, issues);
      if (!best || score > best.score) best = { facts, issues, score, via: a.via };
      console.info(`Geotech read attempt ${tried} via ${a.via}: ${Math.round((Date.now() - startedAt) / 1000)}s, ${facts.completeness.found}/5 facts, ${facts.layers.length} layers${issues.length ? `, issues: ${issues.join('; ')}` : ''}`);
      // Good enough: most key facts and nothing malformed.
      if (!issues.length && facts.completeness.found >= 3) break;
    } catch (error) {
      lastError = error;
      console.info(`Geotech read attempt ${tried} via ${a.via} failed after ${Math.round((Date.now() - startedAt) / 1000)}s: ${error.message.slice(0, 160)}`);
      // Busy, quota or key problems will not be fixed by asking again straight away.
      if ([429, 403, 404].includes(error.providerStatus)) break;
    }
  }

  if (!best) {
    const error = lastError || {};
    const reason = {
      503: 'Google’s AI service is busy right now. The file is saved; run the estimate again in a few minutes.',
      429: `The AI quota is used up${error.retryAt ? `; it resets around ${error.retryAt.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}. The file is saved: use Try again after that, or enable billing on the Gemini key.`,
      timeout: 'The AI took too long to read this report. Try a smaller PDF (fewer pages) or run it again.',
      403: 'The Gemini API key was refused. Check GEMINI_API_KEY in the backend .env.',
      404: 'The configured Gemini model is not available. Check GEMINI_MODEL in the backend .env.',
    }[error.providerStatus];
    return { status: 'Not read', reason: reason || `The AI service could not read the report: ${error.message}` };
  }

  const { facts, issues, via } = best;
  facts.readQuality = { attempts: tried, issues, via, pages: text?.pages ?? null };
  if (!facts.isGeotechnicalReport || facts.completeness.found === 0) {
    return {
      status: 'Not read', reason: 'The file did not contain recognisable soil information (bore log, water table, bearing capacity or foundation recommendation).',
      model, usage, latencyMs,
    };
  }
  return { status: 'Read', facts, model, usage, latencyMs };
}

// Fixed hard-strata profile (typical Pune basalt site) so the screen works without Gemini.
export const SAMPLE_FACTS = normaliseFacts({
  isGeotechnicalReport: true,
  reportTitle: 'Sample soil profile — hard strata (not a real report)',
  boreholes: 1,
  layers: [
    { fromDepthM: 0, toDepthM: 0.6, description: 'Filled-up soil with debris', sptN: null, sourceText: 'Sample: 0.0–0.6 m filled-up soil' },
    { fromDepthM: 0.6, toDepthM: 1.8, description: 'Yellowish brown murum (weathered basalt)', sptN: 45, sourceText: 'Sample: 0.6–1.8 m murum, N = 45' },
    { fromDepthM: 1.8, toDepthM: 3.5, description: 'Hard amygdaloidal basalt rock', sptN: null, sourceText: 'Sample: 1.8–3.5 m hard amygdaloidal basalt, core recovery 70%' },
    { fromDepthM: 3.5, toDepthM: 6, description: 'Hard compact basalt rock', sptN: null, sourceText: 'Sample: 3.5–6.0 m compact basalt' },
  ],
  groundwaterDepthM: null,
  groundwaterNote: 'Water table not encountered up to 6.0 m (sample).',
  rockOrBoulderPresent: true,
  rockDepthM: 1.8,
  bearingCapacity: { value: 40, unit: 't/m2', depthM: 1.5, sourceText: 'Sample: SBC 40 t/m² at 1.5 m' },
  recommendedFoundation: 'isolated',
  recommendedDepthM: 1.5,
  notes: 'Built-in sample for demonstration.',
});

// ---------------------------------------------------------------------------
// 2. Soil class and foundation (rules)
// ---------------------------------------------------------------------------

const ROCK_RE = /\b(rock|basalt|granite|boulders?|trap|gneiss|quartzite|sandstone|limestone)\b/i;
const WEATHERED_RE = /\b(weathered|disintegrated|fractured|soft rock|sdr|murr?um|moorum)\b/i;
const HARD_RE = /\b(hard|very dense|dense|gravel|gravelly|cemented|stiff)\b/i;
const SOFT_RE = /\b(soft|loose|black cotton|marine clay|peat|silt|silty clay|made ground)\b/i;
const RANK = ['soft', 'ordinary', 'hard', 'rock'];

function wordClass(description) {
  if (ROCK_RE.test(description) && !WEATHERED_RE.test(description)) return 'rock';
  if (WEATHERED_RE.test(description) || HARD_RE.test(description)) return 'hard';
  if (SOFT_RE.test(description)) return 'soft';
  return 'ordinary';
}

export function classifySoil(facts, depthM, rules) {
  const g = rules.ai.geotech;
  const reasons = [];
  // Layers that start above the excavation bottom are the ones the JCB digs through.
  const dug = facts.layers.filter((l) => l.fromDepthM === null || l.fromDepthM < depthM);

  const rockLayer = dug.find((l) => wordClass(l.description) === 'rock');
  let rock = false;
  if (rockLayer) {
    rock = true;
    reasons.push(`Rock layer within the ${depthM} m excavation: "${rockLayer.description}"${rockLayer.fromDepthM !== null ? ` from ${rockLayer.fromDepthM} m` : ''}.`);
  } else if (facts.rockOrBoulderPresent) {
    if (facts.rockDepthM !== null) {
      rock = facts.rockDepthM < depthM;
      reasons.push(rock
        ? `Rock/boulders reported from ${facts.rockDepthM} m, above the ${depthM} m excavation bottom.`
        : `Rock/boulders reported from ${facts.rockDepthM} m, below the ${depthM} m excavation, so they are not dug.`);
    } else {
      rock = true;
      reasons.push('Report mentions rock or boulders without a depth, so rock is assumed within the excavation.');
    }
  }

  const sbc = facts.bearingCapacity?.kNm2 ?? null;
  let soilClass;
  if (rock) {
    soilClass = 'rock';
  } else {
    let bySbc = null;
    if (sbc !== null) {
      bySbc = sbc < g.softSbcBelowKnM2 ? 'soft' : sbc >= g.hardSbcFromKnM2 ? 'hard' : 'ordinary';
      reasons.push(`Safe bearing capacity ${sbc} kN/m² → ${SOIL_LABELS[bySbc].toLowerCase()} (soft < ${g.softSbcBelowKnM2}, hard ≥ ${g.hardSbcFromKnM2}).`);
    }
    let byWords = null;
    if (dug.length) {
      byWords = dug.map((l) => wordClass(l.description)).filter((c) => c !== 'rock').reduce((a, c) => (RANK.indexOf(c) > RANK.indexOf(a) ? c : a), 'soft');
      // A soft bottom layer only counts if nothing harder is dug through.
      reasons.push(`Layers within ${depthM} m (${dug.map((l) => l.description).join('; ')}) read as ${SOIL_LABELS[byWords].toLowerCase()}.`);
    }
    if (bySbc && byWords) soilClass = RANK.indexOf(byWords) > RANK.indexOf(bySbc) ? byWords : bySbc;
    else soilClass = bySbc || byWords || 'ordinary';
    if (!bySbc && !byWords) reasons.push('No bearing capacity or layer description in the report: ordinary soil assumed.');
    else if (bySbc && byWords && bySbc !== byWords) reasons.push(`The harder of the two readings (${SOIL_LABELS[soilClass].toLowerCase()}) governs digging.`);
  }

  const gw = facts.groundwaterDepthM;
  // Water at the excavation bottom still floods the pit, so it counts as well as water above it.
  const dewatering = gw !== null && gw <= depthM;
  if (gw !== null) {
    reasons.push(dewatering
      ? `Water table at ${gw} m is ${gw < depthM ? 'above' : 'at'} the ${depthM} m excavation bottom: dewatering added.`
      : `Water table at ${gw} m is below the excavation bottom: no dewatering.`);
  } else {
    reasons.push(facts.groundwaterNote ? `Groundwater: ${facts.groundwaterNote}` : 'Groundwater depth not stated: no dewatering assumed.');
  }
  return { class: soilClass, label: SOIL_LABELS[soilClass], dewatering, sbcKnM2: sbc, reasons };
}

export function chooseFoundation(facts, sbc, rules) {
  const g = rules.ai.geotech;
  if (facts.recommendedFoundation === 'pile') return { type: 'pile', source: 'report', reason: 'Report recommends a pile foundation.' };
  if (facts.recommendedFoundation === 'raft') return { type: 'raft', source: 'report', reason: 'Report recommends a raft foundation.' };
  if (sbc !== null && sbc < g.raftBelowSbcKnM2) {
    return { type: 'raft', source: 'rule', reason: `Bearing capacity ${sbc} kN/m² is below the raft threshold of ${g.raftBelowSbcKnM2} kN/m².` };
  }
  if (facts.recommendedFoundation === 'isolated') return { type: 'isolated', source: 'report', reason: 'Report recommends isolated footings.' };
  return { type: 'isolated', source: 'assumed', reason: 'No foundation recommended in the report: isolated footings assumed.' };
}

// ---------------------------------------------------------------------------
// 3. Learning from site actuals
// ---------------------------------------------------------------------------
//
// Hierarchical Bayesian shrinkage in log space. Each recorded actual gives an observed JCB rate
// (loose m³ ÷ JCB-days, normalised for dewatering). A site-wide efficiency factor is learned from
// all observations, then each soil class moves from its default (times that factor) toward its
// own observed mean. The default counts as `priorWeight` observations, so one odd job cannot
// swing the rate and a class with no history still benefits from the others.

export async function calibrate(rules) {
  const g = rules.ai.geotech;
  const { priorWeight: k, minFactor, maxFactor } = g.learning;
  const done = await GeotechReport.find({
    'actual.excavationDays': { $gt: 0 }, 'actual.jcbCount': { $gt: 0 }, estimate: { $ne: null },
  }, 'estimate actual').lean();

  const obs = [];
  const schedule = [];
  for (const r of done) {
    const est = r.estimate;
    const cls = est?.soil?.class;
    const vol = est?.excavation?.looseVolumeM3;
    if (!g.jcbM3PerDay[cls] || !vol) continue;
    const wet = est.soil.dewatering ? g.dewateringProductivityFactor : 1;
    const rate = vol / (r.actual.jcbCount * r.actual.excavationDays) / wet;
    obs.push({ cls, logRatio: Math.log(rate / g.jcbM3PerDay[cls]), logRate: Math.log(rate) });
    const estRest = (est.totals?.calendarDays ?? 0) - (est.excavation?.days ?? 0);
    if (r.actual.totalDays > r.actual.excavationDays && estRest > 0) {
      schedule.push(Math.log((r.actual.totalDays - r.actual.excavationDays) / estRest));
    }
  }

  const clamp = (f) => Math.min(maxFactor, Math.max(minFactor, f));
  const siteLog = obs.reduce((s, o) => s + o.logRatio, 0) / (obs.length + k);
  const siteFactor = clamp(Math.exp(siteLog));

  const rates = {};
  for (const [cls, base] of Object.entries(g.jcbM3PerDay)) {
    const mine = obs.filter((o) => o.cls === cls);
    const priorLog = Math.log(base * siteFactor);
    const postLog = (k * priorLog + mine.reduce((s, o) => s + o.logRate, 0)) / (k + mine.length);
    const factor = clamp(Math.exp(postLog) / base);
    rates[cls] = {
      default: base,
      used: round(base * factor, 0),
      factor: round(factor, 2),
      observations: mine.length,
      weight: round(mine.length / (mine.length + k), 2),
    };
  }
  const scheduleFactor = schedule.length
    ? clamp(Math.exp(schedule.reduce((s, x) => s + x, 0) / (schedule.length + k)))
    : 1;
  return {
    observations: obs.length,
    siteFactor: round(siteFactor, 2),
    rates,
    scheduleFactor: round(scheduleFactor, 2),
    scheduleObservations: schedule.length,
    priorWeight: k,
  };
}

// ---------------------------------------------------------------------------
// 4. Calculation (rules only — no model)
// ---------------------------------------------------------------------------

const crew = (obj) => Object.entries(obj).filter(([, n]) => n > 0).map(([trade, count]) => ({ trade, count }));
const total = (list) => list.reduce((s, x) => s + x.count, 0);

function rccWork({ name, key, volume, shutterSqm, steelKgPerM3, rules, extraBasis = [] }) {
  const r = rules.ai.geotech.rcc;
  const units = Math.min(r.maxGangUnits, ceil(volume / r.m3PerGangUnit));
  const gang = Object.fromEntries(Object.entries(r.gangUnit).map(([t, n]) => [t, n * units]));
  const steelKg = volume * steelKgPerM3;
  const steelDays = ceil(steelKg / (gang.barBenders * r.steelKgPerBarBenderDay));
  const shutterDays = ceil(shutterSqm / (gang.carpenters * r.shutteringSqmPerCarpenterDay));
  const pumped = volume >= r.pumpFromM3;
  const pourDays = ceil(volume / (pumped ? r.pumpM3PerDay : r.mixerM3PerDay));
  const days = Math.max(steelDays, shutterDays) + pourDays + r.curingDays;
  const transitMixers = pumped ? Math.min(6, ceil(volume / pourDays / (r.transitMixerM3 * r.transitMixerTripsPerDay))) : 0;
  const workers = crew({ Masons: gang.masons, 'Bar-benders': gang.barBenders, Carpenters: gang.carpenters, Helpers: gang.helpers });
  return {
    key, name,
    quantity: { value: round(volume), unit: 'm³', label: 'RCC' },
    days,
    workers,
    workerTotal: total(workers),
    machines: crew({ [pumped ? 'Concrete pump' : 'Concrete mixer']: 1, 'Needle vibrator': 2, 'Bar bending machine': 1 }).map(({ trade, count }) => ({ name: trade, count })),
    vehicles: transitMixers ? [{ name: 'Transit mixer', count: transitMixers }] : [],
    basis: [
      ...extraBasis,
      `Gang: ${units} unit(s) of ${r.gangUnit.masons} masons, ${r.gangUnit.barBenders} bar-benders, ${r.gangUnit.carpenters} carpenters, ${r.gangUnit.helpers} helpers (1 unit per ${r.m3PerGangUnit} m³, max ${r.maxGangUnits}).`,
      `Steel ${round(volume)} m³ × ${steelKgPerM3} kg/m³ = ${round(steelKg, 0)} kg ÷ (${gang.barBenders} × ${r.steelKgPerBarBenderDay} kg/day) = ${plural(steelDays, 'day')}.`,
      `Shuttering ${round(shutterSqm)} m² ÷ (${gang.carpenters} × ${r.shutteringSqmPerCarpenterDay} m²/day) = ${plural(shutterDays, 'day')}, in parallel with steel.`,
      `Pour ${round(volume)} m³ by ${pumped ? `pump at ${r.pumpM3PerDay} m³/day (volume ≥ ${r.pumpFromM3} m³)` : `mixer at ${r.mixerM3PerDay} m³/day`} = ${plural(pourDays, 'day')}, then ${r.curingDays} days curing.`,
      `Days = max(${steelDays}, ${shutterDays}) + ${pourDays} + ${r.curingDays} = ${days}.`,
    ],
  };
}

function insufficient(key, name, reason) {
  return { key, name, insufficientData: true, reason, quantity: null, days: 0, workers: [], workerTotal: 0, machines: [], vehicles: [], basis: [reason] };
}

export function calculateEstimate({ facts, plinthAreaSqm, depthM, depthSource, rules, learning }) {
  const g = rules.ai.geotech;
  const A = plinthAreaSqm;
  const D = depthM;
  const soil = classifySoil(facts, D, rules);
  const foundation = chooseFoundation(facts, soil.sbcKnM2, rules);
  const assumptions = [];
  const warnings = [];
  const phases = [];

  // ---- Excavation
  const inSitu = A * D;
  const bulking = g.bulkingFactor[soil.class];
  const loose = inSitu * bulking;
  const rate = learning?.rates?.[soil.class]?.used ?? g.jcbM3PerDay[soil.class];
  const perJcb = rate * (soil.dewatering ? g.dewateringProductivityFactor : 1);
  const needed = ceil(loose / (perJcb * g.targetExcavationDays));
  const siteCap = Math.max(1, Math.min(g.maxJcbs, Math.floor(A / g.plinthAreaPerJcbSqm)));
  const jcbs = Math.min(needed, siteCap);
  const excDays = ceil(loose / (perJcb * jcbs));
  const learned = learning?.rates?.[soil.class];
  const excWorkers = crew({ 'JCB operators': jcbs, Helpers: jcbs * 2, 'Tipper drivers': jcbs, 'Breaker operators': soil.class === 'rock' ? jcbs : 0, 'Pump operator': soil.dewatering ? 1 : 0 });
  phases.push({
    key: 'excavation', name: 'Excavation',
    quantity: { value: round(loose), unit: 'm³', label: 'loose volume' },
    days: excDays,
    workers: excWorkers,
    workerTotal: total(excWorkers),
    machines: [
      { name: 'JCB', count: jcbs },
      ...(soil.class === 'rock' ? [{ name: 'Rock breaker', count: jcbs }] : []),
      ...(soil.dewatering ? [{ name: 'Dewatering pump', count: 1 }] : []),
    ],
    vehicles: [{ name: 'Tipper', count: jcbs }],
    basis: [
      `Volume = ${A} m² × ${D} m × ${bulking} bulking (${soil.label.toLowerCase()}) = ${round(loose)} m³ (${round(inSitu)} m³ in place).`,
      learned && learned.observations
        ? `JCB output ${learned.used} m³/day: default ${learned.default} for ${soil.label.toLowerCase()}, learned from ${plural(learned.observations, 'recorded job')} (factor ${learned.factor}).`
        : learning && learning.observations
          ? `JCB output ${rate} m³/day: default ${g.jcbM3PerDay[soil.class]} for ${soil.label.toLowerCase()} × site factor ${learning.siteFactor} learned from ${plural(learning.observations, 'recorded job')} on other soil.`
          : `JCB output ${rate} m³/day for ${soil.label.toLowerCase()} (default rate; no site actuals recorded yet).`,
      ...(soil.dewatering ? [`Wet ground: output × ${g.dewateringProductivityFactor} = ${round(perJcb, 0)} m³/day per JCB.`] : []),
      `JCBs = min(site cap ${siteCap}, ⌈${round(loose)} ÷ (${round(perJcb, 0)} × ${g.targetExcavationDays} target days)⌉ = ${needed}) = ${jcbs}. Site cap: 1 per ${g.plinthAreaPerJcbSqm} m², max ${g.maxJcbs}.`,
      `Days = ⌈${round(loose)} ÷ (${round(perJcb, 0)} × ${jcbs})⌉ = ${excDays}. One tipper per JCB${soil.class === 'rock' ? ', one breaker per JCB for rock' : ''}${soil.dewatering ? ', one dewatering pump' : ''}.`,
      'Crew: 1 operator and 2 helpers per JCB, plus a driver per tipper.',
    ],
  });
  if (excDays > g.targetExcavationDays) {
    warnings.push({ level: 'warning', text: `Excavation takes ${excDays} days, over the ${g.targetExcavationDays}-day target: only ${jcbs} JCB(s) fit on a ${A} m² plinth.` });
  }

  // ---- PCC + foundation
  let concreteInGround = 0;
  const pcc = g.pcc;
  if (foundation.type === 'pile') {
    phases.push(insufficient('pcc', 'PCC', 'Pile cap sizes are not in the report, so the PCC under the caps cannot be quantified.'));
    phases.push(insufficient('foundation', 'Piles and pile caps', 'Pile count, diameter and length are not in the report: pile days are not estimated. Ask the structural consultant for the pile layout.'));
    warnings.push({ level: 'critical', text: 'Pile foundation: piling and pile caps are not estimated. The totals cover excavation, plinth beam and backfill only.' });
  } else {
    let pccArea;
    let foundationPhase;
    if (foundation.type === 'raft') {
      pccArea = A;
      const vol = A * g.raft.thicknessM;
      const perimeter = 4 * Math.sqrt(A);
      concreteInGround += vol;
      foundationPhase = rccWork({
        key: 'foundation', name: 'Raft', volume: vol, shutterSqm: perimeter * g.raft.thicknessM, steelKgPerM3: g.raft.steelKgPerM3, rules,
        extraBasis: [`Raft ${A} m² × ${g.raft.thicknessM} m = ${round(vol)} m³; edge shuttering on a ${round(perimeter)} m perimeter.`],
      });
    } else {
      const f = g.footing;
      const n = ceil((A / 100) * f.perHundredSqm);
      const vol = n * f.sizeM * f.sizeM * f.depthM;
      pccArea = n * (f.sizeM + 2 * pcc.offsetM) ** 2;
      concreteInGround += vol;
      assumptions.push(`${n} isolated footings of ${f.sizeM} × ${f.sizeM} × ${f.depthM} m (${f.perHundredSqm} per 100 m²). Replace with the structural drawing count when available.`);
      foundationPhase = rccWork({
        key: 'foundation', name: 'Footings', volume: vol, shutterSqm: n * 4 * f.sizeM * f.depthM, steelKgPerM3: f.steelKgPerM3, rules,
        extraBasis: [`Assumed ${n} footings (${f.perHundredSqm} per 100 m² of ${A} m²) of ${f.sizeM} × ${f.sizeM} × ${f.depthM} m = ${round(vol)} m³.`],
      });
    }
    const pccVol = pccArea * pcc.thicknessM;
    concreteInGround += pccVol;
    const pccDays = ceil(pccVol / pcc.m3PerDay);
    const pccWorkers = crew({ Masons: pcc.masons, Helpers: pcc.helpers });
    phases.push({
      key: 'pcc', name: 'PCC',
      quantity: { value: round(pccVol), unit: 'm³', label: 'PCC' },
      days: pccDays,
      workers: pccWorkers,
      workerTotal: total(pccWorkers),
      machines: [{ name: 'Concrete mixer', count: 1 }],
      vehicles: [],
      basis: [
        `PCC area ${round(pccArea)} m²${foundation.type === 'raft' ? ' (full raft)' : ` (footings + ${pcc.offsetM} m offset each side)`} × ${pcc.thicknessM} m = ${round(pccVol)} m³.`,
        `Days = ⌈${round(pccVol)} ÷ ${pcc.m3PerDay} m³/day per mixer⌉ = ${pccDays}. Gang ${pcc.masons} masons + ${pcc.helpers} helpers.`,
      ],
    });
    phases.push(foundationPhase);
  }

  // ---- Plinth beam (rectangular footprint)
  const pb = g.plinthBeam;
  const L = Math.sqrt(A * pb.aspectRatio);
  const W = A / L;
  const perimeter = 2 * (L + W);
  const beamLen = perimeter * pb.lengthFactor;
  const beamVol = beamLen * pb.widthM * pb.depthM;
  phases.push(rccWork({
    key: 'plinthBeam', name: 'Plinth beam', volume: beamVol, shutterSqm: beamLen * 2 * pb.depthM, steelKgPerM3: pb.steelKgPerM3, rules,
    extraBasis: [
      `Footprint ${round(L)} × ${round(W)} m (aspect ${pb.aspectRatio}), perimeter ${round(perimeter)} m × ${pb.lengthFactor} for internal beams = ${round(beamLen)} m.`,
      `Section ${pb.widthM} × ${pb.depthM} m → ${round(beamVol)} m³.`,
    ],
  }));

  // ---- Backfill
  const bf = g.backfill;
  const fill = Math.max(0, inSitu - concreteInGround);
  const bfDays = ceil(fill / bf.m3PerJcbDay);
  const bfWorkers = crew({ 'JCB operators': 1, Helpers: bf.helpers });
  phases.push({
    key: 'backfill', name: 'Backfill',
    quantity: { value: round(fill), unit: 'm³', label: 'compacted fill' },
    days: bfDays,
    workers: bfWorkers,
    workerTotal: total(bfWorkers),
    machines: [{ name: 'JCB', count: 1 }, { name: 'Plate compactor', count: 1 }],
    vehicles: [],
    basis: [
      `Fill = ${round(inSitu)} m³ excavated in place − ${round(concreteInGround)} m³ concrete left in the ground = ${round(fill)} m³${foundation.type === 'pile' ? ' (pile caps not deducted)' : ''}.`,
      `Days = ⌈${round(fill)} ÷ ${bf.m3PerJcbDay} m³/day⌉ = ${bfDays}, laid and compacted in layers.`,
    ],
  });

  // ---- Learned schedule factor for the non-excavation phases
  const sf = learning?.scheduleFactor ?? 1;
  if (sf !== 1) {
    for (const p of phases) {
      if (p.key === 'excavation' || p.insufficientData) continue;
      const before = p.days;
      p.days = Math.max(1, Math.round(before * sf));
      p.basis.push(`Adjusted × ${sf} from ${plural(learning.scheduleObservations, 'recorded job')} (${before} → ${p.days} days).`);
    }
  }

  // ---- Sequence and totals
  let day = 0;
  for (const p of phases) {
    p.startDay = day;
    day += p.days;
    p.endDay = day;
  }
  const peak = (list, name) => Math.max(0, ...phases.map((p) => p[list].find((x) => x.name === name)?.count || 0));
  const machineNames = [...new Set(phases.flatMap((p) => p.machines.map((m) => m.name)))];
  const vehicleNames = [...new Set(phases.flatMap((p) => p.vehicles.map((v) => v.name)))];
  const partial = phases.some((p) => p.insufficientData);
  const totals = {
    calendarDays: day,
    partial,
    peakWorkers: Math.max(...phases.map((p) => p.workerTotal)),
    peakJcbs: peak('machines', 'JCB'),
    tippers: peak('vehicles', 'Tipper'),
    machines: machineNames.map((name) => ({ name, count: peak('machines', name) })),
    otherVehicles: vehicleNames.filter((n) => n !== 'Tipper').map((name) => ({ name, count: peak('vehicles', name) })),
  };

  if (soil.dewatering) warnings.push({ level: 'warning', text: `Water table (${facts.groundwaterDepthM} m) is ${facts.groundwaterDepthM < D ? 'above' : 'at'} the excavation bottom (${D} m): keep a dewatering pump running and protect the PCC from water.` });
  if (soil.class === 'rock') warnings.push({ level: 'warning', text: 'Rock within the excavation: breakers slow digging; check for controlled blasting permissions if the volume is large.' });
  if (depthSource === 'default') warnings.push({ level: 'attention', text: `Excavation depth not given and not stated in the report: ${D} m assumed.` });
  if (facts.completeness.missing.length) {
    warnings.push({ level: 'attention', text: `Not stated in the report: ${facts.completeness.missing.map((k) => ({ layers: 'soil layers', groundwaterDepthM: 'water table', rockOrBoulderPresent: 'rock/boulders', bearingCapacity: 'bearing capacity', recommendedFoundation: 'foundation type' })[k]).join(', ')}.` });
  }

  // Confidence: how much of the report was readable, how much is assumed, how much is learned.
  const readShare = facts.completeness.found / facts.completeness.of;
  const learnedShare = learned?.weight ?? 0;
  const confidence = Math.round(Math.min(95, 35 + 40 * readShare + 15 * learnedShare + (foundation.source === 'report' ? 5 : 0) - (partial ? 20 : 0) - (depthSource === 'default' ? 5 : 0)));

  return {
    soil,
    foundation: { ...foundation, label: FOUNDATION_LABELS[foundation.type] },
    inputs: { plinthAreaSqm: A, depthM: D, depthSource },
    excavation: { inSituVolumeM3: round(inSitu), looseVolumeM3: round(loose), days: excDays, jcbs, ratePerJcbDay: round(perJcb, 0) },
    phases,
    totals,
    warnings,
    assumptions,
    learning: learning ? {
      observations: learning.observations,
      siteFactor: learning.siteFactor,
      rate: learned || null,
      scheduleFactor: learning.scheduleFactor,
      scheduleObservations: learning.scheduleObservations,
    } : null,
    confidence: Math.max(10, confidence),
    confidenceBasis: [
      `${facts.completeness.found} of ${facts.completeness.of} key soil facts found in the report.`,
      learned?.observations ? `JCB rate ${Math.round(learnedShare * 100)}% learned from site actuals.` : 'JCB rate is the default (no site actuals for this soil yet).',
      ...(partial ? ['Part of the foundation could not be estimated.'] : []),
    ],
  };
}

export function headline(est) {
  const t = est.totals;
  return `${est.soil.label}, ${est.foundation.label.toLowerCase()}: ${plural(t.peakJcbs, 'JCB')} for ${plural(est.excavation.days, 'day')} of excavation, ${t.partial ? 'at least ' : ''}${t.calendarDays} calendar days to plinth, peak ${t.peakWorkers} workers.`;
}

// ---------------------------------------------------------------------------
// 5. Narration (the model explains; it does not calculate)
// ---------------------------------------------------------------------------

const narrationSchema = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING, description: 'Two or three sentences: the soil, the foundation and what it means for the plinth.' },
    warnings: { type: Type.ARRAY, items: { type: Type.STRING } },
    recommendations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { action: { type: Type.STRING }, rationale: { type: Type.STRING } },
        required: ['action', 'rationale'],
      },
    },
  },
  required: ['summary', 'recommendations'],
};

const NARRATION_SYSTEM = `You explain a plinth estimate (excavation to plinth beam and backfill) to a site manager on an Indian
building site. The JSON contains soil facts read from the geotechnical report and figures ALREADY calculated by a rules engine.
Use only the numbers in the JSON; never calculate, change or add a number, machine count, worker count or date.
If a phase has insufficientData, say what is missing and who should provide it. Short, concrete sentences, no emoji.`;

async function narrate(est, facts, projectName) {
  if (!aiConfig().configured) return { data: null, error: 'GEMINI_API_KEY not configured: calculated figures only.' };
  try {
    const res = await askGemini({
      system: NARRATION_SYSTEM,
      payload: {
        project: projectName,
        report: { title: facts.reportTitle, layers: facts.layers.map(({ sourceText, ...l }) => l), groundwater: facts.groundwaterDepthM ?? facts.groundwaterNote, bearingCapacityKnM2: est.soil.sbcKnM2 },
        soil: { class: est.soil.label, dewatering: est.soil.dewatering, reasons: est.soil.reasons },
        foundation: est.foundation,
        inputs: est.inputs,
        phases: est.phases.map((p) => ({ name: p.name, insufficientData: !!p.insufficientData, reason: p.reason, quantity: p.quantity, days: p.days, workers: p.workerTotal, machines: p.machines, vehicles: p.vehicles })),
        totals: est.totals,
        warnings: est.warnings.map((w) => w.text),
        assumptions: est.assumptions,
      },
      schema: narrationSchema,
    });
    return { data: res.data, model: res.model, usage: res.usage, latencyMs: res.latencyMs };
  } catch (error) {
    return { data: null, error: error.message };
  }
}

// ---------------------------------------------------------------------------
// 6. Orchestration and persistence
// ---------------------------------------------------------------------------

const addUsage = (a = {}, b = {}) => ({
  promptTokens: (a.promptTokens || 0) + (b.promptTokens || 0),
  responseTokens: (a.responseTokens || 0) + (b.responseTokens || 0),
  totalTokens: (a.totalTokens || 0) + (b.totalTokens || 0),
});

/**
 * Run the geotech agent once. `file` is { originalName, filename, url, mimetype, size, base64 }
 * for an upload; omit it and pass source 'sample' for the built-in profile.
 */
export async function runGeotechAgent({ projectId, user, file, source = 'upload', plinthAreaSqm, depthM }) {
  const project = await Project.findById(projectId, 'name code').lean();
  if (!project) {
    const err = new Error('Project not found');
    err.status = 404;
    throw err;
  }
  const rules = await getRules();
  const g = rules.ai.geotech;

  const read = source === 'sample'
    ? { status: 'Sample', facts: SAMPLE_FACTS }
    : await extractFacts({ fileBase64: file.base64, mimeType: file.mimetype, originalName: file.originalName });

  const report = new GeotechReport({
    project: projectId, uploadedBy: user?._id, source,
    file: file ? { originalName: file.originalName, filename: file.filename, url: file.url, mimetype: file.mimetype, size: file.size } : undefined,
    extraction: { status: read.status, reason: read.reason, model: read.model, facts: read.facts || null },
    inputs: { plinthAreaSqm, depthM: depthM ?? null },
  });

  let usage = read.usage || {};
  let latencyMs = read.latencyMs || 0;
  let model = read.model || null;

  if (!read.facts) {
    const run = await AiRun.create({
      project: projectId, agent: 'geotech', trigger: 'manual', user: user?._id,
      question: `Plinth estimate from ${file?.originalName || 'report'}`,
      context: { inputs: report.inputs, extraction: read.status }, output: { headline: 'Report not read', aiGenerated: false },
      model, usage, latencyMs, status: 'Failed', errorMessage: read.reason,
    });
    report.run = run._id;
    await report.save();
    return report;
  }

  const facts = read.facts;
  let depthUsed = depthM;
  let depthSource = 'user';
  if (depthUsed == null) {
    depthUsed = facts.recommendedDepthM ?? facts.bearingCapacity?.depthM ?? null;
    depthSource = depthUsed != null ? 'report' : 'default';
    if (depthUsed == null) depthUsed = g.defaultDepthM;
  }
  report.inputs.depthUsedM = depthUsed;
  report.inputs.depthSource = depthSource;

  const learning = await calibrate(rules);
  const estimate = calculateEstimate({ facts, plinthAreaSqm, depthM: depthUsed, depthSource, rules, learning });
  const head = headline(estimate);
  report.estimate = estimate;

  const narr = await narrate(estimate, facts, project.name);
  usage = addUsage(usage, narr.usage);
  latencyMs += narr.latencyMs || 0;
  model = narr.model || model;
  report.narration = narr.data ? { ...narr.data, aiGenerated: true } : null;

  const readOk = read.status === 'Read' || read.status === 'Sample';
  const status = readOk && narr.data ? 'Success' : 'Degraded';
  const run = await AiRun.create({
    project: projectId, agent: 'geotech', trigger: 'manual', user: user?._id,
    question: `Plinth estimate: ${plinthAreaSqm} m² at ${depthUsed} m (${source === 'sample' ? 'sample profile' : file.originalName})`,
    context: { facts, inputs: report.inputs, rules: g, learning },
    output: { headline: head, aiGenerated: !!narr.data, ...(narr.data || {}) },
    model, usage, latencyMs, status, errorMessage: narr.error || null,
  });

  // The prediction carries calculated values only; the narration is attached as explanation.
  const t = estimate.totals;
  const prediction = await AiPrediction.create({
    project: projectId, agent: 'geotech', kind: 'plinthEstimate', run: run._id,
    label: `Plinth estimate · ${plinthAreaSqm} m² · ${estimate.soil.label} · ${estimate.foundation.label}`,
    value: {
      calendarDays: t.calendarDays,
      excavationDays: estimate.excavation.days,
      peakJcbs: t.peakJcbs,
      tippers: t.tippers,
      peakWorkers: t.peakWorkers,
      soilClass: estimate.soil.label,
      foundation: estimate.foundation.label,
      partial: t.partial,
    },
    unit: 'days',
    confidence: estimate.confidence,
    basis: [
      ...estimate.soil.reasons,
      estimate.foundation.reason,
      ...estimate.phases.map((p) => (p.insufficientData ? `${p.name}: ${p.reason}` : `${p.name}: ${plural(p.days, 'day')}, ${p.workerTotal} workers.`)),
      ...estimate.confidenceBasis,
    ],
    narration: narr.data?.summary || head,
  });
  report.run = run._id;
  report.prediction = prediction._id;
  await report.save();
  return report;
}

export async function learningSummary() {
  return calibrate(await getRules());
}

// ---------------------------------------------------------------------------
// 7. Copilot answer (read from the stored estimate, no new model call)
// ---------------------------------------------------------------------------

export async function geotechCopilotAnswer(projectId) {
  const report = await GeotechReport.findOne({
    project: projectId, estimate: { $ne: null }, 'verification.status': { $ne: 'Rejected' },
  }).sort({ createdAt: -1 }).lean();
  if (!report) {
    return {
      answer: 'There is no plinth estimate for this project yet. Upload the geotechnical report on the Plinth Estimate page to get the JCBs, days and crew.',
      sources: [],
    };
  }
  const e = report.estimate;
  const t = e.totals;
  const state = report.verification?.status === 'Pending' ? 'proposed, not yet accepted' : report.verification?.status?.toLowerCase();
  const phases = e.phases.map((p) => (p.insufficientData
    ? `${p.name}: not estimated (${p.reason})`
    : `${p.name}: ${plural(p.days, 'day')}, ${p.workerTotal} workers${p.machines.length ? `, ${p.machines.map((m) => `${m.count} ${m.name}`).join(', ')}` : ''}`));
  return {
    answer: `${headline(e)} This is the latest plinth estimate (${fmt(report.createdAt)}, ${state}) for ${e.inputs.plinthAreaSqm} m² excavated to ${e.inputs.depthM} m. ${phases.join('. ')}.`,
    sources: [
      report.extraction?.facts?.reportTitle || report.file?.originalName || 'Sample soil profile',
      `Plinth estimate ${fmt(report.createdAt)}`,
    ],
  };
}
