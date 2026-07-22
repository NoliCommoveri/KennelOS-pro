// dogRepo.js — all Dexie access for the single Dog table (breeding stock,
// puppies, and external dogs all live here; life-stage changes are `status`
// updates on the same record, never a new row — CLAUDE.md).
import { db } from './db.js';
import { makeRepo, nowIso } from './repoBase.js';
import { DOG_REFERENCES } from './referenceRegistry.js';
import { todayYMD } from './dateUtils.js';
import { enforceDogCap } from './editionConfig.js';

const base = makeRepo('dogs', DOG_REFERENCES);

// Fields required to save a Dog (Build Brief B1). Everything else — registered
// name, DOB, registration number — is commonly unknown at entry time.
const REQUIRED_FIELDS = ['call_name', 'sex', 'breed', 'ownership_type', 'status'];
const OWNER_REQUIRED_TYPES = ['external', 'leased_in'];

// Walk up from a starting parent id and return the set of all ancestor ids.
// `dogsById` is a Map of the current dog table so the walk is a pure in-memory
// graph traversal. A `visited` set guards against pre-existing bad cycles in the
// data so this never infinite-loops.
function collectAncestors(startId, dogsById) {
  const ancestors = new Set();
  const stack = [startId];
  while (stack.length) {
    const id = stack.pop();
    if (id == null || ancestors.has(id)) continue;
    ancestors.add(id);
    const dog = dogsById.get(id);
    if (!dog) continue;
    if (dog.sire_id) stack.push(dog.sire_id);
    if (dog.dam_id) stack.push(dog.dam_id);
  }
  return ancestors;
}

// Hard-block validation (Build Brief B1). Softer, interactive rules — sex
// mismatch on sire/dam, the "leaving deceased" confirmation — are WARN-only and
// belong to the Stage 2 UI, not here (a repo can't prompt the user).
async function validateDog(candidate, existingId = null) {
  for (const f of REQUIRED_FIELDS) {
    if (candidate[f] == null || candidate[f] === '') {
      throw new Error(`Dog: "${f}" is required.`);
    }
  }

  if (candidate.date_of_birth && candidate.date_of_birth > todayYMD()) {
    throw new Error('Dog: date_of_birth cannot be in the future.');
  }

  if (
    candidate.date_of_death &&
    candidate.date_of_birth &&
    candidate.date_of_death < candidate.date_of_birth
  ) {
    throw new Error('Dog: date_of_death cannot be before date_of_birth.');
  }

  if (OWNER_REQUIRED_TYPES.includes(candidate.ownership_type) && !candidate.owner_contact_id) {
    throw new Error(`Dog: owner_contact_id is required when ownership_type is "${candidate.ownership_type}".`);
  }

  // Parentage integrity — hard blocks (an undetected cycle would infinite-loop
  // the pedigree tree renderer later).
  const selfId = existingId ?? candidate.id;
  if (selfId && (candidate.sire_id === selfId || candidate.dam_id === selfId)) {
    throw new Error('Dog: a dog cannot be its own sire or dam.');
  }

  if (selfId && (candidate.sire_id || candidate.dam_id)) {
    const allDogs = await db.dogs.toArray();
    const dogsById = new Map(allDogs.map((d) => [d.id, d]));
    for (const parentId of [candidate.sire_id, candidate.dam_id]) {
      if (!parentId) continue;
      // If this dog already appears in the proposed parent's ancestor chain,
      // adding the link would create a cycle.
      if (collectAncestors(parentId, dogsById).has(selfId)) {
        throw new Error('Dog: this parent would create a pedigree cycle.');
      }
    }
  }
}

// Disposition is a puppy-only field (vocab.js): the stored record must never
// carry one unless status is 'puppy'. Enforced centrally here so every writer —
// the dog form, sale-side disposition offers, CSV import — lands the same
// invariant, and a life-stage change out of 'puppy' clears any lingering value.
function nullDispositionIfNotPuppy(record) {
  return record.status !== 'puppy' && record.disposition != null
    ? { ...record, disposition: null }
    : record;
}

export const dogRepo = {
  ...base,

  async create(data) {
    await validateDog(data);
    // Edition cap hook (§3/§4 of the cap spec). Default (Pro/shared) is a no-op;
    // Lite throws CapExceededError here when adding a new counting dog at the cap.
    await enforceDogCap({ candidate: data, existing: null, id: null });
    return base.create(nullDispositionIfNotPuppy(data));
  },

  async update(id, changes) {
    const existing = await db.dogs.get(id);
    if (!existing) throw new Error(`dogs: no record with id ${id}`);
    const merged = { ...existing, ...changes };
    // Validate the merged result so partial updates are checked against the whole.
    await validateDog(merged, id);
    // Edition cap hook. Default no-op; Lite blocks a ✗→✓ transition into the
    // counting set (e.g. a kept puppy maturing to an adult stage) while at cap.
    await enforceDogCap({ candidate: merged, existing, id });
    // Force disposition null in the write when the resulting status isn't puppy —
    // covers both an explicit status change and a stale value on an unrelated edit.
    if (merged.status !== 'puppy' && merged.disposition != null) {
      changes = { ...changes, disposition: null };
    }
    return base.update(id, changes);
  },

  // --- Pedigree helpers (pure derivation over sire_id/dam_id) --------------

  // Direct children of a dog. Reverse lookups aren't native in Dexie, but both
  // parent fields are indexed, so this is two cheap index queries.
  async getChildren(dogId) {
    const [bySire, byDam] = await Promise.all([
      db.dogs.where('sire_id').equals(dogId).toArray(),
      db.dogs.where('dam_id').equals(dogId).toArray()
    ]);
    const byId = new Map();
    for (const d of [...bySire, ...byDam]) byId.set(d.id, d);
    return [...byId.values()];
  },

  // Dogs born into a given litter (roster is derived, never stored on Litter).
  getByLitter(litterId) {
    return db.dogs.where('litter_id').equals(litterId).toArray();
  },

  // Distinct breed values already entered — feeds the free-text breed autocomplete
  // (Build Brief B1).
  async getBreeds() {
    const all = await db.dogs.toArray();
    return [...new Set(all.map((d) => d.breed).filter(Boolean))].sort();
  },

  // Additive, dedupe-on-write merge into planned_tests (Test Planning Addendum
  // §5) — the shared mechanism behind "Apply to dogs" and "Copy plan from…".
  // Never removes a test the breeder pruned; adding an already-present token
  // (case-insensitive, trimmed) is a no-op.
  async addPlannedTests(id, tokens) {
    const existing = await db.dogs.get(id);
    if (!existing) throw new Error(`dogs: no record with id ${id}`);
    const current = existing.planned_tests || [];
    const seen = new Set(current.map((t) => t.trim().toLowerCase()));
    const merged = [...current];
    for (const raw of tokens || []) {
      const trimmed = String(raw ?? '').trim();
      if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
      seen.add(trimmed.toLowerCase());
      merged.push(trimmed);
    }
    return dogRepo.update(id, { planned_tests: merged });
  }
};

// Re-export so callers can `import { ReferenceBlockedError } from './dogRepo.js'`
// alongside the repo if they prefer.
export { ReferenceBlockedError } from './repoBase.js';
export { nowIso };
