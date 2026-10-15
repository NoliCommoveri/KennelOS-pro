// prepPups.js — the run-up to go-home day for one litter, the data half (pure).
// Read by Kels's "Pups are going home" (assets/prepPupsUI.js) and by the
// Puppy Record's breeder cover page (pages/puppy-record.js), so both say the
// same thing about what's done and what's missing. No reads or writes here.
//
// Readiness, per pup (READY_ITEMS order; an item that doesn't apply is left out):
//   chip         a microchip number on the dog (optional);
//   litter_reg   the litter's registration number (optional; one answer for the litter);
//   pup_reg      the pup's registered name and registration number (optional; for
//                breeders who register pups before they go);
//   shots        a vaccination logged;
//   deworm       a deworming or flea & tick (`preventative`) logged;
//   pickup       a drop-off date: goHome's `placement` event ("Placement / drop-off") for the
//                sale's family, today or later. It's the only go-home date the app keeps
//                (Furever's pickup fields are the family app's, not counted);
//   balance      the sale paid in full, or its balance-due date set;
//   contract     a signed contract on the sale (Pro, `contracts`);
//   registration the sale's registration type;
//   feeding      a feeding schedule: the litter's override, or one for the pup's breed (Pro,
//                `feedingSchedule`; optional).
// Optional items are checked only when she ticks them (`checks`); many breeders don't
// track them. The sale items (pickup, balance, contract, registration) apply only to a pup
// with a sale. The Furever link isn't tracked (decided), so it isn't an item.
import { isOpenSale, RELEASED_SALE_STATUSES } from './vocab.js';
import { GO_HOME_SALE_STATUSES, pickupFor, readyDateOf } from './goHome.js';
import { homePups, rosterOf } from './litterCheckin.js';

export const READY_ITEMS = Object.freeze([
  { key: 'chip', label: 'Microchip', optional: true, ask: 'Microchip numbers' },
  { key: 'litter_reg', label: 'Litter registration number', optional: true, ask: 'The litter\'s registration number' },
  { key: 'pup_reg', label: 'Registered name and number', optional: true, ask: 'Each pup\'s registered name and number' },
  { key: 'shots', label: 'Shots' },
  { key: 'deworm', label: 'Deworming' },
  { key: 'pickup', label: 'Drop-off date', sale: true },
  { key: 'balance', label: 'Balance', sale: true },
  { key: 'contract', label: 'Contract signed', sale: true, flag: 'contracts' },
  { key: 'registration', label: 'Registration type', sale: true },
  { key: 'feeding', label: 'Feeding schedule', flag: 'feedingSchedule', optional: true, ask: 'A feeding schedule' }
]);

// The optional items this edition has, for "want me to check these too?".
export const optionalItems = (flags = {}) => READY_ITEMS.filter((it) => it.optional && (!it.flag || flags[it.flag]));

const PREP_STATUSES = ['whelped', 'weaning', 'ready', 'sold'];

// The pup's sale: its newest open one, else its newest delivered one, else null.
export function pupSale(sales) {
  const live = sales.filter((s) => !s.is_archived);
  const newest = (list) => list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0] || null;
  return newest(live.filter(isOpenSale)) || newest(live.filter((s) => s.status === 'delivered'));
}

// Ticked by default: a pup whose sale is at Deposit paid or later.
export const pickedByDefault = (sale) => Boolean(sale && GO_HOME_SALE_STATUSES.includes(sale.status));

// Litters with a pup still at home (born, not closed or archived), newest born
// first. `dogs` and `sales`: live records (the litter's pups are found from them).
export function prepLitters(litters, dogs, sales) {
  return litters
    .filter((l) => !l.is_archived && PREP_STATUSES.includes(l.status) && homePups(rosterOf(l.id, dogs), sales).length)
    .sort((a, b) => (b.whelp_date || '').localeCompare(a.whelp_date || '') || (b.created_at || '').localeCompare(a.created_at || ''));
}

// The pickup or drop-off the readiness counts: the soonest today or later, else null.
export function nextPickup(sale, events, today) {
  if (!sale) return null;
  return events.filter(pickupFor(sale)).map((e) => e.event_date).filter((d) => d >= today).sort()[0] || null;
}

