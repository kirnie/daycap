import { test, eq } from './harness.js';
import { dayKey, prevDayKey, nextMidnight, nextHour, fmtDuration, fmtMinutes, sumTotals } from '../src/lib/time.js';

const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

test('time: day keys follow the local wall clock', () => {
  eq(dayKey(at(2026, 3, 5, 0, 0, 0)), '2026-03-05');
  eq(dayKey(at(2026, 3, 5, 23, 59, 59)), '2026-03-05');
  eq(prevDayKey(at(2026, 3, 1, 12)), '2026-02-28');
  eq(prevDayKey(at(2026, 1, 1, 0, 5)), '2025-12-31');
});

test('time: next midnight and next hour', () => {
  eq(nextMidnight(at(2026, 12, 31, 23, 30)), at(2027, 1, 1));
  eq(nextHour(at(2026, 6, 1, 14, 59, 59)), at(2026, 6, 1, 15));
  eq(nextHour(at(2026, 6, 1, 14)), at(2026, 6, 1, 15));
});

test('time: duration formatting', () => {
  eq(fmtDuration(44), '44s');
  eq(fmtDuration(2280), '38m');
  eq(fmtDuration(18240), '5h 04m');
  eq(fmtDuration(-5), '0s');
  eq(fmtMinutes(0), 'Off');
  eq(fmtMinutes(45), '45m');
  eq(fmtMinutes(120), '2h 00m');
});

test('time: sumTotals tolerates a missing record', () => {
  eq(sumTotals({ totals: { a: 10, b: 5 } }), 15);
  eq(sumTotals(null), 0);
});
