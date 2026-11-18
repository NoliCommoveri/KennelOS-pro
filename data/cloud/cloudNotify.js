// cloudNotify.js — app alerts (web push) and the email digest, the app's side
// (docs/KennelOS_Notifications_Plan.md; End-State guide §29). Network calls go
// through cloudApi.js; the settings themselves live on the server (per account,
// and per device for alerts), never in a backup.
//
// Alerts carry no text: the push only wakes sw.js, which asks the server what to
// show (POST /notify/push/pending), proving itself with its subscription's own
// secret. sw.js can't import modules or read localStorage, so the server's
// address is left for it in Cache Storage (NOTIFY_CACHE), which it never purges.
//
// Edition-agnostic: callers gate on cloudConfig.isCloudAvailable(), a signed-in
// account and editionFlags.waitlist.
import * as api from './cloudApi.js';
import { cloudBaseUrl } from './cloudConfig.js';
import { sessionToken, currentAccount } from './cloudAuth.js';
import { getCloudSyncState } from '../settings.js';

export const NOTIFY_CACHE = 'kennelos-notify';
const CONFIG_KEY = 'config';
export const REFRESH_EVERY_MS = 24 * 60 * 60 * 1000;
export const SUBSCRIBE_TIMEOUT_MS = 20 * 1000;

// What she can tick, in the card's order, with its words.
export const NOTIFY_KIND_LABELS = [
  { value: 'message', label: 'A family sends a message' },
  { value: 'application', label: 'A new application arrives' },
  { value: 'turn', label: 'A family picks a pup or passes on their turn' },
  { value: 'request', label: 'A family asks for something or leaves the list' },
  { value: 'ready', label: 'A family answers "Ready now?"' },
  { value: 'server_move', label: 'A turn moves on while your phone is off' },
  { value: 'contract', label: 'A contract sent for e-signature is signed, declined or expires' }
];

const token = () => {
  const t = sessionToken();
  if (!t) throw new api.CloudAuthError({ status: 401, code: 'signed_out' });
  return t;
};

// --- What this browser can do ----------------------------------------------------

const isIos = () => /iPhone|iPad|iPod/.test(globalThis.navigator?.userAgent || '')
  || (globalThis.navigator?.platform === 'MacIntel' && globalThis.navigator?.maxTouchPoints > 1);
const isStandalone = () => Boolean(globalThis.matchMedia?.('(display-mode: standalone)').matches || globalThis.navigator?.standalone);

// → 'ok' | 'install' (iPhone/iPad: add to Home Screen first) | 'unsupported' | 'denied'
export function pushSupport() {
  const w = globalThis;
  const capable = 'serviceWorker' in (w.navigator || {}) && 'PushManager' in w && 'Notification' in w;
  if (!capable) return isIos() && !isStandalone() ? 'install' : 'unsupported';
  if (w.Notification.permission === 'denied') return 'denied';
  return 'ok';
}

// --- The service worker's note: where to ask ----------------------------------------

async function readConfig() {
  try {
    const res = await (await caches.open(NOTIFY_CACHE)).match(CONFIG_KEY);
    return res ? await res.json() : null;
  } catch { return null; }
}
// The account whose owner turned alerts on here (review K12-8): a note left by
// someone else, or by support's helper session, is never refreshed.
const ownerProgramId = () => {
  const a = currentAccount();
  return a && a.role === 'owner' ? a.programId : null;
};
async function writeConfig(config) {
  try {
    await (await caches.open(NOTIFY_CACHE)).put(CONFIG_KEY, new Response(JSON.stringify(config), { headers: { 'content-type': 'application/json' } }));
  } catch { /* no Cache Storage: the worker shows its plain alert */ }
}

// --- Settings ---------------------------------------------------------------------

export const getSettings = () => api.getNotifySettings(token());

const timeZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } };

// { pushKinds?, hideNames?, digestKinds?, digestFrequency? }
export const saveSettings = ({ pushKinds, hideNames, digestKinds, digestFrequency } = {}) =>
  api.putNotifySettings(token(), { push_kinds: pushKinds, hide_names: hideNames, digest_kinds: digestKinds, digest_frequency: digestFrequency, tz: timeZone() });

const b64urlToBytes = (s) => {
  const raw = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

async function currentSubscription() {
  const reg = await navigator.serviceWorker.ready;
  return { reg, sub: await reg.pushManager.getSubscription() };
}

// Turn alerts on for this device: asks the browser's permission (must follow her
// tap), subscribes, tells the server. → the settings.
export async function enableAlertsHere(publicKey) {
  if (pushSupport() !== 'ok') throw new Error('This browser can\'t show alerts.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Alerts weren\'t allowed. Allow notifications for KennelOS in this browser\'s settings, then try again.');
  const { reg, sub: existing } = await currentSubscription();
  let sub = existing;
  const key = b64urlToBytes(publicKey);
  // A subscription made with another key (the server's key changed) can't be used.
  const sameKey = (s) => {
    const k = s?.options?.applicationServerKey;
    return !k || (k.byteLength === key.byteLength && new Uint8Array(k).every((b, i) => b === key[i]));
  };
  if (sub && !sameKey(sub)) { await sub.unsubscribe(); sub = null; }
  if (!sub) {
    // The browser registers with its push service (Google's, Apple's…); with no
    // way through, it can wait forever.
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('This browser\'s push service didn\'t answer. Check the connection and try again.')), SUBSCRIBE_TIMEOUT_MS); });
    try {
      sub = await Promise.race([reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }), timeout]);
    } finally { clearTimeout(timer); }
  }
  const { endpoint, keys } = sub.toJSON();
  const settings = await api.subscribePush(token(), { endpoint, auth: keys.auth });
  await writeConfig({ api: cloudBaseUrl(), on: true, refreshedAt: Date.now(), programId: ownerProgramId() });
  return settings;
}

