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
//   CloudConflictError    — 409: another device is backing up this program, or
//                           this device's base is stale (plan §3.4). Carries
//                           `backingDevice` and `latestSnapshotId`.
//   CloudRequestError     — any other refusal, with the server's `code`
//                           (bad_email, invalid_code, too_many_attempts,
//                           rate_limited, email_unavailable, email_failed,
//                           missing_files, …) and its extra fields.
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
  if (res.status === 401) return new CloudAuthError(opts);
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
  throw await readError(res);
}

const getJson = async (path, opts) => (await send(path, opts)).json();

// --- Auth (no token) -----------------------------------------------------------
export const startSignIn = (email) => getJson('/auth/start', { method: 'POST', json: { email } });

// → { token, programId, deviceId }
export const verifyCode = ({ email, code, deviceId, deviceLabel }) =>
  getJson('/auth/verify', { method: 'POST', json: { email, code, deviceId, deviceLabel } });

// --- Auth (token) --------------------------------------------------------------
export const signOut = (token) => getJson('/auth/signout', { method: 'POST', token, json: {} });
export const signOutOthers = (token) => getJson('/auth/signout-others', { method: 'POST', token, json: {} });

// --- Program -------------------------------------------------------------------
// → { programId, thisDeviceId, backingDevice: {id,label,lastPushAt}|null, latestSnapshotId, latestSnapshot }
export const getProgram = (token) => getJson('/program', { token });
export const takeOverBacking = (token) => getJson('/program/backing-device', { method: 'POST', token, json: {} });
export const deleteAccount = (token) => getJson('/account', { method: 'DELETE', token, json: { confirm: 'DELETE' } });

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

// --- Public -------------------------------------------------------------------
// Service notices (the shutdown channel). → [{ id, level, message, until }]
export const getNotices = () => getJson('/notice').then((b) => b.notices || []);
