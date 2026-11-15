// stripeLinks.js — one-use Stripe payment links from her own Stripe account
// (Integrations plan §4, step 6; her own restricted key, decided 2026-10-12).
//   Connect: her restricted key, checked with Stripe, kept on this device only.
//   Make a link: for exactly what's owed on a sale (deposit, or a payment), with
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

// The permissions her KennelOS restricted key needs, as Stripe's Dashboard names
// them: the Accounts page's connect form and Kels's "Help me replace it" both list these.
export const STRIPE_KEY_PERMISSIONS = Object.freeze([
  ['Products', 'Write'], ['Prices', 'Write'], ['Payment Links', 'Write'], ['Checkout Sessions', 'Read'],
  ['PaymentIntents', 'Read'], ['Charges', 'Read'], ['Balance', 'Read']
]);

// A restricted key only (rk_live_… / rk_test_…): never her full secret key.
export const isRestrictedKey = (k) => /^rk_(live|test)_[A-Za-z0-9]{10,}$/.test(String(k || '').trim());

// → { currency, testMode, connected_at, lastError } or null (the key itself stays in
// here). `lastError`: { at, message, kind } when the last paid-link check on this
// account failed (checkStripePayments), else null.
export async function stripeConnection(accountId) {
  const k = await getStripeKey(accountId);
  const lastError = (getIntegrationsState().stripeErrors || {})[accountId] || null;
  return k ? { currency: k.currency, testMode: k.api_key.startsWith('rk_test_'), connected_at: k.connected_at, lastError } : null;
}

// A new key for the account starts clean.
function clearStripeError(accountId) {
  const errors = { ...(getIntegrationsState().stripeErrors || {}) };
  if (!errors[accountId]) return;
  delete errors[accountId];
  updateIntegrationsState({ stripeErrors: errors });
}

export async function connectStripe(accountId, apiKey, currency = 'usd') {
  const api_key = String(apiKey || '').trim();
  if (!accountId) throw new Error('Save the account first.');
  if (/^sk_/.test(api_key)) throw new StripeError('auth', 'That\'s your full secret key. Make a restricted key for KennelOS instead (it starts rk_), with only the permissions listed.');
  if (!isRestrictedKey(api_key)) throw new StripeError('auth', 'That doesn\'t look like a Stripe restricted key (it starts rk_live_ or rk_test_).');
  await stripeCheckKey({ api_key, currency });
  await setStripeKey(accountId, { api_key, currency });
  clearStripeError(accountId);
  return stripeConnection(accountId);
}

export const disconnectStripe = (accountId) => clearStripeKey(accountId);

// Local date of a Stripe timestamp (seconds), YYYY-MM-DD.
function localDate(sec) {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The open link was paid before it could be replaced (review K12-1): the payment is
// now recorded on the sale (`sale`), and no new link was made, since what's owed has
// changed. The caller says so and lets her ask again for what's left.
export class LinkAlreadyPaidError extends Error {
  constructor(sale) {
    super('The family already paid the link you sent before. That payment is now recorded on the sale. Send a new link for what\'s left, if anything.');
    this.name = 'LinkAlreadyPaidError';
    this.sale = sale;
  }
}

// The key the sale's open link was made with: the account its part is paid via (the
// balance falls back to the deposit's, as salePaidVia does). null when not on this device.
async function linkConn(sale) {
  const via = sale.payment_link_component === 'deposit' ? sale.deposit_paid_via_account_id
    : (sale.balance_paid_via_account_id || sale.deposit_paid_via_account_id);
  return via ? { via, conn: await getStripeKey(via) } : { via: null, conn: null };
}

// Ask Stripe whether the sale's open link was paid, and apply each payment.
// → { paid, counts: { applied, review, skipped } }.
async function applyLinkPayments(sale, conn) {
  const counts = { applied: 0, review: 0, skipped: 0 };
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
  return { paid, counts };
}

// A one-use link on her Stripe account (account = the Payment service Account
// holding the key, the one that part is paid via) for exactly `amount`, recorded
// on the sale. Anything but the deposit (the next payment, everything owed) is a
// 'payment': paid, it becomes a row in the sale's payments (integrationEvents,
// Payment Schedule plan D34). `label` names it for the buyer ("Final payment").
// An open link the sale already holds is asked about first: paid, its payment is
// recorded and LinkAlreadyPaidError thrown, so a payment is never lost under a
// replacement (review K12-1); unpaid, it's switched off.
// → the saved sale.
export async function makeSaleLink({ sale, account, component, amount, pupName = '', label = '' }) {
  const conn = await getStripeKey(account.id);
  if (!conn) throw new StripeError('auth', 'Stripe isn\'t connected on this device.');
  const part = component === 'deposit' ? 'deposit' : 'payment';
  if (sale.payment_link_ref) {
    const old = (await linkConn(sale)).conn || conn;
    if (/^plink_/.test(sale.payment_link_ref) && (await applyLinkPayments(sale, old)).paid) throw new LinkAlreadyPaidError(await saleRepo.getById(sale.id));
    await deactivatePaymentLink(old, sale.payment_link_ref);
  }
  const name = `${part === 'deposit' ? 'Deposit' : (String(label).trim() || 'Payment')}${pupName ? `: ${pupName}` : ''}`;
  const link = await createPaymentLink(conn, { amount, name, saleId: sale.id, component: part });
  return saleRepo.update(sale.id, {
    payment_link_url: link.url, payment_link_ref: link.id, payment_link_component: part,
    payment_link_amount: Number(amount), payment_link_date: todayYMD()
  });
}

const CLEARED = { payment_link_url: null, payment_link_ref: null, payment_link_component: null, payment_link_amount: null, payment_link_date: null };

// Ask Stripe about every sale's open link and every waitlist fee link made on
// this device, and apply what was paid. One account's refused key or missing
// permission is caught for its sales alone and kept in the integrations state
// (`stripeErrors`: accountId → { at, message, kind }), cleared once that account
// answers again (review K12-3): every other account is still checked.
// → { applied, review, skipped, checked, failed, feesReceived, feesPrepaid } or null.
export async function checkStripePayments({ force = false, saleIds = null } = {}) {
  if (!editionFlags.accounts) return null;
  const last = Date.parse(getIntegrationsState().stripeCheckedAt || '') || 0;
  if (!force && Date.now() - last < CHECK_EVERY_MS) return null;
  updateIntegrationsState({ stripeCheckedAt: new Date().toISOString() });
  const counts = { applied: 0, review: 0, skipped: 0, checked: 0, failed: 0, feesReceived: 0, feesPrepaid: 0 };
  const errors = { ...(getIntegrationsState().stripeErrors || {}) };
  const ok = new Set();
  const failedNow = new Set();
  const sales = (await saleRepo.getAll())
    .filter((s) => /^plink_/.test(s.payment_link_ref || '') && (!saleIds || saleIds.includes(s.id)));
  for (const sale of sales) {
    const { via, conn } = await linkConn(sale);
    if (!conn) continue; // connected on another device, or not at all
    counts.checked++;
    try {
      const r = await applyLinkPayments(sale, conn);
      for (const k of Object.keys(r.counts)) counts[k] += r.counts[k];
      ok.add(via);
    } catch (e) {
      counts.failed++;
      failedNow.add(via);
      errors[via] = { at: new Date().toISOString(), message: String(e?.message || e).slice(0, 300), kind: e?.kind || null };
    }
  }
  for (const id of ok) if (!failedNow.has(id)) delete errors[id];
  updateIntegrationsState({ stripeErrors: errors });
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
