// upcoming.js — Upcoming Deliverables (Stage4.5 Addendum §D2): a SEPARATE read
// from the Location/Status Board (event_date >= today, duration: instant,
// across every subject type). Filtering to `placement` here is the glanceable
// "all scheduled puppy drop-offs" the owner asked for.
import { HistoryEvent } from '../data/eventRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { pairingRepo } from '../data/pairingRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { createReportView } from '../assets/reportView.js';
import { fmtDate, esc } from '../assets/ui.js';
import { EVENT_TYPES, descriptor } from '../data/vocab.js';

const INSTANT_TYPES = EVENT_TYPES.filter((t) => t.duration === 'instant');

async function init() {
  const [rows, dogs, pairings, litters, contacts] = await Promise.all([
    HistoryEvent.getUpcoming(),
    dogRepo.getAll({ includeArchived: true }),
    pairingRepo.getAll({ includeArchived: true }),
    litterRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true })
  ]);
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const pairingsById = new Map(pairings.map((p) => [p.id, p]));
  const littersById = new Map(litters.map((l) => [l.id, l]));
  const contactsById = new Map(contacts.map((c) => [c.id, c]));

  function subjectLabel(ev) {
    if (ev.subject_type === 'dog') {
      const d = dogsById.get(ev.subject_id);
      return d ? d.call_name : '—';
    }
    if (ev.subject_type === 'pairing') {
      const p = pairingsById.get(ev.subject_id);
      if (!p) return '—';
      return `${dogsById.get(p.sire_id)?.call_name || '—'} × ${dogsById.get(p.dam_id)?.call_name || '—'}`;
    }
    const l = littersById.get(ev.subject_id);
    if (!l) return '—';
    return `Litter (${dogsById.get(l.dam_id)?.call_name || '—'} × ${dogsById.get(l.sire_id)?.call_name || '—'})`;
  }

  function subjectHref(ev) {
    if (ev.subject_type === 'dog') return `dog.html?id=${encodeURIComponent(ev.subject_id)}`;
    if (ev.subject_type === 'pairing') return `pairing.html?id=${encodeURIComponent(ev.subject_id)}`;
    return `litter.html?id=${encodeURIComponent(ev.subject_id)}`;
  }

  createReportView({
    mount: document.getElementById('upcoming-mount'),
    csvFilename: `upcoming-${new Date().toISOString().slice(0, 10)}.csv`,
    search: {
      placeholder: 'Search title…',
      text: (e) => `${e.title || ''} ${subjectLabel(e)}`
    },
    filters: [
      { id: 'type', label: 'Type', options: INSTANT_TYPES, match: (e, v) => e.event_type === v }
    ],
    columns: [
      { header: 'Date', value: (e) => fmtDate(e.event_date), csv: (e) => e.event_date || '' },
      { header: 'Subject', value: (e) => subjectLabel(e) },
      { header: 'Type', value: (e) => e.event_type, badge: EVENT_TYPES, csv: (e) => descriptor(EVENT_TYPES, e.event_type).label },
      { header: 'Title', value: (e) => e.title || '' },
      { header: 'Related contact', value: (e) => e.related_contact_id ? (contactsById.get(e.related_contact_id)?.name || '') : '' }
    ],
    onRowClick: (e) => { location.href = subjectHref(e); },
    load: () => Promise.resolve(rows),
    emptyText: 'Nothing scheduled — no upcoming instant events.'
  });
}

init();
