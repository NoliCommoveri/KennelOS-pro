// dogs.js — Dog List screen. Uses the shared listView component with dog-specific
// filters, columns, and row navigation.
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { createListView } from '../assets/listView.js';
import { badge, fmtDate, esc, param } from '../assets/ui.js';
import { descriptor, SEX, DOG_STATUS, DISPOSITION, OWNERSHIP_TYPE } from '../data/vocab.js';

const mount = document.getElementById('dog-list');
const bucket = param('bucket');

// Compact single-letter badge (M/F/U) — Call name, Sex, and Status are the only
// columns that stay visible on a narrow screen, so Sex has to fit in that space.
function sexBadge(sex) {
  const d = descriptor(SEX, sex);
  const letter = d.label ? d.label[0].toUpperCase() : '?';
  return `<span class="badge ${d.badge}" title="${esc(d.label)}">${letter}</span>`;
}

// DOB ascending (oldest first), undated rows always last regardless of the
// empty-string-sorts-first quirk of plain string comparison.
function dobAscUndatedLast(a, b) {
  if (!a.date_of_birth && !b.date_of_birth) return 0;
  if (!a.date_of_birth) return 1;
  if (!b.date_of_birth) return -1;
  return a.date_of_birth.localeCompare(b.date_of_birth);
}
const dobDesc = (a, b) => (b.date_of_birth || '').localeCompare(a.date_of_birth || '');
const nameAsc = (a, b) => (a.call_name || '').localeCompare(b.call_name || '');
const registeredNameAsc = (a, b) => (a.registered_name || '').localeCompare(b.registered_name || '');
const sexAsc = (a, b) => (a.sex || '').localeCompare(b.sex || '');
const breedAsc = (a, b) => (a.breed || '').localeCompare(b.breed || '');
const statusAsc = (a, b) => (a.status || '').localeCompare(b.status || '');
const dispositionAsc = (a, b) => (a.disposition || '').localeCompare(b.disposition || '');

const NOT_BREEDING_STATUSES = ['retired_breeding', 'pet_home', 'deceased'];

const BUCKETS = {
  puppies: { baseFilter: (d) => d.status === 'puppy', sort: dobDesc },
  breeding: {
    baseFilter: (d) => d.status === 'active_breeding',
    sort: dobAscUndatedLast,
    groupBy: { key: (d) => d.sex, groups: ['male', 'female', 'unknown'].map((v) => ({ value: v, label: descriptor(SEX, v).label })) }
  },
  not_breeding: {
    baseFilter: (d) => NOT_BREEDING_STATUSES.includes(d.status),
    sort: dobAscUndatedLast,
    groupBy: { key: (d) => d.status, groups: NOT_BREEDING_STATUSES.map((v) => ({ value: v, label: descriptor(DOG_STATUS, v).label })) }
  },
  external: { baseFilter: (d) => d.status === 'external_reference', sort: nameAsc }
};

function renderTabs() {
  document.querySelectorAll('#dogs-bucket-tabs .seg-tab').forEach((tab) => {
    const tabBucket = new URL(tab.href).searchParams.get('bucket');
    const isActive = tabBucket === (BUCKETS[bucket] ? bucket : null);
    tab.classList.toggle('active', isActive);
    if (isActive) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
  });
}

async function init() {
  renderTabs();
  const active = BUCKETS[bucket] || {};
  // Breed filter options come from the data (free-text breeds already entered).
  const [breeds, contacts] = await Promise.all([
    dogRepo.getBreeds(),
    contactRepo.getAll({ includeArchived: true })
  ]);
  const contactName = (id) => contacts.find((c) => c.id === id)?.name || '';
  const label = (vocab, v) => (v ? descriptor(vocab, v).label : '');

  createListView({
    mount,
    baseFilter: active.baseFilter || (() => true),
    sort: active.sort || null,
    groupBy: active.groupBy || null,
    search: {
      placeholder: 'Search by name…',
      text: (d) => `${d.call_name || ''} ${d.registered_name || ''}`
    },
    filters: [
      { id: 'status', label: 'Status', options: DOG_STATUS, match: (d, v) => d.status === v },
      // Disposition — "keeping vs offering". `undecided` matches both the explicit
      // value and never-set records, so it isn't a hole prospective-family filtering
      // could fall through.
      { id: 'disposition', label: 'Disposition', options: DISPOSITION, match: (d, v) => (d.disposition || 'undecided') === v },
      { id: 'sex', label: 'Sex', options: SEX, match: (d, v) => d.sex === v },
      { id: 'ownership', label: 'Ownership', options: OWNERSHIP_TYPE, match: (d, v) => d.ownership_type === v },
      { id: 'breed', label: 'Breed', options: breeds.map((b) => ({ value: b, label: b })), match: (d, v) => d.breed === v }
    ],
    // Call name, Sex, Status, and Disposition stay visible at every width;
    // Registered name, Breed, and DOB collapse behind the row's "more details"
    // toggle on phones so the table never forces horizontal scroll.
    columns: [
      { header: 'Call name', sortable: true, sortFn: nameAsc, cell: (d) => `<strong>${esc(d.call_name)}</strong>` },
      { header: 'Registered name', sortable: true, sortFn: registeredNameAsc, collapse: true, cell: (d) => d.registered_name ? esc(d.registered_name) : '<span class="faint">—</span>' },
      { header: 'Sex', sortable: true, sortFn: sexAsc, cell: (d) => sexBadge(d.sex) },
      { header: 'Breed', sortable: true, sortFn: breedAsc, collapse: true, cell: (d) => esc(d.breed || '—') },
      { header: 'DOB', sortable: true, sortFn: dobAscUndatedLast, collapse: true, cell: (d) => d.date_of_birth ? esc(fmtDate(d.date_of_birth)) : '<span class="faint">—</span>' },
      { header: 'Status', sortable: true, sortFn: statusAsc, cell: (d) => badge(DOG_STATUS, d.status) },
      { header: 'Disposition', sortable: true, sortFn: dispositionAsc, cell: (d) => d.disposition ? badge(DISPOSITION, d.disposition) : '<span class="faint">—</span>' }
    ],
    onRowClick: (d) => { location.href = `dog.html?id=${encodeURIComponent(d.id)}`; },
    load: (o) => dogRepo.getAll(o),
    emptyText: BUCKETS[bucket] ? 'No dogs in this bucket yet.' : 'No dogs yet. Click “+ Add Dog” to create the first record.',
    // Roster's CSV export (Navigation Consolidation Plan v1 §3/§6) — same column
    // set as roster.html, now available directly from the Dogs hub.
    csv: {
      filename: `dogs-${new Date().toISOString().slice(0, 10)}.csv`,
      columns: [
        { header: 'Call name', value: (d) => d.call_name || '' },
        { header: 'Registered name', value: (d) => d.registered_name || '' },
        { header: 'Sex', value: (d) => label(SEX, d.sex) },
        { header: 'Breed', value: (d) => d.breed || '' },
        { header: 'DOB', value: (d) => d.date_of_birth || '' },
        { header: 'Status', value: (d) => label(DOG_STATUS, d.status) },
        { header: 'Disposition', value: (d) => label(DISPOSITION, d.disposition) },
        { header: 'Ownership', value: (d) => label(OWNERSHIP_TYPE, d.ownership_type) },
        { header: 'Owner', value: (d) => contactName(d.owner_contact_id) }
      ]
    }
  });
}

init();
