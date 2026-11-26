// costCoverUI.js — Covering payment costs (Payment Methods plan §5.1–§5.3, §5.6; Phase 4):
// the Kennel page's card (service fees or payment-fee prices, a rule per kind of
// charge, the calculator under each rule), its Discounts card (§5.4, Phase 5), and the
// Read about… popups. Pro-only
// (proPages.js): the Kennel, Litter, Sale and Stud service pages import it only when
// editionFlags.costCover is on. Its pure parts are data/costCover.js and
// data/costCoverCalc.js.
import { esc, fmtMoney } from './ui.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { COVER_KINDS, COVER_KIND_LABELS, PERCENT_MAX, coverRules, readCostCover, withHandAmount } from '../data/costCover.js';
import { kennelDiscounts, readDiscounts, METHOD_DISCOUNT_DEFAULT, DISCOUNT_LABEL_MAX, DISCOUNT_PERCENT_MAX } from '../data/discounts.js';
import { workItOut, receivedByAccount, CALC_STAGES } from '../data/costCoverCalc.js';
import { methodLabel, stageIds } from '../data/payMethods.js';
import { savedSchedules } from '../data/paymentSchedule.js';
import { addDaysToYMD, todayYMD } from '../data/dateUtils.js';

const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
const money = (v) => fmtMoney(v) || '$0.00';
const avg = (list) => (list.length ? list.reduce((t, v) => t + v, 0) / list.length : 0);

// --- Read about… (§5.6) -------------------------------------------------------------
// The one place app copy carries a date and a not-legal-advice note (owner,
// 2026-11-25). From docs/KennelOS_Card_Fee_Rules_Facts.md: edit here and every popup
// follows.
export const ABOUT_AS_OF = 'November 25, 2026';
const ABOUT_NOTE = `What's below is how the rules read as of ${ABOUT_AS_OF}. It isn't legal advice: rules change, and they differ by state (yours and your buyer's). Check current sources and your payment processors' terms, PayPal's and Venmo's included, before you set prices.`;

