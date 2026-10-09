// waitlistUI.js — page-side helpers shared by the three Pro-only waitlist pages
// (waitlist / waitlist-entry / waitlist-programs; Waitlist Spec §11, End-State
// guide §29). Which kennel's list a page shows, the kennel picker, and the
// one-line preference summary, and the offer dialogs (pick a pup, deposit received,
// change pup, undo a pass) shared by the family page and the litter's picks panel,
// and "put them back in line" for a lost pup (shared with the Sale page, which
// imports this module only when editionFlags.waitlist is on).
// Pro-only like the pages (proPages.js).
import { ownKennels, getActiveKennelId } from '../data/kennelScope.js';
import { getMyKennelId } from '../data/settings.js';
import { waitlistEntryRepo } from '../data/waitlistEntryRepo.js';
import { WAITLIST_OPEN_STATUSES } from '../data/vocab.js';
import { esc, fmtDate, fmtMoney, todayYMD, confirmModal, alertModal, promptModal } from './ui.js';
import { PLACEMENT_TYPE, descriptor } from '../data/vocab.js';
import { readyCheck, isManuallyPaused, isReadyHeld, isListenOnly, readyFromDate, soonNoticeText, entryName, waitlistConfig, autoOffers, overallPositions, describeOfferChanges } from '../data/waitlistRules.js';
import { isWaitlistOnlineOffered, statusPageLink } from '../data/cloud/cloudConfig.js';
import { editionFlags } from '../data/editionConfig.js';
import { markSoonNotified, recordPick, recordOutcome, confirmDeposit, changePick, undoPass, lostSaleFamilyFor, restoreAfterLostSale } from '../data/waitlistActions.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { waitlistProgramRepo } from '../data/waitlistProgramRepo.js';
import { paidOnSale, getSaleFeeCredit } from '../data/incomeView.js';
import { DemoModeError } from '../data/demoMode.js';

// A family's status-page link (W2 Plan §8), or null while the list isn't online
// (or the waitlist online isn't offered here). Only builds the link: no network.
export function statusLinkFor(entry, kennel) {
  if (!editionFlags.waitlist || !isWaitlistOnlineOffered() || !entry?.status_token) return null;
  if (!kennel || !waitlistConfig(kennel).online) return null;
  return statusPageLink(entry.status_token);
}

// Copy a link for her to paste into Messenger or a text. Where the clipboard
// isn't allowed (plain http on a test server), the link is shown to copy by hand.
export async function copyLink(link, btn = null, { title = 'Copy this link' } = {}) {
  try {
    await navigator.clipboard.writeText(link);
    if (btn) {
      const label = btn.textContent;
      btn.textContent = 'Copied ✓';
      setTimeout(() => { btn.textContent = label; }, 2000);
    }
  } catch {
    await promptModal({ title, message: 'Select the link and copy it.', defaultValue: link, confirmLabel: 'Done', cancelLabel: 'Close' });
  }
}

// The kennel whose list to show, in priority order: an explicit ?kennel= id (one
// of your own), the active kennel scope, the own kennel with the most open
// waitlist entries (so "All kennels" lands on the list you actually use), your
// own kennel from setup, then the first alphabetically. One list per kennel
// (Spec §0), so a page always shows exactly one. Returns { kennel, own } —
// kennel null only when you have no own kennel at all.
export async function resolveWaitlistKennel(requestedId) {
  const own = (await ownKennels()).sort((a, b) => (a.kennel_name || '').localeCompare(b.kennel_name || ''));
  const pick = (id) => own.find((k) => k.id === id) || null;
  const explicit = pick(requestedId) || pick(getActiveKennelId());
  if (explicit) return { kennel: explicit, own };
  const counts = new Map();
  for (const e of await waitlistEntryRepo.getAll()) {
    if (WAITLIST_OPEN_STATUSES.includes(e.status)) counts.set(e.kennel_id, (counts.get(e.kennel_id) || 0) + 1);
  }
  const busiest = [...own].sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0))[0];
  const kennel = (busiest && counts.get(busiest.id) ? busiest : null) || pick(getMyKennelId()) || own[0] || null;
  return { kennel, own };
}

