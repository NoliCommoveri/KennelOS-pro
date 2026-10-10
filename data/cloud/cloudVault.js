// cloudVault.js — the private vault's flows (Private Vault Plan §2, §3, §5.1):
// turning it on with a recovery code, unlocking a device with that code,
// merging the private tier in after a "Not now" restore, a new recovery code,
// unlocking from another device (§2.4, §5.3), passkeys (§5.2), and turning it
// off.
//
// The cryptography is vaultCrypto.js; the unlocked key lives in vaultKeyStore.js;
// pushing and restoring the encrypted part is cloudBackup.js. Network only
// through cloudApi. Every entry point checks isCloudAvailable() first, so
// `cloudUrl: null` never makes a request.
//
// Errors: the cloudApi errors, plus
//   VaultLockedError (vaultCrypto) — that recovery code (or the code typed on
//     the approving device, or the passkey's output) doesn't open the vault;
//   PasskeyError (vaultPasskey) — 'unsupported', 'cancelled', 'exists';
//   VaultSetupError — code 'confirm_mismatch' (the typed-back group is wrong),
//     'no_vault' (nothing to unlock), 'locked' (this device has no key to
//     re-wrap), 'program_changed' (a draft from another sign-in), 'expired'
//     (an unlock request that timed out or was already answered), 'no_passkey'
//     (no passkey is set up for this vault).
import * as api from './cloudApi.js';
import { isCloudAvailable } from './cloudConfig.js';
import { currentAccount, sessionToken } from './cloudAuth.js';
import {
  getVaultKey, setVaultKey, clearVaultKey, getPendingPairing, setPendingPairing, clearPendingPairing,
  getUnsavedRecoveryCode, setUnsavedRecoveryCode, clearUnsavedRecoveryCode
} from './vaultKeyStore.js';
import {
  generateVaultKey, newRecoveryCode, formatCode, normalizeRecoveryCode,
  kekFromRecoveryCode, wrapVaultKey, unwrapVaultKey,
  newPairingCode, generatePairingKeyPair, exportPublicKey, kekFromPairing,
  kekFromPrf, newPrfSalt, newHandoffCode, kekFromHandoffCode, handoffProof, VaultLockedError
} from './vaultCrypto.js';
import { createPasskey, getPrfOutput, forgetPasskey, passkeySupported } from './vaultPasskey.js';
import { pushIfDirty, restoreSnapshotVault } from './cloudBackup.js';
import { getCloudBackupState, updateCloudBackupState, setCloudRestoredAt } from '../settings.js';

export class VaultSetupError extends Error {
  constructor(code, message) {
    super(message || `Private backup: ${code}.`);
    this.name = 'VaultSetupError';
    this.code = code;
  }
}

function requireSession() {
  if (!isCloudAvailable()) throw new api.CloudUnavailableError();
  const token = sessionToken();
  const programId = currentAccount()?.programId;
  if (!token || !programId) throw new api.CloudAuthError({ status: 401, code: 'unauthorized' });
  return { token, programId };
}

// The vault as this device sees it now, and the pause it may lift.
function recordVaultState(vault) {
  const state = getCloudBackupState();
  const patch = { vault };
  if (vault !== 'locked' && state.lastError?.code === 'vault_locked') patch.lastError = null;
  updateCloudBackupState(patch);
}

// --- Status -------------------------------------------------------------------
// → { enabled, unlocked, keyId, createdAt, recovery: { createdAt } | null,
//     passkeys: [{ id, label, createdAt }], passkeySupported }. Asks the server (one request) and
// records 'on' / 'locked' / 'off' for getBackupStatus(). A key here that the
// server's vault no longer matches (re-keyed elsewhere) is forgotten.
export async function vaultStatus() {
  const { token, programId } = requireSession();
  const v = await api.getVault(token);
  let local = await getVaultKey(programId);
  if (local && (!v.enabled || local.keyId !== v.keyId)) {
    await clearVaultKey();
    local = null;
  }
  recordVaultState(!v.enabled ? 'off' : local ? 'on' : 'locked');
  const wraps = v.wraps || [];
  const recovery = wraps.find((w) => w.kind === 'recovery');
  return {
    enabled: !!v.enabled,
    unlocked: !!local,
    keyId: v.keyId || null,
    createdAt: v.createdAt || null,
    recovery: recovery ? { createdAt: recovery.createdAt } : null,
    passkeys: wraps.filter((w) => w.kind === 'passkey').map((w) => ({ id: w.id, label: w.label, createdAt: w.createdAt })),
    passkeySupported: await passkeySupported()
  };
}

