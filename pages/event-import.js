// event-import.js — wires the Event CSV importer using the shared import view.
import { createImportView } from '../assets/importView.js';
import { editionFlags } from '../data/editionConfig.js';

// Show rows always match on title too (Show Tracking Spec §8), so a same-day
// double-header needs distinct titles. Only said where the `show` type exists.
if (editionFlags.shows) {
  const sub = document.querySelector('.page-subtitle');
  if (sub) sub.textContent += ' For show events the title always takes part in the match — give each show of a same-day double-header its own title (e.g. "… Show 1" / "… Show 2").';
}

createImportView({
  mount: document.getElementById('import-root'),
  entity: 'event',
  listHref: 'dogs.html',
  listLabel: 'Dogs'
});
