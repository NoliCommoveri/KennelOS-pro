// cloudBackupUI.js — every cloud-backup screen (Cloud Phase 1 plan §2, §3.4,
// §3.5; §9 step 5). Shared, not Pro-gated (plan §3.1), so Lite and Pro both
// carry it. Every entry point checks isCloudAvailable() first and renders
// NOTHING when the edition has no server (`cloudUrl: null`: Demo, the shared
// default, a post-shutdown release), so no account wording ever appears there.
//
//   bootCloud()                 app.js, every page: scheduler, service notices,
//                               the one-time post-setup offer
//   mountCloudPane(el, getMode) Import/Export: the Cloud destination of Backup & restore
//   mountCloudAccountCard(el)   Settings: the Account card
//   renderTodayCloudNudge(el)   Today: "turn it on" while off, or "paused"
//   runSignInAndRestore()       first-run "I already use KennelOS"
//   resetSignOutFieldHtml() / signOutAfterResetIfChecked()   Reset App's question
//   devicesModal()              "Your devices": erase a lost one, free its Pro license
//   openDevicesFromLicenseWall() the Pro activation wall's "Lost a device?" link
//   renderPrivateGapHint()      record pages: "private details are blank here" after a
//                               restore that didn't bring them back (bootCloud)
//   proLineText()               Pro only: the Account section's "Pro on this account"
//                               line, and Link a Pro purchase email… (License Link Plan §6)
//
// The private vault's screens are cloudVaultUI.js, imported from here only when
// needed (vaultUI()).
//
// Layering: talks to data/cloud/* only (never cloudApi's fetch directly, never db).
import { esc, confirmModal, alertModal, promptModal } from './ui.js';
import { isCloudAvailable, isVaultOffered, isWaitlistOnlineOffered } from '../data/cloud/cloudConfig.js';
import { editionFlags } from '../data/editionConfig.js';
import {
  startSignIn, verifySignIn, currentAccount, signOut, signOutOtherDevices, defaultDeviceLabel
} from '../data/cloud/cloudAuth.js';
import {
  enableBackup, disableBackup, pushIfDirty, getBackupStatus, restoreLatestAndTakeOver,
  replaceCloudWithThisDevice, listSnapshots, downloadSnapshot, previewRestore, restoreSnapshot,
  restoreOnNewDevice, deleteCloudData, startBackupScheduler, getServiceNotices, CLOUD_BACKUP_EVENT
} from '../data/cloud/cloudBackup.js';
import { listDevices, requestErase, cancelErase, releaseDeviceLicense } from '../data/cloud/cloudDevices.js';
import {
  entitlement, cachedEntitlement, startPurchaseLink, finishPurchaseLink, unlinkPurchaseEmails
} from '../data/cloud/cloudEntitlement.js';
import { CloudOfflineError, CloudRequestError, CloudAuthError } from '../data/cloud/cloudApi.js';
import {
  isCloudOfferPending, setCloudOfferPending, getCloudRestoredAt, setCloudRestoredAt, getProLicense, getLastBackupDate
} from '../data/settings.js';
import { isLicenseGated } from '../data/license.js';
import { hasSampleData } from '../data/sampleData.js';
import { getMyKennelName, shouldRequireKennelSetup } from '../data/kennelSetup.js';
import { dismiss, dismissedAt, undismiss } from '../data/nudgeState.js';

// --- Small helpers --------------------------------------------------------------

// The vault's screens (Private Vault Plan §2), loaded on first use.
const vaultUI = () => import('./cloudVaultUI.js');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// "just now", "4 minutes ago", "3 hours ago", "2 days ago".
export function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!t) return 'never';
  const d = Math.max(0, now - t);
  if (d < MINUTE) return 'just now';
  if (d < HOUR) { const m = Math.round(d / MINUTE); return `${m} minute${m === 1 ? '' : 's'} ago`; }
  if (d < DAY) { const h = Math.round(d / HOUR); return `${h} hour${h === 1 ? '' : 's'} ago`; }
  const days = Math.round(d / DAY);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// "Today 9:14", "Yesterday 18:02", "Tue Sep 29 9:14" (plan §2.3).
export function snapshotLabel(iso, now = new Date(), { seconds = false } = {}) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) });
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= startOfToday) return `Today ${time}`;
  if (d.getTime() >= startOfToday - DAY) return `Yesterday ${time}`;
  const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return `${date} ${time}`;
}

// The status line on the card and the nudge (plan §2.2).
export function statusLine(status, now = Date.now()) {
  if (!status.enabled && status.movedToEdition === 'pro') return 'Backup is off on this device: your records moved to KennelOS Pro.';
  if (!status.enabled) return 'Backup is off on this device.';
  if (!status.lastPushedAt) return status.lastError?.code === 'offline' ? 'Not backed up yet: no internet?' : 'Not backed up yet.';
  const age = now - Date.parse(status.lastPushedAt);
  if (status.dirty && age > DAY) {
    const days = Math.max(1, Math.round(age / DAY));
    return `Not backed up for ${days} day${days === 1 ? '' : 's'}: no internet?`;
  }
  return `Backed up ${relativeTime(status.lastPushedAt, now)}.`;
}

function pausedReason(lastError) {
  switch (lastError?.code) {
    case 'conflict': if (lastError.movedToEdition === 'pro') return 'Your records moved to KennelOS Pro.';
      return lastError.ownDevice
      ? 'The cloud already has a backup from this device, made before it was reset.'
      : `Backups are coming from ${lastError.backingDevice?.label || 'another device'}.`;
    case 'shrink': return 'This device has far fewer records than your last backup.';
    case 'auth': return 'Your sign-in has expired.';
    case 'vault_locked': return lastError.stale
      ? 'Sensitive records backup was turned off and on again on another device. Unlock it here with the new recovery code.'
      : 'Your sensitive records are locked on this device. Unlock them to keep backing up.';
    default: return null;
  }
}

export function errorText(e) {
  if (e instanceof CloudOfflineError) return 'No internet connection (or cloud backup is briefly down for maintenance). Try again shortly.';
  if (e instanceof CloudAuthError) return 'Your cloud sign-in has expired. Sign in again.';
  if (e instanceof CloudRequestError) {
    switch (e.code) {
      case 'bad_email': return "That doesn't look like an email address.";
      case 'invalid_code': return "That code isn't right, or it has expired. Check it, or send a new one.";
      case 'too_many_attempts': return 'Too many tries with that code. Send a new one.';
      case 'rate_limited': return 'Too many codes requested. Wait an hour, then try again.';
      case 'email_unavailable': return "Sign-in isn't available right now. Try again later.";
      case 'email_failed': return "We couldn't send the email. Try again in a minute.";
      case 'this_device': return "That's this device. Use Reset App to erase it.";
      case 'not_pending': return 'That device has already erased itself, so there is nothing to cancel.';
      case 'not_found': return "That device isn't on this account any more.";
      case 'own_email': return "That's the email this account signs in with. Use the address you bought Pro with.";
      default: return `Cloud backup refused that (${e.code || e.status}).`;
    }
  }
  if (e && e.name === 'CapExceededError') {
    return `This backup has ${e.current} active dogs. KennelOS Lite keeps up to ${e.limit}, so nothing was restored. Upgrade to Pro to restore it.`;
  }
  return e?.message || String(e);
}

// A modal shell matching ui.js's (.modal-overlay > .modal). Returns the overlay.
export function openModal(innerHtml, { width = 460, dismissible = true } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true" style="max-width:${width}px;">${innerHtml}</div>`;
  document.body.appendChild(overlay);
  if (!dismissible) overlay.addEventListener('click', (e) => { if (e.target === overlay) e.stopPropagation(); }, true);
  return overlay;
}

// A typed confirmation ("type REPLACE"). Resolves true/false.
export function typedConfirm({ title, message, phrase, confirmLabel }) {
  return new Promise((resolve) => {
    const overlay = openModal(`
      <h2 style="margin-top:0;">${esc(title)}</h2>
      <p class="muted" style="white-space:pre-wrap;">${esc(message)}</p>
      <div class="field field-wide">
        <label>Type <strong>${esc(phrase)}</strong> to confirm</label>
        <input id="tc-input" type="text" autocomplete="off" placeholder="${esc(phrase)}">
      </div>
      <div class="form-actions">
        <button class="btn btn-danger" id="tc-ok" disabled>${esc(confirmLabel)}</button>
        <button class="btn" id="tc-cancel">Cancel</button>
      </div>`);
    const input = overlay.querySelector('#tc-input');
    const ok = overlay.querySelector('#tc-ok');
    const done = (v) => { overlay.remove(); resolve(v); };
    input.addEventListener('input', () => { ok.disabled = input.value.trim() !== phrase; });
    ok.addEventListener('click', () => done(true));
    overlay.querySelector('#tc-cancel').addEventListener('click', () => done(false));
    input.focus();
  });
}

