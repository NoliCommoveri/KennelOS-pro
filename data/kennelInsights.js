// kennelInsights.js — Kels's "How my business is doing" (Kels roadmap §3.14 B):
// her reports' own rows turned into plain sentences. Every figure comes from a
// report: the rows its loader builds (data/reportSources.js), cut to the range the
// way the report cuts them (reportMath.inView, or the report's rowsIn), and the
// figures its tiles show (data/reportFigures.js) or the report's own row fields.
// Nothing here works a number out that the report doesn't show. PURE: loaders'
// results in, insights out (tests/kennelInsights.test.js).
//
// An insight is { id, topic, text, tone, value, dogIds, source: { href, title,
// range } }: `text` is her sentence (plain text; the UI escapes it), `tone` 'good' |
// 'neutral' | 'watch', `value` the figure it's about (for ordering), `source` the
// report it came from and the range to open it on (null: the report has no range,
// like Waitlist Today or Breeding-Dog Return).
//
// How she says it (decided): names, rounded money and plain counts; a rate with its
// count; nothing ranked or compared under the minimums (2 litters for a dam or sire,
// 3 decided breedings for a sire's rate, 3 sales for an average price), where she
// says it's too early instead; a tie said as a tie; kind and factual about a dog
// that's behind; flags as prompts to look.
import { inView, rangeWords } from './reportMath.js';
import { growthSeries, growthFlags, successBy } from './breedingReports.js';
import {
  litterFigures, liveBirthFigures, placementFigures, pairingFigures, profitLossFigures, expenseFigures,
  receivableFigures, applicationFigures, waitingFigures, offerFigures, leadFigures, returnFigures, showFigures,
  studServiceFigures, studResultFigures, pricingFigures
} from './reportFigures.js';
import { parentsNamed } from './waitlistReports.js';
import { REPORTS } from './reportCatalog.js';
import { EXPENSE_CATEGORIES, descriptor } from './vocab.js';

export const MIN_LITTERS = 2;    // a dam's or sire's litters before she's ranked
export const MIN_BREEDINGS = 3;  // decided breedings before a sire's rate is said
export const MIN_SALES = 3;      // sales before an average price is compared
export const FIRST_SHOWN = 4;    // sentences per topic before "Tell me more"

// The topics she offers, each only where the edition has its reports.
export const TOPICS = [
  { id: 'dogs', label: 'My dogs' },
  { id: 'money', label: 'Money' },
  { id: 'litters', label: 'Litters & pups' },
  { id: 'sales', label: (f) => (f.waitlist ? 'Sales & the waitlist' : 'Sales') },
  { id: 'shows', label: (f) => (f.shows && f.studServices ? 'Shows & stud' : f.shows ? 'Shows' : 'Stud services'), when: (f) => f.shows || f.studServices },
  { id: 'all', label: 'The whole picture' }
];
export const insightTopics = (flags = {}) => TOPICS.filter((t) => !t.when || t.when(flags))
  .map((t) => ({ id: t.id, label: typeof t.label === 'function' ? t.label(flags) : t.label }));

// The report loaders each topic reads (reportSources.load<Name>).
export function topicSources(topic, flags = {}) {
  const by = {
    dogs: ['Production', 'PairingSuccess', 'DogReturn', 'HeatCycles', 'HealthGaps'],
    money: ['ProfitLoss', 'Expenses', 'LitterFinances', 'Receivables', 'Placements', 'Pricing'],
    litters: ['Litters', 'LiveBirths', 'PuppyGrowth'],
    sales: ['Placements', 'LeadSources', 'Returns', ...(flags.waitlist ? ['Applications', 'WaitlistToday', 'OffersRemovals', 'DemandSupply'] : [])],
    shows: [...(flags.shows ? ['ShowRecord'] : []), ...(flags.studServices ? ['StudServices', 'StudResults'] : [])]
  };
  if (topic !== 'all') return by[topic] || [];
  return [...new Set(insightTopics(flags).filter((t) => t.id !== 'all').flatMap((t) => by[t.id]))];
}

