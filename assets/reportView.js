// reportView.js — the single reusable reporting component (Build Brief A4). It
// takes a record list + column config + optional filters/search, renders a
// table, and offers "export visible rows to CSV". Stage 2 proves it with the
// Active Roster (B2); every later stage's report plugs into this same component
// instead of getting bespoke rendering.
//
// Column config:
//   { header, value:(r)=>string, badge?:vocabArray, csv?:(r)=>string, className? }
//     value — plain-text accessor (also the CSV value unless `csv` overrides).
//     badge — if set, the cell renders value() as a colored badge for that vocab.
//     csv   — override the exported value (defaults to value()).
import Papa from '../vendor/papaparse.min.mjs';
import { esc, badge as badgeHtml } from './ui.js';

function downloadCsv(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function createReportView(opts) {
  const {
    mount,
    columns,
    filters = [],
    search,                       // { placeholder, text:(r)=>string }
    load,                         // async () => records[]
    onRowClick,                   // optional (r) => void
    csvFilename = 'report.csv',
    emptyText = 'No matching records.'
  } = opts;

  let all = [];
  const state = { q: '', filters: {} };

  // --- Toolbar ---
  const toolbar = document.createElement('div');
  toolbar.className = 'list-toolbar';

  let searchInput = null;
  if (search) {
    searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.placeholder = search.placeholder || 'Search…';
    searchInput.addEventListener('input', () => { state.q = searchInput.value.trim().toLowerCase(); render(); });
    toolbar.appendChild(searchInput);
  }

  for (const f of filters) {
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', f.label);
    const optAll = document.createElement('option');
    optAll.value = '';
    optAll.textContent = f.label + ': All';
    sel.appendChild(optAll);
    for (const o of f.options) {
      const el = document.createElement('option');
      el.value = o.value;
      el.textContent = o.label;
      sel.appendChild(el);
    }
    sel.addEventListener('change', () => { state.filters[f.id] = sel.value; render(); });
    toolbar.appendChild(sel);
  }

  const spacer = document.createElement('div');
  spacer.className = 'toolbar-spacer';
  toolbar.appendChild(spacer);

  const countEl = document.createElement('span');
  countEl.className = 'muted';
  toolbar.appendChild(countEl);

  const exportBtn = document.createElement('button');
  exportBtn.className = 'btn btn-sm';
  exportBtn.textContent = '⬇ Export visible to CSV';
  exportBtn.addEventListener('click', exportVisible);
  toolbar.appendChild(exportBtn);

  const tableWrap = document.createElement('div');
  tableWrap.style.overflowX = 'auto';

  mount.innerHTML = '';
  mount.appendChild(toolbar);
  mount.appendChild(tableWrap);

  function visibleRecords() {
    return all.filter((r) => {
      if (state.q && search?.text && !search.text(r).toLowerCase().includes(state.q)) return false;
      for (const f of filters) {
        const v = state.filters[f.id];
        if (v && !f.match(r, v)) return false;
      }
      return true;
    });
  }

  function cellHtml(c, r) {
    const v = c.value(r);
    if (c.badge && v) return badgeHtml(c.badge, v);
    return v ? esc(v) : '<span class="faint">—</span>';
  }

  function render() {
    const rows = visibleRecords();
    countEl.textContent = `${rows.length} of ${all.length}`;
    exportBtn.disabled = rows.length === 0;
    if (!rows.length) {
      tableWrap.innerHTML = `<div class="card empty-state">${esc(emptyText)}</div>`;
      return;
    }
    const head = columns.map((c) => `<th>${esc(c.header)}</th>`).join('');
    const body = rows.map((r, i) => {
      const cells = columns.map((c) => `<td class="${c.className || ''}">${cellHtml(c, r)}</td>`).join('');
      return `<tr class="${onRowClick ? 'clickable' : ''}" data-idx="${i}">${cells}</tr>`;
    }).join('');
    tableWrap.innerHTML = `<table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;

    if (onRowClick) {
      tableWrap.querySelectorAll('tbody tr').forEach((tr) => {
        tr.addEventListener('click', () => onRowClick(rows[Number(tr.dataset.idx)]));
      });
    }
  }

  function exportVisible() {
    const rows = visibleRecords();
    const data = rows.map((r) => {
      const o = {};
      for (const c of columns) o[c.header] = c.csv ? c.csv(r) : c.value(r);
      return o;
    });
    const csv = Papa.unparse({ fields: columns.map((c) => c.header), data });
    downloadCsv(csvFilename, csv);
  }

  async function refresh() {
    all = await load();
    render();
  }

  refresh();
  return { refresh, get records() { return all; } };
}
