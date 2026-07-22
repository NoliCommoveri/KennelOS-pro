// referenceRegistry.js — the single declared list of every foreign key that
// points at each entity, plus the generic guard that drives hard-delete blocking
// (Data Model v3 §10, Stage4 Revision v2 §4).
//
// Stage 4 note: every relationship now has ONE canonical stored side; the
// reverse is always a derived query, never a second stored pointer (Data Model
// v3 §1, sixth design principle). That means every entry below points at a field
// that is actually written somewhere — there is no `Sale.contract_id`,
// `StudService.contract_id`, or `Pairing.stud_service_id` to guard, because
// those fields don't exist.
//
// Why a registry instead of ad-hoc checks in each repo:
//  - It stays HONEST per stage. `findBlockingReferences` skips any entry whose
//    table doesn't exist in the current schema version — a harmless no-op now
//    that all ten tables exist from version(1), but kept so a future unshipped
//    table can't silently break the guard.
//  - It can't silently rot: adding a referencing table later means appending one
//    line here, not remembering to update a scattered check.
//
// Entry shape:
//   { table, field, label,
//     multiEntry?:   true if `field` is a Dexie multi-entry (*) index,
//     compoundIndex? + discriminatorValue?:  for the polymorphic Event, match
//       only rows of the right subject_type via the [subject_type+subject_id]
//       compound index }
import { db, existingTableNames } from './db.js';

// --- Dog: what can point at a Dog (Data Model v3 §10) -----------------------
export const DOG_REFERENCES = [
  { table: 'dogs',          field: 'sire_id',        label: 'sire of another dog' },
  { table: 'dogs',          field: 'dam_id',         label: 'dam of another dog' },
  {
    table: 'events', field: 'subject_id', label: 'subject of an event',
    compoundIndex: '[subject_type+subject_id]', discriminatorValue: 'dog'
  },
  { table: 'events',        field: 'related_dog_id', label: 'partner on an event' },
  { table: 'pairings',      field: 'sire_id',        label: 'sire in a pairing' },
  { table: 'pairings',      field: 'dam_id',         label: 'dam in a pairing' },
  { table: 'litters',       field: 'sire_id',        label: 'sire of a litter' },
  { table: 'litters',       field: 'dam_id',         label: 'dam of a litter' },
  { table: 'sales',         field: 'dog_id',         label: 'placed via a sale' },
  { table: 'stud_services', field: 'our_dog_id',     label: 'our dog in a stud service' },
  { table: 'stud_services', field: 'partner_dog_id', label: 'partner dog in a stud service' },
  { table: 'contracts',     field: 'related_dog_id', label: 'subject of a contract' },
  {
    table: 'expenses', field: 'subject_id', label: 'subject of an expense',
    compoundIndex: '[subject_type+subject_id]', discriminatorValue: 'dog'
  },
  { table: 'documents', field: 'dog_id', label: 'has a filed document' }
];

// --- Litter: what can point at a Litter (Data Model v3 §10) -----------------
// A litter can't be hard-deleted while any Dog still has litter_id pointing at it
// (its puppy roster). Archive instead.
export const LITTER_REFERENCES = [
  { table: 'dogs', field: 'litter_id', label: 'puppy roster member' },
  {
    table: 'expenses', field: 'subject_id', label: 'subject of an expense',
    compoundIndex: '[subject_type+subject_id]', discriminatorValue: 'litter'
  }
];

// --- Pairing: what can point at a Pairing -----------------------------------
// A linked litter (Litter.pairing_id), a linked stud service (StudService.pairing_id
// — canonical, mirrors Litter.pairing_id), or any Event logged against the pairing
// blocks hard delete.
export const PAIRING_REFERENCES = [
  { table: 'litters',       field: 'pairing_id', label: 'linked litter' },
  {
    table: 'events', field: 'subject_id', label: 'subject of an event',
    compoundIndex: '[subject_type+subject_id]', discriminatorValue: 'pairing'
  },
  { table: 'stud_services', field: 'pairing_id', label: 'linked stud service' },
  {
    table: 'expenses', field: 'subject_id', label: 'subject of an expense',
    compoundIndex: '[subject_type+subject_id]', discriminatorValue: 'pairing'
  }
];

