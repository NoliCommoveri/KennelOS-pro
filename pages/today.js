// today.js — the consolidated "Today" home (Navigation Consolidation Plan v1 §4).
// Action-first ordering, top → bottom: (1) reminders, (2) active litters,
// (3) due-outs / upcoming, (4) who's away, (5) the slow-changing kennel
// overview. This page is the single home for what used to be four separate
// nav destinations (dashboard, reminders, upcoming, board), so it shows their
// real content — not teaser counts.
//
// Every read here is DERIVED over the existing repos, exactly as the dashboard/
// reminders/upcoming/board pages each do — no stored aggregates, no new schema.
//
// Every card is collapsible (cardShell in assets/ui.js): a chevron button in
// the header toggles its body, and a card with no rows to show starts
// collapsed (isEmpty) instead of an expanded empty-state message.
import { eventRepo } from '../data/eventRepo.js';
import { getAwayBoardRows } from '../data/awayBoard.js';
import { computeNudges } from '../data/nudges.js';
import { isDismissed, dismiss } from '../data/nudgeState.js';
import { dogRepo } from '../data/dogRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { pairingRepo } from '../data/pairingRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { EVENT_TYPES, DOG_STATUS, DISPOSITION } from '../data/vocab.js';
import { esc, badge, fmtDate, cardShell } from '../assets/ui.js';
import { renderUpgradeNudge } from '../assets/upgradeNudge.js';
import { hasEditionLinks, editionLinksHtml, wireEditionLinks } from '../assets/editionLinks.js';
import { CapExceededError } from '../data/repoBase.js';
import { todayYMD, daysFromToday } from '../data/dateUtils.js';

const DUE_SOON_DAYS = 30; // shared window with the reminder buckets (§3.3)

const errorBox = document.getElementById('page-error');
const remindersEl = document.getElementById('today-reminders');
const upcomingEl = document.getElementById('today-upcoming');
const boardEl = document.getElementById('today-board');
const availableEl = document.getElementById('today-available');
const nudgesEl = document.getElementById('today-nudges');
const overviewEl = document.getElementById('today-overview');
const editionsEl = document.getElementById('today-editions');

// Subject-resolution context, loaded once. Shared by every section.
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

// `extra` appends a raw query-string fragment (e.g. "&openEvent=<id>") so
// callers can deep-link straight to an event on the subject's own page —
// there is no standalone event page, since Event is polymorphic (CLAUDE.md).
function subjectHref(ev, extra = '') {
  if (ev.subject_type === 'dog') return `dog.html?id=${encodeURIComponent(ev.subject_id)}${extra}`;
  if (ev.subject_type === 'pairing') return `pairing.html?id=${encodeURIComponent(ev.subject_id)}${extra}`;
  return `litter.html?id=${encodeURIComponent(ev.subject_id)}${extra}`;
}

// --- 1. Reminders (interactive; re-renders in place on dismiss/snooze) ------

function reminderRow(ev, bucketBadge) {
  const contact = ev.related_contact_id ? ctx.contactsById.get(ev.related_contact_id)?.name : '';
  // A reminder is nudging toward logging the NEXT occurrence, not editing the
  // one that fired it — so this deep-links to a fresh event of the same
  // event_type on the subject's page, prefilled like the app's other
  // soft-suggestion prompts (eventForm.js `prefill`).
  const logHref = subjectHref(ev, `&logEvent=${encodeURIComponent(ev.event_type)}`);
  return `<li style="padding:10px 0; border-top:1px solid var(--border);">
      <div>${bucketBadge}<a href="${subjectHref(ev)}"><strong>${esc(subjectLabel(ev))}</strong></a> — ${badge(EVENT_TYPES, ev.event_type)} ${esc(ev.title)}</div>
      <div class="muted" style="font-size:13px;">⏰ ${esc(fmtDate(ev.reminder_date))}${contact ? ` · ${esc(contact)}` : ''}</div>
      <div class="pill-row" data-row="${esc(ev.id)}" style="margin-top:8px;">
        <a class="btn btn-sm" href="${esc(logHref)}">Log new →</a>
        <button class="btn btn-sm" data-act="snooze" data-id="${esc(ev.id)}">Snooze</button>
        <button class="btn btn-sm" data-act="dismiss" data-id="${esc(ev.id)}">Dismiss</button>
      </div>
    </li>`;
}

function reminderBucket(title, rows, bucketBadge) {
  if (!rows.length) return '';
  return `<h3 style="margin:14px 0 0;">${esc(title)} <span class="muted" style="font-size:13px;">(${rows.length})</span></h3>
    <ul class="linked-list" style="margin:2px 0 0; padding:0; list-style:none;">
      ${rows.map((ev) => reminderRow(ev, bucketBadge)).join('')}
    </ul>`;
}

