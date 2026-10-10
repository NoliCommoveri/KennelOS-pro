// calendar.js — the Calendar page: a month grid over the Event log plus pending
// reminders. Two reads, both existing-shape: eventRepo.getInRange (events whose
// dates touch the month) and eventRepo.getReminders (pending reminders, placed on
// their reminder_date). Nothing is stored — the month lives in the URL (?m=YYYY-MM).
//
// Each day opens a modal listing its items with an "Add to Google Calendar" link:
// a plain https link to Google's prefilled-event page, so nothing leaves the
// device unless the user clicks it (no OAuth, no server, works in every edition).
import { eventRepo } from '../data/eventRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { pairingRepo } from '../data/pairingRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { subjectInScope } from '../data/kennelScope.js';
import { EVENT_TYPES, descriptor } from '../data/vocab.js';
import { esc, badge, fmtDate, dogRefHtml, param, todayYMD } from '../assets/ui.js';
import {
  monthOf, shiftMonth, isMonth, monthGridDates, weekdayHeads, eventSpan, bucketByDay, googleCalendarUrl
} from '../data/calendarMath.js';

const MAX_CHIPS = 3;

const mount = document.getElementById('cal-mount');
const keyEl = document.getElementById('cal-key');
const monthEl = document.getElementById('cal-month');
const errorBox = document.getElementById('page-error');

const ctx = { dogsById: new Map(), pairingsById: new Map(), littersById: new Map() };
let month = isMonth(param('m')) ? param('m') : monthOf(todayYMD());
let byDay = new Map();

const dogName = (id) => ctx.dogsById.get(id)?.call_name || '—';

// Plain-text subject (Google link text) and its linked HTML (the day modal).
function subjectText(ev) {
  if (ev.subject_type === 'dog') return dogName(ev.subject_id);
  if (ev.subject_type === 'pairing') {
    const p = ctx.pairingsById.get(ev.subject_id);
    return p ? `${dogName(p.sire_id)} × ${dogName(p.dam_id)}` : '—';
  }
  const l = ctx.littersById.get(ev.subject_id);
  return l ? `Litter (${dogName(l.dam_id)} × ${dogName(l.sire_id)})` : '—';
}

function subjectHtml(ev) {
  if (ev.subject_type === 'dog') {
    const d = ctx.dogsById.get(ev.subject_id);
    return d ? dogRefHtml(d.id, d.call_name, d.is_archived) : '—';
  }
  const page = ev.subject_type === 'pairing' ? 'pairing' : 'litter';
  return `<a href="${page}.html?id=${encodeURIComponent(ev.subject_id)}">${esc(subjectText(ev))}</a>`;
}

function itemsFor(events, reminders) {
  const items = events.map((ev) => {
    const d = descriptor(EVENT_TYPES, ev.event_type);
    const [start, end] = eventSpan(ev, d.duration);
    return { kind: 'event', ev, start, end, open: d.duration === 'span' && !ev.event_end_date };
  });
  for (const ev of reminders) items.push({ kind: 'reminder', ev, start: ev.reminder_date, end: ev.reminder_date });
  return items;
}

function chipHtml(item) {
  const d = descriptor(EVENT_TYPES, item.ev.event_type);
  if (item.kind === 'reminder') {
    return `<span class="cal-chip cal-chip-reminder" title="Reminder: ${esc(item.ev.title)}">⏰ ${esc(item.ev.title)}</span>`;
  }
  return `<span class="badge cal-chip ${d.badge}" title="${esc(d.label)}: ${esc(item.ev.title)}">${esc(item.ev.title)}</span>`;
}

function cellHtml(date, today) {
  if (!date) return '<div class="cal-cell cal-blank"></div>';
  const items = byDay.get(date) || [];
  const cls = `cal-cell${date === today ? ' cal-today' : ''}${date < today ? ' cal-past' : ''}`;
  const num = `<span class="cal-date">${Number(date.slice(8))}</span>`;
  if (!items.length) return `<div class="${cls}">${num}</div>`;
  const more = items.length > MAX_CHIPS ? `<span class="cal-more">+${items.length - MAX_CHIPS}<span class="cal-more-word"> more</span></span>` : '';
  return `<button type="button" class="${cls}" data-day="${date}" aria-label="${esc(fmtDate(date))}: ${items.length} item${items.length === 1 ? '' : 's'}">
      ${num}<span class="cal-chips">${items.slice(0, MAX_CHIPS).map(chipHtml).join('')}${more}</span>
    </button>`;
}

