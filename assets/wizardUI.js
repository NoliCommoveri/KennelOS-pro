// wizardUI.js — the guided-tour overlay/spotlight/tooltip, the nav "Take the
// tour" entry, and the "Resume tour" pill (Wizard Runtime Spec v1 §4-§7).
// The only module that touches wizard DOM; app.js's shared boot is the only
// caller (no page file imports anything from here — §7).
//
// Card kinds (data/wizardSteps.js): an *intro* step (tour-intro / hub-intro) is a
// centered, page-agnostic card with a single forward button; a *highlight* step
// spotlights a real element and pins a compact card to the top of the screen so
// the feature it describes shows below it, no longer hidden underneath.
import {
  isTourAvailable, getWizardStatus, getWizardStepIndex, currentStep,
  startWizard, advanceWizard, retreatWizard, dismissWizard,
  isIntroStep, HIGHLIGHT_STEPS
} from '../data/wizardState.js';
import { WIZARD_STEPS } from '../data/wizardSteps.js';
import { getSampleDataManifest } from '../data/settings.js';
import { clearSampleData } from '../data/sampleData.js';
import { showKennelSetupModal } from './kennelSetupUI.js';
import { alertModal, esc } from './ui.js';

function rootPrefix() {
  return location.pathname.includes('/pages/') ? '../' : '';
}

function currentFile() {
  const parts = location.pathname.split('/');
  return parts[parts.length - 1] || 'index.html';
}

function currentId() {
  return new URLSearchParams(location.search).get('id');
}

// Detail-page steps carry an `anchor` slug (e.g. 'juniper'); resolve it to the
// current seed's real id via the manifest.named map the seed writes (spec §3.2,
// reconciled to the actual runtime-UUID seed). Null for list/hub steps.
function resolvedAnchorId(step) {
  if (!step.anchor) return null;
  return getSampleDataManifest()?.named?.[step.anchor] || null;
}

// Is the browser already on this step's page? Intro steps have no page — they
// render wherever the user is, so they always count as "on page". For an
// anchored detail step the ?id= must be the resolved anchor id too, so advancing
// between two different dogs (both dog.html) still navigates.
function isOnStepPage(step) {
  if (!step.page) return true;
  if (step.page.split('?')[0] !== currentFile()) return false;
  const wantId = resolvedAnchorId(step);
  return wantId ? currentId() === wantId : true;
}

function resolveStepUrl(step) {
  const base = `${rootPrefix()}pages/${step.page.split('?')[0]}`;
  const id = resolvedAnchorId(step);
  return id ? `${base}?id=${id}` : base;
}

function goToStep(step) {
  location.href = resolveStepUrl(step);
}

// --- Nav menu entry ------------------------------------------------------
export function renderWizardMenuEntry() {
  if (!isTourAvailable()) return;
  const menu = document.querySelector('.nav-more-menu');
  if (!menu) return;

  const status = getWizardStatus();
  const label = status === 'completed' ? '🧭 Retake the tour'
    : (status === 'active' && getWizardStepIndex() > 0) ? '🧭 Resume tour'
    : '🧭 Take the tour';

  const a = document.createElement('a');
  a.href = '#';
  a.className = 'nav-link';
  a.textContent = label;
  a.addEventListener('click', (e) => {
    e.preventDefault();
    if (status !== 'active') startWizard();
    const step = currentStep();
    if (!step) return;
    if (isOnStepPage(step)) runWizardStep();
    else goToStep(step);
  });
  menu.appendChild(a);
}

// --- Overlay / spotlight / cards -----------------------------------------
let mountedNodes = [];
let spotlightEl = null;
let reflowObserver = null; // re-positions the target as late-loading content settles

function teardown() {
  renderToken++; // invalidate any in-flight target poll
  if (reflowObserver) { reflowObserver.disconnect(); reflowObserver = null; }
  mountedNodes.forEach((n) => n.remove());
  mountedNodes = [];
  if (spotlightEl) {
    spotlightEl.classList.remove('wizard-spotlight-target');
    spotlightEl = null;
  }
}

// The full-viewport layer. Dimmed for intro cards and the missing-target
// fallback (nothing is spotlit, so the dim has to come from here); transparent
// for a normal highlight step, where the dim is the spotlight's own box-shadow.
function mountOverlay(dim) {
  const overlay = document.createElement('div');
  overlay.className = dim ? 'wizard-overlay wizard-overlay-dim' : 'wizard-overlay';
  document.body.appendChild(overlay);
  mountedNodes.push(overlay);
  return overlay;
}

