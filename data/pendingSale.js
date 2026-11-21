// pendingSale.js — a sale still waiting on its deposit, whoever's buying (Unified Sale
// plan §2.2): putting back a pup the sale pulled from Undecided / Keeping / Health
// hold, and cancelling a sale whose deposit never came. A side sale (a family on the
// list) is cancelled through waitlistActions.cancelSideSale instead, which also keeps
// their place. Every edition.
import { saleRepo } from './saleRepo.js';
import { waitlistOfferRepo } from './waitlistOfferRepo.js';
import { dogRepo } from './dogRepo.js';
import { todayYMD } from './dateUtils.js';
import { RELEASED_SALE_STATUSES } from './vocab.js';

const appendNote = (notes, line) => (notes ? `${notes}\n${line}` : line);

// The disposition to put back when this sale ends before its deposit: the one it
// pulled the pup from, or null.
export const heldPriorOf = (sale) => (sale && sale.side_holds_pup && sale.side_prior_disposition && sale.side_prior_disposition !== 'available'
  ? sale.side_prior_disposition : null);

// Put the pup back to what it was before this sale held it, when it's still the
// sale's: Available or Placed, alive, and no other live sale on it. → the
// disposition restored, or null.
export async function restoreHeldPup(sale) {
  const prior = heldPriorOf(sale);
  if (!prior) return null;
  const dog = await dogRepo.getById(sale.dog_id);
  if (!dog || dog.is_archived || dog.status === 'deceased') return null;
  if (!['available', 'placed'].includes(dog.disposition || 'undecided')) return null;
  const others = (await saleRepo.getByDog(dog.id)).filter((x) => x.id !== sale.id && !x.is_archived && !RELEASED_SALE_STATUSES.includes(x.status));
  if (others.length) return null;
  await dogRepo.update(dog.id, { disposition: prior });
  return prior;
}

// Cancel a sale still waiting on its deposit (Today's overdue flag, "Cancel the sale").
// → { sale, restored }
export async function cancelPendingSale(saleId, { date = todayYMD(), why = 'the deposit didn\'t arrive in time' } = {}) {
  const sale = await saleRepo.getById(saleId);
  if (!sale || sale.is_archived || sale.status !== 'deposit_pending') throw new Error('Only a sale still waiting on its deposit can be cancelled here. Open the sale to end it.');
  // A family's turn pick ends through their turn (it decides their place), never here.
  if ((await waitlistOfferRepo.getAll()).some((o) => !o.is_archived && o.outcome === 'open' && o.sale_id === sale.id)) {
    throw new Error('This sale is a family\'s pick in their turn. End it from their turn on the waitlist.');
  }
  const saved = await saleRepo.update(sale.id, { status: 'cancelled', notes: appendNote(sale.notes, `Cancelled ${date}: ${why}.`) });
  return { sale: saved, restored: await restoreHeldPup(sale) };
}
