// reportSources.js — what each report reads: its records loaded and scoped, its
// rows, and the date its range is read by. One loader per report, called by the
// report's page AND by Kels's kennel check-up (data/kennelInsights.js), so she can
// never say a number the report wouldn't show for the same range.
//
// Each loader resolves { href, rows, scope?, date?, rowsIn?, ... }: `rows` as the
// page's table gets them; `scope(row)` and `date(row)` exactly as the page passes
// them to reportView (reportMath.inView applies both); `rowsIn(range)` where the
// report rebuilds its rows for a range instead (Dam & Sire Production). Extra keys
// are the lookups the report's own figures need (data/reportFigures.js). Pro-only
// (proPages.js), like the reports.
import { dogRepo } from './dogRepo.js';
import { litterRepo } from './litterRepo.js';
import { pairingRepo } from './pairingRepo.js';
import { eventRepo, testTokensOf } from './eventRepo.js';
import { saleRepo } from './saleRepo.js';
import { contactRepo } from './contactRepo.js';
import { kennelRepo } from './kennelRepo.js';
import { studServiceRepo } from './studServiceRepo.js';
import { waitlistEntryRepo } from './waitlistEntryRepo.js';
import { waitlistOfferRepo } from './waitlistOfferRepo.js';
import { waitlistProgramRepo } from './waitlistProgramRepo.js';
import { getLitterFinances } from './litterFinances.js';
import { expectedPricing } from './saleDefaults.js';
import { loadMoney, incomeEntries, plByPeriod, receivableRows, pricingRows, dogReturnRows } from './moneyReport.js';
import { productionRowsIn, pairingRows, heatRows, testGapRows, studResultRows } from './breedingReports.js';
import { overallPositions, isPaused, waitlistConfig, kennelBreeds } from './waitlistRules.js';
import { offerAndExitRows, demandSupply, listedSince } from './waitlistReports.js';
import { inScope, inScopeOnly, dogInScope, subjectInScope, ownKennels, isScoped, getActiveKennelId } from './kennelScope.js';
import { ourRole } from './studRules.js';
import { daysBetween } from './breedingReports.js';
import { periodsBetween } from './reportMath.js';
import { RELEASED_SALE_STATUSES } from './vocab.js';

export const isPlacedSale = (s) => !RELEASED_SALE_STATUSES.includes(s.status);
const byNewest = (date) => (a, b) => (date(b) || '').localeCompare(date(a) || '');

// --- Breeding ----------------------------------------------------------------------

// Dam & Sire Production: the dogs' rows over the litters whelped in the range, and
// the breeding females with none (breedingReports.productionRowsIn).
export async function loadProduction(today) {
  const [dogs, litters, pairings, kennels] = await Promise.all([
    dogRepo.getAll({ includeArchived: true }),
    litterRepo.getAll({ includeArchived: false }),
    pairingRepo.getAll({ includeArchived: false }),
    kennelRepo.getAll({ includeArchived: true })
  ]);
  const data = {
    dogs, litters: inScopeOnly(litters), puppies: dogs.filter((d) => d.litter_id),
    breeders: dogs.filter((d) => !d.is_archived && dogInScope(d)),
    pairings: inScopeOnly(pairings), kennelsById: new Map(kennels.map((k) => [k.id, k]))
  };
  const rowsIn = (range) => productionRowsIn(data, range, today);
  return { href: 'production-report.html', rows: rowsIn({ from: null, to: null }), rowsIn, dogs };
}

// Pairing Success: one row per bred pairing, scoped by the pairing's kennel.
export async function loadPairingSuccess() {
  const [pairings, litters, dogs, events] = await Promise.all([
    pairingRepo.getAll({ includeArchived: false }),
    litterRepo.getAll({ includeArchived: true }),
    dogRepo.getAll({ includeArchived: true }),
    eventRepo.getAll({ includeArchived: false })
  ]);
  const rows = pairingRows({ pairings, litters, events: events.filter((e) => e.event_type === 'progesterone_test') });
  return { href: 'pairing-success-report.html', rows, scope: (r) => inScope(r.pairing), date: (r) => r.pairing.planned_date, dogs };
}

