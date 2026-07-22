// assistantStore.js — the KennelAssistant page's entire data layer. The
// assistant is a deliberately separate, tiny database ('KennelOSAssistant',
// never the main 'KennelOSBreedingApp' db): on the kid's phone it holds ONLY
// what the assistant feed carries — basic dog fields plus dog-subject events —
// so nothing sensitive ever exists on that device to be found. Opening the main
// app on the same phone just shows the main app's own (empty) database.
//
// Local writes are ONLY new events, marked `pending: 1` until the owner's app
// has round-tripped them: the kid pushes them in the outbox, the owner imports
// and later pushes a fresh feed that carries those same ids back, and the feed
// sync below overwrites the pending copy (clearing the flag) — that overwrite
// IS the acknowledgment. Until then the events keep riding every outbox push,
// which is harmless because the owner's import is an upsert by id.
import Dexie from '../vendor/dexie.min.mjs';
import { EVENT_TYPES, descriptor } from './vocab.js';
import { setAssistantLastSync } from './settings.js';

export const assistantDb = new Dexie('KennelOSAssistant');

// Mirrors the main schema's conventions (UUID ids, [subject_type+subject_id]
// timeline probe); `pending` is filtered in JS like is_archived, not indexed.
assistantDb.version(1).stores({
  dogs: 'id',
  events: 'id, [subject_type+subject_id], event_date'
});

export const ASSISTANT_OUTBOX_FORMAT_VERSION = 1;

// Replace the synced slice with a fresh feed, keeping unacknowledged local
// events. Feed rows that share an id with a pending local event overwrite it —
// the acknowledgment described above.
export async function syncFromFeed(feed) {
  if (!feed || !Array.isArray(feed.dogs) || !Array.isArray(feed.events)) {
    throw new Error('The dog feed in Dropbox has an unexpected shape.');
  }
  await assistantDb.transaction('rw', assistantDb.dogs, assistantDb.events, async () => {
    const stale = (await assistantDb.events.toArray())
      .filter((e) => !e.pending)
      .map((e) => e.id);
    await assistantDb.events.bulkDelete(stale);
    await assistantDb.dogs.clear();
    if (feed.dogs.length) await assistantDb.dogs.bulkPut(feed.dogs);
    if (feed.events.length) await assistantDb.events.bulkPut(feed.events);
  });
  setAssistantLastSync();
  return { dogs: feed.dogs.length, events: feed.events.length };
}

export async function getDogs({ includeArchived = false } = {}) {
  const all = await assistantDb.dogs.toArray();
  const visible = includeArchived ? all : all.filter((d) => !d.is_archived);
  return visible.sort((a, b) =>
    String(a.call_name || '').localeCompare(String(b.call_name || ''), undefined, { sensitivity: 'base' }));
}

export function getDog(id) {
  return assistantDb.dogs.get(id);
}

// One dog's timeline, newest first — same ordering rule as the main app's
// eventRepo.getForSubject (event_date desc, created_at desc tiebreak).
export async function getTimeline(dogId) {
  const rows = await assistantDb.events
    .where('[subject_type+subject_id]')
    .equals(['dog', dogId])
    .toArray();
  return rows
    .filter((r) => !r.is_archived)
    .sort((a, b) => {
      if (a.event_date !== b.event_date) return a.event_date < b.event_date ? 1 : -1;
      return (a.created_at ?? '') < (b.created_at ?? '') ? 1 : -1;
    });
}

// Log a new event. Same required-field rule as the main app's eventRepo, minus
// the subject types the assistant can't see (everything here is a dog).
export async function createPendingEvent(data) {
  for (const f of ['subject_id', 'event_type', 'event_date', 'title']) {
    if (data[f] == null || data[f] === '') throw new Error(`"${f}" is required.`);
  }
  const now = new Date().toISOString();
  const record = {
    ...data,
    id: crypto.randomUUID(),
    subject_type: 'dog',
    pending: 1,
    is_archived: false,
    created_at: now,
    updated_at: now
  };
  await assistantDb.events.add(record);
  return record;
}

