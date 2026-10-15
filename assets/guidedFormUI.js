// guidedFormUI.js — Kels's "Set up my application form" (Pro: editionFlags.waitlist):
// the screens, on the shared step engine (assets/kelsSteps.js) in the chat on
// pages/kels.html. Which kennel, where she starts (her form or the standard one),
// the locked questions' wording, her own questions, their order, her FAQ, then the
// whole form as a family sees it and one save. The steps, checks and save live in
// data/guidedForm.js; this module draws them and keeps the draft (settings.js
// guidedFormDraft), so nothing goes online half-made.
//
// After the save: the form's link when her list is online (published now), then
// Sensitive records backup if it's off (assets/kelsBackupSteps.js: applications
// hold families' phone numbers, addresses and notes), then the application fee and
// how families pay, with its payment account (assets/waitlistFeeStep.js, the same
// step as Set up my waitlist's), then "Add an applicant now?" (assets/kelsApplicant.js).
// Pro-only (proPages.js); pages/kels.js imports it on start.
import { kennelRepo } from '../data/kennelRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { ownKennels, getActiveKennel } from '../data/kennelScope.js';
import { editionFlags } from '../data/editionConfig.js';
import { isWaitlistOnlineOffered } from '../data/cloud/cloudConfig.js';
import { waitlistConfig, kennelBreeds } from '../data/waitlistRules.js';
import { isLocked, isChoice, formQuestions, LOCKED_TYPE_LABEL } from '../data/waitlistForm.js';
import { WAITLIST_QUESTION_TYPE, descriptor } from '../data/vocab.js';
import { getGuidedFormDraft, setGuidedFormDraft, clearGuidedFormDraft } from '../data/settings.js';
import * as G from '../data/guidedForm.js';
import { applicationFields } from './waitlistApplicationForm.js';
import { offerSensitiveRecords, offerCloudBackup, CLOUD_OFF_FORM } from './kelsBackupSteps.js';
import { askWaitlistFee, feeSummary } from './waitlistFeeStep.js';
import { esc } from './ui.js';
import { StepConversation, tile, field, input, options, val, plural, pagesPrefix } from './kelsSteps.js';

const typeLabel = (x) => (isLocked(x) ? LOCKED_TYPE_LABEL[x.key] : descriptor(WAITLIST_QUESTION_TYPE, x.type).label) || '';

// --- Screens ------------------------------------------------------------------------

