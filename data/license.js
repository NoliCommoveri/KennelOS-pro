// license.js — the Pro edition's license gate (editions plan §Licensing).
//
// Pro is a Lemon Squeezy subscription unlocked by a browser-validated license
// key. There is NO backend of our own — the app is a static, offline-first PWA —
// and Lemon Squeezy's License API is callable straight from the browser: the
// activate/validate endpoints authenticate with the *license key itself* (in the
// request body), not the store's secret API key, so there's nothing to stand up.
//
// This module is the LOGIC (network calls + the offline-grace verdict); the UI
// (activation wall / renewal wall / grace banner) lives in assets/licenseGate.js,
// the way demoMode.js (logic) pairs with app.js's demo banner.
//
// Edition-agnostic like the rest of shared/: the gate is active only when
// editionConfig.editionFlags.licenseGate is true — set ONLY in Pro's config. So
// isLicenseGated() is false in Lite/Demo and this code is inert there (Demo is a
// public read-only showcase and must never be walled; Lite is free).
//
// THE HONEST CAVEAT (plan §"The honest caveat"): this check runs in the buyer's
// browser, so a technical person could bypass it. The audience is dog breeders,
// not crackers — the key stops ~99%, and the sub really pays for updates + hosting
// off their plate. This pairs with the absence model: Lite (where feature-hacking
// pressure is highest) is protected by the Pro code genuinely not being there;
// Pro leans on the key.
import { editionFlags, licenseConfig } from './editionConfig.js';
import { getProLicense, setProLicense, clearProLicense } from './settings.js';

// Lemon Squeezy License API base. Fixed (not store-specific — the key identifies
// the store), so it's a constant here rather than edition config.
const API = 'https://api.lemonsqueezy.com/v1';

// Grace window scales with the billing interval (plan §Licensing): a once-a-year
// renewal warrants a longer buffer so a breeder off the grid for a week keeps Pro;
// a monthly cycle renews 12× as often, so a proportionally shorter buffer keeps the
// "don't lock me out for a blip" spirit without swallowing a chunk of the period.
// Unknown interval defaults to the shorter one.
const DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_MS = { yearly: 7 * DAY_MS, monthly: 3 * DAY_MS };
const graceFor = (record) => (record?.interval === 'yearly' ? GRACE_MS.yearly : GRACE_MS.monthly);

// True only in the Pro edition (its editionConfig sets editionFlags.licenseGate).
export const isLicenseGated = () => Boolean(editionFlags.licenseGate);

// Lemon Squeezy returns the variant NAME, not a clean interval field, so we infer
// the interval from it against configurable patterns (licenseConfig carries them so
// they can be tuned to the store's actual variant names without a code change):
//   • lifetime  — a one-time, PERPETUAL purchase (no subscription, no expiry). Its
//                 verdict never expires and it's exempt from the offline re-validation
//                 requirement below, because there's no subscription that could lapse.
//   • yearly    — annual subscription (longer grace window).
//   • monthly   — the fallback for anything not clearly lifetime or yearly, and the
//                 shorter/stricter grace window, per the plan's "unknown → shorter" rule.
// Lifetime is checked first so a hypothetical "lifetime annual"-style name can't be
// misread as a renewing yearly sub.
export function detectInterval(variantName) {
  const lifetimePattern = licenseConfig?.lifetimeVariantPattern || 'lifetime|perpetual';
  const yearlyPattern = licenseConfig?.yearlyVariantPattern || 'year|annual';
  try {
    if (variantName && new RegExp(lifetimePattern, 'i').test(variantName)) return 'lifetime';
  } catch { /* a bad custom pattern just means "not lifetime" */ }
  try {
    if (variantName && new RegExp(yearlyPattern, 'i').test(variantName)) return 'yearly';
  } catch { /* a bad custom pattern just means "not yearly" */ }
  return 'monthly';
}

// Normalize an activate/validate JSON payload into the cached record shape. Both
// endpoints return the same license_key + meta objects, so one mapper serves both.
function recordFromPayload(key, data, instanceId, instanceName) {
  const lk = data.license_key || {};
  const meta = data.meta || {};
  const variantName = meta.variant_name || '';
  return {
    key,
    instanceId: instanceId || null,
    instanceName: instanceName || null,
    // license_key.status is the authoritative signal: 'active' | 'expired' |
    // 'disabled' | 'inactive'. Fall back to the boolean `valid` if it's missing.
    status: lk.status || (data.valid ? 'active' : 'inactive'),
    expiresAt: lk.expires_at || null, // ISO string or null (null = no set expiry)
    variantName,
    interval: detectInterval(variantName),
    lastValidated: new Date().toISOString(),
  };
}

