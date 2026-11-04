// cloudAssistUI.js — assisted setup and help from KennelOS support, the screens
// (docs/KennelOS_Assisted_Setup_Plan.md). The data half is data/cloud/cloudAssist.js.
//
//   openAssistLink()         app.js, before the license gate: a page opened with
//                            ?assist=<token> signs this device in as support's helper
//   bootstrapHelper()        app.js, on support's device: the vault and sync, once
//   renderHelperBar()        app.js: "Helping <name> · Hand back" on every page
//   startAssistLoops()       bootCloud: the automatic vault hand-over, on whichever
//                            side should give the key right now
//   claimAssistedAccount()   her first sign-in on a program support set up (from
//                            "I already use KennelOS"), and its resume on a later load
//   helpSectionHtml / wireHelpSection   Settings → Account: Get help / End help
//
// Layering: data/cloud/* and settings.js only.
import { esc, alertModal, confirmModal } from './ui.js';
import { openModal, progressModal, errorText } from './cloudBackupUI.js';
import {
  assistTokenInUrl, stripAssistToken, redeemAssistLink, isHelperDevice, assistState, requestHelp, endHelp,
  markClaimed, shouldAutoApprove, autoApproveOnce, unlockAutomatically
} from '../data/cloud/cloudAssist.js';
import { currentAccount } from '../data/cloud/cloudAuth.js';
import { vaultStatus, startVaultSetup, finishVaultSetup } from '../data/cloud/cloudVault.js';
import { prepareDirectJoin, adoptOwnKennel } from '../data/cloud/cloudBackup.js';
import { enableSync, syncStatus } from '../data/cloud/cloudSync.js';
import { eraseThisDevice } from '../data/cloud/cloudDevices.js';
import { getAssistReady, setAssistReady } from '../data/settings.js';

const vaultUI = () => import('./cloudVaultUI.js');
const syncUI = () => import('./cloudSyncUI.js');
const herName = () => currentAccount()?.helperLabel || 'her';

// --- Support's device --------------------------------------------------------------------

// → true when this load signed the device in as a helper (the caller carries on),
// false when there was no link or it didn't work (an alert said why).
export async function openAssistLink() {
  const token = assistTokenInUrl();
  if (!token) return false;
  stripAssistToken();
  try {
    const r = await redeemAssistLink(token);
    setAssistReady(null); // a fresh helper session: set up again for this program
    return !!r;
  } catch (e) {
    await alertModal({
      title: 'That link didn’t work',
      message: e?.code === 'link_expired'
        ? 'Assist links work once, for 15 minutes. Make a new one in KennelOS Assist.'
        : e?.code === 'help_not_requested' ? 'She hasn’t asked for help. She presses Get help in Settings first.' : errorText(e)
    });
    return false;
  }
}

// Support's device, once per program: in setup, the vault (a recovery code nobody needs
// to keep: her device makes her own) and sync, so everything set up here reaches her;
// helping, her vault key from her device and the join that brings her records down.
export async function bootstrapHelper() {
  if (!isHelperDevice()) return;
  const programId = currentAccount()?.programId;
  if (!programId || getAssistReady() === programId) return;
  const st = await assistState();
  if (!st) return;
  if (st.state === 'setup') return setUpForHer(programId);
  if (st.state === 'requested' || st.state === 'helping') return joinHer(programId);
}

async function setUpForHer(programId) {
  const pg = progressModal(`Setting up ${herName()}’s account on this device…`);
  try {
    const v = await vaultStatus();
    if (v.enabled && !v.unlocked) {
      pg.close();
      await alertModal({ title: 'Her private records are locked here', message: 'This account already has private records turned on, from another device. Use the device you started the setup on, or delete the account in KennelOS Assist and start again.' });
      return;
    }
    prepareDirectJoin(); // backup on, first-run's sample data question skipped
    if (!v.enabled) {
      pg.update('Turning on private records…');
      const setup = await startVaultSetup();
      await finishVaultSetup(setup, { confirmation: setup.lastGroup });
    }
    pg.update('Turning on keeping devices in step…');
    if (!syncStatus().enabled) {
      const r = await enableSync();
      if (r?.status === 'not_ready' || r?.status === 'refused') throw new Error(`Couldn’t turn on keeping devices in step (${r.missing?.join(', ') || r.code}).`);
    }
    setAssistReady(programId);
    pg.close();
    await alertModal({
      title: `You’re in ${herName()}’s account`,
      message: 'Set up her kennel as she would: kennel, dogs, waitlist, settings. Everything syncs to her account as you go. Her Jotform and Stripe keys can only be entered on her own device.\n\nWhen you’re done, tell her to open KennelOS on her devices and choose “I already use KennelOS”.'
    });
  } catch (e) {
    pg.close();
    await alertModal({ title: 'Setup stopped', message: errorText(e) });
  }
}

