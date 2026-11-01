// waitlistReviewUI.js — Kels's "Review my waitlist" (Kels Roadmap §3.16): her
// day-to-day waitlist work as one conversation on pages/kels.html. Pro only (the
// waitlist); pages/kels.js imports it on start.
//
// First it checks there's something to review: the waitlist set up (else **Set up
// my waitlist**), online where that's offered and publishing, and her own
// application form taking applications online (else **Set up my application
// form**); each hands her to that task with a button rather than redoing it here,
// and she can **Keep going** with what's on her device.
//
// Then "Here's what's waiting on you: …" (data/waitlistReview.reviewSummary) and
// the steps, most time-sensitive first, each skipped when empty, each item with
// **Skip for now**: (1) family requests and messages, (2) families backing out,
// then any other sale to cancel or void, (3) offers past their deadline, (4) picks
// to open, (5) a turn to offer, (6) new applications, (7) fees to check and extras
// payments due, (8) "Ready now?" unanswered and recent removals.
//
// Nothing here is its own rule. The items are Today's own waitlist nudges
// (nudges.waitlistNudgeItems), whose one-tap actions run as they do on Today;
// everything else is a waitlistActions call, a pure rule (backOut, transportFee,
// waitlistRules), or a shared dialog (offerEmails for every "email the family",
// communicateDialog, pickDialog / depositDialog, salePrompts, restoreLostPupDialog).
import { kennelRepo } from '../data/kennelRepo.js';
import { getEntryCredit } from '../data/incomeView.js';
import { contactRepo } from '../data/contactRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import { eventRepo } from '../data/eventRepo.js';
import { waitlistEntryRepo } from '../data/waitlistEntryRepo.js';
import { waitlistOfferRepo } from '../data/waitlistOfferRepo.js';
import { waitlistProgramRepo } from '../data/waitlistProgramRepo.js';
import { ownKennels, getActiveKennel } from '../data/kennelScope.js';
import { isWaitlistOnlineOffered } from '../data/cloud/cloudConfig.js';
import { waitlistNudgeItems, extraDueItems } from '../data/nudges.js';
import { snooze, snoozedUntil } from '../data/nudgeState.js';
import { readNudgeKey, STEP_OF, REVIEW_STEPS, reviewSummary, readinessProblems, outcomeReport } from '../data/waitlistReview.js';
import * as actions from '../data/waitlistActions.js';
import {
  waitlistConfig, waitlistIsSetUp, entryName, describeOfferChanges, contactMatches, contactMatchReason, privateName, publicName,
  isPupAvailable, eligiblePupsFor, rankedList, turnIdOf, restoresFamily, overallPositions
} from '../data/waitlistRules.js';
import { hasOwnForm } from '../data/guidedForm.js';
import { entryQuestions, formQuestions, answerText } from '../data/waitlistForm.js';
import { backOutItems, backOutSummary, suggestOutcome } from '../data/backOut.js';
import { transportQuote } from '../data/transportFee.js';
import { familySale, pendingExtraRequests } from '../data/familyExtras.js';
import { pendingPickupRequests } from '../data/familyPickup.js';
import { trainingStaysFor, trainingStayEvent, defaultStart, readyDateOf } from '../data/goHome.js';
import { chargesWithStepPaid } from '../data/extraCharges.js';
import { offerSpecs, kennelEmailsOn, familyEmail } from '../data/waitlistOutbox.js';
import { standardLocation } from '../data/pickupSlots.js';
import { litterLabel } from '../data/litterCheckin.js';
import { PAYMENT_METHODS, PLACEMENT_METHODS, SEX, isOpenSale, descriptor } from '../data/vocab.js';
import { addDaysToYMD } from '../data/dateUtils.js';
import { field } from './litterCheckinUI.js';
import { prefsSummary } from './waitlistUI.js';
import { esc, fmtDate, fmtMoney, todayYMD } from './ui.js';

const HOW = 'I\'ll go through what\'s waiting on you, most urgent first: family requests and messages, anyone backing out, offers and picks, new applications, fees, and the list\'s upkeep. Skip anything you want to leave for later. Sound good?';
const SKIP = { label: 'Skip for now', value: '__skip' };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const lines = (xs) => xs.filter(Boolean).map(esc).join('<br><br>');

// --- For Kels's menu: how much is waiting (any kennel in scope) -----------------

export async function reviewWaitlistState() {
  const [items, entries] = await Promise.all([waitlistNudgeItems(), waitlistEntryRepo.getAll()]);
  const applied = entries.filter((e) => !e.is_archived && (e.status === 'applied' || (e.status === 'approved' && !e.fee_received_date))).length;
  return { waiting: items.filter((n) => STEP_OF[readNudgeKey(n.key).kind]).length + applied };
}

export async function runWaitlistReviewTask(chat, { onExit = () => {}, handoff = null } = {}) {
  if (!(await chat.intro('Of course, let\'s go through your waitlist together!', HOW))) return onExit('nevermind');
  return new Review(chat, onExit, handoff).start();
}

class Review {
  constructor(chat, onExit, handoff) {
    Object.assign(this, { chat, onExit, handoff, skipped: 0, today: todayYMD() });
  }

  // --- Which kennel, and is there anything to review? -------------------------------

  async start() {
    const kennels = (await ownKennels()).filter((k) => !k.is_archived);
    const setUp = kennels.filter(waitlistIsSetUp);
    let kennel = setUp.length === 1 ? setUp[0] : null;
    if (!setUp.length) {
      const r = readinessProblems({ setUp: false });
      return this.offerFixes(r, kennels[0] || null);
    }
    if (!kennel) {
      const active = await getActiveKennel();
      await this.chat.say('<strong>Which kennel\'s waitlist?</strong>');
      const id = await this.chat.choose([
        ...setUp.map((k) => ({ label: k.kennel_name || 'Your kennel', value: k.id, primary: k.id === active?.id })),
        { label: 'Never mind', value: '' }
      ]);
      if (!id) return this.onExit('nevermind');
      kennel = setUp.find((k) => k.id === id);
    }
    this.kennel = kennel;
    const ready = await this.readiness();
    if (ready === 'left') return null;
    return this.overview(true);
  }

  // The list set up, online and publishing, her own form taking applications online.
  async readiness() {
    const k = this.kennel;
    const offered = isWaitlistOnlineOffered();
    let status = { online: false, formOpen: false, lastError: null };
    let problem = '';
    if (offered) {
      const cw = await import('../data/cloud/cloudWaitlist.js');
      status = cw.waitlistOnlineStatus(k);
      if (status.online && status.lastError) problem = (await import('./waitlistOnlineUI.js')).onlineProblemText(status.lastError.code);
    }
    const r = readinessProblems({ setUp: true, onlineOffered: offered, online: status.online, formOpen: status.formOpen, publishProblem: problem, ownForm: hasOwnForm(k) });
    if (!r.lines.length) return 'ok';
    return this.offerFixes(r, k);
  }

  // Say what's missing; a button per task that fixes it, and Keep going (unless
  // there's nothing to review yet). → 'ok' to go on, 'left' when she went elsewhere.
  async offerFixes(r, kennel) {
    await this.chat.say(lines(r.lines), { typing: 800 });
    const pick = await this.chat.choose([
      ...r.fixes.map((f) => ({ label: f.label, value: f.task, primary: r.stop })),
      ...(r.stop ? [{ label: 'Not now', value: '__no' }] : [{ label: 'Keep going', value: '__go', primary: true }])
    ]);
    if (pick === '__go') return 'ok';
    if (pick === '__no') { this.onExit('done'); return 'left'; }
    await this.chat.say('Sure, let\'s do that now. Come back to me when you\'re done and we\'ll go through your waitlist.');
    if (this.handoff) await this.handoff(pick, { kennelId: kennel?.id || null });
    else this.onExit('done');
    return 'left';
  }

  // --- Everything this kennel's waitlist needs ----------------------------------------

