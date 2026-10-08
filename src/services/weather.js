// Rain buffer for the plinth schedule.
//
//   uploaded weather report (Gemini reads it) + Open-Meteo forecast -> known rain per day
//   monthly rainy-day normals                                       -> expected rain after that
//   -> rules (rules.ai.geotech.weather) decide what each phase loses -> dated schedule with buffer
//
// The model only reads the uploaded report into daily rain figures. Which days are lost, the
// dry-out days and the buffer are all calculated here from the rules, and each one says why.

import { Project } from '../models/index.js';
import { askGemini, aiConfig } from './ai/gemini.js';
import { pdfText } from './ai/geotech.js';
import { getRules } from './settings.js';
import { addDays, fmt, toDay, today } from '../utils/dates.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const iso = (d) => toDay(d).toISOString().slice(0, 10);
const daysInMonth = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
const round1 = (n) => Math.round(n * 10) / 10;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// ---------------------------------------------------------------------------
// Where the site is
// ---------------------------------------------------------------------------

const geocodeCache = new Map();

/** Project location ("Pune, Maharashtra") -> coordinates; falls back to the site in the rules. */
export async function siteLocation(location, rules) {
  const fallback = { ...rules.ai.geotech.weather.site, source: 'rules' };
  const name = String(location || '').split(',')[0].trim();
  if (!name) return fallback;
  if (geocodeCache.has(name)) return geocodeCache.get(name);
  try {
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&countryCode=IN`, { signal: AbortSignal.timeout(8000) });
    const hit = res.ok ? (await res.json()).results?.[0] : null;
    const loc = hit ? { name: [hit.name, hit.admin1].filter(Boolean).join(', '), latitude: hit.latitude, longitude: hit.longitude, source: 'project' } : fallback;
    geocodeCache.set(name, loc);
    return loc;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Known weather: forecast and uploaded report
// ---------------------------------------------------------------------------

/** Daily rain for the next 16 days. Never throws: a failed fetch returns { days: [], error }. */
export async function fetchForecast(loc) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}`
    + '&daily=precipitation_sum,precipitation_probability_max&forecast_days=16&timezone=Asia%2FKolkata';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { days: [], error: `Forecast service answered ${res.status}` };
    const { daily } = await res.json();
    const days = (daily?.time || []).map((date, i) => ({
      date, rainMm: num(daily.precipitation_sum?.[i]) ?? 0, probability: num(daily.precipitation_probability_max?.[i]), source: 'forecast',
    }));
    return { days, fetchedAt: new Date() };
  } catch (error) {
    return { days: [], error: `Forecast could not be fetched (${error.name === 'TimeoutError' ? 'timed out' : error.message})` };
  }
}

const WEATHER_SYSTEM = `You are reading a weather forecast or weather report for a construction site in India.
Extract only what is printed. For every dated day in the document give the expected rain.
- date: YYYY-MM-DD. If the year is not printed, use the year that puts the date nearest to "today" in the request.
- rainMm: rainfall in millimetres if a number is printed, else null.
- condition: "heavy" | "moderate" | "light" | "none" from the wording or symbols (thunderstorm, heavy rain = heavy;
  rain, showers = moderate; drizzle, light rain = light; dry, sunny, clear, cloudy without rain = none), or null.
- probability: chance of rain in percent if printed, else null.
Never invent days that are not in the document. If it is not a weather document, set isWeatherReport to false.

Return one JSON object:
{ "isWeatherReport": true, "title": "string or null", "location": "string or null", "issuedOn": "YYYY-MM-DD or null",
  "days": [{ "date": "YYYY-MM-DD", "rainMm": number or null, "condition": "heavy" | "moderate" | "light" | "none" | null, "probability": number or null }] }`;

// Wording without a number is turned into a representative amount (IMD categories).
const CONDITION_MM = { heavy: 30, moderate: 15, light: 4, none: 0 };

