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
//   offered), page(href) (this edition has that page) }.
//
// Edition-honest (roadmap §2.3): an entry or a sentence about a feature the
// edition lacks isn't there. Lite's limit isn't a topic at all.
import { isProOnlyPage } from './proPages.js';

export const SECTIONS = [
  { id: 'dogs', label: 'Dogs and puppies' },
  { id: 'removing', label: 'Archiving and deleting' },
  { id: 'breeding', label: 'Breedings and litters' },
  { id: 'money', label: 'Money' },
  { id: 'waitlist', label: 'The waitlist' },
  { id: 'data', label: 'Your data and devices' }
];

const tail = (cond, text) => (cond ? ` ${text}` : '');

export const ENTRIES = [
  // Dogs and puppies
  { id: 'keeping-puppy', section: 'dogs', q: 'I\'m keeping a puppy. Why is it still a puppy?',
    keywords: ['keep', 'keeping', 'kept', 'promote', 'grown', 'adult', 'breeding', 'status', 'plan', 'disposition'],
    href: 'dogs.html?bucket=puppies', show: 'Show me my puppies',
    a: (ctx) => 'Keeping is your plan for the pup, not its stage of life. It stays a Puppy until you change its status to Active breeding (or another adult status) on its page, and the app never does that for you.'
      + tail(ctx.page('kennel.html'), 'Your kennel\'s page can remind you on Today when a kept pup reaches an age you pick, one age for boys and one for girls.') },
  { id: 'unfinished-litter', section: 'dogs', q: 'Why does a litter still look unfinished?',
    keywords: ['litter', 'open', 'active', 'close', 'closed', 'finished', 'done', 'today', 'undecided', 'available', 'plan'],
    href: 'litters.html', show: 'Show me my litters',
    a: 'It\'s the pups\' plans. A pup marked Available keeps its litter under Active litters on Today. A pup marked Undecided, or never given a plan, stops me from suggesting you close the litter. Keeping, Health hold and Placed all settle a pup, so a pup you\'re holding back won\'t keep its litter open.' },
  { id: 'health-hold', section: 'dogs', q: 'What does Health hold do?',
    keywords: ['health', 'hold', 'sick', 'not for sale', 'returned', 'plan', 'disposition'],
    a: (ctx) => `Health hold marks a pup you can't sell right now for a health reason. It doesn't count as available${ctx.flags.waitlist ? ', and the waitlist never offers it,' : ''} until you change it. When a sale is returned or falls through for a health reason, the app suggests it.` },
  { id: 'owner-needed', section: 'dogs', q: 'Which dogs need an owner?',
    keywords: ['owner', 'external', 'outside', 'someone else', 'leased', 'lease', 'pedigree', 'ancestor', 'stud'],
    flag: 'externalOwnership', href: 'dogs.html?bucket=external', show: 'Show me other people\'s dogs',
    a: 'Any dog that lives outside your care but that you still deal with needs its owner linked as a contact: a stud you used, a dog leased to you, a pup you sold. A dog that\'s only there to fill in a pedigree (an ancestor) doesn\'t need one, and isn\'t counted as one of your dogs.' },
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
    a: 'Each litter, sale, breeding and contract belongs to the kennel you were in when you made it, and lists and reports show only the kennel you\'re viewing. Switch kennels to see it. Dogs that belong to someone else show under every kennel.' },

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
    href: 'financials.html', show: 'Show me Financials',
    a: (ctx) => `Archiving a sale or an expense takes its money out of Financials${ctx.flags.reports ? ' and reports' : ''}. Only archive one that was entered by mistake. A sale that fell through should be ended with a status instead (Cancelled, Voided or Returned), so its money counts the right way.` },
  { id: 'cant-delete', section: 'removing', q: 'Why can\'t I delete something?',
    keywords: ['delete', 'remove', 'blocked', 'cant', 'mistake', 'erase'],
    a: 'Delete is only for undoing a mistake, so it\'s refused while anything else points at the record. The message says what\'s in the way, like 3 events or a sale.' },
  { id: 'deceased', section: 'removing', q: 'How do I record a dog that died?',
    keywords: ['died', 'death', 'dead', 'deceased', 'passed', 'lost', 'rainbow bridge'],
    a: (ctx) => `Change its status to Deceased and enter the date, rather than archiving it. Today then asks about anything still open for it, like a sale or a planned breeding. For a puppy, it also offers to ${ctx.flags.manualDogArchive ? 'archive it' : 'remove it from your program'}.` },

  // Breedings and litters
  { id: 'pairing-litter', section: 'breeding', q: 'Do I record the breeding or the litter?',
    keywords: ['pairing', 'breeding', 'bred', 'mating', 'litter', 'expected', 'pregnant', 'due'],
    href: 'breeding.html', show: 'Show me Breeding',
    a: 'Both, as two records. The breeding (a pairing) comes first, with its dates. The litter is its own record, Expected until the pups are born. Today reminds you when one moves along and the other hasn\'t.' },
  { id: 'our-stud', section: 'breeding', q: 'My stud bred someone else\'s female. Do I record the litter?',
    keywords: ['stud', 'outside', 'someone else', 'litter', 'pick', 'pick puppy', 'stud service'],
    flag: 'studServices', href: 'stud-services.html', show: 'Show me stud services',
    a: 'No, that litter is hers. You record the stud service, and the app won\'t ask you for the litter. If your fee includes a pick puppy, Today asks about the pick once the pups would be old enough to go.' },
  { id: 'litter-logging', section: 'breeding', q: 'I logged something for the whole litter. Why is it on each pup?',
    keywords: ['litter', 'whole', 'all', 'pups', 'log', 'event', 'weight', 'shots', 'deworm', 'each'],
    a: 'Logging for the litter saves one entry on each pup you tick, so every pup has its own history. To fix it for one pup, change it on that pup\'s page.' },
  { id: 'go-home-day', section: 'breeding', q: 'Where do I put the day a pup goes home?',
    keywords: ['go home', 'going home', 'pickup', 'pick up', 'drop off', 'dropoff', 'date', 'placement', 'boarding'],
    href: 'scheduled-placements.html', show: 'Show me scheduled drop-offs',
    a: 'It\'s a Placement / drop-off entry in the pup\'s history, not a date on the sale. Today and Pups are going home look for it. A pup staying with you past its ready date needs a Boarding entry too.' },

  // Money
  { id: 'add-income', section: 'money', q: 'How do I add income?',
    keywords: ['income', 'add', 'enter', 'money', 'earnings', 'revenue', 'payment', 'ledger'],
    href: 'financials.html?view=income', show: 'Show me my income',
    a: (ctx) => {
      const from = ['your sales', ctx.flags.studServices && 'stud fees you earned', ctx.flags.waitlist && 'waitlist fees'].filter(Boolean);
      return `You don't type it in. Income comes from ${from.length > 2 ? `${from.slice(0, -1).join(', ')} and ${from.at(-1)}` : from.join(' and ')}. To change an income line, edit the ${ctx.flags.studServices ? 'sale or stud service' : 'sale'} it comes from.`;
    } },
  { id: 'earned', section: 'money', q: 'When does a payment count as earned?',
    keywords: ['earned', 'anticipated', 'expected', 'paid', 'counted', 'net', 'deposit', 'balance'],
    href: 'financials.html?view=income', show: 'Show me my income',
    a: 'When its paid date is entered, or when the sale\'s status has moved past it: Deposit paid counts the deposit, and Paid in full or Delivered count the rest, transport and boarding included. Until then it\'s expected, and expected money is never in your Net.' },
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
    a: 'Pups that aren\'t kept, placed or on Health hold, and that have no sale. Any open sale takes a pup off the market, even one still waiting on its deposit.' },
  { id: 'wl-turns', section: 'waitlist', q: 'How do turns and passes work?',
    keywords: ['turn', 'pass', 'passes', 'not this litter', 'skip', 'removed', 'limit'],
    flag: 'waitlist',
    a: 'One family holds a turn at a time, and their turn covers every open litter they match. Passing ends the whole turn and counts as one pass. "Not this litter" skips one litter without using a pass. At the pass limit (2 unless you change it) the family is removed, and you have 7 days to undo it.' },
  { id: 'wl-pause', section: 'waitlist', q: 'Does pausing cost a family their place?',
    keywords: ['pause', 'paused', 'listen', 'only', 'parents', 'place', 'hold', 'ready'],
    flag: 'waitlist',
    a: 'No. A paused family keeps their place and is just skipped until they\'re back. Listening only for certain parents works the same way.' },
  { id: 'wl-auto', section: 'waitlist', q: 'Do offers go out or expire by themselves?',
    keywords: ['automatic', 'auto', 'expire', 'expired', 'overdue', 'offer', 'deadline', 'no response'],
    flag: 'waitlist',
    a: 'Not unless you turn automatic offers on in your waitlist settings. Otherwise you make each offer, and an offer or fee that runs past its time shows up on Today for you to decide.' },
  { id: 'wl-pick', section: 'waitlist', q: 'When is a family\'s pick final?',
    keywords: ['pick', 'picked', 'deposit', 'accept', 'final', 'placed', 'reserved'],
    flag: 'waitlist',
    a: 'When the deposit is in. A pick makes a sale waiting on its deposit, and the pup is off the market while it waits. Confirming the deposit places the pup and the family.' },
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
    flag: 'waitlist', when: (ctx) => ctx.cloud,
    a: 'They see the list as first name and last initial, with their place and the sex they want. Paused families are left out, and no total is shown. A family can pick, pass or leave on their own. Pausing, narrowing what they want or changing their answers waits for your OK. Your device keeps the list up to date.' },

  // Your data and devices
  { id: 'where-data', section: 'data', q: 'Where is my data kept?',
    keywords: ['data', 'stored', 'kept', 'where', 'saved', 'account', 'lose', 'browser'],
    href: 'import-export.html', show: 'Show me backups',
    a: (ctx) => `In this browser, on this device.${ctx.cloud ? ' There\'s no account behind it unless you turn on cloud backup.' : ''} Clearing this browser's site data erases your program, so keep a backup.` },
  { id: 'merge-replace', section: 'data', q: 'What\'s the difference between Merge and Replace?',
    keywords: ['restore', 'merge', 'replace', 'backup', 'import', 'overwrite'],
    href: 'import-export.html', show: 'Show me backups',
    a: 'Merge adds the file\'s records to what\'s here, updating ones you already have. Replace wipes this device first, so it ends up exactly like the file.' },
  { id: 'cloud-device', section: 'data', q: 'Can two devices both back up to the cloud?',
    keywords: ['cloud', 'backup', 'two', 'devices', 'phone', 'computer', 'private', 'sensitive'],
    when: (ctx) => ctx.cloud, href: 'settings.html', show: 'Show me Settings',
    a: (ctx) => `One device backs up your program. Another device that tries is asked to restore that backup or replace it.${ctx.vault ? ' Private details stay on your devices unless you turn on Sensitive records, a locked copy only you can open.' : ''}` },
  { id: 'companion-link', section: 'data', q: 'Does a family\'s Companion link update?',
    keywords: ['companion', 'link', 'share', 'family', 'update', 'snapshot', 'revoke'],
    flag: 'companion', href: 'companion.html', show: 'Show me Companion',
    a: 'No, it\'s a snapshot from the day you sent it, and it can\'t be taken back. It shows only that family\'s own pups and money. Documents go as links, so your sharing settings on each file decide who can open it.' },
  { id: 'device-only', section: 'data', q: 'Why is something I dismissed back on my other device?',
    keywords: ['dismissed', 'dismiss', 'other device', 'starred', 'star', 'came back', 'today'],
    a: 'Dismissing a Today suggestion only hides it on this device, and your starred Kels tasks are remembered per device too. Neither is in a backup.' }
];

