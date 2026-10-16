// cloudSyncUI.js — live sync's screens (Cloud Phase 2 plan §2): "Keep my devices
// in step" on the Cloud pane of Import / Export, turning it on and joining, its
// pauses and their fixes, turning it off, the activity list, and the "updated on
// another device" notice. Imported dynamically from cloudBackupUI.js only where
// isSyncOffered() (Pro, with a server, behind cloudConfig.SYNC_RELEASED), and by
// bootCloud on a device that already syncs. Pro behavior gated by the flag, not
// a Pro page, so it isn't in proPages.js.
//
//   fillSyncField(slot, rerender)  the pane's dropdown, like Sensitive records'
//   joinOfferDialog()       a backup refused because the program syncs: join it
//   startSyncUI()           the scheduler, and what pulled records do to an open page
//
// Layering: talks to data/cloud/* only (never cloudApi or db).
import { esc, alertModal, confirmModal } from './ui.js';
import {
  syncStatus, syncReadiness, enableSync, joinSync, syncNow, programSyncs, disableSyncHere,
  disableSyncEverywhere, clearSyncActivity, dismissSyncStop, startSyncScheduler
} from '../data/cloud/cloudSync.js';
import { pushIfDirty } from '../data/cloud/cloudBackup.js';
import { listDevices } from '../data/cloud/cloudDevices.js';
import { describeActivity } from '../data/cloud/syncActivity.js';
import { askSame, askClashes } from './mergeQuestions.js';
import { SYNC_APPLIED_EVENT } from '../data/syncApply.js';
import { getMyKennelName } from '../data/kennelSetup.js';
import {
  openModal, typedConfirm, progressModal, notify, relativeTime, snapshotLabel, errorText, signInModal, withFreshSignIn
} from './cloudBackupUI.js';

const vaultUI = () => import('./cloudVaultUI.js');

// --- Whether the program syncs (for a device that doesn't), once per visit ----------
let programCache = null;
function programSyncsCached() {
  if (!programCache) programCache = programSyncs();
  return programCache;
}
const forgetProgram = () => { programCache = null; };

// --- Words ----------------------------------------------------------------------------
const MISSING = {
  signed_out: 'Sign in to cloud backup on this device.',
  backup_off: 'Turn on cloud backup on this device (below).',
  backup_paused: 'Resolve the paused backup above.',
  vault_off: 'Turn on Sensitive records (above), so prices, contacts\' details and Financials stay in step too.',
  vault_locked: 'Unlock Sensitive records on this device (above).',
  unavailable: 'Keeping devices in step isn\'t available here.'
};

// A pause → what it means, and the one thing that fixes it ([action, label] or null).
export function pausedText(code, detail = null) {
  switch (code) {
    case 'vault_locked': return ['Your sensitive records are locked on this device. Unlock them to keep in step.', ['unlock', 'Unlock…']];
    case 'vault_key_stale': return ['Sensitive records were turned off and on again on another device. Unlock them here with the new recovery code.', ['unlock', 'Unlock…']];
    case 'vault_required': return ['Sensitive records are off for this account. Turn them on above to keep in step.', null];
    case 'pro_required': return ['Renew Pro to keep your devices in step. Backups carry on meanwhile, and every device keeps its records.', ['retry', 'Check again']];
    case 'resync_required': return ['This device was away too long to catch up change by change. Catching up brings everything down and deletes nothing.', ['rejoin', 'Catch up…']];
    case 'shrink': return [`This device would delete ${detail?.deletes ?? 'most'} of ${detail?.total ?? 'your'} synced records on every device, so it stopped.`, ['shrink', 'Decide…']];
    case 'signed_out': return ['Your cloud sign-in has expired.', ['signin', 'Sign in again']];
    default: return [`Something stopped it (${code}). It tries again by itself.`, ['retry', 'Try now']];
  }
}

// "On · 2 devices · synced a minute ago" (plan §2.2).
export function onLine(s, now = Date.now()) {
  const parts = ['On'];
  if (s.devices >= 2) parts.push(`${s.devices} devices`);
  if (s.offline) parts.push('changes waiting: no internet');
  else if (s.lastPullAt || s.lastCheckAt) {
    const at = [s.lastPullAt, s.lastCheckAt].filter(Boolean).sort().pop();
    parts.push(`synced ${relativeTime(at, now)}`);
  }
  return parts.join(' · ');
}

const ON_HINT = 'Changes here reach your other devices within a minute while they\'re online, and theirs come here.';

