// cloudConfig.js — is there a cloud server for this edition, and where?
// (Cloud Phase 1 plan §3.1, §7). EVERY other cloud module and cloud UI checks
// isCloudAvailable() first, so `cloudUrl: null` (the shared default, Demo, and
// any "we stopped hosting" release) behaves exactly like the app before cloud
// backup existed: no request, no cloud wording.
//
// The URL comes from editionConfig: `cloudUrl` on a deployed origin, and the
// `devCloudUrl` override only when the page is served from localhost/127.0.0.1
// (a dev build pointed at the staging Worker).
import { cloudUrl, devCloudUrl } from '../editionConfig.js';

function isLocalDev() {
  const host = globalThis.location?.hostname;
  return host === 'localhost' || host === '127.0.0.1';
}

// The API base URL without a trailing slash, or null when there's no server.
export function cloudBaseUrl() {
  const url = (isLocalDev() && devCloudUrl) || cloudUrl || null;
  return url ? String(url).replace(/\/+$/, '') : null;
}

export function isCloudAvailable() {
  return cloudBaseUrl() !== null;
}
