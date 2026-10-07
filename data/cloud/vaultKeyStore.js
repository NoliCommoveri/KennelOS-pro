// vaultKeyStore.js — this device's unlocked private-vault key (Private Vault
// Plan §3.3), and its open request to be unlocked by another device (§5.3).
// The ONLY reader/writer of the `device_secrets` table (db.js).
//
// The key is stored as a CryptoKey object, which IndexedDB keeps as-is and
// localStorage (settings.js) can't hold. One row, tagged with the program it
// belongs to, so signing in to a different account never uses the wrong key.
// Extractable, because approving another device has to wrap it; that adds no
// exposure, since the same IndexedDB already holds the private data in the clear.
//
// Never in exportAll, a backup, a snapshot or a restore (db.dataTables()); Reset
// App and remote erase clear it with every other table. Not kennel data, so
// writing it doesn't mark the cloud backup dirty (tests/cloudDirty.test.js).
import { db } from '../db.js';

const ROW_ID = 'vault-key';
const PAIRING_ROW_ID = 'vault-pairing';

// → { key: CryptoKey, keyId } for `programId`, or null (locked on this device,
// or the stored key belongs to another program).
export async function getVaultKey(programId) {
  if (!programId) return null;
  const row = await db.device_secrets.get(ROW_ID);
  if (!row || row.program_id !== programId || !row.key || !row.key_id) return null;
  return { key: row.key, keyId: row.key_id };
}

export async function setVaultKey(programId, { key, keyId }) {
  await db.device_secrets.put({ id: ROW_ID, program_id: programId, key, key_id: keyId, stored_at: new Date().toISOString() });
}

// Forget the key on this device (the vault was turned off or re-keyed). The
// cloud copy and the other devices are untouched.
export async function clearVaultKey() {
  await db.device_secrets.delete(ROW_ID);
}

// --- An open "unlock me from another device" request (§2.4, §5.3) -------------
// Kept here, not in memory, because this is a multi-page app and a phone may
// reload the page while its owner walks to the other device. Holds the ECDH
// private key (a NON-extractable CryptoKey) and the code shown on screen; both
// are useless once the request expires (10 minutes) or is answered, and the row
// is deleted then. One at a time: a new request replaces the old.
//   { pairingId, privateKey, code, expiresAt }
export async function getPendingPairing(programId) {
  if (!programId) return null;
  const row = await db.device_secrets.get(PAIRING_ROW_ID);
  if (!row || row.program_id !== programId) return null;
  return { pairingId: row.pairing_id, privateKey: row.private_key, code: row.code, expiresAt: row.expires_at };
}

export async function setPendingPairing(programId, { pairingId, privateKey, code, expiresAt }) {
  await db.device_secrets.put({
    id: PAIRING_ROW_ID, program_id: programId, pairing_id: pairingId, private_key: privateKey, code, expires_at: expiresAt
  });
}

export async function clearPendingPairing() {
  await db.device_secrets.delete(PAIRING_ROW_ID);
}
