// fieldGuideUI.js — the Field guide (Pro: e-sign through Firma). Opened from Contracts →
// Contract templates, it stays up while she places fields in Firma's editor (its own
// tab), so it opens outside the page:
//   1. a Picture-in-Picture window (Chrome, Edge), which floats over every window,
//      Firma's tab included;
//   2. else a small pop-up window she puts beside the editor;
//   3. else (pop-ups blocked) a panel on this page.
// Three tabs: Using Firma's editor (how to place a detail field, the Text type, a second
// signer, checking a send), Fields (every detail by its label in Firma's editor, how it's
// worked out and an example, by type or A–Z, with a filter; data/prefillGuide.js) and
// Sample sales (made-up sales set up different ways, each beside a sample contract's price
// section: the detail for each line, its value and how it's worked out; a line outlines
// in red the parts of the sale it comes from; data/prefillSamples.js).
//
//   openFieldGuide({ tab })  'help' (first, the default) | 'fields' | 'samples'
//                              → 'pip' | 'window' | 'panel'. Called from a click: a
//                              Picture-in-Picture window or a pop-up needs the tap.
import { guideRows, GUIDE_GROUPS, EXAMPLE_STORY } from '../data/prefillGuide.js';
import { SAMPLE_SALES, sampleSale } from '../data/prefillSamples.js';
import { esc } from './ui.js';

const TITLE = 'KennelOS field guide';
let open = null; // { win, show(tab), kind }

