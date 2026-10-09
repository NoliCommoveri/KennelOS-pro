// invoiceDoc.js — the invoice / receipt DOCUMENT MODEL (End-State guide §24;
// Waitlist Spec §15.2). One function builds what the document says — issuer,
// recipient, line items, totals, payment box, notes, footnotes — and two renderers
// draw it: invoice.js as the printable page, invoicePdf.js as a real PDF file. So
// the page and the PDF can never disagree. Every string here is PLAIN TEXT; the
// HTML renderer escapes, the PDF renderer draws text as-is.
//
// Sources: 'sale' and 'stud' (the Financials generator, §24) and 'waitlist' (a
// family's application fee: a receipt once received, an invoice while it's due).
// `cfg` carries the generator's per-line choices; without it every cash line
// prints in full with nothing collected (see invoice.js's header for the
// Full vs Partial money rules). Pro-only (PRO_ONLY_STANDALONE).
import { saleRepo } from '../data/saleRepo.js';
import { studServiceRepo } from '../data/studServiceRepo.js';
import { waitlistEntryRepo } from '../data/waitlistEntryRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { eventRepo } from '../data/eventRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { getActiveKennel } from '../data/kennelScope.js';
import { incomeLineItems, getSaleFeeCredit } from '../data/incomeView.js';
import { getMyContactId, getInvoiceDefaults } from '../data/settings.js';
import { todayYMD } from '../data/dateUtils.js';
import { waitlistConfig, entryName } from '../data/waitlistRules.js';
import { REGISTRATION_TYPE, FEE_STRUCTURE, INVOICE_LINE_LABELS, FEE_CREDIT_POLICY, descriptor } from '../data/vocab.js';
import { fmtMoney } from './ui.js';

// Footnote markers on a SALE invoice: deposit is refundability (*), the rest of
// the puppy-sale money is due-date driven (**). Stud fees carry neither.
const FOOTNOTE = { deposit: '*', balance: '**', transport: '**', boarding: '**' };
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

// Load the record and everything around it. Returns null when it doesn't exist.
async function loadSource(source, id) {
  const record = source === 'sale' ? await saleRepo.getById(id)
    : source === 'stud' ? await studServiceRepo.getById(id)
    : await waitlistEntryRepo.getById(id);
  if (!record) return null;
  const dogId = source === 'sale' ? record.dog_id : source === 'stud' ? record.our_dog_id : null;
  const recipientId = source === 'sale' ? record.buyer_contact_id : source === 'stud' ? record.partner_contact_id : record.contact_id;
  const [dog, recipient, kennels, myContact, activeKennel] = await Promise.all([
    dogId ? dogRepo.getById(dogId) : null,
    recipientId ? contactRepo.getById(recipientId) : null,
    kennelRepo.getAll({ includeArchived: true }),
    (() => { const cid = getMyContactId(); return cid ? contactRepo.getById(cid) : null; })(),
    getActiveKennel()
  ]);
  // The record's own kennel wins — a sale/stud service carries a real kennel_id
  // as of Multi-Kennel Scope Spec §4 (a stud service inherits it from OUR dog,
  // never the partner's), and a waitlist entry is always on one own kennel's list.
  // Falls back to the dog's own kennel, then the active kennel scope, then the
  // sole own kennel as a last resort (Lite, or "All kennels" with just one).
  const ownKennel = (record.kennel_id && kennels.find((k) => k.id === record.kennel_id))
    || (dog && dog.kennel_id && kennels.find((k) => k.id === dog.kennel_id))
    || activeKennel
    || kennels.find((k) => k.is_own_kennel && !k.is_archived)
    || null;
  return { record, dog, recipient, myContact, ownKennel };
}

// A Sale's due date for everything but the deposit: the soonest of its
// balance_due_date and any scheduled placement (drop-off) event for the puppy.
// Read LIVE every time a document is built, so editing the Sale changes the next
// view/PDF — nothing about an invoice is stored. Also the Financials generator's
// per-line prefill.
export async function saleDueDate(sale) {
  const dates = [];
  if (sale.balance_due_date) dates.push(sale.balance_due_date);
  if (sale.dog_id) {
    const evs = await eventRepo.getForSubject('dog', sale.dog_id);
    for (const e of evs) if (!e.is_archived && e.event_type === 'placement' && e.event_date) dates.push(e.event_date);
  }
  dates.sort();
  return dates[0] || '';
}

