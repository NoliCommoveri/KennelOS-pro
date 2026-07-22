// companionExport.js — the Companion feature's allow-list bundle builder.
//
// THE LOAD-BEARING SECURITY INVARIANT of this feature. importExport.js
// deliberately iterates whatever tables exist (a full backup); this module does
// the EXACT OPPOSITE. Each builder constructs a fresh object naming every field
// explicitly and copies ONLY the listed fields. Hard rules (checked in review):
//   - No object spread of a record ({...dog}), no Object.assign from a record,
//     no "take the record and delete the private keys."
//   - Reads go through repos, never db.<table> directly (layering rule).
//   - No second family's data, no internal notes, no freeform Event.notes, no
//     lead/source fields. Money is limited to the recipient's OWN figures:
//     a prospect sees the litter's per-sex list price + deposit; a family sees
//     their own sale price/deposit/balance; a partner sees the one stud
//     fee_amount. (The prospective "NO price" rule was reversed by owner
//     decision — see the Companion Packages Enhancement Brief, decision 1.)
//   - A new field added to a source table does NOT appear in a bundle until
//     someone adds it here by name. Silence is the safe default.
// After building, assertOnlyKeys() runs a POSITIVE allow-list check (not a
// deny-list): if any unexpected top-level key is present, the send is aborted.
// Enrichment nested inside an allowed top-level key (a pup, a litter, a stud
// service) is safe as long as the top-level allow-lists stay exact and every
// nested field is likewise copied BY NAME.
//
// All three bundles are anchored on a Contact (the recipient) and discriminated
// by bundleType. Money is the app's native decimal, never cents — the shell
// formats it. Bundle evolution is additive; COMPANION_BUNDLE_VERSION bumps only
// on a breaking shape change.
import { dogRepo } from './dogRepo.js';
import { saleRepo } from './saleRepo.js';
import { contractRepo } from './contractRepo.js';
import { studServiceRepo } from './studServiceRepo.js';
import { eventRepo } from './eventRepo.js';
import { litterRepo } from './litterRepo.js';
import { contactRepo } from './contactRepo.js';
import { kennelRepo } from './kennelRepo.js';
import { todayYMD } from './dateUtils.js';
import { getCompanionSettings } from './settings.js';

export const COMPANION_BUNDLE_VERSION = 1;

const FEE_STRUCTURES_WITH_PICK = ['pick_of_litter', 'flat_plus_pick'];

// Curated per-type detail surfaced in a family's event history (brief decision
// 4 — a scoped relaxation of the "fixed type label only" rule). One safe field
// per type, never the freeform top-level notes, never illness/injury/evaluation
// or any other type not listed here.
const FAMILY_EVENT_TYPES = ['vaccination', 'preventative', 'weight_check', 'milestone', 'note'];

// Maps each family event-history type to its Layer-1 include flag, so a type is
// only surfaced when the owner has left its checkbox on.
const FAMILY_EVENT_FLAG = {
  vaccination: 'histVaccination', preventative: 'histPreventative',
  weight_check: 'histWeight', milestone: 'histMilestone', note: 'histNote'
};

function nonEmpty(v) {
  return v != null && v !== '' ? v : null;
}

// Parent identity for a family's parentage line — call + registered name only.
function parentName(d) {
  return d ? { registeredName: d.registered_name || '', callName: d.call_name || '' } : null;
}

// Identity of the dog a lease / co-own agreement is about — registered + call
// name only (no photos or tests; the recipient already knows the dog).
function dogRef(d) {
  return d ? { registeredName: d.registered_name || '', callName: d.call_name || '' } : null;
}

