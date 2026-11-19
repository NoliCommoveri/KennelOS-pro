// pedigreeEdit.js — fixing one spot in a dog's pedigree from the chart
// (assets/pedigree.js): put a dog on file there, add a new pedigree-only dog
// there, or clear it. A spot is a child's sire or dam (`sire_id` / `dam_id`);
// the pedigree is derived from those, so changing the child is the whole fix
// (a dog taken out of a spot stays on file). A pup's litter also names its sire and
// dam: a fix that disagrees with the litter's asks whether the litter (and every
// pup on its old parent) changes too, or just this pup (a split litter; review K9-8).
import { dogRepo, dogName } from './dogRepo.js';
import { litterRepo } from './litterRepo.js';
import { dogRegKeys, normReg, nameKey } from './dogSearch.js';
import { isAkcReg } from './pedigreeParse.js';

export const ROLE_FIELD = { sire: 'sire_id', dam: 'dam_id' };
export const ROLE_SEX = { sire: 'male', dam: 'female' };

// Would putting `parentId` in one of `childId`'s spots make the child its own
// ancestor? True when the parent is the child, or the child is already among the
// parent's ancestors. byId: Map(id → dog).
export function wouldLoop(byId, childId, parentId) {
  const seen = new Set();
  const stack = [parentId];
  while (stack.length) {
    const id = stack.pop();
    if (!id || seen.has(id)) continue;
    if (id === childId) return true;
    seen.add(id);
    const d = byId.get(id);
    if (d) stack.push(d.sire_id, d.dam_id);
  }
  return false;
}

// A dog's sex only fits a spot of the other sex when it's a pedigree-only dog: its
// sex came from where a chart put it, so a dog the importer misplaced can be moved
// and its sex corrected with it.
const sexFits = (d, role) => d.sex === ROLE_SEX[role] || !d.sex || d.sex === 'unknown';
export const sexCorrectable = (d, role) => !sexFits(d, role) && Boolean(d.pedigree_only);

// The dogs a spot can take: the right sex (or not recorded, or a pedigree-only dog
// whose sex can be corrected), never the child or a dog that would loop, archived
// ones left out unless already there.
export function spotCandidates(dogs, childId, role, currentId = null) {
  const byId = new Map(dogs.map((d) => [d.id, d]));
  return dogs.filter((d) => d.id === currentId || (
    !d.is_archived && (sexFits(d, role) || sexCorrectable(d, role)) && !wouldLoop(byId, childId, d.id)));
}

async function allDogs() {
  return dogRepo.getAll({ includeArchived: true, includePedigreeOnly: true });
}

// Can a spot under `child` (its sire or dam) be fixed from the chart? Not under a
// dog that can't itself be edited: an archived one where archived dogs aren't opened
// (Lite, `archivedDogLinks` off; cap spec §7, review K9-11). `flags`: editionFlags.
export function spotFixable(child, flags) {
  return Boolean(child) && !(child.is_archived && !flags?.archivedDogLinks);
}

// Does putting `parentId` in a pup's spot disagree with its litter's? Only when the
// pup has a litter that names that parent and the new one is someone else.
export function litterParentMismatch(child, litter, role, parentId) {
  const field = ROLE_FIELD[role];
  return Boolean(field && parentId && child?.litter_id && litter && litter.id === child.litter_id
    && litter[field] && litter[field] !== parentId);
}

// A litter's pups (not archived) whose sire or dam is still `parentId`: the ones a
// corrected litter parent should carry along. A pup recorded with another (a split
// litter) isn't one.
export async function litterPupsOnParent(litterId, role, parentId) {
  const field = ROLE_FIELD[role];
  if (!field || !litterId) return [];
  const dogs = await dogRepo.getAll({ includePedigreeOnly: true });
  return dogs.filter((d) => d.litter_id === litterId && (d[field] || null) === (parentId || null));
}

// Move those pups from `oldId` to `newId`. → how many moved.
export async function moveLitterPups(litterId, role, oldId, newId) {
  const pups = await litterPupsOnParent(litterId, role, oldId);
  for (const p of pups) await dogRepo.update(p.id, { [ROLE_FIELD[role]]: newId || null });
  return pups.length;
}

