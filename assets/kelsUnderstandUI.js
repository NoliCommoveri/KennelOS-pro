// kelsUnderstandUI.js — Kels's "Understanding Something" (Kels roadmap §3.14,
// End-State guide §33), as a chat on pages/kels.html. Two halves (decided): how
// KennelOS works, an FAQ in every edition, and how her business is doing, from her
// reports (Pro, editionFlags.reports: assets/kelsInsightsUI.js, imported on pick). With more than one half on offer she asks which
// first ("Which is your question about?"); with one, it starts straight away.
// Each half has its own intro, said the first time she picks it.
//
// How KennelOS works: she offers the topics (data/kelsUnderstand.js SECTIONS) and
// a search over the questions only (data/kelsFind.js), then answers one in a few
// plain sentences, with a Show me button where it lives. Reads nothing from her
// records and changes nothing.
import { understandEntries, understandSections, understandCandidates } from '../data/kelsUnderstand.js';
import { search, clearWinner, SHORT_LIST } from '../data/kelsFind.js';
import { isCloudAvailable, isVaultOffered, isWaitlistOnlineOffered } from '../data/cloud/cloudConfig.js';
import { edition, editionFlags } from '../data/editionConfig.js';
import { esc } from './ui.js';
import { KELS_UNDERSTAND_INTRO } from './kelsChat.js';

// The halves, in the order she offers them: { id, label, opener, how, flag?, run }.
// `run(chat, { branched })` → 'left' | 'done' | 'branch' (back to the question).
// How my business is doing is Pro (its script and the reports it reads are Pro-only),
// so its intro and script load only when it's picked.
const businessHalf = () => import('./kelsInsightsUI.js');
const HALVES = [
  { id: 'app', label: 'How KennelOS works', opener: 'I\'m on it!', how: KELS_UNDERSTAND_INTRO, run: (chat, o) => appFaq(chat, o) },
  { id: 'business', label: 'How my business is doing', opener: 'Ready when you are!', how: async () => (await businessHalf()).KELS_BUSINESS_INTRO,
    flag: 'reports', run: async (chat, o) => (await businessHalf()).businessCheckup(chat, o) }
];

export async function runUnderstandTask(chat, { onExit = () => {} } = {}) {
  const halves = HALVES.filter((h) => !h.flag || editionFlags[h.flag]);
  const branched = halves.length > 1;
  const introduced = new Set();
  for (;;) {
    let half = halves[0];
    if (branched) {
      await chat.say(introduced.size ? '<strong>What else would you like to understand?</strong>' : 'Yes, absolutely! <strong>Which is your question about?</strong>', { typing: 500 });
      const v = await chat.choose([
        ...halves.map((h, i) => ({ label: h.label, value: h.id, primary: i === 0 })),
        ...(introduced.size ? [{ label: 'I\'m all set', value: 'done' }] : [])
      ], { stagger: 100 });
      if (v === 'done') return onExit('done');
      half = halves.find((h) => h.id === v);
    }
    if (!introduced.has(half.id)) {
      const how = typeof half.how === 'function' ? await half.how() : half.how;
      if (!(await chat.intro(half.opener, how))) return onExit('nevermind');
      introduced.add(half.id);
    }
    const out = await half.run(chat, { branched });
    if (out === 'left') return undefined;
    if (out === 'done') return onExit('done');
  }
}

// How KennelOS works: the topics and the search, until she's done. Something else
// after an answer goes back to the question when there is one, else to the topics.
async function appFaq(chat, { branched }) {
  const entries = understandEntries({ edition, flags: editionFlags, cloud: isCloudAvailable(), vault: isVaultOffered(), online: isWaitlistOnlineOffered() });
  const sections = understandSections(entries, editionFlags);
  const candidates = understandCandidates(entries, editionFlags);
  let ask = '<strong>What would you like to understand?</strong> Pick a topic, or search the questions.';
  for (;;) {
    await chat.say(ask, { typing: 500 });
    const pick = await chat.choose([
      { label: 'Search the questions', value: 'search', primary: true },
      ...sections.map((s) => ({ label: s.label, value: `section:${s.id}` })),
      ...(branched ? [{ label: 'Something else', value: 'else' }] : []),
      { label: 'I\'m all set', value: 'done' }
    ], { stagger: 100 });
    if (pick === 'done') return 'done';
    if (pick === 'else') return 'branch';
    const out = pick === 'search' ? await searchQuestions(chat, candidates, sections)
      : await sectionQuestions(chat, sections.find((s) => `section:${s.id}` === pick), sections);
    if (out === 'left' || out === 'done') return out;
    if (out === 'else' && branched) return 'branch';
    ask = '<strong>What else would you like to understand?</strong>';
  }
}