// The newest event of a type (live), or null.
const newestOf = (events, type) => events.filter((e) => !e.is_archived && e.event_type === type)
  .sort((a, b) => (b.event_date || '').localeCompare(a.event_date || ''))[0] || null;

// One pup's readiness. `pup`: the dog; `sale`: pupSale (or null); `events`: the
// pup's events; `contracts`: the sale's contracts; `litter`: its litter;
// `hasBreedSchedule`: a breed feeding schedule exists for the pup's breed;
// `flags`: the edition's flags (`contracts`, `feedingSchedule`).
// → { items: [{ key, label, done, detail }], missing: [key], pickupDate }
// `detail` is plain text (the chip number, the last date…), or ''.
// `checks`: the optional item keys she ticked; null checks them all (the Puppy
// Record's cover page from the Sales picker).
export function readiness({ pup, sale = null, events = [], contracts = [], litter = null, hasBreedSchedule = false, flags = {}, today, checks = null }) {
  const shots = newestOf(events, 'vaccination');
  const deworm = newestOf(events, 'preventative');
  const pickupDate = nextPickup(sale, events, today);
  const paid = sale && (['paid_in_full', 'delivered'].includes(sale.status) || Boolean(sale.balance_paid_date));
  const live = contracts.filter((c) => !c.is_archived);
  const signed = live.some((c) => c.status === 'signed');
  const override = String(litter?.feeding_schedule_override || '').trim();
  const check = {
    chip: [Boolean(pup.microchip_id), pup.microchip_id || ''],
    pup_reg: [Boolean(String(pup.registered_name || '').trim() && String(pup.registration_number || '').trim()), String(pup.registration_number || '').trim()],
    litter_reg: [Boolean(String(litter?.litter_registration_number || '').trim()), String(litter?.litter_registration_number || '').trim()],
    shots: [Boolean(shots), shots ? shots.event_date : ''],
    deworm: [Boolean(deworm), deworm ? deworm.event_date : ''],
    pickup: [Boolean(pickupDate), pickupDate || ''],
    balance: [paid || Boolean(sale?.balance_due_date), paid ? 'paid' : sale?.balance_due_date ? `due ${sale.balance_due_date}` : ''],
    contract: [signed, signed ? 'signed' : live.length ? live[0].status || 'draft' : ''],
    registration: [Boolean(sale?.registration_type), sale?.registration_type || ''],
    feeding: [Boolean(override) || hasBreedSchedule, override ? 'litter' : hasBreedSchedule ? 'breed' : '']
  };
  const items = READY_ITEMS
    .filter((it) => (!it.sale || sale) && (!it.flag || flags[it.flag]) && (!it.optional || !checks || checks.includes(it.key)))
    .map((it) => ({ key: it.key, label: it.label, done: check[it.key][0], detail: check[it.key][1] }));
  return { items, missing: items.filter((i) => !i.done).map((i) => i.key), pickupDate };
}

// Where a new pickup defaults: the ready date, or today once that has passed.
export const pickupDefault = (litter, today) => {
  const r = readyDateOf(litter);
  return r && r > today ? r : today;
};

// The pups missing `key`, in the order given. `rows`: [{ pup, ready }].
export const missingFor = (rows, key) => rows.filter((r) => r.ready.missing.includes(key));

// "6 of 8 done" for one pup.
export const doneText = (ready) => `${ready.items.filter((i) => i.done).length} of ${ready.items.length} done`;

// Pups at home whose plan says they're spoken for or up for sale, with no sale going
// ahead: Available ones still unsold at go-home time, and Placed ones nobody recorded
// a sale for. `rows`: [{ pup, sale }] for every pup at home (pupSale; a returned,
// cancelled or voided sale doesn't count). → the rows, Placed first.
export function planWithoutSale(rows) {
  const going = (s) => s && !s.is_archived && !RELEASED_SALE_STATUSES.includes(s.status);
  return rows.filter((r) => ['placed', 'available'].includes(r.pup.disposition) && !going(r.sale))
    .sort((a, b) => (a.pup.disposition === 'placed' ? 0 : 1) - (b.pup.disposition === 'placed' ? 0 : 1));
}
