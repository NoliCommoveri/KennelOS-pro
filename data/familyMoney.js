// familyMoney.js — one family's money across records, for invoices and receipts
// (Payment Schedule plan §6, D13–D14). A family is a waitlist entry and the one sale
// it goes toward (the family page's sale), or a sale no entry claims. Pro-only, like
// invoices (proPages.js).
//
// Everything is read from the sale's payment statement (paymentSchedule.paymentStatement
// through incomeView.getSaleStatement) and its pieces (chargePieces: each charge split
// by the due date it falls in), plus the entry's application fee:
//   charges  what an invoice can bill: one line per charge and due date, with what's
//            been paid on it and what's still owed
//   money    what a receipt can print: the fee received, the application fee credited
//            toward the price, credits for funds received (as what they covered, with
//            "(credited)"), the deposit, each payment, steps marked paid, paid in full.
//            Only money recorded, never a $0 line.
// The pure functions take what loadFamilyAccount loads; nothing here adds money up
// any other way.
import { chargePieces, allocateMoney } from './paymentSchedule.js';
import { creditsOf, feeCharge } from './receivedCredits.js';
import { creditSale } from './familyExtras.js';
import { getSaleStatement, getIncomeRows } from './incomeView.js';
import { saleRepo } from './saleRepo.js';
import { waitlistEntryRepo } from './waitlistEntryRepo.js';
import { waitlistOfferRepo } from './waitlistOfferRepo.js';
import { kennelRepo } from './kennelRepo.js';
import { contactRepo } from './contactRepo.js';
import { dogRepo } from './dogRepo.js';
import { inScopeOnly } from './kennelScope.js';
import { editionFlags } from './editionConfig.js';
import { entryName } from './waitlistRules.js';

const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
const cents = (n) => Math.round(n * 100) / 100;
const sum = (xs, f = (x) => x.amount) => cents(xs.reduce((t, x) => t + f(x), 0));

export const FEE_KEY = 'application_fee';
export const FEE_LABEL = 'Waitlist application fee';

// --- The account (pure) -------------------------------------------------------------

