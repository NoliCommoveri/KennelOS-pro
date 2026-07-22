// financials.js — the Financials hub (its own nav tab, not a Report). "Where the
// money lives," now split three ways by a top toggle:
//
//   • Overview — income-vs-expenses at a glance: Earned / Anticipated income,
//     total Expenses, and Net (earned − expenses), plus a component/category
//     breakdown of each side.
//   • Income   — the DERIVED income view (data/incomeView.js): one row per Sale /
//     outgoing StudService, sectioned Earned vs Anticipated, with a per-component
//     breakdown (deposits, balance, transport, boarding, stud fees) mirroring the
//     Expenses category breakdown. Clicking a row opens a compact "Adjust" modal
//     that writes straight back to the sale/stud record (or jump to the full
//     record). Non-cash pick value is shown on its own line, out of cash totals.
//   • Expenses — the Expense ledger, unchanged: running total, per-category
//     breakdown, the full filterable/exportable ledger, and "+ Add Expense".
//
// Income is never stored — it is recomputed from Sale/StudService status + paid
// dates on every load (see incomeView.js and End-State guide §21). Per-subject
// expense entry still lives on each detail page; this is the operational home.
import { expenseRepo } from '../data/expenseRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import { studServiceRepo } from '../data/studServiceRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { pairingRepo } from '../data/pairingRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { eventRepo } from '../data/eventRepo.js';
import { getIncomeRows, summarize, incomeLineItems } from '../data/incomeView.js';
import { getInvoiceDefaults, setInvoiceDefaults } from '../data/settings.js';
import { createReportView } from '../assets/reportView.js';
import { buildMileageFields, wireMileageMode } from '../assets/expensePanel.js';
import { buildReceiptField, wireReceiptField } from '../assets/receiptCapture.js';
import { editionFlags } from '../data/editionConfig.js';
import { esc, badge, fmtDate, fmtMoney, todayYMD, param } from '../assets/ui.js';
import {
  EXPENSE_CATEGORIES, EXPENSE_SUBJECT_TYPES, INCOME_SOURCE_TYPES, INCOME_COMPONENTS,
  INCOME_STATES, SALE_STATUS, STUD_SERVICE_STATUS, BOARDING_FREQUENCY_OPTIONS,
  PAYMENT_METHODS, INVOICE_LINE_LABELS, descriptor
} from '../data/vocab.js';

const SUBJECT_PAGE = { dog: 'dog.html', litter: 'litter.html', pairing: 'pairing.html', kennel: 'kennel.html' };
const CATEGORY_OPTIONS = EXPENSE_CATEGORIES.map((c) => `<option value="${esc(c.value)}">${esc(c.label)}</option>`).join('');

// Which of the three views are we in? A bucket link (financials.html?bucket=food)
// still lands on Expenses; a bare financials.html opens the Overview.
const bucket = param('bucket');
const view = param('view') || (bucket ? 'expenses' : 'overview');

const VIEW_TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'income',   label: 'Income' },
  { value: 'expenses', label: 'Expenses' }
];

const SUBTITLES = {
  overview: 'Income vs expenses at a glance — what you have earned, what is still anticipated, what you have spent, and the net between them.',
  income: 'Every dollar coming in from sales and outgoing stud services, sectioned by what is earned versus still anticipated. Click a row to adjust it or open the record.',
  expenses: 'Every expense across the program — costs on dogs, litters, pairings, and kennel-wide overhead, all from the one ledger. Add a cost against anything, filter, and export.'
};

function renderViewTabs() {
  const tabs = document.getElementById('financials-view-tabs');
  if (tabs) {
    tabs.innerHTML = VIEW_TABS.map((t) =>
      `<a class="seg-tab${t.value === view ? ' active' : ''}" href="financials.html?view=${encodeURIComponent(t.value)}">${esc(t.label)}</a>`
    ).join('');
  }
  const sub = document.getElementById('financials-subtitle');
  if (sub) sub.textContent = SUBTITLES[view] || '';
}

// --- Shared reference data (labels for the expense report's subject column) ---
const ref = { dogs: [], litters: [], pairings: [], kennels: [] };
const maps = { dogsById: new Map(), littersById: new Map(), pairingsById: new Map(), kennelsById: new Map() };
const dogName = (id) => maps.dogsById.get(id)?.call_name || '—';

function subjectLabel(x) {
  if (x.subject_type === 'dog') return dogName(x.subject_id);
  if (x.subject_type === 'kennel') return maps.kennelsById.get(x.subject_id)?.kennel_name || '—';
  if (x.subject_type === 'litter') {
    const l = maps.littersById.get(x.subject_id);
    return l ? `${dogName(l.dam_id)} × ${dogName(l.sire_id)}` : '—';
  }
  if (x.subject_type === 'pairing') {
    const p = maps.pairingsById.get(x.subject_id);
    return p ? `${dogName(p.sire_id)} × ${dogName(p.dam_id)}` : '—';
  }
  return '—';
}

// ==========================================================================
// EXPENSES view (unchanged behavior, now one of three)
// ==========================================================================

function subjectOptionsFor(type) {
  const head = '<option value="">— select —</option>';
  if (type === 'dog') {
    return head + ref.dogs.filter((d) => !d.is_archived)
      .map((d) => `<option value="${esc(d.id)}">${esc(d.call_name)}${d.registered_name ? ' — ' + esc(d.registered_name) : ''}</option>`).join('');
  }
  if (type === 'kennel') {
    return head + ref.kennels.filter((k) => !k.is_archived)
      .map((k) => `<option value="${esc(k.id)}">${esc(k.kennel_name)}${k.is_own_kennel ? ' (mine)' : ''}</option>`).join('');
  }
  if (type === 'litter') {
    return head + ref.litters.filter((l) => !l.is_archived)
      .map((l) => `<option value="${esc(l.id)}">${esc(dogName(l.dam_id))} × ${esc(dogName(l.sire_id))}${l.whelp_date ? ' (' + esc(fmtDate(l.whelp_date)) + ')' : ''}</option>`).join('');
  }
  if (type === 'pairing') {
    return head + ref.pairings.filter((p) => !p.is_archived)
      .map((p) => `<option value="${esc(p.id)}">${esc(dogName(p.sire_id))} × ${esc(dogName(p.dam_id))}${p.planned_date ? ' (' + esc(fmtDate(p.planned_date)) + ')' : ''}</option>`).join('');
  }
  return head;
}

