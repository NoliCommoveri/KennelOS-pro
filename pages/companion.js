// companion.js — the Companion Messaging console: the ONE centralized place to
// pre-configure the share-out messaging and send links.
//
// The page works ONE package type at a time, chosen by the ?type= seg-tabs
// (like the Contacts group tabs). The active type scopes everything: the single
// template card shown, the filter blurb, the recipients that appear, and the
// bundle "Prepare link" builds. Membership per type: prospective = an active
// waiting-list status; family = an open (non-terminal) sale; partner = a current
// stud service / active lease / co-own / other contract. A contact can appear in
// more than one package — that's expected.
//
// Two layers (see settings.js): Layer 1 is the per-type header copy (kennel
// identity + intro + announcement), edited in the "Message template" card.
// Layer 2 is Contact.companion_note, a per-recipient personal line editable
// inline in the Recipients table, shown alongside the broadcast announcement
// (not an override). "Prepare link" builds a fresh point-in-time bundle through the
// allow-list builder, compresses it, and hands off a REAL sms:/mailto: anchor —
// the user's tap on that anchor is the activating gesture (never a post-async
// window.location assignment, which loses the iOS user-activation, brief §5.2).
import { contactRepo } from '../data/contactRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import { studServiceRepo } from '../data/studServiceRepo.js';
import { contractRepo } from '../data/contractRepo.js';
import {
  getCompanionSettings, setCompanionSettings, COMPANION_TYPES, companionTypeLabel,
  companionIncludeKeys
} from '../data/settings.js';
import { buildBundle } from '../data/companionExport.js';
import { compressToEncodedURIComponent } from '../vendor/lz-string.min.mjs';
import { esc, param, todayYMD } from '../assets/ui.js';

// Payload ceilings for the data-in-hash transport (brief §6.1). SMS is the weak
// link — long URLs get truncated/split by some gateways; mail clients tolerate
// far longer. Conservative starting values; tune on real devices.
const MAX_SMS_HASH_LEN = 1800;
const MAX_EMAIL_HASH_LEN = 12000;

// The recipient-facing shell lives at the app root and is maintained by the
// owner (same static host). Absolute so it survives being pasted into SMS/email.
const SHELL_URL = new URL('../companion-view.html', import.meta.url).href;

const els = {
  error: document.getElementById('page-error'),
  blurb: document.getElementById('filter-blurb'),
  tabs: document.getElementById('companion-type-tabs'),
  templates: document.getElementById('templates'),
  recipients: document.getElementById('recipients'),
  showArchived: document.getElementById('show-archived')
};

// The active package type drives everything on the page — which template card
// shows, which contacts appear as recipients, and the bundle type "Prepare
// link" builds. Read from ?type= (like the Contacts group tabs); default to the
// first type when absent/unknown.
const activeType = COMPANION_TYPES.includes(param('type')) ? param('type') : COMPANION_TYPES[0];

const ctx = {
  contacts: [],
  // Contact-id membership sets, one per package type, recomputed on each load.
  openSaleBuyerIds: new Set(),
  partnerIds: new Set()
};

// Who lands in each package's recipient list. Same contact can satisfy more
// than one — that's expected (a current family can also be a co-own partner).
function inActiveType(contact) {
  switch (activeType) {
    case 'prospective': return contact.waitlist_status === 'active';
    case 'family': return ctx.openSaleBuyerIds.has(contact.id);
    case 'partner': return ctx.partnerIds.has(contact.id);
    default: return false;
  }
}

// The plain-language explanation shown above the template card, so the owner
// knows exactly why a contact is (or isn't) in this package's list.
function filterBlurb() {
  switch (activeType) {
    case 'prospective': return 'Contacts with an active waiting-list status.';
    case 'family': return 'Contacts with an open sale — deposit pending, deposit paid, or paid in full (not delivered, returned, or cancelled).';
    case 'partner': return 'Contacts on a current stud service (whose return date hasn’t passed), an active lease (whose end date hasn’t passed), or any co-own / other contract.';
    default: return '';
  }
}

function showError(msg) { els.error.innerHTML = `<div class="inline-error">${esc(msg)}</div>`; }
function clearError() { els.error.innerHTML = ''; }

