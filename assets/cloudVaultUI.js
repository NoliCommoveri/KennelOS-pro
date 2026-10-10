// cloudVaultUI.js — the private vault's screens (Private Vault Plan §2; §9 step 5).
// Imported dynamically, and only by cloudBackupUI.js, so an edition with
// `cloudUrl: null` never loads it. Shared, not Pro-gated (Lite and Pro alike).
//
//   turnOnVaultFlow({ offer })   §2.1: one card; the passkey turns it on (the
//                                recovery code waits on Today), or the recovery code
//                                first (print / save / copy, type the last group back)
//   saveRecoveryCodeFlow()       Today's "Save your recovery code" after a passkey setup
//   unlockModal({ merge })       §2.3: passkey · recovery code · another device · not now
//   unlockBeforeRestore()        the restore paths' unlock step (§2.3)
//   approveDevicesModal()        §2.4: unlock another device from this one, or
//                                make a one-hour code to paste into it (§5.4)
//   passkeysModal()              §2.2, §5.2: the vault's passkeys; add / remove
//   newRecoveryCodeFlow()        §2.2
//   turnOffVaultFlow()           §2.5
//
// Layering: data/cloud/* only.
import { esc, alertModal, confirmModal } from './ui.js';
import {
  openModal, progressModal, errorText, withFreshSignIn, typedConfirm, notify, handlePushResult
} from './cloudBackupUI.js';
import {
  vaultStatus, startVaultSetup, finishVaultSetup, unlockWithRecoveryCode, unlockWithHandoffCode, createHandoffCode,
  quickVaultSetup, unsavedRecoveryCode, markRecoveryCodeSaved,
  requestDeviceUnlock, pendingDeviceUnlock, waitForDeviceUnlock, cancelDeviceUnlock,
  listUnlockRequests, approveDeviceUnlock, startNewRecoveryCode, finishNewRecoveryCode,
  disableVault, addPasskey, unlockWithPasskey, removePasskey, VaultSetupError
} from '../data/cloud/cloudVault.js';
import { passkeySupported } from '../data/cloud/vaultPasskey.js';
import { getBackupStatus } from '../data/cloud/cloudBackup.js';
import { currentAccount } from '../data/cloud/cloudAuth.js';
import { getMyKennelName } from '../data/kennelSetup.js';

const HONEST_LINE = "If you lose this code and any passkey you add, we can't open your sensitive records backup. Nobody can: it's encrypted on your device before it's uploaded. Your devices and file backups are unaffected.";

function vaultErrorText(e) {
  if (e?.name === 'VaultLockedError') return "That code didn't work. Check it and try again.";
  if (e instanceof VaultSetupError) {
    switch (e.code) {
      case 'confirm_mismatch': return "That doesn't match the end of your recovery code.";
      case 'no_vault': return "Sensitive records backup isn't turned on for this account.";
      case 'locked': return 'Unlock your sensitive records on this device first.';
      case 'expired': return 'That request has expired. Ask again.';
      case 'no_passkey': return 'No passkey on this device unlocks your sensitive records backup. Use your recovery code or another device.';
      default: return e.message;
    }
  }
  if (e?.name === 'PasskeyError') {
    switch (e.code) {
      case 'cancelled': return "The passkey was cancelled, or this device doesn't have one for your sensitive records backup.";
      case 'exists': return 'This device (or your password manager) already has a passkey for your sensitive records backup.';
      default: return "Passkeys can't unlock sensitive records backup on this browser or with this passkey. Your recovery code still works.";
    }
  }
  if (e?.name === 'CloudRequestError' && e.code === 'too_many_passkeys') return 'You already have 10 passkeys. Remove one first.';
  if (e?.name === 'CloudConflictError' && e.code === 'vault_exists') return 'Sensitive records backup was just turned on from another device. Unlock it here with that device\'s recovery code.';
  if (e?.name === 'CloudConflictError' && e.code === 'already_approved') return 'Another device already answered that request.';
  if (e?.name === 'CloudRequestError' && e.code === 'too_many_pairings') return 'Too many open requests. Wait ten minutes, then ask again.';
  if (e?.name === 'CloudRequestError' && e.code === 'too_many_handoffs') return 'Too many unlock codes are open. Wait an hour, or use one you already made.';
  return errorText(e);
}

