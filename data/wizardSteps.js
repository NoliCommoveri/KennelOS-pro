// wizardSteps.js — the guided tour's ordered step catalog (Wizard Runtime Spec
// v1 §3). Hub order and in-hub order follow Tutorial_Coverage_Matrix_v1.md §F/§B;
// the per-stop teaching copy tracks the KennelOS Tour Guide (user-facing wording,
// plain text — cards render escaped, so no markdown/bullets/bold here). Data only,
// like vocab.js — no DOM, no logic. wizardState.js and wizardUI.js both import
// WIZARD_STEPS from here.
//
// Each step:
//   id         stable string id (never array position).
//   kind       'tour-intro' | 'hub-intro' | omitted (a "highlight" step). Intro
//              steps are centered, page-agnostic cards with a single forward
//              button (no Back/Next/Skip); highlight steps spotlight a real
//              element with Back/Next/Skip. The tour is: one tour-intro, then per
//              hub a hub-intro card followed by that hub's highlight steps.
//   button     (intro steps only) the single forward-button label.
//   hub        concise hub name; labels the hub-intro card for that hub.
//   page       bare page file (no path/query) — resolved to pages/<page> like
//              nav.js's HUB_CHILDREN. Detail pages carry a separate `anchor`.
//              Intro steps omit it — they render wherever the user currently is.
//   anchor     (detail pages only) a slug key into the seed's manifest.named
//              map (data/sampleData.js) — wizardUI.js resolves it to the
//              *current* seed's real id at runtime and builds `?id=<id>`. The
//              seed uses crypto.randomUUID() ids (not build-time constants), so
//              the link can only be resolved per-seed; manifest.named is the
//              map the seed writes for exactly this (spec §3.2, reconciled to
//              the actual seed).
//   idParam    (detail pages only, optional) overrides the query key the
//              resolved anchor id is written to — defaults to 'id'. A couple
//              of print-doc pages read a different key (puppy-record.html
//              reads `?sale=`); anchor still resolves the same way.
//   selector   CSS selector for the coach-mark target on that page. Container
//              ids (`#…-section`, `[data-card="…"]`) are stable mount points
//              that always resolve; a step whose selector matches nothing
//              degrades to a centered tooltip (spec §4.3), never throws.
//   beforeShow { openCard: '<key>' } for ui.js cardShell cards (today/companion)
//              that may start collapsed — reuses the delegated card-toggle
//              listener. dog/litter/etc. sections default to expanded when the
//              seed populates them, so they need no reveal.
//              { click: '<selector>' } clicks a trigger button to open a modal
//              form (Add Event, Add Document, …) before spotlighting it — pair
//              with a `selector` matching the modal itself (its root carries a
//              stable id, e.g. `#ef-modal`), not the trigger. wizardUI.js
//              clicks once per step render (its target-poll otherwise fires
//              repeatedly while the modal's async setup is still in flight)
//              and closes the modal via Escape when the step tears down.
//   title/body one idea per stop, from the Tour Guide copy.

