// assistantSync.js — the Dropbox-backed sync flows for the main app (the
// KennelAssistant page has its own store; see data/assistantStore.js).
//
// Three files live in the Dropbox app folder, and each has exactly ONE writer —
// that single-writer split is what makes the whole scheme conflict-free:
//   /kennelos-backup.json   written HERE (pushToDropbox) — the full JSON backup,
//                           same object the download-backup button builds; a
//                           second phone pulls it and merge-restores.
//   /assistant-feed.json    written HERE (pushToDropbox) — the curated slice the
//                           KennelAssistant app is allowed to see: basic dog
//                           fields + dog-subject events. Privacy is enforced at
//                           BUILD time (a positive allow-list, same posture as
//                           companionExport.js): contacts, sales, financials,
//                           and the rest never reach the assistant device at all.
//   /assistant-outbox.json  written by the ASSISTANT app — events the kid
//                           logged. importAssistantEvents() folds them in here.
//                           They arrive with their own UUIDs, so importing is
//                           pure upsert: re-importing the same outbox is a no-op.
//
// Lives in the data layer, so like importExport.js it may use `db` directly for
// the cross-table work; pages call these functions, never the pieces.
import { db } from './db.js';
import { exportAll, restoreBackup, inspectBackup } from './importExport.js';
import { dropboxUploadJson, dropboxDownloadJson, DROPBOX_PATHS } from './dropbox.js';
import { setLastBackupDate } from './settings.js';
import { EVENT_TYPES, ASSISTANT_EVENT_TYPES, descriptor } from './vocab.js';

// Bumped only if the feed/outbox shapes ever change incompatibly.
export const ASSISTANT_FORMAT_VERSION = 1;

// The ONLY Dog fields that ride the assistant feed. Deliberately excludes
// registration/microchip numbers, ownership, parentage FKs, prices — the
// assistant needs "which dog is this" and nothing more. Widen by adding a field
// here (and note it in the End-State guide §25).
const ASSISTANT_DOG_FIELDS = [
  'id', 'call_name', 'registered_name', 'breed', 'sex', 'status',
  'date_of_birth', 'date_of_death', 'color_markings', 'url', 'is_archived'
];

// Build the assistant feed: every dog (named-field copies only) plus the
// dog-subject events whose type is in the ASSISTANT_EVENT_TYPES allow-list
// (vocab.js — one list gates what the assistant sees AND what it can log).
// Archived records ride along with their flag so the assistant store can
// filter exactly like the main app does.
//
// Beyond ASSISTANT_DOG_FIELDS, each dog carries three DERIVED display fields
// so the assistant can group a litter and name its parents without ever
// receiving the litters table or parentage FKs: `litter_id` (grouping key
// only), `litter_nickname`, and `sire_name`/`dam_name` (call-name copies,
// same "named copy, no record spread" posture as companion's dogCard).
export async function buildAssistantFeed() {
  const dogs = await db.dogs.toArray();
  const litters = await db.litters.toArray();
  const events = (await db.events.toArray())
    .filter((e) => e.subject_type === 'dog' && ASSISTANT_EVENT_TYPES.includes(e.event_type));
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const littersById = new Map(litters.map((l) => [l.id, l]));
  const nameOf = (id) => {
    const d = id ? dogsById.get(id) : null;
    return d ? (d.call_name || d.registered_name || null) : null;
  };
  return {
    format_version: ASSISTANT_FORMAT_VERSION,
    generated_at: new Date().toISOString(),
    dogs: dogs.map((d) => {
      const out = {};
      for (const f of ASSISTANT_DOG_FIELDS) out[f] = d[f] ?? null;
      const litter = d.litter_id ? littersById.get(d.litter_id) : null;
      out.litter_id = d.litter_id ?? null;
      out.litter_nickname = litter ? (litter.nickname || null) : null;
      out.sire_name = nameOf(d.sire_id);
      out.dam_name = nameOf(d.dam_id);
      return out;
    }),
    events
  };
}

// Push both owner-written files in one act: the full backup (for the second
// phone) and the freshly rebuilt assistant feed (so the kid's app is never
// stale relative to the last push). Counts as a backup for the reminder date.
export async function pushToDropbox() {
  const backup = await exportAll();
  await dropboxUploadJson(DROPBOX_PATHS.backup, backup);
  const feed = await buildAssistantFeed();
  await dropboxUploadJson(DROPBOX_PATHS.feed, feed);
  setLastBackupDate(backup.exported_at);
  const records = Object.values(backup.collections).reduce((n, rows) => n + rows.length, 0);
  return { records, dogs: feed.dogs.length, events: feed.events.length };
}

// Fetch the backup another phone pushed. Returns { backup, info } for the page
// to confirm before merging, or null when nothing has ever been pushed.
export async function fetchDropboxBackup() {
  const backup = await dropboxDownloadJson(DROPBOX_PATHS.backup);
  if (!backup) return null;
  return { backup, info: inspectBackup(backup) };
}

// Merge-restore a fetched backup (upsert by id — same engine as file restore).
export function mergeDropboxBackup(backup) {
  return restoreBackup(backup, 'merge');
}

// --- Assistant outbox ------------------------------------------------------

// Fetch the kid's outbox and annotate every event for the preview, without
// writing anything. Statuses:
//   'new'      — will be inserted;
//   'update'   — id already exists here (a re-import); upsert is harmless;
//   'no_dog'   — subject dog doesn't exist in this database → SKIPPED, per the
//                import rule that an unresolvable reference is flagged, never
//                invented;
//   'invalid'  — missing a required event field → skipped.
// Returns null when no outbox file exists yet.
export async function fetchAssistantOutbox() {
  const outbox = await dropboxDownloadJson(DROPBOX_PATHS.outbox);
  if (!outbox) return null;
  if (!Array.isArray(outbox.events)) {
    throw new Error('The assistant outbox file in Dropbox has an unexpected shape.');
  }
  const rows = [];
  for (const ev of outbox.events) {
    const required = ev && ev.id && ev.subject_type === 'dog' && ev.subject_id && ev.event_type && ev.event_date && ev.title;
    const dog = required ? await db.dogs.get(ev.subject_id) : null;
    const existing = required ? await db.events.get(ev.id) : null;
    rows.push({
      event: ev,
      status: !required ? 'invalid' : !dog ? 'no_dog' : existing ? 'update' : 'new',
      dogName: dog ? (dog.call_name || dog.registered_name || '(unnamed dog)') : null,
      typeLabel: descriptor(EVENT_TYPES, ev?.event_type).label
    });
  }
  return { generated_at: outbox.generated_at || null, rows };
}

// Commit the importable rows from a fetched outbox. Strips the assistant's
// local `pending` marker and stamps updated_at; created_at/id are the kid's
// own (real record identity, so re-imports stay idempotent).
export async function importAssistantEvents(rows) {
  const importable = rows.filter((r) => r.status === 'new' || r.status === 'update');
  const records = importable.map(({ event }) => {
    const { pending, ...rest } = event;
    return {
      ...rest,
      is_archived: rest.is_archived ?? false,
      created_at: rest.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
  });
  if (records.length) await db.events.bulkPut(records);
  return {
    imported: records.length,
    skipped: rows.length - importable.length
  };
}
