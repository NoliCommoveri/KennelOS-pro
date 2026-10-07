// cloudBackup.js — automatic cloud backup of the kennel-records tier (Cloud
// Phase 1 plan §2.2–§4).
//   - Building: buildCloudSnapshot (§4.1), gzip, and the shrink guard (§3.5).
//   - Pushing: pushIfDirty uploads missing files, then describes and uploads the
//     snapshot (two steps, §6.1), only while something changed (§3.2).
//   - One backup device (§3.4): a 409 becomes status 'conflict'; the two ways
//     out are restoreLatestAndTakeOver() and replaceCloudWithThisDevice().
//   - Restoring: listSnapshots, downloadSnapshot, previewRestore and
//     restoreSnapshot, through importExport's 'cloud-merge' mode (§4.3).
//   - The scheduler (§2.2): startBackupScheduler().
//   - The private vault (Private Vault Plan §3.4, §4): with the vault on and
//     this device unlocked, every push also uploads the encrypted vault part
//     (buildVaultPayload, sealVaultPayload), and a restore merges it. On but
//     locked here, pushes pause ('vault_locked') until the device is unlocked
//     (cloudVault.js).
// Every entry point checks isCloudAvailable() first, so `cloudUrl: null` never
// makes a request.
//
// Data layer: reads through importExport.exportAll, never db directly. Network
// only through cloudApi.
import { exportAll, restoreBackup, planCloudMerge, VAULT_PAYLOAD_FORMAT } from '../importExport.js';
import {
  getSampleDataManifest, getCloudDirtyAt, getCloudDirtySince, clearCloudDirty,
  getCloudBackupState, updateCloudBackupState, CLOUD_DATA_CHANGED_EVENT,
  getMyKennelId, setMyKennelId, markSampleDataCleared, setCloudRestoredAt
} from '../settings.js';
import { edition } from '../editionConfig.js';
import { isCloudAvailable } from './cloudConfig.js';
import * as api from './cloudApi.js';
import { currentAccount, sessionToken, markSessionExpired, signOut } from './cloudAuth.js';
import { checkIn, cacheNotices, NOTICE_CACHE } from './cloudDevices.js';
import { getVaultKey, clearVaultKey } from './vaultKeyStore.js';
import { encryptPayload, decryptPayload, encryptFile, decryptFile, readVaultHeader } from './vaultCrypto.js';
import {
  filterCollectionsForCloud, assertCloudCollections, REGISTRY_TABLES
} from '../syncRegistry.js';

export const SNAPSHOT_FORMAT = 1;

// --- Building a snapshot (plan §4.1) ----------------------------------------
// 1. exportAll() with raw Blobs (the file backup's base64 markers would only be
//    thrown away here).
// 2. Drop every row listed in the sample-data manifest: sample data is never
//    backed up.
// 3. Row rules + by-name projection (syncRegistry.filterCollectionsForCloud).
// 4. Pull file blobs out: each kept `files` row gets its content's `sha256` in
//    the blob's place, and the bytes go in `files` of the result for a separate
//    content-addressed upload.
// 5. The positive key check over every row. An unexpected key throws
//    CloudKeyError, and the push must not happen.
//
// Returns { envelope, files: [{ sha256, size, mime, blob }] } (files deduped by
// sha256). Options are for tests and the step-4 caller:
//   deviceId — the server-issued device id from the cloud session;
//   manifest — the sample-data manifest (defaults to the stored one);
//   now      — the snapshot time.
//   backup   — an exportAll({ encodeBlobs: false }) result to reuse (a push
//              builds the vault payload from the same read);
//   shaCache — Map(file id → sha256), shared with buildVaultPayload.
export async function buildCloudSnapshot({ deviceId = null, manifest = getSampleDataManifest(), now = new Date(), backup = null, shaCache = new Map() } = {}) {
  backup = backup || await exportAll({ encodeBlobs: false });
  const real = dropSampleRows(backup.collections, manifest);
  const collections = filterCollectionsForCloud(real);

  // Step 4: hash each kept file's bytes from the SOURCE row (the projection
  // never carries the blob).
  const files = [];
  if (collections.files && collections.files.length) {
    const sourceById = new Map((real.files || []).map((f) => [f.id, f]));
    const bySha = new Map();
    const kept = [];
    for (const row of collections.files) {
      const blob = sourceById.get(row.id)?.blob;
      if (!(blob instanceof Blob)) continue; // no bytes on this device: nothing to back up
      const sha256 = await cachedSha(shaCache, row.id, blob);
      kept.push({ ...row, sha256 });
      if (!bySha.has(sha256)) {
        bySha.set(sha256, { sha256, size: blob.size, mime: blob.type || row.mime || 'application/octet-stream', blob });
      }
    }
    collections.files = kept;
    files.push(...bySha.values());
  }

  assertCloudCollections(collections);

  const envelope = {
    snapshot_format: SNAPSHOT_FORMAT,
    schema_version: backup.schema_version,
    created_at: now.toISOString(),
    device_id: deviceId,
    edition,
    counts: countRows(collections),
    collections
  };
  return { envelope, files };
}

