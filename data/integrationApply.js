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

const REPOS = { contract: contractRepo, sale: saleRepo };

async function isWaitlistPick(saleId) {
  if (!editionFlags.waitlist) return false;
  return (await waitlistOfferRepo.getAll()).some((o) => o.sale_id === saleId && o.outcome === 'open');
}

async function saleContext(sale) {
  const accounts = await accountRepo.getAll({ includeArchived: true });
  return { waitlistPick: await isWaitlistPick(sale.id), estimate: saleFeeEstimate(sale, new Map(accounts.map((a) => [a.id, a]))) };
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
    return 'applied';
  }
  if (plan.op === 'review') {
    await repo.update(record.id, { integration_reviews: addReview(record.integration_reviews, plan.review) });
    return 'review';
  }
  return 'skipped';
}
