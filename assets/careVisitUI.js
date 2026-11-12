// careVisitUI.js — Kels's care step: "What did they have?" once, then a short
// form for each kind she ticked, each already holding the date, the dogs and the
// vet. Check in on my dogs (assets/dogCheckinUI.js) and Check in on a litter's
// Health care (assets/litterCheckinUI.js) run the whole step (careVisit); Pups are
// going home's shots and deworming fixes and Log health test results' screening
// tests open one of its forms on its own. The rules and the events are in
// data/careVisit.js. Each form saves as she approves it, through the repos, so
// there's no draft.
//
// `who` words the dog lists: { line(dog) → HTML, one: 'dog', many: 'dogs' }.
import { eventRepo } from '../data/eventRepo.js';
import { expenseRepo } from '../data/expenseRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { dogEvents } from '../data/dogCare.js';
import * as C from '../data/litterCheckin.js';
import * as V from '../data/careVisit.js';
import { EVENT_TYPES, VACCINE_CHOICES, VACCINE_NEXT_DUE, SCREENING_TESTS, SCREENING_RESULTS, TEST_OUTCOME, descriptor, defaultExpenseCategoryFor } from '../data/vocab.js';
import { field, titleInput, eventFieldsHtml, eventFieldInput, relatedContactInput, wireRelatedContact, relatedContactProblem, readRelatedContact } from './litterCheckinUI.js';
import { filePicker, wireFilePicker } from './kelsSteps.js';
import { esc, fmtDate } from './ui.js';

const plural = (n, w) => `${n} ${n === 1 ? w.one : w.many}`;
const listText = (xs) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const uniq = (xs) => {
  const seen = new Set();
  return xs.map((x) => String(x ?? '').trim()).filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()));
};

// --- The dogs: ticks with All / None -------------------------------------------------

function dogChecks(prefix, dogs, ticked, who) {
  const boxes = dogs.map((d, i) => `<label class="ck-check"><input type="checkbox" id="${prefix}-dog-${i}"${ticked.has(d.id) ? ' checked' : ''}> ${who.line(d)}</label>`).join('');
  return `<p class="gl-q">Which ${esc(who.many)}?${dogs.length > 1 ? ` <button type="button" class="gl-more" data-all="${prefix}">All</button> <button type="button" class="gl-more" data-none="${prefix}">None</button>` : ''}</p>
    <div class="ck-checks" id="${prefix}-dogs">${boxes}</div>`;
}

function wireDogChecks(root, prefix) {
  const set = (on) => root.querySelectorAll(`#${prefix}-dogs input`).forEach((c) => { c.checked = on; });
  root.querySelector(`[data-all="${prefix}"]`)?.addEventListener('click', () => set(true));
  root.querySelector(`[data-none="${prefix}"]`)?.addEventListener('click', () => set(false));
}

const checkedIds = (root, prefix, dogs) => dogs.filter((d, i) => root.querySelector(`#${prefix}-dog-${i}`)?.checked).map((d) => d.id);
const forWhom = (n, total, who) => (n === total && total > 1 ? `${total === 2 ? 'both' : `all ${total}`} ${who.many}` : plural(n, who));

// --- The whole step ---------------------------------------------------------------------

