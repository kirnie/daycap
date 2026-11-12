import { registrableDomain } from './lib/domain.js';
import { dayKey, prevDayKey, nextMidnight, fmtDuration, fmtMinutes, sumTotals } from './lib/time.js';
import { hourSlices, creditRecord, creditEnd, blockedSet } from './lib/accrual.js';
import {
  getSettings, patchSettings, getLimits, setLimit,
  getDay, putDay, getDays, listDayKeys, pruneDays, migrate,
  getPlaybackOnly, setPlaybackOnly,
} from './lib/store.js';

// --- tuning ------------------------------------------------------------------

const TICK_MINUTES = 0.5;        // 30s heartbeat; also the resolution of a settle
const GRACE_MS = 150_000;        // never credit more than this past the last heartbeat
const BLUR_GRACE_MS = 1_200;     // see "the Linux blur problem" below
const FOCUS_MEMORY_MS = 60_000;  // how long focus may coast on memory alone

// The Linux blur problem
// ----------------------
// On several Linux window managers the browser reports WINDOW_ID_NONE
// immediately *before* focus moves from one of its own windows to another.
// Handled naively the clock would stop and restart on every alt-tab between
// two Brave windows, shredding sessions and losing seconds all day.
//
// So a blur is not believed straight away: it is recorded as pendingBlurAt and
// only becomes a real pause once BLUR_GRACE_MS has passed with nothing else
// taking focus. If another window claims focus inside that window, the pending
// blur is discarded and the clock slides across without a gap.
//
// The deferred re-check runs on a setTimeout, which a service worker may be
// killed before honouring -- so the 30s tick resolves any stale pending blur
// too. Worst case a pause is recorded late; it is never recorded wrong,
// because the credit is cut at pendingBlurAt, not at the time we notice.

// --- tracking state ----------------------------------------------------------
// Lives in storage.session: the service worker is evicted constantly, and
// in-memory state would not survive it.

// --- diagnostics -------------------------------------------------------------
// Off by default. When Settings -> Diagnostics is on: a bounded ring buffer in
// storage.local, written only when something actually changes -- every focus
// event, and every resolve whose outcome differs from the last one. It holds
// window ids and site names, never URLs. Turning the setting off, or deleting
// history, deletes the log. `diag` is the storage key to read.

const DIAG_MAX = 80;

async function diag(event, detail) {
  try {
    const settings = await getSettings();
    if (!settings.diagnostics) return;
    const { diag: log = [] } = await chrome.storage.local.get('diag');
    log.push({ t: new Date().toISOString().slice(11, 23), event, ...detail });
    while (log.length > DIAG_MAX) log.shift();
    await chrome.storage.local.set({ diag: log });
  } catch { /* diagnostics must never break tracking */ }
}

const BLANK = {
  domain: null, tabId: null, windowId: null,
  since: 0, heartbeat: 0, pendingBlurAt: 0,
  focusedWindowId: null,   // derived from events, not polled -- see focusedWindow()
  lastFlagTrue: 0,         // last time any window actually claimed focus
};


async function loadState() {
  const { track } = await chrome.storage.session.get('track');
  return { ...BLANK, ...(track || {}) };
}

async function saveState(state) {
  await chrome.storage.session.set({ track: state });
}

// --- page probe (accurate mode) ----------------------------------------------

const MEDIA_STALE_MS = 45_000;   // a report older than this counts as "not playing"

async function getMedia() {
  const { media } = await chrome.storage.session.get('media');
  return media || {};
}

async function noteMedia(tabId, playing) {
  const media = await getMedia();
  media[tabId] = { playing, at: Date.now() };
  await chrome.storage.session.set({ media });
}

function mediaPlaying(media, tabId) {
  const m = media[tabId];
  return !!(m && m.playing && Date.now() - m.at < MEDIA_STALE_MS);
}

// Asks a tab's top frame whether it has focus. Returns null when nobody
// answers -- a browser page, or accurate mode not enabled -- which is different
// from an answer of "not focused" and is treated differently by the caller.
async function probeTab(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'tabtime-probe' }, { frameId: 0 });
  } catch {
    return null;
  }
}

