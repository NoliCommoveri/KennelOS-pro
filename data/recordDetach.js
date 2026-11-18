// recordDetach.js — remove a known set of records at once, and deal with every
// record outside the set that points at one of them (Load Performance plan D4/D5).
//
// Used for the guided tour's sample data: clearing an old seed that real records
// came to point at (sampleData.clearSampleData), and Kels's "Leftover tour
// records" in Tidy up (assets/tidyUpUI.js). The single-record hardDelete guard
// refuses while anything points at a record; this is the other half, for a set
// that is going as a whole and whose outside links are known not to matter:
//   • a link to a removed KENNEL moves to `kennelTarget` (the breeder's own
//     kennel), so her dogs and the rest stay filed under a kennel;
//   • any other link is cleared: a single id becomes null, an id in a list is
//     taken out of it, and an event or expense about a removed record keeps its
//     own details but is about nothing any more.
// Nothing outside the set is deleted. What changed is returned, for the notice.
//
// The registries (referenceRegistry.js) say what can point at what, so this
// stays complete as references are added there.
import { db, existingTableNames } from './db.js';
import { REFERENCES_BY_TABLE, findReferencingRows, refIdsOf } from './referenceRegistry.js';
import { markDataChanged } from './settings.js';

const at = (obj, dotted) => dotted.split('.').reduce((v, k) => (v == null ? v : v[k]), obj);
function setAt(obj, dotted, value) {
  const keys = dotted.split('.');
  const last = keys.pop();
  const parent = keys.reduce((v, k) => (v == null ? v : v[k]), obj);
  if (parent != null && typeof parent === 'object') parent[last] = value;
}

// Point `row`'s `ref` field away from `id`: to `to` when given, else cleared.
// Mutates and returns the row. Pure apart from that, for tests.
export function detachRow(row, ref, id, to = null) {
  if (ref.compoundIndex) {
    if (row.subject_type === ref.discriminatorValue && row.subject_id === id) row.subject_id = to;
    return row;
  }
  const [list, item] = ref.field.split('[].');
  if (item != null) {
    const xs = at(row, list);
    if (Array.isArray(xs)) for (const x of xs) if (x && at(x, item) === id) setAt(x, item, to);
    return row;
  }
  const v = at(row, ref.field);
  if (Array.isArray(v)) {
    const next = v.filter((x) => x !== id);
    if (to != null && !next.includes(to)) next.push(to);
    setAt(row, ref.field, next);
  } else if (v === id) {
    setAt(row, ref.field, to);
  }
  return row;
}

// What removing `remove` ({ table: [ids] }) would do to the records outside it.
// → { edits: [{ table, row, ref, id, fromTable, to }], needsKennel }. needsKennel:
// a record outside the set points at a removed kennel and there's no target.
// `dropKennelLinks`: with no target, clear kennel links too instead of refusing.
export async function planDetach(remove, { kennelTarget = null, dropKennelLinks = false } = {}) {
  const sets = Object.fromEntries(Object.entries(remove).map(([t, ids]) => [t, new Set(ids || [])]));
  const existing = new Set(existingTableNames());
  const edits = [];
  let needsKennel = false;
  for (const [fromTable, ids] of Object.entries(sets)) {
    if (!ids.size) continue;
    for (const ref of REFERENCES_BY_TABLE[fromTable] || []) {
      if (!existing.has(ref.table)) continue;
      for (const row of await findReferencingRows(ref, ids)) {
        if (sets[ref.table]?.has(row.id)) continue; // going too
        for (const id of refIdsOf(row, ref)) {
          if (!ids.has(id)) continue;
          const kennel = fromTable === 'kennels';
          if (kennel && !kennelTarget && !dropKennelLinks) needsKennel = true;
          edits.push({ table: ref.table, rowId: row.id, ref, id, fromTable, to: kennel ? kennelTarget : null });
        }
      }
    }
  }
  return { edits, needsKennel };
}

// Remove every record in `remove` and detach what points at them, in one
// transaction. Refuses (changes nothing) when a kennel link has nowhere to go:
// → { removed: false, needsKennel: true, edits }. Else { removed: true, edits }.
// `markChanged`: the removed records were real ones (backed up, synced), so the
// change is marked for the cloud; edits to records outside the set always are.
export async function removeDetaching(remove, { kennelTarget = null, dropKennelLinks = false, markChanged = false } = {}) {
  const plan = await planDetach(remove, { kennelTarget, dropKennelLinks });
  if (plan.needsKennel) return { removed: false, needsKennel: true, edits: plan.edits };
  const now = new Date().toISOString();
  const touched = new Map(); // `${table}:${id}` → edited row
  for (const e of plan.edits) {
    const k = `${e.table}:${e.rowId}`;
    if (!touched.has(k)) {
      const row = await db.table(e.table).get(e.rowId);
      if (!row) continue;
      touched.set(k, { table: e.table, row });
    }
    detachRow(touched.get(k).row, e.ref, e.id, e.to);
  }
  const tables = new Set([...Object.keys(remove), ...[...touched.values()].map((t) => t.table)]);
  await db.transaction('rw', [...tables].filter((t) => new Set(existingTableNames()).has(t)).map((t) => db.table(t)), async () => {
    for (const { table, row } of touched.values()) await db.table(table).put({ ...row, updated_at: now });
    for (const [table, ids] of Object.entries(remove)) if (ids?.length) await db.table(table).bulkDelete(ids);
  });
  if (touched.size || markChanged) markDataChanged();
  return { removed: true, edits: plan.edits };
}