const done = (overlay, resolve, v) => { overlay.remove(); resolve(v); };
const buttons = (overlay, resolve) => overlay.querySelectorAll('[data-v]').forEach((b) =>
  b.addEventListener('click', () => done(overlay, resolve, b.dataset.v)));

// --- Turning it on (§2.1; passkey first, decided 2026-10-10) ---------------------------
// One card. Where passkeys can try, its main button is the passkey: the prompt
// turns it on, and the recovery code waits on Today (saveRecoveryCodeFlow).
// Otherwise, or by choice, the recovery code comes first, as before.
// Resolves 'passkey' | 'code' | 'no'.
function introModal({ offer, canPasskey, errorMsg = '' }) {
  return new Promise((resolve) => {
    const overlay = openModal(`
      <h2 style="margin-top:0;">${offer ? 'Protect your sensitive records too?' : 'Back up your sensitive records'}</h2>
      <p>Contacts' phone, email and address, prices, Financials, contracts and your notes, <strong>encrypted on
        this device before upload</strong>. We can't read them, and neither can anyone who gets into our server.</p>
      ${canPasskey
        ? '<p class="muted">Turn it on with Face ID, your fingerprint or your device PIN. You\'ll also get a recovery code to save afterwards.</p>'
        : '<p class="muted">You\'ll get a recovery code to keep somewhere safe. On a new phone, you unlock with that code, or from another of your devices.</p>'}
      ${errorMsg ? `<div class="inline-error">${esc(errorMsg)}</div>` : ''}
      <div class="form-actions">
        ${canPasskey ? '<button class="btn btn-primary" data-v="passkey">Turn on with passkey</button>' : '<button class="btn btn-primary" data-v="code">Continue</button>'}
        ${canPasskey ? '<button class="btn" data-v="code">Use a recovery code instead</button>' : ''}
        <button class="btn" data-v="no">Not now</button>
      </div>`, { width: 520 });
    buttons(overlay, resolve);
  });
}

// The code on screen, with Print / Save / Copy, and the last group typed back.
// Resolves true once confirmed, false on cancel. `setup` is a cloudVault draft.
function recoveryCodeModal(setup, { title = 'Your recovery code', confirmLabel = 'Turn on sensitive records backup', onConfirm }) {
  const account = currentAccount();
  const fileText = [
    'KennelOS: sensitive records backup recovery code',
    '',
    setup.recoveryCode,
    '',
    `Account: ${account?.email || ''}`,
    `Made: ${new Date().toLocaleString()}`,
    '',
    'Use this to unlock your sensitive records (contacts\' details, prices, Financials, contracts, private notes)',
    'on a new or reset device: Import / Export → Cloud → Sensitive records → Unlock → Enter recovery code.',
    '',
    HONEST_LINE
  ].join('\n');
  return new Promise((resolve) => {
    const overlay = openModal(`
      <h2 style="margin-top:0;">${esc(title)}</h2>
      <p class="muted">Keep it somewhere safe, away from this device: printed, in your password manager, or in your files.</p>
      <p style="font-family:ui-monospace,monospace;font-size:20px;letter-spacing:1px;text-align:center;padding:12px;border:1px solid var(--border);border-radius:8px;user-select:all;">${esc(setup.recoveryCode)}</p>
      <div class="form-actions" style="justify-content:center;">
        <button class="btn btn-sm" id="rc-print">Print</button>
        <button class="btn btn-sm" id="rc-save">Save to Files</button>
        <button class="btn btn-sm" id="rc-copy">Copy</button>
      </div>
      <p class="field-hint" id="rc-saved" aria-live="polite"></p>
      <p class="inline-warn">${esc(HONEST_LINE)}</p>
      <div class="field"><label for="rc-last">To check you've saved it, type its <strong>last 4 characters</strong></label>
        <input id="rc-last" type="text" autocomplete="off" autocapitalize="characters" maxlength="5" style="font-family:ui-monospace,monospace;font-size:18px;letter-spacing:2px;max-width:120px;"></div>
      <div id="rc-error"></div>
      <div class="form-actions">
        <button class="btn btn-primary" id="rc-ok" disabled>${esc(confirmLabel)}</button>
        <button class="btn" id="rc-cancel">Cancel</button>
      </div>`, { width: 520, dismissible: false });
    const q = (s) => overlay.querySelector(s);
    const saved = (msg) => { q('#rc-saved').textContent = msg; };
    q('#rc-print').addEventListener('click', () => { printText(fileText); saved('Sent to the printer.'); });
    q('#rc-save').addEventListener('click', () => { downloadText(fileText, 'KennelOS-recovery-code.txt'); saved('Saved as KennelOS-recovery-code.txt.'); });
    q('#rc-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(setup.recoveryCode); saved('Copied. Paste it somewhere safe now.'); } catch { saved("Couldn't copy: select the code and copy it by hand."); }
    });
    const input = q('#rc-last');
    const norm = (v) => v.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    input.addEventListener('input', () => {
      q('#rc-ok').disabled = norm(input.value).length !== 4;
      q('#rc-error').innerHTML = '';
    });
    q('#rc-ok').addEventListener('click', async () => {
      const btn = q('#rc-ok');
      btn.disabled = true;
      try {
        await onConfirm(input.value);
        done(overlay, resolve, true);
      } catch (e) {
        q('#rc-error').innerHTML = `<div class="inline-error">${esc(vaultErrorText(e))}</div>`;
        btn.disabled = false;
      }
    });
    q('#rc-cancel').addEventListener('click', () => done(overlay, resolve, false));
    input.focus();
  });
}

