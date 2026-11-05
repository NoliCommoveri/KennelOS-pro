// waitlist-form.js — her application form for one kennel (Waitlist Spec §15.1;
// End-State guide §29). An editor over Kennel.waitlist_config.form_questions:
// reword, retype, reorder, add and delete questions; locked questions (name,
// email, the four preferences, the public-list notice) can only be reworded. Plus
// "Import questions from a CSV": a responses export from her old form provider
// becomes questions she reviews before anything is saved. Programs are never on
// the form — only she assigns them. Above the questions, her FAQ
// (waitlist_config.application_faq, Spec §15.8): questions and answers shown at the
// top of the application. Pro-only page (proPages.js).
import Papa from '../vendor/papaparse.min.mjs';
import { kennelRepo } from '../data/kennelRepo.js';
import { WAITLIST_QUESTION_TYPE, descriptor } from '../data/vocab.js';
import {
  formQuestions, validateQuestions, newQuestion, isLocked, isChoice, DEFAULT_FORM_QUESTIONS,
  proposeQuestionImport, applyQuestionImport, formFaq, validateFaq, newFaqItem, LOCKED_TYPE_LABEL
} from '../data/waitlistForm.js';
import { esc, param, confirmModal, alertModal } from '../assets/ui.js';
import { qaListHtml, wireQaList } from '../assets/qaListEditor.js';
import { resolveWaitlistKennel, mountKennelPicker } from '../assets/waitlistUI.js';
import { waitlistProgramRepo } from '../data/waitlistProgramRepo.js';
import { LINKABLE_TYPES, linkAnswerChoices, cleanProgramLink } from '../data/programSuggest.js';

const els = {
  back: document.getElementById('back-link'),
  title: document.getElementById('wf-title'),
  picker: document.getElementById('wf-kennel-picker'),
  importBox: document.getElementById('wf-import'),
  body: document.getElementById('wf-body'),
  error: document.getElementById('page-error'),
  save: document.getElementById('wf-save'),
  csv: document.getElementById('wf-csv')
};

const ctx = { kennel: null, questions: [], faq: [], dirty: false, proposals: null, csvRows: [], programs: [] };
const showError = (msg) => { els.error.innerHTML = `<div class="inline-error">${esc(msg)}</div>`; };
const clearError = () => { els.error.innerHTML = ''; };


const typeOptions = (current) => WAITLIST_QUESTION_TYPE
  .map((t) => `<option value="${esc(t.value)}"${t.value === current ? ' selected' : ''}>${esc(t.label)}</option>`).join('');

function markDirty() {
  ctx.dirty = true;
  els.save.textContent = 'Save form •';
}

// --- The question list ---------------------------------------------------------------