// Per-type public projection of a partner contract. Each branch copies ONLY its
// own fields BY NAME — the allow-list invariant holds because `contracts` is an
// allowed top-level key and everything nested here is named (spreading `base`,
// a freshly-built object, is not a record spread — same pattern as `...h`). Lease
// adds its window + the leased dog; co_own adds the co-owned dog; other stays the
// generic shape.
async function projectContract(c) {
  const base = {
    type: c.contract_type || null,
    title: c.title || null,
    status: c.status || null,
    signedDate: c.signed_date || null,
    terms: c.terms_summary || null,
    document_url: c.document_url || null
  };
  if (c.contract_type === 'lease') {
    const dog = c.related_dog_id ? await dogRepo.getById(c.related_dog_id) : null;
    return { ...base, startDate: c.lease_start_date || null, endDate: c.lease_end_date || null, dog: dogRef(dog) };
  }
  if (c.contract_type === 'co_own') {
    const dog = c.related_dog_id ? await dogRepo.getById(c.related_dog_id) : null;
    return { ...base, dog: dogRef(dog) };
  }
  return base;
}

// Completed breed-specific / health tests for a dog, projected to {name, result}
// and surfaced only when the result/rating is non-empty. Returns [] when nothing
// qualifies so callers omit the block entirely (no placeholder). Reads through
// eventRepo, never db.*.
async function completedTests(dogId) {
  const events = await eventRepo.getForSubject('dog', dogId);
  const out = [];
  for (const e of events) {
    const d = e.details || {};
    if (e.event_type === 'breed_specific_test' && nonEmpty(d.result) != null) {
      out.push({ name: d.test_name || '', result: d.result });
    } else if (e.event_type === 'ofa_pennhip' && nonEmpty(d.rating) != null) {
      out.push({ name: d.joint || '', result: d.rating });
    } else if (e.event_type === 'genetic_test' && nonEmpty(d.result) != null) {
      out.push({ name: d.panel_name || '', result: d.result });
    }
  }
  return out;
}

// Public projection of a dog — registered/AKC name, call name, a photos link,
// and completed tests. Named copy only, no record spread. `opts` (from the
// Layer-1 include flags) selects which fields to populate; a disabled field is
// emitted empty. When every field is disabled the card is omitted entirely
// (null), so the shell never renders an empty "—" block.
const ALL_DOG_FIELDS = { registeredName: true, callName: true, photos: true, tests: true };
async function dogCard(dog, opts = ALL_DOG_FIELDS) {
  if (!dog) return null;
  const card = {
    registeredName: opts.registeredName ? (dog.registered_name || '') : '',
    callName: opts.callName ? (dog.call_name || '') : '',
    photosUrl: opts.photos ? (dog.url || '') : '',
    tests: opts.tests ? await completedTests(dog.id) : []
  };
  if (!card.registeredName && !card.callName && !card.photosUrl && !card.tests.length) return null;
  return card;
}

// Whole weeks + trailing days between a YYYY-MM-DD birth date and an as-of
// calendar date. Ships the derived age, never the raw DOB.
function ageFrom(dob, asOfYMD) {
  if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const start = new Date(dob + 'T00:00:00');
  const end = new Date(asOfYMD + 'T00:00:00');
  const days = Math.floor((end.getTime() - start.getTime()) / 86400000);
  if (isNaN(days) || days < 0) return null;
  return { ageWeeks: Math.floor(days / 7), ageDays: days % 7 };
}

// One curated safe detail string per family-visible event type (brief decision
// 4). Never the freeform top-level notes. Returns null when the detail is empty
// (note carries a title only).
function familyEventDetail(e) {
  const d = e.details || {};
  switch (e.event_type) {
    case 'vaccination': return nonEmpty(d.vaccine);
    case 'preventative': return nonEmpty(d.product);
    case 'weight_check': {
      const lbs = nonEmpty(d.weight_lbs);
      const oz = nonEmpty(d.weight_oz);
      if (lbs == null && oz == null) return null;
      return [lbs != null ? `${lbs} lb` : null, oz != null ? `${oz} oz` : null].filter(Boolean).join(' ');
    }
    case 'milestone': return nonEmpty(d.description);
    default: return null;
  }
}

