// paymentScheduleUI.js — a sale's payments, on the Sale page and a family's waitlist
// page (Payment Schedule plan §5): the card (the deposit, each due date with what it
// asks and what's owed, extras on their own dates, the money received), the schedule
// editor, Record a payment, and the question asked whenever a fee is added. All
// editions. Every figure comes from incomeView.getSaleStatement →
// paymentSchedule.paymentStatement; nothing here adds money up itself.
//
//   paymentsCardHtml(loaded, { accountsById, finalMethods, editable })   the card
//   wirePaymentsCard(root, { loaded, accounts, savedList, onChanged })    its buttons
//   openScheduleEditor({ loaded, savedList })        → true once saved
//   openPaymentDialog({ loaded, accounts, payment }) → true once saved
//   askAboutNewFees({ before, after, savedList })    after a save that added fees
//   stepsEditorHtml / wireStepsEditor / readStepsEditor   the due-date rows, also used
//                                                          for the Kennel page's saved schedules
import { saleRepo } from '../data/saleRepo.js';
import { getSaleStatement } from '../data/incomeView.js';
import {
  paymentStatement, saleCharges, cleanSchedule, defaultSchedule, readSchedule, scheduleFromSaved, newPayment, paymentsWith,
  addedFees, paidInFullOffer, finalDueDate, scheduleSummary, coversText
} from '../data/paymentSchedule.js';
import { SCHEDULE_DUE, SCHEDULE_COVERS, PAYMENT_METHODS, RELEASED_SALE_STATUSES } from '../data/vocab.js';
import { esc, fmtDate, fmtMoney, todayYMD, confirmModal } from './ui.js';

const STATUS_BADGE = {
  met: ['badge-green', 'Paid'],
  due_soon: ['badge-amber', 'Due soon'],
  upcoming: ['badge-gray', 'Coming up'],
  not_received: ['badge-red', 'Not received'],
  no_date: ['badge-gray', 'Date not known yet']
};
const statusBadge = (status) => {
  const [cls, label] = STATUS_BADGE[status] || STATUS_BADGE.upcoming;
  return `<span class="badge ${cls}">${esc(label)}</span>`;
};
const money = (n) => fmtMoney(n);
const words = { money, date: fmtDate };

// --- A modal with a form (the app's chrome; ui.js's dialogs are message-only) --------

