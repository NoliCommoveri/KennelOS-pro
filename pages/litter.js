// litter.js — Litter Detail. Edit-in-place profile (whelping counts, dates,
// optional linked-Pairing picker with sync-and-warn), a derived Puppy Roster
// panel (Dog records with this litter_id; Add Puppy / Add N Puppies), and a
// Timeline of litter-subject events. Hard blocks come from litterRepo (required
// fields); the sync/count/date checks are warn-only here per Stage 3 Brief §3.
import { litterRepo, ReferenceBlockedError } from '../data/litterRepo.js';
import { CapExceededError } from '../data/repoBase.js';
import { pairingRepo } from '../data/pairingRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { LITTER_STATUS, PAIRING_STATUS, DOG_STATUS, SEX, SALE_STATUS, FOSTER_DIRECTION, FOSTER_COMP_MODEL, FOSTER_SPLIT_BASIS, descriptor } from '../data/vocab.js';
import { editionFlags } from '../data/editionConfig.js';
import { esc, badge, fmtDate, fmtMoney, todayYMD, param, confirmModal, dogRefHtml } from '../assets/ui.js';
import { renderUpgradeNudge } from '../assets/upgradeNudge.js';
import { addDaysToYMD } from '../data/dateUtils.js';
import { renderTimeline } from '../assets/timeline.js';
import { renderExpensePanel } from '../assets/expensePanel.js';
import { openAddPuppyForm, openAddPuppiesForm } from '../assets/puppyForm.js';
import { openEventForm, openEventFromQuery } from '../assets/eventForm.js';

// Statuses at/after whelping — used to decide whether a future whelp_date warns.
const WHELPED_OR_LATER = ['whelped', 'weaning', 'ready', 'sold', 'closed'];

// Estimated ready date defaults to 8 weeks (56 days) after whelping.
const READY_DAYS_AFTER_WHELP = 56;

const els = {
  title: document.getElementById('litter-title'),
  subtitle: document.getElementById('litter-subtitle'),
  headerActions: document.getElementById('header-actions'),
  profileActions: document.getElementById('profile-actions'),
  body: document.getElementById('profile-body'),
  error: document.getElementById('page-error'),
  roster: document.getElementById('roster-section'),
  timeline: document.getElementById('timeline-section'),
  expenses: document.getElementById('expenses-section'),
  income: document.getElementById('income-section')
};

const blankLitter = () => ({
  pairing_id: '', dam_id: '', sire_id: '', nickname: '', whelp_date: '', accept_deposits_date: '', estimated_ready_date: '', litter_registration_number: '',
  puppies_born_total: '', puppies_born_alive: '', puppies_born_deceased: '', puppies_born_abnormalities: '', status: '', notes: '',
  expected_price_male: '', expected_price_female: '', expected_deposit_male: '', expected_deposit_female: '',
  foster_direction: '', foster_partner_contact_id: '', foster_comp_model: '',
  foster_our_share_pct: '', foster_split_basis: '', foster_flat_fee_per_pup: '', foster_split_notes: ''
});

const ctx = {
  mode: 'view',
  original: null,
  draft: null,
  pickerArchived: false,
  allDogs: [],
  allPairings: [],
  allContacts: [],
  dogsById: new Map(),
  pairingsById: new Map(),
  contactsById: new Map(),
  kennelsById: new Map()
};

async function loadRefs() {
  const [dogs, pairings, contacts, kennels] = await Promise.all([
    dogRepo.getAll({ includeArchived: true }),
    pairingRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true }),
    kennelRepo.getAll({ includeArchived: true })
  ]);
  ctx.allDogs = dogs;
  ctx.allPairings = pairings;
  ctx.allContacts = contacts;
  ctx.dogsById = new Map(dogs.map((d) => [d.id, d]));
  ctx.pairingsById = new Map(pairings.map((p) => [p.id, p]));
  ctx.contactsById = new Map(contacts.map((c) => [c.id, c]));
  ctx.kennelsById = new Map(kennels.map((k) => [k.id, k]));
}

function dogName(id) {
  const d = ctx.dogsById.get(id);
  return d ? (d.call_name + (d.registered_name ? ` (${d.registered_name})` : '')) : '';
}
// Read-only dog reference → a link to that dog's detail page. Returns '' when the
// id doesn't resolve, so row() falls back to its faint dash. Escapes the name.
function dogLink(id) {
  const name = dogName(id);
  if (!name) return '';
  return dogRefHtml(id, name, ctx.dogsById.get(id)?.is_archived);
}
function pairingLabel(p) {
  if (!p) return '';
  return `${dogName(p.sire_id) || '—'} × ${dogName(p.dam_id) || '—'}${p.planned_date ? ` (${fmtDate(p.planned_date)})` : ''}`;
}

// --- Option builders -----------------------------------------------------
function vocabOptions(vocab, current, placeholder) {
  const head = placeholder != null ? `<option value="">${esc(placeholder)}</option>` : '';
  return head + vocab.map((v) =>
    `<option value="${esc(v.value)}"${v.value === current ? ' selected' : ''}>${esc(v.label)}</option>`
  ).join('');
}

// Statuses eligible as a litter's dam/sire: our own active breeding stock,
// plus external dogs (outside studs, foster dams) — those carry
// 'external_reference' rather than 'active_breeding' since they aren't our own
// breeding stock, but they're still valid breeding partners.
const BREEDING_ELIGIBLE_STATUS = ['active_breeding', 'external_reference'];