// The accurate path: ask each window's active tab directly. document.hasFocus()
// is answered by the renderer, which on this platform knows the truth when the
// browser-process window flag does not.
async function focusedByProbe() {
  let wins = [];
  try {
    wins = await chrome.windows.getAll({ windowTypes: ['normal', 'popup'], populate: true });
  } catch {
    return { win: null, tab: null, answered: 0 };
  }

  let answered = 0;
  for (const win of wins) {
    const tab = (win.tabs || []).find((t) => t.active);
    if (!tab) continue;
    const res = await probeTab(tab.id);
    if (!res) continue;
    answered += 1;
    if (res.hasFocus) return { win, tab, probe: res, answered };
  }
  return { win: null, tab: null, answered };
}

async function registerProbe(on) {
  const ID = 'tabtime-probe';
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [ID] });
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [ID] });
  } catch { /* none registered */ }

  if (!on) return false;

  try {
    await chrome.scripting.registerContentScripts([{
      id: ID,
      js: ['src/content/probe.js'],
      matches: ['*://*/*'],
      allFrames: true,
      runAt: 'document_idle',
      persistAcrossSessions: true,
    }]);
  } catch (err) {
    console.error('[tabtime] could not register probe', err);
    return false;
  }

  // Already-open tabs have no script until they reload, so inject now.
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    await Promise.all(tabs.map((t) => chrome.scripting
      .executeScript({ target: { tabId: t.id, allFrames: true }, files: ['src/content/probe.js'] })
      .catch(() => {})));
  } catch { /* best effort */ }

  return true;
}

// --- accrual -----------------------------------------------------------------

// Credits [start, end) to one domain, split on hour boundaries so the hourly
// chart is exact and a span crossing midnight lands in both days.
async function accrue(domain, start, end) {
  for (const [from, to] of hourSlices(start, end)) {
    await creditSlice(domain, from, to);
  }
}

async function creditSlice(domain, start, end) {
  const rec = await getDay(dayKey(start));
  if (!creditRecord(rec, domain, start, end)) return;

  const effects = await noteThresholds(rec, domain);
  await putDay(rec);

  if (effects.blocked) {
    sweepTabs().catch(() => {});
    refreshBadge().catch(() => {});
  }
  if (effects.notify) notify(effects.notify.title, effects.notify.body);
}

// Records "first blocked at" and "warned at" on the day record, and says what
// side effects the caller owes. Whether a domain *is* blocked is always derived
// from the live limit (see blockedSet) -- this only stamps the first crossing,
// so raising a limit lifts a block immediately.
async function noteThresholds(rec, domain) {
  const limits = await getLimits();
  const limitMin = limits[domain];
  if (!limitMin || limitMin <= 0) return {};

  const settings = await getSettings();
  const usedSec = rec.totals[domain] || 0;
  const limitSec = limitMin * 60;

  if (usedSec >= limitSec) {
    if (rec.blocked[domain]) return { blocked: true };
    rec.blocked[domain] = Date.now();
    return {
      blocked: true,
      notify: settings.notify && {
        title: `${domain} is blocked until midnight`,
        body: `That was your ${fmtMinutes(limitMin)} for today.`,
      },
    };
  }

  const warnAt = settings.warnAtPercent;
  if (warnAt > 0 && usedSec >= (limitSec * warnAt) / 100 && !rec.warned[domain]) {
    rec.warned[domain] = Date.now();
    return {
      notify: settings.notify && {
        title: `${fmtDuration(limitSec - usedSec)} left on ${domain}`,
        body: `You've used ${warnAt}% of today's ${fmtMinutes(limitMin)}.`,
      },
    };
  }

  return {};
}

