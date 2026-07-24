// furever.js — the Furever console: configure the kennel-wide seed-link identity
// once, then send/resend each pup's KennelOS Furever seed link.
//
// Recipients are pups with an OPEN sale (saleRepo.isOpenSale — same membership
// predicate Companion's "family" package uses) since a seed link is inherently
// about a specific placement: the family it's going home with. "Prepare link"
// persists whatever note/pickup details are on screen (furever_note/furever_
// pickup_* — plain Sale fields, no schema change) then builds the packet
// (fureverSeedExport.js), compresses it, and hands off a real sms:/mailto:
// anchor — same activating-gesture rule as Companion (brief §5.2 there).
import { saleRepo } from '../data/saleRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { documentRepo } from '../data/documentRepo.js';
import { getFureverSettings, setFureverSettings, getMyKennelId, getMyContactId } from '../data/settings.js';
import { buildSeedPacket, FUREVER_APP_URL } from '../data/fureverSeedExport.js';
import { connectDrive, isDriveConnectedThisSession } from '../data/googleDrive.js';
import { publishPack, isSensitiveDocType } from '../data/fureverContentPack.js';
import { breedFeedingScheduleRepo } from '../data/breedFeedingScheduleRepo.js';
import { DOC_TYPES, descriptor, docTypeIcon } from '../data/vocab.js';
import { compressToEncodedURIComponent } from '../vendor/lz-string.min.mjs';
import { esc, badge } from '../assets/ui.js';

// Same payload ceilings Companion uses (brief §6.1) — SMS gateways are the weak
// link; a seed packet (~1.7K per the schema doc's own measurement) sits well
// under both, but a long personal note could push it, so warn rather than trust.
const MAX_SMS_HASH_LEN = 1800;
const MAX_EMAIL_HASH_LEN = 12000;

const els = {
  error: document.getElementById('page-error'),
  nudges: document.getElementById('setup-nudges'),
  identity: document.getElementById('identity'),
  recipients: document.getElementById('recipients'),
  contentPackages: document.getElementById('content-packages-body')
};

function showError(msg) { els.error.innerHTML = `<div class="inline-error">${esc(msg)}</div>`; }
function clearError() { els.error.innerHTML = ''; }

// --- Kennel identity card ----------------------------------------------------
// The identity is entered once and copied into every seed packet. Most of it is
// already in the breeder's KennelOS records (My Kennel, their owner Contact, their
// vet Contacts), so we PREFILL from there rather than making them retype it. This
// stays non-binding to that data (settings.js note: Furever must work even if
// Kennel Setup was skipped) — prefill only fills blanks, and everything stays
// editable and saved in Furever's own settings block.

// A vet Contact flattened to the three fields the identity card holds. The
// multi-line contact address collapses to one line (the card's a single input).
function vetToFields(v) {
  return {
    name: v.name || '',
    phone: v.phone || '',
    address: (v.address || '').replace(/\s*\n+\s*/g, ', ').trim()
  };
}

// Values already on file elsewhere in KennelOS, offered as prefill defaults + the
// vet-picker list. `getMyKennelId`/`getMyContactId` are the same records Kennel
// Setup manages; vets are any Contact tagged with the 'vet' role.
async function loadIdentityContext() {
  const kennelId = getMyKennelId();
  const contactId = getMyContactId();
  const [kennel, owner, allContacts] = await Promise.all([
    kennelId ? kennelRepo.getById(kennelId) : null,
    contactId ? contactRepo.getById(contactId) : null,
    contactRepo.getAll()
  ]);
  const vets = allContacts.filter((c) => (c.contact_type || []).includes('vet'));
  return {
    defaults: {
      kennelName: (kennel && kennel.kennel_name) || '',
      breederContact: {
        name: (owner && owner.name) || '',
        phone: (owner && owner.phone) || '',
        email: (owner && owner.email) || ''
      }
    },
    vets
  };
}

