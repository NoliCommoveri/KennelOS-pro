// kennel.js — Kennel Detail, now a per-kennel HUB (Multi-Kennel Scope Spec §8):
// roster counts, active litters, recent placements, and this kennel's P&L, all
// derived on load and all filtered on THIS kennel's id rather than the active
// scope — you opened this kennel's page, so you get its numbers whichever kennel
// the app is currently narrowed to. Below the hub, the page keeps what it always
// was: the home for one kennel's program configuration
// (own kennels only): the promote-lifecycle nudge thresholds (Data Integrity
// Brief §3.2) and the preferred-tests panel (Test Planning Addendum §6.1), both
// moved here from the lightweight Kennels list (kennels.js), which now only
// handles identity CRUD (name/prefix/location/own + archive/delete). The page
// also hosts the kennel-wide Expenses ledger: costs that belong to the whole
// kennel rather than any one dog or litter (facility, bulk food, registration
// dues, marketing…), all carrying subject_type='kennel' + subject_id=this kennel.
import { kennelRepo } from '../data/kennelRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import { pairingRepo } from '../data/pairingRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { expenseRepo } from '../data/expenseRepo.js';
import { getIncomeRows, summarize } from '../data/incomeView.js';
import { getActiveKennelId, setActiveKennel } from '../data/kennelScope.js';
import { DOG_STATUS, LITTER_STATUS, SALE_STATUS } from '../data/vocab.js';
import { esc, badge, fmtDate, fmtMoney, param } from '../assets/ui.js';
import { renderExpensePanel } from '../assets/expensePanel.js';
import { renderKennelCardSection } from '../assets/kennelCardUI.js';

const els = {
  title: document.getElementById('kennel-title'),
  subtitle: document.getElementById('kennel-subtitle'),
  body: document.getElementById('profile-body'),
  error: document.getElementById('page-error'),
  logo: document.getElementById('logo-section'),
  card: document.getElementById('kennel-card-section'),
  config: document.getElementById('kennel-config'),
  overview: document.getElementById('kennel-overview'),
  expenses: document.getElementById('expenses-section')
};

// How many recent placements the hub lists before "see all".
const RECENT_PLACEMENTS = 5;

// Longest edge (px) a logo is downscaled to before it's stored as a data URL.
// Keeps the backup-riding string small; a program logo needs no more resolution
// than this on a printed one-page document.
const LOGO_MAX_EDGE = 480;

let kennel = null;      // the kennel being viewed
let allDogs = [];        // loaded once, for the "Apply to dogs" picker
let applyOpen = false;   // whether the "Apply to dogs" picker is expanded

function showError(msg) { els.error.innerHTML = `<div class="inline-error">${esc(msg)}</div>`; }
function clearError() { els.error.innerHTML = ''; }

function row(label, valueHtml) {
  return valueHtml ? `<dt>${esc(label)}</dt><dd>${valueHtml}</dd>` : '';
}

function renderProfile(k) {
  els.title.innerHTML = esc(k.kennel_name) +
    (k.is_own_kennel ? ' <span class="badge badge-green">My kennel</span>' : '') +
    (k.is_archived ? ' <span class="badge badge-gray">Archived</span>' : '');
  els.subtitle.textContent = k.is_own_kennel
    ? 'This kennel’s roster, litters, placements, finances, and program configuration.'
    : 'An outside kennel — reference data only.';
  els.body.innerHTML = `
    <dl class="dl-meta" style="margin-top:14px;">
      ${row('Name', esc(k.kennel_name))}
      ${row('Prefix', esc(k.prefix))}
      ${row('Location', esc(k.location))}
      ${row('Website', k.website ? `<a href="${esc(k.website)}" target="_blank" rel="noopener noreferrer">${esc(k.website)}</a>` : '')}
    </dl>
    <p class="field-hint" style="margin-top:10px;">Edit a kennel's name, prefix, or
      location from the <a href="kennels.html">Kennels list</a>. Program settings
      and kennel-wide overhead live below.</p>`;
}

