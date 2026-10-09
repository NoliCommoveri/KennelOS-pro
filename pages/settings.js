// settings.js — the Settings page: the cloud Account, your kennel, the guided tour,
// and this device's license. Backups, CSV import and Reset App are on Import/Export
// (pages/import-export.js).
import { downloadBackup } from '../data/importExport.js';
import { getLastBackupDate, getProLicense } from '../data/settings.js';
import { isLicenseGated, releaseThisDevice } from '../data/license.js';
import { hasMyKennelSetup, getMyKennelName } from '../data/kennelSetup.js';
import { showKennelSetupModal } from '../assets/kennelSetupUI.js';
import { isTourAvailable, restartWizard } from '../data/wizardState.js';
import { runWizardStep } from '../assets/wizardUI.js';
import { esc } from '../assets/ui.js';
import { isCloudAvailable } from '../data/cloud/cloudConfig.js';

// Loaded only when this edition has a server (`cloudUrl` set), so an edition
// without one never even loads the cloud modules (plan §7).
const cloudUI = isCloudAvailable() ? await import('../assets/cloudBackupUI.js') : null;

const msg = document.getElementById('page-msg');
function flash(text, kind = 'ok') {
  msg.innerHTML = `<div class="${kind === 'ok' ? 'inline-warn' : 'inline-error'}" style="${kind === 'ok' ? 'color:var(--accent-dark);background:var(--accent-soft);border-color:#bfe0cd;' : ''}">${esc(text)}</div>`;
  msg.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// --- Account (the cloud sign-in) -------------------------------------------------
if (cloudUI) cloudUI.mountCloudAccountCard(document.getElementById('account-section'));
else document.getElementById('account-section')?.remove();

// Guided tour — the tour anchors to specific sample records, so it's only
// offerable while the "Thornfield Kennels" sample data is loaded (same gate as
// the nav "more" menu's tour entry). The button restarts it from the top; the
// opening card is a page-agnostic intro, so it just appears right here.
function renderTourStatus() {
  const status = document.getElementById('tour-status');
  const btn = document.getElementById('btn-tour');
  if (isTourAvailable()) {
    status.textContent = 'Walk through KennelOS’s major features using the sample data. Starts from the beginning.';
    btn.style.display = '';
  } else {
    status.textContent = 'Available only while the “Thornfield Kennels” sample data is loaded.';
    btn.style.display = 'none';
  }
}

document.getElementById('btn-tour').addEventListener('click', () => {
  restartWizard();
  runWizardStep();
});

renderTourStatus();

async function renderKennelSetupStatus() {
  const status = document.getElementById('kennel-setup-status');
  const btn = document.getElementById('btn-kennel-setup');
  const name = hasMyKennelSetup() ? await getMyKennelName() : null;
  status.textContent = name
    ? `Your kennel is set to "${name}".`
    : 'Not set up yet — dogs won’t prefill an owner until this is done.';
  btn.textContent = name ? 'Change kennel / owner' : 'Set up your kennel';
}

document.getElementById('btn-kennel-setup').addEventListener('click', () => {
  // Cancellable, not required: this is a deliberate reopen to EDIT an existing
  // kennel, not the first-run gate (Multi-Kennel Scope Spec §3.2.2).
  showKennelSetupModal({ mode: 'cancellable' });
});

renderKennelSetupStatus();

// --- This device's license (Pro only) ---------------------------------------
// The proactive way to hand this browser's activation slot back, so an owner who
// is about to clear their browser or replace a laptop doesn't burn a slot they
// can never recover. Hidden entirely unless the license gate is on (Pro), so Lite
// keeps rendering exactly as it did.

const licenseSection = document.getElementById('license-section');
const licenseReleaseBtn = document.getElementById('btn-license-release');

function renderLicenseSection() {
  if (!isLicenseGated()) return; // Lite/Demo: section stays hidden.
  licenseSection.hidden = false;
  const record = getProLicense();
  const status = document.getElementById('license-device-status');
  if (!record) {
    status.textContent = 'This device is not activated.';
    licenseReleaseBtn.disabled = true;
    return;
  }
  const name = record.instanceName ? `“${record.instanceName}”` : 'this browser';
  status.textContent = `Activated on this device as ${name}.`;
}

// Releasing is the one action here that takes away the ability to *reach* data
// while leaving the data in place: the moment the slot goes back, every page
// including this one shows the activation wall, so Export is behind the wall too.
// The records are still in IndexedDB, but getting at them means re-activating —
// which is exactly what an owner who released their last slot may not be able to
// do. So the confirmation isn't a yes/no: it puts the backup one click away,
// right here, before the door closes.
function showReleaseModal() {
  const iso = getLastBackupDate();
  const last = iso
    ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : 'Never';
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="max-width:460px;">
      <h2 style="margin-top:0;">Release this device?</h2>
      <p class="muted">The license slot goes back so another device can use it. Your records are
        <strong>not deleted</strong> — they stay in this browser exactly as they are.</p>
      <p class="muted"><strong>Export a backup first.</strong> Once this device is released, Pro asks for a
        key here again — and that includes the Import/Export page, so you won't be able to download a
        backup until you re-activate. If you released this slot to free it for another device, that may
        not be something you can undo today.</p>
      <p class="muted">Last backup: <strong id="release-last-backup">${esc(last)}</strong></p>
      <div id="release-error"></div>
      <div class="form-actions">
        <button class="btn btn-primary" id="release-backup-btn">⬇️ Download a backup</button>
        <button class="btn" id="release-confirm-btn">Release this device</button>
        <button class="btn" data-act="cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const errorBox = overlay.querySelector('#release-error');
  const backupBtn = overlay.querySelector('#release-backup-btn');

  backupBtn.addEventListener('click', async () => {
    errorBox.innerHTML = '';
    backupBtn.disabled = true;
    backupBtn.textContent = 'Preparing…';
    try {
      await downloadBackup();
      overlay.querySelector('#release-last-backup').textContent = 'just now';
      backupBtn.textContent = '✅ Backup downloaded';
    } catch (e) {
      backupBtn.disabled = false;
      backupBtn.textContent = '⬇️ Download a backup';
      errorBox.innerHTML = `<div class="inline-error">${esc(e.message || String(e))}</div>`;
    }
  });

  return new Promise((resolve) => {
    const done = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('#release-confirm-btn').addEventListener('click', () => done(true));
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => done(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
  });
}

licenseReleaseBtn.addEventListener('click', async () => {
  if (!(await showReleaseModal())) return;
  licenseReleaseBtn.disabled = true;
  licenseReleaseBtn.textContent = 'Releasing…';
  // Only reload once the slot is genuinely back: releaseThisDevice() leaves the
  // activation untouched on failure, so the owner still has Pro here and can
  // retry rather than losing both the device and the slot.
  if (await releaseThisDevice()) {
    flash('This device has been released. Reloading…');
    setTimeout(() => location.reload(), 900);
    return;
  }
  licenseReleaseBtn.disabled = false;
  licenseReleaseBtn.textContent = 'Release this device…';
  flash("Couldn't reach the licensing server, so this device still holds its slot and stays activated. Check your connection and try again.", 'err');
});

renderLicenseSection();
