import { registrableDomain } from '../lib/domain.js';
import { fmtDuration, fmtMinutes, sumTotals } from '../lib/time.js';

const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)'];
const OTHER = 'var(--series-other)';
const PRESETS = [15, 30, 60, 120, 180];

const ICON = {
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="11" width="15" height="9" rx="2"/><path d="M8 11V7.8a4 4 0 0 1 8 0V11"/></svg>',
  warn: '<svg class="warnicon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.5 21 19.5H3z"/><path d="M12 10.5v4M12 17.2v.1"/></svg>',
  down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
  up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
};

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

let snap = null;
let sheet = { domain: null, minutes: 60 };

// --- today -------------------------------------------------------------------

function renderToday() {
  const { today, limits, yesterdayTotal, blocked } = snap;
  const total = sumTotals(today);

  $('total').textContent = total > 0 ? fmtDuration(total) : '0m';
  renderDelta(total, yesterdayTotal);

  const ranked = Object.entries(today.totals)
    .filter(([, sec]) => sec >= 1)
    .sort((a, b) => b[1] - a[1]);

  const top = ranked.slice(0, 5);
  const restSec = ranked.slice(5).reduce((a, [, sec]) => a + sec, 0);

  $('site-count').textContent = ranked.length ? `${top.length} of ${ranked.length}` : '';
  renderSegbar(top, restSec, total);
  renderSites(top, restSec, ranked.length, limits, blocked);
}

function renderDelta(total, yesterday) {
  const el = $('delta');
  el.className = 'delta';
  if (!yesterday) { el.textContent = ''; return; }

  const diff = total - yesterday;
  if (Math.abs(diff) < 60) {
    el.textContent = 'about the same as yesterday';
    return;
  }
  const less = diff < 0;
  el.classList.add(less ? 'down' : 'up');
  el.innerHTML = `${less ? ICON.down : ICON.up}<span>${fmtDuration(Math.abs(diff))} ${less ? 'less' : 'more'} than yesterday</span>`;
}

function renderSegbar(top, restSec, total) {
  const bar = $('segbar');
  bar.innerHTML = '';
  if (!total) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';

  top.forEach(([, sec], i) => {
    const seg = document.createElement('i');
    seg.style.width = `${(sec / total) * 100}%`;
    seg.style.background = SERIES[i];
    bar.append(seg);
  });
  if (restSec > 0) {
    const seg = document.createElement('i');
    seg.style.flexGrow = '1';
    seg.style.background = OTHER;
    bar.append(seg);
  }
}

function renderSites(top, restSec, totalSites, limits, blocked) {
  const host = $('sites');
  host.innerHTML = '';

  if (!top.length) {
    host.innerHTML = '<p class="empty">Nothing tracked yet today. Browse for a minute and this fills in.<br><br>Only the active tab of the focused window counts &mdash; one clock, never two.</p>';
    return;
  }

  top.forEach(([domain, sec], i) => {
    const limit = limits[domain];
    const isBlocked = blocked.includes(domain);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'site';
    row.title = `Set a daily limit for ${domain}`;

    const pill = isBlocked ? `<span class="pill blocked">${ICON.lock}Blocked</span>` : '';

    let sub = 'No limit set';
    if (isBlocked) {
      sub = `Limit ${fmtMinutes(limit)} &middot; unblocks at 00:00`;
    } else if (limit) {
      const left = limit * 60 - sec;
      const low = left <= limit * 60 * 0.2;
      sub = low
        ? `<span class="pill warn">${ICON.warn}${fmtDuration(left)} left of ${fmtMinutes(limit)}</span>`
        : `${fmtDuration(left)} left of ${fmtMinutes(limit)}`;
    }

    const rail = limit
      ? `<div class="rail"><i style="width:${Math.min(100, (sec / (limit * 60)) * 100)}%;background:${isBlocked ? 'var(--accent)' : (sec / (limit * 60) >= 0.8 ? 'var(--warn)' : 'var(--data)')}"></i></div>`
      : '';

    row.innerHTML = `
      <span class="site-top">
        <span class="dot" style="background:${SERIES[i]}"></span>
        <span class="site-name">${escapeHtml(domain)}</span>
        ${pill}
        <span class="num site-time ${isBlocked ? 'at-limit' : ''}">${fmtDuration(sec)}</span>
      </span>
      <span class="site-sub"><span class="dot"></span><span>${sub}</span></span>
      ${rail}`;

    row.addEventListener('click', () => openSheet(domain));
    host.append(row);
  });

  if (restSec > 0) {
    const note = document.createElement('div');
    note.className = 'site-sub';
    note.style.marginTop = '10px';
    note.innerHTML = `<span class="dot" style="background:${OTHER};visibility:visible"></span><span>${totalSites - top.length} other sites &middot; ${fmtDuration(restSec)}</span>`;
    host.append(note);
  }
}

