// recordMerge.js — merge two records for one dog, or one person, into one
// (Kels's "Tidy up my records", End-State guide §33). The breeder picks the
// record to keep and, where the two disagree, which value wins; then:
//   1. the kept record is updated through its repo (so every repo rule runs),
//   2. everything that pointed at the other record is pointed at the kept one,
//      in one transaction — the list comes from referenceRegistry.js (every FK
//      that can point at a dog or contact) plus EXTRA_REFERENCES below,
//   3. the other record is archived (soft delete; it keeps its own history).
// So a new FK that isn't in the registry is a merge that leaves rows behind:
// that's the second reason every FK goes in referenceRegistry.js.
import { db } from './db.js';
import { DOG_REFERENCES, CONTACT_REFERENCES } from './referenceRegistry.js';
import { dogRepo } from './dogRepo.js';
import { contactRepo } from './contactRepo.js';
import { syncContactWaitlistStatus } from './waitlistEntryRepo.js';
import { assertWritable } from './demoMode.js';
import { markDataChanged } from './settings.js';
import { nowIso } from './repoBase.js';

const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && !v.length);
const same = (a, b) => (typeof a === 'string' && typeof b === 'string' ? a.trim() === b.trim() : a === b);

// Fields she chooses between when both records have one and they differ. Each
// `{ key, label, ref? }`: ref = what the id names, so the UI can show a name.
// `group` fields move together (a dog's ownership: who owns it, where it lives,
// its status), shown as one choice.
export const MERGE_SPEC = {
  dog: {
    fields: [
      { key: 'call_name', label: 'Call name' },
      { key: 'registered_name', label: 'Registered name' },
      { key: 'registration_number', label: 'Registration number' },
      { key: 'registry', label: 'Registry' },
      { key: 'breed', label: 'Breed' },
      { key: 'sex', label: 'Sex' },
      { key: 'date_of_birth', label: 'Birthday', date: true },
      { key: 'date_of_death', label: 'Date of death', date: true },
      { key: 'color_markings', label: 'Color & markings' },
      { key: 'microchip_id', label: 'Microchip' },
      { key: 'sire_id', label: 'Sire', ref: 'dog' },
      { key: 'dam_id', label: 'Dam', ref: 'dog' },
      { key: 'litter_id', label: 'Litter', ref: 'litter' },
      { key: 'breeder_kennel_id', label: 'Breeder kennel', ref: 'kennel' },
      { key: 'intended_registration', label: 'Intended registration' },
      { key: 'url', label: 'Link' }
    ],
    group: { key: 'ownership', label: 'Ownership & status', keys: ['ownership_type', 'status', 'status_date', 'kennel_id', 'owner_contact_id', 'pedigree_only', 'disposition'] },
    unions: ['co_owner_contact_ids', 'planned_tests'],
    references: DOG_REFERENCES
  },
  contact: {
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'email', label: 'Email' },
      { key: 'phone', label: 'Phone' },
      { key: 'address', label: 'Address' },
      { key: 'facebook_profile', label: 'Facebook' },
      { key: 'kennel_id', label: 'Kennel', ref: 'kennel' },
      { key: 'first_contact_source', label: 'First contact' },
      { key: 'companion_note', label: 'Note shown to them' }
    ],
    group: null,
    unions: ['contact_type'],
    references: CONTACT_REFERENCES
  }
};

// References the registry doesn't hold because they aren't indexed (so they
// can't block a delete), but a merge must still move. Scanned, not probed.
export const EXTRA_REFERENCES = {
  dog: [{ table: 'waitlist_offers', field: 'eligible_dog_ids', multiEntry: true }],
  contact: []
};

// Never copied from the other record: identity, timestamps, and fields kept by
// their own repos (waitlist_status is recomputed from the entries afterwards).
const NEVER_COPY = new Set(['id', 'created_at', 'updated_at', 'is_archived', 'waitlist_status', 'notes']);

