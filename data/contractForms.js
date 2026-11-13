// contractForms.js — her contract forms (pasted links, Integrations plan §2.1a, D28) and
// the prefilled link that sends one out for signature.
//
// She keeps the forms on a Form service Account (`contract_forms`: [{ id, form_type, label,
// url }], D6 / D12; a Firma template is { id, form_type, label, provider: 'firma',
// template_id } instead, D30), each tagged with a CONTRACT_FORM_TYPE so the Contract page
// can offer the right one. "Send for signature" builds the form's URL with the
// contract's facts as query parameters — the prefill most form services document — on her
// device: no API call, no server. The parameter names are fixed (PREFILL_FIELDS,
// D14): she gives her form's fields those names, and any field her form
// doesn't have is simply ignored by the form.
//
// A prefilled link carries its values in the URL, so only short facts go in it,
// never private notes, terms or end reasons (§2.1). This list IS that allow-list.
// Pure: no db, no DOM. The callers read the records.
import { CONTRACT_FORM_TYPE, CONTRACT_TYPE, REGISTRATION_TYPE, SEX, STUD_SERVICE_TYPE, descriptor } from './vocab.js';
import { extraFor, extraPayments } from './contractAddOns.js';
import { finalDueDate } from './paymentSchedule.js';

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

// A Firma template of hers (Integrations plan §2.3a, D30): kept on an Account's
// contract_forms like a pasted form, but with Firma's template id and no link.
// Her device sends it through the Worker (data/cloud/cloudEsign.js), never as a link.
const TEMPLATE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const isFirmaForm = (f) => f?.provider === 'firma' && TEMPLATE_ID.test(text(f.template_id));

// An Account's saved forms, cleaned: a known type, a usable link, a label (the
// type's name when she left it blank). Older backups have no field: [].
// A form once picked through Connect Jotform (retired, D27/D29) also keeps its Jotform
// `form_id` and the `field_map` she confirmed (cleanFieldMap); a pasted one has
// neither and fills our fixed names.
// An Extra agreement is for one of her price-list extras: the row's id. Other kinds carry none.
const EXTRA_ID = /^[A-Za-z0-9_-]{1,64}$/;
function withExtra(row, f) {
  if (f.form_type === 'extra' && EXTRA_ID.test(text(f.extra_list_id))) row.extra_list_id = text(f.extra_list_id);
  return row;
}

export function cleanForms(list) {
  return (Array.isArray(list) ? list : [])
    .filter((f) => f && FORM_TYPES.has(f.form_type) && (isFirmaForm(f) || formLink(f.url)))
    .map((f) => {
      if (isFirmaForm(f)) {
        const row = {
          id: text(f.id) || crypto.randomUUID(), form_type: f.form_type,
          label: text(f.label) || descriptor(CONTRACT_FORM_TYPE, f.form_type).label,
          provider: 'firma', template_id: text(f.template_id)
        };
        // She signs it too, after the buyer (Integrations D32). Absent = buyer only.
        // countersign_first: she signs before the buyer instead (only with countersign).
        if (f.countersign === true) row.countersign = true;
        if (f.countersign === true && f.countersign_first === true) row.countersign_first = true;
        // KennelOS keeps the signed PDF and emails the buyer a link (D33). Absent = no.
        if (f.keep_copy === true) row.keep_copy = true;
        withExtra(row, f);
        return row;
      }
      const out = {
        id: text(f.id) || crypto.randomUUID(),
        form_type: f.form_type,
        label: text(f.label) || descriptor(CONTRACT_FORM_TYPE, f.form_type).label,
        url: formLink(f.url)
      };
      withExtra(out, f);
      if (/^\d{1,30}$/.test(text(f.form_id))) out.form_id = text(f.form_id);
      const map = cleanFieldMap(f.field_map);
      if (map) out.field_map = map;
      return out;
    });
}

// Every fact name a link can carry (PREFILL_FIELDS, all groups).
const FACTS = () => new Set(Object.values(PREFILL_FIELDS).flat().map(([k]) => k));
// A parameter of hers: a Jotform unique name, or a part of one ("name[first]").
const PARAM = /^[A-Za-z0-9_-]{1,80}(\[[A-Za-z0-9_]{1,30}\])?$/;

