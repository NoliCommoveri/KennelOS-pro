// litterCheckinUI.js — Kels's "Check in on a litter" task: the weekly visit with
// one litter, as a chat on pages/kels.html (assets/kelsChat.js draws it).
//
// Kels asks which litter (every one that isn't closed), says where it stands
// (age, status, each pup's plan), then brings up what's waiting on a decision,
// one at a time: open picks when the accept-deposits date has come (Pro, with
// families on the waitlist) or move that date; Weaning from 4 weeks; Ready from
// the estimated ready date; and Today's litter rules (mark sold, reopen, close).
// Then "What are we doing first?": weights, medication, or something else
// (deworming, shots, a vet visit, puppy plans, microchips, the dates, the
// status). Each thing is saved as soon as she approves it, through the repos, so
// there's no draft to keep; she can stop at any point.
//
// The rules and wording helpers are in data/litterCheckin.js. Open picks uses
// the Litter page's waitlist panel (assets/waitlistPicksPanel.js, Pro-only),
// imported only when the edition has the waitlist.
import { dogRepo } from '../data/dogRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import { eventRepo } from '../data/eventRepo.js';
import { waitlistEntryRepo } from '../data/waitlistEntryRepo.js';
import { inScopeOnly } from '../data/kennelScope.js';
import { editionFlags } from '../data/editionConfig.js';
import { DISPOSITION, EVENT_TYPES, descriptor } from '../data/vocab.js';
import * as C from '../data/litterCheckin.js';
import * as H from '../data/goHome.js';
import { contactRepo } from '../data/contactRepo.js';
import { addDaysToYMD } from '../data/dateUtils.js';
import { esc, fmtDate, fmtMoney, todayYMD } from './ui.js';

const pagesPrefix = () => (location.pathname.includes('/pages/') ? '' : 'pages/');
const litterHref = (l) => `${pagesPrefix()}litter.html?id=${encodeURIComponent(l.id)}`;
const sexWord = (p) => (p.sex === 'male' ? 'boy' : p.sex === 'female' ? 'girl' : '');
const pupName = (p) => p.call_name || p.registered_name || 'Puppy';
const pupLine = (p) => `<strong>${esc(pupName(p))}</strong>${sexWord(p) ? ` <span class="faint">${esc(sexWord(p))}</span>` : ''}`;
// A message from the waitlist ("\n\n" between paragraphs) as Kels's markup.
const paragraphs = (text) => String(text || '').split(/\n{2,}/).map((t) => esc(t)).join('<br><br>');

// For Kels's menu: is there a litter to check on, and does one have pups at home?
export async function checkinState() {
  const litters = C.checkinLitters(inScopeOnly(await litterRepo.getAll({ includeArchived: false })));
  return { open: litters.length, withPups: litters.filter((l) => ['whelped', 'weaning', 'ready'].includes(l.status)).length };
}

// Run the check-in. `litterId` skips "which litter?" (from a litter's page).
// `handoff(taskId, opts)` starts another of Kels's tasks (an Expected litter's
// birth); `onExit(reason)` hands the chat back to her menu.
export async function runCheckinTask(chat, { litterId = null, onExit = () => {}, handoff = null } = {}) {
  return new Checkin(chat, onExit, handoff).start(litterId);
}

class Checkin {
  constructor(chat, onExit, handoff) {
    Object.assign(this, { chat, onExit, handoff, today: todayYMD(), asked: new Set(), didSomething: false });
  }

  // --- Records ------------------------------------------------------------------

  async load(litterId) {
    const [litter, dogs, sales] = await Promise.all([
      litterRepo.getById(litterId),
      dogRepo.getAll({ includeArchived: false }),
      saleRepo.getAll({ includeArchived: false })
    ]);
    this.litter = litter;
    this.dogsById = new Map(dogs.map((d) => [d.id, d]));
    this.label = C.litterLabel(litter, this.dogsById);
    this.roster = C.rosterOf(litter.id, dogs);
    // Every pup's sales, departed (archived) pups included: the close rule counts them.
    this.sales = C.litterSalesOf(litter.id, await dogRepo.getByLitter(litter.id), sales);
    this.home = C.homePups(this.roster, this.sales);
    const perPup = await Promise.all(this.home.map((p) => eventRepo.getForSubject('dog', p.id)));
    this.eventsByPup = new Map(this.home.map((p, i) => [p.id, perPup[i]]));
    this.weights = C.lastWeights(perPup.flat());
    this.waitlistOn = false;
    if (editionFlags.waitlist) {
      const entries = await waitlistEntryRepo.getByKennel(litter.kennel_id);
      this.waitlistOn = entries.some((e) => e.status === 'active');
    }
  }

