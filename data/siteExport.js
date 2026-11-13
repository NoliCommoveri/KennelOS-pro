// siteExport.js — what her KennelPort website is sent when she presses Update
// website (KennelPort plan 5.3, 5.5; End-State guide §35). PURE: plain records in,
// one plain object out; no Dexie, no DOM, no clock (callers pass `today`), like
// waitlistProjection.js. kennelportLink.js gathers the records and sends it.
//
// The bundle is KennelPort's format 1 (KennelPort's worker/src/kennelos/bundle.js
// lists every key it takes and refuses any other). It is built FIELD BY FIELD from
// allow-lists, like companionExport.js: no buyer, contact, note, contract or sale
// ever goes, and a new field on a dog or litter never reaches the website until
// it's added here on purpose. assertOnlyKeys checks every object before it leaves.
//
// What goes, and nothing else:
//  - Only records she marked Show on website (Dog, Pairing, Litter), and planned
//    heats only for a dam with heats_online. A litter with no mark of its own
//    follows its pairing's, so a page can't drop off the site at whelping.
//  - The marks and dates she set, never a status worked out from her records
//    (KennelPort decision 30): a litter's place on the site comes from its whelp
//    and deposits dates there. A puppy's status is her disposition, read with the
//    same rules as her waitlist (isPupAvailable's dispositions).
//  - Prices (a litter's expected prices and her extras' amounts, private in
//    KennelOS) only while her site has Use my KennelOS prices on (`prices`).
//  - Lengths are cut to what KennelPort takes, so one long name never makes the
//    website refuse the whole update.
//  - Co-owned dogs (KennelPort's docs/Co_Owned_Dogs_Plan.md), to a Worker that
//    takes 'partner_kennels': whether each is co-owned and lives with a co-owner
//    (lives_with_contact_id), and its co-owners' kennels, only outside kennels she
//    ticked Name this kennel on my website, by name and website. Never a co-owner
//    as a person: no name, email, phone, address, contract or money.
//  - Raw values for KennelPort's rules (KennelPort's docs/plans/kennelos-contract.md,
//    Part C; docs/KennelOS_Website_Contract_Plan.md), each only to a Worker whose
//    answer lists its section: a litter puppy's `disposition` as she set it
//    (pup_disposition), a litter's `status` (litter_status), a health result's
//    event `type` (health_detail), an account's `account_type` (account_type), and a
//    dog's `titles` as [{ abbr, organization, date }] in place of the bare
//    abbreviations (titles_detail).
//  - Origin and lineage (contract C4, C7): a dog's `imported` and `import_country`
//    as she set them (origin), and its `breed`, `sire_id`, `dam_id` and `ancestors`
//    to four generations (lineage). Ancestors go by name and titles only, pedigree-
//    only dogs and dogs that aren't hers included: never an owner, a contact, a
//    kennel or a date of birth. Import-descended is KennelPort's to work out from
//    the ancestors' `imported` (sent on each with both sections).
//  - Her waitlist's settings as values (contract C9, waitlist_facts section), for
//    the website's own wording: `steps` and `payment` still go beside them.
//    The worked-out values they replace (a puppy's `status`, a product's
//    `transport`) keep going until KennelPort has moved.
import { titlesByDog } from './waitlistProjection.js';
import { completedTestsByDog } from './healthTestLog.js';
import { waitlistConfig, waitlistIsSetUp } from './waitlistRules.js';
import { feePay } from './waitlistFeePay.js';
import { kennelChargeList } from './extraCharges.js';
import { addDaysToYMD } from './dateUtils.js';
import { DISPOSITION, ACCOUNT_TYPE } from './vocab.js';
import { ancestorsOf, MAX_GENERATIONS } from './pedigreeWalk.js';

export const SITE_BUNDLE_FORMAT = 1;

// KennelPort's caps (bundle.js MAX). Over one, the website would refuse the whole
// bundle, so siteExport says so first, in words.
export const SITE_MAX = { dogs: 200, litters: 100, puppies: 30, pairings: 50, heats: 50, health: 60, extras: 100, products: 50, steps: 20, titles: 20, partner_kennels: 50, co_owner_kennels: 10, ancestors: 30 };

// The website's own heat rules (KennelPort plan 5.3), not the public list's.
export const HEAT_KEEP_DAYS = 60; // a heat no pairing uses stays this long after its date
export const HEAT_USE_BEFORE_DAYS = 30; // a pairing planned from this long before a heat…
export const HEAT_USE_AFTER_DAYS = 60; // …to this long after it uses that heat

export const LIVE_LITTER_STATUSES = ['expected', 'whelped', 'weaning', 'ready'];
export const LIVE_PAIRING_STATUSES = ['planned', 'bred', 'confirmed_pregnant'];
const DEAD_PAIRING_STATUSES = ['failed', 'cancelled'];

// Dog status → the website's word for it. Pet home and External reference have
// none: such a dog isn't sent, so it leaves the site.
const DOG_STATUS = { puppy: 'puppy', active_breeding: 'active_breeding', for_sale: 'for_sale', retired_breeding: 'retired_breeding', deceased: 'deceased' };
const SEXES = ['female', 'male'];
const REGISTRATIONS = ['limited', 'full'];

export class SiteExportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SiteExportError';
  }
}

// --- the allow-lists ----------------------------------------------------------

