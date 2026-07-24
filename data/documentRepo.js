// documentRepo.js — all Dexie access for the Document table: a filed document
// (pedigree/health test/registration/contract/other) belonging to exactly one
// dog and pointing at exactly one stored file (fileRepo.js). The reverse of
// "a dog's documents" is always this repo's getByDog query — never a stored
// back-pointer on the dog.
//
// A Document is a leaf entity (DOCUMENT_REFERENCES is empty — nothing points
// at one); its own dog_id FK is guarded on Dog via DOG_REFERENCES.
//
// `contract_id` is an OPTIONAL back-link to a Contract (contractRepo.js): a
// document filed *for* a contract (typically a signed PDF, doc_type 'contract')
// carries the contract's id so the Contract detail page can surface it inline
// for view/download. It is a PLAIN, UNINDEXED field — the same posture as
// `expenses.receipt_file_id` — so it is deliberately NOT a referenceRegistry
// entry and needs no schema/index change. The reverse query is getByContract
// (a small in-memory scan); the contract clears the link on its own hardDelete
// (contractRepo.unlinkContract via documentRepo.unlinkContract) so no document
// is ever left pointing at a deleted contract. The document itself always
// stays filed on its dog.
import { db } from './db.js';
import { makeRepo } from './repoBase.js';
import { DOCUMENT_REFERENCES } from './referenceRegistry.js';
import { fileRepo } from './fileRepo.js';

const base = makeRepo('documents', DOCUMENT_REFERENCES);

function validateDocument(candidate) {
  if (!candidate.dog_id) throw new Error('Document: a dog is required.');
  if (!candidate.doc_type) throw new Error('Document: a document type is required.');
  if (!candidate.file_id) throw new Error('Document: a file is required.');
}

function normalize(data) {
  return {
    dog_id: data.dog_id,
    doc_type: data.doc_type || 'other',
    title: String(data.title || '').trim(),
    doc_date: data.doc_date || '',
    issuer_or_lab: String(data.issuer_or_lab || '').trim(),
    result: String(data.result || '').trim(),
    registry: String(data.registry || '').trim(),
    registration_number: String(data.registration_number || '').trim(),
    notes: String(data.notes || '').trim(),
    // Optional back-link to a Contract — plain, unindexed (see header). Preserved
    // across edits because update() re-normalizes { ...existing, ...changes }.
    contract_id: data.contract_id || null,
    file_id: data.file_id
  };
}

export const documentRepo = {
  ...base,

  async create(data) {
    const norm = normalize(data);
    validateDocument(norm);
    return base.create(norm);
  },

  async update(id, changes) {
    const existing = await db.documents.get(id);
    if (!existing) throw new Error(`documents: no record with id ${id}`);
    const merged = normalize({ ...existing, ...changes });
    validateDocument(merged);
    return base.update(id, merged);
  },

  // The reverse query powering the grouped list and the dog detail panel.
  async getByDog(dogId, { includeArchived = false } = {}) {
    const rows = await db.documents.where('dog_id').equals(dogId).toArray();
    const visible = includeArchived ? rows : rows.filter((r) => !r.is_archived);
    return visible.sort((a, b) => (a.doc_date || '') < (b.doc_date || '') ? 1 : -1);
  },

  // Documents filed for a given contract — the reverse of the unindexed
  // contract_id back-link (see header). contract_id has no index, so this is an
  // in-memory scan (documents stay at kennel scale), not an index probe. Powers
  // the Contract detail page's inline view/download.
  async getByContract(contractId, { includeArchived = false } = {}) {
    if (!contractId) return [];
    const rows = await db.documents.toArray();
    const visible = rows.filter((r) =>
      r.contract_id === contractId && (includeArchived || !r.is_archived));
    return visible.sort((a, b) => (a.doc_date || '') < (b.doc_date || '') ? 1 : -1);
  },

  // Clear the contract_id on every document filed for this contract. Called by
  // contractRepo.hardDelete so a deleted contract never leaves a document
  // pointing at it — the document stays filed on its dog, just unlinked.
  async unlinkContract(contractId) {
    if (!contractId) return;
    const rows = await db.documents.toArray();
    for (const r of rows) {
      if (r.contract_id === contractId) await base.update(r.id, { contract_id: null });
    }
  },

  // Hard delete also removes the linked file — a file is owned by exactly one
  // document, so it doesn't get its own referenceRegistry guard.
  async hardDelete(id) {
    const doc = await db.documents.get(id);
    await base.hardDelete(id);
    if (doc?.file_id) await fileRepo.remove(doc.file_id);
  }
};
