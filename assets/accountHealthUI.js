// accountHealthUI.js — Kels's "Check account health": one look at whether her
// KennelOS program is safe and working, as a chat on pages/kels.html. The checks
// are data/accountHealth.js (pure); this gathers what they need, then raises each
// finding one at a time through the shared findings loop (assets/kelsFindings.js),
// with the app's own screens as the fixes (turn on cloud backup, Back up now, Your
// devices, Sensitive records…).
//
// Edition-honest: the cloud parts need isCloudAvailable() (and the vault and the
// waitlist online their release switches), the license Pro's gate, the vendor keys
// `accounts`, the waitlist `waitlist`. What isn't offered isn't checked or named.
// Reads go only where those features already go (the cloud, Lemon Squeezy, Stripe,
// Jotform), each wrapped so an offline one is skipped, never guessed.
import * as A from '../data/accountHealth.js';
import { getLastBackupDate } from '../data/settings.js';
import { requestPersistentStorage } from '../data/db.js';
import { downloadBackup } from '../data/importExport.js';
import { editionFlags, licenseConfig } from '../data/editionConfig.js';
import { isCloudAvailable, isVaultOffered, isWaitlistOnlineOffered } from '../data/cloud/cloudConfig.js';
import { isLicenseGated, evaluateLicense, activate } from '../data/license.js';
import { FindingsTask, plural } from './kelsFindings.js';
import { esc, fmtDate } from './ui.js';

const when = (iso) => esc(fmtDate(String(iso).slice(0, 10)));

// A new service worker took over while this page was open: the app on screen is
// the old one until a reload. The very first install (no worker controlled the
// page yet) isn't an update.
let swChanged = false;
const hadController = Boolean(globalThis.navigator?.serviceWorker?.controller);
globalThis.navigator?.serviceWorker?.addEventListener?.('controllerchange', () => { if (hadController) swChanged = true; });

const safe = async (fn) => { try { return await fn(); } catch { return null; } };

// Everything the checks read. Each part null when it couldn't be read.
export async function gatherHealthFacts() {
  const facts = { keys: [], waitlists: [], lastExportAt: getLastBackupDate() };
  facts.update = await safe(async () => {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (!reg) return null;
    await reg.update().catch(() => {});
    return { waiting: Boolean(swChanged || (navigator.serviceWorker.controller && (reg.waiting || reg.installing))) };
  });
  facts.storage = await safe(async () => {
    if (!navigator.storage?.persisted) return null;
    const persisted = await navigator.storage.persisted();
    const est = navigator.storage.estimate ? await navigator.storage.estimate() : {};
    return { persisted, usage: est.usage ?? null, quota: est.quota ?? null };
  });
  if (isLicenseGated()) {
    facts.license = await safe(async () => {
      return { gated: true, ...(await evaluateLicense()) };
    });
  }
  if (isCloudAvailable()) {
    const { getBackupStatus } = await import('../data/cloud/cloudBackup.js');
    const { currentAccount } = await import('../data/cloud/cloudAuth.js');
    facts.cloud = { available: true, backup: getBackupStatus() };
    const signedIn = Boolean(currentAccount()?.signedIn);
    if (signedIn && navigator.onLine !== false) {
      facts.devices = await safe(async () => (await import('../data/cloud/cloudDevices.js')).listDevices());
      if (isVaultOffered()) {
        facts.vault = await safe(async () => {
          const v = await import('../data/cloud/cloudVault.js');
          return { offered: true, status: await v.vaultStatus(), unsavedCode: Boolean(await v.unsavedRecoveryCode()) };
        });
      }
    }
    if (editionFlags.waitlist && isWaitlistOnlineOffered()) {
      facts.waitlists = await safe(async () => {
        const { kennelRepo } = await import('../data/kennelRepo.js');
        const { waitlistOnlineStatus } = await import('../data/cloud/cloudWaitlist.js');
        return (await kennelRepo.getAll()).filter((k) => k.is_own_kennel)
          .map((k) => ({ kennel: { id: k.id, kennel_name: k.kennel_name }, status: waitlistOnlineStatus(k) }))
          .filter((w) => w.status.online);
      }) || [];
    }
  }
  if (editionFlags.accounts) facts.keys = (await safe(vendorKeys)) || [];
  return facts;
}

