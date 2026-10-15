// kelsSteps.js — the step engine Kels's draft-keeping tasks share (Record a new
// litter, assets/guidedLitterUI.js; Add dogs, assets/guidedDogsUI.js). A task is
// a list of steps worked out from its draft; each step is a "screen": Kels's
// line, then the breeder's answer panel with big tiles, Back, and Next. Her
// answer is left in the chat as her reply (and in draft.history, so a resumed
// draft replays the chat), and the last step is a review with Change links that
// come straight back to it. This module draws and moves; the task supplies the
// steps, screens, checks and the save.
//
// A screen is { title, html, read?(root), wire?(root), onTile?(value, root),
// onAct?(act, root), after?(), isReview? }. read() copies its inputs into the
// draft; a tile's onTile returns true (answered: go on), 'redraw', or nothing.
// onAct (any other [data-act] button) returns 'redraw' or 'read-redraw'. A
// `.gl-lead` paragraph in the html moves up into Kels's bubble.
import { esc } from './ui.js';

// --- Little HTML helpers the screens share -------------------------------------

export const tile = (act, value, labelHtml, { selected = false, sub = '' } = {}) =>
  `<button type="button" class="gl-tile${selected ? ' selected' : ''}" data-act="${esc(act)}" data-value="${esc(value)}">
    <span class="gl-tile-label">${labelHtml}</span>${sub ? `<span class="gl-tile-sub">${esc(sub)}</span>` : ''}</button>`;

export const field = (labelText, inputHtml, hint = '') =>
  `<div class="field gl-field"><label>${esc(labelText)}</label>${inputHtml}${hint ? `<span class="field-hint">${esc(hint)}</span>` : ''}</div>`;

export const input = (id, value, { type = 'text', placeholder = '', min = null, max = null, step = null, inputmode = '', list = '', label = '' } = {}) =>
  `<input id="${id}" type="${type}" value="${esc(value ?? '')}"${placeholder ? ` placeholder="${esc(placeholder)}"` : ''}${min != null ? ` min="${min}"` : ''}${max != null ? ` max="${max}"` : ''}${step != null ? ` step="${step}"` : ''}${inputmode ? ` inputmode="${inputmode}"` : ''}${list ? ` list="${list}"` : ''}${label ? ` aria-label="${esc(label)}"` : ''}>`;

export const options = (vocab, current, blankLabel = null) =>
  (blankLabel != null ? `<option value="">${esc(blankLabel)}</option>` : '') +
  vocab.map((v) => `<option value="${esc(v.value)}"${v.value === current ? ' selected' : ''}>${esc(v.label)}</option>`).join('');

export const stepper = (id, value, labelText) => `
  <div class="gl-stepper">
    <span class="gl-stepper-label">${esc(labelText)}</span>
    <button type="button" class="btn gl-step-btn" data-step-for="${id}" data-delta="-1" aria-label="One fewer">−</button>
    <input id="${id}" type="number" min="0" inputmode="numeric" value="${esc(value ?? '')}">
    <button type="button" class="btn gl-step-btn" data-step-for="${id}" data-delta="1" aria-label="One more">+</button>
  </div>`;

export const val = (root, id) => root.querySelector(`#${id}`)?.value.trim() ?? '';

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The add-a-kennel and add-a-person fields Kels asks wherever she makes an
// outside kennel or a breeder / owner contact (the tidy-up, the litter task's
// outside parent, Add dogs' breeder), so they read the same everywhere.
export const kennelNameField = (id, value = '') =>
  field('Kennel name', input(id, value, { placeholder: 'e.g. Elmwood Kennels' }));

export const contactFields = (prefix, v = {}, { nameLabel = 'Name' } = {}) =>
  `${field(nameLabel, input(`${prefix}-name`, v.name, { placeholder: 'e.g. Pat Smith' }))}
  ${field('Phone (optional)', input(`${prefix}-phone`, v.phone, { type: 'tel' }))}
  ${field('Email (optional)', input(`${prefix}-email`, v.email, { type: 'email' }))}`;

// A breed, picked from hers (dogSearch.breedChoices) or typed as a new one, so
// a breed she has is one tap and never retyped (or mistyped). `allowBlank`: a
// "Different for each" choice (the value ''). wireBreedPicker shows the box for
// a new breed; readBreedPicker gives the breed.
export function breedPicker(prefix, current, breeds, { allowBlank = false, label = 'Breed' } = {}) {
  const has = breeds.find((b) => b.toLowerCase() === String(current || '').trim().toLowerCase());
  const isNew = Boolean(String(current || '').trim()) && !has;
  const pick = has || (isNew || !breeds.length ? '__new' : '');
  const radio = (value, text, sub = '') => `<label class="ck-check"><input type="radio" name="${prefix}-pick" value="${esc(value)}"${pick === value ? ' checked' : ''}> <span>${text}${sub ? ` <span class="faint">${esc(sub)}</span>` : ''}</span></label>`;
  return `<div class="field gl-field"><label>${esc(label)}</label>
      <div class="ck-checks gd-breeds">
        ${allowBlank ? radio('', 'Different for each') : ''}
        ${breeds.map((b) => radio(b, esc(b))).join('')}
        ${radio('__new', breeds.length ? '➕ A new breed' : 'Type the breed')}
      </div>
      <div id="${prefix}-new"${pick === '__new' ? '' : ' hidden'}>${input(`${prefix}-name`, isNew ? current : '', { placeholder: 'e.g. Golden Retriever', label: 'New breed' })}</div>
    </div>`;
}

