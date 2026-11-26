// payMethods.js — the payment methods families choose from (Payment Methods plan
// §2–§3, Phase 1). A method is one of her Payment service accounts (a link,
// instructions, or both). Her kennel lists which ones families may use for each
// kind of payment (Kennel.pay_methods: fee, deposit, payments, final), in the
// order families see them. A list that isn't set means that payment works as it
// did before: her free text (payment_instructions, final_payment_methods), and for
// the fee the one account in waitlist_fee_account_id. She can turn methods off for
// one family (WaitlistEntry.pay_methods_off, Phase 2, §2.4): off for every payment
// still ahead of them, on their page and everywhere she sends how to pay.
//
// Every method charges the amount owed: no fee is ever added for how a family pays
// (D1). A link button can only promise an amount when the link itself carries it
// (a Stripe link KennelOS made for that amount, a PayPal.me or Cash App link with
// the amount filled in); otherwise the button names the method and the amount
// stays the headline (owner, 2026-11-25). Pure: no db, and no imports, so the light
// pages (and the sample data on every page's first-run path) can load it cheaply.

// A web address as stored, else '' (paymentLinks.paymentLink's rule).
export function paymentLink(raw) {
  const t = String(raw ?? '').trim();
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(t)) return '';
  try { return new URL(t).href; } catch { return ''; }
}
// Whether an account can take a payment (paymentLinks.takesPayments's rule).
export const takesPayments = (a) => !!a && a.account_type === 'payment_service'
  && (!!paymentLink(a.payment_link) || !!String(a.payment_instructions ?? '').trim());

export const PAY_STAGES = ['fee', 'deposit', 'payments', 'final'];
export const PAY_STAGE_LABELS = { fee: 'Application fee', deposit: 'Deposit', payments: 'Payments', final: 'Final' };
// At most this many choices on one payment (the server's limit too).
export const PAY_MAX = 8;
export const FAMILY_LABEL_MAX = 60;

const text = (v) => String(v ?? '').trim();
const cents = (n) => Math.round(Number(n) * 100) / 100;

// What families see an account as: her family label, else its name.
export const methodLabel = (a) => text(a?.family_label).slice(0, FAMILY_LABEL_MAX) || text(a?.name).slice(0, FAMILY_LABEL_MAX) || 'Payment';

// The ids she listed for a stage, or null when that list isn't set (an empty list
// counts as not set: that payment works as before). The fee falls back to the one
// fee account she picked before lists existed.
export function stageIds(kennel, stage) {
  const list = kennel?.pay_methods?.[stage];
  if (Array.isArray(list) && list.length) return list.filter((id) => typeof id === 'string' && id);
  if (stage === 'fee' && kennel?.waitlist_fee_account_id) return [kennel.waitlist_fee_account_id];
  return null;
}

// Whether she set a list for this stage herself (not the fee account fallback).
export const hasOwnList = (kennel, stage) => Array.isArray(kennel?.pay_methods?.[stage]) && kennel.pay_methods[stage].length > 0;

// The accounts families may use for a stage, in her order: live, taking payments,
// not turned off for this family (`off`: WaitlistEntry.pay_methods_off, Phase 2). [] when none; null when no list
// is set (the caller keeps her text).
export function methodsFor(stage, kennel, accounts = [], { off = [] } = {}) {
  const ids = stageIds(kennel, stage);
  if (!ids) return null;
  const byId = new Map(accounts.filter(Boolean).map((a) => [a.id, a]));
  const skip = new Set(off);
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    const a = byId.get(id);
    if (!a || seen.has(id) || skip.has(id) || a.is_archived || !takesPayments(a)) continue;
    seen.add(id);
    out.push(a);
  }
  return out.slice(0, PAY_MAX);
}

