// picksPreview.js — what opening picks on a litter will do (Picks Preview Spec;
// End-State guide §29). PURE: plain records in, a description out. No Dexie, no
// DOM, no clock (callers pass `today`). Every decision is made by the same rules
// openPicks / offerNextTurn run (waitlistRules.js), so the preview can't disagree
// with what really happens; tests/picksPreview.test.js checks that against the real
// actions. Nothing here is stored. Pro-only (the waitlist is Pro).
//
// A litter isn't a silo: one family holds a turn at a time across every litter
// with open picks, so the default view is the kennel's picks WITH this litter
// added ('combined'); 'alone' shows this litter as if it were the only one open.

import {
  waitlistConfig, rankedList, overallPositions, isPupAvailable, pupMatchesPrefs,
  eligiblePupsFor, isManuallyPaused, isReadyHeld, readyFromDate, readyCheck, isListeningFor,
  turnSpent, turnLittersFor, openTurns, joinsOpenTurn, splitPrepassed, prepassFor,
  respondByDate, countsAsPass, passesUsed, shouldRemoveForPasses, kennelBreeds, resolveBreed,
  WHELP_NOTE_FIELDS, isSideSalePending, sideSaleOf, pupClaims
} from './waitlistRules.js';
import { RELEASED_SALE_STATUSES, cleanPurposes } from './vocab.js';

const GONE_DOG_STATUSES = { deceased: 'deceased', pet_home: 'gone_home', external_reference: 'external' };
const UNOFFERED_DISPOSITIONS = ['undecided', 'keeping', 'placed', 'health_hold'];
const SPENT = ['open', 'accepted', 'passed', 'no_response'];
// The family's email: the linked contact's, else the one they applied with
// (waitlistProjection.entryEmail; not imported, to keep this module light).
const entryEmail = (entry, contact) => String((contact && contact.email) || (entry.application && entry.application.email) || '').trim();
const liveSale = (s) => !s.is_archived && !RELEASED_SALE_STATUSES.includes(s.status);

// Why a pup isn't offered: [] when it is. Mirrors isPupAvailable, naming each cause.
// → [{ code: 'archived' | 'deceased' | 'gone_home' | 'external' | 'disposition' | 'sale',
//      disposition?, sale_id?, sale_status?, entry_id? (a turn pick's family) }]
export function pupBlockers(dog, sales = [], offers = []) {
  const out = [];
  if (dog.is_archived) out.push({ code: 'archived' });
  if (GONE_DOG_STATUSES[dog.status]) out.push({ code: GONE_DOG_STATUSES[dog.status] });
  const disp = dog.disposition || 'undecided';
  if (UNOFFERED_DISPOSITIONS.includes(disp)) out.push({ code: 'disposition', disposition: disp });
  for (const s of sales.filter((x) => x.dog_id === dog.id && liveSale(x))) {
    if (isSideSalePending(s)) {
      // An unheld side sale doesn't take the pup (it's still offered).
      if (s.side_holds_pup) out.push({ code: 'side_sale', sale_id: s.id, entry_id: s.side_entry_id, due: s.side_deposit_due || null });
      continue;
    }
    const pick = offers.find((o) => !o.is_archived && o.outcome === 'open' && o.sale_id === s.id);
    out.push({ code: 'sale', sale_id: s.id, sale_status: s.status, ...(pick ? { entry_id: pick.entry_id, picked: true } : {}) });
  }
  return out;
}

// Setup gaps on an offered pup that quietly change who matches it.
// → ['no_registration' | 'no_color' | 'no_sex'] (breed is required on a dog)
export function pupFlags(dog, config) {
  const out = [];
  if (!dog.intended_registration) out.push('no_registration');
  if (config.color_matching && !String(dog.color_markings ?? '').trim()) out.push('no_color');
  if (dog.sex !== 'male' && dog.sex !== 'female') out.push('no_sex');
  return out;
}

// Live claims on one pup (waitlistRules.pupClaims): two or more is a conflict.
export const pupClaimCount = (dog, sales = [], offers = []) => pupClaims(dog.id, { sales, offers }).length;

