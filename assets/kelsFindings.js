// kelsFindings.js — the loop Kels's checking tasks share: "Tidy up my records"
// (assets/tidyUpUI.js) and "Check account health" (assets/accountHealthUI.js).
// She looks, says what she found, then raises the findings one at a time; each
// fix is saved when approved, and she looks again after every one, so a fix that
// settles another finding takes it off the list.
//
// Every finding offers "Not now" (this visit), an answer remembered on this
// device in the nudge ledger under `<prefix>:<finding key>` ("Don't ask me
// again"…), and "Stop for now". A subclass gives `load()` (sets this.findings,
// from this.notDismissed), `handle(f)` (→ 'stop' | 'left' | anything), and the
// words for `loop()`.
import { isDismissed, dismiss } from '../data/nudgeState.js';
import { esc } from './ui.js';

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export class FindingsTask {
  constructor(chat, onExit, prefix) {
    Object.assign(this, { chat, onExit, prefix, asked: new Set(), fixed: 0, findings: [] });
  }

  dismissKey(f) { return `${this.prefix}:${f.key}`; }
  notDismissed(findings) { return findings.filter((f) => !isDismissed(this.dismissKey(f))); }
  next() { return this.findings.find((f) => !this.asked.has(f.key)); }

  // The visit. `words`: { looking, report? (a function, called after the look:
  // what she saw, said before the findings), none (or a function, likewise),
  // found(findings) → html, allDone(fixed),
  // nothingDone, stopped(fixed), stoppedEmpty } (trusted markup).
  async loop(words) {
    this.words = words;
    await this.chat.say(words.looking, { typing: 700 });
    await this.load();
    const report = words.report?.();
    if (report) await this.chat.say(report, { typing: 1100 });
    if (!this.next()) {
      await this.chat.say(typeof words.none === 'function' ? words.none() : words.none);
      return this.onExit('done');
    }
    await this.chat.say(words.found(this.findings), { typing: 900 });
    for (;;) {
      const f = this.next();
      if (!f) break;
      this.asked.add(f.key);
      let res;
      try {
        res = await this.handle(f);
      } catch (e) {
        await this.chat.say(`Hmm, that didn't save: ${esc(e?.message || String(e))}`);
      }
      if (res === 'stop' || res === 'left') return res === 'stop' ? this.finish(false) : undefined;
      await this.load();
    }
    return this.finish(true);
  }

  async finish(all) {
    const w = this.words;
    if (all) await this.chat.say(this.fixed ? w.allDone(this.fixed) : w.nothingDone);
    else await this.chat.say(this.fixed ? w.stopped(this.fixed) : w.stoppedEmpty);
    this.onExit('done');
  }

  // Her answer to a finding: `actions` first, then the standard tail. Resolves
  // to the chosen value; 'never' is remembered here.
  async ask(f, html, actions, { never = 'Don\'t ask me again' } = {}) {
    await this.chat.say(html);
    const pick = await this.chat.choose([
      ...actions,
      { label: 'Not now', value: 'later' },
      ...(never ? [{ label: never, value: 'never' }] : []),
      { label: 'Stop for now', value: 'stop' }
    ], { stagger: 120 });
    if (pick === 'never') { dismiss(this.dismissKey(f)); await this.chat.say('Got it. I won\'t bring that one up again.', { typing: 400 }); }
    return pick;
  }

  async done(msg) {
    this.fixed++;
    await this.chat.say(msg, { typing: 400 });
  }
}
