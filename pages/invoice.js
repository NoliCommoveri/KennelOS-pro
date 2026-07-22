// invoice.js — Invoice / Receipt print-PDF view (§24). Renders a printable
// financial document for one income record (a Sale or an outgoing StudService),
// covering all five cash income types (deposit, remaining purchase price,
// transport, boarding, stud fee). Like the Puppy Record, "download" is the
// browser's own Print → Save as PDF — no vendored PDF library.
//
// Query params:
//   source = 'sale' | 'stud'   which income record this bills
//   id     = <record id>
//   doc    = 'invoice' | 'receipt'  (default 'invoice')
//   cfg    = URL-encoded JSON built by the Financials generator modal:
//            { number, notes, lines:[{key,mode:'full'|'partial',collected,dueDate}],
//              methods:[…]  (invoice: accepted methods),
//              payMethod, payReference  (receipt: method used) }
//
// The document never prints itself — the owner triggers the browser's
// Print → Save as PDF with the page's "Print / Save as PDF" button.
//
// Full vs Partial per line (owner's model):
//   • Partial → the line prints "<Name> (partial)" and its amount IS the entered
//     "collected" number.
//   • Full → the line prints at the record's full amount; on an invoice the
//     collected number is subtracted in the totals, on a receipt the line shows
//     the remaining (base − collected) and the collected is not printed.
// Line base amounts always come from incomeView.incomeLineItems so they stay
// truthful to the record; cfg only carries the per-line choices.
import { saleRepo } from '../data/saleRepo.js';
import { studServiceRepo } from '../data/studServiceRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { incomeLineItems } from '../data/incomeView.js';
import { getMyContactId, getInvoiceDefaults } from '../data/settings.js';
import { PLACEMENT_TYPE, FEE_STRUCTURE, INVOICE_LINE_LABELS, descriptor } from '../data/vocab.js';
import { esc, param, fmtMoney } from '../assets/ui.js';

const root = document.getElementById('inv-root');

// Footnote markers on a SALE invoice: deposit is refundability (*), the rest of
// the puppy-sale money is due-date driven (**). Stud fees carry neither.
const FOOTNOTE = { deposit: '*', balance: '**', transport: '**', boarding: '**' };
const NOTE_STAR = 'All deposit fees are non-refundable except where exclusions from contract apply.';
const NOTE_DBL = 'Transport, boarding, and purchase price balance due dates are calculated based on either expected pickup date or when puppy reaches nine weeks of age, whichever comes first. Date may change based on rescheduling pick-up dates. Any and all remaining unpaid fees are immediately due upon pickup if earlier than the above listed dates.';