function downloadText(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Prints through a hidden frame, so no popup blocker gets in the way and the
// code never lands in a new tab's history.
function printText(text) {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!doctype html><meta charset="utf-8"><title>KennelOS recovery code</title><pre style="font:14px/1.5 ui-monospace,monospace;white-space:pre-wrap;">${esc(text)}</pre>`);
  doc.close();
  frame.contentWindow.focus();
  frame.contentWindow.print();
  setTimeout(() => frame.remove(), 60 * 1000);
}

// `offer: true` is the step inside "Turn on cloud backup" (its card says "too").
// Resolves true when it's on.
export async function turnOnVaultFlow({ offer = false } = {}) {
  const canPasskey = await passkeySupported();
  let errorMsg = '';
  for (;;) {
    const choice = await introModal({ offer, canPasskey, errorMsg });
    if (choice === 'no') return false;
    if (choice === 'code') return codeFirstVaultFlow({ offerPasskey: canPasskey });
    const pg = progressModal('Turning on sensitive records backup…');
    let push;
    try {
      push = await quickVaultSetup({
        label: currentAccount()?.deviceLabel,
        onProgress: (p) => {
          if (p.phase === 'files' && p.total) pg.update(`Uploading documents: ${p.done + 1} of ${p.total}…`, p.done, p.total);
          else pg.update('Uploading your encrypted records…');
        }
      });
    } catch (e) {
      pg.close();
      // A passkey that can't do PRF: the recovery code is the way, as before.
      if (e?.name === 'PasskeyError' && e.code === 'unsupported') return codeFirstVaultFlow({ offerPasskey: false });
      errorMsg = vaultErrorText(e);
      continue;
    }
    pg.close();
    notify();
    if (push && !['pushed', 'unchanged', 'skipped'].includes(push.status)) await handlePushResult(push);
    return true;
  }
}

// The recovery code first (no passkey here, or the owner chose it).
async function codeFirstVaultFlow({ offerPasskey }) {
  let setup;
  try { setup = await startVaultSetup(); } catch (e) { await alertModal({ title: "That didn't work", message: vaultErrorText(e) }); return false; }
  let push = null;
  const ok = await recoveryCodeModal(setup, {
    onConfirm: async (typed) => {
      const pg = progressModal('Encrypting and backing up your sensitive records…');
      try {
        push = await finishVaultSetup(setup, {
          confirmation: typed,
          onProgress: (p) => {
            if (p.phase === 'files' && p.total) pg.update(`Uploading documents: ${p.done + 1} of ${p.total}…`, p.done, p.total);
            else pg.update('Uploading your encrypted records…');
          }
        });
      } finally { pg.close(); }
    }
  });
  if (!ok) return false;
  notify();
  if (push && push.status !== 'pushed' && push.status !== 'unchanged' && push.status !== 'skipped') await handlePushResult(push);
  if (offerPasskey) await offerPasskeyModal();
  return true;
}

// Today's "Save your recovery code" (passkey-first setup): the code with Print /
// Save / Copy, and its last group typed back. Resolves true once saved.
export async function saveRecoveryCodeFlow() {
  const code = await unsavedRecoveryCode();
  if (!code) return true;
  const ok = await recoveryCodeModal({ recoveryCode: code }, {
    title: 'Save your recovery code',
    confirmLabel: "I've saved it",
    onConfirm: (typed) => markRecoveryCodeSaved(typed)
  });
  if (ok) notify();
  return ok;
}

// §2.1 step 3: "Unlock with Face ID / fingerprint next time?" Skippable; the
// recovery code already works. Resolves true when a passkey was added.
function offerPasskeyModal() {
  return new Promise((resolve) => {
    const overlay = openModal(`
      <h2 style="margin-top:0;">Unlock with a passkey next time?</h2>
      <p>On a new or reset device you can unlock your sensitive records with <strong>Face ID, your fingerprint or
        your device PIN</strong> instead of typing the recovery code. The passkey is saved in your password manager
        (iCloud Keychain, Google Password Manager…), so it can follow you to a new phone.</p>
      <p class="field-hint">Your recovery code still works either way. Keep it.</p>
      <div id="pk-error"></div>
      <div class="form-actions">
        <button class="btn btn-primary" id="pk-add">Add a passkey</button>
        <button class="btn" id="pk-skip">Skip</button>
      </div>`, { width: 500, dismissible: false });
    const q = (sel) => overlay.querySelector(sel);
    q('#pk-skip').addEventListener('click', () => done(overlay, resolve, false));
    q('#pk-add').addEventListener('click', async () => {
      const btn = q('#pk-add');
      btn.disabled = true;
      try {
        await addPasskey({ label: passkeyLabel() });
        done(overlay, resolve, true);
        await alertModal({ title: 'Passkey added', message: 'Next time, choose Use passkey to unlock your sensitive records.' });
      } catch (e) {
        q('#pk-error').innerHTML = `<div class="inline-error">${esc(vaultErrorText(e))}</div>`;
        btn.disabled = false;
      }
    });
  });
}

const passkeyLabel = () => {
  const device = currentAccount()?.deviceLabel;
  return device ? `Made on ${device}` : 'Passkey';
};

// --- Unlocking this device (§2.3, §2.4) ------------------------------------------------
// Resolves 'unlocked' or null (not now / cancelled). `merge: true` merges the
// latest backup's private info in after unlocking (the card's Unlock); the
// restore paths pass false because their restore does it.
export function unlockModal({ merge = true, intro = '' } = {}) {
  return new Promise((resolve) => {
    const overlay = openModal('<div id="ul-body"></div>', { width: 500, dismissible: false });
    const body = overlay.querySelector('#ul-body');
    let controller = null;
    const finish = (v) => { controller?.abort(); done(overlay, resolve, v); };

    const unlocked = async (merged) => {
      notify();
      if (merged?.missingFiles?.length) {
        await alertModal({ title: 'Unlocked', message: `${merged.missingFiles.length} document file(s) couldn't be downloaded yet.` });
      }
      finish('unlocked');
    };

    // Offer the passkey only when the vault has one and this browser can try.
    let canPasskey = false;
    const ready = vaultStatus().then((st) => { canPasskey = st.passkeys.length > 0 && st.passkeySupported; }).catch(() => {});

    const showPasskey = async () => {
      body.innerHTML = '<h2 style="margin-top:0;">Use passkey</h2><p class="muted">Follow your device\'s prompt…</p>';
      try {
        const { merged } = await unlockWithPasskey({ merge });
        await unlocked(merged);
      } catch (e) {
        await showChoices(vaultErrorText(e));
      }
    };

    const showChoices = async (errorMsg = '') => {
      await ready;
      body.innerHTML = `
        <h2 style="margin-top:0;">Unlock your sensitive records</h2>
        <p class="muted">${esc(intro || "Your contacts' details, prices, Financials, contracts and private notes are backed up encrypted. Unlock them on this device to bring them back.")}</p>
        ${errorMsg ? `<div class="inline-error">${esc(errorMsg)}</div>` : ''}
        <div class="form-actions" style="flex-direction:column;align-items:stretch;">
          ${canPasskey ? '<button class="btn btn-primary" data-c="passkey">Use passkey</button>' : ''}
          <button class="btn${canPasskey ? '' : ' btn-primary'}" data-c="code">Enter recovery code</button>
          <button class="btn" data-c="device">Use another device</button>
          <button class="btn" data-c="later">Not now</button>
        </div>
        <p class="field-hint">Not now: your kennel records still come back. Sensitive records stay blank until you unlock, and backups from this device pause until then.</p>`;
      body.querySelector('[data-c="passkey"]')?.addEventListener('click', () => showPasskey());
      body.querySelector('[data-c="code"]').addEventListener('click', () => showCode());
      body.querySelector('[data-c="device"]').addEventListener('click', () => showDevice());
      body.querySelector('[data-c="later"]').addEventListener('click', () => finish(null));
    };

    const showCode = (errorMsg = '') => {
      body.innerHTML = `
        <h2 style="margin-top:0;">Enter your recovery code</h2>
        <p class="muted">The 24-character code you saved when you turned on sensitive records backup. Dashes and capitals don't matter.</p>
        <div class="field field-wide"><label for="ul-code">Recovery code</label>
          <input id="ul-code" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" style="font-family:ui-monospace,monospace;"></div>
        ${errorMsg ? `<div class="inline-error">${esc(errorMsg)}</div>` : ''}
        <div class="form-actions">
          <button class="btn btn-primary" id="ul-ok">Unlock</button>
          <button class="btn" id="ul-back">Back</button>
        </div>`;
      const input = body.querySelector('#ul-code');
      const go = async () => {
        const btn = body.querySelector('#ul-ok');
        btn.disabled = true; btn.textContent = 'Unlocking…';
        try {
          const { merged } = await unlockWithRecoveryCode(input.value, { merge });
          await unlocked(merged);
        } catch (e) { showCode(vaultErrorText(e)); }
      };
      body.querySelector('#ul-ok').addEventListener('click', go);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      body.querySelector('#ul-back').addEventListener('click', () => showChoices());
      input.focus();
    };

    const showDevice = async (errorMsg = '') => {
      body.innerHTML = '<p class="muted">Asking…</p>';
      let req;
      try {
        req = (await pendingDeviceUnlock()) || (await requestDeviceUnlock({ label: currentAccount()?.deviceLabel }));
      } catch (e) {
        body.innerHTML = `<h2 style="margin-top:0;">Use another device</h2><div class="inline-error">${esc(vaultErrorText(e))}</div>
          <div class="form-actions"><button class="btn" id="ul-back">Back</button></div>`;
        body.querySelector('#ul-back').addEventListener('click', () => showChoices());
        return;
      }
      body.innerHTML = `
        <h2 style="margin-top:0;">Use another device</h2>
        <p class="muted">Have an unlock code from KennelOS Lite or another device? Paste it here:</p>
        <div class="field field-wide"><label for="ul-handoff">Unlock code</label>
          <input id="ul-handoff" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" style="font-family:ui-monospace,monospace;"></div>
        <div class="inline-error" id="ul-handoff-error" hidden></div>
        <div class="form-actions" style="margin-top:0;"><button class="btn btn-primary" id="ul-handoff-ok">Unlock</button></div>
        <p class="muted" style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border);">Or, on a device where your sensitive records are already unlocked, open KennelOS, then
          <strong>Import / Export → Cloud → Sensitive records → Unlock another device</strong>, and type this code:</p>
        <p style="font-family:ui-monospace,monospace;font-size:24px;letter-spacing:2px;text-align:center;padding:12px;border:1px solid var(--border);border-radius:8px;">${esc(req.code)}</p>
        <p class="field-hint" id="ul-wait">Waiting for the other device… This code works for 10 minutes.</p>
        ${errorMsg ? `<div class="inline-error">${esc(errorMsg)}</div>` : ''}
        <div class="form-actions"><button class="btn" id="ul-back">Back</button></div>`;
      controller = new AbortController();
      const mine = controller;
      body.querySelector('#ul-back').addEventListener('click', () => { mine.abort(); showChoices(); });
      const handoffInput = body.querySelector('#ul-handoff');
      const handoffError = body.querySelector('#ul-handoff-error');
      const redeem = async () => {
        const btn = body.querySelector('#ul-handoff-ok');
        btn.disabled = true; btn.textContent = 'Unlocking…';
        handoffError.hidden = true;
        try {
          const { merged } = await unlockWithHandoffCode(handoffInput.value, { merge });
          mine.abort();
          cancelDeviceUnlock().catch(() => {});
          await unlocked(merged);
        } catch (e) {
          btn.disabled = false; btn.textContent = 'Unlock';
          handoffError.hidden = false;
          handoffError.textContent = e?.name === 'VaultLockedError'
            ? "That code didn't work. Codes work once, for an hour: make a new one on the other device if it's used or old."
            : vaultErrorText(e);
        }
      };
      body.querySelector('#ul-handoff-ok').addEventListener('click', redeem);
      handoffInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') redeem(); });
      try {
        const r = await waitForDeviceUnlock({ signal: mine.signal, merge });
        if (r.status === 'unlocked') await unlocked(r.merged);
      } catch (e) {
        if (mine.signal.aborted) return;
        await cancelDeviceUnlock();
        const msg = e?.name === 'VaultLockedError'
          ? "The code typed on the other device didn't match. Here's a new one: type it carefully."
          : vaultErrorText(e);
        if (e?.name === 'VaultLockedError' || (e instanceof VaultSetupError && e.code === 'expired')) showDevice(msg);
        else {
          body.innerHTML = `<h2 style="margin-top:0;">Use another device</h2><div class="inline-error">${esc(msg)}</div>
            <div class="form-actions"><button class="btn" id="ul-back">Back</button></div>`;
          body.querySelector('#ul-back').addEventListener('click', () => showChoices());
        }
      }
    };

    showChoices();
  });
}

