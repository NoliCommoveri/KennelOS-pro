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
import { litterRepo } from './litterRepo.js';
import { eventRepo } from './eventRepo.js';
import { paymentStatement, chargePieces } from './paymentSchedule.js';
import { expectedPickupDate } from './goHome.js';
import { businessDays, waitlistConfig } from './waitlistRules.js';
import { todayYMD } from './dateUtils.js';
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

// --- The ledger: a sale's income from its payment statement (Payment Schedule plan §4) ---

// A sale's income components, read from its payment statement (paymentStatement, with
// the credited application fee and the family's credits) through its pieces
// (chargePieces: each charge split by the due date it falls in). Pure.
//   Money received is earned on its own date: the deposit on its deposit date, each
//   payment on its date, an own-dated step on its paid date, "paid in full" on the
//   balance paid date (each else the sale's own date).
//   The application fee credited toward the price isn't the sale's income: it's
//   earned on the family's waitlist row, so the part of the sale it paid is left out.
//   A credit for funds received is the family's money, held, never income itself
//   (D21): the part of a charge it covers is anticipated until that charge's due date
//   (the deposit's: when it was asked for, else marked received), then earned on it.
//   One whose due date can't be known yet is earned once the deposit is received (the
//   deposit) or the sale is paid in full (the rest), on that date. Marked `credited`,
//   so Receivables leaves it out: nothing is owed on it.
//   What's still owed of each charge is anticipated on the due date that needs it.
//   A returned or cancelled sale keeps only what was paid, as earned; a lost sale
//   (vocab.isLostSale) counts nothing. Extras she kept when the family backed out
//   (kept_after_cancel) are still owed on a released sale: what was paid on them
//   (payments, steps marked paid) earned, the rest anticipated.
// → [{ component, key, label, amount, state, due_id, when, due, paid_date?, due_date?,
//      credited? }]: `when` is the date a monthly P&L files it under; `due` the due date
//   of money still owed (Receivables ages it; '' = no due date known yet); `due_id` the
//   due date it belongs to ('deposit', a schedule due date's id, an own-dated charge's key).
export function ledgerComponents(s, st, { today = todayYMD() } = {}) {
  const fallback = s.sale_date || s.deposit_date || s.balance_paid_date || '';
  const keptIds = new Set(saleExtraCharges(s).filter((x) => x.kept_after_cancel).map((x) => x.id));
  const isKept = (key) => key.startsWith('extra:') && keptIds.has(key.split(':')[1]);
  const lost = isLostSale(s);
  const released = RELEASED_SALE_STATUSES.includes(s.status);
  const out = [];
  const push = (pc, amount, state, date, extra = {}) => {
    if (!(amount > 0)) return;
    out.push({
      component: pc.component, key: pc.key, label: pc.label, amount: round2(amount), state, due_id: pc.dueId,
      when: date || fallback, due: state === 'anticipated' ? (date || '') : '',
      ...(state === 'earned' && date ? { paid_date: date } : {}), ...(state === 'anticipated' && date ? { due_date: date } : {}), ...extra
    });
  };
  const moneyDate = (m) => m.date || (m.kind === 'deposit' ? s.deposit_date : m.kind === 'paid_in_full' ? s.balance_paid_date : null) || '';

  const pieces = chargePieces(st);
  if (released) {
    // Kept after the family backed out: what was paid on it on its own (payments,
    // steps marked paid) earned; the rest still owed, on the step's own date (else the
    // balance due date). "Paid in full" doesn't cover it: the sale ended.
    for (const c of st.charges.filter((x) => isKept(x.key))) {
      const pc = { component: c.component, key: c.key, label: c.label, dueId: '' };
      const paidOwn = pieces.filter((p) => p.key === c.key).flatMap((p) => p.paid).filter((m) => m.kind === 'payment' || m.kind === 'step');
      for (const m of paidOwn) push(pc, m.amount, 'earned', moneyDate(m));
      const [, xId, stepId] = c.key.split(':');
      const step = stepId ? saleExtraCharges(s).find((x) => x.id === xId)?.payments?.find((p) => p.id === stepId) : null;
      push(pc, c.amount - paidOwn.reduce((t, m) => t + m.amount, 0), 'anticipated', step?.due_date || s.balance_due_date || null);
    }
  }
  for (const pc of pieces) {
    if (released && isKept(pc.key)) continue; // above
    if (lost) continue; // refunded or carried to another pup: never this sale's income
    for (const m of pc.paid) {
      if (m.kind === 'fee') continue; // the waitlist row's income
      if (m.kind !== 'credit') { push(pc, m.amount, 'earned', moneyDate(m)); continue; }
      if (released) continue; // a credit on a released sale is theirs again
      const date = pc.dueDate;
      const settled = pc.dueId === 'deposit' ? depositPaid(s) : balancePaid(s);
      if (date && date <= today) push(pc, m.amount, 'earned', date, { credited: true });
      else if (!date && settled) push(pc, m.amount, 'earned', (pc.dueId === 'deposit' ? s.deposit_date : s.balance_paid_date) || '', { credited: true });
      else push(pc, m.amount, 'anticipated', date, { credited: true });
    }
    if (!released) push(pc, pc.owed, 'anticipated', pc.dueDate);
  }
  return out;
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
// Read from the payment statement, so payments recorded on the sale (Record a
// payment) count too. `received`'s credits count toward what money hasn't paid of
// each line.
export function paidOnSale(sale, { feeCredit = 0, asStatus = null, received = null } = {}) {
  if (!sale) return 0;
  const status = asStatus || (RELEASED_SALE_STATUSES.includes(sale.status) ? 'deposit_pending' : sale.status);
  const fc = feeCreditOf(feeCredit);
  const st = paymentStatement({ ...sale, status, end_reason: null }, { feeCredit: fc.amount > 0 ? fc : null });
  const left = new Map(st.charges.map((c) => [c.key, c.amount]));
  let paid = 0;
  for (const r of st.received) {
    for (const p of r.pays) {
      if (!left.has(p.key)) continue;
      left.set(p.key, round2(left.get(p.key) - p.amount));
      if (r.kind !== 'fee') paid += p.amount; // the credited fee isn't money paid on the sale
    }
  }
  for (const [key, v] of Object.entries(received?.byKey || {})) paid += Math.min(num(v), left.get(key) || 0);
  return round2(paid);
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
// In the order money pays them (Payment Schedule plan D16): deposit, price, boarding,
// extras, transport last.
const CREDIT_ORDER = { deposit: 0, balance: 1, boarding: 2, extra: 3, transport: 4 };
export function saleCreditCharges(sale, feeCredit = 0) {
  if (!sale || sale.is_archived || RELEASED_SALE_STATUSES.includes(sale.status)) return [];
  return saleComponents({ ...sale, status: 'deposit_pending', end_reason: null }, feeCredit)
    .filter((c) => CREDIT_USE_OF[c.component])
    .map((c, i) => ({ key: c.key || c.component, use: CREDIT_USE_OF[c.component], amount: c.amount, rank: CREDIT_ORDER[c.component] * 1000 + i }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ rank: _rank, ...c }) => c);
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

// When the application fee credited toward this sale was received (the earliest, if
// more than one family record credits it), for the statement's money list. null = none.
function feeCreditDate(sale, ctx) {
  const dates = ctx.entries
    .filter((e) => feeReceived(e) && e.fee_credit_policy === 'credited_to_purchase'
      && (e.placed_sale_id || creditSale(e, ctx.sales, ctx.offers, ctx.entries)?.id) === sale.id)
    .map((e) => e.fee_received_date).sort();
  return dates[0] || null;
}

// A sale's payment statement (Payment Schedule plan §4, paymentSchedule.paymentStatement)
// with everything it reads gathered here: the pup's birth date (else its litter's whelp
// date), its pickup date as a contract reads it (goHome.expectedPickupDate), her open
// days, the application fee credited toward it, the family's credits for funds received,
// and when the deposit is due (a side sale's due date, else the open offer's respond-by).
// → { statement, sale, kennel, birthDate, pickupDate, opts } | null; `opts` are what
// paymentStatement was given, so a page can preview a changed sale the same way.
export async function getSaleStatement(saleOrId, { today = todayYMD() } = {}) {
  const sale = typeof saleOrId === 'string' ? await saleRepo.getById(saleOrId) : saleOrId;
  if (!sale) return null;
  const dog = sale.dog_id ? await dogRepo.getById(sale.dog_id) : null;
  const [litter, events, kennel, ctx] = await Promise.all([
    dog?.litter_id ? litterRepo.getById(dog.litter_id) : null,
    dog ? eventRepo.getForSubject('dog', dog.id) : [],
    sale.kennel_id ? kennelRepo.getById(sale.kennel_id) : null,
    loadCreditContext()
  ]);
  const opts = statementOpts(sale, { dog, litter, events, kennel, ctx, feeBySale: ctx ? feeCreditsBySale(ctx.entries, ctx) : null, today });
  return { statement: paymentStatement(sale, opts), sale, kennel, birthDate: opts.birthDate, pickupDate: opts.pickupDate, opts };
}

// Several sales' statements at once, each read exactly as getSaleStatement reads it
// (the same statementOpts over the same records), loading everything once: the
// family pages' feed (cloudWaitlist.projectionFor) publishes many at a time.
// → Map(saleId → statement)
export async function getSaleStatements(sales, { today = todayYMD() } = {}) {
  const list = (sales || []).filter(Boolean);
  const out = new Map();
  if (!list.length) return out;
  const [dogs, litters, kennels, pickups, ctx] = await Promise.all([
    dogRepo.getAll({ includeArchived: true }),
    litterRepo.getAll({ includeArchived: true }),
    kennelRepo.getAll({ includeArchived: true }),
    eventRepo.getByType('placement', { includeArchived: true }),
    loadCreditContext()
  ]);
  const dogById = new Map(dogs.map((d) => [d.id, d]));
  const litterById = new Map(litters.map((l) => [l.id, l]));
  const kennelById = new Map(kennels.map((k) => [k.id, k]));
  const feeBySale = ctx ? feeCreditsBySale(ctx.entries, ctx) : null;
  for (const sale of list) {
    const dog = sale.dog_id ? dogById.get(sale.dog_id) || null : null;
    const opts = statementOpts(sale, {
      dog, litter: dog?.litter_id ? litterById.get(dog.litter_id) || null : null,
      events: dog ? pickups.filter((e) => e.subject_type === 'dog' && e.subject_id === dog.id) : [],
      kennel: sale.kennel_id ? kennelById.get(sale.kennel_id) || null : null, ctx, feeBySale, today
    });
    out.set(sale.id, paymentStatement(sale, opts));
  }
  return out;
}

// What paymentStatement reads for one sale, from records already loaded: `events` the
// pup's (only its pickups are read), `ctx` loadCreditContext's (or null without the
// waitlist), `feeBySale` feeCreditsBySale over it. getSaleStatement and the Financials
// ledger both use it, so every surface reads a sale the same way.
function statementOpts(sale, { dog = null, litter = null, events = [], kennel = null, ctx = null, feeBySale = null, today }) {
  const fee = feeBySale ? feeBySale.get(sale.id) : null;
  const entry = creditEntryFor(sale, ctx);
  const offer = ctx ? ctx.offers.find((o) => o.sale_id === sale.id && o.outcome === 'open' && !o.is_archived) : null;
  return {
    birthDate: dog?.date_of_birth || litter?.whelp_date || null,
    pickupDate: expectedPickupDate({ sale, events, litter, today }) || null,
    today, openDays: businessDays(waitlistConfig(kennel)),
    feeCredit: fee && fee.amount > 0 ? { ...fee, date: feeCreditDate(sale, ctx) } : null,
    credits: entry ? creditsOf(entry) : [], feeCharges: entry ? feeCharge(entry) : [],
    depositDueDate: sale.side_deposit_due || offer?.respond_by_date || null
  };
}

// A contract's payment table for one sale: the purchase price only (no transport,
// boarding or extras, which are agreed apart). Pure.
//   depositDue  the deposit less the application fee credited toward it
//               (feeCreditSplit) and the family's received funds counted toward it
//               (familyCredit's allocation). The same before and after the deposit
//               is marked paid.
//   otherPaid   credits and payments toward the balance: the credited fee when it
//               isn't taken off the deposit, the family's received funds (a lost pup's
//               carry-over) not on the deposit, and the balance once it's marked paid.
//               Nothing is counted twice: funds on the deposit are in depositDue, and
//               funds that paid the fee count only as the fee (familyCredit leaves
//               the fee out of `received`).
//   balanceDue  what's still owed of the price at pickup.
// So price = the deposit + otherPaid + balanceDue.
// → { depositDue, otherPaid, balanceDue }
export function priceTable(sale, { feeCredit = NO_FEE_CREDIT, received = null } = {}) {
  const parts = saleComponents({ ...sale, end_reason: null }, feeCredit, received).filter((c) => c.component === 'balance');
  const sum = (state) => round2(parts.filter((c) => c.state === state).reduce((t, c) => t + c.amount, 0));
  const split = feeCreditSplit(sale, feeCredit);
  const deposit = Math.max(round2(num(sale.deposit_amount) - split.deposit), 0);
  const depositDue = round2(deposit - Math.min(num(received?.byKey?.deposit), deposit));
  return { depositDue, otherPaid: round2(sum('earned') + split.balance), balanceDue: sum('anticipated') };
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
// component with the `when` it's filed under, ledgerComponents) plus
// the rolled-up earned / anticipated (cash) and pick (non-cash) totals, the raw
// status value (for a badge), a display date, and a deep-link href.
// `kennelId` overrides the active scope with ONE named kennel — what the per-
// kennel hub (kennel.html) needs, since it reports on the kennel you opened
// rather than the kennel you are currently scoped to. Leave it unset everywhere
// else and the active scope applies (Multi-Kennel Scope Spec §7/§8).
export async function getIncomeRows({ includeArchived = false, kennelId = null, today = todayYMD() } = {}) {
  const scopeTo = (list) => (kennelId ? list.filter((r) => r.kennel_id === kennelId) : inScopeOnly(list));
  const [sales, studs, dogs, contacts, entries, offers, kennels, litters, placements] = await Promise.all([
    saleRepo.getAll({ includeArchived }),
    studServiceRepo.getAll({ includeArchived }),
    dogRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true }),
    loadWaitlistEntries(includeArchived),
    editionFlags.waitlist ? waitlistOfferRepo.getAll() : [],
    kennelRepo.getAll({ includeArchived: true }),
    litterRepo.getAll({ includeArchived: true }),
    eventRepo.getByType('placement')
  ]);
  const creditCtx = { entries: entries.filter((e) => !e.is_archived), offers, sales, kennels };
  // Credits come from ALL entries (not just in-scope ones): a sale's credit is a
  // fact about that sale, whichever kennel the app is scoped to.
  const creditBySale = feeCreditsBySale(entries, { sales, offers, kennels });
  const litterById = new Map(litters.map((l) => [l.id, l]));
  const kennelById = new Map(kennels.map((k) => [k.id, k]));
  const pickupsByDog = new Map();
  for (const e of placements) if (e.subject_type === 'dog') pickupsByDog.set(e.subject_id, [...(pickupsByDog.get(e.subject_id) || []), e]);
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
    // The sale's payment statement, read as getSaleStatement reads it, then its
    // income (ledgerComponents): `when` always has a date, for filing by month; `due`
    // is a due date of money still owed, for Receivables' aging.
    const dog = dogById.get(s.dog_id) || null;
    const opts = statementOpts(s, {
      dog, litter: dog?.litter_id ? litterById.get(dog.litter_id) || null : null, events: dog ? pickupsByDog.get(dog.id) || [] : [],
      kennel: kennelById.get(s.kennel_id) || null, ctx: creditCtx, feeBySale: creditBySale, today
    });
    const cash = ledgerComponents(s, paymentStatement(s, opts), { today });
    if (!cash.length) continue; // no money on this sale — nothing to show
    // The processing fee is shared over the sale's full value while open, so a released
    // sale keeps only the paid share's fee.
    const released = RELEASED_SALE_STATUSES.includes(s.status);
    const reopened = released ? { ...s, status: 'deposit_pending', end_reason: null } : null;
    const gross = released ? ledgerComponents(reopened, paymentStatement(reopened, opts), { today }).reduce((t, c) => t + c.amount, 0) : cash.reduce((t, c) => t + c.amount, 0);
    const components = [...cash, ...feeComponents(s, cash, gross)];
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
