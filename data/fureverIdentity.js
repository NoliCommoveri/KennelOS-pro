// fureverIdentity.js — her Furever identity as PROGRAM data (K14-5; owner decision
// 2026-11-16: on her own kennel's record, cloud tier).
//
// What a family's Furever app knows her by: `breederKey` (the key it files her
// breeder card under, breederRepo.upsert by breeder_key), the kennel name,
// tagline, contact and vet on that card, and the kennel-wide content pack's Drive
// pointer. It used to live only in this browser's localStorage, so a resend from
// her second device, a restored backup on a new computer or a Reset App minted a
// new key, and the family's app forked her card (a second breeder row without the
// tagline, vet or kennel documents).
//
// Now it rides on one of her own kennels as `furever_identity`, which file backups,
// cloud backup and live sync all carry. settings.js's local copy stays as the
// synchronous cache every reader uses; this module keeps the two the same:
//   loadFureverIdentity()   — the kennel's copy wins when there is one (and fills
//                             the cache); else this device's copy moves onto the
//                             kennel, so its breederKey (already in packets sent)
//                             is the one kept.
//   saveFureverIdentity(v)  — setFureverSettings(v), then the kennel's copy.
// One key per program, shared by all her own kennels, as before (kennelRepo's
// public_id note): the identity sits on the first own kennel that carries it, or
// else on "My kennel". `driveConnected` is UI state and stays on the device.
import { kennelRepo } from './kennelRepo.js';
import { getFureverSettings, setFureverSettings, getMyKennelId } from './settings.js';

const IDENTITY_KEYS = ['breederKey', 'kennelName', 'tagline', 'breederContact', 'breederVet', 'contentPack'];

// The kennel-row value from settings' shape, by name. Pure.
export function identityForKennel(settings) {
  const out = {};
  for (const k of IDENTITY_KEYS) if (settings[k] !== undefined) out[k] = structuredClone(settings[k]);
  return out;
}

// Which own kennel carries it, and which one should when none does. Pure.
export function identityHome(kennels, myKennelId) {
  const own = kennels.filter((k) => k.is_own_kennel)
    .sort((a, b) => (!!a.is_archived - !!b.is_archived) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
  const carrier = own.find((k) => k.furever_identity && k.furever_identity.breederKey);
  if (carrier) return { kennel: carrier, carries: true };
  const mine = own.find((k) => k.id === myKennelId && !k.is_archived);
  return { kennel: mine || own.find((k) => !k.is_archived) || null, carries: false };
}

async function home() {
  return identityHome(await kennelRepo.getAll({ includeArchived: true }), getMyKennelId());
}

export async function loadFureverIdentity() {
  const { kennel, carries } = await home();
  if (kennel && carries) return setFureverSettings(identityForKennel(kennel.furever_identity));
  const local = getFureverSettings();
  if (kennel) {
    try { await kennelRepo.update(kennel.id, { furever_identity: identityForKennel(local) }); } catch { /* the Demo keeps nothing */ }
  }
  return local;
}

// Loads first, so a device that hasn't yet taken the kennel's copy never writes
// its own breederKey over it.
export async function saveFureverIdentity(values) {
  await loadFureverIdentity();
  const saved = setFureverSettings(values);
  const { kennel } = await home();
  if (kennel) {
    try { await kennelRepo.update(kennel.id, { furever_identity: identityForKennel(saved) }); } catch { /* the Demo keeps nothing */ }
  }
  return saved;
}
