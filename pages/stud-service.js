// stud-service.js — Stud Service Detail. Edit-in-place profile, including the
// canonical `pairing_id` link (mirrors Litter's "Linked pairing" field — this
// entity OWNS the pointer, so it's a plain editable field, not a derived panel)
// plus a convenience to create the pairing when none is linked yet. A derived
// Contracts panel (contracts.related_stud_service_id = this — canonical on
// Contract, Stage4 Revision v2 §5).
import { studServiceRepo, ReferenceBlockedError } from '../data/studServiceRepo.js';
import { contractRepo } from '../data/contractRepo.js';
import { pairingRepo } from '../data/pairingRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import {
  STUD_SERVICE_DIRECTION, FEE_STRUCTURE, STUD_SERVICE_STATUS, STUD_SERVICE_TYPE,
  CONTRACT_TYPE, CONTRACT_STATUS, SEX, descriptor
} from '../data/vocab.js';
import { esc, badge, fmtDate, param, confirmModal } from '../assets/ui.js';
import { getMyContactId } from '../data/kennelSetup.js';
import { attachNewContactButton } from '../assets/contactPicker.js';

const els = {
  title: document.getElementById('ss-title'),
  subtitle: document.getElementById('ss-subtitle'),
  headerActions: document.getElementById('header-actions'),
  profileActions: document.getElementById('profile-actions'),
  body: document.getElementById('profile-body'),
  error: document.getElementById('page-error'),
  contracts: document.getElementById('contracts-section')
};

const blankStudService = () => ({
  direction: '', our_dog_id: '', partner_dog_id: '', partner_contact_id: '',
  fee_amount: '', fee_structure: '', pick_status: '', pick_value_amount: '', pairing_id: '', status: '', result_notes: '', notes: '',
  sent_date: '', returned_date: '', type: '', referred_by_contact_id: ''
});

// pick_status is only meaningful when the fee structure includes a pick component
// (Companion feature §1). Elsewhere it stays null so a flat_fee arrangement never
// shows a stray "pending".
const FEE_STRUCTURES_WITH_PICK = ['pick_of_litter', 'flat_plus_pick'];
function feeHasPick(structure) { return FEE_STRUCTURES_WITH_PICK.includes(structure); }

const ctx = {
  mode: 'view', original: null, draft: null, pickerArchived: false,
  allDogs: [], allContacts: [], allPairings: [],
  dogsById: new Map(), contactsById: new Map(), pairingsById: new Map()
};

async function loadRefs() {
  const [dogs, contacts, pairings] = await Promise.all([
    dogRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true }),
    pairingRepo.getAll({ includeArchived: true })
  ]);
  ctx.allDogs = dogs;
  ctx.allContacts = contacts;
  ctx.allPairings = pairings;
  ctx.dogsById = new Map(dogs.map((d) => [d.id, d]));
  ctx.contactsById = new Map(contacts.map((c) => [c.id, c]));
  ctx.pairingsById = new Map(pairings.map((p) => [p.id, p]));
}

function dogName(id) {
  const d = ctx.dogsById.get(id);
  return d ? (d.call_name + (d.registered_name ? ` (${d.registered_name})` : '')) : '';
}
function contactName(id) { return ctx.contactsById.get(id)?.name || ''; }
function pairingLabel(p) {
  if (!p) return '';
  return `${dogName(p.sire_id) || '—'} × ${dogName(p.dam_id) || '—'}${p.planned_date ? ` (${fmtDate(p.planned_date)})` : ''}`;
}

// --- Option builders -----------------------------------------------------
function vocabOptions(vocab, current, placeholder) {
  const head = placeholder != null ? `<option value="">${esc(placeholder)}</option>` : '';
  return head + vocab.map((v) =>
    `<option value="${esc(v.value)}"${v.value === current ? ' selected' : ''}>${esc(v.label)}</option>`
  ).join('');
}

function sexLetter(d) {
  return d.sex ? ` (${descriptor(SEX, d.sex).label[0]})` : '';
}

