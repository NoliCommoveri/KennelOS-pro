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

// The time of day in an IANA time zone, as 'HH:MM' (24-hour). No zone, or one this
// browser doesn't know: the device's own clock.
export function timeInZone(timeZone, now = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  const local = () => `${p2(now.getHours())}:${p2(now.getMinutes())}`;
  if (!timeZone) return local();
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now).map((x) => [x.type, x.value]));
    return `${p2(Number(p.hour) % 24)}:${p.minute}`;
  } catch {
    return local();
  }
}

// The moment a kennel wall time happens: `date` + `time` ('HH:MM'; none = the end of
// that day) in `timeZone` (none: the device's). → epoch ms, or null with no date. What
// the waitlist countdowns tick toward; the Worker's serverMoves.zonedInstant is a copy.
export function zonedInstant(date, time, timeZone = null) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''));
  if (!m) return null;
  const t = typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : '24:00';
  const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(t.slice(0, 2)), Number(t.slice(3))];
  if (!timeZone) return new Date(y, mo, d, h, mi).getTime();
  const wall = Date.UTC(y, mo, d, h, mi);
  const offset = (ts) => {
    const at = new Date(ts);
    const [ld, lt] = [dayInZone(timeZone, at), timeInZone(timeZone, at)];
    const [a, b, c] = ld.split('-').map(Number);
    return Date.UTC(a, b - 1, c, Number(lt.slice(0, 2)), Number(lt.slice(3))) - Math.floor(ts / 60000) * 60000;
  };
  return wall - offset(wall - offset(wall));
}

// How long until `at` (epoch ms) from `now`, in words for a countdown: '2 days 4 hr',
// '5 hr 12 min', '12:04' in the last hour (minutes:seconds), '' once it's passed.
export function countdownText(at, now = Date.now()) {
  const left = Math.floor((at - now) / 1000);
  if (!(left > 0)) return '';
  const d = Math.floor(left / 86400);
  const h = Math.floor((left % 86400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  if (d > 0) return `${d} day${d === 1 ? '' : 's'}${h ? ` ${h} hr` : ''}`;
  if (h > 0) return `${h} hr${m ? ` ${m} min` : ''}`;
  return `${m}:${String(left % 60).padStart(2, '0')}`;
}

// The kennel's own now, { date: 'YYYY-MM-DD', time: 'HH:MM' }, on the same clock as
// kennelToday: what a waitlist deadline at a time of day (Waitlist Timers plan) is
// set from and compared against.
export const kennelNow = (kennel, now = new Date()) => ({ date: kennelToday(kennel, now), time: timeInZone(kennel?.time_zone || null, now) });

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
