// vocab.js — controlled vocabularies (the enums from the data model) in one place,
// each value carrying a human label and a badge color class (assets/app.css).
// Dropdowns and badges both read from here so they never drift apart.

export const SEX = [
  { value: 'male',    label: 'Male',    badge: 'badge-blue' },
  { value: 'female',  label: 'Female',  badge: 'badge-purple' },
  { value: 'unknown', label: 'Unknown', badge: 'badge-gray' }
];

export const OWNERSHIP_TYPE = [
  { value: 'owned',      label: 'Owned',      badge: 'badge-green' },
  { value: 'co_owned',   label: 'Co-owned',   badge: 'badge-green' },
  { value: 'external',   label: 'External',   badge: 'badge-gray' },
  { value: 'leased_in',  label: 'Leased in',  badge: 'badge-amber' },
  { value: 'leased_out', label: 'Leased out', badge: 'badge-amber' }
];

export const DOG_STATUS = [
  { value: 'puppy',              label: 'Puppy',              badge: 'badge-blue' },
  { value: 'active_breeding',    label: 'Active breeding',    badge: 'badge-green' },
  { value: 'retired_breeding',   label: 'Retired breeding',   badge: 'badge-amber' },
  { value: 'pet_home',           label: 'Pet home',           badge: 'badge-neutral' },
  { value: 'for_sale',           label: 'For Sale',           badge: 'badge-amber' },
  { value: 'deceased',           label: 'Deceased',           badge: 'badge-gray' },
  { value: 'external_reference', label: 'External reference', badge: 'badge-gray' }
];

// Disposition — the breeder's intent for a dog, orthogonal to `status`
// (life-stage). Answers "keeping or selling?" for a puppy before any Sale record
// exists, so it can't be a `status` value (a puppy can't be both `puppy` and
// `for_sale`) and it isn't a Sale (that's an actual transaction with a buyer).
// Nullable/unset reads as "undecided". `available` is the single stable filter
// key a future prospective-families feed selects on. Plain unindexed field on
// Dog (same posture as recorded_coi) — nothing queries it by key.
export const DISPOSITION = [
  { value: 'undecided', label: 'Undecided', badge: 'badge-gray' },
  { value: 'keeping',   label: 'Keeping',   badge: 'badge-blue' },
  { value: 'available', label: 'Available', badge: 'badge-green' },
  { value: 'placed',    label: 'Placed',    badge: 'badge-neutral' }
];

// Foster direction — a per-litter fact (a litter fostered under a caretaker↔owner
// arrangement, not a permanent ownership fact of any dog, so the same dam can have
// more than one foster litter). Null/unset means an ordinary, non-foster litter.
//   foster_in  — an external dam's litter is whelped/raised in OUR care (we sell
//                the pups and pay the owner their income split).
//   foster_out — OUR dam's litter is raised elsewhere (the caretaker sells; we
//                receive our split).
// A foster puppy is distinguished from a plain "external" dog purely by DERIVATION
// (its litter's foster_direction) — it stays a normal status='puppy' Dog we manage
// and sell, never an external_reference. See guide §4.
export const FOSTER_DIRECTION = [
  { value: 'foster_in',  label: 'Foster in — external dam',      badge: 'badge-amber' },
  { value: 'foster_out', label: 'Foster out — raised elsewhere', badge: 'badge-amber' }
];

// How the foster partner is compensated. Two models (owner picks per litter):
//   income_split — a percentage of puppy income (`foster_our_share_pct` +
//                  `foster_split_basis`).
//   flat_per_pup — a fixed dollar amount per puppy (`foster_flat_fee_per_pup`).
// Both are DOCUMENTATION only — the actual money is a real `foster_split`
// ("Foster compensation") Expense either way (§25), so the P&L is model-agnostic.
export const FOSTER_COMP_MODEL = [
  { value: 'income_split', label: 'Income split (%)',   badge: 'badge-neutral' },
  { value: 'flat_per_pup', label: 'Flat fee per pup',   badge: 'badge-neutral' }
];

