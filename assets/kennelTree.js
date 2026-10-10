// kennelTree.js — renders the whole-kennel family tree (the Pedigree page's
// "Whole kennel" view). Layout is the pure data/kennelTree.js; this draws it the
// same way assets/pedigree.js draws one dog's ancestors: absolutely-positioned
// nodes over an SVG connector layer, no charting dependency.
//
// Each sire × dam pair draws as a bracket under the two parents meeting at a
// junction dot, which branches down a bus to every offspring of that pairing.
// Pairings are colour-cycled so crossing branches stay tellable apart.
//
// DELIBERATELY NOT KENNEL-SCOPED (Multi-Kennel Scope Spec §7) — see
// data/kennelTree.js.
import { dogRepo, dogName } from '../data/dogRepo.js';
import { buildKennelTree } from '../data/kennelTree.js';
import { esc, fmtDate } from './ui.js';
import { editionFlags } from '../data/editionConfig.js';

const NODE_W = 170;
const NODE_H = 52;
const H_GAP = 26;
const V_GAP = 92;
const PAD = 8;
const SLOT = NODE_W + H_GAP;
const SEX_BORDER = { male: '#3f78b5', female: '#8a52b5', unknown: '#9aa4b0' };
const UNION_COLORS = ['#2f6f4f', '#b5673f', '#3f78b5', '#8a52b5', '#9a7d1e', '#3a8f96', '#b5455f'];

function nodeHtml(d) {
  // A departed (archived) dog in Lite stays a static node (cap spec §7): no
  // re-center link, no "arch" badge, no ↗ — same rule as the ancestor tree.
  const hideArchive = d.is_archived && !editionFlags.archivedDogLinks;
  const name = esc(dogName(d) || '(unnamed)');
  const nameHtml = hideArchive
    ? `<span class="ped-name ped-name-static">${name}</span>`
    : `<a href="#" class="ped-name" data-nav="${esc(d.id)}" title="View this dog's pedigree">${name}</a>`;
  const archBadge = d.is_archived && !hideArchive ? '<span class="badge badge-gray ped-arch">arch</span>' : '';
  const openLink = hideArchive ? '' : `<a class="ped-open" href="dog.html?id=${encodeURIComponent(d.id)}" title="Open record">↗</a>`;
  const sub = d.date_of_birth ? fmtDate(d.date_of_birth) : (d.registered_name && d.registered_name !== dogName(d) ? d.registered_name : '');
  return `<div class="ped-node${d.pedigree_only ? ' kt-ancestor' : ''}" style="width:${NODE_W}px;height:${NODE_H}px;border-left-color:${SEX_BORDER[d.sex] || SEX_BORDER.unknown};">
    <div class="ped-main">${nameHtml}${archBadge}${openLink}</div>
    ${sub ? `<div class="ped-dob faint">${esc(sub)}</div>` : ''}
  </div>`;
}

function familyHtml(fam, index) {
  const left = (n) => PAD + n.x * SLOT;
  const top = (n) => PAD + n.gen * (NODE_H + V_GAP);
  const byId = new Map(fam.nodes.map((n) => [n.id, n]));
  const width = PAD * 2 + (fam.width - 1) * SLOT + NODE_W;
  const height = PAD * 2 + fam.rows * NODE_H + (fam.rows - 1) * V_GAP;

  // Several pairings can branch through the same gap between rows; give each
  // its own horizontal lane so their buses don't sit on top of one another.
  const laneCount = new Map();
  const paths = fam.unions.map((u, i) => {
    const parents = [u.sireId, u.damId].filter(Boolean).map((id) => byId.get(id));
    const kids = u.childIds.map((id) => byId.get(id));
    const childTop = Math.min(...kids.map(top));
    const lane = laneCount.get(childTop) || 0;
    laneCount.set(childTop, lane + 1);
    const off = (lane % 6) * 7;
    // A parent from an older generation reaches the litter down its own lane
    // (the layout's waypoints), stepping across in the gap above each row.
    const cx = (n) => left(n) + NODE_W / 2;
    const legs = parents.map((p) => {
      let d = `M ${cx(p)} ${top(p) + NODE_H}`;
      let x = cx(p), bottom = top(p) + NODE_H;
      for (const w of u.waypoints[p.id] || []) {
        const wx = cx(w), wTop = top(w);
        if (wx !== x) d += ` V ${wTop - 20 - off / 2} H ${wx}`;
        d += ` V ${wTop + NODE_H}`;
        x = wx; bottom = wTop + NODE_H;
      }
      return { d, x, bottom };
    });
    const parentBottom = Math.max(...legs.map((l) => l.bottom));
    const jy = Math.min(parentBottom + 14 + off, childTop - 30);
    const busY = childTop - 16 - (off / 2);
    const jx = legs.reduce((s, l) => s + l.x, 0) / legs.length;
    const segs = legs.map((l) => `${l.d} V ${jy} H ${jx}`);
    const xs = [jx, ...kids.map(cx)];
    segs.push(`M ${jx} ${jy} V ${busY}`, `M ${Math.min(...xs)} ${busY} H ${Math.max(...xs)}`);
    for (const k of kids) segs.push(`M ${cx(k)} ${busY} V ${top(k)}`);
    const color = UNION_COLORS[i % UNION_COLORS.length];
    return `<g stroke="${color}"><path d="${segs.join(' ')}" fill="none" stroke-width="1.6"/>`
      + `<circle cx="${jx}" cy="${jy}" r="3.5" fill="${color}" stroke="none"/></g>`;
  }).join('');

  const nodesHtml = fam.nodes.map((n) =>
    `<div class="ped-pos" data-kt-id="${esc(n.id)}" style="left:${left(n)}px;top:${top(n)}px;">${nodeHtml(n.dog)}</div>`
  ).join('');

  const gens = fam.rows === 1 ? '1 generation' : `${fam.rows} generations`;
  return `<section class="kt-family">
    <h3 class="kt-family-head">Family ${index + 1} <span class="faint">· ${fam.nodes.length} dogs · ${gens}</span></h3>
    <div class="ped-scroll">
      <div class="ped-canvas" style="width:${width}px;height:${height}px;">
        <svg class="ped-lines" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${paths}</svg>
        ${nodesHtml}
      </div>
    </div>
  </section>`;
}

