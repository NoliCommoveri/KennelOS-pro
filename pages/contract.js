// contract.js — Contract Detail. Edit-in-place profile. Contract is a LEAF
// entity (CONTRACT_REFERENCES is empty) — nothing ever blocks its hard delete.
// Owns all three canonical links (related_sale_id, related_stud_service_id,
// related_dog_id); linking is a plain field on this record, never a two-way
// sync (Stage4 Revision v2 §5).
import { contractRepo, DOG_LINK_TYPES, CONTACT_LINK_TYPES, ReferenceBlockedError } from '../data/contractRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import { studServiceRepo } from '../data/studServiceRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { documentRepo } from '../data/documentRepo.js';
import { CONTRACT_TYPE, CONTRACT_STATUS, SEX, descriptor } from '../data/vocab.js';
import { esc, badge, fmtDate, param, confirmModal } from '../assets/ui.js';
import { openDocumentModal, openDocumentViewModal } from '../assets/documentModal.js';

const els = {
  title: document.getElementById('contract-title'),
  subtitle: document.getElementById('contract-subtitle'),
  headerActions: document.getElementById('header-actions'),
  profileActions: document.getElementById('profile-actions'),
  body: document.getElementById('profile-body'),
  error: document.getElementById('page-error')
};

const blankContract = () => ({
  contract_type: '', status: 'draft', related_sale_id: '', related_stud_service_id: '', related_dog_id: '',
  related_contact_id: '', document_url: '',
  title: '', signed_date: '', lease_start_date: '', lease_end_date: '', terms_summary: '', notes: ''
});

const ctx = {
  mode: 'view', original: null, draft: null,
  allSales: [], allStudServices: [], allDogs: [], dogsById: new Map(), contactsById: new Map()
};

async function loadRefs() {
  const [sales, studServices, dogs, contacts] = await Promise.all([
    saleRepo.getAll({ includeArchived: true }),
    studServiceRepo.getAll({ includeArchived: true }),
    dogRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true })
  ]);
  ctx.allSales = sales;
  ctx.allStudServices = studServices;
  ctx.allDogs = dogs;
  ctx.dogsById = new Map(dogs.map((d) => [d.id, d]));
  ctx.contactsById = new Map(contacts.map((c) => [c.id, c]));
}

function dogName(id) { return ctx.dogsById.get(id)?.call_name || '—'; }
function contactName(id) { return ctx.contactsById.get(id)?.name || '—'; }
function sexLetter(d) { return d.sex ? ` (${descriptor(SEX, d.sex).label[0]})` : ''; }

function saleLabel(s) {
  return `${dogName(s.dog_id)} → ${contactName(s.buyer_contact_id)}${s.sale_date ? ` (${s.sale_date})` : ''}`;
}
function studServiceLabel(ss) {
  return `${dogName(ss.our_dog_id)} × ${dogName(ss.partner_dog_id)}${ss.status ? ` — ${ss.status}` : ''}`;
}

// --- Option builders -----------------------------------------------------
function vocabOptions(vocab, current, placeholder) {
  const head = placeholder != null ? `<option value="">${esc(placeholder)}</option>` : '';
  return head + vocab.map((v) =>
    `<option value="${esc(v.value)}"${v.value === current ? ' selected' : ''}>${esc(v.label)}</option>`
  ).join('');
}

function saleOptions(current) {
  const opts = ctx.allSales
    .filter((s) => !s.is_archived || s.id === current)
    .map((s) => `<option value="${esc(s.id)}"${s.id === current ? ' selected' : ''}>${esc(saleLabel(s))}</option>`)
    .join('');
  return `<option value="">— none —</option>` + opts;
}

function studServiceOptions(current) {
  const opts = ctx.allStudServices
    .filter((s) => !s.is_archived || s.id === current)
    .map((s) => `<option value="${esc(s.id)}"${s.id === current ? ' selected' : ''}>${esc(studServiceLabel(s))}</option>`)
    .join('');
  return `<option value="">— none —</option>` + opts;
}