async function cachedSha(cache, id, blob) {
  if (!cache.has(id)) cache.set(id, await sha256Hex(blob));
  return cache.get(id);
}

// --- The vault payload (Private Vault Plan §4.1, §4.2) ----------------------
// The COMPLETE rows (exportAll, sample rows dropped), not the private
// complement: nothing to keep in step with syncRegistry, and restore is a row
// merge. Built in two halves so the "unchanged" check never encrypts anything:
//   buildVaultPayload — the plaintext envelope. Each `files` row has its blob
//     replaced by `vault_file: { plain_sha256 }`; the blobs come back beside it.
//   sealVaultPayload — fills in each file's upload id and encrypts: a file the
//     cloud tier already uploads (a pedigree, a health test) is referenced by
//     its plain sha256 and not stored twice; every other file (contracts,
//     "other" documents, receipts) is encrypted deterministically (vaultCrypto
//     encryptFile), so an unchanged one has the same /files id every push.
//     Then the envelope is gzipped and encrypted.
// Returns { envelope, blobs: Map(file id → Blob) }.
export async function buildVaultPayload({ keyId, manifest = getSampleDataManifest(), now = new Date(), backup = null, shaCache = new Map() } = {}) {
  backup = backup || await exportAll({ encodeBlobs: false });
  const collections = dropSampleRows(backup.collections, manifest);
  const blobs = new Map();
  if (collections.files) {
    const rows = [];
    for (const row of collections.files) {
      const { blob, ...rest } = row;
      if (!(blob instanceof Blob)) { rows.push(rest); continue; } // no bytes here: the row alone
      blobs.set(row.id, blob);
      rows.push({ ...rest, vault_file: { plain_sha256: await cachedSha(shaCache, row.id, blob) } });
    }
    collections.files = rows;
  }
  const envelope = {
    vault_format: VAULT_PAYLOAD_FORMAT,
    key_id: keyId,
    schema_version: backup.schema_version,
    created_at: now.toISOString(),
    collections
  };
  return { envelope, blobs };
}

// → { bytes (the encrypted vault part), files: [{ sha256, size, mime, blob }] to
// upload (encrypted, deduped), fileIds: every /files id the vault references }.
// `cloudShas` is the set of sha256s the cloud tier already uploads.
export async function sealVaultPayload({ envelope, blobs }, vault, cloudShas = new Set()) {
  const files = new Map();
  const fileIds = new Set();
  const collections = { ...envelope.collections };
  if (collections.files) {
    const rows = [];
    for (const row of collections.files) {
      const plain = row.vault_file?.plain_sha256;
      if (!plain) { rows.push(row); continue; }
      if (cloudShas.has(plain)) {
        rows.push({ ...row, vault_file: { sha256: plain, plain_sha256: plain, encrypted: false } });
        fileIds.add(plain);
        continue;
      }
      const blob = blobs.get(row.id);
      const sealed = await encryptFile(vault.key, vault.keyId, new Uint8Array(await blob.arrayBuffer()));
      rows.push({ ...row, vault_file: { sha256: sealed.sha256, plain_sha256: plain, encrypted: true } });
      fileIds.add(sealed.sha256);
      if (!files.has(sealed.sha256)) {
        files.set(sealed.sha256, { sha256: sealed.sha256, size: sealed.bytes.length, mime: 'application/octet-stream', blob: new Blob([sealed.bytes], { type: 'application/octet-stream' }) });
      }
    }
    collections.files = rows;
  }
  const gz = await gzipJson({ ...envelope, collections });
  const bytes = await encryptPayload(vault.key, vault.keyId, new Uint8Array(await gz.arrayBuffer()));
  return { bytes, files: [...files.values()], fileIds };
}

