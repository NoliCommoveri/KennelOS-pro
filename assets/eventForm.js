// eventForm.js — modal form for creating/editing a HistoryEvent. Picks the
// type-specific short form from the EVENT_TYPES catalog (Build Brief B1) so
// `details` stays structured, not a free-text dumping ground.
//
// Stage4.5 Addendum §C3/D1: a `span`-duration type (boarding, heat_cycle,
// medication) also shows the plain `event_end_date` field, and a
// `relatedContact: true` type (boarding, placement) shows a top-level Contact
// picker — the canonical events.related_contact_id FK, never a `details` field.
import { HistoryEvent } from '../data/eventRepo.js';
import { expenseRepo } from '../data/expenseRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { eventTypesFor, descriptor, EVENT_TYPES, EXPENSE_CATEGORIES, defaultExpenseCategoryFor } from '../data/vocab.js';
import { esc, todayYMD, param, confirmModal } from './ui.js';
import { attachNewContactButton } from './contactPicker.js';

// Which combobox field on each test-bearing type draws from the shared test
// vocabulary rather than a static options list (Test Planning Addendum §3).
const TEST_VOCAB_FIELDS = { genetic_test: 'panel_name', breed_specific_test: 'test_name', ofa_pennhip: 'joint' };

// Open the modal. opts: { subjectType, subjectId, event?, prefill?, onSaved, onCancel? }
// If `event` is provided we're editing; otherwise creating. `prefill` seeds a
// NEW event's draft (event_type/related_contact_id/title/details) — used by the
// soft-suggestion prompts (Stage4.5 Addendum §C6/§D4: StudService→boarding,
// Litter→grow-out, Sale→placement). It's a one-time seed, never a stored link
// back to whatever triggered it.
//
// `cascadeTargets` (optional): [{ id, label }] — when present, this is a
// litter-wide "log for the whole litter" entry (Enhancements Batch #3). Instead
// of writing one event for `subjectId`, an "Apply to" checkbox list lets the
// user pick which targets get the SAME payload, and save writes one independent
// Event per checked target (no cascade record, no stored link between them).
// `subjectId` is unused in this mode. The single-subject path is unchanged.

// --- Weight-check regression guard ---------------------------------------
// A weight_check whose value is below the dog's previous weight is a soft
// warning (a puppy losing weight is worth a second look), never a hard block —
// so it lives here in the UI, not the repo (invariant: soft/interactive checks
// are the page's job). Weights are compared as total ounces (lbs×16 + oz).
function weightTotalOz(details) {
  if (!details) return null;
  const lbs = details.weight_lbs;
  const oz = details.weight_oz;
  const hasLbs = lbs !== '' && lbs != null && Number.isFinite(Number(lbs));
  const hasOz = oz !== '' && oz != null && Number.isFinite(Number(oz));
  if (!hasLbs && !hasOz) return null;
  return (hasLbs ? Number(lbs) : 0) * 16 + (hasOz ? Number(oz) : 0);
}
function fmtWeight(details) {
  const lbs = (details?.weight_lbs ?? '') !== '' ? Number(details.weight_lbs) : 0;
  const oz = (details?.weight_oz ?? '') !== '' ? Number(details.weight_oz) : 0;
  const t = String(details?.time_of_day || '').toUpperCase();
  return `${lbs} lb ${oz} oz${t ? ` ${t}` : ''}`;
}
// Same-day AM/PM awareness: a weigh-in's place in the day is AM (0) before PM (1);
// a blank time sits between so it never mis-sorts a real AM/PM. This lets us find
// the TRUE preceding weight when two are logged on one day — a PM compares against
// that morning's AM, and that AM compares against the prior day, not the later PM.
function timeRank(details) {
  const t = String(details?.time_of_day || '').toUpperCase();
  return t === 'PM' ? 1 : (t === 'AM' ? 0 : 0.5);
}
// A total order over a dog's weigh-ins: date, then AM-before-PM, then capture time.
function weighKey(ev) {
  return { date: ev.event_date || '', rank: timeRank(ev.details), created: ev.created_at || '' };
}
function keyCmp(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.created !== b.created) return a.created < b.created ? -1 : 1;
  return 0;
}
// The dog's weigh-in (with a real weight) immediately preceding `newKey`,
// excluding the event being edited. Null when nothing comes before it.
async function findPriorWeighIn(dogId, newKey, excludeId) {
  const evs = await HistoryEvent.getForSubject('dog', dogId);
  let best = null, bestKey = null;
  for (const e of evs) {
    if (e.event_type !== 'weight_check' || e.id === excludeId) continue;
    if (weightTotalOz(e.details) == null) continue;
    const k = weighKey(e);
    if (keyCmp(k, newKey) >= 0) continue;            // not before the new entry
    if (!bestKey || keyCmp(k, bestKey) > 0) { best = e; bestKey = k; }
  }
  return best;
}