// A kennel <select> when you have more than one own kennel (silent otherwise —
// the same "invisible until a second kennel exists" posture as the scope UI).
// Changing it reloads the page with ?kennel=.
export function mountKennelPicker(host, { kennel, own }) {
  if (!host) return;
  if (own.length < 2) { host.innerHTML = ''; return; }
  host.innerHTML = `
    <div class="field" style="max-width:320px;margin-bottom:12px;">
      <label for="wl-kennel">Kennel's list</label>
      <select id="wl-kennel">${own.map((k) => `<option value="${esc(k.id)}"${k.id === kennel.id ? ' selected' : ''}>${esc(k.kennel_name)}</option>`).join('')}</select>
    </div>`;
  host.querySelector('#wl-kennel').addEventListener('change', (e) => {
    const url = new URL(location.href);
    url.searchParams.set('kennel', e.target.value);
    location.href = url.toString();
  });
}

const SEX_LABEL = { male: 'Male', female: 'Female' };

// "Female · Boston Terrier · Show · brindle" — or "Any pup" when nothing is set.
// Returns escaped HTML.
export function prefsSummary(entry) {
  const parts = [];
  if (SEX_LABEL[entry.pref_sex]) parts.push(SEX_LABEL[entry.pref_sex]);
  if (entry.pref_breed) parts.push(entry.pref_breed);
  if (entry.pref_placement_type) parts.push(descriptor(PLACEMENT_TYPE, entry.pref_placement_type).label);
  const colors = Array.isArray(entry.pref_colors) ? entry.pref_colors : [];
  if (colors.length) parts.push(colors.join(', '));
  return parts.length ? esc(parts.join(' · ')) : '<span class="faint">Any pup</span>';
}

// Small flags for the list row: paused / not ready yet / listen-only. Escaped HTML.
export function entryFlags(entry, today, config = null) {
  const out = [];
  if (isManuallyPaused(entry, today)) out.push(`<span class="badge badge-amber" title="${esc(entry.pause_reason || '')}">Paused to ${esc(entry.paused_until)}</span>`);
  if (isReadyHeld(entry, today, config)) {
    out.push(today < readyFromDate(entry)
      ? `<span class="badge badge-amber" title="They said they won't be ready to buy yet, so they aren't offered pups until then.">Not ready until ${esc(readyFromDate(entry))}</span>`
      : `<span class="badge badge-amber" title="${esc(readyHoldText(entry, today, config))}">Ready now? ${entry.ready_check?.answer === 'no' ? 'Not yet' : 'No answer'}</span>`);
  }
  if (isListenOnly(entry)) out.push(`<span class="badge badge-blue">${entry.listen_mode === 'except' ? 'Skips some litters' : 'Listen-only'}</span>`);
  return out.join(' ');
}

// Why a family is held by their readiness answer (Spec §15.8, §16.7). Plain text.
export function readyHoldText(entry, today, config = null) {
  const from = readyFromDate(entry);
  if (!from) return '';
  if (today < from) return `They said they won't be ready to buy until about ${fmtDate(from)}.`;
  const rc = readyCheck(entry, today, config);
  if (!rc) return '';
  if (rc.answer === 'no') return `Asked "Ready now?", they said not until ${fmtDate(entry.ready_check.until)}: their pause request is waiting for you.`;
  if (rc.answer === 'yes') return '';
  return `Their readiness hold ended ${fmtDate(rc.asked)}; they haven't answered "Ready now?" yet${rc.answer_by ? `, and will be removed after ${fmtDate(rc.answer_by)}` : ''}.`;
}

