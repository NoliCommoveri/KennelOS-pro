// invoice.js — Invoice / Receipt view (§24). Renders the printable financial
// document for one income record: a Sale or an outgoing StudService (all five
// cash income types: deposit, remaining purchase price, transport, boarding, stud
// fee), or a waitlist family's application fee (Waitlist Spec §15.2). What the
// document SAYS is built by assets/invoiceDoc.js; this page draws it as HTML and
// "Download PDF" draws the same model as a real PDF file (assets/invoicePdf.js,
// vendored jsPDF). "Print" is the browser's own print.
//
// Query params:
//   source = 'sale' | 'stud' | 'waitlist'   which record this bills
//   id     = <record id>
//   doc    = 'invoice' | 'receipt'  (default 'invoice')
//   cfg    = URL-encoded JSON built by the Financials generator modal:
//            { number, notes, lines:[{key,mode:'full'|'partial',collected,dueDate?}],
//              (dueDate only when she changed it from the record's own date —
//              absent = read the record's due date live, invoiceDoc.saleDueDate)
//              methods:[…]  (invoice: accepted methods),
//              payMethod, payReference  (receipt: method used) }
//
// Full vs Partial per line (owner's model):
//   • Partial → the line prints "<Name> (partial)" and its amount IS the entered
//     "collected" number.
//   • Full → the line prints at the record's full amount; on an invoice the
//     collected number is subtracted in the totals, on a receipt the line shows
//     the remaining (base − collected) and the collected is not printed.
// Line base amounts always come from incomeView.incomeLineItems so they stay
// truthful to the record; cfg only carries the per-line choices.
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
  const itemsBody = d.rows.length
    ? d.rows.map((row) => r
        ? `<tr><td>${esc(row.label)}</td><td class="num">${esc(money(row.amount))}</td></tr>`
        : `<tr>
            <td>${esc(row.label)}${row.marker ? `<sup>${esc(row.marker)}</sup>` : ''}</td>
            <td>${row.due ? esc(row.due) : '<span class="faint">—</span>'}</td>
            <td class="num">${esc(money(row.amount))}</td>
          </tr>`).join('')
    : `<tr><td colspan="${r ? 2 : 3}" class="inv-empty">No line items.</td></tr>`;
  const foot = d.totals.map((t) => {
    const amount = t.amount < 0 ? `−${esc(money(-t.amount))}` : esc(money(t.amount));
    return `<tr${t.total ? ' class="total"' : ''}><td${r ? '' : ' colspan="2"'}>${esc(t.label)}</td><td class="num">${amount}</td></tr>`;
  }).join('');

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
          ${r ? '' : '<th>Due by</th>'}
          <th class="num">Amount</th>
        </tr>
      </thead>
      <tbody>${itemsBody}</tbody>
      <tfoot>${foot}</tfoot>
    </table>

    ${payBox}

    ${d.notes ? `<div class="inv-notes">${esc(d.notes)}</div>` : ''}
    ${d.footnotes.length ? `<div class="inv-footnotes">${d.footnotes.map((f) => `<div><sup>${esc(f.marker)}</sup> ${esc(f.text)}</div>`).join('')}</div>` : ''}

    <div class="inv-generated">Generated ${esc(fmtDateMDY(d.date))} · KennelOS</div>
  `;
}

async function main() {
  const req = request();
  if (!req.id) { root.innerHTML = '<p class="inv-empty">No record specified.</p>'; return; }
  // Opened from a waitlist family's page → back goes there, not to Financials.
  if (req.source === 'waitlist') {
    const back = document.getElementById('inv-back');
    back.href = `waitlist-entry.html?id=${encodeURIComponent(req.id)}`;
    back.textContent = '← Back to the family';
  }
  const d = await buildInvoiceDoc(req);
  if (!d) { root.innerHTML = '<p class="inv-empty">Record not found.</p>'; return; }
  render(d);
  // An invoice for a sale can go out with her payment link (Integrations plan §4).
  if (req.source === 'sale' && req.doc === 'invoice') {
    const btn = document.getElementById('inv-pay-link');
    btn.hidden = false;
    btn.addEventListener('click', async () => {
      try {
        const { openPaymentRequest } = await import('../assets/paymentRequestUI.js');
        await openPaymentRequest({ saleId: req.id });
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
