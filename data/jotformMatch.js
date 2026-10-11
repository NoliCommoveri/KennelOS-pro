// jotformMatch.js — Connect Jotform's field matching (Integrations plan §2.1b):
// read one of her forms' fields (the API's GET /form/{id}/questions) and suggest
// which of her fields each KennelOS fact fills, so she never renames a field to
// one of our fixed names (D14). She confirms or corrects the suggestion once per
// form; the result is the form row's `field_map: { <our fact>: <her parameter> }`
// (contractForms.cleanForms / mapValues). Pure: no network, no database.
//
// Jotform prefills a field by its "unique name" (`name`); a Full Name field by
// its parts (`name[first]`, `name[last]`) and an Address field by its lines
// (`name[addr_line1]`…), *unverified, check Jotform's prefill docs*. Those parts
// are offered as fields of their own.
import { PREFILL_FIELDS, fieldGroupsFor } from './contractForms.js';

const text = (v) => String(v ?? '').trim();

// Field types that hold nothing to fill (headings, buttons, page breaks…).
const NOT_FILLABLE = new Set([
  'control_head', 'control_button', 'control_pagebreak', 'control_text', 'control_image',
  'control_divider', 'control_collapse', 'control_captcha', 'control_signature', 'control_fileupload'
]);

// The API's questions (an object keyed by question id, or an array) → her
// fillable fields, in form order: [{ param, label, type, part? }]. Full Name and
// Address fields come out as their parts.
export function formFields(questions) {
  const list = Array.isArray(questions) ? questions : Object.values(questions || {});
  const out = [];
  list
    .filter((q) => q && text(q.name) && !NOT_FILLABLE.has(q.type))
    .sort((a, b) => Number(a.order) - Number(b.order))
    .forEach((q) => {
      const name = text(q.name);
      const label = text(q.text).replace(/<[^>]*>/g, '').trim() || name;
      if (q.type === 'control_fullname') {
        out.push({ param: `${name}[first]`, label: `${label} (first)`, type: q.type, part: 'first' });
        out.push({ param: `${name}[last]`, label: `${label} (last)`, type: q.type, part: 'last' });
      } else if (q.type === 'control_address') {
        out.push({ param: `${name}[addr_line1]`, label: `${label} (street)`, type: q.type, part: 'addr_line1' });
      } else {
        out.push({ param: name, label, type: q.type });
      }
    });
  return out;
}

// Whether the form has somewhere to sign.
export const hasSignature = (questions) =>
  (Array.isArray(questions) ? questions : Object.values(questions || {})).some((q) => q && q.type === 'control_signature');

// Words in a field label that point at each fact, best first. A label is
// lowercased, with "'s" and punctuation dropped, before matching.
const PHRASES = {
  contractRef: ['contract reference', 'contract ref', 'contractref'],
  contractTitle: ['contract title', 'agreement title'],
  contractDate: ['contract date', 'agreement date', 'date of agreement', 'today date', 'todays date'],
  kennelName: ['kennel name', 'breeder kennel', 'kennel'],
  kennelLocation: ['kennel location', 'kennel address', 'breeder location'],
  kennelWebsite: ['kennel website', 'breeder website', 'website'],
  breederName: ['breeder full name', 'seller full name', 'breeder name', 'seller name', 'kennel owner name', 'kennel owner', 'breeder', 'seller'],
  breederFirstName: ['breeder first name', 'seller first name'],
  breederLastName: ['breeder last name', 'seller last name'],
  breederEmail: ['breeder email', 'seller email', 'kennel email'],
  breederPhone: ['breeder phone', 'seller phone', 'kennel phone'],
  breederAddress: ['breeder address', 'seller address', 'kennel address'],
  saleRef: ['sale reference', 'sale ref', 'saleref'],
  buyerName: ['buyer full name', 'buyer name', 'purchaser name', 'buyer', 'purchaser', 'full name'],
  buyerFirstName: ['buyer first name', 'first name'],
  buyerLastName: ['buyer last name', 'last name', 'surname'],
  buyerEmail: ['buyer email', 'email address', 'email', 'e mail'],
  buyerPhone: ['buyer phone', 'phone number', 'phone', 'cell', 'mobile'],
  buyerAddress: ['buyer address', 'mailing address', 'home address', 'address'],
  puppyName: ['puppy name', 'puppy call name', 'pup name', 'call name', 'puppy'],
  puppyRegisteredName: ['puppy registered name', 'registered name'],
  puppySex: ['puppy sex', 'puppy gender', 'sex', 'gender'],
  puppyColor: ['puppy color', 'color', 'colour', 'markings'],
  puppyDob: ['puppy date of birth', 'date of birth', 'birth date', 'whelp date', 'whelped', 'dob', 'birthday'],
  puppyMicrochip: ['microchip number', 'microchip', 'chip number'],
  breed: ['breed'],
  sireName: ['sire name', 'sire', 'father'],
  damName: ['dam name', 'dam', 'mother'],
  registrationType: ['registration type', 'type of registration', 'registration'],
  price: ['purchase price', 'sale price', 'total price', 'price'],
  depositAmount: ['deposit amount', 'deposit'],
  balanceDue: ['balance due', 'remaining balance', 'balance'],
  studServiceRef: ['stud service reference', 'stud service ref', 'studserviceref'],
  studName: ['stud dog name', 'stud name', 'stud dog', 'stud'],
  studRegisteredName: ['stud registered name'],
  damRegisteredName: ['dam registered name'],
  partnerName: ['owner full name', 'owner name', 'client name', 'full name', 'name'],
  partnerFirstName: ['first name'],
  partnerLastName: ['last name', 'surname'],
  partnerEmail: ['email address', 'email', 'e mail'],
  partnerPhone: ['phone number', 'phone', 'cell', 'mobile'],
  partnerAddress: ['mailing address', 'address'],
  studFee: ['stud fee', 'breeding fee', 'fee'],
  serviceType: ['service type', 'breeding type', 'type of breeding'],
  dogName: ['dog name', 'name of dog', 'call name'],
  dogRegisteredName: ['dog registered name', 'registered name'],
  dogSex: ['dog sex', 'sex', 'gender'],
  dogDob: ['dog date of birth', 'date of birth', 'birth date', 'dob'],
  dogMicrochip: ['microchip number', 'microchip'],
  leaseStart: ['lease start date', 'lease start', 'start date'],
  leaseEnd: ['lease end date', 'lease end', 'end date']
};

