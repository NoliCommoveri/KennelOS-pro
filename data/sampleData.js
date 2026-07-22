// sampleData.js — the "Thornfield Kennels" demo packet: seed it, clear it.
// Companion to importExport.js in the data layer (Sample Data & Reset brief v2).
//
// Design (brief §2): seed through the repo layer so sample records go through
// the exact same validation real data does; track created IDs in one manifest
// object rather than an `is_sample` schema flag, so clearing needs no scan.
//
// Tutorial coverage (Tutorial Sample-Data Coverage Spec §6, Phase 2): the packet
// is deliberately expanded so a first-run guided tour can stop on every hub and
// point at a live example — a priced "Autumn" litter with an open sale, a second
// (Boxer) breed line, a lease and a co-ownership, an incoming AI stud service,
// and dates tuned so the Today nudges fire. Every addition is DATA — no schema
// change, no new FK — and every id still lands in the manifest so clear/reset
// stays clean. See the spec's §6 threads (A–I) tagged inline below.
import { db } from './db.js';
import { dogRepo } from './dogRepo.js';
import { HistoryEvent } from './eventRepo.js';
import { contactRepo } from './contactRepo.js';
import { kennelRepo } from './kennelRepo.js';
import { pairingRepo } from './pairingRepo.js';
import { litterRepo } from './litterRepo.js';
import { saleRepo } from './saleRepo.js';
import { contractRepo } from './contractRepo.js';
import { studServiceRepo } from './studServiceRepo.js';
import { expenseRepo } from './expenseRepo.js';
import { monthsFromToday, daysFromToday } from './dateUtils.js';
import {
  findBlockingReferences, DOG_REFERENCES, PAIRING_REFERENCES, LITTER_REFERENCES,
  SALE_REFERENCES, STUD_SERVICE_REFERENCES
} from './referenceRegistry.js';
import {
  getSampleDataManifest,
  setSampleDataManifest,
  removeSampleDataManifest,
  wasSampleDataCleared,
  markSampleDataCleared,
  setCompanionSettings,
  COMPANION_TYPES
} from './settings.js';

export { getSampleDataManifest };

export function hasSampleData() {
  return getSampleDataManifest() != null;
}

// First-run gate (brief §4): only offer the choice when there are no rows in
// any Stage 1-2 table yet AND the manifest/cleared flag haven't been set —
// i.e. this browser has genuinely never made a choice before.
export async function shouldOfferFirstRunPrompt() {
  if (getSampleDataManifest() != null || wasSampleDataCleared()) return false;
  const [dogCount, contactCount, kennelCount] = await Promise.all([
    db.dogs.count(),
    db.contacts.count(),
    db.kennels.count()
  ]);
  return dogCount === 0 && contactCount === 0 && kennelCount === 0;
}

// Skip seeding: record the choice so the prompt never reappears.
export function declineSampleData() {
  markSampleDataCleared();
}

// --- Seeding ----------------------------------------------------------------

