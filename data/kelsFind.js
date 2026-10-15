// kelsFind.js — the engine behind Kels's "Finding Something" (Kels roadmap §3.11,
// End-State guide §33). Pure: it takes candidates (places from the cheat sheet,
// data/kelsKnowledge.js; records, data/findRecords.js; her tasks) and the words
// she typed, and says which candidates she most likely means, and what to ask
// when there are too many. Nothing here reads the database or draws anything.
//
// A candidate: { id, group (what kind it is, said in a question: 'A dog'…),
//   title, sub? (a short line), where (the sentence that says where it is),
//   href? (a page, relative to pages/) | taskId?, boost? (a small tie-break),
//   levels: [level1, level2, level3] (each a list of texts, or [label, text]
//   pairs, where a label names the field: "her notes"),
//   numbers?: [registration or chip numbers, as normReg keys],
//   facets?: [{ key, question, value }] (how to split many of one kind) }.
//
// Levels (decided): 1 = names, numbers, a place's title and keywords; 2 =
// secondary details; 3 = deep (notes, a dog's events). A deeper level is used
// only when the levels above don't match every word she typed.
import { wordHit, normReg } from './dogSearch.js';

// Words that say nothing about what she wants.
export const STOP_WORDS = new Set(('a an and any are at be can could do does find for from get go help how i i\'m im in is it its ' +
  'look looking me my need of on or our please s see some that the their there them these this to want was ' +
  'were what whats where wheres which who will with you your').split(' '));

// Words that mean the same thing to her (stems, see `stem`). A word finds its group's others.
export const SYNONYM_GROUPS = [
  ['receipt', 'expense', 'spending', 'spent', 'cost', 'bill', 'purchase', 'bought'],
  ['invoice', 'receipt', 'bill'],
  ['money', 'income', 'earning', 'revenue', 'payment', 'paid', 'profit', 'finance', 'financial'],
  ['shot', 'vaccine', 'vaccination', 'vaccinated', 'immunization', 'rabie'],
  ['vet', 'veterinarian', 'veterinary', 'doctor', 'clinic'],
  ['paper', 'registration', 'pedigree', 'document', 'certificate', 'file'],
  ['puppy', 'pup'],
  ['buyer', 'family', 'client', 'customer', 'owner'],
  ['backup', 'restore', 'export', 'save'],
  ['heat', 'season', 'cycle'],
  ['breeding', 'pairing', 'mating', 'tie', 'bred'],
  ['litter', 'whelp', 'whelping', 'birth', 'born'],
  ['contract', 'agreement'],
  ['waitlist', 'reservation', 'application', 'applicant'],
  ['login', 'password', 'username', 'account'],
  ['chip', 'microchip'],
  ['weight', 'weigh', 'weighed', 'growth'],
  ['health', 'test', 'testing', 'ofa', 'genetic'],
  ['show', 'title', 'point', 'champion'],
  ['setting', 'preference', 'option'],
  ['report', 'summary', 'stat', 'statistic', 'chart'],
  ['calendar', 'schedule', 'upcoming', 'due'],
  ['photo', 'picture', 'logo', 'image'],
  ['import', 'upload', 'spreadsheet', 'csv'],
  ['sale', 'sold', 'sell', 'placement', 'placed'],
  ['reminder', 'todo', 'task'],
  ['female', 'girl', 'bitch', 'dam'],
  ['male', 'boy', 'stud', 'sire']
];