// --- Recovery-code drafts (§2.1 step 2) -------------------------------------------
// The code is shown once; nothing is sent until the user types its last group
// back, so the code can't be skipped. A draft lives only in memory (the UI
// holds it between the two screens).
//   { recoveryCode: 'XXXX-XXXX-…' (to show), lastGroup (what must be typed back), … }
function draft(extra = {}) {
  const code = newRecoveryCode();
  return { code, recoveryCode: formatCode(code), lastGroup: code.slice(-4), ...extra };
}

function checkConfirmation(d, typed) {
  const t = String(typed ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!d || !d.code || t !== d.lastGroup) throw new VaultSetupError('confirm_mismatch', 'That doesn\'t match the end of your recovery code.');
}

// Turning it on, part 1: a new vault key and its recovery code, for this
// signed-in program. Nothing is stored or sent yet.
export async function startVaultSetup() {
  const { programId } = requireSession();
  const vault = await generateVaultKey();
  return draft({ programId, vault });
}

// Turning it on, part 2: `confirmation` is the code's last group, typed back.
// Sends the recovery wrap, keeps the key on this device, and runs the first
// encrypted backup at once (when cloud backup is on). Returns the push result
// (cloudBackup statuses), or { status: 'skipped' } with backup off.
// A 409 'vault_exists' (CloudConflictError) means another device turned it on
// first: unlock with that device's recovery code instead.
export async function finishVaultSetup(setup, { confirmation, onProgress } = {}) {
  const { token, programId } = requireSession();
  checkConfirmation(setup, confirmation);
  if (setup.programId !== programId) throw new VaultSetupError('program_changed');
  const { key, keyId } = setup.vault;
  const kek = await kekFromRecoveryCode(setup.code);
  const recoveryWrap = await wrapVaultKey(key, kek, { keyId, kind: 'recovery' });
  await api.enableVault(token, { keyId, recoveryWrap });
  await setVaultKey(programId, { key, keyId });
  recordVaultState('on');
  if (!getCloudBackupState().enabled) return { status: 'skipped', reason: 'off' };
  return pushIfDirty({ force: true, onProgress });
}

// --- Turning it on with a passkey first (§2.1, decided 2026-10-10) ----------------
// One tap: the passkey prompt turns the vault on. The recovery code is made at
// the same time (the server requires its wrap, so it always exists) but shown
// afterwards: it's kept on this device as "unsaved" until the owner saves it
// (unsavedRecoveryCode / markRecoveryCodeSaved), and Today keeps asking.
// The passkey is made FIRST, before any request, because browsers only allow
// the prompt straight after the tap that started it. Throws PasskeyError
// ('unsupported' → use turnOnVaultFlow's recovery-code screen instead;
// 'cancelled'), and 409 'vault_exists' (CloudConflictError) when another device
// turned it on first. → the push result, as finishVaultSetup.
export async function quickVaultSetup({ label = null, onProgress } = {}) {
  const { token, programId } = requireSession();
  const { key, keyId } = await generateVaultKey();
  const code = newRecoveryCode();
  const prfSalt = newPrfSalt();
  const account = currentAccount();
  const { credentialId, prfOutput } = await createPasskey({ userId: programId, userName: account?.email, prfSalt });
  try {
    const passkeyWrap = await wrapVaultKey(key, await kekFromPrf(prfOutput), { keyId, kind: 'passkey' });
    const recoveryWrap = await wrapVaultKey(key, await kekFromRecoveryCode(code), { keyId, kind: 'recovery' });
    await api.enableVault(token, { keyId, recoveryWrap });
    await setVaultKey(programId, { key, keyId });
    await setUnsavedRecoveryCode(programId, { code, keyId });
    recordVaultState('on');
    await api.addVaultWrap(token, { kind: 'passkey', keyId, wrapped: passkeyWrap, credentialId, prfSalt, label });
  } catch (err) {
    forgetPasskey(credentialId);
    throw err;
  }
  if (!getCloudBackupState().enabled) return { status: 'skipped', reason: 'off' };
  return pushIfDirty({ force: true, onProgress });
}

