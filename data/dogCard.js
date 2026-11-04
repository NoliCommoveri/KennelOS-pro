// dogCard.js — the Dog Card (Shared Dogs Plan §3; End-State guide §36): one dog or a
// whole program of them, handed from one breeder's KennelOS to another's, with their
// ancestors, health tests and titles. Sending again updates the same dogs, matched by
// `dogs.public_id`, never duplicates them.
//
// THE ALLOW-LIST, same posture as kennelCard.js and companionExport.js: the builder
// names every field it copies and `assertOnlyKeys` runs a positive check on every
// object before a card can leave, and again on every object a decoded card yields. A
// new Dog or Event field does NOT travel until someone adds it here by name. Never on a
// card: notes, contacts, sales and money, litters and pairings, heats and every other
// event type, documents, planned tests, disposition, website and waitlist settings, and
// every row id.
//
// THE RECEIVING SIDE'S RULES:
//   - the kennel it's from follows Kennel Card rules (applyKennelCard): never one of
//     hers, and a card from one of her own kennels is refused;
//   - a card only ever writes the dog fields it carries, a blank one meaning "not
//     supplied"; her side of a dog she already has (ownership, kennel, co-owners, lives
//     with, notes, plans, website and waitlist marks, events she recorded) is never
//     touched (`DOG_FIELDS` is the whole list);
//   - linking a sent dog to one she typed in is her pick in the preview, never
//     automatic; an ancestor links only by public id or the same registry and number.
//
// Transport: lz-string JSON, as a link (`dog-cards.html#dogcard=…`), a code or a file.
// Offline; nothing here makes a network call.
import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from '../vendor/lz-string.min.mjs';
import { dogRepo, dogName, isDogPublicId, normalizeRegistrations } from './dogRepo.js';
import { eventRepo } from './eventRepo.js';
import { kennelRepo, isPublicId } from './kennelRepo.js';
import { contactRepo } from './contactRepo.js';
import { applyKennelCard, previewKennelCard } from './kennelCard.js';
import { cloudDetailKeys } from './syncRegistry.js';
import { descriptor, EVENT_TYPES } from './vocab.js';

export const DOG_CARD_VERSION = 1;
export const DOG_CARD_PARAM = 'dogcard';
// How many generations above each dog sent travel with it.
export const ANCESTOR_GENERATIONS = 4;

export class DogCardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DogCardError';
  }
}

const BAD_CARD = 'This dog card could not be read. Ask for a fresh one: it may have been cut short when it was copied. For a lot of dogs, ask for the file instead.';

// --- The allow-list ----------------------------------------------------------

const CARD_KEYS = ['cardVersion', 'issuedAt', 'from', 'kennels', 'dogs'];
const KENNEL_KEYS = ['ref', 'publicId', 'kennelName', 'prefix', 'location', 'website'];
const EVENT_KEYS = ['ref', 'type', 'date', 'title', 'details'];

// The dog fields a card carries, each with the record field it comes from and goes
// to. This is the ONLY mapping, both ways.
export const DOG_FIELDS = [
  { card: 'callName', field: 'call_name', label: 'Call name', kind: 'text' },
  { card: 'registeredName', field: 'registered_name', label: 'Registered name', kind: 'text' },
  { card: 'sex', field: 'sex', label: 'Sex', kind: 'text' },
  { card: 'breed', field: 'breed', label: 'Breed', kind: 'text' },
  { card: 'dateOfBirth', field: 'date_of_birth', label: 'Date of birth', kind: 'date' },
  { card: 'dobIsEstimated', field: 'dob_is_estimated', label: 'Birthday estimated', kind: 'bool' },
  { card: 'dateOfDeath', field: 'date_of_death', label: 'Date of death', kind: 'date' },
  { card: 'colorMarkings', field: 'color_markings', label: 'Colour and markings', kind: 'text' },
  { card: 'registry', field: 'registry', label: 'Registry', kind: 'text' },
  { card: 'registrationNumber', field: 'registration_number', label: 'Registration #', kind: 'text' },
  { card: 'additionalRegistrations', field: 'additional_registrations', label: 'Other registrations', kind: 'registrations' },
  { card: 'microchipId', field: 'microchip_id', label: 'Microchip', kind: 'text' },
  { card: 'photosUrl', field: 'url', label: 'Photos link', kind: 'text' },
  { card: 'recordedCoi', field: 'recorded_coi', label: 'Recorded COI', kind: 'number' }
];
const DOG_KEYS = ['publicId', 'sent', 'status', 'sirePublicId', 'damPublicId', 'breederKennelRef', 'events', ...DOG_FIELDS.map((f) => f.card)];

