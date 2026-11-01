// familyPickup.js — a family's pickup on their status page
// (docs/KennelOS_Family_Requests_Plan.md §4): the times they may book, their booking,
// their requests, and whether they may suggest their own place. Pure: no db.
//
// Requests wait on the entry, `pickup_requests` = [{ id, kind: 'slot' | 'address' |
// 'cancel', slot_id?, date?, start_time?, end_time?, place?, address?, miles?,
// minutes?, far?, note, requested_date, decided?, decided_date? }], newest last;
// approving one makes (or removes) the pup's pickup event
// (waitlistActions.approvePickupRequest). Where they live: `home_place` and
// `home_miles` on the entry (measured once), and `own_place_override` (true/false)
// when she decides by hand.
import { familySale } from './familyExtras.js';
import { pickupLocations, familySlots, slotBookings, changeUntil, timeRange, dateRules } from './pickupSlots.js';
import { kennelChargeList, saleExtraCharges } from './extraCharges.js';
import { readyDateOf, pickupFor } from './goHome.js';
import { addDaysToYMD } from './dateUtils.js';
import { locationRuleOn } from './waitlistForm.js';
import { businessDays } from './waitlistRules.js';

export const PICKUP_REQUESTS_KEPT = 30;
export const PICKUP_REQUEST_SHOWN_DAYS = 30;

export const pendingPickupRequests = (entry) => (Array.isArray(entry?.pickup_requests) ? entry.pickup_requests : []).filter((r) => r && !r.decided);

// May this family suggest their own meetup place? true / false, or null when her
// distance rule is on and their distance isn't known (their page asks while no
// place is known at all; with an unmeasured place she decides on their entry).
export function ownPlaceAllowed(entry, config) {
  if (typeof entry?.own_place_override === 'boolean') return entry.own_place_override;
  if (!locationRuleOn(config)) return true;
  if (Number.isFinite(entry?.home_miles)) return entry.home_miles >= Number(config.transport_min_home_miles);
  return null;
}

// The pup's booking: its next pickup event for this family (today or later).
export function upcomingPickup(sale, events, today) {
  return events.filter((e) => e.subject_id === sale.dog_id && pickupFor(sale)(e) && e.event_date >= today)
    .sort((a, b) => a.event_date.localeCompare(b.event_date))[0] || null;
}

// Where a family's times start: the pup's ready date, or the day after the last
// training stay linked to the sale ends, whichever is later.
export function pickupFrom(sale, litter, events) {
  const stays = events.filter((e) => !e.is_archived && e.event_type === 'boarding' && e.subject_id === sale.dog_id && e.details?.sale_id === sale.id && e.details?.extra_charge_id);
  const stayEnd = stays.map((e) => e.event_end_date || e.event_date).sort().pop() || null;
  const ready = readyDateOf(litter);
  const after = stayEnd ? addDaysToYMD(stayEnd, 1) : null;
  return [ready, after].filter(Boolean).sort().pop() || null;
}

// → null, or { ready_from, slots, booked, requests, own_place, ask_home, far_miles,
// min_home_miles } (the last two for the server's checks only; never on their page).
export function familyPickupView({ entry, sales, offers = [], dogsById, litters, kennel, config, entries = [], events = [], today }) {
  const sale = familySale(entry, sales, offers, entries);
  if (!sale?.dog_id) return null;
  const pup = dogsById.get(sale.dog_id);
  if (!pup) return null;
  const litter = litters.find((l) => l.id === pup.litter_id) || null;
  const locations = pickupLocations(kennel);
  const pupEvents = events.filter((e) => e.subject_id === pup.id);
  const pickup = upcomingPickup(sale, pupEvents, today);
  const mine = pickup?.details?.pickup_slot_id || null;
  const pending = pendingPickupRequests(entry);
  const pendingSlot = pending.find((r) => r.kind === 'slot')?.slot_id || null;
  const litterPups = new Set([...dogsById.values()].filter((d) => d.litter_id === pup.litter_id).map((d) => d.id));
  const bookings = slotBookings(events.filter((e) => litterPups.has(e.subject_id)), entries);
  const from = pickupFrom(sale, litter, events);
  const slots = litter ? familySlots({ slots: litter.pickup_slots, locations, bookings, from, today, mine: mine || pendingSlot }) : [];
  const days = Number(config.pickup_change_days) || 0;
  let booked = null;
  if (pickup) {
    const slot = mine ? (litter?.pickup_slots || []).find((s) => s.id === mine) : null;
    const loc = slot ? locations.find((l) => l.id === slot.location_id) : null;
    booked = {
      kind: mine ? 'slot' : 'address', date: pickup.event_date,
      start_time: slot?.start_time || '', end_time: slot?.end_time || '',
      place: loc?.label || '', address: loc?.address || pickup.details?.location || '',
      change_until: changeUntil(pickup.event_date, days, businessDays(config))
    };
  }
  const requests = (Array.isArray(entry.pickup_requests) ? entry.pickup_requests : [])
    .filter((r) => r && r.requested_date && (!r.decided || (r.decided_date && addDaysToYMD(r.decided_date, PICKUP_REQUEST_SHOWN_DAYS) >= today)))
    .map((r) => ({ id: r.id, kind: r.kind, date: r.date || null, start_time: r.start_time || '', place: r.place || '', address: r.address || '',
      miles: Number.isFinite(r.miles) ? r.miles : null, far: r.far === true, requested_date: r.requested_date, decided: r.decided || null, decided_date: r.decided_date || null }));
  // The rules on the dates they can see: a package they need first (blocked until
  // it's on their sale), or her standard boarding.
  const priceList = kennelChargeList(kennel);
  const theirs = new Set(saleExtraCharges(sale).map((c) => c.list_id).filter(Boolean));
  const shownDates = new Set(slots.map((s) => s.date));
  const dates = dateRules(litter).filter((r) => shownDates.has(r.date)).map((r) => (r.requires_list_id
    ? { date: r.date, requires: priceList.find((x) => x.id === r.requires_list_id)?.label || 'a package', has_it: theirs.has(r.requires_list_id) }
    : { date: r.date, boarding: true }));
  const own = ownPlaceAllowed(entry, config);
  // Asked only while no place is known. A place on file that couldn't be measured
  // (no map key, or not found) isn't asked again: she chooses on their entry.
  const view = {
    ready_from: from, slots, dates, booked, requests, own_place: own, ask_home: own === null && !entry.home_place,
    far_miles: Number(config.transport_far_miles) || 0, min_home_miles: Number(config.transport_min_home_miles) || 0
  };
  return slots.length || booked || requests.length || own !== false ? view : null;
}

// A request added once per id, oldest dropped past the cap.
export function withPickupRequest(entry, request) {
  const list = Array.isArray(entry?.pickup_requests) ? entry.pickup_requests : [];
  if (list.some((r) => r.id === request.id)) return null;
  return [...list, request].slice(-PICKUP_REQUESTS_KEPT);
}

// "Sat Nov 21, 10:00 AM–10:30 AM at the Library" for her screens.
export function requestText(r) {
  if (r.kind === 'cancel') return 'to cancel their pickup time';
  if (r.kind === 'address') return `to meet at ${r.address}${r.date ? ` on ${r.date}` : ''}${Number.isFinite(r.miles) ? ` (about ${Math.round(r.miles)} miles)` : ''}`;
  return `for ${r.date}${r.start_time ? `, ${timeRange({ start_time: r.start_time, end_time: r.end_time || '' })}` : ''}${r.place ? ` at ${r.place}` : ''}`;
}