// Basis an income-split compensation is computed on (only meaningful when the
// comp model is `income_split`). Documentation only. Suggest-not-enforce.
export const FOSTER_SPLIT_BASIS = [
  { value: 'gross', label: 'Gross puppy income', badge: 'badge-neutral' },
  { value: 'net',   label: 'Net after expenses', badge: 'badge-neutral' }
];

// --- Pairing & Litter vocabularies (Data Model doc §5.3–5.4) ---------------
export const PAIRING_TYPE = [
  { value: 'planned', label: 'Planned', badge: 'badge-blue' },
  { value: 'actual',  label: 'Actual',  badge: 'badge-green' }
];

export const PAIRING_METHOD = [
  { value: 'natural',     label: 'Natural',        badge: 'badge-neutral' },
  { value: 'ai_fresh',    label: 'AI — fresh',     badge: 'badge-neutral' },
  { value: 'ai_chilled',  label: 'AI — chilled',   badge: 'badge-neutral' },
  { value: 'ai_frozen',   label: 'AI — frozen',    badge: 'badge-neutral' },
  { value: 'surgical_ai', label: 'Surgical AI',    badge: 'badge-neutral' }
];

export const PAIRING_STATUS = [
  { value: 'planned',            label: 'Planned',            badge: 'badge-blue' },
  { value: 'bred',               label: 'Bred',               badge: 'badge-purple' },
  { value: 'confirmed_pregnant', label: 'Confirmed pregnant', badge: 'badge-green' },
  { value: 'not_pregnant',       label: 'Not pregnant',       badge: 'badge-amber' },
  { value: 'whelped',            label: 'Whelped',            badge: 'badge-green' },
  { value: 'failed',             label: 'Failed',             badge: 'badge-red' },
  { value: 'cancelled',          label: 'Cancelled',          badge: 'badge-gray' }
];

export const LITTER_STATUS = [
  { value: 'expected', label: 'Expected', badge: 'badge-blue' },
  { value: 'whelped',  label: 'Whelped',  badge: 'badge-green' },
  { value: 'weaning',  label: 'Weaning',  badge: 'badge-amber' },
  { value: 'ready',    label: 'Ready',    badge: 'badge-green' },
  { value: 'sold',     label: 'Sold',     badge: 'badge-neutral' },
  { value: 'closed',   label: 'Closed',   badge: 'badge-gray' }
];

export const CONTACT_TYPE = [
  { value: 'breeder',        label: 'Breeder',        badge: 'badge-green' },
  { value: 'vet',            label: 'Vet',            badge: 'badge-blue' },
  { value: 'groomer',        label: 'Groomer',        badge: 'badge-purple' },
  { value: 'buyer_referrer', label: 'Buyer referrer', badge: 'badge-amber' },
  { value: 'stud_referrer',  label: 'Stud referrer',  badge: 'badge-amber' },
  { value: 'co_owner',       label: 'Co-owner',       badge: 'badge-neutral' },
  { value: 'buyer',          label: 'Buyer',          badge: 'badge-blue' },
  { value: 'other',          label: 'Other',          badge: 'badge-gray' }
];

// --- Buyer-view / Sale / Contract / StudService vocabularies (Stage 4,
// Data Model v3 §5.6–5.9, Stage4 Revision v2) --------------------------------
// waitlist_status lives on Contact (Buyer merged into Contact, v3 §5.5) — it
// powers the Buyer-view filter on the Contact List screen.
export const WAITLIST_STATUS = [
  { value: 'none',      label: 'None',      badge: 'badge-gray' },
  { value: 'active',    label: 'Active',    badge: 'badge-blue' },
  { value: 'fulfilled', label: 'Fulfilled', badge: 'badge-green' }
];

export const PLACEMENT_TYPE = [
  { value: 'pet',            label: 'Pet',            badge: 'badge-neutral' },
  { value: 'show',           label: 'Show',           badge: 'badge-purple' },
  { value: 'breeding_rights', label: 'Breeding rights', badge: 'badge-green' },
  { value: 'co_own',         label: 'Co-own',         badge: 'badge-blue' }
];

