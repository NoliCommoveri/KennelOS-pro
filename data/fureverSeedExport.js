// fureverSeedExport.js — builds the seed packet for a KennelOS Furever seed link
// (the Send-to-Furever action on the Furever console, pages/furever.*).
//
// Named-copy-only, like companionExport.js's allow-list builders (that file's own
// header explains why): the packet is built field-by-field from the dog + the
// owner's saved Furever identity, never a record spread, so a new Dog/Sale field
// never rides along silently. The shape matches exactly what the Furever decoder
// (furever/data/seedLink.js) reads by name on the other side — breederRepo.
// upsertFromSeed (breederKey, kennelName, tagline, breederContact, breederVet) and
// petRepo.upsertSeededPet (pupId, name, species, sex, breed, dob, photoUrl) — plus
// note/pickupPlan, which ride along unindexed in the family app's pet.seed.
import { getFureverSettings } from './settings.js';

export const SEED_PACKET_VERSION = 1;

// Furever's own deploy origin (build/README.md's deploy table) — a fixed
// constant, not edition config: every edition that ships this console (Pro,
// Demo) sends to the same family-facing app.
export const FUREVER_APP_URL = 'https://furever.kennelos.app/';

// `dog` is the pup being sent; `sale` (optional) supplies the per-placement
// note + pickup-plan fields the owner authored on the Sale (furever_note,
// furever_pickup_date/time/place/photo_url — plain Sale fields, no FK, schema
// doc's "fully authored by the breeding kennel" content).
export function buildSeedPacket(dog, sale) {
  if (!dog) throw new Error('buildSeedPacket: a dog is required.');
  const identity = getFureverSettings();
  return {
    packetVersion: SEED_PACKET_VERSION,
    pupId: dog.id,
    breederKey: identity.breederKey,
    name: dog.call_name || '',
    species: 'dog',
    sex: dog.sex || null,
    breed: dog.breed || null,
    dob: dog.date_of_birth || null,
    photoUrl: dog.url || null,
    note: (sale && sale.furever_note) || '',
    pickupPlan: {
      photoUrl: (sale && sale.furever_pickup_photo_url) || '',
      date: (sale && sale.furever_pickup_date) || '',
      time: (sale && sale.furever_pickup_time) || '',
      place: (sale && sale.furever_pickup_place) || ''
    },
    kennelName: identity.kennelName,
    tagline: identity.tagline,
    breederContact: identity.breederContact,
    breederVet: identity.breederVet
  };
}
