// nudges.js — the derived-nudge engine (Data Integrity Brief §2). Computes a
// prompt from current record state ONLY — the dismissal ledger is a separate
// concern (data/nudgeState.js) that today.js applies when it renders: filter
// out isDismissed(key), render the rest, wire each action button, and add a
// generic "Dismiss" affordance next to each nudge's own action(s). Dismiss is
// NOT part of a nudge's `actions` here — it's the same mechanism for every
// nudge, so the renderer owns it, not each rule. The one exception is the
// stud→pairing rule's auto-dismiss (§4.7): that's derived from `pairing_id`
// being set, not the ledger, so it belongs here, not in the renderer.
//
// Nothing here mutates a record on its own; every action is a user-confirmed
// button click.
//
// Nine rules (End-State guide §19), each producing zero or more nudges:
// stud-service status (§4.2), promote-lifecycle (§4.3), heat→pairing (§4.5),
// stud→pairing (§4.7), the overdue-pairing rule, three litter-lifecycle
// rules (litter→sold / reopen / close) grouped over each litter's roster below,
// and the Pro-only show-track-complete → "log the title?" rule (Show Tracking
// Spec §5.4, gated on editionFlags.shows). Plus the Pro-only waitlist rules
// (Waitlist Spec §6.5, gated on editionFlags.waitlist): new applications, an
// offer past its deadline, a fee past its pay-by date, and the 7-day undo on a
// second-pass removal — each a one-tap suggestion, never an automatic write;
// and, from W2 step 5, what families asked for or said on their status page (a
// pause, a listen-only narrowing, an answer change: Approve / Decline; messages
// and activity: Mark read).
//   { key, title, detail, subjectHref, actions: [{ label, run: async () => {} }] }
// `run` may resolve to { title, message }, which Today shows once it's done.
import { studServiceRepo } from './studServiceRepo.js';
import { dogRepo } from './dogRepo.js';
import { kennelRepo } from './kennelRepo.js';
import { pairingRepo } from './pairingRepo.js';
import { litterRepo } from './litterRepo.js';
import { saleRepo } from './saleRepo.js';
import { eventRepo } from './eventRepo.js';
import { dogsInScope, inScopeOnly, subjectInScope } from './kennelScope.js';
import { todayYMD, monthsBetween, addDaysToYMD } from './dateUtils.js';
import { descriptor, PAIRING_STATUS, LITTER_STATUS } from './vocab.js';
import { editionFlags } from './editionConfig.js';
import { showRecordFrom } from './showPoints.js';
import { waitlistEntryRepo } from './waitlistEntryRepo.js';
import { waitlistOfferRepo } from './waitlistOfferRepo.js';
import { contactRepo } from './contactRepo.js';
import { accountRepo } from './accountRepo.js';
import { goHomeDate, daysBetween, followUpMessage, sharedReferrals, FOLLOW_UP_DAYS, FOLLOW_UP_WINDOW_DAYS } from './referralShare.js';
import { waitlistProgramRepo } from './waitlistProgramRepo.js';
import {
  overdueTurns, overdueFees, canUndoRemoval, entryName, describeOfferChanges, waitlistConfig, autoOffers, closingTrigger,
  prefChangeSummary, prefChangeEffect, PREF_FIELD_LABEL, depositsDueLitters,
  readyCheck, readyCheckOverdue
} from './waitlistRules.js';
import {
  recordOutcome, markFeeExpired, openPicks, recordReadyAnswer, undoRemoval, hasPendingRequest, markMessagesRead,
  approvePauseRequest, declinePauseRequest, approvePrefChange, declinePrefChange, approveListenChange, declineListenChange,
  markCompanionLinkSent, declineCompanionRequest
} from './waitlistActions.js';
import { offerSpecs } from './waitlistOutbox.js';

const TERMINAL_PAIRING_STATUSES = ['cancelled', 'failed'];

// Pre-whelp: still expecting a litter, not yet resolved one way or the other.
const PRE_WHELP_STATUSES = ['planned', 'bred', 'confirmed_pregnant'];

// Shared dedup (§4.5/§4.7): is there already a live pairing for this dam,
// opened on/after `sinceYMD`? "Opened" prefers planned_date, falling back to
// created_at for a pairing entered without one — either way, a pairing that
// predates the window in question doesn't count as "already handled."
function pairingExistsForDam(pairings, damId, sinceYMD) {
  return pairings.some((p) => {
    if (p.dam_id !== damId || TERMINAL_PAIRING_STATUSES.includes(p.status)) return false;
    if (!sinceYMD) return true;
    const openedOn = p.planned_date || (p.created_at || '').slice(0, 10);
    return !openedOn || openedOn >= sinceYMD;
  });
}