// A "working…" modal with an optional progress bar. Returns { update, close }.
export function progressModal(title) {
  const overlay = openModal(`
    <h2 style="margin-top:0;">${esc(title)}</h2>
    <p class="muted" id="pg-text">Working…</p>
    <progress id="pg-bar" style="width:100%;" hidden></progress>`, { dismissible: false });
  return {
    update(text, done = null, total = null) {
      overlay.querySelector('#pg-text').textContent = text;
      const bar = overlay.querySelector('#pg-bar');
      if (total) { bar.hidden = false; bar.max = total; bar.value = done; } else bar.hidden = true;
    },
    close() { overlay.remove(); }
  };
}

// Today's "turn on" nudge: dismissing it snoozes it for 30 days (plan §2.1).
const NUDGE_KEY = 'cloud-backup-offer';
const NUDGE_SNOOZE_MS = 30 * DAY;

export const notify = () => { try { window.dispatchEvent(new CustomEvent(CLOUD_BACKUP_EVENT, { detail: { status: 'ui' } })); } catch { /* fine */ } };

// --- Sign-in (plan §2.1) ------------------------------------------------------------
// Email → code. A typed code, not a link: an iPhone home-screen app has its own
// storage, separate from Safari's, and a link would sign in the wrong copy.
// Resolves the account on success, null on cancel.
export function signInModal({ title = 'Sign in to cloud backup', intro = '' } = {}) {
  return new Promise((resolve) => {
    const overlay = openModal(`<div id="si-body"></div>`);
    const body = overlay.querySelector('#si-body');
    const done = (v) => { overlay.remove(); resolve(v); };
    let email = currentAccount()?.email || '';
    let deviceLabel = currentAccount()?.deviceLabel || defaultDeviceLabel();

    const showEmail = (errorMsg = '') => {
      body.innerHTML = `
        <h2 style="margin-top:0;">${esc(title)}</h2>
        ${intro ? `<p class="muted">${esc(intro)}</p>` : ''}
        <div class="field field-wide"><label for="si-email">Your email</label>
          <input id="si-email" type="email" autocomplete="email" inputmode="email" value="${esc(email)}" placeholder="you@example.com"></div>
        <div class="field field-wide"><label for="si-device">Name this device</label>
          <input id="si-device" type="text" maxlength="60" value="${esc(deviceLabel)}">
          <span class="field-hint">Shown on your other devices, e.g. "Backups are coming from Jen's iPhone".</span></div>
        <p class="field-hint">We use your email to send your code. We don't keep it.</p>
        ${errorMsg ? `<div class="inline-error">${esc(errorMsg)}</div>` : ''}
        <div class="form-actions">
          <button class="btn btn-primary" id="si-send">Email me a code</button>
          <button class="btn" id="si-cancel">Cancel</button>
        </div>`;
      const input = body.querySelector('#si-email');
      const send = async () => {
        email = input.value.trim();
        deviceLabel = body.querySelector('#si-device').value.trim() || defaultDeviceLabel();
        const btn = body.querySelector('#si-send');
        btn.disabled = true; btn.textContent = 'Sending…';
        try { await startSignIn(email); showCode(); } catch (e) { showEmail(errorText(e)); }
      };
      body.querySelector('#si-send').addEventListener('click', send);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
      body.querySelector('#si-cancel').addEventListener('click', () => done(null));
      input.focus();
    };

    const showCode = (errorMsg = '', note = '') => {
      body.innerHTML = `
        <h2 style="margin-top:0;">Check your email</h2>
        <p class="muted">We sent a 6-digit code to <strong>${esc(email)}</strong>. Type it here within 10 minutes.</p>
        <div class="field"><label for="si-code">Code</label>
          <input id="si-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123456" style="font-size:20px;letter-spacing:4px;max-width:180px;"></div>
        ${note ? `<p class="field-hint">${esc(note)}</p>` : ''}
        ${errorMsg ? `<div class="inline-error">${esc(errorMsg)}</div>` : ''}
        <p class="field-hint">Didn't get it? Check your spam folder, or <a href="#" id="si-resend">send a new code</a>.</p>
        <div class="form-actions">
          <button class="btn btn-primary" id="si-verify">Sign in</button>
          <button class="btn" id="si-back">Use a different email</button>
          <button class="btn" id="si-cancel">Cancel</button>
        </div>`;
      const input = body.querySelector('#si-code');
      const verify = async () => {
        const btn = body.querySelector('#si-verify');
        btn.disabled = true; btn.textContent = 'Checking…';
        try {
          await verifySignIn(email, input.value, { deviceLabel });
          notify();
          done(currentAccount());
        } catch (e) {
          if (e instanceof CloudRequestError && e.code === 'too_many_attempts') showEmail(errorText(e));
          else showCode(errorText(e));
        }
      };
      body.querySelector('#si-verify').addEventListener('click', verify);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') verify(); });
      body.querySelector('#si-resend').addEventListener('click', async (e) => {
        e.preventDefault();
        try { await startSignIn(email); showCode('', 'A new code is on its way. Only the newest code works.'); } catch (err) { showCode(errorText(err)); }
      });
      body.querySelector('#si-back').addEventListener('click', () => showEmail());
      body.querySelector('#si-cancel').addEventListener('click', () => done(null));
      input.focus();
    };

    showEmail();
  });
}

// --- "What gets backed up" (plan §2.1 step 3) ------------------------------------
function whatGetsBackedUpModal() {
  return new Promise((resolve) => {
    const overlay = openModal(`
      <h2 style="margin-top:0;">What gets backed up</h2>
      <p><strong>Backed up to the cloud:</strong> your dogs, litters, pairings, health records and
        test results, kennels, contacts' <strong>names</strong>, and your waitlist: its order, settings,
        application form, and each applicant's <strong>name and email</strong>.</p>
      <p><strong>Stays only on this device:</strong> contacts' phone, email and address, prices and
        payments (including waitlist fees paid), Financials, contracts, receipts, the rest of each
        application's answers, and your notes.</p>
      <p class="muted">${isVaultOffered()
        ? 'Next, you can also back those up <strong>encrypted</strong>, so only you can open them. Or download a file backup now and then from <a href="import-export.html">Import / Export</a>.'
        : 'To keep a copy of those too, download a file backup now and then from <a href="import-export.html">Import / Export</a>.'}</p>
      <p class="field-hint">Backups run automatically after you make changes. The last 30 days are kept,
        so you can roll back to an earlier day.</p>
      <div class="form-actions">
        <button class="btn btn-primary" id="wb-on">Turn on</button>
        <button class="btn" id="wb-cancel">Not now</button>
      </div>`, { width: 500 });
    const done = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelector('#wb-on').addEventListener('click', () => done(true));
    overlay.querySelector('#wb-cancel').addEventListener('click', () => done(false));
  });
}

// Run a push with a progress modal, then deal with whatever came back.
async function pushWithProgress(run, title = 'Backing up…') {
  const pg = progressModal(title);
  let result;
  try {
    result = await run((p) => {
      if (p.phase === 'files' && p.total) pg.update(`Uploading documents: ${p.done + 1} of ${p.total}…`, p.done, p.total);
      else pg.update('Uploading your records…');
    });
  } finally {
    pg.close();
  }
  await handlePushResult(result);
  notify();
  return result;
}

// "Turn on": sign in if needed → what's backed up → first backup.
export async function turnOnFlow() {
  if (!isCloudAvailable()) return false;
  let account = currentAccount();
  if (!account?.signedIn) {
    account = await signInModal({ title: 'Turn on cloud backup', intro: 'Sign in with your email. We\'ll send you a 6-digit code — no password to remember.' });
    if (!account) return false;
  }
  if (!(await whatGetsBackedUpModal())) return false;
  const result = await pushWithProgress((onProgress) => enableBackup({ onProgress }));
  // Private Vault Plan §2.1: offered after the first backup succeeds.
  if (result?.status === 'pushed' && isVaultOffered() && getBackupStatus().vault !== 'on') {
    const ui = await vaultUI();
    if ((await ui.refreshVaultState()) === 'off') await ui.turnOnVaultFlow({ offer: true });
  }
  return true;
}