// The "What to include" checkboxes shown in each template card. A flat list
// where a `master` names the flag that gates a row: a child is disabled (and
// treated as off) whenever its master is unchecked. The `key`s must match the
// include flags in settings.js (companionIncludeKeys). The builder honours the
// same master-AND-child rule, so what's checked here is exactly what's emitted.
const INCLUDE_OPTIONS = {
  prospective: [
    { key: 'parents', label: 'Sire & Dam profiles' },
    { key: 'parentRegisteredName', label: 'Registered name', master: 'parents' },
    { key: 'parentCallName', label: 'Call name', master: 'parents' },
    { key: 'parentPhotos', label: 'Photo links', master: 'parents' },
    { key: 'parentTests', label: 'Health testing', master: 'parents' },
    { key: 'pricing', label: 'Puppy pricing & deposits' },
    { key: 'pricingPrice', label: 'Price', master: 'pricing' },
    { key: 'pricingDeposit', label: 'Deposit', master: 'pricing' },
    { key: 'litterDates', label: 'Litter dates (born, accepting deposits, estimated ready)' },
    { key: 'markings', label: 'Puppy markings' },
    { key: 'fosterOwnerKennel', label: 'Owner kennel on foster litters' }
  ],
  family: [
    { key: 'age', label: 'Puppy age' },
    { key: 'parentage', label: 'Parentage (Sire × Dam)' },
    { key: 'photos', label: 'Photo link' },
    { key: 'readyPlacement', label: 'Ready / placement details' },
    { key: 'financials', label: 'Financials (price, deposit, fees, balance)' },
    { key: 'histVaccination', label: 'History — Vaccinations' },
    { key: 'histPreventative', label: 'History — Preventatives' },
    { key: 'histWeight', label: 'History — Weight checks' },
    { key: 'histMilestone', label: 'History — Milestones' },
    { key: 'histNote', label: 'History — Notes' },
    { key: 'histBoarding', label: 'Deferred pickup boarding' },
    { key: 'contract', label: 'Contract link' },
    { key: 'fosterOwnerKennel', label: 'Owner kennel on foster litters' }
  ],
  partner: [
    { key: 'studServices', label: 'Stud services' },
    { key: 'studRegisteredName', label: 'Registered name', master: 'studServices' },
    { key: 'studCallName', label: 'Call name', master: 'studServices' },
    { key: 'studPhotos', label: 'Photo links', master: 'studServices' },
    { key: 'studTests', label: 'Health testing', master: 'studServices' },
    { key: 'studAgreement', label: 'Agreement & fee details', master: 'studServices' },
    { key: 'studContract', label: 'Contract link', master: 'studServices' },
    { key: 'contracts', label: 'Lease / co-own / other contracts' }
  ]
};

function includeChecklist(type, include) {
  const rows = (INCLUDE_OPTIONS[type] || []).map((o) => {
    const on = include[o.key] !== false;
    const pad = o.master ? ' padding-left:22px;' : '';
    return `<label class="check-inline" style="display:block; margin:4px 0;${pad}">
      <input type="checkbox" class="t-inc" data-key="${esc(o.key)}"${o.master ? ` data-master="${esc(o.master)}"` : ''}${on ? ' checked' : ''}> ${esc(o.label)}
    </label>`;
  }).join('');
  return `
    <div class="field field-wide" style="margin-top:8px;">
      <label>What to include on the recipient's page</label>
      <div class="include-list">${rows}</div>
      <span class="field-hint">Unchecking a component leaves it off the page entirely — the rest stays clean. A sub-option greys out when its group is off.</span>
    </div>`;
}

// --- Layer 1: message template cards --------------------------------------
function templateCard(type) {
  const s = getCompanionSettings(type);
  return `
    <div class="card" data-type="${esc(type)}" style="margin-top:12px;">
      <h3 style="margin:0 0 8px;">${esc(companionTypeLabel(type))}</h3>
      <div class="form-grid">
        <div class="field"><label>Kennel name</label><input class="t-kennelName" type="text" value="${esc(s.kennelName)}"></div>
        <div class="field"><label>Tagline</label><input class="t-tagline" type="text" value="${esc(s.tagline)}"></div>
        <div class="field field-wide"><label>Intro text</label><textarea class="t-introText">${esc(s.introText)}</textarea><span class="field-hint">Sets the "not live" expectation on the recipient's page.</span></div>
        <div class="field field-wide"><label>Announcement</label><textarea class="t-announcement">${esc(s.announcement)}</textarea><span class="field-hint">A broadcast line for everyone of this type (e.g. "Spring litter arrives in June!"). Shown alongside a recipient's personal note, not overridden by it.</span></div>
        <div class="field field-wide"><label>Closer</label><textarea class="t-closer">${esc(s.closer)}</textarea><span class="field-hint">A sign-off shown at the very bottom of the page, just above the snapshot date (e.g. "Thanks for being part of our program!").</span></div>
        ${includeChecklist(type, s.include || {})}
      </div>
      <div style="margin-top:8px;"><button class="btn btn-primary btn-sm t-save">Save ${esc(companionTypeLabel(type))} template</button> <span class="t-saved muted"></span></div>
    </div>`;
}