  // --- The visit ----------------------------------------------------------------

  async start(litterId) {
    const all = C.checkinLitters(inScopeOnly(await litterRepo.getAll({ includeArchived: false })));
    let litter = litterId ? all.find((l) => l.id === litterId) : null;
    if (!litter) {
      if (!all.length) {
        await this.chat.say('You don\'t have any open litters right now. When one is born, I can help you record it.');
        return this.onExit('done');
      }
      litter = await this.pickLitter(all);
      if (!litter) return this.onExit('nevermind');
    } else {
      await this.chat.say('Let\'s check on this litter.', { typing: 500 });
    }
    await this.load(litter.id);
    if (this.litter.status === 'expected') return this.expected(all);
    await this.summary();
    await this.raiseSuggestions();
    return this.loop();
  }

  async pickLitter(all) {
    const dogsById = new Map((await dogRepo.getAll({ includeArchived: false })).map((d) => [d.id, d]));
    const counts = new Map();
    for (const d of dogsById.values()) if (d.litter_id && d.status !== 'deceased') counts.set(d.litter_id, (counts.get(d.litter_id) || 0) + 1);
    await this.chat.say('<strong>Which litter are we checking on?</strong>', { typing: 700 });
    const id = await this.chat.choose([
      ...all.map((l) => {
        const age = C.ageText(C.ageDays(l, this.today));
        const bits = [C.statusLabel(l.status)];
        if (l.status === 'expected') { if (l.whelp_date) bits.push(`due ${fmtDate(l.whelp_date)}`); }
        else if (age) bits.push(age);
        if (counts.get(l.id)) bits.push(C.plural(counts.get(l.id), 'puppy', 'puppies'));
        return { label: C.litterLabel(l, dogsById), sub: bits.join(' · '), value: l.id };
      }),
      { label: 'Never mind', value: '' }
    ], { stagger: 200 });
    return id ? all.find((l) => l.id === id) : null;
  }

  async expected(all) {
    await this.chat.say(`<strong>${esc(this.label)}</strong> hasn't been born yet. Did the puppies arrive?`);
    const pick = await this.chat.choose([
      ...(this.handoff ? [{ label: 'Yes, record the birth', value: 'birth', primary: true }] : []),
      ...(all.length > 1 ? [{ label: 'Check on a different litter', value: 'other' }] : []),
      { label: 'Never mind', value: 'nevermind' }
    ]);
    if (pick === 'birth') return this.handoff('record-litter', { litterId: this.litter.id });
    if (pick === 'other') { this.asked.clear(); return this.start(null); }
    return this.onExit('nevermind');
  }

  async summary() {
    const l = this.litter;
    const age = C.ageText(C.ageDays(l, this.today));
    const gone = this.roster.filter((p) => p.status === 'puppy').length - this.home.length;
    const lines = [`<strong>${esc(this.label)}</strong> is ${age ? esc(age) : 'born'} and marked ${esc(C.statusLabel(l.status))}.`,
      esc(C.dispositionSummary(this.roster))];
    if (gone > 0) lines.push(`${C.plural(gone, 'puppy has', 'puppies have')} gone home.`);
    await this.chat.say(lines.join(' '), { typing: 900 });
  }

