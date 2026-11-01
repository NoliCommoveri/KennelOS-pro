// pickupSlots.js — her pickup places and times, and what a family may book
// (docs/KennelOS_Family_Requests_Plan.md §4). Pure: no db.
//
// Kennel.pickup_locations = [{ id, label, address, notes, is_standard, show_to_families }]:
// exactly one is her standard location (the start of every mileage figure; a public
// place near her, never her house). Litter.pickup_slots = [{ id, date, start_time,
// end_time, location_id, capacity }] — times are per litter (plan D10; stored on the
// litter rather than in a table of their own). A booking is a `placement` event on
// the pup with `details.pickup_slot_id`; a family's request waits on their entry
// (`pickup_requests`) until she approves it.
import { addDaysToYMD, addOpenDays } from './dateUtils.js';

const text = (v) => String(v ?? '').trim();
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

// --- Her places ----------------------------------------------------------------------

export function pickupLocations(kennel) {
  const list = Array.isArray(kennel?.pickup_locations) ? kennel.pickup_locations : [];
  const out = list.filter((l) => l && text(l.label) && text(l.address)).map((l) => ({
    id: text(l.id) || crypto.randomUUID(), label: text(l.label).slice(0, 80), address: text(l.address).slice(0, 300),
    notes: text(l.notes).slice(0, 500), is_standard: l.is_standard === true, show_to_families: l.show_to_families !== false
  }));
  // Exactly one standard: the first marked, else the first.
  const std = out.findIndex((l) => l.is_standard);
  out.forEach((l, i) => { l.is_standard = i === (std >= 0 ? std : 0); });
  return out;
}

export const standardLocation = (kennel) => pickupLocations(kennel).find((l) => l.is_standard) || null;

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
export function slotBookings(events, entries) {
  const out = new Map();
  const add = (id) => { if (id) out.set(id, (out.get(id) || 0) + 1); };
  for (const e of events) if (!e.is_archived && e.event_type === 'placement') add(e.details?.pickup_slot_id);
  for (const en of entries) for (const r of en.pickup_requests || []) if (!r.decided && r.kind === 'slot') add(r.slot_id);
  return out;
}

// The times a family may book: on or after `from` (the pup's ready date, or the day
// after a training stay ends) and after today, at a place she shows families, with
// room left. Their own booking's time is always kept. → [{ id, date, start_time,
// end_time, left, location: { id, label, address, notes } }]
export function familySlots({ slots, locations, bookings, from = null, today, mine = null }) {
  const shown = new Map(locations.filter((l) => l.show_to_families).map((l) => [l.id, l]));
  return cleanSlots(slots).filter((s) => shown.has(s.location_id) && s.date > today && (!from || s.date >= from))
    .map((s) => {
      const left = s.capacity - (bookings.get(s.id) || 0) + (s.id === mine ? 1 : 0);
      const l = shown.get(s.location_id);
      return { id: s.id, date: s.date, start_time: s.start_time, end_time: s.end_time, left, location: { id: l.id, label: l.label, address: l.address, notes: l.notes } };
    })
    .filter((s) => s.left > 0 || s.id === mine);
}

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
