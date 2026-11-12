// contractSend.js — the data side of "Send for signature" (Integrations plan
// §2.1a), shared by the Contract page and the waitlist's "Review sale & send"
// (§2.6): read the records a contract reaches, build its prefilled link, and
// record that it went out. Reads and writes only through the repos.
import { contractRepo } from './contractRepo.js';
import { saleRepo } from './saleRepo.js';
import { studServiceRepo } from './studServiceRepo.js';
import { ourRole } from './studRules.js';
import { dogRepo } from './dogRepo.js';
import { contactRepo } from './contactRepo.js';
import { kennelRepo } from './kennelRepo.js';
import { litterRepo } from './litterRepo.js';
import { eventRepo } from './eventRepo.js';
import { expectedPickupDate, pickupEvent } from './goHome.js';
import { accountRepo } from './accountRepo.js';
import { incomeLineItems, paidOnSale, getSaleCredits, priceTable } from './incomeView.js';
import { allForms, prefillValues, prefillUrl, formProvider, mapValues, isFirmaForm, agreementKey } from './contractForms.js';
import { esignSignedIn, liveTemplateIds } from './cloud/cloudEsign.js';
import { forgetMissingTemplates } from './esignTemplates.js';
import { todayYMD } from './dateUtils.js';
import { addOnFacts } from './contractAddOns.js';
import { kennelChargeList } from './extraCharges.js';

// Contracts that can still go out for signature (and be sent again).
export const SENDABLE_STATUSES = ['draft', 'sent', 'declined'];

// Every saved contract form, from her Form service accounts. Her Firma templates
// (D30) only while this device can send them (Pro, cloud, signed in).
// A template deleted in Firma (its editor has Delete) is dropped here, before it
// can be offered: only when Firma's list is known complete, else kept (the
// Worker refuses a missing one before it counts).
export async function loadContractForms() {
  const forms = allForms(await accountRepo.getAll());
  if (!esignSignedIn()) return forms.filter((f) => !isFirmaForm(f));
  if (!forms.some(isFirmaForm)) return forms;
  const live = await liveTemplateIds();
  if (!live) return forms;
  await forgetMissingTemplates(live);
  return forms.filter((f) => !isFirmaForm(f) || live.has(f.template_id));
}

// What's still owed on a sale, read the way the ledger reads it.
// The family's credits for funds already received count as paid. `credits`: the
// sale's getSaleCredits, when the caller already has them.
export async function balanceDueOn(sale, credits = null) {
  const { feeCredit, credit } = credits || await getSaleCredits(sale.id);
  const total = incomeLineItems('sale', sale, { feeCredit }).reduce((t, x) => t + x.amount, 0);
  return Math.max(0, total - paidOnSale(sale, { feeCredit, received: credit?.received || null }));
}

const get = (repo, id) => (id ? repo.getById(id) : null);