function openAddExpense(onSaved) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="row-between" style="margin-bottom:12px;">
        <h2 style="margin:0;">Add expense</h2>
        <button class="btn btn-sm" data-act="cancel">✕</button>
      </div>
      <div class="form-grid">
        <div class="field"><label>Attached to <span class="req">*</span></label>
          <select id="af-subject-type">${EXPENSE_SUBJECT_TYPES.map((s) => `<option value="${esc(s.value)}">${esc(s.label)}</option>`).join('')}</select></div>
        <div class="field"><label>Subject <span class="req">*</span></label>
          <select id="af-subject-id">${subjectOptionsFor('dog')}</select></div>
        ${buildMileageFields('af', null)}
        <div class="field"><label>Category</label>
          <select id="af-category">${CATEGORY_OPTIONS}</select></div>
        <div class="field"><label>Date <span class="req">*</span></label>
          <input id="af-date" type="date" value="${esc(todayYMD())}"></div>
        <div class="field"><label>Vendor</label>
          <input id="af-vendor" type="text" placeholder="Who was paid"></div>
        <div class="field"><label>Receipt #</label>
          <input id="af-receipt" type="text" placeholder="Optional — auto-filled from a scanned receipt when found"></div>
        <div class="field field-wide"><label>Notes</label><textarea id="af-notes"></textarea></div>
        ${editionFlags.receiptAttach ? buildReceiptField('af', {}) : ''}
      </div>
      <div id="af-error"></div>
      <div class="form-actions">
        <button class="btn btn-primary" data-act="save">Save expense</button>
        <button class="btn" data-act="cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const modal = overlay.querySelector('.modal');
  const typeSel = modal.querySelector('#af-subject-type');
  const subjSel = modal.querySelector('#af-subject-id');
  typeSel.addEventListener('change', () => { subjSel.innerHTML = subjectOptionsFor(typeSel.value); });
  const mileage = wireMileageMode(modal, 'af', modal.querySelector('#af-category'));
  const receipt = editionFlags.receiptAttach ? wireReceiptField(modal, 'af', {}) : null;

  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  async function save() {
    const saveBtn = modal.querySelector('[data-act="save"]');
    saveBtn.disabled = true;
    try {
      const receipt_file_id = receipt ? await receipt.resolveFileId(null) : null;
      const saved = await expenseRepo.create({
        subject_type: typeSel.value,
        subject_id: subjSel.value,
        expense_date: modal.querySelector('#af-date').value,
        vendor: modal.querySelector('#af-vendor').value.trim(),
        receipt_number: modal.querySelector('#af-receipt').value.trim(),
        notes: modal.querySelector('#af-notes').value,
        receipt_file_id,
        ...mileage.payloadBits()
      });
      close();
      onSaved?.(saved);
    } catch (e) {
      modal.querySelector('#af-error').innerHTML = `<div class="inline-error">${esc(e.message || String(e))}</div>`;
    } finally {
      saveBtn.disabled = false;
    }
  }
  modal.querySelector('[data-act="save"]').addEventListener('click', save);
  modal.querySelectorAll('[data-act="cancel"]').forEach((b) => b.addEventListener('click', close));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
}

function renderExpenseBucketTabs() {
  const tabs = document.getElementById('financials-bucket-tabs');
  if (!tabs) return;
  const catTabs = EXPENSE_CATEGORIES.map((c) =>
    `<a class="seg-tab${c.value === bucket ? ' active' : ''}" href="financials.html?view=expenses&bucket=${encodeURIComponent(c.value)}">${esc(c.label)}</a>`
  ).join('');
  tabs.innerHTML = catTabs + `<a class="seg-tab${bucket ? '' : ' active'}" href="financials.html?view=expenses">All</a>`;
}

function renderExpenseSummary(expenses) {
  const bucketLabel = bucket ? descriptor(EXPENSE_CATEGORIES, bucket).label : null;
  const summary = document.getElementById('summary');
  const grand = expenseRepo.total(expenses);
  const byCat = new Map();
  for (const x of expenses) byCat.set(x.category, (byCat.get(x.category) || 0) + (Number(x.amount) || 0));
  const catRows = EXPENSE_CATEGORIES.filter((c) => byCat.get(c.value)).map((c) =>
    `<li class="row-between" style="padding:6px 0; border-top:1px solid var(--border);">
      <span>${badge(EXPENSE_CATEGORIES, c.value)}</span>
      <strong>${esc(fmtMoney(byCat.get(c.value)))}</strong>
    </li>`).join('');
  summary.innerHTML = `
    <div class="row-between" style="align-items:baseline;">
      <h2 style="margin:0;">Total spent${bucket ? ` — ${esc(bucketLabel)}` : ''}</h2>
      <strong style="font-size:22px;">${esc(fmtMoney(grand))}</strong>
    </div>
    <p class="muted" style="margin:4px 0 0; font-size:13px;">Across ${expenses.length} expense${expenses.length === 1 ? '' : 's'} (active only).</p>
    ${catRows ? `<ul class="linked-list" style="margin:12px 0 0; padding:0; list-style:none;">${catRows}</ul>` : ''}`;
}

async function loadExpenses() {
  const expenses = await expenseRepo.getAll({ includeArchived: false });
  expenses.sort((a, b) => (b.expense_date || '').localeCompare(a.expense_date || ''));
  return bucket ? expenses.filter((x) => x.category === bucket) : expenses;
}

