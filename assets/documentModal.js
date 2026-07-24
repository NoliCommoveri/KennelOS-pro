// documentModal.js — the shared Documents add/edit + view modals. Extracted from
// pages/documents.js so the Documents page AND the Contract detail page
// (pages/contract.js) drive the SAME modal (one implementation, per CLAUDE.md's
// shared-JS rule) instead of each hand-rolling an upload dialog.
//
// A document belongs to exactly one dog (data/documentRepo.js) and points at
// exactly one stored file (data/fileRepo.js). Uploading a PDF stores it as-is;
// taking/choosing photo(s) — including a screenshot — runs them through
// data/pdfBuild.js first (downscale + JPEG re-encode) to keep the file small.
//
// Contract link: pass `contractId` to stamp the saved document's UNINDEXED
// contract_id back-link (documentRepo, §26.1), so the Contract page can later
// surface it inline. Only used by the "Attach signed contract" flow; the plain
// Documents page passes nothing and the field stays null (edits preserve it).
//
// Both entry points are self-contained: they load the dogs/file they need and
// report back through callbacks (onSaved / onDeleted / onEdit / onChanged) so
// the caller can refresh its own view — no shared module state.
import { esc, fmtDate, confirmModal } from './ui.js';
import { dogRepo } from '../data/dogRepo.js';
import { documentRepo } from '../data/documentRepo.js';
import { fileRepo } from '../data/fileRepo.js';
import { photosToPdf } from '../data/pdfBuild.js';
import { DOC_TYPES, documentFieldsFor } from '../data/vocab.js';

function fmtBytes(n) {
  if (!n) return '0 KB';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const dogName = (d) => (d && (d.call_name || d.registered_name)) || '(unnamed dog)';

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

// Open the add/edit document modal.
//   existingId    — a document id to edit, or null to add a new one
//   defaultDogId  — preselect this dog (used by the dog page / contract attach)
//   defaultType   — preselect this doc_type (e.g. 'contract' from a contract)
//   contractId    — stamp this contract_id on the saved document (attach flow)
//   onSaved({ isEdit, doc }) — called after a successful create/update
//   onDeleted()   — called after the edit modal's Delete removes the document
export function openDocumentModal({
  existingId = null, defaultDogId = '', defaultType = 'pedigree',
  contractId = null, onSaved, onDeleted
} = {}) {
  (async () => {
    const isEdit = !!existingId;
    const existing = isEdit ? await documentRepo.getById(existingId) : null;
    const currentFile = existing ? await fileRepo.get(existing.file_id) : null;
    const dogs_ = (await dogRepo.getAll({ includeArchived: false }))
      .sort((a, b) => dogName(a).localeCompare(dogName(b), undefined, { sensitivity: 'base' }));
    let pendingFiles = null; // { kind: 'pdf'|'photo', files: File[] }

    const selectedDogId = existing?.dog_id || defaultDogId || '';
    const initialType = existing?.doc_type || defaultType || 'pedigree';

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" id="doc-form-modal" role="dialog" aria-modal="true">
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
        // Stamp the contract back-link only when this modal was opened FROM a
        // contract (attach flow). On a plain edit, contract_id is absent from the
        // payload and documentRepo.update preserves whatever the record already
        // had, so re-editing a linked document never drops its link.
        if (contractId != null) payload.contract_id = contractId;

        let doc;
        if (isEdit) doc = await documentRepo.update(existing.id, payload);
        else doc = await documentRepo.create(payload);

        close();
        onSaved?.({ isEdit, doc });
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
        onDeleted?.();
      });
    }
  })();
}

// Open the read-only view modal for a stored document (inline PDF + Download).
//   docId       — the document to view
//   onEdit(id)  — called when the modal's Edit button is pressed (caller reopens
//                 openDocumentModal); omit to hide the Edit button
export async function openDocumentViewModal({ docId, onEdit } = {}) {
  const doc = await documentRepo.getById(docId);
  if (!doc) return;
  const dog = doc.dog_id ? await dogRepo.getById(doc.dog_id) : null;
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
          ${onEdit ? '<button class="btn" data-act="edit">Edit</button>' : ''}
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
  overlay.querySelector('[data-act="edit"]')?.addEventListener('click', () => { cleanup(); onEdit?.(doc.id); });
  overlay.querySelector('[data-act="download"]').addEventListener('click', () => {
    if (!objUrl) return;
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = fileRow?.filename || `${doc.title || 'document'}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
}