function studPartnerLabel(s, dogsById) {
  return `${dogsById.get(s.our_dog_id)?.call_name || 'Our dog'} × ${dogsById.get(s.partner_dog_id)?.call_name || 'partner'}`;
}

function pairingLabel(p, dogsById) {
  return `${dogsById.get(p.dam_id)?.call_name || 'Dam'} × ${dogsById.get(p.sire_id)?.call_name || 'Sire'}`;
}

// Litter display label — mirrors the litter page's title logic: the nickname
// leads when present, otherwise dam × sire.
function litterLabel(l, dogsById) {
  return l.nickname || `${dogsById.get(l.dam_id)?.call_name || 'Dam'} × ${dogsById.get(l.sire_id)?.call_name || 'Sire'}`;
}

// §4.2 — stud-service status nudges. Never both at once for the same record:
// if the return date has already passed, prefer the "completed" nudge over
// "in progress" (checked first in the caller's loop).
function studCompletedNudge(s, dogsById) {
  return {
    key: `studstatus:${s.id}:completed`,
    title: 'Mark this stud service completed?',
    detail: `${studPartnerLabel(s, dogsById)} — returned ${s.returned_date}.`,
    subjectHref: `stud-service.html?id=${encodeURIComponent(s.id)}`,
    actions: [
      { label: 'Mark completed', run: async () => { await studServiceRepo.update(s.id, { status: 'completed' }); } }
    ]
  };
}

function studInProgressNudge(s, dogsById) {
  return {
    key: `studstatus:${s.id}:in_progress`,
    title: 'Mark this stud service in progress?',
    detail: `${studPartnerLabel(s, dogsById)} — sent ${s.sent_date}.`,
    subjectHref: `stud-service.html?id=${encodeURIComponent(s.id)}`,
    actions: [
      { label: 'Mark in progress', run: async () => { await studServiceRepo.update(s.id, { status: 'in_progress' }); } }
    ]
  };
}

