// kelsBackupSteps.js — Kels asking to turn on cloud backup, and Sensitive records
// backup on top of it, in the chat: one way for every task that needs them. Set
// up my waitlist asks for cloud backup before the list goes online; Set up my
// application form asks for both, since applications hold families' phone
// numbers, addresses and notes; account health says the same about Sensitive
// records (VAULT_WHY). The flows themselves are the cloud screens' own
// (cloudBackupUI.turnOnFlow, cloudVaultUI.turnOnVaultFlow), imported only when
// asked. Edition-honest: nothing is said where the cloud (or the vault) isn't offered.
import { isCloudAvailable, isVaultOffered } from '../data/cloud/cloudConfig.js';

// What Sensitive records backup adds, in her words.
export const VAULT_WHY = 'Turn on Sensitive records backup and they\'re saved too, encrypted so only you can read them.';

// What having cloud backup off costs her waitlist: the warning every offer to
// turn it on for the online form or list gives (Set up my application form, Set
// up my waitlist).
export const CLOUD_OFF_FORM = 'Without it, there\'s no link to share: families can\'t apply online, and you\'ll type each applicant in yourself.';

const backupOn = async () => {
  const { getBackupStatus } = await import('../data/cloud/cloudBackup.js');
  const s = getBackupStatus();
  return Boolean(s.account?.signedIn && s.enabled);
};

// Cloud backup on this device: true when it's on (already, or turned on here).
// `line`: why she's being asked (trusted markup); `later`: said when she says not now.
export async function offerCloudBackup(chat, { line, later = '' } = {}) {
  if (!isCloudAvailable()) return false;
  if (await backupOn()) return true;
  await chat.say(line);
  const pick = await chat.choose([{ label: 'Turn on cloud backup', value: 'yes', primary: true }, { label: 'Not now', value: '' }]);
  if (pick === 'yes') await (await import('./cloudBackupUI.js')).turnOnFlow();
  if (await backupOn()) return true;
  if (later) await chat.say(later, { typing: 300 });
  return false;
}

// Sensitive records backup: cloud backup first (offerCloudBackup), then the vault.
// `what`: what's sensitive here, as the start of her line ("Applications hold
// families' phone numbers, addresses and notes."). → true when it's on.
export async function offerSensitiveRecords(chat, { what = '' } = {}) {
  if (!isVaultOffered()) return false;
  const ui = await import('./cloudVaultUI.js');
  if (!(await offerCloudBackup(chat, {
    line: `${what} Sensitive records backup keeps them safe, and it works through cloud backup, which isn't on for this device yet. Want to turn it on? It only takes a minute.`,
    later: 'No problem. You can turn it on any time from Settings.'
  }))) return false;
  // Turning cloud backup on may have offered it already.
  if ((await ui.refreshVaultState()) !== 'off') return true;
  await chat.say(`${what} Right now your backup leaves those out. ${VAULT_WHY}`);
  const pick = await chat.choose([{ label: 'Turn it on', value: 'yes', primary: true }, { label: 'Not now', value: '' }]);
  if (pick !== 'yes') { await chat.say('No problem. You can turn it on any time from Settings.', { typing: 300 }); return false; }
  if (await ui.turnOnVaultFlow()) { await chat.say('Done! Their details are backed up and encrypted now.', { typing: 400 }); return true; }
  return false;
}
