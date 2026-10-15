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
// Fourteen rules (End-State guide §19), each producing zero or more nudges:
// stud-service status (§4.2), promote-lifecycle (§4.3), heat→pairing (§4.5),
// stud→pairing (§4.7), due-soon and overdue pairing rules, four linked-status rules
// (litter whelped → pairing, pairing ended → expected litter, pairing whelped →
// no litter, a Deceased dog's open sales and pairings), three litter-lifecycle
// rules (litter→sold / reopen / close) grouped over each litter's roster below,
// and the Pro-only show-track-complete → "log the title?" rule (Show Tracking
// Spec §5.4, gated on editionFlags.shows). Plus the Pro-only waitlist rules
// (Waitlist Spec §6.5, gated on editionFlags.waitlist): new applications, an
// offer past its deadline, a fee past its pay-by date, and the 7-day undo on a
// second-pass removal — each a one-tap suggestion, never an automatic write;
// and, from W2 step 5, what families asked for or said on their status page (a
// pause, a listen-only narrowing, an answer change: Approve / Decline; messages
// and activity: Mark read). And (Pro) what a connected vendor reported that her
// device didn't apply by itself (Integrations plan §0): Done.
//   { key, title, detail, subjectHref, actions: [{ label, run: async () => {}, confirm?, ask? }] }
// An action with `confirm: true` must be confirmed first — the renderer shows
// `ask` (confirmModal options) and runs it only on yes (Lite's permanent departure).
// `run` may resolve to { title, message }, which Today shows once it's done.
import { studServiceRepo } from './studServiceRepo.js';
import { dogRepo } from './dogRepo.js';
import { kennelRepo } from './kennelRepo.js';
import { pairingRepo } from './pairingRepo.js';
import { litterSoldDue, litterReopenDue, litterCloseDue } from './litterCheckin.js';
import { goHomeIssue, GO_HOME_SALE_STATUSES, defaultStart, boardingEnd, boardingChargeText, PICKUP_TITLE, BOARDING_TITLE } from './goHome.js';
import { litterRepo } from './litterRepo.js';
import { saleRepo } from './saleRepo.js';
import { eventRepo } from './eventRepo.js';
import { dogsInScope, inScopeOnly, subjectInScope } from './kennelScope.js';
import { todayYMD, monthsBetween, addDaysToYMD } from './dateUtils.js';
import { descriptor, PAIRING_STATUS, LITTER_STATUS, SALE_STATUS, isOpenSale, PAIRING_ENDED_STATUSES, WHELPED_OR_LATER } from './vocab.js';
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
import { contractRepo } from './contractRepo.js';
import { ourStudPairingIds, studParents, pickDue, serviceDate, boardingEndedUpdate } from './studRules.js';
import { reviewTitle } from './integrationEvents.js';

const TERMINAL_PAIRING_STATUSES = ['cancelled', 'failed'];

// Pre-whelp: still expecting a litter, not yet resolved one way or the other.
const PRE_WHELP_STATUSES = ['planned', 'bred', 'confirmed_pregnant'];

// How many days before a pairing's expected due date the "due soon — create the
// litter?" nudge starts.
const DUE_SOON_DAYS = 3;

// How far back the "pairing whelped, no litter" rule looks (see that rule).
const LITTER_RECORD_WINDOW_DAYS = 180;

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

// A puppy that died is archived, so it leaves the Dogs list but stays on its
// litter's roster with its history (archive is a soft delete). Pro archives it
// outright; Lite has no free Archive, only the permanent "remove from program"
// departure (cap spec §5), so there the action carries `confirm: true` and the
// caller asks `ask` first. `ask` is also the question for a caller that offers it
// on its own (salePrompts, when a sale ends because the pup died).
export function deceasedArchiveAction(dog) {
  const name = dog.call_name || dog.registered_name || 'this dog';
  const run = async () => { await dogRepo.archive(dog.id); };
  if (editionFlags.manualDogArchive) {
    return {
      label: 'Archive', run,
      ask: {
        title: `Archive ${name} too?`,
        message: `${name} leaves your Dogs list but stays on the litter, with all its history.`,
        confirmLabel: 'Archive', cancelLabel: 'Keep on list'
      }
    };
  }
  return {
    label: 'Remove from program', run, confirm: true,
    ask: {
      title: `Remove “${name}” from your program?`,
      message: `This can't be undone here — ${name} leaves your roster and you won't be able to edit it or bring it back. It stays in your dogs' pedigrees for lineage.`,
      confirmLabel: 'Remove permanently', cancelLabel: 'Keep on roster', danger: true
    }
  };
}

