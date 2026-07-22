// pairingRepo.js — all Dexie access for the Pairing table (a planned or actual
// breeding attempt between two dogs). Same thin shape as the other repos; pages
// call this, never db.pairings.* directly (CLAUDE.md layering rule).
//
// The pairing→litter link is DERIVED, never stored here: a pairing's litter is
// `Litter WHERE pairing_id = this.id` (Data Model §5.3). `stud_service_id` exists
// in the schema but is unused/hidden until StudService lands (Stage 3 Brief scope).
import { db } from './db.js';
import { makeRepo } from './repoBase.js';
import { PAIRING_REFERENCES } from './referenceRegistry.js';

const base = makeRepo('pairings', PAIRING_REFERENCES);

// Required to save (Stage 3 Brief §3). Softer rules — sex mismatch on sire/dam,
// expected_due_date < planned_date — are WARN-only and live in the UI (a repo
// can't prompt the user), exactly as the Dog repo does for its soft rules.
const REQUIRED_FIELDS = ['sire_id', 'dam_id', 'pairing_type', 'status'];

function validatePairing(candidate) {
  for (const f of REQUIRED_FIELDS) {
    if (candidate[f] == null || candidate[f] === '') {
      throw new Error(`Pairing: "${f}" is required.`);
    }
  }
  // Hard block: a dog cannot be paired with itself.
  if (candidate.sire_id === candidate.dam_id) {
    throw new Error('Pairing: sire and dam cannot be the same dog.');
  }
  // sire/dam sex mismatch and expected_due_date ordering are warn-only (UI).
  // Status is NOT a locked state machine (Stage 3 Brief §3) — any value goes.
}

export const pairingRepo = {
  ...base,

  async create(data) {
    validatePairing(data);
    return base.create(data);
  },

  async update(id, changes) {
    const existing = await db.pairings.get(id);
    if (!existing) throw new Error(`pairings: no record with id ${id}`);
    validatePairing({ ...existing, ...changes });
    return base.update(id, changes);
  },

  // Pairings in which a dog appears as sire or dam — powers the derived
  // "Pairings" panel on Dog Detail. Both parent fields are indexed.
  async getForDog(dogId) {
    const [asSire, asDam] = await Promise.all([
      db.pairings.where('sire_id').equals(dogId).toArray(),
      db.pairings.where('dam_id').equals(dogId).toArray()
    ]);
    const byId = new Map();
    for (const p of [...asSire, ...asDam]) byId.set(p.id, p);
    return [...byId.values()];
  }
};

export { ReferenceBlockedError } from './repoBase.js';
