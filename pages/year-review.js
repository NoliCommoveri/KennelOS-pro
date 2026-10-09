// year-review.js — "Year in Review" (Reports plan, phase 1): a one-page summary
// of one calendar year, made to be printed or saved as a PDF. The numbers come
// from data/yearReview.js (pure), over records scoped to the active kennel the
// same way each matching report scopes them; the charts are assets/chartView.js.
import { litterRepo } from '../data/litterRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { eventRepo } from '../data/eventRepo.js';
import { waitlistEntryRepo } from '../data/waitlistEntryRepo.js';
import { loadMoney, incomeEntries } from '../data/moneyReport.js';
import { yearSummary, reviewYears } from '../data/yearReview.js';
import { inScopeOnly, subjectInScope } from '../data/kennelScope.js';
import { editionFlags } from '../data/editionConfig.js';
import { periodLabel, periodSeries, pct } from '../data/reportMath.js';
import { mountChart, SERIES_COLORS } from '../assets/chartView.js';
import { wirePrintHeader, printButton } from '../assets/printView.js';
import { esc, fmtDate, fmtMoney, param } from '../assets/ui.js';
import { todayYMD } from '../data/dateUtils.js';
import { REGISTRATION_TYPE } from '../data/vocab.js';

const money = (v) => fmtMoney(Math.round((Number(v) || 0) * 100) / 100);
const charts = [];

async function load() {
  const [litters, sales, dogs, events, waitlist, { incomeRows, expenses }] = await Promise.all([
    litterRepo.getAll({ includeArchived: false }),
    saleRepo.getAll({ includeArchived: false }),
    dogRepo.getAll({ includeArchived: true }),
    eventRepo.getAll({ includeArchived: false }),
    editionFlags.waitlist ? waitlistEntryRepo.getAll({ includeArchived: false }) : Promise.resolve([]),
    loadMoney()
  ]);
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  return {
    dogsById,
    litters: inScopeOnly(litters),
    sales: inScopeOnly(sales),
    events: events.filter((e) => e.subject_type === 'dog' && subjectInScope('dog', e.subject_id, { dog: dogsById })),
    waitlist: inScopeOnly(waitlist),
    moneyEntries: incomeEntries(incomeRows),
    expenses
  };
}

function tile(label, value, hint = '') {
  return `<div class="stat"><div class="stat-num">${esc(value)}</div><div class="stat-label">${esc(label)}</div>${hint ? `<div class="stat-hint">${esc(hint)}</div>` : ''}</div>`;
}