function formDialog({ title, bodyHtml, confirmLabel = 'Save', cancelLabel = 'Cancel', onConfirm }, onOpen = null) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
        <h2 style="margin-top:0;">${esc(title)}</h2>
        <div data-pd-error></div>
        ${bodyHtml}
        <div class="form-actions">
          <button class="btn btn-primary" data-pd-confirm>${esc(confirmLabel)}</button>
          <button class="btn" data-pd-cancel>${esc(cancelLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const done = (val) => { overlay.remove(); resolve(val); };
    if (onOpen) onOpen(overlay, done);
    const confirmBtn = overlay.querySelector('[data-pd-confirm]');
    confirmBtn.addEventListener('click', async () => {
      if (confirmBtn.disabled) return;
      confirmBtn.disabled = true;
      try {
        await onConfirm(overlay);
        done(true);
      } catch (e) {
        overlay.querySelector('[data-pd-error]').innerHTML = `<div class="inline-error">${esc(e.message || String(e))}</div>`;
        confirmBtn.disabled = false;
      }
    });
    overlay.querySelector('[data-pd-cancel]').addEventListener('click', () => done(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
  });
}

// --- Words for a due date ---------------------------------------------------------------

// When it's due, as she set it: "at 8 weeks", "3 days before pickup", "at pickup", "Dec 4".
function whenText(step) {
  if (step.due === 'at_weeks') return `at ${step.n} week${step.n === 1 ? '' : 's'}`;
  if (step.due === 'before_pickup') return `${step.n} day${step.n === 1 ? '' : 's'} before pickup`;
  if (step.due === 'at_pickup') return 'at pickup';
  return 'on a date';
}

// What it asks for, as she set it: "50% of purchase price", "$600, new payments only".
function askText(step, charges, isFinal) {
  if (isFinal) return 'Everything left';
  const what = coversText(step.covers, charges);
  if (step.percent != null) return step.basis === 'remaining' ? `${step.percent}% of what's left of ${what}, new payments only` : `${step.percent}% of ${what}, counting what's paid`;
  return `${money(step.amount)} toward ${what}${step.prior_funds === 'dont_count' ? ', new payments only' : ''}`;
}

const dateText = (date, step) => (date ? fmtDate(date) : step?.due === 'at_pickup' ? 'At pickup (no date yet)' : 'Date not known yet');

// What a piece of money received was: "Payment (Zelle)", "Credit", "Deposit".
const RECEIVED_LABEL = { fee: 'Application fee credited', credit: 'Credit', deposit: 'Deposit', step: 'Marked paid', payment: 'Payment', paid_in_full: 'Marked paid in full' };

// --- The card ------------------------------------------------------------------------------

// `loaded`: incomeView.getSaleStatement's result. `editable`: false on an ended sale or
// a read-only page. `finalMethods`: her text for the final payment (Kennel).
export function paymentsCardHtml(loaded, { accountsById = new Map(), finalMethods = '', editable = true } = {}) {
  const st = loaded.statement;
  const sale = loaded.sale;
  const canEdit = editable && !st.ended;
  const head = `<div class="row-between" style="flex-wrap:wrap; gap:8px;">
      <h2 style="margin:0;">Payments</h2>
      ${canEdit ? `<div class="pill-row">
        <button class="btn btn-sm btn-primary" data-ps="record">Record a payment</button>
        <button class="btn btn-sm" data-ps="schedule">${st.hasSchedule ? 'Edit the schedule' : 'Add a payment schedule'}</button>
      </div>` : ''}
    </div>`;
  const totals = `<p style="margin:8px 0;">Total <strong>${esc(money(st.total))}</strong> · paid <strong>${esc(money(st.paid))}</strong>${st.ended ? '' : ` · still owed <strong>${esc(money(st.remaining))}</strong>`}</p>`;
  if (st.ended) {
    return `${head}${totals}<p class="muted" style="margin:0 0 8px;">This sale has ended: what was paid stands, and nothing more is owed on it.</p>${receivedHtml(st, { accountsById, canEdit: false })}`;
  }
  // Everything paid but the sale not marked (D34, whichever way the money came in:
  // recorded here, an invoice, a Stripe link): the button that marks it (D22).
  const offer = canEdit ? paidInFullOffer(st, sale) : null;
  const next = st.next ? `<p style="margin:0 0 8px;">Next: <strong>${esc(money(st.next.owed))}</strong> ${st.next.date ? `by ${esc(fmtDate(st.next.date))}` : esc(st.next.label === 'Deposit' ? 'for the deposit' : '(date not known yet)')}${st.next.kind === 'own' ? ` <span class="faint">for ${esc(st.next.label)}</span>` : ''}</p>`
    : (st.total > 0 ? `<p style="margin:0 0 8px;"><span class="badge badge-green">Everything is paid</span>${offer ? ` <button class="btn btn-sm btn-primary" data-ps="paid-in-full">Mark paid in full</button>` : ''}</p>` : '');
  const line = (title, sub, owedHtml, badgeHtml) => `<li class="row-between" style="padding:8px 0; border-top:1px solid var(--border); align-items:flex-start; gap:8px; flex-wrap:nowrap;">
      <div style="flex:1 1 auto; min-width:0;"><strong>${esc(title)}</strong><div class="faint" style="font-size:13px;">${sub}</div></div>
      <div style="flex:0 0 auto; text-align:right; white-space:nowrap;">${owedHtml}<div>${badgeHtml}</div></div>
    </li>`;
  const rows = [];
  if (st.deposit) {
    rows.push(line('Deposit', `${esc(money(st.deposit.amount))}${st.deposit.date ? ` · ${st.deposit.owed > 0 ? 'due' : 'paid'} ${esc(fmtDate(st.deposit.date))}` : ''}`,
      st.deposit.owed > 0 ? `${esc(money(st.deposit.owed))} owed` : '', statusBadge(st.deposit.status)));
  }
  for (const d of st.dueDates) {
    const sub = `${esc(askText(d.step, st.charges, d.isFinal))} · ${esc(dateText(d.date, d.step))}${d.date && d.step.due !== 'on_date' ? ` <span class="faint">(${esc(whenText(d.step))})</span>` : ''}
      <br>Asks ${esc(money(d.ask))}${d.threshold > 0 && !d.isFinal ? ` · ${esc(money(d.threshold))} paid in all by then` : ''}`;
    rows.push(line(d.label, sub, d.owed > 0 ? `${esc(money(d.owed))} owed` : '', statusBadge(d.status)));
  }
  const own = st.ownDated.length ? `<h3 style="margin:14px 0 2px; font-size:1em;">Paid on their own dates</h3>
      <ul style="margin:0; padding:0; list-style:none;">${st.ownDated.map((o) => line(o.label, `${esc(money(o.amount))} · ${esc(dateText(o.date))}`, o.owed > 0 ? `${esc(money(o.owed))} owed` : '', statusBadge(o.status))).join('')}</ul>` : '';
  const methods = finalMethods ? `<p class="field-hint" style="margin:8px 0 0;">Final payment: ${esc(finalMethods)}</p>` : '';
  const scheduleNote = st.hasSchedule ? '' : '<p class="field-hint" style="margin:8px 0 0;">No payment schedule: everything after the deposit is due once. Add a schedule for more than one due date.</p>';
  return `${head}${totals}${next}
    <ul style="margin:0; padding:0; list-style:none;">${rows.join('')}</ul>
    ${own}${methods}${scheduleNote}
    ${receivedHtml(st, { accountsById, canEdit })}`;
}

// The money received: every payment she recorded (editable), and the credits, fee,
// deposit and paid marks the statement counted, each with what it paid toward.
function receivedHtml(st, { accountsById, canEdit }) {
  if (!st.received.length) return '<p class="muted" style="margin:12px 0 0;">No money received yet.</p>';
  const items = [...st.received].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  return `<h3 style="margin:14px 0 2px; font-size:1em;">Money received</h3>
    <ul style="margin:0; padding:0; list-style:none;">${items.map((r) => {
      const via = [r.method, r.account_id ? accountsById.get(r.account_id)?.name : ''].filter(Boolean).join(' · ');
      const toward = r.pays.length ? r.pays.map((p) => `${esc(p.label)} ${esc(money(p.amount))}`).join(', ') : 'nothing yet';
      const extra = r.unapplied > 0 ? ` <span class="badge badge-amber">${esc(money(r.unapplied))} more than is owed</span>` : '';
      const buttons = canEdit && r.kind === 'payment'
        ? `<div class="pill-row"><button class="btn btn-sm" data-ps-edit="${esc(r.id)}">Edit</button><button class="btn btn-sm" data-ps-remove="${esc(r.id)}">Remove</button></div>` : '';
      return `<li class="row-between" style="padding:8px 0; border-top:1px solid var(--border); align-items:flex-start; gap:8px;">
        <div><strong>${esc(money(r.amount + r.unapplied))}</strong> ${esc(RECEIVED_LABEL[r.kind] || r.kind)}${r.date ? ` · ${esc(fmtDate(r.date))}` : ''}${via ? ` <span class="faint">${esc(via)}</span>` : ''}${extra}
          <div class="faint" style="font-size:13px;">Toward: ${toward}</div></div>
        ${buttons}
      </li>`;
    }).join('')}</ul>`;
}

// Wire the card's buttons. `onChanged()` reloads and redraws the page after a save.
export function wirePaymentsCard(root, { loaded, accounts = [], savedList = [], onChanged }) {
  const fail = (err) => { root.insertAdjacentHTML('afterbegin', `<div class="inline-error">${esc(err.message || String(err))}</div>`); };
  root.querySelector('[data-ps="record"]')?.addEventListener('click', () => openPaymentDialog({ loaded, accounts }).then((ok) => ok && onChanged()).catch(fail));
  root.querySelector('[data-ps="schedule"]')?.addEventListener('click', () => openScheduleEditor({ loaded, savedList }).then((ok) => ok && onChanged()).catch(fail));
  root.querySelector('[data-ps="paid-in-full"]')?.addEventListener('click', () => offerPaidInFull(loaded.sale).then((ok) => ok && onChanged()).catch(fail));
  root.querySelectorAll('[data-ps-edit]').forEach((b) => b.addEventListener('click', () => {
    const payment = (loaded.sale.payments || []).find((p) => p.id === b.dataset.psEdit);
    if (payment) openPaymentDialog({ loaded, accounts, payment }).then((ok) => ok && onChanged()).catch(fail);
  }));
  root.querySelectorAll('[data-ps-remove]').forEach((b) => b.addEventListener('click', () => removePayment(loaded, b.dataset.psRemove).then((ok) => ok && onChanged()).catch(fail)));
}

// --- Due-date rows (the sale's editor and the Kennel page's saved schedules) -------------

const KINDS = [
  { value: 'pct_total', label: '% of the total, counting what\'s paid' },
  { value: 'pct_remaining', label: '% of what\'s left, new payments only' },
  { value: 'amt_count', label: '$ amount, earlier money counts' },
  { value: 'amt_fresh', label: '$ amount, new payments only' }
];
const kindOf = (st) => (st.amount != null && st.percent == null
  ? (st.prior_funds === 'dont_count' ? 'amt_fresh' : 'amt_count')
  : (st.basis === 'remaining' ? 'pct_remaining' : 'pct_total'));

// The cover choices: price always; boarding, transport and extras when the sale has
// them (all of them for a saved schedule); each extra on the schedule by name.
function coverChoices(charges, saved) {
  const has = (c) => saved || charges.some((x) => x.part === 'schedule' && x.covers === c);
  const base = SCHEDULE_COVERS.filter((c) => c.value === 'price' || has(c.value)).map((c) => ({ value: c.value, label: c.label }));
  const extras = saved ? [] : charges.filter((x) => x.part === 'schedule' && x.extraId).map((x) => ({ value: `extra:${x.extraId}`, label: x.label }));
  return [...base, ...extras];
}

function rowHtml(st, i, { final, choices, saved }) {
  const step = { due: 'at_pickup', covers: ['price'], percent: 50, basis: 'total', ...st };
  const dueOpts = SCHEDULE_DUE.filter((d) => !(saved && d.value === 'on_date'))
    .map((d) => `<option value="${esc(d.value)}"${d.value === step.due ? ' selected' : ''}>${esc(d.label)}</option>`).join('');
  const all = step.covers.includes('all');
  const covers = final ? '<span class="faint">Everything left on the sale</span>'
    : `<label class="check-inline" style="margin-right:10px;"><input type="checkbox" class="ps-cover" value="all"${all ? ' checked' : ''}> Everything</label>`
      + choices.map((c) => `<label class="check-inline" style="margin-right:10px;"><input type="checkbox" class="ps-cover" value="${esc(c.value)}"${!all && step.covers.includes(c.value) ? ' checked' : ''}${all ? ' disabled' : ''}> ${esc(c.label)}</label>`).join('');
  const kind = kindOf(step);
  const value = step.amount != null && step.percent == null ? step.amount : step.percent;
  return `<div class="ps-row" data-id="${esc(step.id || '')}"${final ? ' data-final="1"' : ''} style="border-top:1px solid var(--border); padding:10px 0;">
      <div class="row-between"><strong class="ps-title">${final ? 'Final payment' : `Payment ${i + 1}`}</strong>${final ? '' : '<button type="button" class="btn btn-sm" data-ps-row="remove" aria-label="Remove this due date">✕</button>'}</div>
      <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:6px 0;">
        <select class="ps-due" aria-label="When it's due" style="width:auto;">${dueOpts}</select>
        <span class="ps-n-wrap" style="display:inline-flex; gap:4px; align-items:center;"><input class="ps-n" type="number" min="0" step="1" inputmode="numeric" value="${esc(step.n ?? '')}" aria-label="How many" style="width:5em;"> <span class="ps-unit faint"></span></span>
        <input class="ps-date" type="date" value="${esc(step.due_date || '')}" aria-label="Date" style="width:auto;">
      </div>
      <div style="margin:4px 0;">${covers}</div>
      ${final ? '' : `<div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:6px 0;">
        <select class="ps-kind" aria-label="How much" style="width:auto;">${KINDS.map((k) => `<option value="${k.value}"${k.value === kind ? ' selected' : ''}>${esc(k.label)}</option>`).join('')}</select>
        <input class="ps-value" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(value ?? '')}" aria-label="Percent or amount" style="width:7em;">
      </div>`}
      <div class="ps-preview field-hint"></div>
    </div>`;
}

