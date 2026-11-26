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
//   openDiscountDialog({ loaded, kennel, preset })   → true once saved (Pro, costCover)
//   askAboutNewFees({ before, after, savedList })    after a save that added fees
//   stepsEditorHtml / wireStepsEditor / readStepsEditor   the due-date rows, also used
//                                                          for the Kennel page's saved schedules
import { saleRepo } from '../data/saleRepo.js';
import { getSaleStatement } from '../data/incomeView.js';
import {
  paymentStatement, saleCharges, cleanSchedule, defaultSchedule, readSchedule, scheduleFromSaved, newPayment, paymentsWith,
  addedFees, paidInFullOffer, paidInFullChanges, finalDueDate, scheduleSummary, coversText, sharesText, duePieces, chargesToward, towardKeys, dueToward,
  cleanPriority, SCHEDULE_MAX, chargePieces, sameDayPairs, outOfOrderAt, inDateOrder, combineRows
} from '../data/paymentSchedule.js';
import { SCHEDULE_DUE, SCHEDULE_COVERS, PAYMENT_METHODS, RELEASED_SALE_STATUSES } from '../data/vocab.js';
import { saleExtraCharges, paymentFeeChargeBack, chargesWithPaymentFee, paymentFeeFor } from '../data/extraCharges.js';
import { editionFlags } from '../data/editionConfig.js';
import { payGroups, methodNames, stageOfNext } from '../data/payMethods.js';
import { ownDiscounts, ownDiscountAmount, suggestedDiscounts, methodSavings, methodDiscount, discountForPayment, discountsWith, DISCOUNT_LABEL_MAX } from '../data/discounts.js';
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
  if (step.shares) return sharesText(step, charges, { money });
  const what = coversText(step.covers, charges);
  if (step.percent != null) return step.basis === 'remaining' ? `${step.percent}% of what's left of ${what}, new payments only` : `${step.percent}% of ${what}, counting what's paid`;
  return `${money(step.amount)} toward ${what}${step.prior_funds === 'dont_count' ? ', new payments only' : ''}`;
}

const dateText = (date, step) => (date ? fmtDate(date) : step?.due === 'at_pickup' ? 'At pickup (no date yet)' : 'Date not known yet');

// What a piece of money received was: "Payment (Zelle)", "Credit", "Deposit".
const RECEIVED_LABEL = { fee: 'Application fee credited', credit: 'Credit', discount: 'Discount', deposit: 'Deposit', step: 'Marked paid', payment: 'Payment', paid_in_full: 'Marked paid in full' };
// Discounts are Pro (Payment Methods plan §5.4, with Covering payment costs).
const discountsOn = (kennel) => Boolean(editionFlags.costCover && kennel);
// "Read about discounts" opens the popup from the Pro-only module when tapped.
const aboutDiscounts = () => '<a href="#" data-about="discounts">Read about discounts</a>';
function wireAbout(root) {
  root.addEventListener('click', (e) => {
    const a = e.target.closest('[data-about]');
    if (!a) return;
    e.preventDefault();
    import('./costCoverUI.js').then((m) => m.openAbout(a.dataset.about));
  });
}

// --- The card ------------------------------------------------------------------------------

