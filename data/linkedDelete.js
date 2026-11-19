// linkedDelete.js — delete a record together with the linked records that were
// made with it (the Delete wizard; End-State guide §7).
//
// The hard-delete guard refuses while anything points at a record, so a set of
// test records that point at each other (a test contact, its sale, the pup, the
// litter, the contract) can't be deleted one by one. This finds the set from one
// of them, lets her untick anything real, and removes the rest in one go with
// recordDetach.removeDetaching: records she keeps only lose their link.
//
// What's offered, starting from the record she's on:
//   • Records that point at one in the set (a sale pointing at its buyer, a
//     contract at its sale). They depend on it.
//   • Records one in the set points at (the sale's pup, the pup's litter), but
//     only when what else uses them was made at the same time: a real dam, with
//     her other litters and pups, is never pulled in by a test litter.
// A record starts ticked only when it was also added within WINDOW_DAYS of the
// one she started from (and, for one the set points at, so was everything that
// uses it); otherwise it's listed unticked, with why. The search only goes on
// through ticked records, so it stays inside what was made together.
//
// What goes with every record deleted, untold: its own history (events and
// expenses about it, a dog's documents) and their files. Kennels, accounts and
// waitlist programs are setup, never offered: links to them just go.
import { db, existingTableNames } from './db.js';
import { REFERENCES_BY_TABLE, findReferencingRows, refIdsOf } from './referenceRegistry.js';
import { removeDetaching, planDetach } from './recordDetach.js';
import { ENTITY_LABELS } from './repoBase.js';
import { assertWritable } from './demoMode.js';
import { documentRepo } from './documentRepo.js';
import { CONTRACT_TYPE, descriptor } from './vocab.js';

export const WINDOW_DAYS = 3;
const MAX_RECORDS = 200;

// The record kinds the wizard offers.
export const NODE_TABLES = Object.freeze([
  'contacts', 'dogs', 'litters', 'pairings', 'sales', 'stud_services', 'contracts',
  'waitlist_entries', 'waitlist_offers', 'do_not_sell'
]);
const NODES = new Set(NODE_TABLES);

// A record's own history, deleted with it: the registry entries whose row is
// ABOUT the record (not merely mentions it, like an event's partner dog).
const OWN = { events: new Set(['subject_id']), expenses: new Set(['subject_id', 'stud_service_id']), documents: new Set(['dog_id']) };
const isOwnRef = (ref) => OWN[ref.table]?.has(ref.field) || false;

const key = (table, id) => `${table}:${id}`;
const DAY = 86400000;
const withinWindow = (row, start) => {
  const a = Date.parse(row?.created_at); const b = Date.parse(start?.created_at);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= WINDOW_DAYS * DAY;
};

// Records pointing at `row` of `table`, as [{ table, row, ref }]; `own` picks the
// record's own history (true) or everything else (false).
async function referrers(table, ids, { own }) {
  const out = [];
  const existing = new Set(existingTableNames());
  for (const ref of REFERENCES_BY_TABLE[table] || []) {
    if (!existing.has(ref.table) || isOwnRef(ref) !== own) continue;
    for (const r of await findReferencingRows(ref, ids)) out.push({ table: ref.table, row: r, ref });
  }
  return out;
}

// Records `row` (of `table`) points at, among the offered kinds: [{ table, id }].
function pointsAt(table, row) {
  const out = [];
  for (const target of NODE_TABLES) {
    for (const ref of REFERENCES_BY_TABLE[target] || []) {
      if (ref.table !== table) continue;
      for (const id of refIdsOf(row, ref)) out.push({ table: target, id });
    }
  }
  return out;
}

