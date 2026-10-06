// waitlistPicksPanel.js — the Litter page's "Waitlist picks" panel (Waitlist Spec
// §6.5; End-State guide §29). Open/close picks, the open offer with its outcome
// buttons (accepted → Sale, passed, no response, void), who's next, the litter
// queue, and the litter's offer history. Pro-only: litter.js (a shared page)
// imports this module dynamically only when editionFlags.waitlist is on, and it is
// in PRO_ONLY_STANDALONE so it is absent from the Lite build.
import { kennelRepo } from '../data/kennelRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { waitlistEntryRepo } from '../data/waitlistEntryRepo.js';
import { waitlistOfferRepo } from '../data/waitlistOfferRepo.js';
import { waitlistProgramRepo } from '../data/waitlistProgramRepo.js';
import * as actions from '../data/waitlistActions.js';
import {
  waitlistConfig, litterQueue, nextFamilyForLitter, eligiblePupsFor, isPupAvailable,
  overallPositions, entryName, describeOfferChanges, soonFamiliesForLitter
} from '../data/waitlistRules.js';
import { WAITLIST_OFFER_OUTCOME, SEX } from '../data/vocab.js';
import { esc, badge, fmtDate, todayYMD, confirmModal, alertModal } from './ui.js';
import { formModal, openSoonNotice } from './waitlistUI.js';

const none = '<span class="faint">—</span>';
const QUEUE_PREVIEW = 5;

async function loadData(litter) {
  const [kennel, entries, kennelOffers, pups, programsById, sales, contacts] = await Promise.all([
    kennelRepo.getById(litter.kennel_id),
    waitlistEntryRepo.getByKennel(litter.kennel_id),
    waitlistOfferRepo.getByKennel(litter.kennel_id),
    dogRepo.getByLitter(litter.id),
    waitlistProgramRepo.getMapForKennel(litter.kennel_id),
    saleRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true })
  ]);
  const pupIds = new Set(pups.map((d) => d.id));
  return {
    kennel, entries, pups, programsById,
    offers: kennelOffers.filter((o) => o.litter_id === litter.id),
    // Every offer on the kennel: the "almost your turn" notice skips families
    // holding an open offer on ANY litter.
    kennelOffers,
    sales: sales.filter((s) => pupIds.has(s.dog_id)),
    contactsById: new Map(contacts.map((c) => [c.id, c])),
    config: waitlistConfig(kennel)
  };
}

const pupLabel = (d) => `${d.call_name}${d.sex ? ` (${SEX.find((s) => s.value === d.sex)?.label || d.sex})` : ''}`;