// --- Push results → the user (plan §3.4, §3.5) ------------------------------------
export async function handlePushResult(result) {
  switch (result?.status) {
    case 'pushed':
    case 'unchanged':
    case 'skipped':
      return;
    case 'offline':
      await alertModal({ title: 'Backup is on', message: "There's no internet connection right now, so it will back up automatically when you're back online." });
      return;
    case 'conflict':
      await conflictDialog(result);
      return;
    case 'shrink':
      await shrinkDialog(result);
      return;
    case 'vault_locked': {
      const unlocked = await (await vaultUI()).unlockModal({
        merge: true,
        intro: result.stale
          ? 'Sensitive records backup was turned off and on again on another device, so it has a new recovery code. Unlock it here to keep backing up.'
          : 'This account backs up sensitive records, encrypted. Unlock them on this device to keep backing up.'
      });
      if (unlocked) await pushWithProgress((onProgress) => pushIfDirty({ force: true, onProgress }));
      return;
    }
    case 'auth': {
      const account = await signInModal({ title: 'Sign in again', intro: 'Your cloud sign-in has expired. Backup is paused until you sign in again. Your records on this device are untouched.' });
      if (account) await pushWithProgress((onProgress) => pushIfDirty({ force: true, onProgress }));
      return;
    }
    default:
      await alertModal({ title: "Backup didn't finish", message: result?.message || 'Something went wrong. It will try again automatically.' });
  }
}

// One backup device at a time (plan §3.4): restore theirs here, or replace it.
// A Lite device whose program is now backed up from Pro gets movedToProDialog
// first: that's an upgrade, not a second device.
async function conflictDialog(result, { skipMoved = false } = {}) {
  if (!skipMoved && result.movedToEdition === 'pro') return movedToProDialog(result);
  const kennel = (await getMyKennelName()) || 'your program';
  const who = result.backingDevice?.label || 'another device';
  const when = result.backingDevice?.lastPushAt ? ` (last backup ${relativeTime(result.backingDevice.lastPushAt)})` : '';
  const message = result.ownDevice
    ? `The cloud already has a backup of ${kennel} from this device${when}, made before it was reset or signed out.`
    : `Backups for ${kennel} are coming from ${who}${when}. Only one device backs up at a time.`;
  const choice = await new Promise((resolve) => {
    const overlay = openModal(`
      <h2 style="margin-top:0;">There's already a backup</h2>
      <p class="muted">${esc(message)}</p>
      <ul class="muted" style="padding-left:18px;">
        <li><strong>Restore that backup here</strong> — its records are merged into this device (anything newer here is kept, and nothing sensitive here is lost). This device then takes over the backups.</li>
        <li><strong>Replace it with this device's records</strong> — this device's records become the backup. The old one stays in the 30-day history.</li>
      </ul>
      <div class="form-actions">
        <button class="btn btn-primary" data-v="restore">Restore that backup here</button>
        <button class="btn" data-v="replace">Replace it…</button>
        <button class="btn" data-v="cancel">Not now</button>
      </div>`, { width: 520 });
    overlay.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => { overlay.remove(); resolve(b.dataset.v); }));
  });

  if (choice === 'restore') return restoreAndTakeOverFlow();
  if (choice === 'replace') {
    const ok = await typedConfirm({
      title: 'Replace the cloud backup?',
      message: `This device's records become the backup for ${kennel}. Backups from ${who} stop. The old backup stays in the 30-day history, so you can still restore it.`,
      phrase: 'REPLACE',
      confirmLabel: 'Replace the backup'
    });
    if (!ok) return;
    try {
      await pushWithProgress((onProgress) => replaceCloudWithThisDevice({ onProgress }), 'Replacing the backup…');
    } catch (e) {
      await alertModal({ title: "That didn't work", message: errorText(e) });
    }
  }
}

// Editions Plan, "Converting Lite → Pro": the owner restored this program into
// Pro, which now backs it up. The answer is to stop backing up here, not to
// fight over it. "Other choices…" still reaches the usual restore / replace.
async function movedToProDialog(result) {
  const kennel = (await getMyKennelName()) || 'your program';
  const who = result.backingDevice?.label;
  const when = result.backingDevice?.lastPushAt ? `, last backup ${relativeTime(result.backingDevice.lastPushAt)}` : '';
  const choice = await new Promise((resolve) => {
    const overlay = openModal(`
      <h2 style="margin-top:0;">Your records moved to KennelOS Pro</h2>
      <p class="muted">${esc(`${kennel} is now backed up from KennelOS Pro${who ? ` (${who}${when})` : ''}. Keep working in Pro; changes made here in Lite won't reach it.`)}</p>
      <p class="muted">Turning off backup here leaves your Pro backup exactly as it is. Your records on this device stay too.</p>
      <div class="form-actions">
        <button class="btn btn-primary" data-v="off">Turn off backup here</button>
        <button class="btn" data-v="other">Other choices…</button>
        <button class="btn" data-v="cancel">Not now</button>
      </div>`, { width: 520 });
    overlay.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => { overlay.remove(); resolve(b.dataset.v); }));
  });
  if (choice === 'off') {
    disableBackup({ movedToEdition: 'pro' });
    window.dispatchEvent(new CustomEvent(CLOUD_BACKUP_EVENT, { detail: { status: 'skipped' } }));
  }
  if (choice === 'other') return conflictDialog(result, { skipMoved: true });
}

async function restoreAndTakeOverFlow() {
  if (isVaultOffered()) await (await vaultUI()).unlockBeforeRestore();
  const pg = progressModal('Restoring the backup…');
  try {
    const { restored, push } = await restoreLatestAndTakeOver({
      onProgress: (done, total) => pg.update(`Downloading documents: ${done} of ${total}…`, done, total)
    });
    pg.close();
    if (restored?.missingFiles?.length) {
      await alertModal({ title: 'Restored', message: `${restored.missingFiles.length} document file(s) couldn't be downloaded. Try again later from Import / Export.` });
    }
    await handlePushResult(push);
    location.reload();
  } catch (e) {
    pg.close();
    await alertModal({ title: "That didn't work", message: errorText(e) });
  }
}

// The shrink guard's question (plan §3.5).
async function shrinkDialog(result) {
  const s = result.shrink || {};
  const lines = [];
  if (s.dogs) lines.push(`Dogs: ${s.dogs.previous} in the backup, ${s.dogs.next} here`);
  if (s.total) lines.push(`All records: ${s.total.previous} in the backup, ${s.total.next} here`);
  const choice = await new Promise((resolve) => {
    const overlay = openModal(`
      <h2 style="margin-top:0;">This device has far fewer records than your last backup</h2>
      <p class="muted">${lines.map(esc).join('<br>')}</p>
      <p class="muted">That can happen after clearing the browser, a "Replace" import, or Reset App. Backup is paused so the good copy isn't overwritten.</p>
      <div class="form-actions">
        <button class="btn btn-primary" data-v="restore">Restore from backup instead</button>
        <button class="btn btn-danger" data-v="upload">Upload anyway</button>
        <button class="btn" data-v="cancel">Not now</button>
      </div>`, { width: 520 });
    overlay.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => { overlay.remove(); resolve(b.dataset.v); }));
  });
  if (choice === 'restore') return restoreAndTakeOverFlow();
  if (choice === 'upload') await pushWithProgress((onProgress) => pushIfDirty({ force: true, allowShrink: true, onProgress }));
}

// --- Restore as of… (plan §2.3, §4.3) ------------------------------------------------
// The backups to choose from, as <option> data. Two backups in the same minute
// ("Back up now" twice) would read the same, so a repeated label gets its seconds.
function snapshotOptions(snapshots) {
  const labels = snapshots.map((s) => snapshotLabel(s.createdAt));
  return snapshots.map((s, i) => ({
    value: s.id,
    label: `${labels.filter((l) => l === labels[i]).length > 1 ? snapshotLabel(s.createdAt, new Date(), { seconds: true }) : labels[i]}`
      + ` — ${s.counts?.dogs ?? 0} dogs${s.deviceLabel ? `, from ${s.deviceLabel}` : ''}`
  }));
}

