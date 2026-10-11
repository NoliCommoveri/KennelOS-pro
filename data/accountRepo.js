// accountRepo.js — the breeder's business accounts with vendors and registries
// (AKC, Good Dog, Chewy…). Each holds her own login details (username,
// password, customer/member ID — private tier in syncRegistry.js, so they reach
// the cloud only inside the encrypted vault) and a shareable referral link
// and/or code, with free-text instructions for the people she'll share it with.
// Program-wide (not kennel-scoped). An expense may point at the account it was
// paid through (expenses.account_id), and a sale at the account it was sold /
// paid through (sales.sales_channel_account_id, whose fee rate — fee_percent +
// fee_fixed — the Sale form suggests its processing fee from), so hard delete is
// blocked while either does.
import { db } from './db.js';
import { makeRepo } from './repoBase.js';
import { ACCOUNT_REFERENCES } from './referenceRegistry.js';

const base = makeRepo('accounts', ACCOUNT_REFERENCES);

// A sales channel's fee rate (Integrations plan §5): a percentage below 100 plus
// a fixed amount, either blank. Blank means no fee, never an error.
const blank = (v) => v == null || v === '';

function validate(candidate) {
  if (!String(candidate.name ?? '').trim()) throw new Error('Account: "name" is required.');
  if (!blank(candidate.fee_percent)) {
    const p = Number(candidate.fee_percent);
    if (!Number.isFinite(p) || p < 0 || p >= 100) throw new Error('Account: the fee percentage must be 0 or more and less than 100.');
  }
  if (!blank(candidate.fee_fixed)) {
    const f = Number(candidate.fee_fixed);
    if (!Number.isFinite(f) || f < 0) throw new Error('Account: the fixed fee can\'t be negative.');
  }
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
