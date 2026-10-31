// dogCare.js — the rules behind looking after the breeding dogs: when each
// active breeding female's next heat is expected, and which breeding dogs haven't
// had this month's preventative (deworming, heartworm, flea & tick) logged. Used
// by Today's nudges (data/nudges.js), the Heat Cycles report (breedingReports.js
// heatRows) and Kels's "Check in on my dogs" (assets/dogCheckinUI.js). PURE: no
// db, no DOM, no clock (callers pass `today` as YYYY-MM-DD). End-State guide §19.
import { addDaysToYMD, addMonthsToYMD } from './dateUtils.js';

// With one heat on record, the next is expected this many months after it began.
export const ONE_HEAT_INTERVAL_MONTHS = 6;
// Today starts saying a heat is coming this many days before the predicted date.
export const HEAT_NOTICE_DAYS = 30;

const DAY = 86400000;
const ymdMs = (ymd) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
const daysBetween = (a, b) => Math.round((ymdMs(b) - ymdMs(a)) / DAY);

// Active breeding dogs (not archived), optionally one sex.
export const breedingDogs = (dogs, sex = null) => (dogs || [])
  .filter((d) => d && !d.is_archived && d.status === 'active_breeding' && (!sex || d.sex === sex));

// The grown dogs living with her (not archived): active breeding, retired, and
// for sale. The multi-dog forms list these; only active breeding dogs start ticked.
export const HOME_DOG_STATUSES = ['active_breeding', 'retired_breeding', 'for_sale'];
export const homeDogs = (dogs) => (dogs || [])
  .filter((d) => d && !d.is_archived && HOME_DOG_STATUSES.includes(d.status))
  .sort((a, b) => (a.status === 'active_breeding' ? 0 : 1) - (b.status === 'active_breeding' ? 0 : 1) || (a.call_name || '').localeCompare(b.call_name || ''));

// A female's heat starts: each heat_cycle event's start, once, oldest first.
// Future-dated heats count (she may log one she expects).
export function heatStarts(dogId, events) {
  return [...new Set((events || [])
    .filter((e) => e && !e.is_archived && e.subject_type === 'dog' && e.subject_id === dogId && e.event_type === 'heat_cycle' && e.event_date)
    .map((e) => e.event_date))].sort();
}

// The next heat from her starts. One heat: ONE_HEAT_INTERVAL_MONTHS after it.
// Two or more: the last start plus the average days between her starts.
// → { next, last, heats, basis: 'one' | 'average', avgDays } | null (no heats).
export function predictNextHeat(starts) {
  if (!starts?.length) return null;
  const last = starts[starts.length - 1];
  if (starts.length === 1) {
    return { next: addMonthsToYMD(last, ONE_HEAT_INTERVAL_MONTHS), last, heats: 1, basis: 'one', avgDays: null };
  }
  const gaps = starts.slice(1).map((d, i) => daysBetween(starts[i], d));
  const avgDays = Math.round(gaps.reduce((t, g) => t + g, 0) / gaps.length);
  return { next: addDaysToYMD(last, avgDays), last, heats: starts.length, basis: 'average', avgDays };
}

// Each active breeding female with a prediction: { dog, ...predictNextHeat,
// until (days from today), state: 'soon' (within HEAT_NOTICE_DAYS, or today),
// 'overdue' (the date passed with no newer heat logged), or 'later' }. Soonest first.
export function heatForecast(dogs, events, today) {
  const out = [];
  for (const dog of breedingDogs(dogs, 'female')) {
    const p = predictNextHeat(heatStarts(dog.id, events));
    if (!p) continue;
    const until = daysBetween(today, p.next);
    out.push({ dog, ...p, until, state: until < 0 ? 'overdue' : until <= HEAT_NOTICE_DAYS ? 'soon' : 'later' });
  }
  return out.sort((a, b) => a.next.localeCompare(b.next));
}

// "6 months after her heat on 2026-05-01" / "her average of 182 days between 3 heats".
export function heatBasisText(p, fmtDate = (d) => d) {
  return p.basis === 'one'
    ? `${ONE_HEAT_INTERVAL_MONTHS} months after her heat on ${fmtDate(p.last)}`
    : `her average of ${p.avgDays} days between ${p.heats} heats`;
}

// --- Monthly preventatives ------------------------------------------------------

export const monthOf = (ymd) => String(ymd || '').slice(0, 7);

// Has this dog a preventative logged in `month` (YYYY-MM)?
export function hasPreventativeIn(dogId, events, month) {
  return (events || []).some((e) => e && !e.is_archived && e.subject_id === dogId && e.subject_type === 'dog'
    && e.event_type === 'preventative' && monthOf(e.event_date) === month);
}

// The active breeding dogs (both sexes) with no preventative logged in today's month.
export function preventativeGaps(dogs, events, today) {
  const month = monthOf(today);
  return breedingDogs(dogs).filter((d) => !hasPreventativeIn(d.id, events, month))
    .sort((a, b) => (a.call_name || '').localeCompare(b.call_name || ''));
}

// "November 2026" for a YYYY-MM-DD.
export function monthName(ymd) {
  const [y, m] = String(ymd).split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
