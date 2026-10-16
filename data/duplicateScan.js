// duplicateScan.js — records entered twice on this device (End-State guide §10,
// "Duplicates on this device"): what the Import/Export page's Scan for duplicates
// card raises. Pure: rows in, pairs out; data/recordMerge.js reads the tables and
// merges a pair she confirms.
//
// The rules are a file Merge's (data/restoreMatch.js), run between two records on
// this device instead of across two devices, plus the tidy-up's own duplicate
// dogs and contacts (data/tidyRules.js), so anything either would call the same
// is raised. Nothing is ever merged by itself here: a rule's 'same' is a
// `certain` pair, its 'ask' a `possible` one, and she decides each.
//   - Live records only (archived ones are left alone), compared within a table.
//   - Foreign keys compare as stored, so two litters are the same dam only once
//     her two dog records are merged; the card scans again after every merge.
//   - Tables the edition doesn't have are skipped (SCAN_FLAGS).
import { MATCH_RULES, dogNever } from './restoreMatch.js';
import { normReg, nameKey } from './dogSearch.js';
import { normName, normEmail, normPhone } from './contactSearch.js';
import { duplicateDogFindings, duplicateContactFindings } from './tidyRules.js';

// The tables scanned, in the order she sees them: parents before what hangs off
// them, so merging two dogs first can make their litters a pair.
export const SCAN_TABLES = [
  'kennels', 'accounts', 'contacts', 'waitlist_programs', 'breed_feeding_schedules',
  'dogs', 'pairings', 'litters', 'sales', 'stud_services', 'contracts',
  'events', 'expenses', 'documents', 'waitlist_entries', 'waitlist_offers'
];

// The edition flag a table needs (editionFlags); the rest are in every edition.
// Outside kennels need contactsSection too (pairAllowed).
const SCAN_FLAGS = {
  accounts: 'accounts', contacts: 'contactsSection', waitlist_programs: 'waitlist',
  breed_feeding_schedules: 'feedingSchedule', stud_services: 'studServices', contracts: 'contracts',
  documents: 'documents', waitlist_entries: 'waitlist', waitlist_offers: 'waitlist'
};

export function scanTables(flags = {}) {
  return SCAN_TABLES.filter((t) => !SCAN_FLAGS[t] || flags[SCAN_FLAGS[t]]);
}

// One record of each kind, and many, in words.
export const RECORD_WORDS = {
  kennels: ['kennel', 'kennels'], accounts: ['account', 'accounts'], contacts: ['contact', 'contacts'],
  waitlist_programs: ['waitlist program', 'waitlist programs'], breed_feeding_schedules: ['feeding schedule', 'feeding schedules'],
  dogs: ['dog', 'dogs'], pairings: ['breeding', 'breedings'], litters: ['litter', 'litters'], sales: ['sale', 'sales'],
  stud_services: ['stud service', 'stud services'], contracts: ['contract', 'contracts'], events: ['event', 'events'],
  expenses: ['expense', 'expenses'], documents: ['document', 'documents'],
  waitlist_entries: ['waitlist family', 'waitlist families'], waitlist_offers: ['waitlist offer', 'waitlist offers']
};

const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '');
const chip = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const str = (v) => String(v ?? '').trim();

export const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

