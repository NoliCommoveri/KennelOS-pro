// pickupSlots.js — her pickup places and times, and what a family may book
// (docs/KennelOS_Family_Requests_Plan.md §4). Pure: no db.
//
// Kennel.pickup_locations = [{ id, label, address, notes, is_standard, show_to_families,
// miles, transport_fee }]: exactly one is her standard location (the start of every
// mileage figure; a public place near her, never her house). `miles` (one way from the
// standard location; blank = unknown, the standard itself 0) times her drive and
// works out a fee; `transport_fee` is a set fee for a pickup there (0 = free; blank =
// from the miles at her fee per mile). Litter.pickup_slots = [{ id, date, start_time,
// end_time, location_id, capacity }] — times are per litter (plan D10; stored on the
// litter rather than in a table of their own). A booking is a `placement` event on
// the pup with `details.pickup_slot_id`; a family's request waits on their entry
// (`pickup_requests`) until she approves it.
import { addDaysToYMD, addOpenDays } from './dateUtils.js';

const text = (v) => String(v ?? '').trim();
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
// A figure ≥ 0 (miles to the tenth, money to the cent), or null.
const figure = (v, places) => {
  if (v == null || String(v).trim() === '' || !Number.isFinite(Number(v)) || Number(v) < 0) return null;
  const f = 10 ** places;
  return Math.round(Number(v) * f) / f;
};

// --- Her places ----------------------------------------------------------------------

export function pickupLocations(kennel) {
  const list = Array.isArray(kennel?.pickup_locations) ? kennel.pickup_locations : [];
  const out = list.filter((l) => l && text(l.label) && text(l.address)).map((l) => ({
    id: text(l.id) || crypto.randomUUID(), label: text(l.label).slice(0, 80), address: text(l.address).slice(0, 300),
    notes: text(l.notes).slice(0, 500), is_standard: l.is_standard === true, show_to_families: l.show_to_families !== false,
    miles: figure(l.miles, 1), transport_fee: figure(l.transport_fee, 2)
  }));
  // Exactly one standard: the first marked, else the first.
  const std = out.findIndex((l) => l.is_standard);
  out.forEach((l, i) => { l.is_standard = i === (std >= 0 ? std : 0); });
  return out;
}

export const standardLocation = (kennel) => pickupLocations(kennel).find((l) => l.is_standard) || null;

// How far a place is from her standard location, one way: what she typed, the
// standard location itself 0, else null (unknown).
export const placeMiles = (place) => (place && Number.isFinite(place.miles) ? place.miles : place?.is_standard ? 0 : null);

// The transport fee for a pickup at one of her places: transportFee.placeFee.

// What's wrong with places she typed, or ''.
export function locationsProblem(rows) {
  for (const r of rows) {
    const label = text(r.label);
    const address = text(r.address);
    if (!label && !address) continue;
    if (!label) return 'Give each place a name.';
    if (!address) return `Add an address for ${label}.`;
  }
  return '';
}

// --- Her times -----------------------------------------------------------------------

const minutes = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function cleanSlots(list) {
  return (Array.isArray(list) ? list : []).filter((s) => s && YMD.test(s.date || '') && HM.test(s.start_time || '') && text(s.location_id))
    .map((s) => ({
      id: text(s.id) || crypto.randomUUID(), date: s.date, start_time: s.start_time,
      end_time: HM.test(s.end_time || '') && s.end_time > s.start_time ? s.end_time : s.start_time,
      location_id: text(s.location_id), capacity: Math.max(1, Math.round(Number(s.capacity) || 1))
    }))
    .sort((a, b) => `${a.date} ${a.start_time}`.localeCompare(`${b.date} ${b.start_time}`));
}

