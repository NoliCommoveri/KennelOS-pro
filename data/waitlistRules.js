// waitlistRules.js — the waitlist rules engine (Waitlist Spec §6; End-State guide
// §29). PURE functions over plain records: no Dexie, no DOM, no clock (callers pass
// `today` as a YYYY-MM-DD string), so every rule is unit-tested in
// tests/waitlistRules.test.js with no database.
//
// What this module decides, and what it deliberately does NOT store:
//  - POSITION is derived, never stored (§6.1). When someone ahead is placed or
//    removed, everyone behind moves up with nothing to write.
//  - PASSES are counted from offers' frozen `counts_as_pass` (§6.4), never kept as
//    a counter on the entry.
//  - Eligibility (§6.2) is computed per litter / per pup at the moment it's needed.
// The repos store; the pages call these functions to decide what to write.
import { addDaysToYMD } from './dateUtils.js';
import { WAITLIST_OPEN_STATUSES } from './vocab.js';

// --- Config (Spec §4.6) -------------------------------------------------------

// Defaults for Kennel.waitlist_config. Missing keys fall back here, so a kennel
// that predates the waitlist (no config at all) just works.
export const WAITLIST_CONFIG_DEFAULTS = Object.freeze({
  fee_amount: null,
  fee_credit_policy: 'credited_to_purchase',
  fee_due_days: null,
  payment_instructions: '',
  max_passes: 2,
  respond_days: 3,
  no_response_counts_as_pass: true,
  color_matching: false,
  checkin_months: 6
});

