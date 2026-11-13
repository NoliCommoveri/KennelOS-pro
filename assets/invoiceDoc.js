// invoiceDoc.js — the invoice / receipt DOCUMENT MODEL (End-State guide §24;
// Payment Schedule plan §6). One function builds what the document says — issuer,
// recipient, line items, totals, account summary, payment box, notes, footnotes —
// and two renderers draw it: invoice.js as the printable page, invoicePdf.js as a
// real PDF file. So the page and the PDF can never disagree. Every string here is
// PLAIN TEXT; the HTML renderer escapes, the PDF renderer draws text as-is.
//
// A family's documents (a waitlist entry and its sale, data/familyMoney.js) bill the
// lines of its account (each charge by due date, with what's still owed) or receipt
// its recorded money, each with the account summary. A stud service's are its stud
// fee line, Full or Partial (see invoice.js's header). Pro-only (PRO_ONLY_STANDALONE).
import { studServiceRepo } from '../data/studServiceRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { getActiveKennel } from '../data/kennelScope.js';
import { incomeLineItems } from '../data/incomeView.js';
import { loadFamilyAccount, resolvePick, defaultPick, documentLines, FEE_KEY } from '../data/familyMoney.js';
import { getInvoiceDefaults } from '../data/settings.js';
import { resolveMyContactId } from '../data/kennelSetup.js';
import { todayYMD } from '../data/dateUtils.js';
import { waitlistConfig, entryName } from '../data/waitlistRules.js';
import { REGISTRATION_TYPE, FEE_STRUCTURE, INVOICE_LINE_LABELS, FEE_CREDIT_POLICY, descriptor } from '../data/vocab.js';
import { fmtMoney } from './ui.js';

// The standing footnotes on a sale invoice (familyMoney.documentLines marks the
// lines): the deposit's refundability (*), and the due-date note (**) on a sale
// without a schedule. Stud fees carry neither.
const NOTE_STAR = 'All deposit fees are non-refundable except where exclusions from contract apply.';
const NOTE_DBL = 'Transport, boarding, and purchase price balance due dates are calculated based on either expected pickup date or when puppy reaches nine weeks of age, whichever comes first. Date may change based on rescheduling pick-up dates. Any and all remaining unpaid fees are immediately due upon pickup if earlier than the above listed dates.';

