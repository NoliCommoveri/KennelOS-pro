// paymentSchedule.js — a sale's payment schedule and the one money statement every
// surface reads (Payment Schedule plan §3–§4). Pure: no db, no repos.
//
// Stored on the sale:
//   payment_schedule  [{ id, label?, due, n?, due_date?, covers, percent?, basis?,
//                        amount?, prior_funds? }]  (vocab SCHEDULE_DUE / _COVERS /
//                        _BASIS / _PRIOR_FUNDS). None stored = one due date, all of
//                        it, on balance_due_date (else at pickup): today's sale.
//   payments          [{ id, amount, date, method?, account_id?, reference?, note?,
//                        toward? }]  money beyond the deposit; `toward` blank = the
//                        schedule, or `extra:<id>:<step id>` = an own-dated extra's step.
//
// Nothing about how money is used is stored: paymentStatement works it out, every
// time, in two passes.
//  1. Which CHARGE each piece of money pays (allocateMoney, shared with the waitlist's
//     credits for funds received): the application fee credit first, then credits
//     (oldest first, only toward the uses they're ticked for), the deposit, own-dated
//     extras' paid steps, payments (date order), then "paid in full". Charges are paid
//     in order: deposit, price, boarding, extras, transport ALWAYS LAST (D16).
//  2. What each DUE DATE has taken: each due date asks for a slice of the schedule's
//     money (its threshold, the total to be paid by then, less the one before). Money
//     fills the slices in order, oldest first. A "doesn't count" due date (percent of
//     remaining, or an amount set that way) never takes earlier money: the application
//     fee, the deposit, credits (D18). "Remaining" is measured against what the
//     earlier due dates asked for, so paying early never shrinks it (D19).
import { saleExtraCharges, stepLabel, stepDueDate } from './extraCharges.js';
import { pricedSale, serviceFeeCharges, COVER_SCHEDULE, COVER_USE } from './costCover.js';
import { saleDiscounts } from './discounts.js';
import { addDaysToYMD, addOpenDays } from './dateUtils.js';
import { SCHEDULE_DUE, SCHEDULE_COVERS, INVOICE_LINE_LABELS, RELEASED_SALE_STATUSES } from './vocab.js';

const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
const cents = (n) => Math.round(n * 100) / 100;
const text = (v) => String(v ?? '').trim();
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ymd = (v) => (typeof v === 'string' && YMD.test(v) ? v : null);
const count = (v) => {
  const n = Number(v);
  return v === '' || v == null || !Number.isFinite(n) || n < 0 ? null : Math.round(n);
};

const DUE_VALUES = SCHEDULE_DUE.map((d) => d.value);
const NEEDS_N = new Set(SCHEDULE_DUE.filter((d) => d.needsN).map((d) => d.value));
const COVER_VALUES = SCHEDULE_COVERS.map((c) => c.value);
export const DUE_SOON_DAYS = 7;

// --- The allocator (shared with receivedCredits.allocateCredits) ---------------------

// A running ledger over charges ([{ key, use?, amount }], in the order they're paid).
// `pay(amount, accepts)` spends up to `amount` over the charges `accepts(charge)`
// takes, in order, and returns [{ key, amount }].
export function moneyLedger(charges) {
  const left = new Map(charges.map((c) => [c.key, cents(num(c.amount))]));
  return {
    left: (key) => left.get(key) || 0,
    pay(amount, accepts = () => true) {
      let have = cents(num(amount));
      const pays = [];
      for (const ch of charges) {
        if (!(have > 0)) break;
        if (!accepts(ch)) continue;
        const take = cents(Math.min(have, left.get(ch.key)));
        if (!(take > 0)) continue;
        left.set(ch.key, cents(left.get(ch.key) - take));
        pays.push({ key: ch.key, amount: take });
        have = cents(have - take);
      }
      return pays;
    }
  };
}

// Spread money items over charges, in order. Each item may name the charge uses it
// can pay (`uses`, as a credit's applies_to); none = any.
// → { byKey: { key: amount }, perItem: { id: [{ key, amount }] }, applied }
export function allocateMoney(items, charges) {
  const ledger = moneyLedger(charges);
  const byKey = {};
  const perItem = {};
  for (const it of items) {
    const pays = ledger.pay(it.amount, (ch) => !it.uses || it.uses.includes(ch.use));
    perItem[it.id] = pays;
    for (const p of pays) byKey[p.key] = cents((byKey[p.key] || 0) + p.amount);
  }
  return { byKey, perItem, applied: cents(Object.values(byKey).reduce((t, v) => t + v, 0)) };
}

// --- The schedule as stored -----------------------------------------------------------

function cleanCovers(covers) {
  if (!Array.isArray(covers)) return null;
  if (covers.includes('all')) return ['all'];
  const out = [...new Set(covers.filter((c) => COVER_VALUES.includes(c) || (typeof c === 'string' && /^extra:.+/.test(c))))];
  return out.length ? out : null;
}

const isFinalStep = (st) => st.covers.length === 1 && st.covers[0] === 'all' && st.percent === 100 && st.basis === 'total';

// --- What each due date collects, charge by charge (§12, D39) ------------------------
// A due date with `shares` lists what it collects per kind of charge (or one extra):
//   { charge: 'price'|'boarding'|'extras'|'transport'|'extra:<id>',
//     how: 'full'|'percent'|'amount'|'rest', value? }
// 'full' / 'rest': all of it by this date; 'percent': at least that percent of it paid
// by this date (what's paid on it counts: the deposit toward the price); 'amount': $X
// more of it than the earlier due dates asked. `new_money: true` on the due date: only
// payments recorded fill it, never the fee credit, the deposit or credits (D10, D18),
// and a percent is of what the earlier due dates left.
export const SHARE_HOWS = ['full', 'percent', 'amount', 'rest'];
export const CHARGE_KIND_ORDER = ['price', 'boarding', 'extras', 'transport'];
// At most this many due dates on a schedule, the final one included (D43).
export const SCHEDULE_MAX = 10;

function cleanShares(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const sh of raw) {
    const charge = typeof sh?.charge === 'string' ? sh.charge : '';
    if (!(COVER_VALUES.includes(charge) || /^extra:.+/.test(charge)) || out.some((x) => x.charge === charge)) continue;
    if (!SHARE_HOWS.includes(sh.how)) continue;
    const value = cents(num(sh.value));
    if (sh.how === 'percent' && !(value > 0)) continue;
    if (sh.how === 'amount' && !(value > 0)) continue;
    out.push({ charge, how: sh.how, ...(sh.how === 'percent' ? { value: Math.min(value, 100) } : sh.how === 'amount' ? { value } : {}) });
  }
  return out.length ? out : null;
}

// Her order for money no due date names, and for a dollar amount across several kinds
// of charge (D40): the sale's, else price, boarding, extras, transport.
export function cleanPriority(raw) {
  const list = Array.isArray(raw) ? raw.filter((k) => CHARGE_KIND_ORDER.includes(k)) : [];
  return [...new Set([...list, ...CHARGE_KIND_ORDER])];
}

// The sale's due dates as stored, cleaned; the last always covers everything at 100%
// (one is added at pickup if it's missing). null = no schedule stored.
export function cleanSchedule(raw) {
  if (!Array.isArray(raw)) return null;
  const steps = [];
  for (const [i, st] of raw.entries()) {
    if (!st || typeof st !== 'object' || !DUE_VALUES.includes(st.due)) continue;
    const shares = cleanShares(st.shares);
    const covers = cleanCovers(st.covers) || (shares ? shares.map((x) => x.charge) : null);
    if (!covers) continue;
    const row = { id: text(st.id) || `due${i}`, due: st.due, covers };
    if (text(st.label)) row.label = text(st.label);
    if (NEEDS_N.has(st.due)) row.n = count(st.n) ?? 0;
    if (ymd(st.due_date)) row.due_date = st.due_date;
    const percent = cents(num(st.percent));
    const amount = cents(num(st.amount));
    // A due date with shares keeps its percent or amount too, for older builds.
    if (percent > 0) Object.assign(row, { percent: Math.min(percent, 100), basis: st.basis === 'remaining' ? 'remaining' : 'total' });
    else if (amount > 0) Object.assign(row, { amount, prior_funds: st.prior_funds === 'dont_count' ? 'dont_count' : 'count' });
    else if (!shares) continue;
    // One dollar amount across what it covers, paid in her priority order (§12.3).
    if (!shares && row.amount != null && st.pooled === true) row.pooled = true;
    if (shares) {
      row.shares = shares;
      if (st.new_money === true) row.new_money = true;
    }
    steps.push(row);
  }
  if (!steps.length) return null;
  if (!isFinalStep(steps[steps.length - 1])) steps.push({ id: 'final', due: 'at_pickup', covers: ['all'], percent: 100, basis: 'total' });
  return steps;
}