// The recovery code a passkey-first setup made and the owner hasn't saved yet,
// formatted, or null. A code for a vault this device no longer holds is dropped.
export async function unsavedRecoveryCode() {
  const programId = currentAccount()?.programId;
  const row = await getUnsavedRecoveryCode(programId);
  if (!row) return null;
  const vault = await getVaultKey(programId);
  if (!vault || vault.keyId !== row.keyId) { await clearUnsavedRecoveryCode(); return null; }
  return formatCode(row.code);
}

// `typed` is its last group, typed back (as when turning the vault on with the
// code first). Throws VaultSetupError 'confirm_mismatch'.
export async function markRecoveryCodeSaved(typed) {
  const programId = currentAccount()?.programId;
  const row = await getUnsavedRecoveryCode(programId);
  if (!row) return;
  checkConfirmation({ code: row.code, lastGroup: row.code.slice(-4) }, typed);
  await clearUnsavedRecoveryCode();
}

// --- Unlocking this device (§2.3, §5.1) -------------------------------------------
// Opens the vault with the recovery code and keeps the key here. Then, unless
// `merge: false`, merges the latest backup's private tier in (the "Not now,
// unlock later" path; a restore that runs after this unlock merges it itself).
// Throws VaultLockedError for a code that doesn't open it, and
// VaultSetupError 'no_vault' when the program has no vault.
// → { merged: restoreSnapshotVault's result | null }
export async function unlockWithRecoveryCode(rawCode, { merge = true, onProgress } = {}) {
  const { token, programId } = requireSession();
  const code = normalizeRecoveryCode(rawCode);
  const kek = await kekFromRecoveryCode(code ?? rawCode); // a malformed code throws VaultLockedError here
  const v = await api.getVault(token);
  if (!v.enabled) throw new VaultSetupError('no_vault', 'Private backup isn\'t turned on for this account.');
  const recovery = (v.wraps || []).find((w) => w.kind === 'recovery');
  if (!recovery) throw new VaultSetupError('no_vault');
  const wrap = await api.getVaultWrap(token, recovery.id);
  const key = await unwrapVaultKey(wrap.wrapped, kek, { keyId: v.keyId, kind: 'recovery' });
  await setVaultKey(programId, { key, keyId: v.keyId });
  recordVaultState('on');
  return { merged: merge ? await mergeLatestVault({ onProgress }) : null };
}

// The latest backup's private tier, merged into this device (newer wins, blank
// private fields filled; importExport 'vault-merge'). null when there is no
// backup yet.
export async function mergeLatestVault({ onProgress } = {}) {
  const { token } = requireSession();
  const program = await api.getProgram(token);
  if (!program.latestSnapshotId) return null;
  const r = await restoreSnapshotVault(program.latestSnapshotId, { overwrite: false, onProgress });
  if (r.status === 'restored') setCloudRestoredAt(null); // private details are back: no "blank here" hint
  return r;
}

// --- Handoff codes (§5.4) ------------------------------------------------------------
// The reverse of a device unlock, for a device that's being left behind (Lite,
// upgrading to Pro on the same phone or another): this unlocked device makes a
// code that works once, for an hour, and the owner pastes it into the other
// device after signing in there. A new code replaces this device's last one.
// → { code: 'XXXX-XXXX-…', expiresAt }. VaultSetupError 'locked' when this
// device can't open the vault itself.
export async function createHandoffCode() {
  const { token, programId } = requireSession();
  const vault = await getVaultKey(programId);
  if (!vault) throw new VaultSetupError('locked');
  const code = newHandoffCode();
  const wrapped = await wrapVaultKey(vault.key, await kekFromHandoffCode(code), { keyId: vault.keyId, kind: 'handoff' });
  const { expiresAt } = await api.createHandoff(token, { keyId: vault.keyId, wrapped, proof: await handoffProof(code) });
  return { code: formatCode(code), expiresAt };
}

