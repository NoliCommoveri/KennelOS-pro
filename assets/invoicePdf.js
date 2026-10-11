// invoicePdf.js — draws an invoice / receipt document model (assets/invoiceDoc.js)
// as a real PDF file with the vendored jsPDF (Waitlist Spec §15.2, decided: jsPDF).
// The same model drives the HTML page (invoice.js), so the two never disagree.
//
// jsPDF is loaded only when a PDF is made: vendor/jspdf.umd.min.js is the
// self-contained UMD build (its ES build needs a bundler), which sets
// globalThis.jspdf when imported as a module. Pro-only (PRO_ONLY_STANDALONE), and
// precached like every vendor file so it works offline.
//
// The standard PDF fonts only cover Latin-1, so text is passed through pdfText()
// (dashes, quotes and the like mapped to plain equivalents; anything else that
// can't be drawn becomes "?").

const PAGE = { w: 612, h: 792, margin: 48 }; // US Letter, points
const GRAY = [102, 112, 133];
const LINE = [214, 219, 228];
const GREEN = [22, 128, 61];

let jsPdfCtor = null;

// The jsPDF constructor, loading the vendored library on first use.
export async function loadJsPdf() {
  if (jsPdfCtor) return jsPdfCtor;
  if (!globalThis.jspdf) await import('../vendor/jspdf.umd.min.js');
  jsPdfCtor = globalThis.jspdf && globalThis.jspdf.jsPDF;
  if (!jsPdfCtor) throw new Error('The PDF library didn\'t load.');
  return jsPdfCtor;
}

const REPLACE = {
  '—': '-', '–': '-', '−': '-', '‘': "'", '’': "'", '“': '"', '”': '"',
  '…': '...', '×': 'x', '•': '·', ' ': ' '
};

// Text the standard fonts can draw.
export function pdfText(s) {
  return [...String(s ?? '')].map((c) => {
    if (REPLACE[c] !== undefined) return REPLACE[c];
    const code = c.codePointAt(0);
    if (c === '\n' || c === '\t') return c;
    return code < 32 ? '' : code > 255 ? '?' : c;
  }).join('');
}

const money = (v) => {
  const n = Number(v);
  return (Number.isFinite(n) ? n : 0).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
};
const fmtDateMDY = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd || '');
  return m ? `${m[2]}/${m[3]}/${m[1]}` : (ymd || '');
};

