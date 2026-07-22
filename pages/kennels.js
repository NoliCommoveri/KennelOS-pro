// kennels.js — minimal kennel management (add / edit / archive / delete).
// Deliberately lightweight: identity only (name / prefix / location / own).
// Per-kennel program configuration — preferred tests and lifecycle nudges —
// lives on the Kennel detail page (kennel.js), reached via each row's "Open →".
// Delete is blocked while any contact or dog still points at the kennel (KENNEL_REFERENCES).
import { kennelRepo } from '../data/kennelRepo.js';
import { esc, confirmModal } from '../assets/ui.js';

const listEl = document.getElementById('kennel-list');
const errEl = document.getElementById('page-error');

let editingId = null;   // id of the kennel currently shown as an inline edit row, or null

function showError(msg) { errEl.innerHTML = `<div class="inline-error">${esc(msg)}</div>`; }
function clearError() { errEl.innerHTML = ''; }

function displayRow(k, blocked) {
  const title = blocked.length ? 'Referenced by ' + blocked.map((b) => `${b.label} (${b.count})`).join(', ') : 'Delete kennel';
  return `<tr class="${k.is_archived ? 'row-archived' : ''}">
    <td><strong>${esc(k.kennel_name)}</strong>${k.is_own_kennel ? ' <span class="badge badge-green">My kennel</span>' : ''}</td>
    <td class="col-collapse">${k.prefix ? esc(k.prefix) : '<span class="faint">—</span>'}</td>
    <td class="col-collapse">${k.location ? esc(k.location) : '<span class="faint">—</span>'}</td>
    <td class="pill-row" style="justify-content:flex-end;">
      <a class="btn btn-sm" href="kennel.html?id=${encodeURIComponent(k.id)}">Open →</a>
      <button class="btn btn-sm" data-act="edit" data-id="${esc(k.id)}">Edit</button>
      <button class="btn btn-sm" data-act="archive" data-id="${esc(k.id)}">${k.is_archived ? 'Unarchive' : 'Archive'}</button>
      <button class="btn btn-danger btn-sm" data-act="delete" data-id="${esc(k.id)}"${blocked.length ? ' disabled' : ''} title="${esc(title)}">Delete</button>
    </td>
  </tr>`;
}

function editRow(k) {
  return `<tr>
    <td colspan="4">
      <div class="form-grid">
        <div class="field"><label>Kennel name <span class="req">*</span></label><input id="e-name" type="text" value="${esc(k.kennel_name)}"></div>
        <div class="field"><label>Prefix</label><input id="e-prefix" type="text" value="${esc(k.prefix || '')}"></div>
        <div class="field"><label>Location</label><input id="e-location" type="text" value="${esc(k.location || '')}"></div>
        <div class="field"><label>Website</label><input id="e-website" type="url" value="${esc(k.website || '')}" placeholder="https://…"></div>
        <div class="field field-wide"><label class="check-inline"><input id="e-own" type="checkbox"${k.is_own_kennel ? ' checked' : ''}> This is one of my own kennels</label></div>
      </div>
      <p class="field-hint">Preferred tests and lifecycle nudges live on the kennel's own page — use <strong>Open →</strong>.</p>
      <div class="form-actions">
        <button class="btn btn-primary btn-sm" data-act="save" data-id="${esc(k.id)}">Save</button>
        <button class="btn btn-sm" data-act="cancel-edit">Cancel</button>
      </div>
    </td>
  </tr>`;
}