export async function disableAlertsHere() {
  const settings = await api.unsubscribePush(token());
  try { const { sub } = await currentSubscription(); if (sub) await sub.unsubscribe(); } catch { /* already gone */ }
  await writeConfig({ api: cloudBaseUrl(), on: false, refreshedAt: Date.now(), programId: ownerProgramId() });
  return settings;
}

// Sign-out, an erase or support's hand-back (review K12-8): this device stops
// showing alerts for the account. The browser's subscription goes and the note is
// deleted, so no later sign-in (another account, a helper session) re-subscribes
// on its own. The server row goes too when `token` still works (best effort: a
// revoked session already silences it, notify.js liveSubscriptions). Never throws.
export async function forgetAlertsHere(token = null) {
  if (token) { try { await api.unsubscribePush(token); } catch { /* offline or revoked */ } }
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    const sub = await reg?.pushManager?.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch { /* no service worker here */ }
  try { await (await caches.open(NOTIFY_CACHE)).delete(CONFIG_KEY); } catch { /* no Cache Storage */ }
}

// Whether alerts the server sends this device can actually show (review K12-7): the
// server's row says "on" until told otherwise, while the phone may have blocked them
// or the browser dropped its subscription. → 'ok' | 'blocked' | 'lost'.
export async function alertsLiveHere() {
  if (pushSupport() === 'denied' || globalThis.Notification?.permission !== 'granted') return 'blocked';
  try {
    const { sub } = await currentSubscription();
    return sub ? 'ok' : 'lost';
  } catch { return 'lost'; }
}

export const sendTestAlert = () => api.testPush(token());

// On open (once a day): a device with alerts on tells the server its subscription
// again, and makes a new one if the browser dropped it (iPhone does, for an app
// left unopened). Quiet: never throws, never asks for permission.
export async function refreshAlertsHere() {
  try {
    const config = await readConfig();
    if (!config?.on || pushSupport() !== 'ok' || Notification.permission !== 'granted' || !sessionToken()) return 'off';
    // Only for the owner who turned them on. A note from before the account was
    // recorded is adopted by the owner signed in now (it was hers, since sign-out
    // deletes it).
    const programId = ownerProgramId();
    if (!programId || (config.programId && config.programId !== programId)) return 'off';
    if (config.refreshedAt && Date.now() - config.refreshedAt < REFRESH_EVERY_MS && config.api === cloudBaseUrl()) return 'fresh';
    const settings = await getSettings();
    if (!settings.push.available) return 'off';
    await enableAlertsHere(settings.push.publicKey);
    return 'refreshed';
  } catch {
    return 'failed';
  }
}

// --- Where family events land (review K12-4) -----------------------------------------
// An alert says a family did something; the app shows it only once a device that
// takes in family events has applied it (serverWork.js). → { ok: true } |
// { ok: false, reason: 'not_backing', label } (another device backs up) |
// { ok: false, reason: 'not_syncing_here' } (her devices keep in step; this one doesn't).
export async function takeInHere({ syncHere = getCloudSyncState().enabled } = {}) {
  const program = await api.getProgram(token());
  if (program.syncing) return syncHere ? { ok: true } : { ok: false, reason: 'not_syncing_here' };
  if (program.backingDevice && program.backingDevice.id === program.thisDeviceId) return { ok: true };
  return { ok: false, reason: 'not_backing', label: program.backingDevice?.label || null };
}

// The words for a device that shows alerts but doesn't take the events in.
export function takeInHereText(where) {
  if (!where || where.ok) return '';
  if (where.reason === 'not_syncing_here') return 'Alerts show here, but what families do reaches this device only once it keeps in step with your others (Import / Export → Keep devices in step). Until then, open the alert on a device that does.';
  return `Alerts show here, but what families do is taken in by ${where.label ? `“${where.label}”` : 'the device that backs up'}, so it shows on this device only after that one backs up and this one restores. Open the alert there, or make this device the one that backs up.`;
}

// --- The digest -------------------------------------------------------------------

// → settings, with `pending: true` while a code is out to another address.
export const startDigest = ({ email, frequency, kinds }) => api.startDigest(token(), { email, frequency, kinds, tz: timeZone() });
export const verifyDigest = (code) => api.verifyDigest(token(), code);
export const stopDigest = () => api.stopDigest(token());