function questionHtml(x, i, total) {
  const locked = isLocked(x);
  const move = `<div class="wf-move">
      <button class="btn btn-sm" data-up="${i}" title="Move up"${i === 0 ? ' disabled' : ''}>↑</button>
      <button class="btn btn-sm" data-down="${i}" title="Move down"${i === total - 1 ? ' disabled' : ''}>↓</button>
      ${locked ? '' : `<button class="btn btn-sm btn-danger" data-del="${i}" title="Delete this question">✕</button>`}
    </div>`;
  if (x.type === 'notice') {
    return `<div class="wf-q" data-i="${i}">
      <div class="wf-q-head"><span class="wf-num">${i + 1}</span><span title="Locked">🔒</span>
        <input class="wf-label" data-f="label" type="text" value="${esc(x.label)}" aria-label="Heading">${move}</div>
      <div class="field" style="margin-top:8px;"><label>Notice text</label><textarea data-f="help">${esc(x.help)}</textarea>
        <span class="field-hint">${esc(LOCKED_TYPE_LABEL.public_notice)}. Every applicant sees this before they apply, so it can't be removed while your list is public.</span></div>
    </div>`;
  }
  const typeCell = locked
    ? `<span class="faint" style="flex:0 1 auto;">${esc(LOCKED_TYPE_LABEL[x.key] || descriptor(WAITLIST_QUESTION_TYPE, x.type).label)}</span>`
    : `<select data-f="type" aria-label="Answer type">${typeOptions(x.type)}</select>`;
  const options = isChoice(x)
    ? (locked
      ? `<div class="field"><label>Box</label><p class="field-hint" style="margin:0;">☐ ${esc((x.options || []).join(' · '))}</p></div>`
      : `<div class="field"><label>Options (one per line)</label><textarea data-f="options">${esc((x.options || []).join('\n'))}</textarea></div>`)
    : '';
  return `<div class="wf-q" data-i="${i}">
      <div class="wf-q-head"><span class="wf-num">${i + 1}</span>${locked ? '<span title="Locked: reword only">🔒</span>' : ''}
        <input class="wf-label" data-f="label" type="text" value="${esc(x.label)}" placeholder="Question" aria-label="Question">
        ${typeCell}${move}</div>
      <div class="wf-q-body">
        <div class="field"><label>Help text</label><input data-f="help" type="text" value="${esc(x.help || '')}" placeholder="Optional"></div>
        ${options}
        ${programLinkHtml(x)}
        <div class="field"><label class="check-inline"><input data-f="required" type="checkbox"${x.required ? ' checked' : ''}${locked ? ' disabled' : ''}> Required</label>
          ${x.source_header ? `<span class="field-hint">Imported from the "${esc(x.source_header)}" column.</span>` : ''}</div>
      </div>
    </div>`;
}

// "Suggest a program" (programSuggest.js): a yes/no or choice question of hers can
// point at one of her programs, so an application answering it gets "Add to
// [program]?" on the family's page. Families never see it.
function programLinkHtml(x) {
  if (isLocked(x) || !LINKABLE_TYPES.includes(x.type)) return '';
  const live = ctx.programs.filter((p) => !p.is_archived || p.id === x.program_link?.program_id);
  if (!live.length) return `<div class="field field-wide"><label>Suggest a program</label><span class="field-hint">Add a program on Programs and you can have this question suggest it (say, a military program for "Are you a military member?").</span></div>`;
  const link = x.program_link || null;
  const progOpts = `<option value="">— none —</option>` + live.map((p) => `<option value="${esc(p.id)}"${link && link.program_id === p.id ? ' selected' : ''}>${esc(p.name)}${p.is_archived ? ' (archived)' : ''}</option>`).join('');
  const answers = link ? linkAnswerChoices(x).map((a) => `<label class="check-inline"><input type="checkbox" data-link-answer value="${esc(a)}"${(link.answers || []).includes(a) ? ' checked' : ''}> ${esc(a)}</label>`).join('') : '';
  return `<div class="field field-wide wf-link"><label>Suggest a program</label>
      <select data-link-program aria-label="Program this question suggests">${progOpts}</select>
      ${link ? `<div class="check-group" style="margin-top:6px;"><span class="faint">When they answer:</span> ${answers}</div>` : ''}
      <span class="field-hint">${link ? 'Their application asks you "Add to this program?" before you review it, and until their fee is received. Only you see this.' : 'Optional. Families never see it.'}</span></div>`;
}

// --- The FAQ -----------------------------------------------------------------------

const FAQ_LIST = { name: 'faq', a: 'question', b: 'answer', aPlaceholder: "Question, e.g. What's your price range?", aLabel: 'FAQ question', bLabel: 'Answer', noun: 'FAQ', empty: 'No FAQ yet.' };

function faqHtml() {
  return `
    <section class="card" style="margin-bottom:16px;">
      <h2 style="margin:0;">FAQ</h2>
      <p class="field-hint" style="margin-top:4px;">Shown at the top of the application, before the questions: your usual price range, how the waitlist works, anything families always ask.</p>
      <div id="wf-faq">${qaListHtml(ctx.faq, FAQ_LIST)}</div>
      <div class="pill-row" style="margin-top:12px;"><button class="btn btn-sm" data-qa-add="faq">+ Add a question &amp; answer</button></div>
    </section>`;
}

