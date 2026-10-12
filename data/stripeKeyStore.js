// stripeKeyStore.js — her own Stripe restricted key, per Account, on THIS device
// only (Integrations plan §4, step 6: her own key, decided 2026-10-12). Rows
// `stripe:<account id>` in the device-only `device_secrets` table (db.js); this
// module is the only reader/writer of those rows (jotformKeyStore.js and
// cloud/vaultKeyStore.js keep theirs).
//
// Never in exportAll, a backup, a snapshot, a sync or a restore, so each device
// connects on its own; Disconnect and deleting the account forget it here. Not
// kennel data, so writing it doesn't mark the cloud backup dirty
// (tests/cloudDirty.test.js).
import { db } from './db.js';

const rowId = (accountId) => `stripe:${accountId}`;

// → { api_key, currency, connected_at } or null.
export async function getStripeKey(accountId) {
  if (!accountId) return null;
  const row = await db.device_secrets.get(rowId(accountId));
  return row && row.api_key ? { api_key: row.api_key, currency: row.currency || 'usd', connected_at: row.connected_at || '' } : null;
}

export async function setStripeKey(accountId, { api_key, currency }) {
  await db.device_secrets.put({ id: rowId(accountId), account_id: accountId, api_key, currency, connected_at: new Date().toISOString() });
}

export async function clearStripeKey(accountId) {
  if (accountId) await db.device_secrets.delete(rowId(accountId));
}
