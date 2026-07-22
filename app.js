// app.js — shared shell bootstrap imported by every page. Injects the nav and,
// on first run, asks the browser to keep this origin's data durable.
//
// Imports here resolve relative to THIS module's URL (the app root), so they are
// correct no matter which page (root or /pages/) pulls app.js in.
import { renderNav } from './nav.js';
import { requestPersistentStorage } from './data/db.js';
import { wasPersistRequested, markPersistRequested } from './data/settings.js';
import { expenseRepo } from './data/expenseRepo.js';
import { renderSampleBanner } from './assets/sampleDataUI.js';
import { maybeShowKennelSetupPrompt, renderKennelBanner } from './assets/kennelSetupUI.js';
import { renderWizardMenuEntry, runWizardStep } from './assets/wizardUI.js';
import { runFirstRunOnboarding } from './assets/onboardingUI.js';

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

function boot() {
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