function identityCardHtml(s, vets, selectedVetId) {
  const vetOptions = [`<option value="">— Enter manually —</option>`]
    .concat(vets.map((v) => `<option value="${esc(v.id)}"${v.id === selectedVetId ? ' selected' : ''}>${esc(v.name || 'Unnamed vet')}</option>`))
    .join('');
  const vetPicker = vets.length
    ? `<div class="field field-wide"><label>Pick from your vet contacts</label><select class="id-bv-picker">${vetOptions}</select></div>`
    : '';
  return `
    <div class="form-grid">
      <div class="field"><label>Kennel name</label><input class="id-kennelName" type="text" value="${esc(s.kennelName)}"></div>
      <div class="field"><label>Tagline</label><input class="id-tagline" type="text" value="${esc(s.tagline)}"></div>
      <div class="field"><label>Your name</label><input class="id-bc-name" type="text" value="${esc(s.breederContact.name)}"></div>
      <div class="field"><label>Your phone</label><input class="id-bc-phone" type="text" value="${esc(s.breederContact.phone)}"></div>
      <div class="field field-wide"><label>Your email</label><input class="id-bc-email" type="email" value="${esc(s.breederContact.email)}"></div>
      ${vetPicker}
      <div class="field"><label>Your vet's name</label><input class="id-bv-name" type="text" value="${esc(s.breederVet.name)}"></div>
      <div class="field"><label>Your vet's phone</label><input class="id-bv-phone" type="text" value="${esc(s.breederVet.phone)}"></div>
      <div class="field field-wide"><label>Your vet's address</label><input class="id-bv-address" type="text" value="${esc(s.breederVet.address)}"></div>
    </div>
    <div style="margin-top:8px;"><button class="btn btn-primary btn-sm" id="id-save">Save kennel identity</button> <span class="muted" id="id-saved"></span></div>`;
}

// Match a saved vet name back to a Contact so re-opening the console re-selects it
// in the picker (best-effort, case-insensitive on name — the identity block stores
// no contact id, deliberately).
function matchVetId(vets, vetName) {
  const key = (vetName || '').trim().toLowerCase();
  if (!key) return '';
  const hit = vets.find((v) => (v.name || '').trim().toLowerCase() === key);
  return hit ? hit.id : '';
}

async function renderIdentity() {
  const { defaults, vets } = await loadIdentityContext();
  let s = getFureverSettings();

  // Seed blanks from the breeder's records once, and persist so Prepare link works
  // without a manual save. Non-destructive: only empty fields are filled.
  const prefill = {};
  if (!s.kennelName && defaults.kennelName) prefill.kennelName = defaults.kennelName;
  const bc = {};
  if (!s.breederContact.name && defaults.breederContact.name) bc.name = defaults.breederContact.name;
  if (!s.breederContact.phone && defaults.breederContact.phone) bc.phone = defaults.breederContact.phone;
  if (!s.breederContact.email && defaults.breederContact.email) bc.email = defaults.breederContact.email;
  if (Object.keys(bc).length) prefill.breederContact = bc;
  if (!s.breederVet.name && vets.length === 1) prefill.breederVet = vetToFields(vets[0]);
  const didPrefill = Object.keys(prefill).length > 0;
  if (didPrefill) s = setFureverSettings(prefill);

  const selectedVetId = matchVetId(vets, s.breederVet.name);
  els.identity.innerHTML = identityCardHtml(s, vets, selectedVetId);
  wireIdentity(vets);
  if (didPrefill) {
    const saved = document.getElementById('id-saved');
    saved.textContent = 'Prefilled from your kennel records — review and Save.';
  }
  return vets;
}

function wireIdentity(vets) {
  const picker = els.identity.querySelector('.id-bv-picker');
  if (picker) {
    picker.addEventListener('change', () => {
      const v = vets.find((x) => x.id === picker.value);
      if (!v) return; // "Enter manually" — leave the fields as the breeder left them
      const f = vetToFields(v);
      els.identity.querySelector('.id-bv-name').value = f.name;
      els.identity.querySelector('.id-bv-phone').value = f.phone;
      els.identity.querySelector('.id-bv-address').value = f.address;
    });
  }
  document.getElementById('id-save').addEventListener('click', () => {
    setFureverSettings({
      kennelName: els.identity.querySelector('.id-kennelName').value.trim(),
      tagline: els.identity.querySelector('.id-tagline').value.trim(),
      breederContact: {
        name: els.identity.querySelector('.id-bc-name').value.trim(),
        phone: els.identity.querySelector('.id-bc-phone').value.trim(),
        email: els.identity.querySelector('.id-bc-email').value.trim()
      },
      breederVet: {
        name: els.identity.querySelector('.id-bv-name').value.trim(),
        phone: els.identity.querySelector('.id-bv-phone').value.trim(),
        address: els.identity.querySelector('.id-bv-address').value.trim()
      }
    });
    const saved = document.getElementById('id-saved');
    saved.textContent = 'Saved.';
    setTimeout(() => { saved.textContent = ''; }, 2000);
  });
}

// --- Recipients: one row per pup with an open sale --------------------------
let ctx = []; // [{ sale, dog, buyer }]

async function loadData() {
  const sales = (await saleRepo.getAll({ includeArchived: true })).filter(saleRepo.isOpenSale);
  const rows = [];
  for (const sale of sales) {
    const dog = sale.dog_id ? await dogRepo.getById(sale.dog_id) : null;
    if (!dog) continue;
    const buyer = sale.buyer_contact_id ? await contactRepo.getById(sale.buyer_contact_id) : null;
    rows.push({ sale, dog, buyer });
  }
  rows.sort((a, b) => (a.dog.call_name || '').localeCompare(b.dog.call_name || '', undefined, { numeric: true }));
  ctx = rows;
}

