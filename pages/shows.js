// shows.js — the Shows page (Show Tracking Spec §5.2, Pro-only: listed in
// data/proPages.js, so it's physically absent from the Lite build).
//
// Two seg-tabs over the same `show` events (one per dog per show day):
//   Upcoming — event_date >= today, not scratched, grouped by date so a cluster
//              weekend reads as a block; entries close (reminder_date) flagged
//              amber within 7 days, red once past while still `planned`.
//   Results  — event_date < today, with dog / organization / period / track
//              filters and the reportView CSV export.
// Both are scoped through the event's dog (subjectInScope), like every other list.
// Rows open the event's own edit modal in place.
//
// "Add entries" (Upcoming tab) creates one `show` event per picked dog per picked
// date through eventRepo — the same shape the event form writes. No cost field;
// fees are added per entry afterwards.
import { HistoryEvent } from '../data/eventRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { subjectInScope, dogInScope } from '../data/kennelScope.js';
import { addDaysToYMD } from '../data/dateUtils.js';
import { createReportView } from '../assets/reportView.js';
import { openEventForm } from '../assets/eventForm.js';
import { attachNewContactButton } from '../assets/contactPicker.js';
import { esc, fmtDate, todayYMD, param } from '../assets/ui.js';
import {
  SHOW_ENTRY_STATUS, SHOW_ORGANIZATIONS, TITLE_TRACKS, descriptor
} from '../data/vocab.js';

const TABS = [
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'results',  label: 'Results' }
];

const ctx = {
  tab: TABS.some((t) => t.value === param('tab')) ? param('tab') : 'upcoming',
  dogs: [],
  dogsById: new Map(),
  contacts: [],
  contactsById: new Map(),
  view: null
};

const els = {
  tabs: document.getElementById('shows-tabs'),
  actions: document.getElementById('header-actions'),
  error: document.getElementById('page-error'),
  mount: document.getElementById('shows-mount')
};

const dogLabel = (id) => ctx.dogsById.get(id)?.call_name || '—';
const contactLabel = (id) => (id ? ctx.contactsById.get(id)?.name || '' : '');
const det = (ev) => ev.details || {};
const showLabel = (ev) => det(ev).show_name || ev.title || '';
// "Saturday" for a YYYY-MM-DD (local) — the Upcoming group header, so a cluster
// weekend reads Fri / Sat / Sun at a glance.
const weekday = (ymd) => {
  const [y, m, d] = String(ymd || '').split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long' }) + ' ·' : '';
};
const trackLabel = (v) => (v ? descriptor(TITLE_TRACKS, v).label : '');

async function loadRefs() {
  const [dogs, contacts] = await Promise.all([
    dogRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true })
  ]);
  ctx.dogs = dogs;
  ctx.dogsById = new Map(dogs.map((d) => [d.id, d]));
  ctx.contacts = contacts;
  ctx.contactsById = new Map(contacts.map((c) => [c.id, c]));
}

// Dog-subject show events only (show is a dog-only type; the guard just keeps a
// malformed import from rendering a dangling subject).
async function loadShows() {
  return (await HistoryEvent.getByType('show')).filter((e) => e.subject_type === 'dog');
}

const scope = (e) => subjectInScope(e.subject_type, e.subject_id, { dog: ctx.dogsById });

function editRow(ev) {
  openEventForm({
    subjectType: 'dog', subjectId: ev.subject_id, event: ev,
    onSaved: () => ctx.view?.refresh()
  });
}

function renderTabs() {
  els.tabs.innerHTML = TABS.map((t) => t.value === ctx.tab
    ? `<span class="seg-tab active" aria-current="page">${esc(t.label)}</span>`
    : `<a class="seg-tab" href="shows.html?tab=${encodeURIComponent(t.value)}">${esc(t.label)}</a>`).join('');
}

// --- Upcoming -----------------------------------------------------------------

// Entries-close flag: red once the deadline has passed while the entry is still
// only `planned`; amber when it closes within the next 7 days.
function entriesCloseTone(ev, today) {
  const close = ev.reminder_date;
  if (!close) return null;
  if (close < today) return det(ev).entry_status === 'planned' ? 'badge-red' : null;
  if (close <= addDaysToYMD(today, 7)) return 'badge-amber';
  return null;
}

