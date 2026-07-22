// litterRepo.js — all Dexie access for the Litter table. A litter's own sire_id/
// dam_id are AUTHORITATIVE for the litter (Data Model §5.4); pairing_id is the
// canonical, nullable link to the pairing that produced it. The puppy roster is
// NOT stored here — it's derived (`Dog WHERE litter_id = this.id`).
import { db } from './db.js';
import { makeRepo } from './repoBase.js';
import { LITTER_REFERENCES } from './referenceRegistry.js';
import { FOSTER_DIRECTION, FOSTER_COMP_MODEL } from './vocab.js';
import { enforceLitterCap } from './editionConfig.js';

const base = makeRepo('litters', LITTER_REFERENCES);

// Required to save (Stage 3 Brief §3). Everything else is warn-only in the UI:
// sex mismatch, sync-and-warn against a linked pairing's parents, future whelp
// date past a whelped+ status, and born_alive+born_deceased > born_total.
const REQUIRED_FIELDS = ['dam_id', 'sire_id', 'status'];

const FOSTER_DIRECTIONS = FOSTER_DIRECTION.map((d) => d.value);
const FOSTER_COMP_MODELS = FOSTER_COMP_MODEL.map((m) => m.value);

function validateLitter(candidate) {
  for (const f of REQUIRED_FIELDS) {
    if (candidate[f] == null || candidate[f] === '') {
      throw new Error(`Litter: "${f}" is required.`);
    }
  }
  // Foster (guide §4, version(2)): the only two hard foster rules. A set
  // foster_direction must be a known value, and a share % (documentation for the
  // owner/caretaker income split — the real payout is a `foster_split` Expense)
  // must be a sane 0–100. Everything else foster stays warn-only in the UI, in
  // keeping with the litter's deliberately loose validation below.
  if (candidate.foster_direction != null && candidate.foster_direction !== ''
      && !FOSTER_DIRECTIONS.includes(candidate.foster_direction)) {
    throw new Error(`Litter: foster_direction must be one of ${FOSTER_DIRECTIONS.join(', ')}.`);
  }
  if (candidate.foster_comp_model != null && candidate.foster_comp_model !== ''
      && !FOSTER_COMP_MODELS.includes(candidate.foster_comp_model)) {
    throw new Error(`Litter: foster_comp_model must be one of ${FOSTER_COMP_MODELS.join(', ')}.`);
  }
  if (candidate.foster_our_share_pct != null && candidate.foster_our_share_pct !== '') {
    const p = Number(candidate.foster_our_share_pct);
    if (!Number.isFinite(p) || p < 0 || p > 100) {
      throw new Error('Litter: foster share % must be a number between 0 and 100.');
    }
  }
  if (candidate.foster_flat_fee_per_pup != null && candidate.foster_flat_fee_per_pup !== '') {
    const f = Number(candidate.foster_flat_fee_per_pup);
    if (!Number.isFinite(f) || f < 0) {
      throw new Error('Litter: foster flat fee per pup must be a non-negative number.');
    }
  }
  // No hard blocks beyond required fields — the pairing sync check and count
  // checks are deliberately warn-only so messy historical/imported litters stay
  // enterable (Stage 3 Brief §3). Status is not a locked state machine.
}

export const litterRepo = {
  ...base,

  async create(data) {
    validateLitter(data);
    // Edition cap hook (§3/§4 of the cap spec). Default (Pro/shared) is a no-op;
    // Lite throws CapExceededError here when creating a litter at the cap.
    await enforceLitterCap({ candidate: data });
    return base.create(data);
  },

  async update(id, changes) {
    const existing = await db.litters.get(id);
    if (!existing) throw new Error(`litters: no record with id ${id}`);
    validateLitter({ ...existing, ...changes });
    return base.update(id, changes);
  },

  // The litter produced by a pairing (Data Model §5.3: derived, never stored on
  // Pairing). Returns the first match or null — the workflow creates one litter
  // per pairing, but the query tolerates more.
  async getForPairing(pairingId) {
    const rows = await db.litters.where('pairing_id').equals(pairingId).toArray();
    return rows[0] || null;
  },

  getAllForPairing(pairingId) {
    return db.litters.where('pairing_id').equals(pairingId).toArray();
  }
};

export { ReferenceBlockedError } from './repoBase.js';
