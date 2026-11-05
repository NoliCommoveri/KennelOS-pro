// doNotSellRepo.js — all Dexie access for do_not_sell, her list of people she
// won't sell to (End-State guide §29; rules in data/doNotSell.js). Program-wide,
// like contacts. Taking someone off the list archives the row (soft delete), and a
// contact on it shows in the Contacts list again.
import { db } from './db.js';
import { makeRepo } from './repoBase.js';
import { DO_NOT_SELL_REFERENCES } from './referenceRegistry.js';
import { listingProblem, cleanListing, alreadyListed } from './doNotSell.js';
import { todayYMD } from './dateUtils.js';

const base = makeRepo('do_not_sell', DO_NOT_SELL_REFERENCES);

function validate(row) {
  const problem = listingProblem(row);
  if (problem) throw new Error(problem);
}

export const doNotSellRepo = {
  ...base,

  async create(data) {
    const row = cleanListing({ added_date: todayYMD(), ...data });
    validate(row);
    const dup = alreadyListed(row, await base.getAll());
    if (dup) throw new Error(`${dup.name || dup.email || dup.phone} is already on your do-not-sell list.`);
    return base.create(row);
  },

  async update(id, changes) {
    const existing = await db.do_not_sell.get(id);
    if (!existing) throw new Error(`do_not_sell: no record with id ${id}`);
    const next = cleanListing({ ...existing, ...changes });
    validate(next);
    return base.update(id, next);
  },

  // A contact moved to the list: their name, email and phone as they are now.
  addContact(contact, { reason = '' } = {}) {
    return this.create({ name: contact.name, email: contact.email, phone: contact.phone, reason, contact_id: contact.id });
  },

  // An applicant added from their application (and their contact, once linked).
  addApplicant(entry, { reason = '' } = {}) {
    const a = entry.application || {};
    return this.create({ name: a.name, email: a.email, phone: a.phone, reason, contact_id: entry.contact_id || null, source_entry_id: entry.id });
  },

  // The listings made from one contact (for its page).
  forContact(contactId) {
    return db.do_not_sell.where('contact_id').equals(contactId).toArray();
  }
};