function renderUpcoming() {
  const today = todayYMD();
  els.actions.innerHTML = `<button class="btn btn-primary btn-sm" id="btn-add-entries">+ Add entries</button>`;
  els.actions.querySelector('#btn-add-entries').addEventListener('click', openAddEntries);
  ctx.view = createReportView({
    mount: els.mount,
    scope,
    csvFilename: `shows-upcoming-${today}.csv`,
    search: { placeholder: 'Search dog, show, location…', text: (e) => `${dogLabel(e.subject_id)} ${showLabel(e)} ${det(e).club || ''} ${det(e).location || ''}` },
    filters: [
      { id: 'status', label: 'Status', options: SHOW_ENTRY_STATUS.filter((s) => s.value !== 'scratched'), match: (e, v) => det(e).entry_status === v }
    ],
    groupBy: (e) => `${weekday(e.event_date)} ${fmtDate(e.event_date)}`.trim(),
    columns: [
      { header: 'Date', value: (e) => fmtDate(e.event_date), csv: (e) => e.event_date || '' },
      { header: 'Dog', value: (e) => dogLabel(e.subject_id) },
      { header: 'Show', value: showLabel },
      { header: 'Location', value: (e) => det(e).location || '' },
      { header: 'Ring', value: (e) => [det(e).ring, det(e).ring_time].filter(Boolean).join(' · ') },
      { header: 'Handler', value: (e) => contactLabel(e.related_contact_id) },
      { header: 'Status', value: (e) => det(e).entry_status || '', badge: SHOW_ENTRY_STATUS, csv: (e) => (det(e).entry_status ? descriptor(SHOW_ENTRY_STATUS, det(e).entry_status).label : '') },
      { header: 'Entries close', value: (e) => (e.reminder_date ? fmtDate(e.reminder_date) : ''), csv: (e) => e.reminder_date || '', tone: (e) => entriesCloseTone(e, today) }
    ],
    onRowClick: editRow,
    load: async () => (await loadShows()).filter((e) => e.event_date >= today && det(e).entry_status !== 'scratched'),
    emptyText: 'No upcoming shows. Use “+ Add entries” to plan a show weekend.'
  });
}

// --- Results ------------------------------------------------------------------