async function render() {
  const kennels = await kennelRepo.getAll({ includeArchived: true });
  // My own kennels sort to the top; everyone else's fall below in alphabetical
  // order by name (own kennels are also name-sorted among themselves).
  kennels.sort((a, b) => {
    if (!!a.is_own_kennel !== !!b.is_own_kennel) return a.is_own_kennel ? -1 : 1;
    return (a.kennel_name || '').localeCompare(b.kennel_name || '');
  });
  if (!kennels.length) {
    listEl.innerHTML = `<div class="card empty-state">No kennels yet.</div>`;
    return;
  }
  // Compute delete-blockers per kennel so the Delete button can be disabled.
  const blockers = await Promise.all(kennels.map((k) => kennelRepo.getDeleteBlockers(k.id)));
  listEl.innerHTML = `<div class="table-scroll"><table class="data"><thead><tr><th>Name</th><th class="col-collapse">Prefix</th><th class="col-collapse">Location</th><th></th></tr></thead><tbody>${
    kennels.map((k, i) => (k.id === editingId ? editRow(k) : displayRow(k, blockers[i]))).join('')
  }</tbody></table></div>`;

  listEl.querySelectorAll('[data-act="edit"], [data-act="archive"], [data-act="delete"]').forEach((btn) => {
    if (btn.disabled) return;
    btn.addEventListener('click', () => onAction(btn.dataset.act, kennels.find((k) => k.id === btn.dataset.id)));
  });
  const saveBtn = listEl.querySelector('[data-act="save"]');
  if (saveBtn) saveBtn.addEventListener('click', () => saveEdit(kennels.find((k) => k.id === saveBtn.dataset.id)));
  const cancelBtn = listEl.querySelector('[data-act="cancel-edit"]');
  if (cancelBtn) cancelBtn.addEventListener('click', () => { editingId = null; render(); });
}

async function onAction(act, kennel) {
  clearError();
  try {
    if (act === 'edit') {
      editingId = kennel.id;
      render();
    } else if (act === 'archive') {
      kennel.is_archived ? await kennelRepo.unarchive(kennel.id) : await kennelRepo.archive(kennel.id);
      render();
    } else if (act === 'delete') {
      if (await confirmModal({ title: `Delete kennel “${kennel.kennel_name}”?`, message: 'This cannot be undone.', confirmLabel: 'Delete', danger: true })) {
        await kennelRepo.hardDelete(kennel.id);
        render();
      }
    }
  } catch (e) {
    showError(e.message || String(e));
  }
}

async function saveEdit(kennel) {
  clearError();
  const kennel_name = document.getElementById('e-name').value.trim();
  const prefix = document.getElementById('e-prefix').value.trim();
  const location = document.getElementById('e-location').value.trim();
  const website = document.getElementById('e-website').value.trim();
  const is_own_kennel = document.getElementById('e-own').checked;
  try {
    await kennelRepo.update(kennel.id, { kennel_name, prefix, location, website, is_own_kennel });
    editingId = null;
    render();
  } catch (e) {
    showError(e.message || String(e));
  }
}

// The add form stays collapsed behind the "+ Add New Kennel" button until asked
// for — kennels are usually created inline from a contact, so the list is the
// star of this screen.
const addSection = document.getElementById('add-section');
function clearAddForm() {
  document.getElementById('k-name').value = '';
  document.getElementById('k-prefix').value = '';
  document.getElementById('k-location').value = '';
  document.getElementById('k-website').value = '';
  document.getElementById('k-own').checked = false;
}
function closeAddForm() { addSection.hidden = true; clearAddForm(); clearError(); }

document.getElementById('add-toggle').addEventListener('click', () => {
  addSection.hidden = !addSection.hidden;
  if (!addSection.hidden) document.getElementById('k-name').focus();
});
document.getElementById('k-add-cancel').addEventListener('click', closeAddForm);

document.getElementById('k-add').addEventListener('click', async () => {
  clearError();
  const name = document.getElementById('k-name').value.trim();
  const prefix = document.getElementById('k-prefix').value.trim();
  const location = document.getElementById('k-location').value.trim();
  const website = document.getElementById('k-website').value.trim();
  const is_own_kennel = document.getElementById('k-own').checked;
  try {
    await kennelRepo.create({ kennel_name: name, prefix, location, website, is_own_kennel });
    closeAddForm();
    render();
  } catch (e) {
    showError(e.message || String(e));
  }
});

render();
