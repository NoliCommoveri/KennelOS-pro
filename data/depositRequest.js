// depositRequest.js — the one message that goes to a family once they've picked
// a pup from the waitlist (Integrations plan §2.6): the deposit and when it's due,
// how to pay (the sale's Sold / paid through account's payment link and
// instructions, plan §4, and her waitlist payment instructions), the contract link to sign, and a line about the attached invoice.
// She edits it before it goes, and sends it herself (share sheet, her email, or
// copy). Pure: the caller formats money and dates and passes them in.

import { paymentLines } from './paymentLinks.js';

const text = (v) => String(v ?? '').trim();

// → { subject, body }. Every part is optional; a part with nothing to say is left out.
//   who            the family's first name
//   pupName        the pup they picked
//   litterLabel    its litter ("Rose × Duke, Jun 2026")
//   deposit        the deposit, formatted ("$500.00")
//   depositDue     when it's due, formatted
//   payAccount     the account the sale is paid through, when it takes payments
//                  (plan §4): its payment link and instructions, before hers
//   paymentLink    a bare link to pay online, when there's no payAccount
//   paymentText    her payment instructions (the waitlist's, D21)
//   contractLabel  the contract form's label, e.g. "Pet home contract"
//   contractLink   its prefilled signing link
//   invoice        true when the invoice PDF goes with the message
//   balance        what's due after the deposit, formatted, and balanceDue (formatted date)
//   kennelName     signs the message
export function depositRequestMessage(p = {}) {
  const who = text(p.who);
  const pup = text(p.pupName);
  const litter = text(p.litterLabel);
  const lines = [who ? `Hi ${who},` : 'Hi,', ''];
  lines.push(pup
    ? `Thank you for choosing ${pup}${litter ? ` from ${litter}` : ''}! Here's what's next.`
    : 'Thank you for choosing your puppy! Here\'s what\'s next.');
  const deposit = text(p.deposit);
  if (deposit) {
    lines.push('', `Deposit: ${deposit}${text(p.depositDue) ? `, due by ${text(p.depositDue)}` : ''}.`);
    if (pup) lines.push(`${pup} is held for you until then.`);
  }
  const pay = p.payAccount ? paymentLines(p.payAccount) : text(p.paymentLink) ? [`Pay online: ${text(p.paymentLink)}`] : [];
  if (pay.length) lines.push('', ...pay);
  if (text(p.paymentText)) lines.push('', `${pay.length ? 'Or pay' : 'How to pay'}: ${text(p.paymentText)}`);
  if (text(p.contractLink)) {
    lines.push('', `Please review and sign your ${text(p.contractLabel) || 'contract'}. The details are already filled in:`, text(p.contractLink));
  }
  if (p.invoice) lines.push('', 'Your invoice is attached.');
  if (text(p.balance)) lines.push('', `The balance of ${text(p.balance)} is due${text(p.balanceDue) ? ` by ${text(p.balanceDue)}` : ' when you pick up your puppy'}.`);
  lines.push('', 'Let me know if you have any questions.', '', 'Thank you!');
  if (text(p.kennelName)) lines.push(text(p.kennelName));
  const subject = pup ? `${pup}: your deposit${text(p.contractLink) ? ' and contract' : ''}` : `Your puppy: deposit${text(p.contractLink) ? ' and contract' : ''}`;
  return { subject, body: lines.join('\n') };
}