// "What did they have?" → the visit saved → each other ticked kind's form.
// `ticked`: the dogs ticked to start with. `docType` (Documents, Pro): the visit
// takes the vet's summary, filed on each dog. `pups`: a litter's puppies (shots
// start due in 3 weeks). → { done, kinds, count } where `kinds` are the
// CARE_STEPS keys saved.
export async function careVisit(chat, { dogs, ticked = new Set(), today, who, docType = null, pups = false }) {
  const first = await stepsForm(chat, dogs, ticked, today, who, docType);
  if (!first.done) return { done: false, kinds: [], count: 0 };
  const r = first.result;
  const saved = r.steps.includes('visit') ? ['visit'] : [];
  if (saved.length) await chat.say(`Saved the visit.${r.filed ? ' The vet summary is filed on each page.' : ''}`);
  const next = { date: r.date, ticked: new Set(r.dogIds), vetId: r.vetId, who, pups };
  for (const step of V.followUps(r.steps)) {
    let res;
    if (step === 'shots') res = await vaccineForm(chat, dogs, next);
    else if (step === 'screening') res = await screeningForm(chat, dogs, next);
    else res = await careForm(chat, V.CARE_STEPS.find((s) => s.key === step).kind, dogs, r.date, next);
    if (res.done) {
      saved.push(step);
      await chat.say('Saved.');
    }
  }
  return { done: true, kinds: saved, count: r.dogIds.length };
}

async function stepsForm(chat, dogs, ticked, today, who, docType) {
  const visit = descriptor(EVENT_TYPES, 'vet_visit');
  const fields = Object.fromEntries((visit.fields || []).map((f) => [f.key, f]));
  const contacts = await contactRepo.getAll({ includeArchived: false });
  let pickedDoc = () => null;
  const hint = 'A PDF, or photos of the pages. Filed on each page under Documents.';
  const steps = V.CARE_STEPS.map((s) => `<label class="ck-check"><input type="checkbox" data-step="${s.key}"> <span><strong>${esc(s.label)}</strong><br><span class="faint">${esc(s.sub)}</span></span></label>`).join('');
  return chat.form({
    title: `<strong>What did they have?</strong><span class="kels-lead">Tick everything. I'll save the visit here, then ask about each of the rest with the date and the ${esc(who.many)} already filled in.</span>`,
    html: `<div class="ck-checks">${steps}</div>
      ${field('Date', `<input id="cv-date" type="date" value="${esc(today)}">`)}
      ${dogChecks('cv', dogs, ticked, who)}
      <div id="cv-vet" hidden>${relatedContactInput(visit, contacts)}</div>
      <div id="cv-visit" hidden>
        ${titleInput('cv-title', visit, 'reason')}
        ${eventFieldInput(fields.reason, true)}
        ${eventFieldInput(fields.findings)}
        ${field(`Cost per ${who.one} (optional)`, '<input id="cv-cost" type="number" min="0" step="0.01" inputmode="decimal">', 'The visit\'s cost, logged to Financials against each one.')}
        ${docType ? filePicker('cv-doc', { label: 'Vet summary (optional)', hint }) : ''}
      </div>`,
    wire: (root) => {
      wireRelatedContact(root);
      wireDogChecks(root, 'cv');
      const show = () => {
        const on = (k) => root.querySelector(`[data-step="${k}"]`).checked;
        root.querySelector('#cv-visit').hidden = !on('visit');
        root.querySelector('#cv-vet').hidden = !on('visit') && !on('screening');
      };
      root.querySelectorAll('[data-step]').forEach((c) => c.addEventListener('change', show));
      if (docType) pickedDoc = wireFilePicker(root, 'cv-doc', { hint });
    },
    submitLabel: 'Next',
    cancelLabel: 'Not now',
    submit: async (root) => {
      const form = {
        steps: [...root.querySelectorAll('[data-step]')].filter((c) => c.checked).map((c) => c.dataset.step),
        dogIds: checkedIds(root, 'cv', dogs),
        date: root.querySelector('#cv-date').value,
        cost: root.querySelector('#cv-cost').value
      };
      const wantsVet = form.steps.includes('visit') || form.steps.includes('screening');
      const problem = V.careStepsProblem(form) || (wantsVet ? relatedContactProblem(root, visit) : '');
      if (problem) return problem;
      const vetId = wantsVet ? await readRelatedContact(root, visit) : null;
      let filed = false;
      if (form.steps.includes('visit')) {
        const events = dogEvents({
          eventType: 'vet_visit', dogIds: form.dogIds, date: form.date, relatedContactId: vetId, title: root.querySelector('#cv-title').value,
          details: { reason: root.querySelector('#ck-f-reason').value, findings: root.querySelector('#ck-f-findings').value }
        });
        const amount = String(form.cost).trim() === '' ? null : Number(form.cost);
        for (const e of events) {
          const saved = await eventRepo.create(e);
          if (amount != null) await expenseRepo.createForEvent(saved, { amount, category: defaultExpenseCategoryFor('vet_visit') });
        }
        const doc = docType ? pickedDoc() : null;
        if (doc) {
          const vet = vetId ? (await contactRepo.getById(vetId))?.name || '' : '';
          const { storeDocumentFile, createDocument } = await import('./documentModal.js');
          for (const e of events) {
            const fileId = await storeDocumentFile(doc, { title: e.title });
            await createDocument({ dog_id: e.subject_id, doc_type: docType, title: e.title, doc_date: e.event_date, issuer_or_lab: vet, notes: '', file_id: fileId });
          }
          filed = true;
        }
      }
      return { ...form, vetId, filed };
    },
    reply: (r) => `${listText(r.steps.map((k, i) => {
      const label = V.CARE_STEPS.find((s) => s.key === k).label;
      return i ? label.charAt(0).toLowerCase() + label.slice(1) : label;
    }))} for ${forWhom(r.dogIds.length, dogs.length, who)}, ${fmtDate(r.date)}${r.filed ? ' 📎' : ''}`
  });
}