const ABOUT = {
  service_fees: {
    title: 'Service fees',
    body: [
      ['What they are', 'A service fee is its own line inside the total, paid by every buyer whatever they pay with: "$2,575, includes a $75 service fee". It shows on invoices, receipts, contracts and in Income, with its own refund terms.'],
      ['Why every buyer', 'A fee added only when someone pays by card is a surcharge. Surcharges are credit-card only (never debit), capped (Visa: 3%), need 30 days\' notice to your processor, and are banned in Connecticut, Maine, Massachusetts and Puerto Rico (contested in Texas). PayPal\'s and Venmo\'s terms forbid a fee for paying with them. A fee every buyer pays is not a surcharge.'],
      ['Show the total', 'Several states (California, Minnesota, Virginia, Massachusetts, Colorado and others) count a fee every buyer must pay as part of the price you advertise. KennelOS shows families the total with the fee in it, everywhere it shows a price.'],
      ['Percent or amount', 'A percent follows each price by itself: 3% is $75 on a $2,500 puppy and $84 on a $2,800 one, so one rule covers every litter. A dollar amount is the same on every sale.'],
      ['By kind of charge', 'Each kind gets its own rule: the puppy price, extras, transport, boarding, stud fees. Each fee is added with its charge, so a deposit invoice, the balance and a transport invoice each match what\'s due. Never on the application fee.'],
      ['On the deposit', 'The deposit carries its share of the puppy fee, by size: a 3% fee on a $2,500 puppy is $75, and with a $500 deposit $15 of it is paid with the deposit and $60 later. The total never changes, and families paying the deposit by card cover their share.'],
      ['When it\'s fixed', 'On a sale, the fee follows its charge while the sale is open and no contract is signed: the price goes from $2,500 to $2,800 and a 3% fee goes from $75 to $84. Once a contract is signed it stays put; you can still change it by hand. Changing a rule never changes a sale already made, and sales made before you set this up never get one by themselves.'],
      ['Non-refundable', 'Untick Refundable on a rule and invoices and receipts print "(non-refundable)" beside that fee. Say the same in your contract.'],
      ['Don\'t waive it for cash', 'A service fee waived for cash or Zelle is a surcharge in substance. To reward bank or cash payers, give a discount off the full total instead, open to every family: "$2,575 · Save $75 paying by bank or cash".']
    ]
  },
  in_price: {
    title: 'Payment-fee prices',
    body: [
      ['What they are', 'The cost goes into the price itself: families see "$2,575", one price. Your records still know $75 of it is the increase, so a discount can take back exactly that later, and your sale page shows "includes $75 to cover payment fees" (only you see it).'],
      ['Why it works everywhere', 'Every buyer pays the same price, whatever they pay with, so it\'s not a surcharge. It\'s the simplest way to meet the "show the total price" laws: the price is the total.'],
      ['Percent or amount', 'A percent follows each price by itself: 3% makes a $2,500 puppy $2,575 and a $2,800 one $2,884. A dollar amount adds the same to every sale.'],
      ['By kind of charge', 'Each kind has its own rule: the puppy price, extras, transport, boarding, stud fees. Each is raised when that charge is added, so every invoice matches what\'s due. Never the application fee.'],
      ['On the deposit', 'The deposit is raised by its share of the puppy increase, by size: 3% on a $2,500 puppy is $75, so a $500 deposit becomes $515 and the rest of the price carries $60. The price is still $2,575.'],
      ['When it\'s fixed', 'On a sale the increase follows its charge while the sale is open and no contract is signed, then stays put; you can change it by hand. A rule change never changes a sale already made.'],
      ['Service fees or prices, not both', 'You pick one way. With service fees on, nothing raises a price for payment costs a second time. Switching later changes only new sales.']
    ]
  },
  discounts: {
    title: 'Discounts',
    body: [
      ['Why a discount', 'Rewarding families who pay the cheap way (bank, Zelle, cash) is allowed everywhere card rules apply, as a discount off the full price that every family can choose. Waiving a service fee for cash is a surcharge in substance; a discount is not.'],
      ['Payment-method discount', 'Tick Discounted payment method on the accounts it covers (How families pay). By default it takes back exactly your payment costs on what each payment covers: a $2,575 final payment that carries a $75 service fee is $2,500 by Zelle, "Save $75". Or set a percent or a dollar amount off each payment instead.'],
      ['Open to every family', 'Keep at least one discounted method open to every family. Turning off every discounted method for one family warns you.'],
      ['Your own discounts', 'Repeat buyer, a referral reward, anything you name: a percent of the full total or a dollar amount. Add one on a sale from your list; you can change the amount for that sale. They come off the final payment. A repeat buyer one suggests itself when the buyer has bought from you before, and you confirm it.'],
      ['Each off the full total', 'Every discount comes off the full amount, never off another: a $200 repeat-buyer discount and a $75 payment-method discount save $275. Each is its own line on invoices and receipts.'],
      ['In your books', 'Income shows each discount as its own line, so what you earned is what you received.'],
      ['Wording', 'Call it a discount or a saving ("Save $75 paying by bank or cash"), never "service fee waived".']
    ]
  },
  calculator: {
    title: 'Working out your percent',
    body: [
      ['Which methods', 'Ticked from How families pay for that kind of charge. Untick any you rarely see.'],
      ['My usual mix', 'Each method\'s share of the money you received through it in the last 12 months, from the account on each payment. With no history, type the shares you expect. Example: half Zelle (free) and half card at 3% costs about 1.5%; 1.6% covers it.'],
      ['The costliest method', 'The highest rate on the list, so no family\'s choice leaves you short. Example: card at 2.9% + $0.30, three payments on a $2,500 puppy costs 2.94%; 3.1% covers it ($77.50).'],
      ['Other costs', 'Moving money out of PayPal or Venmo instantly costs 1.75% (a standard transfer is free). Put the share you move out instantly, and any fixed cost you have per sale.'],
      ['Fee on the fee', 'Processors take their percent of the increase too, so the percent is worked out on the whole total: (cost) ÷ (1 − rate), rounded up to a tenth.']
    ]
  }
};