function screens(draft, data) {
  const k = data.kennel;
  return {
    start: () => ({
      title: `Where shall we start with ${esc(k.kennel_name || 'your')} form?`,
      html: `<div class="gl-tiles">
          ${tile('start', 'mine', 'Keep my form and change it', { selected: draft.start === 'mine', sub: `${plural(G.ownQuestions({ questions: formQuestions(waitlistConfig(k)) }).length, 'question', 'questions')} of your own` })}
          ${tile('start', 'standard', 'Start over from the standard form', { selected: draft.start === 'standard', sub: 'Your FAQ stays' })}
        </div>`,
      onTile: (value) => { G.startFrom(draft, k, value); return true; }
    }),

    locked: () => ({
      title: 'These questions are how your list works, so they stay. Want to reword any?',
      html: `<p class="gl-lead">Only the wording changes. Name and email find returning families, and the rest decide which pups they're offered.</p>
        ${G.lockedQuestions(draft).map((x) => (x.type === 'notice'
          ? `${field('Notice heading', input(`gf-l-${x.id}`, x.label))}
             <div class="field gl-field"><label>Notice text</label><textarea id="gf-h-${x.id}" rows="4">${esc(x.help)}</textarea>
             <span class="field-hint">Every applicant sees this before they apply.</span></div>`
          : field(typeLabel(x), input(`gf-l-${x.id}`, x.label)))).join('')}`,
      read: (root) => {
        for (const x of G.lockedQuestions(draft)) {
          x.label = val(root, `gf-l-${x.id}`);
          if (x.type === 'notice') x.help = root.querySelector(`#gf-h-${x.id}`).value.trim();
        }
      }
    }),

    questions: () => {
      const own = G.ownQuestions(draft);
      return {
        title: own.length ? 'Here are your own questions. Keep, reword or take off any, and add new ones.' : 'Want to ask families anything else?',
        html: `<p class="gl-lead">Tap ✕ to take one off. Families who already applied keep their answers.</p>
          ${own.map((x) => `<div class="gl-extra-row gf-q" data-q="${esc(x.id)}">
            <div class="row-between"><strong>${esc(x.label || 'New question')}</strong>
              <button type="button" class="btn btn-sm gd-remove" data-act="remove" data-id="${esc(x.id)}" aria-label="Take ${esc(x.label || 'this question')} off">✕</button></div>
            ${field('Question', input(`gf-q-${x.id}`, x.label, { placeholder: 'e.g. Do you have a fenced yard?' }))}
            ${field('Answer type', `<select id="gf-t-${x.id}" data-type-for="${esc(x.id)}">${options(WAITLIST_QUESTION_TYPE, x.type)}</select>`)}
            <div id="gf-o-${x.id}"${isChoice(x) ? '' : ' hidden'}>
              <div class="field gl-field"><label>Choices (one per line)</label><textarea id="gf-ot-${x.id}" rows="3">${esc((x.options || []).join('\n'))}</textarea></div>
            </div>
            ${field('Help text (optional)', input(`gf-h-${x.id}`, x.help))}
            <label class="ck-check"><input type="checkbox" id="gf-r-${x.id}"${x.required ? ' checked' : ''}> <span>Required on the online form</span></label>
          </div>`).join('')}
          <button type="button" class="btn gl-more" data-act="add">+ Add a question</button>`,
        wire: (root) => {
          root.querySelectorAll('[data-type-for]').forEach((sel) => sel.addEventListener('change', () => {
            const id = sel.dataset.typeFor;
            const choice = ['single_choice', 'checkboxes'].includes(sel.value);
            root.querySelector(`#gf-o-${id}`).hidden = !choice;
            const box = root.querySelector(`#gf-ot-${id}`);
            if (choice && !box.value.trim()) box.value = 'Option 1';
          }));
          const fresh = [...root.querySelectorAll('.gf-q input[id^="gf-q-"]')].find((el) => !el.value);
          fresh?.focus({ preventScroll: true });
        },
        read: (root) => {
          for (const x of G.ownQuestions(draft)) {
            if (!root.querySelector(`#gf-q-${x.id}`)) continue;
            x.label = val(root, `gf-q-${x.id}`);
            G.setType(x, val(root, `gf-t-${x.id}`));
            if (isChoice(x)) x.options = root.querySelector(`#gf-ot-${x.id}`).value.split('\n').map((s) => s.trim()).filter(Boolean);
            x.help = val(root, `gf-h-${x.id}`);
            x.required = root.querySelector(`#gf-r-${x.id}`).checked;
          }
        },
        onAct: (act, root, btn) => {
          if (act === 'add') { G.addQuestion(draft); return 'read-redraw'; }
          if (act === 'remove') { G.removeQuestion(draft, btn.dataset.id); return 'redraw'; }
          return null;
        }
      };
    },

    order: () => ({
      title: 'Is this the order you want?',
      html: `<p class="gl-lead">Use ↑ and ↓ to move a question. 🔒 ones can move too.</p>
        <ol class="gf-order">${draft.questions.map((x, i) => `<li class="row-between">
          <span>${isLocked(x) ? '🔒 ' : ''}${esc(x.label)}</span>
          <span class="pill-row">
            <button type="button" class="btn btn-sm" data-act="up" data-id="${esc(x.id)}" aria-label="Move ${esc(x.label)} up"${i === 0 ? ' disabled' : ''}>↑</button>
            <button type="button" class="btn btn-sm" data-act="down" data-id="${esc(x.id)}" aria-label="Move ${esc(x.label)} down"${i === draft.questions.length - 1 ? ' disabled' : ''}>↓</button>
          </span></li>`).join('')}</ol>`,
      onAct: (act, root, btn) => {
        G.move(draft, btn.dataset.id, act === 'up' ? -1 : 1);
        return 'read-redraw';
      }
    }),

    faq: () => {
      const asked = new Set(draft.faq.map((x) => x.question.trim().toLowerCase()));
      const starters = G.FAQ_STARTERS.filter((q) => !asked.has(q.toLowerCase()));
      return {
        title: 'Would you like a few questions and answers at the top of your form?',
        html: `<p class="gl-lead">Optional. They save you answering the same messages. Tap one to start from it, or add your own.</p>
          ${draft.faq.map((x) => `<div class="gl-extra-row" data-faq="${esc(x.id)}">
            <div class="row-between">${field('Question', input(`gf-fq-${x.id}`, x.question))}
              <button type="button" class="btn btn-sm gd-remove" data-act="remove" data-id="${esc(x.id)}" aria-label="Take this one off">✕</button></div>
            <div class="field gl-field"><label>Your answer</label><textarea id="gf-fa-${x.id}" rows="2">${esc(x.answer)}</textarea></div>
          </div>`).join('')}
          ${starters.length ? `<div class="pill-row">${starters.map((q) => `<button type="button" class="btn btn-sm" data-act="starter" data-value="${esc(q)}">+ ${esc(q)}</button>`).join('')}</div>` : ''}
          <button type="button" class="btn gl-more" data-act="add">+ My own question</button>`,
        wire: (root) => {
          const empty = [...root.querySelectorAll('textarea[id^="gf-fa-"]')].find((el) => !el.value);
          empty?.focus({ preventScroll: true });
        },
        read: (root) => {
          for (const x of draft.faq) {
            if (!root.querySelector(`#gf-fq-${x.id}`)) continue;
            x.question = val(root, `gf-fq-${x.id}`);
            x.answer = root.querySelector(`#gf-fa-${x.id}`).value.trim();
          }
        },
        onAct: (act, root, btn) => {
          if (act === 'starter') { G.addFaq(draft, btn.dataset.value); return 'read-redraw'; }
          if (act === 'add') { G.addFaq(draft); return 'read-redraw'; }
          if (act === 'remove') { draft.faq = draft.faq.filter((x) => x.id !== btn.dataset.id); return 'redraw'; }
          return null;
        }
      };
    },

    review: () => {
      const form = G.finalForm(draft);
      const preview = applicationFields({ form: form.form_questions, config: waitlistConfig(k), breeds: data.breeds, entry: {} });
      return {
        title: 'Here\'s your form, as families will see it:',
        html: `<p class="gl-lead">Look it over. Tap a button to change that part, or <strong>Yes, build it</strong> when it's right.</p>
          <div class="pill-row">
            <button type="button" class="btn btn-sm" data-goto="locked">Locked wording</button>
            <button type="button" class="btn btn-sm" data-goto="questions">Questions</button>
            <button type="button" class="btn btn-sm" data-goto="order">Order</button>
            <button type="button" class="btn btn-sm" data-goto="faq">FAQ</button>
          </div>
          ${form.application_faq.length ? `<section class="gl-review-section"><h3>FAQ</h3>
            ${form.application_faq.map((x) => `<p><strong>${esc(x.question)}</strong><br>${esc(x.answer)}</p>`).join('')}</section>` : ''}
          <section class="gl-review-section"><h3>The application</h3>
            <fieldset disabled class="gf-preview"><div class="form-grid">${preview}</div></fieldset></section>`,
        isReview: true
      };
    }
  };
}