// Before a restore on a new or reset device: when the program has a vault and
// this device can't open it, ask now so the restore brings everything back.
// Never blocks a restore: offline or any error just skips the question.
export async function unlockBeforeRestore() {
  let st;
  try { st = await vaultStatus(); } catch { return null; }
  if (!st.enabled || st.unlocked) return st.unlocked ? 'unlocked' : null;
  return unlockModal({ merge: false });
}

// A handoff code (§5.4) on screen, with Copy. Shared by the approve modal here
// and Lite's upgrade dialog (editionLinks.js).
export function handoffCodeHtml(code) {
  return `<div class="handoff-code" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0;">
      <code style="font-family:ui-monospace,monospace;font-size:15px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;user-select:all;white-space:nowrap;max-width:100%;overflow-x:auto;">${esc(code)}</code>
      <button type="button" class="btn btn-sm" data-copy-handoff>Copy code</button>
    </div>`;
}

export async function copyHandoffCode(code) {
  try { await navigator.clipboard.writeText(code); return true; } catch { return false; }
}

export function wireHandoffCopy(scope, code) {
  const btn = scope.querySelector('[data-copy-handoff]');
  btn?.addEventListener('click', async () => {
    btn.textContent = (await copyHandoffCode(code)) ? 'Copied ✓' : 'Select it and copy';
  });
}

