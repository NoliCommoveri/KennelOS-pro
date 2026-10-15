// tidyRules.js — Kels's "Tidy up my records" checks (End-State guide §33): the
// places where two records that should agree don't. Pure: every function takes
// the rows it needs and returns findings; nothing here reads or writes the
// database, and nothing here decides what to do about a finding. The task
// (assets/tidyUpUI.js) asks the breeder, one finding at a time, and writes
// through the repos (or data/recordMerge.js for a duplicate).
//
// These run only inside Kels, never as Today nudges: some are slow (the
// duplicate scans) and some are opinions she should be asked about in person.
//
// A finding: { key, kind, ... }. `key` is stable for the same records, so
// "don't ask me again" can remember it (nudgeState, prefixed `tidy:`). Order is
// the order she raises them in: TIDY_KINDS.
import { RELEASED_SALE_STATUSES } from './vocab.js';

export const TIDY_KINDS = [
  'litter-count',        // a litter's born count ≠ its puppy records
  'pup-placed',          // a pup with a sale isn't marked Placed
  'delivered-owned',     // a delivered pup is still on her roster as hers
  'litter-pairing-parents', // a litter's parents ≠ its breeding's
  'pup-litter-parents',  // a litter's pups have blank or different parents
  'dog-no-parents',      // a dog of hers with no litter has a blank sire or dam
  'stud-unlinked',       // a stud service past its date with no breeding linked (Pro)
  'breeder-no-kennel',   // a Breeder contact with no kennel (Pro)
  'kennel-no-contact',   // an outside kennel no contact belongs to (Pro)
  'duplicate-dogs',      // two dog records for one dog
  'duplicate-contacts'   // two contact records for one person (Pro)
];

const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '');
const num = (v) => (blank(v) ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

// Name keys: case, spacing and punctuation don't count ("Mary-Ann  Smith." = "mary ann smith").
export const normName = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const normId = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normEmail = (s) => String(s ?? '').trim().toLowerCase();
// Phone: digits only, and the last 10 so "+1 (555) 123-4567" = "555.123.4567".
export const normPhone = (s) => {
  const d = String(s ?? '').replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-10) : '';
};
const normUrl = (s) => String(s ?? '').trim().toLowerCase().replace(/^https?:\/\/(www\.|m\.)?/, '').replace(/\/+$/, '');

// --- Litters -------------------------------------------------------------------

// How many pups the litter says were born alive: `puppies_born_alive`, else the
// total less any recorded deceased, else null (no count to compare).
export function recordedAlive(litter) {
  const alive = num(litter.puppies_born_alive);
  if (alive != null) return alive;
  const total = num(litter.puppies_born_total);
  if (total == null) return null;
  return Math.max(0, total - (num(litter.puppies_born_deceased) ?? 0));
}

// Born litters whose count disagrees with their puppy records. Every record with
// the litter_id counts, departed (archived) and deceased pups too: a pup that
// left or died later was still born alive.
export function litterCountFindings(litters, allDogs) {
  const pups = new Map();
  for (const d of allDogs) if (d.litter_id) pups.set(d.litter_id, (pups.get(d.litter_id) || 0) + 1);
  const out = [];
  for (const l of litters) {
    if (l.is_archived || l.status === 'expected') continue;
    const recorded = recordedAlive(l);
    if (recorded == null) continue;
    const actual = pups.get(l.id) || 0;
    if (actual === recorded) continue;
    out.push({ key: `count:${l.id}:${recorded}:${actual}`, kind: 'litter-count', litter: l, recorded, actual, more: actual > recorded });
  }
  return out;
}

// What a "fix the count" writes: alive = the records, and the total grows to
// fit if it would now be smaller than alive + deceased.
export function countFix(litter, actual) {
  const changes = { puppies_born_alive: actual };
  const total = num(litter.puppies_born_total);
  const dead = num(litter.puppies_born_deceased) ?? 0;
  if (total != null && total !== actual + dead) changes.puppies_born_total = actual + dead;
  return changes;
}

// A litter linked to a breeding with different parents. The litter's own
// sire/dam are authoritative (§4), but either side can be the typo, so both fixes are offered.
export function litterPairingFindings(litters, pairings) {
  const byId = new Map(pairings.map((p) => [p.id, p]));
  const out = [];
  for (const l of litters) {
    if (l.is_archived || !l.pairing_id) continue;
    const p = byId.get(l.pairing_id);
    if (!p || p.is_archived) continue;
    const sire = p.sire_id !== l.sire_id;
    const dam = p.dam_id !== l.dam_id;
    if (!sire && !dam) continue;
    out.push({ key: `litpair:${l.id}:${p.sire_id}:${p.dam_id}:${l.sire_id}:${l.dam_id}`, kind: 'litter-pairing-parents', litter: l, pairing: p, sire, dam });
  }
  return out;
}

