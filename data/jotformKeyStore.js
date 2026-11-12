// jotformKeyStore.js — forgets the Jotform API keys this device once kept.
// Connect Jotform is retired (Integrations plan D27, D29): the keys were rows
// `jotform:<account id>` in the device-only `device_secrets` table (db.js), never
// in a backup, a snapshot, a sync or a restore. Opening the app deletes any left.
// Not kennel data, so it doesn't mark the cloud backup dirty
// (tests/cloudDirty.test.js).
import { db } from './db.js';

// → the number of keys removed (0 when there were none).
export async function forgetJotformKeys() {
  const ids = (await db.device_secrets.toArray()).map((r) => r.id).filter((id) => String(id).startsWith('jotform:'));
  if (ids.length) await db.device_secrets.bulkDelete(ids);
  return ids.length;
}