export async function computeNudges() {
  const today = todayYMD();
  const [studServices, dogs, kennels, pairings, events, litters, sales] = await Promise.all([
    studServiceRepo.getAll(),
    dogRepo.getAll(),
    kennelRepo.getAll(),
    pairingRepo.getAll(),
    eventRepo.getAll(),
    litterRepo.getAll({ includeArchived: true }),
    saleRepo.getAll()
  ]);
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const kennelsById = new Map(kennels.map((k) => [k.id, k]));

  // Active-kennel scope (Multi-Kennel Scope Spec §7). A nudge is a prompt to act
  // on one record, so each rule iterates the SCOPED set of whatever it nudges
  // about — you should not be prompted about the kennel you aren't looking at.
  //
  // The unscoped originals stay in play for every LOOKUP and every "has this
  // already been handled?" test below (`pairingExistsForDam`, `pairingIdsWithLitter`,
  // `pupsByLitter`, `salesByDog`). That asymmetry is the point: scoping a dedup
  // check would resurrect a nudge whose answer already exists one kennel over —
  // "record the pairing for this stud service" when the pairing is sitting in
  // kennel B. All four are pass-throughs when unscoped (Lite, "All kennels").
  const scopedStudServices = inScopeOnly(studServices);
  const scopedPairings = inScopeOnly(pairings);
  const scopedLitters = inScopeOnly(litters);
  const scopedDogs = dogsInScope(dogs);
  // Pairings that already have a litter recorded against them — precomputed once
  // so the overdue-pairing rule below is a Set lookup, not a per-pairing query
  // (getForPairing counts archived litters too, matching includeArchived above).
  const pairingIdsWithLitter = new Set(litters.map((l) => l.pairing_id).filter(Boolean));

  const nudges = [];

  // §4.2 — stud-service status nudges.
  for (const s of scopedStudServices) {
    let n = null;
    if (s.returned_date && s.returned_date < today && ['arranged', 'in_progress'].includes(s.status)) {
      n = studCompletedNudge(s, dogsById);
    } else if (s.sent_date && s.sent_date <= today && s.status === 'arranged') {
      n = studInProgressNudge(s, dogsById);
    }
    if (n) nudges.push(n);
  }

  // §4.3 — promote-lifecycle nudge: opt-in per kennel, decide-not-auto-promote.
  for (const d of scopedDogs) {
    if (d.status !== 'puppy' || d.disposition !== 'keeping' || !d.date_of_birth) continue;
    const kennel = d.kennel_id ? kennelsById.get(d.kennel_id) : null;
    if (!kennel || kennel.promote_nudge_enabled !== true) continue;
    const threshold = d.sex === 'male' ? kennel.promote_age_male_months
      : d.sex === 'female' ? kennel.promote_age_female_months : null;
    if (threshold == null) continue;
    const ageMonths = monthsBetween(d.date_of_birth, today);
    if (ageMonths < threshold) continue;
    const key = `promote:${d.id}`;
    nudges.push({
      key,
      title: `${d.call_name} is old enough — promote to active breeding?`,
      detail: `${ageMonths} months old, kept for breeding (threshold: ${threshold}).`,
      subjectHref: `dog.html?id=${encodeURIComponent(d.id)}`,
      actions: [
        { label: 'Promote', run: async () => { await dogRepo.update(d.id, { status: 'active_breeding', status_date: today }); } }
      ]
    });
  }

  // §4.7 — stud service completed/overdue with no linked pairing yet.
  // Auto-dismiss: once pairing_id is set the rule produces nothing at all —
  // no ledger entry needed, the link itself is the done-signal.
  for (const s of scopedStudServices) {
    if (s.pairing_id) continue;
    const isDone = s.status === 'completed' || (s.returned_date && s.returned_date < today);
    if (!isDone) continue;
    const key = `studpair:${s.id}`;
    const damId = s.direction === 'incoming' ? s.our_dog_id : s.partner_dog_id;
    if (damId && pairingExistsForDam(pairings, damId, s.sent_date)) continue;
    nudges.push({
      key,
      title: 'Record the pairing for this stud service?',
      detail: studPartnerLabel(s, dogsById),
      subjectHref: `stud-service.html?id=${encodeURIComponent(s.id)}`,
      actions: [
        { label: 'Create pairing', run: async () => { location.href = `pairing.html?new=1&stud_service=${encodeURIComponent(s.id)}`; } }
      ]
    });
  }

  // §4.5 — concluded heat cycle with no matching pairing since it started.
  const concludedHeats = events.filter((e) =>
    e.event_type === 'heat_cycle' && e.subject_type === 'dog' && e.event_end_date && e.event_end_date < today
    // Scoped through the dam the heat was logged on (an Event carries no kennel
    // of its own — §4.1); an external dam stays scope-transparent.
    && subjectInScope('dog', e.subject_id, { dog: dogsById })
  );
  for (const ev of concludedHeats) {
    const key = `heatpair:${ev.id}`;
    const damId = ev.subject_id;
    if (pairingExistsForDam(pairings, damId, ev.event_date)) continue;
    const dam = dogsById.get(damId);
    nudges.push({
      key,
      title: `${dam?.call_name || 'This dam'} finished a heat — record a pairing?`,
      detail: `Heat concluded ${ev.event_end_date}.`,
      subjectHref: `dog.html?id=${encodeURIComponent(damId)}`,
      actions: [
        { label: 'Create pairing', run: async () => { location.href = `pairing.html?new=1&dam=${encodeURIComponent(damId)}`; } }
      ]
    });
  }

  // Overdue pairing — still pre-whelp status past its own expected due date,
  // with no litter recorded against it yet. Suggests both fixes: sync the
  // status, or go record the litter (deep-links to the same
  // litter.html?new=1&pairing=<id> prefill the pairing page's own "Create
  // Litter" button uses).
  for (const p of scopedPairings) {
    if (!PRE_WHELP_STATUSES.includes(p.status) || !p.expected_due_date || p.expected_due_date >= today) continue;
    if (pairingIdsWithLitter.has(p.id)) continue;
    nudges.push({
      key: `pairingoverdue:${p.id}`,
      title: `${pairingLabel(p, dogsById)} is past its expected due date`,
      detail: `Expected ${p.expected_due_date} — still marked "${descriptor(PAIRING_STATUS, p.status).label}".`,
      subjectHref: `pairing.html?id=${encodeURIComponent(p.id)}`,
      actions: [
        { label: 'Mark whelped', run: async () => { await pairingRepo.update(p.id, { status: 'whelped' }); } },
        { label: 'Create litter', run: async () => { location.href = `litter.html?new=1&pairing=${encodeURIComponent(p.id)}`; } }
      ]
    });
  }

  // Litter-lifecycle nudges — all three are aggregate facts over a litter's
  // puppy roster (and, for the close rule, its sales), so they're grouped once
  // here from data already loaded above rather than re-scanned per record on
  // every pup/sale save. Non-archived, non-empty rosters only.
  const pupsByLitter = new Map();
  for (const d of dogs) {
    if (!d.litter_id) continue;
    const arr = pupsByLitter.get(d.litter_id);
    if (arr) arr.push(d); else pupsByLitter.set(d.litter_id, [d]);
  }
  const salesByDog = new Map();
  for (const s of sales) {
    const arr = salesByDog.get(s.dog_id);
    if (arr) arr.push(s); else salesByDog.set(s.dog_id, [s]);
  }

  for (const l of scopedLitters) {
    if (l.is_archived) continue;
    const pups = pupsByLitter.get(l.id);
    if (!pups || pups.length === 0) continue;
    const label = litterLabel(l, dogsById);
    const href = `litter.html?id=${encodeURIComponent(l.id)}`;
    const anyAvailable = pups.some((p) => p.disposition === 'available');

    // Every pup resolved to placed/keeping (or on a health hold — not for sale),
    // with at least one actually placed (an all-keeping litter never "sold"
    // anything) → suggest marking it sold.
    if (l.status === 'ready'
      && pups.every((p) => ['placed', 'keeping', 'health_hold'].includes(p.disposition))
      && pups.some((p) => p.disposition === 'placed')) {
      nudges.push({
        key: `littersold:${l.id}`,
        title: `${label} — all puppies spoken for. Mark the litter sold?`,
        detail: 'Every puppy is placed or being kept.',
        subjectHref: href,
        actions: [
          { label: 'Mark sold', run: async () => { await litterRepo.update(l.id, { status: 'sold' }); } }
        ]
      });
    }

    // A puppy came back available on a sold/closed litter → suggest reopening.
    if ((l.status === 'sold' || l.status === 'closed') && anyAvailable) {
      nudges.push({
        key: `litterreopen:${l.id}`,
        title: `${label} has a puppy available again — reopen the litter?`,
        detail: `Marked "${descriptor(LITTER_STATUS, l.status).label}" but a puppy is available.`,
        subjectHref: href,
        actions: [
          { label: 'Reopen to Ready', run: async () => { await litterRepo.update(l.id, { status: 'ready' }); } }
        ]
      });
    }

    // Every placed puppy has a delivered sale (a placed pup with no delivered
    // sale — including none at all — blocks this) → suggest closing the litter.
    if (l.status === 'sold' && !anyAvailable) {
      const placed = pups.filter((p) => p.disposition === 'placed');
      const allDelivered = placed.length > 0 && placed.every((p) =>
        (salesByDog.get(p.id) || []).some((s) => s.status === 'delivered'));
      if (allDelivered) {
        nudges.push({
          key: `litterclose:${l.id}`,
          title: `${label} — every placement delivered. Close the litter?`,
          detail: 'All placed puppies have a delivered sale.',
          subjectHref: href,
          actions: [
            { label: 'Close litter', run: async () => { await litterRepo.update(l.id, { status: 'closed' }); } }
          ]
        });
      }
    }
  }

  // Show Tracking Spec §5.4 — a title track the dog's results complete, with no
  // matching title_earned logged yet → suggest logging it. Decide-not-auto: the
  // action only opens a prefilled event form on the dog's page. Auto-dismisses
  // once the title_earned event exists (the event is the done-signal). Pro-only.
  if (editionFlags.shows) {
    const eventsByDog = new Map();
    for (const e of events) {
      if (e.subject_type !== 'dog' || (e.event_type !== 'show' && e.event_type !== 'title_earned')) continue;
      const arr = eventsByDog.get(e.subject_id);
      if (arr) arr.push(e); else eventsByDog.set(e.subject_id, [e]);
    }
    for (const d of scopedDogs) {
      const dogEvents = eventsByDog.get(d.id);
      if (!dogEvents?.some((e) => e.event_type === 'show')) continue;
      for (const { track, progress, titleEvent } of showRecordFrom(dogEvents).tracks) {
        if (!progress.complete || titleEvent) continue;
        const qs = new URLSearchParams({
          id: d.id,
          logEvent: 'title_earned',
          logTitle: track.label,
          logDetails: JSON.stringify({ title_abbreviation: track.title, organization: track.organization })
        });
        if (progress.completedOn) qs.set('logDate', progress.completedOn);
        nudges.push({
          key: `show-title:${d.id}:${track.value}`,
          title: `${d.call_name} has finished the ${track.title} — log the title?`,
          detail: `${track.label} requirements met${progress.completedOn ? ` on ${progress.completedOn}` : ''}.`,
          subjectHref: `dog.html?id=${encodeURIComponent(d.id)}`,
          actions: [
            { label: 'Log title', run: async () => { location.href = `dog.html?${qs.toString()}`; } }
          ]
        });
      }
    }
  }

  if (editionFlags.waitlist) nudges.push(...(await waitlistNudges(today, litters, dogsById, { dogs, sales })));
  if (editionFlags.accounts) nudges.push(...(await followUpNudges(today, inScopeOnly(sales), events, dogsById, kennelsById)));

  return nudges;
}

