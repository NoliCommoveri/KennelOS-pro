// waitlistForm.js — her own application form (Waitlist Spec §15.1; End-State guide
// §29). PURE: no Dexie, no DOM, so it's unit-tested in tests/waitlistForm.test.js.
//
// The form is an ordered list of questions stored on the kennel as
// `waitlist_config.form_questions` (one form per kennel, riding the backup like the
// rest of the config). A kennel with no stored form uses DEFAULT_FORM_QUESTIONS.
//
// Two kinds of question:
//  - LOCKED questions carry a `key` because something depends on them: name and
//    email (contact matching, approval), the four preferences (eligibility, §6.2),
//    how soon they could buy (`ready_timing`, the readiness hold, §15.8), and the
//    public-list notice (§15.3). She can reword them but can't delete them
//    or change their type. Programs are never on the form: only she assigns them.
//  - Everything else is hers: add, delete, reorder, retype. The W1 defaults
//    (phone, city/state, household…) are ordinary questions whose ids happen to be
//    the old application keys, so W1 entries and contact creation keep working.
//
// Answers live in `entry.application`, keyed by question id. Each entry also keeps
// `application_questions`, a copy of the wording it was answered under, so editing
// or deleting a question later never scrambles an old application.

// Her wording, kept as given (decided 2026-10-06). Default text for the locked
// notice; she can edit it but not remove it.
export const PUBLIC_LIST_NOTICE = 'Please note that to ensures transparency and give our applicants peace of mind that their position in line is being honored, our waitlist is publicly available for viewing by prospective and waiting families. Your contact information will never be displayed, but some data like first name and gender preference will appear on the public list once you are added.';

// Types only locked questions use. `preference` answers live on the entry's pref_*
// fields, not in `application`; `notice` has no answer at all.
export const LOCKED_ONLY_TYPES = ['email', 'preference', 'notice'];
export const CHOICE_TYPES = ['single_choice', 'checkboxes'];

// The pref_* entry field behind each preference question.
export const PREFERENCE_FIELDS = {
  pref_sex: 'pref_sex',
  pref_breed: 'pref_breed',
  pref_purposes: 'pref_purposes',
  pref_colors: 'pref_colors',
  ready_timing: 'ready_timing'
};

// Default wording for the locked readiness question (her wording,
// 2026-10-07). She
// can reword it; its answers are fixed (vocab WAITLIST_READY_TIMING) because they
// decide the readiness hold.
export const READY_TIMING_LABEL = 'What is the soonest you are able to commit to the purchase of a puppy, should one become available?';

// Her wording (2026-10-07), shown just above the preference questions that
// decide which pups a family is offered at all (MATCHING_PREF_KEYS), so applicants
// know a narrow answer narrows their offers.
export const MATCHING_NOTICE = 'The following questions are designed to match you with your perfect pup. Please note that only puppies matching your answers below will be offered. When in doubt, select the wider option.';

// The preference questions that filter offers (waitlistRules.pupMatchesPrefs): sex,
// breed and purposes always; colors only when she has color matching on. Readiness
// is a hold, not a match, so it isn't one of them.
export function matchingPrefKeys(config) {
  return ['pref_sex', 'pref_breed', 'pref_purposes', ...(config && config.color_matching ? ['pref_colors'] : [])];
}

const q = (o) => Object.freeze({ required: false, help: '', options: [], ...o });

