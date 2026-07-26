// kennelCardUI.js — all the UI for Kennel Cards (End-State guide §28), kept in
// one module the way kennelScopeUI.js holds all three pieces of scope UI:
//
//   renderKennelCardSection()  the SHARE half, on the Kennel hub (kennel.js) —
//                              own kennels only: the kennel's public ID plus the
//                              two ways to hand it over (link / code).
//   mountKennelCardImport()    the RECEIVE half, on the Kennels list (kennels.js) —
//                              a "Add a kennel from a card" button, the paste box,
//                              and the dry-run preview → commit flow.
//   maybeOpenCardFromHash()    the same import flow, auto-opened when the page is
//                              reached by a card LINK (#kennelcard=…).
//
// Both host pages are Pro-only (data/proPages.js), so this module is listed in
// PRO_ONLY_STANDALONE and never ships in the Lite build.
//
// Everything here hand-builds innerHTML, so every user-supplied value — and a
// card's values all came from another person — goes through esc().
import {
  buildKennelCard, kennelCardLink, encodeKennelCard, decodeKennelCard,
  previewKennelCard, applyKennelCard, KennelCardError, CARD_FIELDS, extractCardPayload
} from '../data/kennelCard.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { esc } from './ui.js';

// Where a card link points: the recipient's Kennels page. Resolved against this
// module's own URL so it stays correct under every edition's directory layout.
const KENNELS_PAGE_URL = new URL('../pages/kennels.html', import.meta.url).href;

// --- Share half (kennel.js) -------------------------------------------------

// Copy helper with the obvious fallback: navigator.clipboard needs a secure
// context, and this app is routinely served over plain http on localhost during
// development, so a failure selects the text instead of silently doing nothing.
async function copyValue(value, inputEl, btnEl) {
  const label = btnEl.textContent;
  try {
    await navigator.clipboard.writeText(value);
    btnEl.textContent = 'Copied ✓';
  } catch {
    inputEl.select();
    btnEl.textContent = 'Press ⌘/Ctrl+C';
  }
  setTimeout(() => { btnEl.textContent = label; }, 2000);
}

export async function renderKennelCardSection(mount, kennel) {
  if (!mount) return;
  // Only your own kennels have a card to hand out. An outside kennel's identity
  // belongs to the breeder who owns it — we show what we were given, not a card.
  if (!kennel.is_own_kennel) {
    mount.innerHTML = kennel.public_id ? receivedIdentityHtml(kennel) : '';
    return;
  }

  let publicId = kennel.public_id;
  if (!publicId) publicId = await kennelRepo.ensurePublicId(kennel.id);

  const card = buildKennelCard({ ...kennel, public_id: publicId });
  const code = encodeKennelCard(card);
  const link = kennelCardLink(card, KENNELS_PAGE_URL);

  mount.innerHTML = `
    <section class="card">
      <h2 style="margin-top:0;">Kennel card</h2>
      <p class="field-hint">Your kennel's public ID, and the card that carries it. Send the card to a breeder you co-breed, stud, or place dogs with, and their copy of KennelOS will file your kennel under this same ID — so a stud service or a pedigree that crosses between you names one kennel, not two look-alike records. Nothing is published anywhere and nothing is looked up online; a card only goes where you send it.</p>

      <div class="field" style="margin-top:10px;">
        <label>Public kennel ID</label>
        <input id="kc-id" type="text" readonly value="${esc(publicId)}" onclick="this.select()">
        <span class="field-hint">Permanent. It survives backups, restores, and moving to a new device, and it never changes once issued.</span>
      </div>

      <div class="field" style="margin-top:10px;">
        <label>Card link <span class="faint" style="font-weight:normal;">— for a breeder using the same KennelOS edition as you</span></label>
        <input id="kc-link" type="text" readonly value="${esc(link)}" onclick="this.select()">
      </div>

      <div class="field" style="margin-top:10px;">
        <label>Card code <span class="faint" style="font-weight:normal;">— works with any KennelOS install</span></label>
        <textarea id="kc-code" readonly rows="3" onclick="this.select()">${esc(code)}</textarea>
        <span class="field-hint">They paste this into <strong>Kennels → Add from a card</strong>. Use the code when you don't know where their app is installed.</span>
      </div>

      <div class="form-actions">
        <button class="btn btn-primary btn-sm" data-act="copy-link">Copy link</button>
        <button class="btn btn-sm" data-act="copy-code">Copy code</button>
      </div>

      <details style="margin-top:10px;">
        <summary class="muted" style="cursor:pointer;">What's on the card</summary>
        <p class="field-hint" style="margin-top:8px;">Only these, and nothing else — no dogs, litters, sales, contacts, money, documents, logo, or your preferred-test and lifecycle settings:</p>
        <dl class="dl-meta">
          <dt>Public ID</dt><dd>${esc(publicId)}</dd>
          ${CARD_FIELDS.map(({ field, label }) => (
            kennel[field] ? `<dt>${esc(label)}</dt><dd>${esc(kennel[field])}</dd>` : ''
          )).join('')}
        </dl>
      </details>
    </section>`;

  const linkInput = mount.querySelector('#kc-link');
  const codeInput = mount.querySelector('#kc-code');
  mount.querySelector('[data-act="copy-link"]').addEventListener('click', (e) => copyValue(link, linkInput, e.currentTarget));
  mount.querySelector('[data-act="copy-code"]').addEventListener('click', (e) => copyValue(code, codeInput, e.currentTarget));
}

