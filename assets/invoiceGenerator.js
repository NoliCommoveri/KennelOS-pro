// invoiceGenerator.js — the Invoice / Receipt generator modal (End-State guide §24,
// Payment Schedule plan §6.1): pick a family (a waitlist entry and the sale it goes
// toward, or a sale no entry claims) or a stud service, choose Invoice or Receipt,
// then open the print-only invoice.html.
//   Invoice: the family's lines (each charge by due date, data/familyMoney.js), the
//     ones still owed ticked; Next payment ticks exactly what's owed by the next due
//     date; a line can bill a typed partial amount.
//   Receipt: the money recorded (the fee, the deposit, each payment, credits used),
//     all ticked; Record a payment adds money first, then it can be receipted.
//   Stud service: its one fee line, Full or Partial with an amount already collected
//     and a due date, as always.
// Opened from Financials, a Sale's page, the waitlist family page and Kels's Pups are
// going home. Pro-only (editionFlags.invoicing): every caller imports it dynamically,
// and it's in PRO_ONLY_STANDALONE so the Lite build leaves it out.
import { saleRepo } from '../data/saleRepo.js';
import { studServiceRepo } from '../data/studServiceRepo.js';
import { waitlistEntryRepo } from '../data/waitlistEntryRepo.js';
import { getIncomeRows, incomeLineItems } from '../data/incomeView.js';
import { listInvoiceFamilies, loadFamilyAccount, resolvePick } from '../data/familyMoney.js';
import { getInvoiceDefaults, setInvoiceDefaults } from '../data/settings.js';
import { editionFlags } from '../data/editionConfig.js';
import { PAYMENT_METHODS, INVOICE_LINE_LABELS } from '../data/vocab.js';
import { esc, fmtDate, fmtMoney } from './ui.js';

const PAYMENT_METHOD_LIST = PAYMENT_METHODS.map((m) => `<option value="${esc(m)}"></option>`).join('');
const money = (v) => fmtMoney(v) || '$0.00';

