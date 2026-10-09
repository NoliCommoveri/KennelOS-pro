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
  entryName, canUndoRemoval, isPaused, isManuallyPaused, isReadyHeld, readyFromDate, readyCheck, rankedList, REMOVAL_UNDO_DAYS,
  eligiblePupsFor, nextFamilyForLitter, turnSpent, openTurns, turnOffers, turnIdOf, isListeningFor, isListenOnly, isPupAvailable,
  describeOfferChanges, isAwaitingDeposit, switchablePups, canSwitchAcceptedPick, undoPassBlocker,
  kennelBreeds, resolveBreed, prefChangeEffect, autoOffers, closingTrigger, listenParentChoices,
  PREF_FIELD_LABEL, prefValueText, prefChangeSummary, lostSaleFamily
} from '../data/waitlistRules.js';
import {
  formQuestions, entryQuestions, snapshotQuestions, answerText, isAnswerQuestion, missingRequired, formFaq, READY_TIMING_LABEL,
  MATCHING_NOTICE, matchingPrefKeys
} from '../data/waitlistForm.js';
import {
  WAITLIST_ENTRY_STATUS, WAITLIST_PREF_SEX, WAITLIST_LISTEN_MODE, WAITLIST_OFFER_OUTCOME,
  WAITLIST_REMOVED_REASON, WAITLIST_READY_TIMING, PLACEMENT_PURPOSE, cleanPurposes, FEE_CREDIT_POLICY, PAYMENT_METHODS, SEX, descriptor
} from '../data/vocab.js';
import { addDaysToYMD } from '../data/dateUtils.js';
import { esc, badge, fmtDate, fmtMoney, param, todayYMD, confirmModal, alertModal } from '../assets/ui.js';
import {
  resolveWaitlistKennel, prefsSummary, entryFlags, readyHoldText, formModal,
  pickDialog, depositDialog, changePickDialog, undoPassDialog, restoreLostPupDialog, textFamilyDialog, statusLinkFor, copyLink
} from '../assets/waitlistUI.js';

const els = {
  title: document.getElementById('entry-title'),
  subtitle: document.getElementById('entry-subtitle'),
  back: document.getElementById('back-link'),
  headerActions: document.getElementById('header-actions'),
  status: document.getElementById('status-section'),
  online: document.getElementById('online-section'),
  profileActions: document.getElementById('profile-actions'),
  body: document.getElementById('profile-body'),
  offers: document.getElementById('offers-section'),
  docs: document.getElementById('docs-section'),
  error: document.getElementById('page-error')
};

const LIVE_PAIRING = ['planned', 'bred', 'confirmed_pregnant'];
const LIVE_LITTER = ['expected', 'whelped', 'weaning', 'ready'];
// A family picks which sires and dams they're listening for only once they're ON
// the list: approved AND their fee received (or waived, which makes them active at
// approval). Before that there's nothing to listen for, and after they leave the
// list it no longer matters (their picks are kept, just not shown for editing).
const LISTEN_STATUSES = ['active'];

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
  const [kennel, programs, kennelEntries, contacts, litters, pairings, dogs, kennelOffers, sales] = await Promise.all([
    kennelRepo.getById(kennelId),
    waitlistProgramRepo.getMapForKennel(kennelId),
    waitlistEntryRepo.getByKennel(kennelId),
    contactRepo.getAll({ includeArchived: true }),
    litterRepo.getAll({ includeArchived: true }),
    pairingRepo.getAll({ includeArchived: true }),
    dogRepo.getAll({ includeArchived: true }),
    waitlistOfferRepo.getByKennel(kennelId),
    saleRepo.getAll({ includeArchived: true })
  ]);
  Object.assign(ctx, {
    kennel, config: waitlistConfig(kennel), form: formQuestions(waitlistConfig(kennel)), programs, kennelEntries, contacts,
    litters: litters.filter((l) => l.kennel_id === kennelId),
    pairings: pairings.filter((p) => p.kennel_id === kennelId),
    dogsById: new Map(dogs.map((d) => [d.id, d])),
    // The breed dropdown's choices: this kennel's breeds only (never free text).
    breeds: kennelBreeds(kennel, dogs), kennelOffers, sales
  });
}

async function reload() {
  ctx.entry = await waitlistEntryRepo.getById(ctx.entry.id);
  await loadKennelContext(ctx.entry.kennel_id);
  ctx.contact = ctx.contacts.find((c) => c.id === ctx.entry.contact_id) || null;
  ctx.offers = await waitlistOfferRepo.getByEntry(ctx.entry.id);
}

// --- Status card + actions --------------------------------------------------------

// A lost pup's sale this family can be put back in line for (Spec §16.11): the sale
// they were placed with, or a pick of their open turn, voided or returned for a
// health problem. Null when there's none. Normally she's asked as she marks the
// sale; this is the way back if she said "Not now".
function lostSale(e) {
  const offers = ctx.kennelOffers.filter((o) => o.entry_id === e.id);
  const ids = new Set([e.placed_sale_id, ...offers.map((o) => o.sale_id)].filter(Boolean));
  return ctx.sales.find((x) => ids.has(x.id) && lostSaleFamily(x, [e], offers)) || null;
}

