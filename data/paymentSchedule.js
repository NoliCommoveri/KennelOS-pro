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

// The sale's due dates as stored, cleaned; the last always covers everything at 100%
// (one is added at pickup if it's missing). null = no schedule stored.
export function cleanSchedule(raw) {
  if (!Array.isArray(raw)) return null;
  const steps = [];
  for (const [i, st] of raw.entries()) {
    if (!st || typeof st !== 'object' || !DUE_VALUES.includes(st.due)) continue;
    const covers = cleanCovers(st.covers);
    if (!covers) continue;
    const row = { id: text(st.id) || `due${i}`, due: st.due, covers };
    if (text(st.label)) row.label = text(st.label);
    if (NEEDS_N.has(st.due)) row.n = count(st.n) ?? 0;
    if (ymd(st.due_date)) row.due_date = st.due_date;
    const percent = cents(num(st.percent));
    const amount = cents(num(st.amount));
    if (percent > 0) Object.assign(row, { percent: Math.min(percent, 100), basis: st.basis === 'remaining' ? 'remaining' : 'total' });
    else if (amount > 0) Object.assign(row, { amount, prior_funds: st.prior_funds === 'dont_count' ? 'dont_count' : 'count' });
    else continue;
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
function boardingTotal(sale) {
  const n = parseInt(sale.deferred_boarding_duration_days, 10);
  return cents(num(sale.deferred_boarding_amount) * (Number.isFinite(n) && n > 0 ? n : 1));
}

// The sale's charges in the order money pays them: deposit, price, boarding, extras on
// the schedule, extras on their own dates, transport last. Each is
// { key, component, label, amount, part: 'deposit'|'schedule'|'own', use, covers?,
//   extraId?, step? }. `use` is the credit use that may pay it (CREDIT_USES).
// An extra is on its own dates when it's flagged so, or it has its own payment steps
// and no due date names it; named, its steps aren't used.
export function saleCharges(sale, schedule = scheduleOf(sale)) {
  const named = new Set(schedule.flatMap((st) => st.covers).filter((c) => c.startsWith('extra:')).map((c) => c.slice(6)));
  const price = num(sale?.price);
  const deposit = cents(num(sale?.deposit_amount));
  const out = [];
  if (deposit > 0) out.push({ key: 'deposit', component: 'deposit', label: INVOICE_LINE_LABELS.deposit, amount: deposit, part: 'deposit', use: 'deposit', covers: 'price' });
  const balance = cents(Math.max(price - deposit, 0));
  if (balance > 0) out.push({ key: 'balance', component: 'balance', label: INVOICE_LINE_LABELS.balance, amount: balance, part: 'schedule', use: 'price', covers: 'price' });
  const boarding = boardingTotal(sale || {});
  if (boarding > 0) out.push({ key: 'boarding', component: 'boarding', label: INVOICE_LINE_LABELS.boarding, amount: boarding, part: 'schedule', use: 'extras', covers: 'boarding' });
  const own = [];
  for (const x of saleExtraCharges(sale)) {
    const ownDates = x.own_due_dates === true || (Array.isArray(x.payments) && !named.has(x.id));
    if (!ownDates) {
      out.push({ key: `extra:${x.id}`, component: 'extra', label: x.label, amount: x.amount, part: 'schedule', use: 'extras', covers: 'extras', extraId: x.id });
    } else if (Array.isArray(x.payments)) {
      for (const st of x.payments) own.push({ key: `extra:${x.id}:${st.id}`, component: 'extra', label: stepLabel(x, st), amount: st.amount, part: 'own', use: 'extras', extraId: x.id, step: st });
    } else {
      own.push({ key: `extra:${x.id}`, component: 'extra', label: x.label, amount: x.amount, part: 'own', use: 'extras', extraId: x.id });
    }
  }
  out.push(...own);
  const transport = cents(num(sale?.transport_fee));
  if (transport > 0) out.push({ key: 'transport', component: 'transport', label: INVOICE_LINE_LABELS.transport, amount: transport, part: 'schedule', use: 'extras', covers: 'transport' });
  return out;
}

// What a due date's covers add up to, from the sale's deposit and schedule charges.
// `price` is the whole price: deposit + balance.
export function coveredTotal(covers, charges) {
  const sched = charges.filter((c) => c.part !== 'own');
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
//   received: [{ kind: 'fee'|'credit'|'deposit'|'step'|'payment'|'paid_in_full', id, date,
//                amount, unapplied, method?, pays: [{ key, amount, label }] }],
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
  const labelOf = (key) => (key === 'fee' ? 'Application fee' : byKey.get(key)?.label || key);
  const ledger = moneyLedger([...feeCharges.map((c) => ({ ...c, use: 'fee' })), ...charges]);
  const received = [];
  const record = (item, pays, credited = false) => {
    const applied = cents(pays.reduce((t, p) => t + p.amount, 0));
    received.push({ ...item, amount: applied, unapplied: cents(Math.max(num(item.offered) - applied, 0)),
      pays: pays.map((p) => ({ ...p, label: `${labelOf(p.key)}${credited ? ' (credited)' : ''}` })) });
  };

  // 1. The application fee credited toward the purchase: the deposit first when her
  //    setting says so, else (and beyond the deposit) the rest of the price.
  const fc = feeCredit && num(feeCredit.amount) > 0 ? feeCredit : null;
  if (fc) {
    const keys = fc.toward === 'deposit' ? ['deposit', 'balance'] : ['balance'];
    const pays = ledger.pay(fc.amount, (ch) => keys.includes(ch.key));
    record({ kind: 'fee', id: 'fee', date: ymd(fc.date), offered: num(fc.amount) }, pays, true);
  }
  // 2. Credits for funds received, oldest first, toward what each is ticked for.
  for (const cr of credits) {
    const pays = ledger.pay(cr.amount, (ch) => (cr.applies_to || []).includes(ch.use));
    record({ kind: 'credit', id: cr.id, date: ymd(cr.date), offered: num(cr.amount), ...(cr.note ? { note: cr.note } : {}) }, pays, true);
  }
  // 3. The deposit she marked received: the whole deposit, less what the fee and
  //    credits already paid of it.
  if (depositPaid(s) && byKey.has('deposit')) {
    const left = ledger.left('deposit');
    const pays = ledger.pay(left, (ch) => ch.key === 'deposit');
    if (pays.length) record({ kind: 'deposit', id: 'deposit', date: ymd(s.deposit_date), offered: left }, pays);
  }
  // 4. Payments recorded toward one own-dated extra (or one of its steps), then each
  //    step marked paid covers whatever of it is left (a step marked paid is paid in
  //    full on its date; a payment that paid it also marks it, for older readers).
  const payments = cleanPayments(s.payments);
  const recordPayment = (p, accepts) => record({ kind: 'payment', id: p.id, date: p.date, offered: p.amount,
    ...(p.method ? { method: p.method } : {}), ...(p.account_id ? { account_id: p.account_id } : {}), ...(text(p.toward) ? { toward: text(p.toward) } : {}) }, ledger.pay(p.amount, accepts));
  for (const p of payments.filter((x) => text(x.toward))) recordPayment(p, (ch) => ch.key === text(p.toward));
  for (const ch of charges.filter((c) => c.part === 'own' && c.step?.paid_date)) {
    const left = ledger.left(ch.key);
    const pays = ledger.pay(left, (c) => c.key === ch.key);
    if (pays.length) record({ kind: 'step', id: ch.key, date: ch.step.paid_date, offered: left }, pays);
  }
  // 5. Payments recorded on the sale toward the schedule, in date order (never the
  //    deposit, never an own-dated extra).
  for (const p of payments.filter((x) => !text(x.toward))) recordPayment(p, (ch) => ch.part === 'schedule');
  // 6. Marked paid in full: whatever is left of everything.
  if (balancePaid(s)) {
    const owedAll = cents(charges.reduce((t, c) => t + ledger.left(c.key), 0));
    const pays = ledger.pay(owedAll, (ch) => ch.key !== 'fee');
    if (pays.length) record({ kind: 'paid_in_full', id: 'paid_in_full', date: ymd(s.balance_paid_date), offered: owedAll }, pays);
  }

  const total = cents(charges.reduce((t, c) => t + c.amount, 0));
  const paid = cents(charges.reduce((t, c) => t + (c.amount - ledger.left(c.key)), 0));
  const feeCharged = cents(feeCharges.reduce((t, c) => t + num(c.amount), 0));
  const fee = feeCharged > 0 ? { charged: feeCharged, credited: cents(feeCharged - ledger.left(feeCharges[0]?.key || 'fee')) } : null;
  const base = { ended, hasSchedule: Boolean(stored), schedule, charges, total, paid, fee, received };
  if (ended) return { ...base, remaining: 0, deposit: null, dueDates: [], ownDated: [], next: null };

  // The deposit: asked for on its own, before the schedule.
  const depCharge = byKey.get('deposit');
  const deposit = depCharge ? (() => {
    const owed = ledger.left('deposit');
    const date = owed > 0 ? ymd(depositDueDate) : ymd(s.deposit_date);
    // `asked`: when it was asked for, kept once it's paid (a credit covering it is
    // earned then, D21).
    return { amount: depCharge.amount, paid: cents(depCharge.amount - owed), owed, date, asked: ymd(depositDueDate), status: statusOf(owed, date, today) };
  })() : null;

  // 2nd pass: the due dates' slices of the schedule's money (deposit asked first).
  const dated = { birthDate, pickupDate, openDays };
  const finalTotal = coveredTotal(['all'], charges);
  let prev = depCharge ? depCharge.amount : 0;
  const dueDates = schedule.map((st, i) => {
    const covered = coveredTotal(st.covers, charges);
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
    return { id: st.id, label: st.label || (isFinal ? 'Final payment' : `Payment ${i + 1}`), step: st, date: dueDateOf(st, dated),
      coveredTotal: covered, threshold, ask, filled: 0, owed: 0, fresh, isFinal, status: 'met', from: [] };
  });
  // Money toward the schedule (not the deposit, not own-dated extras), each piece
  // marked earlier money or not. Earlier money first, then payments by date.
  // `from` on each due date: which money filled it ({ i: index in received, amount }).
  const schedKeys = new Set(charges.filter((c) => c.part === 'schedule').map((c) => c.key));
  const pool = received
    .map((r, i) => ({ i, amount: cents(r.pays.filter((p) => schedKeys.has(p.key)).reduce((t, p) => t + p.amount, 0)), earlier: ['fee', 'credit', 'deposit'].includes(r.kind) }))
    .filter((m) => m.amount > 0)
    .sort((a, b) => Number(b.earlier) - Number(a.earlier));
  const fill = (m, mayFresh) => {
    for (const d of dueDates) {
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
  for (const m of pool) fill(m, !m.earlier);
  // Earlier money with nowhere else to go (everything it may cover is met) covers the
  // "doesn't count" due dates last, so nothing is ever shown owed that's been paid.
  for (const m of pool) fill(m, true);
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
  const next = open.find((o) => o.kind === 'deposit')
    || open.filter((o) => o.date).sort((a, b) => a.date.localeCompare(b.date))[0]
    || open[0] || null;
  return { ...base, remaining: cents(total - paid), deposit, dueDates, ownDated, next };
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
    else c.paid.push({ ref: `${r.kind}:${r.id}`, kind: r.kind, id: r.id, date: r.date || null, amount, credited, label: `${c.label}${credited ? ' (credited)' : ''}`,
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
  for (const [i, r] of rows.entries()) {
    const name = i === rows.length - 1 ? 'The final payment' : `Payment ${i + 1}`;
    const due = SCHEDULE_DUE.find((d) => d.value === r?.due);
    if (!due) return `${name}: choose when it's due.`;
    if (saved && r.due === 'on_date') return `${name}: a saved schedule can't use a date; use an age or pickup.`;
    if (due.needsN && count(r.n) == null) return `${name}: say how many ${due.unit.split(' ')[0]}.`;
    if (r.due === 'at_weeks' && count(r.n) === 0) return `${name}: an age of at least 1 week.`;
    if (r.due === 'on_date' && !ymd(r.due_date)) return `${name}: choose the date.`;
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
    out.push({ id: x.id, name, steps });
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
    out.push({ id: text(r.id) || crypto.randomUUID(), name, steps: cleanSchedule(r.steps.map((st, i) => ({ ...st, id: text(st.id) || `due${i}` }))) });
  }
  return { list: out, error: '' };
}

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
  for (const x of saleExtraCharges(after)) if (!had.has(x.id)) out.push({ kind: 'extra', label: x.label, ...(x.own_due_dates || Array.isArray(x.payments) ? { own: true } : {}) });
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

// The final payment's date (the schedule's last), for the sale's balance_due_date.
export const finalDueDate = (statement) => statement?.dueDates?.[statement.dueDates.length - 1]?.date || null;

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
    const what = st.percent != null
      ? `${st.percent}% of ${st.basis === 'remaining' ? 'what remains of ' : ''}${coversText(st.covers, statement.charges)}`
      : (st.prior_funds === 'dont_count' ? 'a new payment' : '');
    return `${money(d.ask)} ${when}${what ? ` (${what})` : ''}`;
  });
  return parts.join('; ');
}
