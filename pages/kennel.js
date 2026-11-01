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
import { accountRepo } from '../data/accountRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import { pairingRepo } from '../data/pairingRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { expenseRepo } from '../data/expenseRepo.js';
import { getIncomeRows, summarize } from '../data/incomeView.js';
import { getActiveKennelId, setActiveKennel } from '../data/kennelScope.js';
import { DOG_STATUS, LITTER_STATUS, SALE_STATUS, FEE_CREDIT_POLICY, FEE_CREDIT_TOWARD, WAITLIST_AUTO_OFFER_TRIGGER, WAITLIST_READY_NO_ANSWER, PARENT_TESTS_SHOWN } from '../data/vocab.js';
import { editionFlags } from '../data/editionConfig.js';
import { kennelChargeList, readPriceList, readChargeGroups } from '../data/extraCharges.js';
import { priceListHtml, wirePriceList, readPriceListForm } from '../assets/priceListEditor.js';
import { isWaitlistOnlineOffered } from '../data/cloud/cloudConfig.js';
import { pickupLocations, locationsProblem } from '../data/pickupSlots.js';
import { MILEAGE_BASIS } from '../data/transportFee.js';
import { backOutReasons, backOutPolicy, BACK_OUT_OUTCOMES, BACK_OUT_POLICY_TEXT_DEFAULT } from '../data/backOut.js';
import { waitlistConfig, waitlistConfigProblem, openDays, closedDates, liveClosedDates, SOON_NOTICE_DEFAULT, EXTRAS_INTRO_DEFAULT, passReasons, showUpcoming, UPCOMING_STAGES } from '../data/waitlistRules.js';
import { EMAIL_TEMPLATE_KINDS, EMAIL_PLACEHOLDERS, DEFAULT_EMAIL_TEMPLATES, emailTemplate } from '../data/waitlistEmails.js';
import { esc, badge, fmtDate, fmtMoney, param, todayYMD } from '../assets/ui.js';
import { renderExpensePanel } from '../assets/expensePanel.js';
import { renderKennelCardSection } from '../assets/kennelCardUI.js';
import {
  fileToLogoDataUrl, logoPreview, LOGO_ACCEPT, nudgeFields, readNudgeFields,
  puppyRecordFieldsHtml, wirePuppyRecordFields, tickAllPuppyRecordFields, readPuppyRecordFields
} from '../assets/kennelSettingsFields.js';

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

