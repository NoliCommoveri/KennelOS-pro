// healthTestsUI.js — Kels's "Log health test results": completed tests (OFA,
// genetic panels, breed tests), dog by dog, as a chat on pages/kels.html
// (assets/kelsChat.js draws it).
//
// Pick a dog (her dogs at home and any dog with planned tests still unlogged
// first; Another dog finds the rest), then one of that dog's unlogged planned
// tests or any other test, then a short form: the test, its kind (guessed from
// the name, or the kind she used for it before), the date, the result or
// rating, and the lab for a genetic test. Each result is saved as she approves
// it, through eventRepo (data/healthTestLog.js builds it), so there's no draft.
// With Documents (Pro), the form also takes the certificate or report (a PDF or
// photos, kelsSteps.filePicker), filed on the dog as a Health test document with
// the test's name, date, lab and result.
// The test's name lands in its kind's name field, so a planned test reads as
// logged everywhere at once (Dog page, Health-Testing Gaps).
import { dogRepo } from '../data/dogRepo.js';
import { eventRepo, testTokensOf, testMatchTokensOf } from '../data/eventRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { dogsInScope } from '../data/kennelScope.js';
import { homeDogs } from '../data/dogCare.js';
import { TEST_TYPES, TEST_TYPE_FIELDS, testTypeFor, testEvent, unloggedPlanned, testResultSuggestions } from '../data/healthTestLog.js';
import { EVENT_TYPES, TEST_OUTCOME, descriptor } from '../data/vocab.js';
import { field } from './litterCheckinUI.js';
import { filePicker, wireFilePicker } from './kelsSteps.js';
import { editionFlags } from '../data/editionConfig.js';
import { esc, fmtDate, todayYMD } from './ui.js';

const HOW = 'Pick a dog, then a test from their plan or any other, and I\'ll log each result as you go. Sound good?';
const dogName = (d) => d.call_name || d.registered_name || 'Unnamed';
const listText = (xs) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const typeLabel = (t) => descriptor(EVENT_TYPES, t)?.label || t;

// `only`: a narrower list of dogs (the dog check-in passes dogCare.checkinDogs).
async function load(only = null) {
  const [dogs, tests] = await Promise.all([dogRepo.getAll(), Promise.all(TEST_TYPES.map((t) => eventRepo.getByType(t))).then((x) => x.flat())]);
  // Dogs she'd test: hers, not pedigree-only, not deceased.
  const eligible = dogsInScope(dogs).filter((d) => !d.is_archived && !d.pedigree_only && d.status !== 'deceased');
  return { dogs: only ? only(eligible) : eligible, tests };
}

// For Kels's menu: dogs to test, and how many planned tests are still unlogged.
export async function healthTestsState({ only = null } = {}) {
  const { dogs, tests } = await load(only);
  return { dogs: dogs.length, missing: dogs.reduce((n, d) => n + unloggedPlanned(d, tests, testMatchTokensOf).length, 0) };
}

export async function runHealthTestsTask(chat, { onExit = () => {} } = {}) {
  if (!(await chat.intro('Of course, let\'s get those test results logged!', HOW))) return onExit('nevermind');
  let { dogs } = await load();
  if (!dogs.length) {
    await chat.say('You don\'t have any dogs to log tests for yet. Add a dog first and I\'ll help with their results.');
    return onExit('done');
  }
  await logHealthTests(chat);
  await chat.say('All logged. Those clearances are hard-won, nice work!');
  return onExit('done');
}

// The task's loop, also the dog check-in's "Do you need to log any new health test
// results?" (assets/dogCheckinUI.js, which passes `only`: her own dogs and kept
// puppies): pick a dog (those with planned tests waiting named first), log its
// results, "Results for another dog?", until she's done.
// → how many dogs she logged for.
export async function logHealthTests(chat, { only = null } = {}) {
  let n = 0;
  for (let first = true; ; first = false) {
    const dog = await pickDog(chat, first, only);
    if (!dog) return n;
    n++;
    await logForDog(chat, dog);
    await chat.say('Results for another dog?');
  }
}

