// puppyRecordPdf.js — the Puppy Record's Share as PDF file (End-State guide §23):
// draws the same record model the page draws (pages/puppy-record.js recordModel /
// coverModel) as a real PDF with the vendored jsPDF, made on the device. It's the
// way out when the browser's print dialog won't open (an iPhone home-screen app):
// the file goes to the share sheet, where she can print it, save it to Files or
// send it. The page's own Print / Save as PDF is unchanged.
//
// Pro-only (PRO_ONLY_STANDALONE), like the Puppy Record page itself. Text goes
// through invoicePdf.pdfText (the standard PDF fonts cover Latin-1 only).
import { loadJsPdf, pdfText } from './invoicePdf.js';

const PAGE = { w: 612, h: 792, m: 36 }; // US Letter, points
const INK = [17, 24, 39];
const MUTED = [90, 99, 115];
const BORDER = [154, 163, 174];
const RULE = [195, 202, 211];
const LH = (size) => size * 1.25;

// Draw the input. `input` is { cover, records, filename }: cover null or
// coverModel's, records recordModel's, each record starting a new page. Returns
// the jsPDF document.
export function renderPuppyRecordPdf(input, JsPDF) {
  const pdf = new JsPDF({ unit: 'pt', format: 'letter' });
  const { w, h, m } = PAGE;
  const width = w - 2 * m;
  const bottom = h - m;
  let y = m;
  let started = false;

  const font = (style = 'normal', size = 9.5, color = INK) => {
    pdf.setFont('helvetica', style);
    pdf.setFontSize(size);
    pdf.setTextColor(...color);
  };
  const wrap = (t, maxW) => pdf.splitTextToSize(pdfText(t), maxW);
  const newPage = () => { pdf.addPage(); y = m; };
  // A new page when `need` points won't fit (and something is already on this one).
  const room = (need) => { if (y + need > bottom && y > m) newPage(); };
  const box = (x, top, bw, bh) => {
    pdf.setDrawColor(...BORDER);
    pdf.setLineWidth(0.75);
    pdf.roundedRect(x, top, bw, bh, 4, 4);
  };
  const rule = (x1, x2, at) => {
    pdf.setDrawColor(...RULE);
    pdf.setLineWidth(0.5);
    pdf.line(x1, at, x2, at);
  };
  const startDoc = () => { if (started) newPage(); started = true; };

  // "Label value" fields in side-by-side columns, from `top`. Measures only when
  // `draw` is false. → the height used.
  const fields = (cols, x, top, bw, draw) => {
    const gap = 14;
    const cw = (bw - gap * (cols.length - 1)) / Math.max(cols.length, 1);
    let tallest = 0;
    cols.forEach((col, i) => {
      const cx = x + i * (cw + gap);
      let cy = top;
      for (const f of col) {
        font('normal', 9.5, MUTED);
        const kw = pdf.getTextWidth(pdfText(f.k)) + 5;
        font(f.bold ? 'bold' : 'normal', 9.5);
        const lines = wrap(f.v, Math.max(cw - kw, 40));
        if (draw) {
          font('normal', 9.5, MUTED);
          pdf.text(pdfText(f.k), cx, cy + 9.5);
          font(f.bold ? 'bold' : 'normal', 9.5);
          pdf.text(lines, cx + kw, cy + 9.5);
        }
        cy += LH(9.5) * lines.length + 1.5;
      }
      tallest = Math.max(tallest, cy - top);
    });
    return tallest;
  };

  const emptyLine = (text, x, at) => {
    font('italic', 9.5, MUTED);
    pdf.text(pdfText(text), x, at + 9.5);
    return LH(9.5);
  };

  const LABEL_H = 22;
  const sectionLabel = (label) => {
    font('bold', 12);
    pdf.text(pdfText(label), w / 2, y + 13, { align: 'center' });
    y += LABEL_H;
  };

  // A boxed card of fields, its section label kept with it.
  const fieldsCard = (label, cols, emptyText) => {
    const inner = cols.length ? fields(cols, 0, 0, width - 20, false) : LH(9.5);
    const bh = inner + 12;
    room(LABEL_H + bh);
    sectionLabel(label);
    box(m, y, width, bh);
    if (cols.length) fields(cols, m + 10, y + 6, width - 20, true);
    else emptyLine(emptyText, m + 10, y + 6);
    y += bh + 6;
  };

  const parents = (label, list) => {
    const gap = 10;
    const pw = (width - gap) / 2;
    const iw = pw - 20;
    const innerH = (p) => {
      let hh = 12;
      if (p.unknown) return hh + LH(9.5);
      hh += p.cols.length ? fields(p.cols, 0, 0, iw, false) : LH(9.5);
      if (p.tests) { font('normal', 8.5); hh += 6 + wrap(p.tests, iw).length * LH(8.5); }
      return hh;
    };
    const ph = Math.max(...list.map(innerH)) + 12;
    room(LABEL_H + ph);
    sectionLabel(label);
    list.forEach((p, i) => {
      const x = m + i * (pw + gap);
      box(x, y, pw, ph);
      let cy = y + 6;
      font('bold', 7.5, MUTED);
      pdf.text(pdfText(p.role.toUpperCase()), x + 10, cy + 7);
      cy += 12;
      if (p.unknown) { emptyLine('Unknown', x + 10, cy); return; }
      cy += p.cols.length ? fields(p.cols, x + 10, cy, iw, true) : emptyLine('No details recorded.', x + 10, cy);
      if (p.tests) {
        rule(x + 10, x + pw - 10, cy + 2);
        font('normal', 8.5, MUTED);
        pdf.text(wrap(p.tests, iw), x + 10, cy + 12);
      }
    });
    y += ph + 6;
  };

  // Health History: the three columns as the page deals them, each column flowing
  // onto the next page on its own when it runs out of room.
  const health = (label, columns) => {
    if (!columns.length) {
      room(LABEL_H + 16);
      sectionLabel(label);
      y += emptyLine('No health events to show.', m, y) + 6;
      return;
    }
    const gap = 8;
    const cw = (width - 2 * gap) / 3;
    const iw = cw - 16;
    const itemLines = (it) => {
      font('normal', 8.5);
      const lbl = wrap(it.label, iw);
      font('normal', 8);
      return { lbl, vet: it.vet.map((v) => wrap(v, iw)), dates: wrap(it.dates, iw), notes: it.notes ? wrap(it.notes, iw) : [] };
    };
    const cardH = (card) => card.items.reduce((hh, it) => {
      const l = itemLines(it);
      return hh + 4 + l.lbl.length * LH(8.5) + (l.vet.flat().length + l.dates.length + l.notes.length) * LH(8);
    }, 20) + 6;
    const firstH = Math.min(...columns.filter((c) => c.length).map((c) => cardH(c[0])));
    room(LABEL_H + firstH);
    sectionLabel(label);
    const startPage = pdf.getCurrentPageInfo().pageNumber;
    let end = { page: startPage, y };
    columns.forEach((cards, ci) => {
      const x = m + ci * (cw + gap);
      let page = startPage;
      let cy = y;
      for (const card of cards) {
        const ch = cardH(card);
        if (cy + ch > bottom && cy > m) {
          page += 1;
          cy = m;
          while (pdf.getNumberOfPages() < page) pdf.addPage();
        }
        pdf.setPage(page);
        box(x, cy, cw, ch);
        let iy = cy + 6;
        font('bold', 9.5);
        pdf.text(pdfText(card.title), x + 8, iy + 9);
        iy += 14;
        card.items.forEach((it, ii) => {
          const l = itemLines(it);
          if (ii) rule(x + 8, x + cw - 8, iy + 1);
          iy += 4;
          font('normal', 8.5);
          pdf.text(l.lbl, x + 8, iy + 8.5);
          iy += l.lbl.length * LH(8.5);
          font('normal', 8, MUTED);
          for (const v of l.vet) { pdf.text(v, x + 8, iy + 8); iy += v.length * LH(8); }
          pdf.text(l.dates, x + 8, iy + 8);
          iy += l.dates.length * LH(8);
          if (l.notes.length) {
            font('italic', 8, MUTED);
            pdf.text(l.notes, x + 8, iy + 8);
            iy += l.notes.length * LH(8);
          }
        });
        cy += ch + gap;
        if (page > end.page || (page === end.page && cy > end.y)) end = { page, y: cy };
      }
    });
    pdf.setPage(end.page);
    y = end.y - gap + 6;
  };

  const header = (r) => {
    if (r.logo) {
      try {
        const props = pdf.getImageProperties(r.logo);
        const s = Math.min(150 / props.width, 54 / props.height, 1);
        pdf.addImage(r.logo, props.fileType || 'PNG', w / 2 - (props.width * s) / 2, y, props.width * s, props.height * s);
        y += props.height * s + 6;
      } catch { /* an unreadable logo is left off, never fatal */ }
    }
    font('bold', 18);
    const title = wrap(r.title, width);
    pdf.text(title, w / 2, y + 16, { align: 'center' });
    y += 22 + (title.length - 1) * LH(18);
    if (r.sub) { font('bold', 12, MUTED); pdf.text(pdfText(r.sub), w / 2, y + 11, { align: 'center' }); y += 15; }
    if (r.generated) { font('normal', 8, MUTED); pdf.text(pdfText(r.generated), w / 2, y + 8, { align: 'center' }); y += 12; }
    y += 4;
  };

  // The breeder's cover page: a four-column table.
  const cover = (c) => {
    startDoc();
    header({ title: c.title, sub: c.label, generated: c.generated });
    const widths = [0.24, 0.24, 0.26, 0.26].map((f) => f * width);
    const xs = widths.map((_, i) => m + widths.slice(0, i).reduce((a, b) => a + b, 0));
    const pad = 6;
    const head = () => {
      font('bold', 7.5, MUTED);
      ['PUPPY', 'FAMILY', 'DONE', 'MISSING'].forEach((t, i) => pdf.text(t, xs[i] + pad, y + 10));
      y += 16;
      rule(m, m + width, y);
    };
    head();
    for (const r of c.rows) {
      const cell = (parts, i) => parts.map(([text, style, size, color]) => { font(style, size, color); return { lines: wrap(text, widths[i] - 2 * pad), style, size, color }; });
      const cells = [
        cell([[r.name, 'bold', 9.5, INK], [r.status, 'normal', 8.5, MUTED]], 0),
        cell(r.family ? [[r.family, 'normal', 9.5, INK], ...(r.dropoff ? [[r.dropoff, 'normal', 8.5, MUTED]] : [])] : [['No sale', 'italic', 9.5, MUTED]], 1),
        cell([[r.done || '-', 'normal', 9.5, INK]], 2),
        cell([[r.missing, 'bold', 9.5, INK]], 3)
      ];
      const rh = Math.max(...cells.map((parts) => parts.reduce((a, p) => a + p.lines.length * LH(p.size), 0))) + 2 * pad;
      if (y + rh > bottom) { newPage(); head(); }
      cells.forEach((parts, i) => {
        let cy = y + pad;
        for (const p of parts) {
          font(p.style, p.size, p.color);
          pdf.text(p.lines, xs[i] + pad, cy + p.size);
          cy += p.lines.length * LH(p.size);
        }
      });
      y += rh;
      rule(m, m + width, y);
    }
  };

  if (input.cover) cover(input.cover);
  for (const r of input.records) {
    startDoc();
    header(r);
    for (const s of r.sections) {
      if (s.kind === 'info') fieldsCard(s.label, s.cols, 'No details recorded.');
      else if (s.kind === 'parents') parents(s.label, s.parents);
      else if (s.kind === 'health') health(s.label, s.columns);
      else if (s.kind === 'buyer') fieldsCard(s.label, s.cols, '');
    }
  }
  return pdf;
}

// The record(s) as a PDF File for the share sheet. Made on the device; nothing is sent.
export async function puppyRecordPdfFile(input) {
  const JsPDF = await loadJsPdf();
  return new File([renderPuppyRecordPdf(input, JsPDF).output('blob')], input.filename, { type: 'application/pdf' });
}
