// syncRegistry.js — the per-table, per-field CLOUD ALLOW-LIST (Cloud Phase 1 plan
// §5; Waitlist Spec §9 for the three waitlist tables). It is the privacy promise
// of cloud backup: only what is listed here as `cloud` ever leaves the device.
//
// Rule zero: a field NOT listed as cloud is private. The registry lists cloud
// fields, so the default is safe — a field added later stays on the device until
// someone deliberately classifies it here. Every record's `id`, `is_archived`,
// `created_at`, `updated_at` are implicitly cloud.
//
// Each table entry:
//   rows    — the per-row rule: 'all' | 'none' | a predicate (row) => bool |
//             'referenced' (files: only those a KEPT document points at).
//   cloud   — the allow-list. A snapshot row is built FROM THIS LIST BY NAME,
//             never by spreading the source row (same posture as
//             companionExport.js).
//   private — the known private fields. Documentation + the coverage test only:
//             filtering never reads it (rule zero already makes them private).
//   pending — fields not yet classified by a decision. Treated as private (rule
//             zero) until someone moves them to `cloud` or `private`. Listed so
//             the coverage test passes while the open question stays visible.
//   filtered (optional) — { field: fn(value, row) } for a cloud field whose
//             CONTENTS are partly private (events.details).
//   partial (optional) — { field: [keys] } for a cloud field holding an OBJECT
//             of which only the listed keys are cloud (waitlist_entries.
//             application: name + email). The rest of the object stays private,
//             and a restore keeps the device's own copy of those keys.
//   derived (optional) — keys the snapshot builder adds that the local row
//             doesn't carry (files: `sha256`, in place of the blob, which is
//             uploaded separately — plan §4.1 step 4).
//
// A second registry to keep current, beside referenceRegistry.js: a NEW FIELD on
// any table must be classified here, or tests/syncRegistry.test.js fails once it
// shows up in the sample packet. Pure data + pure functions; no db, no network.
import { EVENT_TYPES } from './vocab.js';

export const IMPLICIT_CLOUD_FIELDS = Object.freeze(['id', 'is_archived', 'created_at', 'updated_at']);

// Documents whose rows (and files) go to the cloud. contract/other stay local.
export const CLOUD_DOC_TYPES = Object.freeze(['health_test', 'pedigree', 'registration']);

const ALL = 'all';
const NONE = 'none';
const REFERENCED = 'referenced';