// --- Unlock another device, from this one (§2.4) ---------------------------------------
export function approveDevicesModal() {
  return new Promise((resolve) => {
    const overlay = openModal('<div id="ap-body"><p class="muted">Looking for devices waiting to be unlocked…</p></div>', { width: 500 });
    const body = overlay.querySelector('#ap-body');
    const finish = () => done(overlay, resolve);

    const showList = async () => {
      let requests;
      try { requests = await listUnlockRequests(); } catch (e) {
        body.innerHTML = `<h2 style="margin-top:0;">Unlock another device</h2><div class="inline-error">${esc(vaultErrorText(e))}</div>
          <div class="form-actions"><button class="btn" id="ap-close">Close</button></div>`;
        body.querySelector('#ap-close').addEventListener('click', finish);
        return;
      }
      body.innerHTML = `
        <h2 style="margin-top:0;">Unlock another device</h2>
        <p class="muted">On the other device, choose <strong>Unlock your sensitive records → Use another device</strong>. It shows a code; it appears here, then type the code.</p>
        ${requests.length ? `<ul style="list-style:none;padding:0;margin:0;">${requests.map((r) => `
          <li style="padding:10px 0;border-top:1px solid var(--border);" class="row-between">
            <span><strong>${esc(r.deviceLabel || 'A device')}</strong> <span class="faint">· asked ${esc(new Date(r.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))}</span></span>
            <button class="btn btn-sm btn-primary" data-id="${esc(r.id)}">Unlock it…</button>
          </li>`).join('')}</ul>` : '<p class="field-hint">No device is waiting yet.</p>'}
        <div class="form-actions">
          <button class="btn" id="ap-refresh">Check again</button>
          <button class="btn" id="ap-handoff">Make an unlock code instead</button>
          <button class="btn" id="ap-close">Close</button>
        </div>`;
      body.querySelector('#ap-refresh').addEventListener('click', () => showList());
      body.querySelector('#ap-handoff').addEventListener('click', () => showHandoff());
      body.querySelector('#ap-close').addEventListener('click', finish);
      body.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => showCode(requests.find((r) => r.id === b.dataset.id))));
    };

    // A code to paste into the other device (§5.4), e.g. KennelOS Pro on this phone.
    const showHandoff = async () => {
      body.innerHTML = '<p class="muted">Making a code…</p>';
      let made;
      try { made = await createHandoffCode(); } catch (e) {
        body.innerHTML = `<h2 style="margin-top:0;">Unlock code</h2><div class="inline-error">${esc(vaultErrorText(e))}</div>
          <div class="form-actions"><button class="btn" id="ap-back">Back</button></div>`;
        body.querySelector('#ap-back').addEventListener('click', () => showList());
        return;
      }
      body.innerHTML = `
        <h2 style="margin-top:0;">Unlock code</h2>
        <p class="muted">On the other device (KennelOS Pro, a new phone…), sign in with the same email, choose
          <strong>Unlock your sensitive records → Use another device</strong>, and paste this code. It works once, for 1 hour.</p>
        ${handoffCodeHtml(made.code)}
        <div class="form-actions"><button class="btn btn-primary" id="ap-close">Done</button></div>`;
      wireHandoffCopy(body, made.code);
      body.querySelector('#ap-close').addEventListener('click', finish);
    };

    const showCode = (req, errorMsg = '') => {
      body.innerHTML = `
        <h2 style="margin-top:0;">Unlock ${esc(req.deviceLabel || 'that device')}</h2>
        <p class="muted">Type the 12-character code shown on ${esc(req.deviceLabel || 'that device')}. Only unlock a device you have in front of you.</p>
        <div class="field"><label for="ap-code">Code</label>
          <input id="ap-code" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX" style="font-family:ui-monospace,monospace;font-size:18px;max-width:220px;"></div>
        ${errorMsg ? `<div class="inline-error">${esc(errorMsg)}</div>` : ''}
        <div class="form-actions">
          <button class="btn btn-primary" id="ap-ok">Unlock it</button>
          <button class="btn" id="ap-back">Back</button>
        </div>`;
      const input = body.querySelector('#ap-code');
      const go = async () => {
        const btn = body.querySelector('#ap-ok');
        btn.disabled = true; btn.textContent = 'Unlocking…';
        try {
          await approveDeviceUnlock(req, input.value);
          body.innerHTML = `<h2 style="margin-top:0;">Sent</h2>
            <p class="muted">${esc(req.deviceLabel || 'That device')} unlocks in a few seconds. If it says the code didn't match, it shows a new one: unlock it again from here.</p>
            <div class="form-actions"><button class="btn btn-primary" id="ap-close">Done</button></div>`;
          body.querySelector('#ap-close').addEventListener('click', finish);
        } catch (e) {
          if (e?.name === 'VaultLockedError') showCode(req, 'That code is 12 characters: check it and type it again.');
          else showCode(req, vaultErrorText(e));
        }
      };
      body.querySelector('#ap-ok').addEventListener('click', go);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      body.querySelector('#ap-back').addEventListener('click', () => showList());
      input.focus();
    };

    showList();
  });
}