// --- Setup nudges: subtle, dismissible-by-fixing reminders for the pieces the
// Furever seed packet can carry but hasn't been given yet. Never blocking —
// sending a link works fine without either; these just flag "you could add
// this." Vet is kennel-wide (one check); the feeding schedule check is scoped
// to breeds actually among today's recipients, so it stays relevant to what's
// about to ship rather than nagging about breeds you don't currently have pups
// for.
async function renderSetupNudges(vets) {
  if (!els.nudges) return;
  const items = [];
  if (!vets.length) {
    items.push(`No vet contact on file. <a href="contact.html?new=1">Add one now →</a>`);
  }
  const breeds = [...new Set(ctx.map((r) => (r.dog.breed || '').trim()).filter(Boolean))];
  const missingBreeds = [];
  for (const breed of breeds) {
    if (!(await breedFeedingScheduleRepo.getByBreed(breed))) missingBreeds.push(breed);
  }
  if (missingBreeds.length) {
    items.push(`No feeding schedule configured for ${missingBreeds.map((b) => esc(b)).join(', ')}. <a href="breed-feeding-schedules.html">Configure now →</a>`);
  }
  els.nudges.innerHTML = items.length
    ? `<div class="card" style="border-left:3px solid var(--amber, #d97706);">${items.map((i) => `<p class="muted" style="margin:4px 0;">${i}</p>`).join('')}</div>`
    : '';
}

function recipientRow({ sale, dog, buyer }) {
  const buyerLabel = buyer ? esc(buyer.name) : 'no buyer on file';
  return `
    <div class="card" data-sale="${esc(sale.id)}" style="margin-top:12px;">
      <div class="r-header" style="display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none;">
        <span class="r-arrow" style="display:inline-block; transition:transform 0.2s; font-size:12px;">▶</span>
        <div class="row-between" style="flex:1; gap:8px;">
          <span><strong>${esc(dog.call_name || 'Puppy')}</strong></span>
          <span class="muted">${buyerLabel}</span>
        </div>
      </div>
      <div class="r-body" style="display:none; margin-top:10px;">
        <div class="form-grid">
          <div class="field field-wide"><label>Personal note</label><textarea class="r-note">${esc(sale.furever_note || '')}</textarea></div>
          <div class="field"><label>Pickup date</label><input class="r-pickup-date" type="date" value="${esc(sale.furever_pickup_date || '')}"></div>
          <div class="field"><label>Pickup time</label><input class="r-pickup-time" type="text" placeholder="e.g. 2:00 PM" value="${esc(sale.furever_pickup_time || '')}"></div>
          <div class="field"><label>Pickup place</label><input class="r-pickup-place" type="text" value="${esc(sale.furever_pickup_place || '')}"></div>
          <div class="field field-wide"><label>Pickup photo URL</label><input class="r-pickup-photo" type="text" placeholder="A hosted photo link" value="${esc(sale.furever_pickup_photo_url || '')}"></div>
        </div>
        <div style="margin-top:8px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <button class="btn btn-sm r-save-details">Save details</button>
          <button class="btn btn-primary btn-sm r-prepare">Prepare link</button>
          <span class="r-saved muted"></span>
        </div>
        <div class="r-link" style="margin-top:8px;"></div>
      </div>
    </div>`;
}

function renderRecipients() {
  if (!ctx.length) {
    els.recipients.innerHTML = `<div class="empty-state">No pups with an open sale right now.</div>`;
    return;
  }
  els.recipients.innerHTML = ctx.map(recipientRow).join('');
  els.recipients.querySelectorAll('[data-sale]').forEach((row) => {
    const saleId = row.dataset.sale;
    const entry = ctx.find((r) => r.sale.id === saleId);
    const header = row.querySelector('.r-header');
    const body = row.querySelector('.r-body');
    const arrow = row.querySelector('.r-arrow');
    header.addEventListener('click', () => {
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      arrow.style.transform = open ? 'rotate(0deg)' : 'rotate(90deg)';
    });
    row.querySelector('.r-save-details').addEventListener('click', () => saveDetails(row, entry));
    row.querySelector('.r-prepare').addEventListener('click', () => prepareLink(row, entry));
  });
}

