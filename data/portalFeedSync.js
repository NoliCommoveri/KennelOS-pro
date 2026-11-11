// portalFeedSync.js — her puppy portal's family feed, sent on its own (KennelPort's
// docs/Puppy_Parent_Portal_Plan.md section 3.4; End-State guide §35.1): the steps
// between her records, portalFeed.js (what goes) and kennelportApi.js (the wire).
//
// - Only for a kennel linked to a KennelPort website on this device whose facts say
//   `portal_feed: 1` (the portal is on there). Nothing changes for anyone else.
// - Sent by itself: shortly after KennelOS opens (always, after asking the site for
//   its facts), and FEED_DELAY_MS after a change to her records when the feed
//   would differ from what this device sent last. Website pages still wait for
//   Update website.
// - Never while a Pro license has lapsed.
// - The answer: the portal's address and the one-tap link's key, kept on the
//   kennel (Kennel.kennelport_portal, cloud, so whichever device publishes her
//   waitlist puts Open your puppy portal on the status page), and the few facts
//   she recorded in the portal, applied here without asking her (she made them):
//   the real pickup time on the pup's pickup event and the sale Delivered; the
//   microchip; a death after pickup. Each fact is applied once (kept in
//   `kennelport_portal.facts`), so a later change in KennelOS isn't undone by the
//   portal's older value. Money never comes back this way. Checked first (K7-2):
//   only for a placement the feed carries, on a sale the fact fits, with dates in
//   bounds; each applied fact leaves a Note on the pup (`details.portal_fact`), which
//   Today shows her once (nudges.portalFactNudges).
// - Sent by one device (K7-14): with her cloud program on, the device doing its
//   server work (serverWork.js); a device without a cloud session sends as before.
import { dogRepo } from './dogRepo.js';
import { litterRepo } from './litterRepo.js';
import { eventRepo } from './eventRepo.js';
import { kennelRepo } from './kennelRepo.js';
import { contactRepo } from './contactRepo.js';
import { saleRepo } from './saleRepo.js';
import { contractRepo } from './contractRepo.js';
import { waitlistEntryRepo } from './waitlistEntryRepo.js';
import { todayYMD } from './dateUtils.js';
import { CLOUD_DATA_CHANGED_EVENT } from './settings.js';
import { RELEASED_SALE_STATUSES } from './vocab.js';
import { pickupEvent } from './goHome.js';
import { statusPageLink } from './cloud/cloudConfig.js';
import { buildPortalFeed, feedCopy, pickupEventFor, zonedParts, clockText } from './portalFeed.js';
import { sendFamilyFeed, linkStatus, websiteLinkOffered, KennelportError } from './kennelportApi.js';
import { getWebsiteLink, notePortalSent, noteWebsiteAnswer, clearWebsiteLink } from './kennelportLinkStore.js';
import { licenseOk, turnPortalOff } from './kennelportLink.js';
import { isCloudAvailable } from './cloud/cloudConfig.js';
import { addDaysToYMD } from './dateUtils.js';

// After a change, wait this long for more before sending (a save often writes
// several records).
export const FEED_DELAY_MS = 20 * 1000;
export const FEED_START_DELAY_MS = 4 * 1000;
// KennelOS is many pages: "whenever it opens" means a page load at most this
// often. Then the site is asked for its facts (the portal switched on or off there)
// and the feed is sent even unchanged, so her Site Manager's Last from KennelOS
// stays fresh and the facts she recorded come back.
export const FEED_OPEN_EVERY_MS = 60 * 60 * 1000;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function records(kennel) {
  const [sales, contracts, dogs, contacts, entries, litters, events] = await Promise.all([
    saleRepo.getAll({ includeArchived: true }),
    contractRepo.getAll({ includeArchived: true }),
    dogRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true }),
    waitlistEntryRepo.getByKennel(kennel.id),
    litterRepo.getAll(),
    // Pickups, training stays (a family's go-home is after them), shots, deworming
    // and vet visits (and surgeries, which name her vet).
    Promise.all(['placement', 'boarding', 'vaccination', 'preventative', 'vet_visit', 'surgery'].map((t) => eventRepo.getByType(t))).then((l) => l.flat())
  ]);
  return { sales, contracts, dogs, contacts, entries, litters, events };
}