export const SALE_STATUS = [
  { value: 'deposit_pending', label: 'Deposit Pending', badge: 'badge-blue' },
  { value: 'deposit_paid',  label: 'Deposit paid',  badge: 'badge-amber' },
  { value: 'paid_in_full',  label: 'Paid in full',  badge: 'badge-green' },
  { value: 'delivered',     label: 'Delivered',     badge: 'badge-green' },
  { value: 'returned',      label: 'Returned',      badge: 'badge-red' },
  { value: 'cancelled',     label: 'Cancelled',     badge: 'badge-gray' }
];

export const CONTRACT_TYPE = [
  { value: 'sale',         label: 'Sale',         badge: 'badge-blue' },
  { value: 'stud_service', label: 'Stud service', badge: 'badge-purple' },
  { value: 'co_own',       label: 'Co-own',       badge: 'badge-green' },
  { value: 'lease',        label: 'Lease',        badge: 'badge-amber' },
  { value: 'foster',       label: 'Foster',       badge: 'badge-amber' },
  { value: 'other',        label: 'Other',        badge: 'badge-gray' }
];

// Not a locked state machine (Stage4 Revision v2 §7) — moves any direction, no
// confirmation dialogs. Default on create is 'draft'.
export const CONTRACT_STATUS = [
  { value: 'draft',     label: 'Draft',     badge: 'badge-gray' },
  { value: 'sent',      label: 'Sent',      badge: 'badge-blue' },
  { value: 'signed',    label: 'Signed',    badge: 'badge-green' },
  { value: 'declined',  label: 'Declined',  badge: 'badge-red' },
  { value: 'cancelled', label: 'Cancelled', badge: 'badge-red' },
  { value: 'void',      label: 'Void',      badge: 'badge-gray' }
];

export const STUD_SERVICE_DIRECTION = [
  { value: 'outgoing', label: 'Outgoing — our dog is the stud', badge: 'badge-blue' },
  { value: 'incoming', label: 'Incoming — our dog is the dam',  badge: 'badge-purple' }
];

export const FEE_STRUCTURE = [
  { value: 'flat_fee',       label: 'Flat fee',       badge: 'badge-neutral' },
  { value: 'pick_of_litter', label: 'Pick of litter', badge: 'badge-neutral' },
  { value: 'flat_plus_pick', label: 'Flat + pick',    badge: 'badge-neutral' },
  { value: 'other',          label: 'Other',          badge: 'badge-gray' }
];

export const STUD_SERVICE_STATUS = [
  { value: 'arranged', label: 'Arranged', badge: 'badge-blue' },
  { value: 'in_progress', label: 'In progress', badge: 'badge-amber' },
  { value: 'completed', label: 'Completed', badge: 'badge-green' },
  { value: 'failed',    label: 'Failed',    badge: 'badge-red' },
  { value: 'cancelled', label: 'Cancelled', badge: 'badge-gray' }
];

// Was this a physical stay or a shipment? Sibling to `direction`. The fine-
// grained method (natural / ai_chilled / …) already lives on the linked Pairing
// (pairing_id), so the stud record only needs the coarse in-person/AI split —
// enough to tell the away-board whether a dog physically travelled.
export const STUD_SERVICE_TYPE = [
  { value: 'in_person', label: 'In person', badge: 'badge-green' },
  { value: 'ai',        label: 'AI / shipped', badge: 'badge-neutral' }
];

// Look up the {value,label,badge} descriptor for a value in a vocab list.
export function descriptor(vocab, value) {
  return vocab.find((v) => v.value === value) || { value, label: value ?? '—', badge: 'badge-gray' };
}

// Suggest-not-enforce starter set for boarding's `boarding_reason` (Stage4.5
// Addendum §C3) — a plain string in `details`, never a validated vocab, so a
// combobox surfaces these as suggestions without blocking free text.
export const BOARDING_REASON_SUGGESTIONS = [
  'Stud service', 'Co-owner rotation', 'Foster', 'Grow-out', 'Owner travel', 'Whelp assist', 'Other'
];

// Suggest-not-enforce starter set for a recorded COI's `method` (Stage 5, Build
// Brief §1.5/§2.1) — Dog.recorded_coi.method is free text; a combobox surfaces
// these without forcing an enum. NOT a validated vocab and never a badge: the
// value describes how the breeder's lab/registry derived the number, not a state
// the app owns. No new event types come with it.
export const COI_METHOD_SUGGESTIONS = ['genomic', 'pedigree', 'registry', 'other'];