function wireFaq() {
  wireQaList(els.body, ctx.faq, FAQ_LIST, { onChange: markDirty, rerender: render, newItem: () => newFaqItem() });
}

function render() {
  const qs = ctx.questions;
  els.body.innerHTML = `
    ${faqHtml()}
    <section class="card">
      <h2 style="margin:0 0 8px;">Questions</h2>
      <p class="field-hint" style="margin-top:0;">"Required" applies to the online form (coming with the public form). When you type an application in yourself, only the name and how soon they could buy are required.</p>
      <div id="wf-list">${qs.map((x, i) => questionHtml(x, i, qs.length)).join('')}</div>
      <div class="pill-row" style="margin-top:14px;align-items:center;">
        <label for="wf-new-type" class="muted">Add a question:</label>
        <select id="wf-new-type">${typeOptions('short_text')}</select>
        <button class="btn btn-sm" id="wf-add">+ Add</button>
        <button class="btn btn-sm" id="wf-reset" style="margin-left:auto;">Start over from the defaults</button>
      </div>
    </section>`;

  wireFaq();
  const list = els.body.querySelector('#wf-list');
  list.querySelectorAll('.wf-q').forEach((box) => {
    const i = Number(box.dataset.i);
    box.querySelectorAll('[data-f]').forEach((input) => {
      const evt = input.type === 'checkbox' || input.tagName === 'SELECT' ? 'change' : 'input';
      input.addEventListener(evt, () => {
        const x = ctx.questions[i];
        const f = input.dataset.f;
        if (f === 'required') x.required = input.checked;
        else if (f === 'options') x.options = input.value.split('\n').map((s) => s.trim()).filter(Boolean);
        else if (f === 'type') {
          x.type = input.value;
          if (isChoice(x) && !(x.options || []).length) x.options = ['Option 1'];
          markDirty();
          render();
          return;
        } else x[f] = input.value;
        markDirty();
      });
    });
  });
  list.querySelectorAll('.wf-q').forEach((box) => {
    const x = ctx.questions[Number(box.dataset.i)];
    box.querySelector('[data-link-program]')?.addEventListener('change', (ev) => {
      const id = ev.target.value;
      // A new link starts on "Yes" for a yes/no question; a choice question's answers she ticks.
      x.program_link = id ? { program_id: id, answers: x.program_link?.answers?.length ? x.program_link.answers : (x.type === 'yes_no' ? ['Yes'] : []) } : null;
      if (!id) delete x.program_link;
      markDirty();
      render();
    });
    box.querySelectorAll('[data-link-answer]').forEach((cb) => cb.addEventListener('change', () => {
      x.program_link = { ...x.program_link, answers: [...box.querySelectorAll('[data-link-answer]:checked')].map((c) => c.value) };
      markDirty();
    }));
  });
  const swap = (a, b) => {
    [ctx.questions[a], ctx.questions[b]] = [ctx.questions[b], ctx.questions[a]];
    markDirty();
    render();
  };
  list.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => swap(Number(b.dataset.up), Number(b.dataset.up) - 1)));
  list.querySelectorAll('[data-down]').forEach((b) => b.addEventListener('click', () => swap(Number(b.dataset.down), Number(b.dataset.down) + 1)));
  list.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const x = ctx.questions[Number(b.dataset.del)];
    if (!(await confirmModal({ title: 'Delete this question?', message: `"${x.label || 'Untitled'}" comes off the form. Families who already answered it keep their answer.`, confirmLabel: 'Delete', danger: true }))) return;
    ctx.questions.splice(Number(b.dataset.del), 1);
    markDirty();
    render();
  }));
  els.body.querySelector('#wf-add').addEventListener('click', () => {
    const x = newQuestion(els.body.querySelector('#wf-new-type').value);
    // New questions go just above the public-list notice, so it stays last.
    const at = ctx.questions.findIndex((q) => q.type === 'notice');
    ctx.questions.splice(at < 0 ? ctx.questions.length : at, 0, x);
    markDirty();
    render();
    els.body.querySelector(`.wf-q[data-i="${at < 0 ? ctx.questions.length - 1 : at}"] input.wf-label`)?.focus();
  });
  els.body.querySelector('#wf-reset').addEventListener('click', async () => {
    if (!(await confirmModal({ title: 'Start over from the defaults?', message: 'Your questions are replaced by the starting set (not saved until you tap Save form). Families who already applied keep their answers.', confirmLabel: 'Use the defaults' }))) return;
    ctx.questions = DEFAULT_FORM_QUESTIONS.map((x) => ({ ...x, options: [...x.options] }));
    markDirty();
    render();
  });
}