// Unlock this device with a handoff code. A 24-character code that isn't a
// live handoff is tried as the recovery code (same length), so whichever one
// the owner pastes works. Throws VaultLockedError when neither opens it.
// → { merged } as for unlockWithRecoveryCode.
export async function unlockWithHandoffCode(rawCode, { merge = true, onProgress } = {}) {
  const { token, programId } = requireSession();
  const code = normalizeRecoveryCode(rawCode);
  if (!code) throw new VaultLockedError('That code is not the right length.');
  let h;
  try {
    h = await api.redeemHandoff(token, await handoffProof(code));
  } catch (err) {
    if (err instanceof api.CloudRequestError && err.code === 'not_found') return unlockWithRecoveryCode(code, { merge, onProgress });
    if (err instanceof api.CloudRequestError && err.code === 'no_vault') throw new VaultSetupError('no_vault');
    throw err;
  }
  const key = await unwrapVaultKey(h.wrapped, await kekFromHandoffCode(code), { keyId: h.keyId, kind: 'handoff' });
  await setVaultKey(programId, { key, keyId: h.keyId });
  recordVaultState('on');
  return { merged: merge ? await mergeLatestVault({ onProgress }) : null };
}

// --- Unlocking from another device (§2.4, §5.3) --------------------------------------
// The server relays but can't open what it relays: the new device sends only an
// ECDH public key; the approver wraps the vault key under a KEK from ECDH and
// the 12-character code the user reads off the new device and types on the
// approver. The approver can't check the code; a wrong one shows up on the new
// device as VaultLockedError, and it asks again.

// New device, part 1: ask. Shows `code` (formatted) until answered or expired.
// The request is kept in device_secrets, so a reload doesn't lose it
// (pendingDeviceUnlock). → { pairingId, code, expiresAt }
export async function requestDeviceUnlock({ label = null } = {}) {
  const { token, programId } = requireSession();
  const pair = await generatePairingKeyPair();
  const code = newPairingCode();
  const { pairingId, expiresAt } = await api.createPairing(token, { publicKey: await exportPublicKey(pair.publicKey), label });
  await setPendingPairing(programId, { pairingId, privateKey: pair.privateKey, code, expiresAt });
  return { pairingId, code: formatCode(code), expiresAt };
}

// The open request on this device, for a page that (re)opens mid-wait; null
// when there is none or it has expired (and then it's forgotten).
export async function pendingDeviceUnlock({ now = Date.now() } = {}) {
  const { programId } = requireSession();
  const p = await getPendingPairing(programId);
  if (!p) return null;
  if (Date.parse(p.expiresAt) <= now) { await clearPendingPairing(); return null; }
  return { pairingId: p.pairingId, code: formatCode(p.code), expiresAt: p.expiresAt };
}

// New device, part 2: one poll. → { status: 'waiting', expiresAt } or
// { status: 'unlocked', merged } (merged as for unlockWithRecoveryCode, unless
// `merge: false`). Throws VaultSetupError 'expired' when the request is gone
// (timed out, or none open), and VaultLockedError when the approver typed the
// wrong code: either way the request is over, so ask again.
export async function pollDeviceUnlock({ merge = true, onProgress } = {}) {
  const { token, programId } = requireSession();
  const p = await getPendingPairing(programId);
  if (!p) throw new VaultSetupError('expired', 'That request has expired. Ask again.');
  let answer;
  try {
    answer = await api.pollPairing(token, p.pairingId);
  } catch (err) {
    if (err instanceof api.CloudRequestError && err.status === 404) {
      await clearPendingPairing();
      throw new VaultSetupError('expired', 'That request has expired. Ask again.');
    }
    throw err;
  }
  if (answer.status !== 'approved') return { status: 'waiting', expiresAt: answer.expiresAt };
  await clearPendingPairing(); // the server deleted it as it answered: one try
  const kek = await kekFromPairing(p.privateKey, answer.approverKey, p.code);
  const key = await unwrapVaultKey(answer.wrapped, kek, { keyId: answer.keyId, kind: 'device' });
  await setVaultKey(programId, { key, keyId: answer.keyId });
  recordVaultState('on');
  return { status: 'unlocked', merged: merge ? await mergeLatestVault({ onProgress }) : null };
}

