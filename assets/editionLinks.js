// editionLinks.js — Lite's standing outbound links to the Demo and Pro editions.
//
// The editions plan (§"In-Lite links to Demo and Pro") makes Lite the hub that
// links straight out to the other two editions — no email step, just plain
// cross-origin anchors:
//   • "See the full app ↗"  → the Demo origin (a working, seeded showcase).
//   • "Upgrade to Pro →"     → the export-first bridge (§"Converting Lite → Pro"):
//     trigger the JSON backup export, THEN head to checkout (which redirects into
//     Pro post-purchase to import it). This is the SAME action the cap upgrade
//     nudge runs, so both go through runUpgradeBridge() below (one source of truth
//     for the sequence). An owner whose cloud backup holds everything (Sensitive
//     records on and unlocked) skips the file: they sign in on Pro and restore,
//     with "Save a backup file too" as the secondary button.
//
// These render in two spots (decided): the nav "More" menu (every page) and a
// footer on Today. Both are driven entirely by demoUrl / upgradeUrl from
// editionConfig, which are null in Pro/Demo — so hasEditionLinks() is false there
// and nothing renders. This keeps the module edition-agnostic like the rest of
// shared/, with the Lite-only URLs living in Lite's editionConfig overlay.
import { esc, alertModal } from './ui.js';
import { demoUrl, upgradeUrl } from '../data/editionConfig.js';

// True only when this edition exposes at least one outbound link (i.e. Lite).
// Pro/Demo leave both URLs null, so their nav/footer render nothing.
export function hasEditionLinks() {
  return Boolean(demoUrl || upgradeUrl);
}

// Run the Lite→Pro bridge (Editions Plan, "Converting Lite → Pro"). Two paths:
//   • Cloud first: this device is signed in to cloud backup with Sensitive records
//     (the private vault) on and unlocked, and both are up to date after a last
//     push. Signing in on Pro and unlocking brings everything back, so no file is
//     needed; a dialog says so, with "Save a backup file too" as the secondary
//     button (the file is the fallback, not the main path).
//   • File first: anything else (no cloud, backup off or paused, Sensitive records
//     off or locked, offline). Export the backup to Downloads, THEN go to
//     checkout; a signed-in owner is also told about sign-in-and-restore.
// The import/export and cloud modules are lazy-imported so this module, pulled
// into the nav on every page, loads nothing until the button is clicked. Throws
// if the export fails (caller surfaces it). Returns 'redirecting' (the page is
// heading to checkout), 'cancelled' (the owner chose Not now), or, when no
// checkout URL is configured, 'exported' / 'cloud' so the caller can show a
// "continue in Pro" fallback.
export async function runUpgradeBridge() {
  const cloud = await cloudUpgradeReadiness();
  if (cloud?.complete) {
    const choice = await cloudUpgradeDialog(cloud);
    if (choice === 'cancel') return 'cancelled';
    return goToCheckout('cloud');
  }
  const { downloadBackup } = await import('../data/importExport.js');
  await downloadBackup();
  if (cloud) await fileUpgradeNote(cloud);
  return goToCheckout('exported');
}

function goToCheckout(fallback) {
  if (upgradeUrl) {
    window.location.assign(upgradeUrl);
    return 'redirecting';
  }
  return fallback;
}

// null when this edition has no server or the device isn't signed in; else
// { email, complete }. Pro restores the latest backup, so bring it up to date
// first. A paused backup (another device, a shrink warning, locked Sensitive
// records) is left for the owner to resolve, and the file path covers it. Any
// failure here (offline, an expired session) just means "not complete".
async function cloudUpgradeReadiness() {
  const { isCloudAvailable } = await import('../data/cloud/cloudConfig.js');
  if (!isCloudAvailable()) return null;
  const { currentAccount } = await import('../data/cloud/cloudAuth.js');
  const account = currentAccount();
  if (!account?.signedIn) return null;
  const email = account.email || 'your email';
  try {
    const { getBackupStatus, pushIfDirty, holdsEverything } = await import('../data/cloud/cloudBackup.js');
    let status = getBackupStatus();
    if (status.enabled && status.dirty && !status.paused) {
      try { await pushIfDirty({ force: true }); } catch { /* checked below */ }
      status = getBackupStatus();
    }
    if (!status.enabled || status.paused || status.dirty) return { email, complete: false };
    const { vaultStatus } = await import('../data/cloud/cloudVault.js');
    const vault = await vaultStatus();
    return { email, complete: holdsEverything(getBackupStatus(), vault) };
  } catch {
    return { email, complete: false };
  }
}

