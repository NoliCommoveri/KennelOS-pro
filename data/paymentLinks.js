// paymentLinks.js — her own payment link (Integrations plan §4, Level 0): a
// Stripe / Square / PayPal / Venmo link, or plain instructions (Zelle…), kept on
// a Payment service Account (`payment_link`, `payment_instructions`; that type
// only, revised 2026-10-12). A sale's deposit and balance may each be paid via a
// different one (`deposit_paid_via_account_id`, `balance_paid_via_account_id`), so
// "Send payment link" starts from the account that part is paid via, and the fee
// each payment keeps follows its own account (processingFees.saleFeeEstimate).
// Picking an account for a part with none fills it in. Nothing goes to a server and nothing about
// the sale is sent anywhere but in the message she sends herself; she still
// records the payment (Deposit received…) as today. Pure.
import { formLink } from './contractForms.js';

const text = (v) => String(v ?? '').trim();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const cents = (n) => Math.round(n * 100) / 100;

// A payment link as stored: a web address, else '' (same check as a contract form's link).
export const paymentLink = (raw) => formLink(raw);

// Whether an account can take a payment: a Payment service with a link or
// instructions. A link saved on another type stays stored but isn't offered.
export const takesPayments = (a) => !!a && a.account_type === 'payment_service'
  && (!!paymentLink(a.payment_link) || !!text(a.payment_instructions));

// The accounts she can send a payment link for: not archived, with a link or
// instructions, by name.
export function paymentAccounts(accounts = []) {
  return accounts
    .filter((a) => a && !a.is_archived && takesPayments(a))
    .sort((a, b) => text(a.name).localeCompare(text(b.name)));
}

// Which paid-via field holds a payment part ('all' is paid as the balance).
export const paidViaField = (part) => (part === 'deposit' ? 'deposit_paid_via_account_id' : 'balance_paid_via_account_id');

// The account a sale's payment for `part` ('deposit' | 'balance' | 'all') is paid
// via, archived or not (it's the sale's own); for the balance or 'all' with none
// set, the deposit's. Null when none is set. `accounts` is every account.
export function salePaidVia(sale, accounts = [], part = 'deposit') {
  const ids = part === 'deposit' ? [sale?.deposit_paid_via_account_id]
    : [sale?.balance_paid_via_account_id, sale?.deposit_paid_via_account_id];
  for (const id of ids) {
    const a = id ? accounts.find((x) => x && x.id === id) : null;
    if (a) return a;
  }
  return null;
}

// The same, only when it takes payments (a link or instructions to send).
export function salePayAccount(sale, accounts = [], part = 'deposit') {
  const a = salePaidVia(sale, accounts, part);
  return takesPayments(a) ? a : null;
}

// What she can ask for, from the sale's payment statement (paymentSchedule.paymentStatement,
// Payment Schedule plan §7): the deposit still owed, the next payment on the schedule
// (what's still owed by its date), and everything owed, each once (an option that
// would ask for the same amount as one before it is left out).
// → [{ key: 'deposit' | 'next' | 'all', label, amount, due, atPickup, final }], first =
// the default. `due` YYYY-MM-DD or null; `final`: it ends the schedule, so her
// final-payment methods go with it (D9).
export function paymentOptions(statement) {
  const st = statement;
  if (!st || st.ended) return [];
  const out = [];
  const dep = st.deposit && num(st.deposit.owed) > 0 ? st.deposit : null;
  if (dep) out.push({ key: 'deposit', label: 'Deposit', amount: cents(num(dep.owed)), due: dep.date || null, atPickup: false, final: false });
  const step = (st.dueDates || []).find((d) => num(d.owed) > 0);
  if (step) {
    out.push({
      key: 'next', label: step.isFinal ? (st.dueDates.length > 1 ? 'Final payment' : 'Balance') : `Next payment${step.label ? ` (${step.label})` : ''}`,
      amount: cents(num(step.owed)), due: step.date || null, atPickup: !step.date && step.step?.due === 'at_pickup', final: Boolean(step.isFinal)
    });
  }
  const all = cents(num(st.remaining));
  if (all > 0 && !out.some((o) => o.amount === all) && out.length) {
    const last = (st.dueDates || [])[st.dueDates.length - 1];
    out.push({ key: 'all', label: 'Everything owed', amount: all, due: last?.date || null, atPickup: !last?.date && last?.step?.due === 'at_pickup', final: true });
  }
  return out;
}

const WHAT = { deposit: 'deposit', balance: 'balance', next: 'next payment', final: 'final payment', all: 'payment' };

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
//   what         'deposit' | 'next' | 'final' | 'all' ('balance': before schedules)
//   amount       formatted ("$500.00"); due formatted, optional; atPickup: due at pickup
//   finalMethods her final-payment methods ("Cash or Zelle only"), for the final payment
//   account      the account paid through ({ payment_link, payment_instructions })
//   kennelName   signs it
export function paymentRequestMessage(p = {}) {
  const who = text(p.who);
  const pup = text(p.pupName);
  const what = WHAT[p.what] || 'payment';
  const amount = text(p.amount);
  const due = text(p.due);
  const when = due ? `, due by ${due}` : p.atPickup ? ', due at pickup' : '';
  const lines = [who ? `Hi ${who},` : 'Hi,', ''];
  const forPup = pup ? ` for ${pup}` : '';
  lines.push(amount
    ? `Here's how to pay the ${what} of ${amount}${forPup}${when}.`
    : `Here's how to pay the ${what}${forPup}${when}.`);
  const pay = paymentLines(p.account);
  if (pay.length) lines.push('', ...pay);
  if (text(p.finalMethods)) lines.push('', `For the final payment: ${text(p.finalMethods)}`);
  lines.push('', 'Let me know once it\'s sent, or if you have any questions.', '', 'Thank you!');
  if (text(p.kennelName)) lines.push(text(p.kennelName));
  return { subject: pup ? `${pup}: your ${what}` : `Your puppy: ${what}`, body: lines.join('\n') };
}
