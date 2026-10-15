// kelsChat.js — the chat transcript Kels's guided tasks talk through (pages/kels.*).
// Kels is a scripted helper, not a model: every line she "types" is written in
// the task scripts (assets/guidedLitterUI.js and friends). This module only
// draws the conversation: Kels's messages (after a short typing indicator), the
// breeder's replies, and the answer panels the breeder's inputs live in, all in
// one box that scrolls itself to the newest message.
import { esc } from './ui.js';

// Who Kels is, in one place: every page, task script and the floating button
// read these, so a new name or line changes here only. `photo` is a path under
// assets/ (precached in sw.js), or null to show her initial instead.
export const KELS = Object.freeze({
  name: 'Kels',
  tagline: 'your personal KennelOS agent',
  assistLabel: 'Ask Kels',
  photo: 'assets/kels.png'
});
export const KELS_NAME = KELS.name;
export const ASSIST_LABEL = KELS.assistLabel;

// Kels's opening line, from the menu or when a page sends the breeder straight to a task.
export const kelsHello = () => `Hi, I'm ${esc(KELS.name)}, ${esc(KELS.tagline)}!`;

// Kels's photo as a URL any page can use (KELS.photo is relative to shared/,
// and this module lives in shared/assets/).
export const kelsPhotoUrl = () => (KELS.photo ? new URL(`../${KELS.photo}`, import.meta.url).href : null);

// Kels's avatar: the photo when there is one, else her initial.
export function kelsAvatar({ large = false } = {}) {
  const cls = `kels-avatar${large ? ' kels-avatar-lg' : ''}`;
  return KELS.photo
    ? `<img class="${cls} kels-avatar-photo" src="${esc(kelsPhotoUrl())}" alt="" aria-hidden="true">`
    : `<span class="${cls}" aria-hidden="true">${esc(KELS.name[0])}</span>`;
}

const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const pause = (ms) => new Promise((r) => setTimeout(r, reducedMotion() ? Math.min(ms, 80) : ms));

