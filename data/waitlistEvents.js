// waitlistEvents.js — what a family's action on their status page does on her
// device (Waitlist Spec §8.4; W2 Plan §6, step 5). PURE: one server event and
// the records it touches in, one plan out; no Dexie, no DOM, no clock.
// tests/waitlistEvents.test.js. cloudWaitlist.applyFamilyEvents fetches the
// events on the backing device and carries each plan out through
// waitlistActions.applyFamilyPlan.
//
// The server checked each action against what her device last published, but
// her records may have moved on since (she recorded an outcome, a pup was sold,
// the family left). So nothing is taken on trust: each action is checked again
// here against her records now, and one that no longer fits is never forced
// through. It becomes a line in the family's activity on their entry ("They
// picked Poppy, but that offer had already closed"), which Today shows her.
//
// What applies by itself and what waits for her (Spec §6.3, §15.7, §15.9):
//  - pick → recordPick (a deposit-pending Sale holds the pup; the deposit stays her tap)
//  - pass → recordOutcome(…, 'passed'); leave → withdraw
//  - still interested → a line in their activity
//  - a pause, a NARROWER listen-only change and any change to a matching answer
//    → a request on the entry; nothing changes until she taps Approve
//  - a WIDER listen-only change → applied at once (it can't dodge an offer)
//  - a Companion link request (a family with an open sale) → a request on the
//    entry; she sends the link from the Companion page and marks it sent
// Events the server makes itself while her phone is off (W2 step 7, only for the
// moments she ticked in auto_offer_on) are planned by planServerEvent below:
//  - server_close  → recordOutcome(…, 'no_response') on that turn
//  - server_offer  → the turn the server offered, made on her device with the
//                    server's ids (waitlistActions.applyServerOffer)
// Each is checked against her records now like a family's action; one that no
// longer fits (she recorded the outcome herself, another turn is open, the pups
// were sold) becomes a line on the family's entry instead, which Today shows.
// When the server moved the turn on after a family's pass or leave, or its own
// close, the plan for that event carries `moveOn: false` (cloudWaitlist sets it),
// so her device doesn't offer a second family.
import { WAITLIST_OPEN_STATUSES, isOpenSale } from './vocab.js';
import { isPupAvailable, isListenOnly, listenChangeKind, prefChangeLines, PREF_CHANGE_FIELDS, turnIdOf, turnSpent, passReasonOf } from './waitlistRules.js';
import { arrivalDate } from './waitlistInbox.js';

export const FAMILY_EVENT_KINDS = ['pick', 'pass', 'still_interested', 'pause_request', 'leave', 'listen', 'pref_change', 'prepass', 'unprepass', 'ready', 'companion_request'];
export const NOTE_MAX = 500;

const clean = (v) => String(v ?? '').trim().slice(0, NOTE_MAX);
const ids = (v) => [...new Set((Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && x))];

// The id of the activity line an event writes on the entry: one per event, so an
// event applied twice never writes it twice.
export const activityId = (event) => `event-${event.seq}`;

