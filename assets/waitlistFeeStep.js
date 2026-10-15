// waitlistFeeStep.js — Kels's application-fee step: the fee, its refund policy,
// days to pay, how families pay you, and (with editionFlags.accounts) the payment
// account it's paid through online: one she has, Stripe (made and connected right
// here, vendorKeyUI.vendorKeyFlow), or another payment service she names, with its
// payment link. Asked by "Set up my waitlist" and "Set up my application form", so
// a fee is set up the same way from either. Saved into Kennel.waitlist_config
// (checked by waitlistRules.waitlistConfigProblem, the Kennel page's check too) and
// `waitlist_fee_account_id`. Pro-only (proPages.js), like both callers.
import { kennelRepo } from '../data/kennelRepo.js';
import { editionFlags } from '../data/editionConfig.js';
import { waitlistConfig, waitlistConfigProblem } from '../data/waitlistRules.js';
import { paymentLink } from '../data/paymentLinks.js';
import { FEE_CREDIT_POLICY } from '../data/vocab.js';
import { field } from './kelsSteps.js';
import { esc, fmtMoney } from './ui.js';

const opt = (value, label, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
const group = (title, inner, hint = '') => `<fieldset class="ws-group"><legend>${esc(title)}</legend>${hint ? `<p class="field-hint">${hint}</p>` : ''}${inner}</fieldset>`;
const numOrNull = (v) => (String(v ?? '').trim() === '' ? null : Number(v));

// The fee as she'd say it: "A $50 fee, paid through Stripe" / "No fee".
export function feeSummary(kennel, accounts = []) {
  const c = waitlistConfig(kennel);
  if (!c.fee_amount) return 'No application fee';
  const account = accounts.find((a) => a.id === kennel.waitlist_fee_account_id);
  return `A ${fmtMoney(c.fee_amount)} application fee${account ? `, paid online through ${account.name}` : ''}`;
}

// → true when she saved it. `resumeTask`: the task's name, for the vendor key flow.
export async function askWaitlistFee(chat, kennel, { resumeTask = '', title = '' } = {}) {
  const c = waitlistConfig(kennel);
  let services = [];
  let accountRepo = null;
  if (editionFlags.accounts) {
    ({ accountRepo } = await import('../data/accountRepo.js'));
    services = (await accountRepo.getAll()).filter((a) => a.account_type === 'payment_service' && !a.is_archived);
  }
  const hasStripe = services.some((a) => /stripe/i.test(a.name || ''));
  const onlinePay = editionFlags.accounts ? group('Paid online (optional)', `
      ${field('Families pay through', `<select id="ws-fee-account">${opt('', '— not online —', !kennel.waitlist_fee_account_id)}${services.map((a) => opt(a.id, a.name || 'Payment account', a.id === kennel.waitlist_fee_account_id)).join('')}${hasStripe ? '' : opt('new-stripe', 'Stripe (I\'ll connect it now)', false)}${opt('new-other', 'Another payment service…', false)}</select>`)}
      <div id="ws-fee-other" hidden>
        ${field('Its name', '<input id="ws-other-name" type="text" placeholder="e.g. Square, PayPal">')}
        ${field('Its payment link (optional)', '<input id="ws-other-link" type="url" inputmode="url" placeholder="https://…">', 'Families get a Pay button that opens it. You mark the fee received yourself.')}
      </div>
      ${field('Ask for the fee', `<select id="ws-fee-when">${opt('apply', 'At the end of the online application', c.fee_link_when !== 'approved')}${opt('approved', 'Once I approve them', c.fee_link_when === 'approved')}</select>`)}`,
    'Families get a Pay button. With Stripe connected, it\'s a card checkout for the exact fee, recorded as received when they pay.') : '';
  const res = await chat.form({
    title: title || '<strong>First, the application fee.</strong><span class="kels-lead">Leave the amount blank if you don\'t charge one.</span>',
    html: `<div class="ck-inline">
        ${field('Application fee', `<input id="ws-fee" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(c.fee_amount ?? '')}" placeholder="No fee">`)}
        ${field('The fee is', `<select id="ws-policy">${FEE_CREDIT_POLICY.map((o) => opt(o.value, o.label, o.value === c.fee_credit_policy)).join('')}</select>`)}
      </div>
      ${field('Days to pay after you approve them', `<input id="ws-fee-days" type="number" min="1" step="1" value="${esc(c.fee_due_days ?? '')}" placeholder="No deadline">`, 'Blank means no pay-by date.')}
      ${field('How families pay you', `<textarea id="ws-instructions" rows="2" placeholder="Venmo @…, Zelle …, or a check to …">${esc(c.payment_instructions || '')}</textarea>`)}
      ${onlinePay}`,
    wire: (root) => {
      root.querySelector('#ws-fee-account')?.addEventListener('change', (e) => {
        root.querySelector('#ws-fee-other').hidden = e.target.value !== 'new-other';
      });
    },
    submitLabel: 'Save the fee',
    cancelLabel: 'Skip this',
    submit: async (root) => {
      const q = (s) => root.querySelector(s);
      const account = q('#ws-fee-account')?.value;
      const changes = {
        fee_amount: numOrNull(q('#ws-fee').value),
        fee_credit_policy: q('#ws-policy').value,
        fee_due_days: numOrNull(q('#ws-fee-days').value),
        payment_instructions: q('#ws-instructions').value.trim(),
        ...(q('#ws-fee-when') ? { fee_link_when: q('#ws-fee-when').value } : {})
      };
      const fresh = await kennelRepo.getById(kennel.id);
      const next = { ...(fresh.waitlist_config || {}), ...changes };
      const problem = waitlistConfigProblem(waitlistConfig({ waitlist_config: next }));
      if (problem) return problem;
      let other = null;
      if (account === 'new-other') {
        const name = q('#ws-other-name').value.trim();
        if (!name) return 'What\'s the payment service called?';
        const typed = q('#ws-other-link').value.trim();
        const link = typed ? paymentLink(typed) : '';
        if (typed && !link) return 'That payment link doesn\'t look like a web address. Copy it from the service and paste it here.';
        other = { name, payment_link: link };
      }
      let accountId = account && !account.startsWith('new-') ? account : null;
      if (account === 'new-stripe') {
        accountId = (await accountRepo.create({ name: 'Stripe', account_type: 'payment_service', website: 'https://dashboard.stripe.com' })).id;
      } else if (other) {
        accountId = (await accountRepo.create({ name: other.name, account_type: 'payment_service', ...(other.payment_link ? { payment_link: other.payment_link } : {}) })).id;
      }
      // A new account is in her reply ("paid online through Square").
      if (accountId && !services.some((a) => a.id === accountId)) services.push(await accountRepo.getById(accountId));
      await kennelRepo.update(kennel.id, { waitlist_config: next, ...(editionFlags.accounts ? { waitlist_fee_account_id: accountId } : {}) });
      Object.assign(kennel, await kennelRepo.getById(kennel.id));
      return { accountId, newStripe: account === 'new-stripe' };
    },
    reply: () => feeSummary(kennel, services)
  });
  if (!res.done) return false;
  await chat.say('Saved. Nice and clear for families.', { typing: 400 });
  if (res.result.accountId) await offerStripe(chat, res.result.accountId, res.result.newStripe, resumeTask);
  return true;
}

// The fee's payment account is Stripe with no key on this device: connect it here.
async function offerStripe(chat, accountId, isNew, resumeTask) {
  const { accountRepo } = await import('../data/accountRepo.js');
  const { getStripeKey } = await import('../data/stripeKeyStore.js');
  const account = await accountRepo.getById(accountId);
  if (!account || (!isNew && !/stripe/i.test(account.name || '')) || await getStripeKey(accountId)) return;
  await chat.say(`Want to connect ${esc(account.name)} now? Then families pay the fee by card, and KennelOS marks it received by itself.`);
  const pick = await chat.choose([{ label: 'Connect Stripe', value: 'yes', primary: true }, { label: 'Later', value: '' }]);
  if (pick !== 'yes') { await chat.say('No problem. Families still see your payment instructions.', { typing: 300 }); return; }
  const { vendorKeyFlow } = await import('./vendorKeyUI.js');
  const a = { id: account.id, name: account.name, username: account.username || '', password: account.password || '', website: account.website || '', currency: 'usd' };
  if (await vendorKeyFlow(chat, a, 'stripe', { resumeTask })) {
    await chat.say('Stripe is connected. Families can pay the fee by card now!');
  }
}
