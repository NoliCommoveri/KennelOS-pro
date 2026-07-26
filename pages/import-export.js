// import-export.js — wires the Import/Export page to the backup engine.
import { downloadBackup, readBackupFile, inspectBackup, restoreBackup } from '../data/importExport.js';
import { getLastBackupDate, getProLicense } from '../data/settings.js';
import { isLicenseGated, releaseThisDevice } from '../data/license.js';
import { hasMyKennelSetup, getMyKennelName } from '../data/kennelSetup.js';
import { showKennelSetupModal } from '../assets/kennelSetupUI.js';
import { getResetCounts, resetApp } from '../data/appReset.js';
import { isTourAvailable, restartWizard } from '../data/wizardState.js';
import { runWizardStep } from '../assets/wizardUI.js';
import { esc, confirmModal } from '../assets/ui.js';
import { editionFlags, edition } from '../data/editionConfig.js';
import { isProOnlyPage } from '../data/proPages.js';
import { isDropboxConnected } from '../data/dropbox.js';
import { mountDropboxConnect, dropboxRequiredNotice } from '../assets/dropboxConnectUI.js';
import { pushToDropbox, fetchDropboxBackup } from '../data/assistantSync.js';

const msg = document.getElementById('page-msg');
function flash(text, kind = 'ok') {
  msg.innerHTML = `<div class="${kind === 'ok' ? 'inline-warn' : 'inline-error'}" style="${kind === 'ok' ? 'color:var(--accent-dark);background:var(--accent-soft);border-color:#bfe0cd;' : ''}">${esc(text)}</div>`;
  msg.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderLastBackup() {
  const iso = getLastBackupDate();
  const el = document.getElementById('last-backup');
  el.textContent = iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Never';
}

// --- Backup & restore -------------------------------------------------------
// Two INDEPENDENT axes: what you're doing (back up / restore — the seg-tabs) and
// where it goes (this device / Dropbox — chosen per run). They compose freely,
// which is the whole point: a Dropbox push IS a backup (same exportAll(), same
// lastBackupDate stamp) and a Dropbox pull IS a restore (same restoreBackup()
// engine), so they belong on the same control rather than in a parallel card.
//
// The payoff is the restore path: BOTH sources land in showRestorePreview(), so
// a Dropbox pull now gets the same dry-run table and the same Merge/Replace
// choice a file gets — previously it went straight to a bare confirm and could
// only merge.

const dropboxEnabled = editionFlags.assistant;
const fileInput = document.getElementById('restore-file');
const fetchBtn = document.getElementById('btn-dbx-fetch');
const backupBtn = document.getElementById('btn-backup');
const preview = document.getElementById('restore-preview');
const destWarn = document.getElementById('dest-warn');
let pendingBackup = null;
let mode = 'backup';   // 'backup' | 'restore'
let dest = 'local';    // 'local'  | 'dropbox'

const BLURBS = {
  'backup:local': 'Downloads every record as one JSON file — also the migration path if the app ever moves to a new web address (your data doesn’t follow automatically).',
  'backup:dropbox': 'Uploads a full backup to your own Dropbox, and refreshes what KennelAssistant sees. Pull it on your other phone to catch up.',
  'restore:local': 'Load records from a backup file. Merge adds/updates by id and keeps everything else; Replace wipes current records first.',
  'restore:dropbox': 'Load the backup last pushed to Dropbox — from this phone or another one. Merge adds/updates by id and keeps everything else; Replace wipes current records first.'
};

// Drop a preview without touching the file input — the change handler runs this
// before reading `files[0]`, so clearing the input here would wipe the very
// selection it is about to read.
function clearPending() {
  pendingBackup = null;
  preview.innerHTML = '';
}

// Switching either axis invalidates a preview built from the other source, and
// also forgets the chosen file so the input doesn't show a stale name.
function resetRestoreInput() {
  clearPending();
  fileInput.value = '';
}

function renderBackupRestore() {
  const needsConnect = dest === 'dropbox' && !isDropboxConnected();

  document.getElementById('br-backup').hidden = mode !== 'backup';
  document.getElementById('br-restore').hidden = mode !== 'restore';
  document.getElementById('backup-blurb').textContent = BLURBS[`backup:${dest}`];
  document.getElementById('restore-blurb').textContent = BLURBS[`restore:${dest}`];

  backupBtn.textContent = dest === 'local' ? '⬇ Download backup' : '⬆ Push to Dropbox';
  backupBtn.disabled = needsConnect;
  fileInput.hidden = dest !== 'local';

  // Everything below is the Dropbox axis, which Lite deletes outright (see the
  // edition branch at the foot of this file) — so it exists only when enabled.
  if (!dropboxEnabled) return;
  document.getElementById('dest-label').textContent = mode === 'backup' ? 'To:' : 'From:';
  fetchBtn.hidden = dest !== 'dropbox';
  fetchBtn.disabled = needsConnect;
  // The connect control is mounted at the foot of this same card, so the notice
  // can point straight at it.
  destWarn.innerHTML = needsConnect ? dropboxRequiredNotice('at the bottom of this card') : '';
}

// The single dry-run preview, whatever the backup came from. Nothing is written
// until Merge or Replace.
function showRestorePreview(obj) {
  const info = inspectBackup(obj);
  pendingBackup = obj;
  const rows = Object.entries(info.counts)
    .map(([name, n]) => `<tr><td>${esc(name)}</td><td>${n}</td></tr>`).join('');
  const warnUnknown = info.unknownTables.length
    ? `<div class="inline-warn">Ignoring unknown tables not in this app version: ${esc(info.unknownTables.join(', '))}.</div>`
    : '';
  preview.innerHTML = `
    <p class="muted">Exported ${info.exported_at ? esc(new Date(info.exported_at).toLocaleString()) : 'unknown date'} (schema v${esc(info.schema_version ?? '?')}).</p>
    <table class="data" style="max-width:320px;"><thead><tr><th>Table</th><th>Rows</th></tr></thead><tbody>${rows}</tbody></table>
    ${warnUnknown}
    <div class="form-actions">
      <button class="btn" id="btn-merge">Merge into current data</button>
      <button class="btn btn-danger" id="btn-replace">Replace all data</button>
    </div>`;
  document.getElementById('btn-merge').onclick = () => doRestore('merge');
  document.getElementById('btn-replace').onclick = () => doRestore('replace');
}

backupBtn.addEventListener('click', () => {
  if (dest === 'dropbox') return runNetworkAction(backupBtn, doDropboxPush);
  return doLocalBackup();
});

fetchBtn.addEventListener('click', () => runNetworkAction(fetchBtn, doDropboxFetch));

async function doLocalBackup() {
  try {
    const data = await downloadBackup();
    const total = Object.values(data.collections).reduce((n, rows) => n + rows.length, 0);
    renderLastBackup();
    flash(`Backup downloaded — ${total} record(s) across ${Object.keys(data.collections).length} tables.`);
  } catch (e) {
    flash(e.message || String(e), 'err');
  }
}

async function doDropboxPush() {
  const result = await pushToDropbox();
  renderLastBackup(); // a push counts as a backup
  flash(`Pushed to Dropbox — full backup (${result.records} record(s)) and assistant feed (${result.dogs} dog(s), ${result.events} event(s)).`);
}

async function doDropboxFetch() {
  const fetched = await fetchDropboxBackup();
  if (!fetched) {
    flash('No backup in Dropbox yet — push from your other phone first.', 'err');
    return;
  }
  showRestorePreview(fetched.backup);
}

fileInput.addEventListener('change', async () => {
  clearPending();
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    showRestorePreview(await readBackupFile(file));
  } catch (e) {
    flash(e.message || String(e), 'err');
  }
});

