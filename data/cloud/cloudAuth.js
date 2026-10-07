// cloudAuth.js — the opt-in cloud account: email + 6-digit code, and the
// session that lives in settings.js (Cloud Phase 1 plan §2.1, §3.1, §3.3).
//
// Why a typed code and not a magic link: an iPhone home-screen PWA has separate
// storage from Safari, and a tapped link would sign in the wrong copy of the app.
//
// The email address is kept in the session on THIS device (to show "signed in
// as"); the server keeps only a keyed hash of it.
import * as api from './cloudApi.js';
import { isCloudAvailable } from './cloudConfig.js';
import {
  getCloudSession, setCloudSession, clearCloudSession, getCloudDeviceId, setCloudDeviceId,
  updateCloudBackupState
} from '../settings.js';

function requireCloud() {
  if (!isCloudAvailable()) throw new api.CloudUnavailableError();
}

// Step 1: email the code. Always resolves for a well-formed address, account or
// not (the server never says which). Throws CloudRequestError 'bad_email',
// 'rate_limited', 'email_unavailable' or 'email_failed'.
export async function startSignIn(email) {
  requireCloud();
  await api.startSignIn(String(email ?? '').trim());
}

// Step 2: the typed code. Stores the session and returns it. Throws
// CloudRequestError 'invalid_code' or 'too_many_attempts'.
// `deviceLabel` is what other devices see in "Backups are coming from …".
export async function verifySignIn(email, code, { deviceLabel = defaultDeviceLabel() } = {}) {
  requireCloud();
  const cleanEmail = String(email ?? '').trim();
  const res = await api.verifyCode({
    email: cleanEmail,
    code: String(code ?? '').replace(/\s/g, ''),
    deviceId: getCloudDeviceId(),
    deviceLabel
  });
  setCloudDeviceId(res.deviceId); // the server may have minted one
  const previous = getCloudSession();
  if (previous && previous.programId && previous.programId !== res.programId) {
    // A different account on this device: this device's backup position was
    // for the other program, so forget it.
    // (The vault key here is tagged with the other program, so it's never used.)
    updateCloudBackupState({ enabled: false, lastSnapshotId: null, lastCounts: null, lastContentHash: null, lastError: null, vault: null });
  }
  return setCloudSession({ token: res.token, email: cleanEmail, programId: res.programId, deviceId: res.deviceId, deviceLabel: deviceLabel || null });
}

// The session, or null. `signedIn` is false when the token was dropped after a
// 401 (the email and program are kept so the UI can offer "sign in again").
export function currentAccount() {
  const s = getCloudSession();
  if (!s) return null;
  return {
    email: s.email || null, programId: s.programId || null, deviceId: s.deviceId || null,
    deviceLabel: s.deviceLabel || null, signedIn: !!s.token
  };
}

export function sessionToken() {
  return getCloudSession()?.token || null;
}

// After a 401: keep who they were, drop the token, and pause backup until a
// new code is typed (plan §6.2). Local data is untouched.
export function markSessionExpired() {
  const s = getCloudSession();
  if (s) setCloudSession({ ...s, token: null });
}

// Sign out of this device. Revokes the token server-side when it can (best
// effort: offline still signs out locally), turns backup off, and forgets the
// backup position. The cloud copy stays.
export async function signOut() {
  const token = sessionToken();
  if (token && isCloudAvailable()) {
    try { await api.signOut(token); } catch { /* offline or already revoked */ }
  }
  clearCloudSession();
  updateCloudBackupState({ enabled: false, lastSnapshotId: null, lastCounts: null, lastContentHash: null, lastError: null });
}

// "Sign out other devices". Returns how many sessions were revoked. Throws
// CloudRequestError 'reauth_required' when this sign-in is more than 15
// minutes old: send a code (startSignIn) and pass { email, code } (plan §2.5).
export async function signOutOtherDevices(reauth = {}) {
  requireCloud();
  const token = sessionToken();
  if (!token) throw new api.CloudAuthError({ status: 401, code: 'unauthorized' });
  return (await api.signOutOthers(token, reauth)).revoked ?? 0;
}

// A readable default for the device label ("iPhone", "Mac", …). The UI lets the
// user change it. Reads the user agent only to name the device for its owner.
export function defaultDeviceLabel() {
  const ua = String(globalThis.navigator?.userAgent || '');
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Linux/.test(ua)) return 'Linux computer';
  return 'This device';
}
