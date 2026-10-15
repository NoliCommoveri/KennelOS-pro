// studRules.js — what a stud service means for the breedings and puppies around
// it (pure; no reads or writes). Read by Today's nudges, the Pairing page, Kels's
// tidy-up and the Dog page, so they agree.
//
// Which dog is the stud isn't stored: it's our dog's sex (`ourRole`: male → our
// stud, female → our dam; the partner's sex when ours has none). `direction` is
// only who travels (vocab STUD_SERVICE_DIRECTION).
//
// With OUR STUD on somebody else's dam, the breeding (Pairing) can still be
// recorded and linked, but the litter is the dam's owner's: nothing asks her to
// record it (`ourStudPairingIds`). When the fee includes a pick of the litter, the
// pick puppy is ours: from 63 days (whelping) + 56 days (ready to leave) after the
// service, Today asks whether it's ready to add to her dogs (`pickDue`), until a
// puppy of that stud out of that dam is on file or the pick is settled.
import { addDaysToYMD } from './dateUtils.js';

export const PICK_FEE_STRUCTURES = ['pick_of_litter', 'flat_plus_pick'];
export const WHELP_DAYS = 63;
export const READY_DAYS = 56;
// pick_status is free text ("pending / claimed" suggested); these end the
// reminder: she has the pick, or isn't getting one ('waived', Today's "Not getting one").
const PICK_SETTLED = ['claimed', 'received', 'picked', 'done', 'waived'];

const ymd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');

// `dogs`: a Map of id → dog, or an array of dogs.
const lookup = (dogs) => (dogs instanceof Map ? dogs : new Map((dogs || []).map((d) => [d.id, d])));

// Our dog's part: 'stud' | 'dam' | null (neither dog has a sex on file).
export function ourRole(s, dogs) {
  const byId = lookup(dogs);
  const ours = byId.get(s?.our_dog_id)?.sex;
  if (ours === 'male') return 'stud';
  if (ours === 'female') return 'dam';
  const theirs = byId.get(s?.partner_dog_id)?.sex;
  if (theirs === 'female') return 'stud';
  if (theirs === 'male') return 'dam';
  return null;
}

// The breeding's two dogs. → { sireId, damId }, or null when the role isn't known.
export function studParents(s, dogs) {
  const role = ourRole(s, dogs);
  if (role === 'stud') return { sireId: s.our_dog_id, damId: s.partner_dog_id };
  if (role === 'dam') return { sireId: s.partner_dog_id, damId: s.our_dog_id };
  return null;
}

// The dog that travels: ours (to_partner), theirs (to_us), or null (shipped).
export const travellingDogId = (s) => (s?.direction === 'to_partner' ? s.our_dog_id : s?.direction === 'to_us' ? s.partner_dog_id : null);

// Pairing ids linked to a live stud service where our dog is the stud. → Set
export function ourStudPairingIds(services, dogs) {
  const byId = lookup(dogs);
  return new Set((services || []).filter((s) => s && !s.is_archived && s.pairing_id && ourRole(s, byId) === 'stud').map((s) => s.pairing_id));
}

// The date the service finished, for counting to the pick: returned, else sent. → YMD or null
export const serviceDate = (s) => (ymd(s?.returned_date) ? s.returned_date : ymd(s?.sent_date) ? s.sent_date : null);

// When the pick puppy should be ready: the service date + 63 + 56 days. → YMD or null
export const pickReadyDate = (s) => (serviceDate(s) ? addDaysToYMD(serviceDate(s), WHELP_DAYS + READY_DAYS) : null);

// A puppy of this stud out of this dam, born on or after the service: the pick is on file.
export const pickPupOnFile = (s, dogs) => (dogs || []).some((d) => !d.pedigree_only
  && d.sire_id === s.our_dog_id && d.dam_id === s.partner_dog_id
  && (!ymd(d.date_of_birth) || !serviceDate(s) || d.date_of_birth >= serviceDate(s)));

// A completed stud service of our stud with a pick in its fee whose pick should be
// ready by `today`, not yet on file or settled. `dogs`: every dog (archived too).
export function pickDue(s, dogs, today) {
  if (!s || s.is_archived || s.status !== 'completed' || ourRole(s, dogs) !== 'stud') return false;
  if (!PICK_FEE_STRUCTURES.includes(s.fee_structure) || !s.our_dog_id || !s.partner_dog_id) return false;
  if (PICK_SETTLED.includes(String(s.pick_status || '').trim().toLowerCase())) return false;
  const ready = pickReadyDate(s);
  if (!ready || today < ready) return false;
  return !pickPupOnFile(s, dogs);
}

