// sale.js — Sale Detail. Edit-in-place profile and a derived Contracts panel
// (contracts.related_sale_id = this sale — canonical on Contract, never a
// Sale.contract_id, Stage4 Revision v2 §5). Buyer is a Contact (no Buyer table).
import { saleRepo, ReferenceBlockedError } from '../data/saleRepo.js';
import { expectedPricing } from '../data/saleDefaults.js';
import { contractRepo } from '../data/contractRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { REGISTRATION_TYPE, SALE_STATUS, RELEASED_SALE_STATUSES, SALE_END_REASON, saleEndReasonsFor, DISPOSITION, DOG_STATUS, CONTRACT_TYPE, CONTRACT_STATUS, BOARDING_FREQUENCY_OPTIONS, descriptor } from '../data/vocab.js';
import { restoresFamily } from '../data/waitlistRules.js';
import { esc, badge, fmtDate, todayYMD, param, confirmModal, selectModal, promptModal, dogRefHtml } from '../assets/ui.js';
import { openEventForm } from '../assets/eventForm.js';
import { attachNewContactButton } from '../assets/contactPicker.js';
import { editionFlags } from '../data/editionConfig.js';
import { resolveKennelIdForWrite, dogInScope, isScoped } from '../data/kennelScope.js';
import { renderScopeNotice } from '../assets/kennelScopeUI.js';

// Statuses that warrant the "log a scheduled pickup" prompt (Stage4.5 Addendum §D4).
const PLACEMENT_PROMPT_STATUSES = ['paid_in_full', 'delivered'];

const els = {
  title: document.getElementById('sale-title'),
  subtitle: document.getElementById('sale-subtitle'),
  headerActions: document.getElementById('header-actions'),
  profileActions: document.getElementById('profile-actions'),
  body: document.getElementById('profile-body'),
  error: document.getElementById('page-error'),
  contracts: document.getElementById('contracts-section')
};

const blankSale = () => ({
  dog_id: '', buyer_contact_id: '', sale_date: '', price: '', deposit_amount: '',
  deposit_date: '', balance_due_date: '', balance_paid_date: '', registration_type: '',
  lead_source: '', referred_by_contact_id: '', status: '', notes: '',
  transport_fee: '', deferred_boarding_amount: '', deferred_boarding_frequency: '',
  deferred_boarding_duration_days: '', end_reason: '', end_note: ''
});

const ctx = {
  mode: 'view', original: null, draft: null, pickerArchived: false,
  // §9's "show all kennels" escape — see dogOptions().
  pickerAllKennels: false,
  allDogs: [], allContacts: [], leadSources: [],
  dogsById: new Map(), contactsById: new Map(), littersById: new Map()
};

async function loadRefs() {
  const [dogs, contacts, leadSources, litters] = await Promise.all([
    dogRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true }),
    saleRepo.getLeadSources(),
    litterRepo.getAll({ includeArchived: true })
  ]);
  ctx.allDogs = dogs;
  ctx.allContacts = contacts;
  ctx.leadSources = leadSources;
  ctx.dogsById = new Map(dogs.map((d) => [d.id, d]));
  ctx.contactsById = new Map(contacts.map((c) => [c.id, c]));
  ctx.littersById = new Map(litters.map((l) => [l.id, l]));
}

// Prefills registration_type from the dog's intended_registration, then
// price/deposit_amount from the dog's litter (data/saleDefaults.js: by the dog's
// sex, plus the Full-registration surcharge when the registration is Full) — only
// into fields still empty, so it never clobbers a value already entered (same
// pattern as the buyer's first_contact_source -> lead_source prefill below).
function applyExpectedPricing() {
  const dog = ctx.dogsById.get(ctx.draft.dog_id);
  if (dog && !ctx.draft.registration_type && dog.intended_registration) ctx.draft.registration_type = dog.intended_registration;
  const litter = dog && dog.litter_id ? ctx.littersById.get(dog.litter_id) : null;
  if (!litter) return;
  const expected = expectedPricing(dog, litter, ctx.draft.registration_type);
  if (!ctx.draft.price && expected.price != null) ctx.draft.price = expected.price;
  if (!ctx.draft.deposit_amount && expected.deposit_amount != null) ctx.draft.deposit_amount = expected.deposit_amount;
}

function dogName(id) {
  const d = ctx.dogsById.get(id);
  return d ? (d.call_name + (d.registered_name ? ` (${d.registered_name})` : '')) : '';
}
function contactName(id) {
  return ctx.contactsById.get(id)?.name || '';
}

// --- Option builders -----------------------------------------------------
function vocabOptions(vocab, current, placeholder) {
  const head = placeholder != null ? `<option value="">${esc(placeholder)}</option>` : '';
  return head + vocab.map((v) =>
    `<option value="${esc(v.value)}"${v.value === current ? ' selected' : ''}>${esc(v.label)}</option>`
  ).join('');
}

