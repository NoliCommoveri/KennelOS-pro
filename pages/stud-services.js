// stud-services.js — Stud Services hub: breeding-style cards, each carrying
// its linked Contract(s) inline (Buckets & Direct Contract Linking Plan v1,
// Work Area 1B). Contract owns the link (`related_stud_service_id`) —
// linking/unlinking here is always one write to the contract via
// contractRepo.update, never a field on StudService.
import { studServiceRepo } from '../data/studServiceRepo.js';
import { contractRepo } from '../data/contractRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { STUD_SERVICE_DIRECTION, STUD_SERVICE_STATUS, CONTRACT_TYPE, CONTRACT_STATUS, descriptor } from '../data/vocab.js';
import { esc, badge, fmtDate } from '../assets/ui.js';

const body = document.getElementById('stud-service-list');
const errorBox = document.getElementById('page-error');

function showError(msg) { errorBox.innerHTML = `<div class="inline-error">${esc(msg)}</div>`; }

// Best available date for "recent", newest first. Sent date is optional, so
// fall back to created_at for records that never got one.
function recencyKey(s) { return s.sent_date || (s.created_at || '').slice(0, 10) || ''; }

function contractRowHtml(c) {
  return `<div class="row-between" style="padding:6px 0;">
      <span>${badge(CONTRACT_TYPE, c.contract_type)} <a href="contract.html?id=${encodeURIComponent(c.id)}"><strong>${esc(c.title || '(untitled)')}</strong></a> ${badge(CONTRACT_STATUS, c.status)}${c.signed_date ? ` <span class="faint">signed ${esc(fmtDate(c.signed_date))}</span>` : ''}</span>
      <button type="button" class="btn btn-sm" data-act="unlink" data-contract="${esc(c.id)}">✕ Unlink</button>
    </div>`;
}

function contractBlockHtml(studServiceId, linkedContracts, linkableContracts) {
  const items = linkedContracts.length
    ? linkedContracts.map(contractRowHtml).join('')
    : `<div class="muted" style="font-size:13px;">No contracts linked yet.</div>`;
  const options = linkableContracts
    .map((c) => `<option value="${esc(c.id)}">${esc(c.title || '(untitled)')} — ${esc(descriptor(CONTRACT_TYPE, c.contract_type).label)}</option>`)
    .join('');
  return `<div class="sub-block" style="margin-top:10px; padding-top:10px; border-top:1px dashed var(--border);">
      ${items}
      <div class="pill-row" style="margin-top:8px; align-items:center;">
        ${linkableContracts.length ? `<select class="link-contract-select" data-act="link" data-stud="${esc(studServiceId)}">
            <option value="">+ Link contract…</option>
            ${options}
          </select>` : ''}
        <a class="btn btn-sm" href="contract.html?new=1&stud_service=${encodeURIComponent(studServiceId)}">+ Create contract</a>
      </div>
    </div>`;
}

function studServiceCard(s, dogsById, contactsById, contractsByStud, linkableContracts) {
  const ourDog = dogsById.get(s.our_dog_id);
  const partnerDog = dogsById.get(s.partner_dog_id);
  const partnerContact = contactsById.get(s.partner_contact_id);
  const linked = contractsByStud.get(s.id) || [];
  return `<section class="card" style="margin-top:14px;">
      <div class="row-between">
        <div>
          <a href="stud-service.html?id=${encodeURIComponent(s.id)}"><strong>${esc(ourDog?.call_name || '—')} × ${esc(partnerDog?.call_name || '—')}</strong></a>
          ${badge(STUD_SERVICE_DIRECTION, s.direction)} ${badge(STUD_SERVICE_STATUS, s.status)}
          <div class="muted" style="font-size:13px; margin-top:2px;">
            ${partnerContact ? esc(partnerContact.name) : '<span class="faint">No partner contact</span>'}
          </div>
        </div>
        <a class="btn btn-sm" href="stud-service.html?id=${encodeURIComponent(s.id)}">Open stud service</a>
      </div>
      ${contractBlockHtml(s.id, linked, linkableContracts)}
    </section>`;
}

async function main() {
  const [studServices, dogs, contacts, contracts] = await Promise.all([
    studServiceRepo.getAll({ includeArchived: false }),
    dogRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true }),
    contractRepo.getAll({ includeArchived: false })
  ]);
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const contactsById = new Map(contacts.map((c) => [c.id, c]));

  const contractsByStud = new Map();
  for (const c of contracts) {
    if (!c.related_stud_service_id) continue;
    if (!contractsByStud.has(c.related_stud_service_id)) contractsByStud.set(c.related_stud_service_id, []);
    contractsByStud.get(c.related_stud_service_id).push(c);
  }
  for (const list of contractsByStud.values()) {
    list.sort((a, b) => (b.signed_date || b.created_at || '').localeCompare(a.signed_date || a.created_at || ''));
  }
  const linkableContracts = contracts.filter((c) => !c.related_sale_id && !c.related_stud_service_id);

  if (!studServices.length) {
    body.innerHTML = `<div class="card empty-state">No stud services yet. Click “+ Add Stud Service” to record the first one.</div>`;
    return;
  }

  const cardHtml = (s) => studServiceCard(s, dogsById, contactsById, contractsByStud, linkableContracts);

  // Group by our_dog_id (the kennel's own dog on either side of the service),
  // each dog's records newest sent date first. Dog groups themselves are
  // ordered by their own most recent record.
  const byDog = new Map();
  for (const s of studServices) {
    const key = s.our_dog_id || '';
    if (!byDog.has(key)) byDog.set(key, []);
    byDog.get(key).push(s);
  }
  const dogGroups = [...byDog.entries()].map(([dogId, list]) => ({
    dog: dogsById.get(dogId),
    services: list.slice().sort((a, b) => recencyKey(b).localeCompare(recencyKey(a)))
  }));
  dogGroups.sort((a, b) => recencyKey(b.services[0]).localeCompare(recencyKey(a.services[0])));

  const sections = dogGroups.map((g, idx) => {
    const name = esc(g.dog?.call_name || '(unknown dog)');
    const heading = g.dog ? `<a href="dog.html?id=${encodeURIComponent(g.dog.id)}">${name}</a>` : name;
    return `<h2 style="margin-top:${idx === 0 ? '0' : '26px'};">${heading}</h2>${g.services.map(cardHtml).join('')}`;
  });

  body.innerHTML = sections.join('');
}

body.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act="unlink"]');
  if (!btn) return;
  try {
    await contractRepo.update(btn.dataset.contract, { related_stud_service_id: null });
    await main();
  } catch (err) { showError(err.message || String(err)); }
});

body.addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-act="link"]');
  if (!sel || !sel.value) return;
  const contractId = sel.value;
  const studServiceId = sel.dataset.stud;
  try {
    const existing = await contractRepo.getById(contractId);
    await contractRepo.update(contractId, { related_stud_service_id: studServiceId, contract_type: existing.contract_type || 'stud_service' });
    await main();
  } catch (err) { showError(err.message || String(err)); }
});

main().catch((e) => showError(e.message || String(e)));
