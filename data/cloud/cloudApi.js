// cloudApi.js — the ONLY module that talks to the cloud server (Cloud Phase 1
// plan §3.1, §6.1). A thin fetch wrapper: base URL, bearer token, JSON, timeouts,
// and typed errors. One function per route, matching cloud/src/api.js.
//
// Errors (all extend CloudError):
//   CloudUnavailableError — this edition has no server (cloudUrl null).
//   CloudOfflineError     — no network, a timeout, the server's 503
//                           {maintenance: true}, or an unexpected 5xx. Retry
//                           later; never shown as a failure (plan §6.1).
//   CloudAuthError        — 401: the session expired or was revoked. The app
//                           asks for a new code; local data is untouched.
//   CloudErasedError      — 401 device_erased: the owner erased this device from
//                           another one (plan §2.5). A CloudAuthError too, so
//                           every caller already stops; the handler registered
//                           with setErasedHandler does the erasing.
//   CloudConflictError    — 409: another device is backing up this program, or
//                           this device's base is stale (plan §3.4). Carries
//                           `backingDevice` and `latestSnapshotId`.
//   CloudRequestError     — any other refusal, with the server's `code`
//                           (bad_email, invalid_code, too_many_attempts,
//                           rate_limited, email_unavailable, email_failed,
//                           missing_files, vault_required, no_vault, …) and
//                           its extra fields. (The vault's 409s, vault_exists
//                           and vault_key_stale, arrive as CloudConflictError
//                           with that `code`.)
//
// Bodies are never logged (plan §6.4): no email, code, token or record leaves
// this module except in the request itself.
import { cloudBaseUrl } from './cloudConfig.js';

export class CloudError extends Error {
  constructor(message, { status = null, code = null, extra = {} } = {}) {
    super(message);
    this.name = 'CloudError';
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}
export class CloudUnavailableError extends CloudError {
  constructor() { super('Cloud backup is not available in this edition.', { code: 'unavailable' }); this.name = 'CloudUnavailableError'; }
}
export class CloudOfflineError extends CloudError {
  constructor(message = 'Could not reach cloud backup.', opts) { super(message, opts); this.name = 'CloudOfflineError'; }
}
export class CloudAuthError extends CloudError {
  constructor(opts) { super('Cloud sign-in has expired. Sign in again.', opts); this.name = 'CloudAuthError'; }
}
export class CloudErasedError extends CloudAuthError {
  constructor(opts) { super(opts); this.name = 'CloudErasedError'; }
}
export class CloudConflictError extends CloudError {
  constructor(opts) { super('Another device is backing up this program.', opts); this.name = 'CloudConflictError'; }
}
export class CloudRequestError extends CloudError {
  constructor(opts) { super(`Cloud request refused (${opts.code || opts.status}).`, opts); this.name = 'CloudRequestError'; }
}

export const JSON_TIMEOUT_MS = 30 * 1000;
export const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

async function readError(res) {
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  const code = body && typeof body.error === 'string' ? body.error : null;
  const extra = body && typeof body === 'object' ? { ...body } : {};
  delete extra.error;
  const opts = { status: res.status, code, extra };
  if (res.status === 401) return code === 'device_erased' ? new CloudErasedError(opts) : new CloudAuthError(opts);
  if (res.status === 409) return new CloudConflictError(opts);
  if (res.status === 503 && body && body.maintenance) return new CloudOfflineError('Cloud backup is in maintenance.', opts);
  if (res.status >= 500 && (!code || code === 'internal')) return new CloudOfflineError(`Cloud backup answered ${res.status}.`, opts);
  return new CloudRequestError(opts);
}

// One request. `json` sends a JSON body; `body` sends a Blob as-is. Returns the
// Response for the caller to read (ok statuses only); everything else throws.
async function send(path, { method = 'GET', token = null, json, body, contentType, timeoutMs = JSON_TIMEOUT_MS, okStatuses = [] } = {}) {
  const base = cloudBaseUrl();
  if (!base) throw new CloudUnavailableError();
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(json);
  } else if (body !== undefined) {
    headers['content-type'] = contentType || body.type || 'application/octet-stream';
    payload = body;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await globalThis.fetch(`${base}${path}`, { method, headers, body: payload, signal: controller.signal });
  } catch {
    throw new CloudOfflineError(); // network down, DNS, CORS-blocked, or the timeout
  } finally {
    clearTimeout(timer);
  }
  if (res.ok || okStatuses.includes(res.status)) return res;
  const err = await readError(res);
  if (err instanceof CloudErasedError && erasedHandler) {
    const handler = erasedHandler;
    queueMicrotask(() => { Promise.resolve(handler(token)).catch(() => {}); });
  }
  throw err;
}

// Whatever request first hears device_erased hands its token to this handler
// (cloudDevices.js registers it), so the erase happens from any call site, not
// only the check-in. The token is passed because callers drop it on any 401.
let erasedHandler = null;
export function setErasedHandler(fn) { erasedHandler = fn; }

