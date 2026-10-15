// waitlistReports.js — the numbers behind the Sales & Waitlist reports (Reports plan,
// phases 2 and 4): the Waitlist Funnel, Demand vs Supply, Applications, Waitlist Today
// and Offers & Removals. PURE (tests/waitlistReports
// .test.js): plain, already-scoped records in, report data out. Matching reuses the
// waitlist's own rule (waitlistRules.pupMatchesPrefs), so "families who'd take this
// pup" here is exactly who the waitlist would offer it to — minus the listen-only
// parent choices, which are about litters, not pups.
import { pupMatchesPrefs, isPupAvailable, prefColorTokens, WAITLIST_CONFIG_DEFAULTS } from './waitlistRules.js';
import { REGISTRATION_TYPE, WAITLIST_REMOVED_REASON, WAITLIST_PREF_SEX, PLACEMENT_PURPOSE, registrationsForPurposes, cleanPurposes, descriptor } from './vocab.js';
import { daysBetween } from './breedingReports.js';

// --- Funnel -----------------------------------------------------------------------------

// The stages a family moves through, each a test on the entry (+ its offers). A
// later stage implies the earlier ones, so the counts only ever narrow.
export const FUNNEL_STAGES = [
  { value: 'applied',  label: 'Applied' },
  { value: 'approved', label: 'Approved' },
  { value: 'listed',   label: 'On the list' },
  { value: 'offered',  label: 'Offered a pup' },
  { value: 'placed',   label: 'Placed' }
];

// How far one entry got: the index into FUNNEL_STAGES of its furthest stage.
export function funnelStage(entry, offeredEntryIds = new Set()) {
  if (entry.status === 'placed' || entry.placed_sale_id) return 4;
  if (offeredEntryIds.has(entry.id)) return 3;
  const listed = Boolean(entry.fee_received_date) || entry.status === 'active'
    || (entry.status === 'removed' && entry.removed_reason !== 'fee_expired');
  if (listed) return 2;
  if (entry.approved_date || ['approved', 'expired'].includes(entry.status) || (entry.status === 'removed' && entry.removed_reason === 'fee_expired')) return 1;
  return 0;
}

// Counts per stage: [{ value, label, count }].
export function funnelCounts(entries, offers = []) {
  const offered = new Set(offers.map((o) => o.entry_id));
  const counts = FUNNEL_STAGES.map((s) => ({ ...s, count: 0 }));
  for (const e of entries) {
    const at = funnelStage(e, offered);
    for (let i = 0; i <= at; i++) counts[i].count += 1;
  }
  return counts;
}

// Why families left before being placed: [{ label, value }] — declined by you,
// withdrew, fee expired, and each removal reason.
export function exitReasons(entries) {
  const m = new Map();
  for (const e of entries) {
    const label = exitLabel(e);
    if (label) m.set(label, (m.get(label) || 0) + 1);
  }
  return [...m].map(([label, value]) => ({ label, value }));
}

// Why one entry left the list, as a label; null while it's open or placed.
export function exitLabel(e) {
  if (e.status === 'declined') return 'Declined by you';
  if (e.status === 'withdrawn') return 'Withdrew';
  if (e.status === 'expired') return 'Fee expired';
  if (e.status === 'removed') return e.removed_reason ? descriptor(WAITLIST_REMOVED_REASON, e.removed_reason).label : 'Removed';
  return null;
}

// How offers ended, and why families passed: { outcomes: [{label, value}], reasons:
// [{label, value}] }. A pass with no reason of the family's own is one she recorded.
export function offerOutcomes(offers) {
  const outcomes = new Map();
  const reasons = new Map();
  for (const o of offers) {
    if (o.outcome === 'open' || o.outcome === 'voided') continue;
    const label = { accepted: 'Accepted', passed: 'Passed', no_response: 'No response' }[o.outcome] || o.outcome;
    outcomes.set(label, (outcomes.get(label) || 0) + 1);
    if (o.outcome === 'passed') {
      const r = o.pass_reason?.label || 'Recorded by you';
      reasons.set(r, (reasons.get(r) || 0) + 1);
    }
  }
  return { outcomes: [...outcomes].map(([label, value]) => ({ label, value })), reasons: [...reasons].map(([label, value]) => ({ label, value })) };
}

