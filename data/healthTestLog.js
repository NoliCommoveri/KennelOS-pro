// healthTestLog.js — logging a completed health test: which test event type a
// test name goes with, the event it makes, and which of a dog's planned tests
// are still unlogged. Shared by the Dog page's Planned Tests card ("Log result")
// and Kels's "Log health test results" (assets/healthTestsUI.js). PURE: no
// repo, no DOM.
//
// A test's name always goes in its type's name field (genetic_test.panel_name,
// ofa_pennhip.joint, breed_specific_test.test_name), so eventRepo.testTokensOf
// reads it back exactly as planned and the planned test counts as logged; a
// result whose title is the test name counts too (eventRepo.testMatchTokensOf).
// The type only files it; matching is by name whatever the type.
import { testGapRows } from './breedingReports.js';
import { TEST_OUTCOME, TEST_RESULT_SUGGESTIONS } from './vocab.js';

export const TEST_TYPES = Object.freeze(['genetic_test', 'ofa_pennhip', 'breed_specific_test']);

// Each test type's name field and result field (vocab.js EVENT_TYPES' fields).
// Every test type's overall flag field: TEST_OUTCOME's 'Normal' / 'Abnormal', or unset.
export const TEST_OUTCOME_FIELD = 'outcome';

export const TEST_TYPE_FIELDS = Object.freeze({
  genetic_test: { name: 'panel_name', result: 'result', lab: 'lab' },
  ofa_pennhip: { name: 'joint', result: 'rating', lab: null },
  breed_specific_test: { name: 'test_name', result: 'result', lab: null }
});

const key = (s) => String(s ?? '').trim().toLowerCase();

// A test result's suggestions: TEST_RESULT_SUGGESTIONS in their own order, then
// every result she's typed before (`logged`, from any of the three types' result
// fields) not already listed, A→Z. Deduped case-insensitively; the first spelling
// wins.
export function testResultSuggestions(logged = []) {
  const seen = new Set(TEST_RESULT_SUGGESTIONS.map(key));
  const mine = [];
  for (const v of logged) {
    const t = String(v ?? '').trim();
    if (!t || seen.has(key(t))) continue;
    seen.add(key(t));
    mine.push(t);
  }
  return [...TEST_RESULT_SUGGESTIONS, ...mine.sort((a, b) => a.localeCompare(b))];
}

// A best guess from the name alone: OFA / PennHIP / hips / elbows are OFA /
// PennHIP; DNA, panels and the common genetic tests are Genetic; anything else
// (eye exams, hearing, cardiac…) Breed-specific.
const OFA = /\b(ofa|pennhip|penn ?hip|hips?|elbows?)\b/i;
const GENETIC = /\b(dna|genetic|genotype|panel|embark|wisdom|paw ?print|optigen|vgl|pra|prcd|dm|degenerative myelopathy|eic|cnm|mdr1|vwd|carrier)\b/i;
export function guessTestType(name) {
  const t = String(name ?? '');
  if (OFA.test(t)) return 'ofa_pennhip';
  if (GENETIC.test(t)) return 'genetic_test';
  return 'breed_specific_test';
}

// The type she's used most for this test name before (any dog), else the guess.
// `tokensOf` is eventRepo.testTokensOf (injected, keeping this module pure).
export function testTypeFor(name, events = [], tokensOf = () => []) {
  const k = key(name);
  const counts = new Map();
  for (const e of events) {
    if (e.is_archived || !TEST_TYPES.includes(e.event_type)) continue;
    if (tokensOf(e).some((t) => key(t) === k)) counts.set(e.event_type, (counts.get(e.event_type) || 0) + 1);
  }
  let best = null;
  for (const [type, n] of counts) if (!best || n > counts.get(best)) best = type;
  return best || guessTestType(name);
}

// The Dog page's event form prefill for one planned test (dated today).
export function testPrefill(name, type, today) {
  const f = TEST_TYPE_FIELDS[type] || TEST_TYPE_FIELDS.breed_specific_test;
  return { event_type: TEST_TYPE_FIELDS[type] ? type : 'breed_specific_test', event_date: today, title: String(name).trim(), details: { [f.name]: String(name).trim() } };
}

// The event for one completed test → an eventRepo.create candidate. `lab` is
// kept only where the type has a lab field (Genetic test); `outcome` only when
// it's one of TEST_OUTCOME.
export function testEvent({ dogId, name, type, date, result = '', lab = '', outcome = '' }) {
  const t = TEST_TYPE_FIELDS[type] ? type : 'breed_specific_test';
  const f = TEST_TYPE_FIELDS[t];
  const n = String(name ?? '').trim();
  const details = { [f.name]: n };
  if (String(result).trim()) details[f.result] = String(result).trim();
  if (f.lab && String(lab).trim()) details[f.lab] = String(lab).trim();
  if (TEST_OUTCOME.includes(outcome)) details[TEST_OUTCOME_FIELD] = outcome;
  return { subject_type: 'dog', subject_id: dogId, event_type: t, event_date: date, title: n, details };
}

// This dog's planned tests with no matching result logged, in plan order.
export function unloggedPlanned(dog, events, tokensOf) {
  return testGapRows([dog], events.filter((e) => !e.is_archived), tokensOf)[0].missing;
}

// Each dog's completed tests as family pages show them (Waitlist: parents' health
// tests): Map dogId → [{ name, result, outcome }], one row per test name (a retest replaces
// the older result: the latest event_date wins), in the order first tested. A
// result counts only when its type's result field is filled in; the name is the
// test's name as eventRepo.testTokensOf reads it (OFA: Method + Joint, "OFA
// Hips"), else the event title, as the Puppy Record names it. Archived events and
// non-dog subjects are skipped. `outcome` is 'Normal' / 'Abnormal' (TEST_OUTCOME)
// or '' when unflagged. Never the lab, notes, dates or documents.
export function completedTestsByDog(events = []) {
  const latest = new Map(); // dogId → Map(nameKey → event)
  const sorted = events
    .filter((e) => e && !e.is_archived && e.subject_type === 'dog' && TEST_TYPES.includes(e.event_type))
    .sort((a, b) => String(a.event_date || '').localeCompare(String(b.event_date || '')) || String(a.id).localeCompare(String(b.id)));
  for (const e of sorted) {
    const f = TEST_TYPE_FIELDS[e.event_type];
    // eventRepo.testTokensOf's naming, kept here so this module stays pure.
    const named = e.event_type === 'ofa_pennhip' ? [e.details?.method, e.details?.joint].filter(Boolean).join(' ') : e.details?.[f.name];
    const name = String(named ?? '').trim() || String(e.title ?? '').trim();
    const result = String(e.details?.[f.result] ?? '').trim();
    if (!name || !result) continue;
    const byName = latest.get(e.subject_id) || new Map();
    const k = key(name);
    const flag = String(e.details?.[TEST_OUTCOME_FIELD] ?? '').trim();
    const outcome = TEST_OUTCOME.find((o) => o.toLowerCase() === flag.toLowerCase()) || '';
    byName.set(k, { name, result, outcome }); // a retest keeps the first test's place
    latest.set(e.subject_id, byName);
  }
  return new Map([...latest].map(([id, byName]) => [id, [...byName.values()]]));
}
