// cloudSync.js — live sync's loop (Cloud Phase 2 plan §5): push this device's
// changes, pull everyone else's, and the scheduler that runs both.
//
//   pushChanges()  the scan (syncState) → records (syncRecords) → POST /sync/push
//                  in pages; files' bytes go up first through /files
//   pullChanges()  GET /sync/pull from this device's cursor → syncApply
//   syncNow()      push, then pull, one at a time across tabs
//   startSyncScheduler()  10 s after a local change, at once when the page
//                  hides, on start-up, when it comes back, and every 60 s while
//                  visible (a cheap /sync/head first)
//
//   enableSync()   turn it on for the program, then join (plan §2.1)
//   joinSync()     this device joins a syncing program: a full pull where the
//                  newer `updated_at` wins, then push what the server lacks;
//                  nothing is deleted on either side (§5.5). Until it finishes,
//                  `joining` stays set and any sync run resumes the join.
//   disableSyncHere() / disableSyncEverywhere(reauth)   (§2.4)
//   syncReadiness()  what's missing before this device can sync (§2.1)
//
// The loop only runs while this device's sync state says `enabled`. Every entry point checks
// isCloudAvailable() and editionFlags.liveSync first, so Lite, Demo and
// `cloudUrl: null` never make a request. Network only through cloudApi.
//
// What stops it (getCloudSyncState().lastError.code): vault_locked (unlock
// Sensitive records here), vault_key_stale (unlock with the new key),
// pro_required (a lapsed license: plan §12 decision 6; backups carry on the
// Phase 1 way meanwhile, cloudBackup.js), sync_off (turned off for every device,
// or the vault was: this device stops syncing and says so), resync_required
// (offline past the tombstone horizon: re-join),
// shrink (a push would delete most records: the user decides, as backup does),
// signed_out. `offline` is not a stop: the next run retries.
import * as api from './cloudApi.js';
import { isCloudAvailable } from './cloudConfig.js';
import { editionFlags } from '../editionConfig.js';
import { currentAccount, sessionToken, markSessionExpired } from './cloudAuth.js';
import { getVaultKey } from './vaultKeyStore.js';
import { VaultLockedError } from './vaultCrypto.js';
import { buildPutRecord, buildDeleteRecord, sealFileRow } from './syncRecords.js';
import { scanLocalChanges, writeSyncMeta, removeSyncMeta, clearSyncMeta, metaId } from './syncState.js';
import { isBackupBlocked } from './cloudBackup.js';
import { applyPulledRecords } from '../syncApply.js';
import { CloudKeyError } from '../syncRegistry.js';
import { getCloudSyncState, updateCloudSyncState, getCloudBackupState, CLOUD_DATA_CHANGED_EVENT } from '../settings.js';

export const PUSH_DEBOUNCE_MS = 10 * 1000;
export const POLL_MS = 60 * 1000;
export const CURSOR_EVERY_MS = 60 * 1000;
export const PAGE_RECORDS = 200;
export const PAGE_BYTES = 2 * 1024 * 1024;
export const SHRINK_MIN = 10;
const ACTIVITY_DAYS = 30;
const ACTIVITY_MAX = 100;
const LOCK_NAME = 'kennelos-cloud-sync';

export class SyncPausedError extends Error {
  constructor(code) {
    super(`Live sync paused: ${code}.`);
    this.name = 'SyncPausedError';
    this.code = code;
  }
}

export function isSyncAvailable() {
  return isCloudAvailable() && editionFlags.liveSync === true;
}

// The session, the program and the unlocked vault key, or a SyncPausedError.
async function requireSync() {
  if (!isSyncAvailable()) throw new api.CloudUnavailableError();
  const token = sessionToken();
  const programId = currentAccount()?.programId;
  if (!token || !programId) throw new SyncPausedError('signed_out');
  const vault = await getVaultKey(programId);
  if (!vault) throw new SyncPausedError('vault_locked');
  return { token, programId, vault };
}

// --- State helpers -------------------------------------------------------------
function pause(code, detail = null) {
  updateCloudSyncState({ lastError: { code, at: new Date().toISOString(), detail } });
  return { status: 'paused', code };
}