  // Each decision waiting on the litter, once per visit.
  // Each decision waiting on the litter, then on each puppy's way home
  // (data/goHome.js), once per visit.
  async raiseSuggestions() {
    for (;;) {
      const next = C.checkinSuggestions({ litter: this.litter, roster: this.roster, sales: this.sales, today: this.today, waitlistOn: this.waitlistOn })
        .find((s) => !this.asked.has(`${s.id}:${s.status || ''}`));
      const home = next ? null : this.goHomeIssues().find((x) => !this.asked.has(`gohome:${x.pup.id}:${x.kind}`));
      if (!next && !home) return;
      if (next) {
        this.asked.add(`${next.id}:${next.status || ''}`);
        if (next.id === 'open-picks') await this.offerPicks();
        else await this.offerStatus(next);
      } else {
        this.asked.add(`gohome:${home.pup.id}:${home.kind}`);
        if (await this.offerGoHome(home) === 'left') return;
      }
      await this.load(this.litter.id);
    }
  }

  goHomeIssues() {
    return this.home.map((pup) => {
      const issue = H.goHomeIssue({
        pup, litter: this.litter, today: this.today,
        sales: this.sales.filter((x) => x.dog_id === pup.id), events: this.eventsByPup.get(pup.id) || []
      });
      return issue ? { ...issue, pup } : null;
    }).filter(Boolean);
  }

  // --- A puppy's way home --------------------------------------------------------

  async offerGoHome(x) {
    const name = esc(pupName(x.pup));
    const family = esc((x.sale.buyer_contact_id && (await contactRepo.getById(x.sale.buyer_contact_id))?.name) || 'their family');
    const start = H.defaultStart(x.readyDate, this.today);
    if (x.kind === 'boarding') {
      await this.chat.say(`${name}'s sale includes boarding (${esc(H.boardingChargeText(x.sale, fmtMoney))}): ${family} is paying for ${name} to stay after the ready date. Want me to log the boarding?`);
      return this.logBoarding(x, start);
    }
    if (x.kind === 'schedule') {
      await this.chat.say(`${name} is going home to ${family}, and the litter is ready ${esc(fmtDate(x.readyDate))}. There's no pickup on the calendar yet.`);
      return this.logPickup(x, start, '<strong>When is the pickup?</strong>');
    }
    await this.chat.say(`${name}'s pickup was ${esc(fmtDate(x.pickupDate))}, but the sale to ${family} isn't marked Delivered. Did ${name} go home?`);
    const pick = await this.chat.choose([
      { label: 'Yes, mark the sale delivered', value: 'yes', primary: true },
      { label: 'No, the pickup moved', value: 'moved' },
      { label: 'Not now', value: 'later' }
    ]);
    if (pick === 'moved') return this.logPickup(x, this.today, '<strong>When is the new pickup?</strong>');
    if (pick === 'yes') {
      await this.chat.say('I\'ll open the sale with Delivered chosen. Check it and tap <strong>Save</strong>; the Sale page takes it from there.');
      await this.chat.pause(1200);
      location.href = `${pagesPrefix()}sale.html?id=${encodeURIComponent(x.sale.id)}&deliver=1`;
      return 'left';
    }
  }

  async logPickup(x, date, title) {
    const res = await this.chat.form({
      title,
      html: `<div class="ck-inline">
          ${field('Pickup date', `<input id="ck-pickup" type="date" value="${esc(date)}">`)}
          ${field('Time (optional)', '<input id="ck-time" type="text" placeholder="e.g. 10am">')}
        </div>`,
      submitLabel: 'Save pickup',
      cancelLabel: 'Not sure yet',
      submit: async (root) => {
        const d = root.querySelector('#ck-pickup').value;
        if (!d) return 'Pick a date.';
        await eventRepo.create(H.pickupEvent(x.pup, x.sale, d, root.querySelector('#ck-time').value.trim()));
        return { d };
      },
      reply: (r) => `Pickup on ${fmtDate(r.d)}`
    });
    if (!res.done) return;
    this.didSomething = true;
    await this.chat.say(`Saved. It's on ${esc(pupName(x.pup))}'s history and your calendar. After that day, I'll ask whether ${esc(pupName(x.pup))} went home.`);
  }

