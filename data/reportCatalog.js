// reportCatalog.js — every report on the Reports hub, bucketed (Reports plan:
// "group them rather than one long list"). The hub (pages/reports.js) renders one
// segment tab per group that has reports, and a tile per report; the featured
// report sits above the tabs. Data only, so tests/reportCatalog.test.js can check
// that every page it names exists and is precached.
//
// Adding a report: its page under pages/, a line here in its group, the page in
// shared/data/proPages.js (reports are Pro-only) and in sw.js PRECACHE_URLS.

export const REPORT_GROUPS = [
  { value: 'money',    label: 'Money' },
  { value: 'breeding', label: 'Breeding' },
  { value: 'puppies',  label: 'Puppies' },
  { value: 'sales',    label: 'Sales & Waitlist' },
  { value: 'shows',    label: 'Shows & Stud' },
  { value: 'dogs',     label: 'Dogs & Operations' }
];

// `href` is relative to pages/. `featured` puts it above the tabs.
export const REPORTS = [
  { href: 'year-review.html', icon: '🗓️', title: 'Year in Review', group: 'money', featured: true,
    blurb: 'One printable page for a year: litters, puppies, placements, money in and out, titles earned and the waitlist.' },

  // Money
  { href: 'pl-report.html', icon: '📊', title: 'Profit & Loss by Month', group: 'money',
    blurb: 'Money received vs money spent, month by month, with the net and the year to date.' },
  { href: 'litter-finances-report.html', icon: '💰', title: 'Litter P&L', group: 'money',
    blurb: 'Sale income vs cost per litter: earned and anticipated against litter and puppy expenses, and the net.' },
  { href: 'expenses-report.html', icon: '🧾', title: 'Expenses by Category', group: 'money',
    blurb: 'What you spent by category for a year or any range — the tax-time summary.' },
  { href: 'receivables-report.html', icon: '📬', title: 'Receivables', group: 'money',
    blurb: 'Money still owed to you — deposits, balances, stud fees, foster costs — and how overdue.' },
  { href: 'pricing-report.html', icon: '🏷️', title: 'Pricing', group: 'money',
    blurb: 'What pups sold for by sex, registration and year, against the litter’s price.' },
  { href: 'dog-return-report.html', icon: '📈', title: 'Breeding-Dog Return', group: 'money',
    blurb: 'Per dam and sire: their pups’ income and stud fees against their own costs.' },
  { href: 'financials.html', icon: '📒', title: 'Financials', group: 'money',
    blurb: 'The full income and expense ledgers, where you add and adjust entries.' },

  // Breeding
  { href: 'litters-report.html', icon: '🐣', title: 'Litters Over Time', group: 'breeding',
    blurb: 'Every litter by whelp date, with litters and puppies born per month or year.' },
  { href: 'live-births.html', icon: '📈', title: 'Live-Birth Summary', group: 'breeding',
    blurb: 'Per-litter born / alive / deceased and the live percentage.' },
  { href: 'production-report.html', icon: '🐕', title: 'Dam & Sire Production', group: 'breeding',
    blurb: 'Litters, puppies, live %, average litter and age at each litter per dam and sire; back-to-back litters flagged.' },
  { href: 'pairing-success-report.html', icon: '💞', title: 'Pairing Success', group: 'breeding',
    blurb: 'How often breedings took, by method and by sire, with progesterone at breeding.' },
  { href: 'heat-cycles-report.html', icon: '🌡️', title: 'Heat Cycles', group: 'breeding',
    blurb: 'Each female’s heats, her usual interval, and when the next is likely.' },
  { href: 'health-gaps-report.html', icon: '🩺', title: 'Health-Testing Gaps', group: 'breeding',
    blurb: 'Each dog’s planned tests against the results logged for it.' },
  { href: 'health-tests-report.html', icon: '🔬', title: 'Health-Test Events', group: 'breeding',
    blurb: 'Recorded genetic, OFA/PennHIP and breed-specific results across all dogs.' },

  // Puppies
  { href: 'puppy-growth-report.html', icon: '⚖️', title: 'Puppy Growth', group: 'puppies',
    blurb: 'Weight by age for each pup in a litter, with any pup falling behind its littermates flagged.' },

  // Sales & Waitlist
  { href: 'placements-report.html', icon: '🏡', title: 'Placements', group: 'sales',
    blurb: 'Sales by registration, status and date, with sale value and average price.' },
  { href: 'waitlist-funnel-report.html', icon: '🪜', title: 'Waitlist Funnel', group: 'sales',
    blurb: 'Applied → approved → on the list → offered → placed, why families leave, how offers end.' },
  { href: 'demand-supply-report.html', icon: '🧮', title: 'Demand vs Supply', group: 'sales',
    blurb: 'Families on the list who would take each kind of pup, against the pups you have available.' },
  { href: 'lead-sources-report.html', icon: '📣', title: 'Lead Sources & Referrers', group: 'sales',
    blurb: 'Where buyers came from, and who referred them.' },
  { href: 'returns-report.html', icon: '↩️', title: 'Returns & Voids', group: 'sales',
    blurb: 'Sales that ended without the pup staying placed, and why.' },
  { href: 'scheduled-placements.html', icon: '📅', title: 'Scheduled Placements', group: 'sales',
    blurb: 'Every future-dated puppy drop-off.' },

  // Shows & Stud
  { href: 'stud-services-report.html', icon: '🧬', title: 'Stud Services', group: 'shows',
    blurb: 'Outgoing and incoming arrangements by direction, status and date, with fees.' },
  { href: 'stud-results-report.html', icon: '🐾', title: 'Stud Results', group: 'shows',
    blurb: 'Each stud service and what came of it: the litter, puppies born, the fee.' },
  { href: 'show-record-report.html', icon: '🏆', title: 'Show Record', group: 'shows',
    blurb: 'Results across your dogs: points by dog and judge, majors, titles earned.' },

  // Dogs & Operations
  { href: 'roster.html', icon: '📋', title: 'Active Roster', group: 'dogs',
    blurb: 'All active dogs, filterable and exportable.' },
  { href: 'dashboard.html', icon: '🧭', title: 'Dashboard', group: 'dogs',
    blurb: 'Counts at a glance: dogs by status, litters, sales and what is due soon.' }
];

// The groups that have at least one (non-featured) report, in menu order.
export function groupsInUse(reports = REPORTS) {
  return REPORT_GROUPS.filter((g) => reports.some((r) => r.group === g.value && !r.featured));
}