// A form dialog in the app's modal chrome (same markup as ui.js's dialogs).
// `onConfirm(overlay)` reads the fields and does the work; throwing shows the
// message inside the dialog and keeps it open. Resolves true once confirmed,
// false on cancel/backdrop. `onOpen(overlay)` (optional) wires live controls.
export function formModal({ title, bodyHtml, confirmLabel = 'Save', cancelLabel = 'Cancel', danger = false, onConfirm }, onOpen = null) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
        <h2 style="margin-top:0;">${esc(title)}</h2>
        <div data-fm-error></div>
        ${bodyHtml}
        <div class="form-actions">
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-fm-confirm>${esc(confirmLabel)}</button>
          <button class="btn" data-fm-cancel>${esc(cancelLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    if (onOpen) onOpen(overlay);
    const done = (val) => { overlay.remove(); resolve(val); };
    const confirmBtn = overlay.querySelector('[data-fm-confirm]');
    confirmBtn.addEventListener('click', async () => {
      if (confirmBtn.disabled) return;
      confirmBtn.disabled = true;
      try {
        await onConfirm(overlay);
        done(true);
      } catch (e) {
        overlay.querySelector('[data-fm-error]').innerHTML = `<div class="inline-error">${esc(e.message || String(e))}</div>`;
        confirmBtn.disabled = false;
      }
    });
    overlay.querySelector('[data-fm-cancel]')?.addEventListener('click', () => done(false)); // a dialog may drop Cancel (textFamilyDialog)
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
  });
}

// --- "It's almost your turn" (Spec §15.5) ------------------------------------------

// Where a notice goes. W1 has no server, so the only delivery is her own email app
// (a mailto: with every family BCC'd, so nobody sees anyone else's address) or the
// copied addresses. W2 adds the family's status page and a sent-for-her email,
// taking the same { subject, body, text, recipients } this dialog builds.
export function soonNoticeMailto({ subject, body, recipients }) {
  const bcc = recipients.map((r) => r.email).filter(Boolean).map(encodeURIComponent).join(',');
  return `mailto:?bcc=${bcc}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// Above this some phones and mail apps drop or truncate a mailto: link.
const MAILTO_SAFE_LENGTH = 1800;

// The "almost your turn" dialog. `rows` come from soonFamiliesForLitter /
// soonFamiliesForKennel ({ entry, inFlight, litters? }); `litterLabelOf(row)`
// describes which litter(s) a row is within reach of, `litterIdsOf(row)` their ids.
// In-flight families (an open offer anywhere) are listed for her information but
// can't be selected. Opening the email or copying the addresses stamps the ticked
// families as told (markSoonNotified); families told before are shown, not skipped.
export function openSoonNotice({ kennel, config, rows, contactsById, litterLabelOf, litterIdsOf }) {
  const nameOf = (e) => entryName(e, contactsById.get(e.contact_id));
  const emailOf = (e) => String(contactsById.get(e.contact_id)?.email || e.application?.email || '').trim();
  const send = rows.filter((r) => !r.inFlight);
  const held = rows.filter((r) => r.inFlight);
  const { text } = soonNoticeText(config, kennel.kennel_name);

  const sendRows = send.map((r, i) => {
    const email = emailOf(r.entry);
    return `<label class="check-inline" style="display:block;margin:6px 0;">
        <input type="checkbox" data-sn="${i}"${email ? ' checked' : ' disabled'}>
        <strong>${esc(nameOf(r.entry))}</strong> <span class="faint">${email ? esc(email) : 'no email on file: tell them yourself'}</span>
        <div class="faint" style="margin-left:22px;">${esc(litterLabelOf(r))}${r.entry.soon_notified_date ? ` · <span class="badge badge-neutral">Told ${esc(fmtDate(r.entry.soon_notified_date))}</span>` : ''}</div></label>`;
  }).join('');
  const heldHtml = held.length
    ? `<p class="field-hint">Not included, because they already have an offer to answer (they still count toward the pups): ${esc(held.map((r) => nameOf(r.entry)).join(', '))}.</p>`
    : '';

  const done = formModal({
    title: "It's almost your turn",
    confirmLabel: 'Done',
    bodyHtml: send.length ? `
      <p class="field-hint" style="margin-top:0;">These families' turn should come up for the pups available now: one family per pup, in line order, skipping anyone paused, listening only for other sires or dams, or with no matching pup.</p>
      ${sendRows}${heldHtml}
      <div class="field" style="margin-top:10px;"><label for="sn-text">Message</label>
        <textarea id="sn-text" style="width:100%;min-height:170px;font-family:inherit;">${esc(text)}</textarea>
        <span class="field-hint">The first line is the email subject. Change the standing wording in Waitlist settings.</span></div>
      <div class="pill-row" style="margin-top:8px;">
        <a class="btn btn-primary" id="sn-mail" href="#">Open in my email</a>
        <button class="btn" id="sn-copy" type="button">Copy email addresses</button>
      </div>
      <p class="field-hint" id="sn-hint">Families are BCC'd, so nobody sees anyone else's address. Opening the email or copying the addresses records today's date on each ticked family. Nothing is sent from KennelOS yet; once online status pages arrive, this will show there too.</p>`
      : `<p class="muted">Nobody to tell right now.</p>${heldHtml}`,
    onConfirm: async () => {}
  });
  // formModal renders synchronously, so the dialog is in the DOM now.
  const overlays = document.querySelectorAll('.modal-overlay');
  const overlay = overlays[overlays.length - 1];
  if (overlay && overlay.querySelector('#sn-mail')) wireSoonNotice(overlay, { kennel, send, emailOf, litterIdsOf });
  return done;
}