// A word's plain form: lower case, accents gone, a plural or "'s" dropped.
export function stem(word) {
  let w = String(word || '').toLowerCase();
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(ch|sh|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return w;
}

const tokens = (text) => String(text ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/['’]s\b/g, '').split(/[^a-z0-9]+/).filter(Boolean);

const SYNONYMS = new Map();
for (const g of SYNONYM_GROUPS) for (const w of g) SYNONYMS.set(w, new Set([...(SYNONYMS.get(w) || []), ...g.filter((x) => x !== w)]));

// What she typed, as the words to look for: [{ word, stem, syns }]. Little
// words are dropped, unless that would leave nothing.
export function queryWords(text) {
  // "show" is a dog show, unless it's "show me".
  const all = tokens(text).filter((w, i, ws) => !(w === 'show' && ws[i + 1] === 'me'));
  const kept = all.filter((w) => !STOP_WORDS.has(w));
  const seen = new Set();
  return (kept.length ? kept : all).filter((w) => !seen.has(w) && seen.add(w))
    .map((w) => ({ word: w, stem: stem(w), syns: SYNONYMS.get(stem(w)) || new Set() }));
}

// How well one typed word fits one word of a candidate: the same word, the
// start of one ("rec" → "receipts"), a slip or sound-alike, a synonym, or 0.
// `reach`: 0 = the word itself (or its start) only, 1 = synonyms too,
// 2 = slips and sound-alikes too.
export function wordScore(q, w, reach = 2) {
  if (w === q.stem) return 3;
  if (q.stem.length >= 3 && w.startsWith(q.stem)) return 2.5;
  if (reach >= 1 && q.syns.has(w)) return 1.5;
  if (reach >= 2 && Math.min(q.stem.length, w.length) >= 3 && wordHit(q.stem, w)) return 1.2;
  return 0;
}

const LEVEL_WEIGHT = [1, 0.8, 0.6];

// A candidate's words per level, worked out once: [[{ w, label }]].
function indexOf(c) {
  if (!c._index) {
    c._index = (c.levels || []).slice(0, 3).map((texts) => {
      const out = new Map();
      for (const t of texts || []) {
        const [label, text] = Array.isArray(t) ? t : [null, t];
        for (const w of tokens(text)) { const s = stem(w); if (!out.has(s)) out.set(s, label); }
      }
      return [...out].map(([w, label]) => ({ w, label }));
    });
    c._title = new Set(tokens(c.title).map(stem));
  }
  return c._index;
}

// Every candidate scored at one level (that level and the ones above it).
function scoreAt(candidates, qs, level, typedNumber, reach) {
  const hits = [];
  for (const c of candidates) {
    const idx = indexOf(c);
    let matched = 0;
    let score = 0;
    let why = null;
    let deepest = 0;
    for (const q of qs) {
      let best = 0;
      let bestLevel = 0;
      let bestLabel = null;
      for (let l = 0; l < level && l < idx.length; l++) {
        for (const { w, label } of idx[l]) {
          // A word in its title counts a little more than one in its keywords.
          const ws = wordScore(q, w, reach);
          const s = ws * LEVEL_WEIGHT[l] + (l === 0 && ws && c._title.has(w) ? 0.5 : 0);
          if (s > best) { best = s; bestLevel = l + 1; bestLabel = label; }
        }
      }
      if (best > 0) {
        matched++;
        score += best;
        if (bestLevel > deepest) { deepest = bestLevel; why = bestLabel; } else if (bestLevel === deepest && !why) why = bestLabel;
      }
    }
    // A registration or chip number typed any way she likes ("SR 123456/01").
    if (typedNumber && (c.numbers || []).includes(typedNumber)) { matched = qs.length; score = 3 * qs.length; deepest = 1; why = null; }
    if (matched) hits.push({ c, matched, score: score + (c.boost || 0), level: deepest, why: deepest > 1 ? why : null });
  }
  // On a tie, the shorter title is the nearer fit ("Litters" before "Litter P&L").
  return hits.sort((a, b) => b.matched - a.matched || b.score - a.score || a.c._title.size - b.c._title.size
    || String(a.c.title).localeCompare(String(b.c.title)));
}

// The passes, surest first: her words themselves at each level, then with
// synonyms, then with slips. So a typo near a place's keyword ("rabies" /
// "babies") never hides the word itself in a dog's history, and "receipts"
// finds where receipts are, not everything about expenses.
const PASSES = [0, 1, 2].flatMap((reach) => [1, 2, 3].map((level) => [level, reach]));

// The search. Returns { words (what was looked for), level (1–3, the level used),
// hits ([{ c, matched, score, level, why }], only those matching the most words),
// unmatched (typed words nothing matched), deeper (a deeper level has more) }.
// `level` forces a level (Look deeper).
export function search(candidates, text, { level = null } = {}) {
  const qs = queryWords(text);
  if (!qs.length) return { words: [], level: 0, hits: [], unmatched: [], deeper: false };
  const num = normReg(text);
  const typedNumber = /\d/.test(num) && num.length >= 5 ? num : null;
  const passes = PASSES.map(([l, fz]) => scoreAt(candidates, qs, l, typedNumber, fz));
  const top = (hits) => hits[0]?.matched || 0;
  let pass;
  if (level) pass = PASSES.findIndex(([l, re]) => l === level && re === 2);
  else {
    pass = passes.findIndex((h) => top(h) === qs.length);
    if (pass < 0) {
      const best = Math.max(...passes.map(top));
      pass = passes.findIndex((h) => top(h) === best);
    }
  }
  const [use, reach] = PASSES[pass];
  const all = passes[pass];
  const hits = all.filter((h) => h.matched === top(all));
  const found = new Set();
  for (const h of hits) {
    const idx = indexOf(h.c);
    for (const q of qs) if (idx.slice(0, use).some((ws) => ws.some(({ w }) => wordScore(q, w, reach) > 0))) found.add(q.word);
  }
  const shown = new Set(hits.map((h) => h.c.id));
  const deeper = use < 3 && passes[PASSES.length - 1].some((h) => !shown.has(h.c.id));
  return { words: qs.map((q) => q.word), level: use, hits, unmatched: hits.length ? qs.map((q) => q.word).filter((w) => !found.has(w)) : qs.map((q) => q.word), deeper };
}

// Look deeper: the next level's hits that weren't shown already.
export function deeperHits(candidates, text, result) {
  const next = search(candidates, text, { level: 3 });
  const shown = new Set(result.hits.map((h) => h.c.id));
  return { ...next, hits: next.hits.filter((h) => !shown.has(h.c.id)), deeper: false };
}

// One hit she most likely means: the only one, or well ahead of the next.
export function clearWinner(hits) {
  if (hits.length === 1) return hits[0];
  if (hits.length > 1 && hits[0].score >= hits[1].score + 1.5 && hits[0].score >= hits[1].score * 1.5) return hits[0];
  return null;
}

export const SHORT_LIST = 4;

// What to ask when there are more than SHORT_LIST hits: { key, question,
// options: [{ label, hits }] } or null (nothing splits them, or few enough).
// First which kind, then the kind's own facets in order; `asked` = keys already asked.
export function narrow(hits, asked = new Set()) {
  if (hits.length <= SHORT_LIST) return null;
  const split = (keyOf) => {
    const groups = new Map();
    for (const h of hits) {
      const k = keyOf(h);
      if (k == null || k === '') continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(h);
    }
    return groups;
  };
  if (!asked.has('group')) {
    const g = split((h) => h.c.group);
    if (g.size > 1) return { key: 'group', question: 'Which are you looking for?', options: [...g].map(([label, hs]) => ({ label, hits: hs })) };
  }
  const keys = [];
  for (const h of hits) for (const f of h.c.facets || []) if (!keys.some((k) => k.key === f.key)) keys.push(f);
  for (const { key, question } of keys) {
    if (asked.has(key)) continue;
    const g = split((h) => (h.c.facets || []).find((f) => f.key === key)?.value);
    if (g.size < 2) continue;
    const options = [...g].sort((a, b) => b[1].length - a[1].length).map(([label, hs]) => ({ label, hits: hs }));
    return { key, question, options };
  }
  return null;
}
