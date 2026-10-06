// invoiceGenerator.js — the Invoice / Receipt generator modal (End-State guide
// §24): pick a Sale or outgoing StudService, choose Invoice vs Receipt, set each
// line's Full/Partial, already-collected amount and (invoices) due date, then open
// the print-only invoice.html. Opened from Financials and from a Sale's own page
// (preselected). Pro-only (editionFlags.invoicing): both callers import it
// dynamically, and it's in PRO_ONLY_STANDALONE so the Lite build leaves it out.
import { saleRepo } from '../data/saleRepo.js';
import { studServiceRepo } from '../data/studServiceRepo.js';
import { getIncomeRows, incomeLineItems } from '../data/incomeView.js';
import { getInvoiceDefaults, setInvoiceDefaults } from '../data/settings.js';
import { PAYMENT_METHODS, INVOICE_LINE_LABELS } from '../data/vocab.js';
import { esc, fmtDate, fmtMoney } from './ui.js';
import { saleDueDate } from './invoiceDoc.js';

// A source record is any income row (a Sale or an outgoing StudService that
// carries money — exactly what getIncomeRows returns). The modal lets the owner
// pick one, choose Invoice vs Receipt, then per line item choose Full vs Partial
// and enter an "already collected" amount (and, on invoices, a per-line due
// date). Full/Partial + collected drives the money math (see the invoice page);
// the volatile per-line choices ride the URL as a compact `cfg` JSON, while the
// document number/notes/receipt-method persist on the record for next time.
const PAYMENT_METHOD_LIST = PAYMENT_METHODS.map((m) => `<option value="${esc(m)}"></option>`).join('');

// `preselect` = { source: 'sale' | 'stud', id } opens it on that record (the Sale
// page's "Invoice / Receipt" button), with the picker already set.
export async function openInvoiceGenerator({ preselect = null } = {}) {
  const rows = await getIncomeRows({ includeArchived: false });
  // A preselected record that isn't an active income row (archived, or nothing
  // billable yet) still gets its own option so the modal opens on it.
  if (preselect && !rows.some((r) => r.source_type === preselect.source && r.source_id === preselect.id)) {
    const all = await getIncomeRows({ includeArchived: true });
    const hit = all.find((r) => r.source_type === preselect.source && r.source_id === preselect.id);
    if (hit) rows.unshift(hit);
  }
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
    const items = incomeLineItems(row.source_type, record, { feeCredit: row.fee_credit || 0 });
    const soonest = row.source_type === 'sale' ? await saleDueDate(record) : '';
    st.soonest = soonest;
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

  const showErr = (e) => { modal.querySelector('#gen-error').innerHTML = `<div class="inline-error">${esc(e.message || String(e))}</div>`; };
  sourceSel.addEventListener('change', () => { onSourceChange().catch(showErr); });
  if (preselect) {
    sourceSel.value = `${preselect.source}:${preselect.id}`;
    if (sourceSel.value) onSourceChange().catch(showErr);
  }

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
      // A due date she left at the prefill isn't written into the link: the
      // document reads the sale's own date live, so a later edit to the sale
      // (balance due date, pickup) shows on the next view/PDF. Only a date she
      // changed (or cleared) here is carried.
      const line = { key: k, mode: ln.mode === 'partial' ? 'partial' : 'full', collected: num(ln.collected) };
      if ((ln.dueDate || '') !== (st.soonest || '')) line.dueDate = ln.dueDate || '';
      return line;
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
      // actual download/print themselves with the page's "Download PDF" or "Print"
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

