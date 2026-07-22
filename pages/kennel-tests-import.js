// kennel-tests-import.js — the optional seed import (Test Planning Addendum
// §8–9). Distinct from the generic csvImport.js engine: that one is match-or-
// create against records; this one APPENDS to two kennel vocabularies
// (preferred_tests + preferred_breeds), so it has its own tiny write path.
//
// One optional act, two payloads together: the breed name and its common
// tests. Choosing a breed pulls its tests into the kennel checklist AND the
// breed into the kennel breed-autocomplete pool. Suggests, never locks — both
// stay prunable free text. Nothing ships inside the app; the breeder imports
// a file (bundled under /resources or their own), and only their own kennel-
// scoped, backup-riding vocabulary is written.
import { kennelRepo } from '../data/kennelRepo.js';
import { ci, groupsFromFile, applySeedToKennel } from '../data/seedImport.js';
import { esc } from '../assets/ui.js';
import { renderBreedPicker } from '../assets/breedTestPicker.js';

const root = document.getElementById('import-root');

const state = {
  ownKennels: [],
  targetId: null,       // resolved own-kennel id, or null
  groups: [],           // [{ key, display, tests: [{ key, display }] }]
  selected: new Set(),  // breed keys (lowercase) currently checked
  fileName: '',
  result: null          // { breedsAdded, testsAdded } after a commit
};

async function init() {
  const kennels = await kennelRepo.getAll();
  state.ownKennels = kennels.filter((k) => k.is_own_kennel);
  state.targetId = state.ownKennels.length === 1 ? state.ownKennels[0].id : null;
  render();
}

function targetKennel() {
  return state.ownKennels.find((k) => k.id === state.targetId) || null;
}

// --- Preview math --------------------------------------------------------
// What the selected breeds would add to the target kennel, split new vs.
// already-present (case-insensitive, trimmed — same matching posture as the
// rest of the app).
function computePreview() {
  const k = targetKennel();
  const existingTests = new Set((k?.preferred_tests || []).map(ci));
  const existingBreeds = new Set((k?.preferred_breeds || []).map(ci));
  const breedsNew = [], breedsDup = [];
  const testKeys = new Set(), testsNew = [], testsDup = [];
  for (const g of state.groups) {
    if (!state.selected.has(g.key)) continue;
    (existingBreeds.has(g.key) ? breedsDup : breedsNew).push(g.display);
    for (const t of g.tests) {
      if (testKeys.has(t.key)) continue; // one test shared across two breeds counts once
      testKeys.add(t.key);
      (existingTests.has(t.key) ? testsDup : testsNew).push(t.display);
    }
  }
  return { breedsNew, breedsDup, testsNew, testsDup };
}