function readDetails(row) {
  return {
    furever_note: row.querySelector('.r-note').value.trim(),
    furever_pickup_date: row.querySelector('.r-pickup-date').value || null,
    furever_pickup_time: row.querySelector('.r-pickup-time').value.trim(),
    furever_pickup_place: row.querySelector('.r-pickup-place').value.trim(),
    furever_pickup_photo_url: row.querySelector('.r-pickup-photo').value.trim()
  };
}

async function saveDetails(row, entry) {
  clearError();
  try {
    const changes = readDetails(row);
    entry.sale = await saleRepo.update(entry.sale.id, changes);
    const flag = row.querySelector('.r-saved');
    flag.textContent = 'Saved.';
    setTimeout(() => { flag.textContent = ''; }, 2000);
  } catch (e) {
    showError(e.message || String(e));
  }
}

function channelBody(kennelName, url) {
  const opener = kennelName ? `Here's your pup's own care app from ${kennelName}:` : `Here's your pup's own care app:`;
  return `${opener}\n\n${url}`;
}

async function prepareLink(row, entry) {
  clearError();
  const linkBox = row.querySelector('.r-link');
  linkBox.innerHTML = `<span class="muted">Building…</span>`;
  try {
    const changes = readDetails(row);
    entry.sale = await saleRepo.update(entry.sale.id, changes);

    const packet = await buildSeedPacket(entry.dog, entry.sale);
    const hash = compressToEncodedURIComponent(JSON.stringify(packet));
    const url = `${FUREVER_APP_URL}#seed=${hash}`;
    const bodyText = channelBody(packet.kennelName, url);

    const overSms = hash.length > MAX_SMS_HASH_LEN;
    const overEmail = hash.length > MAX_EMAIL_HASH_LEN;

    const buyer = entry.buyer;
    const subject = encodeURIComponent(packet.kennelName ? `${entry.dog.call_name || 'Your pup'}'s new app, from ${packet.kennelName}` : `${entry.dog.call_name || 'Your pup'}'s new app`);
    const body = encodeURIComponent(bodyText);
    const mailto = `mailto:${encodeURIComponent((buyer && buyer.email) || '')}?subject=${subject}&body=${body}`;
    const sms = `sms:${encodeURIComponent((buyer && buyer.phone) || '')}?body=${body}`;

    const emailAnchor = overEmail
      ? `<span class="inline-warn">Link is too large even for email (${hash.length} chars). A shorter personal note usually fixes it.</span>`
      : `<a class="btn btn-primary btn-sm" href="${esc(mailto)}">✉️ Send via email</a>`;
    const smsAnchor = overSms
      ? `<span class="muted">SMS unavailable — payload ${hash.length} chars exceeds the ${MAX_SMS_HASH_LEN}-char SMS limit; use email.</span>`
      : `<a class="btn btn-sm" href="${esc(sms)}">💬 Send via SMS</a>`;

    linkBox.innerHTML = `
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        ${emailAnchor}
        ${smsAnchor}
      </div>
      <div class="field" style="margin-top:8px;">
        <label>Or copy the link</label>
        <div style="display:flex; gap:8px; align-items:flex-start;">
          <input type="text" readonly value="${esc(url)}" onclick="this.select()">
          <button class="btn btn-sm r-copy-link" style="margin-top:0;">Copy</button>
        </div>
        <span class="field-hint">Payload ${hash.length} chars. A resend (edit details, Prepare link again) updates their app in place — nothing they've logged is touched.</span>
      </div>`;
    const copyBtn = linkBox.querySelector('.r-copy-link');
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(url).then(() => {
        const origText = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = origText; }, 2000);
      }).catch(() => {
        showError('Failed to copy link to clipboard');
      });
    });
  } catch (e) {
    linkBox.innerHTML = '';
    showError(e.message || String(e));
  }
}

// --- Content packages: "Publish to Furever" (Content Package Fetch Mechanism
// §4.1/§4.2) -------------------------------------------------------------
// KennelOS does as much as possible from in here: connect Drive once, then
// publish a kennel-wide pack (any dog's documents + kennel-level uploads) and one
// pack per litter (that litter's pups + sire + dam's documents). The picker is a
// bulk-add over documents already filed on dogs — no new document store.
let kennelUploads = []; // [{ id, title, docType, blob }] — pending "Upload new" items, kennel pack only

function driveConnectHtml() {
  const connected = isDriveConnectedThisSession();
  return `
    <div class="card" style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
      <button type="button" class="btn ${connected ? '' : 'btn-primary'} btn-sm" id="cp-connect-drive">${connected ? 'Reconnect Google Drive' : 'Connect Google Drive'}</button>
      <span class="muted" id="cp-connect-status">${connected ? 'Connected for this session.' : 'Not connected yet — Publish will ask you to connect.'}</span>
      <span class="muted" style="font-size:.85rem;">KennelOS can only ever see files it creates in your Drive — nothing else in your account.</span>
    </div>`;
}

