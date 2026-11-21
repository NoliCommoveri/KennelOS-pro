// saleChecks.js — what every sale checks and remembers, whoever's buying (Unified
// Sale plan §2.2): the pups a sale can't be made on, a pup pulled from Undecided /
// Keeping / Health hold (held for the buyer, put back if the sale is cancelled), the
// other live claims on the pup at the time she records it, and a sale's deposit due
// date. Pure; every edition (Lite has no turn picks, so its claims are sales only).
import { sideSaleBlocker, pupClaims } from './waitlistRules.js';

// The pups no sale can be made on: archived, deceased or an outside dog now. → '' or
// the reason, said plainly. A placed pup or one gone home is only a warning
// (saleWarning): she may mark a pup Placed before she records its sale, or enter a
// past sale. A side sale refuses both (waitlistRules.sideSaleBlocker).
export function saleBlocker(dog) {
  if (!dog || dog.is_archived || ['deceased', 'external_reference'].includes(dog.status)) return sideSaleBlocker(dog);
  return '';
}

// What she's told, not stopped by, about the pup itself. → '' or the line.
export function saleWarning(dog) {
  if (!dog || saleBlocker(dog)) return '';
  if (dog.status === 'pet_home') return `${dog.call_name} has gone home.`;
  if ((dog.disposition || 'undecided') === 'placed') return `${dog.call_name} is already marked Placed.`;
  return '';
}

// Dispositions a sale pulls a pup from: the pup is held for the buyer and goes back
// to what it was if the sale is cancelled before the deposit (side_prior_disposition).
// Only a puppy has a disposition (dogRepo clears it at any other life stage), so an
// adult is never pulled.
export const PULLED_DISPOSITIONS = Object.freeze(['undecided', 'keeping', 'health_hold']);
export const pulledFrom = (dog) => {
  if (!dog || dog.status !== 'puppy') return null;
  const d = dog.disposition || 'undecided';
  return PULLED_DISPOSITIONS.includes(d) ? d : null;
};

// The deposit's due date on any sale (deposit_due_date; a side sale from an older
// build has only side_deposit_due). → 'YYYY-MM-DD' | null
export const depositDueOf = (sale) => (sale && (sale.deposit_due_date || sale.side_deposit_due)) || null;

// Still waiting on its deposit, with a due date that has passed. Released, archived
// and paid sales never are.
export const isDepositOverdue = (sale, today) => Boolean(sale) && !sale.is_archived
  && sale.status === 'deposit_pending' && Boolean(depositDueOf(sale)) && depositDueOf(sale) < today;

// The other live claims on `dogId` she's told about while recording a sale: its live
// sales (side or not) and open turn picks, leaving out `exceptSaleId` (the sale being
// edited). → pupClaims' shape.
export function otherClaims(dogId, { sales = [], offers = [], exceptSaleId = null } = {}) {
  if (!dogId) return [];
  return pupClaims(dogId, { sales, offers }).filter((c) => !exceptSaleId || c.sale_id !== exceptSaleId);
}

// One line per claim, for the form. `nameOfEntry(id)` and `nameOfSale(sale)` name
// who holds it; `fmtDate` formats a due date.
export function claimLine(c, { sales = [], nameOfEntry = () => '', nameOfSale = () => '', fmtDate = (d) => d } = {}) {
  const sale = c.sale_id ? sales.find((s) => s.id === c.sale_id) : null;
  const who = (c.entry_id && nameOfEntry(c.entry_id)) || (sale && nameOfSale(sale)) || 'Another buyer';
  const due = depositDueOf(sale);
  if (c.kind === 'pick') return `${who} picked this pup in their turn${due ? `, deposit due ${fmtDate(due)}` : ''}.`;
  if (sale && sale.status === 'deposit_pending') return `Also sold to ${who}, deposit not in yet${due ? ` (due ${fmtDate(due)})` : ''}. The first deposit received takes the pup.`;
  return `${who} already has a sale on this pup.`;
}