const CSS = `
:root, :host { --fg-bg:#ffffff; --fg-text:#1d2733; --fg-muted:#5b6878; --fg-line:#e2e6ec; --fg-soft:#f4f6f9; --fg-accent:#2f6f4f; --fg-accent-text:#ffffff; --fg-code:#eef2f6; color-scheme: light; }
@media (prefers-color-scheme: dark) {
  :root, :host { --fg-bg:#161b22; --fg-text:#e6ebf1; --fg-muted:#9aa7b6; --fg-line:#2b3440; --fg-soft:#1e252e; --fg-accent:#5fb98a; --fg-accent-text:#0d1410; --fg-code:#252e39; color-scheme: dark; }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--fg-bg); }
.fg { font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--fg-text); background: var(--fg-bg); container-type: inline-size; min-height: 100%; }
.fg-head { position: sticky; top: 0; z-index: 2; background: var(--fg-bg); border-bottom: 1px solid var(--fg-line); padding: 10px 14px 0; }
.fg-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-weight: 650; font-size: 15px; }
.fg-x { font: inherit; font-weight: 500; font-size: 13px; border: 1px solid var(--fg-line); background: var(--fg-soft); color: var(--fg-text); border-radius: 6px; padding: 3px 10px; cursor: pointer; }
.fg-tabs { display: flex; gap: 4px; margin-top: 8px; }
.fg-tabs button { font: inherit; border: 0; background: none; color: var(--fg-muted); padding: 6px 10px 8px; border-bottom: 2px solid transparent; cursor: pointer; }
.fg-tabs button[aria-selected="true"] { color: var(--fg-text); border-bottom-color: var(--fg-accent); font-weight: 600; }
.fg-body { padding: 12px 14px 24px; }
.fg-tools { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.fg-seg { display: inline-flex; border: 1px solid var(--fg-line); border-radius: 7px; overflow: hidden; }
.fg-seg button { font: inherit; font-size: 13px; border: 0; background: var(--fg-bg); color: var(--fg-text); padding: 5px 12px; cursor: pointer; }
.fg-seg button[aria-pressed="true"] { background: var(--fg-accent); color: var(--fg-accent-text); font-weight: 600; }
.fg-find { font: inherit; flex: 1 1 160px; min-width: 0; padding: 6px 10px; border: 1px solid var(--fg-line); border-radius: 7px; background: var(--fg-bg); color: var(--fg-text); }
.fg-note { color: var(--fg-muted); font-size: 13px; margin: 10px 0 6px; }
.fg-story { font-size: 13px; color: var(--fg-muted); margin: 0 0 8px; }
.fg-story summary { cursor: pointer; }
.fg-story p { margin: 6px 0 0; }
.fg-cols, .fg-row { display: grid; grid-template-columns: minmax(0, 34%) minmax(0, 1fr) 8.5rem; gap: 4px 12px; }
.fg-cols { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-muted); padding: 8px 0 4px; border-bottom: 1px solid var(--fg-line); }
.fg-row { padding: 8px 0; border-bottom: 1px solid var(--fg-line); align-items: start; }
.fg-group { margin: 16px 0 0; font-size: 14px; }
.fg-fills-head { margin: 2px 0 0; font-size: 12px; color: var(--fg-muted); }
.fg-label { font-weight: 600; overflow-wrap: anywhere; }
.fg-copy { font: inherit; font-size: 11px; font-weight: 500; margin-left: 4px; padding: 1px 6px; border: 1px solid var(--fg-line); border-radius: 5px; background: var(--fg-soft); color: var(--fg-muted); cursor: pointer; vertical-align: 1px; }
.fg-fills { display: block; font-weight: 400; font-size: 12px; color: var(--fg-muted); margin-top: 2px; }
.fg-how { color: var(--fg-text); }
.fg-ex { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.fg-ex code { font: 12.5px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--fg-code); padding: 1px 5px; border-radius: 4px; }
.fg-blank { color: var(--fg-muted); font-size: 12px; font-style: italic; }
.fg-exk { display: none; color: var(--fg-muted); font-size: 12px; margin-right: 4px; }
.fg-none { color: var(--fg-muted); padding: 16px 0; }
@container (max-width: 520px) {
  .fg-cols { display: none; }
  .fg-row { grid-template-columns: minmax(0, 1fr); }
  .fg-exk { display: inline; }
}
.fg-help h3 { font-size: 14px; margin: 16px 0 4px; }
.fg-help h3:first-child { margin-top: 4px; }
.fg-help p, .fg-help li { margin: 4px 0; }
.fg-help ul, .fg-help ol { padding-left: 20px; margin: 4px 0; }
.fg-help .fg-tip { background: var(--fg-soft); border: 1px solid var(--fg-line); border-radius: 8px; padding: 8px 10px; margin: 8px 0; }
.fg-pick { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.fg-pick select { font: inherit; flex: 1 1 240px; min-width: 0; padding: 6px 8px; border: 1px solid var(--fg-line); border-radius: 7px; background: var(--fg-bg); color: var(--fg-text); }
.fg-blurb { margin: 8px 0; color: var(--fg-muted); font-size: 13px; }
.fg-card { border: 1px solid var(--fg-line); border-radius: 10px; background: var(--fg-bg); }
.fg-card h4 { margin: 0; padding: 8px 12px; font-size: 13px; border-bottom: 1px solid var(--fg-line); background: var(--fg-soft); border-radius: 10px 10px 0 0; }
.fg-sale { position: sticky; top: var(--fg-head-h, 84px); z-index: 1; max-height: 40vh; overflow: auto; box-shadow: 0 6px 14px -10px rgba(0,0,0,.35); }
.fg-srow { display: grid; grid-template-columns: minmax(0, 40%) minmax(0, 1fr); gap: 2px 10px; padding: 5px 12px; margin: 3px 6px; border: 2px solid transparent; border-radius: 7px; font-size: 13px; }
.fg-srow span:first-child { color: var(--fg-muted); }
.fg-srow.fg-hot { border-color: var(--fg-hot); background: var(--fg-hot-bg); }
.fg-contract { margin-top: 12px; }
.fg-sec { padding: 4px 12px 10px; border-top: 1px solid var(--fg-line); }
.fg-sec:first-of-type { border-top: 0; }
.fg-sec h5 { margin: 10px 0 2px; font-size: 13px; }
.fg-sec .fg-secnote { margin: 0 0 6px; color: var(--fg-muted); font-size: 12px; }
.fg-line { scroll-margin-top: calc(var(--fg-head-h, 84px) + 40vh + 12px); display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 10px; padding: 7px 8px; margin: 0 -8px; border: 2px solid transparent; border-radius: 8px; cursor: pointer; }
.fg-line:hover, .fg-line.fg-hot { border-color: var(--fg-hot); }
.fg-ltext { font-weight: 600; }
.fg-lval { text-align: right; font-variant-numeric: tabular-nums; }
.fg-lfield { grid-column: 1 / -1; font-size: 12.5px; }
.fg-lfield b { font-weight: 600; }
.fg-lmath { grid-column: 1 / -1; font-size: 12.5px; color: var(--fg-muted); }
.fg-check { margin: 6px 0 0; font-size: 12.5px; color: var(--fg-ok); }
:root, :host { --fg-hot: #d93025; --fg-hot-bg: rgba(217,48,37,.07); --fg-ok: #2f6f4f; }
@media (prefers-color-scheme: dark) { :root, :host { --fg-hot: #ff6b5e; --fg-hot-bg: rgba(255,107,94,.12); --fg-ok: #5fb98a; } }
button:focus-visible, input:focus-visible, summary:focus-visible, select:focus-visible, .fg-line:focus-visible { outline: 2px solid var(--fg-accent); outline-offset: 2px; }
`;

