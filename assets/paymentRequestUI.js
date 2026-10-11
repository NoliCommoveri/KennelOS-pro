// paymentRequestUI.js — "Send payment link" on a Sale and its Invoice
// (Integrations plan §4, Level 0). She picks the account the buyer pays through
// (the sale's Sold / paid through account first, when it has a payment link or
// instructions) and what the payment is for (the unpaid deposit, the rest, or
// both), then the message opens in the composer (Email / Text / Copy) with the
// amount, the link and the account's instructions. Picking an account on a sale
// with no channel fills Sold / paid through with it (and suggests its fee, the
// Sale page's rule); picking a different one than the sale's asks first.
// Nothing is recorded as paid: she still taps Deposit received as today.
// Pro-only (proPages.PRO_ONLY_STANDALONE): the Sale page imports it only when
// editionFlags.accounts is on, and the Invoice page is Pro.
import { saleRepo } from '../data/saleRepo.js';
import { accountRepo } from '../data/accountRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { incomeLineItems, getSaleFeeCredit } from '../data/incomeView.js';
import { feeRate, processingFee } from '../data/processingFees.js';
import { splitName } from '../data/contractForms.js';
import { paymentAccounts, saleChannelPayAccount, paymentOptions, paymentLink, paymentRequestMessage } from '../data/paymentLinks.js';
import { esc, fmtDate, fmtMoney, confirmModal } from './ui.js';
import { openComposer } from './messageComposer.js';

// The sale's fields after paying through `account`: an empty channel takes it,
// with its fee suggested when the fee is empty; a changed channel moves a fee
// still at the old account's suggested amount. → the changes, or null for none.
function channelChanges(sale, account, accountsById) {
  if (sale.sales_channel_account_id === account.id) return null;
  const rate = feeRate(account);
  const fee = sale.processing_fee_amount;
  const old = accountsById.get(sale.sales_channel_account_id);
  const oldSuggested = old ? processingFee(sale.price, feeRate(old)) : null;
  const follows = fee == null || fee === '' || (oldSuggested != null && Number(fee) === oldSuggested);
  const out = { sales_channel_account_id: account.id, fee_passed_to_buyer: !!account.fee_passed_to_buyer_default };
  if (follows) out.processing_fee_amount = rate ? processingFee(sale.price, rate) : null;
  return out;
}

function noAccountsModal() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true" style="max-width:520px;">
      <h2 style="margin-top:0;">Add your payment link</h2>
      <p>Put your own payment link (Stripe, Square, PayPal, Venmo…) or your payment instructions (Zelle, check…) on the account you take payments through, under <strong>Payment link</strong>. Then send it from here.</p>
      <div class="form-actions"><a class="btn btn-primary" href="accounts.html">Go to Accounts</a><button class="btn" id="pr-close">Close</button></div>
    </div>`;
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); resolve(false); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#pr-close').addEventListener('click', close);
  });
}

// Pick the account and what for. → Promise<{ account, option } | null>.
function chooseModal({ title, accounts, defaultId, channelName, channelPays, options }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const radio = (name, value, checked, label) => `<label class="check-inline" style="display:flex; gap:8px; align-items:center; padding:4px 0;">
      <input type="radio" name="${name}" value="${esc(value)}"${checked ? ' checked' : ''}> <span>${label}</span></label>`;
    overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true" style="max-width:560px;">
      <h2 style="margin-top:0;">${esc(title)}</h2>
      <h3 style="font-size:15px; margin:4px 0;">Paid through</h3>
      ${accounts.map((a) => radio('pr-acct', a.id, a.id === defaultId,
        `${esc(a.name)} <span class="muted">${esc(paymentLink(a.payment_link) ? 'payment link' : 'instructions')}</span>`)).join('')}
      <p class="field-hint">${channelName
        ? `This sale is sold / paid through ${esc(channelName)}.${channelPays ? '' : ' It has no payment link: add one on the Accounts page, or pick another account (it asks before changing the sale).'}`
        : 'This sale has no Sold / paid through account yet: the one you pick becomes it, and its processing fee is suggested.'}</p>
      <h3 style="font-size:15px; margin:10px 0 4px;">For</h3>
      ${options.length
        ? options.map((o, i) => radio('pr-what', o.key, i === 0, `${esc(o.label)} <strong>${esc(fmtMoney(o.amount))}</strong>`)).join('')
        : '<p class="muted" style="margin:0;">Nothing is owed on this sale. The message leaves the amount out; add it yourself.</p>'}
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
    overlay.querySelector('#pr-next').addEventListener('click', () => {
      const id = overlay.querySelector('input[name="pr-acct"]:checked')?.value;
      const key = overlay.querySelector('input[name="pr-what"]:checked')?.value;
      const account = accounts.find((a) => a.id === id);
      if (!account) return;
      done({ account, option: options.find((o) => o.key === key) || null });
    });
  });
}

// → Promise<boolean>: true when the sale changed (its channel was filled or changed).
export async function openPaymentRequest({ saleId }) {
  const sale = await saleRepo.getById(saleId);
  if (!sale) throw new Error('This sale no longer exists.');
  const all = await accountRepo.getAll({ includeArchived: true });
  const accountsById = new Map(all.map((a) => [a.id, a]));
  const channel = accountsById.get(sale.sales_channel_account_id) || null;
  const fromChannel = saleChannelPayAccount(sale, all);
  const accounts = paymentAccounts(all);
  if (fromChannel && !accounts.some((a) => a.id === fromChannel.id)) accounts.unshift(fromChannel);
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
    accounts,
    defaultId: fromChannel?.id || accounts[0].id,
    channelName: channel?.name || '', channelPays: !!fromChannel,
    options
  });
  if (!picked) return false;

  let changed = false;
  const changes = channelChanges(sale, picked.account, accountsById);
  if (changes) {
    const ok = !channel || await confirmModal({
      title: `Sold / paid through ${picked.account.name}?`,
      message: `This sale is sold / paid through ${channel.name}. Change it to ${picked.account.name}, so its processing fee follows the account the buyer pays through?`,
      confirmLabel: 'Change it', cancelLabel: `Keep ${channel.name}`
    });
    if (ok) { await saleRepo.update(sale.id, changes); changed = true; }
  }

  const { option, account } = picked;
  const due = option && option.key !== 'deposit' && sale.balance_due_date ? fmtDate(sale.balance_due_date) : '';
  const msg = paymentRequestMessage({
    who: buyer ? splitName(buyer.name)[0] : '',
    pupName: dog?.call_name || '',
    what: option?.key || 'all',
    amount: option ? fmtMoney(option.amount) : '',
    due,
    account,
    kennelName: kennel?.kennel_name || ''
  });
  await openComposer({
    title: 'Send payment link',
    name: buyer?.name || '', email: buyer?.email || '', phone: buyer?.phone || '',
    subject: msg.subject, body: msg.body,
    hint: 'When they pay, record it on the sale (Deposit received, or the balance paid date) as usual.'
  });
  return changed;
}
