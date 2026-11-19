// linkedDeleteUI.js — the Delete wizard (data/linkedDelete.js; End-State guide §7).
//
// Opened from a refused Delete's note ("Delete it with its linked records…"). Two
// steps in one modal: the linked records, all ticked that were made with this one
// (she unticks anything real); then what will happen, with what only loses a link,
// and a red "Delete N records". Hard delete can't be undone, so nothing is
// deleted before that button.
import { esc } from './ui.js';
import { gatherLinked, planLinkedDelete, runLinkedDelete, WINDOW_DAYS } from '../data/linkedDelete.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const KIND_PLURAL = { 'do-not-sell listing': 'do-not-sell listings', 'stud service': 'stud services' };
const kindCount = (kind, n) => (n === 1 ? `1 ${kind}` : `${n} ${KIND_PLURAL[kind] || `${kind}s`}`);
const WHY = {
  time: `added more than ${WINDOW_DAYS} days apart from it`,
  used: 'other records use it too'
};
const KINDS = { contacts: 'contact', dogs: 'dog', litters: 'litter', pairings: 'pairing', sales: 'sale', stud_services: 'stud service', contracts: 'contract', waitlist_entries: 'application', waitlist_offers: 'offer', do_not_sell: 'do-not-sell listing' };

// Open the wizard on one record. `onDone()` runs after the delete (the page
// usually goes to its list). Resolves true when records were deleted.
export async function openLinkedDelete(table, id, { onDone } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = '<div class="modal linked-delete" role="dialog" aria-modal="true" aria-labelledby="ld-title"><p class="muted">Finding the linked records…</p></div>';
  document.body.appendChild(overlay);
  const modal = overlay.querySelector('.modal');
  return new Promise((resolve) => {
    let busy = false;
    const close = (val) => { overlay.remove(); resolve(val); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay && !busy) close(false); });

    let found;
    const choose = () => {
      const { start, items, capped } = found;
      const others = items.slice(1);
      const on = others.filter((i) => i.ticked);
      const off = others.filter((i) => !i.ticked);
      const rowHtml = (i) => `<label class="check-inline ld-row"><input type="checkbox" data-ld="${esc(`${i.table}:${i.id}`)}"${i.ticked ? ' checked' : ''}>
        <span><strong>${esc(i.label)}</strong> <span class="faint">(${esc(KINDS[i.table] || i.kind)}${i.why ? `, ${esc(WHY[i.why])}` : ''})</span></span></label>`;
      modal.innerHTML = `
        <h2 id="ld-title" style="margin-top:0;">Delete ${esc(start.label)} with its linked records</h2>
        <p class="muted">For records that were all a mistake or a test. Untick anything that's real: it stays, and only its link to the deleted ones is cleared.</p>
        <div class="ld-list">
          <label class="check-inline ld-row"><input type="checkbox" checked disabled> <span><strong>${esc(start.label)}</strong> <span class="faint">(${esc(KINDS[start.table])}, the one you started from)</span></span></label>
          ${on.map(rowHtml).join('')}
        </div>
        ${off.length ? `<p class="muted" style="margin-bottom:4px;"><strong>Linked, but left unticked</strong> (probably real). Tick one only if it was a test too.</p>
        <div class="ld-list">${off.map(rowHtml).join('')}</div>` : ''}
        ${capped ? '<p class="field-hint">That\'s a lot of linked records, so the list stops here. Delete these, then start again from what\'s left.</p>' : ''}
        <div class="form-actions">
          <button class="btn btn-primary" id="ld-next">Next</button>
          <button class="btn" id="ld-cancel">Cancel</button>
        </div>`;
      // What she ticked last time comes back if she steps back.
      for (const box of modal.querySelectorAll('[data-ld]')) {
        const it = items.find((i) => `${i.table}:${i.id}` === box.dataset.ld);
        if (it.picked != null) box.checked = it.picked;
      }
      modal.querySelector('#ld-cancel').onclick = () => close(false);
      modal.querySelector('#ld-next').onclick = () => {
        for (const box of modal.querySelectorAll('[data-ld]')) {
          items.find((i) => `${i.table}:${i.id}` === box.dataset.ld).picked = box.checked;
        }
        review().catch(fail);
      };
    };

    const review = async () => {
      const picked = [found.start, ...found.items.slice(1).filter((i) => i.picked)].map((i) => ({ table: i.table, id: i.id }));
      busy = true;
      modal.innerHTML = '<p class="muted">Checking what changes…</p>';
      const plan = await planLinkedDelete(picked);
      busy = false;
      const counts = Object.entries(plan.counts).map(([t, n]) => kindCount(KINDS[t], n));
      const h = plan.history;
      const history = [h.events && plural(h.events, 'event'), h.expenses && plural(h.expenses, 'expense'), h.documents && plural(h.documents, 'document')].filter(Boolean);
      modal.innerHTML = `
        <h2 id="ld-title" style="margin-top:0;">Delete ${plural(picked.length, 'record')}?</h2>
        <p><strong>${esc(counts.join(', '))}</strong>${history.length ? `, with their own history: ${esc(history.join(', '))}` : ''}.</p>
        ${plan.kept.length ? `<p class="muted" style="margin-bottom:4px;">These stay, and lose their link to what's deleted:</p>
        <ul class="ld-kept">${plan.kept.map((k) => `<li>${esc(k.label || 'Untitled')} <span class="faint">(${esc(k.kind)}: ${esc(k.field)})</span></li>`).join('')}</ul>` : ''}
        <p class="muted">This can't be undone.</p>
        <div class="form-actions">
          <button class="btn btn-danger" id="ld-go">Delete ${plural(picked.length, 'record')}</button>
          <button class="btn" id="ld-back">Back</button>
        </div>`;
      modal.querySelector('#ld-back').onclick = choose;
      modal.querySelector('#ld-go').onclick = async () => {
        busy = true;
        overlay.setAttribute('data-no-dismiss', '');
        modal.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        try {
          const out = await runLinkedDelete(picked);
          // An online application also leaves the server, so a new device can't bring it back.
          const online = out.entries.filter((e) => e.source === 'online_form');
          if (online.length) {
            const { forgetApplication } = await import('../data/cloud/cloudWaitlist.js');
            await Promise.all(online.map((e) => forgetApplication(e).catch(() => {})));
          }
          close(true);
          onDone?.(out);
        } catch (e) { fail(e); }
      };
    };

    const fail = (e) => {
      busy = false;
      overlay.removeAttribute('data-no-dismiss');
      modal.innerHTML = `<h2 style="margin-top:0;">Couldn't delete them</h2><p class="muted">${esc(e?.message || String(e))}</p>
        <div class="form-actions"><button class="btn" id="ld-close">Close</button></div>`;
      modal.querySelector('#ld-close').onclick = () => close(false);
    };

    gatherLinked(table, id).then((g) => { found = g; choose(); }).catch(fail);
  });
}
