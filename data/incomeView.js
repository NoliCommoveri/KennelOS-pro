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
import { inScopeOnly } from './kennelScope.js';
import { editionFlags } from './editionConfig.js';
import { INCOME_COMPONENTS, RELEASED_SALE_STATUSES, isLostSale, descriptor } from './vocab.js';

const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;

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
function depositPaid(s) {
  return !!s.deposit_date || ['deposit_paid', 'paid_in_full', 'delivered'].includes(s.status);
}
function balancePaid(s) {
  return !!s.balance_paid_date || ['paid_in_full', 'delivered'].includes(s.status);
}

// Break a Sale into its earned/anticipated cash components. `price` splits into a
// deposit portion and a balance portion; transport + deferred boarding ride with
// the balance (collected at pickup). On a returned/cancelled sale, only what was
// actually recorded as paid survives (as earned) — the rest is dropped, never
// anticipated (§21). A LOST sale (vocab.isLostSale: voided, or returned for a
// health problem within the guarantee) drops everything, paid or not: what was
// paid is refunded or carried to another pup's sale, never this sale's income.
// On any other status, an unpaid component is anticipated.
// `feeCredit` is a credited waitlist application fee already received for this
// sale (Waitlist Spec §5.3) — it was paid toward the price, so it comes off the
// balance (never below 0).
function saleComponents(s, feeCredit = 0) {
  if (isLostSale(s)) return [];
  const dead = RELEASED_SALE_STATUSES.includes(s.status);
  const price = num(s.price);
  const deposit = num(s.deposit_amount);
  const balance = Math.max(price - deposit - num(feeCredit), 0);
  const parts = [
    { component: 'deposit', amount: deposit, paid: depositPaid(s) },
    { component: 'balance', amount: balance, paid: balancePaid(s) },
    { component: 'transport', amount: num(s.transport_fee), paid: balancePaid(s) },
    { component: 'boarding', amount: num(s.deferred_boarding_amount) * boardingCount(s), paid: balancePaid(s) }
  ];
  const out = [];
  for (const p of parts) {
    if (!p.amount) continue;
    if (dead) {
      if (p.paid) out.push({ component: p.component, amount: p.amount, state: 'earned' });
      // unpaid remainder of a dead sale → dropped from both totals
    } else {
      out.push({ component: p.component, amount: p.amount, state: p.paid ? 'earned' : 'anticipated' });
    }
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

// When each component's money moved (or is due): the date a monthly P&L files it
// under (reports, cash basis). A deposit on its deposit date, the balance and what
// rides with it on the balance-paid date; unpaid money on its due date. Each falls
// back to the sale's own date, so nothing goes undated when a date wasn't kept.
function saleComponentDate(s, c) {
  const fallback = s.sale_date || s.deposit_date || s.balance_paid_date || '';
  if (c.component === 'deposit') return s.deposit_date || fallback;
  if (c.state === 'earned') return s.balance_paid_date || fallback;
  return s.balance_due_date || fallback;
}

function sumBy(components, state) {
  return components.reduce((t, c) => (c.state === state ? t + c.amount : t), 0);
}

// Cash line items for an invoice/receipt on ONE income record (§24). Reuses the
// exact earned/anticipated classification the Income view uses, so a generated
// document can never show a component the ledger wouldn't. Drops the non-cash
// `pick` line (never invoiceable) and tags each item with its display label.
// `sourceType` is 'sale' | 'stud'; the invoice page and the generator modal
// both call this so their line items can't drift.
// `feeCredit` (sales only): a credited application fee already received — pass
// getSaleFeeCredit(sale.id) so a document's balance matches the ledger's.
export function incomeLineItems(sourceType, record, { feeCredit = 0 } = {}) {
  const comps = sourceType === 'sale' ? saleComponents(record, feeCredit) : studComponents(record);
  return comps
    .filter((c) => c.state !== 'noncash')
    .map((c) => ({ ...c, label: descriptor(INCOME_COMPONENTS, c.component).label }));
}

// What the buyer has paid on a sale (deposit, balance, transport, boarding), read
// the same way the ledger reads it — paid-dates, or a status past that point — but
// ignoring a released status, so a voided sale still says what was paid on it
// before it fell through (the waitlist's carry-over offer, Waitlist Spec §16.11).
// `asStatus` reads it as of the status it had before (the Sale page knows it);
// without it, only the recorded paid-dates count. A credited application fee isn't
// money paid on the sale, so pass `feeCredit` to keep it out of the balance.
export function paidOnSale(sale, { feeCredit = 0, asStatus = null } = {}) {
  if (!sale) return 0;
  const status = asStatus || (RELEASED_SALE_STATUSES.includes(sale.status) ? 'deposit_pending' : sale.status);
  return saleComponents({ ...sale, status, end_reason: null }, feeCredit)
    .filter((c) => c.state === 'earned')
    .reduce((sum, c) => sum + c.amount, 0);
}

// --- Waitlist application fees (Waitlist Spec §5.3) ------------------------------

// A fee counts once it's received and above 0 (a waived fee is no money). Refunds
// aren't tracked in W1: a refundable fee stays earned until she edits the entry.
const feeReceived = (e) => !e.is_archived && !!e.fee_received_date && num(e.fee_amount) > 0;

// saleId → credited fee amount, from placed entries whose fee is credited to the
// purchase price.
function feeCreditsBySale(entries) {
  const out = new Map();
  for (const e of entries) {
    if (!feeReceived(e) || !e.placed_sale_id || e.fee_credit_policy !== 'credited_to_purchase') continue;
    out.set(e.placed_sale_id, (out.get(e.placed_sale_id) || 0) + num(e.fee_amount));
  }
  return out;
}

async function loadWaitlistEntries(includeArchived) {
  return editionFlags.waitlist ? waitlistEntryRepo.getAll({ includeArchived }) : [];
}

// The credited application fee for one sale (0 when none) — the invoice page
// passes it to incomeLineItems so the document's balance matches the ledger.
export async function getSaleFeeCredit(saleId) {
  return feeCreditsBySale(await loadWaitlistEntries(false)).get(saleId) || 0;
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
  const [sales, studs, dogs, contacts, entries] = await Promise.all([
    saleRepo.getAll({ includeArchived }),
    studServiceRepo.getAll({ includeArchived }),
    dogRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true }),
    loadWaitlistEntries(includeArchived)
  ]);
  // Credits come from ALL entries (not just in-scope ones): a sale's credit is a
  // fact about that sale, whichever kennel the app is scoped to.
  const creditBySale = feeCreditsBySale(entries);
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
    const feeCredit = creditBySale.get(s.id) || 0;
    // `due` is only a due date she actually set (the balance's), for Receivables'
    // aging; `when` always has a date, for filing by month.
    const components = saleComponents(s, feeCredit).map((c) => ({
      ...c, when: saleComponentDate(s, c), due: c.state === 'anticipated' && c.component !== 'deposit' ? s.balance_due_date || '' : ''
    }));
    if (!components.length) continue; // no money on this sale — nothing to show
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
      fee_credit: feeCredit
    });
  }

  for (const s of scopeTo(studs)) {
    if (s.direction !== 'outgoing') continue; // incoming = we pay = an expense
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
    const components = [{ component: 'application_fee', amount: num(e.fee_amount), state: 'earned', when: e.fee_received_date }];
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
      earned: num(e.fee_amount),
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
