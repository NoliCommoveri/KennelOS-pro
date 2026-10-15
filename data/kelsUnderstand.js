// kelsUnderstand.js — Kels's "Understanding Something" (Kels roadmap §3.14 A,
// End-State guide §33): how the app works, as an FAQ. Pure data plus
// understandEntries() / understandCandidates(); assets/kelsUnderstandUI.js asks.
//
// What goes here (decided): only the rules a breeder who knows dogs and has used
// other apps would still get wrong in KennelOS. Not what any app does (one record
// per dog, a link entered once shows everywhere), not what a screen already says.
// Each answer is a few plain sentences, the way she'd say it out loud: no field
// names, no ids. Written by us from the rules as built; when a rule changes, its
// answer changes in the same edit.
//
// An entry: { id, section, q (the question, as she'd ask it), a (the answer:
//   a string, or (ctx) => string; plain text, escaped when shown), keywords,
//   href? + show? (the Show me button: a page relative to pages/, its label),
//   flag? (an editionFlags key it needs), when? ((ctx) => false hides it) }.
// ctx: { flags, edition, cloud (cloud backup offered), vault (Sensitive records
//   offered), online (the online waitlist offered), page(href) (this edition has
//   that page) }.
//
// Edition-honest (roadmap §2.3): an entry or a sentence about a feature the
// edition lacks isn't there. Lite's limit isn't a topic at all.
import { isProOnlyPage } from './proPages.js';

export const SECTIONS = [
  { id: 'today', label: 'The Today hub' },
  { id: 'dogs', label: 'Dogs and puppies' },
  // Lite has no archiving to speak of: its word is removing (a dog leaves the program).
  { id: 'removing', label: 'Archiving and deleting', labelNoArchive: 'Removing and deleting' },
  { id: 'breeding', label: 'Breedings and litters' },
  { id: 'money', label: 'Money' },
  { id: 'waitlist', label: 'The waitlist' },
  { id: 'data', label: 'Your data and devices' }
];

const tail = (cond, text) => (cond ? ` ${text}` : '');
const joinList = (xs, word) => (xs.length > 2 ? `${xs.slice(0, -1).join(', ')} ${word} ${xs.at(-1)}` : xs.join(` ${word} `));