export function openAbout(topic) {
  const a = ABOUT[topic];
  if (!a) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true" style="max-width:640px;">
      <h2 style="margin-top:0;">${esc(a.title)}</h2>
      <p class="muted" style="font-size:13px;">${esc(ABOUT_NOTE)}</p>
      ${a.body.map(([h, t]) => `<h3 style="font-size:14px; margin:12px 0 4px;">${esc(h)}</h3><p style="margin:0;">${esc(t)}</p>`).join('')}
      <div class="form-actions"><button class="btn btn-primary" data-act="about-close">Close</button></div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('[data-act="about-close"]').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}

export const aboutLink = (topic, words) => `<a href="#" data-about="${esc(topic)}">${esc(words)}</a>`;
export function wireAboutLinks(root) {
  root.addEventListener('click', (e) => {
    const a = e.target.closest('[data-about]');
    if (!a) return;
    e.preventDefault();
    openAbout(a.dataset.about);
  });
}

// --- The Settings card --------------------------------------------------------------

// What the calculator starts from: typical charge per kind, payments per sale, and
// each account's share of the last 12 months' money.
function calcContext({ kennel, accounts, sales, litters, studs }) {
  const prices = litters.flatMap((l) => [l.expected_price_male, l.expected_price_female]).map(num).filter((v) => v > 0);
  const salePrices = sales.map((s) => num(s.price)).filter((v) => v > 0);
  const typical = {
    puppy: avg(prices.length ? prices : salePrices),
    extras: avg(sales.flatMap((s) => (Array.isArray(s.extra_charges) ? s.extra_charges : []).map((x) => num(x?.amount))).filter((v) => v > 0)),
    transport: avg(sales.map((s) => num(s.transport_fee)).filter((v) => v > 0)),
    boarding: avg(sales.map((s) => num(s.deferred_boarding_amount)).filter((v) => v > 0)),
    stud: avg(studs.map((s) => num(s.fee_amount)).filter((v) => v > 0))
  };
  const saved = savedSchedules(kennel);
  // The deposit, plus each saved schedule's due dates (else one balance).
  const payments = Math.max(2, Math.round(1 + (saved.length ? avg(saved.map((x) => x.steps.length)) : 1)));
  const received = receivedByAccount(sales, addDaysToYMD(todayYMD(), -365));
  return { typical, payments, received, accounts: accounts.filter((a) => !a.is_archived && a.account_type === 'payment_service') };
}