// Only records sharing one of these keys can be a pair, so each table is bucketed
// by them first (a rule never pairs two records that share none).
const BUCKETS = {
  kennels: (r) => [normName(r.kennel_name), r.public_id && `p:${r.public_id}`],
  accounts: (r) => [normName(r.name)],
  contacts: (r) => [normName(r.name) && `n:${normName(r.name)}`, normEmail(r.email) && `e:${normEmail(r.email)}`, normPhone(r.phone) && `p:${normPhone(r.phone)}`],
  waitlist_programs: (r) => [r.kennel_id && `${r.kennel_id}|${normName(r.name)}`],
  breed_feeding_schedules: (r) => [normName(r.breed)],
  dogs: (r) => [nameKey(r.registered_name) && `r:${nameKey(r.registered_name)}`, normReg(r.registration_number) && `n:${normReg(r.registration_number)}`,
    chip(r.microchip_id) && `m:${chip(r.microchip_id)}`, normName(r.call_name) && `c:${normName(r.call_name)}`],
  pairings: (r) => [r.dam_id && r.sire_id && `${r.dam_id}|${r.sire_id}`],
  litters: (r) => [r.pairing_id && `p:${r.pairing_id}`, r.dam_id && `d:${r.dam_id}`],
  sales: (r) => [r.dog_id && r.buyer_contact_id && `${r.dog_id}|${r.buyer_contact_id}`],
  stud_services: (r) => [r.our_dog_id && r.partner_dog_id && `${r.our_dog_id}|${r.partner_dog_id}`],
  contracts: (r) => [r.related_sale_id && `s:${r.related_sale_id}`, r.related_stud_service_id && `t:${r.related_stud_service_id}`,
    r.related_dog_id && r.related_contact_id && `d:${r.related_dog_id}|${r.related_contact_id}`],
  events: (r) => [r.subject_id && r.event_date && `${r.subject_type}|${r.subject_id}|${r.event_type}|${r.event_date}`],
  expenses: (r) => [r.event_id && `e:${r.event_id}`, r.stud_service_id && `t:${r.stud_service_id}`, str(r.receipt_number) && `r:${str(r.receipt_number)}`,
    r.expense_date && `d:${r.subject_type}|${r.subject_id}|${r.expense_date}|${Number(r.amount)}|${r.category}`],
  documents: (r) => [r.dog_id && `${r.dog_id}|${r.doc_type}|${r.doc_date || ''}|${normName(r.title)}`],
  waitlist_entries: (r) => [r.kennel_id && r.contact_id && `${r.kennel_id}|${r.contact_id}`],
  waitlist_offers: (r) => [r.entry_id && r.litter_id && `${r.entry_id}|${r.litter_id}|${r.offered_date || ''}`]
};

// What two records have in common, for "Same name and email". [label, key(row)].
const SHARED = {
  kennels: [['name', (r) => normName(r.kennel_name)], ['website', (r) => normName(r.website)], ['location', (r) => normName(r.location)], ['KennelOS ID', (r) => r.public_id]],
  accounts: [['name', (r) => normName(r.name)], ['type', (r) => r.account_type]],
  contacts: [['name', (r) => normName(r.name)], ['email', (r) => normEmail(r.email)], ['phone', (r) => normPhone(r.phone)], ['address', (r) => normName(r.address)],
    ['kennel', (r) => r.kennel_id]],
  waitlist_programs: [['kennel', (r) => r.kennel_id], ['name', (r) => normName(r.name)]],
  breed_feeding_schedules: [['breed', (r) => normName(r.breed)]],
  dogs: [['registered name', (r) => nameKey(r.registered_name)], ['registration number', (r) => normReg(r.registration_number)],
    ['microchip', (r) => chip(r.microchip_id)], ['call name', (r) => normName(r.call_name)], ['breed', (r) => normName(r.breed)],
    ['birthday', (r) => r.date_of_birth], ['litter', (r) => r.litter_id]],
  pairings: [['dam', (r) => r.dam_id], ['sire', (r) => r.sire_id], ['planned date', (r) => r.planned_date]],
  litters: [['breeding', (r) => r.pairing_id], ['dam', (r) => r.dam_id], ['sire', (r) => r.sire_id], ['whelp date', (r) => r.whelp_date]],
  sales: [['pup', (r) => r.dog_id], ['buyer', (r) => r.buyer_contact_id], ['sale date', (r) => r.sale_date]],
  stud_services: [['dog', (r) => r.our_dog_id], ['partner dog', (r) => r.partner_dog_id], ['date', (r) => r.sent_date]],
  contracts: [['type', (r) => r.contract_type], ['sale', (r) => r.related_sale_id], ['stud service', (r) => r.related_stud_service_id],
    ['dog', (r) => r.related_dog_id], ['person', (r) => r.related_contact_id]],
  events: [['subject', (r) => r.subject_id], ['type', (r) => r.event_type], ['date', (r) => r.event_date]],
  expenses: [['event', (r) => r.event_id], ['stud service', (r) => r.stud_service_id], ['receipt number', (r) => str(r.receipt_number)],
    ['date', (r) => r.expense_date], ['amount', (r) => (blank(r.amount) ? '' : String(Number(r.amount)))], ['category', (r) => r.category]],
  documents: [['dog', (r) => r.dog_id], ['type', (r) => r.doc_type], ['date', (r) => r.doc_date], ['title', (r) => normName(r.title)]],
  waitlist_entries: [['kennel', (r) => r.kennel_id], ['family', (r) => r.contact_id], ['application date', (r) => r.applied_date]],
  waitlist_offers: [['family', (r) => r.entry_id], ['litter', (r) => r.litter_id], ['offer date', (r) => r.offered_date]]
};

