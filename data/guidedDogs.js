// guidedDogs.js — Kels's "Add dogs" task, its data half (the screens are
// assets/guidedDogsUI.js, drawn by the shared step engine assets/kelsSteps.js).
// Several dogs in one go, the way Record a new litter takes several puppies:
//   1. Who are we adding? One row per dog: name and boy or girl, "+ Another dog".
//   2. With more than one dog, what they have in common (breed, status, whose
//      dog, kennel), asked once and filled in on each dog to change.
//   3. Each dog's details; then, if a dog on file may be it (dogSearch: names
//      both ways, then the number, breed and birthday), "Is this her?" One of
//      hers gets what's missing filled in (never overwritten); a pedigree-only
//      one is brought into use with these details (the Dog page's "bring in").
//   4. Its parents (a dog on file, one of the dogs being added, or an ancestor
//      typed in, made pedigree-only), who bred it, then one review she
//      approves before anything is written.
//
// Three parts, as in guidedLitter.js: the DRAFT (kept after every step through
// settings.js), pure helpers (steps, checks, review), and saveGuidedDogs(), the
// writes, every one through the repos. The save is RESUMABLE: each record's id
// goes back on the draft as it's made, so a retry never makes anything twice.
// In Lite, the cap stops it: the dogs made so far are kept and linked, and the
// rest aren't added (the UI shows the upgrade notice).
import { dogRepo } from './dogRepo.js';
import { contactRepo } from './contactRepo.js';
import { kennelRepo, seedTestsKennel } from './kennelRepo.js';
import { resolveKennelIdForWrite, SCOPED_OWNERSHIP } from './kennelScope.js';
import { getMyContactId } from './settings.js';
import { CapExceededError } from './repoBase.js';
import { eventRepo } from './eventRepo.js';
import { expenseRepo } from './expenseRepo.js';
import { todayYMD, addMonthsToYMD } from './dateUtils.js';
import { SEX, DOG_STATUS, OWNERSHIP_TYPE, VACCINE_GOOD_FOR, descriptor, defaultExpenseCategoryFor } from './vocab.js';
import { fmt } from './guidedLitter.js';
import { findDogMatches, matchReason, nameKey, similarNamed, looksLikeNumber, normReg } from './dogSearch.js';

// 2: the match is asked after each dog's details (a version-1 draft is dropped).
export const DRAFT_VERSION = 2;
export const MAX_DOGS = 20;

// Statuses she can give a dog she's adding. A puppy belongs to a litter (Record
// a new litter); a pedigree-only dog is made from the parents step.
const ADDABLE_STATUSES = ['active_breeding', 'retired_breeding', 'pet_home', 'for_sale', 'deceased'];
const LITE_STATUSES = ['active_breeding', 'retired_breeding', 'deceased'];
export const statusChoices = ({ fullDogStatuses = true } = {}) =>
  DOG_STATUS.filter((s) => (fullDogStatuses ? ADDABLE_STATUSES : LITE_STATUSES).includes(s.value));

// Whose dog: hers, co-owned, or (where the edition has outside dogs) someone else's.
export const ownershipChoices = ({ externalOwnership = true } = {}) =>
  OWNERSHIP_TYPE.filter((o) => ['owned', 'co_owned', ...(externalOwnership ? ['external'] : [])].includes(o.value));

export const OWNER_REQUIRED = ['external'];

const blank = (v) => v == null || String(v).trim() === '';
const trimmed = (v) => (blank(v) ? '' : String(v).trim());
const norm = (s) => trimmed(s).toLowerCase().replace(/\s+/g, ' ');
const key = () => (globalThis.crypto?.randomUUID?.() || `k${Math.random().toString(36).slice(2)}`);

// The fields "what they have in common" fills in on each dog.
export const COMMON_FIELDS = ['breed', 'status', 'ownership_type', 'kennelId', 'ownerId', 'ownerName'];

export function emptyDraft() {
  const now = new Date().toISOString();
  return {
    v: DRAFT_VERSION,
    startedAt: now,
    updatedAt: now,
    step: null,
    label: '',
    history: [],
    dogs: [newDog()],
    common: { breed: '', status: 'active_breeding', ownership_type: 'owned', kennelId: null, ownerId: null, ownerName: '' },
    // The common answers last filled in on the dogs (fillFromCommon).
    applied: {},
    saved: {},
    done: false
  };
}

