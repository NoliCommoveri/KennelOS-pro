// contractRepo.js — all Dexie access for the Contract table. Generic enough to
// cover sale, stud service, co-ownership, and lease agreements — one table
// instead of four (Data Model v3 §5.7). A LEAF entity: nothing points at a
// Contract, so it is always hard-deletable (CONTRACT_REFERENCES is empty).
//
// Owns all four canonical links: related_sale_id, related_stud_service_id,
// related_dog_id, and related_contact_id (the last two for lease/co_own/other,
// where no linked Sale/StudService already supplies the dog or the counterparty).
// "Linking" a contract is a single write here — there is no reverse field on
// Dog/Sale/StudService/Contact to keep in sync (Stage4 Revision v2 §5), but a
// linked Dog is in DOG_REFERENCES and a linked Contact is in CONTACT_REFERENCES
// so neither can be hard-deleted out from under a documented contract.
import { db } from './db.js';
import { makeRepo } from './repoBase.js';
import { CONTRACT_REFERENCES } from './referenceRegistry.js';

const base = makeRepo('contracts', CONTRACT_REFERENCES);

const REQUIRED_FIELDS = ['contract_type'];

// Types with no linked Sale/StudService to reach a dog/contact through — these are
// the only types related_dog_id and related_contact_id are meaningful for. Canonical
// here (not just in the page) so create/update can normalize them regardless of
// caller. Sale/stud contracts already reach their counterparty through the linked
// Sale.buyer_contact_id / StudService.partner_contact_id, so related_contact_id
// stays null there and never double-sources the same relationship.
// `foster` joins these: a foster contract reaches its fostered dam through
// related_dog_id and its counterparty (owner for foster-in, caretaker for
// foster-out) through related_contact_id — the same shape as lease/co_own/other,
// so no new Contract FK is needed. It is also partner-facing (isLivePartnerContract
// / CONTACT_LINK_TYPES below), so a live foster contract confers partner membership
// and appears in the partner companion bundle like a lease.
export const DOG_LINK_TYPES = ['lease', 'co_own', 'foster', 'other'];
export const CONTACT_LINK_TYPES = ['lease', 'co_own', 'foster', 'other'];

// Statuses that take a contract out of play. A partner never sees a contract in
// one of these states, and such a contract never confers partner membership —
// applied identically in both places via isLivePartnerContract so the two agree.
export const TERMINAL_CONTRACT_STATUSES = ['declined', 'cancelled', 'void'];

function validateContract(candidate) {
  for (const f of REQUIRED_FIELDS) {
    if (candidate[f] == null || candidate[f] === '') {
      throw new Error(`Contract: "${f}" is required.`);
    }
  }
  // status is not a locked state machine (Stage4 Revision v2 §7) — any type can
  // be any status, moves in any direction, no confirmation dialogs here.
}

// related_dog_id / related_contact_id only apply to their *_LINK_TYPES — force
// them null otherwise so a stray link left over from an in-progress type change
// (e.g. lease -> sale) never persists and never surfaces on that dog's or
// contact's derived Contracts panel / companion bundle.
function normalizeLinks(candidate) {
  if (!DOG_LINK_TYPES.includes(candidate.contract_type)) candidate.related_dog_id = null;
  if (!CONTACT_LINK_TYPES.includes(candidate.contract_type)) candidate.related_contact_id = null;
  return candidate;
}

export const contractRepo = {
  ...base,

  async create(data) {
    const record = normalizeLinks({ status: 'draft', ...data });
    validateContract(record);
    return base.create(record);
  },

  async update(id, changes) {
    const existing = await db.contracts.get(id);
    if (!existing) throw new Error(`contracts: no record with id ${id}`);
    const merged = normalizeLinks({ ...existing, ...changes });
    validateContract(merged);
    return base.update(id, {
      ...changes,
      related_dog_id: merged.related_dog_id,
      related_contact_id: merged.related_contact_id
    });
  },

  // Derived reverse lookups — the sale/stud-service side never stores a pointer
  // back to its contract(s); this is the query that replaces it. Permits more
  // than one contract per sale/stud-service by design (e.g. sale + addendum).
  getBySale(saleId) {
    return db.contracts.where('related_sale_id').equals(saleId).toArray();
  },

  getByStudService(studServiceId) {
    return db.contracts.where('related_stud_service_id').equals(studServiceId).toArray();
  },

  getByDog(dogId) {
    return db.contracts.where('related_dog_id').equals(dogId).toArray();
  },

  // Contracts whose counterparty is this contact — lease/co_own/other only (the
  // types related_contact_id is set for). Powers the partner companion bundle's
  // "their lease/other contracts" scope; the reverse of related_contact_id.
  getByContact(contactId) {
    return db.contracts.where('related_contact_id').equals(contactId).toArray();
  },

  // "The live contract" of a sale/stud-service — a derived rule, never a stored
  // flag (Stage4 Revision v2 §7): the most recent `signed` contract by
  // signed_date (falling back to created_at), or null if none is signed.
  governingContract(contracts) {
    const signed = contracts.filter((c) => c.status === 'signed');
    if (!signed.length) return null;
    return signed.slice().sort((a, b) =>
      (b.signed_date || b.created_at || '').localeCompare(a.signed_date || a.created_at || '')
    )[0];
  },

  // The single predicate shared by partner *membership* (companion.js) and partner
  // bundle *contents* (companionExport.js) so the two can never drift: a live,
  // partner-facing contract as of `today` (YYYY-MM-DD) is a non-archived
  // lease/co_own/other contract that has a counterparty, is not in a terminal
  // status, and — for a lease — has not passed its end date.
  isLivePartnerContract(c, today) {
    if (!c || c.is_archived || !c.related_contact_id) return false;
    if (!CONTACT_LINK_TYPES.includes(c.contract_type)) return false;
    if (TERMINAL_CONTRACT_STATUSES.includes(c.status)) return false;
    if (c.contract_type === 'lease' && c.lease_end_date && c.lease_end_date < today) return false;
    return true;
  }
};

export { ReferenceBlockedError } from './repoBase.js';
