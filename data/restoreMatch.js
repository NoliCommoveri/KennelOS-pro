// restoreMatch.js — pairing records across devices for a file / Dropbox Merge
// (End-State guide §10, "Matching records across devices"). Pure: rows in, pairs,
// questions and merged rows out; importExport.js reads and writes the tables.
//
// The same dog typed on two devices has two ids. Before a Merge writes anything,
// these rules pair such records by content, so the restore can give each pair one
// id and merge them, instead of keeping both.
//   - Only unclaimed records: a backup row whose id isn't on this device, against a
//     device row whose id isn't in the backup. Two rows from one side are never
//     paired; pairs are one to one.
//   - Each rule says 'same' (paired by itself), 'ask' (she decides in the restore
//     preview) or null. A row with more than one candidate is asked about.
//   - Tables go in MATCH_ORDER, comparing foreign keys through the pairs found so
//     far, so a dog she says isn't the same leaves what hangs off it unpaired.
import { normReg, nameKey } from './dogSearch.js';
import { normName, normEmail, normPhone } from './contactSearch.js';
import {
  EVENT_TYPES, RELEASED_SALE_STATUSES, WAITLIST_OPEN_STATUSES, SEX, SALE_STATUS, LITTER_STATUS, PAIRING_STATUS,
  ACCOUNT_TYPE, CONTRACT_TYPE, EXPENSE_CATEGORIES, DOC_TYPES, WAITLIST_ENTRY_STATUS, descriptor
} from './vocab.js';

const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && !v.length);
const set = (v) => !blank(v);
// Both have it and it differs.
const differs = (a, b) => set(a) && set(b) && a !== b;
const eqSet = (a, b) => set(a) && a === b;
const chip = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const knownSex = (d) => (d.sex === 'male' || d.sex === 'female' ? d.sex : '');
const dayNum = (ymd) => (/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || '')) ? Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / 86400000 : null);
const daysApart = (a, b) => {
  const x = dayNum(a);
  const y = dayNum(b);
  return x == null || y == null ? null : Math.abs(x - y);
};
// Dates of one heat: the same, within 21 days, or blank on a side.
const sameHeat = (a, b) => { const d = daysApart(a, b); return !set(a) || !set(b) || (d != null && d <= 21); };

// The type's short detail fields (not long notes): where both have one, they agree.
const SHORT_DETAIL_KEYS = new Map(EVENT_TYPES.map((t) => [t.value,
  (t.fields || []).filter((f) => f.type !== 'textarea' && f.key !== 'notes').map((f) => f.key)]));
function detailsAgree(type, a = {}, b = {}) {
  return (SHORT_DETAIL_KEYS.get(type) || []).every((k) => !differs(String(a?.[k] ?? '').trim(), String(b?.[k] ?? '').trim()));
}

// --- The rules ------------------------------------------------------------------
// rule(local, file, ctx) → 'same' | 'ask' | null. `ctx.fk(id)` turns a backup id
// into this device's id through the pairs found so far (unpaired ids pass through,
// so they never equal a device id). `ctx.local` / `ctx.incoming`: every row by table.

const ownCount = (rows) => rows.filter((k) => k.is_own_kennel && !k.is_archived).length;