// The family's charges and money. `entry` (or null), `statement` the family sale's
// payment statement (or null), `sale` that sale (its payments' references and notes).
// → { charges: [piece + { ref, source: 'fee'|'sale' }], money: [{ ref, kind, id, date,
//     amount, credited, method?, reference?, note?, pays: [{ ref, key, label, amount }] }],
//     total, paid, owed, next: { dueId, label, date, owed, isFinal } | null,
//     feeCreditApplied, hasSchedule, ended }
export function familyAccount({ entry = null, statement = null, sale = null } = {}) {
  const st = statement;
  const charges = [];
  const money = new Map();
  const moneyItem = (ref, base) => {
    if (!money.has(ref)) money.set(ref, { ref, ...base, amount: 0, pays: [] });
    return money.get(ref);
  };
  const addPay = (item, pay) => {
    if (!(pay.amount > 0)) return;
    const had = item.pays.find((p) => p.ref === pay.ref);
    if (had) had.amount = cents(had.amount + pay.amount);
    else item.pays.push({ ...pay });
    item.amount = cents(item.amount + pay.amount);
  };

  // The application fee: the money she marked received (less the part a credit paid
  // then, fee_credit_amount), and the credits paying it (the fee is the first thing a
  // credit pays, so the statement's credits pay it the same way).
  const fee = cents(num(entry?.fee_amount));
  if (fee > 0) {
    const feeRef = `${FEE_KEY}@fee`;
    const fromCredits = allocateMoney(creditsOf(entry).map((c) => ({ id: c.id, amount: c.amount, uses: c.applies_to, date: c.date })), feeCharge(entry).map((c) => ({ ...c })));
    const piece = { ref: feeRef, source: 'fee', key: FEE_KEY, label: FEE_LABEL, component: FEE_KEY, part: 'fee', dueId: 'fee', dueLabel: 'Application fee',
      dueDate: entry.fee_due_date || null, isFinal: false, amount: fee, owed: 0, paid: [] };
    const received = entry.fee_received_date ? cents(Math.max(fee - Math.min(num(entry.fee_credit_amount), fee), 0)) : 0;
    if (received > 0) {
      const m = moneyItem(`appfee:${entry.id}`, { kind: 'appfee', id: entry.id, date: entry.fee_received_date, credited: false,
        ...(entry.fee_payment_method ? { method: entry.fee_payment_method } : {}), ...(entry.fee_payment_reference ? { reference: entry.fee_payment_reference } : {}) });
      addPay(m, { ref: feeRef, key: FEE_KEY, label: FEE_LABEL, amount: received });
      piece.paid.push({ ref: m.ref, kind: 'appfee', amount: received, credited: false });
    }
    for (const c of creditsOf(entry)) {
      const amount = sum(fromCredits.perItem[c.id] || []);
      if (!(amount > 0)) continue;
      const m = moneyItem(`credit:${c.id}`, { kind: 'credit', id: c.id, date: c.date || null, credited: true, ...(c.method ? { method: c.method } : {}) });
      addPay(m, { ref: feeRef, key: FEE_KEY, label: 'Application fee (credited)', amount });
      piece.paid.push({ ref: m.ref, kind: 'credit', amount, credited: true });
    }
    piece.owed = cents(Math.max(fee - sum(piece.paid), 0));
    charges.push(piece);
  }

  // The sale: its pieces, and its money (the statement's received, on the sale's charges).
  const payments = new Map((Array.isArray(sale?.payments) ? sale.payments : []).map((p) => [p.id, p]));
  // A schedule due date that covers more than one of the sale's charges (the price and
  // an extra, say) is billed as one line, "Combined Price (<due date>)": `combined`.
  const combined = new Set(combinedDueIds(st));
  for (const pc of chargePieces(st)) {
    const ref = `${pc.key}@${pc.dueId}`;
    charges.push({ ...pc, ref, source: 'sale', ...(combined.has(pc.dueId) ? { combined: true } : {}) });
    for (const x of pc.paid) {
      const p = x.kind === 'payment' ? payments.get(x.id) : null;
      const m = moneyItem(x.ref, { kind: x.kind, id: x.id, date: x.date, credited: x.credited,
        ...(x.method ? { method: x.method } : {}), ...(p?.reference ? { reference: p.reference } : {}), ...(p?.note ? { note: p.note } : {}) });
      addPay(m, { ref, key: pc.key, label: x.label, amount: x.amount });
    }
  }

  const feePiece = charges.find((c) => c.source === 'fee');
  // The application fee credited toward the price is the fee's money again: counted
  // once, as the fee, when the fee is on the account too.
  const feeCreditApplied = feePiece ? Math.min(sum([...money.values()].filter((m) => m.kind === 'fee')), fee) : 0;
  const salePaid = st ? st.paid : 0;
  const saleOwed = st ? st.remaining : 0;
  const paid = cents((feePiece ? sum(feePiece.paid) : 0) + salePaid - feeCreditApplied);
  const owed = cents((feePiece ? feePiece.owed : 0) + saleOwed);
  const next = feePiece && feePiece.owed > 0
    ? { dueId: 'fee', label: 'Application fee', date: feePiece.dueDate, owed: feePiece.owed, isFinal: false }
    : st?.next ? { dueId: st.next.kind === 'deposit' ? 'deposit' : st.next.id, label: st.next.label, date: st.next.date || null, owed: st.next.owed, isFinal: st.next.isFinal } : null;
  return {
    charges, money: [...money.values()].filter((m) => m.amount > 0).sort((a, b) => (a.date || '').localeCompare(b.date || '')),
    total: cents(paid + owed), paid, owed, next, feeCreditApplied,
    hasSchedule: Boolean(st?.hasSchedule), ended: Boolean(st?.ended)
  };
}

// The statement's schedule due dates whose covers take in more than one schedule
// charge (the deposit is its own due date, own-dated extras theirs). → [dueId]
export function combinedDueIds(st) {
  if (!st || st.ended || !st.dueDates?.length) return [];
  const sched = st.charges.filter((c) => c.part === 'schedule');
  return st.dueDates.filter((d) => {
    const covers = d.step?.covers || [];
    const n = covers.includes('all') ? sched.length
      : sched.filter((c) => covers.includes(c.covers) || (c.extraId && covers.includes(`extra:${c.extraId}`))).length;
    return n > 1;
  }).map((d) => d.id);
}

export const COMBINED_LABEL = 'Combined Price';

// --- What a document picks (pure) -----------------------------------------------------

