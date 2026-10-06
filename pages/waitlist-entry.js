// waitlist-entry.js — one family's run through a kennel's waitlist (Waitlist Spec
// §5–§6; End-State guide §29). New application entry (?new=1&kennel=…), the
// status card with the step-by-step actions (approve / decline / fee received /
// withdraw / remove / undo / move / re-apply), the edit-in-place details card
// (preferences incl. breed, listen-only, pause, fee, application answers), and the
// offer history. Every multi-step write goes through data/waitlistActions.js.
// Pro-only page (proPages.js).
import { waitlistEntryRepo, ReferenceBlockedError } from '../data/waitlistEntryRepo.js';
import { waitlistOfferRepo } from '../data/waitlistOfferRepo.js';
import { waitlistProgramRepo } from '../data/waitlistProgramRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { pairingRepo } from '../data/pairingRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import * as actions from '../data/waitlistActions.js';
import {
  waitlistConfig, overallPositions, passesUsed, anchorDate, isMovedByBreeder, contactMatches,
  entryName, canUndoRemoval, isPaused, rankedList, REMOVAL_UNDO_DAYS
} from '../data/waitlistRules.js';
import {
  WAITLIST_ENTRY_STATUS, WAITLIST_PREF_SEX, WAITLIST_LISTEN_MODE, WAITLIST_OFFER_OUTCOME,
  WAITLIST_REMOVED_REASON, PLACEMENT_TYPE, FEE_CREDIT_POLICY, PAYMENT_METHODS, descriptor
} from '../data/vocab.js';
import { addDaysToYMD } from '../data/dateUtils.js';
import { esc, badge, fmtDate, fmtMoney, param, todayYMD, confirmModal } from '../assets/ui.js';
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
  error: document.getElementById('page-error')
};

// The application questions W1 records (Spec §5.1 defaults). Name/email/phone are
// the applicant's own until approval links or creates their Contact.
const APP_FIELDS = [
  { key: 'name', label: 'Name', required: true },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'phone', label: 'Phone' },
  { key: 'location', label: 'City / state' },
  { key: 'timing', label: 'Timing' },
  { key: 'heard_from', label: 'How they heard about you' },
  { key: 'household', label: 'Household', wide: true, multiline: true },
  { key: 'other_pets', label: 'Other pets', wide: true, multiline: true },
  { key: 'experience', label: 'Experience with the breed', wide: true, multiline: true },
  { key: 'about', label: 'About their family', wide: true, multiline: true }
];

const LIVE_PAIRING = ['planned', 'bred', 'confirmed_pregnant'];
const LIVE_LITTER = ['expected', 'whelped', 'weaning', 'ready'];