export async function seedSampleData() {
  const manifest = {
    seededAt: new Date().toISOString(),
    dogs: [], events: [], contacts: [], kennels: [], pairings: [], litters: [],
    sales: [], contracts: [], stud_services: [], expenses: []
  };

  const BREED = 'Boston Terrier';
  const BOXER = 'Boxer'; // Thread I (D2): a small second program alongside the Bostons.

  // Kennels — Thornfield is the user's own kennel; Meadow Ridge is Dana Ruiz's
  // (Own-Kennel Identity addendum §5).
  // Thread F (G12): Thornfield carries its program config — a preferred-test
  // checklist (feeds planned-test suggestions), preferred breeds (both lines,
  // feeds breed autocomplete), and promote-nudge thresholds so a kept puppy old
  // enough surfaces the promote-lifecycle nudge (§19/§4.3).
  const thornfield = await kennelRepo.create({
    kennel_name: 'Thornfield Kennels', prefix: 'THORN', location: 'Hartland, VT', is_own_kennel: true,
    preferred_tests: [
      'OFA Patella', 'OFA Cardiac (Advanced)', 'BAER Hearing', 'Companion Animal Eye Exam (CAER)',
      'Juvenile Hereditary Cataract (DNA)', 'Degenerative Myelopathy (DNA)', 'Holter Monitor (ARVC)'
    ],
    preferred_breeds: [BREED, BOXER],
    promote_nudge_enabled: true, promote_age_male_months: 14, promote_age_female_months: 11
  });
  const meadowRidge = await kennelRepo.create({
    kennel_name: 'Meadow Ridge Kennels', prefix: 'MDWR', location: 'Concord, NH', is_own_kennel: false
  });
  manifest.kennels.push(thornfield.id, meadowRidge.id);

  // Contacts
  const patricia = await contactRepo.create({
    name: 'Dr. Patricia Nguyen', contact_type: ['vet'], phone: '555-0101'
  });
  const dana = await contactRepo.create({
    name: 'Dana Ruiz', contact_type: ['breeder'], kennel_id: meadowRidge.id, phone: '555-0102',
    // companion_note (Thread H/G13): Dana is the lessor on Sage's lease below, so
    // she is a partner recipient — give her a recipient-facing note.
    email: 'dana.ruiz@example.com', address: 'Concord, NH',
    companion_note: 'Thanks for trusting Thornfield with Sage this season — updates to follow.'
  });
  const sam = await contactRepo.create({
    name: 'Sam Okafor', contact_type: ['co_owner'], phone: '555-0103'
  });
  const tessa = await contactRepo.create({
    name: 'Tessa Lin', contact_type: ['co_owner', 'buyer_referrer'], phone: '555-0104'
  });
  const marcus = await contactRepo.create({
    name: 'Marcus Webb', contact_type: ['buyer_referrer'], phone: '555-0105'
  });
  await contactRepo.archive(marcus.id);

  // Stage 4: buyers are Contacts, not a separate table (Data Model v3 §5.5).
  // Priya buys Hazel (waitlist fulfilled by a delivered sale); Owen exercises the
  // ACTIVE-waitlist prospective demo (active, no Sale record yet); Ellen owns the
  // external females used in the sample stud service and the overdue pairing.
  const priya = await contactRepo.create({
    name: 'Priya Shah', contact_type: ['buyer'], waitlist_status: 'fulfilled',
    first_contact_source: 'Instagram', phone: '555-0106', email: 'priya.shah@example.com',
    // Companion feature (§20): a per-recipient note (Layer 2) shown on this
    // family's share page, overriding the per-type announcement.
    companion_note: 'So glad Hazel found her home with you! Reach out anytime with questions.'
  });
  const owen = await contactRepo.create({
    name: 'Owen Farrow', contact_type: ['buyer'], waitlist_status: 'active',
    first_contact_source: 'Referral', phone: '555-0107',
    // Thread H/G13: Owen is the active-waitlist PROSPECTIVE recipient, so give him
    // an email + a recipient-facing note the prospective share page can carry.
    email: 'owen.farrow@example.com', address: 'Montpelier, VT',
    companion_note: 'Great to have you on the list for the Autumn litter — first pick weekend is coming up!'
  });
  // address (Data Integrity Brief §5): the away-board resolves an in-person
  // stud service's location from the partner contact's address, so Ellen
  // needs one for studServiceBirch below to show a real location, not "—".
  const ellen = await contactRepo.create({
    name: 'Ellen Brooks', contact_type: ['breeder'], phone: '555-0108', address: 'Burlington, VT',
    email: 'ellen.brooks@example.com',
    // companion_note (Thread H/G13): Ellen is the outgoing-stud partner recipient.
    companion_note: 'Looking forward to a lovely litter from Birch and Nell.'
  });
  // Nora — buyer on the Daisy sale (Puppy Record feature demo). Carries a full
  // address so the Puppy Record's Buyer card has every field populated. Her sale
  // is open (deposit_paid), so she is also a CURRENT FAMILY companion recipient.
  const nora = await contactRepo.create({
    name: 'Nora Kim', contact_type: ['buyer'], waitlist_status: 'fulfilled',
    first_contact_source: 'Website', phone: '555-0109', email: 'nora.kim@example.com',
    address: '48 Birchwood Lane, Burlington, VT 05401'
  });
  // Jamal — buyer on the open Autumn-litter sale (Thread C, G2/G9). A full address
  // + companion_note so his current-family share page and the balance math are
  // fully populated.
  const jamal = await contactRepo.create({
    name: 'Jamal Reed', contact_type: ['buyer'], waitlist_status: 'fulfilled',
    first_contact_source: 'Referral', phone: '555-0110', email: 'jamal.reed@example.com',
    address: '12 Maple Court, Lebanon, NH 03766',
    companion_note: 'Can’t wait for you to meet your Autumn puppy — pickup details inside.'
  });
  // Thread H (G13): a groomer and an "other" contact so those contact types have
  // a live record, not just a dropdown entry.
  const grace = await contactRepo.create({
    name: 'Grace Halloran', contact_type: ['groomer'], phone: '555-0111',
    email: 'grace@example.com', address: 'White River Junction, VT'
  });
  const rex = await contactRepo.create({
    name: 'Rex Regional Pet Transport', contact_type: ['other'], phone: '555-0112',
    email: 'dispatch@rexpettransport.example.com'
  });
  // Hugo — owner of the outside Boxer stud (Titan) used for the incoming AI stud
  // service (Thread B, G8); the partner contact on that arrangement.
  const hugo = await contactRepo.create({
    name: 'Hugo Marsh', contact_type: ['breeder'], phone: '555-0113', address: 'Keene, NH'
  });
  manifest.contacts.push(
    patricia.id, dana.id, sam.id, tessa.id, marcus.id, priya.id, owen.id, ellen.id,
    nora.id, jamal.id, grace.id, rex.id, hugo.id
  );

  // Dogs — ancestors first so each generation can reference the last.

  const ash = await dogRepo.create({
    call_name: 'Ash', sex: 'male', breed: BREED,
    date_of_birth: '2016-04-02', date_of_death: '2024-08-15',
    ownership_type: 'owned', status: 'deceased', kennel_id: thornfield.id
  });
  const willow = await dogRepo.create({
    call_name: 'Willow', sex: 'female', breed: BREED,
    date_of_birth: '2017-09-14',
    ownership_type: 'owned', status: 'retired_breeding', kennel_id: thornfield.id
  });
  await dogRepo.archive(willow.id);

  // Clover — a retired Boston female past breeding age, now being placed in a pet
  // home. `status: 'for_sale'` (Phase 4 acceptance pass, §7 enum coverage): distinct
  // from `retired_breeding` (still with the program) — she's actively listed, not
  // just retired. No sire/dam recorded, same as several other adults here (Percy,
  // Nell, Dahlia, Titan, Sage).
  const clover = await dogRepo.create({
    call_name: 'Clover', sex: 'female', breed: BREED,
    date_of_birth: '2018-02-11',
    ownership_type: 'owned', status: 'for_sale', kennel_id: thornfield.id
  });

  // Juniper carries a recorded COI (Stage 5 §9) — genomic, from Embark. It's a
  // user-attested value on the Dog record, not computed by the app. planned_tests
  // + url (Thread A/G6): a photo pointer (external URL, D4) and a planned-test
  // plan that unions with Thornfield.preferred_tests in the test combobox.
  const juniper = await dogRepo.create({
    call_name: 'Juniper', sex: 'female', breed: BREED,
    date_of_birth: '2019-11-03', sire_id: ash.id, dam_id: willow.id,
    registered_name: 'Thornfield Midnight Juniper', registration_number: 'AKC WS71029304',
    microchip_id: '985141000123456', color_markings: 'Black & white, seal points', registry: 'AKC',
    url: 'https://images.example.com/thornfield/juniper.jpg',
    planned_tests: ['OFA Patella', 'Companion Animal Eye Exam (CAER)'],
    ownership_type: 'owned', status: 'active_breeding', kennel_id: thornfield.id,
    recorded_coi: { value: 6.25, method: 'genomic', source: 'Embark', as_of_date: '2023-03-01' }
  });

  // Gunnar is external, owned by Dana Ruiz. Both his breeder_kennel_id and his
  // kennel_id point at Meadow Ridge (Dana's outside kennel) — external dogs can
  // now be linked to their kennel, exercising a non-own kennel_id on the dog form
  // and in the wizard tour. His recorded COI uses a DIFFERENT method/source
  // (pedigree, AKC 5-gen) so the mixed-provenance display is exercised (Stage 5 §9).
  const gunnar = await dogRepo.create({
    call_name: 'Gunnar', sex: 'male', breed: BREED,
    date_of_birth: '2018-06-01', dob_is_estimated: true,
    registered_name: 'Meadow Ridge Maximus Gunnar', registration_number: 'AKC WS78341201',
    microchip_id: '985141000456789', color_markings: 'Seal & white, Irish marked', registry: 'AKC',
    ownership_type: 'external', owner_contact_id: dana.id, status: 'external_reference',
    breeder_kennel_id: meadowRidge.id, kennel_id: meadowRidge.id,
    recorded_coi: { value: 4.1, method: 'pedigree', source: 'AKC 5-gen', as_of_date: '2022-11-15' }
  });

  // Ivy — a second owned Boston dam (Thread A): the dam of the current "Autumn"
  // litter, so Juniper isn't the only breeding female. planned_tests + url (G6).
  const ivy = await dogRepo.create({
    call_name: 'Ivy', sex: 'female', breed: BREED,
    date_of_birth: '2021-05-10',
    registered_name: 'Thornfield Wild Ivy', registration_number: 'AKC WS84550012',
    microchip_id: '985141000223344', color_markings: 'Seal brindle & white', registry: 'AKC',
    url: 'https://images.example.com/thornfield/ivy.jpg',
    planned_tests: ['OFA Patella', 'BAER Hearing'],
    ownership_type: 'owned', status: 'active_breeding', kennel_id: thornfield.id
  });

  // Pairing P1 — the actual, whelped breeding that produced Fern/Birch/Hazel.
  const pairingP1 = await pairingRepo.create({
    sire_id: gunnar.id, dam_id: juniper.id, pairing_type: 'actual', method: 'natural',
    status: 'whelped', planned_date: '2025-06-18', expected_due_date: '2025-08-20'
  });

  // Litter 1 — the founding Boston litter (Fern/Birch/Hazel). dam/sire authoritative
  // on the litter; pairing_id links back to P1 (data model §5.4). Status SOLD with
  // one puppy (Fern) still `available`: her placement fell through, so she is on
  // the roster again — this drives the litter→reopen nudge (§19). Thread G(7).
  const litter = await litterRepo.create({
    pairing_id: pairingP1.id, dam_id: juniper.id, sire_id: gunnar.id, nickname: 'Summer litter',
    whelp_date: '2025-08-20', litter_registration_number: 'THORN-L-2025-01',
    puppies_born_total: 3, puppies_born_alive: 3, puppies_born_deceased: 0, puppies_born_abnormalities: 0,
    status: 'sold'
  });

  // Fern/Birch/Hazel carry breeder_kennel_id: thornfield.id — Juniper (their dam)
  // is an owned dog whose own kennel_id is Thornfield, exercising the
  // dam-is-my-dog auto-prefill (dog.js / puppyForm.js) rather than a manual set.
  // Fern — `available` again on a SOLD litter (see litter above): the reopen-nudge
  // anchor. url (G6): a puppy photo for the companion prospective/family bundle.
  const fern = await dogRepo.create({
    call_name: 'Fern', sex: 'female', breed: BREED,
    date_of_birth: '2025-08-20', sire_id: gunnar.id, dam_id: juniper.id, litter_id: litter.id,
    url: 'https://images.example.com/thornfield/fern.jpg',
    ownership_type: 'owned', status: 'puppy', disposition: 'available', kennel_id: thornfield.id,
    breeder_kennel_id: thornfield.id
  });
  const birch = await dogRepo.create({
    call_name: 'Birch', sex: 'male', breed: BREED,
    date_of_birth: '2025-08-20', sire_id: gunnar.id, dam_id: juniper.id, litter_id: litter.id,
    ownership_type: 'owned', status: 'active_breeding', kennel_id: thornfield.id,
    breeder_kennel_id: thornfield.id
  });
  const hazel = await dogRepo.create({
    call_name: 'Hazel', sex: 'female', breed: BREED,
    date_of_birth: '2025-08-20', sire_id: gunnar.id, dam_id: juniper.id, litter_id: litter.id,
    ownership_type: 'owned', status: 'pet_home', kennel_id: thornfield.id,
    breeder_kennel_id: thornfield.id
  });

  // Poppy — a female Thornfield kept back for breeding but not yet promoted. Old
  // enough (past Thornfield's female promote threshold) but still `status: puppy`
  // with `disposition: keeping`, so she surfaces the PROMOTE-LIFECYCLE nudge
  // (§19/§4.3). Thread F. Relative DOB so she stays "old enough" on any seed day.
  const poppy = await dogRepo.create({
    call_name: 'Poppy', sex: 'female', breed: BREED,
    date_of_birth: monthsFromToday(-12),
    ownership_type: 'owned', status: 'puppy', disposition: 'keeping', kennel_id: thornfield.id,
    breeder_kennel_id: thornfield.id
  });

  // Litter 2 + Daisy (Puppy Record feature demo) — a second, standalone litter
  // off Juniper × Gunnar, deliberately with no Pairing behind it (pairing_id is
  // nullable). Status `ready` with Daisy `placed` (her whole roster is one pup,
  // spoken for) drives the litter→sold nudge (§19). Daisy carries every Dog field
  // the Puppy Record can show, and her health history (below) touches all twelve
  // health-relevant event types so the printed record's per-type cards all fill.
  const litter2 = await litterRepo.create({
    dam_id: juniper.id, sire_id: gunnar.id, nickname: 'Spring litter',
    whelp_date: '2026-03-02', litter_registration_number: 'THORN-L-2026-01',
    puppies_born_total: 1, puppies_born_alive: 1, puppies_born_deceased: 0, puppies_born_abnormalities: 1,
    status: 'ready'
  });
  const daisy = await dogRepo.create({
    call_name: 'Daisy', sex: 'female', breed: BREED,
    date_of_birth: '2026-03-02', sire_id: gunnar.id, dam_id: juniper.id, litter_id: litter2.id,
    registered_name: 'Thornfield Daisy Mae', registration_number: 'AKC WS99213045',
    microchip_id: '985141000998877', color_markings: 'Brindle & white, split face', registry: 'AKC',
    ownership_type: 'owned', status: 'puppy', disposition: 'placed', kennel_id: thornfield.id,
    breeder_kennel_id: thornfield.id
  });

  // The current "Autumn" litter (Thread A, G3/G4) — Ivy × Gunnar, whelped ~9 weeks
  // ago, status `ready`, priced per sex, with a nickname and an accept-deposits
  // date. Relative dates so it reads as "now-ish" on any seed day. This is the
  // priced, actively-selling litter behind Today's Active-litters card, the
  // prospective companion bundle, and the open Autumn sale below.
  const pairingP4 = await pairingRepo.create({
    sire_id: gunnar.id, dam_id: ivy.id, pairing_type: 'actual', method: 'natural',
    status: 'whelped', planned_date: daysFromToday(-126), expected_due_date: daysFromToday(-63)
  });
  const autumnLitter = await litterRepo.create({
    pairing_id: pairingP4.id, dam_id: ivy.id, sire_id: gunnar.id, nickname: 'Autumn litter',
    whelp_date: daysFromToday(-63), estimated_ready_date: daysFromToday(-7),
    accept_deposits_date: daysFromToday(-30), litter_registration_number: 'THORN-L-2026-02',
    puppies_born_total: 3, puppies_born_alive: 3, puppies_born_deceased: 0, puppies_born_abnormalities: 0,
    expected_price_male: 2800, expected_price_female: 3000,
    expected_deposit_male: 500, expected_deposit_female: 500,
    status: 'ready'
  });
  // Autumn puppies: one available (feeds the prospective bundle + Active-litters
  // card), one placed on an OPEN sale (Thread C), one kept.
  const wrenPup = await dogRepo.create({
    call_name: 'Wren', sex: 'female', breed: BREED,
    date_of_birth: daysFromToday(-63), sire_id: gunnar.id, dam_id: ivy.id, litter_id: autumnLitter.id,
    url: 'https://images.example.com/thornfield/wren.jpg',
    ownership_type: 'owned', status: 'puppy', disposition: 'available', kennel_id: thornfield.id,
    breeder_kennel_id: thornfield.id
  });
  const cedarPup = await dogRepo.create({
    call_name: 'Cedar', sex: 'male', breed: BREED,
    date_of_birth: daysFromToday(-63), sire_id: gunnar.id, dam_id: ivy.id, litter_id: autumnLitter.id,
    ownership_type: 'owned', status: 'puppy', disposition: 'placed', kennel_id: thornfield.id,
    breeder_kennel_id: thornfield.id
  });
  // Aster carries `disposition: 'undecided'` (Phase 4 acceptance pass, §7 enum
  // coverage): not yet designated keep or sell — the one disposition value the
  // rest of the packet didn't anchor anywhere.
  const asterPup = await dogRepo.create({
    call_name: 'Aster', sex: 'female', breed: BREED,
    date_of_birth: daysFromToday(-63), sire_id: gunnar.id, dam_id: ivy.id, litter_id: autumnLitter.id,
    ownership_type: 'owned', status: 'puppy', disposition: 'undecided', kennel_id: thornfield.id,
    breeder_kennel_id: thornfield.id
  });

  const percy = await dogRepo.create({
    call_name: 'Percy', sex: 'male', breed: BREED,
    date_of_birth: '2024-03-10',
    ownership_type: 'co_owned', co_owner_contact_ids: [sam.id, tessa.id], status: 'active_breeding',
    kennel_id: thornfield.id
  });

  // Nell — external female, Ellen Brooks' dog, the partner side of the sample
  // outgoing stud service below. Her kennel identity flows through
  // owner_contact_id, same pattern as Gunnar.
  const nell = await dogRepo.create({
    call_name: 'Nell', sex: 'female', breed: BREED,
    date_of_birth: '2022-05-14', dob_is_estimated: true,
    ownership_type: 'external', owner_contact_id: ellen.id, status: 'external_reference'
  });

  // Dahlia — a second external Boston dam (Ellen's) bred by our co-owned stud
  // Percy. Her pairing is OVERDUE with no litter recorded yet, driving the
  // overdue-pairing nudge (§19). Thread G(5).
  const dahlia = await dogRepo.create({
    call_name: 'Dahlia', sex: 'female', breed: BREED,
    date_of_birth: '2021-08-22', dob_is_estimated: true,
    ownership_type: 'external', owner_contact_id: ellen.id, status: 'external_reference'
  });

  // --- Boxer line (Thread I / D2) — a small second program on the SAME own
  // kennel (no second fake kennel), so the Dogs breed filter and reports show >1
  // breed and Thornfield.preferred_breeds is exercised. ------------------------
  const diesel = await dogRepo.create({
    call_name: 'Diesel', sex: 'male', breed: BOXER,
    date_of_birth: '2021-08-01',
    registered_name: 'Thornfield Diesel Engine', registration_number: 'AKC WS81002233',
    color_markings: 'Fawn, black mask', registry: 'AKC',
    planned_tests: ['Holter Monitor (ARVC)', 'OFA Cardiac (Advanced)'],
    ownership_type: 'owned', status: 'active_breeding', kennel_id: thornfield.id,
    breeder_kennel_id: thornfield.id
  });
  // Juno — our Boxer dam bred by AI to an outside stud (Titan). The incoming AI
  // stud service below is `completed` with no linked pairing yet, driving the
  // stud→pairing nudge (§19/§4.7). Her only pairing (Diesel × Juno) is `failed`
  // (terminal), so it doesn't count against that nudge's dedup.
  const juno = await dogRepo.create({
    call_name: 'Juno', sex: 'female', breed: BOXER,
    date_of_birth: '2022-04-15',
    ownership_type: 'owned', status: 'active_breeding', kennel_id: thornfield.id,
    breeder_kennel_id: thornfield.id
  });
  // Titan — outside Boxer stud (Hugo's), the partner dog on the incoming AI
  // service. External; identity flows through owner_contact_id.
  const titan = await dogRepo.create({
    call_name: 'Titan', sex: 'male', breed: BOXER,
    date_of_birth: '2020-03-01', dob_is_estimated: true,
    ownership_type: 'external', owner_contact_id: hugo.id, status: 'external_reference'
  });
  // Sage — a Boxer dam LEASED IN from Dana for a breeding (Thread D, G5). Owner is
  // required for a leased_in dog (dogRepo), and the lease contract below documents
  // it. Her recent concluded heat (with no pairing yet) drives the heat→pairing
  // nudge (§19/§4.5).
  const sage = await dogRepo.create({
    call_name: 'Sage', sex: 'female', breed: BOXER,
    date_of_birth: '2022-09-20',
    ownership_type: 'leased_in', owner_contact_id: dana.id, status: 'active_breeding'
  });

  manifest.dogs.push(
    ash.id, willow.id, clover.id, juniper.id, gunnar.id, ivy.id,
    fern.id, birch.id, hazel.id, poppy.id, daisy.id,
    wrenPup.id, cedarPup.id, asterPup.id, percy.id, nell.id, dahlia.id,
    diesel.id, juno.id, titan.id, sage.id
  );

  // Pairing P2 — Juniper × Gunnar, planned only, no litter yet. Exercises the
  // "Create Litter from this Pairing" empty state and an empty pairing timeline.
  const pairingP2 = await pairingRepo.create({
    sire_id: gunnar.id, dam_id: juniper.id, pairing_type: 'planned', status: 'planned',
    planned_date: monthsFromToday(4)
  });

  // Pairing P3 — Birch × Nell, the current breeding behind the outgoing stud
  // service (Birch is physically away at Ellen's now). Recently bred, no due date
  // yet, so it is NOT overdue. StudService.pairing_id is the canonical link.
  const pairingP3 = await pairingRepo.create({
    sire_id: birch.id, dam_id: nell.id, pairing_type: 'actual', method: 'ai_chilled',
    status: 'bred', planned_date: daysFromToday(-3)
  });

  // Pairing P5 — Percy × Dahlia, confirmed pregnant and now PAST its expected due
  // date with no litter recorded → overdue-pairing nudge (§19). Thread G(5).
  const pairingP5 = await pairingRepo.create({
    sire_id: percy.id, dam_id: dahlia.id, pairing_type: 'actual', method: 'natural',
    status: 'confirmed_pregnant', planned_date: daysFromToday(-72), expected_due_date: daysFromToday(-9)
  });

  // Pairing P6 — Diesel × Juno, an earlier Boxer breeding that FAILED (didn't
  // take). Terminal status, so it doesn't dedup Juno's stud→pairing nudge; it
  // gives the Boxer line a pairing and exercises PAIRING_STATUS `failed`. Thread I.
  const pairingP6 = await pairingRepo.create({
    sire_id: diesel.id, dam_id: juno.id, pairing_type: 'actual', method: 'natural',
    status: 'failed', planned_date: daysFromToday(-150)
  });

  manifest.pairings.push(
    pairingP1.id, pairingP2.id, pairingP3.id, pairingP4.id, pairingP5.id, pairingP6.id
  );
  manifest.litters.push(litter.id, litter2.id, autumnLitter.id);

  // Litter 3 — an EXPECTED litter with no puppies yet (Thread A, G3): Juniper ×
  // Gunnar off the planned pairing P2. Exercises LITTER_STATUS `expected` and the
  // "no roster yet" litter-detail state. Linked to P2 (also its own dam/sire).
  const expectedLitter = await litterRepo.create({
    pairing_id: pairingP2.id, dam_id: juniper.id, sire_id: gunnar.id, nickname: 'Winter litter',
    litter_registration_number: 'THORN-L-2026-03', status: 'expected'
  });
  manifest.litters.push(expectedLitter.id);

  // --- Foster-IN scenario (version(2), guide §4/§21) — Thornfield is whelping and
  // selling a litter for another breeder (Dana Ruiz / Meadow Ridge) under a foster
  // agreement with a 60/40 income split. Marigold is Dana's dam, in Thornfield's
  // care; the litter is `foster_in` with Dana as the foster partner. The pups are
  // ordinary owned puppies we manage and sell (NOT external_reference) but their
  // breeder_kennel_id is Meadow Ridge (the owner is the breeder of record) — that
  // is exactly what a companion share reveals as the owner kennel. The split payout
  // to Dana and the owner-reimbursable vet cost are seeded as Expenses below.
  const marigold = await dogRepo.create({
    call_name: 'Marigold', sex: 'female', breed: BREED,
    date_of_birth: '2022-04-12', registered_name: 'Meadow Ridge Marigold', registry: 'AKC',
    color_markings: 'Black & white', ownership_type: 'external', owner_contact_id: dana.id,
    status: 'external_reference', breeder_kennel_id: meadowRidge.id, kennel_id: meadowRidge.id
  });
  const fosterLitter = await litterRepo.create({
    dam_id: marigold.id, sire_id: gunnar.id, nickname: 'Meadow Ridge foster litter',
    whelp_date: daysFromToday(-56), estimated_ready_date: daysFromToday(0),
    litter_registration_number: 'MDWR-L-2026-01',
    puppies_born_total: 2, puppies_born_alive: 2, puppies_born_deceased: 0, puppies_born_abnormalities: 0,
    expected_price_male: 2600, expected_price_female: 2800,
    expected_deposit_male: 500, expected_deposit_female: 500,
    status: 'ready',
    foster_direction: 'foster_in', foster_partner_contact_id: dana.id,
    foster_comp_model: 'income_split', foster_our_share_pct: 60, foster_split_basis: 'gross',
    foster_split_notes: '60% to Thornfield / 40% to Meadow Ridge of gross puppy sales; Thornfield fronts rearing costs, vet reimbursable.'
  });
  const bramblePup = await dogRepo.create({
    call_name: 'Bramble', sex: 'male', breed: BREED,
    date_of_birth: daysFromToday(-56), sire_id: gunnar.id, dam_id: marigold.id, litter_id: fosterLitter.id,
    ownership_type: 'owned', status: 'puppy', disposition: 'available', kennel_id: thornfield.id,
    breeder_kennel_id: meadowRidge.id
  });
  const sorrelPup = await dogRepo.create({
    call_name: 'Sorrel', sex: 'female', breed: BREED,
    date_of_birth: daysFromToday(-56), sire_id: gunnar.id, dam_id: marigold.id, litter_id: fosterLitter.id,
    ownership_type: 'owned', status: 'puppy', disposition: 'available', kennel_id: thornfield.id,
    breeder_kennel_id: meadowRidge.id
  });
  manifest.dogs.push(marigold.id, bramblePup.id, sorrelPup.id);
  manifest.litters.push(fosterLitter.id);

  // The foster agreement itself — a `foster` contract reaching the fostered dam
  // (related_dog_id) and the counterparty (related_contact_id), same shape as a
  // lease/co_own. Being live + partner-facing, it puts Dana on the Companion
  // Partners tab too.
  const fosterContract = await contractRepo.create({
    contract_type: 'foster', status: 'signed', signed_date: daysFromToday(-70),
    related_dog_id: marigold.id, related_contact_id: dana.id,
    title: 'Meadow Ridge foster / co-rearing agreement',
    terms_summary: '60/40 split of gross puppy sales; Thornfield rears and places; vet costs reimbursable by Meadow Ridge.'
  });
  manifest.contracts.push(fosterContract.id);

  // --- Stud Service SS1 (outgoing, in-person) — Birch services Nell at Ellen's.
  // Links to Pairing P3 via the canonical pairing_id. `arranged` with a passed
  // sent_date and no returned_date: Birch is physically away right now, so this is
  // the away-board row AND drives the stud-service status nudge ("mark in
  // progress", §19/§4.2). flat_plus_pick with pick_value_amount so the partner
  // companion bundle exercises both a cash fee and a non-cash pick estimate.
  const studServiceBirch = await studServiceRepo.create({
    direction: 'outgoing', our_dog_id: birch.id, partner_dog_id: nell.id, partner_contact_id: ellen.id,
    fee_amount: 800, fee_structure: 'flat_plus_pick', pick_status: 'pending', pick_value_amount: 1500,
    pairing_id: pairingP3.id, type: 'in_person', sent_date: daysFromToday(-3),
    // referred_by (Referral tracking): Dana sent this arrangement our way — the
    // repo auto-tags her contact as a 'stud_referrer'.
    referred_by_contact_id: dana.id,
    status: 'arranged', result_notes: 'Sent to Ellen’s for a natural breeding; awaiting confirmation.'
  });
  const studServiceContract = await contractRepo.create({
    contract_type: 'stud_service', status: 'signed', related_stud_service_id: studServiceBirch.id,
    title: 'Stud Service Agreement — Birch × Nell', signed_date: daysFromToday(-10),
    // document_url (Companion feature §20): a placeholder "anyone with the link"
    // pointer the partner bundle carries.
    document_url: 'https://drive.example.com/thornfield/birch-nell-stud-agreement',
    terms_summary: 'Flat fee plus pick of litter, one breeding attempt, health-tested sire.'
  });
  manifest.stud_services.push(studServiceBirch.id);
  manifest.contracts.push(studServiceContract.id);

  // --- Stud Service SS2 (incoming, AI) — we bred our Boxer dam Juno by shipped
  // semen from Hugo's outside stud Titan (Thread B, G8). `incoming` (our dog is
  // the dam), `ai` (shipped, so it never hits the away-board), flat_fee (money we
  // PAY — an expense, never income). `completed` with NO linked pairing yet →
  // drives the stud→pairing nudge (§19/§4.7). Its signed contract balances the
  // outgoing one above.
  const studServiceJuno = await studServiceRepo.create({
    direction: 'incoming', our_dog_id: juno.id, partner_dog_id: titan.id, partner_contact_id: hugo.id,
    fee_amount: 1200, fee_structure: 'flat_fee', type: 'ai', sent_date: daysFromToday(-25),
    status: 'completed', result_notes: 'Shipped chilled semen, AI performed by repro vet.'
  });
  const studServiceJunoContract = await contractRepo.create({
    contract_type: 'stud_service', status: 'signed', related_stud_service_id: studServiceJuno.id,
    title: 'Stud Service Agreement — Titan × Juno (AI)', signed_date: daysFromToday(-32),
    document_url: 'https://drive.example.com/thornfield/titan-juno-stud-agreement',
    terms_summary: 'Flat fee, one shipment of chilled semen, no live-guarantee re-breed.'
  });
  manifest.stud_services.push(studServiceJuno.id);
  manifest.contracts.push(studServiceJunoContract.id);

  // --- Contracts: a co-ownership and a lease (Thread D, G7) --------------------
  // co_own (status `sent` — the non-signed CONTRACT_STATUS example): documents
  // Percy's co-ownership with Sam. related_dog_id/related_contact_id are the only
  // way a co_own/lease/other contract reaches its dog/counterparty.
  const percyCoOwnContract = await contractRepo.create({
    contract_type: 'co_own', status: 'sent', related_dog_id: percy.id, related_contact_id: sam.id,
    title: 'Co-Ownership Agreement — Percy', signed_date: '',
    terms_summary: 'Shared ownership; show and breeding decisions made jointly.'
  });
  // lease (signed): Sage leased in from Dana with lease dates. Makes Dana a LEASE
  // PARTNER in the Companion (partner membership comes from a live lease/co_own
  // contract with a counterparty), the third companion recipient type.
  const sageLeaseContract = await contractRepo.create({
    contract_type: 'lease', status: 'signed', related_dog_id: sage.id, related_contact_id: dana.id,
    title: 'Breeding Lease — Sage', signed_date: daysFromToday(-40),
    lease_start_date: daysFromToday(-40), lease_end_date: daysFromToday(120),
    document_url: 'https://drive.example.com/thornfield/sage-lease',
    terms_summary: 'One-season breeding lease; pick arrangement per addendum.'
  });
  manifest.contracts.push(percyCoOwnContract.id, sageLeaseContract.id);

  // --- Sales ------------------------------------------------------------------
  // Hazel placed with Priya (pet home, delivered — terminal). Contract owns
  // related_sale_id (canonical); there is no Sale.contract_id.
  const hazelSale = await saleRepo.create({
    dog_id: hazel.id, buyer_contact_id: priya.id, sale_date: '2025-12-20',
    price: 2500, deposit_amount: 500, deposit_date: '2025-11-01', balance_paid_date: '2025-12-20',
    placement_type: 'pet', status: 'delivered', lead_source: 'Instagram',
    // referred_by (Referral tracking): Tessa referred Priya — auto-tags Tessa as
    // a 'buyer_referrer' (she already carries the role in this seed).
    referred_by_contact_id: tessa.id,
    notes: 'Went home with a family in Concord, NH — regular updates from the family.'
  });
  const hazelContract = await contractRepo.create({
    contract_type: 'sale', status: 'signed', related_sale_id: hazelSale.id,
    title: 'Puppy Purchase Agreement — Hazel', signed_date: '2025-12-15',
    document_url: 'https://drive.example.com/thornfield/hazel-purchase-agreement',
    terms_summary: 'Pet-home placement, spay/neuter clause, health guarantee.'
  });
  manifest.sales.push(hazelSale.id);
  manifest.contracts.push(hazelContract.id);

  // Daisy reserved by Nora, deposit paid but NOT delivered (open) — the Puppy
  // Record "Print" picker lists non-delivered sales, and an open sale makes Nora
  // a current-family companion recipient.
  const daisySale = await saleRepo.create({
    dog_id: daisy.id, buyer_contact_id: nora.id, sale_date: '2026-05-20',
    price: 2800, deposit_amount: 600, deposit_date: '2026-04-01',
    placement_type: 'pet', status: 'deposit_paid', lead_source: 'Website',
    notes: 'Reserved — pickup scheduled for late May.'
  });
  const daisyContract = await contractRepo.create({
    contract_type: 'sale', status: 'signed', related_sale_id: daisySale.id,
    title: 'Puppy Purchase Agreement — Daisy', signed_date: '2026-04-01',
    document_url: 'https://drive.example.com/thornfield/daisy-purchase-agreement',
    terms_summary: 'Pet-home placement, spay clause, health guarantee.'
  });
  manifest.sales.push(daisySale.id);
  manifest.contracts.push(daisyContract.id);

  // Cedar (Autumn litter) on an OPEN sale to Jamal (Thread C, G2/G9): deposit
  // paid, a future balance-due date, a transport fee, and deferred pickup boarding
  // — so the family companion bundle's computed remaining-balance math is
  // exercised (price + transport + boarding×units − deposit). A `show` placement
  // type broadens PLACEMENT_TYPE coverage beyond `pet`.
  const cedarSale = await saleRepo.create({
    dog_id: cedarPup.id, buyer_contact_id: jamal.id, sale_date: daysFromToday(-20),
    price: 2800, deposit_amount: 500, deposit_date: daysFromToday(-20), balance_due_date: daysFromToday(21),
    transport_fee: 250,
    deferred_boarding_amount: 25, deferred_boarding_frequency: 'Day', deferred_boarding_duration_days: 10,
    placement_type: 'show', status: 'deposit_paid', lead_source: 'Referral',
    notes: 'Reserved from the Autumn litter; buyer delayed pickup, boarding with us until then.'
  });
  manifest.sales.push(cedarSale.id);

  // Events — spread across all three subject types to cover the catalog.
  const dogEvents = [
    // Juniper — annual vaccines with a now-OVERDUE reminder (Stage 5 §9): the
    // rabies booster reminder has slipped past its date and is still pending.
    { subject_id: juniper.id, event_type: 'vaccination', event_date: '2026-01-10', title: 'Annual vaccines',
      reminder_date: daysFromToday(-10),
      details: { vaccine: 'DHPP + Rabies', lot_number: 'B4471' } },
    { subject_id: juniper.id, event_type: 'heat_cycle', event_date: '2026-02-02', title: 'Heat cycle',
      details: { cycle_start: '2026-02-02' } },
    { subject_id: juniper.id, event_type: 'ofa_pennhip', event_date: '2022-05-19', title: 'Hip evaluation',
      details: { joint: 'Hips', method: 'OFA', rating: 'Good' } },
    { subject_id: juniper.id, event_type: 'title_earned', event_date: '2021-10-03', title: 'Earned CGC',
      details: { title_abbreviation: 'CGC', organization: 'AKC' } },
    { subject_id: juniper.id, event_type: 'genetic_test', event_date: '2023-03-01', title: 'Panel results',
      details: { panel_name: 'Embark Breeder Panel', lab: 'Embark', result: 'Clear' } },
    { subject_id: juniper.id, event_type: 'breed_specific_test', event_date: '2023-03-05', title: 'Patellar luxation screen',
      details: { test_name: 'Patellar Luxation', result: 'Normal' } },
    // Gunnar
    { subject_id: gunnar.id, event_type: 'genetic_test', event_date: '2023-03-01', title: 'Panel results',
      details: { panel_name: 'Embark Breeder Panel', lab: 'Embark', result: 'Clear' } },
    { subject_id: gunnar.id, event_type: 'breed_specific_test', event_date: '2022-11-15', title: 'Patellar luxation screen',
      details: { test_name: 'Patellar Luxation', result: 'Normal' } },
    { subject_id: gunnar.id, event_type: 'title_earned', event_date: '2020-09-12', title: 'Earned JH',
      details: { title_abbreviation: 'JH', organization: 'AKC' } },
    // Diesel — an ACQUISITION event (Thread I/G6/§7): the first event on a dog we
    // bought, with a purchase Cost that writes a `dog_purchase` expense (below).
    { subject_id: diesel.id, event_type: 'acquisition', event_date: '2022-02-14', title: 'Purchased from Ridgeline Boxers',
      details: { source: 'Ridgeline Boxers (Rutland, VT)' } },
    { subject_id: diesel.id, event_type: 'genetic_test', event_date: '2023-06-01', title: 'Panel results',
      details: { panel_name: 'Embark Breeder Panel', lab: 'Embark', result: 'Clear' } },
    // Sage — a concluded HEAT (span with event_end_date in the recent past) and no
    // pairing recorded since → the heat→pairing nudge (§19/§4.5). Thread G(3).
    { subject_id: sage.id, event_type: 'heat_cycle', event_date: daysFromToday(-22), event_end_date: daysFromToday(-15),
      title: 'Heat cycle', details: { notes: 'Standing heat days 9–13; leased in for this breeding.' } },
    // Percy — a completed BOARDING span (Thread E/G11): a grow-out stay with a
    // related contact, showing a span row + related_contact_id on the timeline.
    { subject_id: percy.id, event_type: 'boarding', event_date: daysFromToday(-40), event_end_date: daysFromToday(-33),
      title: 'Boarding — co-owner rotation', related_contact_id: sam.id,
      details: { location: 'Sam Okafor’s (co-owner)', boarding_reason: 'Co-owner rotation', notes: 'Routine time with his co-owner.' } },
    // Percy — future-dated vet_visit with a DUE-SOON reminder (within 30 days).
    { subject_id: percy.id, event_type: 'vet_visit', event_date: '2026-08-15', title: 'Annual checkup',
      reminder_date: daysFromToday(14),
      details: { reason: 'Annual checkup', vet: 'Dr. Patricia Nguyen' } },
    // Fern
    { subject_id: fern.id, event_type: 'milestone', event_date: '2025-10-15', title: 'Eyes open',
      details: { description: 'Eyes open' } },
    { subject_id: fern.id, event_type: 'vaccination', event_date: '2026-05-01', title: 'Puppy shots (2nd round)',
      details: { vaccine: 'DHPP', lot_number: 'C1029' } },
    { subject_id: fern.id, event_type: 'evaluation', event_date: '2026-06-15', title: 'Puppy evaluation',
      details: { evaluator: 'Dr. Patricia Nguyen', temperament_notes: 'Confident, food-motivated.', structure_notes: 'Level topline, good angulation.' } },
    // Fern — a DISMISSED reminder (Stage 5 §9): visible under "Show dismissed".
    { subject_id: fern.id, event_type: 'vaccination', event_date: '2026-06-01', title: 'Rabies booster',
      reminder_date: daysFromToday(20), reminder_dismissed: true,
      details: { vaccine: 'Rabies', lot_number: 'C2210' } },
    // Birch — health-tested after promotion to breeding stock; UPCOMING reminder
    // (beyond 30 days) demonstrating complete-and-chain.
    { subject_id: birch.id, event_type: 'genetic_test', event_date: '2026-06-20', title: 'Panel results',
      details: { panel_name: 'Embark Breeder Panel', lab: 'Embark', result: 'Clear' } },
    { subject_id: birch.id, event_type: 'preventative', event_date: daysFromToday(-2), title: 'Heartworm preventative',
      reminder_date: daysFromToday(90),
      details: { product: 'Heartgard', dose: '1 chew' } },
    // Hazel
    { subject_id: hazel.id, event_type: 'vaccination', event_date: '2026-05-01', title: 'Puppy shots (2nd round)',
      details: { vaccine: 'DHPP', lot_number: 'C1029' } },
    { subject_id: hazel.id, event_type: 'note', event_date: '2025-12-20', title: 'Placed in pet home',
      details: {}, notes: 'Went home with a family in Concord, NH — regular updates from the family.' },
    // Wren (Autumn, available) — early puppy milestones.
    { subject_id: wrenPup.id, event_type: 'milestone', event_date: daysFromToday(-49), title: 'Eyes open',
      details: { description: 'Eyes open' } },
    { subject_id: wrenPup.id, event_type: 'weight_check', event_date: daysFromToday(-7), title: 'Weight check',
      details: { weight_lbs: 3, weight_oz: 8, time_of_day: 'AM' } },
    // Cedar (Autumn, placed) — a SCHEDULED PICKUP placement event next week, with
    // the buyer as related_contact and NO stored Sale link (§D1). Drives Today's
    // "Due outs & upcoming".
    { subject_id: cedarPup.id, event_type: 'placement', event_date: daysFromToday(7), title: 'Scheduled pickup',
      related_contact_id: jamal.id,
      details: { dropoff_method: 'Local pickup', placement_time: '10:00 AM', location: 'Thornfield Kennels', notes: 'Cedar going home with the Reeds.' } },
    // Daisy — all twelve health-relevant event types on one puppy (Puppy Record
    // feature demo), so every per-type card on the printed record has content.
    { subject_id: daisy.id, event_type: 'abnormalities', event_date: '2026-03-02', title: 'Newborn exam finding',
      details: { type: 'Umbilical hernia' } },
    { subject_id: daisy.id, event_type: 'illness', event_date: '2026-03-20', title: 'Mild GI upset',
      details: { diagnosis: 'Dietary indiscretion', treatment: 'Bland diet 3 days, resolved.' } },
    { subject_id: daisy.id, event_type: 'medication', event_date: '2026-03-20', event_end_date: '2026-03-23', title: 'Metronidazole course',
      details: { drug: 'Metronidazole', dose: '50mg', frequency: 'Twice daily' } },
    { subject_id: daisy.id, event_type: 'injury', event_date: '2026-04-05', title: 'Minor toe scrape',
      details: { description: 'Small scrape on left front toe from the yard.', severity: 'Minor' } },
    { subject_id: daisy.id, event_type: 'genetic_test', event_date: '2026-04-10', title: 'Panel results',
      details: { panel_name: 'Embark Breeder Panel', lab: 'Embark', result: 'Clear' } },
    { subject_id: daisy.id, event_type: 'ofa_pennhip', event_date: '2026-04-10', title: 'Preliminary hip screen',
      details: { joint: 'Hips', method: 'PennHIP', rating: 'Within normal limits' } },
    { subject_id: daisy.id, event_type: 'breed_specific_test', event_date: '2026-04-10', title: 'Patellar luxation screen',
      details: { test_name: 'Patellar Luxation', result: 'Normal' } },
    { subject_id: daisy.id, event_type: 'vaccination', event_date: '2026-04-15', title: 'Puppy shots (1st round)',
      details: { vaccine: 'DHPP', lot_number: 'D5521', next_due: '2026-05-15' } },
    { subject_id: daisy.id, event_type: 'preventative', event_date: '2026-04-20', title: 'Deworming',
      details: { product: 'Panacur', dose: '2 mL' } },
    { subject_id: daisy.id, event_type: 'vet_visit', event_date: '2026-04-25', title: 'Puppy wellness exam',
      details: { reason: 'Wellness check', vet: 'Dr. Patricia Nguyen', findings: 'Healthy, on growth curve.' } },
    { subject_id: daisy.id, event_type: 'weight_check', event_date: '2026-05-01', title: 'Weight check',
      details: { weight_lbs: 6, weight_oz: 4, time_of_day: 'AM' } },
    { subject_id: daisy.id, event_type: 'surgery', event_date: '2026-05-10', title: 'Spay',
      details: { procedure: 'Ovariohysterectomy', vet: 'Dr. Patricia Nguyen', outcome: 'Uncomplicated, recovered well.' } }
  ];

  const pairingEvents = [
    { subject_id: pairingP1.id, event_type: 'breeding_tie', event_date: '2025-06-18', title: 'Breeding tie',
      details: { tie_date: '2025-06-18', method: 'Natural' } },
    { subject_id: pairingP1.id, event_type: 'progesterone_test', event_date: '2025-06-10', title: 'Progesterone test',
      details: { value: 15, lab: 'Antech' } },
    { subject_id: pairingP1.id, event_type: 'ultrasound', event_date: '2025-07-16', title: 'Ultrasound',
      details: { confirmed: 'Yes', estimated_count: 3 } },
    { subject_id: pairingP1.id, event_type: 'pregnancy_update', event_date: '2025-07-20', title: 'Pregnancy update',
      details: { note: 'Active, eating well, on schedule for an early-to-mid August whelp.' } },
    // Autumn pairing (P4) — a short timeline so the Autumn litter's pairing reads
    // as a real breeding.
    { subject_id: pairingP4.id, event_type: 'breeding_tie', event_date: daysFromToday(-126), title: 'Breeding tie',
      details: { tie_date: daysFromToday(-126), method: 'Natural' } },
    { subject_id: pairingP4.id, event_type: 'ultrasound', event_date: daysFromToday(-98), title: 'Ultrasound',
      details: { confirmed: 'Yes', estimated_count: 3 } }
  ];

  const litterEvents = [
    { subject_id: litter.id, event_type: 'whelping_summary', event_date: '2025-08-20', title: 'Whelping summary',
      details: { total_born: 3, live_born: 3, notes: 'Uncomplicated whelp, all three nursing well within the hour.' } },
    { subject_id: autumnLitter.id, event_type: 'whelping_summary', event_date: daysFromToday(-63), title: 'Whelping summary',
      details: { total_born: 3, live_born: 3, notes: 'Three healthy pups; Ivy an attentive first-time dam.' } }
  ];

  for (const e of dogEvents) {
    const saved = await HistoryEvent.create({ subject_type: 'dog', ...e });
    manifest.events.push(saved.id);
  }
  for (const e of pairingEvents) {
    const saved = await HistoryEvent.create({ subject_type: 'pairing', ...e });
    manifest.events.push(saved.id);
  }
  for (const e of litterEvents) {
    const saved = await HistoryEvent.create({ subject_type: 'litter', ...e });
    manifest.events.push(saved.id);
  }

  // Financials ledger (Expense) — a spread across all four subject types so the
  // report, the per-subject panels, and the kennel-wide view all have content.
  // One row is captured FROM an event (the canonical expenses.event_id link) to
  // demonstrate the 🔗 tag; a fresh vet_visit event is created to hang it on.
  const vetVisit = await HistoryEvent.create({
    subject_type: 'dog', subject_id: juniper.id, event_type: 'vet_visit',
    event_date: daysFromToday(-20), title: 'Sick visit',
    details: { reason: 'Ear infection', vet: 'Dr. Patricia Nguyen' }
  });
  manifest.events.push(vetVisit.id);

  const expenses = [
    // Kennel-wide overhead (subject_type='kennel') — the whole point of the table.
    { subject_type: 'kennel', subject_id: thornfield.id, amount: 1200, category: 'facility', expense_date: daysFromToday(-45), vendor: 'Whelping barn lease', notes: 'Quarterly' },
    { subject_type: 'kennel', subject_id: thornfield.id, amount: 340.50, category: 'food', expense_date: daysFromToday(-30), vendor: 'Chewy', notes: 'Bulk kibble' },
    { subject_type: 'kennel', subject_id: thornfield.id, amount: 65, category: 'registration', expense_date: daysFromToday(-60), vendor: 'AKC', notes: 'Kennel name renewal' },
    { subject_type: 'kennel', subject_id: thornfield.id, amount: 120, category: 'marketing', expense_date: daysFromToday(-15), vendor: 'Website hosting', notes: 'Annual' },
    // Dog- and litter-level costs.
    { subject_type: 'dog', subject_id: juniper.id, amount: 199, category: 'testing', expense_date: '2023-03-01', vendor: 'Embark', notes: 'Breeder panel' },
    { subject_type: 'litter', subject_id: litter.id, amount: 210.75, category: 'supplies', expense_date: '2025-08-25', vendor: 'Whelping supplies', notes: 'Pads, scale, ID collars' },
    // Pairing-subject expense (Thread H/G14) — progesterone timing for the Autumn
    // breeding, attached to its pairing.
    { subject_type: 'pairing', subject_id: pairingP4.id, amount: 90, category: 'testing', expense_date: daysFromToday(-130), vendor: 'Green Mountain Vet', notes: 'Progesterone timing' },
    // dog_purchase (Thread I/G6/§7) — Diesel's acquisition cost, category captured
    // from his acquisition event's Cost field.
    { subject_type: 'dog', subject_id: diesel.id, amount: 2500, category: 'dog_purchase', expense_date: '2022-02-14', vendor: 'Ridgeline Boxers', notes: 'Purchase of Diesel' },
    // Captured-from-event row (links back to the vet visit above).
    { event_id: vetVisit.id, subject_type: 'dog', subject_id: juniper.id, amount: 145, category: 'veterinary', expense_date: daysFromToday(-20), vendor: 'Green Mountain Vet', notes: 'Exam + medication' },
    // Foster-in ledger (guide §21): the split payout to the owner is a real
    // Expense (money leaving our program), so it flows into the litter P&L as cost
    // and needs no income machinery. Two owner-reimbursable rearing costs show both
    // states — one already reimbursed (washes out of net), one still pending (a
    // receivable on the Litter P&L's "Owed back" column).
    { subject_type: 'litter', subject_id: fosterLitter.id, amount: 640, category: 'foster_split', expense_date: daysFromToday(-2), vendor: 'Meadow Ridge Kennels', notes: 'Owner share (40%) of deposits received to date' },
    { subject_type: 'litter', subject_id: fosterLitter.id, amount: 220, category: 'veterinary', expense_date: daysFromToday(-40), vendor: 'Green Mountain Vet', reimbursable: true, reimbursed_date: daysFromToday(-20), notes: 'Dam prenatal + whelp check — reimbursed by owner' },
    { subject_type: 'litter', subject_id: fosterLitter.id, amount: 130, category: 'food', expense_date: daysFromToday(-25), vendor: 'Chewy', reimbursable: true, notes: 'Puppy food — awaiting owner reimbursement' }
  ];
  for (const x of expenses) {
    const saved = await expenseRepo.create(x);
    manifest.expenses.push(saved.id);
  }

  // Companion messaging (§20): seed the per-type templates so the demo's share
  // pages have Thornfield branding. These are localStorage config (not manifest
  // records); clearSampleData resets them back to defaults alongside the records.
  seedCompanionSettings();

  // Named ids (Wizard Runtime Spec v1 §3.2) — the guided tour's step catalog is a
  // static import (data/wizardSteps.js) that hard-names anchor records in its copy
  // ("Juniper", "the Autumn litter", …) but still needs the *current* seed's real
  // ids to build detail-page links. Rather than re-querying the database at
  // runtime, it reads this map off the manifest the seed just wrote — deterministic
  // per-seed, no schema, no extra Dexie read.
  manifest.named = {
    juniper: juniper.id, ivy: ivy.id, gunnar: gunnar.id, daisy: daisy.id, diesel: diesel.id,
    poppy: poppy.id, sage: sage.id, aster: asterPup.id, percy: percy.id, fern: fern.id,
    wren: wrenPup.id, cedar: cedarPup.id, birch: birch.id, hazel: hazel.id, clover: clover.id,
    willow: willow.id, nell: nell.id, dahlia: dahlia.id, juno: juno.id, titan: titan.id, ash: ash.id,
    thornfield: thornfield.id, meadowRidge: meadowRidge.id,
    priya: priya.id, owen: owen.id, ellen: ellen.id, jamal: jamal.id, dana: dana.id,
    tessa: tessa.id, grace: grace.id, rex: rex.id, nora: nora.id, marcus: marcus.id,
    sam: sam.id, hugo: hugo.id, patricia: patricia.id,
    summerLitter: litter.id, springLitter: litter2.id, autumnLitter: autumnLitter.id, winterLitter: expectedLitter.id,
    marigold: marigold.id, bramble: bramblePup.id, sorrel: sorrelPup.id, fosterLitter: fosterLitter.id, fosterContract: fosterContract.id,
    pairingP1: pairingP1.id, pairingP2: pairingP2.id, pairingP3: pairingP3.id,
    pairingP4: pairingP4.id, pairingP5: pairingP5.id, pairingP6: pairingP6.id,
    hazelSale: hazelSale.id, daisySale: daisySale.id, cedarSale: cedarSale.id,
    studServiceBirch: studServiceBirch.id, studServiceJuno: studServiceJuno.id,
    hazelContract: hazelContract.id, daisyContract: daisyContract.id,
    studServiceContract: studServiceContract.id, studServiceJunoContract: studServiceJunoContract.id,
    percyCoOwnContract: percyCoOwnContract.id, sageLeaseContract: sageLeaseContract.id
  };

  setSampleDataManifest(manifest);
  return manifest;
}

