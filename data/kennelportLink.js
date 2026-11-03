// kennelportLink.js — Connect website and Update website (KennelPort plan 5.2,
// 5.4, 5.5; End-State guide §35): the steps between her records, siteExport.js
// (what goes) and kennelportApi.js (the wire). Pages call these; the pure parts
// (which addresses to fill, which kennel settings follow the site) are exported
// for the tests.
//
// - Pro only, with a KennelPort address (kennelportApi.websiteLinkOffered).
// - One link per own kennel, per device: the token is in device_secrets
//   (kennelportLinkStore.js), never in a backup or the cloud.
// - Update website sends nothing on its own: only when she presses it (KennelPort
//   decision 5), and never while a Pro license has lapsed (decision 27).
// - What comes back fills, never overwrites what she typed: a dog's `url` and a
//   litter's `photos_url` get their page's address only when blank or holding an
//   address KennelPort wrote (any kennelport.com page, or her site's own); one that
//   left the site is blanked. The same rule fills the kennel's `website` and her
//   waitlist's `extras_info_url`.
import { dogRepo } from './dogRepo.js';
import { litterRepo } from './litterRepo.js';
import { pairingRepo } from './pairingRepo.js';
import { eventRepo } from './eventRepo.js';
import { saleRepo } from './saleRepo.js';
import { kennelRepo } from './kennelRepo.js';
import { accountRepo } from './accountRepo.js';
import { waitlistOfferRepo } from './waitlistOfferRepo.js';
import { TEST_TYPES } from './healthTestLog.js';
import { waitlistConfig, embedOrigin, EMBED_ORIGINS_MAX } from './waitlistRules.js';
import { todayYMD } from './dateUtils.js';
import { isLicenseGated, evaluateLicense } from './license.js';
import { editionFlags } from './editionConfig.js';
import { buildSiteBundle, websiteCounts } from './siteExport.js';
import { redeemLinkCode, linkStatus, stopLink, sendBundle, websiteLinkOffered, KennelportError } from './kennelportApi.js';
import { getWebsiteLink, setWebsiteLink, noteWebsiteAnswer, clearWebsiteLink } from './kennelportLinkStore.js';

export { websiteLinkOffered, KennelportError, getWebsiteLink };

// --- pure: what the site's answer changes here --------------------------------

const originOf = (url) => {
  try { return new URL(String(url)).origin; } catch { return null; }
};
const KENNELPORT_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*kennelport\.com$/;

// Was this address written by KennelPort (so it may be replaced or blanked)? Any
// kennelport.com page, or a page on her site's own address (her custom domain).
// `sites`: the site facts this device has had (now and before).
export function isWebsiteAddress(url, sites = []) {
  const o = originOf(url);
  if (!o) return false;
  if (KENNELPORT_ORIGIN.test(o)) return true;
  return sites.some((s) => s?.website && originOf(s.website) === o);
}

// The url / photos_url changes an answer's addresses make (KennelPort plan 5.4).
// `addresses`: { dogs: { kennelosDogId: url }, litters: { kennelosLitterId: url } }.
// → [{ table: 'dogs' | 'litters', id, changes }].
export function addressChanges({ dogs = [], litters = [], addresses = {}, sites = [] }) {
  const out = [];
  const apply = (table, rows, field, byId) => {
    for (const r of rows) {
      const cur = String(r[field] ?? '').trim();
      const ours = cur && isWebsiteAddress(cur, sites);
      const next = byId[r.id] || null;
      if (next && next !== cur && (!cur || ours)) out.push({ table, id: r.id, changes: { [field]: next } });
      else if (!next && ours) out.push({ table, id: r.id, changes: { [field]: '' } });
    }
  };
  apply('dogs', dogs, 'url', addresses?.dogs || {});
  apply('litters', litters, 'photos_url', addresses?.litters || {});
  return out;
}

