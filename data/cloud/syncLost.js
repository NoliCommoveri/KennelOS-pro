// syncLost.js — versions this device lost to live sync, kept 30 days so she can
// put one back (Cloud Phase 2 plan §2.3, Modified; the K03 review's follow-up).
//
// What counts as lost: when a pull replaces or deletes a row here that held an
// edit not sent yet (`kept_theirs`), this device's own sent version
// (`replaced_mine`), or, in a join, a different version with an earlier date.
// syncApply.js writes the row as it was into the device-only `sync_lost` table
// (db.js version 8) inside the same transaction as the overwrite, and the
// activity line carries its id. Files rows aren't kept (written once, never
// edited). Nothing here travels: not in a backup, a snapshot or sync.
//
// Putting it back is a local edit: the kept row is written with a new
// `updated_at`, markDataChanged() fires, and the next push sends it to every
// device, where it replaces what's there (the server's last-received rule).
import { db } from '../db.js';
import { markDataChanged } from '../settings.js';

export const KEEP_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

// Fields that say nothing she'd recognise as a difference.
const QUIET_FIELDS = new Set(['updated_at', 'created_at', 'id']);

export const lostId = (tbl, rowId, seq) => `${tbl}:${rowId}:${seq}`;

// The row syncApply stores for one loss (pure).
export function lostRecord({ tbl, id, seq, row, kind, by = null, op = 'put' }, now = new Date()) {
  return { id: lostId(tbl, id, seq), at: now.toISOString(), tbl, row_id: id, row: structuredClone(row), kind, by, op };
}

export async function getLostVersion(id) {
  return (await db.sync_lost.get(id)) || null;
}

// → Set of the ids still kept (for the activity list's buttons).
export async function keptLostIds() {
  return new Set((await db.sync_lost.toArray()).map((r) => r.id));
}

// The fields whose values differ between the kept version and the record as it
// is now (null: deleted here), as field names, quiet ones left out (pure).
export function lostDifferences(kept, current) {
  if (!current) return ['the whole record (it was deleted)'];
  const keys = new Set([...Object.keys(kept || {}), ...Object.keys(current)]);
  const out = [];
  for (const k of keys) {
    if (QUIET_FIELDS.has(k)) continue;
    if (JSON.stringify(kept?.[k] ?? null) !== JSON.stringify(current[k] ?? null)) out.push(k.replace(/_/g, ' '));
  }
  return out.sort();
}

// What the activity list shows for a kept version: { tbl, rowId, row, at, current, fields }.
export async function describeLostVersion(id) {
  const lost = await getLostVersion(id);
  if (!lost) return null;
  let current = null;
  try { current = (await db.table(lost.tbl).get(lost.row_id)) || null; } catch { /* a table gone from this build */ }
  return { tbl: lost.tbl, rowId: lost.row_id, row: lost.row, at: lost.at, current, fields: lostDifferences(lost.row, current) };
}

// "Put mine back": the kept row becomes the record here again, dated now, and
// goes to every device with the next push. → the row written, or null when the
// kept version is gone (past 30 days, or already put back / forgotten).
export async function putMineBack(id, now = new Date()) {
  const lost = await getLostVersion(id);
  if (!lost) return null;
  const row = { ...lost.row, updated_at: now.toISOString() };
  await db.transaction('rw', [db.table(lost.tbl), db.sync_lost], async () => {
    await db.table(lost.tbl).put(row);
    await db.sync_lost.delete(id);
  });
  markDataChanged();
  return row;
}

// "Forget it": she doesn't want it back.
export async function forgetLostVersion(id) {
  await db.sync_lost.delete(id);
}

// The 30-day sweep, run after each pull. → how many went.
export async function pruneLostVersions(now = new Date()) {
  const cutoff = new Date(now.getTime() - KEEP_DAYS * DAY).toISOString();
  const old = (await db.sync_lost.toArray()).filter((r) => !(r.at >= cutoff)).map((r) => r.id);
  if (old.length) await db.sync_lost.bulkDelete(old);
  return old.length;
}

// Sign-out, another account, turning sync off: what was lost belonged to that
// program's sync.
export async function clearLostVersions() {
  await db.sync_lost.clear();
}
