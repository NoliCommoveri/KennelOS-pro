// cloudBackupUI.js — every cloud-backup screen (Cloud Phase 1 plan §2, §3.4,
// §3.5; §9 step 5). Shared, not Pro-gated (plan §3.1), so Lite and Pro both
// carry it. Every entry point checks isCloudAvailable() first and renders
// NOTHING when the edition has no server (`cloudUrl: null`: Demo, the shared
// default, a post-shutdown release), so no account wording ever appears there.
//
//   bootCloud()                 app.js, every page: scheduler, service notices,
//                               the one-time post-setup offer
//   mountCloudBackupCard(el)    the Import/Export card
//   renderTodayCloudNudge(el)   Today: "turn it on" while off, or "paused"
//   runSignInAndRestore()       first-run "I already use KennelOS"
//   resetSignOutFieldHtml() / signOutAfterResetIfChecked()   Reset App's question
//   devicesModal()              "Your devices": erase a lost one, free its Pro license
//   openDevicesFromLicenseWall() the Pro activation wall's "Lost a device?" link
//
// Layering: talks to data/cloud/* only (never cloudApi's fetch directly, never db).
import { esc, confirmModal, alertModal, selectModal, promptModal } from './ui.js';
import { isCloudAvailable } from '../data/cloud/cloudConfig.js';
import {
  startSignIn, verifySignIn, currentAccount, signOut, signOutOtherDevices, defaultDeviceLabel
} from '../data/cloud/cloudAuth.js';
import {
  enableBackup, disableBackup, pushIfDirty, getBackupStatus, restoreLatestAndTakeOver,
  replaceCloudWithThisDevice, listSnapshots, downloadSnapshot, previewRestore, restoreSnapshot,
  restoreOnNewDevice, deleteCloudData, startBackupScheduler, getServiceNotices, CLOUD_BACKUP_EVENT
} from '../data/cloud/cloudBackup.js';
import { listDevices, requestErase, cancelErase, releaseDeviceLicense } from '../data/cloud/cloudDevices.js';
import { CloudOfflineError, CloudRequestError, CloudAuthError } from '../data/cloud/cloudApi.js';
import { isCloudOfferPending, setCloudOfferPending, getCloudRestoredAt, setCloudRestoredAt, getProLicense } from '../data/settings.js';
import { isLicenseGated } from '../data/license.js';
import { hasSampleData } from '../data/sampleData.js';
import { getMyKennelName, shouldRequireKennelSetup } from '../data/kennelSetup.js';
import { dismiss, dismissedAt, undismiss } from '../data/nudgeState.js';

// --- Small helpers --------------------------------------------------------------

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
    default: return null;
  }
}

function errorText(e) {
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
      default: return `Cloud backup refused that (${e.code || e.status}).`;
    }
  }
  if (e && e.name === 'CapExceededError') {
    return `This backup has ${e.current} active dogs. KennelOS Lite keeps up to ${e.limit}, so nothing was restored. Upgrade to Pro to restore it.`;
  }
  return e?.message || String(e);
}

// A modal shell matching ui.js's (.modal-overlay > .modal). Returns the overlay.
function openModal(innerHtml, { width = 460, dismissible = true } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true" style="max-width:${width}px;">${innerHtml}</div>`;
  document.body.appendChild(overlay);
  if (!dismissible) overlay.addEventListener('click', (e) => { if (e.target === overlay) e.stopPropagation(); }, true);
  return overlay;
}