function statusLines(e) {
  const today = todayYMD();
  const lines = [];
  const lost = lostSale(e);
  if (lost) {
    lines.push(`<span class="badge badge-amber">Pup lost</span> ${esc(dogName(lost.dog_id))}'s sale was ${esc(lost.status)}. <a href="sale.html?id=${encodeURIComponent(lost.id)}">Open the sale →</a>`);
  }
  if (e.carried_payment) {
    lines.push(`Carrying <strong>${esc(fmtMoney(e.carried_payment.amount))}</strong> they paid on a pup they lost (${esc(fmtDate(e.carried_payment.date))}); it becomes the deposit on their next pick.`);
  }
  if (e.status === 'applied') {
    lines.push(`Applied ${e.applied_date ? esc(fmtDate(e.applied_date)) : ''}${e.source === 'online_form' ? ' through your online form' : ''}. Waiting for your review.`);
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
    const flags = entryFlags(e, today, ctx.config);
    const why = isReadyHeld(e, today, ctx.config)
      ? `${esc(readyHoldText(e, today, ctx.config))} They aren't offered pups (or charged passes) until then, and keep their place.`
      : isPaused(e, today) ? 'Paused families keep their place; they just aren\'t offered pups.'
        : e.listen_mode === 'except' ? 'Not offered litters from the sires and dams they listed; they keep their place.'
          : 'Only offered litters from the sires and dams they chose; they keep their place.';
    if (flags) lines.push(`${flags} <span class="faint">${why}</span>`);
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
  const lost = lostSale(e) ? b('restore', e.status === 'placed' ? 'Put back in line…' : 'Give their turn back…', 'btn-primary') : '';
  return lost + actionButtonsFor(e) + b('text', 'Text them…');
}

// --- Texting them (waitlistUI.textFamilyDialog) ---------------------------------------

// What a text to this family would say now, for her to edit: their turn (or the pup
// they're holding), a fee that's due, or where they are on the list — plus their
// status page link when the list is online.
function suggestedText(e) {
  const first = String(entryName(e, ctx.contact)).trim().split(/\s+/)[0] || 'there';
  const kennel = ctx.kennel.kennel_name;
  const link = statusLinkFor(e, ctx.kennel);
  const linkLine = link ? `\n\nYour waitlist page: ${link}` : '';
  const open = ctx.kennelOffers.filter((o) => o.entry_id === e.id && o.outcome === 'open' && !o.is_archived);
  if (open.length) {
    const by = open.map((o) => o.respond_by_date).filter(Boolean).sort().pop();
    const picked = open.find((o) => o.chosen_dog_id);
    if (picked) {
      return `Hi ${first}, this is ${kennel}. We're holding ${dogName(picked.chosen_dog_id)} for you! Please send your deposit${by ? ` by ${fmtDate(by)}` : ''} to confirm.${ctx.config.payment_instructions ? `\n\n${ctx.config.payment_instructions}` : ''}${linkLine}`;
    }
    const names = open.map((o) => { const l = ctx.litters.find((x) => x.id === o.litter_id); return l ? litterLabel(l) : 'a litter'; }).join(', ');
    return `Hi ${first}, this is ${kennel}. Good news: it's your turn on our waitlist! You can pick a pup from ${names}. Please let us know your pick and send your deposit${by ? ` by ${fmtDate(by)}` : ''}, or tell us if you'd like to pass this time.${linkLine}`;
  }
  if (e.status === 'approved') {
    const fee = e.fee_amount != null ? fmtMoney(e.fee_amount) : '';
    return `Hi ${first}, this is ${kennel}. You're approved for our waitlist!${fee ? ` Your application fee of ${fee} is due${e.fee_due_date ? ` by ${fmtDate(e.fee_due_date)}` : ''}, and you join the list as soon as it's received.` : ''}${ctx.config.payment_instructions ? `\n\n${ctx.config.payment_instructions}` : ''}${linkLine}`;
  }
  if (e.status === 'active') {
    const pos = overallPositions(ctx.kennelEntries, ctx.kennel.id, ctx.programs).get(e.id);
    return `Hi ${first}, this is ${kennel} with a waitlist update: you're #${pos} on our list.${linkLine}`;
  }
  return `Hi ${first}, this is ${kennel}. ${linkLine}`.trim();
}

async function onText() {
  const e = ctx.entry;
  const phone = ctx.contact?.phone || e.application?.phone || '';
  await textFamilyDialog({ name: entryName(e, ctx.contact), phone, message: suggestedText(e) });
}

function actionButtonsFor(e) {
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

// Her request (W2 Plan §8): the family's status-page link, to send by Messenger
// or text, and "New link" if it went somewhere it shouldn't. Only while the list
// is online.
function statusLinkHtml(e) {
  if (!statusLinkFor(e, ctx.kennel)) return '';
  return `<div class="row-between" style="gap:8px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">
      <span class="muted">Their status page: their place, offers and the fee due.</span>
      <span class="pill-row"><button class="btn btn-sm" data-link="copy">Copy status link</button><button class="btn btn-sm" data-link="new" title="Make a new link; the old one stops working">New link</button></span>
    </div>`;
}

async function onNewLink() {
  if (!(await confirmModal({ title: 'Make a new link?', message: 'Their current link stops working as soon as the new one is published. Send them the new link.', confirmLabel: 'Make a new link' }))) return;
  const { replaceStatusToken } = await import('../data/cloud/cloudWaitlist.js');
  await replaceStatusToken(ctx.entry.id);
  await afterAction();
  await copyLink(statusLinkFor(ctx.entry, ctx.kennel), null, { title: 'Their new status page link' });
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
    </div>${statusLinkHtml(e)}`;
  els.status.querySelector('[data-link="copy"]')?.addEventListener('click', (ev) => copyLink(statusLinkFor(e, ctx.kennel), ev.currentTarget, { title: 'Their status page' }));
  els.status.querySelector('[data-link="new"]')?.addEventListener('click', () => onNewLink().catch((err) => showError(err.message || String(err))));
  const handlers = { offer: onOfferLitter, approve: onApprove, decline: onDecline, withdraw: onWithdraw, fee: onFeeReceived, expire: onExpire, move: onMove, remove: onRemove, undo: onUndo, reapply: onReapply, restore: onRestore, text: onText };
  els.status.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => handlers[btn.dataset.act]().catch((err) => showError(err.message || String(err))));
  });
}

// --- From their status page (W2 step 5) ------------------------------------------
// What the family asked for on their status page (a pause, a narrower listen-only
// choice, a change to a matching answer: each waits for her Approve / Decline,
// the same buttons as on Today; a Companion link request waits for Mark sent) and their messages and activity, newest first.
// Hidden for a family who never used it.

function listenText(r) {
  if (!isListenOnly(r)) return 'All litters';
  const names = (list) => (list || []).map(dogName).join(', ');
  const parents = [r.listen_sire_ids?.length ? `Sires: ${names(r.listen_sire_ids)}` : '', r.listen_dam_ids?.length ? `Dams: ${names(r.listen_dam_ids)}` : '']
    .filter(Boolean).join(' · ') || 'no parents';
  return r.listen_mode === 'except' ? `All except ${parents}` : parents;
}

function pendingRequests(e) {
  const out = [];
  if (actions.hasPendingRequest(e, 'pause_request')) {
    const r = e.pause_request;
    out.push({ kind: 'pause', text: `Asked ${esc(fmtDate(r.requested_date))} to pause their place until <strong>${esc(fmtDate(r.until))}</strong>.`, note: r.note,
      hint: 'They keep their place and aren\'t offered pups until then. A pause never counts as a pass.' });
  }
  if (actions.hasPendingRequest(e, 'pref_change_request')) {
    const r = e.pref_change_request;
    out.push({ kind: 'pref', text: `Asked ${esc(fmtDate(r.requested_date))} to change: <strong>${esc(prefChangeSummary(e, r.changes)) || 'nothing that differs now'}</strong>.`, note: r.note,
      hint: 'An open offer stays open either way.' });
  }
  if (actions.hasPendingRequest(e, 'listen_change_request')) {
    const r = e.listen_change_request;
    const except = r.listen_mode === 'except';
    out.push({ kind: 'listen', text: `Asked ${esc(fmtDate(r.requested_date))} to ${except ? 'wait for' : 'wait only for'}: <strong>${esc(listenText(r))}</strong> <span class="faint">(now: ${esc(listenText(e))})</span>.`, note: '',
      hint: `Narrower, so it needs you: they wouldn't be offered ${except ? 'those' : 'other'} litters. An open offer stays open.` });
  }
  if (actions.hasPendingRequest(e, 'companion_request')) {
    const r = e.companion_request;
    out.push({ kind: 'companion', text: `Asked ${esc(fmtDate(r.requested_date))} for <strong>their Companion link</strong>.`, note: r.note,
      hint: 'Send it from the Companion page (Current families), then mark it sent so their status page says so.',
      buttons: '<a class="btn btn-sm" href="companion.html?type=family">Open Companion</a><button class="btn btn-sm btn-primary" data-req="companion:sent">Mark sent</button><button class="btn btn-sm" data-req="companion:decline">Decline</button>' });
  }
  return out;
}

function renderOnline() {
  const e = ctx.entry;
  const requests = pendingRequests(e);
  const messages = [...(e.messages || [])].reverse();
  if (!requests.length && !messages.length) { els.online.hidden = true; els.online.innerHTML = ''; return; }
  const unread = messages.filter((m) => !m.read).length;
  const reqHtml = requests.map((r) => `<div class="row-between" style="gap:8px;flex-wrap:wrap;padding:8px 0;border-top:1px solid var(--border);">
      <div><p style="margin:0;">${r.text}</p>${r.note ? `<p class="faint" style="margin:2px 0 0;">They said: "${esc(r.note)}"</p>` : ''}<p class="field-hint" style="margin:2px 0 0;">${esc(r.hint)}</p></div>
      <span class="pill-row">${r.buttons || `<button class="btn btn-sm btn-primary" data-req="${r.kind}:approve">Approve</button><button class="btn btn-sm" data-req="${r.kind}:decline">Decline</button>`}</span>
    </div>`).join('');
  const msgHtml = messages.slice(0, 50).map((m) => `<li style="padding:6px 0;border-top:1px solid var(--border);">
      <div class="faint" style="font-size:0.85em;">${esc(fmtDate(String(m.at).slice(0, 10)))} · ${m.kind === 'message' ? 'Message' : 'On their status page'}${m.read ? '' : ' <span class="badge badge-blue">New</span>'}</div>
      <div>${multiline(m.body)}</div></li>`).join('');
  els.online.hidden = false;
  els.online.innerHTML = `
    <div class="row-between" style="gap:8px;flex-wrap:wrap;"><h3 style="margin:0;">From their status page</h3>
      ${unread ? '<button class="btn btn-sm" data-msgs="read">Mark read</button>' : ''}</div>
    ${requests.length ? `<div style="margin-top:8px;">${reqHtml}</div>` : ''}
    ${messages.length ? `<ul style="list-style:none;margin:8px 0 0;padding:0;">${msgHtml}</ul>${messages.length > 50 ? `<p class="faint">Showing the newest 50 of ${messages.length}.</p>` : ''}` : ''}
    <p class="field-hint" style="margin-top:8px;">Nothing is sent to the family from here yet; reply by email, text or Messenger.</p>`;
  const run = (fn) => fn().then(afterAction).catch((err) => showError(err.message || String(err)));
  els.online.querySelector('[data-msgs="read"]')?.addEventListener('click', () => run(() => actions.markMessagesRead(e.id)));
  const handlers = {
    'pause:approve': () => actions.approvePauseRequest(e.id), 'pause:decline': () => actions.declinePauseRequest(e.id),
    'pref:approve': () => actions.approvePrefChange(e.id), 'pref:decline': () => actions.declinePrefChange(e.id),
    'listen:approve': () => actions.approveListenChange(e.id), 'listen:decline': () => actions.declineListenChange(e.id),
    'companion:sent': () => actions.markCompanionLinkSent(e.id), 'companion:decline': () => actions.declineCompanionRequest(e.id)
  };
  els.online.querySelectorAll('[data-req]').forEach((btn) => btn.addEventListener('click', () => run(handlers[btn.dataset.req])));
}

// Put them back in line after a lost pup (the same dialog the Sale page asks).
async function onRestore() {
  const sale = lostSale(ctx.entry);
  if (!sale) return;
  if (await restoreLostPupDialog({ saleId: sale.id })) await afterAction();
}

async function afterAction() {
  clearError();
  await reload();
  renderAll();
}

// Plain-text lines for the offers an action voided or made (describeOfferChanges),
// read against the freshly reloaded context.
const offerChangeLines = (res) => describeOfferChanges(res || {}, {
  nameOf: (entryId) => familyNameById(entryId),
  litterOf: (litterId) => { const l = ctx.litters.find((x) => x.id === litterId); return l ? litterLabel(l) : 'A litter'; },
  fmtDate
});

// After the family leaves the list: say which of their offers closed and who the
// turn moved to, so she knows who to contact. Silent when they held none.
async function reportLeaving(res) {
  const lines = offerChangeLines(res);
  if (lines.length) await alertModal({ title: 'Offers updated', message: lines.join('\n\n') });
}

// The open offers this family holds, for the leave-the-list confirmations.
function openOfferWarning() {
  const open = ctx.offers.filter((o) => o.outcome === 'open' && !o.is_archived);
  if (!open.length) return '';
  const names = open.map((o) => { const l = ctx.litters.find((x) => x.id === o.litter_id); return l ? litterLabel(l) : 'a litter'; });
  return ` Their open offer on ${names.join(', ')} will be voided (not a pass) and offered to the next family.`;
}

// After a family joins (or rejoins) the list: no offer is made for them
// automatically (waitlistActions header), so say where they're next in line now.
async function reportNextInLine() {
  if (ctx.entry.status !== 'active') return;
  const mine = litterChoices(ctx.entry).filter((c) => !c.blocked && c.next && c.next.entry.id === ctx.entry.id);
  if (!mine.length) return;
  const name = entryName(ctx.entry, ctx.contact);
  const list = mine.map((c) => `${litterLabel(c.litter)} (${c.litter.picks_opened_date ? 'picks open' : 'picks not open yet'})`).join(', ');
  await alertModal({ title: `${name} is next in line`, message: `${name} is next for ${list}. No offer has been made. Use "Offer a litter…" when you're ready.` });
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
  }) && (await afterAction(), await reportNextInLine());
}

