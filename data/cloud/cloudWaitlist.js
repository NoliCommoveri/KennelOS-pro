// cloudWaitlist.js — putting her waitlist online (Waitlist W2 Plan §5, §9).
//
// For each own kennel whose list she put online (waitlist_config.online), this
// device builds the allow-listed projection (data/waitlistProjection.js) and
// publishes it whenever it changes; a kennel she takes offline is unpublished.
// The server accepts writes only from the BACKING device (Phase 1 §3.4), so on
// any other device this records "not the backing device" and does nothing else.
//
// Every entry point checks isWaitlistOnlineOffered() (cloud available + the
// release switch) and the session first, so `cloudUrl: null` makes no request.
// Network only through cloudApi. Nothing here ever blocks a page: publishing runs
// in the background and records its own errors in the waitlist-online state.
import * as api from './cloudApi.js';
import { isWaitlistOnlineOffered } from './cloudConfig.js';
import { sessionToken } from './cloudAuth.js';
import {
  getCloudBackupState, getWaitlistOnlineState, updateWaitlistOnlineState, CLOUD_DATA_CHANGED_EVENT
} from '../settings.js';
import { editionFlags } from '../editionConfig.js';
import { kennelRepo } from '../kennelRepo.js';
import { waitlistEntryRepo, newStatusToken } from '../waitlistEntryRepo.js';
import { waitlistOfferRepo } from '../waitlistOfferRepo.js';
import { waitlistProgramRepo } from '../waitlistProgramRepo.js';
import { litterRepo } from '../litterRepo.js';
import { pairingRepo } from '../pairingRepo.js';
import { dogRepo } from '../dogRepo.js';
import { saleRepo } from '../saleRepo.js';
import { contactRepo } from '../contactRepo.js';
import { eventRepo } from '../eventRepo.js';
import { todayYMD } from '../dateUtils.js';
import { waitlistConfig, kennelBreeds, readyCheckLapsed } from '../waitlistRules.js';
import { buildProjection } from '../waitlistProjection.js';
import { formQuestions } from '../waitlistForm.js';
import { generateFormKey, currentFormKey, rotateFormKeys, openSealed } from '../waitlistCrypto.js';
import { applicationToEntry } from '../waitlistInbox.js';
import { planFamilyEvent, activityId } from '../waitlistEvents.js';
import { applyFamilyPlan, addFamilyActivity, removeForNoReadyAnswer, MESSAGE_MAX } from '../waitlistActions.js';
import { queuedEmails, setEmailStatus } from '../waitlistOutbox.js';

export const WAITLIST_ONLINE_EVENT = 'kennelos:waitlistonline';
// After a change, wait this long for more before publishing (one publish per burst).
export const PUBLISH_DELAY_MS = 20 * 1000;
// How often an open app looks for new applications.
export const INBOX_POLL_MS = 5 * 60 * 1000;
const LOCK_NAME = 'kennelos-waitlist-publish';

// Why publishing isn't happening, for the settings card. null = fine.
//   'signed-out' | 'backup-off' | 'not-backing' | 'pro-required' | 'kennel-taken' | 'offline' | 'failed'
function errorCode(err) {
  if (err instanceof api.CloudOfflineError) return 'offline';
  if (err instanceof api.CloudAuthError) return 'signed-out';
  if (err?.code === 'not_backing_device') return 'not-backing';
  if (err?.code === 'pro_required') return 'pro-required';
  if (err?.code === 'kennel_taken') return 'kennel-taken';
  return 'failed';
}

export function isOnline(kennel) {
  return Boolean(kennel && kennel.is_own_kennel && !kennel.is_archived && kennel.public_id && waitlistConfig(kennel).online);
}

