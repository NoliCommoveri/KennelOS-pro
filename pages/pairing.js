// pairing.js — Pairing Detail. Edit-in-place profile (same pattern as Dog
// Detail), a Linked Litter panel (derived litter, or a "Create Litter from this
// Pairing" action), and a Timeline of pairing-subject events. Hard blocks come
// from pairingRepo (required fields, sire≠dam); soft/interactive rules (sex
// mismatch, due-date ordering) live here because they need the user.
import { pairingRepo, ReferenceBlockedError } from '../data/pairingRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { studServiceRepo } from '../data/studServiceRepo.js';
import { PAIRING_TYPE, PAIRING_METHOD, PAIRING_STATUS, LITTER_STATUS, STUD_SERVICE_DIRECTION, STUD_SERVICE_STATUS } from '../data/vocab.js';
import { esc, badge, fmtDate, param, confirmModal, dogRefHtml } from '../assets/ui.js';
import { addDaysToYMD } from '../data/dateUtils.js';
import { editionFlags } from '../data/editionConfig.js';
import { renderTimeline } from '../assets/timeline.js';
import { openEventFromQuery } from '../assets/eventForm.js';
import { renderExpensePanel } from '../assets/expensePanel.js';

const els = {
  title: document.getElementById('pairing-title'),
  subtitle: document.getElementById('pairing-subtitle'),
  headerActions: document.getElementById('header-actions'),
  profileActions: document.getElementById('profile-actions'),
  body: document.getElementById('profile-body'),
  error: document.getElementById('page-error'),
  litter: document.getElementById('litter-section'),
  studService: document.getElementById('stud-service-section'),
  timeline: document.getElementById('timeline-section'),
  expenses: document.getElementById('expenses-section')
};

// Set when arriving via "Create Pairing from this Stud Service" — the id of the
// stud service to write pairing_id back onto after this pairing is created
// (StudService owns pairing_id; there is no Pairing.stud_service_id to set here —
// Stage4 Revision v2 §5).
let sourceStudServiceId = null;

// Expected due date defaults to 63 days after the planned first (tie) date.
const DUE_DAYS_AFTER_PLANNED = 63;

const blankPairing = () => ({
  sire_id: '', dam_id: '', pairing_type: '', method: '', status: '',
  planned_date: '', last_observed_date: '', expected_due_date: '', notes: ''
});

const ctx = {
  mode: 'view',        // 'new' | 'view' | 'edit'
  original: null,
  draft: null,
  pickerArchived: false,
  allDogs: [],
  dogsById: new Map()
};

async function loadRefs() {
  const dogs = await dogRepo.getAll({ includeArchived: true });
  ctx.allDogs = dogs;
  ctx.dogsById = new Map(dogs.map((d) => [d.id, d]));
}

function dogName(id) {
  const d = ctx.dogsById.get(id);
  return d ? (d.call_name + (d.registered_name ? ` (${d.registered_name})` : '')) : '';
}
// Read-only dog reference → a link to that dog's detail page. Returns '' when the
// id doesn't resolve, so row() falls back to its faint dash. Escapes the name.
function dogLink(id) {
  const name = dogName(id);
  if (!name) return '';
  return dogRefHtml(id, name, ctx.dogsById.get(id)?.is_archived);
}

// --- Option builders -----------------------------------------------------
function vocabOptions(vocab, current, placeholder) {
  const head = placeholder != null ? `<option value="">${esc(placeholder)}</option>` : '';
  return head + vocab.map((v) =>
    `<option value="${esc(v.value)}"${v.value === current ? ' selected' : ''}>${esc(v.label)}</option>`
  ).join('');
}

// Statuses eligible as a pairing's sire/dam: our own active breeding stock,
// plus external dogs (outside studs, foster dams) — those carry
// 'external_reference' rather than 'active_breeding' since they aren't our own
// breeding stock, but they're still valid breeding partners.
const BREEDING_ELIGIBLE_STATUS = ['active_breeding', 'external_reference'];