function fmtDateMDY(ymd) {
  if (!ymd) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return ymd;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

const todayYMD = () => new Date().toISOString().slice(0, 10);
const money = (v) => fmtMoney(v) || '$0.00';
const numOf = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function payRow(label, value) {
  if (value == null || value === '') return '';
  return `<div class="inv-row"><span class="inv-k">${esc(label)}</span><span>${value}</span></div>`;
}

function partyCard(role, name, lines) {
  const detail = lines.filter(Boolean).join('<br>');
  return `<div class="inv-party">
    <div class="inv-party-role">${esc(role)}</div>
    <div class="inv-name">${name || '<span class="inv-empty">—</span>'}</div>
    ${detail ? `<div class="inv-detail">${detail}</div>` : ''}
  </div>`;
}

function parseCfg() {
  const raw = param('cfg');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function main() {
  const source = param('source') === 'stud' ? 'stud' : 'sale';
  const doc = param('doc') === 'receipt' ? 'receipt' : 'invoice';
  const id = param('id');
  const isReceipt = doc === 'receipt';

  if (!id) { root.innerHTML = '<p class="inv-empty">No record specified.</p>'; return; }

  const record = source === 'sale' ? await saleRepo.getById(id) : await studServiceRepo.getById(id);
  if (!record) { root.innerHTML = '<p class="inv-empty">Record not found.</p>'; return; }
  // The back button keeps its HTML default (financials.html?view=income) to
  // match its "← Back to Financials" label — the generator always opens this
  // page from the Financials hub.

  const dogId = source === 'sale' ? record.dog_id : record.our_dog_id;
  const recipientId = source === 'sale' ? record.buyer_contact_id : record.partner_contact_id;
  const [dog, recipient, kennels, myContact] = await Promise.all([
    dogId ? dogRepo.getById(dogId) : null,
    recipientId ? contactRepo.getById(recipientId) : null,
    kennelRepo.getAll({ includeArchived: true }),
    (() => { const cid = getMyContactId(); return cid ? contactRepo.getById(cid) : null; })()
  ]);
  if (source === 'sale' && dog && dog.litter_id) await litterRepo.getById(dog.litter_id);

  const ownKennel = (dog && dog.kennel_id && kennels.find((k) => k.id === dog.kennel_id))
    || kennels.find((k) => k.is_own_kennel && !k.is_archived)
    || null;

  // Base amounts by component key, always recomputed from the record.
  const baseByKey = new Map(incomeLineItems(source, record).map((it) => [it.component, it.amount]));

  // Config — from the generator, or a full-line default when the page is opened
  // directly (every cash line, full, nothing collected, no dates).
  let cfg = parseCfg();
  if (!cfg) {
    cfg = {
      number: (record.invoice_number || '').trim(),
      notes: (record.invoice_notes || '').trim(),
      lines: [...baseByKey.keys()].map((key) => ({ key, mode: 'full', collected: 0, dueDate: '' })),
      methods: getInvoiceDefaults().acceptedMethods,
      payMethod: record.payment_method || '',
      payReference: record.payment_reference || ''
    };
  }

  const isSale = source === 'sale';
  const rowsHtml = [];
  const markersUsed = new Set();
  let subtotal = 0;       // invoice: sum of printed line amounts
  let collectedFull = 0;  // invoice: already-collected on full lines (reduces balance)
  let paidTotal = 0;      // receipt: sum of amounts received

  for (const line of (cfg.lines || [])) {
    const base = baseByKey.get(line.key);
    if (base == null || base <= 0) continue;
    const collected = numOf(line.collected);
    const partial = line.mode === 'partial';
    let label = INVOICE_LINE_LABELS[line.key] || line.key;
    const marker = isSale && !isReceipt ? (FOOTNOTE[line.key] || '') : '';
    if (marker) markersUsed.add(marker);

    if (isReceipt) {
      const amount = partial ? collected : Math.max(base - collected, 0);
      // Partial → "(partial)". Full but with a prior partial payment already
      // collected → this line is the remaining balance, so print "(balance)".
      if (partial) label += ' (partial)';
      else if (collected > 0) label += ' (balance)';
      paidTotal += amount;
      rowsHtml.push(`<tr><td>${esc(label)}</td><td class="num">${esc(money(amount))}</td></tr>`);
    } else {
      const amount = partial ? collected : base;
      if (partial) label += ' (partial)';
      if (!partial) collectedFull += collected;
      subtotal += amount;
      // Deposits are always due immediately; the calculated due date (expected
      // pickup / nine-weeks-of-age) applies only to the other four line types.
      const due = line.key === 'deposit'
        ? 'Immediately'
        : (line.dueDate ? esc(fmtDateMDY(line.dueDate)) : '<span class="faint">—</span>');
      rowsHtml.push(`<tr>
        <td>${esc(label)}${marker ? `<sup>${esc(marker)}</sup>` : ''}</td>
        <td>${due}</td>
        <td class="num">${esc(money(amount))}</td>
      </tr>`);
    }
  }

  const balance = Math.max(subtotal - collectedFull, 0);
  const itemsBody = rowsHtml.length
    ? rowsHtml.join('')
    : `<tr><td colspan="${isReceipt ? 2 : 3}" class="inv-empty">No line items.</td></tr>`;

  const foot = isReceipt
    ? `<tr class="total"><td>Total paid</td><td class="num">${esc(money(paidTotal))}</td></tr>`
    : `<tr><td colspan="2">Subtotal</td><td class="num">${esc(money(subtotal))}</td></tr>
       ${collectedFull > 0 ? `<tr><td colspan="2">Less amount already collected</td><td class="num">−${esc(money(collectedFull))}</td></tr>` : ''}
       <tr class="total"><td colspan="2">Balance</td><td class="num">${esc(money(balance))}</td></tr>`;

  // Document number.
  const docNumber = (cfg.number || '').trim()
    || `${isReceipt ? 'RCT' : 'INV'}-${todayYMD().replace(/-/g, '')}-${String(id).slice(0, 6).toUpperCase()}`;

  // Payment block.
  let payBox = '';
  if (isReceipt) {
    const paymentDate = isSale
      ? (record.balance_paid_date || record.deposit_date || record.sale_date || '')
      : (record.returned_date || record.sent_date || '');
    const rows = [
      payRow('Payment method', cfg.payMethod ? esc(cfg.payMethod) : ''),
      payRow('Reference', cfg.payReference ? esc(cfg.payReference) : ''),
      payRow('Payment date', paymentDate ? esc(fmtDateMDY(paymentDate)) : '')
    ].filter(Boolean).join('');
    const note = cfg.payMethod ? `Paid via ${esc(cfg.payMethod)}. Thank you!` : 'Thank you for your payment!';
    payBox = `<div class="inv-pay"><h3>Payment received</h3>${rows}<p class="inv-detail" style="margin:6px 0 0;">${note}</p></div>`;
  } else {
    const methods = (cfg.methods || []).filter(Boolean);
    if (methods.length) {
      const boxes = methods.map((m) => `<span class="inv-method">&#9633; ${esc(m)}</span>`).join('');
      payBox = `<div class="inv-pay"><h3>Payment may be made using one of the following methods:</h3>
        <div class="inv-methods">${boxes}</div></div>`;
    }
  }

  // Issuer / recipient.
  const issuerName = esc(ownKennel?.kennel_name || 'Kennel');
  const issuerLines = [
    myContact && myContact.name && myContact.name !== ownKennel?.kennel_name ? esc(myContact.name) : '',
    ownKennel?.location ? esc(ownKennel.location) : '',
    myContact?.email ? esc(myContact.email) : '',
    myContact?.phone ? esc(myContact.phone) : '',
    ownKennel?.website ? esc(ownKennel.website) : ''
  ];
  const logoHtml = ownKennel?.logo_data_url
    ? `<img class="inv-logo" src="${esc(ownKennel.logo_data_url)}" alt="${issuerName} logo">`
    : '';
  const recipientLines = recipient ? [
    recipient.address ? esc(recipient.address) : '',
    recipient.email ? esc(recipient.email) : '',
    recipient.phone ? esc(recipient.phone) : ''
  ] : [];

  const reText = isSale
    ? `Re: ${dog?.call_name || 'Puppy'}${dog?.registered_name ? ` (${dog.registered_name})` : ''} — ${descriptor(PLACEMENT_TYPE, record.placement_type).label} placement`
    : `Re: Stud service — ${dog?.call_name || 'our dog'} × ${recipient?.name || 'partner'}${record.fee_structure ? ` (${descriptor(FEE_STRUCTURE, record.fee_structure).label})` : ''}`;

  // Footer: custom note, then the standing disclaimers whose markers appear above.
  const footnotes = [];
  if (markersUsed.has('*')) footnotes.push(`<div><sup>*</sup> ${esc(NOTE_STAR)}</div>`);
  if (markersUsed.has('**')) footnotes.push(`<div><sup>**</sup> ${esc(NOTE_DBL)}</div>`);

  document.title = `${isReceipt ? 'Receipt' : 'Invoice'} ${docNumber} — KennelOS`;

  root.innerHTML = `
    <div class="inv-top">
      <div class="inv-issuer">
        ${logoHtml}
        <div>
          <h1>${issuerName}</h1>
          ${issuerLines.filter(Boolean).length ? `<div class="inv-sub">${issuerLines.filter(Boolean).join('\n')}</div>` : ''}
        </div>
      </div>
      <div class="inv-meta">
        <div class="inv-doctype">${isReceipt ? 'Receipt' : 'Invoice'}</div>
        <div class="inv-line"><strong>#${esc(docNumber)}</strong></div>
        <div class="inv-line">Date ${esc(fmtDateMDY(todayYMD()))}</div>
        ${isReceipt ? '<div class="inv-paid-stamp">Paid</div>' : ''}
      </div>
    </div>

    <div class="inv-parties">
      ${partyCard(isReceipt ? 'Received from' : 'Bill to', recipient ? esc(recipient.name) : '', recipientLines)}
    </div>

    <p class="inv-re">${esc(reText)}</p>

    <table class="inv-items">
      <thead>
        <tr>
          <th>Description</th>
          ${isReceipt ? '' : '<th>Due by</th>'}
          <th class="num">Amount</th>
        </tr>
      </thead>
      <tbody>${itemsBody}</tbody>
      <tfoot>${foot}</tfoot>
    </table>

    ${payBox}

    ${cfg.notes ? `<div class="inv-notes">${esc(cfg.notes)}</div>` : ''}
    ${footnotes.length ? `<div class="inv-footnotes">${footnotes.join('')}</div>` : ''}

    <div class="inv-generated">Generated ${esc(fmtDateMDY(todayYMD()))} · KennelOS</div>
  `;
}

document.getElementById('inv-print').addEventListener('click', () => window.print());

main();