  async logBoarding(x, start) {
    const res = await this.chat.form({
      title: '',
      html: `<div class="ck-inline">
          ${field('Boarding starts', `<input id="ck-bstart" type="date" value="${esc(start)}">`)}
          ${field('Ends (optional)', `<input id="ck-bend" type="date" value="${esc(H.boardingEnd(x.sale, start))}">`)}
        </div>`,
      wire: (root) => {
        const st = root.querySelector('#ck-bstart');
        const en = root.querySelector('#ck-bend');
        st.addEventListener('change', () => { en.value = H.boardingEnd(x.sale, st.value) || en.value; });
      },
      submitLabel: 'Log boarding',
      cancelLabel: 'Not now',
      submit: async (root) => {
        const a = root.querySelector('#ck-bstart').value;
        const b = root.querySelector('#ck-bend').value;
        if (!a) return 'When does the boarding start?';
        if (b && b < a) return 'The end is before the start.';
        await eventRepo.create(H.boardingEvent(x.pup, a, b));
        return { a, b };
      },
      reply: (r) => `Boarding from ${fmtDate(r.a)}${r.b ? ` to ${fmtDate(r.b)}` : ''}`
    });
    if (!res.done) return;
    this.didSomething = true;
    await this.chat.say('Logged. Once it\'s over, I\'ll ask about the pickup.');
  }

  async offerPicks() {
    const l = this.litter;
    const when = l.accept_deposits_date === this.today ? 'today' : `on ${fmtDate(l.accept_deposits_date)}`;
    await this.chat.say(`You planned to start taking deposits ${esc(when)}, and picks aren't open yet. Want me to open picks for your waitlist?`);
    const pick = await this.chat.choose([
      { label: 'Yes, open picks', value: 'open', primary: true },
      { label: 'Not yet, move the deposit date', value: 'move' },
      { label: 'Not now', value: 'later' }
    ]);
    if (pick === 'open') {
      const { openPicksFromCheckin } = await import('./waitlistPicksPanel.js');
      const said = await openPicksFromCheckin(l);
      this.didSomething = true;
      await this.chat.say(`<strong>${esc(said.title)}</strong><br>${paragraphs(said.message)}`);
    } else if (pick === 'move') {
      await this.moveDepositDate();
    }
  }

  async moveDepositDate() {
    const res = await this.chat.form({
      title: '<strong>When do you want to start taking deposits?</strong>',
      html: field('New date', `<input id="ck-deposit" type="date" min="${esc(addDaysToYMD(this.today, 1))}" value="${esc(C.rescheduleDefault(this.today))}">`),
      submitLabel: 'Move it',
      cancelLabel: 'Leave it',
      submit: async (root) => {
        const date = root.querySelector('#ck-deposit').value;
        if (!date) return 'Pick a date.';
        if (date <= this.today) return 'Pick a day after today, or open picks now.';
        await litterRepo.update(this.litter.id, { accept_deposits_date: date });
        return { date };
      },
      reply: (r) => `Move it to ${fmtDate(r.date)}`
    });
    if (res.done) {
      this.didSomething = true;
      await this.chat.say(`Done. I'll ask again on ${esc(fmtDate(res.result.date))}.`);
    }
  }

  async offerStatus(s) {
    const age = C.ageText(C.ageDays(this.litter, this.today));
    const ask = {
      weaning: `They're ${esc(age)} and still marked Whelped. Move the litter to Weaning?`,
      ready: s.reopen
        ? `A puppy is available again, but the litter is marked ${esc(C.statusLabel(this.litter.status))}. Reopen it to Ready?`
        : `${this.litter.estimated_ready_date ? `Their estimated ready date was ${esc(fmtDate(this.litter.estimated_ready_date))}` : `They're ${esc(age)}`}. Move the litter to Ready?`,
      sold: 'Every puppy is placed or being kept. Mark the litter Sold?',
      closed: 'Every puppy has gone home or is staying with you, and every sale is finished. Close the litter?'
    }[s.status];
    await this.chat.say(ask);
    const verb = s.reopen ? 'Reopen it' : s.status === 'closed' ? 'Close it' : `Move to ${C.statusLabel(s.status)}`;
    const pick = await this.chat.choose([
      { label: verb, value: 'yes', primary: true },
      { label: 'Not yet', value: 'no' }
    ]);
    if (pick !== 'yes') return;
    await this.setStatus(s.status);
  }