function dogOptions(current) {
  const opts = ctx.allDogs
    .filter((d) => !d.is_archived || d.id === current)
    .sort((a, b) => (a.call_name || '').localeCompare(b.call_name || '', undefined, { numeric: true }))
    .map((d) => `<option value="${esc(d.id)}"${d.id === current ? ' selected' : ''}>${esc(d.call_name)}${sexLetter(d)}${d.registered_name ? ' — ' + esc(d.registered_name) : ''}${d.is_archived ? ' (archived)' : ''}</option>`)
    .join('');
  return `<option value="">— none —</option>` + opts;
}

function contactOptions(current) {
  const opts = [...ctx.contactsById.values()]
    .filter((c) => !c.is_archived || c.id === current)
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true }))
    .map((c) => `<option value="${esc(c.id)}"${c.id === current ? ' selected' : ''}>${esc(c.name)}${c.is_archived ? ' (archived)' : ''}</option>`)
    .join('');
  return `<option value="">— none —</option>` + opts;
}

// --- Read-only view --------------------------------------------------------
function row(label, valueHtml) {
  return `<dt>${esc(label)}</dt><dd>${valueHtml || '<span class="faint">—</span>'}</dd>`;
}

function renderView() {
  const c = ctx.original;
  const sale = ctx.allSales.find((s) => s.id === c.related_sale_id);
  const ss = ctx.allStudServices.find((s) => s.id === c.related_stud_service_id);
  const dog = ctx.dogsById.get(c.related_dog_id);
  const contact = ctx.contactsById.get(c.related_contact_id);
  els.body.innerHTML = `
    <dl class="dl-meta" style="margin-top:14px;">
      ${row('Title', esc(c.title))}
      ${row('Type', badge(CONTRACT_TYPE, c.contract_type))}
      ${row('Status', badge(CONTRACT_STATUS, c.status))}
      ${row('Signed date', c.signed_date ? esc(fmtDate(c.signed_date)) : '')}
      ${c.contract_type === 'lease' ? row('Lease start', c.lease_start_date ? esc(fmtDate(c.lease_start_date)) : '') : ''}
      ${c.contract_type === 'lease' ? row('Lease end', c.lease_end_date ? esc(fmtDate(c.lease_end_date)) : '') : ''}
      ${DOG_LINK_TYPES.includes(c.contract_type) ? row('Related dog', dog ? `<a href="dog.html?id=${encodeURIComponent(dog.id)}">${esc(dogName(dog.id))}</a>` : '') : ''}
      ${CONTACT_LINK_TYPES.includes(c.contract_type) ? row('Counterparty', contact ? `<a href="contact.html?id=${encodeURIComponent(contact.id)}">${esc(contactName(contact.id))}</a>` : '') : ''}
      ${c.contract_type !== 'lease' ? row('Related sale', sale ? `<a href="sale.html?id=${encodeURIComponent(sale.id)}">${esc(saleLabel(sale))}</a>` : '') : ''}
      ${c.contract_type !== 'lease' ? row('Related stud service', ss ? `<a href="stud-service.html?id=${encodeURIComponent(ss.id)}">${esc(studServiceLabel(ss))}</a>` : '') : ''}
      ${row('Document link', c.document_url ? `<a href="${esc(c.document_url)}" target="_blank" rel="noopener noreferrer">${esc(c.document_url)}</a>` : '')}
      ${row('Terms summary', c.terms_summary ? esc(c.terms_summary).replace(/\n/g, '<br>') : '')}
      ${row('Notes', c.notes ? esc(c.notes).replace(/\n/g, '<br>') : '')}
    </dl>
    <div id="contract-docs" style="margin-top:18px;"></div>`;
  renderContractDocs();
}

// --- Signed-document attachment (§26.1) ------------------------------------
// The dog a filed contract document is stored under: the contract's own
// related_dog_id when it has one (lease/co_own/foster/other), else the dog
// reached through its linked Sale, else the (our, then partner) dog of its
// linked StudService. Empty string when none is reachable — the attach modal
// then simply opens with no dog preselected for the user to pick.
function resolveDogId(c) {
  if (c.related_dog_id) return c.related_dog_id;
  const sale = ctx.allSales.find((s) => s.id === c.related_sale_id);
  if (sale?.dog_id) return sale.dog_id;
  const ss = ctx.allStudServices.find((s) => s.id === c.related_stud_service_id);
  return ss?.our_dog_id || ss?.partner_dog_id || '';
}