// { <our fact>: <her parameter> } with unknown facts and odd names dropped, or
// null when it isn't a map at all. An empty map is kept: it means "fill nothing".
export function cleanFieldMap(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const facts = FACTS();
  const out = {};
  for (const [k, v] of Object.entries(map)) if (facts.has(k) && PARAM.test(text(v))) out[k] = text(v);
  return out;
}

// The values renamed to her fields. With no map (a pasted form), every value goes
// under our fixed name. With a map (a form matched through Connect Jotform), only
// the facts she matched go, so nothing is put in the link that her form won't
// show.
export function mapValues(values, fieldMap) {
  const map = cleanFieldMap(fieldMap);
  if (!map) return values || [];
  return (values || []).filter(([k]) => map[k]).map(([k, v]) => [map[k], v]);
}

// Every saved form across her Form service accounts (archived ones, and forms
// left on an account whose type was changed, left out), each with its account's
// id and name.
export function allForms(accounts) {
  return (accounts || [])
    .filter((a) => a && !a.is_archived && a.account_type === 'form_service')
    .flatMap((a) => cleanForms(a.contract_forms).map((f) => ({ ...f, account_id: a.id, account_name: text(a.name) })));
}

// Does the sale have what this separate agreement is for? Its transport fee, its
// deferred-pickup boarding, or the extra the form is for: the same match the form
// fills from (contractAddOns.extraFor) when the sale's `addOns` are given, else a
// charge copied from that price-list row.
export function addOnApplies(form, addOn, sale, addOns = null) {
  if (!sale) return false;
  if (addOn === 'transport') return Number(sale.transport_fee) > 0;
  if (addOn === 'boarding') return Number(sale.deferred_boarding_amount) > 0;
  if (addOn !== 'extra' || !form.extra_list_id) return false;
  if (addOns) return Boolean(extraFor(addOns, form.extra_list_id));
  return (Array.isArray(sale.extra_charges) ? sale.extra_charges : []).some((c) => c && c.list_id === form.extra_list_id);
}

// Which of a sale's agreements a form is: '' = its main contract, else the separate
// agreement ('transport', 'boarding', 'extra:<price-list row id>'). Each separate
// agreement goes out on a contract record of its own (contractSend.contractForForm).
export function agreementKey(form) {
  const addOn = descriptor(CONTRACT_FORM_TYPE, form?.form_type).addOn;
  if (!addOn) return '';
  return addOn === 'extra' ? `extra:${text(form.extra_list_id)}` : addOn;
}

// The forms for one contract, best first: `matching` = forms whose type serves
// this contract_type, ranked by fit to the linked sale (pet home for a limited
// registration, breeding rights for full, deposit while it's pending), then
// label; `others` = the rest, for "Show all forms". `addOns`: the sale's
// contractAddOns.addOnFacts, when the caller has them.
export function rankForms(forms, contract, sale = null, addOns = null) {
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
    // A separate agreement (transport, boarding, one extra) only when the sale has it.
    const fits = (t.contractTypes || []).includes(contract?.contract_type) && (!t.addOn || addOnApplies(f, t.addOn, sale, addOns));
    (fits ? matching : others).push(f);
  }
  // The sale's own contract first, then its separate agreements.
  const apart = (f) => (descriptor(CONTRACT_FORM_TYPE, f.form_type).addOn ? 1 : 0);
  matching.sort((a, b) => apart(a) - apart(b) || fit(b) - fit(a) || order.get(a.form_type) - order.get(b.form_type) || byLabel(a, b));
  others.sort((a, b) => order.get(a.form_type) - order.get(b.form_type) || byLabel(a, b));
  return { matching, others };
}

