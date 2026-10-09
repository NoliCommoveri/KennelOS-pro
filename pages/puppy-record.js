// puppy-record.js — Puppy Record print/PDF view (?sale=<id>). Resolves the
// puppy, its sire/dam (with genetic + breed-specific test results), its
// health-history events, and the buyer contact off the Sale, then renders a
// print-ready record — "download" is the browser's own Print → Save as PDF,
// so this needs no vendored PDF library (CLAUDE.md's no-CDN/vendor-everything
// rule would otherwise apply to a PDF-generation dependency).
import { saleRepo } from '../data/saleRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { eventRepo } from '../data/eventRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { getActiveKennel } from '../data/kennelScope.js';
import { descriptor, SEX, EVENT_TYPES } from '../data/vocab.js';
import { PUPPY_RECORD_HEALTH_TYPES as HEALTH_EVENT_TYPES, puppyRecordShows, healthKey } from '../data/puppyRecordFields.js';
import { esc, param } from '../assets/ui.js';

const root = document.getElementById('pr-root');

// Which fields print — the resolving kennel's "Puppy Record fields" picks
// (data/puppyRecordFields.js), set once that kennel is known in main().
let shows = () => true;

// This page's own date format (mm/dd/yyyy) — deliberately not the shared
// ui.js fmtDate (localized "medium" style), a print-record convention call.
function fmtDateMDY(ymd) {
  if (!ymd) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return ymd;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

function eventTypeLabel(type) {
  return descriptor(EVENT_TYPES, type).label;
}

// One curated detail line per health event type, built from its own
// details{} fields (mirrors timeline.js's detailsSummary, scoped to what's
// worth printing).
function eventDetail(ev) {
  const d = ev.details || {};
  switch (ev.event_type) {
    case 'vaccination':
      return [d.vaccine, d.lot_number ? `Lot ${d.lot_number}` : '', d.next_due ? `Next due ${fmtDateMDY(d.next_due)}` : '']
        .filter(Boolean).join(' — ');
    case 'preventative':
      return [d.product, d.dose].filter(Boolean).join(' — ');
    case 'genetic_test':
      return [d.panel_name, d.lab, d.result].filter(Boolean).join(' — ');
    case 'ofa_pennhip':
      return [d.joint, d.method, d.rating].filter(Boolean).join(' — ');
    case 'breed_specific_test':
      return [d.test_name, d.result].filter(Boolean).join(' — ');
    case 'illness':
      return [d.diagnosis, d.treatment].filter(Boolean).join(' — ');
    case 'medication':
      return [d.drug, d.dose, d.frequency].filter(Boolean).join(' — ');
    case 'surgery':
      return [d.procedure, d.vet, d.outcome].filter(Boolean).join(' — ');
    case 'vet_visit':
      return [d.reason, d.vet, d.findings].filter(Boolean).join(' — ');
    case 'injury':
      return [d.description, d.severity].filter(Boolean).join(' — ');
    case 'abnormalities':
      return d.type || '';
    case 'weight_check': {
      const parts = [];
      if (d.weight_lbs != null && d.weight_lbs !== '') parts.push(`${d.weight_lbs} lb`);
      if (d.weight_oz != null && d.weight_oz !== '') parts.push(`${d.weight_oz} oz`);
      if (d.time_of_day) parts.push(d.time_of_day);
      return parts.join(' ');
    }
    default:
      return '';
  }
}

// A "label: value" row — omitted entirely when the value is empty (no null
// placeholders anywhere in this document, per owner decision).
function row(label, value) {
  if (value == null || value === '') return '';
  return `<div class="pr-row"><span class="pr-k">${esc(label)}</span><span class="pr-v">${value}</span></div>`;
}

// A shared, centered "pulled out of the box" section title — Puppy
// Information / Parents / Health History / Buyer all use this same one so
// the page reads as a sequence of equally-weighted labeled blocks.
function sectionLabel(text) {
  return `<h2 class="pr-section-label">${esc(text)}</h2>`;
}

// Splits a set of already-rendered rows into side-by-side columns of up to
// `size` PRESENT rows each — a puppy/parent with a lot of recorded fields
// flows sideways into a new column after 5, instead of stretching tall.
function columnedRows(rowsHtml, size = 5) {
  const present = rowsHtml.filter(Boolean);
  if (!present.length) return '<p class="pr-empty">No details recorded.</p>';
  const columns = [];
  for (let i = 0; i < present.length; i += size) columns.push(present.slice(i, i + size));
  if (columns.length === 1) return columns[0].join('');
  return `<div class="pr-info-columns">${columns.map((c) => `<div class="pr-info-col">${c.join('')}</div>`).join('')}</div>`;
}

// Genetic + breed-specific test results for a dog, as a single pipe-separated
// line ("Panel: Result | Test: Result"). Empty string when none exist, so the
// caller can omit the line entirely.
async function testsLine(dogId) {
  if (!dogId) return '';
  const events = await eventRepo.getForSubject('dog', dogId);
  const parts = [];
  for (const e of events) {
    const d = e.details || {};
    if (e.event_type === 'genetic_test' && d.result) {
      parts.push(`${esc(d.panel_name || 'Genetic test')}: ${esc(d.result)}`);
    } else if (e.event_type === 'breed_specific_test' && d.result) {
      parts.push(`${esc(d.test_name || 'Test')}: ${esc(d.result)}`);
    }
  }
  return parts.join(' | ');
}

async function parentCard(role, dog) {
  if (!dog) {
    return `<div class="pr-parent">
      <div class="pr-parent-role">${esc(role)}</div>
      <div class="pr-empty">Unknown</div>
    </div>`;
  }
  const tests = shows('parentTests') ? await testsLine(dog.id) : '';
  const rows = [
    shows('parentRegisteredName') && row('Registered name', dog.registered_name ? esc(dog.registered_name) : ''),
    shows('parentCallName') && row('Call name', dog.call_name ? esc(dog.call_name) : ''),
    shows('parentBreed') && row('Breed', dog.breed ? esc(dog.breed) : ''),
    shows('parentRegistrationNumber') && row('Registration #', dog.registration_number ? esc(dog.registration_number) : '')
  ];
  return `<div class="pr-parent">
    <div class="pr-parent-role">${esc(role)}</div>
    ${columnedRows(rows)}
    ${tests ? `<div class="pr-tests">${tests}</div>` : ''}
  </div>`;
}

function puppyInfoCard(dog, litter) {
  const rows = [
    shows('callName') && row('Call name', dog.call_name ? `<strong>${esc(dog.call_name)}</strong>` : ''),
    shows('registeredName') && row('Registered name', dog.registered_name ? esc(dog.registered_name) : ''),
    shows('sex') && row('Sex', dog.sex ? esc(descriptor(SEX, dog.sex).label) : ''),
    shows('dateOfBirth') && row('Date of birth', dog.date_of_birth ? esc(fmtDateMDY(dog.date_of_birth)) : ''),
    shows('breed') && row('Breed', dog.breed ? esc(dog.breed) : ''),
    shows('colorMarkings') && row('Color / markings', dog.color_markings ? esc(dog.color_markings) : ''),
    shows('microchip') && row('Microchip ID', dog.microchip_id ? esc(dog.microchip_id) : ''),
    shows('registry') && row('Registry', dog.registry ? esc(dog.registry) : ''),
    shows('registrationNumber') && row('Registration #', dog.registration_number ? esc(dog.registration_number) : ''),
    shows('litterRegistration') && row('Litter registration #', litter && litter.litter_registration_number ? esc(litter.litter_registration_number) : '')
  ];
  return `<section class="pr-card">${columnedRows(rows)}</section>`;
}

// Deals the Health History cards into HEALTH_COLUMNS stacks, each card onto
// whichever stack is shortest so far (by line count, which holds at any page
// width — on screen or on paper). Ties go left, so the cards still read in
// HEALTH_EVENT_TYPES order across the top row.
const HEALTH_COLUMNS = 3;

function healthCardLines(events) {
  return 1 + healthItems(events).reduce((n, it) => n + 2 + (it.notes ? 1 : 0), 0);
}

// One line per distinct item rather than per entry (owner call, 2026-10-09): every
// entry with the same title, details and notes — five days of Panacur — folds into
// one line, its dates listed newest first as a comma-separated string. Entries
// come newest first (eventRepo.getForSubject), so the lines are ordered by each
// item's latest date. A title that only repeats the card's heading ("Preventative"
// under Preventative) is left off.
function healthItems(events) {
  const items = new Map();
  for (const ev of events) {
    const title = ev.title && ev.title.trim().toLowerCase() !== eventTypeLabel(ev.event_type).toLowerCase() ? ev.title.trim() : '';
    const label = [title, eventDetail(ev)].filter(Boolean).join(' — ') || eventTypeLabel(ev.event_type);
    const notes = shows('healthNotes') ? (ev.notes || '').trim() : '';
    const key = `${label}\u0000${notes}`;
    if (!items.has(key)) items.set(key, { label, notes, dates: [] });
    items.get(key).dates.push(fmtDateMDY(ev.event_date));
  }
  return [...items.values()];
}

function healthCardsHtml(byType) {
  const groups = HEALTH_EVENT_TYPES
    .filter((type) => shows(healthKey(type)))
    .map((type) => ({ type, events: byType.get(type) || [] }))
    .filter((g) => g.events.length);
  if (!groups.length) return '<p class="pr-empty">No health events to show.</p>';
  const cols = Array.from({ length: HEALTH_COLUMNS }, () => ({ lines: 0, cards: [] }));
  for (const g of groups) {
    const col = cols.reduce((min, c) => (c.lines < min.lines ? c : min));
    col.cards.push(healthCardHtml(g));
    col.lines += healthCardLines(g.events);
  }
  return `<div class="pr-health-grid">${cols.map((c) => `<div class="pr-health-col">${c.cards.join('')}</div>`).join('')}</div>`;
}

function healthCardHtml(g) {
  const items = healthItems(g.events).map((it) => `<li>
      <div>${esc(it.label)}</div>
      <div class="pr-hdate">${esc(it.dates.join(', '))}</div>
      ${it.notes ? `<div class="pr-hnotes">${esc(it.notes)}</div>` : ''}
    </li>`).join('');
  return `<div class="pr-health-card">
    <h3>${esc(eventTypeLabel(g.type))}</h3>
    <ul class="pr-health-list">${items}</ul>
  </div>`;
}

function buyerCardHtml(contact) {
  if (!contact) return '';
  const rows = [
    shows('buyerName') && row('Name', contact.name ? esc(contact.name) : ''),
    shows('buyerPhone') && row('Phone', contact.phone ? esc(contact.phone) : ''),
    shows('buyerEmail') && row('Email', contact.email ? esc(contact.email) : ''),
    shows('buyerAddress') && row('Address', contact.address ? esc(contact.address).replace(/\n/g, '<br>') : '')
  ];
  if (!rows.some(Boolean)) return '';
  return `<section class="pr-card">${columnedRows(rows)}</section>`;
}

async function main() {
  const saleId = param('sale');
  if (!saleId) {
    root.innerHTML = '<p class="pr-empty">No sale specified.</p>';
    return;
  }
  const sale = await saleRepo.getById(saleId);
  if (!sale) {
    root.innerHTML = '<p class="pr-empty">Sale not found.</p>';
    return;
  }
  const dog = await dogRepo.getById(sale.dog_id);
  if (!dog) {
    root.innerHTML = '<p class="pr-empty">Puppy not found.</p>';
    return;
  }
  document.getElementById('pr-back').href = `sale.html?id=${encodeURIComponent(sale.id)}`;

  const [buyer, sire, dam, litter, events, kennels, activeKennel] = await Promise.all([
    sale.buyer_contact_id ? contactRepo.getById(sale.buyer_contact_id) : null,
    dog.sire_id ? dogRepo.getById(dog.sire_id) : null,
    dog.dam_id ? dogRepo.getById(dog.dam_id) : null,
    dog.litter_id ? litterRepo.getById(dog.litter_id) : null,
    eventRepo.getForSubject('dog', dog.id),
    kennelRepo.getAll({ includeArchived: true }),
    getActiveKennel()
  ]);
  // The puppy's own kennel when it's one of the user's own; otherwise the
  // active kennel scope, then the sole own kennel on record as a last resort
  // (Lite, or "All kennels" with just one) — Multi-Kennel Scope Spec §10.
  const ownKennel = (dog.kennel_id && kennels.find((k) => k.id === dog.kennel_id))
    || activeKennel
    || kennels.find((k) => k.is_own_kennel && !k.is_archived)
    || null;
  shows = puppyRecordShows(ownKennel);
  if (ownKennel?.is_own_kennel) {
    const pick = document.getElementById('pr-fields');
    pick.href = `kennel.html?id=${encodeURIComponent(ownKennel.id)}#puppy-record`;
    pick.hidden = false;
  }

  const byType = new Map();
  for (const e of events) {
    if (!HEALTH_EVENT_TYPES.includes(e.event_type)) continue;
    if (!byType.has(e.event_type)) byType.set(e.event_type, []);
    byType.get(e.event_type).push(e);
  }

  const [sireHtml, damHtml] = await Promise.all([parentCard('Sire', sire), parentCard('Dam', dam)]);
  const buyerHtml = shows('buyer') ? buyerCardHtml(buyer) : '';
  // A section whose every field is unticked is left off, heading and all.
  const anyShown = (keys) => keys.some((k) => shows(k));
  const puppyOn = anyShown(['callName', 'registeredName', 'sex', 'dateOfBirth', 'breed', 'colorMarkings', 'microchip', 'registry', 'registrationNumber', 'litterRegistration']);
  const parentsOn = anyShown(['parentRegisteredName', 'parentCallName', 'parentBreed', 'parentRegistrationNumber', 'parentTests']);
  const healthOn = anyShown(HEALTH_EVENT_TYPES.map(healthKey));

  const titleName = dog.call_name || dog.registered_name || 'Puppy';
  document.title = `${titleName} — Puppy Record`;

  root.innerHTML = `
    <div class="pr-header">
      ${ownKennel?.logo_data_url && shows('logo') ? `<img src="${esc(ownKennel.logo_data_url)}" alt="${esc(ownKennel.kennel_name || '')} logo" style="max-height:72px; max-width:200px; object-fit:contain; margin-bottom:6px;">` : ''}
      <h1>${esc(ownKennel?.kennel_name || 'Puppy Record')}</h1>
      <div class="pr-kennel">Puppy Record</div>
      ${shows('generatedDate') ? `<div class="pr-generated">Generated ${esc(fmtDateMDY(new Date().toISOString().slice(0, 10)))}</div>` : ''}
    </div>

    ${puppyOn ? sectionLabel('Puppy Information') + puppyInfoCard(dog, litter) : ''}

    ${parentsOn ? `${sectionLabel('Parents')}
    <div class="pr-parents">
      ${sireHtml}
      ${damHtml}
    </div>` : ''}

    ${healthOn ? sectionLabel('Health History') + healthCardsHtml(byType) : ''}

    ${buyerHtml ? `<div class="pr-keep">${sectionLabel('Buyer')}${buyerHtml}</div>` : ''}
  `;

  // Launched from the Sales hub's "Print Puppy Record" modal (?autoprint=1) —
  // open the browser print dialog as soon as the layout has settled, so that
  // flow really is a single click through to Print/Save-as-PDF.
  if (param('autoprint')) {
    setTimeout(() => window.print(), 200);
  }
}

document.getElementById('pr-print').addEventListener('click', () => window.print());

main();