export const DEFAULT_FORM_QUESTIONS = Object.freeze([
  q({ id: 'name', key: 'name', label: 'Name', type: 'short_text', required: true }),
  q({ id: 'email', key: 'email', label: 'Email', type: 'email', required: true }),
  q({ id: 'phone', label: 'Phone', type: 'short_text' }),
  q({ id: 'location', label: 'City / state', type: 'short_text' }),
  q({ id: 'pref_sex', key: 'pref_sex', label: 'Do you prefer a male or a female?', type: 'preference' }),
  q({ id: 'pref_breed', key: 'pref_breed', label: 'Which breed?', type: 'preference' }),
  q({ id: 'pref_purposes', key: 'pref_purposes', label: 'What are you looking for in a puppy? Choose all that apply.', type: 'preference' }),
  q({ id: 'pref_colors', key: 'pref_colors', label: 'Any color preferences?', type: 'preference' }),
  q({ id: 'ready_timing', key: 'ready_timing', label: READY_TIMING_LABEL, type: 'preference', required: true }),
  q({ id: 'household', label: 'Tell us about your household', type: 'long_text' }),
  q({ id: 'other_pets', label: 'Other pets', type: 'long_text' }),
  q({ id: 'experience', label: 'Experience with the breed', type: 'long_text' }),
  q({ id: 'heard_from', label: 'How did you hear about us?', type: 'short_text' }),
  q({ id: 'about', label: 'Tell us about your family', type: 'long_text' }),
  q({ id: 'public_notice', key: 'public_notice', label: 'About our public waitlist', type: 'notice', help: PUBLIC_LIST_NOTICE })
]);

const LOCKED_DEFAULTS = DEFAULT_FORM_QUESTIONS.filter((x) => x.key);

// A form saved before the placement question became the purposes question
// (pet/show/breeding single choice → a multi-select mapped to registration) still
// holds the old key; it reads as the new one. Its old default wording is dropped
// for the new default, since it no longer fits a choose-all answer.
const LEGACY_KEYS = { pref_placement: { key: 'pref_purposes', oldLabel: 'Pet, show, or breeding?' } };
function upgradeLegacy(raw) {
  const legacy = raw && LEGACY_KEYS[raw.key];
  if (!legacy) return raw;
  return { ...raw, key: legacy.key, id: legacy.key, label: clean(raw.label) === legacy.oldLabel ? '' : raw.label };
}

export const isLocked = (question) => Boolean(question && question.key);
export const isChoice = (question) => CHOICE_TYPES.includes(question.type);
// Questions whose answer is stored in entry.application (not a preference, not the notice).
export const isAnswerQuestion = (question) => question.type !== 'preference' && question.type !== 'notice';

const clean = (v) => String(v ?? '').trim();

// The effective form for a kennel's config: her stored list (or the defaults),
// with every locked question guaranteed present exactly once and its type,
// required flag and key restored from the defaults. A locked question that has gone
// missing is put back where the defaults have it relative to its neighbours (or at
// the end). Ids are made unique; choice questions get an options array.
export function formQuestions(config) {
  const stored = config && Array.isArray(config.form_questions) && config.form_questions.length
    ? config.form_questions : DEFAULT_FORM_QUESTIONS;
  const out = [];
  const seenIds = new Set();
  const seenKeys = new Set();
  for (const stale of stored) {
    if (!stale || typeof stale !== 'object') continue;
    const raw = upgradeLegacy(stale);
    const locked = raw.key ? LOCKED_DEFAULTS.find((d) => d.key === raw.key) : null;
    if (raw.key && (!locked || seenKeys.has(raw.key))) continue; // unknown or duplicate lock
    const id = locked ? locked.id : clean(raw.id);
    if (!id || seenIds.has(id)) continue;
    const item = locked
      ? { ...locked, label: clean(raw.label) || locked.label, help: raw.help != null ? String(raw.help) : locked.help }
      : {
          id,
          label: clean(raw.label),
          type: LOCKED_ONLY_TYPES.includes(raw.type) || !raw.type ? 'short_text' : raw.type,
          required: Boolean(raw.required),
          help: String(raw.help ?? ''),
          options: []
        };
    if (locked && locked.type === 'notice' && !clean(item.help)) item.help = PUBLIC_LIST_NOTICE;
    if (!locked && isChoice(item)) item.options = (Array.isArray(raw.options) ? raw.options : []).map(clean).filter(Boolean);
    if (raw.source_header) item.source_header = clean(raw.source_header);
    seenIds.add(id);
    if (locked) seenKeys.add(locked.key);
    out.push(item);
  }
  for (const d of LOCKED_DEFAULTS) {
    if (seenKeys.has(d.key)) continue;
    const at = DEFAULT_FORM_QUESTIONS.indexOf(d);
    const before = DEFAULT_FORM_QUESTIONS.slice(0, at).reverse().find((x) => out.some((o) => o.id === x.id));
    const idx = before ? out.findIndex((o) => o.id === before.id) + 1 : 0;
    out.splice(idx, 0, { ...d });
    seenIds.add(d.id);
  }
  return out;
}