// --- Follow-up a week after going home (Integrations plan §3) ----------------------
// Pro (with Accounts, whose shared referral links the note carries). A delivered
// sale whose pup went home (its latest placement event, else the balance-paid
// date) FOLLOW_UP_DAYS to FOLLOW_UP_WINDOW_DAYS ago suggests a note to the buyer:
// a how-is-it-going and thank-you, with the products she shares with families.
// The note opens in the composer (Today reads `compose`); she sends it herself.
// Key per sale, so Dismiss (or sending it) retires it for good.
async function followUpNudges(today, sales, events, dogsById, kennelsById) {
  const delivered = sales.filter((s) => s.status === 'delivered' && s.buyer_contact_id);
  if (!delivered.length) return [];
  const [contacts, accounts] = await Promise.all([contactRepo.getAll({ includeArchived: true }), accountRepo.getAll()]);
  const contactsById = new Map(contacts.map((c) => [c.id, c]));
  const referrals = sharedReferrals(accounts);
  const placements = new Map(); // dog id -> placement dates
  for (const e of events) {
    if (e.event_type !== 'placement' || e.subject_type !== 'dog' || !e.event_date) continue;
    if (!placements.has(e.subject_id)) placements.set(e.subject_id, []);
    placements.get(e.subject_id).push(e.event_date);
  }
  const out = [];
  for (const s of delivered) {
    const home = goHomeDate(s, placements.get(s.dog_id) || [], today);
    if (!home) continue;
    const days = daysBetween(home, today);
    if (days < FOLLOW_UP_DAYS || days > FOLLOW_UP_WINDOW_DAYS) continue;
    const buyer = contactsById.get(s.buyer_contact_id);
    if (!buyer) continue;
    const pup = dogsById.get(s.dog_id)?.call_name || 'their puppy';
    const kennelName = kennelsById.get(s.kennel_id)?.kennel_name || '';
    const message = followUpMessage({ buyerName: buyer.name, pupName: pup, kennelName, days, referrals });
    out.push({
      key: `follow-up:${s.id}`,
      title: `Check in with ${buyer.name}: ${pup} went home ${days} days ago`,
      detail: referrals.length
        ? `A thank-you and how-is-it-going note, with what you recommend (${referrals.map((r) => r.name).join(', ')}).`
        : 'A thank-you and how-is-it-going note. (Mark a referral account "Share with families" to add what you recommend.)',
      subjectHref: `sale.html?id=${encodeURIComponent(s.id)}`,
      actions: [{
        label: 'Write the note',
        run: async () => ({
          compose: { title: `Check in with ${buyer.name}`, name: buyer.name, email: buyer.email || '', phone: buyer.phone || '', ...message },
          // Today retires the nudge once she's sent or copied it.
          doneDismisses: true
        })
      }]
    });
  }
  return out;
}