// --- Contact: what can point at a Contact -----------------------------------
// Now includes the merged-in buyer role via sales.buyer_contact_id (Stage 4 —
// there is no separate Buyer entity; a buyer is a Contact, Data Model v3 §5.5).
export const CONTACT_REFERENCES = [
  { table: 'dogs',          field: 'owner_contact_id',     label: 'owner of a dog' },
  { table: 'dogs',          field: 'co_owner_contact_ids', label: 'co-owner of a dog', multiEntry: true },
  { table: 'sales',         field: 'buyer_contact_id',        label: 'buyer on a sale' },
  { table: 'sales',         field: 'referred_by_contact_id',  label: 'referrer on a sale' },
  { table: 'stud_services', field: 'partner_contact_id',      label: 'partner contact in a stud service' },
  { table: 'stud_services', field: 'referred_by_contact_id',  label: 'referrer on a stud service' },
  { table: 'events',        field: 'related_contact_id',      label: 'contact on a boarding event' },
  { table: 'contracts',     field: 'related_contact_id',      label: 'counterparty on a contract' },
  { table: 'litters',       field: 'foster_partner_contact_id', label: 'foster partner on a litter' }
];

// --- Kennel: what can point at a Kennel -------------------------------------
export const KENNEL_REFERENCES = [
  { table: 'contacts', field: 'kennel_id',          label: 'kennel of a contact' },
  { table: 'dogs',     field: 'kennel_id',          label: 'kennel of a dog' },
  { table: 'dogs',     field: 'breeder_kennel_id',  label: 'breeder kennel of a dog' },
  {
    table: 'expenses', field: 'subject_id', label: 'subject of an expense',
    compoundIndex: '[subject_type+subject_id]', discriminatorValue: 'kennel'
  }
];

// --- Sale: what can point at a Sale (Stage 4) -------------------------------
export const SALE_REFERENCES = [
  { table: 'contracts', field: 'related_sale_id', label: 'documented by a contract' }
];

// --- StudService: what can point at a StudService (Stage 4) ----------------
export const STUD_SERVICE_REFERENCES = [
  { table: 'contracts', field: 'related_stud_service_id', label: 'documented by a contract' }
];

// --- Contract: a leaf entity — nothing points at a Contract (Stage 4). Always
// hard-deletable; Data Model v3 §5.7.
export const CONTRACT_REFERENCES = [];

// --- Event: an Expense captured from an event points back at it via
// expenses.event_id (the ONE canonical event↔cost link; the event queries it,
// never mirrors it). So an event carrying a linked expense can't be hard-deleted
// out from under its cost — archive it, or remove the cost first. Events were a
// leaf before the Financials ledger; this is the only thing that points at one.
export const EVENT_REFERENCES = [
  { table: 'expenses', field: 'event_id', label: 'linked expense' }
];

// --- Expense: a leaf entity — nothing points at an Expense. Its own FKs
// (event_id, subject_id) point OUTWARD and are guarded on those targets above.
export const EXPENSE_REFERENCES = [];

// --- Document: a leaf entity — nothing points at a Document. Its own FK
// (dog_id) points OUTWARD and is guarded on Dog above (DOG_REFERENCES). Its
// file_id is not a referenceRegistry entry — a file is owned by exactly one
// document and is deleted alongside it (documentRepo.hardDelete), not guarded.
export const DOCUMENT_REFERENCES = [];

// Count rows matching one registry entry for the given target id.
async function countReferences(ref, id) {
  const table = db.table(ref.table);
  if (ref.compoundIndex) {
    // Polymorphic reference (Event): match [discriminatorValue, id] on the
    // compound index so we only count events whose subject_type is right.
    return table.where(ref.compoundIndex).equals([ref.discriminatorValue, id]).count();
  }
  // Both single-field and multi-entry (*) indexes answer .where(field).equals(id).
  return table.where(ref.field).equals(id).count();
}

// Generic guard: returns the list of human-readable blockers ({ label, count })
// for `id` against `registry`, skipping any table not present in the current
// schema. Empty array => hard delete is allowed.
export async function findBlockingReferences(registry, id) {
  const existing = new Set(existingTableNames());
  const blockers = [];
  for (const ref of registry) {
    if (!existing.has(ref.table)) continue; // stage-honest: don't probe absent tables
    const count = await countReferences(ref, id);
    if (count > 0) blockers.push({ label: ref.label, count });
  }
  return blockers;
}
