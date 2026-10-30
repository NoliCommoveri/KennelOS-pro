// extraCharges.js — a sale's extra charges (guide §21.2): anything the buyer
// pays for beyond the puppy, transport and boarding, one line each on the
// invoice. Photo and video packages, or a payment service's fee charged back.
//
// Stored as Sale.extra_charges: [{ id, label, amount, fee_for? }]. Every charge
// is paid with the balance (incomeView.saleComponents). `fee_for: 'deposit'`
// marks the fee charged back for a deposit paid through an account set to
// charge its fee back (Account.fee_charge_back), so it's offered only once.
//
// A kennel's price list (Kennel.extra_charge_list: [{ id, label, amount }]) only
// fills the sale's line: the label and amount are copied, so changing the price
// list never rewrites an old sale. Pure; no db.
import { feeRate, isUsableRate, processingFee } from './processingFees.js';

const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
const cents = (n) => Math.round(n * 100) / 100;
const text = (v) => String(v ?? '').trim();

// A list as stored: rows with a label and an amount above 0, amounts to the cent.
// Anything else in the field (not an array, a blank row) reads as nothing. A row
// without an id (an edited backup) reads by its place in the list, so an invoice's
// line keys stay the same from one view to the next; saving mints a real one.
function cleanList(list, { mintIds = false } = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const [i, x] of list.entries()) {
    if (!x || typeof x !== 'object') continue;
    const label = text(x.label);
    const amount = cents(num(x.amount));
    if (!label || !(amount > 0)) continue;
    const row = { id: x.id || (mintIds ? crypto.randomUUID() : `row${i}`), label, amount };
    if (x.fee_for) row.fee_for = x.fee_for;
    out.push(row);
  }
  return out;
}

// The sale's extra charges, as the money code reads them.
export function saleExtraCharges(sale) {
  return cleanList(sale?.extra_charges);
}

export function extraChargesTotal(sale) {
  return cents(saleExtraCharges(sale).reduce((t, x) => t + x.amount, 0));
}

// The rows a form hands over, checked before saving. A row with only a name or
// only an amount is a mistake she should fix; a fully blank row is dropped.
// → { list, error } (error is a message, or '').
export function readExtraCharges(rows = []) {
  for (const r of rows) {
    const hasLabel = !!text(r.label);
    const hasAmount = text(r.amount) !== '';
    if (hasLabel && !(num(r.amount) > 0)) return { list: [], error: `Give "${text(r.label)}" an amount above $0.` };
    if (!hasLabel && hasAmount) return { list: [], error: 'Give each extra charge a name.' };
  }
  return { list: cleanList(rows, { mintIds: true }), error: '' };
}

// A kennel's price list.
export function kennelChargeList(kennel) {
  return cleanList(kennel?.extra_charge_list);
}

// A new charge for a sale, from a price-list entry (or blank, to type one in).
export function newExtraCharge(preset = null) {
  return { id: crypto.randomUUID(), label: text(preset?.label), amount: preset ? cents(num(preset.amount)) : '' };
}

// The fee to charge back for a deposit paid through an account set to charge its
// fee back, or null when there's nothing to offer: no such account, no usable
// rate, no deposit, the deposit not paid yet, or the sale already carries it.
// `depositPaid` is the caller's read of the sale (incomeView's rule).
// → null | { fee_for: 'deposit', label, amount }
export function depositFeeChargeBack(sale, account, depositPaid) {
  if (!sale || !account?.fee_charge_back || !depositPaid) return null;
  const rate = feeRate(account);
  if (!isUsableRate(rate)) return null;
  if (saleExtraCharges(sale).some((x) => x.fee_for === 'deposit')) return null;
  const amount = processingFee(sale.deposit_amount, rate);
  if (!(amount > 0)) return null;
  return { fee_for: 'deposit', label: `${text(account.name) || 'Payment'} fee`, amount };
}