// Heat Cycles: the in-scope females with heats on record, as of today.
export async function loadHeatCycles(today) {
  const [dogs, events] = await Promise.all([dogRepo.getAll({ includeArchived: false }), eventRepo.getByType('heat_cycle')]);
  return { href: 'heat-cycles-report.html', rows: heatRows(dogs.filter((d) => d.sex === 'female' && dogInScope(d)), events, today), dogs };
}

// Health-Testing Gaps: each in-scope adult's planned tests against its logged ones.
export const HEALTH_TEST_TYPES = ['genetic_test', 'ofa_pennhip', 'breed_specific_test'];
export async function loadHealthGaps() {
  const [dogs, ...byType] = await Promise.all([dogRepo.getAll({ includeArchived: false }), ...HEALTH_TEST_TYPES.map((t) => eventRepo.getByType(t))]);
  const rows = testGapRows(dogs.filter((d) => dogInScope(d) && d.status !== 'puppy' && d.status !== 'deceased'), byType.flat(), testTokensOf);
  return { href: 'health-gaps-report.html', rows, dogs };
}

// Litters Over Time: every live litter, newest first.
export async function loadLitters() {
  const [litters, dogs] = await Promise.all([litterRepo.getAll({ includeArchived: false }), dogRepo.getAll({ includeArchived: true })]);
  litters.sort(byNewest((l) => l.whelp_date));
  return { href: 'litters-report.html', rows: litters, scope: inScope, date: (l) => l.whelp_date, dogs };
}

// Live-Birth Summary: the litters with a recorded birth total.
export async function loadLiveBirths() {
  const [all, dogs] = await Promise.all([litterRepo.getAll({ includeArchived: false }), dogRepo.getAll({ includeArchived: true })]);
  const rows = all.filter((l) => Number.isFinite(Number(l.puppies_born_total))).sort(byNewest((l) => l.whelp_date));
  return { href: 'live-births.html', rows, scope: inScope, date: (l) => l.whelp_date, dogs };
}

// Puppy Growth: the in-scope whelped litters (newest first), each pup's weights.
export async function loadPuppyGrowth() {
  const [litters, dogs, events] = await Promise.all([
    litterRepo.getAll({ includeArchived: false }),
    dogRepo.getAll({ includeArchived: true }),
    eventRepo.getByType('weight_check')
  ]);
  const weights = events.filter((e) => e.event_type === 'weight_check' && !e.is_archived);
  const pupsOf = (l) => dogs.filter((d) => d.litter_id === l.id).sort((a, b) => (a.call_name || '').localeCompare(b.call_name || '', undefined, { numeric: true }));
  const choices = inScopeOnly(litters).filter((l) => l.whelp_date && l.status !== 'expected').sort((a, b) => b.whelp_date.localeCompare(a.whelp_date));
  return { href: 'puppy-growth-report.html', rows: choices, date: (l) => l.whelp_date, weights, pupsOf, dogs };
}

// --- Money -------------------------------------------------------------------------

// Profit & Loss by Month: every month from the first money in or out to today (or
// the last dated entry), newest first. A month is in a range when its 1st is.
export async function loadProfitLoss(today) {
  const { incomeRows, expenses } = await loadMoney();
  const entries = incomeEntries(incomeRows);
  const dates = [...entries.map((e) => e.date), ...expenses.map((x) => x.expense_date)].filter(Boolean).sort();
  const first = dates[0] || today;
  const last = dates[dates.length - 1] > today ? dates[dates.length - 1] : today;
  const rows = plByPeriod(entries, expenses, periodsBetween(first, last, 'month'), 'month').reverse();
  return { href: 'pl-report.html', rows, date: (m) => `${m.period}-01`, entries, expenses };
}

