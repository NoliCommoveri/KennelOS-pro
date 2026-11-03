// websiteUpdateUI.js — Kels's "Update my website" (KennelPort plan 5.5; End-State
// guide §33, §35). Before sending, she goes through what isn't on the website yet,
// a group at a time with tick boxes (her adults, kept pups whose litter has gone,
// litters, pairings, heats), gives a deposits date to any shown litter that's born
// without one, and checks her website settings (KennelOS prices, her waitlist
// online, the kennel record's website). Then what's marked goes, on her say.
// Pro with a KennelPort address only (kels.js's `available`). Not connected on this
// device: Kels asks whether she has a KennelPort website, and on a yes walks her
// through linking it (Site Manager in a new tab for the code, typed back here), the
// same link as Settings' Your website card. That card's Update website button
// sends straight away.
import { esc, fmtDate } from './ui.js';
import { kennelportLinkCodeUrl } from '../data/kennelportApi.js';
import { ownKennels, getActiveKennelId } from '../data/kennelScope.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import {
  getWebsiteLink, connectWebsite, websiteSummary, pendingWebsiteOffer, useSiteAsKennelWebsite, keepKennelWebsite,
  websiteGapsFor, markOnWebsite, setDepositsDate, websiteFacts, setWebsitePrices, pendingWebsiteChanges, KennelportError
} from '../data/kennelportLink.js';
import { waitlistIsSetUp } from '../data/waitlistRules.js';
import { isWaitlistOnlineOffered } from '../data/cloud/cloudConfig.js';
import { offerCloudBackup } from './kelsBackupSteps.js';
import { pressUpdateWebsite, guessDeviceLabel } from './websiteCard.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const STATUS_WORDS = { active_breeding: 'breeding', retired_breeding: 'retired', for_sale: 'for sale' };

// Ask about one group: Kels's line, then a tick box per record (ticked to start
// when `ticked`), with Add these and Skip. → the ids she ticked ([] on Skip).
async function askGroup(chat, { title, items, label, ticked = true, submitLabel = 'Add these' }) {
  if (!items.length) return [];
  const res = await chat.form({
    title,
    html: items.map((r) => `<label class="check-inline" style="display:flex;margin:6px 0;"><input type="checkbox" data-id="${esc(r.id)}"${ticked ? ' checked' : ''}> ${label(r)}</label>`).join(''),
    submit: (root) => [...root.querySelectorAll('input[data-id]:checked')].map((b) => b.dataset.id),
    reply: (ids) => (ids.length ? `${submitLabel} (${ids.length})` : 'None of them'),
    submitLabel,
    cancelLabel: 'Skip'
  });
  return res.done ? res.result : [];
}

export async function runWebsiteTask(chat, { onExit = () => {} } = {}) {
  const linked = [];
  for (const k of await ownKennels()) if (await getWebsiteLink(k.id)) linked.push(k);
  if (!linked.length) {
    const k = await askToLink(chat);
    if (!k) return onExit('done');
    linked.push(k);
  }
  let kennel = linked.find((k) => k.id === getActiveKennelId()) || linked[0];
  if (linked.length > 1) {
    const id = await chat.choose(linked.map((k) => ({ label: k.kennel_name || 'Kennel', value: k.id, primary: k.id === kennel.id })));
    kennel = linked.find((k) => k.id === id);
  }

  await askWhatsMissing(chat, kennel);
  await askDeposits(chat, kennel);
  await askSettings(chat, kennel);

  const c = await websiteSummary(kennel);
  await chat.say(`Marked <strong>Show on website</strong>: ${esc([plural(c.dogs, 'dog'), plural(c.litters, 'litter'), plural(c.pairings, 'pairing'), plural(c.heats, 'planned heat'), plural(c.products, 'recommended product')].join(', '))}. I'll send those, with each puppy's status, and your website keeps the photos and wording you gave it there. Ready?`);
  const pick = await chat.choose([{ label: 'Update website', value: 'send', primary: true }, { label: 'Not now', value: 'no' }]);
  if (pick !== 'send') return onExit('nevermind');
  await chat.say('Sending…', { typing: 400 });
  const out = await pressUpdateWebsite(kennel);
  if (out.ok) await chat.say(`Done! ${esc(out.text)} It's in your website's draft: open KennelPort Site Manager to check it and press Publish.`);
  else await chat.say(`That didn't go: ${esc(out.text)}${out.notLinked ? ' You can connect again in Settings, under Your website.' : ''}`);
  return onExit('done');
}

