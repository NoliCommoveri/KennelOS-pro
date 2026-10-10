// pedigreeReader.js — gets positioned words out of a pedigree file for
// data/pedigreeParse.js. Browser-only (PDF.js, canvas, OCR); everything it
// returns is plain data.
//
//   - A PDF with a text layer (an AKC PDF, most pedigree software) is read
//     exactly, from the text PDF.js finds on page 1.
//   - A PDF that's only a picture (a scan or photo saved as PDF), or an image
//     file, is rendered and run through the offline OCR in data/ocr.js —
//     best-effort, so the review screen matters more there.
//
// PDF.js (vendor/pdfjs/, Apache-2.0) and the OCR engine both load only when a
// file is actually read; neither is part of any normal page load.
import { recognizeWords } from './ocr.js';

const PDFJS = new URL('../vendor/pdfjs/pdf.min.mjs', import.meta.url).href;
const PDFJS_WORKER = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
const OCR_WIDTH = 2048; // render width for OCR; small pedigree print needs the pixels
const MIN_TEXT_ITEMS = 20; // fewer than this on a page means it's a picture

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return lib;
    }).catch((e) => { pdfjsPromise = null; throw e; });
  }
  return pdfjsPromise;
}

async function ocrCanvas(canvas, scale, onProgress) {
  const words = await recognizeWords(canvas, onProgress);
  return words.map((w) => ({ ...w, x: w.x / scale, y: w.y / scale, w: w.w / scale, h: w.h / scale }));
}

// file: a File (PDF or image). Returns { source: 'text' | 'ocr', page: { width, height },
// words: [{ text, x, y, w, h, conf? }], pages }.
export async function readPedigreeFile(file, { onProgress } = {}) {
  if (file.type.startsWith('image/')) {
    const bmp = await createImageBitmap(file);
    const scale = Math.max(1, OCR_WIDTH / bmp.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const g = canvas.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return { source: 'ocr', page: { width: bmp.width, height: bmp.height }, words: await ocrCanvas(canvas, scale, onProgress), pages: 1 };
  }

  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  try {
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items.filter((it) => it.str && it.str.trim());
    if (items.length >= MIN_TEXT_ITEMS) {
      // PDF space is bottom-up; flip to top-left with each item's top edge as y.
      const words = items.map((it) => {
        const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
        const h = it.height || Math.hypot(it.transform[2], it.transform[3]);
        return { text: it.str, x, y: y - h, w: it.width, h };
      });
      return { source: 'text', page: { width: vp.width, height: vp.height }, words, pages: doc.numPages };
    }
    const scale = OCR_WIDTH / vp.width;
    const view = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(view.width);
    canvas.height = Math.round(view.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: view }).promise;
    return { source: 'ocr', page: { width: vp.width, height: vp.height }, words: await ocrCanvas(canvas, scale, onProgress), pages: doc.numPages };
  } finally {
    doc.destroy();
  }
}