// A pick → the lines an invoice bills or the money a receipt prints. The applicant
// page's documents and the generator's defaults are picks, so they always agree.
//   invoice: 'owed' (every line still owed) | 'all' (every line) | 'sale' (every line of
//            the sale) | 'fee' | 'deposit' | 'next' (exactly what's owed by the next due date)
//   receipt: 'all' | 'sale' (the sale's money) | 'fee' (the fee's) | 'deposit' (the
//            deposit's) | 'money:<ref>' (one item of money)
// → invoice: [charge ref]; receipt: [{ ref, key? }] (key: only what it paid on that charge)
export function resolvePick(account, doc, pick) {
  const { charges, money } = account;
  if (doc === 'receipt') {
    if (pick?.startsWith('money:')) return money.some((m) => m.ref === pick.slice(6)) ? [{ ref: pick.slice(6) }] : [];
    if (pick === 'fee' || pick === 'deposit') {
      const key = pick === 'fee' ? FEE_KEY : 'deposit';
      return money.filter((m) => m.pays.some((p) => p.key === key)).map((m) => ({ ref: m.ref, key }));
    }
    if (pick === 'sale') return money.filter((m) => m.pays.some((p) => p.key !== FEE_KEY)).map((m) => ({ ref: m.ref }));
    return money.map((m) => ({ ref: m.ref }));
  }
  const refs = (xs) => xs.map((c) => c.ref);
  if (pick === 'all') return refs(charges);
  if (pick === 'sale') return refs(charges.filter((c) => c.source === 'sale'));
  if (pick === 'fee') return refs(charges.filter((c) => c.source === 'fee'));
  if (pick === 'deposit') return refs(charges.filter((c) => c.dueId === 'deposit'));
  if (pick === 'next') return account.next ? refs(charges.filter((c) => c.dueId === account.next.dueId && c.owed > 0)) : [];
  return refs(charges.filter((c) => c.owed > 0));
}

// The pick an old link or no setup means: a sale's documents were every line of the
// sale (an invoice) or all its money (a receipt); a waitlist fee's, the fee.
export const defaultPick = (source, doc) => (source === 'waitlist' ? 'fee' : source === 'sale' ? 'sale' : doc === 'receipt' ? 'all' : 'owed');

// --- The document's lines (pure) ---------------------------------------------------------

// Footnote markers on a sale invoice without a schedule (the deposit's refundability *,
// the standing due-date note **). With a schedule the dates are the schedule's, so no **.
const FOOTNOTE = { deposit: '*', balance: '**', transport: '**', boarding: '**' };

