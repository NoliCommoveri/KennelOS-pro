// sale-import.js — wires the Sale CSV importer using the shared import view.
import { createImportView } from '../assets/importView.js';

createImportView({
  mount: document.getElementById('import-root'),
  entity: 'sale',
  listHref: 'sales.html',
  listLabel: 'Sales'
});