// Dam/sire picker: excludes archived by default, limited to the matching sex
// plus "unknown", and scoped to breeding-eligible dogs (a
// retired/deceased/pet-home/puppy dog isn't a breeding candidate) — the
// current selection always stays listed so a mismatched legacy record is
// still editable (warned, not hidden).
function dogOptions(current, sex) {
  const opts = ctx.allDogs
    .filter((d) => ctx.pickerArchived || !d.is_archived || d.id === current)
    .filter((d) => !sex || d.id === current || d.sex === sex || d.sex === 'unknown')
    .filter((d) => d.id === current || BREEDING_ELIGIBLE_STATUS.includes(d.status))
    .map((d) => `<option value="${esc(d.id)}"${d.id === current ? ' selected' : ''}>${esc(d.call_name)}${d.registered_name ? ' — ' + esc(d.registered_name) : ''}${d.is_archived ? ' (archived)' : ''}</option>`)
    .join('');
  return `<option value="">— select —</option>` + opts;
}

function pairingOptions(current) {
  const opts = ctx.allPairings
    .filter((p) => ctx.pickerArchived || !p.is_archived || p.id === current)
    .map((p) => `<option value="${esc(p.id)}"${p.id === current ? ' selected' : ''}>${esc(pairingLabel(p))}${p.is_archived ? ' (archived)' : ''}</option>`)
    .join('');
  return `<option value="">— none —</option>` + opts;
}

function contactOptions(current) {
  const opts = ctx.allContacts
    .filter((c) => ctx.pickerArchived || !c.is_archived || c.id === current)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map((c) => `<option value="${esc(c.id)}"${c.id === current ? ' selected' : ''}>${esc(c.name)}${c.is_archived ? ' (archived)' : ''}</option>`)
    .join('');
  return `<option value="">— none —</option>` + opts;
}

// A foster partner contact's kennel name, if that contact is tied to a kennel —
// this is the "owner kennel" (foster-in) / "caretaker kennel" (foster-out) that
// can optionally be revealed on a companion share.
function contactKennelName(contactId) {
  const c = ctx.contactsById.get(contactId);
  return c?.kennel_id ? (ctx.kennelsById?.get(c.kennel_id)?.kennel_name || '') : '';
}

// --- Read-only view ------------------------------------------------------
function row(label, valueHtml) {
  return `<dt>${esc(label)}</dt><dd>${valueHtml || '<span class="faint">—</span>'}</dd>`;
}

function money(v) {
  return v != null && v !== '' ? `$${Number(v).toFixed(2)}` : '';
}

function countsDisplay(l) {
  const has = (v) => v != null && v !== '';
  if (!has(l.puppies_born_total) && !has(l.puppies_born_alive) && !has(l.puppies_born_deceased) && !has(l.puppies_born_abnormalities)) return '';
  const parts = [];
  if (has(l.puppies_born_total)) parts.push(`${esc(String(l.puppies_born_total))} total`);
  if (has(l.puppies_born_alive)) parts.push(`${esc(String(l.puppies_born_alive))} alive`);
  if (has(l.puppies_born_deceased)) parts.push(`${esc(String(l.puppies_born_deceased))} deceased`);
  if (has(l.puppies_born_abnormalities)) parts.push(`${esc(String(l.puppies_born_abnormalities))} with abnormalities`);
  return parts.join(' · ');
}

function renderView() {
  const l = ctx.original;
  const pairing = ctx.pairingsById.get(l.pairing_id);
  const pairingHtml = pairing
    ? `<a href="pairing.html?id=${encodeURIComponent(pairing.id)}">${esc(pairingLabel(pairing))}</a>`
    : '';
  els.body.innerHTML = `
    ${syncWarningHtml(l)}
    ${fosterViewHtml(l)}
    <dl class="dl-meta" style="margin-top:14px;">
      ${row('Nickname', esc(l.nickname))}
      ${row('Dam', dogLink(l.dam_id))}
      ${row('Sire', dogLink(l.sire_id))}
      ${row('Linked pairing', pairingHtml)}
      ${row('Whelp date', l.whelp_date ? esc(fmtDate(l.whelp_date)) : '')}
      ${row('Accept deposits date', l.accept_deposits_date ? esc(fmtDate(l.accept_deposits_date)) : '')}
      ${row('Estimated ready date', l.estimated_ready_date ? esc(fmtDate(l.estimated_ready_date)) : '')}
      ${row('Litter registration #', esc(l.litter_registration_number))}
      ${row('Puppies born', countsDisplay(l))}
      ${row('Status', badge(LITTER_STATUS, l.status))}
      ${row('Expected price (male)', esc(money(l.expected_price_male)))}
      ${row('Expected deposit (male)', esc(money(l.expected_deposit_male)))}
      ${row('Expected price (female)', esc(money(l.expected_price_female)))}
      ${row('Expected deposit (female)', esc(money(l.expected_deposit_female)))}
      ${row('Notes', l.notes ? esc(l.notes).replace(/\n/g, '<br>') : '')}
    </dl>`;
}

