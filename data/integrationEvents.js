// integrationEvents.js — what her device does with an event a vendor reported
// through the Worker (Integrations plan §0, step 5): "the contract was signed",
// "the deposit was paid". Pure: the caller loads the record the event names and
// applies the plan (data/cloud/cloudIntegrations.js).
//
// An event is applied only while the record is still where the vendor's link left
// it (a contract still Sent, a sale still waiting for that payment): that is how
// "nothing changed on her device since" is read. Otherwise it becomes a review on
// the record (`integration_reviews`), which Today shows for her to check: never a
// write over something she did. Already-applied events are skipped, so reading
// one twice (or on a second device) changes nothing.
//
// A payment's processing fee (plan §4 → §5) is kept per payment on the sale
// (`processing_fee_reports`, once per payment reference) and fills the sale's
// `processing_fee_amount`: each payment part's reported fee replaces that part's
// estimate (ctx.estimate, processingFees.saleFeeEstimate), unless she typed her own
// fee: then the payment is still applied, and the fee difference waits on Today.

// → { op: 'update', changes } | { op: 'review', review } | { op: 'skip', reason }
//   event:   { seq, provider, kind, recordType, recordId, payload, createdAt }
//   record:  the contract or sale it names, or null
//   ctx:     { waitlistPick: true when the sale is a waitlist pick (its deposit
//              is recorded on the family's page, where it places the family),
//              estimate: { total, parts: { deposit, balance } } from the accounts
//              each part is paid via (a fee still at it isn't one she typed) }
// An 'update' may carry a `review` too (applied, but something to check).
export function planIntegrationEvent(event, record, ctx = {}) {
  if (!record || record.is_archived) return { op: 'skip', reason: 'not_found' };
  const p = event.payload || {};
  const date = /^\d{4}-\d{2}-\d{2}$/.test(p.date || '') ? p.date : String(event.createdAt || '').slice(0, 10);
  const review = (reason) => ({ op: 'review', review: reviewOf(event, reason) });

  switch (event.kind) {
    case 'contract.signed':
      if (record.status === 'signed') return { op: 'skip', reason: 'already' };
      if (['draft', 'sent'].includes(record.status || 'draft')) return { op: 'update', changes: { status: 'signed', signed_date: date } };
      return review(`The contract is ${record.status}.`);
    case 'contract.declined':
      if (record.status === 'declined') return { op: 'skip', reason: 'already' };
      if (record.status === 'sent') return { op: 'update', changes: { status: 'declined' } };
      return review(`The contract is ${record.status || 'a draft'}.`);
    case 'payment.paid':
      return planPayment(record, p, date, ctx, review);
    case 'payment.refunded':
      return review('A refund is never recorded by itself: check the sale.');
    default:
      return { op: 'skip', reason: 'unknown_kind' };
  }
}

function planPayment(sale, p, date, ctx, review) {
  const status = sale.status;
  if (p.component === 'deposit') {
    if (sale.deposit_date === date && status !== 'deposit_pending') return { op: 'skip', reason: 'already' };
    if (status !== 'deposit_pending') return review(`The sale is already past its deposit (${status}).`);
    if (ctx.waitlistPick) return review('This sale is a waitlist pick: record the deposit on the family\'s page, where it places them.');
    return withFee(sale, p, date, ctx, { status: 'deposit_paid', deposit_date: date, ...paidBy(sale, p) });
  }
  if (p.component === 'balance') {
    if (sale.balance_paid_date === date && ['paid_in_full', 'delivered'].includes(status)) return { op: 'skip', reason: 'already' };
    if (!['deposit_pending', 'deposit_paid'].includes(status)) return review(`The sale is ${status}.`);
    if (status === 'deposit_pending' && ctx.waitlistPick) return review('This sale is a waitlist pick: record the deposit on the family\'s page first.');
    return withFee(sale, p, date, ctx,
      { status: 'paid_in_full', balance_paid_date: date, ...(sale.deposit_date ? {} : { deposit_date: date }), ...paidBy(sale, p) });
  }
  return review('A payment for an unknown part of the sale.');
}

const cents = (n) => Math.round(n * 100) / 100;
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// The sale's fee from its reports, each part's reported fees standing in for
// that part's estimate.
function feeFrom(reports, estimate) {
  const reported = { deposit: null, balance: null };
  for (const r of reports) {
    const part = r?.component === 'deposit' ? 'deposit' : 'balance';
    reported[part] = cents((reported[part] || 0) + (Number(r?.fee) || 0));
  }
  const est = estimate?.parts || {};
  return cents((reported.deposit ?? est.deposit ?? 0) + (reported.balance ?? est.balance ?? 0));
}

// The payment's update with its fee: recorded once per payment reference, and the
// sale's fee moved to match, unless she typed a fee of her own.
function withFee(sale, p, date, ctx, changes) {
  const plan = { op: 'update', changes };
  if (typeof p.fee !== 'number') return plan;
  const reports = Array.isArray(sale.processing_fee_reports) ? sale.processing_fee_reports : [];
  const ref = p.reference || `${p.component}:${date}`;
  if (reports.some((r) => r && r.ref === ref)) return plan;
  const next = [...reports, { ref, fee: p.fee, date, component: p.component }];
  changes.processing_fee_reports = next;
  const before = feeFrom(reports, ctx.estimate);
  const after = feeFrom(next, ctx.estimate);
  const current = num(sale.processing_fee_amount);
  const untouched = current === null || current === 0 || current === before
    || (!reports.length && ctx.estimate && current === ctx.estimate.total);
  if (untouched) changes.processing_fee_amount = after;
  else plan.review = { reason: `With Stripe's fee for this payment the processing fee comes to $${after.toFixed(2)}; the sale says $${current.toFixed(2)}, which you entered. Change it if it should match.` };
  return plan;
}

// How it was paid, only into fields she left empty.
function paidBy(sale, p) {
  const out = {};
  if (!sale.payment_method && p.method) out.payment_method = p.method;
  if (!sale.payment_reference && p.reference) out.payment_reference = p.reference;
  return out;
}

export function reviewOf(event, reason) {
  return {
    id: event.id || `int-${event.seq}`, seq: event.seq ?? null, provider: event.provider, kind: event.kind,
    payload: event.payload || {}, at: event.createdAt, reason
  };
}

export const REVIEWS_MAX = 20;

// The record's reviews with this one added (once), newest kept.
export function addReview(list, review) {
  const rest = (Array.isArray(list) ? list : []).filter((r) => r && r.id !== review.id);
  return [...rest, review].slice(-REVIEWS_MAX);
}

const PROVIDER_LABELS = { stripe: 'Stripe', square: 'Square', jotform: 'Jotform', docusign: 'DocuSign', signwell: 'SignWell', boldsign: 'BoldSign' };
export const providerLabel = (p) => PROVIDER_LABELS[p] || String(p || 'A connected service');

// One line for Today: what the vendor said. `money` formats an amount.
export function reviewTitle(review, money = (n) => `$${Number(n).toFixed(2)}`) {
  const who = providerLabel(review.provider);
  const p = review.payload || {};
  const amount = typeof p.amount === 'number' ? ` of ${money(p.amount)}` : '';
  switch (review.kind) {
    case 'contract.signed': return `${who} says the contract was signed`;
    case 'contract.declined': return `${who} says the contract was declined`;
    case 'payment.paid': return `${who} says a ${p.component === 'balance' ? 'balance' : 'deposit'} payment${amount} came in`;
    case 'payment.refunded': return `${who} says a refund${amount} was made`;
    default: return `${who} reported something to check`;
  }
}
