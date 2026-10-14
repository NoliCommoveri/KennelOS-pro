// import-batch.js — "Import several files": pick every CSV at once; each file's
// type is guessed from its columns (data/csvBatch.js), the user can change it,
// and the files then run one after another in the order their links need
// (kennels before the contacts and dogs that name them…). Each step is the
// ordinary import screen (assets/importView.js) with its own dry-run preview and
// commit, so a file previews against everything the earlier steps saved.
import { parseCsv, getMapping } from '../data/csvImport.js';
import { detectEntity, orderFiles, ENTITY_PAGE, HANDOFF_ENTITIES } from '../data/csvBatch.js';
import { HELP_ENTITIES } from '../data/csvImportHelp.js';
import { createImportView } from '../assets/importView.js';
import { esc } from '../assets/ui.js';
import { edition } from '../data/editionConfig.js';
import { isProOnlyPage } from '../data/proPages.js';

const root = document.getElementById('import-root');

// Lite ships only its own import pages, so it only offers (and guesses) those.
const offered = HELP_ENTITIES.filter((e) => !(edition === 'lite' && isProOnlyPage(ENTITY_PAGE[e])));
const label = (e) => getMapping(e).label;

// Each entity's list page, for the finished screen's links.
const ENTITY_LIST = {
  kennel: 'kennels.html', contact: 'contacts.html', dog: 'dogs.html', pairing: 'pairings.html',
  litter: 'litters.html', sale: 'sales.html', event: 'dogs.html', stud_service: 'stud-services.html',
  waitlist: 'waitlist.html'
};

let files = []; // [{ name, rows, fields, entity, note }]

function renderPick() {
  root.innerHTML = `
    <section class="card">
      <h2 style="margin-top:0;">1 · Choose your CSV files</h2>
      <input type="file" id="batch-files" accept=".csv,text/csv" multiple>
      <p class="muted" style="margin:8px 0 0;">Select several at once (Ctrl/Cmd-click, or Shift-click a range).</p>
    </section>
    <div id="batch-msg"></div>
    <section class="card" id="batch-plan" style="display:none; margin-top:16px;"></section>`;
  root.querySelector('#batch-files').addEventListener('change', async (ev) => {
    const msg = root.querySelector('#batch-msg');
    msg.innerHTML = '';
    try {
      files = await Promise.all([...ev.target.files].map(readFile));
    } catch (e) {
      msg.innerHTML = `<div class="inline-error">${esc(e.message || String(e))}</div>`;
      return;
    }
    renderPlan();
  });
}

async function readFile(file) {
  const parsed = await parseCsv(file);
  const guess = detectEntity(parsed.fields, offered);
  let note;
  if (!parsed.rows.length) note = 'No data rows.';
  else if (!guess.entity) {
    const elsewhere = detectEntity(parsed.fields);
    note = elsewhere.entity && !offered.includes(elsewhere.entity)
      ? `Looks like ${label(elsewhere.entity)}, which needs KennelOS Pro.`
      : 'Not recognized. Pick what it holds, or leave it out.';
  } else note = guess.sure ? 'Recognized from its columns.' : 'Best guess from its columns. Check it.';
  return { name: file.name, rows: parsed.rows, fields: parsed.fields, entity: parsed.rows.length ? guess.entity : null, note };
}