// The dog being placed. Active-kennel scope (Multi-Kennel Scope Spec §9):
// scoped by default with the "show all my kennels" escape, since a sale's own
// kennel is INHERITED from this dog — picking one from another kennel files the
// sale there, which should be a deliberate act. The current selection is always
// listed so an existing sale never becomes uneditable.
function dogOptions(current) {
  const opts = ctx.allDogs
    .filter((d) => ctx.pickerAllKennels || d.id === current || dogInScope(d))
    .filter((d) => ctx.pickerArchived || !d.is_archived || d.id === current)
    .map((d) => `<option value="${esc(d.id)}"${d.id === current ? ' selected' : ''}>${esc(d.call_name)}${d.registered_name ? ' — ' + esc(d.registered_name) : ''}${d.is_archived ? ' (archived)' : ''}</option>`)
    .join('');
  return `<option value="">— select —</option>` + opts;
}

// NOT scoped, deliberately (§7): buyers are program-wide — one person who may
// have bought from more than one of your kennels.
function contactOptions(current) {
  const opts = ctx.allContacts
    .filter((c) => ctx.pickerArchived || !c.is_archived || c.id === current)
    .map((c) => `<option value="${esc(c.id)}"${c.id === current ? ' selected' : ''}>${esc(c.name)}${c.is_archived ? ' (archived)' : ''}</option>`)
    .join('');
  return `<option value="">— select —</option>` + opts;
}

function frequencyOptions(current) {
  const opts = BOARDING_FREQUENCY_OPTIONS
    .map((o) => `<option value="${esc(o)}"${o === current ? ' selected' : ''}>${esc(o)}</option>`)
    .join('');
  return `<option value="">— select —</option>` + opts;
}

// --- Read-only view --------------------------------------------------------
function row(label, valueHtml) {
  return `<dt>${esc(label)}</dt><dd>${valueHtml || '<span class="faint">—</span>'}</dd>`;
}

function money(v) {
  return v != null && v !== '' ? `$${Number(v).toFixed(2)}` : '';
}

function renderView() {
  const s = ctx.original;
  els.body.innerHTML = `
    <dl class="dl-meta" style="margin-top:14px;">
      ${row('Dog', dogRefHtml(s.dog_id, dogName(s.dog_id) || '—', ctx.dogsById.get(s.dog_id)?.is_archived))}
      ${row('Buyer', editionFlags.contactsSection
        ? `<a href="contact.html?id=${encodeURIComponent(s.buyer_contact_id)}">${esc(contactName(s.buyer_contact_id) || '—')}</a>`
        : esc(contactName(s.buyer_contact_id) || '—'))}
      ${row('Registration', badge(REGISTRATION_TYPE, s.registration_type))}
      ${row('Status', badge(SALE_STATUS, s.status))}
      ${s.end_reason ? row('Why it ended', esc(descriptor(SALE_END_REASON, s.end_reason).label)) : ''}
      ${s.end_note ? row('About it', esc(s.end_note).replace(/\n/g, '<br>')) : ''}
      ${row('Price', esc(money(s.price)))}
      ${row('Deposit amount', esc(money(s.deposit_amount)))}
      ${row('Transport fee', esc(money(s.transport_fee)))}
      ${row('Deferred pickup boarding', s.deferred_boarding_amount != null && s.deferred_boarding_amount !== '' ? `${esc(money(s.deferred_boarding_amount))}${s.deferred_boarding_frequency ? ` per ${esc(s.deferred_boarding_frequency)}` : ''}${s.deferred_boarding_duration_days ? ` × ${esc(s.deferred_boarding_duration_days)}` : ''}` : '')}
      ${row('Sale date', s.sale_date ? esc(fmtDate(s.sale_date)) : '')}
      ${row('Deposit date', s.deposit_date ? esc(fmtDate(s.deposit_date)) : '')}
      ${row('Balance due date', s.balance_due_date ? esc(fmtDate(s.balance_due_date)) : '')}
      ${row('Balance paid date', s.balance_paid_date ? esc(fmtDate(s.balance_paid_date)) : '')}
      ${row('Lead source', esc(s.lead_source))}
      ${editionFlags.contactsSection ? row('Referred by', s.referred_by_contact_id
        ? `<a href="contact.html?id=${encodeURIComponent(s.referred_by_contact_id)}">${esc(contactName(s.referred_by_contact_id) || '—')}</a>`
        : '') : ''}
      ${row('Notes', s.notes ? esc(s.notes).replace(/\n/g, '<br>') : '')}
    </dl>`;
}

// --- Edit form ---------------------------------------------------------

