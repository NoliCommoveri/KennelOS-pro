// kelsInsightsUI.js — Kels's "How my business is doing" (Kels roadmap §3.14 B,
// End-State guide §33), the second half of Understanding Something. Pro-only
// (editionFlags.reports; proPages.js): kelsUnderstandUI imports it when she picks it.
//
// She asks what about (data/kennelInsights.js insightTopics) and for when (this
// year, the last 12 months, last year, all time), loads the reports that topic reads
// (data/reportSources.js), and says the most telling few sentences
// (kennelInsights.insightsFor), with Tell me more for the rest and a button to each
// report she quoted, opened on the same range. Read-only: nothing is changed.
import * as sources from '../data/reportSources.js';
import { insightTopics, topicSources, insightsFor, nothingText, FIRST_SHOWN } from '../data/kennelInsights.js';
import { rangeFor, rangeWords } from '../data/reportMath.js';
import { todayYMD } from '../data/dateUtils.js';
import { editionFlags } from '../data/editionConfig.js';
import { esc } from './ui.js';

// Her intro, said the first time she picks this half (the roadmap's wording, less
// the comparison with last year, which comes later).
export const KELS_BUSINESS_INTRO = 'I can tell you how your business is doing, like who your most productive dam is or how your money did this year. Pick what you\'d like to know about and for what dates, and I\'ll sum it up in plain words. Every number comes straight from your reports, so I\'ll always show you which one. Sound good?';

const RANGES = [
  { value: 'this_year', label: 'This year' },
  { value: 'last_12', label: 'The last 12 months' },
  { value: 'last_year', label: 'Last year' },
  { value: 'all', label: 'All time' }
];

// Her first line for a topic's answer: what it is, and a warm word.
const LEAD = {
  dogs: (w) => `Here's how your dogs are doing ${w}. They're lucky to have you!`,
  money: (w) => `Here's your money ${w}. Nice work keeping track!`,
  litters: (w) => `Here are your litters and pups ${w}. What a busy whelping box!`,
  sales: (w) => `Here's how your ${editionFlags.waitlist ? 'sales and waitlist are' : 'sales are'} going ${w}. Families are lucky to find you!`,
  shows: (w) => `Here's ${editionFlags.shows ? 'the show ring' : 'stud work'} ${w}. Go team!`,
  all: (w) => `Here's the whole picture ${w}. You've built something special!`
};

// → 'left' (she went to a report) | 'done' | 'branch' (Something else).
export async function businessCheckup(chat, { branched = false } = {}) {
  const topics = insightTopics(editionFlags);
  let ask = '<strong>What would you like to know about?</strong>';
  for (;;) {
    await chat.say(ask, { typing: 500 });
    const topicId = await chat.choose([
      ...topics.map((t, i) => ({ label: t.label, value: t.id, primary: i === 0 })),
      ...(branched ? [{ label: 'Something else', value: 'else' }] : []),
      { label: 'I\'m all set', value: 'done' }
    ], { stagger: 80 });
    if (topicId === 'done') return 'done';
    if (topicId === 'else') return 'branch';
    const topic = topics.find((t) => t.id === topicId);
    await chat.say('<strong>For when?</strong>', { typing: 400 });
    let preset = await chat.choose(RANGES.map((r, i) => ({ ...r, primary: i === 0 })), { stagger: 60 });
    for (;;) {
      const out = await tell(chat, topic, preset, branched);
      if (out === 'all') { preset = 'all'; continue; }
      if (out === 'dates') {
        await chat.say('<strong>For when, then?</strong>', { typing: 300 });
        preset = await chat.choose(RANGES.filter((r) => r.value !== preset).map((r, i) => ({ ...r, primary: i === 0 })), { stagger: 60 });
        continue;
      }
      if (out !== 'topic') return out;
      break;
    }
    ask = '<strong>What else would you like to know about?</strong>';
  }
}

// One topic for one range: the sentences, a few at a time, then where next.
// → 'left' | 'done' | 'branch' | 'topic' | 'dates' | 'all'.
async function tell(chat, topic, preset, branched) {
  const today = todayYMD();
  const range = rangeFor(preset, today);
  await chat.say('Let me look through your reports…', { typing: 300 });
  const names = topicSources(topic.id, editionFlags);
  const results = await Promise.all(names.map((n) => sources[`load${n}`](today)));
  const loaded = Object.fromEntries(names.map((n, i) => [n, results[i]]));
  const insights = insightsFor(topic.id, loaded, { preset, range, today, flags: editionFlags });

  if (!insights.length) {
    await chat.say(esc(nothingText(topic.label, preset)), { typing: 500 });
    const v = await chat.choose([
      ...(preset !== 'all' ? [{ label: 'Yes, all time', value: 'all', primary: true }] : []),
      { label: 'Another topic', value: 'topic', primary: preset === 'all' },
      ...(branched ? [{ label: 'Something else', value: 'branch' }] : []),
      { label: 'I\'m all set', value: 'done' }
    ]);
    return v;
  }

  let from = 0;
  for (;;) {
    const shown = insights.slice(from, from + FIRST_SHOWN);
    const lead = from ? 'Here\'s more.' : LEAD[topic.id](rangeWords(preset));
    await chat.say(`${esc(lead)}<ul class="kels-list">${shown.map((x) => `<li>${esc(x.text)}</li>`).join('')}</ul>`, { typing: 900 });
    from += shown.length;
    // A button to each report she quoted, on the same range.
    const reports = [...new Map(shown.filter((x) => x.source).map((x) => [x.source.href, x.source])).values()];
    const v = await chat.choose([
      ...(from < insights.length ? [{ label: 'Tell me more', value: 'more', primary: true }] : []),
      ...reports.map((s) => ({ label: `See ${s.title}`, value: `report:${s.href}` })),
      { label: 'Another topic', value: 'topic', primary: from >= insights.length },
      { label: 'Different dates', value: 'dates' },
      ...(branched ? [{ label: 'Something else', value: 'branch' }] : []),
      { label: 'I\'m all set', value: 'done' }
    ], { stagger: 60 });
    if (v === 'more') continue;
    if (v.startsWith('report:')) {
      const s = reports.find((r) => `report:${r.href}` === v);
      await chat.say(`Opening ${esc(s.title)}…`, { typing: 300 });
      location.assign(reportHref(s));
      return 'left';
    }
    return v;
  }
}

// The report's page (pages/), on her range when the report has one.
function reportHref(s) {
  const base = location.pathname.includes('/pages/') ? '' : 'pages/';
  if (!s.range) return `${base}${s.href}`;
  return `${base}${s.href}${s.href.includes('?') ? '&' : '?'}range=${encodeURIComponent(s.range)}`;
}
