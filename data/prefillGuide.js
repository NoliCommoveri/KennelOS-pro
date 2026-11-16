// prefillGuide.js — the Field guide's rows (pure): every detail KennelOS fills on a
// contract, by its label in Firma's editor (contractForms.FIRMA_LABELS), which
// contracts fill it (contractForms.fieldGroupsFor), how its value is worked out, and
// an example value. The examples are what prefillValues gives for a made-up sale, stud
// service and lease (EXAMPLE_*), so they're always what a real send would put there.
//
//   guideRows()     → [{ name, label, groups: [group key], how, says, example,
//                     examples: { [group key]: value } }], one per fact, in PREFILL_FIELDS
//                     order (by type); A–Z is the caller's sort. `example`: the first
//                     group's that has one; `says`: the field list's own words.
//   GUIDE_GROUPS    the groups in order: { key, title, fills } (which contracts fill it).
//   EXAMPLE_STORY   the made-up records, in words, for the guide's header.
import { PREFILL_FIELDS, FIRMA_LABELS, prefillValues } from './contractForms.js';
import { addOnFacts } from './contractAddOns.js';
import { paymentStatement } from './paymentSchedule.js';
import { priceTable, incomeLineItems, paidOnSale } from './incomeView.js';

export const GUIDE_GROUPS = Object.freeze([
  { key: 'every', title: 'Every contract', fills: 'Every contract' },
  { key: 'sale', title: 'Sale', fills: 'Every contract on a sale' },
  { key: 'transport', title: 'Transport', fills: 'Contracts on a sale with a transport fee' },
  { key: 'boarding', title: 'Boarding', fills: 'Contracts on a sale with deferred pickup boarding' },
  { key: 'extra', title: 'Extra', fills: 'Extra agreements (the extra the template is for)' },
  { key: 'stud_service', title: 'Stud service', fills: 'Stud service contracts' },
  { key: 'dog', title: 'Dog', fills: 'Co-own, lease, foster and Other contracts about a dog' }
]);

const nth = ['first', 'second', 'third', 'fourth'];