// Enforced choice list for the `placement` event type's `Method` field —
// how the puppy actually travelled to the buyer.
export const PLACEMENT_METHODS = ['Flight nanny', 'Ground transport', 'Local pickup', 'Other'];

// Payment methods for the invoice/receipt generator (§24). On an invoice these
// are the *accepted* methods offered to the buyer (a global default lives in
// settings.js, editable per document); on a receipt one is the method actually
// used. A suggest-not-enforce set — free text is allowed on the receipt's method
// field, same posture as the *_SUGGESTIONS lists above.
export const PAYMENT_METHODS = ['Cash', 'Check', 'Credit/debit card', 'Bank transfer', 'PayPal', 'Venmo', 'Zelle', 'Money order', 'Other'];

// Invoice/receipt line-item labels, keyed by income component (§24). Deliberately
// distinct from INCOME_COMPONENTS' Financials-view labels ("Deposits", "Balance"…)
// — a customer-facing document names the balance "Remaining Purchase Price", etc.
export const INVOICE_LINE_LABELS = {
  deposit: 'Deposit',
  balance: 'Remaining Purchase Price',
  transport: 'Transport Fee',
  boarding: 'Boarding Fee',
  stud_fee: 'Stud Fee'
};

// Enforced choice list for Sale's `deferred_boarding_frequency` field — the
// rate period the deferred pickup boarding amount is charged per.
export const BOARDING_FREQUENCY_OPTIONS = ['Day', 'Week', 'Month'];

// Enforced choice list for the `abnormalities` event type's `Type` field —
// common canine birth defects a breeder would record at whelping.
export const ABNORMALITY_TYPES = [
  'Cleft palate', 'Cleft lip', 'Umbilical hernia', 'Inguinal hernia',
  'Anasarca (walrus puppy)', 'Swimmer puppy syndrome', 'Hydrocephalus',
  'Heart murmur', 'Limb deformity', 'Atresia ani (imperforate anus)',
  'Open fontanelle', 'Cryptorchidism', 'Other'
];

