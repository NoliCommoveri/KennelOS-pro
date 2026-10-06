// waitlist.js — the Waitlist page (Waitlist Spec §5.2/§6.1; End-State guide §29).
// One kennel's list at a time (one list per kennel, Spec §0): new applications,
// approved families whose fee is due, the ranked rolling list, and closed runs.
// Position and passes are DERIVED here from waitlistRules — nothing is stored.
// Pro-only page (proPages.js).
import { waitlistEntryRepo } from '../data/waitlistEntryRepo.js';
import { waitlistOfferRepo } from '../data/waitlistOfferRepo.js';
import { waitlistProgramRepo } from '../data/waitlistProgramRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { WAITLIST_ENTRY_STATUS, WAITLIST_PRIORITY, WAITLIST_REMOVED_REASON } from '../data/vocab.js';
import {
  waitlistConfig, rankedList, passesUsed, isMovedByBreeder, anchorDate, contactMatches, entryName,
  canUndoRemoval, overdueFees
} from '../data/waitlistRules.js';
import { esc, badge, fmtDate, fmtMoney, param, todayYMD, cardShell } from '../assets/ui.js';
import { resolveWaitlistKennel, mountKennelPicker, prefsSummary, entryFlags } from '../assets/waitlistUI.js';

const els = {
  title: document.getElementById('wl-title'),
  actions: document.getElementById('wl-actions'),
  picker: document.getElementById('wl-kennel-picker'),
  body: document.getElementById('wl-body'),
  error: document.getElementById('page-error')
};

const CLOSED = ['placed', 'removed', 'withdrawn', 'declined', 'expired'];
const none = '<span class="faint">—</span>';
const entryHref = (e) => `waitlist-entry.html?id=${encodeURIComponent(e.id)}`;

