// kennelSetup.js — the "your kennel and owner name" startup wizard. Creates
// real Kennel/Contact records through the repo layer (same reasoning as
// sampleData.js: no shadow data, no validation rules that only apply to some
// records). Companion to sampleData.js/settings.js in the data layer.
import { kennelRepo } from './kennelRepo.js';
import { contactRepo } from './contactRepo.js';
import { hasSampleData } from './sampleData.js';
import { hasOwnKennel } from './kennelScope.js';
import {
  getMyKennelId, setMyKennelId,
  getMyContactId, setMyContactId,
  wasSampleDataCleared
} from './settings.js';

export function hasMyKennelSetup() {
  return getMyKennelId() != null;
}

// The MANDATORY first-run gate (Multi-Kennel Scope Spec §3.2). Required, not
// offered: from the multi-kennel work on, every owned dog carries a required
// kennel_id, so the app isn't usable until one own kennel exists.
//
// Two things about the condition are load-bearing:
//  - It tests "does an OWN KENNEL exist", not "is myKennelId set" (§3.2.4). The
//    guided tour seeds an own kennel without ever setting myKennelId — only
//    completeKennelSetup does — so testing the setting would trap tour users
//    behind an unclosable modal.
//  - There is no skip term any more. Removing it is what turns app.js's existing
//    fall-through into the gate: declineSampleData() marks the cleared flag, so
//    the load after a dismissed modal already lands here (§3.2.3). Nothing else
//    was needed to make it re-fire until satisfied.
export async function shouldRequireKennelSetup() {
  if (hasSampleData() || !wasSampleDataCleared()) return false;
  return !(await hasOwnKennel());
}

// Current values, for prefilling the wizard when it's reopened to make a
// change rather than run for the first time.
export async function getKennelSetupState() {
  const kennelId = getMyKennelId();
  const contactId = getMyContactId();
  const [kennel, contact] = await Promise.all([
    kennelId ? kennelRepo.getById(kennelId) : null,
    contactId ? contactRepo.getById(contactId) : null
  ]);
  return { kennelName: kennel?.kennel_name || '', ownerName: contact?.name || '' };
}

// kennelName is required (mirrors kennelRepo's own validation); ownerName is
// optional — leaving it blank just means no Contact is created yet, and the
// "prefill owner" behavior on new dogs stays inactive until one is. Reopening
// the wizard when a kennel/contact is already set UPDATES those same records
// rather than creating duplicates.
//
// This wizard is definitionally about the user's OWN kennel, so it always
// stamps is_own_kennel: true — on first creation and again on every reopen, in
// case an older run predates the flag (Own-Kennel Identity addendum).
export async function completeKennelSetup({ kennelName, ownerName }) {
  const existingKennelId = getMyKennelId();
  const existingKennel = existingKennelId ? await kennelRepo.getById(existingKennelId) : null;
  const kennel = existingKennel
    ? await kennelRepo.update(existingKennel.id, { kennel_name: kennelName, is_own_kennel: true })
    : await kennelRepo.create({ kennel_name: kennelName, is_own_kennel: true });
  setMyKennelId(kennel.id);

  let contact = null;
  if (ownerName) {
    const existingContactId = getMyContactId();
    const existingContact = existingContactId ? await contactRepo.getById(existingContactId) : null;
    // Link the owner Contact to the kennel just created/updated above — this is
    // definitionally the breeder's own contact at their own kennel, so it should
    // never come out unlinked (kennel_id drives Furever/Companion prefill and the
    // Kennel detail page's own-kennel views).
    contact = existingContact
      ? await contactRepo.update(existingContact.id, { name: ownerName, kennel_id: kennel.id })
      : await contactRepo.create({ name: ownerName, kennel_id: kennel.id });
    setMyContactId(contact.id);
  }
  return { kennel, contact };
}

// For the nav banner: the current kennel name, or null if not set up (or the
// record was since deleted out from under the setting).
export async function getMyKennelName() {
  const id = getMyKennelId();
  if (!id) return null;
  const kennel = await kennelRepo.getById(id);
  return kennel ? kennel.kennel_name : null;
}

export { getMyContactId };