// A loader's rows for the range, as its report shows them.
export function rowsOf(src, range) {
  if (!src) return [];
  if (src.rowsIn) return inView(src.rowsIn(range), { scope: src.scope }, range);
  return inView(src.rows || [], { scope: src.scope, date: src.date }, range);
}

// --- Words -----------------------------------------------------------------------------

export const money = (n) => `${n < 0 ? '-' : ''}$${Math.round(Math.abs(Number(n) || 0)).toLocaleString('en-US')}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (xs) => (xs.length < 2 ? xs[0] || '' : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const dogName = (d) => d?.call_name || d?.registered_name || 'A dog';
const her = (d) => (d?.sex === 'female' ? 'her' : d?.sex === 'male' ? 'his' : 'their');
const percent = (part, whole) => `${Math.round((part / whole) * 100)}%`;
const monthName = (period) => new Date(`${period}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const fmtDay = (ymd) => new Date(`${ymd}T00:00:00Z`).toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const reportTitle = (href) => REPORTS.find((r) => r.href === href.split('?')[0])?.title || 'the report';

// The highest by `value`, or every row tied for it.
function top(rows, value) {
  if (!rows.length) return [];
  const best = Math.max(...rows.map(value));
  return rows.filter((r) => value(r) === best);
}

// --- The topics ----------------------------------------------------------------------------

// `loaded`: { [loaderName]: loader result } for the topic (topicSources). `ctx`:
// { preset, range, today, flags }. → insights, the most telling first.
export function insightsFor(topic, loaded, ctx) {
  const say = maker(topic, ctx);
  if (topic === 'all') {
    return insightTopics(ctx.flags).filter((t) => t.id !== 'all')
      .flatMap((t) => insightsFor(t.id, loaded, ctx).slice(0, t.id === 'dogs' || t.id === 'money' ? 2 : 1))
      .concat([{ ...maker('all', ctx)('year-review', `For the full story of a year, Year in Review puts it all on one page.`, { source: 'year-review.html', ranged: false }) }]);
  }
  const fn = { dogs: dogInsights, money: moneyInsights, litters: litterInsights, sales: salesInsights, shows: showInsights }[topic];
  return fn ? fn(loaded, ctx, say).filter(Boolean) : [];
}

function maker(topic, ctx) {
  return (id, text, { tone = 'neutral', value = null, dogIds = [], source, ranged = true } = {}) => ({
    id, topic, text, tone, value, dogIds,
    source: source ? { href: source, title: reportTitle(source), range: ranged ? ctx.preset : null } : null
  });
}

