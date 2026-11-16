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

// Today in an IANA time zone ('America/Chicago'), as YYYY-MM-DD. No zone, or one
// this browser doesn't know: the device's own date (todayYMD).
export function dayInZone(timeZone, now = new Date()) {
  if (!timeZone) return formatYMD(now);
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  } catch {
    return formatYMD(now);
  }
}

// The kennel's own today (Kennel.time_zone, set when its waitlist goes online),
// else the device's. The waitlist's deadlines (turns, fees, "Ready now?") are set
// and read on it, as the Worker and the family's page read them (decision D11);
// everything else in the app keeps the device's date.
export const kennelToday = (kennel, now = new Date()) => dayInZone(kennel?.time_zone || null, now);

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

// Days of the week, 0 = Sunday … 6 = Saturday (Date.getDay).
export const ALL_WEEKDAYS = Object.freeze([0, 1, 2, 3, 4, 5, 6]);

// n OPEN days after (or, n < 0, before) a YYYY-MM-DD date: only the weekdays she's
// open and not her closed dates are counted, so the result never lands on a closed
// day (Saturday closed: Friday + 3 open days = Tuesday, counting Sun, Mon, Tue).
// `calendar` is a weekday list, or { weekdays, closed } with closed YYYY-MM-DD
// dates (waitlistRules.businessDays). n = 0 returns the date itself. Every day open
// and no closed dates (the default) is plain addDaysToYMD.
export function addOpenDays(ymd, n, calendar = ALL_WEEKDAYS) {
  const cal = Array.isArray(calendar) ? { weekdays: calendar, closed: [] } : (calendar || {});
  const open = new Set(Array.isArray(cal.weekdays) && cal.weekdays.length ? cal.weekdays : ALL_WEEKDAYS);
  const closed = new Set(Array.isArray(cal.closed) ? cal.closed : []);
  const days = Math.round(Number(n) || 0);
  if (!ymd || !days || (open.size === 7 && !closed.size)) return ymd ? addDaysToYMD(ymd, days) : ymd;
  const step = days < 0 ? -1 : 1;
  const weekday = (x) => { const [y, m, d] = x.split('-').map(Number); return new Date(y, m - 1, d).getDay(); };
  let left = Math.abs(days);
  let at = ymd;
  while (left > 0) {
    at = addDaysToYMD(at, step);
    if (open.has(weekday(at)) && !closed.has(at)) left--;
  }
  return at;
}

// n calendar months after a YYYY-MM-DD date. A day the target month doesn't have
// lands on its last day (Jan 31 + 1 month = Feb 28/29), never spilling into the
// month after the way Date.setMonth does. Local calendar components, like above.
export function addMonthsToYMD(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const target = new Date(y, m - 1 + n, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d, last));
  return formatYMD(target);
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
