// kennelScope.js — the single source of truth for the ACTIVE KENNEL: which of
// the user's own kennels the app is currently scoped to (Multi-Kennel Scope Spec
// §5). Pages never read the setting directly, exactly as they never read
// localStorage directly — they come through here.
//
// Two halves. The WRITE side (Phase 1) stamps every scoped record with a kennel
// on create, inheriting from its parent record where there is one and falling
// back to the active kennel. The READ side (Phase 2) is the predicate family —
// `inScope` / `dogInScope` / `subjectInScope` and their array conveniences —
// that every scoped list, hub, and report filters by. What is deliberately NOT
// filtered is as load-bearing as what is: pedigree/lineage, detail pages reached
// by id, external/leased dogs, and the contact pool all stay unscoped (spec §7),
// each with a comment at its call site saying so.
//
// Edition posture (spec §12): multi-kennel is Pro-only. Lite has exactly one own
// kennel, `editionFlags.multiKennel` is false there, and `isScoped()` is
// permanently false — so `inScope()` is a constant true and Lite's read paths
// behave exactly as they did before this module existed.
import { kennelRepo } from './kennelRepo.js';
import { getActiveKennelId as readSetting, setActiveKennelId as writeSetting } from './settings.js';
import { editionFlags } from './editionConfig.js';
// The pure record-shape rules live in their own db-free module so they can be
// unit-tested without a browser (spec §16, the same split rosterCount.js already
// has). This file binds them to the LIVE active kennel; pages import the bound
// forms below and never pass an id by hand.
import {
  SCOPED_OWNERSHIP, isOwnedByUser, inScopeOf, dogInScopeOf, subjectInScopeOf
} from './scopePredicates.js';

export { SCOPED_OWNERSHIP, isOwnedByUser };

// The user's own, non-archived kennels — the only kennels that are ever a scope
// (spec decision 2). Outside kennels (a breeder of record, a contact's
// affiliation, an external dog's home) stay pure reference data.
export async function ownKennels() {
  const all = await kennelRepo.getAll();
  return all.filter((k) => k.is_own_kennel);
}

// True once the user actually has an own kennel — the condition the mandatory
// first-run setup gate tests (spec §3.2.4). Deliberately NOT "is myKennelId set":
// the guided tour seeds an own kennel without ever setting that, and testing the
// wrong one would trap tour users behind an unclosable setup modal.
export async function hasOwnKennel() {
  return (await ownKennels()).length > 0;
}

// --- Active scope ----------------------------------------------------------

// The stored scope, or null for "All kennels". Synchronous (it's a settings
// read) so render paths can branch on it without awaiting.
export function getActiveKennelId() {
  if (!editionFlags.multiKennel) return null; // Lite: single kennel, never scoped
  return readSetting();
}

export function setActiveKennel(id) {
  writeSetting(id);
}

// The active kennel record, or null for "All kennels". ALSO the stale-scope
// guard: the active kennel can be archived or hard-deleted out from under the
// setting, and a dangling id would otherwise render an empty app with no
// explanation. A set-but-unresolvable id falls back to "All kennels" and clears
// the setting rather than showing nothing.
export async function getActiveKennel() {
  const id = getActiveKennelId();
  if (!id) return null;
  const kennel = await kennelRepo.getById(id);
  if (!kennel || kennel.is_archived || !kennel.is_own_kennel) {
    writeSetting(null);
    return null;
  }
  return kennel;
}

// Is the app currently narrowed to one kennel? False in Lite and false under
// "All kennels" — in both cases `inScope()` is a constant true.
export function isScoped() {
  return getActiveKennelId() != null;
}

// The read-side predicates every scoped list/hub/report filters by, bound to the
// live active kennel. The rules themselves are in scopePredicates.js — see there
// for what each case means and why.
export function inScope(record, opts) {
  return inScopeOf(getActiveKennelId(), record, opts);
}

// A dog is scope-transparent unless the user owns it.
export function dogInScope(dog) {
  return dogInScopeOf(getActiveKennelId(), dog);
}

// Array conveniences — the shape almost every read path actually wants. Both
// return the SAME array instance when nothing is scoped, so an unscoped page
// (all of Lite, and "All kennels" in Pro) does no work at all.
export function inScopeOnly(records) {
  return isScoped() ? records.filter((r) => inScope(r)) : records;
}

export function dogsInScope(dogs) {
  return isScoped() ? dogs.filter(dogInScope) : dogs;
}

// Polymorphic subjects — Event and Expense. `maps` is a bag of id→record Maps
// keyed by subject_type: { dog, litter, pairing }. Callers already build these to
// resolve subject labels, so scoping costs them one extra argument rather than
// another query. See scopePredicates.js for the unresolvable-subject rule, which
// is the one callers most need to know about.
export function subjectInScope(subjectType, subjectId, maps = {}) {
  return subjectInScopeOf(getActiveKennelId(), subjectType, subjectId, maps);
}

// --- Validation ------------------------------------------------------------

// The shared "this record carries a real own-kennel scope" check every scoped
// repo runs on create (spec §4.3). Kept here rather than duplicated per repo so
// the rule — and its wording — can only be changed in one place.
//
// `entity` is the human label used in the thrown message ('Litter', 'Sale', …),
// matching each repo's existing validation style.
export async function assertOwnKennel(kennelId, entity) {
  if (!kennelId) throw new Error(`${entity}: "kennel_id" is required.`);
  const kennel = await kennelRepo.getById(kennelId);
  if (!kennel) throw new Error(`${entity}: kennel_id does not match any kennel.`);
  if (!kennel.is_own_kennel) {
    throw new Error(`${entity}: "${kennel.kennel_name}" is not one of your own kennels.`);
  }
}

// --- Write side ------------------------------------------------------------

// What one candidate parent record lends to its child. A DOG only lends its
// kennel when the user actually owns it: an external dog's kennel_id names
// somebody else's kennel, and a foster-in litter out of an external dam must not
// be filed under the dam's outside kennel. Any other record type (sale, litter,
// stud service…) already carries a validated own-kennel id by construction.
function inheritableKennelId(record) {
  if (!record) return null;
  if (record.ownership_type != null && !isOwnedByUser(record)) return null;
  return record.kennel_id || null;
}

// What a new record should stamp as its kennel, in priority order:
//   1. `inheritFrom` — the parent record's kennel (a sale takes its dog's, a
//      contract its sale's, a puppy its litter's, a litter its dam's). Accepts a
//      record or an ordered list of fallbacks (a litter tries dam then sire), and
//      the first that actually lends one wins. Inheriting beats the active scope
//      so that recording a sale for a kennel-B dog while scoped to kennel A files
//      it under B, where it belongs.
//   2. the active kennel, when the app is narrowed to one.
//   3. the sole own kennel, when there is exactly one (the single-kennel case,
//      including all of Lite — and the generalization of what dog.js's
//      soleOwnKennelId() already did before this module existed).
// Returns null when none of those resolve (0 or 2+ own kennels under "All
// kennels" with no inheritable parent), which is the case a form must answer with
// a picker rather than a guess.
export async function resolveKennelIdForWrite({ inheritFrom = null } = {}) {
  const parents = Array.isArray(inheritFrom) ? inheritFrom : [inheritFrom];
  for (const parent of parents) {
    const inherited = inheritableKennelId(parent);
    if (inherited) return inherited;
  }

  const activeId = getActiveKennelId();
  if (activeId) {
    const active = await getActiveKennel(); // re-validates; may clear a stale id
    if (active) return active.id;
  }

  const own = await ownKennels();
  return own.length === 1 ? own[0].id : null;
}