// Credits everything owed up to asOf, then moves the segment start there.
//
// Credit is capped at heartbeat + GRACE_MS so a browser that was closed, or a
// machine that was suspended, cannot bank hours it never spent. The grace is
// deliberately larger than the tick: Chrome may clamp the alarm period, and
// under-counting ordinary browsing (which happens all day) is a worse error
// than over-crediting a couple of minutes after a resume (which happens
// rarely). Time past the cap is discarded, never credited late -- `since`
// jumps to asOf regardless.
async function settle(state, asOf) {
  if (state.domain && state.since) {
    const end = creditEnd(state, asOf, GRACE_MS);
    if (end > state.since) await accrue(state.domain, state.since, end);
  }
  state.since = asOf;
}

// --- what is active right now ------------------------------------------------

// Finds the window that actually holds focus.
//
// Polling `window.focused` does not work on GNOME/Wayland. Measured on this
// machine: Brave fired onFocusChanged for window A and then window B, and 43
// seconds later getAll() reported focused:false for all four windows. Every
// time the flag did name a window, it named the wrong one -- the active tab
// came back as brave:// or an empty URL while the user was browsing elsewhere.
//
// The event stream is the reliable source, so focus is now *remembered* from
// events (onFocusChanged, and tab activity, which only happens when the user is
// in the browser) and the polled flag is demoted to a hint: it is preferred
// when it names a window, because it self-heals after a worker restart and it
// is correct on platforms where it works, but it is no longer required.
async function focusedWindow(state, now) {
  const probe = async () => {
    try {
      return await chrome.windows.getAll({ windowTypes: ['normal', 'popup'] });
    } catch {
      return [];
    }
  };

  // No re-polling here. It was tried: a 1.5s re-poll at 400ms intervals, and
  // across 173 failures it never once turned a false into a true (every failure
  // logged probes:5, every success probes:1). The flag does not flicker on a
  // millisecond scale -- it stays false for minutes -- so re-polling only
  // blocked the worker for 1.5s per failing tick.
  const all = await probe();
  const flagged = all.find((w) => w.focused);

  const seen = all.map((w) => ({ id: w.id, focused: !!w.focused, type: w.type }));

  if (flagged) {
    state.focusedWindowId = flagged.id;
    state.lastFlagTrue = now;
    return { win: flagged, via: 'flag', seen };
  }

  // Nothing claims focus. Coast on the remembered window, but only briefly.
  //
  // Measured: while the user is genuinely in the browser the flag returns true
  // every 30-60s, so memory is refreshed constantly and a flap is invisible.
  // While the browser sits in the background the flag went true ONCE and then
  // stayed false for 27 minutes -- which, with unbounded memory, was credited
  // as 27 minutes of browsing. Expiring the memory is what separates the two
  // cases, because only real use keeps refreshing it.
  const sinceFlag = now - (state.lastFlagTrue || 0);
  if (state.focusedWindowId != null && sinceFlag <= FOCUS_MEMORY_MS) {
    const remembered = all.find((w) => w.id === state.focusedWindowId);
    if (remembered) return { win: remembered, via: 'event', seen, sinceFlag };
  }

  state.focusedWindowId = null;
  return { win: null, via: 'none', seen, sinceFlag };
}