function calcHtml(kind, kennel, ctx) {
  const stages = CALC_STAGES[kind];
  const listed = stages ? new Set(stages.flatMap((st) => stageIds(kennel, st) || [])) : null;
  const total = [...ctx.received.values()].reduce((t, v) => t + v, 0);
  const rows = ctx.accounts.map((a) => {
    const on = !listed || !listed.size || listed.has(a.id);
    const share = total > 0 ? Math.round((ctx.received.get(a.id) || 0) / total * 100) : '';
    const rate = `${num(a.fee_percent)}%${num(a.fee_fixed) ? ` + ${money(a.fee_fixed)}` : ''}`;
    return `<div class="cc-m" data-pct="${num(a.fee_percent)}" data-fixed="${num(a.fee_fixed)}" style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        <label class="check-inline" style="flex:1; min-width:140px;"><input type="checkbox" class="cc-m-on"${on ? ' checked' : ''}> ${esc(methodLabel(a))} <span class="faint">${esc(rate)}</span></label>
        <label class="faint" style="font-size:13px;">Share <input class="cc-m-share" type="number" min="0" max="100" step="1" value="${share}" style="width:64px;">%</label>
      </div>`;
  }).join('');
  return `<div class="cc-calc" data-kind="${kind}" hidden style="margin:6px 0 10px; padding:10px; border:1px solid var(--border); border-radius:8px;">
      <p class="field-hint" style="margin-top:0;">${aboutLink('calculator', 'How this works')}</p>
      ${rows || '<p class="field-hint">Add your Payment service accounts, with their rates, on the Accounts page.</p>'}
      <div style="display:flex; gap:4px 14px; flex-wrap:wrap; margin-top:6px;">
        <label class="check-inline"><input type="radio" name="cc-mode-${kind}" value="mix" checked> My usual mix</label>
        <label class="check-inline"><input type="radio" name="cc-mode-${kind}" value="costliest"> The costliest method I take</label>
      </div>
      <div style="display:flex; gap:8px 14px; flex-wrap:wrap; margin-top:6px; font-size:13px;">
        <label>Moved out instantly <input class="cc-inst-share" type="number" min="0" max="100" step="1" value="0" style="width:60px;">% at <input class="cc-inst-rate" type="number" min="0" max="10" step="0.01" value="1.75" style="width:64px;">%</label>
        <label>Fixed cost per sale $<input class="cc-per-sale" type="number" min="0" step="0.01" value="" style="width:80px;"></label>
        <label>Typical ${esc(COVER_KIND_LABELS[kind].toLowerCase())} $<input class="cc-price" type="number" min="0" step="1" value="${Math.round(ctx.typical[kind]) || ''}" style="width:90px;"></label>
        <label>Payments per sale <input class="cc-pays" type="number" min="1" max="12" step="1" value="${kind === 'stud' ? 1 : ctx.payments}" style="width:56px;"></label>
      </div>
      <p class="cc-result" style="margin:8px 0 4px;"></p>
      <button type="button" class="btn btn-sm" data-act="cc-use" hidden>Use</button>
    </div>`;
}

function readCalc(box) {
  const methods = [...box.querySelectorAll('.cc-m')].filter((m) => m.querySelector('.cc-m-on').checked)
    .map((m) => ({ percent: num(m.dataset.pct), fixed: num(m.dataset.fixed), share: num(m.querySelector('.cc-m-share').value) }));
  return workItOut({
    methods,
    mode: box.querySelector('input[type="radio"]:checked')?.value || 'mix',
    instant: { share: box.querySelector('.cc-inst-share').value, percent: box.querySelector('.cc-inst-rate').value },
    perSale: box.querySelector('.cc-per-sale').value,
    price: box.querySelector('.cc-price').value,
    payments: box.querySelector('.cc-pays').value
  });
}

function ruleRowHtml(kind, rule, show, kennel, ctx) {
  const how = rule?.amount ? 'amount' : 'percent';
  const value = rule ? (rule.percent ?? rule.amount) : '';
  return `<div class="cc-rule" data-kind="${kind}" style="border-top:1px solid var(--border); padding:8px 0;">
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        <strong style="flex:1; min-width:110px;">${esc(COVER_KIND_LABELS[kind])}</strong>
        <select class="cc-how" aria-label="${esc(COVER_KIND_LABELS[kind])}: percent or amount">
          <option value="percent"${how === 'percent' ? ' selected' : ''}>%</option>
          <option value="amount"${how === 'amount' ? ' selected' : ''}>$</option>
        </select>
        <input class="cc-value" type="number" min="0" step="0.01" value="${esc(value)}" placeholder="None" aria-label="${esc(COVER_KIND_LABELS[kind])}" style="width:90px;">
        <label class="check-inline cc-refund-wrap"${show === 'service_fee' ? '' : ' hidden'}><input type="checkbox" class="cc-refund"${rule?.refundable === false ? '' : ' checked'}> Refundable</label>
        <button type="button" class="btn btn-sm" data-act="cc-calc">Work it out</button>
      </div>
      ${calcHtml(kind, kennel, ctx)}
    </div>`;
}