// Disable a button while its network action runs, then restore it. `busy` also
// freezes the seg-tabs for the duration: switching axis mid-flight would re-label
// the buttons, and this handler would then restore the label it captured for the
// OLD destination on top of it.
let busy = false;
async function runNetworkAction(btn, action) {
  const label = btn.textContent;
  busy = true;
  btn.disabled = true;
  btn.textContent = 'Working…';
  try {
    await action();
  } catch (e) {
    flash(e.message || String(e), 'err');
  } finally {
    busy = false;
    // The button may have been re-rendered away (e.g. after a disconnect).
    if (btn.isConnected) { btn.disabled = false; btn.textContent = label; }
  }
}

async function doRestore(mode) {
  if (!pendingBackup) return;
  const warning = mode === 'replace'
    ? 'Replace ALL current records with the file’s contents? This cannot be undone.'
    : 'Merge the file’s records into your current data (updating any with matching ids)?';
  if (!(await confirmModal({
    title: mode === 'replace' ? 'Replace all data?' : 'Merge data?',
    message: warning,
    confirmLabel: mode === 'replace' ? 'Replace' : 'Merge',
    danger: mode === 'replace'
  }))) return;
  try {
    const result = await restoreBackup(pendingBackup, mode);
    const total = result.reduce((n, r) => n + r.count, 0);
    flash(`Restore complete (${mode}) — ${total} record(s) loaded. Reloading…`);
    setTimeout(() => location.reload(), 1200);
  } catch (e) {
    // The Lite import cap (cap spec §9) throws a CapExceededError before writing
    // anything, so spell out what happened and what to do rather than showing the
    // terse repo message — nothing was changed, so the user can act and retry.
    if (e && e.name === 'CapExceededError') {
      flash(`This backup would leave ${e.current} active dogs — KennelOS Lite keeps up to ${e.limit}. `
        + `Nothing was changed. Trim the file to ${e.limit} or fewer active dogs, or upgrade to Pro, then import again.`, 'err');
    } else {
      flash(e.message || String(e), 'err');
    }
  }
}

