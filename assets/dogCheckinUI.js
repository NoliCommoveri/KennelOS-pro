// dogCheckinUI.js — Kels's "Check in on my dogs": the breeding dogs' routine
// care, as a chat on pages/kels.html (assets/kelsChat.js draws it).
//
// First the heats: each active breeding female's predicted next heat
// (data/dogCare.js: 6 months after a single heat, else her average interval),
// and whether she wants to log any, future dates included (a heat she knows is
// coming), one female at a time. Then the month's preventatives: the active
// breeding dogs with no preventative (deworming, heartworm, flea & tick) dated
// this month, one form per product, repeated until she says that's all. Each thing is saved as
// soon as she approves it, through the repos, so there's no draft.
import { dogRepo } from '../data/dogRepo.js';
import { eventRepo } from '../data/eventRepo.js';
import { dogsInScope } from '../data/kennelScope.js';
import { breedingDogs, homeDogs, heatStarts, predictNextHeat, heatForecast, preventativeGaps, monthName } from '../data/dogCare.js';
import { daysBetween } from '../data/litterCheckin.js';
import { field } from './litterCheckinUI.js';
import { DOG_STATUS, descriptor } from '../data/vocab.js';
import { esc, fmtDate, todayYMD } from './ui.js';

const HOW = 'I\'ll show you when each of your girls is expected to come into heat and help you log any you know about, then we\'ll log this month\'s preventatives (heartworm, flea & tick, dewormer), as many as you need. Sound good?';
const dogName = (d) => d.call_name || d.registered_name || 'Unnamed';
const listText = (xs) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

async function load() {
  const [dogs, events] = await Promise.all([dogRepo.getAll(), eventRepo.getAll()]);
  return { dogs: dogsInScope(dogs), events };
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

// One product for the dogs she ticks → one `preventative` event each.
async function preventativeForm(chat, dogs, ticked, today, first) {
  // Active breeding dogs first, then her other dogs at home.
  const breeding = breedingDogs(dogs).sort((a, b) => dogName(a).localeCompare(dogName(b)));
  const listed = [...breeding, ...homeDogs(dogs).filter((d) => d.status !== 'active_breeding')];
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