export function fmtDateMDY(ymd) {
  if (!ymd) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return ymd;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

export const money = (v) => fmtMoney(v) || '$0.00';
const numOf = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Build the document. `doc` is 'invoice' | 'receipt'. Returns null when the
// record doesn't exist. A stud service is one record (buildStudDoc); everything
// else is a family's (Payment Schedule plan §6): `source` 'family' with `entry` or
// `sale`, or the older 'sale' / 'waitlist' links, which read as that sale's or that
// entry's family. A family document's cfg is { v: 2, pick?, lines?, money?, number,
// notes, methods?, payMethod?, payReference? } (familyMoney.resolvePick /
// documentLines); without one (or with an older cfg) the source's default pick.
export async function buildInvoiceDoc({ source = 'sale', id, entry = null, sale = null, doc = 'invoice', cfg = null }) {
  if (source === 'stud') return buildStudDoc({ id, doc, cfg });
  const fam = await loadFamilyAccount(source === 'waitlist' ? { entryId: id } : source === 'sale' ? { saleId: id } : { entryId: entry, saleId: sale });
  if (!fam) return null;
  return familyDoc(fam, { source, doc, cfg });
}

// The issuer: the record's own kennel, then the dog's, the active, the sole own.
// A sale/stud service carries a real kennel_id (Multi-Kennel Scope Spec §4; a stud
// service inherits it from OUR dog, never the partner's), and a waitlist entry is
// always on one own kennel's list.
async function issuerFor(kennelIds) {
  const [kennels, myContact, activeKennel] = await Promise.all([
    kennelRepo.getAll({ includeArchived: true }),
    resolveMyContactId().then((cid) => (cid ? contactRepo.getById(cid) : null)),
    getActiveKennel()
  ]);
  const ownKennel = kennelIds.map((kid) => kid && kennels.find((k) => k.id === kid)).find(Boolean)
    || activeKennel
    || kennels.find((k) => k.is_own_kennel && !k.is_archived)
    || null;
  const issuer = {
    name: ownKennel?.kennel_name || 'Kennel',
    lines: [
      myContact && myContact.name && myContact.name !== ownKennel?.kennel_name ? myContact.name : '',
      ownKennel?.location || '',
      myContact?.email || '',
      myContact?.phone || '',
      ownKennel?.website || ''
    ].filter(Boolean),
    logo: ownKennel?.logo_data_url || ''
  };
  return { ownKennel, issuer };
}

const footnotesFor = (markers) => [
  ...(markers.has('*') ? [{ marker: '*', text: NOTE_STAR }] : []),
  ...(markers.has('**') ? [{ marker: '**', text: NOTE_DBL }] : [])
];

function fileName(docType, number, toName) {
  const who = (toName || 'family').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return `${docType}-${number}${who ? `-${who}` : ''}.pdf`;
}

// A family's invoice or receipt, read from its account (familyMoney.familyAccount).
async function familyDoc(fam, { source, doc, cfg }) {
  const { entry, sale, account, contact, dog } = fam;
  const isReceipt = doc === 'receipt';
  const today = todayYMD();
  const record = sale || entry;
  const c = cfg && cfg.v === 2 ? cfg : {};
  const pick = c.pick || defaultPick(source, doc);
  const lines = Array.isArray(c.lines) ? c.lines : isReceipt ? [] : resolvePick(account, 'invoice', pick).map((ref) => ({ ref }));
  const money = Array.isArray(c.money) ? c.money : isReceipt ? resolvePick(account, 'receipt', pick) : [];
  const dl = documentLines(account, { doc, lines, money });

  const markers = new Set();
  const rows = dl.rows.map((r) => {
    if (isReceipt) return { label: r.label, marker: '', due: [r.date ? fmtDateMDY(r.date) : '', r.method].filter(Boolean).join(' · '), amount: r.amount };
    if (r.marker) markers.add(r.marker);
    return { label: r.label, marker: r.marker, due: r.dueText || (r.dueDate ? fmtDateMDY(r.dueDate) : ''), amount: r.amount };
  });

  const { ownKennel, issuer } = await issuerFor([sale?.kennel_id, dog?.kennel_id, entry?.kennel_id]);
  const number = (c.number ?? record.invoice_number ?? '').trim()
    || `${isReceipt ? 'RCT' : 'INV'}-${today.replace(/-/g, '')}-${String(record.id).slice(0, 6).toUpperCase()}`;
  const notes = (c.notes ?? record.invoice_notes ?? '').trim();

  // Payment block. A receipt of one item of money says how and when it came; an
  // invoice lists her accepted methods, and the final payment's own methods
  // (Kennel.final_payment_methods, D9) for a final payment. A fee-only invoice gives
  // her waitlist payment instructions, as before.
  let pay = null;
  const finalMethods = String(fam.kennel?.final_payment_methods || ownKennel?.final_payment_methods || '').trim();
  const feeOnly = !isReceipt && lines.length > 0 && dl.rows.every((r) => r.ref.startsWith(`${FEE_KEY}@`));
  if (isReceipt) {
    const one = dl.items.length === 1 && !dl.items[0].credited ? dl.items[0] : null;
    const method = one?.method || (one && ['deposit', 'paid_in_full'].includes(one.kind) ? (c.payMethod ?? sale?.payment_method ?? '') : '');
    const reference = one?.reference || (one && ['deposit', 'paid_in_full'].includes(one.kind) ? (c.payReference ?? sale?.payment_reference ?? '') : '');
    const payRows = one ? [['Payment method', method], ['Reference', reference], ['Payment date', one.date ? fmtDateMDY(one.date) : '']].filter(([, v]) => v) : [];
    pay = { title: 'Payment received', rows: payRows, methods: [], note: method ? `Paid via ${method}. Thank you!` : 'Thank you for your payment!' };
  } else if (feeOnly && ownKennel && waitlistConfig(ownKennel).payment_instructions) {
    pay = { title: 'How to pay', rows: [], methods: [], note: waitlistConfig(ownKennel).payment_instructions };
  } else if (dl.finalOnly && finalMethods) {
    pay = { title: 'How to pay the final payment', rows: [], methods: [], note: finalMethods };
  } else {
    const methods = (c.methods || getInvoiceDefaults().acceptedMethods || []).filter(Boolean);
    const note = dl.hasFinal && finalMethods ? `The final payment: ${finalMethods}` : '';
    if (methods.length || note) pay = { title: methods.length ? 'Payment may be made using one of the following methods:' : 'How to pay', rows: [], methods, note };
  }

  const app = entry?.application || {};
  const to = {
    name: entry ? entryName(entry, contact) : (contact ? contact.name : ''),
    lines: (contact ? [contact.address, contact.email, contact.phone] : [app.location, app.email, app.phone])
      .map((v) => String(v || '').trim()).filter(Boolean)
  };
  let re;
  if (sale) {
    re = `Re: ${dog?.call_name || 'Puppy'}${dog?.registered_name ? ` (${dog.registered_name})` : ''} — ${sale.registration_type === 'none' ? 'unregistered' : `${descriptor(REGISTRATION_TYPE, sale.registration_type).label} registration`}`;
  } else {
    const policy = entry.fee_credit_policy ? descriptor(FEE_CREDIT_POLICY, entry.fee_credit_policy).label.toLowerCase() : '';
    re = `Re: Waitlist application fee${ownKennel ? ` for ${ownKennel.kennel_name}` : ''}${policy ? ` (${policy})` : ''}`;
  }
  const docType = isReceipt ? 'Receipt' : 'Invoice';
  return {
    source: 'family', saleId: sale?.id || null, entryId: entry?.id || null,
    isReceipt, docType, number, date: today, colLabel: isReceipt ? 'Received' : 'Due by',
    issuer, partyRole: isReceipt ? 'Received from' : 'Bill to', recipient: to, re,
    rows, totals: dl.totals, summary: dl.summary, pay, notes, footnotes: footnotesFor(markers),
    filename: fileName(docType, number, to.name)
  };
}

// A stud service's invoice or receipt: its one stud fee line, Full or Partial, as
// it has always been (cfg { number, notes, lines: [{ key, mode, collected, dueDate? }],
// methods, payMethod, payReference }).
async function buildStudDoc({ id, doc = 'invoice', cfg = null }) {
  const isReceipt = doc === 'receipt';
  const record = await studServiceRepo.getById(id);
  if (!record) return null;
  const [dog, recipient] = await Promise.all([
    record.our_dog_id ? dogRepo.getById(record.our_dog_id) : null,
    record.partner_contact_id ? contactRepo.getById(record.partner_contact_id) : null
  ]);
  const { issuer } = await issuerFor([record.kennel_id, dog?.kennel_id]);
  const today = todayYMD();
  const items = incomeLineItems('stud', record);
  const baseByKey = new Map(items.map((it) => [it.key || it.component, it.amount]));
  const labelByKey = new Map(items.map((it) => [it.key || it.component, it.invoiceLabel]));
  if (!cfg) {
    cfg = {
      number: (record.invoice_number || '').trim(), notes: (record.invoice_notes || '').trim(),
      lines: [...baseByKey.keys()].map((key) => ({ key, mode: 'full', collected: 0 })),
      methods: getInvoiceDefaults().acceptedMethods, payMethod: record.payment_method || '', payReference: record.payment_reference || ''
    };
  }
  const rows = [];
  let subtotal = 0;       // invoice: sum of printed line amounts
  let collectedFull = 0;  // invoice: already-collected on full lines (reduces balance)
  let paidTotal = 0;      // receipt: sum of amounts received
  for (const line of (cfg.lines || [])) {
    const base = baseByKey.get(line.key);
    if (base == null || base <= 0) continue;
    const collected = numOf(line.collected);
    const partial = line.mode === 'partial';
    let label = labelByKey.get(line.key) || INVOICE_LINE_LABELS[line.key] || line.key;
    if (isReceipt) {
      // Full receipts what's left after anything collected before; Partial only
      // the amount typed.
      const amount = partial ? collected : Math.max(base - collected, 0);
      if (partial) label += ' (partial)';
      else if (collected > 0) label += ' (balance)';
      paidTotal += amount;
      rows.push({ label, marker: '', due: '', amount });
    } else {
      const amount = partial ? collected : base;
      if (partial) label += ' (partial)';
      else collectedFull += collected;
      subtotal += amount;
      rows.push({ label, marker: '', due: line.dueDate ? fmtDateMDY(line.dueDate) : '', amount });
    }
  }
  const totals = isReceipt
    ? [{ label: 'Total paid', amount: paidTotal, total: true }]
    : [
        { label: 'Subtotal', amount: subtotal },
        ...(collectedFull > 0 ? [{ label: 'Less amount already collected', amount: -collectedFull }] : []),
        { label: 'Balance', amount: Math.max(subtotal - collectedFull, 0), total: true }
      ];
  const number = (cfg.number || '').trim()
    || `${isReceipt ? 'RCT' : 'INV'}-${today.replace(/-/g, '')}-${String(id).slice(0, 6).toUpperCase()}`;

  let pay = null;
  if (isReceipt) {
    const paymentDate = record.returned_date || record.sent_date || '';
    const payRows = [
      ['Payment method', cfg.payMethod || ''],
      ['Reference', cfg.payReference || ''],
      ['Payment date', paymentDate ? fmtDateMDY(paymentDate) : '']
    ].filter(([, v]) => v);
    pay = { title: 'Payment received', rows: payRows, methods: [], note: cfg.payMethod ? `Paid via ${cfg.payMethod}. Thank you!` : 'Thank you for your payment!' };
  } else {
    const methods = (cfg.methods || []).filter(Boolean);
    if (methods.length) pay = { title: 'Payment may be made using one of the following methods:', rows: [], methods, note: '' };
  }
  const to = {
    name: recipient ? recipient.name : '',
    lines: (recipient ? [recipient.address, recipient.email, recipient.phone] : []).map((v) => String(v || '').trim()).filter(Boolean)
  };
  const re = `Re: Stud service — ${dog?.call_name || 'our dog'} × ${recipient?.name || 'partner'}${record.fee_structure ? ` (${descriptor(FEE_STRUCTURE, record.fee_structure).label})` : ''}`;
  const docType = isReceipt ? 'Receipt' : 'Invoice';
  return {
    source: 'stud', isReceipt, docType, number, date: today,
    issuer, partyRole: isReceipt ? 'Received from' : 'Bill to', recipient: to, re,
    rows, totals, pay, notes: cfg.notes || '', footnotes: [],
    filename: fileName(docType, number, to.name)
  };
}
