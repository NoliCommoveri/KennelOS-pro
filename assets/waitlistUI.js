// waitlistUI.js — page-side helpers shared by the three Pro-only waitlist pages
// (waitlist / waitlist-entry / waitlist-programs; Waitlist Spec §11, End-State
// guide §29). Which kennel's list a page shows, the kennel picker, and the
// one-line preference summary. Pro-only like the pages (proPages.js).
import { ownKennels, getActiveKennelId } from '../data/kennelScope.js';
import { getMyKennelId } from '../data/settings.js';
import { waitlistEntryRepo } from '../data/waitlistEntryRepo.js';
import { WAITLIST_OPEN_STATUSES } from '../data/vocab.js';
import { esc } from './ui.js';
import { PLACEMENT_TYPE, descriptor } from '../data/vocab.js';
import { isPaused } from '../data/waitlistRules.js';

// The kennel whose list to show, in priority order: an explicit ?kennel= id (one
// of your own), the active kennel scope, the own kennel with the most open
// waitlist entries (so "All kennels" lands on the list you actually use), your
// own kennel from setup, then the first alphabetically. One list per kennel
// (Spec §0), so a page always shows exactly one. Returns { kennel, own } —
// kennel null only when you have no own kennel at all.
export async function resolveWaitlistKennel(requestedId) {
  const own = (await ownKennels()).sort((a, b) => (a.kennel_name || '').localeCompare(b.kennel_name || ''));
  const pick = (id) => own.find((k) => k.id === id) || null;
  const explicit = pick(requestedId) || pick(getActiveKennelId());
  if (explicit) return { kennel: explicit, own };
  const counts = new Map();
  for (const e of await waitlistEntryRepo.getAll()) {
    if (WAITLIST_OPEN_STATUSES.includes(e.status)) counts.set(e.kennel_id, (counts.get(e.kennel_id) || 0) + 1);
  }
  const busiest = [...own].sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0))[0];
  const kennel = (busiest && counts.get(busiest.id) ? busiest : null) || pick(getMyKennelId()) || own[0] || null;
  return { kennel, own };
}

// A kennel <select> when you have more than one own kennel (silent otherwise —
// the same "invisible until a second kennel exists" posture as the scope UI).
// Changing it reloads the page with ?kennel=.
export function mountKennelPicker(host, { kennel, own }) {
  if (!host) return;
  if (own.length < 2) { host.innerHTML = ''; return; }
  host.innerHTML = `
    <div class="field" style="max-width:320px;margin-bottom:12px;">
      <label for="wl-kennel">Kennel's list</label>
      <select id="wl-kennel">${own.map((k) => `<option value="${esc(k.id)}"${k.id === kennel.id ? ' selected' : ''}>${esc(k.kennel_name)}</option>`).join('')}</select>
    </div>`;
  host.querySelector('#wl-kennel').addEventListener('change', (e) => {
    const url = new URL(location.href);
    url.searchParams.set('kennel', e.target.value);
    location.href = url.toString();
  });
}

const SEX_LABEL = { male: 'Male', female: 'Female' };

// "Female · Boston Terrier · Show · brindle" — or "Any pup" when nothing is set.
// Returns escaped HTML.
export function prefsSummary(entry) {
  const parts = [];
  if (SEX_LABEL[entry.pref_sex]) parts.push(SEX_LABEL[entry.pref_sex]);
  if (entry.pref_breed) parts.push(entry.pref_breed);
  if (entry.pref_placement_type) parts.push(descriptor(PLACEMENT_TYPE, entry.pref_placement_type).label);
  const colors = Array.isArray(entry.pref_colors) ? entry.pref_colors : [];
  if (colors.length) parts.push(colors.join(', '));
  return parts.length ? esc(parts.join(' · ')) : '<span class="faint">Any pup</span>';
}

// Small flags for the list row: paused / listen-only. Escaped HTML.
export function entryFlags(entry, today) {
  const out = [];
  if (isPaused(entry, today)) out.push(`<span class="badge badge-amber" title="${esc(entry.pause_reason || '')}">Paused to ${esc(entry.paused_until)}</span>`);
  if ((entry.listen_mode || 'all') === 'selected') out.push('<span class="badge badge-blue">Listen-only</span>');
  return out.join(' ');
}

// A form dialog in the app's modal chrome (same markup as ui.js's dialogs).
// `onConfirm(overlay)` reads the fields and does the work; throwing shows the
// message inside the dialog and keeps it open. Resolves true once confirmed,
// false on cancel/backdrop.
export function formModal({ title, bodyHtml, confirmLabel = 'Save', danger = false, onConfirm }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
        <h2 style="margin-top:0;">${esc(title)}</h2>
        <div data-fm-error></div>
        ${bodyHtml}
        <div class="form-actions">
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-fm-confirm>${esc(confirmLabel)}</button>
          <button class="btn" data-fm-cancel>Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const done = (val) => { overlay.remove(); resolve(val); };
    const confirmBtn = overlay.querySelector('[data-fm-confirm]');
    confirmBtn.addEventListener('click', async () => {
      if (confirmBtn.disabled) return;
      confirmBtn.disabled = true;
      try {
        await onConfirm(overlay);
        done(true);
      } catch (e) {
        overlay.querySelector('[data-fm-error]').innerHTML = `<div class="inline-error">${esc(e.message || String(e))}</div>`;
        confirmBtn.disabled = false;
      }
    });
    overlay.querySelector('[data-fm-cancel]').addEventListener('click', () => done(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
  });
}
