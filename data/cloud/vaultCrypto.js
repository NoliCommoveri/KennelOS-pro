// vaultCrypto.js — the private vault's cryptography (Private Vault Plan §3.2, §4,
// §5). Pure WebCrypto: no db, no network, no settings. Every function here runs
// the same in the browser and in Node's test runner.
//
// The vault key is one random AES-GCM-256 key per program. The server only ever
// holds WRAPS of it (the raw key encrypted under a key-encryption key, KEK), one
// per unlock path:
//   recovery — KEK from the 120-bit recovery code (HKDF; high entropy, so no
//              slow hash);
//   passkey  — KEK from the passkey's WebAuthn PRF output (HKDF);
//   device   — KEK from ECDH P-256 between the new device and an approver's
//              ephemeral key, salted with the 12-character code the user types
//              on the approver (§5.3), so a server that swaps a public key in
//              still can't open what it relays.
//   handoff  — KEK from a one-hour, 120-bit code an unlocked device makes and
//              the owner pastes into another (§5.4); a second HKDF output, the
//              proof, lets the server hand the wrap over without opening it.
//
// Every wrap and every ciphertext is bound to the vault's `keyId` (AES-GCM
// additional data), so a wrap or payload made under a replaced key fails to
// open rather than opening as something else.
//
// Ciphertext layout (payloads and files alike), one byte array:
//   'KVLT' | version (1 byte) | keyId (16 bytes) | iv (12 bytes) | AES-GCM ciphertext+tag
// The 33-byte header is the additional data, so none of it can be altered.

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();

export const VAULT_FORMAT = 1;
const MAGIC = [0x4b, 0x56, 0x4c, 0x54]; // 'KVLT'
const KEY_ID_BYTES = 16;
const IV_BYTES = 12;
const HEADER_BYTES = MAGIC.length + 1 + KEY_ID_BYTES + IV_BYTES;

// Thrown when a code, passkey output, pairing or ciphertext doesn't open: the
// wrong secret, a stale key, or tampered bytes. Callers show "That code didn't
// work"; they never learn which.
export class VaultLockedError extends Error {
  constructor(message = 'The vault could not be opened with that key.') {
    super(message);
    this.name = 'VaultLockedError';
  }
}

// --- bytes <-> text ----------------------------------------------------------
export function toBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64) {
  const s = atob(String(b64));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const toHex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

function fromHex(hex) {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) throw new TypeError('bad hex');
  return new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
}

const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

export async function sha256Hex(bytes) {
  return toHex(await subtle().digest('SHA-256', bytes));
}

// --- Codes: Crockford base32 -------------------------------------------------
// 32 symbols, no I/L/O/U. Typing is forgiving: case, spaces and dashes are
// ignored, and O/I/L read as 0/1/1.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const RECOVERY_CODE_LENGTH = 24; // 120 bits
export const PAIRING_CODE_LENGTH = 12;  // 60 bits (§5.3)

function randomCode(length) {
  // 256 is a multiple of 32, so `byte & 31` is uniform.
  return [...randomBytes(length)].map((b) => ALPHABET[b & 31]).join('');
}

// Normalizes a typed code; returns null if it isn't `length` valid symbols.
export function normalizeCode(raw, length) {
  const s = String(raw ?? '').toUpperCase().replace(/[\s-]/g, '')
    .replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== length || [...s].some((c) => !ALPHABET.includes(c))) return null;
  return s;
}

// 'ABCD-EFGH-…' for display and print.
export const formatCode = (code) => String(code).match(/.{1,4}/g).join('-');

export const newRecoveryCode = () => randomCode(RECOVERY_CODE_LENGTH);
export const newPairingCode = () => randomCode(PAIRING_CODE_LENGTH);
export const normalizeRecoveryCode = (raw) => normalizeCode(raw, RECOVERY_CODE_LENGTH);
export const normalizePairingCode = (raw) => normalizeCode(raw, PAIRING_CODE_LENGTH);
// Handoff codes (§5.4) are the recovery code's length: 120 bits.
export const newHandoffCode = () => randomCode(RECOVERY_CODE_LENGTH);

// --- The vault key -------------------------------------------------------------
// Extractable: wrapping it for another unlock path needs the raw bytes (§3.3).
export async function generateVaultKey() {
  const key = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  return { key, keyId: toHex(randomBytes(KEY_ID_BYTES)) };
}