// `event` is one item of GET /waitlist/events ({ seq, entryId, kind, payload,
// madeBy, createdAt }). `ctx`: { entry (or null), offers (this entry's), pups
// (every pup of the litters those offers are on), sales, litterLabel(id),
// pupName(id), timeZone (the kennel's) }.
// → { op, date, activity, … }:
//   op 'skip'           nothing to do (reason says why); no activity line
//   op 'note'           only the activity line
//   op 'pick'           { offerId, dogId }
//   op 'pass'           { offerId }
//   op 'withdraw'
//   op 'pause_request'  { request }  → entry.pause_request
//   op 'listen_apply'   { changes }  → the entry's listen fields
//   op 'listen_request' { request }  → entry.listen_change_request
//   op 'pref_request'   { request }  → entry.pref_change_request
//   op 'prepass'        { prepass }  → "Not this litter" on the entry (§16.2)
//   op 'unprepass'      { target }   → taken back
//   op 'ready'          { answer, until, reason } → "Ready now?" answered (§16.7)
//   op 'companion_request' { request } → entry.companion_request
// `date` is the day the family acted, in the kennel's time zone; `activity` the
// line for their entry's activity ({ id, at, body }), or null.
export function planFamilyEvent(event, ctx) {
  const { entry = null, offers = [], pups = [], sales = [], litterLabel = () => 'the litter', pupName = () => 'a pup', timeZone = null, config = null } = ctx;
  // Their reason (§16.5), checked against her list as it is now: { id, label, text } or null.
  const reasonOf = (r) => passReasonOf(config, r);
  const said = (r) => (r ? ` Their reason: ${r.label}${r.text ? `: "${r.text}"` : ''}.` : '');
  const date = arrivalDate(event.createdAt, timeZone) || String(event.createdAt || '').slice(0, 10);
  const skip = (reason) => ({ op: 'skip', reason, date, activity: null });
  if (event.madeBy === 'server') return planServerEvent(event, ctx);
  if (event.madeBy !== 'family') return skip('unknown_maker');
  if (!FAMILY_EVENT_KINDS.includes(event.kind)) return skip('unknown_kind');
  if (!entry || entry.is_archived) return skip('no_entry');
  const p = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const line = (body) => ({ id: activityId(event), at: event.createdAt, body });
  const note = (body) => ({ op: 'note', date, activity: line(body) });
  const open = WAITLIST_OPEN_STATUSES.includes(entry.status);
  const active = entry.status === 'active';
  const gone = `they're no longer on the list (${entry.status})`;

  switch (event.kind) {
    case 'pick': {
      const offer = offers.find((o) => o.id === p.offer_id);
      const what = `They picked ${pupName(p.dog_id)} from ${litterLabel(p.litter_id || offer?.litter_id)} on their status page`;
      if (!offer || offer.is_archived) return note(`${what}, but that offer no longer exists, so nothing was recorded.`);
      if (offer.outcome !== 'open') return note(`${what}, but that offer had already closed (${offer.outcome.replace(/_/g, ' ')}), so nothing was recorded.`);
      if (offer.chosen_dog_id === p.dog_id) return skip('already_picked');
      // One pick per turn (Spec §16.1): a pick she already recorded on any litter of it wins.
      const recorded = offers.find((o) => turnIdOf(o) === turnIdOf(offer) && o.outcome === 'open' && o.chosen_dog_id);
      if (recorded) return note(`${what}, but you'd already recorded ${pupName(recorded.chosen_dog_id)} as their pick. Change it on the offer if they meant to switch.`);
      if (!(offer.eligible_dog_ids || []).includes(p.dog_id)) return note(`${what}, but that pup wasn't one offered to them, so nothing was recorded.`);
      const dog = pups.find((d) => d.id === p.dog_id);
      if (!dog || !isPupAvailable(dog, sales)) return note(`${what}, but that pup is no longer available, so nothing was recorded. Let them know.`);
      return { op: 'pick', offerId: offer.id, dogId: dog.id, date, activity: line(`${what}. Their pick is held by a sale with the deposit pending.`) };
    }
    case 'pass': {
      // A pass covers their whole turn (Spec §16.1): every litter in it, counted once.
      // Older events name one offer; its turn is the same thing.
      const named = offers.find((o) => o.id === p.offer_id || (p.offer_ids || []).includes(o.id));
      const turnId = p.turn_id || turnIdOf(named);
      const rows = offers.filter((o) => !o.is_archived && turnIdOf(o) === turnId);
      const open = rows.filter((o) => o.outcome === 'open');
      const litters = (p.litter_ids || rows.map((o) => o.litter_id)).map(litterLabel).join(', ') || litterLabel(p.litter_id);
      const what = `They passed on ${litters} on their status page`;
      const reason = reasonOf(p.reason);
      if (!open.length) return note(`${what}, but that turn had already closed, so nothing was recorded.${said(reason)}`);
      return { op: 'pass', offerId: open[0].id, reason, date, activity: line(`${what}.${said(reason)}`) };
    }
    case 'prepass': {
      const target = p.litter_id ? { litter_id: String(p.litter_id) } : p.pairing_id ? { pairing_id: String(p.pairing_id) } : null;
      if (!target) return skip('bad_payload');
      const name = target.litter_id ? litterLabel(target.litter_id) : 'an upcoming pairing';
      const reason = reasonOf(p.reason);
      const what = `Said "Not this litter" to ${name} on their status page.${said(reason)}`;
      if (!active) return note(`${what} But ${gone}.`);
      if (target.litter_id && offers.some((o) => o.litter_id === target.litter_id && o.outcome === 'open' && !o.is_archived)) {
        return note(`${what} But it's in their open turn now, so nothing was recorded; they can pass on the turn.`);
      }
      if (target.litter_id && turnSpent(offers, target.litter_id, entry.id)) return note(`${what} They'd already had their turn on it, so nothing changes.`);
      return { op: 'prepass', date, prepass: { ...target, reason, date }, activity: line(`${what} Nothing counts unless their turn comes; then it's recorded as a pass.`) };
    }
    case 'unprepass': {
      const target = p.litter_id ? { litter_id: String(p.litter_id) } : p.pairing_id ? { pairing_id: String(p.pairing_id) } : null;
      if (!target) return skip('bad_payload');
      const had = (entry.prepasses || []).some((x) => (target.litter_id ? x.litter_id === target.litter_id : x.pairing_id === target.pairing_id));
      if (!had) return skip('no_change');
      return { op: 'unprepass', date, target, activity: line(`Took back their "Not this litter" on ${target.litter_id ? litterLabel(target.litter_id) : 'an upcoming pairing'}.`) };
    }
    case 'still_interested':
      return note('Said they\'re still interested, on their status page.');
    case 'leave': {
      if (!open) return skip('not_on_list');
      const why = clean(p.note);
      return { op: 'withdraw', date, activity: line(`Left the list on their status page.${why ? ` They said: "${why}"` : ''}`) };
    }
    case 'ready': {
      if (!active) return note(`Answered "Ready now?", but ${gone}.`);
      if (p.answer === 'yes') return { op: 'ready', answer: 'yes', date, activity: line('Said they\'re ready now, on their status page.') };
      const reason = clean(p.reason);
      if (p.answer !== 'no' || !/^\d{4}-\d{2}-\d{2}$/.test(String(p.until ?? '')) || !reason) return skip('bad_payload');
      // Their "not yet" is a pause request (the request is what she sees and decides).
      return { op: 'ready', answer: 'no', until: p.until, reason, date, activity: null };
    }
    case 'pause_request': {
      if (!active) return note(`Asked to pause their place until ${p.until}, but ${gone}.`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.until ?? ''))) return skip('bad_payload');
      return { op: 'pause_request', date, activity: null, request: { requested_date: date, until: p.until, note: clean(p.note) } };
    }
    case 'listen': {
      if (!active) return note(`Asked to change which litters they're waiting for, but ${gone}.`);
      const next = p.mode === 'selected' || p.mode === 'except'
        ? { listen_mode: p.mode, listen_sire_ids: ids(p.sire_ids), listen_dam_ids: ids(p.dam_ids) }
        : { listen_mode: 'all', listen_sire_ids: [], listen_dam_ids: [] };
      const kind = listenChangeKind(entry, next);
      if (kind === 'same') return skip('no_change');
      if (kind === 'wider') {
        // Back to All litters keeps their earlier picks on the entry (Spec §15.7 item 3).
        const toAll = !isListenOnly(next);
        return { op: 'listen_apply', date, changes: toAll ? { listen_mode: 'all' } : next, activity: line(toAll
          ? 'Went back to waiting for all litters, on their status page.'
          : next.listen_mode === 'except'
            ? 'Took parents off the litters they skip, on their status page.'
            : 'Added parents to the litters they\'re waiting for, on their status page.') };
      }
      return { op: 'listen_request', date, activity: null, request: { requested_date: date, ...next } };
    }
    case 'companion_request': {
      // Only while they have an open sale (the Companion family package's rule): a
      // sale delivered or cancelled since leaves a line, not a request.
      const why = clean(p.note);
      if (!entry.contact_id || !sales.some((x) => x.buyer_contact_id === entry.contact_id && isOpenSale(x))) {
        return note(`Asked for their Companion link, but they have no open sale now, so there's no family link to send.${why ? ` They said: "${why}"` : ''}`);
      }
      return { op: 'companion_request', date, activity: null, request: { requested_date: date, note: why } };
    }
    case 'pref_change': {
      if (!open) return skip('not_on_list');
      const asked = p.changes && typeof p.changes === 'object' ? p.changes : {};
      const changes = {};
      for (const f of PREF_CHANGE_FIELDS) if (asked[f] !== undefined) changes[f] = asked[f];
      if (!prefChangeLines(entry, changes, { date }).length) return skip('no_change');
      return { op: 'pref_request', date, activity: null, request: { requested_date: date, changes, note: clean(p.note) } };
    }
    default:
      return skip('unknown_kind');
  }
}

