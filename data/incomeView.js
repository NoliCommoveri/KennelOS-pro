// incomeView.js — the DERIVED income side of the Financials hub. There is no
// income table: this module reads the Sale table and the outgoing StudService
// table (the only two places money-in is recorded) and normalizes each into one
// view-model row, classifying every money component as earned or anticipated.
// Same pattern awayBoard.js uses to union rows from two repos — a read-only
// aggregator over existing repos, storing nothing of its own (see §21).
//
// Received waitlist application fees (Waitlist Spec §5.3) are the third source,
// read from waitlist_entries (Pro-only, editionFlags.waitlist). A fee whose
// policy is `credited_to_purchase` is part of the pup's price, so once that
// family's Sale exists (entry.placed_sale_id) the credit comes off the Sale's
// balance here — otherwise the same money would count twice.
//
// A sales channel's processing fee (Sale.processing_fee_amount, Integrations plan
// §5) comes off as negative `processing_fee` components, so `earned` is what she
// actually received. Invoices and paidOnSale never see it: they show the buyer's
// own amounts.
//
// Why derived, not stored: revenue already lives on Sale.price/deposit_amount/
// transport_fee/deferred_boarding_amount and StudService.fee_amount. Duplicating
// it into an income table (or adding an `is_earned` flag) would be a stored
// back-pointer the architecture forbids — so earned/anticipated is COMPUTED here
// from status + which paid-date fields are filled, and recomputed on every load.
import { saleRepo } from './saleRepo.js';
import { studServiceRepo } from './studServiceRepo.js';
import { dogRepo } from './dogRepo.js';
import { contactRepo } from './contactRepo.js';
import { waitlistEntryRepo } from './waitlistEntryRepo.js';
import { waitlistOfferRepo } from './waitlistOfferRepo.js';
import { kennelRepo } from './kennelRepo.js';
import { creditSale } from './familyExtras.js';
import { creditsOf, feeCharge, allocateCredits, saleCredited } from './receivedCredits.js';
import { inScopeOnly } from './kennelScope.js';
import { ourRole } from './studRules.js';
import { editionFlags } from './editionConfig.js';
import { saleExtraCharges, stepLabel } from './extraCharges.js';
import { INCOME_COMPONENTS, INVOICE_LINE_LABELS, RELEASED_SALE_STATUSES, isLostSale, descriptor } from './vocab.js';

const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
const round2 = (n) => Math.round(n * 100) / 100;

// A credited application fee on a sale: { amount, toward } — 'balance' (the rest of
// the price, the default) or 'deposit' (her waitlist setting fee_credit_toward). A
// bare number is toward the balance.
export function feeCreditOf(fc) {
  return fc && typeof fc === 'object'
    ? { amount: num(fc.amount), toward: fc.toward === 'deposit' ? 'deposit' : 'balance' }
    : { amount: num(fc), toward: 'balance' };
}
export const feeCreditAmount = (fc) => feeCreditOf(fc).amount;

// How a fee credit splits over the sale's deposit and balance: toward the deposit,
// up to the deposit, and anything beyond it off the balance.
export function feeCreditSplit(sale, fc) {
  const f = feeCreditOf(fc);
  if (f.toward !== 'deposit') return { deposit: 0, balance: f.amount };
  const deposit = Math.min(f.amount, num(sale?.deposit_amount));
  return { deposit, balance: round2(f.amount - deposit) };
}

