// invoice.js — Invoice / Receipt view (§24). Renders the printable financial
// document: a family's (a waitlist entry and the sale it goes toward, Payment
// Schedule plan §6) or a stud service's. What the document SAYS is built by
// assets/invoiceDoc.js; this page draws it as HTML and "Download PDF" draws the same
// model as a real PDF file (assets/invoicePdf.js, vendored jsPDF). "Print" is the
// browser's own print.
//
// Query params:
//   source = 'family' (with entry=<id> or sale=<id>) | 'stud' (with id=<id>); the
//            older 'sale' / 'waitlist' with id=<id> read as that sale's or entry's family
//   doc    = 'invoice' | 'receipt'  (default 'invoice')
//   cfg    = URL-encoded JSON from the generator:
//            family: { v: 2, pick?, lines?: [{ ref, amount? }] (invoice: each line's
//              ref, amount = a typed partial), money?: [{ ref, key? }] (receipt: the
//              money ticked), number, notes, methods (invoice), payMethod,
//              payReference (receipt: for a deposit or paid-in-full with none) }
//              (data/familyMoney.js resolvePick / documentLines)
//            stud: { number, notes, lines: [{ key, mode: 'full'|'partial', collected,
//              dueDate? }], methods, payMethod, payReference }: Partial prints
//              "(partial)" and the amount typed; Full prints the whole fee and takes
//              what was collected off (an invoice) or prints what's left (a receipt).
import { buildInvoiceDoc, fmtDateMDY, money } from '../assets/invoiceDoc.js';
import { esc, param } from '../assets/ui.js';

const root = document.getElementById('inv-root');

