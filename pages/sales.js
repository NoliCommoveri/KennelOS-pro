// sales.js — Sales hub: breeding-style cards, each carrying its linked
// Contract(s) inline (Buckets & Direct Contract Linking Plan v1, Work Area 1A).
// Contract owns the link (`related_sale_id`) — linking/unlinking here is always
// one write to the contract via contractRepo.update, never a field on Sale.
import { saleRepo } from '../data/saleRepo.js';
import { contractRepo } from '../data/contractRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { PLACEMENT_TYPE, SALE_STATUS, CONTRACT_TYPE, CONTRACT_STATUS, descriptor } from '../data/vocab.js';
import { esc, badge, fmtDate } from '../assets/ui.js';
import { editionFlags } from '../data/editionConfig.js';

const body = document.getElementById('sale-list');
const errorBox = document.getElementById('page-error');

// Kept current by main() on every load, read fresh when the print modal opens
// (not just the paginated "recent" slice shown on the page).
const state = { sales: [], dogsById: new Map(), contactsById: new Map() };

function showError(msg) { errorBox.innerHTML = `<div class="inline-error">${esc(msg)}</div>`; }

// Best available date for "recent", newest first.
function recencyKey(s) {
  return s.sale_date || (s.created_at || '').slice(0, 10) || '';
}

function contractRowHtml(c) {
  return `<div class="row-between" style="padding:6px 0;">
      <span>${badge(CONTRACT_TYPE, c.contract_type)} <a href="contract.html?id=${encodeURIComponent(c.id)}"><strong>${esc(c.title || '(untitled)')}</strong></a> ${badge(CONTRACT_STATUS, c.status)}${c.signed_date ? ` <span class="faint">signed ${esc(fmtDate(c.signed_date))}</span>` : ''}</span>
      <button type="button" class="btn btn-sm" data-act="unlink" data-contract="${esc(c.id)}">✕ Unlink</button>
    </div>`;
}

// The Contract block nested under a sale card — the `litterHtml` sub-block
// equivalent (breeding.js): dashed top border, linked contracts + a picker.
function contractBlockHtml(saleId, linkedContracts, linkableContracts) {
  const items = linkedContracts.length
    ? linkedContracts.map(contractRowHtml).join('')
    : `<div class="muted" style="font-size:13px;">No contracts linked yet.</div>`;
  const options = linkableContracts
    .map((c) => `<option value="${esc(c.id)}">${esc(c.title || '(untitled)')} — ${esc(descriptor(CONTRACT_TYPE, c.contract_type).label)}</option>`)
    .join('');
  return `<div class="sub-block" style="margin-top:10px; padding-top:10px; border-top:1px dashed var(--border);">
      ${items}
      <div class="pill-row" style="margin-top:8px; align-items:center;">
        ${linkableContracts.length ? `<select class="link-contract-select" data-act="link" data-sale="${esc(saleId)}">
            <option value="">+ Link contract…</option>
            ${options}
          </select>` : ''}
        <a class="btn btn-sm" href="contract.html?new=1&sale=${encodeURIComponent(saleId)}">+ Create contract</a>
      </div>
    </div>`;
}

function saleCard(s, dogsById, contactsById, contractsBySale, linkableContracts) {
  const dog = dogsById.get(s.dog_id);
  const buyer = contactsById.get(s.buyer_contact_id);
  const linked = contractsBySale.get(s.id) || [];
  return `<section class="card" style="margin-top:14px;">
      <div class="row-between">
        <div>
          <a href="sale.html?id=${encodeURIComponent(s.id)}"><strong>${esc(dog?.call_name || '—')} → ${esc(buyer?.name || '—')}</strong></a>
          ${badge(PLACEMENT_TYPE, s.placement_type)} ${badge(SALE_STATUS, s.status)}
          <div class="muted" style="font-size:13px; margin-top:2px;">
            ${s.sale_date ? `Sale date ${esc(fmtDate(s.sale_date))}` : '<span class="faint">No sale date</span>'}
          </div>
        </div>
        <a class="btn btn-sm" href="sale.html?id=${encodeURIComponent(s.id)}">Open sale</a>
      </div>
      ${editionFlags.contracts ? contractBlockHtml(s.id, linked, linkableContracts) : ''}
    </section>`;
}

// A litter's group header label: "Dam × Sire — whelp date" (dog.js litterLabel convention).
function litterHeaderLabel(litter, dogsById) {
  const dam = dogsById.get(litter.dam_id)?.call_name || '—';
  const sire = dogsById.get(litter.sire_id)?.call_name || '—';
  return `${dam} × ${sire}${litter.whelp_date ? ` — ${fmtDate(litter.whelp_date)}` : ''}`;
}

// Sales within a group (litter or External Acquisitions), ordered by dog
// name, each dog's own sales newest first.
function dogEntriesHtml(byDog, dogsById, cardHtml) {
  const entries = [...byDog.entries()]
    .map(([dogId, list]) => ({
      dog: dogsById.get(dogId),
      sales: list.slice().sort((a, b) => recencyKey(b).localeCompare(recencyKey(a)))
    }))
    .sort((a, b) => (a.dog?.call_name || '').localeCompare(b.dog?.call_name || ''));
  return entries.flatMap((e) => e.sales).map(cardHtml).join('');
}