// Highlight the active package tab (matches the Contacts group-tabs pattern).
function renderTabs() {
  els.tabs.querySelectorAll('.seg-tab').forEach((tab) => {
    const tabType = new URL(tab.href).searchParams.get('type');
    const isActive = tabType === activeType;
    tab.classList.toggle('active', isActive);
    if (isActive) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
  });
}

function renderBlurb() {
  els.blurb.innerHTML =
    `<p class="muted" style="margin:0 0 12px;"><strong>${esc(companionTypeLabel(activeType))}:</strong> ${esc(filterBlurb())}</p>`;
}

// Only the active package type's template card renders — one audience at a time.
function renderTemplates() {
  els.templates.innerHTML = templateCard(activeType);
  els.templates.querySelectorAll('[data-type]').forEach((card) => {
    const type = card.dataset.type;

    // Grey out a sub-option whenever its master is unchecked (still keeps its own
    // checked state, so re-enabling the master restores the prior selection).
    const incBoxes = Array.from(card.querySelectorAll('.t-inc'));
    const syncDisabled = () => {
      const state = {};
      incBoxes.forEach((b) => { state[b.dataset.key] = b.checked; });
      incBoxes.forEach((b) => {
        const m = b.dataset.master;
        b.disabled = m ? !state[m] : false;
        b.closest('label').style.opacity = b.disabled ? '0.5' : '';
      });
    };
    incBoxes.forEach((b) => b.addEventListener('change', syncDisabled));
    syncDisabled();

    card.querySelector('.t-save').addEventListener('click', () => {
      const include = {};
      companionIncludeKeys(type).forEach((key) => {
        const box = card.querySelector(`.t-inc[data-key="${key}"]`);
        include[key] = box ? box.checked : true;
      });
      setCompanionSettings(type, {
        kennelName: card.querySelector('.t-kennelName').value.trim(),
        tagline: card.querySelector('.t-tagline').value.trim(),
        introText: card.querySelector('.t-introText').value,
        announcement: card.querySelector('.t-announcement').value,
        closer: card.querySelector('.t-closer').value,
        include
      });
      const saved = card.querySelector('.t-saved');
      saved.textContent = 'Saved.';
      setTimeout(() => { saved.textContent = ''; }, 2000);
    });
  });
}

// --- Recipients: type suggestion, note editing, link prep -----------------
async function loadData() {
  const includeArchived = els.showArchived.checked;
  const today = todayYMD();
  const [contacts, sales, studServices, contracts] = await Promise.all([
    contactRepo.getAll({ includeArchived }),
    saleRepo.getAll({ includeArchived: true }),
    studServiceRepo.getAll({ includeArchived: true }),
    contractRepo.getAll({ includeArchived: true })
  ]);
  ctx.contacts = contacts.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true }));

  // Current families: buyers with an open sale — the same saleRepo.isOpenSale
  // predicate the family bundle builder uses, so membership and bundle contents
  // stay in lockstep (non-terminal status: not delivered/returned/cancelled).
  ctx.openSaleBuyerIds = new Set();
  for (const s of sales) {
    if (s.buyer_contact_id && saleRepo.isOpenSale(s)) ctx.openSaleBuyerIds.add(s.buyer_contact_id);
  }

  // Partners: a stud service whose return date hasn't passed (empty or future),
  // or a live lease / co_own / other contract — the same isLivePartnerContract
  // predicate the bundle builder uses, so membership and bundle contents agree
  // (non-terminal status; unexpired for leases).
  ctx.partnerIds = new Set();
  for (const ss of studServices) {
    if (ss.is_archived || !ss.partner_contact_id) continue;
    if (!ss.returned_date || ss.returned_date >= today) ctx.partnerIds.add(ss.partner_contact_id);
  }
  for (const c of contracts) {
    if (contractRepo.isLivePartnerContract(c, today)) ctx.partnerIds.add(c.related_contact_id);
  }
}

