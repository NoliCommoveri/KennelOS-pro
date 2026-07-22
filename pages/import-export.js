// import-export.js — wires the Import/Export page to the backup engine.
import { downloadBackup, readBackupFile, inspectBackup, restoreBackup } from '../data/importExport.js';
import { getLastBackupDate } from '../data/settings.js';
import { hasMyKennelSetup, getMyKennelName } from '../data/kennelSetup.js';
import { showKennelSetupModal } from '../assets/kennelSetupUI.js';
import { getResetCounts, resetApp } from '../data/appReset.js';
import { isTourAvailable, restartWizard } from '../data/wizardState.js';
import { runWizardStep } from '../assets/wizardUI.js';
import { esc, confirmModal } from '../assets/ui.js';
import { editionFlags, edition } from '../data/editionConfig.js';
import { isProOnlyPage } from '../data/proPages.js';
import {
  completeDropboxAuth, beginDropboxAuth, isDropboxConnected, disconnectDropbox
} from '../data/dropbox.js';
import {
  pushToDropbox, fetchDropboxBackup, mergeDropboxBackup,
  fetchAssistantOutbox, importAssistantEvents
} from '../data/assistantSync.js';

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

document.getElementById('btn-backup').addEventListener('click', async () => {
  try {
    const data = await downloadBackup();
    const total = Object.values(data.collections).reduce((n, rows) => n + rows.length, 0);
    renderLastBackup();
    flash(`Backup downloaded — ${total} record(s) across ${Object.keys(data.collections).length} tables.`);
  } catch (e) {
    flash(e.message || String(e), 'err');
  }
});

const fileInput = document.getElementById('restore-file');
const preview = document.getElementById('restore-preview');
let pendingBackup = null;

fileInput.addEventListener('change', async () => {
  preview.innerHTML = '';
  pendingBackup = null;
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    const obj = await readBackupFile(file);
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
  } catch (e) {
    flash(e.message || String(e), 'err');
  }
});

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
    flash(e.message || String(e), 'err');
  }
}

renderLastBackup();