// Not connected on this device. Has she a website through KennelPort? On a yes,
// link it here: the code from Site Manager's Link KennelOS (opened in a new tab),
// typed in when she's back. → the linked kennel, or null.
async function askToLink(chat) {
  await chat.say('First things first: do you have a website through <strong>KennelPort</strong>? It\'s the website service that works with KennelOS, where you edit your site in KennelPort Site Manager.');
  const has = await chat.choose([
    { label: 'Yes, I have one', value: 'yes', primary: true },
    { label: 'No', value: 'no' },
    { label: 'I\'m not sure', value: 'unsure' }
  ]);
  if (has !== 'yes') {
    await chat.say(has === 'no'
      ? 'Okay! This is for KennelPort websites only, so there\'s nothing to send for now. Your records here are all set either way.'
      : 'No problem. If you have one, you\'ll have had an email inviting you to KennelPort Site Manager, at manage.kennelport.com. Ask me again once you know, and I\'ll help you connect it.');
    return null;
  }
  const kennels = await ownKennels();
  if (!kennels.length) {
    await chat.say('I need one of your own kennels to link it to first. Add your kennel on the Kennels page, then ask me again.');
    return null;
  }
  let kennel = kennels.find((k) => k.id === getActiveKennelId()) || kennels[0];
  if (kennels.length > 1) {
    await chat.say('Which of your kennels is this website for? Each kennel links to its own website.');
    const id = await chat.choose(kennels.map((k) => ({ label: k.kennel_name || 'Kennel', value: k.id, primary: k.id === kennel.id })));
    kennel = kennels.find((k) => k.id === id);
  }
  const url = kennelportLinkCodeUrl();
  await chat.say(`Great, let's connect it to this device, so I can send it your dogs and litters. Two steps:<br>1. Open <strong>KennelPort Site Manager</strong> in a new tab, sign in, and on <strong>Link KennelOS</strong> press <strong>Show a link code</strong>.<br>2. Come back to this tab and type the code in here. It works once, for a few minutes.`);
  const go = await chat.choose([{ label: 'Open KennelPort Site Manager', value: 'open', primary: true }, { label: 'I have my code', value: 'have' }]);
  // Straight after her tap, so the browser lets the new tab open.
  if (go === 'open' && url) window.open(url, '_blank', 'noopener');
  const res = await chat.form({
    title: 'Type the code from Link KennelOS, and a name for this device so you can tell your devices apart there.',
    html: `<div class="field"><label for="wu-code">Code</label><input id="wu-code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="ABCD-2345" maxlength="9"></div>
      <div class="field"><label for="wu-device">This device</label><input id="wu-device" maxlength="60" value="${esc(guessDeviceLabel())}"></div>`,
    submit: async (root) => {
      const code = root.querySelector('#wu-code').value.trim();
      if (!code) return 'Type the code from KennelPort Site Manager first.';
      try {
        return await connectWebsite(kennel, code, root.querySelector('#wu-device').value.trim());
      } catch (err) {
        return err instanceof KennelportError ? err.message : String(err?.message || err);
      }
    },
    reply: () => 'Connected',
    submitLabel: 'Connect',
    cancelLabel: 'Not now'
  });
  if (!res.done) {
    await chat.say('Okay. You can connect any time here, or in Settings under <strong>Your website</strong>.');
    return null;
  }
  await chat.say(`Connected to <strong>${esc(res.result?.website || 'your website')}</strong>! You'll see it in Settings under Your website too. Now let's get it up to date.`);
  return kennel;
}

