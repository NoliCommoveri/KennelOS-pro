// websiteBanner.js — "Your website has changes not sent yet", wherever she is
// (the owner's request, 2026-11-18; End-State guide §35). After she changes
// anything a linked KennelPort website shows (a dog, a litter or its puppies, a
// pairing or heat, her extras and prices, a recommended product on Accounts, How it
// works steps, How to pay, her waitlist details), every page but Today shows a strip
// under the nav with what changed and Send now; Today shows the same as a card. Send
// now is Update website (websiteCard.pressUpdateWebsite), which publishes too unless
// she keeps sends in the draft. "Later" hides it until something else changes.
//
// The puppy portal's feed isn't counted here: it goes by itself (portalFeedSync.js).
//
// Pro with a KennelPort address only (app.js loads this under editionFlags.websiteLink,
// never in the Demo); nothing shows until a kennel is linked on this device.
//
// When it compares (Load Performance plan D7): the compare reads seven tables and
// rebuilds the whole site bundle, so its answer is kept (settings
// getWebsiteStripCache) and the next page draws the strip from it in the first
// paint (app.js, and today.js for the card). A page compares again only when
// records changed since the last compare (settings.getDataChangedAt), on a new
// day (the bundle counts from today's date), or when nothing is kept (a link,
// a send or a site answer clears it: kennelportLinkStore.js). After a change
// while the page is open, it compares CHECK_DELAY_MS later, as before.
import { ownKennels } from '../data/kennelScope.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { getWebsiteLink } from '../data/kennelportLinkStore.js';
import { pendingWebsiteChanges } from '../data/kennelportLink.js';
import { todayYMD } from '../data/dateUtils.js';
import {
  CLOUD_DATA_CHANGED_EVENT, getWebsiteLaterFor, setWebsiteLaterFor, getWebsitePublishOnSend,
  getWebsiteStripCache, setWebsiteStripCache, getDataChangedAt
} from '../data/settings.js';

// ui.js's esc, here so the words can be tested without a page (ui.js reads the
// document as it loads); websiteCard.js is loaded only when she presses Send.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const CHECK_DELAY_MS = 1500;
const SHOW_LINES = 3;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// What's waiting, per linked kennel: [{ kennel, lines, never, portal }]. Kennels
// with nothing waiting (or whose bundle can't be built) are left out.
export async function websiteWaiting() {
  const out = [];
  for (const kennel of await ownKennels()) {
    const link = await getWebsiteLink(kennel.id);
    if (!link) continue;
    const ch = await pendingWebsiteChanges(kennel);
    if (ch.error) continue;
    if (ch.never || ch.lines.length) out.push({ kennel, lines: ch.lines || [], never: Boolean(ch.never), portal: Boolean(link.site?.portal_feed) });
  }
  return out;
}

// One string for what's waiting, so "Later" holds only until it changes.
export const waitingSignature = (waiting) => JSON.stringify(waiting.map((w) => [w.kennel.id, w.never ? 'never' : w.lines])).slice(0, 200);

// The strip's (or card's) inner HTML. Pure apart from the setting it reads.
export function waitingHtml(waiting, { open = false, note = null, publish = getWebsitePublishOnSend() } = {}) {
  if (note) return `<span>${esc(note.text)}</span>`;
  const many = waiting.length > 1;
  const count = waiting.reduce((n, w) => n + (w.never ? 0 : w.lines.length), 0);
  const head = waiting.every((w) => w.never) ? 'Your website hasn’t been sent anything from this device yet.'
    : `Your website has ${plural(count, 'change')} not sent yet${count && !open ? `: ${esc(waiting.flatMap((w) => w.lines).slice(0, SHOW_LINES).join('; '))}${count > SHOW_LINES ? '…' : ''}` : '.'}`;
  const detail = open ? `<ul class="website-banner-list">${waiting.map((w) => `${many ? `<li><strong>${esc(w.kennel.kennel_name || 'Your kennel')}</strong></li>` : ''}${w.never ? '<li>Everything you marked Show on website</li>' : w.lines.map((t) => `<li>${esc(t)}</li>`).join('')}`).join('')}</ul>
    ${waiting.some((w) => w.portal) ? '<p class="field-hint" style="margin:4px 0 0;">Puppy portal updates (families, pickups, extras on a sale) go by themselves.</p>' : ''}` : '';
  return `<span>${head}</span>
    <span class="pill-row" style="margin-left:auto;">
      <button class="btn btn-primary btn-sm" data-web="send">${publish ? 'Send and publish' : 'Send to draft'}</button>
      <button class="btn btn-sm" data-web="open">${open ? 'Hide' : 'See changes'}</button>
      <button class="btn btn-sm" data-web="later">Later</button>
    </span>${detail}`;
}

