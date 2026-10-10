// kennel.js — Kennel Overview and Settings, a per-kennel HUB (Multi-Kennel Scope Spec §8):
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
//
// One card at a time (decided 2026-10-08): every card carries data-ks="<section>"
// and a dropdown, alphabetical (SECTIONS), shows only the chosen one. A
// #<section> hash opens it directly. There's no Profile card: the kennel's name
// and badges head the page, and identity is edited on the Kennels list.
import { kennelRepo } from '../data/kennelRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import { pairingRepo } from '../data/pairingRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { expenseRepo } from '../data/expenseRepo.js';
import { getIncomeRows, summarize } from '../data/incomeView.js';
import { getActiveKennelId, setActiveKennel } from '../data/kennelScope.js';
import { DOG_STATUS, LITTER_STATUS, SALE_STATUS, FEE_CREDIT_POLICY, WAITLIST_AUTO_OFFER_TRIGGER, WAITLIST_READY_NO_ANSWER } from '../data/vocab.js';
import { editionFlags } from '../data/editionConfig.js';
import { isWaitlistOnlineOffered } from '../data/cloud/cloudConfig.js';
import { waitlistConfig, SOON_NOTICE_DEFAULT, passReasons, showUpcoming, UPCOMING_STAGES, messengerLink } from '../data/waitlistRules.js';
import { PUPPY_RECORD_FIELD_GROUPS, PUPPY_RECORD_FIELD_KEYS, puppyRecordFieldsValue } from '../data/puppyRecordFields.js';
import { EMAIL_TEMPLATE_KINDS, EMAIL_PLACEHOLDERS, DEFAULT_EMAIL_TEMPLATES, emailTemplate } from '../data/waitlistEmails.js';
import { esc, badge, fmtDate, fmtMoney, param } from '../assets/ui.js';
import { renderExpensePanel } from '../assets/expensePanel.js';
import { renderKennelCardSection } from '../assets/kennelCardUI.js';

