// receiptCapture.js — the shared "attach a receipt" widget: take/choose a
// photo or screenshot (auto-scanned for amount/date/vendor via data/ocr.js,
// then compressed to a PDF via data/pdfBuild.js — same compression Documents
// uses for a filed dog document), or upload a PDF directly. Reused by both
// expense forms — the Financials hub's Add Expense modal (pages/financials.js)
// and each subject's Expense panel (assets/expensePanel.js) — the same way
// buildMileageFields/wireMileageMode above them are shared.
//
// Field-id convention: build/wireReceiptField take a prefix `p` and read/write
// `#${p}-amount`, `#${p}-date`, `#${p}-vendor` for OCR autofill — the same ids
// buildMileageFields/the surrounding modal already use, so no extra wiring is
// needed to find them.
import { fileRepo } from '../data/fileRepo.js';
import { photosToPdf } from '../data/pdfBuild.js';
import * as ocr from '../data/ocr.js';
import { esc, todayYMD, viewPdfModal } from './ui.js';

function fmtBytes(n) {
  if (!n) return '0 KB';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Markup for the receipt field. `currentFile` (optional) is the existing
// file's metadata (no blob — from fileRepo.get, blob stripped by the caller)
// when editing an expense that already has one attached.
export function buildReceiptField(p, { currentFile } = {}) {
  return `
    <div class="field field-wide">
      <label>Receipt</label>
      <div class="pill-row">
        <label class="check-inline"><input type="radio" name="${p}-rsource" value="photo" checked> Take / choose photo or screenshot</label>
        <label class="check-inline"><input type="radio" name="${p}-rsource" value="pdf"> Upload PDF</label>
      </div>
      ${currentFile ? `
        <div class="row-between" style="margin-top:4px;">
          <p class="muted" style="font-size:13px;margin:0;">Current: ${esc(currentFile.filename || 'file')} (${fmtBytes(currentFile.size)}) — attach a new one below to replace it, or leave as-is.</p>
          <div class="pill-row">
            <button type="button" class="btn btn-sm" id="${p}-btn-view-receipt">View</button>
            <button type="button" class="btn btn-sm" id="${p}-btn-remove-receipt">Remove</button>
          </div>
        </div>` : ''}
      <div id="${p}-photo-buttons" class="pill-row" style="margin-top:6px;">
        <label class="btn btn-sm">📷 Take Photo<input type="file" id="${p}-file-camera" accept="image/*" capture="environment" hidden></label>
        <label class="btn btn-sm">🖼 Choose from Library<input type="file" id="${p}-file-library" accept="image/*" hidden></label>
      </div>
      <input type="file" id="${p}-file-pdf" accept="application/pdf" hidden>
      <div id="${p}-receipt-preview" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;"></div>
      <div id="${p}-scan-status" class="muted" style="font-size:13px;"></div>
    </div>`;
}

// Wires the field built above inside `modal`. Returns:
//   resolveFileId(existingFileId) — call at save time; returns the file_id to
//     store (unchanged, newly built, or null if removed), cleaning up any
//     replaced/removed file in fileRepo as it goes.
export function wireReceiptField(modal, p, { currentFile } = {}) {
  // Camera and library are two SEPARATE inputs (not one input with `capture`)
  // because `capture` forces a direct camera launch with no gallery option on
  // Android/Chrome — the only way to offer both "take a photo" and "pick an
  // existing photo or screenshot" is two buttons.
  const photoButtons = modal.querySelector(`#${p}-photo-buttons`);
  const cameraInput = modal.querySelector(`#${p}-file-camera`);
  const libraryInput = modal.querySelector(`#${p}-file-library`);
  const pdfInput = modal.querySelector(`#${p}-file-pdf`);
  const preview = modal.querySelector(`#${p}-receipt-preview`);
  const scanStatus = modal.querySelector(`#${p}-scan-status`);
  const amountEl = modal.querySelector(`#${p}-amount`);
  const dateEl = modal.querySelector(`#${p}-date`);
  const vendorEl = modal.querySelector(`#${p}-vendor`);
  const receiptNoEl = modal.querySelector(`#${p}-receipt`);
  const today = todayYMD();

  let pending = null; // { kind: 'photo'|'pdf', files: File[] }
  let removeCurrent = false;

  function syncSourceUI() {
    const source = modal.querySelector(`input[name="${p}-rsource"]:checked`)?.value || 'photo';
    photoButtons.hidden = source !== 'photo';
    pdfInput.hidden = source !== 'pdf';
  }
  modal.querySelectorAll(`input[name="${p}-rsource"]`).forEach((r) => r.addEventListener('change', syncSourceUI));
  syncSourceUI();

  function renderPreview() {
    preview.innerHTML = '';
    if (!pending) return;
    const f = pending.files[0];
    if (pending.kind === 'pdf') {
      const chip = document.createElement('span');
      chip.className = 'badge badge-neutral';
      chip.textContent = `📎 ${f.name} (${fmtBytes(f.size)})`;
      preview.appendChild(chip);
    } else {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(f);
      img.alt = '';
      img.style.cssText = 'width:64px;height:64px;object-fit:cover;border-radius:4px;border:1px solid var(--border,#e2e6ec);';
      preview.appendChild(img);
    }
  }

  // Auto-scan a freshly picked photo (captured or chosen from the library,
  // including a screenshot) and fill amount/date/vendor/receipt # when
  // they're still blank/default — never overwriting something the user
  // already typed. Not every receipt prints its own number, so that field is
  // best-effort and often stays blank for manual entry.
  async function runScan(file) {
    let available = false;
    try { available = await ocr.isAvailable(); } catch { available = false; }
    if (!available) return;
    scanStatus.textContent = 'Reading receipt…';
    try {
      const { amount, date, vendor, receiptNumber } = await ocr.scan(file, (pr) => {
        scanStatus.textContent = `Reading receipt… ${Math.round(pr * 100)}%`;
      });
      const filled = [];
      if (amount != null && amountEl && !amountEl.value) { amountEl.value = amount; filled.push('amount'); }
      if (date && dateEl && dateEl.value === today) { dateEl.value = date; filled.push('date'); }
      if (vendor && vendorEl && !vendorEl.value) { vendorEl.value = vendor; filled.push('vendor'); }
      if (receiptNumber && receiptNoEl && !receiptNoEl.value) { receiptNoEl.value = receiptNumber; filled.push('receipt #'); }
      scanStatus.textContent = filled.length
        ? `Filled ${filled.join(', ')} from the receipt — please double-check.`
        : 'Couldn’t read the details — enter them by hand.';
    } catch {
      scanStatus.textContent = 'Scan unavailable — enter the details by hand.';
    }
  }

  function onPhotoPicked(input) {
    const f = input.files[0];
    pending = f ? { kind: 'photo', files: [f] } : null;
    removeCurrent = false;
    renderPreview();
    if (f) runScan(f);
  }
  cameraInput.addEventListener('change', () => onPhotoPicked(cameraInput));
  libraryInput.addEventListener('change', () => onPhotoPicked(libraryInput));
  pdfInput.addEventListener('change', () => {
    const f = pdfInput.files[0];
    pending = f ? { kind: 'pdf', files: [f] } : null;
    removeCurrent = false;
    renderPreview();
  });

  modal.querySelector(`#${p}-btn-view-receipt`)?.addEventListener('click', async () => {
    if (!currentFile) return;
    const row = await fileRepo.get(currentFile.id);
    if (row?.blob) viewPdfModal({ title: 'Receipt', blob: row.blob, filename: row.filename });
  });
  modal.querySelector(`#${p}-btn-remove-receipt`)?.addEventListener('click', (e) => {
    removeCurrent = true;
    pending = null;
    cameraInput.value = '';
    libraryInput.value = '';
    pdfInput.value = '';
    preview.innerHTML = '';
    scanStatus.textContent = 'Receipt will be removed on save.';
    e.target.closest('.row-between').style.display = 'none';
  });

  return {
    async resolveFileId(existingFileId) {
      if (removeCurrent) {
        if (existingFileId) await fileRepo.remove(existingFileId);
        return null;
      }
      if (!pending) return existingFileId || null;
      let fileId;
      if (pending.kind === 'pdf') {
        const f = pending.files[0];
        fileId = await fileRepo.create(f, { filename: f.name, thumbnail: '' });
      } else {
        const built = await photosToPdf(pending.files, { title: 'receipt' });
        fileId = await fileRepo.create(built.blob, { filename: built.filename, thumbnail: built.thumbnail });
      }
      if (existingFileId && existingFileId !== fileId) await fileRepo.remove(existingFileId);
      return fileId;
    }
  };
}

// Open the stored receipt for a saved expense (e.g. from a list row), by id.
export async function viewReceipt(fileId, title = 'Receipt') {
  if (!fileId) return;
  const row = await fileRepo.get(fileId);
  if (row?.blob) viewPdfModal({ title, blob: row.blob, filename: row.filename });
}
