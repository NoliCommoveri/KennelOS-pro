// waitlistCrypto.js — her waitlist's form key (Waitlist Spec §8.2; W2 Plan §7).
// Applicants' browsers seal each application to the kennel's current form public
// key (cloud/public/family/seal.js); her device opens it here. No Dexie, no DOM,
// no network.
//
// A form key is { id, public_key (base64 raw P-256), private_key (JWK),
// created_at, retired_at }. The keys live on the kennel record as
// `waitlist_form_keys`, a PRIVATE field (syncRegistry): it rides the private vault
// and file backups, never cloud backup's readable tier. Rotating adds a key and
// retires the old one; old keys are kept so earlier applications still open.
//
// ECDH P-256 with the sender's fresh key pair, HKDF-SHA-256 (salt = the sender's
// public key), AES-GCM-256 with the key id as additional data.
export const SEAL_FORMAT = 1;
const INFO = 'kennelos-waitlist/seal/v1';
const enc = new TextEncoder();
const dec = new TextDecoder();

// In chunks: spreading a long application into one call would exceed argument limits.
function toB64(bytes) {
  const u8 = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const aad = (keyId) => enc.encode(`kennelos-waitlist/v1/${keyId}`);

export class SealError extends Error {}

export async function generateFormKey({ now = new Date() } = {}) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return {
    id: `fk_${crypto.randomUUID()}`,
    public_key: toB64(await crypto.subtle.exportKey('raw', pair.publicKey)),
    private_key: await crypto.subtle.exportKey('jwk', pair.privateKey),
    created_at: now.toISOString(),
    retired_at: null
  };
}

// The key new applications are sealed to: the newest one not retired.
export function currentFormKey(keys) {
  const live = (Array.isArray(keys) ? keys : []).filter((k) => k && !k.retired_at);
  return live.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
}

// Rotate: a new key, every older one retired (kept, so old applications open).
export async function rotateFormKeys(keys, { now = new Date() } = {}) {
  const fresh = await generateFormKey({ now });
  const old = (Array.isArray(keys) ? keys : []).map((k) => (k.retired_at ? k : { ...k, retired_at: now.toISOString() }));
  return [...old, fresh];
}

// Open sealed text with whichever of `keys` it was sealed to. Throws SealError
// when it isn't ours, was tampered with, or isn't a sealed message at all.
export async function openSealed(keys, sealed) {
  let env;
  try { env = JSON.parse(atob(String(sealed))); } catch { throw new SealError('Not a sealed message.'); }
  if (!env || env.v !== SEAL_FORMAT || typeof env.kid !== 'string') throw new SealError('Unknown sealed format.');
  const key = (Array.isArray(keys) ? keys : []).find((k) => k.id === env.kid);
  if (!key) throw new SealError('Sealed to a form key this device doesn\'t have.');
  try {
    const subtle = crypto.subtle;
    const priv = await subtle.importKey('jwk', key.private_key, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const epkBytes = fromB64(env.epk);
    const theirs = await subtle.importKey('raw', epkBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = await subtle.deriveBits({ name: 'ECDH', public: theirs }, priv, 256);
    const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    const aes = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epkBytes, info: enc.encode(INFO) }, hkdf,
      { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(env.iv), additionalData: aad(env.kid) }, aes, fromB64(env.ct));
    return JSON.parse(dec.decode(plain));
  } catch {
    throw new SealError('This message could not be opened (damaged, or not for this key).');
  }
}