function packStatusLine(pack) {
  if (!pack || !pack.packKey || !pack.manifestFileId) return `<span class="muted">Not published yet.</span>`;
  return `<span class="muted">Published — version ${esc(String(pack.version || 1))}.</span>`;
}

function docTypesIn(rows) {
  const present = new Set();
  rows.forEach((r) => r.docs.forEach((d) => present.add(d.doc_type)));
  return DOC_TYPES.filter((t) => present.has(t.value));
}

function docCheckboxHtml(doc, selectedIds) {
  const checked = selectedIds.has(doc.id) ? ' checked' : '';
  const sensitive = isSensitiveDocType(doc.doc_type)
    ? ` <span class="muted" style="font-size:.8rem;">— public by link if included</span>`
    : '';
  return `
    <label class="cp-doc-row" style="display:flex; align-items:center; gap:6px; margin:4px 0;">
      <input type="checkbox" class="cp-doc" value="${esc(doc.id)}" data-type="${esc(doc.doc_type)}"${checked}>
      <span aria-hidden="true">${docTypeIcon(doc.doc_type)}</span>
      <span>${esc(doc.title || descriptor(DOC_TYPES, doc.doc_type).label)}</span>
      ${badge(DOC_TYPES, doc.doc_type)}${sensitive}
    </label>`;
}

// `roleLabel` (litter picker only — "Sire"/"Dam"/"Pup") makes explicit which
// group's documents go to every family in the litter vs. just this one pup's.
function dogGroupHtml(row, selectedIds, roleLabel) {
  const role = roleLabel ? ` <span class="faint" style="font-weight:normal;">(${esc(roleLabel)})</span>` : '';
  return `
    <div class="cp-dog-group" style="margin:8px 0; padding:8px; border:1px solid var(--border); border-radius:var(--radius-sm);">
      <label style="font-weight:600; display:flex; align-items:center; gap:6px;">
        <input type="checkbox" class="cp-dog-all">
        ${esc(row.dog.call_name || 'Dog')}${role}
      </label>
      <div class="cp-dog-docs" style="margin-left:22px;">${row.docs.map((d) => docCheckboxHtml(d, selectedIds)).join('')}</div>
    </div>`;
}

function uploadRowHtml(u) {
  return `
    <div class="list-row" data-upload="${esc(u.id)}" style="display:flex; align-items:center; gap:8px;">
      <span aria-hidden="true">${docTypeIcon(u.docType)}</span>
      <span class="grow">${esc(u.title)}</span>
      ${badge(DOC_TYPES, u.docType)}
      <button type="button" class="btn btn-sm cp-upload-remove" data-upload="${esc(u.id)}">Remove</button>
    </div>`;
}

function uploadsHtml() {
  return `
    <div class="cp-uploads" style="margin-top:12px; padding-top:12px; border-top:1px dashed var(--border);">
      <h4 style="margin:0 0 6px;">Upload new (not filed on a dog)</h4>
      <p class="muted" style="margin:0 0 8px;">A care guide, poison list, or blank guarantee template — kennel-level files, published straight to Drive.</p>
      <div id="cp-upload-list">${kennelUploads.map(uploadRowHtml).join('')}</div>
      <div class="form-grid" style="margin-top:8px;">
        <div class="field"><label>File</label><input type="file" class="cp-upload-file"></div>
        <div class="field"><label>Title</label><input type="text" class="cp-upload-title" placeholder="e.g. Care guide"></div>
        <div class="field"><label>Type</label><select class="cp-upload-type">${DOC_TYPES.map((t) => `<option value="${esc(t.value)}">${esc(t.label)}</option>`).join('')}</select></div>
      </div>
      <button type="button" class="btn btn-sm cp-upload-add" style="margin-top:6px;">Add file</button>
    </div>`;
}

// `parentIds` ({sireId, damId}, litter picker only) drives the "(Sire)"/"(Dam)"
// role labels — absent for the kennel-wide picker, where every row is just a
// dog with no litter role to call out.
function pickerHtml({ prefix, rows, selectedIds, showUploads, parentIds }) {
  const types = docTypesIn(rows);
  const typeToggles = types.map((t) =>
    `<label style="margin-right:10px;"><input type="checkbox" class="cp-type-all" data-type="${esc(t.value)}"> All ${esc(t.label.toLowerCase())}s</label>`
  ).join('');
  const roleFor = (dog) => {
    if (!parentIds) return null;
    if (dog.id === parentIds.sireId) return 'Sire';
    if (dog.id === parentIds.damId) return 'Dam';
    return 'Pup';
  };
  return `
    <div class="cp-picker" data-prefix="${esc(prefix)}">
      ${rows.length ? `<div class="cp-picker-controls" style="margin-bottom:8px;">
        <label style="margin-right:10px;"><input type="checkbox" class="cp-select-all"> Select all</label>
        ${typeToggles}
      </div>` : ''}
      ${rows.length ? rows.map((r) => dogGroupHtml(r, selectedIds, roleFor(r.dog))).join('') : '<p class="muted">No documents filed on any connected dog yet.</p>'}
      ${showUploads ? uploadsHtml() : ''}
    </div>`;
}

