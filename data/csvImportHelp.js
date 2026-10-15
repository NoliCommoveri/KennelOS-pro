// csvImportHelp.js — the plain-language column guide shown on every CSV import
// screen (assets/importHelp.js renders it). One entry per importer, keyed like
// csvImport.js's MAPPINGS, with one line per column in that mapping's
// `templateHeaders` order: what goes in it, whether it's needed, other header
// names that also work, and (for a controlled list) the values it accepts.
//
// Pure data — no repo, no DOM. `values` is a vocab array (or a function
// returning one, for the edition-aware event types), so the accepted-values list
// is read from vocab.js at render time and can never drift from what the
// importer's normEnum() accepts. tests/csvImportHelp.test.js pins every entry's
// columns to its mapping's templateHeaders, so a new column can't ship unexplained.
//
// `need`:
//   'required' — the row can't be matched or created without it; a row missing
//                it goes to "needs review".
//   'new'      — needed only to create a new record; a row that matches an
//                existing record can leave it blank.
//   'optional' — fill it in or leave it out.
import {
  SEX, OWNERSHIP_TYPE, DOG_STATUS, CONTACT_TYPE, PAIRING_TYPE, PAIRING_METHOD, PAIRING_STATUS,
  LITTER_STATUS, REGISTRATION_TYPE, PLACEMENT_PURPOSE, SALE_STATUS, eventTypesFor,
  STUD_SERVICE_DIRECTION, FEE_STRUCTURE, STUD_SERVICE_STATUS, EXPENSE_CATEGORIES, EXPENSE_SUBJECT_TYPES,
  WAITLIST_PREF_SEX, WAITLIST_READY_TIMING
} from './vocab.js';

export const NEED_LABELS = {
  required: 'Required',
  new: 'Required for new records',
  optional: 'Optional'
};

// Rules that hold for every importer (csvImport.js parseCsv / normDate / normEnum).
export const GENERAL_RULES = [
  'The first row of the file must be the column names. Capitals and spaces don\'t matter: "Call Name", "call name" and "call_name" are the same column.',
  'Columns can be in any order. Columns not listed here are ignored, and you can leave out any column that isn\'t required.',
  'Dates can be written 2024-03-15 or 3/15/2024 (month first).',
  'For columns with a fixed list of values, either the name shown or its code works, in any capitals (e.g. "Co-owned" or "co_owned").',
  'A blank cell never erases what\'s already saved: when a row updates an existing record, only the filled-in cells change it.',
  'Names that point at other records (a sire, a buyer, a kennel) must match a record you already have. A name that isn\'t found is flagged for you to review, never made up — unless the column says otherwise.',
  'Nothing is saved until you review the preview and press Commit import.'
];

const KENNEL_NAME = {
  need: 'optional',
  aliases: ['kennel'],
  text: 'Which of your own kennels this belongs to, by kennel name. Leave blank to use the kennel you\'re working in.'
};
const NOTES = { need: 'optional', text: 'Free-text notes.' };
const DOG_REF = (who) => `The ${who}'s registered name or call name, exactly as it's saved on the dog's record. It can be a dog already in KennelOS or another row of this same file (linked after every row is imported).`;

