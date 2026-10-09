// puppy-growth-report.js — "Puppy Growth" (Reports plan, phase 2). Pick a litter;
// each pup's weight checks are plotted by age in days, one line per pup, with a
// table of birth weight, latest weight and gain. A pup well under its littermates'
// median at its latest weigh-in is flagged (breedingReports.growthFlags). The chosen
// litter rides the URL (?litter=) and heads the printout.
import { litterRepo } from '../data/litterRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { eventRepo } from '../data/eventRepo.js';
import { growthSeries, growthFlags } from '../data/breedingReports.js';
import { createReportView } from '../assets/reportView.js';
import { inScopeOnly } from '../data/kennelScope.js';
import { esc, fmtDate, param } from '../assets/ui.js';
import { SEX } from '../data/vocab.js';
import { SERIES_COLORS } from '../assets/chartView.js';

// "2 lb 4.0 oz" from decimal pounds.
function fmtWeight(lbs) {
  if (lbs == null) return '';
  const whole = Math.floor(lbs);
  const oz = Math.round((lbs - whole) * 16 * 10) / 10;
  return whole ? `${whole} lb ${oz.toFixed(1)} oz` : `${oz.toFixed(1)} oz`;
}
// Past eight pups the categorical slots run out; the rest draw in neutral gray
// (still named in the legend and tooltip) rather than reusing a pup's color.
const lineColor = (i) => (i < SERIES_COLORS.length ? SERIES_COLORS[i] : '#9aa3ae');

async function init() {
  const [litters, dogs, events] = await Promise.all([
    litterRepo.getAll({ includeArchived: false }),
    dogRepo.getAll({ includeArchived: true }),
    eventRepo.getByType('weight_check')
  ]);
  const weights = events.filter((e) => e.event_type === 'weight_check' && !e.is_archived);
  const name = new Map(dogs.map((d) => [d.id, d.call_name || '—']));
  const pupsOf = (l) => dogs.filter((d) => d.litter_id === l.id).sort((a, b) => (a.call_name || '').localeCompare(b.call_name || '', undefined, { numeric: true }));
  const label = (l) => l.nickname || `${name.get(l.dam_id) || '—'} × ${name.get(l.sire_id) || '—'}`;
  const weighed = new Set(weights.map((e) => e.subject_id));
  const choices = inScopeOnly(litters).filter((l) => l.whelp_date && l.status !== 'expected')
    .sort((a, b) => b.whelp_date.localeCompare(a.whelp_date));
  const hasData = (l) => pupsOf(l).some((p) => weighed.has(p.id));
  let current = choices.find((l) => l.id === param('litter')) || choices.find(hasData) || choices[0] || null;

  const picker = document.getElementById('growth-picker');
  if (!choices.length) {
    document.getElementById('report-mount').innerHTML = '<div class="card empty-state">No whelped litters yet.</div>';
    return;
  }
  picker.innerHTML = `<label class="muted" style="font-size:13px;">Litter
    <select id="growth-litter" style="margin-left:6px;">${choices.map((l) => `<option value="${esc(l.id)}"${l === current ? ' selected' : ''}>${esc(label(l))} — ${esc(fmtDate(l.whelp_date))}${hasData(l) ? '' : ' (no weights)'}</option>`).join('')}</select></label>`;
  document.getElementById('growth-litter').addEventListener('change', (e) => {
    current = choices.find((l) => l.id === e.target.value);
    history.replaceState(null, '', `?litter=${encodeURIComponent(current.id)}`);
    show();
  });

  function show() {
    const pups = pupsOf(current);
    const series = growthSeries(pups, weights, current);
    const flags = growthFlags(series);
    const rows = series.map((s, i) => ({ ...s, i, first: s.points[0] || null, last: s.points[s.points.length - 1] || null, flag: flags.get(s.pup.id) || null }));
    createReportView({
      mount: document.getElementById('report-mount'),
      title: `Puppy Growth — ${label(current)}`,
      csvFilename: `puppy-growth-${current.whelp_date}.csv`,
      search: { placeholder: 'Search pup…', text: (r) => r.pup.call_name || '' },
      filters: [{ id: 'sex', label: 'Sex', options: SEX, match: (r, v) => r.pup.sex === v }],
      kpis: (list) => {
        const latest = list.filter((r) => r.last).map((r) => r.last.y);
        return [
          { label: 'Pups', value: String(list.length) },
          { label: 'Weigh-ins', value: String(list.reduce((t, r) => t + r.points.length, 0)) },
          { label: latest.length > 1 ? 'Latest weights' : 'Latest weight', value: !latest.length ? '—' : Math.min(...latest) === Math.max(...latest) ? fmtWeight(latest[0]) : `${fmtWeight(Math.min(...latest))} – ${fmtWeight(Math.max(...latest))}` },
          { label: 'Flagged', value: String(list.filter((r) => r.flag).length), hint: 'under 85% of littermates' }
        ];
      },
      charts: (list) => [{
        type: 'line', title: 'Weight by age', subtitle: `${label(current)}, whelped ${fmtDate(current.whelp_date)}`, height: 300,
        xLabel: 'Age (days)', xFormat: (d) => `${d}d`, xMin: 0, format: fmtWeight, axisFormat: (v) => `${v} lb`,
        emptyText: 'No weight checks logged for these pups yet.',
        series: list.filter((r) => r.points.length).map((r) => ({ name: r.pup.call_name || '—', color: lineColor(r.i), points: r.points }))
      }],
      columns: [
        { header: 'Pup', value: (r) => r.pup.call_name || '' },
        { header: 'Sex', value: (r) => r.pup.sex || '', badge: SEX },
        { header: 'First weight', value: (r) => (r.first ? `${fmtWeight(r.first.y)} (day ${r.first.x})` : ''), csv: (r) => (r.first ? String(r.first.y) : '') },
        { header: 'Latest weight', value: (r) => (r.last ? `${fmtWeight(r.last.y)} (day ${r.last.x})` : ''), csv: (r) => (r.last ? String(r.last.y) : '') },
        { header: 'Gain', value: (r) => (r.first && r.last && r.first.y > 0 && r.last !== r.first ? `×${(r.last.y / r.first.y).toFixed(1)}` : '') },
        { header: 'Weigh-ins', value: (r) => String(r.points.length) },
        { header: 'Flag', value: (r) => (r.flag ? `${Math.round(r.flag.ratio * 100)}% of littermates` : ''), tone: () => 'badge-amber' }
      ],
      onRowClick: (r) => { location.href = `dog.html?id=${encodeURIComponent(r.pup.id)}`; },
      load: () => Promise.resolve(rows),
      emptyText: 'No puppies recorded on this litter.'
    });
  }
  show();
}

init();
