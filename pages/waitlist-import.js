// waitlist-import.js — wires the waitlist application CSV importer (Waitlist
// Spec §5.1, W1d) using the shared import view. One list per kennel, so the page
// says which kennel's list it imports into (a picker once you have two own
// kennels); a row's own kennel_name column still wins. Pro-only page.
import { createImportView } from '../assets/importView.js';
import { getMapping } from '../data/csvImport.js';
import { esc, param } from '../assets/ui.js';
import { resolveWaitlistKennel, mountKennelPicker } from '../assets/waitlistUI.js';

const root = document.getElementById('import-root');
const { kennel, own } = await resolveWaitlistKennel(param('kennel'));
if (!kennel) {
  root.innerHTML = '<div class="empty-state">Set up your kennel first — each of your kennels keeps its own waitlist.</div>';
} else {
  document.querySelector('a[href="waitlist.html"]').href = `waitlist.html?kennel=${encodeURIComponent(kennel.id)}`;
  const picker = document.createElement('div');
  root.before(picker);
  mountKennelPicker(picker, { kennel, own });
  if (own.length < 2) picker.innerHTML = `<p class="muted">Importing into ${esc(kennel.kennel_name)}'s waitlist.</p>`;
  getMapping('waitlist').preferredKennelId = kennel.id;
  createImportView({ mount: root, entity: 'waitlist', listHref: `waitlist.html?kennel=${encodeURIComponent(kennel.id)}`, listLabel: 'Waitlist' });
}
