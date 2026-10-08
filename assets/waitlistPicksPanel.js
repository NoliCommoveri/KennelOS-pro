// waitlistPicksPanel.js — the Litter page's "Waitlist picks" panel (Waitlist Spec
// §6.5, §16.1; End-State guide §29). Offers are TURNS: one family at a time across
// the kennel's open litters, each turn covering every open litter they match, so
// this litter's open offer may be one part of a family's turn, and the turn may be
// held on another litter entirely. Open/close picks, the open offer with its outcome
// buttons (picked a pup → a held Sale, deposit received, change pup, passed, no
// response / no deposit, void), who's next, the litter queue, and the litter's
// offer history (change pup on the last accepted pick, undo a pass). Pro-only: litter.js (a shared page)
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
  waitlistConfig, litterQueue, nextTurn, openTurns, turnOffers, turnIdOf, eligiblePupsFor, isPupAvailable,
  overallPositions, entryName, describeOfferChanges, soonFamiliesForLitter,
  isAwaitingDeposit, switchablePups, canSwitchAcceptedPick, undoPassBlocker, autoOffers, autoOfferSummary, closingTrigger
} from '../data/waitlistRules.js';
import { WAITLIST_OFFER_OUTCOME, SEX } from '../data/vocab.js';
import { esc, badge, fmtDate, todayYMD, confirmModal, alertModal } from './ui.js';
import { openSoonNotice, pickDialog, depositDialog, changePickDialog, undoPassDialog, statusLinkFor, copyLink } from './waitlistUI.js';

const none = '<span class="faint">—</span>';
const QUEUE_PREVIEW = 5;