// A parent: '' = not known, 'dog:<id>' = a dog on file, 'batch:<key>' = one of
// the dogs being added, 'new' = an ancestor she typed, made pedigree-only: its
// registered name (`name`, as a pedigree names it), and if she knows them its
// registration number (`regNum`) and call name (`callName`).
const noParent = () => ({ pick: '', name: '', regNum: '', callName: '' });

// A typed parent, as dogSearch reads it.
const typedParent = (p, sex) => ({ registeredName: p.name, callName: p.callName, registrationNumber: p.regNum, sex });

// A typed parent whose registration number is a dog on file IS that dog: the
// pick becomes that dog. Run when the parents step is read. dogs: on file.
export function resolveTypedParents(d, dogs) {
  for (const [role, sex] of [['dam', 'female'], ['sire', 'male']]) {
    const p = d[role];
    if (p.pick !== 'new' || blank(p.regNum)) continue;
    const sure = findDogMatches(dogs, typedParent(p, sex)).find((m) => m.strength === 'certain');
    if (sure) d[role] = { ...noParent(), pick: `dog:${sure.dog.id}` };
  }
  return d;
}

export const noBreeder = () => ({
  bredBy: '', kennelId: null, kennelName: '', contactId: null, contactName: '', contactPhone: '', contactEmail: ''
});

export function newDog() {
  return {
    key: key(),
    call_name: '', sex: '', breed: '', date_of_birth: '', registered_name: '', registration_number: '',
    color_markings: '', microchip_id: '', status: '', ownership_type: '',
    ownerId: null, ownerName: '', kennelId: null,
    dam: noParent(), sire: noParent(),
    // Who bred it (`breeder:<i>`): '' = not asked or not sure, 'me' = her own
    // kennel, 'other' = another breeder: their kennel (one on file, or a new
    // name) and, where the edition has contacts, the breeder (picked, or new).
    breeder: noBreeder(),
    // Dogs on file that may be this one (matchIds, dogSearch, looked up for the
    // details in `matchesFor`), and her answer: null = not asked, 'none' = a
    // different dog, else the dog's id: one of hers is filled in where it's
    // blank; `bringIn`, a pedigree-only one, is brought into use.
    matchIds: [], matchesFor: null, match: null, bringIn: false,
    id: null, saved: false
  };
}

// A roster row she left empty (no name, no sex) is just dropped.
const isEmptyRow = (d) => blank(d.call_name) && !d.sex;

// Every dog on the roster is saved: made, brought in, or (a dog of hers she
// said it is) filled in where blank.
export const dogsToAdd = (draft) => draft.dogs;
export const isFillIn = (d) => Boolean(d.match && d.match !== 'none' && !d.bringIn);

export const dogLabel = (d) => trimmed(d.call_name) || 'this dog';

// After each dog's details: the dogs on file that may be it (dogSearch, up to
// six, surest first). The same details keep her earlier answer; changed ones ask
// again. dogsOnFile: pedigree-only dogs included.
export const MAX_MATCHES = 6;
export function findMatchesFor(d, dogsOnFile, draft) {
  const typed = {
    callName: d.call_name, registeredName: d.registered_name, registrationNumber: d.registration_number,
    breed: d.breed, dateOfBirth: d.date_of_birth, sex: d.sex
  };
  const asked = JSON.stringify(typed);
  if (d.matchesFor === asked) return d;
  d.matchesFor = asked;
  if (d.id && d.id === d.match) d.id = null; // the dog an earlier answer pointed at
  d.match = null;
  d.bringIn = false;
  // A dog another one on the roster already is, isn't offered again.
  const taken = draft.dogs.filter((x) => x !== d && x.match && x.match !== 'none').map((x) => x.match);
  d.matchIds = findDogMatches(dogsOnFile, typed, { excludeIds: taken }).slice(0, MAX_MATCHES).map((m) => m.dog.id);
  return d;
}