// My dogs: Dam & Sire Production, Pairing Success, Breeding-Dog Return, Heat
// Cycles, Health-Testing Gaps.
function dogInsights(L, ctx, say) {
  const when = rangeWords(ctx.preset);
  const out = [];
  const prod = rowsOf(L.Production, ctx.range);
  const P = L.Production?.href;
  for (const role of ['dam', 'sire']) {
    const withLitters = prod.filter((r) => r.role === role && r.litters > 0);
    const ranked = withLitters.filter((r) => r.litters >= MIN_LITTERS);
    if (ranked.length) {
      const best = top(ranked, (r) => r.born);
      const b = best[0];
      out.push(best.length === 1
        ? say(`prolific-${role}`, `Your most prolific ${role} ${when} is ${dogName(b.dog)}, with ${plural(b.litters, 'litter')} and ${plural(b.born, 'puppy', 'puppies')}.`, { tone: 'good', value: b.born, dogIds: [b.dog.id], source: P })
        : say(`prolific-${role}`, `${list(best.map((r) => dogName(r.dog)))} tie as your most prolific ${role}s ${when}, with ${plural(b.born, 'puppy', 'puppies')} each.`, { tone: 'good', value: b.born, dogIds: best.map((r) => r.dog.id), source: P }));
    } else if (withLitters.length) {
      const names = withLitters.map((r) => dogName(r.dog));
      out.push(say(`prolific-${role}`, withLitters.length === 1
        ? `${names[0]} had ${role === 'dam' ? 'your only litter' : 'the only litter you sired'} ${when}, with ${plural(withLitters[0].born, 'puppy', 'puppies')}. It's too early to compare ${role}s yet.`
        : `${list(names)} each had one litter ${when}, so it's too early to say which ${role} is most productive.`, { value: withLitters.length, dogIds: withLitters.map((r) => r.dog.id), source: P }));
    }
  }
  const rated = prod.filter((r) => r.role === 'dam' && r.litters >= MIN_LITTERS && r.born > 0);
  if (rated.length >= 2) {
    const best = top(rated, (r) => r.livePct);
    if (best.length < rated.length) {
      const b = best[0];
      out.push(say('live-births', best.length === 1
        ? `${dogName(b.dog)} had the best live-birth rate: ${b.alive} of ${b.born} born alive.`
        : `${list(best.map((r) => dogName(r.dog)))} share the best live-birth rate, ${percent(b.alive, b.born)}.`, { tone: 'good', value: b.livePct, dogIds: best.map((r) => r.dog.id), source: P }));
    }
  }
  // A breeding female with no litter, said as what happened.
  const idle = prod.filter((r) => r.idle && r.idle !== 'expecting');
  if (idle.length) {
    const by = (k) => idle.filter((r) => r.idle === k).map((r) => dogName(r.dog));
    const parts = [
      by('missed').length ? `${list(by('missed'))} ${by('missed').length === 1 ? 'was' : 'were'} bred but didn't take` : '',
      by('waiting').length ? `${list(by('waiting'))} ${by('waiting').length === 1 ? 'was' : 'were'} bred and you're waiting to hear` : '',
      by('not_bred').length ? `${list(by('not_bred'))} ${by('not_bred').length === 1 ? 'hasn\'t' : 'haven\'t'} been bred` : ''
    ].filter(Boolean);
    out.push(say('no-litter', `No litter ${when} from ${plural(idle.length, 'breeding girl')}: ${parts.join(', and ')}.`, { tone: 'watch', value: idle.length, dogIds: idle.map((r) => r.dog.id), source: P }));
  }
  const expecting = prod.filter((r) => r.idle === 'expecting');
  if (expecting.length) out.push(say('expecting', `${list(expecting.map((r) => dogName(r.dog)))} ${expecting.length === 1 ? 'is' : 'are'} expecting!`, { tone: 'good', value: expecting.length, dogIds: expecting.map((r) => r.dog.id), source: P }));

  // Breedings: how often they took, and the sire whose took least often.
  const pairings = rowsOf(L.PairingSuccess, ctx.range);
  const pf = pairingFigures(pairings);
  const PS = L.PairingSuccess?.href;
  if (pf.decided >= MIN_BREEDINGS) out.push(say('breedings', `${pf.took} of ${pf.decided} breedings took ${when}${pf.waiting ? `, and ${plural(pf.waiting, 'is', 'are')} still waiting` : ''}.`, { tone: pf.rate >= 0.75 ? 'good' : 'neutral', value: pf.rate, source: PS }));
  const sires = successBy(pairings, (r) => r.pairing.sire_id).filter((g) => g.success + g.failed >= MIN_BREEDINGS);
  if (sires.length >= 2) {
    const low = [...sires].sort((a, b) => a.rate - b.rate)[0];
    if (low.rate < Math.max(...sires.map((g) => g.rate))) {
      const sire = (L.PairingSuccess.dogs || []).find((d) => d.id === low.key);
      out.push(say('sire-rate', `Of your sires, ${dogName(sire)}'s breedings took least often: ${low.success} of ${low.success + low.failed}.`, { tone: 'watch', value: low.rate, dogIds: [low.key], source: PS }));
    }
  }

  // Earnings and return, lifetime (Breeding-Dog Return has no range).
  const ret = L.DogReturn?.rows || [];
  const R = L.DogReturn?.href;
  for (const role of ['dam', 'sire']) {
    const earners = ret.filter((r) => r.role === role && r.earned + r.studFees > 0);
    if (earners.length < 2) continue;
    const best = top(earners, (r) => r.earned + r.studFees);
    if (best.length > 1) continue;
    const b = best[0];
    out.push(say(`earning-${role}`, `Your highest-earning ${role} is ${dogName(b.dog)}: ${her(b.dog)} pups${b.studFees ? ' and stud fees' : ''} have brought in ${money(b.earned + b.studFees)} so far.`, { tone: 'good', value: b.earned + b.studFees, dogIds: [b.dog.id], source: R, ranged: false }));
  }
  const red = ret.filter((r) => r.net < 0).sort((a, b) => a.net - b.net);
  if (red.length) {
    const r = red[0];
    out.push(say('in-the-red', `${dogName(r.dog)}'s own costs are more than ${her(r.dog)} pups${r.studFees ? ' and stud fees' : ''} have brought in so far, by ${money(-r.net)}${r.anticipated ? `, with ${money(r.anticipated)} still to come` : ''}.`, { tone: 'watch', value: r.net, dogIds: [r.dog.id], source: R, ranged: false }));
  }

  // Flags to look at, as the report says them.
  const b2b = prod.filter((r) => r.backToBack);
  if (b2b.length) out.push(say('back-to-back', `${list(b2b.map((r) => dogName(r.dog)))} had litters less than 8 months apart, worth a look.`, { tone: 'watch', value: b2b.length, dogIds: b2b.map((r) => r.dog.id), source: P }));
  const life = prod.filter((r) => r.lifetimeFlag);
  if (life.length) out.push(say('lifetime', `${list(life.map((r) => `${dogName(r.dog)} (${r.litters})`))} ${life.length === 1 ? 'has' : 'have'} had 6 or more litters, worth a look at ${life.length === 1 ? her(life[0].dog) : 'their'} plans.`, { tone: 'watch', value: life.length, dogIds: life.map((r) => r.dog.id), source: P }));

  // Now: heats coming up, tests planned and not logged.
  const heats = (L.HeatCycles?.rows || []).filter((r) => r.status === 'due_soon' || r.status === 'overdue');
  if (heats.length) {
    const soon = heats.filter((r) => r.status === 'due_soon');
    const late = heats.filter((r) => r.status === 'overdue');
    out.push(say('heats', [
      soon.length ? `${list(soon.map((r) => `${dogName(r.dog)} (around ${fmtDay(r.next)})`))} ${soon.length === 1 ? 'has a heat' : 'have heats'} due in the next month` : '',
      late.length ? `${list(late.map((r) => dogName(r.dog)))} ${late.length === 1 ? 'is' : 'are'} past ${late.length === 1 ? her(late[0].dog) : 'their'} predicted heat with none logged` : ''
    ].filter(Boolean).join(', and ') + '.', { tone: 'neutral', value: heats.length, dogIds: heats.map((r) => r.dog.id), source: L.HeatCycles.href, ranged: false }));
  }
  const gaps = (L.HealthGaps?.rows || []).filter((r) => r.missing.length);
  if (gaps.length) {
    const n = gaps.reduce((t, r) => t + r.missing.length, 0);
    out.push(say('health-gaps', `${plural(gaps.length, 'dog')} ${gaps.length === 1 ? 'has' : 'have'} health tests planned and not logged yet (${plural(n, 'test')} in all${gaps.length <= 3 ? `: ${list(gaps.map((r) => dogName(r.dog)))}` : ''}).`, { tone: 'watch', value: n, dogIds: gaps.map((r) => r.dog.id), source: L.HealthGaps.href, ranged: false }));
  }
  return out;
}