function sensitiveConfirmHtml(sensitiveDocs) {
  const list = sensitiveDocs.map((d) => `<li>${esc(d.title || descriptor(DOC_TYPES, d.doc_type).label)}</li>`).join('');
  return `
    <div class="inline-warn">
      <strong>This will become publicly readable by anyone with the link:</strong>
      <ul style="margin:6px 0;">${list}</ul>
      <p style="margin:6px 0;">A contract often carries the buyer's name and address — only include it if you're sure.</p>
      <button type="button" class="btn btn-sm cp-confirm-yes">Yes, publish anyway</button>
      <button type="button" class="btn btn-sm cp-confirm-no">Cancel</button>
    </div>`;
}

function wireSensitiveConfirm(box, onConfirm) {
  box.querySelector('.cp-confirm-yes').addEventListener('click', onConfirm);
  box.querySelector('.cp-confirm-no').addEventListener('click', () => { box.innerHTML = ''; });
}

function flattenDocs(rows) {
  const map = new Map();
  rows.forEach((r) => r.docs.forEach((d) => map.set(d.id, d)));
  return map;
}

function collectSelectedIds(root) {
  return Array.from(root.querySelectorAll('.cp-doc:checked')).map((el) => el.value);
}

// Bulk selectors: select-all, per-type, and per-dog "select all" all just check/
// uncheck the underlying boxes — the DOM is the state while the panel is open,
// so no separate selection model has to be kept in sync with it.
function wirePicker(root) {
  const boxes = () => Array.from(root.querySelectorAll('.cp-doc'));
  const selectAll = root.querySelector('.cp-select-all');
  if (selectAll) {
    selectAll.addEventListener('change', () => {
      boxes().forEach((b) => { b.checked = selectAll.checked; });
      root.querySelectorAll('.cp-dog-all').forEach((d) => { d.checked = selectAll.checked; });
    });
  }
  root.querySelectorAll('.cp-type-all').forEach((t) => {
    t.addEventListener('change', () => {
      boxes().filter((b) => b.dataset.type === t.dataset.type).forEach((b) => { b.checked = t.checked; });
    });
  });
  root.querySelectorAll('.cp-dog-group').forEach((group) => {
    const allBox = group.querySelector('.cp-dog-all');
    const docBoxes = () => Array.from(group.querySelectorAll('.cp-doc'));
    allBox.addEventListener('change', () => {
      docBoxes().forEach((b) => { b.checked = allBox.checked; });
    });
    docBoxes().forEach((b) => b.addEventListener('change', () => {
      allBox.checked = docBoxes().every((x) => x.checked);
    }));
  });
}

function wireUploads(root) {
  const addBtn = root.querySelector('.cp-upload-add');
  if (!addBtn) return;
  const refreshList = () => {
    const list = root.querySelector('#cp-upload-list');
    if (list) list.innerHTML = kennelUploads.map(uploadRowHtml).join('');
    wireUploadRemove();
  };
  const wireUploadRemove = () => {
    root.querySelectorAll('.cp-upload-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        kennelUploads = kennelUploads.filter((u) => u.id !== btn.getAttribute('data-upload'));
        refreshList();
      });
    });
  };
  wireUploadRemove();
  addBtn.addEventListener('click', () => {
    const fileInput = root.querySelector('.cp-upload-file');
    const titleInput = root.querySelector('.cp-upload-title');
    const typeSelect = root.querySelector('.cp-upload-type');
    const file = fileInput.files && fileInput.files[0];
    if (!file) { showError('Choose a file to upload.'); return; }
    clearError();
    kennelUploads.push({
      id: crypto.randomUUID(),
      title: (titleInput.value || file.name).trim(),
      docType: typeSelect.value,
      blob: file
    });
    fileInput.value = '';
    titleInput.value = '';
    refreshList();
  });
}

function wireConnect(root) {
  const btn = root.querySelector('#cp-connect-drive');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const statusEl = document.getElementById('cp-connect-status');
    clearError();
    btn.disabled = true;
    statusEl.textContent = 'Connecting…';
    try {
      await connectDrive();
      setFureverSettings({ driveConnected: true });
      statusEl.textContent = 'Connected for this session.';
      btn.textContent = 'Reconnect Google Drive';
    } catch (e) {
      statusEl.textContent = 'Not connected yet — Publish will ask you to connect.';
      showError(e.message || String(e));
    } finally {
      btn.disabled = false;
    }
  });
}

