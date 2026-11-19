// repoBase.js — shared plumbing for the entity repos.
//
// Every repo exposes the same thin surface (getById, getAll, create, update,
// archive, hardDelete). This factory supplies the boilerplate; each entity repo
// wraps it to add entity-specific validation. Pages call repos; repos are the
// only code that touches Dexie (see CLAUDE.md layering rule).
import { db } from './db.js';
import { findBlockingReferences } from './referenceRegistry.js';
import { assertWritable } from './demoMode.js';
import { markDataChanged } from './settings.js';

export function newId() {
  return crypto.randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}

// What a record is called in a refused delete's message: the entity, never the
// table name (review K1-7: "Cannot delete waitlist_entries" read as a bug).
export const ENTITY_LABELS = Object.freeze({
  accounts: 'this account', breed_feeding_schedules: 'this feeding schedule',
  contacts: 'this contact', contracts: 'this contract', do_not_sell: 'this do-not-sell listing',
  documents: 'this document', dogs: 'this dog', events: 'this entry', expenses: 'this expense',
  files: 'this file', kennels: 'this kennel', litters: 'this litter', pairings: 'this pairing',
  sales: 'this sale', stud_services: 'this stud service', waitlist_entries: 'this application',
  waitlist_offers: 'this offer', waitlist_programs: 'this waitlist'
});

// The blockers as one line: "sire of another dog × 2, dam of a litter × 1".
export function blockerList(blockers) {
  return blockers.map((b) => `${b.label} × ${b.count}`).join(', ');
}

// Thrown by hardDelete when references still exist — carries the human-readable
// blocker list so the UI can tell the user exactly what to fix/archive instead.
// `entity` is a table name (turned into ENTITY_LABELS' words) or already words.
export class ReferenceBlockedError extends Error {
  constructor(entity, blockers) {
    const what = ENTITY_LABELS[entity] || entity;
    super(`Can't delete ${what}: it's still in use (${blockerList(blockers)}). Archive it instead.`);
    this.name = 'ReferenceBlockedError';
    this.entity = entity;
    this.blockers = blockers;
  }
}

// Thrown by the Lite edition's cap hooks (editionConfig.js) when an interactive
// write would add a new counting dog / litter past the Lite limit (cap spec §6).
// A repo can't prompt, so it hard-throws this; the dog / litter / puppy forms
// catch it and render the upgrade nudge (never a raw error). Lives here — beside
// ReferenceBlockedError — so both the per-edition editionConfig and the shared
// forms that catch it import from one shared module. The Pro/Demo editionConfig
// never constructs it (their hooks are no-ops), so no cap wording ships in Pro.
export class CapExceededError extends Error {
  constructor(kind, current, limit) {
    super(`Lite limit reached: ${current}/${limit} ${kind}.`);
    this.name = 'CapExceededError';
    this.kind = kind; // 'dogs' | 'litters'
    this.current = current;
    this.limit = limit;
  }
}

// Build the standard repo for a table.
//   tableName  — Dexie table name
//   references — the entity's registry array (from referenceRegistry.js), or null
//                if nothing can point at this entity (e.g. events are leaves).
export function makeRepo(tableName, references = null) {
  const table = () => db.table(tableName);

  const repo = {
    getById(id) {
      return table().get(id);
    },

    // Archived records are filtered in JS rather than via the is_archived index:
    // IndexedDB can't use booleans as index keys, and at kennel scale (hundreds to
    // low thousands of rows) an in-memory filter is trivial.
    async getAll({ includeArchived = false } = {}) {
      const all = await table().toArray();
      return includeArchived ? all : all.filter((r) => !r.is_archived);
    },

    async create(data) {
      assertWritable(); // Demo edition: user writes are a friendly no-op (throws)
      const now = nowIso();
      const record = {
        ...data,
        id: data.id ?? newId(),
        is_archived: data.is_archived ?? false,
        created_at: now,
        updated_at: now
      };
      await table().add(record);
      markDataChanged(); // cloud backup dirty signal (Cloud Phase 1 §3.2)
      return record;
    },

    async update(id, changes) {
      assertWritable(); // Demo: also covers archive()/unarchive(), which call update
      const existing = await table().get(id);
      if (!existing) throw new Error(`${tableName}: no record with id ${id}`);
      const record = {
        ...existing,
        ...changes,
        id, // id is immutable
        created_at: existing.created_at, // preserve original
        updated_at: nowIso()
      };
      await table().put(record);
      markDataChanged(); // cloud backup dirty signal (Cloud Phase 1 §3.2)
      return record;
    },

    // Soft delete — always allowed, never cascades. Hides from active lists/pickers
    // while staying resolvable for pedigree/history.
    archive(id) {
      return repo.update(id, { is_archived: true });
    },

    unarchive(id) {
      return repo.update(id, { is_archived: false });
    },

    // Report blockers without deleting — lets the UI disable/explain the Delete
    // control. Empty array => hard delete is currently allowed.
    async getDeleteBlockers(id) {
      if (!references) return [];
      return findBlockingReferences(references, id);
    },

    // Hard delete — the rare "fix a data-entry mistake" action. Blocked whenever
    // any reference exists (only archive is allowed then).
    async hardDelete(id) {
      assertWritable(); // Demo: no destructive writes either
      if (references) {
        const blockers = await findBlockingReferences(references, id);
        if (blockers.length > 0) throw new ReferenceBlockedError(tableName, blockers);
      }
      await table().delete(id);
      markDataChanged(); // cloud backup dirty signal (Cloud Phase 1 §3.2)
    }
  };

  return repo;
}
