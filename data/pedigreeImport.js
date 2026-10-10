// pedigreeImport.js — turns one or more read pedigrees (data/pedigreeParse.js) into
// dog records: a dry-run PLAN the import page shows for review, then COMMIT.
//
// Matching follows the CSV import's rules (CLAUDE.md "CSV import"):
//   - A registration number is the natural key. The same number anywhere — twice
//     in one chart (line-breeding), across charts, or already in the app — is one
//     dog, matched automatically.
//   - A chart's names are registered names: they're compared with the registered
//     name of every dog in the app (current kennel dogs included, titles in front
//     ignored), never a call name.
//   - A name alone never matches anything automatically. A dog with no number
//     whose name equals another dog's in the batch, or any dog whose name equals
//     a dog already in the app (numbered or not — a number typed differently is
//     the likelier story), goes to review: same dog, or a separate one.
//   - Two sources that disagree on a dog's sire or dam go to review too; a parent
//     already recorded on an existing dog is never overwritten.
// New dogs are created pedigree-only (dogRepo `pedigree_only`) with the chart's
// name as their registered name and no call name (a chart doesn't give one); an existing dog —
// one of the kennel's own included — is only filled in where it's blank, never
// overwritten, and never made pedigree-only.
//
// planImport is pure (tests/pedigreeImport.test.js); commitImport writes through
// the repos inside one Dexie transaction, so a failed save leaves nothing behind.
import { db } from './db.js';
import { dogRepo, dogName } from './dogRepo.js';
import { documentRepo } from './documentRepo.js';
import { fileRepo } from './fileRepo.js';
import { resolveKennelIdForWrite } from './kennelScope.js';
import { splitTitles } from './pedigreeParse.js';

