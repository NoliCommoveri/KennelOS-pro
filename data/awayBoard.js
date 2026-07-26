// awayBoard.js — union of "away from home" rows from two sources: boarding
// events (Event.event_type === 'boarding') and in-person stud services
// (Data Integrity Brief §5). Normalizes both to one view-model so board.js,
// today.js, and dashboard.js render/count them together without knowing
// which table a row came from. Boarding events stay for non-stud reasons
// (grow-out, foster, owner travel, …) — only the stud-reason duplicate goes
// away: one row per physical trip now, sourced from whichever table owns it.
import { eventRepo } from './eventRepo.js';
import { studServiceRepo } from './studServiceRepo.js';
import { dogRepo } from './dogRepo.js';
import { isScoped, subjectInScope } from './kennelScope.js';

function fromBoardingEvent(ev) {
  const d = ev.details || {};
  return {
    dogId: ev.subject_id,
    location: d.location || '',
    reason: d.boarding_reason || '',
    contactId: ev.related_contact_id || null,
    outDate: ev.event_date,
    returnDate: ev.event_end_date || null,
    dropoffTime: d.dropoff_time || '',
    pickupTime: d.pickup_time || '',
    sourceType: 'boarding_event',
    sourceId: ev.id,
    href: `dog.html?id=${encodeURIComponent(ev.subject_id)}`
  };
}

// Active-kennel scope (Multi-Kennel Scope Spec §7), applied HERE rather than in
// each of the three renderers (board.js, today.js, dashboard.js) so they cannot
// disagree about who is away. Both row kinds normalize to a `dogId`, and the dog
// is what is physically away — so both are scoped the same way, through that dog.
// A dog you don't own is scope-transparent (an outside stud boarding with you
// belongs to no kennel of yours and must not vanish under a scope).
//
// Costs one extra read, and only when there IS a scope: unscoped — all of Lite,
// and "All kennels" in Pro — this returns the rows untouched without loading dogs.
async function scopeRows(rows) {
  if (!isScoped() || !rows.length) return rows;
  const dogs = await dogRepo.getAll({ includeArchived: true });
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  return rows.filter((r) => subjectInScope('dog', r.dogId, { dog: dogsById }));
}

// Sorted soonest-return-first, open-ended stays last — same ordering
// eventRepo.getBoardRows() used before the union.
export async function getAwayBoardRows() {
  const [boarding, stud] = await Promise.all([
    eventRepo.getBoardRows(),
    studServiceRepo.getBoardRows()
  ]);
  const rows = await scopeRows([...boarding.map(fromBoardingEvent), ...stud]);
  return rows.sort((a, b) => {
    if (!a.returnDate && !b.returnDate) return 0;
    if (!a.returnDate) return 1;
    if (!b.returnDate) return -1;
    return a.returnDate < b.returnDate ? -1 : 1;
  });
}