// --- Logo ------------------------------------------------------------------
// The logo is a plain (unindexed) data-URL string on the Kennel record, so it
// rides JSON backups and needs no schema/index change. Uploads are downscaled
// on a canvas to LOGO_MAX_EDGE and re-encoded as PNG (preserves transparency)
// before storing, so an oversized photo never bloats the record. The invoice /
// receipt generator and the puppy record read this field back verbatim.
function renderLogo() {
  const k = kennel;
  const preview = k.logo_data_url
    ? `<img src="${esc(k.logo_data_url)}" alt="${esc(k.kennel_name)} logo" style="max-width:180px; max-height:180px; object-fit:contain; border:1px solid var(--border); border-radius:var(--radius); background:#fff; padding:6px;">`
    : `<p class="faint" style="margin:4px 0;">No logo yet.</p>`;
  els.logo.innerHTML = `
    <section class="card">
      <h2 style="margin-top:0;">Logo</h2>
      <p class="field-hint">Shown on this kennel's invoices, receipts, and puppy records. Stored on this device and included in your JSON backups. A square or wide image works best; large uploads are automatically scaled down.</p>
      <div>${preview}</div>
      <input id="logo-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden>
      <div class="form-actions">
        <button class="btn btn-sm" data-act="logo-choose">${k.logo_data_url ? 'Replace logo' : 'Upload logo'}</button>
        ${k.logo_data_url ? '<button class="btn btn-danger btn-sm" data-act="logo-remove">Remove logo</button>' : ''}
      </div>
      <div id="logo-error"></div>
    </section>`;

  const fileInput = els.logo.querySelector('#logo-file');
  els.logo.querySelector('[data-act="logo-choose"]').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) onLogoFile(fileInput.files[0]); });
  const removeBtn = els.logo.querySelector('[data-act="logo-remove"]');
  if (removeBtn) removeBtn.addEventListener('click', onLogoRemove);
}

function logoError(msg) {
  const box = els.logo.querySelector('#logo-error');
  if (box) box.innerHTML = msg ? `<div class="inline-error">${esc(msg)}</div>` : '';
}