// The event types that travel, and their detail keys: exactly the ones the cloud
// already treats as plain data for each type (syncRegistry), so a card never carries
// a detail the cloud wouldn't.
export const SHARED_EVENT_TYPES = ['genetic_test', 'ofa_pennhip', 'breed_specific_test', 'title_earned'];
const detailKeys = (type) => [...cloudDetailKeys(type)];

function assertOnlyKeys(obj, allowed, ctx) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new Error(`Dog card (${ctx}) has unexpected key "${k}": not shared.`);
  }
  return obj;
}

const text = (v) => String(v ?? '').trim();
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);

// A record value as the card carries it, by kind; '' / null / [] mean "not supplied".
function cardValue(kind, v) {
  if (kind === 'bool') return v === true;
  if (kind === 'number') return v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v);
  if (kind === 'date') return isYmd(text(v)) ? text(v) : '';
  if (kind === 'registrations') return normalizeRegistrations(v);
  return text(v);
}
const supplied = (kind, v) => (kind === 'bool' ? v === true : kind === 'number' ? v != null : kind === 'registrations' ? v.length > 0 : v !== '');
const sameValue = (kind, a, b) => JSON.stringify(cardValue(kind, a)) === JSON.stringify(cardValue(kind, b));

// --- Building (sender side) --------------------------------------------------

function kennelEntry(ref, k) {
  return assertOnlyKeys({
    ref,
    publicId: k.public_id || '',
    kennelName: text(k.kennel_name),
    prefix: text(k.prefix),
    location: text(k.location),
    website: text(k.website)
  }, KENNEL_KEYS, 'kennel');
}

async function sharedEvents(dog) {
  const events = await eventRepo.getForSubject('dog', dog.id);
  return events
    .filter((e) => SHARED_EVENT_TYPES.includes(e.event_type) && isYmd(text(e.event_date)))
    .sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)) || String(a.id).localeCompare(String(b.id)))
    .map((e) => {
      const details = {};
      for (const key of detailKeys(e.event_type)) {
        const v = e.details?.[key];
        if (v != null && text(v) !== '') details[key] = text(v);
      }
      return assertOnlyKeys({ ref: e.id, type: e.event_type, date: text(e.event_date), title: text(e.title), details }, EVENT_KEYS, 'event');
    });
}

