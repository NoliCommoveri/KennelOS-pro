// extraCharges.js — a sale's extra charges (guide §21.2): anything the buyer
// pays for beyond the puppy, transport and boarding, one line each on the
// invoice. Photo and video packages, or a payment service's fee charged back.
//
// Stored as Sale.extra_charges: [{ id, label, amount, fee_for?, list_id?, group?,
// payments? }]. A charge is paid with the balance (incomeView.saleComponents)
// unless it has `payments`: its payment plan as dated steps, copied when she
// approves it (planSteps), each [{ id, percent, amount, due, n?, due_date?,
// paid_date? }], earned on its own paid date (or with the balance). `fee_for: 'deposit'`
// marks the fee charged back for a deposit paid through an account set to
// charge its fee back (Account.fee_charge_back), so it's offered only once.
//
// A kennel's price list (Kennel.extra_charge_list) only fills the sale's line: the
// label and amount are copied, so changing the price list never rewrites an old
// sale. Each price-list row may also carry (Family Requests plan §3, §3.1):
//   group                      her heading ("Photo packages", "Training")
//   description                a line families see under the name
//   family_can_request         families may ask for it on their status page
//   request_from_weeks / request_until_weeks / cancel_until_weeks
//                              the pup's age window (weeks); blank = the group's
//   boarding_days              a package that needs the pup to stay (training)
//   payment_plan               [{ percent, due, n? }] (PLAN_DUE); blank = the group's
// and Kennel.extra_charge_groups: [{ name, request_from_weeks, request_until_weeks,
// cancel_until_weeks, payment_plan }] holds each group's defaults, which a row's
// own value overrides. Pure; no db.
import { feeRate, isUsableRate, processingFee } from './processingFees.js';
import { addDaysToYMD, addOpenDays } from './dateUtils.js';

const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
const cents = (n) => Math.round(n * 100) / 100;
const text = (v) => String(v ?? '').trim();

// A list as stored: rows with a label and an amount above 0, amounts to the cent.
// Anything else in the field (not an array, a blank row) reads as nothing. A row
// without an id (an edited backup) reads by its place in the list, so an invoice's
// line keys stay the same from one view to the next; saving mints a real one.
function cleanList(list, { mintIds = false } = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const [i, x] of list.entries()) {
    if (!x || typeof x !== 'object') continue;
    const label = text(x.label);
    const amount = cents(num(x.amount));
    if (!label || !(amount > 0)) continue;
    const row = { id: x.id || (mintIds ? crypto.randomUUID() : `row${i}`), label, amount };
    if (x.fee_for) row.fee_for = x.fee_for;
    if (typeof x.list_id === 'string' && x.list_id) row.list_id = x.list_id;
    if (text(x.group)) row.group = text(x.group);
    const steps = cleanSteps(x.payments, amount);
    if (steps) row.payments = steps;
    // A package the pup stays for (training): the days copied from the price list,
    // so its stay can be logged and linked (Family Requests plan §6).
    const days = count(x.boarding_days);
    if (days) row.boarding_days = days;
    // Work she's finished (a Done tick) and an extra kept, still owed, when the family
    // backed out (Family Requests plan §7.2).
    if (ymd(x.completed_date)) row.completed_date = x.completed_date;
    if (x.kept_after_cancel === true) row.kept_after_cancel = true;
    out.push(row);
  }
  return out;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ymd = (v) => (typeof v === 'string' && YMD.test(v) ? v : null);

// A charge's payment steps as stored, each amount worked out from its percent of
// the charge (the last step takes the rounding), so changing the charge's amount
// on the Sale page rescales them. null = no steps (paid with the balance).
export function cleanSteps(payments, amount) {
  if (!Array.isArray(payments)) return null;
  const steps = [];
  for (const [i, st] of payments.entries()) {
    if (!st || typeof st !== 'object' || !DUE_VALUES.includes(st.due)) continue;
    const percent = Math.round(num(st.percent) * 100) / 100;
    if (!(percent > 0)) continue;
    const row = { id: text(st.id) || `step${i}`, percent, amount: 0, due: st.due };
    const n = count(st.n);
    if (n != null && st.due !== 'with_balance') row.n = n;
    if (ymd(st.due_date)) row.due_date = st.due_date;
    if (ymd(st.paid_date)) row.paid_date = st.paid_date;
    steps.push(row);
  }
  if (!steps.length) return null;
  const total = steps.reduce((t, st) => t + st.percent, 0);
  let left = cents(amount);
  steps.forEach((st, i) => {
    st.amount = i === steps.length - 1 ? cents(left) : cents(amount * st.percent / total);
    left -= st.amount;
  });
  return steps;
}

