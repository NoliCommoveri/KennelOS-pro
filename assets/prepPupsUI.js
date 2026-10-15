// prepPupsUI.js — Kels's "Pups are going home": the run-up to go-home day for
// one litter, as a chat on pages/kels.html (assets/kelsChat.js draws it).
//
// Kels asks which litter (one with pups still at home) and which pups (ticked:
// every pup whose sale is at Deposit paid or later), says where each stands, then
// raises what's missing one thing at a time (data/prepPups.js READY_ITEMS), each
// with its fix: the check-in's microchip, care and drop-off forms
// (assets/litterCheckinUI.js), a balance-due date, or the page that holds it (the
// sale, its contract, the feeding schedules). Each fix is saved when approved, so
// there's no draft. Then, in Pro, the Furever link (not tracked, so only offered)
// and the printed puppy records: one file, a cover page for her, then each pup's
// record (pages/puppy-record.html?dogs=…&cover=1).
import { dogRepo } from '../data/dogRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import { eventRepo } from '../data/eventRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { contractRepo } from '../data/contractRepo.js';
import { breedFeedingScheduleRepo } from '../data/breedFeedingScheduleRepo.js';
import { inScopeOnly } from '../data/kennelScope.js';
import { editionFlags } from '../data/editionConfig.js';
import { SALE_STATUS, REGISTRATION_TYPE, descriptor } from '../data/vocab.js';
import * as C from '../data/litterCheckin.js';
import * as P from '../data/prepPups.js';
import { chipsForm, careForm, pickupsForm, field, pupName, pupLine } from './litterCheckinUI.js';
import { esc, fmtDate, todayYMD } from './ui.js';

// A few ways she moves on, so the walk-through doesn't read like a checklist.
const NEXT = ['Next up:', 'Okay, moving on.', 'Now,', 'Alright, next one.'];
const LATER = ['No problem, we can come back to that.', 'Sure, that can wait.', 'Okay, I\'ll leave that for later.'];

const pagesPrefix = () => (location.pathname.includes('/pages/') ? '' : 'pages/');
const names = (rows) => esc(listText(rows.map((r) => pupName(r.pup))));
const listText = (xs) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

// For Kels's menu: how many litters have pups still at home.
export async function prepState() {
  const [litters, dogs, sales] = await Promise.all([
    litterRepo.getAll({ includeArchived: false }), dogRepo.getAll({ includeArchived: false }), saleRepo.getAll({ includeArchived: false })
  ]);
  return { litters: P.prepLitters(inScopeOnly(litters), dogs, sales).length };
}

// Run the task. `litterId` skips "which litter?" (when it's one she can prep).
export async function runPrepTask(chat, { litterId = null, onExit = () => {} } = {}) {
  if (!(await chat.intro('Sure thing, let\'s get those pups ready to go home!'))) return onExit('nevermind');
  return new Prep(chat, onExit).start(litterId);
}

class Prep {
  constructor(chat, onExit) {
    Object.assign(this, { chat, onExit, today: todayYMD(), asked: new Set(), pupIds: [] });
  }

  async start(litterId) {
    const [litters, dogs, sales] = await Promise.all([
      litterRepo.getAll({ includeArchived: false }), dogRepo.getAll({ includeArchived: false }), saleRepo.getAll({ includeArchived: false })
    ]);
    const all = P.prepLitters(inScopeOnly(litters), dogs, sales);
    const dogsById = new Map(dogs.map((d) => [d.id, d]));
    let litter = litterId ? all.find((l) => l.id === litterId) : null;
    if (!litter) {
      if (!all.length) {
        await this.chat.say('Hmm, I don\'t see any litters with puppies still at home right now. When one\'s getting close, come find me and we\'ll get them ready together.');
        return this.onExit('done');
      }
      if (all.length === 1) {
        litter = all[0];
        await this.chat.say(`You've got one litter with pups at home: <strong>${esc(C.litterLabel(litter, dogsById))}</strong>. Let's start there.`, { typing: 700 });
      } else {
        await this.chat.say('<strong>Which litter is getting ready to leave?</strong>', { typing: 700 });
        const id = await this.chat.choose([
          ...all.map((l) => {
            const home = C.homePups(C.rosterOf(l.id, dogs), sales).length;
            const age = C.ageText(C.ageDays(l, this.today));
            return { label: C.litterLabel(l, dogsById), sub: [C.statusLabel(l.status), age, `${C.plural(home, 'puppy', 'puppies')} at home`].filter(Boolean).join(' · '), value: l.id };
          }),
          { label: 'Never mind', value: '' }
        ], { stagger: 200 });
        if (!id) return this.onExit('nevermind');
        litter = all.find((l) => l.id === id);
        await this.chat.say(`${esc(C.litterLabel(litter, dogsById))} it is. Let's see who's heading out!`, { typing: 600 });
      }
    }
    this.litterId = litter.id;
    this.label = C.litterLabel(litter, dogsById);
    await this.load();
    if (!(await this.pickPups())) return this.onExit('nevermind');
    await this.load();
    await this.overview();
    if (await this.fixAll() === 'left') return null;
    await this.wrapUp();
    return this.onExit('done');
  }

