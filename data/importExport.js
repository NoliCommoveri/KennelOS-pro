// importExport.js — JSON backup/restore (and, later, CSV import mappings).
// Lives in the data layer, so unlike pages it may use `db` directly for the
// cross-table bulk/transaction work that restore needs.
//
// The export iterates whatever tables exist in the schema, so it stays correct
// as later stages add tables — no hardcoded table list (Data Model doc §9).
import { db } from './db.js';
import { setLastBackupDate, markDataChanged } from './settings.js';
import { assertWritable } from './demoMode.js';
import { enforceImportDogCap } from './editionConfig.js';
import { SYNC_REGISTRY, overlayCloudFields, snapshotRowToLocal } from './syncRegistry.js';

// Bumped only when the on-disk backup shape changes in a way that needs a
// migration. Tied to the Dexie schema version so an older file can be detected.
//   v2: file blobs (the `files` table's `blob`, backing Documents + expense
//       receipts) are base64-tagged so they survive JSON — see below. A v1 file
//       predates the `files` table entirely, so nothing there needs decoding.
export const BACKUP_FORMAT_VERSION = 2;

// --- Blob (binary) round-tripping -------------------------------------------
// JSON can't represent a Blob — JSON.stringify turns one into `{}`, silently
// dropping its bytes. The `files` table stores real Blobs (fileRepo.js), so on
// export we replace any Blob value with a base64 marker and on restore we
// rehydrate it. This keeps stored documents/receipts durable across both the
// JSON backup AND the Dropbox sync, which both go through exportAll/restoreBackup.
const BLOB_TAG = '__blob_b64__';

function isBlobMarker(v) {
  return !!v && typeof v === 'object' && v[BLOB_TAG] === true && typeof v.data === 'string';
}

export async function blobToMarker(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Chunked to avoid blowing the argument limit of String.fromCharCode on big files.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return { [BLOB_TAG]: true, mime: blob.type || 'application/octet-stream', data: btoa(binary) };
}

export function markerToBlob(marker) {
  const binary = atob(marker.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: marker.mime || 'application/octet-stream' });
}

// Shallow-scan a row's top-level values, encoding/decoding any Blob it holds
// (only files.blob today, but this stays correct if another table adds one).
async function encodeRowBlobs(row) {
  let out = row;
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Blob) {
      if (out === row) out = { ...row };
      out[k] = await blobToMarker(v);
    }
  }
  return out;
}

function decodeRowBlobs(row) {
  let out = row;
  for (const [k, v] of Object.entries(row)) {
    if (isBlobMarker(v)) {
      if (out === row) out = { ...row };
      out[k] = markerToBlob(v);
    }
  }
  return out;
}

// Build the full backup object: { schema_version, exported_at, collections }.
// `encodeBlobs: false` leaves file blobs as real Blobs — for the cloud snapshot
// builder (data/cloud/cloudBackup.js), which hashes and uploads them itself and
// never puts them in JSON. The file backup always encodes.
export async function exportAll({ encodeBlobs = true } = {}) {
  // Read every row out first, THEN encode blobs. Awaiting blob.arrayBuffer()
  // inside the Dexie transaction could let it auto-commit; the Blobs stay
  // readable after the transaction closes, so encode outside it.
  const raw = {};
  await db.transaction('r', db.tables, async () => {
    for (const table of db.tables) {
      raw[table.name] = await table.toArray();
    }
  });
  const collections = {};
  for (const [name, rows] of Object.entries(raw)) {
    collections[name] = encodeBlobs ? await Promise.all(rows.map(encodeRowBlobs)) : rows;
  }
  return {
    schema_version: db.verno,
    format_version: BACKUP_FORMAT_VERSION,
    exported_at: new Date().toISOString(),
    collections
  };
}

