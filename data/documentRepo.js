// documentRepo.js — all Dexie access for the Document table: a filed document
// (pedigree/health test/registration/contract/other) belonging to exactly one
// dog and pointing at exactly one stored file (fileRepo.js). The reverse of
// "a dog's documents" is always this repo's getByDog query — never a stored
// back-pointer on the dog.
//
// A Document is a leaf entity (DOCUMENT_REFERENCES is empty — nothing points
// at one); its own dog_id FK is guarded on Dog via DOG_REFERENCES.
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

  // Hard delete also removes the linked file — a file is owned by exactly one
  // document, so it doesn't get its own referenceRegistry guard.
  async hardDelete(id) {
    const doc = await db.documents.get(id);
    await base.hardDelete(id);
    if (doc?.file_id) await fileRepo.remove(doc.file_id);
  }
};
