// kennelRepo.js — all Dexie access for the lightweight Kennel table.
// Kept deliberately minimal (Build Brief B1): kennels are added inline from the
// Contact form and managed from a bare list/rename screen; no full CRUD UI yet.
import { db } from './db.js';
import { makeRepo, newId } from './repoBase.js';
import { KENNEL_REFERENCES } from './referenceRegistry.js';

const base = makeRepo('kennels', KENNEL_REFERENCES);

// --- Public identity (End-State guide §28) ---------------------------------
// `public_id` is the kennel's PORTABLE identity: minted once for an own kennel,
// immutable thereafter, and carried on every kennel card (data/kennelCard.js).
// Deliberately NOT the row's `id`. The row id is a database key — it is recreated
// whenever the record is (a fresh install where the breeder retypes their kennel
// instead of restoring, a delete-and-re-add, a hand-edited backup), and it names
// nothing outside this database. The public id is the thing another breeder's
// copy of your kennel points at, so it has to outlive all of that.
//
// The `kos1_` prefix (KennelOS public identity, namespace v1) is what makes a
// mis-pasted value fail loudly instead of silently "working": a bare UUID pasted
// into the wrong field is indistinguishable from a right one, and this id is
// meant to be copied between apps. It also gives a future registry a cheap
// format check and a version to migrate off.
//
// NOT the same thing as settings.js's Furever `breederKey`, and deliberately not
// merged with it: breederKey identifies the INSTALLATION's breeder to Furever
// (one key shared across all your own kennels, so every pup you place dedupes
// into one `breeders` row in the family app), and re-keying it would break the
// dedup of packets already sent. public_id identifies ONE kennel record. Two
// scopes, two ids; not a gap to close.
const PUBLIC_ID_PREFIX = 'kos1_';
const PUBLIC_ID_RE = /^kos1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function newPublicId() {
  return PUBLIC_ID_PREFIX + newId();
}

export function isPublicId(value) {
  return PUBLIC_ID_RE.test(String(value ?? '').trim());
}

// One identity, one record. The schema uses a plain (non-unique) index and this
// explicit guard rather than Dexie's `&public_id`, for the same reason every
// other rule in the repos is a repo-level check: a unique-index violation
// surfaces as a raw DexieError, and this one needs to reach the user as a
// sentence about kennels. `exceptId` lets an update re-assert its own value.
async function assertPublicIdFree(publicId, exceptId) {
  const clash = await db.kennels.where('public_id').equals(publicId).first();
  if (clash && clash.id !== exceptId) {
    throw new Error(`Another kennel on this device (“${clash.kennel_name}”) already has that public ID.`);
  }
}

function validateKennel(candidate) {
  if (!candidate.kennel_name) throw new Error('Kennel: "kennel_name" is required.');
  if (candidate.public_id && !isPublicId(candidate.public_id)) {
    throw new Error(`Kennel: "${candidate.public_id}" is not a valid KennelOS kennel ID.`);
  }
}

const testKey = (s) => String(s ?? '').trim().toLowerCase();

export const kennelRepo = {
  ...base,

  async create(data) {
    validateKennel(data);
    const record = { ...data };
    // An own kennel gets its public identity at birth; an outside kennel only
    // ever carries one it RECEIVED (kennelCard.js supplies it explicitly).
    if (!record.public_id && record.is_own_kennel) record.public_id = newPublicId();
    if (record.public_id) await assertPublicIdFree(record.public_id, null);
    return base.create(record);
  },

  async update(id, changes) {
    const existing = await db.kennels.get(id);
    if (!existing) throw new Error(`kennels: no record with id ${id}`);
    const next = { ...changes };

    // public_id is write-once. It may be filled in on a record that has none (a
    // card import linking an outside kennel, or the own-kennel mint below), but
    // once set it can never be changed or cleared — the whole point is that a
    // reference made against it stays good.
    if ('public_id' in next) {
      const incoming = String(next.public_id ?? '').trim();
      if (!incoming) {
        delete next.public_id; // never blank an identity out
      } else if (existing.public_id && incoming !== existing.public_id) {
        throw new Error('A kennel’s public ID is permanent and cannot be changed.');
      } else if (incoming !== existing.public_id) {
        if (!isPublicId(incoming)) throw new Error(`Kennel: "${incoming}" is not a valid KennelOS kennel ID.`);
        await assertPublicIdFree(incoming, id);
        next.public_id = incoming;
      }
    }

    // Mint on promotion to own — and, by the same line, self-heal any own kennel
    // that predates this field (a dev database, or a backup restored from one).
    const merged = { ...existing, ...next };
    if (!merged.public_id && merged.is_own_kennel) next.public_id = newPublicId();

    validateKennel({ ...existing, ...next });
    return base.update(id, next);
  },

  // The kennel-card match-or-create key (never the row id — CLAUDE.md's import
  // rule). Returns undefined when no local kennel carries this identity.
  async getByPublicId(publicId) {
    const key = String(publicId ?? '').trim();
    if (!key) return undefined;
    return db.kennels.where('public_id').equals(key).first();
  },

  // The public id for a kennel, minting it if this own kennel somehow has none
  // (see the self-heal note above). Returns null for an outside kennel that has
  // never been linked to a card — there is nothing of ours to mint there.
  async ensurePublicId(id) {
    const existing = await db.kennels.get(id);
    if (!existing) throw new Error(`kennels: no record with id ${id}`);
    if (existing.public_id) return existing.public_id;
    if (!existing.is_own_kennel) return null;
    const updated = await kennelRepo.update(id, { public_id: newPublicId() });
    return updated.public_id;
  },

  // Kennels this device typed in by hand that MIGHT be the one a card names:
  // outside kennels carrying no public identity whose name matches the card's,
  // case-insensitively and trimmed (the same name-match rule the CSV importer
  // uses). These are SUGGESTIONS the card preview offers, never automatic
  // matches — the only natural key that auto-matches is the public id itself.
  async findUnlinkedByName(name) {
    const key = testKey(name);
    if (!key) return [];
    const all = await kennelRepo.getAll({ includeArchived: true });
    return all.filter((k) => !k.public_id && !k.is_own_kennel && testKey(k.kennel_name) === key);
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
