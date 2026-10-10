// pedigree-import.js — Import Pedigrees: read one or more pedigree PDFs, review
// every dog on them in one list, then save. Reading is data/pedigreeReader.js
// (PDF text, or OCR for a picture) + data/pedigreeParse.js (the chart layout);
// matching and saving are data/pedigreeImport.js. Nothing is written until
// Import, and the PDFs themselves are dropped afterwards unless a file's
// "Save to Documents" box is ticked (Pro — Lite has no document storage).
import { dogRepo, dogName } from '../data/dogRepo.js';
import { editionFlags } from '../data/editionConfig.js';
import { readPedigreeFile } from '../data/pedigreeReader.js';
import { wordsToSegments, parsePedigree } from '../data/pedigreeParse.js';
import { planImport, commitImport } from '../data/pedigreeImport.js';
import { ownKennels, getActiveKennelId } from '../data/kennelScope.js';
import { esc, badge } from '../assets/ui.js';
import { SEX } from '../data/vocab.js';

const els = {
  input: document.getElementById('ped-files'),
  drop: document.getElementById('ped-drop'),
  fileList: document.getElementById('ped-file-list'),
  review: document.getElementById('ped-review'),
  tabs: document.getElementById('ped-review-tabs'),
  summary: document.getElementById('ped-summary'),
  rows: document.getElementById('ped-rows'),
  commit: document.getElementById('ped-commit'),
  commitNote: document.getElementById('ped-commit-note'),
  done: document.getElementById('ped-done'),
  error: document.getElementById('page-error')
};

// files: [{ id, file, status: 'reading'|'ready'|'failed', progress, source, parsed, breed, store, error }]
const state = { files: [], existing: [], kennels: [], edits: {}, decisions: {}, plan: null, view: null }; // view null = follow what needs attention
let nextId = 1;

const showError = (msg) => { els.error.innerHTML = msg ? `<div class="inline-error">${esc(msg)}</div>` : ''; };

async function addFiles(list) {
  showError('');
  els.done.innerHTML = '';
  for (const file of list) {
    const f = { id: `f${nextId++}`, file, status: 'reading', progress: 0, store: false };
    state.files.push(f);
    renderFiles();
    read(f);
  }
}

async function read(f) {
  try {
    const got = await readPedigreeFile(f.file, {
      onProgress: (p) => { f.progress = p; renderFiles(); }
    });
    f.source = got.source;
    f.parsed = parsePedigree(wordsToSegments(got.words, { minConf: 30 }), got.page);
    if (got.pages > 1) f.parsed.warnings.unshift(`Only the first of ${got.pages} pages was read.`);
    f.breed = f.parsed.header.breed || '';
    f.status = f.parsed.dogs.size ? 'ready' : 'failed';
    if (!f.parsed.dogs.size) f.error = f.parsed.warnings[0] || 'No dogs were found in this file.';
  } catch (e) {
    f.status = 'failed';
    f.error = e?.message || String(e);
  }
  state.existing = await loadExisting();
  replan();
}

function readyFiles() { return state.files.filter((f) => f.status === 'ready'); }

function replan() {
  const files = readyFiles().map((f) => ({ id: f.id, name: f.file.name, breed: f.breed, dogs: f.parsed.dogs }));
  state.plan = files.length ? planImport({ files, existing: state.existing, edits: state.edits, decisions: state.decisions }) : null;
  renderFiles();
  renderReview();
}

// --- Files ------------------------------------------------------------------
function conflictsFromFile(fileId) {
  if (!state.plan) return 0;
  let n = 0;
  for (const r of state.plan.rows) {
    for (const side of ['sire', 'dam']) {
      if (r[`${side}Options`].length > 1 && r[`${side}Options`].some((k) => r[`${side}From`][k].includes(fileId))) n++;
    }
  }
  return n;
}

