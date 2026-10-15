// waitlistSetupUI.js — Kels's "Set up my waitlist" (Pro, editionFlags.waitlist):
// the kennel's Waitlist settings, its online list and its programs, as a chat on
// pages/kels.html, for a breeder starting from nothing. Related settings are one
// screen each (checkboxes for the on/off ones), not a question apiece:
//   1. the fee: amount, refund policy, days to pay, how to pay; paid online (Stripe
//      connected right here, assets/vendorKeyUI.js);
//   2. offers: days to answer, passes, and the on/off rules (no response = a pass,
//      color matching, each automatic-offer moment);
//   3. going online (only where isWaitlistOnlineOffered): needs cloud backup on this
//      device, so Kels offers to turn it on first (cloudBackupUI.turnOnFlow); then the
//      list, applications, reminder emails, what shows before picks open, "Ready
//      now?", Facebook, her website, the time zone;
//   4. programs, as many as she likes;
//   5. the families she already has (the waitlist import, or a new entry).
// Re-runnable: on a kennel already set up she says what's set and asks what to
// change. Every save goes through kennelRepo / waitlistProgramRepo, checked by
// waitlistRules.waitlistConfigProblem (the Kennel page's settings card uses it too);
// going online through cloudWaitlist.saveWaitlistOnline (the Online list card's save).
import { kennelRepo } from '../data/kennelRepo.js';
import { waitlistProgramRepo } from '../data/waitlistProgramRepo.js';
import { waitlistEntryRepo } from '../data/waitlistEntryRepo.js';
import { ownKennels, getActiveKennel } from '../data/kennelScope.js';
import { isWaitlistOnlineOffered } from '../data/cloud/cloudConfig.js';
import {
  waitlistConfig, waitlistConfigProblem, waitlistSummaryLines, waitlistIsSetUp, showUpcoming, UPCOMING_STAGES,
  embedOrigin, embedOrigins, EMBED_ORIGINS_MAX, PUBLIC_INTRO_DEFAULT
} from '../data/waitlistRules.js';
import { WAITLIST_AUTO_OFFER_TRIGGER, WAITLIST_READY_NO_ANSWER, WAITLIST_PRIORITY } from '../data/vocab.js';
import { field } from './litterCheckinUI.js';
import { askApplicant } from './kelsApplicant.js';
import { offerCloudBackup, CLOUD_OFF_FORM } from './kelsBackupSteps.js';
import { askWaitlistFee } from './waitlistFeeStep.js';
import { esc, fmtMoney } from './ui.js';

