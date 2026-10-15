// studServiceRepo.js — all Dexie access for the StudService table: your stud on
// an outside dam, or an outside stud on your dam (Data Model v3 §5.8). Which one
// is ours comes from our dog's sex (studRules.ourRole); `direction` is who
// travels (to_partner / to_us / shipped), and `type` follows it (shipped → ai,
// else in_person), so it's never set by hand.
//
// Owns the canonical studservice<->pairing link (`pairing_id`, mirrors
// Litter.pairing_id). There is no Pairing.stud_service_id — the reverse is
// always the derived query `getByPairing`.
import { db } from './db.js';
import { makeRepo } from './repoBase.js';
import { STUD_SERVICE_REFERENCES } from './referenceRegistry.js';
import { assertOwnKennel } from './kennelScope.js';
import { contactRepo } from './contactRepo.js';
import { eventRepo } from './eventRepo.js';
import { getStudTripsMigrated, markStudTripsMigrated } from './settings.js';
import { travellingDogId, studBoardingFor, studBoardingPrefill } from './studRules.js';

const base = makeRepo('stud_services', STUD_SERVICE_REFERENCES);

const REQUIRED_FIELDS = ['direction', 'our_dog_id', 'partner_dog_id', 'partner_contact_id', 'status'];

// `type` from `direction`: only a shipment is AI; anyone travelling is in person.
const withType = (r) => (r.direction ? { ...r, type: r.direction === 'shipped' ? 'ai' : 'in_person' } : r);

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
    data = withType(data);
    validateStudService(data);
    // Kennel scope (Multi-Kennel Scope Spec §4.3) — inherited from OUR dog, never
    // the partner's: the partner is by definition somebody else's.
    await assertOwnKennel(data.kennel_id, 'Stud service');
    const saved = await base.create(data);
    // Auto-tag the referral source as a Stud referrer (canonical FK stays
    // stud_services.referred_by_contact_id; this is a convenience role label).
    await contactRepo.ensureType(saved.referred_by_contact_id, 'stud_referrer');
    return saved;
  },

  async update(id, changes) {
    const existing = await db.stud_services.get(id);
    if (!existing) throw new Error(`stud_services: no record with id ${id}`);
    if (changes.direction) changes = withType(changes);
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

  // Trips are boarding events now, not the service's own dates. Run on every boot:
  // 1. a direction from before it meant who travels (outgoing / incoming) becomes
  //    shipped for AI, else to_partner (how the Away board read it then: our dog
  //    went). Cheap and idempotent, so a restored older file is caught too.
  // 2. once per device (settings flag): every in-person service with a start date,
  //    not cancelled, whose trip has no stud boarding yet gets one
  //    (studRules.studBoardingPrefill). The match check keeps a second device, or a
  //    re-run after Reset App, from adding it twice.
  async migrateStudTrips() {
    const all = await db.stud_services.toArray();
    for (const s of all) {
      if (s.direction !== 'outgoing' && s.direction !== 'incoming') continue;
      await this.update(s.id, { direction: s.type === 'ai' ? 'shipped' : 'to_partner' });
    }
    if (getStudTripsMigrated()) return;
    for (const s of await db.stud_services.toArray()) {
      if (s.is_archived || s.status === 'cancelled' || !s.sent_date || !travellingDogId(s)) continue;
      const dogId = travellingDogId(s);
      if (studBoardingFor(s, await eventRepo.getForSubject('dog', dogId))) continue;
      const partner = s.partner_contact_id ? await db.contacts.get(s.partner_contact_id) : null;
      const { event_end_date, ...rest } = studBoardingPrefill(s, partner);
      await eventRepo.create({ subject_type: 'dog', subject_id: dogId, ...rest, event_end_date: event_end_date || null });
    }
    markStudTripsMigrated();
  }
};

export { ReferenceBlockedError } from './repoBase.js';
