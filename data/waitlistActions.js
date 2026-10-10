// waitlistActions.js — the waitlist's multi-step writes (Waitlist Spec §5–§6;
// End-State guide §29): approve, decline, fee received, withdraw, remove, the
// second-pass undo, re-apply, the manual position override, and the offer flow
// (open picks, offer the next family, record an outcome — accept creates the
// Sale). Pages and Today's nudges call these rather than stitching repo writes
// together. Every decision comes from waitlistRules.js; this module only writes.
//
// W1 sends nothing: no emails, no status page. She messages families herself.
// Nothing here runs on page load: every write follows a tap (Spec §0).
//
// Offers are TURNS (Spec §16.1, decided 2026-10-08): one family at a time across
// the kennel's open litters, each turn covering every open litter they match.
//
// When are turns offered without her picking the family? Only when a turn closes
// (deposit received / passed / no response, or the family left the list while
// holding it) AND she has turned automatic offers on for that moment
// (waitlist_config.auto_offer_on — none by default, decided 2026-10-06; per moment
// since 2026-10-08, waitlistRules.autoOffers) — the turn moves on,
// and every such offer is RETURNED so the page can tell her who to contact. With
// automatic offers off, the same moments return who is next (`waiting`) and offer
// nobody. Actions on one family (fee received, a fee-waived approval, an undo)
// never make offers on any litter (decided 2026-10-06): she offers from "Next: …
// Offer to them".
//
// Accepting is two steps (decided 2026-10-06): the family PICKS a pup (a
// deposit-pending Sale holds it; the offer stays open, the pick can be switched)
// and then sends the deposit within the same respond-by window. Only the deposit
// makes the offer `accepted`, places the family, and moves the turn on. No deposit
// by the deadline = no response: the Sale is cancelled and the pup is free again.
import { kennelRepo } from './kennelRepo.js';
import { contactRepo } from './contactRepo.js';
import { waitlistEntryRepo } from './waitlistEntryRepo.js';
import { waitlistOfferRepo } from './waitlistOfferRepo.js';
import { waitlistProgramRepo } from './waitlistProgramRepo.js';
import { litterRepo } from './litterRepo.js';
import { dogRepo } from './dogRepo.js';
import { saleRepo } from './saleRepo.js';
import { expectedPricing } from './saleDefaults.js';
import { todayYMD } from './dateUtils.js';
import { RELEASED_SALE_STATUSES, SALE_END_REASON, registrationsForPurposes, descriptor } from './vocab.js';
import {
  waitlistConfig, feeForEntry, feeDueDate, anchorDate, canUndoRemoval, passToForgive,
  respondByDate, countsAsPass, shouldRemoveForPasses, passesUsed, isPupAvailable,
  turnSpent, eligiblePupsFor, isAwaitingDeposit, canSwitchAcceptedPick, undoPassBlocker, autoOffers, closingTrigger,
  prefChangeLines, turnIdOf, turnOffers, openTurns, nextTurn, turnLittersFor, joinsOpenTurn,
  splitPrepassed, prepassFor, lostSaleFamily
} from './waitlistRules.js';

const nowISO = () => new Date().toISOString();
const appendNote = (notes, line) => [notes, line].filter(Boolean).join('\n');
const money = (v) => `$${Number(v).toFixed(2)}`;

async function load(entryId) {
  const entry = await waitlistEntryRepo.getById(entryId);
  if (!entry) throw new Error('That waitlist entry no longer exists.');
  return entry;
}

function requireStatus(entry, allowed, verb) {
  if (!allowed.includes(entry.status)) throw new Error(`Can't ${verb} a family whose status is "${entry.status}".`);
}

// The context approval needs: the kennel's config and the entry's program.
async function feeContext(entry, programId) {
  const [kennel, program] = await Promise.all([
    kennelRepo.getById(entry.kennel_id),
    programId ? waitlistProgramRepo.getById(programId) : null
  ]);
  return { config: waitlistConfig(kennel), program };
}

// A new Contact from the application answers (Spec §5.2 "creates or links").
function contactFromApplication(app = {}) {
  return {
    name: String(app.name || '').trim(),
    email: String(app.email || '').trim(),
    phone: String(app.phone || '').trim(),
    address: String(app.location || '').trim(),
    contact_type: ['buyer'],
    first_contact_source: String(app.heard_from || '').trim()
  };
}

// Approve an application. `contactId` links an existing contact (a match she
// picked); otherwise a new contact is created from the answers. A fee-waived
// program skips straight onto the list, anchored at the approval date (§5.3).
export async function approve(entryId, { date = todayYMD(), contactId = null, programId } = {}) {
  const entry = await load(entryId);
  requireStatus(entry, ['applied'], 'approve');
  const program_id = programId === undefined ? (entry.waitlist_program_id || null) : (programId || null);
  const { config, program } = await feeContext(entry, program_id);

  let contact_id = contactId || entry.contact_id || null;
  if (!contact_id) contact_id = (await contactRepo.create(contactFromApplication(entry.application))).id;

  const fee = feeForEntry(config, program);
  const changes = {
    contact_id,
    waitlist_program_id: program_id,
    approved_date: date,
    fee_amount: fee,
    fee_credit_policy: config.fee_credit_policy,
    fee_due_date: fee === 0 ? null : feeDueDate(date, config),
    status: 'approved'
  };
  if (fee === 0) {
    Object.assign(changes, { status: 'active', fee_received_date: date, fee_received_at: nowISO(), fee_payment_method: 'Waived' });
  }
  return waitlistEntryRepo.update(entryId, changes);
}

export async function decline(entryId, { date = todayYMD() } = {}) {
  const entry = await load(entryId);
  requireStatus(entry, ['applied'], 'decline');
  return waitlistEntryRepo.update(entryId, { status: 'declined', declined_date: date });
}

// Fee received — this fixes the family's place in line (fee_received_date is the
// position anchor, §6.1; fee_received_at, the moment she recorded it, orders two
// families who paid on the same day). Also used with a null fee ("Add to the list").
export async function feeReceived(entryId, { date = todayYMD(), amount, method = '', reference = '' } = {}) {
  const entry = await load(entryId);
  requireStatus(entry, ['approved'], 'mark the fee received for');
  const changes = {
    status: 'active',
    fee_received_date: date,
    fee_received_at: nowISO(),
    fee_payment_method: method,
    fee_payment_reference: reference
  };
  if (amount !== undefined) changes.fee_amount = amount === '' || amount == null ? null : Number(amount);
  // No offer is made here, even if they're now next on a litter with open picks:
  // the page tells her, and she offers it (see the header note).
  return waitlistEntryRepo.update(entryId, changes);
}

export async function markFeeExpired(entryId) {
  const entry = await load(entryId);
  requireStatus(entry, ['approved'], 'expire');
  return waitlistEntryRepo.update(entryId, { status: 'expired' });
}

// The family left the list themselves (they told her). Any open offer they held
// is voided and that litter's turn moves on. Returns { entry, voided, offered }.
export async function withdraw(entryId, { date = todayYMD(), moveOn = true } = {}) {
  const entry = await load(entryId);
  requireStatus(entry, ['applied', 'approved', 'active'], 'withdraw');
  const saved = await waitlistEntryRepo.update(entryId, { status: 'withdrawn', withdrawn_date: date });
  return { entry: saved, ...(await releaseOpenOffers(entryId, { date, why: 'the family withdrew from the list', moveOn })) };
}