// A chat in `box` (the scrolling transcript element).
export function createChat(box) {
  const scroll = () => {
    // After layout, so a just-added panel's full height counts.
    requestAnimationFrame(() => box.scrollTo({ top: box.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' }));
  };
  const add = (el) => { box.appendChild(el); scroll(); return el; };
  const row = (cls, innerHtml) => {
    const el = document.createElement('div');
    el.className = `kels-row ${cls}`;
    el.innerHTML = innerHtml;
    return el;
  };
  const avatar = kelsAvatar();

  return {
    box,
    scroll,
    clear() { box.innerHTML = ''; },

    // Kels "types" for a moment, then says `html` (trusted markup: callers esc()
    // every user value). Returns the bubble so a caller can add to it.
    async say(html, { typing = 600 } = {}) {
      if (typing) {
        const dots = add(row('kels-from-kels', `${avatar}<div class="kels-bubble kels-typing" aria-label="${esc(KELS_NAME)} is typing"><span></span><span></span><span></span></div>`));
        await pause(typing);
        dots.remove();
      }
      const el = add(row('kels-from-kels', `${avatar}<div class="kels-bubble"></div>`));
      el.querySelector('.kels-bubble').innerHTML = html;
      return el.querySelector('.kels-bubble');
    },

    // Her reply, as plain text.
    you(text) {
      const el = add(row('kels-from-you', '<div class="kels-bubble"></div>'));
      el.querySelector('.kels-bubble').textContent = text;
      return el;
    },

    // Where she answers: a card on her side of the chat holding the inputs.
    panel(html = '') {
      const el = add(row('kels-from-you kels-panel-row', `<div class="kels-panel">${html}</div>`));
      return el.querySelector('.kels-panel');
    },

    // Reply buttons that fade in one at a time. `choices`: [{ label, sub?, value,
    // primary? }]. Resolves with the chosen value; the buttons are replaced by
    // her reply bubble (unless keep).
    async choose(choices, { stagger = 160, echo = true } = {}) {
      const holder = add(row('kels-from-you kels-choices-row', '<div class="kels-choices"></div>'));
      const list = holder.querySelector('.kels-choices');
      for (const c of choices) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `kels-choice${c.primary ? ' primary' : ''}`;
        b.dataset.value = c.value;
        b.innerHTML = `<span class="kels-choice-label">${esc(c.label)}</span>${c.sub ? `<span class="kels-choice-sub">${esc(c.sub)}</span>` : ''}`;
        list.appendChild(b);
        scroll();
        if (stagger) await pause(stagger);
        b.classList.add('in');
      }
      return new Promise((resolve) => {
        list.addEventListener('click', (e) => {
          const b = e.target.closest('.kels-choice');
          if (!b) return;
          const choice = choices.find((c) => String(c.value) === b.dataset.value);
          holder.remove();
          if (echo) this.you(choice.label);
          resolve(choice.value);
        });
      });
    },

    // Kels asks with a form: her `title` (trusted markup), then the breeder's panel holding
    // `html`, an error line and the foot (`cancelLabel` and `submitLabel`). Enter
    // in a text box submits. `submit(root)` does the work: return a string to show
    // it as a problem and stay; anything else finishes, and the panel becomes her
    // reply (`reply(result)`, else the submit label). A thrown error is shown the
    // same way (the Demo's "changes aren't saved", say). `wire(root)` hooks up
    // anything extra. → { done: true, result } | { done: false } on cancel.
    async form({ title, html, submit, wire = null, reply = null, submitLabel = 'Save', cancelLabel = 'Never mind', typing = 600 }) {
      if (title) await this.say(title, { typing });
      const panel = this.panel(`<div class="gl-body">${html}</div>
        <div class="gl-error" aria-live="assertive"></div>
        <div class="kels-panel-foot">
          <button type="button" class="btn gl-back" data-k="cancel">${esc(cancelLabel)}</button>
          <button type="button" class="btn btn-primary gl-next" data-k="submit">${esc(submitLabel)}</button>
        </div>`);
      const body = panel.querySelector('.gl-body');
      const errorBox = panel.querySelector('.gl-error');
      const showError = (msg) => {
        errorBox.innerHTML = msg ? `<div class="inline-error gl-inline-error">${esc(msg)}</div>` : '';
        scroll();
      };
      wire?.(body, { showError });
      scroll();
      return new Promise((resolve) => {
        let busy = false;
        const btn = panel.querySelector('[data-k="submit"]');
        const go = async () => {
          if (busy) return;
          busy = true;
          btn.disabled = true;
          showError('');
          try {
            const result = await submit(body);
            if (typeof result === 'string') { showError(result); return; }
            panel.closest('.kels-row').remove();
            this.you(reply ? reply(result) : submitLabel);
            resolve({ done: true, result });
          } catch (e) {
            showError(e?.message || String(e));
          } finally {
            busy = false;
            btn.disabled = false;
          }
        };
        btn.addEventListener('click', go);
        body.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && e.target.matches('input:not([type="checkbox"]):not([type="radio"])')) { e.preventDefault(); go(); }
        });
        panel.querySelector('[data-k="cancel"]').addEventListener('click', () => {
          panel.closest('.kels-row').remove();
          this.you(cancelLabel);
          resolve({ done: false });
        });
      });
    },

    pause
  };
}

// The floating "Ask Kels" button, bottom right on every page but Kels's own
// (app.js). A dot shows when a task is waiting to be finished.
export function renderAssistButton({ pending = false } = {}) {
  if (location.pathname.endsWith('/kels.html') || document.querySelector('.kels-fab')) return;
  const prefix = location.pathname.includes('/pages/') ? '' : 'pages/';
  const a = document.createElement('a');
  a.className = 'kels-fab';
  a.href = `${prefix}kels.html`;
  a.title = `${KELS.name}, ${KELS.tagline}${pending ? ': you have something to finish' : ''}`;
  a.setAttribute('aria-label', `${ASSIST_LABEL}${pending ? ' (something to finish)' : ''}`);
  const icon = KELS.photo
    ? `<img class="kels-fab-photo" src="${esc(kelsPhotoUrl())}" alt="" aria-hidden="true">`
    : '<span class="kels-fab-icon" aria-hidden="true">✨</span>';
  a.innerHTML = `${icon}<span class="kels-fab-label">${esc(ASSIST_LABEL)}</span>${pending ? '<span class="kels-fab-dot" aria-hidden="true"></span>' : ''}`;
  document.body.appendChild(a);
}
