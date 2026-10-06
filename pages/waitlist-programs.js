// waitlist-programs.js — her waitlist programs for one kennel (Waitlist Spec
// §4.4/§7; End-State guide §29): named bundles of adjustments (fee override,
// `ahead` priority, pause allowance, passes not counted, a longer response
// window). List + an inline add/edit form. Pro-only page (proPages.js).
import { waitlistProgramRepo, ReferenceBlockedError } from '../data/waitlistProgramRepo.js';
import { waitlistEntryRepo } from '../data/waitlistEntryRepo.js';
import { WAITLIST_PRIORITY } from '../data/vocab.js';
import { waitlistConfig } from '../data/waitlistRules.js';
import { esc, badge, fmtMoney, param, confirmModal } from '../assets/ui.js';
import { resolveWaitlistKennel, mountKennelPicker } from '../assets/waitlistUI.js';

const els = {
  back: document.getElementById('back-link'),
  picker: document.getElementById('prog-kennel-picker'),
  form: document.getElementById('prog-form'),
  list: document.getElementById('prog-list'),
  error: document.getElementById('page-error'),
  newBtn: document.getElementById('btn-new-program')
};

const ctx = { kennel: null, config: null, programs: [], counts: new Map(), editing: null };
const none = '<span class="faint">—</span>';
const showError = (msg) => { els.error.innerHTML = `<div class="inline-error">${esc(msg)}</div>`; };
const clearError = () => { els.error.innerHTML = ''; };

function feeLabel(p) {
  if (p.fee_override == null || p.fee_override === '') return 'Normal fee';
  return Number(p.fee_override) === 0 ? 'Waived' : fmtMoney(p.fee_override);
}

function adjustments(p) {
  const out = [];
  if (p.priority === 'ahead') out.push(badge(WAITLIST_PRIORITY, 'ahead'));
  out.push(esc(feeLabel(p)));
  if (p.passes_count === false) out.push('Passes don\'t count');
  if (p.pause_allowed) out.push('May pause');
  if (p.respond_days_override) out.push(`${esc(p.respond_days_override)} days to respond`);
  return out.join(' · ');
}

async function load() {
  const [programs, entries] = await Promise.all([
    waitlistProgramRepo.getByKennel(ctx.kennel.id, { includeArchived: true }),
    waitlistEntryRepo.getByKennel(ctx.kennel.id, { includeArchived: true })
  ]);
  ctx.programs = programs.sort((a, b) => Number(a.is_archived) - Number(b.is_archived) || a.name.localeCompare(b.name));
  ctx.counts = new Map();
  for (const e of entries) {
    if (e.waitlist_program_id) ctx.counts.set(e.waitlist_program_id, (ctx.counts.get(e.waitlist_program_id) || 0) + 1);
  }
}

function renderList() {
  if (!ctx.programs.length) {
    els.list.innerHTML = '<div class="empty-state">No programs yet. Add one for families you treat differently, e.g. a family in cancer treatment, a veteran, or a returning family.</div>';
    return;
  }
  els.list.innerHTML = `<section class="card"><table class="data"><thead><tr><th>Program</th><th>What it changes</th><th>Families</th><th></th></tr></thead><tbody>${
    ctx.programs.map((p) => `<tr>
      <td><strong>${esc(p.name)}</strong>${p.is_archived ? ' <span class="badge badge-gray">Archived</span>' : ''}</td>
      <td>${adjustments(p)}</td>
      <td>${ctx.counts.get(p.id) || none}</td>
      <td class="pill-row"><button class="btn btn-sm" data-edit="${esc(p.id)}">Edit</button></td>
    </tr>`).join('')
  }</tbody></table></section>`;
  els.list.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    ctx.editing = ctx.programs.find((p) => p.id === b.dataset.edit);
    renderForm();
  }));
}