const RULES = {
  kennels(l, f, ctx) {
    if (!!l.is_own_kennel !== !!f.is_own_kennel) return null;
    const sameName = eqSet(normName(l.kennel_name), normName(f.kennel_name));
    if (l.is_own_kennel) {
      if (eqSet(l.public_id, f.public_id) || sameName) return 'same';
      return ownCount(ctx.local.kennels) === 1 && ownCount(ctx.incoming.kennels) === 1 ? 'ask' : null;
    }
    if (!sameName) return null;
    return differs(normName(l.website), normName(f.website)) || differs(normName(l.location), normName(f.location)) ? 'ask' : 'same';
  },
  accounts: (l, f) => (eqSet(normName(l.name), normName(f.name)) && l.account_type === f.account_type ? 'same' : null),
  contacts(l, f) {
    const emailL = normEmail(l.email); const emailF = normEmail(f.email);
    const phoneL = normPhone(l.phone); const phoneF = normPhone(f.phone);
    if (differs(emailL, emailF) && differs(phoneL, phoneF)) return null;
    const shared = eqSet(emailL, emailF) || eqSet(phoneL, phoneF);
    const sameName = eqSet(normName(l.name), normName(f.name));
    if (sameName && shared) return 'same';
    return sameName || shared ? 'ask' : null;
  },
  waitlist_programs: (l, f, { fk }) => (l.kennel_id === fk(f.kennel_id) && eqSet(normName(l.name), normName(f.name)) ? 'same' : null),
  breed_feeding_schedules: (l, f) => (eqSet(normName(l.breed), normName(f.breed)) ? 'same' : null),
  // Dogs go twice: strong identifiers first (dogs), then, once litters are paired,
  // pups and the call-name question (dogs_late).
  dogs(l, f, ctx) {
    if (dogNever(l, f, ctx)) return null;
    if (eqSet(nameKey(l.registered_name), nameKey(f.registered_name))) return 'same';
    if (eqSet(normReg(l.registration_number), normReg(f.registration_number))) return 'same';
    if (eqSet(chip(l.microchip_id), chip(f.microchip_id))) return 'same';
    return null;
  },
  dogs_late(l, f, ctx) {
    if (dogNever(l, f, ctx)) return null;
    const sameCall = eqSet(normName(l.call_name), normName(f.call_name));
    // Two pups pair only through their litters: names repeat from litter to litter.
    if (set(l.litter_id) && set(f.litter_id)) return sameCall && l.litter_id === ctx.fk(f.litter_id) && l.sex === f.sex ? 'same' : null;
    if (sameCall && eqSet(normName(l.breed), normName(f.breed)) && l.sex === f.sex) return 'ask';
    return null;
  },
  pairings(l, f, { fk }) {
    if (!(eqSet(l.dam_id, fk(f.dam_id)) && eqSet(l.sire_id, fk(f.sire_id)))) return null;
    if (eqSet(l.planned_date, f.planned_date)) return 'same';
    return sameHeat(l.planned_date, f.planned_date) ? 'ask' : null;
  },
  litters(l, f, { fk }) {
    if (eqSet(l.pairing_id, fk(f.pairing_id))) return 'same';
    if (!eqSet(l.dam_id, fk(f.dam_id))) return null;
    const sameSire = eqSet(l.sire_id, fk(f.sire_id));
    const noSire = blank(l.sire_id) && blank(f.sire_id); // a dam whelps once a day
    if ((sameSire || noSire) && eqSet(l.whelp_date, f.whelp_date)) return 'same';
    if (eqSet(l.whelp_date, f.whelp_date) && (blank(l.sire_id) || blank(f.sire_id))) return 'ask';
    if (sameSire && l.status === 'expected' && f.status === 'expected' && blank(l.pairing_id) && blank(f.pairing_id)) return 'ask';
    return null;
  },
  sales(l, f, { fk }) {
    if (!(eqSet(l.dog_id, fk(f.dog_id)) && eqSet(l.buyer_contact_id, fk(f.buyer_contact_id)))) return null;
    const ended = (s) => RELEASED_SALE_STATUSES.includes(s.status);
    if (differs(l.sale_date, f.sale_date) && ended(l) !== ended(f)) return 'ask';
    return 'same';
  },
  stud_services(l, f, { fk }) {
    if (!(eqSet(l.our_dog_id, fk(f.our_dog_id)) && eqSet(l.partner_dog_id, fk(f.partner_dog_id)))) return null;
    if (eqSet(l.sent_date, f.sent_date)) return 'same';
    return sameHeat(l.sent_date, f.sent_date) ? 'ask' : null;
  },
  contracts(l, f, { fk }) {
    if (l.contract_type !== f.contract_type) return null;
    if (eqSet(l.related_sale_id, fk(f.related_sale_id)) || eqSet(l.related_stud_service_id, fk(f.related_stud_service_id))) return 'same';
    if (['lease', 'co_own', 'foster', 'other'].includes(l.contract_type)
      && eqSet(l.related_dog_id, fk(f.related_dog_id)) && eqSet(l.related_contact_id, fk(f.related_contact_id))) return 'same';
    return null;
  },
  events(l, f, { fk }) {
    if (l.subject_type !== f.subject_type || !eqSet(l.subject_id, fk(f.subject_id))) return null;
    if (l.event_type !== f.event_type || !eqSet(l.event_date, f.event_date)) return null;
    return detailsAgree(l.event_type, l.details, f.details) ? 'same' : null;
  },
  expenses(l, f, { fk }) {
    if (eqSet(l.event_id, fk(f.event_id)) || eqSet(l.stud_service_id, fk(f.stud_service_id))) return 'same';
    if (eqSet(String(l.receipt_number ?? '').trim(), String(f.receipt_number ?? '').trim())) return 'same';
    if (l.subject_type === f.subject_type && eqSet(l.subject_id, fk(f.subject_id)) && eqSet(l.expense_date, f.expense_date)
      && Number(l.amount) === Number(f.amount) && l.category === f.category) return 'same';
    return null;
  },
  documents: (l, f, { fk }) => (eqSet(l.dog_id, fk(f.dog_id)) && l.doc_type === f.doc_type && (l.doc_date || '') === (f.doc_date || '')
    && normName(l.title) === normName(f.title) ? 'same' : null),
  waitlist_entries(l, f, { fk }) {
    if (!(eqSet(l.kennel_id, fk(f.kennel_id)) && eqSet(l.contact_id, fk(f.contact_id)))) return null;
    const open = (e) => WAITLIST_OPEN_STATUSES.includes(e.status);
    if (open(l) && open(f)) return 'same';
    return !open(l) && !open(f) && eqSet(l.applied_date, f.applied_date) ? 'same' : null;
  },
  waitlist_offers: (l, f, { fk }) => (eqSet(l.entry_id, fk(f.entry_id)) && eqSet(l.litter_id, fk(f.litter_id))
    && eqSet(l.offered_date, f.offered_date) ? 'same' : null)
};

