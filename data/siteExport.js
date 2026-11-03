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
import { titlesByDog } from './waitlistProjection.js';
import { completedTestsByDog } from './healthTestLog.js';
import { waitlistConfig, waitlistIsSetUp } from './waitlistRules.js';
import { feePay } from './waitlistFeePay.js';
import { kennelChargeList } from './extraCharges.js';
import { addDaysToYMD } from './dateUtils.js';
import { RELEASED_SALE_STATUSES } from './vocab.js';

export const SITE_BUNDLE_FORMAT = 1;

// KennelPort's caps (bundle.js MAX). Over one, the website would refuse the whole
// bundle, so siteExport says so first, in words.
export const SITE_MAX = { dogs: 200, litters: 100, puppies: 30, pairings: 50, heats: 50, health: 60, extras: 100, products: 50, steps: 20, titles: 20 };

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

export const BUNDLE_KEYS = ['format', 'bundle_id', 'kennel_id', 'sent_at', 'waitlist_public_id', 'dogs', 'litters', 'pairings', 'heats', 'extras', 'products', 'steps', 'payment'];
export const PRODUCT_KEYS = ['id', 'name', 'link_url', 'code', 'code_note'];
export const DOG_KEYS = ['id', 'call_name', 'registered_name', 'sex', 'date_of_birth', 'color', 'status', 'died_on', 'titles', 'health'];
export const HEALTH_KEYS = ['id', 'test', 'result', 'normal', 'date'];
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
const isMarked = (r) => r?.show_on_website === true;

// --- dogs ---------------------------------------------------------------------

function dogEntry(dog, titles, tests) {
  const done = (tests.get(dog.id) || []).slice(0, SITE_MAX.health);
  return assertOnlyKeys({
    id: dog.id,
    call_name: line(dog.call_name || dog.registered_name, 40),
    registered_name: line(dog.registered_name, 120),
    sex: dog.sex,
    date_of_birth: ymd(dog.date_of_birth),
    color: line(dog.color_markings, 40),
    status: DOG_STATUS[dog.status],
    died_on: dog.status === 'deceased' ? ymd(dog.date_of_death) : null,
    titles: (titles.get(dog.id) || []).map((t) => line(t, 30)).filter(Boolean).slice(0, SITE_MAX.titles),
    // A test's id is its name, so a retest updates the same result on the website
    // (and keeps her Show on site tick there).
    health: done.map((t) => assertOnlyKeys({
      id: `test:${t.name.trim().toLowerCase()}`.slice(0, 80),
      test: line(t.name, 60),
      result: line(t.result, 60),
      normal: t.outcome === 'Normal',
      date: ymd(t.date)
    }, HEALTH_KEYS, 'health'))
  }, DOG_KEYS, 'dog');
}

// The dogs she shows: her own kennel's, marked, with a status the website has.
export function websiteDogs(kennel, dogs) {
  return dogs.filter((d) => !d.is_archived && !d.pedigree_only && d.kennel_id === kennel.id && isMarked(d)
    && DOG_STATUS[d.status] && SEXES.includes(d.sex) && (d.call_name || d.registered_name));
}

// --- puppies ------------------------------------------------------------------

// A puppy's status on the website (KennelPort plan 3.6), from what she set: her
// disposition, a sale, or a waitlist pick waiting on its deposit.
export function puppyStatus(pup, { sales = [], offers = [] } = {}) {
  if (pup.disposition === 'health_hold') return 'hidden';
  if (pup.disposition === 'placed' || pup.status === 'pet_home') return 'placed';
  const sale = sales.find((s) => s.dog_id === pup.id && !s.is_archived && !RELEASED_SALE_STATUSES.includes(s.status));
  if (sale) return sale.status === 'delivered' ? 'placed' : 'reserved';
  if (offers.some((o) => !o.is_archived && o.outcome === 'open' && o.chosen_dog_id === pup.id)) return 'reserved';
  if (pup.disposition === 'keeping' || ['active_breeding', 'retired_breeding', 'for_sale'].includes(pup.status)) return 'staying';
  if (pup.disposition === 'available') return 'available';
  return 'undecided';
}

function puppyEntries(litter, dogs, ctx) {
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
      status: puppyStatus(p, ctx)
    }, PUPPY_KEYS, 'puppy'));
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

function litterEntry(litter, { dogsById, pairingsById, dogs, prices, sales, offers }) {
  const pairing = litter.pairing_id ? pairingsById.get(litter.pairing_id) : null;
  const born = litter.status !== 'expected';
  return assertOnlyKeys({
    id: litter.id,
    pairing_id: litter.pairing_id || null,
    name: line(litter.nickname, 80),
    dam_id: litter.dam_id || null,
    sire_id: litter.sire_id || null,
    dam_name: dogName(dogsById.get(litter.dam_id)),
    sire_name: dogName(dogsById.get(litter.sire_id)),
    expected_on: born ? null : ymd(pairing?.expected_due_date) || ymd(litter.whelp_date),
    born_on: born ? ymd(litter.whelp_date) : null,
    ready_on: born ? ymd(litter.estimated_ready_date) : null,
    deposits_on: ymd(litter.accept_deposits_date),
    prices: prices ? litterPrices(litter) : null,
    puppies: puppyEntries(litter, dogs, { sales, offers })
  }, LITTER_KEYS, 'litter');
}