// The dialog's live controls: the mailto link follows the ticked families and the
// edited message; Copy puts the ticked addresses on the clipboard.
function wireSoonNotice(overlay, { kennel, send, emailOf, litterIdsOf }) {
  const picked = () => [...overlay.querySelectorAll('[data-sn]')].filter((c) => c.checked)
    .map((c) => send[Number(c.dataset.sn)])
    .map((r) => ({ entry: r.entry, email: emailOf(r.entry), litterIds: litterIdsOf(r) }));
  // Record who was told. Not awaited before the mail app opens: the tap on the real
  // mailto: anchor must stay the activating gesture (iOS), so the write runs alongside.
  const record = (recipients) => markSoonNotified(new Map(recipients.map((r) => [r.entry.id, r.litterIds])))
    .catch((err) => {
      // Demo blocks every save; its own message says so plainly.
      hint.textContent = err instanceof DemoModeError ? err.message : `Couldn't record who was told: ${err.message || err}`;
    });
  const notice = () => {
    const { subject, body } = soonNoticeText({ soon_notice_text: overlay.querySelector('#sn-text').value }, kennel.kennel_name);
    return { subject, body, recipients: picked() };
  };
  const mail = overlay.querySelector('#sn-mail');
  const hint = overlay.querySelector('#sn-hint');
  const baseHint = hint.textContent;
  const refresh = () => {
    const n = notice();
    const href = soonNoticeMailto(n);
    mail.href = href;
    mail.classList.toggle('disabled', !n.recipients.length);
    hint.textContent = href.length > MAILTO_SAFE_LENGTH
      ? 'That many addresses may be too long for one email link on some phones. If your email app opens without them, use Copy email addresses and paste them into BCC.'
      : baseHint;
  };
  overlay.querySelectorAll('[data-sn], #sn-text').forEach((el) => el.addEventListener('input', refresh));
  overlay.querySelectorAll('[data-sn]').forEach((el) => el.addEventListener('change', refresh));
  mail.addEventListener('click', (e) => {
    const n = notice();
    if (!n.recipients.length) { e.preventDefault(); return; }
    record(n.recipients);
  });
  overlay.querySelector('#sn-copy').addEventListener('click', async () => {
    const { recipients } = notice();
    const list = recipients.map((r) => r.email).join(', ');
    try { await navigator.clipboard.writeText(list); overlay.querySelector('#sn-copy').textContent = 'Copied ✓'; }
    catch { hint.textContent = `Copying isn't allowed here. The addresses: ${list}`; }
    if (recipients.length) record(recipients);
  });
  refresh();
}

// --- Offer dialogs (Spec §6.4–§6.5) ---------------------------------------------------
// Each runs its dialog and the write, and resolves to the action's result, or null
// when she cancels. `pupLabel(dog)` names a pup in a dropdown.

const pupOptions = (pups, pupLabel) => pups.map((p) => `<option value="${esc(p.id)}">${esc(pupLabel(p))}</option>`).join('');