function fileCard(f) {
  const name = esc(f.file.name);
  const remove = `<button class="btn btn-sm" data-remove="${f.id}">Remove</button>`;
  if (f.status === 'reading') {
    const pct = f.progress ? ` — reading text from the image, ${Math.round(f.progress * 100)}%` : '';
    return `<div class="ped-file"><div class="row-between"><div><strong>${name}</strong> <span class="muted">Reading…${pct}</span></div></div></div>`;
  }
  if (f.status === 'failed') {
    return `<div class="ped-file"><div class="row-between"><div><strong>${name}</strong> <span class="badge badge-red">Couldn’t read</span>
      <div class="muted" style="font-size:13px;">${esc(f.error)}</div></div>${remove}</div></div>`;
  }
  const p = f.parsed;
  const subject = p.dogs.get('');
  const conflicts = readyFiles().length > 1 ? conflictsFromFile(f.id) : 0;
  const warnings = p.warnings.map((w) => `<li>${esc(w)}</li>`).join('');
  return `<div class="ped-file">
    <div class="row-between">
      <div>
        <strong>${esc(subject?.registered_name || '(name not read)')}</strong>
        <span class="muted">· ${name} · ${p.dogs.size} dogs, ${p.generations} generation${p.generations === 1 ? '' : 's'}</span>
        ${f.source === 'ocr' ? '<span class="badge badge-amber">Read from an image — check names</span>' : '<span class="badge badge-green">Read exactly</span>'}
      </div>
      <div class="pill-row">${remove}</div>
    </div>
    ${warnings ? `<ul class="ped-warn">${warnings}</ul>` : ''}
    <div class="ped-file-opts">
      <label class="field" style="margin:0;">Breed <span class="req">*</span>
        <input type="text" data-breed="${f.id}" value="${esc(f.breed)}" placeholder="Breed for every dog on this pedigree">
      </label>
      ${editionFlags.documents ? `<label class="check-inline"><input type="checkbox" data-store="${f.id}"${f.store ? ' checked' : ''}> Save this PDF to ${esc(subject?.registered_name || 'the dog')}’s Documents</label>` : ''}
      ${f.store && state.kennels.length > 1 && !getActiveKennelId() ? `<label class="field" style="margin:0;">File under
        <select data-kennel="${f.id}">${state.kennels.map((k) => `<option value="${esc(k.id)}"${k.id === f.kennelId ? ' selected' : ''}>${esc(k.kennel_name)}</option>`).join('')}</select></label>` : ''}
      ${conflicts ? `<button class="btn btn-sm" data-prefer="${f.id}">Use this pedigree’s answers where pedigrees disagree (${conflicts})</button>` : ''}
    </div>
  </div>`;
}

function renderFiles() {
  els.fileList.innerHTML = state.files.map(fileCard).join('');
}

els.fileList.addEventListener('click', (e) => {
  const rm = e.target.closest('[data-remove]');
  if (rm) {
    state.files = state.files.filter((f) => f.id !== rm.dataset.remove);
    replan();
    return;
  }
  const pref = e.target.closest('[data-prefer]');
  if (pref && state.plan) {
    const fid = pref.dataset.prefer;
    for (const r of state.plan.rows) {
      for (const side of ['sire', 'dam']) {
        const opts = r[`${side}Options`];
        if (opts.length < 2) continue;
        const pick = opts.find((k) => r[`${side}From`][k].includes(fid));
        if (pick) state.decisions[`${side}:${r.key}`] = pick;
      }
    }
    replan();
  }
});
els.fileList.addEventListener('change', (e) => {
  const b = e.target.closest('[data-breed]');
  if (b) { state.files.find((f) => f.id === b.dataset.breed).breed = b.value.trim(); replan(); return; }
  const s = e.target.closest('[data-store]');
  if (s) {
    const f = state.files.find((x) => x.id === s.dataset.store);
    f.store = s.checked;
    if (f.store && !f.kennelId) f.kennelId = state.kennels[0]?.id || null;
    renderFiles();
    return;
  }
  const k = e.target.closest('[data-kennel]');
  if (k) state.files.find((f) => f.id === k.dataset.kennel).kennelId = k.value;
});

// --- Review -----------------------------------------------------------------
const needsAttention = (r) => r.action === 'review' || r.sireConflict || r.damConflict || !r.name || r.issues.length
  || (r.action === 'new' && !r.breed);

function rowName(key) { return state.plan.rows.find((r) => r.key === key)?.name || '—'; }
function fileName(id) { return state.files.find((f) => f.id === id)?.file.name || ''; }