const els = {
  title: document.getElementById('kennel-title'),
  subtitle: document.getElementById('kennel-subtitle'),
  scope: document.getElementById('kennel-scope'),
  picker: document.getElementById('kennel-section-picker'),
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
// A stored logo stays under about 300 KB (decided 2026-10-10): live sync carries
// it twice in one record (readable + sealed) against the server's ~2 MB row
// (Cloud Phase 2 plan §4.1). A PNG over it is redrawn at smaller sizes; an SVG
// (kept as markup) over it is refused. Upload only: an older, larger logo already
// on a kennel or in a backup still restores.
const LOGO_MAX_CHARS = 300_000;
const LOGO_STEP_EDGES = [LOGO_MAX_EDGE, 360, 240, 160];
const LOGO_TOO_LARGE = 'That logo is too large. Try a smaller image.';

let kennel = null;      // the kennel being viewed
let allDogs = [];        // loaded once, for the "Apply to dogs" picker
let applyOpen = false;   // whether the "Apply to dogs" picker is expanded

function showError(msg) { els.error.innerHTML = `<div class="inline-error">${esc(msg)}</div>`; }
function clearError() { els.error.innerHTML = ''; }

function row(label, valueHtml) {
  return valueHtml ? `<dt>${esc(label)}</dt><dd>${valueHtml}</dd>` : '';
}

// The page heading stays "Kennel Overview and Settings"; which kennel, under it.
function renderHeader(k) {
  els.subtitle.innerHTML = `<strong>${esc(k.kennel_name)}</strong>`
    + (k.is_own_kennel ? ' <span class="badge badge-green">My kennel</span>' : ' <span class="badge badge-neutral">Outside kennel</span>')
    + (k.is_archived ? ' <span class="badge badge-gray">Archived</span>' : '')
    + (k.is_own_kennel ? '' : ' <span class="faint">Reference data only.</span>');
  document.title = `${k.kennel_name} — Kennel Overview and Settings — KennelOS`;
}

// --- Sections (one card at a time) --------------------------------------------
// Every card the page can show, alphabetical by label. `when` says whether this
// kennel has it (own-kennel cards, the waitlist's flag, a received kennel card).
const SECTIONS = [
  { key: 'litters', label: 'Active litters', when: (k) => k.is_own_kennel },
  { key: 'feeding', label: 'Feeding schedules', when: (k) => k.is_own_kennel },
  { key: 'finances', label: 'Finances', when: (k) => k.is_own_kennel },
  { key: 'card', label: 'Kennel card', when: (k) => k.is_own_kennel || !!k.public_id },
  { key: 'expenses', label: 'Kennel expenses', when: () => true },
  { key: 'nudges', label: 'Lifecycle nudges', when: (k) => k.is_own_kennel },
  { key: 'logo', label: 'Logo', when: () => true },
  { key: 'tests', label: 'Preferred tests', when: (k) => k.is_own_kennel },
  { key: 'puppy-record', label: 'Puppy Record fields', when: (k) => k.is_own_kennel && editionFlags.puppyRecord },
  { key: 'placements', label: 'Recent placements', when: (k) => k.is_own_kennel },
  { key: 'roster', label: 'Roster', when: (k) => k.is_own_kennel },
  { key: 'waitlist-settings', label: 'Waitlist settings', when: (k) => k.is_own_kennel && editionFlags.waitlist }
].sort((a, b) => a.label.localeCompare(b.label));

// Show only the chosen section. A stylesheet rule rather than toggling each card,
// so a card re-rendered later (Save re-renders the config cards) stays hidden or
// shown without anyone remembering to re-apply it.
function showSection(key) {
  let style = document.getElementById('kennel-section-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'kennel-section-style';
    document.head.appendChild(style);
  }
  style.textContent = key ? `[data-ks]:not([data-ks="${CSS.escape(key)}"]) { display: none; }` : '[data-ks] { display: none; }';
  const hint = els.picker.querySelector('[data-ks-hint]');
  if (hint) hint.hidden = !!key;
}

function renderSectionPicker(k) {
  const available = SECTIONS.filter((x) => x.when(k));
  const fromHash = decodeURIComponent(location.hash.slice(1));
  const current = available.some((x) => x.key === fromHash) ? fromHash : '';
  els.picker.innerHTML = `
    <div class="field section-picker">
      <label for="kennel-section">Section</label>
      <select id="kennel-section">
        <option value="">Choose a section…</option>
        ${available.map((x) => `<option value="${esc(x.key)}"${x.key === current ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}
      </select>
    </div>
    <div class="empty-state" data-ks-hint>Choose a section to see or change it.</div>`;
  els.picker.querySelector('#kennel-section').addEventListener('change', (e) => {
    const key = e.target.value;
    history.replaceState(null, '', key ? `#${encodeURIComponent(key)}` : location.pathname + location.search);
    showSection(key);
  });
  showSection(current);
}

// A #<section> link followed while the page is already open (same document).
window.addEventListener('hashchange', () => { if (kennel) renderSectionPicker(kennel); });

