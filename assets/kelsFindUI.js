// kelsFindUI.js — Kels's "Finding Something" (Kels roadmap §3.11, End-State
// guide §33), as a chat on pages/kels.html. She asks what the breeder is looking
// for, searches the cheat sheet (data/kelsKnowledge.js), her records
// (data/findRecords.js) and her tasks with data/kelsFind.js, asks a question or
// two when there are too many, then says where it is with a button that opens
// it (or starts the task). "<a dog> <a word about it>" ("Zeus puppies") goes to
// data/kelsAbout.js first: what the dog has, and which of it she means. Reads
// only, through the repos; nothing leaves the device.
import { search, deeperHits, clearWinner, narrow, SHORT_LIST } from '../data/kelsFind.js';
import { placeCandidates } from '../data/kelsKnowledge.js';
import { recordCandidates } from '../data/findRecords.js';
import { aboutDog, factsSentence, topicResults, topicByKey, addCandidate } from '../data/kelsAbout.js';
import { dogName } from '../data/dogRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import { expenseRepo } from '../data/expenseRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { eventRepo } from '../data/eventRepo.js';
import { resolveKennelIdForWrite } from '../data/kennelScope.js';
import { edition, editionFlags, navItems, moreItems } from '../data/editionConfig.js';
import { esc, fmtDate } from './ui.js';
import { KELS_FIND_INTRO } from './kelsChat.js';

// What she offers when nothing matches: the places most people are after
// (cheat-sheet ids), each only where this edition has it.
const COMMON = [
  ['place:dogs', 'View your dogs'],
  ['place:litters', 'Manage your litters'],
  ['place:financials', 'See your finances'],
  ['place:contacts', 'See your contacts'],
  ['place:companion', 'Sharing your pups']
];

const nav = (path) => [...navItems, ...moreItems].find((i) => i.path === path)?.label || 'the menu';

// Everything she can find, loaded once per visit: { candidates, rows }.
// `tasks`: her task candidates (pages/kels.js). Contacts are loaded in every
// edition for a sale's buyer name and a dog's vet (expenses for its vet costs); they're candidates only where contactsSection.
async function loadCandidates(tasks) {
  const flags = editionFlags;
  const [dogs, litters, contacts, kennels, events, sales, expenses, kennelId] = await Promise.all([
    dogRepo.getAll({ includeArchived: true, includePedigreeOnly: true }),
    litterRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true }),
    kennelRepo.getAll({ includeArchived: true }),
    eventRepo.getAll(),
    saleRepo.getAll({ includeArchived: true }),
    expenseRepo.getAll({ includeArchived: false }),
    resolveKennelIdForWrite().catch(() => null)
  ]);
  const candidates = [
    ...placeCandidates({ edition, flags, nav, kennelId }),
    ...recordCandidates({ dogs, litters, contacts, kennels, events }, flags),
    ...tasks
  ];
  return { candidates, rows: { dogs, litters, contacts, sales, events, expenses } };
}

// Where a deep word was found, in her words: "its notes", "Vaccination, Mar 1, 2026".
const whyText = (why) => (why ? why.replace(/ ?(\d{4}-\d{2}-\d{2})/, (m, d) => `, ${fmtDate(d)}`) : '');
const foundIn = (h, words) => (h.why ? ` I found "${esc(words.join(' '))}" in ${h.why === 'notes' ? 'the notes' : esc(whyText(h.why))}.` : '');