async function renderReminders() {
  const reminders = await eventRepo.getReminders();
  const isEmpty = !reminders.length;
  const title = `Reminders${reminders.length ? ` <span class="muted" style="font-size:14px;">(${reminders.length})</span>` : ''}`;
  let body;
  if (isEmpty) {
    body = `<div class="empty-state">Nothing pending. Add a reminder date to any event to see it here.</div>`;
  } else {
    const today = todayYMD();
    const horizon = daysFromToday(DUE_SOON_DAYS);
    const overdue = reminders.filter((e) => e.reminder_date < today);
    const dueSoon = reminders.filter((e) => e.reminder_date >= today && e.reminder_date <= horizon);
    const upcoming = reminders.filter((e) => e.reminder_date > horizon);
    body = reminderBucket('Overdue', overdue, '<span class="badge badge-red">Overdue</span> ')
      + reminderBucket('Due soon', dueSoon, '<span class="badge badge-amber">Due soon</span> ')
      + reminderBucket('Upcoming', upcoming, '<span class="badge badge-blue">Upcoming</span> ');
  }
  remindersEl.innerHTML = cardShell(title, body, { key: 'reminders', isEmpty });
  wireReminderActions();
}

function wireReminderActions() {
  remindersEl.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => onReminderAction(btn.dataset.act, btn.dataset.id));
  });
}

async function onReminderAction(act, id) {
  try {
    if (act === 'dismiss') { await eventRepo.dismissReminder(id); renderReminders(); }
    else if (act === 'snooze') openSnooze(id);
  } catch (e) { showError(e.message || String(e)); }
}

// Inline snooze: swap the row's actions for a date picker (a week out, never before
// today). Snoozing IS a reminder_date edit — there is no separate snooze field.
function openSnooze(id) {
  const holder = remindersEl.querySelector(`[data-row="${CSS.escape(id)}"]`);
  if (!holder) return;
  holder.innerHTML = `
    <input type="date" class="snooze-date" min="${todayYMD()}" value="${daysFromToday(7)}" style="max-width:160px;">
    <button class="btn btn-primary btn-sm" data-set>Set</button>
    <button class="btn btn-sm" data-cancel>Cancel</button>`;
  holder.querySelector('[data-cancel]').addEventListener('click', renderReminders);
  holder.querySelector('[data-set]').addEventListener('click', async () => {
    const val = holder.querySelector('.snooze-date').value;
    if (!val) return;
    try { await eventRepo.snoozeReminder(id, val); renderReminders(); }
    catch (e) { showError(e.message || String(e)); }
  });
}

// --- 0. Nudges (derived, dismissible — Data Integrity Brief §2) -------------

async function renderNudges() {
  const all = await computeNudges();
  const rows = all.filter((n) => !isDismissed(n.key));
  if (!rows.length) { nudgesEl.innerHTML = ''; return; }
  const title = `Nudges <span class="muted" style="font-size:14px;">(${rows.length})</span>`;
  const body = `<p class="field-hint">Suggestions computed from your data — nothing here changes a record until you act on it.</p>
      <ul class="linked-list" style="margin:6px 0 0; padding:0; list-style:none;">
        ${rows.map((n) => `
          <li class="row-between" style="padding:10px 0; border-top:1px solid var(--border); align-items:flex-start;">
            <div>
              <div><a href="${esc(n.subjectHref)}"><strong>${esc(n.title)}</strong></a></div>
              ${n.detail ? `<div class="muted" style="font-size:13px;">${esc(n.detail)}</div>` : ''}
            </div>
            <div class="pill-row" data-nudge="${esc(n.key)}">
              ${n.actions.map((a, i) => `<button class="btn btn-sm" data-nudge-action="${i}">${esc(a.label)}</button>`).join('')}
              <button class="btn btn-sm" data-nudge-dismiss>Dismiss</button>
            </div>
          </li>`).join('')}
      </ul>`;
  nudgesEl.innerHTML = cardShell(title, body, { key: 'nudges', isEmpty: false });

  nudgesEl.querySelectorAll('[data-nudge]').forEach((holder) => {
    const key = holder.dataset.nudge;
    const nudge = rows.find((n) => n.key === key);
    holder.querySelectorAll('[data-nudge-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await nudge.actions[Number(btn.dataset.nudgeAction)].run(); renderNudges(); }
        catch (e) {
          // The promote-lifecycle nudge matures a pup (a ✗→✓ dog transition); in
          // Lite that can hit the cap and throw CapExceededError — show the
          // upgrade nudge rather than a raw error (cap spec §6).
          if (e instanceof CapExceededError) renderUpgradeNudge(errorBox, e, 'mature');
          else showError(e.message || String(e));
        }
      });
    });
    const dismissBtn = holder.querySelector('[data-nudge-dismiss]');
    dismissBtn.addEventListener('click', () => { dismiss(key); renderNudges(); });
  });
}

