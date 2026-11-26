// costCover.js — covering what getting paid costs her (Payment Methods plan §5.1–§5.3,
// Phase 4). She never adds a fee for how a family pays (D1). Instead she may raise her
// prices one of two ways, for every buyer whatever they pay with (D11):
//   service_fee   the cost is its own line inside the total ("$2,575, includes a $75
//                 service fee"), on invoices, contracts and Income.
//   in_price      the cost goes into the price itself ("$2,575"); her records still
//                 know how much of it is the increase.
//
// Kennel.cost_cover: { show, rules: [{ id, applies_to, percent?, amount?, refundable? }] }
//   applies_to   COVER_KINDS: puppy (a sale's price), extras, transport, boarding, stud.
//                At most one rule per kind; a kind with no rule adds nothing.
//   refundable   false prints "non-refundable" beside a service fee (service fees only).
// Litter.cost_cover: { percent? | amount? } | { none: true }: the puppy rule for that
//   litter's sales.
//
// Each sale copies the rules when it's created (coverForNewSale), so a rule change
// never rewrites a sale and sales made before Phase 4 never get one (D17):
// Sale.cost_cover_amounts: { show, <kind>?: amount, <kind>_percent?: percent,
//                            <kind>_refundable?: false }
//   <kind>_percent  the amount follows its charge: percent × the charge, worked out
//                   every time it's read, while the sale is open and no contract is
//                   signed. Signing writes the amounts (frozenCover); a hand-typed
//                   amount stops following too.
//   <kind>          a dollar amount (a dollar rule, an amount she typed, or one
//                   written at signing). Only charged while its charge is on the sale.
// StudService.cost_cover_amounts: the same, with the one kind `stud`.
// The deposit carries its share of the puppy rule (owner, 2026-11-26, Payment Methods
// plan D30): the puppy amount split by size, the deposit's part owed with the deposit
// (a service fee `service_fee_deposit`, or the deposit itself raised with payment-fee
// prices) and the rest with the later payments. The total never changes.
//
// Readers never see the stored shape: saleCover / studCover give the amounts, and
// pricedSale / serviceFeeCharges hand the money code (paymentSchedule.saleCharges,
// incomeView) the sale as families are charged. Pure; no db, and no imports, so the
// repos and light pages that read it carry nothing more.

const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
const cents = (n) => Math.round(n * 100) / 100;
const text = (v) => String(v ?? '').trim();

export const COVER_SHOWS = ['service_fee', 'in_price'];
export const COVER_KINDS = ['puppy', 'extras', 'transport', 'boarding', 'stud'];
export const SALE_KINDS = ['puppy', 'extras', 'transport', 'boarding'];
export const COVER_KIND_LABELS = { puppy: 'Puppy price', extras: 'Extras', transport: 'Transport', boarding: 'Boarding', stud: 'Stud fee' };
// What a service fee is called on invoices, contracts and family pages.
export const SERVICE_FEE_LABELS = { puppy: 'Service fee', extras: 'Service fee on extras', transport: 'Service fee on transport', boarding: 'Service fee on boarding', stud: 'Service fee', deposit: 'Service fee on deposit' };
// A service fee's line: "Service fee", with "(non-refundable)" when her rule says so.
// `deposit`: the puppy fee's share owed with the deposit (D30).
export const serviceFeeLabel = (kind, refundable = true, { deposit = false } = {}) => `${SERVICE_FEE_LABELS[deposit ? 'deposit' : kind]}${refundable ? '' : ' (non-refundable)'}`;
// The deposit's share of a puppy amount (D30): by size, to the cent. 0 without a
// deposit, a price, or an amount.
export function depositShare(puppyAmount, price, deposit) {
  const a = num(puppyAmount);
  const p = num(price);
  const d = Math.min(num(deposit), p);
  return a > 0 && p > 0 && d > 0 ? cents(a * d / p) : 0;
}
// Which schedule `covers` a kind's service fee is owed with (paymentSchedule).
export const COVER_SCHEDULE = { puppy: 'price', extras: 'extras', transport: 'transport', boarding: 'boarding' };
// The credit use (CREDIT_USES) that may pay a kind's service fee.
export const COVER_USE = { puppy: 'price', extras: 'extras', transport: 'extras', boarding: 'extras' };
export const PERCENT_MAX = 25;

const pct = (v) => {
  const n = Number(v);
  return v === '' || v == null || !Number.isFinite(n) || !(n > 0) ? null : Math.min(Math.round(n * 1000) / 1000, PERCENT_MAX);
};
const dollars = (v) => {
  const n = Number(v);
  return v === '' || v == null || !Number.isFinite(n) || !(n > 0) ? null : cents(n);
};