// Owned/co-owned active breeders only — males first, then by call name. The
// current selection always stays in the list (edit safety) even if it no
// longer matches. Once direction is set, our dog is the stud (outgoing =
// male) or the dam (incoming = female) — filter to that sex.
function ourDogOptions(current, direction) {
  const list = ctx.allDogs
    .filter((d) => (['owned', 'co_owned'].includes(d.ownership_type) && d.status === 'active_breeding') || d.id === current)
    .filter((d) => ctx.pickerArchived || !d.is_archived || d.id === current)
    .filter((d) => d.id === current || direction !== 'outgoing' || d.sex === 'male')
    .filter((d) => d.id === current || direction !== 'incoming' || d.sex === 'female')
    .sort((a, b) => {
      const rank = (d) => (d.sex === 'male' ? 0 : d.sex === 'female' ? 1 : 2);
      const r = rank(a) - rank(b);
      return r !== 0 ? r : (a.call_name || '').localeCompare(b.call_name || '', undefined, { numeric: true });
    });
  const opts = list
    .map((d) => `<option value="${esc(d.id)}"${d.id === current ? ' selected' : ''}>${esc(d.call_name)}${sexLetter(d)}${d.registered_name ? ' — ' + esc(d.registered_name) : ''}${d.is_archived ? ' (archived)' : ''}</option>`)
    .join('');
  return `<option value="">— select —</option>` + opts;
}

// External dogs only — the outside partner. Once direction is set, the
// partner is the opposite role from our dog: outgoing (our dog is the stud)
// means the partner is the dam (female); incoming means the partner is the
// stud (male).
function partnerDogOptions(current, direction) {
  const opts = ctx.allDogs
    .filter((d) => d.ownership_type === 'external' || d.id === current)
    .filter((d) => ctx.pickerArchived || !d.is_archived || d.id === current)
    .filter((d) => d.id === current || direction !== 'outgoing' || d.sex === 'female')
    .filter((d) => d.id === current || direction !== 'incoming' || d.sex === 'male')
    .map((d) => `<option value="${esc(d.id)}"${d.id === current ? ' selected' : ''}>${esc(d.call_name)}${sexLetter(d)}${d.registered_name ? ' — ' + esc(d.registered_name) : ''}${d.is_archived ? ' (archived)' : ''}</option>`)
    .join('');
  return `<option value="">— select —</option>` + opts;
}

// Other breeders only — never the user themselves.
function contactOptions(current) {
  const myContactId = getMyContactId();
  const opts = ctx.allContacts
    .filter((c) => c.id === current || ((c.contact_type || []).includes('breeder') && c.id !== myContactId))
    .filter((c) => ctx.pickerArchived || !c.is_archived || c.id === current)
    .map((c) => `<option value="${esc(c.id)}"${c.id === current ? ' selected' : ''}>${esc(c.name)}${c.is_archived ? ' (archived)' : ''}</option>`)
    .join('');
  return `<option value="">— select —</option>` + opts;
}

// Any contact (unlike the breeder-only partner picker) — a referrer needn't be
// a breeder in your network.
function referrerContactOptions(current) {
  const opts = ctx.allContacts
    .filter((c) => ctx.pickerArchived || !c.is_archived || c.id === current)
    .map((c) => `<option value="${esc(c.id)}"${c.id === current ? ' selected' : ''}>${esc(c.name)}${c.is_archived ? ' (archived)' : ''}</option>`)
    .join('');
  return `<option value="">— none —</option>` + opts;
}

function pairingOptions(current) {
  const opts = ctx.allPairings
    .filter((p) => ctx.pickerArchived || !p.is_archived || p.id === current)
    .map((p) => `<option value="${esc(p.id)}"${p.id === current ? ' selected' : ''}>${esc(pairingLabel(p))}${p.is_archived ? ' (archived)' : ''}</option>`)
    .join('');
  return `<option value="">— none —</option>` + opts;
}

// --- Read-only view --------------------------------------------------------
function row(label, valueHtml) {
  return `<dt>${esc(label)}</dt><dd>${valueHtml || '<span class="faint">—</span>'}</dd>`;
}

