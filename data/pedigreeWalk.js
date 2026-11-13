// pedigreeWalk.js — a dog's ancestors by sire_id / dam_id, for her KennelPort
// website's lineage section (siteExport.js; docs/KennelOS_Website_Contract_Plan.md
// C4, C7). PURE: dogs in, a list out; no Dexie, no DOM.
//
// Nearest first: both parents, then the four grandparents, and so on, sire's side
// before dam's in each generation. `path` names the line from the dog: "sire",
// "sire.dam", "dam.dam.sire"… The same dog can appear twice (line breeding) and is
// listed at each place. Capped at MAX_GENERATIONS, and a parent that is the dog
// itself or one of its own descendants on that line (a loop in the data) stops
// that line rather than repeating.

export const MAX_GENERATIONS = 4;

// → [{ dog, path, generation }], generation 1 = a parent. A missing parent id, or
// one that isn't in `dogsById`, ends that line.
export function ancestorsOf(dog, dogsById, { generations = MAX_GENERATIONS } = {}) {
  const depth = Math.max(0, Math.min(Number(generations) || 0, MAX_GENERATIONS));
  const out = [];
  if (!dog || !dog.id) return out;
  let row = [{ dog, path: '', line: new Set([dog.id]) }];
  for (let g = 1; g <= depth && row.length; g++) {
    const next = [];
    for (const at of row) {
      for (const role of ['sire', 'dam']) {
        const parent = dogsById.get(at.dog[`${role}_id`]);
        if (!parent || at.line.has(parent.id)) continue;
        const path = at.path ? `${at.path}.${role}` : role;
        out.push({ dog: parent, path, generation: g });
        next.push({ dog: parent, path, line: new Set([...at.line, parent.id]) });
      }
    }
    row = next;
  }
  return out;
}