// "Ready now?" (Spec §16.7). Yes: the hold is over. No: a new date and a required
// reason, which becomes a pause request she approves or declines (the reason
// rides it, like a pause note). `by`: 'family' (their status page) or 'breeder'.
export async function recordReadyAnswer(entryId, { answer, until = null, reason = '', date = todayYMD(), by = 'breeder' } = {}) {
  const entry = await load(entryId);
  requireStatus(entry, ['active'], 'answer the ready check for');
  if (answer === 'yes') return waitlistEntryRepo.update(entryId, { ready_check: { answer: 'yes', answered_date: date, by } });
  if (answer !== 'no') throw new Error('Ready now? is answered yes or no.');
  const why = String(reason || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(until || '')) || until <= date) throw new Error('Not ready yet needs a date after today.');
  if (!why) throw new Error('Not ready yet needs a reason.');
  return waitlistEntryRepo.update(entryId, {
    ready_check: { answer: 'no', answered_date: date, until, reason: why, by },
    pause_request: { requested_date: date, until, note: why, from_ready_check: true }
  });
}

// Her device's move under remove_after (§16.7): no answer in her window. Removed
// with the 7-day undo, like a second-pass removal. They're held, so no offer is open.
export async function removeForNoReadyAnswer(entryId, { date = todayYMD() } = {}) {
  const entry = await load(entryId);
  requireStatus(entry, ['active'], 'remove');
  const saved = await waitlistEntryRepo.update(entryId, { status: 'removed', removed_date: date, removed_reason: 'no_ready_answer' });
  return { entry: saved, ...(await releaseOpenOffers(entryId, { date, why: 'they didn\'t answer the ready check' })) };
}

// She removes a family from the list. Final: coming back means re-applying. Any
// open offer they held is voided and moves on. Returns { entry, voided, offered }.
export async function removeByBreeder(entryId, { date = todayYMD() } = {}) {
  const entry = await load(entryId);
  requireStatus(entry, ['active'], 'remove');
  const saved = await waitlistEntryRepo.update(entryId, { status: 'removed', removed_date: date, removed_reason: 'by_breeder' });
  return { entry: saved, ...(await releaseOpenOffers(entryId, { date, why: 'you removed the family from the list' })) };
}

// Archive an entry (it drops off the list). An open offer it held is voided and
// moves on, the same as the family leaving. Unarchive goes straight to the repo:
// it makes no offers. Returns { entry, voided, offered }.
export async function archiveEntry(entryId, { date = todayYMD() } = {}) {
  await load(entryId);
  const saved = await waitlistEntryRepo.archive(entryId);
  return { entry: saved, ...(await releaseOpenOffers(entryId, { date, why: 'the entry was archived' })) };
}

// The 7-day undo on a second-pass removal (§6.4). Forgives the triggering pass so
// the family isn't removed again at once; their anchor is untouched, so they're
// back at their old place. Makes no offers (the page says where they're next).
export async function undoRemoval(entryId, { today = todayYMD() } = {}) {
  const entry = await load(entryId);
  if (!canUndoRemoval(entry, today)) throw new Error('This removal can no longer be undone.');
  // No answer to "Ready now?" (§16.7): back on the list, and the question asked
  // again from today, so the next sweep doesn't remove them again at once.
  if (entry.removed_reason === 'no_ready_answer') {
    return waitlistEntryRepo.update(entryId, {
      status: 'active', removed_date: null, removed_reason: null, ready_check: { ask_from: today }
    });
  }
  const offers = await waitlistOfferRepo.getByEntry(entryId);
  const forgive = passToForgive(entry, offers);
  if (forgive) {
    const note = `Pass forgiven by you on ${today} (removal undone).`;
    await waitlistOfferRepo.update(forgive.id, {
      counts_as_pass: false,
      notes: forgive.notes ? `${forgive.notes}\n${note}` : note
    });
  }
  return waitlistEntryRepo.update(entryId, { status: 'active', removed_date: null, removed_reason: null });
}

// A closed run (placed, removed, withdrawn, declined, expired) → a NEW application
// for the same family on the same kennel's list. New fee, new place (§6.4).
export async function reapply(entryId, { date = todayYMD() } = {}) {
  const entry = await load(entryId);
  if (['applied', 'approved', 'active'].includes(entry.status)) {
    throw new Error('This family is still on the list.');
  }
  return waitlistEntryRepo.create({
    kennel_id: entry.kennel_id,
    contact_id: entry.contact_id || null,
    status: 'applied',
    applied_date: date,
    waitlist_program_id: entry.waitlist_program_id || null,
    application: { ...(entry.application || {}) },
    pref_sex: entry.pref_sex || 'any',
    pref_breed: entry.pref_breed || '',
    pref_purposes: [...(entry.pref_purposes || [])],
    pref_colors: [...(entry.pref_colors || [])]
  });
}

// Manual position override (§6.1): a date that replaces the fee date for ordering
// only. Pass `null` to clear it. `afterEntryId` takes another family's anchor
// instead ("right after the Smiths") — date-only, so the family lands among that
// family's same-day peers (Spec §14 known limit).
export async function setPositionAnchor(entryId, { date = null, afterEntryId = null } = {}) {
  let anchor = date || null;
  if (afterEntryId) {
    const other = await load(afterEntryId);
    anchor = anchorDate(other) || null;
  }
  return waitlistEntryRepo.update(entryId, { position_anchor_date: anchor });
}

// "It's almost your turn" was sent (Spec §15.5): stamp each family with the date
// and the litters the notice was about. A record only — it never skips a family
// next time (she may need them again, e.g. for a "sorry, next time" note if a
// litter falls short). `litterIdsByEntry` maps entryId → litter ids.
export async function markSoonNotified(litterIdsByEntry, { date = todayYMD() } = {}) {
  for (const [entryId, litterIds] of litterIdsByEntry) {
    await waitlistEntryRepo.update(entryId, { soon_notified_date: date, soon_notified_litter_ids: [...litterIds] });
  }
}

// --- Offers: turns (Spec §6.4–§6.5, §16.1) ------------------------------------------
//
// One family holds a TURN at a time across the kennel's open litters (decided
// 2026-10-08). A turn is one waitlist_offers row per litter it covers, sharing
// `turn_id` and `respond_by_date`; the family picks one pup from any of them, or
// passes on all of them. Only a turn passed in full counts as a pass, once.
// Picks, deposits and pup switches still act on one row (one litter); outcomes
// (passed, no response, void) close the whole turn.

// Everything the rules need to decide a litter's pick or switch.
async function litterContext(litterId) {
  const litter = await litterRepo.getById(litterId);
  if (!litter) throw new Error('That litter no longer exists.');
  const [kennel, entries, offers, pups, programsById, sales] = await Promise.all([
    kennelRepo.getById(litter.kennel_id),
    waitlistEntryRepo.getByKennel(litter.kennel_id),
    waitlistOfferRepo.getByLitter(litterId),
    dogRepo.getByLitter(litterId),
    waitlistProgramRepo.getMapForKennel(litter.kennel_id),
    saleRepo.getAll({ includeArchived: true })
  ]);
  const pupIds = new Set(pups.map((d) => d.id));
  return {
    litter, kennel, entries, offers, pups, programsById,
    sales: sales.filter((x) => pupIds.has(x.dog_id)),
    config: waitlistConfig(kennel)
  };
}