// The rows' HTML. `steps`: cleaned steps (the last is the final payment).
export function stepsEditorHtml(steps, { charges = [], saved = false } = {}) {
  const list = steps && steps.length ? steps : [{ id: 'final', due: 'at_pickup', covers: ['all'], percent: 100, basis: 'total' }];
  const choices = coverChoices(charges, saved);
  return `<div class="ps-rows">${list.map((st, i) => rowHtml(st, i, { final: i === list.length - 1, choices, saved })).join('')}</div>
    <button type="button" class="btn btn-sm" data-ps-row="add">+ Add a due date</button>`;
}

// What the rows say now, as steps (not yet checked: scheduleProblem does that).
export function readStepsEditor(root) {
  return [...root.querySelectorAll('.ps-row')].map((row) => {
    const final = row.dataset.final === '1';
    const due = row.querySelector('.ps-due').value;
    const step = { id: row.dataset.id || '', due };
    if (SCHEDULE_DUE.find((d) => d.value === due)?.needsN) step.n = row.querySelector('.ps-n').value;
    if (due === 'on_date') step.due_date = row.querySelector('.ps-date').value;
    if (final) return { ...step, covers: ['all'], percent: 100, basis: 'total' };
    const ticked = [...row.querySelectorAll('.ps-cover:checked')].map((c) => c.value);
    step.covers = ticked.includes('all') ? ['all'] : ticked;
    const kind = row.querySelector('.ps-kind').value;
    const v = row.querySelector('.ps-value').value;
    if (kind.startsWith('pct')) Object.assign(step, { percent: v, basis: kind === 'pct_remaining' ? 'remaining' : 'total' });
    else Object.assign(step, { amount: v, prior_funds: kind === 'amt_fresh' ? 'dont_count' : 'count' });
    return step;
  });
}