async function save() {
  clearError();
  const problems = [...validateFaq(ctx.faq), ...validateQuestions(ctx.questions)];
  ctx.questions.forEach((x, i) => {
    if (x.program_link && LINKABLE_TYPES.includes(x.type) && !cleanProgramLink(x)) problems.push(`Question ${i + 1} ("${x.label || 'untitled'}") suggests a program: tick the answer that suggests it, or set it to none.`);
  });
  if (problems.length) { showError(problems.join(' ')); return; }
  els.save.disabled = true;
  try {
    const form_questions = formQuestions({ form_questions: ctx.questions });
    const application_faq = formFaq({ application_faq: ctx.faq });
    await kennelRepo.update(ctx.kennel.id, { waitlist_config: { ...(ctx.kennel.waitlist_config || {}), form_questions, application_faq } });
    ctx.kennel = await kennelRepo.getById(ctx.kennel.id);
    ctx.questions = formQuestions(ctx.kennel.waitlist_config);
    ctx.faq = formFaq(ctx.kennel.waitlist_config);
    ctx.dirty = false;
    els.save.textContent = 'Saved ✓';
    setTimeout(() => { if (!ctx.dirty) els.save.textContent = 'Save form'; }, 1800);
    render();
  } catch (e) {
    showError(e.message || String(e));
  } finally {
    els.save.disabled = false;
  }
}

// --- Importing questions from a CSV ----------------------------------------------------

function sample(header) {
  const vals = ctx.csvRows.map((r) => String(r[header] ?? '').trim()).filter(Boolean);
  return [...new Set(vals)].slice(0, 2).map((v) => (v.length > 60 ? `${v.slice(0, 60)}…` : v)).join(' · ');
}