function initExpenses() {
  renderExpenseBucketTabs();
  const bucketLabel = bucket ? descriptor(EXPENSE_CATEGORIES, bucket).label : null;
  const subjectTypeLabel = (v) => descriptor(EXPENSE_SUBJECT_TYPES, v).label;
  const year = (x) => (x.expense_date || '').slice(0, 4);

  const view = createReportView({
    mount: document.getElementById('report-mount'),
    csvFilename: `financials-${bucket ? bucket + '-' : ''}${new Date().toISOString().slice(0, 10)}.csv`,
    search: { placeholder: 'Search subject, vendor, receipt #, or notes…', text: (x) => `${subjectLabel(x)} ${x.vendor || ''} ${x.receipt_number || ''} ${x.notes || ''}` },
    filters: [
      { id: 'category', label: 'Category', options: EXPENSE_CATEGORIES, match: (x, v) => x.category === v },
      { id: 'subject_type', label: 'Attached to', options: EXPENSE_SUBJECT_TYPES, match: (x, v) => x.subject_type === v },
      { id: 'year', label: 'Year', options: [], match: (x, v) => year(x) === v }
    ],
    columns: [
      { header: 'Date', value: (x) => (x.expense_date ? fmtDate(x.expense_date) : ''), csv: (x) => x.expense_date || '' },
      { header: 'Category', value: (x) => x.category || '', badge: EXPENSE_CATEGORIES, csv: (x) => descriptor(EXPENSE_CATEGORIES, x.category).label },
      { header: 'Amount', value: (x) => fmtMoney(x.amount), csv: (x) => String(x.amount ?? '') },
      { header: 'Attached to', value: (x) => subjectTypeLabel(x.subject_type) },
      { header: 'Subject', value: (x) => subjectLabel(x) },
      { header: 'Vendor', value: (x) => x.vendor || '' },
      { header: 'Receipt #', value: (x) => x.receipt_number || '' },
      { header: 'File', value: (x) => x.receipt_file_id ? '📎' : '', csv: (x) => x.receipt_file_id ? 'yes' : '' },
      { header: 'Notes', value: (x) => x.notes || '' }
    ],
    onRowClick: (x) => {
      const page = SUBJECT_PAGE[x.subject_type];
      if (page && x.subject_id) location.href = `${page}?id=${encodeURIComponent(x.subject_id)}`;
    },
    load: async () => {
      const expenses = await loadExpenses();
      renderExpenseSummary(expenses);
      const years = [...new Set(expenses.map(year).filter(Boolean))].sort().reverse();
      const yearSel = document.querySelector('#report-mount select[aria-label="Year"]');
      if (yearSel) {
        const cur = yearSel.value;
        yearSel.innerHTML = `<option value="">Year: All</option>` + years.map((y) => `<option value="${esc(y)}">${esc(y)}</option>`).join('');
        yearSel.value = cur;
      }
      return expenses;
    },
    emptyText: bucket ? `No ${bucketLabel} expenses recorded yet.` : 'No expenses recorded yet. Use “+ Add Expense” to log one.'
  });

  const addBtn = document.getElementById('add-expense');
  addBtn.style.display = ''; // shown only on the Expenses view (see init)
  addBtn.addEventListener('click', () => openAddExpense(() => view.refresh()));
}

// ==========================================================================
// INCOME view (derived — data/incomeView.js)
// ==========================================================================

