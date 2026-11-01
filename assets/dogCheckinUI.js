// dogCheckinUI.js — Kels's "Check in on my dogs": the breeding dogs' routine
// care, as a chat on pages/kels.html (assets/kelsChat.js draws it).
//
// Every step looks only at her own dogs (owned or co-owned), never archived or
// deceased (dogCare.ownDogs). First the heats: each active breeding female's predicted next heat
// (data/dogCare.js: 6 months after a single heat, else her average interval),
// and whether she wants to log any, future dates included (a heat she knows is
// coming), one female at a time. Then the month's preventatives: the active
// breeding dogs with no preventative (deworming, heartworm, flea & tick) dated
// this month, one form per product, repeated until she says that's all. Then
// "Do you need to log any new health test results?" (the Log health test results
// task's own loop, assets/healthTestsUI.js). Then "Any vet visits to log?", each
// with its vet summary filed on the dog (Documents, Pro). Last, "Any other events
// to log?": a medication, an illness, a weight, any dog event type no other step or task
// logs (data/dogCare.js otherEventTypes), for the dogs she ticks (both last steps
// list only her own dogs and the puppies she's keeping: checkinDogs), one form per
// event, with an optional cost per dog. Each thing is saved as soon as she
// approves it, through the repos, so there's no draft.
import { dogRepo } from '../data/dogRepo.js';
import { eventRepo } from '../data/eventRepo.js';
import { dogsInScope } from '../data/kennelScope.js';
import { expenseRepo } from '../data/expenseRepo.js';
import { editionFlags } from '../data/editionConfig.js';
import { breedingDogs, ownDogs, heatStarts, predictNextHeat, heatForecast, preventativeGaps, monthName, otherEventTypes, dogEvents, dogEventProblem, eventNameKey, checkinDogs } from '../data/dogCare.js';
import { daysBetween } from '../data/litterCheckin.js';
import { field, eventFieldInput } from './litterCheckinUI.js';
import { filePicker, wireFilePicker } from './kelsSteps.js';
import { logHealthTests, healthTestsState } from './healthTestsUI.js';
import { DOG_STATUS, EVENT_TYPES, descriptor, defaultExpenseCategoryFor } from '../data/vocab.js';
import { esc, fmtDate, todayYMD } from './ui.js';

const HOW = 'I\'ll show you when each of your girls is expected to come into heat and help you log any you know about, then we\'ll log this month\'s preventatives (heartworm, flea & tick, dewormer), any new health test results, any vet visits, and anything else that happened. Sound good?';
const dogName = (d) => d.call_name || d.registered_name || 'Unnamed';
const listText = (xs) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

// Only her own dogs, never archived or deceased (dogCare.ownDogs): every step reads these.
async function load() {
  const [dogs, events] = await Promise.all([dogRepo.getAll(), eventRepo.getAll()]);
  return { dogs: ownDogs(dogsInScope(dogs)), events };
}

// For Kels's menu: breeding dogs, heats coming or late, dogs missing this month's preventative.
export async function dogCheckinState() {
  const today = todayYMD();
  const { dogs, events } = await load();
  return {
    breeding: breedingDogs(dogs).length,
    heatsDue: heatForecast(dogs, events, today).filter((h) => h.state !== 'later').length,
    missing: preventativeGaps(dogs, events, today).length
  };
}

export async function runDogCheckinTask(chat, { onExit = () => {} } = {}) {
  if (!(await chat.intro('Of course, let\'s check in on your dogs!', HOW))) return onExit('nevermind');
  const today = todayYMD();
  const { dogs } = await load();
  if (!breedingDogs(dogs).length) {
    await chat.say('You don\'t have any dogs marked Active breeding yet, so there\'s nothing to check. Set a dog\'s status to Active breeding on their page and I\'ll keep track of them here.');
    return onExit('done');
  }
  await heats(chat, today);
  await preventatives(chat, today);
  await healthTests(chat);
  await vetVisits(chat, today);
  await otherEvents(chat, today);
  await chat.say('That\'s everything for your dogs today. Nice work!');
  return onExit('done');
}

