// kelsKnowledge.js — Kels's cheat sheet: the places in the app she can send the
// breeder to (Kels roadmap §3.11, End-State guide §33), for "Finding Something"
// (data/kelsFind.js). Written by us, not read from the pages: a page's buttons
// don't say where things are, and this does. Pure data plus placeCandidates().
//
// A place: { id, title, where, keywords, href, flag? }.
//   href: a page, relative to pages/ (a query picks its tab where the page reads one);
//     {kennel} is her active kennel's id (no kennel, no place).
//   where: the sentence Kels says, or (nav) => sentence, where nav(path) is that
//     hub's name in this edition's menu ("Placements & Contracts" in Pro, "Sales"
//     in Lite).
//   flag: an editionFlags key the place needs. A place whose page is Pro-only
//     (proPages.js) isn't offered in Lite either.
// The reports (reportCatalog.REPORTS) and the expense categories come in by
// themselves, so a new one is findable without a line here.
//
// Adding a place: a line below. tests/kelsKnowledge.test.js checks its page
// exists and is precached.
import { REPORTS, REPORT_GROUPS } from './reportCatalog.js';
import { EXPENSE_CATEGORIES } from './vocab.js';
import { isProOnlyPage } from './proPages.js';

export const PLACES = [
  // Today
  { id: 'today', title: 'Today', href: 'today.html', keywords: ['home', 'start', 'dashboard', 'overview', 'nudges', 'what needs me'],
    where: 'Today is your home page: what needs you first (reminders and what\'s due) at the top, and your kennel at a glance below.' },
  { id: 'reminders', title: 'Reminders', href: 'reminders.html', keywords: ['reminder', 'overdue', 'due', 'snooze', 'dismiss', 'to do'],
    where: 'Reminders are at the top of Today. The Reminders page has every one, overdue first, to dismiss or snooze.' },
  { id: 'upcoming', title: 'Upcoming', href: 'upcoming.html', keywords: ['upcoming', 'coming up', 'scheduled', 'appointments', 'deliverables', 'next'],
    where: 'Upcoming lists everything scheduled from today on: drop-offs, vet visits, surgeries and more. It\'s on Today.' },
  { id: 'calendar', title: 'Calendar', href: 'calendar.html', keywords: ['calendar', 'month', 'schedule', 'google calendar', 'dates'],
    where: 'The Calendar shows every event and reminder a month at a time. Tap a day for details and an "Add to Google Calendar" link.' },
  { id: 'dashboard', title: 'Dashboard', href: 'dashboard.html', keywords: ['dashboard', 'at a glance', 'counts', 'summary', 'overview'],
    where: 'The Dashboard is your kennel at a glance, at the bottom of Today.' },
  { id: 'board', title: 'Location / Status Board', href: 'board.html', keywords: ['away', 'boarding', 'location', 'where is my dog', 'board', 'status board'],
    where: 'The Location / Status Board lists every dog away from home right now (boarding and in-person stud services). It\'s on Today.' },
  { id: 'scheduled-placements', title: 'Scheduled drop-offs', href: 'scheduled-placements.html', keywords: ['drop off', 'pickup', 'pick up', 'go home', 'going home', 'scheduled placements'],
    where: 'Scheduled Placements lists every puppy drop-off still to come. It\'s on Today.' },

  // Dogs
  { id: 'dogs', title: 'Dogs', href: 'dogs.html', keywords: ['dogs', 'all dogs', 'my dogs', 'list'],
    where: (nav) => `${nav('pages/dogs.html')} in the menu lists every dog, with tabs for Puppies, Breeding, Not breeding and External.` },
  { id: 'puppies', title: 'Puppies', href: 'dogs.html?bucket=puppies', keywords: ['puppies', 'pups', 'babies'],
    where: (nav) => `Your puppies are under ${nav('pages/dogs.html')}, on the Puppies tab. Each litter's own puppies are on its litter page too.` },
  { id: 'available-puppies', title: 'Available puppies', href: 'dogs.html?bucket=puppies&disposition=available', keywords: ['available', 'unsold', 'for sale', 'not sold', 'still available', 'unsold puppies', 'unsold pups', 'available pups'],
    where: (nav) => `Your available puppies are under ${nav('pages/dogs.html')}, on the Puppies tab with Disposition set to Available. Each litter's page shows its unsold pups too.` },
  { id: 'breeding-dogs', title: 'Breeding dogs', href: 'dogs.html?bucket=breeding', keywords: ['breeding dogs', 'breeders', 'stock', 'active', 'dams', 'sires', 'brood'],
    where: (nav) => `Your breeding dogs are under ${nav('pages/dogs.html')}, on the Breeding tab.` },
  { id: 'retired-dogs', title: 'Retired and pet dogs', href: 'dogs.html?bucket=not_breeding', keywords: ['retired', 'pet home', 'not breeding', 'spayed', 'neutered'],
    where: (nav) => `Retired and pet dogs are under ${nav('pages/dogs.html')}, on the Not breeding tab.` },
  { id: 'external-dogs', title: 'Other people\'s dogs', href: 'dogs.html?bucket=external', flag: 'externalOwnership', keywords: ['external', 'outside', 'other people', 'someone else', 'leased', 'co owned', 'outside stud'],
    where: (nav) => `Dogs that belong to someone else are under ${nav('pages/dogs.html')}, on the External tab.` },
  { id: 'add-dog', title: 'Add a dog', href: 'dog.html?new=1', keywords: ['add dog', 'new dog', 'add a dog', 'create dog'],
    where: (nav) => `${nav('pages/dogs.html')} has a + Add Dog button. Or pick "Doing Something" and I'll add dogs with you.` },
  { id: 'roster', title: 'Active Roster', href: 'roster.html', keywords: ['roster', 'export dogs', 'dog list', 'csv'],
    where: 'The Active Roster is every dog in one table, to search, filter and export to CSV.' },
  { id: 'pedigree', title: 'Pedigree', href: 'pedigree.html', keywords: ['pedigree', 'family tree', 'ancestors', 'lineage', 'generations'],
    where: 'Each dog\'s page has its pedigree at the bottom. The Pedigree page shows the family tree: tap a dog to re-center on it.' },
  { id: 'pedigree-import', title: 'Import a pedigree', href: 'pedigree-import.html', keywords: ['import pedigree', 'pedigree pdf', 'scan pedigree', 'read pedigree'],
    where: 'Import / Export → Import Pedigrees reads pedigree PDFs or photos and adds every dog on them, just for the pedigree.' },
  { id: 'dog-health', title: 'A dog\'s health tests', href: 'dogs.html', keywords: ['health tests', 'test results', 'ofa', 'genetic', 'planned tests', 'clearances'],
    where: (nav) => `Each dog's page (under ${nav('pages/dogs.html')}) has its planned tests and health-test results, and its history below them.` },
  { id: 'dog-history', title: 'A dog\'s history', href: 'dogs.html', keywords: ['history', 'timeline', 'events', 'vet visit', 'shots', 'vaccine', 'medication', 'heat', 'weight'],
    where: (nav) => `Everything that's happened to a dog (shots, vet visits, heats, weights) is on its page under ${nav('pages/dogs.html')}, in its history. Tell me the dog's name and I'll take you there.` },

  // Breeding
  { id: 'breeding', title: 'Breeding', href: 'breeding.html', keywords: ['breeding', 'pairings', 'litters', 'heats'],
    where: (nav) => `${nav('pages/breeding.html')} in the menu shows each breeding with its litter and puppies, newest first.` },
  { id: 'pairings', title: 'Pairings', href: 'pairings.html', keywords: ['pairings', 'pairing', 'breedings', 'matings', 'planned breeding'],
    where: (nav) => `Pairings (planned and actual breedings) are under ${nav('pages/breeding.html')}.` },
  { id: 'litters', title: 'Litters', href: 'litters.html', keywords: ['litters', 'whelped', 'expected', 'litter list', 'puppies', 'pups', 'unsold puppies', 'unsold pups', 'available puppies', 'available pups'],
    where: (nav) => `Litters, whelped and expected, are under ${nav('pages/breeding.html')}. Each litter's page has its puppies, prices and sales.` },
  { id: 'heat-log', title: 'Log a heat', href: 'breeding.html', keywords: ['heat', 'season', 'in heat', 'log heat', 'heat cycle', 'progesterone'],
    where: (nav) => `${nav('pages/breeding.html')} has a + Log heat cycle button. A dog's heats are in its history too.` },
  { id: 'active-breeding', title: 'Active Breeding', href: 'active-breeding.html', keywords: ['active breeding', 'export pairings', 'breeding table'],
    where: 'Active Breeding is every pairing and litter in one table, to search, filter and export to CSV.' },
  { id: 'live-births', title: 'Live-Birth Summary', href: 'live-births.html', keywords: ['live births', 'born alive', 'birth outcomes', 'survival'],
    where: 'The Live-Birth Summary has each litter\'s birth outcomes and its live percentage.' },
  { id: 'feeding-schedules', title: 'Feeding schedules', href: 'breed-feeding-schedules.html', flag: 'feedingSchedule', keywords: ['feeding', 'food amounts', 'feeding chart', 'diet'],
    where: 'Feeding Schedules hold your recommended amounts by breed. They\'re also under your kennel\'s page, Feeding schedules.' },

  // People
  { id: 'contacts', title: 'Contacts', href: 'contacts.html', flag: 'contactsSection', keywords: ['contacts', 'people', 'address book', 'phone numbers', 'emails'],
    where: (nav) => `${nav('pages/contacts.html')} in the menu has everyone: families, vets, other breeders and referral sources.` },
  { id: 'buyers', title: 'Families and buyers', href: 'contacts.html?group=clients', flag: 'contactsSection', keywords: ['buyers', 'families', 'clients', 'customers', 'puppy families'],
    where: (nav) => `Your families are under ${nav('pages/contacts.html')}, on the Clients tab.` },
  { id: 'care-team', title: 'Vets and care team', href: 'contacts.html?group=care', flag: 'contactsSection', keywords: ['vet', 'vets', 'groomer', 'care team', 'trainer'],
    where: (nav) => `Your vet and care team are under ${nav('pages/contacts.html')}, on the Care team tab.` },
  { id: 'network', title: 'Breeders and partners', href: 'contacts.html?group=network', flag: 'contactsSection', keywords: ['breeders', 'other breeders', 'network', 'co owners', 'handlers', 'partners'],
    where: (nav) => `Other breeders, co-owners and handlers are under ${nav('pages/contacts.html')}, on the Network tab.` },
  { id: 'waitlist', title: 'Waitlist', href: 'waitlist.html', flag: 'waitlist', keywords: ['waitlist', 'wait list', 'applications', 'reservations', 'deposit list', 'families waiting', 'people on waitlist', 'people waiting'],
    where: (nav) => `The Waitlist is under ${nav('pages/contacts.html')}, on the Waitlist tab: applications, families owing their fee, and your list.` },
  { id: 'waitlist-form', title: 'Application form', href: 'waitlist-form.html', flag: 'waitlist', keywords: ['application form', 'questions', 'faq', 'apply form'],
    where: 'Your application form (the questions families answer, and your FAQ) is on the Waitlist page.' },
  { id: 'waitlist-publish', title: 'Publish your list', href: 'waitlist-publish.html', flag: 'waitlist', keywords: ['publish waitlist', 'online waitlist', 'share list', 'facebook'],
    where: 'Publish your list is on the Waitlist page: put it online, or copy it as text for Facebook or your website.' },
  { id: 'waitlist-programs', title: 'Waitlist programs', href: 'waitlist-programs.html', flag: 'waitlist', keywords: ['programs', 'waived fee', 'discount', 'priority'],
    where: 'Waitlist programs (a waived fee, a place ahead, extra passes) are on the Waitlist page.' },

  // Placements & contracts
  { id: 'sales', title: 'Sales', href: 'sales.html', keywords: ['sales', 'sold', 'placements', 'reserved', 'deposits', 'balance'],
    where: (nav) => `${nav('pages/sales.html')} in the menu lists every sale, by litter.` },
  { id: 'add-sale', title: 'Record a sale', href: 'sale.html?new=1', keywords: ['new sale', 'add sale', 'record sale', 'sell a puppy'],
    where: (nav) => `${nav('pages/sales.html')} has a + Add Sale button, and each puppy's page has one too.` },
  { id: 'puppy-records', title: 'Puppy records', href: 'sales.html', flag: 'puppyRecord', keywords: ['puppy record', 'puppy packet', 'print', 'go home packet', 'paperwork'],
    where: (nav) => `${nav('pages/sales.html')} has a Print Puppy Record button. Or pick "Doing Something" → Pups are going home, and I'll print them with you.` },
  { id: 'stud-services', title: 'Stud services', href: 'stud-services.html', flag: 'studServices', keywords: ['stud service', 'stud fee', 'outside stud', 'stud contract', 'stud my dog', 'stud out', 'stud dog', 'stud to'],
    where: (nav) => `Stud services are under ${nav('pages/sales.html')}, on the Stud Services tab.` },
  { id: 'contracts', title: 'Contracts', href: 'contracts.html', flag: 'contracts', keywords: ['contracts', 'agreement', 'co own', 'lease', 'signed contract'],
    where: (nav) => `A sale's contract is on its sale. Co-own, lease and other contracts are under ${nav('pages/sales.html')}, on the Other contracts tab.` },

  // Money
  { id: 'financials', title: 'Financials', href: 'financials.html', keywords: ['money', 'finances', 'financials', 'books', 'ledger'],
    where: (nav) => `${nav('pages/financials.html')} in the menu has your money in one place: an overview, income and expenses.` },
  { id: 'expenses', title: 'Expenses and receipts', href: 'financials.html?view=expenses', keywords: ['expenses', 'receipts', 'spending', 'costs', 'bills', 'purchases', 'mileage'],
    where: (nav) => `Expenses are under ${nav('pages/financials.html')}, on the Expenses tab, each with its receipt when you've attached one. + Add Expense is at the top.` },
  { id: 'income', title: 'Income', href: 'financials.html?view=income', keywords: ['income', 'payments', 'puppy payments', 'earnings', 'paid', 'revenue', 'deposits received', 'balances paid'],
    where: (nav) => `Income is under ${nav('pages/financials.html')}, on the Income tab: what's been paid and what's still coming.` },
  { id: 'invoice', title: 'Invoices and receipts to send', href: 'financials.html', flag: 'invoicing', keywords: ['invoice', 'receipt', 'bill a family', 'send invoice', 'payment receipt'],
    where: (nav) => `${nav('pages/financials.html')} has an Invoice / Receipt button to make one for a family.` },
  { id: 'expense-import', title: 'Import expenses', href: 'expense-import.html', keywords: ['import expenses', 'import receipts', 'mileage log'],
    where: 'Import / Export → CSV import → Expenses brings in receipts and mileage logs from a spreadsheet.' },

  // Storage
  { id: 'documents', title: 'Documents', href: 'documents.html', flag: 'documents', keywords: ['documents', 'papers', 'files', 'registration papers', 'certificates', 'pdf', 'uploads'],
    where: (nav) => `Documents (pedigrees, health tests, registrations, contracts) are under ${nav('pages/documents.html')}, filed by dog. A dog's page has them too.` },
  { id: 'shows', title: 'Shows', href: 'shows.html', flag: 'shows', keywords: ['shows', 'show entries', 'results', 'points', 'judge', 'ring', 'conformation'],
    where: (nav) => `Shows are under ${nav('pages/documents.html')}, on the Shows tab: upcoming entries and results.` },
  { id: 'accounts', title: 'Accounts', href: 'accounts.html', flag: 'accounts', keywords: ['accounts', 'logins', 'passwords', 'username', 'akc account', 'referral code', 'referral link', 'member number'],
    where: (nav) => `Your business accounts (registries, vendors, logins and referral codes) are under ${nav('pages/documents.html')}, on the Accounts tab.` },

  // Sharing
  { id: 'companion', title: 'Companion messaging', href: 'companion.html', flag: 'companion', keywords: ['share', 'companion', 'send family update', 'link for family'],
    where: (nav) => `${nav('pages/companion.html')} in the menu, Companion: send a family or partner a read-only link to their own records.` },
  { id: 'furever', title: 'Furever', href: 'furever.html', flag: 'furever', keywords: ['furever', 'family app', 'care app', 'seed link'],
    where: (nav) => `Furever is under ${nav('pages/companion.html')}: send a family their pup's own care app.` },
  { id: 'assistant', title: 'KennelAssistant', href: 'assistant.html', flag: 'assistant', keywords: ['helper', 'assistant', 'kennelassistant', 'dropbox', 'employee', 'kennel help'],
    where: (nav) => `KennelAssistant is under ${nav('pages/companion.html')}: let a helper log weights, meds and notes from their own phone.` },

  // Kennel
  { id: 'kennel', title: 'Your kennel', href: 'kennel.html?id={kennel}', flag: 'contactsSection', keywords: ['kennel', 'kennel settings', 'kennel page', 'my kennel'],
    where: 'Your kennel\'s page has its settings, one section at a time: litters, finances, logo, preferred tests, waitlist settings and more.' },
  { id: 'kennel-logo', title: 'Kennel logo', href: 'kennel.html?id={kennel}#logo', flag: 'contactsSection', keywords: ['logo', 'kennel logo', 'picture', 'branding'],
    where: 'Your logo is on your kennel\'s page, the Logo section.' },
  { id: 'kennel-card', title: 'Kennel card', href: 'kennel.html?id={kennel}#card', flag: 'contactsSection', keywords: ['kennel card', 'business card', 'share kennel'],
    where: 'Your kennel card is on your kennel\'s page, the Kennel card section.' },
  { id: 'preferred-tests', title: 'Preferred tests', href: 'kennel.html?id={kennel}#tests', flag: 'contactsSection', keywords: ['preferred tests', 'test checklist', 'required tests', 'breed tests'],
    where: 'The tests you do for your breeds are on your kennel\'s page, the Preferred tests section.' },
  { id: 'kennels', title: 'Kennels', href: 'kennels.html', flag: 'contactsSection', keywords: ['kennels', 'other kennels', 'switch kennel', 'add kennel'],
    where: 'Kennels lists your own kennels and every other kennel on record.' },

  // Reports, import/export, settings
  { id: 'reports', title: 'Reports', href: 'reports.html', flag: 'reports', keywords: ['reports', 'charts', 'stats', 'analytics', 'tax'],
    where: 'Reports are under More → Reports, grouped by Money, Breeding, Puppies, Sales & Waitlist, Shows & Stud, and Dogs.' },
  { id: 'backup', title: 'Back up and restore', href: 'import-export.html', keywords: ['backup', 'back up', 'restore', 'export', 'download', 'save my data', 'cloud', 'dropbox'],
    where: 'More → Import / Export has Back up and Restore: to the cloud, this device or Dropbox.' },
  { id: 'csv-import', title: 'Import from a spreadsheet', href: 'import-export.html', keywords: ['import', 'csv', 'spreadsheet', 'excel', 'upload', 'bring in'],
    where: 'More → Import / Export has CSV import: pick what the file holds and you\'ll see a preview first.' },
  { id: 'import-batch', title: 'Import several files', href: 'import-batch.html', keywords: ['import several', 'many files', 'bulk import', 'move from another app'],
    where: 'Import / Export → Import several files takes all your CSV files at once and imports them in the right order.' },
  { id: 'reset', title: 'Reset the app', href: 'import-export.html', keywords: ['reset', 'start over', 'erase', 'delete everything', 'wipe'],
    where: 'More → Import / Export, at the bottom: the Danger zone has Reset app. Back up first!' },
  { id: 'settings', title: 'Settings', href: 'settings.html', keywords: ['settings', 'preferences', 'options', 'account'],
    where: 'More → Settings: your account, your kennel, and this device.' },
  { id: 'cloud-account', title: 'Cloud account and sign-in', href: 'settings.html', keywords: ['sign in', 'log in', 'cloud', 'cloud backup', 'kennelos account', 'sensitive records'],
    where: 'More → Settings has your KennelOS cloud sign-in, backup and Sensitive records, where your edition has them.' },
  { id: 'license', title: 'Your license', href: 'settings.html', keywords: ['license', 'subscription', 'pro', 'renew', 'devices', 'release device'],
    where: 'More → Settings, This device\'s license: your license and releasing this device.' },
  { id: 'tour', title: 'The guided tour', href: 'settings.html', keywords: ['tour', 'guided tour', 'how to use', 'tutorial', 'walkthrough'],
    where: 'More → Settings has Restart the guided tour.' }
];