// --- limit sheet -------------------------------------------------------------

function openSheet(domain) {
  sheet.domain = domain;
  sheet.minutes = snap.limits[domain] || 60;
  $('view-today').hidden = true;
  $('view-sheet').hidden = false;
  renderSheet();
}

function closeSheet() {
  $('view-sheet').hidden = true;
  $('view-today').hidden = false;
}

function renderSheet() {
  const { domain, minutes } = sheet;
  const used = (snap.today.totals[domain] || 0);
  const index = Object.entries(snap.today.totals)
    .sort((a, b) => b[1] - a[1])
    .findIndex(([d]) => d === domain);

  $('sheet-dot').style.background = index >= 0 && index < 5 ? SERIES[index] : OTHER;
  $('sheet-domain').textContent = domain;
  $('rule-domain').textContent = domain;
  $('sheet-used').textContent = used > 0 ? `${fmtDuration(used)} today` : 'Nothing today yet';
  $('limit-value').textContent = fmtMinutes(minutes);
  $('limit-range').value = String(minutes);
  $('warn-toggle').checked = snap.settings.warnAtPercent > 0;
  $('playback-toggle').checked = !!snap.playbackOnly[domain];
  $('playback-help').textContent = snap.playbackOnly[domain]
    ? `${domain} only counts while its tab is making sound. A muted video will not count.`
    : 'A focused tab is not a watched one. Applies immediately.';
  $('remove-limit').disabled = !snap.limits[domain];

  const host = $('presets');
  host.innerHTML = '';
  PRESETS.forEach((v) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'preset';
    b.textContent = fmtMinutes(v);
    b.setAttribute('aria-pressed', String(v === minutes));
    b.addEventListener('click', () => setMinutes(v));
    host.append(b);
  });
}

function setMinutes(v) {
  sheet.minutes = Math.max(0, Math.min(240, v));
  renderSheet();
}

// --- wiring ------------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function currentDomain() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return registrableDomain(tab && tab.url);
  } catch {
    return null;
  }
}

async function refresh() {
  snap = await send({ type: 'snapshot' });
  renderToday();
}

function openDashboard() {
  chrome.runtime.openOptionsPage();
  window.close();
}

$('open-dashboard').addEventListener('click', openDashboard);
$('go-dashboard').addEventListener('click', openDashboard);
$('sheet-back').addEventListener('click', closeSheet);
$('step-up').addEventListener('click', () => setMinutes(sheet.minutes + 15));
$('step-down').addEventListener('click', () => setMinutes(sheet.minutes - 15));
$('limit-range').addEventListener('input', (e) => setMinutes(parseInt(e.target.value, 10)));

$('add-limit').addEventListener('click', async () => {
  const live = await currentDomain();
  const top = Object.entries(snap.today.totals).sort((a, b) => b[1] - a[1])[0];
  const target = live || (top && top[0]);
  if (!target) {
    $('add-limit').textContent = 'Open a site first';
    return;
  }
  openSheet(target);
});

$('save-limit').addEventListener('click', async () => {
  await send({ type: 'setLimit', domain: sheet.domain, minutes: sheet.minutes });
  await refresh();
  closeSheet();
});

$('remove-limit').addEventListener('click', async () => {
  await send({ type: 'removeLimit', domain: sheet.domain });
  await refresh();
  closeSheet();
});

$('playback-toggle').addEventListener('change', async (e) => {
  const res = await send({ type: 'setPlaybackOnly', domain: sheet.domain, on: e.target.checked });
  snap.playbackOnly = res.playbackOnly;
  renderSheet();
});

$('warn-toggle').addEventListener('change', async (e) => {
  const patch = { warnAtPercent: e.target.checked ? 80 : 0 };
  const res = await send({ type: 'patchSettings', patch });
  snap.settings = res.settings;
});

refresh();