// "around Nov 20, in 12 days" / "expected Oct 1, 30 days ago".
function whenText(p, today) {
  const until = daysBetween(today, p.next);
  if (until < 0) return `was expected around ${esc(fmtDate(p.next))}, ${-until} day${until === -1 ? '' : 's'} ago`;
  if (until === 0) return 'is expected <strong>today</strong>';
  return `is expected around ${esc(fmtDate(p.next))}, in ${until} day${until === 1 ? '' : 's'}`;
}

// --- 1. Heats -----------------------------------------------------------------------

async function heats(chat, today) {
  let { dogs, events } = await load();
  const females = breedingDogs(dogs, 'female').sort((a, b) => dogName(a).localeCompare(dogName(b)));
  if (!females.length) {
    await chat.say('You don\'t have any active breeding females, so no heats to look at.');
    return;
  }
  const lines = females.map((d) => {
    const p = predictNextHeat(heatStarts(d.id, events));
    return p
      ? `<strong>${esc(dogName(d))}</strong> ${whenText(p, today)} <span class="faint">(${p.basis === 'one' ? '6 months after her only heat on record' : `her average of ${p.avgDays} days`})</span>`
      : `<strong>${esc(dogName(d))}</strong>: no heats logged yet`;
  });
  await chat.say(`Here's when your girls are next expected to come into heat:<br>${lines.join('<br>')}`, { typing: 900 });

  let first = true;
  for (;;) {
    await chat.say(first ? 'Do you want to log any heats? Future dates are fine if you know one\'s coming.' : 'Any other heats to log?');
    const doneLabel = first ? 'No thanks' : 'No, that\'s all';
    first = false;
    ({ dogs, events } = await load());
    const choices = breedingDogs(dogs, 'female').sort((a, b) => dogName(a).localeCompare(dogName(b))).map((d) => {
      const p = predictNextHeat(heatStarts(d.id, events));
      return { label: dogName(d), value: d.id, note: p ? `Next: ${fmtDate(p.next)}` : 'No heats yet' };
    });
    const pick = await chat.choose([...choices, { label: doneLabel, value: '__done', primary: true }]);
    if (pick === '__done') return;
    const dog = dogs.find((d) => d.id === pick);
    const p = predictNextHeat(heatStarts(dog.id, events));
    const res = await chat.form({
      title: `<strong>${esc(dogName(dog))}'s heat</strong>`,
      html: `<div class="ck-inline">
          ${field('Started', `<input id="dc-start" type="date" value="${esc(p && p.next > today ? p.next : today)}">`)}
          ${field('Ended (optional)', '<input id="dc-end" type="date">')}
        </div>
        ${field('Notes (optional)', '<textarea id="dc-notes" rows="2"></textarea>')}`,
      submitLabel: 'Log heat',
      cancelLabel: 'Not now',
      submit: async (root) => {
        const start = root.querySelector('#dc-start').value;
        const end = root.querySelector('#dc-end').value;
        const notes = root.querySelector('#dc-notes').value.trim();
        if (!start) return 'When did it start (or when do you expect it)?';
        if (end && end < start) return 'The end is before the start.';
        await eventRepo.create({
          subject_type: 'dog', subject_id: dog.id, event_type: 'heat_cycle', title: 'Heat cycle',
          event_date: start, ...(end ? { event_end_date: end } : {}), details: notes ? { notes } : {}
        });
        return { start };
      },
      reply: (r) => `Log a heat starting ${fmtDate(r.start)}`
    });
    if (!res.done) continue;
    const next = predictNextHeat(heatStarts(dog.id, (await load()).events));
    await chat.say(`Logged.${next ? ` I'll expect ${esc(dogName(dog))}'s next one around ${esc(fmtDate(next.next))}.` : ''}`);
  }
}