const HELP = {
  dog: {
    match: 'Each row is matched to an existing dog by registered name + date of birth, call name + date of birth, or registration number. A match updates that dog; no match creates a new one. Parents can go in the same file as their pups.',
    columns: {
      call_name: { need: 'new', aliases: ['name'], text: 'The name you use day to day. A new dog needs it, except a pedigree-only dog with a registered name; an existing dog can be matched by registered name instead.' },
      registered_name: { need: 'optional', aliases: ['reg_name'], text: 'Full registered name. Used first for matching, so include it when the dog has one.' },
      sex: { need: 'new', values: SEX, text: 'M and F also work.' },
      date_of_birth: { need: 'optional', aliases: ['dob', 'birthdate'], text: 'Used with the name to match the dog. A row needs either this or a registration number, or it goes to review.' },
      breed: { need: 'new', text: 'The breed, as you write it in KennelOS.' },
      sire_registered_name: { need: 'optional', aliases: ['sire_name'], text: DOG_REF('sire') },
      dam_registered_name: { need: 'optional', aliases: ['dam_name'], text: DOG_REF('dam') },
      ownership_type: { need: 'new', aliases: ['ownership'], values: OWNERSHIP_TYPE, text: 'How you hold this dog.' },
      status: { need: 'new', values: DOG_STATUS, text: 'The dog\'s current life stage. Blank on a pedigree-only dog means External reference.' },
      owner_name: { need: 'optional', aliases: ['owner', 'owner_contact_name'], text: 'Who owns the dog, by contact name. The contact must already exist. Required for a Leased in dog. A new External dog without one is saved pedigree-only: kept for lineage (a sire or dam from a pedigree), off the Dogs list.' },
      kennel_name: { need: 'optional', aliases: ['kennel'], text: 'The dog\'s kennel, by name. For a dog you own or co-own it must be one of your own kennels (blank = the kennel you\'re working in); an outside dog can name any kennel you have on file.' },
      breeder_kennel_name: { need: 'optional', aliases: ['breeder_kennel'], text: 'The kennel that bred the dog, by name: your own, or an outside kennel on file (import kennels first). An unknown name is flagged for review.' },
      color_markings: { need: 'optional', aliases: ['color', 'markings'], text: 'Color and markings.' },
      registry: { need: 'optional', text: 'The registry, e.g. AKC or UKC.' },
      registration_number: { need: 'optional', aliases: ['reg_number'], text: 'Registration number. Also matches the dog on its own, written any way ("NP888072/07 03-25" and "np88807207" are the same), so a dog from a pedigree needs no date of birth.' },
      microchip_id: { need: 'optional', aliases: ['microchip'], text: 'Microchip number.' },
      coi_value: { need: 'optional', aliases: ['coi'], text: 'A recorded inbreeding coefficient (COI) as a number, e.g. 6.25. The three COI columns below are saved only when this is filled in.' },
      coi_method: { need: 'optional', text: 'How the COI was worked out, e.g. "10 generations".' },
      coi_source: { need: 'optional', text: 'Where the COI came from, e.g. a registry or database name.' },
      coi_as_of: { need: 'optional', aliases: ['coi_as_of_date'], text: 'The date the COI was calculated.' },
      notes: NOTES
    }
  },

  kennel: {
    match: 'Each row is matched to an existing kennel by name (capitals and extra spaces ignored). A match fills in that kennel; no match adds it as an outside kennel. Import kennels before contacts and dogs, so their kennel columns can find them.',
    columns: {
      kennel_name: { need: 'required', aliases: ['kennel', 'name'], text: 'The kennel\'s name. Type it the way its owner does: a kennel card from them is offered as a link only when the names match.' },
      prefix: { need: 'optional', text: 'The prefix its dogs\' registered names start with.' },
      location: { need: 'optional', text: 'Where the kennel is, e.g. a town and state.' },
      website: { need: 'optional', aliases: ['url'], text: 'A web address for the kennel.' }
    }
  },

  contact: {
    match: 'Each row is matched to an existing contact by name (capitals and extra spaces ignored). A match updates that contact; no match creates a new one.',
    columns: {
      name: { need: 'required', aliases: ['contact_name'], text: 'The person\'s or business\'s name.' },
      contact_type: { need: 'optional', aliases: ['type', 'types'], values: CONTACT_TYPE, text: 'One or more types, separated by commas or semicolons (e.g. "Breeder; Co-owner").' },
      email: { need: 'optional', text: 'Email address.' },
      phone: { need: 'optional', aliases: ['telephone'], text: 'Phone number.' },
      facebook_profile: { need: 'optional', aliases: ['facebook', 'fb_profile'], text: 'Link to their Facebook profile.' },
      address: { need: 'optional', text: 'Mailing address.' },
      kennel_name: { need: 'optional', aliases: ['kennel'], text: 'Their kennel, by name. It must already be a kennel on file (import kennels first); an unknown name is left blank and flagged.' },
      notes: NOTES
    }
  },

  pairing: {
    match: 'Each row is matched to an existing pairing by sire + dam + planned date. A match updates that pairing; no match creates a new one.',
    columns: {
      sire_registered_name: { need: 'required', aliases: ['sire_name'], text: DOG_REF('sire') },
      dam_registered_name: { need: 'required', aliases: ['dam_name'], text: DOG_REF('dam') },
      pairing_type: { need: 'new', aliases: ['type'], values: PAIRING_TYPE, text: 'Whether this pairing is planned or has actually happened.' },
      method: { need: 'optional', values: PAIRING_METHOD, text: 'How the breeding was done.' },
      status: { need: 'new', values: PAIRING_STATUS, text: 'Where the pairing stands.' },
      planned_date: { need: 'required', text: 'The planned (or actual) breeding date. Used to match the pairing.' },
      expected_due_date: { need: 'optional', text: 'The expected whelping date.' },
      kennel_name: KENNEL_NAME,
      notes: NOTES
    }
  },

  litter: {
    match: 'Each row is matched to an existing litter by dam + sire + whelp date. A match updates that litter; no match creates a new one.',
    columns: {
      dam_registered_name: { need: 'required', aliases: ['dam_name'], text: DOG_REF('dam') },
      sire_registered_name: { need: 'required', aliases: ['sire_name'], text: DOG_REF('sire') },
      nickname: { need: 'optional', text: 'A name for the litter, e.g. "Spring 2024" or "Gemstone litter".' },
      whelp_date: { need: 'required', text: 'The date the litter was born. Used to match the litter.' },
      litter_registration_number: { need: 'optional', aliases: ['registration_number'], text: 'The litter\'s registration number.' },
      puppies_born_total: { need: 'optional', text: 'Total puppies born, as a whole number.' },
      puppies_born_alive: { need: 'optional', text: 'Puppies born alive, as a whole number.' },
      puppies_born_deceased: { need: 'optional', text: 'Puppies born deceased, as a whole number.' },
      status: { need: 'new', values: LITTER_STATUS, text: 'Where the litter stands.' },
      kennel_name: KENNEL_NAME,
      notes: NOTES
    }
  },

  sale: {
    match: 'Each row is matched to an existing sale by dog + buyer name + sale date. A match updates that sale; no match creates a new one.',
    columns: {
      dog_registered_name: { need: 'required', aliases: ['dog_name'], text: DOG_REF('dog sold') },
      buyer_name: { need: 'required', aliases: ['buyer'], text: 'The buyer\'s name. If no contact has that name yet, a new contact (type Buyer) is created for them when you commit.' },
      sale_date: { need: 'required', text: 'The date of the sale. Used to match the sale.' },
      registration_type: { need: 'new', aliases: ['registration'], values: REGISTRATION_TYPE, text: 'The registration the buyer gets. "Unregistered" also works for None.' },
      status: { need: 'new', values: SALE_STATUS, text: 'Where the sale stands.' },
      price: { need: 'optional', text: 'The sale price, as a number (e.g. 2500).' },
      deposit_amount: { need: 'optional', text: 'The deposit, as a number.' },
      deposit_date: { need: 'optional', text: 'The date the deposit was paid.' },
      balance_paid_date: { need: 'optional', text: 'The date the balance was paid.' },
      kennel_name: KENNEL_NAME,
      lead_source: { need: 'optional', text: 'How the buyer found you, e.g. "Website" or "Referral".' },
      notes: NOTES
    }
  },

  event: {
    match: 'Each row is a dated event on a dog\'s history. It\'s matched to an existing event by dog + event type + date (and the title, when more than one event shares those). A match updates that event; no match creates a new one.',
    columns: {
      dog_registered_name: { need: 'required', aliases: ['dog_name'], text: DOG_REF('dog') },
      event_type: { need: 'required', aliases: ['type'], values: () => eventTypesFor('dog'), text: 'What kind of event it is.' },
      event_date: { need: 'required', text: 'The date it happened (or the start date, for something that lasts several days).' },
      event_end_date: { need: 'optional', text: 'The end date, only for events that last a span of time (such as a heat cycle, boarding or a course of medication). Ignored on single-day event types.' },
      title: { need: 'new', text: 'A short title, e.g. "Rabies booster".' },
      related_contact_name: { need: 'optional', text: 'A contact involved (a vet, a handler), by name. The contact must already exist.' },
      reminder_date: { need: 'optional', text: 'A date to be reminded about this event.' },
      details_json: { need: 'optional', text: 'Advanced: extra type-specific details as a JSON object, e.g. {"weight_lbs": 12.5}. Leave blank if you\'re not sure.' },
      notes: NOTES
    }
  },

  stud_service: {
    match: 'Each row is matched by your dog + the partner dog. If a stud service with that pair already exists, the row goes to review so you can choose between updating it and adding a repeat service.',
    columns: {
      direction: { need: 'required', aliases: ['who_travels'], values: STUD_SERVICE_DIRECTION, text: 'Who travels: "Our dog goes to them", "Their dog comes to us", or "No one travels" for AI / shipped (ours, theirs and AI work too). Which dog is the stud comes from your dog\'s sex.' },
      our_dog_registered_name: { need: 'required', aliases: ['our_dog_name'], text: DOG_REF('your dog') },
      partner_dog_registered_name: { need: 'required', aliases: ['partner_dog_name'], text: 'The other dog\'s registered or call name. It must already exist in KennelOS (add it as an external dog first if needed).' },
      partner_contact_name: { need: 'new', text: 'The other dog\'s owner. If no contact has that name yet, a new contact (type Breeder) is created when you commit.' },
      fee_amount: { need: 'optional', text: 'The stud fee, as a number.' },
      fee_structure: { need: 'optional', values: FEE_STRUCTURE, text: 'How the fee is paid.' },
      status: { need: 'new', values: STUD_SERVICE_STATUS, text: 'Where the stud service stands.' },
      kennel_name: KENNEL_NAME,
      result_notes: { need: 'optional', text: 'How it turned out.' }
    }
  },

  expense: {
    match: 'Each row is one cost. Re-importing the same file updates rather than duplicates: a row with a receipt number matches by that number; otherwise by what it\'s attached to + date + amount + category + vendor. You can change what each row attaches to on the next screen.',
    columns: {
      subject_type: { need: 'optional', aliases: ['subject'], values: EXPENSE_SUBJECT_TYPES, text: 'What the cost belongs to. Blank means Kennel (general overhead). Litter and pairing costs can\'t be imported here; log them from the litter or pairing.' },
      subject_name: { need: 'optional', aliases: ['kennel_name', 'dog_name', 'dog_registered_name'], text: 'The kennel or dog by name. Needed for a dog. For a kennel, blank means your own kennel.' },
      expense_date: { need: 'required', aliases: ['date'], text: 'The date of the cost.' },
      amount: { need: 'required', aliases: ['total', 'cost'], text: 'The cost, as a number ($ signs and commas are fine). Not needed on a mileage row, which works out the amount from miles.' },
      category: { need: 'optional', values: EXPENSE_CATEGORIES, text: 'Blank or unrecognized means Other. Mileage rows are always Mileage.' },
      vendor: { need: 'optional', aliases: ['merchant', 'payee'], text: 'Who you paid.' },
      miles: { need: 'optional', aliases: ['distance'], text: 'For a mileage row: the miles driven. The amount is miles × the mileage rate.' },
      mileage_rate: { need: 'optional', aliases: ['rate', 'rate_per_mile'], text: 'The rate per mile for a mileage row. Blank uses the default rate in Settings.' },
      receipt_number: { need: 'optional', aliases: ['receipt_no', 'receipt', 'receipt_#'], text: 'A receipt number. When present, it\'s what the row is matched on.' },
      notes: { need: 'optional', aliases: ['memo', 'description'], text: 'Free-text notes.' }
    }
  },

  waitlist: {
    match: 'Each row is one application (a Google Form export works as is). It\'s matched by email on that kennel\'s list: an application still under review is refreshed; someone already approved or on the list is left alone. New rows join the list as Applied.',
    footnote: 'Answer columns can also use the wording of your own application form\'s questions, so a file exported from that form lines up without renaming anything.',
    columns: {
      name: { need: 'required', aliases: ['full_name', 'your_name', 'applicant_name'], text: 'The applicant\'s name.' },
      email: { need: 'required', aliases: ['email_address', 'your_email'], text: 'The applicant\'s email. Used to spot duplicates.' },
      phone: { need: 'optional', aliases: ['phone_number', 'telephone'], text: 'Phone number.' },
      location: { need: 'optional', aliases: ['city', 'city_state'], text: 'Where they live.' },
      applied_date: { need: 'optional', aliases: ['timestamp', 'date', 'submitted'], text: 'When they applied. A Google Form timestamp works (the time is dropped).' },
      pref_sex: { need: 'optional', aliases: ['sex', 'preferred_sex', 'gender'], values: WAITLIST_PREF_SEX, text: 'Boy, Girl and "No preference" also work.' },
      pref_breed: { need: 'optional', aliases: ['breed', 'preferred_breed'], text: 'The breed they want. It must be one of this kennel\'s breeds; otherwise it\'s left as any breed and flagged.' },
      pref_purposes: { need: 'optional', aliases: ['purposes', 'purpose', 'looking_for'], values: PLACEMENT_PURPOSE, text: 'What they want a puppy for. One or more, separated by commas (e.g. "Pet, Show"). Companion, agility and conformation also work.' },
      pref_colors: { need: 'optional', aliases: ['colors', 'color'], text: 'Colors they\'d like, separated by commas.' },
      ready_timing: { need: 'optional', aliases: ['ready', 'how_soon'], values: WAITLIST_READY_TIMING, text: 'The soonest they can commit. "1", "3 months" and "6+" also work.' },
      program: { need: 'optional', text: 'A waitlist program on this kennel, by name. It must already exist.' },
      heard_from: { need: 'optional', aliases: ['referral', 'source'], text: 'How they heard about you.' },
      household: { need: 'optional', aliases: ['household_members'], text: 'About their household.' },
      other_pets: { need: 'optional', aliases: ['pets', 'current_pets'], text: 'Pets they have now.' },
      experience: { need: 'optional', aliases: ['breed_experience', 'dog_experience'], text: 'Their experience with dogs or the breed.' },
      about: { need: 'optional', aliases: ['about_your_family', 'anything_else'], text: 'Anything else they told you.' },
      kennel_name: { need: 'optional', aliases: ['kennel'], text: 'Which of your kennels\' lists this goes on. Blank uses the kennel picked above.' },
      notes: { need: 'optional', text: 'Your own notes.' }
    }
  }
};

// The guide for one importer: { match, footnote?, columns: [{ name, need,
// needLabel, aliases, text, values: [label…] | null }] }, in column order.
export function importHelp(entity) {
  const h = HELP[entity];
  if (!h) throw new Error(`No import help for "${entity}".`);
  return {
    match: h.match,
    footnote: h.footnote || '',
    columns: Object.entries(h.columns).map(([name, c]) => {
      const vocab = typeof c.values === 'function' ? c.values() : c.values;
      return {
        name,
        need: c.need,
        needLabel: NEED_LABELS[c.need],
        aliases: c.aliases || [],
        text: c.text,
        values: vocab ? vocab.map((v) => v.label) : null
      };
    })
  };
}

export const HELP_ENTITIES = Object.keys(HELP);

// A blank template file: just the header row, in column order.
export function templateCsv(entity) {
  return importHelp(entity).columns.map((c) => c.name).join(',') + '\r\n';
}