// How a value is worked out, where the field list's own words (PREFILL_FIELDS) don't
// say enough. Keyed by fact; a fact in two groups reads right in both.
const HOW = {
  contractTitle: 'The contract\'s title, else its type (e.g. Sale).',
  contractDate: 'The day you send it.',
  kennelName: 'From your kennel (Kennels page).',
  kennelLocation: 'From your kennel (Kennels page).',
  kennelWebsite: 'From your kennel (Kennels page).',
  breederName: 'From the contact linked to your kennel.',
  breederFirstName: 'The contact linked to your kennel: the name before its last space.',
  breederLastName: 'The contact linked to your kennel: the last word of the name.',
  breederEmail: 'From the contact linked to your kennel.',
  breederPhone: 'From the contact linked to your kennel.',
  breederAddress: 'From the contact linked to your kennel.',
  buyerName: 'From the buyer\'s contact on the sale.',
  buyerFirstName: 'The buyer\'s name before its last space.',
  buyerLastName: 'The last word of the buyer\'s name.',
  buyerEmail: 'From the buyer\'s contact on the sale.',
  buyerPhone: 'From the buyer\'s contact on the sale.',
  buyerAddress: 'From the buyer\'s contact on the sale.',
  puppyName: 'From the pup\'s record.',
  puppyRegisteredName: 'From the pup\'s record.',
  puppySex: 'From the pup\'s record: Male or Female.',
  puppyColor: 'From the pup\'s record.',
  puppyDob: 'From the pup\'s record.',
  puppyMicrochip: 'From the pup\'s record.',
  breed: 'From the pup\'s record (on a dog contract, the dog\'s).',
  sireName: 'The sire\'s registered name, else its call name.',
  damName: 'On a sale, the dam\'s registered name, else its call name. On a stud service, the dam\'s call name.',
  registrationType: 'The sale\'s Registration: Limited, Full, Co-own or None.',
  pickupDate: 'The pup\'s next pickup for this family on your calendar, else its latest, else the litter\'s estimated ready date (8 weeks after whelping when none is set).',
  price: 'The sale\'s Price, as entered. When the price was prefilled for a Full registration, the surcharge is already in it.',
  depositAmount: 'The sale\'s Deposit amount: the whole deposit, nothing taken off.',
  balanceDue: 'Everything on the sale (price, transport, boarding, extras) less everything paid or credited on it.',
  depositDue: 'The deposit, less the application fee and credits counted toward it. 0.00 once the deposit is marked received.',
  otherPaymentsReceived: 'Money toward the price beyond the deposit: payments recorded on the sale, credits for funds received, and the application fee when it isn\'t counted toward the deposit.',
  purchaseBalanceDue: 'The price less the deposit and Other payments and credits. Price only: no transport, boarding or extras. So Price = Deposit + Other payments and credits + this.',
  totalCharges: 'Every charge on the sale added up, nothing paid taken off: price, boarding, extras, fees passed on and transport.',
  paidToDate: 'Everything received on the sale: the deposit, payments, credits for funds received and the application fee credited.',
  payment1Amount: 'From the sale\'s payment schedule: the first due date before the final one. What it still asks for after the money already toward it, so 0.00 once it\'s met. Blank with no schedule.',
  payment1Due: 'That due date. Blank while it can\'t be known yet (e.g. "at pickup" with no pickup date).',
  payment2Amount: 'From the sale\'s payment schedule: the second due date before the final one, worked out the same way. Blank when there isn\'t one.',
  payment2Due: 'That due date. Blank while it can\'t be known yet.',
  finalPaymentAmount: 'What the final payment still asks for: everything left on the sale after the earlier due dates and the money already paid.',
  finalPaymentDue: 'The final payment\'s date. With no schedule, the sale\'s balance due date, else pickup.',
  transportFee: 'The sale\'s Transport fee.',
  deliveryDate: 'The pup\'s next pickup or drop-off for this sale on your calendar, else its latest.',
  deliveryPlace: 'The location on that pickup or drop-off.',
  transportDueDate: 'With a payment schedule, the final payment\'s date (transport is always paid last). Without one, the sale\'s balance due date.',
  boardingRate: 'The sale\'s Deferred pickup boarding rate.',
  boardingPer: 'The rate\'s per: Day, Week or Month.',
  boardingLength: 'How many days, weeks or months the sale\'s boarding is for.',
  boardingTotal: 'The rate times the length.',
  boardingStart: 'The day the pup could go home: the litter\'s ready date, or the day after its last training stay.',
  boardingEnd: 'The day before the pickup on your calendar, else counted from the start by the length.',
  extraName: 'The extra\'s name on the sale (the one this template is for).',
  extraDescription: 'Its description on your price list.',
  extraPrice: 'The extra\'s amount on the sale.',
  priceWithExtra: 'The sale\'s Price plus this extra\'s amount. Nothing paid is taken off.',
  extraPayments: 'The extra\'s payment plan in words: its share of each due date, or its own steps.',
  extraStayDays: 'The days the pup stays for it (a training package).',
  extraStayStart: 'The stay\'s first day: as logged on the calendar, else from the ready date.',
  extraStayEnd: 'The stay\'s last day.',
  studName: 'The stud dog\'s call name.',
  studRegisteredName: 'The stud dog\'s registered name.',
  damRegisteredName: 'The dam\'s registered name.',
  partnerName: 'From the other party\'s contact.',
  partnerFirstName: 'The other party\'s name before its last space.',
  partnerLastName: 'The last word of the other party\'s name.',
  partnerEmail: 'From the other party\'s contact.',
  partnerPhone: 'From the other party\'s contact.',
  partnerAddress: 'From the other party\'s contact.',
  studFee: 'The stud service\'s fee.',
  serviceType: 'The stud service\'s type: In person or AI / shipped.',
  dogName: 'From the dog\'s record.',
  dogRegisteredName: 'From the dog\'s record.',
  dogSex: 'From the dog\'s record: Male or Female.',
  dogDob: 'From the dog\'s record.',
  dogMicrochip: 'From the dog\'s record.',
  leaseStart: 'The contract\'s lease start (lease contracts only).',
  leaseEnd: 'The contract\'s lease end (lease contracts only).'
};
for (let i = 1; i <= 4; i++) {
  HOW[`extraPayment${i}Amount`] = `The extra's ${nth[i - 1]} payment: its amount.`;
  HOW[`extraPayment${i}Due`] = `The extra's ${nth[i - 1]} payment: when it's due.`;
}

// --- The made-up records the examples come from -------------------------------------

const TODAY = '2026-10-20';
const BIRTH = '2026-09-01';
const breeder = { name: 'Sam Rivera', email: 'sam@mapleridge.example', phone: '555-0100', address: '12 Maple Rd, Asheville, NC' };
const kennel = { kennel_name: 'Maple Ridge Kennel', location: 'Asheville, NC', website: 'mapleridge.example' };
const partner = { name: 'Casey Morgan', email: 'casey@example.com', phone: '555-0177', address: '9 Elm Ct, Greenville, SC' };
const exampleSale = {
  id: '3f6c1b2e-8d4a-4c7e-9b1f-2a5d6e7c8b90', dog_id: 'pup', buyer_contact_id: 'buyer', status: 'deposit_paid',
  registration_type: 'limited', price: 3000, deposit_amount: 500, deposit_date: '2026-09-20',
  transport_fee: 450, deferred_boarding_amount: 25, deferred_boarding_frequency: 'Day', deferred_boarding_duration_days: '5',
  extra_charges: [{ id: 'x1', list_id: 'training', label: '2-week training', amount: 600, boarding_days: 14 }],
  payment_schedule: [
    { id: 'half', due: 'at_weeks', n: 8, covers: ['price', 'extras'], percent: 50, basis: 'total' },
    { id: 'final', due: 'at_pickup', covers: ['all'], percent: 100, basis: 'total' }
  ],
  payments: [{ id: 'p1', amount: 400, date: '2026-10-05', method: 'Zelle' }]
};
const pickup = { subject_type: 'dog', subject_id: 'pup', event_type: 'placement', event_date: '2026-11-24', related_contact_id: 'buyer',
  details: { location: 'RDU airport', sale_id: exampleSale.id } };