// Compact per-record editor: the money/status/paid-date fields that drive
// earned↔anticipated, saved straight to the sale/stud record. Every field maps to
// a real column, so this is the sale/stud edit form in miniature — not a separate
// store. A "Open full record →" link reaches the complete editor.
function openAdjust(row, onSaved) {
  const isSale = row.source_type === 'sale';
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const statusVocab = isSale ? SALE_STATUS : STUD_SERVICE_STATUS;
  const statusOptions = (cur) => statusVocab.map((s) =>
    `<option value="${esc(s.value)}"${s.value === cur ? ' selected' : ''}>${esc(s.label)}</option>`).join('');

  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="row-between" style="margin-bottom:4px;">
        <h2 style="margin:0;">Adjust ${isSale ? 'sale' : 'stud service'}</h2>
        <button class="btn btn-sm" data-act="cancel">✕</button>
      </div>
      <p class="muted" style="margin:0 0 12px; font-size:13px;">${esc(row.dog)} ${isSale ? '→' : '×'} ${esc(row.counterparty)}</p>
      <div class="form-grid" id="adj-form"></div>
      <div id="adj-error"></div>
      <div class="form-actions">
        <button class="btn btn-primary" data-act="save">Save</button>
        <button class="btn" data-act="cancel">Cancel</button>
        <a class="btn btn-sm" href="${esc(row.href)}" style="margin-left:auto;">Open full record →</a>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const modal = overlay.querySelector('.modal');
  const form = modal.querySelector('#adj-form');

  // Pull the live record so we edit real stored values, not the derived row.
  (isSale ? saleRepo.getById(row.source_id) : studServiceRepo.getById(row.source_id)).then((rec) => {
    if (!rec) { form.innerHTML = '<p class="inline-error">Record not found.</p>'; return; }
    const moneyVal = (v) => (v == null ? '' : v);
    if (isSale) {
      // Deferred pickup boarding earning = amount × count (the free-text count of
      // frequency units in deferred_boarding_duration_days). Editable here so the
      // figure that feeds the "Deferred boarding" income component can be adjusted
      // straight from the hub.
      const freqOptions = `<option value="">— per —</option>` + BOARDING_FREQUENCY_OPTIONS
        .map((o) => `<option value="${esc(o)}"${o === rec.deferred_boarding_frequency ? ' selected' : ''}>${esc(o)}</option>`).join('');
      form.innerHTML = `
        <div class="field"><label>Status</label><select id="adj-status">${statusOptions(rec.status)}</select></div>
        <div class="field"><label>Price</label><input id="adj-price" type="number" min="0" step="0.01" value="${esc(moneyVal(rec.price))}"></div>
        <div class="field"><label>Deposit amount</label><input id="adj-deposit_amount" type="number" min="0" step="0.01" value="${esc(moneyVal(rec.deposit_amount))}"></div>
        <div class="field"><label>Deposit date</label><input id="adj-deposit_date" type="date" value="${esc(rec.deposit_date || '')}"></div>
        <div class="field"><label>Balance paid date</label><input id="adj-balance_paid_date" type="date" value="${esc(rec.balance_paid_date || '')}"></div>
        <div class="field"><label>Transport fee</label><input id="adj-transport_fee" type="number" min="0" step="0.01" value="${esc(moneyVal(rec.transport_fee))}"></div>
        <div class="field field-wide"><label>Deferred pickup boarding</label>
          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
            <input id="adj-deferred_boarding_amount" type="number" min="0" step="0.01" value="${esc(moneyVal(rec.deferred_boarding_amount))}" style="flex:1; min-width:80px;">
            <span class="faint">per</span>
            <select id="adj-deferred_boarding_frequency" style="flex:1; min-width:80px;">${freqOptions}</select>
            <span class="faint">×</span>
            <input id="adj-deferred_boarding_duration_days" type="text" placeholder="count" value="${esc(rec.deferred_boarding_duration_days || '')}" style="flex:1; min-width:60px;">
          </div>
          <span class="field-hint">Earning = amount × count (e.g. $30 × 2 weeks = $60).</span>
        </div>`;
    } else {
      form.innerHTML = `
        <div class="field"><label>Status</label><select id="adj-status">${statusOptions(rec.status)}</select></div>
        <div class="field"><label>Fee amount</label><input id="adj-fee_amount" type="number" min="0" step="0.01" value="${esc(moneyVal(rec.fee_amount))}"></div>
        <p class="field-hint field-wide">Earned once the status is “Completed,” anticipated while arranged/in progress.</p>`;
    }
  });

  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  const numOrNull = (id) => {
    const el = modal.querySelector(id);
    if (!el || el.value === '' || el.value == null) return null;
    return Number(el.value);
  };
  const strOrNull = (id) => modal.querySelector(id)?.value || null;

  async function save() {
    try {
      if (isSale) {
        await saleRepo.update(row.source_id, {
          status: modal.querySelector('#adj-status').value,
          price: numOrNull('#adj-price'),
          deposit_amount: numOrNull('#adj-deposit_amount'),
          deposit_date: strOrNull('#adj-deposit_date'),
          balance_paid_date: strOrNull('#adj-balance_paid_date'),
          transport_fee: numOrNull('#adj-transport_fee'),
          deferred_boarding_amount: numOrNull('#adj-deferred_boarding_amount'),
          deferred_boarding_frequency: modal.querySelector('#adj-deferred_boarding_frequency')?.value || '',
          deferred_boarding_duration_days: (modal.querySelector('#adj-deferred_boarding_duration_days')?.value || '').trim() || null
        });
      } else {
        await studServiceRepo.update(row.source_id, {
          status: modal.querySelector('#adj-status').value,
          fee_amount: numOrNull('#adj-fee_amount')
        });
      }
      close();
      onSaved?.();
    } catch (e) {
      modal.querySelector('#adj-error').innerHTML = `<div class="inline-error">${esc(e.message || String(e))}</div>`;
    }
  }
  modal.querySelector('[data-act="save"]').addEventListener('click', save);
  modal.querySelectorAll('[data-act="cancel"]').forEach((b) => b.addEventListener('click', close));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
}

// The per-component breakdown block (Earned / Anticipated columns), reused by the
// Income summary and the Overview. It is a SINGLE grid (not one grid per row) so
// the two numeric columns share tracks and line up cleanly down the whole list.
// Only components actually present are listed; `pick` is a non-cash line whose
// estimate spans both numeric columns.
function componentBreakdownHtml(byComponent) {
  const present = INCOME_COMPONENTS.filter((c) => byComponent.get(c.value));
  if (!present.length) return '';
  const money = (v) => (v ? esc(fmtMoney(v)) : '<span class="faint">—</span>');
  const bd = 'border-top:1px solid var(--border); padding:6px 0;';
  const cells = present.map((c) => {
    const acc = byComponent.get(c.value);
    if (c.value === 'pick') {
      return `<div style="${bd}">${badge(INCOME_COMPONENTS, c.value)}</div>
        <div class="faint" style="${bd} grid-column:2 / span 2; text-align:right;">${esc(fmtMoney(acc.pick))} est.</div>`;
    }
    return `<div style="${bd}">${badge(INCOME_COMPONENTS, c.value)}</div>
      <div style="${bd} text-align:right;">${money(acc.earned)}</div>
      <div style="${bd} text-align:right;">${money(acc.anticipated)}</div>`;
  }).join('');
  return `<div style="display:grid; grid-template-columns:1fr auto auto; column-gap:16px; margin-top:12px;">
    <div></div>
    <div class="muted" style="font-size:12px; text-align:right;">Earned</div>
    <div class="muted" style="font-size:12px; text-align:right;">Anticipated</div>
    ${cells}
  </div>`;
}

function renderIncomeSummary(rows) {
  const { totals, byComponent } = summarize(rows);
  const summary = document.getElementById('summary');
  const breakdown = componentBreakdownHtml(byComponent);
  summary.innerHTML = `
    <div class="row-between" style="align-items:baseline; gap:16px; flex-wrap:wrap;">
      <h2 style="margin:0;">Income</h2>
      <div style="display:flex; gap:20px; align-items:baseline;">
        <span>${badge(INCOME_STATES, 'earned')} <strong style="font-size:20px;">${esc(fmtMoney(totals.earned))}</strong></span>
        <span>${badge(INCOME_STATES, 'anticipated')} <strong style="font-size:20px;">${esc(fmtMoney(totals.anticipated))}</strong></span>
      </div>
    </div>
    <p class="muted" style="margin:4px 0 0; font-size:13px;">Across ${rows.length} record${rows.length === 1 ? '' : 's'} (active only).${totals.pick ? ` Plus ${esc(fmtMoney(totals.pick))} estimated non-cash pick value.` : ''}</p>
    ${breakdown}`;
}