// What is kept of a compare: only what the strip draws and Send now needs.
const keep = (waiting) => waiting.map((w) => ({
  kennel: { id: w.kennel.id, kennel_name: w.kennel.kennel_name || '' },
  lines: w.lines || [], never: Boolean(w.never), portal: Boolean(w.portal)
}));

// Is the kept compare still good? Pure, for tests.
export function compareIsFresh(cache, { dataChangedAt = null, today = todayYMD() } = {}) {
  if (!cache?.checkedAt) return false;
  if (cache.checkedAt.slice(0, 10) !== today) return false;
  return !dataChangedAt || dataChangedAt <= cache.checkedAt;
}

// Keep a compare's answer for the next page's first paint.
export function rememberCompare(waiting, checkedAt = new Date().toISOString()) {
  const kept = keep(waiting);
  setWebsiteStripCache({
    checkedAt, waiting: kept, signature: waitingSignature(kept),
    html: kept.length ? waitingHtml(kept) : null
  });
  return kept;
}

const idle = (win, fn) => (win.requestIdleCallback ? win.requestIdleCallback(fn, { timeout: 2000 }) : win.setTimeout(fn, 200));

// The strip on every page (or, with `el`, Today's card). Never throws. Adopts the
// strip app.js already drew from the kept compare, if any.
export function startWebsiteBanner({ el = null, win = globalThis } = {}) {
  const doc = win.document;
  let box = el || doc.querySelector('.website-banner-strip');
  let open = false;
  let note = null;
  const cache = getWebsiteStripCache();
  let waiting = cache?.waiting || [];
  let timer = null;
  let sending = false;

  const ensureBox = () => {
    if (box) return box;
    box = doc.createElement('div');
    box.className = 'website-banner website-banner-strip inline-notice';
    box.setAttribute('role', 'status');
    // Under the app's nav bar, where the sample-data strip goes.
    const nav = doc.getElementById('app-nav') || doc.querySelector('nav');
    if (nav) nav.insertAdjacentElement('afterend', box); else doc.body.prepend(box);
    return box;
  };

  const draw = () => {
    const shown = note || (waiting.length && getWebsiteLaterFor() !== waitingSignature(waiting));
    if (!shown) { if (box) { box.hidden = true; box.innerHTML = ''; } return; }
    const b = ensureBox();
    b.hidden = false;
    b.innerHTML = el ? `<div class="card inline-notice" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">${waitingHtml(waiting, { open, note })}</div>` : waitingHtml(waiting, { open, note });
    b.querySelector('[data-web="open"]')?.addEventListener('click', () => { open = !open; draw(); });
    b.querySelector('[data-web="later"]')?.addEventListener('click', () => { setWebsiteLaterFor(waitingSignature(waiting)); open = false; draw(); });
    b.querySelector('[data-web="send"]')?.addEventListener('click', send);
  };

  async function send(ev) {
    if (sending) return;
    sending = true;
    if (ev?.target) { ev.target.disabled = true; ev.target.textContent = 'Sending…'; }
    const texts = [];
    const { pressUpdateWebsite } = await import('./websiteCard.js');
    for (const w of waiting) {
      // The kept compare has only the kennel's id and name; send the record itself.
      const kennel = (await kennelRepo.getById(w.kennel.id).catch(() => null)) || w.kennel;
      const out = await pressUpdateWebsite(kennel);
      texts.push(`${waiting.length > 1 ? `${w.kennel.kennel_name || 'Your kennel'}: ` : ''}${out.ok ? out.text : `That didn't go: ${out.text}${out.notLinked ? ' Connect again in Settings, under Your website.' : ''}`}`);
    }
    sending = false;
    open = false;
    note = { text: texts.join(' ') };
    draw();
    win.setTimeout(() => { note = null; check(); }, 8000);
  }

  async function check() {
    timer = null;
    if (sending || note) return;
    // Stamped before the compare, so a change made while it runs compares again.
    const startedAt = new Date().toISOString();
    try { waiting = rememberCompare(await websiteWaiting(), startedAt); } catch { waiting = []; }
    draw();
  }
  const schedule = () => { if (timer) win.clearTimeout(timer); timer = win.setTimeout(check, CHECK_DELAY_MS); };
  win.addEventListener?.(CLOUD_DATA_CHANGED_EVENT, schedule);
  // The kept answer is drawn at once (again, if app.js drew it, so its buttons are
  // wired); a compare runs after first paint only when that answer may be stale.
  draw();
  if (!compareIsFresh(cache, { dataChangedAt: getDataChangedAt() })) idle(win, () => { if (!timer) check(); });
  return { check, stop: () => win.removeEventListener?.(CLOUD_DATA_CHANGED_EVENT, schedule) };
}