export const EXAMPLE_STORY = 'Examples come from a made-up sale: Bella, a female Boston Terrier born 2026-09-01, sold to Jordan Lee for $3,000 on Limited registration. '
  + 'The $500 deposit is paid and a $400 payment came in. The sale has $450 transport, boarding at $25 a day for 5 days and a $600 2-week training package. '
  + 'Its schedule asks for 50% of the price and extras by 8 weeks, and the rest at pickup on 2026-11-24. '
  + 'Stud service examples are a $1,500 in-person breeding; dog examples, a lease of Rosie.';

function saleFacts() {
  const s = exampleSale;
  const litter = { whelp_date: BIRTH, estimated_ready_date: '2026-10-27' };
  const priceList = [{ id: 'training', label: '2-week training', amount: 600, boarding_days: 14, description: 'Crate and potty basics' }];
  const addOns = addOnFacts({ sale: s, events: [pickup], litter, priceList, today: TODAY });
  const statement = paymentStatement(s, { birthDate: BIRTH, pickupDate: addOns.pickupDate, today: TODAY });
  const total = incomeLineItems('sale', s).reduce((t, x) => t + x.amount, 0);
  return {
    contract: { id: '8a2d4f60-1c3b-4e9a-b7d5-6f0e2c9a1b34', title: 'Pet home contract', contract_type: 'sale' },
    kennel, breeder, today: TODAY, sale: s,
    puppy: { call_name: 'Bella', registered_name: 'Maple Ridge\'s Bella Rose', sex: 'female', color_markings: 'Brindle & white', date_of_birth: BIRTH, microchip_id: '985112004567890', breed: 'Boston Terrier' },
    pickupDate: addOns.pickupDate,
    balanceDue: Math.max(0, total - paidOnSale(s)),
    priceTable: priceTable(s),
    statement, addOns,
    buyer: { name: 'Jordan Lee', email: 'jordan@example.com', phone: '555-0142', address: '48 Oak St, Raleigh, NC' },
    sire: { call_name: 'Duke', registered_name: 'Maple Ridge\'s Iron Duke' },
    dam: { call_name: 'Rosie', registered_name: 'Maple Ridge\'s Rosie Belle' }
  };
}

const studFacts = () => ({
  contract: { id: '5b7e9c1d-2f4a-4d6b-8e0c-3a1f5d7b9e22', contract_type: 'stud_service' }, kennel, breeder, today: TODAY,
  studService: { id: 'c1e3a5b7-9d2f-4b6a-8c0e-1f3d5b7a9c44', fee_amount: 1500, type: 'in_person' },
  studDog: { call_name: 'Duke', registered_name: 'Maple Ridge\'s Iron Duke' },
  studDam: { call_name: 'Daisy', registered_name: 'Oakhill Daisy Mae' },
  partner
});

const dogFacts = () => ({
  contract: { id: '9d1f3b5c-7e2a-4c8d-b6f0-4e2a8c6d0f11', contract_type: 'lease', lease_start_date: '2026-11-01', lease_end_date: '2027-11-01' },
  kennel, breeder, today: TODAY,
  dog: { call_name: 'Rosie', registered_name: 'Maple Ridge\'s Rosie Belle', sex: 'female', date_of_birth: '2023-04-12', microchip_id: '985112009876543', breed: 'Boston Terrier' },
  partner
});

// Each group's example values: the sale's groups from an Extra agreement on the
// example sale (it fills every sale group), stud service and dog from their own.
function examples() {
  const sale = Object.fromEntries(prefillValues({ form_type: 'extra', extra_list_id: 'training' }, saleFacts()));
  return {
    every: sale, sale, transport: sale, boarding: sale, extra: sale,
    stud_service: Object.fromEntries(prefillValues('stud_service', studFacts())),
    dog: Object.fromEntries(prefillValues('lease', dogFacts()))
  };
}

let cached = null;
export function guideRows() {
  if (cached) return cached;
  const ex = examples();
  const byName = new Map();
  for (const g of GUIDE_GROUPS) {
    for (const [name, says] of PREFILL_FIELDS[g.key] || []) {
      const had = byName.get(name);
      const value = ex[g.key]?.[name] || '';
      if (had) { had.groups.push(g.key); had.examples[g.key] = value; had.example ||= value; continue; }
      byName.set(name, { name, label: FIRMA_LABELS[name] || says, groups: [g.key], how: HOW[name] || says, says, example: value, examples: { [g.key]: value } });
    }
  }
  cached = [...byName.values()];
  return cached;
}