/** Read an uploaded weather report into daily rain. Returns { status: 'Read', days } or { status: 'Not read', reason }. */
export async function readWeatherReport({ fileBase64, mimeType, originalName }) {
  if (!aiConfig().configured) return { status: 'Not read', reason: 'GEMINI_API_KEY is not configured, so the weather report cannot be read.' };
  const text = mimeType === 'application/pdf' ? await pdfText(fileBase64) : null;
  try {
    const res = await askGemini({
      system: WEATHER_SYSTEM,
      payload: { task: 'Extract the daily rain from the attached weather report', today: iso(today()), fileName: originalName || null },
      schema: null,
      file: text ? { mimeType: 'text/plain', data: text.base64 } : { mimeType, data: fileBase64 },
      retry: { attempts: 3, timeoutMs: 90_000, backoffMs: 3000 },
    });
    const raw = res.data || {};
    const seen = new Set();
    const days = (Array.isArray(raw.days) ? raw.days : [])
      .map((d) => {
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(d?.date)) && !Number.isNaN(new Date(d.date).getTime()) ? d.date : null;
        const mm = num(d?.rainMm);
        const rainMm = mm !== null && mm >= 0 && mm < 1000 ? round1(mm) : CONDITION_MM[d?.condition] ?? null;
        const p = num(d?.probability);
        return date && rainMm !== null ? { date, rainMm, probability: p !== null && p >= 0 && p <= 100 ? p : null, source: 'upload', fromWording: mm === null } : null;
      })
      .filter((d) => d && !seen.has(d.date) && seen.add(d.date))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (raw.isWeatherReport === false || !days.length) {
      return { status: 'Not read', reason: 'No dated rain forecast was found in the file.', model: res.model };
    }
    return { status: 'Read', days, title: raw.title || null, location: raw.location || null, issuedOn: raw.issuedOn || null, model: res.model };
  } catch (error) {
    const reason = {
      503: 'Google’s AI service is busy right now. Try the upload again in a few minutes.',
      429: 'The AI quota is used up. Try again later.',
      timeout: 'The AI took too long to read the weather report.',
    }[error.providerStatus];
    return { status: 'Not read', reason: reason || `The weather report could not be read: ${error.message}` };
  }
}

// ---------------------------------------------------------------------------
// Schedule with the rain buffer (pure)
// ---------------------------------------------------------------------------

const PHASE_WORDS = {
  excavation: { stop: 'no digging', work: 'digging' },
  pcc: { stop: 'no PCC pour', work: 'PCC' },
  foundation: { stop: 'concreting held', work: 'steel and shuttering' },
  plinthBeam: { stop: 'concreting held', work: 'steel and shuttering' },
  backfill: { stop: 'no backfilling', work: 'backfilling' },
};
const words = (key) => PHASE_WORDS[key] || { stop: 'work stopped', work: 'work' };

/**
 * Lay the phases out day by day from `startDate`. On a known day, heavy rain stops (or slows) the
 * phase by its rule and is followed by dry-out days; light rain slows it. Days past the known
 * weather do not get a date-specific loss: their expected loss from the monthly normals is added
 * as buffer days at the end of the phase.
 */
