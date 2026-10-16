// kennelSettingsFields.js — one kennel's program settings as form pieces, shared by
// the Kennel page's cards (pages/kennel.js) and Kels's "Getting Started" (assets/
// kelsSetupUI.js), so the two can never ask or save them differently:
//   • the logo: an image file → the data URL stored on Kennel.logo_data_url;
//   • lifecycle nudges: the on/off and the two promote ages;
//   • Puppy Record fields (Pro, editionFlags.puppyRecord): the ticks, read into
//     Kennel.puppy_record_fields (data/puppyRecordFields.js holds the list and rule).
import { PUPPY_RECORD_FIELD_GROUPS, PUPPY_RECORD_FIELD_KEYS, puppyRecordFieldsValue } from '../data/puppyRecordFields.js';
import { esc } from './ui.js';

// --- Logo ------------------------------------------------------------------
// Longest edge (px) a logo is downscaled to before it's stored as a data URL.
// Keeps the backup-riding string small; a program logo needs no more resolution
// than this on a printed one-page document.
const LOGO_MAX_EDGE = 480;
// A stored logo stays under about 300 KB (decided 2026-10-10): live sync carries
// it twice in one record (readable + sealed) against the server's ~2 MB row
// (Cloud Phase 2 plan §4.1). A PNG over it is redrawn at smaller sizes; an SVG
// (kept as markup) over it is refused. Upload only: an older, larger logo already
// on a kennel or in a backup still restores.
const LOGO_MAX_CHARS = 300_000;
const LOGO_STEP_EDGES = [LOGO_MAX_EDGE, 360, 240, 160];
const LOGO_TOO_LARGE = 'That logo is too large. Try a smaller image.';
export const LOGO_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml';

// Read a file, downscale it on a canvas, and resolve a PNG data URL (preserves
// transparency), stepped down until under LOGO_MAX_CHARS. SVGs are vector — kept
// as-is (data URL of the raw markup) rather than rasterized.
export function fileToLogoDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) { reject(new Error('Please choose an image file.')); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const dataUrl = String(reader.result);
      if (file.type === 'image/svg+xml') {
        if (dataUrl.length > LOGO_MAX_CHARS) reject(new Error(LOGO_TOO_LARGE)); else resolve(dataUrl);
        return;
      }
      const img = new Image();
      img.onerror = () => reject(new Error('That image could not be loaded.'));
      img.onload = () => {
        for (const edge of LOGO_STEP_EDGES) {
          const scale = Math.min(1, edge / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          const png = canvas.toDataURL('image/png');
          if (png.length <= LOGO_MAX_CHARS) { resolve(png); return; }
        }
        reject(new Error(LOGO_TOO_LARGE));
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

// The stored logo as an <img>, or '' when there's none.
export function logoPreview(kennel, { max = 180 } = {}) {
  if (!kennel?.logo_data_url) return '';
  return `<img src="${esc(kennel.logo_data_url)}" alt="${esc(kennel.kennel_name)} logo" style="max-width:${max}px; max-height:${max}px; object-fit:contain; border:1px solid var(--border); border-radius:var(--radius); background:#fff; padding:6px;">`;
}

// --- Lifecycle nudges (Data Integrity Brief §3.2) ---------------------------
// Opt-in, per kennel: an enable checkbox + two month thresholds, saved together.
// `on` overrides the stored on/off (Kels suggests it on).
export function nudgeFields(k, { on = k.promote_nudge_enabled } = {}) {
  return `
      <div class="form-grid">
        <div class="field field-wide"><label class="check-inline"><input id="e-promote-enabled" type="checkbox"${on ? ' checked' : ''}> Nudge me to promote kept puppies to active breeding once they're old enough</label></div>
        <div class="field field-wide">
          <label>Promote age (months)</label>
          <div class="promote-age-row">
            <div class="field"><label>Male</label><input id="e-promote-male" type="number" min="0" step="1" value="${esc(k.promote_age_male_months ?? 6)}"></div>
            <div class="field"><label>Female</label><input id="e-promote-female" type="number" min="0" step="1" value="${esc(k.promote_age_female_months ?? 12)}"></div>
          </div>
        </div>
      </div>`;
}

// The kennel changes the nudge fields under `root` hold.
export function readNudgeFields(root) {
  return {
    promote_nudge_enabled: root.querySelector('#e-promote-enabled').checked,
    promote_age_male_months: Number(root.querySelector('#e-promote-male').value) || 0,
    promote_age_female_months: Number(root.querySelector('#e-promote-female').value) || 0
  };
}

// --- Puppy Record fields (guide §23) ----------------------------------------
// One box per section and field. A section's own box turns the whole section
// off; its fields grey out while it's off.
export function puppyRecordFieldsHtml(k) {
  const stored = k.puppy_record_fields || {};
  const box = (key, label, group, master = false) => `<label class="check-inline" style="display:block; margin:4px 0;${master ? ' font-weight:600;' : ' padding-left:22px;'}">
      <input type="checkbox" data-pr-field="${esc(key)}"${group ? ` data-pr-group="${esc(group)}"` : ''}${stored[key] !== false ? ' checked' : ''}${group && stored[group] === false ? ' disabled' : ''}> ${esc(label)}
    </label>`;
  return PUPPY_RECORD_FIELD_GROUPS.map((g) => `
      <div class="field">
        ${g.key ? box(g.key, g.label, null, true) : `<label>${esc(g.label)}</label>`}
        ${g.fields.map((f) => box(f.key, f.label, g.key)).join('')}
      </div>`).join('');
}

// A section's box enables or greys out its fields.
export function wirePuppyRecordFields(root) {
  root.querySelectorAll('[data-pr-field]:not([data-pr-group])').forEach((master) => {
    master.addEventListener('change', () => {
      root.querySelectorAll(`[data-pr-group="${CSS.escape(master.dataset.prField)}"]`).forEach((cb) => { cb.disabled = !master.checked; });
    });
  });
}

// Tick every box again.
export function tickAllPuppyRecordFields(root) {
  root.querySelectorAll('[data-pr-field]').forEach((cb) => { cb.checked = true; cb.disabled = false; });
}

// The value to store on Kennel.puppy_record_fields from the boxes under `root`.
export function readPuppyRecordFields(root) {
  const checked = {};
  for (const key of PUPPY_RECORD_FIELD_KEYS) {
    const cb = root.querySelector(`[data-pr-field="${CSS.escape(key)}"]`);
    checked[key] = cb ? cb.checked : true;
  }
  return puppyRecordFieldsValue(checked);
}