async function onDecline() {
  const name = entryName(ctx.entry, ctx.contact);
  if (!(await confirmModal({ title: `Decline ${name}?`, message: 'The application closes. No contact is created.', confirmLabel: 'Decline', danger: true }))) return;
  await actions.decline(ctx.entry.id);
  await afterAction();
}

async function onWithdraw() {
  const name = entryName(ctx.entry, ctx.contact);
  if (!(await confirmModal({ title: `${name} left the list?`, message: `Record that the family withdrew. Coming back means a new application, a new fee and a new place.${openOfferWarning()}`, confirmLabel: 'They withdrew' }))) return;
  const res = await actions.withdraw(ctx.entry.id);
  await afterAction();
  await reportLeaving(res);
}

async function onExpire() {
  const name = entryName(ctx.entry, ctx.contact);
  if (!(await confirmModal({ title: `Close ${name}'s application?`, message: 'Their fee wasn\'t received in time. They can re-apply later.', confirmLabel: 'Close it' }))) return;
  await actions.markFeeExpired(ctx.entry.id);
  await afterAction();
}

async function onRemove() {
  const name = entryName(ctx.entry, ctx.contact);
  if (!(await confirmModal({ title: `Remove ${name} from the list?`, message: `This is final. To come back they would re-apply, with a new fee and a new place.${openOfferWarning()}`, confirmLabel: 'Remove', danger: true }))) return;
  const res = await actions.removeByBreeder(ctx.entry.id);
  await afterAction();
  await reportLeaving(res);
}