// Why a voided or returned sale ended (vocab SALE_END_REASON): required for those
// two statuses, and hidden for every other. Voided = it fell through on your side
// (the pup died or can't be sold); Cancelled = the buyer backed out; Returned = the
// pup came back after going home.
function endReasonFields(s) {
  const reasons = saleEndReasonsFor(s.status);
  if (!reasons.length) return '';
  const hint = s.status === 'voided'
    ? 'Voided: the sale fell through on your side, not the buyer\'s. Nothing on it counts as income. (A buyer backing out is Cancelled.)'
    : 'Returned: the pup came back after going home.';
  return `${field('Why it ended', `<select id="f-end_reason">${vocabOptions(reasons, s.end_reason, 'Select…')}</select>`, { required: true, hint })}
      ${field('About it', `<input id="f-end_note" type="text" value="${esc(s.end_note)}" placeholder="e.g. what the vet found">`)}`;
}
function field(label, inner, { required = false, hint = '', wide = false } = {}) {
  return `<div class="field${wide ? ' field-wide' : ''}">
    <label>${esc(label)}${required ? ' <span class="req">*</span>' : ''}</label>
    ${inner}
    ${hint ? `<span class="field-hint">${esc(hint)}</span>` : ''}
  </div>`;
}

function renderEdit() {
  const s = ctx.draft;
  const sourceList = ctx.leadSources.map((v) => `<option value="${esc(v)}"></option>`).join('');
  els.body.innerHTML = `
    <div class="form-grid" id="sale-form" style="margin-top:14px;">
      ${field('Dog', `<select id="f-dog_id">${dogOptions(s.dog_id)}</select>`, { required: true })}
      ${field('Buyer', `<select id="f-buyer_contact_id">${contactOptions(s.buyer_contact_id)}</select>`, { required: true })}
      ${field('Registration', `<select id="f-registration_type">${vocabOptions(REGISTRATION_TYPE, s.registration_type, 'Select…')}</select>`, { required: true, hint: 'Full adds the litter\'s Full-registration surcharge to a prefilled price.' })}
      ${field('Status', `<select id="f-status">${vocabOptions(SALE_STATUS, s.status, 'Select…')}</select>`, { required: true })}
      ${endReasonFields(s)}
      ${field('Price', `<input id="f-price" type="number" min="0" step="0.01" value="${esc(s.price)}">`)}
      ${field('Deposit amount', `<input id="f-deposit_amount" type="number" min="0" step="0.01" value="${esc(s.deposit_amount)}">`)}
      ${field('Transport fee', `<input id="f-transport_fee" type="number" min="0" step="0.01" value="${esc(s.transport_fee)}">`)}
      ${field('Deferred pickup boarding', `<div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <input id="f-deferred_boarding_amount" type="number" min="0" step="0.01" value="${esc(s.deferred_boarding_amount)}" style="flex:1; min-width:90px;">
          <span class="faint">per</span>
          <select id="f-deferred_boarding_frequency" style="flex:1; min-width:90px;">${frequencyOptions(s.deferred_boarding_frequency)}</select>
          <span class="faint">×</span>
          <input id="f-deferred_boarding_duration_days" type="text" placeholder="count" value="${esc(s.deferred_boarding_duration_days)}" style="flex:1; min-width:70px;">
        </div>`, { hint: 'A boarding rate for a buyer who delayed pickup — the count is the number of frequency units (e.g. 2 = 2 weeks). A plain rate, not a Financials cost.' })}
      ${field('Sale date', `<input id="f-sale_date" type="date" value="${esc(s.sale_date)}">`)}
      ${field('Deposit date', `<input id="f-deposit_date" type="date" value="${esc(s.deposit_date)}">`)}
      ${field('Balance due date', `<input id="f-balance_due_date" type="date" value="${esc(s.balance_due_date)}">`)}
      ${field('Balance paid date', `<input id="f-balance_paid_date" type="date" value="${esc(s.balance_paid_date)}">`)}
      ${field('Lead source', `<input id="f-lead_source" type="text" list="lead-source-list" value="${esc(s.lead_source)}"><datalist id="lead-source-list">${sourceList}</datalist>`, { hint: 'How this specific sale came in. Prefills from the buyer, but may differ.' })}
      ${editionFlags.contactsSection ? field('Referred by', `<select id="f-referred_by_contact_id">${contactOptions(s.referred_by_contact_id)}</select>`, { hint: 'The contact who referred this buyer. Tags them as a Buyer referrer automatically.' }) : ''}
      ${editionFlags.includeArchivedToggles ? `<div class="field field-wide">
        <label class="check-inline"><input id="picker-archived" type="checkbox"${ctx.pickerArchived ? ' checked' : ''}> Include archived dogs/contacts in the pickers above</label>
      </div>` : ''}
      ${isScoped() ? `<div class="field field-wide">
        <label class="check-inline"><input id="picker-all-kennels" type="checkbox"${ctx.pickerAllKennels ? ' checked' : ''}> Show dogs from all my kennels</label>
        <span class="field-hint">Off by default while a kennel is active. The sale is filed under the kennel of the dog you pick (Multi-Kennel Scope Spec §9).</span>
      </div>` : ''}
      ${field('Notes', `<textarea id="f-notes">${esc(s.notes)}</textarea>`, { wide: true })}
    </div>`;

  document.getElementById('picker-archived')?.addEventListener('change', (e) => {
    ctx.draft = readForm();
    ctx.pickerArchived = e.target.checked;
    renderEdit();
  });
  document.getElementById('picker-all-kennels')?.addEventListener('change', (e) => {
    ctx.draft = readForm();
    ctx.pickerAllKennels = e.target.checked;
    renderEdit();
  });
  // Voided/Returned need a reason; the reason fields come and go with the status.
  document.getElementById('f-status').addEventListener('change', () => {
    ctx.draft = readForm();
    renderEdit();
  });
  // Prefilling price/deposit_amount from the selected dog's litter (only when
  // those fields are still empty, so it never clobbers a deliberate entry).
  document.getElementById('f-dog_id').addEventListener('change', () => {
    ctx.draft = readForm();
    applyExpectedPricing();
    renderEdit();
  });
  // A registration change moves a price still at its prefilled amount to the
  // new registration's (the Full surcharge comes or goes); a price she typed stays.
  document.getElementById('f-registration_type').addEventListener('change', () => {
    const was = ctx.draft.registration_type;
    ctx.draft = readForm();
    const dog = ctx.dogsById.get(ctx.draft.dog_id);
    const litter = dog && dog.litter_id ? ctx.littersById.get(dog.litter_id) : null;
    if (litter) {
      const before = expectedPricing(dog, litter, was).price;
      const after = expectedPricing(dog, litter, ctx.draft.registration_type).price;
      if (before != null && Number(ctx.draft.price) === Number(before)) ctx.draft.price = after;
    }
    renderEdit();
  });
  // Prefilling lead_source from the buyer's first_contact_source (only when
  // lead_source is still empty, so it never clobbers a deliberate choice) —
  // Stage4 Revision v2 §3.
  document.getElementById('f-buyer_contact_id').addEventListener('change', (e) => {
    ctx.draft = readForm();
    const c = ctx.contactsById.get(e.target.value);
    if (c && c.first_contact_source && !ctx.draft.lead_source) {
      ctx.draft.lead_source = c.first_contact_source;
    }
    renderEdit();
  });
  const onNewContact = (contact) => {
    ctx.allContacts.push(contact);
    ctx.contactsById.set(contact.id, contact);
  };
  attachNewContactButton(document.getElementById('f-buyer_contact_id'), { onCreated: onNewContact });
  const referredByEl = document.getElementById('f-referred_by_contact_id');
  if (referredByEl) attachNewContactButton(referredByEl, { onCreated: onNewContact });
}

