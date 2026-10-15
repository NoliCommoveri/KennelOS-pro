// accountHealth.js — Kels's "Check account health", the data half (pure). Is her
// KennelOS program safe and working: this device, its backup, her Pro license,
// Sensitive records, and her connections. "Account" is her KennelOS account and
// this device, never the business Accounts page (decided).
//
// assets/accountHealthUI.js gathers the facts (each read can fail offline, and a
// failed one is null, so its checks are skipped, never guessed) and asks her about
// each finding in HEALTH_KINDS order, one at a time, with its fix. No reads or
// writes here.
//
// facts: {
//   update:   { waiting } | null          a new version is downloaded, not running yet
//   storage:  { persisted, usage, quota } | null   navigator.storage
//   cloud:    { available, backup } | null  backup = cloudBackup.getBackupStatus()
//   lastExportAt: ISO | null               the last JSON backup file (settings.getLastBackupDate)
//   license:  { gated, state, record } | null       license.evaluateLicense(), gated = Pro's gate on
//   devices:  [listDevices row] | null    signed in only
//   vault:    { offered, status, unsavedCode } | null   status = cloudVault.vaultStatus()
//   keys:     [{ account: { id, name }, vendor: 'stripe' | 'jotform', ok, message }]   ok null = couldn't ask
//   waitlists:[{ kennel: { id, kennel_name }, status }]  waitlistOnlineStatus, online kennels only
// }

export const DAY_MS = 86400000;
// No cloud backup: a JSON backup file older than this is a finding (decided).
export const EXPORT_MAX_DAYS = 14;
// Another device on the account unseen this long is "lost" (decided).
export const DEVICE_LOST_DAYS = 60;
// Browser storage this full is worth a word.
export const STORAGE_FULL_SHARE = 0.8;
// Cloud backup with changes waiting this long is behind (the Import/Export card's "Not backed up for n days").
export const BACKUP_BEHIND_DAYS = 1;

// The order she raises them in: things that put records at risk first.
export const HEALTH_KINDS = Object.freeze([
  'storage-persist', 'backup-paused', 'backup-off', 'backup-behind', 'export-old',
  'vault-locked', 'recovery-unsaved', 'license-grace', 'update',
  'device-lost', 'key-rejected', 'waitlist-signed-out', 'waitlist-error',
  'vault-off', 'passkey-none', 'storage-full'
]);

const ageDays = (iso, now) => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? (now - t) / DAY_MS : Infinity;
};

// Cloud backup is on and doing its job, so a JSON file isn't needed.
export const cloudBacksUp = (cloud) => Boolean(cloud?.available && cloud.backup?.enabled && !cloud.backup.paused);

// → [{ kind, key, …details }] in HEALTH_KINDS order. `key` is unique per finding
// and carries what it was raised on, so "Don't ask me again" on one lost device
// doesn't silence another.
export function healthFindings(facts = {}, now = Date.now()) {
  const out = [];
  const add = (kind, extra = {}, keyBit = '') => out.push({ kind, key: keyBit ? `${kind}:${keyBit}` : kind, ...extra });
  const { update, storage, cloud, license, devices, vault, keys = [], waitlists = [] } = facts;

  if (update?.waiting) add('update');
  if (storage?.persisted === false) add('storage-persist');
  if (storage?.quota > 0 && storage.usage / storage.quota >= STORAGE_FULL_SHARE) add('storage-full', { usage: storage.usage, quota: storage.quota });

  const b = cloud?.available ? cloud.backup : null;
  if (b) {
    if (!b.enabled) {
      // Records that moved to Pro back up from there; nothing to fix here.
      if (b.movedToEdition !== 'pro') add('backup-off');
    } else if (b.paused) {
      add('backup-paused', { code: b.lastError?.code || null }, b.lastError?.code || '');
    } else if (!b.lastPushedAt || (b.dirty && ageDays(b.lastPushedAt, now) > BACKUP_BEHIND_DAYS)) {
      add('backup-behind', { lastPushedAt: b.lastPushedAt || null });
    }
  }
  if (!cloudBacksUp(cloud) && ageDays(facts.lastExportAt, now) > EXPORT_MAX_DAYS) {
    add('export-old', { lastExportAt: facts.lastExportAt || null });
  }

  if (license?.gated && license.state === 'grace') add('license-grace', { expiresAt: license.record?.expiresAt || null });

  for (const d of devices || []) {
    if (d.thisDevice || d.erase || d.status === 'signed-out-here') continue;
    if (ageDays(d.lastSeenAt, now) >= DEVICE_LOST_DAYS) add('device-lost', { device: d }, d.id);
  }

  const v = vault?.offered ? vault.status : null;
  if (v) {
    if (!v.enabled) add('vault-off');
    else {
      if (!v.unlocked) add('vault-locked');
      if (vault.unsavedCode || !v.recovery) add('recovery-unsaved', { unsavedCode: Boolean(vault.unsavedCode) });
      if (v.passkeySupported && !(v.passkeys || []).length) add('passkey-none');
    }
  }

  for (const k of keys) if (k.ok === false) add('key-rejected', { account: k.account, vendor: k.vendor, message: k.message || '' }, `${k.vendor}:${k.account.id}`);

  for (const w of waitlists) {
    if (!w.status?.online) continue;
    if (!w.status.signedIn) add('waitlist-signed-out', { kennel: w.kennel }, w.kennel.id);
    else if (w.status.lastError) add('waitlist-error', { kennel: w.kennel, error: w.status.lastError }, w.kennel.id);
  }

  const rank = (f) => HEALTH_KINDS.indexOf(f.kind);
  return out.sort((a, b2) => rank(a) - rank(b2));
}