// --- The pane's field (plan §2.1, §2.2) ------------------------------------------------
// Fills `slot` (a <div> under Sensitive records). `rerender` redraws the pane.
export function fillSyncField(slot, rerender) {
  const draw = (programOn = null) => {
    const s = syncStatus();
    let current; let choices; let hint;
    if (s.enabled && s.joining) {
      current = 'Joining…';
      choices = [['retry', 'Finish joining']];
      hint = 'Joining didn\'t finish (no internet, or the app closed). It picks up where it stopped.';
    } else if (s.enabled && s.paused) {
      const [text, fix] = pausedText(s.paused, s.pausedDetail);
      current = 'Paused';
      choices = [...(fix ? [fix] : []), ['off-here', 'Turn off on this device…'], ['off-all', 'Turn off for every device…']];
      hint = text;
    } else if (s.enabled) {
      current = onLine(s);
      choices = [['retry', 'Sync now'], ['activity', 'Recent activity…'], ['off-here', 'Turn off on this device…'], ['off-all', 'Turn off for every device…']];
      hint = ON_HINT;
    } else if (s.paused === 'sync_off') {
      current = 'Off';
      choices = [['on', 'Turn on again…'], ['dismiss', 'Got it']];
      hint = 'It was turned off for every device from another device. This device kept all its records.';
    } else if (programOn) {
      current = 'Off on this device';
      choices = [['join', 'Keep this device in step…']];
      hint = 'Your other devices are in step. Turn it on here to join them.';
    } else {
      current = 'Off';
      choices = [['on', 'Turn on…']];
      hint = 'Your phone and computer show the same records, a minute apart. Pro.';
    }
    slot.innerHTML = `<div class="field" style="max-width:340px;margin-top:12px;">
        <label for="cb-sync">Keep my devices in step</label>
        <select id="cb-sync">
          <option value="" selected>${esc(current)}</option>
          ${choices.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}
        </select>
        <span class="field-hint">${esc(hint)}</span>
      </div>`;
    const select = slot.querySelector('#cb-sync');
    select.addEventListener('change', async () => {
      const run = ACTIONS[select.value];
      if (!run) return;
      select.disabled = true;
      try { await run(); } catch (err) { await alertModal({ title: "That didn't work", message: errorText(err) }); }
      finally { notify(); rerender(); }
    });
  };
  draw();
  if (!syncStatus().enabled) {
    programSyncsCached().then((p) => { if (slot.isConnected && p?.enabled) draw(true); }, () => {});
  }
}

const ACTIONS = {
  on: () => turnOnSyncFlow(),
  join: () => joinSyncFlow(),
  rejoin: () => joinSyncFlow({ catchUp: true }),
  retry: () => syncWithAnswer(),
  unlock: async () => {
    if (await (await vaultUI()).unlockModal({ merge: true })) await syncWithAnswer();
  },
  signin: async () => {
    if (await signInModal({ title: 'Sign in again' })) await syncWithAnswer();
  },
  shrink: () => shrinkDialog(),
  activity: () => activityModal(),
  dismiss: () => dismissSyncStop(),
  'off-here': () => turnOffHereFlow(),
  'off-all': () => turnOffEverywhereFlow()
};

// --- Turning it on and joining (plan §2.1) ----------------------------------------------
async function missingAlert(missing) {
  await alertModal({
    title: 'First, a few things',
    message: `To keep your devices in step:\n\n${missing.map((m) => `• ${MISSING[m] || m}`).join('\n')}`
  });
}

// The progress modal's words for cloudSync's ({ phase, done, total }).
function progressText(p) {
  if (p.phase === 'match') return ['Looking for records you entered on more than one device…', p.done, p.total];
  if (p.phase === 'pull') return ['Bringing down your records…', p.done, p.total];
  return [`Getting your records ready to sync: ${p.done.toLocaleString()} of ${p.total.toLocaleString()}`, p.done, p.total];
}

async function withProgress(title, run) {
  const pg = progressModal(title);
  try {
    return await run((p) => { try { pg.update(...progressText(p)); } catch { /* UI only */ } });
  } finally {
    pg.close();
  }
}

// A join (or a turn-on, which joins) with its questions, as a file Merge asks
// them: "Are these the same?" until nothing is left to ask (an answer can pair
// more), then a paired dog's name, sex or parents. → the last result, or null
// when she cancelled (nothing was written).
async function withQuestions(title, first) {
  let answers = {};
  let result = await withProgress(title, first);
  while (result?.status === 'ask') {
    let clashChoices = null;
    if (result.asks.length) {
      const got = await askSame(result.asks, { theirs: 'on your other devices' });
      if (!got) return null;
      answers = { ...answers, ...got };
    } else {
      clashChoices = await askClashes(result.clashes, { theirsLabel: 'your other devices' });
      if (!clashChoices) return null;
    }
    result = await withProgress(title, (onProgress) => joinSync({ onProgress, answers, clashChoices }));
  }
  return result;
}