// Per litter: its pups (on the roster) with a blank sire/dam (`fill`) or one
// different from the litter's (`conflict`).
export function pupParentFindings(litters, dogs) {
  const byLitter = new Map();
  for (const d of dogs) {
    if (d.is_archived || !d.litter_id) continue;
    if (!byLitter.has(d.litter_id)) byLitter.set(d.litter_id, []);
    byLitter.get(d.litter_id).push(d);
  }
  const out = [];
  for (const l of litters) {
    if (l.is_archived) continue;
    const fill = [];
    const conflict = [];
    for (const p of byLitter.get(l.id) || []) {
      const off = (p.sire_id && p.sire_id !== l.sire_id) || (p.dam_id && p.dam_id !== l.dam_id);
      if (off) conflict.push(p);
      else if (!p.sire_id || !p.dam_id) fill.push(p);
    }
    if (!fill.length && !conflict.length) continue;
    const ids = [...fill, ...conflict].map((p) => p.id).sort().join(',');
    out.push({ key: `puppar:${l.id}:${l.sire_id}:${l.dam_id}:${ids}`, kind: 'pup-litter-parents', litter: l, fill, conflict });
  }
  return out;
}

// What filling / correcting a pup from its litter writes.
export function pupParentFix(pup, litter) {
  const changes = {};
  if (pup.sire_id !== litter.sire_id) changes.sire_id = litter.sire_id;
  if (pup.dam_id !== litter.dam_id) changes.dam_id = litter.dam_id;
  return changes;
}

// --- Dogs ------------------------------------------------------------------------

const MINE = ['owned', 'co_owned', 'leased_in'];

// Her own dogs (not from one of her litters) with a blank sire or dam. Pups in a
// litter are pupParentFindings' job; outside and pedigree-only dogs aren't asked
// about (a pedigree's top row has no parents, and that's fine).
export function dogParentFindings(dogs, littersById) {
  const out = [];
  for (const d of dogs) {
    if (d.is_archived || d.pedigree_only || !MINE.includes(d.ownership_type)) continue;
    if (d.litter_id && littersById.has(d.litter_id)) continue;
    const missing = [!d.sire_id && 'sire', !d.dam_id && 'dam'].filter(Boolean);
    if (!missing.length) continue;
    out.push({ key: `dogpar:${d.id}:${missing.join('+')}`, kind: 'dog-no-parents', dog: d, missing });
  }
  return out;
}

// Pups with a sale that's going ahead (open or delivered) whose plan isn't Placed.
export function pupPlacedFindings(dogs, sales) {
  const live = new Set(sales.filter((s) => !s.is_archived && s.status && !RELEASED_SALE_STATUSES.includes(s.status)).map((s) => s.dog_id));
  return dogs
    .filter((d) => !d.is_archived && d.status === 'puppy' && d.disposition !== 'placed' && live.has(d.id))
    .map((d) => ({ key: `placed:${d.id}`, kind: 'pup-placed', dog: d, sale: sales.find((s) => s.dog_id === d.id && !s.is_archived && !RELEASED_SALE_STATUSES.includes(s.status)) }));
}

// A dog whose sale is Delivered but who is still on her roster as hers (owned).
// Co-owned dogs are left alone: keeping a share is a normal way to sell.
export function deliveredOwnedFindings(dogs, sales) {
  const out = [];
  for (const d of dogs) {
    if (d.is_archived || d.ownership_type !== 'owned') continue;
    const sale = sales.filter((s) => !s.is_archived && s.dog_id === d.id && s.status === 'delivered')
      .sort((a, b) => String(b.sale_date || b.updated_at || '').localeCompare(String(a.sale_date || a.updated_at || '')))[0];
    if (!sale) continue;
    // A newer sale still going (a re-sale after a return) means she has the dog back.
    if (sales.some((s) => !s.is_archived && s.dog_id === d.id && s.id !== sale.id && !['delivered', ...RELEASED_SALE_STATUSES].includes(s.status))) continue;
    out.push({ key: `delivered:${d.id}:${sale.id}`, kind: 'delivered-owned', dog: d, sale });
  }
  return out;
}