// --- Her rules (Kennel.cost_cover) -----------------------------------------------------

// Her setting as stored, cleaned: { show: 'service_fee'|'in_price'|null, rules: { kind: rule } }.
// show null = neither (the default): no rule adds anything.
export function coverRules(kennel) {
  const raw = kennel?.cost_cover;
  const show = COVER_SHOWS.includes(raw?.show) ? raw.show : null;
  const rules = {};
  for (const r of Array.isArray(raw?.rules) ? raw.rules : []) {
    if (!r || !COVER_KINDS.includes(r.applies_to) || rules[r.applies_to]) continue;
    const percent = pct(r.percent);
    const amount = percent ? null : dollars(r.amount);
    if (!percent && !amount) continue;
    rules[r.applies_to] = { id: text(r.id) || r.applies_to, applies_to: r.applies_to, ...(percent ? { percent } : { amount }), ...(r.refundable === false ? { refundable: false } : {}) };
  }
  return { show, rules };
}

// The Settings card's rows, checked. rows: [{ applies_to, how: 'percent'|'amount', value,
// refundable }] (a blank value = no rule for that kind). → { cost_cover, error }.
export function readCostCover(show, rows = []) {
  const s = COVER_SHOWS.includes(show) ? show : null;
  const rules = [];
  for (const r of rows) {
    if (!COVER_KINDS.includes(r.applies_to) || text(r.value) === '') continue;
    const n = Number(r.value);
    const name = COVER_KIND_LABELS[r.applies_to];
    if (!Number.isFinite(n) || n <= 0) return { cost_cover: null, error: `${name}: enter a number above 0, or leave it blank.` };
    if (r.how === 'percent' && n > PERCENT_MAX) return { cost_cover: null, error: `${name}: ${PERCENT_MAX}% at most.` };
    rules.push({ id: r.applies_to, applies_to: r.applies_to, ...(r.how === 'percent' ? { percent: pct(n) } : { amount: dollars(n) }), ...(s === 'service_fee' && r.refundable === false ? { refundable: false } : {}) });
  }
  return { cost_cover: { show: s, rules }, error: '' };
}

// A litter's own puppy rule, cleaned: { percent } | { amount } | { none: true } | null.
export function litterCover(litter) {
  const raw = litter?.cost_cover;
  if (!raw || typeof raw !== 'object') return null;
  if (raw.none === true) return { none: true };
  const percent = pct(raw.percent);
  if (percent) return { percent };
  const amount = dollars(raw.amount);
  return amount ? { amount } : null;
}

// The puppy rule a litter's sales start from: its own, else hers.
export function puppyRuleFor(kennel, litter) {
  const own = litterCover(litter);
  if (own?.none) return null;
  const { rules } = coverRules(kennel);
  if (own) return { ...own, ...(rules.puppy?.refundable === false ? { refundable: false } : {}) };
  return rules.puppy || null;
}

const ruleFields = (kind, rule) => (!rule ? {} : {
  ...(rule.percent ? { [`${kind}_percent`]: rule.percent } : { [kind]: rule.amount }),
  ...(rule.refundable === false ? { [`${kind}_refundable`]: false } : {})
});

// What a new sale carries (Sale.cost_cover_amounts), copied from her rules (the
// litter's puppy rule first). null when she hasn't chosen a way, or no rule applies.
export function coverForNewSale(kennel, litter = null) {
  const { show, rules } = coverRules(kennel);
  if (!show) return null;
  const out = { show, ...ruleFields('puppy', puppyRuleFor(kennel, litter)) };
  for (const k of ['extras', 'transport', 'boarding']) Object.assign(out, ruleFields(k, rules[k]));
  return Object.keys(out).length > 1 ? out : null;
}

// What a new outgoing stud service carries (StudService.cost_cover_amounts), or null.
export function coverForNewStud(kennel) {
  const { show, rules } = coverRules(kennel);
  return show && rules.stud ? { show, ...ruleFields('stud', rules.stud) } : null;
}

// --- A sale's amounts -----------------------------------------------------------------

const boardingTotal = (s) => {
  const n = parseInt(s?.deferred_boarding_duration_days, 10);
  return cents(num(s?.deferred_boarding_amount) * (Number.isFinite(n) && n > 0 ? n : 1));
};
// Extras a cover counts: her own extras, not a fee charged back and not one paid on
// its own payment plan (those keep their steps' amounts).
// Read as extraCharges.saleExtraCharges reads them: a name and an amount above 0, a
// row without an id by its place in the list.
const coveredExtras = (s) => (Array.isArray(s?.extra_charges) ? s.extra_charges : [])
  .map((x, i) => (x && typeof x === 'object' ? { id: x.id || `row${i}`, amount: cents(num(x.amount)), label: text(x.label), fee_for: x.fee_for, payments: x.payments } : null))
  .filter((x) => x && x.label && x.amount > 0 && !x.fee_for && !(Array.isArray(x.payments) && x.payments.length));

