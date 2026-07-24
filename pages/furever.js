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
import { getFureverSettings, setFureverSettings } from '../data/settings.js';
import { buildSeedPacket, FUREVER_APP_URL } from '../data/fureverSeedExport.js';
import { compressToEncodedURIComponent } from '../vendor/lz-string.min.mjs';
import { esc } from '../assets/ui.js';

// Same payload ceilings Companion uses (brief §6.1) — SMS gateways are the weak
// link; a seed packet (~1.7K per the schema doc's own measurement) sits well
// under both, but a long personal note could push it, so warn rather than trust.
const MAX_SMS_HASH_LEN = 1800;
const MAX_EMAIL_HASH_LEN = 12000;

const els = {
  error: document.getElementById('page-error'),
  identity: document.getElementById('identity'),
  recipients: document.getElementById('recipients')
};

function showError(msg) { els.error.innerHTML = `<div class="inline-error">${esc(msg)}</div>`; }
function clearError() { els.error.innerHTML = ''; }

// --- Kennel identity card ----------------------------------------------------
function identityCardHtml(s) {
  return `
    <div class="form-grid">
      <div class="field"><label>Kennel name</label><input class="id-kennelName" type="text" value="${esc(s.kennelName)}"></div>
      <div class="field"><label>Tagline</label><input class="id-tagline" type="text" value="${esc(s.tagline)}"></div>
      <div class="field"><label>Your name</label><input class="id-bc-name" type="text" value="${esc(s.breederContact.name)}"></div>
      <div class="field"><label>Your phone</label><input class="id-bc-phone" type="text" value="${esc(s.breederContact.phone)}"></div>
      <div class="field field-wide"><label>Your email</label><input class="id-bc-email" type="email" value="${esc(s.breederContact.email)}"></div>
      <div class="field"><label>Your vet's name</label><input class="id-bv-name" type="text" value="${esc(s.breederVet.name)}"></div>
      <div class="field"><label>Your vet's phone</label><input class="id-bv-phone" type="text" value="${esc(s.breederVet.phone)}"></div>
      <div class="field field-wide"><label>Your vet's address</label><input class="id-bv-address" type="text" value="${esc(s.breederVet.address)}"></div>
    </div>
    <div style="margin-top:8px;"><button class="btn btn-primary btn-sm" id="id-save">Save kennel identity</button> <span class="muted" id="id-saved"></span></div>`;
}

function renderIdentity() {
  const s = getFureverSettings();
  els.identity.innerHTML = identityCardHtml(s);
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

    const packet = buildSeedPacket(entry.dog, entry.sale);
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

async function main() {
  renderIdentity();
  await loadData();
  renderRecipients();
}

main();
