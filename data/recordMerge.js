// recordMerge.js — merge two records for one thing into one: Kels's "Tidy up my
// records" (dogs and contacts, End-State guide §33) and the Import/Export page's
// Scan for duplicates (any record, data/duplicateScan.js; guide §10). The breeder
// picks the record to keep and, where the two disagree, which value wins; then:
//   1. the kept record is updated through its repo (so every repo rule runs),
//   2. every id of the other record is replaced with the kept one's, in every
//      field of every record (nested ones included, as a file Merge re-keys), in
//      one transaction, so all its keys and history move: events, sales,
//      litters, pups, expenses, documents, waitlist places, ids inside lists,
//   3. the other record is deleted (never archived: it's a mistake, not a
//      record), its own file with it unless the kept one took it over; the
//      registry (referenceRegistry.js) confirms nothing still points at it,
//   4. this app's settings follow (settings.remapStoredIds): drafts, dismissals,
//      My kennel, the active kennel.
import { db, dataTables } from './db.js';
import {
  DOG_REFERENCES, CONTACT_REFERENCES, KENNEL_REFERENCES, LITTER_REFERENCES, PAIRING_REFERENCES, SALE_REFERENCES,
  STUD_SERVICE_REFERENCES, CONTRACT_REFERENCES, EVENT_REFERENCES, WAITLIST_ENTRY_REFERENCES, WAITLIST_PROGRAM_REFERENCES,
  WAITLIST_OFFER_REFERENCES, EXPENSE_REFERENCES, BREED_FEEDING_SCHEDULE_REFERENCES, ACCOUNT_REFERENCES, DOCUMENT_REFERENCES,
  findBlockingReferences
} from './referenceRegistry.js';
import { dogRepo } from './dogRepo.js';
import { contactRepo } from './contactRepo.js';
import { kennelRepo } from './kennelRepo.js';
import { accountRepo } from './accountRepo.js';
import { waitlistProgramRepo } from './waitlistProgramRepo.js';
import { breedFeedingScheduleRepo } from './breedFeedingScheduleRepo.js';
import { pairingRepo } from './pairingRepo.js';
import { litterRepo } from './litterRepo.js';
import { saleRepo } from './saleRepo.js';
import { studServiceRepo } from './studServiceRepo.js';
import { contractRepo } from './contractRepo.js';
import { eventRepo } from './eventRepo.js';
import { expenseRepo } from './expenseRepo.js';
import { documentRepo } from './documentRepo.js';
import { waitlistEntryRepo, syncContactWaitlistStatus } from './waitlistEntryRepo.js';
import { waitlistOfferRepo } from './waitlistOfferRepo.js';
import { assertWritable } from './demoMode.js';
import { markDataChanged, remapStoredIds } from './settings.js';
import { nowIso, ReferenceBlockedError } from './repoBase.js';
import { fileRepo } from './fileRepo.js';
import { rekey } from './restoreMatch.js';
import { findDuplicates } from './duplicateScan.js';

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
    unions: ['co_owner_contact_ids', 'planned_tests']
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
    unions: ['contact_type']
  }
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

// --- Any record (Scan for duplicates) ----------------------------------------------

const REPOS = {
  dogs: dogRepo, contacts: contactRepo, kennels: kennelRepo, accounts: accountRepo, waitlist_programs: waitlistProgramRepo,
  breed_feeding_schedules: breedFeedingScheduleRepo, pairings: pairingRepo, litters: litterRepo, sales: saleRepo,
  stud_services: studServiceRepo, contracts: contractRepo, events: eventRepo, expenses: expenseRepo, documents: documentRepo,
  waitlist_entries: waitlistEntryRepo, waitlist_offers: waitlistOfferRepo
};
const KIND = { dogs: 'dog', contacts: 'contact' };
const REGISTRY = {
  dogs: DOG_REFERENCES, contacts: CONTACT_REFERENCES, kennels: KENNEL_REFERENCES, accounts: ACCOUNT_REFERENCES,
  waitlist_programs: WAITLIST_PROGRAM_REFERENCES, breed_feeding_schedules: BREED_FEEDING_SCHEDULE_REFERENCES,
  pairings: PAIRING_REFERENCES, litters: LITTER_REFERENCES, sales: SALE_REFERENCES, stud_services: STUD_SERVICE_REFERENCES,
  contracts: CONTRACT_REFERENCES, events: EVENT_REFERENCES, expenses: EXPENSE_REFERENCES, documents: DOCUMENT_REFERENCES,
  waitlist_entries: WAITLIST_ENTRY_REFERENCES, waitlist_offers: WAITLIST_OFFER_REFERENCES
};