function money(v) { return v != null && v !== '' ? `$${Number(v).toFixed(2)}` : ''; }

function renderView() {
  const s = ctx.original;
  const pairing = ctx.pairingsById.get(s.pairing_id);
  const pairingHtml = pairing
    ? `<a href="pairing.html?id=${encodeURIComponent(pairing.id)}">${esc(pairingLabel(pairing))}</a>`
    : `<a class="btn btn-sm" href="pairing.html?new=1&stud_service=${encodeURIComponent(s.id)}">+ Create Pairing from this Stud Service</a>`;
  els.body.innerHTML = `
    <dl class="dl-meta" style="margin-top:14px;">
      ${row('Direction', badge(STUD_SERVICE_DIRECTION, s.direction))}
      ${row('Our dog', `<a href="dog.html?id=${encodeURIComponent(s.our_dog_id)}">${esc(dogName(s.our_dog_id) || '—')}</a>`)}
      ${row('Partner dog', s.partner_dog_id ? `<a href="dog.html?id=${encodeURIComponent(s.partner_dog_id)}">${esc(dogName(s.partner_dog_id) || '—')}</a>` : '')}
      ${row('Partner contact', s.partner_contact_id ? `<a href="contact.html?id=${encodeURIComponent(s.partner_contact_id)}">${esc(contactName(s.partner_contact_id) || '—')}</a>` : '')}
      ${row('Fee', esc(money(s.fee_amount)) + (s.fee_structure ? ` <span class="faint">(${esc((FEE_STRUCTURE.find(f => f.value === s.fee_structure) || {}).label || s.fee_structure)})</span>` : ''))}
      ${feeHasPick(s.fee_structure) ? row('Pick status', s.pick_status ? esc(s.pick_status) : '') : ''}
      ${feeHasPick(s.fee_structure) ? row('Pick value', esc(money(s.pick_value_amount))) : ''}
      ${row('Linked pairing', pairingHtml)}
      ${row('Status', badge(STUD_SERVICE_STATUS, s.status))}
      ${row('Referred by', s.referred_by_contact_id ? `<a href="contact.html?id=${encodeURIComponent(s.referred_by_contact_id)}">${esc(contactName(s.referred_by_contact_id) || '—')}</a>` : '')}
      ${row('Type', s.type ? badge(STUD_SERVICE_TYPE, s.type) : '')}
      ${row('Sent', s.sent_date ? esc(fmtDate(s.sent_date)) : '')}
      ${row('Returned', s.returned_date ? esc(fmtDate(s.returned_date)) : '')}
      ${row('Result notes', s.result_notes ? esc(s.result_notes).replace(/\n/g, '<br>') : '')}
      ${row('Notes', s.notes ? esc(s.notes).replace(/\n/g, '<br>') : '')}
    </dl>`;
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
  const s = ctx.draft;
  els.body.innerHTML = `
    <div class="form-grid" id="ss-form" style="margin-top:14px;">
      ${field('Direction', `<select id="f-direction">${vocabOptions(STUD_SERVICE_DIRECTION, s.direction, 'Select…')}</select>`, { required: true, hint: 'Outgoing = our dog is the stud. Incoming = our dog is the dam.' })}
      ${field('Our dog', `<select id="f-our_dog_id">${ourDogOptions(s.our_dog_id, s.direction)}</select>`, { required: true })}
      ${field('Partner dog', `<select id="f-partner_dog_id">${partnerDogOptions(s.partner_dog_id, s.direction)}</select>`, { required: true })}
      ${field('Partner contact', `<select id="f-partner_contact_id">${contactOptions(s.partner_contact_id)}</select>`, { required: true, hint: 'Owner of the partner dog.' })}
      ${field('Fee amount', `<input id="f-fee_amount" type="number" min="0" step="0.01" value="${esc(s.fee_amount)}">`)}
      ${field('Fee structure', `<select id="f-fee_structure">${vocabOptions(FEE_STRUCTURE, s.fee_structure, '— none —')}</select>`)}
      ${feeHasPick(s.fee_structure) ? field('Pick status', `<input id="f-pick_status" type="text" list="pick-status-suggestions" value="${esc(s.pick_status || '')}" placeholder="pending / claimed"><datalist id="pick-status-suggestions"><option value="pending"><option value="claimed"></datalist>`, { hint: 'Has the partner claimed their pick yet? Suggested: pending / claimed (free text allowed).' }) : ''}
      ${feeHasPick(s.fee_structure) ? field('Pick value', `<input id="f-pick_value_amount" type="number" min="0" step="0.01" value="${esc(s.pick_value_amount || '')}">`, { hint: 'Estimated dollar value of the pick puppy, for your own income tracking — separate from Fee amount, which is cash actually changing hands.' }) : ''}
      ${field('Linked pairing', `<select id="f-pairing_id">${pairingOptions(s.pairing_id)}</select>`, { hint: 'Optional — the actual breeding record and outcome.' })}
      ${field('Status', `<select id="f-status">${vocabOptions(STUD_SERVICE_STATUS, s.status, 'Select…')}</select>`, { required: true })}
      ${field('Referred by', `<select id="f-referred_by_contact_id">${referrerContactOptions(s.referred_by_contact_id)}</select>`, { hint: 'The contact who referred this arrangement. Tags them as a Stud referrer automatically.' })}
      ${field('Type', `<select id="f-type">${vocabOptions(STUD_SERVICE_TYPE, s.type, '— unknown —')}</select>`, { hint: 'In person = the dog physically travelled — shows on the away board. AI/shipped never does.' })}
      ${field('Sent', `<input id="f-sent_date" type="date" value="${esc(s.sent_date)}">`, { hint: 'Date the dog/semen was sent out (optional).' })}
      ${field('Returned', `<input id="f-returned_date" type="date" value="${esc(s.returned_date)}">`)}
      <div class="field field-wide">
        <label class="check-inline"><input id="picker-archived" type="checkbox"${ctx.pickerArchived ? ' checked' : ''}> Include archived dogs/contacts/pairings in the pickers above</label>
      </div>
      ${field('Result notes', `<textarea id="f-result_notes">${esc(s.result_notes)}</textarea>`, { wide: true })}
      ${field('Notes', `<textarea id="f-notes">${esc(s.notes)}</textarea>`, { wide: true })}
    </div>
    <div id="form-warn"></div>`;

  const form = document.getElementById('ss-form');
  form.addEventListener('input', updateWarnings);
  form.addEventListener('change', updateWarnings);
  document.getElementById('f-direction').addEventListener('change', () => {
    ctx.draft = readForm();
    renderEdit();
  });
  // Toggling to/from a pick-bearing structure shows/hides the Pick status field.
  document.getElementById('f-fee_structure').addEventListener('change', () => {
    ctx.draft = readForm();
    renderEdit();
  });
  document.getElementById('picker-archived').addEventListener('change', (e) => {
    ctx.draft = readForm();
    ctx.pickerArchived = e.target.checked;
    renderEdit();
  });
  const onNewContact = (contact) => {
    ctx.allContacts.push(contact);
    ctx.contactsById.set(contact.id, contact);
  };
  attachNewContactButton(document.getElementById('f-partner_contact_id'), { onCreated: onNewContact });
  attachNewContactButton(document.getElementById('f-referred_by_contact_id'), { onCreated: onNewContact });
  updateWarnings();
}

