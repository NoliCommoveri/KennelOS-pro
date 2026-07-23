// contact.js — Contact Detail (edit-in-place). Includes inline "add new kennel"
// from the kennel field (Build Brief B1) and a read-only list of dogs owned or
// co-owned by this contact (derived via owner_contact_id + the co-owner index).
import { contactRepo } from '../data/contactRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { dogRepo, ReferenceBlockedError } from '../data/dogRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import { CONTACT_TYPE, DOG_STATUS, WAITLIST_STATUS, SALE_STATUS, PLACEMENT_TYPE } from '../data/vocab.js';
import { esc, badge, badges, param, confirmModal, promptModal } from '../assets/ui.js';

const els = {
  title: document.getElementById('contact-title'),
  headerActions: document.getElementById('header-actions'),
  profileActions: document.getElementById('profile-actions'),
  body: document.getElementById('profile-body'),
  error: document.getElementById('page-error'),
  dogs: document.getElementById('dogs-section'),
  sales: document.getElementById('sales-section')
};

const blank = () => ({
  name: '', kennel_id: '', contact_type: [], phone: '', email: '', address: '',
  waitlist_status: '', first_contact_source: '', notes: '', companion_note: ''
});

const ctx = {
  mode: 'view', original: null, draft: null, kennels: [], firstContactSources: [],
  // Collapsible card state — tracks which cards are expanded (mirrors dog.js)
  expandedCards: new Set()
};

// Helper to create a collapsible card. The card auto-collapses when empty.
// If hasContent is false, the card starts collapsed with an empty badge.
// The toggle button for the card should be passed in headerButton.
function renderCollapsibleCard(title, bodyHtml, headerButton = '', { sectionKey = '', hasContent = true } = {}) {
  const isExpanded = ctx.expandedCards.has(sectionKey) || hasContent;
  const toggleId = `${sectionKey}-toggle`;

  return `
    <section class="card" style="margin-top:16px;">
      <div class="row-between">
        <div class="collapsible-header" style="flex: 1; display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none;" data-toggle="${toggleId}">
          <span class="collapsible-arrow" style="transform: rotate(${isExpanded ? '90deg' : '0deg'}); display: inline-block; transition: transform 0.2s; font-size: 12px;">▶</span>
          <h2 style="margin:0;">${esc(title)}${!hasContent ? ' <span class="badge badge-gray">empty</span>' : ''}</h2>
        </div>
        <div id="${toggleId}-actions" class="pill-row">${headerButton}</div>
      </div>
      <div class="collapsible-content" id="${toggleId}-content" style="display: ${isExpanded ? 'block' : 'none'}; margin-top:12px;">
        ${bodyHtml}
      </div>
    </section>`;
}

// Setup collapsible functionality for a card
function setupCollapsibleCard(sectionKey) {
  const toggleId = `${sectionKey}-toggle`;
  const header = document.querySelector(`[data-toggle="${toggleId}"]`);
  const content = document.getElementById(`${toggleId}-content`);
  const arrow = header?.querySelector('.collapsible-arrow');

  if (!header || !content) return;

  header.addEventListener('click', () => {
    const isExpanded = ctx.expandedCards.has(sectionKey);
    if (isExpanded) {
      ctx.expandedCards.delete(sectionKey);
      content.style.display = 'none';
      if (arrow) arrow.style.transform = 'rotate(0deg)';
    } else {
      ctx.expandedCards.add(sectionKey);
      content.style.display = 'block';
      if (arrow) arrow.style.transform = 'rotate(90deg)';
    }
  });
}

async function loadKennels() {
  const [kennels, sources] = await Promise.all([
    kennelRepo.getAll({ includeArchived: true }),
    contactRepo.getFirstContactSources()
  ]);
  ctx.kennels = kennels;
  ctx.firstContactSources = sources;
}
function kennelName(id) { return ctx.kennels.find((k) => k.id === id)?.kennel_name || ''; }

function showError(msg) { els.error.innerHTML = `<div class="inline-error">${esc(msg)}</div>`; }
function clearError() { els.error.innerHTML = ''; }

// --- Read-only view ------------------------------------------------------
// Hides the field entirely until it has a value (matches dog.js's Profile card).
function row(label, valueHtml) { return valueHtml ? `<dt>${esc(label)}</dt><dd>${valueHtml}</dd>` : ''; }

