// dogTitles.js — a dog's titles as one list (Dog Titles Field Plan §2, §8.0).
// Pure: no Dexie, no DOM; tested directly (tests/dogTitles.test.js).
//
// A dog's titles come from three places, merged at read time so nothing is ever
// copied between them:
//   - `field`: `Dog.titles`, what she typed or a chart import gave
//     ([{ abbr, organization, earned_on }], dogRepo stores it via normalizeTitles)
//   - `event`: its non-archived `title_earned` events (the dated record)
//   - `name`: titles still on the front of `registered_name` ("GCH A-K Bella", D5a)
// Every reader (dog page, website feed, waitlist cards, ancestors, the show
// engine, the nudge) goes through titlesOf.
import { splitTitles, TITLE_PREFIXES } from './pedigreeParse.js';

export const MAX_ABBR = 30;
export const MAX_ORGANIZATION = 60;

const text = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);

// The key two titles are compared on: upper case, no dots or spaces (H.CH = HCH).
export const abbrKey = (abbr) => String(abbr ?? '').toUpperCase().replace(/[.\s]/g, '');
// The same key without a repeat number on the end (GCHP2 → GCHP). Used only to say
// whether a title is held (holdsTitle) and which side of the name it goes on.
const baseKey = (abbr) => abbrKey(abbr).replace(/(?<=[A-Z])\d{1,2}$/, '');

// Two entries are the same title when their keys match and their organizations
// match, or either organization is blank.
export function sameTitle(a, b) {
  if (abbrKey(a.abbr) !== abbrKey(b.abbr)) return false;
  const oa = text(a.organization).toUpperCase();
  const ob = text(b.organization).toUpperCase();
  return !oa || !ob || oa === ob;
}

// Goes in front of the name (D3): on the prefix list, a repeat number allowed.
export const isPrefixTitle = (abbr) => TITLE_PREFIXES.has(abbrKey(abbr)) || TITLE_PREFIXES.has(baseKey(abbr));

const earlier = (a, b) => (!a ? b : !b ? a : a < b ? a : b);

// Fold `entry` into `into` (the same title): a blank organization is filled in
// and the earliest known date kept.
function mergeInto(into, entry) {
  if (!into.organization && entry.organization) into.organization = entry.organization;
  into.earned_on = earlier(into.earned_on, entry.earned_on);
  if (!into.event_id && entry.event_id) into.event_id = entry.event_id;
}

// `Dog.titles` as stored: [{ abbr, organization, earned_on }], '' for any blank
// part. abbr trimmed to 30 characters, organization to 60, earned_on kept only if
// it's YYYY-MM-DD. A bare string is an abbreviation. Blank abbreviations are
// dropped and duplicates merged, in the order given.
export function normalizeTitles(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const t of list) {
    const raw = typeof t === 'string' ? { abbr: t } : t || {};
    const entry = {
      abbr: text(raw.abbr).slice(0, MAX_ABBR).trim(),
      organization: text(raw.organization).slice(0, MAX_ORGANIZATION).trim(),
      earned_on: isYmd(text(raw.earned_on)) ? text(raw.earned_on) : ''
    };
    if (!entry.abbr) continue;
    const have = out.find((o) => sameTitle(o, entry));
    if (have) mergeInto(have, entry);
    else out.push(entry);
  }
  return out;
}

// A dog's titles from all three sources, in display order. `events` may be any
// list of events; only this dog's non-archived title_earned ones are read.
// → [{ abbr, organization, earned_on, source: 'field'|'event'|'name', event_id? }]
//
// Display order: the field's own order (as she or the chart arranged it, e.g.
// "GCHB CH"), then name-only titles; event-only prefix titles go in front of all
// the prefixes, newest first (a bought CH that later logs a GCH shows "GCH CH");
// event-only suffix titles go after the suffixes, oldest first.
export function titlesOf(dog, events = []) {
  if (!dog) return [];
  const base = normalizeTitles(dog.titles).map((t) => ({ ...t, source: 'field' }));
  for (const abbr of splitTitles(text(dog.registered_name)).titles) {
    const entry = { abbr, organization: '', earned_on: '', source: 'name' };
    if (!base.some((b) => sameTitle(b, entry))) base.push(entry);
  }
  const evOnly = [];
  const mine = (events || [])
    .filter((e) => e && e.event_type === 'title_earned' && !e.is_archived
      && (e.subject_id == null || (e.subject_id === dog.id && (e.subject_type ?? 'dog') === 'dog'))
      && text(e.details?.title_abbreviation))
    .sort((a, b) => String(a.event_date || '').localeCompare(String(b.event_date || '')) || String(a.id).localeCompare(String(b.id)));
  for (const e of mine) {
    const entry = {
      abbr: text(e.details.title_abbreviation).slice(0, MAX_ABBR).trim(),
      organization: text(e.details.organization).slice(0, MAX_ORGANIZATION).trim(),
      earned_on: isYmd(text(e.event_date)) ? text(e.event_date) : '',
      source: 'event',
      event_id: e.id
    };
    const have = base.find((b) => sameTitle(b, entry)) || evOnly.find((b) => sameTitle(b, entry));
    if (have) mergeInto(have, entry);
    else evOnly.push(entry);
  }
  const prefixes = (l) => l.filter((t) => isPrefixTitle(t.abbr));
  const suffixes = (l) => l.filter((t) => !isPrefixTitle(t.abbr));
  // evOnly is oldest first (events sorted by date).
  return [...prefixes(evOnly).reverse(), ...prefixes(base), ...suffixes(base), ...suffixes(evOnly)];
}

