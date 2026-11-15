// importView.js — the shared CSV-import screen (Build Brief B2). One component
// drives both the Dog and Contact importers; only the `entity` differs. Flow:
//   choose file → parse → DRY-RUN preview (create / update / needs-review, with a
//   per-row decision control) → commit. Nothing is written until Commit.
//
// "Needs review" rows (keyless/partial-key or unresolved references — Data Model
// §8) default to Skip; the user may explicitly create a new record or point the
// row at an existing one, exactly as the spec requires.
import { parseCsv, buildPlan, commitPlan, getMapping } from '../data/csvImport.js';
import { esc, fmtDate } from './ui.js';
import { importHelpHtml, wireImportHelp } from './importHelp.js';

const STATUS_BADGE = {
  create: 'badge-green',
  update: 'badge-blue',
  review: 'badge-amber'
};

// The several-file import (pages/import-batch.js) passes `rows` already parsed
// (with `fileName`) and `onNext(result | null)`: the file picker is replaced by
// the file's name, Cancel becomes "Skip this file" (onNext(null)), and the
// finished screen offers Next instead of the list link.
export function createImportView({ mount, entity, listHref, listLabel, rows = null, fileName = '', onNext = null }) {
  const mapping = getMapping(entity);
  let plan = null;      // array of classified rows (decisions are mutated in place)
  let existing = [];    // existing records, for the "match to existing" picker

  const fileCard = rows
    ? `<h2 style="margin-top:0;">1 · ${esc(mapping.label)} from <span class="mono">${esc(fileName)}</span></h2>
      <p class="muted">${rows.length} row${rows.length === 1 ? '' : 's'}.</p>`
    : `<h2 style="margin-top:0;">1 · Choose a CSV file</h2>
      <input type="file" id="imp-file" accept=".csv,text/csv">`;
  const cancel = onNext
    ? '<button class="btn" id="imp-skip-file">Skip this file</button>'
    : `<a class="btn" href="${esc(listHref)}">Cancel</a>`;

  mount.innerHTML = `
    <section class="card">
      ${fileCard}
      ${importHelpHtml(entity)}
    </section>
    <div id="imp-msg"></div>
    <section class="card" id="imp-preview-card" style="display:none; margin-top:16px;">
      <div class="row-between">
        <h2 style="margin:0;">2 · Preview (dry run)</h2>
        <div class="pill-row" id="imp-summary"></div>
      </div>
      <p class="muted">Nothing is saved yet. Review each row's action, then commit.</p>
      <div id="imp-table" style="overflow-x:auto;"></div>
      <div class="form-actions">
        <button class="btn btn-primary" id="imp-commit">Commit import</button>
        ${cancel}
      </div>
    </section>
    <section class="card" id="imp-result-card" style="display:none; margin-top:16px;">
      <h2 style="margin-top:0;">Import complete</h2>
      <div id="imp-result"></div>
    </section>`;

  wireImportHelp(mount, entity);
  const fileInput = mount.querySelector('#imp-file');
  const msg = mount.querySelector('#imp-msg');
  const previewCard = mount.querySelector('#imp-preview-card');
  const summaryEl = mount.querySelector('#imp-summary');
  const tableEl = mount.querySelector('#imp-table');
  const resultCard = mount.querySelector('#imp-result-card');
  const resultEl = mount.querySelector('#imp-result');
  const commitBtn = mount.querySelector('#imp-commit');

  function flash(text, kind = 'ok') {
    msg.innerHTML = `<div class="${kind === 'ok' ? 'inline-warn' : 'inline-error'}"${kind === 'ok' ? ' style="color:var(--accent-dark);background:var(--accent-soft);border-color:#bfe0cd;"' : ''}>${esc(text)}</div>`;
  }
  function clearFlash() { msg.innerHTML = ''; }

  let lastRows = null;
  let dates = null;
  async function loadRows(dataRows, { dateOrder = null } = {}) {
    if (!dataRows.length) { flash('That file has no data rows.', 'err'); return; }
    lastRows = dataRows;
    const built = await buildPlan(entity, dataRows, { dateOrder });
    plan = built.rows;
    existing = built.existing;
    dates = { ...built.dates, chosen: dateOrder };
    renderPreview(built.summary);
  }

  if (rows) {
    loadRows(rows).catch((e) => flash(e.message || String(e), 'err'));
    mount.querySelector('#imp-skip-file')?.addEventListener('click', () => onNext(null));
  } else {
    fileInput.addEventListener('change', async () => {
      clearFlash();
      resultCard.style.display = 'none';
      previewCard.style.display = 'none';
      plan = null;
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        await loadRows((await parseCsv(file)).rows);
      } catch (e) {
        flash(e.message || String(e), 'err');
      }
    });
  }

  function renderSummary() {
    const s = { create: 0, update: 0, skip: 0 };
    for (const r of plan) {
      if (r.decision === 'create') s.create++;
      else if (r.decision === 'update') s.update++;
      else s.skip++;
    }
    summaryEl.innerHTML =
      `<span class="badge badge-green">${s.create} create</span>` +
      `<span class="badge badge-blue">${s.update} update</span>` +
      `<span class="badge badge-gray">${s.skip} skip</span>`;
  }

  // Options list of existing records, for the review-row "match to existing" picker.
  function existingOptions(selectedId) {
    return `<option value="">— pick a record —</option>` + existing
      .map((r) => `<option value="${esc(r.id)}"${r.id === selectedId ? ' selected' : ''}>${esc(mapping.describe(r))}</option>`)
      .join('');
  }

  function actionCell(r) {
    // Auto-classified create/update rows: proceed or skip.
    if (r.status === 'create') {
      return `<select data-role="action" data-idx="${r.index}">
        <option value="create"${r.decision === 'create' ? ' selected' : ''}>Create new</option>
        <option value="skip"${r.decision === 'skip' ? ' selected' : ''}>Skip</option>
      </select>`;
    }
    if (r.status === 'update') {
      return `<select data-role="action" data-idx="${r.index}">
        <option value="update"${r.decision === 'update' ? ' selected' : ''}>Update match</option>
        <option value="skip"${r.decision === 'skip' ? ' selected' : ''}>Skip</option>
      </select>`;
    }
    // Review rows: skip by default, or explicitly create / match to an existing record.
    const matching = r.decision === 'update';
    return `<select data-role="action" data-idx="${r.index}">
        <option value="skip"${r.decision === 'skip' ? ' selected' : ''}>Skip</option>
        <option value="create"${r.decision === 'create' ? ' selected' : ''}>Create new</option>
        <option value="match"${matching ? ' selected' : ''}>Match existing…</option>
      </select>
      <select data-role="target" data-idx="${r.index}" style="margin-top:6px;${matching ? '' : 'display:none;'}">${existingOptions(r.decisionTarget)}</select>`;
  }

  // What an update changes, field by field (K2-4): "Status: Active breeding → Retired".
  // More than three fold behind a count. Ids read as "changed", never as an id.
  const shown = (v) => (v == null || v === '' || (Array.isArray(v) && !v.length) ? 'blank'
    : Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' ? x.number || x.abbreviation || x.title || JSON.stringify(x) : x)).join(', ')
      : typeof v === 'object' ? JSON.stringify(v) : /^[a-z]+(_[a-z]+)+$/.test(String(v)) ? String(v).replace(/_/g, ' ') : String(v));
  function changeLines(r) {
    const before = r.match || {};
    const out = [];
    for (const [k, v] of Object.entries(r.changes || {})) {
      if (JSON.stringify(before[k] ?? null) === JSON.stringify(v ?? null)) continue;
      const label = k.replace(/_ids?$/, '').replace(/_/g, ' ');
      out.push(/_ids?$/.test(k) ? `${label}: changed` : `${label}: ${shown(before[k])} → ${shown(v)}`);
    }
    return out;
  }
  // The dates as read (K2-3), so a day/month mix-up shows before anything is saved.
  const datesRead = (r) => Object.entries(r.record || {})
    .filter(([k, v]) => /date|_on$/.test(k) && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v))
    .map(([k, v]) => `${k.replace(/_/g, ' ')} ${fmtDate(v)}`).join(' · ');

  function noteCell(r) {
    if (r.status === 'update' && r.matchLabel) {
      const lines = changeLines(r);
      const what = !lines.length ? ' · nothing changes'
        : lines.length <= 3 ? `<br>${lines.map(esc).join('<br>')}`
          : `<details><summary>${lines.length} changes</summary>${lines.map(esc).join('<br>')}</details>`;
      return `<span class="muted">Matches existing: <strong>${esc(r.matchLabel)}</strong>${what}</span>`;
    }
    if (r.reasons.length) {
      return `<span class="muted">${r.reasons.map(esc).join('<br>')}</span>`;
    }
    return '<span class="faint">—</span>';
  }

  function renderPreview(_summary) {
    const body = plan.map((r) => `
      <tr class="${r.status === 'review' ? 'row-review' : ''}">
        <td class="faint">${r.index + 2}</td>
        <td><strong>${esc(r.display)}</strong>${datesRead(r) ? `<br><span class="faint">${esc(datesRead(r))}</span>` : ''}</td>
        <td><span class="badge ${STATUS_BADGE[r.status]}">${r.status === 'review' ? 'needs review' : r.status}</span></td>
        <td>${actionCell(r)}</td>
        <td>${noteCell(r)}</td>
      </tr>`).join('');

    // Dates that could be either way round: say how they're read, and let her flip it.
    const datesNote = dates && (dates.ask || dates.chosen) ? `
      <div class="inline-warn" style="margin-bottom:10px;">Some dates in this file could be read either way round (like 05/01/2021).
        <label style="display:inline-flex; gap:6px; align-items:center; margin-left:4px;">They're
          <select id="imp-date-order"><option value="mdy"${dates.order === 'mdy' ? ' selected' : ''}>month first (May 1)</option><option value="dmy"${dates.order === 'dmy' ? ' selected' : ''}>day first (5 January)</option></select></label>
        Check a row's dates below before you commit.</div>`
      : dates?.detected === 'dmy' ? '<p class="field-hint" style="margin-top:0;">Dates are read day first, as this file writes them (it has a date like 25/01/2021).</p>'
        : dates?.detected === 'mixed' ? '<div class="inline-warn" style="margin-bottom:10px;">This file writes dates both ways round (25/01/2021 and 01/25/2021), so a date that could be either is left for review.</div>' : '';
    tableEl.innerHTML = `${datesNote}
      <table class="data">
        <thead><tr><th>Row</th><th>${esc(mapping.entity.charAt(0).toUpperCase() + mapping.entity.slice(1))}</th><th>Classified</th><th>Action</th><th>Notes</th></tr></thead>
        <tbody>${body}</tbody>
      </table>`;

    // Wire the per-row controls to mutate decisions in place.
    tableEl.querySelectorAll('[data-role="action"]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const r = plan.find((p) => p.index === Number(sel.dataset.idx));
        const target = tableEl.querySelector(`[data-role="target"][data-idx="${sel.dataset.idx}"]`);
        if (sel.value === 'match') {
          r.decision = 'update';
          if (target) { target.style.display = ''; r.decisionTarget = target.value || null; }
        } else {
          r.decision = sel.value; // 'create' | 'update' | 'skip'
          if (target) target.style.display = 'none';
        }
        renderSummary();
      });
    });
    tableEl.querySelectorAll('[data-role="target"]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const r = plan.find((p) => p.index === Number(sel.dataset.idx));
        r.decisionTarget = sel.value || null;
      });
    });

    tableEl.querySelector('#imp-date-order')?.addEventListener('change', (e) => {
      loadRows(lastRows, { dateOrder: e.target.value }).catch((err) => flash(err.message || String(err), 'err'));
    });

    previewCard.style.display = '';
    renderSummary();
  }

  commitBtn.addEventListener('click', async () => {
    if (!plan) return;
    // Guard: a "match existing" row with no target chosen is ambiguous.
    const missingTarget = plan.find((r) => r.decision === 'update' && !(r.decisionTarget || r.match?.id));
    if (missingTarget) {
      flash(`Row ${missingTarget.index + 2} ("${missingTarget.display}") is set to match an existing record but none is picked.`, 'err');
      return;
    }
    commitBtn.disabled = true;
    try {
      const res = await commitPlan(entity, plan);
      previewCard.style.display = 'none';
      const failed = res.failed.length
        ? `<div class="inline-error" style="margin-top:10px;"><strong>${res.failed.length} row(s) failed:</strong><br>${res.failed.map((f) => `Row ${f.index + 2} (${esc(f.display)}): ${esc(f.message)}`).join('<br>')}</div>`
        : '';
      const notes = res.notes?.length
        ? `<div class="muted" style="margin-top:10px;"><strong>${res.notes.length} note(s):</strong><br>${res.notes.map((f) => `Row ${f.index + 2} (${esc(f.display)}): ${esc(f.message)}`).join('<br>')}</div>`
        : '';
      resultEl.innerHTML = `
        <p><strong>${res.created}</strong> created · <strong>${res.updated}</strong> updated · <strong>${res.skipped}</strong> skipped.</p>
        ${failed}
        ${notes}
        <div class="form-actions">${onNext
          ? '<button class="btn btn-primary" id="imp-next">Next →</button>'
          : `<a class="btn btn-primary" href="${esc(listHref)}">Go to ${esc(listLabel)}</a>`}</div>`;
      if (onNext) resultEl.querySelector('#imp-next').addEventListener('click', () => onNext(res));
      resultCard.style.display = '';
      resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
      flash(e.message || String(e), 'err');
    } finally {
      commitBtn.disabled = false;
    }
  });
}
