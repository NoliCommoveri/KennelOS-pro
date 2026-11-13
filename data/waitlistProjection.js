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
import { expectedPricing } from './saleDefaults.js';
import {
  waitlistConfig, openDays, closedDates, liveClosedDates, entryName, publicList, publicWantsMore, overallPositions, litterQueue, isPupAvailable, passesUsed,
  isManuallyPaused, readyFromDate, isReadyHeld, feeForEntry, kennelBreeds, listenParentChoices,
  rankedList, turnLittersFor, turnIdOf, isSideSalePending, passReasons, splitPrepassed, upcomingItems, plannedHeats, showUpcoming, isListeningFor, placeHidden, prefPlaces, whelpNotes, readyCheck, publicIntroText,
  messengerLink, embedOrigins, publicSelected, publicSourceName, isPupReserved, isWaitlistLitter, isPicksOpen, isFamilyPageOnly, LISTEN_LIVE_LITTER
} from './waitlistRules.js';
import { addDaysToYMD } from './dateUtils.js';
import { completedTestsByDog } from './healthTestLog.js';
import { isWebsiteAddress } from './websiteAddress.js';
import { WAITLIST_OPEN_STATUSES, isOpenSale } from './vocab.js';
import { formQuestions, formFaq, matchingPrefKeys, MATCHING_NOTICE, waitlistPolicies } from './waitlistForm.js';
import { serverEmailTemplates } from './waitlistEmails.js';
import { sharedReferrals, sharedTransport } from './referralShare.js';
import { feePay, withClientRef } from './waitlistFeePay.js';
import { familySale, familyExtrasView, pupBirthDate, creditSale } from './familyExtras.js';
import { familyCredit, feeCreditSplit } from './incomeView.js';
import { creditsOf, allocateCredits, feeCharge } from './receivedCredits.js';
import { familyPickupView } from './familyPickup.js';
import { backOutReasons, backOutPolicyText } from './backOut.js';
import { standardLocation } from './pickupSlots.js';
import { EXTRAS_INTRO_DEFAULT, extrasInfoLink } from './waitlistRules.js';
import { portalEntryView, portalOn } from './portalFeed.js';
import { familyPaymentsView } from './paymentSchedule.js';

export const PROJECTION_FORMAT = 1;

// The litter statuses the waitlist works with: waitlistRules' one list (isWaitlistLitter).
export const LIVE_LITTER = LISTEN_LIVE_LITTER;

const byId = (a, b) => String(a.id).localeCompare(String(b.id));
const orNull = (v) => (v === undefined || v === '' ? null : v);

// The family's address for the server's emails (Q11): the linked contact's, else
// the one they applied with.
export function entryEmail(entry, contact) {
  return orNull((contact && contact.email) || (entry.application && entry.application.email)) ?? null;
}