// --- Her answers, as she'd have said them -------------------------------------------

function answerFor(stepId, draft, data) {
  if (stepId === 'start') return draft.start === 'mine' ? 'Keep my form and change it' : 'Start over from the standard form';
  if (stepId === 'locked') {
    const before = G.lockedQuestions(G.startFrom(structuredClone(draft), data.kennel, draft.start || 'standard'));
    const changed = G.lockedQuestions(draft).filter((x) => {
      const b = before.find((y) => y.id === x.id);
      return b && (b.label !== x.label || (x.type === 'notice' && b.help !== x.help));
    }).length;
    if (!changed) return 'They\'re fine as they are';
    return changed === 1 ? 'Reworded one' : `Reworded ${changed} of them`;
  }
  if (stepId === 'questions') {
    const own = G.ownQuestions(draft);
    return own.length ? `${plural(own.length, 'question', 'questions')} of my own` : 'No others';
  }
  if (stepId === 'order') return 'That\'s the order';
  if (stepId === 'faq') return draft.faq.length ? plural(draft.faq.length, 'question and answer', 'questions and answers') : 'No FAQ';
  return '';
}

// --- The conversation -----------------------------------------------------------------

async function loadData(kennel) {
  return { kennel, breeds: kennelBreeds(kennel, await dogRepo.getAll()) };
}