// Using Firma's editor, in her words. What it says about the editor is what KennelOS
// has seen of it (Integrations plan §2.3a; End-State guide §32): Prefilled Data, one
// signer per field, the second signer, and the Send preview.
const HELP = `
<h3>Before you start</h3>
<ul>
  <li><strong>Use a computer.</strong> Firma's editor places fields with a mouse: drag one from its field list, or right-click on the page. A phone or tablet can't.</li>
  <li>Upload the contract PDF in <strong>Contract templates</strong> and pick what kind of contract it is. Then <strong>Place fields</strong> opens Firma's editor in a new tab.</li>
  <li>Anything already printed on your PDF (your name, your phone, the breed) needs no field.</li>
</ul>
<h3>Add a detail KennelOS fills in</h3>
<ol>
  <li>Add a <strong>Text</strong> field where the blank is on the page.</li>
  <li>Set its <strong>Prefilled Data</strong> to the KennelOS detail, by the label in the <strong>Fields</strong> tab (for example <em>Buyer · Email</em> or <em>Sale · Price</em>).</li>
  <li>Size the box to fit the longest value you expect.</li>
</ol>
<div class="fg-tip"><strong>Use the Text type for every detail</strong>, dates and money too. KennelOS sends each one as text (dates as 2026-11-24, money as 3000.00), and Firma's other field types may not take it.</div>
<h3>Which signer a field belongs to</h3>
<ul>
  <li>Every field belongs to one signer. Put the buyer's signature, initials and signing dates on the <strong>buyer's</strong> signer.</li>
  <li>Detail fields fill whichever signer they're on: KennelOS sends the same details to you and the buyer.</li>
  <li>Each "Buyer Initials" or "Date" spot on the page is a signing field for the buyer (initials, or the date they sign), not a KennelOS detail.</li>
</ul>
<h3>If you sign too: add a second signer</h3>
<ol>
  <li>In Firma's editor, add a second signer and give it your signature field (and a date field if your PDF has one).</li>
  <li>The order matters. <strong>I sign last</strong>: your signer is second, after the buyer. <strong>I sign first</strong>: your signer is first, and the buyer second.</li>
  <li>In Contract templates, pick the same choice for that template: <strong>I sign first</strong> or <strong>I sign last</strong>.</li>
  <li>When you send, sign from the contract's <strong>Sign first</strong> or <strong>Countersign</strong> button. It's still one e-sign contract.</li>
</ol>
<h3>Things a detail can't do</h3>
<ul>
  <li><strong>Tick a box.</strong> Pre-tick it in the PDF, or swap the boxes for a Text field (for example <em>Sale · Registration</em> reads Limited or Full).</li>
  <li><strong>Choose between packages.</strong> An Extra agreement is for one extra on your price list, so make one template per package, with that package's box ticked in its PDF.</li>
  <li><strong>Fill something KennelOS doesn't keep</strong>, like a reason for a delayed pickup. Leave it as a blank to write in.</li>
</ul>
<h3>Save, then check it</h3>
<ul>
  <li>Save in Firma's editor, then close its tab.</li>
  <li>On a real contract, <strong>Send for signature</strong> → <strong>Preview</strong>. It's free, and it lists every field on the template with the value KennelOS sent and whether Firma filled it, and says why a blank stayed blank.</li>
  <li>A detail with no value on that contract stays empty: add it where the preview says (the buyer's contact, the pup's record, the sale), then preview again.</li>
</ul>
`;

