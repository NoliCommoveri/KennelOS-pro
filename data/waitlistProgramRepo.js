// waitlistProgramRepo.js — all Dexie access for waitlist_programs: her own named
// bundles of waitlist adjustments (fee override, priority, pause allowance, passes
// not counted, a longer response window), one table rather than a fixed vocab list
// because programs are hers to define (Waitlist Spec §4.4/§7; End-State guide §29).
import { db } from './db.js';
import { makeRepo } from './repoBase.js';
import { WAITLIST_PROGRAM_REFERENCES } from './referenceRegistry.js';
import { assertOwnKennel } from './kennelScope.js';
import { WAITLIST_PRIORITY } from './vocab.js';

const base = makeRepo('waitlist_programs', WAITLIST_PROGRAM_REFERENCES);

function validateProgram(c) {
  if (!String(c.name || '').trim()) throw new Error('Waitlist program: "name" is required.');
  if (!WAITLIST_PRIORITY.some((p) => p.value === c.priority)) {
    throw new Error(`Waitlist program: unknown priority "${c.priority}".`);
  }
  const fee = c.fee_override;
  if (fee != null && fee !== '' && !(Number(fee) >= 0)) {
    throw new Error('Waitlist program: the fee override must be 0 (waived) or more.');
  }
}

function withDefaults(data) {
  return { priority: 'standard', applicable_on_form: false, pause_allowed: false, passes_count: true, fee_override: null, ...data };
}

export const waitlistProgramRepo = {
  ...base,

  async create(data) {
    const candidate = withDefaults(data);
    validateProgram(candidate);
    await assertOwnKennel(candidate.kennel_id, 'Waitlist program');
    return base.create(candidate);
  },

  async update(id, changes) {
    const existing = await db.waitlist_programs.get(id);
    if (!existing) throw new Error(`waitlist_programs: no record with id ${id}`);
    validateProgram(withDefaults({ ...existing, ...changes }));
    if (changes.kennel_id !== undefined && changes.kennel_id !== existing.kennel_id) {
      await assertOwnKennel(changes.kennel_id, 'Waitlist program');
    }
    return base.update(id, changes);
  },

  async getByKennel(kennelId, { includeArchived = false } = {}) {
    const rows = await db.waitlist_programs.where('kennel_id').equals(kennelId).toArray();
    return includeArchived ? rows : rows.filter((p) => !p.is_archived);
  },

  // id → program, archived included: a program keeps applying to the families
  // already in it after it's archived (waitlistRules priority note).
  async getMapForKennel(kennelId) {
    return new Map((await waitlistProgramRepo.getByKennel(kennelId, { includeArchived: true })).map((p) => [p.id, p]));
  }
};

export { ReferenceBlockedError } from './repoBase.js';