// --- Event type catalog (Data Model doc §5.2; Stage4.5 Addendum §C3/D1) ----
// Each type carries a badge color and the type-specific `details` fields shown
// as a short form (Build Brief B1: one small form per event_type, not a generic
// key/value editor). `subjects` limits where a type can be logged; at Stage 2
// only `dog` subjects exist, so pairing/litter-only types are intentionally
// absent and get added with their tables in later stages.
//
// `duration` is 'instant' (a single dated occurrence) or 'span' (has a start —
// event_date — and an optional open end — event_end_date). Only `boarding`,
// `heat_cycle`, and `medication` are spans; everything else is instant. This is
// the field the Location/Status Board deliberately does NOT filter on (Stage4.5
// Addendum §C4/§C5) — whereabouts is a narrower set than "is a span."
//
// `relatedContact: true` means the type carries a top-level related_contact_id
// (the events.related_contact_id FK, Stage4.5 Addendum §C2) — the person/kennel
// on the other side of a boarding stay or a placement's buyer. It is NEVER a
// field inside `details` (details.location stays a plain string; only a real
// FK belongs at the top level).
//
// Field `type` is one of: text | textarea | date | number (optional `step`) |
// combobox (a free-text input with suggestions — suggest-not-enforce, never a
// validated enum) | select (enforced choice from `options[]`).
export const EVENT_TYPES = [
  // Acquisition — an option for the first event on a newly-bought dog's
  // timeline, never auto-created. `source` is a plain free-text field (the
  // seller needn't already be a Contact record). The purchase price itself
  // goes through the event form's existing Cost field, category "New dog
  // purchase" (EXPENSE_CATEGORIES) — Sales/StudService stay income-only, so
  // dog acquisitions are tracked purely as an expense, never a Sale.
  { value: 'acquisition',        label: 'Acquisition',        badge: 'badge-green',   subjects: ['dog'], duration: 'instant',
    fields: [{ key: 'source', label: 'Source / seller', type: 'text' }] },
  { value: 'vaccination',        label: 'Vaccination',        badge: 'badge-blue',    subjects: ['dog'], duration: 'instant',
    fields: [{ key: 'vaccine', label: 'Vaccine', type: 'text' }, { key: 'lot_number', label: 'Lot #', type: 'text' }, { key: 'next_due', label: 'Next due', type: 'date' }] },
  { value: 'preventative',       label: 'Preventative',       badge: 'badge-blue',    subjects: ['dog'], duration: 'instant',
    fields: [{ key: 'product', label: 'Product', type: 'text' }, { key: 'dose', label: 'Dose', type: 'text' }] },
  // panel_name/test_name/joint are `combobox` fields sourced at render time from
  // the shared test vocabulary (Test Planning Addendum §3: Kennel.preferred_tests
  // union distinct tokens already seen in events) — see eventForm.js's
  // TEST_VOCAB_FIELDS. Suggest-not-enforce, same as boarding_reason below.
  { value: 'genetic_test',       label: 'Genetic test',       badge: 'badge-purple',  subjects: ['dog'], duration: 'instant',
    fields: [{ key: 'panel_name', label: 'Panel', type: 'combobox' }, { key: 'lab', label: 'Lab', type: 'text' }, { key: 'result', label: 'Result', type: 'text' }] },
  { value: 'ofa_pennhip',        label: 'OFA / PennHIP',      badge: 'badge-purple',  subjects: ['dog'], duration: 'instant',
    fields: [{ key: 'joint', label: 'Joint', type: 'combobox' }, { key: 'method', label: 'Method', type: 'text' }, { key: 'rating', label: 'Rating', type: 'text' }] },
  { value: 'breed_specific_test', label: 'Breed-specific test', badge: 'badge-purple', subjects: ['dog'], duration: 'instant',
    fields: [{ key: 'test_name', label: 'Test', type: 'combobox' }, { key: 'result', label: 'Result', type: 'text' }] },
  { value: 'illness',            label: 'Illness',            badge: 'badge-red',     subjects: ['dog'], duration: 'instant',
    fields: [{ key: 'diagnosis', label: 'Diagnosis', type: 'text' }, { key: 'treatment', label: 'Treatment', type: 'textarea' }] },
  // Span (Stage4.5 Addendum §C5): event_date is the start, event_end_date the
  // end (retired out of details.end_date — there's no shipped data to migrate).
  { value: 'medication',         label: 'Medication',         badge: 'badge-blue',    subjects: ['dog'], duration: 'span',
    fields: [{ key: 'drug', label: 'Drug', type: 'text' }, { key: 'dose', label: 'Dose', type: 'text' }, { key: 'frequency', label: 'Frequency', type: 'text' }] },
  { value: 'surgery',            label: 'Surgery',            badge: 'badge-red',     subjects: ['dog'], duration: 'instant',
    fields: [{ key: 'procedure', label: 'Procedure', type: 'text' }, { key: 'vet', label: 'Vet', type: 'text' }, { key: 'outcome', label: 'Outcome', type: 'textarea' }] },
  { value: 'vet_visit',          label: 'Vet visit',          badge: 'badge-blue',    subjects: ['dog'], duration: 'instant',
    fields: [{ key: 'reason', label: 'Reason', type: 'text' }, { key: 'vet', label: 'Vet', type: 'text' }, { key: 'findings', label: 'Findings', type: 'textarea' }] },
  { value: 'injury',             label: 'Injury',             badge: 'badge-red',     subjects: ['dog'], duration: 'instant',
    fields: [{ key: 'description', label: 'Description', type: 'textarea' }, { key: 'severity', label: 'Severity', type: 'text' }] },
  { value: 'abnormalities',      label: 'Abnormalities',      badge: 'badge-red',     subjects: ['dog'], duration: 'instant',
    fields: [{ key: 'type', label: 'Type', type: 'select', options: ABNORMALITY_TYPES }] },
  { value: 'weight_check',       label: 'Weight check',       badge: 'badge-neutral', subjects: ['dog'], duration: 'instant',
    fields: [
      { key: 'weight_lbs', label: 'Weight (lbs)', type: 'number' },
      { key: 'weight_oz', label: 'Weight (oz)', type: 'number', step: '0.1' },
      { key: 'time_of_day', label: 'AM/PM', type: 'select', options: ['AM', 'PM'] }
    ] },
  { value: 'milestone',          label: 'Milestone',          badge: 'badge-green',   subjects: ['dog'], duration: 'instant',
    fields: [{ key: 'description', label: 'Description', type: 'text' }] },
  { value: 'title_earned',       label: 'Title earned',       badge: 'badge-green',   subjects: ['dog'], duration: 'instant',
    fields: [{ key: 'title_abbreviation', label: 'Title', type: 'text' }, { key: 'organization', label: 'Organization', type: 'text' }] },
  // Span (Stage4.5 Addendum §C5): event_date is the cycle start (retired out of
  // details.cycle_start), event_end_date the (optional) end.
  { value: 'heat_cycle',         label: 'Heat cycle',         badge: 'badge-amber',   subjects: ['dog'], duration: 'span',
    fields: [{ key: 'notes', label: 'Notes', type: 'textarea' }] },
  { value: 'evaluation',         label: 'Evaluation',         badge: 'badge-neutral', subjects: ['dog'], duration: 'instant',
    fields: [{ key: 'evaluator', label: 'Evaluator', type: 'text' }, { key: 'temperament_notes', label: 'Temperament notes', type: 'textarea' }, { key: 'structure_notes', label: 'Structure notes', type: 'textarea' }] },
  // Boarding (Stage4.5 Addendum §C3) — a span with a top-level related_contact_id
  // (the person/kennel the dog is staying with). `location` and `boarding_reason`
  // stay plain strings in `details`; boarding_reason is suggest-not-enforce, never
  // a validated vocab. dropoff_time/pickup_time are inert display strings — never
  // parsed or compared.
  { value: 'boarding',           label: 'Boarding',           badge: 'badge-amber',   subjects: ['dog'], duration: 'span', relatedContact: true,
    fields: [
      { key: 'location', label: 'Location', type: 'text' },
      { key: 'boarding_reason', label: 'Reason', type: 'combobox', options: BOARDING_REASON_SUGGESTIONS },
      { key: 'dropoff_time', label: 'Drop-off time', type: 'text' },
      { key: 'pickup_time', label: 'Pick-up time', type: 'text' },
      { key: 'notes', label: 'Notes', type: 'textarea' }
    ] },
  // Pairing-subject types (Stage 3) — the pairing's timeline is built from these.
  { value: 'breeding_tie',       label: 'Breeding tie',       badge: 'badge-purple',  subjects: ['pairing'], duration: 'instant',
    fields: [{ key: 'tie_date', label: 'Tie date', type: 'date' }, { key: 'method', label: 'Method', type: 'text' }] },
  { value: 'progesterone_test',  label: 'Progesterone test',  badge: 'badge-blue',    subjects: ['pairing'], duration: 'instant',
    fields: [{ key: 'value', label: 'Value (ng/mL)', type: 'number' }, { key: 'lab', label: 'Lab', type: 'text' }] },
  { value: 'ultrasound',         label: 'Ultrasound',         badge: 'badge-blue',    subjects: ['pairing'], duration: 'instant',
    fields: [{ key: 'confirmed', label: 'Confirmed?', type: 'text' }, { key: 'estimated_count', label: 'Estimated count', type: 'number' }] },
  { value: 'pregnancy_update',   label: 'Pregnancy update',   badge: 'badge-green',   subjects: ['pairing'], duration: 'instant',
    fields: [{ key: 'note', label: 'Note', type: 'textarea' }] },
  // Litter-subject type (Stage 3).
  { value: 'whelping_summary',   label: 'Whelping summary',   badge: 'badge-green',   subjects: ['litter'], duration: 'instant',
    fields: [{ key: 'total_born', label: 'Total born', type: 'number' }, { key: 'live_born', label: 'Live born', type: 'number' }, { key: 'notes', label: 'Notes', type: 'textarea' }] },
  // Placement / drop-off (Stage4.5 Addendum §D1) — an instant event; subject_id
  // is the puppy, related_contact_id is the buyer. No stored link to the Sale
  // (prompted at the Sale, never tied to it — see saleRepo/sale.js prompt).
  // placement_time is an inert display string, same posture as boarding's times.
  { value: 'placement',          label: 'Placement / drop-off', badge: 'badge-green', subjects: ['dog'], duration: 'instant', relatedContact: true,
    fields: [
      { key: 'dropoff_method', label: 'Method', type: 'select', options: PLACEMENT_METHODS },
      { key: 'placement_time', label: 'Drop-off time', type: 'text' },
      { key: 'location', label: 'Location', type: 'text' },
      { key: 'notes', label: 'Notes', type: 'textarea' }
    ] },
  { value: 'note',               label: 'Note',               badge: 'badge-gray',    subjects: ['dog', 'pairing', 'litter'], duration: 'instant',
    fields: [] }
];