// Cloud first: Continue to Pro (primary), Save a backup file too (secondary;
// downloads and stays open), Not now. Resolves 'continue' | 'cancel'. The
// backdrop does nothing, so a stray tap neither buys nor cancels.
// It also makes a one-hour unlock code (Private Vault Plan §5.4) for Pro's
// "Use another device", shown with Copy and copied again on Continue, since
// checkout replaces this page. Without a code (offline, an error) Pro still
// unlocks with the passkey or recovery code, and the dialog says so.
function cloudUpgradeDialog({ email }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <h2 style="margin-top:0;">Switch Products Seamlessly</h2>
      <p class="muted" style="white-space:pre-wrap;">${esc(
        `Since you're using cloud backup, switching is easy! Once you've purchased your Pro license, select "I already use KennelOS" and log in using the email ${email}.\n\n`
        + `Use the same email (${email}) when you buy Pro, so your Pro features online are ready right away.`)}</p>
      <div class="upgrade-handoff"><p class="muted">Making your unlock code…</p></div>
      <p class="muted">Optionally, you can also save a backup file below before switching.</p>
      <p class="muted upgrade-file-note" role="status" hidden></p>
      <div class="form-actions">
        <button class="btn btn-primary" id="ug-continue">Continue to Pro</button>
        <button class="btn" id="ug-file">Save a backup file too</button>
        <button class="btn" id="ug-cancel">Not now</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    const done = (val) => { overlay.remove(); resolve(val); };
    let handoff = null; // { code, copy }
    const slot = overlay.querySelector('.upgrade-handoff');
    (async () => {
      try {
        const [{ createHandoffCode }, ui] = await Promise.all([
          import('../data/cloud/cloudVault.js'), import('./cloudVaultUI.js')
        ]);
        const { code } = await createHandoffCode();
        handoff = { code, copy: ui.copyHandoffCode };
        slot.innerHTML = `<p class="muted">When Pro asks you to unlock your sensitive records, choose "Use another device" and paste this code. It works once, for 1 hour:</p>
          ${ui.handoffCodeHtml(code)}`;
        ui.wireHandoffCopy(slot, code);
      } catch {
        slot.innerHTML = `<p class="muted">When Pro asks you to unlock your sensitive records, use your passkey or recovery code.</p>`;
      }
    })();
    const fileBtn = overlay.querySelector('#ug-file');
    const fileNote = overlay.querySelector('.upgrade-file-note');
    fileBtn.addEventListener('click', async () => {
      fileBtn.disabled = true;
      fileBtn.textContent = 'Saving…';
      try {
        const { downloadBackup } = await import('../data/importExport.js');
        await downloadBackup();
        fileBtn.textContent = 'Backup file saved ✓';
      } catch (e) {
        fileBtn.disabled = false;
        fileBtn.textContent = 'Save a backup file too';
        fileNote.hidden = false;
        fileNote.textContent = `Couldn't save the file (${e.message || e}). Your cloud backup still has everything.`;
      }
    });
    overlay.querySelector('#ug-continue').addEventListener('click', async () => {
      if (handoff) await handoff.copy(handoff.code); // on the clipboard for Pro
      done('continue');
    });
    overlay.querySelector('#ug-cancel').addEventListener('click', () => done('cancel'));
  });
}