// Her dogs at home and any with planned tests left, those with tests left first;
// Another dog searches the rest.
async function pickDog(chat, first, only = null) {
  const { dogs, tests } = await load(only);
  const left = new Map(dogs.map((d) => [d.id, unloggedPlanned(d, tests, testMatchTokensOf)]));
  const home = new Set(homeDogs(dogs).map((d) => d.id));
  const byName = (a, b) => dogName(a).localeCompare(dogName(b));
  const shown = dogs.filter((d) => home.has(d.id) || left.get(d.id).length)
    .sort((a, b) => (left.get(b.id).length ? 1 : 0) - (left.get(a.id).length ? 1 : 0) || byName(a, b));
  const rest = dogs.filter((d) => !shown.includes(d)).sort(byName);
  const note = (d) => (left.get(d.id).length ? `${left.get(d.id).length} planned to log` : '');
  if (first) {
    const waiting = shown.filter((d) => left.get(d.id).length);
    await chat.say(waiting.length
      ? `${waiting.length === 1 ? 'This dog has' : 'These dogs have'} planned tests with no result yet: ${esc(listText(waiting.map(dogName)))}. Whose results do you have?`
      : 'Whose results do you have?');
  }
  const pick = await chat.choose([
    ...shown.map((d) => ({ label: dogName(d), value: d.id, note: note(d) })),
    ...(rest.length ? [{ label: 'Another dog', value: '__other' }] : []),
    { label: first ? 'Never mind' : 'No, that\'s all', value: '__done', primary: !first }
  ], { search: shown.length > 8 ? { placeholder: 'Find a dog' } : null });
  if (pick === '__done') return null;
  if (pick !== '__other') return dogs.find((d) => d.id === pick);
  await chat.say('Which dog?');
  const other = await chat.choose([
    ...rest.map((d) => ({ label: dogName(d), value: d.id, note: note(d) })),
    { label: 'Never mind', value: '__done' }
  ], { search: { placeholder: 'Find a dog' } });
  return other === '__done' ? null : dogs.find((d) => d.id === other);
}

// One dog: its unlogged planned tests or any other test, one form each, until done.
async function logForDog(chat, dog) {
  for (let firstTest = true; ; firstTest = false) {
    const { tests } = await load();
    const planned = unloggedPlanned(dog, tests, testMatchTokensOf);
    if (firstTest) {
      await chat.say(planned.length
        ? `${esc(dogName(dog))}'s plan still needs: ${esc(listText(planned))}. Which result do you have?`
        : `${esc(dogName(dog))} has no planned tests waiting for a result. Which test do you want to log?`);
    } else {
      await chat.say(planned.length ? `Another result for ${esc(dogName(dog))}? Still planned: ${esc(listText(planned))}.` : `Another result for ${esc(dogName(dog))}?`);
    }
    const pick = await chat.choose([
      ...planned.map((t) => ({ label: t, value: `plan:${t}` })),
      { label: planned.length ? 'A different test' : 'Log a test', value: '__new' },
      { label: `Done with ${dogName(dog)}`, value: '__done', primary: !firstTest || !planned.length }
    ]);
    if (pick === '__done') return;
    const name = pick.startsWith('plan:') ? pick.slice(5) : '';
    const res = await testForm(chat, dog, name, tests);
    if (!res.done) continue;
    const stillLeft = unloggedPlanned(dog, (await load()).tests, testMatchTokensOf);
    const filed = res.result.filed ? ` The certificate is filed on ${esc(dogName(dog))}'s page.` : '';
    await chat.say(res.result.planned
      ? `Logged, and ticked off ${esc(dogName(dog))}'s plan.${stillLeft.length ? '' : ' Every planned test has a result now!'}${filed}`
      : `Logged.${filed}`);
  }
}