// The card for `dogIds`, sent from one of her own kennels. Mints the public ids it
// needs (the dogs' and their ancestors') and the sending kennel's; nothing else on
// her records changes. → the card object.
export async function buildDogCard({ fromKennelId, dogIds, generations = ANCESTOR_GENERATIONS }) {
  const from = fromKennelId ? await kennelRepo.getById(fromKennelId) : null;
  if (!from || !from.is_own_kennel) throw new DogCardError('Pick one of your own kennels to send from.');
  const ids = [...new Set(dogIds || [])];
  if (!ids.length) throw new DogCardError('Pick at least one dog to send.');

  const kennels = [kennelEntry('k0', { ...from, public_id: await kennelRepo.ensurePublicId(from.id) })];
  const kennelRefs = new Map([[from.id, 'k0']]);
  const kennelRef = async (kennelId) => {
    if (!kennelId) return '';
    if (kennelRefs.has(kennelId)) return kennelRefs.get(kennelId);
    const k = await kennelRepo.getById(kennelId);
    if (!k) return '';
    const ref = `k${kennels.length}`;
    const publicId = k.is_own_kennel ? await kennelRepo.ensurePublicId(k.id) : k.public_id;
    kennels.push(kennelEntry(ref, { ...k, public_id: publicId || '' }));
    kennelRefs.set(kennelId, ref);
    return ref;
  };

  // The dogs sent, then their ancestors breadth-first up to `generations`.
  const order = [];
  const depth = new Map();
  for (const id of ids) {
    const d = await dogRepo.getById(id);
    if (!d) throw new DogCardError('One of those dogs is no longer on this device.');
    if (!depth.has(id)) { depth.set(id, 0); order.push(d); }
  }
  for (let i = 0; i < order.length; i++) {
    const d = order[i];
    const level = depth.get(d.id);
    if (level >= generations && !ids.includes(d.id)) continue;
    for (const pid of [d.sire_id, d.dam_id]) {
      if (!pid || depth.has(pid)) continue;
      const p = await dogRepo.getById(pid);
      if (!p) continue;
      depth.set(pid, level + 1);
      if (level + 1 <= generations || ids.includes(pid)) order.push(p);
    }
  }
  const inCard = new Set(order.map((d) => d.id));

  const publicIds = new Map();
  for (const d of order) publicIds.set(d.id, await dogRepo.ensurePublicId(d.id));

  const dogs = [];
  for (const d of order) {
    const sent = ids.includes(d.id);
    const entry = { publicId: publicIds.get(d.id), sent, status: text(d.status) };
    for (const { card, field, kind } of DOG_FIELDS) entry[card] = cardValue(kind, d[field]);
    entry.sirePublicId = d.sire_id && inCard.has(d.sire_id) ? publicIds.get(d.sire_id) : '';
    entry.damPublicId = d.dam_id && inCard.has(d.dam_id) ? publicIds.get(d.dam_id) : '';
    entry.breederKennelRef = await kennelRef(d.breeder_kennel_id);
    entry.events = sent ? await sharedEvents(d) : [];
    dogs.push(assertOnlyKeys(entry, DOG_KEYS, 'dog'));
  }

  return assertOnlyKeys({ cardVersion: DOG_CARD_VERSION, issuedAt: new Date().toISOString(), from: 'k0', kennels, dogs }, CARD_KEYS, 'card');
}

