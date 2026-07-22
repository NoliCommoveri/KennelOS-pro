// upgradeNudge.js — the shared "you've hit the Lite limit" upgrade nudge
// (KennelOS_Lite_Cap_Enforcement_Spec.md §6). The repos hard-throw a
// CapExceededError (a repo can't prompt); the dog / litter / puppy forms catch
// it and call renderUpgradeNudge() to show a friendly upgrade prompt — never a
// raw error — with the "Upgrade to Pro →" CTA wired to the export→checkout→
// import bridge (editions plan §"Converting Lite → Pro").
//
// This is shared code, so it must stay edition-agnostic: it reads the upgrade
// target from editionConfig (null in Pro/Demo, where this nudge never renders
// anyway because their cap hooks are no-ops). The one CTA click runs the real
// first step of the bridge — trigger the existing JSON backup export — before
// sending the owner to checkout, so their data is in Downloads before they leave.
import { esc } from './ui.js';
import { upgradeUrl } from '../data/editionConfig.js';
import { downloadBackup } from '../data/importExport.js';

// Human wording per the CapExceededError's kind + the caller's context.
//   err.kind === 'dogs'    → context 'create' (adding an adult) | 'mature' (a kept
//                            puppy growing up); the escape is departing a dog.
//   err.kind === 'litters' → recording another litter; no per-dog escape.
function nudgeText(err, context) {
  const { limit } = err;
  if (err.kind === 'litters') {
    return {
      title: `You're at your Lite limit of ${limit} litters.`,
      body: 'To record another litter, upgrade to Pro. Your existing litters stay editable.',
    };
  }
  // dogs
  const action = context === 'mature'
    ? 'To mark this pup grown'
    : 'To add another dog';
  return {
    title: `You're at your Lite limit of ${limit} adult dogs.`,
    body: `${action}, upgrade to Pro — or remove a dog you no longer keep from your program to free a slot.`,
  };
}

// Render the upgrade nudge into `container` (typically a form's inline message
// slot). `err` is the caught CapExceededError; `context` is 'create' | 'mature'
// (dogs only). Returns nothing — it owns the container's contents.
export function renderUpgradeNudge(container, err, context = 'create') {
  const { title, body } = nudgeText(err, context);
  container.innerHTML = `
    <div class="upgrade-nudge" role="alert">
      <div class="upgrade-nudge-body">
        <strong>${esc(title)}</strong>
        <div class="upgrade-nudge-detail">${esc(body)}</div>
      </div>
      <button type="button" class="btn btn-primary btn-sm" id="upgrade-cta">Upgrade to Pro →</button>
    </div>`;

  const cta = container.querySelector('#upgrade-cta');
  cta.addEventListener('click', async () => {
    cta.disabled = true;
    cta.textContent = 'Exporting your backup…';
    try {
      // Step 1 of the bridge: get the owner's data into Downloads before they go.
      await downloadBackup();
    } catch (e) {
      // If the export somehow fails we still don't want to strand them mid-flow;
      // surface it and let them retry rather than silently sending them to buy.
      cta.disabled = false;
      cta.textContent = 'Upgrade to Pro →';
      container.querySelector('.upgrade-nudge-detail').textContent =
        `Couldn't export your backup (${e.message || e}). Try again before upgrading.`;
      return;
    }
    // Step 2: off to checkout (which redirects into Pro post-purchase, where the
    // owner imports the backup they just downloaded). No URL configured yet →
    // leave them on the export they just got, with a plain instruction.
    if (upgradeUrl) {
      window.location.assign(upgradeUrl);
    } else {
      cta.textContent = 'Backup exported ✓';
      container.querySelector('.upgrade-nudge-detail').textContent =
        'Backup exported. Continue to Pro and import this file to finish upgrading.';
    }
  });
}