// What she'd recognise each record by.
async function labeller() {
  const cache = new Map();
  const get = async (table, id) => {
    if (!id) return null;
    const k = key(table, id);
    if (!cache.has(k)) cache.set(k, await db.table(table).get(id) || null);
    return cache.get(k);
  };
  const dog = async (id) => { const d = await get('dogs', id); return d ? (d.call_name || d.registered_name || 'Unnamed dog') : null; };
  const contact = async (id) => (await get('contacts', id))?.name || null;
  return async function label(table, r) {
    switch (table) {
      case 'contacts': return r.name || 'Unnamed contact';
      case 'dogs': return r.call_name || r.registered_name || 'Unnamed dog';
      case 'litters': return r.nickname || `${(await dog(r.dam_id)) || '?'} × ${(await dog(r.sire_id)) || '?'}`;
      case 'pairings': return `${(await dog(r.dam_id)) || '?'} × ${(await dog(r.sire_id)) || '?'}`;
      case 'sales': {
        const pup = await dog(r.dog_id); const buyer = await contact(r.buyer_contact_id);
        return [pup || 'A pup', buyer ? `to ${buyer}` : ''].filter(Boolean).join(' ');
      }
      case 'stud_services': return `${(await dog(r.our_dog_id)) || '?'} with ${(await dog(r.partner_dog_id)) || '?'}`;
      case 'contracts': {
        const kind = r.contract_type ? `${descriptor(CONTRACT_TYPE, r.contract_type).label} contract` : 'Contract';
        const sale = await get('sales', r.related_sale_id);
        const who = (await dog(r.related_dog_id || sale?.dog_id)) || (await contact(r.related_contact_id || sale?.buyer_contact_id));
        return r.title || (who ? `${kind} for ${who}` : kind);
      }
      case 'waitlist_entries': return (await contact(r.contact_id)) || r.application?.name || 'Unnamed applicant';
      case 'waitlist_offers': {
        const e = await get('waitlist_entries', r.entry_id);
        return `Offer to ${(e && ((await contact(e.contact_id)) || e.application?.name)) || 'a family'}`;
      }
      case 'do_not_sell': return r.name || 'A do-not-sell listing';
      default: return r.id;
    }
  };
}

// Everything linked to the start record: { start, items, capped }. Each item:
// { table, id, row, label, kind, ticked, why }. `why` (unticked only) says what
// kept it off: 'time' (added more than WINDOW_DAYS apart) or 'used' (records
// outside the set use it).
export async function gatherLinked(table, id) {
  if (!NODES.has(table)) throw new Error(`The Delete wizard doesn't start from ${table}.`);
  const start = await db.table(table).get(id);
  if (!start) throw new Error('That record is already gone.');
  const label = await labeller();
  const nodes = new Map(); // key → item
  const add = async (t, row, ticked, why) => {
    const item = { table: t, id: row.id, row, label: await label(t, row), kind: ENTITY_LABELS[t]?.replace(/^this /, '') || t, ticked, why: ticked ? null : why };
    nodes.set(key(t, row.id), item);
    return item;
  };
  await add(table, start, true);
  const expanded = new Set();
  const forward = new Map(); // key → { table, row } reached only by pointing at it
  let capped = false;
  for (let changed = true; changed;) {
    changed = false;
    for (const item of [...nodes.values()]) {
      if (!item.ticked || expanded.has(key(item.table, item.id))) continue;
      expanded.add(key(item.table, item.id));
      // Records that point at it: they depend on it.
      for (const { table: t, row } of await referrers(item.table, new Set([item.id]), { own: false })) {
        if (!NODES.has(t)) continue;
        const k = key(t, row.id);
        if (nodes.has(k) && nodes.get(k).ticked) continue;
        if (nodes.size >= MAX_RECORDS) { capped = true; continue; }
        if (nodes.has(k)) { if (withinWindow(row, start)) { nodes.get(k).ticked = true; nodes.get(k).why = null; forward.delete(k); changed = true; } continue; }
        forward.delete(k);
        await add(t, row, withinWindow(row, start), 'time');
        changed = true;
      }
      // Records it points at: decided below, once the set has grown.
      for (const { table: t, id: tid } of pointsAt(item.table, item.row)) {
        const k = key(t, tid);
        if (nodes.has(k) || forward.has(k)) continue;
        const row = await db.table(t).get(tid);
        if (row) forward.set(k, { table: t, row });
      }
    }
    // A record the set points at joins when it was made around the same time and
    // so was everything else that uses it (a test litter's other test pups, which
    // then join as records pointing at it). A real dam is older, and so are her
    // other litters: she stays out.
    for (const [k, { table: t, row }] of forward) {
      if (nodes.size >= MAX_RECORDS) { capped = true; break; }
      if (!withinWindow(row, start)) continue;
      const users = await referrers(t, new Set([row.id]), { own: false });
      // Only records of the kinds offered count: an event or document that merely
      // mentions it (a partner on a real dog's vet visit) just loses the link.
      if (users.some((u) => NODES.has(u.table) && !(nodes.get(key(u.table, u.row.id))?.ticked) && !withinWindow(u.row, start))) continue;
      forward.delete(k);
      await add(t, row, true);
      changed = true;
    }
  }
  // Records the set points at that stay out: listed, unticked, so she sees them.
  for (const { table: t, row } of forward.values()) {
    if (nodes.size >= MAX_RECORDS) { capped = true; break; }
    await add(t, row, false, withinWindow(row, start) ? 'used' : 'time');
  }
  const items = [...nodes.values()];
  return { start: items[0], items, capped };
}

