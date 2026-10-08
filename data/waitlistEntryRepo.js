// waitlistEntryRepo.js — all Dexie access for waitlist_entries: one row per family
// per time on a kennel's waitlist (Waitlist Spec §4.2; End-State guide §29). The
// Contact stays the person; a family coming back for a second puppy years later is
// a second entry, not an edit to the first.
//
// Position and passes are NOT stored here — both are derived by waitlistRules.js
// (position from the anchor dates, passes from the offers). This repo keeps
// Contact.waitlist_status in step with the entries after every write (Spec §0).
import { db } from './db.js';
import { makeRepo } from './repoBase.js';
import { WAITLIST_ENTRY_REFERENCES } from './referenceRegistry.js';
import { assertOwnKennel } from './kennelScope.js';
import { contactRepo } from './contactRepo.js';
import { deriveContactWaitlistStatus, prefChangeLines } from './waitlistRules.js';
import { todayYMD } from './dateUtils.js';
import { WAITLIST_ENTRY_STATUS, WAITLIST_LISTEN_MODE, WAITLIST_PREF_SEX } from './vocab.js';

// A family's status-page link token (W2 Plan §4): 256 random bits, hex. Minted by
// cloudWaitlist when the list goes online, and again by "New link".
export function newStatusToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const base = makeRepo('waitlist_entries', WAITLIST_ENTRY_REFERENCES);

const STATUSES = WAITLIST_ENTRY_STATUS.map((s) => s.value);
// From approval on, the family is a real Contact (created or matched at approval,
// Spec §5.2). Before that — and for a declined application — the applicant's name
// lives in `application` and no Contact need exist.
const NEEDS_CONTACT = ['approved', 'active', 'placed', 'removed'];
// Statuses that make the family a buyer (auto-tagged like saleRepo's referrer tag).
const BUYER_STATUSES = ['approved', 'active', 'placed'];

function validateEntry(c) {
  if (!STATUSES.includes(c.status)) throw new Error(`Waitlist entry: unknown status "${c.status}".`);
  if (NEEDS_CONTACT.includes(c.status) && !c.contact_id) {
    throw new Error('Waitlist entry: a contact is required once the family is approved.');
  }
  if (!c.contact_id && !(c.application && String(c.application.name || '').trim())) {
    throw new Error('Waitlist entry: the applicant\'s name is required.');
  }
  if (c.status === 'placed' && !c.placed_sale_id) {
    throw new Error('Waitlist entry: a placed family must be linked to its Sale.');
  }
  if (!WAITLIST_LISTEN_MODE.some((m) => m.value === c.listen_mode)) {
    throw new Error(`Waitlist entry: unknown listen mode "${c.listen_mode}".`);
  }
  if (!WAITLIST_PREF_SEX.some((s) => s.value === c.pref_sex)) {
    throw new Error(`Waitlist entry: unknown sex preference "${c.pref_sex}".`);
  }
}

// Fill the defaults a new entry needs, so the multi-entry listen indexes always see
// an array and the rules engine never meets an undefined mode.
function withDefaults(data) {
  return {
    listen_mode: 'all',
    pref_sex: 'any',
    listen_sire_ids: [],
    listen_dam_ids: [],
    ...data
  };
}

// Recompute one contact's waitlist_status from all their entries and write it only
// when it changed; tag them `buyer` while they're approved/on the list/placed.
async function syncContact(contactId) {
  if (!contactId) return;
  const contact = await db.contacts.get(contactId);
  if (!contact) return;
  const entries = await db.waitlist_entries.where('contact_id').equals(contactId).toArray();
  const status = deriveContactWaitlistStatus(entries);
  if ((contact.waitlist_status || 'none') !== status) {
    await contactRepo.update(contactId, { waitlist_status: status });
  }
  if (entries.some((e) => !e.is_archived && BUYER_STATUSES.includes(e.status))) {
    await contactRepo.ensureType(contactId, 'buyer');
  }
}

export const waitlistEntryRepo = {
  ...base,

  async create(data) {
    const candidate = withDefaults(data);
    validateEntry(candidate);
    await assertOwnKennel(candidate.kennel_id, 'Waitlist entry');
    const saved = await base.create(candidate);
    await syncContact(saved.contact_id);
    return saved;
  },

  async update(id, changes) {
    const existing = await db.waitlist_entries.get(id);
    if (!existing) throw new Error(`waitlist_entries: no record with id ${id}`);
    const merged = withDefaults({ ...existing, ...changes });
    validateEntry(merged);
    if (changes.kennel_id !== undefined && changes.kennel_id !== existing.kennel_id) {
      await assertOwnKennel(merged.kennel_id, 'Waitlist entry');
    }
    // Every change to the matching answers once the family is past review goes in
    // their history (Spec §15.9), so changing one and back is visible to her.
    // While an application is still under review it's just being filled in.
    // A caller that writes the log itself (approving a family's request, which logs
    // `by: 'request'`) passes `pref_change_log` and is trusted with it.
    const lines = existing.status === 'applied' || changes.pref_change_log !== undefined ? [] : prefChangeLines(existing, changes, { date: todayYMD() });
    if (lines.length) changes = { ...changes, pref_change_log: [...(existing.pref_change_log || []), ...lines] };
    const saved = await base.update(id, changes);
    // archive()/unarchive() route through here too, so is_archived changes resync.
    await syncContact(saved.contact_id);
    if (existing.contact_id && existing.contact_id !== saved.contact_id) await syncContact(existing.contact_id);
    return saved;
  },

  archive(id) {
    return waitlistEntryRepo.update(id, { is_archived: true });
  },

  unarchive(id) {
    return waitlistEntryRepo.update(id, { is_archived: false });
  },

  async hardDelete(id) {
    const existing = await db.waitlist_entries.get(id);
    await base.hardDelete(id);
    if (existing) await syncContact(existing.contact_id);
  },

  // One kennel's entries (every status) — the Waitlist page filters/ranks them via
  // waitlistRules.rankedList.
  async getByKennel(kennelId, { includeArchived = false } = {}) {
    const rows = await db.waitlist_entries.where('kennel_id').equals(kennelId).toArray();
    return includeArchived ? rows : rows.filter((e) => !e.is_archived);
  },

  // Every run through any kennel's list for one family — the Contact page's panel.
  getByContact(contactId) {
    return db.waitlist_entries.where('contact_id').equals(contactId).toArray();
  },

  // Families in one program.
  getByProgram(programId) {
    return db.waitlist_entries.where('waitlist_program_id').equals(programId).toArray();
  }
};

export { ReferenceBlockedError } from './repoBase.js';