const has = (edition) => (href) => !(edition === 'lite' && isProOnlyPage(String(href).split(/[?#]/)[0]));

// The entries this edition has, each with its answer worked out:
// [{ id, section, q, a, keywords, href?, show? }], in ENTRIES order. A Show me
// whose page this edition lacks is dropped (the answer stays).
export function understandEntries({ edition, flags = {}, cloud = false, vault = false }) {
  const page = has(edition);
  const ctx = { edition, flags, cloud, vault, page };
  return ENTRIES
    .filter((e) => (!e.flag || flags[e.flag]) && (!e.when || e.when(ctx)))
    .map((e) => ({
      id: e.id, section: e.section, q: e.q, keywords: e.keywords,
      a: typeof e.a === 'function' ? e.a(ctx) : e.a,
      ...(e.href && page(e.href) ? { href: e.href, show: e.show } : {})
    }));
}

// The sections with at least one entry, in order: [{ id, label, entries }].
export function understandSections(entries) {
  return SECTIONS.map((s) => ({ ...s, entries: entries.filter((e) => e.section === s.id) })).filter((s) => s.entries.length);
}

// The entries as kelsFind candidates: the search looks at these only (decided).
// Level 1 is the question and its keywords, level 2 the answer.
export function understandCandidates(entries) {
  const label = new Map(SECTIONS.map((s) => [s.id, s.label]));
  return entries.map((e) => ({
    id: `understand:${e.id}`, group: label.get(e.section), title: e.q, entry: e,
    levels: [[e.q, ...e.keywords], [e.a], []]
  }));
}