export const SYNC_REGISTRY = Object.freeze({
  dogs: {
    rows: ALL,
    cloud: [
      'call_name', 'registered_name', 'sex', 'breed', 'status', 'ownership_type',
      'kennel_id', 'breeder_kennel_id', 'sire_id', 'dam_id', 'litter_id',
      'owner_contact_id', 'co_owner_contact_ids', 'date_of_birth', 'date_of_death',
      'color_markings', 'registry', 'registration_number', 'microchip_id', 'url',
      'planned_tests', 'disposition', 'dob_is_estimated', 'recorded_coi',
      'intended_placement' // Waitlist Spec §9
    ],
    private: ['notes'],
    pending: []
  },

  events: {
    rows: ALL,
    cloud: [
      'subject_type', 'subject_id', 'event_type', 'event_date', 'event_end_date',
      'title', 'reminder_date', 'reminder_dismissed', 'related_dog_id',
      'related_contact_id', 'details'
    ],
    private: ['notes'],
    pending: [],
    filtered: { details: (value, row) => filterEventDetails(row.event_type, value) }
  },

  kennels: {
    rows: ALL,
    cloud: [
      'kennel_name', 'prefix', 'public_id', 'is_own_kennel', 'location', 'website',
      'logo_data_url', 'preferred_tests', 'preferred_breeds', 'preferred_test_breeds',
      'promote_nudge_enabled', 'promote_age_male_months', 'promote_age_female_months',
      // Her own waitlist setup: rules, application form questions, FAQ, fee and
      // payment instructions. Her business settings, not anyone else's personal
      // data, so cloud, or a restore couldn't run her waitlist (decided 2026-10-07,
      // Cloud plan §5.1 decision 1).
      'waitlist_config'
    ],
    private: [],
    pending: []
  },

  contacts: {
    rows: ALL,
    cloud: ['name', 'contact_type', 'kennel_id', 'waitlist_status'],
    private: ['email', 'phone', 'address', 'notes', 'companion_note', 'first_contact_source'],
    pending: []
  },

  pairings: {
    rows: ALL,
    cloud: [
      'kennel_id', 'sire_id', 'dam_id', 'pairing_type', 'status', 'method',
      'planned_date', 'last_observed_date', 'expected_due_date'
    ],
    private: ['notes'],
    pending: []
  },

  litters: {
    rows: ALL,
    cloud: [
      'kennel_id', 'pairing_id', 'sire_id', 'dam_id', 'status', 'nickname',
      'whelp_date', 'accept_deposits_date', 'estimated_ready_date',
      'litter_registration_number', 'puppies_born_total', 'puppies_born_alive',
      'puppies_born_deceased', 'puppies_born_abnormalities', 'foster_direction',
      'foster_partner_contact_id',
      'picks_opened_date' // a waitlist date: the auto-offer flow needs it after a restore
    ],
    // Plan §5: "every price/deposit/foster-money field" — the foster comp model
    // and split basis are the terms of that money, so they stay with it.
    private: [
      'expected_price_male', 'expected_price_female', 'expected_deposit_male',
      'expected_deposit_female', 'foster_comp_model', 'foster_our_share_pct',
      'foster_split_basis', 'foster_flat_fee_per_pup', 'foster_split_notes',
      'feeding_schedule_override', 'notes'
    ],
    pending: []
  },

  sales: {
    rows: ALL,
    cloud: [
      'kennel_id', 'dog_id', 'buyer_contact_id', 'status', 'placement_type',
      'sale_date', 'deposit_date', 'balance_due_date', 'balance_paid_date'
    ],
    private: [
      'price', 'deposit_amount', 'transport_fee', 'deferred_boarding_amount',
      'deferred_boarding_frequency', 'deferred_boarding_duration_days',
      'invoice_number', 'invoice_notes', 'payment_method', 'payment_reference',
      'lead_source', 'referred_by_contact_id', 'notes'
    ],
    pending: []
  },

  stud_services: {
    rows: ALL,
    cloud: [
      'kennel_id', 'direction', 'type', 'our_dog_id', 'partner_dog_id',
      'partner_contact_id', 'pairing_id', 'status', 'fee_structure', 'pick_status',
      'sent_date', 'returned_date'
    ],
    private: [
      'fee_amount', 'pick_value_amount', 'result_notes', 'invoice_number',
      'invoice_notes', 'payment_method', 'payment_reference', 'referred_by_contact_id'
    ],
    pending: []
  },

  contracts: {
    rows: ALL,
    cloud: [
      'kennel_id', 'contract_type', 'status', 'title', 'related_sale_id',
      'related_stud_service_id', 'related_dog_id', 'related_contact_id',
      'signed_date', 'lease_start_date', 'lease_end_date'
    ],
    private: ['document_url', 'terms_summary', 'notes'],
    pending: []
  },

  documents: {
    rows: (row) => CLOUD_DOC_TYPES.includes(row.doc_type),
    cloud: [
      'kennel_id', 'dog_id', 'doc_type', 'file_id', 'title', 'doc_date',
      'issuer_or_lab', 'result', 'registry', 'registration_number'
    ],
    // contract_id only rides contract-type documents, whose whole row stays local.
    private: ['notes', 'contract_id'],
    pending: []
  },

  files: {
    rows: REFERENCED,
    cloud: ['mime', 'filename', 'size', 'thumbnail'],
    private: ['blob'], // never in the snapshot JSON; uploaded to R2 by sha256 instead
    pending: [],
    derived: ['sha256']
  },

  expenses: {
    rows: NONE, // the whole table is Financials — private
    cloud: [],
    private: [
      'subject_type', 'subject_id', 'amount', 'category', 'expense_date', 'event_id',
      'miles', 'mileage_rate', 'vendor', 'receipt_number', 'receipt_file_id',
      'reimbursable', 'reimbursed_date', 'notes'
    ],
    pending: []
  },

  breed_feeding_schedules: {
    rows: ALL,
    cloud: ['breed', 'food_brand', 'age_columns', 'weight_rows'],
    private: ['notes'],
    pending: []
  },

  waitlist_entries: {
    rows: ALL,
    cloud: [
      'kennel_id', 'contact_id', 'status', 'waitlist_program_id',
      // "every date field" (Waitlist Spec §9) — fee_received_date is the position anchor
      'applied_date', 'approved_date', 'declined_date', 'fee_due_date',
      'fee_received_date', 'position_anchor_date', 'paused_until', 'removed_date',
      'withdrawn_date', 'soon_notified_date',
      // the same-day tie-breaker of the list order (waitlistRules), so cloud for
      // the reason fee_received_date is: a restore must not re-order the list
      'fee_received_at',
      'pref_sex', 'pref_breed', 'pref_placement_type', 'pref_colors',
      'listen_mode', 'listen_sire_ids', 'listen_dam_ids',
      'removed_reason', 'placed_sale_id',
      // Decided 2026-10-07 (Cloud plan §5.1, decisions 1 and 2): the readiness
      // hold and the litters she told a family about are how the list RUNS; the
      // question wording is her own form; and the applicant's name + email are
      // what W2's server holds readable anyway (Waitlist Spec §8.1). Only those
      // two keys of `application` go (see `partial`); every other answer stays private.
      'ready_timing', 'soon_notified_litter_ids', 'application_questions', 'application'
    ],
    partial: { application: ['name', 'email'] },
    // pref_change_*: "private tier like application" (Waitlist Spec §15.9).
    private: [
      'fee_amount', 'fee_payment_method', 'fee_payment_reference',
      'fee_credit_policy', 'pause_reason', 'notes', 'pref_change_log', 'pref_change_request'
    ],
    pending: []
  },

  waitlist_offers: {
    rows: ALL,
    cloud: [
      'entry_id', 'litter_id', 'kennel_id', 'offered_date', 'respond_by_date',
      'eligible_dog_ids', 'outcome', 'outcome_date', 'chosen_dog_id', 'counts_as_pass',
      'picked_date', 'sale_id' // §9: "every field except notes"
    ],
    private: ['notes'],
    pending: []
  },

  waitlist_programs: {
    rows: ALL,
    cloud: [
      'kennel_id', 'name', 'applicable_on_form', 'priority', 'pause_allowed',
      'passes_count', 'respond_days_override', 'public_description'
    ],
    private: ['fee_override', 'notes'],
    pending: []
  }
});