  // --- Records ------------------------------------------------------------------

  async load() {
    const [litter, dogs, sales] = await Promise.all([
      litterRepo.getById(this.litterId), dogRepo.getAll({ includeArchived: false }), saleRepo.getAll({ includeArchived: false })
    ]);
    this.litter = litter;
    this.home = C.homePups(C.rosterOf(litter.id, dogs), sales);
    const schedules = new Map();
    if (editionFlags.feedingSchedule) {
      for (const breed of new Set(this.home.map((p) => (p.breed || '').trim()).filter(Boolean))) {
        schedules.set(breed, Boolean(await breedFeedingScheduleRepo.getByBreed(breed)));
      }
    }
    this.rows = await Promise.all(this.home.map(async (pup) => {
      const sale = P.pupSale(sales.filter((s) => s.dog_id === pup.id));
      const [events, contracts, buyer] = await Promise.all([
        eventRepo.getForSubject('dog', pup.id),
        sale && editionFlags.contracts ? contractRepo.getBySale(sale.id) : [],
        sale?.buyer_contact_id ? contactRepo.getById(sale.buyer_contact_id) : null
      ]);
      const ready = P.readiness({
        pup, sale, events, contracts, litter, today: this.today, flags: editionFlags,
        hasBreedSchedule: schedules.get((pup.breed || '').trim()) || false
      });
      return { pup, sale, contracts, buyer, ready };
    }));
    this.chosen = this.rows.filter((r) => this.pupIds.includes(r.pup.id));
  }

  async pickPups() {
    const boxes = this.rows.map((r, i) => {
      const sub = r.sale ? `${descriptor(SALE_STATUS, r.sale.status).label}${r.buyer?.name ? `, ${r.buyer.name}` : ''}` : 'No sale';
      return `<label class="ck-check"><input type="checkbox" id="pp-pup-${i}"${P.pickedByDefault(r.sale) ? ' checked' : ''}> <span>${pupLine(r.pup)}<span class="faint pp-sub">${esc(sub)}</span></span></label>`;
    }).join('');
    const res = await this.chat.form({
      title: '<strong>Which puppies are leaving?</strong><span class="kels-lead">I\'ve ticked every puppy with a deposit paid. Tick any others you want ready too.</span>',
      html: `<p class="gl-q" style="margin-top:0;">Puppies at home <button type="button" class="gl-more" data-pp="all">All</button> <button type="button" class="gl-more" data-pp="none">None</button></p>
        <div class="ck-checks pp-checks">${boxes}</div>`,
      wire: (root) => {
        root.querySelector('[data-pp="all"]').addEventListener('click', () => root.querySelectorAll('.ck-checks input').forEach((c) => { c.checked = true; }));
        root.querySelector('[data-pp="none"]').addEventListener('click', () => root.querySelectorAll('.ck-checks input').forEach((c) => { c.checked = false; }));
      },
      submitLabel: 'These ones',
      submit: async (root) => {
        const ids = this.rows.filter((r, i) => root.querySelector(`#pp-pup-${i}`).checked).map((r) => r.pup.id);
        return ids.length ? ids : 'Tick at least one puppy.';
      },
      reply: (ids) => (ids.length === this.rows.length ? (ids.length === 1 ? 'This one' : `All ${ids.length}`) : `${C.plural(ids.length, 'puppy', 'puppies')}`)
    });
    if (!res.done) return false;
    this.pupIds = res.result;
    const picked = this.rows.filter((r) => this.pupIds.includes(r.pup.id)).map((r) => pupName(r.pup));
    await this.chat.say(picked.length === 1 ? `Got it, just ${esc(picked[0])}. Give me a second to look everything over…`
      : `Got it, ${picked.length} pups. Give me a second to look everything over…`, { typing: 500 });
    return true;
  }

  // --- Where they stand ---------------------------------------------------------