const groupTitle = new Map(GUIDE_GROUPS.map((g) => [g.key, g.title]));
const groupFills = new Map(GUIDE_GROUPS.map((g) => [g.key, g.fills]));

const exampleHtml = (value) => (value
  ? `<span class="fg-exk">e.g.</span><code>${esc(value)}</code>`
  : '<span class="fg-blank">Blank in this example</span>');

const rowHtml = (r, { example, fills }) => `<div class="fg-row" role="row">
    <div class="fg-label" role="cell">${esc(r.label)}<button type="button" class="fg-copy" data-copy="${esc(r.label)}" aria-label="Copy ${esc(r.label)}">Copy</button>${fills ? `<span class="fg-fills">${esc(fills)}</span>` : ''}</div>
    <div class="fg-how" role="cell">${esc(r.how)}</div>
    <div class="fg-ex" role="cell">${exampleHtml(example)}</div>
  </div>`;

const COLS = '<div class="fg-cols" role="row"><span role="columnheader">Label in the editor</span><span role="columnheader">How it\'s worked out</span><span role="columnheader">Example</span></div>';

// The Fields list for an order and a filter. → html
export function fieldsListHtml(order, find = '') {
  const q = find.trim().toLowerCase();
  const rows = guideRows().filter((r) => !q || [r.label, r.how, r.name, ...Object.values(r.examples)].some((t) => String(t).toLowerCase().includes(q)));
  if (!rows.length) return `<p class="fg-none">No field matches "${esc(find.trim())}".</p>`;
  if (order === 'az') {
    const sorted = [...rows].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
    return `<div role="table" aria-label="Fields A to Z">${COLS}${sorted.map((r) => rowHtml(r, {
      example: r.example, fills: r.groups.map((g) => groupFills.get(g)).join('; ')
    })).join('')}</div>`;
  }
  return GUIDE_GROUPS.map((g) => {
    const inGroup = rows.filter((r) => r.groups.includes(g.key));
    if (!inGroup.length) return '';
    return `<h3 class="fg-group">${esc(groupTitle.get(g.key))}</h3><p class="fg-fills-head">Filled on: ${esc(g.fills)}</p>
      <div role="table" aria-label="${esc(g.title)} fields">${COLS}${inGroup.map((r) => rowHtml(r, { example: r.examples[g.key] })).join('')}</div>`;
  }).join('');
}

// One sample sale: its Sale page's parts, and the sample contract's price section.
export function sampleHtml(id) {
  const x = sampleSale(id);
  const rows = x.saleRows.map((r) => `<div class="fg-srow" data-row="${esc(r.key)}"><span>${esc(r.label)}</span><span>${esc(r.value)}</span></div>`).join('');
  const line = (l) => `<div class="fg-line" tabindex="0" data-src="${esc(l.sources.join(' '))}">
      <span class="fg-ltext">${esc(l.text)}</span>
      <span class="fg-lval">${l.value ? `<code>${esc(l.value)}</code>` : '<span class="fg-blank">Blank on this sale</span>'}</span>
      <span class="fg-lfield">Place <b>${esc(l.label)}</b><button type="button" class="fg-copy" data-copy="${esc(l.label)}" aria-label="Copy ${esc(l.label)}">Copy</button></span>
      <span class="fg-lmath">${esc(l.value ? l.math : l.why || '')}</span>
    </div>`;
  const sections = x.sections.map((s) => `<div class="fg-sec"><h5>${esc(s.title)}</h5>${s.note ? `<p class="fg-secnote">${esc(s.note)}</p>` : ''}
      ${s.lines.map(line).join('')}${s.check ? `<p class="fg-check">Adds up: ${esc(s.check)}</p>` : ''}</div>`).join('');
  return `<p class="fg-blurb">${esc(x.blurb)}</p>
    <div class="fg-card fg-sale" aria-label="The sale"><h4>The sale, as its page shows it</h4>${rows}</div>
    <div class="fg-card fg-contract"><h4>A sample contract's price section: what to place on each line</h4>${sections}</div>`;
}

