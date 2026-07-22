// wizardState.js — status/index state machine for the first-run guided tour
// (Wizard Runtime Spec v1 §2.2). Pure functions, no DOM. Mirrors kennelSetup.js's
// split between state (here) and UI (assets/wizardUI.js). The step catalog itself
// lives in the sibling data/wizardSteps.js — kept separate so this file stays a
// handful of state functions, not buried under the (long, mechanical) step array.
import { WIZARD_STEPS } from './editionTour.js';
import {
  getWizardStatusRaw, setWizardStatusRaw,
  getWizardStepIndexRaw, setWizardStepIndexRaw,
  getSampleDataManifest, wasSampleDataCleared
} from './settings.js';

// The tour's anchors are specific sample records with no equivalent guarantee on
// real data (§1.4/§6.3), so it's only available while the Thornfield seed is the
// active dataset — same two signals sampleDataUI.js already reads for its banner.
export function isTourAvailable() {
  return !!getSampleDataManifest() && !wasSampleDataCleared();
}

export function getWizardStatus() {
  return getWizardStatusRaw() || 'unseen';
}

export function getWizardStepIndex() {
  const i = getWizardStepIndexRaw();
  return Math.min(Math.max(i, 0), Math.max(WIZARD_STEPS.length - 1, 0));
}

export function currentStep() {
  return WIZARD_STEPS[getWizardStepIndex()] || null;
}

// A centered, page-agnostic card with a single forward button (as opposed to a
// highlight step, which spotlights a real element on its page): the tour-intro,
// each hub-intro, and — in the Lite tour — the 'pro-promo' upgrade cards. All
// three render the same way and are excluded from the "Step n of N" count.
export function isIntroStep(step) {
  return step?.kind === 'tour-intro' || step?.kind === 'hub-intro' || step?.kind === 'pro-promo';
}

// The highlight steps in order — used for the "Step n of N" counter, which counts
// only the real feature stops, not the intro cards between hubs.
export const HIGHLIGHT_STEPS = WIZARD_STEPS.filter((s) => !isIntroStep(s));

export function stepsForPage(pageKey) {
  return WIZARD_STEPS.filter((s) => s.page && s.page.split('?')[0] === pageKey);
}

export function startWizard() {
  setWizardStatusRaw('active');
  setWizardStepIndexRaw(0);
}

export function advanceWizard() {
  const next = getWizardStepIndex() + 1;
  if (next >= WIZARD_STEPS.length) {
    completeWizard();
    return;
  }
  setWizardStepIndexRaw(next);
}

export function retreatWizard() {
  setWizardStepIndexRaw(Math.max(getWizardStepIndex() - 1, 0));
}

export function dismissWizard() {
  setWizardStatusRaw('dismissed'); // index untouched — resuming later picks up where it left off
}

export function completeWizard() {
  setWizardStatusRaw('completed');
  setWizardStepIndexRaw(0); // finishing implies "from the top" on replay
}

export function restartWizard() {
  setWizardStatusRaw('active');
  setWizardStepIndexRaw(0);
}
