// vaultPasskey.js — the browser half of unlocking the private vault with a
// passkey (Private Vault Plan §5.2): WebAuthn with the PRF extension. No db, no
// network, no settings; cloudVault.js turns what this returns into a KEK.
//
// The passkey is NOT used to sign in, and nothing here is an authentication:
// the server never verifies an assertion. A passkey only gives back a 32-byte
// PRF output for a stored salt, the same bytes every time for the same passkey
// and salt, and that output (through HKDF, vaultCrypto.kekFromPrf) opens the
// passkey's wrap of the vault key. So the challenges are random and local, and
// no WebAuthn library is needed.
//
// RP ID `kennelos.app` on kennelos.app and its subdomains (§10 decision 5), so a
// passkey made in Lite also works in Pro; any other host (localhost, a preview
// origin) uses its own hostname.
//
// Errors: PasskeyError, code
//   'unsupported' — no WebAuthn here, or this passkey/browser can't do PRF;
//   'cancelled'   — the user closed the sheet, or no matching passkey is on
//                   this device (browsers don't say which, by design);
//   'exists'      — this authenticator already holds a passkey for this vault.

const PARENT_DOMAIN = 'kennelos.app';

export class PasskeyError extends Error {
  constructor(code, message) {
    super(message || `Passkey: ${code}.`);
    this.name = 'PasskeyError';
    this.code = code;
  }
}

export function passkeyRpId(hostname = globalThis.location?.hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === PARENT_DOMAIN || host.endsWith(`.${PARENT_DOMAIN}`) ? PARENT_DOMAIN : host;
}

// --- bytes <-> base64url (credential ids, as WebAuthn's evalByCredential keys them)
export function toBase64Url(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(b64url) {
  const s = atob(String(b64url).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function fromBase64(b64) {
  const s = atob(String(b64));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const credentials = () => globalThis.navigator?.credentials;

// Can this browser try? True when WebAuthn is here and the browser doesn't
// say PRF is missing. Many browsers can't tell until a passkey exists, so a
// "true" can still end in 'unsupported' when one is made (then nothing is
// saved). The recovery code is always required, so nobody depends on this.
export async function passkeySupported() {
  if (globalThis.isSecureContext === false) return false;
  const PKC = globalThis.PublicKeyCredential;
  if (!PKC || typeof credentials()?.create !== 'function') return false;
  try {
    const caps = await PKC.getClientCapabilities?.();
    if (caps && caps['extension:prf'] === false) return false;
  } catch { /* not implemented: try it */ }
  return true;
}

function mapError(err) {
  if (err instanceof PasskeyError) return err;
  switch (err?.name) {
    case 'NotAllowedError':
    case 'AbortError': return new PasskeyError('cancelled', 'The passkey was cancelled, or none for this account is on this device.');
    case 'InvalidStateError': return new PasskeyError('exists', 'This device already has a passkey for your private backup.');
    default: return new PasskeyError('unsupported', 'Passkeys can\'t unlock private backup on this browser.');
  }
}

const prfFirst = (cred) => {
  const first = cred?.getClientExtensionResults?.()?.prf?.results?.first;
  return first ? new Uint8Array(first) : null;
};

// Asks for a passkey and its PRF output. `allow` is [{ credentialId, prfSalt }]
// (base64url id, base64 salt). → { credentialId, prfOutput (Uint8Array) }
export async function getPrfOutput(allow, { rpId = passkeyRpId() } = {}) {
  if (!allow?.length) throw new PasskeyError('cancelled', 'No passkey is set up for your private backup.');
  if (typeof credentials()?.get !== 'function') throw new PasskeyError('unsupported');
  const evalByCredential = {};
  for (const a of allow) evalByCredential[a.credentialId] = { first: fromBase64(a.prfSalt) };
  let cred;
  try {
    cred = await credentials().get({
      publicKey: {
        rpId,
        challenge: randomBytes(32),
        allowCredentials: allow.map((a) => ({ type: 'public-key', id: fromBase64Url(a.credentialId) })),
        userVerification: 'required',
        timeout: 120000,
        extensions: { prf: { evalByCredential } }
      }
    });
  } catch (err) { throw mapError(err); }
  if (!cred) throw new PasskeyError('cancelled');
  const prfOutput = prfFirst(cred);
  if (!prfOutput) throw new PasskeyError('unsupported', 'That passkey can\'t unlock private backup on this browser.');
  return { credentialId: toBase64Url(cred.rawId), prfOutput };
}

// Makes a new passkey for the vault and returns its PRF output for `prfSalt`.
// `exclude` is the credential ids already on the vault, so an authenticator that
// holds one (a synced keychain) says 'exists' instead of making a duplicate.
// → { credentialId, prfOutput }
export async function createPasskey({ userId, userName, prfSalt, exclude = [], rpId = passkeyRpId() }) {
  if (!(await passkeySupported())) throw new PasskeyError('unsupported');
  const salt = fromBase64(prfSalt);
  let cred;
  try {
    cred = await credentials().create({
      publicKey: {
        rp: { id: rpId, name: 'KennelOS' },
        user: { id: new TextEncoder().encode(String(userId)).slice(0, 64), name: userName || 'KennelOS', displayName: userName || 'KennelOS' },
        challenge: randomBytes(32),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        excludeCredentials: exclude.map((id) => ({ type: 'public-key', id: fromBase64Url(id) })),
        timeout: 120000,
        extensions: { prf: { eval: { first: salt } } }
      }
    });
  } catch (err) { throw mapError(err); }
  if (!cred) throw new PasskeyError('cancelled');
  const credentialId = toBase64Url(cred.rawId);
  const prf = cred.getClientExtensionResults?.()?.prf;
  if (!prf?.enabled && !prf?.results?.first) {
    forgetPasskey(credentialId, rpId);
    throw new PasskeyError('unsupported', 'This passkey can\'t unlock private backup. Your recovery code still works.');
  }
  // Some authenticators only report PRF support at creation; the output then
  // takes one more touch.
  const now = prfFirst(cred);
  if (now) return { credentialId, prfOutput: now };
  try {
    const { prfOutput } = await getPrfOutput([{ credentialId, prfSalt }], { rpId });
    return { credentialId, prfOutput };
  } catch (err) {
    forgetPasskey(credentialId, rpId);
    throw err;
  }
}

// A passkey made but never saved (or removed from the vault) is useless; where
// the browser supports it, tell the password manager so it can drop it.
export function forgetPasskey(credentialId, rpId = passkeyRpId()) {
  try {
    globalThis.PublicKeyCredential?.signalUnknownCredential?.({ rpId, credentialId })?.catch?.(() => {});
  } catch { /* best effort */ }
}
