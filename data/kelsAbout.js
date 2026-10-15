// kelsAbout.js — "Zeus puppies": a dog named, plus a word about it, for Kels's
// "Finding Something" (End-State guide §33). Pure: takes the rows (loaded by the
// caller through the repos) and what she typed; says which dog she means, what
// it has on record for those words (its puppies, its litters, what its puppies
// sold for), the sentence Kels opens with, and each topic's results as Find
// candidates (data/kelsFind.js). Reads and writes nothing.
//
// Kels asks which topic only when two or more of them have something behind
// them (decided): one goes straight to its results, none says so. A topic with
// `add` (shots, vet) also offers adding one, first: "JJ shot" may well be "I just
// gave JJ a shot". With an add word ("log JJ's shot") she leads with it.
//
// Adding a topic: a line in DOG_TOPICS (its words, its choice label, what it
// counts and lists, `events` when it lists the dog's events) and its facts in
// `factsOf` / `factsSentence`.
import { queryWords, wordScore } from './kelsFind.js';
import { dogCandidates, litterCandidates } from './findRecords.js';
import { dogName } from './dogRepo.js';
import { litterLabel } from './litterCheckin.js';
import { SALE_STATUS, RELEASED_SALE_STATUSES, EVENT_TYPES, descriptor } from './vocab.js';
import { isProOnlyPage } from './proPages.js';
import { todayYMD } from './dateUtils.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (ymd) => { const [y, m, d] = String(ymd || '').split('-').map(Number); return y && m && d ? new Date(y, m - 1, d).toLocaleDateString(undefined, { dateStyle: 'medium' }) : ''; };
const typeLabel = (t) => descriptor(EVENT_TYPES, t)?.label || t;
const article = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
// An event's own words for what it was: the vaccine, the drug, the reason…
const WHAT_KEYS = ['vaccine', 'product', 'reason', 'diagnosis', 'drug', 'procedure', 'description'];
const whatOf = (e) => { const v = [...WHAT_KEYS.map((k) => e.details?.[k]), e.title !== typeLabel(e.event_type) ? e.title : null].find((x) => x != null && String(x).trim()); const s = v == null ? '' : String(v).trim(); return s.length > 40 ? `${s.slice(0, 39)}…` : s; };

// Words that mean she wants to add one, not find one.
export const ADD_WORDS = ['add', 'log', 'new', 'enter', 'gave', 'give', 'got', 'track'];
// Words that say nothing here: "JJ's last shot", "gave JJ her rabies", "Zeus shot history".
const FILLER = new Set(['her', 'his', 'him', 'he', 'she', 'last', 'latest', 'next', 'recent', 'all', 'just', 'today', 'yesterday', 'history', 'list']);
const money = (n) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: n % 1 ? 2 : 0 });

// The topics, in the order Kels offers them. `words`: stems she might type
// (synonyms from kelsFind's groups count too); "puppies" is all three.
export const DOG_TOPICS = [
  { key: 'pups', words: ['puppy', 'pup', 'offspring', 'baby', 'kid', 'child', 'progeny', 'son', 'daughter'],
    label: (n) => `One of ${n}'s puppies`, count: (f) => f.pups.length, sub: (f) => plural(f.pups.length, 'puppy', 'puppies'), noun: 'puppies' },
  { key: 'litters', words: ['litter', 'puppy', 'pup', 'bred', 'whelp', 'whelped', 'breeding'],
    label: (n) => `${n}'s litters`, count: (f) => f.litters.length, sub: (f) => plural(f.litters.length, 'litter'), noun: 'litters' },
  { key: 'sales', words: ['sale', 'sold', 'sell', 'money', 'earn', 'earned', 'earning', 'income', 'price', 'buyer', 'puppy', 'pup'],
    label: (n) => `What ${n}'s puppies sold for`, count: (f) => f.sales.length,
    sub: (f) => [f.sold ? `${f.sold} sold` : plural(f.sales.length, 'sale'), f.earned ? money(f.earned) : null].filter(Boolean).join(' · '), noun: 'sales' },
  { key: 'shots', words: ['shot', 'vaccine', 'vaccination', 'vaccinated', 'rabie', 'raby', 'dhpp', 'parvo', 'distemper', 'bordetella', 'lepto', 'leptospirosis', 'booster',
    'preventative', 'heartworm', 'flea', 'tick', 'deworm', 'dewormer', 'wormer', 'health', 'medical'],
    events: ['vaccination', 'preventative'], add: { type: 'vaccination', label: (n) => `Add a shot for ${n}` },
    label: (n) => `${n}'s shots`, count: (f) => f.shots.length,
    sub: (f) => [plural(f.shots.length, 'on record', 'on record'), f.due ? `${f.due.vaccine || 'next'} ${f.due.overdue ? 'overdue' : `due ${day(f.due.date)}`}` : null].filter(Boolean).join(' · '), noun: 'shots' },
  { key: 'vet', words: ['vet', 'veterinarian', 'doctor', 'clinic', 'visit', 'sick', 'illness', 'ill', 'medication', 'medicine', 'med', 'surgery', 'injury', 'hurt', 'health', 'medical'],
    events: ['vet_visit', 'illness', 'medication', 'surgery', 'injury'], add: { type: 'vet_visit', label: (n) => `Add a health event for ${n}` },
    label: (n) => `${n}'s vet visits and health events`, count: (f) => f.vet.length,
    sub: (f) => [plural(f.vet.length, 'on record', 'on record'), f.seen?.date ? `last seen ${day(f.seen.date)}` : null].filter(Boolean).join(' · '), noun: 'vet visits or health events' }
];