function litterLabel(litter, dogsById) {
  if (litter.nickname) return litter.nickname;
  const name = (id) => dogsById.get(id)?.call_name || String(dogsById.get(id)?.registered_name ?? '').trim() || 'Unknown';
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

// Their Companion link (Companion family package): only for a family with an
// open sale (vocab.isOpenSale, the same rule as the Companion page), from a pick
// held by a deposit-pending sale until the pup goes home. `available` lets them
// ask for it; `request` is their last request as their page shows it ('sent' or
// 'declined' once she's dealt with it). The link itself never comes through here:
// she sends it from her device (Companion page), so the server never holds it.
// While her puppy portal is on (portalFeed.portalOn), the portal takes Companion's
// place: `link: false`, and their page offers no Companion link request.
function companionView(entry, ctx) {
  if (!ctx.saleFor(entry)) return null;
  if (ctx.portalOn) return { available: true, link: false, request: null };
  return { available: true, request: requestView(entry.companion_request, ctx.today, () => ({})) };
}

// A photos link as family pages may show it: a web address (http/https), at most
// PHOTO_LINK_MAX characters; else null. A dog's is its `url`, and only when she
// ticked Dog.photos_online for it; a litter's is Litter.photos_url (setting it is
// her choice to show it).
export const PHOTO_LINK_MAX = 500;
export function photoLink(v) {
  const s = String(v ?? '').trim();
  return s.length <= PHOTO_LINK_MAX && /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : null;
}
export const dogPhotosLink = (dog) => (dog && dog.photos_online ? photoLink(dog.url) : null);
const withPhotos = (url) => (url ? { photos_url: url } : {});

// A pup's link as family pages show it: its page on her KennelPort website when its
// `url` is one (Update website fills it; the page is public anyway, so no
// photos_online tick is needed: `page: true`), else its photos link where she
// shows it (dogPhotosLink).
function pupLink(d, kennel) {
  const page = isWebsiteAddress(d.url, [kennel]) ? photoLink(d.url) : null;
  if (page) return { photos_url: page, page: true };
  return withPhotos(dogPhotosLink(d));
}

// A litter's link as family pages show it: its page on her KennelPort website when
// its `photos_url` is one (Update website fills it, and a pup's page sits under it),
// else the photos link she set. `page: true` so a turn reads "View litter on our
// website" rather than "See the litter's photos".
function litterLink(litter, kennel) {
  const url = photoLink(litter.photos_url);
  if (!url) return {};
  return isWebsiteAddress(url, [kennel]) ? { photos_url: url, page: true } : { photos_url: url };
}

// A pup as a family may see it: call name, sex, color, the registration it's
// planned for (null: undecided, either), its registry ("AKC"; null when none),
// and its link. Nothing else.
const registryOf = (d) => orNull(String(d.registry ?? '').trim().slice(0, 30));
const publicPup = (d, kennel) => ({ id: d.id, call_name: d.call_name || '', sex: orNull(d.sex), color: orNull(d.color_markings), registration: orNull(d.intended_registration), registry: registryOf(d), ...pupLink(d, kennel) });

// A litter's expected prices as a family on their turn may see them (her setting
// turn_prices): per registration the pups of it are planned for (an undecided pup
// counts as Limited, and brings Full too, for its "($3,700 for full)"), the male and
// female price (saleDefaults.expectedPricing, the price a sale starts at: Full
// includes her surcharge, never shown apart), and her expected deposit for a male
// and a female.
// Her listed prices only: never a sale's amount or anything a family owes. null
// when she set none.
function litterPrices(litter, pups) {
  const regs = [...new Set(pups.flatMap((d) => (d.intended_registration ? [d.intended_registration] : ['limited', 'full'])))].sort();
  const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const by = Object.fromEntries(regs.map((reg) => [reg, {
    male: num(expectedPricing({ sex: 'male' }, litter, reg).price),
    female: num(expectedPricing({ sex: 'female' }, litter, reg).price)
  }]));
  const deposit = { male: num(litter.expected_deposit_male), female: num(litter.expected_deposit_female) };
  const any = Object.values(by).some((p) => p.male != null || p.female != null) || deposit.male != null || deposit.female != null;
  return any ? { by_registration: by, deposit } : null;
}

// One family's status page (Plan §5). A family still in the pipeline gets the
// detail; one whose time on the list ended (placed, declined, withdrawn, removed,
// expired) gets only its outcome, so an old link still says what happened.
function entryView(entry, ctx) {
  const contact = ctx.contactsById.get(entry.contact_id) || null;
  const view = { name: entryName(entry, contact), email: entryEmail(entry, contact), status: entry.status };
  if (entry.status_token) view.status_token = entry.status_token;
  // A family page only (E3): their page never mentions a waitlist.
  if (isFamilyPageOnly(entry)) view.page_only = true;
  // Which time on the list this record is, for a family with more than one (the
  // server links them on each page): when it started, and its own pup's call name.
  if (entry.applied_date) view.since = entry.applied_date;
  const pup = ctx.pupFor(entry);
  if (pup) view.pup = pup;
  view.record = ctx.recordFor(entry);
  const companion = companionView(entry, ctx);
  if (companion) view.companion = companion; // absent without an open sale
  // Her puppy portal (KennelPort portal plan 3.4): from their signed contract on,
  // Open your puppy portal; once the portal has taken over, only that. Absent
  // while her portal is off, or without a signed, live sale on this record.
  const portal = ctx.portalFor(entry);
  if (portal) view.portal = portal;
  // Extras they may ask for or cancel (Family Requests plan §3): names only, never
  // a price; absent without an open sale or anything to show.
  const extras = companion ? ctx.extrasFor(entry) : null;
  if (extras) view.extras = extras;
  // Their payments (Payment Schedule plan §7): the sale's statement as they may see
  // it (paymentSchedule.familyPaymentsView), with her payment instructions and her
  // final-payment methods (D9); absent without an open sale or anything on it.
  const payments = companion ? ctx.paymentsFor(entry) : null;
  if (payments) view.payments = payments;
  // Pickup (Family Requests plan §4): their times, booking, requests, and whether
  // they may suggest their own place; absent without an open sale.
  const pickup = companion ? ctx.pickupFor(entry) : null;
  if (pickup) view.pickup = pickup;
  // Backing out (Family Requests plan §7): with an open sale they can tell her; their
  // request as their page shows it (her reason list and policy text are the kennel's).
  // A back-out she approved ends that sale, so it shows without one too, for the
  // days a decided request stays (what happened to their deposit), never as a form.
  const backOut = requestView(entry.back_out_request, ctx.today, (r) => ({ reason: r.reason?.label || '', outcome: r.outcome || null }));
  if (companion) view.back_out = { available: true, request: backOut };
  else if (backOut && backOut.decided === 'approved') view.back_out = { available: false, request: backOut };
  // Her policies banner (it compares her last change with the day they applied) for a
  // placed family with an open sale too: a back-out policy matters most to them.
  if (companion && entry.applied_date && !WAITLIST_OPEN_STATUSES.includes(entry.status)) view.applied_date = entry.applied_date;
  if (!WAITLIST_OPEN_STATUSES.includes(entry.status)) return view;

  const program = ctx.programsById.get(entry.waitlist_program_id) || null;
  const fee = feeForEntry(ctx.config, program);
  Object.assign(view, {
    applied_date: orNull(entry.applied_date),
    approved_date: orNull(entry.approved_date),
    // Their overall place only, never a per-litter one. Published during their turn
    // too: their page shows "It's your turn!" instead (place_hidden), and the server
    // finds their public-list row by it to show "Currently deciding" (listView).
    position: ctx.positions.get(entry.id) ?? null,
    place_hidden: ctx.hidden.get(entry.id) || null,
    // Their place for what they want, under their overall number (decided
    // 2026-10-10): per answer they narrowed, and for all of them together
    // (waitlistRules.prefPlaces). {} when their answers are all open.
    pref_places: { ...(ctx.prefPlaces.get(entry.id) || {}) },
    // Litters with open picks whose turn they passed on or let lapse: their page
    // says so and offers no "Not this litter" for them. Ids only.
    spent_litter_ids: [...new Set(ctx.offers
      .filter((o) => o.entry_id === entry.id && (o.outcome === 'passed' || o.outcome === 'no_response') && ctx.picksOpen.has(o.litter_id))
      .map((o) => o.litter_id))].sort(),
    prefs: {
      sex: entry.pref_sex || 'any',
      breed: orNull(entry.pref_breed),
      purposes: Array.isArray(entry.pref_purposes) ? [...entry.pref_purposes] : [],
      colors: Array.isArray(entry.pref_colors) ? [...entry.pref_colors] : (orNull(entry.pref_colors) ? [entry.pref_colors] : []),
      ready_timing: orNull(entry.ready_timing)
    },
    paused_until: isManuallyPaused(entry, ctx.today) ? entry.paused_until : null,
    ready_from: isReadyHeld(entry, ctx.today) ? readyFromDate(entry) : null,
    // "Ready now?" (§16.7): asked when their hold ended while the list is online;
    // `answer_by` only under her remove_after setting. Never their reason.
    ready_check: entry.status === 'active' ? readyCheckView(readyCheck(entry, ctx.today, ctx.config)) : null,
    listen: {
      mode: entry.listen_mode || 'all',
      sire_ids: [...(entry.listen_sire_ids || [])],
      dam_ids: [...(entry.listen_dam_ids || [])]
    },
    passes: { used: passesUsed(entry, ctx.offers), max: Number(ctx.config.max_passes) },
    requests: requestsView(entry, ctx.today),
    // How their name shows on the public list (Spec §15.3): private ("A***** K") or
    // not, and their request to list privately as their page shows it (no expiry:
    // it's the answer to a question on their application).
    private_name: {
      on: Boolean(entry.private_listing),
      request: entry.private_request && entry.private_request.requested_date
        ? { requested_date: entry.private_request.requested_date, decided: entry.private_request.decided || null, decided_date: orNull(entry.private_request.decided_date) }
        : null
    },
    // "Not this litter" (§16.2): which, and when; never their reason.
    prepasses: (entry.prepasses || []).map((p) => ({
      ...(p.litter_id ? { litter_id: p.litter_id } : { pairing_id: p.pairing_id }), date: orNull(p.date)
    })),
    fee_received_date: orNull(entry.fee_received_date),
    // What's credited toward their pup (their Current Position card, and their
    // deposit while a pick they sent waits for her device): null when nothing.
    credits: ctx.creditsView(entry),
    // They paid the fee online before she approved them (Integrations plan §4): the
    // day, so their page says so instead of asking again.
    fee_paid_online: orNull(entry.fee_paid_online?.date),
    // What to pay and how: only while approved and unpaid (Spec §5.3, §8.1). With
    // her fee's Payment service set, their own Pay link (and what it charges, with
    // a passed-on card fee) too (Integrations plan §4).
    // Their credit for funds already received comes off it (`credit`, what it
    // covers); a Pay link charges the whole fee, so it's left off then.
    fee_due: entry.status === 'approved' && !entry.fee_received_date && fee !== null && fee > 0
      ? (() => {
          const credit = Math.min(ctx.creditFor(entry)?.byKey.fee || 0, fee);
          return {
            amount: Math.round((fee - credit) * 100) / 100, due_date: orNull(entry.fee_due_date), instructions: ctx.config.payment_instructions || '', credit_policy: ctx.config.fee_credit_policy,
            ...(ctx.config.fee_credit_policy === 'credited_to_purchase' && ctx.config.fee_credit_toward === 'deposit' ? { credit_toward: 'deposit' } : {}),
            ...(credit > 0 ? { credit } : (ctx.feePayFor(fee, entry.id) || {}))
          };
        })()
      : null,
    // Each item she shows on family pages (§16.4): whether they're waiting for it
    // (listen-only) and, for a born litter, whether they match its available pups.
    // A planned heat is no litter yet: nothing to wait for or say "Not this litter" to.
    upcoming: entry.status === 'active' ? Object.fromEntries(ctx.upcoming.filter((u) => u.family && u.kind !== 'planned_heat').map((u) => [u.id, {
      waiting: isListeningFor(entry, u),
      ...(u.kind === 'early_litter' ? { match: Boolean(ctx.matches.get(entry.id)?.has(u.litter_id)) } : {})
    }])) : {},
    // Born litters, picks not open yet: they match it, or what to review (§16.6).
    whelp_notes: ctx.notes.get(entry.id) || [],
    // The live litters whose available pups they match now (a yes/no, never a place).
    matching_litter_ids: [...(ctx.matches.get(entry.id) || [])].sort(),
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
        picked_dog_id: orNull(o.chosen_dog_id),
        // Server only (never shown): a side sale, not a turn (Side Sale Spec §6).
        ...(o.direct ? { direct: true } : {}),
        // Sending the deposit (their turn card, once they pick): her payment
        // instructions (already on their page for the fee), and the deposit on the
        // sale their pick made, else her listed deposit for that pup.
        deposit_instructions: ctx.config.payment_instructions || '',
        // Their pick as a family may see it (it's no longer among the litter's
        // available pups, so it comes with the offer).
        ...(o.chosen_dog_id ? { deposit_amount: ctx.depositFor(o), picked_pup: ctx.pickedPup(o.chosen_dog_id) } : {}),
        // What their credit for funds already received covers of that deposit, and
        // what their application fee does when she credits it toward the deposit:
        // the sale's payment statement, so it agrees with their Payments card.
        ...(o.chosen_dog_id && o.sale_id ? ctx.depositCreditsFor(entry, o) : {})
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
      help: q.help || '', options: [...(q.options || [])], ...(q.link ? { link: q.link } : {})
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

// Each dog's earned titles (her logged `title_earned` events' abbreviations), in
// the order earned, for the pairings and early litters she shows (§16.4, Q32).
export function titlesByDog(events = []) {
  const out = new Map();
  const earned = events
    .filter((ev) => ev.event_type === 'title_earned' && ev.subject_type === 'dog' && !ev.is_archived && String(ev.details?.title_abbreviation ?? '').trim())
    .sort((a, b) => String(a.event_date || '').localeCompare(String(b.event_date || '')) || String(a.id).localeCompare(String(b.id)));
  for (const ev of earned) {
    const list = out.get(ev.subject_id) || [];
    const t = String(ev.details.title_abbreviation).trim();
    if (!list.includes(t)) list.push(t);
    out.set(ev.subject_id, list);
  }
  return out;
}

// Pairings and litters before picks open (Spec §16.4), only the stages she
// switched on, each saying where it shows (`public`, `family`). A parent is its
// call name and titles, nothing else; dates are hers to publish (Q32): a pairing's
// expected whelp date, a whelped litter's whelp date and "picks expected to open"
// (its accept-deposits date). A planned heat is its dam and the month only
// (`expected_month`, YYYY-MM): never its day, which never leaves her device.
// Internal `sire_id`/`dam_id`/`litter_id` are kept for the per-family view and
// stripped by toUpcomingView.
// A parent as family pages show one (Coming up, Available Puppies, Review Your
// Preferences, a turn): call name and earned titles, and, where she shows them,
// its completed health tests (`tests`: [{ name, result }], absent when none or
// hidden), and its photos link where she shows it (`photos_url`, dogPhotosLink).
// Its registered name whenever it has one (`registered_name`), and with her
// setting `parent_pedigree` its own sire's and dam's registered names where known
// (`pedigree`: { sire, dam }, either null; absent when neither is known). The
// family pages put those three behind an info bubble by the call name.
// And a litter's breed: the dam's, else the sire's.
const regName = (dog) => String(dog?.registered_name ?? '').trim() || null;
export function parentPedigree(dog, dogsById) {
  if (!dog) return null;
  const sire = regName(dogsById.get(dog.sire_id));
  const dam = regName(dogsById.get(dog.dam_id));
  return sire || dam ? { sire, dam } : null;
}
const parentView = (dogsById, titles, id, testsOf = () => [], { pedigree = false } = {}) => {
  const dog = dogsById.get(id);
  const tests = testsOf(id);
  const reg = regName(dog);
  const ped = pedigree ? parentPedigree(dog, dogsById) : null;
  return {
    name: dog?.call_name || regName(dog) || 'Unknown', titles: [...(titles.get(id) || [])], ...(tests.length ? { tests } : {}), ...withPhotos(dogPhotosLink(dog)),
    ...(reg ? { registered_name: reg } : {}), ...(ped ? { pedigree: ped } : {})
  };
};

// Which of a dog's tests family pages show (PARENT_TESTS_SHOWN): its own say
// (Dog.waitlist_tests), else her Waitlist setting (`parent_tests`, default 'off').
const SHOWN = ['off', 'normal', 'all'];
export function parentTestsShown(dog, config) {
  if (SHOWN.includes(dog?.waitlist_tests)) return dog.waitlist_tests;
  return SHOWN.includes(config?.parent_tests) ? config.parent_tests : 'off';
}

// dogId → the tests a family page shows for it ([] when off or none), copied by
// name: a test's name and result, nothing else (never its flag). 'normal' keeps
// only results flagged Normal, judged on each test's LATEST result: a retest
// flagged Abnormal hides that test rather than falling back to an older Normal.
function parentTestsOf(dogsById, config, events) {
  const done = completedTestsByDog(events);
  return (id) => {
    const shown = id ? parentTestsShown(dogsById.get(id), config) : 'off';
    if (shown === 'off') return [];
    return (done.get(id) || []).filter((t) => shown === 'all' || t.outcome === 'Normal').map((t) => ({ name: t.name, result: t.result }));
  };
}
const breedOf = (dogsById, damId, sireId) => orNull(dogsById.get(damId)?.breed || dogsById.get(sireId)?.breed);

function upcomingSection(kennel, config, { litters, pairings, dogs, events, dogsById, titles, testsOf, today }) {
  const show = showUpcoming(config);
  const parent = (id) => parentView(dogsById, titles, id, testsOf, { pedigree: config.parent_pedigree === true });
  const where = (u) => ({ public: show[u.stage].public, family: show[u.stage].family });
  const shown = (u) => show[u.stage].public || show[u.stage].family;
  const litterItems = upcomingItems(kennel, { litters, pairings })
    .filter(shown)
    .map((u) => ({
      ...u,
      label: u.litter?.nickname || `${parent(u.dam_id).name} × ${parent(u.sire_id).name}`,
      sire: parent(u.sire_id),
      dam: parent(u.dam_id),
      breed: breedOf(dogsById, u.dam_id, u.sire_id),
      expected_whelp_date: u.kind === 'early_litter' ? null : orNull(u.pairing?.expected_due_date),
      whelp_date: u.kind === 'early_litter' ? orNull(u.litter.whelp_date) : null,
      picks_expected_date: u.kind === 'early_litter' ? orNull(u.litter.accept_deposits_date) : null,
      ...withPhotos(u.kind === 'early_litter' ? photoLink(u.litter.photos_url) : null),
      expected_month: null,
      ...where(u)
    }));
  const heatItems = plannedHeats(kennel, { dogs, events, today })
    .filter(shown)
    .map((u) => ({
      ...u,
      pairing_id: null, litter_id: null, sire_id: null,
      label: parent(u.dam_id).name,
      sire: null,
      dam: parent(u.dam_id),
      breed: breedOf(dogsById, u.dam_id, null),
      expected_whelp_date: null, whelp_date: null, picks_expected_date: null,
      expected_month: u.month,
      ...where(u)
    }));
  return [...litterItems, ...heatItems];
}

const toUpcomingView = (u) => ({
  id: u.id, kind: u.kind, label: u.label, pairing_id: u.pairing_id, litter_id: u.litter_id,
  sire: u.sire, dam: u.dam, breed: u.breed, expected_whelp_date: u.expected_whelp_date, whelp_date: u.whelp_date,
  picks_expected_date: u.picks_expected_date, expected_month: u.expected_month, ...withPhotos(u.photos_url), public: u.public, family: u.family
});

const readyCheckView = (rc) => (rc ? { asked: rc.asked, answer_by: rc.answer_by, answer: rc.answer } : null);

// The projection for ONE own kennel. Callers pass that kennel's entries, offers
// and programs (a Map), and every litter, pairing, dog, sale and contact (each is
// filtered here). `today` is YYYY-MM-DD. `formKey` is her current form key (its
// PUBLIC half seals applications and family messages); `eventsThrough` the last
// family event her device has applied (the server lets go of picked pups' holds
// up to there, W2 step 5).
// `ancestors`: her pedigree-only dogs (dogRepo leaves them out of `dogs`). They're
// only looked up by id: a parent's own sire and dam, or a parent that is itself
// pedigree-only; never pups, parent choices or breeds.
// `statements`: Map(saleId → its payment statement, incomeView.getSaleStatements) for
// the families' sales; a sale without one shows no Payments card.
export function buildProjection({ kennel, entries = [], offers = [], programsById = new Map(), litters = [], pairings = [], dogs = [], ancestors = [], sales = [], contacts = [], events = [], accounts = [], today, formKey = null, eventsThrough = 0, pickupEvents = [], contracts = [], statements = new Map() }) {
  if (!kennel || !kennel.public_id) throw new Error('This kennel has no public identity yet.');
  if (!today) throw new Error('buildProjection needs today.');
  const config = waitlistConfig(kennel);
  const contactsById = new Map(contacts.map((c) => [c.id, c]));
  const dogsById = new Map([...ancestors, ...dogs].map((d) => [d.id, d]));
  const live = entries.filter((e) => !e.is_archived && e.kennel_id === kennel.id);
  const kennelOffers = offers.filter((o) => !o.is_archived && o.kennel_id === kennel.id);
  const opts = { today, config, programsById };
  const titles = titlesByDog(events);
  const testsOf = parentTestsOf(dogsById, config, events);
  const parent = (id) => parentView(dogsById, titles, id, testsOf, { pedigree: config.parent_pedigree === true });

  // Each live litter's queue tells which families match it now (Q13); a family
  // sees only that they match, never their place in it (decided 2026-10-08).
  const matches = new Map();
  const litterLabels = new Map();
  const notes = new Map();
  const litterViews = {};
  for (const litter of litters.filter((l) => isWaitlistLitter(l, kennel)).sort(byId)) {
    const pups = dogs.filter((d) => d.litter_id === litter.id);
    const queue = litterQueue(live, litter, pups, sales, opts);
    for (const q of queue) {
      if (!matches.has(q.entry.id)) matches.set(q.entry.id, new Set());
      matches.get(q.entry.id).add(litter.id);
    }
    litterLabels.set(litter.id, litterLabel(litter, dogsById));
    // "A litter you match was born" / "Review your preferences" (§16.6): shown
    // whatever her early-litters switch says (Q34).
    for (const n of whelpNotes(live, litter, pups, sales, opts)) {
      if (!notes.has(n.entry.id)) notes.set(n.entry.id, []);
      notes.get(n.entry.id).push({
        litter_id: litter.id, pairing_id: orNull(litter.pairing_id), label: litterLabel(litter, dogsById), kind: n.kind, why: n.why,
        breed: breedOf(dogsById, litter.dam_id, litter.sire_id), sire: parent(litter.sire_id), dam: parent(litter.dam_id)
      });
    }
    const open = kennelOffers.find((o) => o.litter_id === litter.id && o.outcome === 'open') || null;
    litterViews[litter.id] = {
      label: litterLabel(litter, dogsById),
      // What a family's Available Puppies card shows (decided 2026-10-08): her
      // nickname, the breed, and the parents as Coming up shows them.
      nickname: orNull(litter.nickname),
      breed: breedOf(dogsById, litter.dam_id, litter.sire_id),
      sire: parent(litter.sire_id),
      dam: parent(litter.dam_id),
      status: litter.status,
      whelp_date: orNull(litter.whelp_date),
      ready_date: orNull(litter.estimated_ready_date),
      picks_open: Boolean(litter.picks_opened_date),
      ...litterLink(litter, kennel),
      ...(config.turn_prices !== false ? { prices: litterPrices(litter, pups.filter((d) => isPupAvailable(d, sales))) } : {}),
      pairing_id: orNull(litter.pairing_id),
      // Only available pups: what a turn is picked from (the turn card, the server's
      // automatic offers and the prices read this, never `reserved`).
      pups: pups.filter((d) => isPupAvailable(d, sales)).sort(byId).map((d) => publicPup(d, kennel)),
      // Already Reserved (E2): pups whose disposition is Placed, the website's rule.
      reserved: pups.filter(isPupReserved).sort(byId).map((d) => publicPup(d, kennel)),
      open_offer_entry_id: open ? open.entry_id : null
    };
  }

  // Who gets the turns, in order (Spec §16.1): every family with an eligible pup
  // in a litter with open picks they haven't spent a turn on, however many (Q13),
  // each with those pups per litter. The list the server walks for automatic
  // offers (W2 step 7); her device decides every entry of it.
  const openLitters = litters.filter((l) => l.kennel_id === kennel.id && isPicksOpen(l));
  const turnQueue = [];
  for (const e of rankedList(live, kennel.id, programsById)) {
    const ls = turnLittersFor(e, kennelOffers, openLitters, dogs, sales, opts);
    if (!ls.length) continue;
    // Litters they said "Not this litter" to are listed apart: their turn leaves them
    // out, and a turn of nothing else is passed at once (§16.2).
    const { offer, prepassed } = splitPrepassed(e, ls);
    const program = programsById.get(e.waitlist_program_id) || null;
    turnQueue.push({
      entry_id: e.id,
      // Their window if the server offers them a turn (a program can set a longer one).
      respond_days: program && program.respond_days_override != null && program.respond_days_override !== '' ? Number(program.respond_days_override) : Number(config.respond_days),
      litters: Object.fromEntries(offer.map((x) => [x.litter.id, x.eligibleDogs.map((d) => d.id).sort()])),
      prepassed: prepassed.map((x) => x.litter.id)
    });
  }

  // A pending side sale (Side Sale Spec) reads to the family exactly as a turn with a
  // pick: an open row in the same shape, from the sale. `direct: true` is for the
  // server only (it never counts as a turn there, and the family isn't "Currently
  // deciding" on the public list); no family-facing word differs. Turn decisions
  // (the litters' open offer, the turn queue) never see these rows.
  const liveIds = new Set(live.map((e) => e.id));
  const sideOffers = sales.filter((x) => isSideSalePending(x) && liveIds.has(x.side_entry_id) && dogsById.get(x.dog_id)?.litter_id)
    .map((x) => ({
      id: x.id, turn_id: x.id, entry_id: x.side_entry_id, kennel_id: kennel.id, litter_id: dogsById.get(x.dog_id).litter_id,
      offered_date: x.sale_date || null, respond_by_date: x.side_deposit_due || null,
      eligible_dog_ids: [x.dog_id], chosen_dog_id: x.dog_id, sale_id: x.id, outcome: 'open', direct: true
    }));
  const familyOffers = [...kennelOffers, ...sideOffers];
  const hidden = new Map(live.map((e) => [e.id, placeHidden(e, familyOffers)]));
  const upcoming = upcomingSection(kennel, config, { litters, pairings, dogs, events, dogsById, titles, testsOf, today });
  const creditMemo = new Map();
  const ctx = {
    config, contactsById, programsById, offers: familyOffers, today, upcoming,
    picksOpen: new Set(Object.entries(litterViews).filter(([, l]) => l.picks_open).map(([id]) => id)),
    positions: overallPositions(live, kennel.id, programsById, { sales, dogs: dogsById }), prefPlaces: prefPlaces(live, kennel.id, programsById, config, { sales, dogs: dogsById }), matches, litterLabels, hidden, notes,
    // Each record's own pup's sale (familySale): a family back on the list for a
    // second pup gets its first pup's cards only on that pup's record.
    saleFor: (entry) => familySale(entry, sales, familyOffers, live),
    pickedPup: (id) => (dogsById.get(id) ? publicPup(dogsById.get(id), kennel) : null),
    // The deposit for a family's pick: on its sale, else her listed one for the pup.
    depositFor: (o) => {
      const sale = o.sale_id ? sales.find((x) => x.id === o.sale_id) : null;
      const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
      if (num(sale?.deposit_amount) != null) return num(sale.deposit_amount);
      const dog = dogsById.get(o.chosen_dog_id);
      const litter = dog?.litter_id ? litters.find((l) => l.id === dog.litter_id) : null;
      return num(expectedPricing(dog, litter).deposit_amount);
    },
    // The pup this record is about: the one it was placed with (even once home),
    // else its own open sale's (a pick awaiting the deposit). A call name only.
    // Where this record stands, in the family's terms, for the list of their
    // records on each status page: { state, until? }. Facts their own page shows.
    recordFor: (entry) => {
      const own = familyOffers.filter((o) => o.entry_id === entry.id && o.outcome === 'open' && !o.is_archived);
      const placedSale = entry.placed_sale_id ? sales.find((x) => x.id === entry.placed_sale_id) : null;
      switch (entry.status) {
        case 'active':
          if (own.some((o) => o.chosen_dog_id)) return { state: 'picked' };
          if (own.length) return { state: 'turn' };
          if (entry.paused_until && entry.paused_until >= today) return { state: 'paused', until: entry.paused_until };
          return { state: 'waiting' };
        case 'placed': return { state: placedSale?.status === 'delivered' ? 'home' : 'chose' };
        case 'withdrawn': return { state: entry.back_out_request?.decided === 'approved' ? 'backed_out' : 'left' };
        default: return { state: entry.status };
      }
    },
    pupFor: (entry) => {
      const sale = (entry.placed_sale_id && sales.find((x) => x.id === entry.placed_sale_id)) || familySale(entry, sales, familyOffers, live);
      return (sale?.dog_id && dogsById.get(sale.dog_id)?.call_name) || null;
    },
    portalOn: portalOn(kennel),
    // The record's own sale: the one it was placed with, else its open one.
    portalFor: (entry) => {
      if (!portalOn(kennel)) return null;
      const sale = (entry.placed_sale_id && sales.find((x) => x.id === entry.placed_sale_id)) || familySale(entry, sales, familyOffers, live);
      return portalEntryView(entry, { sale, contracts, events: pickupEvents, home: kennel.kennelport_portal.home || [], today });
    },
    pickupFor: (entry) => familyPickupView({ entry, sales, offers: familyOffers, dogsById, litters, kennel, config, entries: live, events: pickupEvents, today }),
    extrasFor: (entry) => {
      const sale = familySale(entry, sales, familyOffers, live);
      if (!sale) return null;
      const dog = dogsById.get(sale.dog_id) || null;
      const litter = dog?.litter_id ? litters.find((l) => l.id === dog.litter_id) : null;
      return familyExtrasView({ entry, sale, kennel, birthDate: pupBirthDate(dog, litter), today });
    },
    // How a family's credits for funds already received are used (incomeView.familyCredit).
    // Their received application fee when it's credited toward the deposit (her
    // setting fee_credit_toward), as incomeView.feeCreditOf reads it; else none.
    feeCreditFor: (entry) => (entry.fee_received_date && Number(entry.fee_amount) > 0 && entry.fee_credit_policy === 'credited_to_purchase'
      ? { amount: Number(entry.fee_amount), toward: config.fee_credit_toward === 'deposit' ? 'deposit' : 'balance' } : 0),
    creditFor: (entry) => {
      if (!creditMemo.has(entry.id)) creditMemo.set(entry.id, familyCredit(entry, creditSale(entry, sales, familyOffers, live), ctx.feeCreditFor(entry)));
      return creditMemo.get(entry.id);
    },
    // A family's credits as their own page shows them, whatever the pup or sale:
    // { fee, fee_toward, received, deposit } or null. `fee` is their received
    // application fee credited to the purchase price (`fee_toward` deposit or
    // balance); `received` is what their credits for funds already received can
    // pay toward the pup, after the fee; `deposit` is the most of it a deposit
    // takes (a credit not ticked for the deposit can't pay it).
    creditsView: (entry) => {
      const fc = ctx.feeCreditFor(entry);
      const credits = creditsOf(entry);
      const BIG = 1e9;
      const pup = credits.length ? allocateCredits(credits, [...feeCharge(entry),
        { key: 'deposit', use: 'deposit', amount: BIG }, { key: 'price', use: 'price', amount: BIG }, { key: 'extras', use: 'extras', amount: BIG }]) : null;
      const deposit = credits.length ? allocateCredits(credits, [...feeCharge(entry), { key: 'deposit', use: 'deposit', amount: BIG }]).byKey.deposit || 0 : 0;
      const received = pup ? Math.round((pup.applied - (pup.byKey.fee || 0)) * 100) / 100 : 0;
      if (!fc && !(received > 0)) return null;
      return { fee: fc ? fc.amount : 0, fee_toward: fc ? fc.toward : null, received, deposit };
    },
    feeDepositFor: (entry, o) => {
      const sale = sales.find((x) => x.id === o.sale_id);
      return sale ? feeCreditSplit(sale, ctx.feeCreditFor(entry)).deposit : 0;
    },
    // A pick's deposit as credits pay it: { deposit_credit?, deposit_fee_credit? }.
    // From the sale's statement (what its application fee and credits for funds
    // received paid of the deposit); without one, worked out as before.
    depositCreditsFor: (entry, o) => {
      const st = statements.get(o.sale_id);
      const fromSt = (kind) => (st ? Math.round(st.received.filter((r) => r.kind === kind)
        .reduce((t, r) => t + r.pays.filter((p) => p.key === 'deposit').reduce((u, p) => u + p.amount, 0), 0) * 100) / 100 : null);
      const credit = st ? fromSt('credit') : (ctx.creditFor(entry)?.byKey.deposit || 0);
      const fee = st ? fromSt('fee') : ctx.feeDepositFor(entry, o);
      return { ...(credit > 0 ? { deposit_credit: credit } : {}), ...(fee > 0 ? { deposit_fee_credit: fee } : {}) };
    },
    // Their Payments card (Payment Schedule plan §7), or null.
    paymentsFor: (entry) => {
      const sale = familySale(entry, sales, familyOffers, live);
      const view = sale ? familyPaymentsView(statements.get(sale.id)) : null;
      if (!view) return null;
      return {
        ...view,
        how_to_pay: config.payment_instructions || '',
        final_methods: String(kennel.final_payment_methods || '').trim()
      };
    },
    // A family's own Pay link for a fee of `fee` (Integrations plan §4), or null.
    feePayFor: (fee, entryId) => {
      const pay = feePay(kennel, accounts, fee);
      return pay ? { pay_url: withClientRef(pay.url, entryId), pay_amount: pay.amount } : null;
    }
  };
  // The fee at the end of the online application (fee_link_when 'apply'): the base
  // link, the server adds each applicant's id when it's a Stripe link.
  const applyPay = config.fee_link_when !== 'approved' ? feePay(kennel, accounts, feeForEntry(config, null)) : null;
  const entryViews = {};
  for (const e of [...live].sort(byId)) entryViews[e.id] = entryView(e, ctx);

  return {
    format: PROJECTION_FORMAT,
    as_of: today,
    kennel: {
      public_id: kennel.public_id,
      name: kennel.kennel_name || '',
      // The message under her public list's heading (publicIntroText).
      intro: publicIntroText(config, kennel.kennel_name || ''),
      time_zone: orNull(kennel.time_zone),
      respond_days: Number(config.respond_days),
      // The weekdays she does business, so a turn the server offers counts its days
      // the way her device does (dateUtils.addOpenDays). null = every day.
      open_days: openDays(config).length === 7 ? null : openDays(config),
      // …and her closed dates still ahead (or just past), skipped the same way.
      closed_dates: liveClosedDates(closedDates(config), today),
      max_passes: Number(config.max_passes),
      auto_offer_on: [...config.auto_offer_on],
      // What the server sends by itself while her phone is off (W2 step 7): her
      // wording for those emails, and whether to send reminders at all.
      email_templates: serverEmailTemplates(config),
      reminders: config.email_reminders !== false,
      breeds: kennelBreeds(kennel, dogs),
      // Her pass reasons and the message each shows the family (§16.5).
      pass_reasons: passReasons(config),
      // Her waitlist policies (Waitlist Policies plan §3): every family page, the
      // application and her website; absent when she has none. Never her editing notes.
      ...(waitlistPolicies(config).length ? {
        policies: waitlistPolicies(config).map((x) => ({ id: x.id, heading: x.heading, body: x.body, ...(x.topic ? { topic: x.topic } : {}) })),
        policies_updated: orNull(config.policies_updated)
      } : {}),
      color_matching: Boolean(config.color_matching),
      // "Message us on Facebook" (Spec §11): only while she has it switched on.
      ...(config.facebook_button && messengerLink(config.facebook_page) ? { messenger: messengerLink(config.facebook_page) } : {}),
      parents: parentsSection(kennel, live, { dogs, litters, pairings }),
      ...(formKey ? { message_key: { key_id: formKey.id, public_key: formKey.public_key } } : {}),
      ...(config.online_form && formKey ? { form: formSection(kennel, config, formKey, dogs) } : {}),
      // Her own website may show the form and list in a frame (Integrations plan
      // §1): only while she has it on; no sites listed = any site.
      ...(config.embed ? { embed: { origins: embedOrigins(config) } } : {}),
      // Her KennelPort website may read the public list (/f/site) and draw it in
      // its own style: only while she has it on. Nothing new is published.
      ...(config.website_feed ? { website_feed: true } : {}),
      // Her referral links marked "Share with families" (Integrations plan §3), for
      // every family's status page: name, link, code, instructions; none = absent.
      ...(sharedReferrals(accounts).length ? { recommended: sharedReferrals(accounts) } : {}),
      // Her Transport accounts marked "Share with families" (Family Requests plan
      // D8): name, link, notes. The server shows them only to a family with an
      // open sale (entry.companion); none = absent.
      ...(sharedTransport(accounts).length ? { transport: sharedTransport(accounts) } : {}),
      // Above the extras on a family's page (Family Requests plan §3): her message
      // and her own page with the details and prices (opened in a new tab).
      // Backing out: her reasons and what families read first, while any family can.
      ...(Object.values(entryViews).some((v) => v.back_out?.available) ? {
        back_out_reasons: backOutReasons(config).map((r) => ({ id: r.id, label: r.label })),
        back_out_policy_text: backOutPolicyText(config, kennel.kennel_name)
      } : {}),
      // Only while some family has extras to see.
      ...(Object.values(entryViews).some((v) => v.extras) ? {
        extras_intro: (config.extras_intro_text || '').trim() || EXTRAS_INTRO_DEFAULT,
        ...(extrasInfoLink(config.extras_info_url) ? { extras_info_url: extrasInfoLink(config.extras_info_url) } : {})
      } : {}),
      ...(applyPay ? { fee_pay: { url: applyPay.url, amount: applyPay.amount, fee: Number(feeForEntry(config, null)), ref_param: applyPay.stripe, instructions: config.payment_instructions || '' } } : {})
    },
    // Unmasked: the server shows "Currently deciding" for whoever holds a turn when
    // the page is served (publicList, familyPages.listView).
    public_list: publicList(live, kennel.id, programsById, {
      today, nameOf: (e) => publicSourceName(e, contactsById.get(e.contact_id)), config, sales, dogs: dogsById,
      wantsMore: (e) => publicWantsMore(e, { config, breeds: kennelBreeds(kennel, dogs), dogsById })
    }),
    // Families with a pup selected (E1), at the numbers they hold: the public list
    // has gaps there. Names as public_list's (private names masked).
    public_selected: publicSelected(live, kennel.id, programsById, {
      nameOf: (e) => publicSourceName(e, contactsById.get(e.contact_id)), config, sales, dogs: dogsById
    }),
    entries: entryViews,
    litters: litterViews,
    upcoming: upcoming.map(toUpcomingView),
    turn_queue: turnQueue,
    events_through: Number.isInteger(eventsThrough) && eventsThrough > 0 ? eventsThrough : 0,
    // For the server only, never in a family's view: her standard location (a public
    // place near her, Family Requests plan §5), where it measures a family's miles
    // from; and her puppy portal's one-tap link (KennelPort portal plan 3.4): where it
    // goes, and the key the server signs each family's link with.
    ...(standardLocation(kennel) || portalOn(kennel) ? { server: {
      ...(standardLocation(kennel) ? { geo_from: standardLocation(kennel).address } : {}),
      ...(portalOn(kennel) ? { portal: {
        url: kennel.kennelport_portal.url || null,
        handoff_url: kennel.kennelport_portal.handoff_url,
        handoff_key: kennel.kennelport_portal.handoff_key,
        minutes: Number(kennel.kennelport_portal.handoff_minutes) || 10
      } } : {})
    } } : {})
  };
}