// Expenses by Category: the in-scope expenses, newest first.
export async function loadExpenses() {
  const { expenses } = await loadMoney();
  expenses.sort(byNewest((x) => x.expense_date));
  return { href: 'expenses-report.html', rows: expenses, date: (x) => x.expense_date };
}

// Litter P&L: one row per litter, newest first.
export async function loadLitterFinances() {
  const [finances, dogs] = await Promise.all([getLitterFinances(), dogRepo.getAll({ includeArchived: true })]);
  finances.sort(byNewest((f) => f.litter.whelp_date));
  return { href: 'litter-finances-report.html', rows: finances, scope: (f) => inScope(f.litter), date: (f) => f.litter.whelp_date, dogs };
}

// Receivables: money still owed, as of today, plus foster costs to be paid back.
export async function loadReceivables(today) {
  const [{ incomeRows }, finances, dogs, contacts] = await Promise.all([
    loadMoney(), getLitterFinances(), dogRepo.getAll({ includeArchived: true }), contactRepo.getAll({ includeArchived: true })
  ]);
  const name = new Map(dogs.map((d) => [d.id, d.call_name || '—']));
  const contactName = new Map(contacts.map((c) => [c.id, c.name || '—']));
  const fosterOwed = finances.filter((f) => inScope(f.litter) && f.reimbursablePending > 0).map((f) => ({
    litter: f.litter, amount: f.reimbursablePending,
    label: contactName.get(f.litter.foster_partner_contact_id) || 'Foster partner',
    litterLabel: f.litter.nickname || `${name.get(f.litter.dam_id) || '—'} × ${name.get(f.litter.sire_id) || '—'}`
  }));
  return { href: 'receivables-report.html', rows: receivableRows(incomeEntries(incomeRows), today, fosterOwed) };
}

// Pricing: each placed sale with a price, against the litter's expected price.
export async function loadPricing() {
  const [sales, dogs, litters] = await Promise.all([
    saleRepo.getAll({ includeArchived: false }), dogRepo.getAll({ includeArchived: true }), litterRepo.getAll({ includeArchived: true })
  ]);
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const littersById = new Map(litters.map((l) => [l.id, l]));
  const rows = pricingRows(sales, {
    dogsById, isPlaced: isPlacedSale,
    expectedFor: (s) => {
      const dog = dogsById.get(s.dog_id);
      const litter = dog && dog.litter_id ? littersById.get(dog.litter_id) : null;
      return expectedPricing(dog, litter, s.registration_type).price;
    }
  });
  return { href: 'pricing-report.html', rows, scope: (r) => inScope(r.sale), date: (r) => r.sale.sale_date, dogs };
}

// Breeding-Dog Return: per dam and sire, lifetime (no range).
export async function loadDogReturn() {
  const [{ incomeRows, expenses }, dogs, litters, sales] = await Promise.all([
    loadMoney(), dogRepo.getAll({ includeArchived: true }), litterRepo.getAll({ includeArchived: false }), saleRepo.getAll({ includeArchived: false })
  ]);
  const rows = dogReturnRows({ dogs, litters: inScopeOnly(litters), incomeRows, expenses, sales, isPlaced: isPlacedSale });
  return { href: 'dog-return-report.html', rows, dogs };
}

// --- Sales and the waitlist ---------------------------------------------------------

// Placements: every live sale, newest first.
export async function loadPlacements() {
  const [sales, dogs, contacts] = await Promise.all([
    saleRepo.getAll({ includeArchived: false }), dogRepo.getAll({ includeArchived: true }), contactRepo.getAll({ includeArchived: true })
  ]);
  sales.sort(byNewest((s) => s.sale_date));
  return { href: 'placements-report.html', rows: sales, scope: inScope, date: (s) => s.sale_date, dogs, contacts };
}