async function main() {
  // Lite: the Stud Services / Other contracts seg-tabs point at Pro-only pages —
  // remove them when those features are off.
  if (!editionFlags.studServices) document.querySelector('.seg-tab[href="stud-services.html"]')?.remove();
  if (!editionFlags.contracts) document.querySelector('.seg-tab[href="contracts.html"]')?.remove();
  const [sales, dogs, contacts, contracts, litters] = await Promise.all([
    saleRepo.getAll({ includeArchived: false }),
    dogRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true }),
    contractRepo.getAll({ includeArchived: false }),
    litterRepo.getAll({ includeArchived: true })
  ]);
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const contactsById = new Map(contacts.map((c) => [c.id, c]));
  const littersById = new Map(litters.map((l) => [l.id, l]));
  state.sales = sales;
  state.dogsById = dogsById;
  state.contactsById = contactsById;

  const contractsBySale = new Map();
  for (const c of contracts) {
    if (!c.related_sale_id) continue;
    if (!contractsBySale.has(c.related_sale_id)) contractsBySale.set(c.related_sale_id, []);
    contractsBySale.get(c.related_sale_id).push(c);
  }
  for (const list of contractsBySale.values()) {
    list.sort((a, b) => (b.signed_date || b.created_at || '').localeCompare(a.signed_date || a.created_at || ''));
  }
  // Candidates for "+ Link contract": tied to no sale and no stud service.
  const linkableContracts = contracts.filter((c) => !c.related_sale_id && !c.related_stud_service_id);

  if (!sales.length) {
    body.innerHTML = `<div class="card empty-state">No sales yet. Click “+ Add Sale” to record the first placement.</div>`;
    return;
  }

  const cardHtml = (s) => saleCard(s, dogsById, contactsById, contractsBySale, linkableContracts);

  // Group by litter (derived via the sold dog's litter_id), then by dog within
  // the litter. Dogs with no litter link (external acquisitions) go together
  // in one bucket at the end, never mixed into a real litter's group.
  const litterGroups = new Map(); // litterId -> byDog map
  const externalByDog = new Map();
  for (const s of sales) {
    const dog = dogsById.get(s.dog_id);
    const litter = dog && dog.litter_id ? littersById.get(dog.litter_id) : null;
    let byDog = externalByDog;
    if (litter) {
      if (!litterGroups.has(litter.id)) litterGroups.set(litter.id, new Map());
      byDog = litterGroups.get(litter.id);
    }
    const dogKey = s.dog_id || '';
    if (!byDog.has(dogKey)) byDog.set(dogKey, []);
    byDog.get(dogKey).push(s);
  }

  const orderedLitters = [...litterGroups.keys()]
    .map((id) => littersById.get(id))
    .sort((a, b) => (b.whelp_date || '').localeCompare(a.whelp_date || ''));

  const sections = orderedLitters.map((litter, idx) => {
    const byDog = litterGroups.get(litter.id);
    return `<h2 style="margin-top:${idx === 0 ? '0' : '26px'};"><a href="litter.html?id=${encodeURIComponent(litter.id)}">${esc(litterHeaderLabel(litter, dogsById))}</a></h2>${dogEntriesHtml(byDog, dogsById, cardHtml)}`;
  });

  if (externalByDog.size) {
    sections.push(`<h2 style="margin-top:${sections.length ? '26px' : '0'};">External Acquisitions</h2>${dogEntriesHtml(externalByDog, dogsById, cardHtml)}`);
  }

  body.innerHTML = sections.join('');
}

// Delegated on the container (not per-card) so re-renders never leak listeners.
body.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act="unlink"]');
  if (!btn) return;
  try {
    await contractRepo.update(btn.dataset.contract, { related_sale_id: null });
    await main();
  } catch (err) { showError(err.message || String(err)); }
});

body.addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-act="link"]');
  if (!sel || !sel.value) return;
  const contractId = sel.value;
  const saleId = sel.dataset.sale;
  try {
    const existing = await contractRepo.getById(contractId);
    await contractRepo.update(contractId, { related_sale_id: saleId, contract_type: existing.contract_type || 'sale' });
    await main();
  } catch (err) { showError(err.message || String(err)); }
});

// --- Print Puppy Record modal --------------------------------------------
// Lets the breeder jump straight to a puppy's printable record without first
// opening its Sale — scoped to non-delivered sales (a delivered puppy is
// already gone; nothing left to hand a buyer). Ordered by dog name.
function openPrintModal() {
  const eligible = state.sales
    .filter((s) => s.status !== 'delivered')
    .map((s) => ({ sale: s, dogName: state.dogsById.get(s.dog_id)?.call_name || '(unnamed)', buyerName: state.contactsById.get(s.buyer_contact_id)?.name || '' }))
    .sort((a, b) => a.dogName.localeCompare(b.dogName));

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const options = eligible
    .map((e) => `<option value="${esc(e.sale.id)}">${esc(e.dogName)}${e.buyerName ? ` → ${esc(e.buyerName)}` : ''}</option>`)
    .join('');
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <h2 style="margin-top:0;">Print a Puppy Record</h2>
      ${eligible.length ? `
        <div class="field">
          <label>Puppy</label>
          <select id="ppm-select">${options}</select>
        </div>` : `<p class="muted">No non-delivered sales to print.</p>`}
      <div class="form-actions">
        ${eligible.length ? `<button class="btn btn-primary" id="ppm-print">Print</button>` : ''}
        <button class="btn" id="ppm-cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('#ppm-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const printBtn = overlay.querySelector('#ppm-print');
  if (printBtn) {
    printBtn.addEventListener('click', () => {
      const saleId = overlay.querySelector('#ppm-select').value;
      // autoprint=1 tells puppy-record.js to invoke window.print() itself once
      // it finishes rendering, so this really is a one-click "Print" button.
      window.open(`puppy-record.html?sale=${encodeURIComponent(saleId)}&autoprint=1`, '_blank');
      close();
    });
  }
}

document.getElementById('btn-print-puppy-record').addEventListener('click', openPrintModal);

main().catch((e) => showError(e.message || String(e)));
