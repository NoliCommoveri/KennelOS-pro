// pro/editionConfig.js — Pro edition config.
//
// Pro is the full, unlimited app. This is identical to the shared default:
// no-op cap hooks + full-feature flags. It's kept as its own file so the
// edition set is uniform (every edition owns one), and so a deploy can place
// the right config at shared's fixed path (shared/data/editionConfig.js) for
// each origin — Pro's shipped bytes therefore contain NO cap logic (cap spec §8).

export const edition = 'pro';

// No in-app upgrade CTA in this edition (Pro is already the full app; Demo is a
// read-only showcase). Exported so shared code that reads it always resolves.
export const upgradeUrl = null;

// No outbound edition links from Pro (Lite is the hub that links out). Null so
// hasEditionLinks() is false and the nav/Today footer render nothing.
export const demoUrl = null;

// --- License gate (editions plan §Licensing) -------------------------------
// Pro is a Lemon Squeezy subscription unlocked by a browser-validated license
// key (data/license.js + assets/licenseGate.js). This config is read only when
// editionFlags.licenseGate is true — which it is ONLY here, in Pro. Lite/Demo
// export a null config (their import must resolve) but never run the gate.
export const licenseConfig = {
  // The Lemon Squeezy checkout URL for buying / renewing Pro, shown on the
  // activation and renewal walls. Set the store checkout's post-purchase redirect
  // to this Pro origin so an upgrader lands here to activate + import.
  // PLACEHOLDER — swap for the real Lemon Squeezy checkout link at launch.
  checkoutUrl: 'https://kennelos.lemonsqueezy.com/buy/kennelos-pro',
  // Optional Lemon Squeezy customer-portal URL ("Manage subscription") shown on
  // the renewal wall. Null hides that link. PLACEHOLDER — set at launch if used.
  portalUrl: null,
  // The billing interval drives the offline grace window (yearly ~30d, monthly
  // ~7d). Lemon Squeezy returns the variant NAME, not a clean interval, so we
  // match it against this pattern (case-insensitive) → yearly; anything else →
  // monthly (the shorter, stricter window). Tune to the store's variant names.
  yearlyVariantPattern: 'year|annual',
};

export async function enforceDogCap(/* { candidate, existing, id } */) {
  // no-op: Pro is unlimited.
}

export async function enforceLitterCap(/* { candidate } */) {
  // no-op: Pro is unlimited.
}

// Read by dog.js's "New Dog" page for its cap-status banner. Null means
// uncapped, so Pro shows nothing.
export async function dogCapStatus() {
  return null;
}

export const editionFlags = {
  manualDogArchive: true,
  includeArchivedToggles: true,
  archivedDogLinks: true,
  fullDogStatuses: true,
  licenseGate: true, // read by license.js — Pro is the ONLY edition that gates on a key
  // Pro-only feature gates — all on in Pro.
  contactsSection: true,
  studServices: true,
  contracts: true,
  documents: true,
  companion: true,
  reports: true,
  invoicing: true,
  puppyRecord: true,
  fosterArrangement: true,
  receiptAttach: true,
  externalOwnership: true,
  assistant: true,
};

// Full nav bar (Pro has every hub).
export const navItems = [
  { label: 'Today',    path: 'pages/today.html' },
  { label: 'Dogs',     path: 'pages/dogs.html' },
  { label: 'Breeding', path: 'pages/breeding.html' },
  { label: 'People',   path: 'pages/contacts.html' },
  { label: 'Placements & Contracts', path: 'pages/sales.html' },
  { label: 'Financials', path: 'pages/financials.html' },
];

export const moreItems = [
  { label: 'Reports',       path: 'pages/reports.html' },
  { label: 'Documents',     path: 'pages/documents.html' },
  { label: 'Companion',     path: 'pages/companion.html' },
  { label: 'Import/Export', path: 'pages/import-export.html' },
];
