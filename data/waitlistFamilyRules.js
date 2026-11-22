// waitlistFamilyRules.js — families she brings onto the waitlist from before it
// (End-State guide §29 "Already bought", the waitlist import's On the list rows). PURE:
// no Dexie, no DOM (tests/waitlistGrandfather.test.js). Kept out of waitlistRules.js so
// the pages that never use it don't load it.
import { isOpenSale } from './vocab.js';
import { familyPageBlocker, isFamilyPageOnly } from './waitlistRules.js';

const byId = (list) => (list instanceof Map ? (id) => list.get(id) : (id) => (list || []).find((x) => x.id === id));

// The kennel a sale belongs to, as a family page reads it: its pup's litter's, else
// the sale's own, else the pup's (waitlistActions.addFamilyPage). `dogs`/`litters`:
// arrays or Maps by id.
export function saleKennelId(sale, dogs, litters) {
  const dog = sale ? byId(dogs)(sale.dog_id) : null;
  const litter = dog?.litter_id ? byId(litters)(dog.litter_id) : null;
  return litter?.kennel_id || sale?.kennel_id || dog?.kennel_id || null;
}

// "Already bought": a family on this kennel's list whose contact is the buyer on an
// open sale of this kennel that nothing on the waitlist claims (familyPageBlocker),
// e.g. a family she imported onto the list who bought before the list. The Waitlist
// page asks to make each a family page only (familyPageFromListEntry). Derived,
// nothing stored: link the sale, or end it, and the question is gone.
// → [{ entry, sale }], one row per sale, oldest sale first.
export function openSaleFamilies(entries, kennelId, { sales = [], dogs = [], litters = [], offers = [] } = {}) {
  const out = [];
  const onList = (entries || []).filter((e) => !e.is_archived && e.kennel_id === kennelId && e.status === 'active' && !e.off_list && e.contact_id);
  if (!onList.length) return out;
  const live = sales.filter((x) => isOpenSale(x) && x.buyer_contact_id && saleKennelId(x, dogs, litters) === kennelId && !familyPageBlocker(x, entries, offers))
    .sort((a, b) => String(a.sale_date || '').localeCompare(String(b.sale_date || '')));
  for (const sale of live) {
    const entry = onList.find((e) => e.contact_id === sale.buyer_contact_id);
    if (entry) out.push({ entry, sale });
  }
  return out;
}

// A contact's family page on this kennel (a status page for a sale, not a place on
// the list), still live: the import flags a row for them rather than put them on the
// list as well.
export const familyPageOf = (entries, kennelId, contactId) => (contactId
  ? (entries || []).find((e) => !e.is_archived && e.kennel_id === kennelId && e.contact_id === contactId && isFamilyPageOnly(e) && e.status === 'placed') || null
  : null);

// A new Contact from an application's answers (Spec §5.2 "creates or links"): on
// approval, and for a family the import puts straight on the list.
export function contactFromApplication(app = {}) {
  return {
    name: String(app.name || '').trim(),
    email: String(app.email || '').trim(),
    phone: String(app.phone || '').trim(),
    address: String(app.location || '').trim(),
    contact_type: ['buyer'],
    first_contact_source: String(app.heard_from || '').trim()
  };
}
