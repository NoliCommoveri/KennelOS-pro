// sampleDataUI.js — the persistent sample-data banner and the shared
// "Clear Sample Data" flow (Sample Data & Reset brief v1, §4). Shared by app.js
// (every page) and pages/import-export.js (the "Clear Sample Data" control).
// The first-run "explore vs. blank" choice moved into assets/onboardingUI.js;
// sample data is now seeded only as part of taking the guided tour.
import { hasSampleData, clearSampleData } from '../data/sampleData.js';
import { alertModal, confirmModal } from './ui.js';

// Persistent small banner, injected right after the nav on every page, shown
// only while sample data is loaded.
export async function renderSampleBanner() {
  if (!hasSampleData()) return;
  const nav = document.getElementById('app-nav');
  if (!nav) return;

  const banner = document.createElement('div');
  banner.className = 'sample-banner';
  banner.innerHTML = `
    <span>Viewing sample data</span>
    <button class="btn btn-sm" id="sample-banner-clear">Clear Sample Data</button>`;
  nav.insertAdjacentElement('afterend', banner);

  banner.querySelector('#sample-banner-clear').addEventListener('click', async () => {
    const result = await promptClearSampleData();
    if (result?.cleared) location.reload();
  });
}

// The clear flow itself — shared by the banner button and the Import/Export
// page's own "Clear Sample Data" control. Returns the clearSampleData() result,
// or undefined if the user backed out.
export async function promptClearSampleData() {
  if (!hasSampleData()) {
    await alertModal({ title: 'No sample data', message: 'There is no sample data loaded.' });
    return;
  }
  if (!(await confirmModal({
    title: 'Clear sample data?',
    message: 'Remove all sample data (Thornfield Kennels demo dogs, pairings, litters, contacts, kennels, and events)? This cannot be undone.',
    confirmLabel: 'Clear', danger: true
  }))) {
    return;
  }

  let result = await clearSampleData();

  if (!result.cleared && result.reason === 'contaminated') {
    const list = result.conflicts.map((c) => `• ${c}`).join('\n');
    const archive = await confirmModal({
      title: 'Archive sample dogs instead?',
      message: `Some of your own records now depend on sample dogs:\n\n${list}\n\n` +
        `These sample dogs can't be deleted while that's true. Archive them instead ` +
        `(hides them from active lists, keeps history intact) and clear the rest?`,
      confirmLabel: 'Archive & clear', cancelLabel: 'Cancel'
    });
    if (!archive) return result;
    result = await clearSampleData({ archiveConflicting: true });
  }

  if (result.cleared) {
    const parts = [`${result.counts.dogs} dog(s)`, `${result.counts.pairings} pairing(s)`,
      `${result.counts.litters} litter(s)`, `${result.counts.stud_services} stud service(s)`,
      `${result.counts.sales} sale(s)`, `${result.counts.contracts} contract(s)`,
      `${result.counts.events} event(s)`, `${result.counts.contacts} contact(s)`, `${result.counts.kennels} kennel(s)`];
    if (result.counts.archived) parts.push(`${result.counts.archived} archived instead of deleted`);
    await alertModal({ title: 'Sample data cleared', message: `Removed ${parts.join(', ')}.` });
  }
  return result;
}