// One topic's questions.
async function sectionQuestions(chat, section, sections) {
  await chat.say(`Here's what people ask about <strong>${esc(section.label.toLowerCase())}</strong>.`, { typing: 400 });
  const v = await chat.choose([
    ...section.entries.map((e) => ({ label: e.q, value: e.id })),
    { label: 'Back to the topics', value: 'top' }
  ], { stagger: 80 });
  if (v === 'top') return 'top';
  return answer(chat, section.entries.find((e) => e.id === v), sections);
}

// Her words against the questions (and then their answers); one clear match is
// answered, else a short list, four at a time.
async function searchQuestions(chat, candidates, sections) {
  let prompt = '<strong>What do you want to know?</strong><span class="kels-lead">A question or a word or two: "income", "why is this family fourth", "archive".</span>';
  for (;;) {
    const res = await chat.form({
      title: prompt,
      html: '<div class="field gl-field"><input id="ku-q" type="search" autocomplete="off" enterkeyhint="search" aria-label="What do you want to know?"></div>',
      wire: (root) => root.querySelector('#ku-q').focus(),
      submitLabel: 'Search', cancelLabel: 'Back to the topics',
      submit: async (root) => { const q = root.querySelector('#ku-q').value.trim(); return q ? { q } : 'Type a word or two, and I\'ll look.'; },
      reply: (r) => r.q
    });
    if (!res.done) return 'top';
    const { q } = res.result;
    const r = search(candidates, q);
    if (!r.hits.length) {
      await chat.say(`I don't have a question about "${esc(q)}" yet. Try other words, or look through the topics.`, { typing: 600 });
      const v = await chat.choose([
        { label: 'Try other words', value: 'again', primary: true },
        { label: 'Back to the topics', value: 'top' }
      ]);
      if (v === 'top') return 'top';
      prompt = '<strong>What should I look for?</strong>';
      continue;
    }
    const one = clearWinner(r.hits);
    const out = one ? await answer(chat, one.c.entry, sections) : await list(chat, r.hits.map((h) => h.c.entry), sections);
    if (out !== 'again') return out;
    prompt = '<strong>What else do you want to know?</strong>';
  }
}

async function list(chat, found, sections) {
  let from = 0;
  for (;;) {
    const page = found.slice(from, from + SHORT_LIST);
    await chat.say(from ? 'Here are some more. <strong>Is it one of these?</strong>' : '<strong>Is it one of these?</strong>', { typing: 500 });
    const v = await chat.choose([
      ...page.map((e, i) => ({ label: e.q, value: `q:${from + i}`, primary: i === 0 && !from })),
      ...(found.length > from + SHORT_LIST ? [{ label: 'Show more', value: 'more' }] : []),
      { label: 'Search again', value: 'again' },
      { label: 'Back to the topics', value: 'top' }
    ], { stagger: 80 });
    if (v === 'more') { from += SHORT_LIST; continue; }
    if (!v.startsWith('q:')) return v;
    return answer(chat, found[Number(v.slice(2))], sections);
  }
}

// The answer, then where next: Show me, the rest of its topic, something else, or
// done. → 'left' | 'done' | 'else'.
async function answer(chat, entry, sections) {
  const section = sections.find((s) => s.id === entry.section);
  await chat.say(`<strong>${esc(entry.q)}</strong><br>${esc(entry.a)}`, { typing: 800 });
  const v = await chat.choose([
    ...(entry.href ? [{ label: entry.show || 'Show me', value: 'show', primary: true }] : []),
    ...(section.entries.length > 1 ? [{ label: `More about ${section.label.toLowerCase()}`, value: 'section' }] : []),
    { label: 'Something else', value: 'else', primary: !entry.href },
    { label: 'I\'m all set', value: 'done' }
  ]);
  if (v === 'show') {
    await chat.say('Taking you there…', { typing: 300 });
    location.assign(entry.href);
    return 'left';
  }
  if (v === 'section') return sectionQuestions(chat, section, sections);
  return v;
}
