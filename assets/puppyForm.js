// puppyForm.js — the "Add Puppy" / "Add N Puppies" flow launched from Litter
// Detail (Stage 3 Brief §3). A puppy is NOT a separate entity — these create
// ordinary Dog records via dogRepo.create(), with the litter-derived fields
// (litter_id, dam_id, sire_id, breed, date_of_birth, status:puppy,
// ownership_type:owned) pre-filled. call_name and sex are the only per-puppy
// fields required (Dog's "required to save" list); disposition and intended
// registration are offered too (applied to all on the bulk form). Everything
// else is edited later on Dog Detail.
import { dogRepo } from '../data/dogRepo.js';
import { baseFromLitter } from '../data/puppyDefaults.js';
import { SEX, DISPOSITION, REGISTRATION_TYPE } from '../data/vocab.js';
import { esc, fmtDate } from './ui.js';

function sexOptions(current) {
  return SEX.map((s) => `<option value="${esc(s.value)}"${s.value === current ? ' selected' : ''}>${esc(s.label)}</option>`).join('');
}

function dispositionOptions(current) {
  return DISPOSITION.map((d) => `<option value="${esc(d.value)}"${d.value === current ? ' selected' : ''}>${esc(d.label)}</option>`).join('');
}

// Intended registration (Dog.intended_registration); blank = not decided yet.
function registrationOptions(current) {
  return `<option value="">Not decided</option>` + REGISTRATION_TYPE.map((r) => `<option value="${esc(r.value)}"${r.value === current ? ' selected' : ''}>${esc(r.label)}</option>`).join('');
}

function modalShell(titleText) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true"></div>`;
  document.body.appendChild(overlay);
  const modal = overlay.querySelector('.modal');
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  return { overlay, modal, close };
}

// Single puppy: prompt call_name + sex, create, then call onSaved.
export function openAddPuppyForm({ litter, dam, onSaved }) {
  const base = baseFromLitter(litter, dam);
  const { modal, close } = modalShell();

  if (!base.breed) {
    // Dog requires a breed; the dam should always have one. Guard just in case.
    modal.innerHTML = `
      <h2 style="margin-top:0;">Add puppy</h2>
      <div class="inline-error">This litter's dam has no breed recorded, so a puppy can't inherit one. Set the dam's breed first, or add the puppy from the Dogs page.</div>
      <div class="form-actions"><button class="btn" data-act="cancel">Close</button></div>`;
    modal.querySelector('[data-act="cancel"]').addEventListener('click', close);
    return;
  }

  modal.innerHTML = `
    <div class="row-between" style="margin-bottom:12px;">
      <h2 style="margin:0;">Add puppy</h2>
      <button class="btn btn-sm" data-act="cancel">✕</button>
    </div>
    <p class="muted" style="margin-top:0;">Litter parents, breed (${esc(base.breed)})${base.date_of_birth ? `, date of birth (${esc(fmtDate(base.date_of_birth))})` : ''}, status “puppy” and owned ownership are filled in automatically. You can edit any of it later on the puppy's own record.</p>
    <div class="form-grid">
      <div class="field"><label>Call name <span class="req">*</span></label>
        <input id="pf-call_name" type="text" placeholder="e.g. Green collar"></div>
      <div class="field"><label>Sex <span class="req">*</span></label>
        <select id="pf-sex">${sexOptions('unknown')}</select></div>
      <div class="field"><label>Disposition</label>
        <select id="pf-disposition">${dispositionOptions('undecided')}</select></div>
      <div class="field"><label>Registration</label>
        <select id="pf-registration">${registrationOptions('')}</select></div>
    </div>
    <div id="pf-error"></div>
    <div class="form-actions">
      <button class="btn btn-primary" data-act="save">Add puppy</button>
      <button class="btn btn-primary" data-act="save-open">Add &amp; open record</button>
      <button class="btn" data-act="cancel">Cancel</button>
    </div>`;

  modal.querySelectorAll('[data-act="cancel"]').forEach((b) => b.addEventListener('click', close));

  // Guards against a rapid double-tap/double-click (either button, or one
  // then the other) firing save() twice before the first call's await chain
  // has a chance to disable anything itself — each call would otherwise run
  // to completion independently, creating two puppy records from one tap.
  async function save(openAfter) {
    const btns = [modal.querySelector('[data-act="save"]'), modal.querySelector('[data-act="save-open"]')].filter(Boolean);
    if (btns.some((b) => b.disabled)) return;
    btns.forEach((b) => { b.disabled = true; });
    try {
      await doSave(openAfter);
    } finally {
      btns.forEach((b) => { b.disabled = false; });
    }
  }

  async function doSave(openAfter) {
    const call_name = modal.querySelector('#pf-call_name').value.trim();
    const sex = modal.querySelector('#pf-sex').value;
    const disposition = modal.querySelector('#pf-disposition').value;
    const intended_registration = modal.querySelector('#pf-registration').value || null;
    if (!call_name) {
      modal.querySelector('#pf-error').innerHTML = `<div class="inline-error">Call name is required.</div>`;
      return;
    }
    try {
      const puppy = await dogRepo.create({ ...base, call_name, sex, disposition, intended_registration });
      close();
      if (openAfter) { location.href = `dog.html?id=${encodeURIComponent(puppy.id)}`; return; }
      onSaved?.(puppy);
    } catch (e) {
      modal.querySelector('#pf-error').innerHTML = `<div class="inline-error">${esc(e.message || String(e))}</div>`;
    }
  }
  modal.querySelector('[data-act="save"]').addEventListener('click', () => save(false));
  modal.querySelector('[data-act="save-open"]').addEventListener('click', () => save(true));
  modal.querySelector('#pf-call_name').focus();
}