function renderForm() {
  const p = ctx.editing;
  if (!p) { els.form.innerHTML = ''; return; }
  const isNew = !p.id;
  const priorityOpts = WAITLIST_PRIORITY.map((o) => `<option value="${esc(o.value)}"${o.value === (p.priority || 'standard') ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
  els.form.innerHTML = `<section class="card" style="margin-bottom:16px;">
      <h2 style="margin-top:0;">${isNew ? 'New program' : `Edit “${esc(p.name)}”`}</h2>
      <div class="form-grid">
        <div class="field"><label>Name <span class="req">*</span></label><input id="p-name" type="text" value="${esc(p.name || '')}" placeholder="e.g. Cancer-treatment family"></div>
        <div class="field"><label>Place in line</label><select id="p-priority">${priorityOpts}</select>
          <span class="field-hint">Ahead: listed before standard families, still in fee-date order among themselves.</span></div>
        <div class="field"><label>Application fee</label><input id="p-fee" type="number" min="0" step="0.01" value="${esc(p.fee_override ?? '')}" placeholder="Normal fee${ctx.config.fee_amount != null ? ` (${fmtMoney(ctx.config.fee_amount)})` : ''}">
          <span class="field-hint">Blank = your normal fee. 0 = waived (they join the list as soon as you approve them).</span></div>
        <div class="field"><label>Days to respond to an offer</label><input id="p-respond" type="number" min="1" step="1" value="${esc(p.respond_days_override ?? '')}" placeholder="Normal (${esc(ctx.config.respond_days)})"></div>
        <div class="field field-wide">
          <label class="check-inline"><input id="p-passes" type="checkbox"${p.passes_count === false ? ' checked' : ''}> Passes by these families don't count toward removal</label>
          <label class="check-inline"><input id="p-pause" type="checkbox"${p.pause_allowed ? ' checked' : ''}> These families may pause without it counting against them</label>
        </div>
        <div class="field field-wide"><label>Description for families</label><textarea id="p-public">${esc(p.public_description || '')}</textarea>
          <span class="field-hint">Shown to families only if you fill it in. Leave blank to keep the program private.</span></div>
        <div class="field field-wide"><label>Private notes</label><textarea id="p-notes">${esc(p.notes || '')}</textarea></div>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary btn-sm" id="p-save">Save</button>
        <button class="btn btn-sm" id="p-cancel">Cancel</button>
        ${isNew ? '' : `<button class="btn btn-sm" id="p-archive">${p.is_archived ? 'Unarchive' : 'Archive'}</button>
        <button class="btn btn-danger btn-sm" id="p-delete">Delete</button>`}
      </div>
    </section>`;
  els.form.querySelector('#p-save').onclick = save;
  els.form.querySelector('#p-cancel').onclick = () => { ctx.editing = null; clearError(); renderForm(); };
  if (!isNew) {
    els.form.querySelector('#p-archive').onclick = toggleArchive;
    els.form.querySelector('#p-delete').onclick = doDelete;
  }
  els.form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function readForm() {
  const v = (id) => els.form.querySelector(id).value;
  const c = (id) => els.form.querySelector(id).checked;
  return {
    name: v('#p-name').trim(),
    priority: v('#p-priority'),
    fee_override: v('#p-fee') === '' ? null : Number(v('#p-fee')),
    respond_days_override: v('#p-respond') === '' ? null : Number(v('#p-respond')),
    passes_count: !c('#p-passes'),
    pause_allowed: c('#p-pause'),
    public_description: v('#p-public').trim(),
    notes: v('#p-notes')
  };
}

async function refresh() {
  await load();
  renderForm();
  renderList();
}

async function save() {
  clearError();
  try {
    const data = readForm();
    if (ctx.editing.id) await waitlistProgramRepo.update(ctx.editing.id, data);
    else await waitlistProgramRepo.create({ ...data, kennel_id: ctx.kennel.id });
    ctx.editing = null;
    await refresh();
  } catch (e) { showError(e.message || String(e)); }
}

async function toggleArchive() {
  const p = ctx.editing;
  const verb = p.is_archived ? 'Unarchive' : 'Archive';
  const message = p.is_archived ? '' : 'It stops being offered for new families. Families already in it keep its adjustments.';
  if (!(await confirmModal({ title: `${verb} “${p.name}”?`, message, confirmLabel: verb }))) return;
  try {
    if (p.is_archived) await waitlistProgramRepo.unarchive(p.id); else await waitlistProgramRepo.archive(p.id);
    ctx.editing = null;
    await refresh();
  } catch (e) { showError(e.message || String(e)); }
}

async function doDelete() {
  const p = ctx.editing;
  if (!(await confirmModal({ title: `Delete “${p.name}”?`, message: 'This cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
  try {
    await waitlistProgramRepo.hardDelete(p.id);
    ctx.editing = null;
    await refresh();
  } catch (e) {
    showError(e instanceof ReferenceBlockedError
      ? `“${p.name}” still has families in it. Archive it instead.`
      : e.message || String(e));
  }
}

async function main() {
  const resolved = await resolveWaitlistKennel(param('kennel'));
  if (!resolved.kennel) { showError('Set up your kennel first.'); return; }
  ctx.kennel = resolved.kennel;
  ctx.config = waitlistConfig(ctx.kennel);
  mountKennelPicker(els.picker, resolved);
  els.back.href = `waitlist.html?kennel=${encodeURIComponent(ctx.kennel.id)}`;
  els.newBtn.onclick = () => { ctx.editing = { priority: 'standard', passes_count: true }; clearError(); renderForm(); };
  await refresh();
}

main().catch((e) => showError(e.message || String(e)));