// The portal as the kennel keeps it, from an answer's `portal`: its address and
// the one-tap link's key and minutes. → the new value, or null when unusable.
export function portalFromAnswer(prev, portal) {
  if (!portal || typeof portal !== 'object') return prev || null;
  const https = (u) => (typeof u === 'string' && /^https:\/\/[^\s"'<>]{3,500}$/i.test(u) ? u : null);
  const key = typeof portal.handoff_key === 'string' && /^[0-9a-f]{64}$/.test(portal.handoff_key) ? portal.handoff_key : null;
  if (!https(portal.handoff_url) || !key) return prev || null;
  return {
    url: https(portal.url),
    handoff_url: https(portal.handoff_url),
    handoff_key: key,
    handoff_minutes: Number.isFinite(Number(portal.handoff_minutes)) && Number(portal.handoff_minutes) > 0 ? Math.min(60, Number(portal.handoff_minutes)) : 10,
    home: Array.isArray(prev?.home) ? prev.home : [],
    facts: prev?.facts && typeof prev.facts === 'object' ? prev.facts : {}
  };
}

// A fact's Note on the pup (K7-2): what came from the portal, when, for which sale.
const FACT_TEXT = {
  picked_up: (v) => `Your puppy portal says they picked up on ${v}.`,
  microchip: (v) => `Your puppy portal set the microchip to ${v}.`,
  died: (v) => `Your puppy portal recorded a death on ${v}.`
};
async function noteFact(pup, sale, what, value, today) {
  await eventRepo.create({
    subject_type: 'dog', subject_id: pup.id, event_type: 'note', event_date: today,
    title: 'From your puppy portal', notes: FACT_TEXT[what](value),
    related_contact_id: sale.buyer_contact_id || null,
    details: { portal_fact: what, sale_id: sale.id }
  });
}

// Apply the facts she recorded in the portal (plan 3.4, "A few facts go back").
// Only a fact about a placement in `known` (what the feed carries), on a sale it
// fits (K7-2): picked up and the microchip on a sale not ended; picked up no earlier
// than the sale (or the pup's birth) and no later than tomorrow; a death on a pup that
// has gone home or is going, on or before today and not before its birth; handed
// over only for the sale's own buyer. → { portal (the kennel's value with `facts`
// and `home` brought up to date), applied: [{ sale_id, what }], refused: [{ sale_id,
// what, why }] }.
export async function applyPortalFacts(kennel, portal, facts = [], { known = null, today = todayYMD() } = {}) {
  const out = { ...portal, facts: { ...(portal?.facts || {}) }, home: [...(portal?.home || [])] };
  const applied = [];
  const refused = [];
  const tz = kennel.time_zone || null;
  const sent = known ? new Set(known.filter((k) => k.type === 'placement').map((k) => String(k.id))) : null;
  for (const f of Array.isArray(facts) ? facts : []) {
    if (!f || typeof f.id !== 'string') continue;
    const sale = await saleRepo.getById(f.id);
    if (!sale || sale.kennel_id !== kennel.id) continue;
    if (sent && !sent.has(sale.id)) { refused.push({ sale_id: sale.id, what: 'any', why: 'not_sent' }); continue; }
    const pup = sale.dog_id ? await dogRepo.getById(sale.dog_id) : null;
    const ended = RELEASED_SALE_STATUSES.includes(sale.status);
    const born = pup?.date_of_birth || null;
    const prev = out.facts[sale.id] || {};
    const next = { ...prev };
    // Handed over: their status page shows only Your puppy portal.
    if (f.portal_only === true && typeof f.family_id === 'string' && !out.home.includes(f.family_id)) {
      if (f.family_id === sale.buyer_contact_id && !ended) out.home.push(f.family_id);
      else refused.push({ sale_id: sale.id, what: 'portal_only', why: 'not_theirs' });
    }

    // Picked up, and when: the pup's pickup event gets the real time, and the sale
    // is Delivered, so KennelOS's own go-home nudges stop.
    const at = typeof f.picked_up_at === 'string' && !Number.isNaN(Date.parse(f.picked_up_at)) ? new Date(f.picked_up_at).toISOString() : null;
    const atDay = at ? zonedParts(at, tz)?.date : null;
    const atFits = atDay && !ended && atDay <= addDaysToYMD(today, 1) && (!sale.sale_date || atDay >= sale.sale_date) && (!born || atDay >= born);
    if (at && at !== prev.picked_up_at && pup && !atFits) refused.push({ sale_id: sale.id, what: 'picked_up', why: ended ? 'sale_ended' : 'date' });
    if (at && at !== prev.picked_up_at && pup && atFits) {
      const when = zonedParts(at, tz);
      const events = await eventRepo.getForSubject('dog', pup.id);
      const ev = pickupEventFor(sale, events, when.date);
      const time = clockText(when.time);
      if (ev) {
        if (ev.event_date !== when.date || ev.details?.placement_time !== time) {
          await eventRepo.update(ev.id, { event_date: when.date, details: { ...(ev.details || {}), placement_time: time } });
        }
      } else {
        await eventRepo.create(pickupEvent(pup, sale, when.date, time));
      }
      if (sale.status !== 'delivered' && !RELEASED_SALE_STATUSES.includes(sale.status)) await saleRepo.update(sale.id, { status: 'delivered' });
      next.picked_up_at = at;
      await noteFact(pup, sale, 'picked_up', `${when.date} at ${time}`, today);
      applied.push({ sale_id: sale.id, what: 'picked_up' });
    }
    // The microchip she entered or corrected in the portal.
    const chip = typeof f.microchip === 'string' ? f.microchip.trim().slice(0, 40) : '';
    if (chip && chip !== prev.microchip && pup && ended) refused.push({ sale_id: sale.id, what: 'microchip', why: 'sale_ended' });
    if (chip && chip !== prev.microchip && pup && !ended) {
      if (String(pup.microchip_id ?? '').trim() !== chip) await dogRepo.update(pup.id, { microchip_id: chip });
      next.microchip = chip;
      await noteFact(pup, sale, 'microchip', chip, today);
      applied.push({ sale_id: sale.id, what: 'microchip' });
    }
    // A death after pickup she recorded: the dog is marked deceased, with its date.
    // Only for a pup this family has (a sale not ended), on a real past day.
    const died = typeof f.died_on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f.died_on) ? f.died_on : null;
    const diedFits = died && !ended && died <= today && (!born || died >= born);
    if (died && died !== prev.died_on && pup && !diedFits) refused.push({ sale_id: sale.id, what: 'died', why: ended ? 'sale_ended' : 'date' });
    if (died && died !== prev.died_on && pup && diedFits) {
      if (pup.status !== 'deceased' || pup.date_of_death !== died) await dogRepo.update(pup.id, { status: 'deceased', date_of_death: died });
      next.died_on = died;
      await noteFact(pup, sale, 'died', died, today);
      applied.push({ sale_id: sale.id, what: 'died' });
    }
    if (!same(next, prev)) out.facts[sale.id] = next;
  }
  return { portal: out, applied, refused };
}

// Forget the portal on the kennel (the site switched it off, or is no longer
// linked): the status page stops offering it, Companion and Furever come back.
const dropPortal = (kennel) => turnPortalOff(kennel.id);

// May this device send the feed (K7-14)? Without a cloud session: yes (it's the
// only one that could). With one: only the device doing the program's server work;
// another device's claim, or this one in the background, says no. A cloud that
// can't be reached doesn't stop it.
export async function mayFeedHere() {
  if (!isCloudAvailable()) return true;
  const [{ sessionToken }, { claimServerWork, inBackground }] = await Promise.all([import('./cloud/cloudAuth.js'), import('./cloud/serverWork.js')]);
  const token = sessionToken();
  if (!token) return true;
  if (inBackground()) return false;
  try {
    await claimServerWork(token);
    return true;
  } catch (err) {
    return err?.name !== 'ServerWorkError';
  }
}

// Send this kennel's family feed when it changed (or `force`). → { status:
// 'sent' | 'skipped' | 'error', reason?, summary?, applied? }.
// `opening`: a page load; force and refresh then when the last check is over
// FEED_OPEN_EVERY_MS old.
export async function sendPortalFeed(kennel, { force = false, refresh = false, opening = false, today = todayYMD(), feedId = crypto.randomUUID(), mayFeed = mayFeedHere } = {}) {
  if (!websiteLinkOffered() || !kennel?.id) return { status: 'skipped', reason: 'unavailable' };
  const link = await getWebsiteLink(kennel.id);
  if (!link) return { status: 'skipped', reason: 'not_linked' };
  if (!(await mayFeed())) return { status: 'skipped', reason: 'other_device' };
  if (opening && !(Date.parse(link.portal_checked_at || '') > Date.now() - FEED_OPEN_EVERY_MS)) {
    force = true;
    refresh = true;
  }
  const forget = async (err) => {
    if (err instanceof KennelportError && err.kind === 'not_linked') {
      await clearWebsiteLink(kennel.id);
      await dropPortal(kennel);
    }
    throw err;
  };
  let site = link.site;
  try {
    if (refresh) {
      site = (await linkStatus(link.token).catch(forget)).site || site;
      await notePortalSent(kennel.id, { site, checked: true });
    }
    if (site?.portal_feed !== 1) {
      // Only on the site's own word just now: a device whose facts are old (its
      // link from before the portal was on) mustn't take the portal off the kennel
      // another device keeps.
      if (refresh) await dropPortal(kennel);
      return { status: 'skipped', reason: 'portal_off' };
    }
    if (!(await licenseOk())) return { status: 'skipped', reason: 'license' };
    const r = await records(kennel);
    const { feed, known } = buildPortalFeed({
      kennel, ...r, today, feedId, sentAt: new Date().toISOString(), statusUrlOf: statusPageLink, known: link.portal_known || []
    });
    const copy = feedCopy(feed);
    if (!force && link.portal_sent && same(copy, link.portal_sent)) return { status: 'skipped', reason: 'unchanged' };
    let answer;
    try {
      answer = await sendFamilyFeed(link.token, feed);
    } catch (err) {
      // Switched off in KennelPort since the facts were read: stop until it's on again.
      if (err instanceof KennelportError && err.code === 'portal_off') {
        await noteWebsiteAnswer(kennel.id, { site: { ...site, portal_feed: null } });
        await dropPortal(kennel);
        return { status: 'skipped', reason: 'portal_off' };
      }
      return await forget(err);
    }
    await notePortalSent(kennel.id, { sent: copy, known });
    const fresh = (await kennelRepo.getById(kennel.id)) || kennel;
    const base = portalFromAnswer(fresh.kennelport_portal, answer?.portal);
    let applied = [];
    if (base) {
      // What the feed carries now and carried before: a fact about anything else is refused.
      const done = await applyPortalFacts(fresh, base, answer?.facts, { known: [...(link.portal_known || []), ...known], today });
      applied = done.applied;
      if (!same(done.portal, fresh.kennelport_portal)) await kennelRepo.update(kennel.id, { kennelport_portal: done.portal });
    }
    return { status: 'sent', summary: answer?.summary || {}, applied };
  } catch (err) {
    return { status: 'error', reason: err?.kind || 'other', message: err?.message || String(err) };
  }
}

// Every own kennel linked on this device, one after the other.
let chain = Promise.resolve();
export function syncPortalFeeds(opts = {}) {
  const run = async () => {
    const kennels = (await kennelRepo.getAll({ includeArchived: true })).filter((k) => k.is_own_kennel && !k.is_archived);
    const out = [];
    for (const k of kennels) {
      if (await getWebsiteLink(k.id)) out.push({ kennel_id: k.id, ...(await sendPortalFeed(k, opts)) });
    }
    return out;
  };
  const next = chain.then(run, run);
  chain = next.catch(() => {});
  return next;
}

// Started once per page (app.js). Asks each linked site for its facts and sends
// shortly after load, then FEED_DELAY_MS after the last data change, and when back
// online. Pro with a KennelPort address only; does nothing on a device with no
// website linked.
export function startPortalFeed({ win = globalThis } = {}) {
  if (!websiteLinkOffered()) return () => {};
  let timer = null;
  let pending = {};
  const schedule = (delay = FEED_DELAY_MS, opts = {}) => {
    if (timer) clearTimeout(timer);
    pending = { opening: pending.opening || opts.opening === true };
    timer = setTimeout(() => {
      timer = null;
      const run = pending;
      pending = {};
      syncPortalFeeds(run).catch(() => {});
    }, delay);
  };
  const onChange = () => schedule();
  const onOnline = () => schedule(2000);
  win.addEventListener?.(CLOUD_DATA_CHANGED_EVENT, onChange);
  win.addEventListener?.('online', onOnline);
  schedule(FEED_START_DELAY_MS, { opening: true });
  return () => {
    if (timer) clearTimeout(timer);
    win.removeEventListener?.(CLOUD_DATA_CHANGED_EVENT, onChange);
    win.removeEventListener?.('online', onOnline);
  };
}
