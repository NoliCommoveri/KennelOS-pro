// healthTestLog.js — logging a completed health test: which test event type a
// test name goes with, the event it makes, and which of a dog's planned tests
// are still unlogged. Shared by the Dog page's Planned Tests card ("Log result")
// and Kels's "Log health test results" (assets/healthTestsUI.js). PURE: no
// repo, no DOM.
//
// A test's name always goes in its type's name field (genetic_test.panel_name,
// ofa_pennhip.joint, breed_specific_test.test_name), so eventRepo.testTokensOf
// reads it back exactly as planned and the planned test counts as logged. The
// type only files it; matching is by name whatever the type.
import { testGapRows } from './breedingReports.js';

export const TEST_TYPES = Object.freeze(['genetic_test', 'ofa_pennhip', 'breed_specific_test']);

// Each test type's name field and result field (vocab.js EVENT_TYPES' fields).
export const TEST_TYPE_FIELDS = Object.freeze({
  genetic_test: { name: 'panel_name', result: 'result', lab: 'lab' },
  ofa_pennhip: { name: 'joint', result: 'rating', lab: null },
  breed_specific_test: { name: 'test_name', result: 'result', lab: null }
});

const key = (s) => String(s ?? '').trim().toLowerCase();

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
// kept only where the type has a lab field (Genetic test).
export function testEvent({ dogId, name, type, date, result = '', lab = '' }) {
  const t = TEST_TYPE_FIELDS[type] ? type : 'breed_specific_test';
  const f = TEST_TYPE_FIELDS[t];
  const n = String(name ?? '').trim();
  const details = { [f.name]: n };
  if (String(result).trim()) details[f.result] = String(result).trim();
  if (f.lab && String(lab).trim()) details[f.lab] = String(lab).trim();
  return { subject_type: 'dog', subject_id: dogId, event_type: t, event_date: date, title: n, details };
}

// This dog's planned tests with no matching result logged, in plan order.
export function unloggedPlanned(dog, events, tokensOf) {
  return testGapRows([dog], events.filter((e) => !e.is_archived), tokensOf)[0].missing;
}