// Read a file, downscale it on a canvas, and resolve a PNG data URL. SVGs are
// vector — kept as-is (data URL of the raw markup) rather than rasterized.
function fileToLogoDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) { reject(new Error('Please choose an image file.')); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const dataUrl = String(reader.result);
      if (file.type === 'image/svg+xml') { resolve(dataUrl); return; }
      const img = new Image();
      img.onerror = () => reject(new Error('That image could not be loaded.'));
      img.onload = () => {
        const scale = Math.min(1, LOGO_MAX_EDGE / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

async function onLogoFile(file) {
  logoError('');
  try {
    const logo_data_url = await fileToLogoDataUrl(file);
    await kennelRepo.update(kennel.id, { logo_data_url });
    await reloadKennel();
    renderLogo();
  } catch (err) { logoError(err.message || String(err)); }
}

async function onLogoRemove() {
  logoError('');
  try {
    await kennelRepo.update(kennel.id, { logo_data_url: null });
    await reloadKennel();
    renderLogo();
  } catch (err) { logoError(err.message || String(err)); }
}

// --- The per-kennel hub (Multi-Kennel Scope Spec §8) -----------------------
// What makes kennel.html a real hub rather than a config screen: this kennel's
// roster, its live litters, its recent placements, and its P&L.
//
// Everything here filters on THIS kennel's id, never on the active scope — you
// opened this kennel's page, so you get this kennel's numbers whichever kennel
// the app is currently narrowed to. (That is also why the income read passes
// `kennelId` explicitly: getIncomeRows() otherwise honors the active scope.)
// Own kennels only: an outside kennel is reference data, with no program of ours
// to report on.

function statTile(num, label, href) {
  const cls = ['stat', num === 0 ? 'stat-zero' : ''].filter(Boolean).join(' ');
  const inner = `<div class="stat-num">${esc(num)}</div><div class="stat-label">${esc(label)}</div>`;
  return href ? `<a class="${cls}" href="${href}">${inner}</a>` : `<div class="${cls}">${inner}</div>`;
}

function moneyTile(label, value, tone) {
  return `<div class="card" style="margin:0; height:100%; box-sizing:border-box; text-align:center; padding:14px;">
      <div class="muted" style="font-size:12px; text-transform:uppercase; letter-spacing:.04em;">${esc(label)}</div>
      <div style="font-size:22px; font-weight:700; padding-top:4px;${tone ? ` color:var(--${tone});` : ''}">${esc(value)}</div>
    </div>`;
}

function dogName(id) {
  return hub.dogsById.get(id)?.call_name || '—';
}

function litterLabel(l) {
  return l.nickname || `${dogName(l.dam_id)} × ${dogName(l.sire_id)}`;
}

// Loaded once by loadHub(); kept module-level so the render helpers above can
// resolve names without threading maps through every call.
const hub = { dogsById: new Map(), contactsById: new Map() };

// A litter still in progress — anything short of closed. `sold` stays here on
// purpose: pups are spoken for but not all delivered, so it is still live work.
const LIVE_LITTER_STATUSES = ['expected', 'whelped', 'weaning', 'ready', 'sold'];

async function loadHub(k) {
  const [dogs, litters, pairings, sales, contacts, expenses, incomeRows] = await Promise.all([
    dogRepo.getAll({ includeArchived: true }),
    litterRepo.getAll({ includeArchived: false }),
    pairingRepo.getAll({ includeArchived: false }),
    saleRepo.getAll({ includeArchived: false }),
    contactRepo.getAll({ includeArchived: true }),
    expenseRepo.getAll({ includeArchived: false }),
    getIncomeRows({ includeArchived: false, kennelId: k.id })
  ]);
  hub.dogsById = new Map(dogs.map((d) => [d.id, d]));
  hub.contactsById = new Map(contacts.map((c) => [c.id, c]));

  const mine = (r) => r.kennel_id === k.id;
  // The roster is the dogs this kennel OWNS. An external/leased dog carries
  // somebody else's kennel (or none) and belongs to no roster of ours — the same
  // rule that makes it scope-transparent everywhere else (spec §3.1a).
  const roster = dogs.filter((d) => ['owned', 'co_owned'].includes(d.ownership_type) && mine(d));
  const kLitters = litters.filter(mine);
  const kSales = sales.filter(mine);

  // An expense carries no kennel of its own (spec §4.1) — its scope is its
  // subject's. Resolve that here by membership in this kennel's own record ids.
  const ownIds = new Set([
    k.id,
    ...roster.map((d) => d.id),
    ...kLitters.map((l) => l.id),
    ...pairings.filter(mine).map((p) => p.id)
  ]);
  const kExpenses = expenses.filter((x) => ownIds.has(x.subject_id));

  return { roster, kLitters, kSales, kExpenses, incomeRows };
}

function rosterCardHtml(roster) {
  const active = roster.filter((d) => !d.is_archived);
  const byStatus = new Map();
  for (const d of active) byStatus.set(d.status, (byStatus.get(d.status) || 0) + 1);
  const tiles = DOG_STATUS
    .filter((s) => (byStatus.get(s.value) || 0) > 0)
    .map((s) => statTile(byStatus.get(s.value), s.label, 'dogs.html'))
    .join('');
  return `<section class="card">
      <div class="row-between" style="align-items:baseline;">
        <h2 style="margin:0;">Roster <span class="muted" style="font-size:14px;">(${active.length})</span></h2>
        <a class="btn btn-sm" href="dogs.html">All dogs →</a>
      </div>
      <p class="field-hint">Dogs this kennel owns or co-owns, by status. External and leased dogs belong to no kennel of yours, so they are not counted here.</p>
      ${tiles ? `<div class="stat-grid">${tiles}</div>` : '<div class="empty-state">No dogs on this kennel’s roster yet.</div>'}
    </section>`;
}

function littersCardHtml(kLitters) {
  const live = kLitters
    .filter((l) => LIVE_LITTER_STATUSES.includes(l.status))
    .sort((a, b) => (b.whelp_date || '').localeCompare(a.whelp_date || ''));
  const rows = live.map((l) => `<li class="row-between" style="padding:8px 0; border-top:1px solid var(--border);">
      <span><a href="litter.html?id=${encodeURIComponent(l.id)}"><strong>${esc(litterLabel(l))}</strong></a> ${badge(LITTER_STATUS, l.status)}</span>
      <span class="muted" style="white-space:nowrap;">${l.whelp_date ? esc(fmtDate(l.whelp_date)) : '<span class="faint">not whelped</span>'}</span>
    </li>`).join('');
  return `<section class="card">
      <div class="row-between" style="align-items:baseline;">
        <h2 style="margin:0;">Active litters <span class="muted" style="font-size:14px;">(${live.length})</span></h2>
        <a class="btn btn-sm" href="breeding.html">Breeding →</a>
      </div>
      ${rows ? `<ul class="linked-list" style="margin:6px 0 0; padding:0; list-style:none;">${rows}</ul>`
             : '<div class="empty-state">No litters in progress at this kennel.</div>'}
    </section>`;
}

function placementsCardHtml(kSales) {
  const recent = kSales
    .slice()
    .sort((a, b) => (b.sale_date || b.created_at || '').localeCompare(a.sale_date || a.created_at || ''))
    .slice(0, RECENT_PLACEMENTS);
  const rows = recent.map((s) => `<li class="row-between" style="padding:8px 0; border-top:1px solid var(--border);">
      <span><a href="sale.html?id=${encodeURIComponent(s.id)}"><strong>${esc(dogName(s.dog_id))}</strong></a>
        <span class="muted">→ ${esc(hub.contactsById.get(s.buyer_contact_id)?.name || '—')}</span> ${badge(SALE_STATUS, s.status)}</span>
      <span class="muted" style="white-space:nowrap;">${s.sale_date ? esc(fmtDate(s.sale_date)) : '<span class="faint">—</span>'}</span>
    </li>`).join('');
  return `<section class="card">
      <div class="row-between" style="align-items:baseline;">
        <h2 style="margin:0;">Recent placements <span class="muted" style="font-size:14px;">(${kSales.length} total)</span></h2>
        <a class="btn btn-sm" href="sales.html">Sales →</a>
      </div>
      ${rows ? `<ul class="linked-list" style="margin:6px 0 0; padding:0; list-style:none;">${rows}</ul>`
             : '<div class="empty-state">No placements recorded for this kennel yet.</div>'}
    </section>`;
}

function financesCardHtml(incomeRows, kExpenses) {
  const { totals } = summarize(incomeRows);
  const spent = expenseRepo.total(kExpenses);
  const net = totals.earned - spent;
  return `<section class="card">
      <div class="row-between" style="align-items:baseline;">
        <h2 style="margin:0;">This kennel's finances</h2>
        <a class="btn btn-sm" href="financials.html">Financials →</a>
      </div>
      <p class="field-hint">Derived exactly as the Financials hub derives its own totals — nothing stored. Expenses include this kennel's overhead plus the costs on its dogs, litters, and pairings.</p>
      <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:12px; margin-top:10px;">
        ${moneyTile('Earned income', fmtMoney(totals.earned), 'success')}
        ${moneyTile('Anticipated income', fmtMoney(totals.anticipated), 'warning')}
        ${moneyTile('Expenses', fmtMoney(spent), 'danger')}
        ${moneyTile('Net (earned − spent)', fmtMoney(net), net < 0 ? 'danger' : 'success')}
      </div>
    </section>`;
}

// "You are viewing another kennel" — the switcher's counterpart on the hub, so
// the page you are reading and the scope the rest of the app is under can be
// brought into agreement in one click.
function scopeActionHtml(k) {
  if (getActiveKennelId() === k.id) {
    return `<p class="field-hint" style="margin-top:10px;">The app is currently scoped to this kennel — lists, hubs, and reports are showing its records.</p>`;
  }
  return `<div class="pill-row" style="margin-top:10px;">
      <button class="btn btn-sm" data-act="scope-here">Scope the app to ${esc(k.kennel_name)}</button>
    </div>`;
}

async function renderOverview() {
  if (!kennel.is_own_kennel) { els.overview.innerHTML = ''; return; }
  const { roster, kLitters, kSales, kExpenses, incomeRows } = await loadHub(kennel);
  els.overview.innerHTML =
    rosterCardHtml(roster)
    + littersCardHtml(kLitters)
    + placementsCardHtml(kSales)
    + financesCardHtml(incomeRows, kExpenses)
    + scopeActionHtml(kennel);
  els.overview.querySelector('[data-act="scope-here"]')?.addEventListener('click', () => {
    setActiveKennel(kennel.id);
    location.reload();
  });
}

// Own-kennel program configuration: lifecycle nudges + preferred tests. Only
// own kennels get these (promote-to-breeding is about our own puppies; the
// preferred-tests panel feeds the shared vocabulary of our own program), the
// same gating both panels carried on the old Kennels-list rows.
function renderConfig() {
  if (!kennel.is_own_kennel) { els.config.innerHTML = ''; return; }
  els.config.innerHTML = nudgeCard(kennel) + testsCard(kennel) + feedingScheduleCard();
  wireConfig();
}

// Feeding Schedules (§27.2) — per-breed feeding grids, edited on their own page
// (breed-feeding-schedules.html; its breed list is pulled from the kennel's own
// dogs, not scoped to a single Kennel record) and sent along in a placed pup's
// Furever seed packet. This card is just the doorway from "kennel program
// configuration", alongside Lifecycle nudges and Preferred tests.
function feedingScheduleCard() {
  return `
    <section class="card">
      <h2 style="margin-top:0;">Feeding schedules</h2>
      <p class="field-hint">Your own recommended feeding amounts, by breed — sent along with each puppy's Furever seed link.</p>
      <div class="form-actions">
        <a class="btn btn-sm" href="breed-feeding-schedules.html">Open Feeding Schedules →</a>
      </div>
    </section>`;
}

// Lifecycle nudges (Data Integrity Brief §3.2) — opt-in, per-kennel: an enable
// checkbox + two month thresholds, saved together.
function nudgeCard(k) {
  return `
    <section class="card">
      <h2 style="margin-top:0;">Lifecycle nudges</h2>
      <p class="field-hint">Opt-in reminders to promote kept puppies to active breeding once they're old enough.</p>
      <div class="form-grid">
        <div class="field field-wide"><label class="check-inline"><input id="e-promote-enabled" type="checkbox"${k.promote_nudge_enabled ? ' checked' : ''}> Nudge me to promote kept puppies to active breeding once they're old enough</label></div>
        <div class="field field-wide">
          <label>Promote age (months)</label>
          <div class="promote-age-row">
            <div class="field"><label>Male</label><input id="e-promote-male" type="number" min="0" step="1" value="${esc(k.promote_age_male_months ?? 6)}"></div>
            <div class="field"><label>Female</label><input id="e-promote-female" type="number" min="0" step="1" value="${esc(k.promote_age_female_months ?? 12)}"></div>
          </div>
        </div>
      </div>
      <div class="form-actions"><button class="btn btn-primary btn-sm" data-act="save-nudges">Save</button></div>
    </section>`;
}

// Preferred-tests editor (Test Planning Addendum §6.1). The checkbox list
// reflects current panel membership; unchecking removes panel membership going
// forward only, never the vocabulary token itself. Listed alphabetically; a
// test pulled in via the breed-seed import shows the breed(s) that tagged it
// in parentheses (kennelRepo.testBreedsFor) — that's what keeps two
// same-named tests imported for different breeds reading as one unambiguous
// row instead of looking like an accidental duplicate.
function testsCard(k) {
  const tests = [...(k.preferred_tests || [])].sort((a, b) => a.localeCompare(b));
  const checklist = tests.length
    ? tests.map((t) => {
        const breeds = kennelRepo.testBreedsFor(k, t);
        const suffix = breeds.length ? ` <span class="faint">(${breeds.map((b) => esc(b)).join(', ')})</span>` : '';
        return `
        <label class="check-inline" style="display:block; margin:4px 0;">
          <input type="checkbox" data-remove-test="${esc(t)}" checked> ${esc(t)}${suffix}
        </label>`;
      }).join('')
    : `<p class="faint" style="margin:4px 0;">No preferred tests yet.</p>`;
  const breedOptions = [...(k.preferred_breeds || [])].sort((a, b) => a.localeCompare(b));
  // Tagging a manually-typed test to breed(s) is optional (Test Planning
  // Addendum §8) — leave every box unchecked and it stays breed-agnostic,
  // same as before breed-scoping existed. Sourced from this kennel's own
  // breed pool (preferred_breeds); hidden entirely if that pool is empty,
  // since there'd be nothing to pick from.
  const breedPicker = breedOptions.length
    ? `<div class="field" style="margin-top:8px;">
        <label>Tag to breed(s) <span class="faint" style="font-weight:normal;">— optional, leave unchecked to apply to every breed</span></label>
        <div class="check-group">
          ${breedOptions.map((b) => `<label class="check-inline"><input type="checkbox" data-tp-breed="${esc(b)}"> ${esc(b)}</label>`).join('')}
        </div>
      </div>`
    : '';
  return `
    <section class="card">
      <h2 style="margin-top:0;">Preferred tests</h2>
      <p class="field-hint">Changes apply to newly added dogs only. Existing dogs keep their current plans — use "Apply to dogs" to update them.</p>
      <div>${checklist}</div>
      <div class="form-grid" style="margin-top:8px;">
        <div class="field"><label>Add a test</label>
          <input id="tp-new" type="text" placeholder="Type a test, then press Enter">
        </div>
      </div>
      ${breedPicker}
      <div class="form-actions">
        <button class="btn btn-sm" data-act="tp-add">Add</button>
        <button class="btn btn-sm" data-act="tp-apply">Apply to dogs…</button>
      </div>
      ${applyOpen ? applyToDogsPanel() : ''}
    </section>`;
}

// "Apply to dogs" (Test Planning Addendum §5) — additive: adds the panel's
// tests to each selected owned/co-owned dog's plan, scoped per dog to its own
// breed (kennelRepo.testsForBreed — a breed-tagged test only lands on a dog of
// that breed; an untagged/breed-agnostic test lands on every dog, as before).
// Never removes a test the breeder pruned from an individual dog; adding an
// already-present token is a no-op.
function applyToDogsPanel() {
  const eligible = allDogs.filter((d) => ['owned', 'co_owned'].includes(d.ownership_type));
  if (!eligible.length) return `<p class="faint" style="margin-top:8px;">No owned/co-owned dogs to apply to.</p>`;
  const rows = eligible.map((d) => `
    <label class="check-inline" style="display:block; margin:4px 0;">
      <input type="checkbox" data-apply-dog="${esc(d.id)}"> ${esc(d.call_name)}${d.registered_name ? ' — ' + esc(d.registered_name) : ''}
    </label>`).join('');
  return `<div style="margin-top:10px; border-top:1px solid var(--border); padding-top:10px;">
    <p class="field-hint">Adds every test currently in the panel above to each selected dog's plan.</p>
    ${rows}
    <div class="form-actions">
      <button class="btn btn-primary btn-sm" data-act="tp-apply-confirm">Apply</button>
    </div>
  </div>`;
}

function wireConfig() {
  const saveNudges = els.config.querySelector('[data-act="save-nudges"]');
  if (saveNudges) saveNudges.addEventListener('click', onSaveNudges);

  els.config.querySelectorAll('[data-remove-test]').forEach((cb) => {
    cb.addEventListener('change', async (e) => {
      if (e.target.checked) return; // only act on uncheck
      try {
        await kennelRepo.removePreferredTest(kennel.id, e.target.dataset.removeTest);
        await reloadKennel();
        renderConfig();
      } catch (err) { showError(err.message || String(err)); }
    });
  });

  const newInput = els.config.querySelector('#tp-new');
  const addBtn = els.config.querySelector('[data-act="tp-add"]');
  if (addBtn) addBtn.addEventListener('click', () => addTest(newInput));
  if (newInput) newInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    addTest(newInput);
  });

  const applyBtn = els.config.querySelector('[data-act="tp-apply"]');
  if (applyBtn) applyBtn.addEventListener('click', () => { applyOpen = !applyOpen; renderConfig(); });

  const applyConfirm = els.config.querySelector('[data-act="tp-apply-confirm"]');
  if (applyConfirm) applyConfirm.addEventListener('click', onApplyConfirm);
}

async function addTest(inputEl) {
  const val = inputEl.value.trim();
  if (!val) return;
  clearError();
  const breeds = [...els.config.querySelectorAll('[data-tp-breed]:checked')].map((cb) => cb.dataset.tpBreed);
  try {
    if (breeds.length) {
      for (const breed of breeds) await kennelRepo.addPreferredTest(kennel.id, val, breed);
    } else {
      await kennelRepo.addPreferredTest(kennel.id, val);
    }
    await reloadKennel();
    renderConfig();
  } catch (err) { showError(err.message || String(err)); }
}

async function onApplyConfirm() {
  const checked = [...els.config.querySelectorAll('[data-apply-dog]:checked')].map((el) => el.dataset.applyDog);
  if (!checked.length) return;
  clearError();
  try {
    await Promise.all(checked.map((dogId) => {
      const dog = allDogs.find((d) => d.id === dogId);
      return dogRepo.addPlannedTests(dogId, kennelRepo.testsForBreed(kennel, dog?.breed));
    }));
    applyOpen = false;
    renderConfig();
  } catch (err) { showError(err.message || String(err)); }
}

async function onSaveNudges() {
  clearError();
  const changes = {
    promote_nudge_enabled: els.config.querySelector('#e-promote-enabled').checked,
    promote_age_male_months: Number(els.config.querySelector('#e-promote-male').value) || 0,
    promote_age_female_months: Number(els.config.querySelector('#e-promote-female').value) || 0
  };
  try {
    await kennelRepo.update(kennel.id, changes);
    await reloadKennel();
    renderConfig();
  } catch (err) { showError(err.message || String(err)); }
}

async function reloadKennel() {
  kennel = await kennelRepo.getById(kennel.id);
}

async function main() {
  const id = param('id');
  if (!id) { showError('No kennel id provided.'); return; }
  const [k, dogs] = await Promise.all([kennelRepo.getById(id), dogRepo.getAll()]);
  if (!k) { showError('Kennel not found. It may have been deleted.'); return; }
  kennel = k;
  allDogs = dogs;
  renderProfile(k);
  renderLogo();
  renderOverview().catch((e) => showError(e.message || String(e)));
  // Async because an own kennel that predates public_id has one minted on the
  // spot (kennelRepo.ensurePublicId) — self-healing rather than a boot migration.
  renderKennelCardSection(els.card, kennel).catch((e) => showError(e.message || String(e)));
  renderConfig();
  renderExpensePanel({ mount: els.expenses, subjectType: 'kennel', subjectId: k.id, title: 'Kennel Expenses' });
}

main();