// What a turn-on or a join came back with, said to her. True when this device is in step.
async function joinResult(result, { first = false } = {}) {
  forgetProgram();
  if (result === null) return false; // she cancelled a question: nothing was written
  const matched = result?.matched ? ` ${result.matched.toLocaleString()} record(s) you had entered on more than one device became one.` : '';
  switch (result?.status) {
    case 'on':
      startSyncUI();
      // The backups carry on from here, stating what this device has applied.
      pushIfDirty({ force: true }).catch(() => {});
      await alertModal({
        title: 'Your devices are in step',
        message: first
          ? 'This device is the starting point. On your other devices, sign in to cloud backup, unlock Sensitive records, and choose Keep this device in step.'
          : `${result.pulled ? `${result.pulled.toLocaleString()} record(s) came down. ` : ''}${result.pushed ? `${result.pushed.toLocaleString()} from this device went up. ` : ''}From now on, changes reach your other devices within a minute.${matched}`
      });
      return true;
    case 'not_ready':
      await missingAlert(result.missing);
      return false;
    case 'refused':
      await alertModal({
        title: 'Not turned on',
        message: result.code === 'pro_required'
          ? 'Keeping devices in step is part of KennelOS Pro, and this cloud account doesn\'t have Pro. Link your Pro purchase in Settings → Account, then try again.'
          : 'Turn on Sensitive records first, so prices, contacts\' details and Financials stay in step too.'
      });
      return false;
    case 'offline':
      await alertModal({ title: 'No internet', message: 'It picks up where it stopped when you\'re back online.' });
      return false;
    case 'shrink':
      return false;
    case 'paused': {
      if (result.code === 'sync_off') {
        await alertModal({ title: 'It was turned off', message: 'Keeping devices in step was turned off for every device. Turn it on again to start over.' });
        return false;
      }
      const [text] = pausedText(result.code);
      await alertModal({ title: 'Paused', message: text });
      return false;
    }
    default:
      await alertModal({ title: "That didn't finish", message: 'Something went wrong. Try again in a minute.' });
      return false;
  }
}

export async function turnOnSyncFlow() {
  const missing = await syncReadiness();
  if (missing.length) return missingAlert(missing);
  const programOn = (await programSyncsCached())?.enabled;
  if (programOn) return joinSyncFlow();
  const ok = await confirmModal({
    title: 'Keep your devices in step?',
    message: 'Every device you turn this on for shows the same records: an edit on your phone is on your laptop within a minute while both are online, and an edit made offline arrives when it reconnects.\n\n'
      + 'Sensitive records travel encrypted, as in your backups. This device\'s records go up first.\n\n'
      + 'If two devices change the same record, the change that reaches the cloud last is kept. The other is in that day\'s backups (Restore as of…).',
    confirmLabel: 'Turn on'
  });
  if (!ok) return false;
  const result = await withQuestions('Turning on…', (onProgress) => enableSync({ onProgress }));
  return joinResult(result, { first: result?.status === 'on' && !result.pulled && !result.matched });
}

// "Keep this device in step" (§2.1, §5.5). `catchUp`: a device that fell too far
// behind (resync_required), or got its records back after a shrink.
export async function joinSyncFlow({ catchUp = false, confirmed = false } = {}) {
  const missing = await syncReadiness();
  if (missing.length) return missingAlert(missing);
  if (!confirmed) {
    const ok = await confirmModal({
      title: catchUp ? 'Catch up with your other devices?' : 'Keep this device in step?',
      message: 'Your records come down from the cloud, and this device\'s records the cloud doesn\'t have go up. '
        + 'A record you entered on both devices becomes one (I\'ll ask about any I\'m not sure of). '
        + 'Where both have changed a record, the newer change is kept. Nothing is deleted on either side.',
      confirmLabel: catchUp ? 'Catch up' : 'Keep in step'
    });
    if (!ok) return false;
  }
  const result = await withQuestions(catchUp ? 'Catching up…' : 'Joining your devices…', (onProgress) => joinSync({ onProgress }));
  return joinResult(result);
}