// New device: poll until unlocked, expired, or `signal` aborts (→ { status:
// 'cancelled' }; the request stays open until it expires). `onWaiting` is
// called (and awaited) after each waiting poll.
export const POLL_INTERVAL_MS = 3000;
export async function waitForDeviceUnlock({ intervalMs = POLL_INTERVAL_MS, signal = null, merge = true, onProgress, onWaiting } = {}) {
  for (;;) {
    if (signal?.aborted) return { status: 'cancelled' };
    const r = await pollDeviceUnlock({ merge, onProgress });
    if (r.status === 'unlocked') return r;
    try { await onWaiting?.(r); } catch { /* UI only */ }
    await new Promise((resolve) => {
      const t = setTimeout(resolve, intervalMs);
      signal?.addEventListener?.('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
}

// New device: give up on the open request here (it expires on the server).
export async function cancelDeviceUnlock() {
  await clearPendingPairing();
}

// Unlocked device, part 1: the requests waiting for approval (not this
// device's own). → [{ id, deviceLabel, createdAt, expiresAt, publicKey }]
export async function listUnlockRequests() {
  const { token } = requireSession();
  return (await api.listPairings(token)).pairings || [];
}

// Unlocked device, part 2: approve one with the code shown on the new device.
// Throws VaultLockedError for a code of the wrong shape (before anything is
// sent), VaultSetupError 'locked' when this device can't open the vault itself,
// 'expired' when the request is gone, and CloudConflictError 'already_approved'.
export async function approveDeviceUnlock(request, typedCode) {
  const { token, programId } = requireSession();
  const vault = await getVaultKey(programId);
  if (!vault) throw new VaultSetupError('locked', 'Unlock your private info on this device first.');
  const ephemeral = await generatePairingKeyPair();
  const kek = await kekFromPairing(ephemeral.privateKey, request.publicKey, typedCode);
  const wrapped = await wrapVaultKey(vault.key, kek, { keyId: vault.keyId, kind: 'device' });
  try {
    await api.approvePairing(token, request.id, { approverKey: await exportPublicKey(ephemeral.publicKey), wrapped, keyId: vault.keyId });
  } catch (err) {
    if (err instanceof api.CloudRequestError && err.status === 404) throw new VaultSetupError('expired', 'That request has expired.');
    throw err;
  }
}

// --- Passkeys (§5.2) ----------------------------------------------------------------
// A passkey is a second way to unlock (the recovery code stays required). It
// never signs in: its PRF output for a per-passkey random salt is the KEK of
// its own wrap. The server keeps the credential id and salt (public by design)
// beside the wrap and never verifies anything.

// Adds a passkey on this (unlocked) device. `label` names it in the list
// ("Passkey on Phone A"). Throws PasskeyError ('unsupported' when this
// passkey can't do PRF: nothing is saved), VaultSetupError 'locked', and the
// server's 'too_many_passkeys' (CloudRequestError) / 'vault_key_stale'.
// → { id }
export async function addPasskey({ label = null } = {}) {
  const { token, programId } = requireSession();
  const vault = await getVaultKey(programId);
  if (!vault) throw new VaultSetupError('locked', 'Unlock your private info on this device first.');
  const v = await api.getVault(token);
  const existing = (v.wraps || []).filter((w) => w.kind === 'passkey' && w.credentialId).map((w) => w.credentialId);
  const prfSalt = newPrfSalt();
  const account = currentAccount();
  const { credentialId, prfOutput } = await createPasskey({ userId: programId, userName: account?.email, prfSalt, exclude: existing });
  const kek = await kekFromPrf(prfOutput);
  const wrapped = await wrapVaultKey(vault.key, kek, { keyId: vault.keyId, kind: 'passkey' });
  try {
    return await api.addVaultWrap(token, { kind: 'passkey', keyId: vault.keyId, wrapped, credentialId, prfSalt, label });
  } catch (err) {
    forgetPasskey(credentialId);
    throw err;
  }
}

// Opens the vault with a passkey (the browser offers whichever of the vault's
// passkeys this device has) and keeps the key here; then merges as
// unlockWithRecoveryCode does. Throws VaultSetupError 'no_vault' / 'no_passkey',
// PasskeyError, or VaultLockedError (a passkey whose wrap doesn't open).
export async function unlockWithPasskey({ merge = true, onProgress } = {}) {
  const { token, programId } = requireSession();
  const v = await api.getVault(token);
  if (!v.enabled) throw new VaultSetupError('no_vault', 'Private backup isn\'t turned on for this account.');
  const passkeys = (v.wraps || []).filter((w) => w.kind === 'passkey' && w.credentialId && w.prfSalt);
  if (!passkeys.length) throw new VaultSetupError('no_passkey', 'No passkey is set up for your private backup.');
  const { credentialId, prfOutput } = await getPrfOutput(passkeys.map((w) => ({ credentialId: w.credentialId, prfSalt: w.prfSalt })));
  const match = passkeys.find((w) => w.credentialId === credentialId);
  if (!match) throw new VaultSetupError('no_passkey', 'That passkey isn\'t one of your private backup\'s.');
  const wrap = await api.getVaultWrap(token, match.id);
  const kek = await kekFromPrf(prfOutput);
  const key = await unwrapVaultKey(wrap.wrapped, kek, { keyId: v.keyId, kind: 'passkey' });
  await setVaultKey(programId, { key, keyId: v.keyId });
  recordVaultState('on');
  return { merged: merge ? await mergeLatestVault({ onProgress }) : null };
}

// Removes a passkey from the vault (it can no longer unlock). Fresh sign-in, as
// for a new recovery code. The passkey itself stays in the password manager,
// unused; the browser is told it's unknown where it supports that.
export async function removePasskey(wrapId, { reauth = {} } = {}) {
  const { token } = requireSession();
  const v = await api.getVault(token);
  const w = (v.wraps || []).find((x) => x.id === wrapId && x.kind === 'passkey');
  await api.removeVaultWrap(token, wrapId, reauth);
  if (w?.credentialId) forgetPasskey(w.credentialId);
}

// --- A new recovery code (§2.2) ---------------------------------------------------
// Part 1: a draft code. Part 2 replaces the server's recovery wrap; the old code
// stops working. Needs this device unlocked, and a fresh sign-in (more than 15
// minutes old → CloudRequestError 'reauth_required'; send a code and pass
// { email, code } as `reauth`).
export function startNewRecoveryCode() {
  const { programId } = requireSession();
  return draft({ programId });
}

export async function finishNewRecoveryCode(d, { confirmation, reauth = {} } = {}) {
  const { token, programId } = requireSession();
  checkConfirmation(d, confirmation);
  if (d.programId !== programId) throw new VaultSetupError('program_changed');
  const vault = await getVaultKey(programId);
  if (!vault) throw new VaultSetupError('locked', 'Unlock your private info on this device first.');
  const kek = await kekFromRecoveryCode(d.code);
  const wrapped = await wrapVaultKey(vault.key, kek, { keyId: vault.keyId, kind: 'recovery' });
  await api.replaceRecoveryWrap(token, { keyId: vault.keyId, wrapped }, reauth);
  await clearUnsavedRecoveryCode(); // the new code replaces any unsaved one
}

// --- Turning it off (§2.5) ----------------------------------------------------------
// Deletes every wrap on the server (nobody can unlock it again) and the key
// here; encrypted uploads stop. Old encrypted parts age out on retention. Fresh
// sign-in, as above. The device's own data is untouched.
export async function disableVault({ reauth = {} } = {}) {
  const { token } = requireSession();
  await api.disableVault(token, reauth);
  await clearVaultKey();
  await clearUnsavedRecoveryCode();
  recordVaultState('off');
}