async function joinHer(programId) {
  const controller = new AbortController();
  const overlay = openModal(`<h2 style="margin-top:0;">Connecting to ${esc(herName())}’s KennelOS…</h2>
    <p class="muted">Her app hands over her private records by itself while it’s open on one of her devices. If this waits, ask her to open KennelOS.</p>
    <div class="form-actions"><button class="btn" data-cancel>Cancel</button></div>`, { dismissible: false });
  overlay.querySelector('[data-cancel]').addEventListener('click', () => controller.abort());
  try {
    const r = await unlockAutomatically({ label: 'KennelOS support', signal: controller.signal });
    overlay.remove();
    if (r.status !== 'unlocked') return;
    prepareDirectJoin();
    const joined = await (await syncUI()).joinSyncFlow({ confirmed: true });
    if (joined) { await adoptOwnKennel(); setAssistReady(programId); globalThis.location?.reload?.(); }
  } catch (e) {
    overlay.remove();
    await alertModal({ title: 'Couldn’t connect', message: errorText(e) });
  }
}

// "Helping Dana · Hand back", fixed at the top of every page on support's device, so her
// program is never mistaken for anyone else's.
export function renderHelperBar() {
  if (!isHelperDevice() || document.getElementById('assist-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'assist-bar';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'KennelOS support');
  bar.style.cssText = 'position:sticky;top:0;z-index:1000;display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;'
    + 'background:#184A45;color:#F5F0E4;font:600 13px/1.3 system-ui,sans-serif;'
    + 'padding:calc(6px + env(safe-area-inset-top,0px)) max(12px,env(safe-area-inset-right,0px)) 6px max(12px,env(safe-area-inset-left,0px));';
  bar.innerHTML = `<span>KennelOS support · helping <strong>${esc(herName())}</strong></span>
    <button type="button" class="btn btn-sm" style="background:transparent;color:inherit;border:1px solid currentColor;">Hand back</button>`;
  bar.querySelector('button').addEventListener('click', handBack);
  document.body.prepend(bar);
}

async function handBack() {
  const ok = await confirmModal({
    title: 'Hand back?',
    message: `Your access to ${herName()}’s account ends now, and her records are wiped from this device. Everything you set up stays in her account.`,
    confirmLabel: 'Hand back'
  });
  if (!ok) return;
  try { await endHelp(); } catch (e) { if (e?.name !== 'CloudErasedError') { await alertModal({ title: 'That didn’t work', message: errorText(e) }); return; } }
  await eraseThisDevice();
}

// --- The automatic vault hand-over, on whichever side gives the key ---------------------

const LOOP_MS = 5000;
const STATE_MS = 60000;
let loops = null;

// Support's device during setup (her takeover), her device while she has asked for
// help. Polls only while the page is visible; checks the state every minute.
export function startAssistLoops({ win = globalThis } = {}) {
  if (loops) return loops.stop;
  let state = null;
  let stateAt = 0;
  let busy = false;
  const tick = async () => {
    if (busy || win.document?.visibilityState === 'hidden') return;
    busy = true;
    try {
      if (!state || Date.now() - stateAt > STATE_MS) { state = await assistState(); stateAt = Date.now(); }
      if (shouldAutoApprove(state)) {
        const n = await autoApproveOnce();
        if (n && !isHelperDevice()) win.dispatchEvent?.(new CustomEvent('kennelos:assist', { detail: { approved: n } }));
      }
    } finally { busy = false; }
  };
  const timer = setInterval(tick, LOOP_MS);
  tick();
  loops = { stop: () => { clearInterval(timer); loops = null; } };
  return loops.stop;
}

// --- Her takeover (step 5 of the plan) -----------------------------------------------------

// Her first sign-in on a program support set up: her private records from support's
// device, the join, her own recovery code, then support is signed out. Each step is
// skipped once done, so a later load finishes an interrupted takeover.
// → true when the takeover is complete.
export async function claimAssistedAccount() {
  const account = currentAccount();
  if (!account?.assisted || account.role === 'helper') return false;
  let st = await vaultStatus().catch(() => null);
  if (st?.enabled && !st.unlocked) {
    const controller = new AbortController();
    const overlay = openModal(`<h2 style="margin-top:0;">Welcome to your KennelOS</h2>
      <p>KennelOS support has set up your kennel. Getting your private records from support’s device…</p>
      <p class="muted">This takes a moment. Keep this page open.</p>
      <div class="form-actions"><button class="btn" data-cancel>Not now</button></div>`, { dismissible: false });
    overlay.querySelector('[data-cancel]').addEventListener('click', () => controller.abort());
    const r = await unlockAutomatically({ label: account.deviceLabel, signal: controller.signal }).catch((e) => ({ status: 'error', e }));
    overlay.remove();
    if (r.status === 'error') { await alertModal({ title: 'That didn’t work', message: errorText(r.e) }); return false; }
    if (r.status !== 'unlocked') return false;
  }
  if (!syncStatus().enabled) {
    prepareDirectJoin();
    const joined = await (await syncUI()).joinSyncFlow({ confirmed: true });
    if (!joined) return false;
    await adoptOwnKennel();
  }
  // Her own recovery code: support's device made the first one, so it's replaced here
  // and only she has the new one. Required to finish.
  for (;;) {
    await alertModal({ title: 'One last step: your recovery code', message: 'Support made a temporary one while setting up. Make your own now and keep it somewhere safe: with it, you can always get your private records back. Support never sees it.' });
    if (await (await vaultUI()).newRecoveryCodeFlow()) break;
    if (!(await confirmModal({ title: 'Finish setting up?', message: 'Your kennel is ready, but until you make your own recovery code, support’s temporary one still works.', confirmLabel: 'Make my code', cancelLabel: 'Later' }))) return false;
  }
  try { await markClaimed(); } catch (e) { await alertModal({ title: 'Almost done', message: `${errorText(e)} It will finish next time you open KennelOS.` }); return false; }
  st = null;
  await alertModal({ title: 'Your kennel is all yours', message: 'Everything support set up is here, and on every device you sign in on. Support’s access has ended. If you ever need help again: Settings → Account → Get help.' });
  return true;
}

// --- Settings → Account: help from KennelOS support ----------------------------------------

const STATE_LINE = {
  requested: 'You asked for help. Support will connect soon: keep KennelOS open on this device so it can hand over your private records.',
  helping: 'KennelOS support is helping you now. They can see and change your records until you end it.',
  setup: 'KennelOS support is setting up your account.',
};

export function helpSectionHtml(state) {
  const s = state?.state;
  const helping = s === 'requested' || s === 'helping';
  return `<h3 style="margin:16px 0 4px;font-size:15px;">Help from KennelOS support</h3>
    <p class="muted" style="font-size:13px;">${esc(STATE_LINE[s] || 'Stuck? Support can come into your account, set things up or fix them, and leave when you say.')}</p>
    <div class="form-actions">${helping
      ? '<button class="btn btn-sm btn-danger" data-assist="end">End help</button>'
      : s === 'setup' ? '' : '<button class="btn btn-sm" data-assist="help">Get help</button>'}</div>`;
}

export async function mountHelpSection(slot) {
  if (!slot || isHelperDevice()) return;
  const render = async () => {
    const state = await assistState();
    if (!slot.isConnected) return;
    slot.innerHTML = helpSectionHtml(state);
    slot.querySelector('[data-assist="help"]')?.addEventListener('click', async () => {
      const ok = await confirmModal({
        title: 'Ask KennelOS support for help?',
        message: 'Support gets a notification and connects from their own device. Until you end it, they can see and change everything in your program, private records included. They can’t change your email, sign-in, recovery code or license.\n\nKeep KennelOS open on this device while they connect.',
        confirmLabel: 'Get help'
      });
      if (!ok) return;
      try { await requestHelp(); startAssistLoops(); } catch (e) { await alertModal({ title: 'That didn’t work', message: errorText(e) }); }
      render();
    });
    slot.querySelector('[data-assist="end"]')?.addEventListener('click', async () => {
      if (!(await confirmModal({ title: 'End help?', message: 'Support’s access ends now, and their copy of your records is wiped. Anything they changed stays.', confirmLabel: 'End help' }))) return;
      try { await endHelp(); } catch (e) { await alertModal({ title: 'That didn’t work', message: errorText(e) }); }
      render();
    });
  };
  globalThis.addEventListener?.('kennelos:assist', render);
  await render();
}