async function sha256(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Every family on an online list gets its status-page link token, once (W2 Plan
// §4). Written through the repo like any edit, so it rides backup.
export async function ensureStatusTokens(kennel) {
  let minted = 0;
  for (const e of await waitlistEntryRepo.getByKennel(kennel.id)) {
    if (e.status_token) continue;
    await waitlistEntryRepo.update(e.id, { status_token: newStatusToken() });
    minted++;
  }
  return minted;
}

// "New link": the old link stops working at the next publish (now).
export async function replaceStatusToken(entryId) {
  const entry = await waitlistEntryRepo.update(entryId, { status_token: newStatusToken() });
  await syncWaitlistOnline().catch(() => {});
  return entry;
}

// An online kennel needs a form key (W2 Plan §7): applications and, from step 5,
// families' messages are sealed to it. Made once, on this device, and kept on the
// kennel (a private field). → the kennel as saved.
export async function ensureFormKey(kennel) {
  if (!isOnline(kennel) || currentFormKey(kennel.waitlist_form_keys)) return kennel;
  const keys = [...(kennel.waitlist_form_keys || []), await generateFormKey()];
  return kennelRepo.update(kennel.id, { waitlist_form_keys: keys });
}

// Rotate form key: new applications use a new key; older ones still open with the
// old keys, which are kept. A family midway through the form is asked to reload it.
export async function rotateFormKey(kennelId) {
  const kennel = await kennelRepo.getById(kennelId);
  const saved = await kennelRepo.update(kennelId, { waitlist_form_keys: await rotateFormKeys(kennel.waitlist_form_keys) });
  await syncWaitlistOnline().catch(() => {});
  return saved;
}

// Take in new applications (W2 Plan step 4): each confirmed application in the
// inbox for an own kennel is opened with that kennel's form keys and becomes an
// `applied` entry whose id is the inbox item's id (D5), so taking one in twice
// never makes two families; then the server is told. A device that has never
// done this (new or reset) first asks for everything the server still holds,
// and fills in answers a restore without private backup left out. One that
// can't be opened (a form key this device doesn't have) stays in the inbox.
// → { taken, filled, unopened }
export async function takeInApplications(token, kennels) {
  const byPublicId = new Map(kennels.filter((k) => k.public_id).map((k) => [k.public_id, k]));
  const state = getWaitlistOnlineState();
  const all = !state.inboxFetchedAll;
  const done = [];
  let taken = 0;
  let filled = 0;
  let unopened = 0;
  let messages = 0;
  let after = null;
  let dogs = null;
  do {
    const page = await api.readWaitlistInbox(token, { all, after });
    for (const item of page.items) {
      const kennel = byPublicId.get(item.publicId);
      if (!kennel) continue;
      if (item.kind === 'message') {
        const r = await takeInMessage(item, kennel);
        if (r === 'unopened') unopened++;
        if (r === 'taken') messages++;
        if (r !== 'unopened' && r !== 'waiting' && !item.acked) done.push(item.id);
        continue;
      }
      if (item.kind !== 'application') continue;
      const existing = await waitlistEntryRepo.getById(item.id);
      // Already here with its answers: just tell the server.
      if (existing && Object.keys(existing.application || {}).length > 2) { if (!item.acked) done.push(item.id); continue; }
      let opened;
      try { opened = await openSealed(kennel.waitlist_form_keys, item.blob); } catch { unopened++; continue; }
      dogs ??= await dogRepo.getAll();
      const fresh = applicationToEntry(item, opened, { kennel, form: formQuestions(waitlistConfig(kennel)), breeds: kennelBreeds(kennel, dogs) });
      if (existing) {
        await waitlistEntryRepo.update(existing.id, { application: { ...fresh.application, ...existing.application }, application_questions: existing.application_questions || fresh.application_questions });
        filled++;
      } else {
        await waitlistEntryRepo.create(fresh);
        taken++;
      }
      if (!item.acked) done.push(item.id);
    }
    after = page.next;
  } while (after);
  for (let i = 0; i < done.length; i += 100) await api.ackWaitlistInbox(token, done.slice(i, i + 100));
  updateWaitlistOnlineState({ inboxFetchedAll: true, inboxUnopened: unopened, ...(taken ? { lastTakenInAt: new Date().toISOString() } : {}) });
  return { taken, filled, unopened, messages };
}

// A family's message (W2 step 5), sealed on their status page to this kennel's
// form key: opened here and added to their entry's activity, by the inbox item's
// id, so taking it in twice never shows it twice. → 'taken' | 'had' | 'unopened'
// | 'waiting' (their entry isn't on this device yet; it stays in the inbox).
async function takeInMessage(item, kennel) {
  const entry = item.entryId ? await waitlistEntryRepo.getById(item.entryId) : null;
  if (!entry || entry.kennel_id !== kennel.id) return 'waiting';
  if ((entry.messages || []).some((m) => m.id === item.id)) return 'had';
  let opened;
  try { opened = await openSealed(kennel.waitlist_form_keys, item.blob); } catch { return 'unopened'; }
  const body = typeof opened?.body === 'string' ? opened.body.trim().slice(0, MESSAGE_MAX) : '';
  if (!body) return 'had';
  await addFamilyActivity(entry.id, [{ id: item.id, at: item.createdAt, kind: 'message', body }]);
  return 'taken';
}

// Where a device that never applied events starts: wherever the device before it
// got to, as its published projections say (events_through), so a new backing
// device never applies an action twice.
async function startingCursor(token, kennels) {
  let cursor = 0;
  for (const k of kennels.filter((x) => x.public_id)) {
    try {
      const res = await api.readWaitlistProjection(token, k.public_id);
      cursor = Math.max(cursor, Number(res.projection?.events_through) || 0);
    } catch (err) {
      if (err?.code !== 'not_found') throw err;
    }
  }
  return cursor;
}

// The records one family event touches, for waitlistEvents.planFamilyEvent.
async function eventContext(event, kennel, cache) {
  const entry = await waitlistEntryRepo.getById(event.entryId);
  if (!entry || entry.kennel_id !== kennel.id) return { entry: null };
  cache.dogs ??= new Map((await dogRepo.getAll({ includeArchived: true })).map((d) => [d.id, d]));
  cache.litters ??= new Map((await litterRepo.getAll({ includeArchived: true })).map((l) => [l.id, l]));
  const offers = await waitlistOfferRepo.getByEntry(entry.id);
  const litterIds = new Set(offers.map((o) => o.litter_id));
  const pups = [...cache.dogs.values()].filter((d) => litterIds.has(d.litter_id));
  const name = (id) => cache.dogs.get(id)?.call_name || 'a pup';
  const litterLabel = (id) => {
    const l = cache.litters.get(id);
    if (!l) return 'the litter';
    return l.nickname || `${cache.dogs.get(l.dam_id)?.call_name || 'Unknown'} × ${cache.dogs.get(l.sire_id)?.call_name || 'Unknown'}`;
  };
  // A server move (W2 step 7) checks the whole kennel: one turn at a time, and the
  // pups of any litter it offered.
  let kennelOffers = offers;
  let movePups = pups;
  if (event.madeBy === 'server') {
    kennelOffers = await waitlistOfferRepo.getByKennel(kennel.id);
    const moveLitters = new Set((event.payload?.rows || []).map((r) => r.litter_id));
    movePups = [...cache.dogs.values()].filter((d) => litterIds.has(d.litter_id) || moveLitters.has(d.litter_id));
  }
  return {
    entry, offers, kennelOffers, pups: movePups, litters: cache.litters, sales: await saleRepo.getAll({ includeArchived: true }), pupName: name, litterLabel,
    timeZone: kennel.time_zone || null, config: waitlistConfig(kennel)
  };
}

// What families did on their status pages (W2 step 5): each event after this
// device's cursor is planned (waitlistEvents.js) and carried out
// (waitlistActions.applyFamilyPlan), and the cursor moves past it. Only the
// BACKING device applies events, so two devices never make two Sales for one
// pick: this checks before it writes anything. The next publish carries the
// cursor as `events_through`, which lets the server drop the holds it kept for
// picks applied here. → { applied, noted, skipped }
export async function applyFamilyEvents(token, kennels) {
  const online = kennels.filter(isOnline);
  const byPublicId = new Map(kennels.filter((k) => k.public_id).map((k) => [k.public_id, k]));
  let cursor = getWaitlistOnlineState().eventsCursor;
  if (!Number.isInteger(cursor)) {
    cursor = await startingCursor(token, online);
    updateWaitlistOnlineState({ eventsCursor: cursor });
  }
  const counts = { applied: 0, noted: 0, skipped: 0 };
  const cache = {};
  let backingChecked = false;
  for (;;) {
    const page = await api.readWaitlistEvents(token, cursor);
    if (!page.events.length) break;
    if (!backingChecked) {
      const program = await api.getProgram(token);
      if (!program.backingDevice || program.backingDevice.id !== program.thisDeviceId) {
        throw Object.assign(new Error('Only the backing device applies family actions.'), { code: 'not_backing_device' });
      }
      backingChecked = true;
    }
    // Where the server already moved the turn on after an event (a family's pass or
    // leave, or its own deadline close), her device doesn't move it on again.
    const movedOnAfter = new Set(page.events.filter((e) => e.madeBy === 'server' && e.kind === 'server_offer')
      .map((e) => e.payload?.cause_seq).filter(Number.isInteger));
    for (const event of page.events) {
      const kennel = byPublicId.get(event.publicId);
      if (kennel) {
        const plan = planFamilyEvent(event, await eventContext(event, kennel, cache));
        if (movedOnAfter.has(event.seq)) plan.moveOn = false;
        if (plan.op === 'skip') counts.skipped++;
        else {
          try {
            await applyFamilyPlan(event.entryId, plan);
            if (plan.op === 'note') counts.noted++; else counts.applied++;
          } catch (err) {
            // A write her records refuse must not stop every later event (and the
            // publish after them): it becomes a line for her, and the cursor moves on.
            await addFamilyActivity(event.entryId, [{
              id: activityId(event), at: event.createdAt,
              body: `Something they did on their status page (${event.kind.replace(/_/g, ' ')}) couldn't be recorded: ${err.message}`
            }]).catch(() => {});
            counts.noted++;
          }
          cache.dogs = null; // a pick or a withdrawal can change pups and sales
          cache.litters = null;
        }
      } else {
        counts.skipped++;
      }
      cursor = event.seq;
      updateWaitlistOnlineState({ eventsCursor: cursor });
    }
    if (!page.more) break;
  }
  if (counts.applied || counts.noted) updateWaitlistOnlineState({ lastEventAt: new Date().toISOString() });
  return counts;
}

// "Ready now?" unanswered past her window (Spec §16.7, remove_after): her device
// removes them, the BACKING device only (checked before the first removal), like
// every other move made for her online. A kennel online from before the ready check
// existed gets today as its online_since, so only holds ending from now are asked.
// → [entryId removed]
export async function sweepReadyChecks(token, kennels, { today = todayYMD() } = {}) {
  const removed = [];
  let backing = null;
  for (const k of kennels.filter(isOnline)) {
    const config = waitlistConfig(k);
    if (!config.online_since) {
      await kennelRepo.update(k.id, { waitlist_config: { ...(k.waitlist_config || {}), online_since: today } });
      continue;
    }
    for (const e of (await waitlistEntryRepo.getByKennel(k.id)).filter((x) => readyCheckLapsed(x, today, config))) {
      if (backing === null) {
        const program = await api.getProgram(token);
        backing = Boolean(program.backingDevice && program.backingDevice.id === program.thisDeviceId);
      }
      if (!backing) return removed;
      await removeForNoReadyAnswer(e.id, { date: today });
      removed.push(e.id);
    }
  }
  return removed;
}

// Send the emails she queued (W2 step 6) for these online kennels, oldest first.
// Runs right after publishing, so each family's status page already shows what
// their email is about. Offline or rate-limited: they stay queued for the next
// sync. A refusal about one email (that family isn't published, has no address)
// marks it failed with the reason; she can retry it. → { sent, failed }
export async function sendQueuedEmails(token, kennels) {
  const counts = { sent: 0, failed: 0 };
  for (const kennel of kennels.filter(isOnline)) {
    for (const { entry, message } of queuedEmails(await waitlistEntryRepo.getByKennel(kennel.id))) {
      let res;
      try {
        res = await api.sendWaitlistEmail(token, {
          id: message.id, publicId: kennel.public_id, entryId: entry.id, kind: message.email_kind, subject: message.subject, body: message.body
        });
      } catch (err) {
        // About this one email: it fails, with the reason, and the rest go on.
        const aboutThis = (err instanceof api.CloudConflictError && ['not_published', 'no_email'].includes(err.code))
          || (err instanceof api.CloudRequestError && err.status === 400);
        if (aboutThis) {
          await setEmailStatus(entry.id, message.id, { status: 'failed', error: err.code || 'bad_message' });
          counts.failed++;
          continue;
        }
        // Email down on the server, or too many this hour: everything waits for the next sync.
        if (err instanceof api.CloudRequestError && (err.status === 503 || err.status === 429)) return counts;
        throw err; // offline, signed out, not the backing device: the sync reports it
      }
      await setEmailStatus(entry.id, message.id, res.status === 'sent'
        ? { status: 'sent', sent_at: res.sentAt || new Date().toISOString(), error: null }
        : { status: 'failed', error: 'failed' });
      if (res.status === 'sent') counts.sent++; else counts.failed++;
    }
  }
  return counts;
}

// The projection for one kennel, from the database.
export async function projectionFor(kennel, { today = todayYMD() } = {}) {
  const [entries, offers, programsById, litters, pairings, dogs, sales, contacts, events] = await Promise.all([
    waitlistEntryRepo.getByKennel(kennel.id),
    waitlistOfferRepo.getByKennel(kennel.id),
    waitlistProgramRepo.getMapForKennel(kennel.id),
    litterRepo.getAll(),
    pairingRepo.getAll(),
    dogRepo.getAll({ includeArchived: true }),
    saleRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true }),
    // Parents' earned titles, for the pairings and early litters she shows (§16.4).
    eventRepo.getByType('title_earned')
  ]);
  return buildProjection({
    kennel, entries, offers, programsById, litters, pairings, dogs, sales, contacts, events, today,
    formKey: currentFormKey(kennel.waitlist_form_keys), eventsThrough: getWaitlistOnlineState().eventsCursor || 0
  });
}

