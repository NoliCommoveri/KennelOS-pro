// dog.js — Dog Detail (Profile section). Edit-in-place: view mode is read-only
// until "Edit" unlocks the fields; ?new=1 starts in create mode. Enforces the
// Build Brief B1 rules — hard blocks come from dogRepo (required fields, dates,
// cycles), soft/interactive ones (sex mismatch warn, the deceased confirmations)
// live here because they need the user.
import { dogRepo, ReferenceBlockedError } from '../data/dogRepo.js';
import { CapExceededError } from '../data/repoBase.js';
import { contactRepo } from '../data/contactRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { pairingRepo } from '../data/pairingRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { eventRepo, testTokensOf } from '../data/eventRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import { studServiceRepo } from '../data/studServiceRepo.js';
import { contractRepo } from '../data/contractRepo.js';
import { getMyContactId } from '../data/kennelSetup.js';
import { editionFlags, dogCapStatus } from '../data/editionConfig.js';
import {
  SEX, DOG_STATUS, DISPOSITION, OWNERSHIP_TYPE, PAIRING_TYPE, PAIRING_STATUS,
  PLACEMENT_TYPE, SALE_STATUS, STUD_SERVICE_DIRECTION, STUD_SERVICE_STATUS,
  LITTER_STATUS, EVENT_TYPES, descriptor, COI_METHOD_SUGGESTIONS, CONTRACT_TYPE, CONTRACT_STATUS
} from '../data/vocab.js';
import { esc, badge, fmtDate, todayYMD, param, confirmModal, dogRefHtml } from '../assets/ui.js';
import { renderUpgradeNudge } from '../assets/upgradeNudge.js';
import { renderTimeline } from '../assets/timeline.js';
import { renderExpensePanel } from '../assets/expensePanel.js';
import { openEventFromQuery } from '../assets/eventForm.js';
import { renderPedigree } from '../assets/pedigree.js';

const OWNER_REQUIRED = ['external', 'leased_in'];

const els = {
  title: document.getElementById('dog-title'),
  subtitle: document.getElementById('dog-subtitle'),
  capBanner: document.getElementById('dog-cap-banner'),
  headerActions: document.getElementById('header-actions'),
  profileActions: document.getElementById('profile-actions'),
  body: document.getElementById('profile-body'),
  error: document.getElementById('page-error'),
  recordedCoi: document.getElementById('recorded-coi-section'),
  plannedTests: document.getElementById('planned-tests-section'),
  healthTests: document.getElementById('health-tests-section'),
  timeline: document.getElementById('timeline-section'),
  expenses: document.getElementById('expenses-section'),
  pairings: document.getElementById('pairings-section'),
  sales: document.getElementById('sales-section'),
  studServices: document.getElementById('stud-services-section'),
  contracts: document.getElementById('contracts-section'),
  litters: document.getElementById('litters-section'),
  pedigree: document.getElementById('pedigree-section')
};

const blankDog = () => ({
  call_name: '', registered_name: '', sex: '', date_of_birth: '', dob_is_estimated: false,
  date_of_death: '', breed: '', color_markings: '', registry: '', registration_number: '',
  microchip_id: '', url: '', sire_id: '', dam_id: '', ownership_type: '', owner_contact_id: '',
  co_owner_contact_ids: [], litter_id: '', breeder_kennel_id: '', kennel_id: '', status: '', status_date: '', disposition: '', notes: '',
  planned_tests: []
});

const SEED_TESTS_FOR = ['owned', 'co_owned'];

// Which kennel's preferred_tests panel seeds a new dog's plan (Test Planning
// Addendum §4) — resolved the same way kennel_id itself gets prefilled
// (soleOwnKennelId): dog's kennel_id set wins outright; unset resolves to the
// sole own-kennel if there's exactly one; 0 or 2+ own-kennels seed nothing
// (don't guess). Owned/co-owned only — never external/leased-in.
function resolveSeedKennel(candidate) {
  if (!SEED_TESTS_FOR.includes(candidate.ownership_type)) return null;
  if (candidate.kennel_id) return ctx.kennelsById.get(candidate.kennel_id) || null;
  const owned = ctx.allKennels.filter((k) => k.is_own_kennel && !k.is_archived);
  return owned.length === 1 ? owned[0] : null;
}

const ctx = {
  mode: 'view',        // 'new' | 'view' | 'edit'
  original: null,      // saved record (null in new mode)
  draft: null,         // working copy while editing
  coiEditing: false,   // Recorded COI panel has its own inline edit toggle
  plannedTestsAddOpen: false, // Planned Tests add/copy controls toggle (survives re-render after an add)
  pickerArchived: false,
  allDogs: [],
  allContacts: [],
  allLitters: [],
  allKennels: [],
  breeds: [],
  dogsById: new Map(),
  contactsById: new Map(),
  littersById: new Map(),
  kennelsById: new Map(),
  // Collapsible card state — tracks which cards are expanded
  expandedCards: new Set()
};

// Helper to create a collapsible card. The card auto-collapses when empty.
// If hasContent is false, the card starts collapsed with an empty badge.
// The toggle button for the card should be passed in headerButton.
function renderCollapsibleCard(title, bodyHtml, headerButton = '', { sectionKey = '', hasContent = true } = {}) {
  const isExpanded = ctx.expandedCards.has(sectionKey) || hasContent;
  const toggleId = `${sectionKey}-toggle`;

  return `
    <section class="card" style="margin-top:16px;">
      <div class="row-between">
        <div class="collapsible-header" style="flex: 1; display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none;" data-toggle="${toggleId}">
          <span class="collapsible-arrow" style="transform: rotate(${isExpanded ? '90deg' : '0deg'}); display: inline-block; transition: transform 0.2s; font-size: 12px;">▶</span>
          <h2 style="margin:0;">${esc(title)}${!hasContent ? ' <span class="badge badge-gray">empty</span>' : ''}</h2>
        </div>
        <div id="${toggleId}-actions" class="pill-row">${headerButton}</div>
      </div>
      <div class="collapsible-content" id="${toggleId}-content" style="display: ${isExpanded ? 'block' : 'none'}; margin-top:12px;">
        ${bodyHtml}
      </div>
    </section>`;
}

// Setup collapsible functionality for a card
function setupCollapsibleCard(sectionKey) {
  const toggleId = `${sectionKey}-toggle`;
  const header = document.querySelector(`[data-toggle="${toggleId}"]`);
  const content = document.getElementById(`${toggleId}-content`);
  const arrow = header?.querySelector('.collapsible-arrow');

  if (!header || !content) return;

  header.addEventListener('click', () => {
    const isExpanded = ctx.expandedCards.has(sectionKey);
    if (isExpanded) {
      ctx.expandedCards.delete(sectionKey);
      content.style.display = 'none';
      if (arrow) arrow.style.transform = 'rotate(0deg)';
    } else {
      ctx.expandedCards.add(sectionKey);
      content.style.display = 'block';
      if (arrow) arrow.style.transform = 'rotate(90deg)';
    }
  });
}

// --- Data loading --------------------------------------------------------
async function loadRefs() {
  const [dogs, contacts, litters, kennels, breeds, breedPool] = await Promise.all([
    dogRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true }),
    litterRepo.getAll({ includeArchived: true }),
    kennelRepo.getAll({ includeArchived: true }),
    dogRepo.getBreeds(),
    kennelRepo.getBreedVocabulary()
  ]);
  ctx.allDogs = dogs;
  ctx.allContacts = contacts;
  ctx.allLitters = litters;
  ctx.allKennels = kennels;
  // Breed autocomplete = breeds already on dogs UNION the kennel breed pool
  // (Test Planning Addendum §8) — the pool is what lets a seeded breed suggest
  // before the first dog exists. Case-insensitive dedupe, dog-derived wins.
  const breedSeen = new Set(breeds.map((b) => b.toLowerCase()));
  ctx.breeds = [...breeds, ...breedPool.filter((b) => !breedSeen.has(b.toLowerCase()))].sort();
  ctx.dogsById = new Map(dogs.map((d) => [d.id, d]));
  ctx.contactsById = new Map(contacts.map((c) => [c.id, c]));
  ctx.littersById = new Map(litters.map((l) => [l.id, l]));
  ctx.kennelsById = new Map(kennels.map((k) => [k.id, k]));
}

