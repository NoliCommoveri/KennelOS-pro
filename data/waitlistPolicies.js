// waitlistPolicies.js — her waitlist policies' starter wording (Waitlist Policies plan
// §2.1; End-State guide §29). PURE: no Dexie, no DOM (tests/waitlistPolicies.test.js).
//
// "Start from common topics" adds these six, each worded from her own waitlist
// settings at the moment she taps it, for her to edit. A sentence whose setting is off
// or blank is left out, so nothing says what her list doesn't do. Each row keeps its
// `topic` and the settings it quoted (`basis`), so the Policies editor can say when one
// of them has changed since (basisChanges). Her words are never rewritten.
import { openDays } from './waitlistRules.js';
import { formQuestions } from './waitlistForm.js';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const money = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 })}`;
const plural = (n, word) => `${n} ${word}${Number(n) === 1 ? '' : /(s|x|ch|sh)$/.test(word) ? 'es' : 's'}`;
const possessive = (name) => (/s$/i.test(name) ? `${name}'` : `${name}'s`);
const ORD = (n) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`;
const listWords = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`);

// Her open weekdays in words: "Monday through Friday" where they run together (a run
// may wrap past Saturday: "Friday through Monday"), else "Monday, Wednesday and Friday".
// null when every day is open.
export function openDaysWords(config) {
  const days = openDays(config);
  if (days.length === 7) return null;
  const set = new Set(days);
  // A run of 3 or more consecutive days (wrapping), starting where the day before is closed.
  for (const start of days) {
    if (set.has((start + 6) % 7)) continue;
    let len = 0;
    while (len < 7 && set.has((start + len) % 7)) len++;
    if (len === days.length && len >= 3) return `${DAY_NAMES[start]} through ${DAY_NAMES[(start + len - 1) % 7]}`;
  }
  return listWords(days.map((d) => DAY_NAMES[d]));
}

// The wording "{n} business days" or "{n} days" (every day open).
const dayWords = (n, config) => plural(n, openDays(config).length === 7 ? 'day' : 'business day');

function zoneWords(timeZone) {
  if (!timeZone) return '';
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longGeneric' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName');
    return part ? part.value.replace(/ Time$/, '') : '';
  } catch { return ''; }
}

// What each topic quotes from her settings. Its basis is these values at the time.
const BASIS = {
  applications: (c) => ({ fee_amount: Number(c.fee_amount) > 0 ? Number(c.fee_amount) : null, fee_due_days: c.fee_due_days ?? null }),
  preferences: (c) => ({ color_matching: Boolean(c.color_matching) }),
  passes: (c) => ({ max_passes: Number(c.max_passes), no_response_counts_as_pass: c.no_response_counts_as_pass !== false, fee_credit_policy: c.fee_credit_policy || null }),
  picking: (c) => ({ respond_days: Number(c.respond_days), no_response_counts_as_pass: c.no_response_counts_as_pass !== false, open_days: openDays(c).join(',') }),
  pausing: () => ({}),
  days: (c) => ({ open_days: openDays(c).join(',') })
};

// The six starter topics (the owner's, 2026-11-05): heading, the starter wording from
// her settings, and the grey hint under it while she edits.
export const POLICY_TOPICS = Object.freeze([
  {
    id: 'applications', heading: 'Applications',
    body: (c, k) => {
      const fee = Number(c.fee_amount) > 0;
      return [
        `Every application is reviewed, and approval is at ${possessive(k)} discretion.`,
        fee ? `Once you're approved, your ${money(c.fee_amount)} application fee${c.fee_due_days ? ` is due within ${dayWords(c.fee_due_days, c)}, and it` : ''} must be received and marked received by us before your name appears on the waitlist. Your place in line counts from the day your fee is received.`
          : 'Your place in line counts from the day you\'re approved.'
      ].join(' ');
    },
    hint: 'Families ask when they\'ll see their name on the list.'
  },
  {
    id: 'preferences', heading: 'Preferences',
    body: (c) => [
      'So that every family on our list gets their offer as quickly as possible, a family whose preferences don\'t match any available puppy in a litter is skipped for that litter. You won\'t be offered a puppy from it, and being skipped this way never counts as a pass.',
      c.color_matching ? 'Color preferences count too.' : '',
      'Please choose your preferences carefully: a preference that rules out most puppies can mean a long wait. You can ask to change them from your status page.'
    ].filter(Boolean).join(' '),
    hint: 'Families ask why a litter went by without them.'
  },
  {
    id: 'passes', heading: 'Passes and not responding',
    body: (c, k) => {
      const max = Number(c.max_passes) || 1;
      return [
        max === 1 ? 'When it\'s your turn, you can pass on a litter, but passing removes you from the waitlist.'
          : `When it's your turn, you can pass on a litter and keep your place. You can pass ${plural(max - 1, 'time')}; your ${ORD(max)} pass removes you from the waitlist.`,
        c.no_response_counts_as_pass !== false ? 'Not responding by your deadline counts as a pass.'
          : `If you don't respond by your deadline, the turn moves to the next family and ${k} will be in touch.`,
        c.fee_credit_policy === 'non_refundable' ? 'When a family is removed, the application fee is not returned, and joining again means a new application.' : ''
      ].filter(Boolean).join(' ');
    },
    hint: 'Families ask what happens if they say no to a litter.'
  },
  {
    id: 'picking', heading: 'Picking your puppy',
    body: (c, k, kennel) => {
      const zone = zoneWords(kennel?.time_zone);
      return [
        `When it's your turn you'll have ${dayWords(Number(c.respond_days) || 1, c)}, until the end of the day on your deadline${zone ? ` (${zone} time)` : ''}, to choose your puppy and have your deposit received by ${k}. Choosing without the deposit received by then doesn't hold the puppy.`,
        c.no_response_counts_as_pass !== false ? 'If both aren\'t done by your deadline, it counts as a pass and the turn moves to the next family.'
          : 'If both aren\'t done by your deadline, the turn moves to the next family.'
      ].join(' ');
    },
    hint: 'Families ask whether choosing a puppy holds it.'
  },
  {
    id: 'pausing', heading: 'Pausing',
    body: (c, k) => {
      const ready = formQuestions(c).find((q) => q.key === 'ready_timing');
      return [
        'You can pause from your status page when you\'re not ready for a puppy. While you\'re paused you will not be offered puppies: every litter that comes up during your pause skips you, and you keep your place.',
        `If you change your mind, you must let ${k} know and have your pause ended before your turn comes up. A litter that has already skipped you won't be offered to you afterwards.`,
        ready ? `Your answer to "${ready.label}" works the same way: anything but "ASAP" pauses you until then.` : ''
      ].filter(Boolean).join(' ');
    },
    hint: 'If you allow a skipped family back in after their pause, say so here.'
  },
  {
    id: 'days', heading: 'Business days and closed dates',
    body: (c) => {
      const words = openDaysWords(c);
      return [
        words ? `Deadlines on our waitlist count only the days we're open for business: ${words}.` : 'Deadlines on our waitlist count every day of the week, including weekends.',
        'We also close for holidays and other dates through the year; those days don\'t count either, so a deadline that would land on one moves to our next open day. Your status page always shows your exact deadline.'
      ].join(' ');
    },
    hint: 'Your upcoming closed dates show under this policy on families\' pages by themselves.'
  }
]);