// --- Shots ----------------------------------------------------------------------------------

// The shot list as ticks, each with when it's next due, and an Other. One
// `vaccination` per ticked shot per ticked dog (careVisit.vaccineEvents).
// `pups`: the next-due choice starts at 3 weeks (a puppy series), rabies at a
// year; for grown dogs every one starts at a year. → { done, result: { count, date, shots } }.
export async function vaccineForm(chat, dogs, { date, ticked = new Set(), who, pups = false }) {
  const typed = await eventRepo.getDetailValues('vaccination', 'vaccine').catch(() => []);
  const choices = uniq([...VACCINE_CHOICES]);
  const known = new Set(choices.map((v) => v.toLowerCase()));
  const datalist = uniq(typed).filter((v) => !known.has(v.toLowerCase()));
  const startDue = (v) => (pups && v !== 'Rabies' ? '3w' : '1y');
  const dueSelect = (id, label, pick) => `<select id="${id}" aria-label="${esc(label)}: next due"><option value="">Not due again</option>${VACCINE_NEXT_DUE.map((o) => `<option value="${o.value}"${o.value === pick ? ' selected' : ''}>Due ${esc(o.label.toLowerCase())}</option>`).join('')}</select>`;
  const vaxType = descriptor(EVENT_TYPES, 'vaccination');
  // A ticked shot opens its own title (blank takes the vaccine), as Kels's other logging forms.
  const rows = choices.map((v, i) => `<div class="ck-inline">
      <label class="ck-check"><input type="checkbox" id="cv-vx-${i}" data-vx="${i}"> <strong>${esc(v)}</strong></label>
      <div class="field gl-field">${dueSelect(`cv-vx-due-${i}`, v, startDue(v))}</div>
    </div>
    <div id="cv-vx-tw-${i}" hidden>${titleInput(`cv-vx-title-${i}`, vaxType, 'vaccine')}</div>`).join('');
  return chat.form({
    title: `<strong>Which shots?</strong><span class="kels-lead">Tick each one they got. I'll log every ticked shot for every ticked ${esc(who.one)}.</span>`,
    html: `${rows}
      <div class="ck-inline">
        ${field('Other shot (optional)', `<input id="cv-vx-other" type="text" autocomplete="off" list="cv-vx-dl" placeholder="e.g. Coronavirus"><datalist id="cv-vx-dl">${datalist.map((v) => `<option value="${esc(v)}"></option>`).join('')}</datalist>`)}
        ${field('Its next due', dueSelect('cv-vx-other-due', 'Other shot', pups ? '3w' : '1y'))}
      </div>
      <div id="cv-vx-tw-other" hidden>${titleInput('cv-vx-title-other', vaxType, 'vaccine')}</div>
      <div class="ck-inline">
        ${field('Date given', `<input id="cv-vx-date" type="date" value="${esc(date)}">`)}
        ${field('Lot # (optional)', '<input id="cv-vx-lot" type="text" autocomplete="off">')}
      </div>
      <label class="ck-check"><input type="checkbox" id="cv-vx-remind" checked> Remind me on Today when they're due</label>
      ${dogChecks('cv-vx', dogs, ticked, who)}`,
    wire: (root) => {
      wireDogChecks(root, 'cv-vx');
      const titleFollows = (i) => { root.querySelector(`#cv-vx-tw-${i}`).hidden = !root.querySelector(`#cv-vx-${i}`).checked; };
      choices.forEach((v, i) => {
        root.querySelector(`#cv-vx-${i}`).addEventListener('change', () => titleFollows(i));
        // Picking a next-due ticks its shot.
        root.querySelector(`#cv-vx-due-${i}`).addEventListener('change', () => { root.querySelector(`#cv-vx-${i}`).checked = true; titleFollows(i); });
      });
      const other = root.querySelector('#cv-vx-other');
      other.addEventListener('input', () => { root.querySelector('#cv-vx-tw-other').hidden = !other.value.trim(); });
    },
    submitLabel: 'Log shots',
    cancelLabel: 'Skip',
    submit: async (root) => {
      const rows = choices.map((v, i) => ({ vaccine: v, nextDue: root.querySelector(`#cv-vx-due-${i}`).value, title: root.querySelector(`#cv-vx-title-${i}`).value, on: root.querySelector(`#cv-vx-${i}`).checked }))
        .filter((r) => r.on);
      const other = root.querySelector('#cv-vx-other').value.trim();
      if (other) rows.push({ vaccine: other, nextDue: root.querySelector('#cv-vx-other-due').value, title: root.querySelector('#cv-vx-title-other').value });
      const form = { rows, dogIds: checkedIds(root, 'cv-vx', dogs), date: root.querySelector('#cv-vx-date').value, lot: root.querySelector('#cv-vx-lot').value, remind: root.querySelector('#cv-vx-remind').checked };
      const problem = V.vaccineProblem(form);
      if (problem) return problem;
      for (const e of V.vaccineEvents(form)) await eventRepo.create(e);
      return { count: form.dogIds.length, date: form.date, shots: rows.map((r) => r.title.trim() || r.vaccine) };
    },
    reply: (r) => `${listText(r.shots)} for ${forWhom(r.count, dogs.length, who)}, ${fmtDate(r.date)}`
  });
}

