// awayBoard.js — union of "away from home" rows from two sources: boarding
// events (Event.event_type === 'boarding') and in-person stud services
// (Data Integrity Brief §5). Normalizes both to one view-model so board.js,
// today.js, and dashboard.js render/count them together without knowing
// which table a row came from. Boarding events stay for non-stud reasons
// (grow-out, foster, owner travel, …) — only the stud-reason duplicate goes
// away: one row per physical trip now, sourced from whichever table owns it.
import { eventRepo } from './eventRepo.js';
import { studServiceRepo } from './studServiceRepo.js';

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

// Sorted soonest-return-first, open-ended stays last — same ordering
// eventRepo.getBoardRows() used before the union.
export async function getAwayBoardRows() {
  const [boarding, stud] = await Promise.all([
    eventRepo.getBoardRows(),
    studServiceRepo.getBoardRows()
  ]);
  const rows = [...boarding.map(fromBoardingEvent), ...stud];
  return rows.sort((a, b) => {
    if (!a.returnDate && !b.returnDate) return 0;
    if (!a.returnDate) return 1;
    if (!b.returnDate) return -1;
    return a.returnDate < b.returnDate ? -1 : 1;
  });
}
