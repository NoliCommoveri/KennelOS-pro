// upgradeNudge.js — the shared "you've hit the Lite limit" upgrade nudge
// (KennelOS_Lite_Cap_Enforcement_Spec.md §6). The repos hard-throw a
// CapExceededError (a repo can't prompt); the dog / litter / puppy forms catch
// it and call renderUpgradeNudge() to show a friendly upgrade prompt — never a
// raw error — with the "Upgrade to Pro →" CTA wired to the Lite→Pro bridge
// (editions plan §"Converting Lite → Pro").
//
// This is shared code, so it must stay edition-agnostic. The one CTA click runs
// the shared bridge (runUpgradeBridge in editionLinks.js) — cloud first when the
// backup holds everything, else the JSON backup export, then checkout — so this
// nudge and Lite's standing "Upgrade to Pro →" links run the identical sequence.
import { esc } from './ui.js';
import { runUpgradeBridge } from './editionLinks.js';

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
    cta.textContent = 'Getting your records ready…';
    try {
      // The bridge either confirms the cloud backup holds everything (sign in on
      // Pro to restore) or exports the owner's data into Downloads, then heads to
      // checkout. If no checkout URL is configured yet it returns 'cloud' /
      // 'exported' — leave them with a plain instruction.
      const result = await runUpgradeBridge();
      const detail = container.querySelector('.upgrade-nudge-detail');
      if (result === 'exported') {
        cta.textContent = 'Backup exported ✓';
        detail.textContent = 'Backup exported. Continue to Pro and import this file to finish upgrading.';
      } else if (result === 'cloud') {
        cta.textContent = 'Backed up ✓';
        detail.textContent = 'Everything is backed up. Open KennelOS Pro and sign in with the same email to restore.';
      } else if (result === 'cancelled') {
        cta.disabled = false;
        cta.textContent = 'Upgrade to Pro →';
      }
    } catch (e) {
      // If the export somehow fails we still don't want to strand them mid-flow;
      // surface it and let them retry rather than silently sending them to buy.
      cta.disabled = false;
      cta.textContent = 'Upgrade to Pro →';
      container.querySelector('.upgrade-nudge-detail').textContent =
        `Couldn't export your backup (${e.message || e}). Try again before upgrading.`;
    }
  });
}