// Each Payment service / Form service account with a key on this device, checked
// with its vendor (the same call the Accounts page makes on connect). ok: true
// works, false refused, null couldn't ask (offline, the browser blocked it).
async function vendorKeys() {
  const { accountRepo } = await import('../data/accountRepo.js');
  const { getStripeKey } = await import('../data/stripeKeyStore.js');
  const { getJotformKey } = await import('../data/jotformKeyStore.js');
  const out = [];
  for (const a of await accountRepo.getAll()) {
    // Her saved login for the vendor and the connection's settings ride along (in
    // memory only) for "Help me replace it".
    const account = { id: a.id, name: a.name || 'An account', username: a.username || '', password: a.password || '', website: a.website || '' };
    const stripe = a.account_type === 'payment_service' ? await getStripeKey(a.id) : null;
    const jot = a.account_type === 'form_service' ? await getJotformKey(a.id) : null;
    if (!stripe && !jot) continue;
    const vendor = stripe ? 'stripe' : 'jotform';
    account.currency = stripe?.currency || 'usd';
    account.region = jot?.region || 'us';
    if (navigator.onLine === false) { out.push({ account, vendor, ok: null }); continue; }
    try {
      if (stripe) await (await import('../data/stripeApi.js')).stripeCheckKey(stripe);
      else await (await import('../data/jotformApi.js')).jotformUser(jot);
      out.push({ account, vendor, ok: true });
    } catch (e) {
      out.push({ account, vendor, ok: e?.kind === 'auth' ? false : null, message: e?.message || '' });
    }
  }
  return out;
}

// For Kels's menu: always offered.
export async function runHealthTask(chat, { onExit = () => {} } = {}) {
  if (!(await chat.intro('Good idea, let\'s make sure everything\'s safe and sound!'))) return onExit('nevermind');
  return new Health(chat, onExit).start();
}

class Health extends FindingsTask {
  constructor(chat, onExit) {
    super(chat, onExit, 'health');
  }

  async load() {
    this.facts = await gatherHealthFacts();
    this.findings = this.notDismissed(A.healthFindings(this.facts));
  }

  start() {
    return this.loop({
      looking: 'Let me check on this device, your backups and your account…',
      report: () => this.report(),
      none: 'All good! You\'re doing a great job keeping things safe.',
      found: (findings) => `I found ${plural(findings.length, 'thing')} worth a look, so let's go one at a time.`,
      allDone: (n) => `That's everything! ${n === 1 ? 'One fix' : `${n} fixes`} in, and your program is in great shape.`,
      nothingDone: 'That\'s everything I found for now.',
      stopped: () => 'Okay, we\'ll stop here. Everything we fixed is saved.',
      stoppedEmpty: 'Okay. Ask me any time.'
    });
  }

  // Where everything stands (data/accountHealth.js healthReport), area by area.
  report() {
    const lines = A.healthReport(this.facts, (iso) => fmtDate(String(iso).slice(0, 10)));
    if (!lines.length) return '';
    return `Here's where everything stands:<br>${lines.map((l) => `<strong>${esc(l.area)}:</strong> ${esc(l.text)}`).join('<br>')}`;
  }

  async finish(all) {
    const left = this.findings.filter((f) => this.asked.has(f.key));
    if (all && left.length) {
      await this.chat.say(`${this.fixed ? 'Nice work.' : 'That\'s everything I found.'} Still worth a look when you have a minute: ${esc(left.map((f) => SHORT[f.kind]).join(', '))}.`);
      this.onExit('done');
      return;
    }
    return super.finish(all);
  }

  // --- Findings ------------------------------------------------------------------

  async handle(f) {
    const fix = FIXES[f.kind];
    return fix ? fix.call(this, f) : null;
  }

  cloudUI() { return import('./cloudBackupUI.js'); }
  vaultUI() { return import('./cloudVaultUI.js'); }

