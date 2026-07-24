// fureverContentPack.js — builds a pack's manifest (pack.json) and orchestrates
// "Publish to Furever" for one scope (kennel-wide or one litter): ensure the Drive
// folder, upload the chosen documents, share the folder public-by-link, write the
// manifest, and hand back the pointer for the caller to persist (settings.js for
// the kennel-wide pack, litterRepo's `furever_pack` field for a litter pack). See
// docs/KennelOS_Content_Package_Fetch_Mechanism.md §3.1/§3.4/§4.2 for the shapes
// and flow this implements. The Furever console (pages/furever.*) is the only
// caller — it owns picking WHICH documents/uploads go in; this module only knows
// how to publish whatever it's handed.
import { ensureFolder, shareFolderPublic, uploadFile, writeManifestFile } from './googleDrive.js';
import { fileRepo } from './fileRepo.js';

const ROOT_FOLDER_NAME = 'KennelOS Furever';
const KENNEL_FOLDER_NAME = 'Kennel-wide';
const litterFolderName = (nickname) => `Litter — ${nickname || 'Untitled'}`;

// Doc types that typically carry buyer PII — the picker leaves these unchecked by
// default and requires an explicit "this becomes public" confirmation to include
// (§4.2 step 2, §6). The console (UI layer) is what actually enforces the
// unchecked-by-default + confirm gesture; this list is shared so the picker and
// any future check agree on exactly which types count as sensitive.
export const SENSITIVE_DOC_TYPES = ['contract'];

export function isSensitiveDocType(docType) {
  return SENSITIVE_DOC_TYPES.includes(docType);
}

// Build pack.json (§3.1) BY NAME from the chosen files — never a record spread,
// so a Document/upload field never rides along into a publicly-readable file by
// accident (the same allow-list discipline fureverSeedExport.js's header
// explains for the seed packet).
function buildManifest({ packKey, scope, kennelName, version, files }) {
  return {
    packVersion: 1,
    packKey,
    scope,
    kennelName: kennelName || '',
    version,
    updatedAt: new Date().toISOString(),
    files: files.map((f) => ({
      fileId: f.fileId,
      ...(f.resourceKey ? { resourceKey: f.resourceKey } : {}),
      title: f.title || '',
      docType: f.docType || 'other',
      mime: f.mime || '',
      size: f.size || 0
    }))
  };
}

// A dog-scoped KennelOS Document, reduced to the bytes + metadata a publish
// needs. `key` is a stable dedupe id across republishes, used to reuse the same
// Drive file id instead of creating a new one every time.
async function loadDocumentSource(doc) {
  const file = doc.file_id ? await fileRepo.get(doc.file_id) : null;
  if (!file || !file.blob) throw new Error(`"${doc.title || 'A document'}" has no stored file to publish.`);
  return {
    key: `doc:${doc.id}`,
    blob: file.blob,
    mime: file.mime || file.blob.type || 'application/octet-stream',
    title: doc.title || file.filename || 'Document',
    docType: doc.doc_type || 'other'
  };
}

// A kennel-level "Upload new" item (no dog record) — care guide, poison list, a
// blank guarantee template. `upload.id` is a stable id the console assigns the
// pending item so a republish can still reuse its Drive file.
function loadUploadSource(upload) {
  return {
    key: `upload:${upload.id}`,
    blob: upload.blob,
    mime: (upload.blob && upload.blob.type) || 'application/octet-stream',
    title: upload.title || (upload.blob && upload.blob.name) || 'File',
    docType: upload.docType || 'other'
  };
}

// Publish one pack. `pointer` is whatever's already persisted for this scope
// (§3.4 shape: packKey/folderId/manifestFileId/manifestResourceKey/version/
// selection), or `{}` for a first-ever publish — folders/files are created as
// needed and cached ids are reused so a republish is incremental (§4.2 step 1/3).
//
//   scope           'kennel' | 'litter'
//   kennelName      for the manifest's display field
//   litterNickname  only used for scope:'litter' (the Drive folder name)
//   documents       KennelOS Document rows the breeder ticked (dog-scoped)
//   uploads         [{ id, title, docType, blob }] kennel-scope "Upload new" items
//
// Returns the new pointer to persist (settings.js's contentPack, or the litter's
// furever_pack field) — this module never writes those itself, so it stays
// agnostic to which scope it's publishing.
export async function publishPack({ scope, kennelName, litterNickname, pointer = {}, documents = [], uploads = [] }) {
  const packKey = pointer.packKey || crypto.randomUUID();
  const driveFileIds = { ...((pointer.selection && pointer.selection.driveFileIds) || {}) };

  // 1. Ensure folders (reuse the cached id — the common case on a republish).
  let folderId = pointer.folderId || null;
  if (!folderId) {
    const rootId = await ensureFolder(ROOT_FOLDER_NAME);
    const name = scope === 'litter' ? litterFolderName(litterNickname) : KENNEL_FOLDER_NAME;
    folderId = await ensureFolder(name, rootId);
  }

  // 2. Load every chosen source's bytes.
  const sources = [];
  for (const doc of documents) sources.push(await loadDocumentSource(doc));
  for (const upload of uploads) sources.push(loadUploadSource(upload));

  // 3. Upload each — PATCHing the same Drive file id when we've published this
  // exact source before (by its stable key), so a republish doesn't pile up
  // duplicate files in the folder; a genuinely new/changed source gets created.
  const files = [];
  for (const src of sources) {
    const existing = driveFileIds[src.key];
    const uploaded = await uploadFile({
      folderId, name: src.title, blob: src.blob,
      existingFileId: existing ? existing.fileId : null
    });
    driveFileIds[src.key] = { fileId: uploaded.id, resourceKey: uploaded.resourceKey || null };
    files.push({
      fileId: uploaded.id, resourceKey: uploaded.resourceKey || null,
      title: src.title, docType: src.docType, mime: src.mime, size: src.blob.size || 0
    });
  }

  // 4. Share the folder public-by-link once; children (files + the manifest)
  // inherit, and re-granting on a republish is harmless.
  await shareFolderPublic(folderId);

  // 5. Write the manifest, bumping the CONTENT version so Furever knows to refetch.
  const version = (pointer.version || 0) + 1;
  const manifest = buildManifest({ packKey, scope, kennelName, version, files });
  const manifestResult = await writeManifestFile({
    folderId, manifest, existingFileId: pointer.manifestFileId || null
  });

  // 6. The pointer for the caller to persist.
  return {
    packKey,
    folderId,
    manifestFileId: manifestResult.id,
    manifestResourceKey: manifestResult.resourceKey || null,
    version,
    selection: {
      documentIds: documents.map((d) => d.id),
      uploads: uploads.map((u) => ({
        id: u.id,
        title: u.title,
        docType: u.docType,
        drive_file_id: (driveFileIds[`upload:${u.id}`] || {}).fileId || null,
        resourceKey: (driveFileIds[`upload:${u.id}`] || {}).resourceKey || null
      })),
      driveFileIds
    }
  };
}