// --- Passkeys (§2.2, §5.2) ---------------------------------------------------------------
// The vault's passkeys: add one on this device, or remove one (fresh sign-in).
export function passkeysModal() {
  return new Promise((resolve) => {
    const overlay = openModal('<div id="pk-body"><p class="muted">Loading…</p></div>', { width: 500 });
    const body = overlay.querySelector('#pk-body');
    const finish = () => done(overlay, resolve);

    const show = async (msg = '', isError = true) => {
      let st;
      try { st = await vaultStatus(); } catch (e) {
        body.innerHTML = `<h2 style="margin-top:0;">Passkeys</h2><div class="inline-error">${esc(vaultErrorText(e))}</div>
          <div class="form-actions"><button class="btn" id="pk-close">Close</button></div>`;
        body.querySelector('#pk-close').addEventListener('click', finish);
        return;
      }
      body.innerHTML = `
        <h2 style="margin-top:0;">Passkeys</h2>
        <p class="muted">A passkey unlocks your sensitive records on a new or reset device with Face ID, a fingerprint or
          the device PIN. It never signs you in, and your recovery code still works.</p>
        ${st.passkeys.length ? `<ul style="list-style:none;padding:0;margin:0;">${st.passkeys.map((p) => `
          <li style="padding:10px 0;border-top:1px solid var(--border);" class="row-between">
            <span><strong>${esc(p.label || 'Passkey')}</strong> <span class="faint">· added ${esc(new Date(p.createdAt).toLocaleDateString())}</span></span>
            <button class="btn btn-sm btn-danger" data-rm="${esc(p.id)}">Remove…</button>
          </li>`).join('')}</ul>` : '<p class="field-hint">No passkeys yet.</p>'}
        ${st.passkeySupported ? '' : '<p class="field-hint">This browser can\'t make a passkey that unlocks sensitive records backup. Try Safari on an iPhone or Mac, or Chrome.</p>'}
        ${msg ? `<div class="${isError ? 'inline-error' : 'field-hint'}">${esc(msg)}</div>` : ''}
        <div class="form-actions">
          ${st.passkeySupported && st.unlocked ? '<button class="btn btn-primary" id="pk-add">Add a passkey</button>' : ''}
          <button class="btn" id="pk-close">Close</button>
        </div>`;
      body.querySelector('#pk-close').addEventListener('click', finish);
      body.querySelector('#pk-add')?.addEventListener('click', async (ev) => {
        ev.currentTarget.disabled = true;
        try { await addPasskey({ label: passkeyLabel() }); await show('Passkey added.', false); } catch (e) { await show(vaultErrorText(e)); }
      });
      body.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', async () => {
        const p = st.passkeys.find((x) => x.id === b.dataset.rm);
        if (!(await confirmModal({
          title: 'Remove this passkey?',
          message: `"${p?.label || 'Passkey'}" will no longer unlock your sensitive records. Your recovery code and other passkeys still work.`,
          confirmLabel: 'Remove'
        }))) return;
        try {
          const r = await withFreshSignIn((reauth) => removePasskey(b.dataset.rm, { reauth }).then(() => true),
            { purpose: 'remove a passkey', confirmLabel: 'Remove it' });
          await show(r === null ? '' : 'Passkey removed.', false);
        } catch (e) { await show(vaultErrorText(e)); }
      }));
    };

    show();
  });
}