export const ENTRIES = [
  // The Today hub
  { id: 'today-nudges', section: 'today', q: 'What are nudges?',
    keywords: ['nudge', 'nudges', 'suggestion', 'suggestions', 'today', 'attention', 'prompt', 'rules', 'dismiss'],
    href: 'today.html', show: 'Show me Today',
    a: 'Nudges are suggestions the app works out from your records. A set of rules looks for things that need your attention, like a detail to update or a page to open and review. Nothing changes until you tap one of a nudge\'s buttons. A nudge goes away by itself once what it\'s about is taken care of, and Dismiss hides it on this device only.' },
  { id: 'today-reminders', section: 'today', q: 'How do reminders work?',
    keywords: ['reminder', 'reminders', 'due', 'next', 'vaccination', 'vaccine', 'shots', 'checkup', 'annual', 'recurring', 'snooze', 'overdue'],
    href: 'reminders.html', show: 'Show me my reminders',
    a: 'Any event you log on a dog can have a reminder date, like when the next vaccination or annual checkup is due. Every reminder still pending shows under Reminders on Today, as Overdue, Due soon (the next 30 days) or Upcoming. Log new opens a fresh entry of the same kind for that dog, where you can set the reminder for the time after, and saving it clears the old reminder. If you log the next one some other way, Dismiss the old reminder yourself, or Snooze it to a later date.' },
  { id: 'active-litter', section: 'today', q: 'What is an "active litter"?',
    keywords: ['active', 'active litter', 'active litters', 'litter', 'available', 'sold', 'today', 'for sale', 'add sale'],
    href: 'today.html', show: 'Show me Today',
    a: 'A litter with at least one pup marked Available. It shows under Active litters on Today with its pups marked Available, Undecided or Placed, and how many are sold, counting the Placed ones. Pups you\'re keeping or have on Health hold aren\'t listed. Once no pup is Available, the litter leaves that list, even if it isn\'t closed yet.' },
  { id: 'today-upcoming', section: 'today', q: 'What shows under Due outs & upcoming?',
    keywords: ['due out', 'due outs', 'upcoming', 'scheduled', 'vet visit', 'surgery', 'drop off', 'future', 'today'],
    a: (ctx) => 'Every event dated today or later, like a drop-off, a vet visit or a surgery. It lists one-day events only, so a stay that runs over several days, like boarding, is under Away from home instead.'
      + tail(ctx.flags.shows, 'Shows in the next two weeks have their own card, Upcoming shows.') },
  { id: 'today-away', section: 'today', q: 'Why isn\'t my dog under Away from home?',
    keywords: ['away', 'away from home', 'boarding', 'board', 'stay', 'trip', 'gone', 'location', 'return'],
    a: (ctx) => 'Away from home lists only Boarding entries that haven\'t ended yet, so medications and heat cycles never show there.'
      + tail(ctx.flags.studServices, 'A stud service\'s trip counts, because saving the service logs it as Boarding.')
      + ' A stay with no return date stays on the list until you add one.' },

  // Dogs and puppies
  { id: 'keeping-puppy', section: 'dogs', q: 'I\'m keeping a puppy. Why is it still a puppy?',
    keywords: ['keep', 'keeping', 'kept', 'promote', 'grown', 'adult', 'breeding', 'status', 'plan', 'disposition'],
    href: 'dogs.html?bucket=puppies', show: 'Show me my puppies',
    a: (ctx) => 'Keeping is your plan for the pup, not its stage of life. It stays a Puppy until you change its status to Active breeding (or another adult status) on its page, and the app never does that for you.'
      + tail(ctx.page('kennel.html'), 'On your kennel\'s page you can pick an age, one for boys and one for girls, and you\'ll be prompted when a kept pup reaches it.') },
  { id: 'unfinished-litter', section: 'dogs', q: 'Why does a litter still look unfinished?',
    keywords: ['litter', 'open', 'active', 'close', 'closed', 'finished', 'done', 'today', 'undecided', 'available', 'plan'],
    href: 'litters.html', show: 'Show me my litters',
    a: 'It\'s the pups\' plans and their sales. A pup marked Available keeps its litter showing as active. A pup marked Undecided, or never given a plan, stops me from suggesting you close the litter, and so does any sale on the litter that isn\'t finished yet, even for a pup marked Placed. Every sale has to be Delivered, Cancelled, Voided or Returned, with at least one pup gone home Delivered. Keeping and Health hold settle a pup, so a pup you\'re holding back won\'t keep its litter open.' },
  { id: 'health-hold', section: 'dogs', q: 'What does Health hold do?',
    keywords: ['health', 'hold', 'sick', 'not for sale', 'returned', 'plan', 'disposition'],
    a: (ctx) => `Health hold marks a pup you can't sell right now for a health reason. It doesn't count as available${ctx.flags.waitlist ? ', and the waitlist never offers it,' : ''} until you change it. When a sale is returned or falls through for a health reason, the app suggests it.` },
  { id: 'owner-needed', section: 'dogs', q: 'Which dogs need an owner?',
    keywords: ['owner', 'external', 'outside', 'someone else', 'leased', 'lease', 'pedigree', 'ancestor', 'stud'],
    flag: 'externalOwnership', href: 'dogs.html?bucket=external', show: 'Show me other people\'s dogs',
    a: 'A dog marked External or Leased in needs its owner linked as a contact: a stud you used, a dog leased to you, a pup you sold and changed to External. Co-owned and Leased out dogs don\'t, because you\'re an owner. A dog that\'s only there to fill in a pedigree (an ancestor) doesn\'t need one either, and isn\'t counted as one of your dogs.' },
  { id: 'pedigree-only', section: 'dogs', q: 'What happens to a parent I type in that isn\'t mine?',
    keywords: ['pedigree', 'ancestor', 'parent', 'sire', 'dam', 'grandparent', 'outside'],
    when: (ctx) => !ctx.flags.externalOwnership,
    a: 'It\'s kept just for the pedigree, as an ancestor. It isn\'t counted as one of your dogs and doesn\'t need any details beyond its name.' },
  { id: 'gone-home', section: 'dogs', q: 'What happens to a pup\'s record after it goes home?',
    keywords: ['gone home', 'go home', 'sold', 'delivered', 'placed', 'external', 'owner', 'remove', 'family'],
    a: (ctx) => (ctx.flags.externalOwnership
      ? 'When you mark its sale Delivered, the app asks whether to change the pup to External with the family as its owner, or to Co-owned. External moves it off your own dogs while its litter, sale and history stay linked. You can skip it and do it later on the pup\'s page.'
      : 'When you mark its sale Delivered, the app asks to remove the pup from your program. Its litter, sale and history stay on file, and it stays in pedigrees. That can\'t be undone, so it waits for Delivered.') },
  { id: 'kennel-scope', section: 'dogs', q: 'I can\'t find a litter or sale I entered. Where did it go?',
    keywords: ['missing', 'disappeared', 'gone', 'cant find', 'kennel', 'switch', 'scope', 'lost'],
    flag: 'multiKennel', href: 'kennels.html', show: 'Show me my kennels',
    a: 'Each litter, sale, breeding and contract belongs to the kennel of your dog in it, not the kennel you were viewing: a sale goes with the pup\'s kennel, a litter or breeding with the dam\'s (else the sire\'s), and a contract with whatever it covers. Only when none of its dogs is yours does it go on the kennel you were viewing. Lists and reports show only the kennel you\'re viewing, so switch to that dog\'s kennel, or All kennels, to see it. Dogs that belong to someone else show under every kennel.' },

  // Archiving and deleting
  { id: 'archive-dog', section: 'removing', q: 'What happens when I archive a dog?',
    keywords: ['archive', 'archived', 'hide', 'remove', 'history'],
    flag: 'manualDogArchive',
    a: 'It\'s hidden from your lists, but its litters, sales, history and money stay exactly as they were, and it still shows in pedigrees. Archiving never spreads: its puppies, litters and sales aren\'t archived with it.' },
  { id: 'remove-dog', section: 'removing', q: 'What happens when a dog leaves my program?',
    keywords: ['remove', 'leave', 'leaves', 'left', 'program', 'gone', 'history'],
    when: (ctx) => !ctx.flags.manualDogArchive,
    a: 'It\'s hidden from your lists, but its litters, sales and history stay on file and it still shows in pedigrees. Nothing linked to it is removed with it. It can\'t be undone, so it\'s only for a dog that has really left.' },
  { id: 'archive-money', section: 'removing', q: 'Why did a sale\'s money disappear from Financials?',
    keywords: ['archive', 'archived', 'sale', 'expense', 'money', 'income', 'missing', 'financials', 'disappeared'],
    flag: 'manualDogArchive', href: 'financials.html', show: 'Show me Financials',
    a: (ctx) => `Archiving a sale or an expense takes its money out of Financials${ctx.flags.reports ? ' and reports' : ''}. Only archive one that was entered by mistake. A sale that fell through should be ended with a status instead (Cancelled, Voided or Returned), so its money counts the right way.` },
  { id: 'mistake-money', section: 'removing', q: 'I entered a sale or an expense by mistake. How do I take it out?',
    keywords: ['mistake', 'wrong', 'delete', 'remove', 'sale', 'expense', 'money', 'financials', 'take out', 'undo'],
    when: (ctx) => !ctx.flags.manualDogArchive, href: 'financials.html', show: 'Show me Financials',
    a: 'Delete it on its page, and its money leaves Financials. Delete is only for a mistake. A sale that fell through should be ended with a status instead (Cancelled, Voided or Returned), so its money counts the right way.' },
  { id: 'cant-delete', section: 'removing', q: 'Why can\'t I delete something?',
    keywords: ['delete', 'remove', 'blocked', 'cant', 'mistake', 'erase'],
    a: 'Delete is only for undoing a mistake, so it\'s refused while anything else points at the record. The message says what\'s in the way, like 3 events or a sale.' },
  { id: 'deceased', section: 'removing', q: 'How do I record a dog that died?',
    keywords: ['died', 'death', 'dead', 'deceased', 'passed', 'lost', 'rainbow bridge'],
    a: (ctx) => `Change its status to Deceased and enter the date${ctx.flags.manualDogArchive ? ', rather than archiving it' : ''}. You\'ll then be prompted about anything still open for it, like a sale or a planned breeding. For a puppy, the app also offers to ${ctx.flags.manualDogArchive ? 'archive it' : 'remove it from your program'}.` },

  // Breedings and litters
  { id: 'pairing-litter', section: 'breeding', q: 'My dog is pregnant or had puppies. How do I enter this so I can sell them?',
    keywords: ['pairing', 'breeding', 'bred', 'mating', 'litter', 'expected', 'pregnant', 'due', 'puppies', 'born',
      'whelped', 'add puppies', 'record litter', 'record the litter', 'enter litter', 'sell', 'selling', 'for sale', 'available', 'plan', 'disposition'],
    href: 'breeding.html', show: 'Show me Breeding',
    a: 'In four steps. First, record the breeding (a pairing) on Breeding, with the dates she was bred. Next, make her litter from that breeding. It stays Expected until the pups are born, and the app reminds you when one moves along and the other hasn\'t. When they\'re born, change the litter to Whelped and add each puppy on the litter\'s page. Last, give each pup a plan: Available for one you\'re selling, Keeping for one you\'re holding back, or Undecided until you know. If you\'d rather not do it by hand, Record a litter with Kels on Breeding walks you through all four.' },
  { id: 'our-stud', section: 'breeding', q: 'My stud bred someone else\'s female. Should I record the litter?',
    keywords: ['stud', 'outside', 'someone else', 'litter', 'pick', 'pick puppy', 'stud service'],
    flag: 'studServices', href: 'stud-services.html', show: 'Show me stud services',
    a: 'No, that litter is hers to track. You should record the stud service on Placements & Contracts, on its Stud Services tab. Set the terms, including the fee structure, so that money you\'re paid counts as income. If your fee includes a pick of the litter, you\'ll be prompted about the pick once the pups would be old enough to come to you.' },
  { id: 'litter-logging', section: 'breeding', q: 'I logged something (like a deworming) for the whole litter. Why can\'t I see it on the litter page?',
    keywords: ['litter', 'whole', 'all', 'pups', 'log', 'event', 'weight', 'shots', 'deworm', 'deworming', 'each',
      'litter page', 'timeline', 'history', 'missing', 'can\'t see', 'where'],
    a: 'Most events, even ones for the pups of a single litter, are logged on each dog as its own entry. That keeps every pup\'s history a running record of what happened to it throughout its life. To see them, open a pup\'s page and look in its Event History.' },
  { id: 'go-home-day', section: 'breeding', q: 'Where do I put the date a pup goes home?',
    keywords: ['go home', 'going home', 'pickup', 'pick up', 'drop off', 'dropoff', 'date', 'placement', 'boarding', 'delivered'],
    href: 'scheduled-placements.html', show: 'Show me scheduled drop-offs',
    a: (ctx) => 'It\'s a Placement / drop-off entry in the pup\'s Event History, not a date on the sale. If the family is paying you to keep the pup past its ready date, log that stay as a separate Boarding entry too. Once the drop-off date has passed, the app asks whether the pup went home and offers to mark the sale Delivered. '
      + (ctx.flags.externalOwnership
        ? 'Marking it Delivered then asks about changing the pup to External with the family as its owner, which takes it off your own dogs.'
        : 'Marking it Delivered then asks about removing the pup from your program.') },

  // Money
  { id: 'add-income', section: 'money', q: 'How do I add income?',
    keywords: ['income', 'add', 'enter', 'money', 'earnings', 'revenue', 'payment', 'ledger'],
    href: 'financials.html?view=income', show: 'Show me my income',
    a: (ctx) => {
      const from = ['your sales', ctx.flags.studServices && 'stud fees you earned', ctx.flags.waitlist && 'waitlist fees'].filter(Boolean);
      const edit = ['sale', ctx.flags.studServices && 'stud service', ctx.flags.waitlist && 'waitlist family'].filter(Boolean);
      return `You don't type it in. Income comes from ${joinList(from, 'and')}. To change an income line, edit the ${joinList(edit, 'or')} it comes from.`;
    } },
  { id: 'earned', section: 'money', q: 'When does a payment count as earned?',
    keywords: ['earned', 'anticipated', 'expected', 'paid', 'counted', 'net', 'deposit', 'balance'],
    href: 'financials.html?view=income', show: 'Show me my income',
    a: (ctx) => 'On a sale, when its paid date is entered, or when the sale\'s status has moved past it: Deposit paid counts the deposit, and Paid in full or Delivered count the rest, transport and boarding included.'
      + tail(ctx.flags.studServices, 'A stud fee you earn counts once the service is Completed.')
      + tail(ctx.flags.waitlist, 'A waitlist fee counts once you record it received.')
      + ' Until then it\'s expected, and expected money is never in your Net.' },
  { id: 'sale-ended', section: 'money', q: 'What happens to the money when a sale falls through?',
    keywords: ['cancelled', 'canceled', 'voided', 'void', 'returned', 'refund', 'fell through', 'backed out', 'deposit', 'keep'],
    a: 'It depends how it ended. Cancelled (the family backed out) and Returned keep only payments that have a paid date, so enter the deposit date before you cancel. Voided (it fell through on your side), or a pup returned for a health problem, counts nothing: that money is taken as refunded or moved to another pup.' },
  { id: 'expense-home', section: 'money', q: 'Where do general costs go?',
    keywords: ['expense', 'general', 'overhead', 'food', 'supplies', 'cost', 'bought', 'purchase', 'dog purchase'],
    href: 'financials.html?view=expenses', show: 'Show me my expenses',
    a: 'Every expense belongs to a dog, a litter, a breeding or your kennel. Put general costs, like food in bulk or your website, on your kennel. Buying a dog is an expense on that dog, not a sale.' },
  { id: 'event-cost', section: 'money', q: 'I typed a cost on an event. Where did it go?',
    keywords: ['cost', 'event', 'vet', 'expense', 'price', 'where'],
    href: 'financials.html?view=expenses', show: 'Show me my expenses',
    a: 'It became an expense, linked to that event, so it\'s in Financials. Clearing the cost on the event deletes that expense.' },
  { id: 'stud-fee', section: 'money', q: 'Is a stud fee income or an expense?',
    keywords: ['stud', 'fee', 'income', 'expense', 'pick', 'pick puppy', 'paid'],
    flag: 'studServices',
    a: 'A stud fee you pay is an expense, and one you earn is income. When you complete a stud service for your female with a fee, the app offers to log the expense for you. A pick puppy\'s value is never counted as money in.' },
  { id: 'processing-fee', section: 'money', q: 'Why is my income less than the price?',
    keywords: ['fee', 'processing', 'stripe', 'paypal', 'marketplace', 'less', 'price', 'card'],
    flag: 'accounts',
    a: 'When a sale goes through a payment service or marketplace that takes a fee, the price stays the full amount and the fee comes off your income, so income is what you actually received. Families never see that fee.' },
  { id: 'foster-money', section: 'money', q: 'How is money split on a foster litter?',
    keywords: ['foster', 'split', 'share', 'caretaker', 'owner'],
    flag: 'fosterArrangement',
    a: 'Whoever has the puppies records the sales, and the other side\'s share is an expense on the litter. Costs the other side will pay you back for are marked reimbursable, and leave the litter\'s costs once they\'re repaid.' },

  // The waitlist
  { id: 'wl-position', section: 'waitlist', q: 'How is a family\'s place in line decided?',
    keywords: ['place', 'position', 'order', 'line', 'rank', 'first', 'fourth', 'ahead', 'why'],
    flag: 'waitlist', href: 'waitlist.html', show: 'Show me my waitlist',
    a: 'Families in a program you\'ve put ahead come first. Then it\'s the date their fee was received (or a date you set their place to), and on the same day, the order they paid in. If you waived their fee, it\'s the day you approved them.' },
  { id: 'wl-not-offered', section: 'waitlist', q: 'Why wasn\'t a family offered a litter?',
    keywords: ['offered', 'skipped', 'passed over', 'eligible', 'match', 'why not', 'litter'],
    flag: 'waitlist',
    a: 'A family is offered a litter only when at least one available pup in it matches what they asked for (sex, breed and purpose, and color if you turned color matching on), they aren\'t paused, and they\'re listening for those parents. Otherwise the turn goes to the next family who matches.' },
  { id: 'wl-available', section: 'waitlist', q: 'Which pups does the waitlist count as available?',
    keywords: ['available', 'pups', 'sale', 'deposit', 'off the market', 'offer'],
    flag: 'waitlist',
    a: 'Pups that aren\'t kept, placed or on Health hold, and that have no sale going or delivered. Any open sale takes a pup off the market, even one still waiting on its deposit. When a sale is cancelled, voided or returned, the pup counts again once you change it back from Placed (the app asks).' },
  { id: 'wl-turns', section: 'waitlist', q: 'How do turns and passes work?',
    keywords: ['turn', 'pass', 'passes', 'not this litter', 'skip', 'removed', 'limit'],
    flag: 'waitlist',
    a: 'One family holds a turn at a time, and their turn covers every open litter they match. Passing ends the whole turn and counts as one pass, and so does letting the turn run out without an answer, unless you turn that off in your waitlist settings. "Not this litter" skips one litter without using a pass, but if they said it to every litter in their turn, that turn counts as one pass. Families in a program you set so passes don\'t count never use one. At the pass limit (2 unless you change it) the family is removed, and you have 7 days to undo it.' },
  { id: 'wl-pause', section: 'waitlist', q: 'Does pausing cost a family their place?',
    keywords: ['pause', 'paused', 'listen', 'only', 'parents', 'place', 'hold', 'ready'],
    flag: 'waitlist',
    a: 'No. A paused family keeps their place and is just skipped until they\'re back. Listening only for certain parents works the same way.' },
  { id: 'wl-auto', section: 'waitlist', q: 'Do offers go out or expire by themselves?',
    keywords: ['automatic', 'auto', 'expire', 'expired', 'overdue', 'offer', 'deadline', 'no response'],
    flag: 'waitlist',
    a: 'Not unless you turn automatic offers on in your waitlist settings. Otherwise you make each offer, and you\'ll be prompted to decide on an offer or fee that runs past its time.' },
  { id: 'wl-pick', section: 'waitlist', q: 'When is a family\'s pick final?',
    keywords: ['pick', 'picked', 'deposit', 'accept', 'final', 'placed', 'reserved'],
    flag: 'waitlist',
    a: 'When you offer the next family a turn. A pick makes a sale waiting on its deposit, and the pup is off the market while it waits. Confirming the deposit places the pup and the family, but until the next family is offered a turn, they can still switch to another pup that matches.' },
  { id: 'wl-lost-pup', section: 'waitlist', q: 'A family\'s pup can\'t go home. Do they lose their place?',
    keywords: ['lost', 'died', 'returned', 'voided', 'place', 'back', 'carry', 'refund'],
    flag: 'waitlist',
    a: 'No. When the sale ends, you\'re asked whether they go back to their original place, and whether what they paid carries over to their next pick.' },
  { id: 'wl-fee-credit', section: 'waitlist', q: 'Does the application fee come off the pup\'s price?',
    keywords: ['fee', 'application', 'credit', 'credited', 'price', 'twice', 'balance'],
    flag: 'waitlist',
    a: 'Only if your fee setting says it\'s credited to the purchase. Then it comes off the balance when they buy, so it\'s never counted twice, and their invoice shows the credit.' },
  { id: 'wl-online', section: 'waitlist', q: 'What can families do on my online list?',
    keywords: ['online', 'public', 'families', 'see', 'request', 'approve', 'status page'],
    flag: 'waitlist', when: (ctx) => ctx.online,
    a: 'They see the list as first name and last initial, with their place, the sex they want and the date their place counts from. Paused families are left out, and no total is shown. A family can pick, pass or leave on their own. Pausing, narrowing what they want or changing their answers waits for your OK. Your device keeps the list up to date.' },

  // Your data and devices
  { id: 'where-data', section: 'data', q: 'Where is my data kept?',
    keywords: ['data', 'stored', 'kept', 'where', 'saved', 'account', 'lose', 'browser'],
    href: 'import-export.html', show: 'Show me backups',
    a: (ctx) => `In this browser, on this device.${ctx.cloud ? ' There\'s no account behind it unless you turn on cloud backup.' : ''} Clearing this browser's site data erases your program, so keep a backup.` },
  { id: 'merge-replace', section: 'data', q: 'What\'s the difference between Merge and Replace?',
    keywords: ['restore', 'merge', 'replace', 'backup', 'import', 'overwrite', 'duplicate', 'twice', 'newer'],
    href: 'import-export.html', show: 'Show me backups',
    a: 'Merge adds the file\'s records to what\'s here and updates ones you already have with the file\'s newer copy. If you changed something here after the file was made, it asks whether to keep your edits or take the file\'s. Something you entered on both devices, like the same dog, becomes one record with the details from both: it\'s matched by things like a registered name, registration number or microchip, and when it\'s not sure, it asks you first. Replace wipes this device first, so it ends up exactly like the file.' },
  { id: 'cloud-device', section: 'data', q: 'Can two devices both back up to the cloud?',
    keywords: ['cloud', 'backup', 'two', 'devices', 'phone', 'computer', 'private', 'sensitive'],
    when: (ctx) => ctx.cloud, href: 'settings.html', show: 'Show me Settings',
    a: (ctx) => `One device backs up your program. Another device that tries is asked to restore that backup or replace it.${ctx.vault ? ' Private details stay on your devices unless you turn on Sensitive records, a locked copy only you can open.' : ''}` },
  { id: 'companion-link', section: 'data', q: 'Does a family\'s Companion link update?',
    keywords: ['companion', 'link', 'share', 'family', 'update', 'snapshot', 'revoke'],
    flag: 'companion', href: 'companion.html', show: 'Show me Companion',
    a: 'No, it\'s a snapshot from the day you sent it, and it can\'t be taken back. A family\'s link shows only their own pups and money; a link for someone still choosing shows the pups you have available. Documents go as links, so your sharing settings on each file decide who can open it.' },
  { id: 'device-only', section: 'data', q: 'Why is something I dismissed back on my other device?',
    keywords: ['dismissed', 'dismiss', 'other device', 'starred', 'star', 'came back', 'today'],
    a: 'Dismissing a prompt from the app only hides it on this device, and your starred Kels tasks are remembered per device too. Neither is in a backup.' }
];

