// expense-import.js — the Expense CSV importer's review screen.
//
// Unlike the other importers (which use the shared assets/importView.js), an
// expense is POLYMORPHIC: every row must attach to a subject (a dog / litter /
// pairing / kennel). This screen therefore reuses the shared parse + dry-run
// engine (parseCsv → buildPlan('expense', …)) for all the field parsing,
// match-or-create classification, and idempotent receipt-number keying, but
// renders its own table so each row gets an editable **"Attach to"** control —
// a subject-type dropdown + a subject picker, prefilled from whatever the CSV
// resolved (by kennel/dog name), and freely reassignable before commit. That's
// how a receipt tagged "kennel overhead" gets pointed at a specific litter, or
// an unresolved subject gets chosen by hand.
import { parseCsv, buildPlan } from '../data/csvImport.js';
import { expenseRepo } from '../data/expenseRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { pairingRepo } from '../data/pairingRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { EXPENSE_CATEGORIES, EXPENSE_SUBJECT_TYPES } from '../data/vocab.js';
import { esc, badge, fmtDate, fmtMoney } from '../assets/ui.js';

const mount = document.getElementById('import-root');
let plan = null;          // classified rows from buildPlan
let subjects = null;      // { dog:[{id,label}], litter:[…], pairing:[…], kennel:[…] }

const catLabel = (v) => EXPENSE_CATEGORIES.find((c) => c.value === v)?.label || v || 'Other';

// Build the per-type option lists once, with readable labels.
async function loadSubjects() {
  const [dogs, litters, pairings, kennels] = await Promise.all([
    dogRepo.getAll({ includeArchived: false }),
    litterRepo.getAll({ includeArchived: false }),
    pairingRepo.getAll({ includeArchived: false }),
    kennelRepo.getAll({ includeArchived: false })
  ]);
  const dogName = new Map(dogs.map((d) => [d.id, d.call_name || d.registered_name || 'dog']));
  const pairLabel = (p) => `${dogName.get(p.sire_id) || '?'} × ${dogName.get(p.dam_id) || '?'}${p.planned_date ? ` (${p.planned_date})` : ''}`;
  const litLabel = (l) => l.nickname || `${dogName.get(l.dam_id) || '?'} × ${dogName.get(l.sire_id) || '?'}${l.whelp_date ? ` (${l.whelp_date})` : ''}`;
  return {
    dog: dogs.map((d) => ({ id: d.id, label: (d.call_name || d.registered_name || 'dog') + (d.date_of_birth ? ` — ${d.date_of_birth}` : '') })).sort(byLabel),
    litter: litters.map((l) => ({ id: l.id, label: litLabel(l) })).sort(byLabel),
    pairing: pairings.map((p) => ({ id: p.id, label: pairLabel(p) })).sort(byLabel),
    kennel: kennels.map((k) => ({ id: k.id, label: k.kennel_name + (k.is_own_kennel ? ' (own)' : '') })).sort(byLabel)
  };
}
function byLabel(a, b) { return a.label.localeCompare(b.label); }

function subjectTypeSelect(idx, selected) {
  return `<select data-role="subtype" data-idx="${idx}">` + EXPENSE_SUBJECT_TYPES
    .map((s) => `<option value="${esc(s.value)}"${s.value === selected ? ' selected' : ''}>${esc(s.label)}</option>`).join('') + `</select>`;
}
function subjectSelect(idx, type, selectedId) {
  const opts = (subjects[type] || []);
  return `<select data-role="subid" data-idx="${idx}" style="margin-top:6px; max-width:100%;">` +
    `<option value="">— choose ${esc(type)} —</option>` +
    opts.map((o) => `<option value="${esc(o.id)}"${o.id === selectedId ? ' selected' : ''}>${esc(o.label)}</option>`).join('') +
    `</select>`;
}

function actionSelect(r) {
  const canUpdate = !!r.match;
  return `<select data-role="action" data-idx="${r.index}">
    <option value="create"${r.decision === 'create' ? ' selected' : ''}>Create new</option>
    ${canUpdate ? `<option value="update"${r.decision === 'update' ? ' selected' : ''}>Update match</option>` : ''}
    <option value="skip"${r.decision === 'skip' ? ' selected' : ''}>Skip</option>
  </select>`;
}

function rowSummary(r) {
  const rec = r.record;
  const amt = rec.miles != null ? fmtMoney((rec.miles || 0) * (rec.mileage_rate || 0)) : fmtMoney(rec.amount);
  const bits = [
    badge(EXPENSE_CATEGORIES, rec.category || 'other'),
    `<strong>${esc(amt)}</strong>`,
    rec.expense_date ? `<span class="faint">${esc(fmtDate(rec.expense_date))}</span>` : '',
    rec.miles != null ? `<span class="muted">${esc(rec.miles)} mi</span>` : '',
    rec.vendor ? esc(rec.vendor) : '',
    rec.receipt_number ? `<span class="badge badge-gray">${esc(rec.receipt_number)}</span>` : ''
  ].filter(Boolean).join(' ');
  return bits;
}