function renderView() {
  const c = ctx.original;
  els.body.innerHTML = `
    <dl class="dl-meta" style="margin-top:14px;">
      ${row('Name', esc(c.name))}
      ${row('Type', (c.contact_type || []).length ? badges(CONTACT_TYPE, c.contact_type) : '')}
      ${row('Waitlist', c.waitlist_status && c.waitlist_status !== 'none' ? badge(WAITLIST_STATUS, c.waitlist_status) : '')}
      ${row('First contact source', esc(c.first_contact_source))}
      ${row('Kennel', esc(kennelName(c.kennel_id)))}
      ${row('Phone', esc(c.phone))}
      ${row('Email', esc(c.email))}
      ${row('Address', c.address ? esc(c.address).replace(/\n/g, '<br>') : '')}
      ${row('Notes', c.notes ? esc(c.notes).replace(/\n/g, '<br>') : '')}
      ${row('Companion note', c.companion_note ? esc(c.companion_note).replace(/\n/g, '<br>') : '')}
    </dl>`;
}

// --- Edit form -----------------------------------------------------------
function kennelOptions(current) {
  return `<option value="">— none —</option>` + ctx.kennels
    .filter((k) => !k.is_archived || k.id === current)
    .map((k) => `<option value="${esc(k.id)}"${k.id === current ? ' selected' : ''}>${esc(k.kennel_name)}${k.is_archived ? ' (archived)' : ''}</option>`)
    .join('');
}

function renderEdit() {
  const c = ctx.draft;
  const typeChecks = CONTACT_TYPE.map((t) => `
    <label class="check-inline">
      <input type="checkbox" data-type="${esc(t.value)}"${(c.contact_type || []).includes(t.value) ? ' checked' : ''}> ${esc(t.label)}
    </label>`).join('');
  const waitlistOpts = `<option value="">— none —</option>` + WAITLIST_STATUS.filter((w) => w.value !== 'none')
    .map((w) => `<option value="${esc(w.value)}"${w.value === c.waitlist_status ? ' selected' : ''}>${esc(w.label)}</option>`).join('');
  const sourceList = ctx.firstContactSources.map((s) => `<option value="${esc(s)}"></option>`).join('');

  els.body.innerHTML = `
    <div class="form-grid" id="c-form" style="margin-top:14px;">
      <div class="field"><label>Name <span class="req">*</span></label><input id="f-name" type="text" value="${esc(c.name)}"></div>
      <div class="field"><label>Kennel</label>
        <div style="display:flex; gap:8px;">
          <select id="f-kennel_id" style="flex:1;">${kennelOptions(c.kennel_id)}</select>
          <button type="button" class="btn btn-sm" id="btn-add-kennel">+ New</button>
        </div>
      </div>
      <div class="field"><label>Phone</label><input id="f-phone" type="text" value="${esc(c.phone)}"></div>
      <div class="field"><label>Email</label><input id="f-email" type="email" value="${esc(c.email)}"></div>
      <div class="field"><label>Waitlist</label><select id="f-waitlist_status">${waitlistOpts}</select></div>
      <div class="field"><label>First contact source</label><input id="f-first_contact_source" type="text" list="source-list" value="${esc(c.first_contact_source)}"><datalist id="source-list">${sourceList}</datalist></div>
      <div class="field field-wide"><label>Type</label><div class="check-group">${typeChecks}</div></div>
      <div class="field field-wide"><label>Address</label><textarea id="f-address">${esc(c.address)}</textarea></div>
      <div class="field field-wide"><label>Notes</label><textarea id="f-notes">${esc(c.notes)}</textarea></div>
      <div class="field field-wide"><label>Companion note</label><textarea id="f-companion_note" placeholder="A personal line shown to this recipient on their companion link (overrides the per-type announcement). Leave blank to use the default.">${esc(c.companion_note || '')}</textarea><span class="field-hint">Meant for the recipient’s eyes — distinct from the private Notes above. Appears on their companion share page.</span></div>
    </div>`;

  document.getElementById('btn-add-kennel').addEventListener('click', addKennelInline);
}