// The owner/breeder kennel to reveal on a FOSTER-IN litter — the kennel the
// foster partner (the dam's owner, who is the breeder of record) belongs to.
// Returns just the kennel name (never the whole record), or '' otherwise.
// Deliberately **foster-in ONLY**: on a foster-OUT litter WE are the breeder, so
// the partner is the caretaker (not the breeder) and there is nothing external to
// reveal. Gated by the `fosterOwnerKennel` include flag at the call site so it can
// be withheld even for foster-in. Reads through repos, never db.*.
async function fosterOwnerKennelName(litter) {
  if (!litter || litter.foster_direction !== 'foster_in' || !litter.foster_partner_contact_id) return '';
  const partner = await contactRepo.getById(litter.foster_partner_contact_id);
  if (!partner || !partner.kennel_id) return '';
  const kennel = await kennelRepo.getById(partner.kennel_id);
  return kennel ? (kennel.kennel_name || '') : '';
}

// Positive allow-list assertion — abort the send rather than emit a superset.
function assertOnlyKeys(obj, allowed, ctx) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) {
      throw new Error(`Companion bundle (${ctx}) has unexpected key "${k}" — send aborted.`);
    }
  }
  return obj;
}

// Shared header/footer copy. Layer 1 (per-type settings) supplies kennel identity,
// intro, the broadcast announcement, and the closer. Layer 2 (Contact.companion_note)
// is the recipient's personal message — carried SEPARATELY as `personalNote` and
// shown alongside the announcement, not overriding it.
function headerCopy(type, contact) {
  const s = getCompanionSettings(type);
  const note = (contact.companion_note || '').trim();
  return {
    kennelName: s.kennelName || '',
    tagline: s.tagline || '',
    introText: s.introText || '',
    announcement: s.announcement || '',
    personalNote: note || '',
    closer: s.closer || ''
  };
}

const PROSPECTIVE_KEYS = [
  'bundleVersion', 'bundleType', 'kennelName', 'tagline', 'introText', 'announcement',
  'personalNote', 'closer', 'familyName', 'litters', 'updatedAt'
];
const FAMILY_KEYS = [
  'bundleVersion', 'bundleType', 'kennelName', 'tagline', 'introText', 'announcement',
  'personalNote', 'closer', 'familyName', 'pups', 'contracts', 'updatedAt'
];
const PARTNER_KEYS = [
  'bundleVersion', 'bundleType', 'kennelName', 'tagline', 'introText', 'announcement',
  'personalNote', 'closer', 'partnerName', 'studServices', 'contracts', 'updatedAt'
];

// --- Prospective family: current availability, one card per litter with its
// available pups nested inside. Carries the litter's per-sex list price + deposit
// (owner decision 1 reversed the old "NO price" rule); still NO per-recipient
// private data — every prospect sees the same availability. -----------------
export async function buildProspectiveBundle(contact) {
  const h = headerCopy('prospective', contact);
  const inc = getCompanionSettings('prospective').include;
  const dogs = await dogRepo.getAll();
  const available = dogs.filter((d) => d.status === 'puppy' && d.disposition === 'available');

  // Which parent-card fields to include, and whether each price/deposit shows —
  // a child flag only counts when its master (parents / pricing) is on.
  const dogOpts = {
    registeredName: inc.parents && inc.parentRegisteredName,
    callName: inc.parents && inc.parentCallName,
    photos: inc.parents && inc.parentPhotos,
    tests: inc.parents && inc.parentTests
  };
  const showPrice = inc.pricing && inc.pricingPrice;
  const showDeposit = inc.pricing && inc.pricingDeposit;

  const litterIds = [...new Set(available.map((d) => d.litter_id).filter(Boolean))];
  const litters = [];
  for (const id of litterIds) {
    const l = await litterRepo.getById(id);
    if (!l) continue;
    const sireDog = l.sire_id ? await dogRepo.getById(l.sire_id) : null;
    const damDog = l.dam_id ? await dogRepo.getById(l.dam_id) : null;
    const pups = available
      .filter((d) => d.litter_id === id)
      .map((d) => ({
        sex: d.sex || '',
        callName: d.call_name || '',
        markings: inc.markings ? (d.color_markings || '') : '',
        price: !showPrice ? null
          : d.sex === 'male' ? nonEmpty(l.expected_price_male)
            : d.sex === 'female' ? nonEmpty(l.expected_price_female) : null,
        deposit: !showDeposit ? null
          : d.sex === 'male' ? nonEmpty(l.expected_deposit_male)
            : d.sex === 'female' ? nonEmpty(l.expected_deposit_female) : null
      }));
    litters.push({
      nickname: l.nickname || '',
      breed: (damDog && damDog.breed) || (sireDog && sireDog.breed) || '',
      whelpDate: inc.litterDates ? (l.whelp_date || null) : null,
      acceptDepositsDate: inc.litterDates ? (l.accept_deposits_date || null) : null,
      readyDate: inc.litterDates ? (l.estimated_ready_date || null) : null,
      // Owner/breeder kennel — populated only for a foster litter and only when the
      // owner leaves the flag on; empty for every ordinary litter (see §20/§4).
      breederKennel: inc.fosterOwnerKennel ? await fosterOwnerKennelName(l) : '',
      sire: inc.parents ? await dogCard(sireDog, dogOpts) : null,
      dam: inc.parents ? await dogCard(damDog, dogOpts) : null,
      pups
    });
  }

  const bundle = {
    bundleVersion: COMPANION_BUNDLE_VERSION,
    bundleType: 'prospective',
    ...h,
    familyName: contact.name || '',
    litters,
    updatedAt: new Date().toISOString()
  };
  return assertOnlyKeys(bundle, PROSPECTIVE_KEYS, 'prospective');
}