  async setStatus(status) {
    try {
      await litterRepo.update(this.litter.id, { status });
      this.didSomething = true;
      await this.chat.say(status === 'closed'
        ? `Closed. That's ${esc(this.label)} all wrapped up. Congratulations!`
        : `Done. ${esc(this.label)} is now ${esc(C.statusLabel(status))}.`);
    } catch (e) {
      await this.chat.say(`Hmm, that didn't save: ${esc(e.message || String(e))}`);
    }
  }

  // --- "What are we doing?" -----------------------------------------------------

  async loop() {
    let first = true;
    for (;;) {
      const hasPups = this.home.length > 0;
      const last = C.lastWeighedDate(this.weights, this.home);
      const weighedSub = last ? `Last weighed ${fmtDate(last)} (${C.plural(C.daysBetween(last, this.today), 'day')} ago)` : 'No weights on file yet';
      await this.chat.say(first ? '<strong>What are we doing first?</strong>' : `<strong>What's next for ${esc(this.label)}?</strong>`, { typing: first ? 700 : 500 });
      first = false;
      const pick = await this.chat.choose([
        ...(hasPups ? [
          { label: 'Record weights', sub: weighedSub, value: 'weights' },
          { label: 'Health care', sub: 'Deworming, shots, medication, a vet visit', value: 'care' }
        ] : []),
        { label: 'Something else', sub: hasPups ? 'Plans, microchips, dates, the litter\'s status' : 'Plans, dates, the litter\'s status', value: 'more' },
        this.didSomething ? { label: 'That\'s all for now', value: 'done' } : { label: 'Never mind', value: 'nevermind' }
      ], { stagger: 150 });
      const what = pick === 'more' ? await this.moreMenu() : pick === 'care' ? await this.careMenu() : pick;
      if (what === 'done' || what === 'nevermind') return this.finish(what);
      if (what === 'page') { location.href = litterHref(this.litter); return; }
      if (what) await this.run(what);
      await this.load(this.litter.id);
      await this.raiseSuggestions();
    }
  }

  async moreMenu() {
    const hasPups = this.home.length > 0;
    const undecided = this.roster.filter((p) => p.status === 'puppy' && (p.disposition || 'undecided') === 'undecided').length;
    const unchipped = this.home.filter((p) => !p.microchip_id).length;
    const l = this.litter;
    await this.chat.say('Sure. What do you need?', { typing: 400 });
    const pick = await this.chat.choose([
      ...(this.roster.some((p) => p.status === 'puppy' && p.disposition !== 'placed')
        ? [{ label: 'Update puppy plans', sub: undecided ? `${undecided} undecided` : 'Keeping, available, health hold', value: 'plans' }] : []),
      ...(hasPups ? [{ label: 'Record microchips', sub: unchipped ? `${unchipped} without one` : 'Every puppy has one', value: 'chips' }] : []),
      { label: 'Change the deposit or ready date', sub: [l.accept_deposits_date ? `Deposits ${fmtDate(l.accept_deposits_date)}` : 'No deposit date', l.estimated_ready_date ? `ready ${fmtDate(l.estimated_ready_date)}` : 'no ready date'].join(' · '), value: 'dates' },
      { label: 'Change the litter\'s status', sub: `Now ${C.statusLabel(l.status)}`, value: 'status' },
      { label: 'Open the litter\'s page', value: 'page' },
      { label: 'Go back', value: '' }
    ], { stagger: 120 });
    return pick;
  }

  // "Health care": which kind, then that kind's form.
  async careMenu() {
    await this.chat.say('Sure! What did they receive?', { typing: 400 });
    return this.chat.choose([
      ...Object.entries(C.CARE_KINDS).map(([kind, k]) => ({ label: k.label, value: `care:${kind}` })),
      { label: 'Go back', value: '' }
    ], { stagger: 120 });
  }

  async run(what) {
    if (what === 'weights') return this.weigh();
    if (what.startsWith('care:')) return this.care(what.slice(5));
    if (what === 'plans') return this.plans();
    if (what === 'chips') return this.chips();
    if (what === 'dates') return this.dates();
    if (what === 'status') return this.pickStatus();
  }

  async finish(how) {
    if (how === 'done') await this.chat.say(`Great work! ${esc(this.label)} is all caught up.`);
    this.onExit(how === 'done' ? 'done' : 'nevermind');
  }