// Foster arrangement (version(2), guide §4): a callout above the profile, shown
// only for a foster litter. The partner is the dam's owner (foster-in) or the
// caretaker (foster-out); their kennel is the "owner/caretaker kennel" that a
// companion share can optionally reveal. The income split is documentation — the
// real payout to the other party is a `foster_split` Expense on this litter.
function fosterViewHtml(l) {
  if (!editionFlags.fosterArrangement || !l.foster_direction) return '';
  const partner = ctx.contactsById.get(l.foster_partner_contact_id);
  const kennelName = contactKennelName(l.foster_partner_contact_id);
  const partnerLabel = l.foster_direction === 'foster_in' ? 'Owner (dam belongs to)' : 'Caretaker (raising the pups)';
  // Compensation reads by model: a flat per-pup fee, or a % income split.
  const isFlat = l.foster_comp_model === 'flat_per_pup';
  const compRows = isFlat
    ? row('Flat fee per pup', l.foster_flat_fee_per_pup != null && l.foster_flat_fee_per_pup !== ''
        ? `${esc(money(l.foster_flat_fee_per_pup))} per pup` : '')
    : row('Our income share', l.foster_our_share_pct != null && l.foster_our_share_pct !== ''
        ? `${esc(String(l.foster_our_share_pct))}% to us${l.foster_split_basis ? ` · ${esc(descriptor(FOSTER_SPLIT_BASIS, l.foster_split_basis).label)}` : ''}` : '');
  return `<div class="card" style="margin-top:14px; border-left:3px solid var(--amber, #d97706);">
    <div class="row-between" style="align-items:center;">
      <h3 style="margin:0;">Foster arrangement ${badge(FOSTER_DIRECTION, l.foster_direction)}</h3>
    </div>
    <dl class="dl-meta" style="margin-top:10px;">
      ${row(partnerLabel, partner ? `${editionFlags.contactsSection ? `<a href="contact.html?id=${encodeURIComponent(partner.id)}">${esc(partner.name)}</a>` : esc(partner.name)}${kennelName ? ` <span class="faint">(${esc(kennelName)})</span>` : ''}` : '')}
      ${row('Compensation', l.foster_comp_model ? esc(descriptor(FOSTER_COMP_MODEL, l.foster_comp_model).label) : '')}
      ${compRows}
      ${row('Terms', l.foster_split_notes ? esc(l.foster_split_notes).replace(/\n/g, '<br>') : '')}
    </dl>
    <p class="muted" style="margin:6px 0 0; font-size:12px;">Record the other party's cut as a <strong>Foster compensation</strong> expense below; flag any owner-reimbursable costs as <strong>Reimbursable</strong>.</p>
  </div>`;
}

// Sync-and-warn (Data Model §5.4 / Stage 3 Brief §3): when a pairing is linked,
// the litter's own dam/sire are authoritative but should match the pairing's.
// Mismatch warns, never blocks. Returns a banner (or '') for both view and edit.
function syncMismatches(l) {
  const pairing = ctx.pairingsById.get(l.pairing_id);
  if (!pairing) return [];
  const out = [];
  if (l.dam_id && pairing.dam_id && l.dam_id !== pairing.dam_id) {
    out.push(`This litter's dam (${dogName(l.dam_id) || '—'}) doesn't match the linked pairing's dam (${dogName(pairing.dam_id) || '—'}).`);
  }
  if (l.sire_id && pairing.sire_id && l.sire_id !== pairing.sire_id) {
    out.push(`This litter's sire (${dogName(l.sire_id) || '—'}) doesn't match the linked pairing's sire (${dogName(pairing.sire_id) || '—'}).`);
  }
  return out;
}
function syncWarningHtml(l) {
  const m = syncMismatches(l);
  return m.length ? `<div class="inline-warn">${m.map(esc).join('<br>')}</div>` : '';
}

// True when any foster field is already set — the Foster arrangement
// <details> defaults open for an existing foster litter, closed otherwise.
function hasFosterData(l) {
  return Boolean(l.foster_direction || l.foster_partner_contact_id || l.foster_comp_model ||
    l.foster_our_share_pct || l.foster_split_basis || l.foster_flat_fee_per_pup || l.foster_split_notes);
}

// --- Edit form -----------------------------------------------------------
function field(label, inner, { required = false, hint = '', wide = false } = {}) {
  return `<div class="field${wide ? ' field-wide' : ''}">
    <label>${esc(label)}${required ? ' <span class="req">*</span>' : ''}</label>
    ${inner}
    ${hint ? `<span class="field-hint">${esc(hint)}</span>` : ''}
  </div>`;
}

