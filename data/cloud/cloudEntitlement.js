// cloudEntitlement.js — is this cloud account Pro on the SERVER? (License Link
// Plan §5, §6). The server learns about Pro purchases from Lemon Squeezy's
// webhook, by the keyed hash of the purchase email; a purchase made with
// another address is linked here, by a code sent to that address.
//
// This gates only what the server does for an account (the waitlist's online
// features). The Pro app itself is still gated by the browser's own license
// check (license.js), with or without a server.
//
// Every entry point checks isCloudAvailable() and the session first, so
// `cloudUrl: null` makes no request. Network only through cloudApi.
import * as api from './cloudApi.js';
import { isCloudAvailable } from './cloudConfig.js';
import { sessionToken } from './cloudAuth.js';

// One read per page view is plenty: it only changes on a purchase, a link, or a
// lapse, and the link flows here refresh it.
export const CACHE_MS = 5 * 60 * 1000;
let cached = null; // { token, at, value }

function requireSession() {
  if (!isCloudAvailable()) throw new api.CloudUnavailableError();
  const token = sessionToken();
  if (!token) throw new api.CloudAuthError({ status: 401, code: 'unauthorized' });
  return token;
}

const remember = (token, value) => { cached = { token, at: Date.now(), value }; return value; };

// → { pro, plan: 'monthly'|'yearly'|'lifetime'|null, until (ISO or null),
//     source: 'email'|'linked'|null, lapsed, linkedEmails }
export async function entitlement({ fresh = false, now = Date.now() } = {}) {
  const token = requireSession();
  if (!fresh && cached && cached.token === token && now - cached.at < CACHE_MS) return cached.value;
  return remember(token, await api.getEntitlement(token));
}

// The last answer for this sign-in, without asking (null if none yet).
export function cachedEntitlement() {
  const token = isCloudAvailable() ? sessionToken() : null;
  return token && cached?.token === token ? cached.value : null;
}

export function forgetEntitlement() { cached = null; }

// Linking, part 1: a code to the purchase email. Throws CloudRequestError
// 'bad_email', 'own_email', 'rate_limited', 'email_unavailable'.
export async function startPurchaseLink(email) {
  const token = requireSession();
  await api.startLicenseLink(token, String(email ?? '').trim());
}

// Linking, part 2 → the new entitlement. 'invalid_code' / 'too_many_attempts'.
export async function finishPurchaseLink(email, code) {
  const token = requireSession();
  return remember(token, await api.verifyLicenseLink(token, { email: String(email ?? '').trim(), code: String(code ?? '').replace(/\s/g, '') }));
}

// Unlinks every extra purchase email. Fresh sign-in: `reauth` = { email, code }
// when this sign-in is older than 15 minutes ('reauth_required').
export async function unlinkPurchaseEmails({ reauth = {} } = {}) {
  const token = requireSession();
  return remember(token, await api.removeLicenseLinks(token, reauth));
}
