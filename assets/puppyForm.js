// puppyForm.js — the "Add Puppy" / "Add N Puppies" flow launched from Litter
// Detail (Stage 3 Brief §3). A puppy is NOT a separate entity — these create
// ordinary Dog records via dogRepo.create(), with the litter-derived fields
// (litter_id, dam_id, sire_id, breed, date_of_birth, status:puppy,
// ownership_type:owned) pre-filled. call_name and sex are the only per-puppy
// fields prompted, matching Dog's "required to save" list; everything else is
// edited later on Dog Detail.
import { dogRepo } from '../data/dogRepo.js';
import { SEX, DISPOSITION } from '../data/vocab.js';
import { esc, fmtDate, todayYMD } from './ui.js';

// Fields carried from the litter onto each new puppy record. whelp_date only
// carries into date_of_birth once it's an actual (not projected) date — a
// litter can still be "Expected" with a future whelp_date when placeholders
// get added, and Dog rejects a future date_of_birth outright.
function baseFromLitter(litter, dam) {
  // Breeder kennel inherits the dam's own kennel_id when she's your own dog
  // (owned/co-owned) — the same "dam is my dog" rule dog.js applies when a
  // Litter is linked after the fact. A dam you don't own says nothing about
  // which of your kennels bred this puppy, so it's left for the user to set.
  const damIsMine = dam && ['owned', 'co_owned'].includes(dam.ownership_type);
  return {
    litter_id: litter.id,
    dam_id: litter.dam_id || null,
    sire_id: litter.sire_id || null,
    breed: dam?.breed || '',        // breed comes from the dam
    date_of_birth: (litter.whelp_date && litter.whelp_date <= todayYMD()) ? litter.whelp_date : '',
    status: 'puppy',
    ownership_type: 'owned',
    breeder_kennel_id: damIsMine ? (dam.kennel_id || null) : null
  };
}

function sexOptions(current) {
  return SEX.map((s) => `<option value="${esc(s.value)}"${s.value === current ? ' selected' : ''}>${esc(s.label)}</option>`).join('');
}

function dispositionOptions(current) {
  return DISPOSITION.map((d) => `<option value="${esc(d.value)}"${d.value === current ? ' selected' : ''}>${esc(d.label)}</option>`).join('');
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
    </div>
    <div id="pf-error"></div>
    <div class="form-actions">
      <button class="btn btn-primary" data-act="save">Add puppy</button>
      <button class="btn btn-primary" data-act="save-open">Add &amp; open record</button>
      <button class="btn" data-act="cancel">Cancel</button>
    </div>`;

  modal.querySelectorAll('[data-act="cancel"]').forEach((b) => b.addEventListener('click', close));

  async function save(openAfter) {
    const call_name = modal.querySelector('#pf-call_name').value.trim();
    const sex = modal.querySelector('#pf-sex').value;
    const disposition = modal.querySelector('#pf-disposition').value;
    if (!call_name) {
      modal.querySelector('#pf-error').innerHTML = `<div class="inline-error">Call name is required.</div>`;
      return;
    }
    try {
      const puppy = await dogRepo.create({ ...base, call_name, sex, disposition });
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

// Bulk: create N placeholder puppies ("Puppy 1"… with sex unknown), each an
// ordinary, individually-editable Dog record afterward (Stage 3 Brief §3).
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
    <p class="muted" style="margin-top:0;">Creates placeholder records (“Puppy 1”, “Puppy 2”…) with sex Unknown. Rename and fill in each one later from its own record.</p>
    <div class="form-grid">
      <div class="field"><label>How many? <span class="req">*</span></label>
        <input id="pf-count" type="number" min="1" max="20" value="4"></div>
      <div class="field"><label>Disposition (applies to all)</label>
        <select id="pf-disposition">${dispositionOptions('undecided')}</select></div>
    </div>
    <div id="pf-error"></div>
    <div class="form-actions">
      <button class="btn btn-primary" data-act="save">Add puppies</button>
      <button class="btn" data-act="cancel">Cancel</button>
    </div>`;

  modal.querySelectorAll('[data-act="cancel"]').forEach((b) => b.addEventListener('click', close));

  modal.querySelector('[data-act="save"]').addEventListener('click', async () => {
    const n = Number(modal.querySelector('#pf-count').value);
    const disposition = modal.querySelector('#pf-disposition').value;
    if (!Number.isInteger(n) || n < 1 || n > 20) {
      modal.querySelector('#pf-error').innerHTML = `<div class="inline-error">Enter a whole number from 1 to 20.</div>`;
      return;
    }
    try {
      // Number the placeholders continuing past any puppies already on the roster.
      for (let i = 0; i < n; i++) {
        await dogRepo.create({ ...base, call_name: `Puppy ${existingCount + i + 1}`, sex: 'unknown', disposition });
      }
      close();
      onSaved?.();
    } catch (e) {
      modal.querySelector('#pf-error').innerHTML = `<div class="inline-error">${esc(e.message || String(e))}</div>`;
    }
  });
}