// --- 2. Due outs / Upcoming -------------------------------------------------

function renderUpcoming(rows) {
  const isEmpty = !rows.length;
  const inner = rows.length
    ? `<ul class="linked-list" style="margin:6px 0 0; padding:0; list-style:none;">
        ${rows.map((ev) => {
          const contact = ev.related_contact_id ? ctx.contactsById.get(ev.related_contact_id)?.name : '';
          // A due-out is THIS event, not a next one — deep-links to open it
          // directly (edit mode) on the subject's page.
          const openHref = subjectHref(ev, `&openEvent=${encodeURIComponent(ev.id)}`);
          return `<li class="row-between" style="padding:9px 0; border-top:1px solid var(--border);">
            <div style="min-width:0;"><a href="${subjectHref(ev)}"><strong>${esc(subjectLabel(ev))}</strong></a> — ${badge(EVENT_TYPES, ev.event_type)} ${esc(ev.title || '')}${contact ? ` <span class="muted">· ${esc(contact)}</span>` : ''}</div>
            <div class="pill-row" style="align-items:center; justify-content:flex-end; flex:0 0 auto;">
              <span class="muted" style="font-size:13px; white-space:nowrap;">${esc(fmtDate(ev.event_date))}</span>
              <a class="btn btn-sm" href="${esc(openHref)}">Open →</a>
            </div>
          </li>`;
        }).join('')}
      </ul>`
    : `<div class="empty-state">Nothing scheduled from today onward.</div>`;
  const title = `Due outs &amp; upcoming${rows.length ? ` <span class="muted" style="font-size:14px;">(${rows.length})</span>` : ''}`;
  const body = `<p class="field-hint">Everything scheduled from today onward — drop-offs, vet visits, surgeries.</p>${inner}`;
  upcomingEl.innerHTML = cardShell(title, body, { key: 'upcoming', isEmpty, marginTop: true });
}

// --- 3. Who's away (Location / Status Board) --------------------------------

// Expandable-row table (phone-first): Dog · Reason · Location stay in the row;
// Contact / Drop-off / Return collapse into a panel a tap opens. Each away-dog is
// a summary <tr> plus a hidden panel <tr>; clicking the summary toggles both.
function renderBoard(rows) {
  if (!rows.length) {
    boardEl.innerHTML = cardShell('Away from home', `<div class="empty-state">No dogs are currently away.</div>`, { key: 'board', isEmpty: true, marginTop: true });
    return;
  }
  const today = todayYMD();
  const body = rows.map((row, i) => {
    const dog = ctx.dogsById.get(row.dogId);
    const contact = row.contactId ? ctx.contactsById.get(row.contactId) : null;
    const ret = row.returnDate
      ? `${esc(fmtDate(row.returnDate))}${row.returnDate < today ? ' <span class="badge badge-amber">Overdue?</span>' : ''}`
      : '<span class="badge badge-blue">Ongoing</span>';
    const drop = `${esc(fmtDate(row.outDate))}${row.dropoffTime ? ` <span class="faint">${esc(row.dropoffTime)}</span>` : ''}`;
    return `<tbody class="expand-group">
      <tr class="expand-summary" data-panel="board-${i}">
        <td><strong>${esc(dog ? dog.call_name : '—')}</strong></td>
        <td>${esc(row.reason || '—')}</td>
        <td>${esc(row.location || '—')}</td>
        <td style="text-align:right; width:1em;"><span class="expand-chevron">▸</span></td>
      </tr>
      <tr class="expand-panel" id="board-${i}" hidden>
        <td colspan="4">
          <div class="expand-detail">
            <div class="k">Contact</div><div class="v">${contact ? esc(contact.name) : '—'}</div>
            <div class="k">Drop-off</div><div class="v">${drop}</div>
            <div class="k">Return</div><div class="v">${ret}</div>
            <div class="expand-actions"><a class="btn btn-sm" href="${esc(row.href)}">Open →</a></div>
          </div>
        </td>
      </tr>
    </tbody>`;
  }).join('');
  const title = `Away from home <span class="muted" style="font-size:14px;">(${rows.length})</span>`;
  const cardBody = `<p class="field-hint">Boarding stays and in-person stud services — medications and heat cycles don't appear here. Tap a row for contact, drop-off, and return.</p>
      <table class="data expand-table">
        <thead><tr><th>Dog</th><th>Reason</th><th>Location</th><th></th></tr></thead>
        ${body}
      </table>`;
  boardEl.innerHTML = cardShell(title, cardBody, { key: 'board', isEmpty: false, marginTop: true });
  boardEl.querySelectorAll('.expand-summary').forEach((tr) => {
    tr.addEventListener('click', () => {
      const panel = document.getElementById(tr.dataset.panel);
      if (!panel) return;
      const open = panel.hidden;
      panel.hidden = !open;
      tr.classList.toggle('open', open); // CSS rotates the ▸ chevron to point down
    });
  });
}