// Which of two records to keep by default: one that's in use (not
// pedigree-only), then the fuller one, then the older one.
export function suggestKeep(a, b) {
  const score = (r) => (r.pedigree_only ? 0 : 1000) + Object.values(r).filter((v) => !blank(v)).length;
  if (score(a) !== score(b)) return score(a) > score(b) ? a : b;
  return String(a.created_at || '') <= String(b.created_at || '') ? a : b;
}

// Where the two disagree: [{ key, label, keep, drop, ref?, group? }].
export function mergeConflicts(kind, keep, drop) {
  const spec = MERGE_SPEC[kind];
  const out = spec.fields
    .filter((f) => !blank(keep[f.key]) && !blank(drop[f.key]) && !same(keep[f.key], drop[f.key]))
    .map((f) => ({ ...f, keep: keep[f.key], drop: drop[f.key] }));
  if (spec.group && spec.group.keys.some((k) => !same(keep[k] ?? null, drop[k] ?? null))) {
    out.push({ key: spec.group.key, label: spec.group.label, group: true, keep: pick(keep, spec.group.keys), drop: pick(drop, spec.group.keys) });
  }
  return out;
}

const pick = (r, keys) => Object.fromEntries(keys.map((k) => [k, r[k] ?? null]));

// The changes to write on the kept record. `choices[key] === 'drop'` takes the
// other record's value for a conflict; a field the kept record lacks is filled
// from the other; lists are joined; notes are kept from both.
export function mergedChanges(kind, keep, drop, choices = {}) {
  const spec = MERGE_SPEC[kind];
  const groupKeys = new Set(spec.group?.keys || []);
  const changes = {};
  for (const [key, v] of Object.entries(drop)) {
    if (NEVER_COPY.has(key) || groupKeys.has(key) || spec.unions.includes(key)) continue;
    if (blank(keep[key]) && !blank(v)) changes[key] = v;
    else if (!blank(v) && choices[key] === 'drop' && !same(keep[key], v)) changes[key] = v;
  }
  if (spec.group && choices[spec.group.key] === 'drop') {
    for (const k of spec.group.keys) changes[k] = drop[k] ?? null;
  }
  for (const key of spec.unions) {
    const joined = [...new Set([...(keep[key] || []), ...(drop[key] || [])])];
    if (joined.length !== (keep[key] || []).length) changes[key] = joined;
  }
  const kn = String(keep.notes || '').trim();
  const dn = String(drop.notes || '').trim();
  if (dn && dn !== kn && !kn.includes(dn)) changes.notes = kn ? `${kn}\n\n${dn}` : dn;
  // A merged dog's co-owners never include its owner.
  if (kind === 'dog') {
    const owner = changes.owner_contact_id ?? keep.owner_contact_id;
    const co = changes.co_owner_contact_ids ?? keep.co_owner_contact_ids;
    if (owner && (co || []).includes(owner)) changes.co_owner_contact_ids = co.filter((id) => id !== owner);
  }
  return changes;
}

// Why these two can't be merged (a sentence), or null. Dogs: a known sex that
// differs, or one is the other's ancestor (merging would make a dog its own
// parent). Contacts: both are live on the same kennel's waitlist (one family,
// one place in line — settle that on the waitlist first).
export function mergeBlocker(kind, keep, drop, { dogsById = new Map(), waitlistEntries = [] } = {}) {
  if (kind === 'dog') {
    const sx = (d) => (d.sex === 'male' || d.sex === 'female' ? d.sex : '');
    if (sx(keep) && sx(drop) && sx(keep) !== sx(drop)) return 'One is a male and one is a female, so they can\'t be the same dog.';
    if (ancestors(keep.id, dogsById).has(drop.id) || ancestors(drop.id, dogsById).has(keep.id)) {
      return 'One of them is in the other\'s pedigree, so they can\'t be the same dog.';
    }
    return null;
  }
  const LIVE = ['applied', 'approved', 'active'];
  const live = (id) => new Set(waitlistEntries.filter((e) => !e.is_archived && e.contact_id === id && LIVE.includes(e.status)).map((e) => e.kennel_id));
  const a = live(keep.id);
  if ([...live(drop.id)].some((k) => a.has(k))) {
    return 'Both of them have a place on the same waitlist. Remove one of those places on the Waitlist page first, then merge them.';
  }
  return null;
}

