// calendarMath.js — the pure arithmetic behind the Calendar page (pages/calendar.js):
// the month grid, which days an event or reminder covers, and the "Add to Google
// Calendar" link. No Dexie, no DOM, so it's tested directly (tests/calendarMath.test.js).
//
// Every date here is a date-only 'YYYY-MM-DD' string (CLAUDE.md data conventions),
// compared lexicographically; a month is 'YYYY-MM'. Weeks start on Sunday.
import { addDaysToYMD } from './dateUtils.js';

export const monthOf = (ymd) => String(ymd).slice(0, 7);

// 'YYYY-MM' n months away (n may be negative).
export function shiftMonth(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function isMonth(s) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s ?? ''));
}

// The cells of a month laid out Sunday-first: a 'YYYY-MM-DD' per day, padded with
// nulls before the 1st and after the last day so the length is a multiple of 7.
export function monthGridDates(month) {
  const [y, m] = month.split('-').map(Number);
  const total = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const cells = Array(firstWeekday).fill(null);
  for (let d = 1; d <= total; d += 1) cells.push(`${month}-${String(d).padStart(2, '0')}`);
  while (cells.length % 7) cells.push(null);
  return cells;
}

// Short weekday names in the reader's locale, Sunday first. 2026-01-04 is a Sunday.
export const weekdayHeads = () => Array.from({ length: 7 }, (_, i) =>
  new Date(Date.UTC(2026, 0, 4 + i)).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }));

// The [start, end] days an event covers on the calendar. A `span` type with an
// event_end_date runs through it; an open-ended span (ongoing heat cycle,
// medication, boarding) is drawn on its start day only — drawing it up to today
// would smear a years-old unclosed record across every month since.
export function eventSpan(ev, duration) {
  const start = ev.event_date;
  const end = duration === 'span' && ev.event_end_date && ev.event_end_date > start ? ev.event_end_date : start;
  return [start, end];
}

// Bucket calendar items (each carrying `start`/`end` days) into the days of
// `month` they touch: Map<'YYYY-MM-DD', item[]>, each day's list in input order.
// A span is clipped to the month, so a stay crossing month-end shows on both.
export function bucketByDay(items, month) {
  const first = `${month}-01`;
  const last = monthGridDates(month).filter(Boolean).pop();
  const byDay = new Map();
  for (const item of items) {
    if (!item.start || item.end < first || item.start > last) continue;
    let day = item.start < first ? first : item.start;
    const stop = item.end > last ? last : item.end;
    for (let guard = 0; day <= stop && guard < 31; guard += 1) {
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(item);
      day = addDaysToYMD(day, 1);
    }
  }
  return byDay;
}

// Google Calendar's "create event" template link for an all-day item. Nothing is
// sent anywhere until the user clicks it; Google then shows a prefilled event they
// still have to save. All-day because event times are free text (placement_time,
// dropoff_time, ring_time), not something we can parse reliably. Google's all-day
// end date is exclusive, hence the +1 day.
export function googleCalendarUrl({ title, start, end = start, details = '', location = '' }) {
  const ymd = (s) => s.replace(/-/g, '');
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${ymd(start)}/${ymd(addDaysToYMD(end, 1))}`
  });
  if (details) params.set('details', details);
  if (location) params.set('location', location);
  return `https://calendar.google.com/calendar/render?${params}`;
}