// --- Methods per kind of charge (owner, 2026-11-25: D25) ---------------------------
// Her stage lists say WHEN a method is offered; Kennel.pay_methods.charges says WHAT
// it may pay: { price?, boarding?, transport?, extras?: [accountId…] }, a kind with a
// list taking only those methods ("boarding is cash only"), a kind without one any
// method on the stage's list. Only the payments after the deposit (`payments`,
// `final`) follow it: the fee and the deposit are their own lists. One payment whose
// charges take different methods is split into parts (payGroups), each with its own
// choices: "$2,550 puppy price and transport: Zelle or Card · $250 boarding: Cash".
export const CHARGE_KINDS = ['price', 'boarding', 'transport', 'extras'];
export const CHARGE_KIND_LABELS = { price: 'Puppy price', boarding: 'Boarding', transport: 'Transport', extras: 'Extras' };
const CHARGE_STAGES = ['payments', 'final'];
const SERVICE_FEE_KIND = { service_fee_deposit: 'price', service_fee_puppy: 'price', service_fee_boarding: 'boarding', service_fee_transport: 'transport', service_fee_extras: 'extras' };
// A statement charge's kind ({ key, component }, paymentSchedule.saleCharges): its
// service fee goes with it.
export function chargeKindOf(c) {
  const comp = c?.component;
  if (comp === 'deposit' || comp === 'balance') return 'price';
  if (comp === 'boarding' || comp === 'transport') return comp;
  if (comp === 'service_fee') return SERVICE_FEE_KIND[c.key] || 'extras';
  return 'extras';
}

// The final payment takes only its own list, whatever it's for (owner, 2026-11-26):
// "final payments are cash or Zelle", boarding and all. `pay_methods.final_own_list`.
export const finalOwnList = (kennel) => kennel?.pay_methods?.final_own_list === true;

// Her limits, cleaned: { kind: [ids] } for kinds she limited.
export function chargeLimits(kennel) {
  const raw = kennel?.pay_methods?.charges;
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of CHARGE_KINDS) {
    // An empty list (no method ticked for that kind) limits nothing.
    const ids = Array.isArray(raw[k]) ? [...new Set(raw[k].filter((id) => typeof id === 'string' && id))] : [];
    if (ids.length) out[k] = ids;
  }
  return out;
}
export const hasChargeLimits = (kennel) => Object.keys(chargeLimits(kennel)).length > 0;

// The methods one kind of charge may be paid with at a stage: the stage's list (her
// order, the family's off ones out), less any method she didn't tick for that kind.
// null when the stage has no list.
export function methodsForCharge(stage, kind, kennel, accounts = [], { off = [] } = {}) {
  const list = methodsFor(stage, kennel, accounts, { off });
  if (!list || !CHARGE_STAGES.includes(stage) || (stage === 'final' && finalOwnList(kennel))) return list;
  const limit = chargeLimits(kennel)[kind];
  const kept = limit ? list.filter((a) => limit.includes(a.id)) : list;
  // None of its methods on this stage's list (or all off for this family): the stage's
  // list, so the charge can still be paid.
  return kept.length ? kept : list;
}

