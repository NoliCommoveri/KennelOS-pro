// programSuggest.js — an application question linked to one of her waitlist
// programs (End-State guide §29, "A question that suggests a program"). PURE: no
// Dexie, no DOM; tests/programSuggest.test.js.
//
// On her form, a yes/no or choice question of hers may carry
//   program_link: { program_id, answers: [answer text…] }
// ("Are you a military member?" → Yes → her Military program). An application
// whose answer is one of `answers` gets "Add to [program]?" (a Yes / No dropdown)
// on the family's page while the application is open (applied) and while it waits
// for its fee (approved). Yes puts them in the program; No is remembered on the
// entry (`program_suggestions_declined`, program ids) so it isn't asked again;
// once the fee is received (or the application closes) it's never asked. The
// link is read from her CURRENT form, so a link added later suggests for
// applications already in. Programs are never on the family's form: the link is
// hers only and the projection never publishes it.

export const LINKABLE_TYPES = Object.freeze(['yes_no', 'single_choice', 'checkboxes']);
export const SUGGEST_STATUSES = Object.freeze(['applied', 'approved']);

const clean = (v) => String(v ?? '').trim();

// The answers a linked question can be set to trigger on (display text).
export function linkAnswerChoices(question) {
  if (!question) return [];
  if (question.type === 'yes_no') return ['Yes', 'No'];
  return (question.options || []).map(clean).filter(Boolean);
}

// A question's link, cleaned: null unless it's a linkable, unlocked question with a
// program and at least one answer that's still one of its choices.
export function cleanProgramLink(question, raw = question && question.program_link) {
  if (!question || question.key || !LINKABLE_TYPES.includes(question.type)) return null;
  if (!raw || typeof raw !== 'object' || !clean(raw.program_id)) return null;
  const choices = linkAnswerChoices(question);
  const answers = [...new Set((Array.isArray(raw.answers) ? raw.answers : []).map(clean).filter((a) => choices.includes(a)))];
  return answers.length ? { program_id: clean(raw.program_id), answers } : null;
}

// The answer(s) an entry gave to one question, as display text.
function givenAnswers(question, value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  let t = clean(value);
  if (question.type === 'yes_no') t = ({ yes: 'Yes', true: 'Yes', no: 'No', false: 'No' })[t.toLowerCase()] || t;
  return question.type === 'checkboxes' ? t.split(',').map(clean).filter(Boolean) : (t ? [t] : []);
}

// The programs this entry's answers suggest, one per program (the first question
// that suggests it): [{ program, question, answer }]. Only while it's open or
// waiting for its fee, never a program it's already in or she said No to, and only
// her live (unarchived) programs of the entry's kennel.
export function programSuggestions(entry, questions = [], programsById = new Map()) {
  if (!entry || !SUGGEST_STATUSES.includes(entry.status)) return [];
  const app = entry.application || {};
  const declined = new Set(entry.program_suggestions_declined || []);
  const out = [];
  const seen = new Set();
  for (const q of questions) {
    const link = cleanProgramLink(q);
    if (!link || seen.has(link.program_id)) continue;
    const program = programsById.get(link.program_id);
    if (!program || program.is_archived || (program.kennel_id && entry.kennel_id && program.kennel_id !== entry.kennel_id)) continue;
    if (entry.waitlist_program_id === program.id || declined.has(program.id)) continue;
    const answer = givenAnswers(q, app[q.id]).find((a) => link.answers.includes(a));
    if (!answer) continue;
    seen.add(program.id);
    out.push({ program, question: q, answer });
  }
  return out;
}

// The line under the prompt: why it's asked. "They answered Yes to “Are you a
// military member?”" (+ the program it replaces, when they're in one).
export function suggestionWhy(s, currentProgram = null) {
  const replaces = currentProgram && currentProgram.id !== s.program.id ? ` Yes moves them out of ${currentProgram.name}.` : '';
  return `They answered “${s.answer}” to “${s.question.label}”.${replaces}`;
}
