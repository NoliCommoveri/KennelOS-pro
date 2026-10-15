// guidedPeople.js — Kels's "Add people" task (Pro: contacts), its data half (the
// screens are assets/guidedPeopleUI.js, drawn by the shared step engine
// assets/kelsSteps.js). Several people in one go, the way Add dogs takes dogs:
//   1. Who are we adding? One row per person: name and what they are to her.
//   2. Her vet, when nobody on the list or in her contacts is one: "Do you have
//      a vet you'd like to add?" (a new one joins the list; one in her contacts
//      is tagged Vet).
//   3. With more than one person, how she met them, asked once.
//   4. Each person's details; then, if someone in her contacts may be them
//      (contactSearch: the same email or phone, or a near name), "Is this them?"
//      One on file gets what's missing filled in, never overwritten.
//   5. Each breeder's kennel: one she has, or a new outside kennel.
//   6. Breeders already in her contacts with no kennel: theirs, if she knows it.
//   7. One review she approves before anything is written.
// After the save (assets/guidedPeopleUI.js): her dogs with no breeder kennel, to
// link to the kennels from this run or another she has; then, with the waitlist,
// a buyer put on it (assets/kelsApplicant.js), linked to their new contact.
//
// Three parts, as in guidedDogs.js: the DRAFT (kept after every step through
// settings.js), pure helpers (steps, checks, review), and saveGuidedPeople(), the
// writes, every one through the repos. The save is RESUMABLE: each record's id
// goes back on the draft as it's made, so a retry never makes anything twice.
import { contactRepo } from './contactRepo.js';
import { kennelRepo } from './kennelRepo.js';
import { CONTACT_TYPE, descriptor } from './vocab.js';
import { SCOPED_OWNERSHIP } from './kennelScope.js';
import { findContactMatches, contactMatchReason, hasVet, isVet, normName } from './contactSearch.js';
import { similarNamed } from './dogSearch.js';

export const DRAFT_VERSION = 1;
export const MAX_PEOPLE = 20;

// The types she picks from on the roster (a handler is tagged by a show event).
export const ROSTER_TYPES = CONTACT_TYPE.filter((t) => t.value !== 'handler');

const blank = (v) => v == null || String(v).trim() === '';
const trimmed = (v) => (blank(v) ? '' : String(v).trim());
const key = () => (globalThis.crypto?.randomUUID?.() || `k${Math.random().toString(36).slice(2)}`);

// The details asked about each person, as the Contact page's fields.
export const DETAIL_FIELDS = ['phone', 'email', 'address', 'facebook_profile', 'first_contact_source', 'notes'];

export const noKennel = () => ({ has: '', kennelId: null, kennelName: '' });

export function newPerson(fields = {}) {
  return {
    key: key(),
    name: '', type: '', types: [],
    phone: '', email: '', address: '', facebook_profile: '', first_contact_source: '', notes: '',
    // Contacts on file that may be this one (matchIds, for the details in
    // `matchesFor`), and her answer: null = not asked, 'none' = someone new,
    // else the contact's id (filled in where blank).
    matchIds: [], matchesFor: null, match: null,
    // Their kennel (a breeder): '' = not asked, 'yes' (one she has, or a new
    // name), 'no'.
    kennel: noKennel(),
    // Added from the vet question, not the roster.
    fromVet: false,
    id: null, saved: false,
    ...fields
  };
}

export function emptyDraft() {
  const now = new Date().toISOString();
  return {
    v: DRAFT_VERSION,
    startedAt: now,
    updatedAt: now,
    step: null,
    label: '',
    history: [],
    people: [newPerson()],
    common: { first_contact_source: '' },
    applied: {},
    // The vet question: answer '' (not asked) | 'add' (a new vet, `name`) |
    // 'onfile' (one in her contacts, `contactId`, tagged Vet) | 'no'.
    vet: { answer: '', name: '', contactId: null },
    // Breeders on file with no kennel: contact id → { kennelId, kennelName } she gave.
    existing: {},
    saved: {},
    done: false
  };
}