// Today offers the archive for a dog that died young (before its first
// birthday, by date of birth, else its litter's whelp date) in the last
// DECEASED_ARCHIVE_WINDOW_DAYS — a pup, not a breeding dog that died (those stay
// listed under Not breeding → Deceased unless she archives them herself), and
// not every pup that died years ago.
const DECEASED_ARCHIVE_WINDOW_DAYS = 90;
const PUPPY_MAX_MONTHS = 12;
function diedAsPuppyRecently(d, littersById, today) {
  const died = d.date_of_death || d.status_date;
  if (!died || died < addDaysToYMD(today, -DECEASED_ARCHIVE_WINDOW_DAYS)) return false;
  const born = d.date_of_birth || littersById?.get(d.litter_id)?.whelp_date;
  return !!born && born <= died && monthsBetween(born, died) < PUPPY_MAX_MONTHS;
}

// What a Deceased dog leaves open: its open sales (End the sale on the sale's own
// page, which settles the family — a waitlist family gets offered back into line)
// and its unfinished pairings — as the dam, any still expecting a litter (Planned
// → Cancel, Bred / Confirmed pregnant → Failed); as the sire, a Planned one only
// (a bred pairing stands without him), and never a frozen-semen AI. Shared by
// computeNudges (the Today backstop) and the dog page's prompt when she marks a
// dog Deceased, so the two always list the same things.
//
// Last, for a puppy, archiving it (deceasedArchiveAction): on Today when it died
// young and recently (diedAsPuppyRecently); on the dog page whenever she has just
// moved it from Puppy to Deceased (`wasPuppy`).
export function deceasedDogNudges(dogs, { pairings, sales, dogsById, littersById = null, wasPuppy = false, today = todayYMD() }) {
  const out = [];
  for (const d of dogs) {
    // An archived one still counts for its sales and pairings: archiving a pup
    // that died doesn't end its sale.
    if (d.status !== 'deceased') continue;
    const name = d.call_name || d.registered_name || 'This dog';
    for (const s of sales) {
      if (s.dog_id !== d.id || s.is_archived || !isOpenSale(s)) continue;
      out.push({
        key: `deceased-sale:${s.id}`,
        title: `${name} is marked Deceased but still has an open sale — end it?`,
        detail: `The sale is "${descriptor(SALE_STATUS, s.status).label}".`,
        subjectHref: `sale.html?id=${encodeURIComponent(s.id)}`,
        actions: [
          { label: 'Open the sale', run: async () => { location.href = `sale.html?id=${encodeURIComponent(s.id)}`; } }
        ]
      });
    }
    for (const p of pairings) {
      if (p.is_archived || !PRE_WHELP_STATUSES.includes(p.status)) continue;
      const asDam = p.dam_id === d.id;
      const asSire = p.sire_id === d.id && p.status === 'planned' && p.method !== 'ai_frozen';
      if (!asDam && !asSire) continue;
      const next = p.status === 'planned' ? 'cancelled' : 'failed';
      out.push({
        key: `deceased-pairing:${p.id}:${d.id}`,
        title: `${name} is marked Deceased — ${next === 'cancelled' ? 'cancel' : 'close out'} ${pairingLabel(p, dogsById)}?`,
        detail: `The pairing is still "${descriptor(PAIRING_STATUS, p.status).label}".`,
        subjectHref: `pairing.html?id=${encodeURIComponent(p.id)}`,
        actions: [
          { label: next === 'cancelled' ? 'Cancel pairing' : 'Mark failed', run: async () => { await pairingRepo.update(p.id, { status: next }); } }
        ]
      });
    }
    if (!d.is_archived && (wasPuppy || diedAsPuppyRecently(d, littersById, today))) {
      const action = deceasedArchiveAction(d);
      out.push({
        key: `deceased-archive:${d.id}`,
        title: editionFlags.manualDogArchive
          ? `${name} is marked Deceased — archive ${name}?`
          : `${name} is marked Deceased — remove ${name} from your program?`,
        detail: editionFlags.manualDogArchive
          ? 'Takes the record off your Dogs list. It stays on the litter, with its history.'
          : 'Takes the record off your roster. It stays in your dogs\' pedigrees.',
        subjectHref: `dog.html?id=${encodeURIComponent(d.id)}`,
        actions: [action]
      });
    }
  }
  return out;
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
  // Breedings of our stud to somebody else's dam (linked to an outgoing stud
  // service): the litter is the dam's owner's, so no rule asks her to record it.
  const outgoingPairings = ourStudPairingIds(studServices, dogsById);

  const nudges = [];

  // A stud service's trip boarded and the boarding has ended, but the service
  // doesn't say so yet (studRules.boardingEndedUpdate): offer to bring its dates
  // and status in line. It stands in for the status nudge below on that service.
  const boardingUpdated = new Set();
  for (const s of scopedStudServices) {
    const u = boardingEndedUpdate(s, events, today);
    if (!u) continue;
    boardingUpdated.add(s.id);
    const who = dogsById.get(u.boarding.subject_id)?.call_name || 'The dog';
    const said = [
      u.changes.returned_date || u.changes.sent_date ? `dates ${u.boarding.event_date} to ${u.boarding.event_end_date}` : '',
      u.changes.status ? 'mark it completed' : ''
    ].filter(Boolean).join(', ');
    nudges.push({
      key: `studboard:${s.id}:${u.boarding.event_end_date}`,
      title: `${who}'s stud-service stay ended ${u.boarding.event_end_date} — update the stud service?`,
      detail: `${studPartnerLabel(s, dogsById)}: ${said}.`,
      subjectHref: `stud-service.html?id=${encodeURIComponent(s.id)}`,
      actions: [
        { label: 'Update it', run: async () => { await studServiceRepo.update(s.id, u.changes); } }
      ]
    });
  }

  // §4.2 — stud-service status nudges.
  for (const s of scopedStudServices) {
    if (boardingUpdated.has(s.id)) continue;
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
    const damId = studParents(s, dogsById)?.damId;
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

  // Due soon — a bred or confirmed-pregnant pairing whose expected due date is
  // today or within DUE_SOON_DAYS, with no litter yet: suggest creating the
  // litter now (it starts as "Expected"), so it's ready when the pups arrive.
  // Not for a pairing still "Planned" — nothing says the breeding happened. Its
  // own key, so dismissing it early doesn't hide the overdue nudge below.
  for (const p of scopedPairings) {
    if (!['bred', 'confirmed_pregnant'].includes(p.status) || !p.expected_due_date) continue;
    if (outgoingPairings.has(p.id)) continue;
    if (p.expected_due_date < today || p.expected_due_date > addDaysToYMD(today, DUE_SOON_DAYS)) continue;
    if (pairingIdsWithLitter.has(p.id)) continue;
    const days = daysBetween(today, p.expected_due_date);
    nudges.push({
      key: `pairingduesoon:${p.id}`,
      title: `${pairingLabel(p, dogsById)} is due ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`} — create the litter?`,
      detail: `Expected ${p.expected_due_date}. The litter starts as "Expected" until the pups arrive.`,
      subjectHref: `pairing.html?id=${encodeURIComponent(p.id)}`,
      actions: [
        { label: 'Create litter', run: async () => { location.href = `litter.html?new=1&pairing=${encodeURIComponent(p.id)}`; } }
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
    if (outgoingPairings.has(p.id)) continue;
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

  // Litter ↔ pairing status (the backstop for the prompts on the litter and
  // pairing pages, which only fire on an edit made there — not on an import, a
  // sync, another device, or a Skip). Three rules over the pairing ↔ litter link.
  const pairingsById = new Map(pairings.map((p) => [p.id, p]));
  const liveLittersByPairing = new Map();
  for (const l of litters) {
    if (!l.pairing_id || l.is_archived) continue;
    const arr = liveLittersByPairing.get(l.pairing_id);
    if (arr) arr.push(l); else liveLittersByPairing.set(l.pairing_id, [l]);
  }

  // A litter that's whelped (or later) whose linked pairing still says otherwise
  // → suggest marking the pairing whelped. Auto-dismisses once it is.
  for (const l of scopedLitters) {
    if (l.is_archived || !l.pairing_id || !WHELPED_OR_LATER.includes(l.status)) continue;
    const p = pairingsById.get(l.pairing_id);
    if (!p || p.status === 'whelped') continue;
    nudges.push({
      key: `litterpairing:${l.id}`,
      title: `${litterLabel(l, dogsById)} has whelped — mark its pairing whelped?`,
      detail: `The litter is "${descriptor(LITTER_STATUS, l.status).label}"; the pairing is still "${descriptor(PAIRING_STATUS, p.status).label}".`,
      subjectHref: `pairing.html?id=${encodeURIComponent(p.id)}`,
      actions: [
        { label: 'Mark pairing whelped', run: async () => { await pairingRepo.update(p.id, { status: 'whelped' }); } }
      ]
    });
  }

  for (const p of scopedPairings) {
    // A pairing that didn't take, with its litter still "Expected" → suggest
    // archiving the litter (it never happened; archive, not delete, so nothing
    // that points at it breaks).
    if (PAIRING_ENDED_STATUSES.includes(p.status)) {
      for (const l of liveLittersByPairing.get(p.id) || []) {
        if (l.status !== 'expected') continue;
        nudges.push({
          key: `pairingended:${l.id}`,
          title: `${pairingLabel(p, dogsById)} is "${descriptor(PAIRING_STATUS, p.status).label}" — archive its expected litter?`,
          detail: 'The litter is still marked Expected.',
          subjectHref: `litter.html?id=${encodeURIComponent(l.id)}`,
          actions: [
            { label: 'Archive litter', run: async () => { await litterRepo.archive(l.id); } }
          ]
        });
      }
    }

    // A pairing marked whelped with no litter recorded against it (archived ones
    // count — the litter exists) → suggest recording it. Skipped for an external
    // dam (our stud's outside breeding: her litter is usually not ours to record),
    // and for a pairing whose dates are more than LITTER_RECORD_WINDOW_DAYS old, so
    // historical pairings entered without their litters don't flood Today.
    if (p.status === 'whelped' && !pairingIdsWithLitter.has(p.id) && !outgoingPairings.has(p.id)) {
      const dam = dogsById.get(p.dam_id);
      if (dam && (dam.ownership_type === 'external' || dam.status === 'external_reference')) continue;
      const refDate = p.expected_due_date || p.last_observed_date || p.planned_date || (p.created_at || '').slice(0, 10);
      if (refDate && refDate < addDaysToYMD(today, -LITTER_RECORD_WINDOW_DAYS)) continue;
      nudges.push({
        key: `pairingnolitter:${p.id}`,
        title: `${pairingLabel(p, dogsById)} whelped — record the litter?`,
        detail: 'The pairing is marked Whelped but has no litter yet.',
        subjectHref: `pairing.html?id=${encodeURIComponent(p.id)}`,
        actions: [
          { label: 'Create litter', run: async () => { location.href = `litter.html?new=1&pairing=${encodeURIComponent(p.id)}`; } }
        ]
      });
    }
  }

  // A dog marked Deceased that's still on an open sale or an unfinished pairing
  // (the backstop for the prompt on the dog page).
  // Archived ones too (an archived pup can still have an open sale), so this one
  // rule reads the dogs again with them.
  const allDogs = await dogRepo.getAll({ includeArchived: true });

  // An outgoing stud service paid with a pick of the litter: once the pick should
  // be ready (63 + 56 days after the service, studRules.pickDue), ask whether it's
  // ready to add to her dogs. Done when a puppy of that stud out of that dam is on
  // file (archived ones count) or the pick is marked claimed.
  for (const s of scopedStudServices) {
    if (!pickDue(s, allDogs, today)) continue;
    nudges.push({
      key: `studpick:${s.id}`,
      title: `Ready to add your pick puppy from ${studPartnerLabel(s, dogsById)}?`,
      detail: `The litter should be ready to go home about now (bred ${serviceDate(s)}).`,
      subjectHref: `stud-service.html?id=${encodeURIComponent(s.id)}`,
      actions: [
        { label: 'Add the puppy', run: async () => { location.href = `dog.html?new=1&pick=${encodeURIComponent(s.id)}`; } },
        { label: 'Not getting one', run: async () => { await studServiceRepo.update(s.id, { pick_status: 'waived' }); } }
      ]
    });
  }

  nudges.push(...deceasedDogNudges(dogsInScope(allDogs.filter((d) => d.status === 'deceased')), {
    pairings, sales, dogsById: new Map(allDogs.map((d) => [d.id, d])), littersById: new Map(litters.map((l) => [l.id, l])), today
  }));

  // Litter-lifecycle nudges (the rules live in data/litterCheckin.js, shared
  // with Kels's litter check-in) — all three are aggregate facts over a litter's
  // puppy roster (and, for the close rule, its sales), so they're grouped once
  // here from data already loaded above rather than re-scanned per record on
  // every pup/sale save. Non-archived, non-empty rosters only.
  const pupsByLitter = new Map();
  for (const d of dogs) {
    if (!d.litter_id) continue;
    const arr = pupsByLitter.get(d.litter_id);
    if (arr) arr.push(d); else pupsByLitter.set(d.litter_id, [d]);
  }
  // The close rule reads the sales of EVERY pup of the litter, archived ones
  // included: in Lite a delivered pup departs (is archived), but its sale counts.
  const litterOfDog = new Map(allDogs.filter((d) => d.litter_id).map((d) => [d.id, d.litter_id]));
  const salesByLitter = new Map();
  for (const s of sales) {
    const litterId = litterOfDog.get(s.dog_id);
    if (!litterId) continue;
    const arr = salesByLitter.get(litterId);
    if (arr) arr.push(s); else salesByLitter.set(litterId, [s]);
  }

  for (const l of scopedLitters) {
    if (l.is_archived) continue;
    // A pup marked Deceased is out of the picture. dogRepo nulls its disposition
    // (puppy-only), and a null disposition would otherwise hold up "mark sold" for
    // its litter forever. Filtering on status rather than disposition also covers
    // a row restored or synced from before that rule.
    const pups = (pupsByLitter.get(l.id) || []).filter((p) => p.status !== 'deceased');
    const litterSales = salesByLitter.get(l.id) || [];
    const label = litterLabel(l, dogsById);
    const href = `litter.html?id=${encodeURIComponent(l.id)}`;

    // Done: no pup Available or Undecided, no sale still open, one went home on a
    // delivered sale → suggest closing, whatever status it was left at. Checked
    // before the empty-roster skip: a Lite litter whose pups all departed has none.
    if (litterCloseDue(l, pups, litterSales)) {
      nudges.push({
        key: `litterclose:${l.id}`,
        title: `${label} — every puppy has gone home or is staying. Close the litter?`,
        detail: 'No puppy is available or undecided, and every sale is finished.',
        subjectHref: href,
        actions: [
          { label: 'Close litter', run: async () => { await litterRepo.update(l.id, { status: 'closed' }); } }
        ]
      });
      continue;
    }
    if (pups.length === 0) continue;

    // Every pup resolved to placed/keeping (or on a health hold — not for sale),
    // with at least one actually placed (an all-keeping litter never "sold"
    // anything) → suggest marking it sold.
    if (litterSoldDue(l, pups, litterSales)) {
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
    if (litterReopenDue(l, pups)) {
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

  }

  // A sold puppy's way home (data/goHome.js, decided 2026-10-15): from a week
  // before the ready date, a sale in progress with no pickup or boarding on the
  // calendar → schedule the pickup; a pickup date that passed with the sale not
  // Delivered → did they go home? (opens the Sale page set to Delivered, so its
  // delivery prompts run); a boarding charge on the sale with no boarding logged
  // → log it. The actions open the puppy's event form prefilled, or the sale.
  {
    const openSales = inScopeOnly(sales).filter((x) => GO_HOME_SALE_STATUSES.includes(x.status));
    if (openSales.length) {
      const littersById = new Map(litters.map((l) => [l.id, l]));
      const contactsById = new Map((await contactRepo.getAll({ includeArchived: true })).map((c) => [c.id, c]));
      const eventsByDog = new Map();
      for (const e of events) {
        if (e.subject_type !== 'dog' || (e.event_type !== 'placement' && e.event_type !== 'boarding')) continue;
        if (!eventsByDog.has(e.subject_id)) eventsByDog.set(e.subject_id, []);
        eventsByDog.get(e.subject_id).push(e);
      }
      const done = new Set();
      for (const sale of openSales) {
        const pup = dogsById.get(sale.dog_id);
        if (!pup || done.has(pup.id)) continue;
        done.add(pup.id);
        const issue = goHomeIssue({
          pup, litter: littersById.get(pup.litter_id), today,
          sales: sales.filter((x) => x.dog_id === pup.id), events: eventsByDog.get(pup.id) || []
        });
        if (!issue) continue;
        const s2 = issue.sale;
        const name = pup.call_name || pup.registered_name || 'This puppy';
        const family = contactsById.get(s2.buyer_contact_id)?.name || 'their family';
        const dogHref = (q) => `dog.html?id=${encodeURIComponent(pup.id)}&${new URLSearchParams(q).toString()}`;
        const start = defaultStart(issue.readyDate, today);
        const logPickup = (label) => ({ label, run: async () => { location.href = dogHref({ logEvent: 'placement', logDate: start, logTitle: PICKUP_TITLE, ...(s2.buyer_contact_id ? { logContact: s2.buyer_contact_id } : {}) }); } });
        if (issue.kind === 'boarding') {
          const end = boardingEnd(s2, start);
          nudges.push({
            key: `gohome-boarding:${s2.id}`,
            title: `${name}'s sale includes boarding (${boardingChargeText(s2)}). Log the boarding?`,
            detail: `${family} is paying for ${name} to stay with you after the ready date (${issue.readyDate}), but no boarding is logged.`,
            subjectHref: `sale.html?id=${encodeURIComponent(s2.id)}`,
            actions: [{ label: 'Log boarding', run: async () => { location.href = dogHref({ logEvent: 'boarding', logDate: start, logTitle: BOARDING_TITLE, ...(end ? { logEnd: end } : {}), logDetails: JSON.stringify({ boarding_reason: 'Deferred pickup' }) }); } }]
          });
        } else if (issue.kind === 'schedule') {
          nudges.push({
            key: `gohome-schedule:${s2.id}`,
            title: `${name} is going home to ${family}. Schedule the pickup?`,
            detail: `The litter is ready ${issue.readyDate}, and there's no pickup or boarding on the calendar.`,
            subjectHref: `sale.html?id=${encodeURIComponent(s2.id)}`,
            actions: [logPickup('Schedule pickup')]
          });
        } else {
          nudges.push({
            key: `gohome-overdue:${s2.id}:${issue.pickupDate}`,
            title: `${name}'s pickup was ${issue.pickupDate}. Did ${name} go home?`,
            detail: `The sale to ${family} still isn't marked Delivered.`,
            subjectHref: `sale.html?id=${encodeURIComponent(s2.id)}`,
            actions: [
              { label: 'Yes, mark delivered', run: async () => { location.href = `sale.html?id=${encodeURIComponent(s2.id)}&deliver=1`; } },
              logPickup('No, new pickup date')
            ]
          });
        }
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
  if (editionFlags.accounts) nudges.push(...(await integrationReviewNudges(inScopeOnly(sales))));

  return nudges;
}