// --- Render --------------------------------------------------------------
function render() {
  if (!state.ownKennels.length) {
    root.innerHTML = `<div class="card"><p class="muted">You have no kennel marked as your own yet. Set up your kennel first (Import / Export → “Set up your kennel”), then come back here to seed its test checklist.</p></div>`;
    return;
  }

  const targetPicker = state.ownKennels.length > 1
    ? `<div class="field" style="max-width:360px;">
         <label>Import into which of your kennels?</label>
         <select id="target-select">
           <option value="">— choose a kennel —</option>
           ${state.ownKennels.map((k) => `<option value="${esc(k.id)}"${k.id === state.targetId ? ' selected' : ''}>${esc(k.kennel_name)}</option>`).join('')}
         </select>
       </div>`
    : `<p class="muted">Importing into <strong>${esc(state.ownKennels[0].kennel_name)}</strong>.</p>`;

  root.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0;">1. Choose your kennel &amp; file</h2>
      ${targetPicker}
      <p class="muted" style="margin-bottom:6px;">Pick a <code>Breed Group,breed,test_name</code> CSV. A starter file is bundled — <a href="../resources/common_tests_by_breed_seed.csv" download>download the sample</a> to edit and grow, or use your own.</p>
      <input type="file" id="seed-file" accept=".csv,text/csv"${state.targetId ? '' : ' disabled'}>
      ${state.targetId ? '' : '<p class="field-hint">Choose a kennel above to enable the file picker.</p>'}
    </div>
    <div id="seed-body" style="margin-top:16px;"></div>`;

  const sel = document.getElementById('target-select');
  if (sel) sel.addEventListener('change', () => {
    state.targetId = sel.value || null;
    state.groups = []; state.selected = new Set(); state.fileName = ''; state.result = null;
    render();
  });

  const fileInput = document.getElementById('seed-file');
  if (fileInput) fileInput.addEventListener('change', onFile);

  renderBody();
}

async function onFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  state.result = null;
  try {
    state.groups = await groupsFromFile(file);
    state.selected = new Set(); // nothing added until you search or browse a breed group
    state.fileName = file.name;
    if (!state.groups.length) {
      document.getElementById('seed-body').innerHTML = `<div class="card"><div class="inline-error">No usable rows found. The file needs a <code>breed</code> column and a <code>test_name</code> column.</div></div>`;
      return;
    }
    renderBody();
  } catch (err) {
    document.getElementById('seed-body').innerHTML = `<div class="card"><div class="inline-error">${esc(err.message || String(err))}</div></div>`;
  }
}

function renderBody() {
  const body = document.getElementById('seed-body');
  if (!body) return;

  if (state.result) {
    body.innerHTML = `<div class="card">
      <h2 style="margin-top:0;">Import complete</h2>
      <p class="muted">Added <strong>${state.result.breedsAdded}</strong> new breed suggestion(s) and <strong>${state.result.testsAdded}</strong> new test(s) to <strong>${esc(targetKennel()?.kennel_name || '')}</strong>. Already-present entries were left untouched.</p>
      <p class="muted">Prune anything you don't want from the kennel's <strong>Preferred tests</strong> panel (on the kennel's own page — open it from the Kennels list). Breed suggestions now appear on the dog form.</p>
      <div class="form-actions">
        <a class="btn" href="import-export.html">Back to Import / Export</a>
        <button class="btn" id="seed-again">Import another file</button>
      </div>
    </div>`;
    document.getElementById('seed-again').addEventListener('click', () => {
      state.groups = []; state.selected = new Set(); state.fileName = ''; state.result = null;
      render();
    });
    return;
  }

  if (!state.groups.length) { body.innerHTML = ''; return; }

  body.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0;">2. Pick breeds — <span class="faint" style="font-weight:normal;">${esc(state.fileName)}</span></h2>
      <p class="field-hint">Search for a breed or browse by breed group. Only the breeds checked below are pulled in — uncheck to skip one without losing your place, and prune individual tests later on the Kennels page.</p>
      <div id="breed-picker-host"></div>
    </div>
    <div class="card" style="margin-top:16px;">
      <h2 style="margin-top:0;">3. Preview &amp; import</h2>
      <div id="seed-preview-host"></div>
    </div>`;

  // Mounted once per file load — renderPreview() (the onChange callback)
  // only touches #seed-preview-host, so the picker's own search text/toast
  // survive every selection change instead of being wiped by a full re-render.
  renderBreedPicker(document.getElementById('breed-picker-host'), state.groups, state.selected, renderPreview);
  renderPreview();
}

function renderPreview() {
  const host = document.getElementById('seed-preview-host');
  if (!host) return;

  const pv = computePreview();
  const anySelected = state.selected.size > 0;
  const previewHtml = anySelected
    ? `<p class="muted">Will add <strong>${pv.testsNew.length}</strong> new test(s)${pv.breedsNew.length ? ` and <strong>${pv.breedsNew.length}</strong> new breed suggestion(s)` : ''}.
         ${(pv.testsDup.length || pv.breedsDup.length) ? `<span class="faint">Already present: ${pv.testsDup.length} test(s)${pv.breedsDup.length ? `, ${pv.breedsDup.length} breed(s)` : ''} (skipped).</span>` : ''}</p>
       ${pv.testsNew.length ? `<p class="field-hint">New tests: ${pv.testsNew.map((t) => esc(t)).join(', ')}.</p>` : ''}`
    : `<p class="faint">Add at least one breed above to import.</p>`;

  host.innerHTML = `
    ${previewHtml}
    <div class="form-actions">
      <button class="btn btn-primary" id="seed-commit"${anySelected ? '' : ' disabled'}>Import to kennel</button>
    </div>
    <div id="seed-msg"></div>`;

  const commit = document.getElementById('seed-commit');
  if (commit) commit.addEventListener('click', doCommit);
}

async function doCommit() {
  const kennelId = state.targetId;
  const btn = document.getElementById('seed-commit');
  const msg = document.getElementById('seed-msg');
  if (!kennelId) return;
  btn.disabled = true;
  btn.textContent = 'Importing…';
  try {
    state.result = await applySeedToKennel(kennelId, state.groups, state.selected);
    renderBody();
  } catch (err) {
    msg.innerHTML = `<div class="inline-error">${esc(err.message || String(err))}</div>`;
    btn.disabled = false;
    btn.textContent = 'Import to kennel';
  }
}

init();
