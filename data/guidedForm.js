// guidedForm.js — Kels's "Set up my application form" (Pro: waitlist), its data
// half (the screens are assets/guidedFormUI.js, on the shared step engine
// assets/kelsSteps.js). The Waitlist form page (pages/waitlist-form.*) as a
// conversation, for one kennel:
//   1. Where she starts: the form she has, or our standard one (only asked when
//      she has saved a form of her own).
//   2. The locked questions (name, email, the preferences, readiness, the
//      public-list notice): shown together, reworded only.
//   3. Her own questions: keep, reword or drop each, and add new ones.
//   4. Their order.
//   5. Her FAQ, with a few common ones to start from.
//   6. The whole form as a family sees it, then one save.
// Nothing is written until the review, so a half-made form never goes live while
// her list is online: the draft (settings.js guidedFormDraft) keeps it till then.
// The rules are waitlistForm.js's, the page's own (formQuestions, validateQuestions,
// validateFaq, newQuestion). After the save the UI offers Sensitive records backup,
// the fee and how families pay (assets/waitlistFeeStep.js), and an applicant.
import { kennelRepo } from './kennelRepo.js';
import {
  formQuestions, formFaq, validateQuestions, validateFaq, newQuestion, newFaqItem, isLocked, isChoice,
  DEFAULT_FORM_QUESTIONS
} from './waitlistForm.js';
import { waitlistConfig } from './waitlistRules.js';

export const DRAFT_VERSION = 1;

const clean = (v) => String(v ?? '').trim();
const copy = (x) => JSON.parse(JSON.stringify(x));

// FAQs most breeders answer, offered as a start (her own answer each time).
export const FAQ_STARTERS = [
  'What is your price range?',
  'When do puppies go home?',
  'Is the application fee refundable?',
  'How does the waitlist work?',
  'Do you ship or deliver puppies?'
];

// She has a form of her own saved (questions or an FAQ), so "where do we start?" is asked.
export const hasOwnForm = (kennel) => {
  const c = kennel?.waitlist_config || {};
  return (Array.isArray(c.form_questions) && c.form_questions.length > 0) || formFaq(c).length > 0;
};

export function emptyDraft(kennel) {
  const now = new Date().toISOString();
  const config = waitlistConfig(kennel);
  return {
    v: DRAFT_VERSION,
    kennelId: kennel.id,
    startedAt: now,
    updatedAt: now,
    step: null,
    label: kennel.kennel_name || '',
    history: [],
    // "Where do we start?" is asked only when she has a form of her own. Its
    // answer: 'mine' (the saved form) | 'standard' | '' (not asked yet).
    askStart: hasOwnForm(kennel),
    start: hasOwnForm(kennel) ? '' : 'standard',
    questions: copy(formQuestions(config)),
    faq: copy(formFaq(config)),
    done: false
  };
}

// "Where do we start?": her saved form, or the standard one (her FAQ kept either way).
export function startFrom(draft, kennel, start) {
  draft.start = start;
  draft.questions = copy(start === 'standard' ? formQuestions({ form_questions: DEFAULT_FORM_QUESTIONS }) : formQuestions(waitlistConfig(kennel)));
  return draft;
}

export const lockedQuestions = (draft) => draft.questions.filter(isLocked);
export const ownQuestions = (draft) => draft.questions.filter((x) => !isLocked(x));

// A new question of `type`, just above the public-list notice (so it stays last).
export function addQuestion(draft, type = 'short_text', makeId) {
  const x = newQuestion(type, makeId);
  const at = draft.questions.findIndex((q) => q.type === 'notice');
  draft.questions.splice(at < 0 ? draft.questions.length : at, 0, x);
  return x;
}

export function removeQuestion(draft, id) {
  draft.questions = draft.questions.filter((x) => x.id !== id || isLocked(x));
  return draft;
}

// A type change: a choice question gets a first option, as on the page.
export function setType(x, type) {
  x.type = type;
  if (isChoice(x) && !(x.options || []).length) x.options = ['Option 1'];
  if (!isChoice(x)) x.options = [];
  return x;
}

export function move(draft, id, by) {
  const i = draft.questions.findIndex((x) => x.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= draft.questions.length) return draft;
  [draft.questions[i], draft.questions[j]] = [draft.questions[j], draft.questions[i]];
  return draft;
}

export function addFaq(draft, question = '', makeId) {
  const item = newFaqItem(makeId);
  item.question = question;
  draft.faq.push(item);
  return item;
}

// --- Steps ------------------------------------------------------------------------

export function stepsFor(draft) {
  return [...(draft.askStart ? ['start'] : []), 'locked', 'questions', 'order', 'faq', 'review'];
}

// One plain-language problem with the step's answers, or null.
export function stepProblem(step, draft) {
  if (step === 'start') return draft.start ? null : 'Tap one of the choices.';
  if (step === 'locked') {
    if (lockedQuestions(draft).some((x) => !clean(x.label))) return 'Give each of these some wording.';
    return null;
  }
  if (step === 'questions') {
    for (const x of ownQuestions(draft)) {
      if (!clean(x.label)) return 'Give each question some wording, or take it off.';
      if (isChoice(x) && !(x.options || []).filter((o) => clean(o)).length) return `"${clean(x.label)}" needs at least one choice, one per line.`;
    }
    return null;
  }
  if (step === 'faq') {
    const i = draft.faq.findIndex((x) => Boolean(clean(x.question)) !== Boolean(clean(x.answer)));
    if (i < 0) return null;
    const x = draft.faq[i];
    return clean(x.question) ? `Type your answer to "${clean(x.question)}", or take it off.` : 'Type the question for each answer, or take it off.';
  }
  if (step === 'review') {
    const problems = [...validateFaq(draft.faq), ...validateQuestions(draft.questions)];
    return problems.length ? problems.join(' ') : null;
  }
  return null;
}

// --- Saving -------------------------------------------------------------------------

// The form and FAQ as they'll be stored: the page's own clean-up (locked questions
// restored, blank FAQs dropped).
export const finalForm = (draft) => ({
  form_questions: formQuestions({ form_questions: draft.questions }),
  application_faq: formFaq({ application_faq: draft.faq })
});

// One write, over the kennel's latest config. → the kennel.
export async function saveGuidedForm(draft) {
  const problem = stepProblem('review', draft);
  if (problem) throw new Error(problem);
  const kennel = await kennelRepo.getById(draft.kennelId);
  if (!kennel) throw new Error('That kennel isn\'t here anymore.');
  await kennelRepo.update(kennel.id, { waitlist_config: { ...(kennel.waitlist_config || {}), ...finalForm(draft) } });
  draft.done = true;
  return kennelRepo.getById(kennel.id);
}

// An unfinished draft Kels can offer to finish, or null.
export const pendingFormDraft = (draft) => (draft && draft.v === DRAFT_VERSION && !draft.done ? draft : null);