const REPORT_GROUP_LABEL = new Map(REPORT_GROUPS.map((g) => [g.value, g.label]));

// Every place this edition has, as Find candidates (data/kelsFind.js).
// ctx: { edition, flags, nav: (path) => the hub's name in the menu, kennelId }.
export function placeCandidates({ edition, flags = {}, nav = (p) => p, kennelId = null }) {
  const offered = (p) => (!p.flag || flags[p.flag]) && !(edition === 'lite' && isProOnlyPage(p.href.split(/[?#]/)[0]))
    && (kennelId || !p.href.includes('{kennel}'));
  const place = (p) => ({
    id: `place:${p.id}`, group: 'A page in the app', title: p.title,
    where: typeof p.where === 'function' ? p.where(nav) : p.where,
    href: p.href.replace('{kennel}', encodeURIComponent(kennelId || '')), levels: [[p.title, ...p.keywords], [], []]
  });
  const reports = REPORTS.map((r) => ({
    id: `report:${r.href}`, title: r.title, href: r.href, flag: 'reports', keywords: ['report'],
    where: `${r.blurb} It's under More → Reports, ${REPORT_GROUP_LABEL.get(r.group) || 'Reports'}.`, blurb: r.blurb
  }));
  const categories = EXPENSE_CATEGORIES.map((c) => ({
    id: `expenses-${c.value}`, title: `${c.label} expenses`, href: `financials.html?view=expenses&bucket=${c.value}`,
    keywords: ['expense'], where: (n) => `Under ${n('pages/financials.html')} → Expenses, the ${c.label} tab.`
  }));
  return [
    ...PLACES.filter(offered).map(place),
    ...reports.filter((r) => offered(r) && !PLACES.some((p) => p.href === r.href)).map((r) => ({ ...place(r), levels: [[r.title, 'report'], [r.blurb], []] })),
    ...categories.filter(offered).map((c) => ({ ...place(c), boost: -0.5 }))
  ];
}
