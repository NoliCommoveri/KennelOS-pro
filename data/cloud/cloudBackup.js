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
// Every entry point checks isCloudAvailable() first, so `cloudUrl: null` never
// makes a request.
//
// Data layer: reads through importExport.exportAll, never db directly. Network
// only through cloudApi.
import { exportAll, restoreBackup, planCloudMerge } from '../importExport.js';
import {
  getSampleDataManifest, getCloudDirtyAt, getCloudDirtySince, clearCloudDirty,
  getCloudBackupState, updateCloudBackupState, CLOUD_DATA_CHANGED_EVENT,
  getMyKennelId, setMyKennelId, markSampleDataCleared, setCloudRestoredAt
} from '../settings.js';
import { edition } from '../editionConfig.js';
import { isCloudAvailable } from './cloudConfig.js';
import * as api from './cloudApi.js';
import { currentAccount, sessionToken, markSessionExpired, signOut } from './cloudAuth.js';
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
export async function buildCloudSnapshot({ deviceId = null, manifest = getSampleDataManifest(), now = new Date() } = {}) {
  const backup = await exportAll({ encodeBlobs: false });
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
      const sha256 = await sha256Hex(blob);
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

const BLOCKING = new Set(['conflict', 'shrink', 'auth']);
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

async function contentHash(collections) {
  return sha256Hex(new Blob([JSON.stringify(collections)]));
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

async function pushNow({ force, allowShrink, onProgress }) {
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
    const { envelope, files } = await buildCloudSnapshot({ deviceId: account.deviceId });

    const shrink = checkShrink(state.lastCounts, envelope.counts);
    if (!shrink.ok && !allowShrink) return fail('shrink', null, { shrink });

    const hash = await contentHash(envelope.collections);
    if (!force && state.lastSnapshotId && hash === state.lastContentHash) {
      clearCloudDirty(dirtyAt);
      updateCloudBackupState({ lastError: null });
      return { status: 'unchanged' };
    }

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
      files: files.map((f) => f.sha256),
      edition // named in a 409 to other devices, so Lite can recognise an upgrade to Pro
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
    await api.uploadSnapshotBody(token, created.snapshotId, gz);

    const now = new Date().toISOString();
    updateCloudBackupState({
      lastPushedAt: now, lastSnapshotId: created.snapshotId, lastCounts: envelope.counts,
      lastContentHash: hash, lastError: null
    });
    if (dirtyAt) clearCloudDirty(dirtyAt);
    return { status: 'pushed', snapshotId: created.snapshotId, counts: envelope.counts };
  } catch (err) {
    return failFromError(err);
  }
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
export async function deleteCloudData() {
  if (!isCloudAvailable()) throw new api.CloudUnavailableError();
  const token = sessionToken();
  if (!token) throw new api.CloudAuthError({ status: 401, code: 'unauthorized' });
  await api.deleteAccount(token);
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

export async function downloadSnapshot(snapshotId) {
  if (!isCloudAvailable()) throw new api.CloudUnavailableError();
  return gunzipJson(await api.getSnapshot(requireToken(), snapshotId));
}

// The confirmation screen's numbers, without writing (plan §4.3).
export function previewRestore(envelope, { overwrite = false } = {}) {
  return planCloudMerge(envelope, { overwrite });
}

// overwrite: false — new device / takeover (newer wins).
// overwrite: true  — "Restore as of…" (a deliberate rollback).
// Missing files are fetched by sha256; `onProgress(done, total)` reports them.
export async function restoreSnapshot(envelope, { overwrite = false, onProgress } = {}) {
  const token = requireToken();
  const total = (envelope.collections?.files || []).length;
  let done = 0;
  return restoreBackup(envelope, 'cloud-merge', {
    overwrite,
    fetchFile: async (sha256) => {
      const blob = await api.getFile(token, sha256);
      done++;
      if (onProgress) onProgress(done, total);
      return blob;
    }
  });
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
    setCloudRestoredAt(new Date().toISOString());
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
// session can show it. Never throws: no notices is the safe answer.
const NOTICE_CACHE = 'kennelOS.cloudNotices';

export async function getServiceNotices() {
  if (!isCloudAvailable() || !currentAccount()) return [];
  try {
    const cached = globalThis.sessionStorage?.getItem(NOTICE_CACHE);
    if (cached) return JSON.parse(cached);
  } catch { /* fall through to a fetch */ }
  let notices = [];
  try { notices = await api.getNotices(); } catch { return []; }
  try { globalThis.sessionStorage?.setItem(NOTICE_CACHE, JSON.stringify(notices)); } catch { /* fine */ }
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
