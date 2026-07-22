// appReset.js — "Reset App to Start": a full, irreversible teardown of every
// table and every localStorage key this app owns, landing back on the exact
// same first-run state a browser that's never visited would see (Sample Data
// & Reset brief v1 covers clearing just the sample manifest; this is the
// superset — real data included, no reference guard, since nothing survives).
import { db, existingTableNames } from './db.js';
import { clearAllSettings } from './settings.js';
import { clearAll as clearNudgeDismissals } from './nudgeState.js';

// Live counts for the confirmation UI, across whatever tables exist at the
// current stage (stays correct as later stages add tables).
export async function getResetCounts() {
  const names = existingTableNames();
  const counts = {};
  for (const name of names) {
    counts[name] = await db.table(name).count();
  }
  return counts;
}

export async function resetApp() {
  const names = existingTableNames();
  await db.transaction('rw', names.map((n) => db.table(n)), async () => {
    for (const name of names) await db.table(name).clear();
  });
  clearAllSettings();
  clearNudgeDismissals();
}