// --- Stud services (Pro) ---------------------------------------------------------

// The dam and sire of a stud service: incoming = our dog is the dam.
export const studParents = (s) => (s.direction === 'incoming'
  ? { damId: s.our_dog_id, sireId: s.partner_dog_id }
  : { damId: s.partner_dog_id, sireId: s.our_dog_id });

// A stud service whose date has passed (returned, else sent; or Completed) with
// no breeding linked. `candidates` are breedings of the same two dogs, opened no
// earlier than two weeks before it was sent, that no other stud service claims:
// the "link it" answers. None means she can create one.
export function studFindings(studServices, pairings, today) {
  const claimed = new Set(studServices.filter((s) => !s.is_archived && s.pairing_id).map((s) => s.pairing_id));
  const out = [];
  for (const s of studServices) {
    if (s.is_archived || s.pairing_id || ['cancelled', 'failed'].includes(s.status)) continue;
    const date = s.returned_date || s.sent_date || null;
    const past = s.status === 'completed' || (date && date < today);
    if (!past) continue;
    const { damId, sireId } = studParents(s);
    const since = s.sent_date ? shiftDays(s.sent_date, -14) : null;
    const candidates = pairings.filter((p) => !p.is_archived && p.dam_id === damId && p.sire_id === sireId && !claimed.has(p.id)
      && (!since || (p.planned_date || String(p.created_at || '').slice(0, 10) || since) >= since));
    out.push({ key: `stud:${s.id}`, kind: 'stud-unlinked', stud: s, candidates });
  }
  return out;
}

function shiftDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// --- Contacts & kennels (Pro) ----------------------------------------------------

export function breederKennelFindings(contacts) {
  return contacts
    .filter((c) => !c.is_archived && (c.contact_type || []).includes('breeder') && !c.kennel_id)
    .map((c) => ({ key: `breederkennel:${c.id}`, kind: 'breeder-no-kennel', contact: c }));
}

// Outside kennels no (current) contact belongs to. `used` = some dog names it
// (as its kennel or its breeder); an unused one can simply be archived.
export function kennelContactFindings(kennels, contacts, dogs) {
  const linked = new Set(contacts.filter((c) => !c.is_archived && c.kennel_id).map((c) => c.kennel_id));
  const usedBy = new Set();
  for (const d of dogs) { if (d.kennel_id) usedBy.add(d.kennel_id); if (d.breeder_kennel_id) usedBy.add(d.breeder_kennel_id); }
  return kennels
    .filter((k) => !k.is_archived && !k.is_own_kennel && !linked.has(k.id))
    .map((k) => ({ key: `kennelcontact:${k.id}`, kind: 'kennel-no-contact', kennel: k, used: usedBy.has(k.id) }));
}

// Two contacts with the same name (normalized) and at least one other detail
// in common: email, phone, address, Facebook, or kennel. A name alone isn't enough.
export function duplicateContactFindings(contacts) {
  const groups = new Map();
  for (const c of contacts) {
    if (c.is_archived) continue;
    const n = normName(c.name);
    if (!n) continue;
    if (!groups.has(n)) groups.set(n, []);
    groups.get(n).push(c);
  }
  const details = [
    ['email', (c) => normEmail(c.email)],
    ['phone', (c) => normPhone(c.phone)],
    ['address', (c) => normName(c.address)],
    ['Facebook', (c) => normUrl(c.facebook_profile)],
    ['kennel', (c) => c.kennel_id || '']
  ];
  const out = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [a, b] = [group[i], group[j]];
        const shared = details.filter(([, f]) => f(a) && f(a) === f(b)).map(([label]) => label);
        if (!shared.length) continue;
        const [x, y] = orderPair(a, b);
        out.push({ key: `dupcontact:${pairKey(a.id, b.id)}`, kind: 'duplicate-contacts', a: x, b: y, shared });
      }
    }
  }
  return out;
}

// Older record first: it's the one most likely to be the "real" one.
const orderPair = (a, b) => (String(a.created_at || '') <= String(b.created_at || '') ? [a, b] : [b, a]);

// Two dog records for one dog. Missing details are unknown, never a difference:
// an outside dog often has no birthday or registration number, so those can only
// rule a pair OUT when both records have them and they differ.
//   certain: the same registration number, or the same registered name;
//   possible: the same call name, breed and sex, and nothing that contradicts it.
// Never a pair: littermates (same litter) by name alone, a dog and its own parent
// or child, or two dogs whose known sex differs.
export const DOG_CONTRADICTIONS = [
  ['registration number', (d) => normId(d.registration_number)],
  ['birthday', (d) => d.date_of_birth || ''],
  ['microchip', (d) => normId(d.microchip_id)],
  ['sire', (d) => d.sire_id || ''],
  ['dam', (d) => d.dam_id || '']
];
const knownSex = (d) => (d.sex === 'male' || d.sex === 'female' ? d.sex : '');

