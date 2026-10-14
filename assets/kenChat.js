// kenChat.js — the chat transcript Ken's guided tasks talk through (pages/ken.*).
// Ken is a scripted helper, not a model: every line he "types" is written in
// the task scripts (assets/guidedLitterUI.js and friends). This module only
// draws the conversation: his messages (after a short typing indicator), her
// replies, and the answer panels her inputs live in, all in one box that
// scrolls itself to the newest message.
import { esc } from './ui.js';

// The helper's placeholder name and the floating button's label, in one place.
export const KEN_NAME = 'Ken';
export const ASSIST_LABEL = 'Ask Ken';

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
    el.className = `ken-row ${cls}`;
    el.innerHTML = innerHtml;
    return el;
  };
  const avatar = `<span class="ken-avatar" aria-hidden="true">${esc(KEN_NAME[0])}</span>`;

  return {
    box,
    scroll,
    clear() { box.innerHTML = ''; },

    // Ken "types" for a moment, then says `html` (trusted markup: callers esc()
    // every user value). Returns the bubble so a caller can add to it.
    async ken(html, { typing = 600 } = {}) {
      if (typing) {
        const dots = add(row('ken-from-ken', `${avatar}<div class="ken-bubble ken-typing" aria-label="${esc(KEN_NAME)} is typing"><span></span><span></span><span></span></div>`));
        await pause(typing);
        dots.remove();
      }
      const el = add(row('ken-from-ken', `${avatar}<div class="ken-bubble"></div>`));
      el.querySelector('.ken-bubble').innerHTML = html;
      return el.querySelector('.ken-bubble');
    },

    // Her reply, as plain text.
    you(text) {
      const el = add(row('ken-from-you', '<div class="ken-bubble"></div>'));
      el.querySelector('.ken-bubble').textContent = text;
      return el;
    },

    // Where she answers: a card on her side of the chat holding the inputs.
    panel(html = '') {
      const el = add(row('ken-from-you ken-panel-row', `<div class="ken-panel">${html}</div>`));
      return el.querySelector('.ken-panel');
    },

    // Reply buttons that fade in one at a time. `choices`: [{ label, sub?, value,
    // primary? }]. Resolves with the chosen value; the buttons are replaced by
    // her reply bubble (unless keep).
    async choose(choices, { stagger = 160, echo = true } = {}) {
      const holder = add(row('ken-from-you ken-choices-row', '<div class="ken-choices"></div>'));
      const list = holder.querySelector('.ken-choices');
      for (const c of choices) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `ken-choice${c.primary ? ' primary' : ''}`;
        b.dataset.value = c.value;
        b.innerHTML = `<span class="ken-choice-label">${esc(c.label)}</span>${c.sub ? `<span class="ken-choice-sub">${esc(c.sub)}</span>` : ''}`;
        list.appendChild(b);
        scroll();
        if (stagger) await pause(stagger);
        b.classList.add('in');
      }
      return new Promise((resolve) => {
        list.addEventListener('click', (e) => {
          const b = e.target.closest('.ken-choice');
          if (!b) return;
          const choice = choices.find((c) => String(c.value) === b.dataset.value);
          holder.remove();
          if (echo) this.you(choice.label);
          resolve(choice.value);
        });
      });
    },

    pause
  };
}

// The floating "Ask Ken" button, bottom right on every page but Ken's own
// (app.js). A dot shows when a task is waiting to be finished.
export function renderAssistButton({ pending = false } = {}) {
  if (location.pathname.endsWith('/ken.html') || document.querySelector('.ken-fab')) return;
  const prefix = location.pathname.includes('/pages/') ? '' : 'pages/';
  const a = document.createElement('a');
  a.className = 'ken-fab';
  a.href = `${prefix}ken.html`;
  a.title = `${KEN_NAME}, your helper${pending ? ': you have something to finish' : ''}`;
  a.setAttribute('aria-label', `${ASSIST_LABEL}${pending ? ' (something to finish)' : ''}`);
  a.innerHTML = `<span class="ken-fab-icon" aria-hidden="true">✨</span><span class="ken-fab-label">${esc(ASSIST_LABEL)}</span>${pending ? '<span class="ken-fab-dot" aria-hidden="true"></span>' : ''}`;
  document.body.appendChild(a);
}
