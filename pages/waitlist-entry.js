// waitlist-entry.js — one family's run through a kennel's waitlist (Waitlist Spec
// §5–§6; End-State guide §29). New application entry (?new=1&kennel=…), the
// status card with the step-by-step actions (approve / decline / fee received /
// withdraw / remove / undo / move / re-apply), the edit-in-place details card
// (preferences incl. breed, listen-only, pause, fee, application answers), and the
// offers (offer a litter from here, record how an offer ended — the waitlist as
// the main workflow, Spec §15.2), and the family's documents (fee receipt, Sale
// invoice/receipt, each viewable or downloadable as a PDF). Application answers
// follow her own form (Spec §15.1, data/waitlistForm.js). Every multi-step write
// goes through data/waitlistActions.js. Pro-only page (proPages.js).
import { waitlistEntryRepo, ReferenceBlockedError } from '../data/waitlistEntryRepo.js';
import { waitlistOfferRepo } from '../data/waitlistOfferRepo.js';
import { waitlistProgramRepo } from '../data/waitlistProgramRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { pairingRepo } from '../data/pairingRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import * as actions from '../data/waitlistActions.js';
import {
  waitlistConfig, overallPositions, passesUsed, anchorDate, isMovedByBreeder, contactMatches,
  entryName, canUndoRemoval, isPaused, rankedList, REMOVAL_UNDO_DAYS,
  eligiblePupsFor, nextFamilyForLitter, turnSpent, hasOpenOffer, isListeningFor, isPupAvailable
} from '../data/waitlistRules.js';
import {
  formQuestions, entryQuestions, snapshotQuestions, answerText, isAnswerQuestion, missingRequired
} from '../data/waitlistForm.js';
import {
  WAITLIST_ENTRY_STATUS, WAITLIST_PREF_SEX, WAITLIST_LISTEN_MODE, WAITLIST_OFFER_OUTCOME,
  WAITLIST_REMOVED_REASON, PLACEMENT_TYPE, FEE_CREDIT_POLICY, PAYMENT_METHODS, SEX, descriptor
} from '../data/vocab.js';
import { addDaysToYMD } from '../data/dateUtils.js';
import { esc, badge, fmtDate, fmtMoney, param, todayYMD, confirmModal, alertModal } from '../assets/ui.js';
import { resolveWaitlistKennel, prefsSummary, entryFlags, formModal } from '../assets/waitlistUI.js';

const els = {
  title: document.getElementById('entry-title'),
  subtitle: document.getElementById('entry-subtitle'),
  back: document.getElementById('back-link'),
  headerActions: document.getElementById('header-actions'),
  status: document.getElementById('status-section'),
  profileActions: document.getElementById('profile-actions'),
  body: document.getElementById('profile-body'),
  offers: document.getElementById('offers-section'),
  docs: document.getElementById('docs-section'),
  error: document.getElementById('page-error')
};

const LIVE_PAIRING = ['planned', 'bred', 'confirmed_pregnant'];
const LIVE_LITTER = ['expected', 'whelped', 'weaning', 'ready'];

const ctx = {
  mode: 'view', entry: null, draft: null, kennel: null, config: null,
  contact: null, contacts: [], programs: new Map(), kennelEntries: [], offers: [],
  litters: [], pairings: [], dogsById: new Map(), breeds: [], form: [], kennelOffers: [], sales: []
};

