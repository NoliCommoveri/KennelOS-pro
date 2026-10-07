// pro/editionConfig.js — Pro edition config.
//
// Pro is the full, unlimited app. This is identical to the shared default:
// no-op cap hooks + full-feature flags. It's kept as its own file so the
// edition set is uniform (every edition owns one), and so a deploy can place
// the right config at shared's fixed path (shared/data/editionConfig.js) for
// each origin — Pro's shipped bytes therefore contain NO cap logic (cap spec §8).

export const edition = 'pro';

// Suffix shown after "KennelOS" in the nav brand (nav.js). Null renders nothing.
export const editionLabel = 'Pro';

// No in-app upgrade CTA in this edition (Pro is already the full app; Demo is a
// read-only showcase). Exported so shared code that reads it always resolves.
export const upgradeUrl = null;

// No outbound edition links from Pro (Lite is the hub that links out). Null so
// hasEditionLinks() is false and the nav/Today footer render nothing.
export const demoUrl = null;

// Cloud backup API (Cloud Phase 1 plan §7): production, live since the go-live
// change (plan §9 step 6). Back to null is how a shutdown release turns every
// cloud feature off. `devCloudUrl` (the staging Worker) applies when served from
// localhost, or in a browser that opted in with ?cloud=staging (the test-server
// switch); see data/cloud/cloudConfig.js.
export const cloudUrl = 'https://api.kennelos.app';
export const devCloudUrl = 'https://kennelos-api-staging.admin-kennelos.workers.dev';

// --- License gate (editions plan §Licensing) -------------------------------
// Pro is a Lemon Squeezy subscription unlocked by a browser-validated license
// key (data/license.js + assets/licenseGate.js). This config is read only when
// editionFlags.licenseGate is true — which it is ONLY here, in Pro. Lite/Demo
// export a null config (their import must resolve) but never run the gate.
export const licenseConfig = {
  // Where "Buy Pro →" (activation wall) and "Renew Pro →" (renewal wall) point.
  // Set the store checkout's post-purchase redirect to this Pro origin so a buyer
  // lands here to activate + import.
  //
  // This is the all-tiers pricing section, NOT a single Lemon Squeezy variant link,
  // because one slot serves both walls: a direct variant URL is right for at most
  // one visitor. "Buy Pro" should let a first-time buyer choose monthly / yearly /
  // lifetime, and "Renew Pro" must not push a lapsed monthly subscriber at a $69.99
  // one-time purchase (or a lifetime owner at a subscription). The per-variant
  // checkout links live on that page, one per tier. For a lapsed subscriber who just
  // wants to manage billing, set `portalUrl` below — that's the better door.
  checkoutUrl: 'https://kennelos.app/pro.html#pricing',
  // Optional Lemon Squeezy customer-portal URL ("Manage subscription") shown on
  // the renewal wall. Null hides that link. PLACEHOLDER — set at launch if used.
  portalUrl: null,
  // The billing interval drives the offline grace window (yearly 7d, monthly 3d).
  // Lemon Squeezy returns the variant NAME, not a clean interval, so we match it
  // against this pattern (case-insensitive) → yearly; anything else → monthly (the
  // shorter, stricter window). Tune to the store's variant names.
  yearlyVariantPattern: 'year|annual',
  // A one-time Lifetime purchase is PERPETUAL — matched by name against this
  // pattern → a license that never expires and never needs online re-validation
  // (no subscription to lapse). Tune to the store's variant name for that tier.
  lifetimeVariantPattern: 'lifetime|perpetual',
};

export async function enforceDogCap(/* { candidate, existing, id } */) {
  // no-op: Pro is unlimited.
}

export async function enforceLitterCap(/* { candidate } */) {
  // no-op: Pro is unlimited.
}

// Bulk-import cap hook (cap spec §9). The shared restore path (importExport.js)
// awaits this before writing a JSON backup, passing the backup's dog rows and the
// restore mode. No-op here, so Pro restores any backup unchanged.
export async function enforceImportDogCap(/* { incomingDogs, mode } */) {
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
  furever: true,
  reports: true,
  invoicing: true,
  puppyRecord: true,
  fosterArrangement: true,
  receiptAttach: true,
  externalOwnership: true,
  assistant: true,
  feedingSchedule: true,
  shows: true,             // Show tracking (Show Tracking Spec §7)
  waitlist: true,         // Per-kennel waitlist (Waitlist Spec)
  // Multi-kennel scope (Multi-Kennel Scope Spec §12) — Pro is the edition that
  // gets more than one own kennel and the active-kennel switcher.
  multiKennel: true,
};

// Full nav bar (Pro has every hub).
export const navItems = [
  { label: 'Today',    path: 'pages/today.html' },
  { label: 'Dogs',     path: 'pages/dogs.html' },
  { label: 'Breeding', path: 'pages/breeding.html' },
  { label: 'People',   path: 'pages/contacts.html' },
  { label: 'Placements & Contracts', path: 'pages/sales.html' },
  { label: 'Financials', path: 'pages/financials.html' },
  { label: 'Sharing',    path: 'pages/companion.html' }, // Companion + Furever + Assistant, seg-tabbed
];

export const moreItems = [
  { label: 'Reports',       path: 'pages/reports.html' },
  { label: 'Shows',         path: 'pages/shows.html' },
  { label: 'Documents',     path: 'pages/documents.html' },
  { label: 'Import/Export', path: 'pages/import-export.html' },
];
