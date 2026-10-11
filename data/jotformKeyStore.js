// jotformKeyStore.js — her Jotform API key, per Form service account, on THIS
// device only (Integrations plan §2.1b, D16 decided 2026-10-11: on the device).
// Rows `jotform:<account id>` in the device-only `device_secrets` table (db.js),
// beside the vault key (cloud/vaultKeyStore.js, which keeps its own rows); this
// module is the only reader/writer of the `jotform:` rows.
//
// Never in exportAll, a backup, a snapshot, a sync or a restore (db.dataTables()
// leaves device_secrets out), so each device connects on its own and Disconnect
// forgets it here only. Reset App clears it with every other table. Not kennel
// data, so writing it doesn't mark the cloud backup dirty (tests/cloudDirty.test.js).
import { db } from './db.js';

const rowId = (accountId) => `jotform:${accountId}`;

// → { api_key, region, username, connected_at } or null.
export async function getJotformKey(accountId) {
  if (!accountId) return null;
  const row = await db.device_secrets.get(rowId(accountId));
  return row && row.api_key ? { api_key: row.api_key, region: row.region || 'us', username: row.username || '', connected_at: row.connected_at || '' } : null;
}

export async function setJotformKey(accountId, { api_key, region, username = '' }) {
  await db.device_secrets.put({ id: rowId(accountId), account_id: accountId, api_key, region, username, connected_at: new Date().toISOString() });
}

export async function clearJotformKey(accountId) {
  if (accountId) await db.device_secrets.delete(rowId(accountId));
}
