// pedigree.js — the reusable ancestor-tree renderer (Build Brief B2). The
// pedigree is entirely DERIVED from Dog.sire_id / Dog.dam_id (Data Model §7),
// so there's no pedigree table and no charting dependency to vendor: an ancestor
// pedigree is a fixed binary structure (each dog has exactly a sire slot and a
// dam slot), which we lay out ourselves with a classic "leaves get rows,
// parents center over their children" pass and draw with absolutely-positioned
// nodes over an SVG connector layer.
//
// DELIBERATELY NOT KENNEL-SCOPED (Multi-Kennel Scope Spec §7). Ancestry crosses
// kennels by definition — a dam bought in from another program, a sire standing
// at your second kennel, an outside stud — so no read in this file consults the
// active scope. Truncating a pedigree at a kennel boundary is the single most
// damaging regression this feature could cause: it would look like a complete
// tree while silently omitting half the lineage.
//
// Dogs with unknown parents render as a visible placeholder node (never a
// truncated branch). Clicking a node re-centers the tree on that dog via the
// caller-supplied onNavigate; a small link opens the dog's full record.
//
// `editable`: every ancestor box gets a ✎ and every Unknown box a "+ Add", to fix
// that spot (its child's sire or dam) in place — a dog on file, a new
// pedigree-only dog, or cleared (data/pedigreeEdit.js). The tree redraws after.
import { dogRepo, dogName } from '../data/dogRepo.js';
import { esc, fmtDate, dogOptgroups } from './ui.js';
import { setParent, addNewParent, spotCandidates, sexCorrectable } from '../data/pedigreeEdit.js';
import { editionFlags } from '../data/editionConfig.js';

const NODE_W = 190;
const NODE_H = 56;
const COL_GAP = 46;
const ROW_H = 74;
const SEX_BORDER = { male: '#3f78b5', female: '#8a52b5', unknown: '#9aa4b0' };

// Build the ancestor tree rooted at rootId, `generations` ancestor levels deep.
// A known dog at depth < generations always gets sire+dam children (placeholders
// when the parent is unknown/missing). Placeholders and dogs at the deepest
// level are leaves.
function buildTree(rootId, byId, generations) {
  let leafSeq = 0;
  // childId/role: the spot this node fills (its child's sire or dam); none for the root.
  function node(dogId, depth, childId = null, role = null) {
    const dog = dogId ? byId.get(dogId) : null;
    const n = { dogId, dog, depth, placeholder: !dog, childId, role };
    if (dog && depth < generations) {
      n.sire = node(dog.sire_id || null, depth + 1, dog.id, 'sire');
      n.dam = node(dog.dam_id || null, depth + 1, dog.id, 'dam');
    }
    return n;
  }
  const root = node(rootId, 0);

  // Vertical layout: each leaf claims the next row; each internal node centers
  // between its two children.
  let maxDepth = 0;
  (function assign(n) {
    maxDepth = Math.max(maxDepth, n.depth);
    if (n.sire && n.dam) {
      assign(n.sire); assign(n.dam);
      n.row = (n.sire.row + n.dam.row) / 2;
    } else {
      n.row = leafSeq++;
    }
  })(root);

  return { root, leafCount: leafSeq, maxDepth };
}

function flatten(root) {
  const out = [];
  (function walk(n) { out.push(n); if (n.sire) walk(n.sire); if (n.dam) walk(n.dam); })(root);
  return out;
}

function fixAttrs(n) { return `data-fix-child="${esc(n.childId)}" data-fix-role="${esc(n.role)}"`; }