// One income box (Earned or Anticipated) — its own card, table, filters, and CSV
// export, following the Active Breeding two-box pattern. `state` picks which
// rolled-up amount the Amount column shows and which rows the box includes. A
// part-paid sale (deposit in, balance owed) shows in BOTH boxes, each with its
// own portion — that's the earned/anticipated split made visible.
function makeIncomeBox(mountId, state, onChanged) {
  const year = (r) => (r.date || '').slice(0, 4);
  const sourceLabel = (v) => descriptor(INCOME_SOURCE_TYPES, v).label;
  const amountOf = (r) => (state === 'earned' ? r.earned : r.anticipated);
  return createReportView({
    mount: document.getElementById(mountId),
    csvFilename: `income-${state}-${new Date().toISOString().slice(0, 10)}.csv`,
    search: { placeholder: 'Search dog or counterparty…', text: (r) => `${r.dog} ${r.counterparty}` },
    filters: [
      { id: 'source_type', label: 'Source', options: INCOME_SOURCE_TYPES, match: (r, v) => r.source_type === v },
      { id: 'year', label: 'Year', options: [], match: (r, v) => year(r) === v }
    ],
    columns: [
      { header: 'Date', value: (r) => (r.date ? fmtDate(r.date) : ''), csv: (r) => r.date || '' },
      { header: 'Source', value: (r) => r.source_type, badge: INCOME_SOURCE_TYPES, csv: (r) => sourceLabel(r.source_type) },
      { header: 'Dog', value: (r) => r.dog },
      { header: 'Counterparty', value: (r) => r.counterparty },
      // Status badge vocab differs by source (SALE_STATUS vs STUD_SERVICE_STATUS)
      // and reportView takes a single vocab array, so render the resolved label
      // as plain text rather than a colored badge here.
      { header: 'Status',
        value: (r) => descriptor(r.source_type === 'sale' ? SALE_STATUS : STUD_SERVICE_STATUS, r.status).label,
        csv: (r) => r.status || '' },
      { header: 'Amount', value: (r) => fmtMoney(amountOf(r)), csv: (r) => String(amountOf(r) || '') }
    ],
    onRowClick: (r) => openAdjust(r, onChanged),
    load: async () => {
      const rows = (await getIncomeRows({ includeArchived: false })).filter((r) => amountOf(r) > 0);
      const years = [...new Set(rows.map(year).filter(Boolean))].sort().reverse();
      const yearSel = document.querySelector(`#${mountId} select[aria-label="Year"]`);
      if (yearSel) {
        const cur = yearSel.value;
        yearSel.innerHTML = `<option value="">Year: All</option>` + years.map((y) => `<option value="${esc(y)}">${esc(y)}</option>`).join('');
        yearSel.value = cur;
      }
      return rows;
    },
    emptyText: state === 'earned'
      ? 'No earned income yet.'
      : 'No anticipated income — every recorded amount is either collected or closed.'
  });
}

async function initIncome() {
  // No sub-tabs: earned vs anticipated live as two grouped boxes on one page
  // (the Active Breeding pattern). Drop the sub-tab nav row entirely.
  document.getElementById('financials-bucket-tabs')?.remove();

  // Replace the single report card with two standalone boxes.
  const section = document.getElementById('report-section');
  section.classList.remove('card');
  section.innerHTML = `
    <section class="card">
      <div class="row-between" style="align-items:baseline;">
        <h2 style="margin:0;">Earned</h2>
        <strong id="earned-box-total" style="font-size:18px; color:var(--success);"></strong>
      </div>
      <div id="income-earned-mount" style="margin-top:12px;"></div>
    </section>
    <section class="card" style="margin-top:16px;">
      <div class="row-between" style="align-items:baseline;">
        <h2 style="margin:0;">Anticipated</h2>
        <strong id="anticipated-box-total" style="font-size:18px; color:var(--warning);"></strong>
      </div>
      <div id="income-anticipated-mount" style="margin-top:12px;"></div>
    </section>`;

  // Shared refresh: recompute the summary + both box header totals after an edit.
  async function refreshSummary() {
    const rows = await getIncomeRows({ includeArchived: false });
    renderIncomeSummary(rows);
    const { totals } = summarize(rows);
    const e = document.getElementById('earned-box-total');
    const a = document.getElementById('anticipated-box-total');
    if (e) e.textContent = fmtMoney(totals.earned);
    if (a) a.textContent = fmtMoney(totals.anticipated);
  }

  const onChanged = () => { refreshSummary(); earnedBox.refresh(); anticipatedBox.refresh(); };
  const earnedBox = makeIncomeBox('income-earned-mount', 'earned', onChanged);
  const anticipatedBox = makeIncomeBox('income-anticipated-mount', 'anticipated', onChanged);
  await refreshSummary();
}

// ==========================================================================
// OVERVIEW view — income vs expenses, net
// ==========================================================================

// One overview tile. A fixed two-line label height keeps every tile's number on
// the same baseline whether its label is one line ("Earned income") or two
// ("Anticipated income"); combined with `grid-auto-rows: 1fr` on the container
// (initOverview), all four tiles render at identical size.
function tile(label, value, tone) {
  // margin:0 overrides the global `.card + .card { margin-top:16px }`, which would
  // otherwise push tiles 2–4 down inside their grid cells and render them shorter.
  // height:100% + the grid's align-items:stretch makes all four fill equal cells.
  return `<div class="card" style="margin:0; height:100%; box-sizing:border-box; display:flex; flex-direction:column; justify-content:center; text-align:center; padding:16px;">
    <div class="muted" style="font-size:12px; text-transform:uppercase; letter-spacing:.04em; min-height:2.6em; display:flex; align-items:center; justify-content:center;">${esc(label)}</div>
    <div style="font-size:24px; font-weight:700; padding-top:6px; ${tone ? `color:var(--${tone});` : ''}">${esc(value)}</div>
  </div>`;
}