// Run it in `chat`. `resume`: carry on the unfinished draft. `kennelId`: the
// kennel to set up (Set up my waitlist's handoff), else asked with several.
export async function runFormTask(chat, { resume = false, kennelId = null, onExit = () => {}, onSaved = () => {}, handoff = null } = {}) {
  let draft = resume ? G.pendingFormDraft(getGuidedFormDraft()) : null;
  let kennel = draft ? await kennelRepo.getById(draft.kennelId) : null;
  if (draft && !kennel) { clearGuidedFormDraft(); draft = null; }
  if (!draft) {
    if (!(await chat.intro('Yes! Let\'s make your application form just right.'))) { onExit('nevermind'); return; }
    const kennels = (await ownKennels()).filter((x) => !x.is_archived);
    if (!kennels.length) {
      await chat.say('You\'ll need your kennel set up first. Once it is, come back and we\'ll build your form together.');
      onExit('done');
      return;
    }
    kennel = kennels.find((x) => x.id === kennelId) || (kennels.length === 1 ? kennels[0] : null);
    if (!kennel) {
      const active = await getActiveKennel();
      await chat.say('<strong>Which kennel\'s form are we working on?</strong>');
      const id = await chat.choose([
        ...kennels.map((x) => ({ label: x.kennel_name || 'Your kennel', value: x.id, primary: x.id === active?.id })),
        { label: 'Never mind', value: '' }
      ]);
      if (!id) { onExit('nevermind'); return; }
      kennel = kennels.find((x) => x.id === id);
    }
    draft = G.emptyDraft(kennel);
  } else {
    await chat.say(`Welcome back! Here's what we have so far for ${esc(kennel.kennel_name || 'your')} form:`, { typing: 500 });
    await StepConversation.replay(chat, draft.history);
    await chat.say('Let\'s pick up where we left off.', { typing: 500 });
  }
  return new FormConversation(chat, draft, await loadData(kennel), { onExit, onSaved, handoff }).start();
}

class FormConversation extends StepConversation {
  constructor(chat, draft, data, { onExit, onSaved, handoff }) {
    super(chat, draft);
    Object.assign(this, { data, onExit, onSaved, handoff });
  }

  persist() {
    this.draft.updatedAt = new Date().toISOString();
    if (!this.draft.done) setGuidedFormDraft(this.draft);
  }

  async loadSteps() { return G.stepsFor(this.draft); }
  screenFor(stepId) { return screens(this.draft, this.data)[stepId](); }
  problem(stepId) { return G.stepProblem(stepId, this.draft); }
  answerText(stepId) { return answerFor(stepId, this.draft, this.data); }

