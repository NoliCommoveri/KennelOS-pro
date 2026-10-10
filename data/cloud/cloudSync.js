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
// Turning sync on, joining and leaving are step 4 (plan §8); this module only
// runs while this device's sync state says `enabled`. Every entry point checks
// isCloudAvailable() and editionFlags.liveSync first, so Lite, Demo and
// `cloudUrl: null` never make a request. Network only through cloudApi.
//
// What stops it (getCloudSyncState().lastError.code): vault_locked (unlock
// Sensitive records here), vault_key_stale (unlock with the new key),
// pro_required (a lapsed license: plan §12 decision 6), sync_off (turned off for
// every device), resync_required (offline past the tombstone horizon: re-join),
// shrink (a push would delete most records: the user decides, as backup does),
// signed_out. `offline` is not a stop: the next run retries.
import * as api from './cloudApi.js';
import { isCloudAvailable } from './cloudConfig.js';
import { editionFlags } from '../editionConfig.js';
import { currentAccount, sessionToken, markSessionExpired } from './cloudAuth.js';
import { getVaultKey } from './vaultKeyStore.js';
import { VaultLockedError } from './vaultCrypto.js';
import { buildPutRecord, buildDeleteRecord, sealFileRow } from './syncRecords.js';
import { scanLocalChanges, writeSyncMeta, removeSyncMeta, metaId } from './syncState.js';
import { applyPulledRecords } from '../syncApply.js';
import { CloudKeyError } from '../syncRegistry.js';
import { getCloudSyncState, updateCloudSyncState, CLOUD_DATA_CHANGED_EVENT } from '../settings.js';

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
  if (err instanceof api.CloudConflictError && ['sync_off', 'vault_key_stale', 'vault_required'].includes(err.code)) return pause(err.code);
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
export async function pushChanges({ allowShrink = false } = {}) {
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
    }
    updateCloudSyncState({ rejected: nowRejected, lastPushAt: new Date().toISOString(), lastError: null });
    noteActivity([...dropped, ...replaced]);
    return { status: 'pushed', pushed, deleted, dropped: dropped.length };
  } catch (err) {
    return fromError(err);
  }
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
// → { status: 'pulled', applied, cursor } | { status: 'paused', code } | { status: 'offline' }.
export async function pullChanges() {
  try {
    const { token, vault } = await requireSync();
    let cursor = getCloudSyncState().cursor || 0;
    let applied = 0;
    for (;;) {
      const res = await api.pullSync(token, cursor);
      const out = await applyPulledRecords(res.records || [], {
        vault, fetchFile: (sha) => api.getFile(token, sha)
      });
      applied += out.applied;
      noteActivity([
        ...out.keptTheirs.map((x) => ({ kind: 'kept_theirs', tbl: x.tbl, id: x.id, by: x.by })),
        ...out.archivedInstead.map((x) => ({ kind: 'archived_instead', tbl: x.tbl, id: x.id })),
        ...out.missingFiles.map((x) => ({ kind: 'missing_file', tbl: x.tbl, id: x.id }))
      ]);
      // Every record up to `seq` is in hand once nothing more is waiting.
      cursor = res.more ? res.through : Math.max(res.through ?? cursor, res.seq ?? cursor);
      updateCloudSyncState({ cursor });
      if (!res.more) break;
    }
    const state = updateCloudSyncState({ lastPullAt: new Date().toISOString(), lastError: null });
    if (!state.lastCursorSentAt || Date.now() - Date.parse(state.lastCursorSentAt) >= CURSOR_EVERY_MS) {
      try {
        await api.syncCursor(token, cursor);
        updateCloudSyncState({ lastCursorSentAt: new Date().toISOString() });
      } catch { /* the device list's "last synced" can wait for the next pull */ }
    }
    return { status: 'pulled', applied, cursor };
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
    const push = await pushChanges({ allowShrink });
    if (push.status === 'paused' || push.status === 'shrink' || !pull) return { push, pull: null };
    return { push, pull: await pullChanges() };
  });
}

// The poll: a cheap head check, then a pull only when the server moved on.
export function pullIfBehind() {
  return exclusive(async () => {
    if (!isSyncAvailable() || !getCloudSyncState().enabled) return null;
    try {
      const { token } = await requireSync();
      const head = await api.syncHead(token);
      if (!head.enabled) return pause('sync_off');
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
    enabled: s.enabled, cursor: s.cursor, lastPushAt: s.lastPushAt, lastPullAt: s.lastPullAt,
    paused: s.lastError && s.lastError.code !== 'offline' ? s.lastError.code : null,
    offline: s.lastError?.code === 'offline', activity: s.activity || []
  };
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
