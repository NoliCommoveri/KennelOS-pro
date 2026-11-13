// integrationApply.js — apply one vendor event to her records (Integrations plan
// §0): load the contract or sale it names, plan it (integrationEvents.js) and
// write through the repos. Shared by the Worker's event stream
// (cloud/cloudIntegrations.js) and her device's own Stripe check (stripeLinks.js).
import { contractRepo } from './contractRepo.js';
import { saleRepo } from './saleRepo.js';
import { accountRepo } from './accountRepo.js';
import { waitlistOfferRepo } from './waitlistOfferRepo.js';
import { editionFlags } from './editionConfig.js';
import { saleFeeEstimate } from './processingFees.js';
import { planIntegrationEvent, addReview, reviewOf } from './integrationEvents.js';
import { getSaleStatement } from './incomeView.js';
import { paidInFullOffer } from './paymentSchedule.js';

const REPOS = { contract: contractRepo, sale: saleRepo };

async function isWaitlistPick(saleId) {
  if (!editionFlags.waitlist) return false;
  return (await waitlistOfferRepo.getAll()).some((o) => o.sale_id === saleId && o.outcome === 'open');
}

async function saleContext(sale) {
  const accounts = await accountRepo.getAll({ includeArchived: true });
  // What's left of the deposit after credits, as her Payments card reads it.
  const st = await getSaleStatement(sale);
  return {
    waitlistPick: await isWaitlistPick(sale.id), estimate: saleFeeEstimate(sale, new Map(accounts.map((a) => [a.id, a]))),
    ...(st?.statement.deposit ? { depositOwed: st.statement.deposit.owed } : {})
  };
}

// A payment that now covers everything on a sale not marked paid in full leaves a
// Today item (Payment Schedule plan D34): nothing marks it by itself (D22).
export const COVERS_ALL_REASON = 'This payment covers everything on the sale. Mark it paid in full on its Payments card.';
async function coversAllReview(event, saleId) {
  const sale = await saleRepo.getById(saleId);
  const st = sale ? await getSaleStatement(sale) : null;
  return st && paidInFullOffer(st.statement, sale) ? reviewOf({ ...event, id: `${event.id || `int-${event.seq}`}-all` }, COVERS_ALL_REASON) : null;
}

// → 'applied' | 'review' | 'skipped'
//   event: { id?, seq?, provider, kind, recordType, recordId, payload, createdAt }
export async function applyIntegrationEvent(event) {
  const repo = REPOS[event.recordType];
  if (!repo) return 'skipped';
  const record = await repo.getById(event.recordId);
  const ctx = event.recordType === 'sale' && record ? await saleContext(record) : {};
  const plan = planIntegrationEvent(event, record, ctx);
  if (plan.op === 'update') {
    const changes = { ...plan.changes };
    if (plan.review) changes.integration_reviews = addReview(record.integration_reviews, reviewOf(event, plan.review.reason));
    await repo.update(record.id, changes);
    if (event.recordType === 'sale' && Array.isArray(changes.payments)) {
      const all = await coversAllReview(event, record.id);
      if (all) {
        const fresh = await repo.getById(record.id);
        await repo.update(record.id, { integration_reviews: addReview(fresh.integration_reviews, all) });
      }
    }
    return 'applied';
  }
  if (plan.op === 'review') {
    await repo.update(record.id, { integration_reviews: addReview(record.integration_reviews, plan.review) });
    return 'review';
  }
  return 'skipped';
}