// Problems that block saving the form: blank wording, a choice question with no
// options. Returns an array of messages ([] = fine).
export function validateQuestions(questions) {
  const problems = [];
  questions.forEach((x, i) => {
    const n = `Question ${i + 1}`;
    if (!clean(x.label)) problems.push(`${n} needs some wording.`);
    if (isChoice(x) && !(x.options || []).filter((o) => clean(o)).length) problems.push(`${n} ("${clean(x.label) || 'untitled'}") needs at least one option.`);
  });
  return problems;
}

// A fresh question of `type`. `makeId` is injectable for tests.
export function newQuestion(type = 'short_text', makeId = () => crypto.randomUUID().slice(0, 8)) {
  return { id: `q_${makeId()}`, label: '', type, required: false, help: '', options: CHOICE_TYPES.includes(type) ? ['Option 1'] : [] };
}

// --- Answers -------------------------------------------------------------------

// The wording an entry's answers were given under: the questions stored in
// `application` (no preferences, no notice), trimmed to what's worth keeping.
export function snapshotQuestions(questions) {
  return questions.filter(isAnswerQuestion).map((x) => {
    const s = { id: x.id, label: x.label, type: x.type };
    if (isChoice(x)) s.options = [...(x.options || [])];
    return s;
  });
}

const humanize = (k) => {
  const s = String(k).replace(/_/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : String(k);
};

const hasValue = (v) => (Array.isArray(v) ? v.length > 0 : clean(v) !== '');

// The answer questions to show (and edit) for one entry. An entry that kept a
// snapshot shows its own wording, in its own order, followed by any question
// she's added since. An older entry (W1, or a CSV import before this) shows her
// current form, plus any stray answer keys it holds so nothing is hidden.
export function entryQuestions(entry, questions) {
  const current = questions.filter(isAnswerQuestion);
  const app = (entry && entry.application) || {};
  const snap = entry && Array.isArray(entry.application_questions) ? entry.application_questions : null;
  const out = [];
  const ids = new Set();
  const push = (x) => { if (!ids.has(x.id)) { ids.add(x.id); out.push(x); } };
  if (snap) {
    for (const s of snap) {
      const now = current.find((c) => c.id === s.id);
      // Keep the snapshot's wording; locked name/email keep their lock.
      push({ ...(now || {}), ...s, key: now ? now.key : undefined, required: now ? now.required : false, help: now ? now.help : '' });
    }
  }
  for (const c of current) push(c);
  for (const k of Object.keys(app)) {
    if (!ids.has(k) && hasValue(app[k])) push({ id: k, label: humanize(k), type: String(app[k]).length > 80 ? 'long_text' : 'short_text', required: false, help: '', options: [] });
  }
  return out;
}

// One answer as display text ('' when blank).
export function answerText(question, value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(clean).filter(Boolean).join(', ');
  if (question && question.type === 'yes_no') {
    const v = clean(value).toLowerCase();
    if (v === 'yes' || v === 'true') return 'Yes';
    if (v === 'no' || v === 'false') return 'No';
  }
  return String(value);
}

// Required answer questions left blank. Only name is enforced when she types an
// application in herself (Spec §15.1); the rest of "required" applies to the
// online form (W2). Returns the blank questions' labels.
export function missingRequired(questions, application, { manualEntry = true } = {}) {
  const app = application || {};
  return questions
    .filter(isAnswerQuestion)
    .filter((x) => (manualEntry ? x.key === 'name' : x.required))
    .filter((x) => !hasValue(app[x.id]))
    .map((x) => x.label);
}

// --- Importing questions from her old form's CSV (Spec §15.1) ----------------------

// Header normalization, identical to csvImport.parseCsv's transformHeader, so a
// question's `source_header` matches the importer's row keys.
export const normalizeHeader = (h) => String(h ?? '').trim().toLowerCase().replace(/\s+/g, '_');

// Column aliases for the locked and default questions, shared with the CSV
// application importer (csvImport.js) so both read the same columns.
export const IMPORT_ALIASES = {
  name: ['name', 'full_name', 'your_name', 'applicant_name'],
  email: ['email', 'email_address', 'your_email'],
  phone: ['phone', 'phone_number', 'telephone'],
  location: ['location', 'city_state', 'city', 'city_/_state', 'where_do_you_live'],
  heard_from: ['heard_from', 'how_did_you_hear_about_us', 'referral', 'source'],
  household: ['household', 'household_members', 'tell_us_about_your_household'],
  other_pets: ['other_pets', 'pets', 'current_pets'],
  experience: ['experience', 'breed_experience', 'dog_experience'],
  about: ['about', 'about_your_family', 'tell_us_about_your_family', 'anything_else'],
  pref_sex: ['pref_sex', 'sex', 'preferred_sex', 'male_or_female', 'gender', 'gender_preference'],
  pref_breed: ['pref_breed', 'breed', 'preferred_breed'],
  pref_purposes: ['pref_purposes', 'purposes', 'purpose', 'looking_for', 'pref_placement', 'pref_placement_type', 'placement', 'placement_type'],
  pref_colors: ['pref_colors', 'colors', 'color', 'preferred_color'],
  ready_timing: ['ready_timing', 'ready', 'readiness', 'ready_to_purchase', 'how_soon', 'soonest', 'when_can_you_commit',
    'what_is_the_soonest_you_are_able_to_commit_to_the_purchase_of_a_puppy,_should_one_become_available?']
};

// Headers that are the form tool's own bookkeeping, not a question.
const BOOKKEEPING = ['timestamp', 'submitted', 'submission_date', 'applied_date', 'date', 'submitted_at', 'kennel_name', 'kennel', 'program', 'notes'];

const strip = (s) => normalizeHeader(s).replace(/[^a-z0-9_]/g, '');

// The question id a header maps to: one of hers that was imported from this same
// column before, an alias match, or a question whose wording is the header.
function matchHeader(header, questions) {
  const n = normalizeHeader(header);
  const bare = strip(header);
  const byId = (id) => questions.find((x) => x.id === id) || null;
  const prior = questions.find((x) => x.source_header && (x.source_header === n));
  if (prior) return prior;
  for (const [id, aliases] of Object.entries(IMPORT_ALIASES)) {
    if (aliases.includes(n) || aliases.includes(bare)) {
      const hit = byId(id);
      if (hit) return hit;
    }
  }
  return questions.find((x) => x.type !== 'notice' && strip(x.label) === bare) || null;
}

const YES_NO = new Set(['yes', 'no', 'y', 'n', 'true', 'false']);
const DATE_RE = /^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})$/;