// Roll back to the backup picked in the card's dropdown: load it, say what would
// change, and write nothing until she confirms.
async function rollBackTo(id, snapshots) {
  const chosen = snapshots.find((s) => s.id === id);
  if (!chosen) return;

  const pg = progressModal('Loading that backup…');
  let envelope; let preview;
  try {
    envelope = await downloadSnapshot(id);
    preview = await previewRestore(envelope, { overwrite: true });
  } catch (e) {
    pg.close();
    return alertModal({ title: "Couldn't load that backup", message: errorText(e) });
  }
  pg.close();
  const sum = (k) => Object.values(preview.summary).reduce((n, s) => n + (s[k] || 0), 0);
  const updated = sum('updated');
  const inserted = sum('inserted');
  if (!updated && !inserted) return alertModal({ title: 'Nothing to restore', message: `Your records already match the backup from ${snapshotLabel(chosen.createdAt)}.` });

  const ok = await confirmModal({
    title: `Roll back to ${snapshotLabel(chosen.createdAt)}?`,
    message: [
      updated ? `${updated} record(s) will be rolled back to how they were then.` : '',
      inserted ? `${inserted} record(s) missing here will be added back.` : '',
      chosen.vaultKeyId && getBackupStatus().vault === 'on'
        ? 'Their sensitive records (phone numbers, prices, notes…) roll back too, from the encrypted backup.'
        : 'Their sensitive records (phone numbers, prices, notes…) keep their current values: those aren\'t in this backup, so they can\'t roll back.',
      'Records added since then stay. Archive them by hand if you don\'t want them.'
    ].filter(Boolean).join('\n\n'),
    confirmLabel: 'Roll back',
    danger: true
  });
  if (!ok) return;
  const pg2 = progressModal('Restoring…');
  try {
    const r = await restoreSnapshot(envelope, { overwrite: true, onProgress: (d, t) => pg2.update(`Downloading documents: ${d} of ${t}…`, d, t) });
    pg2.close();
    await alertModal({
      title: 'Rolled back',
      message: r.missingFiles?.length ? `Done. ${r.missingFiles.length} document file(s) couldn't be downloaded.` : 'Done. Reloading…'
    });
    location.reload();
  } catch (e) {
    pg2.close();
    await alertModal({ title: "That didn't work", message: errorText(e) });
  }
}