// Trigger a browser download of the backup and record the backup time.
export async function downloadBackup() {
  const data = await exportAll();
  const stamp = data.exported_at.slice(0, 19).replace(/[:T]/g, '-');
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `kennelos-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setLastBackupDate(data.exported_at);
  return data;
}

// Basic shape validation of a parsed backup object. Returns a summary of counts
// so the UI can show what a restore would load before touching anything.
export function inspectBackup(obj) {
  if (!obj || typeof obj !== 'object' || !obj.collections || typeof obj.collections !== 'object') {
    throw new Error('This does not look like a valid backup file (missing "collections").');
  }
  // Forward-compat guard: refuse a file whose on-disk format is NEWER than this
  // build understands — its blob encoding or shape may have changed (that's the
  // whole reason BACKUP_FORMAT_VERSION exists). Older/equal/absent is fine: a v1
  // file predates the field entirely (undefined) and carries no encoded blobs.
  const fmt = obj.format_version;
  if (typeof fmt === 'number' && fmt > BACKUP_FORMAT_VERSION) {
    throw new Error(
      `This backup was made by a newer version of KennelOS (backup format v${fmt}; ` +
      `this app understands up to v${BACKUP_FORMAT_VERSION}). Update the app, then restore.`
    );
  }
  const known = new Set(db.tables.map((t) => t.name));
  const counts = {};
  const unknownTables = [];
  for (const [name, rows] of Object.entries(obj.collections)) {
    if (!Array.isArray(rows)) throw new Error(`Collection "${name}" is not an array.`);
    if (!known.has(name)) unknownTables.push(name);
    counts[name] = rows.length;
  }
  return { schema_version: obj.schema_version, exported_at: obj.exported_at, counts, unknownTables };
}

// Restore a parsed backup.
//   mode 'cloud-merge' — a cloud snapshot (data/cloud/cloudBackup.js); see
//                    restoreCloudMerge below. Takes `opts`.
//   mode 'replace' — wipe EVERY known table, then load the file's rows, so the
//                    result is exactly the backup's contents. A table the backup
//                    omits ends up empty (a full export always includes all
//                    tables; this only matters for a partial/hand-edited file).
//   mode 'merge'   — upsert the file's rows by id, leaving other records intact.
// Unknown collections (tables not in this schema version) are skipped, not an error.
export async function restoreBackup(obj, mode, opts = {}) {
  assertWritable(); // restore is a full-DB write — inert in demo (defense-in-depth;
                    // the Import/Export page is also excluded from the demo build)
  if (mode === 'cloud-merge') return restoreCloudMerge(obj, opts);
  inspectBackup(obj);
  const known = new Set(db.tables.map((t) => t.name));
  const entries = Object.entries(obj.collections).filter(([name]) => known.has(name));

  // Edition bulk-import cap (cap spec §9). No-op in Pro/Demo; in Lite it throws a
  // CapExceededError when this restore would leave more than the allowed number of
  // active dogs. Runs BEFORE the transaction so a rejected restore writes nothing —
  // all-or-nothing, unlike the per-row CSV import (which lands the first N and
  // fails the rest). Dog rows carry no Blobs, so the raw backup rows classify fine
  // without decoding. `.filter(Boolean)` drops a null/hole from a hand-edited file.
  const incomingDogs = known.has('dogs')
    ? (obj.collections.dogs || []).filter(Boolean)
    : [];
  await enforceImportDogCap({ incomingDogs, mode });

  await db.transaction('rw', db.tables, async () => {
    // Replace is a full swap: clear every known table first so tables the backup
    // doesn't mention are emptied too, not just the ones it carries.
    if (mode === 'replace') {
      for (const table of db.tables) await table.clear();
    }
    for (const [name, rows] of entries) {
      if (rows.length) await db.table(name).bulkPut(rows.map(decodeRowBlobs));
    }
  });
  markDataChanged();
  return entries.map(([name, rows]) => ({ name, count: rows.length }));
}

// --- 'cloud-merge' (Cloud Phase 1 plan §4.3) --------------------------------
// The 'merge' mode bulkPuts whole rows, which would blank every private field
// on a device that has them. A cloud snapshot carries only the cloud tier, so
// this mode overlays FIELDS instead:
//   - existing local row: overlay only the registry's cloud fields
//     (syncRegistry.overlayCloudFields); private fields stay as they are.
//       overwrite: false (new-device restore, takeover) — only when the snapshot
//         row's updated_at is NEWER than the local row's. A locally newer row
//         keeps its own values, so no record mixes an old status with a new price.
//       overwrite: true ("Restore as of…") — a deliberate rollback, regardless
//         of updated_at.
//     `files` rows are content: an existing local file is left alone.
//   - missing local row: insert the snapshot row (private fields simply absent).
//   - local rows not in the snapshot: left alone. Restore never deletes.
//   - files: a kept file the device doesn't have is fetched by sha256 through
//     `opts.fetchFile(sha256, fileRow) → Blob` (the network lives in the cloud
//     modules, not here). With no fetchFile, or a fetch that fails, the file
//     row is skipped and listed in `missingFiles`.
//   - Lite cap: enforceImportDogCap over the merged dogs, as for a file restore.
// Reads and file fetches happen BEFORE the write transaction, which would
// otherwise auto-commit across a network await.

const CLOUD_SNAPSHOT_FORMAT = 1;

function assertCloudSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.collections || typeof snapshot.collections !== 'object') {
    throw new Error('This does not look like a cloud backup (missing "collections").');
  }
  if (snapshot.snapshot_format !== CLOUD_SNAPSHOT_FORMAT) {
    throw new Error(
      `This cloud backup uses format v${snapshot.snapshot_format}; this app understands ` +
      `v${CLOUD_SNAPSHOT_FORMAT}. Update the app, then restore.`
    );
  }
}

// Works out what a 'cloud-merge' restore would do, without writing. Returns
// { writes: { table: rows[] }, summary }, where summary counts per table
// { inserted, updated, keptLocal, unchanged } — `updated` is the "N records will
// be rolled back" number for "Restore as of…" (plan §4.3).
export async function planCloudMerge(snapshot, { overwrite = false } = {}) {
  assertCloudSnapshot(snapshot);
  const known = new Set(db.tables.map((t) => t.name));
  const writes = {};
  const summary = {};
  for (const [name, rows] of Object.entries(snapshot.collections)) {
    if (!known.has(name) || !SYNC_REGISTRY[name] || !Array.isArray(rows)) continue;
    const s = { inserted: 0, updated: 0, keptLocal: 0, unchanged: 0 };
    const out = [];
    for (const snapRow of rows) {
      if (!snapRow || !snapRow.id) continue;
      const local = await db.table(name).get(snapRow.id);
      if (!local) {
        out.push({ row: snapshotRowToLocal(name, snapRow), insert: true, snapRow });
        s.inserted++;
        continue;
      }
      if (name === 'files') { s.unchanged++; continue; }
      const newer = String(snapRow.updated_at ?? '') > String(local.updated_at ?? '');
      if (!overwrite && !newer) {
        if (String(snapRow.updated_at ?? '') === String(local.updated_at ?? '')) s.unchanged++;
        else s.keptLocal++;
        continue;
      }
      const merged = overlayCloudFields(name, local, snapRow);
      if (JSON.stringify(merged) === JSON.stringify(local)) { s.unchanged++; continue; }
      out.push({ row: merged, insert: false, snapRow });
      s.updated++;
    }
    writes[name] = out;
    summary[name] = s;
  }
  return { writes, summary };
}

export async function restoreCloudMerge(snapshot, { overwrite = false, fetchFile = null } = {}) {
  assertWritable();
  const { writes, summary } = await planCloudMerge(snapshot, { overwrite });

  // Files to fetch: inserted file rows need their bytes before anything is written.
  const missingFiles = [];
  if (writes.files) {
    const fetched = [];
    for (const w of writes.files) {
      let blob = null;
      if (fetchFile && w.snapRow.sha256) {
        try { blob = await fetchFile(w.snapRow.sha256, w.snapRow); } catch { blob = null; }
      }
      if (blob) fetched.push({ ...w, row: { ...w.row, blob } });
      else missingFiles.push(w.row.id);
    }
    writes.files = fetched;
    if (summary.files) summary.files.inserted = fetched.length;
  }

  // The Lite cap sees the dogs exactly as they'll be after the merge.
  if (writes.dogs && writes.dogs.length) {
    await enforceImportDogCap({ incomingDogs: writes.dogs.map((w) => w.row), mode: 'merge' });
  }

  const tables = Object.keys(writes).filter((n) => writes[n].length);
  if (tables.length) {
    await db.transaction('rw', tables.map((n) => db.table(n)), async () => {
      for (const n of tables) await db.table(n).bulkPut(writes[n].map((w) => w.row));
    });
    markDataChanged();
  }
  return { summary, missingFiles };
}

// Read a File object as parsed JSON.
export async function readBackupFile(file) {
  const text = await file.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Could not parse the file as JSON.');
  }
}
