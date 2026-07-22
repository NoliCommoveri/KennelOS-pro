// kennelRepo.js — all Dexie access for the lightweight Kennel table.
// Kept deliberately minimal (Build Brief B1): kennels are added inline from the
// Contact form and managed from a bare list/rename screen; no full CRUD UI yet.
import { db } from './db.js';
import { makeRepo } from './repoBase.js';
import { KENNEL_REFERENCES } from './referenceRegistry.js';

const base = makeRepo('kennels', KENNEL_REFERENCES);

function validateKennel(candidate) {
  if (!candidate.kennel_name) throw new Error('Kennel: "kennel_name" is required.');
}

export const kennelRepo = {
  ...base,

  async create(data) {
    validateKennel(data);
    return base.create(data);
  },

  async update(id, changes) {
    const existing = await db.kennels.get(id);
    if (!existing) throw new Error(`kennels: no record with id ${id}`);
    validateKennel({ ...existing, ...changes });
    return base.update(id, changes);
  },

  // Contacts affiliated with this kennel — for the standalone kennel list screen.
  getContacts(kennelId) {
    return db.contacts.where('kennel_id').equals(kennelId).toArray();
  },

  // Panel authoring (Test Planning Addendum §6.1) — add is dedupe-on-write;
  // remove drops panel membership only, never the vocabulary token itself
  // (an old event still needs it to resolve as a known suggestion — §7).
  async addPreferredTest(id, token) {
    const existing = await db.kennels.get(id);
    if (!existing) throw new Error(`kennels: no record with id ${id}`);
    const trimmed = String(token ?? '').trim();
    if (!trimmed) return existing;
    const current = existing.preferred_tests || [];
    if (current.some((t) => t.trim().toLowerCase() === trimmed.toLowerCase())) return existing;
    return kennelRepo.update(id, { preferred_tests: [...current, trimmed] });
  },

  async removePreferredTest(id, token) {
    const existing = await db.kennels.get(id);
    if (!existing) throw new Error(`kennels: no record with id ${id}`);
    const current = existing.preferred_tests || [];
    return kennelRepo.update(id, { preferred_tests: current.filter((t) => t !== token) });
  },

  // Shared-vocabulary read (addendum §3) — union of every active own-kennel's
  // authored panel. A test added at any own kennel is suggestable on every
  // dog's event form at once (§7); this is the "global" half of that union.
  async getVocabulary() {
    const kennels = await kennelRepo.getAll();
    const seen = new Set();
    const out = [];
    for (const k of kennels) {
      if (!k.is_own_kennel) continue;
      for (const raw of k.preferred_tests || []) {
        const trimmed = String(raw ?? '').trim();
        const key = trimmed.toLowerCase();
        if (!trimmed || seen.has(key)) continue;
        seen.add(key);
        out.push(trimmed);
      }
    }
    return out;
  },

  // Breed suggestion pool (Test Planning Addendum §8) — the optional seed
  // import's breed payload lands here. It's the kennel-scoped, backup-riding
  // half of the breed autocomplete source: distinct breeds already on dogs
  // (dogRepo.getBreeds) union this pool, so an imported breed can be suggested
  // before the first dog is entered. Add is dedupe-on-write, same posture as
  // addPreferredTest; suggests, never locks — breed stays free text.
  async addPreferredBreed(id, breed) {
    const existing = await db.kennels.get(id);
    if (!existing) throw new Error(`kennels: no record with id ${id}`);
    const trimmed = String(breed ?? '').trim();
    if (!trimmed) return existing;
    const current = existing.preferred_breeds || [];
    if (current.some((b) => b.trim().toLowerCase() === trimmed.toLowerCase())) return existing;
    return kennelRepo.update(id, { preferred_breeds: [...current, trimmed] });
  },

  // Union of every active own-kennel's breed pool — the "before any dog exists"
  // half of the breed autocomplete union (mirrors getVocabulary for tests).
  async getBreedVocabulary() {
    const kennels = await kennelRepo.getAll();
    const seen = new Set();
    const out = [];
    for (const k of kennels) {
      if (!k.is_own_kennel) continue;
      for (const raw of k.preferred_breeds || []) {
        const trimmed = String(raw ?? '').trim();
        const key = trimmed.toLowerCase();
        if (!trimmed || seen.has(key)) continue;
        seen.add(key);
        out.push(trimmed);
      }
    }
    return out;
  }
};