// Days from applying to the placement's sale date, per placed family (sales by id).
export function daysToPlacement(entries, salesById) {
  return entries
    .filter((e) => e.applied_date && e.placed_sale_id && salesById.get(e.placed_sale_id)?.sale_date)
    .map((e) => daysBetween(e.applied_date, salesById.get(e.placed_sale_id).sale_date))
    .filter((d) => d >= 0);
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

export function mean(xs) {
  return xs.length ? xs.reduce((t, x) => t + x, 0) / xs.length : null;
}

// --- Applications -----------------------------------------------------------------------

// Days between one application and the next, in applied-date order (same-day
// applications are a 0-day gap). Entries without an applied date are skipped.
export function applicationGaps(entries) {
  const dates = entries.map((e) => e.applied_date).filter(Boolean).sort();
  return dates.slice(1).map((d, i) => daysBetween(dates[i], d));
}

// Has she decided on the application? Approved (or further) or declined. One
// still waiting, or withdrawn before she decided, isn't counted in the rates.
export const wasApproved = (e) => funnelStage(e) >= 1;
export const wasDecided = (e) => wasApproved(e) || e.status === 'declined';
// An approved family that went on the list (fee paid or waived).
export const wasListed = (e) => funnelStage(e) >= 2;

// Days from applying to approval, and from approval to the fee received; null
// when either date is missing (or the order is off, a data slip).
export function daysToApprove(e) {
  if (!e.applied_date || !e.approved_date) return null;
  const d = daysBetween(e.applied_date, e.approved_date);
  return d >= 0 ? d : null;
}
export function daysToFee(e) {
  if (!e.approved_date || !e.fee_received_date) return null;
  const d = daysBetween(e.approved_date, e.fee_received_date);
  return d >= 0 ? d : null;
}

// What sex families asked for, every option present: [{ value, label, count }]
// (Female, Male, Either; a blank preference is Either, as the waitlist reads it).
export const SEX_WANTED = [
  { value: 'female', label: 'A girl' },
  { value: 'male',   label: 'A boy' },
  { value: 'any',    label: 'Either' }
];
export function sexWanted(entries) {
  const of = (e) => (WAITLIST_PREF_SEX.some((s) => s.value === e.pref_sex) ? e.pref_sex : 'any');
  return SEX_WANTED.map((s) => ({ ...s, count: entries.filter((e) => of(e) === s.value).length }));
}

// The other answers that decide which pup a family is offered (waitlistRules
// .pupMatchesPrefs, isListeningFor): what the pup is for, which parents, breed and,
// with color matching on, color. Each is [{ value, label, count }] with the open
// answer ("Any …") last. Purposes are pick-all-that-apply, so a family counts under
// each one it picked and the counts can add up to more than the families.
const shortLabel = (label) => label.split(' (')[0];
export const purposeLabel = (value) => shortLabel(descriptor(PLACEMENT_PURPOSE, value).label);

export function purposesWanted(entries) {
  const picked = entries.map((e) => cleanPurposes(e.pref_purposes));
  return [
    ...PLACEMENT_PURPOSE.map((p) => ({ value: p.value, label: shortLabel(p.label), count: picked.filter((l) => l.includes(p.value)).length })),
    { value: '', label: 'Any purpose', count: picked.filter((l) => !l.length).length }
  ];
}

// How each family's purposes read together ("Pet / companion + Show"), or "Any".
export function purposesText(e) {
  const l = cleanPurposes(e.pref_purposes);
  return l.length ? l.map(purposeLabel).join(' + ') : 'Any';
}

// Listening for: any parents (every litter), only certain parents, or all but certain.
export const PARENT_CHOICES = [
  { value: 'all',      label: 'Any parents' },
  { value: 'selected', label: 'Only certain parents' },
  { value: 'except',   label: 'Any but certain parents' }
];
export const parentChoice = (e) => (PARENT_CHOICES.some((c) => c.value === e.listen_mode) ? e.listen_mode : 'all');
export function parentsWanted(entries) {
  return PARENT_CHOICES.map((c) => ({ ...c, count: entries.filter((e) => parentChoice(e) === c.value).length }));
}

// The sires and dams families asked for by name (`selected`), or asked to skip
// (`except`): [{ label, value }] largest first, one per dog. `nameOf(id)` names it.
export function parentsNamed(entries, mode, nameOf) {
  const m = new Map();
  for (const e of entries) {
    if (parentChoice(e) !== mode) continue;
    for (const id of new Set([...(e.listen_sire_ids || []), ...(e.listen_dam_ids || [])])) m.set(id, (m.get(id) || 0) + 1);
  }
  return [...m].map(([id, value]) => ({ label: nameOf(id), value })).sort((a, b) => b.value - a.value);
}

// Free-text answers (breed, colors), matched the waitlist's way (trimmed, any
// case); each is labeled with its first spelling. A family with no answer is "Any".
function textAnswers(entries, tokensOf, anyLabel) {
  const m = new Map();
  let open = 0;
  for (const e of entries) {
    const raw = tokensOf(e);
    if (!raw.length) { open += 1; continue; }
    for (const t of new Set(raw.map((x) => x.trim()).filter(Boolean))) {
      const k = t.toLowerCase();
      const row = m.get(k) || { value: k, label: t, count: 0 };
      row.count += 1;
      m.set(k, row);
    }
  }
  return [...[...m.values()].sort((a, b) => b.count - a.count), { value: '', label: anyLabel, count: open }];
}
export function breedsWanted(entries) {
  return textAnswers(entries, (e) => (String(e.pref_breed ?? '').trim() ? [String(e.pref_breed)] : []), 'Any breed');
}
export function colorsWanted(entries) {
  const raw = (e) => (Array.isArray(e.pref_colors) ? e.pref_colors : String(e.pref_colors ?? '').split(','));
  return textAnswers(entries, (e) => (prefColorTokens(e).length ? raw(e).map(String) : []), 'Any color');
}

// --- Waitlist today ---------------------------------------------------------------------

// The date a family's wait is counted from: her anchor date if she set one, else
// the fee received, else approval (fee waived), else the application.
export function listedSince(e) {
  return e.position_anchor_date || e.fee_received_date || e.approved_date || e.applied_date || null;
}

export const WAIT_BUCKETS = [
  { label: 'Under 3 months', under: 91 },
  { label: '3–6 months',     under: 183 },
  { label: '6–12 months',    under: 365 },
  { label: 'A year or more', under: Infinity }
];
// [{ label, value }] in bucket order, every bucket present, for families with a date.
export function waitBuckets(entries, today) {
  const counts = WAIT_BUCKETS.map((b) => ({ label: b.label, value: 0 }));
  for (const e of entries) {
    const since = listedSince(e);
    if (!since) continue;
    const days = Math.max(0, daysBetween(since, today));
    counts[WAIT_BUCKETS.findIndex((b) => days < b.under)].value += 1;
  }
  return counts;
}

// --- Offers & removals ------------------------------------------------------------------

// Removals that follow from the list's own rules (decided 2026-10-15: "didn't
// follow the list's rules"), as against ones she made herself. A fee that lapsed
// before the family was listed (status `expired`) counts here too.
export const RULE_REMOVAL_REASONS = ['second_pass', 'no_checkin_response', 'no_ready_answer', 'fee_expired'];

export const EXIT_GROUPS = [
  { value: 'rules',      label: 'Didn’t follow the list’s rules' },
  { value: 'by_breeder', label: 'Removed by you' },
  { value: 'declined',   label: 'Declined by you' },
  { value: 'withdrew',   label: 'Withdrew' }
];

// Which EXIT_GROUPS value an entry left under; null while open or placed. A
// removal with no reason recorded is one she made.
export function exitGroup(e) {
  if (e.status === 'expired') return 'rules';
  if (e.status === 'removed') return RULE_REMOVAL_REASONS.includes(e.removed_reason) ? 'rules' : 'by_breeder';
  if (e.status === 'declined') return 'declined';
  if (e.status === 'withdrawn') return 'withdrew';
  return null;
}

// When it left: the status's own date, else the closest one on file.
export function exitDate(e) {
  if (e.status === 'removed') return e.removed_date || null;
  if (e.status === 'withdrawn') return e.withdrawn_date || null;
  if (e.status === 'declined') return e.declined_date || e.applied_date || null;
  if (e.status === 'expired') return e.fee_due_date || e.approved_date || null;
  return null;
}

export const CLOSED_OUTCOMES = ['accepted', 'passed', 'no_response'];

// One row per closed offer and per family that left, for the Offers & Removals
// report: { id, kind: 'offer'|'exit', date, entry, offer?, what }, newest first.
// `what` is the outcome (accepted / passed / no_response) or the exit group.
export function offerAndExitRows(entries, offers) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const rows = [];
  for (const o of offers) {
    if (!CLOSED_OUTCOMES.includes(o.outcome) || !byId.has(o.entry_id)) continue;
    rows.push({ id: `o:${o.id}`, kind: 'offer', date: o.outcome_date || o.offered_date || null, entry: byId.get(o.entry_id), offer: o, what: o.outcome });
  }
  for (const e of entries) {
    const g = exitGroup(e);
    if (g) rows.push({ id: `e:${e.id}`, kind: 'exit', date: exitDate(e), entry: e, what: g });
  }
  return rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// The rates over those rows: offers closed, how they ended, passes that counted
// against a family, families offered and families who passed at least once, and
// families who left by group. Percentages are the caller's (reportMath.pct).
export function offerAndExitStats(rows) {
  const offers = rows.filter((r) => r.kind === 'offer');
  const exits = rows.filter((r) => r.kind === 'exit');
  const n = (list, what) => list.filter((r) => r.what === what).length;
  const families = (list) => new Set(list.map((r) => r.entry.id)).size;
  return {
    closed: offers.length,
    accepted: n(offers, 'accepted'),
    passed: n(offers, 'passed'),
    noResponse: n(offers, 'no_response'),
    countedPasses: offers.filter((r) => r.offer.counts_as_pass === true).length,
    familiesOffered: families(offers),
    familiesPassed: families(offers.filter((r) => r.what === 'passed' || r.what === 'no_response')),
    left: exits.length,
    byGroup: EXIT_GROUPS.map((g) => ({ ...g, count: n(exits, g.value) }))
  };
}

// --- Demand vs Supply -------------------------------------------------------------------

// One row per kind of pup (breed × sex × intended registration, plus "Registration
// not decided"): how many families on the list would be offered one, and how many
// available pups there are of that kind. `configFor(entry)` gives that family's
// kennel waitlist config (color matching).
//
// A family with no preferences would take any pup, so it counts under every row —
// but it doesn't make rows of its own, or the table would list every combination.
// A row shows when there are pups of that kind, or a family of that sex preference
// ticked a purpose that maps to its registration (sex alone narrows; it never makes
// a row for every registration). A breed shows when it
// has pups or a family named it (or it's the only breed).
export function demandSupply({ families = [], pups = [], sales = [], breeds = [], configFor = () => WAITLIST_CONFIG_DEFAULTS }) {
  const key = (s) => String(s ?? '').trim().toLowerCase();
  const available = pups.filter((p) => p.status === 'puppy' && isPupAvailable(p, sales));
  const allBreeds = breeds.length ? breeds : [...new Set(available.map((p) => p.breed).filter(Boolean))];
  const shownBreeds = allBreeds.length <= 1 ? allBreeds
    : allBreeds.filter((b) => available.some((p) => key(p.breed) === key(b)) || families.some((e) => key(e.pref_breed) === key(b)));
  const regs = [...REGISTRATION_TYPE.map((r) => r.value), ''];
  const rows = [];
  for (const breed of shownBreeds.length ? shownBreeds : ['']) {
    for (const sex of ['female', 'male']) {
      for (const reg of regs) {
        const pseudo = { sex, breed, intended_registration: reg || null };
        const matching = families.filter((e) => pupMatchesPrefs(e, pseudo, configFor(e)));
        const pupCount = available.filter((p) => p.sex === sex && (!breed || key(p.breed) === key(breed)) && (p.intended_registration || '') === reg).length;
        const asked = Boolean(reg) && matching.some((e) => (registrationsForPurposes(e.pref_purposes) || []).includes(reg));
        if (!pupCount && !asked) continue;
        rows.push({
          breed, sex, registration: reg,
          label: [shownBreeds.length > 1 ? breed : '', sex === 'female' ? 'Female' : 'Male', reg ? descriptor(REGISTRATION_TYPE, reg).label : 'Registration not decided'].filter(Boolean).join(' · '),
          families: matching.length,
          pups: pupCount,
          gap: matching.length - pupCount
        });
      }
    }
  }
  return { rows, availableCount: available.length, unsexed: available.filter((p) => p.sex !== 'male' && p.sex !== 'female').length };
}