// --- Waitlist (Waitlist Spec §0/§6.5) -------------------------------------------
// W1 has no server, so nothing on the waitlist moves while she's away: these
// surface what needs a decision, and she confirms with one tap. Scoped like every
// rule (the waitlist is per kennel, so entries/offers carry kennel_id).
// A waitlist action's `run` returns the message Today shows afterwards (the turn
// can move on to another family, who she must contact — never silently).
async function waitlistNudges(today, litters, dogsById, { dogs = [], sales = [] } = {}) {
  const [entriesAll, offersAll, contacts, kennels] = await Promise.all([
    waitlistEntryRepo.getAll(),
    waitlistOfferRepo.getAll(),
    contactRepo.getAll({ includeArchived: true }),
    kennelRepo.getAll({ includeArchived: true })
  ]);
  const kennelsById = new Map(kennels.map((k) => [k.id, k]));
  const entries = inScopeOnly(entriesAll);
  const offers = inScopeOnly(offersAll);
  const contactsById = new Map(contacts.map((c) => [c.id, c]));
  const entriesById = new Map(entriesAll.map((e) => [e.id, e]));
  const littersById = new Map(litters.map((l) => [l.id, l]));
  const name = (e) => entryName(e, contactsById.get(e.contact_id));
  const out = [];

  // New applications — one nudge per kennel's queue. The key carries the newest
  // application's id, so dismissing it hides this batch but a new one resurfaces.
  const byKennel = new Map();
  for (const e of entries.filter((x) => x.status === 'applied')) {
    if (!byKennel.has(e.kennel_id)) byKennel.set(e.kennel_id, []);
    byKennel.get(e.kennel_id).push(e);
  }
  for (const [kennelId, list] of byKennel) {
    const newest = [...list].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0];
    out.push({
      key: `waitlist-applications:${kennelId}:${newest.id}`,
      title: list.length === 1 ? `New waitlist application from ${name(newest)}` : `${list.length} new waitlist applications`,
      detail: 'Review and approve or decline.',
      subjectHref: `waitlist.html?kennel=${encodeURIComponent(kennelId)}`,
      actions: [{ label: 'Review', run: async () => { location.href = `waitlist.html?kennel=${encodeURIComponent(kennelId)}`; } }]
    });
  }

  // One per TURN (Spec §16.1): a turn covering two litters is one deadline.
  for (const t of overdueTurns(offers, today)) {
    const e = entriesById.get(t.entry_id);
    if (!e) continue;
    const o = t.offers.find((x) => x.chosen_dog_id) || t.offers[0];
    const covers = t.offers.map((x) => (littersById.get(x.litter_id) ? litterLabel(littersById.get(x.litter_id), dogsById) : 'Litter')).join(', ');
    out.push({
      key: `waitlist-offer-overdue:${t.id}`,
      // A family that picked a pup but never sent the deposit: same outcome (their
      // pick lapses and the held Sale is cancelled), worded for the deposit.
      title: o.chosen_dog_id ? `${name(e)}'s deposit didn't arrive in time` : `${name(e)}'s offer deadline passed`,
      detail: `${covers} — they had until ${t.respond_by_date}${o.chosen_dog_id ? ' to send the deposit for their pick. Recording no deposit frees the pup' : '. Recording no response closes their turn'}${autoOffers(waitlistConfig(kennelsById.get(o.kennel_id)), closingTrigger(o, 'no_response')) ? ' and offers the next family' : ''}.`,
      subjectHref: `litter.html?id=${encodeURIComponent(o.litter_id)}`,
      actions: [{
        label: o.chosen_dog_id ? 'Record no deposit' : 'Record no response',
        run: async () => {
          const res = await recordOutcome(o.id, 'no_response');
          const fresh = new Map((await waitlistEntryRepo.getAll({ includeArchived: true })).map((x) => [x.id, x]));
          const lines = [];
          if (res.passes) {
            lines.push(!res.passes.counted ? `This doesn't count as a pass for ${name(e)}.`
              : res.removed ? `That was ${name(e)}'s pass ${res.passes.used} of ${res.passes.max}, so they've been removed from the list. You can undo this for 7 days.`
              : `This counts as ${name(e)}'s pass ${res.passes.used} of ${res.passes.max}. They keep their place.`);
          }
          lines.push(...describeOfferChanges(res, {
            nameOf: (id) => (fresh.get(id) ? name(fresh.get(id)) : 'the next family'),
            litterOf: (id) => (littersById.get(id) ? litterLabel(littersById.get(id), dogsById) : 'A litter')
          }));
          if (!res.next && !res.waiting.length) lines.push('Nobody else on the list is eligible for your open litters right now.');
          // `emails`: who to offer an email (Today shows the preview; W2 step 6).
          return { title: 'Recorded', message: lines.join('\n\n'), emails: [
            { entryId: e.id, kind: 'deadline_passed', extra: { litterIds: t.offers.map((x) => x.litter_id), respondBy: t.respond_by_date } },
            ...offerSpecs(res)
          ] };
        }
      }]
    });
  }

  for (const e of overdueFees(entries, today)) {
    out.push({
      key: `waitlist-fee-overdue:${e.id}`,
      title: `${name(e)} hasn't paid the application fee`,
      detail: `The pay-by date was ${e.fee_due_date}. Close the application, or mark the fee received on their page.`,
      subjectHref: `waitlist-entry.html?id=${encodeURIComponent(e.id)}`,
      actions: [{ label: 'Close application', run: async () => { await markFeeExpired(e.id); } }]
    });
  }

  for (const e of entries.filter((x) => canUndoRemoval(x, today))) {
    const noAnswer = e.removed_reason === 'no_ready_answer';
    out.push({
      key: `waitlist-removed:${e.id}:${e.removed_date}`,
      title: noAnswer ? `Removed ${name(e)} from the waitlist: no answer to "Ready now?"` : `Removed ${name(e)} from the waitlist after their second pass`,
      detail: `You can undo this until ${addDaysToYMD(e.removed_date, 7)}. ${noAnswer
        ? 'Undoing puts them back in their old place and asks "Ready now?" again from today.'
        : 'Undoing forgives that pass and puts them back in their old place.'}`,
      subjectHref: `waitlist-entry.html?id=${encodeURIComponent(e.id)}`,
      actions: [{
        label: 'Undo',
        run: async () => {
          await undoRemoval(e.id, { today });
          return { title: 'Removal undone', message: `${name(e)} is back in their old place. No offer was made for them; offer a litter from their page when you're ready.` };
        }
      }]
    });
  }
  // "Ready now?" unanswered for longer than her days, under "keep paused" (§16.7):
  // they stay held, so nobody waits forever unnoticed.
  for (const e of entries.filter((x) => readyCheckOverdue(x, today, waitlistConfig(kennelsById.get(x.kennel_id))))) {
    const rc = readyCheck(e, today, waitlistConfig(kennelsById.get(e.kennel_id)));
    out.push({
      key: `waitlist-ready-overdue:${e.id}:${rc.asked}`,
      title: `${name(e)} hasn't answered "Ready now?"`,
      detail: `Asked ${rc.asked}, when the readiness hold from their application ended. They stay paused until they answer (your setting). Contact them, or record their answer if they've told you.`,
      subjectHref: `waitlist-entry.html?id=${encodeURIComponent(e.id)}`,
      actions: [{ label: 'They\'re ready', run: async () => { await recordReadyAnswer(e.id, { answer: 'yes', date: today, by: 'breeder' }); } }]
    });
  }

  // Deposits were planned to open today (Spec §16.8): suggest Open picks, which
  // starts the next turn (§16.1). Only for a kennel with families on its list.
  const listed = new Set(entries.filter((e) => e.status === 'active').map((e) => e.kennel_id));
  for (const l of depositsDueLitters(inScopeOnly(litters).filter((x) => listed.has(x.kennel_id)), dogs, sales, today)) {
    const label = litterLabel(l, dogsById);
    out.push({
      key: `waitlist-open-picks:${l.id}:${l.accept_deposits_date}`,
      title: `${label}: you planned to start taking deposits ${l.accept_deposits_date === today ? 'today' : `on ${l.accept_deposits_date}`}. Open picks?`,
      detail: 'Opening picks offers the next family on your list a turn (or adds this litter to the turn open now). Nothing opens by itself.',
      subjectHref: `litter.html?id=${encodeURIComponent(l.id)}`,
      actions: [{
        label: 'Open picks',
        run: async () => {
          const turn = await openPicks(l.id, { date: today });
          if (!turn) return { title: 'Picks are open', message: 'Nobody can be offered this litter right now: another family holds the turn and isn\'t first in line for it, or nobody on the list matches its pups yet. The Litter page shows who\'s next.' };
          const fresh = (await waitlistEntryRepo.getAll({ includeArchived: true })).find((x) => x.id === turn.entry_id);
          const who = fresh ? name(fresh) : 'The next family';
          const emails = offerSpecs({ next: turn });
          return turn.joined
            ? { title: 'Added to their turn', message: `${who} is first in line for ${label} too, so it joined their turn. Their deadline restarted: until ${turn.respond_by_date}. Let them know.`, emails }
            : { title: 'Turn offered', message: `It's ${who}'s turn. They have until ${turn.respond_by_date} to pick a pup and send the deposit, or pass. Let them know.`, emails };
        }
      }]
    });
  }
  out.push(...(await statusPageNudges(entries, offers, { today, litters, dogsById, kennelsById, name })));
  return out;
}

