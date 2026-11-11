// portalFeed.js — the family feed for her puppy portal (KennelPort's
// docs/Puppy_Parent_Portal_Plan.md sections 3.2 and 3.4; End-State guide §35.1).
// PURE: plain records in, plain objects out; no Dexie, no DOM, no clock (callers
// pass `today`).
//
// For a kennel whose KennelPort website has the portal on (the site's facts say
// `portal_feed: 1`), each family from their signed contract on: who they are,
// their sale's puppy, its go-home and pickup time, microchip and registration
// number, the contract's signed date, a voided sale's reason, the puppy's shots,
// deworming and vet visits, and the extras on the sale; her vet; and what has gone
// since the last send. KennelPort's format 1 (its worker/src/portal/feed.js), built
// field by field with assertOnlyKeys, as siteExport.js builds the website bundle:
// a field reaches the portal only when it's named here.
//
// Never sent: an amount (a price, a deposit, an extra's charge), a phone or a
// postal address of a family, notes she keeps on a sale, contract terms, or a vet
// visit's findings.
import { pickupFor } from './goHome.js';
import { pickupFrom } from './familyPickup.js';
import { saleExtraCharges } from './extraCharges.js';
import { addDaysToYMD } from './dateUtils.js';
import { RELEASED_SALE_STATUSES } from './vocab.js';

export const PORTAL_FEED_FORMAT = 1;
// KennelPort's caps (feed.js MAX): over them it refuses the whole feed, so the
// newest are sent.
export const PORTAL_MAX = { families: 200, placements: 6, emails: 4, health: 40, removed: 400, extras: 10 };
// A placement keeps being sent this many days after its last change or go-home,
// so a correction after pickup still reaches the portal; after that it's left as
// it is there (a family not sent is never removed).
export const PORTAL_KEEP_DAYS = 60;

export const FEED_KEYS = ['format', 'feed_id', 'kennel_id', 'sent_at', 'families', 'vet', 'removed'];
export const FAMILY_KEYS = ['id', 'name', 'emails', 'status_url', 'placements'];
export const PLACEMENT_KEYS = ['id', 'puppy_id', 'puppy_name', 'contract_signed_on', 'go_home_on', 'pickup_at', 'microchip', 'registration_no', 'voided', 'health', 'extras'];
export const VOIDED_KEYS = ['reason', 'on'];
export const HEALTH_KEYS = ['id', 'type', 'given_on', 'name', 'notes'];
export const EXTRA_KEYS = ['id', 'extra_id'];
export const VET_KEYS = ['clinic', 'doctor', 'phone', 'address'];
export const REMOVED_KEYS = ['type', 'id'];

// A positive allow-list check on every object, as siteExport.js and
// companionExport.js do: an unexpected key stops the send.
function assertOnlyKeys(obj, allowed, ctx) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new Error(`Portal feed (${ctx}) has unexpected key "${k}". Nothing was sent.`);
  }
  return obj;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ymd = (v) => (YMD.test(String(v ?? '')) ? String(v) : null);
const line = (v, max) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};
const dayOf = (iso) => ymd(String(iso ?? '').slice(0, 10));
const newestFirst = (a, b) => String(b ?? '').localeCompare(String(a ?? ''));

// --- times in her time zone ------------------------------------------------------