// A backup refused because the program keeps its devices in step (§2.1): in
// place of the Phase 1 "restore that backup here / replace it".
export async function joinOfferDialog() {
  const kennel = (await getMyKennelName()) || 'Your program';
  const choice = await new Promise((resolve) => {
    const overlay = openModal(`
      <h2 style="margin-top:0;">Your devices keep in step</h2>
      <p class="muted">${esc(kennel)} keeps its devices in step, so there's no single device that backs up. Join them to keep backing up from this one.</p>
      <p class="muted">Your records come down, this device's records the cloud doesn't have go up, a record entered on both becomes one, and nothing is deleted on either side.</p>
      <div class="form-actions">
        <button class="btn btn-primary" data-v="join">Keep this device in step</button>
        <button class="btn" data-v="cancel">Not now</button>
      </div>`, { width: 520 });
    overlay.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => { overlay.remove(); resolve(b.dataset.v); }));
  });
  if (choice === 'join') return joinSyncFlow({ confirmed: true });
  return false;
}

// --- Running it by hand, and its answers ---------------------------------------------------
async function syncWithAnswer() {
  const r = await syncNow();
  const result = r.join || (r.push?.status === 'paused' || r.push?.status === 'shrink' ? r.push : r.pull);
  if (result?.status === 'shrink') return shrinkDialog();
  if (result?.status === 'on') return joinResult(result);
  if (result?.status === 'offline') return alertModal({ title: 'No internet', message: 'Your changes wait here and go up when you\'re back online.' });
  return null; // a pause shows on the field itself
}

// The shrink guard's question, for sync (§11): most records gone here.
async function shrinkDialog() {
  const d = syncStatus().pausedDetail || {};
  const choice = await new Promise((resolve) => {
    const overlay = openModal(`
      <h2 style="margin-top:0;">Most of your records are missing on this device</h2>
      <p class="muted">${esc(`${d.deletes ?? 'Most'} of the ${d.total ?? ''} records this device synced aren't here any more.`)}
        That can happen after clearing the browser, a Replace import, or Reset App. Syncing stopped so your other devices keep them.</p>
      <div class="form-actions">
        <button class="btn btn-primary" data-v="back">Bring them back</button>
        <button class="btn btn-danger" data-v="delete">Delete them everywhere…</button>
        <button class="btn" data-v="cancel">Not now</button>
      </div>`, { width: 520 });
    overlay.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => { overlay.remove(); resolve(b.dataset.v); }));
  });
  if (choice === 'back') return joinSyncFlow({ catchUp: true, confirmed: true });
  if (choice !== 'delete') return null;
  const ok = await typedConfirm({
    title: 'Delete them on every device?',
    message: 'Those records are deleted on all your devices. They stay in the last 30 days of backups, so Restore as of… can still bring them back.',
    phrase: 'DELETE',
    confirmLabel: 'Delete everywhere'
  });
  if (ok) await syncNow({ allowShrink: true });
  return null;
}

// --- Turning it off (plan §2.4) ------------------------------------------------------------
async function turnOffHereFlow() {
  const ok = await confirmModal({
    title: 'Stop keeping this device in step?',
    message: 'This device keeps all its records, but its changes stop reaching your other devices, and theirs stop coming here. Your other devices carry on in step.',
    confirmLabel: 'Turn off here'
  });
  if (!ok) return;
  await disableSyncHere();
  forgetProgram();
}

async function turnOffEverywhereFlow() {
  const kennel = (await getMyKennelName()) || 'your program';
  const ok = await typedConfirm({
    title: 'Turn off for every device?',
    message: `${kennel}'s devices stop keeping in step. Every device keeps its records and goes back to ordinary backups, from one device at a time. `
      + 'The cloud keeps the synced records for 30 days, so turning it back on is quick.',
    phrase: 'TURN OFF',
    confirmLabel: 'Turn off everywhere'
  });
  if (!ok) return;
  await withFreshSignIn((reauth) => disableSyncEverywhere(reauth), { purpose: 'turn off keeping your devices in step', confirmLabel: 'Turn off' });
  forgetProgram();
}

// --- The activity list (plan §2.3) ---------------------------------------------------------
async function activityModal() {
  const items = syncStatus().activity;
  let labels = new Map();
  if (items.some((i) => i.by)) {
    try { labels = new Map((await listDevices()).map((d) => [d.id, d.label])); } catch { /* "another device" */ }
  }
  const lines = await describeActivity(items, labels);
  await new Promise((resolve) => {
    const overlay = openModal(`
      <h2 style="margin-top:0;">Recent sync activity</h2>
      ${lines.length
        ? `<p class="muted">What syncing decided by itself in the last 30 days. An older version is still in that day's backups (Restore as of…).</p>
           <ul style="list-style:none;padding:0;margin:0;">${lines.map((l) => `<li style="padding:8px 0;border-top:1px solid var(--border);">
             ${esc(l.text)}<div class="field-hint">${esc(snapshotLabel(l.at))}</div></li>`).join('')}</ul>`
        : '<p class="muted">Nothing to report: syncing hasn\'t had to decide anything in the last 30 days.</p>'}
      <div class="form-actions">
        ${lines.length ? '<button class="btn" data-v="clear">Clear the list</button>' : ''}
        <button class="btn btn-primary" data-v="close">Close</button>
      </div>`, { width: 540 });
    overlay.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.v === 'clear') clearSyncActivity();
      overlay.remove();
      resolve();
    }));
  });
}