// The activity list (§2.3): newest first, the last 30 days, at most 100.
function noteActivity(items, now = new Date()) {
  if (!items.length) return;
  const cutoff = now.getTime() - ACTIVITY_DAYS * 24 * 60 * 60 * 1000;
  const at = now.toISOString();
  const kept = (getCloudSyncState().activity || []).filter((a) => Date.parse(a.at) >= cutoff);
  updateCloudSyncState({ activity: [...items.map((i) => ({ at, ...i })), ...kept].slice(0, ACTIVITY_MAX) });
}

// Sync was turned off for every device (or the vault was) from somewhere else:
// this device stops too, keeping its records, and says why (lastError sync_off).
function stoppedElsewhere() {
  updateCloudSyncState({ enabled: false, joining: false, lastError: { code: 'sync_off', at: new Date().toISOString(), detail: null } });
  return { status: 'paused', code: 'sync_off' };
}

// An error from either half → a result, recording what stopped it.
function fromError(err) {
  if (err instanceof SyncPausedError) return pause(err.code);
  if (err instanceof VaultLockedError) return pause('vault_key_stale');
  if (err instanceof api.CloudOfflineError) {
    updateCloudSyncState({ lastError: { code: 'offline', at: new Date().toISOString(), detail: null } });
    return { status: 'offline' };
  }
  if (err instanceof api.CloudAuthError) {
    markSessionExpired();
    return pause('signed_out');
  }
  if (err instanceof api.CloudConflictError && err.code === 'sync_off') return stoppedElsewhere();
  if (err instanceof api.CloudConflictError && ['vault_key_stale', 'vault_required'].includes(err.code)) return pause(err.code);
  if (err instanceof api.CloudRequestError) {
    if (err.code === 'pro_required') return pause('pro_required');
    if (err.status === 410 || err.code === 'resync_required') return pause('resync_required');
  }
  throw err;
}

// --- Push (§5.1) ---------------------------------------------------------------------
// → { status: 'pushed' | 'nothing', pushed, deleted } | { status: 'shrink', deletes, total }
//   | { status: 'paused', code } | { status: 'offline' }.
// `allowShrink`: the user said yes to a push that deletes most records.
export async function pushChanges({ allowShrink = false, onProgress = null } = {}) {
  try {
    const { token, vault } = await requireSync();
    const state = getCloudSyncState();
    const scan = await scanLocalChanges();
    const rejected = state.rejected || {};
    const puts = scan.puts.filter((p) => rejected[metaId(p.tbl, p.row_id)] !== p.hash);
    const deletes = scan.deletes;
    if (!puts.length && !deletes.length) return { status: 'nothing', pushed: 0, deleted: 0 };

    // The shrink guard (Phase 1 §3.5), on the scan: most records about to go.
    const total = scan.meta.size;
    if (!allowShrink && total >= SHRINK_MIN && deletes.length * 2 > total) {
      updateCloudSyncState({ lastError: { code: 'shrink', at: new Date().toISOString(), detail: { deletes: deletes.length, total } } });
      return { status: 'shrink', deletes: deletes.length, total };
    }

    // Build every record; a file's bytes go up first (once per content).
    const items = [];
    const nowRejected = { ...rejected };
    const dropped = [];
    for (const p of puts) {
      let row = p.syncRow;
      if (p.tbl === 'files') {
        const { row: sealedRow, upload } = await sealFileRow(row, p.blob, vault, { cloud: p.cloudFile });
        row = sealedRow;
        if (upload && !(await api.hasFile(token, upload.sha256))) await api.putFile(token, upload.sha256, upload.blob, upload.mime);
      }
      try {
        const record = await buildPutRecord(p.tbl, row, vault, { baseSeq: p.baseSeq, keptFileIds: scan.keptFileIds });
        items.push({ record, meta: { tbl: p.tbl, row_id: p.row_id, hash: p.hash } });
      } catch (err) {
        if (!(err instanceof CloudKeyError)) throw err;
        nowRejected[metaId(p.tbl, p.row_id)] = p.hash; // this device's bug, not the user's: never sent
        dropped.push({ kind: 'dropped', tbl: p.tbl, id: p.row_id, reason: `cloud_key:${err.key}` });
      }
    }
    for (const d of deletes) items.push({ record: buildDeleteRecord(d.tbl, d.row_id, { baseSeq: d.baseSeq }), meta: { tbl: d.tbl, row_id: d.row_id, deleted: true } });

    let pushed = 0;
    let deleted = 0;
    const replaced = [];
    let sent = 0;
    progress(onProgress, 'push', 0, items.length);
    for (const page of pages(items)) {
      const res = await api.pushSync(token, page.map((i) => i.record));
      const byKey = new Map(page.map((i) => [metaId(i.record.tbl, i.record.id), i]));
      const metaPuts = [];
      const metaDrops = [];
      for (const a of res.accepted || []) {
        const item = byKey.get(metaId(a.tbl, a.id));
        if (!item) continue;
        if (item.meta.deleted) { metaDrops.push(item.meta); deleted++; } else { metaPuts.push({ ...item.meta, seq: a.seq }); pushed++; }
        delete nowRejected[metaId(a.tbl, a.id)];
      }
      for (const d of res.dropped || []) {
        const item = byKey.get(metaId(d.tbl, d.id));
        if (item && !item.meta.deleted) nowRejected[metaId(d.tbl, d.id)] = item.meta.hash;
        dropped.push({ kind: 'dropped', tbl: d.tbl, id: d.id, reason: d.reason });
      }
      for (const s of res.superseded || []) replaced.push({ kind: 'replaced_theirs', tbl: s.tbl, id: s.id });
      await writeSyncMeta(metaPuts);
      await removeSyncMeta(metaDrops);
      sent += page.length;
      progress(onProgress, 'push', sent, items.length);
    }
    updateCloudSyncState({ rejected: nowRejected, lastPushAt: new Date().toISOString(), lastError: null });
    noteActivity([...dropped, ...replaced]);
    return { status: 'pushed', pushed, deleted, dropped: dropped.length };
  } catch (err) {
    return fromError(err);
  }
}

