// ui.js — small shared rendering helpers used across pages. No framework;
// just functions that return safe HTML strings or build DOM.
import { descriptor } from '../data/vocab.js';
import { todayYMD } from '../data/dateUtils.js';
import { editionFlags } from '../data/editionConfig.js';

// Re-exported so pages keep importing todayYMD from here alongside the rest
// of the shared rendering helpers — the one implementation lives in
// data/dateUtils.js so repos and assets never drift apart on "what is today."
export { todayYMD };

// Escape untrusted text for safe interpolation into innerHTML.
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// A colored badge for a single vocab value.
// A read-only dog reference. Normally a link to the dog's record; but in Lite an
// ARCHIVED dog is a *departed* dog whose record must not be reachable (cap spec
// §7 — a visible link would let a curious user open it, see it's merely
// "archived", and infer an un-archive bypasses the cap). When editionFlags.
// archivedDogLinks is false and the dog is archived, its name renders as plain
// text (no href, no "arch" badge) so the departure mechanism stays invisible.
// `name` is raw text (escaped here). `isArchived` is the dog's is_archived.
export function dogRefHtml(id, name, isArchived = false) {
  const text = esc(name);
  if (isArchived && !editionFlags.archivedDogLinks) {
    return `<span class="dog-name-static">${text}</span>`;
  }
  return `<a href="dog.html?id=${encodeURIComponent(id)}">${text}</a>`;
}

export function badge(vocab, value) {
  const d = descriptor(vocab, value);
  return `<span class="badge ${d.badge}">${esc(d.label)}</span>`;
}

// Multiple badges (e.g. a contact's several types).
export function badges(vocab, values) {
  if (!values || !values.length) return '<span class="faint">—</span>';
  return values.map((v) => badge(vocab, v)).join(' ');
}