async function testForm(chat, dog, name, tests) {
  const vocab = [...new Set([...(await kennelRepo.getVocabulary()), ...(await eventRepo.getTestTokens())])].sort((a, b) => a.localeCompare(b));
  const type = testTypeFor(name || '', tests, testTokensOf);
  const results = testResultSuggestions(await eventRepo.getTestResultValues());
  const plannedKeys = new Set((dog.planned_tests || []).map((t) => String(t).trim().toLowerCase()));
  const docs = editionFlags.documents;
  let pickedDoc = () => null;
  return chat.form({
    title: `<strong>${esc(dogName(dog))}: ${name ? esc(name) : 'which test?'}</strong>`,
    html: `${field('Test', `<input id="ht-name" type="text" list="ht-dl" autocomplete="off" value="${esc(name)}" placeholder="e.g. OFA Hips, Embark panel, CAER eye exam"><datalist id="ht-dl">${vocab.map((t) => `<option value="${esc(t)}"></option>`).join('')}</datalist>`)}
      <div class="ck-inline">
        ${field('Kind', `<select id="ht-type">${TEST_TYPES.map((t) => `<option value="${t}"${t === type ? ' selected' : ''}>${esc(typeLabel(t))}</option>`).join('')}</select>`)}
        ${field('Date', `<input id="ht-date" type="date" value="${esc(todayYMD())}">`)}
      </div>
      ${field('Result', `<input id="ht-result" type="text" list="ht-results" autocomplete="off" placeholder="e.g. Good, Clear, Grade 2, N/N"><datalist id="ht-results">${results.map((r) => `<option value="${esc(r)}"></option>`).join('')}</datalist>`, 'Optional. For OFA, its rating.')}
      ${field('Normal or abnormal', `<select id="ht-outcome"><option value="">Not marked</option>${TEST_OUTCOME.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select>`, 'Optional. Your online waitlist can show only the results marked Normal.')}
      <div id="ht-lab-wrap">${field('Lab (optional)', '<input id="ht-lab" type="text" autocomplete="off" placeholder="e.g. Embark, Paw Print Genetics">')}</div>
      ${docs ? filePicker('ht-doc', { label: 'Certificate or report (optional)', hint: 'A PDF, or photos of the pages. Filed on their page under Documents.' }) : ''}`,
    submitLabel: 'Log result',
    cancelLabel: 'Not now',
    wire: (root) => {
      const typeSel = root.querySelector('#ht-type');
      const nameIn = root.querySelector('#ht-name');
      const labWrap = root.querySelector('#ht-lab-wrap');
      const showLab = () => { labWrap.hidden = !TEST_TYPE_FIELDS[typeSel.value].lab; };
      // Typing a test she hasn't picked a kind for moves the kind with it.
      let picked = false;
      typeSel.addEventListener('change', () => { picked = true; showLab(); });
      nameIn.addEventListener('change', () => {
        if (!picked) typeSel.value = testTypeFor(nameIn.value, tests, testTokensOf);
        showLab();
      });
      showLab();
      if (docs) pickedDoc = wireFilePicker(root, 'ht-doc', { hint: 'A PDF, or photos of the pages. Filed on their page under Documents.' });
      if (!name) nameIn.focus();
    },
    submit: async (root) => {
      const n = root.querySelector('#ht-name').value.trim();
      const t = root.querySelector('#ht-type').value;
      const date = root.querySelector('#ht-date').value;
      if (!n) return 'Which test was it?';
      if (!date) return 'What day was it done (or the result dated)?';
      const result = root.querySelector('#ht-result').value.trim();
      const lab = TEST_TYPE_FIELDS[t].lab ? root.querySelector('#ht-lab').value.trim() : '';
      await eventRepo.create(testEvent({ dogId: dog.id, name: n, type: t, date, result, lab, outcome: root.querySelector('#ht-outcome').value }));
      const doc = pickedDoc();
      if (doc) {
        const { storeDocumentFile, createDocument } = await import('./documentModal.js');
        const fileId = await storeDocumentFile(doc, { title: n });
        await createDocument({ dog_id: dog.id, doc_type: 'health_test', title: n, doc_date: date, issuer_or_lab: lab, result, notes: '', file_id: fileId });
      }
      return { name: n, date, result, filed: Boolean(doc), planned: plannedKeys.has(n.toLowerCase()) };
    },
    reply: (r) => `${r.name}${r.result ? `: ${r.result}` : ''}, ${fmtDate(r.date)}${r.filed ? ' 📎' : ''}`
  });
}
