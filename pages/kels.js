// kels.js — Kels, the guided-task helper (the floating "Ask Kels" button on
// every page opens this). Kels greets the breeder, offers her tasks one at a
// time, and then walks the breeder through the one picked, as a chat
// (assets/kelsChat.js). She's scripted, not a model: every line is written in
// the task scripts. Who she is (name, line, photo) lives in kelsChat.js `KELS`.
//
// She opens with "What do you need help with first?": Finding Something (assets/
// kelsFindUI.js: where a page or record is, with a button to it), Doing
// Something (TASKS) or Understanding Something (assets/kelsUnderstandUI.js: how
// the app works, as an FAQ), with an unfinished draft offered first.
//
// TASKS is her menu. A task is { id, label(s), sub, keywords, available(s),
// priority(s), run(opts), resumable?, beforeStart?(opts) }. `keywords` are the
// other words a breeder might search the menu with ("add puppies" for a new
// litter); the label and sub are searched too, so they needn't repeat them: the higher the priority, the
// nearer the top, so tasks are ordered by what she's likely to need (something
// unfinished first, then whatever fits her kennel now). `resumable` tasks keep
// a draft, so the header's "Save for later" shows while they run; `discard`
// throws that draft away. The header's "Cancel" shows while any task runs and,
// once she says she's sure, stops it (and discards a resumable task's draft).
// `beforeStart` can redirect a start (an unfinished draft of the same task).
// URL: ?task=<id> starts that task straight away; &litter=<id> hands it a litter
// (an Expected litter's birth, or the litter to check on).
import { createChat, KELS, kelsAvatar, kelsWelcome } from '../assets/kelsChat.js';
import { runFindTask } from '../assets/kelsFindUI.js';
import { runUnderstandTask } from '../assets/kelsUnderstandUI.js';
import { runLitterTask, pendingLitterDraft, discardGuidedLitterDraft } from '../assets/guidedLitterUI.js';
import { runCheckinTask, checkinState } from '../assets/litterCheckinUI.js';
import { runTidyTask } from '../assets/tidyUpUI.js';
import { runPrepTask, prepState } from '../assets/prepPupsUI.js';
import { runHealthTask } from '../assets/accountHealthUI.js';
import { runDogsTask, pendingDogsDraft, discardGuidedDogsDraft } from '../assets/guidedDogsUI.js';
import { runSetupTask } from '../assets/kelsSetupUI.js';
import { setupPriority } from '../data/kelsSetup.js';
import { dogRepo } from '../data/dogRepo.js';
import { pendingPeopleDraft } from '../data/guidedPeople.js';
import { pendingFormDraft } from '../data/guidedForm.js';
import { isCloudAvailable, isVaultOffered, isWaitlistOnlineOffered } from '../data/cloud/cloudConfig.js';
import { isLicenseGated } from '../data/license.js';
import { param, esc, todayYMD, confirmModal } from '../assets/ui.js';
import { orderTasks, withStart, withStar } from '../data/kelsFavorites.js';
import { getKelsFavorites, setKelsFavorites, getKelsTaskUse, setKelsTaskUse, getKelsNoPromote, setKelsNoPromote, getGuidedPeopleDraft, clearGuidedPeopleDraft, getGuidedFormDraft, clearGuidedFormDraft } from '../data/settings.js';
import { editionFlags } from '../data/editionConfig.js';

const chat = createChat(document.getElementById('kels-transcript'));
const laterBtn = document.getElementById('kels-later');
const cancelBtn = document.getElementById('kels-cancel');
document.getElementById('kels-name').textContent = KELS.title;
document.getElementById('kels-avatar').innerHTML = kelsAvatar({ large: true });

// Kels's tasks. `state`: { pendingLitter, pendingDogs, pendingPeople, pendingForm, litters: { open, withPups }, prep: { litters }, setup: { dogs } }.
// Add people (Pro, contacts): its script is Pro-only, so it's imported on start.
const runPeople = async (opts) => (await import('../assets/guidedPeopleUI.js')).runPeopleTask(chat, opts);
// Set up my application form (Pro, waitlist): the same.
const runForm = async (opts) => (await import('../assets/guidedFormUI.js')).runFormTask(chat, opts);

