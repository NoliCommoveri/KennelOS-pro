// portalEarlyUI.js — "Start puppy portal now" (the owner's request, 2026-11-18;
// End-State guide §35.1): her puppy portal for one family before their contract is
// signed. The Sale page and the waitlist family's page both offer it when
// portalFeed.earlyPortalState says 'offer'. Setting Sale.portal_early_on is all it
// does: the feed (portalFeedSync.js) sends the family by itself within a minute,
// with no contract date; the date fills in once the contract is signed.
import { confirmModal } from './ui.js';
import { saleRepo } from '../data/saleRepo.js';
import { todayYMD } from '../data/dateUtils.js';

// Asks, then starts it. → true when started.
export async function startPortalEarly(sale, { buyer = '', pup = '' } = {}) {
  const who = buyer || 'This family';
  const ok = await confirmModal({
    title: 'Start their puppy portal now?',
    message: `${who} go to your puppy portal now${pup ? `, with ${pup}` : ''}, before their contract is signed. In KennelPort Site Manager they wait under Puppy families for you to invite them. The contract's signed date fills in by itself once it's signed.\n\nIf they back out, end the sale as you would anyway: the portal closes their placement.`,
    confirmLabel: 'Start their portal'
  });
  if (!ok) return false;
  await saleRepo.update(sale.id, { portal_early_on: todayYMD() });
  return true;
}