// Money: Profit & Loss, Expenses by Category, Litter P&L, Receivables, Placements, Pricing.
function moneyInsights(L, ctx, say) {
  const when = rangeWords(ctx.preset);
  const out = [];
  const pl = profitLossFigures(rowsOf(L.ProfitLoss, ctx.range));
  const PL = L.ProfitLoss?.href;
  if (pl.income || pl.expenses) {
    out.push(say('net', pl.net >= 0
      ? `You made ${money(pl.net)} net ${when}: ${money(pl.income)} came in and ${money(pl.expenses)} went out.`
      : `You spent ${money(-pl.net)} more than came in ${when}: ${money(pl.income)} in and ${money(pl.expenses)} out.`, { tone: pl.net >= 0 ? 'good' : 'watch', value: pl.net, source: PL }));
    if (pl.months >= 2 && pl.best && pl.best.net > 0) out.push(say('best-month', `Your best month was ${monthName(pl.best.period)}, with ${money(pl.best.net)} net.`, { tone: 'good', value: pl.best.net, source: PL }));
  }
  const ex = expenseFigures(rowsOf(L.Expenses, ctx.range));
  if (ex.total > 0 && ex.byCategory[0]) {
    const c = ex.byCategory[0];
    out.push(say('biggest-cost', `Your biggest cost was ${descriptor(EXPENSE_CATEGORIES, c.key).label.toLowerCase()}, at ${money(c.value)} (${percent(c.value, ex.total)} of what you spent).`, { value: c.value, source: L.Expenses.href }));
  }
  const lit = rowsOf(L.LitterFinances, ctx.range).filter((f) => f.earned || f.totalExpenses);
  if (lit.length >= 2) {
    const dogs = new Map((L.LitterFinances.dogs || []).map((d) => [d.id, d]));
    const label = (l) => l.nickname || `${dogName(dogs.get(l.dam_id))} × ${dogName(dogs.get(l.sire_id))}`;
    const sorted = [...lit].sort((a, b) => b.net - a.net);
    const hi = sorted[0];
    const lo = sorted[sorted.length - 1];
    if (hi.net !== lo.net) out.push(say('litters-net', `Your most profitable litter was ${label(hi.litter)}, netting ${money(hi.net)}; the least was ${label(lo.litter)}, at ${money(lo.net)}.`, { value: hi.net, source: L.LitterFinances.href }));
  }
  const rc = receivableFigures(L.Receivables?.rows || []);
  if (rc.owed > 0) {
    out.push(say('owed', rc.overdue > 0
      ? `You're owed ${money(rc.owed)} right now, and ${money(rc.overdue)} of it is overdue${rc.over90 ? ` (${money(rc.over90)} by more than 90 days)` : ''}.`
      : `You're owed ${money(rc.owed)} right now, and none of it is overdue.`, { tone: rc.overdue > 0 ? 'watch' : 'neutral', value: rc.owed, source: L.Receivables.href, ranged: false }));
  }
  const regs = placementFigures(rowsOf(L.Placements, ctx.range)).byRegistration.filter((r) => r.total > 0);
  if (regs.length >= 2) {
    const [first, ...rest] = [...regs].sort((a, b) => b.total - a.total);
    out.push(say('by-registration', `${regLabel(first)} pups brought in ${money(first.total)}, ${list(rest.map((r) => `${regLabel(r)} ${money(r.total)}`))}.`, { value: first.total, source: L.Placements.href }));
  }
  const pr = pricingFigures(rowsOf(L.Pricing, ctx.range));
  if (pr.fullCount && pr.limitedCount) {
    if (pr.fullCount >= MIN_SALES && pr.limitedCount >= MIN_SALES) {
      const d = pr.full - pr.limited;
      out.push(say('full-vs-limited', Math.round(d) === 0 ? 'Full and Limited are selling for about the same, on average.'
        : `Full ${d > 0 ? 'sells' : 'is selling'} for ${money(Math.abs(d))} ${d > 0 ? 'more' : 'less'} than Limited, on average.`, { value: d, source: L.Pricing.href }));
    } else {
      out.push(say('full-vs-limited', `It's too early to compare Full and Limited prices: you've sold ${pr.fullCount} on Full and ${pr.limitedCount} on Limited ${when}.`, { value: 0, source: L.Pricing.href }));
    }
  }
  return out;
}