const TASKS = [
  {
    id: 'resume-litter',
    label: (s) => `Finish recording ${s.pendingLitter?.label || 'your litter'}`,
    sub: 'Pick up where we left off',
    keywords: ['continue', 'resume', 'unfinished', 'draft', 'add puppies', 'puppies', 'whelp', 'birth', 'born'],
    available: (s) => Boolean(s.pendingLitter),
    priority: () => 100, // something half-done always comes first
    resumable: true,
    discard: discardGuidedLitterDraft,
    run: (opts) => runLitterTask(chat, { ...opts, resume: true })
  },
  {
    id: 'resume-dogs',
    label: (s) => `Finish adding ${s.pendingDogs?.label || 'your dogs'}`,
    sub: 'Pick up where we left off',
    keywords: ['continue', 'resume', 'unfinished', 'draft', 'add dogs', 'new dog'],
    available: (s) => Boolean(s.pendingDogs),
    priority: () => 99,
    resumable: true,
    discard: discardGuidedDogsDraft,
    run: (opts) => runDogsTask(chat, { ...opts, resume: true })
  },
  {
    id: 'resume-people',
    label: (s) => `Finish adding ${s.pendingPeople?.label || 'your people'}`,
    sub: 'Pick up where we left off',
    keywords: ['continue', 'resume', 'unfinished', 'draft', 'add people', 'contacts'],
    available: (s) => Boolean(s.pendingPeople),
    priority: () => 98,
    resumable: true,
    discard: clearGuidedPeopleDraft,
    run: (opts) => runPeople({ ...opts, resume: true })
  },
  {
    id: 'resume-form',
    label: (s) => `Finish ${s.pendingForm?.label ? `${s.pendingForm.label}'s` : 'your'} application form`,
    sub: 'Pick up where we left off',
    keywords: ['continue', 'resume', 'unfinished', 'draft', 'application form', 'form', 'questions'],
    available: (s) => Boolean(s.pendingForm),
    priority: () => 97,
    resumable: true,
    discard: clearGuidedFormDraft,
    run: (opts) => runForm({ ...opts, resume: true })
  },
  {
    id: 'get-started',
    label: () => 'Getting Started',
    // Only what this edition sets up is said or searched (data/kelsSetup.js).
    sub: editionFlags.multiKennel ? 'Your logo, nudges, tests, puppy records, kennels, connections and backup'
      : editionFlags.puppyRecord ? 'Your logo, nudges, tests, puppy records, connections and backup' : 'Your backup, then your dogs',
    keywords: ['setup', 'set up', 'get started', 'getting started', 'start', 'new', 'new here', 'first time', 'begin', 'welcome', 'settings', 'backup', 'back up',
      ...(editionFlags.puppyRecord ? ['logo', 'nudges', 'lifecycle', 'promote', 'tests', 'health tests', 'preferred tests', 'ofa', 'puppy record', 'puppy records'] : []),
      ...(editionFlags.multiKennel ? ['another kennel', 'second kennel', 'new kennel', 'two kennels', 'separate'] : []),
      ...(editionFlags.furever ? ['furever', 'google drive', 'drive'] : []),
      ...(editionFlags.assistant ? ['dropbox', 'kennelassistant', 'assistant', 'helper'] : []),
      ...(isCloudAvailable() ? ['cloud'] : [])],
    // Never in the Demo, which saves nothing.
    available: () => !editionFlags.demoMode,
    // Near the top until she has her first dog record.
    priority: (s) => setupPriority(s.setup),
    run: (opts) => runSetupTask(chat, opts)
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
    discard: discardGuidedLitterDraft,
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
    id: 'prep-pups',
    label: () => 'Pups are going home',
    // Printing is Pro (Puppy Record); Lite never mentions or searches it.
    sub: editionFlags.puppyRecord ? 'Chips, shots, drop-off dates, balances, then their puppy records' : 'Chips, shots, drop-off dates and balances',
    keywords: ['go home', 'going home', 'leaving', 'pickup day', 'drop off', 'dropoff', 'ready', 'balance', 'paperwork',
      ...(editionFlags.puppyRecord ? ['puppy records', 'print', 'packet'] : []), ...(editionFlags.contracts ? ['contract'] : [])],
    available: (s) => s.prep.litters > 0,
    priority: () => 45,
    run: (opts) => runPrepTask(chat, opts)
  },
  {
    id: 'add-dogs',
    label: () => 'Add dogs',
    // Documents are Pro; Lite never mentions or searches them.
    sub: editionFlags.documents ? 'One or several: their details, parents and papers' : 'One or several: their details and parents',
    keywords: ['new dog', 'add dog', 'add a dog', 'bought a dog', 'new female', 'new male', 'stud', 'brood', 'girl', 'boy',
      'parents', 'pedigree', 'registered name', 'registration',
      ...(editionFlags.documents ? ['papers', 'registration papers', 'health records', 'documents', 'certificate'] : [])],
    available: () => true,
    priority: () => 35,
    resumable: true,
    discard: discardGuidedDogsDraft,
    // Starting while some dogs are unfinished: finish those first, or start fresh?
    beforeStart: async () => {
      const p = pendingDogsDraft();
      if (!p) return null;
      await chat.say(`You have dogs you didn't finish adding (${esc(p.label || 'started earlier')}). Want to finish those first?`);
      const pick = await chat.choose([
        { label: 'Finish those', value: 'resume', primary: true },
        { label: 'Start fresh (throw them away)', value: 'fresh' }
      ]);
      if (pick === 'resume') return { taskId: 'resume-dogs' };
      discardGuidedDogsDraft();
      return null;
    },
    run: (opts) => runDogsTask(chat, opts)
  },
  {
    id: 'add-people',
    label: () => 'Add people',
    sub: editionFlags.waitlist ? 'Buyers, your vet, breeders and their kennels, and families for your waitlist' : 'Buyers, your vet, breeders and their kennels',
    keywords: ['add person', 'add people', 'add contact', 'contact', 'contacts', 'new buyer', 'buyer', 'vet', 'veterinarian', 'groomer',
      'co-owner', 'co owner', 'family', 'families', 'phone number', 'email', 'breeder', 'kennel', 'bred by', 'referral',
      ...(editionFlags.waitlist ? ['applicant', 'waitlist'] : [])],
    // Pro only: Lite has no Contacts pages.
    available: () => editionFlags.contactsSection,
    priority: () => 33,
    resumable: true,
    discard: clearGuidedPeopleDraft,
    // Starting while some people are unfinished: finish those first, or start fresh?
    beforeStart: async () => {
      const p = pendingPeopleDraft(getGuidedPeopleDraft());
      if (!p) return null;
      await chat.say(`You have people you didn't finish adding (${esc(p.label || 'started earlier')}). Want to finish those first?`);
      const pick = await chat.choose([
        { label: 'Finish those', value: 'resume', primary: true },
        { label: 'Start fresh (throw them away)', value: 'fresh' }
      ]);
      if (pick === 'resume') return { taskId: 'resume-people' };
      clearGuidedPeopleDraft();
      return null;
    },
    run: (opts) => runPeople(opts)
  },
  {
    id: 'tidy-up',
    label: () => 'Tidy up my records',
    sub: 'Find records that don\'t agree, and duplicates, and fix them',
    keywords: ['clean up', 'cleanup', 'fix', 'check', 'mistakes', 'errors', 'duplicate', 'duplicates', 'merge', 'combine', 'same dog', 'mismatch',
      'parents', 'sire', 'dam', 'pedigree', 'count', 'placed', 'audit',
      ...(editionFlags.contactsSection ? ['kennel', 'contact', 'breeder', 'vet', 'veterinarian'] : []), ...(editionFlags.studServices ? ['stud'] : [])],
    available: () => true,
    priority: () => 30,
    run: (opts) => runTidyTask(chat, opts)
  },
  {
    id: 'waitlist-setup',
    label: () => 'Set up my waitlist',
    sub: isWaitlistOnlineOffered() ? 'The fee, offers, going online, programs' : 'The fee, offers, programs',
    keywords: ['waitlist', 'wait list', 'applications', 'apply', 'deposit list', 'reservations', 'families', 'fee', 'application fee',
      'offers', 'picks', 'programs', ...(isWaitlistOnlineOffered() ? ['online', 'website', 'facebook', 'publish'] : [])],
    // Pro only (the waitlist); its script is Pro-only too, so it's imported on start.
    available: () => editionFlags.waitlist,
    priority: () => 25,
    run: async (opts) => (await import('../assets/waitlistSetupUI.js')).runWaitlistSetupTask(chat, opts)
  },
  {
    id: 'form-setup',
    label: () => 'Set up my application form',
    sub: editionFlags.accounts ? 'Your questions, FAQ, the fee and how families pay' : 'Your questions, FAQ and the fee',
    keywords: ['application', 'application form', 'form', 'questions', 'questionnaire', 'apply', 'waitlist form', 'faq',
      'puppy application', 'fee', 'application fee',
      ...(editionFlags.accounts ? ['payment', 'pay', 'stripe', 'payment account'] : []),
      ...(isVaultOffered() ? ['sensitive records', 'encrypted'] : [])],
    // Pro only (the waitlist); its script is Pro-only too, so it's imported on start.
    available: () => editionFlags.waitlist,
    priority: () => 24,
    resumable: true,
    discard: clearGuidedFormDraft,
    beforeStart: async () => {
      const p = pendingFormDraft(getGuidedFormDraft());
      if (!p) return null;
      await chat.say(`You have an application form you didn't finish (${esc(p.label || 'started earlier')}). Want to finish that one first?`);
      const pick = await chat.choose([
        { label: 'Finish that one', value: 'resume', primary: true },
        { label: 'Start fresh (throw it away)', value: 'fresh' }
      ]);
      if (pick === 'resume') return { taskId: 'resume-form' };
      clearGuidedFormDraft();
      return null;
    },
    run: (opts) => runForm(opts)
  },
  {
    id: 'account-health',
    label: () => 'Check account health',
    sub: isCloudAvailable() ? 'Your backups, this device, and your account' : 'Your backups and this device',
    // Only what this edition checks is searchable.
    keywords: ['backup', 'back up', 'safe', 'storage', 'space', 'health', 'status', 'update', 'export',
      ...(isCloudAvailable() ? ['cloud', 'device', 'devices', 'lost phone', 'account', 'sign in'] : []),
      ...(isLicenseGated() ? ['license', 'subscription', 'renew', 'pro'] : []),
      ...(isVaultOffered() ? ['sensitive records', 'recovery code', 'passkey', 'encrypted'] : []),
      ...(editionFlags.accounts ? ['stripe', 'jotform', 'connections', 'keys'] : [])],
    available: () => true,
    priority: () => 20,
    run: (opts) => runHealthTask(chat, opts)
  }
];