// The family picked a pup. Usually that's all she records now: a deposit-pending
// Sale holds the pup and the offer stays open until the deposit arrives (their
// respond-by date is the deadline). Ticking "deposit received" does both at once.
// Resolves { res, depositDone } or null.
// `carried` (the entry's carried_payment, Spec §16.11): what they'd paid on a pup
// they lost. It's already in hand, so the deposit box starts ticked with it.
export async function pickDialog({ offer, name, pups, pupLabel, carried = null }) {
  let out = null;
  const carriedHint = carried ? `<p class="field-hint">${esc(fmtMoney(carried.amount))} they paid on a pup they lost (${esc(fmtDate(carried.date))}) is their deposit on this one.</p>` : '';
  const ok = await formModal({
    title: `${name} picked a pup`,
    confirmLabel: 'Record their pick',
    bodyHtml: `<div class="field"><label>Which pup?</label><select id="pk-dog">${pupOptions(pups, pupLabel)}</select></div>
      <div class="field"><label>Date</label><input id="pk-date" type="date" value="${esc(todayYMD())}"></div>
      <label class="check-inline" style="display:block;margin:8px 0;"><input id="pk-paid" type="checkbox"${carried ? ' checked' : ''}> Their deposit is already in</label>
      <div id="pk-paid-fields" class="form-grid"${carried ? '' : ' hidden'}>
        <div class="field"><label>Deposit received</label><input id="pk-dep-date" type="date" value="${esc(carried?.date || todayYMD())}"></div>
        <div class="field"><label>Amount</label><input id="pk-dep-amount" type="number" min="0" step="0.01" placeholder="The litter's expected deposit" value="${esc(carried?.amount ?? '')}"></div>
      </div>
      ${carriedHint}
      <p class="field-hint">Creates a Sale (deposit pending, price and deposit from the litter's expected amounts) to hold the pup. It isn't theirs until the deposit arrives${offer.respond_by_date ? `, by <strong>${esc(fmtDate(offer.respond_by_date))}</strong>` : ''}. Until then you can switch the pup, and nobody else is offered this litter. No deposit by then counts as no response.</p>`,
    onConfirm: async (o) => {
      const chosenDogId = o.querySelector('#pk-dog').value;
      const date = o.querySelector('#pk-date').value || todayYMD();
      if (o.querySelector('#pk-paid').checked) {
        out = { depositDone: true, res: await recordOutcome(offer.id, 'accepted', {
          chosenDogId, date,
          depositDate: o.querySelector('#pk-dep-date').value || date,
          depositAmount: o.querySelector('#pk-dep-amount').value
        }) };
      } else {
        out = { depositDone: false, res: await recordPick(offer.id, { chosenDogId, date }) };
      }
    }
  }, (o) => {
    const box = o.querySelector('#pk-paid');
    box.addEventListener('change', () => { o.querySelector('#pk-paid-fields').hidden = !box.checked; });
  });
  return ok ? out : null;
}

// The deposit for their pick arrived: they're placed and the turn moves on.
// `sale` (the held Sale, may be null) prefills the amount.
// `carried` (the entry's carried_payment): money they'd already paid on a pup they
// lost, which the held Sale took as its deposit — prefills the date it was paid.
export async function depositDialog({ offer, name, pupName, sale, carried = null }) {
  let res = null;
  const ok = await formModal({
    title: `${name}'s deposit received`,
    confirmLabel: 'Deposit received',
    bodyHtml: `<p style="margin-top:0;">For <strong>${esc(pupName)}</strong>.</p>
      <div class="form-grid">
        <div class="field"><label>Date received</label><input id="dp-date" type="date" value="${esc((sale && sale.deposit_date) || carried?.date || todayYMD())}"></div>
        <div class="field"><label>Amount</label><input id="dp-amount" type="number" min="0" step="0.01" value="${esc(sale?.deposit_amount ?? '')}"></div>
      </div>
      <p class="field-hint">Marks the sale deposit paid and the pup placed, and moves ${esc(name)} off the list as placed. Any other open offers they have are voided.${sale && sale.deposit_amount != null ? ` Expected deposit: ${esc(fmtMoney(sale.deposit_amount))}.` : ''}${carried ? ` ${esc(fmtMoney(carried.amount))} of it is what they paid on a pup they lost (${esc(fmtDate(carried.date))}).` : ''}</p>`,
    onConfirm: async (o) => {
      res = await confirmDeposit(offer.id, { date: o.querySelector('#dp-date').value || todayYMD(), amount: o.querySelector('#dp-amount').value });
    }
  });
  return ok ? res : null;
}

