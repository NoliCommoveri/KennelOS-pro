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
import { waitlistEntryRepo } from './waitlistEntryRepo.js';
import { waitlistOfferRepo } from './waitlistOfferRepo.js';
import { waitlistProgramRepo } from './waitlistProgramRepo.js';
import { accountRepo } from './accountRepo.js';
import { editionFlags } from './editionConfig.js';
import { monthsFromToday, daysFromToday } from './dateUtils.js';
import { planDetach, removeDetaching } from './recordDetach.js';
import {
  getSampleDataManifest,
  hasSampleData,
  setSampleDataManifest,
  removeSampleDataManifest,
  wasSampleDataCleared,
  markSampleDataCleared,
  setCompanionSettings,
  COMPANION_TYPES,
  clearGuidedDrafts,
  getMyKennelId,
  setNavKennels
} from './settings.js';

export { getSampleDataManifest };

export { hasSampleData }; // one localStorage read, in settings.js

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
    sales: [], contracts: [], stud_services: [], expenses: [],
    waitlist_programs: [], waitlist_entries: [], waitlist_offers: [], accounts: []
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
    promote_nudge_enabled: true, promote_age_male_months: 14, promote_age_female_months: 11,
    // Her usual extras (guide §21.2): what a sale's "Add an extra charge" offers.
    extra_charge_list: [
      { id: crypto.randomUUID(), label: 'Gold photo package', amount: 150, group: 'Photo packages' },
      { id: crypto.randomUUID(), label: 'Birth-to-8-weeks video', amount: 75, group: 'Photo packages' },
      { id: crypto.randomUUID(), label: 'Puppy training (2 weeks)', amount: 600, group: 'Training', boarding_days: 14,
        description: 'Crate, potty and leash basics before going home', family_can_request: true }
    ],
    extra_charge_groups: [
      // Photo packages are paid on their own dates, never on a sale's payment schedule.
      { name: 'Photo packages', request_until_weeks: 6, cancel_until_weeks: 5, own_due_dates: true },
      { name: 'Training', request_from_weeks: 7, cancel_until_weeks: 8,
        payment_plan: [{ percent: 50, due: 'at_weeks', n: 8 }, { percent: 50, due: 'with_balance' }] }
    ],
    // A saved payment schedule (Payment Schedule plan §3.4) and what she takes for the
    // final payment.
    payment_schedules: [{ id: crypto.randomUUID(), name: 'Transported pup', steps: [
      { id: 'w7', due: 'at_weeks', n: 7, covers: ['all'], percent: 100, basis: 'total' }
    ] }],
    final_payment_methods: 'Cash or Zelle only'
  });
  const meadowRidge = await kennelRepo.create({
    kennel_name: 'Meadow Ridge Kennels', prefix: 'MDWR', location: 'Concord, NH', is_own_kennel: false
  });
  manifest.kennels.push(thornfield.id, meadowRidge.id);

  // Contacts
  const patricia = await contactRepo.create({
    name: 'Dr. Patricia Nguyen', contact_type: ['vet'], phone: '555-0101',
    address: 'Valley Animal Hospital\n42 Elm Street, Concord, NH 03301'
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
  // Lauren — Birch's professional handler (Show Tracking Spec §9): the
  // related_contact on his show entries, tagged with the `handler` role.
  const lauren = await contactRepo.create({
    name: 'Lauren Pike', contact_type: ['handler'], phone: '555-0114', address: 'Northampton, MA'
  });
  manifest.contacts.push(
    patricia.id, dana.id, sam.id, tessa.id, marcus.id, priya.id, owen.id, ellen.id,
    nora.id, jamal.id, grace.id, rex.id, hugo.id, lauren.id
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
    registered_name: 'Thornfield Midnight Juniper', registration_number: 'WS71029304',
    microchip_id: '985141000123456', color_markings: 'Black & white, seal points', registry: 'AKC',
    additional_registrations: [{ registry: 'UKC', registration_number: 'P1048-221', registered_name: '' }],
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
    registered_name: 'Meadow Ridge Maximus Gunnar', registration_number: 'WS78341201',
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
    registered_name: 'Thornfield Wild Ivy', registration_number: 'WS84550012',
    microchip_id: '985141000223344', color_markings: 'Seal brindle & white', registry: 'AKC',
    url: 'https://images.example.com/thornfield/ivy.jpg',
    planned_tests: ['OFA Patella', 'BAER Hearing'],
    ownership_type: 'owned', status: 'active_breeding', kennel_id: thornfield.id
  });

  // Pairing P1 — the actual, whelped breeding that produced Fern/Birch/Hazel.
  const pairingP1 = await pairingRepo.create({
    kennel_id: thornfield.id,
    sire_id: gunnar.id, dam_id: juniper.id, pairing_type: 'actual', method: 'natural',
    status: 'whelped', planned_date: '2025-06-18', expected_due_date: '2025-08-20'
  });

  // Litter 1 — the founding Boston litter (Fern/Birch/Hazel). dam/sire authoritative
  // on the litter; pairing_id links back to P1 (data model §5.4). Status SOLD with
  // one puppy (Fern) still `available`: her placement fell through, so she is on
  // the roster again — this drives the litter→reopen nudge (§19). Thread G(7).
  const litter = await litterRepo.create({
    kennel_id: thornfield.id,
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
    kennel_id: thornfield.id,
    dam_id: juniper.id, sire_id: gunnar.id, nickname: 'Spring litter',
    whelp_date: '2026-03-02', litter_registration_number: 'THORN-L-2026-01',
    puppies_born_total: 1, puppies_born_alive: 1, puppies_born_deceased: 0, puppies_born_abnormalities: 1,
    status: 'ready'
  });
  const daisy = await dogRepo.create({
    call_name: 'Daisy', sex: 'female', breed: BREED,
    date_of_birth: '2026-03-02', sire_id: gunnar.id, dam_id: juniper.id, litter_id: litter2.id,
    registered_name: 'Thornfield Daisy Mae', registration_number: 'WS99213045',
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
    kennel_id: thornfield.id,
    sire_id: gunnar.id, dam_id: ivy.id, pairing_type: 'actual', method: 'natural',
    status: 'whelped', planned_date: daysFromToday(-126), expected_due_date: daysFromToday(-63)
  });
  const autumnLitter = await litterRepo.create({
    kennel_id: thornfield.id,
    pairing_id: pairingP4.id, dam_id: ivy.id, sire_id: gunnar.id, nickname: 'Autumn litter',
    whelp_date: daysFromToday(-63), estimated_ready_date: daysFromToday(-7),
    accept_deposits_date: daysFromToday(-30), litter_registration_number: 'THORN-L-2026-02',
    puppies_born_total: 3, puppies_born_alive: 3, puppies_born_deceased: 0, puppies_born_abnormalities: 0,
    expected_price_male: 2800, expected_price_female: 3000,
    expected_deposit_male: 500, expected_deposit_female: 500,
    full_reg_surcharge_male: 1000, full_reg_surcharge_female: 1500,
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
    registered_name: 'Thornfield Diesel Engine', registration_number: 'WS81002233',
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
    kennel_id: thornfield.id,
    sire_id: gunnar.id, dam_id: juniper.id, pairing_type: 'planned', status: 'planned',
    planned_date: monthsFromToday(4)
  });

  // Pairing P3 — Birch × Nell, the current breeding behind the outgoing stud
  // service (Birch is physically away at Ellen's now). Recently bred, no due date
  // yet, so it is NOT overdue. StudService.pairing_id is the canonical link.
  const pairingP3 = await pairingRepo.create({
    kennel_id: thornfield.id,
    sire_id: birch.id, dam_id: nell.id, pairing_type: 'actual', method: 'ai_chilled',
    status: 'bred', planned_date: daysFromToday(-3)
  });

  // Pairing P5 — Percy × Dahlia, confirmed pregnant and now PAST its expected due
  // date with no litter recorded → overdue-pairing nudge (§19). Thread G(5).
  const pairingP5 = await pairingRepo.create({
    kennel_id: thornfield.id,
    sire_id: percy.id, dam_id: dahlia.id, pairing_type: 'actual', method: 'natural',
    status: 'confirmed_pregnant', planned_date: daysFromToday(-72), expected_due_date: daysFromToday(-9)
  });

  // Pairing P6 — Diesel × Juno, an earlier Boxer breeding that FAILED (didn't
  // take). Terminal status, so it doesn't dedup Juno's stud→pairing nudge; it
  // gives the Boxer line a pairing and exercises PAIRING_STATUS `failed`. Thread I.
  const pairingP6 = await pairingRepo.create({
    kennel_id: thornfield.id,
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
    kennel_id: thornfield.id,
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
    kennel_id: thornfield.id,
    dam_id: marigold.id, sire_id: gunnar.id, nickname: 'Meadow Ridge foster litter',
    whelp_date: daysFromToday(-56), estimated_ready_date: daysFromToday(0),
    litter_registration_number: 'MDWR-L-2026-01',
    puppies_born_total: 2, puppies_born_alive: 2, puppies_born_deceased: 0, puppies_born_abnormalities: 0,
    expected_price_male: 2600, expected_price_female: 2800,
    expected_deposit_male: 500, expected_deposit_female: 500,
    full_reg_surcharge_male: 1000, full_reg_surcharge_female: 1500,
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
    kennel_id: thornfield.id,
    contract_type: 'foster', status: 'signed', signed_date: daysFromToday(-70),
    related_dog_id: marigold.id, related_contact_id: dana.id,
    title: 'Meadow Ridge foster / co-rearing agreement',
    terms_summary: '60/40 split of gross puppy sales; Thornfield rears and places; vet costs reimbursable by Meadow Ridge.'
  });
  manifest.contracts.push(fosterContract.id);

  // --- Stud Service SS1 (our stud, Birch goes to them) — Birch services Nell at Ellen's.
  // Links to Pairing P3 via the canonical pairing_id. `arranged` with a passed
  // sent_date and no returned_date: Birch is physically away right now, so this is
  // the away-board row AND drives the stud-service status nudge ("mark in
  // progress", §19/§4.2). flat_plus_pick with pick_value_amount so the partner
  // companion bundle exercises both a cash fee and a non-cash pick estimate.
  const studServiceBirch = await studServiceRepo.create({
    kennel_id: thornfield.id,
    direction: 'to_partner', our_dog_id: birch.id, partner_dog_id: nell.id, partner_contact_id: ellen.id,
    fee_amount: 800, fee_structure: 'flat_plus_pick', pick_status: 'pending', pick_value_amount: 1500,
    pairing_id: pairingP3.id, type: 'in_person', sent_date: daysFromToday(-3),
    // referred_by (Referral tracking): Dana sent this arrangement our way — the
    // repo auto-tags her contact as a 'stud_referrer'.
    referred_by_contact_id: dana.id,
    status: 'arranged', result_notes: 'Sent to Ellen’s for a natural breeding; awaiting confirmation.'
  });
  const studServiceContract = await contractRepo.create({
    kennel_id: thornfield.id,
    contract_type: 'stud_service', status: 'signed', related_stud_service_id: studServiceBirch.id,
    title: 'Stud Service Agreement — Birch × Nell', signed_date: daysFromToday(-10),
    // document_url (Companion feature §20): a placeholder "anyone with the link"
    // pointer the partner bundle carries.
    document_url: 'https://drive.example.com/thornfield/birch-nell-stud-agreement',
    terms_summary: 'Flat fee plus pick of litter, one breeding attempt, health-tested sire.'
  });
  manifest.stud_services.push(studServiceBirch.id);
  manifest.contracts.push(studServiceContract.id);

  // --- Stud Service SS2 (our dam, shipped) — we bred our Boxer dam Juno by shipped
  // semen from Hugo's outside stud Titan (Thread B, G8). Our dog is the dam (by
  // her sex), `shipped` (no one travels, so it never hits the away-board), flat_fee (money we
  // PAY — an expense, never income). `completed` with NO linked pairing yet →
  // drives the stud→pairing nudge (§19/§4.7). Its signed contract balances the
  // outgoing one above.
  const studServiceJuno = await studServiceRepo.create({
    kennel_id: thornfield.id,
    direction: 'shipped', our_dog_id: juno.id, partner_dog_id: titan.id, partner_contact_id: hugo.id,
    fee_amount: 1200, fee_structure: 'flat_fee', type: 'ai', sent_date: daysFromToday(-25),
    status: 'completed', result_notes: 'Shipped chilled semen, AI performed by repro vet.'
  });
  const studServiceJunoContract = await contractRepo.create({
    kennel_id: thornfield.id,
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
    kennel_id: thornfield.id,
    contract_type: 'co_own', status: 'sent', related_dog_id: percy.id, related_contact_id: sam.id,
    title: 'Co-Ownership Agreement — Percy', signed_date: '',
    terms_summary: 'Shared ownership; show and breeding decisions made jointly.'
  });
  // lease (signed): Sage leased in from Dana with lease dates. Makes Dana a LEASE
  // PARTNER in the Companion (partner membership comes from a live lease/co_own
  // contract with a counterparty), the third companion recipient type.
  const sageLeaseContract = await contractRepo.create({
    kennel_id: thornfield.id,
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
    kennel_id: thornfield.id,
    dog_id: hazel.id, buyer_contact_id: priya.id, sale_date: '2025-12-20',
    price: 2500, deposit_amount: 500, deposit_date: '2025-11-01', balance_paid_date: '2025-12-20',
    registration_type: 'limited', status: 'delivered', lead_source: 'Instagram',
    // referred_by (Referral tracking): Tessa referred Priya — auto-tags Tessa as
    // a 'buyer_referrer' (she already carries the role in this seed).
    referred_by_contact_id: tessa.id,
    notes: 'Went home with a family in Concord, NH — regular updates from the family.'
  });
  const hazelContract = await contractRepo.create({
    kennel_id: thornfield.id,
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
    kennel_id: thornfield.id,
    dog_id: daisy.id, buyer_contact_id: nora.id, sale_date: '2026-05-20',
    price: 2800, deposit_amount: 600, deposit_date: '2026-04-01',
    registration_type: 'limited', status: 'deposit_paid', lead_source: 'Website',
    notes: 'Reserved — pickup scheduled for late May.'
  });
  const daisyContract = await contractRepo.create({
    kennel_id: thornfield.id,
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
  // exercised (price + transport + boarding×units + extra charges − deposit). A `full`
  // registration broadens REGISTRATION_TYPE coverage beyond `limited`.
  const cedarSale = await saleRepo.create({
    kennel_id: thornfield.id,
    dog_id: cedarPup.id, buyer_contact_id: jamal.id, sale_date: daysFromToday(-20),
    price: 2800, deposit_amount: 500, deposit_date: daysFromToday(-20), balance_due_date: daysFromToday(21),
    transport_fee: 250,
    deferred_boarding_amount: 25, deferred_boarding_frequency: 'Day', deferred_boarding_duration_days: 10,
    // A photo package from the price list, one invoice line of its own (§21.2).
    extra_charges: [{ id: crypto.randomUUID(), label: 'Gold photo package', amount: 150 }],
    // A payment schedule (Payment Schedule plan §3.1): half the price by next week,
    // counting the deposit, and everything else on the balance due date. No payments
    // recorded yet.
    payment_schedule: [
      { id: crypto.randomUUID(), due: 'on_date', due_date: daysFromToday(7), covers: ['price'], percent: 50, basis: 'total' },
      { id: crypto.randomUUID(), due: 'on_date', due_date: daysFromToday(21), covers: ['all'], percent: 100, basis: 'total' }
    ],
    payments: [],
    registration_type: 'full', status: 'deposit_paid', lead_source: 'Referral',
    notes: 'Reserved from the Autumn litter; buyer delayed pickup, boarding with us until then.'
  });
  manifest.sales.push(cedarSale.id);

  // --- Briar Hollow Kennels — a SECOND own kennel (Multi-Kennel Scope Spec §13).
  // Meadow Ridge is Dana's OUTSIDE kennel (breeder-of-record/external-ownership
  // demo, not a scope), so it never exercised the switcher — a second *own*
  // kennel is what shows the scope actually segmenting something. Deliberately
  // small (its own sire/dam, one pairing, one litter, one placed pup, one sale)
  // rather than a second full packet: enough for the switcher, the kennel hub's
  // roster/litters/P&L, and a cross-kennel picker check, without doubling the
  // seed. A different breed line makes "which kennel is this" obvious at a glance.
  const briarHollow = await kennelRepo.create({
    kennel_name: 'Briar Hollow Kennels', prefix: 'BRIAR', location: 'Woodstock, VT', is_own_kennel: true,
    preferred_breeds: ['Golden Retriever'],
    promote_nudge_enabled: true, promote_age_male_months: 14, promote_age_female_months: 11
  });
  manifest.kennels.push(briarHollow.id);

  const renee = await contactRepo.create({
    name: 'Renee Coleman', contact_type: ['buyer'], waitlist_status: 'fulfilled',
    first_contact_source: 'Website', phone: '555-0114', email: 'renee.coleman@example.com',
    address: '9 Orchard Row, Woodstock, VT 05091'
  });
  manifest.contacts.push(renee.id);

  const cassius = await dogRepo.create({
    call_name: 'Cassius', sex: 'male', breed: 'Golden Retriever',
    date_of_birth: '2020-05-18', registered_name: 'Briar Hollow Cassius', registry: 'AKC',
    ownership_type: 'owned', status: 'active_breeding', kennel_id: briarHollow.id
  });
  const opal = await dogRepo.create({
    call_name: 'Opal', sex: 'female', breed: 'Golden Retriever',
    date_of_birth: '2021-02-09', registered_name: 'Briar Hollow Opal', registry: 'AKC',
    ownership_type: 'owned', status: 'active_breeding', kennel_id: briarHollow.id
  });
  const pairingB1 = await pairingRepo.create({
    kennel_id: briarHollow.id,
    sire_id: cassius.id, dam_id: opal.id, pairing_type: 'actual', method: 'natural',
    status: 'whelped', planned_date: daysFromToday(-160), expected_due_date: daysFromToday(-97)
  });
  const briarLitter = await litterRepo.create({
    kennel_id: briarHollow.id,
    pairing_id: pairingB1.id, dam_id: opal.id, sire_id: cassius.id, nickname: 'Meadowlark litter',
    whelp_date: daysFromToday(-97), litter_registration_number: 'BRIAR-L-2026-01',
    puppies_born_total: 1, puppies_born_alive: 1, puppies_born_deceased: 0, puppies_born_abnormalities: 0,
    status: 'sold'
  });
  const maple = await dogRepo.create({
    call_name: 'Maple', sex: 'female', breed: 'Golden Retriever',
    date_of_birth: daysFromToday(-97), sire_id: cassius.id, dam_id: opal.id, litter_id: briarLitter.id,
    ownership_type: 'owned', status: 'pet_home', kennel_id: briarHollow.id, breeder_kennel_id: briarHollow.id
  });
  const mapleSale = await saleRepo.create({
    kennel_id: briarHollow.id,
    dog_id: maple.id, buyer_contact_id: renee.id, sale_date: daysFromToday(-30),
    price: 2200, deposit_amount: 500, deposit_date: daysFromToday(-90), balance_paid_date: daysFromToday(-30),
    registration_type: 'limited', status: 'delivered', lead_source: 'Website',
    notes: 'Went home with the Colemans in Woodstock, VT.'
  });
  manifest.dogs.push(cassius.id, opal.id, maple.id);
  manifest.pairings.push(pairingB1.id);
  manifest.litters.push(briarLitter.id);
  manifest.sales.push(mapleSale.id);

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
    // Birch — away at Ellen's for his stud service with Nell (SS1, our dog goes to
    // them): the trip is a boarding event, so he's on the Away board, and Today asks
    // to update the stud service once it ends (studRules.boardingEndedUpdate).
    { subject_id: birch.id, event_type: 'boarding', event_date: daysFromToday(-3),
      title: 'Stud service', related_contact_id: ellen.id,
      details: { location: 'Ellen Brooks (Burlington, VT)', boarding_reason: 'Stud service' } },
    // Percy — a completed BOARDING span (Thread E/G11): a grow-out stay with a
    // related contact, showing a span row + related_contact_id on the timeline.
    { subject_id: percy.id, event_type: 'boarding', event_date: daysFromToday(-40), event_end_date: daysFromToday(-33),
      title: 'Boarding — co-owner rotation', related_contact_id: sam.id,
      details: { location: 'Sam Okafor’s (co-owner)', boarding_reason: 'Co-owner rotation', notes: 'Routine time with his co-owner.' } },
    // Percy — future-dated vet_visit with a DUE-SOON reminder (within 30 days).
    { subject_id: percy.id, event_type: 'vet_visit', event_date: '2026-08-15', title: 'Annual checkup',
      reminder_date: daysFromToday(14), related_contact_id: patricia.id,
      details: { reason: 'Annual checkup' } },
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
    // Weekly weigh-ins for the Autumn litter (born 63 days ago), birth to 7 weeks (Wren
    // also has the day-56 check above): the Puppy Growth report's curves. Cedar runs
    // small, so the report flags him.
    ...[['wren', [6, 12, 20, 28, 36, 44, 50, 53]], ['aster', [7, 13, 21, 30, 38, 46, 54, 60]], ['cedar', [5, 9, 14, 19, 25, 31, 37, 42]]]
      .flatMap(([who, ounces]) => ounces.map((oz, week) => ({
        subject_id: { wren: wrenPup.id, aster: asterPup.id, cedar: cedarPup.id }[who], event_type: 'weight_check',
        event_date: daysFromToday(-63 + week * 7), title: 'Weight check',
        details: { weight_lbs: Math.floor(oz / 16), weight_oz: oz % 16, time_of_day: 'AM' }
      }))),
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
      related_contact_id: patricia.id, details: { reason: 'Wellness check', findings: 'Healthy, on growth curve.' } },
    { subject_id: daisy.id, event_type: 'weight_check', event_date: '2026-05-01', title: 'Weight check',
      details: { weight_lbs: 6, weight_oz: 4, time_of_day: 'AM' } },
    { subject_id: daisy.id, event_type: 'surgery', event_date: '2026-05-10', title: 'Spay',
      related_contact_id: patricia.id, details: { procedure: 'Ovariohysterectomy', outcome: 'Uncomplicated, recovered well.' } }
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

  // Show tracking (Show Tracking Spec §9, Pro/Demo — Lite seeds from its own
  // tour package). Birch, a young owned male, is working toward his AKC CH:
  // 7 past results (one Reserve with no points) totalling 12 points with ONE
  // major across 3 judges, so his Show Record card shows real gaps ("3 more
  // points, 1 more major under a new judge"). Then a cluster weekend inside
  // Today's 14-day window, handled by Lauren: Saturday `entered` (with its entry
  // fee captured via the event Cost link, below), Sunday still `planned` with
  // entries closing in 3 days — a live reminder and an amber flag on Shows.
  const CLUB = 'Thistle Valley Kennel Club';
  const VENUE = 'Valley Expo Center, West Springfield, MA';
  const birchShow = (days, showName, judge, cls, placement, points, extra = {}) => ({
    subject_id: birch.id, event_type: 'show', event_date: daysFromToday(days), title: showName,
    related_contact_id: lauren.id,
    details: {
      entry_status: 'shown', show_name: showName, club: CLUB, organization: 'AKC', location: VENUE,
      judge, class: cls, placement, points, points_toward: 'akc_ch', defeated_champion: 'No', ...extra
    }
  });
  dogEvents.push(
    birchShow(-130, 'Thistle Valley KC — Show 1', 'Mrs. Helen Archer', 'Puppy 9–12 Months', 'WD', 2),
    birchShow(-129, 'Thistle Valley KC — Show 2', 'Mr. David Ostrowski', 'Puppy 9–12 Months', 'RWD', 0),
    birchShow(-101, 'Granite State KC', 'Mr. David Ostrowski', 'Puppy 9–12 Months', 'WD', 1),
    birchShow(-72, 'Merrimack Valley KC', 'Ms. Carla Benitez', '12–18 Months', 'BOW', 3),
    birchShow(-58, 'Green Mountain Terrier Club', 'Mrs. Helen Archer', '12–18 Months', 'WD', 2),
    birchShow(-37, 'Seacoast KC — Show 1', 'Mr. David Ostrowski', '12–18 Months', 'WD', 2),
    birchShow(-36, 'Seacoast KC — Show 2', 'Ms. Carla Benitez', '12–18 Months', 'BOW', 2),
    { ...birchShow(9, 'Thistle Valley KC — Show 1', '', '12–18 Months', '', '', { entry_status: 'entered', judge: 'Mrs. Joan Whitaker', ring: '4', ring_time: '9:30 AM' }) },
    { ...birchShow(10, 'Thistle Valley KC — Show 2', '', '12–18 Months', '', '', { entry_status: 'planned', ring: '4', ring_time: '11:15 AM' }),
      reminder_date: daysFromToday(3) }
  );

  let birchEntryShow = null;
  for (const e of dogEvents) {
    const saved = await HistoryEvent.create({ subject_type: 'dog', ...e });
    manifest.events.push(saved.id);
    if (e.event_type === 'show' && e.details.entry_status === 'entered') birchEntryShow = saved;
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
    event_date: daysFromToday(-20), title: 'Sick visit', related_contact_id: patricia.id,
    details: { reason: 'Ear infection' }
  });
  manifest.events.push(vetVisit.id);

  // Accounts (Pro-only page, editionFlags.accounts): a registry, a marketplace and
  // a store, so the page shows a login, a hidden password and a referral to share.
  // Obviously-fake credentials — the Demo is public. Seeded before the expenses
  // so the Chewy and AKC costs below can name their account (expenses.account_id).
  const accountIds = new Map(); // name -> id
  if (editionFlags.accounts) {
    for (const data of [
      { name: 'AKC', account_type: 'registry', website: 'akc.org', username: 'thornfield.kennels@example.com',
        password: 'sample-password', customer_id: 'Breeder #A123456', notes: 'Breeder of Merit renewal each January.' },
      { name: 'Good Dog', account_type: 'marketplace', website: 'gooddog.com', username: 'thornfield.kennels@example.com',
        password: 'sample-password', referral_link: 'https://www.gooddog.com/breeders/thornfield-kennels-example',
        referral_instructions: 'Apply for a Thornfield puppy through our Good Dog page — your deposit is protected by Good Dog.',
        // A sales channel's fee, percentage + fixed (Integrations plan §5). Sample
        // numbers, not Good Dog's real terms.
        fee_percent: 6.25, fee_fixed: 5, fee_passed_to_buyer_default: true,
        fee_note: 'Sample rate — check your own Good Dog agreement for yours.' },
      { name: 'Chewy', account_type: 'supplier', website: 'chewy.com', username: 'thornfield.kennels@example.com',
        password: 'sample-password', customer_id: '0000-SAMPLE', referral_link: 'https://www.chewy.com/refer/thornfield-example',
        referral_code: 'THORNPUP', referral_instructions: 'Use code THORNPUP at checkout for 30% off your first Autoship order of the food your puppy is already eating.',
        // Shown to families as "Recommended for your puppy" (Integrations plan §3);
        // with Maple's sale delivered a month ago, Today's follow-up note carries it.
        share_with_families: true }
    ]) {
      const saved = await accountRepo.create(data);
      manifest.accounts.push(saved.id);
      accountIds.set(saved.name, saved.id);
    }
    // Cedar's sale went through Good Dog, its fee passed on in the price: the
    // Sale page shows the fee and what's netted, and Financials' earned income
    // drops by the deposit's share of it.
    await saleRepo.update(cedarSale.id, {
      sales_channel_account_id: accountIds.get('Good Dog'), processing_fee_amount: 180, fee_passed_to_buyer: true
    });

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
    // Birch's entry fee for the upcoming Saturday show — a `show` ("Shows &
    // handling") expense captured from the show event's Cost (Show Tracking §9).
    { event_id: birchEntryShow.id, subject_type: 'dog', subject_id: birch.id, amount: 38, category: 'show', expense_date: daysFromToday(-5), vendor: 'Thistle Valley Kennel Club', notes: 'Entry fee — Show 1' },
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
    // A cost whose vendor is a seeded account is paid through it.
    const saved = await expenseRepo.create({ ...x, account_id: accountIds.get(x.vendor) || null });
    manifest.expenses.push(saved.id);
  }

  // Companion messaging (§20): seed the per-type templates so the demo's share
  // pages have Thornfield branding. These are localStorage config (not manifest
  // records); clearSampleData resets them back to defaults alongside the records.
  seedCompanionSettings();

  // Waitlist (Waitlist Spec §11 "Demo"): a small per-kennel list on Thornfield so
  // the Demo and the Pro tour can show it. Pro-only (editionFlags.waitlist) — Lite
  // has its own seed (lite/editionTour.js) and no waitlist at all.
  if (editionFlags.waitlist) {
    await seedWaitlist(manifest, { thornfield, owen, priya, hazelSale, litter, autumnLitter, expectedLitter, fern, wrenPup, asterPup });
  }

  }

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
    thornfield: thornfield.id, meadowRidge: meadowRidge.id, briarHollow: briarHollow.id,
    priya: priya.id, owen: owen.id, ellen: ellen.id, jamal: jamal.id, dana: dana.id,
    tessa: tessa.id, grace: grace.id, rex: rex.id, nora: nora.id, marcus: marcus.id,
    sam: sam.id, hugo: hugo.id, patricia: patricia.id, renee: renee.id, lauren: lauren.id,
    summerLitter: litter.id, springLitter: litter2.id, autumnLitter: autumnLitter.id, winterLitter: expectedLitter.id,
    marigold: marigold.id, bramble: bramblePup.id, sorrel: sorrelPup.id, fosterLitter: fosterLitter.id, fosterContract: fosterContract.id,
    cassius: cassius.id, opal: opal.id, maple: maple.id, briarLitter: briarLitter.id,
    pairingP1: pairingP1.id, pairingP2: pairingP2.id, pairingP3: pairingP3.id,
    pairingP4: pairingP4.id, pairingP5: pairingP5.id, pairingP6: pairingP6.id, pairingB1: pairingB1.id,
    hazelSale: hazelSale.id, daisySale: daisySale.id, cedarSale: cedarSale.id, mapleSale: mapleSale.id,
    studServiceBirch: studServiceBirch.id, studServiceJuno: studServiceJuno.id,
    hazelContract: hazelContract.id, daisyContract: daisyContract.id,
    studServiceContract: studServiceContract.id, studServiceJunoContract: studServiceJunoContract.id,
    percyCoOwnContract: percyCoOwnContract.id, sageLeaseContract: sageLeaseContract.id
  };

  setSampleDataManifest(manifest);
  return manifest;
}