function renderResults() {
  const today = todayYMD();
  els.actions.innerHTML = '';
  // Filter options are built from the past shows actually on file: dogs that have
  // shown, and the years they've shown in (plus a rolling "last 12 months").
  loadShows().then((all) => {
    const past = all.filter((e) => e.event_date < today);
    const dogIds = [...new Set(past.map((e) => e.subject_id))];
    const dogOptions = dogIds
      .map((id) => ({ value: id, label: dogLabel(id) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const years = [...new Set(past.map((e) => (e.event_date || '').slice(0, 4)).filter(Boolean))].sort().reverse();
    const yearAgo = addDaysToYMD(today, -365);
    const periodOptions = [{ value: 'last12', label: 'Last 12 months' }, ...years.map((y) => ({ value: y, label: y }))];

    ctx.view = createReportView({
      mount: els.mount,
      scope,
      csvFilename: `shows-results-${today}.csv`,
      search: { placeholder: 'Search dog, show, judge…', text: (e) => `${dogLabel(e.subject_id)} ${showLabel(e)} ${det(e).judge || ''} ${det(e).placement || ''}` },
      filters: [
        { id: 'dog', label: 'Dog', options: dogOptions, match: (e, v) => e.subject_id === v },
        { id: 'org', label: 'Organization', options: SHOW_ORGANIZATIONS, match: (e, v) => det(e).organization === v },
        { id: 'period', label: 'Period', options: periodOptions, match: (e, v) => (v === 'last12' ? e.event_date >= yearAgo : (e.event_date || '').startsWith(v)) },
        { id: 'track', label: 'Track', options: TITLE_TRACKS, match: (e, v) => det(e).points_toward === v }
      ],
      columns: [
        { header: 'Date', value: (e) => fmtDate(e.event_date), csv: (e) => e.event_date || '' },
        { header: 'Dog', value: (e) => dogLabel(e.subject_id) },
        { header: 'Show', value: showLabel },
        { header: 'Judge', value: (e) => det(e).judge || '' },
        { header: 'Class', value: (e) => det(e).class || '' },
        { header: 'Award', value: (e) => det(e).placement || '' },
        { header: 'Points', value: (e) => (det(e).points === '' || det(e).points == null ? '' : String(det(e).points)) },
        { header: 'Track', value: (e) => trackLabel(det(e).points_toward) },
        { header: 'Status', value: (e) => det(e).entry_status || '', badge: SHOW_ENTRY_STATUS, csv: (e) => (det(e).entry_status ? descriptor(SHOW_ENTRY_STATUS, det(e).entry_status).label : '') }
      ],
      onRowClick: editRow,
      // Newest first — a results list reads backwards from the latest show.
      load: async () => (await loadShows()).filter((e) => e.event_date < today).reverse(),
      emptyText: 'No past show results yet.'
    });
  });
}

// --- Add entries (multi-dog × multi-day) -----------------------------------------

async function openAddEntries() {
  const clubs = await HistoryEvent.getDetailValues('show', 'club');
  const state = { allKennels: false, dogIds: new Set(), dates: [] };
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true" id="ae-modal"></div>`;
  const modal = overlay.querySelector('.modal');
  document.body.appendChild(overlay);
  const close = () => overlay.remove();

  // Pickable dogs: not archived, not deceased; scoped to the active kennel unless
  // "all my kennels" is ticked (an external dog is in scope everywhere).
  const pickableDogs = () => ctx.dogs
    .filter((d) => !d.is_archived && d.status !== 'deceased')
    .filter((d) => state.allKennels || state.dogIds.has(d.id) || dogInScope(d))
    .sort((a, b) => (a.call_name || '').localeCompare(b.call_name || ''));

  function dogListHtml() {
    const dogs = pickableDogs();
    if (!dogs.length) return `<p class="muted">No dogs to pick.</p>`;
    return dogs.map((d) => `<label class="check-inline" style="display:block; margin:4px 0;">
      <input type="checkbox" data-dog="${esc(d.id)}"${state.dogIds.has(d.id) ? ' checked' : ''}> ${esc(d.call_name)}${d.registered_name ? ` <span class="faint">${esc(d.registered_name)}</span>` : ''}
    </label>`).join('');
  }
  function datesHtml() {
    if (!state.dates.length) return `<span class="faint">No dates yet — add each show day.</span>`;
    return state.dates.map((d, i) => `<span class="badge badge-neutral" style="margin:2px 4px 2px 0;">${esc(fmtDate(d))} <button type="button" class="btn btn-sm" data-rm-date="${i}" aria-label="Remove ${esc(fmtDate(d))}" style="padding:0 6px; margin-left:4px;">✕</button></span>`).join('');
  }
  const contactOptions = (current) => `<option value="">— owner-handled —</option>` + ctx.contacts
    .filter((c) => !c.is_archived || c.id === current)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map((c) => `<option value="${esc(c.id)}"${c.id === current ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  const countLabel = () => {
    const n = state.dogIds.size * state.dates.length;
    return n ? `Create ${n} ${n === 1 ? 'entry' : 'entries'}` : 'Create entries';
  };

  modal.innerHTML = `
    <div class="row-between" style="margin-bottom:12px;">
      <h2 style="margin:0;">Add show entries</h2>
      <button class="btn btn-sm" data-act="cancel">✕</button>
    </div>
    <p class="field-hint">One show record is created per dog per show day. Results, points and fees are filled in on each entry afterwards.</p>
    <div class="form-grid">
      <div class="field field-wide"><label>Dogs <span class="req">*</span></label>
        <label class="check-inline"><input type="checkbox" id="ae-all-kennels"> Show dogs from all my kennels</label>
        <div id="ae-dogs" style="max-height:200px; overflow-y:auto; border:1px solid var(--border); border-radius:var(--radius); padding:6px 10px; margin-top:6px;"></div></div>
      <div class="field field-wide"><label>Show days <span class="req">*</span></label>
        <div class="pill-row"><input id="ae-date" type="date"> <button type="button" class="btn btn-sm" id="ae-add-date">Add day</button> <button type="button" class="btn btn-sm" id="ae-next-day">+ Next day</button></div>
        <div id="ae-dates" style="margin-top:6px;"></div></div>
      <div class="field field-wide"><label>Show <span class="req">*</span></label>
        <input id="ae-show-name" type="text" placeholder="e.g. Greater Example KC — Show 1">
        <span class="field-hint">Also the entry title. A same-day double-header needs a second run with a different name.</span></div>
      <div class="field"><label>Club</label>
        <input id="ae-club" type="text" list="ae-dl-club"><datalist id="ae-dl-club">${clubs.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist></div>
      <div class="field"><label>Organization</label>
        <select id="ae-org">${SHOW_ORGANIZATIONS.map((o) => `<option value="${esc(o.value)}"${o.value === 'AKC' ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>
      <div class="field"><label>Location</label><input id="ae-location" type="text"></div>
      <div class="field"><label>Handler</label><select id="ae-handler">${contactOptions('')}</select></div>
      <div class="field"><label>Entries close</label><input id="ae-close" type="date">
        <span class="field-hint">Becomes each entry's reminder.</span></div>
      <div class="field"><label>Entry status</label>
        <select id="ae-status">${SHOW_ENTRY_STATUS.map((s) => `<option value="${esc(s.value)}"${s.value === 'planned' ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}</select></div>
    </div>
    <div id="ae-error"></div>
    <div class="form-actions">
      <button class="btn btn-primary" data-act="save" id="ae-save">${esc(countLabel())}</button>
      <button class="btn" data-act="cancel">Cancel</button>
    </div>`;

  const $ = (sel) => modal.querySelector(sel);
  const showError = (msg) => { $('#ae-error').innerHTML = msg ? `<div class="inline-error">${esc(msg)}</div>` : ''; };
  const refreshCount = () => { $('#ae-save').textContent = countLabel(); };

  function drawDogs() {
    $('#ae-dogs').innerHTML = dogListHtml();
    $('#ae-dogs').querySelectorAll('[data-dog]').forEach((cb) => cb.addEventListener('change', () => {
      if (cb.checked) state.dogIds.add(cb.dataset.dog); else state.dogIds.delete(cb.dataset.dog);
      refreshCount();
    }));
  }
  function drawDates() {
    $('#ae-dates').innerHTML = datesHtml();
    $('#ae-dates').querySelectorAll('[data-rm-date]').forEach((b) => b.addEventListener('click', () => {
      state.dates.splice(Number(b.dataset.rmDate), 1);
      drawDates();
      refreshCount();
    }));
  }
  function addDate(ymd) {
    if (!ymd || state.dates.includes(ymd)) return;
    state.dates.push(ymd);
    state.dates.sort();
    drawDates();
    refreshCount();
  }
  drawDogs();
  drawDates();

  $('#ae-all-kennels').addEventListener('change', (e) => { state.allKennels = e.target.checked; drawDogs(); });
  $('#ae-add-date').addEventListener('click', () => addDate($('#ae-date').value));
  // Cluster weekends: "+ Next day" adds the day after the latest one picked.
  $('#ae-next-day').addEventListener('click', () => {
    const last = state.dates[state.dates.length - 1];
    addDate(last ? addDaysToYMD(last, 1) : $('#ae-date').value);
  });
  attachNewContactButton($('#ae-handler'), {
    onCreated: (c) => { ctx.contacts.push(c); ctx.contactsById.set(c.id, c); }
  });
  modal.querySelectorAll('[data-act="cancel"]').forEach((b) => b.addEventListener('click', close));

  let saving = false;
  $('#ae-save').addEventListener('click', async () => {
    if (saving) return;
    showError('');
    const showName = $('#ae-show-name').value.trim();
    if (!state.dogIds.size) return showError('Pick at least one dog.');
    if (!state.dates.length) return showError('Add at least one show day.');
    if (!showName) return showError('Name the show.');
    const handlerId = $('#ae-handler').value || null;
    const closeDate = $('#ae-close').value || null;
    const details = {
      entry_status: $('#ae-status').value,
      show_name: showName,
      club: $('#ae-club').value.trim(),
      organization: $('#ae-org').value,
      location: $('#ae-location').value.trim()
    };
    // One per dog per show day: an entry already on file for the same dog, day
    // and title is skipped rather than duplicated.
    const existing = await HistoryEvent.getByType('show');
    const key = (dogId, date, title) => `${dogId}|${date}|${String(title || '').trim().toLowerCase()}`;
    const onFile = new Set(existing.map((e) => key(e.subject_id, e.event_date, e.title)));
    const plan = [];
    let skipped = 0;
    for (const dogId of state.dogIds) {
      for (const date of state.dates) {
        if (onFile.has(key(dogId, date, showName))) { skipped += 1; continue; }
        plan.push({ dogId, date });
      }
    }
    if (!plan.length) return showError('Every one of these entries is already on file.');
    saving = true;
    $('#ae-save').disabled = true;
    try {
      for (const { dogId, date } of plan) {
        await HistoryEvent.create({
          subject_type: 'dog', subject_id: dogId, event_type: 'show',
          event_date: date, event_end_date: null,
          related_contact_id: handlerId, title: showName,
          details: { ...details }, reminder_date: closeDate, notes: ''
        });
      }
      // Tag the handler, same as the event form's save (Show Tracking Spec §2.2).
      if (handlerId) await contactRepo.ensureType(handlerId, 'handler');
      close();
      els.error.innerHTML = `<div class="inline-warn" style="color:var(--accent-dark);background:var(--accent-soft);border-color:#bfe0cd;">Created ${plan.length} ${plan.length === 1 ? 'entry' : 'entries'}${skipped ? ` — ${skipped} already on file, skipped` : ''}.</div>`;
      ctx.view?.refresh();
    } catch (e) {
      saving = false;
      $('#ae-save').disabled = false;
      showError(e.message || String(e));
    }
  });
}

async function main() {
  renderTabs();
  await loadRefs();
  if (ctx.tab === 'results') renderResults();
  else renderUpcoming();
}

main();