export function planWeather({ estimate, startDate, known = [], rules }) {
  const w = rules.ai.geotech.weather;
  const start = toDay(startDate);
  const byDate = new Map(known.map((d) => [d.date, d]));
  const wetGround = !!estimate.soil?.dewatering || estimate.soil?.class === 'soft';
  const schedule = [];
  const phases = [];
  let date = start;
  let carry = 0; // expected rain loss not yet turned into a whole buffer day

  for (const p of estimate.phases) {
    if (p.insufficientData) continue;
    const s = w.phases?.[p.key] || { heavy: 0, light: 0, recoveryDays: 0 };
    const recovery = (s.recoveryDays || 0) + (p.key === 'excavation' && wetGround && s.recoveryDays ? w.wetGroundExtraRecoveryDays || 0 : 0);
    const counts = { work: 0, light: 0, rain: 0, recovery: 0, buffer: 0 };
    const expectedByMonth = {};
    let left = p.days;
    let pendingRecovery = 0;
    let expected = 0;
    let guard = 0;

    while (left > 1e-9 && guard++ < 2000) {
      const k = byDate.get(iso(date));
      let kind = 'work';
      let progress = 1;
      let note = null;
      if (k) {
        const heavy = k.rainMm >= w.heavyRainMm;
        const light = !heavy && k.rainMm >= w.lightRainMm;
        if (heavy && s.heavy > 0) {
          progress = 1 - s.heavy;
          kind = progress <= 0 ? 'rain' : 'light';
          note = `Heavy rain (${k.rainMm} mm): ${progress <= 0 ? words(p.key).stop : `${words(p.key).work} only, about ${Math.round(progress * 100)}% output`}.`;
          pendingRecovery = recovery;
        } else if (pendingRecovery > 0) {
          progress = 0;
          kind = 'recovery';
          pendingRecovery -= 1;
          note = p.key === 'excavation'
            ? `Dry-out after rain: pump out standing water and remove slush${wetGround ? ' (wet ground: water table or soft soil)' : ''}.`
            : 'Dry-out after rain: the ground is too wet to work.';
        } else if (light && s.light > 0) {
          progress = 1 - s.light;
          kind = progress <= 0 ? 'rain' : 'light';
          note = `Light rain (${k.rainMm} mm): ${progress <= 0 ? words(p.key).stop : `about ${Math.round(progress * 100)}% output`}.`;
        }
      } else {
        // Past the known weather: expected loss from the month's normal number of rainy days.
        const m = date.getUTCMonth();
        const pRain = Math.min(1, (w.rainyDaysByMonth?.[m] ?? 0) / daysInMonth(date));
        const h = w.heavyShareOfRainyDays ?? 0.4;
        const loss = Math.min(0.9, pRain * (h * (s.heavy + recovery) + (1 - h) * s.light));
        expected += loss;
        if (loss > 0) expectedByMonth[m] = (expectedByMonth[m] || 0) + loss;
        pendingRecovery = 0;
      }
      left -= Math.max(0, progress);
      counts[kind] += 1;
      schedule.push({ date, phaseKey: p.key, phaseName: p.name, kind, rainMm: k?.rainMm ?? null, probability: k?.probability ?? null, source: k?.source || 'normal', note });
      date = addDays(date, 1);
    }

    carry += expected;
    const buffer = Math.floor(carry + 0.5);
    carry -= buffer;
    const wettest = Object.entries(expectedByMonth).sort((a, b) => b[1] - a[1])[0];
    for (let i = 0; i < buffer; i++) {
      counts.buffer += 1;
      schedule.push({
        date, phaseKey: p.key, phaseName: p.name, kind: 'buffer', rainMm: null, probability: null, source: 'normal',
        note: `Weather buffer for rain expected in ${wettest ? MONTHS[wettest[0]] : 'this period'} (monthly average). If the day stays dry, use it to catch up.`,
      });
      date = addDays(date, 1);
    }
    const days = schedule.filter((x) => x.phaseKey === p.key).length;
    phases.push({
      key: p.key, name: p.name, dryDays: p.days, days, extraDays: days - p.days,
      rainDays: counts.rain, lightDays: counts.light, recoveryDays: counts.recovery, bufferDays: counts.buffer,
      expectedLoss: round1(expected),
    });
  }

  const dryDays = phases.reduce((n, p) => n + p.dryDays, 0);
  const totalDays = schedule.length;
  const end = totalDays ? schedule[totalDays - 1].date : start;
  const knownInRange = schedule.filter((x) => x.source !== 'normal');
  const sources = [...new Set(knownInRange.map((x) => x.source))];

  // Months the job runs through and how wet they normally are.
  const months = [];
  for (const x of schedule) {
    const m = x.date.getUTCMonth();
    if (!months.includes(m)) months.push(m);
  }
  const warnings = [];
  const monsoon = months.filter((m) => m >= 5 && m <= 8);
  if (monsoon.length) {
    warnings.push({
      level: 'warning',
      text: `Work runs into the monsoon (${monsoon.map((m) => MONTHS[m]).join(', ')}): about ${monsoon.map((m) => `${Math.round(w.rainyDaysByMonth[m])} rainy days in ${MONTHS[m]}`).join(', ')}. Plan covers for the pit and stock dewatering pumps${totalDays - dryDays > 0 ? `, or start after the monsoon` : ''}.`,
    });
  }
  const exc = phases.find((p) => p.key === 'excavation');
  if (exc && (exc.rainDays || exc.recoveryDays)) {
    warnings.push({ level: 'attention', text: `Rain in the forecast hits the excavation: ${plural(exc.rainDays, 'rain day')} and ${plural(exc.recoveryDays, 'dry-out day')}.` });
  }

  const basis = [
    `Start ${fmt(start)}. Without rain the phases take ${plural(dryDays, 'working day')}; with the rain buffer ${plural(totalDays, 'day')} (+${totalDays - dryDays}), ending ${fmt(end)}.`,
    knownInRange.length
      ? `Day-by-day rain for ${fmt(knownInRange[0].date)}–${fmt(knownInRange[knownInRange.length - 1].date)} from ${sources.map((s) => (s === 'upload' ? 'the uploaded weather report' : 'the Open-Meteo forecast')).join(' and ')}. Heavy rain is ${w.heavyRainMm} mm or more, light rain ${w.lightRainMm} mm or more.`
      : 'No day-by-day weather covers these dates (forecast reaches about 16 days ahead), so only monthly averages are used.',
    `After that: monthly averages of ${months.map((m) => `${w.rainyDaysByMonth[m]} rainy days in ${MONTHS[m]}`).join(', ')}, turned into buffer days at the end of each phase.`,
    ...phases.filter((p) => p.extraDays > 0).map((p) => `${p.name}: ${p.dryDays} → ${p.days} days (${[
      p.rainDays && plural(p.rainDays, 'rain day'), p.lightDays && plural(p.lightDays, 'slow wet day'),
      p.recoveryDays && plural(p.recoveryDays, 'dry-out day'), p.bufferDays && plural(p.bufferDays, 'buffer day'),
    ].filter(Boolean).join(', ')}).`),
  ];

  return { start, end, dryDays, totalDays, extraDays: totalDays - dryDays, phases, schedule, warnings, basis };
}

// ---------------------------------------------------------------------------
// For a geotech report
// ---------------------------------------------------------------------------

/** Weather buffer for a report's estimate from `startDate`, using its uploaded weather report and the live forecast. */
export async function weatherFor(report, { startDate } = {}) {
  if (!report.estimate) return null;
  const rules = await getRules();
  const project = await Project.findById(report.project, 'location').lean();
  const location = await siteLocation(project?.location, rules);
  const forecast = await fetchForecast(location);
  const upload = report.weatherUpload?.status === 'Read' ? report.weatherUpload.days || [] : [];
  // An uploaded report wins over the forecast on the days it covers.
  const known = [...new Map([...forecast.days, ...upload].map((d) => [d.date, d])).values()];
  const plan = planWeather({ estimate: report.estimate, startDate: startDate || today(), known, rules });
  return {
    ...plan,
    location,
    forecast: { fetchedAt: forecast.fetchedAt || null, error: forecast.error || null, from: forecast.days[0]?.date || null, to: forecast.days.at(-1)?.date || null },
    known: known.sort((a, b) => a.date.localeCompare(b.date)),
    computedAt: new Date(),
  };
}
