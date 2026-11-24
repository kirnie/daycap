import { fmtDuration, fmtMinutes, fmtClock, fmtLongDate, nextMidnight, sumTotals } from '../lib/time.js';
import { registrableDomain } from '../lib/domain.js';

const CHART_DAYS = 30;   // the History chart shows the newest 30; the list shows all
const hh = (i) => String(i).padStart(2, '0');

const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)'];
const OTHER = 'var(--series-other)';

const ICON = {
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="11" width="15" height="9" rx="2"/><path d="M8 11V7.8a4 4 0 0 1 8 0V11"/></svg>',
  warn: '<svg class="warnicon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.5 21 19.5H3z"/><path d="M12 10.5v4M12 17.2v.1"/></svg>',
  down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
  chevron: '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
};

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let snap = null;
let history = [];
let view = 'today';
const openDays = new Set();   // expanded History rows, kept across the 30s reloads

// --- shared chart helper -----------------------------------------------------
// One series, so no legend: the card title names it. Bars carry a hover
// tooltip because an HTML chart that cannot be interrogated is a picture.

function drawBars({ plot, barsEl, axisEl, tipEl, values, max, barWidth, label, tip }) {
  barsEl.innerHTML = '';
  axisEl.innerHTML = '';

  values.forEach((v, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.style.width = `${barWidth}px`;
    if (!v) btn.classList.add('zero');

    const fill = document.createElement('i');
    fill.style.height = v ? `${Math.max(2, (v / max) * 100)}%` : '2px';
    btn.append(fill);

    const show = () => {
      barsEl.querySelectorAll('.on').forEach((el) => el.classList.remove('on'));
      btn.classList.add('on');
      const t = tip(i, v);
      tipEl.innerHTML = `<div class="t1">${t.title}</div><div class="t2">${t.value}</div>` +
        (t.note ? `<div class="t3"><span class="dot" style="background:${t.color || OTHER}"></span>${t.note}</div>` : '');
      tipEl.hidden = false;
      const width = tipEl.offsetWidth;
      const centre = btn.offsetLeft + btn.offsetWidth / 2;
      tipEl.style.left = `${Math.max(0, Math.min(plot.clientWidth - width, centre - width / 2))}px`;
    };

    btn.addEventListener('mouseenter', show);
    btn.addEventListener('focus', show);
    btn.setAttribute('aria-label', `${label(i)}: ${tip(i, v).value}`);
    barsEl.append(btn);

    const tick = document.createElement('span');
    tick.style.width = `${barWidth}px`;
    tick.textContent = label(i, true);
    axisEl.append(tick);
  });

  // Assigned, not addEventListener: this runs on every repaint, and listeners
  // would otherwise pile up one per refresh for as long as the tab is open.
  plot.onmouseleave = () => {
    tipEl.hidden = true;
    barsEl.querySelectorAll('.on').forEach((el) => el.classList.remove('on'));
  };
}

// --- today -------------------------------------------------------------------

function rankedSites(rec) {
  return Object.entries(rec.totals).filter(([, s]) => s >= 1).sort((a, b) => b[1] - a[1]);
}

function renderToday() {
  const { today, limits, blocked, yesterdayTotal } = snap;
  const total = sumTotals(today);
  const ranked = rankedSites(today);

  $('view-title').textContent = fmtLongDate(Date.now());
  $('view-sub').textContent = `Resets in ${fmtDuration((nextMidnight() - Date.now()) / 1000)}`;

  // KPIs
  $('k-total').textContent = total ? fmtDuration(total) : '0m';
  const diff = total - yesterdayTotal;
  const sub = $('k-total-sub');
  sub.className = 'kpi-sub';
  if (!yesterdayTotal) {
    sub.textContent = 'No data for yesterday';
  } else if (Math.abs(diff) < 60) {
    sub.textContent = 'About the same as yesterday';
  } else {
    sub.classList.add(diff < 0 ? 'down' : 'up');
    sub.innerHTML = `${diff < 0 ? ICON.down : ICON.up}<span>${fmtDuration(Math.abs(diff))} ${diff < 0 ? 'less' : 'more'} than yesterday</span>`;
  }

  $('k-sites').textContent = String(ranked.length);
  const limited = Object.keys(limits).length;
  $('k-sites-sub').textContent = limited ? `${limited} ${limited === 1 ? 'has' : 'have'} a daily limit` : 'No limits set';

  $('k-hit').textContent = String(blocked.length);
  $('k-hit').classList.toggle('flag', blocked.length > 0);
  const firstHit = Object.entries(today.blocked).sort((a, b) => a[1] - b[1])[0];
  $('k-hit-sub').textContent = firstHit ? `${firstHit[0]}, at ${fmtClock(firstHit[1])}` : 'Nothing blocked today';

  const earlier = history.filter((d) => d.date !== today.date);
  $('k-avg').textContent = earlier.length
    ? fmtDuration(earlier.reduce((a, d) => a + sumTotals(d), 0) / earlier.length)
    : '—';
  $('k-avg-sub').textContent = earlier.length
    ? `Across ${earlier.length} earlier ${earlier.length === 1 ? 'day' : 'days'} with activity`
    : 'No earlier days yet';

  renderHourly(today);
  renderSiteTable(ranked, total, limits, blocked);
  renderLimitPanel(today, limits, blocked);
}