function checkKeyId(keyId) {
  if (typeof keyId !== 'string' || !/^[0-9a-f]{32}$/.test(keyId)) throw new TypeError('bad keyId');
  return keyId;
}

// --- KEKs ----------------------------------------------------------------------
async function hkdfKey(ikm, salt, info, usages) {
  const base = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) },
    base, { name: 'AES-GCM', length: 256 }, false, usages
  );
}

const KEK_USAGES = ['wrapKey', 'unwrapKey'];

export async function kekFromRecoveryCode(code) {
  const c = normalizeRecoveryCode(code);
  if (!c) throw new VaultLockedError('That recovery code is not the right length.');
  return hkdfKey(enc.encode(c), enc.encode('kennelos-vault'), 'kennelos-vault/recovery/v1', KEK_USAGES);
}

// `prfOutput` is the 32-byte result of the passkey's PRF extension for the
// wrap's stored salt.
export async function kekFromPrf(prfOutput) {
  const bytes = new Uint8Array(prfOutput);
  if (bytes.length < 32) throw new VaultLockedError('The passkey did not return a usable key.');
  return hkdfKey(bytes, enc.encode('kennelos-vault'), 'kennelos-vault/passkey/v1', KEK_USAGES);
}

// --- Handoff codes (§5.4) -----------------------------------------------------------
// Two independent outputs of one code: the KEK (never leaves the device) and the
// proof (sent to the server, which stores only its SHA-256 and returns the wrap
// to whoever shows it). Different HKDF `info`, so the proof says nothing about
// the KEK.
export async function kekFromHandoffCode(code) {
  const c = normalizeRecoveryCode(code);
  if (!c) throw new VaultLockedError('That code is not the right length.');
  return hkdfKey(enc.encode(c), enc.encode('kennelos-vault'), 'kennelos-vault/handoff/v1', KEK_USAGES);
}

export async function handoffProof(code) {
  const c = normalizeRecoveryCode(code);
  if (!c) throw new VaultLockedError('That code is not the right length.');
  const base = await subtle().importKey('raw', enc.encode(c), 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('kennelos-vault'), info: enc.encode('kennelos-vault/handoff-proof/v1') },
    base, 256
  );
  return toHex(new Uint8Array(bits));
}

// A fresh random PRF salt for a new passkey wrap (stored beside it; not secret).
export const newPrfSalt = () => toBase64(randomBytes(32));