export async function runFindTask(chat, { onExit = () => {}, handoff = null, tasks = [] } = {}) {
  if (!(await chat.intro('Absolutely!', KELS_FIND_INTRO))) return onExit('nevermind');
  let candidates = null;
  let rows = null;
  let prompt = '<strong>What are you looking for?</strong><span class="kels-lead">A word or two is plenty: a dog\'s name, "receipts", "contracts"…</span>';
  for (;;) {
    const res = await chat.form({
      title: prompt,
      html: '<div class="field gl-field"><input id="kf-q" type="search" autocomplete="off" enterkeyhint="search" aria-label="What are you looking for?"></div>',
      wire: (root) => root.querySelector('#kf-q').focus(),
      submitLabel: 'Find it', cancelLabel: 'Never mind',
      // form() shows a returned string as a problem, so the words go back as { q }.
      submit: async (root) => { const q = root.querySelector('#kf-q').value.trim(); return q ? { q } : 'Type a word or two, and I\'ll look.'; },
      reply: (r) => r.q
    });
    if (!res.done) return onExit('nevermind');
    const { q } = res.result;
    if (!candidates) ({ candidates, rows } = await loadCandidates(tasks));
    const r = search(candidates, q);
    const about = aboutDog(q, rows, { flags: editionFlags });
    if (about) {
      const out = await aboutOffer(chat, about, r, { q, candidates, rows, handoff });
      if (out === 'left' || out === 'task') return undefined;
      if (out === 'done') return onExit('done');
      prompt = '<strong>What else are you looking for?</strong>';
      continue;
    }
    if (!r.hits.length) {
      const out = await noMatch(chat, q, candidates);
      if (out === 'left') return undefined;
      if (out === 'done') return onExit('done');
      prompt = '<strong>What should I look for?</strong><span class="kels-lead">A name works, or a word like "litters", "receipts" or "backup".</span>';
      continue;
    }
    if (r.unmatched.length) await chat.say(`I didn't find anything for "${esc(r.unmatched.join(' '))}", so I looked for the rest.`, { typing: 500 });
    const out = await offer(chat, r, { q, candidates, handoff });
    if (out === 'left' || out === 'task') return undefined;
    if (out === 'done') return onExit('done');
    prompt = '<strong>What else are you looking for?</strong>';
  }
}

// Nothing matched: a few common places, or a new search.
async function noMatch(chat, q, candidates) {
  const common = COMMON.map(([id, label]) => [candidates.find((c) => c.id === id), label]).filter(([c]) => c);
  await chat.say(`I couldn't find anything for "${esc(q)}". Here are a couple of things people often look for. If none of them are right, feel free to give me new words and I'll search again!`, { typing: 700 });
  const pick = await chat.choose([
    ...common.map(([c, label]) => ({ label, sub: c.where, value: c.id })),
    { label: 'Try new words', value: 'again', primary: true },
    { label: 'I\'m all set', value: 'done' }
  ], { stagger: 100, confirmHint: 'Tap again to go there' });
  if (pick === 'again' || pick === 'done') return pick;
  return go(chat, candidates.find((c) => c.id === pick));
}

// From the hits to one she picks: a question or two, then one answer or a short list.
async function offer(chat, r, { q, candidates, handoff, extras = [] }) {
  let hits = r.hits;
  const asked = new Set();
  // Something to offer first (adding one, "Zeus shots"): straight to the list, with it on top.
  const lead = extras.some((c) => c.first);
  // A question only when there's no clear answer already.
  for (let i = 0; i < 2 && !lead && !clearWinner(hits); i++) {
    const n = narrow(hits, asked);
    if (!n) break;
    asked.add(n.key);
    await chat.say(`I found ${hits.length} things. <strong>${esc(n.question)}</strong>`, { typing: 600 });
    const pick = await chat.choose([
      ...n.options.map((o, j) => ({ label: `${o.label} (${o.hits.length})`, value: String(j) })),
      { label: 'Show me all of them', value: 'all' }
    ], { stagger: 100 });
    if (pick === 'all') break;
    hits = n.options[Number(pick)].hits;
  }

  const one = lead ? null : clearWinner(hits);
  if (one) {
    const c = one.c;
    await chat.say(`Found it! <strong>${esc(c.title)}</strong>${c.sub ? ` <span class="muted">(${esc(c.sub)})</span>` : ''}. ${esc(c.where)}${foundIn(one, r.words)}`, { typing: 700 });
    const pick = await chat.choose([
      { label: c.taskId ? 'Let\'s do it' : 'Take me there', value: 'go', primary: true },
      ...(hits.length > 1 || r.deeper || extras.length ? [{ label: 'Not it', value: 'not' }] : []),
      { label: 'Find something else', value: 'again' },
      { label: 'I\'m all set', value: 'done' }
    ]);
    if (pick === 'go') return go(chat, c, handoff);
    if (pick !== 'not') return pick;
    hits = hits.filter((h) => h !== one);
  }
  return list(chat, hits, { r, q, candidates, handoff, extras });
}

