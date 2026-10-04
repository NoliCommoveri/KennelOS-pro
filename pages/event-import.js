// event-import.js — wires the Event CSV importer using the shared import view.
import { createImportView } from '../assets/importView.js';

createImportView({
  mount: document.getElementById('import-root'),
  entity: 'event',
  listHref: 'dogs.html',
  listLabel: 'Dogs'
});
