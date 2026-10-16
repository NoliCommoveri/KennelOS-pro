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
  breed_feeding_schedules: 'a feeding schedule'
};

// The name she'd know it by, or what kind of record it is.
export function recordName(tbl, row) {
  const name = row && [row.call_name, row.registered_name, row.name, row.kennel_name, row.nickname, row.title, row.filename, row.description]
    .find((v) => typeof v === 'string' && v.trim());
  return name ? name.trim() : (NOUNS[tbl] || 'a record');
}

const DROP_REASONS = {
  record_too_large: "it's too large to sync (a big logo? Replace it with a smaller one)"
};

// One activity item → a sentence. `name` from recordName; `deviceLabel` for
// kept_theirs ("Jen's laptop"), or null.
export function activityText(item, name, deviceLabel = null) {
  const text = sentence(item, name, deviceLabel);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function sentence(item, name, deviceLabel) {
  switch (item.kind) {
    case 'kept_theirs':
      return `Kept the version of ${name} from ${deviceLabel || 'another device'} (the change here was older).`;
    case 'replaced_theirs':
      return `Your change to ${name} replaced one made on another device a moment before.`;
    case 'archived_instead':
      return `${name} was deleted on another device, but records here still use it, so it was archived instead.`;
    case 'missing_file':
      return `The file for ${name} couldn't be downloaded yet. It comes down the next time it changes.`;
    case 'dropped':
      return `${name} couldn't sync: ${DROP_REASONS[item.reason] || 'the cloud refused it'}. It tries again after it changes.`;
    default:
      return `Something happened to ${name}.`;
  }
}

// → [{ at, text }], newest first. `deviceLabels`: Map of device id → label.
export async function describeActivity(items, deviceLabels = new Map()) {
  const out = [];
  for (const item of items) {
    let row = null;
    try { row = await db.table(item.tbl).get(item.id); } catch { /* a table this build doesn't have */ }
    out.push({ at: item.at, text: activityText(item, recordName(item.tbl, row), deviceLabels.get(item.by) || null) });
  }
  return out;
}