// Sire/dam picker: excludes archived by default (Stage 2 cross-cutting rule),
// limited to the matching sex plus "unknown", and scoped to breeding-eligible
// dogs (a retired/deceased/pet-home/puppy dog isn't a breeding candidate) —
// the current selection always stays listed so a mismatched legacy record is
// still editable (warned, not hidden).
function dogOptions(current, sex) {
  const opts = ctx.allDogs
    .filter((d) => ctx.pickerArchived || !d.is_archived || d.id === current)
    .filter((d) => !sex || d.id === current || d.sex === sex || d.sex === 'unknown')
    .filter((d) => d.id === current || BREEDING_ELIGIBLE_STATUS.includes(d.status))
    .map((d) => `<option value="${esc(d.id)}"${d.id === current ? ' selected' : ''}>${esc(d.call_name)}${d.registered_name ? ' — ' + esc(d.registered_name) : ''}${d.is_archived ? ' (archived)' : ''}</option>`)
    .join('');
  return `<option value="">— select —</option>` + opts;
}

// --- Read-only view ------------------------------------------------------
function row(label, valueHtml) {
  return `<dt>${esc(label)}</dt><dd>${valueHtml || '<span class="faint">—</span>'}</dd>`;
}

function renderView() {
  const p = ctx.original;
  els.body.innerHTML = `
    <dl class="dl-meta" style="margin-top:14px;">
      ${row('Sire', dogLink(p.sire_id))}
      ${row('Dam', dogLink(p.dam_id))}
      ${row('Type', badge(PAIRING_TYPE, p.pairing_type))}
      ${row('Method', p.method ? badge(PAIRING_METHOD, p.method) : '')}
      ${row('Status', badge(PAIRING_STATUS, p.status))}
      ${row('Planned first date', p.planned_date ? esc(fmtDate(p.planned_date)) : '')}
      ${row('Last observed date', p.last_observed_date ? esc(fmtDate(p.last_observed_date)) : '')}
      ${row('Expected due date', p.expected_due_date ? esc(fmtDate(p.expected_due_date)) : '')}
      ${row('Notes', p.notes ? esc(p.notes).replace(/\n/g, '<br>') : '')}
    </dl>`;
}

// --- Edit form -----------------------------------------------------------
function field(label, inner, { required = false, hint = '', wide = false } = {}) {
  return `<div class="field${wide ? ' field-wide' : ''}">
    <label>${esc(label)}${required ? ' <span class="req">*</span>' : ''}</label>
    ${inner}
    ${hint ? `<span class="field-hint">${esc(hint)}</span>` : ''}
  </div>`;
}

function renderEdit() {
  const p = ctx.draft;
  els.body.innerHTML = `
    <div class="form-grid" id="pairing-form" style="margin-top:14px;">
      ${field('Sire', `<select id="f-sire_id">${dogOptions(p.sire_id, 'male')}</select>`, { required: true })}
      ${field('Dam', `<select id="f-dam_id">${dogOptions(p.dam_id, 'female')}</select>`, { required: true })}
      ${field('Type', `<select id="f-pairing_type">${vocabOptions(PAIRING_TYPE, p.pairing_type, 'Select…')}</select>`, { required: true })}
      ${field('Method', `<select id="f-method">${vocabOptions(PAIRING_METHOD, p.method, '— none —')}</select>`)}
      ${field('Status', `<select id="f-status">${vocabOptions(PAIRING_STATUS, p.status, 'Select…')}</select>`, { required: true })}
      ${field('Planned first date', `<input id="f-planned_date" type="date" value="${esc(p.planned_date)}">`)}
      ${field('Last observed date', `<input id="f-last_observed_date" type="date" value="${esc(p.last_observed_date)}">`)}
      ${field('Expected due date', `<input id="f-expected_due_date" type="date" value="${esc(p.expected_due_date)}">`, { hint: 'Defaults to 63 days after the planned first date. Still editable.' })}
      ${editionFlags.includeArchivedToggles ? `<div class="field field-wide">
        <label class="check-inline"><input id="picker-archived" type="checkbox"${ctx.pickerArchived ? ' checked' : ''}> Include archived dogs in the pickers above</label>
      </div>` : ''}
      ${field('Notes', `<textarea id="f-notes">${esc(p.notes)}</textarea>`, { wide: true })}
    </div>
    <div id="form-warn"></div>`;

  const form = document.getElementById('pairing-form');
  form.addEventListener('input', updateWarnings);
  form.addEventListener('change', updateWarnings);
  document.getElementById('picker-archived')?.addEventListener('change', (e) => {
    ctx.draft = readForm();
    ctx.pickerArchived = e.target.checked;
    renderEdit();
  });
  // Planned first date prefills expected due date (63 days later) — only while
  // that field is still empty, so it never clobbers a deliberate edit.
  document.getElementById('f-planned_date').addEventListener('change', (e) => {
    ctx.draft = readForm();
    if (e.target.value && !ctx.draft.expected_due_date) {
      ctx.draft.expected_due_date = addDaysToYMD(e.target.value, DUE_DAYS_AFTER_PLANNED);
    }
    renderEdit();
  });
  updateWarnings();
}