// The name with its titles: prefixes + the registered name without its front
// titles (else the call name) + suffixes. "GCH CH A-K Bella CGC".
export function displayName(dog, titles = titlesOf(dog)) {
  if (!dog) return '';
  const name = splitTitles(text(dog.registered_name)).name || text(dog.call_name);
  const pre = titles.filter((t) => isPrefixTitle(t.abbr)).map((t) => t.abbr);
  const post = titles.filter((t) => !isPrefixTitle(t.abbr)).map((t) => t.abbr);
  return [...pre, name, ...post].filter(Boolean).join(' ');
}

// The order the feed sends them in (titles_detail): dated titles by date, then the
// undated ones in display order.
export function feedOrder(titles) {
  const dated = titles.filter((t) => t.earned_on).sort((a, b) => a.earned_on.localeCompare(b.earned_on));
  return [...dated, ...titles.filter((t) => !t.earned_on)];
}

// Whether `list` (titlesOf output, or any [{ abbr }]) holds `abbr`; a repeat
// number counts (GCH2 holds GCH). For the show engine and the nudge only.
export function holdsTitle(list, abbr) {
  const k = baseKey(abbr);
  return !!k && (list || []).some((t) => baseKey(typeof t === 'string' ? t : t?.abbr) === k);
}

// The titles on the front of a registered name, and the name without them (D5).
export function nameTitles(registeredName) {
  return splitTitles(text(registeredName));
}

// Every dog's titles at once, for the readers that build many dogs (the website
// feed, waitlist parent cards, ancestors): `dogs` gives the field and name titles,
// `events` the title_earned ones. A dog with title events but no record in `dogs`
// still gets its event titles. → Map(dogId → titlesOf list).
export function titlesByDogId(events = [], dogs = []) {
  const evBy = new Map();
  for (const e of events || []) {
    if (!e || e.event_type !== 'title_earned' || e.subject_type !== 'dog') continue;
    if (!evBy.has(e.subject_id)) evBy.set(e.subject_id, []);
    evBy.get(e.subject_id).push(e);
  }
  const out = new Map();
  for (const d of dogs || []) if (d?.id && !out.has(d.id)) out.set(d.id, titlesOf(d, evBy.get(d.id) || []));
  for (const [id, list] of evBy) if (!out.has(id)) out.set(id, titlesOf({ id }, list));
  return out;
}

// The abbreviations alone, in display order, each once (case and dots ignored).
export function titleAbbrs(titles) {
  const seen = new Set();
  const out = [];
  for (const t of titles || []) {
    const k = abbrKey(t.abbr);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(t.abbr);
  }
  return out;
}

