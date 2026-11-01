// nudgeState.js — device-local dismissal ledger for derived nudges (Data
// Integrity Brief §2.2). A computed nudge has no backing row to store
// "dismissed" on, so dismissals live here instead: localStorage, keyed by the
// nudge's own stable key, mirroring settings.js's conventions (namespaced
// key, a clearAll swept into App Reset). Deliberately NOT exported/backed
// up — dismissals are device-local UI state, not portable domain data, so
// restoring a backup on a new device never carries stale "I dismissed this"
// flags along with it.
import { todayYMD } from './dateUtils.js';

const STORAGE_KEY = 'kennelOS.nudgeDismissals';
// A snoozed nudge is stored as SNOOZE + the day it comes back (YYYY-MM-DD).
const SNOOZE = 'until:';

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

export function isDismissed(key, today = todayYMD()) {
  const v = readAll()[key];
  if (v === undefined) return false;
  return !(typeof v === 'string' && v.startsWith(SNOOZE) && v.slice(SNOOZE.length) <= today);
}

// Hidden until `untilYMD` (Kels's Review my waitlist: "Not yet, remind me in a few
// days" on open picks), then it shows again. A plain dismiss wins over a snooze.
export function snooze(key, untilYMD) {
  const state = readAll();
  state[key] = `${SNOOZE}${untilYMD}`;
  writeAll(state);
}

// The day a snoozed nudge comes back, or null (not snoozed, or dismissed for good).
export function snoozedUntil(key) {
  const v = readAll()[key];
  return typeof v === 'string' && v.startsWith(SNOOZE) ? v.slice(SNOOZE.length) : null;
}

// When `key` was dismissed (ISO string), or null. For nudges that come back
// after a while (the cloud-backup nudge returns after 30 days).
export function dismissedAt(key) {
  const v = readAll()[key];
  return v && !String(v).startsWith(SNOOZE) ? v : null;
}

export function undismiss(key) {
  const state = readAll();
  delete state[key];
  writeAll(state);
}

export function dismiss(key) {
  const state = readAll();
  state[key] = new Date().toISOString();
  writeAll(state);
}

export function clearAll() {
  localStorage.removeItem(STORAGE_KEY);
}