// A registration number's key: upper-cased, an "AKC" in front dropped, and only
// letters and digits kept — "NP165114/01", "np 165114-01", "AKC NP16511401" are
// one number however they were typed.
// An AKC number is two letters and eight digits; the four digits printed after it
// ("NP888072/07 03-25") are kept on the record but left out of the key, so the
// number matches whether or not they were typed.
export const normReg = (r) => {
  const k = String(r || '').toUpperCase().replace(/^\s*AKC\b[\s#:.-]*/, '').replace(/[^A-Z0-9]/g, '');
  return /^[A-Z]{2}\d{8}(\d{4})?$/.test(k) ? k.slice(0, 10) : k;
};
export const normName = (n) => String(n || '').replace(/[’‘`´]/g, "'").replace(/[“”]/g, '"')
  .trim().replace(/\s+/g, ' ').toLowerCase();

// The key two registered names are compared by: normName without the titles in
// front. A chart's titles go to notes when it's read, but the same dog already in
// the app is often saved as "GCH A-K Bella", so its titles come off too.
const nameKey = (n) => normName(splitTitles(String(n || '')).name);

const srcId = (fileId, path) => `${fileId}:${path}`;

// files: [{ id, name, breed, dogs: Map(path → parsed dog) }]
// existing: every dog in the app (archived and pedigree-only included).
// edits: { 'fileId:path': { registered_name?, registration_number?, color_markings? } }
// decisions: { candKey: 'new' | 'existing:<dogId>' | 'same:<candKey>' | ... ,
//              'sire:<candKey>': <candKey>, 'dam:<candKey>': <candKey> }
export function planImport({ files, existing = [], edits = {}, decisions = {} }) {
  // 1. Every box in every chart, with the review screen's edits applied.
  const nodes = [];
  for (const f of files) {
    for (const [path, d] of f.dogs) {
      const e = edits[srcId(f.id, path)] || {};
      nodes.push({
        fileId: f.id, path, breed: f.breed || '',
        dog: { ...d, ...e, notes: [...(d.notes || [])] }
      });
    }
  }

  // 2. Candidates: numbered boxes merge by number; unnumbered ones stand alone.
  const cands = new Map();
  const candOf = new Map(); // srcId → cand key
  for (const n of nodes) {
    const reg = normReg(n.dog.registration_number);
    const key = reg ? `r:${reg}` : `n:${srcId(n.fileId, n.path)}`;
    let c = cands.get(key);
    if (!c) {
      c = { key, reg, fields: {}, sources: [], sexes: new Set(), breed: '', subjectOf: [], sireKeys: new Map(), damKeys: new Map(), issues: [] };
      cands.set(key, c);
    }
    c.sources.push({ fileId: n.fileId, path: n.path });
    for (const f of ['registered_name', 'registration_number', 'registry', 'color_markings', 'date_of_birth']) {
      const v = n.dog[f];
      if (!v) continue;
      if (!c.fields[f]) c.fields[f] = v;
      else if (f === 'color_markings' && normName(v) !== normName(c.fields[f])) c.issues.push(`Colors differ between charts (“${c.fields[f]}” kept, “${v}” not).`);
    }
    c.fields.notes = [...new Set([...(c.fields.notes || []), ...n.dog.notes])];
    if (n.dog.sex && n.dog.sex !== 'unknown') c.sexes.add(n.dog.sex);
    if (!c.breed && n.breed) c.breed = n.breed;
    if (!n.path) c.subjectOf.push(n.fileId);
    candOf.set(srcId(n.fileId, n.path), key);
  }

  // 3. "Same dog" decisions fold one candidate into another.
  const alias = new Map();
  const resolve = (k) => { let x = k; const seen = new Set(); while (alias.has(x) && !seen.has(x)) { seen.add(x); x = alias.get(x); } return x; };
  for (const [k, v] of Object.entries(decisions)) {
    if (!cands.has(k) || typeof v !== 'string' || !v.startsWith('same:')) continue;
    const target = v.slice(5);
    if (cands.has(target) && resolve(target) !== k) alias.set(k, target);
  }
  for (const [k] of alias) {
    const from = cands.get(k);
    const to = cands.get(resolve(k));
    if (!from || !to || from === to) continue;
    for (const [f, v] of Object.entries(from.fields)) if (!to.fields[f]) to.fields[f] = v;
    to.fields.notes = [...new Set([...(to.fields.notes || []), ...(from.fields.notes || [])])];
    to.sources.push(...from.sources);
    from.sexes.forEach((s) => to.sexes.add(s));
    to.subjectOf.push(...from.subjectOf);
    to.issues.push(...from.issues);
    if (!to.breed) to.breed = from.breed;
    cands.delete(k);
  }
  for (const [s, k] of candOf) candOf.set(s, resolve(k));

  // 4. Parents, from each box's position in its chart.
  for (const n of nodes) {
    const c = cands.get(candOf.get(srcId(n.fileId, n.path)));
    const sire = candOf.get(srcId(n.fileId, `${n.path}s`));
    const dam = candOf.get(srcId(n.fileId, `${n.path}d`));
    // Each parent option remembers which charts gave it, for "use this chart's answers".
    for (const [k, map] of [[sire, c.sireKeys], [dam, c.damKeys]]) {
      if (!k || k === c.key) continue;
      if (!map.has(k)) map.set(k, new Set());
      map.get(k).add(n.fileId);
    }
  }

  // 5. Existing dogs.
  const byReg = new Map();
  const byName = new Map();
  for (const d of existing) {
    if (d.registration_number) byReg.set(normReg(d.registration_number), d);
    // A chart's names are registered names, so they're compared with the
    // registered name of every dog in the app — the kennel's own current dogs as
    // well as archived and pedigree-only ones — never a call name ("Bella" the
    // call name is not "Bella" the registered name).
    const nm = nameKey(d.registered_name);
    if (!nm) continue;
    if (!byName.has(nm)) byName.set(nm, []);
    byName.get(nm).push(d);
  }
  const candsByName = new Map();
  for (const c of cands.values()) {
    const nm = nameKey(c.fields.registered_name);
    if (!nm) continue;
    if (!candsByName.has(nm)) candsByName.set(nm, []);
    candsByName.get(nm).push(c);
  }

  const rows = [];
  for (const c of cands.values()) {
    const name = c.fields.registered_name || '';
    const nm = nameKey(name);
    const row = {
      key: c.key, name, registration_number: c.fields.registration_number || '', registry: c.fields.registry || '',
      color_markings: c.fields.color_markings || '', date_of_birth: c.fields.date_of_birth || '',
      notes: c.fields.notes || [], breed: c.breed,
      sex: c.sexes.size === 1 ? [...c.sexes][0] : (c.sexes.size ? [...c.sexes][0] : 'unknown'),
      sources: c.sources, subjectOf: c.subjectOf, issues: [...c.issues],
      action: 'new', existingId: null, choices: null, decision: decisions[c.key] || null,
      sireOptions: [...c.sireKeys.keys()], damOptions: [...c.damKeys.keys()],
      sireFrom: Object.fromEntries([...c.sireKeys].map(([k, v]) => [k, [...v]])),
      damFrom: Object.fromEntries([...c.damKeys].map(([k, v]) => [k, [...v]])),
      sireKey: null, damKey: null
    };
    if (c.sexes.size > 1) row.issues.push('Appears as a sire in one place and a dam in another.');
    if (!name) row.issues.push('No name was read.');

    const regMatch = c.reg ? byReg.get(c.reg) : null;
    if (regMatch) {
      row.action = 'existing';
      row.existingId = regMatch.id;
    } else {
      // Every dog in the app with this registered name is offered — one whose
      // number differs too, since a number typed or read differently is far more
      // likely than two dogs with one registered name. Never silently a new dog.
      const sameName = byName.get(nm) || [];
      for (const d of sameName) {
        if (c.reg && d.registration_number) row.issues.push(`Same registered name as your ${dogName(d)}, but the registration numbers differ (this chart: ${c.fields.registration_number}; yours: ${d.registration_number}).`);
      }
      const batchSame = (candsByName.get(nm) || []).filter((o) => o !== c && (!c.reg || !o.reg));
      if (nm && (sameName.length || batchSame.length)) {
        row.choices = [
          ...sameName.map((d) => ({ value: `existing:${d.id}`, label: `Same as your existing ${d.registered_name}${d.call_name && d.call_name !== d.registered_name ? ` “${d.call_name}”` : ''}${d.registration_number ? ` (${d.registration_number})` : ''}` })),
          ...batchSame.map((o) => ({ value: `same:${o.key}`, label: `Same as ${o.fields.registered_name}${o.reg ? ` (${o.fields.registration_number})` : ''} from another chart` })),
          { value: 'new', label: 'A separate dog' }
        ];
        const d = decisions[c.key];
        if (d === 'new') row.action = 'new';
        else if (d && d.startsWith('existing:') && row.choices.some((x) => x.value === d)) { row.action = 'existing'; row.existingId = d.slice(9); }
        else row.action = 'review';
      }
    }
    rows.push(row);
  }

  // 6. Parent choices. A parent already on an existing dog stays; otherwise a
  //    single answer is taken and two answers need a decision.
  const rowByKey = new Map(rows.map((r) => [r.key, r]));
  const existingById = new Map(existing.map((d) => [d.id, d]));
  for (const r of rows) {
    for (const side of ['sire', 'dam']) {
      const opts = r[`${side}Options`];
      const kept = r.existingId ? existingById.get(r.existingId)?.[`${side}_id`] : null;
      if (kept) {
        const differs = opts.some((k) => rowByKey.get(k)?.existingId !== kept);
        if (opts.length && differs) r.issues.push(`Already has a ${side} recorded; it's kept, not replaced.`);
        r[`${side}Key`] = null;
      } else if (opts.length === 1) {
        r[`${side}Key`] = opts[0];
      } else if (opts.length > 1) {
        const d = decisions[`${side}:${r.key}`];
        if (d && opts.includes(d)) r[`${side}Key`] = d;
        else r[`${side}Conflict`] = true;
      }
    }
  }

  const blocking = rows.filter((r) => r.action === 'review' || r.sireConflict || r.damConflict || !r.name);
  const missingBreed = rows.filter((r) => r.action === 'new' && !r.breed);
  return {
    rows,
    counts: {
      total: rows.length,
      created: rows.filter((r) => r.action === 'new').length,
      matched: rows.filter((r) => r.action === 'existing').length,
      review: blocking.length
    },
    ready: blocking.length === 0 && missingBreed.length === 0
  };
}