// Exactly one tab can be current: the active tab of the focused window.
// Returns null when nothing qualifies -- the browser is not in front, the user
// is idle or locked, or the tab is not a trackable http(s) page.
async function resolveTarget(state, now) {
  const settings = await getSettings();
  const media = await getMedia();

  let win = null;
  let tab = null;
  let via = null;

  // 1. Accurate mode: ask the pages themselves.
  if (settings.accurate) {
    const hit = await focusedByProbe();
    if (hit.win) {
      win = hit.win;
      tab = hit.tab;
      via = 'probe';
      state.focusedWindowId = win.id;
      state.lastFlagTrue = now;
    } else if (hit.answered > 0) {
      // Pages answered and none of them has focus. That is a real answer:
      // the browser is not in front. No guessing, no coasting.
      await noteResolve({ outcome: 'not-focused', via: 'probe', answered: hit.answered });
      state.focusedWindowId = null;
      return null;
    }
    // hit.answered === 0: nobody could answer (browser pages only, or the
    // script is not injected yet) -- fall through to the old flag path.
  }

  // 2. Fallback: the unreliable window flag, with bounded memory.
  if (!win) {
    const found = await focusedWindow(state, now);
    if (!found.win) {
      await noteResolve({
        outcome: 'no-focused-window',
        seen: found.seen,
        sinceFlag: Math.round((found.sinceFlag || 0) / 1000),
      });
      return null;
    }
    win = found.win;
    via = found.via;
    try {
      const tabs = await chrome.tabs.query({ active: true, windowId: win.id });
      tab = tabs[0];
    } catch { /* window closed */ }
  }

  if (!tab) {
    await noteResolve({ outcome: 'no-active-tab', windowId: win.id, via });
    return null;
  }

  const domain = registrableDomain(tab.url);
  if (!domain) {
    await noteResolve({
      outcome: 'untrackable',
      windowId: win.id,
      via,
      status: tab.status,
    });
    return null;
  }

  const playing = mediaPlaying(media, tab.id) || !!tab.audible;

  // 3. Idle. Watching a film is indistinguishable from being away if you only
  // look at keyboard and mouse -- which is how 11 minutes of a 45 minute
  // episode went missing. Playing media counts as being present.
  const idleState = await chrome.idle.queryState(Math.max(15, settings.idleSeconds));
  if (idleState !== 'active' && !(settings.mediaCountsAsPresent && playing)) {
    await noteResolve({ outcome: 'idle', idleState });
    return null;
  }

  // 4. Playback gate: for these sites a focused tab is not a watched one.
  const playbackOnly = await getPlaybackOnly();
  if (playbackOnly[domain] && !playing) {
    await noteResolve({ outcome: 'not-playing', domain, windowId: win.id });
    return null;
  }

  await noteResolve({ outcome: 'tracking', domain, windowId: win.id, via, playing });
  return { domain, tabId: tab.id, windowId: win.id };
}

// Only logs when the outcome changes, so a quiet hour costs one entry.
let lastResolveKey = null;
async function noteResolve(detail) {
  const key = JSON.stringify(detail);
  if (key === lastResolveKey) return;
  lastResolveKey = key;
  await diag('resolve', detail);
}

let ticking = null;

// Single entry point: settle what is owed, then re-resolve what is current.
// Serialised, because events and the alarm can land together and two
// concurrent settles would double-credit the same span.
function enqueue(fn) {
  ticking = (ticking || Promise.resolve()).then(fn).catch((err) => {
    console.error('[tabtime] task failed', err);
  });
  return ticking;
}

function tick(reason) {
  return enqueue(() => runTick(reason));
}

async function runTick(reason) {
  const now = Date.now();
  const state = await loadState();

  if (state.pendingBlurAt) {
    if (now - state.pendingBlurAt >= BLUR_GRACE_MS) {
      // A real pause. Credit only up to the moment focus was lost.
      await settle(state, state.pendingBlurAt);
      state.domain = null;
      state.tabId = null;
      state.windowId = null;
      state.focusedWindowId = null;   // the browser really did go to the back
      state.pendingBlurAt = 0;
      state.since = now;
    } else {
      // Still inside the grace window -- decide nothing yet.
      state.heartbeat = now;
      await saveState(state);
      return;
    }
  } else {
    await settle(state, now);
  }

  state.heartbeat = now;

  const target = await resolveTarget(state, now);
  if (target) {
    state.domain = target.domain;
    state.tabId = target.tabId;
    state.windowId = target.windowId;
  } else {
    state.domain = null;
    state.tabId = null;
    state.windowId = null;
  }

  await saveState(state);
}

// --- blocking ----------------------------------------------------------------

function blockedUrl(domain, original) {
  const params = new URLSearchParams({ d: domain });
  if (original) params.set('u', original);
  return chrome.runtime.getURL(`src/blocked/blocked.html?${params}`);
}