// --- Follow-up a week after going home (Integrations plan §3) ----------------------
// Pro (with Accounts, whose shared referral links the note carries). A delivered
// sale whose pup went home (its latest placement event, else the balance-paid
// date) FOLLOW_UP_DAYS to FOLLOW_UP_WINDOW_DAYS ago suggests a note to the buyer:
// a how-is-it-going and thank-you, with the products she shares with families.
// The note opens in the composer (Today reads `compose`); she sends it herself.
// Key per sale, so Dismiss (or sending it) retires it for good.
// What a connected vendor reported that her device didn't apply by itself
// (Integrations plan §0; data/integrationEvents.js): one nudge per review, on the
// sale or contract it's about. "Done" removes it from the record.
async function integrationReviewNudges(sales) {
  const contracts = inScopeOnly(await contractRepo.getAll());
  const out = [];
  const add = (record, repo, href, label) => {
    for (const r of Array.isArray(record.integration_reviews) ? record.integration_reviews : []) {
      if (!r || !r.id) continue;
      out.push({
        key: `int-review:${record.id}:${r.id}`,
        title: `${reviewTitle(r)}: ${label}`,
        detail: `${r.reason}${r.payload?.date ? ` (${r.payload.date})` : ''} Check it, then tap Done.`,
        subjectHref: href,
        actions: [{
          label: 'Done',
          run: async () => {
            const fresh = await repo.getById(record.id);
            await repo.update(record.id, { integration_reviews: (fresh?.integration_reviews || []).filter((x) => x && x.id !== r.id) });
          }
        }]
      });
    }
  };
  for (const s of sales) add(s, saleRepo, `sale.html?id=${encodeURIComponent(s.id)}`, 'a sale');
  for (const c of contracts) add(c, contractRepo, `contract.html?id=${encodeURIComponent(c.id)}`, c.title || 'a contract');
  return out;
}

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