async function onUndo() {
  await actions.undoRemoval(ctx.entry.id);
  await afterAction();
  await reportNextInLine();
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
  }) && (await afterAction(), await reportNextInLine());
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
      <p class="field-hint">Places are kept by date, so this gives them that family's date. Families on the same date are ordered by when their fee was recorded, so they may land just before or after.</p>` : ''}
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

// The litters the family was last told "almost your turn" about (Spec §15.5).
function soonLitters(e) {
  return (e.soon_notified_litter_ids || []).map((id) => ctx.litters.find((l) => l.id === id)).filter(Boolean).map(litterLabel).join(', ');
}

// Listen-only families pick parent dogs; the litters and upcoming pairings that
// covers are derived (a litter/pairing by one of their sires OR out of one of
// their dams — waitlistRules.isListeningFor reads only sire_id/dam_id, which
// pairings carry too).
function listenSummary(e) {
  if (!isListenOnly(e)) return esc('All litters');
  const except = e.listen_mode === 'except';
  const names = (ids) => (ids || []).map(dogName).join(', ');
  const parts = [];
  if ((e.listen_sire_ids || []).length) parts.push(`Sires: ${names(e.listen_sire_ids)}`);
  if ((e.listen_dam_ids || []).length) parts.push(`Dams: ${names(e.listen_dam_ids)}`);
  if (!parts.length) return esc('Only: no sires or dams chosen yet, so no litter is offered to them');
  if (except) {
    const skipped = [
      ...ctx.litters.filter((l) => !l.is_archived && LIVE_LITTER.includes(l.status) && !isListeningFor(e, l)).map(litterLabel),
      ...ctx.pairings.filter((p) => !p.is_archived && LIVE_PAIRING.includes(p.status) && !isListeningFor(e, p)
        && !ctx.litters.some((l) => l.pairing_id === p.id)).map((p) => `${pairingLabel(p)} (pairing)`)
    ];
    return `${esc(`All except: ${parts.join(' · ')}`)}<br><span class="faint">${esc(skipped.length ? `Right now that skips: ${skipped.join(', ')}` : 'No current litter or upcoming pairing has these parents.')}</span>`;
  }
  const covers = [
    ...ctx.litters.filter((l) => !l.is_archived && LIVE_LITTER.includes(l.status) && isListeningFor(e, l)).map(litterLabel),
    ...ctx.pairings.filter((p) => !p.is_archived && LIVE_PAIRING.includes(p.status) && isListeningFor(e, p)
      && !ctx.litters.some((l) => l.pairing_id === p.id)).map((p) => `${pairingLabel(p)} (pairing)`)
  ];
  return `${esc(`Only: ${parts.join(' · ')}`)}<br><span class="faint">${esc(covers.length ? `Right now that's: ${covers.join(', ')}` : 'No current litter or upcoming pairing from these parents.')}</span>`;
}

// Their readiness answer, plus the hold it puts on them (Spec §15.8). Escaped HTML.
function readySummary(e) {
  if (!e.ready_timing) return '<span class="badge badge-amber" title="A required question. Edit to fill it in.">Not answered</span>';
  const t = descriptor(WAITLIST_READY_TIMING, e.ready_timing);
  const from = readyFromDate(e);
  if (!from) return esc(t.label);
  const base = e.fee_received_date ? 'the fee date' : 'approval';
  const today = todayYMD();
  const held = today < from;
  const base0 = `${esc(t.label)} <span class="faint">— ${held ? 'no offers until' : 'hold ended'} ${esc(fmtDate(from))} (${esc(t.hold_months)} month${t.hold_months === 1 ? '' : 's'} from ${base})</span>`;
  // "Ready now?" (Spec §16.7): their answer, or a button for when they told her.
  const rc = e.status === 'active' ? readyCheck(e, today, ctx.config) : null;
  if (!rc) return base0;
  if (rc.answer === 'yes') return `${base0}<br><span class="faint">Ready now? Yes, ${esc(fmtDate(e.ready_check.answered_date))}${e.ready_check.by === 'breeder' ? ' (you recorded it)' : ''}.</span>`;
  if (rc.answer === 'no') return `${base0}<br><span class="faint">Ready now? Not yet: until ${esc(fmtDate(e.ready_check.until))}. "${esc(e.ready_check.reason)}"</span>`;
  return `${base0}<br><span class="badge badge-amber">Ready now? No answer yet</span> <span class="faint">${esc(readyHoldText(e, today, ctx.config))}</span>
    <button class="btn btn-sm" data-ready="yes" style="margin-top:4px;">They told me they're ready</button>`;
}

// Her changes to the matching answers (Spec §15.9), for the history and the
// narrowing warning (PREF_FIELD_LABEL / prefValueText from waitlistRules).
// Newest first, so changing an answer and back shows as neighbouring lines.
function prefHistory(e) {
  const log = e.pref_change_log || [];
  if (!log.length) return '';
  return [...log].reverse().map((x) => `${esc(fmtDate(x.date))} · ${esc(PREF_FIELD_LABEL[x.field] || x.field)}: ${esc(prefValueText(x.field, x.from))} → ${esc(prefValueText(x.field, x.to))}${x.declined ? ' <span class="faint">(they asked; you declined)</span>' : x.by === 'request' ? ' <span class="faint">(they asked)</span>' : ''}`).join('<br>');
}

