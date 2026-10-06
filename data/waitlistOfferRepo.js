// waitlistOfferRepo.js — all Dexie access for waitlist_offers: one row each time a
// family's turn comes up for a litter (Waitlist Spec §4.3; End-State guide §29).
//
// `counts_as_pass` is written ONCE, by the page that records the outcome, from
// waitlistRules.countsAsPass — stored, not derived, so a later rule or program
// change never rewrites history. The only later change to it is the second-pass
// undo, which forgives that one pass (Spec §0/§6.4).
import { db } from './db.js';
import { makeRepo } from './repoBase.js';
import { WAITLIST_OFFER_REFERENCES } from './referenceRegistry.js';
import { assertOwnKennel } from './kennelScope.js';
import { WAITLIST_OFFER_OUTCOME } from './vocab.js';

const base = makeRepo('waitlist_offers', WAITLIST_OFFER_REFERENCES);

const REQUIRED_FIELDS = ['entry_id', 'litter_id', 'kennel_id', 'offered_date', 'outcome'];
const OUTCOMES = WAITLIST_OFFER_OUTCOME.map((o) => o.value);

function validateOffer(c) {
  for (const f of REQUIRED_FIELDS) {
    if (c[f] == null || c[f] === '') throw new Error(`Waitlist offer: "${f}" is required.`);
  }
  if (!OUTCOMES.includes(c.outcome)) throw new Error(`Waitlist offer: unknown outcome "${c.outcome}".`);
  if (c.outcome === 'accepted' && !c.chosen_dog_id) {
    throw new Error('Waitlist offer: an accepted offer needs the chosen pup.');
  }
}

// chosen_dog_id only means something on an accepted offer; clear it otherwise so a
// voided/passed offer never keeps a pup pinned (or blocks that dog's hard delete).
function normalize(c) {
  return c.outcome === 'accepted' ? c : { ...c, chosen_dog_id: null };
}

// The offer, its family and its litter must all be on the same kennel's list.
async function assertSameKennel(c) {
  const [entry, litter] = await Promise.all([db.waitlist_entries.get(c.entry_id), db.litters.get(c.litter_id)]);
  if (!entry) throw new Error('Waitlist offer: entry_id does not match any waitlist entry.');
  if (!litter) throw new Error('Waitlist offer: litter_id does not match any litter.');
  if (entry.kennel_id !== c.kennel_id || litter.kennel_id !== c.kennel_id) {
    throw new Error('Waitlist offer: the family and the litter must belong to the same kennel.');
  }
}

export const waitlistOfferRepo = {
  ...base,

  async create(data) {
    const candidate = normalize({ eligible_dog_ids: [], counts_as_pass: false, ...data });
    validateOffer(candidate);
    await assertOwnKennel(candidate.kennel_id, 'Waitlist offer');
    await assertSameKennel(candidate);
    return base.create(candidate);
  },

  async update(id, changes) {
    const existing = await db.waitlist_offers.get(id);
    if (!existing) throw new Error(`waitlist_offers: no record with id ${id}`);
    const merged = normalize({ ...existing, ...changes });
    validateOffer(merged);
    if (['entry_id', 'litter_id', 'kennel_id'].some((f) => changes[f] !== undefined && changes[f] !== existing[f])) {
      await assertOwnKennel(merged.kennel_id, 'Waitlist offer');
      await assertSameKennel(merged);
    }
    return base.update(id, { ...changes, chosen_dog_id: merged.chosen_dog_id ?? null });
  },

  // Every offer made to one family (passes are counted from these).
  getByEntry(entryId) {
    return db.waitlist_offers.where('entry_id').equals(entryId).toArray();
  },

  // Every offer made on one litter (who's had their turn).
  getByLitter(litterId) {
    return db.waitlist_offers.where('litter_id').equals(litterId).toArray();
  },

  // One kennel's offers — the Waitlist page and Today's overdue-offer suggestions.
  getByKennel(kennelId) {
    return db.waitlist_offers.where('kennel_id').equals(kennelId).toArray();
  }
};

export { ReferenceBlockedError } from './repoBase.js';