// The breeder who signs for a kennel: the contact whose Kennel is this kennel
// (Contact.kennel_id is an affiliation, so buyers have none). A derived query,
// never a stored back-pointer. With several, a contact typed Breeder first, then
// the longest-standing one. → the contact or null.
export async function breederFor(kennelId) {
  if (!kennelId) return null;
  const rows = (await contactRepo.getAll()).filter((x) => x.kennel_id === kennelId);
  const isBreeder = (x) => (Array.isArray(x.contact_type) ? x.contact_type : []).includes('breeder');
  rows.sort((a, b) => Number(isBreeder(b)) - Number(isBreeder(a)) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
  return rows[0] || null;
}

// A sale's separate agreements' facts (transport, boarding, each extra:
// contractAddOns.addOnFacts), read from the database. Her price list is the
// sale's kennel's. `have`: records the caller already read ({ puppy, events,
// litter, kennel }). → the facts | null (no sale).
export async function saleAddOns(sale, have = {}) {
  if (!sale) return null;
  const puppy = 'puppy' in have ? have.puppy : await get(dogRepo, sale.dog_id);
  const events = 'events' in have ? have.events : (puppy ? await eventRepo.getForSubject('dog', puppy.id) : []);
  const litter = 'litter' in have ? have.litter : (puppy ? await get(litterRepo, puppy.litter_id) : null);
  const kennel = 'kennel' in have ? have.kennel : await get(kennelRepo, sale.kennel_id);
  return addOnFacts({ sale, events, litter, priceList: kennelChargeList(kennel), today: todayYMD() });
}

// The pup's pickup on the calendar, with the sale's buyer (the event Kels's
// check-in writes: goHome.pickupEvent). → the event.
export function logPickup(sale, date) {
  return eventRepo.create(pickupEvent({ id: sale.dog_id }, sale, date));
}

// The records a contract reaches, as contractForms.prefillValues wants them.
export async function gatherContractFacts(c) {
  const sale = await get(saleRepo, c.related_sale_id);
  const ss = await get(studServiceRepo, c.related_stud_service_id);
  const puppy = sale ? await get(dogRepo, sale.dog_id) : null;
  // Our dog is the stud or the dam by its sex (studRules.ourRole).
  const ours = ss ? await get(dogRepo, ss.our_dog_id) : null;
  const theirs = ss ? await get(dogRepo, ss.partner_dog_id) : null;
  const incoming = ss ? ourRole(ss, [ours, theirs].filter(Boolean)) === 'dam' : false;
  const today = todayYMD();
  const pupEvents = puppy ? await eventRepo.getForSubject('dog', puppy.id) : [];
  const litter = puppy ? await get(litterRepo, puppy.litter_id) : null;
  const pickupDate = puppy ? expectedPickupDate({ sale, today, events: pupEvents, litter }) : '';
  const kennel = await get(kennelRepo, c.kennel_id);
  // Her price list is the sale's kennel's (else the contract's).
  const priceKennel = sale?.kennel_id && sale.kennel_id !== c.kennel_id ? await get(kennelRepo, sale.kennel_id) : kennel;
  const credits = sale ? await getSaleCredits(sale.id) : null;
  return {
    contract: c,
    kennel,
    breeder: await breederFor(c.kennel_id),
    today,
    sale, puppy, pickupDate,
    balanceDue: sale ? await balanceDueOn(sale, credits) : null,
    priceTable: sale ? priceTable(sale, { feeCredit: credits.feeCredit, received: credits.credit?.received || null }) : null,
    addOns: await saleAddOns(sale, { puppy, events: pupEvents, litter, kennel: priceKennel }),
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

// One form's prefilled link for these facts, under her field names when the form
// was once matched through Connect Jotform (field_map, kept read-only, D29). → { values, url }.
export function buildSignatureLink(form, facts) {
  const values = mapValues(prefillValues(form, facts), form.field_map);
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

const newestFirst = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''));

// The contract record a form goes out on. A sale's main contract and each of its
// separate agreements (transport, boarding, one per extra: contractForms.
// agreementKey) have a record of their own, so one being signed never marks
// another Signed. `contract` is the one she's sending from: it's used while
// nothing went out on it, or the same agreement did (a re-send). Once a different
// agreement went out on it (told by its esign_form_label among `forms`), the
// form's own record is used: the sale's sendable one for that agreement, else a
// new draft named for the form and the pup. → the contract.
export async function contractForForm(contract, form, forms) {
  if (!contract?.related_sale_id) return contract;
  const key = agreementKey(form);
  const keyOf = (c) => {
    const sent = c.esign_form_label ? (forms || []).find((f) => f.label === c.esign_form_label) : null;
    return sent ? agreementKey(sent) : null;
  };
  const mine = keyOf(contract);
  if (mine === null || mine === key) return contract;
  const sale = await get(saleRepo, contract.related_sale_id);
  const pup = sale ? await get(dogRepo, sale.dog_id) : null;
  const title = [form.label, pup?.call_name].filter(Boolean).join(': ');
  const own = (await contractRepo.getBySale(contract.related_sale_id))
    .filter((c) => !c.is_archived && c.id !== contract.id && SENDABLE_STATUSES.includes(c.status || 'draft')
      && (keyOf(c) === key || (!c.esign_form_label && c.title === title)))
    .sort(newestFirst);
  return own[0] || contractRepo.create({ contract_type: 'sale', related_sale_id: contract.related_sale_id, kennel_id: contract.kennel_id, status: 'draft', title });
}

// The sale's contract to send: its newest one still sendable, else null.
export async function openContractForSale(saleId) {
  const rows = (await contractRepo.getBySale(saleId))
    .filter((c) => !c.is_archived && SENDABLE_STATUSES.includes(c.status || 'draft'))
    .sort(newestFirst);
  return rows[0] || null;
}