function shellHtml({ closable }) {
  return `<div class="fg">
    <div class="fg-head">
      <div class="fg-title"><span>Field guide</span>${closable ? '<button type="button" class="fg-x" data-fg-close>Close</button>' : ''}</div>
      <div class="fg-tabs" role="tablist">
        <button type="button" role="tab" id="fg-tab-help" aria-controls="fg-help" data-tab="help">Using Firma's editor</button>
        <button type="button" role="tab" id="fg-tab-fields" aria-controls="fg-fields" data-tab="fields">Fields</button>
        <button type="button" role="tab" id="fg-tab-samples" aria-controls="fg-samples" data-tab="samples">Sample sales</button>
      </div>
    </div>
    <div class="fg-body" id="fg-fields" role="tabpanel" aria-labelledby="fg-tab-fields">
      <div class="fg-tools">
        <div class="fg-seg" role="group" aria-label="Order">
          <button type="button" data-order="type">By type</button><button type="button" data-order="az">A–Z</button>
        </div>
        <input class="fg-find" type="search" placeholder="Find a field" aria-label="Find a field">
      </div>
      <p class="fg-note">In Firma's editor, add a <strong>Text</strong> field and set its Prefilled Data to one of these labels. Dates come as 2026-11-24, money as 3000.00.</p>
      <details class="fg-story"><summary>Where the examples come from</summary><p>${esc(EXAMPLE_STORY)}</p></details>
      <div class="fg-list" aria-live="polite"></div>
    </div>
    <div class="fg-body fg-help" id="fg-help" role="tabpanel" aria-labelledby="fg-tab-help" hidden>${HELP}</div>
    <div class="fg-body" id="fg-samples" role="tabpanel" aria-labelledby="fg-tab-samples" hidden>
      <div class="fg-pick"><label for="fg-sample">Sample sale</label>
        <select id="fg-sample">${SAMPLE_SALES.map((x) => `<option value="${esc(x.id)}">${esc(x.title)}</option>`).join('')}</select></div>
      <p class="fg-note">Tap a contract line to outline in red the parts of the sale it's worked out from. Every value is what KennelOS would fill on that sale.</p>
      <div class="fg-sample"></div>
    </div>
  </div>`;
}