function renderEdit() {
  const l = ctx.draft;
  els.body.innerHTML = `
    <div class="form-grid" id="litter-form" style="margin-top:14px;">
      ${field('Nickname', `<input id="f-nickname" type="text" value="${esc(l.nickname)}" maxlength="80">`, { hint: 'Optional friendly name for this litter, e.g. “Party of Five”.', wide: true })}
      ${field('Linked pairing', `<select id="f-pairing_id">${pairingOptions(l.pairing_id)}</select>`, { hint: 'Optional. Choosing one fills in dam/sire below (still editable).', wide: true })}
      ${field('Dam', `<select id="f-dam_id">${dogOptions(l.dam_id, 'female')}</select>`, { required: true })}
      ${field('Sire', `<select id="f-sire_id">${dogOptions(l.sire_id, 'male')}</select>`, { required: true })}
      ${field('Status', `<select id="f-status">${vocabOptions(LITTER_STATUS, l.status, 'Select…')}</select>`, { required: true })}
      ${field('Whelp date', `<input id="f-whelp_date" type="date" value="${esc(l.whelp_date)}">`, { hint: 'May be a projected date while status is Expected.' })}
      ${field('Accept deposits date', `<input id="f-accept_deposits_date" type="date" value="${esc(l.accept_deposits_date)}">`, { hint: 'When you begin accepting deposits on this litter. Shown to prospective families when set.' })}
      ${field('Estimated ready date', `<input id="f-estimated_ready_date" type="date" value="${esc(l.estimated_ready_date)}">`, { hint: 'Defaults to 8 weeks (56 days) after the whelp date. Still editable.' })}
      ${field('Litter registration #', `<input id="f-litter_registration_number" type="text" value="${esc(l.litter_registration_number)}">`)}
      ${field('Puppies born (total)', `<input id="f-puppies_born_total" type="number" min="0" value="${esc(l.puppies_born_total)}">`)}
      ${field('Born alive', `<input id="f-puppies_born_alive" type="number" min="0" value="${esc(l.puppies_born_alive)}">`)}
      ${field('Born deceased', `<input id="f-puppies_born_deceased" type="number" min="0" value="${esc(l.puppies_born_deceased)}">`)}
      ${field('Born with abnormalities', `<input id="f-puppies_born_abnormalities" type="number" min="0" value="${esc(l.puppies_born_abnormalities)}">`)}
      <div class="field field-wide"><h3 style="margin:8px 0 0;">Males — expected price &amp; deposit</h3></div>
      ${field('Expected price (male)', `<input id="f-expected_price_male" type="number" min="0" step="0.01" value="${esc(l.expected_price_male)}">`, { hint: 'Prefills a new sale\'s price when the puppy sold is male. Still editable per sale.' })}
      ${field('Expected deposit (male)', `<input id="f-expected_deposit_male" type="number" min="0" step="0.01" value="${esc(l.expected_deposit_male)}">`, { hint: 'Prefills a new sale\'s deposit amount when the puppy sold is male. Still editable per sale.' })}
      <div class="field field-wide"><h3 style="margin:8px 0 0;">Females — expected price &amp; deposit</h3></div>
      ${field('Expected price (female)', `<input id="f-expected_price_female" type="number" min="0" step="0.01" value="${esc(l.expected_price_female)}">`, { hint: 'Prefills a new sale\'s price when the puppy sold is female. Still editable per sale.' })}
      ${field('Expected deposit (female)', `<input id="f-expected_deposit_female" type="number" min="0" step="0.01" value="${esc(l.expected_deposit_female)}">`, { hint: 'Prefills a new sale\'s deposit amount when the puppy sold is female. Still editable per sale.' })}
      ${editionFlags.includeArchivedToggles ? `<div class="field field-wide">
        <label class="check-inline"><input id="picker-archived" type="checkbox"${ctx.pickerArchived ? ' checked' : ''}> Include archived dogs/pairings/contacts in the pickers above</label>
      </div>` : ''}
      ${field('Notes', `<textarea id="f-notes">${esc(l.notes)}</textarea>`, { wide: true })}
      ${editionFlags.fosterArrangement ? `<details class="field-wide"${hasFosterData(l) ? ' open' : ''}>
        <summary style="cursor:pointer; font-weight:600; margin:8px 0;">Foster arrangement</summary>
        <span class="field-hint">Leave the direction blank for an ordinary litter. Foster is per-litter — the same dam can have foster and non-foster litters.</span>
        <div class="form-grid" style="margin-top:10px;">
          ${field('Foster direction', `<select id="f-foster_direction">${vocabOptions(FOSTER_DIRECTION, l.foster_direction, '— none (not a foster litter) —')}</select>`, { hint: 'Foster in: an external dam\'s litter raised in your care. Foster out: your dam\'s litter raised elsewhere.', wide: true })}
          ${field('Foster partner', `<select id="f-foster_partner_contact_id">${contactOptions(l.foster_partner_contact_id)}</select>`, { hint: 'The dam\'s owner (foster in) or the caretaker (foster out). Their kennel is the owner/caretaker kennel a companion share can reveal.', wide: true })}
          ${field('Compensation model', `<select id="f-foster_comp_model">${vocabOptions(FOSTER_COMP_MODEL, l.foster_comp_model, '— income split (default) —')}</select>`, { hint: 'How the other party is paid. Either way, log their actual cut as a Foster compensation expense.', wide: true })}
          ${l.foster_comp_model === 'flat_per_pup'
            ? field('Flat fee per pup', `<input id="f-foster_flat_fee_per_pup" type="number" min="0" step="0.01" value="${esc(l.foster_flat_fee_per_pup)}">`, { hint: 'A fixed amount per puppy. Documentation only — the actual payout is a Foster compensation expense.' })
            : field('Our income share (%)', `<input id="f-foster_our_share_pct" type="number" min="0" max="100" step="0.1" value="${esc(l.foster_our_share_pct)}">`, { hint: 'Documentation only — record the other party\'s actual cut as a Foster compensation expense.' })}
          ${l.foster_comp_model === 'flat_per_pup'
            ? ''
            : field('Split basis', `<select id="f-foster_split_basis">${vocabOptions(FOSTER_SPLIT_BASIS, l.foster_split_basis, '—')}</select>`)}
          ${field('Terms', `<textarea id="f-foster_split_notes">${esc(l.foster_split_notes)}</textarea>`, { hint: 'The exact agreed terms, in your words.', wide: true })}
        </div>
      </details>` : ''}
    </div>
    <div id="form-warn"></div>`;

  const form = document.getElementById('litter-form');
  form.addEventListener('input', updateWarnings);
  form.addEventListener('change', updateWarnings);
  document.getElementById('picker-archived')?.addEventListener('change', (e) => {
    ctx.draft = readForm();
    ctx.pickerArchived = e.target.checked;
    renderEdit();
  });
  // Choosing a pairing fills dam/sire from it (only when those are still empty,
  // so it never clobbers a deliberate choice) — matches Stage 3 Brief §4.
  document.getElementById('f-pairing_id').addEventListener('change', (e) => {
    ctx.draft = readForm();
    const p = ctx.pairingsById.get(e.target.value);
    if (p) {
      if (!ctx.draft.dam_id) ctx.draft.dam_id = p.dam_id || '';
      if (!ctx.draft.sire_id) ctx.draft.sire_id = p.sire_id || '';
    }
    renderEdit();
  });
  // Switching the foster compensation model swaps which fields show (flat fee
  // per pup vs. income share % + basis), so re-render off the current draft.
  document.getElementById('f-foster_comp_model')?.addEventListener('change', () => {
    ctx.draft = readForm();
    renderEdit();
  });
  // Whelp date prefills estimated ready date (8 weeks later) — only while that
  // field is still empty, so it never clobbers a deliberate edit.
  document.getElementById('f-whelp_date').addEventListener('change', (e) => {
    ctx.draft = readForm();
    if (e.target.value && !ctx.draft.estimated_ready_date) {
      ctx.draft.estimated_ready_date = addDaysToYMD(e.target.value, READY_DAYS_AFTER_WHELP);
    }
    renderEdit();
  });
  updateWarnings();
}

