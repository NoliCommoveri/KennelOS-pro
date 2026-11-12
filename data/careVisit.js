// careVisit.js — Kels's care step (assets/careVisitUI.js): one "What did they
// have?" form whose answers fill the next ones, so a vet trip with shots, a fecal
// and a dewormer for four dogs is typed once. The rules and the events it makes;
// PURE: no repo, no DOM.
//
// The step: the kinds of care she ticks (CARE_STEPS), one date and the dogs; a
// vet visit's vet, reason, findings and cost there too. The visit is saved from
// that form; each other ticked kind then gets its own short form, already holding
// the date, the dogs and the vet:
//   shots       VACCINE_CHOICES as ticks (+ Other), each with when it's next due
//               → one `vaccination` per vaccine per dog (vaccineEvents);
//   screening   SCREENING_TESTS as ticks (+ Other), each with a result for every
//               dog or per dog → one `screening_test` per test per dog
//               (screeningEvents);
//   preventative / medication  the litter check-in's care form
//               (litterCheckin.CARE_KINDS).
import { VACCINE_NEXT_DUE, TEST_OUTCOME } from './vocab.js';
import { addDaysToYMD, addMonthsToYMD } from './dateUtils.js';
import { dogEvents } from './dogCare.js';

// The kinds of care, in the order their forms follow. `visit` is saved from the
// first form; `kind` is the litterCheckin.CARE_KINDS key a plain care form uses.
export const CARE_STEPS = Object.freeze([
  { key: 'visit', label: 'A vet visit', sub: 'Checkup, sick visit, exam' },
  { key: 'shots', label: 'Shots', sub: 'DHPP, rabies, bordetella…' },
  { key: 'screening', label: 'Screening tests', sub: 'Fecal, heartworm, brucellosis…' },
  { key: 'preventative', label: 'Deworming or flea & tick', sub: 'A dewormer, heartworm or flea & tick preventative', kind: 'preventative' },
  { key: 'medication', label: 'Other medication', sub: 'Antibiotics, eye drops…', kind: 'medication' }
]);
export const CARE_STEP_KEYS = Object.freeze(CARE_STEPS.map((s) => s.key));

const blank = (v) => String(v ?? '').trim() === '';
const money = (v) => !blank(v) && !(Number(v) >= 0);

// What's wrong with the first form, or ''. `steps`: the ticked CARE_STEPS keys.
export function careStepsProblem({ steps = [], dogIds = [], date = '', cost = '' }) {
  if (!steps.length) return 'Tick what they had: a vet visit, shots, tests, a preventative or a medication.';
  if (!dogIds.length) return 'Tick at least one dog.';
  if (!date) return 'When was it? Pick a date.';
  if (steps.includes('visit') && money(cost)) return 'The cost should be a number, like 85 or 85.50.';
  return '';
}

// The steps after the visit, in CARE_STEPS order.
export const followUps = (steps) => CARE_STEP_KEYS.filter((k) => k !== 'visit' && steps.includes(k));

// --- Shots ----------------------------------------------------------------------------

// When a shot given on `date` is next due (`choice`: a VACCINE_NEXT_DUE value), or ''.
export function nextDueFrom(date, choice) {
  const c = VACCINE_NEXT_DUE.find((x) => x.value === choice);
  if (!date || !c) return '';
  return c.days ? addDaysToYMD(date, c.days) : addMonthsToYMD(date, c.months);
}

// rows: [{ vaccine, nextDue, title? }] — the ticked ones only (an Other row with
// its name). `title`: her own title for that shot; blank takes the vaccine.
export function vaccineProblem({ rows = [], dogIds = [], date = '' }) {
  if (!rows.length) return 'Tick at least one shot, or type its name under Other.';
  if (rows.some((r) => blank(r.vaccine))) return 'What was the other shot called?';
  if (!dogIds.length) return 'Tick at least one dog.';
  if (!date) return 'When did they get them? Pick a date.';
  return '';
}

// One `vaccination` per ticked vaccine per dog, titled by her title, else the vaccine, its
// `next_due` from the row's choice; with `remind`, that day is its reminder too,
// so Today's Reminders brings it up.
export function vaccineEvents({ rows = [], dogIds = [], date, lot = '', remind = false }) {
  return rows.flatMap((r) => {
    const nextDue = nextDueFrom(date, r.nextDue);
    return dogEvents({
      eventType: 'vaccination', dogIds, date, title: r.title,
      details: { vaccine: r.vaccine, lot_number: lot, next_due: nextDue }
    }).map((e) => (remind && nextDue ? { ...e, reminder_date: nextDue } : e));
  });
}

// --- Screening tests ---------------------------------------------------------------------

// tests: [{ test, title?, result, outcome, perDog: { [dogId]: { result, outcome } } }] —
// the ticked ones. A dog's own result, when she typed one, wins over the one for
// all. `title`: her own title for that test; blank takes the test's name.
export function screeningProblem({ tests = [], dogIds = [], date = '' }) {
  if (!tests.length) return 'Tick at least one test, or type its name under Other.';
  if (tests.some((t) => blank(t.test))) return 'What was the other test called?';
  if (!dogIds.length) return 'Tick at least one dog.';
  if (!date) return 'When were they tested? Pick a date.';
  for (const t of tests) {
    for (const o of [t.outcome, ...Object.values(t.perDog || {}).map((p) => p.outcome)]) {
      if (!blank(o) && !TEST_OUTCOME.includes(o)) return `${t.test}: Normal or abnormal?`;
    }
  }
  return '';
}

// A dog's result for one test: their own, else the one for every dog.
export function resultFor(t, dogId) {
  const own = (t.perDog || {})[dogId] || {};
  return {
    result: blank(own.result) ? String(t.result ?? '').trim() : String(own.result).trim(),
    outcome: blank(own.outcome) ? String(t.outcome ?? '').trim() : String(own.outcome).trim()
  };
}

// One `screening_test` per test per dog, titled by her title, else the test; the vet linked.
export function screeningEvents({ tests = [], dogIds = [], date, relatedContactId = null }) {
  return tests.flatMap((t) => dogIds.flatMap((id) => dogEvents({
    eventType: 'screening_test', dogIds: [id], date, relatedContactId, title: t.title,
    details: { test: t.test, ...resultFor(t, id) }
  })));
}
