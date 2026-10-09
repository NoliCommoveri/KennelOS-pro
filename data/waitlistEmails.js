// waitlistEmails.js — the emails her list sends families (Waitlist W2 Plan §8,
// step 6; Spec §15.4). Pure: no database, no network.
//
// Her device writes every email: her template (waitlist_config.email_templates,
// edited in Waitlist settings; blank = the default here) with its placeholders
// filled from her records, so every name, date, litter and place in line comes
// from the rules engine (Spec §10.3), never from the server. The server sends it
// in the kennel's name and adds the footer with the family's status-page link.
// No money in any email (Spec §5.3): amounts and how to pay are on the status page.
//
// "It's almost your turn" keeps its own standing text (soon_notice_text), and a
// note she writes from scratch has no template.

// Every kind the server accepts (cloud/src/waitlist.js EMAIL_KINDS; a test pins
// the two lists together).
export const EMAIL_KINDS = Object.freeze([
  'approved', 'on_list', 'declined', 'offer', 'pass_recorded', 'deadline_passed', 'almost_turn', 'review_prefs', 'litter_born',
  'request_approved', 'request_declined', 'status_link', 'note',
  // Sent by the server itself while her phone is off (W2 step 7).
  'offer_reminder', 'fee_reminder', 'ready_check'
]);

// The templates her device publishes for the server (kennel.email_templates in the
// projection, W2 step 7): what it sends by itself. Only [Kennel Name], [Family],
// [Litter], [Respond by] and [Pay by] are filled in there.
export const SERVER_EMAIL_KINDS = Object.freeze(['offer', 'deadline_passed', 'offer_reminder', 'fee_reminder', 'ready_check']);

export const EMAIL_SUBJECT_MAX = 200;
export const EMAIL_BODY_MAX = 8000;

// The placeholders a template may use, for the settings editor's hint.
export const EMAIL_PLACEHOLDERS = Object.freeze([
  { key: '[Kennel Name]', hint: 'your kennel' },
  { key: '[Family]', hint: 'the family\'s name' },
  { key: '[Litter]', hint: 'the litter or litters' },
  { key: '[Respond by]', hint: 'the last day to choose and pay the deposit' },
  { key: '[Position]', hint: 'their place in line, like #4' },
  { key: '[Pay by]', hint: '" by <date>" when the fee has a due date, else nothing' },
  { key: '[Request]', hint: 'what they asked for' }
]);

// The emails she can reword, in the order the settings editor shows them.
export const EMAIL_TEMPLATE_KINDS = Object.freeze([
  { kind: 'approved', label: 'Application approved (fee request)' },
  { kind: 'on_list', label: 'On the list (fee received or waived)' },
  { kind: 'declined', label: 'Application declined' },
  { kind: 'offer', label: 'It\'s your turn (an offer)' },
  { kind: 'pass_recorded', label: 'Pass recorded' },
  { kind: 'deadline_passed', label: 'Turn closed: the deadline passed' },
  { kind: 'review_prefs', label: 'A litter was born: review your preferences' },
  { kind: 'litter_born', label: 'A litter you match was born' },
  { kind: 'request_approved', label: 'Their request approved' },
  { kind: 'request_declined', label: 'Their request declined' },
  { kind: 'status_link', label: 'Their status page link' },
  { kind: 'offer_reminder', label: 'Reminder: their turn ends soon (sent by KennelOS)' },
  { kind: 'fee_reminder', label: 'Reminder: the fee is due tomorrow (sent by KennelOS)' },
  { kind: 'ready_check', label: '"Ready now?" (sent by KennelOS)' }
]);