// "12 MB", "1.4 GB".
export function bytesText(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1000 * 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

// Where everything stands, for her status report right after she looks: one
// { area, text } per area she checked, good or not, in plain text. `fmtDate(iso)`
// formats a date for her. Areas she couldn't read (null facts) are left out.
export function healthReport(facts = {}, fmtDate = (iso) => String(iso).slice(0, 10)) {
  const out = [];
  const add = (area, text) => out.push({ area, text });
  const { storage, cloud, license, devices, vault, keys = [], waitlists = [] } = facts;

  if (storage) {
    const kept = storage.persisted === true ? 'kept safe from clean-ups' : storage.persisted === false ? 'could be cleared by the browser' : '';
    const used = storage.usage != null ? `using ${bytesText(storage.usage)}${storage.quota ? ` of ${bytesText(storage.quota)}` : ''}` : '';
    if (kept || used) add('This device', [kept, used].filter(Boolean).join(', '));
  }
  if (facts.update?.waiting) add('App', 'a new version is ready to load');

  const b = cloud?.available ? cloud.backup : null;
  if (b) {
    if (!b.enabled) add('Cloud backup', b.movedToEdition === 'pro' ? 'off here: your records moved to Pro' : 'off');
    else if (b.paused) add('Cloud backup', 'on, but paused');
    else add('Cloud backup', b.lastPushedAt ? `on, last backed up ${fmtDate(b.lastPushedAt)}${b.dirty ? ', with changes waiting' : ''}` : 'on, not backed up yet');
  }
  if (!cloudBacksUp(cloud)) add('Backup file', facts.lastExportAt ? `last saved ${fmtDate(facts.lastExportAt)}` : 'never saved');

  if (license?.gated) {
    const r = license.record || {};
    const plan = r.interval === 'lifetime' ? 'lifetime' : r.interval || '';
    const state = { valid: 'active', grace: 'needs attention', wall: 'not active', unactivated: 'not activated' }[license.state] || license.state;
    const when = r.interval === 'lifetime' ? '' : r.expiresAt ? `${license.state === 'valid' ? 'renews' : 'was due'} ${fmtDate(r.expiresAt)}` : '';
    const seats = Number.isFinite(r.activationUsage)
      ? `on ${r.activationUsage}${Number.isFinite(r.activationLimit) ? ` of ${r.activationLimit}` : ''} device${r.activationUsage === 1 && !Number.isFinite(r.activationLimit) ? '' : 's'}` : '';
    add('Pro license', [`${state}${plan ? ` (${plan})` : ''}`, when, seats].filter(Boolean).join(', '));
  }

  if (devices) {
    const active = devices.filter((d) => d.status === 'signed-in' && !d.erase);
    const others = active.filter((d) => !d.thisDevice).map((d) => d.label || 'a device');
    add('Devices', `${active.length} signed in${active.length ? ` (this one${others.length ? `, ${others.join(', ')}` : ''})` : ''}`);
  }

  const v = vault?.offered ? vault.status : null;
  if (v) {
    if (!v.enabled) add('Sensitive records', 'not backed up');
    else {
      const bits = [v.unlocked ? 'backed up, unlocked here' : 'backed up, locked on this device',
        vault.unsavedCode || !v.recovery ? 'recovery code not saved' : 'recovery code saved',
        `${(v.passkeys || []).length || 'no'} passkey${(v.passkeys || []).length === 1 ? '' : 's'}`];
      add('Sensitive records', bits.join(', '));
    }
  }

  for (const k of keys) {
    const vendor = k.vendor === 'stripe' ? 'Stripe' : 'Jotform';
    add(k.account.name, `${vendor} ${k.ok ? 'connected and working' : k.ok === false ? 'key refused' : 'couldn\'t check right now'}`);
  }
  for (const w of waitlists) {
    const s = w.status || {};
    add(`${w.kennel.kennel_name || 'Kennel'} waitlist`, !s.signedIn ? 'online, but this device isn\'t signed in'
      : s.lastError ? 'online, last update failed' : `online${s.formOpen ? ', taking applications' : ''}`);
  }
  return out;
}