function hourTotals(rec) {
  const perHour = new Array(24).fill(0);
  for (const [h, sec] of Object.entries(rec.hours || {})) perHour[Number(h)] += sec;
  return perHour;
}

function renderHourly(today) {
  const perHour = hourTotals(today);

  const peakIdx = perHour.indexOf(Math.max(...perHour));
  $('chart-peak').textContent = perHour[peakIdx] > 0
    ? `Peak ${Math.round(perHour[peakIdx] / 60)}m at ${hh(peakIdx)}:00`
    : 'Nothing tracked yet today';

  drawBars({
    plot: $('plot'),
    barsEl: $('bars'),
    axisEl: $('xaxis'),
    tipEl: $('tip'),
    values: perHour,
    max: 3600,                 // one full hour of activity is the ceiling
    barWidth: 18,
    label: (i, forAxis) => (forAxis ? (i % 3 === 0 ? String(i).padStart(2, '0') : '') : `${String(i).padStart(2, '0')}:00`),
    tip: (i, v) => ({
      title: `${String(i).padStart(2, '0')}:00–${String((i + 1) % 24).padStart(2, '0')}:00`,
      value: v ? `${Math.round(v / 60)} min active` : 'Nothing tracked',
    }),
  });
}

function statusCell(domain, sec, limits, blocked) {
  if (blocked.includes(domain)) {
    return `<span class="pill blocked">${ICON.lock}Blocked</span>`;
  }
  const limit = limits[domain];
  if (!limit) return 'No limit';
  const left = limit * 60 - sec;
  return sec / (limit * 60) >= 0.8
    ? `<span class="pill warn">${ICON.warn}${fmtDuration(left)} left</span>`
    : `${fmtDuration(left)} left`;
}

function renderSiteTable(ranked, total, limits, blocked) {
  const host = $('site-rows');
  host.innerHTML = '';

  if (!ranked.length) {
    host.innerHTML = '<p class="empty" style="padding:18px 0">Nothing tracked yet today.</p>';
    return;
  }

  const top = ranked.slice(0, 5);
  const restSec = ranked.slice(5).reduce((a, [, s]) => a + s, 0);

  top.forEach(([domain, sec], i) => {
    const row = document.createElement('div');
    row.className = 'trow';
    row.innerHTML = `
      <span class="c-site"><span class="dot" style="background:${SERIES[i]}"></span><span class="name">${esc(domain)}</span></span>
      <span class="c-time num">${fmtDuration(sec)}</span>
      <span class="c-share"><span class="rail"><i style="width:${((sec / total) * 100).toFixed(1)}%;background:${SERIES[i]}"></i></span><span class="pc">${Math.round((sec / total) * 100)}%</span></span>
      <span class="c-status">${statusCell(domain, sec, limits, blocked)}</span>`;
    host.append(row);
  });

  if (restSec > 0) {
    const row = document.createElement('div');
    row.className = 'trow total';
    row.innerHTML = `
      <span class="c-site"><span class="dot" style="background:${OTHER}"></span><span class="name">${ranked.length - top.length} other sites</span></span>
      <span class="c-time num">${fmtDuration(restSec)}</span>
      <span class="c-share"><span class="rail"><i style="width:${((restSec / total) * 100).toFixed(1)}%;background:${OTHER}"></i></span><span class="pc">${Math.round((restSec / total) * 100)}%</span></span>
      <span class="c-status">—</span>`;
    host.append(row);
  }
}

