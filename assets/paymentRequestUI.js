// paymentRequestUI.js — "Send payment link" on a Sale and its Invoice
// (Integrations plan §4). She picks what the payment is for (the unpaid deposit,
// the rest, or both) and the Payment service account the buyer pays via (the
// account that part of the sale is already paid via first), then the message
// opens in the composer (Email / Text / Copy) with the amount, the link and the
// account's instructions.
// The account becomes that part's "paid via" (deposit_paid_via_account_id /
// balance_paid_via_account_id) when none is set; a different one asks first. The
// fee estimate follows (processingFees.saleFeeEstimate), only while the sale's
// fee is still at the old estimate: a fee she typed stays.
// With her Stripe key for that account on this device (step 6) she can send a
// one-time Stripe link for exactly that amount (stripeLinks.makeSaleLink): kept
// on the sale, and her device marks the payment received, with Stripe's fee, when
// Stripe says so. Otherwise she records the payment herself, as today.
// Pro-only (proPages.PRO_ONLY_STANDALONE): the Sale page imports it only when
// editionFlags.accounts is on, and the Invoice page is Pro.
import { saleRepo } from '../data/saleRepo.js';
import { accountRepo } from '../data/accountRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { incomeLineItems, getSaleFeeCredit } from '../data/incomeView.js';
import { saleFeeEstimate } from '../data/processingFees.js';
import { splitName } from '../data/contractForms.js';
import { paymentAccounts, salePaidVia, paidViaField, paymentOptions, paymentLink, paymentRequestMessage } from '../data/paymentLinks.js';
import { esc, fmtDate, fmtMoney, confirmModal } from './ui.js';
import { openComposer } from './messageComposer.js';
import { stripeConnection, makeSaleLink } from '../data/stripeLinks.js';

// The sale's changes when `part` is paid via `account`: the paid-via field(s), and
// the fee estimate when the fee is still at the old one. → changes or null.
export function paidViaChanges(sale, account, part, accountsById) {
  const fields = part === 'all' ? ['deposit_paid_via_account_id', 'balance_paid_via_account_id'] : [paidViaField(part)];
  const out = {};
  for (const f of fields) if (sale[f] !== account.id) out[f] = account.id;
  if (!Object.keys(out).length) return null;
  const before = saleFeeEstimate(sale, accountsById)?.total ?? null;
  const after = saleFeeEstimate({ ...sale, ...out }, accountsById)?.total ?? null;
  const fee = sale.processing_fee_amount;
  const untouched = fee == null || fee === '' || (before != null && Number(fee) === before);
  if (untouched && after !== before) out.processing_fee_amount = after;
  return out;
}

