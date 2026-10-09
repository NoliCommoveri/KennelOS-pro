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
  'pl-report.html', 'year-review.html',
  'production-report.html', 'pairing-success-report.html', 'puppy-growth-report.html',
  'waitlist-funnel-report.html', 'demand-supply-report.html',
  'expenses-report.html', 'receivables-report.html', 'pricing-report.html', 'dog-return-report.html', 'heat-cycles-report.html',
  'health-gaps-report.html', 'lead-sources-report.html', 'returns-report.html', 'show-record-report.html', 'stud-results-report.html',
  // Companion share-out
  'companion.html',
  // KennelAssistant owner console (the helper's own app is the root-level
  // assistant.html in PRO_ONLY_STANDALONE below — same basename, different
  // directory, and both are Pro-only so isProOnlyPage's basename match is
  // correct either way).
  'assistant.html',
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
  // Show tracking — the Shows page (Show Tracking Spec §5.2/§7)
  'shows.html',
  // Waitlist (Waitlist Spec §11) — the list, one family, and programs
  'waitlist.html', 'waitlist-entry.html', 'waitlist-programs.html', 'waitlist-import.html',
  // ...and her application form editor (Waitlist Spec §15.1)
  'waitlist-form.html',
  // ...and publishing the list: online, or as text to copy (Spec §15.3)
  'waitlist-publish.html',
];

// Standalone Pro files that live outside pages/ (no nav entry) — also excluded from
// the Lite build. `assets/documentModal.js` is the shared Documents add/edit + view
// modal, imported only by the Pro-only Documents and Contract pages, so Lite (which
// ships neither) doesn't need it — keep it out so no Pro-only code lands in Lite.
// `assets/kennelCardUI.js` is the same story for Kennel Cards: imported only by the
// Pro-only Kennel hub and Kennels list. (Its data-layer half, `data/kennelCard.js`,
// stays in the shared build — it's reached through kennelRepo, exactly like
// `data/companionExport.js` ships to Lite while `companion.html` does not.)
export const PRO_ONLY_STANDALONE = [
  'companion-view.html', 'assistant.html', 'assistant.js',
  'assets/documentModal.js', 'assets/kennelCardUI.js',
  // Page-side helpers for the waitlist pages only. Its data layer (repos, rules,
  // actions) stays shared, like every repo.
  'assets/waitlistUI.js',
  // The Litter page's waitlist picks panel — litter.js imports it dynamically only
  // when editionFlags.waitlist is on, so Lite never requests it.
  'assets/waitlistPicksPanel.js',
  // The Kennel page's "Online list" card (Waitlist W2 Plan §9), imported only when
  // editionFlags.waitlist is on and the waitlist online is offered.
  'assets/waitlistOnlineUI.js',
  // The "Email the family?" preview (W2 step 6), imported by the waitlist pages,
  // the picks panel and (dynamically) Today's waitlist nudges.
  'assets/waitlistEmailUI.js',
  // Invoice / receipt document model + its PDF renderer (Waitlist Spec §15.2),
  // used only by the Pro invoice page and the waitlist family page, and the
  // vendored jsPDF they load on demand.
  'assets/invoiceDoc.js', 'assets/invoicePdf.js', 'vendor/jspdf.umd.min.js',
  // The Invoice / Receipt generator modal, opened from Financials and a Sale's
  // page — both import it dynamically only when editionFlags.invoicing is on.
  'assets/invoiceGenerator.js',
  // Which fields the Puppy Record prints, read only by the Pro-only Puppy Record
  // and Kennel pages.
  'data/puppyRecordFields.js'
];

// True when a link target (an href like "contact-import.html" or with a query string)
// points at a Pro-only page. Used by runtime gating in Lite-kept pages.
export function isProOnlyPage(href) {
  const file = String(href || '').split('/').pop().split('?')[0];
  return PRO_ONLY_PAGES.includes(file);
}