// --- 2. This month's preventatives ---------------------------------------------------
// One form per product (heartworm, flea & tick, dewormer...), then "Any other
// preventatives to log?" until she says that's all. The first form ticks the
// active breeding dogs still missing one; each later form ticks the dogs she
// picked last time, since the same dogs usually get the next product too.

async function preventatives(chat, today) {
  const { dogs, events } = await load();
  const month = monthName(today).split(' ')[0];
  const gaps = preventativeGaps(dogs, events, today);
  let ticked;
  if (gaps.length) {
    await chat.say(`${gaps.length === 1 ? 'This dog doesn\'t' : 'These dogs don\'t'} have a dewormer, heartworm or flea & tick preventative logged for ${esc(month)} yet: ${esc(listText(gaps.map(dogName)))}.`);
    ticked = new Set(gaps.map((d) => d.id));
  } else {
    await chat.say(`Everyone's had a preventative logged for ${esc(month)}. Any others to log, like flea & tick?`);
    if ((await chat.choose([{ label: 'Yes, log one', value: 'log' }, { label: 'No thanks', value: '__done', primary: true }])) === '__done') return;
    ticked = new Set(breedingDogs(dogs).map((d) => d.id));
  }
  let first = true;
  let hadGaps = gaps.length > 0;
  for (;;) {
    const res = await preventativeForm(chat, dogs, ticked, today, first);
    if (!res.done) {
      if (first && gaps.length) await chat.say('No problem. Today will remind you until they\'re logged.');
      return;
    }
    ticked = res.result.ids;
    const left = preventativeGaps(dogs, (await load()).events, today);
    let msg = 'Logged.';
    if (left.length) msg = `Logged. Still to do for ${esc(month)}: ${esc(listText(left.map(dogName)))}.`;
    else if (hadGaps) msg = `Logged. Everyone has one for ${esc(month)}!`;
    hadGaps = left.length > 0;
    first = false;
    await chat.say(msg);
    await chat.say('Any other preventatives to log?');
    const pick = await chat.choose([{ label: 'Log another', value: 'log' }, { label: 'No, that\'s all', value: '__done', primary: true }]);
    if (pick === '__done') {
      if (left.length) await chat.say('Today will keep reminding you about the rest.');
      return;
    }
  }
}

// One product for the dogs she ticks → one `preventative` event each. Her own
// active breeding dogs only.
async function preventativeForm(chat, dogs, ticked, today, first) {
  const listed = breedingDogs(dogs).sort((a, b) => dogName(a).localeCompare(dogName(b)));
  const boxes = listed.map((d, i) => `<label class="ck-check"><input type="checkbox" id="dc-dog-${i}"${ticked.has(d.id) ? ' checked' : ''}> <strong>${esc(dogName(d))}</strong>${d.status === 'active_breeding' ? '' : ` <span class="faint">${esc(descriptor(DOG_STATUS, d.status).label)}</span>`}</label>`).join('');
  return chat.form({
    title: first ? '<strong>Which preventative did they get?</strong>' : '<strong>Which one this time?</strong>',
    html: `${field('Product', '<input id="dc-product" type="text" autocomplete="off" placeholder="e.g. Heartgard Plus, NexGard, Panacur">')}
      <div class="ck-inline">
        ${field('Dose (optional)', '<input id="dc-dose" type="text" autocomplete="off">')}
        ${field('Date', `<input id="dc-date" type="date" value="${esc(today)}">`)}
      </div>
      <p class="gl-q">Which dogs?</p>
      <div class="ck-checks">${boxes}</div>`,
    submitLabel: 'Log it',
    cancelLabel: first ? 'Not now' : 'That\'s all',
    submit: async (root) => {
      const product = root.querySelector('#dc-product').value.trim();
      const dose = root.querySelector('#dc-dose').value.trim();
      const date = root.querySelector('#dc-date').value;
      const picked = listed.filter((d, i) => root.querySelector(`#dc-dog-${i}`).checked);
      if (!product) return 'Which product was it?';
      if (!date) return 'What day did they get it?';
      if (!picked.length) return 'Tick at least one dog.';
      for (const d of picked) {
        await eventRepo.create({
          subject_type: 'dog', subject_id: d.id, event_type: 'preventative', title: product,
          event_date: date, details: { product, ...(dose ? { dose } : {}) }
        });
      }
      return { count: picked.length, product, ids: new Set(picked.map((d) => d.id)) };
    },
    reply: (r) => `${r.product} for ${r.count === 1 ? '1 dog' : `${r.count} dogs`}`
  });
}

