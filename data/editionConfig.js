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

export async function enforceDogCap(/* { candidate, existing, id } */) {
  // no-op: Pro is unlimited.
}

export async function enforceLitterCap(/* { candidate } */) {
  // no-op: Pro is unlimited.
}

export const editionFlags = {
  manualDogArchive: true,
  includeArchivedToggles: true,
  archivedDogLinks: true,
  // Pro-only feature gates — all on in Pro.
  contactsSection: true,
  studServices: true,
  contracts: true,
  documents: true,
  companion: true,
  reports: true,
  invoicing: true,
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