// The UI's progress bar: ({ phase: 'push' | 'pull', done, total }).
function progress(fn, phase, done, total) {
  try { fn?.({ phase, done, total }); } catch { /* UI only */ }
}

// Records in pages of at most PAGE_RECORDS and about PAGE_BYTES.
function* pages(items) {
  let page = [];
  let bytes = 0;
  for (const item of items) {
    const size = JSON.stringify(item.record).length;
    if (page.length && (page.length >= PAGE_RECORDS || bytes + size > PAGE_BYTES)) {
      yield page;
      page = [];
      bytes = 0;
    }
    page.push(item);
    bytes += size;
  }
  if (page.length) yield page;
}

// --- Pull (§5.2) -----------------------------------------------------------------------
// → { status: 'pulled', applied, keptOurs, cursor } | { status: 'paused', code } | { status: 'offline' }.
// `merge` (a join, §5.5): the newer updated_at wins and nothing is deleted;
// `total` is the server's seq, for the progress bar.
export async function pullChanges({ merge = false, onProgress = null, total = null } = {}) {
  try {
    const { token, vault } = await requireSync();
    let cursor = getCloudSyncState().cursor || 0;
    let applied = 0;
    let keptOurs = 0;
    for (;;) {
      const res = await api.pullSync(token, cursor);
      const out = await applyPulledRecords(res.records || [], {
        vault, fetchFile: (sha) => api.getFile(token, sha), merge
      });
      applied += out.applied;
      keptOurs += out.keptOurs || 0;
      noteActivity([
        ...out.keptTheirs.map((x) => ({ kind: 'kept_theirs', tbl: x.tbl, id: x.id, by: x.by })),
        ...out.archivedInstead.map((x) => ({ kind: 'archived_instead', tbl: x.tbl, id: x.id })),
        ...out.missingFiles.map((x) => ({ kind: 'missing_file', tbl: x.tbl, id: x.id }))
      ]);
      // Every record up to `seq` is in hand once nothing more is waiting.
      cursor = res.more ? res.through : Math.max(res.through ?? cursor, res.seq ?? cursor);
      updateCloudSyncState({ cursor });
      progress(onProgress, 'pull', cursor, total ?? res.seq ?? cursor);
      if (!res.more) break;
    }
    const state = updateCloudSyncState({ lastPullAt: new Date().toISOString(), lastError: null });
    if (!state.lastCursorSentAt || Date.now() - Date.parse(state.lastCursorSentAt) >= CURSOR_EVERY_MS) {
      try {
        await api.syncCursor(token, cursor);
        updateCloudSyncState({ lastCursorSentAt: new Date().toISOString() });
      } catch { /* the device list's "last synced" can wait for the next pull */ }
    }
    return { status: 'pulled', applied, keptOurs, cursor };
  } catch (err) {
    return fromError(err);
  }
}