// --- Logo ------------------------------------------------------------------
// The logo is a plain (unindexed) data-URL string on the Kennel record, so it
// rides JSON backups and needs no schema/index change. Uploads are downscaled
// on a canvas to LOGO_MAX_EDGE and re-encoded as PNG (preserves transparency)
// before storing, then stepped down further until under LOGO_MAX_CHARS, so an
// oversized photo never bloats the record. The invoice /
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
      if (file.type === 'image/svg+xml') {
        if (dataUrl.length > LOGO_MAX_CHARS) reject(new Error(LOGO_TOO_LARGE)); else resolve(dataUrl);
        return;
      }
      const img = new Image();
      img.onerror = () => reject(new Error('That image could not be loaded.'));
      img.onload = () => {
        for (const edge of LOGO_STEP_EDGES) {
          const scale = Math.min(1, edge / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          const png = canvas.toDataURL('image/png');
          if (png.length <= LOGO_MAX_CHARS) { resolve(png); return; }
        }
        reject(new Error(LOGO_TOO_LARGE));
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
  return `<section class="card" data-ks="roster">
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
  return `<section class="card" data-ks="litters">
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
  return `<section class="card" data-ks="placements">
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
  return `<section class="card" data-ks="finances">
      <div class="row-between" style="align-items:baseline;">
        <h2 style="margin:0;">Finances</h2>
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
    + financesCardHtml(incomeRows, kExpenses);
  // Not a section: whether the app is scoped here belongs under the heading.
  els.scope.innerHTML = scopeActionHtml(kennel);
  els.scope.querySelector('[data-act="scope-here"]')?.addEventListener('click', () => {
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
  // The waitlist online's card moved to the waitlist's Publish list page (2026-10-08).
  els.config.innerHTML = nudgeCard(kennel) + testsCard(kennel) + feedingScheduleCard() + puppyRecordCard(kennel) + waitlistCard(kennel);
  wireConfig();
}

// Waitlist settings (Waitlist Spec §4.6) — stored as one Kennel.waitlist_config
// object so they ride the JSON backup (never settings.js/localStorage). One list
// per kennel, so one config per kennel. Pro-only (editionFlags.waitlist).
function waitlistCard(k) {
  if (!editionFlags.waitlist) return '';
  const c = waitlistConfig(k);
  const policyOpts = FEE_CREDIT_POLICY.map((o) => `<option value="${esc(o.value)}"${o.value === c.fee_credit_policy ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
  return `
    <section class="card" id="waitlist-settings" data-ks="waitlist-settings">
      <div class="row-between"><h2 style="margin:0;">Waitlist settings</h2><span class="pill-row"><a class="btn btn-sm" href="waitlist-form.html?kennel=${encodeURIComponent(k.id)}">Application form →</a><a class="btn btn-sm" href="waitlist.html?kennel=${encodeURIComponent(k.id)}">Open waitlist →</a></span></div>
      <p class="field-hint">How ${esc(k.kennel_name)}'s waitlist works. Programs can change the fee and response window for particular families.</p>
      <div class="form-grid">
        <div class="field"><label>Application fee</label><input id="wl-fee" type="number" min="0" step="0.01" value="${esc(c.fee_amount ?? '')}" placeholder="No fee"></div>
        <div class="field"><label>The fee is</label><select id="wl-policy">${policyOpts}</select></div>
        <div class="field"><label>Days to pay after approval</label><input id="wl-fee-days" type="number" min="1" step="1" value="${esc(c.fee_due_days ?? '')}" placeholder="No deadline">
          <span class="field-hint">Blank = no pay-by date, so nothing ever expires.</span></div>
        <div class="field"><label>Days to accept and pay the deposit</label><input id="wl-respond" type="number" min="1" step="1" value="${esc(c.respond_days)}">
          <span class="field-hint">From the offer. A pup they pick is held until then; no deposit in time counts as no response.</span></div>
        <div class="field"><label>Passes before removal</label><input id="wl-passes" type="number" min="1" step="1" value="${esc(c.max_passes)}"></div>
        <div class="field field-wide"><label>Payment instructions</label><textarea id="wl-instructions" placeholder="Venmo @…, Zelle …, or a check to …">${esc(c.payment_instructions)}</textarea>
          <span class="field-hint">What you tell approved families about paying the fee.</span></div>
        <div class="field field-wide">
          <label class="check-inline"><input id="wl-noresp" type="checkbox"${c.no_response_counts_as_pass ? ' checked' : ''}> No response by the deadline counts as a pass</label>
          <label class="check-inline"><input id="wl-colors" type="checkbox"${c.color_matching ? ' checked' : ''}> Match on color (only offer pups in a color the family listed)</label>
        </div>
        <div class="field field-wide"><label>Offer the next family automatically when…</label>
          ${WAITLIST_AUTO_OFFER_TRIGGER.map((t) => `<label class="check-inline"><input type="checkbox" data-wl-auto="${esc(t.value)}"${c.auto_offer_on.includes(t.value) ? ' checked' : ''}> ${esc(t.label)}</label>`).join('')}
          <span class="field-hint">Unticked: you make that offer yourself, with "Offer to them" or "Offer a litter…"; the app just tells you who's next.${isWaitlistOnlineOffered() ? ' With your list online, KennelOS also does the ticked ones while your phone is off: a turn whose last day has passed is closed as no response (or no deposit), and a family\'s pass or leaving on their status page moves the turn on; the next family in line is offered and emailed. Your phone records it all at its next update.' : ''}</span>
        </div>
        <div class="field field-wide"><label for="wl-soon-text">"Almost your turn" message</label>
          <textarea id="wl-soon-text" style="min-height:130px;">${esc(c.soon_notice_text || SOON_NOTICE_DEFAULT)}</textarea>
          <span class="field-hint">Sent from the Almost your turn… button to families whose turn is coming up. The first line is the email subject. [Kennel Name] becomes ${esc(k.kennel_name)}. Clear it to go back to the default.</span></div>
        <div class="field field-wide"><label>Reasons for passing</label>
          <span class="field-hint">A family passing on their status page (on their turn, or "Not this litter" ahead of time) picks one of these, and sees its message when they send it. Passes you record yourself need no reason.</span>
          <div id="wl-reasons">${passReasons({ ...c, pass_other: false }).map(reasonRow).join('')}</div>
          <div class="pill-row" style="margin-top:6px;"><button type="button" class="btn btn-sm" data-act="add-reason">Add a reason</button></div>
          <label class="check-inline" style="margin-top:6px;"><input id="wl-pass-other" type="checkbox"${c.pass_other !== false ? ' checked' : ''}> Also offer "Other", with a box for their own words</label>
        </div>
        ${isWaitlistOnlineOffered() ? readySettings(c) + upcomingSwitches(c) + emailTemplateSettings(c) + facebookSettings(c) : ''}
      </div>
      <div class="form-actions"><button class="btn btn-primary btn-sm" data-act="save-waitlist">Save</button></div>
    </section>`;
}

// What shows online before picks open (Waitlist Spec §16.4): three stages, each
// on the public list and on family pages, all off until she ticks one. Shown
// with the parents' call names and titles and her dates.
// "Ready now?" unanswered (Waitlist Spec §16.7): her rule, and the days.
// Her wording for the emails families get once the list is online (W2 step 6;
// data/waitlistEmails.js). One folded block per email; a field left as the
// default (or cleared) keeps following the default.
function emailTemplateSettings(c) {
  const block = ({ kind, label }) => {
    const t = emailTemplate(c, kind);
    return `<details style="margin:6px 0;"><summary>${esc(label)}</summary>
        <div class="field" style="margin-top:6px;"><label>Subject</label><input type="text" maxlength="200" data-em-tpl="${esc(kind)}" data-em-part="subject" value="${esc(t.subject)}"></div>
        <div class="field"><label>Message</label><textarea style="min-height:150px;" data-em-tpl="${esc(kind)}" data-em-part="body">${esc(t.body)}</textarea></div>
      </details>`;
  };
  return `<div class="field field-wide"><label>Emails to families</label>
      <span class="field-hint">Sent from your kennel's name when you approve, offer, record an outcome or answer a request, after you've seen each one. Every email ends with a link to the family's status page and says replies aren't read. Placeholders: ${EMAIL_PLACEHOLDERS.map((p) => `<strong>${esc(p.key)}</strong> (${esc(p.hint)})`).join(', ')}. Clear a box to go back to the default. Never put amounts or payment details here: families see those on their status page.</span>
      <label class="check-inline" style="margin-top:6px;"><input id="wl-reminders" type="checkbox"${c.email_reminders !== false ? ' checked' : ''}> Send reminders by themselves: halfway through a turn and on its last morning, the day before a fee is due, and "Ready now?" when a family's hold ends</label>
      <span class="field-hint">KennelOS sends these while your phone is off, once each, after 8 am in your kennel's time zone. Turns that end are closed, and the next family offered, only for the moments ticked under "Offer the next family automatically when…".</span>
      ${EMAIL_TEMPLATE_KINDS.map(block).join('')}
    </div>`;
}

// "Message us on Facebook" on status pages (Waitlist Spec §11): off by default,
// and only with a facebook.com or m.me link (messengerLink).
function facebookSettings(c) {
  return `<div class="field field-wide">
      <label class="check-inline"><input id="wl-fb-on" type="checkbox"${c.facebook_button ? ' checked' : ''}> Show "Message us on Facebook" on status pages</label>
      <label for="wl-fb-page" style="margin-top:6px;">Your Facebook Page link</label>
      <input id="wl-fb-page" type="url" inputmode="url" autocomplete="url" value="${esc(c.facebook_page || '')}" placeholder="facebook.com/yourkennel">
      <span class="field-hint">A facebook.com or m.me address.</span>
      <span class="field-hint">Messages sent there stay in Messenger. They aren't added to the family's entry, and they don't count as a reply to an offer.</span>
    </div>`;
}

function readySettings(c) {
  const opts = WAITLIST_READY_NO_ANSWER.map((o) => `<option value="${esc(o.value)}"${o.value === c.ready_no_answer ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
  return `<div class="field"><label>When a family doesn't answer "Ready now?"</label><select id="wl-ready-rule">${opts}</select>
      <span class="field-hint">Asked on their status page when the readiness hold from their application ends (online lists only). Not yet = a new date and a reason, sent to you as a pause request.</span></div>
    <div class="field"><label>Days to answer</label><input id="wl-ready-days" type="number" min="1" step="1" value="${esc(c.ready_answer_days)}">
      <span class="field-hint">"Wait, then remove": removed after this many days, with a 7-day undo. "Keep paused": Today lists them after this many days.</span></div>`;
}

function upcomingSwitches(c) {
  const show = showUpcoming(c);
  const box = (stage, where) => `<label class="check-inline"><input type="checkbox" data-wl-show="${esc(stage)}:${where}"${show[stage][where] ? ' checked' : ''}> ${where === 'public' ? 'Public list' : 'Family pages'}</label>`;
  return `<div class="field field-wide"><label>Show online before picks open</label>
      <span class="field-hint">Each with the parents' call names and titles, and your dates: a pairing's expected whelp date; a litter's whelp date and "Picks expected to open" (its accept-deposits date). Family pages also show whether it's one they're waiting for, their place for a born litter, and "Not this litter".</span>
      ${UPCOMING_STAGES.map((st) => `<div style="margin-top:6px;"><strong style="font-size:0.95em;">${esc(st.label)}</strong><div class="pill-row">${box(st.value, 'public')}${box(st.value, 'family')}</div></div>`).join('')}
      <div class="inline-warn"><strong>The public list is open to anyone with its link:</strong> ticking "Public list" makes those breeding plans public.</div>
    </div>`;
}

// One editable pass reason: its label and the message the family sees.
function reasonRow(r = { id: '', label: '', message: '' }) {
  return `<div class="card" data-reason-id="${esc(r.id)}" style="margin:6px 0;padding:10px 12px;">
      <div class="form-grid">
        <div class="field field-wide"><label>Reason</label><input type="text" data-reason="label" maxlength="120" value="${esc(r.label)}" placeholder="e.g. Financial reasons"></div>
        <div class="field field-wide"><label>Message shown when they pass</label><textarea data-reason="message" maxlength="500" placeholder="e.g. We appreciate your feedback…">${esc(r.message)}</textarea></div>
      </div>
      <button type="button" class="btn btn-sm" data-act="remove-reason">Remove</button>
    </div>`;
}

async function onSaveWaitlist() {
  clearError();
  const q = (sel) => els.config.querySelector(sel);
  const num = (sel) => (q(sel).value === '' ? null : Number(q(sel).value));
  const waitlist_config = {
    ...(kennel.waitlist_config || {}),
    fee_amount: num('#wl-fee'),
    fee_credit_policy: q('#wl-policy').value,
    fee_due_days: num('#wl-fee-days'),
    respond_days: num('#wl-respond'),
    max_passes: num('#wl-passes'),
    payment_instructions: q('#wl-instructions').value.trim(),
    no_response_counts_as_pass: q('#wl-noresp').checked,
    color_matching: q('#wl-colors').checked,
    auto_offer_on: [...els.config.querySelectorAll('[data-wl-auto]:checked')].map((b) => b.dataset.wlAuto),
    // Stored only when she's changed it, so the default wording stays the default.
    soon_notice_text: q('#wl-soon-text').value.trim() === SOON_NOTICE_DEFAULT.trim() ? '' : q('#wl-soon-text').value.trim(),
    pass_reasons: [...els.config.querySelectorAll('[data-reason-id]')].map((row) => ({
      id: row.dataset.reasonId || crypto.randomUUID().slice(0, 8),
      label: row.querySelector('[data-reason="label"]').value.trim(),
      message: row.querySelector('[data-reason="message"]').value.trim()
    })).filter((r) => r.label),
    pass_other: q('#wl-pass-other').checked
  };
  if (els.config.querySelector('[data-em-tpl]')) {
    // Only what differs from the default is stored, so a default stays the default.
    const templates = {};
    for (const el of els.config.querySelectorAll('[data-em-tpl]')) {
      const { emTpl: kind, emPart: part } = el.dataset;
      const value = el.value.trim();
      if (!value || value === DEFAULT_EMAIL_TEMPLATES[kind][part].trim()) continue;
      if (part === 'subject' && /[\r\n]/.test(value)) { showError('An email subject must be one line.'); return; }
      templates[kind] = { ...(templates[kind] || {}), [part]: value };
    }
    waitlist_config.email_templates = Object.keys(templates).length ? templates : null;
    waitlist_config.email_reminders = q('#wl-reminders').checked;
  }
  if (q('#wl-fb-on')) {
    const page = q('#wl-fb-page').value.trim();
    const on = q('#wl-fb-on').checked;
    if (on && !page) { showError('Add your Page link first.'); return; }
    if (page && !messengerLink(page)) { showError('That link isn\'t a Facebook Page. Use a facebook.com or m.me address.'); return; }
    waitlist_config.facebook_button = on;
    waitlist_config.facebook_page = page;
  }
  if (q('#wl-ready-rule')) {
    waitlist_config.ready_no_answer = q('#wl-ready-rule').value;
    waitlist_config.ready_answer_days = num('#wl-ready-days');
    if (waitlist_config.ready_answer_days != null && waitlist_config.ready_answer_days < 1) { showError('Days to answer must be at least 1.'); return; }
  }
  if (els.config.querySelector('[data-wl-show]')) {
    const show = showUpcoming({});
    for (const b of els.config.querySelectorAll('[data-wl-show]')) {
      const [stage, where] = b.dataset.wlShow.split(':');
      show[stage][where] = b.checked;
    }
    waitlist_config.show_upcoming = show;
  }
  if (!waitlist_config.pass_reasons.length && !waitlist_config.pass_other) { showError('Keep at least one reason for passing, or tick "Other".'); return; }
  delete waitlist_config.auto_offer_next; // replaced by auto_offer_on (2026-10-08)
  if (waitlist_config.max_passes != null && waitlist_config.max_passes < 1) { showError('Passes before removal must be at least 1.'); return; }
  try {
    await kennelRepo.update(kennel.id, { waitlist_config });
    await reloadKennel();
    renderConfig();
  } catch (err) { showError(err.message || String(err)); }
}

// Feeding Schedules (§27.2) — per-breed feeding grids, edited on their own page
// (breed-feeding-schedules.html; its breed list is pulled from the kennel's own
// dogs, not scoped to a single Kennel record) and sent along in a placed pup's
// Furever seed packet. This card is just the doorway from "kennel program
// configuration", alongside Lifecycle nudges and Preferred tests.
function feedingScheduleCard() {
  return `
    <section class="card" data-ks="feeding">
      <h2 style="margin-top:0;">Feeding schedules</h2>
      <p class="field-hint">Your own recommended feeding amounts, by breed — sent along with each puppy's Furever seed link.</p>
      <div class="form-actions">
        <a class="btn btn-sm" href="breed-feeding-schedules.html">Open Feeding Schedules →</a>
      </div>
    </section>`;
}

// Puppy Record fields (guide §23): tick what this kennel's printed Puppy Records
// show. Stored as Kennel.puppy_record_fields (only what's off), so it rides the
// backup; data/puppyRecordFields.js holds the list and the read rule. A section's
// own box turns the whole section off; its fields grey out while it's off.
function puppyRecordCard(k) {
  if (!editionFlags.puppyRecord) return '';
  const stored = k.puppy_record_fields || {};
  const box = (key, label, group, master = false) => `<label class="check-inline" style="display:block; margin:4px 0;${master ? ' font-weight:600;' : ' padding-left:22px;'}">
      <input type="checkbox" data-pr-field="${esc(key)}"${group ? ` data-pr-group="${esc(group)}"` : ''}${stored[key] !== false ? ' checked' : ''}${group && stored[group] === false ? ' disabled' : ''}> ${esc(label)}
    </label>`;
  const groups = PUPPY_RECORD_FIELD_GROUPS.map((g) => `
      <div class="field">
        ${g.key ? box(g.key, g.label, null, true) : `<label>${esc(g.label)}</label>`}
        ${g.fields.map((f) => box(f.key, f.label, g.key)).join('')}
      </div>`).join('');
  return `
    <section class="card" data-ks="puppy-record">
      <h2 style="margin-top:0;">Puppy Record fields</h2>
      <p class="field-hint">What this kennel's printed Puppy Records show. Unticked fields are left off the record entirely; a section with nothing ticked is left off, heading and all.</p>
      <div class="form-grid">${groups}</div>
      <div class="form-actions">
        <button class="btn btn-primary btn-sm" data-act="save-puppy-record">Save</button>
        <button class="btn btn-sm" data-act="puppy-record-all">Tick all</button>
      </div>
    </section>`;
}

async function onSavePuppyRecord() {
  clearError();
  const checked = {};
  for (const key of PUPPY_RECORD_FIELD_KEYS) {
    const cb = els.config.querySelector(`[data-pr-field="${CSS.escape(key)}"]`);
    checked[key] = cb ? cb.checked : true;
  }
  try {
    await kennelRepo.update(kennel.id, { puppy_record_fields: puppyRecordFieldsValue(checked) });
    await reloadKennel();
    renderConfig();
  } catch (err) { showError(err.message || String(err)); }
}

// Lifecycle nudges (Data Integrity Brief §3.2) — opt-in, per-kennel: an enable
// checkbox + two month thresholds, saved together.
function nudgeCard(k) {
  return `
    <section class="card" data-ks="nudges">
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
    <section class="card" data-ks="tests">
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
  els.config.querySelector('[data-act="save-puppy-record"]')?.addEventListener('click', onSavePuppyRecord);
  els.config.querySelector('[data-act="puppy-record-all"]')?.addEventListener('click', () => {
    els.config.querySelectorAll('[data-pr-field]').forEach((cb) => { cb.checked = true; cb.disabled = false; });
  });
  els.config.querySelectorAll('[data-pr-field]:not([data-pr-group])').forEach((master) => {
    master.addEventListener('change', () => {
      els.config.querySelectorAll(`[data-pr-group="${CSS.escape(master.dataset.prField)}"]`).forEach((cb) => { cb.disabled = !master.checked; });
    });
  });
  const saveWaitlist = els.config.querySelector('[data-act="save-waitlist"]');
  if (saveWaitlist) saveWaitlist.addEventListener('click', onSaveWaitlist);
  els.config.querySelector('[data-act="add-reason"]')?.addEventListener('click', () => {
    els.config.querySelector('#wl-reasons').insertAdjacentHTML('beforeend', reasonRow());
  });
  els.config.querySelector('#wl-reasons')?.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-act="remove-reason"]')) ev.target.closest('[data-reason-id]').remove();
  });
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
  renderHeader(k);
  renderSectionPicker(k);
  renderLogo();
  renderOverview().catch((e) => showError(e.message || String(e)));
  // Async because an own kennel that predates public_id has one minted on the
  // spot (kennelRepo.ensurePublicId) — self-healing rather than a boot migration.
  renderKennelCardSection(els.card, kennel).catch((e) => showError(e.message || String(e)));
  renderConfig();
  renderExpensePanel({ mount: els.expenses, subjectType: 'kennel', subjectId: k.id, title: 'Kennel Expenses' });
}

main();