// Render the contract's filed documents (documentRepo.getByContract — the
// reverse of the unindexed contract_id back-link) with inline view/download,
// plus the "Attach signed contract" button that opens the shared Add Document
// modal pre-filled with the resolved dog and Type = Contract.
async function renderContractDocs() {
  const host = document.getElementById('contract-docs');
  if (!host || ctx.mode !== 'view' || !ctx.original) return;
  const c = ctx.original;
  const docs = await documentRepo.getByContract(c.id);

  const rows = docs.map((d) => {
    const meta = [d.doc_date ? fmtDate(d.doc_date) : '', d.issuer_or_lab].filter(Boolean).join(' • ');
    return `
      <div class="row-between" data-doc="${esc(d.id)}"
           style="align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--border,#e2e6ec);">
        <div style="min-width:0;">
          <strong>${esc(d.title || 'Contract document')}</strong>
          ${meta ? `<div class="muted" style="font-size:13px;">${esc(meta)}</div>` : ''}
        </div>
        <div class="pill-row" style="flex:none;">
          <button class="btn btn-sm" data-act="view" data-doc="${esc(d.id)}">View / Download</button>
        </div>
      </div>`;
  }).join('');

  host.innerHTML = `
    <div class="card">
      <div class="row-between" style="align-items:baseline;">
        <h2 style="margin:0;font-size:17px;">Signed document${docs.length > 1 ? 's' : ''}</h2>
        <button class="btn btn-sm" id="btn-attach-contract">+ Attach signed contract</button>
      </div>
      ${docs.length
        ? rows
        : '<p class="faint" style="margin:10px 0 0;">No signed document filed yet. Click “Attach signed contract” to upload one.</p>'}
    </div>`;

  document.getElementById('btn-attach-contract').onclick = () => {
    openDocumentModal({
      defaultDogId: resolveDogId(c),
      defaultType: 'contract',
      contractId: c.id,
      onSaved: () => renderContractDocs()
    });
  };
  for (const btn of host.querySelectorAll('[data-act="view"]')) {
    btn.onclick = () => openDocumentViewModal({
      docId: btn.dataset.doc,
      onEdit: (id) => openDocumentModal({ existingId: id, contractId: c.id, onSaved: () => renderContractDocs() })
    });
  }
}

// --- Edit form ---------------------------------------------------------
function field(label, inner, { required = false, hint = '', wide = false } = {}) {
  return `<div class="field${wide ? ' field-wide' : ''}">
    <label>${esc(label)}${required ? ' <span class="req">*</span>' : ''}</label>
    ${inner}
    ${hint ? `<span class="field-hint">${esc(hint)}</span>` : ''}
  </div>`;
}

function renderEdit() {
  const c = ctx.draft;
  els.body.innerHTML = `
    <div class="form-grid" id="contract-form" style="margin-top:14px;">
      ${field('Title', `<input id="f-title" type="text" value="${esc(c.title)}">`)}
      ${field('Type', `<select id="f-contract_type">${vocabOptions(CONTRACT_TYPE, c.contract_type, 'Select…')}</select>`, { required: true })}
      ${field('Status', `<select id="f-status">${vocabOptions(CONTRACT_STATUS, c.status, null)}</select>`, { hint: 'Not a locked sequence — moves freely, e.g. sent → declined → sent → signed.' })}
      ${field('Signed date', `<input id="f-signed_date" type="date" value="${esc(c.signed_date)}">`)}
      ${c.contract_type === 'lease' ? field('Lease start', `<input id="f-lease_start_date" type="date" value="${esc(c.lease_start_date)}">`) : ''}
      ${c.contract_type === 'lease' ? field('Lease end', `<input id="f-lease_end_date" type="date" value="${esc(c.lease_end_date)}">`) : ''}
      ${DOG_LINK_TYPES.includes(c.contract_type) ? field('Related dog', `<select id="f-related_dog_id">${dogOptions(c.related_dog_id)}</select>`, { hint: 'The dog this contract is about.' }) : ''}
      ${CONTACT_LINK_TYPES.includes(c.contract_type) ? field('Counterparty', `<select id="f-related_contact_id">${contactOptions(c.related_contact_id)}</select>`, { hint: 'The other party (lessee, co-owner, partner). Scopes this contract into their companion bundle.' }) : ''}
      ${c.contract_type !== 'lease' ? field('Related sale', `<select id="f-related_sale_id">${saleOptions(c.related_sale_id)}</select>`) : ''}
      ${c.contract_type !== 'lease' ? field('Related stud service', `<select id="f-related_stud_service_id">${studServiceOptions(c.related_stud_service_id)}</select>`) : ''}
      ${field('Document link', `<input id="f-document_url" type="url" value="${esc(c.document_url || '')}" placeholder="https://…">`, { hint: 'Share link to the signed document (e.g. a Google Drive "anyone with the link" URL). Carried as a pointer into the buyer bundle.' })}
      ${field('Terms summary', `<textarea id="f-terms_summary">${esc(c.terms_summary)}</textarea>`, { wide: true })}
      ${field('Notes', `<textarea id="f-notes">${esc(c.notes)}</textarea>`, { wide: true })}
    </div>
    <div id="form-warn"></div>`;

  const form = document.getElementById('contract-form');
  form.addEventListener('input', updateWarnings);
  form.addEventListener('change', updateWarnings);
  document.getElementById('f-contract_type').addEventListener('change', () => {
    ctx.draft = readForm();
    renderEdit();
  });
  updateWarnings();
}