// The one kennel to silently prefill kennel_id with, when exactly one of the
// user's own kennels exists (Own-Kennel Identity addendum §4). With zero or
// 2+ own kennels, the field is left for the user to pick/leave blank.
function soleOwnKennelId() {
  const owned = ctx.allKennels.filter((k) => k.is_own_kennel && !k.is_archived);
  return owned.length === 1 ? owned[0].id : null;
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
function contactName(id) {
  const c = ctx.contactsById.get(id);
  return c ? c.name : '';
}
function kennelName(id) {
  const k = ctx.kennelsById.get(id);
  return k ? k.kennel_name : '';
}
// A litter's human label: "Dam × Sire (whelp date)".
function litterLabel(id) {
  const l = ctx.littersById.get(id);
  if (!l) return '';
  const dam = ctx.dogsById.get(l.dam_id)?.call_name || '—';
  const sire = ctx.dogsById.get(l.sire_id)?.call_name || '—';
  return `${dam} × ${sire}${l.whelp_date ? ` (${fmtDate(l.whelp_date)})` : ''}`;
}
function litterOptions(current) {
  const opts = ctx.allLitters
    .filter((l) => ctx.pickerArchived || !l.is_archived || l.id === current)
    .map((l) => `<option value="${esc(l.id)}"${l.id === current ? ' selected' : ''}>${esc(litterLabel(l.id))}${l.is_archived ? ' (archived)' : ''}</option>`)
    .join('');
  return `<option value="">— none —</option>` + opts;
}

// --- Option builders -----------------------------------------------------
function vocabOptions(vocab, current, placeholder) {
  const head = placeholder != null ? `<option value="">${esc(placeholder)}</option>` : '';
  return head + vocab.map((v) =>
    `<option value="${esc(v.value)}"${v.value === current ? ' selected' : ''}>${esc(v.label)}</option>`
  ).join('');
}

// `sex`, when given, limits the list to that sex (plus "unknown" — a real gap
// in the data, not grounds to make the dog unselectable). The current
// selection always stays in the list even if it doesn't match, so an existing
// mismatched record stays visible/editable (updateWarnings flags it instead).
function dogOptions(current, excludeId, sex) {
  const opts = ctx.allDogs
    .filter((d) => d.id !== excludeId && (ctx.pickerArchived || !d.is_archived))
    .filter((d) => !sex || d.id === current || d.sex === sex || d.sex === 'unknown')
    .map((d) => `<option value="${esc(d.id)}"${d.id === current ? ' selected' : ''}>${esc(d.call_name)}${d.registered_name ? ' — ' + esc(d.registered_name) : ''}${d.is_archived ? ' (archived)' : ''}</option>`)
    .join('');
  return `<option value="">— none —</option>` + opts;
}

function contactOptions(current) {
  const opts = ctx.allContacts
    .filter((c) => ctx.pickerArchived || !c.is_archived)
    .map((c) => `<option value="${esc(c.id)}"${c.id === current ? ' selected' : ''}>${esc(c.name)}${c.is_archived ? ' (archived)' : ''}</option>`)
    .join('');
  return `<option value="">— none —</option>` + opts;
}

// Every kennel is offered here — your own for a dog you own, or an outside
// kennel for a dog you don't (external / leased). We track other people's
// kennels now, so linking an external dog to its kennel is a first-class thing.
function kennelOptions(current) {
  const opts = ctx.allKennels
    .filter((k) => ctx.pickerArchived || !k.is_archived || k.id === current)
    .map((k) => `<option value="${esc(k.id)}"${k.id === current ? ' selected' : ''}>${esc(k.kennel_name)}${k.is_own_kennel ? ' — My kennel' : ''}${k.is_archived ? ' (archived)' : ''}</option>`)
    .join('');
  return `<option value="">— none —</option>` + opts;
}

// Unlike kennelOptions() above, the breeder-kennel picker isn't limited to your
// own kennels — the whole point is naming an outside contact's kennel for a dog
// you acquired rather than bred yourself.
function breederKennelOptions(current) {
  const opts = ctx.allKennels
    .filter((k) => ctx.pickerArchived || !k.is_archived || k.id === current)
    .map((k) => `<option value="${esc(k.id)}"${k.id === current ? ' selected' : ''}>${esc(k.kennel_name)}${k.is_own_kennel ? ' — My kennel' : ''}${k.is_archived ? ' (archived)' : ''}</option>`)
    .join('');
  return `<option value="">— none —</option>` + opts;
}

// --- Rendering: read-only view ------------------------------------------
function row(label, valueHtml) {
  return valueHtml ? `<dt>${esc(label)}</dt><dd>${valueHtml}</dd>` : '';
}

function renderView() {
  const d = ctx.original;
  const coOwners = (d.co_owner_contact_ids || []).map((id) => esc(contactName(id))).filter(Boolean).join(', ');
  els.body.innerHTML = `
    <dl class="dl-meta" style="margin-top:14px;">
      ${row('Call name', esc(d.call_name))}
      ${row('Registered name', esc(d.registered_name))}
      ${row('Sex', badge(SEX, d.sex))}
      ${row('Breed', esc(d.breed))}
      ${row('Date of birth', d.date_of_birth ? esc(fmtDate(d.date_of_birth)) + (d.dob_is_estimated ? ' <span class="faint">(est.)</span>' : '') : '')}
      ${row('Date of death', d.date_of_death ? esc(fmtDate(d.date_of_death)) : '')}
      ${row('Color / markings', esc(d.color_markings))}
      ${row('Registry', esc(d.registry))}
      ${row('Registration #', esc(d.registration_number))}
      ${row('Microchip', esc(d.microchip_id))}
      ${row('URL', d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${esc(d.url)}</a>` : '')}
      ${row('Sire', dogLink(d.sire_id))}
      ${row('Dam', dogLink(d.dam_id))}
      ${row('Litter', d.litter_id ? `<a href="litter.html?id=${encodeURIComponent(d.litter_id)}">${esc(litterLabel(d.litter_id) || 'View litter')}</a>` : '')}
      ${row('Breeder kennel', esc(kennelName(d.breeder_kennel_id)))}
      ${row('Ownership', badge(OWNERSHIP_TYPE, d.ownership_type))}
      ${row('Owner', esc(contactName(d.owner_contact_id)))}
      ${row('Co-owners', coOwners)}
      ${row('Kennel', esc(kennelName(d.kennel_id)))}
      ${row('Status', badge(DOG_STATUS, d.status) + (d.status_date ? ` <span class="faint">since ${esc(fmtDate(d.status_date))}</span>` : ''))}
      ${d.status === 'puppy' ? row('Disposition', d.disposition ? badge(DISPOSITION, d.disposition) : '') : ''}
      ${row('Notes', d.notes ? esc(d.notes).replace(/\n/g, '<br>') : '')}
    </dl>`;
}

// --- Rendering: edit form ------------------------------------------------
function field(label, inner, { required = false, hint = '', wide = false } = {}) {
  return `<div class="field${wide ? ' field-wide' : ''}">
    <label>${esc(label)}${required ? ' <span class="req">*</span>' : ''}</label>
    ${inner}
    ${hint ? `<span class="field-hint">${esc(hint)}</span>` : ''}
  </div>`;
}

function renderEdit() {
  const d = ctx.draft;
  const breedList = ctx.breeds.map((b) => `<option value="${esc(b)}"></option>`).join('');
  const coSelected = new Set(d.co_owner_contact_ids || []);
  const coOptions = ctx.allContacts
    .filter((c) => ctx.pickerArchived || !c.is_archived || coSelected.has(c.id))
    .map((c) => `<option value="${esc(c.id)}"${coSelected.has(c.id) ? ' selected' : ''}>${esc(c.name)}${c.is_archived ? ' (archived)' : ''}</option>`)
    .join('');

  els.body.innerHTML = `
    <div class="form-grid" id="dog-form" style="margin-top:14px;">
      ${field('Call name', `<input id="f-call_name" type="text" value="${esc(d.call_name)}">`, { required: true })}
      ${field('Registered name', `<input id="f-registered_name" type="text" value="${esc(d.registered_name)}">`)}
      ${field('Sex', `<select id="f-sex">${vocabOptions(SEX, d.sex, 'Select…')}</select>`, { required: true })}
      ${field('Breed', `<input id="f-breed" type="text" list="breed-list" value="${esc(d.breed)}"><datalist id="breed-list">${breedList}</datalist>`, { required: true, hint: 'Type freely; suggestions come from breeds already entered or seeded from a kennel test import.' })}
      ${field('Date of birth', `<input id="f-date_of_birth" type="date" max="${todayYMD()}" value="${esc(d.date_of_birth)}">`)}
      ${field('DOB estimated', `<label class="check-inline"><input id="f-dob_is_estimated" type="checkbox"${d.dob_is_estimated ? ' checked' : ''}> approximate</label>`)}
      ${field('Date of death', `<input id="f-date_of_death" type="date" value="${esc(d.date_of_death)}">`)}
      ${field('Color / markings', `<input id="f-color_markings" type="text" value="${esc(d.color_markings)}">`)}
      ${field('Registry', `<input id="f-registry" type="text" value="${esc(d.registry)}">`)}
      ${field('Registration #', `<input id="f-registration_number" type="text" value="${esc(d.registration_number)}">`)}
      ${field('Microchip', `<input id="f-microchip_id" type="text" value="${esc(d.microchip_id)}">`)}
      ${field('URL', `<input id="f-url" type="url" value="${esc(d.url || '')}" placeholder="https://…">`)}
      ${field('Ownership', `<select id="f-ownership_type">${vocabOptions(editionFlags.externalOwnership ? OWNERSHIP_TYPE : OWNERSHIP_TYPE.filter((o) => ['owned', 'co_owned'].includes(o.value)), d.ownership_type, 'Select…')}</select>`, { required: true })}
      ${field('Status', `<select id="f-status">${vocabOptions(editionFlags.fullDogStatuses ? DOG_STATUS : DOG_STATUS.filter((o) => ['puppy', 'active_breeding', 'retired_breeding', 'deceased'].includes(o.value)), d.status, 'Select…')}</select>`, { required: true })}
      ${d.status === 'puppy' ? field('Disposition', `<select id="f-disposition">${vocabOptions(DISPOSITION, d.disposition || 'undecided')}</select>`, { hint: 'Keeping this puppy or offering it? Drives the prospective-families view. Puppy-only — clears when Status moves past Puppy.' }) : ''}
      ${field('Sire', `<select id="f-sire_id">${dogOptions(d.sire_id, ctx.original?.id, 'male')}</select>`)}
      ${field('Dam', `<select id="f-dam_id">${dogOptions(d.dam_id, ctx.original?.id, 'female')}</select>`)}
      ${field('Litter', `<select id="f-litter_id">${litterOptions(d.litter_id)}</select>`, { hint: 'The litter this dog was born into, if born in-house.' })}
      ${field('Breeder kennel', `<select id="f-breeder_kennel_id">${breederKennelOptions(d.breeder_kennel_id)}</select>`, { hint: 'The kennel that produced this dog — your own for an in-house litter, or an outside kennel for a dog you acquired.' })}
      ${field('Owner', `<select id="f-owner_contact_id">${contactOptions(d.owner_contact_id)}</select>`, { hint: 'Required for external / leased-in dogs.' })}
      ${field('Co-owners', `<select id="f-co_owner_contact_ids" multiple size="4">${coOptions}</select>`, { hint: 'Ctrl/Cmd-click to select multiple.' })}
      ${field('Kennel', `<select id="f-kennel_id">${kennelOptions(d.kennel_id)}</select>`, { hint: 'The kennel this dog belongs to — your own, or an outside kennel for a dog you don’t own.' })}
      ${editionFlags.includeArchivedToggles ? `<div class="field field-wide">
        <label class="check-inline"><input id="picker-archived" type="checkbox"${ctx.pickerArchived ? ' checked' : ''}> Include archived dogs/contacts/kennels in the pickers above</label>
      </div>` : ''}
      ${field('Notes', `<textarea id="f-notes">${esc(d.notes)}</textarea>`, { wide: true })}
    </div>
    <div id="form-warn"></div>`;

  const form = document.getElementById('dog-form');
  form.addEventListener('input', updateWarnings);
  form.addEventListener('change', updateWarnings);
  document.getElementById('picker-archived')?.addEventListener('change', (e) => {
    ctx.draft = readForm();
    ctx.pickerArchived = e.target.checked;
    renderEdit();
    renderProfileActions();
  });
  // Convenience: switching Ownership to "Owned" prefills Owner with your own
  // kennel-setup contact, if one is set and Owner is still empty. Switching to
  // "Owned"/"Co-owned" also prefills Kennel with the sole own-kennel, if there's
  // exactly one. Both are prefills only — never override a value already chosen.
  document.getElementById('f-ownership_type').addEventListener('change', (e) => {
    ctx.draft = readForm();
    if (e.target.value === 'owned' && !ctx.draft.owner_contact_id) {
      const myContactId = getMyContactId();
      if (myContactId && ctx.contactsById.has(myContactId)) ctx.draft.owner_contact_id = myContactId;
    }
    if ((e.target.value === 'owned' || e.target.value === 'co_owned') && !ctx.draft.kennel_id) {
      const soleId = soleOwnKennelId();
      if (soleId) ctx.draft.kennel_id = soleId;
    }
    renderEdit();
  });
  // Convenience: linking a Litter prefills Date of birth from the litter's
  // whelp date, if DOB is still empty — a prefill only, never an override. A
  // DOB that already conflicts with the litter's whelp date surfaces as an
  // actionable warning instead (updateWarnings). It also prefills Breeder
  // kennel from the litter's dam — but only when the dam is your own dog
  // (owned/co-owned); a litter whose dam belongs to someone else (e.g. a
  // stud service out) says nothing about which of your kennels bred it.
  // Status drives whether Disposition (puppy-only) is shown at all. Re-render on
  // change so the field appears when Status becomes Puppy and disappears — with
  // its value nulled by readForm — when it moves to any other life-stage.
  document.getElementById('f-status').addEventListener('change', () => {
    ctx.draft = readForm();
    renderEdit();
  });
  document.getElementById('f-litter_id').addEventListener('change', (e) => {
    ctx.draft = readForm();
    const litter = e.target.value ? ctx.littersById.get(e.target.value) : null;
    if (litter && litter.whelp_date && !ctx.draft.date_of_birth) {
      ctx.draft.date_of_birth = litter.whelp_date;
    }
    if (litter && !ctx.draft.breeder_kennel_id) {
      const dam = litter.dam_id ? ctx.dogsById.get(litter.dam_id) : null;
      if (dam && ['owned', 'co_owned'].includes(dam.ownership_type) && dam.kennel_id) {
        ctx.draft.breeder_kennel_id = dam.kennel_id;
      }
    }
    renderEdit();
  });
  updateWarnings();
}

function readForm() {
  const val = (id) => document.getElementById(id)?.value ?? '';
  const coSel = document.getElementById('f-co_owner_contact_ids');
  return {
    ...ctx.draft,
    call_name: val('f-call_name').trim(),
    registered_name: val('f-registered_name').trim(),
    sex: val('f-sex'),
    breed: val('f-breed').trim(),
    date_of_birth: val('f-date_of_birth'),
    dob_is_estimated: document.getElementById('f-dob_is_estimated')?.checked || false,
    date_of_death: val('f-date_of_death'),
    color_markings: val('f-color_markings').trim(),
    registry: val('f-registry').trim(),
    registration_number: val('f-registration_number').trim(),
    microchip_id: val('f-microchip_id').trim(),
    url: val('f-url').trim(),
    ownership_type: val('f-ownership_type'),
    status: val('f-status'),
    // Disposition is a puppy-only field (vocab.js): only a `puppy`-status dog
    // carries one. Force it null for any other status so it can't linger from a
    // prior life-stage, and default it to 'undecided' when the field is present
    // (e.g. Status was just switched to Puppy and the select hasn't rendered).
    disposition: val('f-status') === 'puppy' ? (val('f-disposition') || 'undecided') : null,
    sire_id: val('f-sire_id') || null,
    dam_id: val('f-dam_id') || null,
    litter_id: val('f-litter_id') || null,
    breeder_kennel_id: val('f-breeder_kennel_id') || null,
    owner_contact_id: val('f-owner_contact_id') || null,
    co_owner_contact_ids: coSel ? [...coSel.selectedOptions].map((o) => o.value) : [],
    // Hidden (external/leased-in) means "doesn't apply" — clear rather than
    // carry over a stale value from before ownership_type changed.
    kennel_id: document.getElementById('f-kennel_id') ? (val('f-kennel_id') || null) : null,
    notes: val('f-notes')
  };
}

function updateWarnings() {
  const d = readForm();
  const warns = [];
  const sire = ctx.dogsById.get(d.sire_id);
  const dam = ctx.dogsById.get(d.dam_id);
  if (sire && sire.sex === 'female') warns.push('Selected sire is recorded as female.');
  if (dam && dam.sex === 'male') warns.push('Selected dam is recorded as male.');
  if (OWNER_REQUIRED.includes(d.ownership_type) && !d.owner_contact_id) {
    warns.push(`An owner is required when ownership is “${OWNERSHIP_TYPE.find((o) => o.value === d.ownership_type)?.label}”.`);
  }
  if (d.date_of_death && d.status !== 'deceased') warns.push('Date of death is set but status is not Deceased.');

  const box = document.getElementById('form-warn');
  if (!box) return;

  // Linked litter's whelp date vs. this dog's DOB: warn-only, never blocks
  // save (an imported/historical record may legitimately disagree) — but
  // offer the three fixes a mismatch could mean instead of just a message.
  const litter = d.litter_id ? ctx.littersById.get(d.litter_id) : null;
  const dobConflict = !!(litter && litter.whelp_date && d.date_of_birth && d.date_of_birth !== litter.whelp_date);

  box.innerHTML =
    (warns.length ? `<div class="inline-warn">${warns.map(esc).join('<br>')}</div>` : '') +
    (dobConflict ? `
      <div class="inline-warn">
        Date of birth (${esc(fmtDate(d.date_of_birth))}) doesn't match this litter's whelp date (${esc(fmtDate(litter.whelp_date))}).
        <div class="pill-row" style="margin-top:6px;">
          <button type="button" class="btn btn-sm" id="warn-dob-use-litter">Update dog's DOB to match</button>
          <button type="button" class="btn btn-sm" id="warn-dob-use-dog">Update litter's whelp date to match</button>
          <button type="button" class="btn btn-sm" id="warn-dob-change-litter">Change litter</button>
        </div>
      </div>` : '');

  if (dobConflict) {
    document.getElementById('warn-dob-use-litter').onclick = () => {
      ctx.draft = readForm();
      ctx.draft.date_of_birth = litter.whelp_date;
      renderEdit();
    };
    document.getElementById('warn-dob-use-dog').onclick = async () => {
      const updated = await litterRepo.update(litter.id, { whelp_date: d.date_of_birth });
      ctx.littersById.set(updated.id, updated);
      updateWarnings();
    };
    document.getElementById('warn-dob-change-litter').onclick = () => {
      ctx.draft = readForm();
      ctx.draft.litter_id = null;
      renderEdit();
    };
  }
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
  const d = ctx.original;
  const blockers = await dogRepo.getDeleteBlockers(d.id);
  const altAction = editionFlags.manualDogArchive ? 'archive instead.' : 'remove it from your program instead.';
  const delTitle = blockers.length
    ? 'Referenced as ' + blockers.map((b) => `${b.label} (${b.count})`).join(', ') + ' — ' + altAction
    : 'Permanently delete this record.';
  const documentsBtn = editionFlags.documents
    ? `<a class="btn btn-sm" href="documents.html?dog=${encodeURIComponent(d.id)}" title="View this dog's filed documents">📄 Documents</a>`
    : '';
  // Archive control. Pro offers a free Archive/Unarchive toggle. Lite hides the
  // archive machinery (cap spec §5/§7): the only exit is a confirmed "remove from
  // program" departure, and a departed dog can't be brought back in Lite (so no
  // control at all once archived).
  let archiveBtn = '';
  if (editionFlags.manualDogArchive) {
    archiveBtn = `<button class="btn btn-sm" id="btn-archive">${d.is_archived ? 'Unarchive' : 'Archive'}</button>`;
  } else if (!d.is_archived) {
    archiveBtn = `<button class="btn btn-sm" id="btn-depart" title="Remove this dog from your program">Remove from program</button>`;
  }
  els.headerActions.innerHTML = `
    ${documentsBtn}
    ${archiveBtn}
    <button class="btn btn-danger btn-sm" id="btn-delete"${blockers.length ? ' disabled' : ''} title="${esc(delTitle)}">Delete</button>`;
  document.getElementById('btn-archive')?.addEventListener('click', toggleArchive);
  document.getElementById('btn-depart')?.addEventListener('click', departDog);
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
  ctx.coiEditing = false;
  ctx.draft = { ...ctx.original, co_owner_contact_ids: [...(ctx.original.co_owner_contact_ids || [])] };
  renderEdit();
  renderProfileActions();
  renderRecordedCoiSection(); // hide while editing the profile
  renderPlannedTestsSection(); // hide while editing the profile too
  renderHealthTestsSection(); // hide while editing the profile
  renderTimelineSection(); // hide timeline while editing the profile
  renderExpensesSection(); // hide expenses while editing too
  renderPairingsSection(); // hide pairings while editing too
  renderSalesSection();
  renderStudServicesSection();
  renderContractsSection();
  renderLittersSection(); // hide litters while editing too
  renderPedigreeSection(); // hide pedigree while editing too
}

function cancel() {
  clearError();
  if (ctx.mode === 'new') { location.href = 'dogs.html'; return; }
  ctx.mode = 'view';
  renderView();
  renderProfileActions();
  renderRecordedCoiSection();
  const eventsP = viewDogEventsPromise();
  renderPlannedTestsSection(eventsP);
  renderHealthTestsSection(eventsP);
  renderTimelineSection();
  renderExpensesSection();
  renderPairingsSection();
  renderSalesSection();
  renderStudServicesSection();
  renderContractsSection();
  renderLittersSection();
  renderPedigreeSection();
}

// Guards against a rapid double-tap/double-click firing save() twice before
// the first call's await chain (confirmModal prompts, the repo write) has a
// chance to disable anything itself — each call would otherwise run to
// completion independently, e.g. creating two dogs from one "Save" tap.
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
  const candidate = readForm();

  // status_date: stamp when status changes (or on first save).
  const statusChanged = !ctx.original || ctx.original.status !== candidate.status;
  if (statusChanged) candidate.status_date = todayYMD();
  else candidate.status_date = ctx.original.status_date || '';

  // Interactive rule: setting date_of_death SUGGESTS Deceased (not forced).
  if (candidate.date_of_death && candidate.status !== 'deceased') {
    if (await confirmModal({ title: 'Date of death is set. Also change status to “Deceased”?', confirmLabel: 'Set Deceased', cancelLabel: 'Keep status' })) {
      candidate.status = 'deceased';
      candidate.status_date = todayYMD();
    }
  }
  // Interactive rule: leaving Deceased needs confirmation.
  if (ctx.original && ctx.original.status === 'deceased' && candidate.status !== 'deceased') {
    if (!(await confirmModal({ title: 'Change status from Deceased?', message: 'This dog is marked Deceased. Are you sure you want to change that?', confirmLabel: 'Change status', cancelLabel: 'Cancel' }))) return;
  }

  try {
    let saved;
    if (ctx.mode === 'new') {
      // Seeding-on-create is a one-time copy of the panel as it stood at this
      // moment (Test Planning Addendum §4) — forward-only, never re-checked
      // against the panel again after this. Scoped to this dog's own breed
      // (§8): a breed-tagged test only carries over for a matching breed; an
      // untagged/breed-agnostic test still carries over to every new dog.
      const seedKennel = resolveSeedKennel(candidate);
      if (seedKennel) candidate.planned_tests = kennelRepo.testsForBreed(seedKennel, candidate.breed);
      saved = await dogRepo.create(candidate);
      location.href = `dog.html?id=${encodeURIComponent(saved.id)}`;
      return;
    }
    saved = await dogRepo.update(ctx.original.id, candidate);
    ctx.original = saved;
    ctx.mode = 'view';
    await loadRefs(); // names/breeds may have changed
    ctx.original = await dogRepo.getById(saved.id);
    renderAll();
  } catch (e) {
    // The Lite cap throws CapExceededError (a repo can't prompt); show the
    // upgrade nudge, not a raw error. mode is still 'new' on a blocked create
    // and 'edit' on a blocked ✗→✓ transition (a kept pup maturing).
    if (e instanceof CapExceededError) {
      renderUpgradeNudge(els.error, e, ctx.mode === 'new' ? 'create' : 'mature');
      els.error.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      showError(e.message || String(e));
    }
  }
}

async function toggleArchive() {
  const d = ctx.original;
  const verb = d.is_archived ? 'Unarchive' : 'Archive';
  if (!(await confirmModal({ title: `${verb} “${d.call_name}”?`, confirmLabel: verb }))) return;
  ctx.original = d.is_archived ? await dogRepo.unarchive(d.id) : await dogRepo.archive(d.id);
  renderAll();
}

// Lite's departure exit (cap spec §5): the ONLY way a dog leaves the active
// roster in Lite, gated by a blocking "this is permanent" confirm the user must
// accept. It archives the record (freeing a cap slot honestly — the dog is gone,
// not hidden-but-owned) and returns to the roster, since a departed dog's page
// isn't meant to be a place you linger in Lite. No auto-undo: the confirm IS the
// safety, and history/pedigree stay intact because archive is a soft delete.
async function departDog() {
  const d = ctx.original;
  const ok = await confirmModal({
    title: `Remove “${d.call_name}” from your program?`,
    message: `This can't be undone here — ${d.call_name} leaves your roster and you won't be able to edit it or bring it back. It stays in your dogs' pedigrees for lineage.`,
    confirmLabel: 'Remove permanently',
    cancelLabel: 'Cancel',
    danger: true,
  });
  if (!ok) return;
  await dogRepo.archive(d.id);
  location.href = 'dogs.html';
}