// The effective config for a kennel record (or null/undefined → all defaults).
// A null/blank stored value counts as "not set" so the default applies.
export function waitlistConfig(kennel) {
  const stored = (kennel && kennel.waitlist_config) || {};
  const out = { ...WAITLIST_CONFIG_DEFAULTS };
  for (const [k, v] of Object.entries(stored)) {
    if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

// --- Small helpers -------------------------------------------------------------

const key = (s) => String(s ?? '').trim().toLowerCase();

// "Is there a value": treats null/undefined/'' (and NaN) as unset, but 0 as set —
// a program fee_override of 0 means WAIVED, not "use the normal fee".
const isSet = (v) => v !== null && v !== undefined && v !== '' && !Number.isNaN(v);

const programOf = (entry, programsById) =>
  (entry && entry.waitlist_program_id && programsById && programsById.get(entry.waitlist_program_id)) || null;

// The fee a family owes: the program's override when set (0 = waived), else the
// kennel's normal fee. null = no fee configured.
export function feeForEntry(config, program) {
  if (program && isSet(program.fee_override)) return Number(program.fee_override);
  return isSet(config.fee_amount) ? Number(config.fee_amount) : null;
}

export function isFeeWaived(config, program) {
  return feeForEntry(config, program) === 0;
}

// Pay-by date for a family approved on `approvedDate`, or null when the kennel sets
// no fee window (then nothing ever expires).
export function feeDueDate(approvedDate, config) {
  if (!approvedDate || !isSet(config.fee_due_days)) return null;
  return addDaysToYMD(approvedDate, Number(config.fee_due_days));
}

// The respond-by date for an offer made on `offeredDate` — the program's longer
// window when it sets one (§7), else the kennel's.
export function respondByDate(offeredDate, config, program) {
  const days = program && isSet(program.respond_days_override)
    ? Number(program.respond_days_override)
    : Number(config.respond_days);
  return addDaysToYMD(offeredDate, days);
}

// --- Position (Spec §6.1) -------------------------------------------------------

// The date an entry is ordered by: her manual override, else the fee date. A
// fee-waived entry is anchored at its approval date (§5.3); the fee-received action
// stamps fee_received_date with it, and approved_date stays as a last resort so an
// active entry always has an anchor.
export function anchorDate(entry) {
  return entry.position_anchor_date || entry.fee_received_date || entry.approved_date || '';
}

export function isMovedByBreeder(entry) {
  return Boolean(entry.position_anchor_date);
}

// Priority group: 0 = an `ahead` program, 1 = everyone else. A program applies
// while it's linked, archived or not — archiving a program must not silently
// reorder the families already in it.
function priorityGroup(entry, programsById) {
  const p = programOf(entry, programsById);
  return p && p.priority === 'ahead' ? 0 : 1;
}

// Total order: priority group, anchor date, approved_date, created_at, then id so
// two identical rows can never swap places between renders.
export function compareEntries(a, b, programsById) {
  return (priorityGroup(a, programsById) - priorityGroup(b, programsById))
    || anchorDate(a).localeCompare(anchorDate(b))
    || (a.approved_date || '').localeCompare(b.approved_date || '')
    || (a.created_at || '').localeCompare(b.created_at || '')
    || String(a.id).localeCompare(String(b.id));
}

// Is this entry ON the list (the rolling list's members)?
export const isOnList = (entry) => Boolean(entry) && !entry.is_archived && entry.status === 'active';

// The rolling list for ONE kennel, in order. Callers pass every entry; this keeps
// the active, non-archived ones for `kennelId`.
export function rankedList(entries, kennelId, programsById = new Map()) {
  return entries
    .filter((e) => isOnList(e) && e.kennel_id === kennelId)
    .sort((a, b) => compareEntries(a, b, programsById));
}

// Map entryId → overall position (1-based) on that kennel's list.
export function overallPositions(entries, kennelId, programsById = new Map()) {
  const out = new Map();
  rankedList(entries, kennelId, programsById).forEach((e, i) => out.set(e.id, i + 1));
  return out;
}

// --- Availability + preference matching (Spec §0, §6.2) ------------------------

// Sale statuses that free a pup back up. Any other non-archived sale (open OR
// delivered) means the pup is spoken for.
const RELEASING_SALE_STATUSES = ['returned', 'cancelled'];

// Is this pup still available to offer? Kept-back (`keeping`), already placed,
// deceased, archived, or carrying a live Sale → no. Unset/`undecided`/`available`
// disposition → yes (keeping a pup is an explicit choice; Spec §0).
export function isPupAvailable(dog, sales = []) {
  if (!dog || dog.is_archived) return false;
  if (dog.status === 'deceased') return false;
  if (dog.disposition === 'keeping' || dog.disposition === 'placed') return false;
  return !sales.some((s) => s.dog_id === dog.id && !s.is_archived && !RELEASING_SALE_STATUSES.includes(s.status));
}

// The family's listed colors as an array of lowercase tokens. Stored as an array,
// but tolerate a comma-separated string (CSV import / hand entry).
export function prefColorTokens(entry) {
  const raw = entry.pref_colors;
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  return list.map(key).filter(Boolean);
}

// Does one pup match one family's preferences? Each unset preference matches
// anything, and so does an unset fact on the pup (a pup with no intended placement
// or no breed recorded matches any).
export function pupMatchesPrefs(entry, dog, config = WAITLIST_CONFIG_DEFAULTS) {
  const sex = entry.pref_sex || 'any';
  if (sex !== 'any' && dog.sex !== sex) return false;

  // Breed (Spec §0): a full preference, case-insensitive + trimmed like every
  // other free-text match in the app.
  if (key(entry.pref_breed) && key(dog.breed) && key(entry.pref_breed) !== key(dog.breed)) return false;

  if (entry.pref_placement_type && dog.intended_placement && entry.pref_placement_type !== dog.intended_placement) return false;

  // Color decides eligibility only when she's turned it on (Q4). Then any one of
  // the family's colors appearing in the pup's color_markings is a match.
  if (config.color_matching) {
    const wanted = prefColorTokens(entry);
    if (wanted.length) {
      const markings = key(dog.color_markings);
      if (!wanted.some((c) => markings.includes(c))) return false;
    }
  }
  return true;
}

// --- Eligibility (Spec §6.2, §6.3) ---------------------------------------------

export function isPaused(entry, today) {
  return Boolean(entry.paused_until) && entry.paused_until >= today;
}

// Is the family listening for this litter? Everyone is, unless they've chosen
// listen-only (`selected`) — then only for the litters / pairings they picked.
export function isListeningFor(entry, litter) {
  if ((entry.listen_mode || 'all') !== 'selected') return true;
  if ((entry.listen_litter_ids || []).includes(litter.id)) return true;
  return Boolean(litter.pairing_id) && (entry.listen_pairing_ids || []).includes(litter.pairing_id);
}

// The pups in `litter` this family could be offered right now: [] when the family
// isn't eligible at all. `pups` may be every dog — only this litter's are used.
export function eligiblePupsFor(entry, litter, pups, sales, { today, config = WAITLIST_CONFIG_DEFAULTS } = {}) {
  if (!isOnList(entry) || entry.kennel_id !== litter.kennel_id) return [];
  if (isPaused(entry, today)) return [];
  if (!isListeningFor(entry, litter)) return [];
  return pups.filter((d) => d.litter_id === litter.id && isPupAvailable(d, sales) && pupMatchesPrefs(entry, d, config));
}

// The litter's queue: every eligible family in list order, each with the pups
// available to them and their position FOR THIS LITTER (the number the status
// page shows, §6.1).
export function litterQueue(entries, litter, pups, sales, { today, config = WAITLIST_CONFIG_DEFAULTS, programsById = new Map() } = {}) {
  const queue = [];
  for (const entry of rankedList(entries, litter.kennel_id, programsById)) {
    const eligibleDogs = eligiblePupsFor(entry, litter, pups, sales, { today, config });
    if (eligibleDogs.length) queue.push({ entry, eligibleDogs, litterPosition: queue.length + 1 });
  }
  return queue;
}

// Offers that have already used a family's turn on a litter. A voided offer
// doesn't (she cancelled it), so that family can be offered again.
const SPENT_OUTCOMES = ['open', 'accepted', 'passed', 'no_response'];

export function hasOpenOffer(offers, litterId) {
  return offers.some((o) => !o.is_archived && o.litter_id === litterId && o.outcome === 'open');
}

// Who's next for this litter (Spec §6.5, sequential picks): the first family in
// the litter queue whose turn on this litter hasn't been spent. Returns null when
// an offer is already open on the litter (one at a time), or nobody is left.
// Skipped families (paused, listen-only, no matching pup) have nothing recorded
// against them — they simply aren't in the queue.
// Has this family already used its turn on this litter (an offer that wasn't voided)?
export function turnSpent(offers, litterId, entryId) {
  return offers.some((o) => !o.is_archived && o.litter_id === litterId && o.entry_id === entryId && SPENT_OUTCOMES.includes(o.outcome));
}

export function nextFamilyForLitter(entries, offers, litter, pups, sales, opts = {}) {
  if (hasOpenOffer(offers, litter.id)) return null;
  const spent = new Set(
    offers.filter((o) => !o.is_archived && o.litter_id === litter.id && SPENT_OUTCOMES.includes(o.outcome)).map((o) => o.entry_id)
  );
  return litterQueue(entries, litter, pups, sales, opts).find((q) => !spent.has(q.entry.id)) || null;
}

// --- Passes and removal (Spec §6.4) ---------------------------------------------

// Whether an offer outcome counts as a pass, decided ONCE when it's recorded and
// frozen into offer.counts_as_pass (a later rule change never rewrites history).
export function countsAsPass(outcome, { config = WAITLIST_CONFIG_DEFAULTS, program = null } = {}) {
  if (program && program.passes_count === false) return false;
  if (outcome === 'passed') return true;
  if (outcome === 'no_response') return Boolean(config.no_response_counts_as_pass);
  return false; // open / accepted / voided
}

const entryOffers = (entry, offers) => offers.filter((o) => o.entry_id === entry.id && !o.is_archived);

export function passesUsed(entry, offers) {
  return entryOffers(entry, offers).filter((o) => o.counts_as_pass === true).length;
}

// Should this active entry now be removed for reaching the pass limit?
export function shouldRemoveForPasses(entry, offers, config = WAITLIST_CONFIG_DEFAULTS) {
  return isOnList(entry) && passesUsed(entry, offers) >= Number(config.max_passes);
}

export const REMOVAL_UNDO_DAYS = 7;

// The 7-day undo on an automatic second-pass removal, worked out from removed_date
// (nothing extra stored).
export function canUndoRemoval(entry, today) {
  if (!entry || entry.status !== 'removed' || entry.removed_reason !== 'second_pass' || !entry.removed_date) return false;
  return today <= addDaysToYMD(entry.removed_date, REMOVAL_UNDO_DAYS);
}

// The offer an undo forgives: the most recent counted pass. Undo sets its
// counts_as_pass to false, or the entry would be removed again at once (Spec §0).
export function passToForgive(entry, offers) {
  const counted = entryOffers(entry, offers).filter((o) => o.counts_as_pass === true);
  counted.sort((a, b) => (b.outcome_date || '').localeCompare(a.outcome_date || '')
    || (b.created_at || '').localeCompare(a.created_at || ''));
  return counted[0] || null;
}

// --- Deadlines needing her confirmation (Spec §6.5, W1) -------------------------

// Open offers whose respond-by date has passed — Today suggests "record no response".
export function overdueOffers(offers, today) {
  return offers.filter((o) => !o.is_archived && o.outcome === 'open' && o.respond_by_date && o.respond_by_date < today);
}

// Approved entries whose pay-by date has passed — Today suggests "mark expired".
export function overdueFees(entries, today) {
  return entries.filter((e) => !e.is_archived && e.status === 'approved' && e.fee_due_date && e.fee_due_date < today);
}

// --- Contact.waitlist_status, kept in step (Spec §0, §4.1) ---------------------

// The value a contact's waitlist_status should hold given all their entries:
// `active` while any run is still open; `fulfilled` when their latest run ended
// placed; otherwise `none`. Archived entries are ignored.
export function deriveContactWaitlistStatus(entries) {
  const live = entries.filter((e) => !e.is_archived);
  if (live.some((e) => WAITLIST_OPEN_STATUSES.includes(e.status))) return 'active';
  const latest = [...live].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0];
  return latest && latest.status === 'placed' ? 'fulfilled' : 'none';
}

// --- Applicant ↔ Contact matching (Spec §5.2) ------------------------------------

// Existing contacts that might be this applicant — OFFERED at approval, never
// applied automatically (CSV import's rule: email is the natural key; a name is a
// hint). Email matches first, then name-only matches, archived contacts excluded.
export function contactMatches(application, contacts) {
  const email = key(application && application.email);
  const name = key(application && application.name);
  const live = contacts.filter((c) => !c.is_archived);
  const byEmail = email ? live.filter((c) => key(c.email) === email) : [];
  const seen = new Set(byEmail.map((c) => c.id));
  const byName = name ? live.filter((c) => !seen.has(c.id) && key(c.name) === name) : [];
  return [
    ...byEmail.map((contact) => ({ contact, reason: 'email' })),
    ...byName.map((contact) => ({ contact, reason: 'name' }))
  ];
}

// The family's display name: the linked contact's, else the applicant's own.
export function entryName(entry, contact) {
  return (contact && contact.name) || (entry.application && entry.application.name) || 'Unnamed applicant';
}

// --- The public list (Spec §15.3) ------------------------------------------------

// "Jane S." from "Jane Smith" (first word + last word's initial). One word stays as
// is; a blank name becomes "Family". Contact details never appear (§15.3).
export function publicName(fullName) {
  const words = String(fullName ?? '').trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (!words.length) return 'Family';
  if (words.length === 1) return words[0];
  const last = words[words.length - 1];
  return `${words[0]} ${[...last][0].toUpperCase()}.`;
}

// The public list for one kennel: the allow-listed fields only (position, first
// name + last initial, sex preference, date added). Positions are the REAL §6.1
// positions; paused families are left out and their numbers skipped (#1, #2, #4),
// so nobody's public number shifts when a pause ends (decided 2026-10-06).
// Listen-only families show, with no marker. Programs, notes and money never do.
// `nameOf(entry)` returns the family's full name.
export function publicList(entries, kennelId, programsById = new Map(), { today, nameOf = (e) => entryName(e, null) } = {}) {
  return rankedList(entries, kennelId, programsById)
    .map((e, i) => ({ entry: e, position: i + 1 }))
    .filter(({ entry }) => !isPaused(entry, today))
    .map(({ entry, position }) => ({
      position,
      name: publicName(nameOf(entry)),
      pref_sex: entry.pref_sex || 'any',
      added: anchorDate(entry)
    }));
}

const PUBLIC_SEX = { male: 'Male', female: 'Female', any: 'Either' };

// The public list as plain text for a Facebook post or website (the W1 stand-in
// for the public link). `fmtDate` formats a YYYY-MM-DD for display.
export function publicListText(rows, { kennelName = '', today = '', fmtDate = (d) => d } = {}) {
  const head = `${kennelName ? `${kennelName} waitlist` : 'Waitlist'}${today ? ` (updated ${fmtDate(today)})` : ''}`;
  if (!rows.length) return `${head}\nNobody is on the list yet.`;
  const lines = rows.map((r) => `#${r.position} ${r.name} · ${PUBLIC_SEX[r.pref_sex] || 'Either'} · added ${fmtDate(r.added)}`);
  const gaps = rows.some((r, i) => r.position !== i + 1);
  return [head, '', ...lines, ...(gaps ? ['', 'A skipped number is a family who has paused. They keep their place.'] : [])].join('\n');
}