// Backup / restore share one card with a segmented toggle — only one panel
// shows at a time.
const brTabs = document.getElementById('br-tabs');
brTabs.addEventListener('click', (e) => {
  const tab = e.target.closest('.seg-tab');
  if (!tab) return;
  brTabs.querySelectorAll('.seg-tab').forEach((t) => t.classList.toggle('active', t === tab));
  const mode = tab.dataset.mode;
  document.getElementById('br-backup').hidden = mode !== 'backup';
  document.getElementById('br-restore').hidden = mode !== 'restore';
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
  showKennelSetupModal({ skippable: false });
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

// --- Dropbox sync -----------------------------------------------------------

const dropboxBody = document.getElementById('dropbox-body');

function renderDropbox() {
  if (!dropboxBody) return; // Lite: the Dropbox/KennelAssistant section is removed
  if (!isDropboxConnected()) {
    dropboxBody.innerHTML = `
      <div class="form-actions" style="margin-top:0;">
        <button class="btn btn-primary" id="dbx-connect">Connect Dropbox</button>
      </div>`;
    document.getElementById('dbx-connect').addEventListener('click', async () => {
      try {
        await beginDropboxAuth();
      } catch (e) {
        flash(e.message || String(e), 'err');
      }
    });
    return;
  }

  dropboxBody.innerHTML = `
    <p class="muted">Connected. Push after a work session; pull on your other phone to catch up.</p>
    <div class="form-actions">
      <button class="btn btn-primary" id="dbx-push">⬆ Push</button>
      <button class="btn" id="dbx-pull">⬇ Pull &amp; merge</button>
      <button class="btn" id="dbx-outbox">📥 Bring in updates</button>
      <button class="btn" id="dbx-disconnect">Disconnect</button>
    </div>`;
  document.getElementById('dbx-push').addEventListener('click', () => runDropboxAction('dbx-push', doDropboxPush));
  document.getElementById('dbx-pull').addEventListener('click', () => runDropboxAction('dbx-pull', doDropboxPull));
  document.getElementById('dbx-outbox').addEventListener('click', () => runDropboxAction('dbx-outbox', doAssistantImport));
  document.getElementById('dbx-disconnect').addEventListener('click', async () => {
    if (!(await confirmModal({
      title: 'Disconnect Dropbox?',
      message: 'This forgets the connection on this phone only — nothing in Dropbox is deleted.',
      confirmLabel: 'Disconnect'
    }))) return;
    disconnectDropbox();
    renderDropbox();
  });
}

// Disable the clicked button while its network action runs, then restore it.
async function runDropboxAction(buttonId, action) {
  const btn = document.getElementById(buttonId);
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Working…';
  try {
    await action();
  } catch (e) {
    flash(e.message || String(e), 'err');
  } finally {
    // The button may have been re-rendered away (e.g. after disconnect).
    const still = document.getElementById(buttonId);
    if (still) { still.disabled = false; still.textContent = label; }
  }
}

async function doDropboxPush() {
  const result = await pushToDropbox();
  renderLastBackup(); // a push counts as a backup
  flash(`Pushed to Dropbox — full backup (${result.records} record(s)) and assistant feed (${result.dogs} dog(s), ${result.events} event(s)).`);
}

async function doDropboxPull() {
  const fetched = await fetchDropboxBackup();
  if (!fetched) {
    flash('No backup in Dropbox yet — push from your other phone first.', 'err');
    return;
  }
  const { backup, info } = fetched;
  const total = Object.values(info.counts).reduce((n, c) => n + c, 0);
  const when = info.exported_at ? new Date(info.exported_at).toLocaleString() : 'an unknown date';
  if (!(await confirmModal({
    title: 'Merge from Dropbox?',
    message: `Merge the backup pushed ${when} (${total} record(s)) into your current data? Records with matching ids are updated; everything else is kept.`,
    confirmLabel: 'Merge'
  }))) return;
  const result = await mergeDropboxBackup(backup);
  const merged = result.reduce((n, r) => n + r.count, 0);
  flash(`Merge complete — ${merged} record(s) loaded from Dropbox. Reloading…`);
  setTimeout(() => location.reload(), 1200);
}

async function doAssistantImport() {
  const outbox = await fetchAssistantOutbox();
  if (!outbox) {
    flash('No assistant updates in Dropbox yet — have the assistant app send first.', 'err');
    return;
  }
  if (!outbox.rows.length) {
    flash('The assistant has no unsent updates — nothing to bring in.');
    return;
  }
  showAssistantPreviewModal(outbox);
}

const OUTBOX_STATUS_LABELS = {
  new: { text: 'New', cls: 'badge-green' },
  update: { text: 'Already imported', cls: 'badge-neutral' },
  no_dog: { text: 'Skipped — unknown dog', cls: 'badge-red' },
  invalid: { text: 'Skipped — incomplete', cls: 'badge-red' }
};

// Dry-run preview before committing the assistant's events — same posture as
// every other import in the app: see it, then write it.
function showAssistantPreviewModal({ generated_at, rows }) {
  const importable = rows.filter((r) => r.status === 'new' || r.status === 'update').length;
  const listRows = rows.map((r) => {
    const s = OUTBOX_STATUS_LABELS[r.status];
    return `<tr>
      <td>${esc(r.dogName || '—')}</td>
      <td>${esc(r.typeLabel)}</td>
      <td>${esc(r.event.event_date || '—')}</td>
      <td><span class="badge ${s.cls}">${esc(s.text)}</span></td>
    </tr>`;
  }).join('');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="max-width:520px;">
      <h2 style="margin-top:0;">Assistant updates</h2>
      <p class="muted">Sent ${generated_at ? esc(new Date(generated_at).toLocaleString()) : 'at an unknown time'}. Nothing is written until you import.</p>
      <div style="max-height:300px;overflow-y:auto;">
        <table class="data"><thead><tr><th>Dog</th><th>Event</th><th>Date</th><th>Status</th></tr></thead><tbody>${listRows}</tbody></table>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" id="outbox-import" ${importable ? '' : 'disabled'}>Import ${importable} event(s)</button>
        <button class="btn" data-act="cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#outbox-import').addEventListener('click', async () => {
    try {
      const result = await importAssistantEvents(rows);
      overlay.remove();
      flash(`Assistant updates imported — ${result.imported} event(s)${result.skipped ? `, ${result.skipped} skipped` : ''}.`);
    } catch (e) {
      overlay.remove();
      flash(e.message || String(e), 'err');
    }
  });
}

// Dropbox sync + KennelAssistant is Pro (§26). In Lite, remove the section and
// skip the OAuth-completion / status render entirely.
if (!editionFlags.assistant) {
  document.getElementById('dropbox-section')?.remove();
} else {
  // Finish an in-flight OAuth redirect (if the URL carries ?code=), then render.
  completeDropboxAuth()
    .then((handled) => { if (handled) flash('Dropbox connected.'); })
    .catch((e) => flash(e.message || String(e), 'err'))
    .finally(renderDropbox);
}
