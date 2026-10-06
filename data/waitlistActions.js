// waitlistActions.js — the waitlist's multi-step writes (Waitlist Spec §5–§6;
// End-State guide §29): approve, decline, fee received, withdraw, remove, the
// second-pass undo, re-apply, the manual position override, and the offer flow
// (open picks, offer the next family, record an outcome — accept creates the
// Sale). Pages and Today's nudges call these rather than stitching repo writes
// together. Every decision comes from waitlistRules.js; this module only writes.
//
// W1 sends nothing: no emails, no status page. She messages families herself.
// Nothing here runs on page load: every write follows a tap (Spec §0).
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
  nextFamilyForLitter, respondByDate, countsAsPass, shouldRemoveForPasses, passesUsed, isPupAvailable
} from './waitlistRules.js';

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
    Object.assign(changes, { status: 'active', fee_received_date: date, fee_payment_method: 'Waived' });
  }
  const saved = await waitlistEntryRepo.update(entryId, changes);
  if (saved.status === 'active') await advanceKennel(saved.kennel_id, { today: date });
  return saved;
}

export async function decline(entryId, { date = todayYMD() } = {}) {
  const entry = await load(entryId);
  requireStatus(entry, ['applied'], 'decline');
  return waitlistEntryRepo.update(entryId, { status: 'declined', declined_date: date });
}

// Fee received — this fixes the family's place in line (fee_received_date is the
// position anchor, §6.1). Also used with a null fee ("Add to the list").
export async function feeReceived(entryId, { date = todayYMD(), amount, method = '', reference = '' } = {}) {
  const entry = await load(entryId);
  requireStatus(entry, ['approved'], 'mark the fee received for');
  const changes = {
    status: 'active',
    fee_received_date: date,
    fee_payment_method: method,
    fee_payment_reference: reference
  };
  if (amount !== undefined) changes.fee_amount = amount === '' || amount == null ? null : Number(amount);
  const saved = await waitlistEntryRepo.update(entryId, changes);
  // A new family on the list may be next for a litter whose picks are open (§6.5).
  await advanceKennel(saved.kennel_id);
  return saved;
}

export async function markFeeExpired(entryId) {
  const entry = await load(entryId);
  requireStatus(entry, ['approved'], 'expire');
  return waitlistEntryRepo.update(entryId, { status: 'expired' });
}

// The family left the list themselves (they told her).
export async function withdraw(entryId, { date = todayYMD() } = {}) {
  const entry = await load(entryId);
  requireStatus(entry, ['applied', 'approved', 'active'], 'withdraw');
  return waitlistEntryRepo.update(entryId, { status: 'withdrawn', withdrawn_date: date });
}

// She removes a family from the list. Final: coming back means re-applying.
export async function removeByBreeder(entryId, { date = todayYMD() } = {}) {
  const entry = await load(entryId);
  requireStatus(entry, ['active'], 'remove');
  return waitlistEntryRepo.update(entryId, { status: 'removed', removed_date: date, removed_reason: 'by_breeder' });
}

// The 7-day undo on a second-pass removal (§6.4). Forgives the triggering pass so
// the family isn't removed again at once; their anchor is untouched, so they're
// back at their old place.
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
  const saved = await waitlistEntryRepo.update(entryId, { status: 'active', removed_date: null, removed_reason: null });
  await advanceKennel(saved.kennel_id, { today });
  return saved;
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

// Every open-picks litter of a kennel gets a chance at its next offer — after a
// family joins the list, or is restored to it.
export async function advanceKennel(kennelId, { today = todayYMD() } = {}) {
  const litters = (await litterRepo.getAll()).filter((l) => l.kennel_id === kennelId && l.picks_opened_date);
  for (const l of litters) await offerNext(l.id, { today });
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
// voided. Returns { offer, sale, removed, passes, next } for the page's message.
//  - accepted: needs `chosenDogId` (an available pup from this litter). Creates the
//    Sale (deposit_pending, prefilled price/deposit, buyer = the family), marks the
//    pup placed, the entry `placed`, and voids the family's other open offers.
//  - passed / no_response: counts_as_pass is decided now and frozen (§6.4); at the
//    pass limit the entry is removed (second_pass, with a 7-day undo).
//  - voided: never a pass. The turn is NOT moved on automatically (she voided it
//    for a reason; the same family would just be offered again) — she offers the
//    next family from the litter page.
// After accepted/passed/no_response the turn moves on (offerNext).
export async function recordOutcome(offerId, outcome, { date = todayYMD(), chosenDogId = null } = {}) {
  const offer = await waitlistOfferRepo.getById(offerId);
  if (!offer) throw new Error('That offer no longer exists.');
  if (offer.outcome !== 'open') throw new Error('This offer has already been closed.');
  const entry = await load(offer.entry_id);
  const result = { offer: null, sale: null, removed: false, passes: null, next: null };

  if (outcome === 'accepted') {
    const c = await litterContext(offer.litter_id);
    const dog = c.pups.find((d) => d.id === chosenDogId);
    if (!dog) throw new Error('Pick one of this litter\'s pups.');
    if (!isPupAvailable(dog, c.sales)) throw new Error(`${dog.call_name} is no longer available.`);
    if (!entry.contact_id) throw new Error('This family has no contact record.');
    result.sale = await saleRepo.create({
      dog_id: dog.id,
      buyer_contact_id: entry.contact_id,
      placement_type: dog.intended_placement || entry.pref_placement_type || 'pet',
      status: 'deposit_pending',
      kennel_id: dog.kennel_id || c.litter.kennel_id,
      sale_date: date,
      lead_source: 'Waitlist',
      ...expectedPricing(dog, c.litter)
    });
    await dogRepo.update(dog.id, { disposition: 'placed' });
    result.offer = await waitlistOfferRepo.update(offerId, {
      outcome: 'accepted', outcome_date: date, chosen_dog_id: dog.id, counts_as_pass: false
    });
    await waitlistEntryRepo.update(entry.id, { status: 'placed', placed_sale_id: result.sale.id });
    // Their other open offers end too — never a pass (Spec §6.4 leaning).
    const others = (await waitlistOfferRepo.getByEntry(entry.id)).filter((o) => o.id !== offerId && o.outcome === 'open' && !o.is_archived);
    for (const o of others) {
      await waitlistOfferRepo.update(o.id, {
        outcome: 'voided', outcome_date: date, counts_as_pass: false,
        notes: [o.notes, 'Voided automatically: the family accepted a pup from another litter.'].filter(Boolean).join('\n')
      });
      await offerNext(o.litter_id, { today: date });
    }
  } else if (outcome === 'passed' || outcome === 'no_response') {
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
    }
  } else if (outcome === 'voided') {
    result.offer = await waitlistOfferRepo.update(offerId, { outcome: 'voided', outcome_date: date, counts_as_pass: false });
    return result;
  } else {
    throw new Error(`Unknown outcome "${outcome}".`);
  }

  result.next = await offerNext(offer.litter_id, { today: date });
  return result;
}