const taskById = (id) => TASKS.find((t) => t.id === id);

async function state() {
  const [litters, prep, dogs] = await Promise.all([checkinState(), prepState(), dogRepo.getAll({ includeArchived: true })]);
  return {
    pendingLitter: pendingLitterDraft(), pendingDogs: pendingDogsDraft(),
    pendingPeople: editionFlags.contactsSection ? pendingPeopleDraft(getGuidedPeopleDraft()) : null,
    pendingForm: editionFlags.waitlist ? pendingFormDraft(getGuidedFormDraft()) : null,
    litters, prep, setup: { dogs }
  };
}

let current = null;
function running(task) {
  current = task;
  laterBtn.hidden = !task?.resumable;
  cancelBtn.hidden = !task;
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
  // Each start counts toward "You use this often" (data/kelsFavorites.js); a
  // resumed draft is the same work, not a new start.
  if (!task.id.startsWith('resume-')) setKelsTaskUse(withStart(getKelsTaskUse(), task.id, todayYMD()));
  running(task);
  return task.run({ ...opts, onExit, handoff, onSaved: () => running(null) });
}

// The top: unfinished work first, then Finding Something / Doing Something /
// Understanding Something.
async function menu({ again = false } = {}) {
  const s = await state();
  const unfinished = TASKS.filter((t) => t.id.startsWith('resume-') && t.available(s));
  await chat.say(again ? 'What else can I help you with?' : kelsWelcome(), { typing: again ? 600 : 1300 });
  const pick = await chat.choose([
    ...unfinished.map((t) => ({ label: t.label(s), value: `task:${t.id}`, primary: true })),
    { label: 'Finding Something', value: 'find', primary: !unfinished.length },
    { label: 'Doing Something', value: 'do' },
    { label: 'Understanding Something', value: 'understand' }
  ], { stagger: 150 });
  if (pick.startsWith('task:')) return startTask(taskById(pick.slice(5)));
  if (pick === 'find') return runFindTask(chat, { onExit, handoff, tasks: taskCandidates(s) });
  if (pick === 'understand') return runUnderstandTask(chat, { onExit });
  return doMenu(s);
}