// A payment plan copied onto a sale as dated steps, when she approves the extra.
// `at_weeks` is dated from the pup's birth date, `on_approval` from the day she
// approves; `before_pickup` and `with_balance` stay undated and are read live
// (stepDueDate). → steps, or null for a plan of one "with the balance" step.
export function planSteps(plan, amount, { approvalDate, birthDate = null, openDays } = {}) {
  const steps = cleanPlan(plan);
  if (!steps || (steps.length === 1 && steps[0].due === 'with_balance')) return null;
  return cleanSteps(steps.map((st) => {
    const out = { id: crypto.randomUUID(), percent: st.percent, due: st.due, ...(st.n != null ? { n: st.n } : {}) };
    if (st.due === 'at_weeks' && birthDate) out.due_date = addDaysToYMD(birthDate, st.n * 7);
    if (st.due === 'on_approval' && approvalDate) out.due_date = addOpenDays(approvalDate, st.n || 0, openDays);
    return out;
  }), amount);
}

// When a step is due: its own date, else read live: before pickup from the pup's
// pickup date, with the balance from the sale's balance due date. '' = not known.
export function stepDueDate(step, { sale = null, pickupDate = '', openDays } = {}) {
  if (step.due_date) return step.due_date;
  if (step.due === 'before_pickup' && pickupDate) return addOpenDays(pickupDate, -(step.n || 0), openDays);
  if (step.due === 'with_balance') return sale?.balance_due_date || pickupDate || '';
  return '';
}

// "Puppy training, 50%" (a step's line name on invoices and in Financials).
export const stepLabel = (charge, step) => `${charge.label}, ${step.percent}%`;

// The sale's extra charges, as the money code reads them.
export function saleExtraCharges(sale) {
  return cleanList(sale?.extra_charges);
}

export function extraChargesTotal(sale) {
  return cents(saleExtraCharges(sale).reduce((t, x) => t + x.amount, 0));
}

// The rows a form hands over, checked before saving. A row with only a name or
// only an amount is a mistake she should fix; a fully blank row is dropped.
// → { list, error } (error is a message, or '').
export function readExtraCharges(rows = []) {
  for (const r of rows) {
    const hasLabel = !!text(r.label);
    const hasAmount = text(r.amount) !== '';
    if (hasLabel && !(num(r.amount) > 0)) return { list: [], error: `Give "${text(r.label)}" an amount above $0.` };
    if (!hasLabel && hasAmount) return { list: [], error: 'Give each extra charge a name.' };
  }
  return { list: cleanList(rows, { mintIds: true }), error: '' };
}

// --- The price list -------------------------------------------------------------

// When each part of an extra is due. `n` is weeks of age for at_weeks, days after
// approval for on_approval (optional), days before pickup for before_pickup.
export const PLAN_DUE = Object.freeze([
  { value: 'at_weeks',      label: 'At age',           unit: 'weeks old',          needsN: true },
  { value: 'on_approval',   label: 'After approval',   unit: 'days after',         needsN: false },
  { value: 'before_pickup', label: 'Before pickup',    unit: 'days before pickup', needsN: true },
  { value: 'with_balance',  label: 'With the balance', unit: '',                   needsN: false }
]);
const DUE_VALUES = PLAN_DUE.map((d) => d.value);
export const WINDOW_FIELDS = Object.freeze(['request_from_weeks', 'request_until_weeks', 'cancel_until_weeks']);
const PRICE_ROW_FIELDS = ['group', 'description', 'family_can_request', ...WINDOW_FIELDS, 'boarding_days', 'payment_plan'];