// What an invoice or receipt says, in numbers. `lines` (invoice): [{ ref, amount? }],
// `amount` a typed partial; `money` (receipt): [{ ref, key? }]. Dates are YYYY-MM-DD;
// the caller formats. → invoice: { rows: [{ label, marker, dueDate, dueText, amount,
// partial, ref }], totals, summary, finalOnly, hasFinal }; receipt: { rows: [{ label,
// date, method, amount, credited, ref }], totals, summary, items }.
export function documentLines(account, { doc = 'invoice', lines = [], money = [] } = {}) {
  const summaryBase = [{ label: 'Total', amount: account.total }, { label: 'Paid to date', amount: account.paid }];
  if (doc === 'receipt') {
    const rows = [];
    const items = [];
    for (const pick of money) {
      const m = account.money.find((x) => x.ref === pick.ref);
      if (!m) continue;
      const pays = m.pays.filter((p) => !pick.key || p.key === pick.key);
      if (pays.length) items.push(m);
      for (const p of pays) rows.push({ label: p.label, date: m.date || null, method: m.method || '', amount: p.amount, credited: m.credited, ref: m.ref });
    }
    const credited = sum(rows.filter((r) => r.credited));
    const paid = sum(rows.filter((r) => !r.credited));
    const totals = credited > 0
      ? [...(paid > 0 ? [{ label: 'Paid', amount: paid }] : []), { label: 'Credited', amount: credited }, { label: 'Total', amount: cents(paid + credited), total: true }]
      : [{ label: 'Total paid', amount: paid, total: true }];
    return { rows, totals, items, summary: [...summaryBase, { label: 'Still owed', amount: account.owed }] };
  }
  const rows = [];
  let subtotal = 0;
  const less = { fee: 0, credit: 0, other: 0 };
  let due = 0;
  const picked = lines.map((l) => ({ l, c: account.charges.find((c) => c.ref === l.ref) })).filter((x) => x.c)
    .sort((a, b) => account.charges.indexOf(a.c) - account.charges.indexOf(b.c));
  const byDue = new Map();
  for (const { l, c } of picked) {
    const partial = l.amount != null && l.amount !== '' && num(l.amount) > 0;
    const amount = partial ? cents(num(l.amount)) : c.amount;
    subtotal += amount;
    if (partial) due += amount;
    else {
      for (const x of c.paid) less[x.kind === 'fee' ? 'fee' : x.kind === 'credit' ? 'credit' : 'other'] += x.amount;
      due += c.owed;
    }
    const owed = partial ? amount : c.owed;
    // A combined due date's charges print as one line, whichever of them it falls on.
    const group = c.combined && c.source === 'sale' ? byDue.get(c.dueId) : null;
    if (group) {
      group.amount = cents(group.amount + amount);
      group.owed = cents(group.owed + owed);
      group.partial = group.partial || partial;
      continue;
    }
    const row = {
      label: c.label, ref: c.ref, amount, partial, owed,
      marker: c.source === 'sale' && !account.hasSchedule ? (FOOTNOTE[c.component] || '') : '',
      dueDate: c.dueDate || null, dueId: c.dueId, source: c.source, combined: Boolean(c.combined && c.source === 'sale')
    };
    if (row.combined) {
      row.label = `${COMBINED_LABEL} (${c.dueLabel})`;
      byDue.set(c.dueId, row);
    }
    rows.push(row);
  }
  for (const r of rows) {
    r.label = `${r.label}${r.partial ? ' (partial)' : ''}`;
    r.dueText = !r.partial && r.owed <= 0 ? 'Paid' : r.dueDate ? '' : r.dueId === 'deposit' ? 'Immediately' : r.source === 'sale' ? 'Date not set yet' : '';
    delete r.owed; delete r.dueId; delete r.source;
  }
  const totals = [
    { label: 'Subtotal', amount: cents(subtotal) },
    ...(less.fee > 0 ? [{ label: 'Less application fee credit', amount: -cents(less.fee) }] : []),
    ...(less.credit > 0 ? [{ label: 'Less credit for funds already received', amount: -cents(less.credit) }] : []),
    ...(less.other > 0 ? [{ label: 'Less amount already collected', amount: -cents(less.other) }] : []),
    { label: 'Balance', amount: cents(due), total: true }
  ];
  const owedLines = picked.filter(({ l, c }) => c.owed > 0 || (l.amount != null && l.amount !== ''));
  return {
    rows, totals,
    summary: [...summaryBase, { label: 'This invoice', amount: cents(due) }, { label: 'Still owed after it', amount: cents(Math.max(account.owed - due, 0)) }],
    hasFinal: owedLines.some(({ c }) => c.isFinal),
    finalOnly: owedLines.length > 0 && owedLines.every(({ c }) => c.isFinal)
  };
}

// --- The applicant page's documents (pure) ----------------------------------------------

// One invoice and one receipt per charge, with no setup (§6.2): the application fee's,
// the deposit's (always, while there's a deposit; its receipt says "(credited)" when
// credits or the fee covered it), a receipt for each payment received, and an invoice
// for the next payment (when it isn't the fee's or the deposit's).
// → [{ label, doc, pick }]
export function familyDocs(account, { money = (n) => `$${n}`, date = (d) => d } = {}) {
  const out = [];
  const has = (dueId) => account.charges.some((c) => c.dueId === dueId);
  const paidOn = (key) => account.money.some((m) => m.pays.some((p) => p.key === key));
  if (has('fee')) {
    out.push({ label: 'Application fee invoice', doc: 'invoice', pick: 'fee' });
    if (paidOn(FEE_KEY)) out.push({ label: 'Application fee receipt', doc: 'receipt', pick: 'fee' });
  }
  if (has('deposit')) {
    out.push({ label: 'Deposit invoice', doc: 'invoice', pick: 'deposit' });
    if (paidOn('deposit')) out.push({ label: 'Deposit receipt', doc: 'receipt', pick: 'deposit' });
  }
  for (const m of account.money.filter((x) => ['payment', 'step', 'paid_in_full'].includes(x.kind))) {
    out.push({ label: `Receipt for ${money(m.amount)}${m.date ? ` received ${date(m.date)}` : ''}`, doc: 'receipt', pick: `money:${m.ref}` });
  }
  const n = account.next;
  if (n && !['fee', 'deposit'].includes(n.dueId)) {
    out.push({ label: `Invoice for the next payment (${money(n.owed)}${n.date ? `, due ${date(n.date)}` : ''})`, doc: 'invoice', pick: 'next' });
  }
  return out;
}