// Everything the rules need to decide a kennel's next turn: every litter, pup and
// offer of the kennel.
async function kennelContext(kennelId) {
  const [kennel, entries, offers, allLitters, dogs, programsById, sales] = await Promise.all([
    kennelRepo.getById(kennelId),
    waitlistEntryRepo.getByKennel(kennelId),
    waitlistOfferRepo.getByKennel(kennelId),
    litterRepo.getAll({ includeArchived: true }),
    dogRepo.getAll({ includeArchived: true }),
    waitlistProgramRepo.getMapForKennel(kennelId),
    saleRepo.getAll({ includeArchived: true })
  ]);
  const litters = allLitters.filter((l) => l.kennel_id === kennelId);
  const litterIds = new Set(litters.map((l) => l.id));
  const pups = dogs.filter((d) => litterIds.has(d.litter_id));
  const pupIds = new Set(pups.map((d) => d.id));
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  return {
    kennel, entries, offers, litters, pups, programsById,
    sales: sales.filter((x) => pupIds.has(x.dog_id)),
    config: waitlistConfig(kennel),
    litterLabel: (l) => l.nickname || `${dogsById.get(l.dam_id)?.call_name || 'Unknown'} × ${dogsById.get(l.sire_id)?.call_name || 'Unknown'}`
  };
}

const ruleOpts = (c, today) => ({ today, config: c.config, programsById: c.programsById, kennelId: c.kennel?.id });

// A turn as the pages and Today report it.
function turnView(rows) {
  return {
    id: turnIdOf(rows[0]), entry_id: rows[0].entry_id, offers: rows,
    litter_ids: rows.map((o) => o.litter_id),
    respond_by_date: rows.map((o) => o.respond_by_date || '').sort().reverse()[0] || null
  };
}

// "Not this litter" used up: those litters are recorded as PASSED rows of this
// turn (never counted on their own: only a turn passed in full counts, §16.1 rule
// 6) with the family's reason, and the prepasses leave the entry.
async function recordPrepassed(entry, prepassed, { turnId, today, respondBy, counts = false }) {
  const rows = [];
  for (const [i, { litter, eligibleDogs, prepass }] of prepassed.entries()) {
    rows.push(await waitlistOfferRepo.create({
      entry_id: entry.id, litter_id: litter.id, kennel_id: litter.kennel_id, turn_id: turnId,
      offered_date: today, respond_by_date: respondBy, eligible_dog_ids: eligibleDogs.map((d) => d.id),
      outcome: 'passed', outcome_date: today, counts_as_pass: counts && i === 0,
      pass_reason: prepass.reason || null,
      notes: `Passed ahead of time on ${prepass.date || 'their status page'} ("Not this litter"); recorded when their turn came.`
    }));
  }
  const used = new Set(prepassed.map((x) => x.prepass));
  const fresh = await load(entry.id);
  await waitlistEntryRepo.update(entry.id, { prepasses: (fresh.prepasses || []).filter((p) => ![...used].some((u) => u.litter_id === p.litter_id && u.pairing_id === p.pairing_id)) });
  return rows;
}

// A turn whose every litter the family passed on ahead of time (§16.2): recorded
// as passed at once, counting once, with no wait, and a line for her on their
// entry. At the pass limit they're removed (second_pass, with the usual undo).
async function autoPassTurn(c, entry, prepassed, today) {
  const program = c.programsById.get(entry.waitlist_program_id) || null;
  const counts = countsAsPass('passed', { config: c.config, program });
  await recordPrepassed(entry, prepassed, { turnId: crypto.randomUUID(), today, respondBy: today, counts });
  const offers = await waitlistOfferRepo.getByEntry(entry.id);
  const removed = shouldRemoveForPasses(entry, offers, c.config);
  if (removed) await waitlistEntryRepo.update(entry.id, { status: 'removed', removed_date: today, removed_reason: 'second_pass' });
  const names = prepassed.map((x) => c.litterLabel(x.litter)).join(', ');
  await addFamilyActivity(entry.id, [{
    id: `prepass-turn-${entry.id}-${today}-${prepassed.map((x) => x.litter.id).join('-')}`, kind: 'action',
    body: `Their turn came up on ${names}, which they'd said "Not this litter" to, so it was recorded as a pass${counts ? ` (pass ${passesUsed(entry, offers)} of ${Number(c.config.max_passes)})` : ''} and the list moved on.${removed ? ' That was their last pass, so they were removed from the list; you can undo it from their page for 7 days.' : ''}`
  }]);
  return {
    entry_id: entry.id, litter_ids: prepassed.map((x) => x.litter.id), removed,
    counted: Boolean(counts), used: passesUsed(entry, offers), max: Number(c.config.max_passes)
  };
}

// Write a turn: one open row per litter in `ls` ([{ litter, eligibleDogs }]), and
// a passed row for each litter in `prepassed` (passed ahead of time, §16.2).
async function makeTurn(c, entry, ls, { today, note = '', prepassed = [] }) {
  const program = c.programsById.get(entry.waitlist_program_id) || null;
  const turnId = crypto.randomUUID();
  const respondBy = respondByDate(today, c.config, program);
  const rows = [];
  if (prepassed.length) await recordPrepassed(entry, prepassed, { turnId, today, respondBy });
  for (const { litter, eligibleDogs } of ls) {
    rows.push(await waitlistOfferRepo.create({
      entry_id: entry.id,
      litter_id: litter.id,
      kennel_id: litter.kennel_id,
      turn_id: turnId,
      offered_date: today,
      respond_by_date: respondBy,
      eligible_dog_ids: eligibleDogs.map((d) => d.id),
      outcome: 'open',
      notes: note || ''
    }));
  }
  return turnView(rows);
}

// Offer the next turn in this kennel, if nobody holds one (§16.1 rule 3). A family
// whose whole turn they'd passed on ahead of time is passed at once and the list
// goes on (§16.2). Returns the new turn (with `auto_passed`: the families passed on
// the way), `{ none: true, auto_passed }` when families were passed but nobody is
// left to offer, or null (a turn is open, or nobody is eligible for any open
// litter). Callers must show auto_passed: a pass she didn't see is a surprise.
export async function offerNextTurn(kennelId, { today = todayYMD() } = {}) {
  const autoPassed = [];
  for (;;) {
    const c = await kennelContext(kennelId);
    const next = nextTurn(c.entries, c.offers, c.litters, c.pups, c.sales, ruleOpts(c, today));
    if (!next) return autoPassed.length ? { none: true, auto_passed: autoPassed } : null;
    const { offer, prepassed } = splitPrepassed(next.entry, next.litters);
    if (offer.length) return { ...(await makeTurn(c, next.entry, offer, { today, prepassed })), auto_passed: autoPassed };
    autoPassed.push(await autoPassTurn(c, next.entry, prepassed, today));
  }
}

// The next turn in this litter's kennel (the Litter page's "Offer to them").
export async function offerNext(litterId, { today = todayYMD() } = {}) {
  const litter = await litterRepo.getById(litterId);
  if (!litter) throw new Error('That litter no longer exists.');
  return offerNextTurn(litter.kennel_id, { today });
}

