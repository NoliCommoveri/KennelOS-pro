// sw.js — app-shell cache so KennelOS installs as a PWA and keeps working
// offline after the first load, per CLAUDE.md. Registered from app.js with a
// scope of this file's own directory (the KennelOS root), so it covers /pages/
// too. Bump CACHE_NAME whenever the precache list changes to roll caches over
// — the fetch handler below is cache-first, so an already-installed client
// never re-fetches a stale precached file on its own; only a CACHE_NAME change
// (which changes these bytes, so the browser detects a new service worker,
// installs it, and purges the old cache in `activate`) rolls it over.
const CACHE_NAME = 'kennelos-pro-shell-v18';

const PRECACHE_URLS = [
  './',
  'index.html',
  'companion-view.html',
  'assistant.html',
  'assistant.js',
  'app.js',
  'nav.js',
  'manifest.json',
  'assets/app.css',
  'assets/breedTestPicker.js',
  'assets/contactPicker.js',
  'assets/documentModal.js',
  'assets/editionLinks.js',
  'assets/eventForm.js',
  'assets/expensePanel.js',
  'assets/importView.js',
  'assets/kennelSetupUI.js',
  'assets/listView.js',
  'assets/onboardingUI.js',
  'assets/pedigree.js',
  'assets/puppyForm.js',
  'assets/receiptCapture.js',
  'assets/reportView.js',
  'assets/sampleDataUI.js',
  'assets/timeline.js',
  'assets/licenseGate.js',
  'assets/ui.js',
  'assets/upgradeNudge.js',
  'assets/wizardUI.js',
  'assets/icons/apple-touch-icon.png',
  'assets/icons/favicon-32.png',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/maskable-512.png',
  'data/appReset.js',
  'data/assistantStore.js',
  'data/assistantSync.js',
  'data/awayBoard.js',
  'data/companionExport.js',
  'data/contactRepo.js',
  'data/contractRepo.js',
  'data/csvImport.js',
  'data/dateUtils.js',
  'data/db.js',
  'data/demoMode.js',
  'data/documentRepo.js',
  'data/dogRepo.js',
  'data/dropbox.js',
  'data/editionConfig.js',
  'data/editionTour.js',
  'data/eventRepo.js',
  'data/expenseRepo.js',
  'data/fileRepo.js',
  'data/fureverSeedExport.js',
  'data/importExport.js',
  'data/license.js',
  'data/incomeView.js',
  'data/kennelRepo.js',
  'data/litterFinances.js',
  'data/kennelSetup.js',
  'data/litterRepo.js',
  'data/nudges.js',
  'data/nudgeState.js',
  'data/ocr.js',
  'data/pairingRepo.js',
  'data/pdfBuild.js',
  'data/proPages.js',
  'data/referenceRegistry.js',
  'data/repoBase.js',
  'data/rosterCount.js',
  'data/saleRepo.js',
  'data/sampleData.js',
  'data/seedImport.js',
  'data/settings.js',
  'data/studServiceRepo.js',
  'data/vocab.js',
  'data/wizardState.js',
  'data/wizardSteps.js',
  'pages/active-breeding.html',
  'pages/active-breeding.js',
  'pages/board.html',
  'pages/board.js',
  'pages/breeding.html',
  'pages/breeding.js',
  'pages/companion.html',
  'pages/companion.js',
  'pages/dashboard.html',
  'pages/dashboard.js',
  'pages/contact-import.html',
  'pages/contact-import.js',
  'pages/contact.html',
  'pages/contact.js',
  'pages/contacts.html',
  'pages/contacts.js',
  'pages/contract.html',
  'pages/contract.js',
  'pages/contracts.html',
  'pages/contracts.js',
  'pages/dog-import.html',
  'pages/dog-import.js',
  'pages/dog.html',
  'pages/dog.js',
  'pages/documents.html',
  'pages/documents.js',
  'pages/dogs.html',
  'pages/dogs.js',
  'pages/event-import.html',
  'pages/event-import.js',
  'pages/expense-import.html',
  'pages/expense-import.js',
  'pages/financials.html',
  'pages/financials.js',
  'pages/furever.html',
  'pages/furever.js',
  'pages/health-tests-report.html',
  'pages/health-tests-report.js',
  'pages/import-export.html',
  'pages/import-export.js',
  'pages/invoice.html',
  'pages/invoice.js',
  'pages/kennel-tests-import.html',
  'pages/kennel-tests-import.js',
  'pages/kennel.html',
  'pages/kennel.js',
  'pages/kennels.html',
  'pages/kennels.js',
  'pages/litter-finances-report.html',
  'pages/litter-finances-report.js',
  'pages/litter-import.html',
  'pages/litter-import.js',
  'pages/litter.html',
  'pages/litter.js',
  'pages/litters.html',
  'pages/litters.js',
  'pages/litters-report.html',
  'pages/litters-report.js',
  'pages/live-births.html',
  'pages/live-births.js',
  'pages/pairing-import.html',
  'pages/pairing-import.js',
  'pages/pairing.html',
  'pages/pairing.js',
  'pages/pairings.html',
  'pages/pairings.js',
  'pages/pedigree.html',
  'pages/pedigree.js',
  'pages/placements-report.html',
  'pages/placements-report.js',
  'pages/puppy-record.html',
  'pages/puppy-record.js',
  'pages/reminders.html',
  'pages/reminders.js',
  'pages/reports.html',
  'pages/roster.html',
  'pages/roster.js',
  'pages/sale-import.html',
  'pages/sale-import.js',
  'pages/sale.html',
  'pages/sale.js',
  'pages/sales.html',
  'pages/sales.js',
  'pages/scheduled-placements.html',
  'pages/scheduled-placements.js',
  'pages/stud-service-import.html',
  'pages/stud-service-import.js',
  'pages/stud-service.html',
  'pages/stud-service.js',
  'pages/stud-services.html',
  'pages/stud-services.js',
  'pages/stud-services-report.html',
  'pages/stud-services-report.js',
  'pages/today.html',
  'pages/today.js',
  'pages/upcoming.html',
  'pages/upcoming.js',
  'vendor/dexie.min.mjs',
  'vendor/lz-string.min.mjs',
  'vendor/papaparse.min.mjs',
  'vendor/tesseract/eng.traineddata.gz',
  'vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
  'vendor/tesseract/tesseract.esm.min.js',
  'vendor/tesseract/worker.min.js',
  'resources/common_tests_by_breed_seed.csv',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

// Cache-first for same-origin GET requests; falls through to the network
// untouched for everything else (cross-origin, non-GET).
//
// Query strings are ignored for BOTH the lookup and the write. A record URL like
// `pages/dog.html?id=<uuid>` is the same static shell as the precached
// `pages/dog.html` — the page reads its id from the query at runtime — so:
//   - matching with { ignoreSearch: true } serves the precached shell for any id,
//     which also makes a never-before-visited record open offline; and
//   - runtime-caching only query-less responses stops the cache from growing one
//     entry per visited record (the old handler `cache.put`-ed every distinct
//     `?id=…`, an unbounded leak that only a CACHE_NAME rollover ever cleared).
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && !url.search) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
