// syncState.js — what this device has synced (Cloud Phase 2 plan §3.3, §3.4).
//
// The ONLY reader/writer of the device-only `sync_meta` table (db.js
// version 2): one row per synced record, `{ id: '<table>:<row id>', tbl,
// row_id, seq, hash }`, where `seq` is the server's seq for the version this
// device last pushed or pulled and `hash` is syncRecords.rowHash of the row
// then. Like `device_secrets` it never travels: not in exportAll, a file or
// Dropbox backup, a snapshot, or the sample manifest. Reset App clears it.
//
// The scan (§3.3): rather than hooking every writer, compare every syncing
// row's hash with sync_meta. A row whose hash differs, or that sync_meta
// doesn't know, is a put; a sync_meta entry whose row is gone is a delete.
// Sample rows never sync (§3.5).
import { db } from '../db.js';
import { exportAll } from '../importExport.js';
import { getSampleDataManifest } from '../settings.js';
import { SYNC_TABLES, rowHash, prepareFileRow, cloudFileIds } from './syncRecords.js';

export const metaId = (table, id) => `${table}:${id}`;

// → Map(metaId → { id, tbl, row_id, seq, hash })
export async function readSyncMeta() {
  const rows = await db.sync_meta.toArray();
  return new Map(rows.map((m) => [m.id, m]));
}

// entries: [{ tbl, row_id, seq, hash }]
export async function writeSyncMeta(entries) {
  if (!entries.length) return;
  await db.sync_meta.bulkPut(entries.map((e) => ({ id: metaId(e.tbl, e.row_id), tbl: e.tbl, row_id: e.row_id, seq: e.seq, hash: e.hash })));
}

export async function removeSyncMeta(entries) {
  if (!entries.length) return;
  await db.sync_meta.bulkDelete(entries.map((e) => metaId(e.tbl, e.row_id)));
}

export async function clearSyncMeta() {
  await db.sync_meta.clear();
}

// A file's own SHA-256, cached by id + size + created_at: file rows are written
// once, so re-reading the blob each scan would be waste (plan §3.3).
const fileShaCache = new Map();
async function fileSha(row) {
  if (!(row.blob instanceof Blob)) return null;
  const key = `${row.id}|${row.blob.size}|${row.created_at ?? ''}`;
  if (!fileShaCache.has(key)) {
    const digest = await crypto.subtle.digest('SHA-256', await row.blob.arrayBuffer());
    fileShaCache.set(key, [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''));
  }
  return fileShaCache.get(key);
}

// One row as it syncs and its hash: the ONE place that says how a local row is
// hashed, used by the scan and by syncApply (so a pulled row's sync_meta hash is
// exactly what the next scan computes). `plainSha256` overrides the file hash
// (syncApply knows it from the record); otherwise it's read from the blob.
export async function syncRowFor(table, row, keptFileIds, { plainSha256 } = {}) {
  if (table !== 'files') return { syncRow: row, blob: null, cloudFile: false, hash: await rowHash(table, row, null) };
  const blob = row.blob instanceof Blob ? row.blob : null;
  const sha = plainSha256 !== undefined ? plainSha256 : await fileSha(row);
  const syncRow = prepareFileRow(row, blob ? sha : null);
  const cloudFile = keptFileIds.has(row.id);
  return { syncRow, blob, cloudFile, hash: await rowHash(table, syncRow, { cloud: cloudFile }) };
}

// Every syncing row on this device as it syncs, sample rows left out:
// → { rows: Map(metaId → { tbl, row_id, syncRow, blob, cloudFile, hash }),
//     keptFileIds }. `backup` reuses an exportAll({ encodeBlobs: false }).
export async function readSyncRows({ backup = null, manifest = getSampleDataManifest() } = {}) {
  backup = backup || await exportAll({ encodeBlobs: false });
  const keptFileIds = cloudFileIds(withoutSample(backup.collections.documents, manifest?.documents));
  const rows = new Map();
  for (const table of SYNC_TABLES) {
    const list = withoutSample(backup.collections[table], manifest?.[table]);
    for (const row of list) {
      if (!row || !row.id) continue;
      rows.set(metaId(table, row.id), { tbl: table, row_id: row.id, ...(await syncRowFor(table, row, keptFileIds)) });
    }
  }
  return { rows, keptFileIds };
}

function withoutSample(list, sampleIds) {
  if (!Array.isArray(list)) return [];
  if (!Array.isArray(sampleIds) || !sampleIds.length) return list;
  const ids = new Set(sampleIds);
  return list.filter((r) => !ids.has(r?.id));
}

// The scan itself, over rows from readSyncRows and the meta from readSyncMeta:
// → { puts: [row entry + baseSeq], deletes: [{ tbl, row_id, baseSeq }] }.
// Pure, so it's tested without a db.
export function diffSyncRows(rows, meta) {
  const puts = [];
  const deletes = [];
  for (const [key, r] of rows) {
    const m = meta.get(key);
    if (!m || m.hash !== r.hash) puts.push({ ...r, baseSeq: m ? m.seq : 0 });
  }
  for (const [key, m] of meta) {
    if (!rows.has(key)) deletes.push({ tbl: m.tbl, row_id: m.row_id, baseSeq: m.seq });
  }
  return { puts, deletes };
}

// readSyncRows + readSyncMeta + diffSyncRows.
export async function scanLocalChanges(opts = {}) {
  const [{ rows, keptFileIds }, meta] = await Promise.all([readSyncRows(opts), readSyncMeta()]);
  return { ...diffSyncRows(rows, meta), rows, keptFileIds, meta };
}
