// todayCloudCard.js — Today's cloud backup card: "Protect your records: turn on
// free cloud backup", "Cloud backup is paused", an email change, or "Save your
// recovery code" (Cloud Phase 1 plan §2.1). Only with a server (today.js checks).
//
// Which of them shows is decided from settings alone (the backup state, the
// cloud session, the dismissal ledger), so the card is in Today's first paint
// instead of arriving after the 60-module cloud UI (Load Performance plan
// Phase 1). That UI (cloudBackupUI.js) loads only when a button on the card is
// pressed. The one database answer the card needs, whether the private vault's
// recovery code is still unsaved, is kept in settings from the last look and
// looked up again after first paint.
import { esc, alertModal } from './ui.js';
import { isCloudAvailable, isVaultOffered, isSyncOffered } from '../data/cloud/cloudConfig.js';
import {
  getCloudBackupState, getCloudSession, hasSampleData, CLOUD_BACKUP_EVENT,
  getCloudCodeUnsavedCache, setCloudCodeUnsavedCache
} from '../data/settings.js';
import { dismiss, dismissedAt, undismiss } from '../data/nudgeState.js';

const DAY = 24 * 60 * 60 * 1000;
const NUDGE_KEY = 'cloud-backup-offer';
const NUDGE_SNOOZE_MS = 30 * DAY; // dismissing the "turn on" card snoozes it for 30 days

// Why a backup that is on isn't running (also the Account card's status line).
export function pausedReason(lastError) {
  switch (lastError?.code) {
    case 'conflict': if (lastError.movedToEdition === 'pro') return 'Your records moved to KennelOS Pro.';
      if (lastError.syncing && isSyncOffered()) return 'Your other devices keep in step. Join them to keep backing up from this one.';
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

// Who asked for a pending email change, for its notice (Account card, Today).
export const changeRequestedBy = (c) => (c?.via === 'recovery'
  ? 'Requested with your recovery code'
  : `Requested on ${esc(c?.deviceLabel || 'one of your devices')}`);

export const shortDate = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// What a change that couldn't happen says (review K4-8).
export const FAILED_CHANGE_TEXT = 'That address was taken while the change was waiting, so nothing changed: your account still uses its current email.';

const row = (title, text, actions) => `<div class="row-between">
    <div><strong>${title}</strong>
      <div class="muted" style="font-size:13px;">${text}</div></div>
    <div class="pill-row">${actions}</div>
  </div>`;

// The card's inner HTML from settings, or '' for no card. Pure apart from what it
// reads, so it can be tested.
export function todayCloudCardHtml({ codeUnsaved = getCloudCodeUnsavedCache(), now = Date.now() } = {}) {
  if (!isCloudAvailable() || hasSampleData()) return '';
  const state = getCloudBackupState();
  const session = getCloudSession();
  const paused = state.enabled ? pausedReason(state.lastError) : null;
  const expired = Boolean(session) && !session.token;
  const change = state.emailChange || null;
  if (state.emailChangeFailed && !change && !expired) {
    return row('✉️ Your email change didn\'t happen.', esc(FAILED_CHANGE_TEXT), '<button class="btn btn-sm" data-act="email-dismiss">OK</button>');
  }
  if (change && !expired) {
    return row('✉️ Your account\'s email is changing.', `${changeRequestedBy(change)}; it takes effect ${esc(shortDate(change.effectiveAt))}. Not you? Cancel it.`,
      '<button class="btn btn-sm" data-act="email-cancel">Cancel it</button>');
  }
  if (codeUnsaved && isVaultOffered() && state.enabled && !paused && !expired) {
    return row('🔑 Save your recovery code.', 'If you ever lose your passkey, it\'s the other way to unlock your sensitive records.',
      '<button class="btn btn-sm btn-primary" data-act="code">Show code</button>');
  }
  if (paused || expired) {
    return row('☁️ Cloud backup is paused.', esc(paused || 'Your sign-in has expired.'),
      '<a class="btn btn-sm btn-primary" href="import-export.html#backup-restore">Resolve</a>');
  }
  if (!state.enabled && state.movedToEdition !== 'pro') {
    const at = dismissedAt(NUDGE_KEY);
    if (at && now - Date.parse(at) < NUDGE_SNOOZE_MS) return '';
    return row('☁️ Protect your records: turn on free cloud backup.', 'If this device is lost or replaced, sign in on the new one and your records come back.',
      '<button class="btn btn-sm btn-primary" data-act="on">Turn on</button><button class="btn btn-sm" data-act="later">Not now</button>');
  }
  return '';
}

const backupUI = () => import('./cloudBackupUI.js');

// Draws the card into `el` and keeps it current: after a backup attempt or a
// change made through the card, and once the recovery code has been looked up.
export function renderTodayCloudCard(el) {
  if (!el) return;
  const render = () => {
    const html = todayCloudCardHtml();
    // The "turn on" card coming back after its 30 days clears the old dismissal.
    if (html.includes('data-act="later"') && dismissedAt(NUDGE_KEY)) undismiss(NUDGE_KEY);
    const next = html ? `<section class="card" style="margin-bottom:16px;">${html}</section>` : '';
    if (el.dataset.drawn === next) return;
    el.dataset.drawn = next;
    el.innerHTML = next;
    if (!html) return;
    const on = (act, fn) => el.querySelector(`[data-act="${act}"]`)?.addEventListener('click', async () => {
      try { await fn(); } catch (e) { await alertModal({ title: "That didn't work", message: (await backupUI()).errorText(e) }); }
      render();
    });
    on('on', async () => (await backupUI()).turnOnFlow());
    on('email-cancel', async () => (await backupUI()).cancelEmailChangeFlow());
    on('email-dismiss', async () => { await (await import('../data/cloud/cloudAuth.js')).cancelAccountEmailChange(); });
    on('code', async () => {
      await (await import('./cloudVaultUI.js')).saveRecoveryCodeFlow();
      await refreshCode();
    });
    on('later', () => dismiss(NUDGE_KEY));
  };
  // The unsaved recovery code is a database read: kept from the last look, and
  // looked up again only when the card could show it.
  const refreshCode = async () => {
    let unsaved = false;
    const state = getCloudBackupState();
    if (isVaultOffered() && state.enabled) {
      try { unsaved = Boolean(await (await import('../data/cloud/cloudVault.js')).unsavedRecoveryCode()); } catch { unsaved = false; }
    }
    if (unsaved !== getCloudCodeUnsavedCache()) setCloudCodeUnsavedCache(unsaved);
    render();
  };
  window.addEventListener(CLOUD_BACKUP_EVENT, refreshCode);
  render();
  refreshCode();
}
