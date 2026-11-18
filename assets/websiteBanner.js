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
import { ownKennels } from '../data/kennelScope.js';
import { getWebsiteLink } from '../data/kennelportLinkStore.js';
import { pendingWebsiteChanges } from '../data/kennelportLink.js';
import { CLOUD_DATA_CHANGED_EVENT, getWebsiteLaterFor, setWebsiteLaterFor, getWebsitePublishOnSend } from '../data/settings.js';

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

// The strip on every page (or, with `el`, Today's card). Never throws.
export function startWebsiteBanner({ el = null, win = globalThis } = {}) {
  const doc = win.document;
  let box = el;
  let open = false;
  let note = null;
  let waiting = [];
  let timer = null;
  let sending = false;

  const ensureBox = () => {
    if (box) return box;
    box = doc.createElement('div');
    box.className = 'website-banner inline-notice';
    box.setAttribute('role', 'status');
    // Full width under the nav, like the sample-data strip.
    box.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0;border-radius:0;border-width:0 0 1px;padding:8px 16px;';
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
      const out = await pressUpdateWebsite(w.kennel);
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
    try { waiting = await websiteWaiting(); } catch { waiting = []; }
    draw();
  }
  const schedule = () => { if (timer) win.clearTimeout(timer); timer = win.setTimeout(check, CHECK_DELAY_MS); };
  win.addEventListener?.(CLOUD_DATA_CHANGED_EVENT, schedule);
  schedule();
  return { check, stop: () => win.removeEventListener?.(CLOUD_DATA_CHANGED_EVENT, schedule) };
}