// Offer one family a turn from their own page (Spec §15.2): the waitlist as the
// main workflow. Opens picks on `litterId` if they aren't open yet; the turn covers
// that litter and every other open litter they're eligible for. Nobody else may
// hold a turn (one at a time, §16.1). Offering out of order is allowed: the page
// confirms it with her first and passes `note` saying who was next. Returns the turn.
export async function offerTo(litterId, entryId, { today = todayYMD(), note = '' } = {}) {
  const litter = await litterRepo.getById(litterId);
  if (!litter) throw new Error('That litter no longer exists.');
  if (litter.is_archived) throw new Error('That litter is archived.');
  let c = await kennelContext(litter.kennel_id);
  const entry = c.entries.find((e) => e.id === entryId);
  if (!entry || entry.status !== 'active') throw new Error('Only families on the list can be offered a turn.');
  if (openTurns(c.offers, c.kennel.id).length) throw new Error('Another family holds the turn now. Record how it ended first.');
  if (turnSpent(c.offers, litterId, entryId)) throw new Error('This family has already had their turn on this litter.');
  if (!eligiblePupsFor(entry, litter, c.pups, c.sales, { today, config: c.config }).length) {
    throw new Error('No available pup in this litter matches this family right now.');
  }
  if (!litter.picks_opened_date) {
    await litterRepo.update(litterId, { picks_opened_date: today });
    c = await kennelContext(litter.kennel_id);
  }
  const ls = turnLittersFor(entry, c.offers, c.litters, c.pups, c.sales, { today, config: c.config });
  const { offer, prepassed } = splitPrepassed(entry, ls);
  if (!offer.some((x) => x.litter.id === litterId)) {
    throw new Error(`They said "Not this litter" to ${litter.nickname || 'this litter'} on their status page. Undo that on their page first if they've changed their mind.`);
  }
  return makeTurn(c, entry, offer, { today, note, prepassed });
}

// **Open picks** (Spec §6.5): stamp the litter. With no turn open, the next turn is
// offered. With one open, the litter joins it when its holder is the
// highest-ranked family eligible for it (§16.1 rule 5; the respond-by date
// restarts for the whole turn), and otherwise waits for the next turn.
// Returns the turn offered or joined (`joined: true`), or null.
export async function openPicks(litterId, { date = todayYMD() } = {}) {
  await litterRepo.update(litterId, { picks_opened_date: date });
  const litter = await litterRepo.getById(litterId);
  const c = await kennelContext(litter.kennel_id);
  const [open] = openTurns(c.offers, c.kennel.id);
  if (!open) return offerNextTurn(litter.kennel_id, { today: date });
  const eligible = joinsOpenTurn(open, litter, c.entries, c.offers, c.pups, c.sales, ruleOpts(c, date));
  if (!eligible.length) return null;
  const entry = c.entries.find((e) => e.id === open.entry_id);
  // They passed on it ahead of time: it doesn't join; their next turn records it.
  if (entry && prepassFor(entry, litter)) return null;
  const program = entry ? c.programsById.get(entry.waitlist_program_id) || null : null;
  const respondBy = respondByDate(date, c.config, program);
  const rows = [];
  for (const o of open.offers) {
    rows.push(o.respond_by_date === respondBy ? o : await waitlistOfferRepo.update(o.id, {
      respond_by_date: respondBy, notes: appendNote(o.notes, `Respond-by date restarted on ${date}: another litter joined this turn.`)
    }));
  }
  rows.push(await waitlistOfferRepo.create({
    entry_id: open.entry_id, litter_id: litter.id, kennel_id: litter.kennel_id, turn_id: open.id,
    offered_date: date, respond_by_date: respondBy, eligible_dog_ids: eligible.map((d) => d.id), outcome: 'open'
  }));
  return { ...turnView(rows), joined: true };
}

// Stop making new offers on this litter. An open turn stays open until she records
// how it ended.
export async function closePicks(litterId) {
  return litterRepo.update(litterId, { picks_opened_date: null });
}

// The turn moved on (a turn closed, or its family left the list). `trigger` is how
// it closed: accepted / passed / no_response / no_deposit / left. With automatic
// offers on for that moment, the next turn is offered now; otherwise (the default)
// nobody is offered and who's next is returned so the page can tell her.
// Returns { next, waiting, auto_passed } — at most one of next / waiting set.
// `waiting.prepassed_litter_ids` names the litters that family said "Not this
// litter" to, so the page can say offering them records a pass.
async function moveTurnOn(kennelId, { today = todayYMD(), trigger } = {}) {
  const c = await kennelContext(kennelId);
  if (autoOffers(c.config, trigger)) {
    const r = await offerNextTurn(kennelId, { today });
    return { next: r && !r.none ? r : null, waiting: null, auto_passed: r?.auto_passed || [] };
  }
  const n = nextTurn(c.entries, c.offers, c.litters, c.pups, c.sales, ruleOpts(c, today));
  if (!n) return { next: null, waiting: null, auto_passed: [] };
  const { prepassed } = splitPrepassed(n.entry, n.litters);
  return {
    next: null, auto_passed: [],
    waiting: {
      entry_id: n.entry.id, litter_ids: n.litters.map((x) => x.litter.id),
      ...(prepassed.length ? { prepassed_litter_ids: prepassed.map((x) => x.litter.id) } : {})
    }
  };
}

// Fold moveTurnOn's answer into an action's result.
async function finishTurn(result, kennelId, today, trigger) {
  const moved = await moveTurnOn(kennelId, { today, trigger });
  result.next = moved.next;
  if (moved.waiting) result.waiting = [...(result.waiting || []), moved.waiting];
  if (moved.auto_passed.length) result.auto_passed = [...(result.auto_passed || []), ...moved.auto_passed];
  return result;
}

// A family leaving the list (withdrew, removed, archived, accepted) can't keep
// holding a turn: void each of their open rows (never a pass) and, unless
// `moveOn` is false (the caller moves on itself), move the kennel on to its next
// turn. A pick they were holding is let go too (its deposit-pending Sale is
// cancelled). Returns { voided, offered, waiting }.
async function releaseOpenOffers(entryId, { date = todayYMD(), why, exceptOfferId = null, moveOn = true } = {}) {
  const open = (await waitlistOfferRepo.getByEntry(entryId))
    .filter((o) => o.id !== exceptOfferId && o.outcome === 'open' && !o.is_archived);
  const voided = [];
  const offered = [];
  const waiting = [];
  const autoPassed = [];
  for (const o of open) {
    await releasePick(o, { date, why, strict: false });
    voided.push(await waitlistOfferRepo.update(o.id, {
      outcome: 'voided', outcome_date: date, counts_as_pass: false,
      notes: appendNote(o.notes, `Voided automatically: ${why}.`)
    }));
  }
  if (voided.length && moveOn) {
    const moved = await moveTurnOn(voided[0].kennel_id, { today: date, trigger: 'left' });
    if (moved.next) offered.push(moved.next);
    if (moved.waiting) waiting.push(moved.waiting);
    autoPassed.push(...moved.auto_passed);
  }
  return { voided, offered, waiting, auto_passed: autoPassed };
}

// The deposit-pending Sale holding an open offer's pick, or null.
async function heldSale(offer) {
  return offer.sale_id ? saleRepo.getById(offer.sale_id) : null;
}

// Let go of an open offer's pick before it closes without a deposit: cancel the
// deposit-pending Sale so the pup is free again. `strict` refuses when the Sale
// already shows the deposit (she recorded it on the Sale page) — the offer should be
// settled with "Deposit received" instead. Leaving the list is never refused.
async function releasePick(offer, { date, why, strict = true }) {
  if (!isAwaitingDeposit(offer)) return;
  const sale = await heldSale(offer);
  if (!sale || sale.is_archived) return;
  if (sale.status !== 'deposit_pending') {
    if (strict && !RELEASED_SALE_STATUSES.includes(sale.status)) {
      throw new Error('Their sale already shows the deposit as received. Record it with "Deposit received" instead.');
    }
    return;
  }
  await saleRepo.update(sale.id, {
    status: 'cancelled',
    notes: appendNote(sale.notes, `Cancelled ${date}: the waitlist pick lapsed (${why}).`)
  });
}

async function loadOffer(offerId) {
  const offer = await waitlistOfferRepo.getById(offerId);
  if (!offer) throw new Error('That offer no longer exists.');
  return offer;
}

