// rosterCount.js — the edition-agnostic definition of an "active roster dog" and
// the pure set math over it. This is a neutral DOMAIN fact — the same live,
// owned/co-owned adult population the dashboard's active-dog tiles describe — NOT
// an edition rule: shared code never hardcodes a cap number or a Pro/Lite check
// (CLAUDE.md editions layering). The Lite edition (lite/editionConfig.js) is the
// only caller that turns this population into a *cap* by comparing its size to a
// number; Pro/Demo never call in here at all.
//
// It lives in shared/ (not in lite/) for two reasons: the shared restore path
// (importExport.js) must be able to ask "how many active dogs would this backup
// leave?" through an edition hook whose Lite implementation reuses this exact
// classification, and keeping the predicate in one db-free module means the cap's
// counting logic is unit-testable without a browser/IndexedDB (tests/rosterCount).
//
// Pure: no imports, no db, no edition config — just record shape in, numbers out.

// A dog counts as "active roster" when it is a live (non-archived), owned or
// co-owned adult. Puppies, deceased, external-reference, and departed (archived)
// dogs are all excluded — matching the cap spec's countsTowardDogCap (§2).
export const ACTIVE_ROSTER_OWNERSHIP = new Set(['owned', 'co_owned']);
export const ACTIVE_ROSTER_ADULT_STATUS = new Set([
  'active_breeding', 'retired_breeding', 'pet_home', 'for_sale'
]);

// True when `dog` is a live owned/co-owned adult. `pet_home`/`for_sale` are kept
// in the adult set defensively: a Lite user can never select them, but a Pro
// backup imported into Lite can carry them, and they must still count rather than
// slip through as a bypass (cap spec §1a).
export function isActiveRosterDog(dog) {
  return !!dog
    && !dog.is_archived
    && ACTIVE_ROSTER_OWNERSHIP.has(dog.ownership_type)
    && ACTIVE_ROSTER_ADULT_STATUS.has(dog.status);
}

// Count the active roster dogs in `dogs`, optionally excluding one id (an update
// compares the candidate against everyone *else*).
export function countActiveRosterDogs(dogs, excludeId = null) {
  let n = 0;
  for (const d of dogs) {
    if (excludeId != null && d.id === excludeId) continue;
    if (isActiveRosterDog(d)) n++;
  }
  return n;
}

// The dog rows that would exist AFTER importing `incomingDogs` in the given mode:
//   'replace' — the table becomes exactly the incoming rows (existing wiped).
//   'merge'   — incoming rows upsert by id over the existing rows.
// Pure — the caller supplies the existing rows (empty for 'replace', since they're
// about to be cleared). Used by the Lite import cap to size the resulting roster
// before anything is written, so an over-cap restore is rejected all-or-nothing.
export function dogsAfterImport(existingDogs, incomingDogs, mode) {
  if (mode === 'replace') return incomingDogs.slice();
  const incomingIds = new Set(incomingDogs.map((d) => d.id));
  const kept = existingDogs.filter((d) => !incomingIds.has(d.id));
  return kept.concat(incomingDogs);
}