// Switch the pup they picked (they clicked the wrong one). `pups` are the pups
// they could switch to (waitlistRules.switchablePups).
export async function changePickDialog({ offer, name, currentName, pups, pupLabel }) {
  if (!pups.length) {
    await alertModal({ title: 'No other pup to switch to', message: `No other available pup in this litter matches what ${name} wants.` });
    return null;
  }
  let res = null;
  const ok = await formModal({
    title: `Change ${name}'s pup`,
    confirmLabel: 'Switch pup',
    bodyHtml: `<p style="margin-top:0;">They picked <strong>${esc(currentName)}</strong>.</p>
      <div class="field"><label>Switch to</label><select id="cp-dog">${pupOptions(pups, pupLabel)}</select></div>
      <p class="field-hint">The same sale moves to the new pup, and ${esc(currentName)} is available again. The price and deposit follow the new pup's expected amounts unless you changed them on the sale.</p>`,
    onConfirm: async (o) => { res = await changePick(offer.id, { chosenDogId: o.querySelector('#cp-dog').value }); }
  });
  return ok ? res : null;
}

// Undo a pass / no response: the family's turn is back (every litter of it they
// still match, Spec §16.1). `holderName` names the family holding the kennel's turn
// now (their turn is voided), or null.
export async function undoPassDialog({ offer, name, holderName = null, removed = false }) {
  const what = offer.outcome === 'passed' ? 'pass' : 'no response';
  const lines = [
    `${name}'s ${what} is erased and doesn't count. Their turn reopens with a new respond-by date, on every litter of it they still match.`,
    removed ? 'That pass had removed them from the list, so they go back on it in their old place.' : '',
    holderName ? `${holderName} holds the turn now. Their turn will be voided (not a pass), and they're next again after ${name}. Let them know.` : ''
  ].filter(Boolean);
  if (!(await confirmModal({ title: `Undo ${name}'s ${what}?`, message: lines.join('\n\n'), confirmLabel: 'Undo it' }))) return null;
  return undoPass(offer.id);
}

// --- A lost pup (Spec §16.11) ------------------------------------------------------

