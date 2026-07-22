// expensePanel.js — renders a subject's Expenses (the Financials ledger for one
// dog / litter / pairing / kennel) with a running total and add/edit/archive/
// delete. Reused on the dog, litter, pairing, and kennel detail pages — the same
// role timeline.js plays for events. A cost entered here lives in the `expenses`
// table (expenseRepo); this is the ledger-first entry point that complements the
// convenience "Cost" field on the event form.
import { expenseRepo, mileageAmount } from '../data/expenseRepo.js';
import { fileRepo } from '../data/fileRepo.js';
import { EXPENSE_CATEGORIES } from '../data/vocab.js';
import { getMileageDefaults, setMileageDefaults } from '../data/settings.js';
import { esc, badge, fmtDate, fmtMoney, todayYMD, confirmModal } from './ui.js';
import { openEventForm } from './eventForm.js';
import { buildReceiptField, wireReceiptField, viewReceipt } from './receiptCapture.js';

// Shared mileage-mode fragments so this panel's modal and the Financials hub's
// add-expense modal stay in lockstep. `buildMileageFields` returns the extra
// form rows; `wireMileageMode` binds the Flat↔Mileage toggle, the live "= $X"
// preview, and returns a reader that hands the save() function the right payload
// bits (amount/category/miles/mileage_rate) for whichever mode is active.

// Markup for the mode toggle + mileage inputs. `p` is an id prefix so the two
// modals don't collide, `draft` seeds an edit (miles/rate/amount/category).
export function buildMileageFields(p, draft) {
  const isMileage = draft?.miles != null;
  const rate = draft?.mileage_rate ?? getMileageDefaults().rate ?? '';
  return `
    <div class="field field-wide"><label>Entry type</label>
      <div class="pill-row">
        <label class="check-inline"><input type="radio" name="${p}-mode" value="flat"${isMileage ? '' : ' checked'}> Flat amount</label>
        <label class="check-inline"><input type="radio" name="${p}-mode" value="mileage"${isMileage ? ' checked' : ''}> Mileage</label>
      </div>
    </div>
    <div class="field" data-mode="flat"><label>Amount <span class="req">*</span></label>
      <input id="${p}-amount" type="number" step="0.01" min="0" value="${esc(draft?.amount ?? '')}"></div>
    <div class="field" data-mode="mileage" style="display:none;"><label>Miles <span class="req">*</span></label>
      <input id="${p}-miles" type="number" step="0.1" min="0" value="${esc(draft?.miles ?? '')}"></div>
    <div class="field" data-mode="mileage" style="display:none;"><label>Rate / mile <span class="req">*</span></label>
      <input id="${p}-rate" type="number" step="0.01" min="0" value="${esc(rate)}"></div>
    <div class="field field-wide" data-mode="mileage" style="display:none;">
      <span id="${p}-mileage-preview" class="field-hint"></span>
      <label class="check-inline" style="margin-top:4px;"><input type="checkbox" id="${p}-rate-default"> Save this rate as my default</label>
    </div>`;
}

// Wire the mode toggle for a modal that already contains buildMileageFields(p).
// `categorySel` is the modal's category <select> (forced to 'mileage' and locked
// while in mileage mode). Returns { mode(), payloadBits() } for save().
export function wireMileageMode(modal, p, categorySel) {
  const modeInputs = modal.querySelectorAll(`input[name="${p}-mode"]`);
  const milesEl = modal.querySelector(`#${p}-miles`);
  const rateEl = modal.querySelector(`#${p}-rate`);
  const previewEl = modal.querySelector(`#${p}-mileage-preview`);
  const defaultEl = modal.querySelector(`#${p}-rate-default`);
  const mode = () => modal.querySelector(`input[name="${p}-mode"]:checked`)?.value || 'flat';

  function refreshPreview() {
    const amt = mileageAmount(milesEl.value, rateEl.value);
    previewEl.textContent = amt != null
      ? `= ${fmtMoney(amt)} (${milesEl.value || 0} mi × ${fmtMoney(rateEl.value || 0)}/mi)`
      : 'Enter miles and a rate per mile.';
  }
  function applyMode() {
    const m = mode();
    modal.querySelectorAll('[data-mode]').forEach((el) => {
      el.style.display = el.dataset.mode === m ? '' : 'none';
    });
    if (m === 'mileage') { categorySel.value = 'mileage'; categorySel.disabled = true; refreshPreview(); }
    else { categorySel.disabled = false; }
  }
  modeInputs.forEach((r) => r.addEventListener('change', applyMode));
  milesEl.addEventListener('input', refreshPreview);
  rateEl.addEventListener('input', refreshPreview);
  applyMode();

  return {
    mode,
    // The mode-specific fields for the save payload. Flat mode nulls out the
    // mileage fields (so editing mileage→flat clears them); mileage mode leaves
    // `amount` to the repo (derived) and persists the default rate if asked.
    payloadBits() {
      if (mode() === 'mileage') {
        if (defaultEl.checked) setMileageDefaults({ rate: Number(rateEl.value) });
        return { amount: '', category: 'mileage', miles: milesEl.value, mileage_rate: rateEl.value };
      }
      return { amount: modal.querySelector(`#${p}-amount`).value, category: categorySel.value, miles: null, mileage_rate: null };
    }
  };
}