// Layer-1 companion config for the demo — Thornfield identity across all three
// recipient types, keeping each type's default introText. Reset in
// clearSampleData via resetCompanionSettings().
function seedCompanionSettings() {
  for (const type of COMPANION_TYPES) {
    setCompanionSettings(type, { kennelName: 'Thornfield Kennels', tagline: 'Boston Terriers & Boxers · Est. 2015' });
  }
}

function resetCompanionSettings() {
  for (const type of COMPANION_TYPES) {
    setCompanionSettings(type, { kennelName: '', tagline: '', announcement: '' });
  }
}

// --- Clearing -----------------------------------------------------------

const ENTITY_REPOS = {
  dog: dogRepo, pairing: pairingRepo, litter: litterRepo,
  sale: saleRepo, stud_service: studServiceRepo
};
const ENTITY_REGISTRIES = {
  dog: DOG_REFERENCES, pairing: PAIRING_REFERENCES, litter: LITTER_REFERENCES,
  sale: SALE_REFERENCES, stud_service: STUD_SERVICE_REFERENCES
};

// Human-readable label for a conflict message. Dogs already have a name; a
// pairing/litter/sale/stud-service doesn't, so build one from its own fields
// the same way the UI's own title does.
async function labelFor(entityType, id) {
  if (entityType === 'dog') {
    const d = await db.dogs.get(id);
    return d ? d.call_name : id;
  }
  if (entityType === 'sale') {
    const s = await db.sales.get(id);
    if (!s) return id;
    const [dog, buyer] = await Promise.all([db.dogs.get(s.dog_id), db.contacts.get(s.buyer_contact_id)]);
    return `Sale (${dog?.call_name || '—'} → ${buyer?.name || '—'})`;
  }
  if (entityType === 'stud_service') {
    const s = await db.stud_services.get(id);
    if (!s) return id;
    const [ours, partner] = await Promise.all([db.dogs.get(s.our_dog_id), db.dogs.get(s.partner_dog_id)]);
    return `StudService (${ours?.call_name || '—'} × ${partner?.call_name || '—'})`;
  }
  const row = await db.table(entityType === 'pairing' ? 'pairings' : 'litters').get(id);
  if (!row) return id;
  const [sire, dam] = await Promise.all([db.dogs.get(row.sire_id), db.dogs.get(row.dam_id)]);
  const label = `${sire?.call_name || '—'} × ${dam?.call_name || '—'}`;
  return entityType === 'pairing' ? `Pairing (${label})` : `Litter (${label})`;
}

