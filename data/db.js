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
// FROZEN (2026-10-10). version(1) is what every installed device has: real
// users have kept records in production since 2026-10-07, so this block is
// NEVER edited again. Every schema change from here on is ADDITIVE, in a new
// `db.version(N).stores({...})` block below that lists only the tables it adds
// or re-indexes (Dexie 4 carries the rest forward), and a shipped block is
// never edited either. A new field needs no block at all unless it's indexed.
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
//  - `kennel_id` on `pairings`/`litters`/`sales`/`stud_services`/`contracts`/
//    `documents` is the KENNEL SCOPE (Multi-Kennel Scope Spec §4.1): which of the
//    user's own kennels the record belongs to. Stamped on create by inheriting
//    from the record's parent (a sale from its dog, a contract from its sale, a
//    litter from the active kennel…) — never derived at read time, so a dog
//    moving between the user's kennels can't retroactively rewrite the history of
//    a litter or sale. Indexed so a scoped list is an index probe, not a scan,
//    and guarded in KENNEL_REFERENCES like every other kennel FK.
//    Deliberately NOT stamped: `events`/`expenses` are polymorphic and derive
//    their scope from the subject they hang off (a second stored scope would be a
//    second source of truth); `files` is fetched by id only; and
//    `breed_feeding_schedules` is a program-wide per-breed lookup.
//  - `kennels.public_id` is the kennel's PORTABLE PUBLIC IDENTITY (End-State
//    guide §28): a `kos1_<uuid>` string minted once for each of the user's OWN
//    kennels and thereafter immutable, so the same real-world kennel keeps one
//    identifier across a JSON backup/restore, the Lite→Pro bridge, a Dropbox
//    sync, and any kennel card it hands to another breeder. It is NOT a foreign
//    key — nothing points at it, so it carries no referenceRegistry entry — but
//    it IS indexed, because the kennel-card import's match-or-create step probes
//    it (kennelRepo.getByPublicId) on every apply. An OUTSIDE kennel never has
//    one minted locally: its public_id can only ever be RECEIVED from a card its
//    owner issued, because minting one would be inventing somebody else's
//    identity. A blank public_id on an outside kennel is therefore meaningful,
//    not missing data — it says "I typed this kennel in myself".
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
//  - `waitlist_entries` / `waitlist_offers` / `waitlist_programs` are the per-kennel
//    waitlist (Waitlist Spec §4; End-State guide §29). Every FK is indexed so its
//    referenceRegistry probe is a lookup, never a scan — including the two
//    MULTI-ENTRY listen lists (`*listen_sire_ids`, `*listen_dam_ids`), which
//    the rules engine never queries by key but the hard-delete guard does.
//    `kennel_id` on all three is the kennel scope (one list per kennel). Position is
//    DERIVED (waitlistRules.js), never stored; so are passes (counted from offers).
//  - `accounts` is the breeder's own business accounts with vendors and
//    registries (AKC, Good Dog, Chewy…): login details for her (`username`,
//    `password`, `customer_id` — private tier, never plain cloud) and a
//    shareable `referral_link`/`referral_code` with `referral_instructions` for
//    the people she'll give them to. Program-wide (no kennel_id), with no FKs
//    of its own, so only is_archived is indexed; sorted by name in JS.
//  - `expenses.account_id` is an optional FK into `accounts` (which account a
//    cost was paid through — a Chewy order, an AKC fee). Indexed because the
//    referenceRegistry probe (ACCOUNT_REFERENCES) and the per-account spend on
//    the Accounts page look it up. `expenses.vendor` stays free text beside it.
db.version(1).stores({
  dogs:          'id, sire_id, dam_id, litter_id, breeder_kennel_id, owner_contact_id, *co_owner_contact_ids, status, ownership_type, sex, breed, kennel_id, is_archived',
  events:        'id, [subject_type+subject_id], event_type, event_date, reminder_date, related_dog_id, related_contact_id, is_archived',
  expenses:      'id, event_id, [subject_type+subject_id], category, expense_date, account_id, is_archived',
  contacts:      'id, kennel_id, waitlist_status, is_archived',
  kennels:       'id, public_id, is_archived',
  pairings:      'id, kennel_id, sire_id, dam_id, status, pairing_type, is_archived',
  litters:       'id, kennel_id, pairing_id, sire_id, dam_id, status, whelp_date, foster_partner_contact_id, is_archived',
  sales:         'id, kennel_id, dog_id, buyer_contact_id, referred_by_contact_id, status, registration_type, is_archived',
  contracts:     'id, kennel_id, contract_type, status, related_sale_id, related_stud_service_id, related_dog_id, related_contact_id, is_archived',
  stud_services: 'id, kennel_id, our_dog_id, partner_dog_id, partner_contact_id, referred_by_contact_id, direction, status, pairing_id, is_archived',
  documents:     'id, kennel_id, dog_id, doc_type, doc_date, is_archived',
  files:         'id, created_at',
  breed_feeding_schedules: 'id, breed, is_archived',
  accounts:      'id, is_archived',
  waitlist_entries:  'id, kennel_id, contact_id, status, waitlist_program_id, *listen_sire_ids, *listen_dam_ids, placed_sale_id, is_archived',
  waitlist_offers:   'id, entry_id, litter_id, kennel_id, chosen_dog_id, sale_id, outcome, is_archived',
  waitlist_programs: 'id, kennel_id, is_archived',
  device_secrets:    'id'
});

// version(2), 2026-10-10 (Cloud Phase 2 plan §3.4): `sync_meta`, device-only.
// One row per record this device has synced: id `<table>:<row id>`, `tbl`,
// `row_id`, `seq` (the server's seq for the version this device last pushed or
// pulled) and `hash` (the row's syncRecords.rowHash then). data/cloud/syncState.js
// is its only reader/writer.
db.version(2).stores({
  sync_meta: 'id, tbl'
});

// version(3), 2026-10-10 (Integrations plan §5): `sales.sales_channel_account_id`,
// the Account a sale was sold / paid through (Good Dog, Stripe…), indexed for the
// ACCOUNT_REFERENCES delete guard and a per-channel filter. Re-lists the sales
// index string from version(1) with the one index added.
db.version(3).stores({
  sales: 'id, kennel_id, dog_id, buyer_contact_id, referred_by_contact_id, status, registration_type, sales_channel_account_id, is_archived'
});

// --- Device-only tables ---------------------------------------------------
// `device_secrets` holds this device's unlocked private-vault key as a
// CryptoKey (Private Vault Plan §3.3; data/cloud/vaultKeyStore.js is its only
// reader/writer). It is NOT kennel data: it is never in exportAll, the JSON/
// Dropbox backups, the cloud snapshot, a file restore or the sample manifest,
// and it has no syncRegistry entry. Reset App and remote erase still clear it
// (appReset.js clears every table). Code that means "the kennel's records"
// iterates dataTables(), not db.tables.
//
// `sync_meta` (version 2) is device-only for the same reasons: it records what
// THIS device has synced (Cloud Phase 2 plan §3.4), so it never travels.
export const DEVICE_ONLY_TABLES = Object.freeze(['device_secrets', 'sync_meta']);

export function dataTables() {
  return db.tables.filter((t) => !DEVICE_ONLY_TABLES.includes(t.name));
}

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
// version, device-only tables included (Reset App clears them too).
// referenceRegistry uses this so stage-aware code never probes a table that
// doesn't exist yet.
export function existingTableNames() {
  return db.tables.map((t) => t.name);
}