// `loaded`: incomeView.getSaleStatement's result. `editable`: false on an ended sale or
// a read-only page. `finalMethods`: her text for the final payment (Kennel).
// `kennel` and `sales` (Pro, Covering payment costs on): her discounts, and the ones
// that suggest themselves on this sale (a repeat buyer).
export function paymentsCardHtml(loaded, { accountsById = new Map(), finalMethods = '', editable = true, kennel = null, sales = [] } = {}) {
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
      <br>Asks ${esc(money(d.ask))}${d.threshold > 0 && !d.isFinal && !st.byShares ? ` · ${esc(money(d.threshold))} paid in all by then` : ''}`;
    rows.push(line(d.label, sub, d.owed > 0 ? `${esc(money(d.owed))} owed` : '', statusBadge(d.status)));
  }
  const own = st.ownDated.length ? `<h3 style="margin:14px 0 2px; font-size:1em;">Paid on their own dates</h3>
      <ul style="margin:0; padding:0; list-style:none;">${st.ownDated.map((o) => line(o.label, `${esc(money(o.amount))} · ${esc(dateText(o.date))}`, o.owed > 0 ? `${esc(money(o.owed))} owed` : '', statusBadge(o.status))).join('')}</ul>` : '';
  const methods = finalMethods ? `<p class="field-hint" style="margin:8px 0 0;">Final payment: ${esc(finalMethods)}</p>` : '';
  const scheduleNote = st.hasSchedule ? '' : '<p class="field-hint" style="margin:8px 0 0;">No payment schedule: everything after the deposit is due once. Add a schedule for more than one due date.</p>';
  // Her discounts (§5.4): a suggested one to add in a tap, and Add a discount.
  const suggested = canEdit && discountsOn(kennel) ? suggestedDiscounts(kennel, sale, sales) : [];
  const discounts = canEdit && discountsOn(kennel) ? `<p style="margin:10px 0 0; display:flex; gap:6px 10px; flex-wrap:wrap; align-items:center;">
      ${suggested.map((r) => `<span class="badge badge-blue">${esc(r.label)}: ${esc(money(ownDiscountAmount(r, st)))} off</span> <button class="btn btn-sm" data-ps-suggest="${esc(r.id)}">Add it</button>`).join('')}
      <button class="btn btn-sm" data-ps="discount">Add a discount</button></p>` : '';
  return `${head}${totals}${next}
    <ul style="margin:0; padding:0; list-style:none;">${rows.join('')}</ul>
    ${own}${methods}${scheduleNote}${discounts}
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
        ? `<div class="pill-row"><button class="btn btn-sm" data-ps-edit="${esc(r.id)}">Edit</button><button class="btn btn-sm" data-ps-remove="${esc(r.id)}">Remove</button></div>`
        : canEdit && r.kind === 'discount' ? `<div class="pill-row"><button class="btn btn-sm" data-ps-discount-remove="${esc(r.id)}">Remove</button></div>` : '';
      return `<li class="row-between" style="padding:8px 0; border-top:1px solid var(--border); align-items:flex-start; gap:8px;">
        <div><strong>${esc(money(r.amount + r.unapplied))}</strong> ${esc(r.kind === 'discount' ? r.discount_label : RECEIVED_LABEL[r.kind] || r.kind)}${r.kind === 'discount' ? ` <span class="badge badge-blue">${esc(r.payment_id ? 'with a payment' : 'off the final payment')}</span>` : ''}${r.date ? ` · ${esc(fmtDate(r.date))}` : ''}${via ? ` <span class="faint">${esc(via)}</span>` : ''}${extra}
          <div class="faint" style="font-size:13px;">Toward: ${toward}</div></div>
        ${buttons}
      </li>`;
    }).join('')}</ul>`;
}

// Wire the card's buttons. `onChanged()` reloads and redraws the page after a save.
export function wirePaymentsCard(root, { loaded, accounts = [], savedList = [], onChanged, offIds = [], kennel = null }) {
  const fail = (err) => { root.insertAdjacentHTML('afterbegin', `<div class="inline-error">${esc(err.message || String(err))}</div>`); };
  root.querySelector('[data-ps="record"]')?.addEventListener('click', () => openPaymentDialog({ loaded, accounts, offIds, kennel }).then((ok) => ok && onChanged()).catch(fail));
  root.querySelector('[data-ps="schedule"]')?.addEventListener('click', () => openScheduleEditor({ loaded, savedList }).then((ok) => ok && onChanged()).catch(fail));
  root.querySelector('[data-ps="paid-in-full"]')?.addEventListener('click', () => offerPaidInFull(loaded.sale).then((ok) => ok && onChanged()).catch(fail));
  root.querySelectorAll('[data-ps-edit]').forEach((b) => b.addEventListener('click', () => {
    const payment = (loaded.sale.payments || []).find((p) => p.id === b.dataset.psEdit);
    if (payment) openPaymentDialog({ loaded, accounts, payment, offIds, kennel }).then((ok) => ok && onChanged()).catch(fail);
  }));
  root.querySelectorAll('[data-ps-remove]').forEach((b) => b.addEventListener('click', () => removePayment(loaded, b.dataset.psRemove).then((ok) => ok && onChanged()).catch(fail)));
  root.querySelector('[data-ps="discount"]')?.addEventListener('click', () => openDiscountDialog({ loaded, kennel }).then((ok) => ok && onChanged()).catch(fail));
  root.querySelectorAll('[data-ps-suggest]').forEach((b) => b.addEventListener('click', () => openDiscountDialog({ loaded, kennel, preset: b.dataset.psSuggest }).then((ok) => ok && onChanged()).catch(fail)));
  root.querySelectorAll('[data-ps-discount-remove]').forEach((b) => b.addEventListener('click', () => removeDiscount(loaded, b.dataset.psDiscountRemove).then((ok) => ok && onChanged()).catch(fail)));
}

// --- Her discounts on a sale (Payment Methods plan §5.4) -----------------------------------

// Add one of her own discounts (or a one-off): its amount filled in from her table
// (a percent of the full total), editable for this sale. Comes off the final payment.
export function openDiscountDialog({ loaded, kennel, preset = '' }) {
  const st = loaded.statement;
  const rows = ownDiscounts(kennel);
  const first = rows.find((r) => r.id === preset) || rows[0] || null;
  const opts = [...rows.map((r) => `<option value="${esc(r.id)}"${first && r.id === first.id ? ' selected' : ''}>${esc(r.label)}</option>`), `<option value=""${first ? '' : ' selected'}>Something else</option>`].join('');
  return formDialog({
    title: 'Add a discount',
    confirmLabel: 'Add it',
    bodyHtml: `<div class="form-grid">
        <div class="field"><label for="pd-which">Discount</label><select id="pd-which">${opts}</select></div>
        <div class="field"><label for="pd-label">Families see</label><input id="pd-label" type="text" maxlength="${DISCOUNT_LABEL_MAX}" value="${esc(first?.label || '')}" placeholder="e.g. Welcome back"></div>
        <div class="field"><label for="pd-amount">Amount</label><input id="pd-amount" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(first ? ownDiscountAmount(first, st) : '')}"></div>
      </div>
      <p class="field-hint">Off the full total, from the final payment. ${aboutDiscounts()}</p>`,
    onConfirm: async (o) => {
      const label = o.querySelector('#pd-label').value.trim();
      const amount = Math.round(Number(o.querySelector('#pd-amount').value) * 100) / 100;
      if (!label) throw new Error('Name the discount families will see.');
      if (!(amount > 0)) throw new Error('Enter the amount off.');
      if (!(amount < st.remaining)) throw new Error(`That's more than is still owed (${money(st.remaining)}).`);
      const which = o.querySelector('#pd-which').value;
      await saleRepo.update(loaded.sale.id, { discounts: discountsWith(loaded.sale, { id: crypto.randomUUID(), ...(which ? { discount_id: which } : {}), label, amount }) });
    }
  }, (o) => {
    wireAbout(o);
    o.querySelector('#pd-which').addEventListener('change', (e) => {
      const r = rows.find((x) => x.id === e.target.value);
      o.querySelector('#pd-label').value = r ? r.label : '';
      o.querySelector('#pd-amount').value = r ? ownDiscountAmount(r, st) : '';
    });
  });
}

