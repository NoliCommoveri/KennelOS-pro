// cloudIntegrations.js — vendor integrations on her device (Integrations plan §0,
// step 5): read the events the Worker kept for her (a contract signed, a payment
// made) and apply each one to its record, through the repos, with the rule in
// data/integrationEvents.js (apply while the record is where the vendor's link
// left it, else a review for Today).
//
// Only the device doing the program's server work applies (serverWork.js: the
// BACKING device, or on a syncing program the lease holder), checked before the
// first write, like the waitlist's family events, so two devices never apply one event twice;
// the cursor lives on this device (settings, outside KEYS). Events are read only
// while the account has a connection (`connections` in the state, set by a vendor's
// connect flow, steps 6 and 8, or by refreshConnections). A device that knows of none
// asks once per app open (syncOnOpen), because a connection made on another device
// (another of hers, or support's helper during an assist) never reaches this one's
// state otherwise. Every entry point checks isCloudAvailable() and the
// session first, so `cloudUrl: null` makes no request. Network only through cloudApi.
import * as api from './cloudApi.js';
import { isCloudAvailable } from './cloudConfig.js';
import { sessionToken } from './cloudAuth.js';
import { claimServerWork } from './serverWork.js';
import { getIntegrationsState, updateIntegrationsState } from '../settings.js';
import { editionFlags } from '../editionConfig.js';
import { applyIntegrationEvent } from '../integrationApply.js';

export const INTEGRATIONS_POLL_MS = 5 * 60 * 1000;

const offered = () => isCloudAvailable() && Boolean(editionFlags.accounts);

function errorCode(err) {
  if (err instanceof api.CloudOfflineError) return 'offline';
  if (err instanceof api.CloudAuthError) return 'signed-out';
  if (err?.code === 'not_backing_device') return 'not-backing';
  if (err?.code === 'lease_held') return 'lease-held';
  if (err?.code === 'not_syncing_here') return 'not-syncing';
  if (err?.code === 'pro_required') return 'pro-required';
  return 'failed';
}

// Ask the server which connections the account has (after a connect or a
// disconnect elsewhere). → the connections list.
export async function refreshConnections() {
  if (!offered()) return [];
  const token = sessionToken();
  if (!token) return [];
  const { connections } = await api.listIntegrations(token);
  updateIntegrationsState({ connections: connections.length });
  return connections;
}

// One event applied through the repos (integrationApply.js, shared with the
// device's own Stripe check).
export { applyIntegrationEvent };

let running = null;

// Read and apply everything after this device's cursor. Runs one at a time.
// → { applied, review, skipped } or null when nothing was asked of the server.
export function syncIntegrationEvents({ force = false } = {}) {
  if (running) return running;
  running = run(force).finally(() => { running = null; });
  return running;
}

async function run(force) {
  if (!offered()) return null;
  const token = sessionToken();
  if (!token) return null;
  const state = getIntegrationsState();
  if (!force && !(state.connections > 0)) return null;
  updateIntegrationsState({ lastAttemptAt: new Date().toISOString() });
  const counts = { applied: 0, review: 0, skipped: 0 };
  let cursor = Number.isInteger(state.eventsCursor) ? state.eventsCursor : 0;
  let backingChecked = false;
  try {
    for (;;) {
      const page = await api.readIntegrationEvents(token, cursor);
      if (!page.events.length) break;
      if (!backingChecked) {
        await claimServerWork(token);
        backingChecked = true;
      }
      for (const event of page.events) {
        try {
          counts[await applyIntegrationEvent(event)]++;
        } catch {
          // A write her records refuse (a validation rule) must not stop every later
          // event: the cursor moves on, and the event counts as skipped.
          counts.skipped++;
        }
        cursor = event.seq;
        updateIntegrationsState({ eventsCursor: cursor });
      }
      if (!page.more) break;
    }
    updateIntegrationsState({ lastError: null });
  } catch (err) {
    updateIntegrationsState({ lastError: errorCode(err) });
    throw err;
  }
  return counts;
}

// The first read on an app open: a device that knows of no connection asks the
// server for the account's connections first (one request; none when signed out),
// then reads events as usual. → what syncIntegrationEvents returns.
export async function syncOnOpen() {
  if (!offered() || !sessionToken()) return null;
  if (!(getIntegrationsState().connections > 0)) await refreshConnections().catch(() => {});
  return syncIntegrationEvents();
}

// Started once per page (cloudBackupUI.bootCloud): shortly after load (syncOnOpen),
// then every INTEGRATIONS_POLL_MS while the app is in front, and when back online.
// Past the open's one check, nothing is asked while the account has no connection.
export function startIntegrationsScheduler({ win = globalThis } = {}) {
  if (!offered()) return () => {};
  const visible = () => win.document?.visibilityState !== 'hidden';
  const tick = () => {
    if (!visible()) return;
    syncIntegrationEvents().catch(() => {});
  };
  const first = setTimeout(() => { if (visible()) syncOnOpen().catch(() => {}); }, 3000);
  const every = setInterval(tick, INTEGRATIONS_POLL_MS);
  win.addEventListener?.('online', tick);
  return () => { clearTimeout(first); clearInterval(every); win.removeEventListener?.('online', tick); };
}