// The short list: "Do you want…", four at a time; each opens its where on the first tap.
// `extras`: places offered with every page of the list ("All of Zeus's puppies"
// under it; `first` ones, like "Add a shot for JJ", above it, the first chosen).
async function list(chat, hits, { r, q, candidates, handoff, extras = [] }) {
  let from = 0;
  let deeper = r.deeper;
  for (;;) {
    const page = hits.slice(from, from + SHORT_LIST);
    if (!page.length) {
      await chat.say(deeper ? 'That\'s all the close matches.' : 'That\'s everything I found.', { typing: 400 });
    } else {
      await chat.say(from ? 'Here are some more. <strong>Do you want…</strong>' : '<strong>Do you want…</strong>', { typing: 500 });
    }
    const pick = await chat.choose([
      ...extras.map((c, i) => [c, i]).filter(([c]) => c.first).map(([c, i], j) => ({ label: c.title, sub: c.where, value: `extra:${i}`, primary: j === 0 })),
      ...page.map((h, i) => ({
        label: h.c.title,
        sub: [h.c.sub, h.c.where, h.why ? `Found in ${h.why === 'notes' ? 'the notes' : whyText(h.why)}.` : ''].filter(Boolean).join(' · '),
        value: `hit:${from + i}`, primary: i === 0 && !from && !extras.some((c) => c.first)
      })),
      ...extras.map((c, i) => [c, i]).filter(([c]) => !c.first).map(([c, i]) => ({ label: c.title, sub: c.where, value: `extra:${i}` })),
      ...(hits.length > from + SHORT_LIST ? [{ label: 'Show more', value: 'more' }] : []),
      ...(deeper ? [{ label: 'Look deeper', value: 'deeper' }] : []),
      { label: 'Find something else', value: 'again' },
      { label: 'I\'m all set', value: 'done' }
    ], { stagger: 100, confirmHint: 'Tap again to go there' });
    if (pick.startsWith('hit:')) return go(chat, hits[Number(pick.slice(4))].c, handoff);
    if (pick.startsWith('extra:')) return go(chat, extras[Number(pick.slice(6))], handoff);
    if (pick === 'more') { from += SHORT_LIST; continue; }
    if (pick === 'deeper') {
      const more = deeperHits(candidates, q, { ...r, hits });
      deeper = false;
      if (!more.hits.length) { await chat.say('I looked through notes and history too, and there\'s nothing more.', { typing: 600 }); continue; }
      await chat.say(`I looked through notes and history too, and found ${more.hits.length === 1 ? 'one more' : `${more.hits.length} more`}.`, { typing: 700 });
      hits = more.hits;
      r = { ...r, words: more.words };
      from = 0;
      continue;
    }
    return pick;
  }
}

