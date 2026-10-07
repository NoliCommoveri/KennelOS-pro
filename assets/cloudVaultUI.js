// cloudVaultUI.js — the private vault's screens (Private Vault Plan §2; §9 step 5).
// Imported dynamically, and only by cloudBackupUI.js, so an edition with
// `cloudUrl: null` never loads it. Shared, not Pro-gated (Lite and Pro alike).
//
//   turnOnVaultFlow({ offer })   §2.1: "Also back up your private info?" → the
//                                recovery code (print / save / copy, then type the
//                                last group back) → the first encrypted backup
//   unlockModal({ merge })       §2.3: recovery code · another device · not now
//   unlockBeforeRestore()        the restore paths' unlock step (§2.3)
//   approveDevicesModal()        §2.4: unlock another device from this one
//   newRecoveryCodeFlow()        §2.2
//   turnOffVaultFlow()           §2.5
//
// Passkeys (§5.2) are a later build step. Layering: data/cloud/* only.
import { esc, alertModal, confirmModal } from './ui.js';
import {
  openModal, progressModal, errorText, withFreshSignIn, typedConfirm, notify, handlePushResult
} from './cloudBackupUI.js';
import {
  vaultStatus, startVaultSetup, finishVaultSetup, unlockWithRecoveryCode,
  requestDeviceUnlock, pendingDeviceUnlock, waitForDeviceUnlock, cancelDeviceUnlock,
  listUnlockRequests, approveDeviceUnlock, startNewRecoveryCode, finishNewRecoveryCode,
  disableVault, VaultSetupError
} from '../data/cloud/cloudVault.js';
import { getBackupStatus } from '../data/cloud/cloudBackup.js';
import { currentAccount } from '../data/cloud/cloudAuth.js';
import { getMyKennelName } from '../data/kennelSetup.js';

const HONEST_LINE = "If you lose this code, we can't open your private backup. Nobody can: it's encrypted on your device before it's uploaded. Your devices and file backups are unaffected.";

function vaultErrorText(e) {
  if (e?.name === 'VaultLockedError') return "That code didn't work. Check it and try again.";
  if (e instanceof VaultSetupError) {
    switch (e.code) {
      case 'confirm_mismatch': return "That doesn't match the end of your recovery code.";
      case 'no_vault': return "Private backup isn't turned on for this account.";
      case 'locked': return 'Unlock your private info on this device first.';
      case 'expired': return 'That request has expired. Ask again.';
      default: return e.message;
    }
  }
  if (e?.name === 'CloudConflictError' && e.code === 'vault_exists') return 'Private backup was just turned on from another device. Unlock it here with that device\'s recovery code.';
  if (e?.name === 'CloudConflictError' && e.code === 'already_approved') return 'Another device already answered that request.';
  if (e?.name === 'CloudRequestError' && e.code === 'too_many_pairings') return 'Too many open requests. Wait ten minutes, then ask again.';
  return errorText(e);
}

const done = (overlay, resolve, v) => { overlay.remove(); resolve(v); };
const buttons = (overlay, resolve) => overlay.querySelectorAll('[data-v]').forEach((b) =>
  b.addEventListener('click', () => done(overlay, resolve, b.dataset.v)));

// --- Turning it on (§2.1) ----------------------------------------------------------
function introModal({ offer }) {
  return new Promise((resolve) => {
    const overlay = openModal(`
      <h2 style="margin-top:0;">${offer ? 'Also back up your private info?' : 'Back up your private info'}</h2>
      <p>Contacts' phone, email and address, prices and payments, Financials, contracts, receipts and your
        private notes can be backed up too, <strong>encrypted on this device before upload</strong>. We can't read
        them, and neither can anyone who gets into our server.</p>
      <p class="muted">You'll get a recovery code to keep somewhere safe. On a new phone, you unlock your private
        info with that code, or from another of your devices that's already unlocked.</p>
      <p class="field-hint">Strongly suggested if you use the waitlist: applicants' answers and fees are private.</p>
      <div class="form-actions">
        <button class="btn btn-primary" data-v="on">Continue</button>
        <button class="btn" data-v="no">Not now</button>
      </div>`, { width: 520 });
    buttons(overlay, resolve);
  });
}