export async function openEventForm(opts) {
  const { subjectType, subjectId, event = null, prefill = null, cascadeTargets = null, onSaved, onCancel } = opts;
  const types = eventTypesFor(subjectType);
  const isEdit = !!event;
  const isCascade = !isEdit && !!cascadeTargets?.length;
  const cascadeChecked = new Set(cascadeTargets ? cascadeTargets.map((t) => t.id) : []);

  // Contacts are only ever needed for relatedContact types (boarding, placement,
  // both dog-subject) — loaded once up front so the picker is ready on first render.
  const contacts = await contactRepo.getAll({ includeArchived: true });

  // The Cost field is a convenience writer into the Financials ledger: an event's
  // cost lives in the `expenses` table (linked by expenses.event_id), not on the
  // Event itself. When editing, load any existing linked expense so the field
  // shows/edits the real ledger row instead of a phantom event field.
  const linkedExpense = isEdit ? await expenseRepo.getOneByEvent(event.id) : null;

  // Shared test vocabulary (Test Planning Addendum §3) — union of every active
  // own-kennel's authored panel plus every distinct test token already logged.
  // Loaded once up front like `contacts`; only test-bearing types read it.
  const [kennelVocab, seenTokens] = await Promise.all([
    kennelRepo.getVocabulary(),
    HistoryEvent.getTestTokens()
  ]);
  const testVocabulary = [];
  {
    const seen = new Set();
    for (const t of [...kennelVocab, ...seenTokens]) {
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      testVocabulary.push(t);
    }
  }

  // Working state
  const draft = {
    event_type: event?.event_type || prefill?.event_type || types[0].value,
    event_date: event?.event_date || todayYMD(),
    event_end_date: event?.event_end_date || '',
    related_contact_id: event?.related_contact_id || prefill?.related_contact_id || '',
    title: event?.title || prefill?.title || '',
    details: { ...(event?.details || prefill?.details || {}) },
    reminder_date: event?.reminder_date || '',
    cost: linkedExpense?.amount ?? '',
    expenseCategory: linkedExpense?.category || defaultExpenseCategoryFor(event?.event_type || prefill?.event_type || types[0].value),
    notes: event?.notes || '',
    // Cascade-only: per-target overrides keyed by target id (e.g. one weight
    // per puppy on a litter-wide weight_check, while other detail fields —
    // like time_of_day — stay shared across every target). Empty otherwise.
    perTargetDetails: {}
  };

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true"></div>`;
  const modal = overlay.querySelector('.modal');
  document.body.appendChild(overlay);

  // Per-litter weight_check cascade (Enhancements Batch — litter-wide weight
  // logging): weight_lbs/weight_oz are collected once per checked puppy
  // instead of one shared value applied to all; every other detail field
  // (currently just time_of_day) stays shared across the whole cascade.
  const PER_TARGET_CASCADE_FIELDS = { weight_check: ['weight_lbs', 'weight_oz'] };

  function renderField(typeDef, f) {
    const v = draft.details[f.key] ?? '';
    if (f.type === 'textarea') {
      return `<div class="field field-wide"><label>${esc(f.label)}</label><textarea data-detail="${esc(f.key)}">${esc(v)}</textarea></div>`;
    }
    if (f.type === 'combobox') {
      const isTestField = TEST_VOCAB_FIELDS[typeDef.value] === f.key;
      const dlId = `ef-dl-${f.key}`;
      const opts = (isTestField ? testVocabulary : (f.options || [])).map((o) => `<option value="${esc(o)}"></option>`).join('');
      return `<div class="field"><label>${esc(f.label)}</label><input data-detail="${esc(f.key)}" type="text" list="${dlId}" value="${esc(v)}"><datalist id="${dlId}">${opts}</datalist></div>`;
    }
    if (f.type === 'select') {
      const opts = (f.options || []).map((o) => `<option value="${esc(o)}"${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('');
      return `<div class="field"><label>${esc(f.label)}</label><select data-detail="${esc(f.key)}"><option value="">— select —</option>${opts}</select></div>`;
    }
    const inputType = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text';
    const stepAttr = f.type === 'number' && f.step ? ` step="${esc(f.step)}"` : '';
    return `<div class="field"><label>${esc(f.label)}</label><input data-detail="${esc(f.key)}" type="${inputType}"${stepAttr} value="${esc(v)}"></div>`;
  }

  function perTargetFieldHtml(target, f) {
    const v = draft.perTargetDetails[target.id]?.[f.key] ?? '';
    const stepAttr = f.step ? ` step="${esc(f.step)}"` : '';
    return `<div class="field"><label>${esc(target.label)} — ${esc(f.label)}</label>
      <input data-cascade-detail="${esc(f.key)}" data-cascade-id="${esc(target.id)}" type="number"${stepAttr} value="${esc(v)}"></div>`;
  }

  function detailFieldsHtml(typeDef) {
    const perTargetKeys = isCascade ? (PER_TARGET_CASCADE_FIELDS[typeDef.value] || []) : [];
    if (!typeDef.fields.length) return '<p class="faint" style="margin:0;">No extra fields for this type — use the title and notes.</p>';
    if (!perTargetKeys.length) {
      return `<div class="form-grid">` + typeDef.fields.map((f) => renderField(typeDef, f)).join('') + `</div>`;
    }
    const sharedFields = typeDef.fields.filter((f) => !perTargetKeys.includes(f.key));
    const perTargetFieldDefs = typeDef.fields.filter((f) => perTargetKeys.includes(f.key));
    const sharedHtml = sharedFields.length
      ? `<div class="form-grid">` + sharedFields.map((f) => renderField(typeDef, f)).join('') + `</div>` : '';
    const checkedTargets = cascadeTargets.filter((t) => cascadeChecked.has(t.id));
    const perTargetHtml = checkedTargets.length
      ? `<div class="form-grid" style="margin-top:10px;">` + checkedTargets.map((t) =>
          perTargetFieldDefs.map((f) => perTargetFieldHtml(t, f)).join('')).join('') + `</div>`
      : '<p class="faint" style="margin-top:10px;">Select at least one puppy above to enter its weight.</p>';
    return sharedHtml + perTargetHtml;
  }

  function contactOptions(current) {
    const opts = contacts
      .map((c) => `<option value="${esc(c.id)}"${c.id === current ? ' selected' : ''}>${esc(c.name)}${c.is_archived ? ' (archived)' : ''}</option>`)
      .join('');
    return `<option value="">— none —</option>` + opts;
  }

  function render() {
    const typeDef = descriptor(EVENT_TYPES, draft.event_type);
    const typeOptions = types.map((t) =>
      `<option value="${esc(t.value)}"${t.value === draft.event_type ? ' selected' : ''}>${esc(t.label)}</option>`).join('');
    const isSpan = typeDef.duration === 'span';
    modal.innerHTML = `
      <div class="row-between" style="margin-bottom:12px;">
        <h2 style="margin:0;">${isEdit ? 'Edit event' : isCascade ? 'Log event for whole litter' : 'Add event'}</h2>
        <button class="btn btn-sm" data-act="cancel">✕</button>
      </div>
      ${isCascade ? `<div class="field field-wide" style="margin-bottom:14px;">
        <label>Apply to</label>
        ${cascadeTargets.map((t) => `<label class="check-inline" style="display:block; margin:4px 0;">
          <input type="checkbox" data-cascade-target="${esc(t.id)}"${cascadeChecked.has(t.id) ? ' checked' : ''}> ${esc(t.label)}
        </label>`).join('')}
      </div>` : ''}
      <div class="form-grid">
        <div class="field"><label>Type <span class="req">*</span></label>
          <select id="ef-type">${typeOptions}</select></div>
        <div class="field"><label>${isSpan ? 'Start date' : 'Date'} <span class="req">*</span></label>
          <input id="ef-date" type="date" value="${esc(draft.event_date)}">
          <span class="field-hint">Future dates are allowed (e.g. a scheduled surgery).</span></div>
        ${isSpan ? `<div class="field"><label>End date</label>
          <input id="ef-end-date" type="date" value="${esc(draft.event_end_date)}">
          <span class="field-hint">Leave blank for an open-ended/ongoing stay.</span></div>` : ''}
        <div class="field field-wide"><label>Title <span class="req">*</span></label>
          <input id="ef-title" type="text" value="${esc(draft.title)}" placeholder="Short summary shown in the timeline"></div>
        ${typeDef.relatedContact ? `<div class="field"><label>Related contact</label>
          <select id="ef-related-contact">${contactOptions(draft.related_contact_id)}</select>
          <span class="field-hint">The person or kennel on the other side of this event.</span></div>` : ''}
      </div>
      <h2 style="font-size:15px;">${esc(typeDef.label)} details</h2>
      <div id="ef-details">${detailFieldsHtml(typeDef)}</div>
      <div class="form-grid" style="margin-top:14px;">
        <div class="field"><label>Reminder date</label><input id="ef-reminder" type="date" value="${esc(draft.reminder_date)}"></div>
        <div class="field"><label>Cost</label><input id="ef-cost" type="number" step="0.01" min="0" value="${esc(draft.cost)}">
          <span class="field-hint">Logged to Financials against this ${esc(subjectType)}${linkedExpense ? '' : ' (leave blank for none)'}.</span></div>
        <div class="field"><label>Cost category</label>
          <select id="ef-cost-category">${EXPENSE_CATEGORIES.map((c) => `<option value="${esc(c.value)}"${c.value === draft.expenseCategory ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select></div>
        <div class="field field-wide"><label>Notes</label><textarea id="ef-notes">${esc(draft.notes)}</textarea></div>
      </div>
      <div id="ef-error"></div>
      <div class="form-actions">
        <button class="btn btn-primary" data-act="save">Save event</button>
        <button class="btn" data-act="cancel">Cancel</button>
      </div>`;

    modal.querySelector('#ef-type').addEventListener('change', (e) => {
      // The category the old type suggested — captured before we switch types so
      // we can tell an untouched default from a deliberate override.
      const prevDefault = defaultExpenseCategoryFor(draft.event_type);
      captureInputs();
      draft.event_type = e.target.value;
      // Auto-fill an empty title with the type label as a convenience.
      if (!draft.title) draft.title = descriptor(EVENT_TYPES, draft.event_type).label;
      // Follow the new type's suggested cost category, unless the user has
      // deliberately picked a different one (then leave their choice alone).
      if (draft.expenseCategory === prevDefault) draft.expenseCategory = defaultExpenseCategoryFor(draft.event_type);
      render();
    });
    const relatedContactEl = modal.querySelector('#ef-related-contact');
    if (relatedContactEl) {
      attachNewContactButton(relatedContactEl, {
        onCreated: (contact) => { contacts.push(contact); draft.related_contact_id = contact.id; }
      });
    }
    if (isCascade) {
      modal.querySelectorAll('[data-cascade-target]').forEach((cb) => {
        cb.addEventListener('change', (e) => {
          captureInputs();
          const id = e.target.dataset.cascadeTarget;
          if (e.target.checked) cascadeChecked.add(id); else cascadeChecked.delete(id);
          // Only re-render when the current type has per-target fields (their
          // rows track which puppies are checked); other types' shared fields
          // don't depend on the checked set, so skip the redraw for those.
          if (PER_TARGET_CASCADE_FIELDS[draft.event_type]?.length) render();
        });
      });
    }
    modal.querySelector('[data-act="save"]').addEventListener('click', save);
    modal.querySelectorAll('[data-act="cancel"]').forEach((b) => b.addEventListener('click', close));
  }

  function captureInputs() {
    draft.event_date = modal.querySelector('#ef-date').value;
    const endEl = modal.querySelector('#ef-end-date');
    draft.event_end_date = endEl ? endEl.value : '';
    const contactEl = modal.querySelector('#ef-related-contact');
    draft.related_contact_id = contactEl ? contactEl.value : '';
    draft.title = modal.querySelector('#ef-title').value.trim();
    draft.reminder_date = modal.querySelector('#ef-reminder').value;
    draft.cost = modal.querySelector('#ef-cost').value;
    draft.expenseCategory = modal.querySelector('#ef-cost-category').value;
    draft.notes = modal.querySelector('#ef-notes').value;
    draft.details = {};
    modal.querySelectorAll('[data-detail]').forEach((el) => {
      const val = el.value.trim();
      if (val !== '') draft.details[el.dataset.detail] = el.type === 'number' ? Number(val) : val;
    });
    modal.querySelectorAll('[data-cascade-detail]').forEach((el) => {
      const id = el.dataset.cascadeId;
      const key = el.dataset.cascadeDetail;
      const val = el.value.trim();
      draft.perTargetDetails[id] = draft.perTargetDetails[id] || {};
      if (val !== '') draft.perTargetDetails[id][key] = Number(val);
      else delete draft.perTargetDetails[id][key];
    });
  }

  function showError(msg) {
    modal.querySelector('#ef-error').innerHTML = `<div class="inline-error">${esc(msg)}</div>`;
  }

  async function save() {
    captureInputs();
    if (isCascade && !cascadeChecked.size) {
      showError('Select at least one puppy to apply this event to.');
      return;
    }
    // Soft warning: reminder should not precede the event.
    if (draft.reminder_date && draft.event_date && draft.reminder_date < draft.event_date) {
      if (!(await confirmModal({ title: 'Reminder is before the event date', message: 'Reminder date is before the event date. Save anyway?', confirmLabel: 'Save anyway', cancelLabel: 'Cancel' }))) return;
    }
    // Soft warning: weight below the dog's previous weigh-in. Checked PER DOG,
    // so a litter-wide bulk weight-add lists exactly which puppies dropped.
    if (draft.event_type === 'weight_check' && subjectType === 'dog') {
      const targets = isCascade
        ? [...cascadeChecked].map((id) => ({ id, details: { ...draft.details, ...(draft.perTargetDetails[id] || {}) }, label: cascadeTargets.find((t) => t.id === id)?.label || 'This puppy' }))
        : [{ id: subjectId, details: draft.details, label: 'This dog' }];
      // A new entry sorts after any existing same-day/same-time weigh-in (its
      // capture time is "now"); an edit keeps its own place via created_at + id.
      const newCreated = isEdit ? (event.created_at || '~~~~~~') : '~~~~~~';
      const drops = [];
      for (const t of targets) {
        const newOz = weightTotalOz(t.details);
        if (newOz == null) continue;
        const newKey = { date: draft.event_date || '', rank: timeRank(t.details), created: newCreated };
        const prior = await findPriorWeighIn(t.id, newKey, isEdit ? event.id : null);
        if (prior && newOz < weightTotalOz(prior.details)) {
          drops.push(`• ${t.label}: ${fmtWeight(t.details)} — down from ${fmtWeight(prior.details)}${prior.event_date ? ` on ${prior.event_date}` : ''}`);
        }
      }
      if (drops.length) {
        const many = drops.length > 1;
        const ok = await confirmModal({
          title: `Weight decreased${many ? ` (${drops.length} dogs)` : ''}`,
          message: `${many ? 'These weigh-ins are' : 'This weigh-in is'} below the previous weight for the same dog:\n\n${drops.join('\n')}\n\nSave anyway?`,
          confirmLabel: 'Save anyway', cancelLabel: 'Go back', danger: true
        });
        if (!ok) return;
      }
    }
    const basePayload = {
      subject_type: subjectType,
      event_type: draft.event_type,
      event_date: draft.event_date,
      event_end_date: draft.event_end_date || null,
      related_contact_id: draft.related_contact_id || null,
      title: draft.title,
      details: draft.details,
      reminder_date: draft.reminder_date || null,
      notes: draft.notes
    };
    const amount = draft.cost === '' ? null : Number(draft.cost);
    if (amount != null && !Number.isFinite(amount)) { showError('Cost must be a number.'); return; }
    try {
      let saved;
      if (isCascade) {
        const perTargetKeys = PER_TARGET_CASCADE_FIELDS[draft.event_type] || [];
        saved = await Promise.all(
          [...cascadeChecked].map((id) => HistoryEvent.create({
            ...basePayload,
            subject_id: id,
            details: perTargetKeys.length ? { ...draft.details, ...(draft.perTargetDetails[id] || {}) } : draft.details
          }))
        );
        // One linked expense per created event when a cost was entered (each
        // puppy gets its own ledger row for the same amount/category).
        if (amount != null) {
          await Promise.all(saved.map((ev) => writeLinkedExpense(ev, subjectType, ev.subject_id, amount, draft)));
        }
      } else {
        const payload = { ...basePayload, subject_id: subjectId };
        saved = isEdit
          ? await HistoryEvent.update(event.id, payload)
          : await HistoryEvent.create(payload);
        await syncLinkedExpense(saved, subjectType, subjectId, amount, draft, linkedExpense);
      }
      close();
      onSaved?.(saved);
    } catch (e) {
      showError(e.message || String(e));
    }
  }

  // Create a fresh expense linked to a just-created event (cascade path).
  function writeLinkedExpense(ev, sType, sId, amount, d) {
    return expenseRepo.create({
      event_id: ev.id, subject_type: sType, subject_id: sId,
      amount, category: d.expenseCategory, expense_date: d.event_date, vendor: '', notes: ''
    });
  }

  // Reconcile the single-subject event's linked expense with the Cost field:
  // upsert when a cost is present, remove the linked row when it's cleared.
  async function syncLinkedExpense(ev, sType, sId, amount, d, existing) {
    if (amount != null) {
      if (existing) {
        await expenseRepo.update(existing.id, {
          amount, category: d.expenseCategory, expense_date: d.event_date,
          subject_type: sType, subject_id: sId
        });
      } else {
        await writeLinkedExpense(ev, sType, sId, amount, d);
      }
    } else if (existing) {
      await expenseRepo.hardDelete(existing.id);
    }
  }

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') { close(); onCancel?.(); } }

  overlay.addEventListener('click', (e) => { if (e.target === overlay) { close(); onCancel?.(); } });
  document.addEventListener('keydown', onKey);
  render();
}

// Today's due-out/reminder rows deep-link here via two query params (no
// standalone event page exists — Event is polymorphic, so it's always opened
// from its subject's own page): `openEvent=<id>` opens that exact event in
// edit mode (a due-out — the row IS the event); `logEvent=<event_type>` opens
// a fresh event of that type (a reminder — nudging the NEXT occurrence, not
// re-editing the one that fired it). Call once, after the subject page has
// loaded its record; a no-op if neither param is present.
export async function openEventFromQuery(subjectType, subjectId, onSaved) {
  const openId = param('openEvent');
  if (openId) {
    const event = await HistoryEvent.getById(openId);
    if (event) openEventForm({ subjectType, subjectId, event, onSaved });
    return;
  }
  const logType = param('logEvent');
  if (logType) {
    openEventForm({ subjectType, subjectId, prefill: { event_type: logType }, onSaved });
  }
}