async function doDelete() {
  const d = ctx.original;
  if (!(await confirmModal({ title: `Delete “${d.call_name}”?`, message: 'This cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
  try {
    await dogRepo.hardDelete(d.id);
    location.href = 'dogs.html';
  } catch (e) {
    if (e instanceof ReferenceBlockedError) { showError(e.message); await renderHeaderActions(); }
    else showError(e.message || String(e));
  }
}

// --- Top-level render ----------------------------------------------------
function renderTitle() {
  if (ctx.mode === 'new') {
    els.title.textContent = 'New Dog';
    els.subtitle.textContent = 'Fill in the required fields and save.';
    return;
  }
  const d = ctx.original;
  els.title.innerHTML = esc(d.call_name) + (d.is_archived ? ' <span class="badge badge-gray">Archived</span>' : '');
  els.subtitle.innerHTML = d.registered_name ? esc(d.registered_name) : '';
}

// New-dog-only cap counter (cap spec §6): a plain read of the same counting
// predicate the repo enforces, so the number shown here always matches what
// would actually block a save. Pro/Demo's dogCapStatus() resolves null (no
// cap), so this renders nothing there.
async function renderCapBanner() {
  if (!els.capBanner) return;
  const status = await dogCapStatus();
  els.capBanner.textContent = status ? `Creating ${status.current}/${status.cap} available dogs` : '';
}

// Event History only makes sense for a saved dog; hide it while creating/editing
// the profile so events can't be logged against an unsaved record.
function renderTimelineSection() {
  if (!els.timeline) return;
  if (ctx.mode === 'view' && ctx.original) {
    renderTimeline({ mount: els.timeline, subjectType: 'dog', subjectId: ctx.original.id });
  } else {
    els.timeline.innerHTML = '';
  }
}

// Expenses (Financials ledger) for this dog — costs attached directly, plus any
// captured from its events (both carry subject_type='dog'). Hidden while editing
// the profile, same discipline as the timeline.
function renderExpensesSection() {
  if (!els.expenses) return;
  if (ctx.mode === 'view' && ctx.original) {
    renderExpensePanel({ mount: els.expenses, subjectType: 'dog', subjectId: ctx.original.id });
  } else {
    els.expenses.innerHTML = '';
  }
}

// Recorded COI panel (Stage 5, Build Brief §2.2). recorded_coi is an OPTIONAL,
// user-attested value — { value, method, source, as_of_date } — NOT computed by
// the app and NEVER presented as if it were (§2.4: the app records the result of
// the breeder's lab/registry analysis; it offers no relatedness math of its own).
// The panel always labels the value as user-recorded, always shows its provenance
// beside it (a bare percentage is never shown alone), and shows a quiet empty
// state with an add affordance when nothing is recorded. It has its own inline
// edit toggle, independent of the Profile edit mode.
async function renderRecordedCoiSection() {
  if (!els.recordedCoi) return;
  if (ctx.mode !== 'view' || !ctx.original) { els.recordedCoi.innerHTML = ''; ctx.coiEditing = false; return; }
  const d = ctx.original;
  const coi = d.recorded_coi || null;

  if (ctx.coiEditing) {
    const c = coi || {};
    const methodOpts = COI_METHOD_SUGGESTIONS.map((m) => `<option value="${esc(m)}"></option>`).join('');
    els.recordedCoi.innerHTML = `
      <section class="card" style="margin-top:16px;">
        <h2 style="margin:0;">Recorded COI</h2>
        <p class="field-hint">A coefficient of inbreeding you recorded from a lab or registry — the app stores it, it does not compute or verify it.</p>
        <div class="form-grid" style="margin-top:12px;">
          ${field('COI value (%)', `<input id="coi-value" type="number" step="0.01" min="0" value="${esc(c.value ?? '')}" placeholder="e.g. 6.25">`, { hint: 'Leave blank and save to remove the recorded COI.' })}
          ${field('Method', `<input id="coi-method" type="text" list="coi-method-dl" value="${esc(c.method ?? '')}" placeholder="genomic / pedigree / registry / other"><datalist id="coi-method-dl">${methodOpts}</datalist>`)}
          ${field('Source', `<input id="coi-source" type="text" value="${esc(c.source ?? '')}" placeholder="e.g. Embark, AKC 5-gen">`)}
          ${field('As of', `<input id="coi-as_of" type="date" value="${esc(c.as_of_date ?? '')}">`)}
        </div>
        <div id="coi-error"></div>
        <div class="form-actions" style="margin-top:12px;">
          <button class="btn btn-primary btn-sm" id="coi-save">Save</button>
          <button class="btn btn-sm" id="coi-cancel">Cancel</button>
        </div>
      </section>`;

    document.getElementById('coi-cancel').addEventListener('click', () => { ctx.coiEditing = false; renderRecordedCoiSection(); });
    document.getElementById('coi-save').addEventListener('click', async () => {
      const valRaw = document.getElementById('coi-value').value.trim();
      const method = document.getElementById('coi-method').value.trim();
      const source = document.getElementById('coi-source').value.trim();
      const asOf = document.getElementById('coi-as_of').value;
      let recorded_coi = null;
      if (valRaw !== '') {
        const n = Number(valRaw);
        if (!Number.isFinite(n)) {
          document.getElementById('coi-error').innerHTML = '<div class="inline-error">COI value must be a number (percent, e.g. 6.25).</div>';
          return;
        }
        recorded_coi = { value: n, method: method || null, source: source || null, as_of_date: asOf || null };
      }
      try {
        ctx.original = await dogRepo.update(d.id, { recorded_coi });
        ctx.coiEditing = false;
        renderRecordedCoiSection();
      } catch (e) { document.getElementById('coi-error').innerHTML = `<div class="inline-error">${esc(e.message || String(e))}</div>`; }
    });
    return;
  }

  const bodyHtml = coi && coi.value != null
    ? `<dl class="dl-meta" style="margin-top:12px;">
        ${row('COI value', `<strong>${esc(coi.value)}%</strong>`)}
        ${row('Method', esc(coi.method))}
        ${row('Source', esc(coi.source))}
        ${row('As of', coi.as_of_date ? esc(fmtDate(coi.as_of_date)) : '')}
       </dl>
       <p class="faint" style="margin:10px 0 0; font-size:13px;">User-recorded / attested — recorded from your lab or registry, not computed or verified by this app.</p>`
    : `<p class="muted" style="margin:12px 0 0;">No COI recorded.</p>`;

  const hasContent = coi && coi.value != null;
  const headerBtn = `<button class="btn btn-sm" id="coi-edit">${hasContent ? 'Edit' : '+ Add COI'}</button>`;
  els.recordedCoi.innerHTML = renderCollapsibleCard('Recorded COI', bodyHtml, headerBtn, { sectionKey: 'recorded-coi', hasContent });
  document.getElementById('coi-edit').addEventListener('click', () => { ctx.coiEditing = true; renderRecordedCoiSection(); });
  setupCollapsibleCard('recorded-coi');
}

// Health-test summary (Stage 5, Build Brief §6) — a READ-ONLY presentation of
// this dog's recorded genetic / OFA-PennHIP / breed-specific test events with
// their details. It computes nothing: no carrier-risk math, no genotype
// interpretation, no clear/carrier/affected → offspring inference (that needs
// structured locus data the app doesn't model — door left open in §11). This is
// the "genetic analysis" of Stage 5: surfacing what was recorded, nothing more.
// Editing/adding these events stays in the Event History below.
// A single events read for the current dog in view mode, or null otherwise —
// so the health-test and planned-test sections can share one fetch when rendered
// together, while each still self-fetches when re-rendered on its own.
function viewDogEventsPromise() {
  return (ctx.mode === 'view' && ctx.original)
    ? eventRepo.getForSubject('dog', ctx.original.id)
    : null;
}

const HEALTH_TEST_TYPES = ['genetic_test', 'ofa_pennhip', 'breed_specific_test'];
async function renderHealthTestsSection(eventsP = null) {
  if (!els.healthTests) return;
  if (ctx.mode !== 'view' || !ctx.original) { els.healthTests.innerHTML = ''; return; }
  const d = ctx.original;
  const events = await (eventsP || eventRepo.getForSubject('dog', d.id));
  const tests = events.filter((e) => HEALTH_TEST_TYPES.includes(e.event_type));

  const detailsSummary = (ev) => {
    const typeDef = descriptor(EVENT_TYPES, ev.event_type);
    if (!typeDef.fields?.length || !ev.details) return '';
    return typeDef.fields
      .filter((f) => ev.details[f.key] != null && ev.details[f.key] !== '')
      .map((f) => `${esc(f.label)}: ${esc(ev.details[f.key])}`)
      .join(' · ');
  };

  const rowsHtml = tests.length
    ? `<ul class="linked-list" style="margin:14px 0 0; padding:0; list-style:none;">` + tests.map((ev) => {
        const summary = detailsSummary(ev);
        return `<li style="padding:8px 0; border-top:1px solid var(--border);">
          <div>${badge(EVENT_TYPES, ev.event_type)} <strong>${esc(ev.title)}</strong> <span class="faint">${esc(fmtDate(ev.event_date))}</span></div>
          ${summary ? `<div class="muted" style="font-size:14px;">${summary}</div>` : ''}
        </li>`;
      }).join('') + `</ul>`
    : `<p class="muted" style="margin:14px 0 0;">No health-test events recorded yet.</p>`;

  const bodyHtml = `
    <p class="field-hint">Recorded genetic, OFA/PennHIP, and breed-specific test results for this dog — a read-only view of what's been logged. Add or edit these in the Event History below.</p>
    ${rowsHtml}`;

  const hasContent = tests.length > 0;
  els.healthTests.innerHTML = renderCollapsibleCard('Health-Test Summary', bodyHtml, '', { sectionKey: 'health-tests', hasContent });
  setupCollapsibleCard('health-tests');
}

// Planned Tests panel + advisory completeness view (Test Planning Addendum §6.2).
// planned_tests is an editable checklist; below each planned token, an advisory
// "logged" / "no matching event found — verify" flag, string-matched
// case-insensitively/trimmed against this dog's own test events. Never a hard
// fraction — matching can legitimately miss on drift, typos, or grain mismatch,
// so the view nudges rather than scores.
async function renderPlannedTestsSection(eventsP = null) {
  if (!els.plannedTests) return;
  if (ctx.mode !== 'view' || !ctx.original) { els.plannedTests.innerHTML = ''; return; }
  const d = ctx.original;
  const planned = d.planned_tests || [];

  const [events, kennelVocab, seenTokens] = await Promise.all([
    eventsP || eventRepo.getForSubject('dog', d.id),
    kennelRepo.getVocabulary(),
    eventRepo.getTestTokens()
  ]);
  const loggedTokens = new Set();
  for (const e of events) {
    for (const t of testTokensOf(e)) loggedTokens.add(t.trim().toLowerCase());
  }
  const vocabulary = [];
  {
    const seen = new Set();
    for (const t of [...kennelVocab, ...seenTokens]) {
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      vocabulary.push(t);
    }
  }

  // (#8) Only show planned tokens that are NOT yet matched by a logged event —
  // matched ones already surface in the Health-Test Summary card above.
  const unlogged = planned.filter((t) => !loggedTokens.has(t.trim().toLowerCase()));

  const rowsHtml = unlogged.length
    ? `<ul class="linked-list" style="margin:14px 0 0; padding:0; list-style:none;">` + unlogged.map((t) => {
        return `<li class="row-between" style="padding:8px 0; border-top:1px solid var(--border);">
          <span>${esc(t)} <span class="badge badge-amber">Planned</span></span>
          <button class="btn btn-sm" data-act="pt-remove" data-token="${esc(t)}" aria-label="Remove ${esc(t)}" title="Remove">✕</button>
        </li>`;
      }).join('') + `</ul>`
    : `<p class="muted" style="margin:14px 0 0;">${planned.length ? 'All planned tests logged.' : 'No tests planned yet.'}</p>`;

  // Copy-plan-from sources (§5): other dogs' plans, and kennel panels (a
  // kennel source is scoped to this dog's own breed at copy time — see the
  // pt-copy handler below).
  const dogSources = ctx.allDogs.filter((o) => o.id !== d.id && (o.planned_tests || []).length);
  const kennelSources = ctx.allKennels.filter((k) => (k.preferred_tests || []).length);
  const sourceOptions = [
    `<option value="">— choose a source —</option>`,
    ...kennelSources.map((k) => `<option value="kennel:${esc(k.id)}">Kennel: ${esc(k.kennel_name)}</option>`),
    ...dogSources.map((o) => `<option value="dog:${esc(o.id)}">Dog: ${esc(o.call_name)}</option>`)
  ].join('');

  // (#9) Add/copy controls collapse behind a header toggle; state survives
  // re-render (ctx.plannedTestsAddOpen) so it stays open across an add/copy.
  const controlsHtml = `
    <div id="pt-controls"${ctx.plannedTestsAddOpen ? '' : ' hidden'}>
      <div class="form-grid" style="margin-top:12px;">
        ${field('Add a test', `<input id="pt-new" type="text" list="pt-dl" placeholder="Type a test, then press Enter"><datalist id="pt-dl">${vocabulary.map((t) => `<option value="${esc(t)}"></option>`).join('')}</datalist>`)}
      </div>
      <div class="form-actions"><button class="btn btn-sm" id="pt-add">Add</button></div>
      <div class="form-grid" style="margin-top:12px;">
        ${field('Copy plan from…', `<select id="pt-source">${sourceOptions}</select>`)}
      </div>
      <div class="form-actions"><button class="btn btn-sm" id="pt-copy">Copy</button></div>
    </div>`;

  const bodyHtml = `
    <p class="field-hint">The tests this dog's plan says to run — an undated intention, not an event. Advisory only.</p>
    ${rowsHtml}
    ${controlsHtml}`;

  const hasContent = planned.length > 0;
  const headerBtn = `<button class="btn btn-sm" id="pt-toggle">${ctx.plannedTestsAddOpen ? 'Hide' : '+ Plan a test'}</button>`;
  els.plannedTests.innerHTML = renderCollapsibleCard('Planned Tests', bodyHtml, headerBtn, { sectionKey: 'planned-tests', hasContent });

  document.getElementById('pt-toggle').addEventListener('click', () => {
    ctx.plannedTestsAddOpen = !ctx.plannedTestsAddOpen;
    renderPlannedTestsSection();
  });
  setupCollapsibleCard('planned-tests');

  const addTest = async () => {
    const input = document.getElementById('pt-new');
    const val = input.value.trim();
    if (!val) return;
    try {
      ctx.original = await dogRepo.addPlannedTests(d.id, [val]);
      renderPlannedTestsSection();
    } catch (e) { showError(e.message || String(e)); }
  };
  document.getElementById('pt-add').addEventListener('click', addTest);
  document.getElementById('pt-new').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    addTest();
  });
  els.plannedTests.querySelectorAll('[data-act="pt-remove"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const remaining = (ctx.original.planned_tests || []).filter((t) => t !== btn.dataset.token);
      try {
        ctx.original = await dogRepo.update(d.id, { planned_tests: remaining });
        renderPlannedTestsSection();
      } catch (e) { showError(e.message || String(e)); }
    });
  });
  document.getElementById('pt-copy').addEventListener('click', async () => {
    const val = document.getElementById('pt-source').value;
    if (!val) return;
    const [kind, srcId] = val.split(':');
    const tokens = kind === 'kennel'
      ? kennelRepo.testsForBreed(ctx.kennelsById.get(srcId), d.breed)
      : (ctx.dogsById.get(srcId)?.planned_tests || []);
    try {
      ctx.original = await dogRepo.addPlannedTests(d.id, tokens);
      renderPlannedTestsSection();
    } catch (e) { showError(e.message || String(e)); }
  });
}

