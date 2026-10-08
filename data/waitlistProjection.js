// waitlistProjection.js — what one kennel's waitlist looks like online (Waitlist
// W2 Plan §5). PURE: plain records in, one plain object out; no Dexie, no DOM, no
// clock (callers pass `today`). Pinned by tests/waitlistProjection.test.js.
//
// Her device is the single source of truth: every position, eligibility and
// offer here comes from waitlistRules.js, the same functions the app's own pages
// use, so the status page can never disagree with her app. The server only
// stores and displays this object.
//
// It is built FIELD BY FIELD from allow-lists, like companionExport.js's
// prospective bundle: a new field on an entry, a contact or a dog never reaches
// the server unless it's added here on purpose. What the server may read is
// Waitlist Spec §8.1 (Q11, decided 2026-10-08): a family's name and email, its
// place and offers, the fee amount and her payment instructions while it's
// unpaid, and whether (and when) the fee was received. Never: other answers,
// phone, address, programs, notes, payment details, prices she hasn't published.
//
// Later W2 steps add their parts (the form and FAQ in step 4, the listen-only
// choices, requests and message key in step 5, email templates in step 6) here,
// in the same allow-listed way. A family's own notes on a request and every
// message stay on her device: the page shows what was asked, never the note.
import {
  waitlistConfig, entryName, publicList, overallPositions, litterQueue, isPupAvailable, passesUsed,
  isManuallyPaused, readyFromDate, isReadyHeld, feeForEntry, kennelBreeds, listenParentChoices,
  rankedList, turnLittersFor, turnIdOf, passReasons, splitPrepassed
} from './waitlistRules.js';
import { addDaysToYMD } from './dateUtils.js';
import { WAITLIST_OPEN_STATUSES } from './vocab.js';
import { formQuestions, formFaq, matchingPrefKeys, MATCHING_NOTICE } from './waitlistForm.js';

export const PROJECTION_FORMAT = 1;

// The litter statuses the waitlist works with (as on the Waitlist and family pages).
export const LIVE_LITTER = ['expected', 'whelped', 'weaning', 'ready'];

const byId = (a, b) => String(a.id).localeCompare(String(b.id));
const orNull = (v) => (v === undefined || v === '' ? null : v);

// The family's address for the server's emails (Q11): the linked contact's, else
// the one they applied with.
export function entryEmail(entry, contact) {
  return orNull((contact && contact.email) || (entry.application && entry.application.email)) ?? null;
}

function litterLabel(litter, dogsById) {
  if (litter.nickname) return litter.nickname;
  const name = (id) => dogsById.get(id)?.call_name || 'Unknown';
  return `${name(litter.dam_id)} × ${name(litter.sire_id)}`;
}

// A request the family made on their status page (W2 step 5), as their page shows
// it: what they asked, when, and once she decided, what she decided. A decision
// shows for REQUEST_SHOWN_DAYS, then the request drops off the page. Never the
// family's note.
export const REQUEST_SHOWN_DAYS = 30;
function requestView(req, today, fields) {
  if (!req || !req.requested_date) return null;
  if (req.decided && (!req.decided_date || addDaysToYMD(req.decided_date, REQUEST_SHOWN_DAYS) < today)) return null;
  return { ...fields(req), requested_date: req.requested_date, decided: req.decided || null, decided_date: orNull(req.decided_date) };
}

function requestsView(entry, today) {
  return {
    pause: requestView(entry.pause_request, today, (r) => ({ until: r.until })),
    pref_change: requestView(entry.pref_change_request, today, (r) => ({ changes: { ...(r.changes || {}) } })),
    listen: requestView(entry.listen_change_request, today, (r) => ({
      mode: r.listen_mode || 'all', sire_ids: [...(r.listen_sire_ids || [])], dam_ids: [...(r.listen_dam_ids || [])]
    }))
  };
}

// A pup as a family may see it: call name, sex, color. Nothing else.
const publicPup = (d) => ({ id: d.id, call_name: d.call_name || '', sex: orNull(d.sex), color: orNull(d.color_markings) });

