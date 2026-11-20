// puppy-record.js — Puppy Record print/PDF view: one sale's pup (?sale=<id>), or
// several pups in one file (?dogs=<id>,<id>…), each record in its own section
// starting a new page, optionally after a cover page for the breeder (&cover=1,
// Kels's Pups are going home and the Sales picker). For each pup it resolves the
// puppy, its sire/dam (with their genetic, OFA and breed-specific test results), its
// health-history events (a vet visit's or surgery's with its vet's contact
// details), and the buyer contact off the Sale, then renders a
// print-ready record — "download" is the browser's own Print → Save as PDF,
// so this needs no vendored PDF library (CLAUDE.md's no-CDN/vendor-everything
// rule would otherwise apply to a PDF-generation dependency).
import { saleRepo } from '../data/saleRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { eventRepo, testTokensOf } from '../data/eventRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { getActiveKennel } from '../data/kennelScope.js';
import { descriptor, SEX, EVENT_TYPES } from '../data/vocab.js';
import { PUPPY_RECORD_HEALTH_TYPES as HEALTH_EVENT_TYPES, puppyRecordShows, healthKey } from '../data/puppyRecordFields.js';
import { contractRepo } from '../data/contractRepo.js';
import { breedFeedingScheduleRepo } from '../data/breedFeedingScheduleRepo.js';
import { editionFlags } from '../data/editionConfig.js';
import { pupSale, readiness, doneText } from '../data/prepPups.js';
import { getSaleStatements } from '../data/incomeView.js';
import { litterLabel } from '../data/litterCheckin.js';
import { esc, param, todayYMD, wireActionMenu } from '../assets/ui.js';
import { shareOrDownload, shareFailText } from '../assets/pdfShare.js';

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
// Contacts by id, for a vet visit's or surgery's linked vet (filled in main,
// before any health entry renders).
let contactsById = new Map();

// The vet line(s) under a Vet visit / Surgery entry: "Vet: name · phone", then
// the address on one line. A linked contact gives all three; a vet only typed
// as text (`details.vet` — KennelAssistant, or logged before the link) gives
// the name alone. Empty for every other type, or when nothing's ticked.
const VET_EVENT_TYPES = ['vet_visit', 'surgery', 'screening_test'];
function vetLines(ev) {
  if (!VET_EVENT_TYPES.includes(ev.event_type)) return [];
  const contact = ev.related_contact_id ? contactsById.get(ev.related_contact_id) : null;
  const name = (contact?.name || ev.details?.vet || '').trim();
  const head = [shows('vetName') && name, shows('vetPhone') && (contact?.phone || '').trim()].filter(Boolean).join(' · ');
  const address = shows('vetAddress')
    ? (contact?.address || '').split('\n').map((l) => l.trim()).filter(Boolean).join(', ')
    : '';
  return [head && `Vet: ${head}`, address].filter(Boolean);
}

