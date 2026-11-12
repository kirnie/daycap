import { test, eq, near } from './harness.js';
import { hourSlices, creditRecord, creditEnd, blockedSet, slimDay, cutoffKey } from '../src/lib/accrual.js';
import { dayKey, sumTotals } from '../src/lib/time.js';

const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const blank = (date) => ({ date, totals: {}, hours: {}, blocked: {}, warned: {} });

test('accrual: a span inside one hour is one slice', () => {
  const s = at(2026, 5, 4, 10, 10);
  const e = at(2026, 5, 4, 10, 40);
  eq(hourSlices(s, e), [[s, e]]);
  eq(hourSlices(e, s), []);
  eq(hourSlices(s, s), []);
});

test('accrual: a span is split on every hour boundary', () => {
  const s = at(2026, 5, 4, 10, 50);
  const e = at(2026, 5, 4, 12, 5);
  eq(hourSlices(s, e), [
    [s, at(2026, 5, 4, 11)],
    [at(2026, 5, 4, 11), at(2026, 5, 4, 12)],
    [at(2026, 5, 4, 12), e],
  ]);
});

test('accrual: a span crossing midnight lands in both days', () => {
  const s = at(2026, 5, 4, 23, 50);
  const e = at(2026, 5, 5, 0, 20);
  const days = {};
  for (const [from, to] of hourSlices(s, e)) {
    const key = dayKey(from);
    days[key] = days[key] || blank(key);
    creditRecord(days[key], 'example.com', from, to);
  }
  near(days['2026-05-04'].totals['example.com'], 600);
  near(days['2026-05-04'].hours[23], 600);
  near(days['2026-05-05'].totals['example.com'], 1200);
  near(days['2026-05-05'].hours[0], 1200);
});

test('accrual: hours hold a total, never a per-site breakdown', () => {
  const rec = blank('2026-05-04');
  creditRecord(rec, 'a.com', at(2026, 5, 4, 9, 0), at(2026, 5, 4, 9, 10));
  creditRecord(rec, 'b.com', at(2026, 5, 4, 9, 10), at(2026, 5, 4, 9, 25));
  eq(rec.hours, { 9: 1500 });
  eq(rec.totals, { 'a.com': 600, 'b.com': 900 });
  eq(Object.keys(rec).sort(), ['blocked', 'date', 'hours', 'totals', 'warned']);
  eq(creditRecord(rec, 'a.com', 5000, 5000), 0);
  eq(creditRecord(rec, 'a.com', 5000, 4000), 0);
  near(sumTotals(rec), 1500);
});

test('accrual: credit is capped after a suspend or a closed browser', () => {
  const heartbeat = at(2026, 5, 4, 10, 0);
  const grace = 150_000;
  // ordinary tick, 30s later: credited in full
  eq(creditEnd({ heartbeat }, heartbeat + 30_000, grace), heartbeat + 30_000);
  // machine slept for eight hours: only the grace is credited
  eq(creditEnd({ heartbeat }, heartbeat + 8 * 3600_000, grace), heartbeat + grace);
});

test('accrual: blocked is derived from the live limit', () => {
  const rec = { totals: { 'a.com': 1800, 'b.com': 1799, 'c.com': 9999 } };
  eq([...blockedSet(rec, { 'a.com': 30, 'b.com': 30, 'd.com': 10 })], ['a.com']);
  eq([...blockedSet(rec, { 'a.com': 31 })], []);        // raising a limit lifts it
  eq([...blockedSet(rec, { 'a.com': 0 })], []);
  eq([...blockedSet(rec, {})], []);
});

test('accrual: old records lose their timeline and per-site hours', () => {
  const legacy = {
    date: '2026-05-04',
    totals: { 'a.com': 700, 'b.com': 300 },
    hours: { 'a.com': { 9: 400, 10: 300 }, 'b.com': { 9: 300 } },
    sessions: [{ d: 'a.com', s: 1, e: 2 }],
    blocked: { 'a.com': 123 },
    warned: {},
  };
  const slim = slimDay(legacy);
  eq(slim.hours, { 9: 700, 10: 300 });
  eq(slim.totals, legacy.totals);
  eq(slim.blocked, { 'a.com': 123 });
  eq('sessions' in slim, false);
  eq(slimDay(slim), slim);   // already-slim records pass through unchanged
});

test('accrual: retention cutoff counts calendar days', () => {
  const now = at(2026, 3, 10, 15);
  eq(cutoffKey(1, now), '2026-03-10');
  eq(cutoffKey(30, now), '2026-02-09');
  eq(cutoffKey(365, now), '2025-03-11');
});