  // --- Weights -----------------------------------------------------------------

  async weigh() {
    const rows = this.home.map((p, i) => {
      const prev = this.weights.get(p.id);
      return `<div class="ck-row">
        <div class="ck-row-name">${pupLine(p)}${prev ? `<span class="field-hint">Last: ${esc(C.fmtOz(prev.oz))} on ${esc(fmtDate(prev.date))}</span>` : '<span class="field-hint">No weight yet</span>'}</div>
        <label class="ck-unit"><input id="ck-lb-${i}" type="number" min="0" step="1" inputmode="numeric" aria-label="${esc(pupName(p))}: pounds"> lb</label>
        <label class="ck-unit"><input id="ck-oz-${i}" type="number" min="0" step="0.1" inputmode="decimal" aria-label="${esc(pupName(p))}: ounces"> oz</label>
      </div>`;
    }).join('');
    const res = await this.chat.form({
      title: '<strong>Let\'s weigh them.</strong><span class="kels-lead">Type each puppy\'s weight in pounds and ounces (either one is fine). Leave a puppy blank to skip them.</span>',
      html: `<div class="ck-inline">
          ${field('Date', `<input id="ck-date" type="date" value="${esc(this.today)}" max="${esc(this.today)}">`)}
          ${field('Time of day', `<select id="ck-time"><option value="">—</option><option>AM</option><option>PM</option></select>`)}
        </div>${rows}`,
      submitLabel: 'Save weights',
      cancelLabel: 'Never mind',
      submit: async (root) => {
        const date = root.querySelector('#ck-date').value;
        if (!date) return 'When did you weigh them? Pick a date.';
        const time = root.querySelector('#ck-time').value;
        const entered = [];
        for (const [i, p] of this.home.entries()) {
          const oz = C.parseWeight(root.querySelector(`#ck-lb-${i}`).value, root.querySelector(`#ck-oz-${i}`).value);
          if (oz && oz.error) return `${pupName(p)}: ${oz.error}`;
          if (oz != null) entered.push({ pup: p, oz, prev: this.weights.get(p.id) || null });
        }
        if (!entered.length) return 'Type at least one weight, or tap Never mind.';
        for (const r of entered) {
          await eventRepo.create({
            subject_type: 'dog', subject_id: r.pup.id, event_type: 'weight_check',
            event_date: date, title: 'Weight check', details: C.weightDetails(r.oz, time)
          });
        }
        return { entered, date };
      },
      reply: (r) => `Here are ${C.plural(r.entered.length, 'weight')} for ${fmtDate(r.date)}`
    });
    if (!res.done) return;
    this.didSomething = true;
    await this.chat.say(this.weightComment(res.result));
  }

  weightComment({ entered, date }) {
    const rep = C.weightReport(entered);
    const since = (r) => (r.prev.date === date ? 'since earlier that day' : `since ${esc(fmtDate(r.prev.date))}`);
    const parts = [`Saved ${C.plural(entered.length, 'weight')}.`];
    if (!rep.lost.length && !rep.same.length && rep.gained.length) {
      parts.push(rep.gained.length === entered.length ? 'Everyone is gaining.' : 'Everyone I could compare is gaining.');
      if (rep.top) parts.push(`${esc(pupName(rep.top.pup))} gained the most: +${esc(C.fmtOz(rep.top.diff))} ${since(rep.top)}.`);
    }
    if (rep.lost.length || rep.same.length) {
      const watch = [
        ...rep.lost.map((r) => `${esc(pupName(r.pup))} is down ${esc(C.fmtOz(-r.diff))} ${since(r)}`),
        ...rep.same.map((r) => `${esc(pupName(r.pup))} hasn't gained ${since(r)}`)
      ];
      parts.push(`Heads up: ${watch.join(', and ')}. Worth keeping an eye on.`);
    }
    if (rep.first.length && rep.first.length < entered.length) parts.push(`It's the first weight on file for ${esc(rep.first.map((r) => pupName(r.pup)).join(', '))}.`);
    const skipped = this.home.filter((p) => !entered.some((r) => r.pup.id === p.id));
    if (skipped.length) parts.push(`No weight for ${esc(skipped.map(pupName).join(', '))} this time.`);
    return parts.join(' ');
  }