// Each recipient collapses to just its header (name + contact + a "note" tag when
// one's on file) — the note editor, actions, and link box hide behind the toggle
// so a long filtered list stays scannable. Clicking the header expands one card.
function recipientRow(contact) {
  const archivedTag = contact.is_archived ? ' <span class="badge badge-gray">Archived</span>' : '';
  const noteTag = (contact.companion_note || '').trim() ? ' <span class="badge badge-blue">note</span>' : '';
  return `
    <div class="card" data-id="${esc(contact.id)}" style="margin-top:12px;">
      <div class="r-header" style="display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none;">
        <span class="r-arrow" style="display:inline-block; transition:transform 0.2s; font-size:12px;">▶</span>
        <div class="row-between" style="flex:1; gap:8px;">
          <span><strong>${esc(contact.name)}</strong>${archivedTag}<span class="r-note-tag">${noteTag}</span></span>
          <span class="muted">${esc(contact.email || contact.phone || 'no email/phone on file')}</span>
        </div>
      </div>
      <div class="r-body" style="display:none; margin-top:10px;">
        <div class="form-grid">
          <div class="field field-wide"><label>Personal note (shown alongside the announcement)</label><textarea class="r-note">${esc(contact.companion_note || '')}</textarea></div>
        </div>
        <div style="margin-top:8px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <button class="btn btn-sm r-save-note">Save note</button>
          <button class="btn btn-sm r-preview">Preview</button>
          <button class="btn btn-primary btn-sm r-prepare">Prepare link</button>
          <span class="r-note-saved muted"></span>
        </div>
        <div class="r-link" style="margin-top:8px;"></div>
      </div>
    </div>`;
}

function renderRecipients() {
  const matches = ctx.contacts.filter(inActiveType);
  if (!matches.length) {
    els.recipients.innerHTML =
      `<div class="empty-state">No ${esc(companionTypeLabel(activeType).toLowerCase())} match this package right now.</div>`;
    return;
  }
  els.recipients.innerHTML = matches.map(recipientRow).join('');
  els.recipients.querySelectorAll('[data-id]').forEach((row) => {
    const id = row.dataset.id;
    const contact = ctx.contacts.find((c) => c.id === id);
    const header = row.querySelector('.r-header');
    const body = row.querySelector('.r-body');
    const arrow = row.querySelector('.r-arrow');
    header.addEventListener('click', () => {
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      arrow.style.transform = open ? 'rotate(0deg)' : 'rotate(90deg)';
    });
    row.querySelector('.r-save-note').addEventListener('click', () => saveNote(row, contact));
    row.querySelector('.r-preview').addEventListener('click', () => previewMessage(row, contact));
    row.querySelector('.r-prepare').addEventListener('click', () => prepareLink(row, contact));
  });
}

async function saveNote(row, contact) {
  clearError();
  try {
    const note = row.querySelector('.r-note').value.trim();
    const saved = await contactRepo.update(contact.id, { companion_note: note });
    contact.companion_note = saved.companion_note;
    // Keep the collapsed header's "note" tag in sync with what was just saved.
    const tag = row.querySelector('.r-note-tag');
    if (tag) tag.innerHTML = (saved.companion_note || '').trim() ? ' <span class="badge badge-blue">note</span>' : '';
    const flag = row.querySelector('.r-note-saved');
    flag.textContent = 'Note saved.';
    setTimeout(() => { flag.textContent = ''; }, 2000);
  } catch (e) {
    showError(e.message || String(e));
  }
}

function channelBody(kennelName, url) {
  const opener = kennelName ? `Here's your update from ${kennelName}:` : `Here's your update:`;
  return `${opener}\n\n${url}`;
}

// Persist any unsaved note, build the point-in-time bundle for the active tab,
// and derive the shared send artifacts: the compressed hash, the recipient URL,
// and the channel body text. Both "Prepare link" and "Preview" run through this,
// so the preview is byte-for-byte what a send would produce.
async function buildSendArtifacts(row, contact) {
  // Bundle type is the active package tab — no per-row picker anymore.
  const type = activeType;
  // Persist any unsaved note first so the bundle reflects what's on screen.
  const note = row.querySelector('.r-note').value.trim();
  if (note !== (contact.companion_note || '')) {
    const saved = await contactRepo.update(contact.id, { companion_note: note });
    contact.companion_note = saved.companion_note;
    const tag = row.querySelector('.r-note-tag');
    if (tag) tag.innerHTML = (saved.companion_note || '').trim() ? ' <span class="badge badge-blue">note</span>' : '';
  }

  const bundle = await buildBundle(type, contact);
  const hash = compressToEncodedURIComponent(JSON.stringify(bundle));
  const url = `${SHELL_URL}#${hash}`;
  const bodyText = channelBody(bundle.kennelName, url);
  return { bundle, hash, url, bodyText };
}