function renderLimitPanel(today, limits, blocked) {
  const host = $('limit-rows');
  host.innerHTML = '';
  $('limit-tally').textContent = Object.keys(limits).length || '';

  const entries = Object.entries(limits).sort((a, b) => (today.totals[b[0]] || 0) - (today.totals[a[0]] || 0));
  if (!entries.length) {
    host.innerHTML = '<p class="empty" style="padding:14px 0">No limits yet. Add one from the popup, or on the Limits tab.</p>';
    return;
  }

  entries.forEach(([domain, minutes]) => {
    const used = today.totals[domain] || 0;
    const ratio = Math.min(1, used / (minutes * 60));
    const isBlocked = blocked.includes(domain);
    const warm = !isBlocked && ratio >= 0.8;

    const block = document.createElement('div');
    block.className = 'limit-block';
    block.innerHTML = `
      <div class="limit-top">
        <span class="name">${esc(domain)}</span>
        <span class="nums num" style="color:${isBlocked ? 'var(--accent)' : warm ? 'var(--warn)' : 'var(--ink-2)'}">${fmtDuration(used)} / ${fmtMinutes(minutes)}</span>
      </div>
      <div class="rail"><i style="width:${ratio * 100}%;background:${isBlocked ? 'var(--accent)' : warm ? 'var(--warn)' : 'var(--data)'}"></i></div>
      <div class="limit-note ${isBlocked ? 'hot' : warm ? 'warm' : ''}">
        ${isBlocked ? `${ICON.lock}Blocked · unblocks at 00:00` : `${warm ? ICON.warn : ''}${fmtDuration(minutes * 60 - used)} left today`}
      </div>`;
    host.append(block);
  });
}

// --- history -----------------------------------------------------------------

function renderHistory() {
  $('view-title').textContent = 'History';
  $('view-sub').textContent = `${history.length} ${history.length === 1 ? 'day' : 'days'} with activity · kept for ${snap.settings.keepDays} days`;

  const charted = history.slice(-CHART_DAYS);
  const totals = charted.map(sumTotals);
  const peak = Math.max(3600, ...totals);
  const ceil = Math.ceil(peak / 3600) * 3600;

  $('hist-range').textContent = totals.length
    ? `Busiest day ${fmtDuration(Math.max(...totals))}${history.length > charted.length ? ` · newest ${charted.length} days charted` : ''}`
    : 'Nothing recorded yet';

  $('hist-yaxis').innerHTML = `<span>${Math.round(ceil / 3600)}h</span><span>${(ceil / 7200).toFixed(1)}h</span><span>0</span>`;

  drawBars({
    plot: $('hist-plot'),
    barsEl: $('hist-bars'),
    axisEl: $('hist-xaxis'),
    tipEl: $('hist-tip'),
    values: totals,
    max: ceil,
    barWidth: Math.max(10, Math.min(36, Math.floor(700 / Math.max(1, charted.length)))),
    label: (i, forAxis) => {
      const d = new Date(`${charted[i].date}T00:00:00`);
      return forAxis ? String(d.getDate()) : charted[i].date;
    },
    tip: (i, v) => {
      const top = rankedSites(charted[i])[0];
      return {
        title: fmtLongDate(new Date(`${charted[i].date}T12:00:00`).getTime()),
        value: v ? fmtDuration(v) : 'Nothing tracked',
        note: top ? `${esc(top[0])} ${fmtDuration(top[1])}` : '',
        color: SERIES[0],
      };
    },
  });

  const host = $('hist-rows');
  host.innerHTML = '';
  if (!history.length) {
    host.innerHTML = '<p class="empty" style="padding:18px 0">No days recorded yet.</p>';
    return;
  }

  [...history].reverse().forEach((rec) => {
    const total = sumTotals(rec);
    const top = rankedSites(rec)[0];
    const hits = Object.keys(rec.blocked || {}).length;
    const open = openDays.has(rec.date);

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'trow day';
    row.setAttribute('aria-expanded', String(open));
    row.innerHTML = `
      <span class="c-site">${ICON.chevron}<span class="name">${fmtLongDate(new Date(`${rec.date}T12:00:00`).getTime())}</span></span>
      <span class="c-time num">${total ? fmtDuration(total) : '—'}</span>
      <span class="c-share"><span class="name" style="font-size:12px;color:var(--ink-2)">${top ? esc(top[0]) : '—'}</span></span>
      <span class="c-status">${hits ? `<span class="pill blocked">${ICON.lock}${hits}</span>` : '—'}</span>`;

    const detail = dayDetail(rec, total);
    detail.hidden = !open;

    row.addEventListener('click', () => {
      const next = !openDays.has(rec.date);
      if (next) openDays.add(rec.date); else openDays.delete(rec.date);
      row.setAttribute('aria-expanded', String(next));
      detail.hidden = !next;
    });

    host.append(row, detail);
  });
}

