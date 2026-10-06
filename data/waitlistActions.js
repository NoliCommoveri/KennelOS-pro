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
// When are offers made without her picking the family? Only when she has turned on
// automatic offers (waitlist_config.auto_offer_next — OFF by default, decided
// 2026-10-06) and an offer on that same litter closes (deposit received / passed /
// no response, or the family left the list while holding it) — the turn moves on,
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
import {
  waitlistConfig, feeForEntry, feeDueDate, anchorDate, canUndoRemoval, passToForgive,
  nextFamilyForLitter, respondByDate, countsAsPass, shouldRemoveForPasses, passesUsed, isPupAvailable,
  hasOpenOffer, turnSpent, eligiblePupsFor, isAwaitingDeposit, canSwitchAcceptedPick, undoPassBlocker
} from './waitlistRules.js';

const nowISO = () => new Date().toISOString();
const appendNote = (notes, line) => [notes, line].filter(Boolean).join('\n');

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
export async function withdraw(entryId, { date = todayYMD() } = {}) {
  const entry = await load(entryId);
  requireStatus(entry, ['applied', 'approved', 'active'], 'withdraw');
  const saved = await waitlistEntryRepo.update(entryId, { status: 'withdrawn', withdrawn_date: date });
  return { entry: saved, ...(await releaseOpenOffers(entryId, { date, why: 'the family withdrew from the list' })) };
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
    pref_placement_type: entry.pref_placement_type || '',
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

// --- Offers (Spec §6.4–§6.5) ------------------------------------------------------

// Everything the rules need to decide a litter's next offer.
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

// Offer the turn on this litter to the next eligible family, if picks are open
// and no offer is open yet. Returns the new offer, or null (picks closed, an offer
// already open, or nobody eligible left). One open offer per litter (Spec §6.5).
export async function offerNext(litterId, { today = todayYMD() } = {}) {
  const c = await litterContext(litterId);
  if (!c.litter.picks_opened_date || c.litter.is_archived) return null;
  const next = nextFamilyForLitter(c.entries, c.offers, c.litter, c.pups, c.sales, {
    today, config: c.config, programsById: c.programsById
  });
  if (!next) return null;
  const program = c.programsById.get(next.entry.waitlist_program_id) || null;
  return waitlistOfferRepo.create({
    entry_id: next.entry.id,
    litter_id: c.litter.id,
    kennel_id: c.litter.kennel_id,
    offered_date: today,
    respond_by_date: respondByDate(today, c.config, program),
    eligible_dog_ids: next.eligibleDogs.map((d) => d.id),
    outcome: 'open'
  });
}

// Offer one family a litter from their own page (Spec §15.2): the waitlist as the
// main workflow. Opens picks on the litter if they aren't open yet. The family
// must be eligible for at least one available pup, nobody else may hold an open
// offer on the litter (one at a time, §6.5), and the family's turn on it mustn't
// already be spent. Offering out of order is allowed — the page confirms it with
// her first and passes `note` saying who was next — and nothing about anyone
// else's place changes. Returns the new offer.
export async function offerTo(litterId, entryId, { today = todayYMD(), note = '' } = {}) {
  const c = await litterContext(litterId);
  if (c.litter.is_archived) throw new Error('That litter is archived.');
  const entry = c.entries.find((e) => e.id === entryId);
  if (!entry || entry.status !== 'active') throw new Error('Only families on the list can be offered a litter.');
  if (hasOpenOffer(c.offers, litterId)) throw new Error('Another family already has an open offer on this litter. Record how it ended first.');
  if (turnSpent(c.offers, litterId, entryId)) throw new Error('This family has already had their turn on this litter.');
  const eligible = eligiblePupsFor(entry, c.litter, c.pups, c.sales, { today, config: c.config });
  if (!eligible.length) throw new Error('No available pup in this litter matches this family right now.');
  if (!c.litter.picks_opened_date) await litterRepo.update(litterId, { picks_opened_date: today });
  const program = c.programsById.get(entry.waitlist_program_id) || null;
  return waitlistOfferRepo.create({
    entry_id: entry.id,
    litter_id: litterId,
    kennel_id: c.litter.kennel_id,
    offered_date: today,
    respond_by_date: respondByDate(today, c.config, program),
    eligible_dog_ids: eligible.map((d) => d.id),
    outcome: 'open',
    notes: note || ''
  });
}

// A family leaving the list (withdrew, removed, archived, accepted elsewhere)
// can't keep holding a litter's turn: void each open offer they have (never a
// pass) and move that litter on to its next family. Returns { voided, offered } —
// the closed offers and the new ones — so the page can say who to contact.
// A pick they were holding is let go too (its deposit-pending Sale is cancelled).
// Returns { voided, offered, waiting }.
async function releaseOpenOffers(entryId, { date = todayYMD(), why, exceptOfferId = null } = {}) {
  const open = (await waitlistOfferRepo.getByEntry(entryId))
    .filter((o) => o.id !== exceptOfferId && o.outcome === 'open' && !o.is_archived);
  const voided = [];
  const offered = [];
  const waiting = [];
  for (const o of open) {
    await releasePick(o, { date, why, strict: false });
    voided.push(await waitlistOfferRepo.update(o.id, {
      outcome: 'voided', outcome_date: date, counts_as_pass: false,
      notes: appendNote(o.notes, `Voided automatically: ${why}.`)
    }));
    const moved = await moveTurnOn(o.litter_id, { today: date });
    if (moved.next) offered.push(moved.next);
    if (moved.waiting) waiting.push(moved.waiting);
  }
  return { voided, offered, waiting };
}

// The turn on this litter moved on (an offer closed, or its family left the list).
// With automatic offers on, the next family is offered now (picks must be open);
// with them off (the default), nobody is offered and the family who's next is
// returned so the page can tell her. Returns { next, waiting } — at most one set.
async function moveTurnOn(litterId, { today = todayYMD() } = {}) {
  const c = await litterContext(litterId);
  if (c.config.auto_offer_next) return { next: await offerNext(litterId, { today }), waiting: null };
  if (c.litter.is_archived) return { next: null, waiting: null };
  const n = nextFamilyForLitter(c.entries, c.offers, c.litter, c.pups, c.sales, {
    today, config: c.config, programsById: c.programsById
  });
  return { next: null, waiting: n ? { litter_id: litterId, entry_id: n.entry.id } : null };
}

// Fold moveTurnOn's answer into an action's result.
async function finishTurn(result, litterId, today) {
  const moved = await moveTurnOn(litterId, { today });
  result.next = moved.next;
  if (moved.waiting) result.waiting = [...(result.waiting || []), moved.waiting];
  return result;
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
    if (strict && !['cancelled', 'returned'].includes(sale.status)) {
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

// The family picked a pup (Spec §6.5): create the Sale (deposit pending, buyer =
// the family, price/deposit prefilled) to hold it while they send the deposit. The
// offer stays OPEN — nothing moves on, the family stays on the list — and the
// respond-by date is still their deadline, now for the deposit. Returns { offer, sale }.
export async function recordPick(offerId, { chosenDogId, date = todayYMD() } = {}) {
  const offer = await loadOpenOffer(offerId);
  if (offer.chosen_dog_id) throw new Error('They\'ve already picked a pup. Use "Change pup" to switch.');
  const entry = await load(offer.entry_id);
  if (!entry.contact_id) throw new Error('This family has no contact record.');
  const c = await litterContext(offer.litter_id);
  const dog = c.pups.find((d) => d.id === chosenDogId);
  if (!dog) throw new Error('Pick one of this litter\'s pups.');
  if (!isPupAvailable(dog, c.sales)) throw new Error(`${dog.call_name} is no longer available.`);
  const sale = await saleRepo.create({
    dog_id: dog.id,
    buyer_contact_id: entry.contact_id,
    placement_type: dog.intended_placement || entry.pref_placement_type || 'pet',
    status: 'deposit_pending',
    kennel_id: dog.kennel_id || c.litter.kennel_id,
    sale_date: date,
    lead_source: 'Waitlist',
    ...expectedPricing(dog, c.litter)
  });
  const saved = await waitlistOfferRepo.update(offerId, { chosen_dog_id: dog.id, picked_date: date, sale_id: sale.id });
  return { offer: saved, sale };
}

// Switch the pup a family picked (Spec §6.5 — they clicked the wrong one). Allowed
// while the deposit is pending, and after it too as long as nobody else has been
// offered this litter since. The same Sale moves to the new pup; its price and
// deposit follow the new pup's expected amounts only where she hasn't changed them
// (and a paid deposit is never touched). Returns { offer, sale }.
export async function changePick(offerId, { chosenDogId, date = todayYMD() } = {}) {
  const offer = await loadOffer(offerId);
  const c = await litterContext(offer.litter_id);
  const accepted = offer.outcome === 'accepted';
  if (accepted && !canSwitchAcceptedPick(offer, c.offers)) {
    throw new Error('Another family has been offered this litter since, so the pup can\'t be switched here. Change it on the sale.');
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
  const was = expectedPricing(oldDog, c.litter);
  const now = expectedPricing(dog, c.litter);
  const changes = { dog_id: dog.id, placement_type: dog.intended_placement || sale.placement_type };
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
// placed, the offer is accepted, the family is placed and leaves the list (their
// other open offers are voided, never a pass), and the turn moves on. Returns the
// same shape as recordOutcome.
export async function confirmDeposit(offerId, { date = todayYMD(), amount } = {}) {
  const offer = await loadOpenOffer(offerId);
  if (!isAwaitingDeposit(offer) || !offer.sale_id) throw new Error('Record which pup they picked first.');
  const entry = await load(offer.entry_id);
  const sale = await heldSale(offer);
  if (!sale || sale.is_archived || ['cancelled', 'returned'].includes(sale.status)) {
    throw new Error('The sale holding their pick was cancelled or archived. Void this offer, or open the sale and fix it first.');
  }
  const saleChanges = { deposit_date: date };
  if (sale.status === 'deposit_pending') saleChanges.status = 'deposit_paid';
  if (amount !== undefined && amount !== null && amount !== '') saleChanges.deposit_amount = Number(amount);
  const result = { offer: null, sale: null, removed: false, passes: null, next: null, voided: [], offered: [], waiting: [] };
  result.sale = await saleRepo.update(sale.id, saleChanges);
  await dogRepo.update(offer.chosen_dog_id, { disposition: 'placed' });
  result.offer = await waitlistOfferRepo.update(offerId, { outcome: 'accepted', outcome_date: date, counts_as_pass: false });
  await waitlistEntryRepo.update(entry.id, { status: 'placed', placed_sale_id: sale.id });
  // Their other open offers end too — never a pass (Spec §6.4 leaning).
  Object.assign(result, await releaseOpenOffers(entry.id, { date, why: 'the family accepted a pup from another litter', exceptOfferId: offerId }));
  return finishTurn(result, offer.litter_id, date);
}

// Undo a pass or no response (Spec §6.4): the family is next in line for this
// litter again. Their offer reopens with a fresh respond-by date and the pass no
// longer counts; if that pass had removed them (second pass), they're back on the
// list. A family holding this litter's turn meanwhile has their offer voided —
// never a pass, and they're next again once this family's turn settles — unless
// they've already picked a pup (then she settles that first). Makes no other offer.
// Returns { offer, voided, restored }.
export async function undoPass(offerId, { today = todayYMD() } = {}) {
  const offer = await loadOffer(offerId);
  const entry = await load(offer.entry_id);
  const blocker = undoPassBlocker(offer, entry, today);
  if (blocker) throw new Error(blocker);
  const c = await litterContext(offer.litter_id);
  if (c.litter.is_archived) throw new Error('That litter is archived.');
  const holder = c.offers.find((o) => o.id !== offer.id && !o.is_archived && o.outcome === 'open');
  if (holder && isAwaitingDeposit(holder)) {
    throw new Error('The family holding this litter\'s turn now has already picked a pup. Record their deposit or void their offer first.');
  }
  const eligible = eligiblePupsFor({ ...entry, status: 'active' }, c.litter, c.pups, c.sales, { today, config: c.config });
  if (!eligible.length) {
    throw new Error('They can\'t be offered this litter right now (no matching pup left, paused, or listening for other litters), so there\'s no turn to give back.');
  }
  const program = c.programsById.get(entry.waitlist_program_id) || null;
  const result = { offer: null, voided: [], restored: false };
  if (holder) {
    result.voided.push(await waitlistOfferRepo.update(holder.id, {
      outcome: 'voided', outcome_date: today, counts_as_pass: false,
      notes: appendNote(holder.notes, 'Voided automatically: you undid an earlier pass on this litter, so that family got their turn back. Not a pass; this family is next again after them.')
    }));
  }
  if (entry.status === 'removed') {
    await waitlistEntryRepo.update(entry.id, { status: 'active', removed_date: null, removed_reason: null });
    result.restored = true;
  }
  const label = offer.outcome === 'passed' ? 'Pass' : 'No response';
  result.offer = await waitlistOfferRepo.update(offerId, {
    outcome: 'open', outcome_date: null, counts_as_pass: false,
    respond_by_date: respondByDate(today, c.config, program),
    eligible_dog_ids: eligible.map((d) => d.id),
    notes: appendNote(offer.notes, `${label} undone by you on ${today}; their turn is back with a new respond-by date.`)
  });
  return result;
}

// **Open picks** (Spec §6.5): stamp the litter and offer the first family.
export async function openPicks(litterId, { date = todayYMD() } = {}) {
  await litterRepo.update(litterId, { picks_opened_date: date });
  return offerNext(litterId, { today: date });
}

// Stop making new offers on this litter. An open offer stays open until she
// records its outcome.
export async function closePicks(litterId) {
  return litterRepo.update(litterId, { picks_opened_date: null });
}

// Record how an open offer ended. `outcome` is accepted / passed / no_response /
// voided. Returns { offer, sale, removed, passes, next, voided, offered, waiting }
// for the page's message: `next` is this litter's new offer (automatic offers on),
// `waiting` who's next when they're off; `voided` / `offered` are the family's
// OTHER open offers that closed because they left the list, and the offers those
// litters moved on to.
//  - accepted: the pick AND the deposit at once — needs `chosenDogId` (an available
//    pup from this litter) unless they've already picked; `depositDate` /
//    `depositAmount` are optional. Same as recordPick + confirmDeposit.
//  - passed / no_response: a pick they were holding lapses (its Sale is cancelled).
//    counts_as_pass is decided now and frozen (§6.4); at the pass limit the entry is
//    removed (second_pass, with a 7-day undo) and their other open offers are voided too.
//  - voided: never a pass; a held pick lapses. The turn is NOT moved on (she voided
//    it for a reason; the same family would just be offered again) — she offers the
//    next family from the litter page.
// After passed/no_response the turn moves on (moveTurnOn).
export async function recordOutcome(offerId, outcome, { date = todayYMD(), chosenDogId = null, depositDate = null, depositAmount } = {}) {
  const offer = await loadOpenOffer(offerId);
  const entry = await load(offer.entry_id);

  if (outcome === 'accepted') {
    if (!offer.chosen_dog_id) await recordPick(offerId, { chosenDogId, date });
    else if (chosenDogId && chosenDogId !== offer.chosen_dog_id) await changePick(offerId, { chosenDogId, date });
    return confirmDeposit(offerId, { date: depositDate || date, amount: depositAmount });
  }

  const result = { offer: null, sale: null, removed: false, passes: null, next: null, voided: [], offered: [], waiting: [] };
  if (outcome === 'passed' || outcome === 'no_response') {
    await releasePick(offer, { date, why: outcome === 'passed' ? 'they passed' : 'no deposit by the deadline' });
    const [kennel, program] = await Promise.all([
      kennelRepo.getById(entry.kennel_id),
      entry.waitlist_program_id ? waitlistProgramRepo.getById(entry.waitlist_program_id) : null
    ]);
    const config = waitlistConfig(kennel);
    result.offer = await waitlistOfferRepo.update(offerId, {
      outcome, outcome_date: date, counts_as_pass: countsAsPass(outcome, { config, program })
    });
    const offers = await waitlistOfferRepo.getByEntry(entry.id);
    result.passes = { used: passesUsed(entry, offers), max: Number(config.max_passes), counted: result.offer.counts_as_pass };
    if (shouldRemoveForPasses(entry, offers, config)) {
      await waitlistEntryRepo.update(entry.id, { status: 'removed', removed_date: date, removed_reason: 'second_pass' });
      result.removed = true;
      Object.assign(result, await releaseOpenOffers(entry.id, { date, why: 'the family was removed after their last pass', exceptOfferId: offerId }));
    }
  } else if (outcome === 'voided') {
    await releasePick(offer, { date, why: 'you voided the offer' });
    result.offer = await waitlistOfferRepo.update(offerId, { outcome: 'voided', outcome_date: date, counts_as_pass: false });
    return result;
  } else {
    throw new Error(`Unknown outcome "${outcome}".`);
  }

  return finishTurn(result, offer.litter_id, date);
}