const hitsTopic = (q, t) => t.words.some((w) => wordScore(q, w, 1) > 0);
const nameStems = (d) => new Set([d.call_name, d.registered_name].flatMap((t) => (t ? queryWords(t).map((x) => x.stem) : [])));

// What a dog has on record: its puppies (sire or dam), its litters, its puppies' sales.
export function factsOf(dog, { dogs = [], litters = [], sales = [], events = [], contacts = [], expenses = [] }, flags = {}, today = todayYMD()) {
  const seen = (r) => !r.is_archived || flags.archivedDogLinks;
  const pups = dogs.filter((d) => (d.sire_id === dog.id || d.dam_id === dog.id) && seen(d));
  const mine = litters.filter((l) => (l.sire_id === dog.id || l.dam_id === dog.id) && !l.is_archived);
  const pupIds = new Set(pups.map((d) => d.id));
  const pupSales = sales.filter((s) => pupIds.has(s.dog_id) && !s.is_archived);
  const placed = pupSales.filter((s) => !RELEASED_SALE_STATUSES.includes(s.status));
  const earned = placed.reduce((t, s) => t + (Number.isFinite(Number(s.price)) && s.price !== '' && s.price != null ? Number(s.price) : 0), 0);
  // Its events of a topic, newest first.
  const own = events.filter((e) => e.subject_type === 'dog' && e.subject_id === dog.id && !e.is_archived)
    .sort((a, b) => String(b.event_date || '').localeCompare(String(a.event_date || '')));
  const ofTopic = (key) => own.filter((e) => DOG_TOPICS.find((t) => t.key === key).events.includes(e.event_type));
  const shots = ofTopic('shots');
  // The next shot due: each vaccine's latest shot, the soonest next_due among them.
  const latest = new Map();
  for (const e of shots) if (e.event_type === 'vaccination') { const k = String(e.details?.vaccine || '').toLowerCase(); if (!latest.has(k)) latest.set(k, e); }
  const dues = [...latest.values()].filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.details?.next_due || '')).sort((a, b) => a.details.next_due.localeCompare(b.details.next_due));
  const due = dues.length ? { vaccine: dues[0].details.vaccine || '', date: dues[0].details.next_due, overdue: dues[0].details.next_due < today } : null;
  // Who saw it last: the newest health event (shots or vet) with a vet on it, the
  // linked contact or the plain-text name; and every vet linked, newest first.
  const contactsById = new Map(contacts.map((c) => [c.id, c]));
  const vetOf = (e) => (e.related_contact_id && contactsById.get(e.related_contact_id)) || (e.details?.vet ? { name: String(e.details.vet) } : null);
  const health = own.filter((e) => [...DOG_TOPICS.find((t) => t.key === 'shots').events, ...DOG_TOPICS.find((t) => t.key === 'vet').events].includes(e.event_type));
  const seenBy = health.find(vetOf);
  const lastSeen = seenBy ? { name: vetOf(seenBy).name || '', date: seenBy.event_date || '', contact: vetOf(seenBy).id ? vetOf(seenBy) : null } : null;
  const vets = [];
  for (const e of health) { const c = e.related_contact_id && contactsById.get(e.related_contact_id); if (c && !vets.some((v) => v.contact.id === c.id)) vets.push({ contact: c, last: e.event_date || '', visits: health.filter((x) => x.related_contact_id === c.id).length }); }
  // Its vet costs: Veterinary expenses on the dog, all time and this year.
  const vetCosts = expenses.filter((x) => x.subject_type === 'dog' && x.subject_id === dog.id && x.category === 'veterinary' && !x.is_archived);
  const sum = (xs) => xs.reduce((t, x) => t + (Number(x.amount) || 0), 0);
  const thisYear = vetCosts.filter((x) => String(x.expense_date || '').slice(0, 4) === today.slice(0, 4));
  return { pups, litters: mine, sales: pupSales, sold: new Set(placed.map((s) => s.dog_id)).size, earned, shots, vet: ofTopic('vet'), due,
    seen: lastSeen, vets, vetCosts: { count: vetCosts.length, total: sum(vetCosts), year: today.slice(0, 4), thisYear: sum(thisYear), thisYearCount: thisYear.length } };
}