// Never chosen between or copied: identity, timestamps, a kennel's permanent public
// ID (the kept kennel's stays; the other's goes with it into the archive), and notes
// (kept from both).
const ANY_NEVER_COPY = new Set(['id', 'created_at', 'updated_at', 'is_archived', 'public_id', 'notes']);
const isObj = (v) => v != null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const isList = (v) => Array.isArray(v) && v.every((x) => x == null || typeof x !== 'object');
const sameValue = (a, b) => same(a, b) || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
const fieldLabel = (key) => {
  const words = key.replace(/_ids?$/, '').replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
// Two detail objects disagree where both have a key and the values differ.
const objectsClash = (a, b) => Object.keys(a).some((k) => !blank(a[k]) && !blank(b[k]) && !sameValue(a[k], b[k]));

// Where two records of `table` disagree: [{ key, label, keep, drop, ref?, group? }].
export function duplicateConflicts(table, keep, drop) {
  if (KIND[table]) return mergeConflicts(KIND[table], keep, drop);
  const out = [];
  for (const key of new Set([...Object.keys(keep), ...Object.keys(drop)])) {
    const k = keep[key];
    const d = drop[key];
    if (ANY_NEVER_COPY.has(key) || blank(k) || blank(d) || (isList(k) && isList(d))) continue;
    if (isObj(k) && isObj(d) ? objectsClash(k, d) : !sameValue(k, d)) out.push({ key, label: fieldLabel(key), keep: k, drop: d });
  }
  return out;
}

// The changes to write on the kept record: as mergedChanges, for any table.
// A detail object fills its blank keys from the other record's, or, chosen, takes
// the other's values where both have one.
export function duplicateChanges(table, keep, drop, choices = {}) {
  if (KIND[table]) return mergedChanges(KIND[table], keep, drop, choices);
  const changes = {};
  for (const [key, v] of Object.entries(drop)) {
    if (ANY_NEVER_COPY.has(key) || blank(v)) continue;
    const k = keep[key];
    if (blank(k)) changes[key] = v;
    else if (isList(k) && isList(v)) {
      const joined = [...new Set([...k, ...v])];
      if (joined.length !== k.length) changes[key] = joined;
    } else if (isObj(k) && isObj(v)) {
      const [base, over] = choices[key] === 'drop' ? [k, v] : [v, k];
      const merged = { ...base };
      for (const [kk, vv] of Object.entries(over)) if (!blank(vv) || !(kk in merged)) merged[kk] = vv;
      if (JSON.stringify(merged) !== JSON.stringify(k)) changes[key] = merged;
    } else if (choices[key] === 'drop' && !sameValue(k, v)) changes[key] = v;
  }
  const kn = String(keep.notes || '').trim();
  const dn = String(drop.notes || '').trim();
  if (dn && dn !== kn && !kn.includes(dn)) changes.notes = kn ? `${kn}\n\n${dn}` : dn;
  return changes;
}

// Why two records of `table` can't be merged (a sentence), or null.
export function duplicateBlocker(table, keep, drop, ctx = {}) {
  if (KIND[table]) return mergeBlocker(KIND[table], keep, drop, ctx);
  if (table === 'kennels' && !!keep.is_own_kennel !== !!drop.is_own_kennel) {
    return 'One is your kennel and the other is someone else\'s, so they can\'t be merged.';
  }
  return null;
}

// Every duplicate on this device (data/duplicateScan.js), read from the tables.
export async function scanForDuplicates({ flags = {}, dismissed } = {}) {
  const rows = {};
  for (const t of Object.keys(REPOS)) rows[t] = await db.table(t).toArray();
  return { findings: findDuplicates({ rows, flags, dismissed }), rows };
}

// Every id of `dropId` → `keepId`, in every field of every record but the
// duplicate itself (nested ones included). A list that now names the kept record
// twice names it once, and a dog's owner is never also its co-owner. Files hold
// only their bytes, so they're not read. → rows changed.
async function repointEverywhere(dropId, keepId) {
  const remap = new Map([[dropId, keepId]]);
  const tables = dataTables().filter((t) => t.name !== 'files');
  let moved = 0;
  await db.transaction('rw', tables, async () => {
    const now = nowIso();
    for (const t of tables) {
      for (const row of await t.toArray()) {
        if (row.id === dropId) continue;
        let next = rekey(row, remap);
        if (next === row) continue;
        next = { ...next };
        for (const [k, v] of Object.entries(next)) if (isList(v) && v !== row[k]) next[k] = [...new Set(v)];
        if (t.name === 'dogs' && next.owner_contact_id && (next.co_owner_contact_ids || []).includes(next.owner_contact_id)) {
          next.co_owner_contact_ids = next.co_owner_contact_ids.filter((x) => x !== next.owner_contact_id);
        }
        await db.table(t.name).put({ ...next, updated_at: now });
        moved++;
      }
    }
  });
  return moved;
}

// The duplicate itself, once nothing points at it: deleted, never archived, so no
// copy of the mistake is left to count or show. Its own file (a document's, an
// expense receipt's) goes with it unless the kept record took it over. A
// reference still left (it never should be) stops it with the registry's words.
async function deleteDuplicate(table, drop) {
  const blockers = await findBlockingReferences(REGISTRY[table] || [], drop.id);
  if (blockers.length) throw new ReferenceBlockedError(table, blockers);
  await db.table(table).delete(drop.id);
  markDataChanged(); // cloud backup dirty signal (Cloud Phase 1 §3.2)
  for (const fileId of [drop.file_id, drop.receipt_file_id].filter(Boolean)) {
    const used = (await db.documents.filter((d) => d.file_id === fileId).count())
      + (await db.expenses.filter((e) => e.receipt_file_id === fileId).count());
    if (!used) await fileRepo.remove(fileId);
  }
}

// Merge `dropId` into `keepId`, both of `table`: the kept record takes the
// changes (through its repo, so every repo rule runs), everything that named the
// other one names it, the other one is deleted, and this app's settings follow.
// → { moved: rows repointed }.
export async function mergeDuplicate(table, keepId, dropId, choices = {}) {
  assertWritable();
  if (keepId === dropId) throw new Error('Pick two different records to merge.');
  const repo = REPOS[table];
  if (!repo) throw new Error(`Can't merge ${table} records.`);
  const [keep, drop] = await Promise.all([repo.getById(keepId), repo.getById(dropId)]);
  if (!keep || !drop) throw new Error('One of those records is gone.');
  const blocker = duplicateBlocker(table, keep, drop, {
    dogsById: table === 'dogs' ? new Map((await db.dogs.toArray()).map((d) => [d.id, d])) : new Map(),
    waitlistEntries: table === 'contacts' ? await db.waitlist_entries.toArray() : []
  });
  if (blocker) throw new Error(blocker);

  const changes = duplicateChanges(table, keep, drop, choices);
  if (Object.keys(changes).length) await repo.update(keepId, changes);
  const moved = await repointEverywhere(dropId, keepId);
  if (moved) markDataChanged(); // cloud backup dirty signal (Cloud Phase 1 §3.2)
  await deleteDuplicate(table, drop);
  remapStoredIds((v) => rekey(v, new Map([[dropId, keepId]])));
  if (table === 'contacts') await syncContactWaitlistStatus(keepId);
  if (table === 'waitlist_entries' && drop.contact_id && drop.contact_id !== keep.contact_id) await syncContactWaitlistStatus(drop.contact_id);
  return { moved };
}

// Kels's tidy-up: a dog ('dog') or a person ('contact').
export function mergeRecords(kind, keepId, dropId, choices = {}) {
  return mergeDuplicate(kind === 'dog' ? 'dogs' : 'contacts', keepId, dropId, choices);
}
