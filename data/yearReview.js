// yearReview.js — the numbers behind Year in Review (Reports plan, phase 1): one
// calendar year of the program on one page. PURE: plain records in, one summary
// out, so it's unit-tested in tests/yearReview.test.js; the page does the loading
// and scoping and hands everything in already scoped.
//
// Every figure is read the way the matching report reads it, so the one-pager
// never disagrees with the detail behind it:
//   litters / puppies   — Litters Over Time + Live-Birth Summary (by whelp_date)
//   placements          — Placements (by sale_date; released sales left out)
//   money in / out / net — Profit & Loss by Month (moneyReport.plByPeriod)
//   titles              — title_earned events dated in the year
//   waitlist            — families who applied in the year, and who's on it now
import { RELEASED_SALE_STATUSES } from './vocab.js';
import { periodsBetween } from './reportMath.js';
import { plByPeriod } from './moneyReport.js';

const inYear = (ymd, year) => Boolean(ymd) && ymd.slice(0, 4) === String(year);
const n = (v) => Number(v) || 0;

// The years any of the records touch, newest first (the page's year menu), always
// including `currentYear`.
export function reviewYears({ litters = [], sales = [], entries = [], expenses = [], events = [] }, currentYear) {
  const ys = new Set([String(currentYear)]);
  for (const l of litters) if (l.whelp_date) ys.add(l.whelp_date.slice(0, 4));
  for (const s of sales) if (s.sale_date) ys.add(s.sale_date.slice(0, 4));
  for (const e of entries) if (e.date) ys.add(e.date.slice(0, 4));
  for (const x of expenses) if (x.expense_date) ys.add(x.expense_date.slice(0, 4));
  for (const ev of events) if (ev.event_date) ys.add(ev.event_date.slice(0, 4));
  return [...ys].filter((y) => /^\d{4}$/.test(y) && y <= String(currentYear)).sort().reverse();
}

// The year's summary. `moneyEntries` are moneyReport.incomeEntries; `events` any
// dog events (title_earned ones are read); `waitlist` the entries (or [] when the
// edition has no waitlist).
export function yearSummary(year, { litters = [], sales = [], moneyEntries = [], expenses = [], events = [], waitlist = [] }) {
  const y = String(year);
  const yearLitters = litters.filter((l) => inYear(l.whelp_date, y) && l.status !== 'expected')
    .sort((a, b) => a.whelp_date.localeCompare(b.whelp_date));
  const placements = sales.filter((s) => inYear(s.sale_date, y) && !RELEASED_SALE_STATUSES.includes(s.status));
  const fellThrough = sales.filter((s) => inYear(s.sale_date, y) && RELEASED_SALE_STATUSES.includes(s.status)).length;
  const months = plByPeriod(moneyEntries, expenses, periodsBetween(`${y}-01-01`, `${y}-12-31`, 'month'), 'month');
  const titles = events.filter((e) => e.event_type === 'title_earned' && inYear(e.event_date, y))
    .sort((a, b) => a.event_date.localeCompare(b.event_date));
  const born = yearLitters.reduce((t, l) => t + n(l.puppies_born_total), 0);
  const alive = yearLitters.reduce((t, l) => t + n(l.puppies_born_alive), 0);
  const moneyIn = months.reduce((t, m) => t + m.income, 0);
  const moneyOut = months.reduce((t, m) => t + m.expenses, 0);
  return {
    year: y,
    litters: yearLitters,
    puppiesBorn: born,
    puppiesAlive: alive,
    placements,
    fellThrough,
    months,
    moneyIn,
    moneyOut,
    net: moneyIn - moneyOut,
    titles,
    waitlistApplied: waitlist.filter((e) => inYear(e.applied_date, y)).length,
    waitlistPlaced: waitlist.filter((e) => e.status === 'placed' && placements.some((s) => s.id === e.placed_sale_id)).length,
    waitlistNow: waitlist.filter((e) => e.status === 'active').length
  };
}
