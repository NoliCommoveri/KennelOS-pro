// pedigree.js — the standalone Pedigree page. Picks a root dog (from ?id= or the
// dropdown), renders the ancestor tree, and re-centers in place when a node is
// clicked (updating the URL so the view is shareable/bookmarkable).
import { dogRepo } from '../data/dogRepo.js';
import { renderPedigree } from '../assets/pedigree.js';
import { esc, param } from '../assets/ui.js';
import { editionFlags } from '../data/editionConfig.js';

const rootSel = document.getElementById('ped-root');
const gensSel = document.getElementById('ped-gens');
const openLink = document.getElementById('ped-open-record');
const mount = document.getElementById('pedigree-mount');
const msg = document.getElementById('page-msg');

let dogs = [];
let currentId = null;

function fillPicker(selectedId) {
  const opts = dogs
    .slice()
    // Lite excludes departed (archived) dogs from the root picker so the tree
    // can't be centered on one (cap spec §7); the renderer still draws them as
    // static ancestor/offspring nodes for lineage.
    .filter((d) => editionFlags.includeArchivedToggles || !d.is_archived)
    .sort((a, b) => (a.call_name || '').localeCompare(b.call_name || ''))
    .map((d) => `<option value="${esc(d.id)}"${d.id === selectedId ? ' selected' : ''}>${esc(d.call_name || '(unnamed)')}${d.registered_name ? ' — ' + esc(d.registered_name) : ''}${d.is_archived ? ' (archived)' : ''}</option>`)
    .join('');
  rootSel.innerHTML = `<option value="">— select —</option>` + opts;
}

async function show(id) {
  currentId = id;
  // Lite: a departed (archived) dog isn't a reachable pedigree root (cap spec §7)
  // — even a hand-typed ?id= for one falls back to the empty state, and its
  // open-record link never shows.
  const rootDog = id ? dogs.find((d) => d.id === id) : null;
  const hiddenArchived = rootDog && rootDog.is_archived && !editionFlags.archivedDogLinks;
  if (!id || hiddenArchived) {
    mount.innerHTML = `<div class="empty-state">Choose a dog to view its pedigree.</div>`;
    openLink.style.visibility = 'hidden';
    return;
  }
  openLink.style.visibility = 'visible';
  openLink.href = `dog.html?id=${encodeURIComponent(id)}`;
  // Keep the URL in sync so the view is shareable and the back button works.
  const url = new URL(location.href);
  url.searchParams.set('id', id);
  history.replaceState(null, '', url);
  if (rootSel.value !== id) rootSel.value = id;

  await renderPedigree({
    mount,
    rootId: id,
    generations: Number(gensSel.value),
    onNavigate: (nextId) => show(nextId)
  });
}

async function main() {
  dogs = await dogRepo.getAll({ includeArchived: true });
  if (!dogs.length) {
    msg.innerHTML = `<div class="inline-warn" style="color:var(--accent-dark);background:var(--accent-soft);border-color:#bfe0cd;">No dogs yet. Add dogs first, then explore their pedigree here.</div>`;
    rootSel.disabled = true;
    gensSel.disabled = true;
    openLink.style.visibility = 'hidden';
    return;
  }
  const initial = param('id') || '';
  fillPicker(initial);
  rootSel.addEventListener('change', () => show(rootSel.value));
  gensSel.addEventListener('change', () => currentId && show(currentId));
  await show(initial);
}

main();