const getJson = async (path, opts) => (await send(path, opts)).json();

// --- Auth (no token) -----------------------------------------------------------
export const startSignIn = (email) => getJson('/auth/start', { method: 'POST', json: { email } });

// → { token, programId, deviceId }
export const verifyCode = ({ email, code, deviceId, deviceLabel }) =>
  getJson('/auth/verify', { method: 'POST', json: { email, code, deviceId, deviceLabel } });

// --- Auth (token) --------------------------------------------------------------
export const signOut = (token) => getJson('/auth/signout', { method: 'POST', token, json: {} });
// `reauth` = { email, code } when this sign-in is older than 15 minutes (plan §2.5).
export const signOutOthers = (token, reauth = {}) => getJson('/auth/signout-others', { method: 'POST', token, json: reauth });

// --- Program -------------------------------------------------------------------
// → { programId, thisDeviceId, backingDevice: {id,label,lastPushAt}|null, latestSnapshotId, latestSnapshot }
export const getProgram = (token) => getJson('/program', { token });
export const takeOverBacking = (token) => getJson('/program/backing-device', { method: 'POST', token, json: {} });
export const deleteAccount = (token, reauth = {}) => getJson('/account', { method: 'DELETE', token, json: { ...reauth, confirm: 'DELETE' } });

// --- The Pro license link (License Link Plan §5) ---------------------------------
// → { pro, plan, until, source, lapsed, linkedEmails }
export const getEntitlement = (token) => getJson('/account/entitlement', { token });
// A code to `email` (a Pro purchase made with another address). Always {ok:true}
// for a well-formed address; 400 own_email for the account's own.
export const startLicenseLink = (token, email) => getJson('/account/license-links/start', { method: 'POST', token, json: { email } });
// → the new entitlement
export const verifyLicenseLink = (token, { email, code }) =>
  getJson('/account/license-links/verify', { method: 'POST', token, json: { email, code } });
export const removeLicenseLinks = (token, reauth = {}) => getJson('/account/license-links', { method: 'DELETE', token, json: reauth });

// --- Devices (plan §2.5) ------------------------------------------------------
// → { ok, notices: [{ id, level, message, until }] }
export const checkIn = (token, { licenseInstanceId = null } = {}) =>
  getJson('/devices/check-in', { method: 'POST', token, json: { licenseInstanceId } });
// → { devices: [{ id, label, lastSeenAt, status, licenseInstanceId, erase, thisDevice, backing }] }
export const listDevices = (token) => getJson('/devices', { token });
// `reauth` = { email, code } when this sign-in is older than 15 minutes
// (otherwise CloudRequestError 'reauth_required').
export const eraseDevice = (token, deviceId, reauth = {}) =>
  getJson(`/devices/${encodeURIComponent(deviceId)}/erase`, { method: 'POST', token, json: reauth });
export const cancelErase = (token, deviceId) =>
  getJson(`/devices/${encodeURIComponent(deviceId)}/erase`, { method: 'DELETE', token });
export const ackErase = (token, { licenseReleased = false } = {}) =>
  getJson('/devices/erase-ack', { method: 'POST', token, json: { licenseReleased } });
export const markLicenseReleased = (token, deviceId) =>
  getJson(`/devices/${encodeURIComponent(deviceId)}/license-released`, { method: 'POST', token, json: {} });

// --- Files (content-addressed) ------------------------------------------------
export async function hasFile(token, sha256) {
  const res = await send(`/files/${sha256}`, { method: 'HEAD', token, okStatuses: [404] });
  return res.status === 200;
}

export const putFile = (token, sha256, blob, mime) =>
  send(`/files/${sha256}`, { method: 'PUT', token, body: blob, contentType: mime, timeoutMs: UPLOAD_TIMEOUT_MS }).then((r) => r.json());

export const getFile = (token, sha256) =>
  send(`/files/${sha256}`, { token, timeoutMs: UPLOAD_TIMEOUT_MS }).then((r) => r.blob());

// --- Snapshots ----------------------------------------------------------------
// Step one: { base_snapshot_id, size, counts, files: [sha256…] } → { snapshotId }
export const createSnapshot = (token, description) =>
  getJson('/snapshots', { method: 'POST', token, json: description });

// Step two: the gzipped envelope.
export const uploadSnapshotBody = (token, snapshotId, gzBlob) =>
  send(`/snapshots/${snapshotId}/body`, { method: 'PUT', token, body: gzBlob, contentType: 'application/gzip', timeoutMs: UPLOAD_TIMEOUT_MS })
    .then((r) => r.json());

// → { snapshots: [{ id, createdAt, size, counts, deviceId, deviceLabel }] }, newest first
export const listSnapshots = (token) => getJson('/snapshots', { token });

export const getSnapshot = (token, snapshotId) =>
  send(`/snapshots/${snapshotId}`, { token, timeoutMs: UPLOAD_TIMEOUT_MS }).then((r) => r.blob());