export function wireBreedPicker(root, prefix) {
  root.querySelectorAll(`input[name="${prefix}-pick"]`).forEach((r) => r.addEventListener('change', () => {
    const box = root.querySelector(`#${prefix}-new`);
    box.hidden = r.value !== '__new';
    if (!box.hidden) box.querySelector('input')?.focus();
  }));
}

export function readBreedPicker(root, prefix) {
  const v = root.querySelector(`input[name="${prefix}-pick"]:checked`)?.value ?? '';
  return v === '__new' ? val(root, `${prefix}-name`) : v;
}

export const readContactFields = (root, prefix) => ({
  name: val(root, `${prefix}-name`), phone: val(root, `${prefix}-phone`), email: val(root, `${prefix}-email`)
});

export function pagesPrefix() {
  return location.pathname.includes('/pages/') ? '' : 'pages/';
}

// --- The engine ------------------------------------------------------------------
// A task subclasses this and supplies:
//   async loadSteps()   → the step ids for the draft as it stands
//   screenFor(stepId)   → the screen (above)
//   problem(stepId)     → a plain-language problem with the answers (it stays),
//                         a check she can tap past ({ key, message }: said
//                         once, then skipped while draft.warned[key]), or null
//   answerText(stepId)  → her reply bubble once the step is answered
//   persist()           → keep the draft (settings.js)
//   answerChanged()     → an answer changed (a save that stopped partway rewrites)
//   onAnswered(stepId)  → optional, after a step's checks pass
//   async save()        → "Yes, build it" on the review
export class StepConversation {
  constructor(chat, draft) {
    Object.assign(this, { chat, draft, steps: [], current: null, panel: null, busy: false });
  }

  answerChanged() {}
  onAnswered() {}

  async refreshSteps() {
    this.steps = await this.loadSteps();
  }

  async start() {
    await this.refreshSteps();
    const step = this.steps.includes(this.draft.step) ? this.draft.step : this.steps[0];
    await this.ask(step);
  }

  // Kels asks `stepId`: her question, then the breeder's answer panel.
  async ask(stepId, { typing = 650 } = {}) {
    await this.refreshSteps();
    if (!this.steps.includes(stepId)) stepId = this.steps[0];
    this.draft.step = stepId;
    this.persist();
    this.current = this.screenFor(stepId);
    const bubble = await this.chat.say(`<strong>${this.current.title}</strong>`, { typing });
    this.panel = this.chat.panel('');
    this.fillPanel(bubble);
  }

  // (Re)draw the answer panel for the current step. A lead line in the screen
  // moves up into Kels's bubble, so she's the one saying it.
  fillPanel(bubble = null) {
    const isReview = Boolean(this.current.isReview);
    const canBack = this.draft.history.length > 0;
    this.panel.innerHTML = `<div class="gl-body">${this.current.html}</div>
      <div class="gl-error" aria-live="assertive"></div>
      <div class="kels-panel-foot">
        ${canBack ? '<button type="button" class="btn gl-back" data-k="back">← Back</button>' : '<span></span>'}
        ${this.draft.returnToReview && !isReview ? '<button type="button" class="btn" data-k="to-review">Back to the plan</button>' : ''}
        ${isReview
          ? '<button type="button" class="btn btn-primary gl-next" data-k="save">Yes, build it</button>'
          : '<button type="button" class="btn btn-primary gl-next" data-k="next">Next →</button>'}
      </div>`;
    const lead = this.panel.querySelector('.gl-lead');
    if (lead && bubble) { lead.classList.remove('gl-lead'); lead.classList.add('kels-lead'); bubble.appendChild(lead); }
    else if (lead) lead.remove();
    this.wire();
    this.chat.scroll();
  }

  body() { return this.panel.querySelector('.gl-body'); }
  showError(msg) { this.panel.querySelector('.gl-error').innerHTML = msg ? `<div class="inline-error gl-inline-error">${esc(msg)}</div>` : ''; this.chat.scroll(); }

  async redraw() {
    await this.refreshSteps();
    this.current = this.screenFor(this.draft.step);
    this.fillPanel();
  }