function parseCfg() {
  const raw = param('cfg');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

const request = () => ({
  source: param('source') || 'sale',
  id: param('id'),
  entry: param('entry'),
  sale: param('sale'),
  doc: param('doc') === 'receipt' ? 'receipt' : 'invoice',
  cfg: parseCfg()
});

function partyCard(role, name, lines) {
  const detail = lines.map(esc).join('<br>');
  return `<div class="inv-party">
    <div class="inv-party-role">${esc(role)}</div>
    <div class="inv-name">${name ? esc(name) : '<span class="inv-empty">—</span>'}</div>
    ${detail ? `<div class="inv-detail">${detail}</div>` : ''}
  </div>`;
}

function render(d) {
  const r = d.isReceipt;
  // The middle column: an invoice's Due by, a receipt's Received (date and method),
  // or none (a stud receipt).
  const col = d.colLabel ?? (r ? '' : 'Due by');
  const itemsBody = d.rows.length
    ? d.rows.map((row) => !col
        ? `<tr><td>${esc(row.label)}</td><td class="num">${esc(money(row.amount))}</td></tr>`
        : `<tr>
            <td>${esc(row.label)}${row.marker ? `<sup>${esc(row.marker)}</sup>` : ''}</td>
            <td>${row.due ? esc(row.due) : '<span class="faint">—</span>'}</td>
            <td class="num">${esc(money(row.amount))}</td>
          </tr>`).join('')
    : `<tr><td colspan="${col ? 3 : 2}" class="inv-empty">No line items.</td></tr>`;
  const foot = d.totals.map((t) => {
    const amount = t.amount < 0 ? `−${esc(money(-t.amount))}` : esc(money(t.amount));
    return `<tr${t.total ? ' class="total"' : ''}><td${col ? ' colspan="2"' : ''}>${esc(t.label)}</td><td class="num">${amount}</td></tr>`;
  }).join('');
  const summary = d.summary?.length
    ? `<table class="inv-summary"><caption>Account summary</caption>${d.summary.map((t) => `<tr><td>${esc(t.label)}</td><td class="num">${esc(money(t.amount))}</td></tr>`).join('')}</table>`
    : '';

  let payBox = '';
  if (d.pay) {
    const rows = d.pay.rows.map(([k, v]) => `<div class="inv-row"><span class="inv-k">${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
    const methods = d.pay.methods.length
      ? `<div class="inv-methods">${d.pay.methods.map((m) => `<span class="inv-method">&#9633; ${esc(m)}</span>`).join('')}</div>` : '';
    const note = d.pay.note ? `<p class="inv-detail" style="margin:6px 0 0;white-space:pre-line;">${esc(d.pay.note)}</p>` : '';
    payBox = `<div class="inv-pay"><h3>${esc(d.pay.title)}</h3>${rows}${methods}${note}</div>`;
  }

  const logoHtml = d.issuer.logo ? `<img class="inv-logo" src="${esc(d.issuer.logo)}" alt="${esc(d.issuer.name)} logo">` : '';
  document.title = `${d.docType} ${d.number} — KennelOS`;
  root.innerHTML = `
    <div class="inv-top">
      <div class="inv-issuer">
        ${logoHtml}
        <div>
          <h1>${esc(d.issuer.name)}</h1>
          ${d.issuer.lines.length ? `<div class="inv-sub">${d.issuer.lines.map(esc).join('\n')}</div>` : ''}
        </div>
      </div>
      <div class="inv-meta">
        <div class="inv-doctype">${esc(d.docType)}</div>
        <div class="inv-line"><strong>#${esc(d.number)}</strong></div>
        <div class="inv-line">Date ${esc(fmtDateMDY(d.date))}</div>
        ${r ? '<div class="inv-paid-stamp">Paid</div>' : ''}
      </div>
    </div>

    <div class="inv-parties">
      ${partyCard(d.partyRole, d.recipient.name, d.recipient.lines)}
    </div>

    <p class="inv-re">${esc(d.re)}</p>

    <table class="inv-items">
      <thead>
        <tr>
          <th>Description</th>
          ${col ? `<th>${esc(col)}</th>` : ''}
          <th class="num">Amount</th>
        </tr>
      </thead>
      <tbody>${itemsBody}</tbody>
      <tfoot>${foot}</tfoot>
    </table>
    ${summary}

    ${payBox}

    ${d.notes ? `<div class="inv-notes">${esc(d.notes)}</div>` : ''}
    ${d.footnotes.length ? `<div class="inv-footnotes">${d.footnotes.map((f) => `<div><sup>${esc(f.marker)}</sup> ${esc(f.text)}</div>`).join('')}</div>` : ''}

    <div class="inv-generated">Generated ${esc(fmtDateMDY(d.date))} · KennelOS</div>
  `;
}

async function main() {
  const req = request();
  if (!req.id && !req.entry && !req.sale) { root.innerHTML = '<p class="inv-empty">No record specified.</p>'; return; }
  const d = await buildInvoiceDoc(req);
  if (!d) { root.innerHTML = '<p class="inv-empty">Record not found.</p>'; return; }
  // A waitlist family's document → back goes to their page, not to Financials.
  if (d.entryId && (req.source === 'waitlist' || req.entry)) {
    const back = document.getElementById('inv-back');
    back.href = `waitlist-entry.html?id=${encodeURIComponent(d.entryId)}`;
    back.textContent = '← Back to the family';
  }
  render(d);
  // An invoice with a sale can go out with her payment link (Integrations plan §4).
  if (d.saleId && req.doc === 'invoice') {
    const btn = document.getElementById('inv-pay-link');
    btn.hidden = false;
    btn.addEventListener('click', async () => {
      try {
        const { openPaymentRequest } = await import('../assets/paymentRequestUI.js');
        await openPaymentRequest({ saleId: d.saleId });
      } catch (e) {
        root.insertAdjacentHTML('afterbegin', `<div class="inline-error no-print">${esc(e.message || String(e))}</div>`);
      }
    });
  }
}

document.getElementById('inv-print').addEventListener('click', () => window.print());
document.getElementById('inv-pdf').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  try {
    const { downloadInvoicePdf } = await import('../assets/invoicePdf.js');
    await downloadInvoicePdf(request());
  } catch (e) {
    root.insertAdjacentHTML('afterbegin', `<div class="inline-error no-print">${esc(e.message || String(e))}</div>`);
  } finally {
    btn.disabled = false;
  }
});

main();