// Suffix titles offered as suggestions on the Dog form (Dog Titles Field Plan §8
// phase 3): AKC's published suffix list, main page plus the extra ones confirmed
// from its alphabetical list (docs/KennelOS_Registry_Title_Facts.md §3). Only a
// suggestion list: she can type any title, and anything not on TITLE_PREFIXES
// goes after the name whether it's here or not.
export const TITLE_SUFFIXES = Object.freeze([
  'ACT1', 'ACT2', 'ACT1J', 'ACT2J', 'AJP', 'ATT', 'AX', 'AXJ', 'AXP', 'BCAT', 'BN', 'BN-V', 'CA', 'CAA', 'CAX',
  'CAX2', 'CD', 'CD-V', 'CDX', 'CGC', 'CGCA', 'CGCU', 'CM', 'DCAT', 'EE', 'FCAT', 'FDC', 'FITB', 'FITS', 'FITG',
  'FTA', 'FTC', 'FTCP', 'FTI', 'FTN', 'FTR', 'GN', 'GO', 'HI', 'HIAdsc', 'HIBdsc', 'HICs', 'HS', 'HSAdsc', 'HSBdsc',
  'HSCs', 'HT', 'HX', 'HXAdsc', 'HXBdsc', 'HXCs', 'JC', 'JE', 'JH', 'JHA', 'JHR', 'JHU', 'LCX', 'MC', 'ME', 'MFB',
  'MFC', 'MFG', 'MFP', 'MFPB', 'MFPC', 'MFPG', 'MFPS', 'MFS', 'MH', 'MHA', 'MHR', 'MHU', 'MJB', 'MJC', 'MJG', 'MJP',
  'MJPB', 'MJPC', 'MJPG', 'MJPS', 'MJS', 'MNH', 'MX', 'MXB', 'MXC', 'MXF', 'MXG', 'MXJ', 'MXP', 'MXPB', 'MXPC',
  'MXPG', 'MXPS', 'MXS', 'NA', 'NAJ', 'NAP', 'NE', 'NF', 'NFP', 'NJP', 'OA', 'OAJ', 'OAP', 'OF', 'OFP', 'OGM', 'OJP',
  'OM', 'PAD', 'PADP', 'PAX', 'PCD', 'PCDX', 'PDB', 'PDBP', 'PDC', 'PDCP', 'PDG', 'PDGP', 'PDS', 'PDSP', 'PJB',
  'PJBP', 'PJC', 'PJCP', 'PJD', 'PJDP', 'PJG', 'PJGP', 'PJS', 'PJSP', 'PT', 'PUDX', 'PUTD', 'RN', 'RA', 'RC', 'RE',
  'RAE', 'RI', 'RM', 'SBA', 'SBAE', 'SBE', 'SBEE', 'SBM', 'SBME', 'SBN', 'SBNE', 'SC', 'SCA', 'SCAE', 'SCE', 'SCEE',
  'SCM', 'SCME', 'SCN', 'SCNE', 'SE', 'SEA', 'SEAE', 'SEE', 'SEEE', 'SEM', 'SEME', 'SEN', 'SENE', 'SH', 'SHA',
  'SHDA', 'SHDAE', 'SHDE', 'SHDEE', 'SHDM', 'SHDME', 'SHDN', 'SHDNE', 'SHR', 'SHU', 'SIA', 'SIAE', 'SIE', 'SIEE',
  'SIM', 'SIME', 'SIN', 'SINE', 'STR', 'SWA', 'SWAE', 'SWD', 'SWE', 'SWEE', 'SWM', 'SWME', 'SWN', 'SWNE', 'T2B',
  'T2BP', 'TD', 'TDU', 'TDX', 'THD', 'THDA', 'THDD', 'THDN', 'THDS', 'THDX', 'TKN', 'TKI', 'TKA', 'TKP', 'TKE',
  'TQX', 'TQXP', 'UD', 'UDX', 'VCD1', 'VCD2', 'VCD3', 'VCD4', 'VER', 'VHMA', 'VHMP', 'VST', 'VSWB', 'VSWI', 'VSWE',
  'XF', 'XFP',
  // AKC's alphabetical list, beyond the main one
  'AE', 'AEA', 'AEX', 'AJ', 'CI', 'CIT', 'CS', 'CX', 'CXT', 'NBDD', 'NDD', 'QA2'
]);

// Every suggestion for the Dog form's title box: the prefixes, then the suffixes,
// each once (case and dots ignored).
export function titleSuggestions() {
  return titleAbbrs([...TITLE_PREFIXES, ...TITLE_SUFFIXES].map((abbr) => ({ abbr })));
}

// What she typed in the "add a title" box, split into titles: spaces or commas
// between them ("GCH CH", "CGC, TKN"). Order kept, blanks dropped.
export function splitTitleInput(text) {
  return String(text ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

// The Dog form's chips (§8 phase 3) from the draft and the dog's events:
//   field — Dog.titles as she has them, editable; `event_id` when a logged
//           title_earned event is the same title (the chip links to it)
//   event — logged titles the field doesn't hold: read-only, each with its event
//   name  — titles on the front of the registered name the field doesn't hold
export function formTitleChips(dog, events = []) {
  const field = (Array.isArray(dog?.titles) ? dog.titles : []).map((t) => ({
    abbr: String(t?.abbr ?? ''), organization: String(t?.organization ?? ''), earned_on: String(t?.earned_on ?? '')
  }));
  const merged = titlesOf({ ...dog, titles: field }, events);
  for (const f of field) {
    const m = merged.find((t) => t.source === 'field' && t.event_id && sameTitle(t, f));
    if (m) f.event_id = m.event_id;
  }
  return {
    field,
    event: merged.filter((t) => t.source === 'event'),
    name: merged.filter((t) => t.source === 'name')
  };
}
