// The accounting rules, kept free of chrome.* so they can be tested directly.
//
// A day record holds only what the report shows:
//   totals  { domain: seconds }   -- per-site time for the day
//   hours   { hour: seconds }     -- total active time per local hour, no sites
//   blocked { domain: ms }        -- when a limit was first hit
//   warned  { domain: ms }        -- when the warning was sent
// There is deliberately no per-visit timeline and no per-site hourly breakdown.

import { dayKey, nextHour } from './time.js';

// Splits [start, end) on local hour boundaries, so the hourly chart is exact
// and a span crossing midnight lands in both days.
export function hourSlices(start, end) {
  const out = [];
  let cursor = start;
  while (cursor < end) {
    const slice = Math.min(end, nextHour(cursor));
    out.push([cursor, slice]);
    cursor = slice;
  }
  return out;
}

// Credits one slice (which must not cross an hour boundary) to a day record.
// Returns the seconds credited.
export function creditRecord(rec, domain, start, end) {
  const seconds = (end - start) / 1000;
  if (seconds <= 0) return 0;

  const hour = new Date(start).getHours();
  rec.totals[domain] = (rec.totals[domain] || 0) + seconds;
  rec.hours[hour] = (rec.hours[hour] || 0) + seconds;
  return seconds;
}

// Where crediting must stop: never more than graceMs past the last heartbeat,
// so a closed browser or a suspended machine cannot bank time it never spent.
export function creditEnd(state, asOf, graceMs) {
  return Math.min(asOf, state.heartbeat + graceMs);
}

// Whether a domain is blocked is always derived from the live limit.
export function blockedSet(rec, limits) {
  const out = new Set();
  for (const [domain, minutes] of Object.entries(limits)) {
    if (minutes > 0 && (rec.totals[domain] || 0) >= minutes * 60) out.add(domain);
  }
  return out;
}

// What of today's record survives "delete all history": only the time and
// block stamp of sites that are blocked right now, so wiping history cannot
// lift a block. Returns null when nothing is blocked.
export function keepBlocked(rec, blocked) {
  if (!blocked.size) return null;
  const out = { date: rec.date, totals: {}, hours: {}, blocked: {}, warned: {} };
  for (const domain of blocked) {
    out.totals[domain] = rec.totals[domain] || 0;
    if (rec.blocked[domain]) out.blocked[domain] = rec.blocked[domain];
  }
  return out;
}

// Normalises a stored record to the current shape. Records written before
// schema 2 had hours[domain][hour] and a `sessions` timeline; the former is
// collapsed to per-hour totals and the latter is dropped.
export function slimDay(rec) {
  const hours = {};
  for (const [key, value] of Object.entries(rec.hours || {})) {
    if (value && typeof value === 'object') {
      for (const [h, sec] of Object.entries(value)) hours[h] = (hours[h] || 0) + sec;
    } else {
      hours[key] = (hours[key] || 0) + value;
    }
  }
  return {
    date: rec.date,
    totals: rec.totals || {},
    hours,
    blocked: rec.blocked || {},
    warned: rec.warned || {},
  };
}

// The oldest day key still kept when retaining `keepDays` calendar days
// (today included). Calendar days, not "days that have a record".
export function cutoffKey(keepDays, now = Date.now()) {
  const d = new Date(now);
  return dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (keepDays - 1)).getTime());
}