async function loadOpenOffer(offerId) {
  const offer = await loadOffer(offerId);
  if (offer.outcome !== 'open') throw new Error('This offer has already been closed.');
  return offer;
}

// The open rows of the turn `offer` belongs to.
async function openTurnRows(offer) {
  return turnOffers(await waitlistOfferRepo.getByEntry(offer.entry_id), turnIdOf(offer)).filter((o) => o.outcome === 'open');
}

// The family picked a pup (Spec §6.5): create the Sale (deposit pending, buyer =
// the family, price/deposit prefilled) to hold it while they send the deposit. The
// turn stays OPEN — nothing moves on, the family stays on the list — and the
// respond-by date is still their deadline, now for the deposit. One pick per turn:
// a pick from another litter of the same turn is let go first (they switched
// litters). Returns { offer, sale }.
export async function recordPick(offerId, { chosenDogId, date = todayYMD() } = {}) {
  const offer = await loadOpenOffer(offerId);
  if (offer.chosen_dog_id) throw new Error('They\'ve already picked a pup. Use "Change pup" to switch.');
  const entry = await load(offer.entry_id);
  if (!entry.contact_id) throw new Error('This family has no contact record.');
  const c = await litterContext(offer.litter_id);
  const dog = c.pups.find((d) => d.id === chosenDogId);
  if (!dog) throw new Error('Pick one of this litter\'s pups.');
  if (!isPupAvailable(dog, c.sales)) throw new Error(`${dog.call_name} is no longer available.`);
  for (const other of (await openTurnRows(offer)).filter((o) => o.id !== offer.id && isAwaitingDeposit(o))) {
    await releasePick(other, { date, why: 'they picked from another litter in the same turn' });
    await waitlistOfferRepo.update(other.id, {
      chosen_dog_id: null, picked_date: null, sale_id: null,
      notes: appendNote(other.notes, `Pick let go on ${date}: they picked from another litter in the same turn.`)
    });
  }
  // The pup's intended registration, else the first one the family's purposes
  // fit (vocab order: Limited before Full), else Limited.
  const registration = dog.intended_registration || (registrationsForPurposes(entry.pref_purposes) || [])[0] || 'limited';
  const sale = await saleRepo.create({
    dog_id: dog.id,
    buyer_contact_id: entry.contact_id,
    registration_type: registration,
    status: 'deposit_pending',
    kennel_id: dog.kennel_id || c.litter.kennel_id,
    sale_date: date,
    lead_source: 'Waitlist',
    ...expectedPricing(dog, c.litter, registration),
    // What they'd paid on a pup they lost (§16.11) is their deposit on this one;
    // it's recorded as received with "Deposit received", as any deposit is.
    ...(entry.carried_payment ? {
      deposit_amount: Number(entry.carried_payment.amount),
      notes: `Deposit: ${money(entry.carried_payment.amount)} carried over from a pup they lost (paid ${entry.carried_payment.date}).`
    } : {})
  });
  const saved = await waitlistOfferRepo.update(offerId, { chosen_dog_id: dog.id, picked_date: date, sale_id: sale.id });
  return { offer: saved, sale };
}

// Switch the pup a family picked (Spec §6.5 — they clicked the wrong one), within
// the same litter. Allowed while the deposit is pending, and after it too as long
// as nobody else has been offered a turn since. The same Sale moves to the new pup;
// its price and deposit follow the new pup's expected amounts only where she hasn't
// changed them (and a paid deposit is never touched). Returns { offer, sale }.
export async function changePick(offerId, { chosenDogId, date = todayYMD() } = {}) {
  const offer = await loadOffer(offerId);
  const c = await litterContext(offer.litter_id);
  const accepted = offer.outcome === 'accepted';
  if (accepted && !canSwitchAcceptedPick(offer, await waitlistOfferRepo.getByKennel(offer.kennel_id))) {
    throw new Error('Another family has been offered a turn since, so the pup can\'t be switched here. Change it on the sale.');
  }
  if (!accepted && !isAwaitingDeposit(offer)) throw new Error('They haven\'t picked a pup yet.');
  if (chosenDogId === offer.chosen_dog_id) return { offer, sale: null };
  const dog = c.pups.find((d) => d.id === chosenDogId);
  if (!dog) throw new Error('Pick one of this litter\'s pups.');
  if (!isPupAvailable(dog, c.sales)) throw new Error(`${dog.call_name} is no longer available.`);
  let saleId = offer.sale_id;
  if (!saleId && accepted) saleId = (await load(offer.entry_id)).placed_sale_id || null;
  const sale = saleId ? await saleRepo.getById(saleId) : null;
  if (!sale) throw new Error('There\'s no sale for this pick to move. Change it on the Sales page.');
  const oldDog = c.pups.find((d) => d.id === offer.chosen_dog_id) || null;
  const registration = dog.intended_registration || sale.registration_type;
  const was = expectedPricing(oldDog, c.litter, sale.registration_type);
  const now = expectedPricing(dog, c.litter, registration);
  const changes = { dog_id: dog.id, registration_type: registration };
  if ((sale.price ?? null) === was.price) changes.price = now.price;
  if (sale.status === 'deposit_pending' && (sale.deposit_amount ?? null) === was.deposit_amount) changes.deposit_amount = now.deposit_amount;
  const savedSale = await saleRepo.update(sale.id, changes);
  if (accepted) {
    await dogRepo.update(dog.id, { disposition: 'placed' });
    if (oldDog) await dogRepo.update(oldDog.id, { disposition: 'available' });
  }
  const saved = await waitlistOfferRepo.update(offerId, {
    chosen_dog_id: dog.id,
    notes: appendNote(offer.notes, `Pick switched from ${oldDog ? oldDog.call_name : 'another pup'} to ${dog.call_name} on ${date}.`)
  });
  return { offer: saved, sale: savedSale };
}

// The deposit arrived for a picked pup: the Sale moves to deposit paid, the pup is
// placed, the offer is accepted, the family is placed and leaves the list (the
// other litters of their turn, and any other open offer, are voided — never a
// pass), and the next turn comes up. Returns the same shape as recordOutcome.
export async function confirmDeposit(offerId, { date = todayYMD(), amount } = {}) {
  const offer = await loadOpenOffer(offerId);
  if (!isAwaitingDeposit(offer) || !offer.sale_id) throw new Error('Record which pup they picked first.');
  const entry = await load(offer.entry_id);
  const sale = await heldSale(offer);
  if (!sale || sale.is_archived || RELEASED_SALE_STATUSES.includes(sale.status)) {
    throw new Error('The sale holding their pick was cancelled or archived. Void this offer, or open the sale and fix it first.');
  }
  const saleChanges = { deposit_date: date };
  if (sale.status === 'deposit_pending') saleChanges.status = 'deposit_paid';
  if (amount !== undefined && amount !== null && amount !== '') saleChanges.deposit_amount = Number(amount);
  const result = { offer: null, sale: null, removed: false, passes: null, next: null, voided: [], offered: [], waiting: [] };
  result.sale = await saleRepo.update(sale.id, saleChanges);
  await dogRepo.update(offer.chosen_dog_id, { disposition: 'placed' });
  result.offer = await waitlistOfferRepo.update(offerId, { outcome: 'accepted', outcome_date: date, counts_as_pass: false });
  await waitlistEntryRepo.update(entry.id, { status: 'placed', placed_sale_id: sale.id, carried_payment: null });
  const released = await releaseOpenOffers(entry.id, { date, why: 'the family accepted a pup', exceptOfferId: offerId, moveOn: false });
  // The other litters of this same turn closing is just the turn ending: not news.
  result.voided = released.voided.filter((o) => turnIdOf(o) !== turnIdOf(offer));
  return finishTurn(result, offer.kennel_id, date, 'accepted');
}