// What Kels says she found, for the topics her words touched (all, by default):
// "Zeus has sired 8 puppies across 2 litters, and 5 have sold for $12,400."
// "JJ's last shot was Rabies on Mar 1, 2026, and DHPP is due Nov 2, 2026."
// `pronoun`: "He has sired…" / "Her last shot…", after a sentence that named the dog.
// `today` decides "is due" or "was due… (overdue)".
export function factsSentence(dog, f, { pronoun = false, topics = null } = {}) {
  const name = dogName(dog) || 'This dog';
  const he = { male: 'He', female: 'She' }[dog.sex];
  const his = { male: 'His', female: 'Her' }[dog.sex];
  const on = (k) => !topics || topics.includes(k);
  const out = [];
  const subj = () => (pronoun && he && !out.length ? he : out.length && he ? he : name);
  const poss = () => (pronoun && his && !out.length ? his : out.length && his ? his : `${name}'s`);
  if (on('pups') || on('litters') || on('sales')) {
    const verb = dog.sex === 'male' ? 'has sired' : dog.sex === 'female' ? 'has had' : 'has';
    if (f.pups.length) {
      let s = `${subj()} ${verb} ${plural(f.pups.length, 'puppy', 'puppies')}`;
      if (f.litters.length) s += ` across ${plural(f.litters.length, 'litter')}`;
      if (f.sold) s += `, and ${f.sold} ${f.sold === 1 ? 'has' : 'have'} sold${f.earned ? ` for ${money(f.earned)}` : ''}`;
      out.push(`${s}.`);
    } else if (f.litters.length) out.push(`${subj()} has ${plural(f.litters.length, 'litter')} on record.`);
  }
  if (on('shots') && f.shots.length) {
    const e = f.shots[0];
    let s = `${poss()} last shot was ${whatOf(e) || typeLabel(e.event_type).toLowerCase()}${e.event_date ? ` on ${day(e.event_date)}` : ''}`;
    if (f.due) s += f.due.overdue ? `, and ${f.due.vaccine || 'a shot'} was due ${day(f.due.date)} (overdue)` : `, and ${f.due.vaccine || 'the next one'} is due ${day(f.due.date)}`;
    out.push(`${s}.`);
  }
  if (on('vet')) {
    const e = f.vet[0];
    // "JJ was last seen by Dr. Nguyen on Aug 3, 2026 (Ear infection)." when that was the latest; else both.
    if (f.seen?.name && (!e || f.seen.date >= (e.event_date || ''))) {
      const latest = e && f.seen.date === (e.event_date || '') ? whatOf(e) : '';
      out.push(`${subj()} was last seen by ${f.seen.name}${f.seen.date ? ` on ${day(f.seen.date)}` : ''}${latest ? ` (${latest})` : ''}.`);
    } else if (e) {
      const what = whatOf(e);
      const kind = typeLabel(e.event_type).toLowerCase();
      out.push(`${poss()} latest was ${article(kind)} ${kind}${e.event_date ? ` on ${day(e.event_date)}` : ''}${what ? ` (${what})` : ''}.`);
      if (f.seen?.name) out.push(`${subj()} was last seen by ${f.seen.name}${f.seen.date ? ` on ${day(f.seen.date)}` : ''}.`);
    }
    if (f.vetCosts?.thisYear) out.push(`${subj()} has ${money(f.vetCosts.thisYear)} in vet expenses logged this year.`);
    else if (f.vetCosts?.count) out.push(`${subj()} has no vet expenses logged this year (${money(f.vetCosts.total)} before).`);
  }
  return out.join(' ');
}