// Doing Something: her tasks with a search box. Unfinished work first, then the
// ones she starred, then the ones she uses often, then the state-based priority
// (data/kelsFavorites.js). Every task but a resumed draft has a ☆.
async function doMenu(s) {
  const tasks = TASKS.filter((t) => t.available(s)).map((t) => ({ id: t.id, priority: t.priority(s), unfinished: t.id.startsWith('resume-'), t }));
  const rows = orderTasks(tasks, { starred: getKelsFavorites(), uses: getKelsTaskUse(), noPromote: getKelsNoPromote() }, todayYMD());
  await chat.say('Love it! Here\'s what we can do together.', { typing: 600 });
  const id = await chat.choose(rows.map(({ task: { t, unfinished }, starred, frequent }) => ({
    label: t.label(s), sub: t.sub, keywords: t.keywords, value: t.id,
    ...(unfinished ? {} : { star: starred }),
    ...(frequent ? { note: 'You use this often', noteAction: { label: 'Don\'t move this up', run: dontPromote } } : {})
  })), { stagger: 200, search: { placeholder: 'What do you need? Try "add puppies"' }, confirmHint: 'Tap again to start', onStar: star });
  await startTask(taskById(id));
}

// The ☆: starred tasks sit at the top. Starring also undoes "Don't move this up".
function star(id, on) {
  const next = withStar({ starred: getKelsFavorites(), noPromote: getKelsNoPromote() }, id, on);
  setKelsFavorites(next.starred);
  setKelsNoPromote(next.noPromote);
}