  async overview() {
    const lines = this.chosen.map((r) => {
      const missing = r.ready.items.filter((i) => !i.done).map((i) => i.label.toLowerCase());
      return `<strong>${esc(pupName(r.pup))}</strong>: ${esc(P.doneText(r.ready))}${missing.length ? `, missing ${esc(listText(missing))}` : ''}.`;
    });
    await this.chat.say(`Here's where ${this.chosen.length === 1 ? 'things stand' : 'everyone stands'}:<br>${lines.join('<br>')}`, { typing: 1200 });
    const gaps = this.chosen.reduce((n, r) => n + r.ready.missing.length, 0);
    if (!gaps) return;
    await this.chat.say(gaps <= 3 ? 'You\'re nearly there, just a couple of loose ends. Let\'s go one at a time.'
      : 'You\'ve got the hard part done already. Let\'s go through the rest one at a time.', { typing: 700 });
  }

  // Each missing item in READY_ITEMS order, once per visit; the records reload after
  // every fix. Returns early when she says she's done.
  async fixAll() {
    for (;;) {
      const item = P.READY_ITEMS.find((it) => !this.asked.has(it.key) && P.missingFor(this.chosen, it.key).length);
      if (!item) return;
      this.asked.add(item.key);
      const what = await this.offer(item.key, P.missingFor(this.chosen, item.key), this.asked.size > 1);
      if (what === 'stop' || what === 'left') return what;
      if (what === 'later') await this.chat.say(LATER[this.asked.size % LATER.length], { typing: 400 });
      await this.load();
    }
  }

  async offer(key, rows, next = false) {
    const one = rows.length === 1;
    const n = names(rows);
    const ask = {
      chip: [`${n} ${one ? 'doesn\'t' : 'don\'t'} have a microchip number on file.`, 'Add chip numbers'],
      shots: [`I don't see any shots logged for ${n}.`, 'Log shots'],
      deworm: [`I don't see any deworming logged for ${n}.`, 'Log deworming'],
      pickup: [`${n} ${one ? 'has' : 'have'} no drop-off date on the calendar.`, 'Set the drop-off date'],
      balance: [`${n}'s ${one ? 'sale has' : 'sales have'} a balance with no due date.`, 'Set the due date'],
      contract: [`${n}'s ${one ? 'contract isn\'t' : 'contracts aren\'t'} signed yet.`, one ? 'Open the contract' : 'Open the first one'],
      registration: [`${n}'s ${one ? 'sale has' : 'sales have'} no registration type.`, one ? 'Open the sale' : 'Open the first one'],
      feeding: [`There's no feeding schedule for ${n}.`, 'Set one up']
    }[key];
    await this.chat.say(next ? `${NEXT[this.asked.size % NEXT.length]} ${ask[0]}` : ask[0]);
    const pick = await this.chat.choose([
      { label: ask[1], value: 'fix', primary: true },
      { label: 'Not now', value: 'later' },
      { label: 'That\'s enough for now', value: 'stop' }
    ]);
    if (pick !== 'fix') return pick;
    return this.fix(key, rows);
  }

  async fix(key, rows) {
    const pups = rows.map((r) => r.pup);
    if (key === 'chip') return this.saved(await chipsForm(this.chat, pups), (n) => (n ? `Perfect, ${n === 1 ? 'that chip is' : 'those chips are'} saved.` : 'Okay, I left them as they were.'));
    if (key === 'shots' || key === 'deworm') {
      return this.saved(await careForm(this.chat, key === 'shots' ? 'vaccination' : 'preventative', pups, this.today),
        (r) => `Done! It's on ${r.count === 1 ? 'the puppy\'s' : 'each puppy\'s'} history for ${esc(fmtDate(r.date))}.`);
    }
    if (key === 'pickup') {
      const date = P.pickupDefault(this.litter, this.today);
      return this.saved(await pickupsForm(this.chat, rows.map((r) => ({ pup: r.pup, sale: r.sale, date }))),
        (out) => `Got it! ${out.length === 1 ? 'It\'s' : 'They\'re'} on your calendar and ${out.length === 1 ? 'the puppy\'s' : 'each puppy\'s'} history.`);
    }
    if (key === 'balance') return this.balance(rows);
    if (key === 'contract') {
      const r = rows[0];
      const open = r.contracts.find((c) => !c.is_archived);
      return this.leave(open ? `contract.html?id=${encodeURIComponent(open.id)}` : `contract.html?new=1&sale=${encodeURIComponent(r.sale.id)}`,
        open ? `I'll open ${esc(pupName(r.pup))}'s contract.` : `There's no contract on ${esc(pupName(r.pup))}'s sale yet, so I'll start one.`);
    }
    if (key === 'registration') {
      return this.leave(`sale.html?id=${encodeURIComponent(rows[0].sale.id)}`,
        `I'll open ${esc(pupName(rows[0].pup))}'s sale so you can pick its registration (${esc(REGISTRATION_TYPE.map((t) => t.label).join(', '))}).`);
    }
    if (key === 'feeding') return this.feeding();
  }

  async saved(res, said) {
    if (!res.done) return null;
    await this.chat.say(said(res.result));
    return 'saved';
  }