// Guess an answer type from a column's values. Google Forms writes checkbox
// answers as one cell joined by ", ".
export function guessType(values) {
  const vals = values.map(clean).filter(Boolean);
  if (!vals.length) return { type: 'short_text', options: [] };
  const lower = vals.map((v) => v.toLowerCase());
  if (lower.every((v) => YES_NO.has(v))) return { type: 'yes_no', options: [] };
  if (vals.every((v) => /^-?\d+(\.\d+)?$/.test(v.replace(/,/g, '')))) return { type: 'number', options: [] };
  if (vals.every((v) => DATE_RE.test(v))) return { type: 'date', options: [] };
  const longest = Math.max(...vals.map((v) => v.length));
  const distinct = [...new Set(vals)];
  if (vals.some((v) => v.includes(', '))) {
    const parts = vals.flatMap((v) => v.split(', ').map(clean)).filter(Boolean);
    const options = [...new Set(parts)];
    if (options.length <= 12 && options.length < parts.length && options.every((o) => o.length <= 60)) {
      return { type: 'checkboxes', options };
    }
  }
  if (distinct.length <= 6 && distinct.length < vals.length && longest <= 60) {
    return { type: 'single_choice', options: distinct };
  }
  return { type: longest > 80 ? 'long_text' : 'short_text', options: [] };
}

