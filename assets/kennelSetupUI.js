// kennelSetupUI.js — the kennel/owner setup modal and its nav-banner name.
// Shared by app.js (every page) and pages/import-export.js ("Set up your
// kennel" — the same reachable-any-time-from-Settings pattern as Clear Sample
// Data, since there's still no dedicated Settings page).
import {
  shouldRequireKennelSetup, completeKennelSetup, getMyKennelName,
  getKennelSetupState
} from '../data/kennelSetup.js';
import { fetchBundledSeedGroups, applySeedToKennel } from '../data/seedImport.js';
import { esc } from './ui.js';
import { renderBreedPicker } from './breedTestPicker.js';

// The mandatory first-run gate (Multi-Kennel Scope Spec §3.2), called from
// app.js's boot on every page. Async because the gate's condition is a db read
// ("does an own kennel exist"), unlike the old settings-only skip check.
export async function maybeShowKennelSetupPrompt() {
  if (!(await shouldRequireKennelSetup())) return;
  showKennelSetupModal({ mode: 'required' });
}

// Two postures (spec §3.2.2):
//   'required'    — no Skip, no Cancel, no backdrop close, no Escape. The only
//                   way out is saving a kennel. Used by all three first-run call
//                   sites; the app is unusable without a kennel to stamp dogs into.
//   'cancellable' — a Cancel that closes and changes nothing. Used only by
//                   Import/Export's deliberate reopen, which EDITS an existing
//                   kennel and so must stay dismissible.
// There is no 'skippable' any more — the skip flag it wrote is gone (§3.2.1).
//
// Reopening when a kennel/contact already exists prefills and UPDATES those
// same records (see completeKennelSetup) rather than creating duplicates.
// A successful save reloads the page — the nav banner and every dog-form
// owner picker need the fresh kennel/contact, same as the sample-data flow
// reloads after seeding. onDone(false) only fires on cancel, where nothing
// changed and a reload would be pointless.
export async function showKennelSetupModal({ mode = 'required', onDone } = {}) {
  const required = mode !== 'cancellable';
  const initial = await getKennelSetupState();

  // The optional breed+test prefill (Test Planning Addendum §8–9). Populated
  // async from the bundled starter file after the modal is on screen; if the
  // file can't be reached the section stays hidden and setup is unchanged.
  let seedGroups = [];
  const selectedBreeds = new Set();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="max-width:460px;">
      <h2 style="margin-top:0;">🏡 Set up your kennel</h2>
      <p class="muted">${required
        ? 'Every dog you add belongs to a kennel, so KennelOS needs yours before you start. This also names it in the header and lets new dogs prefill their owner automatically.'
        : 'This names your kennel in the header and lets new dogs prefill their owner automatically.'}</p>
      <div class="form-grid">
        <div class="field field-wide"><label>Kennel name <span class="req">*</span></label>
          <input id="ks-kennel" type="text" placeholder="e.g. Thornfield Kennels" value="${esc(initial.kennelName)}"></div>
        <div class="field field-wide"><label>Your name (as owner)</label>
          <input id="ks-owner" type="text" placeholder="Used to prefill Owner on dogs you own" value="${esc(initial.ownerName)}"></div>
      </div>
      <div id="ks-seed"></div>
      <div id="ks-error"></div>
      <div class="form-actions">
        <button class="btn btn-primary" data-act="save">Save</button>
        ${required ? '' : '<button class="btn" data-act="cancel">Cancel</button>'}
      </div>
    </div>`;
  document.body.appendChild(overlay);

  // Fill the prefill section once the bundled file loads. Breeds default to
  // UNCHECKED — this is an opt-in "I want help" gesture, matching the app's
  // "empty until authored or imported" posture. Picking a breed here seeds its
  // common tests into the kennel checklist and its name into breed autocomplete.
  fetchBundledSeedGroups().then((groups) => {
    seedGroups = groups;
    const host = overlay.querySelector('#ks-seed');
    if (!host || !groups.length) return;
    host.innerHTML = `
      <div style="border-top:1px solid var(--border); margin-top:12px; padding-top:12px;">
        <label style="font-weight:600;">Prefill common health tests <span class="faint" style="font-weight:normal;">— optional</span></label>
        <p class="field-hint" style="margin:4px 0 8px;">Search for the breed(s) you work with, or browse by breed group, to seed their commonly-cited tests into your kennel checklist (prunable later). Illustrative starter, not veterinary guidance — verify against your breed's OFA CHIC / parent-club requirements.</p>
        <div id="ks-breed-picker"></div>
      </div>`;
    renderBreedPicker(host.querySelector('#ks-breed-picker'), groups, selectedBreeds);
  });

  const errorBox = overlay.querySelector('#ks-error');
  overlay.querySelector('[data-act="save"]').addEventListener('click', async () => {
    const kennelName = overlay.querySelector('#ks-kennel').value.trim();
    const ownerName = overlay.querySelector('#ks-owner').value.trim();
    if (!kennelName) {
      errorBox.innerHTML = `<div class="inline-error">Kennel name is required.</div>`;
      return;
    }
    try {
      const { kennel } = await completeKennelSetup({ kennelName, ownerName });
      if (selectedBreeds.size) await applySeedToKennel(kennel.id, seedGroups, selectedBreeds);
      location.reload();
    } catch (e) {
      errorBox.innerHTML = `<div class="inline-error">${esc(e.message || String(e))}</div>`;
    }
  });
  if (required) {
    // No dismiss control at all, and neither of the two ambient escapes the app's
    // other modals honour: a backdrop click and Escape both close `.modal-overlay`
    // elsewhere, so both are swallowed here in the capture phase before any of
    // that can run. The only exit is saving a kennel.
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) e.stopPropagation();
    }, true);
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); }
    }, true);
    return;
  }

  overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => {
    overlay.remove();
    onDone?.(false);
  });
}

// Appends " — <kennel name>" to the nav brand, once looked up. No-op if no
// kennel has been set up yet.
export async function renderKennelBanner() {
  const name = await getMyKennelName();
  if (!name) return;
  const brand = document.querySelector('.nav-brand');
  if (!brand) return;
  const span = document.createElement('span');
  span.className = 'nav-kennel';
  span.textContent = `— ${name}`;
  brand.appendChild(span);
}