// Derived "Pairings" panel (Stage 3): pairings where this dog is sire or dam.
// Shown for breeding-age dogs, or for any dog that actually appears in a pairing
// (so a status change never hides existing breeding history). Read-only — pairings
// are edited from their own page.
const BREEDING_STATUSES = ['active_breeding', 'retired_breeding'];
async function renderPairingsSection() {
  if (!els.pairings) return;
  if (ctx.mode !== 'view' || !ctx.original) { els.pairings.innerHTML = ''; return; }

  const d = ctx.original;
  const pairings = await pairingRepo.getForDog(d.id);
  // Hide the panel entirely for non-breeding dogs that have no pairings.
  if (!pairings.length && !BREEDING_STATUSES.includes(d.status)) { els.pairings.innerHTML = ''; return; }

  pairings.sort((a, b) => (b.planned_date || '').localeCompare(a.planned_date || ''));

  const rowsHtml = pairings.length
    ? `<ul class="linked-list" style="margin:14px 0 0; padding:0; list-style:none;">` + pairings.map((p) => {
        const role = p.sire_id === d.id ? 'Sire' : 'Dam';
        const partnerId = p.sire_id === d.id ? p.dam_id : p.sire_id;
        return `<li class="row-between" style="padding:8px 0; border-top:1px solid var(--border);">
          <span><span class="faint">${role} ·</span> with <strong>${esc(dogName(partnerId) || '—')}</strong> ${badge(PAIRING_TYPE, p.pairing_type)} ${badge(PAIRING_STATUS, p.status)}${p.planned_date ? ` <span class="faint">${esc(fmtDate(p.planned_date))}</span>` : ''}</span>
          <a class="btn btn-sm" href="pairing.html?id=${encodeURIComponent(p.id)}">Open →</a>
        </li>`;
      }).join('') + `</ul>`
    : `<p class="muted" style="margin:14px 0 0;">No pairings recorded for this dog yet.</p>`;

  const hasContent = pairings.length > 0;
  const headerBtn = `<a class="btn btn-sm" href="pairing.html?new=1">+ Add Pairing</a>`;
  els.pairings.innerHTML = renderCollapsibleCard('Pairings', rowsHtml, headerBtn, { sectionKey: 'pairings', hasContent });
  setupCollapsibleCard('pairings');
}