// Event types loggable against a given subject_type.
export function eventTypesFor(subjectType) {
  return EVENT_TYPES.filter((t) => t.subjects.includes(subjectType));
}

// The KennelAssistant allow-list (§26): the event types the helper app can SEE
// (assistantSync's feed builder) and LOG (assistant.js's form) — one list so
// the two can never drift. Lives here (not in either sync module) because both
// sides import vocab and neither should import the other's database module.
// Widen/narrow by editing this list.
export const ASSISTANT_EVENT_TYPES = ['weight_check', 'milestone', 'note', 'preventative', 'medication'];

// --- Financials (the Expense ledger) --------------------------------------
// The controlled category vocabulary for an Expense. Same shape as every other
// vocab here (value/label/badge) so dropdowns and badges read from one place.
export const EXPENSE_CATEGORIES = [
  { value: 'food',         label: 'Food & nutrition',   badge: 'badge-green' },
  { value: 'veterinary',   label: 'Veterinary',         badge: 'badge-blue' },
  { value: 'testing',      label: 'Health testing',     badge: 'badge-purple' },
  { value: 'registration', label: 'Registration',       badge: 'badge-neutral' },
  { value: 'supplies',     label: 'Supplies',           badge: 'badge-amber' },
  { value: 'facility',     label: 'Facility',           badge: 'badge-amber' },
  { value: 'boarding',     label: 'Boarding & travel',  badge: 'badge-amber' },
  { value: 'mileage',      label: 'Mileage / travel',   badge: 'badge-amber' },
  { value: 'stud_fee',     label: 'Stud fee',           badge: 'badge-purple' },
  { value: 'foster_split', label: 'Foster compensation',  badge: 'badge-purple' },
  { value: 'dog_purchase', label: 'New dog purchase',   badge: 'badge-red' },
  { value: 'marketing',    label: 'Marketing',          badge: 'badge-blue' },
  { value: 'insurance',    label: 'Insurance',          badge: 'badge-neutral' },
  { value: 'other',        label: 'Other',              badge: 'badge-gray' }
];