// "Add times": every `length`-minute time from `from` to `to` on `date`, at each
// place. → { slots, error }
export function makeSlots({ date, from, to, length = 30, locationIds = [], capacity = 1 }) {
  if (!YMD.test(date || '')) return { slots: [], error: 'Pick a date.' };
  if (!HM.test(from || '') || !HM.test(to || '')) return { slots: [], error: 'Set the first and last time.' };
  if (to <= from) return { slots: [], error: 'The end time has to be after the start time.' };
  const len = Math.round(Number(length));
  if (!(len >= 5 && len <= 480)) return { slots: [], error: 'Each time is 5 minutes to 8 hours long.' };
  if (!locationIds.length) return { slots: [], error: 'Choose at least one place.' };
  const slots = [];
  for (const location_id of locationIds) {
    for (let m = minutes(from); m + len <= minutes(to); m += len) {
      slots.push({ id: crypto.randomUUID(), date, start_time: hm(m), end_time: hm(m + len), location_id, capacity: Math.max(1, Math.round(Number(capacity) || 1)) });
    }
  }
  if (!slots.length) return { slots: [], error: 'No time fits between those times.' };
  return { slots, error: '' };
}

// New times that overlap times she already has on the same day (at any place: she can't
// be in two places at once, and two times at one place double-book it). → [{ made,
// existing }], one per overlapping pair, in the order of `made`.
export function slotConflicts(existing, made) {
  const out = [];
  for (const m of made) {
    for (const e of cleanSlots(existing)) {
      if (e.date === m.date && minutes(m.start_time) < minutes(e.end_time) && minutes(e.start_time) < minutes(m.end_time)) out.push({ made: m, existing: e });
    }
  }
  return out;
}

