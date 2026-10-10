// kennelTree.js — pure layout for the whole-kennel family tree (the "Whole
// kennel" view of the Pedigree page). Where assets/pedigree.js draws ONE dog's
// ancestors (a fixed binary tree), this connects EVERY dog to its sire and dam
// at once, which is a general layered graph: dogs are grouped into families
// (connected components over sire/dam links), each family is laid out in
// generation rows (founders on top), and each sire × dam pair becomes a
// "union" whose junction branches down to that pair's offspring.
//
// Entirely DERIVED from Dog.sire_id / Dog.dam_id, like the ancestor tree — no
// stored structure. DELIBERATELY NOT KENNEL-SCOPED (Multi-Kennel Scope Spec §7)
// for the same reason: lineage crosses kennels, and a tree cut at a kennel
// boundary would look complete while silently dropping half the family.
//
// No DOM, no db — the renderer (assets/kennelTree.js) turns slot coordinates
// into pixels. Positions are in "slots": two dogs in a row are always at least
// 1 slot apart. Cycle-safe regardless of data (dogRepo blocks cycles on write,
// but a hand-edited import must not hang the page).

const SEX_ORDER = { male: 0, female: 1 };

// Least-squares placement of an ordered row: minimise Σ(x_i − want_i)² subject
// to x_{i+1} − x_i ≥ 1. Substituting y_i = x_i − i turns the gap constraint
// into "y non-decreasing", which pool-adjacent-violators solves exactly.
export function placeRow(want) {
  const blocks = []; // { sum, n }
  want.forEach((w, i) => {
    blocks.push({ sum: w - i, n: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
      if (a.sum / a.n <= b.sum / b.n) break;
      a.sum += b.sum; a.n += b.n; blocks.pop();
    }
  });
  const out = [];
  for (const b of blocks) for (let k = 0; k < b.n; k++) out.push(b.sum / b.n + out.length);
  return out;
}

const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;

// buildKennelTree(dogs, { includePedigreeOnly })
//   dogs — every Dog row (archived and pedigree-only included; this filters).
// Returns { families, loners }:
//   families — [{ nodes: [{ id, dog, gen, x }], unions: [{ key, sireId, damId,
//               childIds, waypoints }], width, rows }], largest family first.
//               waypoints[parentId] = [{ gen, x }] — the lane a parent's line
//               takes through each row between it and the litter (often []).
//   loners   — dogs with no parent or child among the included dogs, by name.
export function buildKennelTree(dogs, { includePedigreeOnly = false } = {}) {
  const included = dogs.filter((d) => includePedigreeOnly || !d.pedigree_only);
  const byId = new Map(included.map((d) => [d.id, d]));
  // A parent counts only when it's one of the included dogs (a pedigree-only
  // sire is simply absent when those are hidden — the child becomes a founder).
  const parentsOf = (d) => [d.sire_id, d.dam_id].filter((p) => p && p !== d.id && byId.has(p));

  const children = new Map(included.map((d) => [d.id, []]));
  for (const d of included) for (const p of parentsOf(d)) children.get(p).push(d.id);

  // Families: connected components over parent links (union-find).
  const root = new Map(included.map((d) => [d.id, d.id]));
  const find = (id) => { while (root.get(id) !== id) { root.set(id, root.get(root.get(id))); id = root.get(id); } return id; };
  for (const d of included) for (const p of parentsOf(d)) root.set(find(d.id), find(p));
  const groups = new Map();
  for (const d of included) {
    const r = find(d.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(d);
  }

  const families = [];
  const loners = [];
  for (const members of groups.values()) {
    if (members.length === 1) loners.push(members[0]);
    else families.push(layoutFamily(members, byId, parentsOf, children));
  }
  families.sort((a, b) => b.nodes.length - a.nodes.length);
  loners.sort((a, b) => nameKey(a).localeCompare(nameKey(b)));
  return { families, loners };
}

function nameKey(d) {
  return (d.call_name || d.registered_name || '').toLowerCase();
}

function layoutFamily(members, byId, parentsOf, children) {
  const ids = members.map((d) => d.id);

  // Generation = longest path down from a founder; an ancestor always sits
  // above its descendants. `visiting` breaks any cycle in bad data.
  const gen = new Map();
  const visiting = new Set();
  function genOf(id) {
    if (gen.has(id)) return gen.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const ps = parentsOf(byId.get(id));
    const g = ps.length ? Math.max(...ps.map(genOf)) + 1 : 0;
    visiting.delete(id);
    gen.set(id, g);
    return g;
  }
  ids.forEach(genOf);
  // Founders (no recorded parents here) drop to just above their earliest
  // offspring, so a stud bought in years later sits beside the dam he's paired
  // with instead of floating at the top of the chart.
  const founders = ids.filter((id) => !parentsOf(byId.get(id)).length && children.get(id).length);
  for (const id of founders) gen.set(id, Math.min(...children.get(id).map((c) => gen.get(c))) - 1);
  const minGen = Math.min(...ids.map((id) => gen.get(id)));
  for (const id of ids) gen.set(id, gen.get(id) - minGen);

  const rowCount = Math.max(...ids.map((id) => gen.get(id))) + 1;
  const rows = Array.from({ length: rowCount }, () => []);
  // Seed order: oldest first, males before females, then name — stable, so the
  // same data always draws the same chart.
  const seed = (a, b) => {
    const da = byId.get(a), db = byId.get(b);
    return (da.date_of_birth || '9999').localeCompare(db.date_of_birth || '9999')
      || (SEX_ORDER[da.sex] ?? 2) - (SEX_ORDER[db.sex] ?? 2)
      || nameKey(da).localeCompare(nameKey(db));
  };
  for (const id of ids.slice().sort(seed)) rows[gen.get(id)].push(id);

  // Unions: one per distinct (sire, dam) pair among the included parents. A
  // child with only one included parent gets a single-parent union.
  const up = (id) => parentsOf(byId.get(id));
  const unions = new Map();
  for (const id of ids) {
    const d = byId.get(id);
    const ps = up(id);
    if (!ps.length) continue;
    const sireId = ps.includes(d.sire_id) ? d.sire_id : null;
    const damId = ps.includes(d.dam_id) ? d.dam_id : null;
    const key = `${sireId || ''}|${damId || ''}`;
    if (!unions.has(key)) unions.set(key, { key, sireId, damId, childIds: [], waypoints: {} });
    unions.get(key).childIds.push(id);
  }

  // The layout graph. A parent more than one row above its pairing's litter
  // (a sire from an older generation, say) gets a waypoint in every row in
  // between: a placeholder that claims a slot like a dog does, so the line
  // runs down its own lane instead of behind some other dog's card.
  const lUp = new Map(ids.map((id) => [id, []]));
  const lDown = new Map(ids.map((id) => [id, []]));
  const link = (a, b) => { lDown.get(a).push(b); lUp.get(b).push(a); };
  for (const u of unions.values()) {
    const childGen = Math.max(...u.childIds.map((c) => gen.get(c)));
    for (const p of [u.sireId, u.damId].filter(Boolean)) {
      let prev = p;
      const way = [];
      for (let g = gen.get(p) + 1; g < childGen; g++) {
        const w = `~${u.key}~${p}~${g}`;
        lUp.set(w, []); lDown.set(w, []);
        rows[g].push(w);
        gen.set(w, g);
        link(prev, w);
        way.push(w);
        prev = w;
      }
      for (const c of u.childIds) link(prev, c);
      u.waypoints[p] = way;
    }
  }
  const all = [...lUp.keys()];

  const x = new Map();
  rows.forEach((row) => row.forEach((id, i) => x.set(id, i)));

  // Co-parents pull toward each other so a pair sits side by side over its litter.
  const mates = new Map(all.map((id) => [id, []]));
  for (const u of unions.values()) {
    if (u.sireId && u.damId) { mates.get(u.sireId).push(u.damId); mates.get(u.damId).push(u.sireId); }
  }
  const sexRank = (id) => (byId.has(id) ? SEX_ORDER[byId.get(id).sex] ?? 2 : 2);

  // Reorder a row by the barycenter of `nbrs`, then re-place it.
  function sweep(row, nbrs) {
    const key = new Map(row.map((id) => {
      const ns = nbrs(id);
      return [id, ns.length ? mean(ns.map((n) => x.get(n))) : x.get(id)];
    }));
    row.sort((a, b) => key.get(a) - key.get(b) || sexRank(a) - sexRank(b) || x.get(a) - x.get(b));
    placeRow(row.map((id) => key.get(id))).forEach((v, i) => x.set(row[i], v));
  }

  // Crossing reduction: alternate bottom-up (by offspring + co-parents) and
  // top-down (by parents) barycenter sweeps, ending top-down. A dog with
  // nothing in the sweep's direction follows its other links instead of
  // staying put, so a childless pup still tracks its parents.
  const byParents = (id) => (lUp.get(id).length ? lUp.get(id) : [...mates.get(id), ...lDown.get(id)]);
  const byOffspring = (id) => {
    const ns = [...lDown.get(id), ...mates.get(id)];
    return ns.length ? ns : lUp.get(id);
  };
  for (let pass = 0; pass < 6; pass++) {
    for (let g = rowCount - 2; g >= 0; g--) sweep(rows[g], byOffspring);
    for (let g = 0; g < rowCount; g++) sweep(rows[g], byParents);
  }
  // Final straightening without reordering: each dog drifts toward the middle
  // of everything it's linked to (parents, offspring, co-parents).
  for (let pass = 0; pass < 8; pass++) {
    for (const row of rows) {
      const want = row.map((id) => {
        const ns = [...lUp.get(id), ...lDown.get(id), ...mates.get(id)];
        return ns.length ? (x.get(id) + mean(ns.map((n) => x.get(n)))) / 2 : x.get(id);
      });
      placeRow(want).forEach((v, i) => x.set(row[i], v));
    }
  }

  const minX = Math.min(...all.map((id) => x.get(id)));
  for (const id of all) x.set(id, x.get(id) - minX);

  for (const u of unions.values()) {
    u.childIds.sort((a, b) => x.get(a) - x.get(b));
    for (const p of Object.keys(u.waypoints)) {
      u.waypoints[p] = u.waypoints[p].map((w) => ({ gen: gen.get(w), x: x.get(w) }));
    }
  }

  const nodes = ids.map((id) => ({ id, dog: byId.get(id), gen: gen.get(id), x: x.get(id) }))
    .sort((a, b) => a.gen - b.gen || a.x - b.x);
  return {
    nodes,
    unions: [...unions.values()],
    width: Math.max(...all.map((id) => x.get(id))) + 1,
    rows: rowCount
  };
}
