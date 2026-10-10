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
import { addDaysToYMD, addMonthsToYMD } from './dateUtils.js';
import { WAITLIST_OPEN_STATUSES, WAITLIST_READY_TIMING, WAITLIST_AUTO_OFFER_TRIGGER, WAITLIST_PREF_SEX, PLACEMENT_PURPOSE, REGISTRATION_TYPE, cleanPurposes, registrationsForPurposes, RELEASED_SALE_STATUSES, isLostSale, descriptor } from './vocab.js';

// --- Config (Spec §4.6) -------------------------------------------------------

// Defaults for Kennel.waitlist_config. Missing keys fall back here, so a kennel
// that predates the waitlist (no config at all) just works.
export const WAITLIST_CONFIG_DEFAULTS = Object.freeze({
  fee_amount: null,
  fee_credit_policy: 'credited_to_purchase',
  fee_due_days: null,
  payment_instructions: '',
  max_passes: 2,
  respond_days: 3, // days to accept AND send the deposit (§6.5)
  online: false, // her list is published online (W2 Plan §5; only where isWaitlistOnlineOffered)
  online_form: false, // she takes applications through the online form (W2 Plan step 4)
  auto_offer_on: [], // which closings offer the next family by themselves (WAITLIST_AUTO_OFFER_TRIGGER); none = she offers
  no_response_counts_as_pass: true,
  color_matching: false,
  checkin_months: 6,
  soon_notice_text: '', // blank = SOON_NOTICE_DEFAULT
  public_intro_text: '', // blank = PUBLIC_INTRO_DEFAULT (the message under her public list's heading)
  email_templates: null, // her wording per email kind (waitlistEmails.js; W2 step 6); null/blank = the defaults
  email_reminders: true, // the server's reminder and "Ready now?" emails while the list is online (W2 step 7)
  pass_reasons: null, // her reasons for a pass (Spec §16.5); null = DEFAULT_PASS_REASONS
  pass_other: true, // also offer "Other" with a short text box (Q33)
  show_upcoming: null, // pairings and early litters online (Spec §16.4); null = all off, see showUpcoming
  online_since: null, // the day her list last went online (set by the Online list card); the ready check starts there
  ready_no_answer: 'keep_paused', // "Ready now?" unanswered (Spec §16.7): WAITLIST_READY_NO_ANSWER
  ready_answer_days: 14, // remove_after: days to answer; keep_paused: when Today flags them
  facebook_button: false, // "Message us on Facebook" on status pages (Spec §11, W2 step 8); needs facebook_page
  facebook_page: '' // her Facebook Page link, as she typed it (facebook.com/… or m.me/…)
});

// Her Facebook Page link → the Messenger link the status page's button opens
// (https://m.me/<page>), or null when it isn't a facebook.com or m.me address
// naming a Page. A profile.php?id= link uses the id.
const FACEBOOK_NOT_A_PAGE = new Set([
  'groups', 'events', 'share', 'sharer', 'sharer.php', 'watch', 'marketplace', 'gaming', 'login', 'login.php',
  'home.php', 'search', 'photo', 'photo.php', 'story.php', 'permalink.php', 'messages', 'help', 'policies', 'pages'
]);
export function messengerLink(raw) {
  let text = String(raw ?? '').trim();
  if (!text) return null;
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try { url = new URL(text); } catch { return null; }
  let host = url.hostname.toLowerCase();
  if (/^(www|m|web|business)\.facebook\.com$/.test(host)) host = 'facebook.com';
  else if (host === 'www.m.me') host = 'm.me';
  if (host !== 'facebook.com' && host !== 'm.me') return null;
  let page = url.pathname.split('/').filter(Boolean)[0] || '';
  if (host === 'facebook.com' && page.toLowerCase() === 'profile.php') page = url.searchParams.get('id') || '';
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(page) || FACEBOOK_NOT_A_PAGE.has(page.toLowerCase())) return null;
  return `https://m.me/${page}`;
}

// The three stages she can show before picks open (Spec §16.4), each on the public
// list and on family pages separately. All off unless she switches one on.
export const UPCOMING_STAGES = Object.freeze([
  { value: 'planned_pairings', label: 'Planned pairings' },
  { value: 'pairings', label: 'Pairings (bred or confirmed pregnant)' },
  { value: 'early_litters', label: 'Whelped litters, picks not open yet' }
]);

// → { planned_pairings: { public, family }, pairings: {…}, early_litters: {…} }, all booleans.
export function showUpcoming(config) {
  const stored = config && typeof config.show_upcoming === 'object' && config.show_upcoming ? config.show_upcoming : {};
  return Object.fromEntries(UPCOMING_STAGES.map(({ value }) => [value, {
    public: stored[value]?.public === true, family: stored[value]?.family === true
  }]));
}