// Ask whether to put a waitlist family back in line after their pup was lost (its
// sale voided, or returned for a health problem), and do it. Asked as she marks the
// sale (the Sale page) and offered on the family's page until she does. `asStatus`
// is the status the sale had before (the Sale page knows it), so what they'd paid
// is read as of then. Resolves the action's result, or null (not a waitlist
// family's lost pup, or she said not now).
export async function restoreLostPupDialog({ saleId, asStatus = null }) {
  const found = await lostSaleFamilyFor(saleId);
  if (!found) return null;
  const { kind, entry, sale } = found;
  const [kennel, contact, pup, programsById, kennelEntries, feeCredit] = await Promise.all([
    kennelRepo.getById(entry.kennel_id),
    entry.contact_id ? contactRepo.getById(entry.contact_id) : null,
    dogRepo.getById(sale.dog_id),
    waitlistProgramRepo.getMapForKennel(entry.kennel_id),
    waitlistEntryRepo.getByKennel(entry.kennel_id),
    getSaleFeeCredit(sale.id)
  ]);
  const config = waitlistConfig(kennel);
  const name = entryName(entry, contact);
  const pupName = pup?.call_name || 'their pup';
  const paid = paidOnSale(sale, { feeCredit, asStatus });
  const asActive = kennelEntries.map((e) => (e.id === entry.id ? { ...e, status: 'active' } : e));
  const pos = overallPositions(asActive, entry.kennel_id, programsById).get(entry.id);
  const total = overallPositions(asActive, entry.kennel_id, programsById).size;
  const intro = kind === 'placed'
    ? `${esc(name)} goes back on the list in their original place, <strong>#${esc(pos)} of ${esc(total)}</strong> by the date their fee came in, with their passes as they were. They can be offered ${esc(pupName)}'s litter again.`
    : `${esc(name)} picked ${esc(pupName)} and still holds the turn. Their pick is cleared and the turn gets a new respond-by date so they can pick another pup.`;
  const next = kind === 'placed'
    ? (autoOffers(config, 'restored')
      ? 'Automatic offers are on for this, so if nobody holds a turn the next one is offered now (to them, if they\'re next).'
      : 'Nobody is offered automatically; you\'ll be told who\'s next.')
    : '';
  const credit = feeCredit > 0 && kind === 'placed'
    ? `<p class="field-hint">Their ${esc(fmtMoney(feeCredit))} application fee stays credited toward their next pup.</p>` : '';
  const money = paid > 0 ? `
      <p style="margin-bottom:4px;">They've paid <strong>${esc(fmtMoney(paid))}</strong> on ${esc(pupName)}'s sale.</p>
      <label class="check-inline" style="display:block;"><input type="radio" name="lp-money" value="carry" checked> Carry it to their next pup</label>
      <div class="field" id="lp-amount-field" style="margin:4px 0 8px 24px;"><label>Amount to carry</label><input id="lp-amount" type="number" min="0" step="0.01" value="${esc(paid.toFixed(2))}"></div>
      <label class="check-inline" style="display:block;"><input type="radio" name="lp-money" value="refund"> I'm refunding it</label>
      <p class="field-hint">Carried, it becomes the deposit on the pup they pick next. Refunded, nothing more is recorded; note the refund on the sale if you like. Either way it isn't counted as income on this sale.</p>` : '';
  let res = null;
  const ok = await formModal({
    title: kind === 'placed' ? `Put ${name} back in line?` : `Give ${name} their turn back?`,
    confirmLabel: kind === 'placed' ? 'Put them back in line' : 'Give their turn back',
    cancelLabel: 'Not now',
    bodyHtml: `<p style="margin-top:0;">${intro}</p>${next ? `<p class="field-hint">${esc(next)}</p>` : ''}${credit}${money}`,
    onConfirm: async (o) => {
      const choice = o.querySelector('input[name="lp-money"]:checked')?.value;
      const amount = choice === 'carry' ? Number(o.querySelector('#lp-amount').value) : 0;
      if (choice === 'carry' && !(amount > 0)) throw new Error('Enter the amount to carry, or choose "I\'m refunding it".');
      res = await restoreAfterLostSale(sale.id, { carry: amount > 0 ? { amount } : null });
    }
  }, (o) => {
    for (const r of o.querySelectorAll('input[name="lp-money"]')) {
      r.addEventListener('change', () => { o.querySelector('#lp-amount-field').hidden = r.value !== 'carry' || !r.checked; });
    }
  });
  if (!ok) return null;
  const [entries, litters, dogs] = await Promise.all([
    waitlistEntryRepo.getByKennel(entry.kennel_id),
    litterRepo.getAll({ includeArchived: true }),
    dogRepo.getAll({ includeArchived: true })
  ]);
  const familyNames = new Map(await Promise.all(entries.map(async (e) => [e.id, entryName(e, e.contact_id ? await contactRepo.getById(e.contact_id) : null)])));
  const dogName = (id) => dogs.find((d) => d.id === id)?.call_name || '—';
  const litterOf = (id) => { const l = litters.find((x) => x.id === id); return l ? (l.nickname || `${dogName(l.dam_id)} × ${dogName(l.sire_id)}`) : 'A litter'; };
  const lines = kind === 'placed'
    ? [`${name} is back on the list at #${pos}.`]
    : res.offers.length
      ? [`${name}'s turn is open again on ${res.offers.map((x) => litterOf(x.litter_id)).join(', ')}: respond by ${fmtDate(res.offers[0].respond_by_date)}. Let them know.`]
      : [`No other pup matches ${name} in that turn, so it ended (not a pass). They keep their place.`];
  lines.push(...describeOfferChanges(kind === 'placed' ? res : { ...res, voided: [] }, { nameOf: (id) => familyNames.get(id) || 'the next family', litterOf, fmtDate }));
  await alertModal({ title: kind === 'placed' ? `${name} is back in line` : `${name}'s turn is back`, message: lines.join('\n\n') });
  return res;
}