async function doKennelPublish(kennelRows) {
  const root = els.contentPackages.querySelector('.cp-picker[data-prefix="kennel"]');
  const docsById = flattenDocs(kennelRows);
  const selectedDocs = collectSelectedIds(root).map((id) => docsById.get(id)).filter(Boolean);
  // "Upload new" items carry their own doc_type too (a breeder could tag one
  // 'contract') — the sensitive-doc guard has to cover them, not just the
  // dog-scoped picker (§4.2 step 2's warning applies to anything about to
  // become public, regardless of source).
  const sensitive = [...selectedDocs, ...kennelUploads.map((u) => ({ title: u.title, doc_type: u.docType }))]
    .filter((d) => isSensitiveDocType(d.doc_type));

  const confirmBox = document.getElementById('cp-kennel-confirm');
  if (sensitive.length && !confirmBox.dataset.confirmed) {
    confirmBox.innerHTML = sensitiveConfirmHtml(sensitive);
    wireSensitiveConfirm(confirmBox, () => { confirmBox.dataset.confirmed = '1'; doKennelPublish(kennelRows); });
    return;
  }
  confirmBox.innerHTML = '';
  delete confirmBox.dataset.confirmed;

  const btn = document.getElementById('cp-kennel-publish');
  const statusEl = document.getElementById('cp-kennel-status');
  clearError();
  btn.disabled = true;
  statusEl.textContent = 'Publishing…';
  try {
    const settings = getFureverSettings();
    const pointer = await publishPack({
      scope: 'kennel',
      kennelName: settings.kennelName,
      pointer: settings.contentPack,
      documents: selectedDocs,
      uploads: kennelUploads
    });
    setFureverSettings({ contentPack: pointer, driveConnected: true });
    kennelUploads = [];
    statusEl.textContent = 'Published.';
    await renderContentPackages();
  } catch (e) {
    statusEl.textContent = '';
    showError(e.message || String(e));
    btn.disabled = false;
  }
}

async function doLitterPublish(litter, rows) {
  const card = els.contentPackages.querySelector(`[data-litter="${CSS.escape(litter.id)}"]`);
  const root = card.querySelector('.cp-picker');
  const docsById = flattenDocs(rows);
  const selectedDocs = collectSelectedIds(root).map((id) => docsById.get(id)).filter(Boolean);
  const sensitive = selectedDocs.filter((d) => isSensitiveDocType(d.doc_type));

  const confirmBox = card.querySelector('.cp-litter-confirm');
  if (sensitive.length && !confirmBox.dataset.confirmed) {
    confirmBox.innerHTML = sensitiveConfirmHtml(sensitive);
    wireSensitiveConfirm(confirmBox, () => { confirmBox.dataset.confirmed = '1'; doLitterPublish(litter, rows); });
    return;
  }
  confirmBox.innerHTML = '';
  delete confirmBox.dataset.confirmed;

  const btn = card.querySelector('.cp-litter-publish');
  const statusEl = card.querySelector('.cp-litter-status');
  clearError();
  btn.disabled = true;
  statusEl.textContent = 'Publishing…';
  try {
    const settings = getFureverSettings();
    const pointer = await publishPack({
      scope: 'litter',
      kennelName: settings.kennelName,
      litterNickname: litter.nickname,
      pointer: litter.furever_pack || {},
      documents: selectedDocs,
      uploads: [],
      // The litter's parents' documents go to every pup's family in the
      // litter; each pup's own documents go only to that pup's family
      // (contentPackFetch.js's per-pup filter reads this back).
      sireId: litter.sire_id || null,
      damId: litter.dam_id || null
    });
    await litterRepo.update(litter.id, { furever_pack: pointer });
    statusEl.textContent = 'Published.';
    await renderContentPackages();
  } catch (e) {
    statusEl.textContent = '';
    showError(e.message || String(e));
    btn.disabled = false;
  }
}

function kennelSectionHtml(settings, kennelRows) {
  const selectedIds = new Set(settings.contentPack.selection.documentIds || []);
  return `
    <div class="card" style="margin-top:16px;">
      <h2 style="margin:0;">Kennel-wide pack</h2>
      <p class="muted" style="margin:6px 0 0;">Reusable material every family gets — a breed care guide, a blank guarantee template. ${packStatusLine(settings.contentPack)}</p>
      <div style="margin-top:10px;">
        ${pickerHtml({ prefix: 'kennel', rows: kennelRows, selectedIds, showUploads: true })}
      </div>
      <div id="cp-kennel-confirm"></div>
      <div style="margin-top:10px; display:flex; align-items:center; gap:10px;">
        <button type="button" class="btn btn-primary btn-sm" id="cp-kennel-publish">Publish kennel-wide pack</button>
        <span class="muted" id="cp-kennel-status"></span>
      </div>
    </div>`;
}