function parentCell(r, side) {
  const opts = r[`${side}Options`];
  const chosen = r[`${side}Key`];
  if (opts.length > 1) {
    const pick = state.decisions[`${side}:${r.key}`] || '';
    const options = opts.map((k) => `<option value="${esc(k)}"${k === pick ? ' selected' : ''}>${esc(rowName(k))} (${esc(r[`${side}From`][k].map(fileName).join(', '))})</option>`).join('');
    return `<select data-parent="${side}" data-key="${esc(r.key)}"${r[`${side}Conflict`] ? ' class="ped-needs"' : ''}><option value="">Pedigrees disagree — choose…</option>${options}</select>`;
  }
  if (chosen) return esc(rowName(chosen));
  if (opts.length && r.existingId) return '<span class="muted">kept as recorded</span>';
  return '<span class="faint">—</span>';
}

function statusCell(r) {
  if (r.choices) {
    const options = r.choices.map((c) => `<option value="${esc(c.value)}"${state.decisions[r.key] === c.value ? ' selected' : ''}>${esc(c.label)}</option>`).join('');
    return `<select data-decide="${esc(r.key)}"${r.action === 'review' ? ' class="ped-needs"' : ''}><option value="">Same name as another dog — choose…</option>${options}</select>`;
  }
  if (r.action === 'existing') {
    const d = state.existing.find((x) => x.id === r.existingId);
    return `<span class="badge badge-blue">Matches</span> <a href="dog.html?id=${encodeURIComponent(r.existingId)}" target="_blank" rel="noopener">${esc(dogName(d) || 'your dog')}</a>`;
  }
  return '<span class="badge badge-neutral">New · pedigree only</span>';
}

function renderReview() {
  const plan = state.plan;
  els.review.hidden = !plan;
  if (!plan) return;
  const attention = plan.rows.filter(needsAttention);
  const view = state.view || (attention.length ? 'attention' : 'all');
  els.tabs.innerHTML = `
    <button class="btn btn-sm${view === 'attention' ? ' btn-primary' : ''}" data-view="attention">Needs attention (${attention.length})</button>
    <button class="btn btn-sm${view === 'all' ? ' btn-primary' : ''}" data-view="all">All dogs (${plan.rows.length})</button>`;
  const { created, matched } = plan.counts;
  els.summary.textContent = `${created} new pedigree-only dog${created === 1 ? '' : 's'}, ${matched} matched to dogs you already have.`;

  const depth = (r) => Math.min(...r.sources.map((s) => s.path.length));
  const shown = (view === 'attention' ? attention : plan.rows)
    .slice().sort((a, b) => depth(a) - depth(b) || a.name.localeCompare(b.name));
  els.rows.innerHTML = shown.length ? `<div class="ped-table-wrap"><table class="data ped-table">
    <thead><tr><th>Name</th><th>Registration #</th><th>Color</th><th>Sex</th><th>Sire</th><th>Dam</th><th>Status</th></tr></thead>
    <tbody>${shown.map((r) => `<tr>
      <td><input type="text" data-edit="registered_name" data-key="${esc(r.key)}" value="${esc(r.name)}"${r.name ? '' : ' class="ped-needs"'}>
        ${r.subjectOf.length ? '<div class="muted" style="font-size:12px;">The pedigree’s dog</div>' : ''}
        ${r.issues.map((i) => `<div class="ped-issue">${esc(i)}</div>`).join('')}
        ${r.action === 'new' && !r.breed ? '<div class="ped-issue">Needs a breed — set it on the pedigree above.</div>' : ''}</td>
      <td><input type="text" data-edit="registration_number" data-key="${esc(r.key)}" value="${esc(r.registration_number)}" style="width:9.5em;"></td>
      <td><input type="text" data-edit="color_markings" data-key="${esc(r.key)}" value="${esc(r.color_markings)}" style="width:9em;"></td>
      <td>${badge(SEX, r.sex)}</td>
      <td>${parentCell(r, 'sire')}</td>
      <td>${parentCell(r, 'dam')}</td>
      <td>${statusCell(r)}</td>
    </tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">Nothing needs attention.</p>';

  els.commit.disabled = !plan.ready;
  els.commit.textContent = `Import ${plan.rows.length} dog${plan.rows.length === 1 ? '' : 's'}`;
  els.commitNote.textContent = plan.ready ? '' : 'Resolve the items under “Needs attention” first.';
  if (state.files.some((f) => f.status === 'reading')) {
    els.commit.disabled = true;
    els.commitNote.textContent = 'Still reading a file…';
  }
}

