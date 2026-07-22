// contacts.js — Contact List screen, using the shared listView component.
// Buckets are filtered Contact views (?group=…), not separate tables/repos/pages
// (Data Model v3 §5.5) — Clients is exactly the old `isBuyer` predicate (a
// contact with a `buyer` role and/or a non-null waitlist_status).
import { contactRepo } from '../data/contactRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { createListView } from '../assets/listView.js';
import { badges, badge, esc, param } from '../assets/ui.js';
import { CONTACT_TYPE, WAITLIST_STATUS } from '../data/vocab.js';

const mount = document.getElementById('contact-list');
const group = param('group');

function isClient(c) {
  return (c.contact_type || []).includes('buyer') || (c.waitlist_status && c.waitlist_status !== 'none');
}
function isNetwork(c) {
  const t = c.contact_type || [];
  return t.includes('breeder') || t.includes('co_owner');
}
function isCareTeam(c) {
  const t = c.contact_type || [];
  return t.includes('vet') || t.includes('groomer');
}
function isOther(c) {
  return !isClient(c) && !isNetwork(c) && !isCareTeam(c);
}

const nameAsc = (a, b) => (a.name || '').localeCompare(b.name || '');
const phoneAsc = (a, b) => (a.phone || '').localeCompare(b.phone || '');
const emailAsc = (a, b) => (a.email || '').localeCompare(b.email || '');
const waitlistAsc = (a, b) => (a.waitlist_status || '').localeCompare(b.waitlist_status || '');

const GROUPS = {
  clients: { predicate: isClient, title: 'Clients', subtitle: 'Contacts with a buyer role or a waitlist status.' },
  network: { predicate: isNetwork, title: 'Network', subtitle: 'Other breeders and co-owners.' },
  care: { predicate: isCareTeam, title: 'Care team', subtitle: 'Vets and groomers.' },
  other: { predicate: isOther, title: 'Other', subtitle: 'Contacts not tagged as a client, network, or care-team role.' }
};

function renderTabs() {
  const active = GROUPS[group] ? group : null;
  document.querySelectorAll('#contacts-group-tabs .seg-tab').forEach((tab) => {
    const tabGroup = new URL(tab.href).searchParams.get('group');
    const isActive = tabGroup === active;
    tab.classList.toggle('active', isActive);
    if (isActive) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
  });
  const info = GROUPS[group];
  document.getElementById('contacts-title').textContent = info ? info.title : 'Contacts';
  document.getElementById('contacts-subtitle').textContent = info
    ? info.subtitle
    : 'Vets, co-owners, other breeders, buyers, and referral sources.';
}

async function init() {
  renderTabs();
  const kennels = await kennelRepo.getAll({ includeArchived: true });
  const kennelName = (id) => kennels.find((k) => k.id === id)?.kennel_name || '';
  const kennelAsc = (a, b) => kennelName(a.kennel_id).localeCompare(kennelName(b.kennel_id));

  createListView({
    mount,
    baseFilter: GROUPS[group]?.predicate || (() => true),
    search: {
      placeholder: 'Search name, email, phone…',
      text: (c) => `${c.name || ''} ${c.email || ''} ${c.phone || ''}`
    },
    filters: [
      { id: 'type', label: 'Type', options: CONTACT_TYPE, match: (c, v) => (c.contact_type || []).includes(v) },
      { id: 'waitlist', label: 'Waitlist', options: WAITLIST_STATUS.filter((w) => w.value !== 'none'), match: (c, v) => c.waitlist_status === v }
    ],
    // Name + Type stay visible at every width; Waitlist/Kennel/Phone/Email
    // collapse behind the row's “more details” toggle on phones so the table
    // never forces horizontal scroll on a narrow screen.
    columns: [
      { header: 'Name', sortable: true, sortFn: nameAsc, cell: (c) => `<strong>${esc(c.name)}</strong>` },
      { header: 'Type', cell: (c) => badges(CONTACT_TYPE, c.contact_type) },
      { header: 'Waitlist', sortable: true, sortFn: waitlistAsc, collapse: true, cell: (c) => c.waitlist_status && c.waitlist_status !== 'none' ? badge(WAITLIST_STATUS, c.waitlist_status) : '<span class="faint">—</span>' },
      { header: 'Kennel', sortable: true, sortFn: kennelAsc, collapse: true, cell: (c) => c.kennel_id ? esc(kennelName(c.kennel_id)) : '<span class="faint">—</span>' },
      { header: 'Phone', sortable: true, sortFn: phoneAsc, collapse: true, cell: (c) => c.phone ? esc(c.phone) : '<span class="faint">—</span>' },
      { header: 'Email', sortable: true, sortFn: emailAsc, collapse: true, cell: (c) => c.email ? esc(c.email) : '<span class="faint">—</span>' }
    ],
    onRowClick: (c) => { location.href = `contact.html?id=${encodeURIComponent(c.id)}`; },
    load: (o) => contactRepo.getAll(o),
    emptyText: GROUPS[group] ? `No ${GROUPS[group].title.toLowerCase()} yet.` : 'No contacts yet. Click “+ Add Contact” to create the first one.'
  });
}

init();