function nodeHtml(n, editable) {
  if (n.placeholder) {
    const add = editable && n.childId ? `<button type="button" class="btn btn-sm ped-add" ${fixAttrs(n)} title="Add the ${esc(n.role)}">+ Add ${esc(n.role)}</button>` : '';
    return `<div class="ped-node ped-unknown" style="width:${NODE_W}px;height:${NODE_H}px;">
      <span class="faint">Unknown</span>${add}
    </div>`;
  }
  const d = n.dog;
  const dob = d.date_of_birth ? fmtDate(d.date_of_birth) : '';
  const reg = d.registered_name ? `<div class="ped-reg">${esc(d.registered_name)}</div>` : '';
  // A departed (archived) ancestor in Lite must stay a static node (cap spec §7):
  // no re-center link, no "arch" badge, no ↗ open-record link — otherwise a
  // curious user could open it, see it's only "archived", and infer an un-archive
  // bypass. The name still renders for lineage; it's just not clickable.
  const hideArchive = d.is_archived && !editionFlags.archivedDogLinks;
  const nameHtml = hideArchive
    ? `<span class="ped-name ped-name-static">${esc(dogName(d) || '(unnamed)')}</span>`
    : `<a href="#" class="ped-name" data-nav="${esc(d.id)}" title="Re-center on this dog">${esc(dogName(d) || '(unnamed)')}</a>`;
  const archBadge = d.is_archived && !hideArchive ? '<span class="badge badge-gray ped-arch">arch</span>' : '';
  const openLink = hideArchive ? '' : `<a class="ped-open" href="dog.html?id=${encodeURIComponent(d.id)}" title="Open record">↗</a>`;
  const fix = editable && n.childId && !hideArchive
    ? `<button type="button" class="ped-fix" ${fixAttrs(n)} title="Fix this spot" aria-label="Fix ${esc(n.role)} spot: ${esc(dogName(d) || 'this dog')}">✎</button>` : '';
  return `<div class="ped-node" style="width:${NODE_W}px;height:${NODE_H}px;border-left-color:${SEX_BORDER[d.sex] || SEX_BORDER.unknown};">
    <div class="ped-main">
      ${nameHtml}
      ${archBadge}
      ${openLink}
      ${fix}
    </div>
    ${reg}
    ${dob ? `<div class="ped-dob faint">${esc(dob)}</div>` : ''}
  </div>`;
}