// --- 3. New health test results --------------------------------------------------------
// The Log health test results task's own loop (logHealthTests), asked once.

async function healthTests(chat) {
  const { dogs, missing } = await healthTestsState({ only: checkinDogs });
  if (!dogs) return;
  await chat.say(missing
    ? `Do you need to log any new health test results? There ${missing === 1 ? 'is 1 planned test' : `are ${missing} planned tests`} still waiting for a result.`
    : 'Do you need to log any new health test results?');
  if ((await chat.choose([{ label: 'Yes, log results', value: 'log' }, { label: 'No thanks', value: '__done', primary: true }])) === '__done') return;
  if (await logHealthTests(chat, { only: checkinDogs })) await chat.say('Those results are saved on each dog\'s page.');
}

// --- 4. Vet visits -----------------------------------------------------------------------
// "Any vet visits to log?" → the same form as any other event (otherEventForm), with
// the vet's summary to file (Documents, Pro) → "Any other vet visits?".

async function vetVisits(chat, today) {
  if (!checkinDogs((await load()).dogs).length) return;
  await chat.say('Any vet visits to log?');
  if ((await chat.choose([{ label: 'Yes, log one', value: 'log' }, { label: 'No thanks', value: '__done', primary: true }])) === '__done') return;
  for (;;) {
    const res = await otherEventForm(chat, descriptor(EVENT_TYPES, 'vet_visit'), today, { docType: editionFlags.documents ? 'vet_summary' : null });
    if (res.done) await chat.say(`Logged.${res.result.filed ? ' The vet summary is filed on their page.' : ''}`);
    await chat.say('Any other vet visits?');
    if ((await chat.choose([{ label: 'Log another', value: 'log' }, { label: 'No, that\'s all', value: '__done', primary: true }])) === '__done') return;
  }
}

// --- 5. Any other events ---------------------------------------------------------------
// Anything else that happened to her dogs: a type (otherEventTypes), then one form
// with that type's fields, the date (and end date for a span), the dogs, and a
// cost per dog. "Anything else to log?" until she says that's all.

async function otherEvents(chat, today) {
  const types = otherEventTypes(editionFlags);
  if (!types.length || !checkinDogs((await load()).dogs).length) return;
  await chat.say('Any other events that need logging, like a new medication, an illness or a weight?');
  if ((await chat.choose([{ label: 'Yes, log one', value: 'log' }, { label: 'No thanks', value: '__done', primary: true }])) === '__done') return;
  for (;;) {
    await chat.say('What happened?');
    const pick = await chat.choose([
      ...types.map((t) => ({ label: t.label, value: t.value })),
      { label: 'Never mind', value: '__done' }
    ], { search: types.length > 8 ? { placeholder: 'Find a kind of event' } : null });
    if (pick === '__done') return;
    const res = await otherEventForm(chat, descriptor(EVENT_TYPES, pick), today);
    if (res.done) await chat.say('Logged.');
    await chat.say('Anything else to log?');
    if ((await chat.choose([{ label: 'Log another', value: 'log' }, { label: 'No, that\'s all', value: '__done', primary: true }])) === '__done') return;
  }
}