// Contamination check (brief §5.2): find any real (non-manifest) record that
// now points at a manifest Dog/Pairing/Litter/Sale/StudService via one of the
// reference registries. Reuses the same registries the live hard-delete guard
// uses, so this stays accurate as more reference kinds are added. Contract is
// never checked here — CONTRACT_REFERENCES is empty (a leaf), so a manifest
// contract can never be contaminated.
async function findContaminatingReferences(manifest) {
  const manifestSets = {
    dogs: new Set(manifest.dogs),
    events: new Set(manifest.events || []),
    pairings: new Set(manifest.pairings || []),
    litters: new Set(manifest.litters || []),
    sales: new Set(manifest.sales || []),
    stud_services: new Set(manifest.stud_services || []),
    contracts: new Set(manifest.contracts || []),
    // Sample expenses point at manifest dogs/litters/pairings/kennels via
    // subject_id — list them here so the demo's OWN expenses aren't mistaken for
    // real (contaminating) references during clear.
    expenses: new Set(manifest.expenses || [])
  };

  // conflicts: Map key `${entityType}:${id}` -> { entityType, id, refs: [{label, row}] }
  const conflicts = new Map();

  for (const [entityType, ids] of [
    ['dog', manifest.dogs], ['pairing', manifest.pairings || []], ['litter', manifest.litters || []],
    ['sale', manifest.sales || []], ['stud_service', manifest.stud_services || []]
  ]) {
    const registry = ENTITY_REGISTRIES[entityType];
    for (const id of ids) {
      const blockers = await findBlockingReferences(registry, id);
      if (blockers.length === 0) continue;
      const real = [];
      for (const ref of registry) {
        const table = db.table(ref.table);
        const rows = ref.compoundIndex
          ? await table.where(ref.compoundIndex).equals([ref.discriminatorValue, id]).toArray()
          : await table.where(ref.field).equals(id).toArray();
        const manifestSet = manifestSets[ref.table] || new Set();
        for (const row of rows) {
          if (!manifestSet.has(row.id)) real.push({ label: ref.label, row });
        }
      }
      if (real.length) conflicts.set(`${entityType}:${id}`, { entityType, id, refs: real });
    }
  }
  return conflicts;
}