// What families asked for or said on their status page (W2 step 5). A request
// waits on the entry until she decides, so dismissing the nudge never loses it
// (the family's page has the same buttons). Keys carry the request's date or the
// newest line's id, so a new one resurfaces after a dismiss.
async function statusPageNudges(entries, offers, { today, litters, dogsById, kennelsById, name }) {
  const out = [];
  const href = (e) => `waitlist-entry.html?id=${encodeURIComponent(e.id)}`;
  const dogName = (id) => dogsById.get(id)?.call_name || 'a dog';
  const litterName = (l) => litterLabel(l, dogsById);
  const said = (note) => (note ? ` They said: "${note}"` : '');
  // Each decision also offers the family an email saying so (W2 step 6).
  const decide = (approve, decline, done, e, field) => {
    const emails = (kind) => [{ entryId: e.id, kind, extra: { request: { field, request: e[field] } } }];
    return [
      { label: 'Approve', run: async () => { await approve(); return { title: 'Approved', message: done, emails: emails('request_approved') }; } },
      { label: 'Decline', run: async () => { await decline(); return { title: 'Declined', message: 'Nothing changed for them. Let them know.', emails: emails('request_declined') }; } }
    ];
  };
  let sales = null;
  const programs = new Map();
  for (const e of entries) {
    const open = offers.filter((o) => o.entry_id === e.id && o.outcome === 'open' && !o.is_archived);
    const openNote = open.length
      ? ` Their open offer on ${open.map((o) => (litters.find((l) => l.id === o.litter_id) ? litterName(litters.find((l) => l.id === o.litter_id)) : 'a litter')).join(', ')} stays open either way.`
      : '';
    if (hasPendingRequest(e, 'pause_request')) {
      const r = e.pause_request;
      out.push({
        key: `waitlist-pause-request:${e.id}:${r.requested_date}:${r.until}`,
        title: `${name(e)} asked to pause their place until ${r.until}`,
        detail: `They keep their place and aren't offered pups until then; a pause never counts as a pass.${openNote}${said(r.note)}`,
        subjectHref: href(e),
        actions: decide(() => approvePauseRequest(e.id, { date: today }), () => declinePauseRequest(e.id, { date: today }),
          `${name(e)} is paused until ${r.until}. Let them know.`, e, 'pause_request')
      });
    }
    if (hasPendingRequest(e, 'pref_change_request')) {
      const r = e.pref_change_request;
      const kennel = kennelsById.get(e.kennel_id);
      const config = waitlistConfig(kennel);
      sales ??= await saleRepo.getAll({ includeArchived: true });
      if (!programs.has(e.kennel_id)) programs.set(e.kennel_id, await waitlistProgramRepo.getMapForKennel(e.kennel_id));
      const live = litters.filter((l) => l.kennel_id === e.kennel_id && !l.is_archived && ['expected', 'whelped', 'weaning', 'ready'].includes(l.status));
      const fx = prefChangeEffect(e, r.changes || {}, {
        litters: live, entries: entries.filter((x) => x.kennel_id === e.kennel_id), offers, pups: [...dogsById.values()], sales, today, config, programsById: programs.get(e.kennel_id)
      });
      const history = (e.pref_change_log || []).filter((l) => !l.declined);
      const lines = [
        fx.narrowed.length
          ? `Narrower (${fx.narrowed.map((f) => PREF_FIELD_LABEL[f]).join(', ')})${fx.skippedLitters.length ? `: they'd stop being next for ${fx.skippedLitters.map(litterName).join(', ')}` : ''}.`
          : 'Not narrower: it doesn\'t rule out a pup they could be offered now.',
        openNote.trim(),
        history.length ? `${history.length} change${history.length === 1 ? '' : 's'} to these answers since joining; the last on ${history[history.length - 1].date}.` : '',
        said(r.note).trim()
      ].filter(Boolean);
      out.push({
        key: `waitlist-pref-request:${e.id}:${r.requested_date}`,
        title: `${name(e)} asked to change ${prefChangeSummary(e, r.changes) || 'their answers'}`,
        detail: lines.join(' '),
        subjectHref: href(e),
        actions: decide(() => approvePrefChange(e.id, { date: today }), () => declinePrefChange(e.id, { date: today }),
          `${name(e)}'s answers are updated, and the change is in their answer history. Let them know.`, e, 'pref_change_request')
      });
    }
    if (hasPendingRequest(e, 'listen_change_request')) {
      const r = e.listen_change_request;
      const parents = [...(r.listen_sire_ids || []), ...(r.listen_dam_ids || [])].map(dogName).join(', ');
      out.push({
        key: `waitlist-listen-request:${e.id}:${r.requested_date}`,
        title: r.listen_mode === 'selected' ? `${name(e)} asked to wait only for litters from ${parents || 'no parents'}`
          : r.listen_mode === 'except' ? `${name(e)} asked to skip litters from ${parents || 'no parents'}`
            : `${name(e)} asked to change which litters they wait for`,
        detail: `Narrower, so it needs you: they wouldn't be offered ${r.listen_mode === 'except' ? 'those' : 'other'} litters, and nothing is counted as a pass for those.${openNote}`,
        subjectHref: href(e),
        actions: decide(() => approveListenChange(e.id, { date: today }), () => declineListenChange(e.id, { date: today }),
          `${name(e)} now ${r.listen_mode === 'except' ? 'skips' : 'waits only for'} those litters. Let them know.`, e, 'listen_change_request')
      });
    }
    if (hasPendingRequest(e, 'companion_request')) {
      const r = e.companion_request;
      out.push({
        key: `waitlist-companion-request:${e.id}:${r.requested_date}`,
        title: `${name(e)} asked for their Companion link`,
        detail: `Send it from the Companion page (Current families), then mark it sent so their status page says so.${said(r.note)}`,
        subjectHref: href(e),
        actions: [
          { label: 'Open Companion', run: async () => { location.href = 'companion.html?type=family'; } },
          { label: 'Mark sent', run: async () => { await markCompanionLinkSent(e.id, { date: today }); return { title: 'Marked sent', message: `${name(e)}'s status page now says their link was sent.` }; } },
          { label: 'Decline', run: async () => { await declineCompanionRequest(e.id, { date: today }); return { title: 'Declined', message: 'Their status page says you didn\'t send one. Let them know why.' }; } }
        ]
      });
    }
    const unread = (e.messages || []).filter((m) => !m.read);
    if (unread.length) {
      const newest = unread[unread.length - 1];
      const msgs = unread.filter((m) => m.kind === 'message').length;
      const clip = (t) => (t.length > 200 ? `${t.slice(0, 200)}…` : t);
      out.push({
        key: `waitlist-messages:${e.id}:${newest.id}`,
        title: msgs ? `${msgs === 1 ? 'A message' : `${msgs} messages`} from ${name(e)}` : `${name(e)} did something on their status page`,
        detail: unread.slice(-3).map((m) => clip(m.body)).join(' · '),
        subjectHref: href(e),
        actions: [
          { label: 'Open', run: async () => { location.href = href(e); } },
          { label: 'Mark read', run: async () => { await markMessagesRead(e.id); } }
        ]
      });
    }
  }
  return out;
}