// With the private vault on: the encrypted vault part, uploaded BEFORE the body
// (Private Vault Plan §6.1). `bytes` is a Uint8Array or Blob.
export const uploadSnapshotVault = (token, snapshotId, bytes) =>
  send(`/snapshots/${snapshotId}/vault`, {
    method: 'PUT', token, body: bytes instanceof Blob ? bytes : new Blob([bytes]),
    contentType: 'application/octet-stream', timeoutMs: UPLOAD_TIMEOUT_MS
  }).then((r) => r.json());

export const getSnapshotVault = (token, snapshotId) =>
  send(`/snapshots/${snapshotId}/vault`, { token, timeoutMs: UPLOAD_TIMEOUT_MS }).then((r) => r.blob());

// --- The private vault (Private Vault Plan §6.1, §6.4) ---------------------------
// → { enabled, keyId?, createdAt?, wraps: [{ id, kind, label, createdAt, credentialId?, prfSalt? }] }
export const getVault = (token) => getJson('/vault', { token });
// → the same shape as getVault. 409 'vault_exists' when another device got there first.
export const enableVault = (token, { keyId, recoveryWrap }) =>
  getJson('/vault', { method: 'POST', token, json: { keyId, recoveryWrap } });
// `reauth` = { email, code } when this sign-in is older than 15 minutes.
export const disableVault = (token, reauth = {}) => getJson('/vault', { method: 'DELETE', token, json: reauth });
// → { id, kind, keyId, wrapped, credentialId?, prfSalt? }
export const getVaultWrap = (token, wrapId) => getJson(`/vault/wraps/${encodeURIComponent(wrapId)}`, { token });
export const addVaultWrap = (token, wrap) => getJson('/vault/wraps', { method: 'POST', token, json: wrap });
export const replaceRecoveryWrap = (token, { keyId, wrapped }, reauth = {}) =>
  getJson('/vault/wraps/recovery', { method: 'PUT', token, json: { keyId, wrapped, ...reauth } });
export const removeVaultWrap = (token, wrapId, reauth = {}) =>
  getJson(`/vault/wraps/${encodeURIComponent(wrapId)}`, { method: 'DELETE', token, json: reauth });

// Unlocking from another device (Private Vault Plan §5.3). The new device asks:
// → { pairingId, expiresAt }. 429 'too_many_pairings' / 'rate_limited'.
export const createPairing = (token, { publicKey, label = null }) =>
  getJson('/vault/pairings', { method: 'POST', token, json: { publicKey, label } });
// An unlocked device lists what it can approve:
// → { pairings: [{ id, deviceLabel, publicKey, createdAt, expiresAt }] }
export const listPairings = (token) => getJson('/vault/pairings', { token });
export const approvePairing = (token, pairingId, { approverKey, wrapped, keyId }) =>
  getJson(`/vault/pairings/${encodeURIComponent(pairingId)}/approve`, { method: 'POST', token, json: { approverKey, wrapped, keyId } });
// The asking device polls: → { status: 'waiting', expiresAt } or
// { status: 'approved', approverKey, wrapped, keyId } (once: the row goes as it's read).
export const pollPairing = (token, pairingId) => getJson(`/vault/pairings/${encodeURIComponent(pairingId)}`, { token });

// --- Public -------------------------------------------------------------------
// Service notices (the shutdown channel). → [{ id, level, message, until }]
// --- The waitlist online, her side (Waitlist W2 Plan §5) -------------------------------
export const publishWaitlist = (token, publicId, projection) =>
  getJson(`/waitlist/projection/${encodeURIComponent(publicId)}`, { method: 'PUT', token, json: { projection } });
export const readWaitlistInbox = (token, { all = false, after = null } = {}) =>
  getJson(`/waitlist/inbox${all || after ? `?${new URLSearchParams({ ...(all ? { all: '1' } : {}), ...(after ? { after } : {}) })}` : ''}`, { token });
export const ackWaitlistInbox = (token, ids) => getJson('/waitlist/inbox/ack', { method: 'POST', token, json: { ids } });
// → { events: [{ seq, publicId, entryId, kind, payload, basedOnVersion, madeBy, createdAt }], last, more }
export const readWaitlistEvents = (token, since = 0) => getJson(`/waitlist/events?since=${encodeURIComponent(since)}`, { token });
export const readWaitlistProjection = (token, publicId) =>
  getJson(`/waitlist/projection/${encodeURIComponent(publicId)}`, { token });
export const unpublishWaitlist = (token, publicId) =>
  getJson(`/waitlist/projection/${encodeURIComponent(publicId)}`, { method: 'DELETE', token });
// An email to one family, in the kennel's name (W2 step 6). → { status: 'sent' | 'failed', sentAt }
export const sendWaitlistEmail = (token, { id, publicId, entryId, kind, subject, body }) =>
  getJson('/waitlist/messages', { method: 'POST', token, json: { id, public_id: publicId, entry_id: entryId, kind, subject, body } });

export const getNotices = () => getJson('/notice').then((b) => b.notices || []);
