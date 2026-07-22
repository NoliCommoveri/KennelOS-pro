// reminders.js — the Reminder view (Stage 5, Build Brief §3.5). Renders
// eventRepo.getReminders() bucketed into overdue / due-soon / upcoming, soonest
// first, with inline dismiss and snooze. The bucketing is a DISPLAY concern
// computed here from the returned rows (§3.3) — the repo read just returns every
// pending reminder. A "show dismissed" toggle swaps in the dismissed list, each
// restorable. reminder_date is the app's one future-dated mechanism: there's no
// Reminder table and no recurrence engine — recurrence is the log-the-next
// workflow on the event itself (§3.4), not modeled here.
import { eventRepo } from '../data/eventRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { pairingRepo } from '../data/pairingRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { EVENT_TYPES, descriptor } from '../data/vocab.js';
import { esc, badge, fmtDate } from '../assets/ui.js';
import { todayYMD, daysFromToday } from '../data/dateUtils.js';

// The due-soon window (§3.3) — a UI constant, not schema. reminders at or before
// today + DUE_SOON_DAYS (and not overdue) are "due soon"; beyond it, "upcoming".
const DUE_SOON_DAYS = 30;

const body = document.getElementById('reminders-body');
const errorBox = document.getElementById('page-error');
let showDismissed = false;

const ctx = { dogsById: new Map(), pairingsById: new Map(), littersById: new Map(), contactsById: new Map() };

function showError(msg) { errorBox.innerHTML = `<div class="inline-error">${esc(msg)}</div>`; }

function subjectLabel(ev) {
  if (ev.subject_type === 'dog') return ctx.dogsById.get(ev.subject_id)?.call_name || '—';
  if (ev.subject_type === 'pairing') {
    const p = ctx.pairingsById.get(ev.subject_id);
    if (!p) return '—';
    return `${ctx.dogsById.get(p.sire_id)?.call_name || '—'} × ${ctx.dogsById.get(p.dam_id)?.call_name || '—'}`;
  }
  const l = ctx.littersById.get(ev.subject_id);
  if (!l) return '—';
  return `Litter (${ctx.dogsById.get(l.dam_id)?.call_name || '—'} × ${ctx.dogsById.get(l.sire_id)?.call_name || '—'})`;
}

function subjectHref(ev) {
  if (ev.subject_type === 'dog') return `dog.html?id=${encodeURIComponent(ev.subject_id)}`;
  if (ev.subject_type === 'pairing') return `pairing.html?id=${encodeURIComponent(ev.subject_id)}`;
  return `litter.html?id=${encodeURIComponent(ev.subject_id)}`;
}

// One reminder row. `dismissed` swaps the actions to a single Restore.
function rowHtml(ev, bucketBadge, dismissed) {
  const contact = ev.related_contact_id ? ctx.contactsById.get(ev.related_contact_id)?.name : '';
  const actions = dismissed
    ? `<button class="btn btn-sm" data-act="restore" data-id="${esc(ev.id)}">Restore</button>`
    : `<button class="btn btn-sm" data-act="snooze" data-id="${esc(ev.id)}">Snooze</button>
       <button class="btn btn-sm" data-act="dismiss" data-id="${esc(ev.id)}">Dismiss</button>`;
  return `<li class="row-between${dismissed ? ' row-archived' : ''}" style="padding:10px 0; border-top:1px solid var(--border); align-items:flex-start;">
      <div>
        <div>${bucketBadge}<a href="${subjectHref(ev)}"><strong>${esc(subjectLabel(ev))}</strong></a> — ${badge(EVENT_TYPES, ev.event_type)} ${esc(ev.title)}</div>
        <div class="muted" style="font-size:13px;">⏰ ${esc(fmtDate(ev.reminder_date))}${contact ? ` · ${esc(contact)}` : ''}</div>
      </div>
      <div class="pill-row" data-row="${esc(ev.id)}">${actions}</div>
    </li>`;
}

function bucketSection(title, hint, rows, bucketBadge) {
  if (!rows.length) return '';
  return `<section class="card" style="margin-top:16px;">
      <div class="row-between"><h2 style="margin:0;">${esc(title)} <span class="muted" style="font-size:14px;">(${rows.length})</span></h2></div>
      ${hint ? `<p class="field-hint">${esc(hint)}</p>` : ''}
      <ul class="linked-list" style="margin:6px 0 0; padding:0; list-style:none;">
        ${rows.map((ev) => rowHtml(ev, bucketBadge, false)).join('')}
      </ul>
    </section>`;
}