// Wire adding/removing rows and showing each row's own fields, once per container
// (its listeners are delegated, so the rows can be redrawn). `onChange()` runs
// whenever anything changes (the sale's editor redraws its previews). → refresh(),
// to call after redrawing the rows.
export function wireStepsEditor(root, { charges = [], saved = false, onChange = () => {} } = {}) {
  const sync = () => {
    root.querySelectorAll('.ps-row').forEach((row, i, all) => {
      const due = SCHEDULE_DUE.find((d) => d.value === row.querySelector('.ps-due').value);
      row.querySelector('.ps-n-wrap').style.display = due?.needsN ? 'inline-flex' : 'none';
      row.querySelector('.ps-unit').textContent = due?.unit || '';
      row.querySelector('.ps-date').style.display = due?.value === 'on_date' ? '' : 'none';
      if (row.dataset.final !== '1') row.querySelector('.ps-title').textContent = `Payment ${i + 1}`;
      const kind = row.querySelector('.ps-kind');
      if (kind) row.querySelector('.ps-value').setAttribute('aria-label', kind.value.startsWith('pct') ? 'Percent' : 'Amount');
      if (row.dataset.final === '1' && i !== all.length - 1) row.parentElement.appendChild(row);
    });
    onChange();
  };
  root.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-ps-row]');
    if (!btn || !root.contains(btn)) return;
    if (btn.dataset.psRow === 'remove') btn.closest('.ps-row').remove();
    if (btn.dataset.psRow === 'add') {
      const rows = root.querySelector('.ps-rows');
      const final = rows.querySelector('.ps-row[data-final="1"]');
      const count = rows.querySelectorAll('.ps-row').length;
      final.insertAdjacentHTML('beforebegin', rowHtml({ due: 'at_weeks', n: 8, covers: ['price'], percent: 50, basis: 'total' }, count - 1, { final: false, choices: coverChoices(charges, saved), saved }));
    }
    sync();
  });
  root.addEventListener('change', (ev) => {
    if (ev.target.matches('.ps-cover[value="all"]')) {
      ev.target.closest('.ps-row').querySelectorAll('.ps-cover:not([value="all"])').forEach((c) => { c.disabled = ev.target.checked; if (ev.target.checked) c.checked = false; });
    }
    sync();
  });
  root.addEventListener('input', () => onChange());
  sync();
  return sync;
}