// One event of `type` for the dogs she ticks → one event each (dogEvents), and a
// linked expense each when she gives a cost (expenseRepo.createForEvent, as the
// event form does for several dogs). With `docType` (vet visits: 'vet_summary'),
// the form also takes a file (kelsSteps.filePicker), filed on each ticked dog as
// that kind of document, titled and dated as the event, the vet as its issuer.
// A document belongs to one dog and deleting it deletes its file, so each dog
// gets its own copy.
async function otherEventForm(chat, type, today, { docType = null } = {}) {
  let pickedDoc = () => null;
  const { dogs } = await load();
  const listed = checkinDogs(dogs);
  const span = type.duration === 'span';
  const nameKey = eventNameKey(type);
  const boxes = listed.map((d, i) => `<label class="ck-check"><input type="checkbox" id="dc-ev-dog-${i}"${listed.length === 1 ? ' checked' : ''}> <strong>${esc(dogName(d))}</strong>${d.status === 'active_breeding' ? '' : ` <span class="faint">${d.status === 'puppy' ? 'Keeping' : esc(descriptor(DOG_STATUS, d.status).label)}</span>`}</label>`).join('');
  return chat.form({
    title: `<strong>${esc(type.label)}</strong>`,
    html: `${field(type.value === 'note' ? 'Note' : 'Title (optional)', `<input id="dc-ev-title" type="text" autocomplete="off" placeholder="${esc(type.value === 'note' ? 'What happened?' : type.label)}">`, type.value === 'note' || !nameKey ? '' : 'Leave blank to use what you fill in below.')}
      ${(type.fields || []).map((f) => eventFieldInput(f, f.key === nameKey)).join('')}
      <div class="ck-inline">
        ${field(span ? 'Started' : 'Date', `<input id="dc-ev-date" type="date" value="${esc(today)}">`)}
        ${span ? field('Ended (optional)', '<input id="dc-ev-end" type="date">') : ''}
      </div>
      ${field('Cost per dog (optional)', '<input id="dc-ev-cost" type="number" min="0" step="0.01" inputmode="decimal">', 'Logged to Financials against each dog.')}
      ${docType ? filePicker('dc-ev-doc', { label: 'Vet summary (optional)', hint: 'A PDF, or photos of the pages. Filed on each dog\'s page under Documents.' }) : ''}
      <p class="gl-q">Which dogs?</p>
      <div class="ck-checks">${boxes}</div>`,
    wire: (root) => {
      if (docType) pickedDoc = wireFilePicker(root, 'dc-ev-doc', { hint: 'A PDF, or photos of the pages. Filed on each dog\'s page under Documents.' });
    },
    submitLabel: 'Log it',
    cancelLabel: 'Not now',
    submit: async (root) => {
      const details = {};
      for (const f of type.fields || []) details[f.key] = root.querySelector(`#ck-f-${f.key}`)?.value ?? '';
      const form = {
        eventType: type.value,
        dogIds: listed.filter((d, i) => root.querySelector(`#dc-ev-dog-${i}`).checked).map((d) => d.id),
        date: root.querySelector('#dc-ev-date').value,
        endDate: root.querySelector('#dc-ev-end')?.value || '',
        title: root.querySelector('#dc-ev-title').value,
        cost: root.querySelector('#dc-ev-cost').value,
        details
      };
      const problem = dogEventProblem(form);
      if (problem) return problem;
      const amount = String(form.cost).trim() === '' ? null : Number(form.cost);
      const events = dogEvents(form);
      for (const e of events) {
        const saved = await eventRepo.create(e);
        if (amount != null) await expenseRepo.createForEvent(saved, { amount, category: defaultExpenseCategoryFor(type.value) });
      }
      const doc = docType ? pickedDoc() : null;
      if (doc) {
        const { storeDocumentFile, createDocument } = await import('./documentModal.js');
        for (const e of events) {
          const fileId = await storeDocumentFile(doc, { title: e.title });
          await createDocument({ dog_id: e.subject_id, doc_type: docType, title: e.title, doc_date: e.event_date, issuer_or_lab: e.details.vet || '', notes: '', file_id: fileId });
        }
      }
      return { title: events[0].title, count: events.length, date: form.date, filed: Boolean(doc) };
    },
    reply: (r) => `${r.title} for ${r.count === 1 ? '1 dog' : `${r.count} dogs`}, ${fmtDate(r.date)}${r.filed ? ' 📎' : ''}`
  });
}