// The rules, for the on-device duplicate scan (data/duplicateScan.js), which runs
// them between two records on this device.
export { RULES as MATCH_RULES };

// Never one dog, whatever else agrees.
export function dogNever(l, f, { fk }) {
  if (knownSex(l) && knownSex(f) && knownSex(l) !== knownSex(f)) return true;
  if (differs(normReg(l.registration_number), normReg(f.registration_number))) return true;
  if (differs(chip(l.microchip_id), chip(f.microchip_id))) return true;
  if (differs(l.date_of_birth, f.date_of_birth)) return true;
  // One is the other's parent (seen through the pairs so far).
  return [fk(f.sire_id), fk(f.dam_id)].includes(l.id);
}

// When a row has several 'same' candidates, these pair them closest first instead
// of asking (a pup sold to the same family twice: by sale date).
const DISTANCE = {
  sales: (l, f) => daysApart(l.sale_date, f.sale_date) ?? 100000
};

// The order the tables are paired in; [rule key, table]. Files follow their
// document or expense (followFiles).
export const MATCH_ORDER = [
  ['kennels', 'kennels'], ['accounts', 'accounts'], ['contacts', 'contacts'],
  ['waitlist_programs', 'waitlist_programs'], ['breed_feeding_schedules', 'breed_feeding_schedules'],
  ['dogs', 'dogs'], ['pairings', 'pairings'], ['litters', 'litters'], ['dogs_late', 'dogs'],
  ['sales', 'sales'], ['stud_services', 'stud_services'], ['contracts', 'contracts'],
  ['events', 'events'], ['expenses', 'expenses'], ['documents', 'documents'],
  ['waitlist_entries', 'waitlist_entries'], ['waitlist_offers', 'waitlist_offers']
];

export const askKey = (table, fileId) => `${table}:${fileId}`;