// --- Import/Export: the Cloud destination of Backup & restore (plan §2.2, §2.4) --------
// The card and its two axes (Back up | Restore, and where to/from) belong to
// pages/import-export.js. This fills the Cloud destination's pane, in the same
// shape as the other two: a blurb, "Last backup", the action (Back up now, or the
// backups to roll back to, right on the page), and a connection strip at the foot.
// `getMode()` says which side is showing ('backup' | 'restore'). Returns the
// render function, which the page calls when the tab or destination changes.
export function mountCloudPane(el, getMode) {
  if (!el || !isCloudAvailable()) return () => {};
  const render = () => { if (!el.hidden) renderPane(el, getMode(), render); };
  // A background push must not rebuild a dropdown she has open.
  window.addEventListener(CLOUD_BACKUP_EVENT, () => {
    if (el.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
    render();
  });
  // Learn the vault's state from the server once per visit (another device may
  // have turned it on or off); refreshVaultState re-renders through the event.
  if (isVaultOffered() && currentAccount()?.signedIn) vaultUI().then((ui) => ui.refreshVaultState()).catch(() => {});
  return render;
}

const backupStamp = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Never');

// The cloud backups, fetched once per (account, last backup) so a re-render
// doesn't ask the server again.
let snapshotCache = null;
function cachedSnapshots(status) {
  const key = `${status.account?.email || ''}|${status.lastPushedAt || ''}`;
  if (!snapshotCache || snapshotCache.key !== key) {
    const promise = listSnapshots();
    snapshotCache = { key, promise };
    promise.catch(() => { if (snapshotCache?.promise === promise) snapshotCache = null; });
  }
  return snapshotCache.promise;
}

// Sensitive records (the encrypted tier, Private Vault Plan §2.2): one dropdown.
// It reads Off, Locked or On; everything you can do with it is a choice in the
// list, and choosing one opens its dialog at once.
function sensitiveField(status) {
  if (!(isVaultOffered() || status.vault === 'on' || status.vault === 'locked')) return '';
  const what = "Contacts' phone, email and address, prices, Financials, contracts and your notes";
  let current; let choices; let hint;
  if (status.vault === 'on') {
    current = status.vaultPushedAt ? `On · backed up ${relativeTime(status.vaultPushedAt)}` : 'On';
    choices = [['vault-approve', 'Unlock another device…'], ['vault-passkeys', 'Passkeys…'], ['vault-code', 'New recovery code…'], ['vault-off', 'Turn off…']];
    hint = `${what}, encrypted so only you can open them.`;
  } else if (status.vault === 'locked') {
    current = 'Locked on this device';
    choices = [['vault-unlock', 'Unlock…']];
    hint = `${what} are backed up encrypted. Unlock them here to bring them back and keep backing up.`;
  } else {
    current = 'Off';
    choices = status.enabled && isVaultOffered() ? [['vault-on', 'Turn on…']] : [];
    hint = `${what} stay only on this device. Last file backup: ${relativeTime(getLastBackupDate())}.`;
  }
  return `<div class="field" style="max-width:340px;margin-top:12px;">
      <label for="cb-sensitive">Sensitive records</label>
      <select id="cb-sensitive"${choices.length ? '' : ' disabled'}>
        <option value="" selected>${esc(current)}</option>
        ${choices.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}
      </select>
      <span class="field-hint">${esc(hint)}</span>
    </div>`;
}

function renderPane(el, mode, rerender) {
  const status = getBackupStatus();
  const account = status.account;
  const signedIn = !!account?.signedIn;
  const restoredAt = getCloudRestoredAt();
  const paused = status.enabled ? pausedReason(status.lastError) : null;
  const restoring = mode === 'restore';

  // --- The strip at the foot: is cloud backup on here, and the one way to change that.
  let stripText; let stripBtn; let stripOn = false;
  if (!account) {
    stripText = 'Cloud backup off';
    stripBtn = restoring ? ['restore-new', 'Sign in and restore'] : ['on', 'Turn on'];
  } else if (!signedIn) {
    stripText = `Sign-in expired · ${account.email || ''}`;
    stripBtn = ['signin', 'Sign in again'];
  } else if (status.enabled) {
    stripOn = true;
    stripText = `Cloud backup on · ${account.email || ''}`;
    stripBtn = ['off', 'Turn off'];
  } else {
    stripText = `Cloud backup off on this device · ${account.email || ''}`;
    stripBtn = ['on', 'Turn on'];
  }
  const strip = `<div class="dbx-strip">
      <span class="dbx-status"><span class="dbx-dot${stripOn ? ' dbx-dot-on' : ''}"></span> ${esc(stripText)}</span>
      <button class="btn btn-sm" type="button" data-act="${stripBtn[0]}">${esc(stripBtn[1])}</button>
    </div>`;

  // --- "Last backup", in the other destinations' format, with what's worth adding.
  let aside = '';
  if (signedIn && !status.enabled && status.movedToEdition === 'pro') aside = 'Your records moved to KennelOS Pro.';
  else if (signedIn && status.enabled && !paused) {
    const line = statusLine(status);
    if (/no internet/.test(line)) aside = line;
    else if (status.dirty) aside = 'Recent changes will back up shortly.';
  }
  const lastBackup = `<p class="muted">Last backup: <strong>${esc(backupStamp(status.lastPushedAt))}</strong>${aside ? ` <span class="faint">${esc(aside)}</span>` : ''}</p>`;
  const pausedWarn = paused
    ? `<div class="inline-warn">Backup is paused: ${esc(paused)} <button class="btn btn-sm" data-act="resolve" style="margin-left:6px;">${status.lastError?.code === 'vault_locked' ? 'Unlock…' : 'Resolve…'}</button></div>`
    : '';

  let body;
  if (restoring) {
    body = `
      <p class="muted">Roll back to an earlier cloud backup. Records go back to how they were then; nothing is deleted, and nothing changes until you confirm.</p>
      ${signedIn ? lastBackup : ''}
      <div class="field" style="max-width:340px;">
        <label for="cb-asof">Restore as of</label>
        <select id="cb-asof" disabled><option value="">${signedIn ? 'Loading your backups…' : 'Sign in to see your backups'}</option></select>
      </div>
      ${signedIn ? sensitiveField(status) : ''}`;
  } else {
    const ready = signedIn && status.enabled;
    body = `
      <p class="muted">Backs up your kennel records automatically after you make changes, free. If this device is lost or replaced, sign in on the new one with your email and everything comes back.</p>
      ${signedIn ? lastBackup : ''}
      ${pausedWarn}
      <button class="btn btn-primary" data-act="now"${ready ? '' : ' disabled'}>⬆ Back up now</button>
      ${signedIn ? sensitiveField(status) : ''}`;
  }

  el.innerHTML = `
    ${restoredAt ? `<div class="inline-warn" style="margin-bottom:10px;">Restored from cloud backup ${esc(relativeTime(restoredAt))}.
      Sensitive records (contacts' phone, email and address, prices, notes) are blank on this device.
      ${status.vault === 'locked'
        ? 'Unlock them under Sensitive records to bring them back.'
        : 'If you have a file backup, restore it from <strong>This device</strong> with <strong>Merge</strong> to bring them back.'}
      <button class="btn btn-sm" data-act="hide-restored" style="margin-left:6px;">Got it</button></div>` : ''}
    ${body}
    ${strip}`;

  const guarded = async (control, fn) => {
    control.disabled = true;
    try { await fn(); } catch (err) { await alertModal({ title: "That didn't work", message: errorText(err) }); }
    finally { rerender(); }
  };
  const act = (name, fn) => el.querySelector(`[data-act="${name}"]`)?.addEventListener('click', (e) => guarded(e.currentTarget, fn));

  act('on', turnOnFlow);
  act('restore-new', async () => { if (await runSignInAndRestore({ fromCard: true })) location.reload(); });
  act('signin', async () => {
    const acc = await signInModal({ title: 'Sign in again' });
    if (acc) await pushWithProgress((onProgress) => pushIfDirty({ force: true, onProgress }));
  });
  act('resolve', () => (status.lastError?.code === 'vault_locked'
    ? handlePushResult({ status: 'vault_locked', stale: !!status.lastError.stale })
    : pushWithProgress((onProgress) => pushIfDirty({ force: true, onProgress }))));
  act('now', () => pushWithProgress((onProgress) => pushIfDirty({ force: true, onProgress })));
  act('off', async () => {
    if (await confirmModal({ title: 'Turn off backup on this device?', message: 'Changes on this device stop backing up. The cloud copy stays, and you can turn it back on any time.', confirmLabel: 'Turn off' })) disableBackup();
  });
  act('hide-restored', () => setCloudRestoredAt(null));

  // Sensitive records: choosing an entry opens its dialog straight away.
  const sensitive = el.querySelector('#cb-sensitive');
  const vaultActions = {
    'vault-on': (ui) => ui.turnOnVaultFlow(),
    'vault-unlock': (ui) => ui.unlockModal({ merge: true }),
    'vault-approve': (ui) => ui.approveDevicesModal(),
    'vault-passkeys': (ui) => ui.passkeysModal(),
    'vault-code': (ui) => ui.newRecoveryCodeFlow(),
    'vault-off': (ui) => ui.turnOffVaultFlow()
  };
  sensitive?.addEventListener('change', () => {
    const run = vaultActions[sensitive.value];
    if (run) guarded(sensitive, async () => run(await vaultUI()));
  });

  // Restore: the backups are listed right here; choosing one starts the roll back.
  const asOf = el.querySelector('#cb-asof');
  if (asOf && signedIn) {
    cachedSnapshots(status).then((snapshots) => {
      if (!asOf.isConnected) return; // re-rendered meanwhile
      if (!snapshots.length) { asOf.innerHTML = '<option value="">No cloud backups yet</option>'; return; }
      asOf.innerHTML = '<option value="" selected>Choose a backup…</option>'
        + snapshotOptions(snapshots).map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
      asOf.disabled = false;
      asOf.addEventListener('change', () => { if (asOf.value) guarded(asOf, () => rollBackTo(asOf.value, snapshots)); });
    }).catch((e) => {
      if (!asOf.isConnected) return;
      asOf.innerHTML = '<option value="">Couldn\'t load your backups</option>';
      asOf.insertAdjacentHTML('afterend', `<span class="field-hint">${esc(errorText(e))}</span>`);
    });
  }
}

// --- Settings: the Account card ------------------------------------------------------------
// The cloud sign-in itself (who, which device, Pro on this account, the other
// devices, sign out, delete). Backups are on Import/Export; this is the account.
export function mountCloudAccountCard(el) {
  if (!el || !isCloudAvailable()) { if (el) el.remove(); return; }
  el.hidden = false;
  const render = () => renderAccountCard(el);
  window.addEventListener(CLOUD_BACKUP_EVENT, render);
  render();
}

function renderAccountCard(el) {
  const account = currentAccount();
  let main;
  if (!account) {
    main = `<p class="muted">Not signed in. Your account is the email you sign in to cloud backup with; turn cloud backup on from <a href="import-export.html">Import / Export</a>.</p>`;
  } else if (!account.signedIn) {
    main = `
      <p class="muted">Signed in as <strong>${esc(account.email || '')}</strong>, but the sign-in has expired.
        Backup is paused until you sign in again. Your records here are untouched.</p>
      <div class="form-actions"><button class="btn btn-primary" data-act="signin">Sign in again</button>
        <button class="btn" data-act="signout">Sign out</button></div>`;
  } else {
    main = `
      <p>Signed in as <strong>${esc(account.email || '')}</strong>${account.deviceLabel ? ` <span class="faint">· this device: ${esc(account.deviceLabel)}</span>` : ''}</p>
      ${isLicenseGated() ? `<p class="field-hint" data-pro-line>${esc(proLineText(cachedEntitlement()))}</p>` : ''}
      <div class="form-actions">
        ${isLicenseGated() ? `<button class="btn btn-sm" data-act="pro-link"${cachedEntitlement()?.pro ? ' hidden' : ''}>Link a Pro purchase email…</button>
        <button class="btn btn-sm" data-act="pro-unlink"${cachedEntitlement()?.linkedEmails ? '' : ' hidden'}>Unlink purchase emails</button>` : ''}
        <button class="btn btn-sm" data-act="devices">Your devices…</button>
        <button class="btn btn-sm" data-act="others">Sign out other devices</button>
        <button class="btn btn-sm" data-act="signout">Sign out</button>
        <button class="btn btn-sm btn-danger" data-act="delete">Delete my cloud data…</button>
      </div>`;
  }
  el.innerHTML = `<h2 style="margin-top:0;">Account</h2>${main}`;

  const act = (name, fn) => el.querySelector(`[data-act="${name}"]`)?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try { await fn(); } catch (err) { await alertModal({ title: "That didn't work", message: errorText(err) }); }
    finally { if (btn.isConnected) btn.disabled = false; renderAccountCard(el); }
  });

  act('signin', async () => {
    const acc = await signInModal({ title: 'Sign in again' });
    if (acc) await pushWithProgress((onProgress) => pushIfDirty({ force: true, onProgress }));
  });
  act('devices', () => devicesModal());
  act('others', async () => {
    if (!(await confirmModal({ title: 'Sign out other devices?', message: 'Every other device signed in to this account is signed out. They keep their records but stop backing up until they sign in again.\n\nLost a device? Use Your devices → Erase instead, which also deletes the records on it.', confirmLabel: 'Sign them out' }))) return;
    const n = await withFreshSignIn((reauth) => signOutOtherDevices(reauth), { purpose: 'sign out your other devices', confirmLabel: 'Sign them out' });
    if (n === null) return;
    await alertModal({ title: 'Done', message: n ? `Signed out ${n} other device(s).` : 'No other devices were signed in.' });
  });
  act('signout', async () => {
    if (await confirmModal({ title: 'Sign out of cloud backup?', message: 'Backup stops on this device. Your records here and the cloud copy both stay.', confirmLabel: 'Sign out' })) await signOut();
  });
  act('delete', async () => {
    const ok = await typedConfirm({
      title: 'Delete your cloud data?',
      message: 'This deletes every cloud backup, every uploaded document and your cloud account. Your records on this device are not touched. There is no undo.',
      phrase: 'DELETE',
      confirmLabel: 'Delete cloud data'
    });
    if (!ok) return;
    if ((await withFreshSignIn((reauth) => deleteCloudData(reauth).then(() => true), { purpose: 'delete your cloud data', confirmLabel: 'Delete cloud data' })) === null) return;
    await alertModal({ title: 'Cloud data deleted', message: 'Your cloud backups and account are gone. Everything on this device is still here.' });
  });
  act('pro-link', () => linkPurchaseModal());
  act('pro-unlink', async () => {
    if (!(await confirmModal({
      title: 'Unlink purchase emails?',
      message: 'Pro purchases made with other email addresses stop counting for this account. The purchases themselves are untouched, and you can link them again.',
      confirmLabel: 'Unlink'
    }))) return;
    await withFreshSignIn((reauth) => unlinkPurchaseEmails({ reauth }), { purpose: 'unlink purchase emails', confirmLabel: 'Unlink' });
  });

  if (el.querySelector('[data-pro-line]')) fillProLine(el);
}

