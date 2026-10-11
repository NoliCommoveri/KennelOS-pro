// contractSend.js — the data side of "Send for signature" (Integrations plan
// §2.1a), shared by the Contract page and the waitlist's "Review sale & send"
// (§2.6): read the records a contract reaches, build its prefilled link, and
// record that it went out. Reads and writes only through the repos.
import { contractRepo } from './contractRepo.js';
import { saleRepo } from './saleRepo.js';
import { studServiceRepo } from './studServiceRepo.js';
import { dogRepo } from './dogRepo.js';
import { contactRepo } from './contactRepo.js';
import { kennelRepo } from './kennelRepo.js';
import { accountRepo } from './accountRepo.js';
import { incomeLineItems, paidOnSale, getSaleFeeCredit } from './incomeView.js';
import { allForms, prefillValues, prefillUrl, formProvider } from './contractForms.js';
import { todayYMD } from './dateUtils.js';

// Contracts that can still go out for signature (and be sent again).
export const SENDABLE_STATUSES = ['draft', 'sent', 'declined'];

// Every saved contract form, from her Form service accounts.
export async function loadContractForms() {
  return allForms(await accountRepo.getAll());
}

// What's still owed on a sale, read the way the ledger reads it.
export async function balanceDueOn(sale) {
  const feeCredit = await getSaleFeeCredit(sale.id);
  const total = incomeLineItems('sale', sale, { feeCredit }).reduce((t, x) => t + x.amount, 0);
  return Math.max(0, total - paidOnSale(sale, { feeCredit }));
}

const get = (repo, id) => (id ? repo.getById(id) : null);

// The records a contract reaches, as contractForms.prefillValues wants them.
export async function gatherContractFacts(c) {
  const sale = await get(saleRepo, c.related_sale_id);
  const ss = await get(studServiceRepo, c.related_stud_service_id);
  const puppy = sale ? await get(dogRepo, sale.dog_id) : null;
  // Outgoing: our dog is the stud. Incoming: our dog is the dam.
  const ours = ss ? await get(dogRepo, ss.our_dog_id) : null;
  const theirs = ss ? await get(dogRepo, ss.partner_dog_id) : null;
  const incoming = ss?.direction === 'incoming';
  return {
    contract: c,
    kennel: await get(kennelRepo, c.kennel_id),
    today: todayYMD(),
    sale, puppy,
    balanceDue: sale ? await balanceDueOn(sale) : null,
    buyer: sale ? await get(contactRepo, sale.buyer_contact_id) : null,
    sire: puppy ? await get(dogRepo, puppy.sire_id) : null,
    dam: puppy ? await get(dogRepo, puppy.dam_id) : null,
    studService: ss,
    studDog: incoming ? theirs : ours,
    studDam: incoming ? ours : theirs,
    partner: await get(contactRepo, ss ? ss.partner_contact_id : c.related_contact_id),
    dog: await get(dogRepo, c.related_dog_id)
  };
}

// One form's prefilled link for these facts. → { values, url }.
export function buildSignatureLink(form, facts) {
  const values = prefillValues(form.form_type, facts);
  return { values, url: prefillUrl(form.url, values) };
}

// She sent it: the contract becomes `sent` (a sent one stays sent) with what went.
export function markContractSent(c, form, url) {
  return contractRepo.update(c.id, {
    status: c.status === 'draft' || c.status === 'declined' ? 'sent' : c.status,
    esign_provider: formProvider(form.url),
    esign_url: url,
    esign_sent_date: todayYMD(),
    esign_form_label: form.label
  });
}

// The sale's contract to send: its newest one still sendable, else null.
export async function openContractForSale(saleId) {
  const rows = (await contractRepo.getBySale(saleId))
    .filter((c) => !c.is_archived && SENDABLE_STATUSES.includes(c.status || 'draft'))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return rows[0] || null;
}