// Deferred boarding is stored as amount + a free-text count of frequency units
// (`deferred_boarding_duration_days`, despite the name — e.g. "2" = two weeks).
// The companion bundle multiplies amount × count; we do the same. An unparseable
// or missing count means the amount stands once (count = 1).
function boardingCount(sale) {
  const n = parseInt(sale.deferred_boarding_duration_days, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// A component is "paid" (already collected) when a paid-date is recorded OR the
// status has advanced past the point that money changes hands. Date-driven first
// so a returned/cancelled sale that recorded a paid deposit still reads as paid —
// exactly the "keep recorded paid amounts as earned" rule (owner decision, §21).
export function depositPaid(s) {
  return !!s.deposit_date || ['deposit_paid', 'paid_in_full', 'delivered'].includes(s.status);
}
function balancePaid(s) {
  return !!s.balance_paid_date || ['paid_in_full', 'delivered'].includes(s.status);
}

// Break a Sale into its earned/anticipated cash components. `price` splits into a
// deposit portion and a balance portion; transport, deferred boarding and each
// extra charge (§21.2, one `extra` component apiece, keyed by its id) ride with
// the balance (collected at pickup). On a returned/cancelled sale, only what was
// actually recorded as paid survives (as earned) — the rest is dropped, never
// anticipated (§21). A LOST sale (vocab.isLostSale: voided, or returned for a
// health problem within the guarantee) drops everything, paid or not: what was
// paid is refunded or carried to another pup's sale, never this sale's income.
// On any other status, an unpaid component is anticipated.
// `feeCredit` is a credited waitlist application fee already received for this
// sale (Waitlist Spec §5.3; feeCreditOf) — it was paid toward the price, so it
// comes off the balance, or off the deposit when her setting says so (never below 0).
// `received` (the Financials ledger only): the family's credits for funds already
// received toward this sale, { byKey: { lineKey: amount }, date } (familyCredit).
// The credited part of a component not yet paid is earned (on the credit's date);
// the rest stays anticipated. Invoices never pass it: their lines stay whole, and
// the credit prefills what's already collected instead.
function saleComponents(s, feeCredit = 0, received = null) {
  // Extras she kept when the family backed out (Family Requests plan §7.2) are still
  // owed whatever the sale's status: paid parts earned, the rest anticipated.
  const kept = saleExtraCharges(s).filter((x) => x.kept_after_cancel);
  if (isLostSale(s)) return keptParts(s, kept);
  const dead = RELEASED_SALE_STATUSES.includes(s.status);
  const price = num(s.price);
  const split = feeCreditSplit(s, feeCredit);
  const deposit = round2(num(s.deposit_amount) - split.deposit);
  const balance = Math.max(round2(price - num(s.deposit_amount) - split.balance), 0);
  const parts = [
    { component: 'deposit', amount: deposit, paid: depositPaid(s) },
    { component: 'balance', amount: balance, paid: balancePaid(s) },
    { component: 'transport', amount: num(s.transport_fee), paid: balancePaid(s) },
    { component: 'boarding', amount: num(s.deferred_boarding_amount) * boardingCount(s), paid: balancePaid(s) },
    ...saleExtraCharges(s).flatMap(extraParts.bind(null, s))
  ];
  const out = [];
  if (dead && kept.length) return [...deadParts(parts.filter((p) => !(p.key && kept.some((x) => p.key === `extra:${x.id}` || p.key.startsWith(`extra:${x.id}:`))))), ...keptParts(s, kept)];
  for (const p of parts) {
    if (!p.amount) continue;
    const named = p.key ? { key: p.key, label: p.label, ...(p.paidDate ? { paid_date: p.paidDate } : {}), ...(p.dueDate ? { due_date: p.dueDate } : {}) } : {};
    const credited = !dead && !p.paid ? Math.min(num(received?.byKey?.[p.key || p.component]), p.amount) : 0;
    if (dead) {
      if (p.paid) out.push({ component: p.component, ...named, amount: p.amount, state: 'earned' });
      // unpaid remainder of a dead sale → dropped from both totals
    } else if (credited > 0) {
      out.push({ component: p.component, ...named, amount: credited, state: 'earned', credited: true, ...(received.date ? { paid_date: received.date } : {}) });
      const rest = Math.round((p.amount - credited) * 100) / 100;
      if (rest > 0) out.push({ component: p.component, ...named, amount: rest, state: 'anticipated' });
    } else {
      out.push({ component: p.component, ...named, amount: p.amount, state: p.paid ? 'earned' : 'anticipated' });
    }
  }
  return out;
}

// A released sale's parts: only what was paid survives, as earned.
function deadParts(parts) {
  return parts.filter((p) => p.amount && p.paid).map((p) => ({ component: p.component, ...(p.key ? { key: p.key, label: p.label, ...(p.paidDate ? { paid_date: p.paidDate } : {}) } : {}), amount: p.amount, state: 'earned' }));
}

// Kept extras on a released sale: each part earned once paid (its own paid date;
// the balance doesn't apply any more), else still owed.
function keptParts(s, kept) {
  return kept.flatMap((x) => extraParts({ ...s, status: 'deposit_pending', balance_paid_date: null }, x)).filter((p) => p.amount).map((p) => ({
    component: 'extra', key: p.key, label: p.label, amount: p.amount, state: p.paidDate ? 'earned' : 'anticipated',
    ...(p.paidDate ? { paid_date: p.paidDate } : {}), ...(p.dueDate ? { due_date: p.dueDate } : {})
  }));
}

// An extra charge's parts: one, paid with the balance; or, with a payment plan
// (Family Requests plan §3.1), one per step, keyed `extra:<id>:<step id>`, each
// earned on its own paid date or else with the balance.
function extraParts(s, x) {
  if (!x.payments) return [{ component: 'extra', key: `extra:${x.id}`, label: x.label, amount: x.amount, paid: balancePaid(s) }];
  return x.payments.map((st) => ({
    component: 'extra', key: `extra:${x.id}:${st.id}`, label: stepLabel(x, st), amount: st.amount,
    paid: Boolean(st.paid_date) || balancePaid(s), paidDate: st.paid_date || null, dueDate: st.due_date || null
  }));
}

// The sales channel's processing fee (Sale.processing_fee_amount, Integrations
// plan §5) as NEGATIVE `processing_fee` lines, so earned income is what she
// actually received. The fee was taken from the buyer's payments, so it is split
// across the sale's cash components in proportion to their size and follows each
// one: earned with a paid deposit, anticipated with an owed balance, filed under
// the same `when`, and dropped with whatever a released sale drops (a lost sale
// has no components, so no fee either). Kept OUT of saleComponents on purpose:
// that feeds the invoice and paidOnSale, which show the buyer's own amounts.
// `components` are the sale's dated components; `gross` is the full sale value
// they'd sum to while open, so a cancelled sale keeps only the paid share's fee.
function feeComponents(s, components, gross) {
  const fee = num(s.processing_fee_amount);
  if (!(fee > 0) || !(gross > 0) || !components.length) return [];
  const out = [];
  for (const c of components) {
    const share = Math.round((fee * c.amount / gross) * 100) / 100;
    if (share) out.push({ component: 'processing_fee', amount: -share, state: c.state, when: c.when, due: '' });
  }
  // Cents lost to rounding go on the last line, so a fully earned sale's fee
  // lines add up to exactly the stored fee.
  const kept = components.reduce((t, c) => t + c.amount, 0);
  if (out.length && Math.abs(kept - gross) < 0.005) {
    const sum = out.reduce((t, c) => t + c.amount, 0);
    out[out.length - 1].amount = Math.round((out[out.length - 1].amount - (fee + sum)) * 100) / 100;
  }
  return out;
}

// The full cash value of a sale while it's open: what its components would sum to
// before a released status drops the unpaid part. Lost sales count nothing.
function saleGross(s, feeCredit, received = null) {
  const open = RELEASED_SALE_STATUSES.includes(s.status) ? { ...s, status: 'deposit_pending', end_reason: null } : s;
  return saleComponents(open, feeCredit, received).reduce((t, c) => t + c.amount, 0);
}

// Break an outgoing StudService into its components. `fee_amount` is cash —
// earned once completed, anticipated while arranged/in_progress, dropped when
// failed/cancelled. `pick_value_amount` is a NON-CASH estimate: surfaced on its
// own `pick` line (state 'noncash') and never mixed into cash totals (§21).
function studComponents(s) {
  const out = [];
  const fee = num(s.fee_amount);
  if (fee) {
    if (s.status === 'completed') out.push({ component: 'stud_fee', amount: fee, state: 'earned' });
    else if (['arranged', 'in_progress'].includes(s.status)) out.push({ component: 'stud_fee', amount: fee, state: 'anticipated' });
    // failed / cancelled → dropped
  }
  const pick = num(s.pick_value_amount);
  if (pick) out.push({ component: 'pick', amount: pick, state: 'noncash' });
  return out;
}

// When each component's money moved (or is due): the date a monthly P&L files it
// under (reports, cash basis). A deposit on its deposit date, the balance and what
// rides with it on the balance-paid date; unpaid money on its due date. Each falls
// back to the sale's own date, so nothing goes undated when a date wasn't kept.
function saleComponentDate(s, c) {
  const fallback = s.sale_date || s.deposit_date || s.balance_paid_date || '';
  if (c.component === 'deposit') return (c.credited && c.paid_date) || s.deposit_date || fallback;
  if (c.state === 'earned') return c.paid_date || s.balance_paid_date || fallback;
  return c.due_date || s.balance_due_date || fallback;
}

function sumBy(components, state) {
  return components.reduce((t, c) => (c.state === state ? t + c.amount : t), 0);
}

// Cash line items for an invoice/receipt on ONE income record (§24). Reuses the
// exact earned/anticipated classification the Income view uses, so a generated
// document can never show a component the ledger wouldn't. Drops the non-cash
// `pick` line (never invoiceable) and tags each item with its line `key` (the
// component, or `extra:<id>` for an extra charge, so a sale's several extra charges
// are separate lines), its Financials `label` and the buyer-facing `invoiceLabel`
// (an extra charge's own name).
// `sourceType` is 'sale' | 'stud'; the invoice page and the generator modal
// both call this so their line items can't drift.
// `feeCredit` (sales only): a credited application fee already received — pass
// getSaleFeeCredit(sale.id) so a document's balance matches the ledger's.
export function incomeLineItems(sourceType, record, { feeCredit = 0 } = {}) {
  const comps = sourceType === 'sale' ? saleComponents(record, feeCredit) : studComponents(record);
  return comps
    .filter((c) => c.state !== 'noncash')
    .map((c) => ({
      ...c,
      key: c.key || c.component,
      label: descriptor(INCOME_COMPONENTS, c.component).label,
      invoiceLabel: c.component === 'extra' ? c.label : (INVOICE_LINE_LABELS[c.component] || c.component)
    }));
}

// What the buyer has paid on a sale (deposit, balance, transport, boarding), read
// the same way the ledger reads it — paid-dates, or a status past that point — but
// ignoring a released status, so a voided sale still says what was paid on it
// before it fell through (the waitlist's carry-over offer, Waitlist Spec §16.11).
// `asStatus` reads it as of the status it had before (the Sale page knows it);
// without it, only the recorded paid-dates count. A credited application fee isn't
// money paid on the sale, so pass `feeCredit` to keep it out of the balance.
// `received` (familyCredit's { byKey, date }) counts the family's credits for
// funds already received as paid too: what a balance-due figure wants, never the
// carry-over (the credit stays theirs).
export function paidOnSale(sale, { feeCredit = 0, asStatus = null, received = null } = {}) {
  if (!sale) return 0;
  const status = asStatus || (RELEASED_SALE_STATUSES.includes(sale.status) ? 'deposit_pending' : sale.status);
  return saleComponents({ ...sale, status, end_reason: null }, feeCredit, received)
    .filter((c) => c.state === 'earned')
    .reduce((sum, c) => sum + c.amount, 0);
}

// --- Waitlist application fees (Waitlist Spec §5.3) ------------------------------

// A fee counts once it's received and above 0 (a waived fee is no money). Refunds
// aren't tracked in W1: a refundable fee stays earned until she edits the entry.
const feeReceived = (e) => !e.is_archived && !!e.fee_received_date && num(e.fee_amount) > 0;

// saleId → { amount, toward }, from entries whose received fee is credited to the
// purchase price: on their sale as creditSale finds it (the one they're placed
// with, or their pick's while the deposit is pending, so a fee toward the deposit
// comes off it before it's paid), `toward` from their kennel's setting.
function feeCreditsBySale(entries, { sales = [], offers = [], kennels = [] } = {}) {
  const out = new Map();
  const towardOf = (e) => (kennels.find((k) => k.id === e.kennel_id)?.waitlist_config?.fee_credit_toward === 'deposit' ? 'deposit' : 'balance');
  for (const e of entries) {
    if (!feeReceived(e) || e.fee_credit_policy !== 'credited_to_purchase') continue;
    const saleId = e.placed_sale_id || creditSale(e, sales, offers, entries)?.id;
    if (!saleId) continue;
    const had = out.get(saleId);
    out.set(saleId, { amount: round2((had?.amount || 0) + num(e.fee_amount)), toward: towardOf(e) });
  }
  return out;
}

async function loadWaitlistEntries(includeArchived) {
  return editionFlags.waitlist ? waitlistEntryRepo.getAll({ includeArchived }) : [];
}

// The credited application fee for one sale ({ amount, toward }, amount 0 when
// none) — the invoice page passes it to incomeLineItems so the document's lines
// match the ledger.
const NO_FEE_CREDIT = Object.freeze({ amount: 0, toward: 'balance' });
export async function getSaleFeeCredit(saleId) {
  const ctx = await loadCreditContext();
  return (ctx && feeCreditsBySale(ctx.entries, ctx).get(saleId)) || NO_FEE_CREDIT;
}

// --- Credits for funds already received (receivedCredits.js) ----------------------

const CREDIT_USE_OF = { deposit: 'deposit', balance: 'price', transport: 'extras', boarding: 'extras', extra: 'extras' };

// A sale's charges a family's credit can pay, keyed like its invoice lines, at
// their full amounts (paid or not: a credit's share of a charge doesn't move once
// the rest is paid). None for a returned, cancelled or voided sale.
export function saleCreditCharges(sale, feeCredit = 0) {
  if (!sale || sale.is_archived || RELEASED_SALE_STATUSES.includes(sale.status)) return [];
  return saleComponents({ ...sale, status: 'deposit_pending', end_reason: null }, feeCredit)
    .filter((c) => CREDIT_USE_OF[c.component])
    .map((c) => ({ key: c.key || c.component, use: CREDIT_USE_OF[c.component], amount: c.amount }));
}

// How a family's credits are used: their fee, then their sale (`sale` may be null).
// → receivedCredits.allocateCredits' result plus `date` (the oldest credit's) and
// `received` ({ byKey, date } of the sale's lines, for saleComponents / paidOnSale),
// or null with no credits.
export function familyCredit(entry, sale, feeCredit = 0) {
  const credits = creditsOf(entry);
  if (!credits.length) return null;
  const alloc = allocateCredits(credits, [...feeCharge(entry), ...saleCreditCharges(sale, feeCredit)]);
  const date = credits[0].date || null;
  const byKey = Object.fromEntries(Object.entries(alloc.byKey).filter(([k]) => k !== 'fee'));
  return { ...alloc, date, received: { byKey, date } };
}

// What a family paid on a sale beyond their credits (the lost-pup carry-over): the
// credit's share stays on their entry as credit, so carrying it too would count it
// twice. `asStatus` as paidOnSale's.
export function paidBesidesCredits(sale, entry, { feeCredit = 0, asStatus = null } = {}) {
  if (!sale) return 0;
  const status = asStatus || (RELEASED_SALE_STATUSES.includes(sale.status) ? 'deposit_pending' : sale.status);
  const credit = entry ? familyCredit(entry, { ...sale, status, end_reason: null }, feeCredit) : null;
  if (!credit) return paidOnSale(sale, { feeCredit, asStatus });
  return Math.max(0, Math.round((paidOnSale(sale, { feeCredit, asStatus, received: credit.received }) - saleCredited(credit)) * 100) / 100);
}

async function loadCreditContext() {
  if (!editionFlags.waitlist) return null;
  const [entries, offers, sales, kennels] = await Promise.all([waitlistEntryRepo.getAll(), waitlistOfferRepo.getAll(), saleRepo.getAll(), kennelRepo.getAll({ includeArchived: true })]);
  return { entries, offers, sales, kennels };
}

// The entry whose credits go toward this sale, in a loaded context.
function creditEntryFor(sale, ctx) {
  if (!ctx || !sale) return null;
  return ctx.entries.find((e) => creditsOf(e).length && creditSale(e, ctx.sales, ctx.offers, ctx.entries)?.id === sale.id) || null;
}

// Everything a document about one sale takes off: the credited application fee
// and the family's credits. → { feeCredit, credit (familyCredit or null), entry }
export async function getSaleCredits(saleId) {
  const ctx = await loadCreditContext();
  const feeCredit = (ctx && feeCreditsBySale(ctx.entries, ctx).get(saleId)) || NO_FEE_CREDIT;
  const sale = ctx?.sales.find((s) => s.id === saleId) || null;
  const entry = creditEntryFor(sale, ctx);
  return { feeCredit, credit: entry ? familyCredit(entry, sale, feeCredit) : null, entry };
}

// One entry's credits as its page shows them, with the sale they go toward.
// → { credit (familyCredit or null), sale, feeCredit }
export async function getEntryCredit(entryId) {
  const ctx = await loadCreditContext();
  const entry = ctx?.entries.find((e) => e.id === entryId) || null;
  if (!entry) return { credit: null, sale: null, feeCredit: NO_FEE_CREDIT };
  const sale = creditSale(entry, ctx.sales, ctx.offers, ctx.entries);
  const feeCredit = (sale && feeCreditsBySale(ctx.entries, ctx).get(sale.id)) || NO_FEE_CREDIT;
  return { credit: familyCredit(entry, sale, feeCredit), sale, feeCredit };
}

// What a family's credits for funds already received have paid on each line of a
// document (invoice / receipt / payment request), keyed like incomeLineItems:
// a sale's lines, or a fee's `application_fee`. {} when none.
export async function getCreditedByLine(source, id) {
  if (source === 'sale') return (await getSaleCredits(id)).credit?.received.byKey || {};
  if (source === 'waitlist') {
    const fee = (await getEntryCredit(id)).credit?.byKey.fee || 0;
    return fee > 0 ? { application_fee: fee } : {};
  }
  return {};
}

// Build the one-per-record income rows. Each carries its component breakdown (each
// component with the `when` it's filed under, saleComponentDate) plus
// the rolled-up earned / anticipated (cash) and pick (non-cash) totals, the raw
// status value (for a badge), a display date, and a deep-link href.
// `kennelId` overrides the active scope with ONE named kennel — what the per-
// kennel hub (kennel.html) needs, since it reports on the kennel you opened
// rather than the kennel you are currently scoped to. Leave it unset everywhere
// else and the active scope applies (Multi-Kennel Scope Spec §7/§8).
export async function getIncomeRows({ includeArchived = false, kennelId = null } = {}) {
  const scopeTo = (list) => (kennelId ? list.filter((r) => r.kennel_id === kennelId) : inScopeOnly(list));
  const [sales, studs, dogs, contacts, entries, offers, kennels] = await Promise.all([
    saleRepo.getAll({ includeArchived }),
    studServiceRepo.getAll({ includeArchived }),
    dogRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true }),
    loadWaitlistEntries(includeArchived),
    editionFlags.waitlist ? waitlistOfferRepo.getAll() : [],
    editionFlags.waitlist ? kennelRepo.getAll({ includeArchived: true }) : []
  ]);
  const creditCtx = { entries: entries.filter((e) => !e.is_archived), offers, sales };
  // Credits come from ALL entries (not just in-scope ones): a sale's credit is a
  // fact about that sale, whichever kennel the app is scoped to.
  const creditBySale = feeCreditsBySale(entries, { sales, offers, kennels });
  const dogById = new Map(dogs.map((d) => [d.id, d]));
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  const dogName = (id) => dogById.get(id)?.call_name || '—';
  const contactName = (id) => contactById.get(id)?.name || '—';

  const rows = [];

  // Active-kennel scope (Multi-Kennel Scope Spec §7), applied at the SOURCE
  // records rather than in each consumer — so the Financials Overview tiles, the
  // Income view, the per-litter P&L, and the invoice/receipt generator's record
  // picker can never disagree about which money is yours-right-now. Both tables
  // carry a stamped kennel_id (a sale inherits the dog's, a stud service OUR
  // dog's), and both are pass-throughs when unscoped.
  for (const s of scopeTo(sales)) {
    const feeCredit = creditBySale.get(s.id) || NO_FEE_CREDIT;
    const creditEntry = creditEntryFor(s, creditCtx);
    const received = creditEntry ? familyCredit(creditEntry, s, feeCredit)?.received || null : null;
    // `due` is only a due date she actually set (the balance's), for Receivables'
    // aging; `when` always has a date, for filing by month.
    const cash = saleComponents(s, feeCredit, received).map((c) => ({
      ...c, when: saleComponentDate(s, c), due: c.state === 'anticipated' && c.component !== 'deposit' ? c.due_date || s.balance_due_date || '' : ''
    }));
    if (!cash.length) continue; // no money on this sale — nothing to show
    const components = [...cash, ...feeComponents(s, cash, saleGross(s, feeCredit, received))];
    rows.push({
      source_type: 'sale',
      source_id: s.id,
      href: `sale.html?id=${encodeURIComponent(s.id)}`,
      dog: dogName(s.dog_id),
      dog_id: s.dog_id,
      // The puppy's litter (dog.litter_id) — lets income roll up per litter
      // (litterFinances.js / the litter P&L report). Null for a non-litter dog.
      litter_id: dogById.get(s.dog_id)?.litter_id || null,
      counterparty: contactName(s.buyer_contact_id),
      status: s.status,
      date: s.sale_date || s.deposit_date || s.balance_paid_date || '',
      components,
      earned: sumBy(components, 'earned'),
      anticipated: sumBy(components, 'anticipated'),
      pick: 0,
      fee_credit: feeCredit,
      // The channel's fee on this sale (Integrations plan §5): already netted
      // out of `earned` / `anticipated` by its negative components.
      processing_fee: components.filter((c) => c.component === 'processing_fee').reduce((t, c) => t - c.amount, 0)
    });
  }

  for (const s of scopeTo(studs)) {
    if (ourRole(s, dogById) !== 'stud') continue; // our dam's service = we pay = an expense
    const components = studComponents(s).map((c) => ({ ...c, when: s.returned_date || s.sent_date || '' }));
    if (!components.length) continue;
    rows.push({
      source_type: 'stud',
      source_id: s.id,
      href: `stud-service.html?id=${encodeURIComponent(s.id)}`,
      dog: dogName(s.our_dog_id),
      dog_id: s.our_dog_id,
      litter_id: null, // stud income is not a puppy sale — never litter-scoped
      counterparty: contactName(s.partner_contact_id),
      status: s.status,
      date: s.sent_date || s.returned_date || '',
      components,
      earned: sumBy(components, 'earned'),
      anticipated: sumBy(components, 'anticipated'),
      pick: sumBy(components, 'noncash')
    });
  }

  // Received application fees — always earned (the money is in hand). The entry
  // carries the kennel scope like every waitlist row.
  for (const e of scopeTo(entries)) {
    if (!feeReceived(e)) continue;
    // Paid online (Integrations plan §4): what the family paid (her fee plus a card
    // fee she passed on, `fee_paid_amount`), less what the payment service kept
    // (`fee_processing_amount`), as a negative line like a sale's processing fee.
    const paid = e.fee_paid_amount != null && e.fee_paid_amount !== '' ? num(e.fee_paid_amount) : num(e.fee_amount);
    const components = [{ component: 'application_fee', amount: paid, state: 'earned', when: e.fee_received_date }];
    if (num(e.fee_processing_amount) > 0) {
      components.push({ component: 'processing_fee', amount: -num(e.fee_processing_amount), state: 'earned', when: e.fee_received_date, due: '' });
    }
    // A credited fee on a placed family is part of THAT pup's price, so it rolls up
    // to the pup's litter (the Sale's balance was netted by it above — without
    // this the litter P&L would lose the credit). Any other fee isn't litter money.
    const creditedSale = e.placed_sale_id && e.fee_credit_policy === 'credited_to_purchase'
      ? sales.find((x) => x.id === e.placed_sale_id) : null;
    const pup = creditedSale ? dogById.get(creditedSale.dog_id) : null;
    rows.push({
      source_type: 'waitlist',
      source_id: e.id,
      href: `waitlist-entry.html?id=${encodeURIComponent(e.id)}`,
      dog: pup ? pup.call_name : '—',
      dog_id: pup ? pup.id : null,
      litter_id: pup ? pup.litter_id || null : null,
      counterparty: e.contact_id ? contactName(e.contact_id) : ((e.application && e.application.name) || '—'),
      status: e.status,
      date: e.fee_received_date,
      components,
      earned: Math.round(components.reduce((t, c) => t + c.amount, 0) * 100) / 100,
      anticipated: 0,
      pick: 0
    });
  }

  // Newest first, undated rows last — same posture as the Expenses ledger.
  return rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// Roll a set of income rows into grand totals plus a per-component breakdown
// (earned / anticipated / non-cash pick per component) — feeds both the Income
// summary's breakdown and the Overview tiles. A tiny pure helper, like
// expenseRepo.total, so the page never re-implements the sums.
export function summarize(rows) {
  const totals = { earned: 0, anticipated: 0, pick: 0 };
  const byComponent = new Map(); // component -> { earned, anticipated, pick }
  for (const r of rows) {
    totals.earned += r.earned;
    totals.anticipated += r.anticipated;
    totals.pick += r.pick;
    for (const c of r.components) {
      const acc = byComponent.get(c.component) || { earned: 0, anticipated: 0, pick: 0 };
      if (c.state === 'earned') acc.earned += c.amount;
      else if (c.state === 'anticipated') acc.anticipated += c.amount;
      else if (c.state === 'noncash') acc.pick += c.amount;
      byComponent.set(c.component, acc);
    }
  }
  return { totals, byComponent };
}
