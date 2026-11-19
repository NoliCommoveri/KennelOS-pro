// fureverContentPack.js — builds a pack's manifest (pack.json) and orchestrates
// "Publish to Furever" for one scope (kennel-wide or one litter): ensure the Drive
// folder, upload the chosen documents, share the folder public-by-link, write the
// manifest, and hand back the pointer for the caller to persist (settings.js for
// the kennel-wide pack, litterRepo's `furever_pack` field for a litter pack). See
// docs/KennelOS_Content_Package_Fetch_Mechanism.md §3.1/§3.4/§4.2 for the shapes
// and flow this implements. The Furever console (pages/furever.*) is the only
// caller — it owns picking WHICH documents/uploads go in; this module only knows
// how to publish whatever it's handed.
import { ensureFolder, shareFolderPublic, uploadFile, writeManifestFile, trashFile } from './googleDrive.js';
import { fileRepo } from './fileRepo.js';

const ROOT_FOLDER_NAME = 'KennelOS Furever';
const KENNEL_FOLDER_NAME = 'Kennel-wide';
const litterFolderName = (nickname) => `Litter — ${nickname || 'Untitled'}`;
// A pup's own folder sits beside its litter's under the (unshared) root, never
// inside it: a folder inherits its parent's "anyone with the link", so a pup
// folder inside the litter's could be listed by anyone holding the litter's.
const pupFolderName = (nickname, pupName) => `${litterFolderName(nickname)} — ${pupName || 'Pup'}`;

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
//
// Per-pup packs (K14-3, Review Remainder R6): a litter manifest lists only the
// sire's and dam's documents (shared with every family in the litter). Each pup's
// own documents are in that pup's own folder and manifest (scope 'pup'), whose
// pointer is kept on the litter's furever_pack (`pupManifests`) and handed out
// only in that pup's family seed (fureverSeedExport.js), so no family is ever
// given another pup's file ids. `dogId` on each file and `parentDogIds` stay, so
// Furever can still filter an older litter pack that held every pup's files.
function buildManifest({ packKey, scope, kennelName, version, files, parentDogIds }) {
  return {
    packVersion: 1,
    packKey,
    scope,
    kennelName: kennelName || '',
    version,
    updatedAt: new Date().toISOString(),
    ...(scope === 'litter' ? { parentDogIds: parentDogIds || [] } : {}),
    ...(scope === 'pup' ? { pupId: parentDogIds?.pupId || null } : {}),
    files: files.map((f) => ({
      fileId: f.fileId,
      ...(f.resourceKey ? { resourceKey: f.resourceKey } : {}),
      title: f.title || '',
      docType: f.docType || 'other',
      mime: f.mime || '',
      size: f.size || 0,
      ...(scope !== 'kennel' ? { dogId: f.dogId || null } : {})
    }))
  };
}

