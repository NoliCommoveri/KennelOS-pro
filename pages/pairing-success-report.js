// pairing-success-report.js — "Pairing Success" (Reports plan, phase 2). One row per
// pairing that was actually bred: its outcome (took / missed / waiting — from its
// status, or a litter pointing at it), the method, the litter it produced, and the
// dam's progesterone at breeding. Rates count decided pairings only (took + missed).
// Pure math in data/breedingReports.js; scoped by the pairing's own kennel.
import { pairingRepo } from '../data/pairingRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { eventRepo } from '../data/eventRepo.js';
import { pairingRows, successBy } from '../data/breedingReports.js';
import { createReportView } from '../assets/reportView.js';
import { inScope } from '../data/kennelScope.js';
import { fmtDate } from '../assets/ui.js';
import { PAIRING_METHOD, descriptor } from '../data/vocab.js';
import { SERIES_COLORS } from '../assets/chartView.js';

const OUTCOME = [
  { value: 'success', label: 'Took',    badge: 'badge-green' },
  { value: 'failed',  label: 'Missed',  badge: 'badge-red' },
  { value: 'pending', label: 'Waiting', badge: 'badge-blue' }
];
const rateText = (g) => (g.rate == null ? '—' : `${Math.round(g.rate * 100)}%`);
const rateRows = (groups, label) => groups
  .filter((g) => g.success + g.failed > 0)
  .map((g) => ({ label: label(g.key), value: Math.round(g.rate * 100), note: `${g.success} of ${g.success + g.failed} took${g.pending ? `, ${g.pending} waiting` : ''}` }));

async function init() {
  const [pairings, litters, dogs, events] = await Promise.all([
    pairingRepo.getAll({ includeArchived: false }),
    litterRepo.getAll({ includeArchived: true }),
    dogRepo.getAll({ includeArchived: true }),
    eventRepo.getAll({ includeArchived: false })
  ]);
  const name = new Map(dogs.map((d) => [d.id, d.call_name || '—']));
  const dogName = (id) => name.get(id) || '—';
  const rows = pairingRows({ pairings, litters, events: events.filter((e) => e.event_type === 'progesterone_test') });
  const sires = [...new Set(rows.map((r) => r.pairing.sire_id))].map((id) => ({ value: id, label: dogName(id) })).sort((a, b) => a.label.localeCompare(b.label));

  createReportView({
    mount: document.getElementById('report-mount'),
    scope: (r) => inScope(r.pairing),
    csvFilename: `pairing-success-${new Date().toISOString().slice(0, 10)}.csv`,
    search: { placeholder: 'Search dam or sire…', text: (r) => `${dogName(r.pairing.dam_id)} ${dogName(r.pairing.sire_id)}` },
    dateRange: { label: 'Bred', date: (r) => r.pairing.planned_date },
    filters: [
      { id: 'method', label: 'Method', options: PAIRING_METHOD, match: (r, v) => r.pairing.method === v },
      { id: 'outcome', label: 'Outcome', options: OUTCOME, match: (r, v) => r.outcome === v },
      { id: 'sire', label: 'Sire', options: sires, match: (r, v) => r.pairing.sire_id === v }
    ],
    kpis: (list) => {
      const all = successBy(list, () => 'all')[0] || { success: 0, failed: 0, pending: 0, rate: null };
      return [
        { label: 'Bred', value: String(list.length) },
        { label: 'Took', value: String(all.success) },
        { label: 'Missed', value: String(all.failed) },
        { label: 'Success rate', value: rateText(all), hint: all.pending ? `${all.pending} still waiting, not counted` : 'took ÷ (took + missed)' }
      ];
    },
    charts: (list) => [
      { type: 'hbar', title: 'Success rate by method', showZero: true, format: (v) => `${v}%`,
        rows: rateRows(successBy(list, (r) => r.pairing.method || ''), (k) => (k ? descriptor(PAIRING_METHOD, k).label : 'Method not recorded')) },
      { type: 'hbar', title: 'Success rate by sire', showZero: true, color: SERIES_COLORS[6], format: (v) => `${v}%`, max: 10,
        rows: rateRows(successBy(list, (r) => r.pairing.sire_id), dogName) }
    ],
    columns: [
      { header: 'Bred', value: (r) => (r.pairing.planned_date ? fmtDate(r.pairing.planned_date) : ''), csv: (r) => r.pairing.planned_date || '' },
      { header: 'Dam', value: (r) => dogName(r.pairing.dam_id) },
      { header: 'Sire', value: (r) => dogName(r.pairing.sire_id) },
      { header: 'Method', value: (r) => r.pairing.method || '', badge: PAIRING_METHOD, csv: (r) => (r.pairing.method ? descriptor(PAIRING_METHOD, r.pairing.method).label : '') },
      { header: 'Outcome', value: (r) => r.outcome, badge: OUTCOME, csv: (r) => descriptor(OUTCOME, r.outcome).label },
      { header: 'Progesterone', value: (r) => (r.progesterone ? `${r.progesterone.value} ng/mL` : ''), csv: (r) => (r.progesterone ? String(r.progesterone.value) : '') },
      { header: 'Litter born', value: (r) => (r.litter && r.litter.puppies_born_total != null && r.litter.puppies_born_total !== '' ? String(r.litter.puppies_born_total) : '') }
    ],
    onRowClick: (r) => { location.href = `pairing.html?id=${encodeURIComponent(r.pairing.id)}`; },
    load: () => Promise.resolve(rows),
    emptyText: 'No bred pairings recorded yet.'
  });
}

init();
