// litter-import.js — wires the Litter CSV importer using the shared import view.
import { createImportView } from '../assets/importView.js';

createImportView({
  mount: document.getElementById('import-root'),
  entity: 'litter',
  listHref: 'litters.html',
  listLabel: 'Litters'
});
