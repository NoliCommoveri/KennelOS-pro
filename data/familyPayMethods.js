// familyPayMethods.js — her payment methods for one family (Payment Methods plan
// §2.4, §4, Phase 2). She can turn methods off for a family
// (WaitlistEntry.pay_methods_off, read with payMethods.offFor): off for every payment
// still ahead of them. These helpers serve her side: the record page's Payment
// methods dialog and its warning, and how to pay in her messages and account
// pickers. The family's page reads payMethods.js only (the projection). Pure, no db.
// Pro-only (proPages.js): every caller is a Pro page or asset.
import { PAY_STAGES, hasOwnList, methodsFor, stageIds, methodLabel, linkForAmount, offFor, payGroups, moneyText } from './payMethods.js';

const text = (v) => String(v ?? '').trim();

// A family's methods for a stage: her list less the ones off for them (methodsFor's
// [] / null rule).
export const familyMethods = (stage, kennel, accounts, entry) => methodsFor(stage, kennel, accounts, { off: offFor(entry) });

// The words for a stage ("their deposit"), in her warnings.
export const PAY_STAGE_WORDS = { fee: 'application fee', deposit: 'deposit', payments: 'payments', final: 'final payment' };

// The payments still ahead for a family (D3: a method off is off for all of them).
// `statement`: their open sale's payment statement (paymentSchedule), or null when
// there's no sale yet. → stages, in PAY_STAGES order.
const ENDED = new Set(['withdrawn', 'declined', 'removed', 'expired']);
export function stagesAhead(entry, statement = null) {
  if (!entry || entry.is_archived || ENDED.has(entry.status)) return [];
  const out = new Set();
  if (!entry.fee_received_date && ['applied', 'approved'].includes(entry.status)) out.add('fee');
  if (!statement) {
    // No sale yet: everything from the deposit on, unless they're placed (their
    // sale has ended or isn't theirs any more).
    if (entry.status !== 'placed') ['deposit', 'payments', 'final'].forEach((s) => out.add(s));
  } else if (!statement.ended) {
    if (statement.deposit && Number(statement.deposit.owed) > 0) out.add('deposit');
    for (const d of statement.dueDates || []) if (Number(d.owed) > 0) out.add(d.isFinal ? 'final' : 'payments');
    for (const o of statement.ownDated || []) if (Number(o.owed) > 0) out.add('payments');
    if (!out.has('final') && Number(statement.remaining) > 0 && !(statement.dueDates || []).length) out.add('final');
  }
  return PAY_STAGES.filter((s) => out.has(s));
}

// The rows of her Payment methods dialog: every account on any of her lists (live,
// taking payments), in her order, with the stages it's on. → [{ account, stages: [], off }]
export function familyMethodRows(kennel, accounts = [], entry = null) {
  const off = new Set(offFor(entry));
  const rows = [];
  for (const s of PAY_STAGES) {
    if (!hasOwnList(kennel, s)) continue;
    for (const a of methodsFor(s, kennel, accounts) || []) {
      let row = rows.find((r) => r.account.id === a.id);
      if (!row) rows.push(row = { account: a, stages: [], off: off.has(a.id) });
      row.stages.push(s);
    }
  }
  return rows;
}

// The payments still ahead that would be left with no method if `offIds` were off
// for this family: only stages she set a list for that has methods today.
export function stagesLeftEmpty(kennel, accounts, ahead, offIds = []) {
  return (ahead || []).filter((s) => hasOwnList(kennel, s)
    && (methodsFor(s, kennel, accounts) || []).length > 0
    && (methodsFor(s, kennel, accounts, { off: offIds }) || []).length === 0);
}

// Words for a list of stages: "deposit and final payment".
export function stageWords(stages) {
  const w = (stages || []).map((s) => PAY_STAGE_WORDS[s] || s);
  return w.length <= 1 ? (w[0] || '') : `${w.slice(0, -1).join(', ')} and ${w[w.length - 1]}`;
}

// Her messages to a family (waitlist messages): how to pay one stage, as text. Her
// list for it, less their turned-off methods, one line per method (its link, with
// the amount filled in where the link takes it, then its instructions), then her own
// text under them. No list set: her text alone, as before. → string ('' for none).
// `pieces` (what the payment is for, paymentSchedule.duePieces): its charges' own
// methods (D25); when they differ, one block per part, "Boarding, $250:" over its
// methods.
export function payMessageText(stage, kennel, accounts, entry, { amount = null, other = '', pieces = null } = {}) {
  const extra = text(other);
  if (!hasOwnList(kennel, stage)) return extra;
  const lineOf = (amt) => (a) => {
    const link = linkForAmount(a.payment_link, amt).url;
    return `${methodLabel(a)}: ${[link, text(a.payment_instructions)].filter(Boolean).join(' · ')}`;
  };
  const groups = pieces ? payGroups(stage, pieces, kennel, accounts, { off: offFor(entry) }) || [] : [];
  let lines;
  if (groups.length > 1) {
    lines = groups.flatMap((g, i) => [...(i ? [''] : []), `${g.label}, ${moneyText(g.amount)}:`, ...g.methods.map(lineOf(g.amount))]);
    if (extra) lines.push('');
  } else {
    const methods = groups.length ? groups[0].methods : familyMethods(stage, kennel, accounts, entry) || [];
    lines = methods.map(lineOf(amount));
  }
  if (extra) lines.push(extra);
  return lines.join('\n');
}

// Her side, an account picker for one family's payment (Send payment link, Review
// sale & send): that stage's methods first in her order, then her other accounts;
// accounts off for this family left out, unless that leaves none (money in is
// money in). → accounts
export function pickerOrder(accounts = [], stage, kennel, entry = null) {
  const off = new Set(offFor(entry));
  const kept = accounts.filter((a) => !off.has(a.id));
  const list = kept.length ? kept : accounts;
  const ids = stage ? (stageIds(kennel, stage) || []) : [];
  const rank = (a) => (ids.includes(a.id) ? ids.indexOf(a.id) : ids.length);
  return list.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i).map((x) => x.a);
}