  // Publishes the online waitlist now (cloudWaitlist.syncWaitlistOnline, what the
  // kennel's Online list card does) and says how it went.
  async retryWaitlist(f, lead) {
    await this.chat.say(`${lead ? `${lead} ` : ''}Let me try publishing the waitlist now…`, { typing: 400 });
    const { syncWaitlistOnline, waitlistOnlineStatus } = await import('../data/cloud/cloudWaitlist.js');
    await syncWaitlistOnline({ force: true });
    const st = waitlistOnlineStatus(f.kennel);
    if (st.signedIn && !st.lastError) return this.done('It worked! Your online waitlist is up to date.');
    const { onlineProblemText } = await import('./waitlistOnlineUI.js');
    await this.chat.say(`It didn't go through yet. ${esc(onlineProblemText(st.lastError?.code || (st.signedIn ? '' : 'signed-out')))}`);
    return null;
  }
}

// What's left, in her closing line.
const SHORT = {
  'storage-persist': 'storage the browser could clear', 'storage-full': 'storage filling up',
  'backup-paused': 'cloud backup is paused', 'backup-off': 'cloud backup is off', 'backup-behind': 'a backup that\'s behind',
  'export-old': 'an old backup file', 'vault-locked': 'Sensitive records locked here', 'recovery-unsaved': 'the recovery code',
  'license-grace': 'your Pro license', update: 'an update to load', 'device-lost': 'a device to check',
  'key-rejected': 'a connection to fix', 'waitlist-signed-out': 'your online waitlist', 'waitlist-error': 'your online waitlist',
  'vault-off': 'Sensitive records backup', 'passkey-none': 'a passkey'
};