export function sharedDetails(table, a, b) {
  return (SHARED[table] || []).filter(([, f]) => { const x = f(a); return !blank(x) && x === f(b); }).map(([label]) => label);
}

const RANK = { same: 2, ask: 1 };
const best = (...levels) => levels.reduce((m, l) => ((RANK[l] || 0) > (RANK[m] || 0) ? l : m), null);
const both = (rule, a, b, ctx) => best(rule(a, b, ctx), rule(b, a, ctx));

// A file Merge's level for two records on this device: 'same' | 'ask' | null.
function ruleLevel(table, a, b, ctx) {
  if (table === 'dogs') {
    if (dogNever(a, b, ctx) || dogNever(b, a, ctx)) return null;
    // A pup's name repeats from litter to litter, and two pups of one litter by
    // name alone are asked about, never certain (the tidy-up's rule).
    const late = both(MATCH_RULES.dogs_late, a, b, ctx);
    return best(both(MATCH_RULES.dogs, a, b, ctx), late && 'ask');
  }
  return MATCH_RULES[table] ? both(MATCH_RULES[table], a, b, ctx) : null;
}

// Outside kennels are a Pro record (People); Lite compares only its own.
function pairAllowed(table, a, b, flags) {
  if (table === 'kennels' && !flags.contactsSection) return a.is_own_kennel && b.is_own_kennel;
  return true;
}

// Every pair: [{ key, table, a, b, strength: 'certain' | 'possible', shared: [labels] }],
// in SCAN_TABLES order, certain first, the older record of each pair as `a`.
//   rows: { table: rows[] } (archived rows may be included; they're skipped).
//   flags: the edition's (editionFlags). dismissed(finding) → true to leave it out.
export function findDuplicates({ rows = {}, flags = {}, dismissed = () => false } = {}) {
  const tables = scanTables(flags);
  const live = Object.fromEntries(tables.map((t) => [t, (rows[t] || []).filter((r) => r && !r.is_archived)]));
  const ctx = { fk: (id) => id, local: live, incoming: live };
  const found = new Map();
  const add = (table, x, y, level) => {
    if (!level || x.id === y.id || !pairAllowed(table, x, y, flags)) return;
    const key = `${table}:${pairKey(x.id, y.id)}`;
    const had = found.get(key);
    if (had && RANK[had.level] >= RANK[level]) return;
    const [a, b] = String(x.created_at || '') <= String(y.created_at || '') ? [x, y] : [y, x];
    found.set(key, { key, table, a, b, level });
  };

  for (const table of tables) {
    const buckets = new Map();
    for (const r of live[table]) {
      for (const k of new Set(BUCKETS[table](r).filter(Boolean))) {
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(r);
      }
    }
    const seen = new Set();
    for (const group of buckets.values()) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const pk = pairKey(group[i].id, group[j].id);
          if (seen.has(pk)) continue;
          seen.add(pk);
          add(table, group[i], group[j], ruleLevel(table, group[i], group[j], ctx));
        }
      }
    }
  }
  // The tidy-up's duplicates, so nothing it would raise is missed here.
  if (tables.includes('dogs')) {
    for (const f of duplicateDogFindings(live.dogs)) add('dogs', f.a, f.b, f.strength === 'certain' ? 'same' : 'ask');
  }
  if (tables.includes('contacts')) {
    for (const f of duplicateContactFindings(live.contacts)) add('contacts', f.a, f.b, 'ask');
  }

  const out = [...found.values()]
    .map(({ level, ...f }) => ({ ...f, strength: level === 'same' ? 'certain' : 'possible', shared: sharedDetails(f.table, f.a, f.b) }))
    .filter((f) => !dismissed(f));
  const order = (f) => tables.indexOf(f.table) * 2 + (f.strength === 'certain' ? 0 : 1);
  return out.sort((x, y) => order(x) - order(y));
}

// The nudge-ledger keys a "Not the same" is remembered under: the scan's own, and
// for dogs and contacts the tidy-up's too, so Kels doesn't ask about it either.
export function dismissKeys(f) {
  const pk = pairKey(f.a.id, f.b.id);
  const keys = [`dup:${f.key}`];
  if (f.table === 'dogs') keys.push(`tidy:dupdog:${pk}`);
  if (f.table === 'contacts') keys.push(`tidy:dupcontact:${pk}`);
  return keys;
}