const has = (edition) => (href) => !(edition === 'lite' && isProOnlyPage(String(href).split(/[?#]/)[0]));

// The entries this edition has, each with its answer worked out:
// [{ id, section, q, a, keywords, href?, show? }], in ENTRIES order. A Show me
// whose page this edition lacks is dropped (the answer stays).
export function understandEntries({ edition, flags = {}, cloud = false, vault = false, online = false }) {
  const page = has(edition);
  const ctx = { edition, flags, cloud, vault, online, page };
  return ENTRIES
    .filter((e) => (!e.flag || flags[e.flag]) && (!e.when || e.when(ctx)))
    .map((e) => ({
      id: e.id, section: e.section, q: e.q, keywords: e.keywords,
      a: typeof e.a === 'function' ? e.a(ctx) : e.a,
      ...(e.href && page(e.href) ? { href: e.href, show: e.show } : {})
    }));
}

// The sections with at least one entry, in order: [{ id, label, entries }].
// `flags`: the edition's, for a topic named differently where it lacks a feature.
const sectionLabel = (s, flags = {}) => (s.labelNoArchive && !flags.manualDogArchive ? s.labelNoArchive : s.label);

export function understandSections(entries, flags = {}) {
  return SECTIONS.map((s) => ({ id: s.id, label: sectionLabel(s, flags), entries: entries.filter((e) => e.section === s.id) })).filter((s) => s.entries.length);
}

// The entries as kelsFind candidates: the search looks at these only (decided).
// Level 1 is the question and its keywords, level 2 the answer.
export function understandCandidates(entries, flags = {}) {
  const label = new Map(SECTIONS.map((s) => [s.id, sectionLabel(s, flags)]));
  return entries.map((e) => ({
    id: `understand:${e.id}`, group: label.get(e.section), title: e.q, entry: e,
    levels: [[e.q, ...e.keywords], [e.a], []]
  }));
}
