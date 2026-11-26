// discounts.js — her discounts (Payment Methods plan §5.4, Phase 5). Pure: no db, no
// imports beyond the pure money modules, so the projection, the sale page and the
// statement all read the same rules.
//
// Kennel.discounts: her table, Settings → Discounts (beside Covering payment costs):
//   [{ id, label, kind: 'method' | 'own', takes_back?, percent?, amount?, suggest? }]
//   method  a discounted payment method (D13): applied by itself to a payment made
//           through any account ticked Discounted payment method
//           (Account.discounted_method, D14). With `takes_back` (the default) it is
//           exactly her payment costs on what that payment covers (the service fees
//           in it, or the payment-fee increase inside its charges); else a percent or
//           an amount of the payment. At most one method row.
//   own     her own reasons (repeat buyer, a referral reward, anything she names): a
//           percent of the sale's full total or an amount, added on a sale by her
//           (Add discount). `suggest: 'repeat_buyer'` offers itself when the buyer has
//           an earlier sale of hers; she confirms (D15).
// Sale.discounts: what she gave on one sale: [{ id, discount_id?, label, amount,
//   payment_id? }]. `payment_id`: the payment a method discount came with (a payment's
//   id, or 'deposit' for the deposit, D31); none for her own discounts, which come off
//   the final payment (owner, 2026-11-26, D27). Each comes off the full amount owed,
//   never off another (D15, D16). paymentSchedule.paymentStatement counts them as money
//   toward what's owed, so a discounted payment pays its due date in full; Income takes
//   each back off as a negative `discount` line, so earned income is what she received.
import { saleCover } from './costCover.js';
import { RELEASED_SALE_STATUSES } from './vocab.js';

const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
const cents = (n) => Math.round(n * 100) / 100;
const text = (v) => String(v ?? '').trim();

export const DISCOUNT_KINDS = ['method', 'own'];
export const DISCOUNT_SUGGESTS = ['repeat_buyer'];
export const DISCOUNT_LABEL_MAX = 120;
export const DISCOUNT_PERCENT_MAX = 50;
// What a new method row starts as.
export const METHOD_DISCOUNT_DEFAULT = Object.freeze({ label: 'Bank or cash discount', kind: 'method', takes_back: true });

const pct = (v) => {
  const n = Number(v);
  return v === '' || v == null || !Number.isFinite(n) || !(n > 0) ? null : Math.min(Math.round(n * 1000) / 1000, DISCOUNT_PERCENT_MAX);
};
const dollars = (v) => {
  const n = Number(v);
  return v === '' || v == null || !Number.isFinite(n) || !(n > 0) ? null : cents(n);
};

// --- Her table -----------------------------------------------------------------------

function cleanRow(r) {
  if (!r || typeof r !== 'object' || !DISCOUNT_KINDS.includes(r.kind)) return null;
  const label = text(r.label).slice(0, DISCOUNT_LABEL_MAX);
  if (!label) return null;
  const takesBack = r.kind === 'method' && r.takes_back !== false;
  const percent = takesBack ? null : pct(r.percent);
  const amount = takesBack || percent ? null : dollars(r.amount);
  if (!takesBack && !percent && !amount) return null;
  return {
    id: text(r.id) || crypto.randomUUID(), label, kind: r.kind,
    ...(r.kind === 'method' ? { takes_back: takesBack } : {}),
    ...(percent ? { percent } : {}), ...(amount ? { amount } : {}),
    ...(r.kind === 'own' && DISCOUNT_SUGGESTS.includes(r.suggest) ? { suggest: r.suggest } : {})
  };
}

// Her table as stored, cleaned: each row once, at most one method row (the first).
export function kennelDiscounts(kennel) {
  const out = [];
  for (const raw of Array.isArray(kennel?.discounts) ? kennel.discounts : []) {
    const r = cleanRow(raw);
    if (!r || out.some((x) => x.id === r.id) || (r.kind === 'method' && out.some((x) => x.kind === 'method'))) continue;
    out.push(r);
  }
  return out;
}
export const methodDiscount = (kennel) => kennelDiscounts(kennel).find((r) => r.kind === 'method') || null;
export const ownDiscounts = (kennel) => kennelDiscounts(kennel).filter((r) => r.kind === 'own');