function eventDetail(ev) {
  const d = ev.details || {};
  switch (ev.event_type) {
    case 'vaccination':
      return [d.vaccine, d.lot_number ? `Lot ${d.lot_number}` : '', d.next_due ? `Next due ${fmtDateMDY(d.next_due)}` : '']
        .filter(Boolean).join(' — ');
    case 'preventative':
      return [d.product, d.dose].filter(Boolean).join(' — ');
    case 'screening_test':
      return [d.test, d.result].filter(Boolean).join(' — ');
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
      return [d.procedure, d.outcome].filter(Boolean).join(' — ');
    case 'vet_visit':
      return [d.reason, d.findings].filter(Boolean).join(' — ');
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

// The record is built once as a plain model (recordModel / coverModel: text, never
// HTML) and drawn twice from it: as this page (recordHtml / coverHtml, below) and
// as the Share as PDF file (assets/puppyRecordPdf.js). So the page and the file
// always show the same fields.

// A "label: value" field — null when the value is empty (no null placeholders
// anywhere in this document, per owner decision). `bold` for the pup's call name.
function field(label, value, bold = false) {
  if (value == null || value === '') return null;
  return { k: label, v: String(value), bold };
}

// Splits fields into side-by-side columns of up to `size` PRESENT fields each — a
// puppy/parent with a lot of recorded fields flows sideways into a new column
// after 5, instead of stretching tall. [] when none is present.
function columns(fields, size = 5) {
  const present = fields.filter(Boolean);
  const cols = [];
  for (let i = 0; i < present.length; i += size) cols.push(present.slice(i, i + size));
  return cols;
}

// Genetic, OFA / PennHIP and breed-specific test results for a dog, as a single
// pipe-separated line ("Panel: Result | OFA Patella: Grade 1"), newest first.
// Only results with a result/rating; the name is the test's name field (OFA:
// Method + Joint), else the title. Empty string when none, so the caller can
// omit the line entirely.
const TEST_RESULT_FIELD = { genetic_test: 'result', ofa_pennhip: 'rating', breed_specific_test: 'result' };
async function testsLine(dogId) {
  if (!dogId) return '';
  const events = await eventRepo.getForSubject('dog', dogId);
  const parts = [];
  for (const e of events) {
    const f = TEST_RESULT_FIELD[e.event_type];
    const result = f && String((e.details || {})[f] ?? '').trim();
    if (!result) continue;
    const name = testTokensOf(e)[0] || String(e.title ?? '').trim() || descriptor(EVENT_TYPES, e.event_type).label;
    parts.push(`${name}: ${result}`);
  }
  return parts.join(' | ');
}

// → { role, unknown: true } or { role, cols, tests }
async function parentModel(role, dog) {
  if (!dog) return { role, unknown: true };
  const tests = shows('parentTests') ? await testsLine(dog.id) : '';
  return {
    role,
    cols: columns([
      shows('parentRegisteredName') && field('Registered name', dog.registered_name),
      shows('parentCallName') && field('Call name', dog.call_name),
      shows('parentBreed') && field('Breed', dog.breed),
      shows('parentRegistrationNumber') && field('Registration #', dog.registration_number)
    ]),
    tests
  };
}

function puppyInfoColumns(dog, litter) {
  return columns([
    shows('callName') && field('Call name', dog.call_name, true),
    shows('registeredName') && field('Registered name', dog.registered_name),
    shows('sex') && field('Sex', dog.sex ? descriptor(SEX, dog.sex).label : ''),
    shows('dateOfBirth') && field('Date of birth', fmtDateMDY(dog.date_of_birth)),
    shows('breed') && field('Breed', dog.breed),
    shows('colorMarkings') && field('Color / markings', dog.color_markings),
    shows('microchip') && field('Microchip ID', dog.microchip_id),
    shows('registry') && field('Registry', dog.registry),
    shows('registrationNumber') && field('Registration #', dog.registration_number),
    shows('litterRegistration') && field('Litter registration #', litter?.litter_registration_number)
  ]);
}

// Deals the Health History cards into HEALTH_COLUMNS stacks, each card onto
// whichever stack is shortest so far (by line count, which holds at any page
// width — on screen or on paper). Ties go left, so the cards still read in
// HEALTH_EVENT_TYPES order across the top row.
const HEALTH_COLUMNS = 3;

function healthCardLines(card) {
  return 1 + card.items.reduce((n, it) => n + 2 + it.vet.length + (it.notes ? 1 : 0), 0);
}

// One line per distinct item rather than per entry (owner call, 2026-10-09): every
// entry with the same title, details and notes — five days of Panacur — folds into
// one line, its dates listed newest first as a comma-separated string (a vet
// visit also needs the same vet to fold). Entries
// come newest first (eventRepo.getForSubject), so the lines are ordered by each
// item's latest date. A title that only repeats the card's heading ("Preventative"
// under Preventative) is left off.
function healthItems(events) {
  const items = new Map();
  for (const ev of events) {
    const title = ev.title && ev.title.trim().toLowerCase() !== eventTypeLabel(ev.event_type).toLowerCase() ? ev.title.trim() : '';
    const label = [title, eventDetail(ev)].filter(Boolean).join(' — ') || eventTypeLabel(ev.event_type);
    const notes = shows('healthNotes') ? (ev.notes || '').trim() : '';
    const vet = vetLines(ev);
    const key = `${label}\u0000${vet.join('\n')}\u0000${notes}`;
    if (!items.has(key)) items.set(key, { label, vet, notes, dates: [] });
    items.get(key).dates.push(fmtDateMDY(ev.event_date));
  }
  return [...items.values()].map((it) => ({ ...it, dates: it.dates.join(', ') }));
}

// → the cards dealt into HEALTH_COLUMNS columns ([[{ title, items }]]), or [] when
// there's nothing to show.
function healthColumns(byType) {
  const cards = HEALTH_EVENT_TYPES
    .filter((type) => shows(healthKey(type)) && byType.get(type)?.length)
    .map((type) => ({ title: eventTypeLabel(type), items: healthItems(byType.get(type)) }));
  if (!cards.length) return [];
  const cols = Array.from({ length: HEALTH_COLUMNS }, () => ({ lines: 0, cards: [] }));
  for (const card of cards) {
    const col = cols.reduce((min, c) => (c.lines < min.lines ? c : min));
    col.cards.push(card);
    col.lines += healthCardLines(card);
  }
  return cols.map((c) => c.cards);
}

function buyerColumns(contact) {
  if (!contact) return [];
  return columns([
    shows('buyerName') && field('Name', contact.name),
    shows('buyerPhone') && field('Phone', contact.phone),
    shows('buyerEmail') && field('Email', contact.email),
    shows('buyerAddress') && field('Address', contact.address)
  ]);
}

// The pup's own kennel when it's one of the user's own; otherwise the active
// kennel scope, then the sole own kennel on record as a last resort (Lite, or
// "All kennels" with just one) — Multi-Kennel Scope Spec §10.
function resolveKennel(dog, kennels, activeKennel) {
  return (dog.kennel_id && kennels.find((k) => k.id === dog.kennel_id))
    || activeKennel
    || kennels.find((k) => k.is_own_kennel && !k.is_archived)
    || null;
}

// One pup's record, header to buyer, as a model. `sale` may be null (a pup with no
// sale prints without the buyer block). `events`: the pup's events.
//   → { logo, title, sub, generated, sections: [
//        { kind: 'info',    label, cols }           cols [] → "No details recorded."
//        { kind: 'parents', label, parents }        (parentModel)
//        { kind: 'health',  label, columns }        columns [] → "No health events to show."
//        { kind: 'buyer',   label, cols } ] }
async function recordModel(dog, sale, events, ownKennel) {
  const [buyer, sire, dam, litter] = await Promise.all([
    sale?.buyer_contact_id ? contactRepo.getById(sale.buyer_contact_id) : null,
    dog.sire_id ? dogRepo.getById(dog.sire_id) : null,
    dog.dam_id ? dogRepo.getById(dog.dam_id) : null,
    dog.litter_id ? litterRepo.getById(dog.litter_id) : null
  ]);

  const byType = new Map();
  for (const e of events) {
    if (!HEALTH_EVENT_TYPES.includes(e.event_type)) continue;
    if (!byType.has(e.event_type)) byType.set(e.event_type, []);
    byType.get(e.event_type).push(e);
  }

  // A section whose every field is unticked is left off, heading and all.
  const anyShown = (keys) => keys.some((k) => shows(k));
  const sections = [];
  if (anyShown(['callName', 'registeredName', 'sex', 'dateOfBirth', 'breed', 'colorMarkings', 'microchip', 'registry', 'registrationNumber', 'litterRegistration'])) {
    sections.push({ kind: 'info', label: 'Puppy Information', cols: puppyInfoColumns(dog, litter) });
  }
  if (anyShown(['parentRegisteredName', 'parentCallName', 'parentBreed', 'parentRegistrationNumber', 'parentTests'])) {
    sections.push({ kind: 'parents', label: 'Parents', parents: await Promise.all([parentModel('Sire', sire), parentModel('Dam', dam)]) });
  }
  if (anyShown(HEALTH_EVENT_TYPES.map(healthKey))) {
    sections.push({ kind: 'health', label: 'Health History', columns: healthColumns(byType) });
  }
  const buyerCols = shows('buyer') ? buyerColumns(buyer) : [];
  if (buyerCols.length) sections.push({ kind: 'buyer', label: 'Buyer', cols: buyerCols });

  return {
    logo: ownKennel?.logo_data_url && shows('logo') ? ownKennel.logo_data_url : '',
    title: ownKennel?.kennel_name || 'Puppy Record',
    sub: 'Puppy Record',
    generated: shows('generatedDate') ? `Generated ${fmtDateMDY(todayYMD())}` : '',
    sections
  };
}

// The breeder's cover page (&cover=1): the litter(s), today, and each pup's
// readiness (data/prepPups.js, the same rules as Kels's Pups are going home), its drop-off
// date and family. For her, not the families, so the kennel's field picks don't
// apply to it.
//   → { title, label, generated, rows: [{ name, status, family, dropoff, done, missing }] }
//     family '' = no sale; done '' = nothing done yet
async function coverModel(pups) {
  const litterIds = [...new Set(pups.map((p) => p.dog.litter_id).filter(Boolean))];
  const litters = (await Promise.all(litterIds.map((id) => litterRepo.getById(id)))).filter(Boolean);
  const littersById = new Map(litters.map((l) => [l.id, l]));
  const parentIds = [...new Set(litters.flatMap((l) => [l.sire_id, l.dam_id]).filter(Boolean))];
  const parentsById = new Map((await Promise.all(parentIds.map((id) => dogRepo.getById(id)))).filter(Boolean).map((d) => [d.id, d]));
  const schedules = new Map();
  if (editionFlags.feedingSchedule) {
    for (const breed of new Set(pups.map((p) => (p.dog.breed || '').trim()).filter(Boolean))) {
      schedules.set(breed, Boolean(await breedFeedingScheduleRepo.getByBreed(breed)));
    }
  }
  const today = todayYMD();
  // Kels passes the optional checks she ticked (&checks=chip,…); without it, all of them.
  const checks = param('checks') == null ? null : param('checks').split(',').filter(Boolean);
  // Payments read each sale's payment statement, as Kels's check does.
  const statements = await getSaleStatements(pups.map((p) => p.sale).filter(Boolean), { today });
  const rows = await Promise.all(pups.map(async ({ dog, sale, events }) => {
    const contracts = sale && editionFlags.contracts ? await contractRepo.getBySale(sale.id) : [];
    const ready = readiness({
      pup: dog, sale, events, contracts, litter: littersById.get(dog.litter_id) || null, today, flags: editionFlags, checks,
      statement: sale ? statements.get(sale.id) || null : null,
      hasBreedSchedule: schedules.get((dog.breed || '').trim()) || false
    });
    const missing = ready.items.filter((i) => !i.done).map((i) => i.label);
    return {
      name: dog.call_name || dog.registered_name || 'Puppy',
      status: doneText(ready),
      family: sale?.buyer_contact_id ? contactsById.get(sale.buyer_contact_id)?.name || '' : '',
      dropoff: ready.pickupDate ? `Drop-off ${fmtDateMDY(ready.pickupDate)}` : '',
      done: ready.items.filter((i) => i.done).map((i) => i.label).join(', '),
      missing: missing.length ? missing.join(', ') : 'Nothing'
    };
  }));
  return {
    title: 'Getting ready to leave',
    label: litters.map((l) => litterLabel(l, parentsById)).join(', '),
    generated: `${fmtDateMDY(today)} · for you, not the families`,
    rows
  };
}

// --- Drawn as this page ----------------------------------------------------------

function rowHtml(f) {
  const v = esc(f.v).replace(/\n/g, '<br>');
  return `<div class="pr-row"><span class="pr-k">${esc(f.k)}</span><span class="pr-v">${f.bold ? `<strong>${v}</strong>` : v}</span></div>`;
}

function columnsHtml(cols) {
  if (!cols.length) return '<p class="pr-empty">No details recorded.</p>';
  if (cols.length === 1) return cols[0].map(rowHtml).join('');
  return `<div class="pr-info-columns">${cols.map((c) => `<div class="pr-info-col">${c.map(rowHtml).join('')}</div>`).join('')}</div>`;
}

// A shared, centered "pulled out of the box" section title — Puppy
// Information / Parents / Health History / Buyer all use this same one so
// the page reads as a sequence of equally-weighted labeled blocks.
function sectionLabel(text) {
  return `<h2 class="pr-section-label">${esc(text)}</h2>`;
}

function parentHtml(p) {
  if (p.unknown) {
    return `<div class="pr-parent">
      <div class="pr-parent-role">${esc(p.role)}</div>
      <div class="pr-empty">Unknown</div>
    </div>`;
  }
  return `<div class="pr-parent">
    <div class="pr-parent-role">${esc(p.role)}</div>
    ${columnsHtml(p.cols)}
    ${p.tests ? `<div class="pr-tests">${esc(p.tests)}</div>` : ''}
  </div>`;
}

function healthCardHtml(card) {
  const items = card.items.map((it) => `<li>
      <div>${esc(it.label)}</div>
      ${it.vet.map((l) => `<div class="pr-hvet">${esc(l)}</div>`).join('')}
      <div class="pr-hdate">${esc(it.dates)}</div>
      ${it.notes ? `<div class="pr-hnotes">${esc(it.notes)}</div>` : ''}
    </li>`).join('');
  return `<div class="pr-health-card">
    <h3>${esc(card.title)}</h3>
    <ul class="pr-health-list">${items}</ul>
  </div>`;
}

function sectionHtml(s) {
  switch (s.kind) {
    case 'info':
      return sectionLabel(s.label) + `<section class="pr-card">${columnsHtml(s.cols)}</section>`;
    case 'parents':
      return `${sectionLabel(s.label)}<div class="pr-parents">${s.parents.map(parentHtml).join('')}</div>`;
    case 'health':
      return sectionLabel(s.label) + (s.columns.length
        ? `<div class="pr-health-grid">${s.columns.map((c) => `<div class="pr-health-col">${c.map(healthCardHtml).join('')}</div>`).join('')}</div>`
        : '<p class="pr-empty">No health events to show.</p>');
    case 'buyer':
      return `<div class="pr-keep">${sectionLabel(s.label)}<section class="pr-card">${columnsHtml(s.cols)}</section></div>`;
    default:
      return '';
  }
}

function recordHtml(r) {
  return `<section class="pr-pup">
    <div class="pr-header">
      ${r.logo ? `<img src="${esc(r.logo)}" alt="${esc(r.title)} logo" style="max-height:72px; max-width:200px; object-fit:contain; margin-bottom:6px;">` : ''}
      <h1>${esc(r.title)}</h1>
      <div class="pr-kennel">${esc(r.sub)}</div>
      ${r.generated ? `<div class="pr-generated">${esc(r.generated)}</div>` : ''}
    </div>
    ${r.sections.map(sectionHtml).join('\n')}
  </section>`;
}

function coverHtml(c) {
  const rows = c.rows.map((r) => `<tr>
      <td><strong>${esc(r.name)}</strong><div class="pr-cover-sub">${esc(r.status)}</div></td>
      <td>${r.family ? esc(r.family) : '<span class="pr-empty">No sale</span>'}${r.dropoff ? `<div class="pr-cover-sub">${esc(r.dropoff)}</div>` : ''}</td>
      <td>${r.done ? esc(r.done) : '—'}</td>
      <td class="pr-cover-missing">${esc(r.missing)}</td>
    </tr>`);
  return `<section class="pr-cover">
    <div class="pr-header">
      <h1>${esc(c.title)}</h1>
      ${c.label ? `<div class="pr-kennel">${esc(c.label)}</div>` : ''}
      <div class="pr-generated">${esc(c.generated)}</div>
    </div>
    <table class="pr-cover-table">
      <thead><tr><th>Puppy</th><th>Family</th><th>Done</th><th>Missing</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>
  </section>`;
}

// --- Share as PDF ------------------------------------------------------------------

// What Share as PDF draws: set in main() once the page is drawn.
let pdfInput = null; // { cover, records, filename }
let pdfFile = null; // the File, made once per page load
let pdfMaking = null;

// The PDF is made as soon as the page is drawn, so a tap on Share as PDF can hand
// it to the share sheet straight away: iPhone only opens the share sheet for a
// tap, and a share started after a long wait counts as no tap.
function makePdfFile() {
  if (pdfFile) return Promise.resolve(pdfFile);
  if (!pdfMaking) {
    pdfMaking = import('../assets/puppyRecordPdf.js')
      .then((m) => m.puppyRecordPdfFile(pdfInput))
      .then((f) => { pdfFile = f; return f; })
      .finally(() => { pdfMaking = null; });
  }
  return pdfMaking;
}

function shareNote(text, isError = false) {
  const box = document.getElementById('pr-share-note');
  box.className = `no-print ${isError ? 'inline-error' : 'muted'}`;
  box.textContent = text;
  box.hidden = !text;
}

async function onSharePdf() {
  if (!pdfInput) return;
  shareNote('');
  try {
    await shareOrDownload(await makePdfFile());
  } catch (e) {
    shareNote(shareFailText(e, 'Share as PDF'), e?.name !== 'NotAllowedError');
  }
}

async function main() {
  const saleId = param('sale');
  const dogIds = (param('dogs') || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!saleId && !dogIds.length) {
    root.innerHTML = '<p class="pr-empty">No puppy specified.</p>';
    return;
  }

  // Each pup to print, with its sale (?sale= names it; ?dogs= finds each pup's
  // live or delivered sale, prepPups.pupSale) and its events.
  let pups;
  if (saleId) {
    const sale = await saleRepo.getById(saleId);
    if (!sale) { root.innerHTML = '<p class="pr-empty">Sale not found.</p>'; return; }
    const dog = await dogRepo.getById(sale.dog_id);
    if (!dog) { root.innerHTML = '<p class="pr-empty">Puppy not found.</p>'; return; }
    document.getElementById('pr-back').href = `sale.html?id=${encodeURIComponent(sale.id)}`;
    pups = [{ dog, sale }];
  } else {
    const dogs = (await Promise.all(dogIds.map((id) => dogRepo.getById(id)))).filter(Boolean);
    if (!dogs.length) { root.innerHTML = '<p class="pr-empty">Puppy not found.</p>'; return; }
    pups = await Promise.all(dogs.map(async (dog) => ({ dog, sale: pupSale(await saleRepo.getByDog(dog.id)) })));
    const back = document.getElementById('pr-back');
    back.textContent = '← Back';
    back.href = 'sales.html';
  }

  const [kennels, activeKennel, contacts, eventLists] = await Promise.all([
    kennelRepo.getAll({ includeArchived: true }),
    getActiveKennel(),
    contactRepo.getAll({ includeArchived: true }),
    Promise.all(pups.map((p) => eventRepo.getForSubject('dog', p.dog.id)))
  ]);
  pups.forEach((p, i) => { p.events = eventLists[i]; });
  contactsById = new Map(contacts.map((c) => [c.id, c]));
  // The kennel's field picks apply to every pup in the file: the first pup's kennel.
  const ownKennel = resolveKennel(pups[0].dog, kennels, activeKennel);
  shows = puppyRecordShows(ownKennel);
  if (ownKennel?.is_own_kennel) {
    const pick = document.getElementById('pr-fields');
    pick.href = `kennel.html?id=${encodeURIComponent(ownKennel.id)}#puppy-record`;
    pick.hidden = false;
  }

  const first = pups[0].dog;
  const firstName = first.call_name || first.registered_name || 'Puppy';
  document.title = pups.length === 1 ? `${firstName} — Puppy Record` : `${pups.length} Puppy Records`;

  const records = [];
  for (const p of pups) records.push(await recordModel(p.dog, p.sale, p.events, ownKennel));
  const cover = param('cover') ? await coverModel(pups) : null;
  root.innerHTML = (cover ? coverHtml(cover) : '') + records.map(recordHtml).join('');

  pdfInput = { cover, records, filename: pups.length === 1 ? `${firstName} Puppy Record.pdf` : `${pups.length} Puppy Records.pdf` };
  document.getElementById('pr-share').disabled = false;

  // Launched from the Sales hub's "Print Puppy Record" picker or Kels's Pups are going home
  // (?autoprint=1) — open the browser print dialog as soon as the layout has
  // settled, so that flow really is a single click through to Print/Save-as-PDF.
  if (param('autoprint')) {
    setTimeout(() => window.print(), 200);
  }
  // Ready before she taps Share as PDF (makePdfFile); a failure shows on the tap.
  makePdfFile().catch(() => {});
}

document.getElementById('pr-print').addEventListener('click', () => window.print());
document.getElementById('pr-share').addEventListener('click', onSharePdf);
wireActionMenu(document.getElementById('pr-more'));

main();