// Lead Sources & Referrers: the placed sales, by the date sold. `label(key)`: a
// source as she spells it most often.
export const leadSourceKey = (s) => String(s.lead_source || '').trim().toLowerCase();
export async function loadLeadSources() {
  const [sales, contacts] = await Promise.all([saleRepo.getAll({ includeArchived: false }), contactRepo.getAll({ includeArchived: true })]);
  const placed = sales.filter(isPlacedSale);
  const display = new Map();
  for (const s of placed) {
    const k = leadSourceKey(s);
    if (!k) continue;
    const m = display.get(k) || new Map();
    m.set(s.lead_source.trim(), (m.get(s.lead_source.trim()) || 0) + 1);
    display.set(k, m);
  }
  const label = (k) => (k ? [...display.get(k).entries()].sort((a, b) => b[1] - a[1])[0][0] : 'Not recorded');
  return { href: 'lead-sources-report.html', rows: placed, scope: inScope, date: (s) => s.sale_date, label, contacts };
}

// Returns & Voids: the sales that ended, newest first, and every in-scope sale
// (the share that ended).
export async function loadReturns() {
  const [sales, dogs, contacts] = await Promise.all([
    saleRepo.getAll({ includeArchived: false }), dogRepo.getAll({ includeArchived: true }), contactRepo.getAll({ includeArchived: true })
  ]);
  const ended = sales.filter((s) => RELEASED_SALE_STATUSES.includes(s.status)).sort(byNewest((s) => s.sale_date));
  return { href: 'returns-report.html', rows: ended, scope: inScope, date: (s) => s.sale_date, allInScope: sales.filter(inScope), dogs, contacts };
}

// Applications: every application, newest first, by the date applied.
export async function loadApplications() {
  const [entries, programs, contacts, dogs, kennels] = await Promise.all([
    waitlistEntryRepo.getAll({ includeArchived: false }),
    waitlistProgramRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true }),
    dogRepo.getAll({ includeArchived: true }),
    kennelRepo.getAll({ includeArchived: true })
  ]);
  entries.sort(byNewest((e) => e.applied_date));
  return { href: 'applications-report.html', rows: entries, scope: inScope, date: (e) => e.applied_date, programs, contacts, dogs, kennels };
}

// Waitlist Today: the families on a list now, by kennel then place, as of today.
// `paused(e)` and `waited(e)` (days on the list) as the report shows them;
// `pipeline`: the in-scope entries, for those still to review or with a fee due.
export async function loadWaitlistToday(today) {
  const [entries, offers, programs, contacts, kennels] = await Promise.all([
    waitlistEntryRepo.getAll({ includeArchived: false }),
    waitlistOfferRepo.getAll({ includeArchived: false }),
    waitlistProgramRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true }),
    kennelRepo.getAll({ includeArchived: true })
  ]);
  const programsById = new Map(programs.map((p) => [p.id, p]));
  const kennelsById = new Map(kennels.map((k) => [k.id, k]));
  const kennelName = (e) => kennelsById.get(e.kennel_id)?.name || '';
  const paused = (e) => isPaused(e, today, waitlistConfig(kennelsById.get(e.kennel_id)));
  const waited = (e) => { const s = listedSince(e); return s ? Math.max(0, daysBetween(s, today)) : null; };
  const place = new Map();
  for (const kennelId of new Set(entries.map((e) => e.kennel_id))) {
    for (const [id, n] of overallPositions(entries, kennelId, programsById)) place.set(id, n);
  }
  const rows = entries.filter((e) => e.status === 'active' && place.has(e.id))
    .sort((a, b) => kennelName(a).localeCompare(kennelName(b)) || place.get(a.id) - place.get(b.id));
  return {
    href: 'waitlist-today-report.html', rows, scope: inScope, paused, waited, place, kennelName, offers, programs, programsById, contacts,
    pipeline: entries.filter(inScope)
  };
}