const norm = (s) => ` ${text(s).toLowerCase().replace(/[’']s\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim()} `;

// The facts a form type fills, in PREFILL_FIELDS order (no repeats): [[fact, what]].
export function factsFor(formType) {
  const seen = new Set();
  return ['every', ...fieldGroupsFor(formType)]
    .flatMap((g) => PREFILL_FIELDS[g])
    .filter(([k]) => !seen.has(k) && seen.add(k));
}

// How well one of her fields fits one fact (0 = not at all).
function score(fact, field) {
  const base = field.param.replace(/\[.*$/, '');
  if (!field.part && base.toLowerCase() === fact.toLowerCase()) return 1000; // she already used our fixed name
  const isFirst = /FirstName$/.test(fact); const isLast = /LastName$/.test(fact);
  // Her own details only go where the label says so (Seller…, Breeder…): a bare
  // Name / Email field is the other party's.
  const ours = /^breeder/.test(fact);
  const saysOurs = /\b(breeder|seller|kennel)\b/.test(norm(field.label));
  // A Full Name field's parts only take first / last names, and nothing else does.
  if (field.part === 'first' || field.part === 'last') {
    if (!(isFirst || isLast)) return 0;
    if ((isFirst && field.part !== 'first') || (isLast && field.part !== 'last')) return 0;
    if (ours) return saysOurs ? 80 : 0;
    const person = fact.replace(/(First|Last)Name$/, '');
    return saysOurs ? 0 : 60 + (norm(field.label).includes(` ${person} `) ? 20 : 0);
  }
  if (field.part === 'addr_line1') {
    if (!/Address$/.test(fact) || ours !== saysOurs) return 0;
    return ours ? 80 : 60 + (norm(field.label).includes(` ${fact.replace(/Address$/, '')} `) ? 20 : 0);
  }
  if (/^(buyer|partner)/.test(fact) && saysOurs) return 0;
  const isEmail = /Email$/.test(fact); const isPhone = /Phone$/.test(fact);
  if (field.type === 'control_email' && !isEmail) return 0;
  if (field.type === 'control_phone' && !isPhone) return 0;
  const label = norm(field.label);
  let best = 0;
  (PHRASES[fact] || []).forEach((p, i) => {
    if (label.includes(` ${p} `)) best = Math.max(best, 20 + p.split(' ').length * 10 - i + (label.trim() === p ? 15 : 0));
  });
  if (!best && !ours && isEmail && field.type === 'control_email') best = 25;
  if (!best && !ours && isPhone && field.type === 'control_phone') best = 25;
  if (best && ((isEmail && field.type === 'control_email') || (isPhone && field.type === 'control_phone'))) best += 30;
  return best;
}

// Suggest a field for each fact of this form type. Each of her fields fills at
// most one fact, best matches first. → { field_map: { fact: param }, warnings: [] }.
export function suggestFieldMap(formType, questions) {
  const fields = formFields(questions);
  const facts = factsFor(formType).map(([k]) => k);
  const pairs = [];
  for (const fact of facts) for (const field of fields) {
    const s = score(fact, field);
    if (s > 0) pairs.push({ fact, param: field.param, s });
  }
  pairs.sort((a, b) => b.s - a.s);
  const map = {}; const used = new Set();
  for (const { fact, param } of pairs) {
    if (fact in map || used.has(param)) continue;
    map[fact] = param; used.add(param);
  }
  return { field_map: map, warnings: matchWarnings(formType, questions, map) };
}

// What to tell her about a form, given the map she's about to save.
export function matchWarnings(formType, questions, map = {}) {
  const out = [];
  if (!hasSignature(questions)) out.push('This form has no signature field.');
  const sale = fieldGroupsFor(formType).includes('sale');
  const email = sale ? 'buyerEmail' : 'partnerEmail';
  if (!map[email]) out.push(`Nothing is matched to the ${sale ? 'buyer\'s' : 'other party\'s'} email.`);
  if (!map.contractRef) out.push('Nothing is matched to the contract reference. Add a hidden field for it if you want signed forms to be matched to their contract automatically later.');
  return out;
}

// A first guess at a form's contract type from its title ("Pet Home Contract",
// "Stud Service Agreement"…), or '' to make her pick.
export function guessFormType(title) {
  const t = norm(title);
  const rules = [
    ['co_own', /\bco ?own/], ['stud_service', /\bstud\b/], ['lease', /\blease\b/],
    ['foster', /\b(foster|guardian)\b/], ['breeding_rights', /\b(breeding rights|full registration|breeding)\b/],
    ['deposit', /\b(deposit|reservation|reserve)\b/], ['pet_home', /\b(pet|companion|limited|puppy)\b/]
  ];
  for (const [type, re] of rules) if (re.test(t)) return type;
  return '';
}