function readForm() {
  const val = (id) => document.getElementById(id)?.value ?? '';
  return {
    ...ctx.draft,
    direction: val('f-direction'),
    our_dog_id: val('f-our_dog_id') || '',
    partner_dog_id: val('f-partner_dog_id') || '',
    partner_contact_id: val('f-partner_contact_id') || '',
    fee_amount: val('f-fee_amount'),
    fee_structure: val('f-fee_structure') || '',
    // Field only exists in the DOM for pick-bearing structures; keep the draft
    // value otherwise so a brief non-pick selection mid-edit doesn't clobber it.
    // normalizeMoney nulls it out on save when the final structure has no pick.
    pick_status: document.getElementById('f-pick_status') ? val('f-pick_status').trim() : (ctx.draft.pick_status || ''),
    pick_value_amount: document.getElementById('f-pick_value_amount') ? val('f-pick_value_amount') : (ctx.draft.pick_value_amount || ''),
    pairing_id: val('f-pairing_id') || null,
    status: val('f-status'),
    type: val('f-type') || '',
    sent_date: val('f-sent_date'),
    returned_date: val('f-returned_date'),
    referred_by_contact_id: val('f-referred_by_contact_id') || null,
    result_notes: val('f-result_notes'),
    notes: val('f-notes')
  };
}

