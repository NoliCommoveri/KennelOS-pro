// prepPupsUI.js — Kels's "Pups are going home": the run-up to go-home day for
// one litter, as a chat on pages/kels.html (assets/kelsChat.js draws it).
//
// Kels asks which litter (one with pups still at home), which pups (ticked: every
// pup whose sale is at Deposit paid or later), and which optional checks she wants
// (microchips, the litter's registration number, each pup's registered name and
// number, a feeding schedule): unticked the first time, then as she left them on
// this device (settings.prepChecks).
// Then pups marked Available or Placed with no sale (prepPups.planWithoutSale):
// record the sale or change the plan, in the chat. Then where each stands, and
// what's missing one thing at a time (data/prepPups.js READY_ITEMS), each with its
// fix, done in the chat wherever it can be: the check-in's microchip, care and
// drop-off forms (assets/litterCheckinUI.js), the litter's registration number, a
// balance-due date, each contract's status, the registration type, the litter's
// feeding note. Only the breed feeding schedule (a table editor) leaves for its
// page. Unpaid balances then get a payment request, then an invoice (Pro). Each fix is saved
// when approved, so there's no draft. Then, in Pro, the Furever link (not tracked,
// so only offered) and the printed puppy records: one file, a cover page for her,
// then each pup's record (pages/puppy-record.html?dogs=…&cover=1). Anything that
// opens a new tab is announced first and waits for her OK.
import { dogRepo } from '../data/dogRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import { eventRepo } from '../data/eventRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { contractRepo } from '../data/contractRepo.js';
import { breedFeedingScheduleRepo } from '../data/breedFeedingScheduleRepo.js';
import { accountRepo } from '../data/accountRepo.js';
import { inScopeOnly, resolveKennelIdForWrite } from '../data/kennelScope.js';
import { priceForRegistrationChange } from '../data/saleDefaults.js';
import { saleFeeEstimate } from '../data/processingFees.js';
import { paymentAccounts } from '../data/paymentLinks.js';
import { stripeConnection } from '../data/stripeLinks.js';
import { editionFlags } from '../data/editionConfig.js';
import { getPrepChecks, setPrepChecks } from '../data/settings.js';
import { SALE_STATUS, REGISTRATION_TYPE, CONTRACT_STATUS, DISPOSITION, descriptor } from '../data/vocab.js';
import { expectedPricing } from '../data/saleDefaults.js';
import { balanceDueOn } from '../data/contractSend.js';
import * as C from '../data/litterCheckin.js';
import * as P from '../data/prepPups.js';
import { chipsForm, careForm, pickupsForm, field, pupName, pupLine } from './litterCheckinUI.js';
import { esc, fmtDate, fmtMoney, todayYMD } from './ui.js';

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
    Object.assign(this, { chat, onExit, today: todayYMD(), asked: new Set(), pupIds: [], checks: [] });
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
    if (!(await this.pickChecks())) return this.onExit('nevermind');
    await this.load();
    await this.unsold();
    await this.load();
    await this.overview();
    if (await this.fixAll() === 'left') return null;
    await this.balances();
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
        pup, sale, events, contracts, litter, today: this.today, flags: editionFlags, checks: this.checks,
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

  // The optional checks: unticked the first time (many breeders don't track them),
  // then ticked as she left them on this device.
  async pickChecks() {
    const opts = P.optionalItems(editionFlags);
    if (!opts.length) return true;
    const last = getPrepChecks() || [];
    const res = await this.chat.form({
      title: '<strong>Want me to check any of these too?</strong><span class="kels-lead">Tick the ones you keep track of. I\'ll always check shots, deworming, the drop-off, the balance and the paperwork.</span>',
      html: `<div class="ck-checks">${opts.map((it) => `<label class="ck-check"><input type="checkbox" id="pp-opt-${esc(it.key)}"${last.includes(it.key) ? ' checked' : ''}> <span>${esc(it.ask)}</span></label>`).join('')}</div>`,
      submitLabel: 'Continue',
      submit: async (root) => setPrepChecks(opts.filter((it) => root.querySelector(`#pp-opt-${it.key}`).checked).map((it) => it.key)),
      reply: (keys) => (keys.length ? listText(opts.filter((it) => keys.includes(it.key)).map((it) => it.ask.toLowerCase())) : 'Just the usual')
    });
    if (!res.done) return false;
    this.checks = res.result;
    return true;
  }

  // Pups marked Available or Placed with no sale going ahead (any pup at home,
  // chosen or not): record the sale, or change the plan.
  async unsold() {
    const rows = P.planWithoutSale(this.rows);
    if (!rows.length) return;
    const lines = rows.map((r) => `<strong>${esc(pupName(r.pup))}</strong>: ${esc(descriptor(DISPOSITION, r.pup.disposition).label)}, no sale`);
    await this.chat.say(`Before we start, ${rows.length === 1 ? 'one puppy doesn\'t' : 'a few puppies don\'t'} have a sale to match ${rows.length === 1 ? 'its' : 'their'} plan:<br>${lines.join('<br>')}`, { typing: 800 });
    const pick = await this.chat.choose([
      { label: rows.length === 1 ? 'Record the sale' : 'Record sales', value: 'sale', primary: true },
      { label: rows.length === 1 ? 'Change the plan' : 'Change their plans', value: 'plan' },
      { label: 'Not now', value: '' }
    ]);
    if (pick === 'plan') return this.changePlans(rows);
    if (pick !== 'sale') return;
    let left = rows;
    if (rows.length > 1) {
      const res = await this.chat.form({
        title: '<strong>Which ones have a family?</strong>',
        html: `<div class="ck-checks">${rows.map((r, i) => `<label class="ck-check"><input type="checkbox" id="pp-us-${i}" checked> <span>${pupLine(r.pup)}</span></label>`).join('')}</div>`,
        submitLabel: 'These ones',
        cancelLabel: 'Not now',
        submit: async (root) => {
          const out = rows.filter((r, i) => root.querySelector(`#pp-us-${i}`).checked);
          return out.length ? out : 'Tick at least one puppy.';
        },
        reply: (out) => C.plural(out.length, 'puppy', 'puppies')
      });
      if (!res.done) return;
      left = res.result;
    }
    for (const r of left) {
      const sale = await this.recordSale(r.pup);
      if (sale && !this.pupIds.includes(r.pup.id)) this.pupIds.push(r.pup.id);
    }
    const rest = rows.filter((r) => !left.includes(r) && r.pup.disposition === 'placed');
    if (rest.length) {
      await this.chat.say(`${names(rest)} ${rest.length === 1 ? 'is' : 'are'} still marked Placed with no sale. Change ${rest.length === 1 ? 'that plan' : 'their plans'}?`);
      if ((await this.chat.choose([{ label: 'Change the plan', value: 'plan', primary: true }, { label: 'Not now', value: '' }])) === 'plan') await this.changePlans(rest);
    }
  }

  async changePlans(rows) {
    const choices = DISPOSITION.filter((d) => d.value !== 'placed');
    const res = await this.chat.form({
      title: '<strong>What\'s the plan for each puppy?</strong><span class="kels-lead">Placed comes from a sale, so it isn\'t here.</span>',
      html: rows.map((r, i) => `<div class="gl-plan-row"><span>${pupLine(r.pup)}</span>
        <select id="pp-plan-${i}" aria-label="${esc(pupName(r.pup))}: plan">${choices.map((d) => `<option value="${esc(d.value)}"${d.value === (r.pup.disposition === 'placed' ? 'keeping' : r.pup.disposition) ? ' selected' : ''}>${esc(d.label)}</option>`).join('')}</select></div>`).join(''),
      submitLabel: 'Save plans',
      cancelLabel: 'Not now',
      submit: async (root) => {
        let n = 0;
        for (const [i, r] of rows.entries()) {
          const v = root.querySelector(`#pp-plan-${i}`).value;
          if (v === r.pup.disposition) continue;
          await dogRepo.update(r.pup.id, { disposition: v });
          n++;
        }
        return n;
      },
      reply: (n) => (n ? `Update ${C.plural(n, 'puppy', 'puppies')}` : 'Keep them as they are')
    });
    if (res.done) await this.chat.say(res.result ? 'Done, their plans are updated.' : 'Okay, nothing changed.');
  }

  // One pup's sale, in the chat: the family (one she has, or a new one), how far
  // along it is, the registration, and the price and deposit (prefilled from the
  // litter as the Sale page does). The pup becomes Placed, as a new sale offers.
  async recordSale(pup) {
    const contacts = (await contactRepo.getAll()).filter((c) => !c.is_archived)
      .sort((a, b) => ((b.contact_type || []).includes('buyer') - (a.contact_type || []).includes('buyer')) || (a.name || '').localeCompare(b.name || ''));
    const reg0 = pup.intended_registration || 'limited';
    const price0 = expectedPricing(pup, this.litter, reg0);
    const statuses = SALE_STATUS.filter((t) => ['deposit_pending', 'deposit_paid', 'paid_in_full'].includes(t.value));
    const html = `
      ${field('Family', `<select id="pp-s-buyer"><option value="new">A new family…</option>${contacts.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select>`)}
      <div id="pp-s-new">
        ${field('Their name', '<input id="pp-s-name" type="text" autocomplete="off">')}
        ${field('Email', '<input id="pp-s-email" type="email" autocomplete="off">')}
        ${field('Phone', '<input id="pp-s-phone" type="tel" autocomplete="off">')}
      </div>
      ${field('Where is it at?', `<select id="pp-s-status">${statuses.map((t) => `<option value="${esc(t.value)}"${t.value === 'deposit_paid' ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}</select>`)}
      ${field('Paid on', `<input id="pp-s-paid" type="date" value="${esc(this.today)}">`, 'When the deposit (or the whole price) came in.')}
      ${field('Registration', `<select id="pp-s-reg">${REGISTRATION_TYPE.map((t) => `<option value="${esc(t.value)}"${t.value === reg0 ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}</select>`)}
      ${field('Price', `<input id="pp-s-price" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(price0.price ?? '')}">`)}
      ${field('Deposit', `<input id="pp-s-deposit" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(price0.deposit_amount ?? '')}">`)}`;
    const res = await this.chat.form({
      title: `<strong>Who is ${esc(pupName(pup))} going home with?</strong>`,
      html,
      wire: (root) => {
        const buyer = root.querySelector('#pp-s-buyer');
        const status = root.querySelector('#pp-s-status');
        const reg = root.querySelector('#pp-s-reg');
        const price = root.querySelector('#pp-s-price');
        const paid = root.querySelector('#pp-s-paid').closest('.field');
        let suggested = String(price0.price ?? '');
        const show = () => {
          root.querySelector('#pp-s-new').style.display = buyer.value === 'new' ? '' : 'none';
          paid.style.display = status.value === 'deposit_pending' ? 'none' : '';
        };
        buyer.addEventListener('change', show);
        status.addEventListener('change', show);
        // The price follows the registration (the Full surcharge) until she types her own.
        reg.addEventListener('change', () => {
          const next = String(expectedPricing(pup, this.litter, reg.value).price ?? '');
          if (price.value === suggested) price.value = next;
          suggested = next;
        });
        show();
      },
      submitLabel: 'Save the sale',
      cancelLabel: 'Skip',
      submit: async (root) => {
        const v = (id) => root.querySelector(id).value.trim();
        let buyerId = v('#pp-s-buyer');
        if (buyerId === 'new' && !v('#pp-s-name')) return 'Type the family\'s name, or pick one you have.';
        const status = v('#pp-s-status');
        const paidOn = status === 'deposit_pending' ? '' : v('#pp-s-paid');
        if (status !== 'deposit_pending' && !paidOn) return 'Pick the date it was paid.';
        const num = (x) => (x === '' ? null : Number(x));
        if (buyerId === 'new') {
          buyerId = (await contactRepo.create({ name: v('#pp-s-name'), email: v('#pp-s-email') || null, phone: v('#pp-s-phone') || null, contact_type: ['buyer'] })).id;
        }
        const sale = await saleRepo.create({
          dog_id: pup.id, buyer_contact_id: buyerId, registration_type: v('#pp-s-reg'), status,
          kennel_id: pup.kennel_id || this.litter.kennel_id, sale_date: this.today,
          price: num(v('#pp-s-price')), deposit_amount: num(v('#pp-s-deposit')),
          ...(paidOn ? { deposit_date: paidOn } : {}),
          ...(status === 'paid_in_full' ? { balance_paid_date: paidOn } : {})
        });
        await dogRepo.update(pup.id, { disposition: 'placed' });
        return { sale };
      },
      reply: (out) => `${descriptor(SALE_STATUS, out.sale.status).label}${out.sale.price != null ? `, ${fmtMoney(out.sale.price)}` : ''}`
    });
    if (!res.done) return null;
    await this.chat.say(`Saved! ${esc(pupName(pup))} is marked Placed, and I'll get ${esc(pupName(pup))} ready with the rest.`);
    return res.result.sale;
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
      litter_reg: ['The litter doesn\'t have its registration number on file yet.', 'Add it'],
      pup_reg: [`${n} ${one ? 'isn\'t' : 'aren\'t'} fully registered on file yet (registered name and number).`, one ? 'Add them' : 'Add them now'],
      shots: [`I don't see any shots logged for ${n}.`, 'Log shots'],
      deworm: [`I don't see any deworming logged for ${n}.`, 'Log deworming'],
      pickup: [`${n} ${one ? 'has' : 'have'} no drop-off date on the calendar.`, 'Set the drop-off date'],
      balance: [`${n}'s ${one ? 'sale has' : 'sales have'} a balance with no due date.`, 'Set the due date'],
      contract: [`${n}'s ${one ? 'contract isn\'t' : 'contracts aren\'t'} signed yet.`, one ? 'Update the contract' : 'Update the contracts'],
      registration: [`${n}'s ${one ? 'sale has' : 'sales have'} no registration type.`, 'Pick the registration'],
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
    if (key === 'litter_reg') return this.litterReg();
    if (key === 'pup_reg') return this.pupReg(pups);
    if (key === 'contract') return this.contracts(rows);
    if (key === 'registration') return this.registration(rows);
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

  // Each pup's sale contract: its status (and the signed date), saved on the
  // contract, or a new sale contract when there's none. Sending one for e-signature
  // stays on the contract page.
  async contracts(rows) {
    const opts = (cur, none) => [none ? `<option value="">${none}</option>` : '']
      .concat(CONTRACT_STATUS.map((t) => `<option value="${esc(t.value)}"${t.value === cur ? ' selected' : ''}>${esc(t.label)}</option>`)).join('');
    const html = rows.map((r, i) => {
      const c = r.contracts.find((x) => !x.is_archived);
      return `<div class="pp-contract">
        ${field(`${pupName(r.pup)}${r.buyer?.name ? ` (${r.buyer.name})` : ''}`, `<select id="pp-ct-${i}">${opts(c ? c.status || 'draft' : '', c ? '' : 'No contract yet')}</select>`, c ? '' : 'Pick a status and I\'ll add the contract to the sale.')}
        ${field('Signed on', `<input id="pp-ct-date-${i}" type="date" value="${esc(c?.signed_date || this.today)}">`)}
      </div>`;
    }).join('');
    const res = await this.chat.form({
      title: '<strong>Where are the contracts at?</strong><span class="kels-lead">Signed one on paper or by email? Mark it Signed with the date.</span>',
      html,
      wire: (root) => rows.forEach((r, i) => {
        const sel = root.querySelector(`#pp-ct-${i}`);
        const date = root.querySelector(`#pp-ct-date-${i}`).closest('.field');
        const show = () => { date.style.display = sel.value === 'signed' ? '' : 'none'; };
        sel.addEventListener('change', show);
        show();
      }),
      submitLabel: 'Save',
      cancelLabel: 'Not now',
      submit: async (root) => {
        const out = [];
        for (const [i, r] of rows.entries()) {
          const status = root.querySelector(`#pp-ct-${i}`).value;
          const signed_date = status === 'signed' ? root.querySelector(`#pp-ct-date-${i}`).value : '';
          if (status === 'signed' && !signed_date) return `Pick the date ${pupName(r.pup)}'s contract was signed.`;
          const c = r.contracts.find((x) => !x.is_archived);
          const changes = { status, ...(signed_date ? { signed_date } : {}) };
          if (c) {
            if (c.status === status && (!signed_date || c.signed_date === signed_date)) continue;
            await contractRepo.update(c.id, changes);
          } else if (status) {
            await contractRepo.create({
              contract_type: 'sale', related_sale_id: r.sale.id, title: `${pupName(r.pup)} sale contract`, ...changes,
              kennel_id: await resolveKennelIdForWrite({ inheritFrom: [r.sale] })
            });
          } else continue;
          out.push({ r, status });
        }
        return out;
      },
      reply: (out) => (!out.length ? 'No changes' : out.every((x) => x.status === 'signed') ? `${C.plural(out.length, 'contract')} signed` : `${C.plural(out.length, 'contract')} updated`)
    });
    return this.saved(res, (out) => (out.length ? 'Saved on the sale. To send one for e-signature, open it from the sale.' : 'Okay, I left them as they were.'));
  }

  // Each sale's registration type. Where the litter prices Full differently, she
  // says how the price would change and asks first, as the Sale page does; a fee
  // she didn't type follows the price. A Co-own placement offers to add the
  // family as a co-owner of the pup.
  async registration(rows) {
    const opts = (cur) => [`<option value="">Pick…</option>`]
      .concat(REGISTRATION_TYPE.map((t) => `<option value="${esc(t.value)}"${t.value === cur ? ' selected' : ''}>${esc(t.label)}</option>`)).join('');
    const res = await this.chat.form({
      title: '<strong>How is each puppy registered?</strong><span class="kels-lead">Leave one on Pick… to skip it.</span>',
      html: rows.map((r, i) => field(`${pupName(r.pup)}${r.buyer?.name ? ` (${r.buyer.name})` : ''}`, `<select id="pp-reg-${i}">${opts(r.pup.intended_registration || '')}</select>`)).join(''),
      submitLabel: 'Save',
      cancelLabel: 'Not now',
      submit: async (root) => {
        const out = rows.map((r, i) => ({ r, reg: root.querySelector(`#pp-reg-${i}`).value })).filter((x) => x.reg);
        if (!out.length) return 'Pick a registration for at least one puppy.';
        for (const x of out) await saleRepo.update(x.r.sale.id, { registration_type: x.reg });
        return out;
      },
      reply: (out) => (out.length === 1 ? descriptor(REGISTRATION_TYPE, out[0].reg).label : `${C.plural(out.length, 'registration')} set`)
    });
    if (!res.done) return null;
    await this.chat.say('Saved on the sale.');
    const accounts = new Map((await accountRepo.getAll()).map((a) => [a.id, a]));
    for (const { r, reg } of res.result) {
      const change = priceForRegistrationChange(r.pup, this.litter, r.sale.price, r.sale.registration_type || '', reg);
      if (change && change.from != null && change.to !== change.from) {
        await this.chat.say(`${esc(descriptor(REGISTRATION_TYPE, reg).label)} ${change.delta > 0 ? 'adds' : 'takes off'} ${esc(fmtMoney(Math.abs(change.delta)))} for this litter. Change ${esc(pupName(r.pup))}'s price from ${esc(fmtMoney(change.from))} to ${esc(fmtMoney(change.to))}?`);
        const pick = await this.chat.choose([{ label: `Make it ${fmtMoney(change.to)}`, value: 'yes', primary: true }, { label: `Keep ${fmtMoney(change.from)}`, value: '' }]);
        if (pick === 'yes') {
          const sale = await saleRepo.getById(r.sale.id);
          const fee = sale.processing_fee_amount === '' || sale.processing_fee_amount == null ? null : Number(sale.processing_fee_amount);
          const auto = fee == null || fee === (saleFeeEstimate(sale, accounts)?.total ?? null);
          const next = { ...sale, price: change.to };
          const est = saleFeeEstimate(next, accounts)?.total ?? null;
          await saleRepo.update(sale.id, { price: change.to, ...(auto && fee != null ? { processing_fee_amount: est ?? '' } : {}) });
          await this.chat.say('Price updated.');
        }
      }
      if (reg === 'co_own' && r.sale.buyer_contact_id && !(r.pup.co_owner_contact_ids || []).includes(r.sale.buyer_contact_id)) {
        await this.chat.say(`${esc(pupName(r.pup))} is a co-own placement. Add ${esc(r.buyer?.name || 'the family')} as a co-owner of ${esc(pupName(r.pup))} too?`);
        if ((await this.chat.choose([{ label: 'Add them', value: 'yes', primary: true }, { label: 'Skip', value: '' }])) === 'yes') {
          await dogRepo.update(r.pup.id, { co_owner_contact_ids: [...(r.pup.co_owner_contact_ids || []), r.sale.buyer_contact_id] });
          await this.chat.say('Done, they\'re a co-owner now.');
        }
      }
    }
    return 'saved';
  }

  // The litter's own feeding note (feeding_schedule_override), typed in the chat.
  async feedingNote() {
    const res = await this.chat.form({
      title: '<strong>What should these families feed?</strong><span class="kels-lead">It goes in every pup\'s Furever app for this litter, ahead of your breed schedule.</span>',
      html: field('Feeding schedule for this litter', `<textarea id="pp-feed" rows="4" placeholder="e.g. Purina Pro Plan Puppy, 1/2 cup three times a day until 12 weeks">${esc(this.litter.feeding_schedule_override || '')}</textarea>`),
      submitLabel: 'Save',
      cancelLabel: 'Not now',
      submit: async (root) => {
        const text = root.querySelector('#pp-feed').value.trim();
        if (!text) return 'Type the feeding schedule, or tap Not now.';
        await litterRepo.update(this.litter.id, { feeding_schedule_override: text });
        return { text }; // a string would show as a problem
      },
      reply: () => 'Saved'
    });
    return this.saved(res, () => 'Saved on the litter. Every pup\'s Furever app will show it.');
  }

  // The litter's registration number (AKC and the like), one for every pup.
  async litterReg() {
    const res = await this.chat.form({
      title: '<strong>What\'s the litter\'s registration number?</strong><span class="kels-lead">The one the registry gave the litter (AKC, UKC…).</span>',
      html: field('Litter registration number', `<input id="pp-lreg" type="text" autocomplete="off" value="${esc(this.litter.litter_registration_number || '')}">`),
      submitLabel: 'Save',
      cancelLabel: 'Not now',
      submit: async (root) => {
        const n = root.querySelector('#pp-lreg').value.trim();
        if (!n) return 'Type the number, or tap Not now.';
        await litterRepo.update(this.litter.id, { litter_registration_number: n });
        return { n }; // a string would show as a problem
      },
      reply: (out) => out.n
    });
    return this.saved(res, () => 'Saved on the litter, so it\'s there for every pup\'s papers.');
  }

  // Each pup's registered name and registration number, for breeders who register
  // pups before they go. A blank stays as it was.
  async pupReg(pups) {
    const res = await this.chat.form({
      title: '<strong>What are their registered names and numbers?</strong><span class="kels-lead">Leave anything you don\'t have yet blank.</span>',
      html: pups.map((p, i) => `<p class="gl-q">${pupLine(p)}</p>
        ${field('Registered name', `<input id="pp-rn-${i}" type="text" autocomplete="off" value="${esc(p.registered_name || '')}">`)}
        ${field('Registration number', `<input id="pp-rnum-${i}" type="text" autocomplete="off" value="${esc(p.registration_number || '')}">`)}`).join(''),
      submitLabel: 'Save',
      cancelLabel: 'Not now',
      submit: async (root) => {
        let n = 0;
        for (const [i, p] of pups.entries()) {
          const name = root.querySelector(`#pp-rn-${i}`).value.trim();
          const num = root.querySelector(`#pp-rnum-${i}`).value.trim();
          const changes = {
            ...(name && name !== (p.registered_name || '') ? { registered_name: name } : {}),
            ...(num && num !== (p.registration_number || '') ? { registration_number: num } : {})
          };
          if (!Object.keys(changes).length) continue;
          await dogRepo.update(p.id, changes);
          n++;
        }
        return { n }; // a number of 0 is fine; a string would show as a problem
      },
      reply: (out) => (out.n ? `${C.plural(out.n, 'puppy', 'puppies')} updated` : 'Nothing yet')
    });
    return this.saved(res, (out) => (out.n ? 'Saved on each puppy\'s record, ready for their papers.' : 'Okay, I left them as they were.'));
  }

  // Sales with money still owed (Pro: accounts / invoicing): for each, a payment
  // request (the Sale page's, a message she sends herself, with a Stripe link when
  // connected) or an invoice (the generator, which opens the invoice in a new tab).
  async balances() {
    if (!editionFlags.accounts && !editionFlags.invoicing) return;
    const owing = [];
    for (const r of this.chosen) {
      if (!r.sale || !['deposit_pending', 'deposit_paid'].includes(r.sale.status) || r.sale.balance_paid_date) continue;
      const due = await balanceDueOn(r.sale);
      if (due > 0) owing.push({ r, due });
    }
    if (!owing.length) return;
    // A payment request needs a Payment service to pay through (a link or
    // instructions, or her Stripe key on this device), as the Sale page's does.
    let canRequest = false;
    if (editionFlags.accounts) {
      const accounts = await accountRepo.getAll();
      canRequest = paymentAccounts(accounts).length > 0;
      for (const a of accounts) if (!canRequest && !a.is_archived && a.account_type === 'payment_service' && await stripeConnection(a.id)) canRequest = true;
    }
    if (!canRequest && !editionFlags.invoicing) return;
    const lines = owing.map(({ r, due }) => `<strong>${esc(pupName(r.pup))}</strong>${r.buyer?.name ? ` (${esc(r.buyer.name)})` : ''}: ${esc(fmtMoney(due))}${r.sale.balance_due_date ? `, due ${esc(fmtDate(r.sale.balance_due_date))}` : ''}`);
    const offer = [canRequest && 'a payment request', editionFlags.invoicing && 'an invoice'].filter(Boolean).join(' and ');
    await this.chat.say(`${owing.length === 1 ? 'One family still owes' : 'These families still owe'} a balance:<br>${lines.join('<br>')}<br>Want to send ${owing.length === 1 ? 'them' : 'each'} ${offer}?${editionFlags.accounts && !canRequest ? ' (To send payment requests, add the service families pay you through on the Accounts page.)' : ''}`);
    if ((await this.chat.choose([{ label: 'Yes, let\'s do it', value: 'go', primary: true }, { label: 'Not now', value: '' }])) !== 'go') return;
    // Each family in turn: the payment request, then the invoice, each skippable.
    for (const [i, { r, due }] of owing.entries()) {
      const who = esc(r.buyer?.name || 'the family');
      if (owing.length > 1) await this.chat.say(`<strong>${esc(pupName(r.pup))}</strong>: ${esc(fmtMoney(due))} from ${who}.`);
      if (canRequest) {
        await this.chat.say(`First, a payment request to ${who}: the amount and how to pay, sent by email or text.`, { typing: 400 });
        if ((await this.chat.choose([{ label: 'Send a payment request', value: 'go', primary: true }, { label: 'Skip', value: '' }])) === 'go') {
          const { openPaymentRequest } = await import('./paymentRequestUI.js');
          await openPaymentRequest({ saleId: r.sale.id });
        }
      }
      if (editionFlags.invoicing) {
        await this.chat.say(canRequest ? `And an invoice for ${who}? It opens in a new tab to download or print; close it and come back here when you're done.`
          : `An invoice for ${who}? It opens in a new tab to download or print; close it and come back here when you're done.`, { typing: 400 });
        if ((await this.chat.choose([{ label: 'Make an invoice', value: 'go', primary: true }, { label: 'Skip', value: '' }])) === 'go') {
          await this.chat.say('Pick what goes on it, then <strong>Generate</strong>.', { typing: 300 });
          const { openInvoiceGenerator } = await import('./invoiceGenerator.js');
          await new Promise((resolve) => { openInvoiceGenerator({ preselect: { source: 'sale', id: r.sale.id }, onClose: resolve }); });
        }
      }
      await this.chat.say(i === owing.length - 1 ? 'Okay, that\'s the balances!' : 'Okay, next family.', { typing: 300 });
    }
  }

  async feeding() {
    await this.chat.say('A feeding schedule can be set for the breed (it covers every litter) or just for this litter.');
    const pick = await this.chat.choose([
      { label: 'For the breed', value: 'breed', primary: true },
      { label: 'Just this litter', value: 'litter' },
      { label: 'Not now', value: '' }
    ]);
    if (pick === 'breed') return this.leave('breed-feeding-schedules.html', 'I\'ll open your feeding schedules.');
    if (pick === 'litter') return this.feedingNote();
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
      if (pick === 'yes') {
        await this.openTab(`${pagesPrefix()}furever.html`, {
          say: 'Sure! Furever opens in a new tab. Once you\'ve sent the links, you can close that tab and come back here; I\'ll be waiting.',
          opened: 'Furever is open in the other tab. Take your time!',
          blockedLabel: 'Furever'
        });
      }
    }
    if (!editionFlags.puppyRecord) { await this.goodbye(); return; }
    await this.chat.say('<strong>Last step: want me to print their puppy records?</strong> I\'ll put it all in one file, with a cover page just for you showing where each pup stands, then each pup\'s record for their family.');
    const pick = await this.chat.choose([{ label: 'Print puppy records', value: 'print', primary: true }, { label: 'Not now', value: '' }]);
    if (pick !== 'print') { await this.goodbye(); return; }
    const href = `${pagesPrefix()}puppy-record.html?dogs=${this.chosen.map((r) => encodeURIComponent(r.pup.id)).join(',')}&cover=1&autoprint=1&checks=${encodeURIComponent(this.checks.join(','))}`;
    await this.openTab(href, {
      say: 'Of course! I\'ll have to open a new tab to print from. Once you print, you can close that tab and come back here; I\'ll be waiting.',
      opened: 'The puppy records are open in the other tab, ready to print. Take your time!',
      blockedLabel: 'the puppy records'
    });
    await this.goodbye();
  }

  // Says a new tab is coming and waits for her OK before opening it, so the switch
  // never takes her by surprise. Opened from that tap, so it isn't blocked.
  // `say`: what she's told first; `opened`: the line once the tab is open.
  async openTab(href, { say, opened, blockedLabel }) {
    await this.chat.say(say);
    if ((await this.chat.choose([{ label: 'Okay, open it', value: 'go', primary: true }, { label: 'Not now', value: '' }])) !== 'go') return false;
    const tab = window.open(href, '_blank');
    await this.chat.say(tab ? opened : `Your browser blocked the new tab. <a href="${esc(href)}" target="_blank" rel="noopener">Tap here to open ${esc(blockedLabel)}</a>.`);
    return Boolean(tab);
  }

  async goodbye() {
    await this.chat.say(this.chosen.length === 1 ? `You've done a lovely job getting ${esc(pupName(this.chosen[0].pup))} ready.`
      : 'You\'ve done a lovely job getting these pups ready.', { typing: 700 });
  }
}
