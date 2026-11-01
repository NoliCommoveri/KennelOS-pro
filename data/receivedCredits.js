// receivedCredits.js — a waitlist family's credits for funds already received
// (WaitlistEntry.received_credits): money she collected outside the app, e.g. an
// early deposit taken before the litter was born. Each credit is
//   { id, amount, date, method?, note?, applies_to: ['fee','deposit','price','extras'] }
// (vocab.CREDIT_USES; every use ticked by default). Nothing about how a credit is
// used is stored: it's worked out here, every time, from what the family is
// charged. Credits are used oldest first; each one pays, in order, the
// application fee, the deposit, the rest of the purchase price, then transport,
// boarding and extras, only toward the uses it's ticked for. Whatever's left is
// their credit remaining. Pure: incomeView supplies the sale's charges.
import { CREDIT_USES } from './vocab.js';

const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
const cents = (n) => Math.round(n * 100) / 100;
export const CREDIT_USE_VALUES = CREDIT_USES.map((u) => u.value);

// The entry's valid credits, oldest first.
export function creditsOf(entry) {
  return (Array.isArray(entry?.received_credits) ? entry.received_credits : [])
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
export function allocateCredits(credits, charges) {
  const left = new Map(charges.map((c) => [c.key, num(c.amount)]));
  const byKey = {};
  const perCredit = {};
  for (const cr of credits) {
    let have = cr.amount;
    perCredit[cr.id] = 0;
    for (const ch of charges) {
      if (!(have > 0)) break;
      if (!cr.applies_to.includes(ch.use)) continue;
      const take = cents(Math.min(have, left.get(ch.key)));
      if (!(take > 0)) continue;
      left.set(ch.key, cents(left.get(ch.key) - take));
      byKey[ch.key] = cents((byKey[ch.key] || 0) + take);
      perCredit[cr.id] = cents(perCredit[cr.id] + take);
      have = cents(have - take);
    }
  }
  const total = cents(credits.reduce((t, c) => t + c.amount, 0));
  const applied = cents(Object.values(byKey).reduce((t, v) => t + v, 0));
  return { byKey, total, applied, remaining: cents(total - applied), perCredit };
}

// Credited toward the sale's own charges (everything but the fee).
export const saleCredited = (alloc) => cents(Object.entries(alloc?.byKey || {}).reduce((t, [k, v]) => (k === 'fee' ? t : t + v), 0));
