// applicationMergeUI.js — "Same family": two applications on one waitlist that are
// one family (docs/KennelOS_Duplicate_Applications_Plan.md; End-State guide §29).
// Opened from the family's page (a suggestion card, or ⋯ Same family as another
// application…), Today, Kels (Review my waitlist, Tidy up my records) and the
// Import/Export Duplicates card. Nothing merges until she confirms:
//   1. which other application (a picker of this list's open applications and
//      families on it, likely matches first, for a different spelling or email),
//   2. which one to keep, and where they disagree, which answer wins; and, when
//      each has its own contact card, whether to merge those too,
//   3. what will happen (their place, the deleted one, its link, a fee moved over
//      as a credit), then Merge and delete the other.
// The writes are waitlistActions.mergeApplications. Pro-only (proPages.js):
// shared pages that offer it import it dynamically.
import { esc, fmtDate, fmtMoney } from './ui.js';
import { waitlistEntryRepo } from '../data/waitlistEntryRepo.js';
import { waitlistOfferRepo } from '../data/waitlistOfferRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { waitlistConfig, entryName, anchorDate, prefValueText } from '../data/waitlistRules.js';
import { formQuestions, entryQuestions, answerText } from '../data/waitlistForm.js';
import { mergeConflicts, mergeBlocker } from '../data/recordMerge.js';
import {
  applicationMatches, applicationMergeBlocker, applicationConflicts, suggestKeepEntry, paidFeeCredit,
  isLiveEntry, matchReasonText, duplicateDismissKeys
} from '../data/applicationDuplicates.js';
import { mergeApplications } from '../data/waitlistActions.js';
import { isDismissed, dismiss } from '../data/nudgeState.js';

// "Not the same" for a pair, remembered everywhere that asks (applicationDuplicates).
export const isPairDismissed = (aId, bId) => duplicateDismissKeys(aId, bId).some((k) => isDismissed(k));
export const markNotSame = (aId, bId) => duplicateDismissKeys(aId, bId).forEach((k) => dismiss(k));

const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

// Everything the dialogs need for one kennel's list.
async function loadList(kennelId) {
  const [kennel, entries, contacts, offers] = await Promise.all([
    kennelRepo.getById(kennelId),
    waitlistEntryRepo.getAll(),
    contactRepo.getAll({ includeArchived: true }),
    waitlistOfferRepo.getByKennel(kennelId)
  ]);
  const contactsById = new Map(contacts.map((c) => [c.id, c]));
  return {
    kennel, form: formQuestions(waitlistConfig(kennel)), allEntries: entries,
    entries: entries.filter((e) => e.kennel_id === kennelId), contactsById, offers,
    name: (e) => entryName(e, contactsById.get(e.contact_id))
  };
}

// Where an entry stands, in words: "On the list since Oct 3", "Approved Oct 3", "Applied Oct 3".
function placeText(e) {
  if (e.status === 'active') return `on the list since ${fmtDate(anchorDate(e))}`;
  if (e.status === 'approved') return `approved ${fmtDate(e.approved_date)}, fee not received yet`;
  return `applied ${fmtDate(e.applied_date)}, not reviewed yet`;
}

function detailsText(e, list) {
  const c = list.contactsById.get(e.contact_id);
  const a = e.application || {};
  return [c?.email || a.email, c?.phone || a.phone].filter(Boolean).join(' · ');
}

function overlay(html, maxWidth = 600) {
  const el = document.createElement('div');
  el.className = 'modal-overlay';
  el.innerHTML = `<div class="modal" role="dialog" aria-modal="true" style="max-width:${maxWidth}px;">${html}</div>`;
  document.body.appendChild(el);
  // Backdrop tap (and Escape, via ui.js) = Cancel.
  el.addEventListener('click', (ev) => { if (ev.target === el) el.querySelector('[data-act="cancel"]')?.click(); });
  return el;
}

