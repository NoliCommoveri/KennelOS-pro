// contact-import.js — wires the Contact CSV importer using the shared import view.
import { createImportView } from '../assets/importView.js';

createImportView({
  mount: document.getElementById('import-root'),
  entity: 'contact',
  listHref: 'contacts.html',
  listLabel: 'Contacts'
});
