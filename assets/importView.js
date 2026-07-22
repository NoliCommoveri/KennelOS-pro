// importView.js — the shared CSV-import screen (Build Brief B2). One component
// drives both the Dog and Contact importers; only the `entity` differs. Flow:
//   choose file → parse → DRY-RUN preview (create / update / needs-review, with a
//   per-row decision control) → commit. Nothing is written until Commit.
//
// "Needs review" rows (keyless/partial-key or unresolved references — Data Model
// §8) default to Skip; the user may explicitly create a new record or point the
// row at an existing one, exactly as the spec requires.
import { parseCsv, buildPlan, commitPlan, getMapping } from '../data/csvImport.js';
import { esc } from './ui.js';

const STATUS_BADGE = {
  create: 'badge-green',
  update: 'badge-blue',
  review: 'badge-amber'
};

export function createImportView({ mount, entity, listHref, listLabel }) {
  const mapping = getMapping(entity);
  let plan = null;      // array of classified rows (decisions are mutated in place)
  let existing = [];    // existing records, for the "match to existing" picker

  mount.innerHTML = `
    <section class="card">
      <h2 style="margin-top:0;">1 · Choose a CSV file</h2>
      <p class="muted">Recognized columns (extra columns are ignored, missing ones are fine):</p>
      <p class="mono" style="font-size:12px; background:var(--surface-2); padding:8px 10px; border-radius:var(--radius-sm); overflow-x:auto;">${esc(mapping.templateHeaders.join(', '))}</p>
      <input type="file" id="imp-file" accept=".csv,text/csv">
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
        <a class="btn" href="${esc(listHref)}">Cancel</a>
      </div>
    </section>
    <section class="card" id="imp-result-card" style="display:none; margin-top:16px;">
      <h2 style="margin-top:0;">Import complete</h2>
      <div id="imp-result"></div>
    </section>`;

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

  fileInput.addEventListener('change', async () => {
    clearFlash();
    resultCard.style.display = 'none';
    previewCard.style.display = 'none';
    plan = null;
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const parsed = await parseCsv(file);
      if (!parsed.rows.length) { flash('That file has no data rows.', 'err'); return; }
      const built = await buildPlan(entity, parsed.rows);
      plan = built.rows;
      existing = built.existing;
      renderPreview(built.summary);
    } catch (e) {
      flash(e.message || String(e), 'err');
    }
  });

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

  function noteCell(r) {
    if (r.status === 'update' && r.matchLabel) {
      return `<span class="muted">Matches existing: <strong>${esc(r.matchLabel)}</strong></span>`;
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
        <td><strong>${esc(r.display)}</strong></td>
        <td><span class="badge ${STATUS_BADGE[r.status]}">${r.status === 'review' ? 'needs review' : r.status}</span></td>
        <td>${actionCell(r)}</td>
        <td>${noteCell(r)}</td>
      </tr>`).join('');

    tableEl.innerHTML = `
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
      resultEl.innerHTML = `
        <p><strong>${res.created}</strong> created · <strong>${res.updated}</strong> updated · <strong>${res.skipped}</strong> skipped.</p>
        ${failed}
        <div class="form-actions"><a class="btn btn-primary" href="${esc(listHref)}">Go to ${esc(listLabel)}</a></div>`;
      resultCard.style.display = '';
      resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
      flash(e.message || String(e), 'err');
    } finally {
      commitBtn.disabled = false;
    }
  });
}