// A dog-scoped KennelOS Document, reduced to the bytes + metadata a publish
// needs. `key` is a stable dedupe id across republishes, used to reuse the same
// Drive file id instead of creating a new one every time. `dogId` carries
// through to the manifest for a litter-scope publish's per-pup filtering.
async function loadDocumentSource(doc) {
  const file = doc.file_id ? await fileRepo.get(doc.file_id) : null;
  if (!file || !file.blob) throw new Error(`"${doc.title || 'A document'}" has no stored file to publish.`);
  return {
    key: `doc:${doc.id}`,
    blob: file.blob,
    mime: file.mime || file.blob.type || 'application/octet-stream',
    title: doc.title || file.filename || 'Document',
    docType: doc.doc_type || 'other',
    dogId: doc.dog_id || null
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
//   removedKeys     driveFileIds keys (`doc:<id>` / `upload:<id>`) the breeder
//                    un-ticked/removed since the last publish — their Drive
//                    files get trashed (§below) instead of just quietly
//                    dropping out of the manifest while still sitting shared
//                    in the folder
//   sireId, damId   only used for scope:'litter' — the litter's parents, whose
//                   documents are shared with every pup's family in the litter
//                   (unlike an individual pup's own documents, which are not)
//
// Returns the new pointer to persist (settings.js's contentPack, or the litter's
// furever_pack field) — this module never writes those itself, so it stays
// agnostic to which scope it's publishing.
export async function publishPack({ scope, kennelName, litterNickname, pointer = {}, documents = [], uploads = [], removedKeys = [], sireId = null, damId = null, pupNames = {} }) {
  const packKey = pointer.packKey || crypto.randomUUID();
  const driveFileIds = { ...((pointer.selection && pointer.selection.driveFileIds) || {}) };

  // 0. Trash whatever the breeder removed since the last publish, so a
  // "removed" doc/upload actually stops being reachable instead of just
  // dropping out of the new manifest while its file (and the folder's
  // "anyone with the link" share) stays live in Drive.
  for (const key of removedKeys) {
    const existing = driveFileIds[key];
    if (!existing) continue;
    await trashFile(existing.fileId);
    delete driveFileIds[key];
  }

  // 1. Ensure folders (reuse the cached id — the common case on a republish).
  let folderId = pointer.folderId || null;
  let rootId = null;
  const root = async () => (rootId ||= await ensureFolder(ROOT_FOLDER_NAME));
  if (!folderId) {
    const name = scope === 'litter' ? litterFolderName(litterNickname) : KENNEL_FOLDER_NAME;
    folderId = await ensureFolder(name, await root());
  }

  // 2. Load every chosen source's bytes. A kennel upload only carries a blob
  // when it's new/changed this session — an upload carried forward from a
  // prior publish (the console re-sends its metadata every publish so it
  // isn't silently dropped from the manifest) has none and is handled in 3b.
  const sources = [];
  for (const doc of documents) sources.push(await loadDocumentSource(doc));
  for (const upload of uploads) {
    if (upload.blob) sources.push(loadUploadSource(upload));
  }

  // On a litter, a pup's own document goes to that pup's folder; the sire's and
  // dam's (and any without a dog) to the litter's.
  const parentIds = [sireId, damId].filter(Boolean);
  const pupOf = (src) => (scope === 'litter' && src.dogId && !parentIds.includes(src.dogId) ? src.dogId : null);
  const pupManifests = { ...(pointer.pupManifests || {}) };
  const pupFolder = async (pupId) => {
    if (!pupManifests[pupId]?.folderId) {
      const id = await ensureFolder(pupFolderName(litterNickname, pupNames[pupId]), await root());
      pupManifests[pupId] = { ...(pupManifests[pupId] || {}), folderId: id };
    }
    return pupManifests[pupId].folderId;
  };

  // 3. Upload each — PATCHing the same Drive file id when we've published this
  // exact source before (by its stable key) in the same folder, so a republish
  // doesn't pile up duplicate files; a new/changed source gets created. A pup's
  // document published before per-pup packs sits in the litter's folder: it is
  // uploaded again into the pup's folder and the old copy trashed, so families
  // holding the old litter pack can no longer open it.
  let moved = 0;
  const files = [];
  const pupFiles = {};
  for (const src of sources) {
    const pupId = pupOf(src);
    const target = pupId ? await pupFolder(pupId) : folderId;
    let existing = driveFileIds[src.key];
    if (existing && (existing.folderId || folderId) !== target) {
      await trashFile(existing.fileId);
      if (pupId) moved += 1;
      existing = null;
    }
    const uploaded = await uploadFile({
      folderId: target, name: src.title, blob: src.blob,
      existingFileId: existing ? existing.fileId : null
    });
    driveFileIds[src.key] = { fileId: uploaded.id, resourceKey: uploaded.resourceKey || null, ...(pupId ? { folderId: target } : {}) };
    const file = {
      fileId: uploaded.id, resourceKey: uploaded.resourceKey || null,
      title: src.title, docType: src.docType, mime: src.mime, size: src.blob.size || 0,
      dogId: src.dogId || null
    };
    if (pupId) (pupFiles[pupId] ||= []).push(file);
    else files.push(file);
  }

  // 3b. Carry forward kennel uploads that weren't re-sent this publish (no
  // blob this session, but a Drive file id from a previous one) — otherwise
  // a republish would silently drop them from the manifest even though the
  // Drive file is still sitting in the folder.
  for (const upload of uploads) {
    if (upload.blob) continue;
    const existing = driveFileIds[`upload:${upload.id}`];
    if (!existing) continue;
    files.push({
      fileId: existing.fileId, resourceKey: existing.resourceKey || null,
      title: upload.title || 'File', docType: upload.docType || 'other',
      mime: upload.mime || '', size: upload.size || 0, dogId: null
    });
  }

  // 4. Share the folder public-by-link once; children (files + the manifest)
  // inherit, and re-granting on a republish is harmless. Each pup's folder is
  // shared on its own.
  await shareFolderPublic(folderId);

  // 5. Write the manifests, bumping the CONTENT version so Furever knows to
  // refetch. Every pup that has had a manifest gets one again at the same
  // version (empty when nothing of its is ticked now), so one version check
  // covers the litter's and the pup's.
  const version = (pointer.version || 0) + 1;
  const manifest = buildManifest({ packKey, scope, kennelName, version, files, parentDogIds: parentIds });
  const manifestResult = await writeManifestFile({
    folderId, manifest, existingFileId: pointer.manifestFileId || null
  });
  for (const pupId of new Set([...Object.keys(pupManifests), ...Object.keys(pupFiles)])) {
    const pupFolderId = await pupFolder(pupId);
    await shareFolderPublic(pupFolderId);
    const pupManifest = buildManifest({ packKey, scope: 'pup', kennelName, version, files: pupFiles[pupId] || [], parentDogIds: { pupId } });
    const written = await writeManifestFile({ folderId: pupFolderId, manifest: pupManifest, existingFileId: pupManifests[pupId].manifestFileId || null });
    pupManifests[pupId] = { folderId: pupFolderId, manifestFileId: written.id, manifestResourceKey: written.resourceKey || null };
  }

  // 6. The pointer for the caller to persist. `moved`: pups' documents moved out
  // of the litter's folder this publish (their families need the Furever link sent
  // again to see them).
  return {
    packKey,
    folderId,
    manifestFileId: manifestResult.id,
    manifestResourceKey: manifestResult.resourceKey || null,
    version,
    ...(scope === 'litter' ? { pupManifests } : {}),
    moved,
    selection: {
      documentIds: documents.map((d) => d.id),
      uploads: uploads.map((u) => {
        const uploaded = driveFileIds[`upload:${u.id}`] || {};
        return {
          id: u.id,
          title: u.title,
          docType: u.docType,
          mime: (u.blob && u.blob.type) || u.mime || '',
          size: u.blob ? (u.blob.size || 0) : (u.size || 0),
          drive_file_id: uploaded.fileId || null,
          resourceKey: uploaded.resourceKey || null
        };
      }),
      driveFileIds
    }
  };
}