// The Settings card's rows, checked: [{ id?, label, kind, how: 'takes_back'|'percent'|
// 'amount', value, suggest? }] → { discounts, error }. A row with no label and no value
// is dropped; a half-filled one is an error.
export function readDiscounts(rows = []) {
  const out = [];
  for (const r of rows) {
    const label = text(r.label);
    const value = text(r.value);
    const how = r.kind === 'method' && r.how === 'takes_back' ? 'takes_back' : r.how === 'amount' ? 'amount' : 'percent';
    if (!label && (how === 'takes_back' || !value)) continue;
    if (!label) return { discounts: null, error: 'Give each discount a name families will see.' };
    if (label.length > DISCOUNT_LABEL_MAX) return { discounts: null, error: `${label.slice(0, 30)}…: ${DISCOUNT_LABEL_MAX} characters at most.` };
    if (r.kind === 'method' && out.some((x) => x.kind === 'method')) return { discounts: null, error: 'Only one payment-method discount.' };
    if (how !== 'takes_back') {
      const n = Number(value);
      if (!value || !Number.isFinite(n) || n <= 0) return { discounts: null, error: `${label}: enter a number above 0.` };
      if (how === 'percent' && n > DISCOUNT_PERCENT_MAX) return { discounts: null, error: `${label}: ${DISCOUNT_PERCENT_MAX}% at most.` };
    }
    const row = cleanRow({ id: r.id, label, kind: r.kind, takes_back: how === 'takes_back', ...(how === 'percent' ? { percent: value } : how === 'amount' ? { amount: value } : {}), suggest: r.suggest });
    if (row) out.push(row);
  }
  return { discounts: out, error: '' };
}

// --- Discounted payment methods ------------------------------------------------------

export const isDiscountedMethod = (account) => Boolean(account && account.discounted_method === true && !account.is_archived);

// The keep-one warning (plan §2.4, D13): a method discount must stay open to every
// family, so turning off every discounted method for one family is flagged. `methods`:
// the payment's methods before the family's off list; `off`: their off ids.
export function discountWarning(kennel, methods = [], off = []) {
  if (!methodDiscount(kennel)) return '';
  const discounted = methods.filter(isDiscountedMethod);
  if (!discounted.length || discounted.some((a) => !off.includes(a.id))) return '';
  return 'Every discounted way to pay is off for this family. A payment-method discount has to be open to every family.';
}

// --- What one payment saves ----------------------------------------------------------

// The kind of cost a charge carries (costCover kinds): its key from saleCharges.
function coverKindOf(c) {
  if (c.component === 'deposit' || c.component === 'balance') return 'puppy';
  if (c.component === 'boarding' || c.component === 'transport') return c.component;
  if (c.component === 'extra' && !c.feeFor && !c.step && !c.steps) return 'extras';
  return null;
}

// What a payment-method discount takes back on a payment of `pieces`
// ([{ key, component, owed }], paymentSchedule.duePieces) on a sale whose statement is
// `st`: with service fees, the service fees in it; with payment-fee prices, each
// charge's share of her cost, worked out cumulatively (what's paid of the kind, then
// with this payment), so the payments across a schedule add up to her cost to the cent.
export function takesBackOn(sale, st, pieces = []) {
  const c = saleCover(sale);
  if (!c || !(c.total > 0) || !st) return 0;
  if (c.show === 'service_fee') return cents(pieces.filter((p) => p.component === 'service_fee').reduce((t, p) => t + num(p.owed), 0));
  // Payment-fee prices: her cost on each kind, over the kind's charges as priced.
  const charges = st.charges || [];
  const paidOf = new Map();
  for (const r of st.received || []) for (const p of r.pays || []) paidOf.set(p.key, cents((paidOf.get(p.key) || 0) + p.amount));
  const byKind = {};
  for (const ch of charges) {
    const kind = coverKindOf(ch);
    if (!kind) continue;
    const k = (byKind[kind] ||= { total: 0, paid: 0, now: 0 });
    k.total = cents(k.total + ch.amount);
    k.paid = cents(k.paid + (paidOf.get(ch.key) || 0));
  }
  for (const p of pieces) {
    const ch = charges.find((x) => x.key === p.key);
    const kind = ch ? coverKindOf(ch) : null;
    if (kind && byKind[kind]) byKind[kind].now = cents(byKind[kind].now + num(p.owed));
  }
  let out = 0;
  for (const [kind, k] of Object.entries(byKind)) {
    const cost = num(c[kind]);
    if (!(cost > 0) || !(k.total > 0) || !(k.now > 0)) continue;
    const share = (paid) => cents(cost * Math.min(paid, k.total) / k.total);
    out = cents(out + share(k.paid + k.now) - share(k.paid));
  }
  return out;
}