export const personLabel = (p) => trimmed(p.name) || 'this person';
export const isBreeder = (p) => (p.types || []).includes('breeder');
export const isFillIn = (p) => Boolean(p.match && p.match !== 'none');
const isEmptyRow = (p) => blank(p.name) && !p.type;

// --- The vet question ------------------------------------------------------------

// Ask about a vet when nobody on the list is one and none of her contacts is
// (contactSearch.hasVet, the tidy-up's rule); once answered, the question stays.
export function asksVet(draft, contacts = []) {
  if (draft.vet.answer) return true;
  const listed = draft.people.some((p) => !p.fromVet && (p.type === 'vet' || (p.types || []).includes('vet')));
  return !listed && !hasVet(contacts);
}

// After the vet question: "Yes, add my vet" puts a vet on the list (last), any
// other answer takes one the question added off it.
export function afterVet(draft) {
  const added = draft.people.find((p) => p.fromVet);
  if (draft.vet.answer === 'add') {
    if (added) added.name = trimmed(draft.vet.name);
    else draft.people.push(newPerson({ name: trimmed(draft.vet.name), type: 'vet', types: ['vet'], fromVet: true }));
  } else if (added) {
    draft.people = draft.people.filter((p) => p !== added);
  }
  return draft;
}

// --- The roster -------------------------------------------------------------------

// After the roster: empty rows dropped; each person's main type is among their
// types (a type she took off there comes off).
export function afterRoster(draft) {
  draft.people = draft.people.filter((p) => !isEmptyRow(p));
  const prev = draft.rosterTypes || {};
  for (const p of draft.people) {
    const was = prev[p.key];
    let types = (p.types || []).filter((t) => t !== was || t === p.type);
    if (p.type && !types.includes(p.type)) types = [p.type, ...types];
    p.types = types;
  }
  draft.rosterTypes = Object.fromEntries(draft.people.map((p) => [p.key, p.type]));
  return draft;
}

// How she met them, from the common answer: a blank one, or one still holding the
// last common answer, takes the new one. Her own changes on a person are kept.
export function fillFromCommon(draft) {
  const c = draft.common.first_contact_source;
  const prev = draft.applied.first_contact_source;
  if (!blank(c)) {
    for (const p of draft.people) if (blank(p.first_contact_source) || p.first_contact_source === prev) p.first_contact_source = c;
  }
  draft.applied = { first_contact_source: c };
  return draft;
}

// After each person's details: the contacts on file that may be them (up to six,
// surest first). The same details keep her earlier answer; changed ones ask again.
export const MAX_MATCHES = 6;
export function findMatchesFor(p, contacts, draft) {
  const typed = { name: p.name, email: p.email, phone: p.phone };
  const asked = JSON.stringify(typed);
  if (p.matchesFor === asked) return p;
  p.matchesFor = asked;
  p.match = null;
  // Someone another person on the list already is, isn't offered again.
  const taken = draft.people.filter((x) => x !== p && isFillIn(x)).map((x) => x.match);
  p.matchIds = findContactMatches(typed, contacts, { excludeIds: taken }).slice(0, MAX_MATCHES).map((m) => m.contact.id);
  return p;
}

// The matches to show for her answer, in the order they were found.
export function findMatchesForShow(p, contacts) {
  const all = findContactMatches({ name: p.name, email: p.email, phone: p.phone }, contacts);
  return (p.matchIds || []).map((id) => all.find((m) => m.contact.id === id)).filter(Boolean);
}

