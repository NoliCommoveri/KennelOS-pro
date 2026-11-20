// board.js — Location / Status Board (Stage4.5 Addendum §C4): one row per
// dog currently away from home, then the dogs staying with us. Reads
// getAwayBoardRows() and getStayingWithUsRows() (awayBoard.js), boarding events
// (event_type === 'boarding' — never filtered on `duration`, so active
// medications/heat cycles, also spans, never show up here) split by where the dog
// is (vocab.boardingStayAt).
import { getAwayBoardRows, getStayingWithUsRows } from '../data/awayBoard.js';
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { esc, fmtDate, todayYMD } from '../assets/ui.js';

const awayMount = document.getElementById('board-mount');
const withUsMount = document.getElementById('with-us-mount');

function endCell(date, today, overdueLabel) {
  if (!date) return '<span class="badge badge-blue">Ongoing</span>';
  return `${esc(fmtDate(date))}${date < today ? ` <span class="badge badge-amber">${esc(overdueLabel)}</span>` : ''}`;
}

function wireRows(mount) {
  mount.querySelectorAll('tr[data-href]').forEach((tr) => {
    tr.addEventListener('click', () => { location.href = tr.dataset.href; });
  });
}

async function init() {
  const [away, withUs, dogs, contacts] = await Promise.all([
    getAwayBoardRows(),
    getStayingWithUsRows(),
    dogRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true })
  ]);
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const contactsById = new Map(contacts.map((c) => [c.id, c]));
  const today = todayYMD();
  const dogCell = (row) => `<td><strong>${esc(dogsById.get(row.dogId)?.call_name || '—')}</strong></td>`;
  const contactCell = (row) => {
    const contact = row.contactId ? contactsById.get(row.contactId) : null;
    return `<td>${contact ? esc(contact.name) : '<span class="faint">—</span>'}</td>`;
  };

  if (!away.length) {
    awayMount.innerHTML = `<div class="empty-state">No dogs are currently away from home.</div>`;
  } else {
    const body = away.map((row) => `<tr class="clickable" data-href="${esc(row.href)}">
      ${dogCell(row)}
      <td>${esc(row.location || '')}</td>
      <td>${esc(row.reason || '')}</td>
      ${contactCell(row)}
      <td>${esc(fmtDate(row.outDate))}${row.dropoffTime ? ` <span class="faint">${esc(row.dropoffTime)}</span>` : ''}</td>
      <td>${endCell(row.returnDate, today, 'Overdue?')}${row.pickupTime ? ` <span class="faint">${esc(row.pickupTime)}</span>` : ''}</td>
    </tr>`).join('');
    awayMount.innerHTML = `
      <table class="data">
        <thead><tr><th>Dog</th><th>Location</th><th>Reason</th><th>Contact</th><th>Drop-off</th><th>Return</th></tr></thead>
        <tbody>${body}</tbody>
      </table>`;
    wireRows(awayMount);
  }

  if (!withUs.length) {
    withUsMount.innerHTML = `<div class="empty-state">No dogs are staying with you right now.</div>`;
  } else {
    const body = withUs.map((row) => `<tr class="clickable" data-href="${esc(row.href)}">
      ${dogCell(row)}
      <td>${esc(row.title || row.reason || 'Boarding')}</td>
      ${contactCell(row)}
      <td>${esc(fmtDate(row.outDate))}${row.dropoffTime ? ` <span class="faint">${esc(row.dropoffTime)}</span>` : ''}</td>
      <td>${endCell(row.returnDate, today, 'Past end?')}${row.pickupTime ? ` <span class="faint">${esc(row.pickupTime)}</span>` : ''}</td>
    </tr>`).join('');
    withUsMount.innerHTML = `
      <table class="data">
        <thead><tr><th>Dog</th><th>Stay</th><th>Contact</th><th>From</th><th>Until</th></tr></thead>
        <tbody>${body}</tbody>
      </table>`;
    wireRows(withUsMount);
  }
}

init();