function updateWarnings() {
  const s = readForm();
  const warns = [];
  const our = ctx.dogsById.get(s.our_dog_id);
  if (our && s.direction === 'outgoing' && our.sex === 'female') warns.push('Direction is “outgoing” (our dog is the stud) but our dog is recorded as female.');
  if (our && s.direction === 'incoming' && our.sex === 'male') warns.push('Direction is “incoming” (our dog is the dam) but our dog is recorded as male.');
  if (s.our_dog_id && s.partner_dog_id && s.our_dog_id === s.partner_dog_id) warns.push('Our dog and the partner dog are the same dog — this will be blocked on save.');
  if (s.sent_date && s.returned_date && s.returned_date < s.sent_date) warns.push('Returned date is before the sent date.');
  const box = document.getElementById('form-warn');
  if (box) box.innerHTML = warns.length ? `<div class="inline-warn">${warns.map(esc).join('<br>')}</div>` : '';
}

// Empty numeric strings become null; pick_status and pick_value_amount are
// meaningful only for a pick-bearing fee structure, forced null otherwise so
// neither rides along on a flat_fee/other arrangement (Companion feature §1).
function normalizeMoney(candidate) {
  candidate.fee_amount = candidate.fee_amount === '' || candidate.fee_amount == null ? null : Number(candidate.fee_amount);
  candidate.pick_status = feeHasPick(candidate.fee_structure) && candidate.pick_status ? candidate.pick_status : null;
  candidate.pick_value_amount = feeHasPick(candidate.fee_structure) && candidate.pick_value_amount !== '' && candidate.pick_value_amount != null
    ? Number(candidate.pick_value_amount) : null;
  return candidate;
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
  const s = ctx.original;
  const archiveLabel = s.is_archived ? 'Unarchive' : 'Archive';
  const blockers = await studServiceRepo.getDeleteBlockers(s.id);
  const delTitle = blockers.length
    ? 'Referenced as ' + blockers.map((b) => `${b.label} (${b.count})`).join(', ') + ' — archive instead.'
    : 'Permanently delete this record.';
  els.headerActions.innerHTML = `
    <button class="btn btn-sm" id="btn-archive">${archiveLabel}</button>
    <button class="btn btn-danger btn-sm" id="btn-delete"${blockers.length ? ' disabled' : ''} title="${esc(delTitle)}">Delete</button>`;
  document.getElementById('btn-archive').onclick = toggleArchive;
  const del = document.getElementById('btn-delete');
  if (!blockers.length) del.onclick = doDelete;
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
  renderContractsSection();
}

function cancel() {
  clearError();
  if (ctx.mode === 'new') { location.href = 'stud-services.html'; return; }
  ctx.mode = 'view';
  renderView();
  renderProfileActions();
  renderContractsSection();
}

// Guards against a rapid double-tap/double-click firing save() twice before
// the first call's await chain has a chance to disable anything itself —
// each call would otherwise run to completion independently, e.g. creating
// two stud services from one "Save" tap.
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
  const candidate = normalizeMoney(readForm());
  try {
    if (ctx.mode === 'new') {
      const saved = await studServiceRepo.create(candidate);
      location.href = `stud-service.html?id=${encodeURIComponent(saved.id)}`;
      return;
    }
    const saved = await studServiceRepo.update(ctx.original.id, candidate);
    ctx.original = saved;
    ctx.mode = 'view';
    await loadRefs();
    ctx.original = await studServiceRepo.getById(saved.id);
    renderAll();
  } catch (e) {
    showError(e.message || String(e));
  }
}

