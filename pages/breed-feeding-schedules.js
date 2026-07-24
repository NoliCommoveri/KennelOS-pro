// breed-feeding-schedules.js — one card per breed already on your dogs
// (dogRepo.getBreeds — the kennel's own breed list, not a separate vocabulary),
// each an editable food-brand + weight-band x age-column grid + notes. Both grid
// axes are breeder-authored free text (a real breeder's printed feeding guide
// rarely fits a fixed set of life-stage labels), matching the litter override's
// own free-text posture. Saved rows feed a placed pup's Furever seed packet
// (fureverSeedExport.js) so the pup's Furever app shows this instead of the
// generic age-bracket placeholder.
import { dogRepo } from '../data/dogRepo.js';
import { breedFeedingScheduleRepo } from '../data/breedFeedingScheduleRepo.js';
import { esc } from '../assets/ui.js';

const els = {
  error: document.getElementById('page-error'),
  list: document.getElementById('breed-list')
};

function showError(msg) { els.error.innerHTML = `<div class="inline-error">${esc(msg)}</div>`; }
function clearError() { els.error.innerHTML = ''; }

const DEFAULT_AGE_COLUMNS = ['8–12 weeks', '3–6 months', '6–12 months'];

function blankDraft(breed) {
  return {
    id: null,
    breed,
    food_brand: '',
    age_columns: [...DEFAULT_AGE_COLUMNS],
    weight_rows: [{ label: '', amounts: DEFAULT_AGE_COLUMNS.map(() => '') }],
    notes: ''
  };
}

function toDraft(schedule, breed) {
  if (!schedule) return blankDraft(breed);
  const age_columns = schedule.age_columns && schedule.age_columns.length ? [...schedule.age_columns] : [...DEFAULT_AGE_COLUMNS];
  const weight_rows = (schedule.weight_rows && schedule.weight_rows.length)
    ? schedule.weight_rows.map((r) => ({ label: r.label || '', amounts: age_columns.map((_, i) => (r.amounts || [])[i] || '') }))
    : [{ label: '', amounts: age_columns.map(() => '') }];
  return { id: schedule.id, breed, food_brand: schedule.food_brand || '', age_columns, weight_rows, notes: schedule.notes || '' };
}

let breeds = [];         // this kennel's own breeds (dogRepo.getBreeds())
let existingByBreed = new Map(); // breed(lowercased) -> saved schedule record
let drafts = new Map();  // breed -> draft object (created lazily on first expand)
const expanded = new Set();

function draftFor(breed) {
  if (!drafts.has(breed)) {
    const existing = existingByBreed.get(breed.trim().toLowerCase());
    drafts.set(breed, toDraft(existing, breed));
  }
  return drafts.get(breed);
}

function rowHtml(breed, row, ri) {
  const cells = row.amounts.map((a, ci) =>
    `<td><input type="text" class="afs-cell" data-breed="${esc(breed)}" data-ri="${ri}" data-ci="${ci}" value="${esc(a)}" placeholder="e.g. 1/2 – 3/4 cup"></td>`
  ).join('');
  return `<tr>
    <td><input type="text" class="afs-row-label" data-breed="${esc(breed)}" data-ri="${ri}" value="${esc(row.label)}" placeholder="e.g. Up to 5 lbs" style="min-width:130px;"></td>
    ${cells}
    <td><button type="button" class="btn btn-sm afs-row-remove" data-breed="${esc(breed)}" data-ri="${ri}" title="Remove this weight row">×</button></td>
  </tr>`;
}

function colHeadHtml(breed, col, ci, removable) {
  return `<th>
    <input type="text" class="afs-col-label" data-breed="${esc(breed)}" data-ci="${ci}" value="${esc(col)}" placeholder="Age range" style="min-width:110px;">
    ${removable ? `<button type="button" class="btn btn-sm afs-col-remove" data-breed="${esc(breed)}" data-ci="${ci}" title="Remove this age column">×</button>` : ''}
  </th>`;
}