// File first, for a signed-in owner whose cloud backup can't carry everything
// (Sensitive records off or locked here, backup off or paused, offline): the
// file is the complete path, and sign-in-and-restore is the easier way in for
// what cloud backup does hold.
async function fileUpgradeNote({ email }) {
  await alertModal({
    title: 'Your backup file is downloading',
    message: `You also use cloud backup (${email}), so there's an easier way in.\n\n`
      + `Use the same email (${email}) when you buy Pro, so your Pro features online are ready right away.\n\n`
      + `After you buy Pro, open KennelOS Pro, choose "I already use KennelOS → sign in and restore", and sign in with the same email. Your dogs, litters, pairings, health records and contact names come straight back.\n\n`
      + `Then, in Pro, go to Import / Export, choose this file and "Merge into current data" to add what cloud backup doesn't hold: prices and payments, Financials, contacts' phone, email and address, and your notes.\n\n`
      + `Tip: with Sensitive records on and unlocked (Import / Export → Cloud), cloud backup holds those too, and you won't need the file.`,
    okLabel: 'Continue to Pro'
  });
}

// HTML for the two links. `variant` only changes presentation:
//   'nav'    — items styled as entries inside the nav "More" dropdown.
//   'footer' — a labelled block (native .btn styling) for the foot of Today.
// The Upgrade CTA is always a <button> (it must run JS before navigating); the
// Demo link is a plain external anchor (new tab, so Lite isn't lost). A hidden
// note paragraph carries any error / "backup saved" fallback message.
export function editionLinksHtml({ variant = 'nav' } = {}) {
  const note = `<p class="edition-links-note" role="status" hidden></p>`;

  if (variant === 'footer') {
    const demo = demoUrl
      ? `<a class="btn edition-link edition-link-demo" href="${esc(demoUrl)}" target="_blank" rel="noopener">See the full app ↗</a>`
      : '';
    const upgrade = upgradeUrl
      ? `<button type="button" class="btn btn-primary edition-link edition-link-upgrade">Upgrade to Pro →</button>`
      : '';
    return `<div class="edition-links edition-links-footer">
        <p class="edition-links-lead">Want the full app — unlimited dogs and litters, plus every Pro feature?</p>
        <div class="edition-links-row">${demo}${upgrade}</div>
        ${note}
      </div>`;
  }

  // nav: menu items inside the More dropdown (reuse .nav-link for the menu look).
  const demo = demoUrl
    ? `<a class="nav-link edition-link edition-link-demo" href="${esc(demoUrl)}" target="_blank" rel="noopener">See the full app ↗</a>`
    : '';
  const upgrade = upgradeUrl
    ? `<button type="button" class="nav-link edition-link edition-link-upgrade">Upgrade to Pro →</button>`
    : '';
  return `<div class="edition-links edition-links-nav">${demo}${upgrade}${note}</div>`;
}

// Wire the Upgrade button(s) within `scope` to the bridge. Idempotent per element
// (guards against double-wiring when a container is re-rendered). A no-op when
// there's no button (Pro/Demo, or a Demo-only future variant).
export function wireEditionLinks(scope) {
  if (!scope) return;
  scope.querySelectorAll('.edition-link-upgrade').forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => onUpgradeClick(btn));
  });
}

async function onUpgradeClick(btn) {
  const note = btn.closest('.edition-links')?.querySelector('.edition-links-note');
  const original = btn.textContent;
  const setNote = (msg) => { if (note) { note.hidden = false; note.textContent = msg; } };
  btn.disabled = true;
  btn.textContent = 'Getting your records ready…';
  if (note) { note.hidden = true; note.textContent = ''; }
  try {
    const result = await runUpgradeBridge();
    // 'redirecting' → the page is navigating to checkout; leave the button as-is.
    if (result === 'exported') {
      btn.textContent = 'Backup exported ✓';
      setNote('Backup saved. Continue to Pro and import this file to finish upgrading.');
    } else if (result === 'cloud') {
      btn.textContent = 'Backed up ✓';
      setNote('Everything is backed up. Open KennelOS Pro and sign in with the same email to restore.');
    } else if (result === 'cancelled') {
      btn.disabled = false;
      btn.textContent = original;
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    setNote(`Couldn't export your backup (${e.message || e}). Try again before upgrading.`);
  }
}