// Pair the two sides.
//   local, incoming: { table: rows[] } (this device / the backup).
//   answers: { askKey: localId | 'none' } — what she said to earlier questions.
// → { pairs: [{ table, localId, fileId, asked }], asks: [{ key, table, fileId, candidates: [localId] }] }
// A question already answered is never asked again; `asks` are the open ones.
export function planMatches({ local = {}, incoming = {}, answers = {} } = {}) {
  const rows = (side, t) => (side[t] || []).filter(Boolean);
  const f2l = new Map(); // backup id → device id, for the pairs found so far
  const fk = (id) => (id == null ? id : f2l.get(id) ?? id);
  const ctx = { fk, local: new Proxy(local, { get: (o, t) => rows(o, t) }), incoming: new Proxy(incoming, { get: (o, t) => rows(o, t) }) };
  const pairs = [];
  const asks = [];
  const taken = new Set(); // device ids already paired

  const pair = (table, l, f, asked) => {
    pairs.push({ table, localId: l.id, fileId: f.id, asked });
    f2l.set(f.id, l.id);
    taken.add(l.id);
  };

  for (const [ruleKey, table] of MATCH_ORDER) {
    const localIds = new Set(rows(local, table).map((r) => r.id));
    const fileIds = new Set(rows(incoming, table).map((r) => r.id));
    // The id matches claim their rows on both sides.
    for (const id of fileIds) if (localIds.has(id)) f2l.set(id, id);
    const L = rows(local, table).filter((r) => !fileIds.has(r.id));
    const F = rows(incoming, table).filter((r) => !localIds.has(r.id) && !f2l.has(r.id));
    const rule = RULES[ruleKey];

    // Every candidate pair, with its level.
    const cands = new Map(F.map((f) => [f.id, []]));
    for (const f of F) {
      for (const l of L) {
        if (taken.has(l.id)) continue;
        const level = rule(l, f, ctx);
        if (level) cands.get(f.id).push({ l, level });
      }
    }

    // Her answers first.
    for (const f of F) {
      const a = answers[askKey(table, f.id)];
      if (a == null) continue;
      cands.set(f.id, []);
      const hit = a !== 'none' && rows(local, table).find((l) => l.id === a && !taken.has(a) && !fileIds.has(a));
      if (hit) pair(table, hit, f, true);
    }

    // 'same' with one candidate each way; or closest first where the table says how.
    const same = [];
    for (const f of F) for (const c of cands.get(f.id)) if (c.level === 'same' && !taken.has(c.l.id) && !f2l.has(f.id)) same.push({ f, l: c.l });
    const sameFor = (pred) => same.filter(pred).length;
    if (DISTANCE[ruleKey]) {
      same.sort((x, y) => DISTANCE[ruleKey](x.l, x.f) - DISTANCE[ruleKey](y.l, y.f));
      for (const s of same) if (!taken.has(s.l.id) && !f2l.has(s.f.id)) pair(table, s.l, s.f, false);
    } else {
      for (const s of same) {
        if (sameFor((x) => x.f === s.f) === 1 && sameFor((x) => x.l === s.l) === 1) pair(table, s.l, s.f, false);
      }
    }

    // What's left with any candidate is a question.
    for (const f of F) {
      if (f2l.has(f.id)) continue;
      const open = cands.get(f.id).filter((c) => !taken.has(c.l.id)).map((c) => c.l.id);
      if (open.length && !asks.some((q) => q.key === askKey(table, f.id))) asks.push({ key: askKey(table, f.id), table, fileId: f.id, candidates: open });
    }
  }
  followFiles({ local, incoming, pairs, taken, f2l });
  return { pairs, asks };
}

// A paired document's file, and a paired expense's receipt file, are paired too.
function followFiles({ local, incoming, pairs, taken, f2l }) {
  const byId = (side, t) => new Map((side[t] || []).filter(Boolean).map((r) => [r.id, r]));
  const lFiles = byId(local, 'files');
  const fFiles = byId(incoming, 'files');
  for (const [table, key] of [['documents', 'file_id'], ['expenses', 'receipt_file_id']]) {
    const lRows = byId(local, table);
    const fRows = byId(incoming, table);
    for (const p of pairs.filter((x) => x.table === table)) {
      const lf = lRows.get(p.localId)?.[key];
      const ff = fRows.get(p.fileId)?.[key];
      if (!lf || !ff || lf === ff || taken.has(lf) || f2l.has(ff)) continue;
      if (!lFiles.has(lf) || !fFiles.has(ff) || fFiles.has(lf) || lFiles.has(ff)) continue;
      pairs.push({ table: 'files', localId: lf, fileId: ff, asked: false });
      f2l.set(ff, lf);
      taken.add(lf);
    }
  }
}

// --- Merging a pair --------------------------------------------------------------

// A dog's fields she chooses between when both records have one and they differ.
export const DOG_CLASH_FIELDS = [
  { key: 'call_name', label: 'Call name' },
  { key: 'registered_name', label: 'Registered name' },
  { key: 'sex', label: 'Sex' },
  { key: 'sire_id', label: 'Sire', ref: 'dog' },
  { key: 'dam_id', label: 'Dam', ref: 'dog' }
];
const clashBlank = (key, v) => blank(v) || (key === 'sex' && v === 'unknown');

export const clashKey = (pairFileId, field) => `${pairFileId}:${field}`;