// The draft's name on the menu: "Pat, Lee and Dr. Ames".
export function draftLabel(draft) {
  const names = (draft?.people || []).map((p) => trimmed(p.name)).filter(Boolean);
  if (!names.length) return '';
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// An unfinished draft Kels can offer to finish (settings.getGuidedPeopleDraft()),
// or null: none, finished, or from an older version.
export const pendingPeopleDraft = (draft) => (draft && draft.v === DRAFT_VERSION && !draft.done ? draft : null);

// --- Steps --------------------------------------------------------------------------

// Breeders in her contacts with no kennel, not someone on this list.
export function breedersWithoutKennel(draft, contacts = []) {
  const onList = new Set(draft.people.filter(isFillIn).map((p) => p.match));
  return contacts.filter((c) => !c.is_archived && isBreeder({ types: c.contact_type }) && !c.kennel_id && !onList.has(c.id))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

// A breeder's kennel is asked unless the contact they are on file has one.
const asksKennel = (p, contactsById) => isBreeder(p) && !(isFillIn(p) && contactsById.get(p.match)?.kennel_id);

// ctx: { contacts (on file, live) }. Steps for each person are keyed by their place.
export function stepsFor(draft, ctx = {}) {
  const contacts = ctx.contacts || [];
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const steps = ['roster'];
  if (asksVet(draft, contacts)) steps.push('vet');
  if (draft.people.length > 1) steps.push('common');
  draft.people.forEach((p, i) => {
    steps.push(`person:${i}`);
    if (p.matchIds?.length) steps.push(`match:${i}`);
    if (asksKennel(p, byId)) steps.push(`kennel:${i}`);
  });
  if (breedersWithoutKennel(draft, contacts).length) steps.push('breeders');
  steps.push('review');
  return steps;
}

export const stepIndex = (step) => Number(step.split(':')[1]);

// A check she can tap past (kelsSteps): asked once per key.
const check = (draft, k, message) => (draft.warned?.[k] ? null : { key: k, message });
const looksLikeEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed(s));

// One plain-language problem with the step's answers, or null when it's fine.
// ctx: { contacts, outsideKennels }.
export function stepProblem(step, draft, ctx = {}) {
  if (step === 'roster') {
    const rows = draft.people.filter((p) => !isEmptyRow(p) && !p.fromVet);
    if (!rows.length && !draft.people.some((p) => p.fromVet)) return 'Type the name of someone you\'re adding.';
    if (rows.length > MAX_PEOPLE) return `I can add up to ${MAX_PEOPLE} people at a time.`;
    if (rows.find((p) => blank(p.name))) return 'Type a name for each person, or take that row off.';
    const noType = rows.find((p) => !p.type);
    if (noType) return `What is ${trimmed(noType.name)} to you?`;
    const seen = new Set();
    for (const p of draft.people) {
      const n = normName(p.name);
      if (seen.has(n)) return `${trimmed(p.name)} is on the list twice. Take one off, or tell them apart.`;
      seen.add(n);
    }
    return null;
  }
  if (step === 'vet') {
    const v = draft.vet;
    if (!v.answer) return 'Tap one of the choices.';
    if (v.answer === 'add' && blank(v.name)) return 'Who\'s your vet? The clinic or the vet\'s name both work.';
    if (v.answer === 'onfile' && !v.contactId) return 'Pick your vet from your contacts.';
    if (v.answer === 'add' && draft.people.some((p) => !p.fromVet && normName(p.name) === normName(v.name))) {
      return `${trimmed(v.name)} is already on the list. Tap Back and make them a vet there.`;
    }
    return null;
  }
  if (step === 'common' || step === 'review' || step === 'breeders') return null;
  const p = draft.people[stepIndex(step)];
  if (!p) return null;
  const name = personLabel(p);
  if (step.startsWith('match:')) return p.match ? null : 'Tap one of the choices.';
  if (step.startsWith('person:')) {
    if (!(p.types || []).length) return `What is ${name} to you? Tick at least one.`;
    if (!blank(p.email) && !looksLikeEmail(p.email)) {
      const c = check(draft, `email:${p.key}:${trimmed(p.email)}`, `"${trimmed(p.email)}" doesn't look like an email address.`);
      if (c) return c;
    }
    return null;
  }
  if (step.startsWith('kennel:')) {
    const k = p.kennel;
    if (!k.has) return 'Tap one of the choices.';
    if (k.has !== 'yes') return null;
    if (!k.kennelId && blank(k.kennelName)) return 'Pick their kennel, or type its name.';
    if (!k.kennelId) {
      const like = similarNamed(ctx.outsideKennels || [], k.kennelName, (x) => x.kennel_name);
      if (like) { const c = check(draft, `kennel:${p.key}:${normName(k.kennelName)}`, `Is that ${like.kennel_name}, already in your kennels? Pick it from the list if so.`); if (c) return c; }
    }
    return null;
  }
  return null;
}

// --- Review ---------------------------------------------------------------------------

const typeLabels = (types) => (types || []).map((t) => descriptor(CONTACT_TYPE, t).label).join(', ');

// Their kennel, as she'd say it. names: { kennel(id) }.
export function kennelText(k, names = {}) {
  if (!k || k.has !== 'yes') return '';
  return k.kennelId ? (names.kennel?.(k.kennelId) || 'a kennel on file') : `${trimmed(k.kennelName)} (a new kennel)`;
}

// One section per person: { title, lines, steps }, then the vet on file and the
// breeders' kennels. names: { contact(id), kennel(id) }.
export function reviewSections(draft, names = {}) {
  const sections = draft.people.map((p, i) => {
    const lines = [`${typeLabels(p.types)}.`];
    const reach = [trimmed(p.phone), trimmed(p.email)].filter(Boolean);
    if (reach.length) lines.push(`${reach.join(', ')}.`);
    if (!blank(p.address)) lines.push(`${trimmed(p.address).replace(/\s*\n\s*/g, ', ')}.`);
    if (!blank(p.facebook_profile)) lines.push(`Facebook: ${trimmed(p.facebook_profile)}.`);
    if (!blank(p.first_contact_source)) lines.push(`Met through ${trimmed(p.first_contact_source)}.`);
    const k = kennelText(p.kennel, names);
    if (k) lines.push(`Kennel: ${k}.`);
    if (!blank(p.notes)) lines.push(`Notes: ${trimmed(p.notes)}`);
    return {
      title: isFillIn(p) ? `${personLabel(p)} (in your contacts: filling in what's missing)` : personLabel(p),
      lines,
      steps: { details: `person:${i}`, ...(isBreeder(p) ? { kennel: `kennel:${i}` } : {}) }
    };
  });
  const extra = [];
  if (draft.vet.answer === 'onfile' && draft.vet.contactId) extra.push(`${names.contact?.(draft.vet.contactId) || 'Your contact'} becomes your vet.`);
  for (const [id, k] of Object.entries(draft.existing || {})) {
    const text = kennelText({ has: k.kennelId || !blank(k.kennelName) ? 'yes' : '', ...k }, names);
    if (text) extra.push(`${names.contact?.(id) || 'A breeder'}'s kennel: ${text}.`);
  }
  if (extra.length) sections.push({ title: 'In your contacts already', lines: extra, steps: { details: draft.vet.answer === 'onfile' ? 'vet' : 'breeders' } });
  return sections;
}

// --- Saving -----------------------------------------------------------------------------

function contactFields(p) {
  const fields = { name: trimmed(p.name), contact_type: [...(p.types || [])] };
  for (const k of DETAIL_FIELDS) if (!blank(p[k])) fields[k] = k === 'notes' || k === 'address' ? String(p[k]).trim() : trimmed(p[k]);
  return fields;
}

// A kennel answer → its id: one she picked, or an outside kennel by that name
// (kennelRepo.findOrCreateOutside: one on file of that name, else a new one).
// New ones go on `s.kennels`, so one name for two people is one kennel.
async function kennelFor(k, s, step) {
  if (k.kennelId) return k.kennelId;
  if (blank(k.kennelName)) return null;
  const n = normName(k.kennelName);
  if (!s.kennels[n]) {
    const { kennel, created } = await kennelRepo.findOrCreateOutside(k.kennelName);
    s.kennels[n] = kennel.id;
    if (created) await step();
  }
  return s.kennels[n];
}

// Write everything the review listed: each person (made, or one on file filled in
// where blank, their types added), their kennel; her vet on file tagged; the
// breeders on file linked to their kennels. `onProgress(draft)` runs after every
// write so the UI keeps the draft (and its saved ids) current.
// → { people: [contact ids], kennelIds: [kennels made or linked in this run] }.
export async function saveGuidedPeople(draft, { onProgress = () => {} } = {}) {
  const s = draft.saved || (draft.saved = {});
  s.kennels = s.kennels || {};
  s.kennelIds = s.kennelIds || [];
  s.existing = s.existing || {};
  const step = async () => { draft.updatedAt = new Date().toISOString(); await onProgress(draft); };
  const linked = (id) => { if (id && !s.kennelIds.includes(id)) s.kennelIds.push(id); };

  for (const p of draft.people) {
    if (p.id && p.saved) continue;
    const fields = contactFields(p);
    const kennelId = p.kennel.has === 'yes' && isBreeder(p) ? await kennelFor(p.kennel, s, step) : null;
    if (kennelId) fields.kennel_id = kennelId;
    if (isFillIn(p)) {
      const on = await contactRepo.getById(p.match);
      const changes = Object.fromEntries(Object.entries(fields).filter(([k, v]) => k !== 'contact_type' && k !== 'name' && !blank(v) && blank(on?.[k])));
      const types = [...new Set([...(on?.contact_type || []), ...fields.contact_type])];
      if (types.length !== (on?.contact_type || []).length) changes.contact_type = types;
      if (Object.keys(changes).length) await contactRepo.update(p.match, changes);
      p.id = p.match;
      if (changes.kennel_id) linked(changes.kennel_id);
    } else if (!p.id) {
      p.id = (await contactRepo.create(fields)).id;
      linked(kennelId);
    } else {
      await contactRepo.update(p.id, fields);
      linked(kennelId);
    }
    p.saved = true;
    await step();
  }

  if (draft.vet.answer === 'onfile' && draft.vet.contactId && !s.vetTagged) {
    await contactRepo.ensureType(draft.vet.contactId, 'vet');
    s.vetTagged = true;
    await step();
  }

  for (const [id, k] of Object.entries(draft.existing || {})) {
    if (s.existing[id]) continue;
    const kennelId = await kennelFor(k, s, step);
    if (kennelId) {
      const c = await contactRepo.getById(id);
      if (c && !c.kennel_id) { await contactRepo.update(id, { kennel_id: kennelId }); linked(kennelId); }
    }
    s.existing[id] = true;
    await step();
  }

  draft.done = true;
  await step();
  return { people: draft.people.map((p) => p.id).filter(Boolean), kennelIds: [...s.kennelIds] };
}

// --- After the save: the dogs they bred ---------------------------------------------------

// Her dogs (owned / co-owned, not pedigree-only, not archived) with no breeder kennel.
export const dogsWithoutBreeder = (dogs = []) => dogs
  .filter((d) => !d.is_archived && !d.pedigree_only && SCOPED_OWNERSHIP.has(d.ownership_type) && !d.breeder_kennel_id);

// The kennels she can pick as a dog's breeder: the ones from this run first, then
// every other outside kennel she has. Never her own (a dog she bred is the litter
// task's). → [{ kennel, fromRun }].
export function breederKennelChoices(kennels = [], runIds = []) {
  const outside = kennels.filter((k) => !k.is_archived && !k.is_own_kennel);
  const byName = (a, b) => (a.kennel_name || '').localeCompare(b.kennel_name || '');
  const run = runIds.map((id) => outside.find((k) => k.id === id)).filter(Boolean);
  const rest = outside.filter((k) => !runIds.includes(k.id)).sort(byName);
  return [...run.map((kennel) => ({ kennel, fromRun: true })), ...rest.map((kennel) => ({ kennel, fromRun: false }))];
}

// Only the dogs still without one, and only to an outside kennel she has: a
// breeder kennel already set is never changed here. picks: { dogId: kennelId }.
export function breederLinks(picks, dogs, kennels) {
  const open = new Set(dogsWithoutBreeder(dogs).map((d) => d.id));
  const allowed = new Set(breederKennelChoices(kennels).map((c) => c.kennel.id));
  return Object.entries(picks).filter(([dogId, kennelId]) => kennelId && open.has(dogId) && allowed.has(kennelId))
    .map(([dogId, kennelId]) => ({ dogId, kennelId }));
}

export { isVet, contactMatchReason };
