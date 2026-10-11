// contractForms.js — her contract forms (Jotform, Integrations plan §2.1a) and
// the prefilled link that sends one out for signature.
//
// She keeps the forms on a Form service Account (`contract_forms`: [{ id, form_type, label,
// url }], D6 / D12), each tagged with a CONTRACT_FORM_TYPE so the Contract page
// can offer the right one. "Send for signature" builds the form's URL with the
// contract's facts as query parameters — Jotform's documented prefill — on her
// device: no API call, no server. The parameter names are fixed (PREFILL_FIELDS,
// D14): she gives her Jotform fields those Unique Names, and any field her form
// doesn't have is simply ignored by Jotform.
//
// A prefilled link carries its values in the URL, so only short facts go in it,
// never private notes, terms or end reasons (§2.1). This list IS that allow-list.
// Pure: no db, no DOM. The callers read the records.
import { CONTRACT_FORM_TYPE, CONTRACT_TYPE, REGISTRATION_TYPE, SEX, STUD_SERVICE_TYPE, descriptor } from './vocab.js';

const text = (v) => String(v ?? '').trim();

// Only an http(s) address is a usable form link.
export function formLink(raw) {
  const t = text(raw);
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(t)) return '';
  try { return new URL(t).href; } catch { return ''; }
}

// Which service a link belongs to, from its host (e.g. form.jotform.com,
// eu.jotform.com, a jotform.com/… link). Anything else is 'link'.
export function formProvider(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'jotform.com' || host.endsWith('.jotform.com') || host === 'jotform.me' || host.endsWith('.jotform.me')
      ? 'jotform' : 'link';
  } catch { return 'link'; }
}

const FORM_TYPES = new Set(CONTRACT_FORM_TYPE.map((t) => t.value));

// An Account's saved forms, cleaned: a known type, a usable link, a label (the
// type's name when she left it blank). Older backups have no field: [].
export function cleanForms(list) {
  return (Array.isArray(list) ? list : [])
    .filter((f) => f && FORM_TYPES.has(f.form_type) && formLink(f.url))
    .map((f) => ({
      id: text(f.id) || crypto.randomUUID(),
      form_type: f.form_type,
      label: text(f.label) || descriptor(CONTRACT_FORM_TYPE, f.form_type).label,
      url: formLink(f.url)
    }));
}

// Every saved form across her Form service accounts (archived ones, and forms
// left on an account whose type was changed, left out), each with its account's
// id and name.
export function allForms(accounts) {
  return (accounts || [])
    .filter((a) => a && !a.is_archived && a.account_type === 'form_service')
    .flatMap((a) => cleanForms(a.contract_forms).map((f) => ({ ...f, account_id: a.id, account_name: text(a.name) })));
}