function render() {
  const body = plan.map((r) => {
    const type = r.record.subject_type || 'kennel';
    return `<tr class="${r.decision === 'skip' ? 'row-review' : ''}">
      <td class="faint">${r.index + 2}</td>
      <td>${rowSummary(r)}${r.reasons.length ? `<div class="muted" style="font-size:13px; margin-top:4px;">${r.reasons.map(esc).join('<br>')}</div>` : ''}</td>
      <td>${subjectTypeSelect(r.index, type)}<br>${subjectSelect(r.index, type, r.record.subject_id)}</td>
      <td>${actionSelect(r)}</td>
    </tr>`;
  }).join('');

  mount.querySelector('#imp-table').innerHTML = `
    <table class="data">
      <thead><tr><th>Row</th><th>Expense</th><th>Attach to</th><th>Action</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;

  // Wire controls.
  mount.querySelectorAll('[data-role="subtype"]').forEach((sel) => sel.addEventListener('change', () => {
    const r = plan.find((p) => p.index === Number(sel.dataset.idx));
    r.record.subject_type = sel.value;
    r.record.subject_id = ''; // reset — a new type needs a fresh pick
    render();
  }));
  mount.querySelectorAll('[data-role="subid"]').forEach((sel) => sel.addEventListener('change', () => {
    const r = plan.find((p) => p.index === Number(sel.dataset.idx));
    r.record.subject_id = sel.value || '';
  }));
  mount.querySelectorAll('[data-role="action"]').forEach((sel) => sel.addEventListener('change', () => {
    const r = plan.find((p) => p.index === Number(sel.dataset.idx));
    r.decision = sel.value;
    renderSummary();
  }));
  renderSummary();
  mount.querySelector('#imp-preview-card').style.display = '';
}

function renderSummary() {
  const s = { create: 0, update: 0, skip: 0 };
  for (const r of plan) s[r.decision] = (s[r.decision] || 0) + 1;
  mount.querySelector('#imp-summary').innerHTML =
    `<span class="badge badge-green">${s.create} create</span>` +
    `<span class="badge badge-blue">${s.update} update</span>` +
    `<span class="badge badge-gray">${s.skip} skip</span>`;
}

function flash(text, kind) {
  mount.querySelector('#imp-msg').innerHTML = `<div class="${kind === 'err' ? 'inline-error' : 'inline-warn'}">${esc(text)}</div>`;
}

async function commit() {
  const btn = mount.querySelector('#imp-commit');
  // Guard: a create/update row must have a chosen subject.
  const bad = plan.find((r) => r.decision !== 'skip' && !r.record.subject_id);
  if (bad) { flash(`Row ${bad.index + 2} has no subject chosen under "Attach to".`, 'err'); return; }
  btn.disabled = true;
  const res = { created: 0, updated: 0, skipped: 0, failed: [] };
  for (const r of plan) {
    try {
      if (r.decision === 'skip') { res.skipped++; continue; }
      const payload = { ...r.record }; // parsed fields + chosen subject_type/subject_id
      if (r.decision === 'update') {
        const id = r.decisionTarget || r.match?.id;
        if (!id) throw new Error('No matched expense to update.');
        await expenseRepo.update(id, payload);
        res.updated++;
      } else {
        await expenseRepo.create(payload);
        res.created++;
      }
    } catch (e) {
      res.failed.push({ index: r.index, message: e.message || String(e) });
    }
  }
  mount.querySelector('#imp-preview-card').style.display = 'none';
  const failed = res.failed.length
    ? `<div class="inline-error" style="margin-top:10px;"><strong>${res.failed.length} row(s) failed:</strong><br>${res.failed.map((f) => `Row ${f.index + 2}: ${esc(f.message)}`).join('<br>')}</div>`
    : '';
  mount.querySelector('#imp-result').innerHTML = `
    <p><strong>${res.created}</strong> created · <strong>${res.updated}</strong> updated · <strong>${res.skipped}</strong> skipped.</p>
    ${failed}
    <div class="form-actions"><a class="btn btn-primary" href="financials.html?view=expenses">Go to Financials</a></div>`;
  mount.querySelector('#imp-result-card').style.display = '';
}

mount.innerHTML = `
  <section class="card">
    <h2 style="margin-top:0;">1 · Choose a CSV file</h2>
    <p class="muted">Recognized columns (extra columns ignored, missing ones fine):</p>
    <p class="mono" style="font-size:12px; background:var(--surface-2); padding:8px 10px; border-radius:var(--radius-sm); overflow-x:auto;">subject_type, subject_name, expense_date, amount, category, vendor, miles, mileage_rate, receipt_number, notes</p>
    <input type="file" id="imp-file" accept=".csv,text/csv">
  </section>
  <div id="imp-msg"></div>
  <section class="card" id="imp-preview-card" style="display:none; margin-top:16px;">
    <div class="row-between">
      <h2 style="margin:0;">2 · Review &amp; attach</h2>
      <div class="pill-row" id="imp-summary"></div>
    </div>
    <p class="muted">Nothing is saved yet. Set where each expense attaches, adjust the action, then commit.</p>
    <div id="imp-table" style="overflow-x:auto;"></div>
    <div class="form-actions">
      <button class="btn btn-primary" id="imp-commit">Commit import</button>
      <a class="btn" href="financials.html?view=expenses">Cancel</a>
    </div>
  </section>
  <section class="card" id="imp-result-card" style="display:none; margin-top:16px;">
    <h2 style="margin-top:0;">Import complete</h2>
    <div id="imp-result"></div>
  </section>`;

mount.querySelector('#imp-file').addEventListener('change', async (ev) => {
  mount.querySelector('#imp-msg').innerHTML = '';
  mount.querySelector('#imp-result-card').style.display = 'none';
  mount.querySelector('#imp-preview-card').style.display = 'none';
  const file = ev.target.files?.[0];
  if (!file) return;
  try {
    const parsed = await parseCsv(file);
    if (!parsed.rows.length) { flash('That file has no data rows.', 'err'); return; }
    [subjects, plan] = await Promise.all([loadSubjects(), buildPlan('expense', parsed.rows).then((p) => p.rows)]);
    render();
  } catch (e) {
    flash(e.message || String(e), 'err');
  }
});

mount.querySelector('#imp-commit').addEventListener('click', commit);
