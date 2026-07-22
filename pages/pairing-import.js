// pairing-import.js — wires the Pairing CSV importer using the shared import view.
import { createImportView } from '../assets/importView.js';

createImportView({
  mount: document.getElementById('import-root'),
  entity: 'pairing',
  listHref: 'pairings.html',
  listLabel: 'Pairings'
});
