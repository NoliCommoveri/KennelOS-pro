// seedImport.js — shared logic for the optional breed+test seed (Test Planning
// Addendum §8–9). Used by BOTH the standalone Import Kennel Tests view
// (pages/kennel-tests-import.js) and the first-run kennel-setup wizard
// (assets/kennelSetupUI.js), so parse/group/apply live in exactly one place.
//
// Deliberately NOT part of the generic csvImport.js record engine: that engine
// is match-or-create against an entity repo; this appends to two kennel
// vocabularies (preferred_tests + preferred_breeds) and creates no records — a
// different shape. It reuses the vendored PapaParse but none of the entity
// mapping machinery.
import Papa from '../vendor/papaparse.min.mjs';
import { kennelRepo } from './kennelRepo.js';

// App-root-relative path to the bundled starter file. Prefixed at call time so
// it resolves from index.html or from a /pages/*.html page (same convention as
// nav.js's rootPrefix), and from any GitHub Pages sub-path.
export const SEED_RESOURCE_PATH = 'resources/common_tests_by_breed_seed.csv';

export const ci = (s) => String(s ?? '').trim().toLowerCase();

function rootPrefix() {
  return location.pathname.includes('/pages/') ? '../' : '';
}

// Parse a CSV file or text blob into raw rows. `comments: '#'` skips the
// disclaimer/how-to header the shipped file carries; header is
// `Breed Group,breed,test_name` (col A, "Breed Group", is optional — an older
// two-column `breed,test_name` file still parses, just with an empty group).
export function parseSeedCsv(fileOrText) {
  return new Promise((resolve, reject) => {
    Papa.parse(fileOrText, {
      header: true,
      comments: '#',
      skipEmptyLines: 'greedy',
      transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, '_'),
      transform: (v) => (typeof v === 'string' ? v.trim() : v),
      complete: (res) => resolve(res.data || []),
      error: reject
    });
  });
}

// Group rows by breed, preserving first-seen display casing for both breed and
// test, and de-duplicating tests within a breed (case-insensitive). Each group
// also carries `breedGroup` — the col-A "Breed Group" value (e.g. "Sporting"),
// used to power the breed-group browse dropdown in the picker UI; '' if the
// file has no Breed Group column. Returns
// [{ key, display, breedGroup, tests: [{ key, display }] }], sorted by breed name.
export function buildSeedGroups(rows) {
  const byBreed = new Map();
  for (const row of rows) {
    const breed = String(row.breed ?? '').trim();
    const test = String(row.test_name ?? row.test ?? '').trim();
    const breedGroup = String(row.breed_group ?? '').trim();
    if (!breed || !test) continue;
    const bKey = ci(breed);
    if (!byBreed.has(bKey)) byBreed.set(bKey, { key: bKey, display: breed, breedGroup, tests: new Map() });
    const g = byBreed.get(bKey);
    if (!g.breedGroup && breedGroup) g.breedGroup = breedGroup;
    const tKey = ci(test);
    if (!g.tests.has(tKey)) g.tests.set(tKey, { key: tKey, display: test });
  }
  return [...byBreed.values()]
    .map((g) => ({ key: g.key, display: g.display, breedGroup: g.breedGroup, tests: [...g.tests.values()] }))
    .sort((a, b) => a.display.localeCompare(b.display));
}

// Unique, sorted breed-group names present across a set of groups (empty
// values excluded) — powers the "browse by breed group" dropdown.
export function listBreedGroups(groups) {
  return [...new Set(groups.map((g) => g.breedGroup).filter(Boolean))].sort();
}

// Convenience: parse a picked File into groups.
export async function groupsFromFile(file) {
  return buildSeedGroups(await parseSeedCsv(file));
}

// Fetch + parse the bundled starter file into groups. Returns [] if the file
// can't be reached (e.g. offline before it was precached) — callers treat an
// empty result as "no prefill available," never an error to surface loudly.
export async function fetchBundledSeedGroups() {
  try {
    const res = await fetch(`${rootPrefix()}${SEED_RESOURCE_PATH}`, { cache: 'no-store' });
    if (!res.ok) return [];
    return buildSeedGroups(await parseSeedCsv(await res.text()));
  } catch {
    return [];
  }
}

// Append the selected breeds (and their tests) to a kennel's vocabularies.
// Each test is tagged with the breed(s) it was imported for
// (kennelRepo.addPreferredTest's third arg -> preferred_test_breeds), which is
// what lets the kennel detail page show "(Breed1, Breed2)" after a test name
// and lets new-dog auto-fill scope the panel to one dog's own breed
// (kennelRepo.testsForBreed). Dedupe lives in the repo (case-insensitive);
// this only tallies what was genuinely new so callers can report accurate
// counts. Add-only, never wipes.
export async function applySeedToKennel(kennelId, groups, selectedKeys) {
  const selected = selectedKeys instanceof Set ? selectedKeys : new Set(selectedKeys);
  const before = await kennelRepo.getById(kennelId);
  const haveTests = new Set((before?.preferred_tests || []).map(ci));
  const haveBreeds = new Set((before?.preferred_breeds || []).map(ci));

  let breedsAdded = 0, testsAdded = 0;
  const countedTests = new Set();
  for (const g of groups) {
    if (!selected.has(g.key)) continue;
    await kennelRepo.addPreferredBreed(kennelId, g.display);
    if (!haveBreeds.has(g.key)) { haveBreeds.add(g.key); breedsAdded++; }
    for (const t of g.tests) {
      await kennelRepo.addPreferredTest(kennelId, t.display, g.display);
      if (!haveTests.has(t.key) && !countedTests.has(t.key)) { countedTests.add(t.key); testsAdded++; }
    }
  }
  return { breedsAdded, testsAdded };
}