// A sale with no schedule stored: one due date, everything, on its balance due date,
// else at pickup.
export function defaultSchedule(sale) {
  const on = ymd(sale?.balance_due_date);
  return [{ id: 'final', due: on ? 'on_date' : 'at_pickup', ...(on ? { due_date: on } : {}), covers: ['all'], percent: 100, basis: 'total' }];
}

export const hasSchedule = (sale) => Boolean(cleanSchedule(sale?.payment_schedule));
export const scheduleOf = (sale) => cleanSchedule(sale?.payment_schedule) || defaultSchedule(sale);

// When a due date falls: a date she typed wins; otherwise worked out now from the
// pup's birth date or the pickup date (so it follows them until she types one).
// null = not known yet.
export function dueDateOf(step, { birthDate = null, pickupDate = null, openDays } = {}) {
  if (ymd(step.due_date)) return step.due_date;
  if (step.due === 'at_weeks') return ymd(birthDate) ? addDaysToYMD(birthDate, (step.n || 0) * 7) : null;
  if (step.due === 'before_pickup') return ymd(pickupDate) ? addOpenDays(pickupDate, -(step.n || 0), openDays) : null;
  if (step.due === 'at_pickup') return ymd(pickupDate) || null;
  return null;
}

// --- The sale's charges ---------------------------------------------------------------

// Deferred boarding: amount × a count of frequency units (as incomeView reads it).
// With payment-fee prices, its cost-cover share rides on it (costCover.pricedSale).
function boardingTotal(sale) {
  const n = parseInt(sale.deferred_boarding_duration_days, 10);
  return cents(num(sale.deferred_boarding_amount) * (Number.isFinite(n) && n > 0 ? n : 1) + num(sale.__boarding_cover));
}

// The sale's charges in the order money pays them: deposit, price, boarding, extras on
// the schedule, extras on their own dates, transport last. Each is
// { key, component, label, amount, part: 'deposit'|'schedule'|'own', use, covers?,
//   extraId?, step? }. `use` is the credit use that may pay it (CREDIT_USES).
// An extra is on its own dates when it's flagged so (`own_due_dates`). On a sale with
// a schedule stored, every other extra is on the schedule, its own steps not used for
// dates (`steps` keeps them, so a step marked paid still counts). With no schedule,
// an extra with its own steps keeps them, as before schedules (D2).
// A fee charged back (`fee_for`, extraCharges.isFeeChargeBack) is always on the
// schedule and owed only on the LAST due date (`finalOnly`; coveredTotal), after the
// other extras and before transport: every payment's fee is collected at the end.
// Covering payment costs (costCover.js, Payment Methods plan §5.2): with payment-fee
// prices each charge already carries its share (pricedSale); with service fees each
// kind's fee is its own charge right after the charge it's on, owed with it
// (component 'service_fee', key `service_fee_<kind>`, its covers the charge's).
// The puppy fee's share on the deposit (D30, `service_fee_deposit`) is part of the
// deposit: owed with it, paid by the deposit.
export function saleCharges(raw, schedule = scheduleOf(raw)) {
  const sale = pricedSale(raw);
  const feeRows = serviceFeeCharges(raw);
  const asCharge = (f) => ({ key: f.key, component: 'service_fee', kind: f.kind, label: f.label, amount: f.amount, part: f.deposit ? 'deposit' : 'schedule', use: f.deposit ? 'deposit' : COVER_USE[f.kind], covers: COVER_SCHEDULE[f.kind], ...(f.refundable ? {} : { nonrefundable: true }) });
  const fees = new Map(feeRows.filter((f) => !f.deposit).map((f) => [f.kind, asCharge(f)]));
  const depositFee = feeRows.filter((f) => f.deposit).map(asCharge);
  const fee = (kind) => (fees.has(kind) ? [fees.get(kind)] : []);
  const scheduled = hasSchedule(sale);
  const price = num(sale?.price);
  const deposit = cents(num(sale?.deposit_amount));
  const out = [];
  if (deposit > 0) out.push({ key: 'deposit', component: 'deposit', label: INVOICE_LINE_LABELS.deposit, amount: deposit, part: 'deposit', use: 'deposit', covers: 'price' }, ...depositFee);
  // With payment-fee prices the deposit already carries its share (pricedSale), so the
  // rest of the price is what's left.
  const balance = cents(Math.max(price - deposit, 0));
  if (balance > 0) out.push({ key: 'balance', component: 'balance', label: INVOICE_LINE_LABELS.balance, amount: balance, part: 'schedule', use: 'price', covers: 'price' });
  out.push(...fee('puppy'));
  const boarding = boardingTotal(sale || {});
  if (boarding > 0) out.push({ key: 'boarding', component: 'boarding', label: INVOICE_LINE_LABELS.boarding, amount: boarding, part: 'schedule', use: 'extras', covers: 'boarding' });
  out.push(...fee('boarding'));
  const own = [];
  const feesBack = [];
  for (const x of saleExtraCharges(sale)) {
    if (x.fee_for) {
      feesBack.push({ key: `extra:${x.id}`, component: 'extra', label: x.label, amount: x.amount, part: 'schedule', use: 'extras', covers: 'fees', extraId: x.id, finalOnly: true, feeFor: x.fee_for });
      continue;
    }
    const ownDates = x.own_due_dates === true || (Array.isArray(x.payments) && !scheduled);
    if (!ownDates) {
      out.push({ key: `extra:${x.id}`, component: 'extra', label: x.label, amount: x.amount, part: 'schedule', use: 'extras', covers: 'extras', extraId: x.id, ...(Array.isArray(x.payments) ? { steps: x.payments } : {}) });
    } else if (Array.isArray(x.payments)) {
      for (const st of x.payments) own.push({ key: `extra:${x.id}:${st.id}`, component: 'extra', label: stepLabel(x, st), amount: st.amount, part: 'own', use: 'extras', extraId: x.id, step: st });
    } else {
      own.push({ key: `extra:${x.id}`, component: 'extra', label: x.label, amount: x.amount, part: 'own', use: 'extras', extraId: x.id });
    }
  }
  out.push(...fee('extras'), ...feesBack, ...own);
  const transport = cents(num(sale?.transport_fee));
  if (transport > 0) out.push({ key: 'transport', component: 'transport', label: INVOICE_LINE_LABELS.transport, amount: transport, part: 'schedule', use: 'extras', covers: 'transport' });
  out.push(...fee('transport'));
  return out;
}

// The deposit a sale asks for (D30): the deposit with its share of her payment costs
// (raised, or its service fee beside it). null when the sale has no deposit set.
export function depositTotal(sale) {
  if (sale?.deposit_amount === '' || sale?.deposit_amount == null || !Number.isFinite(Number(sale.deposit_amount))) return null;
  return cents(saleCharges(sale).filter((c) => c.part === 'deposit').reduce((t, c) => t + c.amount, 0)) || cents(num(sale.deposit_amount));
}

// What a due date's covers add up to, from the sale's deposit and schedule charges.
// `price` is the whole price: deposit + balance. A fee charged back counts only on
// the last due date (`final`).
export function coveredTotal(covers, charges, { final = false } = {}) {
  const sched = charges.filter((c) => c.part !== 'own' && (final || !c.finalOnly));
  const pick = covers.includes('all') ? sched
    : sched.filter((c) => covers.includes(c.covers) || (c.extraId && covers.includes(`extra:${c.extraId}`)));
  return cents(pick.reduce((t, c) => t + c.amount, 0));
}

// --- Paid flags (as incomeView reads them) ---------------------------------------------

const depositPaid = (s) => !!s.deposit_date || ['deposit_paid', 'paid_in_full', 'delivered'].includes(s.status);
const balancePaid = (s) => !!s.balance_paid_date || ['paid_in_full', 'delivered'].includes(s.status);