function renderImport() {
  if (!ctx.proposals) { els.importBox.innerHTML = ''; return; }
  const targetOpts = (p) => ctx.questions.filter((x) => x.type !== 'notice')
    .map((x) => `<option value="map:${esc(x.id)}"${p.action === 'map' && p.targetId === x.id ? ' selected' : ''}>Fills: ${esc(x.label)}${isLocked(x) ? ' 🔒' : ''}</option>`).join('');
  const rows = ctx.proposals.map((p, i) => `
    <tr class="wf-import-row" data-p="${i}">
      <td><strong>${esc(p.header)}</strong><div class="wf-sample">${esc(sample(p.header)) || '<span class="faint">no answers</span>'}</div></td>
      <td><select data-pf="action">
          <option value="new"${p.action === 'new' ? ' selected' : ''}>Add as a new question</option>
          ${targetOpts(p)}
          <option value="skip"${p.action === 'skip' ? ' selected' : ''}>Skip this column</option>
        </select>
        ${p.action === 'new' ? `<div style="margin-top:6px;"><select data-pf="type">${typeOptions(p.question.type)}</select></div>` : ''}
        ${p.action === 'new' && isChoice(p.question) ? `<div class="wf-sample" style="margin-top:4px;">Options: ${esc(p.question.options.join(', '))}</div>` : ''}
      </td>
    </tr>`).join('');
  els.importBox.innerHTML = `
    <section class="card" style="margin-bottom:16px;">
      <div class="row-between"><h2 style="margin:0;">Import questions</h2><button class="btn btn-sm" id="wf-imp-cancel">Cancel</button></div>
      <p class="field-hint">Each column of your old form's responses is a question. Check what each one becomes, then add them to your form. Nothing is saved until you tap Save form.</p>
      <div style="overflow-x:auto;"><table class="data"><thead><tr><th>Column</th><th>Becomes</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="form-actions"><button class="btn btn-primary btn-sm" id="wf-imp-apply">Add to my form</button></div>
    </section>`;
  els.importBox.querySelectorAll('tr[data-p]').forEach((tr) => {
    const p = ctx.proposals[Number(tr.dataset.p)];
    tr.querySelector('[data-pf="action"]').addEventListener('change', (e) => {
      const v = e.target.value;
      if (v.startsWith('map:')) { p.action = 'map'; p.targetId = v.slice(4); } else { p.action = v; p.targetId = null; }
      renderImport();
    });
    tr.querySelector('[data-pf="type"]')?.addEventListener('change', (e) => {
      p.question.type = e.target.value;
      if (isChoice(p.question) && !p.question.options.length) {
        p.question.options = [...new Set(ctx.csvRows.map((r) => String(r[p.header] ?? '').trim()).filter(Boolean))].slice(0, 12);
      }
      renderImport();
    });
  });
  els.importBox.querySelector('#wf-imp-cancel').addEventListener('click', () => { ctx.proposals = null; renderImport(); });
  els.importBox.querySelector('#wf-imp-apply').addEventListener('click', async () => {
    const added = ctx.proposals.filter((p) => p.action === 'new').length;
    const mapped = ctx.proposals.filter((p) => p.action === 'map').length;
    ctx.questions = applyQuestionImport(ctx.questions, ctx.proposals);
    ctx.proposals = null;
    markDirty();
    renderImport();
    render();
    await alertModal({
      title: 'Added to your form',
      message: `${added} new question${added === 1 ? '' : 's'}, ${mapped} column${mapped === 1 ? '' : 's'} matched to questions you already had. Review them below and tap Save form.\n\nTo bring these families in as applications, save the form, then use Import CSV on the Waitlist page with the same file. Their answers land in these questions.`
    });
  });
}

function onCsvPicked(file) {
  clearError();
  Papa.parse(file, {
    header: true,
    skipEmptyLines: 'greedy',
    complete: (res) => {
      const headers = (res.meta.fields || []).filter((h) => String(h).trim());
      if (!headers.length) { showError('That file has no header row, so there are no questions to import.'); return; }
      ctx.csvRows = res.data || [];
      ctx.proposals = proposeQuestionImport(headers, ctx.csvRows, ctx.questions);
      renderImport();
      els.importBox.scrollIntoView({ behavior: 'smooth' });
    },
    error: (err) => showError(`Couldn't read that file: ${err.message || err}`)
  });
}

// --- Start ------------------------------------------------------------------------

async function main() {
  const { kennel, own } = await resolveWaitlistKennel(param('kennel'));
  if (!kennel) { els.body.innerHTML = '<div class="empty-state">Set up your kennel first — each of your kennels keeps its own waitlist and form.</div>'; return; }
  ctx.kennel = kennel;
  mountKennelPicker(els.picker, { kennel, own });
  els.back.href = `waitlist.html?kennel=${encodeURIComponent(kennel.id)}`;
  document.getElementById('wf-kels').href = `kels.html?task=form-setup&kennel=${encodeURIComponent(kennel.id)}`;
  if (own.length > 1) els.title.textContent = `Application form — ${kennel.kennel_name}`;
  ctx.questions = formQuestions(kennel.waitlist_config);
  ctx.faq = formFaq(kennel.waitlist_config);
  ctx.programs = (await waitlistProgramRepo.getAll({ includeArchived: true })).filter((p) => p.kennel_id === kennel.id);
  els.save.addEventListener('click', save);
  els.csv.addEventListener('change', () => {
    const file = els.csv.files && els.csv.files[0];
    if (file) onCsvPicked(file);
    els.csv.value = '';
  });
  window.addEventListener('beforeunload', (e) => { if (ctx.dirty) { e.preventDefault(); e.returnValue = ''; } });
  render();
}

main().catch((e) => showError(e.message || String(e)));
