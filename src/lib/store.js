import { dayKey } from './time.js';

const DAY_PREFIX = 'day:';

export const DEFAULT_SETTINGS = {
  idleSeconds: 60,
  warnAtPercent: 80,
  notify: true,
  keepDays: 120,
  diagnostics: true,        // focus-event ring buffer; see diag() in background.js
  accurate: false,          // read focus/playback from the page (needs page access)
  mediaCountsAsPresent: true,  // playing media means you are here, input or not
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function patchSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function getLimits() {
  const { limits } = await chrome.storage.local.get('limits');
  return limits || {};
}

export async function setLimit(domain, minutes) {
  const limits = await getLimits();
  if (!minutes || minutes <= 0) delete limits[domain];
  else limits[domain] = Math.round(minutes);
  await chrome.storage.local.set({ limits });
  return limits;
}

// Domains that only accrue time while the tab is actually producing sound.
// Kept separate from `limits`: a site can be playback-gated without a limit,
// and limited without being playback-gated.
export async function getPlaybackOnly() {
  const { playbackOnly } = await chrome.storage.local.get('playbackOnly');
  return playbackOnly || {};
}

export async function setPlaybackOnly(domain, on) {
  const map = await getPlaybackOnly();
  if (on) map[domain] = true;
  else delete map[domain];
  await chrome.storage.local.set({ playbackOnly: map });
  return map;
}

export function emptyDay(key) {
  return { date: key, totals: {}, hours: {}, sessions: [], blocked: {}, warned: {} };
}

export async function getDay(key = dayKey()) {
  const slot = DAY_PREFIX + key;
  const got = await chrome.storage.local.get(slot);
  return got[slot] || emptyDay(key);
}

export async function putDay(rec) {
  await chrome.storage.local.set({ [DAY_PREFIX + rec.date]: rec });
}

export async function listDayKeys() {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all)
    .filter((k) => k.startsWith(DAY_PREFIX))
    .map((k) => k.slice(DAY_PREFIX.length))
    .sort();
}

export async function getDays(keys) {
  const slots = keys.map((k) => DAY_PREFIX + k);
  const got = await chrome.storage.local.get(slots);
  return keys.map((k) => got[DAY_PREFIX + k] || emptyDay(k));
}

// Drops day records older than settings.keepDays so storage stays bounded.
export async function pruneDays() {
  const { keepDays } = await getSettings();
  const keys = await listDayKeys();
  if (keys.length <= keepDays) return 0;
  const doomed = keys.slice(0, keys.length - keepDays);
  await chrome.storage.local.remove(doomed.map((k) => DAY_PREFIX + k));
  return doomed.length;
}