// Derived "Sales" panel (Stage 4): placements recorded for this dog. Shown when
// there are existing records, or for a dog that could plausibly be sold (owned/
// co-owned) — read-only here; sales are edited from their own page.
async function renderSalesSection() {
  if (!els.sales) return;
  if (ctx.mode !== 'view' || !ctx.original) { els.sales.innerHTML = ''; return; }
  const d = ctx.original;
  const sales = await saleRepo.getByDog(d.id);
  if (!sales.length && !['owned', 'co_owned'].includes(d.ownership_type)) { els.sales.innerHTML = ''; return; }

  sales.sort((a, b) => (b.sale_date || b.created_at || '').localeCompare(a.sale_date || a.created_at || ''));
  const rowsHtml = sales.length
    ? `<ul class="linked-list" style="margin:14px 0 0; padding:0; list-style:none;">` + sales.map((s) => `
        <li class="row-between" style="padding:8px 0; border-top:1px solid var(--border);">
          <span>${badge(PLACEMENT_TYPE, s.placement_type)} <strong>${esc(contactName(s.buyer_contact_id) || '—')}</strong> ${badge(SALE_STATUS, s.status)}${s.sale_date ? ` <span class="faint">${esc(fmtDate(s.sale_date))}</span>` : ''}</span>
          <a class="btn btn-sm" href="sale.html?id=${encodeURIComponent(s.id)}">Open →</a>
        </li>`).join('') + `</ul>`
    : `<p class="muted" style="margin:14px 0 0;">No sales recorded for this dog yet.</p>`;

  const hasContent = sales.length > 0;
  const headerBtn = `<a class="btn btn-sm" href="sale.html?new=1&dog=${encodeURIComponent(d.id)}">+ Add Sale</a>`;
  els.sales.innerHTML = renderCollapsibleCard('Sales', rowsHtml, headerBtn, { sectionKey: 'sales', hasContent });
  setupCollapsibleCard('sales');
}

