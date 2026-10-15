// findRecords.js — her records as Find candidates for Kels's "Finding Something"
// (data/kelsFind.js; Kels roadmap §3.11). Pure: takes the rows (loaded by the
// caller through the repos) and returns candidates; reads and writes nothing.
//
// Levels (kelsFind): 1 = names and numbers; 2 = secondary details; 3 = deep
// (notes, and a dog's or litter's events: titles, details, notes). A deep field
// carries a label ("notes", "Vaccination 2026-03-01") so Kels can say where the
// word was. Archived records are found but come after live ones; Lite, which
// can't open an archived dog (editionFlags.archivedDogLinks), doesn't get them.
import { DOG_STATUS, OWNERSHIP_TYPE, CONTACT_TYPE, LITTER_STATUS, SEX, EVENT_TYPES, descriptor } from './vocab.js';
import { dogName } from './dogRepo.js';
import { litterLabel } from './litterCheckin.js';
import { normReg } from './dogSearch.js';

const label = (vocab, v) => (v ? descriptor(vocab, v)?.label || v : '');
const ARCHIVED = -1;

// An event's words, labelled with what it was and when.
function eventTexts(events) {
  const out = [];
  for (const e of events) {
    if (e.is_archived) continue;
    const what = `${label(EVENT_TYPES, e.event_type)}${e.event_date ? ` ${e.event_date}` : ''}`;
    const texts = [e.title, e.notes, ...Object.values(e.details || {}).filter((v) => typeof v === 'string' || typeof v === 'number')];
    for (const t of texts) if (t !== '' && t != null) out.push([what, String(t)]);
  }
  return out;
}

const byRecord = (events, type) => {
  const m = new Map();
  for (const e of events) {
    if (e.subject_type !== type) continue;
    if (!m.has(e.subject_id)) m.set(e.subject_id, []);
    m.get(e.subject_id).push(e);
  }
  return m;
};

const OURS = new Set(['owned', 'co_owned', 'leased_in']);

export function dogCandidates(dogs, { events = [], kennelsById = new Map(), flags = {} } = {}) {
  const evs = byRecord(events, 'dog');
  return dogs.filter((d) => !d.is_archived || flags.archivedDogLinks).map((d) => {
    const name = dogName(d) || 'Unnamed dog';
    const whose = d.pedigree_only ? 'Just in a pedigree' : OURS.has(d.ownership_type) ? 'Yours' : 'Someone else\'s';
    const sex = d.sex === 'female' ? 'Girl' : d.sex === 'male' ? 'Boy' : null;
    return {
      id: `dog:${d.id}`, group: 'A dog', title: name,
      sub: [d.call_name && d.registered_name ? d.registered_name : null, d.breed, sex, d.pedigree_only ? 'pedigree only' : label(DOG_STATUS, d.status), d.is_archived ? 'archived' : null].filter(Boolean).join(' · '),
      where: d.pedigree_only
        ? `${name} is in KennelOS for the pedigree. ${name}'s page has the details and the family tree.`
        : `${name} has a page under Dogs: profile, health, history, sales and pedigree.`,
      href: `dog.html?id=${encodeURIComponent(d.id)}`,
      boost: (d.is_archived ? ARCHIVED : 0) + (d.pedigree_only ? -0.3 : 0),
      numbers: [d.registration_number, d.microchip_id].filter(Boolean).map(normReg),
      levels: [
        [d.call_name, d.registered_name, d.registration_number, d.microchip_id],
        [['breed', d.breed], ['color', d.color_markings], ['status', label(DOG_STATUS, d.status)], ['ownership', label(OWNERSHIP_TYPE, d.ownership_type)],
          ['sex', label(SEX, d.sex)], ['kennel', kennelsById.get(d.kennel_id)?.kennel_name],
          ['bred by', kennelsById.get(d.breeder_kennel_id)?.kennel_name]].filter(([, t]) => t),
        [['notes', d.notes], ...eventTexts(evs.get(d.id) || [])].filter(([, t]) => t)
      ],
      facets: [
        { key: 'dog-whose', question: 'Is it your dog, or someone else\'s?', value: whose },
        { key: 'dog-sex', question: 'A boy or a girl?', value: sex },
        { key: 'dog-breed', question: 'Which breed?', value: d.breed || null }
      ]
    };
  });
}

