// dogCare.js — the rules behind looking after the breeding dogs: when each
// active breeding female's next heat is expected, and which breeding dogs haven't
// had this month's preventative (deworming, heartworm, flea & tick) logged. Used
// by Today's nudges (data/nudges.js), the Heat Cycles report (breedingReports.js
// heatRows) and Kels's "Check in on my dogs" (assets/dogCheckinUI.js), whose last
// step ("Any other events to log?") takes its event types, events and checks from
// here; the litter check-in's care events are built the same way. PURE: no
// db, no DOM, no clock (callers pass `today` as YYYY-MM-DD). End-State guide §19.
import { addDaysToYMD, addMonthsToYMD } from './dateUtils.js';
import { EVENT_TYPES } from './vocab.js';

// With one heat on record, the next is expected this many months after it began.
export const ONE_HEAT_INTERVAL_MONTHS = 6;
// Today starts saying a heat is coming this many days before the predicted date.
export const HEAT_NOTICE_DAYS = 30;

const DAY = 86400000;
const ymdMs = (ymd) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
const daysBetween = (a, b) => Math.round((ymdMs(b) - ymdMs(a)) / DAY);

// Active breeding dogs (not archived), optionally one sex.
export const breedingDogs = (dogs, sex = null) => (dogs || [])
  .filter((d) => isCareDog(d) && d.status === 'active_breeding' && (!sex || d.sex === sex));

// The dogs she looks after, the only ones routine care (heats, preventatives,
// Check in on my dogs, Log for several dogs, Today's reminders) ever looks at:
// owned, co-owned, leased in or leased out (never External), and never an
// External reference, Deceased or Pet home dog, archived or pedigree-only.
export const CARE_OWNERSHIP = Object.freeze(['owned', 'co_owned', 'leased_in', 'leased_out']);
export const NOT_CARE_STATUSES = Object.freeze(['external_reference', 'deceased', 'pet_home']);
export const isCareDog = (d) => Boolean(d) && !d.is_archived && !d.pedigree_only
  && CARE_OWNERSHIP.includes(d.ownership_type) && !NOT_CARE_STATUSES.includes(d.status);

// The grown dogs living with her (isCareDog): active breeding, retired, and
// for sale. The multi-dog forms list these; only active breeding dogs start ticked.
export const HOME_DOG_STATUSES = ['active_breeding', 'retired_breeding', 'for_sale'];
export const homeDogs = (dogs) => (dogs || [])
  .filter((d) => isCareDog(d) && HOME_DOG_STATUSES.includes(d.status))
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

// --- Any other events (the check-in's last step) ------------------------------------

// Every dog "Check in on my dogs" looks at: the dogs she looks after (isCareDog).
export const ownDogs = (dogs) => (dogs || []).filter(isCareDog);

// The dogs the check-in's health-test and "any other events" steps list: the
// dogs she looks after (ownDogs), a puppy only when she's keeping it. Active breeding first, then
// the other grown dogs, then kept puppies, each A→Z.
export function checkinDogs(dogs) {
  const rank = (d) => (d.status === 'active_breeding' ? 0 : d.status === 'puppy' ? 2 : 1);
  return ownDogs(dogs)
    .filter((d) => d.status !== 'puppy' || d.disposition === 'keeping')
    .sort((a, b) => rank(a) - rank(b) || (a.call_name || a.registered_name || '').localeCompare(b.call_name || b.registered_name || ''));
}

// Dog event types the check-in's "Any other events to log?" leaves out: the ones
// it asks about itself (heats, preventatives, health tests, vet visits), and the
// ones another Kels task logs (a purchase: Add dogs; a puppy going home: Pups are going home).
export const CHECKIN_OWN_TYPES = Object.freeze(['heat_cycle', 'preventative', 'genetic_test', 'ofa_pennhip', 'breed_specific_test', 'vet_visit']);
export const OTHER_TASK_TYPES = Object.freeze(['acquisition', 'placement']);

// The dog event types "Any other events to log?" offers, in vocab order: a dog's
// types, minus the two lists above, minus any whose edition flag is off (`flags`
// is editionFlags; `show` needs `shows`).
export function otherEventTypes(flags = {}) {
  return EVENT_TYPES.filter((t) => (t.subjects || []).includes('dog')
    && !CHECKIN_OWN_TYPES.includes(t.value) && !OTHER_TASK_TYPES.includes(t.value)
    && (!t.editionFlag || flags[t.editionFlag]));
}

// The field that names an event of each type, for its title when she doesn't type
// one (a vaccine, a drug, a vet visit's reason…). A type with `titleFrom` (show)
// uses that.
const NAME_KEYS = Object.freeze({
  vaccination: 'vaccine', medication: 'drug', vet_visit: 'reason', surgery: 'procedure',
  illness: 'diagnosis', injury: 'description', milestone: 'description', title_earned: 'title_abbreviation',
  boarding: 'location', evaluation: 'evaluator', abnormalities: 'type'
});
export const eventNameKey = (typeDef) => typeDef?.titleFrom || NAME_KEYS[typeDef?.value] || null;

const trimmed = (details) => Object.fromEntries(Object.entries(details || {})
  .filter(([, v]) => String(v ?? '').trim() !== '').map(([k, v]) => [k, String(v).trim()]));

// One event per dog, each a candidate for eventRepo.create. `title`: what she
// typed, else the type's naming field, else `fallbackTitle`, else the type's label.
// Blank details are dropped and the rest trimmed.
export function dogEvents({ eventType, dogIds = [], date, endDate = '', details = {}, title = '', fallbackTitle = '' }) {
  const typeDef = EVENT_TYPES.find((t) => t.value === eventType);
  const d = trimmed(details);
  const key = eventNameKey(typeDef);
  const t = String(title ?? '').trim() || (key && d[key]) || fallbackTitle || typeDef?.label || 'Event';
  return dogIds.map((id) => ({
    subject_type: 'dog', subject_id: id, event_type: eventType,
    event_date: date, ...(endDate ? { event_end_date: endDate } : {}),
    title: t, details: { ...d }
  }));
}

// What's wrong with an "other event" form, or ''. A note needs its words (the
// title); a cost, when given, must be a number of 0 or more.
export function dogEventProblem({ eventType, dogIds = [], date, endDate = '', title = '', cost = '' }) {
  if (!dogIds.length) return 'Tick at least one dog.';
  if (!date) return 'When was it? Pick a date.';
  if (endDate && endDate < date) return 'The end date is before the start.';
  if (eventType === 'note' && !String(title ?? '').trim()) return 'What\'s the note?';
  if (String(cost ?? '').trim() !== '' && !(Number(cost) >= 0)) return 'The cost should be a number, like 85 or 85.50.';
  return '';
}
