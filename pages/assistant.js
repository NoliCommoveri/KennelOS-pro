// assistant.js (pages/) — the OWNER-side KennelAssistant console.
//
// Not to be confused with `shared/assistant.js`, which is the helper's own
// standalone app (its own Dexie database, no nav, read-write). Same split as
// Companion: the console that configures and sends lives in pages/, the thing
// the recipient opens lives at the root.
//
// Three jobs, in the order an owner meets them: connect (the shared control,
// same connection Import/Export uses), send the helper a fresh copy of the
// dogs, and bring their entries back in. Push/pull of the FULL backup is
// deliberately not here — that's Import/Export's Dropbox destination.
import {
  buildAssistantFeed, pushAssistantFeed, fetchAssistantOutbox, importAssistantEvents
} from '../data/assistantSync.js';
import { getAssistantFeedPushedAt } from '../data/settings.js';
import { isDropboxConnected } from '../data/dropbox.js';
import { mountDropboxConnect, dropboxRequiredNotice } from '../assets/dropboxConnectUI.js';
import { EVENT_TYPES, ASSISTANT_EVENT_TYPES, descriptor } from '../data/vocab.js';
import { esc } from '../assets/ui.js';

const msg = document.getElementById('page-msg');
function flash(text, kind = 'ok') {
  msg.innerHTML = `<div class="${kind === 'ok' ? 'inline-warn' : 'inline-error'}" style="${kind === 'ok' ? 'color:var(--accent-dark);background:var(--accent-soft);border-color:#bfe0cd;' : ''}">${esc(text)}</div>`;
  msg.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Shared button-busy wrapper for the two network actions on this page.
async function runNetworkAction(btn, action) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Working…';
  try {
    await action();
  } catch (e) {
    flash(e.message || String(e), 'err');
  } finally {
    if (btn.isConnected) { btn.disabled = false; btn.textContent = label; }
  }
}

// --- Your helper's copy -----------------------------------------------------

function renderFeedSent() {
  const iso = getAssistantFeedPushedAt();
  document.getElementById('feed-sent').textContent = iso
    ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : 'Never';
}

async function renderFeed() {
  const body = document.getElementById('feed-body');
  renderFeedSent();
  if (!isDropboxConnected()) {
    body.innerHTML = dropboxRequiredNotice('above');
    return;
  }
  // Built locally to show what a send WOULD include — no network, nothing
  // uploaded until the button is pressed.
  const feed = await buildAssistantFeed();
  body.innerHTML = `
    <p class="muted">Ready to send: <strong>${feed.dogs.length}</strong> dog(s) and
      <strong>${feed.events.length}</strong> entr${feed.events.length === 1 ? 'y' : 'ies'}.</p>
    <div class="form-actions" style="margin-top:0;">
      <button class="btn btn-primary" id="btn-send-feed">⬆ Send updates to helper</button>
    </div>`;
  const btn = document.getElementById('btn-send-feed');
  btn.addEventListener('click', () => runNetworkAction(btn, async () => {
    const result = await pushAssistantFeed();
    renderFeedSent();
    flash(`Sent — your helper's copy now has ${result.dogs} dog(s) and ${result.events} entr${result.events === 1 ? 'y' : 'ies'}.`);
  }));
}

// --- Their entries ----------------------------------------------------------

function renderOutbox() {
  const body = document.getElementById('outbox-body');
  if (!isDropboxConnected()) {
    body.innerHTML = dropboxRequiredNotice('above');
    return;
  }
  body.innerHTML = `
    <div class="form-actions" style="margin-top:0;">
      <button class="btn" id="btn-outbox">📥 Check for entries</button>
    </div>`;
  const btn = document.getElementById('btn-outbox');
  btn.addEventListener('click', () => runNetworkAction(btn, doAssistantImport));
}

async function doAssistantImport() {
  const outbox = await fetchAssistantOutbox();
  if (!outbox) {
    flash('Nothing from your helper yet — have them tap “Send my updates” in KennelAssistant.', 'err');
    return;
  }
  if (!outbox.rows.length) {
    flash('Your helper has no unsent entries — nothing to bring in.');
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

// Dry-run preview before committing the helper's events — same posture as every
// other import in the app: see it, then write it.
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
      <h2 style="margin-top:0;">Your helper's entries</h2>
      <p class="muted">Sent ${generated_at ? esc(new Date(generated_at).toLocaleString()) : 'at an unknown time'}. Nothing is written until you import.</p>
      <div style="max-height:300px;overflow-y:auto;">
        <table class="data"><thead><tr><th>Dog</th><th>Event</th><th>Date</th><th>Status</th></tr></thead><tbody>${listRows}</tbody></table>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" id="outbox-import" ${importable ? '' : 'disabled'}>Import ${importable} entr${importable === 1 ? 'y' : 'ies'}</button>
        <button class="btn" data-act="cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#outbox-import').addEventListener('click', async () => {
    try {
      const result = await importAssistantEvents(rows);
      overlay.remove();
      flash(`Imported — ${result.imported} entr${result.imported === 1 ? 'y' : 'ies'}${result.skipped ? `, ${result.skipped} skipped` : ''}.`);
    } catch (e) {
      overlay.remove();
      flash(e.message || String(e), 'err');
    }
  });
}

// --- What the helper can see ------------------------------------------------
// Rendered from ASSISTANT_EVENT_TYPES rather than a hand-written list, so the
// promise on screen can't drift from the allow-list that actually gates the feed
// (§26). One list gates what they see, what they can log, and this paragraph.

function renderPrivacy() {
  const labels = ASSISTANT_EVENT_TYPES
    .map((t) => descriptor(EVENT_TYPES, t).label)
    .map((l) => `<span class="badge badge-neutral">${esc(l)}</span>`)
    .join(' ');
  document.getElementById('privacy-body').innerHTML = `
    <p class="muted" style="margin-bottom:6px;">They can see your dogs' names, breed, sex, status, birthday
      and litter grouping — and can log only these:</p>
    <p style="margin-top:0;">${labels}</p>
    <p class="muted">Your contacts, buyers, sales, contracts and finances are never sent to their device at
      all. Registration and microchip numbers, ownership and pedigree links, and prices stay here too.</p>`;
}

// --- Boot -------------------------------------------------------------------

function renderAll() {
  renderFeed();
  renderOutbox();
}

renderPrivacy();
renderAll();

mountDropboxConnect(document.getElementById('dropbox-connect'), {
  onChange: (connected) => {
    if (connected) flash('Dropbox connected.');
    renderAll();
  },
  onError: (m) => flash(m, 'err')
});