// After the roster: drop empty rows.
export function afterRoster(draft) {
  draft.dogs = draft.dogs.filter((d) => !isEmptyRow(d));
  // A parent pointing at a dog no longer in the batch is cleared.
  const keys = new Set(dogsToAdd(draft).map((d) => d.key));
  for (const d of draft.dogs) {
    for (const role of ['dam', 'sire']) {
      const p = d[role];
      if (p.pick.startsWith('batch:') && (!keys.has(p.pick.slice(6)) || p.pick.slice(6) === d.key)) d[role] = noParent();
    }
  }
  return draft;
}

// Fill each dog's fields from what they have in common: a blank field, or one
// still holding the last common answer, takes the new one. Her own changes on a
// dog are kept. Run after the roster too, so a lone dog gets the defaults.
export function fillFromCommon(draft) {
  const c = draft.common;
  const prev = draft.applied || {};
  for (const d of draft.dogs) {
    for (const k of COMMON_FIELDS) {
      if (blank(c[k])) continue;
      if (blank(d[k]) || d[k] === prev[k]) d[k] = c[k];
    }
    // Only someone else's dog has an owner to ask about.
    if (!OWNER_REQUIRED.includes(d.ownership_type)) { d.ownerId = null; d.ownerName = ''; }
  }
  draft.applied = Object.fromEntries(COMMON_FIELDS.map((k) => [k, c[k]]));
  return draft;
}

// --- Steps --------------------------------------------------------------------

// ctx: { multiKennel (she has more than one own kennel, so a dog of hers is
// asked which) }. Steps for each dog are keyed by its place in draft.dogs.
export function stepsFor(draft) {
  const steps = ['roster'];
  if (draft.dogs.length > 1) steps.push('common');
  draft.dogs.forEach((d, i) => {
    steps.push(`dog:${i}`);
    if (d.matchIds?.length) steps.push(`match:${i}`);
    steps.push(`parents:${i}`, `breeder:${i}`);
  });
  steps.push('review');
  return steps;
}

export const stepIndex = (step) => Number(step.split(':')[1]);

// A check she can tap past (kelsSteps): asked once per key, so changing what
// she typed asks again. People put things in the wrong box and misspell names;
// these catch the likely slip without stopping her.
const check = (draft, key, message) => (draft.warned?.[key] ? null : { key, message });

// How many roster rows she may have: MAX_DOGS, or fewer where the edition caps
// dogs (`capStatus`: editionConfig.dogCapStatus(), null when uncapped).
export function maxDogs(capStatus) {
  if (!capStatus) return MAX_DOGS;
  return Math.max(0, Math.min(MAX_DOGS, capStatus.cap - capStatus.current));
}