// A typed confirmation ("type REPLACE"). Resolves true/false.
function typedConfirm({ title, message, phrase, confirmLabel }) {
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
function progressModal(title) {
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

const notify = () => { try { window.dispatchEvent(new CustomEvent(CLOUD_BACKUP_EVENT, { detail: { status: 'ui' } })); } catch { /* fine */ } };

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
        application's answers, and your private notes.</p>
      <p class="muted">To keep a copy of those too, download a file backup now and then from
        <a href="import-export.html">Import / Export</a>.</p>
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
  await pushWithProgress((onProgress) => enableBackup({ onProgress }));
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
        <li><strong>Restore that backup here</strong> — its records are merged into this device (anything newer here is kept, and nothing private here is lost). This device then takes over the backups.</li>
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
async function restoreAsOfFlow() {
  let snapshots;
  try { snapshots = await listSnapshots(); } catch (e) { return alertModal({ title: "Couldn't load your backups", message: errorText(e) }); }
  if (!snapshots.length) return alertModal({ title: 'No backups yet', message: 'There are no cloud backups to restore from yet.' });

  // Two backups in the same minute ("Back up now" twice) would read the same, so
  // a repeated label gets its seconds.
  const labels = snapshots.map((s) => snapshotLabel(s.createdAt));
  const options = snapshots.map((s, i) => ({
    value: s.id,
    label: `${labels.filter((l) => l === labels[i]).length > 1 ? snapshotLabel(s.createdAt, new Date(), { seconds: true }) : labels[i]}`
      + ` — ${s.counts?.dogs ?? 0} dogs${s.deviceLabel ? `, from ${s.deviceLabel}` : ''}`
  }));
  const id = await selectModal({
    title: 'Restore as of…',
    message: 'Pick the backup to roll back to. Records are rolled back to how they were then. Nothing is deleted.',
    label: 'Backup',
    options,
    confirmLabel: 'Next'
  });
  if (!id) return;
  const chosen = snapshots.find((s) => s.id === id);

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
      'Their private details (phone numbers, prices, notes…) keep their current values: those aren\'t in cloud backup, so they can\'t roll back.',
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

// --- The Import/Export card (plan §2.2, §2.4) ------------------------------------------
export function mountCloudBackupCard(el) {
  if (!el || !isCloudAvailable()) { if (el) el.remove(); return; }
  el.hidden = false;
  const render = () => renderCard(el);
  window.addEventListener(CLOUD_BACKUP_EVENT, render);
  render();
  // Keep "Backed up 4 minutes ago" honest without re-rendering the card (which
  // would close an open <details> or drop focus).
  setInterval(() => {
    const line = el.querySelector('[data-status-line]');
    if (line) line.textContent = statusLine(getBackupStatus());
  }, MINUTE);
}

function renderCard(el) {
  const status = getBackupStatus();
  const account = status.account;
  const restoredAt = getCloudRestoredAt();
  const paused = status.enabled ? pausedReason(status.lastError) : null;

  let main;
  if (!account) {
    main = `
      <p class="muted">Back up your kennel records automatically, free. If this device is lost or replaced,
        sign in on the new one with your email and everything comes back.</p>
      <p class="field-hint">Contacts' phone, email and address, prices, Financials, contracts and your private notes
        stay on this device only. Keep a file backup for those.</p>
      <div class="form-actions"><button class="btn btn-primary" data-act="on">☁️ Turn on cloud backup</button>
        <button class="btn" data-act="restore-new">I already have a backup: sign in and restore</button></div>`;
  } else if (!account.signedIn) {
    main = `
      <p class="muted">Signed in as <strong>${esc(account.email || '')}</strong>, but the sign-in has expired.
        Backup is paused until you sign in again. Your records here are untouched.</p>
      <div class="form-actions"><button class="btn btn-primary" data-act="signin">Sign in again</button>
        <button class="btn" data-act="signout">Sign out</button></div>`;
  } else {
    const line = statusLine(status);
    main = `
      <p><strong data-status-line>${esc(line)}</strong>${status.enabled && status.dirty && !paused ? ' <span class="faint">Recent changes will back up shortly.</span>' : ''}</p>
      ${paused ? `<div class="inline-warn">Backup is paused: ${esc(paused)} <button class="btn btn-sm" data-act="resolve" style="margin-left:6px;">Resolve…</button></div>` : ''}
      <p class="field-hint">Signed in as ${esc(account.email || '')}${account.deviceLabel ? ` · this device: ${esc(account.deviceLabel)}` : ''}</p>
      <div class="form-actions">
        ${status.enabled
          ? `<button class="btn btn-primary" data-act="now">Back up now</button>
             <button class="btn" data-act="asof">Restore as of…</button>
             <button class="btn" data-act="off">Turn off backup on this device</button>`
          : `<button class="btn btn-primary" data-act="on">Turn on backup on this device</button>
             <button class="btn" data-act="asof">Restore as of…</button>`}
      </div>
      <details style="margin-top:10px;"><summary class="muted">Account</summary>
        <div class="form-actions">
          <button class="btn btn-sm" data-act="devices">Your devices…</button>
          <button class="btn btn-sm" data-act="others">Sign out other devices</button>
          <button class="btn btn-sm" data-act="signout">Sign out</button>
          <button class="btn btn-sm btn-danger" data-act="delete">Delete my cloud data…</button>
        </div>
      </details>`;
  }

  el.innerHTML = `
    <h2 style="margin-top:0;">☁️ Cloud backup</h2>
    ${restoredAt ? `<div class="inline-warn" style="margin-bottom:10px;">Restored from cloud backup ${esc(relativeTime(restoredAt))}.
      Private details (contacts' phone, email and address, prices, notes) aren't in cloud backup, so they're blank on
      this device. If you have a file backup, restore it with <strong>Merge</strong> above to bring them back.
      <button class="btn btn-sm" data-act="hide-restored" style="margin-left:6px;">Got it</button></div>` : ''}
    ${main}
    <div id="cloud-msg"></div>`;

  const act = (name, fn) => el.querySelector(`[data-act="${name}"]`)?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try { await fn(); } catch (err) { await alertModal({ title: "That didn't work", message: errorText(err) }); }
    finally { if (btn.isConnected) btn.disabled = false; renderCard(el); }
  });

  act('on', turnOnFlow);
  act('restore-new', async () => { if (await runSignInAndRestore({ fromCard: true })) location.reload(); });
  act('signin', async () => {
    const acc = await signInModal({ title: 'Sign in again' });
    if (acc) await pushWithProgress((onProgress) => pushIfDirty({ force: true, onProgress }));
  });
  act('resolve', () => pushWithProgress((onProgress) => pushIfDirty({ force: true, onProgress })));
  act('now', () => pushWithProgress((onProgress) => pushIfDirty({ force: true, onProgress })));
  act('asof', restoreAsOfFlow);
  act('off', async () => {
    if (await confirmModal({ title: 'Turn off backup on this device?', message: 'Changes on this device stop backing up. The cloud copy stays, and you can turn it back on any time.', confirmLabel: 'Turn off' })) disableBackup();
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
  act('hide-restored', () => setCloudRestoredAt(null));
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
      + `\n\nPrivate details (contacts' phone, email and address, prices, Financials, contracts, private notes) aren't in cloud backup. If ${name} has the only copy of them, erasing it loses them, unless you have a file backup that includes them.`
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
async function withFreshSignIn(fn, { purpose, confirmLabel }) {
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
    await alertModal({
      title: 'Your records are back',
      message: `Restored ${n} record(s). Private details (contacts' phone, email and address, prices, notes) aren't in cloud backup. If you have a file backup, restore it from Import / Export with Merge to bring those back.`
        + (restored.missingFiles?.length ? `\n\n${restored.missingFiles.length} document file(s) couldn't be downloaded yet.` : '')
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
  <p class="muted">It's optional. Contacts' details, prices, Financials and your private notes stay on this device either way.</p>`;

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
          <div class="pill-row"><a class="btn btn-sm btn-primary" href="import-export.html#cloud-backup">Resolve</a></div>
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
  renderServiceNotices().catch(() => {});
  await maybeRunCloudOffer().catch(() => {});
}
