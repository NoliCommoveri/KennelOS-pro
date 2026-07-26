// kennels.js — two screens in one page. On top, the PORTFOLIO (Multi-Kennel
// Scope Spec §8): one card per own kennel with live counts and the entry point
// to switching the active scope — rendered only once a second own kennel exists.
// Below it, the original lightweight management list: identity only (name /
// prefix / location / own) across every kennel on record, outside ones included.
// Per-kennel program configuration — preferred tests and lifecycle nudges —
// lives on the Kennel detail page (kennel.js), reached via each row's "Open →".
// Delete is blocked while anything still points at the kennel (KENNEL_REFERENCES —
// since Phase 1 that includes its litters, sales, pairings, stud services,
// contracts, and documents, so a working kennel is archive-only by design).
import { kennelRepo } from '../data/kennelRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import { getActiveKennelId, setActiveKennel } from '../data/kennelScope.js';
import { esc, confirmModal } from '../assets/ui.js';
import { mountKennelCardImport, maybeOpenCardFromHash } from '../assets/kennelCardUI.js';

const listEl = document.getElementById('kennel-list');
const portfolioEl = document.getElementById('kennel-portfolio');
const allHeadingEl = document.getElementById('all-kennels-heading');
const errEl = document.getElementById('page-error');

let editingId = null;   // id of the kennel currently shown as an inline edit row, or null

function showError(msg) { errEl.innerHTML = `<div class="inline-error">${esc(msg)}</div>`; }
function clearError() { errEl.innerHTML = ''; }

// An OUTSIDE kennel carrying a public_id got its details from a card its owner
// issued, rather than from this breeder typing them in — which is exactly the
// difference between a cross-kennel reference that lines up with the other
// breeder's records and one that only looks like it does. Own kennels all carry
// an id by construction, so badging those too would just be noise.
function linkedBadge(k) {
  return (!k.is_own_kennel && k.public_id) ? ' <span class="badge badge-blue">linked</span>' : '';
}

function displayRow(k, blocked) {
  const title = blocked.length ? 'Referenced by ' + blocked.map((b) => `${b.label} (${b.count})`).join(', ') : 'Delete kennel';
  return `<tr class="${k.is_archived ? 'row-archived' : ''}">
    <td><strong>${esc(k.kennel_name)}</strong>${k.is_own_kennel ? ' <span class="badge badge-green">My kennel</span>' : ''}${linkedBadge(k)}</td>
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

// --- Portfolio (Multi-Kennel Scope Spec §8) --------------------------------
// One card per OWN kennel with live counts, plus the entry point to switching
// the active scope. Deliberately silent when there is only one own kennel: a
// portfolio of one is noise, and the same silence rule already governs the dog
// form's kennel picker and the nav switcher's usefulness.
//
// Counts are derived on load, like every other count in the app — no stored
// aggregates. The roster count is OWNED dogs only: an external or leased dog
// belongs to no kennel of yours (spec §3.1a), so it is on nobody's roster.

const LIVE_LITTER_STATUSES = ['expected', 'whelped', 'weaning', 'ready', 'sold'];

function portfolioCard(k, counts, activeId) {
  const isActive = k.id === activeId;
  const stat = (n, label) => `<div class="stat${n === 0 ? ' stat-zero' : ''}"><div class="stat-num">${esc(n)}</div><div class="stat-label">${esc(label)}</div></div>`;
  return `<section class="card" style="margin-top:14px;${isActive ? ' border-color:var(--accent);' : ''}">
      <div class="row-between" style="align-items:baseline;">
        <h3 style="margin:0;">${esc(k.kennel_name)}${isActive ? ' <span class="badge badge-green">Active scope</span>' : ''}${k.is_archived ? ' <span class="badge badge-gray">Archived</span>' : ''}</h3>
        <a class="btn btn-sm" href="kennel.html?id=${encodeURIComponent(k.id)}">Open hub →</a>
      </div>
      ${k.location ? `<p class="muted" style="margin:2px 0 0; font-size:13px;">${esc(k.location)}</p>` : ''}
      <div class="stat-grid" style="margin-top:10px;">
        ${stat(counts.dogs, 'Dogs on roster')}
        ${stat(counts.litters, 'Active litters')}
        ${stat(counts.sales, 'Placements this year')}
      </div>
      <div class="pill-row" style="margin-top:10px;">
        ${isActive
          ? `<button class="btn btn-sm" data-scope-clear>Show all kennels</button>`
          : `<button class="btn btn-sm" data-scope-to="${esc(k.id)}">Switch to this kennel</button>`}
      </div>
    </section>`;
}

async function renderPortfolio(kennels) {
  if (!portfolioEl) return;
  const own = kennels.filter((k) => k.is_own_kennel && !k.is_archived);
  if (own.length < 2) {
    portfolioEl.innerHTML = '';
    if (allHeadingEl) allHeadingEl.hidden = true;
    return;
  }
  if (allHeadingEl) allHeadingEl.hidden = false;

  const [dogs, litters, sales] = await Promise.all([
    dogRepo.getAll({ includeArchived: false }),
    litterRepo.getAll({ includeArchived: false }),
    saleRepo.getAll({ includeArchived: false })
  ]);
  const year = String(new Date().getFullYear());
  const countsFor = (k) => ({
    dogs: dogs.filter((d) => ['owned', 'co_owned'].includes(d.ownership_type) && d.kennel_id === k.id).length,
    litters: litters.filter((l) => l.kennel_id === k.id && LIVE_LITTER_STATUSES.includes(l.status)).length,
    sales: sales.filter((s) => s.kennel_id === k.id && (s.sale_date || '').startsWith(year)).length
  });

  const activeId = getActiveKennelId();
  portfolioEl.innerHTML = `<p class="field-hint" style="margin-top:6px;">Switching changes what every list, hub, and report shows across the app.</p>`
    + own.map((k) => portfolioCard(k, countsFor(k), activeId)).join('');

  // Switching re-derives every read on every page, so it reloads — the same
  // posture the nav switcher takes.
  portfolioEl.querySelectorAll('[data-scope-to]').forEach((btn) => {
    btn.addEventListener('click', () => { setActiveKennel(btn.dataset.scopeTo); location.reload(); });
  });
  portfolioEl.querySelector('[data-scope-clear]')?.addEventListener('click', () => {
    setActiveKennel(null);
    location.reload();
  });
}

async function render() {
  const kennels = await kennelRepo.getAll({ includeArchived: true });
  renderPortfolio(kennels).catch((e) => showError(e.message || String(e)));
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

document.getElementById('k-add').addEventListener('click', async (e) => {
  // Guards against a rapid double-tap/double-click creating two kennels from
  // one "Add" tap — each call would otherwise run to completion independently.
  const btn = e.currentTarget;
  if (btn.disabled) return;
  btn.disabled = true;
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
  } finally {
    btn.disabled = false;
  }
});

// Kennel cards (End-State guide §28) — the receiving half. Two doors into the
// same dry-run preview: the button here, and a card LINK that lands on this page
// with `#kennelcard=…`. Both re-render the list only once something was written.
mountKennelCardImport(document.getElementById('card-import'), { onDone: () => render() });

render();
maybeOpenCardFromHash({ onDone: () => render() });