// What an Expense can attach to. Polymorphic like the Event, but its own list:
// events are dog/pairing/litter history; expenses add `kennel` so kennel-wide
// overhead has a home. There is no `general` subject — program-wide overhead is
// logged against your own kennel (single canonical home, no null subject_id).
export const EXPENSE_SUBJECT_TYPES = [
  { value: 'dog',     label: 'Dog' },
  { value: 'litter',  label: 'Litter' },
  { value: 'pairing', label: 'Pairing' },
  { value: 'kennel',  label: 'Kennel' }
];

// --- Documents (dog-scoped filed files: pedigree/health test/registration/
// contract/other) ------------------------------------------------------------
export const DOC_TYPES = [
  { value: 'pedigree',     label: 'Pedigree',     badge: 'badge-green' },
  { value: 'health_test',  label: 'Health test',  badge: 'badge-blue' },
  { value: 'registration', label: 'Registration', badge: 'badge-neutral' },
  { value: 'contract',     label: 'Contract',     badge: 'badge-purple' },
  { value: 'other',        label: 'Other',        badge: 'badge-gray' }
];

// Which optional fields (beyond title/doc_date/notes, which every type shows)
// appear on the add/edit form for a given doc_type.
const DOC_FIELDS_BY_TYPE = {
  pedigree:     ['issuer_or_lab', 'registry', 'registration_number'],
  health_test:  ['issuer_or_lab', 'result'],
  registration: ['issuer_or_lab', 'registry', 'registration_number'],
  contract:     ['issuer_or_lab'],
  other:        ['issuer_or_lab']
};