function readForm() {
  const val = (id) => document.getElementById(id)?.value ?? '';
  return {
    ...ctx.draft,
    sire_id: val('f-sire_id') || '',
    dam_id: val('f-dam_id') || '',
    pairing_type: val('f-pairing_type'),
    method: val('f-method') || '',
    status: val('f-status'),
    planned_date: val('f-planned_date'),
    last_observed_date: val('f-last_observed_date'),
    expected_due_date: val('f-expected_due_date'),
    notes: val('f-notes')
  };
}

function updateWarnings() {
  const p = readForm();
  const warns = [];
  const sire = ctx.dogsById.get(p.sire_id);
  const dam = ctx.dogsById.get(p.dam_id);
  if (sire && sire.sex === 'female') warns.push('Selected sire is recorded as female.');
  if (dam && dam.sex === 'male') warns.push('Selected dam is recorded as male.');
  if (p.sire_id && p.dam_id && p.sire_id === p.dam_id) warns.push('Sire and dam are the same dog — this will be blocked on save.');
  if (p.expected_due_date && p.planned_date && p.expected_due_date < p.planned_date) {
    warns.push('Expected due date is before the planned first date.');
  }
  const box = document.getElementById('form-warn');
  if (box) box.innerHTML = warns.length ? `<div class="inline-warn">${warns.map(esc).join('<br>')}</div>` : '';
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
  const p = ctx.original;
  const blockers = await pairingRepo.getDeleteBlockers(p.id);
  const delTitle = blockers.length
    ? 'Referenced as ' + blockers.map((b) => `${b.label} (${b.count})`).join(', ') + ' — archive instead.'
    : 'Permanently delete this record.';
  // Archive control. Lite hides the archive machinery (cap spec §5/§7) — no
  // manual pairing-archive at all (pairings have no "departure" substitute).
  const archiveBtn = editionFlags.manualDogArchive
    ? `<button class="btn btn-sm" id="btn-archive">${p.is_archived ? 'Unarchive' : 'Archive'}</button>`
    : '';
  els.headerActions.innerHTML = `
    ${archiveBtn}
    <button class="btn btn-danger btn-sm" id="btn-delete"${blockers.length ? ' disabled' : ''} title="${esc(delTitle)}">Delete</button>`;
  document.getElementById('btn-archive')?.addEventListener('click', toggleArchive);
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
  renderLitterSection();   // hide derived panels while editing the profile
  renderStudServiceSection();
  renderTimelineSection();
  renderExpensesSection();
}

function cancel() {
  clearError();
  if (ctx.mode === 'new') { location.href = 'pairings.html'; return; }
  ctx.mode = 'view';
  renderView();
  renderProfileActions();
  renderLitterSection();
  renderStudServiceSection();
  renderTimelineSection();
  renderExpensesSection();
}