// The effective config for a kennel record (or null/undefined → all defaults).
// A null/blank stored value counts as "not set" so the default applies.
export function waitlistConfig(kennel) {
  const stored = (kennel && kennel.waitlist_config) || {};
  const out = { ...WAITLIST_CONFIG_DEFAULTS };
  for (const [k, v] of Object.entries(stored)) {
    if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  // auto_offer_on replaced the all-or-nothing auto_offer_next (2026-10-08). A kennel
  // saved with it on and never re-saved keeps every moment on.
  if (!Array.isArray(stored.auto_offer_on)) {
    out.auto_offer_on = stored.auto_offer_next === true ? WAITLIST_AUTO_OFFER_TRIGGER.map((t) => t.value) : [];
  }
  delete out.auto_offer_next;
  return out;
}

// One sentence for the pages: when the next family is offered by itself.
export function autoOfferSummary(config) {
  const on = WAITLIST_AUTO_OFFER_TRIGGER.filter((t) => autoOffers(config, t.value));
  if (!on.length) return 'When an offer closes, you offer the next family with "Offer to them".';
  if (on.length === WAITLIST_AUTO_OFFER_TRIGGER.length) return 'When an offer closes, the next family is offered automatically.';
  const words = { accepted: 'accepts a pup', passed: 'passes', no_response: 'lets the deadline pass', no_deposit: 'picks a pup but misses the deposit deadline', left: 'leaves the list' };
  const list = on.map((t) => words[t.value]);
  const joined = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`;
  return `The next family is offered automatically when the family holding the turn ${joined}; otherwise you offer them with "Offer to them".`;
}

// How an offer closing with `outcome` counts for automatic offers: a no response on
// an offer whose family had picked a pup is the missed deposit, `no_deposit`.
export function closingTrigger(offer, outcome) {
  return outcome === 'no_response' && offer && offer.chosen_dog_id ? 'no_deposit' : outcome;
}

// Does this moment (`accepted` / `passed` / `no_response` / `no_deposit` / `left` /
// `restored`) offer the next family by itself? Off for every moment unless she
// turned it on (§4.6).
export function autoOffers(config, trigger) {
  return Boolean(config && Array.isArray(config.auto_offer_on) && config.auto_offer_on.includes(trigger));
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

// Total order: priority group, anchor date, then the moment the fee was recorded
// (fee_received_at — so two families who paid on the same day stay in the order
// they paid, never the order they applied), approved_date, created_at, then id so
// two identical rows can never swap places between renders. An entry with no
// fee_received_at (imported, or recorded before it existed) sorts first among its
// same-day peers.
export function compareEntries(a, b, programsById) {
  return (priorityGroup(a, programsById) - priorityGroup(b, programsById))
    || anchorDate(a).localeCompare(anchorDate(b))
    || (a.fee_received_at || '').localeCompare(b.fee_received_at || '')
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

// A family's place for what they want (decided 2026-10-10), shown on their status
// page under their overall number: for each matching answer they narrowed, their
// place among the families who'd take such a pup too, and, when they narrowed more
// than one, their place for all of them together. A family ahead counts when it
// wants the same or wider on that answer (it would take every pup this family
// would): sex (Either covers both), breed (blank covers any), purposes (the
// registrations they fit; none chosen covers all) and, only with color matching on,
// colors (none covers any; else theirs include all of these). Her use case: #49
// overall, but 30 of the 48 ahead want only females and this family wants a male.
export const PREF_PLACE_FIELDS = Object.freeze(['sex', 'breed', 'purposes', 'colors']);

// Which matching answers a family narrowed (an answer left open is not narrowed).
export function narrowedPrefFields(entry, config = WAITLIST_CONFIG_DEFAULTS) {
  return PREF_PLACE_FIELDS.filter((f) => {
    if (f === 'sex') return (entry.pref_sex || 'any') !== 'any';
    if (f === 'breed') return Boolean(key(entry.pref_breed));
    if (f === 'purposes') return Boolean(registrationsForPurposes(entry.pref_purposes));
    return Boolean(config.color_matching) && prefColorTokens(entry).length > 0;
  });
}

// Does `other` want the same as `mine`, or more, on one matching answer?
export function prefCovers(field, other, mine) {
  if (field === 'sex') {
    const o = other.pref_sex || 'any';
    return o === 'any' || o === (mine.pref_sex || 'any');
  }
  if (field === 'breed') return !key(other.pref_breed) || key(other.pref_breed) === key(mine.pref_breed);
  if (field === 'purposes') {
    const o = registrationsForPurposes(other.pref_purposes);
    if (!o) return true;
    const m = registrationsForPurposes(mine.pref_purposes);
    return Boolean(m) && m.every((r) => o.includes(r));
  }
  const o = prefColorTokens(other);
  if (!o.length) return true;
  const m = prefColorTokens(mine);
  return m.length > 0 && m.every((c) => o.includes(c));
}

// Map entryId → { all?, sex?, breed?, purposes?, colors? }: their 1-based place
// counting only the families ahead who cover that answer (`all`: every answer they
// narrowed). Only the answers they narrowed are present, and `all` only when they
// narrowed two or more (with one, it's the same number). Empty for a family whose
// answers are all open: their overall place says it.
export function prefPlaces(entries, kennelId, programsById = new Map(), config = WAITLIST_CONFIG_DEFAULTS) {
  const ranked = rankedList(entries, kennelId, programsById);
  const out = new Map();
  ranked.forEach((e, i) => {
    const fields = narrowedPrefFields(e, config);
    const places = {};
    if (fields.length > 1) places.all = 1;
    for (const f of fields) places[f] = 1;
    for (let j = 0; j < i; j++) {
      const covers = fields.filter((f) => prefCovers(f, ranked[j], e));
      for (const f of covers) places[f]++;
      if (fields.length > 1 && covers.length === fields.length) places.all++;
    }
    out.set(e.id, places);
  });
  return out;
}

// --- Availability + preference matching (Spec §0, §6.2) ------------------------

// Dog statuses of a pup that has left: died, or gone home (a pet home, or an
// outside dog now). A pup that came back is a puppy again before it's offered.
const GONE_DOG_STATUSES = ['deceased', 'pet_home', 'external_reference'];

// Dispositions that take a pup out of the offers: kept back, already placed, or on
// a health hold (not sellable right now).
const UNOFFERED_DISPOSITIONS = ['keeping', 'placed', 'health_hold'];

// Is this pup still available to offer? Kept-back (`keeping`), already placed, on a
// health hold, deceased or gone home, archived, or carrying a live Sale → no. A sale that was
// returned, cancelled or voided (vocab.RELEASED_SALE_STATUSES) frees the pup; any
// other non-archived sale (open OR delivered) means it's spoken for.
// Unset/`undecided`/`available` disposition → yes (keeping a pup is an explicit
// choice; Spec §0).
export function isPupAvailable(dog, sales = []) {
  if (!dog || dog.is_archived) return false;
  if (GONE_DOG_STATUSES.includes(dog.status)) return false;
  if (UNOFFERED_DISPOSITIONS.includes(dog.disposition)) return false;
  return !sales.some((s) => s.dog_id === dog.id && !s.is_archived && !RELEASED_SALE_STATUSES.includes(s.status));
}

// --- A lost pup (Spec §16.11) ----------------------------------------------------
// A waitlist family whose pup is lost through no fault of theirs gets their place
// back. "Lost" is a sale VOIDED (the pup died or failed a health check before going
// home) or RETURNED for a health problem within the guarantee. Never a cancelled
// sale or a buyer's-choice return: the family backed out themselves.
export function restoresFamily(sale) {
  return isLostSale(sale) && !sale.is_archived;
}

// The waitlist family a lost sale belongs to, or null:
//  - { kind: 'placed', entry, offer }: they were placed with it (deposit in). `offer`
//    is the accepted offer for it (null on an entry placed some other way).
//  - { kind: 'picked', entry, offer }: they picked it and their turn is still open.
export function lostSaleFamily(sale, entries, offers) {
  if (!restoresFamily(sale)) return null;
  const live = (o) => !o.is_archived && o.sale_id === sale.id;
  const placed = entries.find((e) => !e.is_archived && e.status === 'placed' && e.placed_sale_id === sale.id);
  if (placed) {
    const offer = offers.find((o) => live(o) && o.entry_id === placed.id && o.outcome === 'accepted')
      || offers.find((o) => !o.is_archived && o.entry_id === placed.id && o.outcome === 'accepted' && o.chosen_dog_id === sale.dog_id)
      || null;
    return { kind: 'placed', entry: placed, offer };
  }
  const picked = offers.find((o) => live(o) && o.outcome === 'open' && o.chosen_dog_id);
  const entry = picked && entries.find((e) => e.id === picked.entry_id && !e.is_archived && e.status === 'active');
  return entry ? { kind: 'picked', entry, offer: picked } : null;
}

// Litters whose deposits were planned to open by `today` (Spec §16.8): born
// (not expected, sold or closed), `accept_deposits_date` on or before today,
// picks not open, at least one pup available. Today suggests Open picks for each;
// nothing opens by itself.
export function depositsDueLitters(litters, pups, sales, today) {
  return litters.filter((l) => !l.is_archived && ['whelped', 'weaning', 'ready'].includes(l.status)
    && l.accept_deposits_date && l.accept_deposits_date <= today && !l.picks_opened_date
    && pups.some((d) => d.litter_id === l.id && isPupAvailable(d, sales)));
}

// Is a family's place number hidden from them? Only during their turn (decided
// 2026-10-08; "It's your turn!" instead). Since 2026-10-10 a turn they passed on
// or let lapse hides nothing: their page shows their number and the public list
// shows their row as usual. The public list keeps the row of a family holding a
// turn, number and all, but shows "Currently deciding" for the name (publicList
// `deciding`), so a family waiting below can't tell whom to press.
// → null | { reason: 'turn' }
export function placeHidden(entry, offers = []) {
  return offers.some((o) => o.entry_id === entry.id && !o.is_archived && o.outcome === 'open') ? { reason: 'turn' } : null;
}

// "A litter you match was born" / "Review your preferences" (Spec §16.6, Q30, Q34).
// For a born litter whose picks aren't open yet, with pups available: each active
// family on its kennel's list, not paused or held, gets `match` when they're
// eligible now, else `review` when they'd be eligible with All litters and open
// answers, with `why`: what narrows them ('listen', then the matching answers that
// rule out some of these pups: 'sex', 'breed', 'purposes', 'colors'). Derived,
// nothing stored. → [{ entry, kind: 'match' | 'review', why: [] }]
export const WHELP_NOTE_FIELDS = Object.freeze([
  { why: 'sex', open: { pref_sex: 'any' } },
  { why: 'breed', open: { pref_breed: '' } },
  { why: 'purposes', open: { pref_purposes: [] } },
  { why: 'colors', open: { pref_colors: [] } }
]);
export function isWhelpNoteLitter(litter) {
  return Boolean(litter) && !litter.is_archived && ['whelped', 'weaning', 'ready'].includes(litter.status) && !litter.picks_opened_date;
}
export function whelpNotes(entries, litter, pups, sales = [], { today, config = WAITLIST_CONFIG_DEFAULTS } = {}) {
  if (!isWhelpNoteLitter(litter)) return [];
  const available = pups.filter((d) => d.litter_id === litter.id && isPupAvailable(d, sales));
  if (!available.length) return [];
  const out = [];
  for (const entry of entries) {
    if (entry.is_archived || entry.status !== 'active' || entry.kennel_id !== litter.kennel_id || isPaused(entry, today, config)) continue;
    if (eligiblePupsFor(entry, litter, available, sales, { today, config }).length) {
      out.push({ entry, kind: 'match', why: [] });
      continue;
    }
    const why = [];
    if (!isListeningFor(entry, litter)) why.push('listen');
    for (const f of WHELP_NOTE_FIELDS) {
      const narrowed = available.some((d) => !pupMatchesPrefs(entry, d, config) && pupMatchesPrefs({ ...entry, ...f.open }, d, config));
      if (narrowed) why.push(f.why);
    }
    // No one answer rules a pup out by itself (two together do): name each answer
    // that, on its own, rules out at least one of these pups.
    if (!why.length) {
      const only = (f) => Object.assign({ ...entry }, ...WHELP_NOTE_FIELDS.filter((g) => g !== f).map((g) => g.open));
      for (const f of WHELP_NOTE_FIELDS) if (available.some((d) => !pupMatchesPrefs(only(f), d, config))) why.push(f.why);
    }
    if (why.length) out.push({ entry, kind: 'review', why });
  }
  return out;
}

// The breeds a family can ask for on this kennel's list (decided 2026-10-06: a
// dropdown, never free text, so a misspelling or shorthand can't make a family
// match no pup). The breeds of the kennel's own non-archived dogs — what its pups
// are actually recorded as — plus the kennel's preferred breeds, deduped
// case-insensitively (a dog's spelling wins), sorted.
export function kennelBreeds(kennel, dogs = []) {
  if (!kennel) return [];
  const seen = new Map();
  const add = (raw) => {
    const b = String(raw ?? '').trim();
    if (b && !seen.has(key(b))) seen.set(key(b), b);
  };
  for (const d of dogs) if (!d.is_archived && d.kennel_id === kennel.id) add(d.breed);
  for (const b of kennel.preferred_breeds || []) add(b);
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

// The kennel's own spelling of `value` (case-insensitive, trimmed), or null when
// it isn't one of `breeds`. Blank → '' (any breed).
export function resolveBreed(value, breeds) {
  const k = key(value);
  if (!k) return '';
  return breeds.find((b) => key(b) === k) || null;
}

// The family's listed colors as an array of lowercase tokens. Stored as an array,
// but tolerate a comma-separated string (CSV import / hand entry).
export function prefColorTokens(entry) {
  const raw = entry.pref_colors;
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  return list.map(key).filter(Boolean);
}

// Does one pup match one family's preferences? Each unset preference matches
// anything, and so does an unset fact on the pup (a pup with no intended registration
// or no breed recorded matches any).
export function pupMatchesPrefs(entry, dog, config = WAITLIST_CONFIG_DEFAULTS) {
  const sex = entry.pref_sex || 'any';
  if (sex !== 'any' && dog.sex !== sex) return false;

  // Breed (Spec §0): a full preference, case-insensitive + trimmed like every
  // other free-text match in the app.
  if (key(entry.pref_breed) && key(dog.breed) && key(entry.pref_breed) !== key(dog.breed)) return false;

  // Purposes (vocab PLACEMENT_PURPOSE): the pup's intended registration must be
  // one the family's purposes fit (pet → Limited/None, show → Full, …).
  const accepted = registrationsForPurposes(entry.pref_purposes);
  if (accepted && dog.intended_registration && !accepted.includes(dog.intended_registration)) return false;

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

// Her own pause (paused_until, inclusive).
export function isManuallyPaused(entry, today) {
  return Boolean(entry.paused_until) && entry.paused_until >= today;
}

// The readiness hold (Spec §15.8): a family who said they won't be ready to buy
// ASAP isn't offered pups until `hold_months` after their fee was received
// (or, with no fee, after approval). DERIVED, never stored: change their answer, or
// record the fee, and the date follows. Returns the YYYY-MM-DD they're back in
// contention, or null for no hold (ASAP / not answered / no anchor date yet).
export function readyFromDate(entry) {
  const months = WAITLIST_READY_TIMING.find((t) => t.value === entry.ready_timing)?.hold_months || 0;
  const anchor = entry.fee_received_date || entry.approved_date;
  return months && anchor ? addMonthsToYMD(anchor, months) : null;
}

// "Ready now?" (Spec §16.7): when a readiness hold ends, the family is asked. It
// applies only to a list that's online, and only to holds ending while it is (both
// decided 2026-10-08), so an offline list, and a hold that ended before she put the
// list online, keep the plain rule: the hold ends on its date. `ready_check` on the
// entry (private) holds their answer, or `ask_from` when she undid a removal for no
// answer (the window starts again). Pure: entry + config + today.
// → null | { asked, answer_by, answer: 'yes' | 'no' | null }
export function readyCheck(entry, today, config) {
  if (!config || config.online !== true || !config.online_since) return null;
  const from = readyFromDate(entry);
  if (!from || today < from || from < config.online_since) return null;
  const rc = entry.ready_check || {};
  const asked = rc.ask_from && rc.ask_from > from ? rc.ask_from : from;
  const days = Math.max(1, Number(config.ready_answer_days) || WAITLIST_CONFIG_DEFAULTS.ready_answer_days);
  return {
    asked,
    answer_by: config.ready_no_answer === 'remove_after' ? addDaysToYMD(asked, days) : null,
    answer: rc.answer === 'yes' || rc.answer === 'no' ? rc.answer : null
  };
}

// Unanswered past her window under remove_after: her device removes them
// (removed_reason 'no_ready_answer', with the 7-day undo).
export function readyCheckLapsed(entry, today, config) {
  const rc = entry.status === 'active' && readyCheck(entry, today, config);
  return Boolean(rc && !rc.answer && rc.answer_by && today > rc.answer_by);
}

// Unanswered for longer than ready_answer_days under keep_paused: Today lists them.
export function readyCheckOverdue(entry, today, config) {
  const rc = entry.status === 'active' && readyCheck(entry, today, config);
  if (!rc || rc.answer || config.ready_no_answer !== 'keep_paused') return false;
  return today > addDaysToYMD(rc.asked, Math.max(1, Number(config.ready_answer_days) || WAITLIST_CONFIG_DEFAULTS.ready_answer_days));
}

// The readiness hold: before readyFromDate, and after it while "Ready now?" is
// unanswered (unless she chose to unpause as normal), or answered No with their
// pause request still waiting for her. Without `config` (or offline), the plain rule.
export function isReadyHeld(entry, today, config = null) {
  const from = readyFromDate(entry);
  if (!from) return false;
  if (today < from) return true;
  const rc = readyCheck(entry, today, config);
  if (!rc || rc.answer === 'yes') return false;
  if (rc.answer === 'no') return Boolean(entry.pause_request && !entry.pause_request.decided);
  return config.ready_no_answer !== 'unpause';
}

// Paused for any reason: her own pause or the readiness hold. Both mean the same
// thing everywhere (decided 2026-10-06): no offers, so no passes to use up; their
// place is kept; and they're left off the public list with their number skipped.
export function isPaused(entry, today, config = null) {
  return isManuallyPaused(entry, today) || isReadyHeld(entry, today, config);
}

// Is the family listening for this litter? Everyone is, unless they've chosen
// listen-only. `selected`: only litters by a sire OR out of a dam they picked.
// `except` (Spec §16.3): every litter but one by a sire OR out of a dam they
// listed. They pick parent dogs, never litters or pairings: which litters (and
// upcoming pairings) that covers is derived from the litter's own sire_id/dam_id.
export function isListeningFor(entry, litter) {
  const mode = entry.listen_mode || 'all';
  if (mode === 'all') return true;
  const hit = (Boolean(litter.sire_id) && (entry.listen_sire_ids || []).includes(litter.sire_id))
    || (Boolean(litter.dam_id) && (entry.listen_dam_ids || []).includes(litter.dam_id));
  return mode === 'except' ? !hit : hit;
}

// Is this a listen-only choice (anything but All litters)? An `except` with no
// parents listed skips nothing, so it counts as All.
export function isListenOnly(entry) {
  const mode = entry.listen_mode || 'all';
  if (mode === 'except') return Boolean((entry.listen_sire_ids || []).length || (entry.listen_dam_ids || []).length);
  return mode !== 'all';
}

// The litter and pairing statuses whose parents count as "live" for listen-only.
export const LISTEN_LIVE_LITTER = ['expected', 'whelped', 'weaning', 'ready'];
export const LISTEN_LIVE_PAIRING = ['planned', 'bred', 'confirmed_pregnant'];

// What a kennel has coming before picks open (Spec §16.4), one item per future
// litter: a pairing with no litter yet, an `expected` litter (shown with its
// pairing, decided 2026-10-08), or a whelped litter whose picks aren't open.
// Every stage, unfiltered: the projection applies her switches (showUpcoming).
// → [{ id, kind: 'planned_pairing' | 'pairing' | 'early_litter', stage, pairing,
//      litter, pairing_id, litter_id, sire_id, dam_id }]. `id` is the pairing's id
// when there is one (so "Not this litter" on it carries over to its litter),
// else the litter's; an early litter is always its litter's id.
export function upcomingItems(kennel, { litters = [], pairings = [] } = {}) {
  const own = (x) => !x.is_archived && x.kennel_id === kennel.id;
  const pairingsById = new Map(pairings.map((p) => [p.id, p]));
  const hasLitter = new Set(litters.filter((l) => !l.is_archived && l.pairing_id).map((l) => l.pairing_id));
  const out = [];
  for (const l of litters.filter((x) => own(x) && LISTEN_LIVE_LITTER.includes(x.status) && !x.picks_opened_date)) {
    const pairing = (l.pairing_id && pairingsById.get(l.pairing_id)) || null;
    const early = l.status !== 'expected';
    out.push({
      id: early ? l.id : (l.pairing_id || l.id), kind: early ? 'early_litter' : 'pairing', stage: early ? 'early_litters' : 'pairings',
      pairing, litter: l, pairing_id: l.pairing_id || null, litter_id: l.id, sire_id: l.sire_id || null, dam_id: l.dam_id || null
    });
  }
  for (const p of pairings.filter((x) => own(x) && LISTEN_LIVE_PAIRING.includes(x.status) && !hasLitter.has(x.id))) {
    const planned = p.status === 'planned';
    out.push({
      id: p.id, kind: planned ? 'planned_pairing' : 'pairing', stage: planned ? 'planned_pairings' : 'pairings',
      pairing: p, litter: null, pairing_id: p.id, litter_id: null, sire_id: p.sire_id || null, dam_id: p.dam_id || null
    });
  }
  const order = { early_litter: 0, pairing: 1, planned_pairing: 2 };
  const when = (x) => x.litter?.whelp_date || x.pairing?.expected_due_date || x.pairing?.planned_date || '9999';
  return out.sort((a, b) => order[a.kind] - order[b.kind] || when(a).localeCompare(when(b)) || String(a.id).localeCompare(String(b.id)));
}

// The parent dogs a family can pick for listen-only (Spec §15.7 item 1): this
// kennel's active breeding dogs of that sex, plus any parent of one of its live
// litters or upcoming pairings (an outside stud included), plus anything already
// in `selected` (so a retired dog a family picked never silently drops off).
// Her Edit form and the status page (W2 step 5) offer exactly these.
// → { sires: [dog], dams: [dog] }, each sorted by call name.
export function listenParentChoices(kennel, { dogs = [], litters = [], pairings = [], selectedSires = [], selectedDams = [] } = {}) {
  const live = (side) => new Set([
    ...litters.filter((l) => !l.is_archived && l.kennel_id === kennel.id && LISTEN_LIVE_LITTER.includes(l.status)).map((l) => l[side]),
    ...pairings.filter((p) => !p.is_archived && p.kennel_id === kennel.id && LISTEN_LIVE_PAIRING.includes(p.status)).map((p) => p[side])
  ].filter(Boolean));
  const pick = (sex, side, selected) => {
    const parents = live(side);
    return dogs
      .filter((d) => selected.includes(d.id) || (!d.is_archived && (parents.has(d.id)
        || (d.kennel_id === kennel.id && d.status === 'active_breeding' && d.sex === sex))))
      .sort((a, b) => (a.call_name || '').localeCompare(b.call_name || '') || String(a.id).localeCompare(String(b.id)));
  };
  return { sires: pick('male', 'sire_id', selectedSires), dams: pick('female', 'dam_id', selectedDams) };
}

// Is a family's own listen-only change wider or narrower (Spec §15.7 item 6,
// §16.3)? Wider (more `selected` parents, fewer `except` parents, or back to All
// litters) applies at once; narrower (leaving All, dropping a `selected` parent,
// adding an `except` one, or switching between `selected` and `except`) is a
// request she approves. An `except` with nobody listed is All.
// `next` is { listen_mode, listen_sire_ids, listen_dam_ids }. → 'same' | 'wider' | 'narrower'
export function listenChangeKind(entry, next) {
  const mode = (x) => (isListenOnly(x) ? x.listen_mode : 'all');
  const ids = (x) => new Set([...(x.listen_sire_ids || []).map((id) => `s:${id}`), ...(x.listen_dam_ids || []).map((id) => `d:${id}`)]);
  const [a, b] = [mode(entry), mode(next)];
  if (b === 'all') return a === 'all' ? 'same' : 'wider';
  if (a !== b) return 'narrower';
  const [before, after] = [ids(entry), ids(next)];
  const lost = [...before].some((x) => !after.has(x));
  const gained = [...after].some((x) => !before.has(x));
  if (b === 'except') return gained ? 'narrower' : lost ? 'wider' : 'same';
  return lost ? 'narrower' : gained ? 'wider' : 'same';
}

// The pups in `litter` this family could be offered right now: [] when the family
// isn't eligible at all. `pups` may be every dog — only this litter's are used.
export function eligiblePupsFor(entry, litter, pups, sales, { today, config = WAITLIST_CONFIG_DEFAULTS } = {}) {
  if (!isOnList(entry) || entry.kennel_id !== litter.kennel_id) return [];
  if (isPaused(entry, today, config)) return [];
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

// An open offer whose family has picked a pup but hasn't sent the deposit yet
// (Spec §6.5). The pick is held by a deposit-pending Sale (offer.sale_id); the
// offer only becomes `accepted`, and the turn only moves on, once the deposit is in.
export const isAwaitingDeposit = (o) => Boolean(o) && o.outcome === 'open' && Boolean(o.chosen_dog_id);

// The pups a family could switch their pick to: this litter's available pups that
// match their preferences, other than the one they hold now. Ignores list status on
// purpose — after the deposit the family is `placed`, and a switch is still allowed
// until the next family has been offered (see canSwitchAcceptedPick).
export function switchablePups(entry, litter, pups, sales, { currentDogId = null, config = WAITLIST_CONFIG_DEFAULTS } = {}) {
  return pups.filter((d) => d.litter_id === litter.id && d.id !== currentDogId
    && isPupAvailable(d, sales) && pupMatchesPrefs(entry, d, config));
}

// An ACCEPTED offer's pup can still be switched while nobody else has been offered
// a turn since (Spec §6.5; kennel-wide since turns, §16.1, because a later turn may
// have listed this litter's pups). An offer made later and then voided doesn't
// count — the turn never really moved on. `offers` are the kennel's.
export function canSwitchAcceptedPick(offer, offers) {
  if (!offer || offer.outcome !== 'accepted' || !offer.chosen_dog_id) return false;
  return !offers.some((o) => o.id !== offer.id && !o.is_archived && turnIdOf(o) !== turnIdOf(offer)
    && (o.kennel_id ? o.kennel_id === offer.kennel_id : o.litter_id === offer.litter_id)
    && o.outcome !== 'voided' && (o.created_at || '') > (offer.created_at || ''));
}

// Can this closed pass / no response be undone (Spec §6.4)? The family must still be
// on the list, or removed by THIS pass's second-pass removal within the undo window.
// Returns '' when it can, else the reason it can't.
export function undoPassBlocker(offer, entry, today) {
  if (!offer || !['passed', 'no_response'].includes(offer.outcome)) return 'Only a pass or a no response can be undone.';
  if (!entry) return 'That family no longer exists.';
  if (entry.is_archived) return 'That family\'s entry is archived.';
  if (entry.status === 'active') return '';
  if (entry.status === 'removed' && entry.removed_reason === 'second_pass') {
    return canUndoRemoval(entry, today) ? '' : 'Their removal can no longer be undone.';
  }
  return 'They\'re no longer on the list.';
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

// --- Pass reasons and "Not this litter" (Spec §16.2, §16.5) ----------------------
// A family passing on their status page (a whole turn, or a litter ahead of time)
// picks one of her reasons, and is shown that reason's message. Her own recorded
// passes and no response carry none (decided 2026-10-08).

export const PASS_REASON_TEXT_MAX = 200;
export const DEFAULT_PASS_REASONS = Object.freeze([
  { id: 'timing', label: 'The timing isn\'t right for us', message: 'Thank you for letting us know. You keep your place for future litters.' },
  { id: 'finances', label: 'Financial reasons', message: 'We appreciate your feedback. Please contact us if you\'d like to discuss options for payment plans on your next turn.' },
  { id: 'fit', label: 'These pups aren\'t the right fit for us', message: 'Thank you for letting us know. You keep your place for future litters.' }
]);
export const OTHER_PASS_REASON = Object.freeze({ id: 'other', label: 'Other', message: 'Thank you for letting us know. You keep your place for future litters.' });

// Her reasons, as families see them: [{ id, label, message }] (stored ones that
// have a label, else the defaults), plus Other when it's on.
export function passReasons(config) {
  const stored = Array.isArray(config?.pass_reasons) ? config.pass_reasons : null;
  const list = (stored || DEFAULT_PASS_REASONS)
    .filter((r) => r && r.id && String(r.label || '').trim() && r.id !== 'other')
    .map((r) => ({ id: String(r.id), label: String(r.label).trim(), message: String(r.message || '').trim() }));
  return config?.pass_other === false ? list : [...list, { ...OTHER_PASS_REASON }];
}

// A family's chosen reason, checked against her list: { id, label, text } or null.
// "Other" needs its text.
export function passReasonOf(config, choice) {
  if (!choice || typeof choice !== 'object') return null;
  const r = passReasons(config).find((x) => x.id === choice.id);
  if (!r) return null;
  const text = String(choice.text ?? '').trim().slice(0, PASS_REASON_TEXT_MAX);
  if (r.id === 'other' && !text) return null;
  return { id: r.id, label: r.label, text: r.id === 'other' ? text : '' };
}

// The family's "Not this litter" for this litter (or for the pairing it was born
// of: a pass made on an upcoming pairing carries over, §16.4), or null.
export function prepassFor(entry, litter) {
  return (entry.prepasses || []).find((p) => (p.litter_id && p.litter_id === litter.id)
    || (p.pairing_id && litter.pairing_id && p.pairing_id === litter.pairing_id)) || null;
}

// Split a turn's litters ([{ litter, eligibleDogs }]) into the ones to offer and
// the ones the family already passed on ahead of time (each with its prepass).
// Nothing counts until the turn comes (§16.2): the caller records the prepassed
// ones as passed then, and when NOTHING is left to offer the whole turn is passed
// at once, counting once (§16.1 rule 6).
export function splitPrepassed(entry, ls) {
  const offer = [];
  const prepassed = [];
  for (const x of ls) {
    const p = prepassFor(entry, x.litter);
    if (p) prepassed.push({ ...x, prepass: p }); else offer.push(x);
  }
  return { offer, prepassed };
}

// --- Turns (Spec §16.1, decided 2026-10-08; settles Q9) -------------------------
// One family holds a TURN at a time across the kennel's open litters, and the turn
// lists every pup they're eligible for in every litter with open picks. A turn is
// stored as one waitlist_offers row per litter, sharing `turn_id` and
// `respond_by_date`; an offer made before turns existed has no turn_id and is its
// own turn. Turns are spent per litter as before (turnSpent): passing a whole turn
// spends it on the litters it covered, and the family stays in line for any litter
// that opens later.

export const turnIdOf = (offer) => (offer && (offer.turn_id || offer.id)) || null;

// The rows of one turn.
export function turnOffers(offers, turnId) {
  return offers.filter((o) => !o.is_archived && turnIdOf(o) === turnId);
}

// The open turns in a kennel, oldest first: [{ id, entry_id, offers, respond_by_date }].
// After 5c there is at most one; offers made before it (one per litter) can leave
// several, which still close the usual way.
export function openTurns(offers, kennelId) {
  const groups = new Map();
  for (const o of offers) {
    if (o.is_archived || o.outcome !== 'open' || (kennelId && o.kennel_id !== kennelId)) continue;
    const id = turnIdOf(o);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(o);
  }
  return [...groups.entries()].map(([id, rows]) => ({
    id, entry_id: rows[0].entry_id, offers: rows,
    offered_date: rows.map((o) => o.offered_date || '').sort()[0] || null,
    respond_by_date: rows.map((o) => o.respond_by_date || '').sort().reverse()[0] || null
  })).sort((a, b) => String(a.offered_date).localeCompare(String(b.offered_date)));
}

// The litters a family could be offered in a turn now: each open-picks litter (not
// archived) where they're eligible for an available pup and haven't spent their
// turn. → [{ litter, eligibleDogs }] in litter-id order.
export function turnLittersFor(entry, offers, litters, pups, sales, { today, config = WAITLIST_CONFIG_DEFAULTS } = {}) {
  return litters
    .filter((l) => !l.is_archived && l.picks_opened_date && l.kennel_id === entry.kennel_id)
    .filter((l) => !turnSpent(offers, l.id, entry.id))
    .map((litter) => ({ litter, eligibleDogs: eligiblePupsFor(entry, litter, pups, sales, { today, config }) }))
    .filter((x) => x.eligibleDogs.length)
    .sort((a, b) => String(a.litter.id).localeCompare(String(b.litter.id)));
}

// Who gets the next turn (§16.1 rule 3): the highest-ranked family (§6.1) with at
// least one eligible, available pup in an open-picks litter they haven't spent a
// turn on. Recalculated each time, never a pointer down the list, so a family
// skipped on litter A (no match) comes first for litter B when B opens. Null while
// a turn is open in the kennel (one at a time) or when nobody is left.
// `litters` / `pups` may be every litter and dog; offers must be the kennel's.
// → { entry, litters: [{ litter, eligibleDogs }] }
export function nextTurn(entries, offers, litters, pups, sales, { today, config = WAITLIST_CONFIG_DEFAULTS, programsById = new Map(), kennelId = null } = {}) {
  const kid = kennelId || litters.find((l) => l.picks_opened_date)?.kennel_id || null;
  if (!kid || openTurns(offers, kid).length) return null;
  for (const entry of rankedList(entries, kid, programsById)) {
    const ls = turnLittersFor(entry, offers, litters.filter((l) => l.kennel_id === kid), pups, sales, { today, config });
    if (ls.length) return { entry, litters: ls };
  }
  return null;
}

// A litter whose picks open while a turn is open (§16.1 rule 5) joins that turn
// only when its holder is eligible for it and nobody ranked above them is (and
// hasn't spent a turn on it). Otherwise it waits for the next turn.
// → the holder's eligible pups in it ([] = it doesn't join).
export function joinsOpenTurn(turn, litter, entries, offers, pups, sales, { today, config = WAITLIST_CONFIG_DEFAULTS, programsById = new Map() } = {}) {
  if (!turn || turnOffers(offers, turn.id).some((o) => o.litter_id === litter.id)) return [];
  for (const entry of rankedList(entries, litter.kennel_id, programsById)) {
    if (turnSpent(offers, litter.id, entry.id) && entry.id !== turn.entry_id) continue;
    const eligible = eligiblePupsFor(entry, litter, pups, sales, { today, config });
    if (!eligible.length) continue;
    return entry.id === turn.entry_id ? eligible : [];
  }
  return [];
}

// Open turns whose respond-by date has passed: one per turn.
export function overdueTurns(offers, today) {
  return openTurns(offers, null).filter((t) => t.respond_by_date && t.respond_by_date < today);
}

// --- "Pups available soon" (Spec §15.5) -----------------------------------------

// The default "almost your turn" notice (her wording, decided 2026-10-06). The
// first line is the heading (the email subject); `[Kennel Name]` is filled in by
// soonNoticeText. She edits it in Waitlist settings (waitlist_config.soon_notice_text).
export const SOON_NOTICE_DEFAULT = "It's almost your turn!\n[Kennel Name] has puppies who will soon be searching for their furever families. You've been patiently waiting; based on your current waitlist position,  we anticipate being able to match you to your new furbaby this litter. Please be on the lookout for a communication with details about how to make your selection within the next few weeks.";

// The notice for one kennel, split for delivery: { subject, body, text }.
// `subject` is the first line, `body` the rest (an email shows the subject on its
// own), `text` the whole message (a status page shows it all; W2).
export function soonNoticeText(config, kennelName = '') {
  const text = String((config && config.soon_notice_text) || SOON_NOTICE_DEFAULT)
    .replace(/\[kennel name\]/gi, kennelName || 'Our kennel').trim();
  const [first, ...rest] = text.split('\n');
  return { subject: first.trim(), body: rest.join('\n').trim(), text };
}

// The message under the heading of her public list page (decided 2026-10-08), with
// [Kennel Name] filled in. She edits it on the Publish list page
// (waitlist_config.public_intro_text; blank = this default); it's published with
// the list (waitlistProjection kennel.intro).
export const PUBLIC_INTRO_DEFAULT = 'Our waitlist is a rolling list of approved applicants for [Kennel Name] puppies. When puppies are ready for selection, applicants whose preferences match an available pup will be contacted by [Kennel Name] through one of the following methods: email, SMS, and/or the messaging platform used to communicate with the applicant previously. Once contacted, you will have a limited time to respond before we move on to the next waiting family, so we encourage you to check back regularly to see your place in line.';
export const PUBLIC_INTRO_MAX = 2000;

export function publicIntroText(config, kennelName = '') {
  return String((config && config.public_intro_text) || PUBLIC_INTRO_DEFAULT)
    .replace(/\[kennel name\]/gi, kennelName || 'our kennel').trim().slice(0, PUBLIC_INTRO_MAX);
}

const openOfferEntryIds = (offers) =>
  new Set(offers.filter((o) => !o.is_archived && o.outcome === 'open').map((o) => o.entry_id));

// Who is within reach of a litter's pups: walking the litter queue in order (§6.2
// eligibility — paused, listening elsewhere, or no matching pup → skipped), each
// family takes up one of the litter's available pups until they run out. Families
// whose turn on this litter already closed (passed / no response) are left out.
// A family holding an open offer — on THIS litter or ANY other — still takes a
// pup's worth of room but is marked `inFlight`: they're mid-decision and must not
// get an "almost your turn" notice. `offers` must be ALL the kennel's offers so
// offers on other litters are seen. Returns [{ entry, eligibleDogs, soonPosition,
// inFlight }] in queue order; the notice goes to the rows with !inFlight.
export function soonFamiliesForLitter(entries, offers, litter, pups, sales, opts = {}) {
  let slots = pups.filter((d) => d.litter_id === litter.id && isPupAvailable(d, sales)).length;
  const here = offers.filter((o) => !o.is_archived && o.litter_id === litter.id);
  const closedHere = new Set(here.filter((o) => o.outcome !== 'open' && SPENT_OUTCOMES.includes(o.outcome)).map((o) => o.entry_id));
  const inFlight = openOfferEntryIds(offers);
  const queue = litterQueue(entries, litter, pups, sales, opts).filter((q) => !closedHere.has(q.entry.id));
  // An open offer here whose family has since dropped out of the queue (paused,
  // say) still holds this litter's turn, so it still takes a pup's worth of room.
  const queued = new Set(queue.map((q) => q.entry.id));
  slots -= here.filter((o) => o.outcome === 'open' && !queued.has(o.entry_id)).length;
  if (slots <= 0) return [];
  return queue.slice(0, slots).map((q, i) => ({ ...q, soonPosition: i + 1, inFlight: inFlight.has(q.entry.id) }));
}

// The same across several litters (the Waitlist page; pass the live litters of
// one kennel). One row per family, listing every litter they're within reach of,
// in list order. A family with an open offer anywhere is `inFlight` and gets no
// notice, but still took up room on each litter above. Returns [{ entry, inFlight,
// litters: [{ litter, eligibleDogs, soonPosition }] }].
export function soonFamiliesForKennel(entries, offers, litters, pups, sales, opts = {}) {
  const byEntry = new Map();
  for (const litter of litters) {
    if (litter.is_archived) continue;
    for (const row of soonFamiliesForLitter(entries, offers, litter, pups, sales, opts)) {
      if (!byEntry.has(row.entry.id)) byEntry.set(row.entry.id, { entry: row.entry, inFlight: row.inFlight, litters: [] });
      byEntry.get(row.entry.id).litters.push({ litter, eligibleDogs: row.eligibleDogs, soonPosition: row.soonPosition });
    }
  }
  const kennelId = litters.find((l) => !l.is_archived)?.kennel_id;
  const order = overallPositions(entries, kennelId, opts.programsById || new Map());
  return [...byEntry.values()].sort((a, b) => (order.get(a.entry.id) || 0) - (order.get(b.entry.id) || 0));
}

// --- Changes to the matching answers (Spec §15.9) --------------------------------

// The entry fields behind the answers that decide which pups a family is offered
// (or, for readiness, when). Families can't change these themselves (W2 makes it a
// request she approves); every change is kept in `pref_change_log` so changing an
// answer and changing it back is visible to her.
export const PREF_CHANGE_FIELDS = ['pref_sex', 'pref_breed', 'pref_purposes', 'pref_colors', 'ready_timing'];

const holdMonths = (v) => WAITLIST_READY_TIMING.find((t) => t.value === v)?.hold_months || 0;
// One field's value in a comparable form: blank/'any' alike, breed and colors
// case-insensitive, colors order-free.
function prefValueKey(field, v) {
  if (field === 'pref_colors') return [...new Set(prefColorTokens({ pref_colors: v }))].sort().join(',');
  if (field === 'pref_sex') return key(v) || 'any';
  if (field === 'pref_purposes') return cleanPurposes(v).join(',');
  return key(v);
}
// The value as stored in the log: colors as a clean array, the rest as a string
// ('' for blank; sex blank → 'any').
function prefLogValue(field, v) {
  if (field === 'pref_colors') return (Array.isArray(v) ? v : String(v ?? '').split(',')).map((c) => String(c).trim()).filter(Boolean);
  if (field === 'pref_sex') return String(v ?? '').trim() || 'any';
  if (field === 'pref_purposes') return cleanPurposes(v);
  return String(v ?? '').trim();
}

// The matching answers in words, for her history, the family-page warning and a
// family's request on Today (Spec §15.9). Plain text.
export const PREF_FIELD_LABEL = {
  pref_sex: 'Sex', pref_breed: 'Breed', pref_purposes: 'Looking for', pref_colors: 'Colors', ready_timing: 'Ready to buy'
};
export function prefValueText(field, v) {
  switch (field) {
    case 'pref_sex': return descriptor(WAITLIST_PREF_SEX, v || 'any').label;
    case 'pref_breed': return v || 'Any breed';
    case 'pref_purposes': return cleanPurposes(v).map((p) => descriptor(PLACEMENT_PURPOSE, p).label).join(', ') || 'Any';
    case 'pref_colors': return (Array.isArray(v) ? v : []).join(', ') || 'None';
    case 'ready_timing': return v ? descriptor(WAITLIST_READY_TIMING, v).label : 'Not answered';
    default: return String(v ?? '');
  }
}
// "Sex: Either → Female; Breed: Any breed → French Bulldog": only what changes.
export function prefChangeSummary(entry, changes) {
  return prefChangeLines(entry, changes || {}, { date: '' })
    .map((l) => `${PREF_FIELD_LABEL[l.field] || l.field}: ${prefValueText(l.field, l.from)} → ${prefValueText(l.field, l.to)}`)
    .join('; ');
}

// The log lines for `changes` written over `before`: one per tracked field present
// in `changes` whose value actually differs. `by` is 'breeder' (her edit or her
// import) or, from W2, 'request' (a family's request she approved).
export function prefChangeLines(before, changes, { date, by = 'breeder' } = {}) {
  return PREF_CHANGE_FIELDS
    .filter((f) => changes[f] !== undefined && prefValueKey(f, before[f]) !== prefValueKey(f, changes[f]))
    .map((f) => ({ date, field: f, from: prefLogValue(f, before[f]), to: prefLogValue(f, changes[f]), by }));
}

// Which tracked fields got NARROWER from `before` to `after`: the new answer rules
// out a pup (or, for readiness, a month) the old one allowed. Colors only count
// while color matching is on (otherwise they're notes).
export function narrowedPrefs(before, after, config = WAITLIST_CONFIG_DEFAULTS) {
  const narrower = (f) => {
    const a = prefValueKey(f, before[f]);
    const b = prefValueKey(f, after[f]);
    if (a === b) return false;
    if (f === 'ready_timing') return holdMonths(after[f]) > holdMonths(before[f]);
    if (f === 'pref_purposes') {
      // Narrower when some registration they accepted before isn't accepted now.
      const all = REGISTRATION_TYPE.map((r) => r.value);
      const now = registrationsForPurposes(after[f]) || all;
      return (registrationsForPurposes(before[f]) || all).some((r) => !now.includes(r));
    }
    if (f === 'pref_colors') {
      if (!config.color_matching || !b) return false;
      const now = b.split(',');
      return !a || a.split(',').some((c) => !now.includes(c));
    }
    const any = f === 'pref_sex' ? 'any' : '';
    return b !== any; // any → specific, or one specific → another
  };
  return PREF_CHANGE_FIELDS.filter((f) => after[f] !== undefined && narrower(f));
}

// What narrowing this family's answers would do right now (Spec §15.9, W1 warning):
// the fields narrowed, their open offers (which stay open: a change never closes
// one), and the litters they're next for now that they'd be skipped on after.
// `litters` are the kennel's live litters; the rest is as for nextFamilyForLitter.
export function prefChangeEffect(entry, after, { litters = [], entries = [], offers = [], pups = [], sales = [], today, config = WAITLIST_CONFIG_DEFAULTS, programsById = new Map() } = {}) {
  const narrowed = narrowedPrefs(entry, after, config);
  if (!narrowed.length) return { narrowed, openOffers: [], skippedLitters: [] };
  const changed = { ...entry, ...after };
  const others = entries.filter((x) => x.id !== entry.id);
  const opts = { today, config, programsById };
  const openOffers = offers.filter((o) => !o.is_archived && o.entry_id === entry.id && o.outcome === 'open');
  const skippedLitters = litters.filter((l) => {
    const now = nextFamilyForLitter([...others, entry], offers, l, pups, sales, opts);
    if (!now || now.entry.id !== entry.id) return false;
    const then = nextFamilyForLitter([...others, changed], offers, l, pups, sales, opts);
    return !then || then.entry.id !== entry.id;
  });
  return { narrowed, openOffers, skippedLitters };
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
  if (!entry || entry.status !== 'removed' || !['second_pass', 'no_ready_answer'].includes(entry.removed_reason) || !entry.removed_date) return false;
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

// "A***** K" from "Andrea Kim": a family she let list privately (`private_listing`,
// asked for on the application, approved by her). The first letter, then one
// asterisk per letter hidden, then the last initial. One word: "A*****". Blank:
// "Family".
export function privateName(fullName) {
  const words = String(fullName ?? '').trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (!words.length) return 'Family';
  const first = [...words[0]];
  const masked = `${first[0].toUpperCase()}${'*'.repeat(first.length - 1)}`;
  if (words.length === 1) return masked;
  return `${masked} ${[...words[words.length - 1]][0].toUpperCase()}`;
}

// The name a family shows under on the public list: "Jane S.", or "J*** S" when she
// approved their request to list privately.
export const listedName = (entry, fullName) => (entry && entry.private_listing ? privateName(fullName) : publicName(fullName));

// The public list for one kennel: the allow-listed fields only (position, first
// name + last initial, or the private form of it, sex preference, date added). Positions are the REAL §6.1
// positions; paused families are left out and their numbers skipped (#1, #2, #4),
// so nobody's public number shifts when a pause ends (decided 2026-10-06).
// Listen-only families show, with no marker. Programs, notes and money never do.
// `nameOf(entry)` returns the family's full name.
// `deciding(entry)`: a family holding a turn (placeHidden). Their row stays, at
// their number, but the name, sex preference and date read as DECIDING_LABEL and
// the row carries `deciding: true` (decided 2026-10-10). The online projection
// publishes rows unmasked and the server masks them as it serves the page, from
// who holds a turn at that moment (cloud/src/familyPages.js listView), so a turn
// the server closes or opens while her phone is off shows right away.
export const DECIDING_LABEL = 'Currently deciding';
export function publicList(entries, kennelId, programsById = new Map(), { today, nameOf = (e) => entryName(e, null), deciding = () => false, config = null } = {}) {
  return rankedList(entries, kennelId, programsById)
    .map((e, i) => ({ entry: e, position: i + 1 }))
    .filter(({ entry }) => !isPaused(entry, today, config))
    .map(({ entry, position }) => (deciding(entry)
      ? { position, name: DECIDING_LABEL, pref_sex: null, added: null, deciding: true }
      : {
        position,
        name: listedName(entry, nameOf(entry)),
        pref_sex: entry.pref_sex || 'any',
        added: anchorDate(entry)
      }));
}

const PUBLIC_SEX = { male: 'Male', female: 'Female', any: 'Either' };

// The public list as plain text for a Facebook post or website (the W1 stand-in
// for the public link). `fmtDate` formats a YYYY-MM-DD for display.
export function publicListText(rows, { kennelName = '', today = '', fmtDate = (d) => d } = {}) {
  const head = `${kennelName ? `${kennelName} Waitlist` : 'Waitlist'}${today ? ` (updated ${fmtDate(today)})` : ''}`;
  if (!rows.length) return `${head}\nNo families to show right now.`;
  const lines = rows.map((r) => (r.deciding
    ? `#${r.position} ${DECIDING_LABEL}`
    : `#${r.position} ${r.name} · ${PUBLIC_SEX[r.pref_sex] || 'Either'} · added ${fmtDate(r.added)}`));
  const gaps = rows.some((r, i) => r.position !== i + 1);
  return [head, '', ...lines, ...(gaps ? ['', 'Note: in special circumstances, some applicant names may not be displayed above. Their place is being held, but they are not currently eligible for available pups.'] : [])].join('\n');
}