// A whole number ≥ 0, or null for blank/anything else.
function count(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

// A payment plan as stored: steps with a percent above 0 and a known `due`; null
// when there's no usable step (= use the group's, else "all with the balance").
export function cleanPlan(plan) {
  if (!Array.isArray(plan)) return null;
  const out = [];
  for (const st of plan) {
    if (!st || typeof st !== 'object' || !DUE_VALUES.includes(st.due)) continue;
    const percent = Math.round(num(st.percent) * 100) / 100;
    if (!(percent > 0)) continue;
    const step = { percent, due: st.due };
    const n = count(st.n);
    if (n != null && st.due !== 'with_balance') step.n = n;
    out.push(step);
  }
  return out.length ? out : null;
}

// What's wrong with a plan she typed, or ''. Blank is fine (no plan).
export function planProblem(plan) {
  if (!Array.isArray(plan) || !plan.length) return '';
  let total = 0;
  for (const st of plan) {
    const percent = num(st.percent);
    if (!(percent > 0)) return 'Give each payment a percent above 0.';
    const due = PLAN_DUE.find((d) => d.value === st.due);
    if (!due) return 'Choose when each payment is due.';
    if (due.needsN && count(st.n) == null) return `Say how many ${due.unit.split(' ')[0]} for "${due.label.toLowerCase()}".`;
    total += percent;
  }
  if (Math.abs(total - 100) > 0.01) return `The payments add up to ${Math.round(total * 100) / 100}%; they need to add up to 100%.`;
  return '';
}

// "50% at 8 weeks, 50% with the balance".
export function planText(plan) {
  const steps = cleanPlan(plan);
  if (!steps) return 'All with the balance';
  return steps.map((st) => {
    const pct = `${st.percent}%`;
    if (st.due === 'at_weeks') return `${pct} at ${st.n} week${st.n === 1 ? '' : 's'}`;
    if (st.due === 'on_approval') return st.n ? `${pct} ${st.n} day${st.n === 1 ? '' : 's'} after you approve it` : `${pct} when you approve it`;
    if (st.due === 'before_pickup') return `${pct} ${st.n} day${st.n === 1 ? '' : 's'} before pickup`;
    return `${pct} with the balance`;
  }).join(', ');
}

// A price list as stored: cleanList's rows plus whichever price-list fields are set.
function cleanPriceList(list, { mintIds = false } = {}) {
  const base = cleanList(list, { mintIds });
  if (!Array.isArray(list)) return base;
  const byPlace = list.filter((x) => x && typeof x === 'object' && text(x.label) && cents(num(x.amount)) > 0);
  return base.map((row, i) => {
    const src = byPlace[i];
    delete row.fee_for; delete row.list_id; delete row.payments; delete row.boarding_days; delete row.completed_date; delete row.kept_after_cancel;
    const group = text(src.group);
    if (group) row.group = group;
    const description = text(src.description);
    if (description) row.description = description.slice(0, 300);
    if (src.family_can_request === true) row.family_can_request = true;
    for (const k of [...WINDOW_FIELDS, 'boarding_days']) {
      const n = count(src[k]);
      if (n != null) row[k] = n;
    }
    const plan = cleanPlan(src.payment_plan);
    if (plan) row.payment_plan = plan;
    return row;
  });
}

// A kennel's price list.
export function kennelChargeList(kennel) {
  return cleanPriceList(kennel?.extra_charge_list);
}

// A kennel's group defaults: one per named group, windows and plan cleaned.
export function kennelChargeGroups(kennel) {
  const list = Array.isArray(kennel?.extra_charge_groups) ? kennel.extra_charge_groups : [];
  const seen = new Set();
  const out = [];
  for (const g of list) {
    const name = text(g?.name);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const row = { name };
    for (const k of WINDOW_FIELDS) {
      const n = count(g[k]);
      if (n != null) row[k] = n;
    }
    const plan = cleanPlan(g.payment_plan);
    if (plan) row.payment_plan = plan;
    out.push(row);
  }
  return out;
}

// The price list in her groups, in the order each group first appears; extras
// without a group come last under ''. → [{ group, items }]
export function groupedChargeList(list) {
  const order = [];
  const by = new Map();
  for (const x of list) {
    const g = x.group || '';
    if (!by.has(g)) { by.set(g, []); order.push(g); }
    by.get(g).push(x);
  }
  const named = order.filter((g) => g);
  return [...named, ...(by.has('') ? [''] : [])].map((group) => ({ group, items: by.get(group) }));
}

// The rules an extra follows: its own window and plan where set, else its group's.
// → { request_from_weeks, request_until_weeks, cancel_until_weeks, payment_plan }
// (each window null = no limit; the plan is never null: no plan = all with the balance).
export function chargeRules(item, groups = []) {
  const g = item?.group ? groups.find((x) => x.name.toLowerCase() === item.group.toLowerCase()) : null;
  const out = {};
  for (const k of WINDOW_FIELDS) out[k] = item?.[k] ?? g?.[k] ?? null;
  out.payment_plan = cleanPlan(item?.payment_plan) || cleanPlan(g?.payment_plan) || [{ percent: 100, due: 'with_balance' }];
  return out;
}

// The dates an extra can be asked for and cancelled, from the litter's birth date.
// "Until N weeks" means while the pup is younger than N weeks (the last day is the
// day before it turns N weeks); "from N weeks" starts the day it does.
// → { open_from, open_until, cancel_until } (YYYY-MM-DD or null = no limit), or
// null when there's no birth date to count from.
export function requestWindow(item, groups, birthDate) {
  if (!birthDate) return null;
  const r = chargeRules(item, groups);
  const at = (w) => addDaysToYMD(birthDate, w * 7);
  return {
    open_from: r.request_from_weeks != null ? at(r.request_from_weeks) : null,
    open_until: r.request_until_weeks != null ? addDaysToYMD(at(r.request_until_weeks), -1) : null,
    cancel_until: r.cancel_until_weeks != null ? addDaysToYMD(at(r.cancel_until_weeks), -1) : null
  };
}

// The rows the price-list editor hands over, checked, merged with what's stored:
// a row that leaves out a field (Kels's name-and-price form) keeps the stored
// value, matched by id. → { list, error }
export function readPriceList(rows = [], previous = []) {
  const prev = new Map((Array.isArray(previous) ? previous : []).filter((x) => x && x.id).map((x) => [x.id, x]));
  const { error } = readExtraCharges(rows);
  if (error) return { list: [], error };
  const merged = [];
  for (const r of rows) {
    if (!text(r.label) && text(r.amount) === '') continue;
    const old = (r.id && prev.get(r.id)) || {};
    const row = { id: r.id || null, label: r.label, amount: r.amount };
    for (const k of PRICE_ROW_FIELDS) row[k] = k in r ? r[k] : old[k];
    const name = text(r.label);
    const from = count(row.request_from_weeks);
    const until = count(row.request_until_weeks);
    if (from != null && until != null && until <= from) return { list: [], error: `"${name}": the "until" age has to be after the "from" age.` };
    const planError = planProblem(row.payment_plan);
    if (planError) return { list: [], error: `"${name}": ${planError}` };
    merged.push(row);
  }
  return { list: cleanPriceList(merged, { mintIds: true }), error: '' };
}

// The group defaults the editor hands over, checked. → { groups, error }
export function readChargeGroups(rows = []) {
  for (const g of rows) {
    const name = text(g.name);
    if (!name) continue;
    const from = count(g.request_from_weeks);
    const until = count(g.request_until_weeks);
    if (from != null && until != null && until <= from) return { groups: [], error: `${name}: the "until" age has to be after the "from" age.` };
    const planError = planProblem(g.payment_plan);
    if (planError) return { groups: [], error: `${name}: ${planError}` };
  }
  return { groups: kennelChargeGroups({ extra_charge_groups: rows }), error: '' };
}

// A new charge for a sale, from a price-list entry (or blank, to type one in).
export function newExtraCharge(preset = null) {
  return { id: crypto.randomUUID(), label: text(preset?.label), amount: preset ? cents(num(preset.amount)) : '' };
}

// The fee to charge back for a deposit paid through an account set to charge its
// fee back, or null when there's nothing to offer: no such account, no usable
// rate, no deposit, the deposit not paid yet, or the sale already carries it.
// `depositPaid` is the caller's read of the sale (incomeView's rule).
// → null | { fee_for: 'deposit', label, amount }
export function depositFeeChargeBack(sale, account, depositPaid) {
  if (!sale || !account?.fee_charge_back || !depositPaid) return null;
  const rate = feeRate(account);
  if (!isUsableRate(rate)) return null;
  if (saleExtraCharges(sale).some((x) => x.fee_for === 'deposit')) return null;
  const amount = processingFee(sale.deposit_amount, rate);
  if (!(amount > 0)) return null;
  return { fee_for: 'deposit', label: `${text(account.name) || 'Payment'} fee`, amount };
}
