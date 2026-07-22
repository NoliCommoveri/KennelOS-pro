// incomeView.js — the DERIVED income side of the Financials hub. There is no
// income table: this module reads the Sale table and the outgoing StudService
// table (the only two places money-in is recorded) and normalizes each into one
// view-model row, classifying every money component as earned or anticipated.
// Same pattern awayBoard.js uses to union rows from two repos — a read-only
// aggregator over existing repos, storing nothing of its own (see §21).
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
import { INCOME_COMPONENTS, descriptor } from './vocab.js';

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
// anticipated (§21). On any other status, an unpaid component is anticipated.
function saleComponents(s) {
  const dead = ['returned', 'cancelled'].includes(s.status);
  const price = num(s.price);
  const deposit = num(s.deposit_amount);
  const balance = Math.max(price - deposit, 0);
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

function sumBy(components, state) {
  return components.reduce((t, c) => (c.state === state ? t + c.amount : t), 0);
}

// Cash line items for an invoice/receipt on ONE income record (§24). Reuses the
// exact earned/anticipated classification the Income view uses, so a generated
// document can never show a component the ledger wouldn't. Drops the non-cash
// `pick` line (never invoiceable) and tags each item with its display label.
// `sourceType` is 'sale' | 'stud'; the invoice page and the generator modal
// both call this so their line items can't drift.
export function incomeLineItems(sourceType, record) {
  const comps = sourceType === 'sale' ? saleComponents(record) : studComponents(record);
  return comps
    .filter((c) => c.state !== 'noncash')
    .map((c) => ({ ...c, label: descriptor(INCOME_COMPONENTS, c.component).label }));
}

// Build the one-per-record income rows. Each carries its component breakdown plus
// the rolled-up earned / anticipated (cash) and pick (non-cash) totals, the raw
// status value (for a badge), a display date, and a deep-link href.
export async function getIncomeRows({ includeArchived = false } = {}) {
  const [sales, studs, dogs, contacts] = await Promise.all([
    saleRepo.getAll({ includeArchived }),
    studServiceRepo.getAll({ includeArchived }),
    dogRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true })
  ]);
  const dogById = new Map(dogs.map((d) => [d.id, d]));
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  const dogName = (id) => dogById.get(id)?.call_name || '—';
  const contactName = (id) => contactById.get(id)?.name || '—';

  const rows = [];

  for (const s of sales) {
    const components = saleComponents(s);
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
      pick: 0
    });
  }

  for (const s of studs) {
    if (s.direction !== 'outgoing') continue; // incoming = we pay = an expense
    const components = studComponents(s);
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
