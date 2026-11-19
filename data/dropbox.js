// dropbox.js — minimal Dropbox client for the zero-cost sync features (the
// Import/Export page's push/pull and the KennelAssistant feed/outbox). Talks
// straight to the Dropbox HTTP API with fetch — no SDK, nothing vendored.
//
// Auth is OAuth2 + PKCE, which runs entirely client-side (no app secret, no
// backend). APP_KEY below is a public OAuth client id (not a secret — PKCE is
// built for exactly this "public client" case) for the "KennelOS" app
// registered once at https://www.dropbox.com/developers/apps with:
//   - Access type: "App folder" — tokens can only ever see /Apps/KennelOS/,
//     never the rest of whichever Dropbox account signs in;
//   - Redirect URIs: every page that calls beginDropboxAuth(), i.e. the
//     Import/Export page URL and the assistant.html URL (both the deployed
//     https://… addresses and http://localhost:8000/… for local dev).
// Every install of this app shares APP_KEY, but each user still does their own
// "Connect" and signs into their own Dropbox account — the key just tells
// Dropbox which application is asking, it grants no access by itself. The
// flow stores a long-lived refresh token (token_access_type=offline) and
// mints short-lived access tokens from it as needed.
//
// These are cross-origin calls, so the service worker's cache-first fetch
// handler ignores them entirely — every sync action is live network, by design
// (the sync features are online-only; the rest of the app still works offline).
const APP_KEY = 'z9m7ey6rf6yfcpv';

import { getDropboxSettings, setDropboxSettings, clearDropboxSettings } from './settings.js';

// The three files of the sync scheme, all relative to the app folder. Each has
// exactly one writer (see data/assistantSync.js for the full contract).
export const DROPBOX_PATHS = {
  backup: '/kennelos-backup.json',
  feed: '/assistant-feed.json',
  outbox: '/assistant-outbox.json'
};

const AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const CONTENT_URL = 'https://content.dropboxapi.com/2/files';

// Base64url without padding — the PKCE alphabet.
function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The redirect URI is the calling page's own URL (no query/hash) — each page
// that offers "Connect" round-trips back to itself. Must match one of the
// URIs registered on the Dropbox app (a one-time developer setup step).
function dropboxRedirectUri() {
  return location.origin + location.pathname;
}

// Fired on the window when the connection ends by itself (an expired or revoked
// grant), so every Dropbox control on the page redraws as not connected.
export const DROPBOX_CHANGED_EVENT = 'kennelos:dropboxchanged';

// Her Dropbox connection was revoked or expired (review K2-9): the tokens are
// forgotten, and she connects again.
export class DropboxExpiredError extends Error {
  constructor() {
    super('Your Dropbox connection has expired. Connect again.');
    this.name = 'DropboxExpiredError';
    this.code = 'dropbox_expired';
  }
}

// A guarded upload found a different file than the one this device last pushed
// or pulled (review K2-13): another phone pushed since.
export class DropboxConflictError extends Error {
  constructor(path) {
    super('A newer backup is already in Dropbox. Pull it first, or push anyway.');
    this.name = 'DropboxConflictError';
    this.code = 'dropbox_conflict';
    this.path = path;
  }
}

export function isDropboxConnected() {
  const s = getDropboxSettings();
  return Boolean(s.refreshToken);
}

// Kick off the PKCE authorization redirect. Stores the verifier (localStorage,
// so it survives the round-trip through dropbox.com), then navigates away;
// completeDropboxAuth() finishes the job when Dropbox sends the browser back
// with ?code=.
export async function beginDropboxAuth() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  // CSRF nonce: a random value round-tripped through Dropbox and checked on the
  // way back, so a `?code=` we didn't initiate (a forged redirect to this page)
  // is rejected rather than exchanged. Stored beside the PKCE verifier and cleared
  // the same way once the round-trip completes.
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  setDropboxSettings({ pkceVerifier: verifier, oauthState: state });
  const params = new URLSearchParams({
    client_id: APP_KEY,
    response_type: 'code',
    code_challenge: b64url(new Uint8Array(digest)),
    code_challenge_method: 'S256',
    redirect_uri: dropboxRedirectUri(),
    token_access_type: 'offline',
    state
  });
  location.assign(`${AUTHORIZE_URL}?${params}`);
}

// Call on page load from any page that offers Connect. If the URL carries the
// OAuth ?code= from Dropbox, exchange it for tokens and return true (the page
// should re-render its connection status); otherwise do nothing. The code is
// scrubbed from the URL either way so a reload never replays a spent code.
export async function completeDropboxAuth() {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  if (!code) return false;
  const returnedState = url.searchParams.get('state');
  url.searchParams.delete('code');
  url.searchParams.delete('state');
  history.replaceState(null, '', url.toString());

  const s = getDropboxSettings();
  if (!s.pkceVerifier) {
    throw new Error('Dropbox sent back an authorization code, but no connection attempt is in progress. Try Connect again.');
  }
  // Reject a code whose state doesn't match the one we sent (CSRF). Guarded on
  // `s.oauthState` being present so a redirect from an auth started before this
  // check existed isn't spuriously refused; new flows always set it.
  if (s.oauthState && returnedState !== s.oauthState) {
    setDropboxSettings({ pkceVerifier: null, oauthState: null });
    throw new Error('Dropbox sign-in could not be verified (state mismatch). Please try Connect again.');
  }
  const tokens = await tokenRequest({
    code,
    grant_type: 'authorization_code',
    code_verifier: s.pkceVerifier,
    client_id: APP_KEY,
    redirect_uri: dropboxRedirectUri()
  });
  setDropboxSettings({
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    accessTokenExpiresAt: Date.now() + (tokens.expires_in - 60) * 1000,
    pkceVerifier: null,
    oauthState: null
  });
  return true;
}