function litterSectionHtml(litter, rows) {
  const pack = litter.furever_pack;
  const selectedIds = new Set((pack && pack.selection && pack.selection.documentIds) || []);
  return `
    <div class="card" data-litter="${esc(litter.id)}" style="margin-top:12px;">
      <div class="r-header" style="display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none;">
        <span class="r-arrow" style="display:inline-block; transition:transform 0.2s; font-size:12px;">▶</span>
        <div class="row-between" style="flex:1; gap:8px;">
          <span><strong>${esc(litter.nickname || 'Untitled litter')}</strong></span>
          <span>${packStatusLine(pack)}</span>
        </div>
      </div>
      <div class="r-body" style="display:none; margin-top:10px;">
        <p class="muted" style="margin:0 0 8px; font-size:.85rem;">Sire/dam documents go to every family in this litter. A pup's own documents go only to that pup's family — check just that pup's box to send something to one family alone.</p>
        ${pickerHtml({ prefix: `litter-${litter.id}`, rows, selectedIds, showUploads: false, parentIds: { sireId: litter.sire_id, damId: litter.dam_id } })}
        <div class="cp-litter-confirm"></div>
        <div style="margin-top:10px; display:flex; align-items:center; gap:10px;">
          <button type="button" class="btn btn-primary btn-sm cp-litter-publish">Publish this litter's pack</button>
          <span class="muted cp-litter-status"></span>
        </div>
      </div>
    </div>`;
}

async function loadContentPackagesData() {
  const allDogs = await dogRepo.getAll();
  const kennelRows = (await Promise.all(allDogs.map(async (dog) => {
    const docs = await documentRepo.getByDog(dog.id);
    return docs.length ? { dog, docs } : null;
  }))).filter(Boolean);

  const allLitters = await litterRepo.getAll();
  const litterEntries = [];
  for (const litter of allLitters) {
    const pups = await dogRepo.getByLitter(litter.id);
    const ids = new Set(pups.map((p) => p.id));
    if (litter.sire_id) ids.add(litter.sire_id);
    if (litter.dam_id) ids.add(litter.dam_id);
    const rows = [];
    for (const id of ids) {
      const dog = allDogs.find((d) => d.id === id) || await dogRepo.getById(id);
      if (!dog) continue;
      const docs = await documentRepo.getByDog(id);
      if (docs.length) rows.push({ dog, docs });
    }
    litterEntries.push({ litter, rows });
  }
  return { kennelRows, litterEntries };
}

function wireContentPackages(kennelRows, litterEntries) {
  wireConnect(els.contentPackages);

  const kennelRoot = els.contentPackages.querySelector('.cp-picker[data-prefix="kennel"]');
  if (kennelRoot) { wirePicker(kennelRoot); wireUploads(kennelRoot); }
  const kennelBtn = document.getElementById('cp-kennel-publish');
  if (kennelBtn) kennelBtn.addEventListener('click', () => doKennelPublish(kennelRows));

  litterEntries.forEach(({ litter, rows }) => {
    const card = els.contentPackages.querySelector(`[data-litter="${CSS.escape(litter.id)}"]`);
    if (!card) return;
    const root = card.querySelector('.cp-picker');
    if (root) wirePicker(root);
    const header = card.querySelector('.r-header');
    const body = card.querySelector('.r-body');
    const arrow = card.querySelector('.r-arrow');
    header.addEventListener('click', () => {
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      arrow.style.transform = open ? 'rotate(0deg)' : 'rotate(90deg)';
    });
    card.querySelector('.cp-litter-publish').addEventListener('click', () => doLitterPublish(litter, rows));
  });
}

async function renderContentPackages() {
  const settings = getFureverSettings();
  const { kennelRows, litterEntries } = await loadContentPackagesData();

  els.contentPackages.innerHTML = `
    ${driveConnectHtml()}
    ${kennelSectionHtml(settings, kennelRows)}
    ${litterEntries.length
      ? litterEntries.map(({ litter, rows }) => litterSectionHtml(litter, rows)).join('')
      : '<p class="muted" style="margin-top:12px;">No litters yet.</p>'}
  `;
  wireContentPackages(kennelRows, litterEntries);
}

async function main() {
  const vets = await renderIdentity();
  await loadData();
  renderRecipients();
  await renderContentPackages();
  await renderSetupNudges(vets);
}

main();