  // Leaves Kels for the page that holds the fix. She can start Pups are going home again after.
  async leave(href, line) {
    await this.chat.say(`${line} When you're done, tap me and pick <strong>Pups are going home</strong> to carry on.`);
    await this.chat.pause(1400);
    location.href = `${pagesPrefix()}${href}`;
    return 'left';
  }

  async balance(rows) {
    const res = await this.chat.form({
      title: '<strong>When is the balance due?</strong><span class="kels-lead">Already paid? Record the payment on the sale instead. Leave a puppy blank to skip them.</span>',
      html: rows.map((r, i) => field(`${pupName(r.pup)}${r.buyer?.name ? ` (${r.buyer.name})` : ''}`, `<input id="pp-due-${i}" type="date" value="${esc(P.pickupDefault(this.litter, this.today))}">`)).join(''),
      submitLabel: 'Save',
      cancelLabel: 'Not now',
      submit: async (root) => {
        const out = rows.map((r, i) => ({ r, date: root.querySelector(`#pp-due-${i}`).value })).filter((x) => x.date);
        if (!out.length) return 'Pick a date for at least one puppy.';
        for (const x of out) await saleRepo.update(x.r.sale.id, { balance_due_date: x.date });
        return out;
      },
      reply: (out) => (out.length === 1 ? `Due ${fmtDate(out[0].date)}` : `${C.plural(out.length, 'due date')} set`)
    });
    return this.saved(res, () => 'Saved on the sale. One less thing to chase!');
  }

  async feeding() {
    await this.chat.say('A feeding schedule can be set for the breed (it covers every litter) or just for this litter.');
    const pick = await this.chat.choose([
      { label: 'For the breed', value: 'breed', primary: true },
      { label: 'Just this litter', value: 'litter' },
      { label: 'Not now', value: '' }
    ]);
    if (pick === 'breed') return this.leave('breed-feeding-schedules.html', 'I\'ll open your feeding schedules.');
    if (pick === 'litter') return this.leave(`litter.html?id=${encodeURIComponent(this.litter.id)}`, 'I\'ll open the litter\'s page. Edit it to add a feeding schedule override.');
    return null;
  }

  // --- After the fixes --------------------------------------------------------------

  async wrapUp() {
    await this.load();
    const left = this.chosen.filter((r) => r.ready.missing.length);
    if (!left.length) {
      await this.chat.say(this.chosen.length === 1 ? 'Look at that, everything on my list is done! 🎉' : `Look at that, everything on my list is done for all ${this.chosen.length}! 🎉`);
    } else {
      const lines = left.map((r) => `<strong>${esc(pupName(r.pup))}</strong>: ${esc(listText(r.ready.items.filter((i) => !i.done).map((i) => i.label.toLowerCase())))}`);
      await this.chat.say(`Nice progress! Here's what's still on the list, whenever you're ready:<br>${lines.join('<br>')}`);
    }
    // The Furever link isn't tracked, so it's only offered, for pups with an open sale.
    if (editionFlags.furever && this.chosen.some((r) => r.sale && r.sale.status !== 'delivered')) {
      await this.chat.say('One more idea: want to send the families their pup\'s Furever app? It\'s a sweet way to say welcome home.');
      const pick = await this.chat.choose([{ label: 'Open Furever', value: 'yes' }, { label: 'Not now', value: '' }]);
      if (pick === 'yes') { window.open(`${pagesPrefix()}furever.html`, '_blank'); }
    }
    if (!editionFlags.puppyRecord) { await this.goodbye(); return; }
    await this.chat.say('<strong>Last step: want me to print their puppy records?</strong> I\'ll put it all in one file, with a cover page just for you showing where each pup stands, then each pup\'s record for their family.');
    const pick = await this.chat.choose([{ label: 'Print puppy records', value: 'print', primary: true }, { label: 'Not now', value: '' }]);
    if (pick !== 'print') { await this.goodbye(); return; }
    const href = `${pagesPrefix()}puppy-record.html?dogs=${this.chosen.map((r) => encodeURIComponent(r.pup.id)).join(',')}&cover=1&autoprint=1`;
    const tab = window.open(href, '_blank');
    await this.chat.say(tab ? 'Here you go! I opened them in a new tab, ready to print.' : `Your browser blocked the new tab. <a href="${esc(href)}" target="_blank" rel="noopener">Tap here to open the puppy records</a>.`);
    await this.goodbye();
  }

  async goodbye() {
    await this.chat.say(this.chosen.length === 1 ? `You've done a lovely job getting ${esc(pupName(this.chosen[0].pup))} ready.`
      : 'You\'ve done a lovely job getting these pups ready.', { typing: 700 });
  }
}