// A small hour-by-hour strip for one past day, on the same 60-minute scale as
// the Today chart so days compare by eye.
function hourStrip(rec) {
  const perHour = hourTotals(rec);
  const peakIdx = perHour.indexOf(Math.max(...perHour));

  const wrap = document.createElement('div');
  wrap.className = 'mini-hours';
  if (perHour[peakIdx] <= 0) return wrap;

  const cap = document.createElement('div');
  cap.className = 'mh-cap';
  cap.textContent = `Active minutes by hour · peak ${Math.round(perHour[peakIdx] / 60)}m at ${hh(peakIdx)}:00`;

  const bars = document.createElement('div');
  bars.className = 'mh-bars';
  bars.setAttribute('role', 'img');
  bars.setAttribute('aria-label', cap.textContent);
  perHour.forEach((sec, i) => {
    const bar = document.createElement('i');
    if (sec) bar.style.height = `${Math.max(4, Math.min(100, (sec / 3600) * 100))}%`;
    else bar.className = 'zero';
    bar.title = `${hh(i)}:00–${hh((i + 1) % 24)}:00 · ${sec ? `${Math.round(sec / 60)} min` : 'nothing'}`;
    bars.append(bar);
  });

  const axis = document.createElement('div');
  axis.className = 'mh-axis';
  axis.innerHTML = '<span>00</span><span>06</span><span>12</span><span>18</span><span>24</span>';

  wrap.append(cap, bars, axis);
  return wrap;
}

// One past day: its hours, then every site ranked. Colours follow the Today
// table: the top five get a series colour, the rest share the neutral one.
function dayDetail(rec, total) {
  const box = document.createElement('div');
  box.className = 'day-detail';
  box.append(hourStrip(rec));

  rankedSites(rec).forEach(([domain, sec], i) => {
    const colour = i < 5 ? SERIES[i] : OTHER;
    const pct = (sec / total) * 100;
    const blockedAt = rec.blocked && rec.blocked[domain];

    const row = document.createElement('div');
    row.className = 'trow sub';
    row.innerHTML = `
      <span class="c-site"><span class="dot" style="background:${colour}"></span><span class="name">${esc(domain)}</span></span>
      <span class="c-time num">${fmtDuration(sec)}</span>
      <span class="c-share"><span class="rail"><i style="width:${pct.toFixed(1)}%;background:${colour}"></i></span><span class="pc">${Math.round(pct)}%</span></span>
      <span class="c-status">${blockedAt
        ? `<span class="pill blocked">${ICON.lock}Blocked ${fmtClock(blockedAt)}</span>`
        : '—'}</span>`;
    box.append(row);
  });

  return box;
}

// --- limits ------------------------------------------------------------------

// A focused tab is not a watched one: these sites only accrue while their tab
// is producing sound.
function playbackToggle(domain) {
  const label = document.createElement('label');
  label.className = 'mini-toggle';
  label.title = `Only count ${domain} while audio is playing`;

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = !!snap.playbackOnly[domain];
  box.addEventListener('change', async () => {
    await send({ type: 'setPlaybackOnly', domain, on: box.checked });
    await reload();
  });

  label.append(box, Object.assign(document.createElement('span'), { textContent: 'audio only' }));
  return label;
}

function removeButton(domain) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'linkish';
  b.textContent = 'Remove';
  b.addEventListener('click', async () => {
    await send({ type: 'removeLimit', domain });
    await reload();
  });
  return b;
}