// --- Current family: their placed dog(s), each with parentage, a computed age,
// ready/placement info, their own sale facts, and a curated per-type event
// history. A pointer to the governing contract document rides alongside. ------
export async function buildFamilyBundle(contact) {
  const h = headerCopy('family', contact);
  const inc = getCompanionSettings('family').include;
  // Only OPEN sales — a terminal sale (delivered/returned/cancelled) never shows,
  // matching "current family" membership exactly (saleRepo.isOpenSale).
  const sales = (await saleRepo.getByBuyer(contact.id)).filter(saleRepo.isOpenSale);
  const updatedAt = new Date().toISOString();
  const asOf = updatedAt.slice(0, 10);

  const pups = [];
  const contracts = [];

  for (const sale of sales) {
    const dog = await dogRepo.getById(sale.dog_id);
    if (dog) {
      const litter = dog.litter_id ? await litterRepo.getById(dog.litter_id) : null;
      const sireDog = litter && litter.sire_id ? await dogRepo.getById(litter.sire_id) : null;
      const damDog = litter && litter.dam_id ? await dogRepo.getById(litter.dam_id) : null;

      // getForSubject excludes archived and returns newest-first.
      const events = await eventRepo.getForSubject('dog', dog.id);
      const placement = events.find((e) => e.event_type === 'placement' && e.event_date);

      const eventSections = [];
      for (const t of FAMILY_EVENT_TYPES) {
        if (!inc[FAMILY_EVENT_FLAG[t]]) continue;
        const items = events
          .filter((e) => e.event_type === t && e.event_date)
          .map((e) => ({ date: e.event_date, title: e.title || '', detail: familyEventDetail(e) }));
        if (items.length) eventSections.push({ type: t, items });
      }

      const price = nonEmpty(sale.price);
      const deposit = nonEmpty(sale.deposit_amount);
      const transportFee = nonEmpty(sale.transport_fee);

      // Deferred pickup boarding: a rate (`amount`) charged per frequency unit
      // (Day/Week/Month), for a count of those units (`deferred_boarding_duration_days`
      // now holds the number of frequency units, not days — owner decision). The
      // total is `amount × units` and feeds the remaining balance; the line only
      // appears when an amount is present.
      const deferredAmount = nonEmpty(sale.deferred_boarding_amount);
      let deferredPickup = null;
      let deferredTotal = 0;
      if (deferredAmount != null) {
        const units = Number(sale.deferred_boarding_duration_days);
        const factor = Number.isFinite(units) && units > 0 ? units : 1;
        deferredTotal = Number(deferredAmount) * factor;
        deferredPickup = {
          total: deferredTotal,
          amount: Number(deferredAmount),
          frequency: nonEmpty(sale.deferred_boarding_frequency),
          duration: nonEmpty(sale.deferred_boarding_duration_days)
        };
      }

      // Remaining balance is COMPUTED here, never stored: price + transport fee +
      // deferred boarding − deposit. Absent components count as 0.
      const remainingBalance = price != null
        ? Number(price) + Number(transportFee || 0) + deferredTotal - Number(deposit || 0)
        : null;

      // Deferred Pickup Boarding section — pinned to the top of the event history,
      // but only when the sale carries a COMPLETE deferred pickup (amount +
      // frequency + duration). Lists the dog's boarding stays as scheduled date
      // ranges. Only the two dates are copied by name — never the boarding notes.
      const deferredComplete = deferredAmount != null
        && nonEmpty(sale.deferred_boarding_frequency) != null
        && nonEmpty(sale.deferred_boarding_duration_days) != null;
      if (inc.histBoarding && deferredComplete) {
        const boarding = events
          .filter((e) => e.event_type === 'boarding' && e.event_date)
          .map((e) => ({ startDate: e.event_date, endDate: e.event_end_date || null }));
        if (boarding.length) eventSections.unshift({ type: 'deferred_pickup_boarding', items: boarding });
      }

      const showFin = inc.financials;
      const pup = {
        callName: dog.call_name || '',
        sex: dog.sex || '',
        photosUrl: inc.photos ? (dog.url || '') : '',
        sire: inc.parentage ? parentName(sireDog) : null,
        dam: inc.parentage ? parentName(damDog) : null,
        age: inc.age ? ageFrom(dog.date_of_birth, asOf) : null,
        placementType: nonEmpty(sale.placement_type),
        saleStatus: nonEmpty(sale.status),
        price: showFin ? price : null,
        deposit: showFin ? deposit : null,
        transportFee: showFin ? transportFee : null,
        deferredPickup: showFin ? deferredPickup : null,
        remainingBalance: showFin ? remainingBalance : null,
        balanceDueDate: showFin ? (sale.balance_due_date || null) : null,
        // Owner/breeder kennel — populated only when this pup came from a foster
        // litter and the owner leaves the flag on; empty otherwise (§20/§4).
        breederKennel: (inc.fosterOwnerKennel && litter) ? await fosterOwnerKennelName(litter) : '',
        eventSections
      };
      if (litter && litter.nickname) pup.litterNickname = litter.nickname;
      if (inc.readyPlacement) {
        if (placement) {
          const pd = placement.details || {};
          pup.placement = {
            date: placement.event_date,
            time: nonEmpty(pd.placement_time),
            method: nonEmpty(pd.dropoff_method)
          };
        } else if (litter && litter.estimated_ready_date) {
          pup.estimatedReadyDate = litter.estimated_ready_date;
        }
      }
      pups.push(pup);
    }
    // Carry each governing/documented contract as {signedDate, documentUrl} so the
    // shell can show the signed date (or "Not Signed") alongside a view/sign link.
    if (inc.contract) {
      const saleContracts = (await contractRepo.getBySale(sale.id)).filter((c) => !c.is_archived);
      for (const c of saleContracts) {
        if (c.document_url || c.signed_date) {
          contracts.push({ signedDate: c.signed_date || null, documentUrl: c.document_url || null });
        }
      }
    }
  }

  const bundle = {
    bundleVersion: COMPANION_BUNDLE_VERSION,
    bundleType: 'family',
    ...h,
    familyName: contact.name || '',
    pups,
    contracts,
    updatedAt
  };
  return assertOnlyKeys(bundle, FAMILY_KEYS, 'family');
}

