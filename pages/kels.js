// kels.js — Kels, the guided-task helper (the floating "Ask Kels" button on
// every page opens this). Kels greets the breeder, offers her tasks one at a
// time, and then walks the breeder through the one picked, as a chat
// (assets/kelsChat.js). She's scripted, not a model: every line is written in
// the task scripts. Who she is (name, line, photo) lives in kelsChat.js `KELS`.
//
// TASKS is her menu. A task is { id, label(s), sub, keywords, available(s),
// priority(s), run(opts), resumable?, beforeStart?(opts) }. `keywords` are the
// other words a breeder might search the menu with ("add puppies" for a new
// litter); the label and sub are searched too, so they needn't repeat them: the higher the priority, the
// nearer the top, so tasks are ordered by what she's likely to need (something
// unfinished first, then whatever fits her kennel now). `resumable` tasks keep
// a draft, so the header's "Save for later" shows while they run.
// `beforeStart` can redirect a start (an unfinished draft of the same task).
// URL: ?task=<id> starts that task straight away; &litter=<id> hands it a litter
// (an Expected litter's birth, or the litter to check on).
import { createChat, KELS, kelsAvatar, kelsHello } from '../assets/kelsChat.js';
import { runLitterTask, pendingLitterDraft, discardGuidedLitterDraft } from '../assets/guidedLitterUI.js';
import { runCheckinTask, checkinState } from '../assets/litterCheckinUI.js';
import { runTidyTask } from '../assets/tidyUpUI.js';
import { param, esc } from '../assets/ui.js';

const chat = createChat(document.getElementById('kels-transcript'));
const laterBtn = document.getElementById('kels-later');
document.getElementById('kels-name').textContent = KELS.title;
document.getElementById('kels-avatar').innerHTML = kelsAvatar({ large: true });

// Kels's tasks. `state`: { pendingLitter, litters: { open, withPups } }.
const TASKS = [
  {
    id: 'resume-litter',
    label: (s) => `Finish recording ${s.pendingLitter?.label || 'your litter'}`,
    sub: 'Pick up where we left off',
    keywords: ['continue', 'resume', 'unfinished', 'draft', 'add puppies', 'puppies', 'whelp', 'birth', 'born'],
    available: (s) => Boolean(s.pendingLitter),
    priority: () => 100, // something half-done always comes first
    resumable: true,
    run: (opts) => runLitterTask(chat, { ...opts, resume: true })
  },
  {
    id: 'checkin',
    label: () => 'Check in on a litter',
    sub: 'Weights, medication, and what the litter needs next',
    keywords: ['weigh', 'weight', 'deworm', 'flea', 'tick', 'shots', 'vaccine', 'vaccination', 'medicine', 'vet', 'microchip', 'chip',
      'wean', 'weaning', 'ready', 'pickup', 'go home', 'going home', 'boarding', 'picks', 'deposit', 'sold', 'close', 'puppy plans', 'update puppies'],
    available: (s) => s.litters.open > 0,
    // With pups at home, the weekly check-in is the likely reason she's here.
    priority: (s) => (s.litters.withPups ? 60 : 40),
    run: (opts) => runCheckinTask(chat, opts)
  },
  {
    id: 'record-litter',
    label: () => 'Record a new litter',
    sub: 'The parents, the puppies, and getting them ready for families',
    keywords: ['add puppies', 'new puppies', 'puppies arrived', 'whelp', 'whelped', 'birth', 'born', 'delivered puppies', 'add litter', 'enter litter', 'log litter'],
    available: () => true,
    priority: () => 50,
    resumable: true,
    // Starting a new litter while one is unfinished: finish that first, or start fresh?
    beforeStart: async () => {
      const p = pendingLitterDraft();
      if (!p) return null;
      await chat.say(`You have an unfinished litter (${esc(p.label || 'started earlier')}). Want to finish that one first?`);
      const pick = await chat.choose([
        { label: 'Finish that one', value: 'resume', primary: true },
        { label: 'Start fresh (throw it away)', value: 'fresh' }
      ]);
      if (pick === 'resume') return { taskId: 'resume-litter' };
      discardGuidedLitterDraft();
      return null;
    },
    run: (opts) => runLitterTask(chat, opts)
  },
  {
    id: 'tidy-up',
    label: () => 'Tidy up my records',
    sub: 'Find records that don\'t agree, and duplicates, and fix them',
    keywords: ['clean up', 'cleanup', 'fix', 'check', 'mistakes', 'errors', 'duplicate', 'duplicates', 'merge', 'combine', 'same dog', 'mismatch',
      'parents', 'sire', 'dam', 'pedigree', 'count', 'placed', 'kennel', 'contact', 'breeder', 'stud', 'audit'],
    available: () => true,
    priority: () => 30,
    run: (opts) => runTidyTask(chat, opts)
  }
];

const taskById = (id) => TASKS.find((t) => t.id === id);

async function state() {
  return { pendingLitter: pendingLitterDraft(), litters: await checkinState() };
}

function running(task) {
  laterBtn.hidden = !task?.resumable;
}

// Back to the menu after a task ends, is put off, or she says never mind.
async function onExit(reason) {
  running(null);
  if (reason === 'nevermind') await chat.say('No problem!');
  await menu({ again: true });
}

// One task hands her to another (the check-in's Expected litter → its birth).
// Her reply that led there is already in the chat.
async function handoff(taskId, opts = {}) {
  return startTask(taskById(taskId), opts);
}

async function startTask(task, opts = {}) {
  const redirect = await task.beforeStart?.(opts);
  if (redirect) task = taskById(redirect.taskId);
  running(task);
  return task.run({ ...opts, onExit, handoff, onSaved: () => running(null) });
}

async function menu({ again = false } = {}) {
  const s = await state();
  const tasks = TASKS.filter((t) => t.available(s)).sort((a, b) => b.priority(s) - a.priority(s));
  await chat.say(again ? 'What else can I help you with?' : `${kelsHello()} What can I help you do today?`, { typing: again ? 600 : 1300 });
  const id = await chat.choose(tasks.map((t) => ({ label: t.label(s), sub: t.sub, keywords: t.keywords, value: t.id })),
    { stagger: 200, search: { placeholder: 'What do you need? Try "add puppies"' }, confirmHint: 'Tap again to start' });
  await startTask(taskById(id));
}

laterBtn.addEventListener('click', async () => {
  // Her answers are already kept after every step; this just says so.
  chat.box.querySelectorAll('.kels-panel-row, .kels-choices-row').forEach((r) => r.remove());
  chat.you('Let\'s finish this later.');
  running(null);
  await chat.say('Saved! I\'ll keep what we\'ve got until you\'re ready to continue. Just tap me any time.');
  await menu({ again: true });
});

async function main() {
  const asked = taskById(param('task'));
  if (!asked) { await menu(); return; }
  await chat.say(kelsHello(), { typing: 900 });
  chat.you(asked.label(await state()));
  await startTask(asked, { litterId: param('litter') || null });
}

main().catch((e) => chat.say(`Sorry, something went wrong: ${esc(e.message || String(e))}`, { typing: 0 }));
