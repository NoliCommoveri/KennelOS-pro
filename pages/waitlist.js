// waitlist.js — the Waitlist page (Waitlist Spec §5.2/§6.1; End-State guide §29).
// One kennel's list at a time (one list per kennel, Spec §0): new applications,
// approved families whose fee is due, the ranked rolling list, and closed runs.
// Position and passes are DERIVED here from waitlistRules — nothing is stored.
// Also the waitlist as the main workflow (Spec §15.2): each live litter with who's
// next and a one-tap offer, and "Copy public list" (Spec §15.3), the W1 stand-in
// for the public link. Pro-only page (proPages.js).
import { waitlistEntryRepo } from '../data/waitlistEntryRepo.js';
import { waitlistOfferRepo } from '../data/waitlistOfferRepo.js';
import { waitlistProgramRepo } from '../data/waitlistProgramRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import * as actions from '../data/waitlistActions.js';
import { WAITLIST_ENTRY_STATUS, WAITLIST_PRIORITY, WAITLIST_REMOVED_REASON } from '../data/vocab.js';
import {
  waitlistConfig, rankedList, passesUsed, isMovedByBreeder, anchorDate, contactMatches, entryName,
  canUndoRemoval, overdueFees, nextFamilyForLitter, isPupAvailable, publicList, publicListText
} from '../data/waitlistRules.js';
import { esc, badge, fmtDate, fmtMoney, param, todayYMD, cardShell, alertModal } from '../assets/ui.js';
import { resolveWaitlistKennel, mountKennelPicker, prefsSummary, entryFlags, formModal } from '../assets/waitlistUI.js';

const els = {
  title: document.getElementById('wl-title'),
  actions: document.getElementById('wl-actions'),
  picker: document.getElementById('wl-kennel-picker'),
  body: document.getElementById('wl-body'),
  error: document.getElementById('page-error')
};