async function loadData(litter) {
  const [kennel, entries, kennelOffers, dogs, allLitters, programsById, allSales, contacts] = await Promise.all([
    kennelRepo.getById(litter.kennel_id),
    waitlistEntryRepo.getByKennel(litter.kennel_id),
    waitlistOfferRepo.getByKennel(litter.kennel_id),
    dogRepo.getAll({ includeArchived: true }),
    litterRepo.getAll({ includeArchived: true }),
    waitlistProgramRepo.getMapForKennel(litter.kennel_id),
    saleRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true })
  ]);
  const pups = dogs.filter((d) => d.litter_id === litter.id);
  const pupIds = new Set(pups.map((d) => d.id));
  // The kennel's litters and their pups: a turn covers every open litter (§16.1).
  const kennelLitters = allLitters.filter((l) => l.kennel_id === litter.kennel_id).map((l) => (l.id === litter.id ? litter : l));
  const kennelLitterIds = new Set(kennelLitters.map((l) => l.id));
  const kennelPups = dogs.filter((d) => kennelLitterIds.has(d.litter_id));
  const kennelPupIds = new Set(kennelPups.map((d) => d.id));
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  return {
    kennel, entries, pups, programsById, kennelLitters, kennelPups,
    kennelSales: allSales.filter((s) => kennelPupIds.has(s.dog_id)),
    litterName: (id) => {
      const l = kennelLitters.find((x) => x.id === id);
      return l ? (l.nickname || `${dogsById.get(l.dam_id)?.call_name || 'Unknown'} × ${dogsById.get(l.sire_id)?.call_name || 'Unknown'}`) : 'another litter';
    },
    offers: kennelOffers.filter((o) => o.litter_id === litter.id),
    // Every offer on the kennel: the "almost your turn" notice skips families
    // holding an open offer on ANY litter.
    kennelOffers,
    sales: allSales.filter((s) => pupIds.has(s.dog_id)),
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
  // The turn open in the kennel (at most one since §16.1; older offers may leave more).
  const kennelTurns = openTurns(d.kennelOffers, litter.kennel_id);
  const otherLitters = (offer) => turnOffers(d.kennelOffers, turnIdOf(offer)).filter((o) => o.outcome === 'open' && o.litter_id !== offer.litter_id).map((o) => d.litterName(o.litter_id));
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
    const picked = isAwaitingDeposit(open) ? pupsById.get(open.chosen_dog_id) : null;
    // Her request (W2 Plan §8): the family's status-page link, to send by Messenger.
    const copyBtn = entry && statusLinkFor(entry, d.kennel)
      ? '<button class="btn btn-sm" data-pk="copy-link" title="Their status page, to send by Messenger or text">Copy status link</button>' : '';
    openHtml = `
      <div class="card" style="margin:12px 0 0;background:var(--surface-2, transparent);">
        <p style="margin:0 0 6px;"><strong>${entry ? familyLink(entry) : 'A family'}'s turn</strong> since ${esc(fmtDate(open.offered_date))}
          · pick and pay by <strong>${esc(fmtDate(open.respond_by_date))}</strong>${overdue ? ' <span class="badge badge-red">Deadline passed</span>' : ''}</p>
        ${otherLitters(open).length ? `<p class="muted" style="margin:0 0 6px;">Their turn also covers ${esc(otherLitters(open).join(', '))}: they pick one pup from any of them, or pass on all of them.</p>` : ''}
        ${isAwaitingDeposit(open)
          ? `<p style="margin:0 0 10px;"><span class="badge badge-purple">Picked ${esc(picked ? picked.call_name : 'a pup')}</span> <span class="muted">held until the deposit arrives${open.sale_id ? ` · <a href="sale.html?id=${encodeURIComponent(open.sale_id)}">open the sale</a>` : ''}</span></p>
        <div class="pill-row">
          <button class="btn btn-primary btn-sm" data-pk="deposit">Deposit received…</button>
          <button class="btn btn-sm" data-pk="change">Change pup…</button>
          <button class="btn btn-sm" data-pk="passed">Passed</button>
          <button class="btn btn-sm" data-pk="no_response" title="The deposit didn't arrive in time (counts like no response)">No deposit</button>
          <button class="btn btn-sm" data-pk="voided" title="Cancel this offer (never counts as a pass)">Void</button>
          ${copyBtn}
        </div>`
          : `<p class="muted" style="margin:0 0 10px;">Pups available to them: ${live.length ? esc(live.map(pupLabel).join(', ')) : 'none right now'}</p>
        <div class="pill-row">
          <button class="btn btn-primary btn-sm" data-pk="accept"${live.length ? '' : ' disabled'}>Picked a pup…</button>
          <button class="btn btn-sm" data-pk="passed">Passed</button>
          <button class="btn btn-sm" data-pk="no_response">No response</button>
          <button class="btn btn-sm" data-pk="voided" title="Cancel this offer (never counts as a pass)">Void</button>
          ${copyBtn}
        </div>`}
      </div>`;
  }

  // --- Who's next (picks open, no turn open in the kennel) ---
  let nextHtml = '';
  const heldElsewhere = !open ? kennelTurns[0] : null;
  if (heldElsewhere) {
    const holder = entriesById.get(heldElsewhere.entry_id);
    nextHtml = `<p class="muted" style="margin:12px 0 0;">${holder ? familyLink(holder) : 'Another family'} holds the turn (${esc(heldElsewhere.offers.map((o) => d.litterName(o.litter_id)).join(', '))}) until ${esc(fmtDate(heldElsewhere.respond_by_date))}. One family at a time across your open litters: the next turn is worked out when theirs closes.</p>`;
  } else if (picksOpen && !open) {
    const next = nextTurn(d.entries, d.kennelOffers, d.kennelLitters, d.kennelPups, d.kennelSales, { ...opts, kennelId: litter.kennel_id });
    const here = next && next.litters.some((x) => x.litter.id === litter.id);
    const others = next ? next.litters.filter((x) => x.litter.id !== litter.id).map((x) => d.litterName(x.litter.id)) : [];
    nextHtml = next
      ? `<p style="margin:12px 0 0;">Next turn: <strong>${familyLink(next.entry)}</strong>${here ? (others.length ? ` <span class="muted">(this litter and ${esc(others.join(', '))})</span>` : '') : ` <span class="muted">(for ${esc(others.join(', '))}; nobody ahead of them is waiting for this litter)</span>`} <button class="btn btn-sm btn-primary" data-pk="offer-next">Offer to them</button></p>`
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
        <table class="data" style="margin-top:8px;"><thead><tr><th>Family</th><th>Offered</th><th>Outcome</th><th>Pass?</th><th></th></tr></thead><tbody>${
          history.map((o) => {
            const e = entriesById.get(o.entry_id);
            const pup = o.chosen_dog_id ? pupsById.get(o.chosen_dog_id) : null;
            const act = canSwitchAcceptedPick(o, d.kennelOffers)
              ? `<button class="btn btn-sm" data-pk-change="${esc(o.id)}" title="Allowed until the next family is offered this litter">Change pup…</button>`
              : !undoPassBlocker(o, e, today) ? `<button class="btn btn-sm" data-pk-undo="${esc(o.id)}" title="Erase this and give them their turn back">Undo…</button>` : '';
            return `<tr><td>${e ? familyLink(e) : none}</td><td>${esc(fmtDate(o.offered_date))}</td><td>${badge(WAITLIST_OFFER_OUTCOME, o.outcome)}${pup ? ` ${esc(pup.call_name)}` : ''}${o.outcome_date ? ` <span class="faint">${esc(fmtDate(o.outcome_date))}</span>` : ''}</td><td>${o.counts_as_pass ? '<span class="badge badge-amber">Counts</span>' : none}</td><td>${act}</td></tr>`;
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
        ? `Picks opened ${esc(fmtDate(litter.picks_opened_date))}. One family at a time across all your open litters, in list order; each turn shows every pup they match in every open litter, and only passing on all of them counts as a pass. Families with no matching pup, paused, or listening only for other sires or dams are skipped and nothing is held against them. A pup is only theirs once the deposit is in. ${autoOfferSummary(d.config)} Nothing is sent automatically, so tell each family yourself.`
        : `${available.length} pup${available.length === 1 ? '' : 's'} available. Opening picks offers the next turn (${esc(d.config.respond_days)} days to pick and pay the deposit), or, while a family holds a turn, adds this litter to it when they're first in line for it.`}</p>
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
    const turn = await actions.openPicks(litter.id);
    await alertModal(turn ? offeredMessage(turn, entriesById, familyName, d.litterName)
      : { title: 'Picks are open', message: heldElsewhere || kennelTurns.length
        ? 'Another family holds the turn and isn\'t first in line for this litter, so it waits for the next turn.'
        : 'Nobody on the list is eligible for the available pups yet. A family is offered as soon as one becomes eligible and you tap "Offer to them".' });
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
    const turn = await actions.offerNext(litter.id);
    if (turn) await alertModal(offeredMessage(turn, await freshEntries(litter), familyName, d.litterName));
  });

  const turnNote = (outcome) => (autoOffers(d.config, outcome)
    ? 'The turn moves to the next eligible family.'
    : 'Nobody is offered automatically; you\'ll see who\'s next.');

  if (open) {
    const entry = entriesById.get(open.entry_id);
    const name = entry ? familyName(entry) : 'this family';
    const pickedName = open.chosen_dog_id ? (pupsById.get(open.chosen_dog_id)?.call_name || 'their pup') : '';
    // Not wrapped in run(): copying writes nothing.
    const link = entry ? statusLinkFor(entry, d.kennel) : null;
    mount.querySelector('[data-pk="copy-link"]')?.addEventListener('click', (ev) => { if (link) copyLink(link, ev.currentTarget, { title: `${name}'s status page` }); });
    on('accept', async () => {
      const live = eligiblePupsFor(entry, litter, d.pups, d.sales, opts);
      const out = await pickDialog({ offer: open, name, pups: live, pupLabel, carried: entry?.carried_payment || null });
      if (!out) return;
      await onChange();
      const saleId = out.res.sale.id;
      const lines = out.depositDone
        ? [`${name} is placed.`, ...(await changeLines(out.res, await freshEntries(litter), familyName))]
        : [`${pupsById.get(out.res.offer.chosen_dog_id)?.call_name || 'The pup'} is held for ${name} until ${fmtDate(open.respond_by_date)}. Send them the deposit details (the sale has an invoice), and record "Deposit received" when it arrives.`];
      if (await confirmModal({ title: out.depositDone ? 'Deposit received' : 'Pick recorded', message: `${lines.join('\n\n')}\n\nOpen the sale?`, confirmLabel: 'Open the sale', cancelLabel: 'Stay here' })) {
        location.href = `sale.html?id=${encodeURIComponent(saleId)}`;
      }
    });
    on('deposit', async () => {
      const res = await depositDialog({ offer: open, name, pupName: pickedName, sale: open.sale_id ? await saleRepo.getById(open.sale_id) : null, carried: entry?.carried_payment || null });
      if (!res) return;
      await alertModal({ title: `${name} is placed`, message: [`Deposit recorded for ${pickedName}.`, ...(await changeLines(res, await freshEntries(litter), familyName)), ...(res.next || res.waiting.length ? [] : ['Nobody else on the list is eligible for this litter right now.'])].join('\n\n') });
    });
    on('change', async () => {
      const options = switchablePups(entry, litter, d.pups, d.sales, { currentDogId: open.chosen_dog_id, config: d.config });
      await changePickDialog({ offer: open, name, currentName: pickedName, pups: options, pupLabel });
    });
    const lapse = open.chosen_dog_id ? ` Their pick lapses: the sale is cancelled and ${pickedName} is available again.` : '';
    for (const outcome of ['passed', 'no_response']) {
      on(outcome, async () => {
        const also = otherLitters(open);
        const title = outcome === 'passed' ? (also.length ? `${name} passed on their whole turn?` : `${name} passed on this litter?`)
          : open.chosen_dog_id ? `No deposit from ${name}?` : `${name} didn't respond in time?`;
        const whole = also.length ? ` This closes their whole turn, including ${also.join(', ')}, and counts once.` : '';
        if (!(await confirmModal({ title, message: `${turnNote(closingTrigger(open, outcome))}${whole}${lapse}`, confirmLabel: 'Record it' }))) return;
        const res = await actions.recordOutcome(open.id, outcome);
        await alertModal(await outcomeMessage(name, res, await freshEntries(litter), familyName));
      });
    }
    on('voided', async () => {
      const also = otherLitters(open);
      if (!(await confirmModal({ title: 'Void this turn?', message: `Use this if the offer was a mistake or the litter fell through. It never counts as a pass for ${name}, and the turn isn't moved on automatically.${also.length ? ` It voids their whole turn, including ${also.join(', ')}.` : ''}${lapse}`, confirmLabel: 'Void it' }))) return;
      await actions.recordOutcome(open.id, 'voided');
    });
  }

  // History actions: switch an accepted pick (until the next family is offered),
  // undo a pass / no response.
  mount.querySelectorAll('[data-pk-change]').forEach((btn) => btn.addEventListener('click', run(async () => {
    const o = d.offers.find((x) => x.id === btn.dataset.pkChange);
    const entry = entriesById.get(o.entry_id);
    const options = switchablePups(entry, litter, d.pups, d.sales, { currentDogId: o.chosen_dog_id, config: d.config });
    await changePickDialog({ offer: o, name: familyName(entry), currentName: pupsById.get(o.chosen_dog_id)?.call_name || 'their pup', pups: options, pupLabel });
  })));
  mount.querySelectorAll('[data-pk-undo]').forEach((btn) => btn.addEventListener('click', run(async () => {
    const o = d.offers.find((x) => x.id === btn.dataset.pkUndo);
    const entry = entriesById.get(o.entry_id);
    const name = familyName(entry);
    const holding = kennelTurns.find((t) => t.id !== turnIdOf(o));
    const holder = holding ? entriesById.get(holding.entry_id) : null;
    const res = await undoPassDialog({ offer: o, name, holderName: holder ? familyName(holder) : null, removed: entry.status === 'removed' });
    if (!res) return;
    await alertModal({ title: 'Their turn is back', message: [`${name}'s turn is back (${res.offers.map((x) => d.litterName(x.litter_id)).join(', ')}), with until ${fmtDate(res.offer.respond_by_date)} to pick and pay the deposit. Let them know; nothing is sent automatically.`, ...(await changeLines(res, await freshEntries(litter), familyName))].join('\n\n') });
  })));
}

async function freshEntries(litter) {
  return new Map((await waitlistEntryRepo.getByKennel(litter.kennel_id, { includeArchived: true })).map((e) => [e.id, e]));
}

// `turn` from offerNext / openPicks: { entry_id, litter_ids, respond_by_date, joined? }.
function offeredMessage(turn, entriesById, familyName, litterName) {
  const e = entriesById.get(turn.entry_id);
  const name = e ? familyName(e) : 'the next family';
  const litters = (turn.litter_ids || []).map(litterName).join(', ');
  return turn.joined
    ? { title: 'Added to their turn', message: `${name} is first in line for this litter too, so it joined their turn (${litters}). Their deadline restarted: until ${fmtDate(turn.respond_by_date)}. Let them know; nothing is sent automatically yet.` }
    : { title: 'Turn offered', message: `It's ${name}'s turn (${litters}). They have until ${fmtDate(turn.respond_by_date)} to pick a pup from any of these and send the deposit, or pass. Let them know; nothing is sent automatically yet.` };
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
  if (!res.next && !(res.waiting || []).length) lines.push('Nobody else on the list is eligible for this litter right now.');
  return { title: 'Recorded', message: lines.join('\n\n') };
}