  wire() {
    const body = this.body();
    const cur = this.current;
    body.querySelectorAll('.gl-tile').forEach((b) => b.addEventListener('click', async () => {
      if (this.busy) return;
      cur.read?.(body);
      const result = cur.onTile?.(b.dataset.value, body, b.dataset.act);
      this.answerChanged();
      if (result === 'redraw') { this.persist(); await this.redraw(); return; }
      if (result === true) await this.advance({ skipRead: true });
    }));
    body.querySelectorAll('[data-act]:not(.gl-tile)').forEach((b) => b.addEventListener('click', async () => {
      const result = cur.onAct?.(b.dataset.act, body, b);
      if (result === 'read-redraw' || result === 'redraw') {
        cur.read?.(body);
        if (result === 'read-redraw') this.answerChanged();
        this.persist();
        await this.redraw();
      }
    }));
    body.querySelectorAll('[data-step-for]').forEach((b) => b.addEventListener('click', () => {
      const el = body.querySelector(`#${b.dataset.stepFor}`);
      el.value = String(Math.max(0, (Number(el.value) || 0) + Number(b.dataset.delta)));
    }));
    body.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => this.change(b.dataset.goto)));
    body.querySelectorAll('input').forEach((el) => el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.advance(); }
    }));
    cur.wire?.(body);
    const on = (k, fn) => this.panel.querySelector(`[data-k="${k}"]`)?.addEventListener('click', fn);
    on('back', () => this.back());
    on('next', () => this.advance());
    on('to-review', () => this.advance({ toReview: true }));
    on('save', () => this.save());
  }

  // Her answer to the current step goes into the chat as her reply.
  answered(stepId) {
    const q = this.panelQuestionText();
    const a = this.answerText(stepId) || 'Done';
    this.draft.history.push({ step: stepId, q, a });
    this.panel.closest('.kels-row').remove();
    this.chat.you(a);
  }

  panelQuestionText() {
    const tmp = document.createElement('div');
    tmp.innerHTML = this.current.title;
    return tmp.textContent;
  }

  async advance({ skipRead = false, toReview = false } = {}) {
    if (this.busy) return;
    this.busy = true;
    try {
      const shown = this.steps;
      const body = this.body();
      if (!skipRead) { this.current.read?.(body); this.answerChanged(); }
      await this.refreshSteps();
      const problem = this.problem(this.draft.step);
      if (typeof problem === 'string' && problem) { this.persist(); this.showError(problem); return; }
      if (problem?.key) {
        // A "did you mean?": said once, then Next again keeps what she typed
        // (the task's check skips a key in draft.warned).
        (this.draft.warned || (this.draft.warned = {}))[problem.key] = true;
        this.persist();
        this.showError(`${problem.message} If it's right as you typed it, tap Next again.`);
        return;
      }
      this.current.after?.();
      this.onAnswered(this.draft.step);
      const stepId = this.draft.step;
      this.answered(stepId);
      this.persist();
      // The answer can change which steps there are, and even remove this one:
      // go on from where it was.
      const at = shown.indexOf(stepId);
      await this.refreshSteps();
      let next;
      if (toReview || (this.draft.returnToReview && stepId !== 'review')) {
        // Fixing something from the plan: straight back to the plan, unless the
        // fix opened a question that hasn't been answered yet.
        const answered = new Set(this.draft.history.map((h) => h.step));
        next = this.steps.find((x) => x !== 'review' && !answered.has(x) && this.steps.indexOf(x) > this.steps.indexOf(stepId)) || 'review';
        if (next === 'review') this.draft.returnToReview = false;
      } else {
        const here = this.steps.indexOf(stepId);
        next = here !== -1 ? this.steps[Math.min(here + 1, this.steps.length - 1)]
          : shown.slice(at + 1).find((x) => this.steps.includes(x)) || this.steps[this.steps.length - 1];
      }
      await this.ask(next);
    } finally {
      this.busy = false;
    }
  }

  // Back: Kels un-asks the last question; her last answer comes off the chat.
  async back() {
    if (this.busy || !this.draft.history.length) return;
    this.current.read?.(this.body());
    const prev = this.draft.history.pop();
    this.panel.closest('.kels-row').remove();
    // Remove the current question bubble and the previous answer + question.
    const rows = [...this.chat.box.querySelectorAll('.kels-row')];
    rows.slice(-3).forEach((r) => r.remove());
    this.persist();
    await this.ask(prev.step, { typing: 0 });
  }

  // "Change" from the plan: ask that step again, then come back to the plan.
  async change(stepId) {
    this.draft.returnToReview = true;
    this.panel.closest('.kels-row').remove();
    this.chat.you('Let me change something.');
    await this.ask(stepId);
  }

  // Replay a resumed draft's chat, greyed, before carrying on.
  static async replay(chat, history) {
    for (const h of history) {
      const b = await chat.say(esc(h.q), { typing: 0 });
      b.classList.add('kels-past');
      chat.you(h.a);
    }
  }
}