// Bulk: create placeholder puppies ("Puppy 1"…), so many males then so many
// females, each an ordinary, individually-editable Dog record afterward (Stage 3
// Brief §3). Disposition and intended registration apply to all of them.
export function openAddPuppiesForm({ litter, dam, existingCount = 0, onSaved }) {
  const base = baseFromLitter(litter, dam);
  const { modal, close } = modalShell();

  if (!base.breed) {
    modal.innerHTML = `
      <h2 style="margin-top:0;">Add puppies</h2>
      <div class="inline-error">This litter's dam has no breed recorded, so puppies can't inherit one. Set the dam's breed first.</div>
      <div class="form-actions"><button class="btn" data-act="cancel">Close</button></div>`;
    modal.querySelector('[data-act="cancel"]').addEventListener('click', close);
    return;
  }

  modal.innerHTML = `
    <div class="row-between" style="margin-bottom:12px;">
      <h2 style="margin:0;">Add several puppies</h2>
      <button class="btn btn-sm" data-act="cancel">✕</button>
    </div>
    <p class="muted" style="margin-top:0;">Creates placeholder records (“Puppy 1”, “Puppy 2”…), males first. Rename and fill in each one later from its own record.</p>
    <div class="form-grid">
      <div class="field"><label>Males</label>
        <input id="pf-males" type="number" min="0" max="20" value="0"></div>
      <div class="field"><label>Females</label>
        <input id="pf-females" type="number" min="0" max="20" value="0"></div>
      <div class="field"><label>Disposition (applies to all)</label>
        <select id="pf-disposition">${dispositionOptions('undecided')}</select></div>
      <div class="field"><label>Registration (applies to all)</label>
        <select id="pf-registration">${registrationOptions('')}</select></div>
    </div>
    <div id="pf-error"></div>
    <div class="form-actions">
      <button class="btn btn-primary" data-act="save">Add puppies</button>
      <button class="btn" data-act="cancel">Cancel</button>
    </div>`;

  modal.querySelectorAll('[data-act="cancel"]').forEach((b) => b.addEventListener('click', close));

  // Guards against a rapid double-tap/double-click running this whole batch
  // twice before the first call's await chain has a chance to disable
  // anything itself — each call would otherwise run to completion
  // independently, creating two full batches of placeholder puppies.
  modal.querySelector('[data-act="save"]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    const males = Number(modal.querySelector('#pf-males').value || 0);
    const females = Number(modal.querySelector('#pf-females').value || 0);
    const disposition = modal.querySelector('#pf-disposition').value;
    const intended_registration = modal.querySelector('#pf-registration').value || null;
    const whole = (n) => Number.isInteger(n) && n >= 0;
    if (!whole(males) || !whole(females) || males + females < 1 || males + females > 20) {
      modal.querySelector('#pf-error').innerHTML = `<div class="inline-error">Enter whole numbers of males and females, 1 to 20 puppies in all.</div>`;
      return;
    }
    const sexes = [...Array(males).fill('male'), ...Array(females).fill('female')];
    btn.disabled = true;
    try {
      // Number the placeholders continuing past any puppies already on the roster.
      for (let i = 0; i < sexes.length; i++) {
        await dogRepo.create({ ...base, call_name: `Puppy ${existingCount + i + 1}`, sex: sexes[i], disposition, intended_registration });
      }
      close();
      onSaved?.();
    } catch (e) {
      modal.querySelector('#pf-error').innerHTML = `<div class="inline-error">${esc(e.message || String(e))}</div>`;
    } finally {
      btn.disabled = false;
    }
  });
}