// --- Texting a family (decided 2026-10-08) -------------------------------------------
// The app never sends a text. This puts the message in front of her ready to send
// from whichever app she likes, so it can come from a business number (Google
// Voice) rather than her own:
//  - Share…: the phone's share sheet, with the message in it — pick Google Voice
//    (or any app), then the family inside it;
//  - Copy message / Open Google Voice: copies it and opens Google Voice on the web
//    to paste (no Google Voice link can fill in a number and a message);
//  - Texting app: an sms: link with the number and message filled in, which always
//    opens the phone's DEFAULT texting app (on an iPhone, Messages and her own number).
// `message` is a suggestion she can edit first. It carries their status page link
// when the list is online (the caller builds it), and every button sends the box as
// it stands, link included. The box grows to fit so the link is always in view.
const GOOGLE_VOICE_URL = 'https://voice.google.com/u/0/messages';

function smsHref(phone, body) {
  const num = String(phone || '').replace(/[^\d+]/g, '');
  // iOS reads `&body=`, everyone else `?body=`.
  const sep = /iPad|iPhone|iPod/.test(globalThis.navigator?.userAgent || '') ? '&' : '?';
  return `sms:${num}${sep}body=${encodeURIComponent(body)}`;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

export async function textFamilyDialog({ name, phone = '', message = '' }) {
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  await formModal({
    title: `Text ${name}`,
    confirmLabel: 'Done',
    bodyHtml: `
      <p style="margin-top:0;">${phone
        ? `To <strong>${esc(phone)}</strong> <button class="btn btn-sm" type="button" data-tx="copy-number">Copy number</button>`
        : '<span class="faint">No phone number on file for them.</span>'}</p>
      <div class="field"><label for="tx-body">Message</label><textarea id="tx-body" style="min-height:150px;">${esc(message)}</textarea></div>
      <div class="pill-row" style="margin:8px 0;">
        ${canShare ? '<button class="btn btn-primary btn-sm" type="button" data-tx="share">Share…</button>' : ''}
        <button class="btn btn-sm${canShare ? '' : ' btn-primary'}" type="button" data-tx="copy">Copy message</button>
        <button class="btn btn-sm" type="button" data-tx="voice">Copy &amp; open Google Voice</button>
        ${phone ? '<a class="btn btn-sm" data-tx="sms" href="#">Texting app</a>' : ''}
      </div>
      <p class="field-hint" data-tx="note" role="status"></p>
      <p class="field-hint">To text from your business number: ${canShare ? '<strong>Share…</strong> and pick Google Voice, or ' : ''}<strong>Copy &amp; open Google Voice</strong> and paste it into their conversation.${phone ? ' <strong>Texting app</strong> fills in their number and the message, but opens your phone\'s own texting app, so it sends from your personal number.' : ''} Nothing is sent by KennelOS.</p>`,
    onConfirm: async () => {}
  }, (o) => {
    o.querySelector('[data-fm-cancel]')?.remove(); // one way out: Done
    const body = () => o.querySelector('#tx-body').value;
    const note = (t) => { o.querySelector('[data-tx="note"]').textContent = t; };
    // Show the whole message, never a scrolling box: the status page link is its
    // last line, and below the fold it looks like it isn't there.
    const box = o.querySelector('#tx-body');
    const fit = () => { box.style.height = 'auto'; box.style.height = `${box.scrollHeight + 2}px`; };
    box.addEventListener('input', fit);
    fit();
    o.querySelector('[data-tx="copy-number"]')?.addEventListener('click', async () => note(await copyText(phone) ? 'Number copied.' : 'Copying isn\'t allowed here; select the number and copy it.'));
    o.querySelector('[data-tx="copy"]').addEventListener('click', async () => note(await copyText(body()) ? 'Message copied.' : 'Copying isn\'t allowed here; select the message and copy it.'));
    o.querySelector('[data-tx="voice"]').addEventListener('click', async () => {
      const ok = await copyText(body());
      window.open(GOOGLE_VOICE_URL, '_blank', 'noopener');
      note(ok ? 'Message copied. Paste it into their conversation in Google Voice.' : 'Copy the message above, then paste it in Google Voice.');
    });
    o.querySelector('[data-tx="share"]')?.addEventListener('click', async () => {
      try { await navigator.share({ text: body() }); } catch (e) { if (e?.name !== 'AbortError') note('Sharing didn\'t work here. Use Copy message instead.'); }
    });
    o.querySelector('[data-tx="sms"]')?.addEventListener('click', (ev) => { ev.currentTarget.href = smsHref(phone, body()); });
  });
}