// Undo a pass or no response (Spec §6.4): the family's turn is back. Every litter
// of that turn they're still eligible for reopens with a fresh respond-by date, and
// the pass no longer counts; if that pass had removed them (second pass), they're
// back on the list. A family holding the kennel's turn meanwhile has it voided —
// never a pass, and they're next again once this family's turn settles — unless
// they've already picked a pup (then she settles that first). Makes no other
// offer. Returns { offer, offers, voided, restored }.
export async function undoPass(offerId, { today = todayYMD() } = {}) {
  const offer = await loadOffer(offerId);
  const entry = await load(offer.entry_id);
  const blocker = undoPassBlocker(offer, entry, today);
  if (blocker) throw new Error(blocker);
  const c = await kennelContext(offer.kennel_id);
  const rows = turnOffers(c.offers, turnIdOf(offer)).filter((o) => o.outcome === offer.outcome && o.outcome_date === offer.outcome_date);
  const holders = openTurns(c.offers, c.kennel.id).filter((t) => t.id !== turnIdOf(offer));
  if (holders.some((t) => t.offers.some(isAwaitingDeposit))) {
    throw new Error('The family holding the turn now has already picked a pup. Record their deposit or void their offer first.');
  }
  const active = { ...entry, status: 'active' };
  const reopen = rows.map((o) => ({ o, litter: c.litters.find((l) => l.id === o.litter_id) }))
    .filter(({ litter }) => litter && !litter.is_archived)
    .map(({ o, litter }) => ({ o, eligible: eligiblePupsFor(active, litter, c.pups, c.sales, { today, config: c.config }) }))
    .filter((x) => x.eligible.length);
  if (!reopen.length) {
    throw new Error('They can\'t be offered those litters right now (no matching pup left, paused, or listening for other litters), so there\'s no turn to give back.');
  }
  const program = c.programsById.get(entry.waitlist_program_id) || null;
  const result = { offer: null, offers: [], voided: [], restored: false };
  for (const t of holders) {
    for (const h of t.offers) {
      result.voided.push(await waitlistOfferRepo.update(h.id, {
        outcome: 'voided', outcome_date: today, counts_as_pass: false,
        notes: appendNote(h.notes, 'Voided automatically: you undid an earlier pass, so that family got their turn back. Not a pass; this family is next again after them.')
      }));
    }
  }
  if (entry.status === 'removed') {
    await waitlistEntryRepo.update(entry.id, { status: 'active', removed_date: null, removed_reason: null });
    result.restored = true;
  }
  const label = offer.outcome === 'passed' ? 'Pass' : 'No response';
  const respondBy = respondByDate(today, c.config, program);
  for (const o of rows) {
    const re = reopen.find((x) => x.o.id === o.id);
    const saved = await waitlistOfferRepo.update(o.id, re
      ? { outcome: 'open', outcome_date: null, counts_as_pass: false, respond_by_date: respondBy, eligible_dog_ids: re.eligible.map((d) => d.id),
          notes: appendNote(o.notes, `${label} undone by you on ${today}; their turn is back with a new respond-by date.`) }
      : { counts_as_pass: false, notes: appendNote(o.notes, `${label} undone by you on ${today}; no matching pup left in this litter, so it stays closed.`) });
    if (re) result.offers.push(saved);
  }
  result.offer = result.offers.find((o) => o.id === offerId) || result.offers[0];
  return result;
}

// Record how a turn ended, from any of its rows. `outcome` is accepted / passed /
// no_response / voided. Returns { offer, sale, removed, passes, next, voided,
// offered, waiting } for the page's message: `next` is the new turn (automatic
// offers on), `waiting` who's next when they're off; `voided` / `offered` are the
// family's OTHER open offers that closed because they left the list.
//  - accepted: the pick AND the deposit at once, on THIS row — needs `chosenDogId`
//    (an available pup from this litter) unless they've already picked here;
//    `depositDate` / `depositAmount` are optional. Same as recordPick + confirmDeposit.
//  - passed / no_response: closes EVERY litter of the turn; a pick they were
//    holding lapses (its Sale is cancelled). counts_as_pass is decided now and
//    frozen (§6.4) on ONE row: a turn passed in full counts once (§16.1 rule 6). At
//    the pass limit the entry is removed (second_pass, with a 7-day undo).
//  - voided: the whole turn, never a pass; a held pick lapses. The turn is NOT
//    moved on (she voided it for a reason; the same family would just be offered
//    again) — she offers the next turn from the litter page.
// `passReason` ({ id, label, text }) is the family's own reason, on a pass they
// made on their status page (§16.5); none when she records one.
export async function recordOutcome(offerId, outcome, { date = todayYMD(), chosenDogId = null, depositDate = null, depositAmount, passReason = null, moveOn = true } = {}) {
  const offer = await loadOpenOffer(offerId);
  const entry = await load(offer.entry_id);

  if (outcome === 'accepted') {
    if (!offer.chosen_dog_id) await recordPick(offerId, { chosenDogId, date });
    else if (chosenDogId && chosenDogId !== offer.chosen_dog_id) await changePick(offerId, { chosenDogId, date });
    return confirmDeposit(offerId, { date: depositDate || date, amount: depositAmount });
  }

  const rows = await openTurnRows(offer);
  const picked = rows.find(isAwaitingDeposit) || null;
  const result = { offer: null, sale: null, removed: false, passes: null, next: null, voided: [], offered: [], waiting: [] };
  if (outcome === 'passed' || outcome === 'no_response') {
    for (const o of rows) await releasePick(o, { date, why: outcome === 'passed' ? 'they passed' : 'no deposit by the deadline' });
    const [kennel, program] = await Promise.all([
      kennelRepo.getById(entry.kennel_id),
      entry.waitlist_program_id ? waitlistProgramRepo.getById(entry.waitlist_program_id) : null
    ]);
    const config = waitlistConfig(kennel);
    const counts = countsAsPass(outcome, { config, program });
    for (const o of rows) {
      const saved = await waitlistOfferRepo.update(o.id, {
        outcome, outcome_date: date, counts_as_pass: counts && o.id === offer.id,
        ...(outcome === 'passed' && passReason ? { pass_reason: passReason } : {})
      });
      if (o.id === offer.id) result.offer = saved;
    }
    const offers = await waitlistOfferRepo.getByEntry(entry.id);
    result.passes = { used: passesUsed(entry, offers), max: Number(config.max_passes), counted: counts };
    if (shouldRemoveForPasses(entry, offers, config)) {
      await waitlistEntryRepo.update(entry.id, { status: 'removed', removed_date: date, removed_reason: 'second_pass' });
      result.removed = true;
      const released = await releaseOpenOffers(entry.id, { date, why: 'the family was removed after their last pass', moveOn: false });
      result.voided = released.voided;
    }
  } else if (outcome === 'voided') {
    for (const o of rows) {
      await releasePick(o, { date, why: 'you voided the offer' });
      const saved = await waitlistOfferRepo.update(o.id, { outcome: 'voided', outcome_date: date, counts_as_pass: false });
      if (o.id === offer.id) result.offer = saved;
    }
    return result;
  } else {
    throw new Error(`Unknown outcome "${outcome}".`);
  }

  // `moveOn: false`: the server already moved the turn on (W2 step 7).
  if (!moveOn) return result;
  return finishTurn(result, offer.kennel_id, date, closingTrigger(picked || offer, outcome));
}