export const topicById = (id) => POLICY_TOPICS.find((t) => t.id === id) || null;

// One starter row: heading, wording from her settings now, its topic and basis.
// `config` is the effective config (waitlistRules.waitlistConfig).
export function policyStarter(topicId, config, kennel, makeId = () => crypto.randomUUID().slice(0, 8)) {
  const t = topicById(topicId);
  if (!t) return null;
  const k = String(kennel?.kennel_name || '').trim() || 'the breeder';
  return { id: `pol_${makeId()}`, heading: t.heading, body: t.body(config, k, kennel), topic: t.id, basis: BASIS[t.id](config) };
}

export const policyStarters = (config, kennel, makeId) => POLICY_TOPICS.map((t) => policyStarter(t.id, config, kennel, makeId));

// What a starter row quoted that her settings no longer say, in words ([] = nothing):
// "passes are now 3". Rows without a topic or basis have nothing to compare.
const SAYS = {
  fee_amount: (v) => (v == null ? 'there\'s no application fee now' : `the fee is now ${money(v)}`),
  fee_due_days: (v) => (v == null ? 'there\'s no fee due date now' : `the fee is now due within ${v} days`),
  color_matching: (v) => (v ? 'color matching is now on' : 'color matching is now off'),
  max_passes: (v) => `passes before removal are now ${v}`,
  no_response_counts_as_pass: (v) => (v ? 'no response now counts as a pass' : 'no response no longer counts as a pass'),
  fee_credit_policy: (v) => (v === 'non_refundable' ? 'the fee is now non-refundable' : 'the fee is no longer non-refundable'),
  respond_days: (v) => `families now have ${v} days to choose and send the deposit`,
  open_days: () => 'your open days have changed'
};
export function basisChanges(row, config) {
  const make = row && row.topic && BASIS[row.topic];
  if (!make || !row.basis) return [];
  const now = make(config);
  const out = [];
  for (const [key, was] of Object.entries(row.basis)) {
    if (!(key in now) || now[key] === was) continue;
    const say = SAYS[key]?.(now[key]);
    if (say && !out.includes(say)) out.push(say);
  }
  return out;
}

// The grey line under a row while she edits: the topic's hint, then what it read.
export function policyHint(row, config) {
  const t = row && topicById(row.topic);
  if (!t) return '';
  const read = [];
  const b = BASIS[t.id](config);
  if ('fee_amount' in b) read.push(b.fee_amount ? `fee ${money(b.fee_amount)}` : 'no application fee');
  if ('respond_days' in b) read.push(dayWords(b.respond_days, config));
  if ('max_passes' in b) read.push(plural(b.max_passes, 'pass'), b.no_response_counts_as_pass ? 'no response counts as a pass' : 'no response isn\'t a pass');
  if (t.id === 'days') read.push(openDaysWords(config) ? `open ${openDaysWords(config)}` : 'open every day');
  return read.length ? `${t.hint} From your settings: ${read.join(', ')}.` : t.hint;
}