// renderPedigree({ mount, rootId, generations=3, onNavigate, editable })
//   onNavigate(dogId) — called when a node name is clicked (re-center). If
//   omitted, name clicks fall back to navigating to the pedigree page.
//   editable — offer the fix-a-spot buttons (see the top of this file).
export async function renderPedigree(opts) {
  const { mount, rootId, generations = 3, onNavigate, editable = false } = opts;
  const dogs = await dogRepo.getAll({ includeArchived: true, includePedigreeOnly: true });
  const byId = new Map(dogs.map((d) => [d.id, d]));
  const rootDog = byId.get(rootId);

  if (!rootDog) {
    mount.innerHTML = `<div class="empty-state">Dog not found.</div>`;
    return;
  }

  const { root, leafCount, maxDepth } = buildTree(rootId, byId, generations);
  const nodes = flatten(root);

  const width = (maxDepth + 1) * NODE_W + maxDepth * COL_GAP;
  const height = Math.max(leafCount, 1) * ROW_H;

  const cx = (n) => n.depth * (NODE_W + COL_GAP);              // left edge
  const cyCenter = (n) => n.row * ROW_H + ROW_H / 2;           // vertical center

  // Connector paths: from a parent's right edge to each child's left edge (elbow).
  const paths = [];
  for (const n of nodes) {
    for (const child of [n.sire, n.dam]) {
      if (!child) continue;
      const x1 = cx(n) + NODE_W, y1 = cyCenter(n);
      const x2 = cx(child), y2 = cyCenter(child);
      const midX = x1 + COL_GAP / 2;
      paths.push(`M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`);
    }
  }

  const nodesHtml = nodes.map((n) => {
    const top = cyCenter(n) - NODE_H / 2;
    return `<div class="ped-pos" style="left:${cx(n)}px;top:${top}px;">${nodeHtml(n, editable)}</div>`;
  }).join('');

  // Build offspring section
  const offspring = dogs.filter((d) => d.sire_id === rootId || d.dam_id === rootId);
  const offspringByLitter = new Map();
  for (const pup of offspring) {
    const litterId = pup.litter_id || 'no-litter';
    if (!offspringByLitter.has(litterId)) offspringByLitter.set(litterId, []);
    offspringByLitter.get(litterId).push(pup);
  }

  // Sort each litter: males first, then females, then unknown
  for (const pups of offspringByLitter.values()) {
    pups.sort((a, b) => {
      const sexOrder = { male: 0, female: 1, unknown: 2 };
      return (sexOrder[a.sex] ?? 2) - (sexOrder[b.sex] ?? 2);
    });
  }

  // Sort litters: by oldest pup date_of_birth, litters with no dates last
  const sortedLitters = Array.from(offspringByLitter.entries()).sort((a, b) => {
    const [, pupsA] = a;
    const [, pupsB] = b;
    const oldestA = pupsA.reduce((oldest, pup) => {
      if (!pup.date_of_birth) return oldest;
      if (!oldest) return pup.date_of_birth;
      return pup.date_of_birth < oldest ? pup.date_of_birth : oldest;
    }, null);
    const oldestB = pupsB.reduce((oldest, pup) => {
      if (!pup.date_of_birth) return oldest;
      if (!oldest) return pup.date_of_birth;
      return pup.date_of_birth < oldest ? pup.date_of_birth : oldest;
    }, null);

    if (oldestA === null && oldestB === null) return 0;
    if (oldestA === null) return 1;
    if (oldestB === null) return -1;
    return oldestA.localeCompare(oldestB);
  });

  let offspringHtml = '';
  if (offspring.length > 0) {
    offspringHtml = '<div id="offspring" style="scroll-margin-top: 16px; margin-top: 24px; border-top: 1px solid var(--border); padding-top: 16px;"><h3 style="margin: 0 0 12px 0;">Offspring</h3>';
    for (const [litterId, pups] of sortedLitters) {
      offspringHtml += '<div style="margin-bottom: 12px;">';
      for (const pup of pups) {
        const otherParentId = pup.sire_id === rootId ? pup.dam_id : pup.sire_id;
        const otherParent = otherParentId ? byId.get(otherParentId) : null;
        const role = pup.sire_id === rootId ? 'Dam' : 'Sire';
        const otherParentName = otherParent ? esc(dogName(otherParent) || '(unnamed)') : '[Unknown parent]';
        const dob = pup.date_of_birth ? fmtDate(pup.date_of_birth) : '';
        const genderIndicator = pup.sex === 'male' ? 'M' : pup.sex === 'female' ? 'F' : '?';
        // A departed (archived) offspring in Lite is plain text — re-centering the
        // tree on it would expose the departed record the same way an open link
        // would (cap spec §7).
        const pupName = `${esc(dogName(pup) || '(unnamed)')} ${genderIndicator}`;
        const pupHtml = pup.is_archived && !editionFlags.archivedDogLinks
          ? `<span style="font-weight: 500;">${pupName}</span>`
          : `<a href="#" class="ped-pup-nav" data-pup-id="${esc(pup.id)}" style="font-weight: 500; color: var(--link-color); text-decoration: none; cursor: pointer;">${pupName}</a>`;
        offspringHtml += `<div style="display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--border-subtle);">
          <span style="font-size: 14px; color: var(--text-muted);">× ${otherParentName} (${role})</span>
          ${pupHtml}
          ${dob ? `<span style="font-size: 14px; color: var(--text-muted); margin-left: auto;">${esc(dob)}</span>` : ''}
        </div>`;
      }
      offspringHtml += '</div>';
    }
    offspringHtml += '</div>';
  }

  mount.innerHTML = `
    <div class="ped-scroll">
      <div class="ped-canvas" style="width:${width}px;height:${height}px;">
        <svg class="ped-lines" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
          ${paths.map((d) => `<path d="${d}" fill="none" stroke="var(--border-strong)" stroke-width="1.5"/>`).join('')}
        </svg>
        ${nodesHtml}
      </div>
    </div>
    ${offspringHtml}`;

  mount.querySelectorAll('[data-nav]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const id = a.dataset.nav;
      if (onNavigate) onNavigate(id);
      else location.href = `pedigree.html?id=${encodeURIComponent(id)}`;
    });
  });

  mount.querySelectorAll('[data-fix-child]').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.preventDefault();
      const changed = await fixSpotDialog({ dogs, childId: b.dataset.fixChild, role: b.dataset.fixRole });
      if (changed) await renderPedigree(opts);
    });
  });

  mount.querySelectorAll('[data-pup-id]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const id = a.dataset.pupId;
      if (onNavigate) onNavigate(id);
      else location.href = `pedigree.html?id=${encodeURIComponent(id)}`;
    });
  });
}