// Step 1: which other application is the same family. → its id, or null.
function pickOther(entry, list) {
  const matches = applicationMatches(entry, list.entries, { contactsById: list.contactsById });
  const why = new Map(matches.map((m) => [m.entry.id, m]));
  const others = list.entries.filter((e) => e.id !== entry.id && isLiveEntry(e))
    .sort((x, y) => (why.has(y.id) - why.has(x.id)) || list.name(x).localeCompare(list.name(y)));
  return new Promise((resolve) => {
    const el = overlay(`
      <h2 style="margin-top:0;">Same family as…</h2>
      <p class="muted">Pick the other application from ${esc(list.name(entry))}. Next you'll choose which one to keep. Nothing changes until you confirm.</p>
      ${others.length ? `<div class="field"><label for="am-search">Search by name, email or phone</label><input id="am-search" type="search" autocomplete="off"></div>
      <div id="am-list" style="max-height:360px; overflow-y:auto;"></div>` : '<p>There\'s no other open application or family on this list.</p>'}
      <div class="form-actions"><button class="btn" data-act="cancel">Cancel</button></div>`, 560);
    const done = (v) => { el.remove(); resolve(v); };
    el.querySelector('[data-act="cancel"]').addEventListener('click', () => done(null));
    if (!others.length) return;
    const listEl = el.querySelector('#am-list');
    const draw = (q) => {
      const needle = q.trim().toLowerCase();
      const shown = others.filter((e) => !needle || `${list.name(e)} ${detailsText(e, list)} ${(e.application || {}).name || ''}`.toLowerCase().includes(needle));
      listEl.innerHTML = shown.length ? shown.map((e) => {
        const m = why.get(e.id);
        return `<button type="button" class="btn" data-pick="${esc(e.id)}" style="display:block; width:100%; text-align:left; margin:6px 0; white-space:normal;">
          <strong>${esc(list.name(e))}</strong>${m ? ` <span class="badge badge-amber">${esc(m.strength === 'certain' ? 'Likely' : 'Maybe')}: ${esc(matchReasonText(m))}</span>` : ''}<br>
          <span class="faint">${esc(cap(placeText(e)))}${detailsText(e, list) ? ` · ${esc(detailsText(e, list))}` : ''}</span></button>`;
      }).join('') : '<p class="muted">Nobody on this list matches that.</p>';
    };
    draw('');
    el.querySelector('#am-search').addEventListener('input', (ev) => draw(ev.target.value));
    listEl.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-pick]');
      if (b) done(b.dataset.pick);
    });
  });
}