function isOwnBlockPage(url) {
  return typeof url === 'string' && url.startsWith(chrome.runtime.getURL('src/blocked/blocked.html'));
}

// Replaces every open tab sitting on a blocked domain -- background tabs
// included, so one cannot idle past the limit and be waiting later.
async function sweepTabs() {
  const [rec, limits] = await Promise.all([getDay(), getLimits()]);
  const blocked = blockedSet(rec, limits);
  if (!blocked.size) return;

  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async (tab) => {
    const domain = registrableDomain(tab.url);
    if (!domain || !blocked.has(domain)) return;
    try {
      await chrome.tabs.update(tab.id, { url: blockedUrl(domain, tab.url) });
    } catch { /* tab closed mid-sweep */ }
  }));
}

async function refreshBadge() {
  const [rec, limits] = await Promise.all([getDay(), getLimits()]);
  const count = blockedSet(rec, limits).size;
  await chrome.action.setBadgeBackgroundColor({ color: '#FB542B' });
  await chrome.action.setBadgeText({ text: count ? String(count) : '' });
}

function notify(title, body) {
  if (!title) return;
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message: body || '',
  }, () => void chrome.runtime.lastError);
}

// --- events ------------------------------------------------------------------

// Runs inside the same serialised queue as the ticks: loading, mutating and
// saving state outside it raced with an in-flight tick and could lose the
// write.
chrome.windows.onFocusChanged.addListener((windowId) => {
  enqueue(async () => {
    const none = windowId === chrome.windows.WINDOW_ID_NONE;
    await diag(none ? 'blur' : 'focus', { windowId: none ? 'NONE' : windowId });

    const state = await loadState();

    if (none) {
      if (!state.pendingBlurAt) {
        state.pendingBlurAt = Date.now();
        await saveState(state);
      }
      // Re-check once the grace window passes; the 30s tick is the backstop
      // if the worker is evicted before this fires.
      setTimeout(() => tick('blur-grace'), BLUR_GRACE_MS + 50);
      return;
    }

    // Focus moved between our own windows: no pause happened.
    state.pendingBlurAt = 0;
    state.focusedWindowId = windowId;
    await saveState(state);
    await runTick('window-focus');
  });
});

// Tab activity only happens when the user is in the browser, so it doubles as
// a focus signal -- and it is what seeds focus after a worker restart, when no
// onFocusChanged has fired yet.
chrome.tabs.onActivated.addListener((info) => {
  enqueue(async () => {
    const state = await loadState();
    state.focusedWindowId = info.windowId;
    state.pendingBlurAt = 0;
    await saveState(state);
    await runTick('tab-activated');
  });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Sound started or stopped: for a playback-gated site this is the difference
  // between the clock running and not, so settle immediately instead of waiting
  // up to 30s for the next tick.
  if (changeInfo.audible !== undefined && tab && tab.active) {
    tick('audible');
    return;
  }

  if (!changeInfo.url) return;

  const domain = registrableDomain(changeInfo.url);
  if (domain) {
    const [rec, limits] = await Promise.all([getDay(), getLimits()]);
    if (blockedSet(rec, limits).has(domain)) {
      try {
        await chrome.tabs.update(tabId, { url: blockedUrl(domain, changeInfo.url) });
      } catch { /* gone */ }
      return;
    }
  }

  if (tab && tab.active) {
    enqueue(async () => {
      const state = await loadState();
      state.focusedWindowId = tab.windowId;
      state.pendingBlurAt = 0;
      await saveState(state);
      await runTick('tab-url');
    });
  }
});

chrome.idle.onStateChanged.addListener(() => tick('idle'));

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const media = await getMedia();
  if (media[tabId]) {
    delete media[tabId];
    await chrome.storage.session.set({ media });
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'tick') {
    await tick('alarm');
    await refreshBadge();
  } else if (alarm.name === 'midnight') {
    await tick('midnight');
    await pruneDays();
    await refreshBadge();
    await scheduleMidnight();
  }
});

