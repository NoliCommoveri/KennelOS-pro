// dateUtils.js — the single implementation of "what is today" as a date-only
// YYYY-MM-DD string (CLAUDE.md: date-only fields compare lexicographically as
// local calendar strings; only created_at/updated_at are full ISO/UTC). Lives
// in the data layer so both repos and assets/ui.js (which re-exports todayYMD
// for pages) share one definition instead of four independent copies.
//
// Deliberately LOCAL time (getFullYear/getMonth/getDate), not UTC — "today"
// should match the breeder's own wall clock, not a server's.
export function formatYMD(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function todayYMD() {
  return formatYMD(new Date());
}

// n days from today (negative = past) — sample-data dates that should stay
// "still relevant" regardless of when the packet is seeded.
export function daysFromToday(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return formatYMD(d);
}

// n months from today — same purpose, coarser grain.
export function monthsFromToday(n) {
  const d = new Date();
  d.setMonth(d.getMonth() + n);
  return formatYMD(d);
}

// n days after a given YYYY-MM-DD date string (negative = before) — used to
// prefill a derived date field from an anchor date the user already entered
// (e.g. a litter's estimated ready date from its whelp date, or a pairing's
// expected due date from its planned first date). Parses as local calendar
// components, not UTC, matching todayYMD's local-time convention above.
export function addDaysToYMD(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + n);
  return formatYMD(date);
}

// Whole months between two YYYY-MM-DD strings (fromYMD earlier, toYMD later),
// day-of-month aware — used by the promote-lifecycle nudge (Data Integrity
// Brief §4.3) to turn date_of_birth into an age threshold can compare against.
export function monthsBetween(fromYMD, toYMD) {
  const [fy, fm, fd] = fromYMD.split('-').map(Number);
  const [ty, tm, td] = toYMD.split('-').map(Number);
  let months = (ty - fy) * 12 + (tm - fm);
  if (td < fd) months -= 1;
  return months;
}