function cardHtml(breed) {
  const draft = draftFor(breed);
  const isOpen = expanded.has(breed);
  const hasSaved = existingByBreed.has(breed.trim().toLowerCase());
  const headCols = draft.age_columns.map((c, ci) => colHeadHtml(breed, c, ci, draft.age_columns.length > 1)).join('');
  const rows = draft.weight_rows.map((row, ri) => rowHtml(breed, row, ri)).join('');
  return `
    <div class="card" data-breed="${esc(breed)}" style="margin-top:12px;">
      <div class="r-header afs-header" style="display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none;">
        <span class="r-arrow" style="display:inline-block; transition:transform 0.2s; font-size:12px;${isOpen ? ' transform:rotate(90deg);' : ''}">▶</span>
        <div class="row-between" style="flex:1; gap:8px;">
          <span><strong>${esc(breed)}</strong></span>
          <span class="muted">${hasSaved ? 'Schedule set' : 'Not set — falls back to a generic default'}</span>
        </div>
      </div>
      <div class="r-body" style="display:${isOpen ? 'block' : 'none'}; margin-top:10px;">
        <div class="field field-wide">
          <label>Food brand</label>
          <input type="text" class="afs-brand" data-breed="${esc(breed)}" value="${esc(draft.food_brand)}" placeholder="e.g. Purina Pro Plan Sport Salmon &amp; Rice Formula">
        </div>
        <div class="table-scroll" style="margin-top:10px; overflow-x:auto;">
          <table class="data">
            <thead><tr><th>Puppy's weight</th>${headCols}<th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="pill-row" style="margin-top:8px;">
          <button type="button" class="btn btn-sm afs-add-row" data-breed="${esc(breed)}">+ Add weight range</button>
          <button type="button" class="btn btn-sm afs-add-col" data-breed="${esc(breed)}">+ Add age range</button>
        </div>
        <div class="field field-wide" style="margin-top:10px;">
          <label>Notes</label>
          <textarea class="afs-notes" data-breed="${esc(breed)}" placeholder="Adjust based on body condition, transition guidance, etc.">${esc(draft.notes)}</textarea>
        </div>
        <div class="form-actions">
          <button type="button" class="btn btn-primary btn-sm afs-save" data-breed="${esc(breed)}">Save</button>
          <span class="muted afs-saved" data-breed="${esc(breed)}"></span>
        </div>
      </div>
    </div>`;
}

function render() {
  if (!breeds.length) {
    els.list.innerHTML = `<div class="card empty-state">No breeds yet — a breed shows up here once it's set on one of your dogs.</div>`;
    return;
  }
  els.list.innerHTML = breeds.map(cardHtml).join('');
  wireCards();
}

function renderCard(breed) {
  const card = els.list.querySelector(`[data-breed="${CSS.escape(breed)}"]`);
  if (!card) return;
  card.outerHTML = cardHtml(breed);
  wireCard(els.list.querySelector(`[data-breed="${CSS.escape(breed)}"]`));
}

function wireCards() {
  els.list.querySelectorAll('.card[data-breed]').forEach(wireCard);
}