// The card's HTML; mount it with wireCostCoverCard after it's in the page.
export function costCoverCardHtml(kennel, data) {
  const ctx = calcContext({ kennel, ...data });
  const { show, rules } = coverRules(kennel);
  const opt = (v, words, about) => `<label class="check-inline"><input type="radio" name="cc-show" value="${v}"${(show || '') === v ? ' checked' : ''}> ${words}</label>${about ? ` <span class="field-hint">${aboutLink(about, 'Read about')}</span>` : ''}`;
  return `
    <section class="card" data-ks="cost-cover">
      <h2 style="margin-top:0;">Covering payment costs</h2>
      <p class="field-hint">Get back what card and app fees cost you, on every sale. Every buyer pays the same, whatever they pay with.</p>
      <div style="display:flex; flex-direction:column; gap:4px; margin:8px 0;">
        ${opt('', 'Neither', '')}
        <div>${opt('service_fee', '<span><strong>Service fees</strong>, their own line inside the total</span>', 'service_fees')}</div>
        <div>${opt('in_price', '<span><strong>Payment-fee prices</strong>, in the price itself</span>', 'in_price')}</div>
      </div>
      <div class="cc-rules"${show ? '' : ' hidden'}>
        <p class="field-hint" style="margin:8px 0 0;">Each kind of charge gets its own, added when that charge is. Up to ${PERCENT_MAX}%; blank = nothing added. A litter can have its own puppy rule.</p>
        ${COVER_KINDS.map((k) => ruleRowHtml(k, rules[k], show, kennel, ctx)).join('')}
      </div>
      <div class="form-actions"><button class="btn btn-primary btn-sm" data-act="save-cost-cover">Save</button></div>
    </section>`;
}

// Wire the card. onSaved(kennel) after a save; onError(message).
export function wireCostCoverCard(card, { kennel, onSaved, onError }) {
  if (!card) return;
  wireAboutLinks(card);
  const refresh = (box) => {
    const r = readCalc(box);
    const out = box.querySelector('.cc-result');
    const use = box.querySelector('[data-act="cc-use"]');
    if (!r) { out.textContent = 'Tick a method and give a typical amount.'; use.hidden = true; return; }
    out.innerHTML = `Getting paid costs you about ${r.cost}%. <strong>${r.percent}%</strong> covers it: ${esc(money(r.onPrice))} on ${esc(money(r.price))}.`;
    use.textContent = `Use ${r.percent}%`;
    use.dataset.percent = String(r.percent);
    use.hidden = false;
  };
  card.addEventListener('change', (e) => {
    if (e.target.name === 'cc-show') {
      const v = e.target.value;
      card.querySelector('.cc-rules').hidden = !v;
      card.querySelectorAll('.cc-refund-wrap').forEach((w) => { w.hidden = v !== 'service_fee'; });
    }
    const box = e.target.closest('.cc-calc');
    if (box) refresh(box);
  });
  card.addEventListener('input', (e) => { const box = e.target.closest('.cc-calc'); if (box) refresh(box); });
  card.addEventListener('click', async (e) => {
    const row = e.target.closest('.cc-rule');
    if (e.target.closest('[data-act="cc-calc"]') && row) {
      const box = row.querySelector('.cc-calc');
      box.hidden = !box.hidden;
      if (!box.hidden) refresh(box);
    }
    const use = e.target.closest('[data-act="cc-use"]');
    if (use && row) {
      row.querySelector('.cc-how').value = 'percent';
      row.querySelector('.cc-value').value = use.dataset.percent;
      row.querySelector('.cc-calc').hidden = true;
    }
    if (e.target.closest('[data-act="save-cost-cover"]')) {
      const show = card.querySelector('input[name="cc-show"]:checked')?.value || '';
      const rows = [...card.querySelectorAll('.cc-rule')].map((el) => ({
        applies_to: el.dataset.kind, how: el.querySelector('.cc-how').value, value: el.querySelector('.cc-value').value,
        refundable: el.querySelector('.cc-refund').checked
      }));
      const { cost_cover, error } = readCostCover(show, rows);
      if (error) { onError(error); return; }
      try {
        await kennelRepo.update(kennel.id, { cost_cover });
        onSaved();
      } catch (err) { onError(err.message || String(err)); }
    }
  });
}

