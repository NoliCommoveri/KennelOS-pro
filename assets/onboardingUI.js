// onboardingUI.js — the first-run welcome, shown once on a brand-new (empty,
// no-choice-yet) install: one non-dismissible Welcome card with the ways in.
// Sits at the shell level next to sampleDataUI.js / kennelSetupUI.js; app.js's
// boot is the only caller. (Installing as an app is a dismissible card on Today.)
//
// The branches:
//   "Start my kennel"        → no sample data (declineSampleData), then the kennel
//                              setup modal, whose optional email turns on backup.
//   "Take the tour"          → seed the Thornfield sample data, start the guided
//                              tour, reload so the destination page picks it up.
//   "I already use KennelOS" → sign in and restore (only with a cloud server).
import { shouldOfferFirstRunPrompt, declineSampleData } from '../data/sampleData.js';
import { seedSampleData } from '../data/editionTour.js';
import { startWizard } from '../data/wizardState.js';
import { showKennelSetupModal } from './kennelSetupUI.js';
import { isCloudAvailable } from '../data/cloud/cloudConfig.js';

// A single onboarding card: a dimmed, non-dismissible overlay (no backdrop close,
// no X — the only way onward is a button) with body HTML and one or more buttons.
// Resolves the clicked button's `value`.
function onboardCard({ bodyHtml, buttons }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'onboard-overlay';
    const actions = buttons.map((b) =>
      `<button type="button" class="btn ${b.primary ? 'btn-primary' : ''}" data-val="${b.value}">${b.label}</button>`
    ).join('');
    overlay.innerHTML = `
      <div class="onboard-card" role="dialog" aria-modal="true">
        <div class="onboard-body">${bodyHtml}</div>
        <div class="onboard-actions">${actions}</div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelectorAll('[data-val]').forEach((btn) => {
      btn.addEventListener('click', () => { overlay.remove(); resolve(btn.dataset.val); });
    });
  });
}

const welcomeHtml = () => WELCOME_HTML.replace(
  'Everything lives securely on this device — no account, no cloud, nothing leaves your browser.',
  isCloudAvailable()
    ? 'Everything lives securely on this device, and no account is needed. Free cloud backup is optional, and off unless you turn it on.'
    : 'Everything lives securely on this device — no account, no cloud, nothing leaves your browser.'
);

const WELCOME_HTML = `
  <h2 class="onboard-title">🐾 Welcome to KennelOS!</h2>
  <p>KennelOS is your whole breeding program in one private place. It helps you:</p>
  <ul class="onboard-list">
    <li><strong>Manage your dogs</strong> — breeding stock, puppies and outside dogs, all on one roster.</li>
    <li><strong>Keep health records</strong> — vaccines, tests, vet visits and a full timeline on every dog.</li>
    <li><strong>Plan breedings</strong> — pairings, heat cycles, litters and the puppies that result.</li>
    <li><strong>Facilitate sales &amp; placements</strong> — buyers, deposits, contracts and stud services.</li>
    <li><strong>Track the money</strong> — income and expenses, with a running picture of your net.</li>
    <li><strong>Generate documents</strong> — puppy records, invoices and receipts, ready to print.</li>
  </ul>
  <p>Everything lives securely on this device — no account, no cloud, nothing leaves your browser.</p>
  <p class="muted">New here? The tour shows you around with sample records in a couple of minutes, and you can leave it at any time.</p>`;

// The whole first-run sequence. Returns true when it handled the first run (so
// app.js knows not to fall through to its own kennel-setup prompt); false when
// this isn't a fresh install and nothing was shown.
export async function runFirstRunOnboarding() {
  if (!(await shouldOfferFirstRunPrompt())) return false;

  // One card, three ways in (decided 2026-10-10; it replaced Welcome → tour offer
  // → backups note). The third only when this edition has a cloud server (Cloud
  // Phase 1 plan §2.3): someone on a new phone signs in and restores, skipping
  // the tour and kennel setup (the restored records carry the kennel). Backing
  // out of sign-in returns to this card.
  const buttons = [
    { label: 'Start my kennel', value: 'explore', primary: true },
    { label: 'Take the tour', value: 'tour' }
  ];
  if (isCloudAvailable()) buttons.push({ label: 'I already use KennelOS', value: 'restore' });

  let choice;
  for (;;) {
    choice = await onboardCard({ bodyHtml: welcomeHtml(), buttons });
    if (choice !== 'restore') break;
    const { runSignInAndRestore } = await import('./cloudBackupUI.js');
    const restored = await runSignInAndRestore();
    if (restored === true) {
      location.reload();
      return true;
    }
    if (restored === 'empty') {
      // Signed in, backup on, but nothing to restore yet: a blank kennel, as below.
      declineSampleData();
      showKennelSetupModal({ mode: 'required' });
      return true;
    }
  }

  if (choice === 'tour') {
    await seedSampleData();   // load Thornfield so the tour has live records to point at
    startWizard();            // status active, index 0 = the tour-intro card
    location.reload();        // destination page's runWizardStep picks the tour back up
    return true;              // (never returns past the reload)
  }

  // "Start my kennel": a blank kennel, no sample data ever seeded on this path.
  // Required, not skippable (spec §3.2): there is no kennel anywhere yet and
  // nothing they create could be filed. Its optional email turns on cloud backup.
  declineSampleData();
  showKennelSetupModal({ mode: 'required' });
  return true;
}
