// kelsChat.js — the chat transcript Kels's guided tasks talk through (pages/kels.*).
// Kels is a scripted helper, not a model: every line she "types" is written in
// the task scripts (assets/guidedLitterUI.js and friends). This module only
// draws the conversation: Kels's messages (after a short typing indicator), the
// breeder's replies, and the answer panels the breeder's inputs live in, all in
// one box that scrolls itself to the newest message.
import { esc } from './ui.js';

// Who Kels is, in one place: every page, task script and the floating button
// read these, so a new name, title or line changes here only. `photo` is a path under
// assets/ (precached in sw.js), or null to show her initial instead.
export const KELS = Object.freeze({
  name: 'Kels',
  tagline: 'your personal KennelOS agent',
  title: 'Kels, the KennelOS whiz', // the Kels page header
  assistLabel: 'Ask Kels',
  photo: 'assets/kels.png'
});
export const KELS_NAME = KELS.name;
export const ASSIST_LABEL = KELS.assistLabel;

// Kels's opening line, from the menu or when a page sends the breeder straight to a task.
export const kelsHello = () => `Hi, I'm ${esc(KELS.name)}, ${esc(KELS.tagline)}!`;

// Her first message on the Kels page, before "Finding Something" / "Doing Something" /
// "Understanding Something".
export const kelsWelcome = () => `${kelsHello()} I'm here to help you manage your kennel :) What do you need help with first?`;

// How she works, said at the start of every new task (not a resumed one), after
// the task's own opener. The answers are INTRO_CHOICES.
export const KELS_INTRO = 'I\'ll ask you some questions; once I\'m done collecting the information, I\'ll build the records for you to approve. If you get stuck or need to save and come back, I\'ll save what we\'ve got so far until you\'re ready to continue. Sound good?';
// Finding Something's version: it searches, so there are no records to approve.
export const KELS_FIND_INTRO = 'I\'ll look through the app and try to find what you\'re looking for. I\'ll search app features and your existing records. If I find several matches, I\'ll ask you to choose one or ask follow-up questions. Sound good?';
// How KennelOS works's version (Understanding Something): it explains, so nothing
// is asked or built. Every edition, so it names nothing Lite lacks.
export const KELS_UNDERSTAND_INTRO = 'I can explain the rules KennelOS follows behind the scenes, the ones that aren\'t obvious from the screens, like what keeps a litter open or when a payment counts as earned. Pick a topic or search in your own words, and I\'ll answer in plain language and show you where it lives. Sound good?';
const INTRO_CHOICES = [
  { label: 'Sounds great, let\'s start!', value: 'start', primary: true },
  { label: 'Never mind', value: 'nevermind' }
];

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