// One plain-language problem with the step's answers, or null when it's fine.
// Plain strings stay until fixed; `check()`s she can tap past. ctx: { dogs (on
// file), breeds (on file), contacts, outsideKennels, multiKennel, ownKennelIds, maxDogs,
// outsideBreeders (this edition records other breeders' kennels and contacts) }.
export function stepProblem(step, draft, ctx = {}) {
  const today = todayYMD();
  if (step === 'roster') {
    const rows = draft.dogs.filter((d) => !isEmptyRow(d));
    if (!rows.length) return 'Type the name of a dog you\'re adding.';
    const max = ctx.maxDogs ?? MAX_DOGS;
    if (rows.length > max) {
      return max < MAX_DOGS ? `You have room for ${max} more ${max === 1 ? 'dog' : 'dogs'}. Take ${rows.length - max === 1 ? 'one' : 'some'} off the list.` : `I can add up to ${MAX_DOGS} dogs at a time.`;
    }
    const unnamed = rows.find((d) => blank(d.call_name));
    if (unnamed) return 'Type a name for each dog, or take that row off.';
    const noSex = rows.find((d) => !['male', 'female'].includes(d.sex));
    if (noSex) return `Is ${trimmed(noSex.call_name)} a boy or a girl?`;
    const seen = new Set();
    for (const d of rows) {
      const n = norm(d.call_name);
      if (seen.has(n)) return `Two dogs are named ${trimmed(d.call_name)}. Give each one its own name.`;
      seen.add(n);
    }
    const numberish = rows.find((d) => looksLikeNumber(d.call_name));
    if (numberish) return check(draft, `rosternum:${norm(numberish.call_name)}`, `"${trimmed(numberish.call_name)}" looks like a registration number. There's a box for it on the next screens; here, the name you call ${numberish.sex === 'male' ? 'him' : 'her'}.`);
    return null;
  }
  if (step === 'common') return null;
  if (step === 'review') return null;
  const d = draft.dogs[stepIndex(step)];
  if (!d) return null;
  const name = dogLabel(d);
  if (step.startsWith('match:')) return d.match ? null : 'Tap one of the choices.';
  if (step.startsWith('dog:')) {
    if (blank(d.breed)) return `Pick ${name}'s breed, or type a new one.`;
    if (!blank(d.date_of_birth) && d.date_of_birth > today) return 'The birth date can\'t be in the future.';
    if (blank(d.status)) return `Pick ${name}'s status.`;
    if (blank(d.ownership_type)) return `Whose dog is ${name}?`;
    if (OWNER_REQUIRED.includes(d.ownership_type) && !d.ownerId && blank(d.ownerName)) return `Pick ${name}'s owner, or type the owner's name.`;
    if (ctx.multiKennel && SCOPED_OWNERSHIP.has(d.ownership_type) && !(ctx.ownKennelIds || []).includes(d.kennelId)) return `Which of your kennels is ${name} under?`;
    // A breed she has, spelled a little differently, would make a second breed.
    const breedLike = similarNamed((ctx.breeds || []).filter((x) => norm(x) !== norm(d.breed)), d.breed, (x) => x);
    if (breedLike) { const c = check(draft, `breed:${d.key}:${norm(d.breed)}`, `Did you mean ${breedLike}? That's how your other dogs have it.`); if (c) return c; }
    if (looksLikeNumber(d.registered_name) && blank(d.registration_number)) {
      const c = check(draft, `regname:${d.key}:${norm(d.registered_name)}`, `"${trimmed(d.registered_name)}" looks like a registration number. Should it go in the Registration number box?`);
      if (c) return c;
    }
    if (OWNER_REQUIRED.includes(d.ownership_type) && !d.ownerId) {
      const like = similarNamed(ctx.contacts || [], d.ownerName, (c) => c.name);
      if (like) { const c = check(draft, `owner:${d.key}:${norm(d.ownerName)}`, `Is that ${like.name}, already in your contacts? Pick them from the list if so.`); if (c) return c; }
    }
    return null;
  }
  if (step.startsWith('breeder:')) {
    const b = d.breeder || noBreeder();
    if (b.bredBy !== 'other' || !ctx.outsideBreeders) return null;
    if (!b.kennelId && blank(b.kennelName)) return 'Pick the breeder\'s kennel, or type its name.';
    if (!b.contactId && blank(b.contactName) && !(blank(b.contactPhone) && blank(b.contactEmail))) return 'Type the breeder\'s name too.';
    if (!b.kennelId) {
      const like = similarNamed(ctx.outsideKennels || [], b.kennelName, (k) => k.kennel_name);
      if (like) { const c = check(draft, `bkennel:${d.key}:${norm(b.kennelName)}`, `Is that ${like.kennel_name}, already in your kennels? Pick it from the list if so.`); if (c) return c; }
    }
    if (!b.contactId && !blank(b.contactName)) {
      const like = similarNamed(ctx.contacts || [], b.contactName, (c) => c.name);
      if (like) { const c = check(draft, `bcontact:${d.key}:${norm(b.contactName)}`, `Is that ${like.name}, already in your contacts? Pick them from the list if so.`); if (c) return c; }
    }
    return null;
  }
  if (step.startsWith('parents:')) {
    for (const [role, sex, w] of [['dam', 'female', 'mom'], ['sire', 'male', 'dad']]) {
      const p = d[role];
      if (p.pick === `batch:${d.key}`) return `${name} can't be ${d.sex === 'female' ? 'her' : 'his'} own ${w}.`;
      if (p.pick !== 'new') continue;
      if (blank(p.name)) return `Type the ${w}'s registered name, or pick "Not known".`;
      // The same name on file, or a near one with something else agreeing: she
      // probably means that one. Asked once; she may know better.
      const found = findDogMatches(ctx.dogs || [], typedParent(p, sex)).find((m) => (m.close && !m.differs.length) || m.strength !== 'possible');
      if (found) {
        const on = [found.dog.registered_name, found.dog.call_name].filter(Boolean).join(', ');
        const why = matchReason(found);
        const msg = `Is that ${on}, already in KennelOS${why ? ` (${why.toLowerCase()})` : ''}? Pick ${sex === 'female' ? 'her' : 'him'} from the list if so.`;
        const c = check(draft, `parent:${d.key}:${role}:${nameKey(p.name)}|${normReg(p.regNum)}`, msg);
        if (c) return c;
      }
      const twin = dogsToAdd(draft).find((x) => x.sex === sex && [x.call_name, x.registered_name].some((n) => nameKey(n) && nameKey(n) === nameKey(p.name)));
      if (twin) return `${trimmed(p.name)} is one of the dogs we're adding. Pick ${sex === 'female' ? 'her' : 'him'} from the list.`;
    }
    return null;
  }
  return null;
}