// --- Partner: stud services (labeled Stud/Dam cards with completed tests) and
// lease/co_own/other contracts where this partner is the counterparty. -------
export async function buildPartnerBundle(contact) {
  const h = headerCopy('partner', contact);
  const inc = getCompanionSettings('partner').include;

  // Which Stud/Dam card fields to include — each honoured only while the
  // Stud services master is on.
  const dogOpts = {
    registeredName: inc.studServices && inc.studRegisteredName,
    callName: inc.studServices && inc.studCallName,
    photos: inc.studServices && inc.studPhotos,
    tests: inc.studServices && inc.studTests
  };

  const services = inc.studServices
    ? (await studServiceRepo.getByPartnerContact(contact.id)).filter((s) => !s.is_archived)
    : [];
  const studServices = [];
  for (const ss of services) {
    const our = await dogRepo.getById(ss.our_dog_id);
    const partner = ss.partner_dog_id ? await dogRepo.getById(ss.partner_dog_id) : null;
    // Direction decides which side is the stud vs. the dam: outgoing = our dog
    // is the stud, incoming = our dog is the dam.
    const studDog = ss.direction === 'incoming' ? partner : our;
    const damDog = ss.direction === 'incoming' ? our : partner;

    const hasPick = FEE_STRUCTURES_WITH_PICK.includes(ss.fee_structure);

    // The stud service's own contract (governing/signed if any, else the most
    // recent) as {signedDate, documentUrl} — powers the per-service Contract
    // block: signed date (or "Not Signed") + a view/sign link.
    let primary = null;
    if (inc.studContract) {
      const svcContracts = (await contractRepo.getByStudService(ss.id)).filter((c) => !c.is_archived);
      const gov = contractRepo.governingContract(svcContracts);
      primary = gov || svcContracts.slice().sort((a, b) =>
        (b.created_at || '').localeCompare(a.created_at || ''))[0] || null;
    }

    studServices.push({
      studDog: await dogCard(studDog, dogOpts),
      damDog: await dogCard(damDog, dogOpts),
      type: inc.studAgreement ? (ss.type || null) : null,
      compensation: inc.studAgreement ? {
        fee_structure: ss.fee_structure || null,
        fee_amount: nonEmpty(ss.fee_amount),
        pick_status: hasPick ? (ss.pick_status || null) : null,
        sentDate: ss.sent_date || null,
        returnedDate: ss.returned_date || null
      } : {},
      contract: primary
        ? { signedDate: primary.signed_date || null, documentUrl: primary.document_url || null }
        : null
    });
  }

  // Partner contracts, reduced to the LIVE one per distinct agreement — not the
  // full history. getByContact spans several agreements at once (e.g. a lease +
  // a co_own + last year's expired lease), so keep only live contracts (same
  // isLivePartnerContract predicate as membership — non-terminal, unexpired),
  // group them by (type + dog), and within each group keep the governing
  // (most-recent signed) contract, falling back to the most recent by created_at.
  const today = todayYMD();
  const liveContracts = inc.contracts
    ? (await contractRepo.getByContact(contact.id)).filter((c) => contractRepo.isLivePartnerContract(c, today))
    : [];
  const contractGroups = new Map();
  for (const c of liveContracts) {
    const key = `${c.contract_type}::${c.related_dog_id || ''}`;
    if (!contractGroups.has(key)) contractGroups.set(key, []);
    contractGroups.get(key).push(c);
  }
  const contracts = [];
  for (const group of contractGroups.values()) {
    const live = contractRepo.governingContract(group)
      || group.slice().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0];
    if (live) contracts.push(await projectContract(live));
  }

  const bundle = {
    bundleVersion: COMPANION_BUNDLE_VERSION,
    bundleType: 'partner',
    ...h,
    partnerName: contact.name || '',
    studServices,
    contracts,
    updatedAt: new Date().toISOString()
  };
  return assertOnlyKeys(bundle, PARTNER_KEYS, 'partner');
}

// Convenience dispatcher used by the Send-Link UI.
export function buildBundle(type, contact) {
  if (type === 'prospective') return buildProspectiveBundle(contact);
  if (type === 'family') return buildFamilyBundle(contact);
  if (type === 'partner') return buildPartnerBundle(contact);
  throw new Error(`Unknown companion bundle type "${type}".`);
}
