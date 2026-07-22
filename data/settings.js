// settings.js — tiny localStorage-backed settings store. This is the small,
// synchronous "UI prefs / last backup date" use case that localStorage is
// genuinely right for (Build Brief A3) — records live in IndexedDB, not here.

const KEYS = {
  lastBackupDate: 'kennelOS.lastBackupDate',
  persistRequested: 'kennelOS.persistRequested',
  sampleDataManifest: 'kennelOS.sampleDataManifest',
  sampleDataCleared: 'kennelOS.sampleDataCleared',
  myKennelId: 'kennelOS.myKennelId',
  myContactId: 'kennelOS.myContactId',
  myKennelSetupSkipped: 'kennelOS.myKennelSetupSkipped',
  companion: 'kennelOS.companion',
  invoiceDefaults: 'kennelOS.invoiceDefaults',
  mileageDefaults: 'kennelOS.mileageDefaults',
  expensesMigrated: 'kennelOS.expensesMigrated',
  wizardStatus: 'kennelOS.wizardStatus',
  wizardStepIndex: 'kennelOS.wizardStepIndex',
  dropbox: 'kennelOS.dropbox',
  assistantLastSync: 'kennelOS.assistantLastSync'
};

export function getLastBackupDate() {
  return localStorage.getItem(KEYS.lastBackupDate); // ISO string or null
}

export function setLastBackupDate(iso = new Date().toISOString()) {
  localStorage.setItem(KEYS.lastBackupDate, iso);
  return iso;
}

export function wasPersistRequested() {
  return localStorage.getItem(KEYS.persistRequested) === '1';
}

export function markPersistRequested() {
  localStorage.setItem(KEYS.persistRequested, '1');
}