// --- The sale's schedule editor ---------------------------------------------------------------

// Each row's preview from the statement the draft schedule gives: what it asks, what
// it's due, the date. A draft that doesn't make sense yet previews nothing.
function previewRows(root, loaded) {
  const rows = readStepsEditor(root);
  const ids = rows.map((r, i) => r.id || `draft${i}`);
  const draft = cleanSchedule(rows.map((r, i) => ({ ...r, id: ids[i] })));
  const st = draft ? paymentStatement({ ...loaded.sale, payment_schedule: draft }, loaded.opts) : null;
  root.querySelectorAll('.ps-row').forEach((el, i) => {
    const d = st?.dueDates.find((x) => x.id === ids[i]);
    el.querySelector('.ps-preview').textContent = d
      ? `${dateText(d.date, d.step)} · asks ${money(d.ask)}${d.owed > 0 ? ` · ${money(d.owed)} still owed` : ' · already paid'}`
      : 'Finish this row to see its amount and date.';
  });
}

export function openScheduleEditor({ loaded, savedList = [] }) {
  const sale = loaded.sale;
  const current = cleanSchedule(sale.payment_schedule);
  // The charges as they'll be once a schedule is stored: an extra with its own steps
  // joins the schedule then (unless it's flagged its own dates), so it can be ticked.
  const charges = current ? loaded.statement.charges : saleCharges({ ...sale, payment_schedule: defaultSchedule(sale) });
  const savedPick = savedList.length ? `<div class="field"><label for="ps-saved">Start from a saved schedule</label>
      <select id="ps-saved"><option value="">Choose…</option>${savedList.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></div>` : '';
  return formDialog({
    title: current ? 'Payment schedule' : 'Add a payment schedule',
    confirmLabel: 'Save the schedule',
    bodyHtml: `<p class="field-hint" style="margin-top:0;">Each due date asks for part of what the family owes. The deposit is asked for on its own, first. The final payment is everything left. Dates by age or pickup follow the pup until you choose a date.</p>
      ${savedPick}
      <div id="ps-editor">${stepsEditorHtml(current || defaultSchedule(sale), { charges })}</div>
      ${current ? '<div style="margin-top:12px;"><button type="button" class="btn btn-sm btn-danger" data-ps="clear">Remove the schedule</button> <span class="field-hint">Everything after the deposit is due once again, on the final payment\'s date.</span></div>' : ''}`,
    onConfirm: async (o) => {
      const { schedule, error } = readSchedule(readStepsEditor(o.querySelector('#ps-editor')));
      if (error) throw new Error(error);
      const preview = paymentStatement({ ...sale, payment_schedule: schedule }, loaded.opts);
      const finalDate = finalDueDate(preview);
      // balance_due_date mirrors the final payment's date for the screens that read it.
      await saleRepo.update(sale.id, { payment_schedule: schedule, balance_due_date: finalDate || null });
    }
  }, (o, done) => {
    const box = o.querySelector('#ps-editor');
    const refresh = wireStepsEditor(box, { charges, onChange: () => previewRows(box, loaded) });
    o.querySelector('#ps-saved')?.addEventListener('change', (ev) => {
      const saved = savedList.find((x) => x.id === ev.target.value);
      if (!saved) return;
      box.innerHTML = stepsEditorHtml(scheduleFromSaved(saved), { charges });
      refresh();
    });
    o.querySelector('[data-ps="clear"]')?.addEventListener('click', async () => {
      if (!(await confirmModal({ title: 'Remove the payment schedule?', message: `Everything after the deposit will be due once${sale.balance_due_date ? `, on ${fmtDate(sale.balance_due_date)}` : ', at pickup'}. Payments already recorded stay.`, confirmLabel: 'Remove it', danger: true }))) return;
      await saleRepo.update(sale.id, { payment_schedule: null });
      done(true);
    });
  });
}