// --- Active litters (per-litter availability) -------------------------------
// Replaces the flat available-puppies feed: one block per NON-archived litter
// that still has at least one 'available' puppy, each showing that litter's
// selling roster grouped available → undecided → sold. The "selling roster" is
// the litter's non-archived pups whose disposition is one of available/
// undecided/placed ('keeping' pups and pups that have moved past the puppy
// life-stage — disposition nulled — are excluded). "Sold" = disposition
// 'placed' (the value sale.js sets when a sale is recorded); the per-litter
// tally reads "<placed>/<roster> sold". Add-sale buttons appear on the still-
// sellable pups (available/undecided), exactly as the old feed's did. Disposition
// is the breeder's placement intent, distinct from DOG_STATUS 'for_sale' (the
// life-stage badge).
const SELLING_DISPOSITIONS = new Set(['available', 'undecided', 'placed']);
// Display order within a litter: available first, undecided next, sold last.
const DISPOSITION_ORDER = { available: 0, undecided: 1, placed: 2 };

function litterLabel(l) {
  const dam = ctx.dogsById.get(l.dam_id)?.call_name || '—';
  const sire = ctx.dogsById.get(l.sire_id)?.call_name || '—';
  return `${dam} × ${sire}`;
}

// One puppy row: name + its disposition badge on the left, an "Add sale →"
// action pinned right for sellable pups (available/undecided). Sold pups carry
// no action — their "Placed" badge already says so.
function pupRow(d) {
  const sellable = d.disposition !== 'placed';
  const action = sellable
    ? `<div class="pill-row"><a class="btn btn-sm" href="sale.html?new=1&dog=${encodeURIComponent(d.id)}">Add sale →</a></div>`
    : '';
  return `<li class="row-between" style="padding:8px 0 0;">
      <span style="min-width:0;"><a href="dog.html?id=${encodeURIComponent(d.id)}"><strong>${esc(d.call_name)}</strong></a> ${badge(DISPOSITION, d.disposition)}</span>
      ${action}
    </li>`;
}

function renderAvailable(dogs, litters) {
  // Group each litter's non-archived selling pups by litter_id.
  const pupsByLitter = new Map();
  for (const d of dogs) {
    if (d.is_archived || !d.litter_id || !SELLING_DISPOSITIONS.has(d.disposition)) continue;
    if (!pupsByLitter.has(d.litter_id)) pupsByLitter.set(d.litter_id, []);
    pupsByLitter.get(d.litter_id).push(d);
  }
  // Active litter = non-archived litter with ≥1 'available' pup. Newest first.
  const active = litters
    .filter((l) => !l.is_archived)
    .map((l) => ({ litter: l, pups: pupsByLitter.get(l.id) || [] }))
    .filter((x) => x.pups.some((p) => p.disposition === 'available'))
    .sort((a, b) => String(b.litter.whelp_date || '').localeCompare(String(a.litter.whelp_date || '')));

  const isEmpty = !active.length;
  const inner = active.length
    ? active.map(({ litter, pups }, i) => {
        const sold = pups.filter((p) => p.disposition === 'placed').length;
        const ordered = [...pups].sort((a, b) =>
          (DISPOSITION_ORDER[a.disposition] - DISPOSITION_ORDER[b.disposition])
          || a.call_name.localeCompare(b.call_name));
        // A rule between litters (skipped before the first) is the visual break.
        const sep = i ? ' style="margin-top:16px; padding-top:16px; border-top:1px solid var(--border);"' : '';
        return `<div${sep}>
          <div class="row-between">
            <a href="litter.html?id=${encodeURIComponent(litter.id)}"><strong>${esc(litterLabel(litter))}</strong></a>
            <span class="muted" style="white-space:nowrap;">${sold}/${pups.length} sold</span>
          </div>
          <ul class="linked-list" style="margin:2px 0 0; padding:0; list-style:none;">
            ${ordered.map(pupRow).join('')}
          </ul>
        </div>`;
      }).join('')
    : `<div class="empty-state">No litters with available puppies.</div>`;
  const title = `Active litters${active.length ? ` <span class="muted" style="font-size:14px;">(${active.length})</span>` : ''}`;
  availableEl.innerHTML = cardShell(title, inner, { key: 'active-litters', isEmpty, marginTop: true });
}

