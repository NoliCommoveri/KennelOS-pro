// reportFigures.js — the figures a report's tiles show, worked out from the rows on
// screen, for the reports whose tiles Kels quotes (data/kennelInsights.js). The
// report page's tiles and Kels both call these, so a number she says is the number
// the tile shows for the same range. PURE (tests/reportFigures.test.js).
import { sumOf, rankBy } from './reportMath.js';
import { successBy } from './breedingReports.js';
import { byRegistration } from './moneyReport.js';
import {
  applicationGaps, wasApproved, wasDecided, wasListed, daysToApprove, daysToFee, sexWanted, mean, median,
  offerAndExitStats
} from './waitlistReports.js';
import { RELEASED_SALE_STATUSES, isLostSale } from './vocab.js';
import { eventPoints } from './showPoints.js';

const num = (v) => (v === '' || v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const priced = (s) => num(s.price) != null;
const placed = (s) => !RELEASED_SALE_STATUSES.includes(s.status);

// Litters Over Time: litters, puppies born and alive, the average litter over the
// litters with a count.
export function litterFigures(litters) {
  const born = litters.filter((l) => Number(l.puppies_born_total) > 0);
  const total = sumOf(born, (l) => l.puppies_born_total);
  return { litters: litters.length, born: total, alive: sumOf(born, (l) => l.puppies_born_alive), counted: born.length, avgLitter: born.length ? total / born.length : null };
}

// Live-Birth Summary: born and alive summed over the litters, then divided.
export function liveBirthFigures(litters) {
  const born = sumOf(litters, (l) => l.puppies_born_total);
  const alive = sumOf(litters, (l) => l.puppies_born_alive);
  return { litters: litters.length, born, alive, rate: born ? alive / born : null };
}

// Placements: placed sales, those that fell through, sale value and average price
// (placed sales with a price), and pups placed by registration.
export function placementFigures(sales) {
  const live = sales.filter(placed);
  const withPrice = live.filter(priced);
  const value = sumOf(withPrice, (s) => s.price);
  return {
    placed: live.length, fellThrough: sales.length - live.length, value, priced: withPrice.length,
    avgPrice: withPrice.length ? value / withPrice.length : null, byRegistration: byRegistration(live)
  };
}

// Pairing Success: bred, took, missed, waiting, and the rate over decided ones.
export function pairingFigures(rows) {
  const all = successBy(rows, () => 'all')[0] || { success: 0, failed: 0, pending: 0, rate: null };
  return { bred: rows.length, took: all.success, missed: all.failed, waiting: all.pending, decided: all.success + all.failed, rate: all.rate };
}

// Profit & Loss by Month: earned income, expenses, net and still to come over the
// months, and the best and worst month by net among the months with money in or out.
export function profitLossFigures(months) {
  const active = months.filter((m) => m.income || m.expenses);
  const sorted = [...active].sort((a, b) => b.net - a.net);
  return {
    income: sumOf(months, (m) => m.income), expenses: sumOf(months, (m) => m.expenses), net: sumOf(months, (m) => m.net),
    anticipated: sumOf(months, (m) => m.anticipated), months: active.length,
    best: sorted[0] || null, worst: sorted.length > 1 ? sorted[sorted.length - 1] : null
  };
}

// Expenses by Category: the total and each category, biggest first.
export function expenseFigures(expenses) {
  return { total: sumOf(expenses, (x) => x.amount), byCategory: rankBy(expenses, { key: (x) => x.category, value: (x) => x.amount }) };
}

// Receivables: what's owed, and how much of it is past due.
export const OVERDUE_BUCKETS = ['d30', 'd60', 'd90', 'd90plus'];
export function receivableFigures(rows) {
  const overdue = rows.filter((r) => OVERDUE_BUCKETS.includes(r.bucket));
  return { owed: sumOf(rows, (r) => r.amount), count: rows.length, overdue: sumOf(overdue, (r) => r.amount), overdueCount: overdue.length,
    over90: sumOf(rows.filter((r) => r.bucket === 'd90plus'), (r) => r.amount) };
}

// Applications: how many, the gap between them, approvals, and how fast.
export function applicationFigures(entries) {
  const gaps = applicationGaps(entries);
  const decided = entries.filter(wasDecided);
  const approved = entries.filter(wasApproved);
  const listed = approved.filter(wasListed);
  const approveDays = entries.map(daysToApprove).filter((d) => d != null);
  const feeDays = entries.map(daysToFee).filter((d) => d != null);
  return {
    count: entries.length, meanGap: mean(gaps), medianGap: median(gaps), gaps: gaps.length,
    decided: decided.length, approved: approved.length, listed: listed.length,
    daysToApprove: median(approveDays), daysToFee: median(feeDays), sex: sexWanted(entries)
  };
}

// Waitlist Today: who's waiting, for what, how long, and how many are paused.
export function waitingFigures(list, { paused, waited }) {
  const sex = sexWanted(list);
  const of = (v) => sex.find((s) => s.value === v)?.count || 0;
  return { waiting: list.length, paused: list.filter(paused).length, girl: of('female'), boy: of('male'), either: of('any'),
    medianWait: median(list.map(waited).filter((d) => d != null)) };
}

// Offers & Removals.
export const offerFigures = (rows) => offerAndExitStats(rows);

// Lead Sources & Referrers: sales, the top source, referrals.
export function leadFigures(sales, sourceKey) {
  const top = rankBy(sales.filter(sourceKey), { key: sourceKey })[0] || null;
  const referred = sales.filter((s) => s.referred_by_contact_id);
  return { sales: sales.length, top, referred: referred.length, referrers: new Set(referred.map((s) => s.referred_by_contact_id)).size,
    unrecorded: sales.filter((s) => !sourceKey(s)).length };
}

// Returns & Voids: how many ended against the sales made in the range.
export const HEALTH_END_REASONS = ['pup_died', 'failed_health_check', 'health_problem'];
export function returnFigures(ended, madeInRange) {
  return { ended: ended.length, made: madeInRange, lost: ended.filter(isLostSale).length,
    health: ended.filter((s) => HEALTH_END_REASONS.includes(s.end_reason)).length, cancelled: ended.filter((s) => s.status === 'cancelled').length };
}

// Show Record: results, dogs shown, points, pointed wins, majors, titles earned.
export function showFigures(results, titles) {
  return { results: results.length, dogs: new Set(results.map((e) => e.subject_id)).size, points: sumOf(results, eventPoints),
    pointed: results.filter((e) => eventPoints(e) > 0).length, majors: results.filter((e) => eventPoints(e) >= 3).length, titles: titles.length,
    byDog: rankBy(results, { key: (e) => e.subject_id, value: eventPoints }) };
}

// Stud Services: our studs' and our dams' services, fees earned and paid (completed).
export function studServiceFigures(services, role) {
  const out = services.filter((s) => role(s) === 'stud');
  const inc = services.filter((s) => role(s) === 'dam');
  const done = (xs) => xs.filter((s) => s.status === 'completed');
  return { studs: out.length, studsDone: done(out).length, dams: inc.length, damsDone: done(inc).length,
    earned: sumOf(done(out), (s) => s.fee_amount), paid: sumOf(done(inc), (s) => s.fee_amount) };
}

// Stud Results: services, litters they produced, puppies born.
export function studResultFigures(rows, role) {
  const litterRows = rows.filter((r) => r.litter);
  const outgoing = rows.filter((r) => role(r) === 'stud');
  return { services: rows.length, ourStud: outgoing.length, litters: litterRows.length, born: sumOf(litterRows, (r) => r.born),
    feesEarned: sumOf(outgoing.filter((r) => r.service.status === 'completed'), (r) => num(r.service.fee_amount) || 0) };
}

// Pricing: sales, the average price, and Full against Limited (each average over
// that registration's sales; `fullCount` / `limitedCount` say how many).
export function pricingFigures(rows) {
  const avg = (xs) => (xs.length ? sumOf(xs, (r) => r.price) / xs.length : null);
  const full = rows.filter((r) => r.sale.registration_type === 'full');
  const limited = rows.filter((r) => r.sale.registration_type === 'limited');
  const vs = rows.filter((r) => r.diff != null);
  return { sales: rows.length, avg: avg(rows), full: avg(full), fullCount: full.length, limited: avg(limited), limitedCount: limited.length,
    vsLitter: vs.length ? sumOf(vs, (r) => r.diff) / vs.length : null, vsCount: vs.length };
}