// The kennel settings the site's facts fill (KennelPort plan 5.5, "Filled in when
// linked"): its `website`, and in her waitlist settings `extras_info_url`, her
// public list for the website (`website_feed`, when the site's waitlist page wants
// it and her list is online), and the site in `embed_origins` when she has listed
// any. Each only when blank or KennelPort's own. → changes for kennelRepo.update,
// or null when nothing changes.
export function kennelChanges(kennel, site, sites = []) {
  if (!site || !site.website) return null;
  const changes = {};
  const known = [site, ...sites];
  const web = String(kennel.website ?? '').trim();
  if (web !== site.website && (!web || isWebsiteAddress(web, known))) changes.website = site.website;

  const before = kennel.waitlist_config || {};
  const c = waitlistConfig(kennel);
  const config = {};
  const extras = String(c.extras_info_url ?? '').trim();
  const nextExtras = site.extras_info_url || '';
  if (extras !== nextExtras && (!extras || isWebsiteAddress(extras, known))) config.extras_info_url = nextExtras;
  if (site.waitlist_page && c.online === true && c.website_feed !== true) config.website_feed = true;
  const listed = Array.isArray(c.embed_origins) ? c.embed_origins : [];
  const siteOrigin = originOf(site.website);
  if (listed.length && siteOrigin && listed.length < EMBED_ORIGINS_MAX && !listed.some((o) => embedOrigin(o) === siteOrigin)) config.embed_origins = [...listed, siteOrigin];
  if (Object.keys(config).length) changes.waitlist_config = { ...before, ...config };
  return Object.keys(changes).length ? changes : null;
}

// The kennel record's website when she typed her own (an older homepage, say):
// never replaced silently, but offered — invoices, receipts and contract forms
// print it, so it should be the site families find. → { current, next } to ask
// about, or null (blank or KennelPort's own: kennelChanges fills those; already
// the same; or she said Keep mine for this address).
const sameAddress = (a, b) => {
  const norm = (u) => { try { const x = new URL(String(u).trim()); return `${x.origin.toLowerCase()}${x.pathname.replace(/\/+$/, '')}${x.search}`; } catch { return String(u ?? '').trim().replace(/\/+$/, '').toLowerCase(); } };
  return norm(a) === norm(b);
};
export function websiteOffer(kennel, site, { sites = [], kept = null } = {}) {
  const current = String(kennel?.website ?? '').trim();
  if (!site?.website || !current) return null;
  if (sameAddress(current, site.website) || isWebsiteAddress(current, [site, ...sites])) return null;
  if (kept && sameAddress(kept, site.website)) return null;
  return { current, next: site.website };
}

// The offer for this kennel on this device, from its record and the link's last facts.
export async function pendingWebsiteOffer(kennelId) {
  const link = await getWebsiteLink(kennelId);
  const kennel = link ? await kennelRepo.getById(kennelId) : null;
  return kennel ? websiteOffer(kennel, link.site, { kept: link.kept_website }) : null;
}

// Her answer: use the website's address on the kennel record, or keep hers (asked
// again only if the website's address changes, e.g. to her own domain).
export async function useSiteAsKennelWebsite(kennelId) {
  const link = await getWebsiteLink(kennelId);
  if (!link?.site?.website) return;
  await kennelRepo.update(kennelId, { website: link.site.website });
}
export async function keepKennelWebsite(kennelId) {
  const link = await getWebsiteLink(kennelId);
  if (link?.site?.website) await noteWebsiteAnswer(kennelId, { kept_website: link.site.website });
}

// --- the records a bundle is built from ---------------------------------------

async function records(kennel) {
  const [dogs, litters, pairings, sales, offers, accounts, events] = await Promise.all([
    dogRepo.getAll({ includeArchived: true }),
    litterRepo.getAll(),
    pairingRepo.getAll(),
    saleRepo.getAll(),
    editionFlags.waitlist ? waitlistOfferRepo.getByKennel(kennel.id) : [],
    editionFlags.accounts ? accountRepo.getAll() : [],
    Promise.all(['title_earned', 'heat_cycle', ...TEST_TYPES].map((t) => eventRepo.getByType(t))).then((lists) => lists.flat())
  ]);
  return { dogs, litters, pairings, sales, offers, accounts, events };
}

// What Update website would send for this kennel, counted (the Website card).
export async function websiteSummary(kennel) {
  const r = await records(kennel);
  return websiteCounts(kennel, { ...r, today: todayYMD() });
}