async function removeDiscount(loaded, id) {
  const sale = loaded.sale;
  const d = (sale.discounts || []).find((x) => x && x.id === id);
  if (!d) return false;
  if (!(await confirmModal({ title: `Remove "${d.label}"?`, message: `${fmtMoney(d.amount)} goes back onto what they owe.`, confirmLabel: 'Remove', danger: true }))) return false;
  await saleRepo.update(sale.id, { discounts: discountsWith(sale, { id }, { remove: true }) });
  return true;
}

// What a payment toward `toward` covers, charge by charge, for the method discount.
function piecesToward(st, toward) {
  if (!toward) return duePieces(st);
  if (toward.startsWith('due:')) return duePieces(st, toward.slice(4));
  const keys = towardKeys(toward);
  if (keys.length) return duePieces(st).filter((p) => keys.includes(p.key));
  return [];
}

// --- Due-date rows (the sale's editor and the Kennel page's saved schedules) -------------

// What a due date collects (Payment Schedule plan §12, D39): a line per charge, each
// In full · At least % · $ amount · The rest, or one $ amount across the ticked charges
// (paid in her priority order). "New payments only": the deposit, the fee credit and
// credits don't count toward it.
const HOWS = [
  { value: 'full', label: 'In full' },
  { value: 'percent', label: 'At least %' },
  { value: 'amount', label: '$ amount' },
  { value: 'rest', label: 'The rest' }
];
const KIND_LABELS = { price: 'Purchase price', boarding: 'Boarding', extras: 'Extras', transport: 'Transport' };

// The charge choices: price always; boarding, transport and extras when the sale has
// them (all of them for a saved schedule); each extra on the schedule by name.
function coverChoices(charges, saved) {
  const has = (c) => saved || charges.some((x) => x.part === 'schedule' && x.covers === c);
  const base = SCHEDULE_COVERS.filter((c) => c.value === 'price' || has(c.value)).map((c) => ({ value: c.value, label: c.label }));
  // A fee charged back isn't a choice: it's always on the last payment.
  const extras = saved ? [] : charges.filter((x) => x.part === 'schedule' && x.extraId && !x.finalOnly).map((x) => ({ value: `extra:${x.extraId}`, label: x.label }));
  return [...base, ...extras];
}

// A stored step as the editor shows it: shares, or one amount across charges. A step
// saved before shares (a percent over what it covers) shows as that percent of each.
function rowState(st, choices) {
  const every = choices.map((c) => c.value);
  const covers = st.covers?.includes('all') ? every : (st.covers || []);
  if (st.shares) return { mode: 'each', lines: new Map(st.shares.map((x) => [x.charge, x])), newMoney: st.new_money === true };
  if (st.amount != null && st.percent == null) return { mode: 'pooled', lines: new Map(covers.map((c) => [c, { charge: c }])), amount: st.amount, newMoney: st.prior_funds === 'dont_count' };
  return { mode: 'each', lines: new Map(covers.map((c) => [c, { charge: c, how: Number(st.percent) >= 100 ? 'full' : 'percent', value: st.percent }])), newMoney: st.basis === 'remaining' };
}