function readForm() {
  const val = (id) => document.getElementById(id)?.value ?? '';
  return {
    ...ctx.draft,
    dog_id: val('f-dog_id') || '',
    buyer_contact_id: val('f-buyer_contact_id') || '',
    registration_type: val('f-registration_type'),
    status: val('f-status'),
    sale_date: val('f-sale_date'),
    price: val('f-price'),
    deposit_amount: val('f-deposit_amount'),
    deposit_date: val('f-deposit_date'),
    balance_due_date: val('f-balance_due_date'),
    balance_paid_date: val('f-balance_paid_date'),
    transport_fee: val('f-transport_fee'),
    deferred_boarding_amount: val('f-deferred_boarding_amount'),
    deferred_boarding_frequency: val('f-deferred_boarding_frequency'),
    deferred_boarding_duration_days: val('f-deferred_boarding_duration_days').trim(),
    lead_source: val('f-lead_source').trim(),
    referred_by_contact_id: val('f-referred_by_contact_id') || null,
    end_reason: val('f-end_reason') || null,
    end_note: val('f-end_note').trim() || null,
    notes: val('f-notes')
  };
}

// Empty numeric strings become null.
function normalizeMoney(candidate) {
  for (const k of ['price', 'deposit_amount', 'transport_fee', 'deferred_boarding_amount']) {
    candidate[k] = candidate[k] === '' || candidate[k] == null ? null : Number(candidate[k]);
  }
  // Duration is a free-text field (e.g. "10-14"), not a number — only the
  // empty-string-to-null normalization applies.
  candidate.deferred_boarding_duration_days = candidate.deferred_boarding_duration_days || null;
  return candidate;
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
  const s = ctx.original;
  const archiveLabel = s.is_archived ? 'Unarchive' : 'Archive';
  const blockers = await saleRepo.getDeleteBlockers(s.id);
  const delTitle = blockers.length
    ? 'Referenced as ' + blockers.map((b) => `${b.label} (${b.count})`).join(', ') + ' — archive instead.'
    : 'Permanently delete this record.';
  const puppyRecordBtn = editionFlags.puppyRecord
    ? `<a class="btn btn-sm" id="btn-puppy-record" href="puppy-record.html?sale=${encodeURIComponent(s.id)}">Puppy Record (PDF)</a>`
    : '';
  // Invoice / Receipt for THIS sale without a trip to Financials (Pro-only, like
  // the Financials generator it opens; Lite never loads the module).
  const invoiceBtn = editionFlags.invoicing
    ? '<button class="btn btn-sm" id="btn-invoice">Invoice / Receipt</button>'
    : '';
  els.headerActions.innerHTML = `
    ${invoiceBtn}
    ${puppyRecordBtn}
    <button class="btn btn-sm" id="btn-archive">${archiveLabel}</button>
    <button class="btn btn-danger btn-sm" id="btn-delete"${blockers.length ? ' disabled' : ''} title="${esc(delTitle)}">Delete</button>`;
  document.getElementById('btn-archive').onclick = toggleArchive;
  const inv = document.getElementById('btn-invoice');
  if (inv) {
    inv.onclick = async () => {
      try {
        const { openInvoiceGenerator } = await import('../assets/invoiceGenerator.js');
        await openInvoiceGenerator({ preselect: { source: 'sale', id: s.id } });
      } catch (err) { showError(err.message || String(err)); }
    };
  }
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
  renderContractsSection();
}

