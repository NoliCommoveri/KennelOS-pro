// accountRepo.js — the breeder's business accounts with vendors and registries
// (AKC, Good Dog, Chewy…). Each holds her own login details (username,
// password, customer/member ID — private tier in syncRegistry.js, so they reach
// the cloud only inside the encrypted vault) and a shareable referral link
// and/or code, with free-text instructions for the people she'll share it with.
// Program-wide (not kennel-scoped). An expense may point at the account it was
// paid through (expenses.account_id), so hard delete is blocked while one does.
import { db } from './db.js';
import { makeRepo } from './repoBase.js';
import { ACCOUNT_REFERENCES } from './referenceRegistry.js';

const base = makeRepo('accounts', ACCOUNT_REFERENCES);

function validate(candidate) {
  if (!String(candidate.name ?? '').trim()) throw new Error('Account: "name" is required.');
}

export const accountRepo = {
  ...base,

  // Sorted by name (case-insensitive) — the list's only order.
  async getAll(opts) {
    const rows = await base.getAll(opts);
    return rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }));
  },

  async create(data) {
    validate(data);
    return base.create(data);
  },

  async update(id, changes) {
    const existing = await db.accounts.get(id);
    if (!existing) throw new Error(`accounts: no record with id ${id}`);
    validate({ ...existing, ...changes });
    return base.update(id, changes);
  }
};

export { ReferenceBlockedError } from './repoBase.js';
