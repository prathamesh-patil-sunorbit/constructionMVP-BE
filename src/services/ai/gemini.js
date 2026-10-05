// Gemini access. The API key lives in the backend process only: no route, response or log
// ever returns it, so the browser never sees it.
//
// The model is used for language, not arithmetic: callers pass already-computed numbers and ask
// for explanation. See analytics.js for the deterministic side.

import { GoogleGenAI } from '@google/genai';

const DEFAULT_MODEL = 'gemini-2.5-flash';
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

const RETRYABLE = [429, 500, 502, 503, 504];
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
 * @returns {Promise<{data: object, model: string, usage: object, latencyMs: number}>}
 */
export async function askGemini({ system, payload, schema, image }) {
  const ai = getClient();
  if (!ai) {
    const err = new Error('GEMINI_API_KEY is not configured on the server');
    err.code = 'AI_NOT_CONFIGURED';
    throw err;
  }
  const { model } = aiConfig();
  const startedAt = Date.now();
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [{
          role: 'user',
          parts: [
            { text: JSON.stringify(payload) },
            ...(image?.data ? [{ inlineData: { mimeType: image.mimeType || 'image/jpeg', data: image.data } }] : []),
          ],
        }],
        config: {
          systemInstruction: system,
          responseMimeType: 'application/json',
          responseSchema: schema,
          temperature: 0.2,
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
      const retryable = RETRYABLE.includes(Number(statusOf(error))) || error.name === 'AbortError';
      if (!retryable || attempt === MAX_ATTEMPTS) break;
      await sleep(500 * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }
  // Never surface the provider's raw payload: it can echo request details back to the client.
  const err = new Error(`Gemini request failed after ${MAX_ATTEMPTS} attempts: ${lastError?.message || 'unknown error'}`);
  err.code = 'AI_UNAVAILABLE';
  throw err;
}