// The matching answers that, each on its own, rule this pup out for this family
// (sex, breed, purposes, colors). Uses pupMatchesPrefs with every other answer
// opened, so it can never disagree with matching itself.
export function mismatchFields(entry, dog, config) {
  return WHELP_NOTE_FIELDS
    .filter((f) => {
      const only = Object.assign({ ...entry }, ...WHELP_NOTE_FIELDS.filter((g) => g !== f).map((g) => g.open));
      return !pupMatchesPrefs(only, dog, config);
    })
    .map((f) => f.why);
}

// Every reason this family isn't offered anything in this litter ([] = they are, or
// they hold the turn on it). Follows eligiblePupsFor step by step, collecting every
// reason rather than stopping at the first.
// → [{ code: 'paused', until } | { code: 'ready_hold', until | null, asked? }
//    | { code: 'listening', mode } | { code: 'had_turn', outcome } | { code: 'holds_turn' }
//    | { code: 'no_pups' } | { code: 'no_match', pups: [{ dog_id, fields: [] }] }]
export function exclusionReasons(entry, litter, pups, sales, offers, { today, config }) {
  const out = [];
  const here = offers.filter((o) => !o.is_archived && o.litter_id === litter.id && o.entry_id === entry.id);
  if (here.some((o) => o.outcome === 'open')) return [{ code: 'holds_turn' }];
  const side = sideSaleOf(entry, sales);
  if (side) out.push({ code: 'side_sale', sale_id: side.id, dog_id: side.dog_id, due: side.side_deposit_due || null });
  if (isManuallyPaused(entry, today)) out.push({ code: 'paused', until: entry.paused_until });
  if (isReadyHeld(entry, today, config)) {
    const from = readyFromDate(entry);
    out.push(from && today < from ? { code: 'ready_hold', until: from } : { code: 'ready_hold', until: null, asked: readyCheck(entry, today, config)?.asked || from });
  }
  if (!isListeningFor(entry, litter)) out.push({ code: 'listening', mode: entry.listen_mode || 'all' });
  const spent = here.find((o) => SPENT.includes(o.outcome) || o.backed_out_date);
  if (spent) out.push({ code: 'had_turn', outcome: spent.backed_out_date ? 'backed_out' : spent.outcome });
  const available = pups.filter((d) => d.litter_id === litter.id && isPupAvailable(d, sales));
  if (!available.length) out.push({ code: 'no_pups' });
  else if (!available.some((d) => pupMatchesPrefs(entry, d, config))) {
    out.push({ code: 'no_match', pups: available.map((d) => ({ dog_id: d.id, fields: mismatchFields(entry, d, config) })) });
  }
  return out;
}

// "Either" families as one sex, for the Either switch: their pref_sex is read as
// `eitherAs` ('female' | 'male'); 'stated' changes nothing.
export function withEitherAs(entries, eitherAs) {
  if (eitherAs !== 'female' && eitherAs !== 'male') return entries;
  return entries.map((e) => ((e.pref_sex || 'any') === 'any' ? { ...e, pref_sex: eitherAs, either_as: eitherAs } : e));
}