const none = '<span class="faint">—</span>';
const showError = (msg) => { els.error.innerHTML = `<div class="inline-error">${esc(msg)}</div>`; };
const clearError = () => { els.error.innerHTML = ''; };
const row = (label, html) => (html ? `<dt>${esc(label)}</dt><dd>${html}</dd>` : '');
const multiline = (s) => (s ? esc(s).replace(/\n/g, '<br>') : '');
const dogName = (id) => ctx.dogsById.get(id)?.call_name || '—';
const litterLabel = (l) => l.nickname || `${dogName(l.dam_id)} × ${dogName(l.sire_id)}`;
const pairingLabel = (p) => `${dogName(p.dam_id)} × ${dogName(p.sire_id)}`;
const options = (vocab, current, blankLabel) =>
  (blankLabel != null ? `<option value="">${esc(blankLabel)}</option>` : '') +
  vocab.map((o) => `<option value="${esc(o.value)}"${o.value === current ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
const programOptions = (current) => `<option value="">— none —</option>` + [...ctx.programs.values()]
  .filter((p) => !p.is_archived || p.id === current)
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((p) => `<option value="${esc(p.id)}"${p.id === current ? ' selected' : ''}>${esc(p.name)}${p.is_archived ? ' (archived)' : ''}</option>`).join('');

// --- Loading ------------------------------------------------------------------

async function loadKennelContext(kennelId) {
  const [kennel, programs, kennelEntries, contacts, litters, pairings, dogs, breeds, kennelOffers, sales] = await Promise.all([
    kennelRepo.getById(kennelId),
    waitlistProgramRepo.getMapForKennel(kennelId),
    waitlistEntryRepo.getByKennel(kennelId),
    contactRepo.getAll({ includeArchived: true }),
    litterRepo.getAll({ includeArchived: true }),
    pairingRepo.getAll({ includeArchived: true }),
    dogRepo.getAll({ includeArchived: true }),
    kennelRepo.getBreedVocabulary(),
    waitlistOfferRepo.getByKennel(kennelId),
    saleRepo.getAll({ includeArchived: true })
  ]);
  Object.assign(ctx, {
    kennel, config: waitlistConfig(kennel), form: formQuestions(waitlistConfig(kennel)), programs, kennelEntries, contacts,
    litters: litters.filter((l) => l.kennel_id === kennelId),
    pairings: pairings.filter((p) => p.kennel_id === kennelId),
    dogsById: new Map(dogs.map((d) => [d.id, d])),
    breeds, kennelOffers, sales
  });
}

async function reload() {
  ctx.entry = await waitlistEntryRepo.getById(ctx.entry.id);
  await loadKennelContext(ctx.entry.kennel_id);
  ctx.contact = ctx.contacts.find((c) => c.id === ctx.entry.contact_id) || null;
  ctx.offers = await waitlistOfferRepo.getByEntry(ctx.entry.id);
}

// --- Status card + actions --------------------------------------------------------

function statusLines(e) {
  const today = todayYMD();
  const lines = [];
  if (e.status === 'applied') {
    lines.push(`Applied ${e.applied_date ? esc(fmtDate(e.applied_date)) : ''}. Waiting for your review.`);
  } else if (e.status === 'approved') {
    const fee = e.fee_amount != null ? esc(fmtMoney(e.fee_amount)) : 'no fee set';
    lines.push(`Approved ${esc(fmtDate(e.approved_date))}. Fee due: <strong>${fee}</strong>${e.fee_due_date ? ` by ${esc(fmtDate(e.fee_due_date))}` : ''}.`);
    if (e.fee_due_date && e.fee_due_date < today) lines.push('<span class="badge badge-red">The pay-by date has passed</span>');
    if (ctx.config.payment_instructions) lines.push(`<span class="faint">Your payment instructions: ${esc(ctx.config.payment_instructions)}</span>`);
  } else if (e.status === 'active') {
    const pos = overallPositions(ctx.kennelEntries, ctx.kennel.id, ctx.programs).get(e.id);
    const total = rankedList(ctx.kennelEntries, ctx.kennel.id, ctx.programs).length;
    lines.push(`<strong style="font-size:1.3em;">#${esc(pos)}</strong> of ${esc(total)} on the list.`);
    lines.push(`In line since ${esc(fmtDate(anchorDate(e)))}${isMovedByBreeder(e) ? ` <span class="badge badge-purple">Moved by you</span> <span class="faint">(fee received ${esc(fmtDate(e.fee_received_date))})</span>` : ''}.`);
    lines.push(`Passes used: ${passesUsed(e, ctx.offers)} of ${esc(ctx.config.max_passes)}.`);
    const flags = entryFlags(e, today);
    if (flags) lines.push(flags + (isPaused(e, today) ? ' <span class="faint">Paused families keep their place; they just aren\'t offered pups.</span>' : ' <span class="faint">Only offered the litters they chose; they keep their place.</span>'));
  } else if (e.status === 'removed') {
    lines.push(`Removed ${esc(fmtDate(e.removed_date))}${e.removed_reason ? ` — ${esc(descriptor(WAITLIST_REMOVED_REASON, e.removed_reason).label.toLowerCase())}` : ''}.`);
    if (canUndoRemoval(e, today)) lines.push(`<span class="badge badge-amber">You can undo this until ${esc(fmtDate(addDaysToYMD(e.removed_date, REMOVAL_UNDO_DAYS)))}</span>`);
  } else if (e.status === 'placed') {
    lines.push(e.placed_sale_id ? `Placed — <a href="sale.html?id=${encodeURIComponent(e.placed_sale_id)}">open the sale →</a>` : 'Placed.');
  } else if (e.status === 'withdrawn') {
    lines.push(`Withdrew${e.withdrawn_date ? ` ${esc(fmtDate(e.withdrawn_date))}` : ''}.`);
  } else if (e.status === 'declined') {
    lines.push(`Declined${e.declined_date ? ` ${esc(fmtDate(e.declined_date))}` : ''}.`);
  } else if (e.status === 'expired') {
    lines.push('The fee wasn\'t received by the pay-by date.');
  }
  return lines;
}

function actionButtons(e) {
  const b = (act, label, cls = '') => `<button class="btn btn-sm ${cls}" data-act="${act}">${esc(label)}</button>`;
  switch (e.status) {
    case 'applied': return b('approve', 'Approve…', 'btn-primary') + b('decline', 'Decline') + b('withdraw', 'Withdrew');
    case 'approved': {
      const label = e.fee_amount == null ? 'Add to the list…' : 'Fee received…';
      return b('fee', label, 'btn-primary') + b('expire', 'Fee not received') + b('withdraw', 'Withdrew');
    }
    case 'active': return b('offer', 'Offer a litter…', 'btn-primary') + b('move', 'Move place…') + b('withdraw', 'Withdrew') + b('remove', 'Remove from list', 'btn-danger');
    case 'removed': return (canUndoRemoval(e, todayYMD()) ? b('undo', 'Undo removal', 'btn-primary') : '') + b('reapply', 'Re-apply');
    default: return b('reapply', 'Re-apply');
  }
}

function renderStatus() {
  const e = ctx.entry;
  els.status.innerHTML = `
    <div class="row-between" style="align-items:flex-start;gap:12px;flex-wrap:wrap;">
      <div>
        <h2 style="margin:0 0 6px;">${badge(WAITLIST_ENTRY_STATUS, e.status)}</h2>
        ${statusLines(e).map((l) => `<p style="margin:4px 0;">${l}</p>`).join('')}
      </div>
      <div class="pill-row">${actionButtons(e)}</div>
    </div>`;
  const handlers = { offer: onOfferLitter, approve: onApprove, decline: onDecline, withdraw: onWithdraw, fee: onFeeReceived, expire: onExpire, move: onMove, remove: onRemove, undo: onUndo, reapply: onReapply };
  els.status.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => handlers[btn.dataset.act]().catch((err) => showError(err.message || String(err))));
  });
}

async function afterAction() {
  clearError();
  await reload();
  renderAll();
}

async function onApprove() {
  const e = ctx.entry;
  const matches = e.contact_id ? [] : contactMatches(e.application || {}, ctx.contacts);
  const contactChoices = e.contact_id
    ? `<p class="muted">Linked to <strong>${esc(ctx.contact?.name || '')}</strong>.</p>`
    : `<div class="field field-wide"><label>Contact</label>
        ${matches.map((m, i) => `<label class="check-inline" style="display:block;"><input type="radio" name="ap-contact" value="${esc(m.contact.id)}"${i === 0 && m.reason === 'email' ? ' checked' : ''}> Use existing: <strong>${esc(m.contact.name)}</strong> <span class="faint">(${m.reason === 'email' ? 'same email' : 'same name'}${m.contact.email ? `, ${esc(m.contact.email)}` : ''})</span></label>`).join('')}
        <label class="check-inline" style="display:block;"><input type="radio" name="ap-contact" value=""${matches.length && matches[0].reason === 'email' ? '' : ' checked'}> Create a new contact for ${esc(entryName(e, null))}</label>
        ${matches.length ? '<span class="field-hint">A match is only a suggestion. Pick it if it\'s the same family.</span>' : ''}
      </div>`;
  await formModal({
    title: `Approve ${entryName(e, ctx.contact)}?`,
    confirmLabel: 'Approve',
    bodyHtml: `<div class="form-grid">
        <div class="field"><label>Approval date</label><input id="ap-date" type="date" value="${esc(todayYMD())}"></div>
        <div class="field"><label>Program</label><select id="ap-program">${programOptions(e.waitlist_program_id)}</select></div>
        ${contactChoices}
      </div>
      <p class="field-hint">A program that waives the fee puts them straight on the list. Otherwise they owe ${esc(fmtMoney(ctx.config.fee_amount) || 'the fee')} and join the list when you mark it received. Nothing is sent to the family; let them know yourself.</p>`,
    onConfirm: async (o) => {
      const picked = o.querySelector('input[name="ap-contact"]:checked');
      await actions.approve(e.id, {
        date: o.querySelector('#ap-date').value || todayYMD(),
        programId: o.querySelector('#ap-program').value || null,
        contactId: picked ? picked.value || null : null
      });
    }
  }) && afterAction();
}

