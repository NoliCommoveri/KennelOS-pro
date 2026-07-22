// contactPicker.js — decorates a contact <select> with a "＋ New" button that
// opens a minimal inline-create modal (name required, contact_type optional),
// creates the contact, appends+selects it on the select, and returns it.
// Removes the round-trip through the Contacts page that point-of-entry
// pickers (sale buyer, stud-service partner, boarding related contact) would
// otherwise force (Data Integrity Brief §4.8). Same modal/overlay pattern as
// puppyForm.js.
import { contactRepo } from '../data/contactRepo.js';
import { CONTACT_TYPE } from '../data/vocab.js';
import { esc } from './ui.js';

// Inserts a "＋ New" button right after `selectEl`. `onCreated(contact)`
// fires after the new option is appended+selected and a native `change`
// event has been dispatched on the select, so existing change listeners
// (e.g. sale.js's lead-source prefill) run the same as a manual pick.
export function attachNewContactButton(selectEl, { onCreated } = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-sm';
  btn.textContent = '＋ New';
  btn.style.marginLeft = '6px';
  selectEl.insertAdjacentElement('afterend', btn);

  btn.addEventListener('click', () => {
    openNewContactModal(async (contact) => {
      // Run onCreated (typically: register the contact in the page's own
      // ctx.allContacts/contactsById) BEFORE dispatching `change` — a
      // listener that re-renders the select from that same source list needs
      // the new contact present already, or the rebuild drops it.
      onCreated?.(contact);
      const opt = document.createElement('option');
      opt.value = contact.id;
      opt.textContent = contact.name;
      selectEl.appendChild(opt);
      selectEl.value = contact.id;
      selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });

  return btn;
}

function openNewContactModal(onCreate) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
    <h2 style="margin-top:0;">New contact</h2>
    <div class="form-grid">
      <div class="field"><label>Name <span class="req">*</span></label>
        <input id="ncp-name" type="text"></div>
      <div class="field"><label>Contact type</label>
        <select id="ncp-type">
          <option value="">— none —</option>
          ${CONTACT_TYPE.map((t) => `<option value="${esc(t.value)}">${esc(t.label)}</option>`).join('')}
        </select></div>
    </div>
    <div id="ncp-error"></div>
    <div class="form-actions">
      <button class="btn btn-primary" id="ncp-save">Create</button>
      <button class="btn" id="ncp-cancel">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);

  overlay.querySelector('#ncp-cancel').addEventListener('click', close);
  overlay.querySelector('#ncp-save').addEventListener('click', async () => {
    const name = overlay.querySelector('#ncp-name').value.trim();
    const type = overlay.querySelector('#ncp-type').value;
    if (!name) {
      overlay.querySelector('#ncp-error').innerHTML = `<div class="inline-error">Name is required.</div>`;
      return;
    }
    try {
      const contact = await contactRepo.create({ name, contact_type: type ? [type] : [] });
      close();
      await onCreate(contact);
    } catch (e) {
      overlay.querySelector('#ncp-error').innerHTML = `<div class="inline-error">${esc(e.message || String(e))}</div>`;
    }
  });
  overlay.querySelector('#ncp-name').focus();
}