// One proposal per CSV column: map it onto one of her questions (`map`, with
// `targetId`), add it as a new question (`new`, with a guessed `question`), or skip
// it (`skip`, for the form tool's own columns and blank columns). She reviews and
// can change each one before anything is saved.
export function proposeQuestionImport(headers, rows, questions, makeId) {
  return headers.map((header) => {
    const n = normalizeHeader(header);
    const values = rows.map((r) => r[header]);
    const blank = !values.some((v) => clean(v));
    const target = matchHeader(header, questions);
    if (target) return { header, normalized: n, action: 'map', targetId: target.id, question: null };
    const guessed = guessType(values);
    const question = { ...newQuestion(guessed.type, makeId), label: clean(header), options: guessed.options };
    const skip = blank || BOOKKEEPING.includes(n);
    return { header, normalized: n, action: skip ? 'skip' : 'new', targetId: null, question };
  });
}

// Apply her reviewed proposals to the form. `map` stamps the target question's
// source_header (so the application importer reads that column into it); `new`
// appends the question (before the public-list notice) with its source_header.
export function applyQuestionImport(questions, proposals) {
  const out = questions.map((x) => ({ ...x }));
  const noticeAt = () => { const i = out.findIndex((x) => x.type === 'notice'); return i < 0 ? out.length : i; };
  for (const p of proposals) {
    if (p.action === 'map') {
      const t = out.find((x) => x.id === p.targetId);
      if (t) t.source_header = p.normalized;
    } else if (p.action === 'new' && p.question) {
      out.splice(noticeAt(), 0, { ...p.question, source_header: p.normalized });
    }
  }
  return out;
}

// The CSV columns the application importer should read for a question: its own
// imported column first, then the built-in aliases for that id.
export function columnsFor(question) {
  return [question.source_header, ...(IMPORT_ALIASES[question.id] || [])].filter(Boolean);
}

// --- The application FAQ (Spec §15.8) ----------------------------------------------

// Her questions and answers shown at the top of the application (price range, how
// the waitlist works…), stored as `waitlist_config.application_faq`: an ordered
// list of { id, question, answer }. Nothing depends on it, so it's entirely hers.
// The cleaned list: items with neither a question nor an answer are dropped.
export function formFaq(config) {
  const stored = config && Array.isArray(config.application_faq) ? config.application_faq : [];
  return stored
    .filter((x) => x && typeof x === 'object')
    .map((x, i) => ({ id: clean(x.id) || `faq_${i + 1}`, question: clean(x.question), answer: String(x.answer ?? '').trim() }))
    .filter((x) => x.question || x.answer);
}

// Problems that block saving the FAQ: an answer with no question, or the reverse.
export function validateFaq(items) {
  const problems = [];
  items.forEach((x, i) => {
    const has = (v) => clean(v) !== '';
    if (has(x.question) !== has(x.answer) && (has(x.question) || has(x.answer))) {
      problems.push(`FAQ ${i + 1} needs both a question and an answer.`);
    }
  });
  return problems;
}

export function newFaqItem(makeId = () => crypto.randomUUID().slice(0, 8)) {
  return { id: `faq_${makeId()}`, question: '', answer: '' };
}
