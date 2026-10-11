// paymentLinks.js — her own payment link (Integrations plan §4, Level 0): a
// Stripe / Square / PayPal / Venmo link, or plain instructions (Zelle…), kept on
// the Account she takes payments through (`payment_link`, `payment_instructions`).
// "Send payment link" on a Sale or its Invoice starts from the sale's own
// Sold / paid through account (`sales_channel_account_id`), so the link she sends
// and the fee the sale carries name the same account; with none set, she picks
// one and it fills the empty channel. Nothing goes to a server and nothing about
// the sale is sent anywhere but in the message she sends herself; she still
// records the payment (Deposit received…) as today. Pure.
import { formLink } from './contractForms.js';

const text = (v) => String(v ?? '').trim();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const cents = (n) => Math.round(n * 100) / 100;

// A payment link as stored: a web address, else '' (same check as a contract form's link).
export const paymentLink = (raw) => formLink(raw);

// Whether an account can take a payment: a link or instructions.
export const takesPayments = (a) => !!a && (!!paymentLink(a.payment_link) || !!text(a.payment_instructions));

// The accounts she can send a payment link for: not archived, with a link or
// instructions, by name.
export function paymentAccounts(accounts = []) {
  return accounts
    .filter((a) => a && !a.is_archived && takesPayments(a))
    .sort((a, b) => text(a.name).localeCompare(text(b.name)));
}

// The account a sale's payment link comes from first: its Sold / paid through
// account when that one takes payments (archived or not: it's the sale's own),
// else null and she picks.
export function saleChannelPayAccount(sale, accounts = []) {
  const id = sale?.sales_channel_account_id;
  const a = id ? accounts.find((x) => x && x.id === id) : null;
  return takesPayments(a) ? a : null;
}

// What she can ask for, from the sale's invoice lines (incomeView.incomeLineItems):
// the unpaid deposit, the unpaid rest (balance, transport, boarding), or both.
// → [{ key: 'deposit' | 'balance' | 'all', label, amount }], first = the default.
export function paymentOptions(items = []) {
  const owed = items.filter((x) => x && x.state === 'anticipated' && num(x.amount) > 0);
  const deposit = cents(owed.filter((x) => x.component === 'deposit').reduce((t, x) => t + num(x.amount), 0));
  const rest = cents(owed.filter((x) => x.component !== 'deposit').reduce((t, x) => t + num(x.amount), 0));
  const out = [];
  if (deposit > 0) out.push({ key: 'deposit', label: 'Deposit', amount: deposit });
  if (rest > 0) out.push({ key: 'balance', label: deposit > 0 ? 'The rest of the price' : 'Balance', amount: rest });
  if (deposit > 0 && rest > 0) out.push({ key: 'all', label: 'Everything owed', amount: cents(deposit + rest) });
  return out;
}

const WHAT = { deposit: 'deposit', balance: 'balance', all: 'payment' };

// The payment lines of any message: the link, then the account's instructions.
// → string[] (empty when the account has neither).
export function paymentLines(account) {
  const link = paymentLink(account?.payment_link);
  const note = text(account?.payment_instructions);
  if (link) return note ? [`Pay online: ${link}`, note] : [`Pay online: ${link}`];
  return note ? [`How to pay: ${note}`] : [];
}

// → { subject, body }. The caller formats money and dates.
//   who          the buyer's first name
//   pupName      the pup
//   what         'deposit' | 'balance' | 'all'
//   amount       formatted ("$500.00"); due formatted, optional
//   account      the account paid through ({ payment_link, payment_instructions })
//   kennelName   signs it
export function paymentRequestMessage(p = {}) {
  const who = text(p.who);
  const pup = text(p.pupName);
  const what = WHAT[p.what] || 'payment';
  const amount = text(p.amount);
  const due = text(p.due);
  const lines = [who ? `Hi ${who},` : 'Hi,', ''];
  const forPup = pup ? ` for ${pup}` : '';
  lines.push(amount
    ? `Here's how to pay the ${what} of ${amount}${forPup}${due ? `, due by ${due}` : ''}.`
    : `Here's how to pay the ${what}${forPup}${due ? `, due by ${due}` : ''}.`);
  const pay = paymentLines(p.account);
  if (pay.length) lines.push('', ...pay);
  lines.push('', 'Let me know once it\'s sent, or if you have any questions.', '', 'Thank you!');
  if (text(p.kennelName)) lines.push(text(p.kennelName));
  return { subject: pup ? `${pup}: your ${what}` : `Your puppy: ${what}`, body: lines.join('\n') };
}
