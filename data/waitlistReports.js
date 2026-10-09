// waitlistReports.js — the numbers behind the Sales & Waitlist reports (Reports plan,
// phase 2): the Waitlist Funnel and Demand vs Supply. PURE (tests/waitlistReports
// .test.js): plain, already-scoped records in, report data out. Matching reuses the
// waitlist's own rule (waitlistRules.pupMatchesPrefs), so "families who'd take this
// pup" here is exactly who the waitlist would offer it to — minus the listen-only
// parent choices, which are about litters, not pups.
import { pupMatchesPrefs, isPupAvailable, WAITLIST_CONFIG_DEFAULTS } from './waitlistRules.js';
import { REGISTRATION_TYPE, WAITLIST_REMOVED_REASON, registrationsForPurposes, descriptor } from './vocab.js';
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
  const add = (label) => m.set(label, (m.get(label) || 0) + 1);
  for (const e of entries) {
    if (e.status === 'declined') add('Declined by you');
    else if (e.status === 'withdrawn') add('Withdrew');
    else if (e.status === 'expired') add('Fee expired');
    else if (e.status === 'removed') add(e.removed_reason ? descriptor(WAITLIST_REMOVED_REASON, e.removed_reason).label : 'Removed');
  }
  return [...m].map(([label, value]) => ({ label, value }));
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