// --- Pro on this account (License Link Plan §5, §6) ------------------------------------
// Whether the SERVER knows this account is Pro: it decides the online features
// that need Pro (the waitlist's), never the app itself, which the license key
// unlocks as before.
const PLAN_LABEL = { monthly: 'monthly', yearly: 'yearly', lifetime: 'lifetime' };

export function proLineText(e, { offline = false } = {}) {
  if (offline) return "Pro on this account: couldn't check (no internet?).";
  if (!e) return 'Pro on this account: checking…';
  if (e.pro) {
    const plan = PLAN_LABEL[e.plan] ? ` (${PLAN_LABEL[e.plan]})` : '';
    const until = e.until ? `, until ${new Date(e.until).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : '';
    return `Pro on this account${plan}${until}${e.source === 'linked' ? ', through a linked purchase email' : ''}.`;
  }
  if (e.lapsed) return "Your Pro purchase for this account has ended, so online features that need Pro are off. Renew it, and they're back.";
  return "This account isn't linked to a Pro purchase yet. Bought Pro with another email address? Link it here.";
}

async function fillProLine(el) {
  let e = null;
  let offline = false;
  try { e = await entitlement(); } catch { offline = true; }
  const line = el.querySelector('[data-pro-line]');
  if (!line) return; // re-rendered meanwhile
  line.textContent = proLineText(e, { offline });
  const link = el.querySelector('[data-act="pro-link"]');
  const unlink = el.querySelector('[data-act="pro-unlink"]');
  if (link) link.hidden = offline || !!e?.pro;
  if (unlink) unlink.hidden = !e?.linkedEmails;
}

// Two steps, like sign-in: the purchase email, then the code sent to it.
// Resolves the new entitlement, or null on cancel.
export function linkPurchaseModal() {
  return new Promise((resolve) => {
    const overlay = openModal('<div id="pl-body"></div>');
    const body = overlay.querySelector('#pl-body');
    const done = (v) => { overlay.remove(); resolve(v); };
    let email = '';

    const showEmail = (errorMsg = '') => {
      body.innerHTML = `
        <h2 style="margin-top:0;">Link a Pro purchase email</h2>
        <p class="muted">If you bought KennelOS Pro with a different email address from the one you sign in with,
          type it here. We'll send a code to it, to check it's yours.</p>
        <div class="field field-wide"><label for="pl-email">Email you bought Pro with</label>
          <input id="pl-email" type="email" autocomplete="email" inputmode="email" value="${esc(email)}" placeholder="you@example.com"></div>
        <p class="field-hint">We use it to send the code, and don't keep it.</p>
        ${errorMsg ? `<div class="inline-error">${esc(errorMsg)}</div>` : ''}
        <div class="form-actions">
          <button class="btn btn-primary" id="pl-send">Email me a code</button>
          <button class="btn" id="pl-cancel">Cancel</button>
        </div>`;
      const input = body.querySelector('#pl-email');
      const send = async () => {
        email = input.value.trim();
        const btn = body.querySelector('#pl-send');
        btn.disabled = true; btn.textContent = 'Sending…';
        try { await startPurchaseLink(email); showCode(); } catch (e) { showEmail(errorText(e)); }
      };
      body.querySelector('#pl-send').addEventListener('click', send);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
      body.querySelector('#pl-cancel').addEventListener('click', () => done(null));
      input.focus();
    };

    const showCode = (errorMsg = '', note = '') => {
      body.innerHTML = `
        <h2 style="margin-top:0;">Check that inbox</h2>
        <p class="muted">We sent a 6-digit code to <strong>${esc(email)}</strong>. Type it here within 10 minutes.</p>
        <div class="field"><label for="pl-code">Code</label>
          <input id="pl-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123456" style="font-size:20px;letter-spacing:4px;max-width:180px;"></div>
        ${note ? `<p class="field-hint">${esc(note)}</p>` : ''}
        ${errorMsg ? `<div class="inline-error">${esc(errorMsg)}</div>` : ''}
        <p class="field-hint">Didn't get it? Check the spam folder, or <a href="#" id="pl-resend">send a new code</a>.</p>
        <div class="form-actions">
          <button class="btn btn-primary" id="pl-verify">Link it</button>
          <button class="btn" id="pl-back">Use a different email</button>
          <button class="btn" id="pl-cancel">Cancel</button>
        </div>`;
      const input = body.querySelector('#pl-code');
      const verify = async () => {
        const btn = body.querySelector('#pl-verify');
        btn.disabled = true; btn.textContent = 'Checking…';
        try {
          const e = await finishPurchaseLink(email, input.value);
          done(e);
          notify();
          await alertModal(e.pro
            ? { title: 'Linked', message: proLineText(e) }
            : { title: 'Linked, but no Pro purchase yet', message: `We haven't been told of a Pro purchase made with ${email}. If you've just bought it, check again in a few minutes. Otherwise, link the address you bought it with.` });
        } catch (e) {
          if (e instanceof CloudRequestError && e.code === 'too_many_attempts') showEmail(errorText(e));
          else showCode(errorText(e));
        }
      };
      body.querySelector('#pl-verify').addEventListener('click', verify);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') verify(); });
      body.querySelector('#pl-resend').addEventListener('click', async (e) => {
        e.preventDefault();
        try { await startPurchaseLink(email); showCode('', 'A new code is on its way. Only the newest code works.'); } catch (err) { showCode(errorText(err)); }
      });
      body.querySelector('#pl-back').addEventListener('click', () => showEmail());
      body.querySelector('#pl-cancel').addEventListener('click', () => done(null));
      input.focus();
    };

    showEmail();
  });
}

// --- Your devices: a lost one (plan §2.5) --------------------------------------------
// Erase: that device deletes every record on it the next time it opens KennelOS
// online. Free its Pro license: this browser calls Lemon Squeezy with the key
// and that device's activation id, so its slot comes back now.
function deviceStatusText(d) {
  if (d.erase?.confirmedAt) return `Erased ${relativeTime(d.erase.confirmedAt)}.`;
  if (d.erase) return `Erase requested ${snapshotLabel(d.erase.requestedAt)}. It happens the next time that device opens KennelOS with an internet connection.`;
  const seen = d.lastSeenAt ? `Last used ${relativeTime(d.lastSeenAt)}` : '';
  if (d.status === 'signed-in') return `${seen || 'Signed in'}.`;
  if (d.status === 'signed-out-here') return `Signed out on that device${seen ? ` · ${seen.toLowerCase()}` : ''}. It can't be erased from here.`;
  return `Signed out${seen ? ` · ${seen.toLowerCase()}` : ''}.`;
}

export function devicesModal({ key = '' } = {}) {
  return new Promise((resolve) => {
    const overlay = openModal('<div id="dv-body"><p class="muted">Loading your devices…</p></div>', { width: 560 });
    const body = overlay.querySelector('#dv-body');
    const done = () => { overlay.remove(); resolve(); };
    const proHere = isLicenseGated();
    let licenseKey = key;

    const render = async () => {
      let devices;
      try {
        devices = await listDevices();
      } catch (e) {
        body.innerHTML = `<h2 style="margin-top:0;">Your devices</h2><div class="inline-error">${esc(errorText(e))}</div>
          <div class="form-actions"><button class="btn" id="dv-close">Close</button></div>`;
        body.querySelector('#dv-close').addEventListener('click', done);
        return;
      }
      const rows = devices.map((d) => {
        const tags = [d.thisDevice ? 'this device' : '', d.backing ? 'backs up your records' : ''].filter(Boolean)
          .map((t) => `<span class="faint">· ${esc(t)}</span>`).join(' ');
        const canErase = !d.thisDevice && !d.erase && d.status !== 'signed-out-here';
        const canCancel = !!d.erase && !d.erase.confirmedAt;
        const canFree = proHere && !d.thisDevice && !!d.licenseInstanceId;
        const actions = [
          canErase ? `<button class="btn btn-sm btn-danger" data-erase="${esc(d.id)}">Erase…</button>` : '',
          canFree ? `<button class="btn btn-sm" data-free="${esc(d.id)}">Free its Pro license</button>` : '',
          canCancel ? `<button class="btn btn-sm" data-cancel="${esc(d.id)}">Found it: cancel the erase</button>` : ''
        ].join('');
        return `<li style="padding:10px 0;border-top:1px solid var(--border);">
            <strong>${esc(d.label || 'Unnamed device')}</strong> ${tags}
            <div class="field-hint">${esc(deviceStatusText(d))}</div>
            ${actions ? `<div class="form-actions" style="margin-top:6px;">${actions}</div>` : ''}
          </li>`;
      }).join('');
      body.innerHTML = `
        <h2 style="margin-top:0;">Your devices</h2>
        <p class="muted">Every device signed in to this cloud account. Lost one? <strong>Erase</strong> it: the next time it
          opens KennelOS with an internet connection, every record on it is deleted.</p>
        ${proHere ? '<p class="field-hint"><strong>Free its Pro license</strong> gives that device\'s slot back, so you can activate Pro on another one.</p>' : ''}
        <ul style="list-style:none;padding:0;margin:0;">${rows || '<li class="muted">No devices.</li>'}</ul>
        <div id="dv-msg"></div>
        <div class="form-actions"><button class="btn" id="dv-close">Close</button></div>`;
      body.querySelector('#dv-close').addEventListener('click', done);

      const byId = new Map(devices.map((d) => [d.id, d]));
      const wire = (attr, fn) => body.querySelectorAll(`[${attr}]`).forEach((btn) => btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const msg = await fn(byId.get(btn.getAttribute(attr)));
          await render();
          if (msg) body.querySelector('#dv-msg').innerHTML = `<div class="inline-warn">${esc(msg)}</div>`;
        } catch (e) {
          await alertModal({ title: "That didn't work", message: errorText(e) });
          if (btn.isConnected) btn.disabled = false;
        }
      }));
      wire('data-erase', async (d) => {
        if (!(await eraseDeviceFlow(d))) return null;
        let msg = `${d.label || 'That device'} will be erased the next time it opens KennelOS online.`;
        if (proHere && d.licenseInstanceId) {
          const freed = await freeLicenseFlow(d);
          if (freed === true) msg += ' Its Pro license is free.';
          else if (freed === false) msg += " Its Pro license couldn't be freed yet; try Free its Pro license again.";
        }
        return msg;
      });
      wire('data-free', async (d) => {
        const freed = await freeLicenseFlow(d);
        if (freed === null) return null;
        return freed ? `${d.label || 'That device'}'s Pro license is free. You can activate Pro on another device now.`
          : "Lemon Squeezy didn't release it. Check the key and your connection. If you've already freed it, there's nothing more to do.";
      });
      wire('data-cancel', async (d) => {
        await cancelErase(d.id);
        return `${d.label || 'That device'} won't be erased. It stays signed out: sign in on it again to keep backing up.`;
      });
    };

    // The key: the one this device is activated with, else the one typed on
    // the activation wall, else ask.
    async function freeLicenseFlow(d) {
      let k = getProLicense()?.key || licenseKey;
      if (!k) {
        k = await promptModal({
          title: 'Your Pro license key',
          message: 'Enter the license key from your purchase confirmation. It goes to Lemon Squeezy only, never to cloud backup.',
          label: 'License key',
          placeholder: 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX',
          confirmLabel: 'Free the license'
        });
        if (!k) return null;
        licenseKey = k;
      }
      return releaseDeviceLicense(d, k);
    }

    render();
  });
}

