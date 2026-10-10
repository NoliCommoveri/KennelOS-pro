// syncRecords.js — one record on the wire for live sync (Cloud Phase 2 plan §4),
// and the hash that tells a changed row from an unchanged one (§3.3).
//
// No db, no network: rows in, records out, so it's unit-tested in Node
// (tests/syncRecords.test.js). syncState.js reads the rows and the device's
// sync_meta; cloudSync.js sends and receives.
//
// A record:
//   { tbl, id, op: 'put' | 'delete', base_seq,
//     cloud:  the Phase 1 snapshot row (syncRegistry.projectRow, checked by
//             assertCloudRow), or null when the row rule keeps nothing;
//     sealed: the WHOLE row as JSON, encrypted with the vault key (base64 of a
//             vaultCrypto payload envelope), or null for a delete;
//     key_id, updated_at, and for `files` file: the /files id of its bytes }
//
// Files: a `files` row never carries its blob on the wire. Before anything else
// it becomes a "sync row" (prepareFileRow): the blob is replaced by
// `vault_file: { plain_sha256 }`, exactly as the vault payload does (Private
// Vault Plan §4.2), and sealFileRow then says where the bytes live:
//   - a cloud-tier file (kept by a pedigree / health test / registration
//     document) is uploaded as is, so `vault_file.sha256 = plain_sha256`
//     (encrypted: false), and the cloud part carries `sha256`;
//   - every other file is encrypted deterministically with the vault key
//     (encryptFile), so an unchanged file has the same /files id every time.
import {
  keepsRow, projectRow, assertCloudRow, REGISTRY_TABLES
} from '../syncRegistry.js';
import { encryptPayload, decryptPayload, encryptFile, toBase64, fromBase64 } from './vaultCrypto.js';

export const RECORD_FORMAT = 1;

// The tables that sync: every table the JSON backup carries (syncRegistry has
// an entry for each; device-only tables have none).
export const SYNC_TABLES = REGISTRY_TABLES;

// Pulled pages are applied with the tables other rows point at first (§5.3).
export const APPLY_ORDER = Object.freeze([
  'kennels', 'contacts', 'accounts', 'files', 'dogs', 'pairings', 'litters', 'sales',
  'stud_services', 'contracts', 'documents', 'events', 'expenses',
  'breed_feeding_schedules', 'waitlist_programs', 'waitlist_entries', 'waitlist_offers'
]);

const enc = new TextEncoder();
const dec = new TextDecoder();

// --- Canonical JSON and the row hash ---------------------------------------------
// Keys sorted at every level, so two equal rows hash the same whatever order
// their fields were written in. Arrays keep their order (it's data). undefined
// is dropped, as JSON.stringify drops it.
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (typeof Blob !== 'undefined' && value instanceof Blob) throw new TypeError('canonicalJson: a Blob has no JSON form');
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

