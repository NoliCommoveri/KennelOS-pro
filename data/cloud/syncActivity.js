// syncActivity.js — live sync's activity list in words (Cloud Phase 2 plan §2.3):
// what sync decided on its own in the last 30 days, said one line each, with the
// record named. The list itself is kept by cloudSync.js (getCloudSyncState().activity);
// this only reads the records it names. `recordName` and `activityText` are pure.
import { db } from '../db.js';

const NOUNS = {
  dogs: 'a dog', litters: 'a litter', pairings: 'a pairing', contacts: 'a contact', kennels: 'a kennel',
  sales: 'a sale', stud_services: 'a stud service', contracts: 'a contract', events: 'an event',
  waitlist_entries: 'a waitlist entry', waitlist_programs: 'a waitlist program', waitlist_offers: 'a waitlist offer',
  expenses: 'an expense', documents: 'a document', files: 'a file', accounts: 'an account',
  breed_feeding_schedules: 'a feeding schedule', do_not_sell: 'a do-not-sell listing'
};

// What kind of record a table holds, without the article: "Dog", "Waitlist entry".
export function recordKind(tbl) {
  const noun = (NOUNS[tbl] || 'a record').replace(/^an? /, '');
  return noun.charAt(0).toUpperCase() + noun.slice(1);
}

// The name she'd know it by, or what kind of record it is.
export function recordName(tbl, row) {
  const name = row && [row.call_name, row.registered_name, row.name, row.kennel_name, row.nickname, row.title, row.filename, row.description]
    .find((v) => typeof v === 'string' && v.trim());
  return name ? name.trim() : (NOUNS[tbl] || 'a record');
}

const DROP_REASONS = {
  record_too_large: "it's too large to sync (a big logo? Replace it with a smaller one)",
  too_large: "it's too large to sync (a big logo? Replace it with a smaller one)"
};

// One activity item → a sentence. `name` from recordName; `deviceLabel` for the
// device named in `by` ("Jen's laptop"), or null.
//
// Each line says what happened, never why one version was "older": the rule is
// the order the server received them in (plan §12 decision 3), which says
// nothing about when either change was made (K03 review, 10). Only a join
// decides by date, and its line says so.
export function activityText(item, name, deviceLabel = null) {
  const text = sentence(item, name, deviceLabel);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function sentence(item, name, deviceLabel) {
  const other = deviceLabel || 'another device';
  const gone = item.op === 'delete';
  switch (item.kind) {
    case 'kept_theirs':
      if (item.reason === 'older') return `${name} had a different version on ${other} with a later date, so that one was kept here.`;
      return gone
        ? `${name} was deleted on ${other} while your change here was waiting to be sent, so your change is gone.`
        : `${name} was changed on ${other} while your change here was waiting to be sent. ${capital(other)}'s version was kept.`;
    case 'replaced_mine':
      return gone
        ? `${name} was deleted on ${other}, which hadn't yet seen your change made here.`
        : `Your change to ${name} was replaced by one from ${other}, which hadn't yet seen it.`;
    case 'replaced_theirs':
      return `Your change to ${name} replaced one from ${other} that this device hadn't seen yet.`;
    case 'clock':
      return item.where === 'here'
        ? `The version of ${name} here was dated in the future, so the cloud's was kept. Check this device's date and time.`
        : `The cloud's version of ${name} was dated in the future, so the one here was kept. Check the date and time on your other devices.`;
    case 'archived_instead':
      return `${name} was deleted on another device, but records here still use it, so it was archived instead.`;
    case 'missing_file':
      return `The file for ${name} couldn't be downloaded yet. It's tried again each time this device syncs.`;
    case 'needs_update':
      return 'Some changes from your other devices need a newer version of KennelOS here. Update this device to see them.';
    case 'dropped':
      return `${name} couldn't sync: ${DROP_REASONS[item.reason] || 'the cloud refused it'}. It tries again after it changes.`;
    default:
      return `Something happened to ${name}.`;
  }
}

const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// → [{ at, text }], newest first. `deviceLabels`: Map of device id → label.
export async function describeActivity(items, deviceLabels = new Map()) {
  const out = [];
  for (const item of items) {
    let row = null;
    if (item.id != null) {
      try { row = await db.table(item.tbl).get(item.id); } catch { /* a table this build doesn't have */ }
    }
    out.push({ at: item.at, text: activityText(item, recordName(item.tbl, row), deviceLabels.get(item.by) || null) });
  }
  return out;
}