// What Open picks (or, with picks already open, the next offer) will do, run the
// way openPicks / offerNextTurn run it, on copies. Always on the families' stated
// answers: it's what will actually happen.
// → { kind: 'offer', entry_id, litters: [{ litter_id, dog_ids }], prepassed: [litter_id],
//      respond_by, auto_passed }
//   | { kind: 'join', entry_id, turn_id, dog_ids, respond_by, was_respond_by }
//   | { kind: 'wait', holder_id, turn_id, holder_litter_ids, respond_by, prepass_blocked? }
//   | { kind: 'held', holder_id, turn_id, holder_litter_ids, respond_by }   (picks already open)
//   | { kind: 'none', auto_passed }
// auto_passed: [{ entry_id, litter_ids, counted, used, max, removed }]
function simulateOpen({ entries, offers, litters, pups, sales, programsById, config, today, kennelId, litterId, alreadyOpen }) {
  const opts = { today, config, programsById, kennelId };
  const target = litters.find((l) => l.id === litterId);
  const [open] = openTurns(offers, kennelId);
  if (open) {
    const base = { holder_id: open.entry_id, turn_id: open.id, holder_litter_ids: open.offers.map((o) => o.litter_id), respond_by: open.respond_by_date };
    if (alreadyOpen) return { kind: 'held', ...base };
    const eligible = joinsOpenTurn(open, target, entries, offers, pups, sales, opts);
    const holder = entries.find((e) => e.id === open.entry_id);
    if (eligible.length && holder && prepassFor(holder, target)) return { kind: 'wait', ...base, prepass_blocked: true };
    if (!eligible.length) return { kind: 'wait', ...base };
    const program = holder ? programsById.get(holder.waitlist_program_id) || null : null;
    return { kind: 'join', entry_id: open.entry_id, turn_id: open.id, dog_ids: eligible.map((d) => d.id), respond_by: respondByDate(today, config, program), was_respond_by: open.respond_by_date };
  }
  // offerNextTurn's loop: a family whose whole turn is "Not this litter" is passed
  // at once (counting once), removed at the pass limit, and the list goes on.
  let simEntries = entries;
  let simOffers = offers;
  const autoPassed = [];
  for (let guard = 0; guard <= entries.length; guard++) {
    const next = nextTurnOn(simEntries, simOffers, litters, pups, sales, opts);
    if (!next) return { kind: 'none', auto_passed: autoPassed };
    const program = programsById.get(next.entry.waitlist_program_id) || null;
    const { offer, prepassed } = splitPrepassed(next.entry, next.litters);
    if (offer.length) {
      return {
        kind: 'offer', entry_id: next.entry.id,
        litters: offer.map((x) => ({ litter_id: x.litter.id, dog_ids: x.eligibleDogs.map((d) => d.id) })),
        prepassed: prepassed.map((x) => x.litter.id), respond_by: respondByDate(today, config, program), auto_passed: autoPassed
      };
    }
    const counts = countsAsPass('passed', { config, program });
    const rows = prepassed.map((x, i) => ({
      id: `preview-${guard}-${i}`, entry_id: next.entry.id, litter_id: x.litter.id, kennel_id: kennelId,
      turn_id: `preview-${guard}`, outcome: 'passed', counts_as_pass: counts && i === 0
    }));
    simOffers = [...simOffers, ...rows];
    const removed = shouldRemoveForPasses(next.entry, simOffers, config);
    if (removed) simEntries = simEntries.map((e) => (e.id === next.entry.id ? { ...e, status: 'removed' } : e));
    autoPassed.push({ entry_id: next.entry.id, litter_ids: prepassed.map((x) => x.litter.id), counted: counts, used: passesUsed(next.entry, simOffers), max: Number(config.max_passes), removed });
  }
  return { kind: 'none', auto_passed: autoPassed };
}

// nextTurn without the open-turn check (simulateOpen only calls it with none open).
function nextTurnOn(entries, offers, litters, pups, sales, { today, config, programsById, kennelId }) {
  for (const entry of rankedList(entries, kennelId, programsById)) {
    const ls = turnLittersFor(entry, offers, litters, pups, sales, { today, config });
    if (ls.length) return { entry, litters: ls };
  }
  return null;
}

