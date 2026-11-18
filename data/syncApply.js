// syncApply.js — writes records pulled by live sync into this device (Cloud
// Phase 2 plan §5.3, §5.4).
//
// A DIRECT WRITER of every syncing table, beside importExport.js, and
// deliberately so: pulled rows keep their own `updated_at` / `created_at`, so
// they bypass the repos, and they do NOT call markDataChanged(), because a
// pulled change must not look like a local edit and go back up
// (tests/cloudDirty.test.js lists it with that reason). The one exception is a
// delete that arrives where something now points at the record: it becomes an
// archive of the local row, which IS a local change and is pushed.
//
// Order of work, so the Dexie transaction holds nothing but Dexie calls:
//   1. outside: decrypt each record (syncRecords.readRecord), fetch and open
//      its file, run the reference check for deletes;
//   2. one transaction per page: the writes and their sync_meta rows;
//   3. SYNC_APPLIED_EVENT with the tables and ids touched (§5.3), which pages
//      use for "updated elsewhere"; never CLOUD_DATA_CHANGED_EVENT.
import { db } from './db.js';
import { markDataChanged, noteDataChanged } from './settings.js';
import {
  DOG_REFERENCES, LITTER_REFERENCES, PAIRING_REFERENCES, CONTACT_REFERENCES, KENNEL_REFERENCES,
  SALE_REFERENCES, STUD_SERVICE_REFERENCES, CONTRACT_REFERENCES, EVENT_REFERENCES,
  WAITLIST_ENTRY_REFERENCES, WAITLIST_PROGRAM_REFERENCES, WAITLIST_OFFER_REFERENCES,
  EXPENSE_REFERENCES, BREED_FEEDING_SCHEDULE_REFERENCES, ACCOUNT_REFERENCES, DOCUMENT_REFERENCES, DO_NOT_SELL_REFERENCES,
  findBlockingReferences
} from './referenceRegistry.js';
import { readRecord, cloudFileIds, APPLY_ORDER } from './cloud/syncRecords.js';
import { readSyncMeta, writeSyncMeta, removeSyncMeta, syncRowFor, metaId } from './cloud/syncState.js';
import { decryptFile } from './cloud/vaultCrypto.js';
import { lostRecord } from './cloud/syncLost.js';

export const SYNC_APPLIED_EVENT = 'kennelos:syncapplied';

// Each table's hard-delete guard, as its repo uses it (makeRepo).
const REFERENCES = {
  dogs: DOG_REFERENCES, litters: LITTER_REFERENCES, pairings: PAIRING_REFERENCES,
  contacts: CONTACT_REFERENCES, kennels: KENNEL_REFERENCES, sales: SALE_REFERENCES,
  stud_services: STUD_SERVICE_REFERENCES, contracts: CONTRACT_REFERENCES, events: EVENT_REFERENCES,
  waitlist_entries: WAITLIST_ENTRY_REFERENCES, waitlist_programs: WAITLIST_PROGRAM_REFERENCES,
  waitlist_offers: WAITLIST_OFFER_REFERENCES, expenses: EXPENSE_REFERENCES,
  breed_feeding_schedules: BREED_FEEDING_SCHEDULE_REFERENCES, accounts: ACCOUNT_REFERENCES,
  documents: DOCUMENT_REFERENCES, do_not_sell: DO_NOT_SELL_REFERENCES
};

// Anything still pointing at a record here (§5.4). `files` has no registry (a
// document and its file are deleted together): a document or an expense
// receipt naming it counts.
async function stillReferenced(tbl, id) {
  if (tbl === 'files') {
    const docs = await db.documents.filter((d) => d.file_id === id).count();
    const receipts = await db.expenses.filter((e) => e.receipt_file_id === id).count();
    return docs + receipts > 0;
  }
  const registry = REFERENCES[tbl];
  return registry ? (await findBlockingReferences(registry, id)).length > 0 : false;
}

const order = (tbl) => { const i = APPLY_ORDER.indexOf(tbl); return i === -1 ? APPLY_ORDER.length : i; };