// Wire one rendered guide. `root`: its document or shadow root; `clip`: the clipboard of
// the window it's in. → show(tab)
function wire(root, { clip, onClose }) {
  let order = 'type';
  const list = root.querySelector('.fg-list');
  const find = root.querySelector('.fg-find');
  const draw = () => {
    list.innerHTML = fieldsListHtml(order, find.value);
    root.querySelectorAll('[data-order]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.order === order)));
  };
  const show = (tab) => {
    root.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    for (const t of ['help', 'fields', 'samples']) root.querySelector(`#fg-${t}`).hidden = tab !== t;
    // The sale card sticks under the header, however tall the header wraps.
    const head = root.querySelector('.fg-head');
    root.querySelector('.fg')?.style.setProperty('--fg-head-h', `${head.offsetHeight}px`);
  };
  // Sample sales: pick one; a line (hovered, focused or tapped) outlines its sources.
  const sampleBox = root.querySelector('.fg-sample');
  const pick = root.querySelector('#fg-sample');
  const drawSample = () => { sampleBox.innerHTML = sampleHtml(pick.value); };
  let pinned = null;
  const outline = (lineEl) => {
    sampleBox.querySelectorAll('.fg-hot').forEach((el) => el.classList.remove('fg-hot'));
    if (!lineEl) return;
    lineEl.classList.add('fg-hot');
    const keys = new Set(lineEl.dataset.src.split(' ').filter(Boolean));
    let first = null;
    sampleBox.querySelectorAll('[data-row]').forEach((r) => { if (keys.has(r.dataset.row)) { r.classList.add('fg-hot'); first ||= r; } });
    first?.scrollIntoView({ block: 'nearest' });
  };
  pick.addEventListener('change', () => { pinned = null; drawSample(); });
  sampleBox.addEventListener('mouseover', (e) => { const l = e.target.closest('.fg-line'); if (l) outline(l); });
  sampleBox.addEventListener('mouseleave', () => outline(pinned));
  sampleBox.addEventListener('focusin', (e) => { const l = e.target.closest('.fg-line'); if (l) outline(l); });
  sampleBox.addEventListener('click', (e) => {
    if (e.target.closest('[data-copy]')) return;
    const l = e.target.closest('.fg-line');
    if (!l) return;
    pinned = pinned === l ? null : l;
    outline(pinned || l);
    l.scrollIntoView({ block: 'nearest' });
  });
  sampleBox.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.fg-line')) { e.preventDefault(); e.target.click(); } });
  drawSample();
  root.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  root.querySelectorAll('[data-order]').forEach((b) => b.addEventListener('click', () => { order = b.dataset.order; draw(); }));
  find.addEventListener('input', draw);
  const copy = async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    try { await clip.writeText(btn.dataset.copy); btn.textContent = 'Copied'; } catch { btn.textContent = 'Select it'; }
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  };
  list.addEventListener('click', copy);
  sampleBox.addEventListener('click', copy);
  root.querySelector('[data-fg-close]')?.addEventListener('click', onClose);
  draw();
  return show;
}

// Into a window's own document (Picture-in-Picture or a pop-up).
function intoWindow(win, kind, tab) {
  const doc = win.document;
  doc.title = TITLE;
  const style = doc.createElement('style');
  style.textContent = CSS;
  doc.head.appendChild(style);
  doc.body.innerHTML = shellHtml({ closable: false });
  const show = wire(doc, { clip: win.navigator.clipboard, onClose: () => win.close() });
  show(tab);
  open = { win, kind, show };
  win.addEventListener('pagehide', () => { if (open?.win === win) open = null; });
  return kind;
}

// On this page, in its own shadow root so the app's styles and the guide's stay apart.
function intoPanel(tab) {
  const host = document.createElement('aside');
  host.setAttribute('aria-label', 'Field guide');
  host.style.cssText = 'position:fixed; top:0; right:0; bottom:0; width:min(560px, 100vw); z-index:10000; box-shadow:-8px 0 24px rgba(0,0,0,.18); overflow:auto;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${CSS}</style>${shellHtml({ closable: true })}`;
  document.body.appendChild(host);
  const close = () => { host.remove(); if (open?.host === host) open = null; };
  const show = wire(root, { clip: navigator.clipboard, onClose: close });
  show(tab);
  open = { host, kind: 'panel', show, win: { closed: false, focus: () => host.scrollIntoView(), close } };
  return 'panel';
}

export async function openFieldGuide({ tab = 'help' } = {}) {
  if (open && !open.win.closed) { open.show(tab); open.win.focus?.(); return open.kind; }
  const pip = window.documentPictureInPicture;
  if (pip?.requestWindow) {
    try { return intoWindow(await pip.requestWindow({ width: 600, height: 760 }), 'pip', tab); } catch { /* a pop-up instead */ }
  }
  const win = window.open('', 'kennelos-field-guide', 'popup,width=600,height=780');
  if (win) {
    win.document.open();
    win.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${TITLE}</title></head><body></body></html>`);
    win.document.close();
    return intoWindow(win, 'window', tab);
  }
  return intoPanel(tab);
}