// The application fee as one line item (Waitlist Spec §5.3).
function waitlistLines(entry) {
  const amount = numOf(entry.fee_amount);
  return amount > 0 ? [{ component: 'application_fee', amount }] : [];
}

// Build the document. `doc` is 'invoice' | 'receipt'. Returns null when the
// record doesn't exist.
export async function buildInvoiceDoc({ source = 'sale', id, doc = 'invoice', cfg = null }) {
  if (!['sale', 'stud', 'waitlist'].includes(source)) source = 'sale';
  const isReceipt = doc === 'receipt';
  const loaded = await loadSource(source, id);
  if (!loaded) return null;
  const { record, dog, recipient, myContact, ownKennel } = loaded;
  const isSale = source === 'sale';
  const isFee = source === 'waitlist';
  const today = todayYMD();

  // Base amounts by component key, always recomputed from the record. A credited
  // waitlist application fee (Waitlist Spec §5.3) already paid part of the price,
  // so the balance line is reduced by it and says so.
  const feeCredit = isSale ? await getSaleFeeCredit(record.id) : 0;
  const items = isFee ? waitlistLines(record) : incomeLineItems(source, record, { feeCredit });
  const baseByKey = new Map(items.map((it) => [it.component, it.amount]));

  // The record's own due date, read now: a sale's balance due / pickup date, a
  // fee's pay-by date. A line with no dueDate of its own (the default, or a
  // generator line she didn't change) uses it, so the document always matches the
  // record as it is today.
  const liveDue = isSale ? await saleDueDate(record) : (isFee ? (record.fee_due_date || '') : '');

  // Config — from the generator, or a full-line default (every cash line, full,
  // nothing collected, the record's due date).
  if (!cfg) {
    cfg = {
      number: isFee ? '' : (record.invoice_number || '').trim(),
      notes: isFee ? '' : (record.invoice_notes || '').trim(),
      lines: [...baseByKey.keys()].map((key) => ({ key, mode: 'full', collected: 0 })),
      methods: getInvoiceDefaults().acceptedMethods,
      payMethod: isFee ? (record.fee_payment_method || '') : (record.payment_method || ''),
      payReference: isFee ? (record.fee_payment_reference || '') : (record.payment_reference || '')
    };
  }

  const rows = [];
  const markersUsed = new Set();
  let subtotal = 0;       // invoice: sum of printed line amounts
  let collectedFull = 0;  // invoice: already-collected on full lines (reduces balance)
  let paidTotal = 0;      // receipt: sum of amounts received

  for (const line of (cfg.lines || [])) {
    const base = baseByKey.get(line.key);
    if (base == null || base <= 0) continue;
    const collected = numOf(line.collected);
    const partial = line.mode === 'partial';
    let label = line.key === 'application_fee' ? 'Waitlist application fee' : (INVOICE_LINE_LABELS[line.key] || line.key);
    if (line.key === 'balance' && feeCredit > 0) label += ` (after ${money(feeCredit)} application fee credit)`;
    const marker = isSale && !isReceipt ? (FOOTNOTE[line.key] || '') : '';
    if (marker) markersUsed.add(marker);

    if (isReceipt) {
      const amount = partial ? collected : Math.max(base - collected, 0);
      // Partial → "(partial)". Full but with a prior partial payment already
      // collected → this line is the remaining balance, so print "(balance)".
      if (partial) label += ' (partial)';
      else if (collected > 0) label += ' (balance)';
      paidTotal += amount;
      rows.push({ label, marker: '', due: '', amount });
    } else {
      const amount = partial ? collected : base;
      if (partial) label += ' (partial)';
      if (!partial) collectedFull += collected;
      subtotal += amount;
      // Deposits are always due immediately; the calculated due date (expected
      // pickup / nine-weeks-of-age, or a fee's pay-by date) applies to the rest.
      const dueDate = line.dueDate == null ? liveDue : line.dueDate;
      const due = line.key === 'deposit' ? 'Immediately' : (dueDate ? fmtDateMDY(dueDate) : '');
      rows.push({ label, marker, due, amount });
    }
  }

  const balance = Math.max(subtotal - collectedFull, 0);
  const totals = isReceipt
    ? [{ label: 'Total paid', amount: paidTotal, total: true }]
    : [
        { label: 'Subtotal', amount: subtotal },
        ...(collectedFull > 0 ? [{ label: 'Less amount already collected', amount: -collectedFull }] : []),
        { label: 'Balance', amount: balance, total: true }
      ];

  const number = (cfg.number || '').trim()
    || `${isReceipt ? 'RCT' : 'INV'}-${today.replace(/-/g, '')}-${String(id).slice(0, 6).toUpperCase()}`;

  // Payment block.
  let pay = null;
  if (isReceipt) {
    const paymentDate = isFee ? (record.fee_received_date || '')
      : isSale ? (record.balance_paid_date || record.deposit_date || record.sale_date || '')
      : (record.returned_date || record.sent_date || '');
    const payRows = [
      ['Payment method', cfg.payMethod || ''],
      ['Reference', cfg.payReference || ''],
      ['Payment date', paymentDate ? fmtDateMDY(paymentDate) : '']
    ].filter(([, v]) => v);
    pay = { title: 'Payment received', rows: payRows, methods: [], note: cfg.payMethod ? `Paid via ${cfg.payMethod}. Thank you!` : 'Thank you for your payment!' };
  } else if (isFee && ownKennel && waitlistConfig(ownKennel).payment_instructions) {
    pay = { title: 'How to pay', rows: [], methods: [], note: waitlistConfig(ownKennel).payment_instructions };
  } else {
    const methods = (cfg.methods || []).filter(Boolean);
    if (methods.length) pay = { title: 'Payment may be made using one of the following methods:', rows: [], methods, note: '' };
  }

  // Issuer / recipient.
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
  const app = isFee ? (record.application || {}) : {};
  const to = {
    name: isFee ? entryName(record, recipient) : (recipient ? recipient.name : ''),
    lines: (recipient
      ? [recipient.address, recipient.email, recipient.phone]
      : isFee ? [app.location, app.email, app.phone] : []).map((v) => String(v || '').trim()).filter(Boolean)
  };

  let re;
  if (isFee) {
    const policy = record.fee_credit_policy ? descriptor(FEE_CREDIT_POLICY, record.fee_credit_policy).label.toLowerCase() : '';
    re = `Re: Waitlist application fee${ownKennel ? ` for ${ownKennel.kennel_name}` : ''}${policy ? ` (${policy})` : ''}`;
  } else if (isSale) {
    re = `Re: ${dog?.call_name || 'Puppy'}${dog?.registered_name ? ` (${dog.registered_name})` : ''} — ${record.registration_type === 'none' ? 'unregistered' : `${descriptor(REGISTRATION_TYPE, record.registration_type).label} registration`}`;
  } else {
    re = `Re: Stud service — ${dog?.call_name || 'our dog'} × ${recipient?.name || 'partner'}${record.fee_structure ? ` (${descriptor(FEE_STRUCTURE, record.fee_structure).label})` : ''}`;
  }

  // Footer: custom note, then the standing disclaimers whose markers appear above.
  const footnotes = [];
  if (markersUsed.has('*')) footnotes.push({ marker: '*', text: NOTE_STAR });
  if (markersUsed.has('**')) footnotes.push({ marker: '**', text: NOTE_DBL });

  const docType = isReceipt ? 'Receipt' : 'Invoice';
  const who = (to.name || 'family').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return {
    source, isReceipt, docType, number, date: today,
    issuer, partyRole: isReceipt ? 'Received from' : 'Bill to', recipient: to, re,
    rows, totals, pay, notes: cfg.notes || '', footnotes,
    filename: `${docType}-${number}${who ? `-${who}` : ''}.pdf`
  };
}