// clearSampleData({ archiveConflicting }):
//   - dry run (default): reports what's blocking, deletes nothing if blocked.
//   - archiveConflicting: true archives the conflicting sample records instead
//     of deleting them, then proceeds to delete everything else in the manifest.
export async function clearSampleData({ archiveConflicting = false } = {}) {
  const manifest = getSampleDataManifest();
  if (!manifest) return { cleared: false, reason: 'none', counts: {} };
  // Defensive: treat any missing array key as empty, in case of a future
  // partial-seed failure or a manifest written by an older app version.
  manifest.pairings = manifest.pairings || [];
  manifest.litters = manifest.litters || [];
  manifest.sales = manifest.sales || [];
  manifest.contracts = manifest.contracts || [];
  manifest.stud_services = manifest.stud_services || [];
  manifest.expenses = manifest.expenses || [];

  const conflicts = await findContaminatingReferences(manifest);

  if (conflicts.size > 0 && !archiveConflicting) {
    const details = [];
    for (const { entityType, id, refs } of conflicts.values()) {
      const label = await labelFor(entityType, id);
      for (const r of refs) details.push(`${label} is ${r.label}`);
    }
    return { cleared: false, reason: 'contaminated', conflicts: details, counts: {} };
  }

  // Archive conflicting records (grouped by entity type), tracking which ids
  // to exclude from the bulk delete below.
  const archivedIds = { dog: [], pairing: [], litter: [], sale: [], stud_service: [] };
  if (conflicts.size > 0) {
    for (const { entityType, id } of conflicts.values()) {
      await ENTITY_REPOS[entityType].archive(id);
      archivedIds[entityType].push(id);
    }
  }

  const dogIdsToDelete = manifest.dogs.filter((id) => !archivedIds.dog.includes(id));
  const pairingIdsToDelete = manifest.pairings.filter((id) => !archivedIds.pairing.includes(id));
  const litterIdsToDelete = manifest.litters.filter((id) => !archivedIds.litter.includes(id));
  const saleIdsToDelete = manifest.sales.filter((id) => !archivedIds.sale.includes(id));
  const studServiceIdsToDelete = manifest.stud_services.filter((id) => !archivedIds.stud_service.includes(id));

  const counts = {
    expenses: manifest.expenses.length,
    events: manifest.events.length,
    litters: litterIdsToDelete.length,
    pairings: pairingIdsToDelete.length,
    stud_services: studServiceIdsToDelete.length,
    sales: saleIdsToDelete.length,
    contracts: manifest.contracts.length,
    dogs: dogIdsToDelete.length,
    contacts: manifest.contacts.length,
    kennels: manifest.kennels.length,
    archived: archivedIds.dog.length + archivedIds.pairing.length + archivedIds.litter.length
      + archivedIds.sale.length + archivedIds.stud_service.length
  };

  // Dependency order: events -> contracts -> litters -> stud_services ->
  // pairings -> sales -> dogs -> contacts -> kennels. Contract references
  // sales/stud_services so it must clear first (it's a leaf itself — nothing
  // ever references a Contract, so it's never in archivedIds). Litters and
  // stud_services reference pairings/dogs, sales reference dogs/contacts, so
  // all of those clear before dogs/contacts. This is a known, self-contained,
  // unreferenced set, so it bypasses the single-record hardDelete guard (which
  // exists to protect one record at a time, not to bulk-clear a whole known
  // set — brief §5).
  await db.transaction('rw', db.expenses, db.events, db.contracts, db.litters, db.stud_services, db.pairings, db.sales, db.dogs, db.contacts, db.kennels, async () => {
    // Expenses first: they point at events AND dogs/litters/pairings/kennels, so
    // they must clear before any of those (same dependency discipline as below).
    if (manifest.expenses.length) await db.expenses.bulkDelete(manifest.expenses);
    if (manifest.events.length) await db.events.bulkDelete(manifest.events);
    if (manifest.contracts.length) await db.contracts.bulkDelete(manifest.contracts);
    if (litterIdsToDelete.length) await db.litters.bulkDelete(litterIdsToDelete);
    if (studServiceIdsToDelete.length) await db.stud_services.bulkDelete(studServiceIdsToDelete);
    if (pairingIdsToDelete.length) await db.pairings.bulkDelete(pairingIdsToDelete);
    if (saleIdsToDelete.length) await db.sales.bulkDelete(saleIdsToDelete);
    if (dogIdsToDelete.length) await db.dogs.bulkDelete(dogIdsToDelete);
    if (manifest.contacts.length) await db.contacts.bulkDelete(manifest.contacts);
    if (manifest.kennels.length) await db.kennels.bulkDelete(manifest.kennels);
  });

  removeSampleDataManifest();
  resetCompanionSettings();
  markSampleDataCleared();

  return { cleared: true, counts };
}
