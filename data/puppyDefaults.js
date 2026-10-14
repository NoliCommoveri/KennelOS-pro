// puppyDefaults.js — what a new puppy record inherits from its litter. Shared by
// the Litter page's Add Puppy / Add several puppies forms (assets/puppyForm.js)
// and the guided "Record a new litter" flow (data/guidedLitter.js), so a pup is
// filled in the same way whichever door she used. Pure: no db, no DOM.
import { todayYMD } from './dateUtils.js';

// Fields carried from the litter onto each new puppy record. whelp_date only
// carries into date_of_birth once it's an actual (not projected) date — a
// litter can still be "Expected" with a future whelp_date when placeholders
// get added, and Dog rejects a future date_of_birth outright.
export function baseFromLitter(litter, dam) {
  // Breeder kennel inherits the dam's own kennel_id when she's your own dog
  // (owned/co-owned) — the same "dam is my dog" rule dog.js applies when a
  // Litter is linked after the fact. A dam you don't own says nothing about
  // which of your kennels bred this puppy, so it's left for the user to set.
  const damIsMine = dam && ['owned', 'co_owned'].includes(dam.ownership_type);
  return {
    litter_id: litter.id,
    dam_id: litter.dam_id || null,
    sire_id: litter.sire_id || null,
    breed: dam?.breed || '',        // breed comes from the dam
    date_of_birth: (litter.whelp_date && litter.whelp_date <= todayYMD()) ? litter.whelp_date : '',
    status: 'puppy',
    ownership_type: 'owned',
    breeder_kennel_id: damIsMine ? (dam.kennel_id || null) : null,
    // Kennel scope (Multi-Kennel Scope Spec §6): the puppy is ours (ownership_type
    // 'owned' above), so it needs a required own-kennel scope — inherited from the
    // LITTER, not the dam. The litter is the thing that belongs to a kennel, and on
    // a foster-in litter the dam's kennel is somebody else's. Distinct from
    // breeder_kennel_id above, which records who BRED the pup.
    kennel_id: litter.kennel_id || null
  };
}