// "Not this litter" (Spec §16.2): litters the family passed on ahead of time on
// their status page, with their reason. Nothing counts until their turn comes.
const reasonText = (r) => (r ? `${r.label}${r.text ? `: "${r.text}"` : ''}` : '');
function notThisLitterHtml(e) {
  return (e.prepasses || []).map((p) => {
    const l = p.litter_id ? ctx.litters.find((x) => x.id === p.litter_id) : null;
    const name = l ? litterLabel(l) : p.pairing_id ? 'an upcoming pairing' : 'a litter';
    return `${esc(name)}${p.reason ? ` <span class="faint">— ${esc(reasonText(p.reason))}${p.date ? `, ${esc(fmtDate(p.date))}` : ''}</span>` : ''}`;
  }).join('<br>') + ((e.prepasses || []).length ? '<br><span class="faint">Left out of their turn when it comes, and it counts as a pass only then.</span>' : '');
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
      ${row('Wants', prefsSummary(e) + (e.pref_breed && resolveBreed(e.pref_breed, ctx.breeds) === null ? ` <span class="badge badge-red" title="No pup will match this breed. Edit to pick one of your breeds.">Unknown breed</span>` : ''))}
      ${row('Ready to buy', readySummary(e))}
      ${row('Answer changes', prefHistory(e))}
      ${row('Listening for', LISTEN_STATUSES.includes(e.status) || isListenOnly(e) ? listenSummary(e) : '')}
      ${row('Not this litter', notThisLitterHtml(e))}
      ${row('Paused until', e.paused_until ? esc(fmtDate(e.paused_until)) + (e.pause_reason ? ` <span class="faint">— ${esc(e.pause_reason)}</span>` : '') : '')}
      ${row('Fee', e.fee_amount != null ? esc(fmtMoney(e.fee_amount)) : '')}
      ${row('Fee policy', e.fee_credit_policy ? esc(descriptor(FEE_CREDIT_POLICY, e.fee_credit_policy).label) : '')}
      ${row('Fee received', e.fee_received_date ? esc(fmtDate(e.fee_received_date)) + [e.fee_payment_method, e.fee_payment_reference].filter(Boolean).map((s) => ` <span class="faint">${esc(s)}</span>`).join('') : '')}
      ${row('Pay by', e.fee_due_date ? esc(fmtDate(e.fee_due_date)) : '')}
      ${row('Told "almost your turn"', e.soon_notified_date ? esc(fmtDate(e.soon_notified_date)) + (soonLitters(e) ? ` <span class="faint">— ${esc(soonLitters(e))}</span>` : '') : '')}
      ${row('Notes', multiline(e.notes))}
    </dl>
    <h3 style="margin:18px 0 6px;">Application</h3>
    <dl class="dl-meta">
      ${row('Applied', e.applied_date ? esc(fmtDate(e.applied_date)) : '')}
      ${entryQuestions(e, ctx.form).map((q) => row(q.label, multiline(answerText(q, app[q.id])))).join('')}
    </dl>`;
  // "Ready now?" answered for them (they told her by phone or message).
  els.body.querySelector('[data-ready="yes"]')?.addEventListener('click', () => actions.recordReadyAnswer(e.id, { answer: 'yes', by: 'breeder' })
    .then(afterAction).catch((err) => showError(err.message || String(err))));
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
  // A stored breed that isn't one of the kennel's (typed before this was a
  // dropdown, or imported) stays selectable, flagged, so saving never clears it.
  const current = e.pref_breed || '';
  const known = resolveBreed(current, ctx.breeds);
  const breedOpts = `<option value="">Any breed</option>`
    + ctx.breeds.map((b) => `<option value="${esc(b)}"${known && b === known ? ' selected' : ''}>${esc(b)}</option>`).join('')
    + (current && known === null ? `<option value="${esc(current)}" selected>${esc(current)} (not one of your breeds)</option>` : '');
  switch (key) {
    case 'pref_sex':
      return `<div class="field"><label>${esc(label || 'Sex')}</label><select id="f-pref_sex">${options(WAITLIST_PREF_SEX, e.pref_sex || 'any')}</select></div>`;
    case 'pref_breed':
      return `<div class="field"><label>${esc(label || 'Breed')}</label><select id="f-pref_breed">${breedOpts}</select>
        <span class="field-hint">${ctx.breeds.length ? 'Only pups of this breed are offered to them.' : 'No breeds yet: give this kennel\'s dogs a breed, or add preferred breeds on the kennel page.'}${current && known === null ? ' <strong>Their current breed doesn\'t match any of your dogs\' breeds, so no pup will match it. Pick the right one.</strong>' : ''}</span></div>`;
    case 'pref_purposes': {
      const picked = cleanPurposes(e.pref_purposes);
      return `<div class="field field-wide"><label>${esc(label || 'Looking for')}</label>
        <div>${PLACEMENT_PURPOSE.map((p) => `<label class="check-inline"><input type="checkbox" data-purpose="${esc(p.value)}"${picked.includes(p.value) ? ' checked' : ''}> ${esc(p.label)}</label>`).join(' ')}</div>
        <span class="field-hint">Only pups whose intended registration fits are offered to them (pet and performance → Limited or None, show → Full, breeding → Full or None, co-own → Co-own). None ticked: any registration.</span></div>`;
    }
    case 'ready_timing':
      return `<div class="field"><label>${esc(label || READY_TIMING_LABEL)} <span class="req">*</span></label><select id="f-ready_timing">${options(WAITLIST_READY_TIMING, e.ready_timing || '', '— Choose —')}</select>
        <span class="field-hint">Anything but ASAP puts them on hold: no offers (so no passes used) until that many months after their fee is received, or approval if there's no fee (6+ months → 6).</span></div>`;
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
  const selSires = e.listen_sire_ids || [];
  const selDams = e.listen_dam_ids || [];
  const canListen = LISTEN_STATUSES.includes(e.status);
  // The parents a family can pick: this kennel's active breeding dogs, plus any dog
  // that's a parent of one of its live litters or upcoming pairings (an outside
  // stud included), plus anything already chosen (so a retired dog a family picked
  // never silently drops off their list).
  // (waitlistRules.listenParentChoices; the status page offers the same ones.)
  const choices = listenParentChoices(ctx.kennel, {
    dogs: [...ctx.dogsById.values()], litters: ctx.litters, pairings: ctx.pairings, selectedSires: selSires, selectedDams: selDams
  });
  const asOption = (d) => ({ id: d.id, label: `${d.call_name || '(unnamed)'}${d.is_archived ? ' (archived)' : ''}` });
  const sires = choices.sires.map(asOption);
  const dams = choices.dams.map(asOption);
  const isNew = ctx.mode === 'new';
  const programField = `<div class="field"><label>Program</label><select id="f-program">${programOptions(e.waitlist_program_id)}</select>
    <span class="field-hint">Only you assign programs. Families never pick one.</span></div>`;

  // A new application follows her form, in her order and wording, so typing one in
  // matches what families will see online. The public-list notice is shown so she
  // can tell the family.
  // Her matching notice heads the first preference question that filters offers.
  const matchKeys = matchingPrefKeys(ctx.config);
  const firstMatch = ctx.form.find((q) => matchKeys.includes(q.key));
  const matchNotice = `<div class="field field-wide"><div class="card" style="margin:0;padding:10px 12px;">
      <strong>Matching you with a pup</strong><p style="margin:6px 0 0;">${esc(MATCHING_NOTICE)}</p></div></div>`;
  const newForm = () => ctx.form.map((q) => {
    if (q.type === 'preference') return (q === firstMatch ? matchNotice : '') + prefField(q.key, e, q.label);
    if (q.type === 'notice') {
      return `<div class="field field-wide"><div class="card" style="margin:0;padding:10px 12px;background:var(--surface-2, transparent);">
        <strong>${esc(q.label)}</strong><p style="margin:6px 0 0;white-space:pre-line;">${esc(q.help)}</p>
        <span class="field-hint">Every applicant is told this. Make sure this family has heard it.</span></div></div>`;
    }
    return answerField(q, app[q.id]);
  }).join('');

  // Her FAQ heads the application, as families will see it online (Spec §15.8).
  const faq = formFaq(ctx.config);
  const faqHtml = faq.length ? `<div class="field field-wide"><div class="card" style="margin:0;padding:10px 12px;">
      <strong>Before you apply</strong>
      ${faq.map((x) => `<details style="margin-top:6px;"><summary>${esc(x.question || 'Question')}</summary><p style="margin:6px 0 0;white-space:pre-line;">${esc(x.answer)}</p></details>`).join('')}
      <span class="field-hint">Your FAQ, from the Application form page. Every applicant sees it first.</span></div></div>` : '';

  els.body.innerHTML = isNew ? `
    <div class="form-grid" style="margin-top:14px;">
      ${faqHtml}
      ${newForm()}
      <div class="field field-wide"><h3 style="margin:8px 0 0;">For you</h3></div>
      ${programField}
      <div class="field"><label>Applied</label><input id="f-applied_date" type="date" value="${esc(e.applied_date || todayYMD())}"></div>
      <div class="field field-wide"><label>Your notes</label><textarea id="f-notes">${esc(e.notes || '')}</textarea></div>
      <div class="field field-wide"><span class="field-hint">Change these questions on the <a href="waitlist-form.html?kennel=${encodeURIComponent(ctx.kennel.id)}">Application form</a> page.</span></div>
    </div>` : `
    <div class="form-grid" style="margin-top:14px;">
      <div class="field field-wide"><h3 style="margin:0;">Preferences</h3></div>
      ${['pref_sex', 'pref_breed', 'pref_purposes', 'pref_colors', 'ready_timing'].map((k) => prefField(k, e, k === 'ready_timing' ? ctx.form.find((q) => q.key === 'ready_timing')?.label : undefined)).join('')}
      ${programField}

      ${canListen ? `<div class="field field-wide"><h3 style="margin:8px 0 0;">Which litters</h3></div>
      <div class="field"><label>Listening for</label><select id="f-listen_mode">${options(WAITLIST_LISTEN_MODE, e.listen_mode || 'all')}</select>
        <span class="field-hint">Listen-only families are only offered litters by a sire or out of a dam they picked (or, with "All except", every litter but those). That never costs them their place or counts as a pass.</span></div>
      <div class="field field-wide" id="listen-picks"${(e.listen_mode || 'all') !== 'all' ? '' : ' hidden'}>
        <label>Sires</label><div class="check-group">${checkList(sires, selSires, 'data-sire')}</div>
        <label style="margin-top:8px;">Dams</label><div class="check-group">${checkList(dams, selDams, 'data-dam')}</div>
        <span class="field-hint">Any litter or pairing with one of these parents counts (or is skipped, with "All except"): picking a sire and a dam means either one, not only the two together.</span>
      </div>` : e.status === 'approved' ? `<div class="field field-wide"><span class="field-hint">Listening for certain sires and dams opens once they're on the list (fee received).</span></div>` : ''}
      <div class="field"><label>Paused until</label><input id="f-paused_until" type="date" value="${esc(e.paused_until || '')}">
        <span class="field-hint">Not offered pups until after this date. They keep their place, but don't appear on the public list while paused.</span></div>
      <div class="field"><label>Pause reason</label><input id="f-pause_reason" type="text" value="${esc(e.pause_reason || '')}"></div>

      <div class="field field-wide"><h3 style="margin:8px 0 0;">Fee</h3></div>
      <div class="field"><label>Fee amount</label><input id="f-fee_amount" type="number" min="0" step="0.01" value="${esc(e.fee_amount ?? '')}"></div>
      <div class="field"><label>Pay by</label><input id="f-fee_due_date" type="date" value="${esc(e.fee_due_date || '')}"></div>
      <div class="field"><label>Fee policy</label><select id="f-fee_credit_policy">${options(FEE_CREDIT_POLICY, e.fee_credit_policy || '', '—')}</select></div>
      ${e.fee_received_date ? `<div class="field"><label>Fee received</label><input id="f-fee_received_date" type="date" value="${esc(e.fee_received_date)}">
        <span class="field-hint">${isMovedByBreeder(e)
          ? 'You moved this family yourself, so their place stays where you put it. This date still sets when a readiness hold ends and the day the fee counts as income.'
          : 'This date is their place in line: changing it can move them up or down the list. It also sets when a readiness hold ends and the day the fee counts as income.'}</span></div>` : ''}

      <div class="field field-wide"><h3 style="margin:8px 0 0;">Application</h3>${e.contact_id ? '<span class="field-hint">Name, email and phone are what they applied with. The contact record holds the current ones.</span>' : ''}</div>
      <div class="field"><label>Applied</label><input id="f-applied_date" type="date" value="${esc(e.applied_date || '')}"></div>
      ${draftQuestions().map((q) => answerField(q, app[q.id])).join('')}
      <div class="field field-wide"><label>Your notes</label><textarea id="f-notes">${esc(e.notes || '')}</textarea></div>
    </div>`;

  const modeSel = document.getElementById('f-listen_mode');
  if (modeSel) modeSel.addEventListener('change', () => { document.getElementById('listen-picks').hidden = modeSel.value === 'all'; });
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
    pref_purposes: [...els.body.querySelectorAll('[data-purpose]')].filter((x) => x.checked).map((x) => x.dataset.purpose),
    pref_colors: val('f-pref_colors').split(',').map((s) => s.trim()).filter(Boolean),
    ready_timing: val('f-ready_timing') || null,
    waitlist_program_id: val('f-program') || null,
    application,
    application_questions: snapshotQuestions(questions),
    notes: val('f-notes')
  };
  if (has('f-applied_date')) out.applied_date = val('f-applied_date') || ctx.draft.applied_date || todayYMD();
  // The fee date is the position anchor (waitlistRules.anchorDate), so it can be
  // corrected but never blanked here: a cleared box keeps the date it had.
  if (has('f-fee_received_date') && val('f-fee_received_date')) out.fee_received_date = val('f-fee_received_date');
  if (has('f-paused_until')) {
    Object.assign(out, {
      paused_until: val('f-paused_until') || null,
      pause_reason: val('f-pause_reason').trim(),
      fee_amount: val('f-fee_amount') === '' ? null : Number(val('f-fee_amount')),
      fee_due_date: val('f-fee_due_date') || null,
      fee_credit_policy: val('f-fee_credit_policy') || null
    });
  }
  if (has('f-listen_mode')) {
    Object.assign(out, {
      listen_mode: val('f-listen_mode') || 'all',
      listen_sire_ids: [...document.querySelectorAll('[data-sire]:checked')].map((el) => el.dataset.sire),
      listen_dam_ids: [...document.querySelectorAll('[data-dam]:checked')].map((el) => el.dataset.dam)
    });
  }
  const missing = ctx.draft.contact_id ? [] : missingRequired(questions, application);
  // Readiness is mandatory on a new application (it decides the hold). An older
  // entry without one can still be edited; its page flags it as not answered.
  if (ctx.mode === 'new' && !out.ready_timing) missing.push(ctx.form.find((q) => q.key === 'ready_timing')?.label || 'Ready to buy');
  if (missing.length) throw new Error(`Please fill in: ${missing.map((m) => m.replace(/[?.!:]+$/, '')).join(', ')}.`);
  return out;
}

// --- Offers: make one from here, record how it ended (Spec §15.2) --------------------

const pupLabel = (d) => `${d.call_name}${d.sex ? ` (${SEX.find((s) => s.value === d.sex)?.label || d.sex})` : ''}`;
const kennelLitterPups = (litter) => [...ctx.dogsById.values()].filter((d) => d.litter_id === litter.id);
const familyNameById = (entryId) => {
  const x = ctx.kennelEntries.find((k) => k.id === entryId);
  return x ? entryName(x, ctx.contacts.find((c) => c.id === x.contact_id)) : 'another family';
};

// Every live litter of this kennel, with whether this family can be offered a turn
// starting from it now and, if not, why. `next` is who's first in line for that
// litter (null = nobody). One family holds a turn at a time across the kennel
// (Spec §16.1), so while anyone holds one, nothing can be offered.
function litterChoices(e) {
  const today = todayYMD();
  const opts = { today, config: ctx.config, programsById: ctx.programs };
  const [held] = openTurns(ctx.kennelOffers, ctx.kennel.id);
  return ctx.litters
    .filter((l) => !l.is_archived && LIVE_LITTER.includes(l.status))
    .map((l) => {
      const pups = kennelLitterPups(l);
      const offers = ctx.kennelOffers.filter((o) => o.litter_id === l.id);
      const eligible = eligiblePupsFor(e, l, pups, ctx.sales, opts);
      let blocked = '';
      if (held) {
        blocked = held.entry_id === e.id ? 'They hold the turn now.' : `${familyNameById(held.entry_id)} holds the turn now; one family at a time.`;
      } else if (turnSpent(offers, l.id, e.id)) blocked = 'They\'ve already had their turn on this litter.';
      else if (isReadyHeld(e, today, ctx.config)) blocked = readyHoldText(e, today, ctx.config);
      else if (isManuallyPaused(e, today)) blocked = 'They\'re paused.';
      else if (!isListeningFor(e, l)) blocked = e.listen_mode === 'except' ? 'They asked to skip litters from this sire or dam.' : 'They\'re only listening for litters from other sires/dams.';
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
    title: `Offer ${entryName(e, ctx.contact)} their turn`,
    confirmLabel: 'Offer the turn',
    bodyHtml: choices.length
      ? `${choices.map(rowHtml).join('')}
         <p class="field-hint">Their turn covers this litter and every other open litter they match; they pick one pup from any of them, or pass on all of them. They get ${esc(days)} days to pick a pup and send the deposit. Offering someone who isn't next doesn't change anyone's place; the next family ${ctx.config.auto_offer_on.length ? 'is up (offered automatically if you chose that in Waitlist settings)' : 'is up'} once this one is settled. Nothing is sent automatically, so tell them yourself.</p>`
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

// The turn-moves-on sentence for an outcome prompt: with automatic offers off for
// that moment (the default) nobody is offered; she's told who's next.
const turnNote = (outcome) => (autoOffers(ctx.config, outcome)
  ? 'The turn moves to the next eligible family.'
  : 'Nobody is offered automatically; you\'ll see who\'s next.');

async function onOfferOutcome(offer, outcome) {
  const e = ctx.entry;
  const name = entryName(e, ctx.contact);
  const litter = ctx.litters.find((l) => l.id === offer.litter_id);
  const pups = litter ? kennelLitterPups(litter) : [];

  if (outcome === 'pick') {
    const live = litter ? eligiblePupsFor(e, litter, pups, ctx.sales, { today: todayYMD(), config: ctx.config }) : [];
    if (!live.length) { await alertModal({ title: 'No pups available', message: 'None of the pups offered to them is still available.' }); return; }
    const out = await pickDialog({ offer, name, pups: live, pupLabel, carried: e.carried_payment || null });
    if (!out) return;
    await afterAction();
    const saleId = out.res.sale.id;
    const message = out.depositDone
      ? [`${name} is placed.`, ...offerChangeLines(out.res)].join('\n\n')
      : `${dogName(out.res.offer.chosen_dog_id)} is held for ${name} until ${fmtDate(offer.respond_by_date)}. Send them the deposit details (the sale's invoice is under Documents on this page). Record "Deposit received" when it arrives.`;
    if (await confirmModal({ title: out.depositDone ? 'Deposit received' : 'Pick recorded', message: `${message}\n\nOpen the sale?`, confirmLabel: 'Open the sale', cancelLabel: 'Stay here' })) {
      location.href = `sale.html?id=${encodeURIComponent(saleId)}`;
    }
    return;
  }
  if (outcome === 'deposit') {
    const res = await depositDialog({ offer, name, pupName: dogName(offer.chosen_dog_id), sale: ctx.sales.find((x) => x.id === offer.sale_id) || null, carried: e.carried_payment || null });
    if (!res) return;
    await afterAction();
    await alertModal({ title: `${name} is placed`, message: [`Deposit recorded for ${dogName(offer.chosen_dog_id)}.`, ...offerChangeLines(res)].join('\n\n') });
    return;
  }
  if (outcome === 'change') {
    const options = litter ? switchablePups(e, litter, pups, ctx.sales, { currentDogId: offer.chosen_dog_id, config: ctx.config }) : [];
    if (await changePickDialog({ offer, name, currentName: dogName(offer.chosen_dog_id), pups: options, pupLabel })) await afterAction();
    return;
  }
  if (outcome === 'undo') {
    const holder = openTurns(ctx.kennelOffers, ctx.kennel.id).find((t) => t.id !== turnIdOf(offer));
    const res = await undoPassDialog({ offer, name, holderName: holder ? familyNameById(holder.entry_id) : null, removed: e.status === 'removed' });
    if (!res) return;
    await afterAction();
    const back = res.offers.map((x) => ctx.litters.find((l) => l.id === x.litter_id)).filter(Boolean).map(litterLabel).join(', ');
    await alertModal({ title: 'Their turn is back', message: [`${name}'s turn is back (${back || 'this litter'}), with until ${fmtDate(res.offer.respond_by_date)} to pick and pay the deposit. Let them know; nothing is sent automatically.`, ...offerChangeLines(res)].join('\n\n') });
    return;
  }

  const lapse = offer.chosen_dog_id ? ` Their pick lapses: the sale is cancelled and ${dogName(offer.chosen_dog_id)} is available again.` : '';
  // A turn covers every open litter they matched (Spec §16.1): outcomes close all of it.
  const also = turnOffers(ctx.kennelOffers, turnIdOf(offer)).filter((o) => o.outcome === 'open' && o.id !== offer.id)
    .map((o) => ctx.litters.find((l) => l.id === o.litter_id)).filter(Boolean).map(litterLabel);
  const whole = also.length ? ` This closes their whole turn, including ${also.join(', ')}, and counts once.` : '';
  const prompts = {
    passed: { title: also.length ? `${name} passed on their whole turn?` : `${name} passed on this litter?`, message: `${turnNote('passed')}${whole}${lapse}`, confirmLabel: 'Record it' },
    no_response: offer.chosen_dog_id
      ? { title: `No deposit from ${name}?`, message: `Record that the deposit didn't arrive in time. It counts like no response. ${turnNote(closingTrigger(offer, 'no_response'))}${lapse}`, confirmLabel: 'Record it' }
      : { title: `${name} didn't respond in time?`, message: `${turnNote('no_response')}${whole}`, confirmLabel: 'Record it' },
    voided: { title: 'Void this turn?', message: `Use this if the offer was a mistake or the litter fell through. It never counts as a pass for ${name}, and the turn isn't moved on automatically.${also.length ? ` It voids their whole turn, including ${also.join(', ')}.` : ''}${lapse}`, confirmLabel: 'Void it' }
  };
  if (!(await confirmModal(prompts[outcome]))) return;
  const res = await actions.recordOutcome(offer.id, outcome);
  await afterAction();
  if (res.passes) {
    const msg = !res.passes.counted ? 'This doesn\'t count as a pass.'
      : res.removed ? `That was pass ${res.passes.used} of ${res.passes.max}, so they've been removed from the list. You can undo this for ${REMOVAL_UNDO_DAYS} days.`
      : `This counts as pass ${res.passes.used} of ${res.passes.max}. They keep their place.`;
    const changes = offerChangeLines(res);
    await alertModal({ title: 'Recorded', message: [msg, ...changes].join('\n\n') });
  }
}

// The buttons under one offer: what she can do with it now.
function offerButtons(o, today) {
  const btn = (oc, label, primary = false, title = '') => `<button class="btn ${primary ? 'btn-primary ' : ''}btn-sm" data-oc="${oc}" data-offer="${esc(o.id)}"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</button>`;
  let list = [];
  if (isAwaitingDeposit(o)) {
    list = [btn('deposit', 'Deposit received…', true), btn('change', 'Change pup…'), btn('passed', 'Passed'), btn('no_response', 'No deposit'), btn('voided', 'Void')];
  } else if (o.outcome === 'open') {
    list = [btn('pick', 'Picked a pup…', true), btn('passed', 'Passed'), btn('no_response', 'No response'), btn('voided', 'Void')];
  } else if (canSwitchAcceptedPick(o, ctx.kennelOffers)) {
    list = [btn('change', 'Change pup…', false, 'Allowed until the next family is offered a turn')];
  } else if (!undoPassBlocker(o, ctx.entry, today)) {
    list = [btn('undo', 'Undo…', false, 'Erase this and give them their turn back')];
  }
  return list.length ? `<div class="pill-row" style="margin-top:6px;">${list.join('')}</div>` : '';
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
          const sale = o.sale_id && isAwaitingDeposit(o) ? ` · <a href="sale.html?id=${encodeURIComponent(o.sale_id)}">sale</a>` : '';
          const status = isAwaitingDeposit(o)
            ? `<span class="badge badge-purple">Picked ${esc(dogName(o.chosen_dog_id))}</span> <span class="faint">deposit pending${sale}</span>`
            : `${badge(WAITLIST_OFFER_OUTCOME, o.outcome)}${o.chosen_dog_id ? ` ${esc(dogName(o.chosen_dog_id))}` : ''}${o.pass_reason ? ` <span class="faint">${esc(reasonText(o.pass_reason))}</span>` : ''}`;
          return `<tr><td>${l ? `<a href="litter.html?id=${encodeURIComponent(l.id)}">${esc(litterLabel(l))}</a>` : none}</td>
            <td>${esc(fmtDate(o.offered_date))}</td><td>${o.respond_by_date ? esc(fmtDate(o.respond_by_date)) : none}${overdue ? ' <span class="badge badge-red">Deadline passed</span>' : ''}</td>
            <td>${status}${offerButtons(o, today)}</td>
            <td>${o.counts_as_pass ? '<span class="badge badge-amber">Counts</span>' : none}${o.notes ? ` <span class="faint" title="${esc(o.notes)}">ⓘ</span>` : ''}</td></tr>`;
        }).join('')
      }</tbody></table></div>
      <p class="field-hint" style="margin-bottom:0;">An offer is theirs to accept AND pay: a picked pup is held for them, but it's only theirs once the deposit arrives by the respond-by date.</p>
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
  for (const o of ctx.offers.filter((x) => isAwaitingDeposit(x) && x.sale_id && !x.is_archived)) {
    docs.push({ label: `Puppy invoice for ${dogName(o.chosen_dog_id)} (deposit pending)`, source: 'sale', id: o.sale_id, doc: 'invoice' });
  }
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