const CATEGORY_OPTIONS = EXPENSE_CATEGORIES.map((c) => `<option value="${esc(c.value)}">${esc(c.label)}</option>`).join('');

// Subject types that can also carry events, so a ledger row offers "Log event →"
// (kennel expenses have no event subject, so they don't).
const EVENTABLE = new Set(['dog', 'litter', 'pairing']);

// A small modal for creating/editing one expense. Resolves via onSaved. The
// subject is fixed by the panel's context and never editable here.
async function openExpenseForm({ subjectType, subjectId, expense = null, onSaved }) {
  const isEdit = !!expense;
  let currentFile = null;
  if (expense?.receipt_file_id) {
    const row = await fileRepo.get(expense.receipt_file_id);
    if (row) { const { blob, ...meta } = row; currentFile = meta; }
  }
  const draft = {
    amount: expense?.amount ?? '',
    miles: expense?.miles ?? null,
    mileage_rate: expense?.mileage_rate ?? null,
    category: expense?.category || 'other',
    expense_date: expense?.expense_date || todayYMD(),
    vendor: expense?.vendor || '',
    receipt_number: expense?.receipt_number || '',
    reimbursable: !!expense?.reimbursable,
    reimbursed_date: expense?.reimbursed_date || '',
    notes: expense?.notes || ''
  };

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="row-between" style="margin-bottom:12px;">
        <h2 style="margin:0;">${isEdit ? 'Edit expense' : 'Add expense'}</h2>
        <button class="btn btn-sm" data-act="cancel">✕</button>
      </div>
      <div class="form-grid">
        ${buildMileageFields('xf', draft)}
        <div class="field"><label>Category</label>
          <select id="xf-category">${CATEGORY_OPTIONS}</select></div>
        <div class="field"><label>Date <span class="req">*</span></label>
          <input id="xf-date" type="date" value="${esc(draft.expense_date)}"></div>
        <div class="field"><label>Vendor</label>
          <input id="xf-vendor" type="text" value="${esc(draft.vendor)}" placeholder="Who was paid"></div>
        <div class="field"><label>Receipt #</label>
          <input id="xf-receipt" type="text" value="${esc(draft.receipt_number)}" placeholder="Optional — auto-filled from a scanned receipt when found"></div>
        <div class="field"><label>Reimbursable</label>
          <label class="check-inline"><input type="checkbox" id="xf-reimbursable"${draft.reimbursable ? ' checked' : ''}> Owed back (e.g. by a foster dam's owner)</label></div>
        <div class="field" id="xf-reimbursed-wrap"${draft.reimbursable ? '' : ' style="display:none;"'}><label>Reimbursed on</label>
          <input id="xf-reimbursed" type="date" value="${esc(draft.reimbursed_date)}"></div>
        <div class="field field-wide"><label>Notes</label>
          <textarea id="xf-notes">${esc(draft.notes)}</textarea></div>
        ${buildReceiptField('xf', { currentFile })}
      </div>
      <div id="xf-error"></div>
      <div class="form-actions">
        <button class="btn btn-primary" data-act="save">Save expense</button>
        <button class="btn" data-act="cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const modal = overlay.querySelector('.modal');
  const categorySel = modal.querySelector('#xf-category');
  categorySel.value = draft.category;
  const mileage = wireMileageMode(modal, 'xf', categorySel);
  const receipt = wireReceiptField(modal, 'xf', { currentFile });

  // Reimbursable toggle reveals the "Reimbursed on" date (the repo also coerces
  // reimbursable=true whenever a reimbursed date is present, so the two agree).
  const reimbursableEl = modal.querySelector('#xf-reimbursable');
  const reimbursedWrap = modal.querySelector('#xf-reimbursed-wrap');
  reimbursableEl.addEventListener('change', () => {
    reimbursedWrap.style.display = reimbursableEl.checked ? '' : 'none';
  });

  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }

  async function save() {
    const saveBtn = modal.querySelector('[data-act="save"]');
    saveBtn.disabled = true;
    try {
      const receipt_file_id = await receipt.resolveFileId(expense?.receipt_file_id || null);
      const payload = {
        subject_type: subjectType,
        subject_id: subjectId,
        expense_date: modal.querySelector('#xf-date').value,
        vendor: modal.querySelector('#xf-vendor').value.trim(),
        receipt_number: modal.querySelector('#xf-receipt').value.trim(),
        reimbursable: reimbursableEl.checked,
        reimbursed_date: reimbursableEl.checked ? (modal.querySelector('#xf-reimbursed').value || null) : null,
        notes: modal.querySelector('#xf-notes').value,
        receipt_file_id,
        ...mileage.payloadBits()
      };
      const saved = isEdit
        ? await expenseRepo.update(expense.id, payload)
        : await expenseRepo.create(payload);
      close();
      onSaved?.(saved);
    } catch (e) {
      modal.querySelector('#xf-error').innerHTML = `<div class="inline-error">${esc(e.message || String(e))}</div>`;
    } finally {
      saveBtn.disabled = false;
    }
  }

  modal.querySelector('[data-act="save"]').addEventListener('click', save);
  modal.querySelectorAll('[data-act="cancel"]').forEach((b) => b.addEventListener('click', close));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
}

