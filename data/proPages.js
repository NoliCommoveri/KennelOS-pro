// proPages.js — the canonical list of Pro-only PAGES. Single source of truth for
// two things that must never disagree about what "Pro-only" means:
//   1. the Lite build (build/assemble.mjs excludes these files from the Lite artifact);
//   2. runtime gating of any in-app link to a Pro page from a Lite-kept shared page
//      (e.g. the Import/Export CSV-type dropdown drops the Pro options).
//
// These are the pages that carry Pro features; the data-layer repos they use stay in
// shared/ (they're imported by shared code), so absence is enforced at the page level.

// Pages under pages/ — basenames of the .html (the matching .js, when present, is
// excluded alongside it by the build).
export const PRO_ONLY_PAGES = [
  // People / Contacts
  'contacts.html', 'contact.html', 'contact-import.html',
  // Kennel management (full) — Lite keeps only first-run kennel setup
  'kennels.html', 'kennel.html', 'kennel-tests-import.html',
  // Stud services
  'stud-services.html', 'stud-service.html', 'stud-service-import.html',
  // Contracts
  'contracts.html', 'contract.html',
  // Reports (all)
  'reports.html', 'health-tests-report.html', 'litters-report.html',
  'litter-finances-report.html', 'placements-report.html', 'stud-services-report.html',
  // Companion share-out
  'companion.html',
  // Furever seed-link generator
  'furever.html',
  // Per-breed feeding schedules (sent along in the Furever seed packet)
  'breed-feeding-schedules.html',
  // Documents + file storage
  'documents.html',
  // Invoice / receipt generation (print doc)
  'invoice.html',
  // Puppy Record generation (print doc)
  'puppy-record.html',
];

// Standalone Pro files that live outside pages/ (no nav entry) — also excluded from
// the Lite build. `assets/documentModal.js` is the shared Documents add/edit + view
// modal, imported only by the Pro-only Documents and Contract pages, so Lite (which
// ships neither) doesn't need it — keep it out so no Pro-only code lands in Lite.
export const PRO_ONLY_STANDALONE = ['companion-view.html', 'assistant.html', 'assistant.js', 'assets/documentModal.js'];

// True when a link target (an href like "contact-import.html" or with a query string)
// points at a Pro-only page. Used by runtime gating in Lite-kept pages.
export function isProOnlyPage(href) {
  const file = String(href || '').split('/').pop().split('?')[0];
  return PRO_ONLY_PAGES.includes(file);
}