export const REGISTRY_TABLES = Object.freeze(Object.keys(SYNC_REGISTRY));

// --- Event details ----------------------------------------------------------
// Derived from the vocab that already drives the event forms, so it can't
// drift: a declared key whose field type is `textarea` (free text — treatment,
// findings, temperament notes, notes/note) is private; every other declared
// key is cloud; an UNDECLARED key is private. EVENT_TYPES is the complete list
// (not edition-filtered), so a Pro-only type's keys classify the same in Lite.
const DETAILS_CLOUD_KEYS = new Map(
  EVENT_TYPES.map((t) => [
    t.value,
    new Set((t.fields || []).filter((f) => f.type !== 'textarea').map((f) => f.key))
  ])
);

export function cloudDetailKeys(eventType) {
  return DETAILS_CLOUD_KEYS.get(eventType) || new Set();
}

// A NEW object holding only the cloud keys of `details`, or null when the input
// isn't a plain object.
export function filterEventDetails(eventType, details) {
  if (details == null || typeof details !== 'object' || Array.isArray(details)) return null;
  const allowed = cloudDetailKeys(eventType);
  const out = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(details, key)) out[key] = details[key];
  }
  return out;
}

// --- Lookups ---------------------------------------------------------------
function entryFor(table) {
  const entry = SYNC_REGISTRY[table];
  if (!entry) throw new Error(`syncRegistry: no entry for table "${table}"`);
  return entry;
}

// Every key a snapshot row of `table` may carry: implicit + cloud + derived.
export function allowedSnapshotKeys(table) {
  const entry = entryFor(table);
  return new Set([...IMPLICIT_CLOUD_FIELDS, ...entry.cloud, ...(entry.derived || [])]);
}

export function isCloudField(table, field) {
  const entry = SYNC_REGISTRY[table];
  if (!entry) return false;
  return IMPLICIT_CLOUD_FIELDS.includes(field) || entry.cloud.includes(field);
}

// Does the per-row rule keep this row? `ctx.keptFileIds` (a Set) is required
// for 'referenced' tables (files).
export function keepsRow(table, row, ctx = {}) {
  const { rows } = entryFor(table);
  if (rows === ALL) return true;
  if (rows === NONE) return false;
  if (rows === REFERENCED) return !!(ctx.keptFileIds && ctx.keptFileIds.has(row.id));
  return !!rows(row);
}

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// Only the allowed keys of an object, as a NEW object; null when not an object.
function pickKeys(value, keys) {
  if (!isPlainObject(value)) return null;
  const out = {};
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(value, k)) out[k] = value[k];
  return out;
}

// The cloud keys allowed inside a nested object field, or null when the field
// isn't nested-filtered. events.details is derived from vocab per event type.
function nestedCloudKeys(table, field, row) {
  const entry = entryFor(table);
  if (entry.partial && entry.partial[field]) return new Set(entry.partial[field]);
  if (table === 'events' && field === 'details') return cloudDetailKeys(row.event_type);
  return null;
}

