// kelsApplicant.js — Kels's applicant step: a family put on one kennel's waitlist
// from the chat, asked with her application form (the same fields as the Waitlist
// entry page's new application, waitlistApplicationForm.js), then the program, when
// they applied, any money they've already paid her (a credit for funds already
// received, receivedCredits.js: an early deposit taken before the app) and her notes.
// Saved as an application (status `applied`), as that
// page saves it. Shared by "Set up my waitlist" (a family she already has) and
// "Add people" (someone she just added, linked to that contact at once: their name,
// email and phone fill the form in). Pro-only (proPages.js); callers import it
// dynamically, only with editionFlags.waitlist.
import { waitlistEntryRepo } from '../data/waitlistEntryRepo.js';
import { waitlistProgramRepo } from '../data/waitlistProgramRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { waitlistConfig, kennelBreeds, feeForEntry, isFeeWaived } from '../data/waitlistRules.js';
import { formQuestions, snapshotQuestions, isAnswerQuestion, missingRequired } from '../data/waitlistForm.js';
import { applicationFields, readAnswers, readPrefs } from './waitlistApplicationForm.js';
import { newCredit } from '../data/receivedCredits.js';
import { doNotSellRepo } from '../data/doNotSellRepo.js';
import { entryDoNotSellMatches, doNotSellWarning } from '../data/doNotSell.js';
import { field, input, val } from './kelsSteps.js';
import { esc, todayYMD, fmtMoney, fmtDate } from './ui.js';

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
  const [dogs, programs, doNotSell] = await Promise.all([dogRepo.getAll(), waitlistProgramRepo.getByKennel(kennel.id), doNotSellRepo.getAll()]);
  // Her do-not-sell list, checked before the family is added (the entry page
  // shows the same warning once they're on): asked once, then a second tap adds them.
  let warned = '';
  const breeds = kennelBreeds(kennel, dogs);
  const live = programs.filter((p) => !p.is_archived).sort((a, b) => a.name.localeCompare(b.name));
  const entry = { application: applicationFromContact(form, contact) };
  const res = await chat.form({
    title: title || '<strong>Tell me about the family.</strong><span class="kels-lead">Your application\'s questions, so it matches what families fill in online.</span>',
    html: `<div class="form-grid">${applicationFields({ form, config, breeds, entry })}
      ${live.length ? field('Program', `<select id="ka-program"><option value="">— none —</option>${live.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>`) : ''}
      ${field('When they applied', `<input id="ka-applied" type="date" value="${esc(todayYMD())}">`, 'Their place in line comes from when their fee is received, once you approve them.')}
      <fieldset class="ws-group" style="grid-column:1/-1;"><legend>Money they've already paid you (optional)</legend>
        <p class="field-hint">Like an early deposit. It's kept as their credit and comes off what they're asked to pay: the application fee, then the deposit, then the rest. Change what it pays toward on their waitlist page.</p>
        <div class="ck-inline">
          ${field('Amount', '<input id="ka-credit" type="number" min="0" step="0.01" inputmode="decimal" placeholder="None">')}
          ${field('Received on', `<input id="ka-credit-date" type="date" value="${esc(todayYMD())}">`)}
          ${field('Note', '<input id="ka-credit-note" type="text" placeholder="e.g. Early deposit">')}
        </div>
      </fieldset>
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
      const dns = doNotSellWarning(entryDoNotSellMatches({ application, contact_id: contact?.id || null }, doNotSell));
      if (dns && warned !== dns) { warned = dns; return `${dns} Tap Add the family again to add them anyway.`; }
      let credit = null;
      const paid = root.querySelector('#ka-credit').value;
      if (String(paid).trim() !== '' && Number(paid) > 0) {
        try {
          credit = newCredit({ amount: paid, date: root.querySelector('#ka-credit-date').value, note: root.querySelector('#ka-credit-note').value.trim() });
        } catch (e) { return e.message; }
      }
      const made = await waitlistEntryRepo.create({
        ...prefs, application, application_questions: snapshotQuestions(questions),
        waitlist_program_id: root.querySelector('#ka-program')?.value || null,
        applied_date: root.querySelector('#ka-applied').value || todayYMD(),
        notes: root.querySelector('#ka-notes').value,
        kennel_id: kennel.id, status: 'applied',
        ...(credit ? { received_credits: [credit] } : {}),
        ...(contact ? { contact_id: contact.id } : {})
      });
      return { entry: made };
    },
    reply: (out) => out.entry.application?.name || contact?.name || 'Add the family'
  });
  return res.done ? res.result.entry : null;
}

// Approve the application she just entered (waitlistActions.approve) and settle the
// fee: paid (when, how), not yet (fee due), or not charging (an existing waived
// program, a new program, or waived for just them). No fee set, or a waived program
// chosen on the application: straight onto the list. → the entry as saved.
//
// The one rule for a family she typed in herself (K11-14): Add people, Set up my
// waitlist's families she already has and Set up my application form's Add a
// family all approve it here, in the chat, so Review my waitlist doesn't ask again.
export async function approveTypedFamily(chat, kennel, entry, contact = null) {
  // With no contact yet (Set up my waitlist, Set up my application form), approve
  // makes one from the application.
  contact = contact || { id: null, name: entry.application?.name || 'They' };
  const A = await import('../data/waitlistActions.js');
  const { waitlistProgramRepo } = await import('../data/waitlistProgramRepo.js');
  const config = waitlistConfig(kennel);
  const programs = (await waitlistProgramRepo.getByKennel(kennel.id)).filter((p) => !p.is_archived);
  const program = programs.find((p) => p.id === entry.waitlist_program_id) || null;
  const fee = feeForEntry(config, program);
  const today = todayYMD();
  if (!(fee > 0)) {
    const approved = await A.approve(entry.id, { date: today, contactId: contact.id || null });
    return approved.status === 'active' ? approved : A.feeReceived(entry.id, { date: today, amount: null });
  }
  const who = esc(contact.name);
  // Money they'd already paid her (a credit for funds already received, entered with
  // their application) pays the fee first.
  const { creditsOf, feeCharge, allocateCredits } = await import('../data/receivedCredits.js');
  const credits = creditsOf(entry);
  const covered = allocateCredits(credits, feeCharge({ ...entry, fee_amount: fee, fee_received_date: null })).byKey.fee || 0;
  if (covered >= fee) {
    const from = credits[0].date || today;
    await chat.say(`The ${esc(fmtMoney(covered))} ${who} already paid you covers the ${esc(fmtMoney(fee))} application fee. Put them on the list from ${esc(fmtDate(from))}, when you received it?`, { typing: 300 });
    const ok = await chat.choose([{ label: `Yes, from ${fmtDate(from)}`, value: 'yes', primary: true }, { label: 'Not yet', value: '' }]);
    await A.approve(entry.id, { date: today, contactId: contact.id || null });
    if (!ok) return waitlistEntryRepo.getById(entry.id);
    return A.feeReceived(entry.id, { date: from, amount: fee, method: credits[0].method || '' });
  }
  if (covered > 0) await chat.say(`${esc(fmtMoney(covered))} of it is covered by what ${who} already paid you, so ${esc(fmtMoney(fee - covered))} is left.`, { typing: 300 });
  await chat.say(covered > 0 ? `Has ${who} paid the other ${esc(fmtMoney(fee - covered))}?` : `Has ${who} already paid the ${esc(fmtMoney(fee))} application fee?`, { typing: 300 });
  const pick = await chat.choose([
    { label: 'Yes, they paid', value: 'paid', primary: true },
    { label: 'Not yet', value: 'due' },
    { label: 'Not charging for this applicant', value: 'free' }
  ]);
  if (pick === 'paid') {
    const res = await chat.form({
      title: `<strong>When did ${who} pay?</strong><span class="kels-lead">Their place in line starts the day they paid.</span>`,
      html: `<div class="ck-inline">${field('Paid on', input('wa-paid', today, { type: 'date' }))}${field('How (optional)', input('wa-method', '', { placeholder: 'e.g. Zelle', list: 'wa-methods' }))}</div>
        <datalist id="wa-methods">${['Cash', 'Check', 'Venmo', 'Zelle', 'PayPal', 'Credit/debit card'].map((m) => `<option value="${esc(m)}">`).join('')}</datalist>`,
      submitLabel: 'Save',
      cancelLabel: 'Not yet, after all',
      submit: (root) => {
        const date = val(root, 'wa-paid');
        if (!date) return 'When did they pay?';
        if (date > today) return 'That date is in the future.';
        return { date, method: val(root, 'wa-method') };
      },
      reply: (r) => `Paid ${fmtDate(r.date)}${r.method ? `, ${r.method}` : ''}`
    });
    await A.approve(entry.id, { date: today, contactId: contact.id || null });
    if (!res.done) return waitlistEntryRepo.getById(entry.id);
    return A.feeReceived(entry.id, { date: res.result.date, amount: fee, method: res.result.method });
  }
  if (pick === 'free') return waiveFee(chat, kennel, config, programs, entry, contact);
  return A.approve(entry.id, { date: today, contactId: contact.id || null });
}

// "Not charging for this applicant": a program that waives the fee (one she has, or
// a new one: Set up my waitlist's program form, fee prefilled at $0), or waived for
// just them. A new program that still charges is linked, and the fee falls due.
async function waiveFee(chat, kennel, config, programs, entry, contact) {
  const A = await import('../data/waitlistActions.js');
  const today = todayYMD();
  const waived = programs.filter((p) => isFeeWaived(config, p));
  await chat.say(`Got it. Is that because of a program, like repeat buyers, or just for ${esc(contact.name)}?`, { typing: 300 });
  const pick = await chat.choose([
    ...waived.map((p) => ({ label: `${p.name} program`, value: p.id })),
    { label: 'Set up a new program', value: 'new' },
    { label: `Just ${contact.name}`, value: 'one', primary: !waived.length }
  ]);
  let programId = waived.find((p) => p.id === pick)?.id || null;
  if (pick === 'new') {
    const { askNewProgram } = await import('./waitlistSetupUI.js');
    const made = await askNewProgram(this.chat, kennel, config, { fee: 0, title: '<strong>A new program</strong><span class="kels-lead">The fee is set to $0 (waived). Change it if they pay a different amount.</span>' });
    programId = made ? made.id : null;
    if (!made) await chat.say(`Okay, I'll waive it for just ${esc(contact.name)}.`, { typing: 300 });
  }
  const approved = await A.approve(entry.id, { date: today, contactId: contact.id || null, programId });
  if (approved.status === 'active') return approved;
  if (programId) return approved; // a new program that still charges: the fee is due
  return A.feeReceived(entry.id, { date: today, amount: 0, method: 'Waived' });
}