  // --- Medication, deworming, shots, vet visits --------------------------------

  async care(kind) {
    const k = C.CARE_KINDS[kind];
    const type = descriptor(EVENT_TYPES, k.eventType);
    const span = type.duration === 'span';
    const fields = (type.fields || []).map((f) => careInput(f, f.key === k.nameKey)).join('');
    const pups = this.home.map((p, i) => `<label class="ck-check"><input type="checkbox" id="ck-pup-${i}" checked> ${pupLine(p)}</label>`).join('');
    const res = await this.chat.form({
      title: `<strong>${esc(k.ask)}</strong>`,
      html: `${fields}
        <div class="ck-inline">
          ${field(span ? 'Started' : 'Date', `<input id="ck-date" type="date" value="${esc(this.today)}">`)}
          ${span ? field('Last dose (optional)', '<input id="ck-end" type="date">') : ''}
        </div>
        <p class="gl-q">Which puppies? <button type="button" class="gl-more" data-ck="all">All</button> <button type="button" class="gl-more" data-ck="none">None</button></p>
        <div class="ck-checks">${pups}</div>`,
      wire: (root) => {
        root.querySelector('[data-ck="all"]').addEventListener('click', () => root.querySelectorAll('.ck-checks input').forEach((c) => { c.checked = true; }));
        root.querySelector('[data-ck="none"]').addEventListener('click', () => root.querySelectorAll('.ck-checks input').forEach((c) => { c.checked = false; }));
      },
      submitLabel: 'Save',
      submit: async (root) => {
        const ids = this.home.filter((p, i) => root.querySelector(`#ck-pup-${i}`).checked).map((p) => p.id);
        const details = {};
        for (const f of type.fields || []) details[f.key] = root.querySelector(`#ck-f-${f.key}`)?.value ?? '';
        const form = { date: root.querySelector('#ck-date').value, endDate: root.querySelector('#ck-end')?.value || '', details };
        const problem = C.careProblem(kind, ids, form);
        if (problem) return problem;
        const events = C.careEvents(kind, ids, form);
        for (const e of events) await eventRepo.create(e);
        return { count: ids.length, title: events[0].title, date: form.date };
      },
      reply: (r) => `${r.title} for ${r.count === this.home.length ? (r.count === 1 ? 'the puppy' : `all ${r.count} puppies`) : C.plural(r.count, 'puppy', 'puppies')}`
    });
    if (!res.done) return;
    this.didSomething = true;
    await this.chat.say(`Saved. It's on each puppy's history for ${esc(fmtDate(res.result.date))}.`);
  }

  // --- Puppy plans --------------------------------------------------------------

  async plans() {
    const pups = this.roster.filter((p) => p.status === 'puppy');
    const choices = DISPOSITION.filter((d) => d.value !== 'placed');
    const rows = pups.map((p, i) => (p.disposition === 'placed'
      ? `<div class="gl-plan-row"><span>${pupLine(p)}</span><span class="faint">Placed (from the sale)</span></div>`
      : `<div class="gl-plan-row"><span>${pupLine(p)}</span>
          <select id="ck-plan-${i}" aria-label="${esc(pupName(p))}: plan">${choices.map((d) => `<option value="${esc(d.value)}"${d.value === (p.disposition || 'undecided') ? ' selected' : ''}>${esc(d.label)}</option>`).join('')}</select></div>`)).join('');
    const res = await this.chat.form({
      title: '<strong>What are your plans for each puppy?</strong><span class="kels-lead">Available puppies can be offered to families. A placed puppy changes on its sale.</span>',
      html: rows,
      submitLabel: 'Save plans',
      submit: async (root) => {
        let changed = 0;
        for (const [i, p] of pups.entries()) {
          const v = root.querySelector(`#ck-plan-${i}`)?.value;
          if (!v || v === (p.disposition || 'undecided')) continue;
          await dogRepo.update(p.id, { disposition: v });
          changed++;
        }
        return changed;
      },
      reply: (n) => (n ? `Update ${C.plural(n, 'puppy', 'puppies')}` : 'Keep them as they are')
    });
    if (!res.done) return;
    if (res.result) this.didSomething = true;
    await this.chat.say(res.result ? 'Done. Their plans are updated.' : 'Okay, nothing changed.');
  }

