// waitlistFeeLinks.js — the waitlist application fee paid online, the network
// half (the pure half is waitlistFeePay.js) (Integrations
// plan §4, 2026-10-12). The kennel names the Payment service account its fee is
// paid via (`kennels.waitlist_fee_account_id`) and when to ask for it
// (`waitlist_config.fee_link_when`: 'apply' = at the end of the online
// application, 'approved' = once she approves them). The family's page then shows
// a Pay button:
//   - with her Stripe key for that account on this device: a reusable Stripe
//     payment link per fee amount, made here and kept in
//     `waitlist_config.fee_links` [{ account_id, amount, charge, url, ref }]; each
//     family's button adds their entry id as Stripe's client_reference_id, so her
//     device can tell who paid (checkFeePayments) and record it, with Stripe's fee;
//   - else the account's own payment link (any service): she records the fee
//     herself, as today.
// With the account's "usually pass the fee on" set, the family pays the fee plus
// the card fee (processingFees.priceToNet), so she nets her fee.
import { getStripeKey } from './stripeKeyStore.js';
import { createPaymentLink, paidSessions, feeSessionPayment } from './stripeApi.js';
import { waitlistConfig, feeForEntry } from './waitlistRules.js';
import { feeAccountOf, feeCharge, planFeePayment } from './waitlistFeePay.js';
import { kennelRepo } from './kennelRepo.js';
import { accountRepo } from './accountRepo.js';
import { waitlistEntryRepo } from './waitlistEntryRepo.js';
import { waitlistProgramRepo } from './waitlistProgramRepo.js';
import { feeReceived } from './waitlistActions.js';

// The fee amounts the kennel asks for: its own and each program's (0 = waived).
async function feeAmounts(kennel) {
  const config = waitlistConfig(kennel);
  const programs = [...(await waitlistProgramRepo.getMapForKennel(kennel.id)).values()];
  return [...new Set([feeForEntry(config, null), ...programs.map((p) => feeForEntry(config, p))]
    .filter((f) => f != null && f > 0).map(Number))];
}

// With her Stripe key for the fee account on this device: make the link for any
// fee amount without one. → the kennel (updated when a link was made).
export async function ensureFeeLinks(kennel) {
  const account = feeAccountOf(kennel, kennel.waitlist_fee_account_id ? [await accountRepo.getById(kennel.waitlist_fee_account_id)] : []);
  if (!account) return kennel;
  const conn = await getStripeKey(account.id);
  if (!conn) return kennel;
  const config = waitlistConfig(kennel);
  const links = (config.fee_links || []).filter((l) => l && l.account_id === account.id);
  let added = false;
  for (const amount of await feeAmounts(kennel)) {
    const { charge } = feeCharge(amount, account);
    if (links.some((l) => Number(l.amount) === amount && Number(l.charge) === charge)) continue;
    const link = await createPaymentLink(conn, { amount: charge, name: `${kennel.kennel_name || 'Waitlist'}: application fee`, feeFor: kennel.public_id || kennel.id });
    links.push({ account_id: account.id, amount, charge, url: link.url, ref: link.id });
    added = true;
  }
  if (!added) return kennel;
  return kennelRepo.update(kennel.id, { waitlist_config: { ...(kennel.waitlist_config || {}), fee_links: links } });
}

function localDate(sec) {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Ask Stripe about each fee link made on this device and record what was paid.
// → { received, prepaid, skipped }
export async function checkFeePayments() {
  const counts = { received: 0, prepaid: 0, skipped: 0 };
  for (const kennel of (await kennelRepo.getAll()).filter((k) => k.is_own_kennel && k.waitlist_fee_account_id)) {
    const conn = await getStripeKey(kennel.waitlist_fee_account_id);
    if (!conn) continue;
    for (const link of waitlistConfig(kennel).fee_links || []) {
      if (!link?.ref || link.account_id !== kennel.waitlist_fee_account_id) continue;
      for (const session of await paidSessions(conn, link.ref, 100)) {
        const paid = feeSessionPayment(session, { timeZoneDate: localDate });
        if (!paid) continue;
        const entry = await waitlistEntryRepo.getById(paid.entryId);
        if (entry && entry.kennel_id !== kennel.id) { counts.skipped++; continue; }
        const plan = planFeePayment(entry, paid.payload, kennel.waitlist_fee_account_id);
        if (plan.op === 'received') {
          await feeReceived(entry.id, { date: plan.paidOnline.date, method: plan.paidOnline.method, reference: plan.paidOnline.reference });
          await waitlistEntryRepo.update(entry.id, plan.changes);
          counts.received++;
        } else if (plan.op === 'prepaid') {
          await waitlistEntryRepo.update(entry.id, plan.changes);
          counts.prepaid++;
        } else counts.skipped++;
      }
    }
  }
  return counts;
}