function readForm() {
  const val = (id) => document.getElementById(id)?.value ?? '';
  const types = [...document.querySelectorAll('[data-type]')].filter((el) => el.checked).map((el) => el.dataset.type);
  return {
    ...ctx.draft,
    name: val('f-name').trim(),
    kennel_id: val('f-kennel_id') || null,
    contact_type: types,
    phone: val('f-phone').trim(),
    email: val('f-email').trim(),
    waitlist_status: val('f-waitlist_status') || 'none',
    first_contact_source: val('f-first_contact_source').trim(),
    address: val('f-address').trim(),
    notes: val('f-notes'),
    companion_note: val('f-companion_note').trim()
  };
}

async function addKennelInline() {
  const name = await promptModal({ title: 'New kennel', label: 'Kennel name', confirmLabel: 'Create' });
  if (!name) return;
  try {
    ctx.draft = readForm();
    const kennel = await kennelRepo.create({ kennel_name: name });
    await loadKennels();
    ctx.draft.kennel_id = kennel.id;
    renderEdit();
  } catch (e) {
    showError(e.message || String(e));
  }
}

// --- Owned / co-owned dogs list -----------------------------------------
async function renderDogsSection() {
  if (ctx.mode !== 'view' || !ctx.original) { els.dogs.innerHTML = ''; return; }
  const dogs = await contactRepo.getDogs(ctx.original.id);
  const bodyHtml = dogs.length
    ? `<table class="data"><thead><tr><th>Call name</th><th>Registered</th><th>Status</th><th>Role</th></tr></thead><tbody>${
        dogs.map((d) => {
          const role = d.owner_contact_id === ctx.original.id ? 'Owner' : 'Co-owner';
          return `<tr class="clickable" data-id="${esc(d.id)}"><td><strong>${esc(d.call_name)}</strong></td><td>${d.registered_name ? esc(d.registered_name) : '<span class="faint">—</span>'}</td><td>${badge(DOG_STATUS, d.status)}</td><td>${role}</td></tr>`;
        }).join('')
      }</tbody></table>`
    : `<div class="empty-state">No dogs linked to this contact. Ownership is edited from the dog’s own record.</div>`;

  const hasContent = dogs.length > 0;
  els.dogs.innerHTML = renderCollapsibleCard('Dogs owned or co-owned', bodyHtml, '', { sectionKey: 'dogs', hasContent });
  els.dogs.querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.addEventListener('click', () => { location.href = `dog.html?id=${encodeURIComponent(tr.dataset.id)}`; });
  });
  setupCollapsibleCard('dogs');
}

// --- Sales (as buyer) list -------------------------------------------------
// Shown (collapsed if empty) for buyer-type contacts, or any contact that
// already has sales on record — same "relevant or has history" gating dog.js
// uses for its Sales/Stud Services/Contracts panels.
async function renderSalesSection() {
  if (ctx.mode !== 'view' || !ctx.original) { els.sales.innerHTML = ''; return; }
  const c = ctx.original;
  const sales = await saleRepo.getByBuyer(c.id);
  if (!sales.length && !(c.contact_type || []).includes('buyer')) { els.sales.innerHTML = ''; return; }
  const dogs = await dogRepo.getAll({ includeArchived: true });
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const bodyHtml = sales.length
    ? `<ul class="linked-list" style="margin:14px 0 0; padding:0; list-style:none;">` + sales.map((s) => {
        const dog = dogsById.get(s.dog_id);
        return `<li class="row-between" style="padding:8px 0; border-top:1px solid var(--border);">
          <span>${badge(PLACEMENT_TYPE, s.placement_type)} <strong>${esc(dog ? dog.call_name : '—')}</strong> ${badge(SALE_STATUS, s.status)}${s.sale_date ? ` <span class="faint">${esc(s.sale_date)}</span>` : ''}</span>
          <a class="btn btn-sm" href="sale.html?id=${encodeURIComponent(s.id)}">Open →</a>
        </li>`;
      }).join('') + `</ul>`
    : `<p class="muted" style="margin:14px 0 0;">No sales recorded for this contact yet.</p>`;

  const hasContent = sales.length > 0;
  els.sales.innerHTML = renderCollapsibleCard('Sales (as buyer)', bodyHtml, '', { sectionKey: 'sales', hasContent });
  setupCollapsibleCard('sales');
}

// --- Actions -------------------------------------------------------------
function renderProfileActions() {
  if (ctx.mode === 'view') {
    els.profileActions.innerHTML = `<button class="btn btn-sm" id="btn-edit">Edit</button>`;
    document.getElementById('btn-edit').onclick = enterEdit;
  } else {
    els.profileActions.innerHTML = `<button class="btn btn-primary btn-sm" id="btn-save">Save</button><button class="btn btn-sm" id="btn-cancel">Cancel</button>`;
    document.getElementById('btn-save').onclick = save;
    document.getElementById('btn-cancel').onclick = cancel;
  }
}