function cancel() {
  clearError();
  if (ctx.mode === 'new') { location.href = 'sales.html'; return; }
  ctx.mode = 'view';
  renderView();
  renderProfileActions();
  renderContractsSection();
}

// Soft prompt on the Delivered transition (Enhancements Batch #7): offer to
// update the sold dog's ownership to reflect it has left the program.
// "External"/"Co-owned" are OWNERSHIP_TYPE values, not DOG_STATUS values — this
// edits dog.ownership_type (and, for External, may also set status to
// external_reference). Optional/warn-don't-block: the sale is already saved by
// the time this shows, and a skipped/failed update never blocks anything.
// Resolves once the modal is dismissed, so callers can sequence it.
function promptOwnershipUpdate(sale) {
  return new Promise((resolve) => {
    const dogLabel = dogName(sale.dog_id) || 'this dog';
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <h2 style="margin-top:0;">Sale delivered — update ${esc(dogLabel)}'s ownership?</h2>
      <div class="field">
        <label>Ownership</label>
        <select id="own-choice">
          <option value="">— leave unchanged —</option>
          <option value="external">External</option>
          <option value="co_owned">Co-owned</option>
        </select>
      </div>
      <div class="field" id="own-owner-field" hidden>
        <label>Owner</label>
        <select id="own-owner">${contactOptions(sale.buyer_contact_id)}</select>
      </div>
      <div id="own-error"></div>
      <div class="form-actions">
        <button class="btn btn-primary" id="own-confirm">Confirm</button>
        <button class="btn" id="own-skip">Skip</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); resolve(); };
    overlay.querySelector('#own-skip').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    const choiceSelect = overlay.querySelector('#own-choice');
    const ownerField = overlay.querySelector('#own-owner-field');
    // Owner is the single owner_contact_id field, which only applies to
    // External — Co-owned adds the buyer to co_owner_contact_ids instead
    // (handled below without needing a picker; owner_contact_id there stays
    // whoever it already was, typically the breeder).
    choiceSelect.addEventListener('change', () => {
      ownerField.hidden = choiceSelect.value !== 'external';
    });
    overlay.querySelector('#own-confirm').addEventListener('click', async () => {
      const choice = choiceSelect.value;
      if (!choice) { close(); return; }
      try {
        // Re-fetch: the co-own convenience above may have just updated this dog.
        const dog = await dogRepo.getById(sale.dog_id);
        if (choice === 'external') {
          const ownerId = overlay.querySelector('#own-owner').value || null;
          const updates = { ownership_type: 'external', status: 'external_reference', status_date: todayYMD() };
          if (ownerId) updates.owner_contact_id = ownerId;
          await dogRepo.update(sale.dog_id, updates);
        } else if (choice === 'co_owned') {
          const coOwners = dog?.co_owner_contact_ids || [];
          const updates = { ownership_type: 'co_owned' };
          if (!coOwners.includes(sale.buyer_contact_id)) updates.co_owner_contact_ids = [...coOwners, sale.buyer_contact_id];
          await dogRepo.update(sale.dog_id, updates);
        }
        close();
      } catch (e) {
        overlay.querySelector('#own-error').innerHTML = `<div class="inline-error">${esc(e.message || String(e))}</div>`;
      }
    });
  });
}

// Lite's delivery-departure (cap spec §5): on the transition into Delivered,
// offer to remove the sold dog (or sold puppy) from the roster. This is the Lite
// exit that replaces the Pro ownership→External prompt — archiving is the only
// way a dog leaves the roster in Lite, always gated by the blocking "permanent"
// confirm. Declining keeps the dog. The Sale record and pedigree survive either
// way (archive is a soft delete). A pup never counted toward the cap, so this is
// roster tidiness for pups and a genuine slot-free for a sold adult.
async function promptDepartOnDelivery(sale) {
  const dog = await dogRepo.getById(sale.dog_id);
  if (!dog || dog.is_archived) return;
  const dogLabel = dog.call_name || 'this dog';
  const ok = await confirmModal({
    title: `Remove “${dogLabel}” from your program?`,
    message: `This sale is delivered. This can't be undone here — ${dogLabel} leaves your roster and you won't be able to edit it or bring it back. It stays in your dogs' pedigrees and this Sale record for history.`,
    confirmLabel: 'Remove permanently',
    cancelLabel: 'Keep on roster',
    danger: true,
  });
  if (ok) await dogRepo.archive(sale.dog_id);
}