// Sample-data manifest — the record of which IDs were created by the demo
// seed, so they can be found again for a clean bulk delete (see sampleData.js).
export function getSampleDataManifest() {
  const raw = localStorage.getItem(KEYS.sampleDataManifest);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setSampleDataManifest(manifest) {
  localStorage.setItem(KEYS.sampleDataManifest, JSON.stringify(manifest));
}

export function removeSampleDataManifest() {
  localStorage.removeItem(KEYS.sampleDataManifest);
}

export function wasSampleDataCleared() {
  return localStorage.getItem(KEYS.sampleDataCleared) === '1';
}

export function markSampleDataCleared() {
  localStorage.setItem(KEYS.sampleDataCleared, '1');
}

// "My kennel" identity — the real Kennel/Contact created by the kennel-setup
// wizard (see kennelSetup.js). Stored as ids, not copied strings, so renaming
// either record later (e.g. from the Kennels page) stays the single source of
// truth; settings just remembers which records they are.
export function getMyKennelId() {
  return localStorage.getItem(KEYS.myKennelId);
}

export function setMyKennelId(id) {
  localStorage.setItem(KEYS.myKennelId, id);
}

export function getMyContactId() {
  return localStorage.getItem(KEYS.myContactId);
}

export function setMyContactId(id) {
  localStorage.setItem(KEYS.myContactId, id);
}

export function wasMyKennelSetupSkipped() {
  return localStorage.getItem(KEYS.myKennelSetupSkipped) === '1';
}

export function markMyKennelSetupSkipped() {
  localStorage.setItem(KEYS.myKennelSetupSkipped, '1');
}

// --- Companion messaging (per recipient type) ------------------------------
// The Companion feature's Layer-1 config: kennel identity + intro/announcement
// copy, one set per bundle type, edited in the Companion Messaging console and
// copied into every built bundle so header/landing text updates without touching
// the shell. App-level UI config, so it lives here (localStorage), never in
// IndexedDB — consistent with "nothing app-level goes in IndexedDB." The Layer-2
// per-recipient personal message is Contact.companion_note (a real record field),
// shown ALONGSIDE the broadcast announcement (not an override).
export const COMPANION_TYPES = ['prospective', 'family', 'partner'];

const COMPANION_TYPE_LABELS = {
  prospective: 'Prospective families',
  family: 'Current families',
  partner: 'Partners'
};

// `include` is the Layer-1 component allow-list per bundle type: a flat map of
// boolean flags, ALL default true (current behaviour = everything shown). Each
// flag lets the owner drop a component from the recipient's page; the builder
// only ever SUBTRACTS from what it emits, so this can never widen the bundle.
// Master flags gate a group; a child flag is only honoured when its master is
// on (the builder ANDs them). New flags added here default true, so an upgrade
// never silently hides a component from an existing saved config.
const COMPANION_INCLUDE_DEFAULTS = {
  prospective: {
    parents: true, parentRegisteredName: true, parentCallName: true, parentPhotos: true, parentTests: true,
    pricing: true, pricingPrice: true, pricingDeposit: true,
    litterDates: true, markings: true,
    // Reveal the owner/breeder kennel on FOSTER-IN litters only (the field is
    // emitted empty for a non-foster or foster-out litter regardless of this flag —
    // on foster-out we are the breeder). Defaults on, per the "all include flags
    // default true" invariant; turn it off to keep a foster dam's owner kennel
    // private on a prospective share.
    fosterOwnerKennel: true
  },
  family: {
    age: true, parentage: true, photos: true, readyPlacement: true, financials: true,
    histVaccination: true, histPreventative: true, histWeight: true, histMilestone: true, histNote: true,
    histBoarding: true, contract: true,
    // Same as prospective: only populated for a puppy from a foster litter.
    fosterOwnerKennel: true
  },
  partner: {
    studServices: true, studRegisteredName: true, studCallName: true, studPhotos: true, studTests: true,
    studAgreement: true, studContract: true,
    contracts: true
  }
};

const COMPANION_DEFAULTS = {
  prospective: {
    kennelName: '', tagline: '', announcement: '', closer: '',
    introText: 'A peek at the puppies we have available right now. This is a snapshot as of the last link I sent — I’ll send a fresh link when things change. There’s no live sync.',
    include: COMPANION_INCLUDE_DEFAULTS.prospective
  },
  family: {
    kennelName: '', tagline: '', announcement: '', closer: '',
    introText: 'This shows your puppy’s info as of the last link I sent. I’ll send a new link whenever anything changes — there’s no live sync.',
    include: COMPANION_INCLUDE_DEFAULTS.family
  },
  partner: {
    kennelName: '', tagline: '', announcement: '', closer: '',
    introText: 'A summary of our arrangement as of the last link I sent. I’ll send a new link when anything changes — there’s no live sync.',
    include: COMPANION_INCLUDE_DEFAULTS.partner
  }
};

// The full ordered list of include flags per type (masters + children), used by
// the console to render checkboxes and by callers that need every key.
export function companionIncludeKeys(type) {
  return Object.keys(COMPANION_INCLUDE_DEFAULTS[type] || {});
}

export function companionTypeLabel(type) {
  return COMPANION_TYPE_LABELS[type] || type;
}

function readCompanionStore() {
  const raw = localStorage.getItem(KEYS.companion);
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

// Merged with defaults so a caller always gets every field, even before the
// owner has saved anything.
export function getCompanionSettings(type) {
  const defaults = COMPANION_DEFAULTS[type] || {};
  const stored = readCompanionStore()[type] || {};
  // `include` is deep-merged over defaults so a flag the owner never set (or one
  // added in a later version) falls back to its default (on) instead of undefined.
  return {
    ...defaults,
    ...stored,
    include: { ...(defaults.include || {}), ...(stored.include || {}) }
  };
}

export function setCompanionSettings(type, values) {
  const store = readCompanionStore();
  const prev = store[type] || {};
  const merged = { ...prev, ...values };
  // Deep-merge `include` so a partial write updates only the named flags and
  // never drops the rest (the console writes the full map, but this keeps any
  // caller honest).
  if (values.include) merged.include = { ...(prev.include || {}), ...values.include };
  store[type] = merged;
  localStorage.setItem(KEYS.companion, JSON.stringify(store));
  return getCompanionSettings(type);
}

// --- Invoice / receipt defaults (§24) --------------------------------------
// Global config for the invoice generator: the default set of accepted payment
// methods offered on an invoice ("Payment may be made using one of the
// following methods:"). The generator modal prefills from this and can override
// per document, or save the current selection back here as the new default.
const INVOICE_DEFAULTS = {
  acceptedMethods: ['Cash', 'Check', 'Bank transfer', 'Venmo', 'Zelle']
};

export function getInvoiceDefaults() {
  const raw = localStorage.getItem(KEYS.invoiceDefaults);
  if (!raw) return { ...INVOICE_DEFAULTS };
  try { return { ...INVOICE_DEFAULTS, ...(JSON.parse(raw) || {}) }; } catch { return { ...INVOICE_DEFAULTS }; }
}

export function setInvoiceDefaults(values) {
  const merged = { ...getInvoiceDefaults(), ...values };
  localStorage.setItem(KEYS.invoiceDefaults, JSON.stringify(merged));
  return merged;
}

// --- Mileage defaults (§21) ------------------------------------------------
// The default reimbursement/deduction rate per mile the add-expense form's
// mileage mode prefills. Editable per entry, or saved back here as the new
// default. 0.70 is a sensible starting value (the 2025 US IRS standard mileage
// rate) — change it to whatever rate your jurisdiction/records use. Units are
// the app's native decimal dollars per mile.
const MILEAGE_DEFAULTS = {
  rate: 0.70
};

export function getMileageDefaults() {
  const raw = localStorage.getItem(KEYS.mileageDefaults);
  if (!raw) return { ...MILEAGE_DEFAULTS };
  try { return { ...MILEAGE_DEFAULTS, ...(JSON.parse(raw) || {}) }; } catch { return { ...MILEAGE_DEFAULTS }; }
}

export function setMileageDefaults(values) {
  const merged = { ...getMileageDefaults(), ...values };
  localStorage.setItem(KEYS.mileageDefaults, JSON.stringify(merged));
  return merged;
}

// Financials migration flag — set once the one-time Event.cost → Expense fold
// has run (expenseRepo.migrateEventCosts). Cleared by Reset App along with every
// other key, after which the migration re-runs harmlessly (no event has a cost).
export function getExpensesMigrated() {
  return localStorage.getItem(KEYS.expensesMigrated) === '1';
}

export function markExpensesMigrated() {
  localStorage.setItem(KEYS.expensesMigrated, '1');
}

// --- Guided tour (first-run wizard) -----------------------------------------
// Wizard Runtime Spec v1 §2.1. `wizardStatus` is absent → treated as 'unseen';
// `wizardStepIndex` is written on every advance/retreat regardless of status, so
// pausing mid-tour never loses the spot.
export function getWizardStatusRaw() {
  return localStorage.getItem(KEYS.wizardStatus); // null | 'unseen' | 'active' | 'dismissed' | 'completed'
}

export function setWizardStatusRaw(status) {
  localStorage.setItem(KEYS.wizardStatus, status);
}

export function getWizardStepIndexRaw() {
  const raw = localStorage.getItem(KEYS.wizardStepIndex);
  const n = raw == null ? 0 : parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

export function setWizardStepIndexRaw(index) {
  localStorage.setItem(KEYS.wizardStepIndex, String(index));
}

// --- Dropbox sync (data/dropbox.js) -----------------------------------------
// One JSON blob holding the OAuth tokens the PKCE flow produces (refresh
// token, cached short-lived access token, and the in-flight PKCE verifier
// during a redirect) — the app key itself is hardcoded in data/dropbox.js,
// not stored here. App-level config, so it lives here like every other
// setting — never in IndexedDB, and it rides Reset App's clearAllSettings
// like everything else. The SAME connection is shared by the Import/Export
// page and the KennelAssistant page (same origin, same folder).
export function getDropboxSettings() {
  const raw = localStorage.getItem(KEYS.dropbox);
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

export function setDropboxSettings(values) {
  const merged = { ...getDropboxSettings(), ...values };
  // A key explicitly set to null is a delete, so tokens can be dropped cleanly.
  for (const k of Object.keys(merged)) if (merged[k] == null) delete merged[k];
  localStorage.setItem(KEYS.dropbox, JSON.stringify(merged));
  return merged;
}

export function clearDropboxSettings() {
  localStorage.removeItem(KEYS.dropbox);
}

// KennelAssistant: when the dog feed was last pulled from Dropbox (ISO string).
export function getAssistantLastSync() {
  return localStorage.getItem(KEYS.assistantLastSync);
}

export function setAssistantLastSync(iso = new Date().toISOString()) {
  localStorage.setItem(KEYS.assistantLastSync, iso);
  return iso;
}

// Full app reset (Reset App to Start): drop every key this app owns in
// localStorage, so the next load has no memory of sample data, kennel setup,
// or backup history — same blank slate as a browser that's never visited.
export function clearAllSettings() {
  for (const key of Object.values(KEYS)) localStorage.removeItem(key);
}

// --- Pro license (Pro edition license gate — data/license.js) ----------------
// The cached Lemon Squeezy activation record (key, instance id, status, expiry,
// billing interval, last-validated timestamp) that lets Pro run offline within a
// grace window without re-hitting the network every launch.
//
// Deliberately NOT in KEYS above, so clearAllSettings() (Reset App to Start) does
// NOT drop it: a data reset wipes the kennel program, but paid entitlement isn't
// program data — de-activating Pro on a reset would be a hostile surprise, and the
// key would just re-validate anyway. It's cleared explicitly only when the owner
// chooses "use a different key" (clearProLicense), never by Reset App.
const PRO_LICENSE_KEY = 'kennelOS.proLicense';

export function getProLicense() {
  const raw = localStorage.getItem(PRO_LICENSE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function setProLicense(record) {
  localStorage.setItem(PRO_LICENSE_KEY, JSON.stringify(record));
  return record;
}

export function clearProLicense() {
  localStorage.removeItem(PRO_LICENSE_KEY);
}