function readForm() {
  const val = (id) => document.getElementById(id)?.value ?? '';
  return {
    ...ctx.draft,
    nickname: val('f-nickname').trim(),
    pairing_id: val('f-pairing_id') || '',
    dam_id: val('f-dam_id') || '',
    sire_id: val('f-sire_id') || '',
    status: val('f-status'),
    whelp_date: val('f-whelp_date'),
    accept_deposits_date: val('f-accept_deposits_date'),
    estimated_ready_date: val('f-estimated_ready_date'),
    litter_registration_number: val('f-litter_registration_number').trim(),
    puppies_born_total: val('f-puppies_born_total'),
    puppies_born_alive: val('f-puppies_born_alive'),
    puppies_born_deceased: val('f-puppies_born_deceased'),
    puppies_born_abnormalities: val('f-puppies_born_abnormalities'),
    expected_price_male: val('f-expected_price_male'),
    expected_price_female: val('f-expected_price_female'),
    expected_deposit_male: val('f-expected_deposit_male'),
    expected_deposit_female: val('f-expected_deposit_female'),
    notes: val('f-notes'),
    // The whole Foster arrangement section is absent from the DOM in Lite
    // (editionFlags.fosterArrangement off) — every field here falls back to
    // its stored draft value rather than being clobbered to '' by val().
    foster_direction: document.getElementById('f-foster_direction') ? val('f-foster_direction') : (ctx.draft.foster_direction ?? ''),
    foster_partner_contact_id: document.getElementById('f-foster_partner_contact_id') ? val('f-foster_partner_contact_id') : (ctx.draft.foster_partner_contact_id ?? ''),
    foster_comp_model: document.getElementById('f-foster_comp_model') ? val('f-foster_comp_model') : (ctx.draft.foster_comp_model ?? ''),
    // The comp-model-specific inputs only exist in the DOM for their model, so a
    // hidden one keeps its stored draft value (never clobbered to '' by val()).
    foster_our_share_pct: document.getElementById('f-foster_our_share_pct') ? val('f-foster_our_share_pct') : (ctx.draft.foster_our_share_pct ?? ''),
    foster_split_basis: document.getElementById('f-foster_split_basis') ? val('f-foster_split_basis') : (ctx.draft.foster_split_basis ?? ''),
    foster_flat_fee_per_pup: document.getElementById('f-foster_flat_fee_per_pup') ? val('f-foster_flat_fee_per_pup') : (ctx.draft.foster_flat_fee_per_pup ?? ''),
    foster_split_notes: document.getElementById('f-foster_split_notes') ? val('f-foster_split_notes') : (ctx.draft.foster_split_notes ?? '')
  };
}

function updateWarnings() {
  const l = readForm();
  const warns = [...syncMismatches(l)];
  const dam = ctx.dogsById.get(l.dam_id);
  const sire = ctx.dogsById.get(l.sire_id);
  if (dam && dam.sex === 'male') warns.push('Selected dam is recorded as male.');
  if (sire && sire.sex === 'female') warns.push('Selected sire is recorded as female.');

  const num = (v) => (v === '' || v == null ? null : Number(v));
  const total = num(l.puppies_born_total);
  const alive = num(l.puppies_born_alive);
  const deceased = num(l.puppies_born_deceased);
  if (total != null && alive != null && deceased != null && alive + deceased > total) {
    warns.push('Born alive + born deceased exceeds total born.');
  }
  if (l.whelp_date && WHELPED_OR_LATER.includes(l.status) && l.whelp_date > todayYMD()) {
    warns.push('Whelp date is in the future but the status is at or past “Whelped”.');
  }
  if (editionFlags.fosterArrangement && l.foster_direction && !l.foster_partner_contact_id) {
    warns.push('This is a foster litter but no foster partner (owner/caretaker) is selected.');
  }
  const box = document.getElementById('form-warn');
  if (box) box.innerHTML = warns.length ? `<div class="inline-warn">${warns.map(esc).join('<br>')}</div>` : '';
}

// --- Actions -------------------------------------------------------------
function renderProfileActions() {
  if (ctx.mode === 'view') {
    els.profileActions.innerHTML = `<button class="btn btn-sm" id="btn-edit">Edit</button>`;
    document.getElementById('btn-edit').onclick = enterEdit;
  } else {
    els.profileActions.innerHTML = `
      <button class="btn btn-primary btn-sm" id="btn-save">Save</button>
      <button class="btn btn-sm" id="btn-cancel">Cancel</button>`;
    document.getElementById('btn-save').onclick = save;
    document.getElementById('btn-cancel').onclick = cancel;
  }
}

async function renderHeaderActions() {
  els.headerActions.innerHTML = '';
  if (ctx.mode === 'new' || !ctx.original) return;
  const l = ctx.original;
  const blockers = await litterRepo.getDeleteBlockers(l.id);
  const delTitle = blockers.length
    ? 'Referenced as ' + blockers.map((b) => `${b.label} (${b.count})`).join(', ') + ' — archive instead.'
    : 'Permanently delete this record.';
  // Archive control. Lite hides the archive machinery (cap spec §5/§7) — no
  // manual litter-archive at all (litters have no "departure" substitute).
  const archiveBtn = editionFlags.manualDogArchive
    ? `<button class="btn btn-sm" id="btn-archive">${l.is_archived ? 'Unarchive' : 'Archive'}</button>`
    : '';
  els.headerActions.innerHTML = `
    ${archiveBtn}
    <button class="btn btn-danger btn-sm" id="btn-delete"${blockers.length ? ' disabled' : ''} title="${esc(delTitle)}">Delete</button>`;
  document.getElementById('btn-archive')?.addEventListener('click', toggleArchive);
  const del = document.getElementById('btn-delete');
  if (!blockers.length) del.onclick = doDelete;
}