// --- Fixing one spot -------------------------------------------------------------
// The child's sire or dam: a dog on file, a new one typed in, or cleared.
// Resolves true when something changed.
function fixSpotDialog({ dogs, childId, role }) {
  const child = dogs.find((d) => d.id === childId);
  if (!child) return Promise.resolve(false);
  const field = role === 'sire' ? 'sire_id' : 'dam_id';
  const currentId = child[field] || null;
  const current = currentId ? dogs.find((d) => d.id === currentId) : null;
  const word = role === 'sire' ? 'Sire' : 'Dam';
  const label = (d) => `${dogName(d) || '(unnamed)'}${d.registration_number ? ` · ${d.registration_number}` : ''}`;
  const option = (d) => `<option value="${esc(d.id)}"${d.id === currentId ? ' selected' : ''}>${esc(label(d))}${d.id === currentId ? ' (here now)' : ''}</option>`;
  // A pedigree-only dog recorded as the other sex can still go here (its sex is
  // corrected with it, for a dog the importer misplaced) — listed last, on its own.
  const cands = spotCandidates(dogs, childId, role, currentId);
  const wrongSex = cands.filter((d) => sexCorrectable(d, role))
    .sort((a, b) => dogName(a).localeCompare(dogName(b), undefined, { sensitivity: 'base', numeric: true }));
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <h2 style="margin-top:0;">${esc(word)} of ${esc(dogName(child) || 'this dog')}</h2>
      <p class="muted">Here now: ${current ? `<strong>${esc(dogName(current))}</strong> <a href="dog.html?id=${encodeURIComponent(current.id)}">Edit ${esc(dogName(current))}’s details ↗</a>` : 'nobody recorded'}</p>
      <div class="field"><label for="pf-pick">Put here</label>
        <select id="pf-pick">
          <option value="new"${current ? '' : ' selected'}>A dog not in KennelOS — type it in…</option>
          ${dogOptgroups(cands.filter((d) => !sexCorrectable(d, role)), option, (d) => dogName(d))}
          ${wrongSex.length ? `<optgroup label="Recorded as ${role === 'sire' ? 'female' : 'male'}: made ${role === 'sire' ? 'male' : 'female'} if put here">${wrongSex.map(option).join('')}</optgroup>` : ''}
        </select></div>
      <div id="pf-new"${current ? ' hidden' : ''}>
        <div class="field"><label for="pf-name">Registered name <span class="req">*</span></label>
          <input id="pf-name" type="text" placeholder="As it reads on the pedigree"></div>
        <div class="field"><label for="pf-reg">Registration number</label>
          <input id="pf-reg" type="text" placeholder="Optional, e.g. NP806704/02"></div>
        <p class="field-hint">Added as a pedigree-only dog. If that registration number is already on a dog in KennelOS, that dog is used instead.</p>
      </div>
      <div id="pf-err"></div>
      <div class="form-actions">
        <button class="btn btn-primary" id="pf-save">Save</button>
        ${current ? '<button class="btn" id="pf-clear" title="Leave this spot empty; the dog stays in KennelOS">Clear this spot</button>' : ''}
        <button class="btn" id="pf-cancel">Cancel</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    const $ = (sel) => overlay.querySelector(sel);
    const done = (changed) => { overlay.remove(); resolve(changed); };
    const fail = (e) => { $('#pf-err').innerHTML = `<div class="inline-error">${esc(e?.message || String(e))}</div>`; };
    $('#pf-pick').addEventListener('change', () => { $('#pf-new').hidden = $('#pf-pick').value !== 'new'; });
    $('#pf-save').addEventListener('click', async () => {
      const pick = $('#pf-pick').value;
      try {
        if (pick === 'new') {
          await addNewParent(childId, role, { registered_name: $('#pf-name').value, registration_number: $('#pf-reg').value });
        } else if (pick !== currentId) {
          await setParent(childId, role, pick);
        } else { done(false); return; }
        done(true);
      } catch (e) { fail(e); }
    });
    $('#pf-clear')?.addEventListener('click', async () => {
      try { await setParent(childId, role, null); done(true); } catch (e) { fail(e); }
    });
    $('#pf-cancel').addEventListener('click', () => done(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
    if (!current) $('#pf-name').focus();
  });
}