function revealTarget(step) {
  if (!step.beforeShow?.openCard) return;
  const key = step.beforeShow.openCard;
  const btn = document.querySelector(`[data-card="${CSS.escape(key)}"] .card-toggle-btn`);
  const body = btn?.closest('.card-collapsible')?.querySelector('.card-body');
  if (btn && body && body.hidden) btn.click();
}

const CLOSING_MESSAGE = 'And that’s it! You now know how to use KennelOS to manage your entire ' +
  'breeding operation’s recordkeeping. We’ll clear the sample data now — you won’t need it, ' +
  'you’ve got your own dogs to load in — and get you set up with your kennel name next. We hope ' +
  'you love using the app!';

// Finishing the tour mirrors the "I'll explore" onboarding ending: acknowledge,
// clear the Thornfield seed (clearSampleData only removes the seeded records), and
// hand off to the kennel-setup modal — exactly what the closing copy promises.
async function finishTour() {
  teardown();
  await alertModal({ title: 'Tour complete', message: CLOSING_MESSAGE, okLabel: 'Set up my kennel →' });
  try { await clearSampleData(); } catch { /* leave the seed in place if the clear fails */ }
  await showKennelSetupModal({ skippable: true });
}

function goNext() {
  advanceWizard();
  if (getWizardStatus() !== 'active') {
    finishTour();
    return;
  }
  const step = currentStep();
  if (isOnStepPage(step)) runWizardStep();
  else goToStep(step);
}

function goBack() {
  retreatWizard();
  const step = currentStep();
  if (isOnStepPage(step)) runWizardStep();
  else goToStep(step);
}

function skip() {
  dismissWizard();
  teardown();
}

// A centered card: the tour-intro and each hub-intro (one forward button), and
// the missing-target fallback for a highlight step (Back / Skip / Next).
function mountCenteredCard(step) {
  const card = document.createElement('div');
  card.className = 'wizard-card wizard-card-centered';
  card.innerHTML = cardInner(step);
  document.body.appendChild(card);
  mountedNodes.push(card);
  wireCardButtons(card);
}

// A highlight card pinned to the top of the viewport, with the spotlit target
// scrolled to sit just below it (§ pinned-top, so the card never covers the
// data it explains). Falls back to a centered card if the target never appears.
function mountTopCard(step, target) {
  const card = document.createElement('div');
  card.className = 'wizard-card wizard-card-top';
  card.innerHTML = cardInner(step);
  document.body.appendChild(card);
  mountedNodes.push(card);
  wireCardButtons(card);
  positionTarget(card, target);
  // Content-heavy pages (a dog/litter profile) fill their sections in async, so
  // the target's position keeps shifting after this first pass. Re-position on
  // every reflow — otherwise the one-shot scroll lands on a stale position and
  // the section ends up off-screen (the "one stop that doesn't scroll" bug).
  observeReflow(card, target, renderToken);
}

// Place the spotlit target relative to the pinned card so both stay visible.
// Idempotent, so it can be re-run on reflow: a top card scrolls its target to sit
// just below it; if the target's top can't clear the card (it lives near the page
// top and the upward scroll is clamped at 0), the card flips to the bottom of the
// viewport and the target is lifted to the top instead — after which re-runs keep
// the target pinned near the top.
function positionTarget(card, target) {
  const gap = 20;
  if (card.classList.contains('wizard-card-bottom')) {
    const lift = target.getBoundingClientRect().top - gap;
    if (Math.abs(lift) > 2) window.scrollBy({ top: lift, behavior: 'auto' });
    return;
  }
  const desiredTop = card.getBoundingClientRect().bottom + gap;
  const delta = target.getBoundingClientRect().top - desiredTop;
  if (Math.abs(delta) > 2) window.scrollBy({ top: delta, behavior: 'auto' });

  // If the target's *top* is still tucked under the card, the upward scroll was
  // clamped at the page top — flip the card to the bottom and lift the target up.
  // (A tall section whose top now sits just below the card is fine; only a
  // genuinely-covered top triggers the flip, not a target taller than the viewport.)
  const t = target.getBoundingClientRect();
  const c = card.getBoundingClientRect();
  if (t.top < c.bottom - 8 && t.bottom > c.top) {
    card.classList.add('wizard-card-bottom');
    const lift = target.getBoundingClientRect().top - gap;
    if (Math.abs(lift) > 2) window.scrollBy({ top: lift, behavior: 'auto' });
  }
}