// Render the panel into `mount` for `litter`. `onChange` lets the litter page
// refresh its own state (the litter record and roster) after a write.
export async function renderWaitlistPicksPanel({ mount, litter, onChange = async () => {} }) {
  if (!mount) return;
  const today = todayYMD();
  const d = await loadData(litter);
  const familyName = (entry) => entryName(entry, d.contactsById.get(entry.contact_id));
  const familyLink = (entry) => `<a href="waitlist-entry.html?id=${encodeURIComponent(entry.id)}">${esc(familyName(entry))}</a>`;
  const entriesById = new Map(d.entries.map((e) => [e.id, e]));
  const pupsById = new Map(d.pups.map((p) => [p.id, p]));
  const opts = { today, config: d.config, programsById: d.programsById };

  const available = d.pups.filter((p) => isPupAvailable(p, d.sales));
  const queue = litterQueue(d.entries, litter, d.pups, d.sales, opts);
  const positions = overallPositions(d.entries, litter.kennel_id, d.programsById);
  const open = d.offers.find((o) => o.outcome === 'open' && !o.is_archived) || null;
  const picksOpen = Boolean(litter.picks_opened_date);
  const soon = soonFamiliesForLitter(d.entries, d.kennelOffers, litter, d.pups, d.sales, opts);

  // Nothing to show for a kennel that has never used the waitlist on this litter.
  if (!picksOpen && !d.offers.length && !queue.length && !d.entries.some((e) => e.status === 'active')) {
    mount.innerHTML = '';
    return;
  }

  // --- The open offer ---
  let openHtml = '';
  if (open) {
    const entry = entriesById.get(open.entry_id);
    const live = entry ? eligiblePupsFor(entry, litter, d.pups, d.sales, opts) : [];
    const overdue = open.respond_by_date && open.respond_by_date < today;
    openHtml = `
      <div class="card" style="margin:12px 0 0;background:var(--surface-2, transparent);">
        <p style="margin:0 0 6px;"><strong>Offered to ${entry ? familyLink(entry) : 'a family'}</strong> on ${esc(fmtDate(open.offered_date))}
          · respond by <strong>${esc(fmtDate(open.respond_by_date))}</strong>${overdue ? ' <span class="badge badge-red">Deadline passed</span>' : ''}</p>
        <p class="muted" style="margin:0 0 10px;">Pups available to them: ${live.length ? esc(live.map(pupLabel).join(', ')) : 'none right now'}</p>
        <div class="pill-row">
          <button class="btn btn-primary btn-sm" data-pk="accept"${live.length ? '' : ' disabled'}>Accepted a pup…</button>
          <button class="btn btn-sm" data-pk="passed">Passed</button>
          <button class="btn btn-sm" data-pk="no_response">No response</button>
          <button class="btn btn-sm" data-pk="voided" title="Cancel this offer (never counts as a pass)">Void</button>
        </div>
      </div>`;
  }

  // --- Who's next (picks open, nothing open) ---
  let nextHtml = '';
  if (picksOpen && !open) {
    const next = nextFamilyForLitter(d.entries, d.offers, litter, d.pups, d.sales, opts);
    nextHtml = next
      ? `<p style="margin:12px 0 0;">Next up: <strong>${familyLink(next.entry)}</strong> <button class="btn btn-sm btn-primary" data-pk="offer-next">Offer to them</button></p>`
      : `<p class="muted" style="margin:12px 0 0;">${available.length ? 'Nobody else on the list is eligible for the pups still available.' : 'Every pup in this litter is spoken for.'}</p>`;
  }

  // --- Litter queue preview ---
  const spent = new Set(d.offers.filter((o) => o.outcome !== 'voided' && !o.is_archived).map((o) => o.entry_id));
  const waiting = queue.filter((q) => !spent.has(q.entry.id));
  const queueHtml = waiting.length
    ? `<table class="data" style="margin-top:8px;"><thead><tr><th>In line</th><th>Family</th><th>Overall</th><th>Pups for them</th></tr></thead><tbody>${
        waiting.slice(0, QUEUE_PREVIEW).map((q) => `<tr><td>${q.litterPosition}</td><td>${familyLink(q.entry)}</td><td>#${esc(positions.get(q.entry.id))}</td><td>${esc(q.eligibleDogs.map(pupLabel).join(', '))}</td></tr>`).join('')
      }</tbody></table>${waiting.length > QUEUE_PREVIEW ? `<p class="faint" style="margin:4px 0 0;">…and ${waiting.length - QUEUE_PREVIEW} more.</p>` : ''}`
    : `<p class="muted" style="margin:8px 0 0;">No families waiting for this litter${available.length ? '' : ' (no pups available)'}.</p>`;

  // --- History ---
  const history = [...d.offers].filter((o) => o.outcome !== 'open').sort((a, b) => (b.outcome_date || b.offered_date || '').localeCompare(a.outcome_date || a.offered_date || '') || (b.created_at || '').localeCompare(a.created_at || ''));
  const historyHtml = history.length
    ? `<details style="margin-top:12px;"><summary>Offer history (${history.length})</summary>
        <table class="data" style="margin-top:8px;"><thead><tr><th>Family</th><th>Offered</th><th>Outcome</th><th>Pass?</th></tr></thead><tbody>${
          history.map((o) => {
            const e = entriesById.get(o.entry_id);
            const pup = o.chosen_dog_id ? pupsById.get(o.chosen_dog_id) : null;
            return `<tr><td>${e ? familyLink(e) : none}</td><td>${esc(fmtDate(o.offered_date))}</td><td>${badge(WAITLIST_OFFER_OUTCOME, o.outcome)}${pup ? ` ${esc(pup.call_name)}` : ''}${o.outcome_date ? ` <span class="faint">${esc(fmtDate(o.outcome_date))}</span>` : ''}</td><td>${o.counts_as_pass ? '<span class="badge badge-amber">Counts</span>' : none}</td></tr>`;
          }).join('')
        }</tbody></table></details>`
    : '';

  mount.innerHTML = `
    <section class="card" style="margin-top:16px;">
      <div class="row-between">
        <h2 style="margin:0;">Waitlist picks</h2>
        <div class="pill-row">${soon.some((r) => !r.inFlight) ? '<button class="btn btn-sm" data-pk="soon" title="Tell the families whose turn is coming up for these pups">Almost your turn…</button>' : ''}${picksOpen
          ? '<button class="btn btn-sm" data-pk="close">Close picks</button>'
          : `<button class="btn btn-primary btn-sm" data-pk="open"${available.length ? '' : ' disabled title="No pups available to offer."'}>Open picks</button>`}</div>
      </div>
      <p class="field-hint" style="margin:6px 0 0;">${picksOpen
        ? `Picks opened ${esc(fmtDate(litter.picks_opened_date))}. One family at a time, in list order; families with no matching pup, paused, or listening for other litters are skipped and nothing is held against them. Nothing is sent automatically, so tell each family yourself.`
        : `${available.length} pup${available.length === 1 ? '' : 's'} available. Opening picks offers the first eligible family their turn (${esc(d.config.respond_days)} days to respond).`}</p>
      ${openHtml}
      ${nextHtml}
      <h3 style="margin:16px 0 0;font-size:15px;">In line for this litter</h3>
      ${queueHtml}
      ${historyHtml}
    </section>`;

  const rerender = async () => { await onChange(); };
  const run = (fn) => async () => {
    try { await fn(); } catch (e) { await alertModal({ title: 'Couldn\'t do that', message: e.message || String(e) }); }
    await rerender();
  };
  const on = (key, fn) => mount.querySelector(`[data-pk="${key}"]`)?.addEventListener('click', run(fn));

  on('open', async () => {
    const offer = await actions.openPicks(litter.id);
    await alertModal(offer ? offeredMessage(offer, entriesById, familyName) : { title: 'Picks are open', message: 'Nobody on the list is eligible for the available pups yet. A family is offered as soon as one becomes eligible and you tap "Offer to them".' });
  });
  // Not wrapped in run(): the dialog writes nothing, so there's nothing to re-render.
  mount.querySelector('[data-pk="soon"]')?.addEventListener('click', () => {
    openSoonNotice({
      kennel: d.kennel, config: d.config, rows: soon, contactsById: d.contactsById,
      litterLabelOf: (r) => `#${r.soonPosition} in line · pups for them: ${r.eligibleDogs.map(pupLabel).join(', ')}`,
      litterIdsOf: () => [litter.id]
    });
  });
  on('close', async () => {
    if (!(await confirmModal({ title: 'Close picks?', message: 'No new offers will be made on this litter. An open offer stays open until you record how it ended.', confirmLabel: 'Close picks' }))) return;
    await actions.closePicks(litter.id);
  });
  on('offer-next', async () => {
    const offer = await actions.offerNext(litter.id);
    if (offer) await alertModal(offeredMessage(offer, await freshEntries(litter), familyName));
  });

  if (open) {
    const entry = entriesById.get(open.entry_id);
    const name = entry ? familyName(entry) : 'this family';
    on('accept', async () => {
      const live = eligiblePupsFor(entry, litter, d.pups, d.sales, opts);
      let saleId = null;
      let res = null;
      const done = await formModal({
        title: `${name} accepted a pup`,
        confirmLabel: 'Record and create the sale',
        bodyHtml: `<div class="field"><label>Which pup?</label><select id="pk-dog">${live.map((p) => `<option value="${esc(p.id)}">${esc(pupLabel(p))}</option>`).join('')}</select></div>
          <div class="field"><label>Date</label><input id="pk-date" type="date" value="${esc(today)}"></div>
          <p class="field-hint">Creates a Sale (deposit pending, price and deposit from this litter's expected amounts), marks the pup placed, and moves the family off the list as placed. Any other open offers they have are voided.</p>`,
        onConfirm: async (o) => {
          res = await actions.recordOutcome(open.id, 'accepted', { chosenDogId: o.querySelector('#pk-dog').value, date: o.querySelector('#pk-date').value || today });
          saleId = res.sale.id;
        }
      });
      if (!done) return;
      await onChange();
      const lines = await changeLines(res, await freshEntries(litter), familyName);
      if (!res.next) lines.push('Nobody else on the list is eligible for this litter right now.');
      if (await confirmModal({ title: 'Sale created', message: `${lines.join('\n\n')}\n\nOpen the sale to add the deposit and details?`, confirmLabel: 'Open the sale', cancelLabel: 'Stay here' })) {
        location.href = `sale.html?id=${encodeURIComponent(saleId)}`;
      }
    });
    for (const outcome of ['passed', 'no_response']) {
      on(outcome, async () => {
        const verb = outcome === 'passed' ? 'passed on this litter' : 'didn\'t respond in time';
        if (!(await confirmModal({ title: `${name} ${verb}?`, message: 'The turn moves to the next eligible family.', confirmLabel: 'Record it' }))) return;
        const res = await actions.recordOutcome(open.id, outcome);
        await alertModal(await outcomeMessage(name, res, await freshEntries(litter), familyName));
      });
    }
    on('voided', async () => {
      if (!(await confirmModal({ title: 'Void this offer?', message: `Use this if the offer was a mistake or the litter fell through. It never counts as a pass for ${name}, and the turn isn't moved on automatically.`, confirmLabel: 'Void it' }))) return;
      await actions.recordOutcome(open.id, 'voided');
    });
  }
}