// Guards against a rapid double-tap/double-click firing save() twice before
// the first call's await chain has a chance to disable anything itself —
// each call would otherwise run to completion independently, e.g. creating
// two pairings from one "Save" tap.
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
      const saved = await pairingRepo.create(candidate);
      // Write the canonical link back onto the source stud service (StudService
      // owns pairing_id — this repo's own update() is the only thing allowed to
      // write it, per the ownership rule in Stage4 Revision v2 §5).
      if (sourceStudServiceId) {
        await studServiceRepo.update(sourceStudServiceId, { pairing_id: saved.id });
      }
      location.href = `pairing.html?id=${encodeURIComponent(saved.id)}`;
      return;
    }
    const saved = await pairingRepo.update(ctx.original.id, candidate);
    ctx.original = saved;
    ctx.mode = 'view';
    await loadRefs();
    ctx.original = await pairingRepo.getById(saved.id);
    renderAll();
  } catch (e) {
    showError(e.message || String(e));
  }
}

async function toggleArchive() {
  const p = ctx.original;
  const verb = p.is_archived ? 'Unarchive' : 'Archive';
  if (!(await confirmModal({ title: `${verb} this pairing?`, confirmLabel: verb }))) return;
  ctx.original = p.is_archived ? await pairingRepo.unarchive(p.id) : await pairingRepo.archive(p.id);
  renderAll();
}

