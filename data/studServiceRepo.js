// studServiceRepo.js — all Dexie access for the StudService table. Covers both
// directions: your stud servicing an outside female (`outgoing`) and you using
// an outside stud on your dam (`incoming`) — Data Model v3 §5.8.
//
// Owns the canonical studservice<->pairing link (`pairing_id`, mirrors
// Litter.pairing_id). There is no Pairing.stud_service_id — the reverse is
// always the derived query `getByPairing`.
import { db } from './db.js';
import { makeRepo } from './repoBase.js';
import { STUD_SERVICE_REFERENCES } from './referenceRegistry.js';
import { contactRepo } from './contactRepo.js';
import { todayYMD } from './dateUtils.js';

const base = makeRepo('stud_services', STUD_SERVICE_REFERENCES);

const REQUIRED_FIELDS = ['direction', 'our_dog_id', 'partner_dog_id', 'partner_contact_id', 'status'];

function validateStudService(candidate) {
  for (const f of REQUIRED_FIELDS) {
    if (candidate[f] == null || candidate[f] === '') {
      throw new Error(`StudService: "${f}" is required.`);
    }
  }
}

export const studServiceRepo = {
  ...base,

  async create(data) {
    validateStudService(data);
    const saved = await base.create(data);
    // Auto-tag the referral source as a Stud referrer (canonical FK stays
    // stud_services.referred_by_contact_id; this is a convenience role label).
    await contactRepo.ensureType(saved.referred_by_contact_id, 'stud_referrer');
    return saved;
  },

  async update(id, changes) {
    const existing = await db.stud_services.get(id);
    if (!existing) throw new Error(`stud_services: no record with id ${id}`);
    validateStudService({ ...existing, ...changes });
    const saved = await base.update(id, changes);
    await contactRepo.ensureType(saved.referred_by_contact_id, 'stud_referrer');
    return saved;
  },

  // The stud service(s) linked to a pairing — derived, since Pairing carries no
  // back-pointer (Data Model v3 §5.3, §5.8).
  getByPairing(pairingId) {
    return db.stud_services.where('pairing_id').equals(pairingId).toArray();
  },

  // Stud services with this outside partner (partner_contact_id is indexed) —
  // the reverse of the partner link, powering the partner companion bundle.
  getByPartnerContact(contactId) {
    return db.stud_services.where('partner_contact_id').equals(contactId).toArray();
  },

  // Stud services where this dog appears on either side — powers the Dog
  // Detail "Stud Services" panel.
  async getForDog(dogId) {
    const [asOurs, asPartner] = await Promise.all([
      db.stud_services.where('our_dog_id').equals(dogId).toArray(),
      db.stud_services.where('partner_dog_id').equals(dogId).toArray()
    ]);
    const byId = new Map();
    for (const s of [...asOurs, ...asPartner]) byId.set(s.id, s);
    return [...byId.values()];
  },

  // Away-board rows (Data Integrity Brief §5) — stud services where our dog
  // physically travelled and is still away today. Union'd with
  // eventRepo.getBoardRows() at the call site (data/awayBoard.js), never
  // replacing it — non-stud boarding stays (grow-out, foster, owner travel)
  // still come from Event. `type` is a plain unindexed field (§3.1), so this
  // filters in JS, same posture as is_archived elsewhere in the repo layer.
  // Away dog is always `our_dog_id`: whichever direction the service runs,
  // the dog that physically travels for an in-person service is ours.
  async getBoardRows() {
    const today = todayYMD();
    const all = await db.stud_services.toArray();
    const away = all.filter((s) =>
      !s.is_archived && s.type === 'in_person' && s.sent_date && s.sent_date <= today &&
      (s.returned_date == null || s.returned_date >= today)
    );
    const contacts = await Promise.all(
      away.map((s) => (s.partner_contact_id ? db.contacts.get(s.partner_contact_id) : null))
    );
    return away.map((s, i) => ({
      dogId: s.our_dog_id,
      location: contacts[i]?.address || '',
      reason: 'Stud service',
      contactId: s.partner_contact_id || null,
      outDate: s.sent_date,
      returnDate: s.returned_date || null,
      dropoffTime: '',
      pickupTime: '',
      sourceType: 'stud_service',
      sourceId: s.id,
      href: `stud-service.html?id=${encodeURIComponent(s.id)}`
    }));
  }
};

export { ReferenceBlockedError } from './repoBase.js';