// A NEW object built by name from the table's implicit + cloud fields. Keys the
// source row doesn't have are omitted (not written as undefined). `filtered`
// fields pass through their filter, and `partial` fields keep only their listed
// keys. Derived keys are NOT added here — the snapshot builder adds them
// (files' sha256).
export function projectRow(table, row) {
  const entry = entryFor(table);
  const out = {};
  for (const field of [...IMPLICIT_CLOUD_FIELDS, ...entry.cloud]) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) continue;
    const filter = entry.filtered && entry.filtered[field];
    const partial = entry.partial && entry.partial[field];
    out[field] = filter ? filter(row[field], row) : partial ? pickKeys(row[field], partial) : row[field];
  }
  return out;
}

// Apply the row rules + projection to a whole `{ table: rows[] }` collection
// map (the exportAll shape). Tables without a registry entry are dropped —
// silence is the safe default. Documents are decided before files, because a
// file goes only if a kept document references it.
export function filterCollectionsForCloud(collections) {
  const out = {};
  const keptDocs = (collections.documents || []).filter((r) => keepsRow('documents', r));
  const keptFileIds = new Set(keptDocs.map((d) => d.file_id).filter(Boolean));
  for (const table of REGISTRY_TABLES) {
    const rows = collections[table];
    if (!Array.isArray(rows)) continue;
    out[table] = rows
      .filter((r) => keepsRow(table, r, { keptFileIds }))
      .map((r) => projectRow(table, r));
  }
  return out;
}

// --- The positive check before upload (plan §4.1 step 5) ------------------
export class CloudKeyError extends Error {
  constructor(table, key, rowId) {
    super(`Cloud snapshot refused: "${table}" row ${rowId ?? '?'} carries unexpected key "${key}".`);
    this.name = 'CloudKeyError';
    this.table = table;
    this.key = key;
    this.rowId = rowId;
  }
}

// Throws CloudKeyError on the first key a snapshot row may not carry, including
// inside a nested-filtered object (events.details, waitlist_entries.application).
// An unknown table throws too.
export function assertCloudRow(table, row) {
  if (!SYNC_REGISTRY[table]) throw new CloudKeyError(table, '(table)', row && row.id);
  const allowed = allowedSnapshotKeys(table);
  for (const key of Object.keys(row)) {
    if (!allowed.has(key)) throw new CloudKeyError(table, key, row.id);
    const nested = nestedCloudKeys(table, key, row);
    if (!nested || row[key] == null) continue;
    if (!isPlainObject(row[key])) throw new CloudKeyError(table, key, row.id);
    for (const k of Object.keys(row[key])) {
      if (!nested.has(k)) throw new CloudKeyError(table, `${key}.${k}`, row.id);
    }
  }
}

export function assertCloudCollections(collections) {
  for (const [table, rows] of Object.entries(collections)) {
    for (const row of rows) assertCloudRow(table, row);
  }
}

// --- Restore: overlaying a snapshot row onto a local one (plan §4.3) -------
// The 'cloud-merge' restore mode. Returns a NEW row: the local row with every
// implicit + cloud field taken from `snapRow`, and every other (private) field
// left exactly as it is locally. A cloud field the snapshot row doesn't carry
// is REMOVED from the result, since the snapshot says it was absent at the
// source. Nested-filtered objects (events.details, waitlist_entries.
// application) merge by key: the snapshot's cloud keys, plus the local row's
// private keys, so a restore never blanks a treatment note or an applicant's
// answers that only this device has. Derived keys (files' sha256) are never
// written to a local row.
export function overlayCloudFields(table, localRow, snapRow) {
  const entry = entryFor(table);
  const out = { ...localRow };
  for (const field of [...IMPLICIT_CLOUD_FIELDS, ...entry.cloud]) {
    if (Object.prototype.hasOwnProperty.call(snapRow, field)) out[field] = snapRow[field];
    else delete out[field];
  }
  for (const field of entry.cloud) {
    const cloudKeys = nestedCloudKeys(table, field, out);
    if (!cloudKeys) continue;
    const localObj = isPlainObject(localRow[field]) ? localRow[field] : null;
    const snapObj = isPlainObject(snapRow[field]) ? snapRow[field] : null;
    if (!localObj && !snapObj) continue;
    const merged = {};
    if (localObj) for (const [k, v] of Object.entries(localObj)) if (!cloudKeys.has(k)) merged[k] = v;
    if (snapObj) for (const [k, v] of Object.entries(snapObj)) if (cloudKeys.has(k)) merged[k] = v;
    out[field] = merged;
  }
  return out;
}

// A snapshot row as a NEW local row (the "missing local row" case): the
// snapshot's own fields, minus any derived key. Private fields are simply absent.
export function snapshotRowToLocal(table, snapRow) {
  const entry = entryFor(table);
  const out = { ...snapRow };
  for (const key of entry.derived || []) delete out[key];
  return out;
}
