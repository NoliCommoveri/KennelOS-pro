// appReset.js — "Reset App to Start": a full, irreversible teardown of every
// table and every localStorage key this app owns, landing back on the exact
// same first-run state a browser that's never visited would see (Sample Data
// & Reset brief v1 covers clearing just the sample manifest; this is the
// superset — real data included, no reference guard, since nothing survives).
import { db, existingTableNames } from './db.js';
import { clearAllSettings, clearAllAppStorage, getCloudBackupState, updateCloudBackupState } from './settings.js';
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
  stopCloudBackupAfterReset();
}

// Cloud Phase 1 plan §3.3: a reset ALWAYS turns cloud backup off on this device,
// so an emptied program can't overwrite the cloud copy. It also forgets which
// snapshot this device was in step with, so turning backup back on meets the
// server's 409 and goes through "restore that backup here / replace it"
// (plan §3.4) instead of pushing an empty program on a matching base. The
// sign-in itself is kept; signing out is the UI's separate choice
// (cloudAuth.signOut).
export function stopCloudBackupAfterReset() {
  const state = getCloudBackupState();
  if (!state.enabled && !state.lastSnapshotId) return;
  updateCloudBackupState({
    enabled: false, lastSnapshotId: null, lastCounts: null, lastContentHash: null, lastError: null
  });
}

// Remote erase (Cloud Phase 1 plan §2.5): the owner erased this device from
// another one, so nothing of theirs may stay. Reset App's teardown, plus
// everything a reset deliberately keeps: the license record, the cloud
// sign-in and device ids, and KennelAssistant's separate database.
export async function eraseThisDevice() {
  await resetApp();
  try { globalThis.indexedDB?.deleteDatabase('KennelOSAssistant'); } catch { /* not there */ }
  clearAllAppStorage();
}
