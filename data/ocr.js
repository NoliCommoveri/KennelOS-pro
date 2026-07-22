// ocr.js — fully-offline receipt text extraction via the vendored Tesseract.js.
// Ported from the Receipts app: the "auto-pull-out text" behind the receipt
// capture widget (assets/receiptCapture.js) — scanning a receipt photo
// pre-fills amount/date/vendor on the expense form instead of typing them.
//
// Progressive enhancement: everything is lazy — Tesseract (≈7 MB) only loads the
// first time you actually scan, and every failure path degrades to manual entry
// so the app never breaks if OCR can't run (old device, no wasm SIMD, etc.).
//
// The pieces are all vendored under vendor/tesseract/ and precached by the
// service worker, so scanning works with no network after first install:
//   - tesseract.esm.min.js  (main ESM entry)
//   - worker.min.js         (the recognition worker)
//   - tesseract-core-simd-lstm.wasm.js  (the LSTM OCR core)
//   - eng.traineddata.gz    (English model)
const BASE = new URL('../vendor/tesseract/', import.meta.url).href;

let _workerPromise = null; // memoized worker
let _unavailable = false;

// Load (once) and return a ready Tesseract worker, or throw if it can't.
async function getWorker(onProgress) {
  if (_workerPromise) return _workerPromise;
  _workerPromise = (async () => {
    const { default: Tesseract } = await import('../vendor/tesseract/tesseract.esm.min.js');
    // oem 1 = LSTM_ONLY → loads the smaller -simd-lstm core.
    const worker = await Tesseract.createWorker('eng', 1, {
      workerPath: `${BASE}worker.min.js`,
      corePath: BASE,        // directory → picks tesseract-core-simd-lstm.wasm.js
      langPath: BASE,        // eng.traineddata.gz lives here
      gzip: true,
      logger: (m) => {
        if (onProgress && m.status === 'recognizing text') onProgress(m.progress);
      }
    });
    return worker;
  })().catch((err) => {
    _workerPromise = null;
    _unavailable = true;
    throw err;
  });
  return _workerPromise;
}

// Best-effort probe: are the OCR assets present at all? (HEAD the core file.)
// Cheap and cached; used to decide whether to show the Scan button.
export async function isAvailable() {
  if (_unavailable) return false;
  if (!('WebAssembly' in window) || !('createImageBitmap' in window)) return false;
  try {
    const res = await fetch(`${BASE}eng.traineddata.gz`, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

// Recognize text on an image blob and pull out likely fields. Returns
// { rawText, amount, date, vendor, receiptNumber } — any field may be null
// when not confidently found. Throws only if the engine itself can't run
// (caller falls back to manual).
export async function scan(fileOrBlob, onProgress) {
  const worker = await getWorker(onProgress);
  const { data } = await worker.recognize(fileOrBlob);
  const rawText = data?.text || '';
  return { rawText, ...parseFields(rawText) };
}

// --- Field heuristics -----------------------------------------------------

const MONEY_RE = /\$?\s?(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+\.\d{2})/g;

function toNumber(moneyStr) {
  const n = Number(moneyStr.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Amount: prefer a number on a line that mentions a total; else the largest
// money-looking number on the receipt (the grand total usually is).
function parseAmount(text) {
  const lines = text.split(/\r?\n/);
  const totalHints = /\b(grand\s*total|total\s*due|amount\s*due|balance\s*due|total|amount|balance)\b/i;
  const skip = /\b(subtotal|sub\s*total|tax|change|tender|cash|card|tip)\b/i;
  let best = null;
  for (const line of lines) {
    if (!totalHints.test(line) || skip.test(line)) continue;
    const nums = line.match(MONEY_RE);
    if (!nums) continue;
    const val = toNumber(nums[nums.length - 1]);
    if (val != null && (best == null || val > best)) best = val;
  }
  if (best != null) return best;
  // Fallback: the largest money value anywhere.
  const all = (text.match(MONEY_RE) || []).map(toNumber).filter((n) => n != null);
  return all.length ? Math.max(...all) : null;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function pad(n) { return String(n).padStart(2, '0'); }

function ymd(y, m, d) {
  y = Number(y); m = Number(m); d = Number(d);
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

// Date: try ISO, US M/D/Y, and "Mon D, YYYY". Returns YYYY-MM-DD or null.
function parseDate(text) {
  let m;
  if ((m = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/))) return ymd(m[1], m[2], m[3]);
  if ((m = text.match(/\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})\b/))) return ymd(m[3], m[1], m[2]); // US M/D/Y
  if ((m = text.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/))) {
    const mm = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mm) return ymd(m[3], mm, m[2]);
  }
  return null;
}

// Vendor: the first line near the top that looks like a business name — mostly
// letters, not an address / phone / pure number.
function parseVendor(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const looksLikeAddress = /\d{2,}.*\b(st|ave|rd|blvd|ln|dr|suite|ste|#)\b/i;
  const looksLikePhone = /\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/;
  for (const line of lines.slice(0, 6)) {
    const letters = (line.match(/[A-Za-z]/g) || []).length;
    const digits = (line.match(/\d/g) || []).length;
    if (letters >= 3 && letters > digits && !looksLikeAddress.test(line) && !looksLikePhone.test(line)) {
      return line.replace(/\s{2,}/g, ' ').slice(0, 60);
    }
  }
  return null;
}

// Receipt/invoice/order/transaction number: whatever alphanumeric token
// follows one of those labels on the same line. Not every receipt prints
// one, so this is best-effort — a miss just leaves the field for manual entry.
const RECEIPT_NO_RE = /\b(?:receipt|invoice|order|transaction|trans|ref|reference|auth)\s*#?\s*(?:no\.?|num(?:ber)?)?\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9\-]{2,19})/i;

function parseReceiptNumber(text) {
  const m = text.match(RECEIPT_NO_RE);
  return m ? m[1] : null;
}

export function parseFields(text) {
  return {
    amount: parseAmount(text),
    date: parseDate(text),
    vendor: parseVendor(text),
    receiptNumber: parseReceiptNumber(text)
  };
}