// Derived "Stud Services" panel (Stage 4): stud services where this dog appears
// on either side. Shown for breeding-age dogs or a dog with existing records.
async function renderStudServicesSection() {
  if (!els.studServices) return;
  if (!editionFlags.studServices) { els.studServices.innerHTML = ''; return; } // Pro-only in Lite
  if (ctx.mode !== 'view' || !ctx.original) { els.studServices.innerHTML = ''; return; }
  const d = ctx.original;
  const studServices = await studServiceRepo.getForDog(d.id);
  if (!studServices.length && !BREEDING_STATUSES.includes(d.status)) { els.studServices.innerHTML = ''; return; }
  studServices.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  const rowsHtml = studServices.length
    ? `<ul class="linked-list" style="margin:14px 0 0; padding:0; list-style:none;">` + studServices.map((s) => {
        const partnerId = s.our_dog_id === d.id ? s.partner_dog_id : s.our_dog_id;
        return `<li class="row-between" style="padding:8px 0; border-top:1px solid var(--border);">
          <span>${badge(STUD_SERVICE_DIRECTION, s.direction)} with <strong>${esc(dogName(partnerId) || '—')}</strong> ${badge(STUD_SERVICE_STATUS, s.status)}</span>
          <a class="btn btn-sm" href="stud-service.html?id=${encodeURIComponent(s.id)}">Open →</a>
        </li>`;
      }).join('') + `</ul>`
    : `<p class="muted" style="margin:14px 0 0;">No stud services recorded for this dog yet.</p>`;

  const hasContent = studServices.length > 0;
  const headerBtn = `<a class="btn btn-sm" href="stud-service.html?new=1&dog=${encodeURIComponent(d.id)}">+ Add Stud Service</a>`;
  els.studServices.innerHTML = renderCollapsibleCard('Stud Services', rowsHtml, headerBtn, { sectionKey: 'stud-services', hasContent });
  setupCollapsibleCard('stud-services');
}