async function eraseDeviceFlow(d) {
  const name = d.label || 'that device';
  const ok = await typedConfirm({
    title: `Erase ${name}?`,
    message: `The next time ${name} opens KennelOS with an internet connection, every record on it is deleted and it's signed out.`
      + `\n\nUntil then nothing happens to it. If it stays offline or never opens KennelOS again, its records stay on it. Your phone's own Find My (iPhone) or Find My Device (Android) can erase the whole phone.`
      + `\n\nSensitive records (contacts' phone, email and address, prices, Financials, contracts, private notes) aren't in cloud backup. If ${name} has the only copy of them, erasing it loses them, unless you have a file backup that includes them.`
      + `\n\nYour cloud backup isn't touched.`,
    phrase: 'ERASE',
    confirmLabel: `Erase ${name}`
  });
  if (!ok) return false;
  return withFreshSignIn((reauth) => requestErase(d.id, reauth), { purpose: 'erase the device', confirmLabel: 'Erase it' })
    .then((r) => r !== null);
}

// Erasing a device, signing out the others and deleting the cloud data need a
// fresh sign-in: one in the last 15 minutes, or a code just emailed to the
// account, so a stolen phone that is still signed in can't do them (plan
// §2.5). Runs `fn` as is; on reauth_required, asks for a code and runs it
// again with { email, code }. Resolves fn's result, or null on cancel.
export async function withFreshSignIn(fn, { purpose, confirmLabel }) {
  try {
    return await fn({});
  } catch (e) {
    if (!(e instanceof CloudRequestError && e.code === 'reauth_required')) throw e;
  }
  const reauth = await confirmCodeModal({ purpose, confirmLabel });
  if (!reauth) return null;
  return fn(reauth);
}

// Resolves { email, code }, or null on cancel.
function confirmCodeModal({ purpose, confirmLabel }) {
  const email = currentAccount()?.email || '';
  return new Promise((resolve) => {
    const overlay = openModal('<div id="cc-body"></div>');
    const body = overlay.querySelector('#cc-body');
    const done = (v) => { overlay.remove(); resolve(v); };
    const show = (errorMsg = '', note = '') => {
      body.innerHTML = `
        <h2 style="margin-top:0;">Confirm it's you</h2>
        <p class="muted">We sent a 6-digit code to <strong>${esc(email)}</strong>. Type it here within 10 minutes to ${esc(purpose)}.</p>
        <div class="field"><label for="cc-code">Code</label>
          <input id="cc-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123456" style="font-size:20px;letter-spacing:4px;max-width:180px;"></div>
        ${note ? `<p class="field-hint">${esc(note)}</p>` : ''}
        ${errorMsg ? `<div class="inline-error">${esc(errorMsg)}</div>` : ''}
        <p class="field-hint">Didn't get it? Check your spam folder, or <a href="#" id="cc-resend">send a new code</a>.</p>
        <div class="form-actions">
          <button class="btn btn-danger" id="cc-ok">${esc(confirmLabel)}</button>
          <button class="btn" id="cc-cancel">Cancel</button>
        </div>`;
      const input = body.querySelector('#cc-code');
      const ok = () => {
        const code = input.value.replace(/\s/g, '');
        if (!/^\d{6}$/.test(code)) { show('Type the 6-digit code from the email.'); return; }
        done({ email, code });
      };
      body.querySelector('#cc-ok').addEventListener('click', ok);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
      body.querySelector('#cc-resend').addEventListener('click', async (e) => {
        e.preventDefault();
        try { await startSignIn(email); show('', 'A new code is on its way. Only the newest code works.'); } catch (err) { show(errorText(err)); }
      });
      body.querySelector('#cc-cancel').addEventListener('click', () => done(null));
      input.focus();
    };
    startSignIn(email).then(() => show(), (err) => show(errorText(err)));
  });
}

// The Pro activation wall's "Lost a device?" link (licenseGate.js): sign in
// to cloud backup if needed, then the device list, to free the lost device's
// slot. `key` is whatever was typed in the wall's key field.
export async function openDevicesFromLicenseWall({ key = '' } = {}) {
  if (!isCloudAvailable()) return;
  if (!currentAccount()?.signedIn) {
    const account = await signInModal({
      title: 'Free a lost device',
      intro: 'Sign in to your cloud backup account to see the devices on it, then free the Pro license of the one you lost. This works for devices that had cloud backup turned on.'
    });
    if (!account) return;
  }
  await devicesModal({ key });
}

// --- First run: "I already use KennelOS → sign in and restore" (plan §2.3) -------------
// Resolves true when records were restored (the caller reloads), false when the
// user backed out. An account with no backup yet turns backup on and resolves
// 'empty', so first-run carries on to kennel setup.
export async function runSignInAndRestore({ fromCard = false } = {}) {
  if (!isCloudAvailable()) return false;
  const account = await signInModal({
    title: 'Sign in and restore',
    intro: 'Sign in with the email you used for cloud backup. Your records come back on this device.'
  });
  if (!account) return false;
  // Private Vault Plan §2.3: the unlock step, when the program has a vault.
  if (isVaultOffered()) await (await vaultUI()).unlockBeforeRestore();
  const pg = progressModal('Restoring your records…');
  try {
    const { restored } = await restoreOnNewDevice({
      onProgress: (done, total) => pg.update(`Downloading documents: ${done} of ${total}…`, done, total)
    });
    pg.close();
    if (!restored) {
      await alertModal({ title: 'No backup yet', message: "There's no backup on this account yet. Cloud backup is now on for this device, so your records will start backing up as you add them." });
      return fromCard ? true : 'empty';
    }
    const n = Object.values(restored.summary).reduce((t, s) => t + (s.inserted || 0) + (s.updated || 0), 0);
    const vault = restored.vault?.status;
    const privateNote = vault === 'restored'
      ? 'Your sensitive records came back too.'
      : vault === 'locked'
        ? "Sensitive records (contacts' phone, email and address, prices, notes) are blank until you unlock them: Import / Export → Cloud → Sensitive records → Unlock. Backups from this device are paused until then."
        : "Sensitive records (contacts' phone, email and address, prices, notes) weren't in this backup. If you have a file backup, restore it from Import / Export with Merge to bring those back.";
    const missing = (restored.missingFiles?.length || 0) + (restored.vault?.missingFiles?.length || 0);
    await alertModal({
      title: 'Your records are back',
      message: `Restored ${n} record(s). ${privateNote}`
        + (missing ? `\n\n${missing} document file(s) couldn't be downloaded yet.` : '')
    });
    return true;
  } catch (e) {
    pg.close();
    await alertModal({ title: "Couldn't restore", message: errorText(e) });
    return false;
  }
}

