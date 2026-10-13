// importHelp.js — the "What should my file look like?" guide on every CSV import
// screen: how rows are matched, one line per accepted column (needed or not,
// what goes in it, other header names that work, accepted values), the rules
// that hold for every import, and a blank template download. The words live in
// data/csvImportHelp.js; this only renders them.
import { importHelp, GENERAL_RULES, templateCsv } from '../data/csvImportHelp.js';
import { esc } from './ui.js';

const NEED_BADGE = { required: 'badge-red', new: 'badge-amber', optional: 'badge-gray' };

// Returns the guide's HTML. Call wireImportHelp(mount, entity) after inserting it.
export function importHelpHtml(entity) {
  const help = importHelp(entity);
  const rows = help.columns.map((c) => `
    <tr>
      <td class="mono" style="white-space:nowrap;">${esc(c.name)}</td>
      <td><span class="badge ${NEED_BADGE[c.need]}">${esc(c.needLabel)}</span></td>
      <td>${esc(c.text)}
        ${c.values ? `<div class="muted" style="font-size:13px; margin-top:4px;">Accepts: ${c.values.map(esc).join(' · ')}</div>` : ''}
        ${c.aliases.length ? `<div class="faint" style="font-size:12px; margin-top:2px;">Also read from a column named: ${c.aliases.map((a) => `<span class="mono">${esc(a)}</span>`).join(', ')}</div>` : ''}
      </td>
    </tr>`).join('');
  return `
    <details class="import-help" open style="margin:12px 0;">
      <summary style="cursor:pointer; font-weight:600;">What should my file look like?</summary>
      <p style="margin-top:10px;">${esc(help.match)}</p>
      <div style="overflow-x:auto;">
        <table class="data">
          <thead><tr><th>Column</th><th>Needed?</th><th>What goes in it</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${help.footnote ? `<p class="muted">${esc(help.footnote)}</p>` : ''}
      <p class="muted" style="margin-bottom:4px;"><span class="badge ${NEED_BADGE.required}">Required</span> a row without it can't be matched or created, so it's held for review.
        <span class="badge ${NEED_BADGE.new}">Required for new records</span> needed to add a new record; a row that updates an existing one can leave it blank.</p>
      <ul class="muted" style="font-size:13px;">${GENERAL_RULES.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      <button type="button" class="btn" data-role="import-template">Download a blank template</button>
    </details>`;
}

// Saves the blank template (header row only) for one importer.
export function downloadImportTemplate(entity) {
  const url = URL.createObjectURL(new Blob([templateCsv(entity)], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `kennelos-${entity.replace(/_/g, '-')}-import-template.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Wires the template download button inside `mount`.
export function wireImportHelp(mount, entity) {
  const btn = mount.querySelector('[data-role="import-template"]');
  if (btn) btn.addEventListener('click', () => downloadImportTemplate(entity));
}