async function refresh() {
  errorBox.innerHTML = '';
  if (showDismissed) {
    const rows = await eventRepo.getDismissedReminders();
    body.innerHTML = rows.length
      ? `<section class="card">
          <div class="row-between"><h2 style="margin:0;">Dismissed <span class="muted" style="font-size:14px;">(${rows.length})</span></h2></div>
          <p class="field-hint">Handled reminders. The events stay on their timelines — restoring brings the reminder back to the pending buckets.</p>
          <ul class="linked-list" style="margin:6px 0 0; padding:0; list-style:none;">
            ${rows.map((ev) => rowHtml(ev, '', true)).join('')}
          </ul>
        </section>`
      : `<div class="card empty-state">No dismissed reminders.</div>`;
    wireActions();
    return;
  }

  const reminders = await eventRepo.getReminders();
  if (!reminders.length) {
    body.innerHTML = `<div class="card empty-state">No pending reminders. Add a reminder date to any event to see it here.</div>`;
    return;
  }

  const today = todayYMD();
  const horizon = daysFromToday(DUE_SOON_DAYS);
  const overdue = reminders.filter((e) => e.reminder_date < today);
  const dueSoon = reminders.filter((e) => e.reminder_date >= today && e.reminder_date <= horizon);
  const upcoming = reminders.filter((e) => e.reminder_date > horizon);

  body.innerHTML =
    bucketSection('Overdue', 'Past their reminder date and still pending.', overdue, '<span class="badge badge-red">Overdue</span> ') +
    bucketSection('Due soon', `Within the next ${DUE_SOON_DAYS} days.`, dueSoon, '<span class="badge badge-amber">Due soon</span> ') +
    bucketSection('Upcoming', 'Further out.', upcoming, '<span class="badge badge-blue">Upcoming</span> ');
  wireActions();
}

function wireActions() {
  body.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => onAction(btn.dataset.act, btn.dataset.id));
  });
}

async function onAction(act, id) {
  try {
    if (act === 'dismiss') { await eventRepo.dismissReminder(id); refresh(); }
    else if (act === 'restore') { await eventRepo.undismissReminder(id); refresh(); }
    else if (act === 'snooze') { openSnooze(id); }
  } catch (e) { showError(e.message || String(e)); }
}

// Inline snooze: swap the row's actions for a date picker (defaulted a week out,
// never before today) + Set/Cancel. Snoozing IS a reminder_date edit (§3.4) —
// there is no separate snooze field.
function openSnooze(id) {
  const holder = body.querySelector(`[data-row="${CSS.escape(id)}"]`);
  if (!holder) return;
  const suggested = daysFromToday(7);
  holder.innerHTML = `
    <input type="date" class="snooze-date" min="${todayYMD()}" value="${suggested}" style="max-width:160px;">
    <button class="btn btn-primary btn-sm" data-set="${esc(id)}">Set</button>
    <button class="btn btn-sm" data-cancel>Cancel</button>`;
  holder.querySelector('[data-cancel]').addEventListener('click', refresh);
  holder.querySelector('[data-set]').addEventListener('click', async () => {
    const val = holder.querySelector('.snooze-date').value;
    if (!val) return;
    try { await eventRepo.snoozeReminder(id, val); refresh(); }
    catch (e) { showError(e.message || String(e)); }
  });
}

async function main() {
  const [dogs, pairings, litters, contacts] = await Promise.all([
    dogRepo.getAll({ includeArchived: true }),
    pairingRepo.getAll({ includeArchived: true }),
    litterRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true })
  ]);
  ctx.dogsById = new Map(dogs.map((d) => [d.id, d]));
  ctx.pairingsById = new Map(pairings.map((p) => [p.id, p]));
  ctx.littersById = new Map(litters.map((l) => [l.id, l]));
  ctx.contactsById = new Map(contacts.map((c) => [c.id, c]));

  document.getElementById('show-dismissed').addEventListener('change', (e) => {
    showDismissed = e.target.checked;
    refresh();
  });
  refresh();
}

main();