// --- Both, one at a time ---------------------------------------------------------
// Serialized across tabs where the browser can (navigator.locks), and within one
// tab by a chain, like the backup push.
let chain = Promise.resolve();
function exclusive(fn) {
  const locks = globalThis.navigator?.locks;
  const run = () => (locks ? locks.request(LOCK_NAME, fn) : fn());
  const next = chain.then(run, run);
  chain = next.catch(() => {});
  return next;
}

// → { push, pull }. Skips both while this device isn't syncing.
export function syncNow({ pull = true, allowShrink = false } = {}) {
  return exclusive(async () => {
    if (!isSyncAvailable() || !getCloudSyncState().enabled) return { push: null, pull: null };
    if (getCloudSyncState().joining) return { join: await joinNow() };
    const push = await pushChanges({ allowShrink });
    if (push.status === 'paused' || push.status === 'shrink' || !pull) return { push, pull: null };
    return { push, pull: await pullChanges() };
  });
}

// The poll: a cheap head check, then a pull only when the server moved on.
export function pullIfBehind() {
  return exclusive(async () => {
    if (!isSyncAvailable() || !getCloudSyncState().enabled) return null;
    if (getCloudSyncState().joining) return joinNow();
    try {
      const { token } = await requireSync();
      const head = await api.syncHead(token);
      if (!head.enabled) return stoppedElsewhere();
      if (head.seq <= (getCloudSyncState().cursor || 0)) return { status: 'current' };
    } catch (err) {
      return fromError(err);
    }
    return pullChanges();
  });
}

export function syncStatus() {
  const s = getCloudSyncState();
  return {
    enabled: s.enabled, joining: !!s.joining, cursor: s.cursor, lastPushAt: s.lastPushAt, lastPullAt: s.lastPullAt,
    paused: s.lastError && s.lastError.code !== 'offline' ? s.lastError.code : null,
    offline: s.lastError?.code === 'offline', activity: s.activity || []
  };
}

// --- Turning it on, joining, turning it off (§2.1, §2.4, §5.5) -------------------------
// What this device still needs before it can keep in step (§2.1), in the order
// to fix them: signed_out, backup_off, backup_paused, vault_off, vault_locked.
// [] = ready. Pro is the server's to say: enableSync answers pro_required.
export async function syncReadiness() {
  if (!isSyncAvailable()) return ['unavailable'];
  const programId = currentAccount()?.programId;
  if (!sessionToken() || !programId) return ['signed_out'];
  const missing = [];
  const backup = getCloudBackupState();
  if (!backup.enabled) missing.push('backup_off');
  else if (isBackupBlocked(backup) && backup.lastError?.code !== 'vault_locked') missing.push('backup_paused');
  if (!(await getVaultKey(programId))) missing.push(backup.vault === 'locked' ? 'vault_locked' : 'vault_off');
  return missing;
}

// A refusal from turning it on or joining → a result the UI can name.
async function refused(err) {
  if (err instanceof api.CloudRequestError && err.code === 'pro_required') return { status: 'refused', code: 'pro_required' };
  if (err instanceof api.CloudConflictError && err.code === 'vault_required') return { status: 'refused', code: 'vault_off' };
  return fromError(err);
}