// The forms for one contract, best first: `matching` = forms whose type serves
// this contract_type, ranked by fit to the linked sale (pet home for a limited
// registration, breeding rights for full, deposit while it's pending), then
// label; `others` = the rest, for "Show all forms".
export function rankForms(forms, contract, sale = null) {
  const order = new Map(CONTRACT_FORM_TYPE.map((t, i) => [t.value, i]));
  const fit = (f) => {
    const t = descriptor(CONTRACT_FORM_TYPE, f.form_type);
    if (!sale || (!t.registrations && !t.saleStatuses)) return t.registrations || t.saleStatuses ? 0 : 1;
    if (t.registrations && t.registrations.includes(sale.registration_type || '')) return 2;
    if (t.saleStatuses && t.saleStatuses.includes(sale.status)) return 2;
    return 0;
  };
  const byLabel = (a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
  const matching = []; const others = [];
  for (const f of forms || []) {
    const t = descriptor(CONTRACT_FORM_TYPE, f.form_type);
    ((t.contractTypes || []).includes(contract?.contract_type) ? matching : others).push(f);
  }
  matching.sort((a, b) => fit(b) - fit(a) || order.get(a.form_type) - order.get(b.form_type) || byLabel(a, b));
  others.sort((a, b) => order.get(a.form_type) - order.get(b.form_type) || byLabel(a, b));
  return { matching, others };
}

// The parameter names a form can use, by group, with what each holds. Shown on
// the Accounts page (Copy) so she can set her Jotform fields' Unique Names.
export const PREFILL_FIELDS = {
  every: [
    ['contractRef', 'This contract\'s reference (make it a hidden field)'],
    ['contractTitle', 'Contract title'],
    ['contractDate', 'Today\'s date (YYYY-MM-DD)'],
    ['kennelName', 'Your kennel\'s name'],
    ['kennelLocation', 'Your kennel\'s location'],
    ['kennelWebsite', 'Your kennel\'s website']
  ],
  sale: [
    ['saleRef', 'The sale\'s reference (make it a hidden field)'],
    ['buyerName', 'Buyer\'s full name'],
    ['buyerFirstName', 'Buyer\'s first name'],
    ['buyerLastName', 'Buyer\'s last name'],
    ['buyerEmail', 'Buyer\'s email'],
    ['buyerPhone', 'Buyer\'s phone'],
    ['buyerAddress', 'Buyer\'s address'],
    ['puppyName', 'Puppy\'s call name'],
    ['puppyRegisteredName', 'Puppy\'s registered name'],
    ['puppySex', 'Puppy\'s sex'],
    ['puppyColor', 'Puppy\'s color / markings'],
    ['puppyDob', 'Puppy\'s date of birth'],
    ['puppyMicrochip', 'Puppy\'s microchip number'],
    ['breed', 'Breed'],
    ['sireName', 'Sire'],
    ['damName', 'Dam'],
    ['registrationType', 'Registration (Limited, Full…)'],
    ['price', 'Price'],
    ['depositAmount', 'Deposit'],
    ['balanceDue', 'Balance still due']
  ],
  stud_service: [
    ['studServiceRef', 'The stud service\'s reference (make it a hidden field)'],
    ['studName', 'Stud dog'],
    ['studRegisteredName', 'Stud\'s registered name'],
    ['damName', 'Dam'],
    ['damRegisteredName', 'Dam\'s registered name'],
    ['partnerName', 'The other party\'s full name'],
    ['partnerFirstName', 'The other party\'s first name'],
    ['partnerLastName', 'The other party\'s last name'],
    ['partnerEmail', 'The other party\'s email'],
    ['partnerPhone', 'The other party\'s phone'],
    ['partnerAddress', 'The other party\'s address'],
    ['studFee', 'Stud fee'],
    ['serviceType', 'In person or AI / shipped']
  ],
  dog: [
    ['dogName', 'The dog\'s call name'],
    ['dogRegisteredName', 'The dog\'s registered name'],
    ['dogSex', 'The dog\'s sex'],
    ['dogDob', 'The dog\'s date of birth'],
    ['dogMicrochip', 'The dog\'s microchip number'],
    ['breed', 'Breed'],
    ['partnerName', 'The other party\'s full name (co-owner, lessee, foster home)'],
    ['partnerFirstName', 'The other party\'s first name'],
    ['partnerLastName', 'The other party\'s last name'],
    ['partnerEmail', 'The other party\'s email'],
    ['partnerPhone', 'The other party\'s phone'],
    ['partnerAddress', 'The other party\'s address'],
    ['leaseStart', 'Lease start date'],
    ['leaseEnd', 'Lease end date']
  ]
};

// Which groups a form type fills, after `every`.
export function fieldGroupsFor(formType) {
  if (formType === 'stud_service') return ['stud_service'];
  if (['lease', 'foster', 'other'].includes(formType)) return ['dog'];
  if (formType === 'co_own') return ['sale', 'dog'];
  return ['sale'];
}

// "Jane Q. Smith" → ['Jane Q.', 'Smith']; one word → [word, ''].
export function splitName(name) {
  const t = text(name).replace(/\s+/g, ' ');
  const i = t.lastIndexOf(' ');
  return i < 0 ? [t, ''] : [t.slice(0, i), t.slice(i + 1)];
}

const money = (v) => {
  if (v == null || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : '';
};
const label = (vocab, v) => (v ? descriptor(vocab, v).label : '');

function person(prefix, c) {
  if (!c) return [];
  const [first, last] = splitName(c.name);
  return [
    [`${prefix}Name`, text(c.name)], [`${prefix}FirstName`, first], [`${prefix}LastName`, last],
    [`${prefix}Email`, text(c.email)], [`${prefix}Phone`, text(c.phone)], [`${prefix}Address`, text(c.address)]
  ];
}

// The facts to prefill, as [[name, value]] in PREFILL_FIELDS order, empties
// dropped. `facts` holds the records the contract reaches (the caller reads
// them): { contract, kennel, sale, buyer, puppy, sire, dam, balanceDue,
// studService, studDog, studDam, partner, dog, today }.
export function prefillValues(formType, facts = {}) {
  const f = facts;
  const c = f.contract || {};
  const out = [
    ['contractRef', text(c.id)],
    ['contractTitle', text(c.title) || label(CONTRACT_TYPE, c.contract_type)],
    ['contractDate', text(f.today)],
    ['kennelName', text(f.kennel?.kennel_name)],
    ['kennelLocation', text(f.kennel?.location)],
    ['kennelWebsite', text(f.kennel?.website)]
  ];
  const groups = fieldGroupsFor(formType);
  if (groups.includes('sale') && f.sale) {
    const s = f.sale; const p = f.puppy || {};
    out.push(
      ['saleRef', text(s.id)],
      ...person('buyer', f.buyer),
      ['puppyName', text(p.call_name)], ['puppyRegisteredName', text(p.registered_name)],
      ['puppySex', label(SEX, p.sex)], ['puppyColor', text(p.color_markings)],
      ['puppyDob', text(p.date_of_birth)], ['puppyMicrochip', text(p.microchip_id)],
      ['breed', text(p.breed)],
      ['sireName', text(f.sire?.registered_name || f.sire?.call_name)],
      ['damName', text(f.dam?.registered_name || f.dam?.call_name)],
      ['registrationType', label(REGISTRATION_TYPE, s.registration_type)],
      ['price', money(s.price)], ['depositAmount', money(s.deposit_amount)], ['balanceDue', money(f.balanceDue)]
    );
  }
  if (groups.includes('stud_service') && f.studService) {
    const ss = f.studService;
    out.push(
      ['studServiceRef', text(ss.id)],
      ['studName', text(f.studDog?.call_name)], ['studRegisteredName', text(f.studDog?.registered_name)],
      ['damName', text(f.studDam?.call_name)], ['damRegisteredName', text(f.studDam?.registered_name)],
      ...person('partner', f.partner),
      ['studFee', money(ss.fee_amount)], ['serviceType', label(STUD_SERVICE_TYPE, ss.type)]
    );
  }
  if (groups.includes('dog')) {
    const d = f.dog;
    if (d) {
      out.push(
        ['dogName', text(d.call_name)], ['dogRegisteredName', text(d.registered_name)],
        ['dogSex', label(SEX, d.sex)], ['dogDob', text(d.date_of_birth)], ['dogMicrochip', text(d.microchip_id)]
      );
      if (!groups.includes('sale') || !f.sale) out.push(['breed', text(d.breed)]);
    }
    // A sale co-own's other party is its buyer (already in), so partner only when there's no sale.
    if (!groups.includes('sale') || !f.sale) out.push(...person('partner', f.partner));
    if (c.contract_type === 'lease') out.push(['leaseStart', text(c.lease_start_date)], ['leaseEnd', text(c.lease_end_date)]);
  }
  const seen = new Set();
  return out.filter(([k, v]) => v && !seen.has(k) && seen.add(k));
}

// The form's link with the values added as query parameters (anything already
// on the link is kept; a value of ours replaces one of the same name).
export function prefillUrl(url, values) {
  const u = new URL(formLink(url));
  for (const [k, v] of values || []) u.searchParams.set(k, v);
  return u.href;
}

// The note that goes with the link. `who` is the signer's first name.
export function signatureMessage({ who = '', kennelName = '', formLabel = '', subject = '', link = '' } = {}) {
  const hi = who ? `Hi ${who},` : 'Hi,';
  const about = subject ? ` for ${subject}` : '';
  return {
    subject: `${formLabel || 'Contract'}${about}: ready to sign`,
    body: `${hi}\n\nHere's the ${formLabel || 'contract'}${about}. The details are already filled in; please check them, then sign:\n\n${link}\n\nLet me know if anything needs changing.\n\nThank you!${kennelName ? `\n${kennelName}` : ''}`
  };
}