// The preview. `data` is the kennel's records:
//   kennel, entries (the kennel's), offers (the kennel's), litters (may be all),
//   dogs (may be all: pups are found by litter, breeds from the kennel's dogs),
//   sales, programsById (Map), contacts (for emails)
// `litterId`: the litter being opened (or looked at). `view`: 'combined' | 'alone'.
// `eitherAs`: 'stated' | 'female' | 'male'. `configDraft`: unsaved settings changes,
// laid over the kennel's (the preview shows their effect before she saves).
export function previewPicks(data, { litterId, today, view = 'combined', eitherAs = 'stated', configDraft = null } = {}) {
  const { kennel, entries = [], offers = [], litters = [], dogs = [], sales = [], programsById = new Map(), contacts = [] } = data;
  const config = waitlistConfig({ waitlist_config: { ...(kennel?.waitlist_config || {}), ...(configDraft || {}) } });
  const kennelId = kennel.id;
  const kennelOffers = offers.filter((o) => !o.is_archived && (!o.kennel_id || o.kennel_id === kennelId));
  const base = litters.find((l) => l.id === litterId);
  if (!base) throw new Error('That litter no longer exists.');
  if (base.waitlist_off) throw new Error('This litter is kept off the waitlist (Non-Waitlist Sales). Put it back on the waitlist from its page first.');
  const alreadyOpen = Boolean(base.picks_opened_date);
  const target = alreadyOpen ? base : { ...base, picks_opened_date: today };
  const kennelLitters = litters.filter((l) => l.kennel_id === kennelId && !l.is_archived && !l.waitlist_off).map((l) => (l.id === litterId ? target : l));
  const openLitters = kennelLitters.filter((l) => l.picks_opened_date);
  const otherOpen = openLitters.filter((l) => l.id !== litterId);
  const shown = view === 'alone' ? [target] : [...otherOpen.sort((a, b) => String(a.picks_opened_date).localeCompare(String(b.picks_opened_date)) || String(a.id).localeCompare(String(b.id))), target];
  const litterIds = new Set(kennelLitters.map((l) => l.id));
  const pups = dogs.filter((d) => litterIds.has(d.litter_id));
  const opts = { today, config, programsById };

  // What will happen: always combined, always as they said.
  const action = simulateOpen({ entries, offers: kennelOffers, litters: openLitters, pups, sales, programsById, config, today, kennelId, litterId, alreadyOpen });

  const seen = withEitherAs(entries, eitherAs);
  const ranked = rankedList(seen, kennelId, programsById);
  const positions = overallPositions(entries, kennelId, programsById, { sales, dogs });
  const [openTurn] = openTurns(kennelOffers, kennelId);
  const contactsById = new Map(contacts.map((c) => [c.id, c]));
  const breeds = kennelBreeds(kennel, dogs);

  // Turn order: every family on the list with a pup in a shown litter they haven't
  // had a turn on, in list order (the projection's turn queue, on these litters).
  const turnOrder = [];
  for (const entry of ranked) {
    const ls = turnLittersFor(entry, kennelOffers, shown, pups, sales, opts);
    const holds = openTurn && openTurn.entry_id === entry.id;
    if (!ls.length && !holds) continue;
    const { offer, prepassed } = splitPrepassed(entry, ls);
    const program = programsById.get(entry.waitlist_program_id) || null;
    const elsewhere = view === 'alone'
      ? turnLittersFor(entry, kennelOffers, otherOpen, pups, sales, opts).map((x) => x.litter.id) : [];
    turnOrder.push({
      entry_id: entry.id,
      position: positions.get(entry.id) ?? null,
      ahead: program?.priority === 'ahead',
      holds_turn: Boolean(holds),
      holds_litter_ids: holds ? openTurn.offers.map((o) => o.litter_id) : [],
      litters: offer.map((x) => ({ litter_id: x.litter.id, dog_ids: x.eligibleDogs.map((d) => d.id) })),
      prepassed: prepassed.map((x) => x.litter.id),
      had_turn: shown.filter((l) => turnSpent(kennelOffers, l.id, entry.id) && !(holds && openTurn.offers.some((o) => o.litter_id === l.id))).map((l) => l.id),
      not_for: shown.filter((l) => !ls.some((x) => x.litter.id === l.id))
        .map((l) => ({ litter_id: l.id, reasons: exclusionReasons(entry, l, pups, sales, kennelOffers, opts) }))
        .filter((x) => x.reasons.length && !x.reasons.some((r) => r.code === 'holds_turn')),
      also_in: elsewhere,
      passes: { used: passesUsed(entry, kennelOffers), max: Number(config.max_passes), counted: countsAsPass('passed', { config, program }) },
      either_as: entry.either_as || null
    });
  }
  const inLine = new Set(turnOrder.map((t) => t.entry_id));

  // Pups by litter, each offered pup with the families who qualify for it, in order.
  const pupsByLitter = shown.map((litter) => {
    const rows = pups.filter((d) => d.litter_id === litter.id && !d.is_archived)
      .sort((a, b) => (a.sex || '').localeCompare(b.sex || '') || (a.call_name || '').localeCompare(b.call_name || ''))
      .map((dog) => {
        const offered = isPupAvailable(dog, sales);
        const families = offered ? ranked.filter((e) => !turnSpent(kennelOffers, litter.id, e.id)
          && eligiblePupsFor(e, litter, pups, sales, opts).some((d) => d.id === dog.id))
          .map((e) => ({ entry_id: e.id, prepassed: Boolean(prepassFor(e, litter)) })) : [];
        const holder = offered && openTurn ? openTurn.offers.find((o) => o.litter_id === litter.id && (o.eligible_dog_ids || []).includes(dog.id)) : null;
        // The family holding the turn on it is first in its line.
        if (holder) families.unshift({ entry_id: holder.entry_id, prepassed: false, holds_turn: true });
        return {
          dog_id: dog.id, sex: dog.sex || null, offered,
          blockers: offered ? [] : pupBlockers(dog, sales, kennelOffers),
          flags: offered ? pupFlags(dog, config) : [],
          conflict: pupClaimCount(dog, sales, kennelOffers) > 1,
          side: offered ? (sales.filter((x) => x.dog_id === dog.id && isSideSalePending(x)).map((x) => ({ sale_id: x.id, entry_id: x.side_entry_id, due: x.side_deposit_due || null }))) : [],
          holder_id: holder ? holder.entry_id : null,
          families
        };
      });
    // Within reach, per sex: with N offered pups of a sex, the first N families in
    // line for that sex. A count, not a prediction.
    const bySex = {};
    for (const sex of ['female', 'male']) {
      const ofSex = rows.filter((r) => r.offered && r.sex === sex);
      const fams = [];
      const holderId = ofSex.flatMap((r) => r.families).find((f) => f.holds_turn)?.entry_id;
      if (holderId) fams.push(holderId);
      for (const e of ranked) {
        if (e.id !== holderId && ofSex.some((r) => r.families.some((f) => f.entry_id === e.id && !f.prepassed))) fams.push(e.id);
      }
      bySex[sex] = { pups: ofSex.length, families: fams.length, within_reach: fams.slice(0, ofSex.length) };
    }
    return { litter_id: litter.id, is_target: litter.id === litterId, picks_open: Boolean(litter.picks_opened_date) && (litter.id !== litterId || alreadyOpen), pups: rows, by_sex: bySex };
  });

  // Left out: on the list, in nothing shown.
  const excluded = ranked.filter((e) => !inLine.has(e.id)).map((e) => ({
    entry_id: e.id,
    position: positions.get(e.id) ?? null,
    either_as: e.either_as || null,
    litters: shown.map((l) => ({ litter_id: l.id, reasons: exclusionReasons(e, l, pups, sales, kennelOffers, opts) }))
  }));

  // Not on the list yet: applied, or approved with the fee not recorded.
  const notOnList = entries.filter((e) => !e.is_archived && e.kennel_id === kennelId && (e.status === 'applied' || e.status === 'approved'))
    .map((e) => ({ entry_id: e.id, status: e.status }));

  // Soft checks on every family on the list (in line or left out): likely input
  // mistakes. A misspelled breed is usually why a family is left out at all.
  const checks = [];
  for (const { id } of ranked) {
    const e = entries.find((x) => x.id === id);
    const found = [];
    if (!cleanPurposes(e.pref_purposes).length) found.push('any_registration');
    if (String(e.pref_breed ?? '').trim() && resolveBreed(e.pref_breed, breeds) === null) found.push('breed_unknown');
    if (!entryEmail(e, contactsById.get(e.contact_id))) found.push('no_email');
    if (!e.fee_received_date && !e.position_anchor_date) found.push('no_fee_date');
    if (found.length) checks.push({ entry_id: e.id, codes: found });
  }

  return {
    litter_id: litterId, already_open: alreadyOpen, view, either_as: eitherAs,
    shown_litter_ids: shown.map((l) => l.id),
    other_open_litter_ids: otherOpen.map((l) => l.id),
    action, turnOrder, pupsByLitter, excluded, notOnList, checks,
    config,
    respond_by_today: respondByDate(today, config, null)
  };
}

