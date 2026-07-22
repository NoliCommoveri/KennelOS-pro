// dashboard.js — the Stage 5 dashboard (Build Brief §4). Pure DERIVED reads over
// the existing repos, computed on load: no denormalized counters, no cached
// summaries, no stored aggregates (that would break the derived-not-stored and
// one-canonical-direction invariants — §4.1). If a count were ever slow it would
// be memoized in-page for the session, never in the schema.
//
// Archive ≠ status (§4.2): the "Dogs by status" tiles count NON-ARCHIVED dogs
// per status (status-based, active-list read); "Archived" is a separate tile on
// the archive flag; "deceased" is one of the status tiles and is NEVER conflated
// with archived. Every tile states which question it answers.
import { dogRepo } from '../data/dogRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { pairingRepo } from '../data/pairingRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { eventRepo } from '../data/eventRepo.js';
import { editionFlags } from '../data/editionConfig.js';
import { getAwayBoardRows } from '../data/awayBoard.js';
import { DOG_STATUS } from '../data/vocab.js';
import { esc } from '../assets/ui.js';
import { todayYMD, daysFromToday } from '../data/dateUtils.js';

const DUE_SOON_DAYS = 30; // matches the reminder view's window (§3.3)
const body = document.getElementById('dashboard-body');

// A stat tile. `href` makes it a navigable link; `tone` ('alert'|'warn'|'zero')
// colors the number. A zero count always renders muted regardless of tone.
function stat(num, label, { href = null, tone = null } = {}) {
  const cls = ['stat', num === 0 ? 'stat-zero' : (tone ? `stat-${tone}` : '')].filter(Boolean).join(' ');
  const inner = `<div class="stat-num">${esc(num)}</div><div class="stat-label">${esc(label)}</div>`;
  return href ? `<a class="${cls}" href="${href}">${inner}</a>` : `<div class="${cls}">${inner}</div>`;
}

function card(title, tilesHtml, subtitle) {
  return `<section class="card" style="margin-top:16px;">
      <h2 style="margin:0;">${esc(title)}</h2>
      ${subtitle ? `<p class="field-hint">${esc(subtitle)}</p>` : ''}
      <div class="stat-grid">${tilesHtml}</div>
    </section>`;
}

async function main() {
  const [allDogs, litters, pairings, sales, contacts, reminders, upcoming, boardRows] = await Promise.all([
    dogRepo.getAll({ includeArchived: true }),
    litterRepo.getAll({ includeArchived: false }),
    pairingRepo.getAll({ includeArchived: false }),
    saleRepo.getAll({ includeArchived: false }),
    contactRepo.getAll({ includeArchived: false }),
    eventRepo.getReminders(),
    eventRepo.getUpcoming(),
    getAwayBoardRows()
  ]);

  // Dogs: split archived (archive flag) from active (non-archived), then count
  // the active set by status. Deceased stays a status here, distinct from archived.
  const activeDogs = allDogs.filter((d) => !d.is_archived);
  const archivedCount = allDogs.length - activeDogs.length;
  const byStatus = new Map();
  for (const d of activeDogs) byStatus.set(d.status, (byStatus.get(d.status) || 0) + 1);
  const statusTiles = DOG_STATUS
    .filter((s) => (byStatus.get(s.value) || 0) > 0 || ['active_breeding', 'retired_breeding', 'puppy', 'pet_home', 'deceased'].includes(s.value))
    .map((s) => stat(byStatus.get(s.value) || 0, s.label, { href: 'dogs.html' }))
    .join('') + (editionFlags.includeArchivedToggles ? stat(archivedCount, 'Archived (any status)', { href: 'dogs.html', tone: 'zero' }) : '');

  // This year: date-filtered tallies over non-archived records (whelp/planned/sale
  // dates are YYYY-MM-DD, compared by year prefix).
  const year = String(new Date().getFullYear());
  const inYear = (ymd) => (ymd || '').startsWith(year);
  const littersThisYear = litters.filter((l) => inYear(l.whelp_date)).length;
  const pairingsThisYear = pairings.filter((p) => inYear(p.planned_date)).length;
  const salesThisYear = sales.filter((s) => inYear(s.sale_date)).length;

  // Reminders: bucket the pending set the same way the reminder view does.
  const today = todayYMD();
  const horizon = daysFromToday(DUE_SOON_DAYS);
  const overdue = reminders.filter((e) => e.reminder_date < today).length;
  const dueSoon = reminders.filter((e) => e.reminder_date >= today && e.reminder_date <= horizon).length;

  const upcomingPlacements = upcoming.filter((e) => e.event_type === 'placement').length;
  const awayCount = boardRows.length;
  const waitlistActive = contacts.filter((c) => c.waitlist_status === 'active').length;

  body.innerHTML =
    card('Dogs by status', statusTiles, 'Active (non-archived) dogs grouped by status. Archived is a separate flag, never mixed in with a status.') +
    card(`This year (${year})`, [
      stat(littersThisYear, 'Litters whelped', { href: 'litters.html' }),
      stat(pairingsThisYear, 'Pairings', { href: 'pairings.html' }),
      stat(salesThisYear, 'Sales', { href: 'sales.html' })
    ].join(''), 'Records dated in the current calendar year (excludes archived).') +
    card('Needs attention', [
      stat(overdue, 'Overdue reminders', { href: 'reminders.html', tone: 'alert' }),
      stat(dueSoon, `Due within ${DUE_SOON_DAYS} days`, { href: 'reminders.html', tone: 'warn' }),
      stat(upcomingPlacements, 'Upcoming placements', { href: 'scheduled-placements.html' }),
      stat(awayCount, 'Dogs away (boarding)', { href: 'board.html' }),
      editionFlags.contactsSection ? stat(waitlistActive, 'Active waitlist', { href: 'contacts.html?group=clients' }) : ''
    ].join(''), 'Live counts you can act on — each tile opens the full list.');
}

main();