// One family's status page (Plan §5). A family still in the pipeline gets the
// detail; one whose time on the list ended (placed, declined, withdrawn, removed,
// expired) gets only its outcome, so an old link still says what happened.
function entryView(entry, ctx) {
  const contact = ctx.contactsById.get(entry.contact_id) || null;
  const view = { name: entryName(entry, contact), email: entryEmail(entry, contact), status: entry.status };
  if (entry.status_token) view.status_token = entry.status_token;
  if (!WAITLIST_OPEN_STATUSES.includes(entry.status)) return view;

  const program = ctx.programsById.get(entry.waitlist_program_id) || null;
  const fee = feeForEntry(ctx.config, program);
  Object.assign(view, {
    applied_date: orNull(entry.applied_date),
    approved_date: orNull(entry.approved_date),
    position: ctx.positions.get(entry.id) ?? null,
    prefs: {
      sex: entry.pref_sex || 'any',
      breed: orNull(entry.pref_breed),
      placement: orNull(entry.pref_placement_type),
      colors: Array.isArray(entry.pref_colors) ? [...entry.pref_colors] : (orNull(entry.pref_colors) ? [entry.pref_colors] : []),
      ready_timing: orNull(entry.ready_timing)
    },
    paused_until: isManuallyPaused(entry, ctx.today) ? entry.paused_until : null,
    ready_from: isReadyHeld(entry, ctx.today) ? readyFromDate(entry) : null,
    listen: {
      mode: entry.listen_mode || 'all',
      sire_ids: [...(entry.listen_sire_ids || [])],
      dam_ids: [...(entry.listen_dam_ids || [])]
    },
    passes: { used: passesUsed(entry, ctx.offers), max: Number(ctx.config.max_passes) },
    requests: requestsView(entry, ctx.today),
    // "Not this litter" (§16.2): which, and when; never their reason.
    prepasses: (entry.prepasses || []).map((p) => ({
      ...(p.litter_id ? { litter_id: p.litter_id } : { pairing_id: p.pairing_id }), date: orNull(p.date)
    })),
    fee_received_date: orNull(entry.fee_received_date),
    // What to pay and how: only while approved and unpaid (Spec §5.3, §8.1).
    fee_due: entry.status === 'approved' && !entry.fee_received_date && fee !== null && fee > 0
      ? { amount: fee, due_date: orNull(entry.fee_due_date), instructions: ctx.config.payment_instructions || '', credit_policy: ctx.config.fee_credit_policy }
      : null,
    litter_positions: ctx.litterPositions.get(entry.id) || {},
    offers: ctx.offers
      .filter((o) => o.entry_id === entry.id && o.outcome === 'open' && !o.is_archived)
      .sort(byId)
      .map((o) => ({
        id: o.id,
        turn_id: turnIdOf(o),
        litter_id: o.litter_id,
        offered_date: orNull(o.offered_date),
        respond_by_date: orNull(o.respond_by_date),
        eligible_dog_ids: [...(o.eligible_dog_ids || [])],
        picked_dog_id: orNull(o.chosen_dog_id)
      }))
  });
  return view;
}

// Her application form as the online form page renders it (W2 Plan step 4): her
// questions in her order and wording, her FAQ and notices, her breeds, and the
// PUBLIC half of the current form key. Only while she takes applications online.
function formSection(kennel, config, formKey, dogs) {
  return {
    open: true,
    key_id: formKey.id,
    public_key: formKey.public_key,
    questions: formQuestions(config).map((q) => ({
      id: q.id, ...(q.key ? { key: q.key } : {}), label: q.label, type: q.type, required: Boolean(q.required),
      help: q.help || '', options: [...(q.options || [])]
    })),
    faq: formFaq(config).map((x) => ({ id: x.id, question: x.question, answer: x.answer })),
    breeds: kennelBreeds(kennel, dogs),
    matching_keys: matchingPrefKeys(config),
    matching_notice: MATCHING_NOTICE,
    color_matching: Boolean(config.color_matching)
  };
}

// The parent dogs the status page's listen-only editor offers (Spec §15.7): the
// same choices as her Edit form, plus every parent a family on this list already
// picked. A family sees a dog's call name only.
function parentsSection(kennel, live, { dogs, litters, pairings }) {
  const choices = listenParentChoices(kennel, {
    dogs, litters, pairings,
    selectedSires: live.flatMap((e) => e.listen_sire_ids || []),
    selectedDams: live.flatMap((e) => e.listen_dam_ids || [])
  });
  const named = (d) => ({ id: d.id, name: d.call_name || '' });
  return { sires: choices.sires.map(named), dams: choices.dams.map(named) };
}