export const WIZARD_STEPS = [
  // --- Tour intro (centered card, single button) -------------------------
  {
    id: 'tour-intro', kind: 'tour-intro', button: 'Start the tour →',
    title: 'Meet Thornfield Kennels',
    body: 'We’ve loaded a fictional sample kennel — Thornfield Kennels — with several dogs, litters and records already filled in so you have something real to explore. Nothing here is yours: once you finish the tour you can delete the sample data. If you leave the tour to explore on your own, a yellow “Clear sample data” banner stays at the top — click it whenever you’re ready to reset to a blank slate and load your own program.'
  },

  // --- Today -------------------------------------------------------------
  {
    id: 'today-intro', kind: 'hub-intro', hub: 'Today', button: 'Explore Today Hub →',
    title: 'Today',
    body: 'The Today hub is your at-a-glance command center: everything that needs your attention right now — reminders, active litters, upcoming pickups, who’s away from home, and a quick read on the whole kennel — gathered in one place.'
  },
  {
    id: 'today-reminders', hub: 'Today', page: 'today.html',
    selector: '[data-card="reminders"]', beforeShow: { openCard: 'reminders' },
    title: 'Reminders',
    body: 'Reminders track recurring events — like annual vet visits — so you know when the next one is due. Any event you give a future reminder date appears here automatically as the date gets close. From here you can log the new event, snooze the reminder for a while, or dismiss it if you no longer plan another occurrence.'
  },
  {
    id: 'today-active-litters', hub: 'Today', page: 'today.html',
    selector: '[data-card="active-litters"]', beforeShow: { openCard: 'active-litters' },
    title: 'Active litters',
    body: 'Active litters are the ones that still have puppies available for sale. Each shows a placed-vs-total count and a “New Sale” button to log a sale directly and keep things moving. Once every pup is placed or marked as keeping, the litter drops off this list.'
  },
  {
    id: 'today-due-outs', hub: 'Today', page: 'today.html',
    selector: '[data-card="upcoming"]', beforeShow: { openCard: 'upcoming' },
    title: 'Due outs & upcoming',
    body: 'Unlike reminders, due outs are events you’ve already scheduled — a puppy pickup next week, or an annual vet visit. Use “Open” to edit the details, and you can reschedule or delete an event. Each one drops off the list once its date has passed.'
  },
  {
    id: 'today-away', hub: 'Today', page: 'today.html',
    selector: '[data-card="board"]', beforeShow: { openCard: 'board' },
    title: 'Away from home',
    body: 'This shows where any dogs that aren’t at home currently are — being boarded, or studded out — so you always know where every dog in your program is at any given time.'
  },
  {
    id: 'today-overview', hub: 'Today', page: 'today.html',
    selector: '[data-card="overview"]', beforeShow: { openCard: 'overview' },
    title: 'Kennel overview',
    body: 'A quick count of your entire program’s stock at a glance.'
  },
  {
    id: 'today-nudges', hub: 'Today', page: 'today.html',
    selector: '[data-card="nudges"]', beforeShow: { openCard: 'nudges' },
    title: 'Nudges',
    body: 'Nudges are your companion for keeping information consistent across the app. It’s a set of rules that surface suggestions — like moving a grown dog from puppy to breeding status, or reopening a litter after a puppy sale is canceled or returned.'
  },

  // --- Dogs --------------------------------------------------------------
  {
    id: 'dogs-intro', kind: 'hub-intro', hub: 'Dogs', button: 'Explore Dogs Hub →',
    title: 'Dogs',
    body: 'This is the heart and soul of your kennel — the dogs that make up your program. From this hub you manage your stock, record events, view pedigrees, and see at a glance what contracts each dog has taken part in.'
  },
  {
    id: 'dogs-buckets', hub: 'Dogs', page: 'dogs.html',
    selector: '#dogs-bucket-tabs',
    title: 'The dog roster',
    body: 'The roster lists your entire stock with key details on each dog, plus curated life-stage toggles to focus on dogs at a certain stage. Open any dog’s profile straight from here.'
  },
  {
    id: 'dogs-external', hub: 'Dogs', page: 'dogs.html',
    selector: '#dogs-bucket-tabs',
    title: 'External dogs',
    body: 'External dogs are relevant to your program but owned by someone else — dogs you stud with, or the parents of your own dogs. Create an external record for dogs you plan to breed with, switch a puppy to external after you’ve sold it, and archive dogs used only to fill out a pedigree so they don’t clutter the list.'
  },
  {
    id: 'dogs-filters', hub: 'Dogs', page: 'dogs.html',
    selector: '#dog-list',
    title: 'Filter, sort, archive, and export',
    body: 'Apply custom filters and sorts to pull exactly the dogs you need. Turn on “Show archived” to see archived dogs — handy for bringing back one you thought you were done with — and export your dog list as a spreadsheet.'
  },
  {
    id: 'dog-identity', hub: 'Dogs', page: 'dog.html', anchor: 'juniper',
    selector: '#profile-body',
    title: 'Dog profile: identity',
    body: 'Record a dog’s details here — registered name and number, colors, and a URL that links out to a photo album or the dog’s own web page. Click “Edit” to add, remove, or change anything in this section.'
  },
  {
    id: 'dog-ownership', hub: 'Dogs', page: 'dog.html', anchor: 'gunnar',
    selector: '#profile-body',
    title: 'Origin, breeder & ownership',
    body: 'See and record where a dog came from and who owns it. Dogs you’ve bred show their litter of origin with your kennel prefilled as owner; for dogs you’ve purchased, set the breeder kennel from the dropdown; and for dogs you no longer own, mark them external and fill in the owner and kennel details below.'
  },
  {
    id: 'dog-disposition', hub: 'Dogs', page: 'dog.html', anchor: 'fern',
    selector: '#profile-body',
    title: 'Disposition',
    body: 'Disposition is for puppies only — it captures your plan for a pup you’ve bred or bought. Marking one “available” flags your intent to sell it and drives the tools that help you sell, like listing it for potential buyers on Companion share-outs.'
  },
  {
    id: 'dog-coi', hub: 'Dogs', page: 'dog.html', anchor: 'juniper',
    selector: '#recorded-coi-section',
    title: 'Recorded COI',
    body: 'If you know a dog’s COI, record it here to help you make informed decisions about potential breeding partners. Note that KennelOS does not attempt to calculate COI itself.'
  },
  {
    id: 'dog-planned-tests', hub: 'Dogs', page: 'dog.html', anchor: 'juniper',
    selector: '#planned-tests-section',
    title: 'Planned tests',
    body: 'Record the tests you intend to run if your kennel regularly does genetic and breed-specific testing (like JHC). Once you log a test in the dog’s event history, it drops off the planned list automatically on the next refresh.'
  },
  {
    id: 'dog-health-tests', hub: 'Dogs', page: 'dog.html', anchor: 'daisy',
    selector: '#health-tests-section',
    title: 'Health-test summary',
    body: 'Because a dog’s event history can get long, this view pulls out just the health-testing events — so you can see at a glance which tests you’ve performed and their results.'
  },
  {
    id: 'dog-timeline', hub: 'Dogs', page: 'dog.html', anchor: 'percy',
    selector: '#timeline-section',
    title: 'Event history',
    body: 'This is the full list of dated events a dog has been through — its entire history from whelping or acquisition onward. Add new events with the “Add Event” button.'
  },
  {
    id: 'dog-add-event', hub: 'Dogs', page: 'dog.html', anchor: 'percy',
    selector: '#ef-modal', beforeShow: { click: '#tl-add' },
    title: 'Adding new events',
    body: 'Event fields adapt to the event type: some offer helpful dropdowns or auto-filled values, others suggest entries as you type (a health test offers your planned test suite). You can also log the cost of an event straight to your Expenses table from here.'
  },
  {
    id: 'dog-derived', hub: 'Dogs', page: 'dog.html', anchor: 'juniper',
    selector: '#pairings-section',
    title: 'Derived relationship panels',
    body: 'See the pairings, litters, sales, stud services and contracts your dog is associated with, all gathered in one place.'
  },
  {
    id: 'dog-pedigree', hub: 'Dogs', page: 'dog.html', anchor: 'juniper',
    selector: '#pedigree-section',
    title: 'Pedigree & offspring',
    body: 'An interactive, branching tree showing a dog’s pedigree, its offspring, and how the dogs in your program relate to each other. Open the full view to switch between related dogs seamlessly.'
  },

  // --- Breeding ----------------------------------------------------------
  {
    id: 'breeding-intro', kind: 'hub-intro', hub: 'Breeding', button: 'Explore Breeding Hub →',
    title: 'Breeding',
    body: 'This is where you run your breeding program — record your dogs’ pairings and litters, and produce new dog records for the puppies they yield.'
  },
  {
    id: 'breeding-chain', hub: 'Breeding', page: 'breeding.html',
    selector: '#breeding-body',
    title: 'The breeding chain',
    body: 'Your view of every pairing and litter your program has logged. You’ll typically start by adding a female’s heat cycle, then add pairing plans, record the litter, and create records for the resulting puppies. The most recent records show first.'
  },
  {
    id: 'breeding-log-heat', hub: 'Breeding', page: 'breeding.html',
    selector: '#log-heat-btn',
    title: 'Log a heat cycle',
    body: 'Add a heat cycle to a dog’s event history here. When it finishes you’ll get a nudge to record a pairing, successful or failed. Logging heat cycles helps you track skips and remember when to expect the next one.'
  },
  {
    id: 'pairing-profile', hub: 'Breeding', page: 'pairing.html', anchor: 'pairingP2',
    selector: '#profile-section',
    title: 'A pairing',
    body: '“Add New Pairing” opens the pairing screen, where you choose the sire and dam, record the date of the first tie (planned or already passed) and the last observed tie, and track pregnancy updates — tie dates, ultrasounds, notes — with the Add event button.'
  },
  {
    id: 'litter-profile', hub: 'Breeding', page: 'litter.html', anchor: 'autumnLitter',
    selector: '#profile-section',
    title: 'A litter',
    body: 'Once a pairing is recorded, create a litter. The litter record holds the general details that apply to the whole whelping — whelp date, when you’ll start accepting deposits, the litter registration number, born-alive and born-deceased counts, and expected prices for male and female pups. Tip: give the litter a nickname to tell apart litters from the same dam.'
  },
  {
    id: 'litter-roster', hub: 'Breeding', page: 'litter.html', anchor: 'autumnLitter',
    selector: '#roster-section',
    title: 'Puppy roster',
    body: 'The puppies produced in this litter. Adding puppies creates new dog records — quick-add several at once with “Add N Puppies”, record details like sex and nicknames, and log an event across multiple pups (vaccinations, weight checks) so it lands in every selected pup’s history from one screen.'
  },
  {
    id: 'litter-expenses', hub: 'Breeding', page: 'litter.html', anchor: 'autumnLitter',
    selector: '#expenses-section',
    title: 'Expenses & receipts',
    body: 'Log a litter’s costs here — vet visits, supplies, stud fees. Snap a photo of a paper receipt or attach a PDF when you add or edit an expense, and KennelOS stores it right alongside the entry so you can pull it up again later.'
  },
  {
    id: 'litter-income', hub: 'Breeding', page: 'litter.html', anchor: 'autumnLitter',
    selector: '#income-section',
    title: 'Sales & income',
    body: 'A quick view of a litter’s sales income against what you’ve spent, so you can see the profit you’re making. For the full breakdown — calculations and income split out by type (deposit, purchase price, transport) — head to the Financials hub.'
  },

  // --- People ------------------------------------------------------------
  {
    id: 'people-intro', kind: 'hub-intro', hub: 'People', button: 'Explore People Hub →',
    title: 'People',
    body: 'Everything so far has been about the dogs; this hub is about the other half of a kennel — the people. Keep your contacts here — buyers, breeders, your dog-care team — and record kennel-level details for your own kennel or someone else’s.'
  },
  {
    id: 'contacts-groups', hub: 'People', page: 'contacts.html',
    selector: '#contacts-group-tabs',
    title: 'Contacts',
    body: 'Every contact you’ve recorded, with pre-filtered buckets to help you find people quickly, plus further filtering and sorting options.'
  },
  {
    id: 'contact-profile', hub: 'People', page: 'contact.html', anchor: 'priya',
    selector: '#profile-body',
    title: 'Contact details',
    body: 'Record a contact’s communication details — phone, email — along with things like their website or associated kennel. Remember that you are the contact for your own kennel, so record your own details to drive owner-related features across the app. You’ll also see the dogs a contact owns and the contracts they hold with you.'
  },
  {
    id: 'kennels-list', hub: 'People', page: 'kennels.html',
    selector: '#kennel-list',
    title: 'Kennels',
    body: 'The kennels list holds every kennel you do business with, including your own. Add the ones you work with regularly and link each to its contact — your dogs carry owner and breeder-kennel links back to them.'
  },
  {
    id: 'kennel-config', hub: 'People', page: 'kennel.html', anchor: 'thornfield',
    selector: '#kennel-config',
    title: 'Kennel program config',
    body: 'Set kennel-wide preferences here — the health tests you generally administer, and your standard age for promoting a dog to the breeding roster.'
  },
  {
    id: 'kennel-expenses', hub: 'People', page: 'kennel.html', anchor: 'thornfield',
    selector: '#expenses-section',
    title: 'Kennel expenses',
    body: 'Record kennel-wide expenses that don’t relate to an individual dog or litter — bulk dog-food purchases, facility costs, and the like.'
  },

  // --- Placements --------------------------------------------------------
  {
    id: 'placements-intro', kind: 'hub-intro', hub: 'Placements', button: 'Explore Placements Hub →',
    title: 'Placements & Contracts',
    body: 'This hub drives the business side of your program. Record puppies finding homes (sales), income from studding out your dogs (stud services), and your lease and co-own contracts.'
  },
  {
    id: 'sales-list', hub: 'Placements', page: 'sales.html',
    selector: '#sale-list',
    title: 'Sales',
    body: 'An overview of the sales your kennel is making or has made. Adding a sale lets you record the terms agreed with the buyer, link it to a contract to track the legal record, and print puppy record details for any pup with an open sale.'
  },
  {
    id: 'sale-profile', hub: 'Placements', page: 'sale.html', anchor: 'cedarSale',
    selector: '#profile-section',
    title: 'Sale details',
    body: 'The details of a sale for a particular puppy — sale type (show or pet), a price prefilled from the litter and editable, any transport or deferred pick-up boarding charge, and a status tracking where the sale is in its lifecycle. You can also create or link a contract specific to the sale here.'
  },
  {
    id: 'puppy-record', hub: 'Placements', page: 'puppy-record.html', anchor: 'cedarSale', idParam: 'sale',
    selector: '#pr-root',
    title: 'Puppy Record',
    body: 'A printable handout for the buyer — the puppy’s identity, its sire and dam with their own health testing, the puppy’s own health history, and the buyer’s contact details, all on one page. Reach it from “Print Puppy Record” on the Sales list or from a sale’s own page, then Print / Save as PDF to hand it over or email it.'
  },
  {
    id: 'stud-list', hub: 'Placements', page: 'stud-services.html',
    selector: '#stud-service-list',
    title: 'Stud services',
    body: 'Agreements with other breeders for stud services, tracked whether you own the dam or the sire. Outgoing stud services generate income; for an incoming one, record it as an expense in the pairing history of the resulting pairing.'
  },
  {
    id: 'stud-profile', hub: 'Placements', page: 'stud-service.html', anchor: 'studServiceBirch',
    selector: '#profile-section',
    title: 'Stud service details',
    body: 'Like sales, each stud service expands to show its details. This one is an outgoing studding, where your dog is the sire — a status of “Arranged” means your dog hasn’t left yet to begin the studding (it’s in person). Record sent and return dates to mark the intended duration. Below the details you can create or link a contract and track whether it’s signed.'
  },
  {
    id: 'contracts-list', hub: 'Placements', page: 'contracts.html',
    selector: '#contract-list',
    title: 'Other contracts',
    body: 'Contracts that don’t fit neatly into a sale — like a co-ownership agreement or a lease — live on the Other Contracts tab. It’s your repository of the legal agreements you’ve made with other breeders and owners.'
  },
  {
    id: 'contract-profile', hub: 'Placements', page: 'contract.html', anchor: 'sageLeaseContract',
    selector: '#profile-section',
    title: 'Contract details',
    body: 'A contract carries its own information — the dog, sale, or stud agreement it applies to, the date it was signed, and the counterparty. It also has a link field for the external URL where you store and sign the contract, and it can be sent to the other party through the Companion app if you like.'
  },

  // --- Financials --------------------------------------------------------
  {
    id: 'financials-intro', kind: 'hub-intro', hub: 'Financials', button: 'Explore Financials Hub →',
    title: 'Financials',
    body: 'The Financials hub is where the money lives — earned and anticipated income, expenses by category, your running net, and printable invoices and receipts.'
  },
  {
    id: 'fin-overview', hub: 'Financials', page: 'financials.html',
    selector: '#financials-view-tabs',
    title: 'Financials overview',
    body: 'Your at-a-glance view of where your kennel is receiving — and spending — its money. See your collected and anticipated revenue (completed versus still-in-progress sales and studs), your total expenditures, and the net profit or loss those numbers produce.'
  },
  {
    id: 'fin-breakdown', hub: 'Financials', page: 'financials.html',
    selector: '#summary-section',
    title: 'Income & expense toggles',
    body: 'Here you’ll see the actual details of your income and expenses, and can make adjustments or add new items. Note that income is always derived from a sale or stud service — you can adjust existing values here, but anything completely missing has to be added first in the Placements & Contracts hub before it shows up.'
  },
  {
    id: 'fin-invoice', hub: 'Financials', page: 'financials.html',
    selector: '#gen-document',
    title: 'Invoices & receipts',
    body: 'Generate invoices (for money owed) and receipts (for money paid) right in the app, pre-filled from your existing sales and stud services. Choose full or partial amounts, decide which payment methods you’ll accept, and set due dates easily. Click Print to save a PDF to email or hand over in person.'
  },
  {
    id: 'invoice-doc', hub: 'Financials', page: 'invoice.html', anchor: 'cedarSale',
    selector: '#inv-root',
    title: 'A generated invoice',
    body: 'What comes out of the generator: an itemized bill with due dates, a running balance, and the payment methods you accept — ready to Print / Save as PDF. Switch the doc type in the generator to produce a receipt the same way, for money already collected.'
  },

  // --- More: Reports / Companion / Import-Export --------------------------
  {
    id: 'more-intro', kind: 'hub-intro', hub: 'More', button: 'Explore More Hub →',
    title: 'Reports, Documents, Companion & Backups',
    body: 'Behind the More menu: analytics Reports, Documents for filing a dog’s paperwork, read-only Companion share-outs for buyers and partners, and Import / Export for backups and spreadsheet import.'
  },
  {
    id: 'reports', hub: 'More', page: 'reports.html',
    selector: 'main',
    title: 'Reports',
    body: 'The analytics — reports you can generate from information stored across the app and download as spreadsheets for your physical files.'
  },
  {
    id: 'documents', hub: 'More', page: 'documents.html',
    selector: '#doc-form-modal', beforeShow: { click: '#btn-add-document' },
    title: 'Documents',
    body: 'File a dog’s pedigree, registration, health-test results, or other paperwork here — upload a PDF, or take/choose a photo and KennelOS turns it into a compressed PDF automatically. Everything is grouped by dog and stored right on this device.'
  },
  {
    id: 'companion', hub: 'More', page: 'companion.html',
    selector: '#companion-type-tabs',
    title: 'Companion app',
    body: 'A place to generate snapshots of the information you want to share, in a format that looks like an app, without putting your business online. Three preconfigured Companion packages suit different audiences: pick the toggle, find the relevant contact, preview it, and send off a link. The recipient sees just what you sent, in a clean, readable format.'
  },
  {
    id: 'import-export', hub: 'More', page: 'import-export.html',
    selector: '#btn-backup',
    title: 'Import / export',
    body: 'Where you bring in CSV files to populate a large kennel all at once, and where you back up your entire dataset to protect against loss. There’s no cloud storage, so losing your phone means starting over — back up regularly and keep the file somewhere central, like a Drive or an email to yourself, for easy recovery.'
  }
];
