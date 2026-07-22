// documents.js — the Documents controller (see documents.html). Local
// storage: a document row (data/documentRepo.js) belongs to exactly one dog
// and points at exactly one stored file (data/fileRepo.js). Uploading a PDF
// stores it as-is; taking/choosing photo(s) — including a screenshot picked
// from the library — runs them through data/pdfBuild.js first, which
// downscales and re-encodes each page as JPEG to keep the stored file small.
import { esc, fmtDate, param, confirmModal } from '../assets/ui.js';
import { dogRepo } from '../data/dogRepo.js';
import { documentRepo } from '../data/documentRepo.js';
import { fileRepo } from '../data/fileRepo.js';
import { photosToPdf } from '../data/pdfBuild.js';
import { DOC_TYPES, documentFieldsFor, docTypeIcon } from '../data/vocab.js';

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

function fmtBytes(n) {
  if (!n) return '0 KB';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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
    const open = () => openViewModal(row.dataset.doc);
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

// --- Add / edit modal ---------------------------------------------------

function extraFieldsHtml(docType, existing) {
  const FIELD_DEFS = {
    issuer_or_lab: { label: 'Registry / vet / lab' },
    result: { label: 'Result' },
    registry: { label: 'Registry' },
    registration_number: { label: 'Registration #' }
  };
  return documentFieldsFor(docType).map((f) => {
    const def = FIELD_DEFS[f];
    const val = esc(existing?.[f] || '');
    return `<div class="field"><label>${esc(def.label)}</label><input type="text" id="doc-field-${f}" value="${val}"></div>`;
  }).join('');
}

function openAddEditModal(existingId, defaultDogId) {
  (async () => {
    const isEdit = !!existingId;
    const existing = isEdit ? await documentRepo.getById(existingId) : null;
    const currentFile = existing ? await fileRepo.get(existing.file_id) : null;
    const dogs_ = [...dogsById.values()].filter((d) => !d.is_archived)
      .sort((a, b) => dogName(a).localeCompare(dogName(b), undefined, { sensitivity: 'base' }));
    let pendingFiles = null; // { kind: 'pdf'|'photo', files: File[] }

    const selectedDogId = existing?.dog_id || defaultDogId || '';
    const initialType = existing?.doc_type || 'pedigree';

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="row-between" style="margin-bottom:12px;">
          <h2 style="margin:0;">${isEdit ? 'Edit document' : 'Add document'}</h2>
          <button class="btn btn-sm" data-act="cancel" type="button">✕</button>
        </div>
        <form id="doc-form">
          <div class="field">
            <label>Source</label>
            <label class="check-inline"><input type="radio" name="doc-source" value="pdf" checked> Upload PDF</label>
            <label class="check-inline"><input type="radio" name="doc-source" value="photo"> Take / choose photo or screenshot</label>
          </div>
          ${isEdit ? `<p class="muted" style="font-size:13px;">Current file: ${esc(currentFile?.filename || 'unknown')} (${fmtBytes(currentFile?.size)}) — pick a new one below to replace it, or leave as-is.</p>` : ''}
          <div class="field">
            <input type="file" id="doc-file-pdf" accept="application/pdf">
            <div id="doc-photo-buttons" class="pill-row" hidden>
              <label class="btn btn-sm">📷 Take Photo<input type="file" id="doc-file-camera" accept="image/*" capture="environment" multiple hidden></label>
              <label class="btn btn-sm">🖼 Choose from Library<input type="file" id="doc-file-library" accept="image/*" multiple hidden></label>
            </div>
            <div id="doc-file-preview" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;"></div>
          </div>

          <div class="form-grid" style="margin-top:12px;">
            <div class="field"><label>Dog <span class="req">*</span></label>
              <select id="doc-dog" required>
                <option value="" disabled${selectedDogId ? '' : ' selected'}>Choose a dog…</option>
                ${dogs_.map((d) => `<option value="${esc(d.id)}"${d.id === selectedDogId ? ' selected' : ''}>${esc(dogName(d))}</option>`).join('')}
              </select></div>
            <div class="field"><label>Type</label>
              <select id="doc-type">${DOC_TYPES.map((t) => `<option value="${t.value}"${t.value === initialType ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}</select></div>
            <div class="field"><label>Title</label>
              <input type="text" id="doc-title" value="${esc(existing?.title || '')}" placeholder="e.g. Willow's OFA hips"></div>
            <div class="field"><label>Date</label>
              <input type="date" id="doc-date" value="${esc(existing?.doc_date || '')}"></div>
            <div id="doc-extra-fields" style="display:contents;">${extraFieldsHtml(initialType, existing)}</div>
            <div class="field field-wide"><label>Notes</label><textarea id="doc-notes" rows="2">${esc(existing?.notes || '')}</textarea></div>
          </div>

          <div id="doc-form-error"></div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Add document'}</button>
            <button type="button" class="btn" data-act="cancel">Cancel</button>
            <span class="spacer"></span>
            ${isEdit ? '<button type="button" class="btn btn-danger" id="btn-doc-delete">Delete</button>' : ''}
          </div>
        </form>
      </div>`;
    document.body.appendChild(overlay);
    const modal = overlay.querySelector('.modal');

    function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    modal.querySelectorAll('[data-act="cancel"]').forEach((b) => b.addEventListener('click', close));

    // Type -> extra fields.
    modal.querySelector('#doc-type').addEventListener('change', (e) => {
      modal.querySelector('#doc-extra-fields').innerHTML = extraFieldsHtml(e.target.value, null);
    });

    // Source radio -> which file control shows. Camera and library are two
    // SEPARATE inputs (not one input with `capture`) because `capture` forces
    // a direct camera launch with no gallery option on Android/Chrome — the
    // only way to offer both "take a photo" and "pick an existing photo or
    // screenshot" is two buttons, each feeding the same pendingFiles variable
    // so Save doesn't care which path was used.
    const pdfInput = modal.querySelector('#doc-file-pdf');
    const photoButtons = modal.querySelector('#doc-photo-buttons');
    const cameraInput = modal.querySelector('#doc-file-camera');
    const libraryInput = modal.querySelector('#doc-file-library');
    const preview = modal.querySelector('#doc-file-preview');

    function syncSourceUI() {
      const source = modal.querySelector('input[name="doc-source"]:checked').value;
      pdfInput.hidden = source !== 'pdf';
      photoButtons.hidden = source !== 'photo';
    }
    modal.querySelectorAll('input[name="doc-source"]').forEach((r) => r.addEventListener('change', syncSourceUI));
    syncSourceUI();

    function renderFilePreview() {
      preview.innerHTML = '';
      if (!pendingFiles) return;
      if (pendingFiles.kind === 'pdf') {
        const f = pendingFiles.files[0];
        const chip = document.createElement('div');
        chip.className = 'badge badge-neutral';
        chip.textContent = `📎 ${f.name} (${fmtBytes(f.size)})`;
        preview.appendChild(chip);
      } else {
        for (const f of pendingFiles.files) {
          const url = URL.createObjectURL(f);
          const img = document.createElement('img');
          img.src = url;
          img.alt = '';
          img.style.cssText = 'width:64px;height:64px;object-fit:cover;border-radius:4px;border:1px solid var(--border,#e2e6ec);';
          preview.appendChild(img);
        }
      }
    }
    pdfInput.addEventListener('change', () => {
      pendingFiles = pdfInput.files[0] ? { kind: 'pdf', files: [pdfInput.files[0]] } : null;
      renderFilePreview();
    });
    function onPhotoPicked(input) {
      pendingFiles = input.files.length ? { kind: 'photo', files: Array.from(input.files) } : null;
      renderFilePreview();
    }
    cameraInput.addEventListener('change', () => onPhotoPicked(cameraInput));
    libraryInput.addEventListener('change', () => onPhotoPicked(libraryInput));

    modal.querySelector('#doc-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const dogId = modal.querySelector('#doc-dog').value;
      const docType = modal.querySelector('#doc-type').value;
      const title = modal.querySelector('#doc-title').value.trim();
      const docDate = modal.querySelector('#doc-date').value;
      const notes = modal.querySelector('#doc-notes').value;
      const extras = {};
      for (const f of documentFieldsFor(docType)) {
        extras[f] = modal.querySelector(`#doc-field-${f}`)?.value.trim() || '';
      }

      const submitBtn = modal.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      const errBox = modal.querySelector('#doc-form-error');
      errBox.innerHTML = '';
      try {
        if (!dogId) throw new Error('Choose a dog first.');

        let fileId = existing?.file_id || null;
        if (pendingFiles) {
          if (pendingFiles.kind === 'pdf') {
            const f = pendingFiles.files[0];
            fileId = await fileRepo.create(f, { filename: f.name, thumbnail: '' });
          } else {
            const built = await photosToPdf(pendingFiles.files, { title: title || docType });
            fileId = await fileRepo.create(built.blob, { filename: built.filename, thumbnail: built.thumbnail });
          }
          if (isEdit && existing.file_id && existing.file_id !== fileId) {
            await fileRepo.remove(existing.file_id);
          }
        }
        if (!fileId) throw new Error('Choose a PDF or photo(s) first.');

        const payload = { dog_id: dogId, doc_type: docType, title, doc_date: docDate, notes, file_id: fileId, ...extras };
        if (isEdit) await documentRepo.update(existing.id, payload);
        else await documentRepo.create(payload);

        close();
        flash(isEdit ? 'Document updated.' : 'Document added.');
        await refresh();
      } catch (err) {
        errBox.innerHTML = `<div class="inline-error">${esc(err.message || String(err))}</div>`;
      } finally {
        submitBtn.disabled = false;
      }
    });

    if (isEdit) {
      modal.querySelector('#btn-doc-delete').addEventListener('click', async () => {
        if (!(await confirmModal({ title: 'Delete this document?', message: 'This also removes its stored file. This can’t be undone.', confirmLabel: 'Delete', danger: true }))) return;
        await documentRepo.hardDelete(existing.id);
        close();
        flash('Document deleted.');
        await refresh();
      });
    }
  })();
}

// --- View modal ---------------------------------------------------------

async function openViewModal(docId) {
  const doc = docs.find((d) => d.id === docId);
  if (!doc) return;
  const dog = dogsById.get(doc.dog_id);
  const fileRow = await fileRepo.get(doc.file_id);
  const objUrl = fileRow ? URL.createObjectURL(fileRow.blob) : '';
  const t = DOC_TYPES.find((d) => d.value === doc.doc_type) || DOC_TYPES.at(-1);

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="max-width:900px;width:96vw;">
      <div class="row-between" style="align-items:center;">
        <h2 style="margin:0;font-size:17px;">${esc(doc.title || t.label)}${dog ? ` — ${esc(dogName(dog))}` : ''}</h2>
        <div class="form-actions" style="margin:0;">
          <button class="btn" data-act="edit">Edit</button>
          <button class="btn" data-act="download">Download</button>
          <button class="btn" data-act="close">Close</button>
        </div>
      </div>
      ${objUrl
        ? `<embed src="${objUrl}" type="application/pdf" style="width:100%;height:70vh;margin-top:12px;border:1px solid var(--border,#e2e6ec);border-radius:6px;">`
        : '<p class="muted">That file is missing.</p>'}
    </div>`;
  document.body.appendChild(overlay);

  const cleanup = () => { overlay.remove(); if (objUrl) setTimeout(() => URL.revokeObjectURL(objUrl), 500); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });
  overlay.querySelector('[data-act="close"]').addEventListener('click', cleanup);
  overlay.querySelector('[data-act="edit"]').addEventListener('click', () => { cleanup(); openAddEditModal(doc.id); });
  overlay.querySelector('[data-act="download"]').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = fileRow?.filename || `${doc.title || 'document'}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
}

// --- Boot -------------------------------------------------------------------

function wireEvents() {
  document.getElementById('btn-add-document').addEventListener('click', () => openAddEditModal(null, filters.dog));
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