// --- Review -------------------------------------------------------------------

const label = (vocab, v) => (blank(v) ? '' : descriptor(vocab, v).label);

// The parent as she'd say it, for the review. names: { dog(id) → name }.
export function parentText(p, draft, names = {}) {
  if (p.pick === 'new') return `${trimmed(p.name)}${blank(p.callName) ? '' : ` "${trimmed(p.callName)}"`} (new, for the pedigree)`;
  if (p.pick.startsWith('dog:')) return names.dog?.(p.pick.slice(4)) || 'a dog on file';
  if (p.pick.startsWith('batch:')) return dogLabel(draft.dogs.find((d) => d.key === p.pick.slice(6)) || {});
  return '';
}

// Who bred it, as she'd say it: "you", or the kennel and the breeder (new ones
// marked). '' when not known. names: { kennel(id), contact(id) }.
export function breederText(b, names = {}) {
  if (!b || !b.bredBy) return '';
  if (b.bredBy === 'me') return 'you';
  const kennel = b.kennelId ? names.kennel?.(b.kennelId) : (blank(b.kennelName) ? '' : `${trimmed(b.kennelName)} (a new kennel)`);
  const person = b.contactId ? names.contact?.(b.contactId) : (blank(b.contactName) ? '' : `${trimmed(b.contactName)} (a new contact)`);
  return [kennel, person].filter(Boolean).join(', ') || 'another breeder';
}

// The breeder answer the next dog starts with: the dog before it's, so dogs from
// one breeder take one tap each.
export function breederDefault(draft, i) {
  const prev = dogsToAdd(draft).filter((d) => draft.dogs.indexOf(d) < i).pop();
  return prev?.breeder?.bredBy ? { ...prev.breeder } : noBreeder();
}

// One section per dog: { title, lines, steps: { details, parents } }, then the
// dogs left as they are. names: { dog(id), contact(id), kennel(id) } for records
// on file; `kennelNames` true when she has more than one own kennel.
export function reviewSections(draft, names = {}, { kennelNames = false } = {}) {
  const sections = draft.dogs.map((d, i) => {
    const lines = [];
    const born = blank(d.date_of_birth) ? '' : `born ${fmt(d.date_of_birth)}`;
    lines.push([label(SEX, d.sex), trimmed(d.breed), born].filter(Boolean).join(', ') + '.');
    const reg = [trimmed(d.registered_name), blank(d.registration_number) ? '' : `#${trimmed(d.registration_number)}`].filter(Boolean).join(' ');
    if (reg) lines.push(`Registered: ${reg}.`);
    const more = [blank(d.color_markings) ? '' : trimmed(d.color_markings), blank(d.microchip_id) ? '' : `microchip ${trimmed(d.microchip_id)}`].filter(Boolean);
    if (more.length) lines.push(`${more.join(', ')}.`.replace(/^./, (c) => c.toUpperCase()));
    const owner = OWNER_REQUIRED.includes(d.ownership_type)
      ? (d.ownerId ? `, owned by ${names.contact?.(d.ownerId) || 'a contact'}` : `, owned by ${trimmed(d.ownerName)} (a new contact)`)
      : '';
    const kennel = kennelNames && SCOPED_OWNERSHIP.has(d.ownership_type) && d.kennelId ? `, ${names.kennel?.(d.kennelId) || ''}` : '';
    lines.push(`${label(DOG_STATUS, d.status)}. ${label(OWNERSHIP_TYPE, d.ownership_type)}${owner}${kennel}.`);
    const dam = parentText(d.dam, draft, names);
    const sire = parentText(d.sire, draft, names);
    lines.push(dam || sire ? `Parents: ${sire || 'dad not known'} × ${dam || 'mom not known'}.` : 'Parents: not known.');
    const bred = breederText(d.breeder, names);
    if (bred) lines.push(`Bred by ${bred}.`);
    return {
      title: d.bringIn ? `${dogLabel(d)} (bringing in from the pedigree)`
        : isFillIn(d) ? `${dogLabel(d)} (on file: filling in what's missing)` : dogLabel(d),
      lines,
      steps: { details: `dog:${i}`, parents: `parents:${i}`, breeder: `breeder:${i}` }
    };
  });
  return sections;
}

