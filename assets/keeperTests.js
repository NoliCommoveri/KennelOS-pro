// A pup just marked Keeping: offer to add her kennel's planned tests for its
// breed that aren't on its plan yet (kennelRepo.testsToPlan, the same panel a
// new dog is seeded from). Pups added from a litter start with no plan, so
// this is where a kept pup's plan starts. Two ways to ask: a modal (Dog page, Litter page, sale prompts) and a
// chat question (Kels). Nothing is asked when there's nothing to add.
import { dogRepo, dogName } from '../data/dogRepo.js';
import { kennelRepo, testsToPlan } from '../data/kennelRepo.js';
import { confirmModal, esc } from './ui.js';

const listText = (xs) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

// [{ dog, tests }] for each Keeping pup in `dogs` with tests to add.
export async function keeperTestOffers(dogs) {
  const keepers = (dogs || []).filter((d) => d && !d.is_archived && d.status === 'puppy' && d.disposition === 'keeping');
  if (!keepers.length) return [];
  const kennels = await kennelRepo.getAll();
  return keepers.map((dog) => ({ dog, tests: testsToPlan(dog, kennels) })).filter((o) => o.tests.length);
}

// Plain-text question (no HTML): who, and which tests.
function question(offers) {
  const who = listText(offers.map((o) => dogName(o.dog) || 'This puppy'));
  const same = offers.every((o) => o.tests.join('\n') === offers[0].tests.join('\n'));
  const tests = same
    ? listText(offers[0].tests)
    : offers.map((o) => `${dogName(o.dog)}: ${listText(o.tests)}`).join('; ');
  return {
    title: `Add planned tests for ${who}?`,
    message: `${offers.length === 1 ? `${who} is` : 'They\'re'} staying with you. Your kennel's tests for the breed that aren't planned yet: ${tests}.`
  };
}

async function addAll(offers) {
  for (const o of offers) await dogRepo.addPlannedTests(o.dog.id, o.tests);
}

// Modal version. Resolves true when tests were added.
export async function offerKeeperTests(dogs) {
  const offers = await keeperTestOffers(Array.isArray(dogs) ? dogs : [dogs]);
  if (!offers.length) return false;
  const q = question(offers);
  if (!(await confirmModal({ title: q.title, message: q.message, confirmLabel: 'Add tests', cancelLabel: 'Not now' }))) return false;
  await addAll(offers);
  return true;
}

// Kels version, in her chat. Resolves true when tests were added.
export async function askKeeperTests(chat, dogs) {
  const offers = await keeperTestOffers(dogs);
  if (!offers.length) return false;
  const q = question(offers);
  await chat.say(`${esc(q.message)} Add ${offers.length === 1 ? 'them to the plan' : 'them to their plans'}?`);
  const yes = (await chat.choose([{ label: 'Add the tests', value: 'yes', primary: true }, { label: 'Not now', value: '' }])) === 'yes';
  if (yes) {
    await addAll(offers);
    await chat.say('Added. They\'re on the Planned Tests card, and Log health test results will ask for them.');
  }
  return yes;
}
