// googleDrive.js — the breeder-side Google Drive client for the Furever console's
// "Publish to Furever" flow: a GIS token-client wrapper (Connect Google Drive) plus
// the small set of Drive v3 calls the publish orchestration needs (ensure a folder,
// upload/overwrite a file, share a folder public-by-link). See
// docs/KennelOS_Content_Package_Fetch_Mechanism.md §4.1/§4.2/§9 for the full
// mechanism this implements.
//
// CLIENT_ID below is the OAuth 2.0 Web application client id for the "KennelOS"
// Google Cloud project, registered once at https://console.cloud.google.com with:
//   - OAuth consent screen scoped to https://www.googleapis.com/auth/drive.file
//     only (non-sensitive — no Google verification review), published to
//     Production;
//   - Authorized JavaScript origins covering the KennelOS Pro/Demo origins
//     plus http://localhost:8000 for dev;
//   - No redirect URIs (the token-client flow needs none) and no client
//     secret (none is issued for this credential type).
// Like dropbox.js's APP_KEY, this is a public identifier, not a secret — it
// only tells Google which app is asking; the drive.file scope (this app can
// only ever see files it created) is what actually limits access, and every
// user still has to grant consent through their own Google sign-in.
export const CLIENT_ID = '566763436944-k7rk72avivr1qg5nd7sn1fhbbg0343r2.apps.googleusercontent.com';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const drivePermissionsUrl = (fileId) => `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}/permissions`;

// --- Token client (Google Identity Services, token model — §4.1/§9) --------
// Access-token-only: no client secret, no refresh token, no backend. The token
// lives ONLY in memory for the current tab/session — never persisted — because a
// GIS token model issues no refresh token to persist safely. `shared/pages/
// furever.*` (or any caller) treats "connected" as UI state only (settings.js);
// the actual token is always (re)acquired here, at the moment it's needed.
let tokenClient = null;
let cachedToken = null; // { accessToken, expiresAt } | null

function gisAvailable() {
  return typeof google !== 'undefined' && google.accounts && google.accounts.oauth2;
}

function ensureTokenClient() {
  if (tokenClient) return tokenClient;
  if (!gisAvailable()) {
    throw new Error('Google sign-in failed to load. Check your connection and refresh the page.');
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    callback: () => {} // replaced per-request in requestToken()
  });
  return tokenClient;
}

function requestToken({ silent = false } = {}) {
  return new Promise((resolve, reject) => {
    let client;
    try {
      client = ensureTokenClient();
    } catch (e) {
      reject(e);
      return;
    }
    client.callback = (resp) => {
      if (!resp || resp.error) {
        reject(new Error(resp && resp.error === 'access_denied'
          ? 'Google Drive access was not granted.'
          : 'Could not connect to Google Drive. Please try again.'));
        return;
      }
      cachedToken = {
        accessToken: resp.access_token,
        expiresAt: Date.now() + (Number(resp.expires_in) - 60) * 1000
      };
      resolve(cachedToken.accessToken);
    };
    client.requestAccessToken(silent ? { prompt: '' } : {});
  });
}

// The breeder-facing "Connect Google Drive" action — always interactive (a
// Google consent popup the first time; a click either way). Call from a click
// handler, per GIS's popup-blocker rules.
export async function connectDrive() {
  return requestToken({ silent: false });
}

// A valid access token for a Drive call. Reuses the in-memory token while it
// hasn't expired; otherwise tries a SILENT re-request first (works when the
// breeder's Google session is still live — §4.1), and only throws (never pops a
// surprise consent dialog mid-publish) if that fails, so the caller can ask the
// breeder to hit Connect again — one extra click, never a stuck publish.
async function ensureAccessToken({ force = false } = {}) {
  if (!force && cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.accessToken;
  }
  try {
    return await requestToken({ silent: true });
  } catch {
    throw new Error('Your Google Drive connection needs a refresh — click "Connect Google Drive" again, then Publish.');
  }
}

export function isDriveConnectedThisSession() {
  return !!(cachedToken && Date.now() < cachedToken.expiresAt);
}

// --- Drive v3 calls ----------------------------------------------------------

// One Drive call, retried once with a forced token re-acquisition on 401 (a
// token can lapse mid-publish on a long upload — §4.1's "worst case: one extra
// click" retry, mirroring dropbox.js's contentCall).
async function driveFetch(url, options = {}) {
  const attempt = async (force) => {
    const token = await ensureAccessToken({ force });
    try {
      return await fetch(url, {
        ...options,
        headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` }
      });
    } catch {
      throw new Error('Could not reach Google Drive — check your internet connection.');
    }
  };
  let res = await attempt(false);
  if (res.status === 401) res = await attempt(true);
  return res;
}

async function driveJson(url, options) {
  const res = await driveFetch(url, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = (body.error && body.error.message) || `HTTP ${res.status}`;
    throw new Error(`Google Drive request failed: ${detail}`);
  }
  return res.json();
}

// Find-or-create a folder by name under `parentId` (root "My Drive" if null).
// `drive.file` scope means files.list here only ever sees folders THIS app
// created, so a search-then-create is safe (it can't collide with the
// breeder's other Drive content). Callers should still cache the returned id
// (settings.js / litter.furever_pack) so a republish skips this call entirely.
export async function ensureFolder(name, parentId = null) {
  const parentClause = parentId ? `'${parentId}' in parents and ` : `'root' in parents and `;
  const q = `${parentClause}name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const list = await driveJson(`${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name)`);
  if (list.files && list.files.length) return list.files[0].id;

  const metadata = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    ...(parentId ? { parents: [parentId] } : {})
  };
  const created = await driveJson(`${DRIVE_FILES_URL}?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata)
  });
  return created.id;
}

// Make a folder (and everything under it) readable by anyone with the link.
// Called once per scope (§4.2 step 4) — safe to call again on a republish
// (Drive dedupes an identical grant), so we don't bother checking first.
export async function shareFolderPublic(folderId) {
  await driveJson(drivePermissionsUrl(folderId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'anyone', role: 'reader' })
  });
}

// Multipart/related body per the Drive v3 upload spec (fetch's own FormData
// produces multipart/form-data, which this endpoint does NOT accept — the parts
// have to be built by hand).
async function buildMultipartBody(metadata, blob) {
  const boundary = 'kennelos-' + Math.random().toString(36).slice(2);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const head =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  return { boundary, body: new Blob([head, bytes, tail]) };
}

// Create a new file in `folderId` from `blob`, or overwrite `existingFileId`'s
// content + metadata if given (a republish reusing the same Drive file — §4.2
// step 3's "skip files already uploaded at the same content... incremental").
// Returns `{ id, resourceKey }` — resourceKey is present only when Drive assigns
// one (link-shared items, §9); omitted from the manifest entry when absent,
// exactly as the seed packet does.
export async function uploadFile({ folderId, name, blob, existingFileId = null }) {
  const metadata = existingFileId ? { name } : { name, parents: [folderId] };
  const { boundary, body } = await buildMultipartBody(metadata, blob);
  const url = existingFileId
    ? `${DRIVE_UPLOAD_URL}/${encodeURIComponent(existingFileId)}?uploadType=multipart&fields=id,resourceKey`
    : `${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id,resourceKey`;
  return driveJson(url, {
    method: existingFileId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
}

// Write (or overwrite) the pack.json manifest — a thin, named wrapper over
// uploadFile so callers don't have to remember the mime/name convention.
export async function writeManifestFile({ folderId, manifest, existingFileId = null }) {
  const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
  return uploadFile({ folderId, name: 'pack.json', blob, existingFileId });
}
