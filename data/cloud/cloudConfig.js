// cloudConfig.js — is there a cloud server for this edition, and where?
// (Cloud Phase 1 plan §3.1, §7). EVERY other cloud module and cloud UI checks
// isCloudAvailable() first, so `cloudUrl: null` (the shared default, Demo, and
// any "we stopped hosting" release) behaves exactly like the app before cloud
// backup existed: no request, no cloud wording.
//
// The URL comes from editionConfig: `cloudUrl` on a deployed origin, and the
// `devCloudUrl` override (the staging Worker) when the page is served from
// localhost/127.0.0.1, or when this browser has the test-server switch on.
//
// The test-server switch exists so the owner can try cloud backup on the real
// lite./pro. origins with only a browser. Visiting any page with ?cloud=staging
// turns it on for this browser; ?cloud=off turns it off. It does nothing in an
// edition with no devCloudUrl (Demo), and nothing for anyone who never visits
// such a link. It is handled here, as this module loads, because every cloud
// consumer (app.js, Today, Import/Export, onboarding) imports this module first.
import { cloudUrl, devCloudUrl } from '../editionConfig.js';
import {
  isCloudTestServerOn, setCloudTestServer, clearCloudSession, clearCloudBackupState
} from '../settings.js';

function isLocalDev() {
  const host = globalThis.location?.hostname;
  return host === 'localhost' || host === '127.0.0.1';
}

function testServerOn() {
  try { return isCloudTestServerOn(); } catch { return false; }
}

// True when this browser is on a deployed origin but talking to staging, so
// the UI can say so on every page.
export function isUsingTestServer() {
  return !!devCloudUrl && !isLocalDev() && testServerOn();
}

// The API base URL without a trailing slash, or null when there's no server.
export function cloudBaseUrl() {
  const url = ((isLocalDev() || testServerOn()) && devCloudUrl) || cloudUrl || null;
  return url ? String(url).replace(/\/+$/, '') : null;
}

export function isCloudAvailable() {
  return cloudBaseUrl() !== null;
}

// Reads ?cloud=staging / ?cloud=off from `loc` and applies it. A sign-in and
// the backup position belong to one server, so switching server forgets both
// on this device (local only; nothing on either server is touched, and the
// program's records are untouched). The parameter is then removed from the
// address bar so a bookmark or reload doesn't carry it. Returns true if the
// switch changed.
export function applyCloudTestSwitch(loc = globalThis.location, hist = globalThis.history) {
  if (!devCloudUrl || !loc?.search) return false;
  let value;
  try { value = new URLSearchParams(loc.search).get('cloud'); } catch { return false; }
  if (value !== 'staging' && value !== 'off') return false;
  const on = value === 'staging';
  const changed = on !== testServerOn();
  if (changed) {
    setCloudTestServer(on);
    clearCloudSession();
    clearCloudBackupState();
  }
  try {
    const url = new URL(loc.href);
    url.searchParams.delete('cloud');
    hist?.replaceState?.(hist.state, '', url.pathname + url.search + url.hash);
  } catch { /* the switch still applied; only the address bar keeps the parameter */ }
  return changed;
}

try { applyCloudTestSwitch(); } catch (e) { console.warn('KennelOS: cloud test switch', e); }