let chain = Promise.resolve();
function exclusive(fn) {
  const locks = globalThis.navigator?.locks;
  const run = () => (locks ? locks.request(LOCK_NAME, fn) : fn());
  const next = chain.then(run, run);
  chain = next.catch(() => {});
  return next;
}

// Publish every online kennel whose projection changed, unpublish every kennel
// taken offline, then send the emails she queued. `force` republishes unchanged ones too. → { status:
// 'skipped' | 'ok' | 'error', reason?, published: [kennelId], unpublished: [kennelId] }
export function syncWaitlistOnline({ force = false } = {}) {
  return exclusive(async () => {
    const result = await syncNow({ force });
    if (result.status !== 'skipped' || result.reason !== 'unavailable') {
      try { globalThis.dispatchEvent?.(new CustomEvent(WAITLIST_ONLINE_EVENT, { detail: result })); } catch { /* no window */ }
    }
    return result;
  });
}

async function syncNow({ force }) {
  if (!isWaitlistOnlineOffered() || !editionFlags.waitlist) return { status: 'skipped', reason: 'unavailable' };
  const kennels = (await kennelRepo.getAll({ includeArchived: true })).filter((k) => k.is_own_kennel);
  const state = getWaitlistOnlineState();
  const wanted = kennels.filter(isOnline);
  const stale = Object.entries(state.kennels).filter(([id, s]) => {
    const k = kennels.find((x) => x.id === id);
    return !k || !isOnline(k) || k.public_id !== s.publicId;
  });
  if (!wanted.length && !stale.length) {
    if (state.lastError) updateWaitlistOnlineState({ lastError: null });
    return { status: 'skipped', reason: 'nothing-online' };
  }

  const token = sessionToken();
  const stop = (reason) => {
    updateWaitlistOnlineState({ lastError: { code: reason, at: new Date().toISOString() } });
    return { status: 'skipped', reason };
  };
  if (!token) return stop('signed-out');
  if (!getCloudBackupState().enabled) return stop('backup-off');

  const published = [];
  const unpublished = [];
  let inbox = null;
  let events = null;
  let emails = null;
  updateWaitlistOnlineState({ lastAttemptAt: new Date().toISOString() });
  try {
    // New applications and messages first, then what families did on their
    // pages, so the projection that follows includes all of it.
    if (wanted.length) inbox = await takeInApplications(token, wanted);
    if (wanted.length) events = await applyFamilyEvents(token, kennels);
    if (wanted.length) await sweepReadyChecks(token, kennels);
    for (const [kennelId, s] of stale) {
      await api.unpublishWaitlist(token, s.publicId);
      const kennelsState = { ...getWaitlistOnlineState().kennels };
      delete kennelsState[kennelId];
      updateWaitlistOnlineState({ kennels: kennelsState });
      unpublished.push(kennelId);
    }
    for (const listed of wanted) {
      const kennel = await ensureFormKey(listed);
      await ensureStatusTokens(kennel);
      let projection = await projectionFor(kennel);
      let hash = await sha256(JSON.stringify(projection));
      const prev = getWaitlistOnlineState().kennels[kennel.id];
      if (!force && prev && prev.hash === hash && prev.publicId === kennel.public_id) continue;
      let res;
      try {
        res = await api.publishWaitlist(token, kennel.public_id, projection);
      } catch (err) {
        // The server moved on while this device was away (W2 step 7): apply its
        // moves first, then publish what that makes.
        if (err?.code !== 'events_pending') throw err;
        events = await applyFamilyEvents(token, kennels);
        projection = await projectionFor(kennel);
        hash = await sha256(JSON.stringify(projection));
        res = await api.publishWaitlist(token, kennel.public_id, projection);
      }
      updateWaitlistOnlineState({
        kennels: { ...getWaitlistOnlineState().kennels, [kennel.id]: { publicId: kennel.public_id, hash, version: res.version, publishedAt: res.publishedAt } }
      });
      published.push(kennel.id);
    }
    if (wanted.length) emails = await sendQueuedEmails(token, wanted);
  } catch (err) {
    const code = errorCode(err);
    updateWaitlistOnlineState({ lastError: { code, at: new Date().toISOString() } });
    return { status: 'error', reason: code, published, unpublished, inbox, events, emails };
  }
  updateWaitlistOnlineState({ lastError: null });
  return { status: 'ok', published, unpublished, inbox, events, emails };
}