// The code on screen, with Print / Save / Copy, and the last group typed back.
// Resolves true once confirmed, false on cancel. `setup` is a cloudVault draft.
function recoveryCodeModal(setup, { title = 'Your recovery code', confirmLabel = 'Turn on private backup', onConfirm }) {
  const account = currentAccount();
  const fileText = [
    'KennelOS: private backup recovery code',
    '',
    setup.recoveryCode,
    '',
    `Account: ${account?.email || ''}`,
    `Made: ${new Date().toLocaleString()}`,
    '',
    'Use this to unlock your private info (contacts\' details, prices, Financials, contracts, private notes)',
    'on a new or reset device: Cloud backup → Unlock your private info → Enter recovery code.',
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

// `offer: true` is the step inside "Turn on cloud backup" (its intro has "Not
// now"). Resolves true when it's on.
export async function turnOnVaultFlow({ offer = false } = {}) {
  if ((await introModal({ offer })) !== 'on') return false;
  let setup;
  try { setup = await startVaultSetup(); } catch (e) { await alertModal({ title: "That didn't work", message: vaultErrorText(e) }); return false; }
  let push = null;
  const ok = await recoveryCodeModal(setup, {
    onConfirm: async (typed) => {
      const pg = progressModal('Encrypting and backing up your private info…');
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
  else await alertModal({ title: 'Private backup is on', message: 'Your private info is now backed up, encrypted, with every backup. Keep your recovery code safe.' });
  return true;
}

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

    const showChoices = () => {
      body.innerHTML = `
        <h2 style="margin-top:0;">Unlock your private info</h2>
        <p class="muted">${esc(intro || "Your contacts' details, prices, Financials, contracts and private notes are backed up encrypted. Unlock them on this device to bring them back.")}</p>
        <div class="form-actions" style="flex-direction:column;align-items:stretch;">
          <button class="btn btn-primary" data-c="code">Enter recovery code</button>
          <button class="btn" data-c="device">Use another device</button>
          <button class="btn" data-c="later">Not now</button>
        </div>
        <p class="field-hint">Not now: your kennel records still come back. Private details stay blank until you unlock, and backups from this device pause until then.</p>`;
      body.querySelector('[data-c="code"]').addEventListener('click', () => showCode());
      body.querySelector('[data-c="device"]').addEventListener('click', () => showDevice());
      body.querySelector('[data-c="later"]').addEventListener('click', () => finish(null));
    };

    const showCode = (errorMsg = '') => {
      body.innerHTML = `
        <h2 style="margin-top:0;">Enter your recovery code</h2>
        <p class="muted">The 24-character code you saved when you turned on private backup. Dashes and capitals don't matter.</p>
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
        <p class="muted">On a device where your private info is already unlocked, open KennelOS, then
          <strong>Import / Export → Cloud backup → Private backup → Unlock another device</strong>, and type this code:</p>
        <p style="font-family:ui-monospace,monospace;font-size:24px;letter-spacing:2px;text-align:center;padding:12px;border:1px solid var(--border);border-radius:8px;">${esc(req.code)}</p>
        <p class="field-hint" id="ul-wait">Waiting for the other device… This code works for 10 minutes.</p>
        ${errorMsg ? `<div class="inline-error">${esc(errorMsg)}</div>` : ''}
        <div class="form-actions"><button class="btn" id="ul-back">Back</button></div>`;
      controller = new AbortController();
      const mine = controller;
      body.querySelector('#ul-back').addEventListener('click', () => { mine.abort(); showChoices(); });
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
        <p class="muted">On the other device, choose <strong>Unlock your private info → Use another device</strong>. It shows a code; it appears here, then type the code.</p>
        ${requests.length ? `<ul style="list-style:none;padding:0;margin:0;">${requests.map((r) => `
          <li style="padding:10px 0;border-top:1px solid var(--border);" class="row-between">
            <span><strong>${esc(r.deviceLabel || 'A device')}</strong> <span class="faint">· asked ${esc(new Date(r.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))}</span></span>
            <button class="btn btn-sm btn-primary" data-id="${esc(r.id)}">Unlock it…</button>
          </li>`).join('')}</ul>` : '<p class="field-hint">No device is waiting yet.</p>'}
        <div class="form-actions">
          <button class="btn" id="ap-refresh">Check again</button>
          <button class="btn" id="ap-close">Close</button>
        </div>`;
      body.querySelector('#ap-refresh').addEventListener('click', () => showList());
      body.querySelector('#ap-close').addEventListener('click', finish);
      body.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => showCode(requests.find((r) => r.id === b.dataset.id))));
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
    title: 'Turn off private backup?',
    message: `Nobody will be able to unlock the private backup of ${kennel} again, from any device, and private info stops being backed up. `
      + 'Old encrypted backups are deleted within 30 days.\n\nYour records on this device are untouched. Kennel records keep backing up as before.',
    phrase: 'TURN OFF',
    confirmLabel: 'Turn off private backup'
  });
  if (!ok) return false;
  const r = await withFreshSignIn((reauth) => disableVault({ reauth }).then(() => true),
    { purpose: 'turn off private backup', confirmLabel: 'Turn it off' });
  if (r === null) return false;
  notify();
  await alertModal({ title: 'Private backup is off', message: 'Your private info is only on this device now. Keep a file backup of it from Import / Export.' });
  return true;
}

// Refresh what this device knows about the vault (the card calls it once).
export async function refreshVaultState() {
  try { await vaultStatus(); notify(); } catch { /* offline: keep the last known state */ }
  return getBackupStatus().vault;
}