// Derived "Contracts" panel: contracts that name this dog directly via
// Contract.related_dog_id — lease/co_own/other only (sale/stud_service
// contracts reach their dog through the linked Sale/StudService, and show up
// in the Sales/Stud Services panels above instead). Shown for leased-in/out
// dogs or a dog with existing linked contracts.
async function renderContractsSection() {
  if (!els.contracts) return;
  if (!editionFlags.contracts) { els.contracts.innerHTML = ''; return; } // Pro-only in Lite
  if (ctx.mode !== 'view' || !ctx.original) { els.contracts.innerHTML = ''; return; }
  const d = ctx.original;
  const contracts = await contractRepo.getByDog(d.id);
  if (!contracts.length && !['leased_in', 'leased_out'].includes(d.ownership_type)) { els.contracts.innerHTML = ''; return; }
  contracts.sort((a, b) => (b.signed_date || b.created_at || '').localeCompare(a.signed_date || a.created_at || ''));

  const rowsHtml = contracts.length
    ? `<ul class="linked-list" style="margin:14px 0 0; padding:0; list-style:none;">` + contracts.map((c) => `
        <li class="row-between" style="padding:8px 0; border-top:1px solid var(--border);">
          <span>${badge(CONTRACT_TYPE, c.contract_type)} <strong>${esc(c.title || 'Contract')}</strong> ${badge(CONTRACT_STATUS, c.status)}${c.signed_date ? ` <span class="faint">signed ${esc(fmtDate(c.signed_date))}</span>` : ''}</span>
          <a class="btn btn-sm" href="contract.html?id=${encodeURIComponent(c.id)}">Open →</a>
        </li>`).join('') + `</ul>`
    : `<p class="muted" style="margin:14px 0 0;">No contracts naming this dog directly yet.</p>`;

  const hasContent = contracts.length > 0;
  const headerBtn = `<a class="btn btn-sm" href="contract.html?new=1&dog=${encodeURIComponent(d.id)}">+ Add Contract</a>`;
  els.contracts.innerHTML = renderCollapsibleCard('Contracts', rowsHtml, headerBtn, { sectionKey: 'contracts', hasContent });
  setupCollapsibleCard('contracts');
}