// "Zeus puppies": which Zeus (when two dogs answer to it), what Zeus has, and
// which of it she means. A question only when two or more topics have something
// (decided); one goes straight to its results; none says so. "Something else"
// is the ordinary search, `r`.
async function aboutOffer(chat, about, r, { q, candidates, rows, handoff }) {
  let pick = about.dogs[0];
  const withData = about.dogs.filter((d) => d.offered.length);
  if (withData.length > 1) {
    await chat.say(`I know more than one dog by that name. <strong>Which one?</strong>`, { typing: 500 });
    const v = await chat.choose([
      ...withData.map((d, i) => ({ label: dogName(d.dog) || 'Unnamed dog', note: factsSentence(d.dog, d.facts), value: String(i) })),
      { label: 'Something else', value: 'else' }
    ], { stagger: 100 });
    if (v === 'else') return offer(chat, r, { q, candidates, handoff });
    pick = withData[Number(v)];
  } else if (withData.length) pick = withData[0];
  const { dog, facts, offered } = pick;
  const name = esc(dogName(dog) || 'This dog');
  const facts1 = esc(factsSentence(dog, facts, { topics: about.topics }));
  const factsAfter = esc(factsSentence(dog, facts, { pronoun: true, topics: offered }));
  // Adding one, for the topics she named that can ("Add a shot for JJ").
  const adds = about.topics.map((k) => addCandidate(k, dog)).filter(Boolean);
  const addChoices = adds.map((c, i) => ({ label: c.title, value: `add:${i}`, primary: i === 0 }));
  const seeChoices = (keys) => keys.map((k) => { const t = topicByKey(k); return { label: t.label(dogName(dog) || 'this dog'), note: t.sub(facts), value: k }; });
  const nav = { flags: editionFlags, edition };
  const show = async (key, lead) => {
    const { hits, extras } = topicResults(key, dog, facts, rows, nav);
    if (lead) await chat.say(lead, { typing: 600 });
    return offer(chat, { words: about.words, level: 1, hits, unmatched: [], deeper: false }, { q, candidates, handoff, extras });
  };

  // "Log JJ's shot": adding comes first; what's on record is a tap away.
  if (about.add && adds.length) {
    await chat.say(`Let's add it.${facts1 ? ` For reference: ${facts1}` : ''} <strong>What would you like to do?</strong>`, { typing: 600 });
    const v = await chat.choose([
      ...addChoices,
      ...seeChoices(offered.filter((k) => topicByKey(k).add)).map((c) => ({ ...c, label: `See ${c.label}` })),
      { label: 'Something else', value: 'else' }
    ], { stagger: 100 });
    if (v.startsWith('add:')) return go(chat, adds[Number(v.slice(4))], handoff);
    if (v === 'else') return offer(chat, r, { q, candidates, handoff });
    return show(v, null);
  }

  if (!offered.length) {
    const nouns = about.topics.map((k) => topicByKey(k).noun);
    const said = nouns.length > 1 ? `${nouns.slice(0, -1).join(', ')} or ${nouns.at(-1)}` : nouns[0];
    await chat.say(`${name} doesn't have any ${esc(said)} on record yet.`, { typing: 600 });
    const v = await chat.choose([
      ...addChoices,
      { label: `Open ${dogName(dog) || 'the dog'}'s page`, value: 'dog', primary: !adds.length },
      ...(r.hits.length ? [{ label: 'Something else', value: 'else' }] : []),
      { label: 'Find something else', value: 'again' },
      { label: 'I\'m all set', value: 'done' }
    ]);
    if (v.startsWith('add:')) return go(chat, adds[Number(v.slice(4))], handoff);
    if (v === 'dog') return go(chat, { title: dogName(dog) || 'the dog', href: `dog.html?id=${encodeURIComponent(dog.id)}` }, handoff);
    if (v === 'else') return offer(chat, r, { q, candidates, handoff });
    return v;
  }
  if (offered.length === 1) return show(offered[0], facts1 || null);

  await chat.say(`I found a lot about ${name}. ${factsAfter} <strong>${adds.length ? 'What would you like to do?' : 'What are you looking for?'}</strong>`, { typing: 700 });
  const v = await chat.choose([
    ...seeChoices(offered),
    ...addChoices.map((c) => ({ ...c, primary: false })),
    { label: 'Something else', value: 'else' }
  ], { stagger: 100 });
  if (v.startsWith('add:')) return go(chat, adds[Number(v.slice(4))], handoff);
  if (v === 'else') return offer(chat, r, { q, candidates, handoff });
  return show(v, null);
}

async function go(chat, c, handoff) {
  if (c.taskId && handoff) { await handoff(c.taskId); return 'task'; }
  await chat.say(`Taking you to <strong>${esc(c.title)}</strong>…`, { typing: 300 });
  location.assign(c.href);
  return 'left';
}