async function onDecline() {
  const name = entryName(ctx.entry, ctx.contact);
  if (!(await confirmModal({ title: `Decline ${name}?`, message: 'The application closes. No contact is created.', confirmLabel: 'Decline', danger: true }))) return;
  await actions.decline(ctx.entry.id);
  await afterAction();
}

async function onWithdraw() {
  const name = entryName(ctx.entry, ctx.contact);
  if (!(await confirmModal({ title: `${name} left the list?`, message: 'Record that the family withdrew. Coming back means a new application, a new fee and a new place.', confirmLabel: 'They withdrew' }))) return;
  await actions.withdraw(ctx.entry.id);
  await afterAction();
}

async function onExpire() {
  const name = entryName(ctx.entry, ctx.contact);
  if (!(await confirmModal({ title: `Close ${name}'s application?`, message: 'Their fee wasn\'t received in time. They can re-apply later.', confirmLabel: 'Close it' }))) return;
  await actions.markFeeExpired(ctx.entry.id);
  await afterAction();
}

async function onRemove() {
  const name = entryName(ctx.entry, ctx.contact);
  if (!(await confirmModal({ title: `Remove ${name} from the list?`, message: 'This is final. To come back they would re-apply, with a new fee and a new place.', confirmLabel: 'Remove', danger: true }))) return;
  await actions.removeByBreeder(ctx.entry.id);
  await afterAction();
}

async function onUndo() {
  await actions.undoRemoval(ctx.entry.id);
  await afterAction();
}

async function onReapply() {
  const created = await actions.reapply(ctx.entry.id);
  location.href = `waitlist-entry.html?id=${encodeURIComponent(created.id)}`;
}

async function onFeeReceived() {
  const e = ctx.entry;
  const noFee = e.fee_amount == null;
  const methodOpts = `<option value="">—</option>` + PAYMENT_METHODS.map((m) => `<option>${esc(m)}</option>`).join('');
  await formModal({
    title: noFee ? `Add ${entryName(e, ctx.contact)} to the list?` : 'Fee received',
    confirmLabel: noFee ? 'Add to the list' : 'Fee received',
    bodyHtml: `<div class="form-grid">
        <div class="field"><label>${noFee ? 'Date' : 'Date received'}</label><input id="fr-date" type="date" value="${esc(todayYMD())}"></div>
        ${noFee ? '' : `
        <div class="field"><label>Amount</label><input id="fr-amount" type="number" min="0" step="0.01" value="${esc(e.fee_amount)}"></div>
        <div class="field"><label>Method</label><select id="fr-method">${methodOpts}</select></div>
        <div class="field"><label>Reference</label><input id="fr-ref" type="text"></div>`}
      </div>
      <p class="field-hint">This date sets their place in line.</p>`,
    onConfirm: async (o) => {
      await actions.feeReceived(e.id, noFee
        ? { date: o.querySelector('#fr-date').value || todayYMD() }
        : {
            date: o.querySelector('#fr-date').value || todayYMD(),
            amount: o.querySelector('#fr-amount').value,
            method: o.querySelector('#fr-method').value,
            reference: o.querySelector('#fr-ref').value.trim()
          });
    }
  }) && afterAction();
}