function table(headers, rows) {
  return `<table class="data"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}
const row = (e, cells) => `<tr class="clickable" data-href="${esc(entryHref(e))}">${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;

async function main() {
  const { kennel, own } = await resolveWaitlistKennel(param('kennel'));
  if (!kennel) {
    els.body.innerHTML = '<div class="empty-state">Set up your kennel first — each of your kennels keeps its own waitlist.</div>';
    return;
  }
  mountKennelPicker(els.picker, { kennel, own });
  const kq = `kennel=${encodeURIComponent(kennel.id)}`;
  els.title.textContent = own.length > 1 ? `Waitlist — ${kennel.kennel_name}` : 'Waitlist';
  els.actions.innerHTML = `
    <a class="btn" href="kennel.html?id=${encodeURIComponent(kennel.id)}#waitlist-settings">Settings</a>
    <a class="btn" href="waitlist-programs.html?${kq}">Programs</a>
    <a class="btn" href="waitlist-import.html?${kq}">Import CSV</a>
    <a class="btn btn-primary" href="waitlist-entry.html?new=1&${kq}">+ New application</a>`;

  const [entries, offers, programs, contacts] = await Promise.all([
    waitlistEntryRepo.getByKennel(kennel.id),
    waitlistOfferRepo.getByKennel(kennel.id),
    waitlistProgramRepo.getMapForKennel(kennel.id),
    contactRepo.getAll({ includeArchived: true })
  ]);
  const config = waitlistConfig(kennel);
  const today = todayYMD();
  const contactsById = new Map(contacts.map((c) => [c.id, c]));
  const nameOf = (e) => esc(entryName(e, contactsById.get(e.contact_id)));
  const programBadge = (e) => {
    const p = programs.get(e.waitlist_program_id);
    if (!p) return '';
    const cls = p.priority === 'ahead' ? 'badge-purple' : 'badge-neutral';
    return ` <span class="badge ${cls}" title="${esc(p.priority === 'ahead' ? WAITLIST_PRIORITY[1].label : '')}">${esc(p.name)}</span>`;
  };

  // --- New applications (Spec §5.2) ---
  const applied = entries.filter((e) => e.status === 'applied')
    .sort((a, b) => (a.applied_date || '').localeCompare(b.applied_date || '') || (a.created_at || '').localeCompare(b.created_at || ''));
  const appliedHtml = applied.length
    ? table(['Applicant', 'Applied', 'Wants', 'Possible match'], applied.map((e) => {
        const matches = e.contact_id ? [] : contactMatches(e.application || {}, contacts);
        const match = e.contact_id
          ? '<span class="badge badge-neutral">Existing contact</span>'
          : matches.length ? `<span class="badge badge-amber">${esc(matches[0].contact.name)}${matches.length > 1 ? ` +${matches.length - 1}` : ''}</span>` : none;
        return row(e, [`<strong>${nameOf(e)}</strong>${programBadge(e)}`, e.applied_date ? esc(fmtDate(e.applied_date)) : none, prefsSummary(e), match]);
      }))
    : '<div class="empty-state">No new applications.</div>';

  // --- Fee due (approved, not yet on the list) ---
  const approved = entries.filter((e) => e.status === 'approved')
    .sort((a, b) => (a.approved_date || '').localeCompare(b.approved_date || ''));
  const overdue = new Set(overdueFees(approved, today).map((e) => e.id));
  const approvedHtml = approved.length
    ? table(['Family', 'Approved', 'Fee', 'Pay by'], approved.map((e) => row(e, [
        `<strong>${nameOf(e)}</strong>${programBadge(e)}`,
        e.approved_date ? esc(fmtDate(e.approved_date)) : none,
        e.fee_amount != null ? esc(fmtMoney(e.fee_amount)) : none,
        e.fee_due_date ? `${esc(fmtDate(e.fee_due_date))}${overdue.has(e.id) ? ' <span class="badge badge-red">Past due</span>' : ''}` : none
      ])))
    : '<div class="empty-state">Nobody is waiting on a fee.</div>';

  // --- The rolling list (Spec §6.1) ---
  const ranked = rankedList(entries, kennel.id, programs);
  const listHtml = ranked.length
    ? table(['#', 'Family', 'Wants', 'Passes', 'In line since'], ranked.map((e, i) => row(e, [
        `<strong>${i + 1}</strong>`,
        `<strong>${nameOf(e)}</strong>${programBadge(e)} ${entryFlags(e, today)}`,
        prefsSummary(e),
        `${passesUsed(e, offers)} of ${esc(config.max_passes)}`,
        `${esc(fmtDate(anchorDate(e)))}${isMovedByBreeder(e) ? ' <span class="badge badge-purple" title="You set this place by hand">Moved by you</span>' : ''}`
      ])))
    : '<div class="empty-state">Nobody is on the list yet. Families join once you approve them and mark their fee received.</div>';

  // --- Closed runs ---
  const closed = entries.filter((e) => CLOSED.includes(e.status))
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  const closedHtml = closed.length
    ? table(['Family', 'Status', 'Why'], closed.map((e) => row(e, [
        `<strong>${nameOf(e)}</strong>`,
        badge(WAITLIST_ENTRY_STATUS, e.status) + (canUndoRemoval(e, today) ? ' <span class="badge badge-amber">Undo available</span>' : ''),
        e.status === 'removed' && e.removed_reason ? badge(WAITLIST_REMOVED_REASON, e.removed_reason) : none
      ])))
    : '<div class="empty-state">No closed entries.</div>';

  const count = (n) => ` <span class="faint">(${n})</span>`;
  els.body.innerHTML =
    cardShell('New applications' + count(applied.length), appliedHtml, { key: 'applied', isEmpty: !applied.length }) +
    cardShell('Fee due' + count(approved.length), approvedHtml, { key: 'approved', isEmpty: !approved.length, marginTop: true }) +
    cardShell('On the list' + count(ranked.length), listHtml, { key: 'list', marginTop: true }) +
    cardShell('Closed' + count(closed.length), closedHtml, { key: 'closed', isEmpty: true, marginTop: true });

  els.body.querySelectorAll('tr[data-href]').forEach((tr) => {
    tr.addEventListener('click', () => { location.href = tr.dataset.href; });
  });
}

main().catch((e) => { els.error.innerHTML = `<div class="inline-error">${esc(e.message || String(e))}</div>`; });