function render(data, year) {
  const s = yearSummary(year, data);
  const name = (id) => data.dogsById.get(id)?.call_name || '—';
  const tiles = [
    tile('Litters whelped', String(s.litters.length)),
    tile('Puppies born', String(s.puppiesBorn), s.puppiesBorn ? `${s.puppiesAlive} alive (${pct(s.puppiesAlive, s.puppiesBorn)})` : ''),
    tile('Placements', String(s.placements.length), s.fellThrough ? `${s.fellThrough} fell through` : ''),
    tile('Titles earned', String(s.titles.length)),
    tile('Money in', money(s.moneyIn)),
    tile('Money out', money(s.moneyOut)),
    tile('Net', money(s.net)),
    editionFlags.waitlist
      ? tile('Waitlist', `${s.waitlistApplied} applied`, `${s.waitlistNow} on the list now`)
      : tile('Average litter', s.litters.length ? (s.puppiesBorn / s.litters.length).toFixed(1) : '—')
  ].join('');

  const litterRows = s.litters.map((l) => `<tr><td>${esc(fmtDate(l.whelp_date))}</td><td>${esc(l.nickname || `${name(l.dam_id)} × ${name(l.sire_id)}`)}</td><td class="num">${esc(String(l.puppies_born_total ?? '—'))}</td><td class="num">${esc(String(l.puppies_born_alive ?? '—'))}</td></tr>`).join('');
  const titleRows = s.titles.map((e) => `<tr><td>${esc(fmtDate(e.event_date))}</td><td>${esc(name(e.subject_id))}</td><td>${esc(e.details?.title_abbreviation || e.title || '')}</td></tr>`).join('');

  document.getElementById('yr-body').innerHTML = `
    <div class="stat-grid report-kpis yr-kpis">${tiles}</div>
    <div class="report-charts yr-charts">
      <div class="chart-slot" id="yr-chart-money"></div>
      <div class="chart-slot" id="yr-chart-placements"></div>
      <div class="chart-slot" id="yr-chart-pups"></div>
      <div class="chart-slot" id="yr-chart-net"></div>
    </div>
    <div class="yr-lists">
      <div class="print-block">
        <h3>Litters</h3>
        ${litterRows ? `<table class="data"><thead><tr><th>Whelped</th><th>Litter</th><th>Born</th><th>Alive</th></tr></thead><tbody>${litterRows}</tbody></table>` : '<p class="muted">No litters whelped this year.</p>'}
      </div>
      <div class="print-block">
        <h3>Titles earned</h3>
        ${titleRows ? `<table class="data"><thead><tr><th>Date</th><th>Dog</th><th>Title</th></tr></thead><tbody>${titleRows}</tbody></table>` : '<p class="muted">No titles recorded this year.</p>'}
      </div>
    </div>`;

  while (charts.length) charts.pop().destroy();
  const cats = s.months.map((m) => ({ key: m.period, label: periodLabel(m.period), short: periodLabel(m.period, { short: true }) }));
  const range = { from: `${s.year}-01-01`, to: `${s.year}-12-31` };
  const regs = REGISTRATION_TYPE.filter((r) => s.placements.some((x) => x.registration_type === r.value));
  const placed = periodSeries(s.placements, range, {
    yearMarks: false,
    date: (x) => x.sale_date,
    series: regs.map((r) => ({ name: r.label, color: SERIES_COLORS[REGISTRATION_TYPE.indexOf(r)], when: (x) => x.registration_type === r.value }))
  });
  const pups = periodSeries(s.litters, range, {
    yearMarks: false,
    date: (l) => l.whelp_date,
    series: [{ name: 'Born alive', value: (l) => l.puppies_born_alive }, { name: 'Born deceased', value: (l) => l.puppies_born_deceased }]
  });
  const mount = (id, spec) => charts.push(mountChart(document.getElementById(id), { height: 180, ...spec }));
  mount('yr-chart-money', { type: 'bar', money: true, title: 'Money in vs money out', format: money, categories: cats,
    series: [{ name: 'Money in', values: s.months.map((m) => m.income) }, { name: 'Money out', values: s.months.map((m) => m.expenses) }] });
  mount('yr-chart-net', { type: 'bar', diverging: true, money: true, title: 'Net by month', format: money, categories: cats,
    series: [{ name: 'Net', values: s.months.map((m) => m.net) }] });
  mount('yr-chart-placements', { type: 'bar', stacked: true, title: 'Placements by month', subtitle: 'By registration', categories: placed.categories, series: placed.series, emptyText: 'No placements this year.' });
  mount('yr-chart-pups', { type: 'bar', stacked: true, title: 'Puppies born by month', categories: pups.categories, series: pups.series, emptyText: 'No puppies born this year.' });
}

async function init() {
  const data = await load();
  const current = todayYMD().slice(0, 4);
  const years = reviewYears({ ...data, entries: data.moneyEntries }, current);
  let year = years.includes(param('year')) ? param('year') : years[0];

  const controls = document.getElementById('yr-controls');
  controls.style.display = 'flex';
  controls.style.gap = '8px';
  controls.style.alignItems = 'center';
  const sel = document.createElement('select');
  sel.setAttribute('aria-label', 'Year');
  sel.innerHTML = years.map((y) => `<option value="${esc(y)}"${y === year ? ' selected' : ''}>${esc(y)}</option>`).join('');
  const fill = wirePrintHeader(document.getElementById('yr-print-header'), { title: () => `Year in Review ${year}`, getDetails: () => [`Year: ${year}`] });
  controls.append(sel, printButton(fill));
  sel.addEventListener('change', () => {
    year = sel.value;
    history.replaceState(null, '', `?year=${encodeURIComponent(year)}`);
    render(data, year);
    fill();
  });
  render(data, year);
}

init();