// The sample waitlist: one family in a program (paused for treatment, so skipped
// without losing their place), one with an OPEN offer on the Autumn litter (picks
// open), one with a pass already used, a listen-only family waiting for the
// Winter litter, one on the list but on a readiness hold (can't commit for 3
// months), one approved family whose fee is due, one new application, and a
// past run that ended placed (Hazel — its credited fee nets off her sale in
// Financials). Everything goes through the repos, like the rest of the seed.
async function seedWaitlist(manifest, r) {
  await kennelRepo.update(r.thornfield.id, {
    waitlist_config: {
      fee_amount: 300, fee_credit_policy: 'credited_to_purchase', fee_due_days: 14,
      payment_instructions: 'Venmo @thornfield-kennels, or a check to Thornfield Kennels.',
      respond_days: 3, max_passes: 2, no_response_counts_as_pass: true, color_matching: false,
      application_faq: [
        { id: 'faq_price', question: 'What do your puppies cost?', answer: 'Pet homes are usually $2,500–$2,800. Show and breeding prospects are priced per pup.' },
        { id: 'faq_how', question: 'How does the waitlist work?', answer: 'Once you\'re approved, a $300 fee holds your place. When a litter\'s picks open, families are offered a pup in list order. You can pass twice before you\'re taken off the list.' }
      ]
    }
  });
  const treatment = await waitlistProgramRepo.create({
    kennel_id: r.thornfield.id, name: 'Treatment family', priority: 'ahead', fee_override: 0,
    passes_count: false, pause_allowed: true, respond_days_override: 7,
    public_description: 'For families going through medical treatment: no fee, and passes never count.'
  });
  manifest.waitlist_programs.push(treatment.id);

  const contact = async (data) => {
    const c = await contactRepo.create({ contact_type: ['buyer'], ...data });
    manifest.contacts.push(c.id);
    return c;
  };
  const entry = async (data) => {
    const e = await waitlistEntryRepo.create({ kennel_id: r.thornfield.id, ...data });
    manifest.waitlist_entries.push(e.id);
    return e;
  };
  const offer = async (data) => {
    const o = await waitlistOfferRepo.create({ kennel_id: r.thornfield.id, ...data });
    manifest.waitlist_offers.push(o.id);
    return o;
  };
  const app = (name, email, extra = {}) => ({ name, email, location: 'Vermont', heard_from: 'Instagram', ...extra });

  const mia = await contact({ name: 'Mia Torres', email: 'mia.torres@example.com', phone: '555-0141' });
  await entry({
    contact_id: mia.id, status: 'active', waitlist_program_id: treatment.id,
    applied_date: daysFromToday(-220), approved_date: daysFromToday(-215), fee_received_date: daysFromToday(-215),
    fee_amount: 0, fee_payment_method: 'Waived', pref_sex: 'female', pref_breed: 'Boston Terrier', ready_timing: 'asap',
    paused_until: daysFromToday(60), pause_reason: 'Treatment — back in touch in two months',
    application: app('Mia Torres', 'mia.torres@example.com', { about: 'Our family wants a calm companion while I finish treatment.' })
  });

  const owenEntry = await entry({
    contact_id: r.owen.id, status: 'active', applied_date: daysFromToday(-170), approved_date: daysFromToday(-165),
    fee_received_date: daysFromToday(-160), fee_amount: 300, fee_credit_policy: 'credited_to_purchase', fee_payment_method: 'Venmo',
    pref_breed: 'Boston Terrier', ready_timing: 'asap', application: app('Owen Farrow', 'owen.farrow@example.com', { heard_from: 'Referral' })
  });

  const rachel = await contact({ name: 'Rachel Kim', email: 'rachel.kim@example.com', phone: '555-0142' });
  const rachelEntry = await entry({
    contact_id: rachel.id, status: 'active', applied_date: daysFromToday(-140), approved_date: daysFromToday(-138),
    fee_received_date: daysFromToday(-130), fee_amount: 300, fee_credit_policy: 'credited_to_purchase', fee_payment_method: 'Zelle',
    pref_sex: 'female', ready_timing: 'asap', application: app('Rachel Kim', 'rachel.kim@example.com')
  });

  const alders = await contact({ name: 'Ben & Kate Alder', email: 'alders@example.com' });
  await entry({
    contact_id: alders.id, status: 'active', applied_date: daysFromToday(-110), approved_date: daysFromToday(-108),
    fee_received_date: daysFromToday(-100), fee_amount: 300, fee_credit_policy: 'credited_to_purchase', fee_payment_method: 'Check',
    listen_mode: 'selected', listen_dam_ids: [r.expectedLitter.dam_id], ready_timing: 'asap',
    application: app('Ben & Kate Alder', 'alders@example.com', { about: 'Only a Juniper litter — we love her' })
  });

  const hannah = await contact({ name: 'Hannah Moore', email: 'hannah.moore@example.com' });
  await entry({
    contact_id: hannah.id, status: 'approved', applied_date: daysFromToday(-9), approved_date: daysFromToday(-5),
    fee_amount: 300, fee_credit_policy: 'credited_to_purchase', fee_due_date: daysFromToday(9), ready_timing: '1_month',
    application: app('Hannah Moore', 'hannah.moore@example.com')
  });

  // On the list but can't commit for 3 months: the readiness hold keeps them
  // from being offered (and using up passes) until 3 months after their fee.
  const riveras = await contact({ name: 'Sam & Jo Rivera', email: 'riveras@example.com' });
  await entry({
    contact_id: riveras.id, status: 'active', applied_date: daysFromToday(-30), approved_date: daysFromToday(-28),
    fee_received_date: daysFromToday(-20), fee_amount: 300, fee_credit_policy: 'credited_to_purchase', fee_payment_method: 'Zelle',
    ready_timing: '3_months', application: app('Sam & Jo Rivera', 'riveras@example.com', { about: 'Moving house this spring, so we\'ll be ready after that.' })
  });

  // A new application, typed in — no contact yet (approving links or creates one).
  await entry({
    status: 'applied', applied_date: daysFromToday(-2), pref_sex: 'male', ready_timing: '6_plus_months',
    application: app('Leo Grant', 'leo.grant@example.com', { household: 'Two adults, one teenager', other_pets: 'An older cat', about: 'First Boston, lots of reading done!' })
  });

  // Priya's earlier run ended placed with Hazel.
  await entry({
    contact_id: r.priya.id, status: 'placed', placed_sale_id: r.hazelSale.id,
    applied_date: '2025-05-20', approved_date: '2025-05-22', fee_received_date: '2025-06-01',
    fee_amount: 300, fee_credit_policy: 'credited_to_purchase', fee_payment_method: 'Venmo', ready_timing: 'asap',
    application: app('Priya Shah', 'priya.shah@example.com')
  });

  // Rachel passed on Fern (Summer litter) — her one counted pass so far.
  await offer({
    entry_id: rachelEntry.id, litter_id: r.litter.id, offered_date: daysFromToday(-45), respond_by_date: daysFromToday(-42),
    eligible_dog_ids: [r.fern.id], outcome: 'passed', outcome_date: daysFromToday(-43), counts_as_pass: true
  });

  // Picks are open on the Autumn litter: Mia is paused (skipped, nothing held
  // against her), so it's Owen's turn — respond by in two days. Rachel is next.
  await litterRepo.update(r.autumnLitter.id, { picks_opened_date: daysFromToday(-1) });
  await offer({
    entry_id: owenEntry.id, litter_id: r.autumnLitter.id, offered_date: daysFromToday(-1), respond_by_date: daysFromToday(2),
    eligible_dog_ids: [r.wrenPup.id, r.asterPup.id], outcome: 'open'
  });
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
//
// Every sample record is deleted (Load Performance plan D4). The tour is
// read-only now (demoMode.assertWritable), so a new seed has nothing pointing at
// it. A seed from before that may: a real dog filed under Thornfield, a real
// litter whose dam is a sample dog. Those links are dealt with by
// recordDetach.js: a link to a sample KENNEL moves to the breeder's own kennel
// (and when she has none yet, nothing is cleared until kennel setup saves one:
// reason 'needs-kennel'); any other link to a sample record is cleared. What
// changed comes back as `detached`, one line each, for the one-time notice.

// Manifest key → table. Every id the seed made is in one of these.
const MANIFEST_TABLES = {
  dogs: 'dogs', events: 'events', contacts: 'contacts', kennels: 'kennels', pairings: 'pairings',
  litters: 'litters', sales: 'sales', contracts: 'contracts', stud_services: 'stud_services',
  expenses: 'expenses', waitlist_programs: 'waitlist_programs', waitlist_entries: 'waitlist_entries',
  waitlist_offers: 'waitlist_offers', accounts: 'accounts', documents: 'documents'
};

export function manifestRemoval(manifest) {
  const out = {};
  for (const [key, table] of Object.entries(MANIFEST_TABLES)) {
    const ids = Array.isArray(manifest?.[key]) ? manifest[key] : [];
    if (ids.length) out[table] = ids;
  }
  return out;
}

// The breeder's own kennel, for links to a sample kennel to move to: "My kennel"
// when it's a live own kennel outside the seed, else the oldest such own kennel.
async function ownKennelOutside(sampleKennelIds) {
  const outside = (k) => k && k.is_own_kennel && !k.is_archived && !sampleKennelIds.has(k.id);
  const mine = getMyKennelId() ? await db.kennels.get(getMyKennelId()) : null;
  if (outside(mine)) return mine;
  const own = (await db.kennels.toArray()).filter(outside)
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  return own[0] || null;
}

// "Juniper", "Thornfield Kennels", "a litter (Rex × Juniper)": for the notice.
async function recordLabel(table, row) {
  if (!row) return 'a record';
  const dogName = async (id) => (id ? (await db.dogs.get(id))?.call_name : null) || '—';
  switch (table) {
    case 'dogs': return row.call_name || row.registered_name || 'a dog';
    case 'contacts': return row.name || 'a contact';
    case 'kennels': return row.kennel_name || 'a kennel';
    case 'litters': return `a litter (${await dogName(row.sire_id)} × ${await dogName(row.dam_id)})`;
    case 'pairings': return `a pairing (${await dogName(row.sire_id)} × ${await dogName(row.dam_id)})`;
    case 'sales': return `a sale of ${await dogName(row.dog_id)}`;
    case 'stud_services': return `a stud service (${await dogName(row.our_dog_id)})`;
    case 'events': return row.title ? `the event “${row.title}”` : 'an event';
    case 'expenses': return row.description ? `the expense “${row.description}”` : 'an expense';
    case 'accounts': return row.name ? `the account “${row.name}”` : 'an account';
    case 'contracts': return 'a contract';
    case 'documents': return 'a document';
    case 'waitlist_entries': return `${row.application?.name || 'a family'} on your waitlist`;
    case 'waitlist_programs': return 'a waitlist';
    case 'waitlist_offers': return 'a waitlist offer';
    default: return 'a record';
  }
}

async function detachLines(edits, target) {
  const lines = [];
  for (const e of edits) {
    const [sample, outside] = await Promise.all([
      db.table(e.fromTable).get(e.id).then((r) => recordLabel(e.fromTable, r)),
      db.table(e.table).get(e.rowId).then((r) => recordLabel(e.table, r))
    ]);
    lines.push(e.fromTable === 'kennels'
      ? `${outside}: moved from ${sample} (from the tour; ${e.ref.label}) to ${target ? target.kennel_name || 'your kennel' : 'your kennel'}.`
      : `${outside}: its link to ${sample} (from the tour; ${e.ref.label}) is cleared.`);
  }
  return [...new Set(lines)];
}

// clearSampleData({ kennelTarget, dropKennelLinks }):
//   → { cleared: true, counts, detached: [line] }
//   → { cleared: false, reason: 'none' } (no seed)
//   → { cleared: false, reason: 'needs-kennel', detached } (an old seed's real
//     records point at the sample kennel and she has no kennel of her own yet:
//     nothing changed; save one in kennel setup and call again with its id)
// `dropKennelLinks`: clear kennel links too instead of waiting (a restore, which
// brings her own kennel with it).
export async function clearSampleData({ kennelTarget = null, dropKennelLinks = false } = {}) {
  const manifest = getSampleDataManifest();
  if (!manifest) return { cleared: false, reason: 'none', counts: {} };
  const remove = manifestRemoval(manifest);
  const target = kennelTarget
    ? await db.kennels.get(kennelTarget)
    : await ownKennelOutside(new Set(manifest.kennels || []));
  const plan = await planDetach(remove, { kennelTarget: target?.id || null, dropKennelLinks });
  const detached = await detachLines(plan.edits, target);
  if (plan.needsKennel) return { cleared: false, reason: 'needs-kennel', detached, counts: {} };
  await removeDetaching(remove, { kennelTarget: target?.id || null, dropKennelLinks });

  const counts = Object.fromEntries(Object.keys(MANIFEST_TABLES).map((k) => [k, (manifest[k] || []).length]));
  removeSampleDataManifest();
  resetCompanionSettings();
  markSampleDataCleared();
  // A Kels draft started on the sample would build on dogs that are gone (K11-2).
  clearGuidedDrafts();
  // The nav's stored kennel name and switcher held the sample kennel.
  setNavKennels(null);
  return { cleared: true, counts, detached };
}