// --- Record a payment ---------------------------------------------------------------------------

// What a payment can go toward: the schedule, or one extra on its own dates (a step,
// or the whole extra when it has no steps) still owed.
function towardChoices(st, current = '') {
  const own = st.ownDated.filter((o) => o.owed > 0 || o.key === current);
  return [{ value: '', label: 'The payment schedule' }, ...own.map((o) => ({ value: o.key, label: `${o.label} (${money(o.owed)} owed)` }))];
}

export function openPaymentDialog({ loaded, accounts = [], payment = null }) {
  const st = loaded.statement;
  const sale = loaded.sale;
  const suggest = st.next?.kind === 'schedule' ? st.next.owed : (st.dueDates.find((d) => d.owed > 0)?.owed ?? '');
  const p = payment || { amount: suggest, date: todayYMD(), method: '', account_id: '', reference: '', note: '', toward: '' };
  const methods = [...new Set([...PAYMENT_METHODS, ...(p.method ? [p.method] : [])])];
  const live = accounts.filter((a) => !a.is_archived || a.id === p.account_id);
  let saved = null;
  return formDialog({
    title: payment ? 'Edit the payment' : 'Record a payment',
    confirmLabel: payment ? 'Save' : 'Record it',
    bodyHtml: `<div class="form-grid">
        <div class="field"><label for="pp-amount">Amount</label><input id="pp-amount" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(p.amount ?? '')}"></div>
        <div class="field"><label for="pp-date">Date received</label><input id="pp-date" type="date" value="${esc(p.date || '')}"></div>
        <div class="field"><label for="pp-method">How they paid</label><select id="pp-method"><option value="">—</option>${methods.map((m) => `<option${m === p.method ? ' selected' : ''}>${esc(m)}</option>`).join('')}</select></div>
        ${live.length ? `<div class="field"><label for="pp-account">Paid via</label><select id="pp-account"><option value="">—</option>${live.map((a) => `<option value="${esc(a.id)}"${a.id === p.account_id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>` : ''}
        <div class="field"><label for="pp-toward">Toward</label><select id="pp-toward">${towardChoices(st, p.toward).map((c) => `<option value="${esc(c.value)}"${c.value === (p.toward || '') ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="pp-reference">Reference</label><input id="pp-reference" type="text" maxlength="100" value="${esc(p.reference || '')}" placeholder="e.g. a confirmation number"></div>
        <div class="field field-wide"><label for="pp-note">Note</label><input id="pp-note" type="text" maxlength="300" value="${esc(p.note || '')}"></div>
      </div>
      ${st.next ? `<p class="field-hint">Next due: ${esc(money(st.next.owed))}${st.next.date ? ` by ${esc(fmtDate(st.next.date))}` : ''}.</p>` : ''}`,
    onConfirm: async (o) => {
      const v = (id) => o.querySelector(id)?.value ?? '';
      const rec = newPayment({ id: payment?.id || null, amount: v('#pp-amount'), date: v('#pp-date'), method: v('#pp-method'), account_id: v('#pp-account'), reference: v('#pp-reference'), note: v('#pp-note'), toward: v('#pp-toward') });
      saved = await savePayment(loaded, rec, payment);
    }
  }).then(async (ok) => {
    // Asked once the dialog has closed: everything paid → mark it paid in full?
    if (ok && saved) await offerPaidInFull(saved);
    return ok;
  });
}

// Save one payment. A payment toward one step of an extra that covers what's owed on
// it also marks that step paid on its date (older screens read the step's paid date);
// the payment remembers it did, so removing it unmarks the step.
async function savePayment(loaded, rec, before) {
  const sale = loaded.sale;
  const had = Array.isArray(sale.extra_charges) ? sale.extra_charges : [];
  let extra = unmarkStep(had, before);
  const [, chargeId, stepId] = (rec.toward || '').split(':');
  if (stepId) {
    const owed = loaded.statement.ownDated.find((o) => o.key === rec.toward)?.owed ?? 0;
    const already = before?.toward === rec.toward ? before.amount : 0;
    const step = extra.find((c) => c.id === chargeId)?.payments?.find((x) => x.id === stepId);
    if (step && !step.paid_date && rec.amount >= owed + already) {
      extra = extra.map((c) => (c.id !== chargeId ? c : { ...c, payments: c.payments.map((x) => (x.id === stepId ? { ...x, paid_date: rec.date } : x)) }));
      rec.marks_step_paid = true;
    }
  }
  const changes = { payments: paymentsWith(sale, rec), ...(extra !== had ? { extra_charges: extra } : {}) };
  return saleRepo.update(sale.id, changes);
}

// The step a payment marked paid, unmarked (it's being changed or removed).
function unmarkStep(extra, payment) {
  if (!payment?.marks_step_paid || !payment.toward || !extra.length) return extra;
  const [, chargeId, stepId] = payment.toward.split(':');
  return extra.map((c) => (c.id !== chargeId || !Array.isArray(c.payments) ? c
    : { ...c, payments: c.payments.map((s) => (s.id === stepId && s.paid_date === payment.date ? (({ paid_date: _p, ...rest }) => rest)(s) : s)) }));
}

async function removePayment(loaded, id) {
  const sale = loaded.sale;
  const payment = (sale.payments || []).find((p) => p.id === id);
  if (!payment) return false;
  if (!(await confirmModal({ title: `Remove the ${fmtMoney(payment.amount)} payment?`, message: `Received ${fmtDate(payment.date)}. It no longer counts toward what they owe.`, confirmLabel: 'Remove', danger: true }))) return false;
  const had = Array.isArray(sale.extra_charges) ? sale.extra_charges : [];
  const extra = unmarkStep(had, payment);
  await saleRepo.update(sale.id, { payments: paymentsWith(sale, { id }, { remove: true }), ...(extra !== had ? { extra_charges: extra } : {}) });
  return true;
}

// Everything is paid (D22): one question, the date and the status together.
async function offerPaidInFull(sale) {
  const fresh = await getSaleStatement(sale);
  const offer = fresh && paidInFullOffer(fresh.statement, sale);
  if (!offer) return false;
  const date = offer.date || todayYMD();
  const ok = await confirmModal({
    title: 'Everything is paid',
    message: `Mark the sale paid in full on ${fmtDate(date)}?${['deposit_pending', 'deposit_paid'].includes(sale.status) ? ' Its status becomes Paid in full.' : ''}`,
    confirmLabel: 'Mark paid in full', cancelLabel: 'Not now'
  });
  if (!ok) return false;
  await saleRepo.update(sale.id, { balance_paid_date: date, ...(['deposit_pending', 'deposit_paid'].includes(sale.status) ? { status: 'paid_in_full' } : {}) });
  return true;
}

// --- Fees added (D17) ---------------------------------------------------------------------------

// After a save that added a transport fee, boarding or an extra: what the schedule is
// now, and whether to adjust it. Never changes anything by itself. `after`: the sale
// as saved; `before`: as it was (null for a new sale).
export async function askAboutNewFees({ before, after, savedList = [] }) {
  if (!after || RELEASED_SALE_STATUSES.includes(after.status)) return false;
  const fees = addedFees(before, after);
  if (!fees.length) return false;
  const loaded = await getSaleStatement(after.id);
  if (!loaded) return false;
  const added = fees.map((f) => `${f.label}${f.own ? ', paid on its own dates' : ''}`).join('; ');
  const ok = await confirmModal({
    title: 'Schedule the new fees?',
    message: `Added: ${added}.\n\nYour current payment schedule is: ${scheduleSummary(loaded.statement, words)}.\n\nDo you need to make any adjustments to schedule the new fees?`,
    confirmLabel: 'Adjust the schedule', cancelLabel: 'Keep it'
  });
  if (!ok) return false;
  return openScheduleEditor({ loaded, savedList });
}