els.tabs.addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b) { state.view = b.dataset.view; renderReview(); }
});

els.rows.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.edit) {
    // An edit applies to every box this dog came from, so it re-matches correctly.
    const row = state.plan.rows.find((r) => r.key === t.dataset.key);
    for (const s of row.sources) {
      const k = `${s.fileId}:${s.path}`;
      state.edits[k] = { ...(state.edits[k] || {}), [t.dataset.edit]: t.value.trim() };
    }
    replan();
  } else if (t.dataset.decide) {
    if (t.value) state.decisions[t.dataset.decide] = t.value; else delete state.decisions[t.dataset.decide];
    replan();
  } else if (t.dataset.parent) {
    const k = `${t.dataset.parent}:${t.dataset.key}`;
    if (t.value) state.decisions[k] = t.value; else delete state.decisions[k];
    replan();
  }
});

els.commit.addEventListener('click', async () => {
  if (!state.plan?.ready) return;
  els.commit.disabled = true;
  els.commitNote.textContent = 'Saving…';
  showError('');
  try {
    const storeFiles = readyFiles().filter((f) => f.store).map((f) => ({ fileId: f.id, blob: f.file, filename: f.file.name, kennelId: f.kennelId }));
    const res = await commitImport(state.plan, { storeFiles });
    const subjects = [...new Map(readyFiles().filter((f) => res.subjects[f.id])
      .map((f) => [res.subjects[f.id], { name: f.parsed.dogs.get('')?.registered_name, id: res.subjects[f.id] }])).values()];
    els.done.innerHTML = `<section class="card">
      <h2 style="margin-top:0;">Imported</h2>
      <p>${res.created} new pedigree-only dog${res.created === 1 ? '' : 's'}${res.updated ? `, ${res.updated} existing dog${res.updated === 1 ? '' : 's'} filled in` : ''}.</p>
      <ul>${subjects.map((s) => `<li><a href="pedigree.html?id=${encodeURIComponent(s.id)}">${esc(s.name)}</a> — view pedigree</li>`).join('')}</ul>
      ${res.fileErrors.length ? `<div class="inline-error">Some PDFs weren’t saved to Documents: ${esc(res.fileErrors.join('; '))}</div>` : ''}
    </section>`;
    // Start fresh: the files (and their PDFs) are dropped from the page.
    state.files = [];
    state.edits = {};
    state.decisions = {};
    state.view = null;
    state.existing = await loadExisting();
    replan();
    els.done.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    showError(e?.message || String(e));
    els.commit.disabled = false;
    els.commitNote.textContent = '';
  }
});

// --- Picking files ----------------------------------------------------------
els.input.addEventListener('change', () => { addFiles([...els.input.files]); els.input.value = ''; });
els.drop.addEventListener('dragover', (e) => { e.preventDefault(); els.drop.classList.add('ped-drop-over'); });
els.drop.addEventListener('dragleave', () => els.drop.classList.remove('ped-drop-over'));
els.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  els.drop.classList.remove('ped-drop-over');
  addFiles([...e.dataTransfer.files].filter((f) => f.type === 'application/pdf' || f.type.startsWith('image/') || /\.pdf$/i.test(f.name)));
});

// Every dog already in the app — archived and pedigree-only too — for matching.
// Re-read for each file, so a dog added or edited in another tab since this page
// opened is matched too.
function loadExisting() {
  return dogRepo.getAll({ includeArchived: true, includePedigreeOnly: true })
    .catch((e) => { showError(e?.message || String(e)); return state.existing; });
}
// Own kennels, for filing a kept PDF when there's more than one and none is active.
if (editionFlags.documents) ownKennels().then((ks) => { state.kennels = ks; }).catch(() => {});
