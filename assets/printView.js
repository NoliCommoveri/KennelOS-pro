// printView.js — the letterhead on a printed (or "Save as PDF") report (Reports
// plan, phase 1). Reports print through the browser's own dialog — no PDF
// library — with the print stylesheet in app.css hiding the app chrome. This
// module builds the header that only shows on paper: the kennel's logo and name,
// the report's title, what the report was narrowed to (date range, filters,
// search), and when it was generated.
//
// Which kennel heads the page: the active kennel when the app is scoped to one;
// else the only own kennel there is; else none (a multi-kennel program printing
// "All kennels" gets the title alone, plus "All kennels" in the details).
import { getActiveKennel, ownKennels, isScoped } from '../data/kennelScope.js';
import { esc, fmtDate } from './ui.js';
import { todayYMD } from '../data/dateUtils.js';

async function letterheadKennel() {
  const active = await getActiveKennel();
  if (active) return active;
  const own = await ownKennels();
  return own.length === 1 ? own[0] : null;
}

// The header's HTML. `details` are short "Label: value" lines (already plain text).
export async function printHeaderHtml({ title, details = [] } = {}) {
  const kennel = await letterheadKennel();
  const own = isScoped() ? [] : await ownKennels();
  const lines = [...details];
  if (!kennel && own.length > 1) lines.unshift('Kennels: All kennels');
  const logo = kennel && kennel.logo_data_url && /^data:image\//.test(kennel.logo_data_url)
    ? `<img class="print-logo" src="${esc(kennel.logo_data_url)}" alt="">` : '';
  return `
    <div class="print-head-row">
      ${logo}
      <div>
        ${kennel ? `<div class="print-kennel">${esc(kennel.kennel_name)}</div>` : ''}
        <div class="print-title">${esc(title || document.title.replace(/\s+—\s+KennelOS$/, ''))}</div>
      </div>
    </div>
    <div class="print-details">
      ${lines.map((l) => `<span>${esc(l)}</span>`).join('')}
      <span>Generated ${esc(fmtDate(todayYMD()))}</span>
    </div>`;
}

// Fill (or refresh) a `.print-header` element right before the dialog opens, so
// it always describes what is on screen at that moment. `getDetails` is called
// at print time.
export function wirePrintHeader(el, { title, getDetails = () => [] } = {}) {
  // `title` may be a function, read at print time (Year in Review's year changes).
  const fill = async () => { el.innerHTML = await printHeaderHtml({ title: typeof title === 'function' ? title() : title, details: getDetails() }); };
  window.addEventListener('beforeprint', fill);
  fill();
  return fill;
}

// The "Print / Save as PDF" button: refreshes the header, then opens the dialog.
export function printButton(fill, label = '🖨 Print / PDF') {
  const btn = document.createElement('button');
  btn.className = 'btn btn-sm no-print';
  btn.type = 'button';
  btn.textContent = label;
  btn.title = 'Print this report, or choose “Save as PDF” in the print dialog.';
  btn.addEventListener('click', async () => { await fill(); window.print(); });
  return btn;
}