// --- Sale-specific prompt helpers ----------------------------------------
// Opens the shared event modal and resolves once it's saved or dismissed, so the
// post-save sequence can await it before navigating/re-rendering.
function openEventFormAwait(opts) {
  return new Promise((resolve) => {
    openEventForm({ ...opts, onSaved: () => resolve(true), onCancel: () => resolve(false) });
  });
}

// Offer to set the sold dog's disposition (breeder intent). `defaultValue` seeds
// the dropdown (Placed on a new sale; Available when a sale falls through). Skips
// the write when the choice matches what the dog already has.
async function promptDisposition(sale, { title, message, defaultValue }) {
  const dog = await dogRepo.getById(sale.dog_id);
  if (!dog) return;
  // Disposition is a puppy-only field (vocab.js) — never offer to set one on a
  // dog that's moved past the puppy life-stage (e.g. a sale delivered as
  // External flips the dog to external_reference just above this call).
  if (dog.status !== 'puppy') return;
  const choice = await selectModal({
    title, message, label: 'Disposition',
    options: DISPOSITION, defaultValue, confirmLabel: 'Update', cancelLabel: 'Skip'
  });
  if (choice && choice !== dog.disposition) await dogRepo.update(dog.id, { disposition: choice });
}

// The pup of a sale that just ended without it staying placed. Pup died → offer to
// record the death (status Deceased + date). A health reason → disposition prompt
// defaulting to Health hold (not for sale, never offered). Anything else → back to
// Available, as before.
const HEALTH_END_REASONS = ['failed_health_check', 'health_problem'];
async function promptReleasedPup(sale) {
  if (sale.end_reason === 'pup_died') {
    const dog = await dogRepo.getById(sale.dog_id);
    if (!dog || dog.status === 'deceased') return;
    const date = await promptModal({
      title: `Record ${dog.call_name}'s death?`,
      message: `Marks ${dog.call_name} Deceased, so no one is offered this pup again.`,
      label: 'Date of death', type: 'date', defaultValue: todayYMD(), confirmLabel: 'Record', cancelLabel: 'Skip'
    });
    if (date == null) return;
    try {
      await dogRepo.update(dog.id, { status: 'deceased', date_of_death: date });
    } catch (e) {
      showError(`${dog.call_name}'s death wasn't recorded: ${e.message || e} Record it on the dog's page.`);
    }
    return;
  }
  const health = HEALTH_END_REASONS.includes(sale.end_reason);
  if (sale.status === 'returned' && await promptBackAsPuppy(sale, health)) return;
  await promptDisposition(sale, {
    title: 'Update this dog’s disposition?',
    message: health
      ? `This sale is now "${descriptor(SALE_STATUS, sale.status).label}" for a health reason. Health hold keeps the pup from being offered until you change it.`
      : `This sale is now "${descriptor(SALE_STATUS, sale.status).label}" — update the dog's disposition back?`,
    defaultValue: health ? 'health_hold' : 'available'
  });
}

// A returned pup that was marked as gone home (Pet home, or External after the
// delivery prompt) is back with you: offer to make it a puppy again — owned, with a
// disposition (Health hold for a health return) — so it shows in its litter and
// the waitlist sees it right. Skip leaves the dog as it is (e.g. an adult dog
// returned long after). Resolves true when it was handled here.
async function promptBackAsPuppy(sale, health) {
  const dog = await dogRepo.getById(sale.dog_id);
  if (!dog || dog.is_archived || !['pet_home', 'external_reference'].includes(dog.status)) return false;
  const choice = await selectModal({
    title: `${dog.call_name} is back with you`,
    message: `${dog.call_name} is marked ${descriptor(DOG_STATUS, dog.status).label}. Bring ${dog.call_name} back into your program as a puppy?${health ? ' Health hold keeps the pup from being offered until you change it.' : ''}`,
    label: 'Disposition', options: DISPOSITION.filter((o) => o.value !== 'placed'),
    defaultValue: health ? 'health_hold' : 'available', confirmLabel: 'Bring back', cancelLabel: 'Skip'
  });
  if (!choice) return true;
  const changes = { status: 'puppy', disposition: choice };
  if (dog.ownership_type === 'external') Object.assign(changes, { ownership_type: 'owned', owner_contact_id: null });
  try {
    await dogRepo.update(dog.id, changes);
  } catch (e) {
    showError(`${dog.call_name} wasn't updated: ${e.message || e} Change it on the dog's page.`);
  }
  return true;
}