function showError(msg) {
  els.error.innerHTML = `<div class="inline-error">${esc(msg)}</div>`;
  els.error.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function clearError() { els.error.innerHTML = ''; }

function enterEdit() {
  clearError();
  ctx.mode = 'edit';
  ctx.draft = { ...ctx.original };
  renderEdit();
  renderProfileActions();
  renderRosterSection();
  renderTimelineSection();
  renderExpensesSection();
  renderIncomeSection();
}

function cancel() {
  clearError();
  if (ctx.mode === 'new') { location.href = 'litters.html'; return; }
  ctx.mode = 'view';
  renderView();
  renderProfileActions();
  renderRosterSection();
  renderTimelineSection();
  renderExpensesSection();
  renderIncomeSection();
}

// Empty numeric strings become null so we don't persist '' where a number belongs.
function normalizeCounts(candidate) {
  for (const k of [
    'puppies_born_total', 'puppies_born_alive', 'puppies_born_deceased', 'puppies_born_abnormalities',
    'expected_price_male', 'expected_price_female', 'expected_deposit_male', 'expected_deposit_female'
  ]) {
    candidate[k] = candidate[k] === '' || candidate[k] == null ? null : Number(candidate[k]);
  }
  candidate.pairing_id = candidate.pairing_id || null;
  // Foster: empty → null (a non-foster litter stores null direction/partner). The
  // share % becomes a real Number or null; partner/basis/notes drop to null blank.
  candidate.foster_direction = candidate.foster_direction || null;
  candidate.foster_partner_contact_id = candidate.foster_partner_contact_id || null;
  candidate.foster_comp_model = candidate.foster_comp_model || null;
  candidate.foster_our_share_pct = candidate.foster_our_share_pct === '' || candidate.foster_our_share_pct == null
    ? null : Number(candidate.foster_our_share_pct);
  candidate.foster_split_basis = candidate.foster_split_basis || null;
  candidate.foster_flat_fee_per_pup = candidate.foster_flat_fee_per_pup === '' || candidate.foster_flat_fee_per_pup == null
    ? null : Number(candidate.foster_flat_fee_per_pup);
  candidate.foster_split_notes = (candidate.foster_split_notes || '').trim() || null;
  return candidate;
}

// Soft-suggestion prompt: the first time a litter crosses into a whelped-or-
// later status, offer to sync its linked pairing's status to match (prefilled
// "Whelped", but editable — the pairing's real state might be something else
// entirely by then). Skipped silently when there's no linked pairing, or the
// pairing is already "Whelped".
function maybePromptPairingWhelped(litter) {
  if (!litter.pairing_id) return Promise.resolve();
  const pairing = ctx.pairingsById.get(litter.pairing_id);
  if (!pairing || pairing.status === 'whelped') return Promise.resolve();

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <h2 style="margin-top:0;">Update the linked pairing's status?</h2>
      <p class="muted">This litter is now "${esc(descriptor(LITTER_STATUS, litter.status).label)}" — the linked pairing is still "${esc(descriptor(PAIRING_STATUS, pairing.status).label)}".</p>
      <div class="field">
        <label>Pairing status</label>
        <select id="pw-status">${vocabOptions(PAIRING_STATUS, 'whelped')}</select>
      </div>
      <div id="pw-error"></div>
      <div class="form-actions">
        <button class="btn btn-primary" id="pw-confirm">Confirm</button>
        <button class="btn" id="pw-skip">Skip</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); resolve(); };
    overlay.querySelector('#pw-skip').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#pw-confirm').addEventListener('click', async () => {
      const status = overlay.querySelector('#pw-status').value;
      if (!status) { close(); return; }
      try {
        await pairingRepo.update(pairing.id, { status });
        close();
      } catch (e) {
        overlay.querySelector('#pw-error').innerHTML = `<div class="inline-error">${esc(e.message || String(e))}</div>`;
      }
    });
  });
}