// The groups of what could be on the website and isn't marked, one at a time.
async function askWhatsMissing(chat, kennel) {
  const g = await websiteGapsFor(kennel);
  const dogsById = new Map((await dogRepo.getAll({ includeArchived: true })).map((d) => [d.id, d]));
  const dogName = (d) => esc(d?.call_name || d?.registered_name || 'Unknown');
  const parents = (r) => `${dogName(dogsById.get(r.dam_id))} × ${dogName(dogsById.get(r.sire_id))}`;
  const one = (list, a, b) => (list.length === 1 ? a : b);
  const picked = { dogs: [], litters: [], pairings: [], heats: [] };

  picked.dogs.push(...await askGroup(chat, {
    title: `You have ${plural(g.dogs.length, 'dog')} that ${one(g.dogs, 'isn\'t', 'aren\'t')} on your website. Want to add ${one(g.dogs, 'it', 'them')}? Each gets a page and a card on your Dogs page.`,
    items: g.dogs,
    label: (d) => `<span><strong>${dogName(d)}</strong> <span class="muted">· ${esc(STATUS_WORDS[d.status] || '')}</span></span>`
  }));
  picked.dogs.push(...await askGroup(chat, {
    title: `${one(g.keptPups, 'A puppy you\'re keeping isn\'t', `${plural(g.keptPups.length, 'puppy', 'puppies')} you're keeping aren't`)} on your website, and ${one(g.keptPups, 'her litter has', 'their litters have')} left it. Keep ${one(g.keptPups, 'her', 'them')} on the site as your own, with puppy photos? ${one(g.keptPups, 'She shows', 'They show')} under Up and coming.`,
    items: g.keptPups,
    label: (d) => `<span><strong>${dogName(d)}</strong></span>`,
    submitLabel: 'Keep these'
  }));
  picked.litters = await askGroup(chat, {
    title: `You have ${plural(g.litters.length, 'litter')} not currently listed. Want to add ${one(g.litters, 'it', 'them')} to the website? Puppies come with their litter.`,
    items: g.litters,
    label: (l) => `<span>${l.nickname ? `<strong>${esc(l.nickname)}</strong> ` : ''}${parents(l)} <span class="muted">· ${l.status === 'expected' ? 'expected' : l.whelp_date ? `born ${esc(fmtDate(l.whelp_date))}` : 'born'}</span></span>`
  });
  picked.pairings = await askGroup(chat, {
    title: `You have ${plural(g.pairings.length, 'pairing')} not under Coming up on your website. Add ${one(g.pairings, 'it', 'them')}?`,
    items: g.pairings,
    label: (p) => `<span><strong>${parents(p)}</strong>${p.planned_date ? ` <span class="muted">· ${esc(fmtDate(p.planned_date))}</span>` : ''}</span>`
  });
  picked.heats = await askGroup(chat, {
    title: `Your website can show when a girl's next heat is due, as a month, under Coming up. ${one(g.heats, 'This girl\'s heats don\'t', 'These girls\' heats don\'t')} show yet. Show any?`,
    items: g.heats,
    label: (d) => `<span><strong>${dogName(d)}</strong></span>`,
    ticked: false,
    submitLabel: 'Show these'
  });
  const n = picked.dogs.length + picked.litters.length + picked.pairings.length + picked.heats.length;
  if (n) {
    await markOnWebsite(picked);
    await chat.say(`Done, ${plural(n, 'change')} marked for your website.`, { typing: 300 });
  }
}

// A shown litter that's born, with no accept deposits date: its puppies would show
// as available straight away. Ask for one; blank leaves it so.
async function askDeposits(chat, kennel, { only = null } = {}) {
  const deposits = (await websiteGapsFor(kennel)).deposits.filter((l) => !only || only.includes(l.id));
  if (!deposits.length) return;
  const dogsById = new Map((await dogRepo.getAll({ includeArchived: true })).map((d) => [d.id, d]));
  const name = (l) => l.nickname || `${dogsById.get(l.dam_id)?.call_name || 'Unknown'} × ${dogsById.get(l.sire_id)?.call_name || 'Unknown'}`;
  const res = await chat.form({
    title: `${deposits.length === 1 ? `The ${esc(name(deposits[0]))} litter is` : `${plural(deposits.length, 'litter')} on your website are`} born with no <strong>accept deposits</strong> date, so ${deposits.length === 1 ? 'its' : 'their'} puppies show as available straight away. When do deposits open? Until then they show under Coming up. Leave one blank to keep it available now.`,
    html: deposits.map((l) => `<div class="field"><label for="wu-dep-${esc(l.id)}">${esc(name(l))}${l.whelp_date ? ` <span class="muted">(born ${esc(fmtDate(l.whelp_date))})</span>` : ''}</label><input type="date" id="wu-dep-${esc(l.id)}" data-id="${esc(l.id)}"></div>`).join(''),
    submit: async (root) => {
      const set = [...root.querySelectorAll('input[data-id]')].filter((i) => i.value);
      for (const i of set) await setDepositsDate(i.dataset.id, i.value);
      return set.length;
    },
    reply: (n) => (n ? `Saved ${plural(n, 'date')}` : 'Leave them available'),
    submitLabel: 'Save',
    cancelLabel: 'Skip'
  });
  if (res.done && !res.result) await chat.say('Okay, they stay available straight away.', { typing: 300 });
}