export const BUNDLE_KEYS = ['format', 'bundle_id', 'kennel_id', 'sent_at', 'waitlist_public_id', 'dogs', 'litters', 'pairings', 'heats', 'extras', 'products', 'steps', 'payment', 'partner_kennels', 'waitlist_facts'];
export const WAITLIST_FACT_KEYS = ['online_form', 'has_fee', 'fee_due_days', 'respond_days', 'max_passes'];
export const PRODUCT_KEYS = ['id', 'name', 'link_url', 'code', 'code_note'];
// With a Worker that takes the 'transport' section: whether it's a transport
// service (for her Getting your pup home page) and its website (shown under its badge).
export const PRODUCT_TRANSPORT_KEYS = [...PRODUCT_KEYS, 'website', 'transport'];
export const DOG_KEYS = ['id', 'call_name', 'registered_name', 'sex', 'date_of_birth', 'color', 'status', 'died_on', 'titles', 'health'];
// `registry` (a dog's and a puppy's, "AKC"…) goes only to a Worker whose answer
// lists the 'registry' section: an older one refuses a field it doesn't know.
const withRegistry = (keys, on) => (on ? [...keys, 'registry'] : keys);
const registryOf = (d, on) => (on ? { registry: line(d.registry, 30) } : {});
// `disposition` (a puppy-status dog's: keeping, available, placed, health_hold,
// undecided) goes only to a Worker whose answer lists the 'disposition' section. The
// website doesn't show it: its owner's rule picks which puppies go on the site by it.
const withDisposition = (keys, on) => (on ? [...keys, 'disposition'] : keys);
const dispositionOf = (d, on) => (on && d.status === 'puppy' ? { disposition: d.disposition || 'undecided' } : {});
// `heat_id` (on a pairing and a litter: the heat it uses, so the website litter
// made from that heat carries on as the pairing's, with its photos, wording and
// address) goes only to a Worker whose answer lists the 'heat_id' section.
const withHeat = (keys, on) => (on ? [...keys, 'heat_id'] : keys);
// A dog's co-owned fields and the kennels they name go only to a Worker whose
// answer lists the 'partner_kennels' section.
export const CO_OWNED_KEYS = ['co_owned', 'lives_away', 'lives_with_kennel_id', 'co_owner_kennel_ids'];
export const PARTNER_KENNEL_KEYS = ['id', 'name', 'website'];
const withCoOwned = (keys, on) => (on ? [...keys, ...CO_OWNED_KEYS] : keys);
export const HEALTH_KEYS = ['id', 'test', 'result', 'normal', 'date'];
export const TITLE_KEYS = ['abbr', 'organization', 'date'];
export const ORIGIN_KEYS = ['imported', 'import_country'];
export const LINEAGE_KEYS = ['breed', 'sire_id', 'dam_id', 'ancestors'];
export const ANCESTOR_KEYS = ['id', 'path', 'call_name', 'registered_name', 'titles'];
// The raw-value sections (contract Part C). Each adds one key where it's named.
const has = (sections, s) => Array.isArray(sections) && sections.includes(s);
const plus = (keys, key, on) => (on ? [...keys, key] : keys);
const DISPOSITIONS = DISPOSITION.map((d) => d.value);
const ACCOUNT_TYPES = ACCOUNT_TYPE.map((t) => t.value);
export const LITTER_KEYS = ['id', 'pairing_id', 'name', 'dam_id', 'sire_id', 'dam_name', 'sire_name', 'expected_on', 'born_on', 'ready_on', 'deposits_on', 'prices', 'puppies'];
export const PRICE_KEYS = ['price_female', 'price_male', 'full_reg_female', 'full_reg_male', 'deposit_female', 'deposit_male'];
export const PUPPY_KEYS = ['id', 'name', 'sex', 'color', 'registration', 'status'];
export const PAIRING_KEYS = ['id', 'dam_id', 'sire_id', 'dam_name', 'sire_name', 'planned_on', 'expected_on'];
export const HEAT_KEYS = ['id', 'dam_id', 'dam_name', 'month'];
export const EXTRA_KEYS = ['id', 'name', 'group', 'description', 'price_from', 'price_to'];
export const STEP_KEYS = ['id', 'heading', 'body'];
export const PAYMENT_KEYS = ['application_fee'];
export const PAY_KEYS = ['title', 'due_note', 'note', 'pay_url', 'pay_label'];

// Positive allow-list check: abort the send rather than emit a superset.
function assertOnlyKeys(obj, allowed, ctx) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new Error(`Website bundle (${ctx}) has unexpected key "${k}". Nothing was sent.`);
  }
  return obj;
}

// --- small cleaners -----------------------------------------------------------