// "Puppy price", "Puppy price and transport", "Puppy price, boarding and transport".
export function kindsLabel(kinds) {
  const words = CHARGE_KINDS.filter((k) => kinds.includes(k)).map((k, i) => (i === 0 ? CHARGE_KIND_LABELS[k] : CHARGE_KIND_LABELS[k].toLowerCase()));
  return words.length <= 1 ? words[0] || '' : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

// One payment split by the methods its charges take. `pieces`: what the payment is
// for, [{ key, component, owed }] (paymentSchedule.nextPieces). → null when the stage
// has no list (her text, as before); else [{ kinds, keys, label, amount, methods }],
// in kind order, one per set of methods: a single part when every charge takes the
// same ones. A part's `keys` are the charges it pays (Record a payment's Toward).
export function payGroups(stage, pieces, kennel, accounts = [], { off = [] } = {}) {
  if (!methodsFor(stage, kennel, accounts, { off })) return null;
  const owed = new Map();
  const keys = new Map();
  for (const p of pieces || []) {
    if (!(Number(p?.owed) > 0)) continue;
    const k = chargeKindOf(p);
    owed.set(k, cents((owed.get(k) || 0) + Number(p.owed)));
    if (!keys.has(k)) keys.set(k, []);
    if (!keys.get(k).includes(p.key)) keys.get(k).push(p.key);
  }
  const groups = new Map();
  for (const k of CHARGE_KINDS.filter((x) => owed.has(x))) {
    const methods = methodsForCharge(stage, k, kennel, accounts, { off });
    const sig = methods.map((a) => a.id).join('|');
    if (!groups.has(sig)) groups.set(sig, { kinds: [], keys: [], amount: 0, methods });
    const g = groups.get(sig);
    g.kinds.push(k);
    g.keys.push(...keys.get(k));
    g.amount = cents(g.amount + owed.get(k));
  }
  return [...groups.values()].map((g) => ({ ...g, label: kindsLabel(g.kinds) }));
}

// "$2,550", "$250.50" (her messages and invoices, a part's amount).
export function moneyText(n) {
  const a = Math.round(Number(n) * 100) / 100;
  return `$${a.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(a) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

// The stage of a family's next payment (paymentSchedule.familyPaymentsView's
// `next`): the deposit, the final payment (the schedule's last due date, or the
// balance), else one of the payments between.
export function stageOfNext(next) {
  if (!next) return null;
  if (next.deposit) return 'deposit';
  return next.final ? 'final' : 'payments';
}

const host = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
export const isStripeLink = (url) => /(^|\.)stripe\.com$/.test(host(url));

// A link with the amount filled in, where the service takes it in the address:
// paypal.me/<name> → paypal.me/<name>/<amount>, cash.app/$tag → cash.app/$tag/<amount>.
// → { url, exact } (`exact`: the link asks for that amount).
export function linkForAmount(url, amount) {
  const link = paymentLink(url);
  if (!link) return { url: '', exact: false };
  const a = cents(amount);
  if (!(a > 0)) return { url: link, exact: false };
  let u;
  try { u = new URL(link); } catch { return { url: link, exact: false }; }
  const h = u.hostname.toLowerCase().replace(/^www\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  const amt = Number.isInteger(a) ? String(a) : a.toFixed(2);
  if ((h === 'paypal.me' && parts.length >= 1 && parts.length <= 2)
    || (h === 'paypal.com' && parts[0] === 'paypalme' && parts.length >= 2 && parts.length <= 3)) {
    const name = h === 'paypal.me' ? parts[0] : parts[1];
    u.pathname = h === 'paypal.me' ? `/${name}/${amt}` : `/paypalme/${name}/${amt}`;
    return { url: u.href, exact: true };
  }
  if (h === 'cash.app' && parts.length >= 1 && parts.length <= 2 && parts[0].startsWith('$')) {
    u.pathname = `/${parts[0]}/${amt}`;
    return { url: u.href, exact: true };
  }
  return { url: link, exact: false };
}

// The choices a family sees for one payment of `amount` (null = not known yet,
// e.g. a pick her device hasn't recorded): one per method, in her order.
//   madeLink(account) → a Stripe link KennelOS made for exactly this amount, or null
//   savings(account)  → her payment-method discount through it ({ amount, label }) or
//                       null (Phase 5, §5.4, discounts.methodSavings)
// → [{ label, kind: 'link' | 'text', url?, exact?, instructions?, amount?, discount?,
//      discount_label? }]  `amount`: what paying that way costs, its discount off.
// `url` is the base link: the server adds the family's id to a Stripe link.
export function payOptions(methods, amount, { madeLink = null, savings = null } = {}) {
  const a = amount == null || amount === '' ? null : cents(amount);
  return (methods || []).map((acct) => {
    const save = a != null && a > 0 && savings ? savings(acct) : null;
    const off = save && save.amount > 0 && save.amount < a ? cents(save.amount) : 0;
    const pays = a != null ? cents(a - off) : null;
    const made = madeLink && !off ? madeLink(acct) : null;
    const own = linkForAmount(acct.payment_link, pays);
    const url = made || own.url;
    const note = text(acct.payment_instructions).slice(0, 1000);
    return {
      label: methodLabel(acct),
      kind: url ? 'link' : 'text',
      ...(url ? { url, exact: Boolean(made) || own.exact } : {}),
      ...(note ? { instructions: note } : {}),
      ...(pays != null && pays > 0 ? { amount: pays } : {}),
      ...(off ? { discount: off, discount_label: text(save.label).slice(0, 120) } : {})
    };
  }).filter((o) => o.url || o.instructions);
}

// Her side: the methods for a stage as words ("Zelle, PayPal or Cash"), or '' when
// no list is set or none is left.
export function methodNames(methods) {
  const names = (methods || []).map(methodLabel);
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

// Her side, printed (invoices): one line per method, its link and instructions.
// → [{ label, link, note }]
export function methodLines(methods) {
  return (methods || []).map((a) => ({ label: methodLabel(a), link: paymentLink(a.payment_link) || '', note: text(a.payment_instructions) }));
}

// Settings: her lists as saved, kept to accounts that exist, each id once, in the
// order given. `rows`: [{ id, stages: Set|string[], kinds? }] in her order. → pay_methods
// with every stage present (an empty list = works as before), and `charges` when she
// limited a kind.
// `kinds` (optional, Set|string[]): the kinds of charge it may pay (D25); a kind some
// row on her payments or final lists leaves unticked gets a list in `charges` of the
// rows that tick it. A row without `kinds` pays every kind.
export function readPayMethods(rows = [], { finalOwn = false } = {}) {
  const out = Object.fromEntries(PAY_STAGES.map((s) => [s, []]));
  for (const r of rows) {
    if (!r?.id) continue;
    const on = new Set(r.stages || []);
    for (const s of PAY_STAGES) if (on.has(s) && !out[s].includes(r.id)) out[s].push(r.id);
  }
  const later = rows.filter((r) => r?.id && CHARGE_STAGES.some((s) => out[s].includes(r.id)));
  const kindsOf = (r) => (r.kinds ? new Set(r.kinds) : new Set(CHARGE_KINDS));
  const charges = {};
  for (const k of CHARGE_KINDS) {
    const ids = later.filter((r) => kindsOf(r).has(k)).map((r) => r.id);
    // Every method takes it, or none does (limits nothing): no list.
    if (ids.length === later.length || !ids.length) continue;
    charges[k] = ids;
  }
  if (Object.keys(charges).length) out.charges = charges;
  if (finalOwn) out.final_own_list = true;
  return out;
}

// Her settings' rows: every live Payment service account, the ones on her lists
// first in her order, then the rest by name. → [{ account, stages: Set }]
export function payMethodRows(kennel, accounts = []) {
  const live = accounts.filter((a) => a && a.account_type === 'payment_service' && !a.is_archived);
  const order = [];
  for (const s of PAY_STAGES) for (const id of kennel?.pay_methods?.[s] || []) if (!order.includes(id)) order.push(id);
  const rank = (a) => (order.includes(a.id) ? order.indexOf(a.id) : order.length);
  const limits = chargeLimits(kennel);
  return live
    .sort((x, y) => rank(x) - rank(y) || text(x.name).localeCompare(text(y.name)))
    .map((a) => ({ account: a, stages: new Set(PAY_STAGES.filter((s) => (kennel?.pay_methods?.[s] || []).includes(a.id))),
      kinds: new Set(CHARGE_KINDS.filter((k) => !limits[k] || limits[k].includes(a.id))) }));
}

// The fee account older builds (and the Stripe fee links) read, from her fee list:
// the first Stripe account on it, else the first with a link, else the first.
export function feeAccountFromList(ids, accounts = []) {
  const list = (ids || []).map((id) => accounts.find((a) => a && a.id === id)).filter(Boolean);
  const pick = list.find((a) => isStripeLink(a.payment_link)) || list.find((a) => paymentLink(a.payment_link)) || list[0];
  return pick ? pick.id : null;
}

// "Add Cash" in one tap (D7): a Payment service account for cash at pickup, no fee.
export const CASH_ACCOUNT = Object.freeze({ name: 'Cash', account_type: 'payment_service', family_label: 'Cash', payment_instructions: 'Cash at pickup' });

// Her side: how the final payment is paid, in words. Her final list's methods by
// name once she lists them ("Zelle or Cash"), else her text (final_payment_methods).
// `off`: the family's turned-off methods (Phase 2).
export function finalMethodsText(kennel, accounts = [], { off = [] } = {}) {
  const names = hasOwnList(kennel, 'final') ? methodNames(methodsFor('final', kennel, accounts, { off })) : '';
  return names || text(kennel?.final_payment_methods);
}

// Her website (Payment Methods plan §4; Website Contract plan C11): every method she
// accepts at any stage of a sale, once each, in the order she first lists it, with the
// stages it's accepted for. Her own link as stored (no amount: the website isn't one
// family's payment) and her instructions. Only stages she listed herself.
// → [{ label, url?, note?, stages: ['application_fee' | 'deposit' | 'payments' | 'final_payment'] }]
// With `charges` (Website Contract plan C13, section pay_charges), each also carries
// `key` (its Account id, the same id `products` sends, so her website's names for it
// survive a rename) and `pays`: the kinds of charge it may pay on the payments after the
// deposit, per stage, as families are offered them (websitePays).
export const WEBSITE_STAGE = { fee: 'application_fee', deposit: 'deposit', payments: 'payments', final: 'final_payment' };
export const WEBSITE_METHODS_MAX = 12;
// `discountLabel` (Phase 5): her payment-method discount's name, for each method ticked
// Discounted (`discount`), with `charges`.
export function websiteMethods(kennel, accounts = [], { charges = false, discountLabel = '' } = {}) {
  const byId = new Map();
  for (const stage of PAY_STAGES) {
    if (!hasOwnList(kennel, stage)) continue;
    for (const a of methodsFor(stage, kennel, accounts) || []) {
      if (!byId.has(a.id)) byId.set(a.id, { account: a, stages: [] });
      byId.get(a.id).stages.push(WEBSITE_STAGE[stage]);
    }
  }
  const pays = charges ? websitePays(kennel, accounts) : null;
  return [...byId.values()].slice(0, WEBSITE_METHODS_MAX).map(({ account: a, stages }) => {
    const url = paymentLink(a.payment_link);
    const note = text(a.payment_instructions);
    return {
      label: methodLabel(a), ...(url ? { url } : {}), ...(note ? { note } : {}), stages,
      ...(pays ? { key: a.id, pays: pays.get(a.id) || {} } : {}),
      ...(pays && discountLabel && a.discounted_method === true ? { discount: discountLabel } : {})
    };
  });
}

// What each method may pay on the payments after the deposit (D25, D26), for her
// website: Map accountId → { payments?: [kind…], final_payment?: [kind…] }, kinds in
// CHARGE_KINDS order. Worked out with methodsForCharge, so a limit no method on a list
// meets (the charge falls back to the whole list) and the final payment's own list read
// exactly as families are offered them. A stage she hasn't listed herself is left out.
// The fee and the deposit pay only themselves (their own lists), so they aren't in it.
export function websitePays(kennel, accounts = []) {
  const out = new Map();
  for (const stage of CHARGE_STAGES) {
    if (!hasOwnList(kennel, stage)) continue;
    for (const kind of CHARGE_KINDS) {
      for (const a of methodsForCharge(stage, kind, kennel, accounts) || []) {
        if (!out.has(a.id)) out.set(a.id, {});
        const p = out.get(a.id);
        (p[WEBSITE_STAGE[stage]] ||= []).push(kind);
      }
    }
  }
  return out;
}

// --- One family (Phase 2, §2.4) ---------------------------------------------------

// The methods she turned off for one family (WaitlistEntry.pay_methods_off): ids,
// each once. A family with no record (a buyer without a status page) has none.
export function offFor(entry) {
  const list = entry?.pay_methods_off;
  return Array.isArray(list) ? [...new Set(list.filter((id) => typeof id === 'string' && id))] : [];
}