function renderLimits() {
  $('view-title').textContent = 'Limits';
  $('view-sub').textContent = 'One daily allowance per site, enforced until midnight';
  $('add-hint').textContent = $('add-hint').dataset.sticky
    || 'One limit per site. Subdomains share it. "Audio only" counts a site just while its tab is making sound \u2014 useful for video sites, where a focused tab is not a watched one.';

  const host = $('all-limits');
  host.innerHTML = '';
  const entries = Object.entries(snap.limits).sort(([a], [b]) => a.localeCompare(b));

  if (!entries.length) {
    host.innerHTML = '<p class="empty" style="padding:18px 0">No limits set.</p>';
  }

  entries.forEach(([domain, minutes]) => {
    const used = snap.today.totals[domain] || 0;
    const row = document.createElement('div');
    row.className = 'trow';
    row.innerHTML = `
      <span class="c-site"><span class="name">${esc(domain)}</span></span>
      <span class="c-time num">${fmtDuration(used)}</span>
      <span class="c-share">
        <input type="number" min="5" max="1440" step="5" value="${minutes}" aria-label="Daily limit for ${esc(domain)} in minutes" style="width:84px;height:34px">
        <span class="pc">min</span>
      </span>
      <span class="c-status"></span>`;

    // A spent limit is locked until midnight; the worker refuses changes too.
    const locked = snap.blocked.includes(domain);
    const input = row.querySelector('input');
    input.disabled = locked;
    input.addEventListener('change', async () => {
      const v = Math.max(5, Math.min(1440, parseInt(input.value, 10) || 5));
      input.value = String(v);
      await send({ type: 'setLimit', domain, minutes: v });
      await reload();
    });

    const tail = locked
      ? Object.assign(document.createElement('span'), {
        className: 'muted', textContent: 'Locked until 00:00', title: 'Today’s allowance is spent',
      })
      : removeButton(domain);
    row.querySelector('.c-status').append(playbackToggle(domain), tail);
    host.append(row);
  });

  const sugg = $('suggestions');
  sugg.innerHTML = '';
  const candidates = rankedSites(snap.today).filter(([d]) => !snap.limits[d]).slice(0, 6);

  if (!candidates.length) {
    sugg.innerHTML = '<p class="empty" style="padding:18px 0">Nothing else tracked today.</p>';
    return;
  }

  candidates.forEach(([domain, sec], i) => {
    const row = document.createElement('div');
    row.className = 'trow';
    row.innerHTML = `
      <span class="c-site"><span class="dot" style="background:${i < 5 ? SERIES[i] : OTHER}"></span><span class="name">${esc(domain)}</span></span>
      <span class="c-time num">${fmtDuration(sec)}</span>
      <span class="c-share"></span>
      <span class="c-status"></span>`;

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'linkish';
    add.textContent = 'Add 1h limit';
    add.addEventListener('click', async () => {
      await send({ type: 'setLimit', domain, minutes: 60 });
      await reload();
    });
    row.querySelector('.c-status').append(playbackToggle(domain), add);
    sugg.append(row);
  });
}

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  // Time is bucketed per site (m.youtube.com counts as youtube.com), so the
  // limit has to be keyed the same way or it would never trigger.
  const raw = $('add-domain').value.trim().toLowerCase();
  const typed = raw.replace(/^https?:\/\//, '').split(/[/?#]/)[0];
  const domain = registrableDomain(`https://${typed}`);
  const minutes = Math.max(5, Math.min(1440, parseInt($('add-minutes').value, 10) || 60));

  if (!domain) {
    $('add-hint').textContent = 'Enter a site like youtube.com.';
    return;
  }
  const res = await send({ type: 'setLimit', domain, minutes });
  if (res && res.error === 'locked') {
    $('add-hint').textContent = `${domain} is blocked; its limit is locked until midnight.`;
    return;
  }
  $('add-domain').value = '';
  $('add-hint').textContent = `Limit set: ${domain}, ${fmtMinutes(minutes)} a day.`
    + (typed !== domain && typed !== `www.${domain}` ? ` (${typed} is counted as part of ${domain}.)` : '');
  await reload();
});

// --- settings ----------------------------------------------------------------

function renderSettings() {
  $('view-title').textContent = 'Settings';
  $('view-sub').textContent = 'Stored in this browser profile only';

  const s = snap.settings;
  $('s-idle').value = String(s.idleSeconds);
  $('s-warn').value = String(s.warnAtPercent);
  $('s-notify').checked = !!s.notify;
  $('s-keep').value = String(s.keepDays);
  $('s-diag').checked = !!s.diagnostics;
  $('s-accurate').checked = !!s.accurate;
  $('s-media').checked = s.mediaCountsAsPresent !== false;
  $('accurate-note').textContent = s.accurate
    ? 'On \u2014 Tabtime has access to every site. Tabs opened before you enabled this may need one reload.'
    : 'Off \u2014 no page access. Falling back to window focus, which is unreliable on Wayland.';
}