// A turn KennelOS offered while her phone was off (W2 step 7;
// waitlistEvents.planServerEvent checked it against her records): the same rows,
// with the server's ids, so the family's pick on it maps to them.
// `turn`: { turn_id, offered_date, respond_by_date, rows: [{ offer_id, litter_id, dog_ids }] }.
export async function applyServerOffer(entryId, turn) {
  const entry = await load(entryId);
  const rows = [];
  for (const r of turn.rows) {
    const had = await waitlistOfferRepo.getById(r.offer_id);
    if (had) { rows.push(had); continue; }
    rows.push(await waitlistOfferRepo.create({
      id: r.offer_id, entry_id: entry.id, litter_id: r.litter_id, kennel_id: entry.kennel_id, turn_id: turn.turn_id,
      offered_date: turn.offered_date, respond_by_date: turn.respond_by_date, eligible_dog_ids: [...r.dog_ids], outcome: 'open',
      notes: 'Offered by KennelOS while your phone was off (your automatic offers).'
    }));
  }
  return turnView(rows);
}

// --- A lost pup (Spec §16.11) ------------------------------------------------------
//
// A family's pup is lost through no fault of theirs: its sale is voided (the pup
// died, or failed a health check before going home) or returned for a health
// problem within the guarantee. She's asked, as she marks the sale, whether to put
// them back in line; nothing here runs by itself.

// The waitlist family a lost sale belongs to, or null: { kind, entry, offer, sale }
// (waitlistRules.lostSaleFamily).
export async function lostSaleFamilyFor(saleId) {
  const sale = await saleRepo.getById(saleId);
  if (!sale || !sale.buyer_contact_id) return null;
  const entries = await waitlistEntryRepo.getByContact(sale.buyer_contact_id);
  const offers = (await Promise.all(entries.map((e) => waitlistOfferRepo.getByEntry(e.id)))).flat();
  const found = lostSaleFamily(sale, entries, offers);
  return found ? { ...found, sale } : null;
}