export function cleanPayments(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && typeof p === 'object' && num(p.amount) > 0 && ymd(p.date))
    .map((p, i) => ({ ...p, id: text(p.id) || `pay${i}`, amount: cents(num(p.amount)) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

function statusOf(owed, date, today) {
  if (!(owed > 0)) return 'met';
  if (!date) return 'no_date';
  if (date < today) return 'not_received';
  return date <= addDaysToYMD(today, DUE_SOON_DAYS) ? 'due_soon' : 'upcoming';
}

// --- The statement ---------------------------------------------------------------------

// Everything about a sale's money, worked out once. Options:
//   birthDate, pickupDate, openDays   for dating due dates
//   today                             YYYY-MM-DD (status)
//   feeCredit  { amount, toward: 'deposit'|'balance', date? }  the application fee
//              received and credited toward the purchase (incomeView.feeCreditOf)
//   credits    the family's credits for funds received, cleaned (receivedCredits.creditsOf)
//   feeCharges the application fee as a charge credits may pay (receivedCredits.feeCharge)
//   depositDueDate  when the deposit was asked for (shown while it's owed)
// →
// { ended, hasSchedule, charges, total, paid, remaining,
//   fee: { charged, credited } | null,
//   received: [{ kind: 'fee'|'credit'|'discount'|'deposit'|'step'|'payment'|'paid_in_full', id,
//                date, amount, unapplied, method?, discount_label?, pays: [{ key, amount, label }] }],
//             A discount (Sale.discounts, discounts.js) is money toward what's owed: one
//             with a payment goes with it (the same date and toward, just before it), one
//             with the deposit pays the deposit's service fee first, and her own come off
//             the final payment (D27). Each labelled as she named it.
//   deposit: { amount, paid, owed, date, asked, status } | null,
//   dueDates: [{ id, label, step, date, coveredTotal, threshold, ask, filled, owed,
//                fresh, isFinal, status, from: [{ i, amount }] }],   (i: index in received)
//   ownDated: [{ key, label, amount, paid, owed, date, status }],
//   next: { kind: 'deposit'|'schedule'|'own', id, label, date, owed, isFinal } | null }
export function paymentStatement(sale, opts = {}) {
  const { birthDate = null, pickupDate = null, openDays, today = '0000-00-00', feeCredit = null, credits = [], feeCharges = [], depositDueDate = null } = opts;
  const s = sale || {};
  const ended = RELEASED_SALE_STATUSES.includes(s.status);
  const stored = cleanSchedule(s.payment_schedule);
  const schedule = stored || defaultSchedule(s);
  const charges = saleCharges(s, schedule);
  const byKey = new Map(charges.map((c) => [c.key, c]));
  // What each due date collects, charge by charge (§12): a schedule with shares, or a
  // stored one whose old math asks $0 where its charges still ask for money (D41).
  const priority = cleanPriority(s.payment_priority);
  const byShares = !ended && stored && (stored.some((st) => st.shares || st.pooled) || zeroCase(schedule, charges, priority));
  const targets = byShares ? shareTargets(schedule, charges, priority) : null;
  const labelOf = (key) => (key === 'fee' ? 'Application fee' : byKey.get(key)?.label || key);
  const ledger = moneyLedger([...feeCharges.map((c) => ({ ...c, use: 'fee' })), ...charges]);
  const received = [];
  const record = (item, pays, credited = false) => {
    const applied = cents(pays.reduce((t, p) => t + p.amount, 0));
    received.push({ ...item, amount: applied, unapplied: cents(Math.max(num(item.offered) - applied, 0)),
      pays: pays.map((p) => ({ ...p, label: item.discount_label || `${labelOf(p.key)}${credited ? ' (credited)' : ''}` })) });
  };
  // Her discounts (Payment Methods plan §5.4): with a payment, with the deposit, or her own.
  const payIds = new Set(cleanPayments(s.payments).map((p) => p.id));
  const discounts = saleDiscounts(s);
  // A discount pays its charges' service fees first (what it takes back), then the rest.
  const payDiscount = (amount, accepts) => {
    const fees = ledger.pay(amount, (ch) => ch.component === 'service_fee' && accepts(ch));
    const done = cents(fees.reduce((t, p) => t + p.amount, 0));
    return [...fees, ...ledger.pay(cents(amount - done), accepts)];
  };

  // 1. The application fee credited toward the purchase: the deposit first when her
  //    setting says so, else (and beyond the deposit) the rest of the price.
  const fc = feeCredit && num(feeCredit.amount) > 0 ? feeCredit : null;
  if (fc) {
    const keys = fc.toward === 'deposit' ? ['deposit', 'balance'] : ['balance'];
    const pays = ledger.pay(fc.amount, (ch) => keys.includes(ch.key));
    // Toward the final payment (owner, 2026-11-26): it fills the due dates from the last.
    record({ kind: 'fee', id: 'fee', date: ymd(fc.date), offered: num(fc.amount), ...(fc.toward === 'final' ? { last: true } : {}) }, pays, true);
  }
  // 2. Credits for funds received, oldest first, toward what each is ticked for.
  for (const cr of credits) {
    const pays = ledger.pay(cr.amount, (ch) => (cr.applies_to || []).includes(ch.use));
    record({ kind: 'credit', id: cr.id, date: ymd(cr.date), offered: num(cr.amount), ...(cr.note ? { note: cr.note } : {}) }, pays, true);
  }
  // 2b. Her own discounts (no payment, or one no longer on the sale): off the final
  //     payment (D27), filling the due dates from the last.
  for (const d of discounts.filter((x) => !x.payment_id || (x.payment_id !== 'deposit' && !payIds.has(x.payment_id)))) {
    record({ kind: 'discount', id: d.id, date: null, offered: d.amount, discount_label: d.label, last: true }, payDiscount(d.amount, (ch) => ch.part === 'schedule'));
  }
  // 3. The deposit she marked received: the whole deposit (its service fee with it,
  //    D30), less what the fee and credits already paid of it, and less the discount
  //    she gave with it (D31).
  const depKeys = charges.filter((c) => c.part === 'deposit').map((c) => c.key);
  const depLeft = () => cents(depKeys.reduce((t, k) => t + ledger.left(k), 0));
  const depDiscount = discounts.find((x) => x.payment_id === 'deposit');
  if (depDiscount && depositPaid(s) && byKey.has('deposit')) {
    record({ kind: 'discount', id: depDiscount.id, date: ymd(s.deposit_date), offered: depDiscount.amount, discount_label: depDiscount.label }, payDiscount(Math.min(depDiscount.amount, depLeft()), (ch) => depKeys.includes(ch.key)));
  }
  if (depositPaid(s) && byKey.has('deposit')) {
    const left = depLeft();
    const pays = ledger.pay(left, (ch) => depKeys.includes(ch.key));
    if (pays.length) record({ kind: 'deposit', id: 'deposit', date: ymd(s.deposit_date), offered: left }, pays);
  }
  // 4. Payments recorded toward one own-dated extra (or one of its steps), then each
  //    step marked paid covers whatever of it is left (a step marked paid is paid in
  //    full on its date; a payment that paid it also marks it, for older readers).
  // A discount with a payment rides with it, just before it (the same date and toward),
  // so it pays the service fees it takes back and the payment the rest.
  const withDiscounts = (list) => list.flatMap((p) => {
    const d = discounts.find((x) => x.payment_id === p.id);
    return d ? [{ id: d.id, amount: d.amount, date: p.date, ...(text(p.toward) ? { toward: text(p.toward) } : {}), discount: d }, p] : [p];
  });
  const payments = withDiscounts(cleanPayments(s.payments));
  const moneyItem = (p) => (p.discount
    ? { kind: 'discount', id: p.id, date: p.date, offered: p.amount, discount_label: p.discount.label, payment_id: p.discount.payment_id }
    : { kind: 'payment', id: p.id, date: p.date, offered: p.amount, ...(p.method ? { method: p.method } : {}), ...(p.account_id ? { account_id: p.account_id } : {}) });
  const recordPayment = (p, accepts) => record({ ...moneyItem(p), ...(text(p.toward) ? { toward: text(p.toward) } : {}) }, p.discount ? payDiscount(p.amount, accepts) : ledger.pay(p.amount, accepts));
  //    An extra now on the schedule keeps what was paid toward its old steps: a payment
  //    toward one of them pays the extra, and a step marked paid covers what's left
  //    of that step's share.
  const towardSteps = {};
  // A part of a payment split by method (Payment Methods plan D25): toward the charges
  // it names, `charges:<key>,<key>…`, before the rest of the schedule's money.
  for (const p of payments.filter((x) => text(x.toward).startsWith(CHARGES_TOWARD))) {
    const keys = towardKeys(p.toward);
    recordPayment(p, (ch) => ch.part === 'schedule' && keys.includes(ch.key));
  }
  for (const p of payments.filter((x) => text(x.toward) && !text(x.toward).startsWith(CHARGES_TOWARD) && !text(x.toward).startsWith(DUE_TOWARD))) {
    const toward = text(p.toward);
    const onSched = charges.find((ch) => ch.part === 'schedule' && ch.steps && toward.startsWith(`${ch.key}:`));
    recordPayment(p, (ch) => ch.key === toward || ch === onSched);
    if (onSched) towardSteps[toward] = cents((towardSteps[toward] || 0) + received[received.length - 1].amount);
  }
  for (const ch of charges.filter((c) => c.part === 'own' && c.step?.paid_date)) {
    const left = ledger.left(ch.key);
    const pays = ledger.pay(left, (c) => c.key === ch.key);
    if (pays.length) record({ kind: 'step', id: ch.key, date: ch.step.paid_date, offered: left }, pays);
  }
  for (const ch of charges.filter((c) => c.part === 'schedule' && c.steps)) {
    for (const stp of ch.steps.filter((x) => x.paid_date)) {
      const id = `${ch.key}:${stp.id}`;
      const left = cents(Math.min(Math.max(num(stp.amount) - (towardSteps[id] || 0), 0), ledger.left(ch.key)));
      const pays = ledger.pay(left, (c) => c.key === ch.key);
      if (pays.length) record({ kind: 'step', id, date: stp.paid_date, offered: left }, pays);
    }
  }
  // 5. Payments recorded on the sale toward the schedule, in date order (never the
  //    deposit, never an own-dated extra). By shares (§12, D42): what a payment pays is
  //    the charges its due date asks for (`due:<id>`), else the earliest due date still
  //    owed, each due date's charges in her priority order.
  const toSchedule = payments.filter((x) => !text(x.toward) || text(x.toward).startsWith(DUE_TOWARD));
  const cells = targets ? shareCells(targets, received, charges, priority) : null;
  if (!cells) for (const p of toSchedule) recordPayment(p, (ch) => ch.part === 'schedule');
  else {
    for (const p of toSchedule) {
      const i = received.length;
      const dueId = text(p.toward).startsWith(DUE_TOWARD) ? text(p.toward).slice(DUE_TOWARD.length) : '';
      let have = p.amount;
      const pays = [];
      const take = (cell) => {
        const amt = cents(Math.min(have, cell.ask - cell.filled, ledger.left(cell.key)));
        if (!(amt > 0)) return;
        pays.push(...ledger.pay(amt, (ch) => ch.key === cell.key));
        fillCell(cell, i, amt);
        have = cents(have - amt);
      };
      const at = schedule.findIndex((st) => st.id === dueId);
      if (at >= 0) cells.filter((c) => c.due === at).forEach(take);
      cells.forEach(take);
      // More than every due date asks: whatever is left, in her order.
      if (have > 0) pays.push(...ledger.pay(have, (ch) => ch.part === 'schedule'));
      record({ ...moneyItem(p), ...(text(p.toward) ? { toward: text(p.toward) } : {}) }, mergePays(pays));
    }
  }
  // 6. Marked paid in full: whatever is left of everything.
  if (balancePaid(s)) {
    const owedAll = cents(charges.reduce((t, c) => t + ledger.left(c.key), 0));
    const pays = ledger.pay(owedAll, (ch) => ch.key !== 'fee');
    if (pays.length) {
      record({ kind: 'paid_in_full', id: 'paid_in_full', date: ymd(s.balance_paid_date), offered: owedAll }, pays);
      if (cells) for (const p of pays) fillKey(cells, received.length - 1, p.key, p.amount, true);
    }
  }

  const total = cents(charges.reduce((t, c) => t + c.amount, 0));
  const paid = cents(charges.reduce((t, c) => t + (c.amount - ledger.left(c.key)), 0));
  const feeCharged = cents(feeCharges.reduce((t, c) => t + num(c.amount), 0));
  const fee = feeCharged > 0 ? { charged: feeCharged, credited: cents(feeCharged - ledger.left(feeCharges[0]?.key || 'fee')) } : null;
  const base = { ended, hasSchedule: Boolean(stored), schedule, charges, total, paid, fee, received };
  if (ended) return { ...base, remaining: 0, deposit: null, dueDates: [], ownDated: [], next: null };

  // The deposit: asked for on its own, before the schedule.
  const depCharge = byKey.get('deposit');
  const depAmount = cents(charges.filter((c) => c.part === 'deposit').reduce((t, c) => t + c.amount, 0));
  const deposit = depCharge ? (() => {
    const owed = depLeft();
    const date = owed > 0 ? ymd(depositDueDate) : ymd(s.deposit_date);
    // `asked`: when it was asked for, kept once it's paid (a credit covering it is
    // earned then, D21). `amount`: the deposit with its service fee (D30).
    return { amount: depAmount, paid: cents(depAmount - owed), owed, date, asked: ymd(depositDueDate), status: statusOf(owed, date, today) };
  })() : null;

  // 2nd pass: the due dates' slices of the schedule's money (deposit asked first).
  const dated = { birthDate, pickupDate, openDays };
  const finalTotal = coveredTotal(['all'], charges, { final: true });
  let prev = depCharge ? depAmount : 0;
  const dueDates = cells ? shareDueDates(schedule, targets, cells, { dated, prev, label: dueLabel }) : schedule.map((st, i) => {
    const covered = coveredTotal(st.covers, charges, { final: i === schedule.length - 1 });
    let threshold;
    let fresh = false;
    if (st.percent != null && st.basis === 'remaining') {
      threshold = prev + (st.percent / 100) * Math.max(0, covered - Math.min(prev, covered));
      fresh = true;
    } else if (st.percent != null) {
      threshold = Math.max(prev, (st.percent / 100) * covered);
    } else {
      threshold = prev + st.amount;
      fresh = st.prior_funds === 'dont_count';
    }
    threshold = Math.max(prev, Math.min(cents(threshold), finalTotal));
    const ask = cents(threshold - prev);
    prev = threshold;
    const isFinal = i === schedule.length - 1;
    return { id: st.id, label: dueLabel(st, i, isFinal), step: st, date: dueDateOf(st, dated),
      coveredTotal: covered, threshold, ask, filled: 0, owed: 0, fresh, isFinal, status: 'met', from: [] };
  });
  // Money toward the schedule (not the deposit, not own-dated extras), each piece
  // marked earlier money or not. Earlier money first, then payments by date.
  // `from` on each due date: which money filled it ({ i: index in received, amount }).
  const schedKeys = new Set(charges.filter((c) => c.part === 'schedule').map((c) => c.key));
  const pool = received
    .map((r, i) => ({ i, amount: cents(r.pays.filter((p) => schedKeys.has(p.key)).reduce((t, p) => t + p.amount, 0)), earlier: ['fee', 'credit', 'deposit'].includes(r.kind), last: r.last === true }))
    .filter((m) => m.amount > 0)
    .sort((a, b) => Number(b.earlier) - Number(a.earlier));
  const fill = (m, mayFresh) => {
    for (const d of m.last ? [...dueDates].reverse() : dueDates) {
      if (!(m.amount > 0)) return;
      if (d.fresh && !mayFresh) continue;
      const take = cents(Math.min(m.amount, d.ask - d.filled));
      if (take > 0) {
        d.filled = cents(d.filled + take);
        m.amount = cents(m.amount - take);
        const had = d.from.find((f) => f.i === m.i);
        if (had) had.amount = cents(had.amount + take);
        else d.from.push({ i: m.i, amount: take });
      }
    }
  };
  if (!cells) {
    for (const m of pool) fill(m, !m.earlier);
    // Earlier money with nowhere else to go (everything it may cover is met) covers the
    // "doesn't count" due dates last, so nothing is ever shown owed that's been paid.
    for (const m of pool) fill(m, true);
  }
  for (const d of dueDates) {
    d.owed = cents(Math.max(d.ask - d.filled, 0));
    d.status = statusOf(d.owed, d.date, today);
  }

  const finalDate = dueDates[dueDates.length - 1]?.date || null;
  const ownDated = charges.filter((c) => c.part === 'own').map((c) => {
    const owed = ledger.left(c.key);
    const date = c.step ? (stepDueDate(c.step, { sale: s, pickupDate: pickupDate || '', openDays }) || null) : finalDate;
    return { key: c.key, label: c.label, amount: c.amount, paid: cents(c.amount - owed), owed, date, status: statusOf(owed, date, today) };
  });

  const open = [
    ...(deposit && deposit.owed > 0 ? [{ kind: 'deposit', id: 'deposit', label: 'Deposit', date: deposit.date, owed: deposit.owed, isFinal: false }] : []),
    ...dueDates.filter((d) => d.owed > 0).map((d) => ({ kind: 'schedule', id: d.id, label: d.label, date: d.date, owed: d.owed, isFinal: d.isFinal })),
    ...ownDated.filter((o) => o.owed > 0).map((o) => ({ kind: 'own', id: o.key, label: o.label, date: o.date, owed: o.owed, isFinal: false }))
  ];
  const first = open.find((o) => o.kind === 'deposit')
    || open.filter((o) => o.date).sort((a, b) => a.date.localeCompare(b.date))[0]
    || open[0] || null;
  // Due dates on the same day are one payment to the family (§12.5, D44): the next one
  // takes in every schedule due date still owed on its date (`ids`), owed together.
  const sameDay = first?.kind === 'schedule' && first.date ? open.filter((o) => o.kind === 'schedule' && o.date === first.date) : [];
  const next = sameDay.length > 1 ? {
    ...first, ids: sameDay.map((o) => o.id), owed: cents(sameDay.reduce((t, o) => t + o.owed, 0)),
    isFinal: sameDay.some((o) => o.isFinal), label: listWords(sameDay.map((o) => o.label))
  } : first;
  return { ...base, remaining: cents(total - paid), deposit, dueDates, ownDated, next,
    ...(cells ? { byShares: true, priority, cells } : {}) };
}

const listWords = (words) => (words.length < 2 ? words[0] || '' : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);
const dueLabel = (st, i, isFinal) => st.label || (isFinal ? 'Final payment' : `Payment ${i + 1}`);

// --- By shares (§12): each due date's ask, charge by charge ---------------------------

const mergePays = (pays) => {
  const out = [];
  for (const p of pays) {
    const had = out.find((x) => x.key === p.key);
    if (had) had.amount = cents(had.amount + p.amount);
    else out.push({ ...p });
  }
  return out;
};

// The charges in her priority order (kind, then the sale's charge order). A fee
// charged back ('fees') comes last.
function inPriority(charges, priority) {
  const rank = (c) => { const i = priority.indexOf(c.covers); return i < 0 ? priority.length : i; };
  return charges.map((c, n) => ({ c, n })).sort((a, b) => rank(a.c) - rank(b.c) || a.n - b.n).map((x) => x.c);
}

// Each due date's ask per charge: [{ fresh, final, asks: Map(key → amount) }]. Targets
// are cumulative per charge (what of it is asked by then): the deposit's start at the
// deposit (it's asked first), so a percent of the price counts it. A share raises its
// charges' targets in her order; the final due date asks the rest of everything. A due
// date without shares (a stored one, D41) is one share over what it covers.
export function shareTargets(schedule, charges, priority = CHARGE_KIND_ORDER) {
  const ordered = inPriority(charges, cleanPriority(priority));
  let T = new Map(charges.filter((c) => c.part !== 'own').map((c) => [c.key, c.part === 'deposit' ? c.amount : 0]));
  return schedule.map((st, i) => {
    const final = i === schedule.length - 1;
    const prev = T;
    T = new Map(prev);
    const setOf = (match) => ordered.filter((c) => c.part !== 'own' && (final || !c.finalOnly) && match(c));
    const matches = (ch) => (ch === 'all' ? () => true
      : ch.startsWith('extra:') ? (c) => Boolean(c.extraId) && `extra:${c.extraId}` === ch : (c) => c.covers === ch);
    const covered = (c) => st.covers.includes('all') || st.covers.includes(c.covers) || (c.extraId && st.covers.includes(`extra:${c.extraId}`));
    const fresh = !final && (st.shares ? st.new_money === true : (st.basis === 'remaining' || st.prior_funds === 'dont_count'));
    const shares = final ? [{ set: setOf(() => true), how: 'rest' }]
      : st.shares ? st.shares.map((sh) => ({ set: setOf(matches(sh.charge)), how: sh.how, value: sh.value }))
        : [{ set: setOf(covered), how: st.percent != null ? 'percent' : 'amount', value: st.percent ?? st.amount }];
    for (const sh of shares) {
      const sum = (m) => cents(sh.set.reduce((t, c) => t + (m ? m.get(c.key) || 0 : c.amount), 0));
      const total = sum(null);
      const before = sum(prev);
      let want = total;
      if (sh.how === 'percent') want = fresh ? before + (sh.value / 100) * (total - before) : (sh.value / 100) * total;
      else if (sh.how === 'amount') want = before + sh.value;
      let need = cents(Math.min(cents(want), total) - sum(T));
      for (const c of sh.set) {
        if (!(need > 0)) break;
        const give = cents(Math.min(need, c.amount - (T.get(c.key) || 0)));
        if (give > 0) { T.set(c.key, cents((T.get(c.key) || 0) + give)); need = cents(need - give); }
      }
    }
    const asks = new Map();
    for (const c of charges.filter((x) => x.part === 'schedule')) {
      const a = cents((T.get(c.key) || 0) - (prev.get(c.key) || 0));
      if (a > 0) asks.set(c.key, a);
    }
    return { fresh, final, asks };
  });
}

// The old math's asks (by thresholds over everything the due dates cover). Only to spot
// the $0 case.
function thresholdAsks(schedule, charges) {
  const finalTotal = coveredTotal(['all'], charges, { final: true });
  let prev = cents(charges.filter((c) => c.part === 'deposit').reduce((t, c) => t + c.amount, 0));
  return schedule.map((st, i) => {
    const covered = coveredTotal(st.covers, charges, { final: i === schedule.length - 1 });
    let threshold;
    if (st.percent != null && st.basis === 'remaining') threshold = prev + (st.percent / 100) * Math.max(0, covered - Math.min(prev, covered));
    else if (st.percent != null) threshold = Math.max(prev, (st.percent / 100) * covered);
    else threshold = prev + st.amount;
    threshold = Math.max(prev, Math.min(cents(threshold), finalTotal));
    const ask = cents(threshold - prev);
    prev = threshold;
    return ask;
  });
}

// A stored schedule whose old math asks $0 on a due date (before the final) that,
// charge by charge, asks for money: "100% of boarding and transport" after a deposit
// bigger than both (§12.1). It's worked out by shares instead (D41).
export function zeroCase(schedule, charges, priority) {
  if (schedule.length < 2) return false;
  const old = thresholdAsks(schedule, charges);
  const now = shareTargets(schedule, charges, priority);
  return old.some((a, i) => i < schedule.length - 1 && a === 0 && [...now[i].asks.values()].some((v) => v > 0));
}

function fillCell(cell, i, amount) {
  cell.filled = cents(cell.filled + amount);
  const had = cell.from.find((f) => f.i === i);
  if (had) had.amount = cents(had.amount + amount);
  else cell.from.push({ i, amount });
}
// Money already on a charge fills that charge's cells, earliest due date first; a "new
// money only" due date only when `mayFresh`. → what's left.
function fillKey(cells, i, key, amount, mayFresh, last = false) {
  let have = cents(amount);
  for (const c of last ? [...cells].reverse() : cells) {
    if (!(have > 0)) break;
    if (c.key !== key || (c.fresh && !mayFresh)) continue;
    const take = cents(Math.min(have, c.ask - c.filled));
    if (take > 0) { fillCell(c, i, take); have = cents(have - take); }
  }
  return have;
}

// The due dates' cells, one per due date and charge it asks for, in due-date order and
// her priority within each; filled with the money received so far (each on the charge
// it paid): payments first wherever they can go, the fee credit, credits and the deposit
// ("earlier money") never into a "new money only" due date unless nothing else is left.
function shareCells(targets, received, charges, priority) {
  const ordered = inPriority(charges, priority);
  const cells = [];
  targets.forEach((t, due) => {
    for (const c of ordered) if (t.asks.has(c.key)) cells.push({ due, key: c.key, ask: t.asks.get(c.key), filled: 0, fresh: t.fresh, from: [] });
  });
  const sched = new Set(charges.filter((c) => c.part === 'schedule').map((c) => c.key));
  const earlier = (r) => ['fee', 'credit', 'deposit'].includes(r.kind);
  const left = [];
  received.forEach((r, i) => {
    for (const p of r.pays.filter((x) => sched.has(x.key))) {
      const rest = fillKey(cells, i, p.key, p.amount, !earlier(r), r.last === true);
      if (rest > 0) left.push({ i, key: p.key, amount: rest, last: r.last === true });
    }
  });
  for (const m of left) fillKey(cells, m.i, m.key, m.amount, true, m.last);
  return cells;
}

// The due dates when worked out by shares: each one's ask, what filled it and what's
// owed, from its cells.
function shareDueDates(schedule, targets, cells, { dated, prev, label }) {
  let threshold = prev;
  return schedule.map((st, i) => {
    const mine = cells.filter((c) => c.due === i);
    const ask = cents(mine.reduce((t, c) => t + c.ask, 0));
    const filled = cents(mine.reduce((t, c) => t + c.filled, 0));
    const from = [];
    for (const c of mine) for (const f of c.from) {
      const had = from.find((x) => x.i === f.i);
      if (had) had.amount = cents(had.amount + f.amount);
      else from.push({ ...f });
    }
    threshold = cents(threshold + ask);
    const isFinal = i === schedule.length - 1;
    return { id: st.id, label: label(st, i, isFinal), step: st, date: dueDateOf(st, dated),
      coveredTotal: ask, threshold, ask, filled, owed: 0, fresh: targets[i].fresh, isFinal, status: 'met', from };
  });
}

// A payment toward some of the schedule's charges (a part paid by its own method):
// `toward` as `charges:<key>,<key>…`.
export const CHARGES_TOWARD = 'charges:';
export const chargesToward = (keys) => `${CHARGES_TOWARD}${[...new Set(keys)].join(',')}`;
// A payment toward one due date (§12, D42): `toward` as `due:<due date id>`.
export const DUE_TOWARD = 'due:';
export const dueToward = (id) => `${DUE_TOWARD}${id}`;
export const towardKeys = (toward) => (text(toward).startsWith(CHARGES_TOWARD) ? text(toward).slice(CHARGES_TOWARD.length).split(',').filter(Boolean) : []);

// What one due date still asks for, charge by charge (from chargePieces): `dueId` is a
// schedule due date's id, 'deposit', or an own-dated charge's key; none = the next
// payment's (every due date on its day, D44). → [{ key, component, label, owed }]
export function duePieces(st, dueId = null) {
  const n = st?.next;
  const ids = dueId != null ? [dueId] : n ? (n.kind === 'deposit' ? ['deposit'] : n.ids || [n.id]) : [];
  if (!ids.length) return [];
  return chargePieces(st).filter((p) => ids.includes(p.dueId) && p.owed > 0).map((p) => ({ key: p.key, component: p.component, label: p.label, owed: p.owed }));
}

// --- Pieces: each charge split by the due date it falls in ------------------------------

// The statement's money and what's still owed, cell by cell: one piece per charge and
// due date (income, invoices and receipts read these, so they agree with the card).
// A due date's money is the money that filled it (`from`); each money item's pays
// (in charge order) are matched to the due dates it filled (in schedule order), and
// what's still owed of each charge (in charge order) to the due dates' owed (in
// order). The deposit is its own due date ('deposit'), an own-dated extra or step its
// own (its key). An ended sale has no due dates: one piece per charge, dueId ''.
// The application fee charge (credits paying the fee) is not the sale's, so not here.
// → [{ key, label, component, part, dueId, dueLabel, dueDate, isFinal, amount, owed,
//      paid: [{ ref, kind, id, date, amount, credited, label }] }]
//   ordered by due date (deposit, the schedule's, own-dated), then charge order.
//   `ref` = `${kind}:${id}` names the money item; `credited`: the application fee or a
//   credit for funds received (labelled "<charge> (credited)").
export function chargePieces(st) {
  if (!st) return [];
  const charges = new Map(st.charges.map((c, n) => [c.key, { ...c, n }]));
  const cells = new Map();
  const cell = (key, dueId, meta) => {
    const id = `${key}@${dueId}`;
    if (!cells.has(id)) {
      const c = charges.get(key);
      cells.set(id, { key, label: c.label, component: c.component, part: c.part, dueId, amount: 0, owed: 0, paid: [], n: c.n, ...meta });
    }
    return cells.get(id);
  };
  const addPaid = (p, r, amount, dueId, meta) => {
    if (!(amount > 0)) return;
    const c = cell(p.key, dueId, meta);
    const credited = r.kind === 'fee' || r.kind === 'credit';
    const had = c.paid.find((x) => x.ref === `${r.kind}:${r.id}`);
    if (had) had.amount = cents(had.amount + amount);
    else c.paid.push({ ref: `${r.kind}:${r.id}`, kind: r.kind, id: r.id, date: r.date || null, amount, credited, label: r.kind === 'discount' ? r.discount_label : `${c.label}${credited ? ' (credited)' : ''}`,
      ...(r.method ? { method: r.method } : {}), ...(r.account_id ? { account_id: r.account_id } : {}) });
    c.amount = cents(c.amount + amount);
  };
  const addOwed = (key, amount, dueId, meta) => {
    if (!(amount > 0)) return;
    const c = cell(key, dueId, meta);
    c.owed = cents(c.owed + amount);
    c.amount = cents(c.amount + amount);
  };

  if (st.ended || !st.dueDates?.length) {
    const meta = { dueLabel: '', dueDate: null, isFinal: false, order: 0 };
    for (const r of st.received) for (const p of r.pays) if (charges.has(p.key)) addPaid(p, r, p.amount, '', meta);
    if (!st.ended) for (const c of st.charges) addOwed(c.key, cents(c.amount - st.received.reduce((t, r) => t + r.pays.filter((p) => p.key === c.key).reduce((u, p) => u + p.amount, 0), 0)), '', meta);
    return order(cells);
  }

  const depMeta = { dueLabel: 'Deposit', dueDate: st.deposit ? (st.deposit.asked || st.deposit.date || null) : null, isFinal: false, order: 0 };
  const dueMeta = st.dueDates.map((d, i) => ({ dueLabel: d.label, dueDate: d.date || null, isFinal: d.isFinal, order: i + 1 }));
  const ownByKey = new Map((st.ownDated || []).map((o) => [o.key, o]));
  const ownMeta = (key) => ({ dueLabel: charges.get(key).label, dueDate: ownByKey.get(key)?.date || null, isFinal: false, order: st.dueDates.length + 1 });

  // Paid: the deposit and own-dated charges go straight to their own due date;
  // schedule money is matched to the due dates it filled.
  st.received.forEach((r, i) => {
    const sched = [];
    for (const p of r.pays) {
      const c = charges.get(p.key);
      if (!c) continue; // the application fee charge
      if (c.part === 'deposit') addPaid(p, r, p.amount, 'deposit', depMeta);
      else if (c.part === 'own') addPaid(p, r, p.amount, p.key, ownMeta(p.key));
      else sched.push({ p, left: p.amount });
    }
    if (st.cells) return;
    const fills = st.dueDates.map((d, j) => ({ j, left: d.from.filter((f) => f.i === i).reduce((t, f) => t + f.amount, 0) })).filter((f) => f.left > 0);
    zip(sched, fills, (a, b, amount) => addPaid(a.p, r, amount, st.dueDates[b.j].id, dueMeta[b.j]));
  });
  // Owed: the deposit's and own-dated charges' own; the schedule's matched to the
  // due dates still owed.
  const leftOf = (key) => cents(charges.get(key).amount - st.received.reduce((t, r) => t + r.pays.filter((p) => p.key === key).reduce((u, p) => u + p.amount, 0), 0));
  const sched = [];
  for (const c of st.charges) {
    const left = leftOf(c.key);
    if (c.part === 'deposit') addOwed(c.key, left, 'deposit', depMeta);
    else if (c.part === 'own') addOwed(c.key, left, c.key, ownMeta(c.key));
    else if (left > 0) sched.push({ key: c.key, left });
  }
  if (st.cells) {
    // By shares (§12): each due date's cells say which charge its money paid and what's
    // still owed on it.
    for (const c of st.cells) {
      for (const f of c.from) addPaid({ key: c.key }, st.received[f.i], f.amount, st.dueDates[c.due].id, dueMeta[c.due]);
      addOwed(c.key, cents(c.ask - c.filled), st.dueDates[c.due].id, dueMeta[c.due]);
    }
    return order(cells);
  }
  const owedDue = st.dueDates.map((d, j) => ({ j, left: d.owed })).filter((d) => d.left > 0);
  zip(sched, owedDue, (a, b, amount) => addOwed(a.key, amount, st.dueDates[b.j].id, dueMeta[b.j]));
  return order(cells);
}

// Walk two lists of { left } in step, calling take(a, b, amount) for each overlap.
// Anything one side has beyond the other is left unmatched (the sums always agree).
function zip(as, bs, take) {
  let i = 0;
  let j = 0;
  while (i < as.length && j < bs.length) {
    const amount = cents(Math.min(as[i].left, bs[j].left));
    if (amount > 0) take(as[i], bs[j], amount);
    as[i].left = cents(as[i].left - amount);
    bs[j].left = cents(bs[j].left - amount);
    if (!(as[i].left > 0)) i++;
    if (!(bs[j].left > 0)) j++;
  }
}

const order = (cells) => [...cells.values()]
  .sort((a, b) => a.order - b.order || a.n - b.n)
  .map(({ n: _n, order: _o, ...p }) => p);

// --- Editing ----------------------------------------------------------------------------

// What's wrong with due dates she typed (the editor's rows, before cleaning), or ''.
// The last row is the final payment: everything, 100% of the total.
// `saved`: a saved schedule's steps (no typed dates, no single extras).
export function scheduleProblem(rows, { saved = false } = {}) {
  if (!Array.isArray(rows) || !rows.length) return 'Add at least the final payment.';
  if (rows.length > SCHEDULE_MAX) return `A schedule holds up to ${SCHEDULE_MAX} payments, the final one included.`;
  for (const [i, r] of rows.entries()) {
    const name = i === rows.length - 1 ? 'The final payment' : `Payment ${i + 1}`;
    const due = SCHEDULE_DUE.find((d) => d.value === r?.due);
    if (!due) return `${name}: choose when it's due.`;
    if (saved && r.due === 'on_date') return `${name}: a saved schedule can't use a date; use an age or pickup.`;
    if (due.needsN && count(r.n) == null) return `${name}: say how many ${due.unit.split(' ')[0]}.`;
    if (r.due === 'at_weeks' && count(r.n) === 0) return `${name}: an age of at least 1 week.`;
    if (r.due === 'on_date' && !ymd(r.due_date)) return `${name}: choose the date.`;
    if (i < rows.length - 1 && Array.isArray(r.shares)) {
      if (!r.shares.length) return `${name}: tick what it collects.`;
      for (const sh of r.shares) {
        if (saved && String(sh.charge).startsWith('extra:')) return `${name}: a saved schedule can cover extras, not one extra.`;
        if (sh.how === 'percent' && !(num(sh.value) > 0 && num(sh.value) <= 100)) return `${name}: a percent from 1 to 100.`;
        if (sh.how === 'amount' && !(num(sh.value) > 0)) return `${name}: an amount above 0.`;
      }
      continue;
    }
    const covers = cleanCovers(r.covers);
    if (!covers) return `${name}: tick what it covers.`;
    if (saved && covers.some((c) => c.startsWith('extra:'))) return `${name}: a saved schedule can cover extras, not one extra.`;
    const percent = num(r.percent);
    const amount = num(r.amount);
    if (r.percent != null && r.percent !== '') {
      if (!(percent > 0) || percent > 100) return `${name}: a percent from 1 to 100.`;
    } else if (!(amount > 0)) return `${name}: an amount above 0.`;
  }
  const last = rows[rows.length - 1];
  if (!cleanCovers(last.covers)?.includes('all') || num(last.percent) !== 100 || last.basis === 'remaining') return 'The final payment covers everything left: 100% of everything.';
  return '';
}

// A schedule as the editor saves it: cleaned, ids kept or minted.
export function readSchedule(rows) {
  const error = scheduleProblem(rows);
  if (error) return { schedule: null, error };
  const withIds = rows.map((r) => ({ ...r, id: text(r.id) || crypto.randomUUID() }));
  return { schedule: cleanSchedule(withIds), error: '' };
}

// Her saved schedules (Kennel.payment_schedules): [{ id, name, steps }], each with a
// name and at least the final payment; steps never carry a typed date or a single extra.
export function savedSchedules(kennel) {
  const list = Array.isArray(kennel?.payment_schedules) ? kennel.payment_schedules : [];
  const out = [];
  for (const x of list) {
    const name = text(x?.name);
    const steps = cleanSchedule(Array.isArray(x?.steps) ? x.steps.map(({ due_date: _d, ...st }) => st) : null);
    if (!name || !x?.id || !steps || steps.some((st) => st.due === 'on_date' || st.covers.some((c) => c.startsWith('extra:')))) continue;
    out.push({ id: x.id, name, steps, priority: cleanPriority(x.priority) });
  }
  return out;
}

// The saved schedules the Kennel page hands over, checked. → { list, error }
export function readSavedSchedules(rows = []) {
  const out = [];
  const names = new Set();
  for (const r of rows) {
    const name = text(r?.name);
    if (!name) return { list: [], error: 'Give each saved schedule a name.' };
    if (names.has(name.toLowerCase())) return { list: [], error: `Two saved schedules are called "${name}".` };
    names.add(name.toLowerCase());
    const error = scheduleProblem(r.steps, { saved: true });
    if (error) return { list: [], error: `"${name}": ${error}` };
    out.push({ id: text(r.id) || crypto.randomUUID(), name, steps: cleanSchedule(r.steps.map((st, i) => ({ ...st, id: text(st.id) || `due${i}` }))),
      priority: cleanPriority(r.priority) });
  }
  return { list: out, error: '' };
}

// --- Tidying a schedule up (§12.5, D44, D48) -------------------------------------------
// People build a schedule by trial, so due dates may be out of order or on the same day.
// The editor offers to put them in date order and to combine same-day ones, then
// renumbers. `rows`: the editor's steps (the last is the final payment). `dates`: each
// row's date on a sale (null where it can't be known); none for a saved schedule, which
// compares rules instead (D48).

// A rule's place, where two rules can be compared without a sale: by age (weeks up),
// days before pickup (days down), at pickup. → [group, n] or null.
const ruleRank = (r) => (r.due === 'at_weeks' ? [0, num(r.n)] : r.due === 'before_pickup' ? [1, -num(r.n)] : r.due === 'at_pickup' ? [2, 0] : null);
const sameRule = (a, b) => a.due === b.due && (a.due === 'on_date' ? Boolean(a.due_date) && a.due_date === b.due_date : !NEEDS_N.has(a.due) || num(a.n) === num(b.n));

// Rows before the final one, in pairs that fall on the same day. → [[i, j]] (i < j)
export function sameDayPairs(rows, dates = null) {
  const out = [];
  for (let i = 0; i < rows.length - 1; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const same = dates ? Boolean(dates[i]) && dates[i] === dates[j] : sameRule(rows[i], rows[j]);
      if (same) out.push([i, j]);
    }
  }
  return out;
}

// The first row (before the final one) that falls before the row above it. → index or -1
export function outOfOrderAt(rows, dates = null) {
  for (let i = 1; i < rows.length - 1; i++) {
    if (dates) {
      if (dates[i] && dates[i - 1] && dates[i] < dates[i - 1]) return i;
    } else {
      const a = ruleRank(rows[i - 1]);
      const b = ruleRank(rows[i]);
      if (a && b && (b[0] < a[0] || (b[0] === a[0] && b[1] < a[1]))) return i;
    }
  }
  return -1;
}

// The rows before the final one in date order (one whose date can't be known keeps its
// place), the final one last.
export function inDateOrder(rows, dates = null) {
  const body = rows.slice(0, -1).map((r, i) => ({ r, i, key: dates ? dates[i] : ruleRank(r) }));
  const known = body.filter((x) => x.key).sort((a, b) => (dates ? a.key.localeCompare(b.key) : a.key[0] - b.key[0] || a.key[1] - b.key[1]) || a.i - b.i);
  let k = 0;
  return [...body.map((x) => (x.key ? known[k++].r : x.r)), rows[rows.length - 1]];
}

// Two rows on the same day as one, from the settings she used. → { row } or { why }.
// The final payment asks everything left, so a row joining it simply goes.
export function combineRows(a, b, { final = false } = {}) {
  if (final) return { row: b };
  const newMoney = (r) => (r.shares ? r.new_money === true : r.prior_funds === 'dont_count' || r.basis === 'remaining');
  if (newMoney(a) !== newMoney(b)) return { why: 'one counts earlier money and the other only new payments' };
  const label = text(a.label) || text(b.label);
  const base = { id: a.id, due: a.due, ...(a.n != null ? { n: a.n } : {}), ...(a.due_date ? { due_date: a.due_date } : {}), ...(label ? { label } : {}) };
  const pooled = (r) => !r.shares && r.amount != null && r.percent == null;
  if (pooled(a) || pooled(b)) {
    if (!(pooled(a) && pooled(b))) return { why: 'one is a single amount across several charges and the other sets each charge' };
    const covers = cleanCovers([...(a.covers || []), ...(b.covers || [])]);
    return { row: { ...base, covers, amount: cents(num(a.amount) + num(b.amount)), prior_funds: a.prior_funds || 'count', pooled: true } };
  }
  const sharesOf = (r) => r.shares || (r.covers || []).map((c) => ({ charge: c, how: 'percent', value: num(r.percent) }));
  const out = sharesOf(a).map((x) => ({ ...x }));
  for (const sh of sharesOf(b)) {
    const had = out.find((x) => x.charge === sh.charge);
    if (!had) { out.push({ ...sh }); continue; }
    const whole = (x) => x.how === 'full' || x.how === 'rest';
    if (whole(had) || whole(sh)) { Object.assign(had, { how: whole(had) ? had.how : sh.how }); delete had.value; continue; }
    if (had.how !== sh.how) return { why: `one asks a percent of ${coverWord(sh.charge)} and the other an amount` };
    had.value = had.how === 'percent' ? Math.min(cents(num(had.value) + num(sh.value)), 100) : cents(num(had.value) + num(sh.value));
  }
  return { row: { ...base, covers: out.map((x) => x.charge), shares: out, ...(newMoney(a) ? { new_money: true } : {}) } };
}
const coverWord = (c) => (SCHEDULE_COVERS.find((x) => x.value === c)?.label || 'that extra').toLowerCase();

// A saved schedule copied onto a sale: its steps with ids of their own (dates follow
// the pup and pickup until she types one).
export const scheduleFromSaved = (saved) => saved.steps.map((st) => ({ ...st, id: crypto.randomUUID() }));

// A payment as it's recorded. → the payment, or throws with what's missing.
export function newPayment({ id = null, amount, date, method = '', account_id = '', reference = '', note = '', toward = '' }) {
  const a = cents(num(amount));
  if (!(a > 0)) throw new Error('Enter the amount received.');
  if (!ymd(date)) throw new Error('Enter the date it was received.');
  return {
    id: id || crypto.randomUUID(), amount: a, date,
    ...(text(method) ? { method: text(method) } : {}), ...(text(account_id) ? { account_id: text(account_id) } : {}),
    ...(text(reference) ? { reference: text(reference) } : {}), ...(text(note) ? { note: text(note) } : {}),
    ...(text(toward) ? { toward: text(toward) } : {})
  };
}

// The sale's payments with one added or replaced (by id), or removed (`remove`).
export function paymentsWith(sale, payment, { remove = false } = {}) {
  const list = (Array.isArray(sale?.payments) ? sale.payments : []).filter((p) => p && p.id !== payment.id);
  return remove ? list : [...list, payment];
}

// Fees just added to a sale (Payment Schedule plan §3.4, D17): a transport fee set or
// raised, boarding added or raised, an extra not there before.
// → [{ kind: 'transport'|'boarding'|'extra', label, own? }]
export function addedFees(before, after) {
  const out = [];
  const b = before || {};
  if (num(after?.transport_fee) > num(b.transport_fee)) out.push({ kind: 'transport', label: 'Transport fee' });
  if (boardingTotal(after || {}) > boardingTotal(b)) out.push({ kind: 'boarding', label: 'Boarding' });
  const had = new Set(saleExtraCharges(b).map((x) => x.id));
  const scheduled = hasSchedule(after);
  // A fee charged back isn't asked about: it always rides on the last payment.
  for (const x of saleExtraCharges(after)) if (!had.has(x.id) && !x.fee_for) out.push({ kind: 'extra', label: x.label, ...(x.own_due_dates || (Array.isArray(x.payments) && !scheduled) ? { own: true } : {}) });
  return out;
}

// Everything is paid and the sale isn't marked paid in full yet (D22): offer the date
// (the last money received) and status. → null | { date }
export function paidInFullOffer(statement, sale) {
  if (!statement || statement.ended || statement.remaining > 0 || !(statement.total > 0)) return null;
  if (sale?.balance_paid_date || ['paid_in_full', 'delivered'].includes(sale?.status)) return null;
  const date = statement.received.map((r) => r.date).filter(Boolean).sort().pop() || null;
  return { date };
}

// What marking the sale paid in full writes (D22, after she says yes): the date, and
// the status Paid in full while it's still at a deposit status.
export const paidInFullChanges = (sale, date) => ({
  balance_paid_date: date,
  ...(['deposit_pending', 'deposit_paid'].includes(sale?.status) ? { status: 'paid_in_full' } : {})
});

// The final payment's date (the schedule's last), for the sale's balance_due_date.
export const finalDueDate = (statement) => statement?.dueDates?.[statement.dueDates.length - 1]?.date || null;

// What's owed by a date (a pickup day, for the pickup message): the deposit and each
// due date or own-dated charge still owed whose date is that day or before, or isn't
// known. `final`: the final payment is part of it (her final-payment methods apply,
// D9). → { amount, final }
export function owedBy(statement, date) {
  if (!statement || statement.ended) return { amount: 0, final: false };
  const by = (d) => !d || !date || d <= date;
  let amount = 0;
  let final = false;
  if (statement.deposit && statement.deposit.owed > 0 && by(statement.deposit.date)) amount += statement.deposit.owed;
  for (const d of statement.dueDates) {
    if (!(d.owed > 0) || !by(d.date)) continue;
    amount += d.owed;
    if (d.isFinal) final = true;
  }
  for (const o of statement.ownDated) if (o.owed > 0 && by(o.date)) amount += o.owed;
  return { amount: cents(amount), final };
}

// --- Words ------------------------------------------------------------------------------

// What a due date covers, in words: "everything", "price and Puppy training".
export function coversText(covers, charges = []) {
  if (covers.includes('all')) return 'everything';
  const label = (c) => {
    if (c.startsWith('extra:')) return charges.find((x) => x.extraId === c.slice(6))?.label || 'an extra';
    return (SCHEDULE_COVERS.find((x) => x.value === c)?.label || c).toLowerCase();
  };
  const words = covers.map(label);
  return words.length < 2 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

// What a due date with shares collects, in words (§12): "transport in full, at least 50%
// of purchase price and $200 of boarding". `money` formats the figures.
export function sharesText(step, charges = [], { money = (n) => `$${n}` } = {}) {
  const words = (step.shares || []).map((sh) => {
    const what = coversText([sh.charge], charges);
    if (sh.how === 'percent') return `at least ${sh.value}% of ${what}`;
    if (sh.how === 'amount') return `${money(sh.value)} of ${what}`;
    return sh.how === 'rest' ? `the rest of ${what}` : `${what} in full`;
  });
  return `${words.length < 2 ? words[0] || '' : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`}${step.new_money ? ', new payments only' : ''}`;
}

// The schedule in one line, for the "adjust the schedule?" prompt and messages:
// "$1,150 by Dec 4 (50% of purchase price and Puppy training); the rest at pickup".
// `money` and `date` format the figures (the page's own helpers).
export function scheduleSummary(statement, { money = (n) => `$${n}`, date = (d) => d } = {}) {
  const parts = statement.dueDates.map((d) => {
    const when = d.date ? `by ${date(d.date)}` : d.step.due === 'at_pickup' ? 'at pickup' : 'on a date not set yet';
    if (d.isFinal) {
      if (statement.dueDates.length > 1) return `the rest ${when}`;
      return d.date ? `everything due ${date(d.date)}` : `everything due ${when}`;
    }
    const st = d.step;
    const what = st.shares ? sharesText(st, statement.charges, { money })
      : st.pooled ? coversText(st.covers, statement.charges)
      : st.percent != null
      ? `${st.percent}% of ${st.basis === 'remaining' ? 'what remains of ' : ''}${coversText(st.covers, statement.charges)}`
      : (st.prior_funds === 'dont_count' ? 'a new payment' : '');
    return `${money(d.ask)} ${when}${what ? ` (${what})` : ''}`;
  });
  return parts.join('; ');
}

// The next payment in words, for messages: "$1,150 by Dec 4", "$500 for the deposit,
// by Nov 20", "$2,000 at pickup". '' when nothing is owed. `money` and `date` as above.
export function nextPaymentText(statement, { money = (n) => `$${n}`, date = (d) => d } = {}) {
  const n = statement?.next;
  if (!n || !(n.owed > 0)) return '';
  const step = n.kind === 'schedule' ? statement.dueDates.find((d) => d.id === n.id)?.step : null;
  const when = n.date ? `by ${date(n.date)}` : step?.due === 'at_pickup' ? 'at pickup' : '';
  if (n.kind === 'deposit') return `${money(n.owed)} for the deposit${when ? `, ${when}` : ''}`;
  if (n.kind === 'own') return `${money(n.owed)} for ${n.label}${when ? `, ${when}` : ''}`;
  return `${money(n.owed)}${when ? ` ${when}` : ''}`;
}

// --- What the family is shown ------------------------------------------------------------

// A sale's statement as the family's own pages show it (their status page and their
// Companion page, Payment Schedule plan §7): built field by field, never a copy of the
// statement, so nothing about her settings, notes, accounts or methods goes out. Only
// money on this sale: the application fee itself and a credit left over aren't in it.
//   total, paid, remaining      paid + remaining = total
//   deposit   { amount, owed, date, state } | null
//   due       [{ label, date, at_pickup, amount, owed, final, state }]  the schedule's
//             due dates in order; `amount` what that due date asks for
//   own       [{ label, amount, owed, date, state }]  extras paid on their own dates
//   received  [{ date, label, amount }]  each charge each piece of money paid, oldest
//             first; a credit's or the application fee's labelled "<charge> (credited)".
//             They add up to `paid`.
//   next      { label, date, at_pickup, owed, final, deposit } | null
// `state`: 'met' (nothing owed), 'next' (the next payment), 'past' (its date has gone
// by and it isn't marked received: the family page says "Was due …", never Overdue),
// or 'later'. → the view, or null for an ended sale or one with nothing on it.
export function familyPaymentsView(st) {
  if (!st || st.ended || !(st.total > 0)) return null;
  const next = st.next;
  const isNext = (kind, id) => Boolean(next && next.kind === kind && (next.ids || [next.id]).includes(id));
  const stateOf = (owed, status, kind, id) => (!(owed > 0) ? 'met' : isNext(kind, id) ? 'next' : status === 'not_received' ? 'past' : 'later');
  const saleKeys = new Set(st.charges.map((c) => c.key));
  const received = [];
  for (const r of [...st.received].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))) {
    for (const p of r.pays) {
      if (!saleKeys.has(p.key) || !(p.amount > 0)) continue;
      received.push({ date: r.date || null, label: String(p.label), amount: cents(p.amount) });
    }
  }
  const atPickup = (step) => Boolean(step && step.due === 'at_pickup');
  const nextStep = next && next.kind === 'schedule' ? st.dueDates.find((d) => d.id === next.id) : null;
  return {
    total: cents(st.total),
    paid: cents(st.paid),
    remaining: cents(st.remaining),
    deposit: st.deposit ? {
      amount: cents(st.deposit.amount), owed: cents(st.deposit.owed), date: st.deposit.date || null,
      state: stateOf(st.deposit.owed, st.deposit.status, 'deposit', 'deposit')
    } : null,
    due: st.dueDates.map((d) => ({
      label: String(d.label), date: d.date || null, at_pickup: atPickup(d.step), amount: cents(d.ask), owed: cents(d.owed),
      final: Boolean(d.isFinal), state: stateOf(d.owed, d.status, 'schedule', d.id)
    })),
    own: st.ownDated.map((o) => ({
      label: String(o.label), amount: cents(o.amount), owed: cents(o.owed), date: o.date || null,
      state: stateOf(o.owed, o.status, 'own', o.key)
    })),
    received,
    next: next ? {
      label: String(next.label), date: next.date || null, at_pickup: atPickup(nextStep?.step), owed: cents(next.owed),
      final: Boolean(next.isFinal), deposit: next.kind === 'deposit'
    } : null
  };
}