async function toggleArchive() {
  const s = ctx.original;
  const verb = s.is_archived ? 'Unarchive' : 'Archive';
  const ok = await confirmModal({ title: `${verb} this stud service?`, confirmLabel: verb });
  if (!ok) return;
  ctx.original = s.is_archived ? await studServiceRepo.unarchive(s.id) : await studServiceRepo.archive(s.id);
  renderAll();
}

async function doDelete() {
  const s = ctx.original;
  const ok = await confirmModal({
    title: 'Delete this stud service?',
    message: 'Permanently delete this stud service? This cannot be undone.',
    confirmLabel: 'Delete', danger: true
  });
  if (!ok) return;
  try {
    await studServiceRepo.hardDelete(s.id);
    location.href = 'stud-services.html';
  } catch (e) {
    if (e instanceof ReferenceBlockedError) { showError(e.message); await renderHeaderActions(); }
    else showError(e.message || String(e));
  }
}

// --- Contracts panel (derived) --------------------------------------------
async function renderContractsSection() {
  if (!els.contracts) return;
  if (ctx.mode !== 'view' || !ctx.original) { els.contracts.innerHTML = ''; return; }
  const contracts = await contractRepo.getByStudService(ctx.original.id);
  contracts.sort((a, b) => (b.signed_date || b.created_at || '').localeCompare(a.signed_date || a.created_at || ''));

  const inner = contracts.length
    ? `<ul class="linked-list" style="margin:14px 0 0; padding:0; list-style:none;">` + contracts.map((c) => `
        <li class="row-between" style="padding:8px 0; border-top:1px solid var(--border);">
          <span>${badge(CONTRACT_TYPE, c.contract_type)} <strong>${esc(c.title || 'Contract')}</strong> ${badge(CONTRACT_STATUS, c.status)}${c.signed_date ? ` <span class="faint">signed ${esc(fmtDate(c.signed_date))}</span>` : ''}</span>
          <a class="btn btn-sm" href="contract.html?id=${encodeURIComponent(c.id)}">Open →</a>
        </li>`).join('') + `</ul>`
    : `<p class="muted" style="margin:14px 0 0;">No contracts attached to this stud service yet.</p>`;

  els.contracts.innerHTML = `
    <section class="card" style="margin-top:16px;">
      <div class="row-between">
        <h2 style="margin:0;">Contracts</h2>
        <a class="btn btn-sm" href="contract.html?new=1&stud_service=${encodeURIComponent(ctx.original.id)}">+ Create Contract</a>
      </div>
      ${inner}
    </section>`;
}

// --- Top-level render ------------------------------------------------------
function renderTitle() {
  if (ctx.mode === 'new') {
    els.title.textContent = 'New Stud Service';
    els.subtitle.textContent = 'Choose a direction, our dog, and the partner, then save.';
    return;
  }
  const s = ctx.original;
  const label = `${dogName(s.our_dog_id) || '—'} × ${dogName(s.partner_dog_id) || '—'}`;
  els.title.innerHTML = esc(label) + (s.is_archived ? ' <span class="badge badge-gray">Archived</span>' : '');
  els.subtitle.innerHTML = '';
}

function renderAll() {
  renderTitle();
  renderProfileActions();
  renderHeaderActions();
  if (ctx.mode === 'view') renderView();
  else renderEdit();
  renderContractsSection();
}

async function main() {
  await loadRefs();
  const id = param('id');
  const isNew = param('new');

  if (isNew) {
    ctx.mode = 'new';
    ctx.draft = blankStudService();
    const dogId = param('dog');
    if (dogId && ctx.dogsById.has(dogId)) ctx.draft.our_dog_id = dogId;
    renderTitle();
    renderEdit();
    renderProfileActions();
    renderHeaderActions();
    return;
  }

  if (!id) { showError('No stud service id provided.'); return; }
  const s = await studServiceRepo.getById(id);
  if (!s) { showError('Stud service not found. It may have been deleted.'); return; }
  ctx.original = s;
  ctx.mode = 'view';
  renderAll();
}

main();
