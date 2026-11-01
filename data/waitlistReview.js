// waitlistReview.js — the rules behind Kels's "Review my waitlist" (Kels Roadmap
// §3.16; assets/waitlistReviewUI.js draws it). PURE: no db, no DOM, no clock.
//
// The task works through Today's own waitlist nudges (nudges.waitlistNudgeItems),
// so the wording and the one-tap actions are the same in both places; this module
// reads each nudge's key (who and what it's about), says which step it belongs to,
// builds the opening "here's what's waiting on you" line, and words what's missing
// before there's anything to review (the list not set up or not online, no form).

// A Today nudge key → what it's about. Waitlist keys are `kind:id[:id…]`; the ids
// are an entry, a request on it, a litter or a turn, depending on the kind.
export function readNudgeKey(key) {
  const [kind, a = null, b = null] = String(key || '').split(':');
  const out = { kind, entryId: null, requestId: null, litterId: null, turnId: null, saleId: null, chargeId: null, stepId: null };
  switch (kind) {
    case 'waitlist-offer-overdue': out.turnId = a; break;
    case 'waitlist-open-picks': out.litterId = a; break;
    case 'waitlist-extra-request':
    case 'waitlist-pickup-request': out.entryId = a; out.requestId = b; break;
    case 'extra-due': out.saleId = a; out.chargeId = b; out.stepId = String(key).split(':')[3] || null; break;
    case 'waitlist-applications': break; // the task lists applications itself
    default: out.entryId = a;
  }
  return out;
}

// Which step of the review each nudge kind belongs to (§3.16's order: requests and
// messages, back-outs, offers past their deadline, open picks, then the rest).
export const STEP_OF = Object.freeze({
  'waitlist-messages': 'requests',
  'waitlist-pause-request': 'requests',
  'waitlist-pref-request': 'requests',
  'waitlist-listen-request': 'requests',
  'waitlist-companion-request': 'requests',
  'waitlist-extra-request': 'requests',
  'waitlist-pickup-request': 'requests',
  'waitlist-back-out': 'backouts',
  'waitlist-offer-overdue': 'overdue',
  'waitlist-open-picks': 'picks',
  'waitlist-fee-overdue': 'fees',
  'extra-due': 'fees',
  'waitlist-ready-overdue': 'upkeep',
  'waitlist-removed': 'upkeep'
});
export const REVIEW_STEPS = Object.freeze(['requests', 'backouts', 'overdue', 'picks', 'turns', 'applications', 'fees', 'upkeep']);

const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
const joinAnd = (xs) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

// A request's words in the opening line: [one, many].
const REQUEST_WORDS = {
  pause: ['a pause', 'pauses'],
  pref: ['a change to their answers', 'changes to their answers'],
  listen: ['which litters they wait for', 'changes to which litters they wait for'],
  companion: ['a Companion link', 'Companion links'],
  extra: ['an extra', 'extras'],
  extraCancel: ['an extra to cancel', 'extras to cancel'],
  pickup: ['a pickup time', 'pickup times'],
  address: ['their own pickup place', 'own pickup places']
};

// The opening line: "Here's what's waiting on you: 1 family backing out, 3 requests
// (2 extras, a pickup time), …". `c`: counts per thing (missing = 0); `picks` is
// the litters' names. '' when there's nothing.
export function reviewSummary(c = {}) {
  const parts = [];
  if (c.backOuts) parts.push(n(c.backOuts, 'family backing out', 'families backing out'));
  const req = Object.entries(c.requests || {}).filter(([, v]) => v > 0);
  const reqTotal = req.reduce((t, [, v]) => t + v, 0);
  if (reqTotal) {
    const what = req.map(([k, v]) => (v === 1 ? REQUEST_WORDS[k]?.[0] : `${v} ${REQUEST_WORDS[k]?.[1]}`)).filter(Boolean);
    parts.push(`${n(reqTotal, 'request', 'requests')} (${what.join(', ')})`);
  }
  if (c.messages) parts.push(n(c.messages, 'new message', 'new messages'));
  if (c.overdue) parts.push(n(c.overdue, 'offer past its deadline', 'offers past their deadline'));
  if (c.picks?.length) parts.push(`picks to open on ${joinAnd(c.picks)}`);
  if (c.turns) parts.push(n(c.turns, 'turn to offer', 'turns to offer'));
  if (c.applications) parts.push(n(c.applications, 'new application', 'new applications'));
  if (c.fees) parts.push(n(c.fees, 'fee to check', 'fees to check'));
  if (c.extrasDue) parts.push(n(c.extrasDue, 'extras payment due', 'extras payments due'));
  if (c.ready) parts.push(n(c.ready, 'family who hasn\'t answered "Ready now?"', 'families who haven\'t answered "Ready now?"'));
  if (c.removals) parts.push(n(c.removals, 'removal you can still undo', 'removals you can still undo'));
  return parts.length ? `Here's what's waiting on you: ${parts.join(', ')}.` : '';
}

// What's missing before a review makes sense, for one kennel. `s`: { setUp,
// onlineOffered, online, formOpen, publishProblem ('' or why it isn't publishing),
// ownForm }. → { stop, lines: [text], fixes: [{ task, label }] }. `stop` (not set
// up) means there's nothing to review yet; otherwise she can still go on.
export function readinessProblems(s = {}) {
  if (!s.setUp) {
    return {
      stop: true,
      lines: ['Your waitlist isn\'t set up yet, so there\'s nothing to review. Let\'s set it up first: your fee, how offers work and your programs.'],
      fixes: [{ task: 'waitlist-setup', label: 'Set up my waitlist' }]
    };
  }
  const lines = [];
  const fixes = [];
  const fix = (task, label) => { if (!fixes.some((f) => f.task === task)) fixes.push({ task, label }); };
  if (s.onlineOffered && !s.online) {
    lines.push('Your waitlist isn\'t online, so families can\'t apply, see their place or answer offers themselves, and nothing new comes in by itself. I can still go through what\'s here.');
    fix('waitlist-setup', 'Put my list online');
  } else if (s.online && s.publishProblem) {
    lines.push(`Your list is set to be online, but it isn't publishing right now: ${s.publishProblem} Families see the last version that went out.`);
  }
  if (!s.ownForm) {
    lines.push('You haven\'t made your own application form yet, so families get the standard questions.');
    fix('form-setup', 'Set up my application form');
  }
  if (s.online && !s.formOpen) {
    lines.push('Families can\'t apply online yet: you\'re typing in each application yourself.');
    fix('form-setup', 'Set up my application form');
  }
  return { stop: false, lines, fixes };
}

// What a closed turn did, in lines for her (Today's "Record no response" and Kels's
// "Count it as a pass" / "Record no response"): whether it counted as a pass, then
// who the turn went to (describeOfferChanges, passed in so this stays pure). `res`
// is recordOutcome's result; `name` the family's; `changes` the offer lines.
export function outcomeReport(res, { name, changes = [] }) {
  const lines = [];
  if (res?.passes) {
    lines.push(!res.passes.counted ? `This doesn't count as a pass for ${name}.`
      : res.removed ? `That was ${name}'s pass ${res.passes.used} of ${res.passes.max}, so they've been removed from the list. You can undo this for 7 days.`
      : `This counts as ${name}'s pass ${res.passes.used} of ${res.passes.max}. They keep their place.`);
  }
  lines.push(...changes);
  if (!res?.next && !(res?.waiting || []).length) lines.push('Nobody else on the list is eligible for your open litters right now.');
  return lines;
}
