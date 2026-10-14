// ken.js — Ken, the guided-task helper (the floating "Ask Ken" button on
// every page opens this). Ken greets her, offers his tasks one at a time, and
// then walks her through the one she picks as a chat (assets/kenChat.js). He's
// scripted, not a model: every line is written in the task scripts.
//
// TASKS is his menu. Each task has a priority(state) — the higher, the nearer
// the top — so as more scripts are added they can be ordered by what she's
// likely to need (an unfinished task first, then whatever fits her kennel now).
// URL: ?task=<id> starts that task straight away; &litter=<id> hands the litter
// task an Expected litter (from that litter's page).
import { createChat, KEN_NAME } from '../assets/kenChat.js';
import { runLitterTask, pendingLitterDraft, discardGuidedLitterDraft } from '../assets/guidedLitterUI.js';
import { param, esc } from '../assets/ui.js';

const chat = createChat(document.getElementById('ken-transcript'));
const laterBtn = document.getElementById('ken-later');
document.getElementById('ken-name').textContent = KEN_NAME;

// Ken's tasks. `state`: { pendingLitter } (the unfinished litter draft, if any).
const TASKS = [
  {
    id: 'resume-litter',
    label: (s) => `Finish recording ${s.pendingLitter?.label || 'your litter'}`,
    sub: 'Pick up where we left off',
    available: (s) => Boolean(s.pendingLitter),
    priority: () => 100, // something half-done always comes first
    run: (opts) => runLitterTask(chat, { ...opts, resume: true })
  },
  {
    id: 'record-litter',
    label: () => 'Record a new litter',
    sub: 'The parents, the puppies, and getting them ready for families',
    available: () => true,
    priority: () => 50,
    run: (opts) => runLitterTask(chat, opts)
  }
];

const state = () => ({ pendingLitter: pendingLitterDraft() });

function running(on) {
  laterBtn.hidden = !on;
}

// Back to the menu after a task ends, is put off, or she says never mind.
async function onExit(reason) {
  running(false);
  if (reason === 'nevermind') await chat.ken('No problem!');
  await menu({ again: true });
}

async function startTask(task, opts = {}) {
  // Starting a new litter while one is unfinished: finish that first, or start fresh?
  if (task.id === 'record-litter' && state().pendingLitter) {
    const p = state().pendingLitter;
    await chat.ken(`You have an unfinished litter (${esc(p.label || 'started earlier')}). Want to finish that one first?`);
    const pick = await chat.choose([
      { label: 'Finish that one', value: 'resume', primary: true },
      { label: 'Start fresh (throw it away)', value: 'fresh' }
    ]);
    if (pick === 'resume') { running(true); return TASKS[0].run({ onExit, onSaved: () => running(false) }); }
    discardGuidedLitterDraft();
  }
  running(true);
  return task.run({ ...opts, onExit, onSaved: () => running(false) });
}

async function menu({ again = false } = {}) {
  const s = state();
  const tasks = TASKS.filter((t) => t.available(s)).sort((a, b) => b.priority(s) - a.priority(s));
  await chat.ken(again ? 'What else can I help you with?' : `Hi, I'm ${esc(KEN_NAME)}! What can I help you do today?`, { typing: again ? 600 : 1300 });
  const id = await chat.choose(tasks.map((t) => ({ label: t.label(s), sub: t.sub, value: t.id })), { stagger: 350 });
  await startTask(TASKS.find((t) => t.id === id));
}

laterBtn.addEventListener('click', async () => {
  // Her answers are already kept after every step; this just says so.
  chat.box.querySelectorAll('.ken-panel-row, .ken-choices-row').forEach((r) => r.remove());
  chat.you('Let\'s finish this later.');
  running(false);
  await chat.ken('Saved! I\'ll keep what we\'ve got until you\'re ready to continue. Just tap me any time.');
  await menu({ again: true });
});

async function main() {
  const asked = TASKS.find((t) => t.id === param('task'));
  if (!asked) { await menu(); return; }
  await chat.ken(`Hi, I'm ${esc(KEN_NAME)}!`, { typing: 900 });
  chat.you(asked.label(state()));
  await startTask(asked, { litterId: param('litter') || null });
}

main().catch((e) => chat.ken(`Sorry, something went wrong: ${esc(e.message || String(e))}`, { typing: 0 }));
