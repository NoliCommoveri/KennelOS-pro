// sampleDataUI.js — the guided tour's sample data in the shell (Load Performance
// plan D1–D4): the strip under the nav while it's loaded, leaving the tour, and
// clearing the seed by itself.
//
// The seed lives only while the tour is active, and only in the browsing session
// that seeded it (D2). app.js calls autoClearTourSeed() on every page load before
// anything else renders: any other load clears the seed and reloads once, and the
// kennel-setup gate follows (kennelSetup.shouldRequireKennelSetup). The tour is
// read-only (demoMode.assertWritable), so a new seed has nothing pointing at it
// and the clear always goes through; if it throws anyway, a strip says so with
// Try again, and the next load tries again. Never silent.
//
// An old seed from before the tour was read-only may have her real records
// pointing at it (D4): sampleData.clearSampleData moves links to the sample
// kennel to her own and clears the rest, and a one-time notice lists them. With
// no kennel of her own yet, kennel setup comes first and the clear runs after it.
//
// sampleData.js is loaded only when the seed is actually being cleared.
import {
  hasSampleData, getWizardStatusRaw, setWizardStatusRaw, tourSeedExpired,
  tookTourClearReload, setTourClearReload, setTourCleanupNotice, takeTourCleanupNotice
} from '../data/settings.js';
import { withSeedAllowed } from '../data/demoMode.js';
import { alertModal, confirmModal } from './ui.js';

const sampleData = () => import('../data/sampleData.js');

// The strip right under the nav on every page while the seed is loaded.
export function renderSampleBanner() {
  if (!hasSampleData()) return;
  const nav = document.getElementById('app-nav');
  if (!nav) return;
  const banner = document.createElement('div');
  banner.className = 'sample-banner';
  banner.innerHTML = `
    <span>You're in the tour's sample kennel. Nothing here is saved.</span>
    <button class="btn btn-sm" id="sample-banner-leave">Leave the tour</button>`;
  nav.insertAdjacentElement('afterend', banner);
  banner.querySelector('#sample-banner-leave').addEventListener('click', () => leaveTour());
}

// "Leave the tour" (the strip, Settings): ends the tour the way Skip does.
export async function leaveTour() {
  if (!(await confirmModal({
    title: 'Leave the tour?',
    message: 'The sample kennel (Thornfield Kennels) is removed, and you set up your own kennel next. You can see the tour again in the KennelOS demo.',
    confirmLabel: 'Leave the tour', cancelLabel: 'Stay'
  }))) return;
  if (getWizardStatusRaw() === 'active') setWizardStatusRaw('dismissed');
  await clearTourSeedAndReload();
}

// Clear the seed, then reload: the page that loads next has no seed and asks
// for her kennel. Returns true when a reload (or the kennel setup an old seed
// waits on) is under way, false when the clear failed (a strip says so).
export async function clearTourSeedAndReload({ kennelTarget = null } = {}) {
  let res;
  try {
    res = await withSeedAllowed(async () => (await sampleData()).clearSampleData({ kennelTarget }));
  } catch (e) {
    console.warn('KennelOS: clearing the tour\'s sample data', e);
    renderClearFailed();
    return false;
  }
  if (res.reason === 'needs-kennel') {
    await askKennelThenClear();
    return true;
  }
  if (res.detached?.length) setTourCleanupNotice(res.detached);
  setTourClearReload(true);
  location.reload();
  return true;
}

// An old seed whose sample kennel her own records are filed under, and no
// kennel of her own yet: set one up first (its save is let through the tour's
// guard), then the clear moves them there.
async function askKennelThenClear() {
  const { showKennelSetupModal } = await import('./kennelSetupUI.js');
  await showKennelSetupModal({
    mode: 'required',
    lead: 'Some of your own records are filed under the tour\'s sample kennel. Name your kennel and they move to it; then the sample kennel is removed.',
    duringTour: true,
    afterSave: (kennel) => clearTourSeedAndReload({ kennelTarget: kennel.id })
  });
}

// app.js boot, before anything renders. True when it is clearing (boot stops).
export async function autoClearTourSeed() {
  if (!hasSampleData()) { setTourClearReload(false); return false; }
  if (!tourSeedExpired()) return false;
  // Already cleared once and reloaded, and the seed is still here: say so and stop,
  // so it can't reload forever; the next load tries again.
  if (tookTourClearReload()) {
    setTourClearReload(false);
    renderClearFailed();
    return false;
  }
  return clearTourSeedAndReload();
}

function renderClearFailed() {
  if (document.getElementById('tour-clear-failed')) return;
  const bar = document.createElement('div');
  bar.id = 'tour-clear-failed';
  bar.className = 'cloud-notice cloud-notice-warning';
  bar.setAttribute('role', 'alert');
  bar.innerHTML = '<strong>Couldn\'t remove the tour\'s sample kennel.</strong> <button type="button" class="btn btn-sm">Try again</button>';
  bar.querySelector('button').addEventListener('click', () => { bar.remove(); clearTourSeedAndReload(); });
  const nav = document.getElementById('app-nav');
  if (nav) nav.insertAdjacentElement('afterend', bar); else document.body.prepend(bar);
}

// Once, after an old seed was cleared: what changed in her own records.
export async function showTourCleanupNotice() {
  const lines = takeTourCleanupNotice();
  if (!lines.length) return;
  await alertModal({
    title: 'The tour\'s sample kennel is gone',
    message: `Some of your own records pointed at the tour's sample records, so they changed:\n\n${lines.map((l) => `• ${l}`).join('\n')}`
  });
}