// --- Screening tests ---------------------------------------------------------------------------

// The screening tests as ticks (SCREENING_TESTS, then any she's typed before),
// and an Other. Each ticked test opens its result for every ticked dog, and
// **Different for each** opens a row per dog, whose own result wins. One
// `screening_test` per test per dog (careVisit.screeningEvents), the vet linked.
// → { done, result: { count, date, tests } }.
export async function screeningForm(chat, dogs, { date, ticked = new Set(), vetId = null, who }) {
  const type = descriptor(EVENT_TYPES, 'screening_test');
  const [contacts, typedTests, typedResults] = await Promise.all([
    contactRepo.getAll({ includeArchived: false }),
    eventRepo.getDetailValues('screening_test', 'test').catch(() => []),
    eventRepo.getDetailValues('screening_test', 'result').catch(() => [])
  ]);
  const tests = uniq([...SCREENING_TESTS, ...typedTests]);
  const results = uniq([...SCREENING_RESULTS, ...typedResults]);
  const outcome = (id, label) => `<select id="${id}" aria-label="${esc(label)}"><option value="">Not marked</option>${TEST_OUTCOME.map((o) => `<option>${esc(o)}</option>`).join('')}</select>`;
  const resultIn = (id, label) => `<input id="${id}" type="text" list="cv-sc-results" autocomplete="off" placeholder="e.g. Negative" aria-label="${esc(label)}">`;
  const body = (i, name) => `<div id="cv-sc-body-${i}" hidden>
      ${titleInput(`cv-sc-title-${i}`, type, 'test')}
      <div class="ck-inline">
        ${field(dogs.length > 1 ? 'Result for all' : 'Result', resultIn(`cv-sc-res-${i}`, `${name}: result`))}
        ${field('Normal or abnormal', outcome(`cv-sc-out-${i}`, `${name}: normal or abnormal`))}
      </div>
      ${dogs.length > 1 ? `<button type="button" class="gl-more" data-each="${i}">Different for each ${esc(who.one)}</button>
      <div id="cv-sc-each-${i}" hidden>${dogs.map((d, j) => `<div data-dogrow="${j}"${ticked.has(d.id) ? '' : ' hidden'}><p class="gl-q">${who.line(d)}</p><div class="ck-inline">
          ${field('Result', resultIn(`cv-sc-res-${i}-${j}`, `${name}: result`))}
          ${field('Normal or abnormal', outcome(`cv-sc-out-${i}-${j}`, `${name}: normal or abnormal`))}
        </div></div>`).join('')}<span class="field-hint">Leave a ${esc(who.one)} blank to use the result for all.</span></div>` : ''}
    </div>`;
  const rows = tests.map((t, i) => `<div class="gl-extra-row">
      <label class="ck-check"><input type="checkbox" id="cv-sc-${i}" data-sc="${i}"> <strong>${esc(t)}</strong></label>
      ${body(i, t)}
    </div>`).join('');
  const o = tests.length;
  return chat.form({
    title: `<strong>Which screening tests?</strong><span class="kels-lead">Tick each test and type its result. If one came back different, open <em>Different for each</em>.</span>`,
    html: `<datalist id="cv-sc-results">${results.map((r) => `<option value="${esc(r)}"></option>`).join('')}</datalist>
      ${rows}
      <div class="gl-extra-row">
        <label class="ck-check"><input type="checkbox" id="cv-sc-${o}" data-sc="${o}"> <strong>Another test</strong></label>
        <div id="cv-sc-name-${o}" hidden>${field('Test', '<input id="cv-sc-other" type="text" autocomplete="off" placeholder="e.g. Thyroid panel">')}</div>
        ${body(o, 'Another test')}
      </div>
      ${field('Date', `<input id="cv-sc-date" type="date" value="${esc(date)}">`)}
      ${relatedContactInput(type, contacts, vetId)}
      ${dogChecks('cv-sc', dogs, ticked, who)}`,
    wire: (root) => {
      wireRelatedContact(root);
      wireDogChecks(root, 'cv-sc');
      // Each test's per-dog rows follow the ticked dogs.
      const rowsFollow = () => dogs.forEach((d, j) => {
        const on = root.querySelector(`#cv-sc-dog-${j}`).checked;
        root.querySelectorAll(`[data-dogrow="${j}"]`).forEach((r) => { r.hidden = !on; });
      });
      root.querySelector('#cv-sc-dogs').addEventListener('change', rowsFollow);
      root.querySelectorAll('[data-all="cv-sc"], [data-none="cv-sc"]').forEach((b) => b.addEventListener('click', rowsFollow));
      root.querySelectorAll('[data-sc]').forEach((c) => c.addEventListener('change', () => {
        const i = c.dataset.sc;
        root.querySelector(`#cv-sc-body-${i}`).hidden = !c.checked;
        const name = root.querySelector(`#cv-sc-name-${i}`);
        if (name) name.hidden = !c.checked;
      }));
      root.querySelectorAll('[data-each]').forEach((b) => b.addEventListener('click', () => {
        const box = root.querySelector(`#cv-sc-each-${b.dataset.each}`);
        box.hidden = !box.hidden;
      }));
    },
    submitLabel: 'Log tests',
    cancelLabel: 'Skip',
    submit: async (root) => {
      const names = [...tests, null];
      const picked = names.map((t, i) => ({ t, i })).filter(({ i }) => root.querySelector(`#cv-sc-${i}`).checked).map(({ t, i }) => ({
        test: t ?? root.querySelector('#cv-sc-other').value.trim(),
        title: root.querySelector(`#cv-sc-title-${i}`).value,
        result: root.querySelector(`#cv-sc-res-${i}`).value,
        outcome: root.querySelector(`#cv-sc-out-${i}`).value,
        perDog: dogs.length > 1 ? Object.fromEntries(dogs.map((d, j) => [d.id, {
          result: root.querySelector(`#cv-sc-res-${i}-${j}`).value,
          outcome: root.querySelector(`#cv-sc-out-${i}-${j}`).value
        }])) : {}
      }));
      const form = { tests: picked, dogIds: checkedIds(root, 'cv-sc', dogs), date: root.querySelector('#cv-sc-date').value };
      const problem = V.screeningProblem(form) || relatedContactProblem(root, type);
      if (problem) return problem;
      const relatedContactId = await readRelatedContact(root, type);
      for (const e of V.screeningEvents({ ...form, relatedContactId })) await eventRepo.create(e);
      return { count: form.dogIds.length, date: form.date, tests: picked.map((t) => t.title.trim() || t.test) };
    },
    reply: (r) => `${listText(r.tests)} for ${forWhom(r.count, dogs.length, who)}, ${fmtDate(r.date)}`
  });
}