async function initOverview() {
  document.getElementById('financials-bucket-tabs')?.remove();
  const [incomeRows, expenses] = await Promise.all([
    getIncomeRows({ includeArchived: false }),
    expenseRepo.getAll({ includeArchived: false })
  ]);
  const { totals, byComponent } = summarize(incomeRows);
  const spent = expenseRepo.total(expenses);
  const net = totals.earned - spent;

  const byCat = new Map();
  for (const x of expenses) byCat.set(x.category, (byCat.get(x.category) || 0) + (Number(x.amount) || 0));
  const catRows = EXPENSE_CATEGORIES.filter((c) => byCat.get(c.value)).map((c) =>
    `<li class="row-between" style="padding:6px 0; border-top:1px solid var(--border);">
      <span>${badge(EXPENSE_CATEGORIES, c.value)}</span><strong>${esc(fmtMoney(byCat.get(c.value)))}</strong>
    </li>`).join('');
  const incomeBreak = componentBreakdownHtml(byComponent);

  document.getElementById('summary').innerHTML = `
    <div style="display:grid; grid-template-columns:repeat(2, 1fr); grid-auto-rows:1fr; gap:12px;">
      ${tile('Earned income', fmtMoney(totals.earned), 'success')}
      ${tile('Anticipated income', fmtMoney(totals.anticipated), 'warning')}
      ${tile('Total expenses', fmtMoney(spent), 'danger')}
      ${tile('Net (earned − spent)', fmtMoney(net), net < 0 ? 'danger' : 'success')}
    </div>
    <p class="muted" style="margin:12px 0 0; font-size:13px;">
      Net compares cash actually earned against total expenses. Anticipated income (${esc(fmtMoney(totals.anticipated))}) is money still expected on open sales and stud services${totals.pick ? `; a further ${esc(fmtMoney(totals.pick))} of estimated non-cash pick value is tracked separately` : ''}.
    </p>`;

  document.getElementById('report-mount').innerHTML = `
    <div style="display:flex; gap:16px; flex-wrap:wrap;">
      <section style="flex:1; min-width:260px;">
        <div class="row-between" style="align-items:baseline;"><h2 style="margin:0;">Income</h2>
          <a class="btn btn-sm" href="financials.html?view=income">View →</a></div>
        ${incomeBreak || '<p class="muted" style="margin:12px 0 0;">No income recorded yet.</p>'}
      </section>
      <section style="flex:1; min-width:260px;">
        <div class="row-between" style="align-items:baseline;"><h2 style="margin:0;">Expenses</h2>
          <a class="btn btn-sm" href="financials.html?view=expenses">View →</a></div>
        <ul class="linked-list" style="margin:12px 0 0; padding:0; list-style:none;">${catRows || '<li class="muted" style="padding:8px 0;">No expenses recorded yet.</li>'}</ul>
      </section>
    </div>`;
}

// ==========================================================================
// INVOICE / RECEIPT generator (opens the print-only invoice.html, §24)
// ==========================================================================

// A source record is any income row (a Sale or an outgoing StudService that
// carries money — exactly what getIncomeRows returns). The modal lets the owner
// pick one, choose Invoice vs Receipt, then per line item choose Full vs Partial
// and enter an "already collected" amount (and, on invoices, a per-line due
// date). Full/Partial + collected drives the money math (see the invoice page);
// the volatile per-line choices ride the URL as a compact `cfg` JSON, while the
// document number/notes/receipt-method persist on the record for next time.
const PAYMENT_METHOD_LIST = PAYMENT_METHODS.map((m) => `<option value="${esc(m)}"></option>`).join('');

// Soonest of the sale's balance-due date and any scheduled placement (drop-off)
// date for the puppy — the per-line due-date prefill on an invoice.
async function soonestDueFor(record) {
  const dates = [];
  if (record.balance_due_date) dates.push(record.balance_due_date);
  if (record.dog_id) {
    const evs = await eventRepo.getForSubject('dog', record.dog_id);
    for (const e of evs) if (e.event_type === 'placement' && e.event_date) dates.push(e.event_date);
  }
  dates.sort();
  return dates[0] || '';
}