// Date-only display: 'YYYY-MM-DD' -> localized medium date, untouched if empty.
export function fmtDate(ymd) {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

// Money display: a number -> "$1,234.50", untouched if null/blank. Kept here
// alongside fmtDate so every screen formats currency the same way.
export function fmtMoney(amount) {
  if (amount == null || amount === '') return '';
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

// Read ?id= (or any param) from the current URL.
export function param(name) {
  return new URLSearchParams(location.search).get(name);
}

// --- Styled modal dialogs -------------------------------------------------
// The app's own dialogs, replacing native window.confirm/alert/prompt. Each
// appends a .modal-overlay to <body> and returns a promise, removing the
// overlay when the user resolves it. Backdrop-click dismisses (as cancel/no).
// Markup mirrors the hand-built modals on the litter/sale pages so the styling
// stays identical everywhere.
function mountModal(innerHtml) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${innerHtml}</div>`;
  document.body.appendChild(overlay);
  return overlay;
}

// Message paragraph: pre-wrap so embedded newlines (e.g. a bulleted list passed
// through from a former window.confirm) render as line breaks, not one blob.
function modalMessage(message) {
  return message ? `<p class="muted" style="white-space:pre-wrap;">${esc(message)}</p>` : '';
}

// Yes/no confirmation. Resolves true on confirm, false on cancel/backdrop.
export function confirmModal({ title, message = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const overlay = mountModal(`
      <h2 style="margin-top:0;">${esc(title)}</h2>
      ${modalMessage(message)}
      <div class="form-actions">
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="cm-confirm">${esc(confirmLabel)}</button>
        <button class="btn" id="cm-cancel">${esc(cancelLabel)}</button>
      </div>`);
    const done = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('#cm-confirm').addEventListener('click', () => done(true));
    overlay.querySelector('#cm-cancel').addEventListener('click', () => done(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
  });
}

// Informational alert with a single OK button. Resolves when dismissed.
export function alertModal({ title, message = '', okLabel = 'OK' }) {
  return new Promise((resolve) => {
    const overlay = mountModal(`
      <h2 style="margin-top:0;">${esc(title)}</h2>
      ${modalMessage(message)}
      <div class="form-actions">
        <button class="btn btn-primary" id="am-ok">${esc(okLabel)}</button>
      </div>`);
    const done = () => { overlay.remove(); resolve(); };
    overlay.querySelector('#am-ok').addEventListener('click', done);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(); });
  });
}

// Single-line text prompt. Resolves the trimmed string on confirm, or null on
// cancel/backdrop/empty.
export function promptModal({ title, message = '', label = '', placeholder = '', defaultValue = '', confirmLabel = 'OK', cancelLabel = 'Cancel' }) {
  return new Promise((resolve) => {
    const overlay = mountModal(`
      <h2 style="margin-top:0;">${esc(title)}</h2>
      ${modalMessage(message)}
      <div class="field">
        ${label ? `<label>${esc(label)}</label>` : ''}
        <input id="pm-value" type="text" value="${esc(defaultValue)}" placeholder="${esc(placeholder)}">
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" id="pm-confirm">${esc(confirmLabel)}</button>
        <button class="btn" id="pm-cancel">${esc(cancelLabel)}</button>
      </div>`);
    const input = overlay.querySelector('#pm-value');
    const done = (val) => { overlay.remove(); resolve(val); };
    const submit = () => done(input.value.trim() || null);
    overlay.querySelector('#pm-confirm').addEventListener('click', submit);
    overlay.querySelector('#pm-cancel').addEventListener('click', () => done(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    input.focus();
  });
}

// Single-select prompt from a vocab-style [{value,label}] list. Resolves the
// chosen value, or null on cancel/backdrop.
export function selectModal({ title, message = '', label = '', options, defaultValue = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel' }) {
  return new Promise((resolve) => {
    const optsHtml = options.map((o) =>
      `<option value="${esc(o.value)}"${o.value === defaultValue ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
    const overlay = mountModal(`
      <h2 style="margin-top:0;">${esc(title)}</h2>
      ${modalMessage(message)}
      <div class="field">
        ${label ? `<label>${esc(label)}</label>` : ''}
        <select id="sm-value">${optsHtml}</select>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" id="sm-confirm">${esc(confirmLabel)}</button>
        <button class="btn" id="sm-cancel">${esc(cancelLabel)}</button>
      </div>`);
    const done = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('#sm-confirm').addEventListener('click', () => done(overlay.querySelector('#sm-value').value || null));
    overlay.querySelector('#sm-cancel').addEventListener('click', () => done(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
  });
}

// Read-only PDF viewer modal (Download + Close). Shared by anything that
// stores a file via data/fileRepo.js — the Documents page and the
// receipt-attachment widget (assets/receiptCapture.js) — so a stored PDF is
// always viewed the same way regardless of what it's attached to.
export function viewPdfModal({ title = 'Document', blob, filename = 'document.pdf' }) {
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="max-width:900px;width:96vw;">
      <div class="row-between" style="align-items:center;">
        <h2 style="margin:0;font-size:17px;">${esc(title)}</h2>
        <div class="form-actions" style="margin:0;">
          <button class="btn" data-act="download">Download</button>
          <button class="btn" data-act="close">Close</button>
        </div>
      </div>
      <embed src="${url}" type="application/pdf" style="width:100%;height:70vh;margin-top:12px;border:1px solid var(--border,#e2e6ec);border-radius:6px;">
    </div>`;
  document.body.appendChild(overlay);
  const cleanup = () => { overlay.remove(); setTimeout(() => URL.revokeObjectURL(url), 500); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });
  overlay.querySelector('[data-act="close"]').addEventListener('click', cleanup);
  overlay.querySelector('[data-act="download"]').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
}

// Collapsible card chrome (Today home cards). `title` is the header HTML
// (may already include a trailing count span); `bodyHtml` is everything
// below the header. `isEmpty` starts the card collapsed — the caller
// decides what "empty" means for that card. `headerExtra` renders inline
// actions (e.g. a link/button) next to the toggle, before it.
export function cardShell(title, bodyHtml, { key = '', isEmpty = false, headerExtra = '', marginTop = false } = {}) {
  return `<section class="card card-collapsible"${marginTop ? ' style="margin-top:16px;"' : ''} data-card="${esc(key)}">
      <div class="card-head">
        <h2 style="margin:0;">${title}</h2>
        <div class="card-head-actions">
          ${headerExtra}
          <button type="button" class="card-toggle-btn" aria-expanded="${isEmpty ? 'false' : 'true'}" aria-label="${isEmpty ? 'Expand' : 'Collapse'} card">▾</button>
        </div>
      </div>
      <div class="card-body"${isEmpty ? ' hidden' : ''}>${bodyHtml}</div>
    </section>`;
}

// Delegated once for every page that renders a cardShell — toggles the
// nearest card body and flips the button's expanded state/label.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.card-toggle-btn');
  if (!btn) return;
  const body = btn.closest('.card-collapsible')?.querySelector('.card-body');
  if (!body) return;
  const wasOpen = !body.hidden;
  body.hidden = wasOpen;
  btn.setAttribute('aria-expanded', String(!wasOpen));
  btn.setAttribute('aria-label', wasOpen ? 'Expand card' : 'Collapse card');
});