renderLastBackup();

function wireSegTabs(containerId, onPick) {
  const tabs = document.getElementById(containerId);
  if (!tabs) return; // the destination row is absent in Lite
  tabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.seg-tab');
    if (!tab || busy) return; // a network action owns the card right now
    tabs.querySelectorAll('.seg-tab').forEach((t) => t.classList.toggle('active', t === tab));
    onPick(tab);
  });
}

wireSegTabs('br-tabs', (tab) => {
  mode = tab.dataset.mode;
  resetRestoreInput();
  renderBackupRestore();
});

wireSegTabs('dest-tabs', (tab) => {
  dest = tab.dataset.dest;
  resetRestoreInput();
  renderBackupRestore();
});

// CSV import is a single dropdown — pick a data type and go straight to its
// dedicated import page (each has its own dry-run preview).
const csvSelect = document.getElementById('csv-import-select');
// Lite is the only build that excludes Pro-only pages, so only there do we drop
// CSV-import options whose target page (Contacts, Stud services, Kennel tests)
// would be absent. Pro/Demo ship every page, so they keep every option.
if (edition === 'lite') {
  for (const opt of [...csvSelect.options]) {
    if (opt.value && isProOnlyPage(opt.value)) opt.remove();
  }
}
csvSelect.addEventListener('change', () => {
  if (csvSelect.value) location.href = csvSelect.value;
});

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

async function renderResetAppStatus() {
  const status = document.getElementById('reset-app-status');
  const counts = await getResetCounts();
  const parts = Object.entries(counts).map(([name, n]) => `${n} ${name}`);
  status.textContent = `Currently stored: ${parts.join(', ')}.`;
}

const RESET_PHRASE = 'RESET';

function showResetAppModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="max-width:440px;">
      <h2 style="margin-top:0;">⚠️ Reset app to start</h2>
      <p class="muted">This permanently deletes <strong>all</strong> dogs, contacts, kennels, and events, and clears
        all app settings. You'll land back on the first-run setup screen. This cannot be undone.</p>
      <div class="field field-wide">
        <label>Type <strong>${RESET_PHRASE}</strong> to confirm</label>
        <input id="reset-confirm-input" type="text" autocomplete="off" placeholder="${RESET_PHRASE}">
      </div>
      <div id="reset-error"></div>
      <div class="form-actions">
        <button class="btn btn-danger" id="reset-confirm-btn" disabled>Delete everything</button>
        <button class="btn" data-act="cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('#reset-confirm-input');
  const confirmBtn = overlay.querySelector('#reset-confirm-btn');
  const errorBox = overlay.querySelector('#reset-error');

  input.addEventListener('input', () => {
    confirmBtn.disabled = input.value !== RESET_PHRASE;
  });

  overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => overlay.remove());

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Deleting…';
    try {
      await resetApp();
      overlay.querySelector('.modal').innerHTML = `<h2 style="margin-top:0;">Reset complete</h2>
        <p class="muted">Reloading…</p>`;
      setTimeout(() => location.reload(), 800);
    } catch (e) {
      errorBox.innerHTML = `<div class="inline-error">${esc(e.message || String(e))}</div>`;
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Delete everything';
    }
  });

  input.focus();
}

document.getElementById('btn-reset-app').addEventListener('click', showResetAppModal);

renderResetAppStatus();

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
        key here again — and that includes this Import/Export page, so you won't be able to download a
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
      renderLastBackup();  // the page behind the modal, too
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

// Dropbox sync + KennelAssistant is Pro (§26). In Lite there is no second
// destination at all, so the whole Dropbox axis disappears and the card renders
// as the plain local backup/restore it has always been.
if (!dropboxEnabled) {
  document.getElementById('dest-row')?.remove();
  document.getElementById('dest-warn')?.remove();
  document.getElementById('btn-dbx-fetch')?.remove();
  document.getElementById('dropbox-connect')?.remove();
  renderBackupRestore();
} else {
  renderBackupRestore();
  // Mounts the connect control AND finishes an in-flight OAuth redirect, so
  // everything gated on the connection re-renders once it lands.
  mountDropboxConnect(document.getElementById('dropbox-connect'), {
    onChange: (connected) => {
      if (connected) flash('Dropbox connected.');
      renderBackupRestore();
    },
    onError: (m) => flash(m, 'err')
  });
}