async function applyKennelFacts(kennel, site, previous) {
  const changes = kennelChanges(kennel, site, previous ? [previous] : []);
  if (changes) await kennelRepo.update(kennel.id, changes);
  return changes;
}

// --- Connect website ------------------------------------------------------------

// Redeem the code from KennelPort Site Manager's Link KennelOS for this kennel, on
// this device. → the site's facts.
export async function connectWebsite(kennel, code, deviceLabel) {
  if (!websiteLinkOffered()) throw new KennelportError('other', 'Your website isn\'t available in this edition.');
  if (!kennel?.id) throw new KennelportError('other', 'Choose a kennel first.');
  const out = await redeemLinkCode(code, kennel.id, deviceLabel);
  if (!out?.token) throw new KennelportError('other', 'KennelPort didn\'t send a link. Try a new code.');
  await setWebsiteLink(kennel.id, { token: out.token, site: out.site, device_label: deviceLabel });
  await applyKennelFacts(kennel, out.site, null);
  return out.site;
}

// Stop this device. KennelPort stops this device's token; the last device to stop
// is an Unlink there. Forgets the link here even when KennelPort can't be reached.
export async function disconnectWebsite(kennelId) {
  const link = await getWebsiteLink(kennelId);
  if (!link) return;
  try { await stopLink(link.token); } catch (err) {
    if (!(err instanceof KennelportError) || err.kind !== 'not_linked') {
      await clearWebsiteLink(kennelId);
      return { reached: false };
    }
  }
  await clearWebsiteLink(kennelId);
  return { reached: true };
}

// --- Update website -------------------------------------------------------------

export class LicenseLapsedError extends Error {
  constructor() {
    super('Your KennelOS Pro license has lapsed, so your website wasn\'t updated. It keeps what it has. Renew, and Update website works again with no new code.');
    this.name = 'LicenseLapsedError';
  }
}

async function licenseOk() {
  if (!isLicenseGated()) return true;
  const { state } = await evaluateLicense();
  return state === 'valid' || state === 'grace';
}

// Send this kennel's website what she marked. → { summary, filled, site }:
// KennelPort's summary ({ text, updated, created, … }), how many photos links were
// filled or cleared here, and the site's facts. A stopped link (Unlink in
// KennelPort) forgets the token and throws KennelportError 'not_linked'.
export async function updateWebsite(kennel, { bundleId = crypto.randomUUID(), today = todayYMD() } = {}) {
  const link = await getWebsiteLink(kennel?.id);
  if (!link) throw new KennelportError('not_linked', 'Connect your website first.', 'not_linked');
  if (!(await licenseOk())) throw new LicenseLapsedError();
  const forget = async (err) => {
    if (err instanceof KennelportError && err.kind === 'not_linked') await clearWebsiteLink(kennel.id);
    throw err;
  };
  // The site's facts first: whether it takes her prices now (Use my KennelOS
  // prices, decision 6), so private prices go only while it does.
  const status = await linkStatus(link.token).catch(forget);
  const site = status.site || link.site;
  const r = await records(kennel);
  const bundle = buildSiteBundle({ kennel, ...r, today, bundleId, sentAt: new Date().toISOString(), prices: site?.kennelos_prices === true, sections: site?.sections || [] });
  const answer = await sendBundle(link.token, bundle).catch(forget);
  const after = answer.site || site;
  await noteWebsiteAnswer(kennel.id, { site: after, summary: answer.summary || { text: 'Sent.' } });

  // Photos links (KennelPort plan 5.4): only this kennel's dogs and litters.
  const sites = [after, link.site].filter(Boolean);
  const changes = addressChanges({
    dogs: r.dogs.filter((d) => !d.is_archived && d.kennel_id === kennel.id),
    litters: r.litters.filter((l) => !l.is_archived && l.kennel_id === kennel.id),
    addresses: answer.addresses || {},
    sites
  });
  for (const c of changes) {
    if (c.table === 'dogs') await dogRepo.update(c.id, c.changes);
    else await litterRepo.update(c.id, c.changes);
  }
  const fresh = await kennelRepo.getById(kennel.id);
  await applyKennelFacts(fresh || kennel, after, link.site);
  return { summary: answer.summary || null, filled: changes.length, site: after };
}
