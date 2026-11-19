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
import { currentAccount, sessionToken, setHelperSession, clearAssisted, defaultDeviceLabel, isConfirmedHelper, markHelperConfirmed } from './cloudAuth.js';
import { getCloudDeviceId } from '../settings.js';
import { dataTables } from '../db.js';
import { requestDeviceUnlock, pendingDeviceUnlock, waitForDeviceUnlock, listUnlockRequests, approveDeviceUnlock, cancelDeviceUnlock } from './cloudVault.js';

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

// The link was for another program than the records this device holds (review K05-1):
// nothing was signed in or copied. `heldFor` is the label of the user they belong to,
// when this device was helping her.
export class AssistDeviceInUseError extends Error {
  constructor(heldFor = null) {
    super('This device holds another account’s records.');
    this.name = 'AssistDeviceInUseError';
    this.code = 'device_holds_records';
    this.heldFor = heldFor;
  }
}

// Any record at all on this device (device-only tables aren't records).
export async function deviceHoldsRecords() {
  for (const t of dataTables()) if (await t.count() > 0) return true;
  return false;
}

// Support's device opens an assist link: it becomes a helper on her account.
// → { programId, state, label }. Throws CloudRequestError 'link_expired', and
// AssistDeviceInUseError when this device holds records of another program: those
// would sync up into her account as hers, so the new session is signed out again
// before anything is stored (the link is spent; support hands back there, then
// makes a new one).
export async function redeemAssistLink(token, { deviceLabel = defaultDeviceLabel() } = {}) {
  if (!isCloudAvailable()) throw new api.CloudUnavailableError();
  const previous = currentAccount();
  const res = await api.redeemAssist({ token, deviceId: getCloudDeviceId(), deviceLabel });
  if (previous?.programId !== res.programId && await deviceHoldsRecords()) {
    try { await api.signOut(res.token); } catch { /* it expires unused; help ending revokes it */ }
    throw new AssistDeviceInUseError(previous?.role === 'helper' ? previous.helperLabel || null : null);
  }
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
// A 'helper' answer is cached with the session (markHelperConfirmed) for the
// licence gate below.
export async function assistState() {
  if (!isCloudAvailable() || !sessionToken()) return null;
  const programId = currentAccount()?.programId;
  try {
    const st = await api.getAssistState(sessionToken());
    if (st?.role === 'helper') markHelperConfirmed(programId);
    return st;
  } catch { return null; }
}

// May the Pro licence gate let this device through as support's helper (review
// K05-11)? Only on the server's word: a confirmed helper session is let through at
// once; a session that only says 'helper' (one stored before the answer was kept)
// asks GET /assist/state now. Signed out, offline, or any other answer → false,
// and the ordinary gate decides. Never throws.
export async function helperSkipsLicenseGate() {
  if (!isCloudAvailable() || currentAccount()?.role !== 'helper' || !sessionToken()) return false;
  if (isConfirmedHelper()) return true;
  await assistState();
  return isConfirmedHelper();
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
// whenever a request expires, until it arrives or `signal` aborts. A request this
// device already has open is waited on rather than asked again, so moving between
// pages doesn't pile up requests into the server's caps (review K05-5).
// → { status: 'unlocked' } | { status: 'cancelled' }
export async function unlockAutomatically({ label = null, signal = null, onWaiting = null, intervalMs } = {}) {
  for (;;) {
    if (signal?.aborted) { await cancelDeviceUnlock(); return { status: 'cancelled' }; }
    const open = await pendingDeviceUnlock();
    if (!open?.auto) await requestDeviceUnlock({ label, auto: true });
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