// --- Saving -------------------------------------------------------------------

function dogFields(d) {
  const fields = {
    call_name: trimmed(d.call_name),
    sex: d.sex,
    breed: trimmed(d.breed),
    status: d.status,
    ownership_type: d.ownership_type
  };
  for (const k of ['date_of_birth', 'registered_name', 'registration_number', 'color_markings', 'microchip_id']) {
    if (!blank(d[k])) fields[k] = trimmed(d[k]);
  }
  return fields;
}

// The dog's breeder kennel: hers (`ownKennelId`, else the one she works in), or
// another breeder's (one on file, one of that name on file, or a new outside
// kennel), with the breeder as a contact linked to it (typed Breeder; one she
// picked keeps any kennel she already has). New ones go on `s` as made, so the
// same breeder for two dogs is one kennel and one contact. → the kennel id.
async function saveBreeder(b, { s, step, ownKennelId }) {
  if (!b?.bredBy) return null;
  if (b.bredBy === 'me') return ownKennelId || await resolveKennelIdForWrite();
  s.kennels = s.kennels || {};
  s.contacts = s.contacts || {};
  let kennelId = b.kennelId || null;
  if (!kennelId && !blank(b.kennelName)) {
    const k = norm(b.kennelName);
    kennelId = s.kennels[k] || null;
    if (!kennelId) {
      const { kennel, created } = await kennelRepo.findOrCreateOutside(b.kennelName);
      kennelId = s.kennels[k] = kennel.id;
      if (created) await step();
    }
  }
  if (b.contactId) {
    const c = await contactRepo.getById(b.contactId);
    if (c && !c.kennel_id && kennelId) await contactRepo.update(c.id, { kennel_id: kennelId });
    await contactRepo.ensureType(b.contactId, 'breeder');
    if (!kennelId) kennelId = c?.kennel_id || null;
  } else if (!blank(b.contactName)) {
    // The same new name as a dog's owner (or another dog's breeder) is one contact.
    const k = norm(b.contactName);
    const madeId = s.contacts[k];
    if (madeId) {
      const c = await contactRepo.getById(madeId);
      if (c && !c.kennel_id && kennelId) await contactRepo.update(c.id, { kennel_id: kennelId });
    } else {
      const c = await contactRepo.create({
        name: trimmed(b.contactName), phone: trimmed(b.contactPhone), email: trimmed(b.contactEmail),
        contact_type: ['breeder'], kennel_id: kennelId
      });
      s.contacts[k] = c.id;
      await step();
    }
  }
  return kennelId;
}