function lonerHtml(d) {
  const hideArchive = d.is_archived && !editionFlags.archivedDogLinks;
  const name = esc(dogName(d) || '(unnamed)');
  const color = SEX_BORDER[d.sex] || SEX_BORDER.unknown;
  return hideArchive
    ? `<span class="kt-loner" style="border-left-color:${color};">${name}</span>`
    : `<a href="#" class="kt-loner" data-nav="${esc(d.id)}" data-kt-id="${esc(d.id)}" style="border-left-color:${color};">${name}</a>`;
}

// renderKennelTree({ mount, includePedigreeOnly, onNavigate })
//   onNavigate(dogId) — a dog's name was clicked (show that dog's pedigree).
// Returns the dogs drawn (for a "find dog" picker), in name order.
export async function renderKennelTree({ mount, includePedigreeOnly = false, onNavigate }) {
  const dogs = await dogRepo.getAll({ includeArchived: true, includePedigreeOnly: true });
  const { families, loners } = buildKennelTree(dogs, { includePedigreeOnly });

  if (!families.length && !loners.length) {
    mount.innerHTML = `<div class="empty-state">No dogs to chart yet.</div>`;
    return [];
  }

  const legend = `<div class="kt-legend faint">
    <span><i style="background:${SEX_BORDER.male}"></i>Male</span>
    <span><i style="background:${SEX_BORDER.female}"></i>Female</span>
    <span>● a pairing — its branch leads to that pair's offspring</span>
  </div>`;
  const noFamilies = families.length ? ''
    : `<div class="empty-state">No sire/dam links between your dogs yet. Set a dog's Sire and Dam on its record (or import a pedigree) and families appear here.</div>`;
  const lonersBlock = loners.length
    ? `<section class="kt-family">
        <h3 class="kt-family-head">No recorded relatives <span class="faint">· ${loners.length}</span></h3>
        <div class="kt-loners">${loners.map(lonerHtml).join('')}</div>
      </section>`
    : '';

  mount.innerHTML = legend + noFamilies + families.map(familyHtml).join('') + lonersBlock;

  mount.querySelectorAll('[data-nav]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (onNavigate) onNavigate(a.dataset.nav);
      else location.href = `pedigree.html?id=${encodeURIComponent(a.dataset.nav)}`;
    });
  });

  const drawn = [...families.flatMap((f) => f.nodes.map((n) => n.dog)), ...loners];
  return drawn.sort((a, b) => (dogName(a) || '').localeCompare(dogName(b) || ''));
}

// Scroll a drawn dog into view and flash it.
export function focusKennelTreeDog(mount, dogId) {
  const el = [...mount.querySelectorAll('[data-kt-id]')].find((n) => n.dataset.ktId === dogId);
  if (!el) return;
  mount.querySelectorAll('.kt-focus').forEach((n) => n.classList.remove('kt-focus'));
  el.classList.add('kt-focus');
  el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
}
