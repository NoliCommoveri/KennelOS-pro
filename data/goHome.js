// goHome.js — a sold puppy's way home, pure (decided 2026-10-15). People record
// pickups and boarding but rarely come back to mark a sale Delivered, so this
// works out, for one puppy with a sale in progress, what's missing:
//   - 'boarding': the sale carries a deferred-pickup boarding charge, but no
//     boarding is logged for the puppy around its ready date;
//   - 'schedule': from a week before the litter's ready date, no pickup is on the
//     calendar and no boarding covers today or later;
//   - 'overdue': the pickup date has passed (nothing scheduled after it, no
//     boarding covering today) and the sale still isn't Delivered.
// Today's nudges and Kels's litter check-in both read it; the fixes are ordinary
// events (a `placement` pickup, a `boarding` span) and, for 'overdue', the Sale
// page's own Delivered save (sale.html?id=…&deliver=1), so delivery's prompts run.
import { addDaysToYMD, addMonthsToYMD } from './dateUtils.js';

export const READY_AFTER_DAYS = 56;
// Kels and Today start asking about the pickup this many days before the ready date.
export const SCHEDULE_LEAD_DAYS = 7;
// A sale far enough along to plan the pickup.
export const GO_HOME_SALE_STATUSES = ['deposit_paid', 'paid_in_full'];
export const BOARDING_TITLE = 'Deferred pickup boarding';
export const PICKUP_TITLE = 'Puppy pickup';

const ymd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');

// The litter's estimated ready date, else 8 weeks after the whelp date.
export const readyDateOf = (litter) => (ymd(litter?.estimated_ready_date) ? litter.estimated_ready_date
  : ymd(litter?.whelp_date) ? addDaysToYMD(litter.whelp_date, READY_AFTER_DAYS) : null);

// The sale whose pickup we're planning: the newest one in progress.
export function goHomeSale(sales) {
  return sales.filter((s) => !s.is_archived && GO_HOME_SALE_STATUSES.includes(s.status))
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0] || null;
}

// The sale has a deferred-pickup boarding charge.
export const hasDeferredBoarding = (sale) => Number(sale?.deferred_boarding_amount) > 0;

// How long the charged boarding runs: `deferred_boarding_duration_days` is a
// COUNT of the frequency's units ("2" × Week = two weeks; guide §4, Sale).
// → the end date for a start date, or '' when the count isn't a number.
export function boardingEnd(sale, start) {
  const n = Math.round(Number(String(sale?.deferred_boarding_duration_days ?? '').trim()));
  if (!ymd(start) || !Number.isFinite(n) || n <= 0) return '';
  const unit = String(sale.deferred_boarding_frequency || 'Day').toLowerCase();
  if (unit === 'month') return addDaysToYMD(addMonthsToYMD(start, n), -1);
  return addDaysToYMD(start, n * (unit === 'week' ? 7 : 1) - 1);
}

// "$15 per Day × 14"-style summary of the charge, for Kels and Today.
export function boardingChargeText(sale, fmtMoney = (v) => `$${v}`) {
  if (!hasDeferredBoarding(sale)) return '';
  const f = sale.deferred_boarding_frequency ? ` per ${String(sale.deferred_boarding_frequency).toLowerCase()}` : '';
  const n = String(sale.deferred_boarding_duration_days ?? '').trim();
  return `${fmtMoney(sale.deferred_boarding_amount)}${f}${n ? ` × ${n}` : ''}`;
}

// A pickup event for this sale's family: a placement event with that buyer, or
// with no contact on it (older pickups were logged without one).
const pickupFor = (sale) => (e) => !e.is_archived && e.event_type === 'placement' && ymd(e.event_date)
  && (!e.related_contact_id || !sale.buyer_contact_id || e.related_contact_id === sale.buyer_contact_id);

// What's missing on this puppy's way home, or null. `pup`: the dog; `litter`:
// its litter; `sales`: its sales; `events`: its events (any types).
// → null | { kind: 'boarding' | 'schedule' | 'overdue', sale, readyDate, pickupDate? }
export function goHomeIssue({ pup, litter, sales, events, today }) {
  if (!pup || pup.is_archived || pup.status !== 'puppy') return null;
  const sale = goHomeSale(sales);
  const readyDate = readyDateOf(litter);
  if (!sale || !readyDate) return null;
  const since = addDaysToYMD(readyDate, -SCHEDULE_LEAD_DAYS);
  if (today < since) return null;

  const live = events.filter((e) => !e.is_archived);
  // Boarding around the go-home: starts from a week before the ready date on.
  const boarding = live.filter((e) => e.event_type === 'boarding' && ymd(e.event_date) && (e.event_end_date || e.event_date) >= since);
  if (hasDeferredBoarding(sale) && !boarding.length) return { kind: 'boarding', sale, readyDate };
  // Staying on: a boarding that runs today or later (one with no end, from its start on).
  const staying = boarding.some((e) => (e.event_end_date ? e.event_end_date >= today : true));
  const pickups = live.filter(pickupFor(sale));
  if (pickups.some((e) => e.event_date >= today) || staying) return null;
  const past = pickups.map((e) => e.event_date).sort();
  if (past.length) return { kind: 'overdue', sale, readyDate, pickupDate: past[past.length - 1] };
  return { kind: 'schedule', sale, readyDate };
}

// Where a new pickup or boarding starts by default: the ready date, or today
// once that has passed.
export const defaultStart = (readyDate, today) => (readyDate && readyDate > today ? readyDate : today);

// The events Kels writes. A pickup: the family as its related contact. A
// boarding: the charge's span from `start`.
export const pickupEvent = (pup, sale, date, time = '') => ({
  subject_type: 'dog', subject_id: pup.id, event_type: 'placement', event_date: date,
  title: PICKUP_TITLE, ...(sale.buyer_contact_id ? { related_contact_id: sale.buyer_contact_id } : {}),
  details: time ? { placement_time: time } : {}
});
export const boardingEvent = (pup, start, end = '') => ({
  subject_type: 'dog', subject_id: pup.id, event_type: 'boarding', event_date: start,
  ...(end ? { event_end_date: end } : {}), title: BOARDING_TITLE, details: { boarding_reason: 'Deferred pickup' }
});
