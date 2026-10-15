// kelsApplicant.js — Kels's applicant step: a family put on one kennel's waitlist
// from the chat, asked with her application form (the same fields as the Waitlist
// entry page's new application, waitlistApplicationForm.js), then the program, when
// they applied and her notes. Saved as an application (status `applied`), as that
// page saves it. Shared by "Set up my waitlist" (a family she already has) and
// "Add people" (someone she just added, linked to that contact at once: their name,
// email and phone fill the form in). Pro-only (proPages.js); callers import it
// dynamically, only with editionFlags.waitlist.
import { waitlistEntryRepo } from '../data/waitlistEntryRepo.js';
import { waitlistProgramRepo } from '../data/waitlistProgramRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { waitlistConfig, kennelBreeds } from '../data/waitlistRules.js';
import { formQuestions, snapshotQuestions, isAnswerQuestion, missingRequired } from '../data/waitlistForm.js';
import { applicationFields, readAnswers, readPrefs } from './waitlistApplicationForm.js';
import { field } from './kelsSteps.js';
import { esc, todayYMD } from './ui.js';

// Her answers to the form's name, email and phone questions, from a contact.
export function applicationFromContact(form, contact) {
  if (!contact) return {};
  const out = {};
  for (const q of form) {
    const from = q.key === 'name' ? contact.name : q.key === 'email' ? contact.email : q.id === 'phone' ? contact.phone : null;
    if (from) out[q.id] = from;
  }
  return out;
}

// → the new entry, or null on "Not now". `title`: Kels's line (trusted markup).
export async function askApplicant(chat, { kennel, contact = null, title = null } = {}) {
  const config = waitlistConfig(kennel);
  const form = formQuestions(config);
  const [dogs, programs] = await Promise.all([dogRepo.getAll(), waitlistProgramRepo.getByKennel(kennel.id)]);
  const breeds = kennelBreeds(kennel, dogs);
  const live = programs.filter((p) => !p.is_archived).sort((a, b) => a.name.localeCompare(b.name));
  const entry = { application: applicationFromContact(form, contact) };
  const res = await chat.form({
    title: title || '<strong>Tell me about the family.</strong><span class="kels-lead">Your application\'s questions, so it matches what families fill in online.</span>',
    html: `<div class="form-grid">${applicationFields({ form, config, breeds, entry })}
      ${live.length ? field('Program', `<select id="ka-program"><option value="">— none —</option>${live.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>`) : ''}
      ${field('When they applied', `<input id="ka-applied" type="date" value="${esc(todayYMD())}">`, 'Their place in line comes from when their fee is received, once you approve them.')}
      ${field('Your notes', '<textarea id="ka-notes" rows="2"></textarea>')}</div>`,
    submitLabel: 'Add the family',
    cancelLabel: 'Not now',
    submit: async (root) => {
      const questions = form.filter(isAnswerQuestion);
      const application = readAnswers(root, questions);
      const prefs = readPrefs(root);
      const missing = missingRequired(questions, application);
      if (!prefs.ready_timing) missing.push(form.find((q) => q.key === 'ready_timing')?.label || 'Ready to buy');
      if (missing.length) return `Please fill in: ${missing.map((m) => m.replace(/[?.!:]+$/, '')).join(', ')}.`;
      const made = await waitlistEntryRepo.create({
        ...prefs, application, application_questions: snapshotQuestions(questions),
        waitlist_program_id: root.querySelector('#ka-program')?.value || null,
        applied_date: root.querySelector('#ka-applied').value || todayYMD(),
        notes: root.querySelector('#ka-notes').value,
        kennel_id: kennel.id, status: 'applied',
        ...(contact ? { contact_id: contact.id } : {})
      });
      return { entry: made };
    },
    reply: (out) => out.entry.application?.name || contact?.name || 'Add the family'
  });
  return res.done ? res.result.entry : null;
}