// What KennelOS did on her list while her phone was off (W2 step 7). `ctx` as for
// planFamilyEvent, plus `kennelOffers` (every offer of the kennel) and `litters`
// (a Map of her litters). → the same plan shapes, with ops 'server_close' { offerId }
// and 'server_offer' { turn }.
export const SERVER_EVENT_KINDS = ['server_close', 'server_offer'];
export function planServerEvent(event, ctx) {
  const { entry = null, offers = [], kennelOffers = [], pups = [], sales = [], litters = new Map(), litterLabel = () => 'the litter', pupName = () => 'a pup', timeZone = null } = ctx;
  const date = arrivalDate(event.createdAt, timeZone) || String(event.createdAt || '').slice(0, 10);
  const skip = (reason) => ({ op: 'skip', reason, date, activity: null });
  if (!SERVER_EVENT_KINDS.includes(event.kind)) return skip('unknown_kind');
  if (!entry || entry.is_archived) return skip('no_entry');
  const p = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const line = (body) => ({ id: activityId(event), at: event.createdAt, from: 'server', body });
  const note = (body) => ({ op: 'note', date, activity: line(body) });
  const labels = (list) => (list || []).map(litterLabel).join(', ') || 'a litter';

  if (event.kind === 'server_close') {
    const what = `Their turn on ${labels(p.litter_ids)} reached its deadline (${p.respond_by_date || 'the respond-by date'}) while your phone was off, and KennelOS closed it`;
    const rows = offers.filter((o) => !o.is_archived && turnIdOf(o) === p.turn_id && o.outcome === 'open');
    if (!rows.length) return note(`${what} on their status page. You'd already recorded how it ended, so nothing changed here.`);
    const picked = rows.find((o) => o.chosen_dog_id);
    if (picked && !p.picked_dog_id) {
      return note(`${what} as no response, but you'd recorded ${pupName(picked.chosen_dog_id)} as their pick, so nothing was recorded here. Record the deposit or "No deposit" on their turn.`);
    }
    return { op: 'server_close', offerId: rows[0].id, date, activity: line(`${what} as ${picked ? 'no deposit' : 'no response'}, and emailed them.`) };
  }

  // server_offer
  const rows = Array.isArray(p.rows) ? p.rows : [];
  const what = `KennelOS offered them their turn on ${labels(rows.map((r) => r.litter_id))} while your phone was off (respond by ${p.respond_by_date || '?'}) and emailed them`;
  if (!p.turn_id || !rows.length) return skip('bad_payload');
  if (offers.some((o) => turnIdOf(o) === p.turn_id)) return skip('already_applied');
  const why = (reason) => note(`${what}, but ${reason}, so it wasn't recorded here. Their status page showed the offer until your next update: let them know where things stand.`);
  if (entry.status !== 'active') return why(`they're no longer on the list (${entry.status})`);
  const open = kennelOffers.filter((o) => !o.is_archived && o.outcome === 'open');
  if (open.length) return why('another turn is open on your records');
  const turnRows = [];
  for (const r of rows) {
    const litter = litters.get(r.litter_id);
    if (!litter || litter.is_archived || !litter.picks_opened_date) continue;
    const dogIds = (r.dog_ids || []).filter((id) => {
      const d = pups.find((x) => x.id === id);
      return d && d.litter_id === r.litter_id && isPupAvailable(d, sales);
    });
    if (dogIds.length) turnRows.push({ offer_id: String(r.offer_id), litter_id: r.litter_id, dog_ids: dogIds });
  }
  if (!turnRows.length) return why('none of those pups is still available with picks open');
  return {
    op: 'server_offer', date,
    turn: { turn_id: String(p.turn_id), offered_date: p.offered_date || date, respond_by_date: p.respond_by_date, rows: turnRows },
    activity: line(`${what}.`)
  };
}