// What a payment through `account` of `amount` (owed on `pieces`) saves: her method
// discount's amount, or 0 (not a discounted method, no method discount, nothing owed).
// Never the whole payment. `cost`: her payment costs in it when there's no sale yet (a
// deposit picked while her device was off: the listed deposit's share). → { amount,
// label, discount_id } | null.
export function methodSavings({ kennel, account, sale = null, st = null, pieces = [], amount, cost = null }) {
  const d = methodDiscount(kennel);
  const owed = cents(num(amount));
  if (!d || !isDiscountedMethod(account) || !(owed > 0)) return null;
  const raw = d.takes_back ? (cost != null ? cents(num(cost)) : takesBackOn(sale, st, pieces)) : d.percent ? cents(owed * d.percent / 100) : num(d.amount);
  const save = cents(Math.min(raw, owed - 0.01));
  return save > 0 ? { amount: save, label: d.label, discount_id: d.id } : null;
}

// --- Her own discounts on a sale -----------------------------------------------------

// What one of her own discounts comes to on a sale (a percent of its full total).
export function ownDiscountAmount(row, st) {
  if (!row) return 0;
  if (row.percent) return cents(num(st?.total) * row.percent / 100);
  return cents(num(row.amount));
}

// A sale's discounts, cleaned: [{ id, discount_id?, label, amount, payment_id? }].
export function saleDiscounts(sale) {
  const list = Array.isArray(sale?.discounts) ? sale.discounts : [];
  const out = [];
  for (const d of list) {
    if (!d || typeof d !== 'object') continue;
    const amount = dollars(d.amount);
    const label = text(d.label).slice(0, DISCOUNT_LABEL_MAX);
    if (!amount || !label) continue;
    const id = text(d.id) || `disc${out.length}`;
    if (out.some((x) => x.id === id)) continue;
    out.push({ id, label, amount, ...(text(d.discount_id) ? { discount_id: text(d.discount_id) } : {}), ...(text(d.payment_id) ? { payment_id: text(d.payment_id) } : {}) });
  }
  return out;
}

// What recording the deposit through an account writes on the sale (D31): the account
// it came through, and the deposit's discount set (or cleared when none). `discount`:
// methodSavings' result, or null. → { deposit_paid_via_account_id?, discounts? }
export function depositPayChanges(sale, { paidVia = null, discount = null } = {}) {
  const had = saleDiscounts(sale).find((d) => d.payment_id === 'deposit') || null;
  const out = {};
  if (paidVia) out.deposit_paid_via_account_id = paidVia;
  if (discount && discount.amount > 0) {
    const kept = (Array.isArray(sale?.discounts) ? sale.discounts : []).filter((d) => d && d.payment_id !== 'deposit');
    out.discounts = [...kept, { id: had?.id || crypto.randomUUID(), ...(discount.discount_id ? { discount_id: discount.discount_id } : {}), label: discount.label, amount: discount.amount, payment_id: 'deposit' }];
  } else if (had) {
    out.discounts = (sale.discounts || []).filter((d) => d && d.payment_id !== 'deposit');
  }
  return out;
}

// A sale's discounts with one added or replaced (by id), or removed.
export function discountsWith(sale, discount, { remove = false } = {}) {
  const list = (Array.isArray(sale?.discounts) ? sale.discounts : []).filter((d) => d && d.id !== discount.id);
  return remove ? list : [...list, discount];
}
// The discount recorded with one payment (its id, or 'deposit'), if any.
export const discountForPayment = (sale, paymentId) => saleDiscounts(sale).find((d) => d.payment_id === paymentId) || null;

// The rows of hers that suggest themselves on this sale (D15; she confirms): the repeat
// buyer row when the buyer has an earlier sale of hers that went ahead. Never one
// already on the sale.
export function suggestedDiscounts(kennel, sale, sales = []) {
  if (!sale?.buyer_contact_id) return [];
  const on = new Set(saleDiscounts(sale).map((d) => d.discount_id).filter(Boolean));
  const earlier = sales.some((s) => s && s.id !== sale.id && !s.is_archived && s.buyer_contact_id === sale.buyer_contact_id
    && (!sale.kennel_id || s.kennel_id === sale.kennel_id) && !RELEASED_SALE_STATUSES.includes(s.status)
    && String(s.created_at || s.sale_date || '') < String(sale.created_at || sale.sale_date || '9999'));
  return ownDiscounts(kennel).filter((r) => r.suggest === 'repeat_buyer' && earlier && !on.has(r.id));
}