const regLabel = (r) => (r.value === 'none' ? 'Unregistered' : r.label);

// Litters & pups: Litters Over Time, Live-Birth Summary, Puppy Growth.
function litterInsights(L, ctx, say) {
  const when = rangeWords(ctx.preset);
  const out = [];
  const lf = litterFigures(rowsOf(L.Litters, ctx.range));
  if (lf.litters) {
    out.push(say('litters', `You had ${plural(lf.litters, 'litter')} ${when}${lf.born ? `, with ${plural(lf.born, 'puppy', 'puppies')} born` : ''}.`, { tone: 'good', value: lf.litters, source: L.Litters.href }));
    if (lf.counted >= MIN_LITTERS) out.push(say('avg-litter', `Your average litter was ${lf.avgLitter.toFixed(1)} puppies.`, { value: lf.avgLitter, source: L.Litters.href }));
  }
  const lb = liveBirthFigures(rowsOf(L.LiveBirths, ctx.range));
  if (lb.born) out.push(say('live-rate', `${lb.alive} of ${lb.born} puppies were born alive (${percent(lb.alive, lb.born)}).`, { tone: lb.alive === lb.born ? 'good' : 'neutral', value: lb.rate, source: L.LiveBirths.href }));
  // A pup falling behind its littermates, in the litters whelped in the range.
  const G = L.PuppyGrowth;
  if (G) {
    const dogs = new Map((G.dogs || []).map((d) => [d.id, d]));
    for (const litter of rowsOf(G, ctx.range).filter((l) => l.status !== 'closed')) {
      const flags = growthFlags(growthSeries(G.pupsOf(litter), G.weights, litter));
      for (const [pupId, f] of flags) {
        const pup = dogs.get(pupId);
        const dam = dogs.get(litter.dam_id);
        out.push(say(`growth-${pupId}`, `${dogName(pup)} in ${dam ? `${dogName(dam)}'s` : 'a'} litter is at ${Math.round(f.ratio * 100)}% of ${her(pup)} littermates' weight, worth keeping an eye on.`, { tone: 'watch', value: f.ratio, dogIds: [pupId], source: `${G.href}?litter=${encodeURIComponent(litter.id)}`, ranged: false }));
      }
    }
  }
  return out;
}

// Sales & the waitlist: Placements, Lead Sources, Returns; Applications, Waitlist
// Today, Offers & Removals, Demand vs Supply where the waitlist is.
function salesInsights(L, ctx, say) {
  const when = rangeWords(ctx.preset);
  const out = [];
  const pf = placementFigures(rowsOf(L.Placements, ctx.range));
  const PL = L.Placements?.href;
  if (pf.placed) {
    out.push(say('placed', `You placed ${plural(pf.placed, 'pup')} ${when}${pf.priced ? `, for ${money(pf.value)}${pf.priced >= MIN_SALES ? ` (about ${money(pf.avgPrice)} each)` : ''}` : ''}.`, { tone: 'good', value: pf.placed, source: PL }));
    const regs = pf.byRegistration.filter((r) => r.count);
    if (regs.length >= 2) out.push(say('placed-registration', `${list(regs.map((r) => `${r.count} on ${regLabel(r)}`))}.`.replace(/^(.)/, (c) => c.toUpperCase()), { value: regs.length, source: PL }));
  }
  const lead = L.LeadSources;
  if (lead) {
    const lf = leadFigures(rowsOf(lead, ctx.range), (s) => String(s.lead_source || '').trim().toLowerCase());
    if (lf.top) out.push(say('lead-source', `Your top lead source was ${lead.label(lf.top.key)}, with ${plural(lf.top.value, 'sale')}${lf.referred ? `, and ${plural(lf.referred, 'buyer was', 'buyers were')} referred` : ''}.`, { value: lf.top.value, source: lead.href }));
  }
  const ret = L.Returns;
  if (ret) {
    const ended = rowsOf(ret, ctx.range);
    const made = (ret.allInScope || []).filter((s) => inView([s], { date: ret.date }, ctx.range).length).length;
    const rf = returnFigures(ended, made);
    if (rf.ended) out.push(say('returns', `${plural(rf.ended, 'sale')} ended ${when} without the pup staying placed${rf.health ? ` (${rf.health} for health reasons)` : ''}.`, { tone: 'watch', value: rf.ended, source: ret.href }));
    else if (made >= MIN_SALES) out.push(say('returns', `None of your ${made} sales ${when} fell through.`, { tone: 'good', value: 0, source: ret.href }));
  }
  if (!ctx.flags.waitlist) return out;

  const apps = L.Applications;
  if (apps) {
    const list0 = rowsOf(apps, ctx.range);
    const af = applicationFigures(list0);
    if (af.count) {
      const often = af.gaps >= 2 && af.meanGap != null ? `, a new one about every ${plural(Math.max(1, Math.round(af.meanGap)), 'day')}` : '';
      out.push(say('applications', `You had ${plural(af.count, 'application')} ${when}${often}${af.decided ? `, and approved ${af.approved} of the ${af.decided} you decided on` : ''}.`, { value: af.count, source: apps.href }));
      const wants = af.sex.filter((s) => s.count);
      const wanted = { female: 'wanted a girl', male: 'wanted a boy', any: 'didn\'t mind which' };
      if (wants.length) out.push(say('wants', `Of the families who applied, ${list(wants.map((s) => `${s.count} ${wanted[s.value]}`))}.`, { value: wants.length, source: apps.href }));
      const dogs = new Map((apps.dogs || []).map((d) => [d.id, d]));
      const named = parentsNamed(list0, 'selected', (id) => dogName(dogs.get(id)));
      if (named.length) out.push(say('parents-asked', `${plural(named[0].value, 'family', 'families')} asked only for ${named[0].label}'s pups.`, { value: named[0].value, source: apps.href }));
    }
  }
  const today = L.WaitlistToday;
  if (today) {
    const wf = waitingFigures(rowsOf(today, ctx.range), today);
    const toReview = (today.pipeline || []).filter((e) => e.status === 'applied').length;
    const feeDue = (today.pipeline || []).filter((e) => e.status === 'approved').length;
    if (wf.waiting) {
      const kinds = [wf.girl ? `${wf.girl} for a girl` : '', wf.boy ? `${wf.boy} for a boy` : '', wf.either ? `${wf.either} for either` : ''].filter(Boolean);
      out.push(say('waiting', `${plural(wf.waiting, 'family is', 'families are')} waiting now: ${list(kinds)}${wf.paused ? `; ${wf.paused} ${wf.paused === 1 ? 'is' : 'are'} paused` : ''}.${wf.medianWait != null ? ` They've waited about ${plural(Math.round(wf.medianWait), 'day')} (the middle of the list).` : ''}`, { value: wf.waiting, source: today.href, ranged: false }));
    }
    if (toReview || feeDue) out.push(say('pipeline', `${[toReview ? `${plural(toReview, 'application')} to review` : '', feeDue ? `${plural(feeDue, 'family', 'families')} with a fee due` : ''].filter(Boolean).join(' and ')}.`.replace(/^(.)/, (c) => c.toUpperCase()), { tone: 'watch', value: toReview + feeDue, source: today.href, ranged: false }));
  }
  const offers = L.OffersRemovals;
  if (offers) {
    const s = offerFigures(rowsOf(offers, ctx.range));
    if (s.closed >= MIN_SALES) out.push(say('offers', `Families accepted ${s.accepted} of ${s.closed} offers ${when}${s.passed ? `; ${s.passed} passed` : ''}${s.noResponse ? ` and ${s.noResponse} didn't answer` : ''}.`, { value: s.accepted / s.closed, source: offers.href }));
    else if (s.closed) out.push(say('offers', `${plural(s.closed, 'offer')} closed ${when}: ${s.accepted} accepted, ${s.passed} passed${s.noResponse ? `, ${s.noResponse} unanswered` : ''}.`, { value: s.closed, source: offers.href }));
  }
  const ds = L.DemandSupply;
  if (ds) {
    const short = (ds.rows || []).filter((r) => r.gap > 0 && r.registration).sort((a, b) => b.gap - a.gap)[0];
    if (short) out.push(say('demand', `${plural(short.families, 'family', 'families')} would take a ${short.label.toLowerCase()} pup, and you have ${short.pups} available.`, { tone: 'watch', value: short.gap, source: ds.href, ranged: false }));
  }
  return out;
}

// Shows & stud: Show Record, Stud Services, Stud Results.
function showInsights(L, ctx, say) {
  const when = rangeWords(ctx.preset);
  const out = [];
  const S = L.ShowRecord;
  if (S) {
    const titles = (S.titles || []).filter((t) => inView([t], { scope: S.scope, date: (e) => e.event_date }, ctx.range).length);
    const sf = showFigures(rowsOf(S, ctx.range), titles);
    if (sf.results) {
      out.push(say('points', `Your dogs won ${plural(sf.points, 'point')} from ${plural(sf.results, 'show result')} ${when}${sf.majors ? `, with ${plural(sf.majors, 'major')}` : ''}.`, { tone: 'good', value: sf.points, source: S.href }));
      const best = sf.byDog[0];
      if (sf.dogs >= 2 && best && best.value > 0) out.push(say('top-show-dog', `${dogName(S.dogsById.get(best.key))} won the most, with ${plural(best.value, 'point')}.`, { tone: 'good', value: best.value, dogIds: [best.key], source: S.href }));
    }
    if (titles.length) out.push(say('titles', `${plural(titles.length, 'title')} earned: ${list(titles.map((t) => `${dogName(S.dogsById.get(t.subject_id))} ${t.details?.title_abbreviation || ''}`.trim()))}.`, { tone: 'good', value: titles.length, source: S.href }));
  }
  const SV = L.StudServices;
  if (SV) {
    const f = studServiceFigures(rowsOf(SV, ctx.range), SV.role);
    if (f.studsDone) out.push(say('stud-fees', `Your studs earned ${money(f.earned)} in stud fees ${when}, from ${plural(f.studsDone, 'completed service')}.`, { tone: 'good', value: f.earned, source: SV.href }));
    if (f.damsDone) out.push(say('stud-paid', `You paid ${money(f.paid)} in stud fees for ${plural(f.damsDone, 'breeding')} of your girls.`, { value: f.paid, source: SV.href }));
  }
  const SR = L.StudResults;
  if (SR) {
    const f = studResultFigures(rowsOf(SR, ctx.range), SR.role);
    if (f.litters) out.push(say('stud-litters', `Stud services ${when} produced ${plural(f.litters, 'litter')} with ${plural(f.born, 'puppy', 'puppies')}.`, { tone: 'good', value: f.litters, source: SR.href }));
  }
  return out;
}

// For a topic with nothing in the range: what she says.
export function nothingText(topicLabel, preset) {
  return preset === 'all'
    ? `I don't have anything to tell you about ${topicLabel.toLowerCase()} yet. Once there's more in your records, I'll have plenty to say!`
    : `I didn't find anything about ${topicLabel.toLowerCase()} ${rangeWords(preset)}. Want me to look at all time instead?`;
}