export const encodeDogCard = (card) => compressToEncodedURIComponent(JSON.stringify(card));
export const dogCardLink = (card, baseUrl) => `${baseUrl}#${DOG_CARD_PARAM}=${encodeDogCard(card)}`;
// The file's name: the sending kennel's, and how many dogs.
export function dogCardFileName(card) {
  const from = card.kennels.find((k) => k.ref === card.from);
  const slug = text(from?.kennelName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'kennel';
  const n = card.dogs.filter((d) => d.sent).length;
  return `${slug}-${n}-dog${n === 1 ? '' : 's'}.kosdogs`;
}

// --- Reading (receiving side) ------------------------------------------------

export function extractDogCardPayload(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  const prefix = `${DOG_CARD_PARAM}=`;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : null;
}

// A bare code, a whole pasted link, or a file's contents.
export function normalizeDogCardInput(input) {
  const raw = String(input ?? '').trim();
  const at = raw.indexOf(`#${DOG_CARD_PARAM}=`);
  return at === -1 ? raw : raw.slice(at + DOG_CARD_PARAM.length + 2);
}

// Decompress → parse → rebuild by name. Unknown keys are dropped (a later version's
// card still reads), anything malformed throws a DogCardError, never half-applies.
export function decodeDogCard(input) {
  const payload = normalizeDogCardInput(input);
  if (!payload) throw new DogCardError(BAD_CARD);
  let parsed;
  try {
    parsed = JSON.parse(decompressFromEncodedURIComponent(payload) || '');
  } catch {
    throw new DogCardError(BAD_CARD);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.kennels) || !Array.isArray(parsed.dogs)) {
    throw new DogCardError(isPublicId(parsed?.publicId)
      ? 'That is a kennel card, not a dog card. Add it from Kennels → Add from a card.'
      : BAD_CARD);
  }

  const kennels = parsed.kennels.map((k) => assertOnlyKeys({
    ref: text(k?.ref),
    publicId: isPublicId(k?.publicId) ? text(k.publicId) : '',
    kennelName: text(k?.kennelName),
    prefix: text(k?.prefix),
    location: text(k?.location),
    website: text(k?.website)
  }, KENNEL_KEYS, 'kennel'));
  const refs = new Set(kennels.map((k) => k.ref));
  const from = kennels.find((k) => k.ref === text(parsed.from));
  if (!from || !from.publicId || !from.kennelName) throw new DogCardError(BAD_CARD);
  if (kennels.some((k) => !k.ref || !k.kennelName)) throw new DogCardError(BAD_CARD);

  const seen = new Set();
  const dogs = parsed.dogs.map((d) => {
    const publicId = text(d?.publicId);
    if (!isDogPublicId(publicId) || seen.has(publicId)) throw new DogCardError(BAD_CARD);
    seen.add(publicId);
    const entry = { publicId, sent: d.sent === true, status: text(d.status) };
    for (const { card, kind } of DOG_FIELDS) entry[card] = cardValue(kind, d[card]);
    entry.sirePublicId = isDogPublicId(d.sirePublicId) ? text(d.sirePublicId) : '';
    entry.damPublicId = isDogPublicId(d.damPublicId) ? text(d.damPublicId) : '';
    entry.breederKennelRef = refs.has(text(d.breederKennelRef)) ? text(d.breederKennelRef) : '';
    entry.events = (Array.isArray(d.events) && entry.sent ? d.events : [])
      .filter((e) => SHARED_EVENT_TYPES.includes(e?.type) && isYmd(text(e?.date)) && text(e?.ref))
      .map((e) => {
        const details = {};
        for (const key of detailKeys(e.type)) if (text(e.details?.[key])) details[key] = text(e.details[key]);
        return assertOnlyKeys({ ref: text(e.ref), type: e.type, date: text(e.date), title: text(e.title), details }, EVENT_KEYS, 'event');
      });
    if (!entry.callName && !entry.registeredName) throw new DogCardError(BAD_CARD);
    return assertOnlyKeys(entry, DOG_KEYS, 'dog');
  });
  for (const d of dogs) {
    if (!seen.has(d.sirePublicId)) d.sirePublicId = '';
    if (!seen.has(d.damPublicId)) d.damPublicId = '';
  }
  if (!dogs.some((d) => d.sent)) throw new DogCardError(BAD_CARD);

  return assertOnlyKeys({
    cardVersion: Number(parsed.cardVersion) || 1, issuedAt: text(parsed.issuedAt), from: from.ref, kennels, dogs
  }, CARD_KEYS, 'card');
}

// --- Matching and the diff ---------------------------------------------------

const lower = (v) => text(v).toLowerCase();
const fromKennelOf = (card) => card.kennels.find((k) => k.ref === card.from);
const asKennelCard = (k) => ({ cardVersion: 1, publicId: k.publicId, kennelName: k.kennelName, prefix: k.prefix, location: k.location, website: k.website, issuedAt: '' });

// The card fields that would change on `existing` (blank on the card = not supplied).
export function dogChanges(cardDog, existing) {
  const out = [];
  for (const { card, field, label, kind } of DOG_FIELDS) {
    const to = cardDog[card];
    if (!supplied(kind, to) || sameValue(kind, to, existing[field])) continue;
    out.push({ field, label, from: existing[field], to });
  }
  if (cardDog.status === 'deceased' && existing.status !== 'deceased') out.push({ field: 'status', label: 'Status', from: existing.status, to: 'deceased' });
  return out;
}

// Dogs of hers that look like this one, for her to link to (never automatic): the
// same registration number, else the same registered name, else the same call name,
// sex and breed. Dogs already carrying a public id are someone else's match.
function lookalikes(cardDog, all) {
  const free = all.filter((d) => !d.public_id && !d.is_archived);
  const num = lower(cardDog.registrationNumber);
  if (num) {
    const hits = free.filter((d) => lower(d.registration_number) === num);
    if (hits.length) return hits;
  }
  const reg = lower(cardDog.registeredName);
  if (reg) {
    const hits = free.filter((d) => lower(d.registered_name) === reg);
    if (hits.length) return hits;
  }
  const call = lower(cardDog.callName);
  return call ? free.filter((d) => lower(d.call_name) === call && d.sex === cardDog.sex && lower(d.breed) === lower(cardDog.breed)) : [];
}