function noAccountsModal() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true" style="max-width:520px;">
      <h2 style="margin-top:0;">Add your payment service</h2>
      <p>Add the service buyers pay you through (Stripe, Square, PayPal, Venmo…) on the Accounts page as a <strong>Payment service</strong> account, with your payment link or instructions (Zelle, check…), or connect Stripe for one-time links. Then send it from here.</p>
      <div class="form-actions"><a class="btn btn-primary" href="accounts.html">Go to Accounts</a><button class="btn" id="pr-close">Close</button></div>
    </div>`;
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); resolve(false); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#pr-close').addEventListener('click', close);
  });
}

// Pick what for and the account. → Promise<{ account, option, stripe } | null>.
function chooseModal({ title, accounts, options, defaultFor, stripeIds }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const radio = (name, value, checked, label) => `<label class="check-inline" style="display:flex; gap:8px; align-items:center; padding:4px 0;">
      <input type="radio" name="${name}" value="${esc(value)}"${checked ? ' checked' : ''}> <span>${label}</span></label>`;
    const first = options[0]?.key || 'all';
    overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true" style="max-width:560px;">
      <h2 style="margin-top:0;">${esc(title)}</h2>
      <h3 style="font-size:15px; margin:4px 0;">For</h3>
      ${options.length
        ? options.map((o, i) => radio('pr-what', o.key, i === 0, `${esc(o.label)} <strong>${esc(fmtMoney(o.amount))}</strong>`)).join('')
        : '<p class="muted" style="margin:0;">Nothing is owed on this sale. The message leaves the amount out; add it yourself.</p>'}
      <h3 style="font-size:15px; margin:10px 0 4px;">Paid via</h3>
      ${accounts.map((a, i) => radio('pr-acct', a.id, defaultFor(first) ? a.id === defaultFor(first) : i === 0,
        `${esc(a.name)} <span class="muted">${esc(stripeIds.has(a.id) ? 'one-time Stripe links' : paymentLink(a.payment_link) ? 'payment link' : 'instructions')}</span>`)).join('')}
      <p class="field-hint" id="pr-via-hint"></p>
      <label class="check-inline" id="pr-stripe-row" style="display:flex; gap:8px; align-items:flex-start; margin-top:10px;">
        <input type="checkbox" id="pr-stripe" checked> <span>Make a one-time Stripe link for exactly this amount. KennelOS marks the payment received, with Stripe's fee, when they pay.</span></label>
      <div class="form-actions">
        <button class="btn btn-primary" id="pr-next">Write the message</button>
        <button class="btn" id="pr-cancel">Cancel</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    const done = (v) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    function onKey(e) { if (e.key === 'Escape') done(null); }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
    overlay.querySelector('#pr-cancel').addEventListener('click', () => done(null));
    const what = () => overlay.querySelector('input[name="pr-what"]:checked')?.value || 'all';
    const acct = () => overlay.querySelector('input[name="pr-acct"]:checked')?.value;
    let touched = false;
    const refresh = () => {
      overlay.querySelector('#pr-stripe-row').hidden = !(stripeIds.has(acct()) && options.length);
      const set = defaultFor(what());
      overlay.querySelector('#pr-via-hint').textContent = set
        ? (set === acct() ? 'This is the account that part of the sale is paid via.' : 'This part of the sale is paid via another account: picking this one asks before changing it.')
        : 'The account you pick becomes what this part of the sale is paid via, and its processing fee is estimated.';
    };
    overlay.addEventListener('change', (e) => {
      if (e.target.name === 'pr-acct') touched = true;
      if (e.target.name === 'pr-what' && !touched) {
        const d = defaultFor(what());
        const r = d && overlay.querySelector(`input[name="pr-acct"][value="${CSS.escape(d)}"]`);
        if (r) r.checked = true;
      }
      refresh();
    });
    refresh();
    overlay.querySelector('#pr-next').addEventListener('click', () => {
      const account = accounts.find((a) => a.id === acct());
      if (!account) return;
      const stripe = !overlay.querySelector('#pr-stripe-row').hidden && overlay.querySelector('#pr-stripe').checked;
      done({ account, option: options.find((o) => o.key === what()) || null, stripe });
    });
  });
}

// → Promise<boolean>: true when the sale changed (a paid-via account, the fee, a link).
export async function openPaymentRequest({ saleId }) {
  let sale = await saleRepo.getById(saleId);
  if (!sale) throw new Error('This sale no longer exists.');
  const all = await accountRepo.getAll({ includeArchived: true });
  const accountsById = new Map(all.map((a) => [a.id, a]));
  const own = new Set([sale.deposit_paid_via_account_id, sale.balance_paid_via_account_id].filter(Boolean));
  // Payment services with a link or instructions, or her Stripe key on this device;
  // plus the sale's own paid-via accounts, archived or not.
  const stripeIds = new Set();
  for (const a of all) {
    if (a.account_type === 'payment_service' && (!a.is_archived || own.has(a.id)) && await stripeConnection(a.id)) stripeIds.add(a.id);
  }
  const accounts = paymentAccounts(all);
  for (const a of all) if ((stripeIds.has(a.id) || own.has(a.id)) && !accounts.some((x) => x.id === a.id)) accounts.push(a);
  if (!accounts.length) return noAccountsModal();

  const [dog, buyer, kennel, feeCredit] = await Promise.all([
    sale.dog_id ? dogRepo.getById(sale.dog_id) : null,
    sale.buyer_contact_id ? contactRepo.getById(sale.buyer_contact_id) : null,
    sale.kennel_id ? kennelRepo.getById(sale.kennel_id) : null,
    getSaleFeeCredit(sale.id)
  ]);
  const options = paymentOptions(incomeLineItems('sale', sale, { feeCredit }));
  const pupName = dog?.call_name || dog?.registered_name || '';
  const picked = await chooseModal({
    title: `Send payment link${pupName ? `: ${pupName}` : ''}`,
    accounts, options, stripeIds,
    defaultFor: (part) => salePaidVia(sale, all, part)?.id || null
  });
  if (!picked) return false;
  const { option } = picked;
  const part = option?.key || 'all';
  let { account } = picked;

  let changed = false;
  let isPaidVia = true;
  const changes = paidViaChanges(sale, account, part, accountsById);
  if (changes) {
    const current = salePaidVia(sale, all, part);
    const ok = !current || await confirmModal({
      title: `Paid via ${account.name}?`,
      message: `This part of the sale is paid via ${current.name}. Change it to ${account.name}, so its processing fee follows the account the buyer pays through?`,
      confirmLabel: 'Change it', cancelLabel: `Keep ${current.name}`
    });
    if (ok) { sale = await saleRepo.update(sale.id, changes); changed = true; } else isPaidVia = false;
  }

  let hint = 'When they pay, record it on the sale (Deposit received, or the balance paid date) as usual.';
  if (picked.stripe && option) {
    if (!isPaidVia) {
      hint = 'No Stripe link: a one-time link is checked with the key of the account that part is paid via, which you kept.';
    } else {
      const linkPart = part === 'deposit' ? 'deposit' : 'balance';
      // The open link for this same payment is sent again, not replaced.
      const reuse = sale.payment_link_ref && sale.payment_link_component === linkPart && Number(sale.payment_link_amount) === option.amount;
      if (!reuse) sale = await makeSaleLink({ sale, account, component: part, amount: option.amount, pupName });
      account = { ...account, payment_link: sale.payment_link_url };
      changed = true;
      hint = 'A one-time Stripe link for exactly this amount. When they pay, KennelOS marks it received (it checks Stripe when you open the app).';
    }
  }

  const due = option && option.key !== 'deposit' && sale.balance_due_date ? fmtDate(sale.balance_due_date) : '';
  const msg = paymentRequestMessage({
    who: buyer ? splitName(buyer.name)[0] : '',
    pupName: dog?.call_name || '',
    what: part,
    amount: option ? fmtMoney(option.amount) : '',
    due,
    account,
    kennelName: kennel?.kennel_name || ''
  });
  await openComposer({
    title: 'Send payment link',
    name: buyer?.name || '', email: buyer?.email || '', phone: buyer?.phone || '',
    subject: msg.subject, body: msg.body, hint
  });
  return changed;
}
