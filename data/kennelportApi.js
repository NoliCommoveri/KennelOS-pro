// kennelportApi.js — her KennelPort website (KennelPort plan 5.2, 5.5; End-State
// guide §35): the only module that talks to KennelPort, as
// stripeApi.js is for Stripe (cloudApi.js is the cloud's own).
//
// Straight from her browser to api.kennelport.com with the device's link token in
// an Authorization header (kept in device_secrets, kennelportLinkStore.js). No
// cookies, no referrer. What it sends is what siteExport.js built; what comes back
// is the site's facts and the addresses of its published pages.
//
// The address is editionConfig's `kennelportUrl`, or `devKennelportUrl` (KennelPort
// staging) on localhost and in a browser with the ?cloud=staging test switch on,
// like cloudConfig.js. Both null (Lite, Demo): websiteLinkOffered() is false, so
// nothing about the website shows and no request is made.
//
//   POST   /v1/link    { code, kennel_id, device_label }  → { token, site }
//   GET    /v1/link    (token) → { linked, site, last_bundle_at }
//   DELETE /v1/link    (token) → { linked: false }
//   POST   /v1/bundle  (token, the bundle) → { summary, addresses, site }
//   POST   /v1/portal  (token, the family feed, portalFeed.js) → { received, summary, facts, portal }
import { kennelportUrl, devKennelportUrl, editionFlags } from './editionConfig.js';
import { isCloudTestServerOn } from './settings.js';

function isLocalDev() {
  const host = globalThis.location?.hostname;
  return host === 'localhost' || host === '127.0.0.1';
}
function testServerOn() {
  try { return isCloudTestServerOn(); } catch { return false; }
}

// The API's base address without a trailing slash, or null.
export function kennelportBaseUrl() {
  const url = ((isLocalDev() || testServerOn()) && devKennelportUrl) || kennelportUrl || null;
  return url ? String(url).replace(/\/+$/, '') : null;
}

// Connect website, Update website and the Show on website marks are offered only
// here: Pro (editionFlags.websiteLink) with a KennelPort address.
export function websiteLinkOffered(flags = editionFlags) {
  return flags.websiteLink === true && kennelportBaseUrl() !== null;
}

export class KennelportError extends Error {
  // kind: 'network' (no answer), 'not_linked' (the token was stopped: Unlink in
  // KennelPort, or the site closed), 'refused' (KennelPort said no, with a line to
  // show), 'other'. `code` is KennelPort's error code when it gave one.
  constructor(kind, message, code = null) {
    super(message);
    this.name = 'KennelportError';
    this.kind = kind;
    this.code = code;
  }
}

async function call(method, path, { token = null, body } = {}) {
  const base = kennelportBaseUrl();
  if (!base) throw new KennelportError('other', 'Your website isn\'t available in this edition.');
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer'
    });
  } catch {
    throw new KennelportError('network', 'Couldn\'t reach your website. Check you\'re online, then press it again.');
  }
  let out = null;
  try { out = await res.json(); } catch { out = null; }
  if (res.ok && out) return out;
  const message = String(out?.message || '').slice(0, 300);
  if (res.status === 401 || out?.error === 'not_linked') {
    throw new KennelportError('not_linked', message || 'Your website is no longer linked. Connect it again with a new code from KennelPort Site Manager.', 'not_linked');
  }
  if (res.status === 503) throw new KennelportError('other', message || 'Your website is being updated. Try again in a few minutes.', out?.error || null);
  if (res.status >= 400 && res.status < 500 && message) throw new KennelportError('refused', message, out?.error || null);
  throw new KennelportError('other', message || `KennelPort didn't answer (${res.status}). Try again in a few minutes.`, out?.error || null);
}

// Connect website: the code from KennelPort Site Manager's Link KennelOS.
export const redeemLinkCode = (code, kennelId, deviceLabel) =>
  call('POST', '/v1/link', { body: { code: String(code ?? ''), kennel_id: kennelId, device_label: String(deviceLabel ?? '').slice(0, 60) } });

export const linkStatus = (token) => call('GET', '/v1/link', { token });

export const stopLink = (token) => call('DELETE', '/v1/link', { token });

export const sendBundle = (token, bundle) => call('POST', '/v1/bundle', { token, body: bundle });

// Her puppy portal's family feed (portalFeedSync.js), only to a site whose facts
// say `portal_feed: 1`. Sent on its own, apart from Update website.
export const sendFamilyFeed = (token, feed) => call('POST', '/v1/portal', { token, body: feed });

// Her settings on the website that KennelOS may change (Kels's Update my website):
// `{ kennelos_prices }`, only to a site whose facts list it under `settings`.
export const setSiteSettings = (token, settings) => call('POST', '/v1/settings', { token, body: settings });

// KennelPort Site Manager's "get a link code" page, for Kels's linking steps: the
// manage host beside the API (api.kennelport.com → manage.kennelport.com; staging
// serves both from one address). null where the edition has no KennelPort.
export function kennelportLinkCodeUrl() {
  const base = kennelportBaseUrl();
  return base ? `${base.replace('//api.', '//manage.')}/link-kennelos` : null;
}