function rowHtml(st, i, { final, choices, saved }) {
  const step = { due: 'at_pickup', covers: ['price'], shares: [{ charge: 'price', how: 'percent', value: 50 }], ...st };
  const dueOpts = SCHEDULE_DUE.filter((d) => !(saved && d.value === 'on_date'))
    .map((d) => `<option value="${esc(d.value)}"${d.value === step.due ? ' selected' : ''}>${esc(d.label)}</option>`).join('');
  const state = final ? null : rowState(step, choices);
  const lines = final ? '' : choices.map((c) => {
    const line = state.lines.get(c.value);
    const how = line?.how || 'full';
    return `<div class="ps-line" data-charge="${esc(c.value)}" style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:3px 0;">
        <label class="check-inline" style="min-width:9em;"><input type="checkbox" class="ps-take"${line ? ' checked' : ''}> ${esc(c.label)}</label>
        <select class="ps-how" aria-label="How much of ${esc(c.label)}" style="width:auto;">${HOWS.map((h) => `<option value="${h.value}"${h.value === how ? ' selected' : ''}>${esc(h.label)}</option>`).join('')}</select>
        <input class="ps-hv" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(line?.value ?? '')}" aria-label="${esc(c.label)}: percent or amount" style="width:6.5em;">
      </div>`;
  }).join('');
  return `<div class="ps-row" data-id="${esc(step.id || '')}" data-label="${esc(step.label || '')}"${final ? ' data-final="1"' : ''} style="border-top:1px solid var(--border); padding:10px 0;">
      <div class="row-between"><strong class="ps-title">${final ? 'Final payment' : `Payment ${i + 1}`}</strong>${final ? '' : '<button type="button" class="btn btn-sm" data-ps-row="remove" aria-label="Remove this due date">✕</button>'}</div>
      <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:6px 0;">
        <select class="ps-due" aria-label="When it's due" style="width:auto;">${dueOpts}</select>
        <span class="ps-n-wrap" style="display:inline-flex; gap:4px; align-items:center;"><input class="ps-n" type="number" min="0" step="1" inputmode="numeric" value="${esc(step.n ?? '')}" aria-label="How many" style="width:5em;"> <span class="ps-unit faint"></span></span>
        <input class="ps-date" type="date" value="${esc(step.due_date || '')}" aria-label="Date" style="width:auto;">
      </div>
      ${final ? '<div style="margin:4px 0;"><span class="faint">Everything left on the sale</span></div>' : `
      <div style="margin:6px 0;"><select class="ps-mode" aria-label="What it collects" style="width:auto;">
        <option value="each"${state.mode === 'each' ? ' selected' : ''}>Set each charge</option>
        <option value="pooled"${state.mode === 'pooled' ? ' selected' : ''}>One $ amount across them</option>
      </select>
      <span class="ps-pool-wrap" style="display:${state.mode === 'pooled' ? 'inline-flex' : 'none'}; gap:4px; align-items:center;">$ <input class="ps-pool" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(state.amount ?? '')}" aria-label="Amount" style="width:7em;"></span></div>
      <div class="ps-lines">${lines}</div>
      <label class="check-inline" style="margin-top:4px;"><input type="checkbox" class="ps-new"${state.newMoney ? ' checked' : ''}> New payments only (the deposit and credits don't count toward it)</label>`}
      <div class="ps-preview field-hint"></div>
    </div>`;
}

// Her order for money no payment names, and for one amount across several charges
// (D40): ↑ ↓ per kind.
function priorityHtml(priority) {
  return `<div class="ps-priority" style="margin-top:12px;">
      <p class="field-hint" style="margin:0 0 4px;">Money that isn't for one payment (the deposit, credits, paying early) pays these first, in this order:</p>
      ${cleanPriority(priority).map((k, i) => `<div class="ps-prio" data-kind="${k}" style="display:flex; gap:6px; align-items:center; padding:2px 0;">
        <span style="min-width:9em;">${i + 1}. ${esc(KIND_LABELS[k])}</span>
        <button type="button" class="btn btn-sm" data-ps-prio="up" aria-label="Move ${esc(KIND_LABELS[k])} up">↑</button>
        <button type="button" class="btn btn-sm" data-ps-prio="down" aria-label="Move ${esc(KIND_LABELS[k])} down">↓</button>
      </div>`).join('')}
    </div>`;
}

// The rows' HTML. `steps`: cleaned steps (the last is the final payment).
export function stepsEditorHtml(steps, { charges = [], saved = false, priority = null } = {}) {
  const list = steps && steps.length ? steps : [{ id: 'final', due: 'at_pickup', covers: ['all'], percent: 100, basis: 'total' }];
  const choices = coverChoices(charges, saved);
  return `<div class="ps-notes"></div>
    <div class="ps-rows">${list.map((st, i) => rowHtml(st, i, { final: i === list.length - 1, choices, saved })).join('')}</div>
    <button type="button" class="btn btn-sm" data-ps-row="add">+ Add a due date</button>
    ${priorityHtml(priority)}`;
}

// Her priority as the editor shows it.
export const readPriority = (root) => [...root.querySelectorAll('.ps-prio')].map((el) => el.dataset.kind);

// What the rows say now, as steps (not yet checked: scheduleProblem does that).
export function readStepsEditor(root) {
  return [...root.querySelectorAll('.ps-row')].map((row) => {
    const final = row.dataset.final === '1';
    const due = row.querySelector('.ps-due').value;
    const step = { id: row.dataset.id || '', due };
    if (row.dataset.label) step.label = row.dataset.label;
    if (SCHEDULE_DUE.find((d) => d.value === due)?.needsN) step.n = row.querySelector('.ps-n').value;
    if (due === 'on_date') step.due_date = row.querySelector('.ps-date').value;
    if (final) return { ...step, covers: ['all'], percent: 100, basis: 'total' };
    const ticked = [...row.querySelectorAll('.ps-line')].filter((l) => l.querySelector('.ps-take').checked);
    const newMoney = row.querySelector('.ps-new').checked;
    step.covers = ticked.map((l) => l.dataset.charge);
    if (row.querySelector('.ps-mode').value === 'pooled') {
      return { ...step, amount: row.querySelector('.ps-pool').value, prior_funds: newMoney ? 'dont_count' : 'count', pooled: true };
    }
    step.shares = ticked.map((l) => {
      const how = l.querySelector('.ps-how').value;
      return { charge: l.dataset.charge, how, ...(how === 'percent' || how === 'amount' ? { value: l.querySelector('.ps-hv').value } : {}) };
    });
    if (newMoney) step.new_money = true;
    // For older builds, which read a percent of what it covers: the largest percent
    // asked (100 when a charge is asked in full or as an amount).
    const pcts = step.shares.map((x) => (x.how === 'percent' ? Number(x.value) || 0 : 100));
    Object.assign(step, { percent: Math.max(1, ...pcts.filter((v) => v > 0)), basis: newMoney ? 'remaining' : 'total' });
    return step;
  });
}

// Wire adding/removing rows, each row's own fields, her priority and the tidy-up
// notes, once per container (listeners are delegated, so the rows can be redrawn).
// `onChange()` runs whenever anything changes (the sale's editor redraws its
// previews). `datesOf(rows)` → each row's date on a sale (none for a saved schedule:
// rules are compared, D48). → refresh(), to call after redrawing the rows.
export function wireStepsEditor(root, { charges = [], saved = false, onChange = () => {}, datesOf = null } = {}) {
  const redraw = (rows) => {
    const prio = readPriority(root);
    root.innerHTML = stepsEditorHtml(rows.map((r) => cleanSchedule([r, { id: 'f', due: 'at_pickup', covers: ['all'], percent: 100, basis: 'total' }])?.[0] || r), { charges, saved, priority: prio });
    // The final row keeps its own date settings.
    sync();
  };
  const notes = () => {
    const box = root.querySelector('.ps-notes');
    if (!box) return;
    const rows = readStepsEditor(root);
    const dates = datesOf ? datesOf(rows) : null;
    const name = (i) => (i === rows.length - 1 ? 'the final payment' : `Payment ${i + 1}`);
    const out = [];
    const at = outOfOrderAt(rows, dates);
    if (at > 0) out.push(`<p class="field-hint" style="margin:0 0 6px;">${esc(name(at)[0].toUpperCase() + name(at).slice(1))} is due before ${esc(name(at - 1))}. <button type="button" class="btn btn-sm" data-ps-tidy="order">Put them in date order</button></p>`);
    for (const [i, j] of sameDayPairs(rows, dates)) {
      const final = j === rows.length - 1;
      const res = combineRows(rows[i], rows[j], { final });
      const when = dates?.[i] ? ` ${fmtDate(dates[i])}` : ' the same day';
      out.push(`<p class="field-hint" style="margin:0 0 6px;">${esc(name(i)[0].toUpperCase() + name(i).slice(1))} and ${esc(name(j))} are both due${esc(when)}. ${res.row
        ? `<button type="button" class="btn btn-sm" data-ps-tidy="combine" data-a="${i}" data-b="${j}">Combine them</button>${final ? ` <span class="faint">The final payment asks everything left, so ${esc(name(i))} joins it.</span>` : ''}`
        : `They stay separate: ${esc(res.why)}.`}</p>`);
      break;
    }
    box.innerHTML = out.join('');
  };
  const sync = () => {
    const all = root.querySelectorAll('.ps-row');
    all.forEach((row, i) => {
      const due = SCHEDULE_DUE.find((d) => d.value === row.querySelector('.ps-due').value);
      row.querySelector('.ps-n-wrap').style.display = due?.needsN ? 'inline-flex' : 'none';
      row.querySelector('.ps-unit').textContent = due?.unit || '';
      row.querySelector('.ps-date').style.display = due?.value === 'on_date' ? '' : 'none';
      if (row.dataset.final !== '1') row.querySelector('.ps-title').textContent = row.dataset.label || `Payment ${i + 1}`;
      const mode = row.querySelector('.ps-mode')?.value;
      if (mode) {
        row.querySelector('.ps-pool-wrap').style.display = mode === 'pooled' ? 'inline-flex' : 'none';
        row.querySelectorAll('.ps-line').forEach((l) => {
          const on = l.querySelector('.ps-take').checked;
          const how = l.querySelector('.ps-how').value;
          l.querySelector('.ps-how').style.display = mode === 'each' && on ? '' : 'none';
          l.querySelector('.ps-hv').style.display = mode === 'each' && on && (how === 'percent' || how === 'amount') ? '' : 'none';
          l.querySelector('.ps-hv').setAttribute('aria-label', how === 'percent' ? 'Percent' : 'Amount');
        });
      }
      if (row.dataset.final === '1' && i !== all.length - 1) row.parentElement.appendChild(row);
    });
    const add = root.querySelector('[data-ps-row="add"]');
    if (add) add.hidden = all.length >= SCHEDULE_MAX;
    root.querySelectorAll('.ps-prio').forEach((el, i) => { el.querySelector('span').textContent = `${i + 1}. ${KIND_LABELS[el.dataset.kind]}`; });
    notes();
    onChange();
  };
  root.addEventListener('click', (ev) => {
    const prio = ev.target.closest('[data-ps-prio]');
    if (prio && root.contains(prio)) {
      const el = prio.closest('.ps-prio');
      if (prio.dataset.psPrio === 'up' && el.previousElementSibling?.classList.contains('ps-prio')) el.parentElement.insertBefore(el, el.previousElementSibling);
      if (prio.dataset.psPrio === 'down' && el.nextElementSibling?.classList.contains('ps-prio')) el.parentElement.insertBefore(el.nextElementSibling, el);
      sync();
      return;
    }
    const tidy = ev.target.closest('[data-ps-tidy]');
    if (tidy && root.contains(tidy)) {
      const rows = readStepsEditor(root);
      const dates = datesOf ? datesOf(rows) : null;
      if (tidy.dataset.psTidy === 'order') redraw(inDateOrder(rows, dates));
      else {
        const a = Number(tidy.dataset.a);
        const b = Number(tidy.dataset.b);
        const final = b === rows.length - 1;
        const res = combineRows(rows[a], rows[b], { final });
        // Into the final payment: the row simply goes. Else one row in the first's place.
        if (res.row) redraw(final ? rows.filter((_, k) => k !== a) : rows.map((r, k) => (k === a ? res.row : r)).filter((_, k) => k !== b));
      }
      return;
    }
    const btn = ev.target.closest('[data-ps-row]');
    if (!btn || !root.contains(btn)) return;
    if (btn.dataset.psRow === 'remove') btn.closest('.ps-row').remove();
    if (btn.dataset.psRow === 'add') {
      const rows = root.querySelector('.ps-rows');
      const final = rows.querySelector('.ps-row[data-final="1"]');
      const count = rows.querySelectorAll('.ps-row').length;
      if (count >= SCHEDULE_MAX) return;
      final.insertAdjacentHTML('beforebegin', rowHtml({ due: 'at_weeks', n: 8, covers: ['price'], shares: [{ charge: 'price', how: 'percent', value: 50 }] }, count - 1, { final: false, choices: coverChoices(charges, saved), saved }));
    }
    sync();
  });
  root.addEventListener('change', () => sync());
  root.addEventListener('input', () => onChange());
  sync();
  return sync;
}

// --- The sale's schedule editor ---------------------------------------------------------------

// Each row's preview from the statement the draft schedule gives: what it asks, what
// it's due, the date. A draft that doesn't make sense yet previews nothing.
function draftStatement(root, loaded) {
  const rows = readStepsEditor(root);
  const ids = rows.map((r, i) => r.id || `draft${i}`);
  const draft = cleanSchedule(rows.map((r, i) => ({ ...r, id: ids[i] })));
  const st = draft ? paymentStatement({ ...loaded.sale, payment_schedule: draft, payment_priority: readPriority(root) }, loaded.opts) : null;
  return { ids, st };
}
// Each row's preview: its date, what it asks and for what ("boarding $240, transport
// $150, purchase price $500"), what's still owed.
function previewRows(root, loaded) {
  const { ids, st } = draftStatement(root, loaded);
  root.querySelectorAll('.ps-row').forEach((el, i) => {
    const d = st?.dueDates.find((x) => x.id === ids[i]);
    const parts = d && st.byShares ? chargePieces(st).filter((p) => p.dueId === d.id && p.amount > 0).map((p) => `${p.label.toLowerCase()} ${money(p.amount)}`) : [];
    el.querySelector('.ps-preview').textContent = d
      ? `${dateText(d.date, d.step)} · asks ${money(d.ask)}${parts.length > 1 ? ` (${parts.join(', ')})` : ''}${d.owed > 0 ? ` · ${money(d.owed)} still owed` : ' · already paid'}`
      : 'Finish this row to see its amount and date.';
  });
}
// Each row's date on this sale, for the tidy-up notes (D48).
const rowDates = (root, loaded) => () => {
  const { ids, st } = draftStatement(root, loaded);
  return ids.map((id) => st?.dueDates.find((x) => x.id === id)?.date || null);
};

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
      <div id="ps-editor">${stepsEditorHtml(current || defaultSchedule(sale), { charges, priority: sale.payment_priority })}</div>
      ${current ? '<div style="margin-top:12px;"><button type="button" class="btn btn-sm btn-danger" data-ps="clear">Remove the schedule</button> <span class="field-hint">Everything after the deposit is due once again, on the final payment\'s date.</span></div>' : ''}`,
    onConfirm: async (o) => {
      const box = o.querySelector('#ps-editor');
      const { schedule, error } = readSchedule(readStepsEditor(box));
      if (error) throw new Error(error);
      const payment_priority = readPriority(box);
      const preview = paymentStatement({ ...sale, payment_schedule: schedule, payment_priority }, loaded.opts);
      const finalDate = finalDueDate(preview);
      // balance_due_date mirrors the final payment's date for the screens that read it.
      await saleRepo.update(sale.id, { payment_schedule: schedule, payment_priority, balance_due_date: finalDate || null });
    }
  }, (o, done) => {
    const box = o.querySelector('#ps-editor');
    const refresh = wireStepsEditor(box, { charges, onChange: () => previewRows(box, loaded), datesOf: rowDates(box, loaded) });
    o.querySelector('#ps-saved')?.addEventListener('change', (ev) => {
      const saved = savedList.find((x) => x.id === ev.target.value);
      if (!saved) return;
      box.innerHTML = stepsEditorHtml(scheduleFromSaved(saved), { charges, priority: saved.priority });
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
// When the next payment is split by method (Payment Methods plan D25), each part too:
// money paid toward a part pays its charges first (`charges:<keys>`).
// And each payment on the schedule still owed (Payment Schedule plan §12, D42): money
// toward one pays that payment's charges (`due:<id>`).
function towardChoices(st, current = '', parts = []) {
  const own = st.ownDated.filter((o) => o.owed > 0 || o.key === current);
  const dues = st.dueDates.filter((d) => d.owed > 0 || dueToward(d.id) === current)
    .map((d) => ({ value: dueToward(d.id), label: `${d.label}${d.date ? `, due ${fmtDate(d.date)}` : ''} (${money(d.owed)} owed)` }));
  const partChoices = parts.map((g) => ({ value: chargesToward(g.keys), label: `${g.label} (${money(g.amount)} owed${g.methods.length ? `, ${methodNames(g.methods)}` : ''})` }));
  const known = new Set(['', ...own.map((o) => o.key), ...dues.map((c) => c.value), ...partChoices.map((c) => c.value)]);
  const kept = current && !known.has(current) && towardKeys(current).length ? [{ value: current, label: towardKeys(current).map((k) => st.charges.find((c) => c.key === k)?.label || k).join(', ') }] : [];
  return [{ value: '', label: 'The next payment owed' }, ...(dues.length > 1 ? dues : []), ...partChoices, ...kept, ...own.map((o) => ({ value: o.key, label: `${o.label} (${money(o.owed)} owed)` }))];
}

// The next payment's parts by method, when it's split (D25). [] otherwise.
function nextParts(st, kennel, accounts, offIds) {
  if (!kennel || !st.next || st.next.kind === 'deposit') return [];
  const stage = stageOfNext({ final: st.next.isFinal, deposit: false });
  const groups = payGroups(stage, duePieces(st), kennel, accounts, { off: offIds });
  return groups && groups.length > 1 ? groups : [];
}

export function openPaymentDialog({ loaded, accounts = [], payment = null, offIds = [], kennel = null }) {
  const st = loaded.statement;
  const parts = nextParts(st, kennel, accounts, offIds);
  const sale = loaded.sale;
  const suggest = st.next?.kind === 'schedule' ? st.next.owed : (st.dueDates.find((d) => d.owed > 0)?.owed ?? '');
  const p = payment || { amount: suggest, date: todayYMD(), method: '', account_id: '', reference: '', note: '', toward: '' };
  const methods = [...new Set([...PAYMENT_METHODS, ...(p.method ? [p.method] : [])])];
  const live = accounts.filter((a) => !a.is_archived || a.id === p.account_id);
  // Paid via a discounted method (§5.4): the discount beside the payment, ticked.
  const hadDiscount = payment ? discountForPayment(sale, payment.id) : null;
  const methodOn = discountsOn(kennel) && Boolean(methodDiscount(kennel));
  let discount = hadDiscount ? { amount: hadDiscount.amount, label: hadDiscount.label, discount_id: hadDiscount.discount_id } : null;
  let saved = null;
  let added = null;
  return formDialog({
    title: payment ? 'Edit the payment' : 'Record a payment',
    confirmLabel: payment ? 'Save' : 'Record it',
    bodyHtml: `<div class="form-grid">
        <div class="field"><label for="pp-amount">Amount</label><input id="pp-amount" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(p.amount ?? '')}"></div>
        <div class="field"><label for="pp-date">Date received</label><input id="pp-date" type="date" value="${esc(p.date || '')}"></div>
        <div class="field"><label for="pp-method">How they paid</label><select id="pp-method"><option value="">—</option>${methods.map((m) => `<option${m === p.method ? ' selected' : ''}>${esc(m)}</option>`).join('')}</select></div>
        ${live.length ? `<div class="field"><label for="pp-account">Paid via</label><select id="pp-account"><option value="">—</option>${live.map((a) => `<option value="${esc(a.id)}"${a.id === p.account_id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select><span class="field-hint" id="pp-off"${offIds.includes(p.account_id) ? '' : ' hidden'}>Off for this family.</span></div>` : ''}
        ${methodOn || hadDiscount ? `<div class="field field-wide" id="pp-disc"${discount ? '' : ' hidden'}><label class="check-inline"><input type="checkbox" id="pp-disc-on"${discount ? ' checked' : ''}> <span id="pp-disc-text">${discount ? esc(`${discount.label}: ${money(discount.amount)} off`) : ''}</span></label></div>` : ''}
        <div class="field"><label for="pp-toward">Toward</label><select id="pp-toward">${towardChoices(st, p.toward, parts).map((c) => `<option value="${esc(c.value)}"${c.value === (p.toward || '') ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="pp-reference">Reference</label><input id="pp-reference" type="text" maxlength="100" value="${esc(p.reference || '')}" placeholder="e.g. a confirmation number"></div>
        <div class="field field-wide"><label for="pp-note">Note</label><input id="pp-note" type="text" maxlength="300" value="${esc(p.note || '')}"></div>
      </div>
      ${st.next ? `<p class="field-hint">Next due: ${esc(money(st.next.owed))}${st.next.date ? ` by ${esc(fmtDate(st.next.date))}` : ''}.</p>` : ''}`,
    onConfirm: async (o) => {
      const v = (id) => o.querySelector(id)?.value ?? '';
      const rec = newPayment({ id: payment?.id || null, amount: v('#pp-amount'), date: v('#pp-date'), method: v('#pp-method'), account_id: v('#pp-account'), reference: v('#pp-reference'), note: v('#pp-note'), toward: v('#pp-toward') });
      const account = accounts.find((a) => a.id === rec.account_id) || null;
      const keep = discount && o.querySelector('#pp-disc-on')?.checked && !o.querySelector('#pp-disc')?.hidden;
      const without = discountsWith(sale, { id: hadDiscount?.id || '' }, { remove: true });
      const discounts = keep ? [...without, { id: hadDiscount?.id || crypto.randomUUID(), ...(discount.discount_id ? { discount_id: discount.discount_id } : {}), label: discount.label, amount: discount.amount, payment_id: rec.id }]
        : hadDiscount ? without : undefined;
      saved = await savePayment(loaded, rec, payment, account, discounts);
      added = payment ? null : rec;
    }
  }, (o) => {
    wireAbout(o);
    const sel = o.querySelector('#pp-account');
    const amountEl = o.querySelector('#pp-amount');
    // The method discount for this account and what the payment is toward.
    const refreshDiscount = () => {
      if (!methodOn || !o.querySelector('#pp-disc')) return;
      const account = accounts.find((a) => a.id === sel?.value) || null;
      const pieces = piecesToward(st, o.querySelector('#pp-toward').value);
      const owed = Math.round(pieces.reduce((t, x) => t + x.owed, 0) * 100) / 100;
      const was = Math.round(Number(amountEl.value) * 100) / 100;
      const before = discount;
      const save = methodSavings({ kennel, account, sale, st, pieces, amount: owed });
      discount = save || (hadDiscount && account?.id === payment?.account_id ? before : null);
      o.querySelector('#pp-disc').hidden = !discount;
      if (!discount) return;
      // A discount that just applied starts ticked.
      if (!before) o.querySelector('#pp-disc-on').checked = true;
      o.querySelector('#pp-disc-text').textContent = `${discount.label}: ${money(discount.amount)} off${owed > 0 ? `. They send ${money(Math.round((owed - discount.amount) * 100) / 100)}.` : ''}`;
      // The amount she hasn't typed over follows: what's owed less the discount.
      if (!payment && owed > 0 && (was === owed || String(amountEl.value) === String(suggest) || (before && was === Math.round((owed - before.amount) * 100) / 100))) amountEl.value = Math.round((owed - discount.amount) * 100) / 100;
    };
    o.querySelector('#pp-toward').addEventListener('change', refreshDiscount);
    sel?.addEventListener('change', refreshDiscount);
    sel?.addEventListener('change', () => {
      o.querySelector('#pp-off').hidden = !offIds.includes(sel.value);
      // Paid via a method only one part takes: toward that part, for its amount.
      const only = parts.filter((g) => g.methods.some((a) => a.id === sel.value));
      if (payment || only.length !== 1) return;
      o.querySelector('#pp-toward').value = chargesToward(only[0].keys);
      const amount = o.querySelector('#pp-amount');
      if (String(amount.value) === String(suggest) || parts.some((g) => String(g.amount) === String(amount.value))) amount.value = only[0].amount;
      refreshDiscount();
    });
  }).then(async (ok) => {
    // Asked once the dialog has closed: this payment's fee charged back onto the last
    // payment, then, everything paid → mark it paid in full?
    if (ok && saved && added) saved = await offerPaymentFeeChargeBack(saved, added, accounts.find((a) => a.id === added.account_id));
    if (ok && saved) await offerPaidInFull(saved);
    return ok;
  });
}

// A payment made through an account set to charge its fee back (Account.fee_charge_back):
// offer to add its fee as a charge, collected with the last payment (extraCharges
// feeChargeBackOffers). Not when this payment paid the last of it: there's no later
// payment for the fee to ride on.
async function offerPaymentFeeChargeBack(sale, payment, account) {
  if (!editionFlags.extraCharges || sale.fee_passed_to_buyer) return sale; // already in the price
  const offer = paymentFeeChargeBack(payment, account);
  if (!offer || saleExtraCharges(sale).some((x) => x.fee_for === offer.fee_for)) return sale;
  const fresh = await getSaleStatement(sale);
  if (!fresh || fresh.statement.ended || !(fresh.statement.remaining > 0)) return sale;
  const ok = await confirmModal({
    title: `Charge the ${account.name} fee back?`,
    message: `This payment came through ${account.name}, which took about ${fmtMoney(offer.amount)}. Add "${offer.label}" (${fmtMoney(offer.amount)}) to the final payment, with any other fees charged back? You can change or remove it on the sale.`,
    confirmLabel: 'Add it', cancelLabel: 'Skip'
  });
  if (!ok) return sale;
  return saleRepo.update(sale.id, { extra_charges: [...(Array.isArray(sale.extra_charges) ? sale.extra_charges : []), { id: crypto.randomUUID(), ...offer }] });
}

// Save one payment. A payment toward one step of an extra that covers what's owed on
// it also marks that step paid on its date (older screens read the step's paid date);
// the payment remembers it did, so removing it unmarks the step.
// An edited payment's fee charged back follows its new amount or account.
// `discounts`: the sale's discounts with this payment's set or cleared (undefined: unchanged).
async function savePayment(loaded, rec, before, account = null, discounts = undefined) {
  const sale = loaded.sale;
  const had = Array.isArray(sale.extra_charges) ? sale.extra_charges : [];
  let extra = unmarkStep(had, before);
  if (before) extra = chargesWithPaymentFee({ ...sale, extra_charges: extra }, before.id, rec, account);
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
  const changes = { payments: paymentsWith(sale, rec), ...(extra !== had ? { extra_charges: extra } : {}), ...(discounts !== undefined ? { discounts } : {}) };
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
  const fee = (Array.isArray(sale.extra_charges) ? sale.extra_charges : []).find((x) => x?.fee_for === paymentFeeFor(id));
  const disc = discountForPayment(sale, id);
  if (!(await confirmModal({ title: `Remove the ${fmtMoney(payment.amount)} payment?`, message: `Received ${fmtDate(payment.date)}. It no longer counts toward what they owe.${fee ? ` Its fee charged back (${fmtMoney(fee.amount)}) comes off too.` : ''}${disc ? ` Its ${disc.label} (${fmtMoney(disc.amount)}) goes with it.` : ''}`, confirmLabel: 'Remove', danger: true }))) return false;
  const had = Array.isArray(sale.extra_charges) ? sale.extra_charges : [];
  const extra = chargesWithPaymentFee({ ...sale, extra_charges: unmarkStep(had, payment) }, id, null);
  await saleRepo.update(sale.id, { payments: paymentsWith(sale, { id }, { remove: true }), ...(extra !== had ? { extra_charges: extra } : {}), ...(disc ? { discounts: discountsWith(sale, disc, { remove: true }) } : {}) });
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
  await saleRepo.update(sale.id, paidInFullChanges(sale, date));
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