// Guards against a rapid double-tap/double-click firing save() twice before
// the first call's await chain has a chance to disable anything itself —
// each call would otherwise run to completion independently, e.g. creating
// two sales from one "Save" tap.
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
  const candidate = normalizeMoney(readForm());
  const isNew = ctx.mode === 'new';
  const prevStatus = isNew ? null : ctx.original.status;
  if (saleEndReasonsFor(candidate.status).length && !candidate.end_reason) {
    showError(`Choose why the sale was ${descriptor(SALE_STATUS, candidate.status).label.toLowerCase()}.`);
    return;
  }
  try {
    if (isNew) {
      // Kennel scope (Multi-Kennel Scope Spec §6): the sale files under the kennel
      // of the dog being placed, so a kennel-B dog sold while scoped to kennel A
      // still belongs to B.
      candidate.kennel_id = await resolveKennelIdForWrite({
        inheritFrom: ctx.dogsById.get(candidate.dog_id)
      });
    }
    const saved = isNew
      ? await saleRepo.create(candidate)
      : await saleRepo.update(ctx.original.id, candidate);

    // --- Post-save prompt sequence: each awaits the previous, all optional
    // (a Skip never blocks the save that already happened above). ---

    // Co-own placement convenience (Data Model v3 §5.6): pairs naturally with
    // adding the buyer to the dog's co_owner_contact_ids — never automatic.
    if (saved.registration_type === 'co_own') {
      const dog = await dogRepo.getById(saved.dog_id);
      if (dog && !(dog.co_owner_contact_ids || []).includes(saved.buyer_contact_id)) {
        const ok = await confirmModal({
          title: 'Add buyer as a co-owner?',
          message: 'This is a co-own placement. Also add the buyer as a co-owner of this dog?',
          cancelLabel: 'Skip'
        });
        if (ok) await dogRepo.update(dog.id, { co_owner_contact_ids: [...(dog.co_owner_contact_ids || []), saved.buyer_contact_id] });
      }
    }

    // Fires only on the transition INTO delivered. In Pro this offers to mark the
    // sold dog's ownership External/Co-owned (External also flips status to
    // external_reference). Lite has no external ownership, and its dogs leave the
    // program by DEPARTURE (archive) instead (cap spec §5) — so Lite runs the
    // "remove from program" prompt here, which also archives sold puppies.
    if (saved.status === 'delivered' && prevStatus !== 'delivered') {
      if (editionFlags.externalOwnership) await promptOwnershipUpdate(saved);
      else await promptDepartOnDelivery(saved);
    }

    // Any new sale → offer to update the dog's disposition, defaulting to Placed.
    if (isNew) {
      await promptDisposition(saved, {
        title: 'Update this dog’s disposition?',
        message: 'A sale was just recorded for this dog.',
        defaultValue: 'placed'
      });
    }

    // Editing a sale into Returned/Cancelled/Voided → settle the pup first (record
    // its death, or set its disposition back — Available, or Health hold for a
    // health reason), then, for a waitlist family's lost pup, offer to put them back
    // in line (Waitlist Spec §16.11). The pup goes first so a dead or held pup is
    // never offered to anyone.
    if (!isNew && RELEASED_SALE_STATUSES.includes(saved.status) && prevStatus !== saved.status) {
      await promptReleasedPup(saved);
      if (editionFlags.waitlist && restoresFamily(saved)) {
        const { restoreLostPupDialog } = await import('../assets/waitlistUI.js');
        await restoreLostPupDialog({ saleId: saved.id, asStatus: prevStatus });
      }
    }

    // All three deferred-pickup fields set → offer to schedule a boarding event.
    const hasDeferred = saved.deferred_boarding_amount != null && saved.deferred_boarding_amount !== ''
      && !!saved.deferred_boarding_frequency && !!saved.deferred_boarding_duration_days;
    if (hasDeferred) {
      const ok = await confirmModal({
        title: 'Schedule a boarding event?',
        message: 'This sale has a deferred pickup boarding rate. Schedule a boarding event for it?',
        cancelLabel: 'Skip'
      });
      if (ok) {
        await openEventFormAwait({
          subjectType: 'dog', subjectId: saved.dog_id,
          prefill: { event_type: 'boarding', title: 'Deferred pickup boarding' }
        });
      }
    }

    // Soft-suggestion prompt (Stage4.5 Addendum §D4) — only on the transition
    // INTO a prompt-worthy status, so re-saving an already-delivered sale
    // doesn't re-nag.
    if (PLACEMENT_PROMPT_STATUSES.includes(saved.status) && prevStatus !== saved.status) {
      const ok = await confirmModal({
        title: 'Log a scheduled pickup for this placement?',
        confirmLabel: 'Log', cancelLabel: 'Skip'
      });
      if (ok) {
        await openEventFormAwait({
          subjectType: 'dog', subjectId: saved.dog_id,
          prefill: { event_type: 'placement', related_contact_id: saved.buyer_contact_id, title: 'Puppy pickup' }
        });
      }
    }

    // Finish: navigate (new) or re-render in place (edit).
    if (isNew) { location.href = `sale.html?id=${encodeURIComponent(saved.id)}`; return; }
    ctx.original = saved;
    ctx.mode = 'view';
    await loadRefs();
    ctx.original = await saleRepo.getById(saved.id);
    renderAll();
  } catch (e) {
    showError(e.message || String(e));
  }
}

async function toggleArchive() {
  const s = ctx.original;
  const verb = s.is_archived ? 'Unarchive' : 'Archive';
  const ok = await confirmModal({ title: `${verb} this sale?`, confirmLabel: verb, cancelLabel: 'Cancel' });
  if (!ok) return;
  ctx.original = s.is_archived ? await saleRepo.unarchive(s.id) : await saleRepo.archive(s.id);
  renderAll();
}

