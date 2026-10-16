// kelsSetup.js — the rules behind Kels's "Getting Started" (assets/kelsSetupUI.js):
// which parts this edition asks, what her logo is printed on, when the task sits
// at the top of the menu, and what a second kennel starts with. Pure: no db, no
// DOM; `flags` is editionFlags.
import { similarNamed } from './dogSearch.js';

// The parts, in the order she asks them. Each only where the edition has what it
// sets up, so a part for a missing feature is never asked or mentioned. The
// kennel's own settings (logo, nudges, tests, Puppy Record, another kennel) need its
// Kennel page (`kennelPage`: false in Lite, which has none).
//   logo         — only where something prints it (logoUses);
//   nudges       — the Today hub's promote nudge;
//   tests        — her preferred tests: added, removed or renamed;
//   puppy-record — Pro (Puppy Record);
//   kennels      — Pro (multiKennel): another kennel, for a separate side of the business;
//   furever      — Pro (Furever): Google Drive, for families' content packages;
//   assistant    — Pro (KennelAssistant): Dropbox, for a helper's phone;
//   backup       — every edition: cloud backup where offered, else a backup file.
export function setupParts(flags = {}, { kennelPage = true } = {}) {
  return [
    kennelPage && logoUses(flags).length ? 'logo' : null,
    kennelPage ? 'nudges' : null,
    kennelPage ? 'tests' : null,
    kennelPage && flags.puppyRecord ? 'puppy-record' : null,
    kennelPage && flags.multiKennel ? 'kennels' : null,
    flags.furever ? 'furever' : null,
    flags.assistant ? 'assistant' : null,
    'backup'
  ].filter(Boolean);
}

// What prints her logo in this edition, in her words. Empty: nothing does (Lite).
export function logoUses(flags = {}) {
  return [
    flags.invoicing ? 'invoices' : null,
    flags.invoicing ? 'receipts' : null,
    flags.puppyRecord ? 'puppy records' : null,
    flags.reports ? 'printed reports' : null
  ].filter(Boolean);
}

// "a, b and c".
export function listWords(words) {
  if (words.length < 2) return words[0] || '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

// "Elmwood Kennels'", "Bluebell's".
export const possessive = (name) => (/s$/i.test(String(name).trim()) ? `${String(name).trim()}'` : `${String(name).trim()}'s`);

// What she'll do, said after the opener in place of KELS_INTRO: each part is saved
// as it's answered, so there's no draft to build, approve or come back to.
export const SETUP_HOW = 'I\'ll go through your kennel\'s settings with you one at a time and save each one as we go. Skip anything you\'re not ready for; you can change it all later. Sound good?';

// While she's new (not one dog record on file, of any kind), the task sits near
// the top of her menu, however often she's run it; from her first dog on, near
// the bottom. `dogs`: every dog record, archived ones included.
export function isNewProgram({ dogs = [] } = {}) {
  return dogs.length === 0;
}

export const SETUP_PRIORITY_NEW = 95; // under unfinished drafts (97–100)
export const SETUP_PRIORITY = 15;     // under Check account health (20)

export function setupPriority(state) {
  return isNewProgram(state) ? SETUP_PRIORITY_NEW : SETUP_PRIORITY;
}

// The settings a second kennel starts with, copied from the one she just set up:
// the lifecycle nudges and the Puppy Record fields. Never its name, logo, public
// id, waitlist or tests (a separate side of the business sets its own).
export function settingsToCopy(kennel = {}) {
  const out = {};
  for (const key of ['promote_nudge_enabled', 'promote_age_male_months', 'promote_age_female_months', 'puppy_record_fields']) {
    if (kennel[key] !== undefined && kennel[key] !== null) out[key] = kennel[key];
  }
  return out;
}

// A new kennel's name, checked against every kennel she has. → null, a problem
// that stops her (no name), or a check she can tap past ({ key, message }).
export function newKennelNameProblem(name, kennels = []) {
  const typed = String(name || '').trim();
  if (!typed) return 'Give the new kennel a name.';
  const same = similarNamed(kennels, typed, (k) => k.kennel_name || '');
  if (!same) return null;
  return {
    key: `kennel:${typed.toLowerCase()}`,
    message: `You already have a kennel called "${same.kennel_name}"${same.is_own_kennel ? '' : ' (someone else\'s)'}. If this is a different one, tap Add again.`
  };
}