// The new pick puppy's starting fields (the Dog page's ?pick=<stud service id>):
// ours, a puppy, sired by our stud out of her dam, the stud's breed and kennel,
// born about 63 days after the service (marked estimated, for her to correct).
export function pickPupDefaults(s, stud) {
  const born = serviceDate(s) ? addDaysToYMD(serviceDate(s), WHELP_DAYS) : '';
  return {
    sire_id: s.our_dog_id || '', dam_id: s.partner_dog_id || '',
    ...(born ? { date_of_birth: born, dob_is_estimated: true } : {}),
    status: 'puppy', ownership_type: 'owned', disposition: 'keeping',
    breed: stud?.breed || '', kennel_id: s.kennel_id || stud?.kennel_id || ''
  };
}

// --- Boarding for a stud service ----------------------------------------------------
// Whoever travels boards: ours at the partner's (to_partner), theirs with us (to_us).
// A boarding event belongs to a stud service when it's on the dog that travels, its
// reason is "Stud service", and its dates overlap the service's. No stored link: the
// match is derived, so either side can be edited first.
export const STUD_BOARDING_REASON = 'Stud service';

const isStudReason = (e) => String(e?.details?.boarding_reason || '').trim().toLowerCase() === STUD_BOARDING_REASON.toLowerCase();
// Two date spans overlap (an open end runs on; a missing start matches nothing).
const overlaps = (a1, a2, b1, b2) => ymd(a1) && ymd(b1) && a1 <= (ymd(b2) ? b2 : '9999-12-31') && b1 <= (ymd(a2) ? a2 : '9999-12-31');

// The boarding event for this stud service's trip, or null. `events`: any events.
export function studBoardingFor(s, events) {
  const dogId = travellingDogId(s);
  if (!dogId || !ymd(s?.sent_date)) return null;
  return (events || []).find((e) => e && !e.is_archived && e.event_type === 'boarding' && e.subject_type === 'dog'
    && e.subject_id === dogId && isStudReason(e)
    && overlaps(s.sent_date, s.returned_date || s.sent_date, e.event_date, e.event_end_date)) || null;
}

// The boarding event a stud service's trip starts as (the event form's prefill).
// `partner`: the partner contact (its address is where our dog stays).
export function studBoardingPrefill(s, partner) {
  return {
    event_type: 'boarding', event_date: s.sent_date, event_end_date: s.returned_date || '',
    related_contact_id: s.partner_contact_id || '', title: STUD_BOARDING_REASON,
    details: {
      boarding_reason: STUD_BOARDING_REASON,
      location: s.direction === 'to_us' ? 'With us' : String(partner?.address || '').replace(/\s*\n+\s*/g, ', ').trim()
    }
  };
}

// A stud service whose trip's boarding has ended (its end date before `today`) and
// the service doesn't say so yet: the dates differ, or it's still arranged / in
// progress. → { boarding, changes } (what "Update it" writes) or null.
export function boardingEndedUpdate(s, events, today) {
  if (!s || s.is_archived || ['cancelled', 'failed'].includes(s.status)) return null;
  const b = studBoardingFor(s, events);
  if (!b || !ymd(b.event_end_date) || b.event_end_date >= today) return null;
  const changes = {};
  if (s.returned_date !== b.event_end_date) changes.returned_date = b.event_end_date;
  if (s.sent_date !== b.event_date) changes.sent_date = b.event_date;
  if (['arranged', 'in_progress'].includes(s.status)) changes.status = 'completed';
  return Object.keys(changes).length ? { boarding: b, changes } : null;
}

// --- Our dam's stud fee ---------------------------------------------------------------
// Our stud's fee is income, read from the service (incomeView). Our dam's is money we
// pay: when her service is completed with a fee and no expense records it yet
// (expenses.stud_service_id), saving it offers to log one (`studFeeExpense`).

// `expenses`: the expenses already linked to this service. → boolean
export function studFeeExpenseDue(s, dogs, expenses = []) {
  if (!s || s.is_archived || s.status !== 'completed' || ourRole(s, dogs) !== 'dam') return false;
  if (!(Number(s.fee_amount) > 0)) return false;
  return !(expenses || []).some((e) => e && !e.is_archived);
}

// The expense: Stud fee, the fee, on the linked breeding (else our dam), dated the
// service's end (else its start, else `today`), the partner as vendor.
export function studFeeExpense(s, partner, today) {
  return {
    subject_type: s.pairing_id ? 'pairing' : 'dog', subject_id: s.pairing_id || s.our_dog_id,
    amount: Number(s.fee_amount), category: 'stud_fee',
    expense_date: ymd(s.returned_date) ? s.returned_date : ymd(s.sent_date) ? s.sent_date : today,
    vendor: partner?.name || '', notes: 'Stud fee', stud_service_id: s.id
  };
}