// --- After the first kennel is saved: the one-time offer (plan §2.1) ----------------------
const OFFER_HTML = `
  <h2 class="onboard-title">☁️ Protect your records</h2>
  <p>Turn on <strong>free cloud backup</strong> and your dogs, litters, pairings and health records are backed
  up automatically. If this device is ever lost or replaced, sign in on the new one and they come back.</p>
  <p class="muted">It's optional. Contacts' details, prices, Financials and your notes stay on this device either way.</p>`;

async function maybeRunCloudOffer() {
  if (!isCloudOfferPending()) return;
  if (hasSampleData() || currentAccount() || (await shouldRequireKennelSetup())) return;
  if (document.querySelector('.modal-overlay, .onboard-overlay')) return; // something else owns the screen
  setCloudOfferPending(false);
  const choice = await new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'onboard-overlay';
    overlay.innerHTML = `
      <div class="onboard-card" role="dialog" aria-modal="true">
        <div class="onboard-body">${OFFER_HTML}</div>
        <div class="onboard-actions">
          <button type="button" class="btn btn-primary" data-v="on">Turn on cloud backup</button>
          <button type="button" class="btn" data-v="skip">Skip for now</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => { overlay.remove(); resolve(b.dataset.v); }));
  });
  if (choice === 'on') await turnOnFlow();
  else { dismiss(NUDGE_KEY); notify(); } // "Skip for now" also quiets Today's nudge for its 30 days
}

// --- Today (plan §2.1): turn it on, or it's paused -------------------------------------

export function renderTodayCloudNudge(el) {
  if (!el) return;
  const render = () => {
    el.innerHTML = '';
    if (!isCloudAvailable() || hasSampleData()) return;
    const status = getBackupStatus();
    const paused = status.enabled ? pausedReason(status.lastError) : null;
    const expired = status.account && !status.account.signedIn;

    let html = '';
    if (paused || expired) {
      html = `<div class="row-between">
          <div><strong>☁️ Cloud backup is paused.</strong>
            <div class="muted" style="font-size:13px;">${esc(paused || 'Your sign-in has expired.')}</div></div>
          <div class="pill-row"><a class="btn btn-sm btn-primary" href="import-export.html#backup-restore">Resolve</a></div>
        </div>`;
    } else if (!status.enabled && status.movedToEdition !== 'pro') {
      const at = dismissedAt(NUDGE_KEY);
      if (at && Date.now() - Date.parse(at) < NUDGE_SNOOZE_MS) return;
      if (at) undismiss(NUDGE_KEY); // 30 days passed: show again
      html = `<div class="row-between">
          <div><strong>☁️ Protect your records: turn on free cloud backup.</strong>
            <div class="muted" style="font-size:13px;">If this device is lost or replaced, sign in on the new one and your records come back.</div></div>
          <div class="pill-row">
            <button class="btn btn-sm btn-primary" data-act="on">Turn on</button>
            <button class="btn btn-sm" data-act="later">Not now</button>
          </div>
        </div>`;
    }
    if (!html) return;
    el.innerHTML = `<section class="card" style="margin-bottom:16px;">${html}</section>`;
    el.querySelector('[data-act="on"]')?.addEventListener('click', async () => { await turnOnFlow(); render(); });
    el.querySelector('[data-act="later"]')?.addEventListener('click', () => { dismiss(NUDGE_KEY); render(); });
  };
  window.addEventListener(CLOUD_BACKUP_EVENT, render);
  render();
}

// --- Service notices (plan §2.1: the in-app shutdown channel) ---------------------------
async function renderServiceNotices() {
  const notices = await getServiceNotices();
  if (!notices.length) return;
  const seen = new Set();
  for (const n of notices) {
    if (!n || seen.has(n.id)) continue;
    seen.add(n.id);
    const bar = document.createElement('div');
    bar.className = `cloud-notice cloud-notice-${['info', 'warning', 'shutdown'].includes(n.level) ? n.level : 'info'}`;
    bar.setAttribute('role', 'status');
    bar.innerHTML = `<strong>${n.level === 'shutdown' ? 'Cloud backup is ending.' : 'KennelOS cloud:'}</strong> ${esc(n.message || '')}`;
    document.body.insertBefore(bar, document.body.firstChild);
  }
}

// --- Record pages: private details blank after a restore (Private Vault Plan §2.3) -----
// Phase 1 §2.3's per-record hint: after a cloud restore that didn't bring the
// private tier back, the pages that hold private details say why they're blank,
// and how to get them back (unlock, or a file backup). Gone once they're back
// (an unlock clears cloudRestoredAt) or the user says "Got it" on the card.
const PRIVATE_DETAIL_PAGES = new Set([
  'contact.html', 'contacts.html', 'dog.html', 'sale.html', 'sales.html', 'contract.html', 'contracts.html',
  'stud-service.html', 'litter.html', 'financials.html', 'waitlist-entry.html', 'documents.html'
]);

export function renderPrivateGapHint() {
  const page = location.pathname.split('/').pop();
  if (!PRIVATE_DETAIL_PAGES.has(page) || !getCloudRestoredAt()) return;
  const main = document.querySelector('main');
  if (!main || main.querySelector('.private-gap-hint')) return;
  const locked = getBackupStatus().vault === 'locked';
  const hint = document.createElement('div');
  hint.className = 'inline-warn private-gap-hint';
  hint.style.marginBottom = '12px';
  hint.innerHTML = locked
    ? 'Sensitive records (phone, email, address, prices, notes) are blank on this device until you unlock them. <a href="import-export.html#backup-restore">Unlock your sensitive records</a>'
    : 'Sensitive records (phone, email, address, prices, notes) weren\'t in the cloud backup this device was restored from, so they\'re blank here. <a href="import-export.html">Restore a file backup</a> with Merge to bring them back.';
  main.insertBefore(hint, main.firstChild);
}

// --- Reset App's question (plan §3.3) ------------------------------------------------------
// The checkbox for the Reset App modal: '' when there's no cloud sign-in on
// this device. Ticked by default, because a typed "erase" may mean the device is
// changing hands.
export function resetSignOutFieldHtml() {
  if (!isCloudAvailable() || !currentAccount()) return '';
  return `
    <label style="display:flex;gap:8px;align-items:flex-start;margin:10px 0;">
      <input type="checkbox" id="reset-cloud-signout" checked>
      <span>Also sign out of cloud backup on this device
        <span class="field-hint" style="display:block;">Leave this ticked if the device might change hands. Untick it to stay signed in and restore your backup straight after the reset.</span></span>
    </label>
    <p class="field-hint">Cloud backup is turned off on this device either way, so the reset can't overwrite your cloud copy.</p>`;
}

export async function signOutAfterResetIfChecked(root) {
  const box = root?.querySelector('#reset-cloud-signout');
  if (box && box.checked) {
    try { await signOut(); } catch { /* local sign-out still happened */ }
  }
}

// --- Boot (app.js) ---------------------------------------------------------------------------
export async function bootCloud() {
  if (!isCloudAvailable()) return;
  startBackupScheduler();
  // The waitlist online (Waitlist W2 Plan §5): Pro, behind its release switch.
  if (isWaitlistOnlineOffered() && editionFlags.waitlist) {
    import('../data/cloud/cloudWaitlist.js').then((m) => m.startWaitlistScheduler()).catch(() => {});
  }
  renderServiceNotices().catch(() => {});
  try { renderPrivateGapHint(); } catch { /* a hint only */ }
  await maybeRunCloudOffer().catch(() => {});
}