// What deleting `picked` ([{ table, id }]) does: { remove: { table: [ids] },
// counts: { table: n } (the picked records), history: { events, expenses,
// documents, files }, kept: [{ table, id, label, kind, field }] (records that
// stay and lose a link) }.
export async function planLinkedDelete(picked) {
  const remove = {};
  const put = (t, id) => { (remove[t] ||= new Set()).add(id); };
  for (const p of picked) put(p.table, p.id);
  // Their own history.
  for (const [t, ids] of Object.entries({ ...remove })) {
    for (const { table: ht, row } of await referrers(t, new Set(ids), { own: true })) put(ht, row.id);
  }
  // A dog's documents point at their files; an expense at its receipt.
  for (const id of remove.documents || []) { const d = await db.documents.get(id); if (d?.file_id) put('files', d.file_id); }
  for (const id of remove.expenses || []) { const x = await db.expenses.get(id); if (x?.receipt_file_id) put('files', x.receipt_file_id); }
  const out = Object.fromEntries(Object.entries(remove).map(([t, s]) => [t, [...s]]));
  const plan = await planDetach(out, { dropKennelLinks: true });
  const label = await labeller();
  const seen = new Set();
  const kept = [];
  for (const e of plan.edits) {
    const k = key(e.table, e.rowId);
    if (seen.has(k)) continue;
    seen.add(k);
    const row = await db.table(e.table).get(e.rowId);
    if (!row) continue;
    kept.push({ table: e.table, id: e.rowId, label: NODES.has(e.table) ? await label(e.table, row) : (row.title || row.event_type || row.vendor || ''), kind: ENTITY_LABELS[e.table]?.replace(/^this /, '') || e.table, field: e.ref.label });
  }
  // A kept document filed with a deleted contract: its link goes too (not in the registry).
  const contracts = new Set(out.contracts || []);
  if (contracts.size) {
    for (const d of await db.documents.toArray()) {
      if (contracts.has(d.contract_id) && !(remove.documents?.has(d.id))) {
        kept.push({ table: 'documents', id: d.id, label: d.title || 'A document', kind: 'document', field: 'filed with a contract' });
      }
    }
  }
  const counts = Object.fromEntries(NODE_TABLES.map((t) => [t, out[t]?.length || 0]).filter(([, n]) => n));
  const history = { events: out.events?.length || 0, expenses: out.expenses?.length || 0, documents: out.documents?.length || 0, files: out.files?.length || 0 };
  return { remove: out, counts, history, kept };
}

// Delete them. → { removed: n records picked, kept: n records that lost a link,
// entries: the waitlist entries deleted (the page tells the server about online ones) }.
export async function runLinkedDelete(picked) {
  assertWritable();
  const plan = await planLinkedDelete(picked);
  const entries = [];
  for (const id of plan.remove.waitlist_entries || []) { const e = await db.waitlist_entries.get(id); if (e) entries.push(e); }
  await removeDetaching(plan.remove, { dropKennelLinks: true, markChanged: true });
  // A kept document filed with a deleted contract stops naming it, as a contract's own delete does.
  for (const id of plan.remove.contracts || []) await documentRepo.unlinkContract(id);
  return { removed: picked.length, kept: plan.kept.length, entries };
}