// Is it "<a dog> <topic words>"? Every word she typed is either one of the
// dog's names or a topic's word, with at least one of each. Returns null, or
// { words, topics (DOG_TOPICS keys her words touch), dogs: [{ dog, facts, offered
// (the topics with something behind them) }] }, dogs with something first.
export function aboutDog(text, rows, { flags = {}, today = todayYMD() } = {}) {
  const all = queryWords(text);
  const isAdd = (q) => ADD_WORDS.includes(q.stem) || ADD_WORDS.includes(q.word);
  const add = all.some(isAdd);
  const qs = all.filter((q) => !isAdd(q) && !FILLER.has(q.word));
  if (qs.length < 2) return null;
  const seen = (d) => !d.is_archived || flags.archivedDogLinks;
  const out = [];
  let topics = null;
  for (const dog of (rows.dogs || []).filter(seen)) {
    const names = nameStems(dog);
    const isName = (q) => [...names].some((w) => wordScore(q, w, 0) > 0);
    const rest = qs.filter((q) => !isName(q));
    if (rest.length === qs.length || !rest.length) continue;
    const touched = DOG_TOPICS.filter((t) => rest.some((q) => hitsTopic(q, t)));
    if (!touched.length || !rest.every((q) => touched.some((t) => hitsTopic(q, t)))) continue;
    topics ||= touched.map((t) => t.key);
    const facts = factsOf(dog, rows, flags, today);
    out.push({ dog, facts, offered: touched.filter((t) => t.count(facts) > 0).map((t) => t.key) });
  }
  if (!out.length) return null;
  // Her own dogs before pedigree-only ones, then the ones with the most to show.
  out.sort((a, b) => b.offered.length - a.offered.length || !!a.dog.pedigree_only - !!b.dog.pedigree_only);
  // `add`: she said "add"/"log"…, and a topic she named can add one.
  return { words: qs.map((q) => q.word), topics, add: add && topics.some((k) => topicByKey(k).add), dogs: out };
}

// Adding one of a topic for a dog: a candidate opening its page with the event
// form ready (dog.html's ?logEvent=), or null when the topic can't add.
export function addCandidate(key, dog) {
  const t = topicByKey(key);
  if (!t?.add) return null;
  const name = dogName(dog) || 'this dog';
  return { id: `add:${key}:${dog.id}`, first: true, title: t.add.label(name), where: `Opens ${name}'s page with a new ${typeLabel(t.add.type).toLowerCase()} ready to fill in.`,
    href: `dog.html?id=${encodeURIComponent(dog.id)}&logEvent=${t.add.type}` };
}

