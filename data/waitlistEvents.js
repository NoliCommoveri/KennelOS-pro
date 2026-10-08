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
// Events the server makes itself (deadlines and automatic offers, step 7) are
// not handled yet: they're skipped here, and no server writes any before step 7.
import { WAITLIST_OPEN_STATUSES } from './vocab.js';
import { isPupAvailable, isListenOnly, listenChangeKind, prefChangeLines, PREF_CHANGE_FIELDS, turnIdOf, turnSpent, passReasonOf } from './waitlistRules.js';
import { arrivalDate } from './waitlistInbox.js';

export const FAMILY_EVENT_KINDS = ['pick', 'pass', 'still_interested', 'pause_request', 'leave', 'listen', 'pref_change', 'prepass', 'unprepass', 'ready'];
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
// `date` is the day the family acted, in the kennel's time zone; `activity` the
// line for their entry's activity ({ id, at, body }), or null.
export function planFamilyEvent(event, ctx) {
  const { entry = null, offers = [], pups = [], sales = [], litterLabel = () => 'the litter', pupName = () => 'a pup', timeZone = null, config = null } = ctx;
  // Their reason (§16.5), checked against her list as it is now: { id, label, text } or null.
  const reasonOf = (r) => passReasonOf(config, r);
  const said = (r) => (r ? ` Their reason: ${r.label}${r.text ? `: "${r.text}"` : ''}.` : '');
  const date = arrivalDate(event.createdAt, timeZone) || String(event.createdAt || '').slice(0, 10);
  const skip = (reason) => ({ op: 'skip', reason, date, activity: null });
  if (event.madeBy !== 'family') return skip('server_move');
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