// Put a dog on file in the spot (null clears it). → the updated child.
// `litter: 'all'`: when it disagrees with the pup's litter (litterParentMismatch), the
// litter takes the new parent too, and so does every pup still on the old one.
// Anything else changes this pup only (a split litter).
export async function setParent(childId, role, parentId, { litter = 'this' } = {}) {
  const field = ROLE_FIELD[role];
  if (!field) throw new Error(`Unknown pedigree spot "${role}".`);
  const dogs = await allDogs();
  const byId = new Map(dogs.map((d) => [d.id, d]));
  const child = byId.get(childId);
  if (!child) throw new Error('That dog is no longer in KennelOS.');
  if (parentId) {
    const parent = byId.get(parentId);
    if (!parent) throw new Error('That dog is no longer in KennelOS.');
    if (wouldLoop(byId, childId, parentId)) {
      throw new Error(`${dogName(parent)} can't be ${dogName(child)}'s ${role}: ${dogName(child)} is already in ${dogName(parent)}'s own pedigree.`);
    }
    if (!sexFits(parent, role)) {
      if (!sexCorrectable(parent, role)) {
        throw new Error(`${dogName(parent)} is recorded as ${parent.sex}, so can't be the ${role}.`);
      }
      // Still a parent the other way round somewhere: that spot comes first.
      const other = role === 'sire' ? 'dam_id' : 'sire_id';
      const kids = dogs.filter((d) => d[other] === parentId);
      if (kids.length) {
        throw new Error(`${dogName(parent)} is still recorded as the ${role === 'sire' ? 'dam' : 'sire'} of ${kids.map(dogName).join(', ')}. Fix that spot first, then put ${dogName(parent)} here.`);
      }
    }
  }
  const updated = await dogRepo.update(childId, { [field]: parentId || null });
  if (parentId && !sexFits(byId.get(parentId), role)) await dogRepo.update(parentId, { sex: ROLE_SEX[role] });
  if (litter === 'all' && parentId && child.litter_id) {
    const l = await litterRepo.getById(child.litter_id);
    if (litterParentMismatch(child, l, role, parentId)) {
      await moveLitterPups(l.id, role, l[field], parentId);
      await litterRepo.update(l.id, { [field]: parentId });
    }
  }
  return updated;
}

// Pedigree-only dogs already on file under the name typed for a spot (titles,
// case and punctuation aside: dogSearch.nameKey), that could go in it: not archived,
// not looping, the right sex, and not told apart by registration number (one typed
// that isn't theirs means a different dog). → [dog]
export function nameMatches(dogs, childId, role, name, reg = '') {
  const key = nameKey(name);
  if (!key) return [];
  const typed = reg ? normReg(reg) : '';
  return spotCandidates(dogs, childId, role).filter((d) => d.pedigree_only && !d.is_archived && !sexCorrectable(d, role)
    && nameKey(d.registered_name) === key && (!typed || !dogRegKeys(d).length || dogRegKeys(d).includes(typed)));
}

// Put a dog that isn't on file yet in the spot. A registration number already on
// a dog in KennelOS means that dog: it's used, not duplicated; on an archived dog
// it's refused, naming it (review K9-11). A name already on a pedigree-only dog
// (nameMatches, review K9-9) is asked about first: with `matchId` undefined and a
// match, nothing is written and `matches` comes back; `matchId` set uses that dog,
// null makes a new one. Otherwise a new pedigree-only dog is made with the child's
// breed and the spot's sex. `litter` as setParent's.
// → { dog, reused, matches? }.
export async function addNewParent(childId, role, { registered_name = '', registration_number = '', matchId, litter = 'this' } = {}) {
  const name = String(registered_name).replace(/\s+/g, ' ').trim();
  const reg = String(registration_number).replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('Type the dog’s registered name.');
  const dogs = await allDogs();
  const child = dogs.find((d) => d.id === childId);
  if (!child) throw new Error('That dog is no longer in KennelOS.');
  const key = reg ? normReg(reg) : '';
  const byReg = key ? dogs.filter((d) => dogRegKeys(d).includes(key)) : [];
  const existing = byReg.find((d) => !d.is_archived);
  if (existing) {
    await setParent(childId, role, existing.id, { litter });
    return { dog: existing, reused: true };
  }
  if (byReg.length) {
    throw new Error(`That registration number is on ${dogName(byReg[0])}, an archived dog, so it isn't used here. Pick a dog on file, or check the number.`);
  }
  if (matchId) {
    const match = dogs.find((d) => d.id === matchId);
    if (!match) throw new Error('That dog is no longer in KennelOS.');
    await setParent(childId, role, match.id, { litter });
    return { dog: match, reused: true };
  }
  if (matchId === undefined) {
    const matches = nameMatches(dogs, childId, role, name, reg);
    if (matches.length) return { dog: null, reused: false, matches };
  }
  const dog = await dogRepo.createPedigreeOnly({
    registered_name: name, registration_number: reg, registry: reg && isAkcReg(reg) ? 'AKC' : '',
    sex: ROLE_SEX[role], breed: child.breed || ''
  });
  await setParent(childId, role, dog.id, { litter });
  return { dog, reused: false };
}