// SHA-256 of the row's canonical JSON. `extra` is anything else that decides
// what the record looks like on the wire, so a change to it re-sends the row:
// a file's classification (a file is cloud only while a cloud document keeps
// it, plan §4.1).
export async function rowHash(table, syncRow, extra = null) {
  const text = canonicalJson({ t: table, r: syncRow, x: extra });
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

// --- Files -------------------------------------------------------------------------
// A files row as it syncs: no blob, `vault_file: { plain_sha256 }` in its place.
// `plainSha256` is the blob's own SHA-256 (the caller caches it). A row with no
// bytes on this device syncs without `vault_file`.
export function prepareFileRow(row, plainSha256) {
  const { blob, ...rest } = row;
  if (!plainSha256) return rest;
  return { ...rest, vault_file: { plain_sha256: plainSha256 } };
}

// Where a file's bytes go: → { row (with vault_file filled in), upload: { sha256,
// size, mime, blob } | null }. `cloud` = a cloud document keeps it.
export async function sealFileRow(syncRow, blob, vault, { cloud = false } = {}) {
  const plain = syncRow.vault_file?.plain_sha256;
  if (!plain || !blob) return { row: syncRow, upload: null };
  if (cloud) {
    return {
      row: { ...syncRow, vault_file: { sha256: plain, plain_sha256: plain, encrypted: false } },
      upload: { sha256: plain, size: blob.size, mime: blob.type || syncRow.mime || 'application/octet-stream', blob }
    };
  }
  const sealed = await encryptFile(vault.key, vault.keyId, new Uint8Array(await blob.arrayBuffer()));
  return {
    row: { ...syncRow, vault_file: { sha256: sealed.sha256, plain_sha256: plain, encrypted: true } },
    upload: { sha256: sealed.sha256, size: sealed.bytes.length, mime: 'application/octet-stream', blob: new Blob([sealed.bytes], { type: 'application/octet-stream' }) }
  };
}

// The cloud document ids that keep a file in the cloud tier (Phase 1 §5): the
// file ids referenced by documents the registry keeps.
export function cloudFileIds(documents = []) {
  return new Set(documents.filter((d) => keepsRow('documents', d)).map((d) => d.file_id).filter(Boolean));
}

// --- Building a record ---------------------------------------------------------------
// `syncRow` is the row as it syncs (a files row already through sealFileRow).
// `ctx.keptFileIds` decides the files rule. Throws CloudKeyError (syncRegistry)
// if the cloud part would carry a key it may not.
export async function buildPutRecord(table, syncRow, vault, { baseSeq = 0, keptFileIds = new Set() } = {}) {
  if (!SYNC_TABLES.includes(table)) throw new Error(`syncRecords: "${table}" doesn't sync`);
  if (!vault || !vault.key || !vault.keyId) throw new Error('syncRecords: a put needs the vault key');
  let cloud = null;
  if (keepsRow(table, syncRow, { keptFileIds })) {
    cloud = projectRow(table, syncRow);
    if (table === 'files') {
      if (syncRow.vault_file?.encrypted === false) cloud.sha256 = syncRow.vault_file.sha256;
      else cloud = null; // a cloud file with no bytes here: nothing readable to send
    }
    if (cloud) assertCloudRow(table, cloud);
  }
  const bytes = await encryptPayload(vault.key, vault.keyId, enc.encode(JSON.stringify({ f: RECORD_FORMAT, t: table, r: syncRow })));
  return {
    tbl: table, id: syncRow.id, op: 'put', base_seq: baseSeq,
    cloud, sealed: toBase64(bytes), key_id: vault.keyId, updated_at: syncRow.updated_at ?? null,
    // A files record names the /files id its bytes are under (a hash of ciphertext
    // for a private file), so the server keeps them while the record lives.
    ...(table === 'files' ? { file: syncRow.vault_file?.sha256 ?? null } : {})
  };
}

export function buildDeleteRecord(table, id, { baseSeq = 0 } = {}) {
  return { tbl: table, id, op: 'delete', base_seq: baseSeq, cloud: null, sealed: null, key_id: null, updated_at: null };
}

// --- Reading a record back -----------------------------------------------------------
// → { table, id, deleted: true } or { table, id, row, fileRef } where `row` is the
// local row to write (a files row without its blob yet) and `fileRef` is its
// vault_file ({ sha256, plain_sha256, encrypted }) for the caller to fetch.
// Throws VaultLockedError when `vault` doesn't open it (another key).
export async function readRecord(record, vault) {
  if (record.deleted || record.op === 'delete') return { table: record.tbl, id: record.id, deleted: true };
  const plain = await decryptPayload(vault.key, vault.keyId, fromBase64(record.sealed));
  const body = JSON.parse(dec.decode(plain));
  if (body.f !== RECORD_FORMAT || body.t !== record.tbl || !body.r || body.r.id !== record.id) {
    throw new Error(`syncRecords: record ${record.tbl}/${record.id} doesn't match its contents`);
  }
  const row = body.r;
  if (record.tbl !== 'files' || !row.vault_file) return { table: record.tbl, id: record.id, row, fileRef: null };
  const { vault_file: fileRef, ...rest } = row;
  return { table: record.tbl, id: record.id, row: rest, fileRef, syncRow: row };
}