// A browser POST to the License API. Form-encoded body (what the endpoints expect),
// key in the body — no Authorization header, no store secret.
async function postLicense(path, params) {
  const res = await fetch(`${API}/${path}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

// First-run activation: bind this key to this browser as a Lemon Squeezy
// "instance". Stores and returns the record on success; throws a user-facing
// message on failure (invalid key, activation limit reached, network down).
export async function activate(rawKey) {
  const key = (rawKey || '').trim();
  if (!key) throw new Error('Enter your license key.');
  const instanceName = `KennelOS Pro @ ${location.hostname || 'device'}`;
  let res, data;
  try {
    ({ res, data } = await postLicense('licenses/activate', { license_key: key, instance_name: instanceName }));
  } catch {
    throw new Error("Couldn't reach the licensing server. Check your connection and try again.");
  }
  if (!res.ok || !data.activated) {
    throw new Error(data.error || 'That key could not be activated. Double-check it and try again.');
  }
  return setProLicense(recordFromPayload(key, data, data.instance?.id, instanceName));
}

// Silent re-validation of a stored record. Returns the refreshed (and re-cached)
// record on success, or null on a network/HTTP failure so the caller can fall
// back to the cached verdict (offline-first — don't lock a breeder out on a blip).
export async function validate(record) {
  if (!record?.key) return null;
  let res, data;
  try {
    ({ res, data } = await postLicense('licenses/validate', {
      license_key: record.key,
      ...(record.instanceId ? { instance_id: record.instanceId } : {}),
    }));
  } catch {
    return null; // offline / DNS / CORS blip — keep the cache
  }
  if (!res.ok) return null;
  return setProLicense(recordFromPayload(record.key, data, record.instanceId, record.instanceName));
}

// Forget the cached activation (the "use a different key" action). Does NOT touch
// program data — only the entitlement record. Reset App never calls this.
export function resetLicense() {
  clearProLicense();
}

// The verdict from a record we just validated online: authoritative status +
// expiry, with the grace window applied once the printed expiry passes.
//   'valid' → full access
//   'grace' → access, but show a "renew / reconnect" banner
//   'wall'  → blocked (renewal wall)
export function onlineVerdict(record) {
  if (!record) return 'wall';
  // Perpetual (lifetime) purchase: no subscription, no expiry. Active is full
  // access, full stop; anything else (a refund/chargeback flips the key to
  // disabled/inactive) walls. We never consult expiry or grace for these.
  if (record.interval === 'lifetime') {
    return record.status === 'active' ? 'valid' : 'wall';
  }
  const now = Date.now();
  const exp = record.expiresAt ? Date.parse(record.expiresAt) : null;
  const grace = graceFor(record);
  if (record.status === 'active') {
    if (!exp || now < exp) return 'valid';       // active, not past a set expiry
    return now < exp + grace ? 'grace' : 'wall'; // active but past expiry → grace
  }
  if (record.status === 'expired') {
    return exp && now < exp + grace ? 'grace' : 'wall';
  }
  // 'disabled' / 'inactive' → deliberately revoked; no grace.
  return 'wall';
}

// The verdict when we could NOT validate online (offline, or the request failed),
// decided from the cache alone. Same base status check, but additionally requires
// that we validated recently enough — within the grace window of lastValidated —
// so a cancelled subscription can't ride a stale cached 'active' forever offline.
export function offlineVerdict(record) {
  const base = onlineVerdict(record);
  if (base === 'wall') return 'wall';
  // Perpetual licenses need no periodic re-validation — there's no subscription
  // to lapse, so a lifetime buyer stays licensed offline indefinitely after the
  // one online activation. (The rare refunded-lifetime case is an accepted gap,
  // per the honest caveat — not worth locking every off-grid owner out over.)
  if (record.interval === 'lifetime') return base;
  const since = Date.now() - Date.parse(record.lastValidated || 0);
  if (!Number.isFinite(since) || since > graceFor(record)) return 'wall';
  return base;
}

// Evaluate the current license: read the cache, refresh it online when possible,
// and return the state the gate UI renders from.
//   { state: 'unactivated', record: null }  → no key yet → activation wall
//   { state: 'valid' | 'grace' | 'wall', record }
export async function evaluateLicense() {
  let record = getProLicense();
  if (!record) return { state: 'unactivated', record: null };

  // Re-validate silently when online; honor the cache when not (grace window).
  let refreshed = null;
  if (navigator.onLine !== false) {
    refreshed = await validate(record);
  }
  if (refreshed) {
    record = refreshed;
    return { state: onlineVerdict(record), record };
  }
  return { state: offlineVerdict(record), record };
}
