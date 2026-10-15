// sales.js — Sales hub: one collapsible card per litter (closed on load, the
// header summing up its sales), opening onto that litter's sales, each carrying
// its linked Contract(s) inline (Buckets & Direct Contract Linking Plan v1, Work
// Area 1A). Ended sales (Returned / Cancelled / Voided) fold away under their own
// "N ended sales" toggle inside the litter. Only the PAGE_SIZE newest litters show;
// the rest are behind a "Show more" toggle, like the Breeding hub's pairings.
// External Acquisitions always shows, last.
// Contract owns the link (`related_sale_id`) — linking/unlinking here is always
// one write to the contract via contractRepo.update, never a field on Sale.
import { saleRepo } from '../data/saleRepo.js';
import { contractRepo } from '../data/contractRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { inScopeOnly } from '../data/kennelScope.js';
import { REGISTRATION_TYPE, SALE_STATUS, CONTRACT_TYPE, CONTRACT_STATUS, RELEASED_SALE_STATUSES, descriptor, isOpenSale } from '../data/vocab.js';
import { prepLitters, pupSale, pickedByDefault } from '../data/prepPups.js';
import { litterLabel, rosterOf, homePups } from '../data/litterCheckin.js';
import { esc, badge, fmtDate, cardShell } from '../assets/ui.js';
import { editionFlags } from '../data/editionConfig.js';

const PAGE_SIZE = 5; // most recent litters shown before "Show more" (as breeding.js)
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
  return `<div style="padding:12px 0; border-top:1px solid var(--border);">
      <div class="row-between">
        <div>
          <a href="sale.html?id=${encodeURIComponent(s.id)}"><strong>${esc(dog?.call_name || '—')} → ${esc(buyer?.name || '—')}</strong></a>
          ${badge(REGISTRATION_TYPE, s.registration_type)} ${badge(SALE_STATUS, s.status)}
          <div class="muted" style="font-size:13px; margin-top:2px;">
            ${s.sale_date ? `Sale date ${esc(fmtDate(s.sale_date))}` : '<span class="faint">No sale date</span>'}
          </div>
        </div>
        <a class="btn btn-sm" href="sale.html?id=${encodeURIComponent(s.id)}">Open sale</a>
      </div>
      ${editionFlags.contracts ? contractBlockHtml(s.id, linked, linkableContracts) : ''}
    </div>`;
}

// A litter's group header label: "Dam × Sire — whelp date" (dog.js litterLabel convention).
function litterHeaderLabel(litter, dogsById) {
  const dam = dogsById.get(litter.dam_id)?.call_name || '—';
  const sire = dogsById.get(litter.sire_id)?.call_name || '—';
  return `${dam} × ${sire}${litter.whelp_date ? ` — ${fmtDate(litter.whelp_date)}` : ''}`;
}

// Sales within a group (litter or External Acquisitions), ordered by dog
// name, each dog's own sales newest first.
function orderedSales(byDog, dogsById) {
  return [...byDog.entries()]
    .map(([dogId, list]) => ({
      dog: dogsById.get(dogId),
      sales: list.slice().sort((a, b) => recencyKey(b).localeCompare(recencyKey(a)))
    }))
    .sort((a, b) => (a.dog?.call_name || '').localeCompare(b.dog?.call_name || ''))
    .flatMap((e) => e.sales);
}

const isEnded = (s) => RELEASED_SALE_STATUSES.includes(s.status);