// One line of text, cut to `max` characters; null when blank.
export function line(v, max) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max).trim() : null;
}
// Text that keeps its line breaks, cut to `max`; null when blank.
function para(v, max) {
  const s = String(v ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return s ? s.slice(0, max).trim() : null;
}
const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? v : null);
// A whole number of dollars the website takes (0 to 100,000), else null.
function money(v) {
  if (v === '' || v == null) return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= 100000 ? n : null;
}
const dogName = (d) => line(d?.call_name || d?.registered_name, 60);
// A web address KennelPort takes (http or https), else null; "oakridge.com" reads
// as https://oakridge.com/.
export function webAddress(v) {
  const s = line(v, 500);
  if (!s) return null;
  for (const t of [s, `https://${s}`]) {
    try {
      const u = new URL(t);
      if ((u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.')) return u.toString();
    } catch { /* try the next */ }
  }
  return null;
}
const isMarked = (r) => r?.show_on_website === true;

// --- dogs ---------------------------------------------------------------------

// Each dog's titles with their organization and date (titles_detail section), from
// her title_earned events, in the order earned. The same title from the same
// organization counts once, at its first date; the same abbreviation from two
// organizations is two titles. → Map(dogId → [{ abbr, organization, date }]).
export function titleDetailsByDog(events = []) {
  const out = new Map();
  const earned = events
    .filter((ev) => ev && ev.event_type === 'title_earned' && ev.subject_type === 'dog' && !ev.is_archived && line(ev.details?.title_abbreviation, 30))
    .sort((a, b) => String(a.event_date || '').localeCompare(String(b.event_date || '')) || String(a.id).localeCompare(String(b.id)));
  const seen = new Set();
  for (const ev of earned) {
    const abbr = line(ev.details.title_abbreviation, 30);
    const organization = line(ev.details.organization, 60);
    const k = `${ev.subject_id}|${abbr.toLowerCase()}|${(organization || '').toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const list = out.get(ev.subject_id) || [];
    list.push(assertOnlyKeys({ abbr, organization, date: ymd(ev.event_date) }, TITLE_KEYS, 'title'));
    out.set(ev.subject_id, list);
  }
  return out;
}

// --- co-owned dogs --------------------------------------------------------------

// The kennel a contact belongs to, as the website may name it: an outside kennel,
// not archived, with a name, that she ticked Name this kennel on my website.
export function namedKennelOf(contactId, { contactsById, kennelsById }) {
  const k = kennelsById.get(contactsById.get(contactId)?.kennel_id);
  return k && !k.is_own_kennel && !k.is_archived && k.name_on_website === true && line(k.kennel_name, 80) ? k : null;
}

// A dog's co-owned fields for the website. lives_away: it lives with one of its
// co-owners now (lives_with_contact_id), not with her; then it shows only in the
// website's Co-owned section. The kennels are its co-owners' named ones, the one
// it lives with first. → { co_owned, lives_away, lives_with_kennel_id, co_owner_kennel_ids }
export function coOwnership(dog, maps) {
  const coOwners = dog.ownership_type === 'co_owned' ? (dog.co_owner_contact_ids || []) : [];
  const co_owned = dog.ownership_type === 'co_owned';
  const lives_away = co_owned && Boolean(dog.lives_with_contact_id) && coOwners.includes(dog.lives_with_contact_id);
  const home = lives_away ? namedKennelOf(dog.lives_with_contact_id, maps) : null;
  const ids = [...new Set([home?.id, ...coOwners.map((c) => namedKennelOf(c, maps)?.id)].filter(Boolean))].slice(0, SITE_MAX.co_owner_kennels);
  return { co_owned, lives_away, lives_with_kennel_id: home?.id ?? null, co_owner_kennel_ids: ids };
}

// The kennels those dogs name, by public name and website only.
function partnerKennelEntries(entries, kennelsById) {
  const ids = [...new Set(entries.flatMap((d) => d.co_owner_kennel_ids || []))];
  return ids.map((id) => {
    const k = kennelsById.get(id);
    return assertOnlyKeys({ id: k.id, name: line(k.kennel_name, 80), website: webAddress(k.website) }, PARTNER_KENNEL_KEYS, 'partner kennel');
  });
}

// Imported, and the country only while it's ticked (origin section).
const originOf = (d) => {
  const imported = d.imported === true;
  return { imported, import_country: imported ? line(d.import_country, 60) : null };
};

// A dog's titles as sent: the detail objects (titles_detail) or the abbreviations.
const titlesSent = (titles, id, detail) => (detail
  ? (titles.get(id) || []).slice(0, SITE_MAX.titles)
  : (titles.get(id) || []).map((t) => line(t, 30)).filter(Boolean).slice(0, SITE_MAX.titles));

// A dog's lineage (lineage section): its breed, parents' ids, and its ancestors to
// four generations, nearest first, by name and titles only; with the origin
// section each ancestor also says whether it was imported.
function lineageOf(dog, { dogsById, titles, titlesDetail, origin }) {
  const ancestors = ancestorsOf(dog, dogsById, { generations: MAX_GENERATIONS }).slice(0, SITE_MAX.ancestors).map(({ dog: a, path }) => assertOnlyKeys({
    id: a.id,
    path,
    call_name: line(a.call_name, 40),
    registered_name: line(a.registered_name, 120),
    titles: titlesSent(titles, a.id, titlesDetail),
    ...(origin ? originOf(a) : {})
  }, origin ? [...ANCESTOR_KEYS, ...ORIGIN_KEYS] : ANCESTOR_KEYS, 'ancestor'));
  return { breed: line(dog.breed, 60), sire_id: dog.sire_id || null, dam_id: dog.dam_id || null, ancestors };
}

function dogEntry(dog, titles, tests, registry = false, coOwned = null, disposition = false, healthType = false, titlesDetail = false, lineage = null, origin = false) {
  const done = (tests.get(dog.id) || []).slice(0, SITE_MAX.health);
  return assertOnlyKeys({
    id: dog.id,
    call_name: line(dog.call_name || dog.registered_name, 40),
    registered_name: line(dog.registered_name, 120),
    ...registryOf(dog, registry),
    sex: dog.sex,
    date_of_birth: ymd(dog.date_of_birth),
    color: line(dog.color_markings, 40),
    status: DOG_STATUS[dog.status],
    died_on: dog.status === 'deceased' ? ymd(dog.date_of_death) : null,
    // A Worker that takes titles_detail gets each title as { abbr, organization,
    // date } (`titles` is then the detail map); an older one the abbreviations.
    titles: titlesSent(titles, dog.id, titlesDetail),
    // A test's id is its name, so a retest updates the same result on the website
    // (and keeps her Show on site tick there).
    health: done.map((t) => assertOnlyKeys({
      id: `test:${t.name.trim().toLowerCase()}`.slice(0, 80),
      test: line(t.name, 60),
      result: line(t.result, 60),
      // Marked Normal: true; Abnormal: false; not marked: null, which the website
      // counts as normal (only a result she marked Abnormal is kept off).
      normal: t.outcome === 'Normal' ? true : t.outcome === 'Abnormal' ? false : null,
      date: ymd(t.date),
      // Its KennelOS event type (genetic_test, ofa_pennhip, breed_specific_test), so
      // the website can group results (health_detail section).
      ...(healthType ? { type: t.type } : {})
    }, plus(HEALTH_KEYS, 'type', healthType), 'health')),
    ...(coOwned ? coOwnership(dog, coOwned) : {}),
    ...dispositionOf(dog, disposition),
    ...(origin ? originOf(dog) : {}),
    ...(lineage ? lineageOf(dog, { ...lineage, titles, titlesDetail, origin }) : {})
  }, [...withDisposition(withCoOwned(withRegistry(DOG_KEYS, registry), Boolean(coOwned)), disposition), ...(origin ? ORIGIN_KEYS : []), ...(lineage ? LINEAGE_KEYS : [])], 'dog');
}

// The dogs she shows: her own kennel's, marked, with a status the website has.
export function websiteDogs(kennel, dogs) {
  return dogs.filter((d) => !d.is_archived && !d.pedigree_only && d.kennel_id === kennel.id && isMarked(d)
    && DOG_STATUS[d.status] && SEXES.includes(d.sex) && (d.call_name || d.registered_name));
}

// --- puppies ------------------------------------------------------------------

// A puppy's status on the website (KennelPort plan 3.6): her disposition, as she
// set it, and nothing worked out. Placed is spoken for (an open sale, still here);
// a pup who has gone home is External and isn't sent. A waitlist pick with its
// deposit still owed leaves her Available. A litter closes (and leaves the site)
// at about 9 weeks, long before a kept pup moves on from Puppy, so her status
// field isn't read.
const DISPOSITION_ON_SITE = { available: 'available', placed: 'placed', keeping: 'staying', health_hold: 'hidden' };
export function puppyStatus(pup) {
  return DISPOSITION_ON_SITE[pup.disposition] ?? 'undecided';
}

function puppyEntries(litter, dogs, registry = false, rawDisposition = false) {
  return dogs
    .filter((d) => d.litter_id === litter.id && !d.is_archived && !['deceased', 'external_reference'].includes(d.status) && SEXES.includes(d.sex))
    .sort((a, b) => String(a.call_name || '').localeCompare(String(b.call_name || '')) || String(a.id).localeCompare(String(b.id)))
    .slice(0, SITE_MAX.puppies)
    .map((p) => assertOnlyKeys({
      id: p.id,
      name: line(p.call_name || p.registered_name, 40) || 'Puppy',
      sex: p.sex,
      color: line(p.color_markings, 40),
      registration: REGISTRATIONS.includes(p.intended_registration) ? p.intended_registration : null,
      status: puppyStatus(p),
      ...registryOf(p, registry),
      // Her disposition as she set it, null when none is set (pup_disposition
      // section): KennelPort's rule turns it into the site status.
      ...(rawDisposition ? { disposition: DISPOSITIONS.includes(p.disposition) ? p.disposition : null } : {})
    }, plus(withRegistry(PUPPY_KEYS, registry), 'disposition', rawDisposition), 'puppy'));
}

// --- litters and pairings -----------------------------------------------------

// A litter's mark: its own once set, else its pairing's (it inherits the mark at
// whelping, KennelPort plan 5.3).
export function litterMarked(litter, pairingsById) {
  if (typeof litter.show_on_website === 'boolean') return litter.show_on_website;
  return isMarked(litter.pairing_id ? pairingsById.get(litter.pairing_id) : null);
}

export function websiteLitters(kennel, litters, pairingsById) {
  return litters.filter((l) => !l.is_archived && l.kennel_id === kennel.id && LIVE_LITTER_STATUSES.includes(l.status) && litterMarked(l, pairingsById));
}

function litterPrices(litter) {
  return assertOnlyKeys({
    price_female: money(litter.expected_price_female),
    price_male: money(litter.expected_price_male),
    full_reg_female: money(litter.full_reg_surcharge_female),
    full_reg_male: money(litter.full_reg_surcharge_male),
    deposit_female: money(litter.expected_deposit_female),
    deposit_male: money(litter.expected_deposit_male)
  }, PRICE_KEYS, 'prices');
}

function litterEntry(litter, { dogsById, pairingsById, dogs, prices, registry, heatOf, litterStatus, rawDisposition }) {
  const pairing = litter.pairing_id ? pairingsById.get(litter.pairing_id) : null;
  const born = litter.status !== 'expected';
  return assertOnlyKeys({
    id: litter.id,
    pairing_id: litter.pairing_id || null,
    ...(heatOf ? { heat_id: (litter.pairing_id && heatOf.get(litter.pairing_id)) || null } : {}),
    name: line(litter.nickname, 80),
    dam_id: litter.dam_id || null,
    sire_id: litter.sire_id || null,
    dam_name: dogName(dogsById.get(litter.dam_id)),
    sire_name: dogName(dogsById.get(litter.sire_id)),
    expected_on: born ? null : ymd(pairing?.expected_due_date) || ymd(litter.whelp_date),
    born_on: born ? ymd(litter.whelp_date) : null,
    ready_on: born ? ymd(litter.estimated_ready_date) : null,
    deposits_on: ymd(litter.accept_deposits_date),
    // Its status as she set it (litter_status section): only live ones are sent.
    ...(litterStatus ? { status: litter.status } : {}),
    prices: prices ? litterPrices(litter) : null,
    puppies: puppyEntries(litter, dogs, registry, rawDisposition)
  }, plus(withHeat(LITTER_KEYS, Boolean(heatOf)), 'status', litterStatus), 'litter');
}

// Pairings she shows under Coming up: marked, still on their way, and not yet a
// litter (the litter carries on from there, with the pairing's page).
export function websitePairings(kennel, pairings, litters) {
  const hasLitter = new Set(litters.filter((l) => !l.is_archived && l.pairing_id).map((l) => l.pairing_id));
  return pairings.filter((p) => !p.is_archived && p.kennel_id === kennel.id && isMarked(p) && LIVE_PAIRING_STATUSES.includes(p.status) && !hasLitter.has(p.id));
}

const pairingEntry = (p, dogsById, heatOf) => assertOnlyKeys({
  id: p.id,
  ...(heatOf ? { heat_id: heatOf.get(p.id) || null } : {}),
  dam_id: p.dam_id || null,
  sire_id: p.sire_id || null,
  dam_name: dogName(dogsById.get(p.dam_id)),
  sire_name: dogName(dogsById.get(p.sire_id)),
  planned_on: ymd(p.planned_date),
  expected_on: ymd(p.expected_due_date)
}, withHeat(PAIRING_KEYS, Boolean(heatOf)), 'pairing');

// --- heats --------------------------------------------------------------------

const dayNumber = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86400000);

// Her planned heats as the website shows them (KennelPort plan 5.3): each
// heat_cycle event of a dam of this kennel with heats_online on, from 60 days ago
// on, one per dam per month, less the heats a pairing has used. A pairing of the
// same dam (not failed or cancelled) uses the nearest heat whose date its
// planned_date (else the day it was entered) falls from 30 days before to 60 days
// after; each pairing uses at most one. A used heat leaves: the pairing's own
// entry, or its litter's, takes over. → [{ id, dam_id, month }], soonest first.
export function websiteHeats(kennel, opts) {
  const { heats, heatOf } = heatUse(kennel, opts);
  const used = new Set(heatOf.values());
  return heats.filter((h) => !used.has(h.id)).map((h) => ({ id: h.id, dam_id: h.subject_id, month: h.event_date.slice(0, 7) }));
}

// The heats the website could show, and which one each pairing uses (by the rules
// above): → { heats: [heat_cycle events], heatOf: Map(pairing id → heat id) }.
export function heatUse(kennel, { dogs = [], events = [], pairings = [], today }) {
  const dams = new Map(dogs.filter((d) => !d.is_archived && d.kennel_id === kennel.id && d.sex === 'female' && d.heats_online === true).map((d) => [d.id, d]));
  const from = addDaysToYMD(today, -HEAT_KEEP_DAYS);
  const seen = new Set();
  const heats = [];
  for (const ev of events
    .filter((e) => e.event_type === 'heat_cycle' && e.subject_type === 'dog' && !e.is_archived && dams.has(e.subject_id) && ymd(e.event_date) && e.event_date >= from)
    .sort((a, b) => a.event_date.localeCompare(b.event_date) || String(a.id).localeCompare(String(b.id)))) {
    const k = `${ev.subject_id}|${ev.event_date.slice(0, 7)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    heats.push(ev);
  }
  const heatOf = new Map();
  for (const p of pairings.filter((x) => !x.is_archived && dams.has(x.dam_id) && !DEAD_PAIRING_STATUSES.includes(x.status))) {
    const when = ymd(p.planned_date) || ymd(String(p.created_at || '').slice(0, 10));
    if (!when) continue;
    const at = dayNumber(when);
    let best = null;
    for (const h of heats) {
      if (h.subject_id !== p.dam_id) continue;
      const gap = at - dayNumber(h.event_date);
      if (gap < -HEAT_USE_BEFORE_DAYS || gap > HEAT_USE_AFTER_DAYS) continue;
      if (!best || Math.abs(gap) < best.gap) best = { h, gap: Math.abs(gap) };
    }
    if (best) heatOf.set(p.id, best.h.id);
  }
  return { heats, heatOf };
}

// --- the waitlist's part: steps, How to pay -----------------------------------

const plural = (n, word) => `${n} ${word}${Number(n) === 1 ? '' : 's'}`;

// The steps her waitlist actually runs (KennelPort plan 3.11), from her settings,
// for How it works. The website keeps the wording hers to change. Amounts never
// go: they follow the website's prices rule. [] before her waitlist is set up.
export function waitlistSteps(kennel) {
  if (!waitlistIsSetUp(kennel)) return [];
  const c = waitlistConfig(kennel);
  const fee = Number(c.fee_amount) > 0;
  const steps = [
    { id: 'apply', heading: 'Apply', body: `Send us your application${c.online && c.online_form ? ' online' : ''}.${fee ? ' There is an application fee.' : ''}` },
    { id: 'approved', heading: 'Join our list', body: `Once we approve your application${fee ? ` and your fee is in${c.fee_due_days ? ` (within ${plural(c.fee_due_days, 'day')} of approval)` : ''}` : ''}, you have your place on our list.` },
    { id: 'turn', heading: 'Your turn', body: `When a litter matches your choices and your turn comes, we offer you a puppy. You have ${plural(c.respond_days, 'day')} to accept and send your deposit.${c.max_passes ? ` You can pass ${c.max_passes === 1 ? 'once' : `up to ${c.max_passes} times`} and keep your place.` : ''}` }
  ];
  return steps.map((s) => assertOnlyKeys({ id: s.id, heading: line(s.heading, 80), body: para(s.body, 400) }, STEP_KEYS, 'step'));
}

// Her waitlist's settings as values (waitlist_facts section), the same ones
// waitlistSteps words: whether she takes applications online (only while her list is
// online), whether there's an application fee (never its amount: prices follow the
// website's prices rule), the days to pay it after approval, the days to accept an
// offer and send the deposit, and the passes before removal. A count she hasn't set
// is null. null before her waitlist is set up.
const count = (v) => (Number.isInteger(Number(v)) && Number(v) >= 1 && v !== '' && v != null ? Number(v) : null);
export function waitlistFacts(kennel) {
  if (!waitlistIsSetUp(kennel)) return null;
  const c = waitlistConfig(kennel);
  return assertOnlyKeys({
    online_form: c.online === true && c.online_form === true,
    has_fee: Number(c.fee_amount) > 0,
    fee_due_days: count(c.fee_due_days),
    respond_days: count(c.respond_days),
    max_passes: count(c.max_passes)
  }, WAITLIST_FACT_KEYS, 'waitlist facts');
}

// How to pay the application fee (KennelPort plan 3.9), from her waitlist's
// payment instructions and the fee account's Pay link: the same words families
// read on their status pages. null when there's nothing to say. Instructions
// longer than the website's note (200 characters) aren't cut, since a cut-off
// payment detail is worse than none: she types them in KennelPort instead.
export function applicationFeePay(kennel, accounts = []) {
  const c = waitlistConfig(kennel);
  const note = line(c.payment_instructions, 1000);
  const pay = feePay(kennel, accounts, c.fee_amount);
  const out = {
    title: 'Application fee',
    due_note: c.fee_due_days ? `Within ${plural(c.fee_due_days, 'day')} of approval.` : null,
    note: note && note.length <= 200 ? note : null,
    pay_url: pay?.url || null,
    pay_label: pay?.url ? 'Pay the application fee' : null
  };
  if (!out.note && !out.pay_url) return null;
  return assertOnlyKeys(Object.fromEntries(Object.entries(out).filter(([, v]) => v != null)), PAY_KEYS, 'payment');
}

// --- extras -------------------------------------------------------------------

function extraEntries(kennel, prices) {
  return kennelChargeList(kennel).slice(0, SITE_MAX.extras).map((x) => {
    const amount = prices ? money(x.amount) : null;
    return assertOnlyKeys({
      id: String(x.id).slice(0, 80),
      name: line(x.label, 80) || 'Extra',
      group: line(x.group, 40),
      description: para(x.description, 600),
      price_from: amount,
      price_to: amount
    }, EXTRA_KEYS, 'extra');
  });
}

// --- recommended products ------------------------------------------------------

const webLink = (v) => {
  const s = String(v ?? '').trim();
  return s.length <= 500 && /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : null;
};

// Her Accounts marked Show on website, as the website's Recommended products: the
// name, the referral link (else the account's website), the code, and her
// instructions when they fit the line after the code (120 characters; longer ones
// aren't cut, she words them in KennelPort). Copied by name: never a login, a
// customer id, notes, fees, contract forms or payment details. Which accounts go
// (owner decision 2026-11-05): those marked with something to share (a referral
// link, code or instructions, `hasReferral`), and transport accounts marked even
// without one. Transport ones go only to a Worker that takes the 'transport'
// section (`transport: true`), flagged `transport` with their `website`: they show
// on her Getting your pup home page, never with her Recommended products. Accounts
// are program-wide, so every linked kennel's website gets the same ones.
const isTransportAccount = (a) => a.account_type === 'transport';
const siteAddress = (v) => {
  const s = String(v ?? '').trim();
  return webLink(s) || (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(s) ? webLink(`https://${s}`) : null);
};
export function websiteProducts(accounts = [], { transport = false, accountType = false } = {}) {
  return accounts
    .filter((a) => a && !a.is_archived && a.show_on_website === true && line(a.name, 80)
      && (isTransportAccount(a) ? transport : hasReferral(a)))
    .sort((x, y) => String(x.name).localeCompare(String(y.name), undefined, { sensitivity: 'base' }) || String(x.id).localeCompare(String(y.id)))
    .map((a) => {
      const note = line(a.referral_instructions, 1000);
      const out = {
        id: String(a.id).slice(0, 80),
        name: line(a.name, 80),
        link_url: webLink(a.referral_link) || siteAddress(a.website),
        code: line(a.referral_code, 40),
        code_note: note && note.length <= 120 ? note : null
      };
      // Its type as she set it, null when none (account_type section).
      const type = accountType ? { account_type: ACCOUNT_TYPES.includes(a.account_type) ? a.account_type : null } : {};
      if (!transport) return assertOnlyKeys({ ...out, ...type }, plus(PRODUCT_KEYS, 'account_type', accountType), 'product');
      return assertOnlyKeys({ ...out, website: siteAddress(a.website), transport: isTransportAccount(a), ...type }, plus(PRODUCT_TRANSPORT_KEYS, 'account_type', accountType), 'product');
    });
}

// --- the bundle ---------------------------------------------------------------

// What Kels's Update my website asks about before sending (End-State guide §35),
// in groups she ticks: records of this kennel that could be on the website and
// aren't marked, and marked born litters with no accept deposits date.
// - dogs: her own adults (breeding, retired, for sale) not marked;
// - keptPups: pups marked Keeping, not marked, whose litter isn't on the website any
//   more, so they'd be lost with it (the hand-over she missed);
// - litters / pairings: live ones not marked (a pairing only until it's a litter);
// - heats: her breeding girls whose coming heats don't show (heats_online off);
// - deposits: marked litters past Expected with no accept deposits date (blank
//   means available straight away). `marking`: ids she is about to mark, counted
//   as marked here;
// - accounts: ones with something to share (a referral link, code or
//   instructions) not marked, for Recommended products (never transport).
// - partnerKennels: outside kennels of a shown co-owned dog's co-owners she
//   hasn't ticked Name this kennel on my website for (asked, unticked to begin);
// - noKennel: shown dogs living with a co-owner who has no outside kennel, so the
//   website can't name where they live (said, not asked).
// → { dogs, keptPups, litters, pairings, heats, deposits, accounts, partnerKennels, noKennel }, each a list.
export const hasReferral = (a) => Boolean(line(a?.referral_link, 500) || line(a?.referral_code, 40) || line(a?.referral_instructions, 1000));
export function websiteGaps(kennel, { dogs = [], litters = [], pairings = [], accounts = [], contacts = [], kennels = [] }, { marking = [] } = {}) {
  const mine = (r) => !r.is_archived && r.kennel_id === kennel.id;
  const willMark = new Set(marking);
  const pairingsById = new Map(pairings.map((p) => [p.id, p]));
  const shownLitters = new Set(websiteLitters(kennel, litters, pairingsById).map((l) => l.id));
  const ownDog = (d) => mine(d) && !d.pedigree_only && SEXES.includes(d.sex) && (d.call_name || d.registered_name);
  const liveLitters = litters.filter((l) => mine(l) && LIVE_LITTER_STATUSES.includes(l.status));
  const hasLitter = new Set(litters.filter((l) => !l.is_archived && l.pairing_id).map((l) => l.pairing_id));
  return {
    dogs: dogs.filter((d) => ownDog(d) && !isMarked(d) && ['active_breeding', 'retired_breeding', 'for_sale'].includes(d.status)),
    keptPups: dogs.filter((d) => ownDog(d) && !isMarked(d) && d.status === 'puppy' && d.disposition === 'keeping' && d.litter_id && !shownLitters.has(d.litter_id)),
    litters: liveLitters.filter((l) => !litterMarked(l, pairingsById)),
    pairings: pairings.filter((p) => mine(p) && !isMarked(p) && LIVE_PAIRING_STATUSES.includes(p.status) && !hasLitter.has(p.id)),
    heats: dogs.filter((d) => ownDog(d) && d.sex === 'female' && d.status === 'active_breeding' && !d.heats_online),
    deposits: liveLitters.filter((l) => l.status !== 'expected' && !ymd(l.accept_deposits_date) && (litterMarked(l, pairingsById) || willMark.has(l.id))),
    accounts: accounts.filter((a) => a && !a.is_archived && !isMarked(a) && line(a.name, 80) && (hasReferral(a) || (isTransportAccount(a) && siteAddress(a.website)))),
    ...coOwnedGaps(kennel, dogs, contacts, kennels)
  };
}

function coOwnedGaps(kennel, dogs, contacts, kennels) {
  const contactsById = new Map(contacts.map((c) => [c.id, c]));
  const kennelsById = new Map(kennels.map((k) => [k.id, k]));
  const shown = websiteDogs(kennel, dogs).filter((d) => d.ownership_type === 'co_owned');
  const outside = (cid) => {
    const k = kennelsById.get(contactsById.get(cid)?.kennel_id);
    return k && !k.is_own_kennel && !k.is_archived && line(k.kennel_name, 80) ? k : null;
  };
  const unticked = new Map();
  for (const d of shown) for (const c of d.co_owner_contact_ids || []) {
    const k = outside(c);
    if (k && k.name_on_website !== true) unticked.set(k.id, k);
  }
  return {
    partnerKennels: [...unticked.values()],
    noKennel: shown.filter((d) => d.lives_with_contact_id && (d.co_owner_contact_ids || []).includes(d.lives_with_contact_id) && !outside(d.lives_with_contact_id))
  };
}

// What an Update website would change, as lines Kels can show: `before`, the
// bundle this device sent last; `after`, the one it would send now (each without
// its id and time). Records match by id within a section, as on KennelPort.
// → ["New litter: First Down", "Coach: Available → Spoken for", …], [] when the
// same.
const PUPPY_WORDS = { available: 'Available', placed: 'Spoken for', staying: 'Staying with us', undecided: 'Still deciding', hidden: 'Hidden' };
const DOG_WORDS = { puppy: 'up and coming', active_breeding: 'at home', for_sale: 'looking for a home', retired_breeding: 'retired', deceased: 'in memory' };
const FIELD_WORDS = {
  call_name: 'name', registered_name: 'registered name', registry: 'registry', sex: 'sex', date_of_birth: 'birthday', color: 'colour', died_on: 'date of death',
  titles: 'titles', health: 'health results', name: 'name', dam_id: 'dam', sire_id: 'sire', dam_name: 'dam', sire_name: 'sire',
  expected_on: 'expected date', born_on: 'birth date', ready_on: 'going-home date', deposits_on: 'deposits date', prices: 'prices',
  planned_on: 'planned date', month: 'month', pairing_id: 'pairing', registration: 'registration',
  co_owned: 'co-owned', co_owner_kennel_ids: 'co-owner kennels',
  imported: 'imported', import_country: 'country of origin', breed: 'breed', ancestors: 'pedigree'
};
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export function bundleChanges(before = {}, after = {}) {
  const out = [];
  const byId = (list) => new Map((list || []).map((r) => [r.id, r]));
  const fields = (a, b, skip = []) => [...new Set(Object.keys({ ...a, ...b }))].filter((k) => !skip.includes(k) && !same(a[k], b[k]));
  const words = (ks) => [...new Set(ks.map((k) => FIELD_WORDS[k] || k.replace(/_/g, ' ')))].join(', ');
  const litterName = (l) => l.name || (l.dam_name && l.sire_name ? `${l.dam_name} × ${l.sire_name}` : l.dam_name ? `${l.dam_name}'s litter` : 'a litter');
  const pairName = (p) => (p.dam_name && p.sire_name ? `${p.dam_name} × ${p.sire_name}` : p.dam_name || 'a pairing');

  const [d0, d1] = [byId(before.dogs), byId(after.dogs)];
  const kennelName = (id) => (after.partner_kennels || []).find((k) => k.id === id)?.name || 'a partner kennel';
  for (const [id, d] of d1) {
    const was = d0.get(id);
    if (!was) { out.push(`New dog: ${d.call_name}`); continue; }
    if (was.status !== d.status) out.push(`${d.call_name}: now ${DOG_WORDS[d.status] || d.status}`);
    // Where a co-owned dog lives moves it on the website.
    if ('lives_away' in d && (Boolean(was.lives_away) !== Boolean(d.lives_away) || (d.lives_away && (was.lives_with_kennel_id ?? null) !== (d.lives_with_kennel_id ?? null)))) {
      out.push(`${d.call_name}: now living ${d.lives_away ? `with ${kennelName(d.lives_with_kennel_id)}` : 'with you'}`);
    }
    const ks = fields(was, d, ['id', 'status', 'lives_away', 'lives_with_kennel_id']);
    if (ks.length) out.push(`${d.call_name}: ${words(ks)} changed`);
  }
  for (const [id, d] of d0) if (!d1.has(id)) out.push(`${d.call_name}: off the site`);

  const [l0, l1] = [byId(before.litters), byId(after.litters)];
  for (const [id, l] of l1) {
    const was = l0.get(id);
    if (!was) { out.push(`New litter: ${litterName(l)}${l.puppies?.length ? ` (${l.puppies.length} ${l.puppies.length === 1 ? 'puppy' : 'puppies'})` : ''}`); continue; }
    const ks = fields(was, l, ['id', 'heat_id', 'puppies']);
    if (ks.length) out.push(`${litterName(l)}: ${words(ks)} changed`);
    const [p0, p1] = [byId(was.puppies), byId(l.puppies)];
    for (const [pid, p] of p1) {
      const pw = p0.get(pid);
      if (!pw) { out.push(`${p.name}: new puppy in ${litterName(l)}`); continue; }
      if (pw.status !== p.status) out.push(`${p.name}: ${PUPPY_WORDS[pw.status] || pw.status} → ${PUPPY_WORDS[p.status] || p.status}`);
      const pk = fields(pw, p, ['id', 'status', 'disposition']); // her disposition is the status line above
      if (pk.length) out.push(`${p.name}: ${words(pk)} changed`);
    }
    for (const [pid, p] of p0) if (!p1.has(pid)) out.push(`${p.name}: off the site`);
  }
  for (const [id, l] of l0) if (!l1.has(id)) out.push(`${litterName(l)}: off the site`);

  const [q0, q1] = [byId(before.pairings), byId(after.pairings)];
  for (const [id, p] of q1) {
    const was = q0.get(id);
    if (!was) out.push(`New under Coming up: ${pairName(p)}`);
    else if (fields(was, p, ['id', 'heat_id']).length) out.push(`${pairName(p)}: ${words(fields(was, p, ['id', 'heat_id']))} changed`);
  }
  for (const [id, p] of q0) if (!q1.has(id)) out.push(`${pairName(p)}: off Coming up`);

  const [h0, h1] = [byId(before.heats), byId(after.heats)];
  for (const [id, h] of h1) if (!h0.has(id)) out.push(`Coming up: ${h.dam_name || 'a girl'}'s heat`);
  for (const [id, h] of h0) if (!h1.has(id)) out.push(`${h.dam_name || 'A girl'}'s heat: off Coming up`);

  const other = { extras: 'Extras', products: 'Recommended products', partner_kennels: 'Partner kennels', steps: 'How it works steps', payment: 'How to pay', waitlist_facts: 'Waitlist details', waitlist_public_id: 'Your waitlist link' };
  for (const [k, label] of Object.entries(other)) if (!same(before[k], after[k])) out.push(`${label} changed`);
  return out;
}

// What the website would be sent, before the caps check: the records she marked.
// kennelportLink.js shows these counts on the Website card.
export function websiteCounts(kennel, { dogs = [], litters = [], pairings = [], events = [], accounts = [], today }) {
  const pairingsById = new Map(pairings.map((p) => [p.id, p]));
  return {
    dogs: websiteDogs(kennel, dogs).length,
    litters: websiteLitters(kennel, litters, pairingsById).length,
    pairings: websitePairings(kennel, pairings, litters).length,
    heats: websiteHeats(kennel, { dogs, events, pairings, today }).length,
    products: websiteProducts(accounts).length
  };
}

// The bundle for ONE own kennel. `dogs`: every dog (filtered here); `events`: her
// title_earned, heat_cycle and health-test events; `prices`: the site's Use my
// KennelOS prices switch, from its last answer; `bundleId`: a new id per press
// (a retry of the same press reuses it); `sections`: the optional sections the
// site's Worker takes (its answer's `sections`), so an older one isn't sent a
// section it would refuse the whole bundle over. → the bundle, every key allow-listed.
export function buildSiteBundle({ kennel, dogs = [], litters = [], pairings = [], events = [], accounts = [], contacts = [], kennels = [], today, sentAt, bundleId, prices = false, sections = [] }) {
  if (!kennel || !kennel.id) throw new SiteExportError('Choose a kennel first.');
  if (!today) throw new Error('buildSiteBundle needs today.');
  if (!/^[\w-]{8,80}$/.test(String(bundleId ?? ''))) throw new Error('buildSiteBundle needs a bundle id.');
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const pairingsById = new Map(pairings.map((p) => [p.id, p]));
  const titlesDetail = has(sections, 'titles_detail');
  const titles = titlesDetail ? titleDetailsByDog(events) : titlesByDog(events);
  const tests = completedTestsByDog(events);
  const config = waitlistConfig(kennel);
  const registry = has(sections, 'registry');
  const heatOf = Array.isArray(sections) && sections.includes('heat_id') ? heatUse(kennel, { dogs, events, pairings, today }).heatOf : null;
  const ctx = { dogsById, pairingsById, dogs, prices, registry, heatOf, litterStatus: has(sections, 'litter_status'), rawDisposition: has(sections, 'pup_disposition') };
  const kennelsById = new Map(kennels.map((k) => [k.id, k]));
  const coOwned = Array.isArray(sections) && sections.includes('partner_kennels') ? { contactsById: new Map(contacts.map((c) => [c.id, c])), kennelsById } : null;

  const shown = {
    dogs: websiteDogs(kennel, dogs).map((d) => dogEntry(d, titles, tests, registry, coOwned, has(sections, 'disposition'), has(sections, 'health_detail'), titlesDetail,
      has(sections, 'lineage') ? { dogsById } : null, has(sections, 'origin'))),
    litters: websiteLitters(kennel, litters, pairingsById).map((l) => litterEntry(l, ctx)),
    pairings: websitePairings(kennel, pairings, litters).map((p) => pairingEntry(p, dogsById, heatOf)),
    heats: websiteHeats(kennel, { dogs, events, pairings, today }).map((h) => assertOnlyKeys({ ...h, dam_name: dogName(dogsById.get(h.dam_id)) }, HEAT_KEYS, 'heat'))
  };
  const products = Array.isArray(sections) && sections.includes('products') ? websiteProducts(accounts, { transport: sections.includes('transport'), accountType: sections.includes('account_type') }) : null;
  if (products && products.length > SITE_MAX.products) throw new SiteExportError(`Your website takes at most ${SITE_MAX.products} recommended products, and ${products.length} accounts are marked Show on website. Untick some, then try again.`);
  const words = { dogs: 'dogs', litters: 'litters', pairings: 'pairings', heats: 'planned heats' };
  for (const [k, list] of Object.entries(shown)) {
    if (list.length > SITE_MAX[k]) throw new SiteExportError(`Your website takes at most ${SITE_MAX[k]} ${words[k]}, and ${list.length} are marked Show on website. Untick some, then try again.`);
  }
  const partnerKennels = coOwned ? partnerKennelEntries(shown.dogs, kennelsById) : null;
  if (partnerKennels && partnerKennels.length > SITE_MAX.partner_kennels) throw new SiteExportError(`Your website takes at most ${SITE_MAX.partner_kennels} partner kennels, and your co-owned dogs name ${partnerKennels.length}. Untick Name this kennel on my website on some, then try again.`);

  const steps = waitlistSteps(kennel);
  const fee = applicationFeePay(kennel, accounts);
  const facts = has(sections, 'waitlist_facts') ? waitlistFacts(kennel) : null;
  const bundle = {
    format: SITE_BUNDLE_FORMAT,
    bundle_id: bundleId,
    kennel_id: kennel.id,
    sent_at: sentAt || null,
    // Her public list for the website's waitlist page (KennelPort plan 3.8): only
    // while she lets the website read it (website_feed).
    ...(config.website_feed === true && kennel.public_id ? { waitlist_public_id: kennel.public_id } : {}),
    ...shown,
    extras: extraEntries(kennel, prices),
    ...(products ? { products } : {}),
    ...(partnerKennels ? { partner_kennels: partnerKennels } : {}),
    ...(steps.length ? { steps } : {}),
    ...(fee ? { payment: assertOnlyKeys({ application_fee: fee }, PAYMENT_KEYS, 'payment') } : {}),
    ...(facts ? { waitlist_facts: facts } : {})
  };
  return assertOnlyKeys(bundle, BUNDLE_KEYS, 'bundle');
}