function wireCard(card) {
  if (!card) return;
  const breed = card.dataset.breed;
  const header = card.querySelector('.afs-header');
  const body = card.querySelector('.r-body');
  const arrow = card.querySelector('.r-arrow');
  header.addEventListener('click', () => {
    const open = expanded.has(breed);
    if (open) expanded.delete(breed); else expanded.add(breed);
    body.style.display = open ? 'none' : 'block';
    arrow.style.transform = open ? 'rotate(0deg)' : 'rotate(90deg)';
  });

  // Cell/label/brand/notes edits mutate the draft in place — no re-render, so
  // focus and caret position survive normal typing.
  card.querySelectorAll('.afs-cell').forEach((el) => {
    el.addEventListener('input', () => {
      const d = draftFor(breed);
      d.weight_rows[Number(el.dataset.ri)].amounts[Number(el.dataset.ci)] = el.value;
    });
  });
  card.querySelectorAll('.afs-row-label').forEach((el) => {
    el.addEventListener('input', () => { draftFor(breed).weight_rows[Number(el.dataset.ri)].label = el.value; });
  });
  card.querySelectorAll('.afs-col-label').forEach((el) => {
    el.addEventListener('input', () => { draftFor(breed).age_columns[Number(el.dataset.ci)] = el.value; });
  });
  const brand = card.querySelector('.afs-brand');
  if (brand) brand.addEventListener('input', () => { draftFor(breed).food_brand = brand.value; });
  const notes = card.querySelector('.afs-notes');
  if (notes) notes.addEventListener('input', () => { draftFor(breed).notes = notes.value; });

  // Structural edits (add/remove a row or column) change the grid shape, so
  // they re-render the card from the updated draft.
  card.querySelector('.afs-add-row')?.addEventListener('click', () => {
    const d = draftFor(breed);
    d.weight_rows.push({ label: '', amounts: d.age_columns.map(() => '') });
    expanded.add(breed);
    renderCard(breed);
  });
  card.querySelectorAll('.afs-row-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      const d = draftFor(breed);
      if (d.weight_rows.length <= 1) return;
      d.weight_rows.splice(Number(btn.dataset.ri), 1);
      expanded.add(breed);
      renderCard(breed);
    });
  });
  card.querySelector('.afs-add-col')?.addEventListener('click', () => {
    const d = draftFor(breed);
    d.age_columns.push('');
    d.weight_rows.forEach((r) => r.amounts.push(''));
    expanded.add(breed);
    renderCard(breed);
  });
  card.querySelectorAll('.afs-col-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      const d = draftFor(breed);
      if (d.age_columns.length <= 1) return;
      const ci = Number(btn.dataset.ci);
      d.age_columns.splice(ci, 1);
      d.weight_rows.forEach((r) => r.amounts.splice(ci, 1));
      expanded.add(breed);
      renderCard(breed);
    });
  });

  card.querySelector('.afs-save')?.addEventListener('click', () => saveBreed(breed));
}

async function saveBreed(breed) {
  clearError();
  const d = draftFor(breed);
  const saveBtn = els.list.querySelector(`.afs-save[data-breed="${CSS.escape(breed)}"]`);
  const savedFlag = els.list.querySelector(`.afs-saved[data-breed="${CSS.escape(breed)}"]`);
  if (saveBtn) saveBtn.disabled = true;
  try {
    const payload = {
      breed,
      food_brand: d.food_brand.trim(),
      age_columns: d.age_columns.map((c) => c.trim()),
      weight_rows: d.weight_rows.map((r) => ({ label: r.label.trim(), amounts: r.amounts.map((a) => a.trim()) })),
      notes: d.notes.trim()
    };
    const existing = existingByBreed.get(breed.trim().toLowerCase());
    const saved = existing
      ? await breedFeedingScheduleRepo.update(existing.id, payload)
      : await breedFeedingScheduleRepo.create(payload);
    existingByBreed.set(breed.trim().toLowerCase(), saved);
    drafts.set(breed, toDraft(saved, breed));
    if (savedFlag) {
      savedFlag.textContent = 'Saved.';
      setTimeout(() => { savedFlag.textContent = ''; }, 2000);
    }
    renderCard(breed);
    expanded.add(breed);
  } catch (e) {
    showError(e.message || String(e));
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function main() {
  try {
    const [allBreeds, schedules] = await Promise.all([
      dogRepo.getBreeds(),
      breedFeedingScheduleRepo.getAll()
    ]);
    breeds = allBreeds;
    existingByBreed = new Map(schedules.map((s) => [s.breed.trim().toLowerCase(), s]));
    render();
  } catch (e) {
    showError(e.message || String(e));
  }
}

main();