// --- Telling her what an action did to offers -------------------------------------

// Plain-text lines for the offers an action closed or made on her behalf, so no
// offer is ever made silently: `voided` (offers that ended because the family left
// the list) and `next` / `offered` (families now holding a turn, whom she must
// contact — W1 sends nothing). `nameOf(entryId)` and `litterOf(litterId)` give
// display names; `fmtDate` formats a YYYY-MM-DD. [] when nothing changed.
//
// `waiting` lists the families who are next but were NOT offered because she has
// automatic offers turned off (waitlist_config.auto_offer_next): [{ litter_id,
// entry_id }]. She offers them herself.
// One auto-passed family (offerNextTurn's auto_passed item), as a sentence.
export function autoPassedLine(a, { nameOf, litterOf }) {
  const litters = (a.litter_ids || []).map(litterOf).join(', ');
  const count = a.counted ? ` (pass ${a.used} of ${a.max})` : '';
  const removed = a.removed ? ' That was their last pass, so they were removed from the list; you can undo it from their page for 7 days.' : '';
  return `${nameOf(a.entry_id)} had said "Not this litter" to ${litters}, so their turn was recorded as a pass${count} and the list moved on.${removed}`;
}

// The "Next turn" line's warning (Spec §16.2): which of the next family's turn
// litters they said "Not this litter" to, and what offering will do. '' when none.
// `ls` is nextTurn's litters; `litterOf(litter)` names one.
export function nextTurnPrepassNote(entry, ls, { offers = [], config = WAITLIST_CONFIG_DEFAULTS, program = null, litterOf }) {
  const { offer, prepassed } = splitPrepassed(entry, ls);
  if (!prepassed.length) return '';
  const names = prepassed.map((x) => litterOf(x.litter)).join(', ');
  if (offer.length) return `They said "Not this litter" to ${names}, so their turn will cover ${offer.map((x) => litterOf(x.litter)).join(', ')} only.`;
  const counts = countsAsPass('passed', { config, program });
  const used = passesUsed(entry, offers) + 1;
  const max = Number(config.max_passes);
  const last = counts && used >= max ? ' That will be their last pass, so they\'ll be removed from the list.' : '';
  return `They said "Not this litter" to ${prepassed.length === 1 ? names : `all of these (${names})`}. "Offer to them" records their turn as a pass${counts ? ` (pass ${used} of ${max})` : ''} and offers the next family.${last}`;
}

