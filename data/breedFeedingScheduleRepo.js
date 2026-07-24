// breedFeedingScheduleRepo.js — the kennel's own recommended feeding schedule
// per breed: a food brand, a free-text weight-band x age-column grid (both axes
// breeder-authored, matching how breeders actually write these — see a real
// example in the Feeding Schedules brief), and notes. One row per breed.
//
// Feeds a placed pup's Furever seed packet (fureverSeedExport.js) so the pup's
// Furever app shows the breeder's own guidance instead of the generic
// age-bracket placeholder (furever/data/careLibrary.js FEEDING_PLAN).
import { db } from './db.js';
import { makeRepo } from './repoBase.js';
import { BREED_FEEDING_SCHEDULE_REFERENCES } from './referenceRegistry.js';

const base = makeRepo('breed_feeding_schedules', BREED_FEEDING_SCHEDULE_REFERENCES);

function validate(candidate) {
  if (!candidate.breed) throw new Error('Breed feeding schedule: "breed" is required.');
}

const key = (s) => String(s ?? '').trim().toLowerCase();

export const breedFeedingScheduleRepo = {
  ...base,

  async create(data) {
    validate(data);
    return base.create(data);
  },

  async update(id, changes) {
    const existing = await db.breed_feeding_schedules.get(id);
    if (!existing) throw new Error(`breed_feeding_schedules: no record with id ${id}`);
    validate({ ...existing, ...changes });
    return base.update(id, changes);
  },

  // Case-insensitive, trimmed match — `breed` is free text on both Dog and this
  // table (same posture as CSV import's name matching, CLAUDE.md). Returns null
  // when no schedule is set for the breed.
  async getByBreed(breed) {
    const k = key(breed);
    if (!k) return null;
    const all = await base.getAll();
    return all.find((s) => key(s.breed) === k) || null;
  }
};

export { ReferenceBlockedError } from './repoBase.js';
