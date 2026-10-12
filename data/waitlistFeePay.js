// waitlistFeePay.js — the waitlist application fee paid online (Integrations
// plan §4, 2026-10-12), the pure half: which account, what the family pays, their
// Pay link, and what a paid fee does to their entry. The network half (making the
// Stripe links, checking them) is waitlistFeeLinks.js. Used by the projection
// (waitlistProjection.js), so nothing here touches the database.
import { feeRate, priceToNet } from './processingFees.js';
import { paymentLink } from './paymentLinks.js';
import { waitlistConfig } from './waitlistRules.js';

export const FEE_LINK_WHEN = ['apply', 'approved'];

// The Payment service account the kennel's fee is paid via, or null.
export function feeAccountOf(kennel, accounts = []) {
  const a = kennel?.waitlist_fee_account_id ? accounts.find((x) => x && x.id === kennel.waitlist_fee_account_id) : null;
  return a && a.account_type === 'payment_service' ? a : null;
}

// What the family pays for a fee of `fee`: the fee itself, or with the card fee
// on top when the account usually passes it on. → { charge, passed }
export function feeCharge(fee, account) {
  const rate = feeRate(account);
  const grossed = account?.fee_passed_to_buyer_default && rate ? priceToNet(fee, rate) : null;
  return grossed != null && grossed > fee ? { charge: grossed, passed: true } : { charge: Number(fee), passed: false };
}

const isStripe = (url) => {
  try { return /(^|\.)stripe\.com$/.test(new URL(url).hostname); } catch { return false; }
};

// The family's own Pay link: a Stripe link gets their id (client_reference_id).
export function withClientRef(url, ref) {
  if (!url || !ref || !isStripe(url)) return url;
  const u = new URL(url);
  u.searchParams.set('client_reference_id', ref);
  return u.href;
}

// Pure: what a family's page offers for a fee of `fee`, or null.
// → { url (the base link, before their id), amount (what they pay), stripe }
export function feePay(kennel, accounts, fee) {
  const account = feeAccountOf(kennel, accounts);
  if (!account || !(Number(fee) > 0)) return null;
  const { charge } = feeCharge(Number(fee), account);
  const made = (waitlistConfig(kennel).fee_links || []).find((l) => l && l.account_id === account.id
    && Number(l.amount) === Number(fee) && Number(l.charge) === charge && paymentLink(l.url));
  if (made) return { url: made.url, amount: charge, stripe: true };
  const own = paymentLink(account.payment_link);
  return own ? { url: own, amount: charge, stripe: isStripe(own) } : null;
}

// Pure: what one paid fee does to its family's entry.
// → { op: 'received', changes } (approved: feeReceived, then these)
//   | { op: 'prepaid', changes } (not approved yet: kept until she approves)
//   | { op: 'skip', reason }
export function planFeePayment(entry, p, accountId) {
  if (!entry) return { op: 'skip', reason: 'not_found' };
  const paidOnline = { date: p.date, amount: p.amount ?? null, fee: p.fee ?? null, method: p.method || 'Credit/debit card', reference: p.reference };
  if (entry.fee_payment_reference === p.reference || entry.fee_paid_online?.reference === p.reference) return { op: 'skip', reason: 'already' };
  const extra = {
    fee_paid_via_account_id: accountId,
    ...(typeof p.amount === 'number' ? { fee_paid_amount: p.amount } : {}),
    ...(typeof p.fee === 'number' ? { fee_processing_amount: p.fee } : {})
  };
  if (entry.status === 'approved' && !entry.fee_received_date) return { op: 'received', changes: extra, paidOnline };
  if (entry.fee_received_date) return { op: 'skip', reason: 'fee_already_received' };
  // Applied (or declined / withdrawn after paying): kept on the entry. Approving
  // uses it; otherwise her family page shows it, to refund in her Stripe.
  return { op: 'prepaid', changes: { ...extra, fee_paid_online: paidOnline } };
}

