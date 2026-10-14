// salePrompts.js — settling the pup when a sale ends without it staying placed
// (Returned / Cancelled / Voided): record its death, put it on Health hold, set its
// disposition back, or bring a returned pup back as a puppy. Each step is an
// optional prompt. Shared by the Sale page (as she edits the status) and the
// waitlist family's page ("End the sale…", waitlistUI.endSaleDialog), so the two
// always do the same thing. The Sale page also uses promptDisposition on a new sale.
import { dogRepo } from '../data/dogRepo.js';
import { SALE_STATUS, DISPOSITION, DOG_STATUS, REGISTRATION_TYPE, descriptor } from '../data/vocab.js';
import { todayYMD, fmtMoney, selectModal, promptModal, confirmModal } from './ui.js';

// Offer to set the sold dog's disposition (breeder intent). `defaultValue` seeds
// the dropdown (Placed on a new sale; Available when a sale falls through). Skips
// the write when the choice matches what the dog already has.
export async function promptDisposition(sale, { title, message, defaultValue }) {
  const dog = await dogRepo.getById(sale.dog_id);
  if (!dog) return;
  // Disposition is a puppy-only field (vocab.js) — never offer to set one on a
  // dog that's moved past the puppy life-stage (e.g. a sale delivered as
  // External flips the dog to external_reference just above this call).
  if (dog.status !== 'puppy') return;
  const choice = await selectModal({
    title, message, label: 'Disposition',
    options: DISPOSITION, defaultValue, confirmLabel: 'Update', cancelLabel: 'Skip'
  });
  if (choice && choice !== dog.disposition) await dogRepo.update(dog.id, { disposition: choice });
}

// The pup of a sale that just ended without it staying placed. Pup died → offer to
// record the death (status Deceased + date), then to archive the pup. A health reason → disposition prompt
// defaulting to Health hold (not for sale, never offered). Anything else → back to
// Available, as before. `onError(message)` shows a dog update that failed (the
// sale itself is already saved).
const HEALTH_END_REASONS = ['failed_health_check', 'health_problem'];
export async function promptReleasedPup(sale, { onError = () => {} } = {}) {
  if (sale.end_reason === 'pup_died') {
    const dog = await dogRepo.getById(sale.dog_id);
    if (!dog || dog.status === 'deceased') return;
    const date = await promptModal({
      title: `Record ${dog.call_name}'s death?`,
      message: `Marks ${dog.call_name} Deceased, so no one is offered this pup again.`,
      label: 'Date of death', type: 'date', defaultValue: todayYMD(), confirmLabel: 'Record', cancelLabel: 'Skip'
    });
    if (date == null) return;
    let dead;
    try {
      dead = await dogRepo.update(dog.id, { status: 'deceased', date_of_death: date });
    } catch (e) {
      onError(`${dog.call_name}'s death wasn't recorded: ${e.message || e} Record it on the dog's page.`);
      return;
    }
    // A pup that died comes off the Dogs list (archived; Lite: removed from the
    // program) — offered, never automatic. Loaded on demand: a rare path.
    if (dog.status === 'puppy') {
      const { deceasedArchiveAction } = await import('../data/nudges.js');
      const action = deceasedArchiveAction(dead);
      if (await confirmModal(action.ask)) {
        try { await action.run(); } catch (e) { onError(`${dog.call_name} wasn't archived: ${e.message || e}`); }
      }
    }
    return;
  }
  const health = HEALTH_END_REASONS.includes(sale.end_reason);
  if (sale.status === 'returned' && await promptBackAsPuppy(sale, health, onError)) return;
  await promptDisposition(sale, {
    title: 'Update this dog’s disposition?',
    message: health
      ? `This sale is now "${descriptor(SALE_STATUS, sale.status).label}" for a health reason. Health hold keeps the pup from being offered until you change it.`
      : `This sale is now "${descriptor(SALE_STATUS, sale.status).label}" — update the dog's disposition back?`,
    defaultValue: health ? 'health_hold' : 'available'
  });
}

// A returned pup that was marked as gone home (Pet home, or External after the
// delivery prompt) is back with you: offer to make it a puppy again — owned, with a
// disposition (Health hold for a health return) — so it shows in its litter and
// the waitlist sees it right. Skip leaves the dog as it is (e.g. an adult dog
// returned long after). Resolves true when it was handled here.
async function promptBackAsPuppy(sale, health, onError) {
  const dog = await dogRepo.getById(sale.dog_id);
  if (!dog || dog.is_archived || !['pet_home', 'external_reference'].includes(dog.status)) return false;
  const choice = await selectModal({
    title: `${dog.call_name} is back with you`,
    message: `${dog.call_name} is marked ${descriptor(DOG_STATUS, dog.status).label}. Bring ${dog.call_name} back into your program as a puppy?${health ? ' Health hold keeps the pup from being offered until you change it.' : ''}`,
    label: 'Disposition', options: DISPOSITION.filter((o) => o.value !== 'placed'),
    defaultValue: health ? 'health_hold' : 'available', confirmLabel: 'Bring back', cancelLabel: 'Skip'
  });
  if (!choice) return true;
  const changes = { status: 'puppy', disposition: choice };
  if (dog.ownership_type === 'external') Object.assign(changes, { ownership_type: 'owned', owner_contact_id: null });
  try {
    await dogRepo.update(dog.id, changes);
  } catch (e) {
    onError(`${dog.call_name} wasn't updated: ${e.message || e} Change it on the dog's page.`);
  }
  return true;
}

// A sale's registration changed (decided 2026-10-11): ask whether its price follows.
// `change` is saleDefaults.priceForRegistrationChange's result. Resolves the new
// price, or null to keep the price as it is. A sale with no price yet just takes
// the new expected price, no question asked.
export async function askRegistrationPrice(change, fromReg, toReg) {
  if (!change) return null;
  if (change.from == null) return change.to;
  if (change.from === change.to) return null;
  const label = (r) => (r ? descriptor(REGISTRATION_TYPE, r).label : 'No registration');
  const ok = await confirmModal({
    title: 'Update the price?',
    message: `${label(fromReg)} → ${label(toReg)} ${change.delta > 0 ? 'adds' : 'takes off'} ${fmtMoney(Math.abs(change.delta))} on this litter's expected prices (its Full-registration surcharge). Change the price from ${fmtMoney(change.from)} to ${fmtMoney(change.to)}?`,
    confirmLabel: `Make it ${fmtMoney(change.to)}`, cancelLabel: `Keep ${fmtMoney(change.from)}`
  });
  return ok ? change.to : null;
}