async function renderHeaderActions() {
  els.headerActions.innerHTML = '';
  if (ctx.mode === 'new' || !ctx.original) return;
  const c = ctx.original;
  const blockers = await contactRepo.getDeleteBlockers(c.id);
  const delTitle = blockers.length
    ? 'Referenced as ' + blockers.map((b) => `${b.label} (${b.count})`).join(', ') + ' — archive instead.'
    : 'Permanently delete this contact.';
  els.headerActions.innerHTML = `
    <button class="btn btn-sm" id="btn-archive">${c.is_archived ? 'Unarchive' : 'Archive'}</button>
    <button class="btn btn-danger btn-sm" id="btn-delete"${blockers.length ? ' disabled' : ''} title="${esc(delTitle)}">Delete</button>`;
  document.getElementById('btn-archive').onclick = toggleArchive;
  if (!blockers.length) document.getElementById('btn-delete').onclick = doDelete;
}

function enterEdit() {
  clearError();
  ctx.mode = 'edit';
  ctx.draft = { ...ctx.original, contact_type: [...(ctx.original.contact_type || [])] };
  renderEdit();
  renderProfileActions();
  renderDogsSection();
  renderSalesSection();
}

function cancel() {
  clearError();
  if (ctx.mode === 'new') { location.href = 'contacts.html'; return; }
  ctx.mode = 'view';
  renderView();
  renderProfileActions();
  renderDogsSection();
  renderSalesSection();
}

// Guards against a rapid double-tap/double-click firing save() twice before
// the first call's await chain has a chance to disable anything itself —
// each call would otherwise run to completion independently, e.g. creating
// two contacts from one "Save" tap.
async function save() {
  const btn = document.getElementById('btn-save');
  if (btn?.disabled) return;
  if (btn) btn.disabled = true;
  try {
    await doSave();
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function doSave() {
  clearError();
  const candidate = readForm();
  try {
    if (ctx.mode === 'new') {
      const saved = await contactRepo.create(candidate);
      location.href = `contact.html?id=${encodeURIComponent(saved.id)}`;
      return;
    }
    ctx.original = await contactRepo.update(ctx.original.id, candidate);
    ctx.mode = 'view';
    renderAll();
  } catch (e) {
    showError(e.message || String(e));
  }
}

async function toggleArchive() {
  const c = ctx.original;
  const verb = c.is_archived ? 'Unarchive' : 'Archive';
  if (!(await confirmModal({ title: `${verb} “${c.name}”?`, confirmLabel: verb }))) return;
  ctx.original = c.is_archived ? await contactRepo.unarchive(c.id) : await contactRepo.archive(c.id);
  renderAll();
}

async function doDelete() {
  const c = ctx.original;
  if (!(await confirmModal({ title: `Delete “${c.name}”?`, message: 'This cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
  try {
    await contactRepo.hardDelete(c.id);
    location.href = 'contacts.html';
  } catch (e) {
    if (e instanceof ReferenceBlockedError) { showError(e.message); renderHeaderActions(); }
    else showError(e.message || String(e));
  }
}

// --- Top-level -----------------------------------------------------------
function renderTitle() {
  if (ctx.mode === 'new') { els.title.textContent = 'New Contact'; return; }
  const c = ctx.original;
  els.title.innerHTML = esc(c.name) + (c.is_archived ? ' <span class="badge badge-gray">Archived</span>' : '');
}

function renderAll() {
  renderTitle();
  renderProfileActions();
  renderHeaderActions();
  if (ctx.mode === 'view') renderView();
  else renderEdit();
  renderDogsSection();
  renderSalesSection();
}

async function main() {
  await loadKennels();
  const id = param('id');
  if (param('new')) {
    ctx.mode = 'new';
    ctx.draft = blank();
    renderTitle();
    renderEdit();
    renderProfileActions();
    return;
  }
  if (!id) { showError('No contact id provided.'); return; }
  const contact = await contactRepo.getById(id);
  if (!contact) { showError('Contact not found.'); return; }
  ctx.original = contact;
  ctx.mode = 'view';
  renderAll();
}

main();