// How far ahead of this device's clock an `updated_at` may be before a join
// stops trusting it (K03 review, 8): a day covers time zones typed by hand.
export const CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

// The join's rule (plan §5.5): does the local row stay over the server's?
// → { keep, suspect } where suspect is 'here' (this row is dated in the future,
// so it never wins) or 'there' (the server's is, so this row stays), or null.
// Compared as times, never as strings ("…T10:00:00Z" vs "…T10:00:00.900Z").
export function joinKeepsLocal(local, row, now = new Date()) {
  const limit = now.getTime() + CLOCK_SKEW_MS;
  const l = Date.parse(local?.updated_at ?? '');
  const s = Date.parse(row?.updated_at ?? '');
  if (l > limit) return { keep: false, suspect: 'here' };
  if (s > limit) return { keep: true, suspect: 'there' };
  return { keep: l > s, suspect: null };
}

// Applies one pulled page. `vault` is this device's { key, keyId }; `fetchFile`
// (sha256) → Blob is cloudApi.getFile with the token. Returns
//   { applied, skipped, keptTheirs: [{ tbl, id, by, op, reason }],
//     replacedMine: [{ tbl, id, by, op }], clock: [{ tbl, id, where }],
//     archivedInstead: [{ tbl, id }], missingFiles: [{ tbl, id }],
//     unknownTables: [{ tbl, seq }], keptOurs }.
//
// What it notes (plan §2.3, K03 review 1, 2, 8):
//   keptTheirs   this device had an edit not sent yet, and another device's
//                version (or delete) took its place; in a join, reason 'older'.
//   replacedMine this device's own sent version was replaced (or deleted) by
//                one built without seeing it: the record's `base_seq` is older
//                than the version this device pushed. Versions from before
//                the Worker kept base_seq carry null and are never reported.
// Each of those (files rows aside) keeps the row as it was here in the
// device-only `sync_lost` table, in the page's transaction, for 30 days, and
// the item carries its id as `lost` (data/cloud/syncLost.js: Put mine back).
//
// `merge: true` is a device joining (plan §5.5, §2.1): nothing is deleted on
// either side, and a row this device has keeps whichever version has the newer
// `updated_at` (joinKeepsLocal; a date in the future never wins). A local row kept
// that way gets the record's seq with the SERVER version's hash, so the next scan
// sees it differ and pushes it as a newer version; a tombstone leaves the local
// row alone with no meta, so it's pushed as a new record. Files always take the
// server's version (they're written once). After the join, server order decides.
// A record for a table this build doesn't have is left out and listed in
// `unknownTables` (cloudSync pulls it again once the app is updated, K03, 3).
// A file whose bytes don't come down lands without them, with a marker in its
// sync_meta that retryMissingFiles reads (K03, 5).
// Throws VaultLockedError when a record is sealed under another key; nothing of
// the page is written then, so the cursor stays and the page is retried.
export async function applyPulledRecords(records, { vault, fetchFile, now = new Date(), merge = false } = {}) {
  const meta = await readSyncMeta();
  const known = new Set(db.tables.map((t) => t.name));
  const out = {
    applied: 0, skipped: 0, keptTheirs: [], replacedMine: [], clock: [], archivedInstead: [], missingFiles: [],
    unknownTables: [], keptOurs: 0
  };
  const lostRows = [];
  // A loss, noted; the version lost here is kept (not a file's bytes).
  const noteLoss = (list, item, local, seq) => {
    if (local && item.tbl !== 'files') {
      const kind = list === 'replacedMine' ? 'replaced_mine' : 'kept_theirs';
      const kept = lostRecord({ tbl: item.tbl, id: item.id, seq, row: local, kind, by: item.by, op: item.op }, now);
      lostRows.push(kept);
      item = { ...item, lost: kept.id };
    }
    out[list].push(item);
  };
  let docs = null;
  const hashOf = async (tbl, row) => {
    docs ||= await db.documents.toArray();
    return (await syncRowFor(tbl, row, cloudFileIds(docs))).hash;
  };

  // 1. Decide every record, outside any transaction.
  const plans = [];
  for (const r of [...records].sort((a, b) => order(a.tbl) - order(b.tbl) || a.seq - b.seq)) {
    if (!known.has(r.tbl)) { out.unknownTables.push({ tbl: r.tbl, seq: r.seq }); continue; }
    const key = metaId(r.tbl, r.id);
    const m = meta.get(key);
    if (m && m.seq >= r.seq) { out.skipped++; continue; } // its own echo, or older than what's here
    const local = await db.table(r.tbl).get(r.id);
    // What this device loses to this version (plain pulls only), noted once the
    // record's outcome is known.
    let loss = null;
    if (local && m && !merge) {
      const item = { tbl: r.tbl, id: r.id, by: r.device_id ?? null, op: r.op };
      if ((await hashOf(r.tbl, local)) !== m.hash) loss = ['keptTheirs', item];
      else if (m.mine && Number.isInteger(r.base_seq) && r.base_seq < m.seq) loss = ['replacedMine', item];
    }
    if (r.op === 'delete') {
      if (merge && local) { out.skipped++; continue; } // nothing is deleted by a join
      if (!local) { plans.push({ kind: 'forget', r }); continue; }
      if (await stillReferenced(r.tbl, r.id)) {
        // Archived, not deleted: the row here (and any edit in it) stays.
        plans.push({ kind: 'archive', r, row: { ...local, is_archived: true, updated_at: now.toISOString() } });
        out.archivedInstead.push({ tbl: r.tbl, id: r.id });
      } else {
        plans.push({ kind: 'delete', r });
        if (loss) noteLoss(loss[0], loss[1], local, r.seq);
      }
      continue;
    }
    if (loss) noteLoss(loss[0], loss[1], local, r.seq);
    const rec = await readRecord(r, vault);
    let row = rec.row;
    if (merge && local && r.tbl !== 'files') {
      const join = joinKeepsLocal(local, row, now);
      if (join.suspect) out.clock.push({ tbl: r.tbl, id: r.id, where: join.suspect });
      if (join.keep) {
        plans.push({ kind: 'keep', r, row });
        out.keptOurs++;
        continue;
      }
      // The server's version replaces a different one here: say so.
      if (!join.suspect && (await hashOf(r.tbl, local)) !== (await hashOf(r.tbl, row))) {
        noteLoss('keptTheirs', { tbl: r.tbl, id: r.id, by: r.device_id ?? null, op: 'put', reason: 'older' }, local, r.seq);
      }
    }
    let plainSha256 = null;
    let missingFile = null;
    if (rec.fileRef) {
      try {
        const sealedBytes = new Uint8Array(await (await fetchFile(rec.fileRef.sha256)).arrayBuffer());
        const bytes = rec.fileRef.encrypted
          ? await decryptFile(vault.key, vault.keyId, sealedBytes, { plainSha256: rec.fileRef.plain_sha256 })
          : sealedBytes;
        row = { ...row, blob: new Blob([bytes], { type: row.mime || 'application/octet-stream' }) };
        plainSha256 = rec.fileRef.plain_sha256;
      } catch {
        out.missingFiles.push({ tbl: r.tbl, id: r.id }); // the row lands without its bytes
        missingFile = rec.fileRef; // …and retryMissingFiles fetches them later
      }
    }
    plans.push({ kind: 'put', r, row, plainSha256, missingFile });
  }
  if (!plans.length) return out;

  // The files rule after this page (a document in it may keep or drop a file).
  const docsById = new Map((await db.documents.toArray()).map((d) => [d.id, d]));
  for (const p of plans) {
    if (p.r.tbl !== 'documents') continue;
    if (p.kind === 'keep') continue;
    if (p.kind === 'put' || p.kind === 'archive') docsById.set(p.r.id, p.row); else docsById.delete(p.r.id);
  }
  const keptFileIds = cloudFileIds([...docsById.values()]);
  const metaPuts = [];
  const metaDrops = [];
  for (const p of plans) {
    if (p.kind === 'put' || p.kind === 'keep') {
      // A kept local row is remembered as the server's version, so it's pushed.
      const { hash } = await syncRowFor(p.r.tbl, p.row, keptFileIds, { plainSha256: p.row.blob ? p.plainSha256 : null });
      metaPuts.push({ tbl: p.r.tbl, row_id: p.r.id, seq: p.r.seq, hash, ...(p.missingFile ? { missing_file: p.missingFile } : {}) });
    } else {
      // A delete or a forget: nothing to remember. An archive-instead also drops
      // its meta, so the next scan pushes the archived row as a new version.
      metaDrops.push({ tbl: p.r.tbl, row_id: p.r.id });
    }
  }

  // 2. One transaction for the page.
  const tables = [...new Set(plans.map((p) => p.r.tbl))].map((t) => db.table(t));
  await db.transaction('rw', [...tables, db.sync_meta, db.sync_lost], async () => {
    if (lostRows.length) await db.sync_lost.bulkPut(lostRows);
    for (const p of plans) {
      if (p.kind === 'put' || p.kind === 'archive') await db.table(p.r.tbl).put(p.row);
      else if (p.kind === 'delete') await db.table(p.r.tbl).delete(p.r.id);
    }
    await writeSyncMeta(metaPuts);
    await removeSyncMeta(metaDrops);
  });
  out.applied = plans.filter((p) => p.kind !== 'keep').length;

  // 3. Tell the pages; an archive-instead is a local change to push. Records that
  // came in still count as changed here (noteDataChanged, without the push flag),
  // so a kept answer that read them (the website strip) is worked out again.
  if (out.archivedInstead.length) markDataChanged();
  else if (out.applied) noteDataChanged();
  const touched = {};
  for (const p of plans) if (p.kind !== 'keep') (touched[p.r.tbl] ||= []).push(p.r.id);
  announce(touched);
  return out;
}

