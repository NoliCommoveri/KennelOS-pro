// onboardingUI.js — the first-run welcome sequence, shown once on a brand-new
// (empty, no-choice-yet) install: a non-dismissible Welcome card, a tour offer,
// and — for anyone who declines the tour — a backups/install card that hands off
// to the kennel-setup ("New Kennel") modal. Sits at the shell level next to
// sampleDataUI.js / kennelSetupUI.js; app.js's boot is the only caller.
//
// The two branches:
//   "Show me around!"  → seed the Thornfield sample data, start the guided tour,
//                        reload so the destination page's runWizardStep picks it up.
//   "No thanks…"       → no sample data (declineSampleData), show backups/install,
//                        then the New Kennel modal — a blank kennel of the user's own.
import { shouldOfferFirstRunPrompt, declineSampleData } from '../data/sampleData.js';
import { seedSampleData } from '../data/editionTour.js';
import { startWizard } from '../data/wizardState.js';
import { showKennelSetupModal } from './kennelSetupUI.js';

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
  <p>Everything lives securely on this device — no account, no cloud, nothing leaves your browser.</p>`;

const TOUR_OFFER_HTML = `
  <h2 class="onboard-title">Would you like a quick tour?</h2>
  <p>To help you learn your way around, there’s a brief guided tour that walks through the major
  features that make KennelOS such a powerful tool. It takes just a couple of minutes, and you can
  leave it at any time.</p>`;

const BACKUP_INSTALL_HTML = `
  <h2 class="onboard-title">A quick note on backups</h2>
  <p>Because your data lives only in this browser, <strong>it’s yours to safeguard.</strong> Get in the
  habit of backing up regularly: open <strong>Import / Export</strong> and export a JSON backup. Keep it
  somewhere safe — that file can restore everything if this device is ever lost, cleared or replaced.</p>
  <hr class="onboard-rule">
  <h3 class="onboard-subtitle">📲 Install KennelOS as an app</h3>
  <p>Add KennelOS to your home screen so it opens like a normal app and works offline:</p>
  <ul class="onboard-list">
    <li><strong>Android (Chrome):</strong> tap the <strong>⋮</strong> menu (top-right) →
      <strong>Add to Home screen</strong> (or <strong>Install app</strong>), then confirm.</li>
    <li><strong>iPhone / iPad (Safari):</strong> tap the <strong>Share</strong> button (□ with an ↑) →
      scroll down → <strong>Add to Home Screen</strong>.</li>
  </ul>`;

// The whole first-run sequence. Returns true when it handled the first run (so
// app.js knows not to fall through to its own kennel-setup prompt); false when
// this isn't a fresh install and nothing was shown.
export async function runFirstRunOnboarding() {
  if (!(await shouldOfferFirstRunPrompt())) return false;

  await onboardCard({
    bodyHtml: WELCOME_HTML,
    buttons: [{ label: 'Get started →', value: 'go', primary: true }]
  });

  const choice = await onboardCard({
    bodyHtml: TOUR_OFFER_HTML,
    buttons: [
      { label: 'Show me around!', value: 'tour', primary: true },
      { label: 'No thanks, I’ll explore', value: 'explore' }
    ]
  });

  if (choice === 'tour') {
    await seedSampleData();   // load Thornfield so the tour has live records to point at
    startWizard();            // status active, index 0 = the tour-intro card
    location.reload();        // destination page's runWizardStep picks the tour back up
    return true;              // (never returns past the reload)
  }

  // "I'll explore" — a blank kennel, no sample data ever seeded on this path.
  declineSampleData();
  await onboardCard({
    bodyHtml: BACKUP_INSTALL_HTML,
    buttons: [{ label: 'Got it!', value: 'ok', primary: true }]
  });
  showKennelSetupModal({ skippable: true });
  return true;
}