// An ancestor's automatic match: the same registry and registration number, both given.
const sameRegistration = (cardDog, d) => !d.public_id && text(cardDog.registry) && text(cardDog.registrationNumber)
  && lower(d.registry) === lower(cardDog.registry) && lower(d.registration_number) === lower(cardDog.registrationNumber);

async function eventPlan(cardDog, existing) {
  const mine = existing ? await eventRepo.getForSubject('dog', existing.id, { includeArchived: true }) : [];
  const byRef = new Map(mine.filter((e) => e.shared_ref).map((e) => [e.shared_ref, e]));
  let added = 0, changed = 0;
  for (const e of cardDog.events) {
    const have = byRef.get(`${cardDog.publicId}:${e.ref}`);
    if (!have) added++;
    else if (eventPatch(e, have)) changed++;
  }
  return { added, changed };
}

function eventPatch(e, have) {
  const patch = {};
  if (have.event_date !== e.date) patch.event_date = e.date;
  const title = e.title || descriptor(EVENT_TYPES, e.type)?.label || e.type;
  if (have.title !== title) patch.title = title;
  const details = { ...(have.details || {}) };
  let detailsChanged = false;
  for (const key of detailKeys(e.type)) {
    const to = e.details[key] ?? '';
    if (to && text(details[key]) !== to) { details[key] = to; detailsChanged = true; }
  }
  if (detailsChanged) patch.details = details;
  return Object.keys(patch).length ? patch : null;
}

// --- Preview: writes nothing -------------------------------------------------
//
// → { from, dogs, ancestors }
//   from: previewKennelCard's answer for the sending kennel ('own' refuses the card).
//   dogs: one per dog sent: { cardDog, action, existing, changes, candidates, events }
//     action 'create' | 'update' | 'unchanged' | 'adopt' (she has it as a pedigree-only
//     ancestor, from an earlier card; it becomes one of her dogs).
//   ancestors: { total, added, matched }.
export async function previewDogCard(card) {
  const from = await previewKennelCard(asKennelCard(fromKennelOf(card)));
  const all = await dogRepo.getAll({ includeArchived: true, includePedigreeOnly: true });
  const byPublicId = new Map(all.filter((d) => d.public_id).map((d) => [d.public_id, d]));

  const dogs = [];
  for (const cardDog of card.dogs.filter((d) => d.sent)) {
    const existing = byPublicId.get(cardDog.publicId) || null;
    const events = await eventPlan(cardDog, existing);
    if (!existing) {
      dogs.push({ cardDog, action: 'create', existing: null, changes: [], candidates: lookalikes(cardDog, all), events });
      continue;
    }
    const changes = dogChanges(cardDog, existing);
    const action = existing.pedigree_only ? 'adopt' : changes.length || events.added || events.changed ? 'update' : 'unchanged';
    dogs.push({ cardDog, action, existing, changes, candidates: [], events });
  }

  const ancestors = { total: 0, added: 0, matched: 0 };
  for (const cardDog of card.dogs.filter((d) => !d.sent)) {
    ancestors.total++;
    if (byPublicId.has(cardDog.publicId) || all.some((d) => sameRegistration(cardDog, d))) ancestors.matched++;
    else ancestors.added++;
  }
  return { from, dogs, ancestors };
}