export function contactCandidates(contacts, { kennelsById = new Map() } = {}) {
  return contacts.map((c) => {
    const types = (c.contact_type || []).map((t) => label(CONTACT_TYPE, t));
    const name = c.name || 'Unnamed contact';
    return {
      id: `contact:${c.id}`, group: 'A person', title: name,
      sub: [types.join(', '), c.email || c.phone, c.is_archived ? 'archived' : null].filter(Boolean).join(' · '),
      where: `${name}'s page is under People: their details, dogs, sales and history with you.`,
      href: `contact.html?id=${encodeURIComponent(c.id)}`,
      boost: c.is_archived ? ARCHIVED : 0,
      levels: [
        [c.name],
        [...types.map((t) => ['type', t]), ['email', c.email], ['phone', c.phone], ['kennel', kennelsById.get(c.kennel_id)?.kennel_name]].filter(([, t]) => t),
        [['notes', c.notes], ['address', c.address], ['how they found you', c.first_contact_source]].filter(([, t]) => t)
      ],
      facets: [{ key: 'contact-type', question: 'Who are they to you?', value: types[0] || null }]
    };
  });
}

export function kennelCandidates(kennels) {
  return kennels.map((k) => ({
    id: `kennel:${k.id}`, group: 'A kennel', title: k.kennel_name || 'Unnamed kennel',
    sub: [k.is_own_kennel ? 'Your kennel' : 'Another kennel', k.location, k.is_archived ? 'archived' : null].filter(Boolean).join(' · '),
    where: k.is_own_kennel
      ? `${k.kennel_name}'s page has its settings, one section at a time: litters, finances, logo, tests and more.`
      : `${k.kennel_name}'s page has its expenses, logo and kennel card.`,
    href: `kennel.html?id=${encodeURIComponent(k.id)}`,
    boost: k.is_archived ? ARCHIVED : 0,
    levels: [
      [k.kennel_name, k.prefix],
      [['location', k.location], ['website', k.website]].filter(([, t]) => t),
      [['notes', k.notes]].filter(([, t]) => t)
    ],
    facets: [{ key: 'kennel-own', question: 'One of yours, or another kennel?', value: k.is_own_kennel ? 'Yours' : 'Another kennel' }]
  }));
}

export function litterCandidates(litters, { dogsById = new Map(), events = [] } = {}) {
  const evs = byRecord(events, 'litter');
  const name = (id) => dogName(dogsById.get(id));
  return litters.map((l) => {
    const lbl = litterLabel(l, dogsById);
    const title = /\blitter$/i.test(lbl) ? lbl : `${lbl} litter`;
    const year = l.whelp_date ? l.whelp_date.slice(0, 4) : null;
    return {
      id: `litter:${l.id}`, group: 'A litter', title,
      sub: [label(LITTER_STATUS, l.status), l.whelp_date ? `born ${l.whelp_date}` : null, l.is_archived ? 'archived' : null].filter(Boolean).join(' · '),
      where: `The ${title}'s page is under Breeding: its puppies, prices and sales.`,
      href: `litter.html?id=${encodeURIComponent(l.id)}`,
      boost: l.is_archived ? ARCHIVED : 0,
      numbers: [l.litter_registration_number].filter(Boolean).map(normReg),
      levels: [
        ['litter', l.nickname, l.litter_registration_number],
        [['mom', name(l.dam_id)], ['dad', name(l.sire_id)], ['status', label(LITTER_STATUS, l.status)], ['year', year]].filter(([, t]) => t),
        [['notes', l.notes], ...eventTexts(evs.get(l.id) || [])].filter(([, t]) => t)
      ],
      facets: [{ key: 'litter-year', question: 'Which year?', value: year || (l.status === 'expected' ? 'Expected' : null) }]
    };
  });
}

// Every record kind this edition has. rows: { dogs, contacts, kennels, litters, events }.
export function recordCandidates({ dogs = [], contacts = [], kennels = [], litters = [], events = [] }, flags = {}) {
  const kennelsById = new Map(kennels.map((k) => [k.id, k]));
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  return [
    ...dogCandidates(dogs, { events, kennelsById, flags }),
    ...litterCandidates(litters, { dogsById, events }),
    ...(flags.contactsSection ? contactCandidates(contacts, { kennelsById }) : []),
    ...(flags.contactsSection ? kennelCandidates(kennels) : [])
  ];
}
