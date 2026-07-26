// scopePredicates.js — the PURE half of the active-kennel scope: the record-shape
// rules that decide whether a record is inside the kennel you are currently
// viewing (Multi-Kennel Scope Spec §5/§7). No imports, no db, no localStorage, no
// edition config — active-kennel id + record in, boolean out.
//
// Why it is split out at all: `kennelScope.js` reaches kennelRepo (Dexie) and
// settings (localStorage), neither of which exists in Node, so nothing in that
// module can be unit-tested. Phase 1 accepted that and covered the write side with
// source-level guards instead (spec §16). Phase 2 makes these three predicates
// load-bearing across every list, hub, and report in the app — a wrong answer
// silently hides a record, which §7 calls the worst failure this feature can have
// — so they move here, exactly the way `rosterCount.js` was split out to make the
// Lite cap's counting testable without a browser.
//
// `kennelScope.js` re-exports every one of these bound to the LIVE active kennel,
// and that bound form is what pages import. Nothing outside kennelScope.js should
// need to pass `activeId` by hand.

// Ownership types whose dogs belong to one of the user's OWN kennels, and which
// therefore carry a required, own-kennel `kennel_id` (spec §3.1a). An external /
// leased-in dog's kennel_id points at somebody else's kennel (or nothing), so it
// is neither required nor a scope.
export const SCOPED_OWNERSHIP = new Set(['owned', 'co_owned']);

export function isOwnedByUser(dog) {
  return !!dog && SCOPED_OWNERSHIP.has(dog.ownership_type);
}

// The read-side predicate. Three cases, in order:
//   1. No active kennel ("All kennels", or a single-kennel edition) → everything.
//   2. Scope-transparent record → in scope under every kennel.
//   3. Otherwise → the record's stamped kennel must match.
//
// Scope-transparency (spec §3.1a/§7) is what keeps external dogs visible
// everywhere: an outside stud used by two of your kennels belongs to neither, and
// hiding him under a scope would break pedigree and stud-service workflows.
export function inScopeOf(activeId, record, { transparent = false } = {}) {
  if (!activeId) return true;
  if (transparent) return true;
  return record?.kennel_id === activeId;
}

// A dog is scope-transparent unless the user owns it.
export function dogInScopeOf(activeId, dog) {
  return inScopeOf(activeId, dog, { transparent: !isOwnedByUser(dog) });
}

// Polymorphic subjects — Event and Expense (spec §4.1: deliberately NOT stamped,
// because their scope is a fact about the subject they hang off, and a second
// stamped field would be a second source of truth for it). `maps` is a bag of
// id→record Maps keyed by subject_type: { dog, litter, pairing }.
//
// An UNRESOLVABLE subject is deliberately treated as in-scope. A row we cannot
// place is strictly better shown under every scope than silently dropped from all
// of them — §7's "a silently hidden record is far worse than a missing filter".
// That is also why callers must build those maps from UNSCOPED loads: a
// pre-filtered map would make every other kennel's rows look unresolvable and let
// them straight through the filter.
export function subjectInScopeOf(activeId, subjectType, subjectId, maps = {}) {
  if (!activeId) return true;
  // A kennel-subject expense (facility overhead, dues, marketing) IS the kennel.
  if (subjectType === 'kennel') return subjectId === activeId;
  const record = maps[subjectType]?.get?.(subjectId);
  if (!record) return true;
  if (subjectType === 'dog') return dogInScopeOf(activeId, record);
  return inScopeOf(activeId, record);
}
