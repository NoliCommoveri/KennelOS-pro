// websiteUpdateUI.js — Kels's "Update my website" (KennelPort plan 5.5; End-State
// guide §33, §35): what's marked Show on website, then Update website on her say.
// Pro with a KennelPort address only (kels.js's `available`). Connecting stays on
// Settings' Your website card, where she types the code.
import { esc } from './ui.js';
import { ownKennels, getActiveKennelId } from '../data/kennelScope.js';
import { getWebsiteLink, websiteSummary, pendingWebsiteOffer, useSiteAsKennelWebsite, keepKennelWebsite } from '../data/kennelportLink.js';
import { pressUpdateWebsite } from './websiteCard.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const settingsUrl = () => new URL('../pages/settings.html', import.meta.url).href;

export async function runWebsiteTask(chat, { onExit = () => {} } = {}) {
  const linked = [];
  for (const k of await ownKennels()) if (await getWebsiteLink(k.id)) linked.push(k);
  if (!linked.length) {
    await chat.say('Your website isn\'t connected on this device yet. In Settings, under <strong>Your website</strong>, type the code from KennelPort Site Manager\'s <strong>Link KennelOS</strong>. Then I can send it your dogs and litters.');
    const go = await chat.choose([{ label: 'Open Settings', value: 'go', primary: true }, { label: 'Not now', value: 'no' }]);
    if (go === 'go') { location.href = settingsUrl(); return; }
    return onExit('done');
  }
  let kennel = linked.find((k) => k.id === getActiveKennelId()) || linked[0];
  if (linked.length > 1) {
    const id = await chat.choose(linked.map((k) => ({ label: k.kennel_name || 'Kennel', value: k.id, primary: k.id === kennel.id })));
    kennel = linked.find((k) => k.id === id);
  }
  const c = await websiteSummary(kennel);
  await chat.say(`Marked <strong>Show on website</strong>: ${esc([plural(c.dogs, 'dog'), plural(c.litters, 'litter'), plural(c.pairings, 'pairing'), plural(c.heats, 'planned heat'), plural(c.products, 'recommended product')].join(', '))}. I'll send those, with each puppy's status, and your website keeps the photos and wording you gave it there. Ready?`);
  const pick = await chat.choose([{ label: 'Update website', value: 'send', primary: true }, { label: 'Not now', value: 'no' }]);
  if (pick !== 'send') return onExit('nevermind');
  await chat.say('Sending…', { typing: 400 });
  const out = await pressUpdateWebsite(kennel);
  if (out.ok) await chat.say(`Done! ${esc(out.text)} It's in your website's draft: open KennelPort Site Manager to check it and press Publish.`);
  else await chat.say(`That didn't go: ${esc(out.text)}${out.notLinked ? ' You can connect again in Settings, under Your website.' : ''}`);
  // Her kennel record still names her own website: offer the KennelPort one.
  const offer = out.ok ? await pendingWebsiteOffer(kennel.id) : null;
  if (offer) {
    await chat.say(`One more thing: your kennel record's website is ${esc(offer.current)}. Should it be your KennelPort website, <strong>${esc(offer.next)}</strong>, instead? It's what your invoices, receipts and contract forms print.`);
    const use = await chat.choose([{ label: 'Use my KennelPort website', value: 'use', primary: true }, { label: 'Keep mine', value: 'keep' }]);
    if (use === 'use') { await useSiteAsKennelWebsite(kennel.id); await chat.say('Done, your kennel record has it now.'); }
    else { await keepKennelWebsite(kennel.id); await chat.say('Okay, I\'ll leave it as it is.'); }
  }
  return onExit('done');
}