export function compareDogs(a, b) {
  if (a.id === b.id) return null;
  if (a.sire_id === b.id || a.dam_id === b.id || b.sire_id === a.id || b.dam_id === a.id) return null;
  if (knownSex(a) && knownSex(b) && knownSex(a) !== knownSex(b)) return null;
  const regA = normId(a.registration_number);
  const sameReg = regA && regA === normId(b.registration_number);
  const rnA = normName(a.registered_name);
  const sameRegName = rnA && rnA === normName(b.registered_name);
  const cnA = normName(a.call_name);
  const sameCall = cnA && cnA === normName(b.call_name) && normName(a.breed) === normName(b.breed);
  const differs = DOG_CONTRADICTIONS.filter(([, f]) => f(a) && f(b) && f(a) !== f(b)).map(([label]) => label);
  const matches = DOG_CONTRADICTIONS.filter(([, f]) => f(a) && f(a) === f(b)).map(([label]) => label);
  const unknown = DOG_CONTRADICTIONS.filter(([, f]) => !f(a) || !f(b)).map(([label]) => label);
  if (sameReg) return { strength: 'certain', reasons: ['registration number'], matches, unknown: [] };
  if (sameRegName && !differs.length) return { strength: 'certain', reasons: ['registered name'], matches, unknown };
  if (sameCall && !differs.length && !(a.litter_id && a.litter_id === b.litter_id)) {
    return { strength: 'possible', reasons: ['call name', 'breed'], matches, unknown };
  }
  return null;
}

export function duplicateDogFindings(dogs) {
  const live = dogs.filter((d) => !d.is_archived);
  // Only pairs sharing a name or a registration number can match, so bucket by those.
  const buckets = new Map();
  const put = (k, d) => { if (!k) return; if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(d); };
  for (const d of live) {
    put(normName(d.call_name) && `c:${normName(d.call_name)}`, d);
    put(normName(d.registered_name) && `r:${normName(d.registered_name)}`, d);
    put(normId(d.registration_number) && `n:${normId(d.registration_number)}`, d);
  }
  const seen = new Set();
  const out = [];
  for (const group of buckets.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const k = pairKey(group[i].id, group[j].id);
        if (seen.has(k)) continue;
        seen.add(k);
        const m = compareDogs(group[i], group[j]);
        if (!m) continue;
        const [a, b] = orderPair(group[i], group[j]);
        out.push({ key: `dupdog:${k}`, kind: 'duplicate-dogs', a, b, ...m });
      }
    }
  }
  return out.sort((x, y) => (x.strength === y.strength ? 0 : x.strength === 'certain' ? -1 : 1));
}

// --- Everything ------------------------------------------------------------------

// Every finding, in TIDY_KINDS order. `flags` are the edition's (editionFlags):
// contactsSection gates the contact and kennel checks, studServices the stud one.
// `scoped` rows (litters, sales, studServices, dogs) are already in kennel scope;
// `allDogs` is every dog (archived and pedigree-only included) for counting
// litters and matching duplicates; contacts and kennels are program-wide.
export function tidyFindings({ litters, pairings, sales, studServices = [], dogs, allDogs, contacts = [], kennels = [], flags = {}, today }) {
  const littersById = new Map(litters.map((l) => [l.id, l]));
  const all = [
    ...litterCountFindings(litters, allDogs),
    ...pupPlacedFindings(dogs, sales),
    ...deliveredOwnedFindings(dogs, sales),
    ...litterPairingFindings(litters, pairings),
    ...pupParentFindings(litters, dogs),
    ...dogParentFindings(dogs, littersById),
    ...(flags.studServices ? studFindings(studServices, pairings, today) : []),
    ...(flags.contactsSection ? breederKennelFindings(contacts) : []),
    ...(flags.contactsSection ? kennelContactFindings(kennels, contacts, allDogs) : []),
    ...duplicateDogFindings(allDogs),
    ...(flags.contactsSection ? duplicateContactFindings(contacts) : [])
  ];
  return all.sort((a, b) => TIDY_KINDS.indexOf(a.kind) - TIDY_KINDS.indexOf(b.kind));
}