// Writes a ready plan. storeFiles: [{ fileId, blob, filename, kennelId? }] — the
// PDFs the user asked to keep, filed as a "pedigree" document on that chart's dog.
// A document carries one of the user's own kennels; it's inherited from the dog
// when the dog has one, else the active/sole kennel, else `kennelId` (the page
// asks when it can't be worked out — a pedigree-only dog lends none).
// Returns { created, updated, subjects: { fileId → dogId } }.
export async function commitImport(plan, { storeFiles = [] } = {}) {
  if (!plan.ready) throw new Error('Resolve the dogs marked for review before importing.');
  const byKey = new Map(plan.rows.map((r) => [r.key, r]));
  const idOf = new Map();
  let created = 0;
  let updated = 0;

  // Parents before children, so each new dog is created with its parents' ids.
  const order = [];
  const seen = new Set();
  const visit = (k, stack = new Set()) => {
    if (seen.has(k) || stack.has(k)) return;
    stack.add(k);
    const r = byKey.get(k);
    for (const p of [r.sireKey, r.damKey]) if (p && byKey.has(p)) visit(p, stack);
    seen.add(k);
    order.push(r);
  };
  for (const r of plan.rows) visit(r.key);

  const tables = [db.dogs, db.kennels, db.documents, db.files];
  await db.transaction('rw', tables, async () => {
    for (const r of order) {
      const sire_id = r.sireKey ? idOf.get(r.sireKey) || null : null;
      const dam_id = r.damKey ? idOf.get(r.damKey) || null : null;
      if (r.action === 'existing') {
        const ex = await dogRepo.getById(r.existingId);
        const changes = {};
        const fill = { registered_name: r.name, registration_number: r.registration_number, registry: r.registry,
          color_markings: r.color_markings, date_of_birth: r.date_of_birth, sire_id, dam_id };
        for (const [f, v] of Object.entries(fill)) if (v && !ex[f]) changes[f] = v;
        if (Object.keys(changes).length) { await dogRepo.update(ex.id, changes); updated++; }
        idOf.set(r.key, ex.id);
      } else {
        const d = await dogRepo.create({
          call_name: '', registered_name: r.name, sex: r.sex || 'unknown', breed: r.breed,
          ownership_type: 'external', status: 'external_reference', pedigree_only: true,
          registration_number: r.registration_number, registry: r.registry, color_markings: r.color_markings,
          date_of_birth: r.date_of_birth || '', notes: r.notes.join('\n'), sire_id, dam_id
        });
        idOf.set(r.key, d.id);
        created++;
      }
    }
  });

  const subjects = {};
  for (const r of plan.rows) for (const f of r.subjectOf) subjects[f] = idOf.get(r.key);

  // The kept PDFs, filed after the dogs exist. A failure here leaves the dogs
  // (they're the point) and reports which file didn't save.
  const fileErrors = [];
  for (const sf of storeFiles) {
    const dogId = subjects[sf.fileId];
    if (!dogId) continue;
    try {
      const subject = plan.rows.find((r) => r.subjectOf.includes(sf.fileId));
      const kennel_id = await resolveKennelIdForWrite({ inheritFrom: await dogRepo.getById(dogId) }) || sf.kennelId || null;
      if (!kennel_id) throw new Error('choose which of your kennels to file it under');
      const fileId = await fileRepo.create(sf.blob, { filename: sf.filename });
      await documentRepo.create({ dog_id: dogId, doc_type: 'pedigree', title: 'Pedigree', file_id: fileId, kennel_id,
        registry: subject?.registry || '', registration_number: subject?.registration_number || '' });
    } catch (e) {
      fileErrors.push(`${sf.filename}: ${e.message || e}`);
    }
  }
  return { created, updated, subjects, fileErrors };
}
