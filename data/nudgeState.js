// nudgeState.js — device-local dismissal ledger for derived nudges (Data
// Integrity Brief §2.2). A computed nudge has no backing row to store
// "dismissed" on, so dismissals live here instead: localStorage, keyed by the
// nudge's own stable key, mirroring settings.js's conventions (namespaced
// key, a clearAll swept into App Reset). Deliberately NOT exported/backed
// up — dismissals are device-local UI state, not portable domain data, so
// restoring a backup on a new device never carries stale "I dismissed this"
// flags along with it.
const STORAGE_KEY = 'kennelOS.nudgeDismissals';

function readAll() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

function writeAll(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function isDismissed(key) {
  return Object.prototype.hasOwnProperty.call(readAll(), key);
}

export function dismiss(key) {
  const state = readAll();
  state[key] = new Date().toISOString();
  writeAll(state);
}

export function clearAll() {
  localStorage.removeItem(STORAGE_KEY);
}