async function onMove() {
  const e = ctx.entry;
  const others = rankedList(ctx.kennelEntries, ctx.kennel.id, ctx.programs).filter((x) => x.id !== e.id);
  const contactsById = new Map(ctx.contacts.map((c) => [c.id, c]));
  const positions = overallPositions(ctx.kennelEntries, ctx.kennel.id, ctx.programs);
  const otherOpts = others.map((x) => `<option value="${esc(x.id)}">#${esc(positions.get(x.id))} ${esc(entryName(x, contactsById.get(x.contact_id)))}</option>`).join('');
  await formModal({
    title: 'Move their place',
    confirmLabel: 'Move',
    bodyHtml: `
      <label class="check-inline" style="display:block;"><input type="radio" name="mv" value="date" checked> Place them as if they paid on
        <input id="mv-date" type="date" value="${esc(e.position_anchor_date || anchorDate(e))}"></label>
      ${others.length ? `<label class="check-inline" style="display:block;margin-top:8px;"><input type="radio" name="mv" value="after"> Place them with <select id="mv-after">${otherOpts}</select></label>
      <p class="field-hint">Places are kept by date, so this gives them that family's date. Families on the same date are ordered by approval date, so they may land just before or after.</p>` : ''}
      ${e.position_anchor_date ? '<label class="check-inline" style="display:block;margin-top:8px;"><input type="radio" name="mv" value="clear"> Undo the move (back to their fee date)</label>' : ''}
      <p class="field-hint">Programs that put families ahead still come first. The real fee date is kept.</p>`,
    onConfirm: async (o) => {
      const how = o.querySelector('input[name="mv"]:checked').value;
      if (how === 'clear') await actions.setPositionAnchor(e.id, { date: null });
      else if (how === 'after') await actions.setPositionAnchor(e.id, { afterEntryId: o.querySelector('#mv-after').value });
      else {
        const date = o.querySelector('#mv-date').value;
        if (!date) throw new Error('Pick a date.');
        await actions.setPositionAnchor(e.id, { date });
      }
    }
  }) && afterAction();
}

// --- Details: view ----------------------------------------------------------------

function listenSummary(e) {
  if ((e.listen_mode || 'all') !== 'selected') return 'All litters';
  const litters = (e.listen_litter_ids || []).map((id) => ctx.litters.find((l) => l.id === id)).filter(Boolean).map(litterLabel);
  const pairings = (e.listen_pairing_ids || []).map((id) => ctx.pairings.find((p) => p.id === id)).filter(Boolean).map((p) => `${pairingLabel(p)} (pairing)`);
  const all = [...pairings, ...litters];
  return `Only: ${all.length ? all.join(', ') : 'nothing chosen yet'}`;
}

function renderView() {
  const e = ctx.entry;
  const app = e.application || {};
  const program = ctx.programs.get(e.waitlist_program_id);
  const contactHtml = ctx.contact
    ? `<a href="contact.html?id=${encodeURIComponent(ctx.contact.id)}">${esc(ctx.contact.name)}</a>${ctx.contact.email ? ` <span class="faint">${esc(ctx.contact.email)}</span>` : ''}`
    : '<span class="faint">Not linked yet — approving links or creates one</span>';
  els.body.innerHTML = `
    <dl class="dl-meta" style="margin-top:14px;">
      ${row('Contact', contactHtml)}
      ${row('Program', program ? esc(program.name) + (program.is_archived ? ' <span class="badge badge-gray">archived</span>' : '') : '')}
      ${row('Wants', prefsSummary(e))}
      ${row('Listening for', esc(listenSummary(e)))}
      ${row('Paused until', e.paused_until ? esc(fmtDate(e.paused_until)) + (e.pause_reason ? ` <span class="faint">— ${esc(e.pause_reason)}</span>` : '') : '')}
      ${row('Fee', e.fee_amount != null ? esc(fmtMoney(e.fee_amount)) : '')}
      ${row('Fee policy', e.fee_credit_policy ? esc(descriptor(FEE_CREDIT_POLICY, e.fee_credit_policy).label) : '')}
      ${row('Fee received', e.fee_received_date ? esc(fmtDate(e.fee_received_date)) + [e.fee_payment_method, e.fee_payment_reference].filter(Boolean).map((s) => ` <span class="faint">${esc(s)}</span>`).join('') : '')}
      ${row('Pay by', e.fee_due_date ? esc(fmtDate(e.fee_due_date)) : '')}
      ${row('Notes', multiline(e.notes))}
    </dl>
    <h3 style="margin:18px 0 6px;">Application</h3>
    <dl class="dl-meta">
      ${row('Applied', e.applied_date ? esc(fmtDate(e.applied_date)) : '')}
      ${entryQuestions(e, ctx.form).map((q) => row(q.label, multiline(answerText(q, app[q.id])))).join('')}
    </dl>`;
}

// --- Details: edit / new ------------------------------------------------------------

function checkList(items, selected, attr) {
  if (!items.length) return '<span class="faint">None yet.</span>';
  return items.map(({ id, label }) => `<label class="check-inline"><input type="checkbox" ${attr}="${esc(id)}"${selected.includes(id) ? ' checked' : ''}> ${esc(label)}</label>`).join('');
}

// One application answer as a form field, by her question's answer type (Spec
// §15.1). Fields carry data-answer="<question id>" so readForm never depends on
// element ids built from her question ids.
function answerField(q, value) {
  const req = q.key === 'name' ? ' <span class="req">*</span>' : '';
  const help = q.help ? `<span class="field-hint">${esc(q.help)}</span>` : '';
  const attr = `data-answer="${esc(q.id)}" aria-label="${esc(q.label)}"`;
  const v = value ?? '';
  let input;
  let wide = false;
  if (q.type === 'long_text') {
    input = `<textarea ${attr}>${esc(v)}</textarea>`;
    wide = true;
  } else if (q.type === 'single_choice') {
    const opts = [...(q.options || [])];
    if (v && !opts.includes(v)) opts.push(v);
    input = `<select ${attr}><option value="">—</option>${opts.map((o) => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  } else if (q.type === 'checkboxes') {
    const picked = Array.isArray(v) ? v : String(v).split(',').map((x) => x.trim()).filter(Boolean);
    const opts = [...(q.options || [])];
    for (const x of picked) if (!opts.includes(x)) opts.push(x);
    input = `<div class="check-group">${opts.map((o) => `<label class="check-inline"><input type="checkbox" data-answer-cb="${esc(q.id)}" value="${esc(o)}"${picked.includes(o) ? ' checked' : ''}> ${esc(o)}</label>`).join('') || '<span class="faint">No options yet.</span>'}</div>`;
    wide = true;
  } else if (q.type === 'yes_no') {
    const cur = answerText(q, v);
    input = `<select ${attr}><option value="">—</option><option value="yes"${cur === 'Yes' ? ' selected' : ''}>Yes</option><option value="no"${cur === 'No' ? ' selected' : ''}>No</option></select>`;
  } else {
    const type = { number: 'number', date: 'date', email: 'email' }[q.type] || 'text';
    input = `<input ${attr} type="${type}" value="${esc(v)}">`;
  }
  return `<div class="field${wide ? ' field-wide' : ''}"><label>${esc(q.label)}${req}</label>${input}${help}</div>`;
}

// The four preference fields. Their answers live on the entry's pref_* fields, so
// they keep fixed element ids; `label` is her wording on the new-application form.
function prefField(key, e, label) {
  const breedList = ctx.breeds.map((b) => `<option value="${esc(b)}"></option>`).join('');
  switch (key) {
    case 'pref_sex':
      return `<div class="field"><label>${esc(label || 'Sex')}</label><select id="f-pref_sex">${options(WAITLIST_PREF_SEX, e.pref_sex || 'any')}</select></div>`;
    case 'pref_breed':
      return `<div class="field"><label>${esc(label || 'Breed')}</label><input id="f-pref_breed" type="text" list="breed-list" value="${esc(e.pref_breed || '')}" placeholder="Any breed"><datalist id="breed-list">${breedList}</datalist>
        <span class="field-hint">Only pups of this breed are offered to them. Leave blank for any.</span></div>`;
    case 'pref_placement':
      return `<div class="field"><label>${esc(label || 'Placement')}</label><select id="f-pref_placement_type">${options(PLACEMENT_TYPE, e.pref_placement_type || '', 'Any')}</select></div>`;
    case 'pref_colors':
      return `<div class="field"><label>${esc(label || 'Colors')}</label><input id="f-pref_colors" type="text" value="${esc((e.pref_colors || []).join(', '))}" placeholder="e.g. brindle, seal">
        <span class="field-hint">${ctx.config.color_matching ? 'Color matching is on: only pups with one of these colors are offered.' : 'Notes only. Color matching is off in your waitlist settings.'}</span></div>`;
    default: return '';
  }
}

// The questions a draft's answers are read from: her form for a new application,
// else the entry's own questions (its saved wording plus anything added since).
const draftQuestions = () => (ctx.mode === 'new' ? ctx.form.filter(isAnswerQuestion) : entryQuestions(ctx.draft, ctx.form));

function renderEdit() {
  const e = ctx.draft;
  const app = e.application || {};
  const selPairings = e.listen_pairing_ids || [];
  const selLitters = e.listen_litter_ids || [];
  // Upcoming pairings and live litters, plus anything already chosen (so a closed
  // litter a family picked never silently drops off their list).
  const pairings = ctx.pairings.filter((p) => (LIVE_PAIRING.includes(p.status) && !p.is_archived) || selPairings.includes(p.id))
    .map((p) => ({ id: p.id, label: pairingLabel(p) }));
  const litters = ctx.litters.filter((l) => (LIVE_LITTER.includes(l.status) && !l.is_archived) || selLitters.includes(l.id))
    .map((l) => ({ id: l.id, label: litterLabel(l) }));
  const isNew = ctx.mode === 'new';
  const programField = `<div class="field"><label>Program</label><select id="f-program">${programOptions(e.waitlist_program_id)}</select>
    <span class="field-hint">Only you assign programs. Families never pick one.</span></div>`;

  // A new application follows her form, in her order and wording, so typing one in
  // matches what families will see online. The public-list notice is shown so she
  // can tell the family.
  const newForm = () => ctx.form.map((q) => {
    if (q.type === 'preference') return prefField(q.key, e, q.label);
    if (q.type === 'notice') {
      return `<div class="field field-wide"><div class="card" style="margin:0;padding:10px 12px;background:var(--surface-2, transparent);">
        <strong>${esc(q.label)}</strong><p style="margin:6px 0 0;white-space:pre-line;">${esc(q.help)}</p>
        <span class="field-hint">Every applicant is told this. Make sure this family has heard it.</span></div></div>`;
    }
    return answerField(q, app[q.id]);
  }).join('');

  els.body.innerHTML = isNew ? `
    <div class="form-grid" style="margin-top:14px;">
      ${newForm()}
      <div class="field field-wide"><h3 style="margin:8px 0 0;">For you</h3></div>
      ${programField}
      <div class="field"><label>Applied</label><input id="f-applied_date" type="date" value="${esc(e.applied_date || todayYMD())}"></div>
      <div class="field field-wide"><label>Your notes</label><textarea id="f-notes">${esc(e.notes || '')}</textarea></div>
      <div class="field field-wide"><span class="field-hint">Change these questions on the <a href="waitlist-form.html?kennel=${encodeURIComponent(ctx.kennel.id)}">Application form</a> page.</span></div>
    </div>` : `
    <div class="form-grid" style="margin-top:14px;">
      <div class="field field-wide"><h3 style="margin:0;">Preferences</h3></div>
      ${['pref_sex', 'pref_breed', 'pref_placement', 'pref_colors'].map((k) => prefField(k, e)).join('')}
      ${programField}

      <div class="field field-wide"><h3 style="margin:8px 0 0;">Which litters</h3></div>
      <div class="field"><label>Listening for</label><select id="f-listen_mode">${options(WAITLIST_LISTEN_MODE, e.listen_mode || 'all')}</select>
        <span class="field-hint">Listen-only families aren't offered other litters. That never costs them their place or counts as a pass.</span></div>
      <div class="field field-wide" id="listen-picks"${(e.listen_mode || 'all') === 'selected' ? '' : ' hidden'}>
        <label>Pairings</label><div class="check-group">${checkList(pairings, selPairings, 'data-pairing')}</div>
        <label style="margin-top:8px;">Litters</label><div class="check-group">${checkList(litters, selLitters, 'data-litter')}</div>
      </div>
      <div class="field"><label>Paused until</label><input id="f-paused_until" type="date" value="${esc(e.paused_until || '')}">
        <span class="field-hint">Not offered pups until after this date. They keep their place, but don't appear on the public list while paused.</span></div>
      <div class="field"><label>Pause reason</label><input id="f-pause_reason" type="text" value="${esc(e.pause_reason || '')}"></div>

      <div class="field field-wide"><h3 style="margin:8px 0 0;">Fee</h3></div>
      <div class="field"><label>Fee amount</label><input id="f-fee_amount" type="number" min="0" step="0.01" value="${esc(e.fee_amount ?? '')}"></div>
      <div class="field"><label>Pay by</label><input id="f-fee_due_date" type="date" value="${esc(e.fee_due_date || '')}"></div>
      <div class="field"><label>Fee policy</label><select id="f-fee_credit_policy">${options(FEE_CREDIT_POLICY, e.fee_credit_policy || '', '—')}</select></div>

      <div class="field field-wide"><h3 style="margin:8px 0 0;">Application</h3>${e.contact_id ? '<span class="field-hint">Name, email and phone are what they applied with. The contact record holds the current ones.</span>' : ''}</div>
      ${draftQuestions().map((q) => answerField(q, app[q.id])).join('')}
      <div class="field field-wide"><label>Your notes</label><textarea id="f-notes">${esc(e.notes || '')}</textarea></div>
    </div>`;

  const modeSel = document.getElementById('f-listen_mode');
  if (modeSel) modeSel.addEventListener('change', () => { document.getElementById('listen-picks').hidden = modeSel.value !== 'selected'; });
}

function readForm() {
  const val = (id) => document.getElementById(id)?.value ?? '';
  const has = (id) => Boolean(document.getElementById(id));
  const application = { ...(ctx.draft.application || {}) };
  const questions = draftQuestions();
  for (const q of questions) {
    if (q.type === 'checkboxes') {
      application[q.id] = [...els.body.querySelectorAll('input[data-answer-cb]')]
        .filter((el) => el.dataset.answerCb === q.id && el.checked).map((el) => el.value);
      continue;
    }
    const el = [...els.body.querySelectorAll('[data-answer]')].find((x) => x.dataset.answer === q.id);
    if (!el) continue;
    application[q.id] = q.type === 'long_text' ? el.value : el.value.trim();
  }
  const out = {
    pref_sex: val('f-pref_sex') || 'any',
    pref_breed: val('f-pref_breed').trim(),
    pref_placement_type: val('f-pref_placement_type') || '',
    pref_colors: val('f-pref_colors').split(',').map((s) => s.trim()).filter(Boolean),
    waitlist_program_id: val('f-program') || null,
    application,
    application_questions: snapshotQuestions(questions),
    notes: val('f-notes')
  };
  if (has('f-applied_date')) out.applied_date = val('f-applied_date') || todayYMD();
  if (has('f-listen_mode')) {
    Object.assign(out, {
      listen_mode: val('f-listen_mode') || 'all',
      listen_pairing_ids: [...document.querySelectorAll('[data-pairing]:checked')].map((el) => el.dataset.pairing),
      listen_litter_ids: [...document.querySelectorAll('[data-litter]:checked')].map((el) => el.dataset.litter),
      paused_until: val('f-paused_until') || null,
      pause_reason: val('f-pause_reason').trim(),
      fee_amount: val('f-fee_amount') === '' ? null : Number(val('f-fee_amount')),
      fee_due_date: val('f-fee_due_date') || null,
      fee_credit_policy: val('f-fee_credit_policy') || null
    });
  }
  const missing = ctx.draft.contact_id ? [] : missingRequired(questions, application);
  if (missing.length) throw new Error(`Please fill in: ${missing.join(', ')}.`);
  return out;
}

// --- Offers: make one from here, record how it ended (Spec §15.2) --------------------

const pupLabel = (d) => `${d.call_name}${d.sex ? ` (${SEX.find((s) => s.value === d.sex)?.label || d.sex})` : ''}`;
const kennelLitterPups = (litter) => [...ctx.dogsById.values()].filter((d) => d.litter_id === litter.id);
const familyNameById = (entryId) => {
  const x = ctx.kennelEntries.find((k) => k.id === entryId);
  return x ? entryName(x, ctx.contacts.find((c) => c.id === x.contact_id)) : 'another family';
};

// Every live litter of this kennel, with whether this family can be offered it now
// and, if not, why. `next` is who the list says is next (null = nobody / an offer
// is open).
function litterChoices(e) {
  const today = todayYMD();
  const opts = { today, config: ctx.config, programsById: ctx.programs };
  return ctx.litters
    .filter((l) => !l.is_archived && LIVE_LITTER.includes(l.status))
    .map((l) => {
      const pups = kennelLitterPups(l);
      const offers = ctx.kennelOffers.filter((o) => o.litter_id === l.id);
      const eligible = eligiblePupsFor(e, l, pups, ctx.sales, opts);
      let blocked = '';
      if (hasOpenOffer(offers, l.id)) {
        const open = offers.find((o) => o.outcome === 'open' && !o.is_archived);
        blocked = open.entry_id === e.id ? 'They already have an open offer on this litter.' : `${familyNameById(open.entry_id)} has an open offer on this litter.`;
      } else if (turnSpent(offers, l.id, e.id)) blocked = 'They\'ve already had their turn on this litter.';
      else if (isPaused(e, today)) blocked = 'They\'re paused.';
      else if (!isListeningFor(e, l)) blocked = 'They\'re listening for other litters only.';
      else if (!pups.some((d) => isPupAvailable(d, ctx.sales))) blocked = 'No pups available yet.';
      else if (!eligible.length) blocked = 'No available pup matches what they want.';
      const next = blocked ? null : nextFamilyForLitter(ctx.kennelEntries, offers, l, pups, ctx.sales, opts);
      return { litter: l, eligible, blocked, next };
    });
}

async function onOfferLitter() {
  const e = ctx.entry;
  const choices = litterChoices(e);
  const offerable = choices.filter((c) => !c.blocked);
  const rowHtml = (c, i) => {
    const l = c.litter;
    const picks = l.picks_opened_date ? 'Picks open' : 'Picks not open yet (offering opens them)';
    const order = c.blocked ? '' : (!c.next || c.next.entry.id === e.id
      ? '<span class="badge badge-green">They\'re next</span>'
      : `<span class="badge badge-amber">Next in line is ${esc(familyNameById(c.next.entry.id))}</span>`);
    return `<label class="check-inline" style="display:block;margin:8px 0;${c.blocked ? 'opacity:.6;' : ''}">
        <input type="radio" name="ol" value="${esc(l.id)}"${c.blocked ? ' disabled' : ''}${!c.blocked && i === choices.indexOf(offerable[0]) ? ' checked' : ''}>
        <strong>${esc(litterLabel(l))}</strong> ${order}
        <div class="faint" style="margin-left:22px;">${c.blocked ? esc(c.blocked) : `${esc(picks)} · pups for them: ${esc(c.eligible.map(pupLabel).join(', '))}`}</div>
      </label>`;
  };
  const days = ctx.programs.get(e.waitlist_program_id)?.respond_days_override || ctx.config.respond_days;
  await formModal({
    title: `Offer ${entryName(e, ctx.contact)} a litter`,
    confirmLabel: 'Make the offer',
    bodyHtml: choices.length
      ? `${choices.map(rowHtml).join('')}
         <p class="field-hint">They get ${esc(days)} days to respond. Offering someone who isn't next doesn't change anyone's place; the next family is offered once this one is settled. Nothing is sent automatically, so tell them yourself.</p>`
      : '<p class="muted">No upcoming or current litters on this kennel yet.</p>',
    onConfirm: async (o) => {
      const picked = o.querySelector('input[name="ol"]:checked');
      if (!picked) throw new Error('Pick a litter.');
      const c = choices.find((x) => x.litter.id === picked.value);
      let note = '';
      if (c.next && c.next.entry.id !== e.id) {
        if (!(await confirmModal({ title: 'Offer out of turn?', message: `${familyNameById(c.next.entry.id)} is next in line for this litter. Offer it to ${entryName(e, ctx.contact)} anyway? Nobody's place changes, and ${familyNameById(c.next.entry.id)} still gets their turn afterwards.`, confirmLabel: 'Offer anyway' }))) {
          throw new Error('Not offered. Pick another litter, or cancel.');
        }
        note = `Offered out of turn by you; ${familyNameById(c.next.entry.id)} was next in line.`;
      }
      await actions.offerTo(c.litter.id, e.id, { note });
    }
  }) && afterAction();
}

async function onOfferOutcome(offer, outcome) {
  const e = ctx.entry;
  const name = entryName(e, ctx.contact);
  const litter = ctx.litters.find((l) => l.id === offer.litter_id);
  if (outcome === 'accepted') {
    const live = litter ? eligiblePupsFor(e, litter, kennelLitterPups(litter), ctx.sales, { today: todayYMD(), config: ctx.config }) : [];
    if (!live.length) { await alertModal({ title: 'No pups available', message: 'None of the pups offered to them is still available.' }); return; }
    let saleId = null;
    const done = await formModal({
      title: `${name} accepted a pup`,
      confirmLabel: 'Record and create the sale',
      bodyHtml: `<div class="field"><label>Which pup?</label><select id="oc-dog">${live.map((p) => `<option value="${esc(p.id)}">${esc(pupLabel(p))}</option>`).join('')}</select></div>
        <div class="field"><label>Date</label><input id="oc-date" type="date" value="${esc(todayYMD())}"></div>
        <p class="field-hint">Creates a Sale (deposit pending, price and deposit from the litter's expected amounts), marks the pup placed, and marks the family placed. Any other open offers they have are voided.</p>`,
      onConfirm: async (o) => {
        const res = await actions.recordOutcome(offer.id, 'accepted', { chosenDogId: o.querySelector('#oc-dog').value, date: o.querySelector('#oc-date').value || todayYMD() });
        saleId = res.sale.id;
      }
    });
    if (!done) return;
    await afterAction();
    if (await confirmModal({ title: 'Sale created', message: 'Open the sale to add the deposit and details? Their invoice and receipts are under Documents on this page.', confirmLabel: 'Open the sale', cancelLabel: 'Stay here' })) {
      location.href = `sale.html?id=${encodeURIComponent(saleId)}`;
    }
    return;
  }
  const prompts = {
    passed: { title: `${name} passed on this litter?`, message: 'The turn moves to the next eligible family.', confirmLabel: 'Record it' },
    no_response: { title: `${name} didn't respond in time?`, message: 'The turn moves to the next eligible family.', confirmLabel: 'Record it' },
    voided: { title: 'Void this offer?', message: `Use this if the offer was a mistake or the litter fell through. It never counts as a pass for ${name}, and the turn isn't moved on automatically.`, confirmLabel: 'Void it' }
  };
  if (!(await confirmModal(prompts[outcome]))) return;
  const res = await actions.recordOutcome(offer.id, outcome);
  await afterAction();
  if (res.passes) {
    const msg = !res.passes.counted ? 'This doesn\'t count as a pass.'
      : res.removed ? `That was pass ${res.passes.used} of ${res.passes.max}, so they've been removed from the list. You can undo this for ${REMOVAL_UNDO_DAYS} days.`
      : `This counts as pass ${res.passes.used} of ${res.passes.max}. They keep their place.`;
    const next = res.next ? `\n\nOffered to ${familyNameById(res.next.entry_id)} next, respond by ${fmtDate(res.next.respond_by_date)}.` : '';
    await alertModal({ title: 'Recorded', message: msg + next });
  }
}

function renderOffers() {
  if (ctx.mode !== 'view' || !ctx.offers.length) { els.offers.innerHTML = ''; return; }
  const today = todayYMD();
  const offers = [...ctx.offers].sort((a, b) => (b.offered_date || '').localeCompare(a.offered_date || ''));
  els.offers.innerHTML = `<section class="card" style="margin-top:16px;">
      <h2 style="margin-top:0;">Offers</h2>
      <div style="overflow-x:auto;"><table class="data"><thead><tr><th>Litter</th><th>Offered</th><th>Respond by</th><th>Outcome</th><th>Pass?</th></tr></thead><tbody>${
        offers.map((o) => {
          const l = ctx.litters.find((x) => x.id === o.litter_id);
          const overdue = o.outcome === 'open' && o.respond_by_date && o.respond_by_date < today;
          const buttons = o.outcome === 'open' ? `<div class="pill-row" style="margin-top:6px;">
              <button class="btn btn-primary btn-sm" data-oc="accepted" data-offer="${esc(o.id)}">Accepted a pup…</button>
              <button class="btn btn-sm" data-oc="passed" data-offer="${esc(o.id)}">Passed</button>
              <button class="btn btn-sm" data-oc="no_response" data-offer="${esc(o.id)}">No response</button>
              <button class="btn btn-sm" data-oc="voided" data-offer="${esc(o.id)}">Void</button></div>` : '';
          return `<tr><td>${l ? `<a href="litter.html?id=${encodeURIComponent(l.id)}">${esc(litterLabel(l))}</a>` : none}</td>
            <td>${esc(fmtDate(o.offered_date))}</td><td>${o.respond_by_date ? esc(fmtDate(o.respond_by_date)) : none}${overdue ? ' <span class="badge badge-red">Deadline passed</span>' : ''}</td>
            <td>${badge(WAITLIST_OFFER_OUTCOME, o.outcome)}${o.chosen_dog_id ? ` ${esc(dogName(o.chosen_dog_id))}` : ''}${buttons}</td>
            <td>${o.counts_as_pass ? '<span class="badge badge-amber">Counts</span>' : none}${o.notes ? ` <span class="faint" title="${esc(o.notes)}">ⓘ</span>` : ''}</td></tr>`;
        }).join('')
      }</tbody></table></div>
    </section>`;
  els.offers.querySelectorAll('[data-oc]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const offer = ctx.offers.find((o) => o.id === btn.dataset.offer);
      onOfferOutcome(offer, btn.dataset.oc).catch((err) => showError(err.message || String(err)));
    });
  });
}