// The join itself (§5.5), resumable: `joining` stays set until it's done, and a
// sync run that finds it set comes back here, so an interrupted join (offline,
// the tab closed) never turns into a plain pull that drops this device's newer
// records. → { status: 'on', pulled, keptOurs, pushed } or a stop.
async function joinNow({ onProgress = null } = {}) {
  try {
    const { token } = await requireSync();
    const head = await api.syncHead(token);
    if (!head.enabled) return stoppedElsewhere();
    const s = getCloudSyncState();
    if (!s.joining) {
      await clearSyncMeta();
      updateCloudSyncState({ enabled: true, joining: true, cursor: 0, rejected: {}, lastError: null, lastPushAt: null, lastPullAt: null });
    }
    const pull = await pullChanges({ merge: true, onProgress, total: head.seq });
    if (pull.status !== 'pulled') return pull;
    const push = await pushChanges({ allowShrink: true, onProgress });
    if (push.status !== 'pushed' && push.status !== 'nothing') return push;
    updateCloudSyncState({ joining: false });
    await pullChanges(); // anything that arrived meanwhile, by server order again
    return { status: 'on', pulled: pull.applied, keptOurs: pull.keptOurs, pushed: push.pushed || 0 };
  } catch (err) {
    return fromError(err);
  }
}

async function ready() {
  const missing = await syncReadiness();
  return missing.length ? { status: 'not_ready', missing } : null;
}

// "Turn on…" (§2.1): the program syncs from now on, and this device joins. On the
// first device the join pulls nothing and uploads every record (the progress
// bar's 'push' phase); on a program that already syncs it's an ordinary join.
export function enableSync({ onProgress = null } = {}) {
  return exclusive(async () => {
    const notReady = await ready();
    if (notReady) return notReady;
    try {
      await api.enableSync(sessionToken());
    } catch (err) {
      return refused(err);
    }
    return joinNow({ onProgress });
  });
}

// "Keep this device in step" on a program that already syncs (§2.1).
export function joinSync({ onProgress = null } = {}) {
  return exclusive(async () => {
    const notReady = await ready();
    if (notReady) return notReady;
    return joinNow({ onProgress });
  });
}

// Whether the program syncs, for the join offer: → { enabled, seq } or null
// (unavailable, signed out, offline). Never throws.
export async function programSyncs() {
  if (!isSyncAvailable() || !sessionToken()) return null;
  try {
    const head = await api.syncHead(sessionToken());
    return { enabled: !!head.enabled, seq: head.seq };
  } catch {
    return null;
  }
}

// This device stops (§2.4): it keeps every record and goes back to being an
// ordinary backup device. What it synced is forgotten here; a later join starts over.
async function stopHere() {
  updateCloudSyncState({ enabled: false, joining: false, cursor: 0, rejected: {}, lastError: null });
  await clearSyncMeta();
}

export function disableSyncHere() {
  return exclusive(async () => {
    await stopHere();
    return { status: 'off' };
  });
}

// "Turn off for every device" (§2.4, typed confirm in the UI): a fresh sign-in
// (`reauth` = { email, code }, as signout-others); throws the cloudApi errors,
// reauth_required included, for the UI's fresh sign-in flow.
export function disableSyncEverywhere(reauth = {}) {
  return exclusive(async () => {
    await api.disableSync(sessionToken(), reauth);
    await stopHere();
    return { status: 'off' };
  });
}

// --- The scheduler (§5.1, §5.2) ------------------------------------------------------
let started = false;
export function startSyncScheduler({ win = globalThis } = {}) {
  if (started || !isSyncAvailable()) return;
  started = true;
  let pushTimer = null;
  const visible = () => win.document?.visibilityState !== 'hidden';
  win.addEventListener?.(CLOUD_DATA_CHANGED_EVENT, () => {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { syncNow(); }, PUSH_DEBOUNCE_MS);
  });
  win.document?.addEventListener?.('visibilitychange', () => {
    if (visible()) pullIfBehind();
    else { clearTimeout(pushTimer); syncNow({ pull: false }); }
  });
  win.addEventListener?.('pagehide', () => { syncNow({ pull: false }); });
  win.addEventListener?.('online', () => { syncNow(); });
  setInterval(() => { if (visible()) pullIfBehind(); }, POLL_MS);
  syncNow();
}