// Narrowing an answer while the family has an open offer, or is next for a litter,
// is what a family could use to dodge a pass (Spec §15.9), so she confirms it.
// Widening, or narrowing with nothing at stake, saves without asking.
async function confirmNarrowing(changes) {
  const e = ctx.entry;
  const fx = prefChangeEffect(e, changes, {
    litters: ctx.litters.filter((l) => !l.is_archived && LIVE_LITTER.includes(l.status)),
    entries: ctx.kennelEntries, offers: ctx.kennelOffers, pups: [...ctx.dogsById.values()], sales: ctx.sales,
    today: todayYMD(), config: ctx.config, programsById: ctx.programs
  });
  if (!fx.openOffers.length && !fx.skippedLitters.length) return true;
  const lines = [`Narrower: ${fx.narrowed.map((f) => PREF_FIELD_LABEL[f]).join(', ')}.`];
  for (const l of fx.skippedLitters) lines.push(`They're next for ${litterLabel(l)}. This skips them there, with no pass counted.`);
  for (const o of fx.openOffers) {
    const l = ctx.litters.find((x) => x.id === o.litter_id);
    lines.push(`Their open offer on ${l ? litterLabel(l) : 'a litter'}${o.respond_by_date ? ` (until ${fmtDate(o.respond_by_date)})` : ''} stays open. Passing on it still counts as a pass.`);
  }
  lines.push('Make sure this is a real change and not a way around a pass. It goes in their answer history.');
  return confirmModal({ title: `Narrow what ${entryName(e, ctx.contact)} asked for?`, message: lines.join('\n\n'), confirmLabel: 'Save anyway' });
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
    if (!(await confirmNarrowing(changes))) return;
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
    if (!(await confirmModal({ title: `${verb} this entry?`, message: e.is_archived ? '' : `Archived entries are hidden from the waitlist and drop off the list.${openOfferWarning()}`, confirmLabel: verb }))) return;
    try {
      if (e.is_archived) {
        await waitlistEntryRepo.unarchive(e.id);
        await afterAction();
      } else {
        const res = await actions.archiveEntry(e.id);
        await afterAction();
        await reportLeaving(res);
      }
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
  if (ctx.mode === 'view') { renderStatus(); renderOnline(); renderView(); els.status.hidden = false; }
  else { els.status.hidden = true; els.online.hidden = true; renderEdit(); }
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
