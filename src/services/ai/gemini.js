// Gemini access. The API key lives in the backend process only: no route, response or log
// ever returns it, so the browser never sees it.
//
// The model is used for language, not arithmetic: callers pass already-computed numbers and ask
// for explanation. See analytics.js for the deterministic side.

import { GoogleGenAI } from '@google/genai';

const DEFAULT_MODEL = 'gemini-3.8-flash';
const TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

let client = null;

export function aiConfig() {
  const key = process.env.GEMINI_API_KEY?.trim();
  return {
    configured: Boolean(key),
    model: process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL,
    rateLimitPerMin: Number(process.env.AI_RATE_LIMIT_PER_MIN) || 10,
  };
}

function getClient() {
  const { configured } = aiConfig();
  if (!configured) return null;
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY.trim() });
  return client;
}

// Per-user sliding window, so one account cannot exhaust the project's quota.
const calls = new Map();
export function checkRateLimit(userId) {
  const { rateLimitPerMin } = aiConfig();
  const now = Date.now();
  const recent = (calls.get(String(userId)) || []).filter((t) => now - t < 60_000);
  if (recent.length >= rateLimitPerMin) {
    const retryInSec = Math.ceil((60_000 - (now - recent[0])) / 1000);
    return { ok: false, retryInSec };
  }
  recent.push(now);
  calls.set(String(userId), recent);
  return { ok: true };
}

// 429 (quota / rate limit) is deliberately not retried: every retry is another request that
// counts against the same quota, so retrying only uses it up faster.
const RETRYABLE = [500, 502, 503, 504];

// Once the provider says the quota is exhausted, stop calling it until the reset time it gives,
// so background jobs and repeated clicks fail instantly instead of burning requests.
let quotaBlockedUntil = 0;
const QUOTA_FALLBACK_MS = 60_000;

function retryDelayMs(error) {
  const text = String(error?.message || '');
  const secs = text.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/) || text.match(/retry in (\d+(?:\.\d+)?)s/i);
  if (secs) return Number(secs[1]) * 1000;
  const hms = text.match(/retry in (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
  if (hms) return ((Number(hms[1]) || 0) * 3600 + (Number(hms[2]) || 0) * 60 + Number(hms[3])) * 1000;
  return QUOTA_FALLBACK_MS;
}

export function quotaStatus() {
  const ms = quotaBlockedUntil - Date.now();
  return ms > 0 ? { blocked: true, retryAt: new Date(quotaBlockedUntil), retryInSec: Math.ceil(ms / 1000) } : { blocked: false };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function statusOf(error) {
  return error?.status ?? error?.code ?? error?.response?.status ?? null;
}

/**
 * Ask Gemini for structured JSON.
 *
 * @param {object} args
 * @param {string} args.system     Role and guardrails for the agent.
 * @param {object} args.payload    Deterministic findings. The model may only reuse these numbers.
 * @param {object} args.schema     Gemini responseSchema describing the expected JSON.
 * @param {object} [args.file]     Attachment { mimeType, data (base64) }: a photo or a PDF document.
 * @param {object} [args.image]    Older name for args.file.
 * @param {object} [args.retry]    { attempts, timeoutMs, backoffMs } for slow calls such as reading a PDF.
 * @param {number} [args.temperature] Sampling temperature for older models (default 0.2). Gemini 3 models
 *                                 ignore it and use their default, see below.
 * @returns {Promise<{data: object, model: string, usage: object, latencyMs: number}>}
 */
export async function askGemini({ system, payload, schema, image, file, retry = {}, temperature = 0.2 }) {
  const attachment = file || image;
  const attempts = retry.attempts || MAX_ATTEMPTS;
  const timeoutMs = retry.timeoutMs || TIMEOUT_MS;
  const backoffMs = retry.backoffMs || 500;
  const quota = quotaStatus();
  if (quota.blocked) {
    const err = new Error(`Gemini quota is used up; calls are paused until ${quota.retryAt.toISOString()}`);
    err.code = 'AI_UNAVAILABLE';
    err.providerStatus = 429;
    err.retryAt = quota.retryAt;
    throw err;
  }
  const ai = getClient();
  if (!ai) {
    const err = new Error('GEMINI_API_KEY is not configured on the server');
    err.code = 'AI_NOT_CONFIGURED';
    throw err;
  }
  const { model } = aiConfig();
  const startedAt = Date.now();
  let lastError;
  let made = 0;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    made = attempt;
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [{
          role: 'user',
          parts: [
            { text: JSON.stringify(payload) },
            ...(attachment?.data ? [{ inlineData: { mimeType: attachment.mimeType || 'image/jpeg', data: attachment.data } }] : []),
          ],
        }],
        config: {
          systemInstruction: system,
          responseMimeType: 'application/json',
          // Some calls describe the JSON shape in the prompt instead (see geotech.js) and pass no schema.
          ...(schema ? { responseSchema: schema } : {}),
          // Gemini 3 models are tuned for their default temperature; lower values make them loop
          // (e.g. a depth returned as "0.0000150383838…") and drop most of the answer.
          ...(/^gemini-3/.test(model) ? {} : { temperature }),
          abortSignal: controller.signal,
        },
      });
      const text = response.text;
      if (!text) throw new Error('Empty response from Gemini');
      const meta = response.usageMetadata || {};
      return {
        data: JSON.parse(text),
        model,
        usage: {
          promptTokens: meta.promptTokenCount,
          responseTokens: meta.candidatesTokenCount,
          totalTokens: meta.totalTokenCount,
        },
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      lastError = error;
      if (Number(statusOf(error)) === 429) {
        quotaBlockedUntil = Date.now() + retryDelayMs(error);
        console.warn(`Gemini quota exhausted; pausing AI calls until ${new Date(quotaBlockedUntil).toISOString()}`);
      }
      const retryable = RETRYABLE.includes(Number(statusOf(error))) || error.name === 'AbortError';
      if (!retryable || attempt === attempts) break;
      await sleep(backoffMs * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }
  // Never surface the provider's raw payload: it can echo request details back to the client.
  const err = new Error(`Gemini request failed after ${made} attempt${made === 1 ? '' : 's'}: ${lastError?.message || 'unknown error'}`);
  err.code = 'AI_UNAVAILABLE';
  err.providerStatus = Number(statusOf(lastError)) || (lastError?.name === 'AbortError' ? 'timeout' : null);
  if (err.providerStatus === 429) err.retryAt = new Date(quotaBlockedUntil);
  throw err;
}