// What the settings card shows for one kennel.
export function waitlistOnlineStatus(kennel) {
  const state = getWaitlistOnlineState();
  return {
    offered: isWaitlistOnlineOffered() && editionFlags.waitlist,
    online: isOnline(kennel),
    published: state.kennels[kennel.id] || null,
    lastError: state.lastError,
    signedIn: Boolean(sessionToken()),
    formOpen: isOnline(kennel) && waitlistConfig(kennel).online_form,
    inboxUnopened: state.inboxUnopened || 0,
    backupOn: getCloudBackupState().enabled
  };
}

// Started once per page (cloudBackupUI.bootCloud). Publishes shortly after
// load (catching changes made while signed out or offline: the hash decides),
// then PUBLISH_DELAY_MS after the last data change, and when back online; and
// takes in new applications every INBOX_POLL_MS while the app is in front.
export function startWaitlistScheduler({ win = globalThis } = {}) {
  if (!isWaitlistOnlineOffered() || !editionFlags.waitlist) return () => {};
  let timer = null;
  const run = () => { timer = null; syncWaitlistOnline().catch(() => {}); };
  const schedule = (delay = PUBLISH_DELAY_MS) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, delay);
  };
  const onChange = () => schedule();
  const onOnline = () => schedule(1000);
  // New applications arrive on the server, not from a change here: look every few
  // minutes while the app is open and in front, and when she comes back to it.
  const visible = () => win.document?.visibilityState !== 'hidden';
  const poll = win.setInterval?.(() => { if (visible() && !timer) run(); }, INBOX_POLL_MS);
  const onVisible = () => { if (visible()) schedule(1000); };
  win.addEventListener?.(CLOUD_DATA_CHANGED_EVENT, onChange);
  win.addEventListener?.('online', onOnline);
  win.document?.addEventListener?.('visibilitychange', onVisible);
  schedule(2000);
  return () => {
    if (timer) clearTimeout(timer);
    if (poll) win.clearInterval?.(poll);
    win.removeEventListener?.(CLOUD_DATA_CHANGED_EVENT, onChange);
    win.removeEventListener?.('online', onOnline);
    win.document?.removeEventListener?.('visibilitychange', onVisible);
  };
}