  async load() {
    const k = this.kennel = await kennelRepo.getById(this.kennel.id);
    const [entries, offers, contacts, litters, dogs, sales, programs, items] = await Promise.all([
      waitlistEntryRepo.getByKennel(k.id),
      waitlistOfferRepo.getByKennel(k.id),
      contactRepo.getAll({ includeArchived: true }),
      litterRepo.getAll({ includeArchived: true }),
      dogRepo.getAll({ includeArchived: true }),
      saleRepo.getAll({ includeArchived: true }),
      waitlistProgramRepo.getByKennel(k.id),
      waitlistNudgeItems(this.today)
    ]);
    const live = entries.filter((e) => !e.is_archived);
    const entriesById = new Map(live.map((e) => [e.id, e]));
    const contactsById = new Map(contacts.map((c) => [c.id, c]));
    const kennelLitters = litters.filter((l) => l.kennel_id === k.id);
    // Today's items that are about this kennel.
    const mine = (n) => {
      const r = readNudgeKey(n.key);
      if (r.entryId) return entriesById.has(r.entryId);
      if (r.litterId) return kennelLitters.some((l) => l.id === r.litterId);
      if (r.turnId) return offers.some((o) => turnIdOf(o) === r.turnId);
      return false;
    };
    Object.assign(this, {
      config: waitlistConfig(k), entries: live, entriesById, offers, contactsById, litters: kennelLitters,
      dogs, dogsById: new Map(dogs.map((d) => [d.id, d])), sales, programs: programs.filter((p) => !p.is_archived),
      items: items.filter((n) => STEP_OF[readNudgeKey(n.key).kind] && mine(n))
    });
    const familySales = this.familySales();
    this.extras = (await extraDueItems(familySales, this.today));
    return this;
  }

  name(e) { return entryName(e, this.contactsById.get(e.contact_id)); }
  contactOf(e) { return this.contactsById.get(e.contact_id) || null; }
  litterName(id) { const l = this.litters.find((x) => x.id === id); return l ? litterLabel(l, this.dogsById) : 'a litter'; }
  pupName(id) { return this.dogsById.get(id)?.call_name || 'the pup'; }
  canEmail(e) { return kennelEmailsOn(this.kennel) && Boolean(familyEmail(e, this.contactOf(e))); }
  // The waitlist families' open sales (for extras payments due).
  familySales() {
    const buyers = new Set(this.entries.map((e) => e.contact_id).filter(Boolean));
    return this.sales.filter((s) => !s.is_archived && s.kennel_id === this.kennel.id && buyers.has(s.buyer_contact_id) && isOpenSale(s));
  }
  changeLines(res) {
    return describeOfferChanges(res || {}, {
      nameOf: (id) => (this.entriesById.get(id) ? this.name(this.entriesById.get(id)) : 'the next family'),
      litterOf: (id) => this.litterName(id), fmtDate
    });
  }
  byStep(step) { return this.items.filter((n) => STEP_OF[readNudgeKey(n.key).kind] === step); }

  // What each step has now.
  async counts() {
    await this.load();
    const requests = {};
    let messages = 0;
    for (const n of this.byStep('requests')) {
      const r = readNudgeKey(n.key);
      const e = this.entriesById.get(r.entryId);
      if (r.kind === 'waitlist-messages') { messages += (e?.messages || []).filter((m) => !m.read && m.kind === 'message').length || 1; continue; }
      const kind = { 'waitlist-pause-request': 'pause', 'waitlist-pref-request': 'pref', 'waitlist-listen-request': 'listen', 'waitlist-companion-request': 'companion' }[r.kind];
      if (kind) { requests[kind] = (requests[kind] || 0) + 1; continue; }
      if (r.kind === 'waitlist-extra-request') {
        const req = pendingExtraRequests(e).find((x) => x.id === r.requestId);
        const k = req?.kind === 'cancel' ? 'extraCancel' : 'extra';
        requests[k] = (requests[k] || 0) + 1;
      } else if (r.kind === 'waitlist-pickup-request') {
        const req = pendingPickupRequests(e).find((x) => x.id === r.requestId);
        const k = req?.kind === 'address' ? 'address' : 'pickup';
        requests[k] = (requests[k] || 0) + 1;
      }
    }
    const picks = this.byStep('picks').filter((n) => !this.snoozed(n.key)).map((n) => this.litterName(readNudgeKey(n.key).litterId));
    const next = await actions.previewNextTurn(this.kennel.id, { today: this.today });
    return {
      requests, messages,
      backOuts: this.byStep('backouts').length,
      overdue: this.byStep('overdue').length,
      picks,
      turns: next ? 1 : 0,
      applications: this.entries.filter((e) => e.status === 'applied').length,
      fees: this.entries.filter((e) => e.status === 'approved' && !e.fee_received_date).length,
      extrasDue: this.extras.length,
      ready: this.items.filter((n) => readNudgeKey(n.key).kind === 'waitlist-ready-overdue').length,
      removals: this.items.filter((n) => readNudgeKey(n.key).kind === 'waitlist-removed').length
    };
  }
  snoozed(key) { const u = snoozedUntil(key); return Boolean(u && u > this.today); }