async function openGenerateModal() {
  const rows = await getIncomeRows({ includeArchived: false });
  const rowByKey = new Map(rows.map((r) => [`${r.source_type}:${r.source_id}`, r]));

  const optFor = (r) => {
    const sep = r.source_type === 'sale' ? '→' : '×';
    const when = r.date ? ` (${fmtDate(r.date)})` : '';
    return `<option value="${esc(r.source_type)}:${esc(r.source_id)}">${esc(r.dog)} ${sep} ${esc(r.counterparty)}${esc(when)}</option>`;
  };
  const saleOpts = rows.filter((r) => r.source_type === 'sale').map(optFor).join('');
  const studOpts = rows.filter((r) => r.source_type === 'stud').map(optFor).join('');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="max-width:640px;">
      <div class="row-between" style="margin-bottom:12px;">
        <h2 style="margin:0;">Invoice / Receipt</h2>
        <button class="btn btn-sm" data-act="cancel">✕</button>
      </div>
      ${rows.length ? `
      <div class="form-grid">
        <div class="field field-wide"><label>Document</label>
          <div class="pill-row">
            <label class="check-inline"><input type="radio" name="gen-doc" value="invoice" checked> Invoice</label>
            <label class="check-inline"><input type="radio" name="gen-doc" value="receipt"> Receipt</label>
          </div>
        </div>
        <div class="field field-wide"><label>For <span class="req">*</span></label>
          <select id="gen-source">
            <option value="">— select a sale or stud service —</option>
            ${saleOpts ? `<optgroup label="Sales">${saleOpts}</optgroup>` : ''}
            ${studOpts ? `<optgroup label="Stud services">${studOpts}</optgroup>` : ''}
          </select>
        </div>
      </div>
      <div id="gen-config"></div>
      <div id="gen-error"></div>
      <div class="form-actions">
        <button class="btn btn-primary" data-act="generate" disabled>Generate →</button>
        <button class="btn" data-act="cancel">Cancel</button>
      </div>` : `
      <p class="muted">No income records to invoice yet. Record a sale or an outgoing stud service with a price, deposit, or fee first.</p>
      <div class="form-actions"><button class="btn" data-act="cancel">Close</button></div>`}
    </div>`;
  document.body.appendChild(overlay);
  const modal = overlay.querySelector('.modal');

  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  modal.querySelectorAll('[data-act="cancel"]').forEach((b) => b.addEventListener('click', close));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);

  const sourceSel = modal.querySelector('#gen-source');
  const configEl = modal.querySelector('#gen-config');
  const genBtn = modal.querySelector('[data-act="generate"]');
  if (!sourceSel) return; // no rows — nothing to wire

  // Everything the config section holds, so a doc-type toggle can re-render
  // without losing typed values.
  const st = {
    doc: 'invoice', source: null, record: null, order: [], lines: {},
    accepted: new Set(getInvoiceDefaults().acceptedMethods),
    number: '', notes: '', payMethod: '', payReference: ''
  };

  // Pull the current DOM state back into `st` before any re-render.
  function syncFromDom() {
    configEl.querySelectorAll('.gen-line').forEach((el) => {
      const ln = st.lines[el.dataset.key];
      if (!ln) return;
      ln.include = el.querySelector('.ln-include').checked;
      ln.mode = el.querySelector('.ln-mode:checked')?.value || 'full';
      ln.collected = el.querySelector('.ln-collected').value;
      const due = el.querySelector('.ln-due');
      if (due) ln.dueDate = due.value;
    });
    const num = configEl.querySelector('#gen-num'); if (num) st.number = num.value;
    const notes = configEl.querySelector('#gen-notes'); if (notes) st.notes = notes.value;
    const pm = configEl.querySelector('#gen-pm'); if (pm) st.payMethod = pm.value;
    const ref = configEl.querySelector('#gen-ref'); if (ref) st.payReference = ref.value;
    const acc = configEl.querySelectorAll('.acc-method');
    if (acc.length) st.accepted = new Set([...acc].filter((c) => c.checked).map((c) => c.value));
  }

  function lineRowHtml(key) {
    const ln = st.lines[key];
    const label = INVOICE_LINE_LABELS[key] || key;
    // Deposits are always due immediately, so they get a static note rather than
    // a date picker; the other four line types carry a calculated due date.
    const dueField = st.doc !== 'invoice'
      ? ''
      : (key === 'deposit'
        ? `<span class="faint">Due immediately</span>`
        : `<label class="check-inline" style="gap:4px;">Due by <input type="date" class="ln-due" value="${esc(ln.dueDate || '')}"></label>`);
    return `<div class="gen-line" data-key="${esc(key)}" style="border-top:1px solid var(--border); padding:8px 0;">
      <label class="check-inline" style="gap:8px;"><input type="checkbox" class="ln-include"${ln.include ? ' checked' : ''}> <strong>${esc(label)}</strong> <span class="faint">${esc(fmtMoney(ln.base))}</span></label>
      <div style="display:flex; gap:14px; flex-wrap:wrap; align-items:center; margin-top:5px; padding-left:24px;">
        <label class="check-inline" style="gap:4px;"><input type="radio" name="mode-${esc(key)}" class="ln-mode" value="full"${ln.mode !== 'partial' ? ' checked' : ''}> Full</label>
        <label class="check-inline" style="gap:4px;"><input type="radio" name="mode-${esc(key)}" class="ln-mode" value="partial"${ln.mode === 'partial' ? ' checked' : ''}> Partial</label>
        <label class="check-inline" style="gap:4px;">Already collected <input type="number" class="ln-collected" min="0" step="0.01" value="${esc(ln.collected || '')}" style="width:100px;"></label>
        ${dueField}
      </div>
    </div>`;
  }

  function paymentSectionHtml() {
    if (st.doc === 'invoice') {
      const boxes = PAYMENT_METHODS.map((m) =>
        `<label class="check-inline" style="gap:4px;"><input type="checkbox" class="acc-method" value="${esc(m)}"${st.accepted.has(m) ? ' checked' : ''}> ${esc(m)}</label>`).join('');
      return `<div class="field field-wide">
        <label>Accepted payment methods <span class="faint">(shown on the invoice)</span></label>
        <div style="display:flex; flex-wrap:wrap; gap:6px 14px; margin-top:4px;">${boxes}</div>
        <div class="pill-row" style="margin-top:6px; align-items:center;">
          <button class="btn btn-sm" data-act="save-default" type="button">Save as my default</button>
          <span id="gen-default-saved" class="field-hint"></span>
        </div>
      </div>`;
    }
    return `<div class="field"><label>Payment method used</label>
        <input id="gen-pm" type="text" list="gen-pm-list" value="${esc(st.payMethod)}" placeholder="e.g. Check, Venmo…">
        <datalist id="gen-pm-list">${PAYMENT_METHOD_LIST}</datalist>
      </div>
      <div class="field"><label>Reference</label>
        <input id="gen-ref" type="text" value="${esc(st.payReference)}" placeholder="Check #, transaction id…">
      </div>`;
  }

  function renderConfig() {
    if (!st.record) { configEl.innerHTML = ''; genBtn.disabled = true; return; }
    const lineRows = st.order.map(lineRowHtml).join('');
    const hint = st.doc === 'invoice'
      ? 'Full bills the whole amount and subtracts anything already collected; Partial bills only the amount you enter and prints "(partial)".'
      : 'Full receipts the remaining amount (line total minus anything already collected); Partial receipts only the amount you enter and prints "(partial)".';
    configEl.innerHTML = `
      <div style="margin-top:12px; border-top:1px solid var(--border); padding-top:10px;">
        <label style="font-weight:600;">Line items</label>
        <p class="field-hint" style="margin:2px 0 4px;">${esc(hint)}</p>
        ${lineRows || '<p class="faint">No billable amounts on this record.</p>'}
      </div>
      <div class="form-grid" style="margin-top:12px;">
        ${paymentSectionHtml()}
        <div class="field"><label>Document #</label>
          <input id="gen-num" type="text" value="${esc(st.number)}" placeholder="Auto (${st.doc === 'receipt' ? 'RCT' : 'INV'}-…)">
        </div>
        <div class="field field-wide"><label>Notes on document</label>
          <textarea id="gen-notes" placeholder="Optional message shown on the ${st.doc}">${esc(st.notes)}</textarea>
        </div>
      </div>`;
    genBtn.disabled = false;

    const saveDefault = configEl.querySelector('[data-act="save-default"]');
    if (saveDefault) saveDefault.addEventListener('click', () => {
      syncFromDom();
      setInvoiceDefaults({ acceptedMethods: [...st.accepted] });
      const note = configEl.querySelector('#gen-default-saved');
      if (note) note.textContent = 'Saved as default.';
    });
  }

  async function onSourceChange() {
    const key = sourceSel.value;
    const row = key ? rowByKey.get(key) : null;
    if (!row) { st.record = null; renderConfig(); return; }
    const record = row.source_type === 'sale'
      ? await saleRepo.getById(row.source_id)
      : await studServiceRepo.getById(row.source_id);
    const items = incomeLineItems(row.source_type, record);
    const soonest = row.source_type === 'sale' ? await soonestDueFor(record) : '';
    st.source = row.source_type;
    st.record = record;
    st.order = items.map((it) => it.component);
    st.lines = {};
    for (const it of items) st.lines[it.component] = { base: it.amount, include: true, mode: 'full', collected: '', dueDate: soonest };
    st.number = record.invoice_number || '';
    st.notes = record.invoice_notes || '';
    st.payMethod = record.payment_method || '';
    st.payReference = record.payment_reference || '';
    renderConfig();
  }

  sourceSel.addEventListener('change', () => {
    onSourceChange().catch((e) => { modal.querySelector('#gen-error').innerHTML = `<div class="inline-error">${esc(e.message || String(e))}</div>`; });
  });

  // Doc-type toggle re-renders the config (invoice-only vs receipt-only fields)
  // without losing what's typed.
  modal.querySelectorAll('input[name="gen-doc"]').forEach((r) => r.addEventListener('change', (e) => {
    if (!e.target.checked) return;
    syncFromDom();
    st.doc = e.target.value;
    renderConfig();
  }));

  genBtn.addEventListener('click', async () => {
    const errBox = modal.querySelector('#gen-error');
    errBox.innerHTML = '';
    if (!st.record) return;
    syncFromDom();
    const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
    const lines = st.order.filter((k) => st.lines[k].include).map((k) => {
      const ln = st.lines[k];
      return { key: k, mode: ln.mode === 'partial' ? 'partial' : 'full', collected: num(ln.collected), dueDate: ln.dueDate || '' };
    });
    if (!lines.length) { errBox.innerHTML = `<div class="inline-error">Include at least one line item.</div>`; return; }
    const cfg = { number: st.number.trim(), notes: st.notes.trim(), lines };
    if (st.doc === 'invoice') cfg.methods = [...st.accepted];
    else { cfg.payMethod = st.payMethod.trim(); cfg.payReference = st.payReference.trim(); }
    // Open the tab synchronously, WHILE we still hold the user gesture. iOS
    // Safari blocks window.open() once an await has consumed the click, so we
    // grab the blank tab here and only navigate it after the async save below.
    const win = window.open('', '_blank');
    try {
      const repo = st.source === 'sale' ? saleRepo : studServiceRepo;
      const persist = { invoice_number: st.number.trim() || null, invoice_notes: st.notes.trim() || null };
      if (st.doc === 'receipt') { persist.payment_method = st.payMethod.trim() || null; persist.payment_reference = st.payReference.trim() || null; }
      await repo.update(st.record.id, persist);
      // Navigate to the document but don't auto-print — the owner triggers the
      // actual download/print themselves with the page's "Print / Save as PDF"
      // button.
      const url = `invoice.html?source=${encodeURIComponent(st.source)}&id=${encodeURIComponent(st.record.id)}`
        + `&doc=${encodeURIComponent(st.doc)}&cfg=${encodeURIComponent(JSON.stringify(cfg))}`;
      if (win) win.location = url;   // navigate the tab we pre-opened
      else window.location = url;    // popup blocked outright — fall back to this tab
      close();
    } catch (e) {
      if (win) win.close();
      errBox.innerHTML = `<div class="inline-error">${esc(e.message || String(e))}</div>`;
    }
  });
}

// ==========================================================================
// Boot
// ==========================================================================

async function init() {
  renderViewTabs();
  const [dogs, litters, pairings, kennels] = await Promise.all([
    dogRepo.getAll({ includeArchived: true }),
    litterRepo.getAll({ includeArchived: true }),
    pairingRepo.getAll({ includeArchived: true }),
    kennelRepo.getAll({ includeArchived: true })
  ]);
  ref.dogs = dogs; ref.litters = litters; ref.pairings = pairings; ref.kennels = kennels;
  maps.dogsById = new Map(dogs.map((d) => [d.id, d]));
  maps.littersById = new Map(litters.map((l) => [l.id, l]));
  maps.pairingsById = new Map(pairings.map((p) => [p.id, p]));
  maps.kennelsById = new Map(kennels.map((k) => [k.id, k]));

  // The `+ Add Expense` button belongs only to the Expenses view. `.btn` CSS
  // sets display, which beats the HTML `hidden` attribute on specificity, so we
  // force it off here and initExpenses turns it back on.
  const addBtn = document.getElementById('add-expense');
  if (addBtn) addBtn.style.display = 'none';

  // The Invoice / Receipt generator is available from every Financials view —
  // except in Lite, where invoice/receipt generation is Pro-only (hide the button).
  const genBtn = document.getElementById('gen-document');
  if (genBtn && editionFlags.invoicing) genBtn.addEventListener('click', () => openGenerateModal());
  else if (genBtn) genBtn.style.display = 'none';

  if (view === 'income') initIncome();
  else if (view === 'overview') await initOverview();
  else initExpenses();
}

init();
