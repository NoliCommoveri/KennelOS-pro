// waitlistUI.js — page-side helpers shared by the three Pro-only waitlist pages
// (waitlist / waitlist-entry / waitlist-programs; Waitlist Spec §11, End-State
// guide §29). Which kennel's list a page shows, the kennel picker, and the
// one-line preference summary, and the offer dialogs (pick a pup, deposit received,
// change pup, undo a pass) shared by the family page and the litter's picks panel.
// Pro-only like the pages (proPages.js).
import { ownKennels, getActiveKennelId } from '../data/kennelScope.js';
import { getMyKennelId } from '../data/settings.js';
import { waitlistEntryRepo } from '../data/waitlistEntryRepo.js';
import { WAITLIST_OPEN_STATUSES } from '../data/vocab.js';
import { esc, fmtDate, fmtMoney, todayYMD, confirmModal, alertModal, promptModal } from './ui.js';
import { PLACEMENT_TYPE, descriptor } from '../data/vocab.js';
import { isManuallyPaused, isReadyHeld, readyFromDate, soonNoticeText, entryName, waitlistConfig } from '../data/waitlistRules.js';
import { isWaitlistOnlineOffered, statusPageLink } from '../data/cloud/cloudConfig.js';
import { editionFlags } from '../data/editionConfig.js';
import { markSoonNotified, recordPick, recordOutcome, confirmDeposit, changePick, undoPass } from '../data/waitlistActions.js';
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
export function entryFlags(entry, today) {
  const out = [];
  if (isManuallyPaused(entry, today)) out.push(`<span class="badge badge-amber" title="${esc(entry.pause_reason || '')}">Paused to ${esc(entry.paused_until)}</span>`);
  if (isReadyHeld(entry, today)) out.push(`<span class="badge badge-amber" title="They said they won't be ready to buy yet, so they aren't offered pups until then.">Not ready until ${esc(readyFromDate(entry))}</span>`);
  if ((entry.listen_mode || 'all') === 'selected') out.push('<span class="badge badge-blue">Listen-only</span>');
  return out.join(' ');
}

// A form dialog in the app's modal chrome (same markup as ui.js's dialogs).
// `onConfirm(overlay)` reads the fields and does the work; throwing shows the
// message inside the dialog and keeps it open. Resolves true once confirmed,
// false on cancel/backdrop. `onOpen(overlay)` (optional) wires live controls.
export function formModal({ title, bodyHtml, confirmLabel = 'Save', danger = false, onConfirm }, onOpen = null) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
        <h2 style="margin-top:0;">${esc(title)}</h2>
        <div data-fm-error></div>
        ${bodyHtml}
        <div class="form-actions">
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-fm-confirm>${esc(confirmLabel)}</button>
          <button class="btn" data-fm-cancel>Cancel</button>
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
    overlay.querySelector('[data-fm-cancel]').addEventListener('click', () => done(false));
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
export async function pickDialog({ offer, name, pups, pupLabel }) {
  let out = null;
  const ok = await formModal({
    title: `${name} picked a pup`,
    confirmLabel: 'Record their pick',
    bodyHtml: `<div class="field"><label>Which pup?</label><select id="pk-dog">${pupOptions(pups, pupLabel)}</select></div>
      <div class="field"><label>Date</label><input id="pk-date" type="date" value="${esc(todayYMD())}"></div>
      <label class="check-inline" style="display:block;margin:8px 0;"><input id="pk-paid" type="checkbox"> Their deposit is already in</label>
      <div id="pk-paid-fields" class="form-grid" hidden>
        <div class="field"><label>Deposit received</label><input id="pk-dep-date" type="date" value="${esc(todayYMD())}"></div>
        <div class="field"><label>Amount</label><input id="pk-dep-amount" type="number" min="0" step="0.01" placeholder="The litter's expected deposit"></div>
      </div>
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
export async function depositDialog({ offer, name, pupName, sale }) {
  let res = null;
  const ok = await formModal({
    title: `${name}'s deposit received`,
    confirmLabel: 'Deposit received',
    bodyHtml: `<p style="margin-top:0;">For <strong>${esc(pupName)}</strong>.</p>
      <div class="form-grid">
        <div class="field"><label>Date received</label><input id="dp-date" type="date" value="${esc((sale && sale.deposit_date) || todayYMD())}"></div>
        <div class="field"><label>Amount</label><input id="dp-amount" type="number" min="0" step="0.01" value="${esc(sale?.deposit_amount ?? '')}"></div>
      </div>
      <p class="field-hint">Marks the sale deposit paid and the pup placed, and moves ${esc(name)} off the list as placed. Any other open offers they have are voided.${sale && sale.deposit_amount != null ? ` Expected deposit: ${esc(fmtMoney(sale.deposit_amount))}.` : ''}</p>`,
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