// Each kind's charge, before any cover: what a percent is a percent of.
export function coverBases(sale) {
  return {
    puppy: cents(num(sale?.price)),
    extras: cents(coveredExtras(sale).reduce((t, x) => t + x.amount, 0)),
    transport: cents(num(sale?.transport_fee)),
    boarding: boardingTotal(sale),
    stud: cents(num(sale?.fee_amount))
  };
}

function amountsOf(stored, bases, kinds) {
  const out = {};
  const following = {};
  for (const k of kinds) {
    const base = bases[k];
    if (!(base > 0)) { out[k] = 0; continue; }
    const p = pct(stored[`${k}_percent`]);
    if (p) { out[k] = cents(base * p / 100); following[k] = p; } else out[k] = dollars(stored[k]) || 0;
  }
  return { out, following };
}

// A sale's cost-cover amounts as charged now: { show, puppy, extras, transport,
// boarding, total, following: { kind: percent }, nonrefundable: [kind] }, or null when
// the sale has none (made before Phase 4, or no rule applied).
export function saleCover(sale) {
  const stored = sale?.cost_cover_amounts;
  if (!stored || typeof stored !== 'object' || !COVER_SHOWS.includes(stored.show)) return null;
  const { out, following } = amountsOf(stored, coverBases(sale), SALE_KINDS);
  const total = cents(SALE_KINDS.reduce((t, k) => t + out[k], 0));
  // The deposit's part of the puppy amount (D30), included in `puppy`.
  const deposit = depositShare(out.puppy, sale?.price, sale?.deposit_amount);
  return { show: stored.show, ...out, deposit, total, following, nonrefundable: SALE_KINDS.filter((k) => stored[`${k}_refundable`] === false) };
}

// An outgoing stud service's: { show, stud, following, nonrefundable } or null.
export function studCover(stud) {
  const stored = stud?.cost_cover_amounts;
  if (!stored || typeof stored !== 'object' || !COVER_SHOWS.includes(stored.show)) return null;
  const { out, following } = amountsOf(stored, coverBases(stud), ['stud']);
  return { show: stored.show, stud: out.stud, total: out.stud, following, nonrefundable: stored.stud_refundable === false ? ['stud'] : [] };
}

// The changes that fix a record's amounts where they are (a contract was signed):
// every kind following its charge gets its amount written and stops following. Kinds
// whose charge isn't on the record yet keep their percent, so a charge added later
// still gets its share. → { cost_cover_amounts } or null when nothing follows.
export function frozenCover(record, kinds = SALE_KINDS) {
  const stored = record?.cost_cover_amounts;
  if (!stored || typeof stored !== 'object') return null;
  const bases = coverBases(record);
  const next = { ...stored };
  let changed = false;
  for (const k of kinds) {
    const p = pct(stored[`${k}_percent`]);
    if (!p || !(bases[k] > 0)) continue;
    next[k] = cents(bases[k] * p / 100);
    delete next[`${k}_percent`];
    changed = true;
  }
  return changed ? { cost_cover_amounts: next } : null;
}

// The sale's cost_cover_amounts with one kind typed by hand (a blank or 0 = none for
// that kind): it stops following.
export function withHandAmount(stored, kind, value) {
  const next = { ...(stored || {}) };
  delete next[`${kind}_percent`];
  const amount = dollars(value);
  if (amount) next[kind] = amount; else next[kind] = 0;
  return next;
}

// A new cost_cover_amounts for a sale that has none (she adds one by hand on a sale
// made before Phase 4): the kennel's way, else service fees.
export const handCoverStart = (kennel) => ({ show: coverRules(kennel).show || 'service_fee' });

// --- The sale as families are charged ---------------------------------------------------

// Split `amount` over `parts` ([{ id, amount }]) by size, to the cent; the last takes
// what rounding leaves. → Map id → share.
function shares(amount, parts) {
  const base = parts.reduce((t, p) => t + p.amount, 0);
  const out = new Map();
  if (!(amount > 0) || !(base > 0)) return out;
  let left = cents(amount);
  parts.forEach((p, i) => {
    const s = i === parts.length - 1 ? left : cents(amount * p.amount / base);
    out.set(p.id, s);
    left = cents(left - s);
  });
  return out;
}