// Her website settings: Use my KennelOS prices, her waitlist online, and the
// kennel record's website.
async function askSettings(chat, kennel) {
  const site = await websiteFacts(kennel.id);

  if (site && (site.settings || []).includes('kennelos_prices')) {
    const on = site.kennelos_prices === true;
    await chat.say(on
      ? 'Your litter and extras prices go to your website from here (<strong>Use my KennelOS prices</strong> is on). They show only where Show prices is on. Keep it that way?'
      : 'Your website has its own prices, typed in KennelPort. Want your litter and extras prices to come from here instead? They\'d show on any litter whose Show prices is on, and new litters start with it on.');
    const pick = await chat.choose(on
      ? [{ label: 'Keep sending prices', value: 'keep', primary: true }, { label: 'Stop sending prices', value: 'off' }]
      : [{ label: 'Send my prices', value: 'on', primary: true }, { label: 'Keep them in KennelPort', value: 'keep' }]);
    if (pick === 'on' || pick === 'off') {
      try {
        await setWebsitePrices(kennel, pick === 'on');
        await chat.say(pick === 'on' ? 'Done, your prices go with this update.' : 'Done, your prices stay here from now on.', { typing: 300 });
      } catch (err) {
        await chat.say(`I couldn't change that: ${esc(err instanceof KennelportError ? err.message : String(err?.message || err))}`);
      }
    }
  }

  if (site?.waitlist_page && isWaitlistOnlineOffered()) {
    const fresh = await kennelRepo.getById(kennel.id);
    const cw = await import('../data/cloud/cloudWaitlist.js');
    const st = cw.waitlistOnlineStatus(fresh);
    if (st.offered && !st.online) {
      if (!waitlistIsSetUp(fresh)) {
        await chat.say('Your website has a waitlist page, but it shows your list only once your waitlist is set up and online. Ask me to <strong>Set up my waitlist</strong> when you\'re ready.');
      } else {
        await chat.say('Your website\'s waitlist page shows your list only while it\'s online. Put it online, so families can see their place and apply there?');
        const pick = await chat.choose([
          { label: 'List and applications online', value: 'form', primary: true },
          { label: 'Just the list', value: 'list' },
          { label: 'Not now', value: '' }
        ]);
        if (pick && await offerCloudBackup(chat, {
          line: 'Your list goes online through cloud backup, and that\'s not on for this device yet. Want to turn it on now? It only takes a minute.',
          later: 'Okay, your list stays offline for now. I can put it online any time once cloud backup is on.'
        })) {
          await cw.saveWaitlistOnline(kennel.id, { online: true, online_form: pick === 'form' });
          await chat.say('Done, your list is going online.', { typing: 300 });
        }
      }
    }
  }

  // Her kennel record still names her own website: offer the KennelPort one.
  const offer = await pendingWebsiteOffer(kennel.id);
  if (offer) {
    await chat.say(`Your kennel record's website is ${esc(offer.current)}. Should it be your KennelPort website, <strong>${esc(offer.next)}</strong>, instead? It's what your invoices, receipts and contract forms print.`);
    const use = await chat.choose([{ label: 'Use my KennelPort website', value: 'use', primary: true }, { label: 'Keep mine', value: 'keep' }]);
    if (use === 'use') { await useSiteAsKennelWebsite(kennel.id); await chat.say('Done, your kennel record has it now.'); }
    else { await keepKennelWebsite(kennel.id); await chat.say('Okay, I\'ll leave it as it is.'); }
  }
}