export function renderExpensePanel(opts) {
  const { mount, subjectType, subjectId, title = 'Expenses' } = opts;
  let showArchived = false;

  mount.innerHTML = `
    <section class="card" style="margin-top:16px;">
      <div class="row-between">
        <div class="collapsible-header" style="flex: 1; display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none;" data-toggle="xp-toggle">
          <span class="collapsible-arrow" style="transform: rotate(90deg); display: inline-block; transition: transform 0.2s; font-size: 12px;">▶</span>
          <h2 style="margin:0;">${esc(title)}</h2>
        </div>
        <strong id="xp-total" style="font-size:18px;"></strong>
      </div>
      <div class="pill-row" style="justify-content:flex-end; margin-top:8px;">
        <label class="check-inline"><input type="checkbox" id="xp-archived"> Show archived</label>
        <button class="btn btn-primary btn-sm" id="xp-add">+ Add Expense</button>
      </div>
      <div class="collapsible-content" id="xp-content" style="display: block; margin-top:12px;">
        <div id="xp-body"></div>
      </div>
    </section>`;

  const body = mount.querySelector('#xp-body');
  const totalEl = mount.querySelector('#xp-total');

  async function refresh() {
    const all = await expenseRepo.getForSubject(subjectType, subjectId, { includeArchived: true });
    const active = all.filter((x) => !x.is_archived);
    totalEl.textContent = active.length ? `Total ${fmtMoney(expenseRepo.total(active))}` : 'No costs';
    const visible = showArchived ? all : active;
    if (!visible.length) {
      body.innerHTML = `<div class="empty-state">No expenses logged yet.</div>`;
      wireAddOnly();
      return;
    }
    body.innerHTML = `<ul class="linked-list" style="margin:0; padding:0; list-style:none;">` + visible.map((x, i) => {
      const mileageMeta = x.miles != null
        ? `${esc(x.miles)} mi × ${esc(fmtMoney(x.mileage_rate ?? 0))}/mi` : '';
      const receiptMeta = x.receipt_number ? `Receipt ${esc(x.receipt_number)}` : '';
      const meta = [mileageMeta, x.vendor ? esc(x.vendor) : '', receiptMeta, x.notes ? esc(x.notes) : ''].filter(Boolean).join(' — ');
      const eventTag = x.event_id ? ' <span class="badge badge-gray" title="Captured from an event">🔗 event</span>' : '';
      const reimbursableTag = x.reimbursable
        ? (x.reimbursed_date
            ? ` <span class="badge badge-green" title="Reimbursed">↩︎ reimbursed ${esc(fmtDate(x.reimbursed_date))}</span>`
            : ' <span class="badge badge-amber" title="Reimbursable — awaiting reimbursement">↩︎ reimbursable</span>')
        : '';
      const logBtn = (!x.event_id && EVENTABLE.has(subjectType))
        ? `<button class="btn btn-sm" data-act="log-event" data-idx="${i}" title="Create a linked event for this cost">Log event →</button>` : '';
      const receiptBtn = x.receipt_file_id
        ? `<button class="btn btn-sm" data-act="view-receipt" data-idx="${i}" title="View the attached receipt">📎 Receipt</button>` : '';
      return `<li class="row-between${x.is_archived ? ' row-archived' : ''}" style="padding:8px 0; border-top:1px solid var(--border); gap:10px;">
        <div style="flex:1;">
          <div>${badge(EXPENSE_CATEGORIES, x.category)} <strong>${esc(fmtMoney(x.amount))}</strong> <span class="faint">${esc(fmtDate(x.expense_date))}</span>${eventTag}${reimbursableTag}</div>
          ${meta ? `<div class="muted" style="font-size:14px;">${meta}</div>` : ''}
        </div>
        <div class="pill-row">
          ${receiptBtn}
          ${logBtn}
          <button class="btn btn-sm" data-act="edit" data-idx="${i}">Edit</button>
          <button class="btn btn-sm" data-act="archive" data-idx="${i}">${x.is_archived ? 'Unarchive' : 'Archive'}</button>
          <button class="btn btn-danger btn-sm" data-act="delete" data-idx="${i}">Delete</button>
        </div>
      </li>`;
    }).join('') + `</ul>`;

    body.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => onAction(btn.dataset.act, visible[Number(btn.dataset.idx)]));
    });
    wireAddOnly();
  }

  async function onAction(act, x) {
    if (act === 'edit') {
      openExpenseForm({ subjectType, subjectId, expense: x, onSaved: refresh });
    } else if (act === 'view-receipt') {
      viewReceipt(x.receipt_file_id, x.vendor || 'Receipt');
    } else if (act === 'archive') {
      x.is_archived ? await expenseRepo.unarchive(x.id) : await expenseRepo.archive(x.id);
      refresh();
    } else if (act === 'delete') {
      if (await confirmModal({ title: 'Delete expense?', message: `Permanently delete this ${fmtMoney(x.amount)} expense? This cannot be undone.`, confirmLabel: 'Delete', danger: true })) {
        await expenseRepo.hardDelete(x.id);
        refresh();
      }
    } else if (act === 'log-event') {
      // Ledger → event: open a fresh event for this subject; on save, adopt it as
      // this expense's canonical link (so the cost and the event become one).
      openEventForm({
        subjectType, subjectId,
        onSaved: async (savedEvent) => {
          if (savedEvent && !Array.isArray(savedEvent) && savedEvent.id) {
            await expenseRepo.update(x.id, { event_id: savedEvent.id });
          }
          refresh();
        }
      });
    }
  }

  // (Re)bind the always-present controls. Called after each body render so the
  // Add button keeps working when the list re-draws.
  function wireAddOnly() {
    const addBtn = mount.querySelector('#xp-add');
    addBtn.onclick = () => openExpenseForm({ subjectType, subjectId, onSaved: refresh });
  }

  mount.querySelector('#xp-archived').addEventListener('change', (e) => { showArchived = e.target.checked; refresh(); });

  // Collapsible header
  const header = mount.querySelector('[data-toggle="xp-toggle"]');
  const content = mount.querySelector('#xp-content');
  const arrow = header?.querySelector('.collapsible-arrow');
  let isExpanded = true;
  if (header) {
    header.addEventListener('click', () => {
      isExpanded = !isExpanded;
      content.style.display = isExpanded ? 'block' : 'none';
      if (arrow) arrow.style.transform = isExpanded ? 'rotate(90deg)' : 'rotate(0deg)';
    });
  }

  refresh();
}