export function describeOfferChanges({ next = null, voided = [], offered = [], waiting = [], auto_passed = [] } = {}, { nameOf, litterOf, fmtDate = (d) => d } = {}) {
  const lines = [];
  // Families whose turn was passed at once ("Not this litter" to all of it, §16.2):
  // always said, so a pass never happens out of her sight.
  for (const a of [...auto_passed, ...((next && next.auto_passed) || [])]) {
    lines.push(autoPassedLine(a, { nameOf, litterOf }));
  }
  if (voided.length) {
    lines.push(`Their open offer${voided.length === 1 ? '' : 's'} on ${voided.map((o) => litterOf(o.litter_id)).join(', ')} ${voided.length === 1 ? 'was' : 'were'} voided (not a pass).`);
  }
  // A turn (§16.1) names every litter it covers: { entry_id, litter_ids, respond_by_date }.
  const litters = (o) => (o.litter_ids || [o.litter_id]).map(litterOf).join(', ');
  for (const o of [next, ...offered].filter(Boolean)) {
    lines.push(`${litters(o)}: now ${nameOf(o.entry_id)}'s turn, respond by ${fmtDate(o.respond_by_date)}. Let them know.`);
  }
  for (const w of waiting) {
    const pre = w.prepassed_litter_ids || [];
    if (pre.length && pre.length === (w.litter_ids || []).length) {
      lines.push(`${litters(w)}: ${nameOf(w.entry_id)} is next, but they said "Not this litter" to ${pre.length === 1 ? 'it' : 'all of these'}. "Offer to them" will record that as a pass and offer the next family.`);
    } else {
      lines.push(`${litters(w)}: ${nameOf(w.entry_id)} is next${pre.length ? ` (they said "Not this litter" to ${pre.map(litterOf).join(', ')})` : ''}. No turn was offered (automatic offers are off); offer it when you're ready.`);
    }
  }
  if (voided.length && !offered.length && !waiting.length) lines.push('Nobody else on the list is eligible for those litters right now.');
  return lines;
}
