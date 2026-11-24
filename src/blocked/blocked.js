import { fmtDuration, fmtMinutes, fmtClock, nextMidnight, dayKey } from '../lib/time.js';
import { blockedSet } from '../lib/accrual.js';

const params = new URLSearchParams(location.search);
const domain = params.get('d') || 'this site';
const original = params.get('u') || '';
const blockedOn = params.get('k') || '';   // day the block was put up

const $ = (id) => document.getElementById(id);

let unblocked = false;
let shownDay = dayKey();

document.title = `${domain} is blocked — Tabtime`;
$('domain').textContent = domain;

$('close').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'closeTab' });
});

// One handler for both states. A second listener added on unblock would fire
// alongside this one, and the dashboard would steal the tab's focus.
$('dashboard').addEventListener('click', () => {
  if (unblocked) location.replace(original || `https://${domain}/`);
  else chrome.runtime.openOptionsPage();
});

// The page never messages the service worker. It reads the two storage keys
// it needs directly and repaints when they change, so a blocked tab left open
// all day costs nothing in the background. The clock runs only while the tab
// is visible.
function paintClock() {
  const now = Date.now();

  // Crossing midnight is the moment the block lifts; nothing in storage
  // changes then, so the clock is what notices. A tab hidden at midnight
  // notices as soon as it is shown again.
  const today = dayKey(now);
  if (today !== shownDay) {
    shownDay = today;
    paintState();
  }
  if (unblocked) return;

  const midnight = nextMidnight(now);
  const startOfDay = midnight - 86_400_000;

  $('remaining').textContent = fmtDuration((midnight - now) / 1000);
  $('now-label').textContent = `now · ${fmtClock(now)}`;
  $('dayfill').style.width = `${(((now - startOfDay) / 86_400_000) * 100).toFixed(2)}%`;
}

async function paintState() {
  const slot = `day:${dayKey()}`;
  const got = await chrome.storage.local.get([slot, 'limits']);
  const today = { date: dayKey(), totals: {}, ...(got[slot] || {}) };
  const limits = got.limits || {};
  const blocked = [...blockedSet(today, limits)];

  const used = today.totals[domain] || 0;
  const limit = limits[domain];

  $('used').textContent = fmtDuration(used);
  $('limit').textContent = limit ? fmtMinutes(limit) : 'None';

  const blockedCount = blocked.length;
  $('foot').textContent = blockedCount > 1
    ? `Other sites are unaffected · ${blockedCount - 1} more ${blockedCount - 1 === 1 ? 'limit is' : 'limits are'} still running today`
    : 'Other sites are unaffected';

  if (!blocked.includes(domain)) {
    showUnblocked(today.date);
    return;
  }
  $('lede').textContent = limit
    ? `You gave this site ${fmtMinutes(limit)} a day. You've spent them. It comes back on its own at midnight.`
    : 'This site was blocked earlier today.';
}

// A spent limit is locked until midnight, so in practice the block lifts
// because a new day started. Either way the page it replaced should be
// reachable again without a manual retype.
function showUnblocked(today) {
  if (unblocked) return;
  unblocked = true;

  const newDay = !blockedOn || blockedOn !== today;
  $('eyebrow').textContent = newDay ? 'New day' : 'Available again';
  $('lede').textContent = newDay
    ? `Your limit has reset. Today's allowance for ${domain} is yours again.`
    : 'This site is available again.';
  $('remaining').textContent = '—';
  document.querySelector('.badge').style.opacity = '0.45';

  const go = $('dashboard');
  go.classList.add('primary');
  go.textContent = `Continue to ${domain}`;
  clearInterval(clock);

  $('fine').textContent = original
    ? 'Picking up where you left off.'
    : 'Reload to continue.';
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && !unblocked && (changes.limits || changes[`day:${dayKey()}`])) paintState();
});

let clock = null;
function syncClock() {
  clearInterval(clock);
  clock = null;
  if (document.visibilityState !== 'visible') return;
  paintClock();
  if (!unblocked) clock = setInterval(paintClock, 1000);
}
document.addEventListener('visibilitychange', syncClock);

paintState();
syncClock();