let kennel = null;      // the kennel being viewed
let paymentServices = []; // Payment service accounts, for the fee's "paid via" (Pro)
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
  { key: 'extra-charges', label: 'Extra charges price list', when: (k) => k.is_own_kennel && editionFlags.extraCharges },
  { key: 'nudges', label: 'Lifecycle nudges', when: (k) => k.is_own_kennel },
  { key: 'logo', label: 'Logo', when: () => true },
  { key: 'tests', label: 'Preferred tests', when: (k) => k.is_own_kennel },
  { key: 'puppy-record', label: 'Puppy Record fields', when: (k) => k.is_own_kennel && editionFlags.puppyRecord },
  { key: 'placements', label: 'Recent placements', when: (k) => k.is_own_kennel },
  { key: 'pickup', label: 'Pickup & transport', when: (k) => k.is_own_kennel && editionFlags.waitlist },
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
// and re-encoded by assets/kennelSettingsFields.js (fileToLogoDataUrl, shared
// with Kels's "Getting Started"), so an oversized photo never bloats the record. The invoice /
// receipt generator and the puppy record read this field back verbatim.
function renderLogo() {
  const k = kennel;
  const preview = logoPreview(k) || `<p class="faint" style="margin:4px 0;">No logo yet.</p>`;
  els.logo.innerHTML = `
    <section class="card">
      <h2 style="margin-top:0;">Logo</h2>
      <p class="field-hint">Shown on this kennel's invoices, receipts, and puppy records. Stored on this device and included in your JSON backups. A square or wide image works best; large uploads are automatically scaled down.</p>
      <div>${preview}</div>
      <input id="logo-file" type="file" accept="${LOGO_ACCEPT}" hidden>
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
  openWaitlistGroups = new Set([...els.config.querySelectorAll('details[data-wl-group][open]')].map((d) => d.dataset.wlGroup));
  // The waitlist online's card moved to the waitlist's Publish list page (2026-10-08).
  els.config.innerHTML = nudgeCard(kennel) + testsCard(kennel) + feedingScheduleCard() + puppyRecordCard(kennel) + extraChargesCard(kennel) + waitlistCard(kennel) + pickupCard(kennel);
  wireConfig();
}

// Which Waitlist settings groups are open, kept across a re-render (Save redraws
// the config cards).
let openWaitlistGroups = new Set();

// Waitlist settings (Waitlist Spec §4.6) — stored as one Kennel.waitlist_config
// object so they ride the JSON backup (never settings.js/localStorage). One list
// per kennel, so one config per kennel. Pro-only (editionFlags.waitlist).
function waitlistCard(k) {
  if (!editionFlags.waitlist) return '';
  const c = waitlistConfig(k);
  const online = isWaitlistOnlineOffered();
  const policyOpts = FEE_CREDIT_POLICY.map((o) => `<option value="${esc(o.value)}"${o.value === c.fee_credit_policy ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
  // Folded groups, all closed at first; one Save for the lot. A group only the
  // online list uses is left out until the list can go online.
  const group = (key, title, hint, body) => `
      <details class="settings-group" data-wl-group="${key}"${openWaitlistGroups.has(key) ? ' open' : ''}>
        <summary><strong>${esc(title)}</strong><span class="field-hint">${esc(hint)}</span></summary>
        <div class="form-grid">
${body}        </div>
      </details>`;
  return `
    <section class="card" id="waitlist-settings" data-ks="waitlist-settings">
      <div class="row-between"><h2 style="margin:0;">Waitlist settings</h2><span class="pill-row"><a class="btn btn-sm" href="waitlist-form.html?kennel=${encodeURIComponent(k.id)}">Application form →</a><a class="btn btn-sm" href="waitlist.html?kennel=${encodeURIComponent(k.id)}">Open waitlist →</a></span></div>
      <p class="field-hint">How ${esc(k.kennel_name)}'s waitlist works. Programs can change the fee and response window for particular families. Open a group to see or change it.</p>
${group('fees', 'Fees & payment', 'Application fee, when it is due, how families pay', `
        <div class="field"><label>Application fee</label><input id="wl-fee" type="number" min="0" step="0.01" value="${esc(c.fee_amount ?? '')}" placeholder="No fee"></div>
        <div class="field"><label>The fee is</label><select id="wl-policy">${policyOpts}</select></div>
        <div class="field"><label>A credited fee counts toward</label><select id="wl-credit-toward">${FEE_CREDIT_TOWARD.map((o) => `<option value="${esc(o.value)}"${o.value === c.fee_credit_toward ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
          <span class="field-hint">When the fee is credited to the purchase price. The deposit: families send the deposit less their fee.</span></div>
        <div class="field"><label>Days to pay after approval</label><input id="wl-fee-days" type="number" min="1" step="1" value="${esc(c.fee_due_days ?? '')}" placeholder="No deadline">
          <span class="field-hint">Blank = no pay-by date, so nothing ever expires.</span></div>
        <div class="field field-wide"><label>Payment instructions</label><textarea id="wl-instructions" placeholder="Venmo @…, Zelle …, or a check to …">${esc(c.payment_instructions)}</textarea>
          <span class="field-hint">What you tell approved families about paying the fee.</span></div>
        ${editionFlags.accounts ? `<div class="field"><label>Fee paid online via</label><select id="wl-fee-account"><option value="">— not online —</option>${paymentServices
            .filter((a) => !a.is_archived || a.id === k.waitlist_fee_account_id)
            .map((a) => `<option value="${esc(a.id)}"${a.id === k.waitlist_fee_account_id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
          <span class="field-hint">A Payment service account (Accounts page). Families get a Pay button with its link; with Stripe connected on this device, a Stripe checkout for the exact fee that KennelOS records as received when they pay.</span></div>
        <div class="field"><label>Ask for the fee</label><select id="wl-fee-when">
            <option value="apply"${c.fee_link_when !== 'approved' ? ' selected' : ''}>At the end of the online application</option>
            <option value="approved"${c.fee_link_when === 'approved' ? ' selected' : ''}>Once I approve them</option></select>
          <span class="field-hint">Paid before you approve them: approving puts them on the list from the day they paid.</span></div>` : ''}
`)}
${group('turns', 'Turns & offers', 'Time to respond, passes, color matching, automatic offers', `
        <div class="field field-wide"><label>Days you do business</label>
          <div class="pill-row">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, n) => `<label class="check-inline"><input type="checkbox" data-wl-open="${n}"${openDays(c).includes(n) ? ' checked' : ''}> ${d}</label>`).join('')}</div>
          <span class="field-hint">Deadlines count only these days, so one never lands on a day you're closed: the days to accept and pay the deposit, to pay the application fee, to answer "Ready now?", to change a pickup time, and extras payment plans. Closed Saturdays: offered on a Friday with 3 days, it's due Tuesday.</span></div>
        <div class="field field-wide"><label for="wl-closed-new">Closed dates</label>
          <div id="wl-closed" class="pill-row">${closedDateChips(liveClosedDates(closedDates(c), todayYMD()))}</div>
          <div class="pill-row" style="margin-top:6px;align-items:center;"><input id="wl-closed-new" type="date" style="width:auto;"><button type="button" class="btn btn-sm" data-act="closed-add">Add date</button></div>
          <span class="field-hint">Any day you're closed, for any reason: skipped like a closed weekday. A date drops off the list by itself a week after it passes.</span></div>
        <div class="field"><label>Days to accept and pay the deposit</label><input id="wl-respond" type="number" min="1" step="1" value="${esc(c.respond_days)}">
          <span class="field-hint">From the offer. A pup they pick is held until then; no deposit in time counts as no response.</span></div>
        <div class="field"><label>Passes before removal</label><input id="wl-passes" type="number" min="1" step="1" value="${esc(c.max_passes)}"></div>
        <div class="field field-wide">
          <label class="check-inline"><input id="wl-noresp" type="checkbox"${c.no_response_counts_as_pass ? ' checked' : ''}> No response by the deadline counts as a pass</label>
          <label class="check-inline"><input id="wl-colors" type="checkbox"${c.color_matching ? ' checked' : ''}> Match on color (only offer pups in a color the family listed)</label>
          <label class="check-inline"><input id="wl-turn-prices" type="checkbox"${c.turn_prices !== false ? ' checked' : ''}> Show your expected prices on a family's turn</label>
          <span class="field-hint">From each litter's expected prices and deposits (Litter page), for males and females; pups planned for Full registration in their own section at their full price. Once a family picks, their page also shows the deposit with your payment instructions.</span>
        </div>
        <div class="field field-wide"><label>Offer the next family automatically when…</label>
          ${WAITLIST_AUTO_OFFER_TRIGGER.map((t) => `<label class="check-inline"><input type="checkbox" data-wl-auto="${esc(t.value)}"${c.auto_offer_on.includes(t.value) ? ' checked' : ''}> ${esc(t.label)}</label>`).join('')}
          <span class="field-hint">Unticked: you make that offer yourself, with "Offer to them" or "Offer a litter…"; the app just tells you who's next.${isWaitlistOnlineOffered() ? ' With your list online, KennelOS also does the ticked ones while your phone is off: a turn whose last day has passed is closed as no response (or no deposit), and a family\'s pass or leaving on their status page moves the turn on; the next family in line is offered and emailed. Your phone records it all at its next update.' : ''}</span>
        </div>
`)}
${group('passing', 'Passing & readiness', online ? 'Reasons families give, and "Ready now?"' : 'Reasons families give when they pass', `
        <div class="field field-wide"><label>Reasons for passing</label>
          <span class="field-hint">A family passing on their status page (on their turn, or "Not this litter" ahead of time) picks one of these, and sees its message when they send it. Passes you record yourself need no reason.</span>
          <div id="wl-reasons">${passReasons({ ...c, pass_other: false }).map(reasonRow).join('')}</div>
          <div class="pill-row" style="margin-top:6px;"><button type="button" class="btn btn-sm" data-act="add-reason">Add a reason</button></div>
          <label class="check-inline" style="margin-top:6px;"><input id="wl-pass-other" type="checkbox"${c.pass_other !== false ? ' checked' : ''}> Also offer "Other", with a box for their own words</label>
        </div>
${online ? readySettings(c) : ''}`)}
      ${group('public', 'Public list & family pages', online ? 'Paused families, upcoming litters, parents\' health tests, Facebook, extras' : 'Paused families on the public list', `
        <div class="field field-wide">
          <label class="check-inline"><input id="wl-show-paused" type="checkbox"${c.public_show_paused ? ' checked' : ''}> Show paused families on the public list</label>
          <span class="field-hint">They keep their number and show "Skipped until" the date their pause ends in place of what they want. Unticked, they're left off and their number is skipped. Applies to the list online and the list copied as text.</span>
        </div>
${online ? upcomingSwitches(c) + parentTestsSetting(c) + facebookSettings(c) + extrasSettings(c) : ''}`)}
${group('messages', 'Messages to families', online ? '"Almost your turn" and the emails families get' : 'The "Almost your turn" message', `
        <div class="field field-wide"><label for="wl-soon-text">"Almost your turn" message</label>
          <textarea id="wl-soon-text" style="min-height:130px;">${esc(c.soon_notice_text || SOON_NOTICE_DEFAULT)}</textarea>
          <span class="field-hint">Sent from the Almost your turn… button to families whose turn is coming up. The first line is the email subject. [Kennel Name] becomes ${esc(k.kennel_name)}. Clear it to go back to the default.</span></div>
${online ? emailTemplateSettings(c) : ''}`)}
      ${online ? group('backout', 'Backing out', 'Reasons, your deposit policy, what families read', backOutSettings(c)) : ''}
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

// Extras on a family's status page (Family Requests plan §3): her message above
// them and her own page with the details and prices. The extras themselves, and
// which ones families can ask for, are on the Extra charges price list.
function extrasSettings(c) {
  return `<div class="field field-wide">
      <label for="wl-extras-intro">Extras: your message to families</label>
      <textarea id="wl-extras-intro" rows="3" placeholder="${esc(EXTRAS_INTRO_DEFAULT)}">${esc(c.extras_intro_text || '')}</textarea>
      <label for="wl-extras-url" style="margin-top:6px;">Your page with the extras' details and prices</label>
      <input id="wl-extras-url" type="url" inputmode="url" autocomplete="url" value="${esc(c.extras_info_url || '')}" placeholder="https://yourkennel.com/extras">
      <span class="field-hint">Families whose pup is picked see your message, a <strong>See our extras and prices</strong> button that opens this page in a new tab, then the extras they can ask for, by name. Prices never show on their page. Choose which extras they can ask for on the Extra charges price list.</span>
    </div>`;
}

// Backing out (Family Requests plan §7): her reasons (one per line; "Something else"
// is always offered), her deposit policy (rows: a reason or any, an optional age,
// keep or move), and what families read before they send.
function policyRowHtml(row, reasons) {
  const r = row || { reason_id: 'any', from_weeks: null, until_weeks: null, outcome: 'keep' };
  return `<div class="bo-row" style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-bottom:6px;">
      <select class="bo-reason" style="width:auto; max-width:100%;"><option value="any">Any reason</option>${reasons.map((x) => `<option value="${esc(x.id)}"${x.id === r.reason_id ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}</select>
      <span style="display:inline-flex; gap:4px; align-items:center;">from <input class="bo-from" type="number" min="0" step="1" value="${esc(r.from_weeks ?? '')}" style="width:4.5em;"> to <input class="bo-until" type="number" min="0" step="1" value="${esc(r.until_weeks ?? '')}" style="width:4.5em;"> weeks</span>
      <select class="bo-outcome" style="width:auto;">${BACK_OUT_OUTCOMES.map((o) => `<option value="${o.value}"${o.value === r.outcome ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
      <button type="button" class="btn btn-sm" data-act="bo-remove" aria-label="Remove">✕</button>
    </div>`;
}

function backOutSettings(c) {
  const reasons = backOutReasons(c);
  const mine = reasons.filter((r) => r.id !== 'other');
  return `<div class="field field-wide" data-bo>
      <label for="wl-bo-reasons">Backing out: the reasons families choose from</label>
      <textarea id="wl-bo-reasons" rows="4">${esc(mine.map((r) => r.label).join('\n'))}</textarea>
      <span class="field-hint">One per line. "Something else" (with a few words) is always offered too.</span>
      <label style="margin-top:8px;">Your deposit policy</label>
      <div id="bo-rows">${backOutPolicy(c).map((row) => policyRowHtml(row, reasons)).join('')}</div>
      <button type="button" class="btn btn-sm" data-act="bo-add">+ Add a rule</button>
      <span class="field-hint">When a family asks to back out, the first rule that fits their reason and the puppy's age (leave the weeks blank for any age) is suggested; you always choose. With none, keeping the deposit is suggested. A refund is never suggested.</span>
      <label for="wl-bo-text" style="margin-top:8px;">What every family reads before they send</label>
      <textarea id="wl-bo-text" rows="6">${esc(c.back_out_policy_text || BACK_OUT_POLICY_TEXT_DEFAULT)}</textarea>
      <span class="field-hint">[Kennel Name] is filled in. Your deposit policy above is never shown to families; it only suggests an outcome to you.</span>
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
      <span class="field-hint">Each with the parents' call names and titles, and your dates: a pairing's expected whelp date; a litter's whelp date and "Picks expected to open" (its accept-deposits date); a planned heat (a future-dated heat on an active breeding female) as "estimated around" its month and year, never the day. Family pages also show whether it's one they're waiting for, their place for a born litter, and "Not this litter".</span>
      ${UPCOMING_STAGES.map((st) => `<div style="margin-top:6px;"><strong style="font-size:0.95em;">${esc(st.label)}</strong><div class="pill-row">${box(st.value, 'public')}${box(st.value, 'family')}</div></div>`).join('')}
      <div class="inline-warn"><strong>The public list is open to anyone with its link:</strong> ticking "Public list" makes those breeding plans public.</div>
    </div>`;
}

// Parents' health tests on family pages (PARENT_TESTS_SHOWN, default off); each
// dog can override it on its Health-Test Summary card (Dog.waitlist_tests).
function parentTestsSetting(c) {
  return `<div class="field field-wide"><label for="wl-parent-tests">Parents' health test results</label>
      <select id="wl-parent-tests">${PARENT_TESTS_SHOWN.map((o) => `<option value="${esc(o.value)}"${(c.parent_tests || 'off') === o.value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
      <span class="field-hint">Wherever family pages show a litter's parents (Coming up, Available Puppies, a family's turn), with a "Health testing" line under them: each completed test's name and your result, the latest result when a test was repeated. Never the lab, dates, notes or documents. <strong>Normal results only</strong> shows a test only when its latest result is marked Normal ("Normal or abnormal" on the test's event); a result not marked either way isn't shown. To choose differently for one dog, use "On family pages" on its Health-Test Summary card.</span>
      <div class="inline-warn"><strong>The public list is open to anyone with its link:</strong> with Coming up or Available Puppies on the public list, these results are public too.</div>
    </div>`;
}

// Her closed dates as removable chips (data-closed holds the date).
function closedDateChips(dates) {
  return dates.length ? dates.map((d) => `<span class="badge badge-neutral" data-closed="${esc(d)}" style="margin:2px 4px 2px 0;">${esc(fmtDate(d))} <button type="button" class="btn btn-sm" data-act="closed-remove" aria-label="Remove ${esc(fmtDate(d))}" style="padding:0 6px;margin-left:4px;">✕</button></span>`).join('')
    : '<span class="faint">None yet.</span>';
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
    fee_credit_toward: q('#wl-credit-toward').value,
    fee_due_days: num('#wl-fee-days'),
    respond_days: num('#wl-respond'),
    max_passes: num('#wl-passes'),
    payment_instructions: q('#wl-instructions').value.trim(),
    ...(q('#wl-fee-when') ? { fee_link_when: q('#wl-fee-when').value } : {}),
    no_response_counts_as_pass: q('#wl-noresp').checked,
    color_matching: q('#wl-colors').checked,
    turn_prices: q('#wl-turn-prices').checked,
    closed_dates: liveClosedDates([...els.config.querySelectorAll('[data-closed]')].map((x) => x.dataset.closed).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort(), todayYMD()),
    open_days: (() => { const d = [...els.config.querySelectorAll('[data-wl-open]')].filter((b) => b.checked).map((b) => Number(b.dataset.wlOpen)); return d.length === 7 ? null : d; })(),
    public_show_paused: q('#wl-show-paused').checked,
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
    waitlist_config.facebook_button = on;
    waitlist_config.facebook_page = page;
  }
  if (q('#wl-bo-reasons')) {
    const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'reason';
    const lines = q('#wl-bo-reasons').value.split('\n').map((t) => t.trim()).filter(Boolean);
    const before = backOutReasons(kennel.waitlist_config || {});
    // A reason keeps its id while its wording stays, so her policy rows still point at it.
    const used = new Set();
    const reasons = lines.map((label) => {
      const same = before.find((r) => r.label === label && r.id !== 'other');
      let id = same ? same.id : slug(label);
      while (used.has(id) || id === 'other' || id === 'any') id = `${id}_2`;
      used.add(id);
      return { id, label };
    });
    waitlist_config.back_out_reasons = reasons.length ? reasons : null;
    waitlist_config.back_out_policy = [...els.config.querySelectorAll('.bo-row')].map((row) => ({
      reason_id: row.querySelector('.bo-reason').value, outcome: row.querySelector('.bo-outcome').value,
      from_weeks: row.querySelector('.bo-from').value === '' ? null : Number(row.querySelector('.bo-from').value),
      until_weeks: row.querySelector('.bo-until').value === '' ? null : Number(row.querySelector('.bo-until').value)
    }));
    const text = q('#wl-bo-text').value.trim();
    waitlist_config.back_out_policy_text = text === BACK_OUT_POLICY_TEXT_DEFAULT ? '' : text;
  }
  if (q('#wl-extras-intro')) {
    const intro = q('#wl-extras-intro').value.trim();
    waitlist_config.extras_intro_text = intro === EXTRAS_INTRO_DEFAULT ? '' : intro;
    waitlist_config.extras_info_url = q('#wl-extras-url').value.trim();
  }
  if (q('#wl-ready-rule')) {
    waitlist_config.ready_no_answer = q('#wl-ready-rule').value;
    waitlist_config.ready_answer_days = num('#wl-ready-days');
  }
  if (q('#wl-parent-tests')) waitlist_config.parent_tests = q('#wl-parent-tests').value;
  if (els.config.querySelector('[data-wl-show]')) {
    const show = showUpcoming({});
    for (const b of els.config.querySelectorAll('[data-wl-show]')) {
      const [stage, where] = b.dataset.wlShow.split(':');
      show[stage][where] = b.checked;
    }
    waitlist_config.show_upcoming = show;
  }
  delete waitlist_config.auto_offer_next; // replaced by auto_offer_on (2026-10-08)
  const problem = waitlistConfigProblem(waitlist_config);
  if (problem) { showError(problem); return; }
  try {
    await kennelRepo.update(kennel.id, {
      waitlist_config,
      ...(q('#wl-fee-account') ? { waitlist_fee_account_id: q('#wl-fee-account').value || null } : {})
    });
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
  return `
    <section class="card" data-ks="puppy-record">
      <h2 style="margin-top:0;">Puppy Record fields</h2>
      <p class="field-hint">What this kennel's printed Puppy Records show. Unticked fields are left off the record entirely; a section with nothing ticked is left off, heading and all.</p>
      <div class="form-grid">${puppyRecordFieldsHtml(k)}</div>
      <div class="form-actions">
        <button class="btn btn-primary btn-sm" data-act="save-puppy-record">Save</button>
        <button class="btn btn-sm" data-act="puppy-record-all">Tick all</button>
      </div>
    </section>`;
}

async function onSavePuppyRecord() {
  clearError();
  try {
    await kennelRepo.update(kennel.id, { puppy_record_fields: readPuppyRecordFields(els.config) });
    await reloadKennel();
    renderConfig();
  } catch (err) { showError(err.message || String(err)); }
}

// Extra charges price list (guide §21.2): her usual extras (photo and training
// packages…) in groups, each a name and a price with optional details, and each
// group's defaults (assets/priceListEditor.js). Stored as Kennel.extra_charge_list
// and Kennel.extra_charge_groups so they ride the backup; a sale's "Add an extra
// charge" picks from the list and copies the name and price, so changing a price
// here never rewrites an old sale.
function extraChargesCard(k) {
  if (!editionFlags.extraCharges) return '';
  return `
    <section class="card" data-ks="extra-charges">
      <h2 style="margin-top:0;">Extra charges price list</h2>
      <p class="field-hint">What you offer on top of a puppy, such as photo or training packages. On a sale, <strong>Add an extra charge</strong> picks from this list, and each one prints as its own line on the invoice. Group them (Photo packages, Training…) and set rules once for a whole group.</p>
      ${priceListHtml(k, { familyRequests: editionFlags.waitlist })}
      <div class="form-actions">
        <button class="btn btn-primary btn-sm" data-act="save-charges">Save</button>
      </div>
    </section>`;
}

async function onSaveCharges() {
  clearError();
  const opts = { familyRequests: editionFlags.waitlist };
  const card = els.config.querySelector('[data-ks="extra-charges"]');
  const form = readPriceListForm(card, opts);
  if (form.error) { showError(form.error); return; }
  const { list, error } = readPriceList(form.rows, kennelChargeList(kennel));
  if (error) { showError(error); return; }
  const { groups, error: groupError } = readChargeGroups(form.groups);
  if (groupError) { showError(groupError); return; }
  try {
    await kennelRepo.update(kennel.id, { extra_charge_list: list, extra_charge_groups: groups });
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
      ${nudgeFields(k)}
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

// Pickup & transport (Family Requests plan §4–§5): her pickup places (one is her
// standard location, the start of every mileage figure: a public place near her,
// never her house), and the settings that work out a transport fee and decide who
// may suggest their own meetup place. Pickup times are set per litter.
function placeRow(l = { id: '', label: '', address: '', notes: '', is_standard: false, show_to_families: true }) {
  return `<div class="pl-row" data-pl-id="${esc(l.id)}" style="border-top:1px solid var(--border); padding:8px 0;">
      <div style="display:flex; gap:8px; align-items:center;">
        <input class="pl-label" type="text" value="${esc(l.label)}" placeholder="e.g. Library parking lot" aria-label="Name" style="flex:1; min-width:0;">
        <button type="button" class="btn btn-sm" data-pl="remove" aria-label="Remove">✕</button>
      </div>
      <input class="pl-address" type="text" value="${esc(l.address)}" placeholder="Street, city, state" aria-label="Address" style="margin-top:6px; width:100%;">
      <input class="pl-notes" type="text" value="${esc(l.notes)}" placeholder="Notes for families (optional), e.g. by the north entrance" aria-label="Notes" style="margin-top:6px; width:100%;">
      <div style="display:flex; flex-wrap:wrap; gap:4px 16px; margin-top:6px;">
        <label class="check-inline"><input type="radio" name="pl-standard" class="pl-standard"${l.is_standard ? ' checked' : ''}> Standard location</label>
        <label class="check-inline"><input type="checkbox" class="pl-show"${l.show_to_families ? ' checked' : ''}> Show to families</label>
      </div>
    </div>`;
}

function pickupCard(k) {
  if (!editionFlags.waitlist) return '';
  const c = waitlistConfig(k);
  const places = pickupLocations(k);
  const n = (id, v, label, unit, hint = '') => `<div class="field"><label for="${id}">${label}</label>
      <span style="display:inline-flex; align-items:center; gap:6px;"><input id="${id}" type="number" min="0" step="any" inputmode="decimal" value="${esc(v ?? '')}" style="width:7em;"> ${esc(unit)}</span>${hint ? `<span class="field-hint">${hint}</span>` : ''}</div>`;
  return `
    <section class="card" data-ks="pickup">
      <h2 style="margin-top:0;">Pickup places</h2>
      <p class="field-hint">Where families pick up their puppies. Your <strong>standard location</strong> is where every mileage figure starts: use a public place near you, not your home address. Set pickup times on each litter's page.</p>
      <div id="pl-list">${(places.length ? places : [{ id: '', label: '', address: '', notes: '', is_standard: true, show_to_families: true }]).map(placeRow).join('')}</div>
      <button type="button" class="btn btn-sm" data-pl="add">+ Add a place</button>
      <h2>Transport fee</h2>
      <p class="field-hint">For a family's own meetup address: KennelOS measures the driving miles from your standard location and suggests the fee, which you can change before approving.</p>
      <div class="form-grid">
        ${n('tr-rate', c.mileage_rate, 'Fee per mile', '$ per mile')}
        <div class="field"><label>Calculate from</label>
          <span style="display:flex; gap:16px;">${MILEAGE_BASIS.map((b) => `<label class="check-inline"><input type="radio" name="tr-basis" value="${b.value}"${c.mileage_basis === b.value ? ' checked' : ''}> ${esc(b.label)}</label>`).join('')}</span>
          <span class="field-hint">Round trip doubles the miles before the fee per mile.</span></div>
        ${n('tr-free', c.mileage_free_under || '', 'No charge under', 'miles', 'A shorter trip is free; at or over it, every mile is charged.')}
        ${n('tr-far', c.transport_far_miles, 'Farther than this, you\'ll be in touch', 'miles', 'Families farther away are told you\'ll contact them about driving or a flight nanny.')}
        ${n('tr-home', c.transport_min_home_miles || '', 'Families can suggest their own place only if they live at least', 'miles away', 'Blank or 0: any family can. Above 0, City / state becomes a required question on your application form.')}
        ${n('tr-change', c.pickup_change_days, 'Families can change their pickup time until', 'days before')}
        ${n('tr-board', c.boarding_rate, 'Standard boarding rate', '$ per day', 'For a pickup date you mark "standard boarding applies" on a litter: charged from when the pup could go home until that day, and logged as a stay.')}
      </div>
      <div class="form-actions"><button class="btn btn-primary btn-sm" data-act="save-pickup">Save</button></div>
    </section>`;
}

async function onSavePickup() {
  clearError();
  const card = els.config.querySelector('[data-ks="pickup"]');
  const rows = [...card.querySelectorAll('.pl-row')].map((el) => ({
    id: el.dataset.plId || crypto.randomUUID(), label: el.querySelector('.pl-label').value, address: el.querySelector('.pl-address').value,
    notes: el.querySelector('.pl-notes').value, is_standard: el.querySelector('.pl-standard').checked, show_to_families: el.querySelector('.pl-show').checked
  }));
  const problem = locationsProblem(rows);
  if (problem) { showError(problem); return; }
  const q = (sel) => card.querySelector(sel).value.trim();
  const val = (sel) => (q(sel) === '' ? null : Number(q(sel)));
  const waitlist_config = {
    ...(kennel.waitlist_config || {}),
    mileage_rate: val('#tr-rate'), mileage_basis: card.querySelector('input[name="tr-basis"]:checked')?.value || 'round_trip',
    mileage_free_under: val('#tr-free') || 0, transport_far_miles: val('#tr-far'), transport_min_home_miles: val('#tr-home') || 0,
    pickup_change_days: val('#tr-change') ?? 2, boarding_rate: val('#tr-board')
  };
  const configProblem = waitlistConfigProblem(waitlist_config);
  if (configProblem) { showError(configProblem); return; }
  try {
    await kennelRepo.update(kennel.id, { pickup_locations: pickupLocations({ pickup_locations: rows }), waitlist_config });
    await reloadKennel();
    renderConfig();
  } catch (err) { showError(err.message || String(err)); }
}

function wirePickup() {
  const card = els.config.querySelector('[data-ks="pickup"]');
  if (!card) return;
  card.querySelector('[data-act="save-pickup"]').addEventListener('click', onSavePickup);
  card.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-pl]');
    if (!b) return;
    if (b.dataset.pl === 'remove') b.closest('.pl-row').remove();
    if (b.dataset.pl === 'add') {
      const list = card.querySelector('#pl-list');
      list.insertAdjacentHTML('beforeend', placeRow({ id: '', label: '', address: '', notes: '', is_standard: !list.querySelector('.pl-standard:checked'), show_to_families: true }));
      list.lastElementChild.querySelector('.pl-label').focus();
    }
  });
}

function wireConfig() {
  wirePickup();
  const saveNudges = els.config.querySelector('[data-act="save-nudges"]');
  if (saveNudges) saveNudges.addEventListener('click', onSaveNudges);
  els.config.querySelector('[data-act="save-puppy-record"]')?.addEventListener('click', onSavePuppyRecord);
  els.config.querySelector('[data-act="save-charges"]')?.addEventListener('click', onSaveCharges);
  const chargesCard = els.config.querySelector('[data-ks="extra-charges"]');
  if (chargesCard) wirePriceList(chargesCard, { familyRequests: editionFlags.waitlist });
  els.config.querySelector('[data-act="puppy-record-all"]')?.addEventListener('click', () => tickAllPuppyRecordFields(els.config));
  wirePuppyRecordFields(els.config);
  els.config.querySelector('[data-act="bo-add"]')?.addEventListener('click', () => {
    els.config.querySelector('#bo-rows').insertAdjacentHTML('beforeend', policyRowHtml(null, backOutReasons(kennel.waitlist_config || {})));
  });
  els.config.querySelector('#bo-rows')?.addEventListener('click', (ev) => { if (ev.target.closest('[data-act="bo-remove"]')) ev.target.closest('.bo-row').remove(); });
  const saveWaitlist = els.config.querySelector('[data-act="save-waitlist"]');
  if (saveWaitlist) saveWaitlist.addEventListener('click', onSaveWaitlist);
  // Closed dates: added and removed here, saved with the rest.
  const closedList = () => [...els.config.querySelectorAll('[data-closed]')].map((x) => x.dataset.closed);
  els.config.querySelector('[data-act="closed-add"]')?.addEventListener('click', () => {
    const input = els.config.querySelector('#wl-closed-new');
    if (!input.value) return;
    els.config.querySelector('#wl-closed').innerHTML = closedDateChips([...new Set([...closedList(), input.value])].sort());
    input.value = '';
  });
  els.config.querySelector('#wl-closed')?.addEventListener('click', (ev) => {
    const chip = ev.target.closest('[data-act="closed-remove"]')?.closest('[data-closed]');
    if (!chip) return;
    els.config.querySelector('#wl-closed').innerHTML = closedDateChips(closedList().filter((d) => d !== chip.dataset.closed));
  });
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
  const changes = readNudgeFields(els.config);
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
  if (editionFlags.accounts) paymentServices = (await accountRepo.getAll({ includeArchived: true })).filter((a) => a.account_type === 'payment_service');
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