  // --- Microchips ---------------------------------------------------------------

  async chips() {
    const rows = this.home.map((p, i) => field(pupName(p) + (sexWord(p) ? ` (${sexWord(p)})` : ''), `<input id="ck-chip-${i}" type="text" inputmode="numeric" autocomplete="off" value="${esc(p.microchip_id || '')}">`)).join('');
    const res = await this.chat.form({
      title: '<strong>Microchip numbers</strong><span class="kels-lead">Type or scan each number. Leave one blank if they don\'t have a chip yet.</span>',
      html: rows,
      submitLabel: 'Save chips',
      submit: async (root) => {
        let changed = 0;
        for (const [i, p] of this.home.entries()) {
          const v = root.querySelector(`#ck-chip-${i}`).value.trim();
          if (v === (p.microchip_id || '')) continue;
          await dogRepo.update(p.id, { microchip_id: v });
          changed++;
        }
        return changed;
      },
      reply: (n) => (n ? `Save ${C.plural(n, 'chip number')}` : 'No changes')
    });
    if (!res.done) return;
    if (res.result) this.didSomething = true;
    await this.chat.say(res.result ? 'Saved.' : 'Okay, nothing changed.');
  }

  // --- Dates and status ------------------------------------------------------------

  async dates() {
    const l = this.litter;
    const res = await this.chat.form({
      title: '<strong>The litter\'s dates</strong>',
      html: field('Start taking deposits', `<input id="ck-deposits" type="date" value="${esc(l.accept_deposits_date || '')}">`, 'Families see this date. With a waitlist, I\'ll offer to open picks when it comes.')
        + field('Estimated ready date', `<input id="ck-ready" type="date" value="${esc(l.estimated_ready_date || '')}">`, 'When the puppies can go home.'),
      submitLabel: 'Save dates',
      submit: async (root) => {
        const changes = {};
        const dep = root.querySelector('#ck-deposits').value;
        const ready = root.querySelector('#ck-ready').value;
        if (dep !== (l.accept_deposits_date || '')) changes.accept_deposits_date = dep;
        if (ready !== (l.estimated_ready_date || '')) changes.estimated_ready_date = ready;
        if (Object.keys(changes).length) await litterRepo.update(l.id, changes);
        return Object.keys(changes).length;
      },
      reply: (n) => (n ? 'Save the new dates' : 'Keep the dates')
    });
    if (!res.done) return;
    if (res.result) { this.didSomething = true; this.asked.delete('open-picks:'); }
    await this.chat.say(res.result ? 'Saved.' : 'Okay, nothing changed.');
  }

  async pickStatus() {
    await this.chat.say(`It's marked ${esc(C.statusLabel(this.litter.status))}. What should it be?`);
    const pick = await this.chat.choose([
      ...C.statusChoices().filter((s) => s.value !== this.litter.status).map((s) => ({ label: s.label, value: s.value })),
      { label: 'Leave it', value: '' }
    ]);
    if (pick) await this.setStatus(pick);
  }
}

// --- Small HTML helpers -----------------------------------------------------------

function field(labelText, inputHtml, hint = '') {
  return `<div class="field gl-field"><label>${esc(labelText)}</label>${inputHtml}${hint ? `<span class="field-hint">${esc(hint)}</span>` : ''}</div>`;
}

// One details field of a care event type (vocab EVENT_TYPES), as an input.
function careInput(f, isName) {
  const id = `ck-f-${f.key}`;
  const label = f.contactFallback ? `${f.label} (name)` : f.label;
  let input;
  if (f.type === 'textarea') input = `<textarea id="${id}" rows="2"></textarea>`;
  else if (f.type === 'select') input = `<select id="${id}"><option value="">—</option>${(f.options || []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o)).map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select>`;
  else input = `<input id="${id}" type="${f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text'}"${f.step ? ` step="${esc(f.step)}"` : ''}${isName ? ' autocomplete="off"' : ''}>`;
  return field(label, input);
}