// The parameter names a form can use, by group, with what each holds. Shown on
// the Accounts page (Copy) so she can name her form's fields.
export const PREFILL_FIELDS = {
  every: [
    ['contractRef', 'This contract\'s reference (make it a hidden field)'],
    ['contractTitle', 'Contract title'],
    ['contractDate', 'Today\'s date (YYYY-MM-DD)'],
    ['kennelName', 'Your kennel\'s name'],
    ['kennelLocation', 'Your kennel\'s location'],
    ['kennelWebsite', 'Your kennel\'s website'],
    ['breederName', 'Your full name (the contact linked to your kennel)'],
    ['breederFirstName', 'Your first name'],
    ['breederLastName', 'Your last name'],
    ['breederEmail', 'Your email'],
    ['breederPhone', 'Your phone'],
    ['breederAddress', 'Your address']
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
    ['pickupDate', 'Estimated pickup date (the pickup on your calendar, else the litter\'s ready date)'],
    ['price', 'Price (the total purchase price, with any Full registration surcharge)'],
    ['depositAmount', 'Deposit'],
    ['balanceDue', 'Balance still due (everything on the sale: with transport, boarding and extras)'],
    ['depositDue', 'Deposit still due (the deposit, less the application fee and credits counted toward it)'],
    ['otherPaymentsReceived', 'Credits and payments toward the balance, beyond what covered the deposit'],
    ['purchaseBalanceDue', 'Balance of the purchase price due at pickup (the price only)'],
    ['totalCharges', 'Everything on the sale (price, transport, boarding and extras)'],
    ['paidToDate', 'Paid to date: deposit, payments, credits for funds received and the fee credited, on the sale'],
    ['payment1Amount', 'First payment before the final one: what\'s still owed by it (blank with no schedule)'],
    ['payment1Due', 'First payment\'s due date'],
    ['payment2Amount', 'Second payment before the final one: what\'s still owed by it'],
    ['payment2Due', 'Second payment\'s due date'],
    ['finalPaymentAmount', 'Final payment: what\'s still owed by it'],
    ['finalPaymentDue', 'Final payment\'s due date']
  ],
  transport: [
    ['transportFee', 'Transport fee'],
    ['deliveryDate', 'Delivery / pickup date (the one on your calendar)'],
    ['deliveryPlace', 'Delivery / pickup place'],
    ['transportDueDate', 'When the transport fee is due (with the final payment; without a schedule, the balance due date)']
  ],
  boarding: [
    ['boardingRate', 'Boarding rate'],
    ['boardingPer', 'Boarding rate per (Day, Week, Month)'],
    ['boardingLength', 'How long (e.g. 2 weeks)'],
    ['boardingTotal', 'Boarding total'],
    ['boardingStart', 'Boarding starts (the day the pup could go home, after any training stay)'],
    ['boardingEnd', 'Boarding ends (the day before pickup)']
  ],
  extra: [
    ['extraName', 'The extra this agreement is for, as on the sale (e.g. 2-week training)'],
    ['extraDescription', 'Its description from your price list'],
    ['extraPrice', 'Its price'],
    ['extraPayments', 'Its payment plan, in words (e.g. 50% (300.00) due 2026-12-01; 50% (300.00) with the balance)'],
    ['extraPayment1Amount', 'First payment'], ['extraPayment1Due', 'First payment due'],
    ['extraPayment2Amount', 'Second payment'], ['extraPayment2Due', 'Second payment due'],
    ['extraPayment3Amount', 'Third payment'], ['extraPayment3Due', 'Third payment due'],
    ['extraPayment4Amount', 'Fourth payment'], ['extraPayment4Due', 'Fourth payment due'],
    ['extraStayDays', 'Days the pup stays for it (a training package)'],
    ['extraStayStart', 'Its stay starts (as logged; else from the ready date)'],
    ['extraStayEnd', 'Its stay ends']
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

// Each fact's label in Firma's template editor (her workspace's custom fields,
// cloudEsign.factFields): a group prefix, then a short name, so the fields sort into
// groups in the editor's list (Payment Schedule plan §8.2, D15). Only the label shows
// there; the field's name (the fact) never changes, so a field already placed keeps
// filling. A fact shared by two groups (damName, breed, partner…) reads right in both.
export const FIRMA_LABELS = {
  contractRef: 'Contract · Reference (hidden)', contractTitle: 'Contract · Title', contractDate: 'Contract · Date',
  kennelName: 'Kennel · Name', kennelLocation: 'Kennel · Location', kennelWebsite: 'Kennel · Website',
  breederName: 'Breeder · Full name', breederFirstName: 'Breeder · First name', breederLastName: 'Breeder · Last name',
  breederEmail: 'Breeder · Email', breederPhone: 'Breeder · Phone', breederAddress: 'Breeder · Address',
  saleRef: 'Sale · Reference (hidden)',
  buyerName: 'Buyer · Full name', buyerFirstName: 'Buyer · First name', buyerLastName: 'Buyer · Last name',
  buyerEmail: 'Buyer · Email', buyerPhone: 'Buyer · Phone', buyerAddress: 'Buyer · Address',
  puppyName: 'Pup · Call name', puppyRegisteredName: 'Pup · Registered name', puppySex: 'Pup · Sex',
  puppyColor: 'Pup · Color / markings', puppyDob: 'Pup · Date of birth', puppyMicrochip: 'Pup · Microchip',
  breed: 'Pup or dog · Breed', sireName: 'Sire · Name', damName: 'Dam · Name',
  registrationType: 'Sale · Registration', pickupDate: 'Sale · Pickup date', price: 'Sale · Price',
  depositAmount: 'Sale · Deposit', balanceDue: 'Sale · Balance still due', depositDue: 'Sale · Deposit still due',
  otherPaymentsReceived: 'Sale · Other payments and credits', purchaseBalanceDue: 'Sale · Price balance due at pickup',
  totalCharges: 'Sale · Total charges', paidToDate: 'Sale · Paid to date',
  payment1Amount: 'Payment · 1st amount', payment1Due: 'Payment · 1st due date',
  payment2Amount: 'Payment · 2nd amount', payment2Due: 'Payment · 2nd due date',
  finalPaymentAmount: 'Payment · Final amount', finalPaymentDue: 'Payment · Final due date',
  transportFee: 'Transport · Fee', deliveryDate: 'Transport · Delivery date', deliveryPlace: 'Transport · Delivery place',
  transportDueDate: 'Transport · Fee due date',
  boardingRate: 'Boarding · Rate', boardingPer: 'Boarding · Rate per', boardingLength: 'Boarding · Length',
  boardingTotal: 'Boarding · Total', boardingStart: 'Boarding · Start date', boardingEnd: 'Boarding · End date',
  extraName: 'Extra · Name', extraDescription: 'Extra · Description', extraPrice: 'Extra · Price', extraPayments: 'Extra · Payment plan',
  extraPayment1Amount: 'Extra · 1st payment', extraPayment1Due: 'Extra · 1st payment due',
  extraPayment2Amount: 'Extra · 2nd payment', extraPayment2Due: 'Extra · 2nd payment due',
  extraPayment3Amount: 'Extra · 3rd payment', extraPayment3Due: 'Extra · 3rd payment due',
  extraPayment4Amount: 'Extra · 4th payment', extraPayment4Due: 'Extra · 4th payment due',
  extraStayDays: 'Extra · Stay days', extraStayStart: 'Extra · Stay start', extraStayEnd: 'Extra · Stay end',
  studServiceRef: 'Stud service · Reference (hidden)', studName: 'Stud · Name', studRegisteredName: 'Stud · Registered name',
  damRegisteredName: 'Dam · Registered name', studFee: 'Stud service · Fee', serviceType: 'Stud service · Type',
  partnerName: 'Other party · Full name', partnerFirstName: 'Other party · First name', partnerLastName: 'Other party · Last name',
  partnerEmail: 'Other party · Email', partnerPhone: 'Other party · Phone', partnerAddress: 'Other party · Address',
  dogName: 'Dog · Call name', dogRegisteredName: 'Dog · Registered name', dogSex: 'Dog · Sex', dogDob: 'Dog · Date of birth',
  dogMicrochip: 'Dog · Microchip', leaseStart: 'Lease · Start date', leaseEnd: 'Lease · End date'
};

// Which groups a form type fills, after `every`.
export function fieldGroupsFor(formType) {
  if (formType === 'stud_service') return ['stud_service'];
  if (['lease', 'foster', 'other'].includes(formType)) return ['dog'];
  if (formType === 'co_own') return ['sale', 'dog'];
  if (['transport', 'boarding', 'extra'].includes(formType)) return ['sale', formType];
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

// The sale's payment schedule on a contract (Payment Schedule plan §8.1, D11), from its
// payment statement (paymentSchedule.paymentStatement), so the contract says what the
// Payments card says. totalCharges / paidToDate: the statement's total and paid (the
// sale's own charges; money on them from the deposit, payments, credits for funds
// received and the application fee credited; a credit's leftover or the part that paid
// the fee itself isn't on the sale). payment1 / payment2: the first two due dates before
// the final one; finalPayment: the last. Each amount is what's still owed by that due
// date (its ask less the money it took, so 0.00 once met); its date, YYYY-MM-DD, is left
// out while it can't be known. A returned, cancelled or voided sale has no due dates.
function scheduleValues(st) {
  if (!st) return [];
  const out = [['totalCharges', money(st.total)], ['paidToDate', money(st.paid)]];
  const dueDates = st.dueDates || [];
  dueDates.filter((d) => !d.isFinal).slice(0, 2).forEach((d, i) => out.push([`payment${i + 1}Amount`, money(d.owed)], [`payment${i + 1}Due`, text(d.date)]));
  const last = dueDates.find((d) => d.isFinal);
  if (last) out.push(['finalPaymentAmount', money(last.owed)], ['finalPaymentDue', text(last.date)]);
  return out;
}

// The facts to prefill for a form (or a bare form type), as [[name, value]] in
// PREFILL_FIELDS order, empties dropped. An Extra agreement fills from the extra
// its row names (`extra_list_id`). `facts` holds the records the contract reaches (the caller reads
// them): { contract, kennel, breeder, sale, buyer, puppy, sire, dam, balanceDue, priceTable, pickupDate,
// statement (the sale's payment statement, incomeView.getSaleStatement), addOns (contractAddOns.addOnFacts),
// studService, studDog, studDam, partner, dog, today }.
export function prefillValues(formOrType, facts = {}) {
  const form = typeof formOrType === 'string' ? { form_type: formOrType } : (formOrType || {});
  const formType = form.form_type;
  const f = facts;
  const c = f.contract || {};
  const out = [
    ['contractRef', text(c.id)],
    ['contractTitle', text(c.title) || label(CONTRACT_TYPE, c.contract_type)],
    ['contractDate', text(f.today)],
    ['kennelName', text(f.kennel?.kennel_name)],
    ['kennelLocation', text(f.kennel?.location)],
    ['kennelWebsite', text(f.kennel?.website)],
    // Her own name and details: the contact linked to the kennel (contractSend.breederFor).
    ...person('breeder', f.breeder)
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
      ['pickupDate', text(f.pickupDate)],
      ['price', money(s.price)], ['depositAmount', money(s.deposit_amount)], ['balanceDue', money(f.balanceDue)],
      // Her contract's payment table (contractSend: incomeView.priceTable).
      ['depositDue', money(f.priceTable?.depositDue)],
      ['otherPaymentsReceived', money(f.priceTable?.otherPaid)], ['purchaseBalanceDue', money(f.priceTable?.balanceDue)],
      ...scheduleValues(f.statement)
    );
  }
  const a = f.addOns;
  if (groups.includes('transport') && a) {
    const t = a.transport;
    // Transport is always paid last (D16), so with a schedule it's due with the final
    // payment: that due date as it stands now, not the balance due date mirrored when
    // the schedule was last saved.
    const st = f.statement;
    const due = st?.hasSchedule && !st.ended ? text(finalDueDate(st)) : text(t.due);
    out.push(['transportFee', money(t.fee)], ['deliveryDate', text(t.date)],
      ['deliveryPlace', text(t.place)], ['transportDueDate', due]);
  }
  if (groups.includes('boarding') && a?.boarding) {
    const b = a.boarding;
    out.push(['boardingRate', money(b.rate)], ['boardingPer', text(b.per)], ['boardingLength', text(b.length)],
      ['boardingTotal', money(b.total)], ['boardingStart', text(b.start)], ['boardingEnd', text(b.end)]);
  }
  const x = groups.includes('extra') ? extraFor(a, form.extra_list_id) : null;
  if (x) {
    const steps = extraPayments(x.charge, f.sale, a.pickupDate || f.pickupDate, f.statement);
    const stepText = (st) => `${st.percent}% (${money(st.amount)}) ${st.due === 'with the balance' ? 'with the balance' : st.due ? `due ${st.due}` : ''}`.trim();
    out.push(['extraName', text(x.charge.label)], ['extraDescription', text(x.row?.description)], ['extraPrice', money(x.charge.amount)],
      ['extraPayments', steps.map(stepText).join('; ')]);
    steps.slice(0, 4).forEach((st, i) => out.push([`extraPayment${i + 1}Amount`, money(st.amount)], [`extraPayment${i + 1}Due`, text(st.due)]));
    if (x.stay) out.push(['extraStayDays', text(x.charge.boarding_days)], ['extraStayStart', text(x.stay.start)], ['extraStayEnd', text(x.stay.end)]);
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
