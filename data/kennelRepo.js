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

const testKey = (s) => String(s ?? '').trim().toLowerCase();

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
  // `breed`, when given (the breed-seed import passes its contributing
  // breed's display name), tags this test in `preferred_test_breeds` — a
  // { [testKey]: breed[] } map, additive across every breed that ever
  // contributed the test. A test added without a breed (typed directly into
  // the kennel's own "Add a test" field) stays untagged and, per
  // `testsForBreed` below, keeps applying to every breed — same as before
  // breed-scoping existed.
  async addPreferredTest(id, token, breed) {
    const existing = await db.kennels.get(id);
    if (!existing) throw new Error(`kennels: no record with id ${id}`);
    const trimmed = String(token ?? '').trim();
    if (!trimmed) return existing;
    const changes = {};
    const current = existing.preferred_tests || [];
    if (!current.some((t) => t.trim().toLowerCase() === trimmed.toLowerCase())) {
      changes.preferred_tests = [...current, trimmed];
    }
    const breedTrimmed = String(breed ?? '').trim();
    if (breedTrimmed) {
      const map = existing.preferred_test_breeds || {};
      const have = map[testKey(trimmed)] || [];
      if (!have.some((b) => b.trim().toLowerCase() === breedTrimmed.toLowerCase())) {
        changes.preferred_test_breeds = { ...map, [testKey(trimmed)]: [...have, breedTrimmed] };
      }
    }
    if (!Object.keys(changes).length) return existing;
    return kennelRepo.update(id, changes);
  },

  async removePreferredTest(id, token) {
    const existing = await db.kennels.get(id);
    if (!existing) throw new Error(`kennels: no record with id ${id}`);
    const current = existing.preferred_tests || [];
    const changes = { preferred_tests: current.filter((t) => t !== token) };
    const map = existing.preferred_test_breeds || {};
    if (map[testKey(token)]) {
      const rest = { ...map };
      delete rest[testKey(token)];
      changes.preferred_test_breeds = rest;
    }
    return kennelRepo.update(id, changes);
  },

  // Breed tag(s) a preferred test carries (Test Planning Addendum §8), sorted
  // for display — e.g. kennel.js appends "(Labrador Retriever, Golden
  // Retriever)" after a test name so two same-named tests pulled in for
  // different breeds still read as one unambiguous, deduped row. [] for an
  // untagged (breed-agnostic) test.
  testBreedsFor(k, token) {
    const tagged = (k?.preferred_test_breeds || {})[testKey(token)];
    return tagged ? [...tagged].sort((a, b) => a.localeCompare(b)) : [];
  },

  // New-dog auto-fill and "copy/apply from kennel" (Test Planning Addendum
  // §4/§8) — scope the panel to one breed: a tagged test only carries over
  // when `breed` matches one of its tags (case-insensitive); an untagged test
  // is breed-agnostic and always carries over.
  testsForBreed(k, breed) {
    const breedKey = testKey(breed);
    return (k?.preferred_tests || []).filter((t) => {
      const tagged = (k?.preferred_test_breeds || {})[testKey(t)];
      if (!tagged || !tagged.length) return true;
      return breedKey && tagged.some((b) => testKey(b) === breedKey);
    });
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