// Preview modal: the exact message this recipient will receive — the SMS/email
// body text, and a live render of the page it links to. The page is the REAL
// recipient shell (companion-view.html) loaded in an iframe off the same hash a
// send would carry, so the preview can never drift from what actually renders.
// Opening it sends nothing; it's a local render of the just-built bundle.
function openPreviewModal({ bodyText, url, hash, updatedAt }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  // Wider than the default modal so the shell's 680px column renders without a
  // horizontal scrollbar; the iframe is the same static file the recipient opens.
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="max-width:820px;">
      <div class="row-between" style="align-items:flex-start; gap:12px;">
        <h2 style="margin:0;">Message preview</h2>
        <button class="btn btn-sm" id="pv-close">Close</button>
      </div>
      <p class="muted" style="margin:6px 0 12px;">Exactly what this recipient receives — the message text, and the page it links to. Opening this preview sends nothing.</p>
      <div class="field">
        <label>Message text (email &amp; SMS body)</label>
        <textarea readonly rows="4" onclick="this.select()">${esc(bodyText)}</textarea>
      </div>
      <div class="field" style="margin-top:10px;">
        <label>Recipient's page</label>
        <iframe title="Companion page preview" style="width:100%; height:66vh; border:1px solid var(--border); border-radius:8px; background:#fff;"></iframe>
        <span class="field-hint">Snapshot as of now (${esc(new Date(updatedAt).toLocaleString())}). Payload ${hash.length} chars.</span>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  // Set src after mount so the shell reads the hash and renders on load.
  overlay.querySelector('iframe').src = url;
  const done = () => overlay.remove();
  overlay.querySelector('#pv-close').addEventListener('click', done);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) done(); });
}

async function previewMessage(row, contact) {
  clearError();
  try {
    const { bundle, hash, url, bodyText } = await buildSendArtifacts(row, contact);
    openPreviewModal({ bodyText, url, hash, updatedAt: bundle.updatedAt });
  } catch (e) {
    showError(e.message || String(e));
  }
}

async function prepareLink(row, contact) {
  clearError();
  const linkBox = row.querySelector('.r-link');
  linkBox.innerHTML = `<span class="muted">Building…</span>`;
  try {
    const { bundle, hash, url, bodyText } = await buildSendArtifacts(row, contact);

    const overSms = hash.length > MAX_SMS_HASH_LEN;
    const overEmail = hash.length > MAX_EMAIL_HASH_LEN;

    const subject = encodeURIComponent(bundle.kennelName ? `Update from ${bundle.kennelName}` : 'Your update');
    const body = encodeURIComponent(bodyText);
    const mailto = `mailto:${encodeURIComponent(contact.email || '')}?subject=${subject}&body=${body}`;
    const sms = `sms:${encodeURIComponent(contact.phone || '')}?body=${body}`;

    // Email is the default channel (larger bundles ride it comfortably); SMS is
    // offered only when the payload is under the SMS ceiling.
    const emailAnchor = overEmail
      ? `<span class="inline-warn">Bundle is too large even for email (${hash.length} chars). Trim it — a family's per-pup event history is the usual culprit.</span>`
      : `<a class="btn btn-primary btn-sm" href="${esc(mailto)}">✉️ Send via email</a>`;
    const smsAnchor = overSms
      ? `<span class="muted">SMS unavailable — payload ${hash.length} chars exceeds the ${MAX_SMS_HASH_LEN}-char SMS limit; use email.</span>`
      : `<a class="btn btn-sm" href="${esc(sms)}">💬 Send via SMS</a>`;

    linkBox.innerHTML = `
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        ${emailAnchor}
        ${smsAnchor}
      </div>
      <div class="field" style="margin-top:8px;">
        <label>Or copy the link</label>
        <div style="display:flex; gap:8px; align-items:flex-start;">
          <input type="text" readonly value="${esc(url)}" onclick="this.select()">
          <button class="btn btn-sm r-copy-link" style="margin-top:0;">Copy</button>
        </div>
        <span class="field-hint">Snapshot as of now (${esc(new Date(bundle.updatedAt).toLocaleString())}). Payload ${hash.length} chars. Tap an anchor above to send.</span>
      </div>`;
    const copyBtn = linkBox.querySelector('.r-copy-link');
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(url).then(() => {
        const origText = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = origText; }, 2000);
      }).catch(() => {
        showError('Failed to copy link to clipboard');
      });
    });
  } catch (e) {
    linkBox.innerHTML = '';
    showError(e.message || String(e));
  }
}

async function refreshRecipients() {
  await loadData();
  renderRecipients();
}

async function main() {
  renderTabs();
  renderBlurb();
  renderTemplates();
  els.showArchived.addEventListener('change', refreshRecipients);
  await refreshRecipients();
}

main();
