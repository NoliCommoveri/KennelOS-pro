// puppyRecordFields.js — which fields the printed Puppy Record (pages/puppy-record.js,
// guide §23) shows, picked per kennel on the Kennel page's "Puppy Record fields"
// card. Stored on the kennel as `Kennel.puppy_record_fields`, a plain object of
// only the fields turned OFF ({ [key]: false }); a missing key (or a null field)
// means shown, so a kennel that never opened the card prints everything, and a
// field added here later starts out shown. Kept on the kennel, not in settings.js,
// so it rides the JSON backup like the rest of the kennel's program config.
//
// Each group with a `key` has its own on/off (the whole section); a field shows
// only when its group is on AND the field itself is on.
import { EVENT_TYPES, descriptor } from './vocab.js';

// The Health History event types, in the order the record prints their cards.
// Admin/lifecycle types (milestone, placement, note…) are never printed.
export const PUPPY_RECORD_HEALTH_TYPES = [
  'vaccination', 'preventative', 'genetic_test', 'ofa_pennhip',
  'breed_specific_test', 'illness', 'medication', 'surgery', 'vet_visit',
  'injury', 'abnormalities', 'weight_check'
];

export const PUPPY_RECORD_FIELD_GROUPS = [
  { key: null, label: 'Header', fields: [
    { key: 'logo', label: 'Kennel logo' },
    { key: 'generatedDate', label: 'Generated date' }
  ] },
  { key: 'puppy', label: 'Puppy Information', fields: [
    { key: 'callName', label: 'Call name' },
    { key: 'registeredName', label: 'Registered name' },
    { key: 'sex', label: 'Sex' },
    { key: 'dateOfBirth', label: 'Date of birth' },
    { key: 'breed', label: 'Breed' },
    { key: 'colorMarkings', label: 'Color / markings' },
    { key: 'microchip', label: 'Microchip ID' },
    { key: 'registry', label: 'Registry' },
    { key: 'registrationNumber', label: 'Registration #' },
    { key: 'litterRegistration', label: 'Litter registration #' }
  ] },
  { key: 'parents', label: 'Parents', fields: [
    { key: 'parentRegisteredName', label: 'Registered name' },
    { key: 'parentCallName', label: 'Call name' },
    { key: 'parentBreed', label: 'Breed' },
    { key: 'parentRegistrationNumber', label: 'Registration #' },
    { key: 'parentTests', label: 'Genetic & breed test results' }
  ] },
  { key: 'health', label: 'Health History', fields: [
    ...PUPPY_RECORD_HEALTH_TYPES.map((type) => ({ key: healthKey(type), label: descriptor(EVENT_TYPES, type).label })),
    { key: 'healthNotes', label: 'Notes on each entry' }
  ] },
  { key: 'buyer', label: 'Buyer', fields: [
    { key: 'buyerName', label: 'Name' },
    { key: 'buyerPhone', label: 'Phone' },
    { key: 'buyerEmail', label: 'Email' },
    { key: 'buyerAddress', label: 'Address' }
  ] }
];

// The key for one Health History type's card.
export function healthKey(type) {
  return `health_${type}`;
}

// Every storable key: the groups' own on/offs, then each field.
export const PUPPY_RECORD_FIELD_KEYS = PUPPY_RECORD_FIELD_GROUPS.flatMap((g) =>
  [...(g.key ? [g.key] : []), ...g.fields.map((f) => f.key)]);

const GROUP_OF = new Map(PUPPY_RECORD_FIELD_GROUPS.flatMap((g) => g.fields.map((f) => [f.key, g.key])));

// A `shows(key)` reader for this kennel. A group key answers for the section; a
// field key answers for the field and is off whenever its group is.
export function puppyRecordShows(kennel) {
  const stored = (kennel && kennel.puppy_record_fields) || {};
  const on = (key) => stored[key] !== false;
  return (key) => {
    const group = GROUP_OF.get(key);
    return on(key) && (!group || on(group));
  };
}

// The object to store from a { key: bool } map (e.g. the card's checkboxes): only
// the keys that are off, or null when everything is on.
export function puppyRecordFieldsValue(checked) {
  const off = {};
  for (const key of PUPPY_RECORD_FIELD_KEYS) if (checked[key] === false) off[key] = false;
  return Object.keys(off).length ? off : null;
}
