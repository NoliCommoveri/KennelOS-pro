// scheduled-placements.js — Scheduled Placements report (Stage4.5 Addendum
// §D3): reuses the Stage 1 reporting framework for a near-zero-cost exportable
// list of future-dated `placement` events. A sibling read to the Upcoming
// Deliverables view (§D2), not a filter over it.
import { HistoryEvent } from '../data/eventRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { createReportView } from '../assets/reportView.js';
import { fmtDate } from '../assets/ui.js';

async function init() {
  const [rows, dogs, contacts] = await Promise.all([
    HistoryEvent.getScheduledPlacements(),
    dogRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true })
  ]);
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const contactsById = new Map(contacts.map((c) => [c.id, c]));
  const puppyName = (e) => dogsById.get(e.subject_id)?.call_name || '';
  const buyerName = (e) => e.related_contact_id ? (contactsById.get(e.related_contact_id)?.name || '') : '';

  createReportView({
    mount: document.getElementById('placements-mount'),
    csvFilename: `scheduled-placements-${new Date().toISOString().slice(0, 10)}.csv`,
    search: {
      placeholder: 'Search puppy or buyer…',
      text: (e) => `${puppyName(e)} ${buyerName(e)}`
    },
    columns: [
      { header: 'Puppy', value: puppyName },
      { header: 'Buyer', value: buyerName },
      { header: 'Date', value: (e) => fmtDate(e.event_date), csv: (e) => e.event_date || '' },
      { header: 'Time', value: (e) => e.details?.placement_time || '' },
      { header: 'Location', value: (e) => e.details?.location || '' }
    ],
    onRowClick: (e) => { location.href = `dog.html?id=${encodeURIComponent(e.subject_id)}`; },
    load: () => Promise.resolve(rows),
    emptyText: 'No scheduled placements yet.'
  });
}

init();
