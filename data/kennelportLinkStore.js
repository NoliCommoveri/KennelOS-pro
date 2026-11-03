// kennelportLinkStore.js — her KennelPort website link, per own kennel, on THIS
// device only (KennelPort plan 5.5, decision 11: each device links once). Rows
// `kennelport:<kennel id>` in the device-only `device_secrets` table (db.js),
// beside the vault key and her Jotform and Stripe keys; this module is the only
// reader/writer of the `kennelport:` rows.
//
// A row: { token, site: { name, website, extras_info_url, waitlist_page,
// kennelos_prices }, device_label, linked_at, last_sent_at, last_summary, sent }.
// `sent`: the last bundle this device sent (less its id and time), so Kels can
// say what an update would change (siteExport.bundleChanges).
// `site` is what KennelPort said last (each answer refreshes it). `kept_website`:
// the site address she said Keep mine to, for the kennel record's website.
// A device choice, like the rest of the row.
//
// Never in exportAll, a backup, a snapshot, a sync or a restore (db.dataTables()
// leaves device_secrets out), so a restored or synced device connects on its own.
// Reset App clears it with every other table. Not kennel data, so writing it
// doesn't mark the cloud backup dirty (tests/cloudDirty.test.js).
import { db } from './db.js';

const rowId = (kennelId) => `kennelport:${kennelId}`;

export async function getWebsiteLink(kennelId) {
  if (!kennelId) return null;
  const row = await db.device_secrets.get(rowId(kennelId));
  return row && row.token ? row : null;
}

export async function setWebsiteLink(kennelId, { token, site, device_label = '' }) {
  await db.device_secrets.put({ id: rowId(kennelId), kennel_id: kennelId, token, site: site || null, device_label, linked_at: new Date().toISOString(), last_sent_at: null, last_summary: null });
}

// After an answer from KennelPort: the site's facts, and after an Update website
// its summary and when.
export async function noteWebsiteAnswer(kennelId, { site, summary, kept_website, sent } = {}) {
  const row = await getWebsiteLink(kennelId);
  if (!row) return;
  await db.device_secrets.put({
    ...row,
    ...(site ? { site } : {}),
    ...(kept_website ? { kept_website } : {}),
    ...(sent ? { sent } : {}),
    ...(summary ? { last_summary: summary, last_sent_at: new Date().toISOString() } : {})
  });
}

export async function clearWebsiteLink(kennelId) {
  if (kennelId) await db.device_secrets.delete(rowId(kennelId));
}

// Is a website linked for any kennel on this device? (Kels asks about the
// website only then.)
export async function anyWebsiteLink() {
  return (await db.device_secrets.toArray()).some((r) => String(r.id).startsWith('kennelport:') && r.token);
}