async function doDelete() {
  const p = ctx.original;
  if (!(await confirmModal({ title: 'Delete this pairing?', message: 'Permanently delete this pairing? This cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
  try {
    await pairingRepo.hardDelete(p.id);
    location.href = 'pairings.html';
  } catch (e) {
    if (e instanceof ReferenceBlockedError) { showError(e.message); await renderHeaderActions(); }
    else showError(e.message || String(e));
  }
}

// --- Linked Litter panel -------------------------------------------------
async function renderLitterSection() {
  if (!els.litter) return;
  if (ctx.mode !== 'view' || !ctx.original) { els.litter.innerHTML = ''; return; }
  const litters = await litterRepo.getAllForPairing(ctx.original.id);

  let inner;
  if (litters.length) {
    inner = `<ul class="linked-list" style="margin:14px 0 0; padding:0; list-style:none;">` + litters.map((l) => `
      <li class="row-between" style="padding:8px 0; border-top:1px solid var(--border);">
        <span>${badge(LITTER_STATUS, l.status)} <strong>${esc(dogName(l.dam_id) || 'Dam')} × ${esc(dogName(l.sire_id) || 'Sire')}</strong>${l.whelp_date ? ` <span class="faint">whelped ${esc(fmtDate(l.whelp_date))}</span>` : ''}</span>
        <a class="btn btn-sm" href="litter.html?id=${encodeURIComponent(l.id)}">Open litter →</a>
      </li>`).join('') + `</ul>`;
  } else {
    inner = `
      <p class="muted" style="margin:14px 0 0;">No litter is linked to this pairing yet.</p>
      <div class="form-actions">
        <a class="btn btn-primary" href="litter.html?new=1&pairing=${encodeURIComponent(ctx.original.id)}">+ Create Litter from this Pairing</a>
      </div>`;
  }

  els.litter.innerHTML = `
    <section class="card" style="margin-top:16px;">
      <h2 style="margin:0;">Linked Litter</h2>
      ${inner}
    </section>`;
}

// --- Linked Stud Service panel (derived — StudService owns pairing_id, so
// there is nothing to link/create from this side; Data Model v3 §5.8) --------
async function renderStudServiceSection() {
  if (!els.studService) return;
  if (!editionFlags.studServices) { els.studService.innerHTML = ''; return; } // Pro-only in Lite
  if (ctx.mode !== 'view' || !ctx.original) { els.studService.innerHTML = ''; return; }
  const studServices = await studServiceRepo.getByPairing(ctx.original.id);
  if (!studServices.length) { els.studService.innerHTML = ''; return; }

  const inner = `<ul class="linked-list" style="margin:14px 0 0; padding:0; list-style:none;">` + studServices.map((s) => `
    <li class="row-between" style="padding:8px 0; border-top:1px solid var(--border);">
      <span>${badge(STUD_SERVICE_DIRECTION, s.direction)} <strong>${esc(dogName(s.our_dog_id) || '—')} × ${esc(dogName(s.partner_dog_id) || '—')}</strong> ${badge(STUD_SERVICE_STATUS, s.status)}</span>
      <a class="btn btn-sm" href="stud-service.html?id=${encodeURIComponent(s.id)}">Open stud service →</a>
    </li>`).join('') + `</ul>`;

  els.studService.innerHTML = `
    <section class="card" style="margin-top:16px;">
      <h2 style="margin:0;">Linked Stud Service</h2>
      ${inner}
    </section>`;
}

// --- Timeline ------------------------------------------------------------
function renderTimelineSection() {
  if (!els.timeline) return;
  if (ctx.mode === 'view' && ctx.original) {
    renderTimeline({ mount: els.timeline, subjectType: 'pairing', subjectId: ctx.original.id, title: 'Timeline' });
  } else {
    els.timeline.innerHTML = '';
  }
}
function renderExpensesSection() {
  if (!els.expenses) return;
  if (ctx.mode === 'view' && ctx.original) {
    renderExpensePanel({ mount: els.expenses, subjectType: 'pairing', subjectId: ctx.original.id });
  } else {
    els.expenses.innerHTML = '';
  }
}

// --- Top-level render ----------------------------------------------------
function renderTitle() {
  if (ctx.mode === 'new') {
    els.title.textContent = 'New Pairing';
    els.subtitle.textContent = 'Choose a sire and dam, then save.';
    return;
  }
  const p = ctx.original;
  const label = `${dogName(p.sire_id) || '—'} × ${dogName(p.dam_id) || '—'}`;
  els.title.innerHTML = esc(label) + (p.is_archived ? ' <span class="badge badge-gray">Archived</span>' : '');
  els.subtitle.innerHTML = '';
}

function renderAll() {
  renderTitle();
  renderProfileActions();
  renderHeaderActions();
  if (ctx.mode === 'view') renderView();
  else renderEdit();
  renderLitterSection();
  renderStudServiceSection();
  renderTimelineSection();
  renderExpensesSection();
}

async function main() {
  await loadRefs();
  const id = param('id');
  const isNew = param('new');

  if (isNew) {
    ctx.mode = 'new';
    ctx.draft = blankPairing();
    // Pre-fill from a stud service via "Create Pairing from this Stud Service"
    // (Data Model v3 §5.8 direction mapping; Stage4 Revision v2 §5).
    const studServiceId = param('stud_service');
    if (studServiceId) {
      const ss = await studServiceRepo.getById(studServiceId);
      if (ss) {
        sourceStudServiceId = ss.id;
        if (ss.direction === 'outgoing') {
          ctx.draft.sire_id = ss.our_dog_id || '';
          ctx.draft.dam_id = ss.partner_dog_id || '';
        } else if (ss.direction === 'incoming') {
          ctx.draft.sire_id = ss.partner_dog_id || '';
          ctx.draft.dam_id = ss.our_dog_id || '';
        }
        ctx.draft.pairing_type = 'actual';
        ctx.draft.status = 'planned';
      }
    }
    // Pre-fill dam from the heat-conclusion nudge deep-link (Data Integrity
    // Brief §4.5) — a lighter-weight seed than `stud_service`, just the dam.
    const damId = param('dam');
    if (damId && ctx.dogsById.has(damId)) ctx.draft.dam_id = damId;
    renderTitle();
    renderEdit();
    renderProfileActions();
    renderHeaderActions();
    return;
  }

  if (!id) { showError('No pairing id provided.'); return; }
  const p = await pairingRepo.getById(id);
  if (!p) { showError('Pairing not found. It may have been deleted.'); return; }
  ctx.original = p;
  ctx.mode = 'view';
  renderAll();
  openEventFromQuery('pairing', p.id, renderTimelineSection);
}

main();