// --- Discounts (§5.4) ------------------------------------------------------------------

function discountRowHtml(r = {}, kind = r.kind || 'own') {
  const how = kind === 'method' && r.takes_back !== false ? 'takes_back' : r.amount ? 'amount' : 'percent';
  const value = r.percent ?? r.amount ?? '';
  return `<div class="dc-row" data-kind="${kind}" data-id="${esc(r.id || '')}" style="border-top:1px solid var(--border); padding:8px 0; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
      <input class="dc-label" type="text" maxlength="${DISCOUNT_LABEL_MAX}" value="${esc(r.label || '')}" placeholder="${kind === 'method' ? 'e.g. Bank or cash discount' : 'e.g. Welcome back'}" aria-label="What families see" style="flex:1; min-width:160px;">
      <select class="dc-how" aria-label="How much">
        ${kind === 'method' ? `<option value="takes_back"${how === 'takes_back' ? ' selected' : ''}>My payment costs back</option>` : ''}
        <option value="percent"${how === 'percent' ? ' selected' : ''}>%</option>
        <option value="amount"${how === 'amount' ? ' selected' : ''}>$</option>
      </select>
      <input class="dc-value" type="number" min="0" step="0.01" value="${esc(value)}"${how === 'takes_back' ? ' hidden' : ''} aria-label="Amount" style="width:90px;">
      ${kind === 'own' ? `<label class="check-inline"><input type="checkbox" class="dc-repeat"${r.suggest === 'repeat_buyer' ? ' checked' : ''}> Suggest for repeat buyers</label>` : ''}
      <button type="button" class="btn btn-sm" data-act="dc-remove" aria-label="Remove">✕</button>
    </div>`;
}

// The Discounts card's HTML (beside Covering payment costs).
export function discountsCardHtml(kennel) {
  const rows = kennelDiscounts(kennel);
  const method = rows.find((r) => r.kind === 'method');
  return `
    <section class="card" data-ks="discounts">
      <h2 style="margin-top:0;">Discounts</h2>
      <p class="field-hint">Win the families who pay the cheap way, and bring buyers back. ${aboutLink('discounts', 'Read about discounts')}</p>
      <h3 style="font-size:15px; margin:12px 0 0;">Paying by a discounted method</h3>
      <p class="field-hint" style="margin:2px 0 0;">For the accounts ticked Discounted under How families pay. Families see it beside those choices.</p>
      <div id="dc-method">${method ? discountRowHtml(method, 'method') : ''}</div>
      ${method ? '' : '<button type="button" class="btn btn-sm" data-act="dc-add-method" style="margin-top:6px;">+ Add a payment-method discount</button>'}
      <h3 style="font-size:15px; margin:14px 0 0;">Your own</h3>
      <p class="field-hint" style="margin:2px 0 0;">Added on a sale (Payments › Add a discount), off the final payment. Up to ${DISCOUNT_PERCENT_MAX}%.</p>
      <div id="dc-own">${rows.filter((r) => r.kind === 'own').map((r) => discountRowHtml(r, 'own')).join('')}</div>
      <button type="button" class="btn btn-sm" data-act="dc-add-own" style="margin-top:6px;">+ Add a discount</button>
      <div class="form-actions"><button class="btn btn-primary btn-sm" data-act="save-discounts">Save</button></div>
    </section>`;
}

