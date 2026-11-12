import { test, eq } from './harness.js';
import { installChrome } from './harness.js';
import { getDay, getDays, listDayKeys, pruneDays, migrate, getSettings, setLimit } from '../src/lib/store.js';

const at = (y, mo, d, h = 12) => new Date(y, mo - 1, d, h).getTime();
const day = (date, sec = 60) => ({ date, totals: { 'a.com': sec }, hours: { 9: sec }, blocked: {}, warned: {} });

test('store: privacy-relevant defaults', async () => {
  installChrome();
  const s = await getSettings();
  eq(s.diagnostics, false);
  eq(s.accurate, false);
  eq(s.keepDays, 30);
});

test('store: pruning is by calendar date, not by record count', async () => {
  // Three records only, but two of them are older than 30 days.
  const data = installChrome({
    'day:2025-11-01': day('2025-11-01'),
    'day:2026-02-08': day('2026-02-08'),
    'day:2026-02-09': day('2026-02-09'),
    'day:2026-03-10': day('2026-03-10'),
    limits: { 'a.com': 30 },
  });
  eq(await pruneDays(at(2026, 3, 10)), 2);
  eq(await listDayKeys(), ['2026-02-09', '2026-03-10']);
  eq(data.limits, { 'a.com': 30 });
  eq(await pruneDays(at(2026, 3, 10)), 0);
});

test('store: pruning honours the retention setting', async () => {
  installChrome({
    settings: { keepDays: 365 },
    'day:2025-11-01': day('2025-11-01'),
    'day:2026-03-10': day('2026-03-10'),
  });
  eq(await pruneDays(at(2026, 3, 10)), 0);
});

test('store: readers never see the old record shape', async () => {
  installChrome({
    'day:2026-03-10': {
      date: '2026-03-10', totals: { 'a.com': 90 },
      hours: { 'a.com': { 8: 90 } }, sessions: [{ d: 'a.com', s: 1, e: 2 }],
      blocked: {}, warned: {},
    },
  });
  const rec = await getDay('2026-03-10');
  eq(rec.hours, { 8: 90 });
  eq('sessions' in rec, false);
  const [again, empty] = await getDays(['2026-03-10', '2026-03-11']);
  eq(again, rec);
  eq(empty, { date: '2026-03-11', totals: {}, hours: {}, blocked: {}, warned: {} });
});

test('store: migration rewrites records, stops diagnostics and deletes its log', async () => {
  const data = installChrome({
    settings: { diagnostics: true, keepDays: 120, idleSeconds: 120 },
    diag: [{ t: '10:00:00.000', event: 'resolve', urlHead: 'https://example.com/private' }],
    limits: { 'a.com': 30 },
    'day:2026-03-10': {
      date: '2026-03-10', totals: { 'a.com': 90 },
      hours: { 'a.com': { 8: 90 } }, sessions: [{ d: 'a.com', s: 1, e: 2 }],
      blocked: {}, warned: {},
    },
  });
  eq(await migrate(), true);
  eq('diag' in data, false);
  eq(data.settings, { diagnostics: false, keepDays: 120, idleSeconds: 120 });
  eq(data['day:2026-03-10'], { date: '2026-03-10', totals: { 'a.com': 90 }, hours: { 8: 90 }, blocked: {}, warned: {} });
  eq(data.limits, { 'a.com': 30 });
  eq(await migrate(), false);   // runs once
});

test('store: a zero limit removes the limit', async () => {
  installChrome();
  eq(await setLimit('a.com', 45.4), { 'a.com': 45 });
  eq(await setLimit('a.com', 0), {});
});