function render() {
  const today = todayYMD();
  monthEl.textContent = new Date(`${month}-01T12:00:00Z`)
    .toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  mount.innerHTML = `<div class="cal-grid">
      ${weekdayHeads().map((h) => `<div class="cal-head">${esc(h)}</div>`).join('')}
      ${monthGridDates(month).map((date) => cellHtml(date, today)).join('')}
    </div>
    ${byDay.size ? '' : '<p class="muted" style="margin-top:12px;">Nothing logged or due this month.</p>'}`;

  // A key holding only the types actually on this month's grid.
  const present = new Map();
  let anyReminder = false;
  for (const list of byDay.values()) {
    for (const it of list) {
      if (it.kind === 'reminder') anyReminder = true;
      else present.set(it.ev.event_type, true);
    }
  }
  keyEl.innerHTML = [...present.keys()].map((t) => badge(EVENT_TYPES, t)).join(' ')
    + (anyReminder ? ' <span class="cal-chip cal-chip-reminder">⏰ Reminder</span>' : '');
}

function whenText(item) {
  if (item.kind === 'reminder') return `Reminder · ${fmtDate(item.start)}`;
  if (item.open) return `${fmtDate(item.start)} – ongoing`;
  if (item.end !== item.start) return `${fmtDate(item.start)} – ${fmtDate(item.end)}`;
  return fmtDate(item.start);
}

function googleUrlFor(item) {
  const ev = item.ev;
  const d = descriptor(EVENT_TYPES, ev.event_type);
  const subject = subjectText(ev);
  return googleCalendarUrl({
    title: `${item.kind === 'reminder' ? 'Reminder: ' : ''}${subject} — ${ev.title}`,
    start: item.start,
    end: item.end,
    details: `${d.label} · ${subject} (from KennelOS)`,
    location: ev.details?.location || ''
  });
}

function openDay(date) {
  const items = byDay.get(date) || [];
  const rows = items.map((item) => `
    <li class="cal-day-item">
      <div>${item.kind === 'reminder' ? '<span class="cal-chip cal-chip-reminder">⏰ Reminder</span>' : badge(EVENT_TYPES, item.ev.event_type)}
        <strong>${subjectHtml(item.ev)}</strong> — ${esc(item.ev.title)}</div>
      <div class="muted" style="font-size:13px;">${esc(whenText(item))}</div>
      <div><a href="${esc(googleUrlFor(item))}" target="_blank" rel="noopener noreferrer">Add to Google Calendar ↗</a></div>
    </li>`).join('');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <h2 style="margin-top:0;">${esc(fmtDate(date))}</h2>
      <ul class="cal-day-list">${rows}</ul>
      <div class="form-actions"><button class="btn" id="cal-close">Close</button></div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  overlay.querySelector('#cal-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  overlay.querySelector('#cal-close').focus();
}

async function load() {
  errorBox.innerHTML = '';
  try {
    const first = `${month}-01`;
    const last = monthGridDates(month).filter(Boolean).pop();
    const [events, reminders] = await Promise.all([eventRepo.getInRange(first, last), eventRepo.getReminders()]);
    const maps = { dog: ctx.dogsById, pairing: ctx.pairingsById, litter: ctx.littersById };
    const inScope = (ev) => subjectInScope(ev.subject_type, ev.subject_id, maps);
    byDay = bucketByDay(itemsFor(events.filter(inScope), reminders.filter(inScope)), month);
    render();
  } catch (err) {
    errorBox.innerHTML = `<div class="inline-error">${esc(err.message || String(err))}</div>`;
  }
}

function go(next) {
  month = next;
  const url = new URL(location.href);
  url.searchParams.set('m', month);
  history.replaceState(null, '', url);
  load();
}

async function init() {
  const [dogs, pairings, litters] = await Promise.all([
    dogRepo.getAll({ includeArchived: true }),
    pairingRepo.getAll({ includeArchived: true }),
    litterRepo.getAll({ includeArchived: true })
  ]);
  ctx.dogsById = new Map(dogs.map((d) => [d.id, d]));
  ctx.pairingsById = new Map(pairings.map((p) => [p.id, p]));
  ctx.littersById = new Map(litters.map((l) => [l.id, l]));

  document.getElementById('cal-prev').addEventListener('click', () => go(shiftMonth(month, -1)));
  document.getElementById('cal-next').addEventListener('click', () => go(shiftMonth(month, 1)));
  document.getElementById('cal-today').addEventListener('click', () => go(monthOf(todayYMD())));
  mount.addEventListener('click', (e) => {
    const cell = e.target.closest('[data-day]');
    if (cell) openDay(cell.dataset.day);
  });
  await load();
}

init().catch((err) => {
  errorBox.innerHTML = `<div class="inline-error">${esc(err.message || String(err))}</div>`;
});