// --- A new recovery code (§2.2) --------------------------------------------------------
export async function newRecoveryCodeFlow() {
  const ok = await confirmModal({
    title: 'Make a new recovery code?',
    message: 'Your current recovery code stops working as soon as you confirm the new one. Use this if the old one may have been seen, or you\'ve lost it.',
    confirmLabel: 'Make a new code'
  });
  if (!ok) return false;
  let d;
  try { d = startNewRecoveryCode(); } catch (e) { await alertModal({ title: "That didn't work", message: vaultErrorText(e) }); return false; }
  const confirmed = await recoveryCodeModal(d, {
    title: 'Your new recovery code',
    confirmLabel: 'Use this code',
    onConfirm: async (typed) => {
      const r = await withFreshSignIn((reauth) => finishNewRecoveryCode(d, { confirmation: typed, reauth }).then(() => true),
        { purpose: 'change your recovery code', confirmLabel: 'Use this code' });
      if (r === null) throw new Error('Cancelled: your old recovery code still works.');
    }
  });
  if (confirmed) await alertModal({ title: 'New recovery code saved', message: 'Your old code no longer works. Keep the new one safe.' });
  return confirmed;
}

// --- Turning it off (§2.5) --------------------------------------------------------------
export async function turnOffVaultFlow() {
  const kennel = (await getMyKennelName()) || 'your program';
  const ok = await typedConfirm({
    title: 'Turn off sensitive records backup?',
    message: `Nobody will be able to unlock the sensitive records backup of ${kennel} again, from any device, and sensitive records stop being backed up. `
      + 'Old encrypted backups are deleted within 30 days.\n\nYour records on this device are untouched. Kennel records keep backing up as before.',
    phrase: 'TURN OFF',
    confirmLabel: 'Turn off sensitive records backup'
  });
  if (!ok) return false;
  const r = await withFreshSignIn((reauth) => disableVault({ reauth }).then(() => true),
    { purpose: 'turn off sensitive records backup', confirmLabel: 'Turn it off' });
  if (r === null) return false;
  notify();
  await alertModal({ title: 'Sensitive records backup is off', message: 'Your sensitive records are only on this device now. Keep a file backup of them from Import / Export.' });
  return true;
}

// Refresh what this device knows about the vault (the card calls it once).
export async function refreshVaultState() {
  try { await vaultStatus(); notify(); } catch { /* offline: keep the last known state */ }
  return getBackupStatus().vault;
}
