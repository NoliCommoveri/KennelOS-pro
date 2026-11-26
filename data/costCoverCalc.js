// costCoverCalc.js — the Covering payment costs calculator (Payment Methods plan §5.3,
// Phase 4): the percent that covers what getting paid costs her, from her methods'
// rates and how she's usually paid. Pro-only (the Kennel page's card), kept apart from
// costCover.js so the light pages don't carry it. Pure; no db.

const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
const cents = (n) => Math.round(n * 100) / 100;

// --- The calculator (§5.3) --------------------------------------------------------------

// The percent that covers what getting paid costs, worked out on the whole total so it
// covers the cost of itself (fee on the fee): f = (r + fixed ÷ price) ÷ (1 − r).
//   methods   [{ percent, fixed, share }]  each method's rate and share of the money
//             (shares are normalized; 'costliest' uses the one with the highest cost)
//   mode      'mix' | 'costliest'
//   instant   { share, percent }  the share of money moved out instantly and its rate
//   perSale   a fixed cost per sale
//   price     the typical price; payments  payments per sale (each pays a method's fixed part)
// → { cost, percent, onPrice, price } (cost and percent in %, onPrice in dollars), or
//   null without a price or a method.
export function workItOut({ methods = [], mode = 'mix', instant = null, perSale = 0, price = 0, payments = 1 } = {}) {
  const P = num(price);
  const n = Math.max(1, Math.round(num(payments)) || 1);
  const list = methods.map((m) => ({ percent: num(m.percent), fixed: num(m.fixed), share: Math.max(0, num(m.share)) })).filter((m) => m.percent >= 0 && m.percent < 100);
  if (!(P > 0) || !list.length) return null;
  const costOf = (m) => m.percent / 100 + (m.fixed * n) / P;
  let r;
  let fixed;
  if (mode === 'costliest') {
    const top = list.reduce((a, b) => (costOf(b) > costOf(a) ? b : a));
    r = top.percent / 100;
    fixed = top.fixed * n;
  } else {
    const total = list.reduce((t, m) => t + m.share, 0);
    const w = (m) => (total > 0 ? m.share / total : 1 / list.length);
    r = list.reduce((t, m) => t + w(m) * m.percent / 100, 0);
    fixed = list.reduce((t, m) => t + w(m) * m.fixed * n, 0);
  }
  r += Math.max(0, Math.min(num(instant?.share), 100)) / 100 * Math.max(0, num(instant?.percent)) / 100;
  fixed += Math.max(0, num(perSale));
  if (!(r < 1)) return null;
  const cost = r + fixed / P;
  const f = cost / (1 - r);
  // Rounded UP to a tenth of a percent, so it never falls short.
  const percent = Math.ceil(f * 1000 - 1e-6) / 10;
  return { cost: Math.round(cost * 10000) / 100, percent, onPrice: cents(P * percent / 100), price: cents(P) };
}

// Each account's share of the money she received through it since `since` (YYYY-MM-DD),
// from the account recorded on each payment: a sale's deposit (deposit_paid_via_account_id),
// its payments (payments[].account_id) and its balance (balance_paid_via_account_id).
// → Map accountId → dollars.
export function receivedByAccount(sales = [], since = '0000-00-00') {
  const out = new Map();
  const add = (id, amount, date) => {
    if (!id || !(num(amount) > 0) || !date || String(date) < since) return;
    out.set(id, cents((out.get(id) || 0) + num(amount)));
  };
  for (const s of sales) {
    if (!s || s.is_archived) continue;
    add(s.deposit_paid_via_account_id, s.deposit_amount, s.deposit_date);
    for (const p of Array.isArray(s.payments) ? s.payments : []) add(p?.account_id, p?.amount, p?.date);
    if (s.balance_paid_via_account_id && s.balance_paid_date) {
      const paidOther = num(s.deposit_amount) + (Array.isArray(s.payments) ? s.payments.reduce((t, p) => t + num(p?.amount), 0) : 0);
      add(s.balance_paid_via_account_id, Math.max(num(s.price) - paidOther, 0), s.balance_paid_date);
    }
  }
  return out;
}

// Which payments' methods a kind's calculator starts from (§5.3 step 1).
export const CALC_STAGES = { puppy: ['deposit', 'payments', 'final'], extras: ['payments', 'final'], transport: ['payments', 'final'], boarding: ['payments', 'final'], stud: null };