// The projection for ONE own kennel. Callers pass that kennel's entries, offers
// and programs (a Map), and every litter, pairing, dog, sale and contact (each is
// filtered here). `today` is YYYY-MM-DD. `formKey` is her current form key (its
// PUBLIC half seals applications and family messages); `eventsThrough` the last
// family event her device has applied (the server lets go of picked pups' holds
// up to there, W2 step 5).
export function buildProjection({ kennel, entries = [], offers = [], programsById = new Map(), litters = [], pairings = [], dogs = [], sales = [], contacts = [], today, formKey = null, eventsThrough = 0 }) {
  if (!kennel || !kennel.public_id) throw new Error('This kennel has no public identity yet.');
  if (!today) throw new Error('buildProjection needs today.');
  const config = waitlistConfig(kennel);
  const contactsById = new Map(contacts.map((c) => [c.id, c]));
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const live = entries.filter((e) => !e.is_archived && e.kennel_id === kennel.id);
  const kennelOffers = offers.filter((o) => !o.is_archived && o.kennel_id === kennel.id);
  const opts = { today, config, programsById };

  // Each live litter's queue: every eligible family in order, however many (Q13).
  const litterPositions = new Map();
  const litterViews = {};
  for (const litter of litters.filter((l) => l.kennel_id === kennel.id && !l.is_archived && LIVE_LITTER.includes(l.status)).sort(byId)) {
    const pups = dogs.filter((d) => d.litter_id === litter.id);
    const queue = litterQueue(live, litter, pups, sales, opts);
    for (const q of queue) {
      if (!litterPositions.has(q.entry.id)) litterPositions.set(q.entry.id, {});
      litterPositions.get(q.entry.id)[litter.id] = q.litterPosition;
    }
    const open = kennelOffers.find((o) => o.litter_id === litter.id && o.outcome === 'open') || null;
    litterViews[litter.id] = {
      label: litterLabel(litter, dogsById),
      status: litter.status,
      whelp_date: orNull(litter.whelp_date),
      ready_date: orNull(litter.estimated_ready_date),
      picks_open: Boolean(litter.picks_opened_date),
      pups: pups.filter((d) => isPupAvailable(d, sales)).sort(byId).map(publicPup),
      open_offer_entry_id: open ? open.entry_id : null
    };
  }

  // Who gets the turns, in order (Spec §16.1): every family with an eligible pup
  // in a litter with open picks they haven't spent a turn on, however many (Q13),
  // each with those pups per litter. The list the server walks for automatic
  // offers (W2 step 7); her device decides every entry of it.
  const openLitters = litters.filter((l) => l.kennel_id === kennel.id && !l.is_archived && l.picks_opened_date);
  const turnQueue = [];
  for (const e of rankedList(live, kennel.id, programsById)) {
    const ls = turnLittersFor(e, kennelOffers, openLitters, dogs, sales, opts);
    if (!ls.length) continue;
    // Litters they said "Not this litter" to are listed apart: their turn leaves them
    // out, and a turn of nothing else is passed at once (§16.2).
    const { offer, prepassed } = splitPrepassed(e, ls);
    turnQueue.push({
      entry_id: e.id,
      litters: Object.fromEntries(offer.map((x) => [x.litter.id, x.eligibleDogs.map((d) => d.id).sort()])),
      prepassed: prepassed.map((x) => x.litter.id)
    });
  }

  const ctx = {
    config, contactsById, programsById, offers: kennelOffers, today,
    positions: overallPositions(live, kennel.id, programsById), litterPositions
  };
  const entryViews = {};
  for (const e of [...live].sort(byId)) entryViews[e.id] = entryView(e, ctx);

  return {
    format: PROJECTION_FORMAT,
    as_of: today,
    kennel: {
      public_id: kennel.public_id,
      name: kennel.kennel_name || '',
      time_zone: orNull(kennel.time_zone),
      respond_days: Number(config.respond_days),
      max_passes: Number(config.max_passes),
      auto_offer_on: [...config.auto_offer_on],
      breeds: kennelBreeds(kennel, dogs),
      // Her pass reasons and the message each shows the family (§16.5).
      pass_reasons: passReasons(config),
      color_matching: Boolean(config.color_matching),
      parents: parentsSection(kennel, live, { dogs, litters, pairings }),
      ...(formKey ? { message_key: { key_id: formKey.id, public_key: formKey.public_key } } : {}),
      ...(config.online_form && formKey ? { form: formSection(kennel, config, formKey, dogs) } : {})
    },
    public_list: publicList(live, kennel.id, programsById, {
      today, nameOf: (e) => entryName(e, contactsById.get(e.contact_id))
    }),
    entries: entryViews,
    litters: litterViews,
    turn_queue: turnQueue,
    events_through: Number.isInteger(eventsThrough) && eventsThrough > 0 ? eventsThrough : 0
  };
}
