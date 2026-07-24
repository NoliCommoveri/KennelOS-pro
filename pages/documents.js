// documents.js — the Documents controller (see documents.html). Local
// storage: a document row (data/documentRepo.js) belongs to exactly one dog
// and points at exactly one stored file (data/fileRepo.js). The add/edit and
// view dialogs live in the shared assets/documentModal.js so this page and the
// Contract detail page drive the same modal; this controller only owns the
// grouped list, filters, and refresh.
import { esc, fmtDate, param } from '../assets/ui.js';
import { dogRepo } from '../data/dogRepo.js';
import { documentRepo } from '../data/documentRepo.js';
import { fileRepo } from '../data/fileRepo.js';
import { DOC_TYPES, docTypeIcon } from '../data/vocab.js';
import { openDocumentModal, openDocumentViewModal } from '../assets/documentModal.js';

// --- View state -------------------------------------------------------------
let dogsById = new Map();            // dogs by id, for names + the add-form select
let docs = [];                       // all documents (active + archived), reloaded on refresh()
let filesById = new Map();           // file metadata (no blob) by id, for thumbnails
const filters = { type: 'all', dog: param('dog') || '', text: '' };

const msg = document.getElementById('page-msg');
function flash(text, kind = 'ok') {
  msg.innerHTML = text
    ? `<div class="${kind === 'ok' ? 'inline-warn' : 'inline-error'}" style="${kind === 'ok' ? 'color:var(--accent-dark);background:var(--accent-soft);border-color:#bfe0cd;' : ''}">${esc(text)}</div>`
    : '';
  if (text) msg.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

const dogName = (d) => (d && (d.call_name || d.registered_name)) || '(unnamed dog)';

// --- Rendering --------------------------------------------------------------

function renderTypeChips() {
  const chips = [{ value: 'all', label: 'All' }, ...DOC_TYPES];
  document.getElementById('type-chips').innerHTML = chips.map((c) =>
    `<a class="seg-tab${filters.type === c.value ? ' active' : ''}" href="#" data-type="${esc(c.value)}">${esc(c.label)}</a>`
  ).join('');
}

function renderDogFilterOptions() {
  const sel = document.getElementById('dog-filter');
  const live = [...dogsById.values()]
    .filter((d) => !d.is_archived)
    .sort((a, b) => dogName(a).localeCompare(dogName(b), undefined, { sensitivity: 'base' }));
  sel.innerHTML = '<option value="">All dogs</option>'
    + live.map((d) => `<option value="${esc(d.id)}"${filters.dog === d.id ? ' selected' : ''}>${esc(dogName(d))}</option>`).join('');
}

function matchesText(doc, dogLabel, q) {
  if (!q) return true;
  const hay = [doc.title, dogLabel, doc.issuer_or_lab, doc.notes, doc.registry, doc.result]
    .filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

// Group the (filtered) documents by dog: dogs alphabetical by name, newest
// document first within a dog.
function buildGroups() {
  const q = filters.text.trim().toLowerCase();
  const groups = new Map(); // dogId -> { dogId, name, docs: [] }
  for (const doc of docs) {
    if (doc.is_archived) continue;
    if (filters.type !== 'all' && doc.doc_type !== filters.type) continue;
    if (filters.dog && doc.dog_id !== filters.dog) continue;

    const dog = dogsById.get(doc.dog_id);
    if (!dog) continue; // dog was hard-deleted out from under an orphaned row — shouldn't happen (guarded), skip defensively
    const name = dogName(dog);
    if (!matchesText(doc, name, q)) continue;

    if (!groups.has(doc.dog_id)) groups.set(doc.dog_id, { dogId: doc.dog_id, name, docs: [] });
    groups.get(doc.dog_id).docs.push(doc);
  }
  const arr = [...groups.values()];
  for (const g of arr) {
    g.docs.sort((a, b) => String(b.doc_date || '').localeCompare(String(a.doc_date || '')));
  }
  arr.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return arr;
}

function docRowHtml(doc) {
  const t = DOC_TYPES.find((d) => d.value === doc.doc_type) || DOC_TYPES.at(-1);
  const meta = [fmtDate(doc.doc_date), doc.issuer_or_lab].filter(Boolean).join(' • ');
  const file = filesById.get(doc.file_id);
  const thumb = file?.thumbnail
    ? `<img src="${esc(file.thumbnail)}" alt="" style="width:36px;height:36px;object-fit:cover;border-radius:4px;">`
    : `<span aria-hidden="true" style="font-size:22px;line-height:1;">${docTypeIcon(doc.doc_type)}</span>`;
  return `
    <div class="doc-row" data-doc="${esc(doc.id)}" role="button" tabindex="0"
         style="display:flex;align-items:center;gap:12px;padding:10px 2px;border-top:1px solid var(--border,#e2e6ec);cursor:pointer;">
      ${thumb}
      <div style="flex:1;min-width:0;">
        <strong>${esc(doc.title || t.label)}</strong>
        ${meta ? `<div class="muted" style="font-size:13px;">${esc(meta)}</div>` : ''}
      </div>
      <span class="badge ${esc(t.badge)}">${esc(t.label)}</span>
    </div>`;
}

function renderList() {
  const host = document.getElementById('list');
  const groups = buildGroups();
  if (!groups.length) {
    host.innerHTML = `<div class="card"><p class="faint" style="margin:0;">${docs.length ? 'No documents match these filters.' : 'No documents yet. Click “+ Add Document” to file the first one.'}</p></div>`;
    return;
  }
  host.innerHTML = groups.map((g) => `
    <div class="card" style="margin-top:14px;">
      <div class="row-between" style="align-items:baseline;">
        <h2 style="margin:0;font-size:17px;">${esc(g.name)}</h2>
        <span class="muted" style="font-size:13px;">${g.docs.length} document${g.docs.length > 1 ? 's' : ''}</span>
      </div>
      ${g.docs.map(docRowHtml).join('')}
    </div>`).join('');

  for (const row of host.querySelectorAll('.doc-row[data-doc]')) {
    const open = () => openView(row.dataset.doc);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  }
}

async function refreshData() {
  const [dogs_, docs_, filesMeta] = await Promise.all([
    dogRepo.getAll({ includeArchived: true }),
    documentRepo.getAll({ includeArchived: false }),
    fileRepo.getAllMeta()
  ]);
  dogsById = new Map(dogs_.map((d) => [d.id, d]));
  docs = docs_;
  filesById = new Map(filesMeta.map((f) => [f.id, f]));
}

async function refresh() {
  await refreshData();
  renderDogFilterOptions();
  renderList();
}

// --- Modals (shared implementation in assets/documentModal.js) --------------

const onSaved = async ({ isEdit }) => { flash(isEdit ? 'Document updated.' : 'Document added.'); await refresh(); };
const onDeleted = async () => { flash('Document deleted.'); await refresh(); };

function openAdd(defaultDogId) {
  openDocumentModal({ defaultDogId: defaultDogId || filters.dog || '', onSaved, onDeleted });
}
function openEdit(docId) {
  openDocumentModal({ existingId: docId, onSaved, onDeleted });
}
function openView(docId) {
  openDocumentViewModal({ docId, onEdit: openEdit });
}

// --- Boot -------------------------------------------------------------------

function wireEvents() {
  document.getElementById('btn-add-document').addEventListener('click', () => openAdd());
  document.getElementById('type-chips').addEventListener('click', (e) => {
    const a = e.target.closest('[data-type]');
    if (!a) return;
    e.preventDefault();
    filters.type = a.dataset.type;
    renderTypeChips();
    renderList();
  });
  document.getElementById('dog-filter').addEventListener('change', (e) => {
    filters.dog = e.target.value;
    renderList();
  });
  document.getElementById('search').addEventListener('input', (e) => {
    filters.text = e.target.value;
    renderList();
  });
}

async function boot() {
  renderTypeChips();
  wireEvents();
  await refresh();
}

boot();