// --- Device pairing (§5.3) -------------------------------------------------------
export async function generatePairingKeyPair() {
  return subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

export async function exportPublicKey(publicKey) {
  return toBase64(await subtle().exportKey('raw', publicKey));
}

async function importPublicKey(b64) {
  try {
    return await subtle().importKey('raw', fromBase64(b64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  } catch {
    throw new VaultLockedError('The other device sent an unreadable key.');
  }
}

// Both sides call this: the new device with its own private key and the
// approver's public key, the approver with its ephemeral private key and the
// new device's public key. The typed code is the HKDF salt.
export async function kekFromPairing(privateKey, peerPublicKeyB64, code) {
  const c = normalizePairingCode(code);
  if (!c) throw new VaultLockedError('That code is not the right length.');
  const peer = await importPublicKey(peerPublicKeyB64);
  const shared = await subtle().deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  return hkdfKey(shared, enc.encode(c), 'kennelos-vault/pairing/v1', KEK_USAGES);
}

// --- Wrapping the vault key --------------------------------------------------------
// A wrap is base64(iv | AES-GCM(raw vault key)), with `kind` and keyId as
// additional data so a wrap can't be replayed as another kind or another key.
const wrapAad = (kind, keyId) => enc.encode(`kennelos-vault/wrap/${kind}/${checkKeyId(keyId)}`);

export async function wrapVaultKey(vaultKey, kek, { keyId, kind }) {
  const iv = randomBytes(IV_BYTES);
  const wrapped = await subtle().wrapKey('raw', vaultKey, kek, { name: 'AES-GCM', iv, additionalData: wrapAad(kind, keyId) });
  const out = new Uint8Array(IV_BYTES + wrapped.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(wrapped), IV_BYTES);
  return toBase64(out);
}

export async function unwrapVaultKey(wrappedB64, kek, { keyId, kind }) {
  let bytes;
  try { bytes = fromBase64(wrappedB64); } catch { throw new VaultLockedError(); }
  if (bytes.length <= IV_BYTES) throw new VaultLockedError();
  try {
    return await subtle().unwrapKey(
      'raw', bytes.subarray(IV_BYTES), kek,
      { name: 'AES-GCM', iv: bytes.subarray(0, IV_BYTES), additionalData: wrapAad(kind, keyId) },
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
    );
  } catch {
    throw new VaultLockedError();
  }
}

// --- Ciphertext ------------------------------------------------------------------------
function header(keyId, iv) {
  const h = new Uint8Array(HEADER_BYTES);
  h.set(MAGIC, 0);
  h[MAGIC.length] = VAULT_FORMAT;
  h.set(fromHex(checkKeyId(keyId)), MAGIC.length + 1);
  h.set(iv, MAGIC.length + 1 + KEY_ID_BYTES);
  return h;
}

// Reads the header without decrypting: { version, keyId }, or null if these
// aren't vault bytes. Lets a restore say "made under an older key" up front.
export function readVaultHeader(bytes) {
  const u8 = new Uint8Array(bytes);
  if (u8.length < HEADER_BYTES || MAGIC.some((b, i) => u8[i] !== b)) return null;
  return {
    version: u8[MAGIC.length],
    keyId: toHex(u8.subarray(MAGIC.length + 1, MAGIC.length + 1 + KEY_ID_BYTES))
  };
}

async function sealWith(aesKey, keyId, iv, plaintext) {
  const h = header(keyId, iv);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: h }, aesKey, plaintext);
  const out = new Uint8Array(HEADER_BYTES + ct.byteLength);
  out.set(h, 0);
  out.set(new Uint8Array(ct), HEADER_BYTES);
  return out;
}

async function openWith(aesKey, keyId, bytes) {
  const u8 = new Uint8Array(bytes);
  const head = readVaultHeader(u8);
  if (!head || head.version !== VAULT_FORMAT || head.keyId !== checkKeyId(keyId)) throw new VaultLockedError();
  const h = u8.subarray(0, HEADER_BYTES);
  const iv = u8.subarray(HEADER_BYTES - IV_BYTES, HEADER_BYTES);
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: h }, aesKey, u8.subarray(HEADER_BYTES)));
  } catch {
    throw new VaultLockedError();
  }
}

// The vault payload (§4.1): bytes in (the caller gzips the JSON), bytes out.
// A fresh random IV every time.
export function encryptPayload(vaultKey, keyId, plaintext) {
  return sealWith(vaultKey, keyId, randomBytes(IV_BYTES), plaintext);
}

export function decryptPayload(vaultKey, keyId, bytes) {
  return openWith(vaultKey, keyId, bytes);
}

// --- Private files: deterministic (§4.2) ---------------------------------------------------
// Same file + same vault key → the same ciphertext, so the content-addressed
// /files upload (keyed by the ciphertext's sha256) dedups and an unchanged
// document is never re-sent. The IV is HMAC(ivKey, plaintext sha256), so it
// repeats only for identical plaintext, never across different files. Both
// subkeys come from the vault key by HKDF, separate from the payload key use.
async function fileKeys(vaultKey) {
  const raw = await subtle().exportKey('raw', vaultKey);
  const base = await subtle().importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  const params = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('kennelos-vault'), info: enc.encode(info) });
  const [encKey, ivKey] = await Promise.all([
    subtle().deriveKey(params('kennelos-vault/files/enc/v1'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
    subtle().deriveKey(params('kennelos-vault/files/iv/v1'), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'])
  ]);
  return { encKey, ivKey };
}

// Returns { bytes, sha256 (of the ciphertext: the /files id), plainSha256 }.
export async function encryptFile(vaultKey, keyId, plaintext) {
  const { encKey, ivKey } = await fileKeys(vaultKey);
  const plainSha256 = await sha256Hex(plaintext);
  const iv = new Uint8Array(await subtle().sign('HMAC', ivKey, fromHex(plainSha256))).subarray(0, IV_BYTES);
  const bytes = await sealWith(encKey, keyId, iv, plaintext);
  return { bytes, sha256: await sha256Hex(bytes), plainSha256 };
}

// Decrypts, and when `plainSha256` is given checks the result against it.
export async function decryptFile(vaultKey, keyId, bytes, { plainSha256 = null } = {}) {
  const { encKey } = await fileKeys(vaultKey);
  const plain = await openWith(encKey, keyId, bytes);
  if (plainSha256 && (await sha256Hex(plain)) !== plainSha256) throw new VaultLockedError('The file did not match its record.');
  return plain;
}