function ancestors(id, dogsById) {
  const seen = new Set();
  const stack = [dogsById.get(id)?.sire_id, dogsById.get(id)?.dam_id];
  while (stack.length) {
    const x = stack.pop();
    if (!x || seen.has(x)) continue;
    seen.add(x);
    const d = dogsById.get(x);
    if (d) stack.push(d.sire_id, d.dam_id);
  }
  return seen;
}

// A row with `field` pointing at `fromId`, pointed at `toId` instead.
export function repointed(row, ref, fromId, toId) {
  const v = row[ref.field];
  if (ref.multiEntry || Array.isArray(v)) {
    const list = [...new Set((v || []).map((x) => (x === fromId ? toId : x)))];
    return { ...row, [ref.field]: list };
  }
  return { ...row, [ref.field]: toId };
}

async function rowsPointingAt(ref, id) {
  const t = db.table(ref.table);
  if (ref.compoundIndex) return t.where(ref.compoundIndex).equals([ref.discriminatorValue, id]).toArray();
  if (EXTRA_REFERENCES.dog.includes(ref) || EXTRA_REFERENCES.contact.includes(ref)) {
    return t.filter((r) => (r[ref.field] || []).includes(id)).toArray();
  }
  return t.where(ref.field).equals(id).toArray();
}

// Merge `dropId` into `keepId`. → { moved: number of rows repointed }.
export async function mergeRecords(kind, keepId, dropId, choices = {}) {
  assertWritable();
  if (keepId === dropId) throw new Error('Pick two different records to merge.');
  const repo = kind === 'dog' ? dogRepo : contactRepo;
  const [keep, drop] = await Promise.all([repo.getById(keepId), repo.getById(dropId)]);
  if (!keep || !drop) throw new Error('One of those records is gone.');
  const blocker = mergeBlocker(kind, keep, drop, kind === 'dog'
    ? { dogsById: new Map((await db.dogs.toArray()).map((d) => [d.id, d])) }
    : { waitlistEntries: await db.waitlist_entries.toArray() });
  if (blocker) throw new Error(blocker);

  const changes = mergedChanges(kind, keep, drop, choices);
  if (Object.keys(changes).length) await repo.update(keepId, changes);

  const refs = [...MERGE_SPEC[kind].references, ...EXTRA_REFERENCES[kind]];
  const tables = [...new Set(refs.map((r) => r.table))];
  let moved = 0;
  await db.transaction('rw', tables.map((t) => db.table(t)), async () => {
    const now = nowIso();
    for (const ref of refs) {
      for (const row of await rowsPointingAt(ref, dropId)) {
        if (row.id === dropId) continue;
        let next = repointed(row, ref, dropId, keepId);
        // A dog whose owner is now also listed as a co-owner: just the owner.
        if (ref.table === 'dogs' && next.owner_contact_id && (next.co_owner_contact_ids || []).includes(next.owner_contact_id)) {
          next = { ...next, co_owner_contact_ids: next.co_owner_contact_ids.filter((x) => x !== next.owner_contact_id) };
        }
        await db.table(ref.table).put({ ...next, updated_at: now });
        moved++;
      }
    }
  });
  if (moved) markDataChanged(); // cloud backup dirty signal (Cloud Phase 1 §3.2)

  await repo.archive(dropId);
  if (kind === 'contact') await syncContactWaitlistStatus(keepId);
  return { moved };
}
