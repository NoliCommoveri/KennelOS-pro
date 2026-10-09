// demand-supply-report.js — "Demand vs Supply" (Reports plan, phase 2). For each kind
// of pup (breed × sex × intended registration, and "Registration not decided"): how
// many families on the list would be offered one — by the waitlist's own matching
// rule (sex, breed, purposes → registration, color when she matches on it) — against
// how many such pups are available now. Families = entries on the list (active);
// pups = available puppies (waitlistRules.isPupAvailable). Pure math in
// data/waitlistReports.js; both sides scoped to the active kennel.
import { waitlistEntryRepo } from '../data/waitlistEntryRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { waitlistConfig, kennelBreeds } from '../data/waitlistRules.js';
import { demandSupply } from '../data/waitlistReports.js';
import { createReportView } from '../assets/reportView.js';
import { inScopeOnly, dogInScope, ownKennels, isScoped, getActiveKennelId } from '../data/kennelScope.js';
import { REGISTRATION_TYPE } from '../data/vocab.js';

const SEXES = [{ value: 'female', label: 'Female' }, { value: 'male', label: 'Male' }];

async function init() {
  const [entries, dogs, sales, litters, kennels, own] = await Promise.all([
    waitlistEntryRepo.getAll({ includeArchived: false }),
    dogRepo.getAll({ includeArchived: false }),
    saleRepo.getAll({ includeArchived: false }),
    litterRepo.getAll({ includeArchived: false }),
    kennelRepo.getAll({ includeArchived: true }),
    ownKennels()
  ]);
  const kennelsById = new Map(kennels.map((k) => [k.id, k]));
  const families = inScopeOnly(entries).filter((e) => e.status === 'active');
  const pups = dogs.filter((d) => d.litter_id && dogInScope(d));
  const scopedKennels = isScoped() ? own.filter((k) => k.id === getActiveKennelId()) : own;
  const breeds = [...new Set(scopedKennels.flatMap((k) => kennelBreeds(k, dogs)))].sort();
  const expected = inScopeOnly(litters).filter((l) => l.status === 'expected');
  const { rows, availableCount, unsexed } = demandSupply({
    families, pups, sales, breeds, configFor: (e) => waitlistConfig(kennelsById.get(e.kennel_id))
  });

  createReportView({
    mount: document.getElementById('report-mount'),
    csvFilename: `demand-supply-${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [
      { id: 'sex', label: 'Sex', options: SEXES, match: (r, v) => r.sex === v },
      { id: 'reg', label: 'Registration', options: [...REGISTRATION_TYPE, { value: 'none_set', label: 'Not decided' }], match: (r, v) => (v === 'none_set' ? !r.registration : r.registration === v) },
      ...(breeds.length > 1 ? [{ id: 'breed', label: 'Breed', options: breeds.map((b) => ({ value: b, label: b })), match: (r, v) => r.breed === v }] : [])
    ],
    kpis: () => [
      { label: 'Families on the list', value: String(families.length) },
      { label: 'Pups available', value: String(availableCount), hint: unsexed ? `${unsexed} with sex not recorded` : '' },
      { label: 'Expected litters', value: String(expected.length), hint: 'not yet whelped' },
      { label: 'Short of pups', value: String(rows.filter((r) => r.gap > 0 && r.registration).length), hint: 'kinds with more families than pups' }
    ],
    charts: (list) => [{
      type: 'bar', title: 'Families vs pups, by kind of pup', subtitle: 'A family counts under every kind of pup they would be offered',
      // Full labels when they fit; past six bars, "F · Full" / "M · ?" (the tooltip and table keep the full name).
      categories: list.map((r, i) => ({ key: String(i), label: r.label, short: list.length <= 6 ? r.label : `${r.sex === 'female' ? 'F' : 'M'} · ${r.registration ? REGISTRATION_TYPE.find((x) => x.value === r.registration).label.split(' ')[0] : '?'}` })),
      series: [{ name: 'Families who’d take one', values: list.map((r) => r.families) }, { name: 'Pups available', values: list.map((r) => r.pups) }]
    }],
    columns: [
      { header: 'Kind of pup', value: (r) => r.label },
      { header: 'Families who’d take one', value: (r) => String(r.families) },
      { header: 'Pups available', value: (r) => String(r.pups) },
      { header: 'Gap', value: (r) => (r.gap > 0 ? `${r.gap} more families than pups` : r.gap < 0 ? `${-r.gap} more pups than families` : 'Even'),
        tone: (r) => (r.gap > 0 && r.registration ? 'badge-amber' : null), csv: (r) => String(r.gap) }
    ],
    load: () => Promise.resolve(rows),
    emptyText: 'No families on the list and no pups available.'
  });
}

init();