// The sale as its money code reads it. With payment-fee prices (in_price), each
// charge carries its share: the price, transport and her extras raised by their
// amounts, and boarding's in `__boarding_cover` (boarding is a rate × a count). With
// service fees, or none, the sale itself. Marked `__priced` so it's never raised
// twice. Never saved.
export function pricedSale(sale) {
  if (!sale || sale.__priced) return sale;
  const c = saleCover(sale);
  if (!c || c.show !== 'in_price' || !(c.total > 0)) return sale;
  const out = { ...sale, __priced: true };
  if (c.puppy > 0) out.price = cents(num(sale.price) + c.puppy);
  // The deposit's share goes on the deposit (D30); the price carries all of it.
  if (c.deposit > 0) out.deposit_amount = cents(num(sale.deposit_amount) + c.deposit);
  if (c.transport > 0) out.transport_fee = cents(num(sale.transport_fee) + c.transport);
  if (c.boarding > 0) out.__boarding_cover = c.boarding;
  if (c.extras > 0) {
    const sh = shares(c.extras, coveredExtras(sale));
    out.extra_charges = (sale.extra_charges || []).map((x, i) => {
      const id = x?.id || `row${i}`;
      return sh.has(id) ? { ...x, amount: cents(num(x.amount) + sh.get(id)) } : x;
    });
  }
  return out;
}

// The service fees on a sale (show 'service_fee'), one per kind with an amount:
// [{ kind, key: 'service_fee_<kind>', label, amount, refundable, deposit? }]. [] otherwise.
// The puppy fee's share owed with the deposit is its own, first (`service_fee_deposit`,
// `deposit: true`, kind puppy, D30); `service_fee_puppy` is the rest.
export function serviceFeeCharges(sale) {
  const c = saleCover(sale);
  if (!c || c.show !== 'service_fee') return [];
  const out = [];
  for (const k of SALE_KINDS) {
    if (!(c[k] > 0)) continue;
    const refundable = !c.nonrefundable.includes(k);
    const dep = k === 'puppy' ? c.deposit : 0;
    if (dep > 0) out.push({ kind: k, key: 'service_fee_deposit', label: serviceFeeLabel(k, refundable, { deposit: true }), amount: dep, refundable, deposit: true });
    const rest = cents(c[k] - dep);
    if (rest > 0) out.push({ kind: k, key: `service_fee_${k}`, label: serviceFeeLabel(k, refundable), amount: rest, refundable });
  }
  return out;
}

// The stud service as it's charged: { fee, serviceFee: { amount, refundable } | null }.
export function pricedStud(stud) {
  const c = studCover(stud);
  const fee = cents(num(stud?.fee_amount));
  if (!c || !(c.stud > 0)) return { fee, serviceFee: null };
  if (c.show === 'in_price') return { fee: cents(fee + c.stud), serviceFee: null };
  return { fee, serviceFee: { amount: c.stud, refundable: !c.nonrefundable.includes('stud') } };
}

// A price with the puppy rule on it, as families see a listed price (the litter's
// expected prices, a pup's price): { price, serviceFee } — with payment-fee prices the
// price raised and serviceFee 0; with service fees the price as she set it and the fee
// beside it ("includes a $X service fee" is price + serviceFee). null price → null.
// A listed deposit as families see it (D30): { deposit, serviceFee, total }, the
// deposit carrying its share of the puppy amount on `price` (listedPrice's). With
// payment-fee prices the deposit raised; with service fees the fee beside it. null
// deposit → null.
export function listedDeposit(deposit, price, kennel, litter = null) {
  const d = deposit == null || deposit === '' ? null : Number(deposit);
  if (d == null || !Number.isFinite(d)) return null;
  const lp = listedPrice(price, kennel, litter);
  const puppy = lp ? cents(lp.total - num(price)) : 0;
  const share = depositShare(puppy, price, d);
  const show = coverRules(kennel).show;
  if (show === 'in_price') return { deposit: cents(d + share), serviceFee: 0, total: cents(d + share) };
  return { deposit: cents(d), serviceFee: share, total: cents(d + share) };
}

export function listedPrice(price, kennel, litter = null) {
  const p = price == null || price === '' ? null : Number(price);
  if (p == null || !Number.isFinite(p)) return null;
  const { show } = coverRules(kennel);
  const rule = show ? puppyRuleFor(kennel, litter) : null;
  const add = !rule || !(p > 0) ? 0 : rule.percent ? cents(p * rule.percent / 100) : rule.amount;
  if (show === 'in_price') return { price: cents(p + add), serviceFee: 0, total: cents(p + add) };
  return { price: cents(p), serviceFee: add, total: cents(p + add) };
}
