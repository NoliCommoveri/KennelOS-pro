// dog-import.js — wires the Dog CSV importer using the shared import view.
import { createImportView } from '../assets/importView.js';

createImportView({
  mount: document.getElementById('import-root'),
  entity: 'dog',
  listHref: 'dogs.html',
  listLabel: 'Dogs'
});
