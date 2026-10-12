// stripeApi.js — her own Stripe account (Integrations plan §4, step 6): the only
// module that calls Stripe's API. Straight from her browser to Stripe with her
// restricted key, kept on this device (stripeKeyStore.js); nothing goes through
// KennelOS's server, and the money goes to her Stripe account.
//
// *Unverified from the build environment, which can't reach stripe.com:* that
// api.stripe.com answers a browser call made with a restricted key (CORS), the
// restricted-key permission names, and the expand path for the fee. The calls
// are Stripe's documented ones; check them in a real flow, as Jotform's were.
//   Products: Write, Prices: Write   (a price for exactly this amount)
//   Payment Links: Write             (the one-use link)
//   Checkout Sessions: Read, PaymentIntents: Read, Charges: Read,
//   Balance transaction sources / Balance: Read   (paid? and the fee)
//
// The pure builders (linkParams, sessionPayment) are what the tests pin.

const API = 'https://api.stripe.com/v1';

// Currencies whose amounts Stripe counts in hundredths (all of these do).
export const STRIPE_CURRENCIES = [
  { value: 'usd', label: 'US dollars (USD)' },
  { value: 'cad', label: 'Canadian dollars (CAD)' },
  { value: 'gbp', label: 'British pounds (GBP)' },
  { value: 'eur', label: 'Euros (EUR)' },
  { value: 'aud', label: 'Australian dollars (AUD)' },
  { value: 'nzd', label: 'New Zealand dollars (NZD)' }
];

export class StripeError extends Error {
  // kind: 'network' (no answer: offline, or the browser blocked it), 'auth'
  // (key refused, or a permission it lacks), 'other'.
  constructor(kind, message) {
    super(message);
    this.name = 'StripeError';
    this.kind = kind;
  }
}

const toCents = (amount) => Math.round(Number(amount) * 100);

// The form fields of a call, flattened Stripe's way (a[b][c]=v).
function form(params) {
  const out = new URLSearchParams();
  const walk = (prefix, v) => {
    if (v === undefined || v === null) return;
    if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(prefix ? `${prefix}[${k}]` : k, x);
    else out.append(prefix, String(v));
  };
  walk('', params);
  return out;
}

async function call(conn, method, path, params = null) {
  let res;
  try {
    const body = method === 'POST' && params ? form(params) : null;
    const url = method === 'GET' && params ? `${API}${path}?${form(params)}` : `${API}${path}`;
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${conn.api_key}`, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer'
    });
  } catch {
    throw new StripeError('network', 'Couldn\'t reach Stripe from this browser. If you\'re online, Stripe may not accept calls from an app like KennelOS: use your own payment link for now, and let us know.');
  }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (res.status === 401 || res.status === 403) {
    throw new StripeError('auth', res.status === 401
      ? 'Stripe didn\'t accept that key. Check it\'s the restricted key you made for KennelOS.'
      : `Your Stripe key is missing a permission KennelOS needs${body?.error?.message ? ` (${String(body.error.message).slice(0, 160)})` : ''}.`);
  }
  if (!res.ok || !body) throw new StripeError('other', `Stripe said: ${String(body?.error?.message || res.statusText || res.status).slice(0, 200)}`);
  return body;
}

// The key works and can see payment links. Anything else is found when used.
export async function stripeCheckKey(conn) {
  await call(conn, 'GET', '/payment_links', { limit: 1 });
}

// Pure: the two calls that make a link for exactly `amount`.
//   name: what the buyer sees ("Deposit: Maple").
//   A sale's link is one-use, with saleId + component in the metadata, so a paid
//   session names its sale. A waitlist fee link (feeFor: the kennel's public_id)
//   is reusable: each family's checkout names them by the client_reference_id
//   their page adds to the link.
export function linkParams({ amount, currency = 'usd', name, saleId, component, feeFor = null }) {
  const metadata = feeFor
    ? { kennelos_purpose: 'waitlist_fee', kennelos_kennel: feeFor }
    : { kennelos_sale_id: saleId, kennelos_component: component };
  return {
    price: { currency, unit_amount: toCents(amount), product_data: { name: String(name).slice(0, 200) } },
    link: (priceId) => ({
      line_items: { 0: { price: priceId, quantity: 1 } },
      metadata,
      payment_intent_data: { metadata, description: String(name).slice(0, 200) },
      ...(feeFor ? {} : { restrictions: { completed_sessions: { limit: 1 } } })
    })
  };
}

// → { id, url }
export async function createPaymentLink(conn, spec) {
  const p = linkParams({ ...spec, currency: conn.currency || 'usd' });
  const price = await call(conn, 'POST', '/prices', p.price);
  const link = await call(conn, 'POST', '/payment_links', p.link(price.id));
  return { id: String(link.id), url: String(link.url) };
}

// A link no longer wanted (a new one replaces it). Best effort.
export async function deactivatePaymentLink(conn, id) {
  try { await call(conn, 'POST', `/payment_links/${encodeURIComponent(id)}`, { active: false }); } catch { /* it may be paid or gone */ }
}

// The completed, paid checkout sessions of one link, with the fee expanded.
export async function paidSessions(conn, linkId, limit = 10) {
  const page = await call(conn, 'GET', '/checkout/sessions', {
    payment_link: linkId, limit, expand: { 0: 'data.payment_intent.latest_charge.balance_transaction' }
  });
  return (page.data || []).filter((s) => s && s.status === 'complete' && s.payment_status === 'paid');
}

// Pure: one paid waitlist-fee session → { entryId, sessionId, payload } (the
// family by the client_reference_id their page put on the link), or null.
export function feeSessionPayment(session, { timeZoneDate = (sec) => new Date(sec * 1000).toISOString().slice(0, 10) } = {}) {
  if (session?.metadata?.kennelos_purpose !== 'waitlist_fee') return null;
  const entryId = String(session.client_reference_id || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(entryId)) return null;
  const p = sessionPayment({ ...session, metadata: { kennelos_sale_id: 'x', kennelos_component: 'deposit' } }, { timeZoneDate });
  return { entryId, sessionId: String(session.id), payload: { ...p.payload, component: 'application_fee' } };
}

// Pure: one paid session as the payload of a 'payment.paid' event (step 5's
// shape), or null when it isn't one of ours. The fee is the charge's balance
// transaction fee (what Stripe kept), in her account's currency.
export function sessionPayment(session, { timeZoneDate = (sec) => new Date(sec * 1000).toISOString().slice(0, 10) } = {}) {
  const meta = session?.metadata || {};
  if (!meta.kennelos_sale_id || !['deposit', 'balance'].includes(meta.kennelos_component)) return null;
  const pi = session.payment_intent && typeof session.payment_intent === 'object' ? session.payment_intent : null;
  const bt = pi?.latest_charge?.balance_transaction;
  const fee = bt && typeof bt === 'object' && Number.isFinite(bt.fee) ? bt.fee / 100 : undefined;
  return {
    saleId: String(meta.kennelos_sale_id),
    sessionId: String(session.id),
    payload: {
      component: meta.kennelos_component,
      amount: Number.isFinite(session.amount_total) ? session.amount_total / 100 : undefined,
      fee,
      currency: String(session.currency || '').toUpperCase() || undefined,
      date: Number.isFinite(session.created) ? timeZoneDate(session.created) : undefined,
      method: 'Credit/debit card',
      reference: String(pi?.id || session.payment_intent || session.id)
    }
  };
}
