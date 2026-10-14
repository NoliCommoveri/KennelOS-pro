// csvBatch.js — the "Import several files" flow's brains (pages/import-batch.js):
// work out which importer each CSV file is for, from its column names, and the
// order to run them in, from what each importer's columns point at. Pure: no
// repo, no DOM (tests/csvBatch.test.js).
//
// Detection reads the same column names and aliases the import screens explain
// (data/csvImportHelp.js), so a column the importer accepts can't be missed
// here. Each name a file shares with an importer scores 1 / (how many importers
// accept that name), so a column only one importer reads ("event_type",
// "prefix") counts for more than one most of them read ("notes",
// "kennel_name"). A file is guessed at only when at least two of its columns,
// and at least a third of them, are that importer's (so a checklist that merely
// shares a few dog columns isn't taken for a dogs file); the page always lets
// the user change the guess.
//
// Order: each mapping declares `links`, the entities its columns point at
// (csvImport.js). A file runs after every file for an entity it links to, so a
// contact's kennel_name or a dog's breeder_kennel_name finds a kennel imported
// earlier in the same run. Files the user gave the same type keep their order.
import { importHelp, HELP_ENTITIES } from './csvImportHelp.js';
import { getMapping } from './csvImport.js';

// Each entity's own import page (relative to pages/). Two have set-up of their
// own, so the several-file flow hands those files to their screen instead of
// running them inline: Expense (each row attached on its own review screen) and
// Waitlist applications (which kennel's list they join). HANDOFF_ENTITIES maps
// each to the sentence that says why.
export const ENTITY_PAGE = {
  kennel: 'kennel-import.html', contact: 'contact-import.html', dog: 'dog-import.html',
  pairing: 'pairing-import.html', litter: 'litter-import.html', sale: 'sale-import.html',
  event: 'event-import.html', stud_service: 'stud-service-import.html',
  expense: 'expense-import.html', waitlist: 'waitlist-import.html'
};
export const HANDOFF_ENTITIES = new Map([
  ['expense', 'Expenses have their own import screen, where each one is attached to a dog, litter, pairing or kennel.'],
  ['waitlist', 'Waitlist applications have their own import screen, where you choose which kennel\'s list they join.']
]);

const norm = (h) => String(h ?? '').trim().toLowerCase().replace(/\s+/g, '_');

// entity -> Set of every column name (and alias) that importer reads.
function columnNames(entity) {
  const names = new Set();
  for (const c of importHelp(entity).columns) {
    names.add(c.name);
    for (const a of c.aliases || []) names.add(norm(a));
  }
  return names;
}

const MIN_MATCHED = 2;
const MIN_SHARE = 1 / 3;

// headers: a file's column names (any spelling; normalized like parseCsv).
// entities: which importers this edition offers. Returns the best guess
// (`entity` null when nothing fits), whether it's clear-cut (`sure`: the
// runner-up scores under two thirds of it), and every candidate ranked.
export function detectEntity(headers, entities = HELP_ENTITIES) {
  const cols = new Map(entities.map((e) => [e, columnNames(e)]));
  const readers = new Map(); // column name -> how many importers read it
  for (const names of cols.values()) for (const n of names) readers.set(n, (readers.get(n) || 0) + 1);

  const fileCols = [...new Set(headers.map(norm).filter(Boolean))];
  const ranked = entities.map((entity) => {
    const matched = fileCols.filter((h) => cols.get(entity).has(h));
    const score = matched.reduce((sum, h) => sum + 1 / readers.get(h), 0);
    return { entity, score, matched };
  }).sort((a, b) => b.score - a.score || b.matched.length - a.matched.length);

  const [top, second] = ranked;
  if (!top || top.matched.length < MIN_MATCHED || top.matched.length < fileCols.length * MIN_SHARE) return { entity: null, sure: false, ranked };
  const sure = !second || second.score < top.score * (2 / 3);
  return { entity: top.entity, sure, ranked };
}

// files: [{ entity, ... }] in the order the user picked them; entity null =
// skipped. Returns the files to run, ordered so each comes after every file for
// an entity it links to (a stable topological sort; skipped files dropped).
export function orderFiles(files) {
  const todo = files.filter((f) => f.entity);
  const present = new Set(todo.map((f) => f.entity));
  const ordered = [];
  const done = new Set(); // entities whose files are all placed
  while (todo.length) {
    // The first file (in the user's order) whose linked entities are all done,
    // or not in this run at all.
    let i = todo.findIndex((f) => getMapping(f.entity).links.every((e) => e === f.entity || done.has(e) || !present.has(e)));
    if (i === -1) i = 0; // a cycle can't happen with today's links; never stall if one is added
    const [f] = todo.splice(i, 1);
    ordered.push(f);
    if (!todo.some((t) => t.entity === f.entity)) done.add(f.entity);
  }
  return ordered;
}