// A pickup's free-text time ("10:00 AM", "10:00 AM–10:30 AM", "14:30", "2pm") →
// its start as 'HH:MM', or null.
export function parseClock(value) {
  const m = /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i.exec(String(value ?? ''));
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = (m[3] || '').toLowerCase().replace(/\./g, '');
  if (!m[2] && !ap) return null; // a bare number isn't a time
  if (min > 59 || h > 23 || (ap && (h < 1 || h > 12))) return null;
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// "10:00 AM–10:30 AM".
export function timeRange(slot) {
  const f = (t) => {
    const [h, m] = t.split(':').map(Number);
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  };
  return slot.end_time && slot.end_time !== slot.start_time ? `${f(slot.start_time)}–${f(slot.end_time)}` : f(slot.start_time);
}

// How many families each time holds now: confirmed bookings (placement events with
// `details.pickup_slot_id`, not archived) and requests still waiting. → Map slot id → n
// A waiting request counts only on a record that still has an open sale (`live`,
// a test on the entry; K8-8): a family who backed out holds no time.
export function slotBookings(events, entries, { live = () => true } = {}) {
  const out = new Map();
  const add = (id) => { if (id) out.set(id, (out.get(id) || 0) + 1); };
  for (const e of events) if (!e.is_archived && e.event_type === 'placement') add(e.details?.pickup_slot_id);
  for (const en of entries) {
    if (en.is_archived || !live(en)) continue;
    for (const r of en.pickup_requests || []) if (!r.decided && r.kind === 'slot') add(r.slot_id);
  }
  return out;
}

// The times a family may book: on or after `from` (the pup's ready date, or the day
// after a training stay ends) and after today, at a place she shows families, with
// room left. Their own booking's time is always kept. → [{ id, date, start_time,
// end_time, left, location: { id, label, address, notes } }]
// `allPlaces`: every place of hers, not only those shown to families (her own booking).
// `busy` + `perMile`: her other pickups (busyWindows, without this family's own) and
// her drive time; a time too close to one of them (driveClash) is left out, or with
// `markClash` (her own booking) kept with `clash` set to that pickup.
export function familySlots({ slots, locations, bookings, from = null, today, mine = null, allPlaces = false, busy = [], perMile = 0, markClash = false }) {
  const shown = new Map(locations.filter((l) => allPlaces || l.show_to_families).map((l) => [l.id, l]));
  return cleanSlots(slots).filter((s) => shown.has(s.location_id) && s.date > today && (!from || s.date >= from))
    .map((s) => {
      const left = s.capacity - (bookings.get(s.id) || 0) + (s.id === mine ? 1 : 0);
      const l = shown.get(s.location_id);
      const clash = s.id === mine ? null : driveClash({ ...s, place_id: l.id, miles: placeMiles(l) }, busy, perMile);
      return { id: s.id, date: s.date, start_time: s.start_time, end_time: s.end_time, left, location: { id: l.id, label: l.label, address: l.address, notes: l.notes }, ...(markClash ? { clash } : {}), _clash: clash };
    })
    .filter((s) => (s.left > 0 && (markClash || !s._clash)) || s.id === mine)
    .map(({ _clash, ...s }) => s);
}

// --- Her drive (owner, 2026-11-25) ---------------------------------------------------
// Every pickup takes her there and back: `waitlist_config.pickup_minutes_per_mile`
// (default 1.5; 0 = off) for each mile, one way, from her standard location. Two
// pickups on a day at different places need the drive to one plus the drive to the
// other between them, so a time that close to one of her pickups is blacked out.

export const DRIVE_MINUTES_PER_MILE = 1.5;
export const drivePerMile = (config) => {
  const v = config?.pickup_minutes_per_mile;
  return v == null || v === '' || !Number.isFinite(Number(v)) ? DRIVE_MINUTES_PER_MILE : Math.max(0, Number(v));
};

// Where she'll be, and when, from `today` on: each pickup at one of her times (its
// time and place), each pickup or drop-off she set at a time of day (details
// start_time / end_time, and location_id or miles; a flight nanny takes her nowhere),
// and each family's request still waiting for one of her times (on a record `live`
// says still has an open sale). → [{ date, start, end (minutes), place_id | null,
// miles, label, time, dog_id | null, entry_id | null }]
export function busyWindows({ events = [], entries = [], litters = [], locations = [], today = '', live = () => true }) {
  const slots = new Map();
  for (const l of litters) for (const s of cleanSlots(l?.pickup_slots)) slots.set(s.id, s);
  const places = new Map(locations.map((l) => [l.id, l]));
  const out = [];
  const add = (date, start, end, place, extra) => out.push({
    date, start: minutes(start), end: minutes(end), place_id: place?.id || null, miles: extra.miles ?? placeMiles(place) ?? 0,
    label: place?.label || extra.label || 'a drop-off', time: timeRange({ start_time: start, end_time: end }), dog_id: extra.dog_id || null, entry_id: extra.entry_id || null
  });
  for (const e of events) {
    if (!e || e.is_archived || e.event_type !== 'placement' || !(e.event_date >= today)) continue;
    const d = e.details || {};
    const slot = d.pickup_slot_id ? slots.get(d.pickup_slot_id) : null;
    if (slot) { add(slot.date, slot.start_time, slot.end_time, places.get(slot.location_id), { dog_id: e.subject_id }); continue; }
    if (d.dropoff_method === 'Flight nanny') continue;
    const start = HM.test(d.start_time || '') ? d.start_time : parseClock(d.placement_time);
    if (!start) continue;
    const end = HM.test(d.end_time || '') && d.end_time > start ? d.end_time : start;
    const place = d.location_id ? places.get(d.location_id) : null;
    add(e.event_date, start, end, place, { miles: place ? undefined : (Number.isFinite(d.miles) ? d.miles : 0), label: text(d.location).split(',')[0], dog_id: e.subject_id });
  }
  for (const en of entries) {
    if (!en || en.is_archived || !live(en)) continue;
    for (const r of en.pickup_requests || []) {
      const slot = r && !r.decided && r.kind === 'slot' ? slots.get(r.slot_id) : null;
      if (slot && slot.date >= today) add(slot.date, slot.start_time, slot.end_time, places.get(slot.location_id), { entry_id: en.id });
    }
  }
  return out;
}

// The first of `busy` that a time ({ date, start_time, end_time, place_id, miles })
// can't fit beside: the same day, somewhere else (another place, or an address), and
// closer than perMile × (its miles + that one's) before its start or after its end.
// → that window, or null (also when perMile is 0).
export function driveClash({ date, start_time, end_time, place_id = null, miles = 0 }, busy, perMile) {
  const rate = Number(perMile);
  if (!(rate > 0) || !HM.test(start_time || '')) return null;
  const s = minutes(start_time);
  const e = HM.test(end_time || '') && end_time > start_time ? minutes(end_time) : s;
  return (busy || []).find((b) => {
    if (b.date !== date || (place_id && b.place_id === place_id)) return false;
    const gap = rate * ((Number(miles) || 0) + (Number(b.miles) || 0));
    return s < b.end + gap && b.start - gap < e;
  }) || null;
}

// Every one of `busy` a time can't fit beside (driveClash, all of them).
export function driveClashes(time, busy, perMile) {
  return (busy || []).filter((b) => driveClash(time, [b], perMile));
}

// Her open times (nobody holds a place: `bookings`, slotBookings over every litter)
// from `today` on, on every litter. → [{ id, litter_id, date, start_time, end_time,
// place_id, miles, label, time }]: what Set their pickup offers to remove when a pickup
// leaves no time to drive to them.
export function openTimes({ litters = [], locations = [], bookings = new Map(), today = '' }) {
  const places = new Map(locations.map((l) => [l.id, l]));
  return litters.flatMap((l) => cleanSlots(l?.pickup_slots).filter((s) => s.date >= today && !(bookings.get(s.id) > 0)).map((s) => {
    const p = places.get(s.location_id);
    return { id: s.id, litter_id: l.id, date: s.date, start_time: s.start_time, end_time: s.end_time, start: minutes(s.start_time), end: minutes(s.end_time),
      place_id: s.location_id, miles: placeMiles(p) ?? 0, label: p?.label || 'a place', time: timeRange(s) };
  }));
}

// "your 10:00 AM–10:30 AM pickup at Exit 12" for her screens.
export const clashText = (b) => `your ${b.time} ${b.place_id ? 'pickup' : 'drop-off'} at ${b.label}`;

// --- Rules per pickup date (Family Requests plan §4) -----------------------------------
// Litter.pickup_date_rules = [{ date, requires_list_id? , boarding? }]: on that date a
// family needs one of her extras (a training package) before they can choose a time,
// or her standard boarding applies (charged per day from when the pup could first go
// home until that date, and logged as a stay). One rule per date, never both.

export function dateRules(litter) {
  const seen = new Set();
  return (Array.isArray(litter?.pickup_date_rules) ? litter.pickup_date_rules : [])
    .filter((r) => r && YMD.test(r.date || '') && !seen.has(r.date) && (seen.add(r.date), true))
    .map((r) => (text(r.requires_list_id) ? { date: r.date, requires_list_id: text(r.requires_list_id) } : r.boarding === true ? { date: r.date, boarding: true } : null))
    .filter(Boolean);
}

export const ruleFor = (litter, date) => dateRules(litter).find((r) => r.date === date) || null;

// The rules with one date's set to `rule` ({ requires_list_id } | { boarding: true } | null).
export function withDateRule(litter, date, rule) {
  const rest = dateRules(litter).filter((r) => r.date !== date);
  return rule ? [...rest, { date, ...rule }].sort((a, b) => a.date.localeCompare(b.date)) : rest;
}

// Copy to another litter (K8-15): the rules of the dates being copied go with their
// times. A date that already has its own rule on the other litter keeps it.
// → { rules: the other litter's new pickup_date_rules, copied, kept }
export function copyDateRules(from, to, dates) {
  let rules = dateRules(to);
  let copied = 0;
  let kept = 0;
  for (const date of [...new Set(dates)]) {
    const r = ruleFor(from, date);
    if (!r) continue;
    if (ruleFor(to, date)) { kept++; continue; }
    const { date: _d, ...rule } = r;
    rules = withDateRule({ pickup_date_rules: rules }, date, rule);
    copied++;
  }
  return { rules, copied, kept };
}

const ms = (ymd) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));

// Standard boarding for a pickup on `date`: the days from `from` (the day the pup
// could first go home) up to the day before. → { days, start, end, amount } or null
// when there are none or no rate.
export function standardBoarding(from, date, rate) {
  const r = Number(rate);
  if (!from || !YMD.test(date || '') || !(r > 0)) return null;
  const days = Math.round((ms(date) - ms(from)) / 86400000);
  if (days <= 0) return null;
  return { days, start: from, end: addDaysToYMD(date, -1), amount: Math.round(days * r * 100) / 100 };
}

// The last day a family may change or cancel a booking for `date` themselves.
export const changeUntil = (date, days, openDays) => addOpenDays(date, -Math.max(0, Math.round(Number(days) || 0)), openDays);