// One she uses often, kept where its priority puts it until she stars it.
function dontPromote(id) {
  setKelsNoPromote([...new Set([...getKelsNoPromote(), id])]);
}

// Her tasks as Find candidates (data/kelsFind.js): a match offers to start it.
// A little behind a page of the same words, since she asked to find something.
function taskCandidates(s) {
  return TASKS.filter((t) => t.available(s)).map((t) => ({
    id: `task:${t.id}`, group: 'Something we can do together', title: t.label(s), sub: t.sub,
    where: 'I can do this with you right now.', taskId: t.id, boost: -0.3,
    levels: [[t.label(s), ...t.keywords], [t.sub], []]
  }));
}

// The task's open question goes away, so nothing more can be answered in it.
const dropOpenQuestion = () => chat.box.querySelectorAll('.kels-panel-row, .kels-choices-row').forEach((r) => r.remove());

laterBtn.addEventListener('click', async () => {
  // Her answers are already kept after every step; this just says so.
  dropOpenQuestion();
  chat.you('Let\'s finish this later.');
  running(null);
  await chat.say('Saved! I\'ll keep what we\'ve got until you\'re ready to continue. Just tap me any time.');
  await menu({ again: true });
});

cancelBtn.addEventListener('click', async () => {
  const task = current;
  if (!task) return;
  const ok = await confirmModal({
    title: 'Are you sure?',
    message: task.resumable
      ? 'This stops what we\'re doing and throws away the answers you\'ve given so far. Anything already saved to your records stays.'
      : 'This stops what we\'re doing. Anything already saved to your records stays.',
    confirmLabel: 'Yes, cancel', cancelLabel: 'Keep going', danger: true
  });
  // She may have finished (or put it off) while the question was open.
  if (!ok || current !== task) return;
  dropOpenQuestion();
  chat.you('Cancel this.');
  running(null);
  task.discard?.();
  await chat.say('Okay, I\'ve stopped.');
  await menu({ again: true });
});

async function main() {
  const asked = taskById(param('task'));
  if (!asked) { await menu(); return; }
  // Sent straight to a task: she still greets and asks, and the task is the answer.
  await chat.say(kelsWelcome(), { typing: 900 });
  chat.you(asked.label(await state()));
  await startTask(asked, { litterId: param('litter') || null });
}

main().catch((e) => chat.say(`Sorry, something went wrong: ${esc(e.message || String(e))}`, { typing: 0 }));
