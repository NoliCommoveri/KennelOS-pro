// cloudAssist.js — assisted setup and help from KennelOS support, the data half
// (docs/KennelOS_Assisted_Setup_Plan.md). No DOM: assets/cloudAssistUI.js asks and shows.
//
// Two kinds of device on one account:
//   - **support's helper device**: signed in through a one-time assist link
//     (`?assist=<token>` on the app's address), role 'helper'. It sets her program
//     up, or helps, and is signed out when she takes over or help ends (any request
//     then hears helper_removed and the device erases itself, cloudDevices.js).
//   - **her devices**: ordinary. Her first sign-in on a program support set up takes
//     it over (claimAssisted's steps); later, Get help lets support back in.
//
// The vault key moves between the two sides by an automatic pairing (she chose no
// typed code): the asking device sends its code with the request, and the other
// side, while the program's state allows it, approves by itself (autoApproveOnce).
import * as api from './cloudApi.js';
import { isCloudAvailable } from './cloudConfig.js';
import { currentAccount, sessionToken, setHelperSession, clearAssisted, defaultDeviceLabel } from './cloudAuth.js';
import { getCloudDeviceId } from '../settings.js';
import { requestDeviceUnlock, waitForDeviceUnlock, listUnlockRequests, approveDeviceUnlock, cancelDeviceUnlock } from './cloudVault.js';

export const ASSIST_PARAM = 'assist';
const LINK = /^[0-9a-f]{64}$/;

// The assist token in this page's address, or null.
export function assistTokenInUrl(loc = globalThis.location) {
  try {
    const t = new URL(loc.href).searchParams.get(ASSIST_PARAM);
    return t && LINK.test(t) ? t : null;
  } catch { return null; }
}

// Removes ?assist= from the address bar, so a reload or a shared screenshot can't
// show a spent link.
export function stripAssistToken(loc = globalThis.location, hist = globalThis.history) {
  try {
    const u = new URL(loc.href);
    if (!u.searchParams.has(ASSIST_PARAM)) return;
    u.searchParams.delete(ASSIST_PARAM);
    hist?.replaceState?.(null, '', u.pathname + u.search + u.hash);
  } catch { /* not a browser */ }
}

// Support's device opens an assist link: it becomes a helper on her account.
// → { programId, state, label }. Throws CloudRequestError 'link_expired'.
export async function redeemAssistLink(token, { deviceLabel = defaultDeviceLabel() } = {}) {
  if (!isCloudAvailable()) throw new api.CloudUnavailableError();
  const res = await api.redeemAssist({ token, deviceId: getCloudDeviceId(), deviceLabel });
  setHelperSession(res, { deviceLabel: `KennelOS support${deviceLabel ? ` (${deviceLabel})` : ''}` });
  return { programId: res.programId, state: res.state, label: res.label };
}

export function isHelperDevice() {
  return currentAccount()?.role === 'helper';
}

function requireToken() {
  if (!isCloudAvailable()) throw new api.CloudUnavailableError();
  const token = sessionToken();
  if (!token) throw new api.CloudAuthError({ status: 401, code: 'unauthorized' });
  return token;
}

// → { role, state, label }; null when signed out or offline. Never throws.
export async function assistState() {
  if (!isCloudAvailable() || !sessionToken()) return null;
  try { return await api.getAssistState(sessionToken()); } catch { return null; }
}

// Her Get help, and either side's End help.
export const requestHelp = async () => api.requestAssistHelp(requireToken());
export const endHelp = async () => api.endAssistHelp(requireToken());

// Her takeover is complete (she holds the vault key): support is signed out.
export async function markClaimed() {
  const r = await api.assistClaimed(requireToken());
  clearAssisted();
  return r;
}

// May this device hand the vault key to the other side right now?
//   support's device: while the program is still in setup (her takeover);
//   her device: while she has asked for help.
export function shouldAutoApprove(state, role = currentAccount()?.role) {
  if (!state) return false;
  return role === 'helper' ? state.state === 'setup' : (state.state === 'requested' || state.state === 'helping');
}

// Approves every waiting automatic pairing (the server shows their codes only to the
// right side, and only while the program allows). → how many were approved.
export async function autoApproveOnce() {
  let requests;
  try { requests = await listUnlockRequests(); } catch { return 0; }
  let n = 0;
  for (const r of requests) {
    if (!r.autoCode) continue;
    try { await approveDeviceUnlock(r, r.autoCode); n++; } catch { /* expired or taken: the asker asks again */ }
  }
  return n;
}

// Gets the vault key from the other side by an automatic pairing, asking again
// whenever a request expires, until it arrives or `signal` aborts.
// → { status: 'unlocked' } | { status: 'cancelled' }
export async function unlockAutomatically({ label = null, signal = null, onWaiting = null, intervalMs } = {}) {
  for (;;) {
    if (signal?.aborted) { await cancelDeviceUnlock(); return { status: 'cancelled' }; }
    await requestDeviceUnlock({ label, auto: true });
    try {
      const r = await waitForDeviceUnlock({ signal, merge: false, onWaiting, ...(intervalMs ? { intervalMs } : {}) });
      if (r.status === 'unlocked') return { status: 'unlocked' };
      if (r.status === 'cancelled') { await cancelDeviceUnlock(); return r; }
    } catch (e) {
      // Expired, or a code that didn't fit (it can't, but ask again rather than stop).
      if (e?.name !== 'VaultSetupError' && e?.name !== 'VaultLockedError') throw e;
    }
  }
}