// --- Loading -------------------------------------------------------------------------------

// The sale an entry's documents cover: the sale its credits go toward (creditSale: the
// one it's placed with or picked, delivered included), else the sale it was placed with
// whatever happened to it (a receipt for money paid on a cancelled sale).
function entrySale(entry, sales, offers, entries) {
  return creditSale(entry, sales, offers, entries)
    || (entry.placed_sale_id ? sales.find((s) => s.id === entry.placed_sale_id && !s.is_archived) || null : null);
}

// A family as the documents read it: `entryId` (a waitlist family) or `saleId` (a sale,
// whose family is the entry that claims it, if any). → { entry, sale, loaded
// (getSaleStatement's, or null), account, kennel, contact, dog } | null
export async function loadFamilyAccount({ entryId = null, saleId = null } = {}) {
  const [entries, offers, sales] = await Promise.all([
    editionFlags.waitlist ? waitlistEntryRepo.getAll() : [],
    editionFlags.waitlist ? waitlistOfferRepo.getAll() : [],
    saleRepo.getAll({ includeArchived: true })
  ]);
  let entry = entryId ? (entries.find((e) => e.id === entryId) || await waitlistEntryRepo.getById(entryId)) : null;
  let sale = null;
  if (entry) sale = entrySale(entry, sales, offers, entries);
  else if (saleId) {
    sale = sales.find((s) => s.id === saleId) || null;
    if (!sale) return null;
    entry = entries.find((e) => entrySale(e, sales, offers, entries)?.id === sale.id) || null;
  }
  if (!entry && !sale) return null;
  const loaded = sale ? await getSaleStatement(sale) : null;
  const [kennel, contact, dog] = await Promise.all([
    loaded?.kennel || (entry?.kennel_id ? kennelRepo.getById(entry.kennel_id) : null),
    (sale?.buyer_contact_id || entry?.contact_id) ? contactRepo.getById(sale?.buyer_contact_id || entry.contact_id) : null,
    sale?.dog_id ? dogRepo.getById(sale.dog_id) : null
  ]);
  return { entry, sale, loaded, kennel, contact, dog, account: familyAccount({ entry, statement: loaded?.statement || null, sale }) };
}

// The generator's families: every waitlist family with a fee or a sale, and every sale
// with money that no family claims, in the active kennel scope.
// → [{ key: 'entry:<id>' | 'sale:<id>', entryId?, saleId?, label, date }]
export async function listInvoiceFamilies() {
  const [rows, entries, offers, sales, contacts, dogs] = await Promise.all([
    getIncomeRows({ includeArchived: false }),
    editionFlags.waitlist ? waitlistEntryRepo.getAll() : [],
    editionFlags.waitlist ? waitlistOfferRepo.getAll() : [],
    saleRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true }),
    dogRepo.getAll({ includeArchived: true })
  ]);
  const contactName = (id) => contacts.find((c) => c.id === id)?.name || '';
  const pupName = (s) => dogs.find((d) => d.id === s?.dog_id)?.call_name || '';
  const claimed = new Set();
  const out = [];
  for (const e of inScopeOnly(entries)) {
    const s = entrySale(e, sales, offers, entries);
    if (s) claimed.add(s.id);
    if (!s && !(num(e.fee_amount) > 0)) continue;
    const name = entryName(e, e.contact_id ? { name: contactName(e.contact_id) } : null);
    out.push({ key: `entry:${e.id}`, entryId: e.id, label: `${name}${s ? ` → ${pupName(s) || 'their pup'}` : ' (application fee)'}`, date: s?.sale_date || e.applied_date || '' });
  }
  for (const r of rows.filter((x) => x.source_type === 'sale' && !claimed.has(x.source_id))) {
    out.push({ key: `sale:${r.source_id}`, saleId: r.source_id, label: `${r.counterparty} → ${r.dog}`, date: r.date || '' });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}