// Derived "Litters" panel: litters where this dog is sire or dam.
async function renderLittersSection() {
  if (!els.litters) return;
  if (ctx.mode !== 'view' || !ctx.original) { els.litters.innerHTML = ''; return; }
  const d = ctx.original;
  const litters = ctx.allLitters.filter((l) => l.sire_id === d.id || l.dam_id === d.id);

  const rowsHtml = litters.length
    ? `<ul class="linked-list" style="margin:14px 0 0; padding:0; list-style:none;">` + litters.map((l) => {
        const role = l.sire_id === d.id ? 'Sire' : 'Dam';
        const partnerId = l.sire_id === d.id ? l.dam_id : l.sire_id;
        return `<li class="row-between" style="padding:8px 0; border-top:1px solid var(--border);">
          <span><span class="faint">${role} ·</span> with <strong>${esc(dogName(partnerId) || '—')}</strong> ${badge(LITTER_STATUS, l.status)}${l.whelp_date ? ` <span class="faint">${esc(fmtDate(l.whelp_date))}</span>` : ''}</span>
          <a class="btn btn-sm" href="litter.html?id=${encodeURIComponent(l.id)}">Open →</a>
        </li>`;
      }).join('') + `</ul>`
    : `<p class="muted" style="margin:14px 0 0;">No litters recorded for this dog yet.</p>`;

  const hasContent = litters.length > 0;
  const headerBtn = `<a class="btn btn-sm" href="litter.html?new=1">+ Add Litter</a>`;
  els.litters.innerHTML = renderCollapsibleCard('Litters', rowsHtml, headerBtn, { sectionKey: 'litters', hasContent });
  setupCollapsibleCard('litters');
}

// Pedigree centered on this dog (only for a saved dog in view mode). Clicking a
// node opens the full Pedigree page re-centered there.
function renderPedigreeSection() {
  if (!els.pedigree) return;
  if (ctx.mode === 'view' && ctx.original) {
    const bodyHtml = `<div id="dog-pedigree-mount" style="margin-top:14px;"></div>`;
    const headerBtn = `<a class="btn btn-sm" href="pedigree.html?id=${encodeURIComponent(ctx.original.id)}">Open full view →</a>`;
    els.pedigree.innerHTML = renderCollapsibleCard('Pedigree', bodyHtml, headerBtn, { sectionKey: 'pedigree', hasContent: true });
    renderPedigree({
      mount: document.getElementById('dog-pedigree-mount'),
      rootId: ctx.original.id,
      generations: 3,
      onNavigate: (id) => { location.href = `pedigree.html?id=${encodeURIComponent(id)}`; }
    });
    setupCollapsibleCard('pedigree');
  } else {
    els.pedigree.innerHTML = '';
  }
}

function renderAll() {
  renderTitle();
  renderProfileActions();
  renderHeaderActions();
  if (ctx.mode === 'view') renderView();
  else renderEdit();
  renderRecordedCoiSection();
  // Health-test and planned-test sections both read this dog's events; share one
  // fetch (a single promise) so it's queried once, not twice, per render.
  const eventsP = viewDogEventsPromise();
  renderPlannedTestsSection(eventsP);
  renderHealthTestsSection(eventsP);
  renderTimelineSection();
  renderExpensesSection();
  renderPairingsSection();
  renderSalesSection();
  renderStudServicesSection();
  renderContractsSection();
  renderLittersSection();
  renderPedigreeSection();
}

async function main() {
  await loadRefs();
  const id = param('id');
  const isNew = param('new');

  if (isNew) {
    ctx.mode = 'new';
    ctx.draft = blankDog();
    renderTitle();
    renderCapBanner();
    renderEdit();
    renderProfileActions();
    renderHeaderActions();
    return;
  }

  if (!id) { showError('No dog id provided.'); return; }
  const dog = await dogRepo.getById(id);
  if (!dog) { showError('Dog not found. It may have been deleted.'); return; }
  ctx.original = dog;
  ctx.mode = 'view';
  renderAll();
  openEventFromQuery('dog', dog.id, renderTimelineSection);
}

main();