// One topic's results for one dog: { hits ([{ c }] for kelsFindUI's offer),
// extras (candidates offered with the list: "All of Zeus's puppies"; `first`
// ones, like adding one, go above it) }.
export function topicResults(key, dog, facts, rows, { flags = {}, edition = 'pro' } = {}) {
  const name = dogName(dog) || 'this dog';
  const dogsById = new Map((rows.dogs || []).map((d) => [d.id, d]));
  const littersById = new Map((rows.litters || []).map((l) => [l.id, l]));
  const contactsById = new Map((rows.contacts || []).map((c) => [c.id, c]));
  const litterOf = (pup) => (littersById.get(pup.litter_id) ? litterLabel(littersById.get(pup.litter_id), dogsById) : pup.date_of_birth ? `Born ${pup.date_of_birth}` : null);
  const hit = (c) => ({ c, matched: 1, score: 0, level: 1, why: null });
  if (key === 'pups') {
    const hits = dogCandidates(facts.pups, { flags }).map((c, i) => {
      const pup = facts.pups[i];
      return hit({ ...c, facets: [{ key: 'pup-litter', question: 'Which litter?', value: litterOf(pup) }, ...c.facets] });
    });
    return { hits, extras: [{ id: `offspring:${dog.id}`, title: `All of ${name}'s puppies`, where: `${name}'s page, under Offspring.`, href: `dog.html?id=${encodeURIComponent(dog.id)}#offspring` }] };
  }
  if (key === 'shots' || key === 'vet') {
    const hits = facts[key].map((e) => {
      const kind = typeLabel(e.event_type);
      const what = whatOf(e);
      return hit({
        id: `event:${e.id}`, group: 'An event', title: what ? `${what} (${kind.toLowerCase()})` : kind,
        sub: [day(e.event_date), e.details?.next_due ? `next due ${day(e.details.next_due)}` : null].filter(Boolean).join(' · '),
        where: `On ${name}'s page, in its history.`, href: `dog.html?id=${encodeURIComponent(dog.id)}&openEvent=${encodeURIComponent(e.id)}`,
        levels: [[what, kind], [], []],
        facets: [{ key: 'event-kind', question: 'Which kind?', value: kind }, { key: 'event-year', question: 'Which year?', value: e.event_date ? e.event_date.slice(0, 4) : null }]
      });
    });
    const extras = [addCandidate(key, dog)];
    if (key === 'vet') {
      // Her vets (contact pages are Pro's), and her vet costs on Financials.
      if (flags.contactsSection && !(edition === 'lite' && isProOnlyPage('contact.html'))) {
        for (const v of facts.vets) extras.push({ id: `contact:${v.contact.id}`, title: v.contact.name || 'Vet', where: `${name}'s vet: ${plural(v.visits, 'visit')}${v.last ? `, the last on ${day(v.last)}` : ''}.`, href: `contact.html?id=${encodeURIComponent(v.contact.id)}` });
      }
      if (facts.vetCosts.count) {
        extras.push({ id: `vet-costs:${dog.id}`, title: `${name}'s vet expenses`,
          where: `${money(facts.vetCosts.thisYear)} in ${facts.vetCosts.year}, ${money(facts.vetCosts.total)} in all. Under Financials → Expenses, Veterinary.`,
          href: `financials.html?view=expenses&bucket=veterinary&dog=${encodeURIComponent(dog.id)}` });
      }
    }
    return { hits, extras };
  }
  if (key === 'litters') return { hits: litterCandidates(facts.litters, { dogsById }).map(hit), extras: [] };
  if (key === 'sales') {
    const hits = facts.sales.map((s) => {
      const pup = dogsById.get(s.dog_id);
      const pupName = dogName(pup) || 'A puppy';
      const buyer = contactsById.get(s.buyer_contact_id)?.name || '';
      const status = descriptor(SALE_STATUS, s.status)?.label || s.status;
      const price = s.price !== '' && s.price != null && Number.isFinite(Number(s.price)) ? money(Number(s.price)) : '';
      return hit({
        id: `sale:${s.id}`, group: 'A sale', title: pupName, sub: [buyer, price, status].filter(Boolean).join(' · '),
        where: `${pupName}'s sale${buyer ? ` to ${buyer}` : ''}${price ? `, ${price}` : ''}: ${status.toLowerCase()}.`,
        href: `sale.html?id=${encodeURIComponent(s.id)}`, levels: [[pupName, buyer], [], []],
        facets: [{ key: 'sale-litter', question: 'Which litter?', value: pup ? litterOf(pup) : null }]
      });
    });
    const report = flags.reports && !(edition === 'lite' && isProOnlyPage('dog-return-report.html'));
    return { hits, extras: report ? [{ id: 'report:dog-return-report.html', title: 'Breeding-Dog Return', where: `${name}'s row has what ${name}'s litters brought in, against ${name}'s costs.`, href: 'dog-return-report.html' }] : [] };
  }
  return { hits: [], extras: [] };
}

export const topicByKey = (key) => DOG_TOPICS.find((t) => t.key === key);
