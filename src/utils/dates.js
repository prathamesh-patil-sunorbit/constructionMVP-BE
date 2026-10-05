export const DAY_MS = 24 * 60 * 60 * 1000;

// All schedule dates are stored as UTC midnight so that day arithmetic is timezone-safe.
export function toDay(value) {
  if (!value) return null;
  const d = new Date(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// "Today" is the server's local calendar date, expressed as UTC midnight.
export function today() {
  const n = new Date();
  return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
}

export function addDays(value, days) {
  return new Date(toDay(value).getTime() + days * DAY_MS);
}

export function diffDays(a, b) {
  return Math.round((toDay(a).getTime() - toDay(b).getTime()) / DAY_MS);
}

export function maxDate(...values) {
  const valid = values.filter(Boolean).map(toDay);
  if (!valid.length) return null;
  return new Date(Math.max(...valid.map((d) => d.getTime())));
}

export function sameDay(a, b) {
  return a && b && toDay(a).getTime() === toDay(b).getTime();
}

export function fmt(value) {
  if (!value) return '-';
  return toDay(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
}
