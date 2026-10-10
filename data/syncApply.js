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
import { markDataChanged } from './settings.js';
import {
  DOG_REFERENCES, LITTER_REFERENCES, PAIRING_REFERENCES, CONTACT_REFERENCES, KENNEL_REFERENCES,
  SALE_REFERENCES, STUD_SERVICE_REFERENCES, CONTRACT_REFERENCES, EVENT_REFERENCES,
  WAITLIST_ENTRY_REFERENCES, WAITLIST_PROGRAM_REFERENCES, WAITLIST_OFFER_REFERENCES,
  EXPENSE_REFERENCES, BREED_FEEDING_SCHEDULE_REFERENCES, ACCOUNT_REFERENCES, DOCUMENT_REFERENCES,
  findBlockingReferences
} from './referenceRegistry.js';
import { readRecord, cloudFileIds, APPLY_ORDER } from './cloud/syncRecords.js';
import { readSyncMeta, writeSyncMeta, removeSyncMeta, syncRowFor, metaId } from './cloud/syncState.js';
import { decryptFile } from './cloud/vaultCrypto.js';

export const SYNC_APPLIED_EVENT = 'kennelos:syncapplied';

// Each table's hard-delete guard, as its repo uses it (makeRepo).
const REFERENCES = {
  dogs: DOG_REFERENCES, litters: LITTER_REFERENCES, pairings: PAIRING_REFERENCES,
  contacts: CONTACT_REFERENCES, kennels: KENNEL_REFERENCES, sales: SALE_REFERENCES,
  stud_services: STUD_SERVICE_REFERENCES, contracts: CONTRACT_REFERENCES, events: EVENT_REFERENCES,
  waitlist_entries: WAITLIST_ENTRY_REFERENCES, waitlist_programs: WAITLIST_PROGRAM_REFERENCES,
  waitlist_offers: WAITLIST_OFFER_REFERENCES, expenses: EXPENSE_REFERENCES,
  breed_feeding_schedules: BREED_FEEDING_SCHEDULE_REFERENCES, accounts: ACCOUNT_REFERENCES,
  documents: DOCUMENT_REFERENCES
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

// Applies one pulled page. `vault` is this device's { key, keyId }; `fetchFile`
// (sha256) → Blob is cloudApi.getFile with the token. Returns
//   { applied, skipped, keptTheirs: [{ tbl, id, by }], archivedInstead: [{ tbl, id }],
//     missingFiles: [{ tbl, id }] }.
// Throws VaultLockedError when a record is sealed under another key; nothing of
// the page is written then, so the cursor stays and the page is retried.
export async function applyPulledRecords(records, { vault, fetchFile, now = new Date() } = {}) {
  const meta = await readSyncMeta();
  const out = { applied: 0, skipped: 0, keptTheirs: [], archivedInstead: [], missingFiles: [] };

  // 1. Decide every record, outside any transaction.
  const plans = [];
  for (const r of [...records].sort((a, b) => order(a.tbl) - order(b.tbl) || a.seq - b.seq)) {
    const key = metaId(r.tbl, r.id);
    const m = meta.get(key);
    if (m && m.seq >= r.seq) { out.skipped++; continue; } // its own echo, or older than what's here
    const local = await db.table(r.tbl).get(r.id);
    if (r.op === 'delete') {
      if (!local) { plans.push({ kind: 'forget', r }); continue; }
      if (await stillReferenced(r.tbl, r.id)) {
        plans.push({ kind: 'archive', r, row: { ...local, is_archived: true, updated_at: now.toISOString() } });
        out.archivedInstead.push({ tbl: r.tbl, id: r.id });
      } else {
        plans.push({ kind: 'delete', r });
      }
      continue;
    }
    const rec = await readRecord(r, vault);
    let row = rec.row;
    let plainSha256 = null;
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
      }
    }
    // A local edit not pushed yet loses to the server's version (§2.3), and is noted.
    if (local && m) {
      const docs = await db.documents.toArray();
      const localHash = (await syncRowFor(r.tbl, local, cloudFileIds(docs))).hash;
      if (localHash !== m.hash) out.keptTheirs.push({ tbl: r.tbl, id: r.id, by: r.device_id ?? null });
    }
    plans.push({ kind: 'put', r, row, plainSha256 });
  }
  if (!plans.length) return out;

  // The files rule after this page (a document in it may keep or drop a file).
  const docsById = new Map((await db.documents.toArray()).map((d) => [d.id, d]));
  for (const p of plans) {
    if (p.r.tbl !== 'documents') continue;
    if (p.kind === 'put' || p.kind === 'archive') docsById.set(p.r.id, p.row); else docsById.delete(p.r.id);
  }
  const keptFileIds = cloudFileIds([...docsById.values()]);
  const metaPuts = [];
  const metaDrops = [];
  for (const p of plans) {
    if (p.kind === 'put') {
      const { hash } = await syncRowFor(p.r.tbl, p.row, keptFileIds, { plainSha256: p.row.blob ? p.plainSha256 : null });
      metaPuts.push({ tbl: p.r.tbl, row_id: p.r.id, seq: p.r.seq, hash });
    } else {
      // A delete or a forget: nothing to remember. An archive-instead also drops
      // its meta, so the next scan pushes the archived row as a new version.
      metaDrops.push({ tbl: p.r.tbl, row_id: p.r.id });
    }
  }

  // 2. One transaction for the page.
  const tables = [...new Set(plans.map((p) => p.r.tbl))].map((t) => db.table(t));
  await db.transaction('rw', [...tables, db.sync_meta], async () => {
    for (const p of plans) {
      if (p.kind === 'put' || p.kind === 'archive') await db.table(p.r.tbl).put(p.row);
      else if (p.kind === 'delete') await db.table(p.r.tbl).delete(p.r.id);
    }
    await writeSyncMeta(metaPuts);
    await removeSyncMeta(metaDrops);
  });
  out.applied = plans.length;

  // 3. Tell the pages; an archive-instead is a local change to push.
  if (out.archivedInstead.length) markDataChanged();
  const touched = {};
  for (const p of plans) (touched[p.r.tbl] ||= []).push(p.r.id);
  try {
    globalThis.dispatchEvent?.(new CustomEvent(SYNC_APPLIED_EVENT, { detail: { tables: touched } }));
  } catch { /* no window (tests): nothing listens */ }
  return out;
}
