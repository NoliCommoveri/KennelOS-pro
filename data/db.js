// db.js — Dexie schema definition (single source of truth for tables/indexes).
//
// Layering rule (see CLAUDE.md): pages never import this file directly and never
// call db.<table>.* — they go through the repo modules in /data. The repos are the
// only code that touches Dexie.
//
// Dexie is vendored locally (no CDN) so the app works offline after first load.
import Dexie from '../vendor/dexie.min.mjs';

// App-specific DB name: project pages on github.io share one origin as path
// prefixes, so a distinct name prevents collisions with anything else the user
// hosts on the same account (Data Model doc §2.1).
export const db = new Dexie('KennelOSBreedingApp');

// --- Schema ---------------------------------------------------------------
// Fresh repo, no shipped data yet — schema starts collapsed at a SINGLE
// version(1) block covering all ten tables. That ladder only exists to
// protect real-data migrations, and nothing has shipped — there is no live data
// to migrate, so this block absorbs every change and is edited in place. The
// first `.version(2)` block should be added only at the first real release;
// from then on, additive versioning applies as Dexie expects and this block
// is never edited again.
//
// Index notes:
//  - events '[subject_type+subject_id]' is a COMPOUND index, required for fast
//    "timeline for this dog/pairing/litter" lookups. Do not split into two.
//  - dogs '*co_owner_contact_ids' is a MULTI-ENTRY index so "dogs co-owned by X"
//    is a real query, not a full scan.
//  - Every canonical FK (Stage 4: sales/contracts/stud_services; Stage 4.5:
//    events.related_contact_id) is indexed, so every reverse lookup in
//    referenceRegistry.js is an index probe, never a scan.
//  - Only fields we actually query/filter on are indexed; all other fields still
//    persist, they just aren't indexed. `events.event_end_date` (Stage 4.5) is a
//    deliberate example: a plain nullable YYYY-MM-DD field, never queried/sorted
//    on directly, so it carries no index (Stage4.5 Addendum §C1).
//  - events '.reminder_date' IS indexed: the reminder engine's getReminders()
//    range-probes it. Every further index after the first real release goes
//    in an additive `.version(2)` block that is never edited again.
//  - `events.reminder_dismissed` (boolean) and `dogs.recorded_coi` (object) are
//    deliberately UNindexed: they persist and ride the JSON backup, but nothing
//    queries them by key, so they stay out of the index strings below.
//  - `dogs.breeder_kennel_id` (FK → Kennel, the kennel that produced this dog —
//    distinct from `kennel_id`, which of the user's own kennels the dog belongs
//    to now) is indexed like every other canonical Dog FK, and guarded in
//    `KENNEL_REFERENCES` (referenceRegistry.js) so a Kennel can't be
//    hard-deleted out from under a dog that still names it as its breeder.
//  - `contracts.related_contact_id` (Companion feature) is the counterparty FK
//    for lease/co_own/other contracts — the types with no linked Sale/StudService
//    to reach a contact through. Indexed like every other canonical Contract FK
//    (so contractRepo.getByContact is an index probe) and guarded in
//    CONTACT_REFERENCES. Forced null for other types (contractRepo.normalizeLinks).
//  - `expenses` (Financials ledger) is the single home for money spent. It is
//    polymorphic like events — '[subject_type+subject_id]' compound index —
//    with subject_type ∈ {dog, litter, pairing, kennel}, so a cost can attach to
//    any of them (kennel-wide overhead lives on subject_type='kennel'). Its
//    `event_id` is the ONE canonical link between an event and its cost: a cost
//    entered on the event form is written here carrying the event's id, and the
//    event/timeline just query it back (expenseRepo.getByEvent) — Event no longer
//    stores a `cost` field. Indexed on event_id (fast "cost for this event"),
//    category (report filter), and expense_date (report range).
//  - litters.`foster_partner_contact_id` is a per-litter foster fact (the same
//    dam can have more than one foster litter, so it can't live on the Dog):
//    indexed because the referential guard (CONTACT_REFERENCES) probes it so a
//    foster partner contact can't be hard-deleted out from under a litter.
//    `foster_direction` and the split fields (`foster_our_share_pct`,
//    `foster_split_basis`, `foster_split_notes`) are plain unindexed fields
//    (filtered in JS, like is_archived) and so are NOT listed.
//  - `documents` is a filed document (pedigree/health test/registration/contract/
//    other) belonging to exactly one dog and pointing at exactly one stored
//    `files` row (documentRepo.js). Indexed on dog_id (a dog's document list),
//    doc_type (the type filter chips), and doc_date (newest-first sort).
//  - `files` is the blob archive backing `documents` AND `expenses.receipt_file_id`
//    — the bytes of an uploaded PDF, or a photo/screenshot converted to a
//    compressed PDF client-side (data/pdfBuild.js), never queried by anything
//    but id, so only `created_at` (backup ordering) is indexed alongside it.
//  - `expenses.receipt_file_id` (assets/receiptCapture.js) is a plain,
//    unindexed FK into `files` — same posture as `vendor`/`notes`, fetched by
//    id only, never queried/filtered on.
//  - `breed_feeding_schedules` is the kennel's own recommended feeding grid per
//    breed (food brand + a free-text weight-band x age-column table + notes),
//    fed into a placed pup's Furever seed packet (fureverSeedExport.js). `breed`
//    is a free-text lookup key (matched case-insensitively/trimmed against
//    Dog.breed), not a stored FK, so it carries no referenceRegistry entry.
//    Indexed on breed (breedFeedingScheduleRepo.getByBreed is a probe, not a
//    scan). `litters.feeding_schedule_override` (a plain, unindexed free-text
//    field, filtered in JS like the foster fields) is the per-litter override
//    that takes priority over the breed default in the seed packet — both are
//    Pro-only (editionFlags.feedingSchedule).
db.version(1).stores({
  dogs:          'id, sire_id, dam_id, litter_id, breeder_kennel_id, owner_contact_id, *co_owner_contact_ids, status, ownership_type, sex, breed, kennel_id, is_archived',
  events:        'id, [subject_type+subject_id], event_type, event_date, reminder_date, related_dog_id, related_contact_id, is_archived',
  expenses:      'id, event_id, [subject_type+subject_id], category, expense_date, is_archived',
  contacts:      'id, kennel_id, waitlist_status, is_archived',
  kennels:       'id, is_archived',
  pairings:      'id, sire_id, dam_id, status, pairing_type, is_archived',
  litters:       'id, pairing_id, sire_id, dam_id, status, whelp_date, foster_partner_contact_id, is_archived',
  sales:         'id, dog_id, buyer_contact_id, referred_by_contact_id, status, placement_type, is_archived',
  contracts:     'id, contract_type, status, related_sale_id, related_stud_service_id, related_dog_id, related_contact_id, is_archived',
  stud_services: 'id, our_dog_id, partner_dog_id, partner_contact_id, referred_by_contact_id, direction, status, pairing_id, is_archived',
  documents:     'id, dog_id, doc_type, doc_date, is_archived',
  files:         'id, created_at',
  breed_feeding_schedules: 'id, breed, is_archived'
});

// --- First-run storage durability ----------------------------------------
// Ask the browser to keep this origin's data from being evicted under storage
// pressure (Data Model doc §2.1). Best-effort; safe to ignore if unsupported.
export async function requestPersistentStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      return await navigator.storage.persist();
    }
  } catch {
    /* non-fatal — durability is a nicety, not a requirement */
  }
  return false;
}

// Convenience: the list of table names that actually exist in the current schema
// version. referenceRegistry / import-export use this so stage-aware code never
// probes a table that doesn't exist yet.
export function existingTableNames() {
  return db.tables.map((t) => t.name);
}
