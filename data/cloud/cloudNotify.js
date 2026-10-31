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
import { sessionToken } from './cloudAuth.js';

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
  { value: 'server_move', label: 'A turn moves on while your phone is off' }
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
  await writeConfig({ api: cloudBaseUrl(), on: true, refreshedAt: Date.now() });
  return settings;
}

export async function disableAlertsHere() {
  const settings = await api.unsubscribePush(token());
  try { const { sub } = await currentSubscription(); if (sub) await sub.unsubscribe(); } catch { /* already gone */ }
  await writeConfig({ api: cloudBaseUrl(), on: false, refreshedAt: Date.now() });
  return settings;
}

export const sendTestAlert = () => api.testPush(token());

// On open (once a day): a device with alerts on tells the server its subscription
// again, and makes a new one if the browser dropped it (iPhone does, for an app
// left unopened). Quiet: never throws, never asks for permission.
export async function refreshAlertsHere() {
  try {
    const config = await readConfig();
    if (!config?.on || pushSupport() !== 'ok' || Notification.permission !== 'granted' || !sessionToken()) return 'off';
    if (config.refreshedAt && Date.now() - config.refreshedAt < REFRESH_EVERY_MS && config.api === cloudBaseUrl()) return 'fresh';
    const settings = await getSettings();
    if (!settings.push.available) return 'off';
    await enableAlertsHere(settings.push.publicKey);
    return 'refreshed';
  } catch {
    return 'failed';
  }
}

// --- The digest -------------------------------------------------------------------

// → settings, with `pending: true` while a code is out to another address.
export const startDigest = ({ email, frequency, kinds }) => api.startDigest(token(), { email, frequency, kinds, tz: timeZone() });
export const verifyDigest = (code) => api.verifyDigest(token(), code);
export const stopDigest = () => api.stopDigest(token());