// Guards against a rapid double-tap/double-click firing save() twice before
// the first call's await chain has a chance to disable anything itself —
// each call would otherwise run to completion independently, e.g. creating
// two litters from one "Save" tap.
async function save() {
  const btn = document.getElementById('btn-save');
  if (btn?.disabled) return;
  if (btn) btn.disabled = true;
  try {
    await doSave();
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function doSave() {
  clearError();
  const candidate = normalizeCounts(readForm());
  try {
    if (ctx.mode === 'new') {
      const saved = await litterRepo.create(candidate);
      location.href = `litter.html?id=${encodeURIComponent(saved.id)}`;
      return;
    }
    const prevStatus = ctx.original.status;
    const saved = await litterRepo.update(ctx.original.id, candidate);
    ctx.original = saved;
    ctx.mode = 'view';
    await loadRefs();
    ctx.original = await litterRepo.getById(saved.id);
    renderAll();
    const enteringWhelpBand = WHELPED_OR_LATER.includes(saved.status) && !WHELPED_OR_LATER.includes(prevStatus);
    if (enteringWhelpBand) {
      await maybePromptPairingWhelped(saved);
    }
  } catch (e) {
    // Lite cap: creating a litter past the limit throws CapExceededError — show
    // the upgrade nudge instead of a raw error (litter update is never capped).
    if (e instanceof CapExceededError) {
      renderUpgradeNudge(els.error, e);
      els.error.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      showError(e.message || String(e));
    }
  }
}

async function toggleArchive() {
  const l = ctx.original;
  const verb = l.is_archived ? 'Unarchive' : 'Archive';
  if (!(await confirmModal({ title: `${verb} this litter?`, confirmLabel: verb }))) return;
  ctx.original = l.is_archived ? await litterRepo.unarchive(l.id) : await litterRepo.archive(l.id);
  renderAll();
}

async function doDelete() {
  const l = ctx.original;
  if (!(await confirmModal({ title: 'Delete this litter?', message: 'Permanently delete this litter? This cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
  try {
    await litterRepo.hardDelete(l.id);
    location.href = 'litters.html';
  } catch (e) {
    if (e instanceof ReferenceBlockedError) { showError(e.message); await renderHeaderActions(); }
    else showError(e.message || String(e));
  }
}

// --- Puppy Roster panel --------------------------------------------------
async function renderRosterSection() {
  if (!els.roster) return;
  if (ctx.mode !== 'view' || !ctx.original) { els.roster.innerHTML = ''; return; }

  const puppies = await dogRepo.getByLitter(ctx.original.id);
  puppies.sort((a, b) => (a.call_name || '').localeCompare(b.call_name || '', undefined, { numeric: true }));
  const activePuppies = puppies.filter((d) => !d.is_archived);

  const rowsHtml = puppies.length
    ? `<ul class="linked-list" style="margin:14px 0 0; padding:0; list-style:none;">` + puppies.map((d) => {
        // A departed (archived) pup in Lite must not advertise its archived state
        // or link back to its record (cap spec §7) — plain row, no badge, no Open.
        const hideArchive = d.is_archived && !editionFlags.archivedDogLinks;
        const archBadge = d.is_archived && !hideArchive ? ' <span class="badge badge-gray">Archived</span>' : '';
        const openBtn = hideArchive ? '' : `<a class="btn btn-sm" href="dog.html?id=${encodeURIComponent(d.id)}">Open →</a>`;
        return `
        <li class="row-between" style="padding:8px 0; border-top:1px solid var(--border);">
          <span>${badge(SEX, d.sex)} <strong>${esc(d.call_name)}</strong>${d.registered_name ? ` <span class="faint">${esc(d.registered_name)}</span>` : ''} ${badge(DOG_STATUS, d.status)}${archBadge}</span>
          ${openBtn}
        </li>`;
      }).join('') + `</ul>`
    : `<p class="muted" style="margin:14px 0 0;">No puppies recorded yet. Each puppy is an ordinary Dog record with this litter set.</p>`;

  const dam = ctx.dogsById.get(ctx.original.dam_id);
  const damHasBreed = !!(dam && dam.breed);

  els.roster.innerHTML = `
    <section class="card" style="margin-top:16px;">
      <div class="row-between">
        <h2 style="margin:0;">Puppy Roster${puppies.length ? ` <span class="faint">(${puppies.length})</span>` : ''}</h2>
        <div class="pill-row">
          <button class="btn btn-primary btn-sm" id="btn-add-puppy"${damHasBreed ? '' : ' disabled title="Set the dam\'s breed first."'}>+ Add Puppy</button>
          <button class="btn btn-sm" id="btn-add-puppies"${damHasBreed ? '' : ' disabled'}>+ Add N Puppies</button>
          <button class="btn btn-sm" id="btn-cascade-event"${activePuppies.length ? '' : ' disabled title="No puppies to log against."'}>+ Log event for whole litter</button>
        </div>
      </div>
      ${rowsHtml}
    </section>`;

  const add = document.getElementById('btn-add-puppy');
  const addN = document.getElementById('btn-add-puppies');
  if (add && damHasBreed) add.onclick = () => openAddPuppyForm({ litter: ctx.original, dam, onSaved: refreshRosterAndCounts });
  if (addN && damHasBreed) addN.onclick = () => openAddPuppiesForm({ litter: ctx.original, dam, existingCount: puppies.length, onSaved: refreshRosterAndCounts });
  const cascadeBtn = document.getElementById('btn-cascade-event');
  if (cascadeBtn && activePuppies.length) {
    cascadeBtn.onclick = () => openEventForm({
      subjectType: 'dog',
      cascadeTargets: activePuppies.map((p) => ({ id: p.id, label: `${p.call_name}${p.sex ? ` (${descriptor(SEX, p.sex).label[0]})` : ''}` })),
      onSaved: () => { renderRosterSection(); renderTimelineSection(); }
    });
  }
}

// After adding puppies the roster (and dog names cached in ctx) may have changed.
async function refreshRosterAndCounts() {
  await loadRefs();
  renderRosterSection();
}

// --- Timeline ------------------------------------------------------------
function renderTimelineSection() {
  if (!els.timeline) return;
  if (ctx.mode === 'view' && ctx.original) {
    renderTimeline({ mount: els.timeline, subjectType: 'litter', subjectId: ctx.original.id, title: 'Timeline' });
  } else {
    els.timeline.innerHTML = '';
  }
}
function renderExpensesSection() {
  if (!els.expenses) return;
  if (ctx.mode === 'view' && ctx.original) {
    renderExpensePanel({ mount: els.expenses, subjectType: 'litter', subjectId: ctx.original.id });
  } else {
    els.expenses.innerHTML = '';
  }
}

// Deliberately simple, per owner decision: this litter's puppy sales and their
// total sale value (price + transport + deferred boarding, when present). No
// earned/anticipated split and no net here — that lives on the litter P&L report
// (litter-finances-report). Sales reach the litter via the puppy's dog_id.
const saleNum = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
function saleBoardingCount(s) {
  const n = parseInt(s.deferred_boarding_duration_days, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
function saleValue(s) {
  return saleNum(s.price) + saleNum(s.transport_fee) + saleNum(s.deferred_boarding_amount) * saleBoardingCount(s);
}

async function renderIncomeSection() {
  if (!els.income) return;
  if (ctx.mode !== 'view' || !ctx.original) { els.income.innerHTML = ''; return; }

  const puppies = await dogRepo.getByLitter(ctx.original.id);
  const salesArrays = await Promise.all(puppies.map((p) => saleRepo.getByDog(p.id)));
  const sales = salesArrays.flat().filter((s) => !s.is_archived);
  sales.sort((a, b) => (b.sale_date || '').localeCompare(a.sale_date || ''));

  const puppyById = new Map(puppies.map((d) => [d.id, d]));
  const contacts = await contactRepo.getAll({ includeArchived: true });
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  const total = sales.reduce((t, s) => t + saleValue(s), 0);

  const rowsHtml = sales.length
    ? `<ul class="linked-list" style="margin:14px 0 0; padding:0; list-style:none;">` + sales.map((s) => {
        const puppy = puppyById.get(s.dog_id);
        const buyer = contactById.get(s.buyer_contact_id)?.name || '—';
        const t = saleNum(s.transport_fee);
        const b = saleNum(s.deferred_boarding_amount) * saleBoardingCount(s);
        const extras = [t ? `transport ${fmtMoney(t)}` : '', b ? `boarding ${fmtMoney(b)}` : ''].filter(Boolean).join(', ');
        return `<li class="row-between" style="padding:8px 0; border-top:1px solid var(--border); gap:12px;">
          <span><a href="sale.html?id=${encodeURIComponent(s.id)}">${esc(puppy?.call_name || 'Puppy')}</a> <span class="faint">→ ${esc(buyer)}</span> ${badge(SALE_STATUS, s.status)}</span>
          <span style="text-align:right;"><strong>${esc(fmtMoney(saleValue(s)))}</strong>${extras ? `<br><span class="faint" style="font-size:12px;">${esc('incl. ' + extras)}</span>` : ''}</span>
        </li>`;
      }).join('') + `</ul>`
    : `<p class="muted" style="margin:14px 0 0;">No sales recorded for this litter's puppies yet.</p>`;

  els.income.innerHTML = `
    <section class="card" style="margin-top:16px;">
      <div class="row-between">
        <div class="collapsible-header" style="flex:1; display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none;" data-toggle="inc-toggle">
          <span class="collapsible-arrow" style="transform: rotate(90deg); display:inline-block; transition:transform 0.2s; font-size:12px;">▶</span>
          <h2 style="margin:0;">Sales &amp; Income${sales.length ? ` <span class="faint">(${sales.length})</span>` : ''}</h2>
        </div>
        ${sales.length ? `<strong style="font-size:18px;">${esc(fmtMoney(total))}</strong>` : ''}
      </div>
      <div class="collapsible-content" id="inc-content" style="display:block; margin-top:12px;">
        <p class="muted" style="margin:0; font-size:13px;">Total sale value (price + transport + boarding). Earned-vs-anticipated and net live on the litter P&amp;L report.</p>
        ${rowsHtml}
      </div>
    </section>`;

  // Collapsible header — same behavior as the Expenses/Timeline cards.
  const header = els.income.querySelector('[data-toggle="inc-toggle"]');
  const content = els.income.querySelector('#inc-content');
  const arrow = header?.querySelector('.collapsible-arrow');
  let isExpanded = true;
  if (header) {
    header.addEventListener('click', () => {
      isExpanded = !isExpanded;
      content.style.display = isExpanded ? 'block' : 'none';
      if (arrow) arrow.style.transform = isExpanded ? 'rotate(90deg)' : 'rotate(0deg)';
    });
  }
}

// --- Top-level render ----------------------------------------------------
function renderTitle() {
  if (ctx.mode === 'new') {
    els.title.textContent = 'New Litter';
    els.subtitle.textContent = 'Choose a dam and sire, then save.';
    return;
  }
  const l = ctx.original;
  const cross = `${dogName(l.dam_id) || '—'} × ${dogName(l.sire_id) || '—'}`;
  const foster = l.foster_direction ? ' ' + badge(FOSTER_DIRECTION, l.foster_direction) : '';
  const archived = (l.is_archived ? ' <span class="badge badge-gray">Archived</span>' : '') + foster;
  const whelped = l.whelp_date ? `Whelped ${esc(fmtDate(l.whelp_date))}` : '';
  // The nickname is the friendly label; when present it leads, with dam × sire
  // and whelp date demoted to the subtitle. Otherwise dam × sire is the title.
  if (l.nickname) {
    els.title.innerHTML = esc(l.nickname) + archived;
    els.subtitle.innerHTML = esc(cross) + (whelped ? ` · ${whelped}` : '');
  } else {
    els.title.innerHTML = esc(cross) + archived;
    els.subtitle.innerHTML = whelped;
  }
}

function renderAll() {
  renderTitle();
  renderProfileActions();
  renderHeaderActions();
  if (ctx.mode === 'view') renderView();
  else renderEdit();
  renderRosterSection();
  renderTimelineSection();
  renderExpensesSection();
  renderIncomeSection();
}

async function main() {
  await loadRefs();
  const id = param('id');
  const isNew = param('new');

  if (isNew) {
    ctx.mode = 'new';
    ctx.draft = blankLitter();
    // Pre-fill from a pairing when arriving via "Create Litter from this Pairing".
    const pairingId = param('pairing');
    if (pairingId && ctx.pairingsById.has(pairingId)) {
      const p = ctx.pairingsById.get(pairingId);
      ctx.draft.pairing_id = p.id;
      ctx.draft.dam_id = p.dam_id || '';
      ctx.draft.sire_id = p.sire_id || '';
      // Sensible default status: a just-created pairing→litter is usually expected.
      ctx.draft.status = 'expected';
    }
    renderTitle();
    renderEdit();
    renderProfileActions();
    renderHeaderActions();
    return;
  }

  if (!id) { showError('No litter id provided.'); return; }
  const l = await litterRepo.getById(id);
  if (!l) { showError('Litter not found. It may have been deleted.'); return; }
  ctx.original = l;
  ctx.mode = 'view';
  renderAll();
  openEventFromQuery('litter', l.id, renderTimelineSection);
}

main();