// The clashes she decides for the paired dogs: [{ key, fileId, localId, field, label,
// ref?, local, file }] where `file` is the backup's value with its ids turned into
// this device's (so a sire paired in this restore isn't a clash).
export function dogClashes({ local = {}, incoming = {}, pairs = [] }) {
  const f2l = new Map(pairs.map((p) => [p.fileId, p.localId]));
  const lDogs = new Map((local.dogs || []).map((d) => [d.id, d]));
  const fDogs = new Map((incoming.dogs || []).map((d) => [d.id, d]));
  const out = [];
  for (const p of pairs.filter((x) => x.table === 'dogs')) {
    const l = lDogs.get(p.localId);
    const f = fDogs.get(p.fileId);
    if (!l || !f) continue;
    for (const c of DOG_CLASH_FIELDS) {
      const fv = c.ref ? (f2l.get(f[c.key]) ?? f[c.key]) : f[c.key];
      const lv = l[c.key];
      if (clashBlank(c.key, lv) || clashBlank(c.key, fv)) continue;
      // Spelled the same apart from titles, case or punctuation isn't a clash.
      const same = c.ref || c.key === 'sex' ? lv === fv : c.key === 'registered_name' ? nameKey(lv) === nameKey(fv) : normName(lv) === normName(fv);
      if (!same) out.push({ key: clashKey(p.fileId, c.key), fileId: p.fileId, localId: p.localId, field: c.key, label: c.label, ref: c.ref, local: lv, file: fv });
    }
  }
  return out;
}

const isPlainObject = (v) => v != null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const isPrimitiveList = (v) => Array.isArray(v) && v.every((x) => x == null || typeof x !== 'object');

// Merge two copies of one record that already share an id. A field blank on one
// side fills from the other; where both have one, the newer copy (updated_at)
// wins, except the dog clash fields, which follow `choose(field)` → 'local' |
// 'file' | undefined (undefined: newer wins). Lists of plain values are joined,
// `notes` keep both, plain objects fill their blank keys from the older copy.
export function mergePair(localRow, fileRow, { table = '', choose = () => undefined } = {}) {
  const fileNewer = String(fileRow.updated_at || '') > String(localRow.updated_at || '');
  const newer = fileNewer ? fileRow : localRow;
  const older = fileNewer ? localRow : fileRow;
  const out = { ...older, ...newer };
  for (const k of new Set([...Object.keys(newer), ...Object.keys(older)])) {
    const nv = newer[k];
    const ov = older[k];
    if (k === 'id') continue;
    if (table === 'dogs' && DOG_CLASH_FIELDS.some((c) => c.key === k)) {
      if (clashBlank(k, nv) && !clashBlank(k, ov)) { out[k] = ov; continue; }
      const pick = !clashBlank(k, nv) && !clashBlank(k, ov) && nv !== ov ? choose(k) : undefined;
      if (pick === 'local') out[k] = localRow[k];
      else if (pick === 'file') out[k] = fileRow[k];
      continue;
    }
    if (blank(nv) && !blank(ov)) { out[k] = ov; continue; }
    if (blank(ov)) continue;
    if (k === 'notes' && typeof nv === 'string' && typeof ov === 'string' && nv.trim() !== ov.trim()) {
      out[k] = nv.includes(ov.trim()) ? nv : `${nv}\n\n${ov}`;
    } else if (isPrimitiveList(nv) && isPrimitiveList(ov)) {
      out[k] = [...new Set([...nv, ...ov])];
    } else if (isPlainObject(nv) && isPlainObject(ov)) {
      const merged = { ...ov };
      for (const [kk, vv] of Object.entries(nv)) if (!blank(vv) || !(kk in merged)) merged[kk] = vv;
      out[k] = merged;
    }
  }
  const created = [localRow.created_at, fileRow.created_at].filter(Boolean).sort();
  if (created.length) out.created_at = created[0];
  const updated = [localRow.updated_at, fileRow.updated_at].filter(Boolean).sort();
  if (updated.length) out.updated_at = updated[updated.length - 1];
  return out;
}

// --- Re-keying -----------------------------------------------------------------

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LONG_TEXT = 4096; // a data URL or an encoded file: no id inside, not worth scanning