function updateWarnings() {
  const s = readForm();
  const warns = [];
  if (s.lease_start_date && s.lease_end_date && s.lease_end_date < s.lease_start_date) warns.push('Lease end date is before the lease start date.');
  const box = document.getElementById('form-warn');
  if (box) box.innerHTML = warns.length ? `<div class="inline-warn">${warns.map(esc).join('<br>')}</div>` : '';
}

function readForm() {
  const val = (id) => document.getElementById(id)?.value ?? '';
  return {
    ...ctx.draft,
    title: val('f-title').trim(),
    contract_type: val('f-contract_type'),
    status: val('f-status') || 'draft',
    signed_date: val('f-signed_date'),
    lease_start_date: val('f-lease_start_date'),
    lease_end_date: val('f-lease_end_date'),
    // The field only exists in the DOM for DOG_LINK_TYPES — when it's hidden
    // (type not yet chosen, or briefly a non-dog type mid-edit), fall back to
    // whatever's already in the draft instead of clobbering a prefill/prior
    // selection. contractRepo normalizes it to null on save if the final type
    // doesn't call for it.
    related_dog_id: document.getElementById('f-related_dog_id') ? (val('f-related_dog_id') || null) : (ctx.draft.related_dog_id || null),
    // Same hidden-field fallback as related_dog_id: the counterparty select only
    // exists in the DOM for CONTACT_LINK_TYPES. contractRepo normalizes it to null
    // on save when the final type doesn't call for it.
    related_contact_id: document.getElementById('f-related_contact_id') ? (val('f-related_contact_id') || null) : (ctx.draft.related_contact_id || null),
    // Related sale and stud service fields are hidden for lease contracts
    related_sale_id: document.getElementById('f-related_sale_id') ? (val('f-related_sale_id') || null) : (ctx.draft.related_sale_id || null),
    related_stud_service_id: document.getElementById('f-related_stud_service_id') ? (val('f-related_stud_service_id') || null) : (ctx.draft.related_stud_service_id || null),
    document_url: val('f-document_url').trim(),
    terms_summary: val('f-terms_summary'),
    notes: val('f-notes')
  };
}

// --- Actions -------------------------------------------------------------
function renderProfileActions() {
  if (ctx.mode === 'view') {
    els.profileActions.innerHTML = `<button class="btn btn-sm" id="btn-edit">Edit</button>`;
    document.getElementById('btn-edit').onclick = enterEdit;
  } else {
    els.profileActions.innerHTML = `
      <button class="btn btn-primary btn-sm" id="btn-save">Save</button>
      <button class="btn btn-sm" id="btn-cancel">Cancel</button>`;
    document.getElementById('btn-save').onclick = save;
    document.getElementById('btn-cancel').onclick = cancel;
  }
}