// --- Documents: fee receipt, Sale invoice + receipt (Spec §15.2) ------------------------

function renderDocs() {
  const e = ctx.entry;
  if (ctx.mode !== 'view') { els.docs.innerHTML = ''; return; }
  const docs = [];
  if (e.fee_received_date && Number(e.fee_amount) > 0) docs.push({ label: 'Application fee receipt', source: 'waitlist', id: e.id, doc: 'receipt' });
  if (e.placed_sale_id) {
    docs.push({ label: 'Puppy invoice', source: 'sale', id: e.placed_sale_id, doc: 'invoice' });
    docs.push({ label: 'Puppy receipt', source: 'sale', id: e.placed_sale_id, doc: 'receipt' });
  }
  if (!docs.length) { els.docs.innerHTML = ''; return; }
  const href = (d) => `invoice.html?source=${encodeURIComponent(d.source)}&id=${encodeURIComponent(d.id)}&doc=${d.doc}`;
  els.docs.innerHTML = `<section class="card" style="margin-top:16px;">
      <h2 style="margin-top:0;">Documents</h2>
      ${docs.map((d, i) => `<div class="row-between" style="padding:6px 0;border-top:${i ? '1px solid var(--border)' : '0'};">
          <span>${esc(d.label)}</span>
          <span class="pill-row"><a class="btn btn-sm" href="${esc(href(d))}">View</a><button class="btn btn-sm btn-primary" data-pdf="${i}">Download PDF</button></span>
        </div>`).join('')}
      <p class="field-hint" style="margin-bottom:0;">For partial payments, due dates or a custom number, use Invoice / Receipt in Financials.</p>
    </section>`;
  els.docs.querySelectorAll('[data-pdf]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const { downloadInvoicePdf } = await import('../assets/invoicePdf.js');
        const d = docs[Number(btn.dataset.pdf)];
        await downloadInvoicePdf({ source: d.source, id: d.id, doc: d.doc });
      } catch (err) {
        showError(err.message || String(err));
      } finally {
        btn.disabled = false;
      }
    });
  });
}

