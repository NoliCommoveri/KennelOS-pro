// stripeLinks.js — one-use Stripe payment links from her own Stripe account
// (Integrations plan §4, step 6; her own restricted key, decided 2026-10-12).
//   Connect: her restricted key, checked with Stripe, kept on this device only.
//   Make a link: for exactly what's owed on a sale (deposit, or the rest), with
//     the sale's id in Stripe's metadata; the link goes on the sale
//     (payment_link_*), replacing an unpaid one.
//   Check: when she opens KennelOS (at most every CHECK_EVERY_MS), her device asks
//     Stripe whether each sale's open link was paid, and applies the payment like
//     any vendor event (integrationApply.js): status, date, card, reference and
//     the fee Stripe kept, or a review on Today when the sale had moved on.
// No KennelOS server is involved; the money goes to her Stripe account. What
// pages call; the key (stripeKeyStore.js) and the network (stripeApi.js) stay
// behind it.
import { getStripeKey, setStripeKey, clearStripeKey } from './stripeKeyStore.js';
import { stripeCheckKey, createPaymentLink, deactivatePaymentLink, paidSessions, sessionPayment, StripeError } from './stripeApi.js';
import { saleRepo } from './saleRepo.js';
import { applyIntegrationEvent } from './integrationApply.js';
import { getIntegrationsState, updateIntegrationsState } from './settings.js';
import { editionFlags } from './editionConfig.js';
import { todayYMD } from './dateUtils.js';

export { STRIPE_CURRENCIES, StripeError } from './stripeApi.js';

export const CHECK_EVERY_MS = 15 * 60 * 1000;

// A restricted key only (rk_live_… / rk_test_…): never her full secret key.
export const isRestrictedKey = (k) => /^rk_(live|test)_[A-Za-z0-9]{10,}$/.test(String(k || '').trim());

// → { currency, testMode, connected_at } or null (the key itself stays in here).
export async function stripeConnection(accountId) {
  const k = await getStripeKey(accountId);
  return k ? { currency: k.currency, testMode: k.api_key.startsWith('rk_test_'), connected_at: k.connected_at } : null;
}

export async function connectStripe(accountId, apiKey, currency = 'usd') {
  const api_key = String(apiKey || '').trim();
  if (!accountId) throw new Error('Save the account first.');
  if (/^sk_/.test(api_key)) throw new StripeError('auth', 'That\'s your full secret key. Make a restricted key for KennelOS instead (it starts rk_), with only the permissions listed.');
  if (!isRestrictedKey(api_key)) throw new StripeError('auth', 'That doesn\'t look like a Stripe restricted key (it starts rk_live_ or rk_test_).');
  await stripeCheckKey({ api_key, currency });
  await setStripeKey(accountId, { api_key, currency });
  return stripeConnection(accountId);
}

export const disconnectStripe = (accountId) => clearStripeKey(accountId);

// Local date of a Stripe timestamp (seconds), YYYY-MM-DD.
function localDate(sec) {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// A one-use link on her Stripe account (account = the Payment service Account
// holding the key, the one that part is paid via) for exactly `amount`, recorded
// on the sale. 'all' (everything owed) is paid as the balance. → the saved sale.
export async function makeSaleLink({ sale, account, component, amount, pupName = '' }) {
  const conn = await getStripeKey(account.id);
  if (!conn) throw new StripeError('auth', 'Stripe isn\'t connected on this device.');
  const part = component === 'deposit' ? 'deposit' : 'balance';
  if (sale.payment_link_ref) await deactivatePaymentLink(conn, sale.payment_link_ref);
  const name = `${part === 'deposit' ? 'Deposit' : 'Balance'}${pupName ? `: ${pupName}` : ''}`;
  const link = await createPaymentLink(conn, { amount, name, saleId: sale.id, component: part });
  return saleRepo.update(sale.id, {
    payment_link_url: link.url, payment_link_ref: link.id, payment_link_component: part,
    payment_link_amount: Number(amount), payment_link_date: todayYMD()
  });
}

const CLEARED = { payment_link_url: null, payment_link_ref: null, payment_link_component: null, payment_link_amount: null, payment_link_date: null };

// Ask Stripe about every sale's open link and every waitlist fee link made on
// this device, and apply what was paid. → { applied, review, skipped, checked,
// feesReceived, feesPrepaid } or null (not due yet).
export async function checkStripePayments({ force = false, saleIds = null } = {}) {
  if (!editionFlags.accounts) return null;
  const last = Date.parse(getIntegrationsState().stripeCheckedAt || '') || 0;
  if (!force && Date.now() - last < CHECK_EVERY_MS) return null;
  updateIntegrationsState({ stripeCheckedAt: new Date().toISOString() });
  const counts = { applied: 0, review: 0, skipped: 0, checked: 0, feesReceived: 0, feesPrepaid: 0 };
  const sales = (await saleRepo.getAll())
    .filter((s) => /^plink_/.test(s.payment_link_ref || '') && (!saleIds || saleIds.includes(s.id)));
  for (const sale of sales) {
    // The key of the account the link's part is paid via (the balance falls back
    // to the deposit's, as salePaidVia does).
    const via = sale.payment_link_component === 'deposit' ? sale.deposit_paid_via_account_id
      : (sale.balance_paid_via_account_id || sale.deposit_paid_via_account_id);
    const conn = via ? await getStripeKey(via) : null;
    if (!conn) continue; // connected on another device, or not at all
    counts.checked++;
    let paid = false;
    for (const session of await paidSessions(conn, sale.payment_link_ref)) {
      const p = sessionPayment(session, { timeZoneDate: localDate });
      if (!p || p.saleId !== sale.id) continue;
      paid = true;
      counts[await applyIntegrationEvent({
        id: `stripe-${p.sessionId}`, provider: 'stripe', kind: 'payment.paid',
        recordType: 'sale', recordId: sale.id, payload: p.payload, createdAt: new Date().toISOString()
      })]++;
    }
    if (paid) await saleRepo.update(sale.id, CLEARED);
  }
  // Waitlist application fees paid online (waitlistFeeLinks.js).
  if (!saleIds && editionFlags.waitlist) {
    const { checkFeePayments } = await import('./waitlistFeeLinks.js');
    const fees = await checkFeePayments();
    counts.feesReceived = fees.received;
    counts.feesPrepaid = fees.prepaid;
  }
  return counts;
}

// On page load (app.js): a check, when one is due. Never blocks a page.
export function bootStripeCheck() {
  if (!editionFlags.accounts) return;
  setTimeout(() => { checkStripePayments().catch(() => {}); }, 2000);
}