const CLOSED = ['placed', 'removed', 'withdrawn', 'declined', 'expired'];
const LIVE_LITTER = ['expected', 'whelped', 'weaning', 'ready'];
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
    <a class="btn" href="waitlist-form.html?${kq}">Application form</a>
    <a class="btn" href="waitlist-programs.html?${kq}">Programs</a>
    <button class="btn" id="wl-copy-public">Copy public list</button>
    <a class="btn" href="waitlist-import.html?${kq}">Import CSV</a>
    <a class="btn btn-primary" href="waitlist-entry.html?new=1&${kq}">+ New application</a>`;

  const [entries, offers, programs, contacts, litters, dogs, sales] = await Promise.all([
    waitlistEntryRepo.getByKennel(kennel.id),
    waitlistOfferRepo.getByKennel(kennel.id),
    waitlistProgramRepo.getMapForKennel(kennel.id),
    contactRepo.getAll({ includeArchived: true }),
    litterRepo.getAll(),
    dogRepo.getAll({ includeArchived: true }),
    saleRepo.getAll({ includeArchived: true })
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

  // --- Litters: who's next (Spec §15.2) ---
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const dogName = (id) => dogsById.get(id)?.call_name || '—';
  const litterLabel = (l) => l.nickname || `${dogName(l.dam_id)} × ${dogName(l.sire_id)}`;
  const entriesById = new Map(entries.map((e) => [e.id, e]));
  const familyLink = (e) => `<a href="${esc(entryHref(e))}">${nameOf(e)}</a>`;
  const opts = { today, config, programsById: programs };
  const litterRows = litters
    .filter((l) => l.kennel_id === kennel.id && LIVE_LITTER.includes(l.status))
    .map((l) => {
      const pups = dogs.filter((d) => d.litter_id === l.id);
      const available = pups.filter((d) => isPupAvailable(d, sales));
      const lOffers = offers.filter((o) => o.litter_id === l.id);
      const open = lOffers.find((o) => o.outcome === 'open' && !o.is_archived) || null;
      const next = open ? null : nextFamilyForLitter(entries, lOffers, l, pups, sales, opts);
      return { l, available, open, next };
    })
    .filter((r) => r.available.length || r.open);
  const littersHtml = litterRows.length
    ? table(['Litter', 'Pups available', 'Picks', 'Turn'], litterRows.map(({ l, available, open, next }) => {
        let turn;
        if (open) {
          const e = entriesById.get(open.entry_id);
          const overdue = open.respond_by_date && open.respond_by_date < today;
          turn = `Offered to ${e ? familyLink(e) : 'a family'} · respond by ${esc(fmtDate(open.respond_by_date))}${overdue ? ' <span class="badge badge-red">Deadline passed</span>' : ''}`;
        } else if (next) {
          turn = `Next: ${familyLink(next.entry)} <button class="btn btn-sm btn-primary" data-offer-litter="${esc(l.id)}">Offer to them</button>`;
        } else turn = '<span class="faint">Nobody on the list is eligible</span>';
        return `<tr><td><a href="litter.html?id=${encodeURIComponent(l.id)}">${esc(litterLabel(l))}</a></td>
          <td>${available.length}</td>
          <td>${l.picks_opened_date ? `Open since ${esc(fmtDate(l.picks_opened_date))}` : '<span class="faint">Not open</span>'}</td>
          <td>${turn}</td></tr>`;
      }))
    : '<div class="empty-state">No litters with pups to offer right now.</div>';

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
    cardShell('Litters' + count(litterRows.length), littersHtml, { key: 'litters', isEmpty: !litterRows.length, marginTop: true }) +
    cardShell('Closed' + count(closed.length), closedHtml, { key: 'closed', isEmpty: true, marginTop: true });

  els.body.querySelectorAll('tr[data-href]').forEach((tr) => {
    tr.addEventListener('click', () => { location.href = tr.dataset.href; });
  });

  // Offer the next family their turn — opening picks first if they aren't open.
  els.body.querySelectorAll('[data-offer-litter]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const l = litters.find((x) => x.id === btn.dataset.offerLitter);
        const offer = l.picks_opened_date ? await actions.offerNext(l.id) : await actions.openPicks(l.id);
        if (offer) {
          const e = entriesById.get(offer.entry_id);
          await alertModal({ title: 'Offer made', message: `It's ${e ? entryName(e, contactsById.get(e.contact_id)) : 'the next family'}'s turn. They have until ${fmtDate(offer.respond_by_date)} to respond. Let them know; nothing is sent automatically yet.` });
        }
        await main();
      } catch (err) {
        els.error.innerHTML = `<div class="inline-error">${esc(err.message || String(err))}</div>`;
        btn.disabled = false;
      }
    });
  });

  // The public list as text (Spec §15.3): allow-listed fields only, paused
  // families left out with their numbers skipped.
  document.getElementById('wl-copy-public').onclick = async () => {
    const rows = publicList(entries, kennel.id, programs, { today, nameOf: (e) => entryName(e, contactsById.get(e.contact_id)) });
    const text = publicListText(rows, { kennelName: kennel.kennel_name, today, fmtDate });
    await formModal({
      title: 'Public list',
      confirmLabel: 'Copy',
      bodyHtml: `<p class="field-hint" style="margin-top:0;">Paste this on Facebook or your website. It shows first names with a last initial, sex preference and the date each family was added. Contact details, programs and paused families are left out.</p>
        <textarea readonly style="width:100%;min-height:220px;font-family:inherit;">${esc(text)}</textarea>`,
      onConfirm: async (o) => {
        const ta = o.querySelector('textarea');
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          ta.select();
          if (!document.execCommand('copy')) throw new Error('Copying isn\'t allowed here. Select the text and copy it yourself.');
        }
      }
    });
  };
}

main().catch((e) => { els.error.innerHTML = `<div class="inline-error">${esc(e.message || String(e))}</div>`; });
