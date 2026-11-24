// A puppy's collar color (Dog.collar_color, vocab COLLAR_COLOR): which color goes by
// each pup's name in her pup lists and on the waitlist family pages.
//
// What a pup shows, in order:
//   1. the color she set on it (`collar_color`): a filled dot;
//   2. a color its call name gives ("Blue collar", or just "Blue"), for a breeder who
//      names pups by collar: also filled, the name says it;
//   3. otherwise a color picked for it, steady from its id and not one a littermate
//      shows: drawn as a hollow ring (`set: false`), so a family never takes it for a
//      collar the pup really wears.
import { COLLAR_COLOR } from './vocab.js';

export const COLLAR_VALUES = Object.freeze(COLLAR_COLOR.map((c) => c.value));
export const isCollar = (v) => COLLAR_VALUES.includes(v);
export const collarHex = (v) => COLLAR_COLOR.find((c) => c.value === v)?.hex || null;
export const collarLabel = (v) => COLLAR_COLOR.find((c) => c.value === v)?.label || '';

// A collar color is a puppy's at home (owner decision 2026-11-24): kept only while the
// dog is a puppy and not external (dogRepo sets it to null otherwise, for every writer).
export const keepsCollar = (record) => record?.status === 'puppy' && record?.ownership_type !== 'external';

// Too pale to read as a ring on a white page: never picked for a pup she hasn't set.
const NOT_PICKED = new Set(['white', 'silver']);
const BY_LENGTH = [...COLLAR_COLOR].sort((a, b) => b.label.length - a.label.length);

// The color a call name gives: the whole name a color ("Blue"), or "<color> collar"
// anywhere in it ("Blue collar", "Pink collar girl"). Never part of a word ("Bluebell").
export function collarFromName(name) {
  const s = String(name ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!s) return null;
  for (const c of BY_LENGTH) {
    const w = c.label.toLowerCase();
    if (s === w || new RegExp(`(^|[^a-z])${w} collar([^a-z]|$)`).test(s)) return c.value;
  }
  return null;
}

// FNV-1a: the same id always lands on the same color.
function hash(str) {
  let h = 0x811c9dc5;
  for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

// Every pup of one litter (any state: available, reserved, gone home), each with
// `id`, `collar_color` and `call_name` → Map(id → { collar, set }).
export function litterCollars(pups = []) {
  const out = new Map();
  const used = new Set();
  for (const d of pups) {
    const own = isCollar(d?.collar_color) ? d.collar_color : null;
    const named = own ? null : collarFromName(d?.call_name);
    if (own || named) { out.set(d.id, { collar: own || named, set: true }); used.add(own || named); }
  }
  const rest = pups.filter((d) => d && !out.has(d.id)).sort((a, b) => (hash(a.id) - hash(b.id)) || String(a.id).localeCompare(String(b.id)));
  for (const d of rest) {
    const free = COLLAR_VALUES.filter((v) => !used.has(v) && !NOT_PICKED.has(v));
    const pool = free.length ? free : COLLAR_VALUES.filter((v) => !NOT_PICKED.has(v));
    const v = pool[hash(d.id) % pool.length];
    used.add(v);
    out.set(d.id, { collar: v, set: false });
  }
  return out;
}

// The pups in one litter wearing the same color she set (each color at most once).
export function sharedCollars(pups = []) {
  const seen = new Map();
  for (const d of pups) if (isCollar(d?.collar_color) && !d.is_archived) seen.set(d.collar_color, [...(seen.get(d.collar_color) || []), d]);
  return [...seen.entries()].filter(([, list]) => list.length > 1);
}

// A dot for her own pages: filled for a collar she set or a name gives, a ring otherwise.
export function collarDotHtml(c, { title = '' } = {}) {
  if (!c || !isCollar(c.collar)) return '';
  const hex = collarHex(c.collar);
  const label = `${collarLabel(c.collar)} collar${c.set ? '' : ' (not set)'}`;
  return `<span class="collar-dot${c.set ? '' : ' ring'}" style="--collar:${hex}" role="img" aria-label="${label}" title="${title || label}"></span>`;
}

// The picker (the Dog form, Add puppy, the guided litter's pup step): a row of
// swatches plus None; its value is read with readCollar.
export function collarPickerHtml(name, current = '') {
  const opt = (value, label, hex) => `<label class="collar-opt" title="${label}">
      <input type="radio" name="${name}" value="${value}"${(current || '') === value ? ' checked' : ''}>
      <span class="collar-dot${value ? '' : ' none'}"${hex ? ` style="--collar:${hex}"` : ''} aria-hidden="true"></span>
      <span class="sr-only">${label}</span>
    </label>`;
  return `<div class="collar-pick" role="radiogroup" aria-label="Collar color">${opt('', 'None', '')}${COLLAR_COLOR.map((c) => opt(c.value, c.label, c.hex)).join('')}</div>`;
}

export function readCollar(root, name) {
  const el = (root || document).querySelector(`input[name="${name}"]:checked`);
  return el && el.value ? el.value : null;
}
