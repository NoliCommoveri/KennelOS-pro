// reports.js — the Reports hub. Reports are bucketed (data/reportCatalog.js) and
// the buckets are segment tabs, the same pill toggle the Financials hub uses; the
// chosen bucket rides the URL (?group=money) so Back returns to it. The featured
// report (Year in Review) sits above the tabs.
import { REPORTS, groupsInUse } from '../data/reportCatalog.js';
import { esc, param } from '../assets/ui.js';

const groups = groupsInUse();
const current = groups.some((g) => g.value === param('group')) ? param('group') : groups[0]?.value;

const tile = (r) => `
  <a class="tile" href="${esc(r.href)}">
    <span class="tile-icon">${esc(r.icon)}</span>
    <h3>${esc(r.title)}</h3>
    <p>${esc(r.blurb)}</p>
  </a>`;

const featured = REPORTS.filter((r) => r.featured);
document.getElementById('reports-featured').innerHTML = featured.length
  ? `<div class="grid-links reports-featured">${featured.map(tile).join('')}</div>` : '';

document.getElementById('reports-tabs').innerHTML = groups.map((g) =>
  `<a class="seg-tab${g.value === current ? ' active' : ''}" role="tab" aria-selected="${g.value === current}" href="reports.html?group=${encodeURIComponent(g.value)}">${esc(g.label)}</a>`
).join('');

document.getElementById('reports-tiles').innerHTML = REPORTS
  .filter((r) => r.group === current && !r.featured)
  .map(tile).join('');