const ctx = {
  mode: 'view', entry: null, draft: null, kennel: null, config: null,
  contact: null, contacts: [], programs: new Map(), kennelEntries: [], offers: [],
  litters: [], pairings: [], dogsById: new Map(), breeds: []
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
  const [kennel, programs, kennelEntries, contacts, litters, pairings, dogs, breeds] = await Promise.all([
    kennelRepo.getById(kennelId),
    waitlistProgramRepo.getMapForKennel(kennelId),
    waitlistEntryRepo.getByKennel(kennelId),
    contactRepo.getAll({ includeArchived: true }),
    litterRepo.getAll({ includeArchived: true }),
    pairingRepo.getAll({ includeArchived: true }),
    dogRepo.getAll({ includeArchived: true }),
    kennelRepo.getBreedVocabulary()
  ]);
  Object.assign(ctx, {
    kennel, config: waitlistConfig(kennel), programs, kennelEntries, contacts,
    litters: litters.filter((l) => l.kennel_id === kennelId),
    pairings: pairings.filter((p) => p.kennel_id === kennelId),
    dogsById: new Map(dogs.map((d) => [d.id, d])),
    breeds
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
    case 'active': return b('move', 'Move place…') + b('withdraw', 'Withdrew') + b('remove', 'Remove from list', 'btn-danger');
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
  const handlers = { approve: onApprove, decline: onDecline, withdraw: onWithdraw, fee: onFeeReceived, expire: onExpire, move: onMove, remove: onRemove, undo: onUndo, reapply: onReapply };
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
      ${APP_FIELDS.map((f) => row(f.label, multiline(app[f.key]))).join('')}
    </dl>`;
}

// --- Details: edit / new ------------------------------------------------------------

function checkList(items, selected, attr) {
  if (!items.length) return '<span class="faint">None yet.</span>';
  return items.map(({ id, label }) => `<label class="check-inline"><input type="checkbox" ${attr}="${esc(id)}"${selected.includes(id) ? ' checked' : ''}> ${esc(label)}</label>`).join('');
}

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
  const appFields = APP_FIELDS.map((f) => {
    const input = f.multiline
      ? `<textarea id="a-${f.key}">${esc(app[f.key] || '')}</textarea>`
      : `<input id="a-${f.key}" type="${f.type || 'text'}" value="${esc(app[f.key] || '')}">`;
    return `<div class="field${f.wide ? ' field-wide' : ''}"><label>${esc(f.label)}${f.required && !e.contact_id ? ' <span class="req">*</span>' : ''}</label>${input}</div>`;
  }).join('');
  const breedList = ctx.breeds.map((b) => `<option value="${esc(b)}"></option>`).join('');
  const isNew = ctx.mode === 'new';

  els.body.innerHTML = `
    <div class="form-grid" style="margin-top:14px;">
      <div class="field field-wide"><h3 style="margin:0;">Preferences</h3></div>
      <div class="field"><label>Sex</label><select id="f-pref_sex">${options(WAITLIST_PREF_SEX, e.pref_sex || 'any')}</select></div>
      <div class="field"><label>Breed</label><input id="f-pref_breed" type="text" list="breed-list" value="${esc(e.pref_breed || '')}" placeholder="Any breed"><datalist id="breed-list">${breedList}</datalist>
        <span class="field-hint">Only pups of this breed are offered to them. Leave blank for any.</span></div>
      <div class="field"><label>Placement</label><select id="f-pref_placement_type">${options(PLACEMENT_TYPE, e.pref_placement_type || '', 'Any')}</select></div>
      <div class="field"><label>Colors</label><input id="f-pref_colors" type="text" value="${esc((e.pref_colors || []).join(', '))}" placeholder="e.g. brindle, seal">
        <span class="field-hint">${ctx.config.color_matching ? 'Color matching is on: only pups with one of these colors are offered.' : 'Notes only. Color matching is off in your waitlist settings.'}</span></div>
      <div class="field"><label>Program</label><select id="f-program">${programOptions(e.waitlist_program_id)}</select></div>
      ${isNew ? `<div class="field"><label>Applied</label><input id="f-applied_date" type="date" value="${esc(e.applied_date || todayYMD())}"></div>` : ''}

      ${isNew ? '' : `
      <div class="field field-wide"><h3 style="margin:8px 0 0;">Which litters</h3></div>
      <div class="field"><label>Listening for</label><select id="f-listen_mode">${options(WAITLIST_LISTEN_MODE, e.listen_mode || 'all')}</select>
        <span class="field-hint">Listen-only families aren't offered other litters. That never costs them their place or counts as a pass.</span></div>
      <div class="field field-wide" id="listen-picks"${(e.listen_mode || 'all') === 'selected' ? '' : ' hidden'}>
        <label>Pairings</label><div class="check-group">${checkList(pairings, selPairings, 'data-pairing')}</div>
        <label style="margin-top:8px;">Litters</label><div class="check-group">${checkList(litters, selLitters, 'data-litter')}</div>
      </div>
      <div class="field"><label>Paused until</label><input id="f-paused_until" type="date" value="${esc(e.paused_until || '')}">
        <span class="field-hint">Not offered pups until after this date. They keep their place.</span></div>
      <div class="field"><label>Pause reason</label><input id="f-pause_reason" type="text" value="${esc(e.pause_reason || '')}"></div>

      <div class="field field-wide"><h3 style="margin:8px 0 0;">Fee</h3></div>
      <div class="field"><label>Fee amount</label><input id="f-fee_amount" type="number" min="0" step="0.01" value="${esc(e.fee_amount ?? '')}"></div>
      <div class="field"><label>Pay by</label><input id="f-fee_due_date" type="date" value="${esc(e.fee_due_date || '')}"></div>
      <div class="field"><label>Fee policy</label><select id="f-fee_credit_policy">${options(FEE_CREDIT_POLICY, e.fee_credit_policy || '', '—')}</select></div>`}

      <div class="field field-wide"><h3 style="margin:8px 0 0;">Application</h3>${e.contact_id ? '<span class="field-hint">Name, email and phone are what they applied with. The contact record holds the current ones.</span>' : ''}</div>
      ${appFields}
      <div class="field field-wide"><label>Your notes</label><textarea id="f-notes">${esc(e.notes || '')}</textarea></div>
    </div>`;

  const modeSel = document.getElementById('f-listen_mode');
  if (modeSel) modeSel.addEventListener('change', () => { document.getElementById('listen-picks').hidden = modeSel.value !== 'selected'; });
}

function readForm() {
  const val = (id) => document.getElementById(id)?.value ?? '';
  const has = (id) => Boolean(document.getElementById(id));
  const application = { ...(ctx.draft.application || {}) };
  for (const f of APP_FIELDS) application[f.key] = f.multiline ? val(`a-${f.key}`) : val(`a-${f.key}`).trim();
  const out = {
    pref_sex: val('f-pref_sex') || 'any',
    pref_breed: val('f-pref_breed').trim(),
    pref_placement_type: val('f-pref_placement_type') || '',
    pref_colors: val('f-pref_colors').split(',').map((s) => s.trim()).filter(Boolean),
    waitlist_program_id: val('f-program') || null,
    application,
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
  return out;
}

// --- Offers (read-only in W1b; W1c adds the offer flow) --------------------------------

function renderOffers() {
  if (ctx.mode !== 'view' || !ctx.offers.length) { els.offers.innerHTML = ''; return; }
  const offers = [...ctx.offers].sort((a, b) => (b.offered_date || '').localeCompare(a.offered_date || ''));
  els.offers.innerHTML = `<section class="card" style="margin-top:16px;">
      <h2 style="margin-top:0;">Offers</h2>
      <table class="data"><thead><tr><th>Litter</th><th>Offered</th><th>Respond by</th><th>Outcome</th><th>Pass?</th></tr></thead><tbody>${
        offers.map((o) => {
          const l = ctx.litters.find((x) => x.id === o.litter_id);
          return `<tr><td>${l ? `<a href="litter.html?id=${encodeURIComponent(l.id)}">${esc(litterLabel(l))}</a>` : none}</td>
            <td>${esc(fmtDate(o.offered_date))}</td><td>${o.respond_by_date ? esc(fmtDate(o.respond_by_date)) : none}</td>
            <td>${badge(WAITLIST_OFFER_OUTCOME, o.outcome)}${o.chosen_dog_id ? ` ${esc(dogName(o.chosen_dog_id))}` : ''}</td>
            <td>${o.counts_as_pass ? '<span class="badge badge-amber">Counts</span>' : none}${o.notes ? ` <span class="faint" title="${esc(o.notes)}">ⓘ</span>` : ''}</td></tr>`;
        }).join('')
      }</tbody></table>
    </section>`;
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
