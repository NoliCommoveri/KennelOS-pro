// receivedCredits.js — a waitlist family's credits for funds already received
// (WaitlistEntry.received_credits): money she collected outside the app, e.g. an
// early deposit taken before the litter was born. Each credit is
//   { id, amount, date, method?, note?, applies_to: ['fee','deposit','price','extras'] }
// (vocab.CREDIT_USES; every use ticked by default). Nothing about how a credit is
// used is stored: it's worked out here, every time, from what the family is
// charged. Credits are used oldest first; each one pays, in order, the
// application fee, the deposit, the rest of the purchase price, boarding, extras,
// then transport last (Payment Schedule plan D16), only toward the uses it's ticked
// for. Whatever's left is their credit remaining. Pure: incomeView supplies the
// sale's charges, in that order.
import { CREDIT_USES } from './vocab.js';
import { allocateMoney } from './paymentSchedule.js';

const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
const cents = (n) => Math.round(n * 100) / 100;
export const CREDIT_USE_VALUES = CREDIT_USES.map((u) => u.value);

// Money carried from a pup they lost (Payment Schedule plan §3.2a, D20) is a credit
// like any other, with `from_sale_id` (the lost pup's sale) and a note naming it.
// Older entries hold it as `carried_payment` ({ amount, date, from_sale_id }), which
// reads as one such credit (`legacyCarried`) until a write moves it into
// received_credits (`creditsWithCarried`). Only putting the family back on the list
// carries money; a refund carries nothing.
const LEGACY_NOTE = 'Carried over from a pup they lost';
function legacyCarried(entry) {
  const c = entry?.carried_payment;
  if (!c || !(num(c.amount) > 0)) return null;
  return { id: `carried-${c.from_sale_id || 'legacy'}`, amount: cents(num(c.amount)), date: c.date || '', note: LEGACY_NOTE,
    ...(c.from_sale_id ? { from_sale_id: c.from_sale_id } : {}), applies_to: [...CREDIT_USE_VALUES] };
}

// The entry's stored credits plus an older carried_payment as one: what to write back
// as received_credits (with carried_payment: null) whenever the entry's credits change.
export function creditsWithCarried(entry) {
  const list = Array.isArray(entry?.received_credits) ? entry.received_credits : [];
  const old = legacyCarried(entry);
  return old && !list.some((c) => c && c.id === old.id) ? [...list, old] : list;
}

// The credit for money carried from a lost pup's sale. `pupName` names it.
export function carriedCredit({ amount, date, fromSaleId, pupName = '' }) {
  return { ...newCredit({ amount, date, note: pupName ? `Carried over from ${pupName}'s sale` : LEGACY_NOTE }), from_sale_id: fromSaleId };
}

// The entry's credits carried from a pup they lost (oldest first).
export const carriedCreditsOf = (entry) => creditsOf(entry).filter((c) => c.from_sale_id);

// The entry's valid credits, oldest first.
export function creditsOf(entry) {
  return creditsWithCarried(entry)
    .filter((c) => c && c.id && num(c.amount) > 0)
    .map((c) => ({ ...c, amount: num(c.amount), applies_to: Array.isArray(c.applies_to) ? c.applies_to.filter((u) => CREDIT_USE_VALUES.includes(u)) : [...CREDIT_USE_VALUES] }))
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.id.localeCompare(b.id));
}

export const creditTotal = (entry) => cents(creditsOf(entry).reduce((t, c) => t + c.amount, 0));

// A new credit record (every use ticked unless she unticked some).
export function newCredit({ amount, date, method = '', note = '', applies_to = CREDIT_USE_VALUES }) {
  const a = num(amount);
  if (!(a > 0)) throw new Error('Enter the amount already received.');
  if (!date) throw new Error('Enter the date it was received.');
  const uses = (applies_to || []).filter((u) => CREDIT_USE_VALUES.includes(u));
  if (!uses.length) throw new Error('Tick at least one thing the credit can pay toward.');
  return { id: crypto.randomUUID(), amount: cents(a), date, ...(method ? { method } : {}), ...(note ? { note } : {}), applies_to: uses };
}

// The application fee as a charge a credit can pay: the whole fee while it's
// unpaid; once she's marked it received, only the part a credit paid then
// (entry.fee_credit_amount) — a fee she was paid in full some other way takes
// no credit.
export function feeCharge(entry) {
  const fee = num(entry?.fee_amount);
  if (!(fee > 0)) return [];
  const cap = entry.fee_received_date ? Math.min(num(entry.fee_credit_amount), fee) : fee;
  return cap > 0 ? [{ key: 'fee', use: 'fee', amount: cap }] : [];
}

// Spread the credits over the charges ([{ key, use, amount }], in order).
// → { byKey: { key: credited }, total, applied, remaining, perCredit: { id: applied } }
// The same allocator the sale's payment statement uses (paymentSchedule.allocateMoney).
export function allocateCredits(credits, charges) {
  const { byKey, perItem, applied } = allocateMoney(credits.map((cr) => ({ id: cr.id, amount: cr.amount, uses: cr.applies_to })), charges);
  const perCredit = Object.fromEntries(credits.map((cr) => [cr.id, cents((perItem[cr.id] || []).reduce((t, p) => t + p.amount, 0))]));
  const total = cents(credits.reduce((t, c) => t + c.amount, 0));
  return { byKey, total, applied, remaining: cents(total - applied), perCredit };
}

// Credited toward the sale's own charges (everything but the fee).
export const saleCredited = (alloc) => cents(Object.entries(alloc?.byKey || {}).reduce((t, [k, v]) => (k === 'fee' ? t : t + v), 0));