// Offers & Removals: each closed offer and each family that left, by the date.
export async function loadOffersRemovals() {
  const [entries, offers, contacts, litters, dogs] = await Promise.all([
    waitlistEntryRepo.getAll({ includeArchived: false }),
    waitlistOfferRepo.getAll({ includeArchived: false }),
    contactRepo.getAll({ includeArchived: true }),
    litterRepo.getAll({ includeArchived: true }),
    dogRepo.getAll({ includeArchived: true })
  ]);
  return { href: 'offers-removals-report.html', rows: offerAndExitRows(entries, offers), scope: (r) => inScope(r.entry), date: (r) => r.date, contacts, litters, dogs };
}

// Demand vs Supply: families on the list against pups available, now.
export async function loadDemandSupply() {
  const [entries, dogs, sales, litters, kennels, own] = await Promise.all([
    waitlistEntryRepo.getAll({ includeArchived: false }),
    dogRepo.getAll({ includeArchived: false }),
    saleRepo.getAll({ includeArchived: false }),
    litterRepo.getAll({ includeArchived: false }),
    kennelRepo.getAll({ includeArchived: true }),
    ownKennels()
  ]);
  const kennelsById = new Map(kennels.map((k) => [k.id, k]));
  const families = inScopeOnly(entries).filter((e) => e.status === 'active');
  const pups = dogs.filter((d) => d.litter_id && dogInScope(d));
  const scopedKennels = isScoped() ? own.filter((k) => k.id === getActiveKennelId()) : own;
  const breeds = [...new Set(scopedKennels.flatMap((k) => kennelBreeds(k, dogs)))].sort();
  const expected = inScopeOnly(litters).filter((l) => l.status === 'expected');
  const { rows, availableCount, unsexed } = demandSupply({ families, pups, sales, breeds, configFor: (e) => waitlistConfig(kennelsById.get(e.kennel_id)) });
  return { href: 'demand-supply-report.html', rows, availableCount, unsexed, families, expected, breeds };
}

// --- Shows and stud -------------------------------------------------------------------

// Show Record: every result shown, newest first; titles earned by date.
export async function loadShowRecord() {
  const [dogs, shows, titles] = await Promise.all([
    dogRepo.getAll({ includeArchived: true }), eventRepo.getByType('show'), eventRepo.getByType('title_earned')
  ]);
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const scope = (e) => subjectInScope('dog', e.subject_id, { dog: dogsById });
  const rows = shows.filter((e) => e.details?.entry_status === 'shown').sort((a, b) => b.event_date.localeCompare(a.event_date));
  return { href: 'show-record-report.html', rows, scope, date: (e) => e.event_date, titles, dogs, dogsById };
}

// Stud Services: every live service, by the date sent; `role(s)`: our stud or our dam.
export const studServiceDate = (s) => s.sent_date || s.returned_date || '';
export async function loadStudServices() {
  const [services, dogs, contacts] = await Promise.all([
    studServiceRepo.getAll({ includeArchived: false }), dogRepo.getAll({ includeArchived: true }), contactRepo.getAll({ includeArchived: true })
  ]);
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  return { href: 'stud-services-report.html', rows: services, scope: inScope, date: studServiceDate, role: (s) => ourRole(s, dogsById), dogs, dogsById, contacts };
}

// Stud Results: each service with the litter it produced.
export async function loadStudResults() {
  const [services, litters, dogs, contacts] = await Promise.all([
    studServiceRepo.getAll({ includeArchived: false }), litterRepo.getAll({ includeArchived: true }),
    dogRepo.getAll({ includeArchived: true }), contactRepo.getAll({ includeArchived: true })
  ]);
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const when = (r) => studServiceDate(r.service);
  const rows = studResultRows(services, litters).sort((a, b) => when(b).localeCompare(when(a)));
  return { href: 'stud-results-report.html', rows, scope: (r) => inScope(r.service), date: when, role: (r) => ourRole(r.service, dogsById), dogs, dogsById, contacts };
}
