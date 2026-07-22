// board.js — Location / Status Board (Stage4.5 Addendum §C4): one row per
// dog currently away from home. Reads getAwayBoardRows(), the union of
// boarding events (event_type === 'boarding' — never filtered on `duration`,
// so active medications/heat cycles, also spans, never show up here) and
// in-person stud services (Data Integrity Brief §5).
import { getAwayBoardRows } from '../data/awayBoard.js';
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { esc, fmtDate, todayYMD } from '../assets/ui.js';

const mount = document.getElementById('board-mount');

async function init() {
  const [rows, dogs, contacts] = await Promise.all([
    getAwayBoardRows(),
    dogRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true })
  ]);
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const contactsById = new Map(contacts.map((c) => [c.id, c]));

  if (!rows.length) {
    mount.innerHTML = `<div class="empty-state">No dogs are currently away from home.</div>`;
    return;
  }

  const today = todayYMD();
  const body = rows.map((row) => {
    const dog = dogsById.get(row.dogId);
    const contact = row.contactId ? contactsById.get(row.contactId) : null;
    const returnCell = row.returnDate
      ? `${esc(fmtDate(row.returnDate))}${row.returnDate < today ? ' <span class="badge badge-amber">Overdue?</span>' : ''}`
      : '<span class="badge badge-blue">Ongoing</span>';
    return `<tr class="clickable" data-href="${esc(row.href)}">
      <td><strong>${esc(dog ? dog.call_name : '—')}</strong></td>
      <td>${esc(row.location || '')}</td>
      <td>${esc(row.reason || '')}</td>
      <td>${contact ? esc(contact.name) : '<span class="faint">—</span>'}</td>
      <td>${esc(fmtDate(row.outDate))}${row.dropoffTime ? ` <span class="faint">${esc(row.dropoffTime)}</span>` : ''}</td>
      <td>${returnCell}${row.pickupTime ? ` <span class="faint">${esc(row.pickupTime)}</span>` : ''}</td>
    </tr>`;
  }).join('');

  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Dog</th><th>Location</th><th>Reason</th><th>Contact</th><th>Drop-off</th><th>Return</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;

  mount.querySelectorAll('tr[data-href]').forEach((tr) => {
    tr.addEventListener('click', () => { location.href = tr.dataset.href; });
  });
}

init();