// --- Apply --------------------------------------------------------------------
//
// choices:
//   fromLinkToId  — an unlinked outside kennel of hers to attach the sending kennel to
//   holding       — 'co_owned' (with the contact, in one of her kennels) or 'external'
//                   (owned by the contact); how NEW dogs are held
//   contactId     — the contact, or newContactName to add one (affiliated with the
//                   sending kennel)
//   kennelId      — her own kennel the co-owned dogs go in
//   dogs          — { [publicId]: { linkToId, livesWith: 'them' | 'me', skip } }
// → { kennel, contact, created, updated, linked, unchanged, ancestorsAdded, eventsAdded, eventsUpdated }
export async function applyDogCard(card, choices = {}) {
  const preview = await previewDogCard(card);
  if (preview.from.action === 'own') {
    throw new DogCardError('This card was sent from one of your own kennels, so there is nothing to add.');
  }
  // Every choice is checked before anything is written.
  const holding = choices.holding === 'external' ? 'external' : 'co_owned';
  const newDogs = preview.dogs.filter((p) => (p.action === 'create' || p.action === 'adopt') && !choices.dogs?.[p.cardDog.publicId]?.skip && !choices.dogs?.[p.cardDog.publicId]?.linkToId);
  let contact = null;
  if (newDogs.length) {
    if (choices.contactId) contact = await contactRepo.getById(choices.contactId);
    if (!contact && !text(choices.newContactName)) throw new DogCardError(holding === 'external' ? 'Pick who owns these dogs.' : 'Pick who you co-own these dogs with.');
    if (holding === 'co_owned') {
      const own = choices.kennelId ? await kennelRepo.getById(choices.kennelId) : null;
      if (!own?.is_own_kennel) throw new DogCardError('Pick which of your kennels these dogs belong to.');
    }
  }
  const { kennel: fromKennel } = await applyKennelCard(asKennelCard(fromKennelOf(card)), { linkToId: choices.fromLinkToId || null });
  if (newDogs.length && !contact) contact = await contactRepo.create({ name: text(choices.newContactName), kennel_id: fromKennel.id });

  // Kennels the dogs name as their breeder: by public id (Kennel Card rules), else by name.
  const kennelIds = new Map([[card.from, fromKennel.id]]);
  for (const k of card.kennels) {
    if (kennelIds.has(k.ref)) continue;
    if (k.publicId) {
      const hit = await kennelRepo.getByPublicId(k.publicId);
      kennelIds.set(k.ref, hit ? hit.id : (await applyKennelCard(asKennelCard(k))).kennel.id);
    } else {
      kennelIds.set(k.ref, (await kennelRepo.findOrCreateOutside(k.kennelName)).kennel.id);
    }
  }

  const all = await dogRepo.getAll({ includeArchived: true, includePedigreeOnly: true });
  const local = new Map(); // public id → local dog id
  for (const d of all) if (d.public_id) local.set(d.public_id, d.id);
  const result = { kennel: fromKennel, contact, created: 0, updated: 0, linked: 0, unchanged: 0, ancestorsAdded: 0, eventsAdded: 0, eventsUpdated: 0 };

  const cardFields = (cardDog) => {
    const out = {};
    for (const { card: key, field, kind } of DOG_FIELDS) if (supplied(kind, cardDog[key])) out[field] = cardDog[key];
    const breeder = kennelIds.get(cardDog.breederKennelRef);
    if (breeder) out.breeder_kennel_id = breeder;
    return out;
  };
  const updateFrom = async (cardDog, existing, { onlyBlank = false } = {}) => {
    const patch = {};
    for (const { field } of dogChanges(cardDog, existing)) {
      const v = field === 'status' ? 'deceased' : cardDog[DOG_FIELDS.find((f) => f.field === field).card];
      if (onlyBlank && !(existing[field] == null || existing[field] === '' || (Array.isArray(existing[field]) && !existing[field].length))) continue;
      patch[field] = v;
    }
    const breeder = kennelIds.get(cardDog.breederKennelRef);
    if (breeder && !existing.breeder_kennel_id) patch.breeder_kennel_id = breeder;
    if (!existing.public_id) patch.public_id = cardDog.publicId;
    return Object.keys(patch).length ? dogRepo.update(existing.id, patch) : existing;
  };

  // Ancestors first, so the dogs sent find their parents; each as its own pedigree-only
  // dog unless she has it already (by public id, or the same registry and number).
  for (const cardDog of card.dogs.filter((d) => !d.sent)) {
    const byId = local.get(cardDog.publicId);
    const existing = byId ? all.find((d) => d.id === byId) : all.find((d) => sameRegistration(cardDog, d));
    if (existing) {
      await updateFrom(cardDog, existing, { onlyBlank: !byId });
      local.set(cardDog.publicId, existing.id);
    } else {
      const made = await dogRepo.createPedigreeOnly({ ...cardFields(cardDog), public_id: cardDog.publicId, sex: cardDog.sex || 'unknown', breed: cardDog.breed || 'Unknown' });
      local.set(cardDog.publicId, made.id);
      result.ancestorsAdded++;
    }
  }

  for (const p of preview.dogs) {
    const { cardDog } = p;
    const pick = choices.dogs?.[cardDog.publicId] || {};
    if (pick.skip && (p.action === 'create' || p.action === 'adopt')) continue;
    let dog;
    if (p.action === 'update' || p.action === 'unchanged') {
      dog = await updateFrom(cardDog, p.existing);
      result[p.action === 'update' ? 'updated' : 'unchanged']++;
    } else if (pick.linkToId) {
      const target = all.find((d) => d.id === pick.linkToId);
      if (!target || target.public_id) throw new DogCardError('That dog is already linked to another card, or is no longer on this device.');
      dog = await updateFrom(cardDog, target);
      result.linked++;
    } else {
      const held = holding === 'external'
        ? { ownership_type: 'external', owner_contact_id: contact.id, kennel_id: fromKennel.id, co_owner_contact_ids: [], lives_with_contact_id: null }
        : { ownership_type: 'co_owned', kennel_id: choices.kennelId, co_owner_contact_ids: [contact.id], lives_with_contact_id: pick.livesWith === 'me' ? null : contact.id };
      const status = cardDog.status && cardDog.status !== 'external_reference' ? cardDog.status : 'active_breeding';
      if (p.action === 'adopt') {
        dog = await dogRepo.update(p.existing.id, { ...cardFields(cardDog), ...held, status, pedigree_only: false });
      } else {
        dog = await dogRepo.create({ ...cardFields(cardDog), ...held, status, public_id: cardDog.publicId });
      }
      result.created++;
    }
    local.set(cardDog.publicId, dog.id);
    const counts = await applyEvents(cardDog, dog.id);
    result.eventsAdded += counts.added;
    result.eventsUpdated += counts.changed;
  }

  // Parents last, now every dog on the card has a local id. Only filled in where hers
  // is blank: a parent she set herself stays.
  for (const cardDog of card.dogs) {
    const id = local.get(cardDog.publicId);
    if (!id) continue;
    const dog = await dogRepo.getById(id);
    const patch = {};
    const sire = local.get(cardDog.sirePublicId);
    const dam = local.get(cardDog.damPublicId);
    if (sire && !dog.sire_id) patch.sire_id = sire;
    if (dam && !dog.dam_id) patch.dam_id = dam;
    if (Object.keys(patch).length) await dogRepo.update(id, patch);
  }
  return result;
}

async function applyEvents(cardDog, dogId) {
  const mine = await eventRepo.getForSubject('dog', dogId, { includeArchived: true });
  const byRef = new Map(mine.filter((e) => e.shared_ref).map((e) => [e.shared_ref, e]));
  let added = 0, changed = 0;
  for (const e of cardDog.events) {
    const ref = `${cardDog.publicId}:${e.ref}`;
    const have = byRef.get(ref);
    if (have) {
      const patch = eventPatch(e, have);
      if (patch) { await eventRepo.update(have.id, patch); changed++; }
      continue;
    }
    await eventRepo.create({
      subject_type: 'dog', subject_id: dogId, event_type: e.type, event_date: e.date,
      title: e.title || descriptor(EVENT_TYPES, e.type)?.label || e.type,
      details: { ...e.details }, shared_ref: ref
    });
    added++;
  }
  return { added, changed };
}

// For the send screen: the dogs she can put on a card (not pedigree-only ancestors,
// not archived), and a dog's name for lists.
export async function sendableDogs() {
  return (await dogRepo.getAll()).filter((d) => !d.pedigree_only);
}
export { dogName };
