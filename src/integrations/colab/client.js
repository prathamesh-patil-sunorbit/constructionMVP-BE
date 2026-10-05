// Colab connector. Uses the live API when COLAB_API_URL is set, otherwise the mock feed.
import * as mock from './mock.js';

// Assumed REST endpoints; confirm with the Colab API documentation and adjust here.
const ENDPOINTS = {
  teams: (code) => `/projects/${encodeURIComponent(code)}/teams`,
  planning: (code) => `/projects/${encodeURIComponent(code)}/schedule`,
  estimation: (code) => `/projects/${encodeURIComponent(code)}/estimates`,
  execution: (code) => `/projects/${encodeURIComponent(code)}/daily-reports`,
};

export function colabStatus() {
  return {
    source: 'colab',
    mode: process.env.COLAB_API_URL ? 'live' : 'mock',
    baseUrl: process.env.COLAB_API_URL || null,
  };
}

async function fetchLive(type, projectCode) {
  const url = `${process.env.COLAB_API_URL.replace(/\/$/, '')}${ENDPOINTS[type](projectCode)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.COLAB_API_KEY || ''}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Colab ${type} request failed: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function fetchColab(type, projectCode) {
  if (!ENDPOINTS[type]) throw new Error(`Unknown Colab data type: ${type}`);
  if (process.env.COLAB_API_URL) return fetchLive(type, projectCode);
  return mock[type](projectCode);
}
