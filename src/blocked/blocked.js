import { fmtDuration, fmtMinutes, fmtClock, nextMidnight } from '../lib/time.js';

const params = new URLSearchParams(location.search);
const domain = params.get('d') || 'this site';
const original = params.get('u') || '';

const $ = (id) => document.getElementById(id);

let unblocked = false;

document.title = `${domain} is blocked — Tabtime`;
$('domain').textContent = domain;

$('close').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'closeTab' });
});

$('dashboard').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// The countdown runs locally every second; the snapshot that decides whether
// the block still stands is fetched far less often, so the service worker is
// not woken once a second by a page the user is not even looking at.
function paintClock() {
  const now = Date.now();
  const midnight = nextMidnight(now);
  const startOfDay = midnight - 86_400_000;

  $('remaining').textContent = fmtDuration((midnight - now) / 1000);
  $('now-label').textContent = `now · ${fmtClock(now)}`;
  $('dayfill').style.width = `${(((now - startOfDay) / 86_400_000) * 100).toFixed(2)}%`;
}

async function paintState() {
  let snap;
  try {
    snap = await chrome.runtime.sendMessage({ type: 'snapshot' });
  } catch {
    return;   // worker restarting; the next poll will catch it
  }
  if (!snap || snap.error) return;

  const used = snap.today.totals[domain] || 0;
  const limit = snap.limits[domain];

  $('used').textContent = fmtDuration(used);
  $('limit').textContent = limit ? fmtMinutes(limit) : 'None';
  $('lede').textContent = limit
    ? `You gave this site ${fmtMinutes(limit)} a day. You've spent them. It comes back on its own at midnight.`
    : 'This site was blocked earlier today.';

  const blockedCount = snap.blocked.length;
  $('foot').textContent = blockedCount > 1
    ? `Other sites are unaffected · ${blockedCount - 1} more ${blockedCount - 1 === 1 ? 'limit is' : 'limits are'} still running today`
    : 'Other sites are unaffected';

  if (!snap.blocked.includes(domain)) showUnblocked();
}

// Raising the limit clears the block immediately, so the page it replaced
// should be reachable again without a manual retype.
function showUnblocked() {
  if (unblocked) return;
  unblocked = true;

  $('eyebrow').textContent = 'Limit raised';
  $('lede').textContent = 'This site is available again.';
  $('remaining').textContent = '—';
  document.querySelector('.badge').style.opacity = '0.45';

  const go = $('dashboard');
  go.classList.add('primary');
  go.innerHTML = `Continue to ${domain}`;
  go.onclick = () => { location.replace(original || `https://${domain}/`); };

  $('fine').textContent = original
    ? 'Picking up where you left off.'
    : 'Reload to continue.';
}

paintClock();
paintState();
setInterval(paintClock, 1000);
setInterval(paintState, 15_000);
