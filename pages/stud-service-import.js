// stud-service-import.js — wires the StudService CSV importer using the shared import view.
import { createImportView } from '../assets/importView.js';

createImportView({
  mount: document.getElementById('import-root'),
  entity: 'stud_service',
  listHref: 'stud-services.html',
  listLabel: 'Stud Services'
});
