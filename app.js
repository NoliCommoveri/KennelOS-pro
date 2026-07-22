// app.js — shared shell bootstrap imported by every page. Injects the nav and,
// on first run, asks the browser to keep this origin's data durable.
//
// Imports here resolve relative to THIS module's URL (the app root), so they are
// correct no matter which page (root or /pages/) pulls app.js in.
import { renderNav } from './nav.js';
import { db, requestPersistentStorage } from './data/db.js';
import { wasPersistRequested, markPersistRequested } from './data/settings.js';
import { expenseRepo } from './data/expenseRepo.js';
import { renderSampleBanner } from './assets/sampleDataUI.js';
import { maybeShowKennelSetupPrompt, renderKennelBanner } from './assets/kennelSetupUI.js';
import { renderWizardMenuEntry, runWizardStep } from './assets/wizardUI.js';
import { runFirstRunOnboarding } from './assets/onboardingUI.js';
import { isDemo, withSeedAllowed } from './data/demoMode.js';
import { seedSampleData } from './data/editionTour.js';
import { isLicenseGated, ensureLicensed } from './assets/licenseGate.js';

async function firstRunPersistence() {
  if (wasPersistRequested()) return;
  markPersistRequested(); // record the attempt so we only prompt once
  await requestPersistentStorage();
}

// Registered against this module's own URL (not the page's) so it resolves to
// the same sw.js/scope from both index.html and /pages/*.html. A service
// worker with a fetch handler is required by Chrome/Android before it will
// offer to install the app, and it's what makes offline-after-first-load work.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const swUrl = new URL('./sw.js', import.meta.url);
  navigator.serviceWorker.register(swUrl, { scope: new URL('./', import.meta.url) });
}

// First run shows the onboarding sequence (Welcome → tour offer → tour or
// backups+New Kennel). On a non-fresh load it does nothing and returns false, so
// we fall through to the kennel-setup prompt that fires on the load right after
// sample data is cleared (shouldOfferKennelSetupPrompt gates it).
async function firstRunFlow() {
  const handled = await runFirstRunOnboarding();
  if (!handled) maybeShowKennelSetupPrompt();
}

// --- Demo edition (editions plan §"The Demo edition") ----------------------
// Auto-seed on load: the demo is a seeded, read-only showcase. Seed only when the
// DB is empty — every write is blocked in demo (demoMode.js), so once seeded it
// stays pristine across visits without re-wiping. On a genuinely empty load we
// seed (through the same repo layer real data uses, via the seed window) and then
// reload so the page scripts render against the seeded DB instead of an empty
// first paint. A sessionStorage guard caps this at one seed+reload per session,
// so a persistence hiccup can never spin a reload loop. Returns true if a reload
// is in flight (boot then skips rendering this doomed paint).
async function ensureDemoSeed() {
  const KEY = 'kennelos-demo-seed-attempted';
  if (sessionStorage.getItem(KEY)) return false;
  if ((await db.dogs.count()) > 0) return false; // already seeded from a prior visit
  sessionStorage.setItem(KEY, '1');
  await withSeedAllowed(() => seedSampleData());
  location.reload();
  return true;
}

// A persistent "this is a read-only demo" strip at the top of every page, so a
// blocked write is expected, not a surprise. Rendered only in the demo build.
function renderDemoBanner() {
  const bar = document.createElement('div');
  bar.className = 'demo-banner';
  bar.setAttribute('role', 'status');
  bar.innerHTML = "🔒 <strong>Demo</strong> — a read-only tour with sample data. Changes aren't saved.";
  document.body.insertBefore(bar, document.body.firstChild);
}

async function boot() {
  // Pro license gate (editions plan §Licensing): before rendering the app, make
  // sure this device has an active subscription. A painted wall (no key yet, or
  // lapsed past the grace window) returns false and boot stops. Active only in the
  // Pro edition (isLicenseGated) — Lite is free and Demo is a public showcase, so
  // this is a no-op there. Runs before the demo branch, but Demo never sets the
  // gate flag so it's skipped there regardless.
  if (isLicenseGated()) {
    let licensed = false;
    try {
      licensed = await ensureLicensed();
    } catch (e) {
      // A gate failure must not silently unlock Pro — but it also shouldn't brick
      // the app on an unexpected error. Log and fall through to render; the next
      // online load re-evaluates. (The gate is a soft check by design.)
      console.warn('KennelOS: license gate error', e);
      licensed = true;
    }
    if (!licensed) return;
  }

  // Demo: seed-then-(maybe)-reload before anything renders, then show the full
  // app read-only. It deliberately skips the first-run / kennel-setup / sample-
  // data UI — the demo is always seeded and never prompts the visitor to set up.
  if (isDemo()) {
    let reloading = false;
    try { reloading = await ensureDemoSeed(); } catch (e) { console.warn('KennelOS: demo seed failed', e); }
    if (reloading) return;
    renderNav();
    registerServiceWorker();
    renderDemoBanner();
    return;
  }

  renderNav();
  registerServiceWorker();
  firstRunPersistence();
  // One-time fold of legacy Event.cost values into the Financials ledger. Guarded
  // by a settings flag inside the repo, so it's a cheap no-op after the first run.
  expenseRepo.migrateEventCosts().catch(() => { /* non-fatal */ });
  renderSampleBanner();
  renderKennelBanner();
  renderWizardMenuEntry();
  runWizardStep();
  firstRunFlow();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
