// kennel-import.js — wires the Kennel CSV importer using the shared import view.
import { createImportView } from '../assets/importView.js';

createImportView({
  mount: document.getElementById('import-root'),
  entity: 'kennel',
  listHref: 'kennels.html',
  listLabel: 'Kennels'
});