async function doDelete() {
  const s = ctx.original;
  const ok = await confirmModal({
    title: 'Delete this sale?',
    message: 'Permanently delete this sale? This cannot be undone.',
    confirmLabel: 'Delete', cancelLabel: 'Cancel', danger: true
  });
  if (!ok) return;
  try {
    await saleRepo.hardDelete(s.id);
    location.href = 'sales.html';
  } catch (e) {
    if (e instanceof ReferenceBlockedError) { showError(e.message); await renderHeaderActions(); }
    else showError(e.message || String(e));
  }
}

// --- Contracts panel (derived) --------------------------------------------
async function renderContractsSection() {
  if (!els.contracts) return;
  if (!editionFlags.contracts) { els.contracts.innerHTML = ''; return; } // Pro-only in Lite
  if (ctx.mode !== 'view' || !ctx.original) { els.contracts.innerHTML = ''; return; }
  const contracts = await contractRepo.getBySale(ctx.original.id);
  contracts.sort((a, b) => (b.signed_date || b.created_at || '').localeCompare(a.signed_date || a.created_at || ''));

  // Derived governing-contract line (Stage4.5 Addendum §A2) — proves invariant
  // #8 (the "live contract" is derived, never a stored flag) by exercising
  // contractRepo.governingContract() somewhere real, not just leaving it unused.
  const governing = contractRepo.governingContract(contracts);
  const governingHtml = governing
    ? `Governing contract: <a href="contract.html?id=${encodeURIComponent(governing.id)}">signed ${esc(fmtDate(governing.signed_date || governing.created_at))}</a>`
    : 'Governing contract: none signed yet';

  const inner = contracts.length
    ? `<ul class="linked-list" style="margin:14px 0 0; padding:0; list-style:none;">` + contracts.map((c) => `
        <li class="row-between" style="padding:8px 0; border-top:1px solid var(--border);">
          <span>${badge(CONTRACT_TYPE, c.contract_type)} <strong>${esc(c.title || 'Contract')}</strong> ${badge(CONTRACT_STATUS, c.status)}${c.signed_date ? ` <span class="faint">signed ${esc(fmtDate(c.signed_date))}</span>` : ''}</span>
          <a class="btn btn-sm" href="contract.html?id=${encodeURIComponent(c.id)}">Open →</a>
        </li>`).join('') + `</ul>`
    : `<p class="muted" style="margin:14px 0 0;">No contracts attached to this sale yet.</p>`;

  els.contracts.innerHTML = `
    <section class="card" style="margin-top:16px;">
      <div class="row-between">
        <div>
          <h2 style="margin:0;">Contracts</h2>
          <p class="muted" style="margin:4px 0 0; font-size:13px;">${governingHtml}</p>
        </div>
        <a class="btn btn-sm" href="contract.html?new=1&sale=${encodeURIComponent(ctx.original.id)}">+ Create Contract</a>
      </div>
      ${inner}
    </section>`;
}

// --- Top-level render ------------------------------------------------------
function renderTitle() {
  if (ctx.mode === 'new') {
    els.title.textContent = 'New Sale';
    els.subtitle.textContent = 'Choose a dog and buyer, then save.';
    return;
  }
  const s = ctx.original;
  els.title.innerHTML = `${esc(dogName(s.dog_id) || '—')} → ${esc(contactName(s.buyer_contact_id) || '—')}` + (s.is_archived ? ' <span class="badge badge-gray">Archived</span>' : '');
  els.subtitle.innerHTML = s.sale_date ? `Sale date ${esc(fmtDate(s.sale_date))}` : '';
}

function renderAll() {
  renderTitle();
  renderProfileActions();
  renderHeaderActions();
  if (ctx.mode === 'view') renderView();
  else renderEdit();
  renderContractsSection();
}

async function main() {
  await loadRefs();
  const id = param('id');
  const isNew = param('new');

  if (isNew) {
    ctx.mode = 'new';
    ctx.draft = blankSale();
    const dogId = param('dog');
    if (dogId && ctx.dogsById.has(dogId)) {
      ctx.draft.dog_id = dogId;
      applyExpectedPricing();
    }
    renderTitle();
    renderEdit();
    renderProfileActions();
    renderHeaderActions();
    return;
  }

  if (!id) { showError('No sale id provided.'); return; }
  const s = await saleRepo.getById(id);
  if (!s) { showError('Sale not found. It may have been deleted.'); return; }
  ctx.original = s;
  ctx.mode = 'view';
  // Out-of-scope banner (Multi-Kennel Scope Spec §7). A detail page reached by id
  // is deliberately NEVER scope-filtered — a direct link, a bookmark, or a click
  // through from a pedigree must always resolve — so an sale belonging to another
  // kennel renders in full, with this above it saying whose it is and offering a
  // one-click switch. Renders nothing in the ordinary in-scope case.
  renderScopeNotice(document.getElementById('scope-notice'), s, { kind: 'sale' });
  renderAll();
}

main();