// The closed header's summary: "5 sales: 2 deposit paid, 1 delivered, 2 ended"
// (live statuses in vocabulary order, the ended ones lumped together).
function groupSummary(sales) {
  const parts = SALE_STATUS
    .filter((o) => !RELEASED_SALE_STATUSES.includes(o.value))
    .map((o) => [o.label.toLowerCase(), sales.filter((s) => s.status === o.value).length])
    .filter(([, n]) => n)
    .map(([label, n]) => `${n} ${label}`);
  const ended = sales.filter(isEnded).length;
  if (ended) parts.push(`${ended} ended`);
  return `${sales.length} sale${sales.length === 1 ? '' : 's'}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

// One litter (or External Acquisitions) as a collapsible card, closed on load.
function groupCardHtml(key, label, linkHtml, sales, cardHtml) {
  const live = sales.filter((s) => !isEnded(s));
  const ended = sales.filter(isEnded);
  const title = `${esc(label)}<div class="muted" style="font-size:13px; font-weight:400; margin-top:2px;">${esc(groupSummary(sales))}</div>`;
  const endedHtml = ended.length
    ? `<details style="margin-top:8px;"><summary class="muted">${ended.length} ended sale${ended.length === 1 ? '' : 's'} (returned, cancelled or voided)</summary>${ended.map(cardHtml).join('')}</details>`
    : '';
  const body = `${linkHtml}${live.map(cardHtml).join('')}${endedHtml}`;
  return cardShell(title, body, { key, isEmpty: true, headToggles: true, marginTop: true });
}

async function main() {
  // Lite: the Stud Services / Other contracts seg-tabs point at Pro-only pages —
  // remove them when those features are off.
  if (!editionFlags.studServices) document.querySelector('.seg-tab[href="stud-services.html"]')?.remove();
  if (!editionFlags.contracts) document.querySelector('.seg-tab[href="contracts.html"]')?.remove();
  // Lite: Puppy Record is Pro-only (the page itself is excluded from the build) —
  // remove the button that opens it.
  if (!editionFlags.puppyRecord) document.getElementById('btn-print-puppy-record')?.remove();
  const [allSales, dogs, contacts, allContracts, litters] = await Promise.all([
    saleRepo.getAll({ includeArchived: false }),
    dogRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true }),
    contractRepo.getAll({ includeArchived: false }),
    litterRepo.getAll({ includeArchived: true })
  ]);
  // Active-kennel scope (Multi-Kennel Scope Spec §7). Sales carry the kennel they
  // were placed FROM. Contracts are scoped too — the "+ Link contract" picker
  // must not offer another kennel's contract, since linking it would silently
  // move that contract's subject across kennels. The dog/contact/litter loads
  // stay unscoped: they resolve the names ON the scoped cards (a litter header, a
  // buyer, an external dog), which is lookup, not listing.
  const sales = inScopeOnly(allSales);
  const contracts = inScopeOnly(allContracts);
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

  const sections = orderedLitters.map((litter) => groupCardHtml(
    `sales-litter:${litter.id}`,
    litterHeaderLabel(litter, dogsById),
    `<div style="margin:8px 0 4px;"><a class="btn btn-sm" href="litter.html?id=${encodeURIComponent(litter.id)}">Open litter</a></div>`,
    orderedSales(litterGroups.get(litter.id), dogsById),
    cardHtml
  ));

  const shownHtml = sections.slice(0, PAGE_SIZE).join('');
  const rest = sections.slice(PAGE_SIZE);
  const restHtml = rest.length
    ? `<div id="sales-more" hidden>${rest.join('')}</div>
       <div style="margin-top:14px;"><button class="btn" id="show-more-btn">Show ${rest.length} more litter${rest.length === 1 ? '' : 's'} ▾</button></div>`
    : '';
  const externalHtml = externalByDog.size
    ? groupCardHtml('sales-external', 'External Acquisitions', '', orderedSales(externalByDog, dogsById), cardHtml)
    : '';

  // A re-render (after linking or unlinking a contract) keeps what she had open:
  // the litter cards, their ended-sales lists, and the "Show more" litters.
  const openCards = new Set([...body.querySelectorAll('.card-collapsible')]
    .filter((c) => !c.querySelector('.card-body')?.hidden).map((c) => c.dataset.card));
  const openEnded = new Set([...body.querySelectorAll('.card-collapsible details[open]')]
    .map((d) => d.closest('.card-collapsible').dataset.card));
  const moreShown = body.querySelector('#sales-more') && !body.querySelector('#sales-more').hidden;

  body.innerHTML = shownHtml + restHtml + externalHtml;
  for (const card of body.querySelectorAll('.card-collapsible')) {
    if (openCards.has(card.dataset.card)) {
      card.querySelector('.card-body').hidden = false;
      const toggle = card.querySelector('.card-toggle-btn');
      toggle.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('aria-label', 'Collapse card');
    }
    if (openEnded.has(card.dataset.card)) card.querySelector('details')?.setAttribute('open', '');
  }
  const btn = document.getElementById('show-more-btn');
  const showMore = () => { document.getElementById('sales-more').hidden = false; btn.remove(); };
  if (btn) {
    if (moreShown) showMore();
    else btn.addEventListener('click', showMore);
  }
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
// The same picker as Kels's Pups are going home: a litter with pups still at home, then
// which pups (ticked: a sale at Deposit paid or later; a pup with no sale prints
// too, without the buyer block). "Other puppies" holds pups with a sale in
// progress that aren't on one of those litters (a grown dog sold, say). Prints
// one file (puppy-record.html?dogs=…), optionally after the breeder's cover page.
async function openPrintModal() {
  const [litters, dogs, sales] = await Promise.all([
    litterRepo.getAll({ includeArchived: false }), dogRepo.getAll({ includeArchived: false }), saleRepo.getAll({ includeArchived: false })
  ]);
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const saleOf = (dog) => pupSale(sales.filter((x) => x.dog_id === dog.id));
  const groups = prepLitters(inScopeOnly(litters), dogs, sales).map((l) => ({
    id: l.id, label: litterLabel(l, dogsById), pups: homePups(rosterOf(l.id, dogs), sales)
  }));
  const grouped = new Set(groups.flatMap((g) => g.pups.map((p) => p.id)));
  const others = [...new Set(sales.filter(isOpenSale).map((x) => x.dog_id))]
    .map((id) => dogsById.get(id)).filter((d) => d && !grouped.has(d.id) && inScopeOnly([d]).length)
    .sort((a, b) => (a.call_name || '').localeCompare(b.call_name || ''));
  if (others.length) groups.push({ id: 'other', label: 'Other puppies with a sale', pups: others });

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <h2 style="margin-top:0;">Print Puppy Records</h2>
      ${groups.length ? `
        <div class="field">
          <label for="ppm-litter">Litter</label>
          <select id="ppm-litter">${groups.map((g) => `<option value="${esc(g.id)}">${esc(g.label)}</option>`).join('')}</select>
        </div>
        <div class="field"><label>Puppies</label><div id="ppm-pups" style="display:flex; flex-direction:column; gap:6px;"></div></div>
        <label class="check-inline"><input type="checkbox" id="ppm-cover"> Start with my readiness cover page</label>
        <div id="ppm-error"></div>` : `<p class="muted">No puppies at home or with a sale in progress.</p>`}
      <div class="form-actions">
        ${groups.length ? `<button class="btn btn-primary" id="ppm-print">Print</button>` : ''}
        <button class="btn" id="ppm-cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('#ppm-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  if (!groups.length) return;

  const select = overlay.querySelector('#ppm-litter');
  const list = overlay.querySelector('#ppm-pups');
  const showPups = () => {
    const g = groups.find((x) => x.id === select.value);
    list.innerHTML = g.pups.map((d) => {
      const sale = saleOf(d);
      const buyer = sale ? state.contactsById.get(sale.buyer_contact_id)?.name || '' : '';
      return `<label class="check-inline"><input type="checkbox" value="${esc(d.id)}"${pickedByDefault(sale) ? ' checked' : ''}> ${esc(d.call_name || d.registered_name || '(unnamed)')}${buyer ? ` → ${esc(buyer)}` : sale ? '' : ' <span class="muted">(no sale)</span>'}</label>`;
    }).join('');
  };
  select.addEventListener('change', showPups);
  showPups();

  overlay.querySelector('#ppm-print').addEventListener('click', () => {
    const ids = [...list.querySelectorAll('input:checked')].map((c) => c.value);
    if (!ids.length) { overlay.querySelector('#ppm-error').innerHTML = '<div class="inline-error">Tick at least one puppy.</div>'; return; }
    const cover = overlay.querySelector('#ppm-cover').checked ? '&cover=1' : '';
    // autoprint=1 tells puppy-record.js to invoke window.print() itself once
    // it finishes rendering, so this really is a one-click "Print" button.
    window.open(`puppy-record.html?dogs=${ids.map(encodeURIComponent).join(',')}${cover}&autoprint=1`, '_blank');
    close();
  });
}

document.getElementById('btn-print-puppy-record')?.addEventListener('click', () => openPrintModal().catch((e) => showError(e.message || String(e))));

main().catch((e) => showError(e.message || String(e)));