// `preselect` = { source: 'sale' | 'entry' | 'stud', id } opens it on that record's
// family (or stud service). `pick` (a familyMoney pick) sets what starts ticked.
// `onClose` runs when the modal closes, generated or not (Kels waits on it).
export async function openInvoiceGenerator({ preselect = null, pick = null, onClose = null } = {}) {
  const [families, incomeRows] = await Promise.all([listInvoiceFamilies(), getIncomeRows({ includeArchived: false })]);
  const studs = incomeRows.filter((r) => r.source_type === 'stud');
  // A preselected record opens on its family, listed even if the picker wouldn't
  // list it (archived, or nothing billable yet).
  let preKey = '';
  if (preselect?.source === 'stud') {
    preKey = `stud:${preselect.id}`;
    if (!studs.some((r) => r.source_id === preselect.id)) {
      const hit = (await getIncomeRows({ includeArchived: true })).find((r) => r.source_type === 'stud' && r.source_id === preselect.id);
      if (hit) studs.unshift(hit);
    }
  } else if (preselect) {
    const fam = await loadFamilyAccount(preselect.source === 'entry' ? { entryId: preselect.id } : { saleId: preselect.id });
    if (fam) {
      preKey = fam.entry ? `entry:${fam.entry.id}` : `sale:${fam.sale.id}`;
      if (!families.some((f) => f.key === preKey)) {
        families.unshift({ key: preKey, entryId: fam.entry?.id, saleId: fam.entry ? null : fam.sale.id, label: `${fam.contact?.name || fam.entry?.application?.name || 'Family'}${fam.dog ? ` → ${fam.dog.call_name}` : ''}` });
      }
    }
  }
  const familyByKey = new Map(families.map((f) => [f.key, f]));
  const studByKey = new Map(studs.map((r) => [`stud:${r.source_id}`, r]));
  const any = families.length || studs.length;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="max-width:640px;">
      <div class="row-between" style="margin-bottom:12px;">
        <h2 style="margin:0;">Invoice / Receipt</h2>
        <button class="btn btn-sm" data-act="cancel" aria-label="Close">✕</button>
      </div>
      ${any ? `
      <div class="form-grid">
        <div class="field field-wide"><label>Document</label>
          <div class="pill-row">
            <label class="check-inline"><input type="radio" name="gen-doc" value="invoice" checked> Invoice</label>
            <label class="check-inline"><input type="radio" name="gen-doc" value="receipt"> Receipt</label>
          </div>
        </div>
        <div class="field field-wide"><label for="gen-source">For <span class="req">*</span></label>
          <select id="gen-source">
            <option value="">— select a family or stud service —</option>
            ${families.length ? `<optgroup label="Families">${families.map((f) => `<option value="${esc(f.key)}">${esc(f.label)}</option>`).join('')}</optgroup>` : ''}
            ${studs.length ? `<optgroup label="Stud services">${studs.map((r) => `<option value="stud:${esc(r.source_id)}">${esc(r.dog)} × ${esc(r.counterparty)}${r.date ? ` (${esc(fmtDate(r.date))})` : ''}</option>`).join('')}</optgroup>` : ''}
          </select>
        </div>
      </div>
      <div id="gen-config"></div>
      <div id="gen-error"></div>
      <div class="form-actions">
        <button class="btn btn-primary" data-act="generate" disabled>Generate →</button>
        <button class="btn" data-act="cancel">Cancel</button>
      </div>` : `
      <p class="muted">Nothing to invoice yet. Record a sale, a waitlist family's fee, or a stud service of your stud with a fee first.</p>
      <div class="form-actions"><button class="btn" data-act="cancel">Close</button></div>`}
    </div>`;
  document.body.appendChild(overlay);
  const modal = overlay.querySelector('.modal');

  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); onClose?.(); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  modal.querySelectorAll('[data-act="cancel"]').forEach((b) => b.addEventListener('click', close));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);

  const sourceSel = modal.querySelector('#gen-source');
  const configEl = modal.querySelector('#gen-config');
  const genBtn = modal.querySelector('[data-act="generate"]');
  const errBox = modal.querySelector('#gen-error');
  if (!sourceSel) return;

  // Everything the config holds, so a doc-type toggle re-renders without losing what's typed.
  const st = {
    doc: 'invoice', key: '', fam: null, stud: null,
    lines: new Map(),   // family invoice: ref → { include, partial, amount }
    money: new Map(),   // family receipt: ref → include
    studLines: {}, studOrder: [],
    accepted: new Set(getInvoiceDefaults().acceptedMethods),
    number: '', notes: '', payMethod: '', payReference: ''
  };

  // Tick what a pick covers (the doc's own default when none).
  function applyPick(p) {
    const a = st.fam.account;
    const inv = new Set(resolvePick(a, 'invoice', st.doc === 'invoice' && p ? p : 'owed'));
    st.lines = new Map(a.charges.map((c) => [c.ref, { include: inv.has(c.ref), partial: false, amount: '' }]));
    const rec = new Set(resolvePick(a, 'receipt', st.doc === 'receipt' && p ? p : 'all').map((x) => x.ref));
    st.money = new Map(a.money.map((m) => [m.ref, rec.has(m.ref)]));
  }

  function syncFromDom() {
    configEl.querySelectorAll('.gen-charge').forEach((el) => {
      const ln = st.lines.get(el.dataset.ref);
      if (!ln) return;
      ln.include = el.querySelector('.ln-include').checked;
      ln.partial = el.querySelector('.ln-partial').checked;
      ln.amount = el.querySelector('.ln-amount').value;
    });
    configEl.querySelectorAll('.gen-money').forEach((el) => { st.money.set(el.dataset.ref, el.querySelector('.mn-include').checked); });
    configEl.querySelectorAll('.gen-line').forEach((el) => {
      const ln = st.studLines[el.dataset.key];
      if (!ln) return;
      ln.include = el.querySelector('.ln-include').checked;
      ln.mode = el.querySelector('.ln-mode:checked')?.value || 'full';
      ln.collected = el.querySelector('.ln-collected').value;
      const due = el.querySelector('.ln-due');
      if (due) ln.dueDate = due.value;
    });
    const v = (id) => configEl.querySelector(id)?.value;
    if (v('#gen-num') != null) st.number = v('#gen-num');
    if (v('#gen-notes') != null) st.notes = v('#gen-notes');
    if (v('#gen-pm') != null) st.payMethod = v('#gen-pm');
    if (v('#gen-ref') != null) st.payReference = v('#gen-ref');
    const acc = configEl.querySelectorAll('.acc-method');
    if (acc.length) st.accepted = new Set([...acc].filter((c) => c.checked).map((c) => c.value));
  }

  // --- A family's invoice: its lines, grouped by due date ---
  function familyInvoiceHtml() {
    const a = st.fam.account;
    if (!a.charges.length) return '<p class="faint">Nothing is charged to this family.</p>';
    const groups = [];
    for (const c of a.charges) {
      const head = `${c.dueLabel || 'Due'}${c.dueDate ? ` · ${fmtDate(c.dueDate)}` : c.dueId === 'deposit' ? ' · immediately' : ''}`;
      if (!groups.length || groups[groups.length - 1].head !== head) groups.push({ head, items: [] });
      groups[groups.length - 1].items.push(c);
    }
    const lineHtml = (c) => {
      const ln = st.lines.get(c.ref);
      const status = c.owed > 0 ? `${money(c.owed)} owed${c.owed < c.amount ? ` of ${money(c.amount)}` : ''}` : `${money(c.amount)} · paid`;
      return `<div class="gen-charge" data-ref="${esc(c.ref)}" style="padding:6px 0;">
        <label class="check-inline" style="gap:8px;"><input type="checkbox" class="ln-include"${ln.include ? ' checked' : ''}> <strong>${esc(c.label)}</strong> <span class="faint">${esc(status)}</span></label>
        <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-top:4px; padding-left:24px;">
          <label class="check-inline" style="gap:4px;"><input type="checkbox" class="ln-partial"${ln.partial ? ' checked' : ''}> Bill part of it</label>
          <input type="number" class="ln-amount" min="0" step="0.01" inputmode="decimal" aria-label="Amount to bill" value="${esc(ln.amount)}" style="width:110px;"${ln.partial ? '' : ' hidden'}>
        </div>
      </div>`;
    };
    return `<div class="pill-row" style="margin:6px 0;">
        ${a.next ? `<button class="btn btn-sm" type="button" data-pick="next">Next payment (${esc(money(a.next.owed))})</button>` : ''}
        <button class="btn btn-sm" type="button" data-pick="owed">Everything owed</button>
        <button class="btn btn-sm" type="button" data-pick="none">Clear</button>
      </div>
      ${groups.map((g) => `<div style="border-top:1px solid var(--border); padding-top:6px; margin-top:6px;">
        <div class="muted" style="font-size:12px; font-weight:600;">${esc(g.head)}</div>${g.items.map(lineHtml).join('')}</div>`).join('')}
      <p class="field-hint">Each line bills what's still owed on it, after what's been paid and credited. Due dates come from the sale's payment schedule.</p>`;
  }

  // --- A family's receipt: the money recorded ---
  function familyReceiptHtml() {
    const a = st.fam.account;
    const canRecord = st.fam.sale && st.fam.loaded && !st.fam.loaded.statement.ended;
    const items = a.money.map((m) => `<div class="gen-money" data-ref="${esc(m.ref)}" style="border-top:1px solid var(--border); padding:6px 0;">
        <label class="check-inline" style="gap:8px; align-items:flex-start;"><input type="checkbox" class="mn-include"${st.money.get(m.ref) ? ' checked' : ''}>
          <span><strong>${esc(money(m.amount))}</strong> ${m.date ? esc(fmtDate(m.date)) : '<span class="faint">no date</span>'}${m.method ? ` · ${esc(m.method)}` : ''}
          <br><span class="faint">${esc(m.pays.map((p) => `${p.label} ${money(p.amount)}`).join(', '))}</span></span></label>
      </div>`).join('');
    return `${items || '<p class="faint">No money recorded for this family yet.</p>'}
      ${canRecord ? '<div class="pill-row" style="margin-top:6px;"><button class="btn btn-sm" type="button" data-act="record">Record a payment</button></div>' : ''}
      <p class="field-hint">A receipt shows only money recorded. Credits print as what they covered, marked "(credited)".</p>`;
  }

  // --- A stud service: its fee line, Full or Partial (as always) ---
  function studLineHtml(key) {
    const ln = st.studLines[key];
    const label = ln.label || INVOICE_LINE_LABELS[key] || key;
    const dueField = st.doc !== 'invoice' ? '' : `<label class="check-inline" style="gap:4px;">Due by <input type="date" class="ln-due" value="${esc(ln.dueDate || '')}"></label>`;
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
    const hint = st.fam ? '<span class="faint">(for a deposit or paid-in-full without one)</span>' : '';
    return `<div class="field"><label for="gen-pm">Payment method used ${hint}</label>
        <input id="gen-pm" type="text" list="gen-pm-list" value="${esc(st.payMethod)}" placeholder="e.g. Check, Venmo…">
        <datalist id="gen-pm-list">${PAYMENT_METHOD_LIST}</datalist>
      </div>
      <div class="field"><label for="gen-ref">Reference</label>
        <input id="gen-ref" type="text" value="${esc(st.payReference)}" placeholder="Check #, transaction id…">
      </div>`;
  }

  function renderConfig() {
    if (!st.fam && !st.stud) { configEl.innerHTML = ''; genBtn.disabled = true; return; }
    const body = st.fam
      ? (st.doc === 'invoice' ? familyInvoiceHtml() : familyReceiptHtml())
      : `<p class="field-hint" style="margin:2px 0 4px;">${st.doc === 'invoice'
        ? 'Full bills the whole amount and subtracts anything already collected; Partial bills only the amount you enter and prints "(partial)".'
        : 'Full receipts the remaining amount (line total minus anything already collected); Partial receipts only the amount you enter and prints "(partial)".'}</p>
        ${st.studOrder.map(studLineHtml).join('') || '<p class="faint">No billable amounts on this record.</p>'}`;
    const a = st.fam?.account;
    configEl.innerHTML = `
      <div style="margin-top:12px; border-top:1px solid var(--border); padding-top:10px;">
        <label style="font-weight:600;">${st.doc === 'invoice' ? 'Lines' : 'Money received'}</label>
        ${body}
        ${a ? `<p class="muted" style="font-size:13px; margin:6px 0 0;">Account: ${esc(money(a.total))} in all · ${esc(money(a.paid))} paid · ${esc(money(a.owed))} still owed.</p>` : ''}
      </div>
      <div class="form-grid" style="margin-top:12px;">
        ${paymentSectionHtml()}
        <div class="field"><label for="gen-num">Document #</label>
          <input id="gen-num" type="text" value="${esc(st.number)}" placeholder="Auto (${st.doc === 'receipt' ? 'RCT' : 'INV'}-…)">
        </div>
        <div class="field field-wide"><label for="gen-notes">Notes on document</label>
          <textarea id="gen-notes" placeholder="Optional message shown on the ${st.doc}">${esc(st.notes)}</textarea>
        </div>
      </div>`;
    genBtn.disabled = false;

    configEl.querySelector('[data-act="save-default"]')?.addEventListener('click', () => {
      syncFromDom();
      setInvoiceDefaults({ acceptedMethods: [...st.accepted] });
      const note = configEl.querySelector('#gen-default-saved');
      if (note) note.textContent = 'Saved as default.';
    });
    configEl.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
      syncFromDom();
      const p = b.dataset.pick;
      const on = new Set(p === 'none' ? [] : resolvePick(st.fam.account, 'invoice', p));
      for (const [ref, ln] of st.lines) ln.include = on.has(ref);
      renderConfig();
    }));
    configEl.querySelectorAll('.ln-partial').forEach((cb) => cb.addEventListener('change', () => {
      const input = cb.closest('.gen-charge').querySelector('.ln-amount');
      input.hidden = !cb.checked;
      if (cb.checked) input.focus();
    }));
    configEl.querySelector('[data-act="record"]')?.addEventListener('click', async () => {
      syncFromDom();
      try {
        const [{ openPaymentDialog }, { accountRepo }] = await Promise.all([import('./paymentScheduleUI.js'), import('../data/accountRepo.js')]);
        const accounts = editionFlags.accounts ? (await accountRepo.getAll({ includeArchived: true })).filter((a) => a.account_type === 'payment_service') : [];
        const had = new Set(st.fam.account.money.map((m) => m.ref));
        if (!(await openPaymentDialog({ loaded: st.fam.loaded, accounts }))) return;
        await loadFamily(st.key, { keep: true });
        // The money just recorded starts ticked.
        for (const m of st.fam.account.money) if (!had.has(m.ref)) st.money.set(m.ref, true);
        renderConfig();
      } catch (e) { showErr(e); }
    });
  }

  async function loadFamily(key, { keep = false, initialPick = null } = {}) {
    const f = familyByKey.get(key);
    const before = keep ? { lines: st.lines, money: st.money } : null;
    st.fam = await loadFamilyAccount(f.entryId ? { entryId: f.entryId } : { saleId: f.saleId });
    if (!st.fam) throw new Error('That family\'s records are gone.');
    applyPick(initialPick);
    if (before) {
      for (const [ref, ln] of before.lines) if (st.lines.has(ref)) st.lines.set(ref, ln);
      for (const [ref, on] of before.money) if (st.money.has(ref)) st.money.set(ref, on);
    }
    if (!keep) {
      const rec = st.fam.sale || st.fam.entry;
      st.number = rec.invoice_number || '';
      st.notes = rec.invoice_notes || '';
      st.payMethod = st.fam.sale?.payment_method || '';
      st.payReference = st.fam.sale?.payment_reference || '';
    }
  }

  async function loadStud(key) {
    const row = studByKey.get(key);
    const record = await studServiceRepo.getById(row.source_id);
    const items = incomeLineItems('stud', record);
    st.stud = record;
    st.studOrder = items.map((it) => it.key);
    st.studLines = Object.fromEntries(items.map((it) => [it.key, { base: it.amount, label: it.invoiceLabel, include: true, mode: 'full', collected: '', dueDate: '' }]));
    st.number = record.invoice_number || '';
    st.notes = record.invoice_notes || '';
    st.payMethod = record.payment_method || '';
    st.payReference = record.payment_reference || '';
  }

  async function onSourceChange(initialPick = null) {
    errBox.innerHTML = '';
    st.key = sourceSel.value;
    st.fam = null;
    st.stud = null;
    if (st.key.startsWith('stud:')) await loadStud(st.key);
    else if (st.key) await loadFamily(st.key, { initialPick });
    renderConfig();
  }

  function showErr(e) { errBox.innerHTML = `<div class="inline-error">${esc(e.message || String(e))}</div>`; }
  sourceSel.addEventListener('change', () => { onSourceChange().catch(showErr); });
  if (preKey) {
    sourceSel.value = preKey;
    if (pick?.startsWith?.('receipt:')) {
      st.doc = 'receipt';
      modal.querySelector('input[name="gen-doc"][value="receipt"]').checked = true;
    }
    if (sourceSel.value) onSourceChange(pick ? pick.replace(/^(invoice|receipt):/, '') : null).catch(showErr);
  }

  // Doc-type toggle re-renders the config without losing what's typed.
  modal.querySelectorAll('input[name="gen-doc"]').forEach((r) => r.addEventListener('change', (e) => {
    if (!e.target.checked) return;
    syncFromDom();
    st.doc = e.target.value;
    renderConfig();
  }));

  genBtn.addEventListener('click', async () => {
    errBox.innerHTML = '';
    if (!st.fam && !st.stud) return;
    syncFromDom();
    const pos = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
    let cfg;
    let url;
    if (st.fam) {
      cfg = { v: 2, number: st.number.trim(), notes: st.notes.trim() };
      if (st.doc === 'invoice') {
        cfg.lines = [];
        for (const [ref, ln] of st.lines) {
          if (!ln.include) continue;
          if (ln.partial && !pos(ln.amount)) { showErr(new Error('Enter the part to bill, or untick "Bill part of it".')); return; }
          cfg.lines.push(ln.partial ? { ref, amount: pos(ln.amount) } : { ref });
        }
        if (!cfg.lines.length) { showErr(new Error('Tick at least one line.')); return; }
        cfg.methods = [...st.accepted];
      } else {
        cfg.money = [...st.money].filter(([, on]) => on).map(([ref]) => ({ ref }));
        if (!cfg.money.length) { showErr(new Error('Tick the money this receipt is for.')); return; }
        cfg.payMethod = st.payMethod.trim();
        cfg.payReference = st.payReference.trim();
      }
      const who = st.fam.entry ? `entry=${encodeURIComponent(st.fam.entry.id)}` : `sale=${encodeURIComponent(st.fam.sale.id)}`;
      url = `invoice.html?source=family&${who}&doc=${encodeURIComponent(st.doc)}&cfg=${encodeURIComponent(JSON.stringify(cfg))}`;
    } else {
      const lines = st.studOrder.filter((k) => st.studLines[k].include).map((k) => {
        const ln = st.studLines[k];
        return { key: k, mode: ln.mode === 'partial' ? 'partial' : 'full', collected: pos(ln.collected), ...(ln.dueDate ? { dueDate: ln.dueDate } : {}) };
      });
      if (!lines.length) { showErr(new Error('Include at least one line item.')); return; }
      cfg = { number: st.number.trim(), notes: st.notes.trim(), lines };
      if (st.doc === 'invoice') cfg.methods = [...st.accepted];
      else { cfg.payMethod = st.payMethod.trim(); cfg.payReference = st.payReference.trim(); }
      url = `invoice.html?source=stud&id=${encodeURIComponent(st.stud.id)}&doc=${encodeURIComponent(st.doc)}&cfg=${encodeURIComponent(JSON.stringify(cfg))}`;
    }
    // Open the tab synchronously, WHILE we still hold the user gesture. iOS Safari
    // blocks window.open() once an await has consumed the click, so we grab the blank
    // tab here and only navigate it after the async save below.
    const win = window.open('', '_blank');
    try {
      // The number and notes are kept for next time: on the sale, else the waitlist
      // entry (D14); a receipt's method and reference on the sale or stud service.
      const persist = { invoice_number: st.number.trim() || null, invoice_notes: st.notes.trim() || null };
      const withPay = st.doc === 'receipt' ? { payment_method: st.payMethod.trim() || null, payment_reference: st.payReference.trim() || null } : {};
      if (st.stud) await studServiceRepo.update(st.stud.id, { ...persist, ...withPay });
      else if (st.fam.sale) await saleRepo.update(st.fam.sale.id, { ...persist, ...withPay });
      else await waitlistEntryRepo.update(st.fam.entry.id, persist);
      if (win) win.location = url;
      else window.location = url;
      close();
    } catch (e) {
      if (win) win.close();
      showErr(e);
    }
  });
}