// --- An open page while records arrive (plan §2.2, §12 decision 7) --------------------------
// A record page whose record changed gets a notice with Reload, never a re-render
// under her hands. A list or Today refreshes by itself while she hasn't typed
// anything or opened a dialog there; otherwise it gets the notice too.
const RECORD_PAGES = {
  'dog.html': 'dogs', 'litter.html': 'litters', 'pairing.html': 'pairings', 'contact.html': 'contacts',
  'kennel.html': 'kennels', 'sale.html': 'sales', 'stud-service.html': 'stud_services', 'contract.html': 'contracts',
  'waitlist-entry.html': 'waitlist_entries'
};
const REFRESHING_PAGES = new Set([
  'today.html', 'index.html', '', 'dashboard.html', 'dogs.html', 'litters.html', 'pairings.html', 'contacts.html',
  'kennels.html', 'sales.html', 'contracts.html', 'stud-services.html', 'waitlist.html', 'calendar.html',
  'upcoming.html', 'reminders.html', 'board.html', 'roster.html', 'shows.html', 'documents.html',
  'active-breeding.html', 'live-births.html', 'scheduled-placements.html'
]);
const SCROLL_KEY = 'kennelOS.syncScroll';

export function pageReaction(page, recordId, tables, { busy = false } = {}) {
  const touched = Object.values(tables || {}).some((ids) => ids?.length);
  if (!touched) return null;
  const tbl = RECORD_PAGES[page];
  if (tbl && recordId) return tables[tbl]?.includes(recordId) ? 'notice' : null;
  if (REFRESHING_PAGES.has(page)) return busy ? 'notice' : 'reload';
  return null;
}

let typed = false;
function showNotice() {
  if (document.querySelector('.sync-notice')) return;
  const bar = document.createElement('div');
  bar.className = 'cloud-notice cloud-notice-info sync-notice';
  bar.setAttribute('role', 'status');
  bar.innerHTML = 'Updated on another device. <button type="button" class="btn btn-sm" style="margin-left:6px;">Reload to see it</button>';
  bar.querySelector('button').addEventListener('click', () => location.reload());
  document.body.insertBefore(bar, document.body.firstChild);
}

// The pull runs in one tab (the lock); the others hear about it here.
let channel = null;

function onApplied(e) {
  try { channel?.postMessage(e.detail?.tables || {}); } catch { /* one tab only */ }
  react(e.detail?.tables);
}

function react(tables) {
  const page = location.pathname.split('/').pop();
  const id = new URLSearchParams(location.search).get('id');
  const busy = typed || !!document.querySelector('.modal-overlay') || document.visibilityState === 'hidden';
  const what = pageReaction(page, id, tables, { busy });
  if (what === 'notice') showNotice();
  if (what === 'reload') {
    try { sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ path: location.pathname + location.search, y: window.scrollY })); } catch { /* top it is */ }
    location.reload();
  }
  notify();
}

// Back where she was after a refresh by itself.
function restoreScroll() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SCROLL_KEY) || 'null');
    sessionStorage.removeItem(SCROLL_KEY);
    if (saved && saved.path === location.pathname + location.search) {
      requestAnimationFrame(() => window.scrollTo(0, saved.y || 0));
    }
  } catch { /* nothing saved */ }
}

let started = false;
export function startSyncUI() {
  if (started) return;
  started = true;
  restoreScroll();
  document.addEventListener('input', () => { typed = true; }, true);
  window.addEventListener(SYNC_APPLIED_EVENT, onApplied);
  try {
    channel = new BroadcastChannel('kennelos-sync-applied');
    channel.onmessage = (m) => react(m.data);
  } catch { /* no BroadcastChannel: each tab reacts to its own pulls */ }
  startSyncScheduler();
}