  async save() {
    if (this.busy) return;
    this.busy = true;
    const btn = this.panel.querySelector('[data-k="save"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    this.showError('');
    try {
      const kennel = await G.saveGuidedForm(this.draft);
      clearGuidedFormDraft();
      this.onSaved();
      this.panel.closest('.kels-row').remove();
      this.chat.you('Yes, build it');
      await this.afterSave(kennel);
    } catch (e) {
      setGuidedFormDraft(this.draft);
      if (btn) { btn.disabled = false; btn.textContent = 'Try again'; }
      this.showError(`Hmm, that didn't save: ${e.message || String(e)} Your answers are kept, so you can fix it and try again.`);
    } finally {
      this.busy = false;
    }
  }

  async afterSave(kennel) {
    await this.chat.say('Done! ✓ Your application form is saved. Families are going to love how clear it is.', { typing: 1000 });
    await offerSensitiveRecords(this.chat, { what: 'Applications hold families\' phone numbers, addresses and notes.' });
    await this.fee(kennel);
    await this.shareLink(kennel);
    await this.applicants(kennel);
    await this.finish(kennel);
  }

  // The link families apply at, offered to copy. Her form is online only while her
  // list is online with applications taken online (online_form); otherwise she's
  // offered that first (cloud backup on, through kelsBackupSteps, since the list
  // publishes from it), saved by cloudWaitlist.saveWaitlistOnline as the Online
  // list card saves it. Only where the waitlist online is offered.
  async shareLink(kennel) {
    if (!isWaitlistOnlineOffered()) return;
    const cw = await import('../data/cloud/cloudWaitlist.js');
    let fresh = await kennelRepo.getById(kennel.id);
    let st = cw.waitlistOnlineStatus(fresh);
    if (!st.formOpen) {
      await this.chat.say(st.online
        ? 'Your list is online, but families can\'t apply online yet. Want to take applications online? You\'ll get a link to share on Facebook or your website.'
        : 'Want families to apply online? I\'ll put your waitlist online with this form and give you a link to share on Facebook or your website. Your public list shows first names only.');
      const pick = await this.chat.choose([{ label: 'Yes, take applications online', value: 'yes', primary: true }, { label: 'Not now', value: '' }]);
      if (pick !== 'yes') return;
      if (!(await offerCloudBackup(this.chat, {
        line: `Your online form is published through cloud backup, and that's not on for this device yet. ${CLOUD_OFF_FORM} Want to turn it on now? It only takes a minute.`,
        later: `Okay, your form stays offline for now, so you'll type each family's application in yourself. Once cloud backup is on, I can put it online any time.`
      }))) return;
      await this.chat.say('Putting it online…', { typing: 300 });
      fresh = await cw.saveWaitlistOnline(kennel.id, { online: true, online_form: true });
      st = cw.waitlistOnlineStatus(fresh);
    } else {
      await cw.syncWaitlistOnline().catch(() => {});
      st = cw.waitlistOnlineStatus(fresh);
    }
    if (st.lastError) {
      const { onlineProblemText } = await import('./waitlistOnlineUI.js');
      await this.chat.say(`Your form is saved, but it isn't online yet. ${esc(onlineProblemText(st.lastError.code))}`);
      return;
    }
    if (!st.formOpen) return;
    const { applyFormLink } = await import('../data/cloud/cloudConfig.js');
    const link = applyFormLink(fresh.public_id);
    await this.chat.say(`Your form is live! Families apply at:<br><strong class="gf-link">${esc(link)}</strong><br>Want to copy it to share?`);
    const pick = await this.chat.choose([{ label: 'Copy the link', value: 'copy', primary: true }, { label: 'Not now', value: '' }]);
    if (pick !== 'copy') return;
    const { copyLink } = await import('./waitlistUI.js');
    await copyLink(link, null, { title: 'Your application form' });
    await this.chat.say('Copied! Paste it on Facebook, your website, or anywhere families will see it.', { typing: 400 });
  }

  // The application fee and how families pay, with its payment account.
  async fee(kennel) {
    let accounts = [];
    if (editionFlags.accounts) accounts = await (await import('../data/accountRepo.js')).accountRepo.getAll();
    const c = waitlistConfig(kennel);
    const set = c.fee_amount != null || (c.payment_instructions || '').trim();
    await this.chat.say(set
      ? `Your form ends with the application fee: ${esc(feeSummary(kennel, accounts).replace(/^A /, 'a '))}. Want to change it, or how families pay?`
      : 'Do you charge an application fee? I can set it up now, and how families pay it.');
    const pick = await this.chat.choose([
      { label: set ? 'Change the fee' : 'Yes, let\'s set it up', value: 'yes', primary: !set },
      { label: set ? 'It\'s right' : 'No fee for now', value: '' }
    ]);
    if (pick !== 'yes') return;
    await askWaitlistFee(this.chat, kennel, {
      resumeTask: 'Set up my application form',
      title: '<strong>The application fee.</strong><span class="kels-lead">Leave the amount blank if you don\'t charge one.</span>'
    });
  }

  // "Add an applicant now?": a family she already has, asked with the new form.
  async applicants(kennel) {
    await this.chat.say('Do you have a family to put on the list now? I\'ll ask them your new form\'s questions.');
    const { askApplicant } = await import('./kelsApplicant.js');
    for (;;) {
      const pick = await this.chat.choose([{ label: 'Add a family', value: 'yes', primary: true }, { label: 'Not now', value: '' }]);
      if (pick !== 'yes') return;
      const fresh = await kennelRepo.getById(kennel.id);
      const entry = await askApplicant(this.chat, { kennel: fresh });
      if (entry) await this.chat.say(`Added! ${esc(entry.application?.name || 'They')} ${entry.application?.name ? 'is' : 'are'} in your applications, ready for you to approve. Another?`, { typing: 500 });
      else return;
    }
  }

  async finish(kennel) {
    await this.chat.say('All set. Anything else I can do for you?');
    const where = await this.chat.choose([
      { label: 'See my form', value: 'form', primary: true },
      { label: 'Help me with something else', value: 'menu' },
      { label: 'Back to Today', value: 'today' }
    ]);
    if (where === 'form') location.href = `${pagesPrefix()}waitlist-form.html?kennel=${encodeURIComponent(kennel.id)}`;
    else if (where === 'today') location.href = `${pagesPrefix()}today.html`;
    else this.onExit('done');
  }
}
