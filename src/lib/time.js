// Day keys are local-date strings, so "today" and "midnight" always mean what
// they mean on the user's wall clock -- never UTC.

export function dayKey(ms = Date.now()) {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function nextMidnight(ms = Date.now()) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
}

export function startOfHour(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), 0, 0, 0).getTime();
}

export function nextHour(ms) {
  return startOfHour(ms) + 3600_000;
}

// 18240 -> "5h 04m"; 2280 -> "38m"; 44 -> "44s"
export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const mins = Math.floor(s / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return `${h}h ${String(mins % 60).padStart(2, '0')}m`;
}

// Same, but always minutes-first for limit fields: 120 -> "2h 00m"
export function fmtMinutes(minutes) {
  const m = Math.max(0, Math.round(minutes));
  if (m === 0) return 'Off';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function fmtClock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtLongDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long',
  });
}

export function prevDayKey(ms = Date.now()) {
  const d = new Date(ms);
  return dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1).getTime());
}

export function sumTotals(rec) {
  return Object.values((rec && rec.totals) || {}).reduce((a, b) => a + b, 0);
}