// The vault part back to its plaintext envelope. Throws VaultLockedError when
// `vault` (this device's key) doesn't open it.
export async function openVaultPayload(bytes, vault) {
  const plain = await decryptPayload(vault.key, vault.keyId, bytes);
  return gunzipJson(new Blob([plain]));
}

// Rows whose id is in the manifest's list for their table are sample data.
export function dropSampleRows(collections, manifest) {
  if (!manifest) return collections;
  const out = {};
  for (const [table, rows] of Object.entries(collections)) {
    const ids = Array.isArray(manifest[table]) ? new Set(manifest[table]) : null;
    out[table] = ids && ids.size ? rows.filter((r) => !ids.has(r.id)) : rows;
  }
  return out;
}

export function countRows(collections) {
  const counts = {};
  for (const table of REGISTRY_TABLES) {
    if (Array.isArray(collections[table])) counts[table] = collections[table].length;
  }
  return counts;
}

export async function sha256Hex(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// --- gzip (plan §4.1 step 6) ------------------------------------------------
export async function gzipJson(obj) {
  const stream = new Blob([JSON.stringify(obj)], { type: 'application/json' })
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  const bytes = await new Response(stream).arrayBuffer();
  return new Blob([bytes], { type: 'application/gzip' });
}

export async function gunzipJson(blob) {
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

// --- Shrink guard (plan §3.5) ------------------------------------------------
// Before a push, compare the new snapshot's counts with the last pushed ones.
// Blocked when the new one has FEWER THAN HALF the dogs, or fewer than half the
// total records, of the last one. Each measure applies only when its previous
// count was at least SHRINK_MIN_PREVIOUS, so a small program can't trip it by
// removing a couple of records. Catches a half-cleared browser, a wrong
// "replace" import, and Reset App on a forgotten second device. The UI then
// offers "Upload anyway" or "Restore from backup instead".
export const SHRINK_MIN_PREVIOUS = 10;

const totalOf = (counts) => Object.values(counts || {}).reduce((sum, n) => sum + (Number(n) || 0), 0);

// Returns { ok, dogs: { previous, next }, total: { previous, next } }. With no
// previous counts (first push) it is always ok.
export function checkShrink(previousCounts, nextCounts) {
  const dogs = { previous: Number(previousCounts?.dogs) || 0, next: Number(nextCounts?.dogs) || 0 };
  const total = { previous: totalOf(previousCounts), next: totalOf(nextCounts) };
  const shrank = (m) => m.previous >= SHRINK_MIN_PREVIOUS && m.next < m.previous / 2;
  return { ok: !previousCounts || !(shrank(dogs) || shrank(total)), dogs, total };
}

// --- Pushing (plan §2.2, §3.4, §6.1) -------------------------------------------
// The result of every push attempt is one of these statuses; the UI reads them
// (step 5), and the scheduler only cares whether to try again later.
//   'pushed'      a new snapshot is committed
//   'unchanged'   the cloud tier is identical to the last push; nothing sent
//   'skipped'     nothing to do (no server, not signed in, off, not dirty, or
//                 paused by an earlier conflict/shrink/auth until the user acts)
//   'offline'     no network or maintenance; retried later, never shown as a failure
//   'conflict'    409: another device backs up this program (or this device's
//                 base is stale, e.g. after Reset App). Carries `backingDevice`.
//   'shrink'      the shrink guard stopped it. Carries the counts.
//   'auth'        the session expired; the UI asks for a new code
//   'error'       anything else (lastError has the code)
// conflict / shrink / auth PAUSE automatic pushes (lastError.blocking) so the
// scheduler doesn't retry them every five minutes; a push the user starts
// (force) goes ahead.

//   'vault_locked' the program has a private vault and this device can't open
//                 it (restored with "Not now", or the vault was re-keyed on
//                 another device). Pushing without the vault part would let
//                 retention forget the last good one, so pushes pause until
//                 the device is unlocked (Private Vault Plan §3.4).
const BLOCKING = new Set(['conflict', 'shrink', 'auth', 'vault_locked']);
const LOCK_NAME = 'kennelos-cloud-push';

export function isBackupBlocked(state = getCloudBackupState()) {
  return !!(state.lastError && BLOCKING.has(state.lastError.code));
}

// Serialize pushes across tabs where the browser can (navigator.locks); the
// state is in localStorage, so the second tab re-reads it inside the lock and
// sees the first tab's push. Within one tab a module-level chain does the same.
let chain = Promise.resolve();
function exclusive(fn) {
  const locks = globalThis.navigator?.locks;
  const run = () => (locks ? locks.request(LOCK_NAME, fn) : fn());
  const next = chain.then(run, run);
  chain = next.catch(() => {});
  return next;
}

// With the vault unlocked the hash covers the vault's plaintext rows too (with
// each file's plain sha256), so a private-only edit pushes (§4.3). Without it,
// the cloud tier alone, exactly as before the vault existed.
async function contentHash(collections, vaultEnvelope = null) {
  const subject = vaultEnvelope
    ? { cloud: collections, vault: vaultEnvelope.collections, keyId: vaultEnvelope.key_id }
    : collections;
  return sha256Hex(new Blob([JSON.stringify(subject)]));
}

function fail(status, error, extra = {}) {
  updateCloudBackupState({ lastError: { code: status, at: new Date().toISOString(), detail: error?.code || null, ...extra } });
  return { status, ...extra };
}

// Push if something changed since the last push.
//   force       — push even when not dirty, and even when paused (a push the
//                 user started: "Turn on", "Back up now", after a takeover)
//   allowShrink — the user chose "Upload anyway" in the shrink dialog
//   onProgress  — ({ phase: 'files'|'snapshot', done, total }) for the UI's
//                 progress bar (the first backup with documents can take a minute)
// Every attempt that gets past the quick skips dispatches CLOUD_BACKUP_EVENT on
// the window with the result, so an open status line can refresh itself.
export const CLOUD_BACKUP_EVENT = 'kennelos:cloudbackup';

export function pushIfDirty({ force = false, allowShrink = false, onProgress = null } = {}) {
  return exclusive(async () => {
    const result = await pushNow({ force, allowShrink, onProgress });
    if (result.status !== 'skipped') {
      try { globalThis.dispatchEvent?.(new CustomEvent(CLOUD_BACKUP_EVENT, { detail: result })); } catch { /* no window */ }
    }
    return result;
  });
}

async function pushNow({ force, allowShrink, onProgress, retried = false }) {
  const progress = (phase, done, total) => { try { onProgress?.({ phase, done, total }); } catch { /* UI only */ } };
  if (!isCloudAvailable()) return { status: 'skipped', reason: 'unavailable' };
  const state = getCloudBackupState();
  const token = sessionToken();
  if (!state.enabled) return { status: 'skipped', reason: 'off' };
  if (!token) return { status: 'skipped', reason: 'signed-out' };
  const dirtyAt = getCloudDirtyAt();
  if (!dirtyAt && !force) return { status: 'skipped', reason: 'clean' };
  if (!force && isBackupBlocked(state)) return { status: 'skipped', reason: 'paused' };

  const account = currentAccount();
  updateCloudBackupState({ lastAttemptAt: new Date().toISOString() });
  try {
    const backup = await exportAll({ encodeBlobs: false });
    const shaCache = new Map();
    const { envelope, files: cloudFiles } = await buildCloudSnapshot({ deviceId: account.deviceId, backup, shaCache });

    const shrink = checkShrink(state.lastCounts, envelope.counts);
    if (!shrink.ok && !allowShrink) return fail('shrink', null, { shrink });

    const vault = await getVaultKey(account.programId);
    const vaultPlain = vault ? await buildVaultPayload({ keyId: vault.keyId, backup, shaCache }) : null;

    const hash = await contentHash(envelope.collections, vaultPlain?.envelope);
    if (!force && state.lastSnapshotId && hash === state.lastContentHash) {
      clearCloudDirty(dirtyAt);
      updateCloudBackupState({ lastError: null });
      return { status: 'unchanged' };
    }

    const sealed = vault ? await sealVaultPayload(vaultPlain, vault, new Set(cloudFiles.map((f) => f.sha256))) : null;
    const files = [...cloudFiles, ...(sealed?.files || [])];
    const fileIds = [...new Set([...cloudFiles.map((f) => f.sha256), ...(sealed?.fileIds || [])])];

    // Files first: the server refuses a snapshot that references a file it
    // doesn't have, and retention only spares files for a day (cloud/README).
    for (const [i, f] of files.entries()) {
      progress('files', i, files.length);
      if (!(await api.hasFile(token, f.sha256))) await api.putFile(token, f.sha256, f.blob, f.mime);
    }
    progress('snapshot', files.length, files.length);
    const gz = await gzipJson(envelope);
    const description = {
      base_snapshot_id: state.lastSnapshotId || null,
      size: gz.size,
      counts: envelope.counts,
      files: fileIds,
      edition, // named in a 409 to other devices, so Lite can recognise an upgrade to Pro
      ...(sealed ? { vault: { size: sealed.bytes.length, keyId: vault.keyId } } : {})
    };
    let created;
    try {
      created = await api.createSnapshot(token, description);
    } catch (err) {
      // A file the server collected between our HEAD and this call (retention
      // spares unreferenced files only a day): upload the named ones, once.
      if (!(err instanceof api.CloudRequestError && err.code === 'missing_files')) throw err;
      const missing = new Set(err.missing || []);
      for (const f of files) if (missing.has(f.sha256)) await api.putFile(token, f.sha256, f.blob, f.mime);
      created = await api.createSnapshot(token, description);
    }
    // The vault part lands before the body, whose PUT commits (§6.1).
    if (sealed) await api.uploadSnapshotVault(token, created.snapshotId, sealed.bytes);
    await api.uploadSnapshotBody(token, created.snapshotId, gz);

    const now = new Date().toISOString();
    updateCloudBackupState({
      lastPushedAt: now, lastSnapshotId: created.snapshotId, lastCounts: envelope.counts,
      lastContentHash: hash, lastError: null,
      vault: sealed ? 'on' : 'off', // the server took it, so it agrees
      ...(sealed ? { vaultPushedAt: now } : {})
    });
    if (dirtyAt) clearCloudDirty(dirtyAt);
    return { status: 'pushed', snapshotId: created.snapshotId, counts: envelope.counts, vault: !!sealed };
  } catch (err) {
    const vaultOutcome = await vaultRefusal(err);
    if (vaultOutcome === 'retry' && !retried) return pushNow({ force: true, allowShrink, onProgress, retried: true });
    if (vaultOutcome === 'locked') return fail('vault_locked', err, { stale: err.code === 'vault_key_stale' });
    return failFromError(err);
  }
}

// The server's vault refusals (Private Vault Plan §6.4), at the POST or at the
// body PUT that commits:
//   vault_required  — the program has a vault and this device sent no part:
//                     it's locked here → 'locked'.
//   vault_key_stale — the vault was turned off and on again elsewhere, so the
//                     key here no longer opens it: forget it → 'locked'.
//   no_vault        — the vault was turned off elsewhere: forget the key and
//                     push again without it → 'retry'.
async function vaultRefusal(err) {
  if (!(err instanceof api.CloudError)) return null;
  if (err.code === 'vault_required') {
    updateCloudBackupState({ vault: 'locked' });
    return 'locked';
  }
  if (err.code === 'vault_key_stale') {
    await clearVaultKey();
    updateCloudBackupState({ vault: 'locked' });
    return 'locked';
  }
  if (err.code === 'no_vault') {
    await clearVaultKey();
    updateCloudBackupState({ vault: 'off' });
    return 'retry';
  }
  return null;
}

// A Lite device whose program is now backed up from Pro: the owner upgraded
// (Editions Plan, "Converting Lite → Pro"), so the UI says "your records moved
// to KennelOS Pro" instead of treating it as a second device. 'pro' or null.
export function movedToEdition(backingDevice, ownDevice = false, thisEdition = edition) {
  return !ownDevice && thisEdition === 'lite' && backingDevice?.edition === 'pro' ? 'pro' : null;
}

function failFromError(err) {
  if (err instanceof api.CloudOfflineError || err instanceof api.CloudUnavailableError) {
    updateCloudBackupState({ lastError: { code: 'offline', at: new Date().toISOString() } });
    return { status: 'offline' };
  }
  if (err instanceof api.CloudAuthError) {
    markSessionExpired();
    return fail('auth', err);
  }
  if (err instanceof api.CloudConflictError) {
    const own = err.backingDevice && err.backingDevice.id === currentAccount()?.deviceId;
    return fail('conflict', err, {
      backingDevice: err.backingDevice || null,
      latestSnapshotId: err.latestSnapshotId || null,
      ownDevice: !!own,
      movedToEdition: movedToEdition(err.backingDevice, own)
    });
  }
  if (err && err.name === 'CloudKeyError') return fail('error', { code: 'unexpected_key' }, { message: err.message });
  return fail('error', err, { message: String(err?.message || err) });
}

// --- Turning it on / off (plan §2.1, §2.4) ------------------------------------
// "Turn on": the first backup runs immediately. A program that already has a
// backup from another device (or from before a reset) comes back 'conflict'.
export async function enableBackup({ onProgress } = {}) {
  if (!isCloudAvailable()) return { status: 'skipped', reason: 'unavailable' };
  updateCloudBackupState({ enabled: true, lastError: null, movedToEdition: null });
  return pushIfDirty({ force: true, onProgress });
}

// "Turn off backup on this device": stops pushing; the cloud copy stays.
// `movedToEdition` ('pro') records that this Lite device stopped because the
// program moved to Pro, so it isn't nudged to turn backup back on.
export function disableBackup({ movedToEdition = null } = {}) {
  updateCloudBackupState({ enabled: false, lastError: null, movedToEdition });
}

// "Delete my cloud data": snapshots, files and the account, server-side. Local
// data is untouched; this device is signed out.
// Throws CloudRequestError 'reauth_required' when this sign-in is more than 15
// minutes old: send a code (cloudAuth.startSignIn) and pass { email, code }.
export async function deleteCloudData(reauth = {}) {
  if (!isCloudAvailable()) throw new api.CloudUnavailableError();
  const token = sessionToken();
  if (!token) throw new api.CloudAuthError({ status: 401, code: 'unauthorized' });
  await api.deleteAccount(token, reauth);
  await signOut();
}

// What the Import/Export card shows (step 5): "Backed up 4 minutes ago", or why not.
export function getBackupStatus() {
  const state = getCloudBackupState();
  const account = currentAccount();
  return {
    available: isCloudAvailable(),
    account,
    enabled: state.enabled,
    lastPushedAt: state.lastPushedAt,
    lastAttemptAt: state.lastAttemptAt,
    lastError: state.lastError,
    movedToEdition: state.movedToEdition || null,
    // The private vault as this device last saw it: 'on' (unlocked here, part
    // of every push), 'locked' (on, but this device can't open it), 'off', or
    // null (not known yet; cloudVault.vaultStatus() asks the server).
    vault: state.vault || null,
    vaultPushedAt: state.vaultPushedAt || null,
    paused: isBackupBlocked(state),
    dirty: !!getCloudDirtyAt()
  };
}

// The server's view: who backs up, and the latest snapshot.
export async function getProgramStatus() {
  if (!isCloudAvailable()) throw new api.CloudUnavailableError();
  return api.getProgram(requireToken());
}

function requireToken() {
  const token = sessionToken();
  if (!token) throw new api.CloudAuthError({ status: 401, code: 'unauthorized' });
  return token;
}

// --- One backup device (plan §3.4) -----------------------------------------------
// Choice 1: "Restore that backup here", then this device takes over. Field-merge,
// newer wins, so nothing private on this device is lost. Returns the restore
// summary and the push that follows.
export async function restoreLatestAndTakeOver({ onProgress } = {}) {
  if (!isCloudAvailable()) throw new api.CloudUnavailableError();
  const token = requireToken();
  const program = await api.getProgram(token);
  let restored = null;
  if (program.latestSnapshotId) {
    const envelope = await downloadSnapshot(program.latestSnapshotId);
    restored = await restoreSnapshot(envelope, { overwrite: false, onProgress });
  }
  const after = await api.takeOverBacking(token);
  updateCloudBackupState({
    enabled: true,
    lastSnapshotId: after.latestSnapshotId || null,
    lastCounts: after.latestSnapshot?.counts || null,
    lastContentHash: null,
    lastError: null
  });
  return { restored, push: await pushIfDirty({ force: true }) };
}

// Choice 2: "Replace it with this device's records" (typed confirm in the UI).
// The old backup stays in the 30-day history.
export async function replaceCloudWithThisDevice({ onProgress } = {}) {
  if (!isCloudAvailable()) throw new api.CloudUnavailableError();
  const after = await api.takeOverBacking(requireToken());
  updateCloudBackupState({
    enabled: true,
    lastSnapshotId: after.latestSnapshotId || null,
    lastCounts: null, // the user chose to replace: no shrink comparison
    lastContentHash: null,
    lastError: null
  });
  return pushIfDirty({ force: true, allowShrink: true, onProgress });
}

// --- Restoring (plan §2.3, §4.3) -------------------------------------------------
// → [{ id, createdAt, size, counts, deviceId, deviceLabel }], newest first
export async function listSnapshots() {
  if (!isCloudAvailable()) throw new api.CloudUnavailableError();
  return (await api.listSnapshots(requireToken())).snapshots || [];
}

// Remembers which snapshot each downloaded envelope came from, so
// restoreSnapshot can fetch the same snapshot's vault part.
const envelopeIds = new WeakMap();

export async function downloadSnapshot(snapshotId) {
  if (!isCloudAvailable()) throw new api.CloudUnavailableError();
  const envelope = await gunzipJson(await api.getSnapshot(requireToken(), snapshotId));
  if (envelope && typeof envelope === 'object') envelopeIds.set(envelope, snapshotId);
  return envelope;
}

// The confirmation screen's numbers, without writing (plan §4.3).
export function previewRestore(envelope, { overwrite = false } = {}) {
  return planCloudMerge(envelope, { overwrite });
}

// overwrite: false — new device / takeover (newer wins).
// overwrite: true  — "Restore as of…" (a deliberate rollback).
// Missing files are fetched by sha256; `onProgress(done, total)` reports them.
// For an envelope from downloadSnapshot, the same snapshot's vault part is
// merged too when this device is unlocked (Private Vault Plan §4.4): the
// result's `vault` is { status: 'restored', summary, missingFiles }, or
// { status } 'none' (no vault part), 'locked' (one this device can't open yet),
// or 'stale' (made under a key that has since been replaced).
export async function restoreSnapshot(envelope, { overwrite = false, onProgress } = {}) {
  const token = requireToken();
  const total = (envelope.collections?.files || []).length;
  let done = 0;
  const result = await restoreBackup(envelope, 'cloud-merge', {
    overwrite,
    fetchFile: async (sha256) => {
      const blob = await api.getFile(token, sha256);
      done++;
      if (onProgress) onProgress(done, total);
      return blob;
    }
  });
  const snapshotId = envelopeIds.get(envelope);
  return { ...result, vault: snapshotId ? await restoreSnapshotVault(snapshotId, { overwrite, onProgress }) : { status: 'none' } };
}

// The 'vault-merge' of one snapshot's vault part. Also how an unlock merges the
// private tier in after a "Not now" restore (cloudVault.js).
export async function restoreSnapshotVault(snapshotId, { overwrite = false, onProgress } = {}) {
  const token = requireToken();
  const vault = await getVaultKey(currentAccount()?.programId);
  // Locked here: say so without downloading what can't be opened.
  if (!vault) return { status: (await api.getVault(token)).enabled ? 'locked' : 'none' };
  let bytes;
  try {
    bytes = new Uint8Array(await (await api.getSnapshotVault(token, snapshotId)).arrayBuffer());
  } catch (err) {
    if (err instanceof api.CloudRequestError && err.status === 404) return { status: 'none' };
    throw err;
  }
  if (readVaultHeader(bytes)?.keyId !== vault.keyId) return { status: 'stale' };
  const payload = await openVaultPayload(bytes, vault);
  const total = (payload.collections?.files || []).length;
  let done = 0;
  const r = await restoreBackup(payload, 'vault-merge', {
    overwrite,
    fetchFile: async (vf, row) => {
      const blob = await api.getFile(token, vf.sha256);
      let out = blob;
      if (vf.encrypted) {
        const plain = await decryptFile(vault.key, vault.keyId, new Uint8Array(await blob.arrayBuffer()), { plainSha256: vf.plain_sha256 });
        out = new Blob([plain], { type: row.mime || 'application/octet-stream' });
      }
      done++;
      if (onProgress) onProgress(done, total);
      return out;
    }
  });
  return { status: 'restored', ...r };
}

// New phone (first-run "I already use KennelOS → sign in and restore", plan
// §2.3): restore the latest snapshot, then this device backs up from here on.
// Also records the first-run choice (so the sample-data prompt never comes back)
// and points the kennel-setup identity at the restored own kennel, which lives in
// settings, not in the snapshot.
export async function restoreOnNewDevice(opts = {}) {
  const result = await restoreLatestAndTakeOver(opts);
  markSampleDataCleared();
  if (result.restored) {
    // "Private details are blank here" (the card and record-page hint), unless
    // the private vault came back too. An unlock later clears it (cloudVault).
    setCloudRestoredAt(result.restored.vault?.status === 'restored' ? null : new Date().toISOString());
    if (!getMyKennelId()) {
      const own = (await exportAll({ encodeBlobs: false })).collections.kennels
        ?.find((k) => k.is_own_kennel && !k.is_archived);
      if (own) setMyKennelId(own.id);
    }
  }
  return result;
}

// --- Service notices (plan §2.1, §6.1; Proposal §2a) ----------------------------
// The in-app shutdown channel. Fetched only for a device signed in to cloud
// backup (someone who never opted in makes no request to the server at all),
// once per browsing session, and cached in sessionStorage so every page of the
// session can show it. A signed-in device gets them from its check-in
// (cloudDevices.js, plan §2.5), so that's still one request; one whose sign-in
// expired asks the public route. Never throws: no notices is the safe answer.
export async function getServiceNotices() {
  if (!isCloudAvailable() || !currentAccount()) return [];
  try {
    const cached = globalThis.sessionStorage?.getItem(NOTICE_CACHE);
    if (cached) return JSON.parse(cached);
  } catch { /* fall through to a fetch */ }
  let notices = null;
  if (sessionToken()) notices = (await checkIn({ force: true }))?.notices ?? null;
  if (!notices) {
    try { notices = await api.getNotices(); } catch { return []; }
    cacheNotices(notices);
  }
  return notices;
}

// --- The scheduler (plan §2.2) ---------------------------------------------------
// Pushes only when something changed:
//   - after a change, five minutes after the FIRST unpushed change (later
//     changes ride the same push), and never sooner than five minutes after the
//     last attempt;
//   - when the app goes to the background, at most once a minute;
//   - at app start: the first page of a browsing session pushes straight away
//     if dirty; later page loads in the same session (this is a multi-page app,
//     so every navigation is a "start") just resume the five-minute timer.
//   - when the browser comes back online.
// Nothing ever blocks a page: every push runs in the background and swallows its
// own errors into cloudBackupState.lastError.
export const PUSH_DELAY_MS = 5 * 60 * 1000;
export const HIDDEN_MIN_GAP_MS = 60 * 1000;
const SESSION_MARK = 'kennelOS.cloudBackupStarted';

export function nextPushDelay({ now = Date.now(), dirtySince, lastAttemptAt } = {}) {
  if (!dirtySince) return null;
  const since = Date.parse(dirtySince) || now;
  const last = Date.parse(lastAttemptAt || '') || 0;
  return Math.max(0, Math.max(since, last) + PUSH_DELAY_MS - now);
}

export function startBackupScheduler({ win = globalThis } = {}) {
  if (!isCloudAvailable()) return () => {};
  let timer = null;
  let stopped = false;

  const active = () => {
    const s = getCloudBackupState();
    return !stopped && s.enabled && !!sessionToken() && !isBackupBlocked(s);
  };
  const run = async () => {
    timer = null;
    if (!active()) return;
    await pushIfDirty();
    schedule();
  };
  const schedule = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!active()) return;
    const delay = nextPushDelay({ dirtySince: getCloudDirtySince(), lastAttemptAt: getCloudBackupState().lastAttemptAt });
    if (delay !== null) timer = setTimeout(run, delay);
  };
  const sinceLastAttempt = () => Date.now() - (Date.parse(getCloudBackupState().lastAttemptAt || '') || 0);
  const onHidden = () => {
    if (win.document?.visibilityState === 'hidden' && getCloudDirtyAt() && sinceLastAttempt() >= HIDDEN_MIN_GAP_MS) run();
  };

  win.addEventListener?.(CLOUD_DATA_CHANGED_EVENT, schedule);
  win.addEventListener?.('online', schedule);
  win.document?.addEventListener?.('visibilitychange', onHidden);

  let coldStart = false;
  try {
    coldStart = !win.sessionStorage?.getItem(SESSION_MARK);
    win.sessionStorage?.setItem(SESSION_MARK, '1');
  } catch { /* no sessionStorage: treat as a later page */ }
  if (coldStart && getCloudDirtyAt() && sinceLastAttempt() >= HIDDEN_MIN_GAP_MS) run();
  else schedule();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    win.removeEventListener?.(CLOUD_DATA_CHANGED_EVENT, schedule);
    win.removeEventListener?.('online', schedule);
    win.document?.removeEventListener?.('visibilitychange', onHidden);
  };
}