// An outside kennel that arrived via a card — worth saying so on its page, since
// "this came from its owner" is exactly the difference between a reference you
// can trust to line up with theirs and one you typed from memory.
function receivedIdentityHtml(kennel) {
  return `
    <section class="card">
      <h2 style="margin-top:0;">Kennel card <span class="badge badge-blue">linked</span></h2>
      <p class="field-hint">This kennel's details came from a card its owner issued, so your records and theirs refer to the same kennel by the same ID.</p>
      <dl class="dl-meta"><dt>Public ID</dt><dd>${esc(kennel.public_id)}</dd></dl>
    </section>`;
}

// --- Receive half (kennels.js) ---------------------------------------------

function modalShell(bodyHtml) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="max-width:560px;">
      <div class="row-between" style="align-items:flex-start; gap:12px;">
        <h2 style="margin:0;">Add a kennel from a card</h2>
        <button class="btn btn-sm" data-act="close">Close</button>
      </div>
      <div id="kc-body">${bodyHtml}</div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('[data-act="close"]').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  return { overlay, close, body: overlay.querySelector('#kc-body') };
}

const pasteFormHtml = (prefill) => `
  <p class="field-hint" style="margin-top:6px;">Paste the card link or code another breeder sent you. Nothing is saved until you've seen exactly what it would change.</p>
  <div class="field">
    <label>Card link or code</label>
    <textarea id="kc-input" rows="4" placeholder="Paste the link or code here…">${esc(prefill || '')}</textarea>
  </div>
  <div id="kc-error"></div>
  <div class="form-actions">
    <button class="btn btn-primary btn-sm" data-act="preview">Preview</button>
  </div>`;

function changesTableHtml(changes) {
  return `<div class="table-scroll"><table class="data">
    <thead><tr><th>Field</th><th>Currently</th><th>From the card</th></tr></thead>
    <tbody>${changes.map((c) => `<tr>
      <td>${esc(c.label)}</td>
      <td>${c.from ? esc(c.from) : '<span class="faint">—</span>'}</td>
      <td><strong>${esc(c.to)}</strong></td>
    </tr>`).join('')}</tbody></table></div>`;
}

function cardSummaryHtml(card) {
  const rows = CARD_FIELDS
    .map(({ card: key, label }) => (card[key] ? `<dt>${esc(label)}</dt><dd>${esc(card[key])}</dd>` : ''))
    .join('');
  return `<dl class="dl-meta">${rows}<dt>Public ID</dt><dd>${esc(card.publicId)}</dd></dl>`;
}

// The dry-run screen. Each action gets its own explanation and its own commit
// button (or, for the two no-op outcomes, no commit button at all).
function previewHtml(preview) {
  const { action, card, existing, changes, candidates } = preview;

  if (action === 'own') {
    return `<div class="card" style="margin-top:10px;">
        <p><strong>${esc(card.kennelName)}</strong> is one of your own kennels.</p>
        <p class="field-hint">Nothing to import — a card from outside never edits your own kennel's details. If you're setting up a second device, restore a backup from Import/Export instead; a card carries identity only, not your records.</p>
      </div>
      <div class="form-actions"><button class="btn btn-sm" data-act="close2">Done</button></div>`;
  }

  if (action === 'unchanged') {
    return `<div class="card" style="margin-top:10px;">
        <p>You already have <strong>${esc(existing.kennel_name)}</strong> linked to this card, and it's up to date.</p>
      </div>
      <div class="form-actions"><button class="btn btn-sm" data-act="close2">Done</button></div>`;
  }

  if (action === 'update') {
    return `<div class="card" style="margin-top:10px;">
        <p>This updates your existing record for <strong>${esc(existing.kennel_name)}</strong>.</p>
        ${changesTableHtml(changes)}
        <p class="field-hint">Everything else on your record — the dogs, litters, and sales that reference it — is untouched.</p>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary btn-sm" data-act="commit">Apply update</button>
        <button class="btn btn-sm" data-act="close2">Cancel</button>
      </div>`;
  }

  // 'create' — with the name-match suggestions, offered and never auto-applied.
  const suggestions = candidates.length ? `
    <div class="card" style="margin-top:10px;">
      <p><strong>You may already have this kennel.</strong></p>
      <p class="field-hint">${candidates.length === 1 ? 'This kennel on your device has' : 'These kennels on your device have'} the same name but no card behind ${candidates.length === 1 ? 'it' : 'them'}. Linking keeps everything that already points at ${candidates.length === 1 ? 'it' : 'the one you pick'} — dogs, stud services, contracts — instead of leaving it behind on a duplicate.</p>
      <label class="check-inline" style="display:block; margin:6px 0;">
        <input type="radio" name="kc-link-to" value="" checked> Add as a new kennel
      </label>
      ${candidates.map((k) => `
      <label class="check-inline" style="display:block; margin:6px 0;">
        <input type="radio" name="kc-link-to" value="${esc(k.id)}"> Link to “${esc(k.kennel_name)}”${k.location ? ` <span class="faint">— ${esc(k.location)}</span>` : ''}${k.is_archived ? ' <span class="badge badge-gray">Archived</span>' : ''}
      </label>`).join('')}
    </div>` : '';

  return `<div class="card" style="margin-top:10px;">
      <p>This adds <strong>${esc(card.kennelName)}</strong> as an outside kennel — another breeder's kennel you can reference on dogs, stud services, and contracts.</p>
      ${cardSummaryHtml(card)}
      <p class="field-hint">It is not added to your own kennels: it won't appear in your kennel switcher or your portfolio. You can change that later on this page if you really do own it.</p>
    </div>
    ${suggestions}
    <div class="form-actions">
      <button class="btn btn-primary btn-sm" data-act="commit">Add kennel</button>
      <button class="btn btn-sm" data-act="close2">Cancel</button>
    </div>`;
}