// Write everything the review listed, in order: for each dog its owner (a new
// contact), its typed parents (pedigree-only dogs), then the dog; then the
// parents that are dogs from this same batch. `onProgress(draft)` runs after
// every write so the UI keeps the draft (and its saved ids) current.
// → { made: [dog ids], notMade: [draft dogs], capError } — capError is Lite's
// CapExceededError when the cap stopped it (the rest weren't made).
export async function saveGuidedDogs(draft, { onProgress = () => {} } = {}) {
  const s = draft.saved || (draft.saved = {});
  s.contacts = s.contacts || {};
  s.parents = s.parents || {};
  s.linked = s.linked || {};
  const step = async () => { draft.updatedAt = new Date().toISOString(); await onProgress(draft); };
  const kennels = await kennelRepo.getAll({ includeArchived: false });
  // A breed typed in another case or spacing takes the spelling her dogs have.
  const breedSpelling = new Map((await dogRepo.getAll({ includePedigreeOnly: true }))
    .filter((x) => !blank(x.breed)).map((x) => [norm(x.breed), trimmed(x.breed)]));
  const myContactId = getMyContactId();
  const myContact = myContactId ? await contactRepo.getById(myContactId) : null;
  let capError = null;

  for (const d of dogsToAdd(draft)) {
    if (d.id && d.saved) continue;
    try {
      // One of hers she said this is: only what's blank on it is written.
      const onFile = isFillIn(d) ? await dogRepo.getById(d.match) : null;
      // Someone else's dog: its owner, a new contact unless she picked one. The
      // same new name for two dogs is one contact.
      let ownerId = null;
      if (onFile?.owner_contact_id) {
        ownerId = onFile.owner_contact_id;
      } else if (OWNER_REQUIRED.includes(d.ownership_type)) {
        ownerId = d.ownerId || s.contacts[norm(d.ownerName)] || null;
        if (!ownerId) {
          const c = await contactRepo.create({ name: trimmed(d.ownerName), contact_type: ['breeder'] });
          ownerId = s.contacts[norm(d.ownerName)] = c.id;
          await step();
        }
      } else if (d.ownership_type === 'owned' && myContact && !myContact.is_archived) {
        ownerId = myContact.id; // the Dog page's prefill for a dog she owns
      }

      // Typed parents: pedigree-only dogs (dogRepo.createPedigreeOnly). The same
      // number, or name, for two dogs (littermates) is one parent.
      const parentIds = {};
      for (const [role, sex] of [['dam', 'female'], ['sire', 'male']]) {
        const p = d[role];
        if (p.pick.startsWith('dog:')) parentIds[role] = p.pick.slice(4);
        if (p.pick !== 'new') continue;
        const k = `${sex}|${normReg(p.regNum) || nameKey(p.name)}`;
        if (!s.parents[k]) {
          const made = await dogRepo.createPedigreeOnly({
            registered_name: trimmed(p.name), registration_number: trimmed(p.regNum), call_name: trimmed(p.callName),
            sex, breed: trimmed(d.breed)
          });
          s.parents[k] = made.id;
          await step();
        }
        parentIds[role] = s.parents[k];
      }

      const fields = { ...dogFields(d), owner_contact_id: ownerId };
      fields.breed = breedSpelling.get(norm(fields.breed)) || fields.breed;
      if (SCOPED_OWNERSHIP.has(d.ownership_type)) fields.kennel_id = d.kennelId || await resolveKennelIdForWrite();
      const breederKennelId = await saveBreeder(d.breeder, { s, step, ownKennelId: fields.kennel_id });
      if (breederKennelId) fields.breeder_kennel_id = breederKennelId;
      if (parentIds.dam) fields.dam_id = parentIds.dam;
      if (parentIds.sire) fields.sire_id = parentIds.sire;
      if (onFile) {
        const changes = Object.fromEntries(Object.entries(fields).filter(([k, v]) => !blank(v) && blank(onFile[k])));
        if (Object.keys(changes).length) await dogRepo.update(onFile.id, changes);
        d.id = onFile.id;
      } else if (d.bringIn) {
        await dogRepo.update(d.match, { ...fields, pedigree_only: false });
        d.id = d.match;
      } else if (!d.id) {
        // The Dog page's seeding: her kennel's planned tests for this breed.
        const seed = seedTestsKennel(fields, kennels);
        if (seed) fields.planned_tests = kennelRepo.testsForBreed(seed, fields.breed);
        const made = await dogRepo.create(fields);
        d.id = made.id;
      } else {
        await dogRepo.update(d.id, fields);
      }
      d.saved = true;
      await step();
    } catch (e) {
      if (e instanceof CapExceededError) { capError = e; break; }
      throw e;
    }
  }

  // Parents from this same batch, once both are made.
  const byKey = new Map(draft.dogs.map((d) => [d.key, d]));
  for (const d of dogsToAdd(draft)) {
    if (!d.id || s.linked[d.key]) continue;
    const changes = {};
    const current = isFillIn(d) ? await dogRepo.getById(d.id) : null; // never overwrite one of hers
    for (const role of ['dam', 'sire']) {
      const p = d[role];
      if (!p.pick.startsWith('batch:') || current?.[`${role}_id`]) continue;
      const parent = byKey.get(p.pick.slice(6));
      if (parent?.id) changes[`${role}_id`] = parent.id;
    }
    if (Object.keys(changes).length) await dogRepo.update(d.id, changes);
    s.linked[d.key] = true;
    await step();
  }

  const made = dogsToAdd(draft).filter((d) => d.id && d.saved);
  draft.done = true;
  await step();
  return { made: made.map((d) => d.id), notMade: dogsToAdd(draft).filter((d) => !made.includes(d)), capError };
}