// Search words: lower case, accents and punctuation dropped.
const searchWords = (text) => String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .split(/[^a-z0-9]+/).filter(Boolean);

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

    // Reply buttons, two across, that fade in one at a time. `choices`: [{ label,
    // sub?, value, primary?, keywords? }]. A choice with a `sub` opens on the first
    // tap to show it (and `confirmHint`), and is chosen on the second; one without
    // is chosen on the first. `search` puts a box above them that filters as she
    // types (`search.placeholder`): every typed word must start a word in the
    // label, sub or `keywords` (her own words for it: "add puppies" finds
    // "Record a new litter"). Enter picks the first match. Resolves with the
    // chosen value; the buttons are replaced by her reply bubble (unless !echo).
    // A choice with `star` (true/false) gets a ☆ in its corner, its own tap
    // target that never opens or picks it: `onStar(value, on)` keeps the change.
    // `note` is a line always shown under the label; `noteAction` ({ label,
    // run(value) }) a small button shown when the choice is open, that runs and
    // then takes the note away.
    async choose(choices, { stagger = 160, echo = true, search = null, confirmHint = 'Tap again to choose', onStar = null } = {}) {
      const holder = add(row('kels-from-you kels-choices-row', `<div class="kels-pick">
        ${search ? `<input type="search" class="kels-search" placeholder="${esc(search.placeholder || 'Search')}" aria-label="${esc(search.placeholder || 'Search')}" autocomplete="off" enterkeyhint="go">
        <p class="kels-search-empty" hidden></p>` : ''}
        <div class="kels-choices"></div></div>`));
      const list = holder.querySelector('.kels-choices');
      const buttons = [];
      for (const c of choices) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `kels-choice${c.primary ? ' primary' : ''}${c.sub ? ' has-sub' : ''}`;
        b.dataset.value = c.value;
        if (c.sub) b.setAttribute('aria-expanded', 'false');
        b.innerHTML = `<span class="kels-choice-label">${esc(c.label)}</span>${c.note ? `<span class="kels-choice-note">${esc(c.note)}</span>` : ''}${c.sub ? `<span class="kels-choice-sub">${esc(c.sub)}</span><span class="kels-choice-hint">${esc(confirmHint)}</span>` : ''}`;
        b._words = searchWords([c.label, c.sub, ...(c.keywords || [])].join(' '));
        // The button's cell in the grid: the button itself, or a holder for it and its star.
        b._cell = b;
        if (typeof c.star === 'boolean' && onStar) {
          const cell = document.createElement('div');
          cell.className = 'kels-choice-cell';
          cell.appendChild(b);
          const star = document.createElement('button');
          star.type = 'button';
          star.className = 'kels-star';
          let on = c.star;
          const show = () => {
            star.textContent = on ? '★' : '☆';
            star.setAttribute('aria-pressed', String(on));
            star.setAttribute('aria-label', `${on ? 'Unstar' : 'Star'} ${c.label}`);
            star.title = on ? 'Starred: always at the top' : 'Star it to keep it at the top';
          };
          show();
          star.addEventListener('click', (e) => { e.stopPropagation(); on = !on; show(); onStar(c.value, on); });
          cell.appendChild(star);
          if (c.noteAction) {
            const aside = document.createElement('button');
            aside.type = 'button';
            aside.className = 'kels-choice-aside';
            aside.textContent = c.noteAction.label;
            aside.addEventListener('click', (e) => {
              e.stopPropagation();
              c.noteAction.run(c.value);
              b.querySelector('.kels-choice-note')?.remove();
              aside.remove();
            });
            cell.appendChild(aside);
          }
          b._cell = cell;
        }
        list.appendChild(b._cell);
        buttons.push(b);
        scroll();
        if (stagger) await pause(stagger);
        b.classList.add('in');
      }
      const close = () => buttons.forEach((x) => { if (x.classList.contains('open')) { x.classList.remove('open'); x._cell.classList.remove('open'); x.setAttribute('aria-expanded', 'false'); } });
      return new Promise((resolve) => {
        const pickBtn = (b) => {
          const choice = choices.find((c) => String(c.value) === b.dataset.value);
          holder.remove();
          if (echo) this.you(choice.label);
          resolve(choice.value);
        };
        list.addEventListener('click', (e) => {
          const b = e.target.closest('.kels-choice');
          if (!b) return;
          if (b.classList.contains('has-sub') && !b.classList.contains('open')) {
            close();
            b.classList.add('open');
            b._cell.classList.add('open');
            b.setAttribute('aria-expanded', 'true');
            b.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
            return;
          }
          pickBtn(b);
        });
        const box = holder.querySelector('.kels-search');
        if (!box) return;
        const empty = holder.querySelector('.kels-search-empty');
        const visible = () => buttons.filter((b) => !b._cell.hidden);
        box.addEventListener('input', () => {
          const q = searchWords(box.value);
          for (const b of buttons) b._cell.hidden = !q.every((w) => b._words.some((x) => x.startsWith(w)));
          close();
          const none = !visible().length;
          empty.hidden = !none;
          empty.textContent = none ? `Nothing matches "${box.value.trim()}". Try other words, or clear the search.` : '';
        });
        box.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const first = visible()[0];
          if (first && box.value.trim()) pickBtn(first);
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

    // A new task's start: her `opener` (trusted markup: "Sure thing, let's…"),
    // KELS_INTRO, and Sounds great / Never mind. → true to go ahead.
    // `how`: what she'll do, after the opener (KELS_INTRO unless a task says otherwise).
    async intro(opener, how = KELS_INTRO) {
      await this.say(`${opener} ${how}`, { typing: 900 });
      return (await this.choose(INTRO_CHOICES)) === 'start';
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