// Draw the model. Returns the jsPDF document (call .save(name) or
// .output('blob')).
export function renderInvoicePdf(d, JsPDF) {
  const pdf = new JsPDF({ unit: 'pt', format: 'letter' });
  const { w, h, margin: m } = PAGE;
  const right = w - m;
  const width = w - 2 * m;
  let y = m;

  const font = (style = 'normal', size = 10, color = [17, 24, 39]) => {
    pdf.setFont('helvetica', style);
    pdf.setFontSize(size);
    pdf.setTextColor(...color);
  };
  const lineH = (size) => size * 1.25;
  // Start a new page when `needed` points won't fit above the bottom margin.
  const room = (needed) => {
    if (y + needed > h - m - 20) { pdf.addPage(); y = m; }
  };
  const wrap = (text, maxW) => pdf.splitTextToSize(pdfText(text), maxW);

  // --- Header: logo + issuer (left), document type + number + date (right) ---
  let left = m;
  if (d.issuer.logo) {
    try {
      const props = pdf.getImageProperties(d.issuer.logo);
      const scale = Math.min(64 / props.width, 64 / props.height, 1);
      pdf.addImage(d.issuer.logo, props.fileType || 'PNG', m, y, props.width * scale, props.height * scale);
      left = m + props.width * scale + 12;
    } catch { /* an unreadable logo is left off, never fatal */ }
  }
  font('bold', 18);
  const nameLines = wrap(d.issuer.name, right - 170 - left);
  pdf.text(nameLines, left, y + 16);
  let ly = y + 16 + lineH(18) * (nameLines.length - 1);
  font('normal', 9.5, GRAY);
  for (const l of d.issuer.lines) { ly += lineH(9.5); pdf.text(pdfText(l), left, ly); }

  font('bold', 22);
  pdf.text(pdfText(d.docType.toUpperCase()), right, y + 18, { align: 'right' });
  font('bold', 10);
  pdf.text(pdfText(`#${d.number}`), right, y + 36, { align: 'right' });
  font('normal', 9.5, GRAY);
  pdf.text(`Date ${fmtDateMDY(d.date)}`, right, y + 50, { align: 'right' });
  let ry = y + 50;
  if (d.isReceipt) {
    pdf.setDrawColor(...GREEN);
    pdf.setLineWidth(1.5);
    pdf.roundedRect(right - 54, y + 58, 54, 20, 3, 3);
    font('bold', 11, GREEN);
    pdf.text('PAID', right - 27, y + 72, { align: 'center' });
    ry = y + 78;
  }
  y = Math.max(ly, ry, y + 64) + 18;

  // --- Recipient box ---
  font('normal', 10);
  const detail = d.recipient.lines.flatMap((l) => wrap(l, width - 24));
  const boxH = 18 + lineH(11) + detail.length * lineH(10) + 8;
  pdf.setDrawColor(...LINE);
  pdf.setLineWidth(0.75);
  pdf.roundedRect(m, y, width, boxH, 4, 4);
  font('bold', 7.5, GRAY);
  pdf.text(pdfText(d.partyRole.toUpperCase()), m + 12, y + 14);
  font('bold', 11);
  pdf.text(pdfText(d.recipient.name || '-'), m + 12, y + 14 + lineH(11));
  font('normal', 10, GRAY);
  detail.forEach((l, i) => pdf.text(l, m + 12, y + 14 + lineH(11) + (i + 1) * lineH(10)));
  y += boxH + 16;

  font('normal', 9.5, GRAY);
  const reLines = wrap(d.re, width);
  pdf.text(reLines, m, y);
  y += reLines.length * lineH(9.5) + 10;

  // --- Line items ---
  const amountW = 90;
  const dueW = d.isReceipt ? 0 : 90;
  const descW = width - amountW - dueW - 12;
  const dueX = m + descW + 12;
  font('bold', 7.5, GRAY);
  pdf.text('DESCRIPTION', m, y);
  if (!d.isReceipt) pdf.text('DUE BY', dueX, y);
  pdf.text('AMOUNT', right, y, { align: 'right' });
  y += 6;
  pdf.setDrawColor(...LINE);
  pdf.line(m, y, right, y);
  y += 14;
  if (!d.rows.length) {
    font('italic', 10, GRAY);
    pdf.text('No line items.', m, y);
    y += lineH(10) + 4;
  }
  for (const row of d.rows) {
    font('normal', 10.5);
    const label = wrap(`${row.label}${row.marker ? ` ${row.marker}` : ''}`, descW);
    room(label.length * lineH(10.5) + 10);
    pdf.text(label, m, y);
    if (!d.isReceipt) pdf.text(pdfText(row.due || '-'), dueX, y);
    pdf.text(pdfText(money(row.amount)), right, y, { align: 'right' });
    y += label.length * lineH(10.5) + 2;
    pdf.line(m, y, right, y);
    y += 14;
  }

  // --- Totals ---
  for (const t of d.totals) {
    room(30);
    const size = t.total ? 13 : 10.5;
    if (t.total) {
      pdf.setLineWidth(1.5);
      pdf.line(right - 240, y - 9, right, y - 9);
      pdf.setLineWidth(0.75);
      y += 4;
    }
    font(t.total ? 'bold' : 'normal', size);
    const amount = t.amount < 0 ? `-${money(-t.amount)}` : money(t.amount);
    pdf.text(pdfText(t.label), right - 110, y, { align: 'right' });
    pdf.text(pdfText(amount), right, y, { align: 'right' });
    y += lineH(size) + 2;
  }
  y += 8;

  // --- Payment box ---
  if (d.pay) {
    font('normal', 10);
    const noteLines = d.pay.note ? wrap(d.pay.note, width - 24) : [];
    const methodRows = d.pay.methods.length ? Math.ceil(d.pay.methods.length / 3) : 0;
    const payH = 16 + lineH(10) + d.pay.rows.length * lineH(10) + methodRows * lineH(10) + noteLines.length * lineH(10) + 10;
    room(payH + 10);
    pdf.setDrawColor(...LINE);
    pdf.roundedRect(m, y, width, payH, 4, 4);
    let py = y + 18;
    font('bold', 10);
    pdf.text(pdfText(d.pay.title), m + 12, py);
    for (const [k, v] of d.pay.rows) {
      py += lineH(10);
      font('normal', 10, GRAY);
      pdf.text(pdfText(k), m + 12, py);
      font('normal', 10);
      pdf.text(pdfText(v), m + 140, py);
    }
    d.pay.methods.forEach((method, i) => {
      const col = i % 3;
      if (col === 0) py += lineH(10);
      const x = m + 12 + col * ((width - 24) / 3);
      pdf.setDrawColor(...GRAY);
      pdf.rect(x, py - 8, 8, 8);
      font('normal', 10);
      pdf.text(pdfText(method), x + 13, py);
    });
    if (noteLines.length) {
      font('normal', 10, GRAY);
      pdf.text(noteLines, m + 12, py + lineH(10));
    }
    y += payH + 14;
  }

  if (d.notes) {
    font('normal', 10);
    const lines = wrap(d.notes, width);
    room(lines.length * lineH(10));
    pdf.text(lines, m, y);
    y += lines.length * lineH(10) + 10;
  }
  for (const f of d.footnotes) {
    font('normal', 8, GRAY);
    const lines = wrap(`${f.marker} ${f.text}`, width);
    room(lines.length * lineH(8));
    pdf.text(lines, m, y);
    y += lines.length * lineH(8) + 4;
  }

  font('normal', 8, [150, 156, 170]);
  pdf.text(`Generated ${fmtDateMDY(d.date)} · KennelOS`, w / 2, h - m + 10, { align: 'center' });
  return pdf;
}

// Build and download one document. `req` is { source, id, doc, cfg } as for
// assets/invoiceDoc.js's buildInvoiceDoc.
export async function downloadInvoicePdf(req) {
  const [{ buildInvoiceDoc }, JsPDF] = await Promise.all([import('./invoiceDoc.js'), loadJsPdf()]);
  const d = await buildInvoiceDoc(req);
  if (!d) throw new Error('That record no longer exists.');
  renderInvoicePdf(d, JsPDF).save(d.filename);
  return d.filename;
}

// The same document as a PDF File, for the share sheet (Integrations plan §2.6:
// the invoice goes with the deposit request). Made on the device; nothing is sent.
export async function invoicePdfFile(req) {
  const [{ buildInvoiceDoc }, JsPDF] = await Promise.all([import('./invoiceDoc.js'), loadJsPdf()]);
  const d = await buildInvoiceDoc(req);
  if (!d) throw new Error('That record no longer exists.');
  return new File([renderInvoicePdf(d, JsPDF).output('blob')], d.filename, { type: 'application/pdf' });
}