const DONE_COPY = {
  created: 'added',
  linked: 'linked to your existing record',
  update: 'updated',
  unchanged: 'already up to date',
  own: 'unchanged — it is your own kennel'
};

// Open the import flow. `prefill` seeds the paste box (used by the link path).
// `onDone` fires only when something was actually written, so the caller can
// re-render its list without a pointless repaint after a cancel.
export function openKennelCardImport({ prefill = '', onDone } = {}) {
  const { close, body } = modalShell(pasteFormHtml(prefill));

  const showError = (msg) => {
    const box = body.querySelector('#kc-error');
    if (box) box.innerHTML = `<div class="inline-error">${esc(msg)}</div>`;
  };

  const wireClose = () => {
    body.querySelector('[data-act="close2"]')?.addEventListener('click', close);
  };

  const onPreview = async () => {
    const raw = body.querySelector('#kc-input').value;
    body.querySelector('#kc-error').innerHTML = '';
    let preview;
    try {
      preview = await previewKennelCard(decodeKennelCard(raw));
    } catch (e) {
      showError(e instanceof KennelCardError ? e.message : (e.message || String(e)));
      return;
    }
    body.innerHTML = previewHtml(preview);
    wireClose();
    body.querySelector('[data-act="commit"]')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (btn.disabled) return;
      btn.disabled = true;
      const picked = body.querySelector('input[name="kc-link-to"]:checked');
      try {
        const { kennel, action } = await applyKennelCard(preview.card, { linkToId: picked?.value || null });
        body.innerHTML = `<div class="card" style="margin-top:10px;">
            <p><strong>${esc(kennel.kennel_name)}</strong> — ${esc(DONE_COPY[action] || action)}.</p>
          </div>
          <div class="form-actions">
            <a class="btn btn-primary btn-sm" href="kennel.html?id=${encodeURIComponent(kennel.id)}">Open kennel →</a>
            <button class="btn btn-sm" data-act="close2">Done</button>
          </div>`;
        wireClose();
        onDone?.(kennel);
      } catch (err) {
        btn.disabled = false;
        showError(err.message || String(err));
      }
    });
  };

  body.querySelector('[data-act="preview"]').addEventListener('click', onPreview);
  if (prefill) onPreview();
}

// Wire the "Add from a card" button on the Kennels page.
export function mountKennelCardImport(buttonEl, { onDone } = {}) {
  if (!buttonEl) return;
  buttonEl.addEventListener('click', () => openKennelCardImport({ onDone }));
}

// The link path: a breeder opened `kennels.html#kennelcard=…`. Consume the hash
// (so a reload doesn't re-run the flow) and open the same preview.
//
// The `hashchange` half is not redundant. Pasting a card link into the address
// bar while ALREADY on the Kennels page is a same-document navigation — the
// browser only changes the fragment, and no module re-runs — so without this
// listener that paste would silently do nothing, which is precisely the case
// where the user is most certain the link should work.
export function maybeOpenCardFromHash({ onDone } = {}) {
  const open = () => {
    const payload = extractCardPayload(location.hash);
    if (!payload) return;
    history.replaceState(null, '', location.pathname + location.search);
    openKennelCardImport({ prefill: payload, onDone });
  };
  window.addEventListener('hashchange', open);
  open();
}