function announce(touched) {
  try {
    globalThis.dispatchEvent?.(new CustomEvent(SYNC_APPLIED_EVENT, { detail: { tables: touched } }));
  } catch { /* no window (tests): nothing listens */ }
}

// Files that landed without their bytes (a failed download, K03 review 5): try
// each again. A row written once never changes, so waiting for "the next time it
// changes" would wait for ever. → { fetched: [{ tbl, id }], still: n }. A file
// row since removed or given bytes here is forgotten; one that fails again keeps
// its marker for the next pull.
export async function retryMissingFiles({ vault, fetchFile }) {
  const waiting = [...(await readSyncMeta()).values()].filter((m) => m.missing_file);
  const out = { fetched: [], still: 0 };
  if (!waiting.length) return out;
  const docs = await db.documents.toArray();
  const keptFileIds = cloudFileIds(docs);
  for (const m of waiting) {
    const local = await db.table(m.tbl).get(m.row_id);
    const { missing_file: _gone, ...plain } = m;
    if (!local || local.blob instanceof Blob) { await writeSyncMeta([plain]); continue; }
    const ref = m.missing_file;
    let blob;
    try {
      const sealedBytes = new Uint8Array(await (await fetchFile(ref.sha256)).arrayBuffer());
      const bytes = ref.encrypted ? await decryptFile(vault.key, vault.keyId, sealedBytes, { plainSha256: ref.plain_sha256 }) : sealedBytes;
      blob = new Blob([bytes], { type: local.mime || 'application/octet-stream' });
    } catch {
      out.still++;
      continue;
    }
    const row = { ...local, blob };
    const { hash } = await syncRowFor(m.tbl, row, keptFileIds, { plainSha256: ref.plain_sha256 });
    await db.transaction('rw', [db.table(m.tbl), db.sync_meta], async () => {
      await db.table(m.tbl).put(row);
      await writeSyncMeta([{ ...plain, hash }]);
    });
    out.fetched.push({ tbl: m.tbl, id: m.row_id });
  }
  if (out.fetched.length) announce({ files: out.fetched.map((f) => f.id) });
  return out;
}