const pagesPrefix = () => (location.pathname.includes('/pages/') ? '' : 'pages/');
const opt = (value, label, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
const check = (id, label, on, attrs = '') => `<label class="check-inline ws-check"><input type="checkbox" id="${esc(id)}"${on ? ' checked' : ''}${attrs}> ${esc(label)}</label>`;
const group = (title, inner, hint = '') => `<fieldset class="ws-group"><legend>${esc(title)}</legend>${hint ? `<p class="field-hint">${hint}</p>` : ''}${inner}</fieldset>`;
const numOrNull = (v) => (String(v ?? '').trim() === '' ? null : Number(v));

export async function runWaitlistSetupTask(chat, { onExit = () => {}, handoff = null } = {}) {
  if (!(await chat.intro('Ooh, love it, let\'s get your waitlist ready for families!'))) return onExit('nevermind');
  return new Setup(chat, onExit, handoff).start();
}

class Setup {
  constructor(chat, onExit, handoff) {
    Object.assign(this, { chat, onExit, handoff, saved: 0 });
    this.onlineOffered = isWaitlistOnlineOffered();
  }

  async reload() {
    this.kennel = await kennelRepo.getById(this.kennel.id);
    this.config = waitlistConfig(this.kennel);
    this.programs = await waitlistProgramRepo.getByKennel(this.kennel.id);
  }

  // Merge `changes` into the stored config, check it, save. → '' or a problem.
  async saveConfig(changes, extra = {}) {
    const next = { ...(this.kennel.waitlist_config || {}), ...changes };
    const problem = waitlistConfigProblem({ ...waitlistConfig({ waitlist_config: next }) });
    if (problem) return problem;
    await kennelRepo.update(this.kennel.id, { waitlist_config: next, ...extra });
    this.saved++;
    await this.reload();
    return '';
  }

  async start() {
    const kennels = (await ownKennels()).filter((k) => !k.is_archived);
    if (!kennels.length) {
      await this.chat.say('You\'ll need your kennel set up first. Once it is, come back and we\'ll build your waitlist together.');
      return this.onExit('done');
    }
    let kennel = kennels.length === 1 ? kennels[0] : null;
    if (!kennel) {
      const active = await getActiveKennel();
      await this.chat.say('<strong>Which kennel\'s waitlist are we setting up?</strong>');
      const id = await this.chat.choose([
        ...kennels.map((k) => ({ label: k.kennel_name || 'Your kennel', value: k.id, primary: k.id === active?.id })),
        { label: 'Never mind', value: '' }
      ]);
      if (!id) return this.onExit('nevermind');
      kennel = kennels.find((k) => k.id === id);
    }
    this.kennel = kennel;
    await this.reload();

    if (waitlistIsSetUp(this.kennel)) return this.changeMenu(true);

    await this.chat.say(`Let's build ${esc(this.kennel.kennel_name || 'your kennel')}'s waitlist. It's a few short screens, and you can change any of it later.`, { typing: 700 });
    for (const step of ['fee', 'offers', 'online', 'programs', 'families']) {
      const r = await this.runSection(step, { walk: true });
      if (r === 'left') return null;
      if (r === 'stop') break;
    }
    return this.wrapUp();
  }

  // An existing setup: what's set, then what to change, until she's done.
  async changeMenu(first) {
    if (first) {
      const lines = waitlistSummaryLines(this.config, { programs: this.programs, online: this.onlineOffered, fmtMoney });
      await this.chat.say(`${esc(this.kennel.kennel_name || 'Your kennel')}'s waitlist is already set up. Here's what's set:<br>${lines.map(esc).join('<br>')}`, { typing: 900 });
    }
    for (;;) {
      await this.chat.say(first ? '<strong>What would you like to change?</strong>' : '<strong>Anything else to change?</strong>', { typing: 400 });
      first = false;
      const pick = await this.chat.choose([
        { label: 'The fee', sub: 'Amount, refunds, how families pay', value: 'fee' },
        { label: 'Offers and turns', sub: 'Days to answer, passes, automatic offers', value: 'offers' },
        ...(this.onlineOffered ? [{ label: 'Going online', sub: 'Your list, applications, emails, your website', value: 'online' }] : []),
        { label: 'Programs', sub: this.programs.length ? this.programs.map((p) => p.name).join(', ') : 'Special terms for some families', value: 'programs' },
        { label: 'Families I already have', value: 'families' },
        { label: 'That\'s all', value: 'done' }
      ], { stagger: 100 });
      if (pick === 'done') return this.wrapUp();
      if ((await this.runSection(pick, { walk: false })) === 'left') return null;
    }
  }

  runSection(step, opts) {
    if (step === 'fee') return this.fee(opts);
    if (step === 'offers') return this.offers(opts);
    if (step === 'online') return this.onlineOffered ? this.online(opts) : null;
    if (step === 'programs') return this.programsStep(opts);
    if (step === 'families') return this.families(opts);
    return null;
  }

  // --- 1. The fee -----------------------------------------------------------------
  // The shared fee step (assets/waitlistFeeStep.js): Set up my application form asks it too.

  async fee() {
    if (await askWaitlistFee(this.chat, this.kennel, { resumeTask: 'Set up my waitlist' })) this.saved++;
    await this.reload();
    return null;
  }

  // --- 2. Offers and turns ------------------------------------------------------------

  async offers() {
    const c = this.config;
    const autos = WAITLIST_AUTO_OFFER_TRIGGER.map((t) => check(`ws-auto-${t.value}`, t.label, c.auto_offer_on.includes(t.value), ` data-auto="${esc(t.value)}"`)).join('');
    const res = await this.chat.form({
      title: '<strong>Now, how offers work.</strong><span class="kels-lead">When it\'s a family\'s turn, they get an offer to pick a pup.</span>',
      html: `<div class="ck-inline">
          ${field('Days to accept and pay the deposit', `<input id="ws-respond" type="number" min="1" step="1" value="${esc(c.respond_days)}">`)}
          ${field('Passes before they\'re removed', `<input id="ws-passes" type="number" min="1" step="1" value="${esc(c.max_passes)}">`)}
        </div>
        ${group('Rules', check('ws-noresp', 'No response by the deadline counts as a pass', c.no_response_counts_as_pass)
          + check('ws-colors', 'Only offer pups in a color the family listed', c.color_matching))}
        ${group('Offer the next family automatically when…', `<p class="gl-q" style="margin-top:0;"><button type="button" class="gl-more" data-ws="all">All</button> <button type="button" class="gl-more" data-ws="none">None</button></p>${autos}`,
          'Unticked ones wait for you to tap "Offer to them".')}`,
      wire: (root) => {
        root.querySelector('[data-ws="all"]').addEventListener('click', () => root.querySelectorAll('[data-auto]').forEach((b) => { b.checked = true; }));
        root.querySelector('[data-ws="none"]').addEventListener('click', () => root.querySelectorAll('[data-auto]').forEach((b) => { b.checked = false; }));
      },
      submitLabel: 'Save',
      cancelLabel: 'Skip this',
      submit: async (root) => (await this.saveConfig({
        respond_days: numOrNull(root.querySelector('#ws-respond').value),
        max_passes: numOrNull(root.querySelector('#ws-passes').value),
        no_response_counts_as_pass: root.querySelector('#ws-noresp').checked,
        color_matching: root.querySelector('#ws-colors').checked,
        auto_offer_on: [...root.querySelectorAll('[data-auto]:checked')].map((b) => b.dataset.auto)
      })) || true,
      reply: () => `${this.config.respond_days} days, ${this.config.max_passes} passes`
    });
    if (!res.done) return null;
    await this.chat.say('Got it. That\'s fair to families and to you.', { typing: 400 });
    return null;
  }

  // --- 3. Going online -------------------------------------------------------------------

  async online({ walk }) {
    const cw = await import('../data/cloud/cloudWaitlist.js');
    // The list stays offline until she says so: asked whenever it's off.
    if (!this.config.online) {
      await this.chat.say('Want families to apply and check their place in line online? You get a link to share, and KennelOS keeps it up to date for you.');
      const pick = await this.chat.choose([
        { label: 'Yes, put it online', value: 'yes', primary: true },
        { label: 'Keep it offline for now', value: '' }
      ]);
      if (pick !== 'yes') return null;
    }
    // Her online list is published from this device's cloud backup.
    let st = cw.waitlistOnlineStatus(this.kennel);
    if (!st.signedIn || !st.backupOn) {
      const on = await offerCloudBackup(this.chat, {
        line: `Your online list is published through cloud backup, and that's ${st.signedIn ? 'off' : 'not set up'} on this device. ${CLOUD_OFF_FORM} Want to turn it on now? It only takes a minute, and your records get backed up too.`,
        later: 'Okay, we\'ll leave the list offline for now, so you\'ll type each family\'s application in yourself. Once cloud backup is on, come back and we\'ll put it online.'
      });
      st = cw.waitlistOnlineStatus(this.kennel);
      if (!on || !st.signedIn || !st.backupOn) return null;
      await this.chat.say('Cloud backup is on. Great, let\'s put your list online.');
    }
    const { timeZoneOptions, deviceTimeZone } = await import('./waitlistOnlineUI.js');
    const c = this.config;
    const show = showUpcoming(c);
    const zone = this.kennel.time_zone || deviceTimeZone() || '';
    const upcoming = UPCOMING_STAGES.map((stg) => `<div class="ws-row"><span>${esc(stg.label)}</span>
        ${check(`ws-up-${stg.value}-public`, 'Public list', show[stg.value].public, ` data-up="${esc(stg.value)}:public"`)}
        ${check(`ws-up-${stg.value}-family`, 'Family pages', show[stg.value].family, ` data-up="${esc(stg.value)}:family"`)}</div>`).join('');
    const res = await this.chat.form({
      title: '<strong>Here\'s everything for your online list.</strong><span class="kels-lead">Tick what you want. The defaults are a good start.</span>',
      html: `${group('Online', check('ws-online', `Put ${this.kennel.kennel_name || 'my'} waitlist online`, true)
          + check('ws-form', 'Take applications online', c.online_form || !c.online)
          + check('ws-reminders', 'Send reminder emails by themselves (turn halfway, last day, fee due, "Ready now?")', c.email_reminders !== false))}
        ${group('Show online before picks open', upcoming, '<strong>The public list is open to anyone with its link</strong>, so "Public list" makes those plans public.')}
        ${group('When a family doesn\'t answer "Ready now?"', `<div class="ck-inline">
            ${field('Then', `<select id="ws-ready">${WAITLIST_READY_NO_ANSWER.map((o) => opt(o.value, o.label, o.value === c.ready_no_answer)).join('')}</select>`)}
            ${field('Days to answer', `<input id="ws-ready-days" type="number" min="1" step="1" value="${esc(c.ready_answer_days)}">`)}</div>`)}
        ${group('Facebook', check('ws-fb', 'Show "Message us on Facebook" on status pages', c.facebook_button)
          + field('Your Facebook Page link', `<input id="ws-fb-page" type="url" inputmode="url" value="${esc(c.facebook_page || '')}" placeholder="facebook.com/yourkennel">`))}
        ${group('Your website', check('ws-embed', 'Let my own website show my application form and list', c.embed)
          + field(`Its address (optional, up to ${EMBED_ORIGINS_MAX}, one per line)`, `<textarea id="ws-sites" rows="2" placeholder="e.g. thornfieldkennels.com">${esc(embedOrigins(c).join('\n'))}</textarea>`, 'Blank allows any site. On Wix, leave it blank.'))}
        ${field('Message above your public list (optional)', `<textarea id="ws-intro" rows="3" placeholder="${esc(PUBLIC_INTRO_DEFAULT.slice(0, 90))}…">${esc(c.public_intro_text || '')}</textarea>`, 'Blank uses our standard wording.')}
        ${field('Time zone', `<select id="ws-tz">${timeZoneOptions(this.kennel.time_zone).map((z) => opt(z, z.replace(/_/g, ' '), z === zone)).join('')}</select>`, 'Offer deadlines end at 11:59 pm here.')}`,
      submitLabel: 'Save and publish',
      cancelLabel: 'Skip this',
      submit: async (root) => {
        const q = (s) => root.querySelector(s);
        const typed = q('#ws-sites').value.split(/[\n,]+/).map((t) => t.trim()).filter(Boolean);
        const bad = typed.filter((t) => !embedOrigin(t));
        if (bad.length) return `This doesn't look like a website address: ${bad.join(', ')}. Type it like thornfieldkennels.com.`;
        const sites = [...new Set(typed.map(embedOrigin))];
        if (sites.length > EMBED_ORIGINS_MAX) return `List up to ${EMBED_ORIGINS_MAX} addresses, or leave it blank.`;
        const showNext = showUpcoming({});
        for (const b of root.querySelectorAll('[data-up]')) { const [stg, where] = b.dataset.up.split(':'); showNext[stg][where] = b.checked; }
        const changes = {
          online: q('#ws-online').checked,
          online_form: q('#ws-form').checked,
          email_reminders: q('#ws-reminders').checked,
          show_upcoming: showNext,
          ready_no_answer: q('#ws-ready').value,
          ready_answer_days: numOrNull(q('#ws-ready-days').value),
          facebook_button: q('#ws-fb').checked,
          facebook_page: q('#ws-fb-page').value.trim(),
          embed: q('#ws-embed').checked,
          embed_origins: sites,
          public_intro_text: q('#ws-intro').value.trim()
        };
        const problem = waitlistConfigProblem(waitlistConfig({ waitlist_config: { ...(this.kennel.waitlist_config || {}), ...changes } }));
        if (problem) return problem;
        await cw.saveWaitlistOnline(this.kennel.id, changes, { timeZone: q('#ws-tz').value || null });
        this.saved++;
        await this.reload();
        return true;
      },
      reply: () => (this.config.online ? 'Put it online' : 'Keep it offline')
    });
    if (!res.done) return null;
    if (!this.config.online) { await this.chat.say('Saved. Your list stays offline.'); return null; }
    return this.sayOnlineStatus(cw);
  }

  async sayOnlineStatus(cw) {
    await this.chat.say('Publishing…', { typing: 300 });
    const st = cw.waitlistOnlineStatus(this.kennel);
    if (st.lastError) {
      const { onlineProblemText } = await import('./waitlistOnlineUI.js');
      await this.chat.say(`Your settings are saved, but the list isn't published yet. ${esc(onlineProblemText(st.lastError.code))}`);
      return null;
    }
    const { publicListLink, applyFormLink } = await import('../data/cloud/cloudConfig.js');
    const list = publicListLink(this.kennel.public_id);
    const form = st.formOpen ? applyFormLink(this.kennel.public_id) : null;
    const bubble = await this.chat.say(`You're live! Copy your links to share on Facebook or your website:
      <div class="pill-row" style="margin-top:8px;">
        <button type="button" class="btn btn-sm btn-primary" data-ws-copy="list">Copy list link</button>
        ${form ? '<button type="button" class="btn btn-sm" data-ws-copy="form">Copy application form link</button>' : ''}
      </div>`);
    const { copyLink } = await import('./waitlistUI.js');
    bubble.querySelector('[data-ws-copy="list"]').addEventListener('click', (ev) => copyLink(list, ev.currentTarget, { title: 'Your public list' }));
    bubble.querySelector('[data-ws-copy="form"]')?.addEventListener('click', (ev) => copyLink(form, ev.currentTarget, { title: 'Your application form' }));
    return null;
  }

  // --- 4. Programs ----------------------------------------------------------------------

  async programsStep({ walk }) {
    if (walk || !this.programs.length) {
      await this.chat.say(`Do some families get special terms? A program can waive the fee, put them ahead in line, or give them more time. Repeat buyers or service-dog homes, say.${this.programs.length ? ` You have ${esc(this.programs.map((p) => p.name).join(', '))}.` : ''}`);
      const pick = await this.chat.choose([{ label: 'Add a program', value: 'add', primary: true }, { label: walk ? 'Not now' : 'Go back', value: '' }]);
      if (pick !== 'add') return null;
    }
    for (;;) {
      const added = await this.programForm();
      if (!added) return null;
      await this.chat.say(`${esc(added.name)} is ready. Add another?`, { typing: 400 });
      const pick = await this.chat.choose([{ label: 'Add another', value: 'add' }, { label: 'That\'s all', value: '', primary: true }]);
      if (pick !== 'add') return null;
    }
  }

  async programForm() {
    const res = await this.chat.form({
      title: '<strong>A new program</strong>',
      html: `${field('Name', '<input id="wp-name" type="text" placeholder="e.g. Repeat buyers">')}
        <div class="ck-inline">
          ${field('Place in line', `<select id="wp-priority">${WAITLIST_PRIORITY.map((o) => opt(o.value, o.label, o.value === 'standard')).join('')}</select>`)}
          ${field('Application fee', `<input id="wp-fee" type="number" min="0" step="0.01" placeholder="${this.config.fee_amount != null ? `Normal (${esc(fmtMoney(this.config.fee_amount))})` : 'Normal'}">`, '0 waives it.')}
          ${field('Days to accept', `<input id="wp-respond" type="number" min="1" step="1" placeholder="Normal (${esc(this.config.respond_days)})">`)}
        </div>
        ${group('Also', check('wp-passes', 'Their passes don\'t count toward removal', false) + check('wp-pause', 'They may pause without it counting against them', false))}
        ${field('Description for families (optional)', '<textarea id="wp-public" rows="2"></textarea>', 'Blank keeps the program private.')}`,
      submitLabel: 'Save program',
      cancelLabel: 'Never mind',
      submit: async (root) => {
        const q = (s) => root.querySelector(s);
        const name = q('#wp-name').value.trim();
        if (!name) return 'Give the program a name.';
        const respond = numOrNull(q('#wp-respond').value);
        if (respond != null && !(Number.isInteger(respond) && respond >= 1)) return 'Days to accept must be at least 1.';
        const p = await waitlistProgramRepo.create({
          kennel_id: this.kennel.id, name, priority: q('#wp-priority').value,
          fee_override: numOrNull(q('#wp-fee').value), respond_days_override: respond,
          passes_count: !q('#wp-passes').checked, pause_allowed: q('#wp-pause').checked,
          public_description: q('#wp-public').value.trim()
        });
        this.saved++;
        await this.reload();
        return p;
      },
      reply: (p) => p.name
    });
    return res.done ? res.result : null;
  }

  // --- 5. Families she already has ---------------------------------------------------------

  async families({ walk }) {
    const entries = await waitlistEntryRepo.getByKennel(this.kennel.id);
    const live = entries.filter((e) => !e.is_archived);
    await this.chat.say(live.length
      ? `You have ${live.length} famil${live.length === 1 ? 'y' : 'ies'} on the list already. Want to bring in more you're keeping track of elsewhere?`
      : 'Last one: do you already have families waiting, maybe in a spreadsheet or your messages?');
    const pick = await this.chat.choose([
      { label: 'Import a list', sub: 'A spreadsheet (CSV) of families', value: 'import' },
      { label: 'Add one by hand', sub: 'Their details and when they joined', value: 'one' },
      { label: walk ? 'Not now' : 'Go back', value: '' }
    ]);
    if (!pick) return null;
    if (pick === 'one') {
      let added = 0;
      for (;;) {
        const entry = await this.addFamily();
        if (!entry) break;
        added++;
        await this.chat.say(`Added! ${esc(entry.application?.name || 'They')} ${added === 1 ? 'is' : 'are'} in your applications, ready for you to approve on the waitlist.`);
        if ((await this.chat.choose([{ label: 'Add another family', value: 'more', primary: true }, { label: 'That\'s all of them', value: '' }])) !== 'more') break;
      }
      return added ? 'saved' : null;
    }
    // A spreadsheet import is a page of its own (match columns, preview, commit).
    if (walk) await this.wrapUp({ leaving: true });
    const k = encodeURIComponent(this.kennel.id);
    await this.chat.say('I\'ll open the waitlist import for you. Your settings are all saved.');
    await this.chat.pause(1300);
    location.href = `${pagesPrefix()}waitlist-import.html?kennel=${k}`;
    return 'left';
  }

  // One family she already has, typed in the chat (kelsApplicant.askApplicant).
  async addFamily() {
    return askApplicant(this.chat, { kennel: this.kennel });
  }

  // --- The end -----------------------------------------------------------------------------

  async wrapUp({ leaving = false } = {}) {
    await this.reload();
    const lines = waitlistSummaryLines(this.config, { programs: this.programs, online: this.onlineOffered, fmtMoney });
    await this.chat.say(`${this.saved ? 'Your waitlist is ready, and it looks great!' : 'Nothing changed, and that\'s fine.'} Here's where it stands:<br>${lines.map(esc).join('<br>')}`
      + `<br><span class="kels-lead">Your emails and pass reasons use our standard wording. You can change them in your kennel's Waitlist settings.</span>`);
    if (leaving) return;
    // Her application form is a task of its own (assets/guidedFormUI.js).
    if (this.handoff) {
      await this.chat.say('Want to make your application form your own next? The questions families answer, and a few FAQs.');
      const pick = await this.chat.choose([{ label: 'Set up my application form', value: 'form', primary: true }, { label: 'Not now', value: '' }]);
      if (pick === 'form') return this.handoff('form-setup', { kennelId: this.kennel.id });
    }
    this.onExit('done');
  }
}