export function wireDiscountsCard(card, { kennel, onSaved, onError }) {
  if (!card) return;
  wireAboutLinks(card);
  card.addEventListener('change', (e) => {
    if (!e.target.classList.contains('dc-how')) return;
    const row = e.target.closest('.dc-row');
    row.querySelector('.dc-value').hidden = e.target.value === 'takes_back';
  });
  card.addEventListener('click', async (e) => {
    if (e.target.closest('[data-act="dc-remove"]')) {
      const row = e.target.closest('.dc-row');
      if (row.dataset.kind === 'method') card.querySelector('#dc-method').insertAdjacentHTML('afterend', '<button type="button" class="btn btn-sm" data-act="dc-add-method" style="margin-top:6px;">+ Add a payment-method discount</button>');
      row.remove();
    }
    const addMethod = e.target.closest('[data-act="dc-add-method"]');
    if (addMethod) { card.querySelector('#dc-method').innerHTML = discountRowHtml({ ...METHOD_DISCOUNT_DEFAULT }, 'method'); addMethod.remove(); }
    if (e.target.closest('[data-act="dc-add-own"]')) {
      card.querySelector('#dc-own').insertAdjacentHTML('beforeend', discountRowHtml({}, 'own'));
      card.querySelector('#dc-own').lastElementChild.querySelector('.dc-label').focus();
    }
    if (e.target.closest('[data-act="save-discounts"]')) {
      const rows = [...card.querySelectorAll('.dc-row')].map((el) => ({
        id: el.dataset.id || undefined, kind: el.dataset.kind, label: el.querySelector('.dc-label').value,
        how: el.querySelector('.dc-how').value, value: el.querySelector('.dc-value').value,
        suggest: el.querySelector('.dc-repeat')?.checked ? 'repeat_buyer' : undefined
      }));
      const { discounts, error } = readDiscounts(rows);
      if (error) { onError(error); return; }
      try {
        await kennelRepo.update(kennel.id, { discounts });
        onSaved();
      } catch (err) { onError(err.message || String(err)); }
    }
  });
}

// --- On a sale or stud service (§5.2) -------------------------------------------------

// Change one record's amounts: each kind's amount as charged now, with whether it
// follows its charge. An amount left as it was keeps following; one she changes is
// fixed (costCover.withHandAmount). `start` is the stored value to begin from when the
// record has none (handCoverStart). → the new cost_cover_amounts, or null (cancelled).
export function openCoverDialog({ record, kinds, cover, start = null, kennelShow = null }) {
  return new Promise((resolve) => {
    const stored = record.cost_cover_amounts || start || {};
    const show = cover?.show || stored.show || kennelShow || 'service_fee';
    const rowHtml = (k) => {
      const amount = cover ? cover[k] : 0;
      const follows = cover?.following?.[k];
      return `<div class="field"><label for="ccd-${k}">${esc(COVER_KIND_LABELS[k])}</label>
          <input id="ccd-${k}" data-kind="${k}" data-was="${amount || ''}" type="number" min="0" step="0.01" value="${amount || ''}" placeholder="None">
          ${follows ? `<span class="field-hint">${esc(`${follows}%: follows the charge until a contract is signed. Type an amount to fix it.`)}</span>` : ''}</div>`;
    };
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
        <h2 style="margin-top:0;">Payment costs</h2>
        <div class="field"><label for="ccd-show">Shown as</label><select id="ccd-show">
          <option value="service_fee"${show === 'service_fee' ? ' selected' : ''}>Service fees (their own line)</option>
          <option value="in_price"${show === 'in_price' ? ' selected' : ''}>In the price</option></select></div>
        ${kinds.map(rowHtml).join('')}
        <p class="field-hint">${aboutLink('service_fees', 'Read about service fees')} · ${aboutLink('in_price', 'Read about payment-fee prices')}</p>
        <div class="form-actions"><button class="btn btn-primary" data-act="ccd-save">Save</button><button class="btn" data-act="ccd-cancel">Cancel</button></div>
      </div>`;
    document.body.appendChild(overlay);
    wireAboutLinks(overlay);
    const done = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelector('[data-act="ccd-cancel"]').addEventListener('click', () => done(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
    overlay.querySelector('[data-act="ccd-save"]').addEventListener('click', () => {
      let next = { ...stored, show: overlay.querySelector('#ccd-show').value };
      for (const input of overlay.querySelectorAll('input[data-kind]')) {
        if (input.value === input.dataset.was) continue;
        next = withHandAmount(next, input.dataset.kind, input.value);
      }
      done(next);
    });
  });
}