// --- 4. Kennel overview (slow-changing; sits last) --------------------------

function stat(num, label, href) {
  const cls = ['stat', num === 0 ? 'stat-zero' : ''].filter(Boolean).join(' ');
  const inner = `<div class="stat-num">${esc(num)}</div><div class="stat-label">${esc(label)}</div>`;
  return href ? `<a class="${cls}" href="${href}">${inner}</a>` : `<div class="${cls}">${inner}</div>`;
}

function renderOverview({ allDogs, litters, pairings, sales }) {
  const activeDogs = allDogs.filter((d) => !d.is_archived);
  const archivedCount = allDogs.length - activeDogs.length;
  const byStatus = new Map();
  for (const d of activeDogs) byStatus.set(d.status, (byStatus.get(d.status) || 0) + 1);
  const statusTiles = DOG_STATUS
    .filter((s) => (byStatus.get(s.value) || 0) > 0 || ['active_breeding', 'retired_breeding', 'puppy', 'pet_home', 'deceased'].includes(s.value))
    .map((s) => stat(byStatus.get(s.value) || 0, s.label, 'dogs.html'))
    .join('') + stat(archivedCount, 'Archived (any status)', 'dogs.html');

  const year = String(new Date().getFullYear());
  const inYear = (ymd) => (ymd || '').startsWith(year);
  const yearLitters = litters.filter((l) => inYear(l.whelp_date)).length;
  const yearPairings = pairings.filter((p) => inYear(p.planned_date)).length;
  const yearSales = sales.filter((s) => inYear(s.sale_date)).length;

  overviewEl.innerHTML =
    cardShell('Kennel overview',
      `<p class="field-hint">Active dogs by status. Rarely changes, so it sits at the bottom.</p><div class="stat-grid">${statusTiles}</div>`,
      { key: 'overview', isEmpty: allDogs.length === 0, marginTop: true })
    + cardShell(`This year (${year})`,
      `<div class="stat-grid">
        ${stat(yearLitters, 'Litters whelped', 'breeding.html')}
        ${stat(yearPairings, 'Pairings', 'breeding.html')}
        ${stat(yearSales, 'Sales', 'sales.html')}
      </div>`,
      { key: 'this-year', isEmpty: yearLitters === 0 && yearPairings === 0 && yearSales === 0, marginTop: true });
}

// --- Edition footer (Lite only) --------------------------------------------
// The "See the full app ↗" / "Upgrade to Pro →" links (editions plan §"In-Lite
// links to Demo and Pro"). Edition-static, so it's rendered once up front and
// never touches the loaded data. No-op in Pro/Demo (hasEditionLinks() false).
function renderEditionFooter() {
  if (!editionsEl || !hasEditionLinks()) return;
  editionsEl.innerHTML = editionLinksHtml({ variant: 'footer' });
  wireEditionLinks(editionsEl);
}

async function main() {
  renderEditionFooter();

  const [allDogs, litters, pairings, sales, contacts, upcoming, boardRows] = await Promise.all([
    dogRepo.getAll({ includeArchived: true }),
    litterRepo.getAll({ includeArchived: false }),
    pairingRepo.getAll({ includeArchived: false }),
    saleRepo.getAll({ includeArchived: false }),
    contactRepo.getAll({ includeArchived: true }),
    eventRepo.getUpcoming(),
    getAwayBoardRows()
  ]);
  ctx.dogsById = new Map(allDogs.map((d) => [d.id, d]));
  ctx.pairingsById = new Map(pairings.map((p) => [p.id, p]));
  ctx.littersById = new Map(litters.map((l) => [l.id, l]));
  ctx.contactsById = new Map(contacts.map((c) => [c.id, c]));

  // Nudges and reminders each do their own async read; they're independent, so
  // run them concurrently rather than one-then-the-other (halves the critical
  // path for the two top cards). The remaining sections render synchronously
  // from the data main() already loaded.
  const asyncCards = Promise.all([renderNudges(), renderReminders()]);
  renderAvailable(allDogs, litters);
  renderUpcoming(upcoming);
  renderBoard(boardRows);
  renderOverview({ allDogs, litters, pairings, sales });
  await asyncCards;
}

main().catch((e) => showError(e.message || String(e)));