// Step 2: which to keep, what wins, and what happens; then the merge.
// → { keptId, droppedId, contactsMerged, credit } | null.
async function confirmMerge(entryA, entryB, list) {
  // The older application is shown first.
  const [A, B] = String(entryA.applied_date || entryA.created_at || '') <= String(entryB.applied_date || entryB.created_at || '') ? [entryA, entryB] : [entryB, entryA];
  const side0 = suggestKeepEntry(A, B, list.offers) === A ? 'a' : 'b';
  const byId = { a: A, b: B };
  const questions = new Map([...entryQuestions(B, list.form), ...entryQuestions(A, list.form)].map((q) => [q.id, q]));
  const conflicts = applicationConflicts(A, B, { labelOf: (id) => questions.get(id)?.label || id });
  const show = (c, v) => (c.answer ? answerText(questions.get(c.answer) || { type: 'short_text' }, v) : prefValueText(c.key, v)) || '—';
  const cA = list.contactsById.get(A.contact_id);
  const cB = list.contactsById.get(B.contact_id);
  const twoContacts = Boolean(cA && cB && cA.id !== cB.id);
  const contactConflicts = twoContacts ? mergeConflicts('contact', cA, cB) : [];
  const kennelName = async (id) => (id ? (await kennelRepo.getById(id))?.kennel_name || 'a kennel' : '');
  const contactShown = new Map();
  for (const c of contactConflicts) {
    contactShown.set(c.key, c.ref === 'kennel' ? [await kennelName(c.keep), await kennelName(c.drop)] : [String(c.keep), String(c.drop)]);
  }
  const contactBlock = twoContacts
    ? mergeBlocker('contact', cA, cB, { waitlistEntries: list.allEntries.filter((e) => e.id !== A.id && e.id !== B.id) })
    : null;

  const radio = (name, value, text, checked) => `<label class="check-inline" style="display:flex; gap:6px; margin:4px 0;">
    <input type="radio" name="${name}" value="${value}"${checked ? ' checked' : ''}> <span>${text}</span></label>`;
  const entryLine = (e) => `<strong>${esc(list.name(e))}</strong> · ${esc(cap(placeText(e)))}${detailsText(e, list) ? `<br><span class="faint">${esc(detailsText(e, list))}</span>` : ''}`;

  return new Promise((resolve) => {
    const el = overlay(`
      <h2 style="margin-top:0;">Merge these two applications?</h2>
      <p class="muted">One family, one place on your list. The one you keep takes the other's answers where you choose them, both histories, and any fee it paid as a credit. The other is deleted.</p>
      <div class="field"><label>Keep this one</label>
        ${radio('am-keep', 'a', entryLine(A), side0 === 'a')}
        ${radio('am-keep', 'b', entryLine(B), side0 === 'b')}
      </div>
      ${conflicts.length ? `<p style="margin-bottom:4px;"><strong>Their answers differ on ${conflicts.length === 1 ? 'one thing' : `${conflicts.length} things`}. Which should I keep?</strong></p>
        ${conflicts.map((c, i) => `<div class="field"><label>${esc(c.label)}</label>
          ${radio(`am-c${i}`, 'a', esc(show(c, c.keep)), side0 === 'a')}
          ${radio(`am-c${i}`, 'b', esc(show(c, c.drop)), side0 === 'b')}</div>`).join('')}` : ''}
      ${twoContacts ? `<div class="field" style="border-top:1px solid var(--border); padding-top:10px;">
          <label class="check-inline" style="display:flex; gap:6px;"><input type="checkbox" id="am-contacts"${contactBlock ? ' disabled' : ' checked'}>
            <span>Also merge their two contact cards (${esc(cA.name || 'Unnamed')} and ${esc(cB.name || 'Unnamed')}) into one</span></label>
          ${contactBlock ? `<p class="field-hint">${esc(contactBlock)}</p>` : '<p class="field-hint">Everything on the other card, their sales and history too, moves to the one kept.</p>'}
          <div id="am-contact-conflicts"${contactBlock ? ' hidden' : ''}>
          ${contactConflicts.length ? '<p style="margin:8px 0 4px;"><strong>Their contact cards differ too. Which should I keep?</strong></p>' : ''}
          ${contactConflicts.map((c, i) => `<div class="field"><label>${esc(c.label)}</label>
            ${radio(`am-k${i}`, 'a', esc(contactShown.get(c.key)[0]), side0 === 'a')}
            ${radio(`am-k${i}`, 'b', esc(contactShown.get(c.key)[1]), side0 === 'b')}</div>`).join('')}
          </div></div>` : ''}
      <div id="am-what" style="border-top:1px solid var(--border); padding-top:10px;"></div>
      <div class="fm-error"></div>
      <div class="form-actions">
        <button class="btn btn-danger" data-act="ok">Merge and delete the other</button>
        <button class="btn" data-act="cancel">Cancel</button>
      </div>`);
    const done = (v) => { el.remove(); resolve(v); };
    const sideNow = () => el.querySelector('input[name="am-keep"]:checked').value;
    const okBtn = el.querySelector('[data-act="ok"]');

    const drawWhat = () => {
      const side = sideNow();
      const keep = byId[side];
      const drop = byId[side === 'a' ? 'b' : 'a'];
      const blocker = applicationMergeBlocker(keep, drop, list.offers);
      const offers = list.offers.filter((o) => o.entry_id === drop.id && !o.is_archived).length;
      const fee = paidFeeCredit(drop);
      const keepPaid = Boolean((keep.fee_received_date && keep.fee_payment_method !== 'Waived') || keep.fee_paid_online?.date);
      const lines = [
        `<strong>${esc(list.name(keep))}</strong> keeps their own place: ${esc(placeText(keep))}.`,
        `<strong>${esc(list.name(drop))}</strong>'s application (applied ${esc(fmtDate(drop.applied_date))}) is deleted. This can't be undone.`,
        offers ? `Its ${offers === 1 ? 'offer moves' : `${offers} offers move`} to the one you keep.` : '',
        drop.status_token ? `The status-page link sent for the one you delete stops working.${keep.status_token ? ' They use the kept one\'s link.' : ''}` : '',
        fee ? `The ${esc(fmtMoney(fee.amount))} they paid on it becomes a credit on the one you keep${keepPaid
          ? '. They paid the fee twice: the credit counts toward their deposit and what they owe. If you\'d rather refund it, remove the credit after you refund.'
          : ', toward their application fee and what they owe.'}` : ''
      ].filter(Boolean);
      el.querySelector('#am-what').innerHTML = `<p style="margin:0 0 4px;"><strong>What happens</strong></p><ul style="margin:0; padding-left:20px;">${lines.map((l) => `<li>${l}</li>`).join('')}</ul>`;
      el.querySelector('.fm-error').innerHTML = blocker ? `<div class="inline-error">${esc(blocker)}</div>` : '';
      okBtn.disabled = Boolean(blocker);
    };
    drawWhat();
    // Switching the kept one moves the value choices with it (she can still change each).
    el.querySelectorAll('input[name="am-keep"]').forEach((r) => r.addEventListener('change', () => {
      conflicts.forEach((c, i) => { el.querySelector(`input[name="am-c${i}"][value="${r.value}"]`).checked = true; });
      contactConflicts.forEach((c, i) => { el.querySelector(`input[name="am-k${i}"][value="${r.value}"]`).checked = true; });
      drawWhat();
    }));
    el.querySelector('#am-contacts')?.addEventListener('change', (ev) => { el.querySelector('#am-contact-conflicts').hidden = !ev.target.checked; });
    el.querySelector('[data-act="cancel"]').addEventListener('click', () => done(null));
    okBtn.addEventListener('click', async () => {
      const side = sideNow();
      const keep = byId[side];
      const drop = byId[side === 'a' ? 'b' : 'a'];
      const choices = {};
      conflicts.forEach((c, i) => { choices[c.key] = el.querySelector(`input[name="am-c${i}"]:checked`).value === side ? 'keep' : 'drop'; });
      const mergeContacts = Boolean(el.querySelector('#am-contacts')?.checked);
      const contactChoices = {};
      contactConflicts.forEach((c, i) => { contactChoices[c.key] = el.querySelector(`input[name="am-k${i}"]:checked`).value === side ? 'keep' : 'drop'; });
      okBtn.disabled = true;
      okBtn.textContent = 'Merging…';
      try {
        const res = await mergeApplications(keep.id, drop.id, { choices, mergeContacts, contactChoices, dropName: list.name(drop) });
        done({ keptId: keep.id, droppedId: drop.id, keptName: list.name(res.entry || keep), contactsMerged: res.contactsMerged, credit: paidFeeCredit(drop) });
      } catch (err) {
        el.querySelector('.fm-error').innerHTML = `<div class="inline-error">${esc(err.message || String(err))}</div>`;
        okBtn.disabled = false;
        okBtn.textContent = 'Merge and delete the other';
      }
    });
  });
}

// The whole flow from one entry. `otherId` skips the picker (a suggested match).
// → { keptId, droppedId, keptName, contactsMerged, credit } | null.
export async function sameFamilyDialog({ entryId, otherId = null }) {
  const entry = await waitlistEntryRepo.getById(entryId);
  if (!entry) throw new Error('That application no longer exists.');
  const list = await loadList(entry.kennel_id);
  const pickedId = otherId || await pickOther(entry, list);
  if (!pickedId) return null;
  const other = list.entries.find((e) => e.id === pickedId);
  if (!other) throw new Error('That application no longer exists.');
  return confirmMerge(entry, other, list);
}

// One sentence for after a merge.
export function mergedMessage(res) {
  if (!res) return '';
  return [`Merged. ${res.keptName} has one application now; the other is deleted.`,
    res.contactsMerged ? 'Their contact cards are one card too.' : '',
    res.credit ? `The ${fmtMoney(res.credit.amount)} fee paid on the other is a credit on theirs.` : ''].filter(Boolean).join(' ');
}