// Pending (unacknowledged) local events, oldest first, with the dog name
// resolved for display.
export async function getPendingEvents() {
  const rows = (await assistantDb.events.toArray()).filter((e) => e.pending);
  rows.sort((a, b) => ((a.created_at ?? '') < (b.created_at ?? '') ? -1 : 1));
  const out = [];
  for (const event of rows) {
    const dog = await assistantDb.dogs.get(event.subject_id);
    out.push({
      event,
      dogName: dog ? (dog.call_name || dog.registered_name || '(unnamed dog)') : '(unknown dog)',
      typeLabel: descriptor(EVENT_TYPES, event.event_type).label
    });
  }
  return out;
}

// Remove a not-yet-sent mistake. Only pending events may be deleted — synced
// history belongs to the owner's records, not this device.
export async function deletePendingEvent(id) {
  const event = await assistantDb.events.get(id);
  if (!event || !event.pending) throw new Error('Only unsent events can be deleted here.');
  await assistantDb.events.delete(id);
}

// --- Weight-drop lookup ------------------------------------------------------
// Mirrors assets/eventForm.js's soft warning: a weigh-in below the dog's
// previous weight is worth a second look, never a hard block. Same semantics —
// total ounces (lbs×16 + oz), and a total order over weigh-ins of date, then
// AM-before-PM (blank between), then capture time, so a PM entry compares
// against that morning's AM and an AM against the prior day.

export function weightTotalOz(details) {
  if (!details) return null;
  const lbs = details.weight_lbs;
  const oz = details.weight_oz;
  const hasLbs = lbs !== '' && lbs != null && Number.isFinite(Number(lbs));
  const hasOz = oz !== '' && oz != null && Number.isFinite(Number(oz));
  if (!hasLbs && !hasOz) return null;
  return (hasLbs ? Number(lbs) : 0) * 16 + (hasOz ? Number(oz) : 0);
}

export function fmtWeight(details) {
  const lbs = (details?.weight_lbs ?? '') !== '' ? Number(details.weight_lbs) : 0;
  const oz = (details?.weight_oz ?? '') !== '' ? Number(details.weight_oz) : 0;
  const t = String(details?.time_of_day || '').toUpperCase();
  return `${lbs} lb ${oz} oz${t ? ` ${t}` : ''}`;
}

function timeRank(details) {
  const t = String(details?.time_of_day || '').toUpperCase();
  return t === 'PM' ? 1 : (t === 'AM' ? 0 : 0.5);
}

export function weighKey(ev) {
  return { date: ev.event_date || '', rank: timeRank(ev.details), created: ev.created_at || '' };
}

function keyCmp(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.created !== b.created) return a.created < b.created ? -1 : 1;
  return 0;
}

// The dog's weigh-in (with a real weight) immediately preceding `newKey`,
// across BOTH synced history and still-pending local entries — a second pup
// weighed this morning must compare against this morning, not last week.
export async function getPriorWeighIn(dogId, newKey) {
  const evs = await getTimeline(dogId);
  let best = null;
  let bestKey = null;
  for (const e of evs) {
    if (e.event_type !== 'weight_check') continue;
    if (weightTotalOz(e.details) == null) continue;
    const k = weighKey(e);
    if (keyCmp(k, newKey) >= 0) continue;
    if (!bestKey || keyCmp(k, bestKey) > 0) { best = e; bestKey = k; }
  }
  return best;
}

// The outbox object to upload: every still-pending event, `pending` marker
// stripped (it's this device's bookkeeping, not part of the record).
export async function buildOutbox() {
  const pending = (await assistantDb.events.toArray()).filter((e) => e.pending);
  return {
    format_version: ASSISTANT_OUTBOX_FORMAT_VERSION,
    generated_at: new Date().toISOString(),
    events: pending.map(({ pending: _p, ...rest }) => rest)
  };
}