export const DEFAULT_EMAIL_TEMPLATES = Object.freeze({
  approved: {
    subject: 'You\'re approved for [Kennel Name]\'s waitlist',
    body: 'Hi [Family],\n\nGood news: your application to [Kennel Name] is approved. To join our waitlist, please pay the application fee[Pay by]. The amount and how to pay are on your status page.\n\nYour place in line is set by the day we receive your fee.\n\n[Kennel Name]'
  },
  on_list: {
    subject: 'You\'re on [Kennel Name]\'s waitlist: [Position]',
    body: 'Hi [Family],\n\nThank you! You\'re on our waitlist, currently [Position] in line. Your status page shows your place, your preferences and our upcoming litters at any time.\n\n[Kennel Name]'
  },
  declined: {
    subject: 'Your application to [Kennel Name]',
    body: 'Hi [Family],\n\nThank you for your interest in a [Kennel Name] puppy. After reviewing your application, we aren\'t able to add you to our waitlist at this time.\n\nWe wish you the very best in finding your new family member.\n\n[Kennel Name]'
  },
  offer: {
    subject: 'It\'s your turn! [Litter]',
    body: 'Hi [Family],\n\nIt\'s your turn to choose a puppy from [Litter]. The puppies available to you are on your status page.\n\nPlease choose your puppy and send your deposit by [Respond by], or let us know there if you\'d like to pass on this litter.\n\n[Kennel Name]'
  },
  pass_recorded: {
    subject: 'Your pass on [Litter]',
    body: 'Hi [Family],\n\nWe\'ve recorded your pass on [Litter]. Your status page shows where you stand on our waitlist.\n\n[Kennel Name]'
  },
  deadline_passed: {
    subject: 'Your turn for [Litter] has closed',
    body: 'Hi [Family],\n\nThe time to choose a puppy from [Litter] and send the deposit ended on [Respond by], so your turn has closed. Your status page shows where you stand on our waitlist.\n\n[Kennel Name]'
  },
  review_prefs: {
    subject: 'A new litter at [Kennel Name]: [Litter]',
    body: 'Hi [Family],\n\n[Litter] was born. With your current preferences, none of its puppies are a match for you. If your preferences have changed, you can review them on your status page.\n\n[Kennel Name]'
  },
  litter_born: {
    subject: 'A litter you match was born: [Litter]',
    body: 'Hi [Family],\n\n[Litter] was born, and you match its puppies. We\'ll be in touch when picks open. Your status page shows your place in line.\n\n[Kennel Name]'
  },
  request_approved: {
    subject: 'Your request to [Kennel Name]',
    body: 'Hi [Family],\n\nWe\'ve approved your request [Request]. Your status page shows the change.\n\n[Kennel Name]'
  },
  request_declined: {
    subject: 'Your request to [Kennel Name]',
    body: 'Hi [Family],\n\nWe weren\'t able to approve your request [Request], so nothing has changed. If you\'d like to talk it over, send us a message from your status page.\n\n[Kennel Name]'
  },
  status_link: {
    subject: 'Your waitlist status page at [Kennel Name]',
    body: 'Hi [Family],\n\nHere is your own status page for [Kennel Name]\'s waitlist. It shows your place in line, our upcoming litters, and anything waiting for your reply. Please keep the link to yourself: it opens your page.\n\n[Kennel Name]'
  },
  offer_reminder: {
    subject: 'Reminder: your turn for [Litter] ends [Respond by]',
    body: 'Hi [Family],\n\nA reminder that your turn to choose a puppy from [Litter] ends on [Respond by]. If you haven\'t yet, please choose your puppy and send your deposit, or let us know on your status page if you\'d like to pass.\n\n[Kennel Name]'
  },
  fee_reminder: {
    subject: 'Your application fee for [Kennel Name] is due tomorrow',
    body: 'Hi [Family],\n\nA reminder that your application fee is due[Pay by]. The amount and how to pay are on your status page. Your place in line is set by the day we receive it.\n\n[Kennel Name]'
  },
  ready_check: {
    subject: 'Are you ready for a puppy? [Kennel Name]',
    body: 'Hi [Family],\n\nWhen you joined our waitlist you told us you\'d be ready a little later. That time has come: are you ready to be offered a puppy now? Please answer "Ready now?" on your status page, either way.\n\n[Kennel Name]'
  },
  note: {
    subject: 'A message from [Kennel Name]',
    body: 'Hi [Family],\n\n\n\n[Kennel Name]'
  }
});

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// '2026-10-20' → 'October 20, 2026' (no time zone involved). Anything else as is.
export function longDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ''));
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : String(ymd ?? '');
}

// 'A', 'A and B', 'A, B and C'.
export function joinNames(list) {
  const xs = (list || []).filter(Boolean);
  if (xs.length <= 1) return xs[0] || '';
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

// Her wording for one kind: each of subject and body her own when she set it,
// else the default.
export function emailTemplate(config, kind) {
  const base = DEFAULT_EMAIL_TEMPLATES[kind] || DEFAULT_EMAIL_TEMPLATES.note;
  const mine = (config && config.email_templates && config.email_templates[kind]) || {};
  return {
    subject: String(mine.subject || '').trim() || base.subject,
    body: String(mine.body || '').trim() || base.body
  };
}

// The placeholder values a set of facts fills in. Dates come as YYYY-MM-DD.
export function placeholderValues({ kennelName = '', family = '', litters = [], respondBy = null, position = null, payBy = null, request = '' } = {}) {
  return {
    'kennel name': kennelName || 'Our kennel',
    family: family || 'there',
    litter: joinNames(litters) || 'our litter',
    'respond by': respondBy ? longDate(respondBy) : 'the date on your status page',
    position: position ? `#${position}` : 'on the list',
    'pay by': payBy ? ` by ${longDate(payBy)}` : '',
    request: request || ''
  };
}

// Fill [Placeholders] (any case). One that isn't known is left as typed, so a
// typo shows in the preview rather than vanishing.
export function fillPlaceholders(text, values) {
  return String(text ?? '').replace(/\[([^\]\n]{1,40})\]/g, (whole, name) => {
    const k = name.trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(values, k) ? values[k] : whole;
  });
}

// A ready-to-preview email: { kind, subject, body }. Subject on one line, both cut
// to what the server takes.
export function draftEmail(kind, facts, config) {
  const t = emailTemplate(config, kind);
  const values = placeholderValues(facts);
  return {
    kind,
    subject: fillPlaceholders(t.subject, values).replace(/\s+/g, ' ').trim().slice(0, EMAIL_SUBJECT_MAX),
    body: fillPlaceholders(t.body, values).replace(/[ \t]+\n/g, '\n').trim().slice(0, EMAIL_BODY_MAX)
  };
}

// What a family asked for, as [Request] reads after "your request": "to pause
// your place until October 20, 2026".
export function requestPhrase(field, request) {
  if (field === 'pause_request') return request && request.until ? `to pause your place until ${longDate(request.until)}` : 'to pause your place';
  if (field === 'listen_change_request') return 'to change which litters you wait for';
  if (field === 'pref_change_request') return 'to change your preferences';
  return '';
}

// The projection's kennel.email_templates: her wording (or the default) for each
// email the server sends by itself.
export function serverEmailTemplates(config) {
  return Object.fromEntries(SERVER_EMAIL_KINDS.map((kind) => [kind, emailTemplate(config, kind)]));
}

// Is an edited email sendable? → '' or the reason it isn't.
export function emailProblem({ subject, body }) {
  if (!String(subject || '').trim()) return 'The subject is empty.';
  if (String(subject).length > EMAIL_SUBJECT_MAX) return `The subject is longer than ${EMAIL_SUBJECT_MAX} characters.`;
  if (!String(body || '').trim()) return 'The message is empty.';
  if (String(body).length > EMAIL_BODY_MAX) return `The message is longer than ${EMAIL_BODY_MAX} characters.`;
  return '';
}
