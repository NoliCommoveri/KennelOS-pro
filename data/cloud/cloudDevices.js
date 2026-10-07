// cloudDevices.js — a lost device: erase it from another one, and free its Pro
// license (Cloud Phase 1 plan §2.5).
//
// The server can't reach a device; it can only answer one. So:
//   - every signed-in device checks in (checkIn), whether or not it has
//     anything to back up: on the first page of a browsing session, when the
//     app comes back to the foreground or back online (at most once a minute),
//     and on any other page load at most every 15 minutes (this is a
//     multi-page app: every navigation is a load). app.js starts it BEFORE the Pro license gate, so a device
//     whose license was already released (and walls) still hears the erase.
//   - any request that meets 401 device_erased, the check-in or any other,
//     erases this device (cloudApi's setErasedHandler → eraseThisDevice).
// Freeing a license is the owner's browser calling Lemon Squeezy with the key
// and the lost device's activation id, which the check-in reported. The key
// never goes to our server.
import * as api from './cloudApi.js';
import { isCloudAvailable } from './cloudConfig.js';
import { sessionToken, markSessionExpired } from './cloudAuth.js';
import {
  getCloudBackupState, updateCloudBackupState, getProLicense,
  getPendingEraseAck, setPendingEraseAck, clearPendingEraseAck
} from '../settings.js';
import { isLicenseGated, deactivate } from '../license.js';
import { eraseThisDevice as wipeThisDevice } from '../appReset.js';

export const CHECK_IN_EVERY_MS = 15 * 60 * 1000;
export const CHECK_IN_MIN_GAP_MS = 60 * 1000;
const SESSION_MARK = 'kennelOS.deviceCheckStarted';
export const NOTICE_CACHE = 'kennelOS.cloudNotices';
export const DEVICE_ERASED_EVENT = 'kennelos:deviceerased';

export function cacheNotices(notices) {
  try { globalThis.sessionStorage?.setItem(NOTICE_CACHE, JSON.stringify(notices)); } catch { /* fine */ }
}

// The Pro activation this device holds, for the device list. Lite has none.
function thisLicenseInstanceId() {
  return isLicenseGated() ? getProLicense()?.instanceId || null : null;
}

// --- The check-in ---------------------------------------------------------------
// Resolves { notices } after a check-in, { erased: true } when this device was
// erased, or null (no sign-in, throttled, offline, expired). Never throws.
let inFlight = null;

// `minGapMs`: skip if the last check-in was more recent than this.
export function checkIn({ force = false, minGapMs = CHECK_IN_EVERY_MS } = {}) {
  if (!isCloudAvailable()) return Promise.resolve(null);
  const token = sessionToken();
  if (!token) return Promise.resolve(null);
  if (inFlight) return inFlight;
  if (!force && sinceLastCheckIn() < minGapMs) return Promise.resolve(null);
  inFlight = (async () => {
    try {
      const res = await api.checkIn(token, { licenseInstanceId: thisLicenseInstanceId() });
      const notices = Array.isArray(res.notices) ? res.notices : [];
      updateCloudBackupState({ lastCheckInAt: new Date().toISOString() });
      cacheNotices(notices);
      return { notices };
    } catch (err) {
      if (err instanceof api.CloudErasedError) {
        await eraseThisDevice(token);
        return { erased: true };
      }
      if (err instanceof api.CloudAuthError) markSessionExpired();
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

const sinceLastCheckIn = () => Date.now() - (Date.parse(getCloudBackupState().lastCheckInAt || '') || 0);

// app.js, every page, before the license gate: finish an interrupted erase's
// acknowledgment, check in, and check in again whenever the app returns to the
// foreground or the connection returns.
let booted = false;
export function bootDeviceCheck({ win = globalThis } = {}) {
  if (!isCloudAvailable()) return;
  let coldStart = false;
  try {
    coldStart = !win.sessionStorage?.getItem(SESSION_MARK);
    win.sessionStorage?.setItem(SESSION_MARK, '1');
  } catch { /* no sessionStorage: treat as a later page */ }
  finishEraseAck();
  checkIn({ minGapMs: coldStart ? CHECK_IN_MIN_GAP_MS : CHECK_IN_EVERY_MS });
  if (booted) return;
  booted = true;
  const again = () => { finishEraseAck(); checkIn({ minGapMs: CHECK_IN_MIN_GAP_MS }); };
  win.addEventListener?.('online', again);
  win.document?.addEventListener?.('visibilitychange', () => { if (win.document.visibilityState === 'visible') again(); });
}

// --- Erased: this device wipes itself -------------------------------------------
// Everything goes (appReset.eraseThisDevice). Then, best effort, its Pro
// activation is released from here too, in case the owner didn't free it from
// their other device, and the server is told the erase happened. The page
// reloads onto first run.
let erasing = null;

export function eraseThisDevice(token = sessionToken()) {
  if (!erasing) erasing = doErase(token).finally(() => { erasing = null; });
  return erasing;
}

async function doErase(token) {
  const license = getProLicense();
  await wipeThisDevice();
  if (token) setPendingEraseAck(token);
  try { globalThis.dispatchEvent?.(new CustomEvent(DEVICE_ERASED_EVENT)); } catch { /* no window */ }
  const licenseReleased = license ? await deactivate(license) : false;
  await finishEraseAck({ licenseReleased });
  try { globalThis.location?.reload?.(); } catch { /* not a browser */ }
}

api.setErasedHandler((token) => eraseThisDevice(token));

// Tell the server this device is erased. Kept until it lands: an offline
// failure keeps the token for the next try; any answer at all clears it.
export async function finishEraseAck({ licenseReleased = false } = {}) {
  const token = getPendingEraseAck();
  if (!token || !isCloudAvailable()) return false;
  try {
    await api.ackErase(token, { licenseReleased });
  } catch (err) {
    if (err instanceof api.CloudOfflineError) return false;
  }
  clearPendingEraseAck();
  return true;
}

// --- The owner's side: the device list ---------------------------------------------
function requireToken() {
  if (!isCloudAvailable()) throw new api.CloudUnavailableError();
  const token = sessionToken();
  if (!token) throw new api.CloudAuthError({ status: 401, code: 'unauthorized' });
  return token;
}

// → [{ id, label, lastSeenAt, status, licenseInstanceId, erase, thisDevice, backing }]
//   status: 'signed-in' | 'signed-out' (an erase still reaches it) |
//           'signed-out-here' (it signed itself out: an erase can't reach it)
//   erase:  null | { requestedAt, confirmedAt }
export async function listDevices() {
  return (await api.listDevices(requireToken())).devices || [];
}

// Throws CloudRequestError 'reauth_required' when this sign-in is more than 15
// minutes old: send a code (cloudAuth.startSignIn) and pass { email, code }.
export async function requestErase(deviceId, reauth = {}) {
  await api.eraseDevice(requireToken(), deviceId, reauth);
}

export async function cancelErase(deviceId) {
  await api.cancelErase(requireToken(), deviceId);
}

// Releases the lost device's Lemon Squeezy activation with this license key.
// True when the slot came back; false when Lemon Squeezy refused (a different
// key, already released, offline). The server only hears that it's done.
export async function releaseDeviceLicense(device, key) {
  const token = requireToken();
  if (!device?.licenseInstanceId) return false;
  const released = await deactivate({ key: String(key ?? '').trim(), instanceId: device.licenseInstanceId });
  if (!released) return false;
  try { await api.markLicenseReleased(token, device.id); } catch { /* the slot is free either way */ }
  return true;
}