// --- A preventative or a medication ----------------------------------------------------------

// One care kind (litterCheckin.CARE_KINDS) for the ticked dogs: the type's fields,
// a date (a medication's last dose too), one event each. → { done, result: { count, title, date } }.
export async function careForm(chat, kind, dogs, today, { date = today, ticked = new Set(dogs.map((d) => d.id)), who }) {
  const k = C.CARE_KINDS[kind];
  const type = descriptor(EVENT_TYPES, k.eventType);
  const span = type.duration === 'span';
  const contacts = type.relatedContact ? await contactRepo.getAll({ includeArchived: false }) : [];
  return chat.form({
    title: `<strong>${esc(k.ask)}</strong>`,
    html: `${titleInput('ck-title', type, k.nameKey)}
      ${eventFieldsHtml(type, contacts, k.nameKey)}
      <div class="ck-inline">
        ${field(span ? 'Started' : 'Date', `<input id="ck-date" type="date" value="${esc(date)}">`)}
        ${span ? field('Last dose (optional)', '<input id="ck-end" type="date">') : ''}
      </div>
      ${dogChecks('ck', dogs, ticked, who)}`,
    wire: (root) => {
      wireRelatedContact(root);
      wireDogChecks(root, 'ck');
    },
    submitLabel: 'Save',
    cancelLabel: 'Skip',
    submit: async (root) => {
      const ids = checkedIds(root, 'ck', dogs);
      const details = {};
      for (const f of type.fields || []) details[f.key] = root.querySelector(`#ck-f-${f.key}`)?.value ?? '';
      const form = { date: root.querySelector('#ck-date').value, endDate: root.querySelector('#ck-end')?.value || '', title: root.querySelector('#ck-title').value, details };
      const problem = C.careProblem(kind, ids, form) || relatedContactProblem(root, type);
      if (problem) return problem.replace('puppy', who.one);
      form.relatedContactId = await readRelatedContact(root, type);
      const events = C.careEvents(kind, ids, form);
      for (const e of events) await eventRepo.create(e);
      return { count: ids.length, title: events[0].title, date: form.date };
    },
    reply: (r) => `${r.title} for ${forWhom(r.count, dogs.length, who)}`
  });
}
