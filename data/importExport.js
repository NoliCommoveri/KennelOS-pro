// importExport.js — JSON backup/restore (and, later, CSV import mappings).
// Lives in the data layer, so unlike pages it may use `db` directly for the
// cross-table bulk/transaction work that restore needs.
//
// The export iterates whatever data tables exist in the schema (dataTables():
// every table but the device-only ones, db.js), so it stays correct as later
// stages add tables — no hardcoded table list (Data Model doc §9).
import { db, dataTables } from './db.js';
import { setLastBackupDate, markDataChanged, getMyKennelId, setMyKennelId, getCloudBackupState, getCloudSyncState, remapStoredIds } from './settings.js';
import { planMatches, dogClashes, mergePair, rekey, clashKey, describeRecord } from './restoreMatch.js';
import { assertWritable } from './demoMode.js';
import { enforceImportDogCap } from './editionConfig.js';
import { SYNC_REGISTRY, overlayCloudFields, snapshotRowToLocal, isCloudField } from './syncRegistry.js';

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
  const tables = dataTables();
  await db.transaction('r', tables, async () => {
    for (const table of tables) {
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
  const known = new Set(dataTables().map((t) => t.name));
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
//   mode 'vault-merge' — a decrypted private-vault payload; see
//                    restoreVaultMerge below. Takes `opts`.
//   mode 'replace' — wipe EVERY known table, then load the file's rows, so the
//                    result is exactly the backup's contents. A table the backup
//                    omits ends up empty (a full export always includes all
//                    tables; this only matters for a partial/hand-edited file).
//   mode 'merge'   — upsert the file's rows by id, leaving other records intact;
//                    see restoreFileMerge below. Takes `opts`.
// Unknown collections (tables not in this schema version) are skipped, not an error.
export async function restoreBackup(obj, mode, opts = {}) {
  assertWritable(); // restore is a full-DB write — inert in demo (defense-in-depth;
                    // the Import/Export page is also excluded from the demo build)
  if (mode === 'cloud-merge') return restoreCloudMerge(obj, opts);
  if (mode === 'vault-merge') return restoreVaultMerge(obj, opts);
  if (mode === 'merge') return restoreFileMerge(obj, opts);
  inspectBackup(obj);
  const entries = knownEntries(obj);

  // Edition bulk-import cap (cap spec §9). No-op in Pro/Demo; in Lite it throws a
  // CapExceededError when this restore would leave more than the allowed number of
  // active dogs. Runs BEFORE the transaction so a rejected restore writes nothing —
  // all-or-nothing, unlike the per-row CSV import (which lands the first N and
  // fails the rest). Dog rows carry no Blobs, so the raw backup rows classify fine
  // without decoding. `.filter(Boolean)` drops a null/hole from a hand-edited file.
  const incomingDogs = (entries.find(([name]) => name === 'dogs')?.[1] || []).filter(Boolean);
  await enforceImportDogCap({ incomingDogs, mode });

  const tables = dataTables();
  await db.transaction('rw', tables, async () => {
    // Replace is a full swap: clear every known table first so tables the backup
    // doesn't mention are emptied too, not just the ones it carries. Device-only
    // tables (the vault key) aren't records and are left alone.
    if (mode === 'replace') {
      for (const table of tables) await table.clear();
    }
    for (const [name, rows] of entries) {
      if (rows.length) await db.table(name).bulkPut(rows.map(decodeRowBlobs));
    }
  });
  markDataChanged();
  await pointMyKennelAtRestoredKennel();
  return entries.map(([name, rows]) => ({ name, count: rows.length }));
}

// The file's collections this schema knows: [[tableName, rows]].
function knownEntries(obj) {
  const known = new Set(dataTables().map((t) => t.name));
  return Object.entries(obj.collections).filter(([name]) => known.has(name));
}


// This device's copy was changed after the file's. A row without updated_at on
// either side can't be compared, so the file's copy is taken, as before.
const localIsNewer = (local, row) => Boolean(local && row && local.updated_at && row.updated_at && local.updated_at > row.updated_at);

// --- 'merge' (a backup file or a Dropbox pull) -------------------------------
// Rows are matched by id first. Then records the two sides each entered on their
// own (two ids for one dog) are paired by content (data/restoreMatch.js, guide
// §10), given one id, and merged field by field. What to do is planned first
// (planFileMerge, no writes), so the Import/Export page can ask her about:
//   - asks: pairs the rules aren't sure of ("Are these the same?"); `answers`
//     carries what she said ({ askKey: localId | 'none' }), and the plan is made
//     again with them, since a Yes can pair more (a litter once its dam is paired);
//   - clashes: a paired dog's name, sex or parents differing (`clashChoices`:
//     { clashKey: 'local' | 'file' }; unanswered, the newer record wins);
//   - newerHere: rows with the same id that this device changed after the file's
//     copy (`keepNewer`: leave them as they are; otherwise the file's copy wins).
// Which id a pair keeps: the backup's, so two devices that restore each other's
// files end up with one set of ids, unless this device has cloud backup or live
// sync on (its cloud copy must never see records vanish and reappear). The old id
// is replaced everywhere on this device: every record, device-only rows, and this
// app's settings (rekey).

async function readLocal(tables) {
  const out = {};
  for (const t of tables) out[t.name] = await t.toArray();
  return out;
}

function incomingOf(obj) {
  return Object.fromEntries(knownEntries(obj).map(([name, rows]) => [name, rows.filter(Boolean)]));
}

// This device keeps its own ids when its records are mirrored in the cloud.
export function keepsOwnIds() {
  return Boolean(getCloudBackupState().enabled || getCloudSyncState().enabled);
}

// Names a referenced record for the preview, from either side.
function namer(local, incoming) {
  const find = (table, id) => (local[table] || []).find((r) => r.id === id) || (incoming[table] || []).find((r) => r.id === id);
  const nameOf = (table, id) => {
    const r = id && find(table, id);
    if (!r) return '';
    if (table === 'dogs') return r.call_name || r.registered_name || '';
    if (table === 'contacts') return r.name || '';
    if (table === 'kennels') return r.kennel_name || '';
    if (table === 'litters') return [nameOf('dogs', r.dam_id), nameOf('dogs', r.sire_id)].filter(Boolean).join(' × ');
    return r.name || r.title || '';
  };
  return { find, nameOf };
}

// Works out what a file 'merge' would do, without writing:
// { added, updated, newerHere, matched, asks, clashes }.
//   added: rows only in the file; updated: same id, the file's copy as new or
//   newer; newerHere: same id, changed here after the file's copy; matched: rows
//   paired by content. asks: [{ key, table, file: text, candidates: [{ id, text }] }];
//   clashes: [{ key, label, local: text, file: text }].
export async function planFileMerge(obj, { answers = {} } = {}) {
  inspectBackup(obj);
  const local = await readLocal(dataTables());
  const incoming = incomingOf(obj);
  const { pairs, asks } = planMatches({ local, incoming, answers });
  const paired = new Set(pairs.map((p) => p.fileId));
  const summary = { added: 0, updated: 0, newerHere: 0, matched: 0 };
  for (const [name, rows] of Object.entries(incoming)) {
    const mine = new Map((local[name] || []).map((r) => [r.id, r]));
    for (const r of rows) {
      const m = mine.get(r.id);
      if (m) summary[localIsNewer(m, r) ? 'newerHere' : 'updated']++;
      else summary[paired.has(r.id) ? 'matched' : 'added']++;
    }
  }
  return { ...summary, ...questions(local, incoming, pairs, asks) };
}

// The preview's questions in words: "Are these the same?" and a paired dog's clashes.
function questions(local, incoming, pairs, asks) {
  const { find, nameOf } = namer(local, incoming);
  const text = (table, id) => describeRecord(table, find(table, id) || {}, nameOf);
  const show = (c, v) => (c.ref ? nameOf('dogs', v) || 'another dog' : String(v));
  return {
    asks: asks.map((q) => ({
      key: q.key, table: q.table, file: text(q.table, q.fileId),
      candidates: q.candidates.map((id) => ({ id, text: text(q.table, id) }))
    })),
    clashes: dogClashes({ local, incoming, pairs }).map((c) => ({
      key: c.key, label: c.label, dog: nameOf('dogs', c.localId), local: show(c, c.local), file: show(c, c.file)
    }))
  };
}

// --- A device joining live sync (Cloud Phase 2 plan §5.5) ------------------------
// The same content matching as a file Merge (data/restoreMatch.js, guide §10),
// between this device's records and the cloud's (`incoming`: { table: whole rows },
// decrypted), before the join pulls anything. A pair keeps the CLOUD's id: the
// other devices already have it, so only this device re-keys (every field of
// every record, device-only rows and settings, as a file Merge does). The merged
// row is stamped now, so the join's newer-wins pull keeps it and pushes it up.
// planJoinMatches → { matched, asks, clashes } (no writes; answers as planFileMerge).
export async function planJoinMatches(incoming, { answers = {} } = {}) {
  const local = await readLocal(dataTables());
  const { pairs, asks } = planMatches({ local, incoming, answers });
  return { matched: pairs.length, ...questions(local, incoming, pairs, asks) };
}

// Writes the pairs (unanswered questions stay two records). → how many were paired.
export async function mergeJoinMatches(incoming, { answers = {}, clashChoices = {}, now = new Date() } = {}) {
  assertWritable();
  const tables = dataTables();
  const local = await readLocal(tables);
  const { pairs } = planMatches({ local, incoming, answers });
  if (!pairs.length) return 0;
  const localRemap = new Map(pairs.map((p) => [p.localId, p.fileId]));
  const pairedIds = new Set(pairs.map((p) => p.fileId));
  const stamp = now.toISOString();
  const writes = {};
  const deletes = {};
  for (const { name } of tables) {
    const theirs = new Map((incoming[name] || []).filter(Boolean).map((r) => [r.id, r]));
    for (const r of local[name] || []) {
      const n = rekey(r, localRemap);
      if (n === r) continue;
      if (n.id !== r.id) (deletes[name] ||= []).push(r.id);
      const cloud = pairedIds.has(n.id) ? theirs.get(n.id) : null;
      const row = cloud
        ? { ...mergePair(n, cloud, { table: name, choose: (field) => clashChoices[clashKey(n.id, field)] }), updated_at: stamp }
        : n;
      (writes[name] ||= []).push(row);
    }
  }
  const secrets = db.table('device_secrets');
  await db.transaction('rw', [...tables, secrets], async () => {
    for (const [name, ids] of Object.entries(deletes)) await db.table(name).bulkDelete(ids);
    for (const [name, rows] of Object.entries(writes)) await db.table(name).bulkPut(rows);
    for (const r of await secrets.toArray()) {
      const n = rekey(r, localRemap);
      if (n === r) continue;
      if (n.id !== r.id) await secrets.delete(r.id);
      await secrets.put(n);
    }
  });
  remapStoredIds((v) => rekey(v, localRemap));
  markDataChanged();
  return pairs.length;
}

async function restoreFileMerge(obj, { keepNewer = false, answers = {}, clashChoices = {} } = {}) {
  inspectBackup(obj);
  const tables = dataTables();
  const local = await readLocal(tables);
  const incoming = incomingOf(obj);
  const { pairs } = planMatches({ local, incoming, answers }); // unanswered questions stay two records

  const keepLocal = keepsOwnIds();
  const fileRemap = new Map();
  const localRemap = new Map();
  for (const p of pairs) {
    if (keepLocal) fileRemap.set(p.fileId, p.localId);
    else localRemap.set(p.localId, p.fileId);
  }
  // A pair's id from here on → the backup id its clash choices are keyed by.
  const pairByNewId = new Map(pairs.map((p) => [keepLocal ? p.localId : p.fileId, p.fileId]));

  const writes = {};
  const deletes = {};
  const counts = [];
  const finalDogs = new Map();
  for (const { name } of tables) {
    const out = new Map();
    const now = new Map();
    for (const r of local[name] || []) {
      const n = rekey(r, localRemap);
      now.set(n.id, n);
      if (n !== r) {
        out.set(n.id, n);
        if (n.id !== r.id) (deletes[name] ||= []).push(r.id);
      }
    }
    let count = 0;
    for (const raw of incoming[name] || []) {
      const r = rekey(raw, fileRemap);
      const mine = now.get(r.id);
      let row = r;
      if (mine && pairByNewId.has(r.id)) {
        const fileId = pairByNewId.get(r.id);
        row = mergePair(mine, r, { table: name, choose: (field) => clashChoices[clashKey(fileId, field)] });
      } else if (mine && keepNewer && localIsNewer(mine, r)) {
        continue;
      }
      out.set(row.id, row);
      now.set(row.id, row);
      count++;
    }
    if (out.size) writes[name] = [...out.values()];
    if (name in incoming) counts.push({ name, count });
    if (name === 'dogs') for (const [id, d] of now) finalDogs.set(id, d);
  }

  // Edition bulk-import cap (cap spec §9), on the dogs as they'll be after the
  // whole merge. No-op in Pro/Demo; Lite refuses before anything is written.
  await enforceImportDogCap({ incomingDogs: [...finalDogs.values()], mode: 'replace' });

  const secrets = localRemap.size ? db.table('device_secrets') : null;
  await db.transaction('rw', secrets ? [...tables, secrets] : tables, async () => {
    for (const [name, ids] of Object.entries(deletes)) await db.table(name).bulkDelete(ids);
    for (const [name, rows] of Object.entries(writes)) await db.table(name).bulkPut(rows.map(decodeRowBlobs));
    if (secrets) {
      for (const r of await secrets.toArray()) {
        const n = rekey(r, localRemap);
        if (n === r) continue;
        if (n.id !== r.id) await secrets.delete(r.id);
        await secrets.put(n);
      }
    }
  });
  if (localRemap.size) remapStoredIds((v) => rekey(v, localRemap));
  markDataChanged();
  await pointMyKennelAtRestoredKennel();
  return counts;
}

// "My kennel" (the nav banner, Furever prefill) is a settings id, not part of the
// backup, so a file restored on a new browser leaves it unset — or pointing at a
// kennel the replace just wiped. Same repair restoreOnNewDevice does for a cloud
// restore: point it at the restored own kennel. A setting that still resolves to
// an own kennel is left alone.
async function pointMyKennelAtRestoredKennel() {
  const current = getMyKennelId();
  const kennel = current ? await db.kennels.get(current) : null;
  if (kennel && kennel.is_own_kennel && !kennel.is_archived) return;
  const own = (await db.kennels.toArray()).find((k) => k.is_own_kennel && !k.is_archived);
  if (own) setMyKennelId(own.id);
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
  const known = new Set(dataTables().map((t) => t.name));
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

// --- 'vault-merge' (Private Vault Plan §4.4) ---------------------------------
// The vault payload holds COMPLETE rows (the exportAll rows, sample data dropped,
// §4.1), so this is a row merge, newer wins, with one twist for the device that
// restored the kennel tier while locked and edited since:
//   - missing local row: insert the vault row.
//   - vault row as new as the local one or newer (the usual case: a restore
//     right after the 'cloud-merge' of the same snapshot, where updated_at
//     matches), or overwrite: true ("Restore as of…"): the vault row, whole.
//   - local row newer: keep it, but fill its BLANK private fields (and missing
//     keys of its object fields) from the vault row. Cloud fields stay exactly
//     local. So a record edited while locked keeps the edit and gets its
//     private details back, and a private field typed in while locked wins.
//   - local rows not in the vault: left alone. Restore never deletes.
//   - files: rows carry `vault_file` { sha256, plain_sha256, encrypted } in
//     place of the blob. A file the device doesn't have is fetched through
//     `opts.fetchFile(vaultFile, row) → Blob` (decryption lives in the cloud
//     modules); an existing local file is left alone; a failed fetch is listed
//     in `missingFiles`, as for 'cloud-merge'.
//   - Lite cap: enforceImportDogCap over the merged dogs.
// Reads and fetches happen before the write transaction.

export const VAULT_PAYLOAD_FORMAT = 1;

function assertVaultPayload(payload) {
  if (!payload || typeof payload !== 'object' || !payload.collections || typeof payload.collections !== 'object') {
    throw new Error('This does not look like a private-vault backup (missing "collections").');
  }
  if (payload.vault_format !== VAULT_PAYLOAD_FORMAT) {
    throw new Error(
      `This private backup uses format v${payload.vault_format}; this app understands ` +
      `v${VAULT_PAYLOAD_FORMAT}. Update the app, then restore.`
    );
  }
}

const isBlank = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const isPlainObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Blob);

function fillPrivateBlanks(table, local, vaultRow) {
  const out = { ...local };
  for (const [k, v] of Object.entries(vaultRow)) {
    if (isCloudField(table, k)) {
      // A cloud object field (events.details) may hold private keys: add the
      // ones the local object lacks, never touching a key it has.
      if (isPlainObj(out[k]) && isPlainObj(v)) {
        const missing = Object.keys(v).filter((key) => !(key in out[k]));
        if (missing.length) out[k] = { ...out[k], ...Object.fromEntries(missing.map((key) => [key, v[key]])) };
      }
      continue;
    }
    if (isBlank(out[k]) && !isBlank(v)) out[k] = v;
    else if (isPlainObj(out[k]) && isPlainObj(v)) {
      const missing = Object.keys(v).filter((key) => !(key in out[k]));
      if (missing.length) out[k] = { ...out[k], ...Object.fromEntries(missing.map((key) => [key, v[key]])) };
    }
  }
  return out;
}

function vaultRowToLocal(row) {
  const { vault_file, ...rest } = row;
  return rest;
}

export async function planVaultMerge(payload, { overwrite = false } = {}) {
  assertVaultPayload(payload);
  const known = new Set(dataTables().map((t) => t.name));
  const writes = {};
  const summary = {};
  for (const [name, rows] of Object.entries(payload.collections)) {
    if (!known.has(name) || !Array.isArray(rows)) continue;
    const s = { inserted: 0, updated: 0, keptLocal: 0, unchanged: 0 };
    const out = [];
    for (const vaultRow of rows) {
      if (!vaultRow || !vaultRow.id) continue;
      const local = await db.table(name).get(vaultRow.id);
      if (!local) {
        out.push({ row: vaultRowToLocal(vaultRow), insert: true, vaultRow });
        s.inserted++;
        continue;
      }
      if (name === 'files') { s.unchanged++; continue; }
      const row = vaultRowToLocal(vaultRow);
      const asNew = String(row.updated_at ?? '') >= String(local.updated_at ?? '');
      const merged = overwrite || asNew ? row : fillPrivateBlanks(name, local, row);
      if (JSON.stringify(merged) === JSON.stringify(local)) {
        if (overwrite || asNew) s.unchanged++; else s.keptLocal++;
        continue;
      }
      out.push({ row: merged, insert: false, vaultRow });
      s.updated++;
    }
    writes[name] = out;
    summary[name] = s;
  }
  return { writes, summary };
}

export async function restoreVaultMerge(payload, { overwrite = false, fetchFile = null } = {}) {
  assertWritable();
  const { writes, summary } = await planVaultMerge(payload, { overwrite });

  const missingFiles = [];
  if (writes.files) {
    const fetched = [];
    for (const w of writes.files) {
      let blob = null;
      if (fetchFile && w.vaultRow.vault_file) {
        try { blob = await fetchFile(w.vaultRow.vault_file, w.row); } catch { blob = null; }
      }
      if (blob) fetched.push({ ...w, row: { ...w.row, blob } });
      else missingFiles.push(w.row.id);
    }
    writes.files = fetched;
    if (summary.files) summary.files.inserted = fetched.length;
  }

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