// --- After the save: when she got them -------------------------------------------
// "Did you buy any of them?" Each dog she bought gets an `acquisition` event
// (the first on its timeline, as the event form makes it: `source` the seller),
// and its price an expense linked to that event (`dog_purchase`, the event
// form's Cost). A rough date is fine; it's the date she gives.
// rows: [{ dogId, name, date, source, price }].

// Her dogs (owned / co-owned) she didn't breed. `ownKennelIds`: her kennels.
export const canBeBought = (d, ownKennelIds = []) => SCOPED_OWNERSHIP.has(d.ownership_type) && !d.pedigree_only
  && !(d.breeder_kennel_id && ownKennelIds.includes(d.breeder_kennel_id));

export function acquisitionProblem(rows, today = todayYMD()) {
  if (!rows.length) return 'Tick the dogs you bought, or tap Skip.';
  for (const r of rows) {
    if (blank(r.date)) return `When did you get ${r.name}? A rough date is fine.`;
    if (r.date > today) return `${r.name}'s date can't be in the future.`;
    if (!blank(r.price) && !(Number(r.price) >= 0)) return `${r.name}'s price must be a number, like 2500.`;
  }
  return null;
}

export function acquisitionEvent(r) {
  const source = trimmed(r.source);
  return {
    subject_type: 'dog', subject_id: r.dogId, event_type: 'acquisition', event_date: r.date,
    title: source ? `Purchased from ${source}` : 'Purchased',
    details: source ? { source } : {}
  };
}

export async function saveAcquisitions(rows) {
  const events = [];
  for (const r of rows) {
    const ev = await eventRepo.create(acquisitionEvent(r));
    if (!blank(r.price)) await expenseRepo.createForEvent(ev, { amount: Number(r.price), category: defaultExpenseCategoryFor('acquisition') });
    events.push(ev);
  }
  return events;
}

// --- After the save: their shots -----------------------------------------------
// "Do you have their shots on record?" One form per dog over VACCINE_CHECKLIST:
// a date given (blank = not given / not known) and how long it's good for. Each
// becomes a `vaccination` event titled "Rabies (3-year)" / "DHPP (lifetime)",
// `details.next_due` from the date and its years, and with `remind` that same
// date as its `reminder_date`, so Today's Reminders card brings it up (Upcoming,
// then Due soon, then Overdue), as any event with a reminder date.
// rows: [{ vaccine, date, goodFor }].

const goodFor = (v) => VACCINE_GOOD_FOR.find((g) => g.value === v) || null;

export function shotsProblem(rows, today = todayYMD()) {
  for (const r of rows) {
    if (blank(r.date)) continue;
    if (r.date > today) return `The ${r.vaccine} date can't be in the future.`;
    if (!goodFor(r.goodFor)) return `How long is the ${r.vaccine} shot good for?`;
  }
  return rows.some((r) => !blank(r.date)) ? null : 'Fill in the date of at least one shot, or tap Skip.';
}

export function shotEvents(dogId, rows, { remind = false } = {}) {
  return rows.filter((r) => !blank(r.date)).map((r) => {
    const g = goodFor(r.goodFor);
    const nextDue = g.years ? addMonthsToYMD(r.date, g.years * 12) : null;
    return {
      subject_type: 'dog', subject_id: dogId, event_type: 'vaccination', event_date: r.date,
      title: `${r.vaccine} (${g.years ? `${g.years}-year` : 'lifetime'})`,
      details: { vaccine: r.vaccine, ...(nextDue ? { next_due: nextDue } : {}) },
      ...(remind && nextDue ? { reminder_date: nextDue } : {})
    };
  });
}

export async function saveShots(dogId, rows, opts) {
  const made = [];
  for (const ev of shotEvents(dogId, rows, opts)) made.push(await eventRepo.create(ev));
  return made;
}