// Forget the tokens (and cached access token).
export function disconnectDropbox() {
  clearDropboxSettings();
}

async function tokenRequest(fields) {
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields)
    });
  } catch {
    throw new Error('Could not reach Dropbox — check your internet connection.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body.error_description || body.error || `HTTP ${res.status}`;
    const err = new Error(`Dropbox sign-in failed: ${detail}`);
    err.status = res.status;
    err.oauthError = body.error || null;
    throw err;
  }
  return body;
}

// A refresh grant Dropbox won't honour any more: the app was removed from her
// Dropbox's connected apps, or the grant expired.
export const isExpiredGrant = (e) => e?.oauthError === 'invalid_grant' || e?.status === 400 || e?.status === 401;

// A valid short-lived access token, minting a fresh one from the refresh token
// when the cached one is missing/expired.
async function getAccessToken({ force = false } = {}) {
  const s = getDropboxSettings();
  if (!s.refreshToken) {
    throw new Error('Not connected to Dropbox — use Connect first.');
  }
  if (!force && s.accessToken && s.accessTokenExpiresAt && Date.now() < s.accessTokenExpiresAt) {
    return s.accessToken;
  }
  let tokens;
  try {
    tokens = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: s.refreshToken,
      client_id: APP_KEY
    });
  } catch (e) {
    if (!isExpiredGrant(e)) throw e;
    disconnectDropbox();
    try { globalThis.dispatchEvent?.(new Event(DROPBOX_CHANGED_EVENT)); } catch { /* no window */ }
    throw new DropboxExpiredError();
  }
  setDropboxSettings({
    accessToken: tokens.access_token,
    accessTokenExpiresAt: Date.now() + (tokens.expires_in - 60) * 1000
  });
  return tokens.access_token;
}

// One content-endpoint call, retried once with a forced token refresh on 401
// (an access token can be revoked/expired ahead of its cached expiry).
async function contentCall(endpoint, apiArg, body) {
  const attempt = async (force) => {
    const token = await getAccessToken({ force });
    try {
      return await fetch(`${CONTENT_URL}/${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          // Fixed ASCII paths only, so plain JSON.stringify is header-safe here.
          'Dropbox-API-Arg': JSON.stringify(apiArg),
          ...(body != null ? { 'Content-Type': 'application/octet-stream' } : {})
        },
        ...(body != null ? { body } : {})
      });
    } catch {
      throw new Error('Could not reach Dropbox — check your internet connection.');
    }
  };
  let res = await attempt(false);
  if (res.status === 401) res = await attempt(true);
  return res;
}

// The file's revision as this device last pushed it or restored from it, per path
// (settings `revs`). A guarded upload sends it, so Dropbox refuses to replace a
// file another phone pushed since (review K2-13). A pull counts only once she
// restores from it (assistantSync.noteDropboxRestored), not on a preview.
export const knownRev = (path) => getDropboxSettings().revs?.[path] || null;
export function rememberRev(path, rev) {
  if (!rev) return;
  setDropboxSettings({ revs: { ...(getDropboxSettings().revs || {}), [path]: rev } });
}

// The upload mode: overwrite unless `guard`; guarded, an update of the known
// revision, or an add when this device has never seen the file (both fail with
// a conflict when the file there is a different one). `force` overwrites.
export function uploadMode(path, { guard = false, force = false } = {}) {
  if (!guard || force) return 'overwrite';
  const rev = knownRev(path);
  return rev ? { '.tag': 'update', update: rev } : 'add';
}

// Store `obj` as pretty-printed JSON at `path` (relative to the app folder,
// e.g. '/kennelos-backup.json'). Unguarded it overwrites whatever is there;
// `{ guard: true }` throws DropboxConflictError when another device replaced the
// file since this one last saw it (`force: true` overwrites anyway).
export async function dropboxUploadJson(path, obj, { guard = false, force = false } = {}) {
  const res = await contentCall('upload',
    { path, mode: uploadMode(path, { guard, force }), autorename: false, mute: true },
    JSON.stringify(obj, null, 2));
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 409 && text.includes('conflict')) throw new DropboxConflictError(path);
    throw new Error(`Dropbox upload of ${path} failed: ${summarize(res, text)}`);
  }
  const meta = await res.json();
  rememberRev(path, meta?.rev);
  return meta;
}

// Fetch and parse the JSON file at `path`. Returns null when the file simply
// doesn't exist yet (nothing has been pushed) — every other failure throws.
export async function dropboxDownloadJson(path) {
  return (await dropboxDownloadWithRev(path))?.obj ?? null;
}

// The same, with the file's revision: → { obj, rev } | null.
export async function dropboxDownloadWithRev(path) {
  const res = await contentCall('download', { path });
  if (res.status === 409) {
    const text = await res.text().catch(() => '');
    if (text.includes('not_found')) return null;
    throw new Error(`Dropbox download of ${path} failed: ${summarize(res, text)}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Dropbox download of ${path} failed: ${summarize(res, text)}`);
  }
  const text = await res.text();
  let rev = null;
  try {
    rev = JSON.parse(res.headers?.get?.('Dropbox-API-Result') || 'null')?.rev || null;
  } catch { /* no metadata header: the next guarded push asks */ }
  try {
    return { obj: JSON.parse(text), rev };
  } catch {
    throw new Error(`The file at ${path} in Dropbox is not valid JSON.`);
  }
}

function summarize(res, text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed.error_summary) return parsed.error_summary;
  } catch { /* fall through to the raw status */ }
  return `HTTP ${res.status}`;
}