async function patch(key, value) {
  const res = await send({ type: 'patchSettings', patch: { [key]: value } });
  snap.settings = res.settings;
  $('idle-label').textContent = String(snap.settings.idleSeconds);
}

$('s-idle').addEventListener('change', (e) => patch('idleSeconds', Number(e.target.value)));
$('s-warn').addEventListener('change', (e) => patch('warnAtPercent', Number(e.target.value)));
$('s-notify').addEventListener('change', (e) => patch('notify', e.target.checked));
$('s-keep').addEventListener('change', (e) => patch('keepDays', Number(e.target.value)));
$('s-diag').addEventListener('change', (e) => patch('diagnostics', e.target.checked));
$('s-media').addEventListener('change', (e) => patch('mediaCountsAsPresent', e.target.checked));

// permissions.request() needs a real user gesture and must run in a page, not
// in the service worker -- so it happens here and the worker is told after.
$('s-accurate').addEventListener('change', async (e) => {
  const on = e.target.checked;
  const note = $('accurate-note');

  if (on) {
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: ['*://*/*'] });
    } catch { granted = false; }
    if (!granted) {
      e.target.checked = false;
      note.textContent = 'Page access declined, so accurate tracking stays off.';
      return;
    }
  } else {
    try { await chrome.permissions.remove({ origins: ['*://*/*'] }); } catch { /* ignore */ }
  }

  const res = await send({ type: 'setAccurate', on });
  snap.settings = res.settings;
  e.target.checked = !!res.settings.accurate;
  note.textContent = res.settings.accurate
    ? 'On \u2014 Tabtime has access to every site. Tabs opened before you enabled this may need one reload.'
    : 'Off \u2014 no page access. Falling back to window focus, which is unreliable on Wayland.';
  await reload();
});

$('export').addEventListener('click', () => {
  const lines = ['date,domain,seconds,minutes'];
  for (const rec of history) {
    for (const [domain, sec] of rankedSites(rec)) {
      lines.push(`${rec.date},${domain},${Math.round(sec)},${(sec / 60).toFixed(1)}`);
    }
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tabtime-${snap.today.date}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('wipe').addEventListener('click', async () => {
  const note = $('wipe-note');
  if ($('wipe').dataset.armed !== '1') {
    $('wipe').dataset.armed = '1';
    $('wipe').textContent = 'Click again to confirm';
    note.textContent = 'This deletes every recorded day and the diagnostics log. Your limits and settings are kept, and so is today’s time on sites blocked right now.';
    setTimeout(() => {
      $('wipe').dataset.armed = '0';
      $('wipe').textContent = 'Delete all history';
      note.textContent = '';
    }, 5000);
    return;
  }
  const res = await send({ type: 'clearData' });
  $('wipe').dataset.armed = '0';
  $('wipe').textContent = 'Delete all history';
  note.textContent = `Deleted ${res.cleared} ${res.cleared === 1 ? 'day' : 'days'}.`;
  await reload();
});

// --- view switching ----------------------------------------------------------

function setView(next) {
  view = next;
  document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('on', b.dataset.view === next));
  ['today', 'history', 'limits', 'settings'].forEach((v) => { $(`view-${v}`).hidden = v !== next; });
  $('topbar-actions').innerHTML = '';
  paint();
}

document.querySelectorAll('.nav').forEach((b) => {
  b.addEventListener('click', () => setView(b.dataset.view));
});
$('go-limits').addEventListener('click', () => setView('limits'));

function paint() {
  if (view === 'today') renderToday();
  else if (view === 'history') renderHistory();
  else if (view === 'limits') renderLimits();
  else renderSettings();
}

async function reload() {
  snap = await send({ type: 'snapshot' });
  const res = await send({ type: 'history' });
  history = (res.days || []).filter((d) => sumTotals(d) > 0);
  $('idle-label').textContent = String(snap.settings.idleSeconds);
  paint();
}

reload();
setInterval(reload, 30_000);