  // "Here's what's waiting on you" → Start with the first / Pick one / Not now.
  async overview(first) {
    const c = await this.counts();
    const summary = reviewSummary(c);
    if (!summary) {
      await this.chat.say(first ? 'Nothing on your waitlist is waiting on you right now. Your families are all taken care of!' : `That's everything on your waitlist for today.${this.skipped ? ` I left ${plural(this.skipped, 'thing')} for later.` : ''}`);
      return this.onExit('done');
    }
    await this.chat.say(first ? esc(summary) : `${esc(summary.replace('Here\'s what\'s waiting on you', 'Still waiting'))}`, { typing: 900 });
    const steps = this.stepChoices(c);
    const pick = await this.chat.choose([
      { label: first ? 'Start with the first' : 'Keep going', value: '__all', primary: true },
      ...(steps.length > 1 ? [{ label: 'Pick one', value: '__pick' }] : []),
      { label: 'Not now', value: '__no' }
    ]);
    if (pick === '__no') {
      await this.chat.say('No problem. Everything stays on Today until you get to it.');
      return this.onExit('done');
    }
    if (pick === '__pick') {
      await this.chat.say('<strong>Which one?</strong>');
      const step = await this.chat.choose([...steps, { label: 'Never mind', value: '__none' }]);
      if (step !== '__none') await this.runStep(step);
      return this.overview(false);
    }
    // Each step in order, rechecked as it comes: one step can make work for a later
    // one (a pass makes a turn to offer; an approval makes a fee to check).
    for (const s of REVIEW_STEPS) {
      if (this.stepChoices(await this.counts()).some((x) => x.value === s)) await this.runStep(s);
    }
    await this.chat.say(`That's everything on your waitlist for today.${this.skipped ? ` I left ${plural(this.skipped, 'thing')} for later; it's all still on Today.` : ''} Nice work keeping your families looked after!`);
    return this.onExit('done');
  }

  stepChoices(c) {
    const reqTotal = Object.values(c.requests).reduce((t, v) => t + v, 0) + c.messages;
    return [
      reqTotal && { label: 'Family requests and messages', note: plural(reqTotal, 'item'), value: 'requests' },
      { label: 'Backing out, and sales to cancel or void', note: c.backOuts ? plural(c.backOuts, 'family', 'families') : 'Any sale', value: 'backouts' },
      c.overdue && { label: 'Offers past their deadline', note: String(c.overdue), value: 'overdue' },
      c.picks.length && { label: 'Picks to open', note: c.picks.join(', '), value: 'picks' },
      c.turns && { label: 'A turn to offer', value: 'turns' },
      c.applications && { label: 'New applications', note: String(c.applications), value: 'applications' },
      (c.fees || c.extrasDue) && { label: 'Fees and payments to check', note: String(c.fees + c.extrasDue), value: 'fees' },
      (c.ready || c.removals) && { label: '"Ready now?" and removals', note: String(c.ready + c.removals), value: 'upkeep' }
    ].filter(Boolean);
  }

  async runStep(step) {
    await this.load();
    const run = {
      requests: () => this.requests(), backouts: () => this.backOuts(), overdue: () => this.overdue(), picks: () => this.picks(),
      turns: () => this.turns(), applications: () => this.applications(), fees: () => this.fees(), upkeep: () => this.upkeep()
    }[step];
    if (run) await run();
  }

  // Run a nudge action as Today does: its message, then its emails.
  async runNudgeAction(action) {
    try {
      const report = await action.run();
      if (report?.message) await this.chat.say(esc(report.message).replace(/\n\n/g, '<br><br>'));
      else await this.chat.say('Done.');
      if (report?.emails?.length) await this.emails(report.emails);
    } catch (err) {
      await this.chat.say(`That didn't work: ${esc(err.message || String(err))}`);
    }
  }

  // "Email the family?" (waitlistEmailUI.offerEmails): shown only where they can be emailed.
  async emails(specs) {
    if (!specs.length) return;
    const { offerEmails } = await import('./waitlistEmailUI.js');
    await offerEmails(specs);
  }

  // Leaving Kels for a page: said first, then opened.
  async openPage(href, what) {
    await this.chat.say(`Opening ${esc(what)}. I'll be here when you come back.`);
    location.href = href;
    return new Promise(() => {});
  }
  entryHref(e) { return `waitlist-entry.html?id=${encodeURIComponent(e.id)}`; }

  // --- 1. Family requests and messages -------------------------------------------------

  async requests() {
    // One family at a time, messages first, all that family's items together.
    const items = this.byStep('requests');
    const families = [...new Set(items.map((n) => readNudgeKey(n.key).entryId))];
    for (const id of families) {
      const mineItems = items.filter((n) => readNudgeKey(n.key).entryId === id)
        .sort((a, b) => (readNudgeKey(a.key).kind === 'waitlist-messages' ? -1 : 0) - (readNudgeKey(b.key).kind === 'waitlist-messages' ? -1 : 0));
      for (const n of mineItems) {
        await this.load();
        const e = this.entriesById.get(id);
        if (!e) break;
        const r = readNudgeKey(n.key);
        if (r.kind === 'waitlist-messages') await this.message(n, e);
        else if (r.kind === 'waitlist-extra-request') await this.extraRequest(n, e, r.requestId);
        else if (r.kind === 'waitlist-pickup-request') await this.pickupRequest(n, e, r.requestId);
        else await this.simpleRequest(n);
      }
    }
  }

  // A request decided by the nudge's own actions (pause, answers, litters, Companion link).
  async simpleRequest(n) {
    await this.chat.say(`<strong>${esc(n.title)}</strong><br>${esc(n.detail || '')}`);
    const pick = await this.chat.choose([...n.actions.map((a, i) => ({ label: a.label, value: String(i), primary: i === 0 })), SKIP]);
    if (pick === '__skip') { this.skipped++; return; }
    const action = n.actions[Number(pick)];
    if (action.label === 'Open Companion') return this.openPage('companion.html?type=family', 'the Companion page');
    await this.runNudgeAction(action);
  }

  async message(n, e) {
    const unread = (e.messages || []).filter((m) => !m.read);
    const words = unread.filter((m) => m.kind === 'message');
    await this.chat.say(words.length
      ? `<strong>${esc(this.name(e))} wrote on their status page</strong><br>${words.slice(-3).map((m) => `${m.date ? `<span class="faint">${esc(fmtDate(m.date))}</span> ` : ''}${esc(m.body)}`).join('<br>')}`
      : `<strong>${esc(this.name(e))} did something on their status page</strong><br>${unread.slice(-3).map((m) => esc(m.body)).join('<br>')}`);
    const pick = await this.chat.choose([
      ...(words.length ? [{ label: 'Write back', value: 'write', primary: true }] : []),
      { label: 'Mark read', value: 'read', primary: !words.length },
      ...(words.length ? [{ label: 'Open their page', value: 'open' }] : []),
      SKIP
    ]);
    if (pick === '__skip') { this.skipped++; return; }
    if (pick === 'open') return this.openPage(this.entryHref(e), 'their page');
    if (pick === 'write') {
      const { communicateDialog } = await import('./waitlistEmailUI.js');
      const c = this.contactOf(e);
      await communicateDialog({ entryId: e.id, name: this.name(e), phone: c?.phone || e.application?.phone || '', emails: this.canEmail(e) ? [{ kind: 'note', label: 'A note from you' }] : [] });
    }
    await actions.markMessagesRead(e.id);
    await this.chat.say(pick === 'write' ? 'Marked read.' : 'Marked read.');
  }

  async extraRequest(n, e, requestId) {
    const r = pendingExtraRequests(e).find((x) => x.id === requestId);
    if (!r) return;
    const cancel = r.kind === 'cancel';
    await this.chat.say(`<strong>${esc(n.title)}</strong><br>${esc(n.detail || '')}`);
    const pick = await this.chat.choose([{ label: 'Approve', value: 'yes', primary: true }, { label: 'Decline', value: 'no' }, { label: 'Open their page', value: 'open' }, SKIP]);
    if (pick === '__skip') { this.skipped++; return; }
    if (pick === 'open') return this.openPage(this.entryHref(e), 'their page');
    const emails = (kind) => [{ entryId: e.id, kind, extra: { request: { field: 'extra_request', request: r } } }];
    if (pick === 'no') {
      await actions.declineExtraRequest(e.id, r.id, { date: this.today });
      await this.chat.say('Declined. Nothing changed on their sale.');
      return this.emails(emails('request_declined'));
    }
    // A cancel: the training stays linked to it, before it goes.
    let staysBefore = [];
    if (cancel) {
      const sale = familySale(e, this.sales, this.offers, this.entries);
      const charge = sale ? (sale.extra_charges || []).find((c) => c.id === r.charge_id) : null;
      if (sale?.dog_id && charge) staysBefore = trainingStaysFor(sale, charge, await eventRepo.getForSubject('dog', sale.dog_id)).filter((s) => (s.event_date || '') >= this.today);
    }
    let res;
    try {
      res = await actions.approveExtraRequest(e.id, r.id, { date: this.today });
    } catch (err) {
      await this.chat.say(`I couldn't approve that: ${esc(err.message || String(err))}`);
      const next = await this.chat.choose([{ label: 'Decline it', value: 'no' }, { label: 'Open the sale', value: 'sale' }, SKIP]);
      if (next === 'no') { await actions.declineExtraRequest(e.id, r.id, { date: this.today }); await this.emails(emails('request_declined')); }
      else if (next === 'sale') { const s = familySale(e, this.sales, this.offers, this.entries); if (s) return this.openPage(`sale.html?id=${encodeURIComponent(s.id)}`, 'the sale'); }
      else this.skipped++;
      return;
    }
    await this.chat.say(cancel ? `${esc(r.name)} is off their sale.` : `${esc(r.name)} is on their sale${res.charge?.payments ? ', with its payment plan' : ''}.`);
    await this.emails(emails('request_approved'));
    if (cancel) {
      for (const stay of staysBefore) {
        await this.chat.say(`Remove the training stay too? ${esc(stay.title || 'The stay')}, ${esc(fmtDate(stay.event_date))}${stay.event_end_date ? ` to ${esc(fmtDate(stay.event_end_date))}` : ''}.`);
        if ((await this.chat.choose([{ label: 'Remove it', value: 'yes', primary: true }, { label: 'Keep it', value: 'no' }])) === 'yes') {
          await eventRepo.archive(stay.id);
          await this.chat.say('Removed.');
        }
      }
      return;
    }
    if (res.boardingDays && res.sale?.dog_id && res.charge) {
      const dog = await dogRepo.getById(res.sale.dog_id);
      const litter = dog?.litter_id ? await litterRepo.getById(dog.litter_id) : null;
      const stay = trainingStayEvent(dog, res.sale, res.charge, defaultStart(readyDateOf(litter), this.today));
      await this.chat.say(`Log ${esc(dog?.call_name || 'the pup')}'s ${res.boardingDays}-day training stay from ${esc(fmtDate(stay.event_date))}?`);
      if ((await this.chat.choose([{ label: 'Log it', value: 'yes', primary: true }, { label: 'Later', value: 'no' }])) === 'yes') {
        await eventRepo.create(stay);
        await this.chat.say(`Logged, ${esc(fmtDate(stay.event_date))} to ${esc(fmtDate(stay.event_end_date))}. You can change the dates on ${esc(dog?.call_name || 'the pup')}'s page.`);
      } else {
        await this.chat.say('Okay, Today will remind you.');
      }
    }
  }

  async pickupRequest(n, e, requestId) {
    const r = pendingPickupRequests(e).find((x) => x.id === requestId);
    if (!r) return;
    const emails = (kind, extra = {}) => [{ entryId: e.id, kind, extra: { request: { field: 'pickup_request', request: r }, ...extra } }];
    await this.chat.say(`<strong>${esc(n.title)}</strong>${n.detail ? `<br>${esc(n.detail)}` : ''}`);
    if (r.kind === 'address') {
      const far = Boolean(r.far);
      const pick = await this.chat.choose([
        ...(far ? [{ label: 'Send transport options', value: 'options', primary: true }] : [{ label: 'Set it up', value: 'setup', primary: true }]),
        { label: 'Open their page', value: 'open' }, { label: 'Decline', value: 'no' }, SKIP
      ]);
      if (pick === '__skip') { this.skipped++; return; }
      if (pick === 'open') return this.openPage(this.entryHref(e), 'their page');
      if (pick === 'options') return this.emails([{ entryId: e.id, kind: 'transport_options', extra: Number.isFinite(r.miles) ? { distance: r.miles } : {} }]);
      if (pick === 'no') {
        await actions.declinePickupRequest(e.id, r.id, { date: this.today });
        await this.chat.say('Declined. Nothing changed.');
        return this.emails(emails('request_declined'));
      }
      // No standard pickup location or fee per mile yet: set them up first, so the
      // miles and the fee can be worked out (Set up my waitlist's same screen).
      if (!standardLocation(this.kennel) || !(Number(this.config.mileage_rate) > 0)) {
        await this.chat.say(`${standardLocation(this.kennel) ? 'You haven\'t set a fee per mile' : 'You haven\'t set your standard pickup location (where the miles start)'} yet. Set up pickup and transport now?`);
        if ((await this.chat.choose([{ label: 'Set it up', value: 'yes', primary: true }, { label: 'Not now, I\'ll type the fee', value: '' }])) === 'yes') {
          const { askPickupTransport } = await import('./pickupTransportStep.js');
          await askPickupTransport(this.chat, this.kennel);
          await this.load();
        }
      }
      const res = await this.addressForm(e, r);
      if (!res.done) { this.skipped++; return; }
      await this.chat.say('It\'s on the pup\'s calendar as their drop-off, with the fee on their sale.');
      return this.emails(emails('request_approved'));
    }
    const pick = await this.chat.choose([{ label: 'Approve', value: 'yes', primary: true }, { label: 'Decline', value: 'no' }, SKIP]);
    if (pick === '__skip') { this.skipped++; return; }
    if (pick === 'no') {
      await actions.declinePickupRequest(e.id, r.id, { date: this.today });
      await this.chat.say('Declined. Nothing changed.');
      return this.emails(emails('request_declined'));
    }
    const res = await actions.approvePickupRequest(e.id, r.id, { date: this.today });
    const board = res.boarding ? ` Standard boarding applies: ${plural(res.boarding.days, 'day')}, ${fmtMoney(res.boarding.amount)}, on their sale and logged as a stay.` : '';
    await this.chat.say(esc(`${r.kind === 'cancel' ? 'Their pickup is off the calendar.' : 'It\'s on the pup\'s calendar as their pickup.'}${board}`));
    await this.emails(emails('request_approved'));
    if (res.boardingKept) {
      const b = res.boardingKept;
      await this.chat.say(`This date has standard boarding (${plural(b.days, 'day')}, ${esc(fmtMoney(b.amount))}), but their sale already has your own boarding charge, so I kept yours. Use standard boarding instead?`);
      if ((await this.chat.choose([{ label: `Use it, ${fmtMoney(b.amount)}`, value: 'yes' }, { label: 'Keep mine', value: 'no', primary: true }])) === 'yes') {
        await actions.applyPickupBoarding(res.sale.id, b, b.rate);
        await this.chat.say('Done.');
      }
    }
    if (res.transportFeeLeft) {
      await this.chat.say(`Their sale still has a ${esc(fmtMoney(res.transportFeeLeft))} transport fee from an earlier drop-off plan. Remove it?`);
      if ((await this.chat.choose([{ label: 'Remove it', value: 'yes', primary: true }, { label: 'Keep it', value: 'no' }])) === 'yes') {
        await actions.clearTransportFee(res.sale.id);
        await this.chat.say('Removed.');
      }
    }
  }

  // Their own address, set up in the chat (decided 2026-11-01): the day, time, how,
  // the miles and the fee (transportQuote's working), saved as their page saves it.
  addressForm(e, r) {
    const config = this.config;
    const from = standardLocation(this.kennel)?.address || '';
    const sale = familySale(e, this.sales, this.offers, this.entries);
    const current = Number(sale?.transport_fee) > 0 ? Number(sale.transport_fee) : null;
    const miles0 = Number.isFinite(r.miles) ? r.miles : null;
    const quote = (m) => (m != null ? transportQuote(m, config) : null);
    return this.chat.form({
      title: `<strong>${esc(this.name(e))}'s drop-off</strong><span class="kels-lead">${esc(r.address || '')}</span>`,
      html: `<div class="ck-inline">
          ${field('Day', `<input id="wr-date" type="date" value="${esc(r.date || '')}">`)}
          ${field('Time', '<input id="wr-time" type="text" placeholder="e.g. 2:00 PM">')}
        </div>
        ${field('How', `<select id="wr-method">${PLACEMENT_METHODS.map((m) => `<option${m === 'Ground transport' ? ' selected' : ''}>${esc(m)}</option>`).join('')}</select>`)}
        ${field('Miles, one way', `<input id="wr-miles" type="number" min="0" step="0.1" value="${miles0 ?? ''}">${from ? ' <button type="button" class="gl-more" id="wr-measure">Get driving miles</button>' : ''}`)}
        ${field('Transport fee', `<input id="wr-fee" type="number" min="0" step="0.01" value="${current ?? (quote(miles0)?.fee ?? '')}">`, current != null ? `On the sale now: ${fmtMoney(current)}. Saving uses what's in the box.` : '')}
        <p class="field-hint" id="wr-working">${esc(quote(miles0)?.text || '')}</p>`,
      wire: (root) => {
        const refresh = () => {
          const v = root.querySelector('#wr-miles').value;
          const q = quote(v === '' ? null : Number(v));
          root.querySelector('#wr-working').textContent = q?.text || '';
          if (current == null && q?.fee != null) root.querySelector('#wr-fee').value = q.fee;
        };
        root.querySelector('#wr-miles').addEventListener('change', refresh);
        root.querySelector('#wr-measure')?.addEventListener('click', async (ev) => {
          ev.target.disabled = true;
          try {
            const { drivingMiles } = await import('../data/cloud/cloudWaitlist.js');
            root.querySelector('#wr-miles').value = (await drivingMiles(from, r.address)).miles;
            refresh();
          } catch (err) {
            root.querySelector('#wr-working').textContent = `Couldn't measure: ${err.code === 'geo_off' ? 'miles aren\'t switched on yet' : err.code === 'not_found' ? 'the address wasn\'t found' : err.message}. Type the miles instead.`;
          }
          ev.target.disabled = false;
        });
      },
      submitLabel: 'Approve',
      cancelLabel: 'Not now',
      submit: async (root) => {
        const when = root.querySelector('#wr-date').value;
        if (!when) return 'Which day?';
        await actions.approvePickupRequest(e.id, r.id, {
          when, time: root.querySelector('#wr-time').value.trim(), method: root.querySelector('#wr-method').value, fee: root.querySelector('#wr-fee').value
        });
        return { when };
      },
      reply: (x) => `Drop-off ${fmtDate(x.when)}`
    });
  }

  // --- 2. Backing out, then sales to cancel or void ------------------------------------

  async backOuts() {
    for (const n of this.byStep('backouts')) {
      await this.load();
      const e = this.entriesById.get(readNudgeKey(n.key).entryId);
      if (!e || !actions.hasPendingRequest(e, 'back_out_request')) continue;
      const req = e.back_out_request;
      const sale = familySale(e, this.sales, this.offers, this.entries);
      const pup = sale?.dog_id ? this.dogsById.get(sale.dog_id) : null;
      const litter = pup?.litter_id ? this.litters.find((l) => l.id === pup.litter_id) : null;
      const weeks = litter?.whelp_date ? Math.floor((Date.parse(this.today) - Date.parse(litter.whelp_date)) / (7 * 86400000)) : null;
      const suggested = suggestOutcome(this.config, req.reason?.id, weeks) || 'keep';
      await this.chat.say(`<strong>${esc(this.name(e))} asked to back out${pup ? ` of ${esc(pup.call_name || 'their pup')}` : ''}</strong> (${esc(fmtDate(req.requested_date))}).<br>Their reason: ${esc(req.reason?.label || 'not given')}${req.reason?.text ? `: "${esc(req.reason.text)}"` : ''}.<br>Your policy suggests ${suggested === 'move' ? 'moving the deposit to their next pup' : 'keeping the deposit'}${weeks != null ? ` (${pup?.sex === 'female' ? 'she\'s' : 'he\'s'} ${weeks} weeks)` : ''}.`);
      const pick = await this.chat.choose([
        { label: 'Keep the deposit', value: 'keep', primary: suggested === 'keep' },
        { label: 'Move the deposit', value: 'move', primary: suggested === 'move' },
        { label: 'More options…', value: 'more' },
        { label: 'Decline', value: 'decline' },
        SKIP
      ]);
      if (pick === '__skip') { this.skipped++; continue; }
      if (pick === 'decline') {
        await actions.declineBackOut(e.id, { date: this.today });
        await this.chat.say('Declined. Their sale stays as it is; let them know why.');
        await this.emails([{ entryId: e.id, kind: 'request_declined', extra: { request: { field: 'back_out_request', request: req } } }]);
        continue;
      }
      let outcome = pick;
      if (pick === 'more') {
        await this.chat.say('Refunding voids the sale, so their deposit won\'t count as income.');
        if ((await this.chat.choose([{ label: 'Refund their deposit', value: 'refund' }, { label: 'Back', value: '__back' }])) === '__back') { this.skipped++; continue; }
        outcome = 'refund';
      }
      await this.backOutForm(e, outcome, { request: req });
    }
    await this.otherSales();
  }

  // What comes off with the sale and the pup back, then Do it (approveBackOut).
  // `request`: their pending request; `told`: she heard some other way.
  async backOutForm(e, outcome, { request = null, told = null } = {}) {
    const sale = familySale(e, this.sales, this.offers, this.entries);
    if (!sale) { await this.chat.say('They have no open sale to back out of any more.'); return null; }
    const items = backOutItems({ sale, events: sale.dog_id ? await eventRepo.getForSubject('dog', sale.dog_id) : [], today: this.today });
    const deposit = Number(sale.deposit_amount) || 0;
    const pupName = this.pupName(sale.dog_id);
    const healthReason = request?.reason?.id === 'pup';
    let res = null;
    const done = await this.chat.form({
      title: `<strong>${esc({ keep: 'Cancel the sale, keep the deposit', move: 'Cancel the sale, move the deposit', refund: 'Refund their deposit' }[outcome])}</strong>${outcome === 'move' ? '<span class="kels-lead">They go back on your list at the end of the line, with their application, fee and history. Their deposit goes toward their next pup.</span>' : ''}`,
      html: `${items.length ? `<p class="gl-q">What comes off with the sale? Extras you leave unticked stay on it, still owed.</p>
          <div class="ck-checks">${items.map((it, i) => `<label class="ck-check"><input type="checkbox" class="wr-bo" data-i="${i}"${it.remove ? ' checked' : ''}> <strong>${esc(it.label)}</strong> <span class="faint">${esc(it.kind === 'charge' ? `extra, ${it.detail}` : it.detail)}</span></label>`).join('')}</div>` : ''}
        <label class="ck-check"><input type="checkbox" id="wr-pup" checked> Put ${esc(pupName)} back to <select id="wr-pup-to"><option value="available"${healthReason ? '' : ' selected'}>Available</option><option value="health_hold"${healthReason ? ' selected' : ''}>Health hold</option></select></label>
        <p class="field-hint" id="wr-bo-sum"></p>
        ${outcome === 'refund' ? field('Type REFUND to confirm', '<input id="wr-refund" type="text" autocomplete="off">') : ''}`,
      wire: (root) => {
        const sum = () => {
          const picked = items.map((it, i) => ({ ...it, remove: root.querySelector(`.wr-bo[data-i="${i}"]`).checked }));
          root.querySelector('#wr-bo-sum').textContent = `${backOutSummary(outcome, { deposit, items: picked, money: fmtMoney })}.`;
        };
        root.querySelectorAll('.wr-bo').forEach((c) => c.addEventListener('change', sum));
        sum();
      },
      submitLabel: 'Do it',
      cancelLabel: 'Back',
      submit: async (root) => {
        if (outcome === 'refund' && root.querySelector('#wr-refund').value.trim() !== 'REFUND') return 'Type REFUND to confirm.';
        const remove = [...root.querySelectorAll('.wr-bo:checked')].map((c) => items[Number(c.dataset.i)].id);
        const pup = root.querySelector('#wr-pup').checked ? root.querySelector('#wr-pup-to').value : null;
        res = await actions.approveBackOut(e.id, { outcome, remove, pup, date: this.today, ...(told ? { told } : {}) });
        return { pup };
      },
      reply: () => ({ keep: 'Keep the deposit', move: 'Move the deposit', refund: 'Refund it' }[outcome])
    });
    if (!done.done) { this.skipped++; return null; }
    await this.load();
    const changes = this.changeLines(res);
    await this.chat.say(lines([`Done. ${outcome === 'move' ? `${this.name(e)} is back on the list at the end of the line.` : `${this.name(e)}'s sale is ${outcome === 'refund' ? 'voided and refunded' : 'cancelled'}.`}`, ...changes]));
    await this.emails([
      ...(request ? [{ entryId: e.id, kind: 'request_approved', extra: { request: { field: 'back_out_request', request } } }] : []),
      ...offerSpecs(res)
    ]);
    if (done.result.pup === 'available') await this.offerPupOnward(sale.dog_id);
    return res;
  }

  // A pup back to Available: "Offer [pup] to the next family?" (the turn step, now).
  async offerPupOnward(dogId) {
    await this.load();
    const next = await actions.previewNextTurn(this.kennel.id, { today: this.today });
    if (!next) return;
    await this.chat.say(`Offer ${esc(this.pupName(dogId))} to the next family?`);
    if ((await this.chat.choose([{ label: 'Yes', value: 'yes', primary: true }, { label: 'Not yet', value: 'no' }])) === 'yes') await this.turns();
  }

  // "Do you need to cancel or void any other sales?": asked every time.
  async otherSales() {
    for (let first = true; ; first = false) {
      await this.load();
      const sales = this.sales.filter((s) => !s.is_archived && s.kennel_id === this.kennel.id && (isOpenSale(s) || s.status === 'delivered'))
        .sort((a, b) => (isOpenSale(b) ? 1 : 0) - (isOpenSale(a) ? 1 : 0) || (b.sale_date || '').localeCompare(a.sale_date || ''));
      if (!sales.length) return;
      await this.chat.say(first ? 'Do you need to cancel or void any other sales? For example a family backed out, or a pup died or can\'t go home.' : 'Any other sales to cancel or void?');
      if ((await this.chat.choose([{ label: 'Yes', value: 'yes' }, { label: first ? 'No' : 'No, that\'s all', value: 'no', primary: true }])) === 'no') return;
      const buyer = (s) => this.contactsById.get(s.buyer_contact_id)?.name || 'No buyer';
      await this.chat.say('<strong>Which sale?</strong>');
      const id = await this.chat.choose([
        ...sales.map((s) => ({ label: `${this.pupName(s.dog_id)}: ${buyer(s)}`, note: `${this.dogsById.get(s.dog_id)?.litter_id ? this.litterName(this.dogsById.get(s.dog_id).litter_id) : ''}${s.status === 'delivered' ? ' · gone home' : ''}`, value: s.id })),
        { label: 'Never mind', value: '' }
      ], { search: sales.length > 8 ? { placeholder: 'Find a pup or family' } : null });
      if (!id) continue;
      await this.endSale(sales.find((s) => s.id === id));
    }
  }

  async endSale(sale) {
    const pup = this.pupName(sale.dog_id);
    const delivered = sale.status === 'delivered';
    await this.chat.say(`<strong>What happened with ${esc(pup)}'s sale?</strong>`);
    const what = await this.chat.choose([
      ...(delivered ? [{ label: 'The pup came back after going home', value: 'returned' }] : [
        { label: 'The family backed out', value: 'backed_out' },
        { label: 'The pup died', value: 'pup_died' },
        { label: 'The pup failed a health check', value: 'failed_health_check' }
      ]),
      { label: 'Something else', value: 'other' },
      { label: 'Never mind', value: '' }
    ]);
    if (!what) return;
    if (what === 'backed_out') {
      const entry = this.entries.find((e) => e.contact_id && e.contact_id === sale.buyer_contact_id && familySale(e, this.sales, this.offers, this.entries)?.id === sale.id);
      if (entry) {
        await this.chat.say(`${esc(this.name(entry))} is on your waitlist, so let's handle it the same way as a back-out request. What happens to their deposit?`);
        const outcome = await this.chat.choose([{ label: 'Keep the deposit', value: 'keep', primary: true }, { label: 'Move the deposit', value: 'move' }, { label: 'Refund their deposit', value: 'refund' }, { label: 'Never mind', value: '' }]);
        if (outcome) await this.backOutForm(entry, outcome, { told: { reason: { id: 'told', label: 'They told you' } } });
        return;
      }
      return this.saveEnd(sale, { status: 'cancelled' }, 'Cancelled. Their deposit stays as income.');
    }
    if (what === 'returned') {
      await this.chat.say('Why did they bring the pup back?');
      const why = await this.chat.choose([{ label: 'A health problem (within the guarantee)', value: 'health_problem' }, { label: 'The family\'s choice', value: 'buyer_choice' }, { label: 'Never mind', value: '' }]);
      if (why) await this.saveEnd(sale, { status: 'returned', end_reason: why }, 'Marked returned.');
      return;
    }
    if (what === 'other') {
      await this.chat.say('Cancel it (they backed out: a deposit stays income) or void it (it shouldn\'t count at all)?');
      const kind = await this.chat.choose([{ label: 'Cancel', value: 'cancelled' }, { label: 'Void', value: 'voided' }, { label: 'Never mind', value: '' }]);
      if (!kind) return;
      const res = await this.chat.form({
        title: '<strong>What happened?</strong>',
        html: field('In a few words', '<input id="wr-why" type="text" autocomplete="off">'),
        submitLabel: kind === 'voided' ? 'Void it' : 'Cancel it',
        cancelLabel: 'Never mind',
        submit: async (root) => ({ note: root.querySelector('#wr-why').value.trim() }),
        reply: (r) => r.note || 'Other'
      });
      if (!res.done) return;
      const changes = kind === 'voided' ? { status: 'voided', end_reason: delivered ? 'other' : 'other', end_note: res.result.note || null } : { status: 'cancelled', ...(res.result.note ? { notes: sale.notes ? `${sale.notes}\n${res.result.note}` : res.result.note } : {}) };
      if (delivered && kind === 'voided') Object.assign(changes, { status: 'returned' });
      return this.saveEnd(sale, changes, kind === 'voided' ? 'Voided.' : 'Cancelled.');
    }
    return this.saveEnd(sale, { status: 'voided', end_reason: what }, 'Voided: nothing on it counts as income.');
  }

  // Saved through the Sale page's own path: the status and reason, then the pup
  // (salePrompts: record its death, Health hold…), then the family's place back.
  async saveEnd(sale, changes, said) {
    const saved = await saleRepo.update(sale.id, changes);
    await this.chat.say(esc(said));
    const { promptReleasedPup } = await import('./salePrompts.js');
    await promptReleasedPup(saved, { onError: (m) => this.chat.say(esc(m)) });
    if (restoresFamily(saved)) {
      const { restoreLostPupDialog } = await import('./waitlistUI.js');
      await restoreLostPupDialog({ saleId: saved.id, asStatus: sale.status });
    }
    const dog = await dogRepo.getById(saved.dog_id);
    if (dog && dog.status !== 'deceased' && dog.disposition === 'available') await this.offerPupOnward(dog.id);
  }

  // --- 3. Offers past their deadline ------------------------------------------------------

  async overdue() {
    for (const n of this.byStep('overdue')) {
      await this.load();
      const turnId = readNudgeKey(n.key).turnId;
      const turn = this.offers.filter((o) => !o.is_archived && o.outcome === 'open' && turnIdOf(o) === turnId);
      if (!turn.length) continue;
      const e = this.entriesById.get(turn[0].entry_id);
      if (!e) continue;
      const picked = turn.find((o) => o.chosen_dog_id);
      await this.chat.say(`<strong>${esc(n.title)}</strong><br>${esc(n.detail || '')}`);
      const pick = await this.chat.choose([
        { label: picked ? 'The deposit came' : 'They picked', value: 'picked' },
        { label: 'Count it as a pass', value: 'pass' },
        { label: picked ? 'Record no deposit' : 'Record no response', value: 'none' },
        { label: 'Give them more time', value: 'time' },
        SKIP
      ]);
      if (pick === '__skip') { this.skipped++; continue; }
      if (pick === 'none') { await this.runNudgeAction(n.actions[0]); continue; }
      if (pick === 'time') { await this.moreTime(turnId, turn[0].respond_by_date, e); continue; }
      if (pick === 'pass') {
        const res = await actions.recordOutcome(turn[0].id, 'passed', { date: this.today });
        await this.load();
        await this.chat.say(lines(outcomeReport(res, { name: this.name(e), changes: this.changeLines(res) })));
        await this.emails(offerSpecs(res));
        continue;
      }
      await this.theyPicked(e, turn, picked);
    }
  }

  async moreTime(turnId, was, e) {
    const res = await this.chat.form({
      title: `<strong>More time for ${esc(this.name(e))}</strong><span class="kels-lead">They had until ${esc(fmtDate(was))}.</span>`,
      html: field('New deadline', `<input id="wr-until" type="date" value="${esc(addDaysToYMD(this.today, Number(this.config.respond_days) || 3))}">`),
      submitLabel: 'Give them more time',
      cancelLabel: 'Never mind',
      submit: async (root) => {
        // A string from submit is shown as the form's error, so the date goes back in an object.
        try { return { until: (await actions.extendTurn(turnId, { until: root.querySelector('#wr-until').value, date: this.today })).respond_by_date }; } catch (err) { return err.message; }
      },
      reply: (r) => `Until ${fmtDate(r.until)}`
    });
    if (!res.done) { this.skipped++; return; }
    await this.chat.say(`${esc(this.name(e))} has until ${esc(fmtDate(res.result.until))} now. Let them know.`);
    await this.emails([{ entryId: e.id, kind: 'offer', extra: { litterIds: this.offers.filter((o) => turnIdOf(o) === turnId).map((o) => o.litter_id), respondBy: res.result.until } }]);
  }

  // Their pick and deposit, through the family page's own dialogs.
  async theyPicked(e, turn, picked) {
    const { pickDialog, depositDialog } = await import('./waitlistUI.js');
    const sexWord = (d) => descriptor(SEX, d.sex)?.label || '';
    const pupLabel = (d) => `${d.call_name || 'Pup'}${sexWord(d) ? ` (${sexWord(d)})` : ''}`;
    if (picked) {
      const res = await depositDialog({ offer: picked, name: this.name(e), pupName: this.pupName(picked.chosen_dog_id), sale: this.sales.find((s) => s.id === picked.sale_id) || null, carried: e.carried_payment || null });
      if (!res) { this.skipped++; return; }
      await this.load();
      await this.chat.say(lines([`${this.name(e)} is placed with ${this.pupName(picked.chosen_dog_id)}.`, ...this.changeLines(res)]));
      return this.emails(offerSpecs(res));
    }
    let offer = turn[0];
    if (turn.length > 1) {
      await this.chat.say('<strong>From which litter?</strong>');
      const id = await this.chat.choose(turn.map((o) => ({ label: this.litterName(o.litter_id), value: o.id })));
      offer = turn.find((o) => o.id === id);
    }
    const litter = this.litters.find((l) => l.id === offer.litter_id);
    const pups = litter ? eligiblePupsFor(e, litter, this.dogs.filter((d) => d.litter_id === litter.id), this.sales, { today: this.today, config: this.config }) : [];
    if (!pups.length) { await this.chat.say('None of the pups offered to them is still available.'); return; }
    const out = await pickDialog({ offer, name: this.name(e), pups, pupLabel, carried: e.carried_payment || null });
    if (!out) { this.skipped++; return; }
    await this.load();
    await this.chat.say(out.depositDone
      ? lines([`${this.name(e)} is placed.`, ...this.changeLines(out.res)])
      : `${esc(this.pupName(out.res.offer.chosen_dog_id))} is held for ${esc(this.name(e))} until ${esc(fmtDate(offer.respond_by_date))}. Record the deposit on their page when it arrives.`);
    if (out.depositDone) await this.emails(offerSpecs(out.res));
  }

  // --- 4. Picks to open ------------------------------------------------------------------------

  async picks() {
    for (const n of this.byStep('picks')) {
      if (this.snoozed(n.key)) continue;
      await this.load();
      const l = this.litters.find((x) => x.id === readNudgeKey(n.key).litterId);
      if (!l || l.picks_opened_date) continue;
      const avail = this.dogs.filter((d) => d.litter_id === l.id && isPupAvailable(d, this.sales));
      const girls = avail.filter((d) => d.sex === 'female').length;
      const boys = avail.filter((d) => d.sex === 'male').length;
      await this.chat.say(`You planned to start taking deposits on ${esc(litterLabel(l, this.dogsById))} ${l.accept_deposits_date === this.today ? 'today' : `on ${esc(fmtDate(l.accept_deposits_date))}`}. ${esc([girls && plural(girls, 'girl'), boys && plural(boys, 'boy')].filter(Boolean).join(' and ') || 'No pups')} ${avail.length === 1 ? 'is' : 'are'} available. Open picks?`);
      const pick = await this.chat.choose([
        { label: 'Open picks', value: 'open', primary: true },
        { label: 'Not yet, remind me in a few days', value: 'later' },
        { label: 'Change the date', value: 'date' },
        SKIP
      ]);
      if (pick === '__skip') { this.skipped++; continue; }
      if (pick === 'open') { await this.runNudgeAction(n.actions[0]); continue; }
      if (pick === 'later') {
        const until = addDaysToYMD(this.today, 3);
        snooze(n.key, until);
        await this.chat.say(`Okay, I'll remind you on ${esc(fmtDate(until))}. Your planned date stays as it is.`);
        continue;
      }
      const res = await this.chat.form({
        title: `<strong>When do you want to start taking deposits?</strong>`,
        html: field('Start taking deposits', `<input id="wr-acc" type="date" value="${esc(addDaysToYMD(this.today, 7))}">`),
        submitLabel: 'Save',
        cancelLabel: 'Never mind',
        submit: async (root) => {
          const d = root.querySelector('#wr-acc').value;
          if (!d) return 'Pick a date.';
          await litterRepo.update(l.id, { accept_deposits_date: d });
          return { date: d };
        },
        reply: (r) => fmtDate(r.date)
      });
      if (res.done) await this.chat.say(`Saved. I'll bring it up again on ${esc(fmtDate(res.result.date))}.`);
      else this.skipped++;
    }
  }

  // --- 5. A turn waiting on her ---------------------------------------------------------------

  async turns() {
    await this.load();
    const next = await actions.previewNextTurn(this.kennel.id, { today: this.today });
    if (!next) return;
    const e = next.entry;
    const since = e.fee_received_date || e.approved_date || e.applied_date;
    const months = since ? Math.max(0, Math.round((Date.parse(this.today) - Date.parse(since)) / (30.44 * 86400000))) : null;
    const prefs = prefsSummary(e).replace(/<[^>]+>/g, '');
    await this.chat.say(`Next in line for ${esc(next.litters.map((x) => litterLabel(x.litter, this.dogsById)).join(' and '))} is <strong>${esc(this.name(e))}</strong> (wants ${esc(prefs.toLowerCase())}${months != null ? `, waiting ${plural(months, 'month')}` : ''}). Offer it to them?`);
    const pick = await this.chat.choose([{ label: 'Offer it', value: 'offer', primary: true }, { label: 'Offer someone else', value: 'other' }, { label: 'Not yet', value: '__skip' }]);
    if (pick === '__skip') { this.skipped++; return; }
    if (pick === 'offer') {
      const turn = await actions.offerNextTurn(this.kennel.id, { today: this.today });
      return this.reportTurn(turn);
    }
    // Someone else: the litter, then any family it has pups for, best placed first.
    let litter = next.litters[0].litter;
    const open = this.litters.filter((l) => l.picks_opened_date && !l.is_archived);
    if (open.length > 1) {
      await this.chat.say('<strong>For which litter?</strong>');
      const id = await this.chat.choose(open.map((l) => ({ label: litterLabel(l, this.dogsById), value: l.id })));
      litter = open.find((l) => l.id === id);
    }
    const pups = this.dogs.filter((d) => d.litter_id === litter.id);
    const progs = new Map(this.programs.map((p) => [p.id, p]));
    const fits = rankedList(this.entries, this.kennel.id, progs).filter((x) => eligiblePupsFor(x, litter, pups, this.sales, { today: this.today, config: this.config }).length);
    if (!fits.length) { await this.chat.say('Nobody on the list has a pup in that litter they could take right now.'); return; }
    const pos = overallPositions(this.entries, this.kennel.id, progs);
    await this.chat.say('<strong>Who should have it?</strong>');
    const id = await this.chat.choose([...fits.map((x) => ({ label: this.name(x), note: pos.get(x.id) ? `#${pos.get(x.id)}` : '', value: x.id })), { label: 'Never mind', value: '' }],
      { search: fits.length > 8 ? { placeholder: 'Find a family' } : null });
    if (!id) { this.skipped++; return; }
    const turn = await actions.offerTo(litter.id, id, { today: this.today, note: `Offered out of order; next in line was ${this.name(e)}.` });
    return this.reportTurn(turn);
  }

  async reportTurn(turn) {
    await this.load();
    if (!turn || turn.none) {
      const passed = (turn?.auto_passed || []).length;
      await this.chat.say(`${passed ? `${plural(passed, 'family', 'families')} had already said "Not this litter", so I passed them. ` : ''}Nobody else on the list can be offered a pup right now.`);
      return;
    }
    const who = this.entriesById.get(turn.entry_id);
    const passed = (turn.auto_passed || []).length;
    await this.chat.say(`${passed ? `${plural(passed, 'family', 'families')} had already said "Not this litter", so I passed them. ` : ''}It's ${esc(who ? this.name(who) : 'the next family')}'s turn. They have until ${esc(fmtDate(turn.respond_by_date))} to pick a pup and send the deposit, or pass.`);
    await this.emails(offerSpecs({ next: turn }));
  }

  // --- 6. New applications --------------------------------------------------------------------

  async applications() {
    const ids = this.entries.filter((e) => e.status === 'applied').sort((a, b) => (a.applied_date || '').localeCompare(b.applied_date || '')).map((e) => e.id);
    const form = formQuestions(this.config);
    for (const id of ids) {
      await this.load();
      const e = this.entriesById.get(id);
      if (!e || e.status !== 'applied') continue;
      const app = e.application || {};
      const answers = entryQuestions(e, form)
        .filter((q) => !['name', 'email'].includes(q.key) && answerText(q, app[q.id]))
        .slice(0, 8)
        .map((q) => `<span class="faint">${esc(q.label)}:</span> ${esc(answerText(q, app[q.id]).slice(0, 160))}`);
      await this.chat.say(`<strong>${esc(this.name(e))}</strong> applied ${esc(fmtDate(e.applied_date))}. Wants: ${prefsSummary(e)}.${answers.length ? `<br>${answers.join('<br>')}` : ''}`, { typing: 800 });
      const pick = await this.chat.choose([
        { label: 'Approve', value: 'approve', primary: true },
        { label: 'Decline', value: 'decline' },
        { label: 'Ask a question', value: 'ask' },
        { label: 'Decide later', value: '__skip' }
      ]);
      if (pick === '__skip') { this.skipped++; continue; }
      if (pick === 'ask') {
        const { communicateDialog } = await import('./waitlistEmailUI.js');
        const c = this.contactOf(e);
        await communicateDialog({ entryId: e.id, name: this.name(e), phone: c?.phone || app.phone || '', emails: this.canEmail(e) ? [{ kind: 'note', label: 'A question from you' }] : [] });
        await this.chat.say('Their application stays here until you decide.');
        this.skipped++;
        continue;
      }
      if (pick === 'decline') {
        await this.chat.say(`Decline ${esc(this.name(e))}'s application? It closes, and no contact is made for them.`);
        if ((await this.chat.choose([{ label: 'Decline it', value: 'yes' }, { label: 'Back', value: 'no', primary: true }])) === 'no') { this.skipped++; continue; }
        await actions.decline(e.id, { date: this.today });
        await this.chat.say('Declined.');
        await this.emails([{ entryId: e.id, kind: 'declined' }]);
        continue;
      }
      await this.approveForm(e);
    }
  }

  // Approve: the date, their program, the contact (a match only suggested), and their
  // ask to list privately, as their page asks; then the fee request email.
  async approveForm(e) {
    const matches = e.contact_id ? [] : contactMatches(e.application || {}, [...this.contactsById.values()].filter((c) => !c.is_archived));
    const full = this.name(e);
    const asksPrivate = actions.hasPendingRequest(e, 'private_request');
    const fee = this.config.fee_amount;
    const res = await this.chat.form({
      title: `<strong>Approve ${esc(full)}</strong>`,
      html: `<div class="ck-inline">
          ${field('Approval date', `<input id="wr-ap-date" type="date" value="${esc(this.today)}">`)}
          ${field('Program', `<select id="wr-ap-prog"><option value="">None</option>${this.programs.map((p) => `<option value="${esc(p.id)}"${p.id === e.waitlist_program_id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`)}
        </div>
        ${e.contact_id ? '' : `<p class="gl-q">Their contact</p><div class="ck-checks">
          ${matches.map((m, i) => `<label class="ck-check"><input type="radio" name="wr-ap-c" value="${esc(m.contact.id)}"${i === 0 && m.strength === 'certain' ? ' checked' : ''}> Use <strong>${esc(m.contact.name)}</strong> <span class="faint">${esc(contactMatchReason(m).toLowerCase())}</span></label>`).join('')}
          <label class="ck-check"><input type="radio" name="wr-ap-c" value=""${matches.length && matches[0].strength === 'certain' ? '' : ' checked'}> A new contact for ${esc(entryName(e, null))}</label></div>
          ${matches.length ? '<p class="field-hint">A match is only a suggestion. Pick it if it\'s the same family.</p>' : ''}`}
        ${asksPrivate ? `<p class="gl-q">They asked not to show their full name on your public list</p><div class="ck-checks">
          <label class="ck-check"><input type="radio" name="wr-ap-p" value="yes"> Approve: shown as <strong>${esc(privateName(full))}</strong></label>
          <label class="ck-check"><input type="radio" name="wr-ap-p" value="no"> Decline: shown as <strong>${esc(publicName(full))}</strong></label></div>` : ''}
        <p class="field-hint">A program that waives the fee puts them straight on the list. Otherwise they owe ${esc(fee != null ? fmtMoney(fee) : 'the fee')} and join the list when you mark it received.</p>`,
      submitLabel: 'Approve',
      cancelLabel: 'Not now',
      submit: async (root) => {
        const p = root.querySelector('input[name="wr-ap-p"]:checked');
        if (asksPrivate && !p) return 'Approve or decline their ask to not show their full name.';
        const c = root.querySelector('input[name="wr-ap-c"]:checked');
        await actions.approve(e.id, {
          date: root.querySelector('#wr-ap-date').value || this.today,
          programId: root.querySelector('#wr-ap-prog').value || null,
          contactId: c ? c.value || null : null,
          ...(asksPrivate ? { privateListing: p.value === 'yes' } : {})
        });
        return true;
      },
      reply: () => 'Approve'
    });
    if (!res.done) { this.skipped++; return; }
    const fresh = await waitlistEntryRepo.getById(e.id);
    await this.chat.say(fresh.status === 'active' ? `${esc(full)} is on the list.` : `Approved. ${esc(full)} joins the list once you mark their fee received.`);
    await this.emails([{ entryId: e.id, kind: fresh.status === 'active' ? 'on_list' : 'approved' }]);
  }

  // --- 7. Fees to check, then extras payments due ---------------------------------------------

  async fees() {
    const ids = this.entries.filter((e) => e.status === 'approved' && !e.fee_received_date)
      .sort((a, b) => (a.fee_due_date || '9999').localeCompare(b.fee_due_date || '9999')).map((e) => e.id);
    for (const id of ids) {
      await this.load();
      const e = this.entriesById.get(id);
      if (!e || e.status !== 'approved') continue;
      const overdue = Boolean(e.fee_due_date && e.fee_due_date < this.today);
      await this.chat.say(`<strong>${esc(this.name(e))}'s ${e.fee_amount != null ? esc(fmtMoney(e.fee_amount)) : ''} fee</strong>: asked for ${esc(fmtDate(e.approved_date))}${e.fee_due_date ? `, ${overdue ? 'was due' : 'due'} ${esc(fmtDate(e.fee_due_date))}` : ''}.`);
      const pick = await this.chat.choose([
        { label: 'Received', value: 'yes', primary: true },
        { label: 'Not yet', value: '__skip' },
        ...(overdue ? [{ label: 'Remove them', value: 'expire' }] : [])
      ]);
      if (pick === '__skip') { this.skipped++; continue; }
      if (pick === 'expire') {
        await actions.markFeeExpired(e.id);
        await this.chat.say('Their application is closed. They can re-apply later.');
        continue;
      }
      // Their credit for funds already received pays this much of it.
      const feeCredit = (await getEntryCredit(e.id)).credit?.byKey.fee || 0;
      const creditLead = feeCredit > 0 ? ` ${esc(fmtMoney(feeCredit))} of it is paid by their credit for funds already received.` : '';
      const res = await this.chat.form({
        title: `<strong>${esc(this.name(e))}'s fee</strong><span class="kels-lead">The date sets their place in line.${creditLead}</span>`,
        html: `<div class="ck-inline">
            ${field('Date received', `<input id="wr-fr-date" type="date" value="${esc(this.today)}">`)}
            ${e.fee_amount != null ? field('Amount', `<input id="wr-fr-amt" type="number" min="0" step="0.01" value="${esc(e.fee_amount)}">`) : ''}
          </div>
          ${e.fee_amount != null ? `<div class="ck-inline">${field('Method', `<select id="wr-fr-method"><option value="">—</option>${PAYMENT_METHODS.map((m) => `<option>${esc(m)}</option>`).join('')}</select>`)}${field('Reference (optional)', '<input id="wr-fr-ref" type="text" autocomplete="off">')}</div>` : ''}`,
        submitLabel: 'Fee received',
        cancelLabel: 'Not now',
        submit: async (root) => {
          await actions.feeReceived(e.id, e.fee_amount == null ? { date: root.querySelector('#wr-fr-date').value || this.today } : {
            date: root.querySelector('#wr-fr-date').value || this.today, amount: root.querySelector('#wr-fr-amt').value,
            method: root.querySelector('#wr-fr-method').value, reference: root.querySelector('#wr-fr-ref').value.trim()
          });
          return true;
        },
        reply: () => 'Received'
      });
      if (!res.done) { this.skipped++; continue; }
      await this.chat.say(`${esc(this.name(e))} is on the list.`);
      await this.emails([{ entryId: e.id, kind: 'on_list' }]);
    }
    for (const n of this.extras) {
      const r = readNudgeKey(n.key);
      await this.chat.say(`<strong>${esc(n.title)}</strong><br>${esc(n.detail || '')}`);
      const pick = await this.chat.choose([{ label: 'Paid', value: 'paid', primary: true }, { label: 'Not yet', value: '__skip' }, { label: 'Open the sale', value: 'open' }]);
      if (pick === '__skip') { this.skipped++; continue; }
      if (pick === 'open') return this.openPage(`sale.html?id=${encodeURIComponent(r.saleId)}`, 'the sale');
      const sale = await saleRepo.getById(r.saleId);
      if (!sale) continue;
      await saleRepo.update(sale.id, { extra_charges: chargesWithStepPaid(sale, r.chargeId, r.stepId, this.today) });
      await this.chat.say(`Marked paid today, ${esc(fmtDate(this.today))}. Change the date on the sale if it came in another day.`);
    }
  }

  // --- 8. "Ready now?" unanswered, recent removals ---------------------------------------------

  async upkeep() {
    for (const n of this.byStep('upkeep')) {
      await this.load();
      const r = readNudgeKey(n.key);
      const e = this.entriesById.get(r.entryId);
      if (!e) continue;
      await this.chat.say(`<strong>${esc(n.title)}</strong><br>${esc(n.detail || '')}`);
      if (r.kind === 'waitlist-removed') {
        const pick = await this.chat.choose([{ label: 'Keep it', value: 'keep', primary: true }, { label: 'Undo', value: 'undo' }, SKIP]);
        if (pick === '__skip') { this.skipped++; continue; }
        if (pick === 'undo') await this.runNudgeAction(n.actions[0]);
        else await this.chat.say('Okay, they stay off the list.');
        continue;
      }
      const pick = await this.chat.choose([{ label: 'They\'re ready', value: 'ready', primary: true }, { label: 'Remove them', value: 'remove' }, { label: 'Wait longer', value: '__skip' }]);
      if (pick === '__skip') { this.skipped++; continue; }
      if (pick === 'ready') { await this.runNudgeAction(n.actions[0]); continue; }
      const res = await actions.removeForNoReadyAnswer(e.id, { date: this.today });
      await this.load();
      await this.chat.say(lines([`${this.name(e)} is off the list. You can undo it for 7 days.`, ...this.changeLines(res)]));
      await this.emails(offerSpecs(res));
    }
  }
}
