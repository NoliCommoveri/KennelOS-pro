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
import { getProLicense, setProLicense, clearProLicense, getDeviceId } from './settings.js';

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

// Lifetime check-in (see offlineVerdict). A perpetual key has no expiry to
// measure against, so its offline limit is measured from the last successful
// validate instead: full access for this long, then a banner asking for one
// reconnect, then the wall.
//
// Deliberately generous — 4 months from the last time the app saw the internet.
// A lifetime key that reaches the wall has lost nothing: one reconnect restores
// it permanently, and the records were never touched.
const LIFETIME_REVALIDATE_MS = 90 * DAY_MS;
const LIFETIME_OFFLINE_GRACE_MS = 30 * DAY_MS;

// True only in the Pro edition (its editionConfig sets editionFlags.licenseGate).
export const isLicenseGated = () => Boolean(editionFlags.licenseGate);

// Lemon Squeezy returns the variant NAME, not a clean interval field, so we infer
// the interval from it against configurable patterns (licenseConfig carries them so
// they can be tuned to the store's actual variant names without a code change):
//   • lifetime  — a one-time, PERPETUAL purchase (no subscription, no expiry). Its
//                 verdict never expires, and it gets a far longer offline check-in
//                 window than a subscription (months, not days — see offlineVerdict)
//                 since there's no billing cycle to police, only a periodic
//                 confirmation that the key itself is still good.
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

// The activation's name in the Lemon Squeezy dashboard — the ONLY thing that
// lets an owner tell their activations apart when they have used their allowance
// and need to release one. So it has to be human-readable AND unique.
//
// It used to be `KennelOS Pro @ ${location.hostname}`, which is the *app's*
// origin, not anything about the buyer — the identical string for every buyer on
// every device, so a dashboard full of them named nothing and "which one do I
// release?" had no answer. Now it's the owner's own label plus a short slice of
// this browser's random device id (settings.js) to keep two devices the owner
// called the same thing distinguishable.
//
// Pure and parameterized so the naming rule is testable without a browser; the
// id is read from settings at the one call site.
export const DEFAULT_DEVICE_LABEL = 'This browser';

export function buildInstanceName(label, deviceId) {
  const clean = String(label ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const suffix = String(deviceId ?? '').replace(/-/g, '').slice(0, 8);
  const name = clean || DEFAULT_DEVICE_LABEL;
  return suffix ? `${name} · ${suffix}` : name;
}

// Normalize an activate/validate JSON payload into the cached record shape. Both
// endpoints return the same license_key + meta objects, so one mapper serves both.
//
// Exported for tests: it is a pure mapper, and the status rule below is the one
// piece of this module that decides whether a de-authorized device keeps running.
export function recordFromPayload(key, data, instanceId, instanceName) {
  const lk = data.license_key || {};
  const meta = data.meta || {};
  const variantName = meta.variant_name || '';
  // Lemon Squeezy answers two different questions here and they can disagree:
  // `license_key.status` describes the KEY ('active' | 'expired' | 'disabled' |
  // 'inactive'), while `valid` describes THIS activation. Deactivate one instance
  // — the whole point of releasing a seat, and the way a shared device gets cut
  // off — and /validate comes back valid:false while the key stays 'active'.
  // Reading the key alone (as this did) would keep that device running forever.
  //
  // So: an explicit valid:false downgrades an otherwise-'active' key to
  // 'inactive' (revoked → walls immediately, no grace). A key status that is
  // already more specific ('expired') is preserved rather than flattened, because
  // onlineVerdict gives 'expired' its grace window and a lapsed renewal must
  // still get that. `=== false` on purpose: /activate answers with `activated`
  // and carries no `valid` at all, so an absent field never downgrades anything.
  const keyStatus = lk.status || (data.valid ? 'active' : 'inactive');
  const status = data.valid === false && keyStatus === 'active' ? 'inactive' : keyStatus;
  return {
    key,
    instanceId: instanceId || null,
    instanceName: instanceName || null,
    status,
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
// message on failure (invalid key, activation limit reached, network down) —
// Lemon Squeezy's own `error` text is passed straight through, so a key that has
// used every activation says so rather than reading as a bad key.
//
// `deviceLabel` is what the owner typed on the activation wall (optional); it
// names this activation in their store account so they can release it later.
export async function activate(rawKey, deviceLabel) {
  const key = (rawKey || '').trim();
  if (!key) throw new Error('Enter your license key.');
  const instanceName = buildInstanceName(deviceLabel, getDeviceId());
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

// Release this browser's activation on Lemon Squeezy's side, freeing the slot it
// holds against the key's activation limit. Returns true when the slot came back,
// false on any failure (offline, or an instance the store no longer knows about).
// Never throws: every caller is on a path that has to reach an end state anyway,
// and the two callers below want opposite things from a failure.
//
// This is the half that was missing. Nothing in the app released a slot, so every
// cleared browser, reinstalled PWA, and replaced laptop consumed one permanently
// — an owner could reach "no activations left" through ordinary browser hygiene,
// with nothing in the app able to fix it.
export async function deactivate(record) {
  if (!record?.key || !record.instanceId) return false;
  try {
    const { res, data } = await postLicense('licenses/deactivate', {
      license_key: record.key,
      instance_id: record.instanceId,
    });
    return Boolean(res.ok && data.deactivated);
  } catch {
    return false;
  }
}

// The deliberate "I'm done with this device" action (Import/Export → This
// device's license). Releases the slot FIRST and forgets the local record only if
// that succeeded — returning false and changing nothing otherwise. Clearing a
// record whose slot is still held would cost the owner both this device's access
// AND the slot, with no way back to either, which is the exact trap this whole
// change exists to close.
//
// Does NOT touch program data: the kennel stays in IndexedDB, and re-activating
// with the same key picks up right where it left off.
export async function releaseThisDevice() {
  const record = getProLicense();
  if (!(await deactivate(record))) return false;
  clearProLicense();
  return true;
}

// Forget the cached activation so a different key can be entered (the renewal
// wall's "use a different key"). Best-effort release, then clear regardless: the
// owner is already blocked behind a wall here, so a failed release must not trap
// them. Returns whether the slot was actually freed so the caller can say so.
// Reset App never calls this.
export async function resetLicense() {
  const released = await deactivate(getProLicense());
  clearProLicense();
  return released;
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
  const since = Date.now() - Date.parse(record.lastValidated || 0);
  if (!Number.isFinite(since)) return 'wall';
  // Perpetual licenses used to be exempt from this check entirely, which meant a
  // lifetime key activated once could run forever on any number of machines
  // without ever contacting the store again — no expiry to lapse, nothing to
  // re-check, so a refund or a shared key was undetectable after activation. It
  // was the strongest key in the catalogue with the weakest control.
  //
  // They now check in too, on a window measured in months rather than the days a
  // subscription gets: there is still no subscription to lapse, so the goal is
  // only to guarantee the app eventually hears "this key is still good", not to
  // police a billing cycle. A lifetime owner who is simply offline for a season
  // sees a reconnect banner for a further month before anything blocks, and one
  // successful validate resets the clock completely.
  if (record.interval === 'lifetime') {
    if (since <= LIFETIME_REVALIDATE_MS) return base;
    return since <= LIFETIME_REVALIDATE_MS + LIFETIME_OFFLINE_GRACE_MS ? 'grace' : 'wall';
  }
  if (since > graceFor(record)) return 'wall';
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
