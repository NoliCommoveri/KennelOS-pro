// saleRepo.js — all Dexie access for the Sale (placement) table. A bridge entity
// between a Dog and a Contact (the buyer) — deliberately its own table, not a
// field on Dog, since a dog can be reserved/returned/re-placed and each of those
// is a fact worth keeping (Data Model v3 §5.6). Buyer is a Contact; there is no
// Buyer table (v3 §5.5).
import { db } from './db.js';
import { makeRepo } from './repoBase.js';
import { SALE_REFERENCES } from './referenceRegistry.js';
import { contactRepo } from './contactRepo.js';

const base = makeRepo('sales', SALE_REFERENCES);

const REQUIRED_FIELDS = ['dog_id', 'buyer_contact_id', 'placement_type', 'status'];

// Statuses that close a sale out. A closed sale no longer makes its buyer a
// current "family" and never appears in that family's companion bundle — applied
// identically to membership (companion.js) and bundle contents (companionExport.js)
// via isOpenSale so the two can't drift.
export const TERMINAL_SALE_STATUSES = ['delivered', 'returned', 'cancelled'];

function validateSale(candidate) {
  for (const f of REQUIRED_FIELDS) {
    if (candidate[f] == null || candidate[f] === '') {
      throw new Error(`Sale: "${f}" is required.`);
    }
  }
  // No hard blocks beyond required fields — a "returned" sale stays visible on
  // the dog's record (status records what happened; archive only hides).
}

export const saleRepo = {
  ...base,

  async create(data) {
    validateSale(data);
    const saved = await base.create(data);
    // Auto-tag the referral source as a Buyer referrer (a stored role on the
    // Contact — the canonical FK stays sales.referred_by_contact_id, this is just
    // a convenience label so the contact reads as a referrer at a glance).
    await contactRepo.ensureType(saved.referred_by_contact_id, 'buyer_referrer');
    return saved;
  },

  async update(id, changes) {
    const existing = await db.sales.get(id);
    if (!existing) throw new Error(`sales: no record with id ${id}`);
    validateSale({ ...existing, ...changes });
    const saved = await base.update(id, changes);
    await contactRepo.ensureType(saved.referred_by_contact_id, 'buyer_referrer');
    return saved;
  },

  // Every Sale ever recorded for a dog — a dog may have several over its life
  // (reserved, returned, re-placed).
  getByDog(dogId) {
    return db.sales.where('dog_id').equals(dogId).toArray();
  },

  // Sales where this contact is the buyer — powers the Contact Detail panel.
  getByBuyer(contactId) {
    return db.sales.where('buyer_contact_id').equals(contactId).toArray();
  },

  // Is this an open (in-flight) sale? The single predicate shared by "current
  // family" membership (companion.js) and the family companion bundle
  // (companionExport.js): a non-archived sale with a status that has not reached
  // a terminal state (delivered/returned/cancelled).
  isOpenSale(s) {
    return !!s && !s.is_archived && !!s.status && !TERMINAL_SALE_STATUSES.includes(s.status);
  },

  // Distinct lead_source values already entered — feeds the free-text
  // autocomplete (Stage4 Revision v2 §3, built like `breed`).
  async getLeadSources() {
    const all = await db.sales.toArray();
    return [...new Set(all.map((s) => s.lead_source).filter(Boolean))].sort();
  }
};

export { ReferenceBlockedError } from './repoBase.js';
