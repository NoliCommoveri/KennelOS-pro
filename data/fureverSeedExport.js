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
//
// `contentPackages` (Content Package Fetch Mechanism §3.2/§4.3) rides along the
// same way: public Drive POINTERS only — packKey/manifestFileId/manifestResourceKey/
// version — never an API key, never file bytes. Only packs that are actually
// published are included; an unpublished kennel or litter pack is simply absent,
// so an unpublished pup carries no breeder docs until a later resend.
//
// `feedingSchedule` (Feeding Schedules feature, Pro-only) is named-copy-only the
// same way: a litter's own override (free text) takes priority, else the
// kennel's breed default (breedFeedingScheduleRepo, matched against dog.breed);
// null when neither is set, so Furever's Feeding page keeps its own generic
// age-bracket placeholder untouched.
import { getFureverSettings } from './settings.js';
import { litterRepo } from './litterRepo.js';
import { breedFeedingScheduleRepo } from './breedFeedingScheduleRepo.js';

export const SEED_PACKET_VERSION = 1;

// Furever's own deploy origin (build/README.md's deploy table) — a fixed
// constant, not edition config: every edition that ships this console (Pro,
// Demo) sends to the same family-facing app.
export const FUREVER_APP_URL = 'https://furever.kennelos.app/';

// One pointer entry, built by name from a persisted pack pointer (settings.js's
// contentPack, or a litter's furever_pack) — never a spread, so an internal-only
// pointer field (e.g. `selection`) never leaks into the packet.
function packagePointer(pack, scope) {
  if (!pack || !pack.packKey || !pack.manifestFileId) return null;
  const pointer = { packKey: pack.packKey, scope, manifestFileId: pack.manifestFileId, version: pack.version || 1 };
  if (pack.manifestResourceKey) pointer.manifestResourceKey = pack.manifestResourceKey;
  return pointer;
}

function collectContentPackages(identity, litter) {
  const packages = [];
  const kennelPointer = packagePointer(identity.contentPack, 'kennel');
  if (kennelPointer) packages.push(kennelPointer);
  const litterPointer = litter && packagePointer(litter.furever_pack, 'litter');
  if (litterPointer) packages.push(litterPointer);
  return packages;
}

// The pup's feeding guidance: a per-litter override (free text) takes priority;
// otherwise the kennel's own breed default. Both are named-copy-only (never a
// record spread) — see this module's header. Returns null when neither exists.
async function resolveFeedingSchedule(dog, litter) {
  const litterOverride = (litter && litter.feeding_schedule_override) || null;
  const breed = dog.breed ? await breedFeedingScheduleRepo.getByBreed(dog.breed) : null;
  if (!litterOverride && !breed) return null;
  return {
    litterOverride,
    breedSchedule: breed ? {
      foodBrand: breed.food_brand || '',
      ageColumns: breed.age_columns || [],
      weightRows: (breed.weight_rows || []).map((r) => ({ label: r.label || '', amounts: r.amounts || [] })),
      notes: breed.notes || ''
    } : null
  };
}

// `dog` is the pup being sent; `sale` (optional) supplies the per-placement
// note + pickup-plan fields the owner authored on the Sale (furever_note,
// furever_pickup_date/time/place/photo_url — plain Sale fields, no FK, schema
// doc's "fully authored by the breeding kennel" content).
export async function buildSeedPacket(dog, sale) {
  if (!dog) throw new Error('buildSeedPacket: a dog is required.');
  const identity = getFureverSettings();
  const litter = dog.litter_id ? await litterRepo.getById(dog.litter_id) : null;
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
    breederVet: identity.breederVet,
    contentPackages: collectContentPackages(identity, litter),
    feedingSchedule: await resolveFeedingSchedule(dog, litter)
  };
}
