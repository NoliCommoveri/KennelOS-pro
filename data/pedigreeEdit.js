// pedigreeEdit.js — fixing one spot in a dog's pedigree from the chart
// (assets/pedigree.js): put a dog on file there, add a new pedigree-only dog
// there, or clear it. A spot is a child's sire or dam (`sire_id` / `dam_id`);
// the pedigree is derived from those, so changing the child is the whole fix,
// and no other record changes (a dog taken out of a spot stays on file).
import { dogRepo, dogName } from './dogRepo.js';
import { dogRegKeys, normReg } from './dogSearch.js';
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

// Put a dog on file in the spot (null clears it). → the updated child.
export async function setParent(childId, role, parentId) {
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
  return updated;
}

// Put a dog that isn't on file yet in the spot. A registration number already on
// a dog in KennelOS means that dog: it's used, not duplicated. Otherwise a new
// pedigree-only dog is made with the child's breed and the spot's sex.
// → { dog, reused }.
export async function addNewParent(childId, role, { registered_name = '', registration_number = '' } = {}) {
  const name = String(registered_name).replace(/\s+/g, ' ').trim();
  const reg = String(registration_number).replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('Type the dog’s registered name.');
  const dogs = await allDogs();
  const child = dogs.find((d) => d.id === childId);
  if (!child) throw new Error('That dog is no longer in KennelOS.');
  const key = reg ? normReg(reg) : '';
  const existing = key ? dogs.find((d) => dogRegKeys(d).includes(key)) : null;
  if (existing) {
    await setParent(childId, role, existing.id);
    return { dog: existing, reused: true };
  }
  const dog = await dogRepo.createPedigreeOnly({
    registered_name: name, registration_number: reg, registry: reg && isAkcReg(reg) ? 'AKC' : '',
    sex: ROLE_SEX[role], breed: child.breed || ''
  });
  await setParent(childId, role, dog.id);
  return { dog, reused: false };
}
