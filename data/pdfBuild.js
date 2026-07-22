// pdfBuild.js — photo(s) -> a single/multi-page PDF, vanilla, no library. A
// PDF can embed a JPEG directly via the DCTDecode filter, so no PDF library is
// needed: build the byte-accurate PDF ourselves. This is the "compress to
// reduce file size" step for a photo/screenshot upload — downscaling +
// re-encoding as JPEG keeps a filed document small without a visible quality
// loss on screen or print.
//
// Pipeline per image: createImageBitmap (this also normalizes iPhone
// HEIC -> decoded bitmap, which matters because raw HEIC doesn't embed
// cleanly and isn't universally viewable) -> draw to a canvas, downscaled so
// the long edge is <= PAGE_MAX px -> re-encode as JPEG. One page per image; a
// multi-photo capture becomes one multi-page PDF. The first image's bitmap
// also yields the document's list thumbnail (a separately-scaled, smaller
// JPEG data-URL — the list only ever needs a small preview).
//
// Uploaded PDFs skip this module entirely; they're stored via fileRepo as-is.

const PAGE_MAX = 2000;    // px, longest edge of a page image
const PAGE_QUALITY = 0.8;
const THUMB_MAX = 320;    // px, longest edge of the list thumbnail
const THUMB_QUALITY = 0.7;

async function canvasFrom(bitmap, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  return { canvas, w, h };
}

function canvasToJpegBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode JPEG.'))), 'image/jpeg', quality);
  });
}

// files: array of File/Blob image sources (camera capture, screenshot, or
// library picks). Returns { blob (application/pdf), filename, thumbnail (data-URL) }.
export async function photosToPdf(files, { title = 'document' } = {}) {
  if (!files || files.length === 0) throw new Error('pdfBuild: at least one photo is required.');

  const pages = [];
  let thumbnail = '';

  for (let i = 0; i < files.length; i++) {
    const bitmap = await createImageBitmap(files[i]);
    try {
      const { canvas, w, h } = await canvasFrom(bitmap, PAGE_MAX);
      const jpegBlob = await canvasToJpegBlob(canvas, PAGE_QUALITY);
      const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
      pages.push({ w, h, jpegBytes });

      if (i === 0) {
        const thumb = await canvasFrom(bitmap, THUMB_MAX);
        const thumbBlob = await canvasToJpegBlob(thumb.canvas, THUMB_QUALITY);
        thumbnail = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(thumbBlob);
        });
      }
    } finally {
      bitmap.close?.();
    }
  }

  const chunks = buildPdfChunks(pages);
  const blob = new Blob(chunks, { type: 'application/pdf' });
  const filename = `${String(title || 'document').replace(/[^\w.-]+/g, '_') || 'document'}.pdf`;
  return { blob, filename, thumbnail };
}

// Assembles the raw PDF bytes as an array of Uint8Array chunks (fed straight
// into a Blob — no need to concatenate ourselves). Object layout:
//   1 = Catalog, 2 = Pages
//   for page i: (3+3i) = Page, (4+3i) = Image XObject, (5+3i) = Contents
function buildPdfChunks(pages) {
  const enc = new TextEncoder();
  const n = pages.length;
  const totalObjects = 2 + n * 3;
  const offsets = new Array(totalObjects + 1).fill(0); // 1-indexed
  const chunks = [];
  let offset = 0;

  function push(bytes) {
    chunks.push(bytes);
    offset += bytes.length;
  }

  const pageObjNum = (i) => 3 + i * 3;
  const imageObjNum = (i) => pageObjNum(i) + 1;
  const contentObjNum = (i) => pageObjNum(i) + 2;

  // Header + a binary marker comment (4 bytes >127) so tools that sniff the
  // first line recognize this as a binary-content PDF.
  push(enc.encode('%PDF-1.4\n'));
  push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

  const kids = [];
  for (let i = 0; i < n; i++) kids.push(`${pageObjNum(i)} 0 R`);

  offsets[1] = offset;
  push(enc.encode('1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n'));

  offsets[2] = offset;
  push(enc.encode(`2 0 obj\n<</Type/Pages/Kids[${kids.join(' ')}]/Count ${n}>>\nendobj\n`));

  for (let i = 0; i < n; i++) {
    const { w, h, jpegBytes } = pages[i];
    const pageNum = pageObjNum(i);
    const imgNum = imageObjNum(i);
    const contentNum = contentObjNum(i);

    offsets[pageNum] = offset;
    push(enc.encode(
      `${pageNum} 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${w} ${h}]` +
      `/Resources<</XObject<</Im0 ${imgNum} 0 R>>>>/Contents ${contentNum} 0 R>>\nendobj\n`
    ));

    offsets[imgNum] = offset;
    push(enc.encode(
      `${imgNum} 0 obj\n<</Type/XObject/Subtype/Image/Width ${w}/Height ${h}` +
      `/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ${jpegBytes.length}>>\nstream\n`
    ));
    push(jpegBytes);
    push(enc.encode('\nendstream\nendobj\n'));

    const contentBytes = enc.encode(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`);
    offsets[contentNum] = offset;
    push(enc.encode(`${contentNum} 0 obj\n<</Length ${contentBytes.length}>>\nstream\n`));
    push(contentBytes);
    push(enc.encode('\nendstream\nendobj\n'));
  }

  const xrefOffset = offset;
  let xref = `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= totalObjects; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  push(enc.encode(xref));
  push(enc.encode(`trailer\n<</Size ${totalObjects + 1}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF`));

  return chunks;
}