async function scheduleMidnight() {
  await chrome.alarms.create('midnight', { when: nextMidnight() + 2_000 });
}

async function init() {
  await migrate();
  await pruneDays();   // also at midnight, but the browser may be closed then

  const settings = await getSettings();
  chrome.idle.setDetectionInterval(Math.max(15, settings.idleSeconds));

  if (settings.accurate) {
    const granted = await chrome.permissions.contains({ origins: ['*://*/*'] }).catch(() => false);
    if (granted) await registerProbe(true);
    else await patchSettings({ accurate: false });   // permission revoked behind our back
  }
  await chrome.alarms.create('tick', { periodInMinutes: TICK_MINUTES });
  await scheduleMidnight();
  await tick('init');
  await sweepTabs();
  await refreshBadge();
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

// --- message API for the popup, dashboard and block page ---------------------

const handlers = {
  async snapshot() {
    await tick('snapshot');
    const [today, yesterday, limits, settings, state, playbackOnly] = await Promise.all([
      getDay(), getDay(prevDayKey()), getLimits(), getSettings(), loadState(), getPlaybackOnly(),
    ]);
    return {
      today,
      yesterdayTotal: sumTotals(yesterday),
      limits,
      playbackOnly,
      settings,
      now: Date.now(),
      blocked: [...blockedSet(today, limits)],
      current: state.domain,
    };
  },

  // Every day still kept, oldest first -- retention is what bounds it, so
  // nothing is stored that the dashboard cannot show.
  async history({ days } = {}) {
    const keys = await listDayKeys();
    return { days: await getDays(days ? keys.slice(-days) : keys) };
  },

  async setLimit({ domain, minutes }) {
    // Time is bucketed by registrable domain, so a limit keyed any other way
    // (news.ycombinator.com) would never match. Normalise at the door.
    const key = registrableDomain(`https://${domain}`) || domain;
    const limits = await setLimit(key, minutes);
    await sweepTabs();      // a lowered limit can block immediately
    await refreshBadge();   // a raised one clears the badge
    return { limits };
  },

  async removeLimit({ domain }) {
    const limits = await setLimit(domain, 0);
    await refreshBadge();
    return { limits };
  },

  async patchSettings({ patch }) {
    const settings = await patchSettings(patch);
    chrome.idle.setDetectionInterval(Math.max(15, settings.idleSeconds));
    if (patch && patch.diagnostics === false) await chrome.storage.local.remove('diag');
    return { settings };
  },

  // Sent by the content script; no reply is awaited.
  async media({ playing }, sender) {
    if (sender && sender.tab) {
      await noteMedia(sender.tab.id, playing);
      if (playing) await tick('media');
    }
    return {};
  },

  // The permission itself is requested by the dashboard, which has the user
  // gesture the API demands; this only turns the machinery on afterwards.
  async setAccurate({ on }) {
    const registered = await registerProbe(on);
    const settings = await patchSettings({ accurate: on && registered });
    await tick('accurate-changed');
    return { settings, registered };
  },

  async setPlaybackOnly({ domain, on }) {
    const playbackOnly = await setPlaybackOnly(domain, on);
    await tick('playback-changed');
    return { playbackOnly };
  },

  async clearData() {
    const keys = await listDayKeys();
    await chrome.storage.local.remove([...keys.map((k) => `day:${k}`), 'diag']);
    await chrome.storage.session.remove('track');
    await refreshBadge();
    await tick('cleared');
    return { cleared: keys.length };
  },

  async closeTab(_msg, sender) {
    if (sender.tab) await chrome.tabs.remove(sender.tab.id);
    return {};
  },
};

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  const handler = handlers[msg && msg.type];
  if (!handler) return false;
  handler(msg, sender).then(respond).catch((err) => respond({ error: String(err) }));
  return true;   // response is async
});

// The worker may also be spun up without onInstalled/onStartup firing
// (an event woke it after eviction); make sure the alarms exist.
chrome.alarms.get('tick').then((alarm) => {
  if (!alarm) init();
});