async function freshEntries(litter) {
  return new Map((await waitlistEntryRepo.getByKennel(litter.kennel_id, { includeArchived: true })).map((e) => [e.id, e]));
}

function offeredMessage(offer, entriesById, familyName) {
  const e = entriesById.get(offer.entry_id);
  return {
    title: 'Offer made',
    message: `It's ${e ? familyName(e) : 'the next family'}'s turn. They have until ${fmtDate(offer.respond_by_date)} to respond. Let them know; nothing is sent automatically yet.`
  };
}

// describeOfferChanges, with names from a fresh read: an accept or a removal may
// have closed the family's offers on OTHER litters, which this panel hasn't loaded.
async function changeLines(res, entriesById, familyName) {
  const [litters, dogs] = await Promise.all([litterRepo.getAll({ includeArchived: true }), dogRepo.getAll({ includeArchived: true })]);
  const littersById = new Map(litters.map((l) => [l.id, l]));
  const dogName = (id) => dogs.find((d) => d.id === id)?.call_name || '—';
  return describeOfferChanges(res, {
    nameOf: (id) => { const e = entriesById.get(id); return e ? familyName(e) : 'the next family'; },
    litterOf: (id) => { const l = littersById.get(id); return l ? (l.nickname || `${dogName(l.dam_id)} × ${dogName(l.sire_id)}`) : 'A litter'; },
    fmtDate
  });
}

async function outcomeMessage(name, res, entriesById, familyName) {
  const lines = [];
  if (res.passes) {
    if (!res.passes.counted) lines.push(`This doesn't count as a pass for ${name}.`);
    else if (res.removed) lines.push(`That was ${name}'s pass ${res.passes.used} of ${res.passes.max}, so they've been removed from the list. You can undo this from their page for 7 days.`);
    else lines.push(`This counts as ${name}'s pass ${res.passes.used} of ${res.passes.max}. They keep their place.`);
  }
  lines.push(...(await changeLines(res, entriesById, familyName)));
  if (!res.next) lines.push('Nobody else on the list is eligible for this litter right now.');
  return { title: 'Recorded', message: lines.join('\n\n') };
}