// A pickup's free-text time ("10:00 AM", "10:00 AM–10:30 AM", "14:30", "2pm") →
// its start as 'HH:MM', or null.
export function parseClock(text) {
  const m = /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i.exec(String(text ?? ''));
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = (m[3] || '').toLowerCase().replace(/\./g, '');
  if (!m[2] && !ap) return null; // a bare number isn't a time
  if (min > 59 || h > 23 || (ap && (h < 1 || h > 12))) return null;
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// 'HH:MM' → "10:00 AM", as pickupSlots.timeRange writes them.
export function clockText(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function zoneOk(tz) {
  if (!tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// An instant's wall clock in a time zone → { date: 'YYYY-MM-DD', time: 'HH:MM' }.
// No zone (or one this browser doesn't know): this device's own.
export function zonedParts(iso, tz) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    ...(zoneOk(tz) ? { timeZone: tz } : {}), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}` };
}

// A day and a wall-clock time in a time zone → the instant, as ISO 8601; null
// when either is missing.
export function zonedIso(date, hhmm, tz) {
  if (!ymd(date) || !/^\d{2}:\d{2}$/.test(String(hhmm ?? ''))) return null;
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  // The zone's offset at that moment, found by reading the guess back (twice, for
  // a guess that lands across a daylight-saving change).
  let t = wall;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(t).toISOString(), tz);
    const [py, pm, pd] = p.date.split('-').map(Number);
    const [ph, pmi] = p.time.split(':').map(Number);
    t += wall - Date.UTC(py, pm - 1, pd, ph, pmi);
  }
  return new Date(t).toISOString();
}

// --- which sales are in the feed --------------------------------------------------

// The sale's contract, signed: a Sale contract linked to it, status Signed, with
// its signed date. The newest when there are several.
export function signedContractFor(sale, contracts) {
  return (contracts || []).filter((c) => c && !c.is_archived && c.related_sale_id === sale.id && c.contract_type === 'sale'
    && c.status === 'signed' && ymd(c.signed_date)).sort((a, b) => newestFirst(a.signed_date, b.signed_date))[0] || null;
}

// The family's pickup for this sale: its next placement event, else its last one.
export function pickupEventFor(sale, events, today) {
  const mine = (events || []).filter((e) => e.subject_id === sale.dog_id && pickupFor(sale)(e)).sort((a, b) => a.event_date.localeCompare(b.event_date));
  return mine.find((e) => e.event_date >= today) || mine[mine.length - 1] || null;
}

// The sales a kennel's feed carries, each with its contract: her kennel's, not
// archived, with a puppy and a buyer, from the signed contract on. A sale the feed
// sent before (`known`) whose contract is no longer signed stays while the sale
// ended (voided, cancelled, returned), so the portal hears why; otherwise it goes
// (a contract marked signed by mistake).
export function portalSales({ kennel, sales = [], contracts = [], dogsById, contactsById, known = [] }) {
  const sent = new Set(known.filter((k) => k.type === 'placement').map((k) => k.id));
  const out = [];
  for (const sale of sales) {
    if (!sale || sale.is_archived || sale.kennel_id !== kennel.id || !sale.dog_id || !sale.buyer_contact_id) continue;
    if (!dogsById.get(sale.dog_id) || !contactsById.get(sale.buyer_contact_id)) continue;
    const contract = signedContractFor(sale, contracts);
    if (contract) out.push({ sale, contract });
    else if (sent.has(sale.id) && RELEASED_SALE_STATUSES.includes(sale.status)) out.push({ sale, contract: null });
  }
  return out;
}

// A voided, cancelled or returned sale, as the portal reads it (feed.js `voided`):
// a returned pup isn't the family's any more either (K7-1), so it goes as `other`.
const VOID_REASON = { pup_died: 'died', failed_health_check: 'failed_health', buyer_backed_out: 'backed_out' };
export function voidedOf(sale, today) {
  if (sale.status === 'voided') return { reason: VOID_REASON[sale.end_reason] || 'other', on: saleEndDay(sale, today) };
  if (sale.status === 'cancelled') return { reason: 'backed_out', on: saleEndDay(sale, today) };
  if (sale.status === 'returned') return { reason: 'other', on: saleEndDay(sale, today) };
  return null;
}

// The day a released sale ended (its last edit, never after today), else null.
export function saleEndDay(sale, today) {
  if (!RELEASED_SALE_STATUSES.includes(sale?.status)) return null;
  const d = dayOf(sale.updated_at) || today;
  return d > today ? today : d;
}

// The puppy's shots, deworming (her preventatives) and vet visits, newest first:
// what was given and when. A vaccine's lot and next due date go as its notes; a
// vet visit's findings never go.
const HEALTH_TYPE = { vaccination: 'vaccine', preventative: 'deworming', vet_visit: 'vet_visit' };
export function healthOf(dogId, events, today) {
  return (events || []).filter((e) => !e.is_archived && e.subject_type === 'dog' && e.subject_id === dogId && HEALTH_TYPE[e.event_type] && ymd(e.event_date) && e.event_date <= today)
    .sort((a, b) => newestFirst(a.event_date, b.event_date) || String(a.id).localeCompare(String(b.id)))
    .slice(0, PORTAL_MAX.health)
    .map((e) => {
      const d = e.details || {};
      const name = e.event_type === 'vaccination' ? (line(d.vaccine, 120) || line(e.title, 120))
        : e.event_type === 'preventative' ? (line(d.product, 120) || line(e.title, 120))
          : (line(e.title, 120) || line(d.reason, 120));
      const notes = e.event_type === 'vaccination'
        ? line([d.lot_number ? `Lot ${line(d.lot_number, 40)}` : '', ymd(d.next_due) ? `next due ${d.next_due}` : ''].filter(Boolean).join(', '), 400)
        : null;
      return assertOnlyKeys({ id: String(e.id), type: HEALTH_TYPE[e.event_type], given_on: e.event_date, name: name || 'Health record', notes }, HEALTH_KEYS, 'health');
    });
}

// The extras on the sale she has on her price list (the website bundle sends
// each by its list id), never an amount.
export function extrasOf(sale) {
  return saleExtraCharges(sale).filter((x) => x.id && x.list_id).slice(0, PORTAL_MAX.extras)
    .map((x) => assertOnlyKeys({ id: String(x.id).slice(0, 80), extra_id: String(x.list_id).slice(0, 80) }, EXTRA_KEYS, 'extra'));
}

// Her vet, for the portal's contacts for families: the Vet contact she names most
// on her own dogs' vet visits and surgeries, else her only Vet contact. Its name
// goes as the clinic, with its phone and address. → null when there's no telling.
export function herVet({ kennel, contacts = [], events = [], dogsById }) {
  const vets = contacts.filter((c) => c && !c.is_archived && Array.isArray(c.contact_type) && c.contact_type.includes('vet'));
  if (!vets.length) return null;
  const ids = new Set(vets.map((c) => c.id));
  const uses = new Map();
  for (const e of events) {
    if (e.is_archived || !['vet_visit', 'surgery'].includes(e.event_type) || !ids.has(e.related_contact_id)) continue;
    if (dogsById.get(e.subject_id)?.kennel_id !== kennel.id) continue;
    uses.set(e.related_contact_id, (uses.get(e.related_contact_id) || 0) + 1);
  }
  const ranked = [...uses.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  const vet = ranked.length ? vets.find((c) => c.id === ranked[0][0]) : (vets.length === 1 ? vets[0] : null);
  if (!vet) return null;
  const out = { clinic: line(vet.name, 120), doctor: null, phone: line(vet.phone, 40), address: line(vet.address, 200) };
  return Object.values(out).some(Boolean) ? assertOnlyKeys(out, VET_KEYS, 'vet') : null;
}

// A family's addresses: their contact's, then those they applied with on her
// waitlist, lower case, at most PORTAL_MAX.emails.
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
function emailsOf(contact, entries) {
  const all = [contact.email, ...entries.map((e) => e.application?.email)].map((e) => String(e ?? '').trim().toLowerCase()).filter((e) => e.length <= 254 && EMAIL.test(e));
  return [...new Set(all)].slice(0, PORTAL_MAX.emails);
}

// Their status page: the newest of their records on her list with one.
function statusTokenOf(entries) {
  return [...entries].filter((e) => e.status_token).sort((a, b) => newestFirst(a.applied_date || a.created_at, b.applied_date || b.created_at))[0]?.status_token || null;
}

// The last day a placement still changes: its go-home, its sale's or contract's
// last edit, whichever is latest.
function lastDay(sale, contract, goHome) {
  return [goHome, dayOf(sale.updated_at), dayOf(contract?.updated_at), contract?.signed_date].filter(Boolean).sort().pop() || null;
}

// --- the feed ----------------------------------------------------------------------

// → { feed, known }: the feed to send, and every family, placement and health
// record it stands for now (sent or not), to pass back as `known` next time so
// what has gone since goes as `removed`.
// `statusUrlOf(token)`: the family's status page address (https), or null.
export function buildPortalFeed({
  kennel, sales = [], contracts = [], dogs = [], contacts = [], events = [], entries = [], litters = [],
  today, feedId, sentAt = null, statusUrlOf = () => null, known = []
}) {
  if (!kennel?.id) throw new Error('buildPortalFeed needs a kennel.');
  if (!ymd(today)) throw new Error('buildPortalFeed needs today.');
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const contactsById = new Map(contacts.map((c) => [c.id, c]));
  const tz = kennel.time_zone || null;
  const live = portalSales({ kennel, sales, contracts, dogsById, contactsById, known });

  const byFamily = new Map();
  const now = [];
  for (const { sale, contract } of live) {
    const pup = dogsById.get(sale.dog_id);
    const litter = litters.find((l) => l.id === pup.litter_id) || null;
    const pickup = pickupEventFor(sale, events, today);
    const goHome = pickup?.event_date || pickupFrom(sale, litter, events) || null;
    const clock = pickup ? parseClock(pickup.details?.placement_time) : null;
    const released = RELEASED_SALE_STATUSES.includes(sale.status);
    // A released sale's health stops at its end (K7-1): a returned pup's next home's
    // vet visits never reach this family.
    const health = healthOf(pup.id, events, released ? saleEndDay(sale, today) : today);
    const keep = (!released && sale.status !== 'delivered')
      || addDaysToYMD(lastDay(sale, contract, goHome) || today, PORTAL_KEEP_DAYS) >= today;
    // A released placement that has aged out isn't left in the portal: it stops being
    // `now`, so it goes in `removed` (K7-1).
    if (released && !keep) continue;
    now.push({ type: 'placement', id: sale.id }, ...health.map((h) => ({ type: 'health', id: h.id })));
    const placement = assertOnlyKeys({
      id: String(sale.id),
      puppy_id: String(pup.id),
      puppy_name: line(pup.call_name, 60) || line(pup.registered_name, 60) || 'Puppy',
      // A sale the feed sent whose contract has since gone: the date it was sent with.
      contract_signed_on: contract?.signed_date || known.find((k) => k.type === 'placement' && k.id === sale.id)?.signed_on || dayOf(sale.created_at) || today,
      go_home_on: ymd(goHome),
      pickup_at: pickup && clock ? zonedIso(pickup.event_date, clock, tz) : null,
      microchip: line(pup.microchip_id, 40),
      registration_no: line(pup.registration_number, 40),
      voided: voidedOf(sale, today) ? assertOnlyKeys(voidedOf(sale, today), VOIDED_KEYS, 'voided') : null,
      health,
      extras: extrasOf(sale)
    }, PLACEMENT_KEYS, 'placement');
    const fam = byFamily.get(sale.buyer_contact_id) || { placements: [], keep: false, newest: '' };
    fam.placements.push({ placement, keep, at: contract?.signed_date || placement.contract_signed_on });
    fam.keep = fam.keep || keep;
    if (placement.contract_signed_on > fam.newest) fam.newest = placement.contract_signed_on;
    byFamily.set(sale.buyer_contact_id, fam);
  }

  const kennelEntries = entries.filter((e) => e && !e.is_archived && e.kennel_id === kennel.id);
  const families = [];
  for (const [contactId, fam] of [...byFamily.entries()].sort((a, b) => newestFirst(a[1].newest, b[1].newest) || String(a[0]).localeCompare(String(b[0])))) {
    now.push({ type: 'family', id: contactId });
    if (!fam.keep || families.length >= PORTAL_MAX.families) continue;
    const contact = contactsById.get(contactId);
    const theirs = kennelEntries.filter((e) => e.contact_id === contactId);
    const token = statusTokenOf(theirs);
    const url = token ? statusUrlOf(token) : null;
    families.push(assertOnlyKeys({
      id: String(contactId),
      name: line(contact.name, 120) || 'Family',
      emails: emailsOf(contact, theirs),
      status_url: url && /^https:\/\//i.test(url) ? url : null,
      placements: fam.placements.filter((p) => p.keep).sort((a, b) => newestFirst(a.at, b.at)).slice(0, PORTAL_MAX.placements).map((p) => p.placement)
    }, FAMILY_KEYS, 'family'));
  }

  // Gone since last time: sent before, not here now (a sale or event deleted or
  // archived, a contract no longer signed).
  const here = new Set(now.map((k) => `${k.type}:${k.id}`));
  const removed = known.filter((k) => !here.has(`${k.type}:${k.id}`)).slice(0, PORTAL_MAX.removed)
    .map((k) => assertOnlyKeys({ type: k.type, id: String(k.id) }, REMOVED_KEYS, 'removed'));

  const vet = herVet({ kennel, contacts, events, dogsById });
  const feed = assertOnlyKeys({
    format: PORTAL_FEED_FORMAT,
    feed_id: String(feedId || ''),
    kennel_id: String(kennel.id),
    sent_at: sentAt,
    families,
    vet,
    removed
  }, FEED_KEYS, 'feed');
  if (!feed.sent_at) delete feed.sent_at;
  if (!feed.vet) delete feed.vet;
  // What it stands for, with the signed date each placement went with.
  const signedOn = new Map(families.flatMap((f) => f.placements.map((p) => [p.id, p.contract_signed_on])));
  const nowKnown = now.map((k) => (k.type === 'placement' && signedOn.has(k.id) ? { ...k, signed_on: signedOn.get(k.id) } : k));
  return { feed, known: nowKnown };
}

// A feed as kept for comparing: without its id and time, which differ each send.
export const feedCopy = ({ feed_id: _id, sent_at: _at, ...rest }) => rest;

// --- the status page's side (plan 3.4, steps 2 and 3) ------------------------------

// For one family record on her list, while her portal is on: whether their status
// page offers the one-tap link to the portal, and whether it shows only that.
// Their record's own sale (placed, else open), signed and not ended. → null, or
// { family_id (their contact: the portal knows them by it), only, pickup_on }.
// `only`: the portal took over (she marked the pup picked up: `home`), the sale is
// Delivered, or the pickup day has passed; the server also switches on its own
// once `pickup_on` passes.
export function portalEntryView(entry, { sale, contracts = [], events = [], home = [], today }) {
  if (!entry?.contact_id || !sale || sale.is_archived || RELEASED_SALE_STATUSES.includes(sale.status)) return null;
  if (sale.buyer_contact_id !== entry.contact_id || !signedContractFor(sale, contracts)) return null;
  const pickupOn = pickupEventFor(sale, events, today)?.event_date || null;
  const only = home.includes(entry.contact_id) || sale.status === 'delivered' || Boolean(pickupOn && pickupOn < today);
  return { family_id: entry.contact_id, only, pickup_on: pickupOn };
}

// Is her portal on for this kennel (Kennel.kennelport_portal, from the site's last
// answer)? Companion and Furever are off for her families then.
export const portalOn = (kennel) => Boolean(kennel?.kennelport_portal?.handoff_url && kennel.kennelport_portal.handoff_key);