async function renderHeaderActions() {
  els.headerActions.innerHTML = '';
  if (ctx.mode === 'new' || !ctx.original) return;
  const c = ctx.original;
  const archiveLabel = c.is_archived ? 'Unarchive' : 'Archive';
  // Contract is a leaf (CONTRACT_REFERENCES is empty) — always hard-deletable.
  els.headerActions.innerHTML = `
    <button class="btn btn-sm" id="btn-archive">${archiveLabel}</button>
    <button class="btn btn-danger btn-sm" id="btn-delete" title="Permanently delete this record.">Delete</button>`;
  document.getElementById('btn-archive').onclick = toggleArchive;
  document.getElementById('btn-delete').onclick = doDelete;
}

function showError(msg) {
  els.error.innerHTML = `<div class="inline-error">${esc(msg)}</div>`;
  els.error.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function clearError() { els.error.innerHTML = ''; }

function enterEdit() {
  clearError();
  ctx.mode = 'edit';
  ctx.draft = { ...ctx.original };
  renderEdit();
  renderProfileActions();
}

function cancel() {
  clearError();
  if (ctx.mode === 'new') { location.href = 'contracts.html'; return; }
  ctx.mode = 'view';
  renderView();
  renderProfileActions();
}

// Guards against a rapid double-tap/double-click firing save() twice before
// the first call's await chain has a chance to disable anything itself —
// each call would otherwise run to completion independently, e.g. creating
// two contracts from one "Save" tap.
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
      const saved = await contractRepo.create(candidate);
      location.href = `contract.html?id=${encodeURIComponent(saved.id)}`;
      return;
    }
    const saved = await contractRepo.update(ctx.original.id, candidate);
    ctx.original = saved;
    ctx.mode = 'view';
    renderAll();
  } catch (e) {
    showError(e.message || String(e));
  }
}

async function toggleArchive() {
  const c = ctx.original;
  const verb = c.is_archived ? 'Unarchive' : 'Archive';
  if (!(await confirmModal({ title: `${verb} this contract?`, confirmLabel: verb }))) return;
  ctx.original = c.is_archived ? await contractRepo.unarchive(c.id) : await contractRepo.archive(c.id);
  renderAll();
}

async function doDelete() {
  const c = ctx.original;
  if (!(await confirmModal({ title: 'Delete this contract?', message: 'Permanently delete this contract? This cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
  try {
    await contractRepo.hardDelete(c.id);
    location.href = 'contracts.html';
  } catch (e) {
    if (e instanceof ReferenceBlockedError) { showError(e.message); await renderHeaderActions(); }
    else showError(e.message || String(e));
  }
}

// --- Top-level render ------------------------------------------------------
function renderTitle() {
  if (ctx.mode === 'new') {
    els.title.textContent = 'New Contract';
    els.subtitle.textContent = 'Choose a type, then save.';
    return;
  }
  const c = ctx.original;
  els.title.innerHTML = esc(c.title || '(untitled contract)') + (c.is_archived ? ' <span class="badge badge-gray">Archived</span>' : '');
  els.subtitle.innerHTML = '';
}

function renderAll() {
  renderTitle();
  renderProfileActions();
  renderHeaderActions();
  if (ctx.mode === 'view') renderView();
  else renderEdit();
}

async function main() {
  await loadRefs();
  const id = param('id');
  const isNew = param('new');

  if (isNew) {
    ctx.mode = 'new';
    ctx.draft = blankContract();
    const saleId = param('sale');
    if (saleId && ctx.allSales.some((s) => s.id === saleId)) {
      ctx.draft.related_sale_id = saleId;
      ctx.draft.contract_type = 'sale';
    }
    const studServiceId = param('stud_service');
    if (studServiceId && ctx.allStudServices.some((s) => s.id === studServiceId)) {
      ctx.draft.related_stud_service_id = studServiceId;
      ctx.draft.contract_type = 'stud_service';
    }
    // No single contract_type fits a dog deep-link (lease/co_own/other all
    // qualify) — prefill the dog and let the user pick the type.
    const dogId = param('dog');
    if (dogId && ctx.dogsById.has(dogId)) ctx.draft.related_dog_id = dogId;
    renderTitle();
    renderEdit();
    renderProfileActions();
    renderHeaderActions();
    return;
  }

  if (!id) { showError('No contract id provided.'); return; }
  const c = await contractRepo.getById(id);
  if (!c) { showError('Contract not found. It may have been deleted.'); return; }
  ctx.original = c;
  ctx.mode = 'view';
  renderAll();
}

main();