export function documentFieldsFor(docType) {
  return DOC_FIELDS_BY_TYPE[docType] || DOC_FIELDS_BY_TYPE.other;
}

// A small emoji icon per type, for the list when a document has no photo
// thumbnail (uploaded PDFs).
const DOC_TYPE_ICON = {
  pedigree: '🌳',
  health_test: '🩺',
  registration: '📜',
  contract: '✍️',
  other: '📄'
};
export function docTypeIcon(value) {
  return DOC_TYPE_ICON[value] || '📄';
}

// Suggested default category when a cost is captured from an event, keyed by
// event_type. Only a starting point — the event form's category dropdown lets
// the user override before saving. Anything unmapped defaults to 'other'.
//
// `veterinary` is reserved for genuine clinical vet care (a dog seen, treated,
// operated on, or scanned by a vet), NOT used as a lazy catch-all for anything
// health-adjacent. Events that are stockable products a breeder self-administers
// (preventative, medication) or a plain observation with no inherent cost
// (abnormalities) fall through to 'other' rather than mislabel spend as vet care.
// Diagnostic panels (genetic/OFA/breed/progesterone) map to `testing`.
const EVENT_TYPE_EXPENSE_CATEGORY = {
  acquisition: 'dog_purchase',
  vaccination: 'veterinary', illness: 'veterinary', surgery: 'veterinary',
  vet_visit: 'veterinary', injury: 'veterinary', ultrasound: 'veterinary',
  genetic_test: 'testing', ofa_pennhip: 'testing', breed_specific_test: 'testing',
  progesterone_test: 'testing',
  boarding: 'boarding'
};

export function defaultExpenseCategoryFor(eventType) {
  return EVENT_TYPE_EXPENSE_CATEGORY[eventType] || 'other';
}

// --- Financials (the Income view) -----------------------------------------
// Income is DERIVED, never stored: data/incomeView.js reads Sale + outgoing
// StudService and classifies each money component as earned or anticipated —
// there is no income table and no `is_earned` field (see §21). These three
// vocabs give the Income view its badges and its per-component breakdown, in the
// same value/label/badge shape every other vocab uses, so dropdowns/badges/
// breakdown all read from one place and never drift.

// The state a cash income component is in. `earned` = money already in hand
// (a paid deposit, a completed stud fee); `anticipated` = expected but not yet
// received (an unpaid balance on an open sale). Money that will never arrive —
// the unpaid remainder of a returned/cancelled sale, a failed stud fee — is
// simply dropped from both, not carried as a third state (owner decision, §21).
export const INCOME_STATES = [
  { value: 'earned',      label: 'Earned',      badge: 'badge-green' },
  { value: 'anticipated', label: 'Anticipated', badge: 'badge-amber' }
];

// Where an income row comes from — a Sale placement or an outgoing StudService
// (incoming stud is money WE pay, so it is an expense, never income).
export const INCOME_SOURCE_TYPES = [
  { value: 'sale', label: 'Sale',         badge: 'badge-blue' },
  { value: 'stud', label: 'Stud service', badge: 'badge-purple' }
];

// The money components a row breaks into, for the Income summary's per-component
// breakdown (mirrors the Expenses summary's per-category one). `pick` is a
// NON-CASH estimate (StudService.pick_value_amount) — surfaced on its own line
// but kept out of the earned/anticipated cash totals and the Net figure (owner
// decision, §21).
export const INCOME_COMPONENTS = [
  { value: 'deposit',   label: 'Deposits',          badge: 'badge-amber' },
  { value: 'balance',   label: 'Balance',           badge: 'badge-green' },
  { value: 'transport', label: 'Transport',         badge: 'badge-blue' },
  { value: 'boarding',  label: 'Deferred boarding',  badge: 'badge-amber' },
  { value: 'stud_fee',  label: 'Stud fees',         badge: 'badge-purple' },
  { value: 'pick',      label: 'Pick value (est.)', badge: 'badge-neutral' }
];
