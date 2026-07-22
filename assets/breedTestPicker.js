// breedTestPicker.js — the shared breed-picker widget for both seed-import
// wizards: the standalone Import Kennel Tests page (pages/kennel-tests-import.js)
// and the first-run kennel-setup modal (assets/kennelSetupUI.js). One
// implementation so the two runtime wizards look and behave identically:
// type to search breed names with a live match list, or browse by the CSV's
// Breed Group column (col A) via a dropdown that opens a checkbox modal for
// that group's breeds. Either path lands the breed in the same checked list
// at the bottom.
import { esc } from './ui.js';
import { listBreedGroups } from '../data/seedImport.js';

// host: element to render into (owned entirely by this widget from here on).
// groups: buildSeedGroups() output — each item carries `breedGroup`, which
// may be '' for a legacy file with no Breed Group column. selected: a Set
// the CALLER owns; this widget only adds/removes breed keys from it and
// calls onChange() after every change so the caller can re-run its own
// preview/step logic without this widget re-mounting (which would lose its
// own in-progress search text and toast).
export function renderBreedPicker(host, groups, selected, onChange = () => {}) {
  const byKey = new Map(groups.map((g) => [g.key, g]));
  const breedGroups = listBreedGroups(groups);
  // Rows shown at the bottom: every breed ever added this session, even if
  // since unchecked — unchecking excludes it from import but keeps it listed
  // so it's a one-click re-check, not a re-search.
  const addedOrder = [...selected].filter((k) => byKey.has(k));
  let query = '';
  let toast = '';

  function addKeys(keys) {
    let newlyAdded = 0;
    let firstName = '';
    for (const key of keys) {
      if (!byKey.has(key)) continue;
      if (!addedOrder.includes(key)) addedOrder.push(key);
      if (!selected.has(key)) {
        selected.add(key);
        newlyAdded++;
        firstName = byKey.get(key).display;
      }
    }
    toast = newlyAdded === 0 ? ''
      : newlyAdded === 1 ? `Successfully added ${firstName}.`
      : `Successfully added ${newlyAdded} breeds.`;
    onChange();
    paint();
    host.querySelector('#bp-query')?.focus();
  }

  function openGroupModal(breedGroup) {
    const breeds = groups.filter((g) => g.breedGroup === breedGroup).sort((a, b) => a.display.localeCompare(b.display));
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" style="max-width:420px;">
        <h2 style="margin-top:0;">${esc(breedGroup)} breeds</h2>
        <p class="field-hint">Check the breed(s) to add.</p>
        <div class="breed-picker-modal-list">
          ${breeds.map((g) => `<label class="breed-picker-row">
            <input type="checkbox" data-modal-breed="${esc(g.key)}"${selected.has(g.key) ? ' checked' : ''}>
            <span><strong>${esc(g.display)}</strong> <span class="faint">— ${g.tests.length} test${g.tests.length === 1 ? '' : 's'}</span></span>
          </label>`).join('')}
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" data-act="add">Add checked</button>
          <button class="btn" data-act="cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('[data-act="add"]').addEventListener('click', () => {
      const checkedKeys = [...overlay.querySelectorAll('[data-modal-breed]:checked')].map((cb) => cb.dataset.modalBreed);
      const uncheckedKeys = [...overlay.querySelectorAll('[data-modal-breed]:not(:checked)')].map((cb) => cb.dataset.modalBreed);
      for (const key of uncheckedKeys) selected.delete(key);
      overlay.remove();
      addKeys(checkedKeys);
    });
  }

  function paint() {
    const q = query.trim().toLowerCase();
    const matches = q
      ? groups.filter((g) => !selected.has(g.key) && g.display.toLowerCase().includes(q)).slice(0, 8)
      : [];

    host.innerHTML = `
      ${toast ? `<p class="breed-picker-toast">✓ ${esc(toast)} Add another?</p>` : ''}
      <div class="field">
        <label>Search breeds</label>
        <div class="breed-picker-search-wrap">
          <input type="text" id="bp-query" placeholder="Start typing a breed…" autocomplete="off" value="${esc(query)}">
          ${matches.length ? `<div class="breed-picker-suggestions" role="listbox">
            ${matches.map((g) => `<button type="button" class="breed-picker-suggestion" data-key="${esc(g.key)}" role="option">
              ${esc(g.display)} <span class="faint">${g.breedGroup ? `— ${esc(g.breedGroup)} · ` : '— '}${g.tests.length} test${g.tests.length === 1 ? '' : 's'}</span>
            </button>`).join('')}</div>` : ''}
        </div>
        ${q && !matches.length ? '<p class="field-hint">No matching breed in this file.</p>' : ''}
      </div>
      ${breedGroups.length ? `
      <div class="field breed-picker-group-field">
        <label>Or browse by breed group</label>
        <select id="bp-group">
          <option value="">— choose a breed group —</option>
          ${breedGroups.map((bg) => `<option value="${esc(bg)}">${esc(bg)}</option>`).join('')}
        </select>
      </div>` : ''}
      <div class="breed-picker-selected">
        ${addedOrder.length ? addedOrder.map((key) => {
          const g = byKey.get(key);
          if (!g) return '';
          return `<label class="breed-picker-row">
            <input type="checkbox" data-selected-breed="${esc(key)}"${selected.has(key) ? ' checked' : ''}>
            <span><strong>${esc(g.display)}</strong> <span class="faint">— ${g.tests.length} test${g.tests.length === 1 ? '' : 's'}</span></span>
          </label>`;
        }).join('') : '<p class="faint">No breeds added yet — search above or browse a breed group.</p>'}
      </div>`;

    const input = host.querySelector('#bp-query');
    input.addEventListener('input', () => {
      query = input.value;
      toast = '';
      paint();
      const fresh = host.querySelector('#bp-query');
      fresh.focus();
      fresh.setSelectionRange(fresh.value.length, fresh.value.length);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { query = ''; toast = ''; paint(); }
      else if (e.key === 'Enter' && matches.length) { e.preventDefault(); query = ''; addKeys([matches[0].key]); }
    });

    host.querySelectorAll('.breed-picker-suggestion').forEach((btn) => {
      btn.addEventListener('click', () => { query = ''; addKeys([btn.dataset.key]); });
    });

    const groupSelect = host.querySelector('#bp-group');
    if (groupSelect) groupSelect.addEventListener('change', () => {
      const bg = groupSelect.value;
      groupSelect.value = '';
      if (bg) openGroupModal(bg);
    });

    host.querySelectorAll('[data-selected-breed]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const key = cb.dataset.selectedBreed;
        cb.checked ? selected.add(key) : selected.delete(key);
        toast = '';
        onChange();
        paint();
      });
    });
  }

  paint();
}