// Replace every id in `remap` (old → new) wherever it appears in a value: a whole
// string, inside a string (a dismissal key "deceased-sale:<id>", a "jotform:<id>"
// row id), in lists, nested objects and their keys. Blobs and other non-plain objects are left
// alone. Returns the same value when nothing changed.
export function rekey(value, remap) {
  if (!remap.size) return value;
  if (typeof value === 'string') {
    if (remap.has(value)) return remap.get(value);
    if (value.length > LONG_TEXT || value.length < 36) return value;
    return value.replace(UUID, (m) => remap.get(m) ?? remap.get(m.toLowerCase()) ?? m);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => { const n = rekey(v, remap); if (n !== v) changed = true; return n; });
    return changed ? out : value;
  }
  if (isPlainObject(value)) {
    let changed = false;
    const entries = Object.entries(value).map(([k, v]) => {
      const nk = rekey(k, remap);
      const nv = rekey(v, remap);
      if (nk !== k || nv !== v) changed = true;
      return [nk, nv];
    });
    return changed ? Object.fromEntries(entries) : value;
  }
  return value;
}

// --- Words for the preview -------------------------------------------------------

// One line saying what a record is, for "Are these the same?". `nameOf(table, id)`
// names a referenced dog / contact / kennel (either side).
export function describeRecord(table, r, nameOf = () => '') {
  const bits = (...xs) => xs.filter((x) => set(x)).join(' · ');
  const dogs = (a, b) => [nameOf('dogs', a), nameOf('dogs', b)].filter(Boolean).join(' × ');
  switch (table) {
    case 'kennels': return bits(r.kennel_name, r.is_own_kennel ? 'your kennel' : '', r.location, r.website);
    case 'contacts': return bits(r.name, r.email, r.phone);
    case 'dogs': return bits(r.call_name, r.registered_name, r.sex && descriptor(SEX, r.sex).label, r.breed, r.date_of_birth && `born ${r.date_of_birth}`, r.registration_number, r.litter_id && nameOf('litters', r.litter_id) && `litter ${nameOf('litters', r.litter_id)}`);
    case 'pairings': return bits(dogs(r.dam_id, r.sire_id), r.planned_date && `planned ${r.planned_date}`, r.status && descriptor(PAIRING_STATUS, r.status).label);
    case 'litters': return bits(dogs(r.dam_id, r.sire_id), r.whelp_date ? `whelped ${r.whelp_date}` : r.status && descriptor(LITTER_STATUS, r.status).label);
    case 'sales': return bits(nameOf('dogs', r.dog_id), nameOf('contacts', r.buyer_contact_id) && `to ${nameOf('contacts', r.buyer_contact_id)}`, r.sale_date, r.status && descriptor(SALE_STATUS, r.status).label);
    case 'stud_services': return bits(dogs(r.our_dog_id, r.partner_dog_id), r.sent_date, r.status);
    case 'accounts': return bits(r.name, r.account_type && descriptor(ACCOUNT_TYPE, r.account_type).label, r.website);
    case 'waitlist_programs': return bits(r.name, nameOf('kennels', r.kennel_id));
    case 'breed_feeding_schedules': return bits(r.breed, 'feeding schedule');
    case 'contracts': return bits(r.contract_type && `${descriptor(CONTRACT_TYPE, r.contract_type).label} contract`, nameOf('dogs', r.related_dog_id),
      nameOf('contacts', r.related_contact_id) && `with ${nameOf('contacts', r.related_contact_id)}`, r.signed_date);
    case 'events': return bits(r.title || (r.event_type && descriptor(EVENT_TYPES, r.event_type).label), nameOf(r.subject_type === 'dog' ? 'dogs' : r.subject_type === 'litter' ? 'litters' : 'pairings', r.subject_id), r.event_date);
    case 'expenses': return bits(r.category && descriptor(EXPENSE_CATEGORIES, r.category).label, r.amount != null && r.amount !== '' && `$${Number(r.amount).toFixed(2)}`, r.expense_date, r.vendor);
    case 'documents': return bits(r.title, r.doc_type && descriptor(DOC_TYPES, r.doc_type).label, nameOf('dogs', r.dog_id), r.doc_date);
    case 'waitlist_entries': return bits(nameOf('contacts', r.contact_id), nameOf('kennels', r.kennel_id), r.applied_date && `applied ${r.applied_date}`, r.status && descriptor(WAITLIST_ENTRY_STATUS, r.status).label);
    case 'waitlist_offers': return bits(r.offered_date && `offered ${r.offered_date}`, nameOf('litters', r.litter_id) && `litter ${nameOf('litters', r.litter_id)}`, r.outcome);
    default: return bits(r.name || r.title || r.kennel_name || r.id);
  }
}