// Put the family back in line. Never a pass, never a new place:
//  - placed: their accepted offer is voided (not a pass), so that litter is theirs
//    to be offered again, and the entry is active again with its own fee date —
//    their ORIGINAL place — and their passes as they were.
//  - picked (their turn was still open): the pick is cleared and the turn gets a
//    fresh respond-by date to pick another pup; a litter of it with no pup left for
//    them closes (voided, never a pass), and if none is left the turn ends.
// `carry` ({ amount, date }) keeps what they'd paid for their next pup
// (entry.carried_payment: their next pick's sale takes it as its deposit); none =
// she's refunding it. Then the turn moves on like any other moment, `restored`:
// automatic offers on for it and nobody holding a turn → the next turn is offered
// now (to them, when they're next); otherwise who's next is returned.
// Returns { kind, entry, offers, voided, next, waiting }.
export async function restoreAfterLostSale(saleId, { date = todayYMD(), carry = null } = {}) {
  const found = await lostSaleFamilyFor(saleId);
  if (!found) throw new Error('This sale isn\'t a waitlist family\'s lost pup (it must be voided, or returned for a health problem).');
  const { kind, entry, offer, sale } = found;
  const pupName = (await dogRepo.getById(sale.dog_id))?.call_name || 'their pup';
  const why = `${pupName}'s sale was ${sale.status}${sale.end_reason ? ` (${descriptor(SALE_END_REASON, sale.end_reason).label.toLowerCase()})` : ''}`;
  const carried = carry && Number(carry.amount) > 0
    ? { amount: Number(carry.amount), date: carry.date || date, from_sale_id: sale.id } : null;
  const entryNote = (what) => appendNote(entry.notes, `${what} on ${date}: ${why}.${carried ? ` ${money(carried.amount)} they'd paid is carried to their next pup.` : ''}`);
  const result = { kind, entry: null, offers: [], voided: [], next: null, waiting: [] };

  if (kind === 'placed') {
    if (offer) {
      await waitlistOfferRepo.update(offer.id, {
        outcome: 'voided', outcome_date: date, counts_as_pass: false,
        notes: appendNote(offer.notes, `Voided on ${date}: ${why}. The family is back in line, so this litter can be offered to them again. Not a pass.`)
      });
    }
    result.entry = await waitlistEntryRepo.update(entry.id, {
      status: 'active', placed_sale_id: null, ...(carried ? { carried_payment: carried } : {}),
      notes: entryNote('Back on the list in their original place')
    });
    return finishTurn(result, entry.kennel_id, date, 'restored');
  }

  const c = await kennelContext(offer.kennel_id);
  const program = c.programsById.get(entry.waitlist_program_id) || null;
  const respondBy = respondByDate(date, c.config, program);
  for (const o of turnOffers(c.offers, turnIdOf(offer)).filter((x) => x.outcome === 'open')) {
    const litter = c.litters.find((l) => l.id === o.litter_id);
    // Never the lost pup itself, even if she hasn't recorded its death or hold yet.
    const eligible = litter && !litter.is_archived
      ? eligiblePupsFor(entry, litter, c.pups, c.sales, { today: date, config: c.config }).filter((d) => d.id !== sale.dog_id) : [];
    const cleared = o.id === offer.id ? { chosen_dog_id: null, picked_date: null, sale_id: null } : {};
    if (eligible.length) {
      result.offers.push(await waitlistOfferRepo.update(o.id, {
        ...cleared, respond_by_date: respondBy, eligible_dog_ids: eligible.map((d) => d.id),
        notes: appendNote(o.notes, `${o.id === offer.id ? `Pick cleared on ${date}: ${why}. ` : ''}Respond-by date restarted on ${date} so they can pick another pup.`)
      }));
    } else {
      result.voided.push(await waitlistOfferRepo.update(o.id, {
        ...cleared, outcome: 'voided', outcome_date: date, counts_as_pass: false,
        notes: appendNote(o.notes, `Voided on ${date}: ${why}, and no other pup here matches them. Not a pass.`)
      }));
    }
  }
  result.entry = await waitlistEntryRepo.update(entry.id, {
    ...(carried ? { carried_payment: carried } : {}),
    notes: entryNote(result.offers.length ? 'Their turn was given back' : 'Their turn ended with no other pup for them')
  });
  return result.offers.length ? result : finishTurn(result, entry.kennel_id, date, 'restored');
}

// --- The status page (W2 step 5): family actions, requests, messages -------------
//
// A family's actions arrive as events (data/waitlistEvents.js plans each one); a
// request (a pause, a narrower listen-only change, a change to a matching answer)
// waits on the entry until she taps Approve or Decline here, and is then kept,
// marked with her decision, so their page can show it (waitlistProjection).
// `messages` on the entry is the family's activity and their messages to her,
// newest last: { id, at, from: 'family', kind: 'message' | 'action', body, read }.
// Unread ones are a Today nudge.

export const MESSAGES_KEPT = 500;
export const MESSAGE_MAX = 10000;

// Add lines to a family's activity (by id, so the same line is never added twice).
// → the entry, or null when there was nothing new.
export async function addFamilyActivity(entryId, items) {
  const entry = await load(entryId);
  const have = new Set((entry.messages || []).map((m) => m.id));
  const fresh = items.filter((m) => m && m.id && !have.has(m.id)).map((m) => ({
    id: String(m.id), at: m.at || nowISO(), from: m.from === 'server' ? 'server' : 'family', kind: m.kind === 'message' ? 'message' : 'action',
    body: String(m.body ?? '').slice(0, MESSAGE_MAX), read: false
  }));
  if (!fresh.length) return null;
  const messages = [...(entry.messages || []), ...fresh]
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .slice(-MESSAGES_KEPT);
  return waitlistEntryRepo.update(entryId, { messages });
}

export async function markMessagesRead(entryId) {
  const entry = await load(entryId);
  if (!(entry.messages || []).some((m) => !m.read)) return entry;
  return waitlistEntryRepo.update(entryId, { messages: entry.messages.map((m) => ({ ...m, read: true })) });
}

const decided = (req, decision, date) => ({ ...req, decided: decision, decided_date: date });
const pending = (req) => Boolean(req && req.requested_date && !req.decided);
export const hasPendingRequest = (entry, field) => pending(entry && entry[field]);

function loadPending(entry, field, what) {
  if (!pending(entry[field])) throw new Error(`There's no ${what} request waiting for this family.`);
  return entry[field];
}

// Carry out one plan from waitlistEvents.planFamilyEvent. A pick or pass that
// her records refuse after all (the pup was sold a moment ago…) becomes an
// activity line instead, never an error that stops the other events.
// → { done: op, result?, activity: entry | null }
export async function applyFamilyPlan(entryId, plan) {
  const { date } = plan;
  let result = null;
  let activity = plan.activity;
  try {
    switch (plan.op) {
      case 'pick': result = await recordPick(plan.offerId, { chosenDogId: plan.dogId, date }); break;
      case 'pass': result = await recordOutcome(plan.offerId, 'passed', { date, passReason: plan.reason || null, moveOn: plan.moveOn !== false }); break;
      case 'server_close': result = await recordOutcome(plan.offerId, 'no_response', { date, moveOn: plan.moveOn !== false }); break;
      case 'server_offer': result = await applyServerOffer(entryId, plan.turn); break;
      case 'prepass': await addPrepass(entryId, plan.prepass); break;
      case 'unprepass': await removePrepass(entryId, plan.target); break;
      case 'withdraw': result = await withdraw(entryId, { date, moveOn: plan.moveOn !== false }); break;
      case 'pause_request': await waitlistEntryRepo.update(entryId, { pause_request: plan.request }); break;
      case 'ready': await recordReadyAnswer(entryId, { answer: plan.answer, until: plan.until, reason: plan.reason, date, by: 'family' }); break;
      case 'listen_request': await waitlistEntryRepo.update(entryId, { listen_change_request: plan.request }); break;
      case 'pref_request': await waitlistEntryRepo.update(entryId, { pref_change_request: plan.request }); break;
      case 'companion_request': await waitlistEntryRepo.update(entryId, { companion_request: plan.request }); break;
      case 'listen_apply': await waitlistEntryRepo.update(entryId, plan.changes); break;
      case 'note': case 'skip': break;
      default: throw new Error(`Unknown plan "${plan.op}".`);
    }
  } catch (err) {
    if (!activity) throw err;
    activity = { ...activity, body: `${activity.body.replace(/\. Their pick is held.*$/, '.')} It couldn't be recorded: ${err.message}` };
    result = null;
  }
  return { done: plan.op, result, activity: activity ? await addFamilyActivity(entryId, [activity]) : null };
}

// A pause they asked for (Spec §6.3, Q7): approving sets paused_until to their
// date (their note, if any, becomes the pause reason); declining changes nothing.
export async function approvePauseRequest(entryId, { date = todayYMD() } = {}) {
  const entry = await load(entryId);
  const req = loadPending(entry, 'pause_request', 'pause');
  return waitlistEntryRepo.update(entryId, {
    paused_until: req.until, pause_reason: req.note || entry.pause_reason || '', pause_request: decided(req, 'approved', date)
  });
}

export async function declinePauseRequest(entryId, { date = todayYMD() } = {}) {
  const entry = await load(entryId);
  return waitlistEntryRepo.update(entryId, { pause_request: decided(loadPending(entry, 'pause_request', 'pause'), 'declined', date) });
}

// A change to their matching answers (Spec §15.9). Approving applies it and logs
// it `by: 'request'`; declining logs what they asked for with `declined: true`.
// Neither closes an open offer.
export async function approvePrefChange(entryId, { date = todayYMD() } = {}) {
  const entry = await load(entryId);
  const req = loadPending(entry, 'pref_change_request', 'answer-change');
  const lines = prefChangeLines(entry, req.changes || {}, { date, by: 'request' });
  return waitlistEntryRepo.update(entryId, {
    ...(req.changes || {}),
    pref_change_log: [...(entry.pref_change_log || []), ...lines],
    pref_change_request: decided(req, 'approved', date)
  });
}

export async function declinePrefChange(entryId, { date = todayYMD() } = {}) {
  const entry = await load(entryId);
  const req = loadPending(entry, 'pref_change_request', 'answer-change');
  const lines = prefChangeLines(entry, req.changes || {}, { date, by: 'request' }).map((l) => ({ ...l, declined: true }));
  return waitlistEntryRepo.update(entryId, {
    pref_change_log: [...(entry.pref_change_log || []), ...lines],
    pref_change_request: decided(req, 'declined', date)
  });
}

// A narrower listen-only change they asked for (Spec §15.7 item 6).
export async function approveListenChange(entryId, { date = todayYMD() } = {}) {
  const entry = await load(entryId);
  const req = loadPending(entry, 'listen_change_request', 'listen-only');
  return waitlistEntryRepo.update(entryId, {
    listen_mode: req.listen_mode || 'all',
    ...((req.listen_mode || 'all') !== 'all' ? { listen_sire_ids: [...(req.listen_sire_ids || [])], listen_dam_ids: [...(req.listen_dam_ids || [])] } : {}),
    listen_change_request: decided(req, 'approved', date)
  });
}

export async function declineListenChange(entryId, { date = todayYMD() } = {}) {
  const entry = await load(entryId);
  return waitlistEntryRepo.update(entryId, { listen_change_request: decided(loadPending(entry, 'listen_change_request', 'listen-only'), 'declined', date) });
}

// Their Companion link request (Spec §8.3). She sends the link herself from the
// Companion page (her device builds it; it never goes through the server), then
// marks the request sent, or declines it. Either way their page shows it.
export async function markCompanionLinkSent(entryId, { date = todayYMD() } = {}) {
  const entry = await load(entryId);
  return waitlistEntryRepo.update(entryId, { companion_request: decided(loadPending(entry, 'companion_request', 'Companion link'), 'sent', date) });
}

export async function declineCompanionRequest(entryId, { date = todayYMD() } = {}) {
  const entry = await load(entryId);
  return waitlistEntryRepo.update(entryId, { companion_request: decided(loadPending(entry, 'companion_request', 'Companion link'), 'declined', date) });
}

// "Not this litter" (Spec §16.2): a pending pass on a litter (or an upcoming
// pairing), with the family's reason. Nothing counts until their turn comes; one
// per litter, and saying it again replaces it. `prepass` is { litter_id | pairing_id,
// reason: { id, label, text }, date }.
export async function addPrepass(entryId, prepass) {
  const entry = await load(entryId);
  const same = (p) => (prepass.litter_id ? p.litter_id === prepass.litter_id : p.pairing_id === prepass.pairing_id);
  return waitlistEntryRepo.update(entryId, { prepasses: [...(entry.prepasses || []).filter((p) => !same(p)), prepass] });
}

// Take a "Not this litter" back. `target` is { litter_id } or { pairing_id }.
export async function removePrepass(entryId, target) {
  const entry = await load(entryId);
  const same = (p) => (target.litter_id ? p.litter_id === target.litter_id : p.pairing_id === target.pairing_id);
  return waitlistEntryRepo.update(entryId, { prepasses: (entry.prepasses || []).filter((p) => !same(p)) });
}
