// pdfShare.js — hands a PDF the app made on the device to the share sheet (Print,
// Save to Files, send) where the device can share files, else downloads it. Used by
// the Puppy Record's Share as PDF and the Invoice page's PDF button (End-State guide
// §23, §24). Pro-only (PRO_ONLY_STANDALONE), like both pages.
//
// iPhone opens the share sheet only for a tap, and a share started after a long
// wait no longer counts as one: so pages make the file as soon as they're drawn,
// and a refusal (NotAllowedError) is passed back for the page to say "tap again".

// Can this device hand files to the share sheet (Web Share level 2)?
export function canShareFiles(file = null) {
  try {
    const probe = file || new File([''], 'probe.pdf', { type: 'application/pdf' });
    return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

// → 'shared' | 'cancelled' | 'downloaded'. Throws on any other failure, a
// NotAllowedError included (the tap no longer counts).
export async function shareOrDownload(file) {
  if (canShareFiles(file)) {
    try {
      await navigator.share({ files: [file], title: file.name.replace(/\.pdf$/i, '') });
      return 'shared';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled'; // she closed the share sheet
      throw e;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}

// The words for a failed share or download, given the button's label.
export function shareFailText(e, label) {
  return e?.name === 'NotAllowedError'
    ? `Your PDF is ready. Tap ${label} again.`
    : `The PDF didn't go through: ${e?.message || e}`;
}
