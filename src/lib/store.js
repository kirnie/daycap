import { dayKey } from './time.js';
import { slimDay, cutoffKey } from './accrual.js';

const DAY_PREFIX = 'day:';
const SCHEMA = 2;   // 2: day records slimmed to totals + per-hour totals

export const DEFAULT_SETTINGS = {
  idleSeconds: 60,
  warnAtPercent: 80,
  notify: true,
  keepDays: 30,
  diagnostics: false,       // focus-event ring buffer; see diag() in background.js
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
  dropConfig();
  return next;
}

// Settings, limits and playback gates in one storage read -- what a tick needs.
//
// Only the service worker writes these keys (the pages go through messages),
// so the worker keeps the last read in memory and re-reads only after a write.
// Every writer below drops the cache, and so does any change seen through
// storage.onChanged, which covers an edit made from DevTools. The cache is tied
// to the storage area it came from, and dies with the worker; a cold worker
// simply reads again. Callers must treat the result as read-only.
const CONFIG_KEYS = ['settings', 'limits', 'playbackOnly'];
let config = null;      // { area, value }
let generation = 0;     // bumped by every write, so a read that raced one is not kept
let watching = false;

function dropConfig() { config = null; generation += 1; }

export async function getConfig() {
  const area = chrome.storage.local;
  if (config && config.area === area) return config.value;

  if (!watching && chrome.storage.onChanged) {
    watching = true;
    chrome.storage.onChanged.addListener((changes, name) => {
      if (name === 'local' && CONFIG_KEYS.some((k) => k in changes)) dropConfig();
    });
  }
  const gen = generation;
  const got = await area.get(CONFIG_KEYS);
  const value = {
    settings: { ...DEFAULT_SETTINGS, ...(got.settings || {}) },
    limits: got.limits || {},
    playbackOnly: got.playbackOnly || {},
  };
  if (gen === generation) config = { area, value };
  return value;
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
  dropConfig();
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
  dropConfig();
  return map;
}

export function emptyDay(key) {
  return { date: key, totals: {}, hours: {}, blocked: {}, warned: {} };
}

// Records are passed through slimDay on the way out, so no reader ever sees
// the pre-schema-2 shape even if migrate() has not run yet.
export async function getDay(key = dayKey()) {
  const slot = DAY_PREFIX + key;
  const got = await chrome.storage.local.get(slot);
  return got[slot] ? slimDay(got[slot]) : emptyDay(key);
}

export async function putDay(rec) {
  await chrome.storage.local.set({ [DAY_PREFIX + rec.date]: rec });
}

export async function listDayKeys() {
  const names = chrome.storage.local.getKeys
    ? await chrome.storage.local.getKeys()
    : Object.keys(await chrome.storage.local.get(null));
  return names
    .filter((k) => k.startsWith(DAY_PREFIX))
    .map((k) => k.slice(DAY_PREFIX.length))
    .sort();
}

export async function getDays(keys) {
  const slots = keys.map((k) => DAY_PREFIX + k);
  const got = await chrome.storage.local.get(slots);
  return keys.map((k) => (got[DAY_PREFIX + k] ? slimDay(got[DAY_PREFIX + k]) : emptyDay(k)));
}

// Drops day records older than settings.keepDays calendar days.
export async function pruneDays(now = Date.now()) {
  const { keepDays } = await getSettings();
  const cutoff = cutoffKey(keepDays, now);
  const doomed = (await listDayKeys()).filter((k) => k < cutoff);
  if (doomed.length) await chrome.storage.local.remove(doomed.map((k) => DAY_PREFIX + k));
  return doomed.length;
}

// One-time upgrade of data written by older versions: rewrites every day
// record in the slim shape (dropping the session timeline and per-site hours),
// switches diagnostics off and deletes its log.
export async function migrate() {
  const { schema = 1 } = await chrome.storage.local.get('schema');
  if (schema >= SCHEMA) return false;

  const all = await chrome.storage.local.get(null);
  const patch = { schema: SCHEMA };
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(DAY_PREFIX)) patch[key] = slimDay(value);
  }
  if (all.settings) patch.settings = { ...all.settings, diagnostics: false };

  await chrome.storage.local.set(patch);
  await chrome.storage.local.remove('diag');
  dropConfig();
  return true;
}