// Watch the document for layout changes (async sections rendering in) and
// re-position the target each time, until the next step tears down or a ~2.5s
// budget elapses — enough for the heaviest profile page to finish, without an
// observer that lingers and fights the user afterward.
function observeReflow(card, target, token) {
  if (typeof ResizeObserver === 'undefined') return;
  const start = Date.now();
  reflowObserver = new ResizeObserver(() => {
    if (token !== renderToken) return; // superseded — teardown will disconnect
    positionTarget(card, target);
    if (Date.now() - start > 2500 && reflowObserver) {
      reflowObserver.disconnect();
      reflowObserver = null;
    }
  });
  reflowObserver.observe(document.documentElement);
}

// Card contents. Intro steps show one primary button (step.button); highlight
// steps show the step counter and Back / Skip tour / Next (Finish on the last).
function cardInner(step) {
  if (isIntroStep(step)) {
    return `
      <h3 class="wizard-tooltip-title">${esc(step.title)}</h3>
      <div class="wizard-tooltip-body wizard-scroll">${esc(step.body)}</div>
      <div class="wizard-tooltip-actions">
        <button type="button" class="btn btn-primary btn-sm" data-act="next">${esc(step.button || 'Next')}</button>
      </div>`;
  }
  const n = HIGHLIGHT_STEPS.indexOf(step) + 1;
  const total = HIGHLIGHT_STEPS.length;
  const isLast = getWizardStepIndex() === WIZARD_STEPS.length - 1;
  return `
    <div class="wizard-step-count">Step ${n} of ${total}</div>
    <h3 class="wizard-tooltip-title">${esc(step.title)}</h3>
    <div class="wizard-tooltip-body wizard-scroll">${esc(step.body)}</div>
    <div class="wizard-tooltip-actions">
      <button type="button" class="btn btn-sm" data-act="back">Back</button>
      <button type="button" class="btn btn-sm" data-act="skip">Skip tour</button>
      <button type="button" class="btn btn-primary btn-sm" data-act="next">${isLast ? 'Finish' : 'Next'}</button>
    </div>`;
}

function wireCardButtons(card) {
  card.querySelector('[data-act="back"]')?.addEventListener('click', goBack);
  card.querySelector('[data-act="skip"]')?.addEventListener('click', skip);
  card.querySelector('[data-act="next"]')?.addEventListener('click', goNext);
}

// Bumped on every runWizardStep()/teardown() so a pending target poll from a
// superseded step bails instead of mounting a stale, duplicate card.
let renderToken = 0;

// app.js's shared boot() runs runWizardStep() synchronously, but each page
// renders its own content asynchronously (repo reads → innerHTML), so a step's
// target often isn't in the DOM yet on the first tick. Poll briefly for it
// before falling back to the centered non-spotlit card (§4.3), so the fallback
// is reserved for genuinely-absent targets, not slow renders.
function waitForTarget(step, overlay, token, attempt) {
  if (token !== renderToken) return; // superseded by a newer step/teardown
  revealTarget(step); // open a collapsed card once it exists
  const target = document.querySelector(step.selector);
  if (target) {
    target.classList.add('wizard-spotlight-target');
    spotlightEl = target;
    requestAnimationFrame(() => { if (token === renderToken) mountTopCard(step, target); });
    return;
  }
  if (attempt >= 40) { // ~2s, then fall back to a centered, dimmed card
    overlay.classList.add('wizard-overlay-dim');
    mountCenteredCard(step);
    return;
  }
  setTimeout(() => waitForTarget(step, overlay, token, attempt + 1), 50);
}

function renderResumePill(step) {
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'wizard-resume-pill';
  pill.textContent = '🧭 Resume tour →';
  pill.addEventListener('click', () => goToStep(step));
  document.body.appendChild(pill);
  mountedNodes.push(pill);
}

// The per-page hook: app.js's shared boot() calls this unconditionally on every
// page load (§7). No page file imports anything wizard-related.
export function runWizardStep() {
  teardown();
  if (!isTourAvailable()) return;
  if (getWizardStatus() !== 'active') return;
  const step = currentStep();
  if (!step) return;

  // Intro cards (tour-intro / hub-intro) render centered wherever the user is.
  if (isIntroStep(step)) {
    mountOverlay(true);
    mountCenteredCard(step);
    return;
  }
  // Highlight steps live on a page; if the user has wandered off it, offer the
  // resume pill instead of fighting their navigation.
  if (!isOnStepPage(step)) {
    renderResumePill(step);
    return;
  }
  const overlay = mountOverlay(false);
  waitForTarget(step, overlay, renderToken, 0);
}