// Kels's Add dogs and Record a new litter, after they save: on a device whose
// website is linked for the kennel, offer what was just made (her own adults, the
// litter) for the website, ticked, then a deposits date for a born litter without
// one. It goes with her next Update my website. `dogIds`, `litterIds`: what was
// made (or named, like a litter's parents); anything already shown, or that the
// website can't show, is left out. → whether she marked anything.
export async function offerWebsiteFor(chat, { dogIds = [], litterIds = [] } = {}) {
  let marked = false;
  for (const kennel of await ownKennels()) {
    if (!(await getWebsiteLink(kennel.id))) continue;
    const g = await websiteGapsFor(kennel);
    const dogs = [...g.dogs, ...g.keptPups].filter((d) => dogIds.includes(d.id));
    const litters = g.litters.filter((l) => litterIds.includes(l.id));
    if (!dogs.length && !litters.length) continue;
    const dogsById = new Map((await dogRepo.getAll({ includeArchived: true })).map((d) => [d.id, d]));
    const dogName = (d) => esc(d?.call_name || d?.registered_name || 'Unknown');
    const items = [...litters.map((l) => ({ id: l.id, kind: 'litter', l })), ...dogs.map((d) => ({ id: d.id, kind: 'dog', d }))];
    // Named when there are a few ("First Down and Zoey"), else counted.
    const names = [...litters.map((l) => (l.nickname ? `the ${esc(l.nickname)} litter` : 'the new litter')), ...dogs.map(dogName)];
    const what = names.length <= 3
      ? names.join(names.length === 2 ? ' and ' : ', ').replace(/, ([^,]*)$/, ', and $1')
      : [litters.length && plural(litters.length, 'litter'), dogs.length && plural(dogs.length, 'dog')].filter(Boolean).join(' and ');
    const ids = await askGroup(chat, {
      title: `Your website is linked. Show ${what} on it too?${litters.length ? ' Puppies come with their litter.' : ''}`,
      items,
      label: (x) => (x.kind === 'litter'
        ? `<span>${x.l.nickname ? `<strong>${esc(x.l.nickname)}</strong> ` : ''}${dogName(dogsById.get(x.l.dam_id))} × ${dogName(dogsById.get(x.l.sire_id))} <span class="muted">· litter</span></span>`
        : `<span><strong>${dogName(x.d)}</strong></span>`),
      submitLabel: 'Show on website'
    });
    if (!ids.length) continue;
    const picked = new Set(ids);
    await markOnWebsite({ dogs: dogs.filter((d) => picked.has(d.id)).map((d) => d.id), litters: litters.filter((l) => picked.has(l.id)).map((l) => l.id) });
    marked = true;
    await askDeposits(chat, kennel, { only: litters.filter((l) => picked.has(l.id)).map((l) => l.id) });
    await chat.say('Marked for your website.', { typing: 300 });
  }
  return marked;
}

// After any of Kels's tasks (kels.js onExit, and Add dogs / Record a new litter
// before their last step): when a linked website would change with an update, ask
// whether to check; on a yes, what would change (pendingWebsiteChanges) and Update
// website. The same changes aren't asked about twice on one page.
const asked = new Set();
const SHOW_LINES = 12;
export async function offerWebsiteCheck(chat) {
  const linked = [];
  for (const k of await ownKennels()) if (await getWebsiteLink(k.id)) linked.push(k);
  for (const kennel of linked) {
    const ch = await pendingWebsiteChanges(kennel);
    if (ch.error || (!ch.never && !ch.lines.length)) continue;
    const key = `${kennel.id}:${ch.never ? 'never' : JSON.stringify(ch.lines)}`;
    if (asked.has(key)) continue;
    asked.add(key);
    const whose = linked.length > 1 ? ` (${esc(kennel.kennel_name || 'your kennel')})` : '';
    await chat.say(`Some of this changes what your website${whose} shows. Want me to check for website updates?`);
    const look = await chat.choose([{ label: 'Yes, check', value: 'yes', primary: true }, { label: 'Not now', value: 'no' }]);
    if (look !== 'yes') continue;
    if (ch.never) {
      const c = await websiteSummary(kennel);
      await chat.say(`Your website hasn't been updated from this device yet, so I'd send everything you've marked: ${esc([plural(c.dogs, 'dog'), plural(c.litters, 'litter'), plural(c.pairings, 'pairing'), plural(c.heats, 'planned heat')].join(', '))}, with each puppy's status.`);
    } else {
      const shown = ch.lines.slice(0, SHOW_LINES);
      const more = ch.lines.length - shown.length;
      await chat.say(`An update would change ${plural(ch.lines.length, 'thing')} on your website:<ul class="kels-list">${shown.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>${more ? `…and ${plural(more, 'more change')}.` : ''}`);
    }
    const go = await chat.choose([{ label: 'Update website', value: 'send', primary: true }, { label: 'Not now', value: 'no' }]);
    if (go !== 'send') { await chat.say('Okay. Ask me to <strong>Update my website</strong> whenever you\'re ready.', { typing: 300 }); continue; }
    await chat.say('Sending…', { typing: 400 });
    const out = await pressUpdateWebsite(kennel);
    await chat.say(out.ok
      ? `Done! ${esc(out.text)} It's in your website's draft: open KennelPort Site Manager to check it and press Publish.`
      : `That didn't go: ${esc(out.text)}${out.notLinked ? ' You can connect again in Settings, under Your website.' : ''}`);
  }
}