// --- Edit lifecycle -----------------------------------------------------------------

function renderProfileActions() {
  if (ctx.mode === 'view') {
    els.profileActions.innerHTML = '<button class="btn btn-sm" id="btn-edit">Edit</button>';
    document.getElementById('btn-edit').onclick = () => {
      clearError();
      ctx.mode = 'edit';
      ctx.draft = structuredClone(ctx.entry);
      renderAll();
    };
  } else {
    els.profileActions.innerHTML = `<button class="btn btn-primary btn-sm" id="btn-save">${ctx.mode === 'new' ? 'Save application' : 'Save'}</button><button class="btn btn-sm" id="btn-cancel">Cancel</button>`;
    document.getElementById('btn-save').onclick = save;
    document.getElementById('btn-cancel').onclick = () => {
      clearError();
      if (ctx.mode === 'new') { location.href = `waitlist.html?kennel=${encodeURIComponent(ctx.kennel.id)}`; return; }
      ctx.mode = 'view';
      renderAll();
    };
  }
}

async function save() {
  const btn = document.getElementById('btn-save');
  if (btn?.disabled) return;
  if (btn) btn.disabled = true;
  clearError();
  try {
    const changes = readForm();
    if (ctx.mode === 'new') {
      const saved = await waitlistEntryRepo.create({ ...changes, kennel_id: ctx.kennel.id, status: 'applied' });
      location.href = `waitlist-entry.html?id=${encodeURIComponent(saved.id)}`;
      return;
    }
    await waitlistEntryRepo.update(ctx.entry.id, changes);
    ctx.mode = 'view';
    await reload();
    renderAll();
  } catch (e) {
    showError(e.message || String(e));
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function renderHeaderActions() {
  els.headerActions.innerHTML = '';
  if (ctx.mode === 'new') return;
  const e = ctx.entry;
  const blockers = await waitlistEntryRepo.getDeleteBlockers(e.id);
  const delTitle = blockers.length
    ? 'Referenced as ' + blockers.map((b) => `${b.label} (${b.count})`).join(', ') + ' — archive instead.'
    : 'Permanently delete this entry (for a mistake).';
  els.headerActions.innerHTML = `
    <button class="btn btn-sm" id="btn-archive">${e.is_archived ? 'Unarchive' : 'Archive'}</button>
    <button class="btn btn-danger btn-sm" id="btn-delete"${blockers.length ? ' disabled' : ''} title="${esc(delTitle)}">Delete</button>`;
  document.getElementById('btn-archive').onclick = async () => {
    const verb = e.is_archived ? 'Unarchive' : 'Archive';
    if (!(await confirmModal({ title: `${verb} this entry?`, message: e.is_archived ? '' : 'Archived entries are hidden from the waitlist and drop off the list.', confirmLabel: verb }))) return;
    try {
      if (e.is_archived) await waitlistEntryRepo.unarchive(e.id); else await waitlistEntryRepo.archive(e.id);
      await afterAction();
    } catch (err) { showError(err.message || String(err)); }
  };
  if (!blockers.length) {
    document.getElementById('btn-delete').onclick = async () => {
      if (!(await confirmModal({ title: 'Delete this entry?', message: 'This cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
      try {
        await waitlistEntryRepo.hardDelete(e.id);
        location.href = `waitlist.html?kennel=${encodeURIComponent(e.kennel_id)}`;
      } catch (err) {
        if (err instanceof ReferenceBlockedError) renderHeaderActions();
        showError(err.message || String(err));
      }
    };
  }
}

function renderTitle() {
  if (ctx.mode === 'new') {
    els.title.textContent = 'New application';
    els.subtitle.textContent = `For ${ctx.kennel.kennel_name}'s waitlist. Type in what the family told you; you'll review and approve it next.`;
    return;
  }
  const e = ctx.entry;
  els.title.innerHTML = esc(entryName(e, ctx.contact)) + (e.is_archived ? ' <span class="badge badge-gray">Archived</span>' : '');
  els.subtitle.textContent = `${ctx.kennel.kennel_name} waitlist`;
}

function renderAll() {
  els.back.href = `waitlist.html?kennel=${encodeURIComponent(ctx.kennel.id)}`;
  renderTitle();
  renderProfileActions();
  renderHeaderActions();
  if (ctx.mode === 'view') { renderStatus(); renderView(); els.status.hidden = false; }
  else { els.status.hidden = true; renderEdit(); }
  renderOffers();
  renderDocs();
}

async function main() {
  if (param('new')) {
    const { kennel } = await resolveWaitlistKennel(param('kennel'));
    if (!kennel) { showError('Set up your kennel first.'); return; }
    await loadKennelContext(kennel.id);
    ctx.mode = 'new';
    ctx.draft = { pref_sex: 'any', listen_mode: 'all', application: {}, applied_date: todayYMD() };
    renderAll();
    return;
  }
  const id = param('id');
  if (!id) { showError('No waitlist entry id provided.'); return; }
  const entry = await waitlistEntryRepo.getById(id);
  if (!entry) { showError('Waitlist entry not found.'); return; }
  ctx.entry = entry;
  await reload();
  ctx.mode = 'view';
  renderAll();
}

main().catch((e) => showError(e.message || String(e)));