// Pairings she shows under Coming up: marked, still on their way, and not yet a
// litter (the litter carries on from there, with the pairing's page).
export function websitePairings(kennel, pairings, litters) {
  const hasLitter = new Set(litters.filter((l) => !l.is_archived && l.pairing_id).map((l) => l.pairing_id));
  return pairings.filter((p) => !p.is_archived && p.kennel_id === kennel.id && isMarked(p) && LIVE_PAIRING_STATUSES.includes(p.status) && !hasLitter.has(p.id));
}

const pairingEntry = (p, dogsById) => assertOnlyKeys({
  id: p.id,
  dam_id: p.dam_id || null,
  sire_id: p.sire_id || null,
  dam_name: dogName(dogsById.get(p.dam_id)),
  sire_name: dogName(dogsById.get(p.sire_id)),
  planned_on: ymd(p.planned_date),
  expected_on: ymd(p.expected_due_date)
}, PAIRING_KEYS, 'pairing');

// --- heats --------------------------------------------------------------------

const dayNumber = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86400000);

// Her planned heats as the website shows them (KennelPort plan 5.3): each
// heat_cycle event of a dam of this kennel with heats_online on, from 60 days ago
// on, one per dam per month, less the heats a pairing has used. A pairing of the
// same dam (not failed or cancelled) uses the nearest heat whose date its
// planned_date (else the day it was entered) falls from 30 days before to 60 days
// after; each pairing uses at most one. A used heat leaves: the pairing's own
// entry, or its litter's, takes over. → [{ id, dam_id, month }], soonest first.
export function websiteHeats(kennel, { dogs = [], events = [], pairings = [], today }) {
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
  const used = new Set();
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
    if (best) used.add(best.h.id);
  }
  return heats.filter((h) => !used.has(h.id)).map((h) => ({ id: h.id, dam_id: h.subject_id, month: h.event_date.slice(0, 7) }));
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
// customer id, notes, fees, contract forms or payment details. Transport accounts
// never (they're shown to a family with a picked pup, not to the public). Accounts
// are program-wide, so every linked kennel's website gets the same ones.
export function websiteProducts(accounts = []) {
  return accounts
    .filter((a) => a && !a.is_archived && a.show_on_website === true && a.account_type !== 'transport' && line(a.name, 80))
    .sort((x, y) => String(x.name).localeCompare(String(y.name), undefined, { sensitivity: 'base' }) || String(x.id).localeCompare(String(y.id)))
    .map((a) => {
      const note = line(a.referral_instructions, 1000);
      return assertOnlyKeys({
        id: String(a.id).slice(0, 80),
        name: line(a.name, 80),
        link_url: webLink(a.referral_link) || webLink(a.website),
        code: line(a.referral_code, 40),
        code_note: note && note.length <= 120 ? note : null
      }, PRODUCT_KEYS, 'product');
    });
}

// --- the bundle ---------------------------------------------------------------

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
export function buildSiteBundle({ kennel, dogs = [], litters = [], pairings = [], events = [], sales = [], offers = [], accounts = [], today, sentAt, bundleId, prices = false, sections = [] }) {
  if (!kennel || !kennel.id) throw new SiteExportError('Choose a kennel first.');
  if (!today) throw new Error('buildSiteBundle needs today.');
  if (!/^[\w-]{8,80}$/.test(String(bundleId ?? ''))) throw new Error('buildSiteBundle needs a bundle id.');
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const pairingsById = new Map(pairings.map((p) => [p.id, p]));
  const titles = titlesByDog(events);
  const tests = completedTestsByDog(events);
  const config = waitlistConfig(kennel);
  const ctx = { dogsById, pairingsById, dogs, prices, sales, offers };

  const shown = {
    dogs: websiteDogs(kennel, dogs).map((d) => dogEntry(d, titles, tests)),
    litters: websiteLitters(kennel, litters, pairingsById).map((l) => litterEntry(l, ctx)),
    pairings: websitePairings(kennel, pairings, litters).map((p) => pairingEntry(p, dogsById)),
    heats: websiteHeats(kennel, { dogs, events, pairings, today }).map((h) => assertOnlyKeys({ ...h, dam_name: dogName(dogsById.get(h.dam_id)) }, HEAT_KEYS, 'heat'))
  };
  const products = Array.isArray(sections) && sections.includes('products') ? websiteProducts(accounts) : null;
  if (products && products.length > SITE_MAX.products) throw new SiteExportError(`Your website takes at most ${SITE_MAX.products} recommended products, and ${products.length} accounts are marked Show on website. Untick some, then try again.`);
  const words = { dogs: 'dogs', litters: 'litters', pairings: 'pairings', heats: 'planned heats' };
  for (const [k, list] of Object.entries(shown)) {
    if (list.length > SITE_MAX[k]) throw new SiteExportError(`Your website takes at most ${SITE_MAX[k]} ${words[k]}, and ${list.length} are marked Show on website. Untick some, then try again.`);
  }

  const steps = waitlistSteps(kennel);
  const fee = applicationFeePay(kennel, accounts);
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
    ...(steps.length ? { steps } : {}),
    ...(fee ? { payment: assertOnlyKeys({ application_fee: fee }, PAYMENT_KEYS, 'payment') } : {})
  };
  return assertOnlyKeys(bundle, BUNDLE_KEYS, 'bundle');
}