// One handler per kind: says what she found (a couple of warm words at most), offers
// the fix, does it. → 'later' | 'stop' | 'left' | anything (looked at).
const FIXES = {
  async 'storage-persist'(f) {
    const pick = await this.ask(f, 'This browser could clear your records if the device runs low on space. I can ask it to keep them safe.', [
      { label: 'Ask the browser', value: 'fix', primary: true }
    ]);
    if (pick !== 'fix') return pick;
    if (await requestPersistentStorage()) return this.done('Done! Your browser will keep your records safe from clean-ups.');
    await this.chat.say('The browser said not yet. Browsers decide this themselves. Installing KennelOS to your home screen, and using it often, usually earns it. I\'ll check again next time.');
    return null;
  },

  async 'storage-full'(f) {
    const share = Math.round((f.usage / f.quota) * 100);
    const pick = await this.ask(f, `Your records are using ${share}% of the space this browser allows (${esc(A.bytesText(f.usage))} of ${esc(A.bytesText(f.quota))}). Big photos and files take the most. Worth keeping an eye on.`, [
      { label: 'Got it', value: 'ok', primary: true }
    ]);
    return pick;
  },

  async 'backup-off'(f) {
    const pick = await this.ask(f, 'Cloud backup is off on this device, so if it\'s lost or broken your records go with it. Want to turn it on? It backs up by itself after that.', [
      { label: 'Turn on cloud backup', value: 'fix', primary: true }
    ]);
    if (pick !== 'fix') return pick;
    const ui = await this.cloudUI();
    if (await ui.turnOnFlow()) return this.done('Cloud backup is on. Smart move!');
    await this.chat.say('No problem, it\'s still off. You can turn it on any time from Import/Export.');
    return null;
  },

  async 'backup-paused'(f) {
    const pick = await this.ask(f, 'Cloud backup is on, but it\'s paused and waiting on you. Let\'s see what it needs.', [
      { label: 'See what it needs', value: 'fix', primary: true }
    ]);
    if (pick !== 'fix') return pick;
    return pushNow.call(this);
  },

  async 'backup-behind'(f) {
    const said = f.lastPushedAt ? `Your last cloud backup was ${when(f.lastPushedAt)}, and you've made changes since.` : 'Cloud backup is on, but nothing has backed up yet.';
    const pick = await this.ask(f, `${said} Want me to back up now?`, [{ label: 'Back up now', value: 'fix', primary: true }]);
    if (pick !== 'fix') return pick;
    return pushNow.call(this);
  },

  async 'export-old'(f) {
    const said = f.lastExportAt ? `Your last backup file is from ${when(f.lastExportAt)}.` : 'You haven\'t saved a backup file yet.';
    const pick = await this.ask(f, `${said} Without cloud backup, a backup file is what saves your records if this device is lost. Want to save one now?`, [
      { label: 'Download a backup now', value: 'fix', primary: true }
    ]);
    if (pick !== 'fix') return pick;
    await downloadBackup();
    return this.done('Saved! Keep that file somewhere safe, like your email or a cloud drive.');
  },

  async 'vault-locked'(f) {
    const pick = await this.ask(f, 'Your Sensitive records (phone numbers, addresses, prices, notes) are locked on this device, so backups are waiting. Let\'s unlock them.', [
      { label: 'Unlock them', value: 'fix', primary: true }
    ], { never: null });
    if (pick !== 'fix') return pick;
    if (await (await this.vaultUI()).unlockModal({ merge: true })) return this.done('Unlocked. Your backups can carry on.');
    return null;
  },

  async 'recovery-unsaved'(f) {
    const pick = await this.ask(f, 'Your Sensitive records\' recovery code isn\'t saved yet. It\'s the only way back in if you lose every device, so it\'s worth two minutes.', [
      { label: 'Save my recovery code', value: 'fix', primary: true }
    ], { never: null });
    if (pick !== 'fix') return pick;
    const ui = await this.vaultUI();
    const ok = f.unsavedCode ? await ui.saveRecoveryCodeFlow() : await ui.newRecoveryCodeFlow();
    if (ok) return this.done('Saved. That\'s a big one, thank you!');
    return null;
  },

  async 'license-grace'(f) {
    const pick = await this.ask(f, `Your Pro license needs attention${f.expiresAt ? ` (it was due ${when(f.expiresAt)})` : ''}. KennelOS still works for now, but let's sort it before it stops.`, [
      { label: 'Check it again now', sub: 'If you\'ve just renewed or got back online', value: 'check', primary: true },
      ...(licenseConfig?.checkoutUrl ? [{ label: 'Renew my subscription', sub: 'Opens the store in a new tab', value: 'renew' }] : []),
      { label: 'Use a different key', value: 'key' }
    ], { never: null });
    if (pick === 'check') {
      const { state, record } = await evaluateLicense();
      if (state === 'valid') return this.done('Confirmed! Your Pro license is all good.');
      await this.chat.say(record?.interval === 'lifetime'
        ? 'I still can\'t reach the license server from here. Your Lifetime license is fine; once this device is online, it confirms by itself.'
        : 'I still can\'t confirm an active subscription. If you\'ve renewed, give it a few minutes and check again; otherwise renewing keeps Pro going.');
      return null;
    }
    if (pick === 'renew') {
      await this.chat.say('I\'ll open the store in a new tab. Once you\'ve renewed, close that tab and come back here, and I\'ll check it again.');
      if ((await this.chat.choose([{ label: 'Okay, open it', value: 'go', primary: true }, { label: 'Not now', value: '' }])) !== 'go') return null;
      window.open(licenseConfig.checkoutUrl, '_blank', 'noopener');
      await this.chat.choose([{ label: 'I\'m back, check it now', value: 'go', primary: true }]);
      const { state } = await evaluateLicense();
      if (state === 'valid') return this.done('Confirmed! Thanks for renewing.');
      await this.chat.say('It isn\'t showing as renewed yet. It can take a few minutes; I\'ll look again next time.');
      return null;
    }
    if (pick === 'key') {
      const res = await this.chat.form({
        title: '<strong>Paste your license key.</strong><span class="kels-lead">It\'s in your purchase confirmation email.</span>',
        html: `<div class="field gl-field"><label>License key</label><input id="ah-key" type="text" autocomplete="off" spellcheck="false"></div>`,
        submitLabel: 'Activate',
        cancelLabel: 'Not now',
        submit: async (root) => {
          const record = await activate(root.querySelector('#ah-key').value); // throws its own message
          return { record };
        },
        reply: () => 'Activate this key'
      });
      if (!res.done) return null;
      return this.done('That key is active on this device. You\'re all set!');
    }
    return pick;
  },

  async update(f) {
    const pick = await this.ask(f, 'There\'s a new version of KennelOS ready. A quick reload and you\'re on it.', [
      { label: 'Reload now', value: 'fix', primary: true }
    ], { never: null });
    if (pick !== 'fix') return pick;
    await this.chat.say('Reloading. See you in a second!');
    await this.chat.pause(900);
    location.reload();
    return 'left';
  },

  async 'device-lost'(f) {
    const d = f.device;
    const pick = await this.ask(f, `<strong>${esc(d.label || 'A device')}</strong> is still signed in to your account but hasn't been seen since ${when(d.lastSeenAt)}. If it's lost or gone, you can erase it${isLicenseGated() ? ' and free its Pro license' : ''}.`, [
      { label: 'Open Your devices', value: 'fix', primary: true }
    ], { never: 'It\'s fine, I still use it' });
    if (pick !== 'fix') return pick;
    await (await this.cloudUI()).devicesModal();
    await this.chat.say('Okay. I\'ll look again.', { typing: 300 });
    return null;
  },

  async 'key-rejected'(f) {
    const vendor = f.vendor === 'stripe' ? 'Stripe' : 'Jotform';
    const pick = await this.ask(f, `The ${vendor} key on <strong>${esc(f.account.name)}</strong> isn't working.${f.message ? ` ${esc(f.message)}` : ''} Until it's fixed, KennelOS can't use that connection.`, [
      { label: 'Help me replace it', value: 'fix', primary: true }
    ]);
    if (pick !== 'fix') return pick;
    const { vendorKeyFlow } = await import('./vendorKeyUI.js');
    const ok = await vendorKeyFlow(this.chat, f.account, f.vendor, { replacing: true, resumeTask: 'Check account health' });
    return ok ? this.done(`It works! ${esc(f.account.name)} is connected again. Nicely done.`) : null;
  },

  async 'waitlist-signed-out'(f) {
    const pick = await this.ask(f, `<strong>${esc(f.kennel.kennel_name || 'Your kennel')}</strong>'s waitlist is online, but this device isn't signed in to the cloud, so new applications aren't coming in here.`, [
      { label: 'Sign in now', value: 'fix', primary: true }
    ]);
    if (pick !== 'fix') return pick;
    const ui = await this.cloudUI();
    if (!(await ui.signInModal({ intro: 'Your online waitlist works through your cloud backup account.' }))) return null;
    return this.retryWaitlist(f, 'Signed in.');
  },

  async 'waitlist-error'(f) {
    const { onlineProblemText } = await import('./waitlistOnlineUI.js');
    const why = f.error?.code ? onlineProblemText(f.error.code) : (f.error?.message || '');
    const pick = await this.ask(f, `<strong>${esc(f.kennel.kennel_name || 'Your kennel')}</strong>'s online waitlist hit a problem the last time it updated.${why ? ` ${esc(why)}` : ''}`, [
      ...(f.error?.code === 'backup-off' ? [{ label: 'Turn on cloud backup', value: 'backup', primary: true }] : []),
      { label: 'Try again now', value: 'fix', primary: f.error?.code !== 'backup-off' }
    ]);
    if (pick === 'backup') {
      if (!(await (await this.cloudUI()).turnOnFlow())) return null;
      return this.retryWaitlist(f, 'Cloud backup is on.');
    }
    if (pick !== 'fix') return pick;
    return this.retryWaitlist(f, '');
  },

  async 'vault-off'(f) {
    const pick = await this.ask(f, 'Your backup leaves out Sensitive records (phone numbers, addresses, prices, notes). Turn on Sensitive records backup and they\'re saved too, encrypted so only you can read them.', [
      { label: 'Turn it on', value: 'fix', primary: true }
    ]);
    if (pick !== 'fix') return pick;
    if (await (await this.vaultUI()).turnOnVaultFlow()) return this.done('Done! Everything is backed up now.');
    return null;
  },

  async 'passkey-none'(f) {
    const pick = await this.ask(f, 'You can add a passkey (your fingerprint or face) to unlock Sensitive records on a new device, instead of typing the recovery code.', [
      { label: 'Add a passkey', value: 'fix', primary: true }
    ]);
    if (pick !== 'fix') return pick;
    await (await this.vaultUI()).passkeysModal();
    return null;
  }
};

// Back up now, through the cloud screens' own result handling (a conflict, a
// shrink, locked Sensitive records each open their dialog).
async function pushNow() {
  const { pushIfDirty, getBackupStatus } = await import('../data/cloud/cloudBackup.js');
  const ui = await this.cloudUI();
  const result = await pushIfDirty({ force: true });
  await ui.handlePushResult(result);
  const s = getBackupStatus();
  if (!s.paused && (result?.status === 'pushed' || result?.status === 'unchanged')) return this.done('Backed up. You\'re all set!');
  await this.chat.say(esc(ui.statusLine(s)));
  return null;
}