function renderPlan() {
  const card = root.querySelector('#batch-plan');
  const options = (sel) => `<option value="">Don't import</option>` +
    offered.map((e) => `<option value="${e}"${e === sel ? ' selected' : ''}>${esc(label(e))}</option>`).join('');
  const order = orderFiles(files);
  card.innerHTML = `
    <h2 style="margin-top:0;">2 · What each file holds</h2>
    ${files.map((f, i) => `
      <div style="padding:10px 0; border-top:1px solid var(--border, #e3e3e3);">
        <div><span class="mono" style="word-break:break-all;">${esc(f.name)}</span> <span class="muted">· ${f.rows.length} row${f.rows.length === 1 ? '' : 's'}</span></div>
        <label class="muted" style="display:block; margin-top:6px; font-size:13px;" for="batch-type-${i}">Imports as</label>
        <select id="batch-type-${i}" data-file="${i}" style="width:100%; max-width:320px;">${options(f.entity)}</select>
        <div class="muted" style="font-size:13px; margin-top:4px;">${esc(f.note)}</div>
      </div>`).join('')}
    <h3>Import order</h3>
    ${order.length
      ? `<ol>${order.map((f) => `<li>${esc(label(f.entity))}: <span class="mono" style="word-break:break-all;">${esc(f.name)}</span>${HANDOFF_ENTITIES.has(f.entity) ? ' <span class="muted">(on its own import screen)</span>' : ''}</li>`).join('')}</ol>
        <p class="muted">Records other files point at come first, so a contact's or dog's kennel, or an event's dog, is already saved when its file is previewed.</p>`
      : '<p class="muted">Nothing to import yet. Choose what each file holds.</p>'}
    <div class="form-actions"><button class="btn btn-primary" id="batch-start"${order.length ? '' : ' disabled'}>Start importing</button></div>`;
  card.style.display = '';
  card.querySelectorAll('select[data-file]').forEach((sel) => sel.addEventListener('change', () => {
    files[Number(sel.dataset.file)].entity = sel.value || null;
    renderPlan();
  }));
  card.querySelector('#batch-start').addEventListener('click', () => runSteps(order));
}

function runSteps(order) {
  const results = [];
  let step = 0;
  const next = (res) => {
    if (step > 0) results.push({ file: order[step - 1], res });
    if (step === order.length) { renderDone(results); return; }
    const f = order[step++];
    root.innerHTML = `
      <p class="muted">File ${step} of ${order.length}</p>
      <div id="batch-step"></div>`;
    const mount = root.querySelector('#batch-step');
    if (HANDOFF_ENTITIES.has(f.entity)) {
      mount.innerHTML = `
        <section class="card">
          <h2 style="margin-top:0;">${esc(label(f.entity))} from <span class="mono">${esc(f.name)}</span></h2>
          <p>${esc(HANDOFF_ENTITIES.get(f.entity))} Open it in a new tab and choose <span class="mono">${esc(f.name)}</span> there.</p>
          <div class="form-actions">
            <a class="btn" href="${ENTITY_PAGE[f.entity]}" target="_blank" rel="noopener">Open the ${esc(label(f.entity))} import</a>
            <button class="btn btn-primary" id="batch-handoff-next">Next →</button>
          </div>
        </section>`;
      mount.querySelector('#batch-handoff-next').addEventListener('click', () => next({ handoff: true }));
      window.scrollTo(0, 0);
      return;
    }
    createImportView({
      mount, entity: f.entity, listHref: ENTITY_LIST[f.entity], listLabel: label(f.entity),
      rows: f.rows, fileName: f.name, onNext: next
    });
    window.scrollTo(0, 0);
  };
  next();
}

function renderDone(results) {
  const line = ({ file, res }) => {
    let what;
    if (!res) what = 'Skipped';
    else if (res.handoff) what = 'Left for its own import screen';
    else {
      what = `${res.created} created · ${res.updated} updated · ${res.skipped} skipped`;
      if (res.failed.length) what += ` · ${res.failed.length} failed`;
      if (res.notes?.length) what += ` · ${res.notes.length} note${res.notes.length === 1 ? '' : 's'}`;
    }
    return `<tr><td>${esc(label(file.entity))}</td><td class="mono">${esc(file.name)}</td><td>${esc(what)}</td></tr>`;
  };
  // One button per list page (dogs and their events both list on Dogs).
  const pages = new Map();
  for (const { file } of results) {
    const href = ENTITY_LIST[file.entity];
    if (href && !HANDOFF_ENTITIES.has(file.entity) && !pages.has(href)) pages.set(href, label(file.entity));
  }
  const lists = [...pages].map(([href, name]) => `<a class="btn" href="${esc(href)}">Go to ${esc(name)}</a>`).join(' ');
  root.innerHTML = `
    <section class="card">
      <h2 style="margin-top:0;">All files done</h2>
      <div style="overflow-x:auto;"><table class="data">
        <thead><tr><th>Imported as</th><th>File</th><th>Result</th></tr></thead>
        <tbody>${results.map(line).join('')}</tbody>
      </table></div>
      <div class="form-actions">${lists} <a class="btn btn-primary" href="import-export.html">Back to Import / Export</a></div>
    </section>`;
  window.scrollTo(0, 0);
}

renderPick();
