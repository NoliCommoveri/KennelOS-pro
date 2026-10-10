// waitlistInbox.js — an online application, opened on her device, becomes an
// `applied` waitlist entry (Waitlist Spec §8.2; W2 Plan step 4). PURE: no Dexie,
// no DOM, no network; tests/waitlistInbox.test.js.
//
// What an applicant's browser sends is untrusted, however it was sealed. So
// nothing is copied through as-is: answers are kept only for questions on her
// form, cut to size and to the question's choices; preferences only take values
// from the vocab (a breed only one of hers); everything else is dropped.
import { WAITLIST_PREF_SEX, WAITLIST_READY_TIMING, cleanPurposes } from './vocab.js';
import { isAnswerQuestion, snapshotQuestions } from './waitlistForm.js';
import { resolveBreed } from './waitlistRules.js';

export const ANSWER_LIMITS = { short: 500, long: 10000, choices: 50, choice: 200, colors: 10, color: 60 };

const str = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, max) : '');
const oneOf = (v, vocab, fallback) => (vocab.some((x) => x.value === v) ? v : fallback);

// One answer, made safe for its question's type.
function cleanAnswer(question, value) {
  const choices = Array.isArray(question.options) ? question.options : [];
  switch (question.type) {
    case 'checkboxes': {
      const picked = Array.isArray(value) ? value.slice(0, ANSWER_LIMITS.choices).map((v) => str(v, ANSWER_LIMITS.choice)) : [];
      return picked.filter((v) => choices.includes(v));
    }
    case 'single_choice': {
      const v = str(value, ANSWER_LIMITS.choice);
      return choices.includes(v) ? v : '';
    }
    case 'yes_no': {
      const v = str(value, 10).toLowerCase();
      return v === 'yes' || v === 'no' ? v : '';
    }
    case 'number': {
      const v = str(value, 30);
      return v === '' || Number.isFinite(Number(v)) ? v : '';
    }
    case 'date': {
      const v = str(value, 10);
      return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
    }
    case 'long_text':
      return typeof value === 'string' ? value.slice(0, ANSWER_LIMITS.long) : '';
    default:
      return str(value, ANSWER_LIMITS.short);
  }
}

// The day an application arrived, in the kennel's time zone (YYYY-MM-DD).
export function arrivalDate(iso, timeZone) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

// `item` is the inbox item ({ id, name, email, createdAt, statusToken }), `opened`
// what the applicant sealed ({ answers, prefs, private_request }), `form` her current questions
// (waitlistForm.formQuestions), `breeds` the kennel's breeds. → the new entry's
// fields (without `id`'s bookkeeping), ready for waitlistEntryRepo.create.
export function applicationToEntry(item, opened, { kennel, form, breeds = [] }) {
  const answers = (opened && typeof opened.answers === 'object' && !Array.isArray(opened.answers)) ? opened.answers : {};
  const prefs = (opened && typeof opened.prefs === 'object' && !Array.isArray(opened.prefs)) ? opened.prefs : {};
  const application = {};
  for (const q of form.filter(isAnswerQuestion)) {
    if (Object.prototype.hasOwnProperty.call(answers, q.id)) application[q.id] = cleanAnswer(q, answers[q.id]);
  }
  // Name and email are what the server held and emailed; the sealed ones must agree.
  application.name = str(application.name || item.name, ANSWER_LIMITS.short) || str(item.name, ANSWER_LIMITS.short);
  application.email = str(item.email, 254).toLowerCase();

  const colors = Array.isArray(prefs.pref_colors)
    ? prefs.pref_colors.slice(0, ANSWER_LIMITS.colors).map((c) => str(c, ANSWER_LIMITS.color)).filter(Boolean)
    : [];
  const breed = resolveBreed(str(prefs.pref_breed, 120), breeds);
  return {
    id: item.id,
    kennel_id: kennel.id,
    status: 'applied',
    applied_date: arrivalDate(item.createdAt, kennel.time_zone),
    application,
    application_questions: snapshotQuestions(form),
    pref_sex: oneOf(prefs.pref_sex, WAITLIST_PREF_SEX, 'any'),
    pref_breed: breed || '',
    pref_purposes: Array.isArray(prefs.pref_purposes) ? cleanPurposes(prefs.pref_purposes) : [],
    pref_colors: colors,
    ready_timing: oneOf(prefs.ready_timing, WAITLIST_READY_TIMING, null),
    listen_mode: 'all',
    // Their ask to show privately on the public list (Spec §15.3): waits for her
    // Approve / Decline; until then their name lists as "Jane S.".
    ...(opened && opened.private_request === true ? { private_request: { requested_date: arrivalDate(item.createdAt, kennel.time_zone) } } : {}),
    source: 'online_form',
    ...(item.statusToken ? { status_token: item.statusToken } : {})
  };
}
