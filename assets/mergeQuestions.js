// mergeQuestions.js — the questions a merge asks before writing anything, when two
// devices each entered a record on their own (data/restoreMatch.js, guide §10):
// "Are these the same?" and, for a paired dog, which name, sex or parents to keep.
// Used by a file / Dropbox Merge (pages/import-export.js) and a device joining
// live sync (assets/cloudSyncUI.js). The plans come from importExport.js
// (planFileMerge, planJoinMatches), already in words.
import { esc } from './ui.js';

const RECORD_WORD = {
  kennels: 'kennel', contacts: 'contact', dogs: 'dog', pairings: 'breeding', litters: 'litter', sales: 'sale',
  stud_services: 'stud service', accounts: 'account', waitlist_programs: 'waitlist program'
};

// A form in a modal: `body` is its fields; `read(root)` returns the answer, or a
// string saying what's missing. → the answer | null (cancelled).
function formModal({ title, intro, body, confirmLabel, read }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <h2 style="margin-top:0;">${esc(title)}</h2>
      <p class="muted">${esc(intro)}</p>
      ${body}
      <div class="fm-error"></div>
      <div class="form-actions">
        <button class="btn btn-primary" data-act="ok">${esc(confirmLabel)}</button>
        <button class="btn" data-act="cancel">Cancel</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    const done = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => done(null));
    overlay.querySelector('[data-act="ok"]').addEventListener('click', () => {
      const res = read(overlay);
      if (typeof res === 'string') {
        overlay.querySelector('.fm-error').innerHTML = `<div class="inline-error">${esc(res)}</div>`;
        return;
      }
      done(res);
    });
  });
}

// "Are these the same?" for each open question. `theirs` says where the other
// record is ("in the backup", "on your other devices"). → { askKey: localId | 'none' } | null.
export function askSame(asks, { theirs = 'in the backup' } = {}) {
  const radio = (i, value, text) => `<label class="check-inline" style="display:flex; margin:4px 0;"><input type="radio" name="as-${i}" value="${esc(value)}"> ${text}</label>`;
  return formModal({
    title: 'Are these the same?',
    intro: 'These look like records you entered on each device. If they’re the same, they become one record, keeping the details from both.',
    body: asks.map((q, i) => `<div class="field">
        <label>A ${esc(RECORD_WORD[q.table] || 'record')} ${esc(theirs)}: <strong>${esc(q.file)}</strong></label>
        ${q.candidates.map((c) => radio(i, c.id, `Same as this one here: ${esc(c.text)}`)).join('')}
        ${radio(i, 'none', 'Not the same, keep both')}
      </div>`).join(''),
    confirmLabel: 'Continue',
    read: (root) => {
      const out = {};
      for (const [i, q] of asks.entries()) {
        const picked = root.querySelector(`input[name="as-${i}"]:checked`);
        if (!picked) return 'Answer each one, or choose Not the same.';
        out[q.key] = picked.value;
      }
      const chosen = Object.values(out).filter((v) => v !== 'none');
      if (new Set(chosen).size !== chosen.length) return `One record here can only be the same as one ${theirs}.`;
      return out;
    }
  });
}

// A paired dog's name, sex or parents differ: which to keep. → { clashKey: 'local' | 'file' } | null.
export function askClashes(clashes, { theirsLabel = 'the backup' } = {}) {
  return formModal({
    title: 'Which should I keep?',
    intro: 'These dogs are the same dog on both devices, but a few details differ.',
    body: clashes.map((c, i) => `<div class="field">
        <label>${esc(c.dog)}: ${esc(c.label)}</label>
        <label class="check-inline" style="display:flex; margin:4px 0;"><input type="radio" name="cl-${i}" value="local" checked> ${esc(c.local)} (this device)</label>
        <label class="check-inline" style="display:flex; margin:4px 0;"><input type="radio" name="cl-${i}" value="file"> ${esc(c.file)} (${esc(theirsLabel)})</label>
      </div>`).join(''),
    confirmLabel: 'Continue',
    read: (root) => Object.fromEntries(clashes.map((c, i) => [c.key, root.querySelector(`input[name="cl-${i}"]:checked`).value]))
  });
}
