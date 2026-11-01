// kelsSetupUI.js — Kels's "Getting Started": a new breeder's first run through her
// kennel's settings, as a chat on pages/kels.html. Each part is saved as it's
// answered (nothing to draft), and every part can be skipped. The parts, each only
// where this edition has what it sets up (data/kelsSetup.js `setupParts`):
//   1. her logo (where something prints it), the Kennel page's own upload;
//   2. lifecycle nudges (the Kennel page's fields);
//   2b. her preferred tests (each new dog's planned tests): add, remove, rename, as
//      many rounds as she likes (kennelRepo's add / remove / renamePreferredTest);
//   3. Puppy Record fields (Pro): everything, or what to leave off;
//   3b. her extra charges price list (Pro, extraCharges): photo packages and the
//      like, saved on the kennel (data/extraCharges.js);
//   3c. her vendor and third-party accounts (Pro, Accounts): added or changed in
//      rounds; a marketplace's or payment service's fee, and whether she charges a
//      payment service's fee back to the family; Stripe connected right here
//      (waitlistFeeStep.offerStripe);
//   4. another kennel (Pro, multi-kennel), for a separate side of the business: two
//      breeds with their own waitlists, a pet side and a show side; it starts with
//      the nudge and Puppy Record settings from 1–3, and its own logo;
//   5. Google Drive for Furever (Pro), connected right here (Google's own sign-in
//      window, opened from her tap);
//   6. Dropbox for KennelAssistant (Pro): Dropbox sends her back to the page that
//      asked, so it connects on the KennelAssistant page, in a new tab;
//   7. backup: cloud backup when it isn't on (kelsBackupSteps.offerCloudBackup), else
//      a backup file when she has none recent;
// then Add dogs or Add people (Pro) straight from here, through `handoff`.
// Every save goes through kennelRepo; the form pieces are the Kennel page's own
// (assets/kennelSettingsFields.js, Pro-only like that page, so it's imported only
// by the parts that use it: Lite, with no Kennel page, gets the backup and her dogs).
// Not offered in the Demo, which saves nothing.
import { kennelRepo } from '../data/kennelRepo.js';
import { ownKennels } from '../data/kennelScope.js';
import { resolveMyKennelId } from '../data/kennelSetup.js';
import { editionFlags, edition } from '../data/editionConfig.js';
import { isProOnlyPage } from '../data/proPages.js';
import { isCloudAvailable } from '../data/cloud/cloudConfig.js';
import { setupParts, logoUses, listWords, settingsToCopy, newKennelNameProblem, possessive, accountLine, FEE_ACCOUNT_TYPES, SETUP_HOW, ACCOUNTS_HOW } from '../data/kelsSetup.js';
import { kennelChargeList, readPriceList } from '../data/extraCharges.js';
import { paymentLink } from '../data/paymentLinks.js';
import { EXPORT_MAX_DAYS } from '../data/accountHealth.js';
import { getLastBackupDate, setFureverSettings } from '../data/settings.js';
import { downloadBackup } from '../data/importExport.js';
import { isDropboxConnected } from '../data/dropbox.js';
import { offerCloudBackup, cloudBackupOn } from './kelsBackupSteps.js';
import { field, input, val, kennelNameField, pagesPrefix } from './kelsSteps.js';
import { ACCOUNT_TYPE } from '../data/vocab.js';
import { esc, fmtMoney } from './ui.js';

export async function runSetupTask(chat, { onExit = () => {}, handoff = null } = {}) {
  if (!(await chat.intro('Welcome aboard! Let\'s get KennelOS set up just the way you like it.', SETUP_HOW))) return onExit('nevermind');
  return new Setup(chat, onExit, handoff).start();
}

// "Set up my accounts" (Pro, Accounts): Getting Started's vendor and third-party
// accounts part on its own, for a breeder already set up.
export async function runAccountsTask(chat, { onExit = () => {} } = {}) {
  if (!(await chat.intro('Let\'s set up your vendor and third-party accounts!', ACCOUNTS_HOW))) return onExit('nevermind');
  await new Setup(chat, onExit, null).accounts({ standalone: true });
  return onExit('done');
}

const DAY = 86_400_000;

// The Kennel page's form pieces (Pro-only; see above).
const fields = () => import('./kennelSettingsFields.js');

// Google's sign-in script (vendored, like the Furever page's), loaded only when
// she asks to connect Drive: the button that opens Google's window must find it
// already there, since a window opened later than her tap is blocked.
let gsiLoading = null;
function loadGoogleSignIn() {
  if (typeof google !== 'undefined' && google.accounts?.oauth2) return Promise.resolve();
  gsiLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('../vendor/gsi/client.js', import.meta.url).href;
    s.onload = () => resolve();
    s.onerror = () => { gsiLoading = null; reject(new Error('Google sign-in couldn\'t load. Check your connection.')); };
    document.head.appendChild(s);
  });
  return gsiLoading;
}

class Setup {
  constructor(chat, onExit, handoff) {
    Object.assign(this, { chat, onExit, handoff, added: [] });
  }

  async start() {
    const kennels = (await ownKennels()).filter((k) => !k.is_archived);
    if (!kennels.length) {
      await this.chat.say('You\'ll need your kennel set up first. Once it is, come back and we\'ll do the rest together.');
      return this.onExit('done');
    }
    const mine = await resolveMyKennelId();
    let kennel = kennels.length === 1 ? kennels[0] : null;
    if (!kennel) {
      await this.chat.say('<strong>Which kennel are we setting up?</strong>');
      const id = await this.chat.choose([
        ...kennels.map((k) => ({ label: k.kennel_name || 'Your kennel', value: k.id, primary: k.id === mine })),
        { label: 'Never mind', value: '' }
      ]);
      if (!id) return this.onExit('nevermind');
      kennel = kennels.find((k) => k.id === id);
    }
    this.kennel = kennel;

    const kennelPage = !(edition === 'lite' && isProOnlyPage('kennel.html'));
    const parts = setupParts(editionFlags, { kennelPage });
    for (const [i, part] of parts.entries()) {
      this.first = i === 0;
      await this[part]();
    }
    return this.next();
  }

  get name() { return esc(this.kennel.kennel_name || 'your kennel'); }

  async reload() { this.kennel = await kennelRepo.getById(this.kennel.id); }

  // --- 1. Logo -----------------------------------------------------------------
  async logo() {
    const { logoPreview } = await fields();
    const uses = listWords(logoUses(editionFlags));
    if (this.kennel.logo_data_url) {
      await this.chat.say(`First up, your logo. ${this.name} already has one, and it goes on your ${uses}:<br>${logoPreview(this.kennel, { max: 120 })}`);
      const pick = await this.chat.choose([{ label: 'Keep it', value: '', primary: true }, { label: 'Change it', value: 'change' }]);
      if (pick === 'change') await this.askLogo(this.kennel);
      else await this.chat.say('Lovely, it stays.', { typing: 300 });
      return;
    }
    await this.chat.say(`First up, your logo! It goes at the top of your ${uses}. Have one handy?`);
    const pick = await this.chat.choose([{ label: 'Upload my logo', value: 'yes', primary: true }, { label: 'Skip for now', value: '' }]);
    if (pick === 'yes') await this.askLogo(this.kennel);
    else await this.chat.say('No problem. You can add it any time from your kennel\'s page.', { typing: 300 });
  }

  // A logo file picked, scaled and saved on `kennel`. → true when saved.
  async askLogo(kennel) {
    const { fileToLogoDataUrl, logoPreview, LOGO_ACCEPT } = await fields();
    const res = await this.chat.form({
      title: `<strong>Choose ${esc(possessive(kennel.kennel_name))} logo.</strong><span class="kels-lead">A square or wide image works best; I'll scale a big one down.</span>`,
      html: `${field('Logo', `<input id="ks-logo" type="file" accept="${LOGO_ACCEPT}">`)}<div id="ks-logo-preview"></div>`,
      wire: (root, { showError }) => {
        root.querySelector('#ks-logo').addEventListener('change', async (e) => {
          const file = e.target.files[0];
          root.querySelector('#ks-logo-preview').innerHTML = '';
          if (!file) return;
          try {
            root._logo = await fileToLogoDataUrl(file);
            root.querySelector('#ks-logo-preview').innerHTML = logoPreview({ ...kennel, logo_data_url: root._logo }, { max: 120 });
            showError('');
          } catch (err) { root._logo = null; showError(err.message || String(err)); }
        });
      },
      submit: async (root) => {
        if (!root._logo) return 'Choose your logo first.';
        await kennelRepo.update(kennel.id, { logo_data_url: root._logo });
        return true;
      },
      submitLabel: 'Use this logo',
      cancelLabel: 'Skip for now',
      reply: () => 'Here\'s my logo'
    });
    if (!res.done) return false;
    if (kennel.id === this.kennel.id) await this.reload();
    await this.chat.say('Gorgeous! It\'ll be on everything you print from now on.', { typing: 400 });
    return true;
  }

  // --- 2. Lifecycle nudges -----------------------------------------------------
  async nudges() {
    const { nudgeFields, readNudgeFields } = await fields();
    const res = await this.chat.form({
      title: '<strong>Next, lifecycle nudges.</strong><span class="kels-lead">When a puppy you kept gets old enough to join your breeding program, I can put a reminder on your Today page to move them up. Here\'s how I\'d set it; change the ages to suit your breed.</span>',
      html: nudgeFields(this.kennel, { on: this.kennel.promote_nudge_enabled ?? true }),
      submit: async (root) => {
        const changes = readNudgeFields(root);
        await kennelRepo.update(this.kennel.id, changes);
        return changes;
      },
      reply: (r) => (r.promote_nudge_enabled ? `Nudge me at ${r.promote_age_male_months} months for boys, ${r.promote_age_female_months} for girls` : 'No nudges, thanks'),
      cancelLabel: 'Skip for now'
    });
    if (!res.done) return this.chat.say('Okay, I\'ll leave those as they are. They\'re on your kennel\'s page whenever you want them.', { typing: 300 });
    await this.reload();
    await this.chat.say(res.result.promote_nudge_enabled ? 'Done! You\'ll never miss a keeper\'s big day.' : 'Got it, no nudges.', { typing: 400 });
  }

  // --- 2b. Preferred tests -------------------------------------------------------
  testsLine() {
    const tests = [...(this.kennel.preferred_tests || [])].sort((a, b) => a.localeCompare(b));
    return tests.map((t) => {
      const breeds = kennelRepo.testBreedsFor(this.kennel, t);
      return `<li>${esc(t)}${breeds.length ? ` <span class="faint">(${breeds.map(esc).join(', ')})</span>` : ''}</li>`;
    }).join('');
  }

  async tests() {
    const why = 'Each new dog you add gets these as its planned tests, and they\'re suggested whenever you log a test result.';
    const has = () => (this.kennel.preferred_tests || []).length > 0;
    if (has()) await this.chat.say(`Now your preferred health tests. ${why} Here's what ${this.name} has:<ul class="kels-list">${this.testsLine()}</ul>Any you'd like to add, remove or rename?`);
    else await this.chat.say(`Now your preferred health tests, like OFA hips and elbows, eyes, or a DNA panel. ${why} Any you'd like to add?`);
    let first = true;
    for (;;) {
      const pick = await this.chat.choose([
        { label: 'Add tests', value: 'add', primary: !has() },
        ...(has() ? [{ label: 'Remove tests', value: 'remove' }, { label: 'Rename a test', value: 'rename' }] : []),
        { label: first ? (has() ? 'They\'re good as they are' : 'Not now') : 'That\'s all', value: '', primary: has() }
      ]);
      if (!pick) break;
      first = false;
      const changed = await this[`${pick}Tests`]();
      await this.reload();
      if (changed) {
        await this.chat.say(has() ? `Done! ${esc(possessive(this.kennel.kennel_name))} tests now:<ul class="kels-list">${this.testsLine()}</ul>Anything else?` : 'Done! There are no preferred tests now. Anything else?', { typing: 400 });
      }
    }
    if (!first) await this.chat.say('Lovely, your tests are set! Every dog you add from now on gets them. A dog already on file keeps its own; you can apply these to it from your kennel\'s page.', { typing: 400 });
    else if (!has()) await this.chat.say('No problem. You can add them any time from your kennel\'s page.', { typing: 300 });
  }

  // Several at once, one per line, each optionally for some of her breeds.
  async addTests() {
    const breeds = [...(this.kennel.preferred_breeds || [])].sort((a, b) => a.localeCompare(b));
    const res = await this.chat.form({
      title: '<strong>Which tests?</strong><span class="kels-lead">One per line.</span>',
      html: `${field('Tests', '<textarea id="ks-tests" rows="4" placeholder="OFA Hips&#10;OFA Elbows&#10;Eyes (CAER)"></textarea>')}
        ${breeds.length ? field('Only for these breeds (optional)', `<div class="check-group">${breeds.map((b) => `<label class="check-inline"><input type="checkbox" data-ks-breed="${esc(b)}"> ${esc(b)}</label>`).join('')}</div>`, 'Leave them all unticked and the tests are for every breed.') : ''}`,
      submit: async (root) => {
        const names = root.querySelector('#ks-tests').value.split('\n').map((t) => t.trim()).filter(Boolean);
        if (!names.length) return 'Type a test, one per line.';
        const forBreeds = [...root.querySelectorAll('[data-ks-breed]:checked')].map((cb) => cb.dataset.ksBreed);
        for (const name of names) {
          if (forBreeds.length) for (const b of forBreeds) await kennelRepo.addPreferredTest(this.kennel.id, name, b);
          else await kennelRepo.addPreferredTest(this.kennel.id, name);
        }
        return names;
      },
      reply: (names) => names.join(', '),
      submitLabel: 'Add',
      cancelLabel: 'Never mind'
    });
    return res.done;
  }

  async removeTests() {
    const tests = [...(this.kennel.preferred_tests || [])].sort((a, b) => a.localeCompare(b));
    const res = await this.chat.form({
      title: '<strong>Tick the ones to remove.</strong><span class="kels-lead">Only from the list: dogs that already have them planned keep them.</span>',
      html: tests.map((t) => `<label class="check-inline ws-check"><input type="checkbox" data-ks-test="${esc(t)}"> ${esc(t)}</label>`).join(''),
      submit: async (root) => {
        const gone = [...root.querySelectorAll('[data-ks-test]:checked')].map((cb) => cb.dataset.ksTest);
        if (!gone.length) return 'Tick at least one, or tap Never mind.';
        for (const t of gone) await kennelRepo.removePreferredTest(this.kennel.id, t);
        return gone;
      },
      reply: (gone) => `Remove ${gone.join(', ')}`,
      submitLabel: 'Remove',
      cancelLabel: 'Never mind'
    });
    return res.done;
  }

  async renameTests() {
    const tests = [...(this.kennel.preferred_tests || [])].sort((a, b) => a.localeCompare(b));
    const res = await this.chat.form({
      title: '<strong>Which one, and what should it be called?</strong>',
      html: `${field('Test', `<select id="ks-rename-from">${tests.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select>`)}
        ${field('New name', input('ks-rename-to', ''))}`,
      submit: async (root) => {
        const from = root.querySelector('#ks-rename-from').value;
        const to = val(root, 'ks-rename-to');
        if (!to) return 'Type its new name.';
        await kennelRepo.renamePreferredTest(this.kennel.id, from, to);
        return { from, to };
      },
      reply: ({ from, to }) => `${from} → ${to}`,
      submitLabel: 'Rename',
      cancelLabel: 'Never mind'
    });
    return res.done;
  }

  // --- 3. Puppy Record fields (Pro) ------------------------------------------------
  async 'puppy-record'() {
    const { puppyRecordFieldsHtml, wirePuppyRecordFields, readPuppyRecordFields } = await fields();
    await this.chat.say('Now your puppy records: the printout each family takes home, with their pup\'s details, parents, health history and their own contact details. Right now they show everything. Want to keep it that way, or choose what\'s left off?');
    const pick = await this.chat.choose([{ label: 'Show everything', value: '', primary: true }, { label: 'Let me choose', value: 'choose' }]);
    if (pick !== 'choose') {
      if (this.kennel.puppy_record_fields) await kennelRepo.update(this.kennel.id, { puppy_record_fields: null });
      await this.reload();
      return this.chat.say('Everything it is. Families love a full record.', { typing: 300 });
    }
    const res = await this.chat.form({
      title: '<strong>Untick what to leave off.</strong><span class="kels-lead">A section with its box unticked is left off, heading and all.</span>',
      html: `<div class="form-grid">${puppyRecordFieldsHtml(this.kennel)}</div>`,
      wire: (root) => wirePuppyRecordFields(root),
      submit: async (root) => { await kennelRepo.update(this.kennel.id, { puppy_record_fields: readPuppyRecordFields(root) }); return true; },
      reply: () => 'That\'s what I want on them',
      cancelLabel: 'Skip for now'
    });
    await this.reload();
    if (res.done) await this.chat.say('Saved! Every puppy record you print will look just like that.', { typing: 300 });
  }

  // --- 3b. Extra charges price list (Pro) ---------------------------------------------
  async 'extra-charges'() {
    const list = kennelChargeList(this.kennel);
    if (list.length) {
      await this.chat.say(`Your extras price list: what you offer on top of a puppy, each its own line on the invoice.<ul>${list.map((x) => `<li>${esc(x.label)}: ${esc(fmtMoney(x.amount))}</li>`).join('')}</ul>`);
      const pick = await this.chat.choose([{ label: 'Keep it', value: '', primary: true }, { label: 'Change it', value: 'change' }]);
      if (pick === 'change') await this.askCharges(list);
      else await this.chat.say('Lovely, it stays.', { typing: 300 });
      return;
    }
    await this.chat.say('Do you offer extras with your puppies, like photo or video packages? List them here with their prices, and you can add them to any sale. Each one prints as its own line on the invoice.');
    const pick = await this.chat.choose([{ label: 'Yes, let me list them', value: 'yes', primary: true }, { label: 'Not now', value: '' }]);
    if (pick === 'yes') await this.askCharges([]);
    else await this.chat.say('No problem. The price list is on your kennel\'s page whenever you want it.', { typing: 300 });
  }

  async askCharges(list) {
    const row = (x = { id: '', label: '', amount: '' }) => `<div class="xc-row" data-xc-id="${esc(x.id)}" style="display:flex; gap:8px; align-items:center; margin-bottom:6px;">
      <input class="xc-label" type="text" value="${esc(x.label)}" placeholder="e.g. Gold photo package" aria-label="Name" style="flex:2; min-width:0;">
      <input class="xc-amount" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(x.amount)}" placeholder="$" aria-label="Price" style="flex:1; min-width:0;">
      <button type="button" class="gl-more" data-xc-remove aria-label="Remove">✕</button>
    </div>`;
    const res = await this.chat.form({
      title: '<strong>Your extras and their prices.</strong><span class="kels-lead">You can change the price on any one sale.</span>',
      html: `<div class="field gl-field" id="xc-list">${(list.length ? list : [undefined, undefined]).map((x) => row(x)).join('')}</div>
        <button type="button" class="gl-more" data-xc-add>+ Another one</button>`,
      wire: (root) => {
        root.querySelector('[data-xc-add]').addEventListener('click', () => {
          root.querySelector('#xc-list').insertAdjacentHTML('beforeend', row());
          root.querySelector('#xc-list').lastElementChild.querySelector('.xc-label').focus();
        });
        root.querySelector('#xc-list').addEventListener('click', (e) => {
          if (e.target.closest('[data-xc-remove]')) e.target.closest('.xc-row').remove();
        });
      },
      submit: async (root) => {
        const rows = [...root.querySelectorAll('#xc-list .xc-row')].map((el) => ({
          id: el.dataset.xcId || null, label: el.querySelector('.xc-label').value, amount: el.querySelector('.xc-amount').value
        }));
        // Only names and prices here: readPriceList keeps each extra's group,
        // rules and plan from the Kennel page.
        const { list: next, error } = readPriceList(rows, this.kennel.extra_charge_list);
        if (error) return error;
        await kennelRepo.update(this.kennel.id, { extra_charge_list: next });
        return next;
      },
      reply: (next) => (next.length ? listWords(next.map((x) => `${x.label} ${fmtMoney(x.amount)}`)) : 'No extras for now'),
      cancelLabel: 'Skip for now'
    });
    await this.reload();
    if (res.done && res.result.length) await this.chat.say('Saved! On a sale, pick them from <strong>Add an extra charge</strong>.', { typing: 300 });
  }

  // --- 3c. Vendor and third-party accounts (Pro, Accounts) ------------------------------
  // The Accounts page's records: her registry, marketplaces, payment services,
  // suppliers, labs… Kels asks only what the app uses: the name and type, a website,
  // the fee a marketplace or payment service takes, a payment service's link, and
  // (extraCharges) whether only some families pay that way and she charges them its
  // fee (Account.fee_charge_back). Logins and referral codes stay on the Accounts page.
  async accounts({ standalone = false } = {}) {
    const { accountRepo } = await import('../data/accountRepo.js');
    const chargeBack = !!editionFlags.extraCharges;
    const load = async () => (await accountRepo.getAll()).filter((a) => !a.is_archived).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    let list = await load();
    const lines = () => `<ul>${list.map((a) => `<li>${esc(accountLine(a, { chargeBack }))}</li>`).join('')}</ul>`;
    const why = `Marketplaces and payment services take a fee, so I'll keep it, and your income is what you actually received.${chargeBack ? ' If a payment service costs you a fee only when a family chooses it (PayPal sent as business, say), I can add that fee to their balance.' : ''}`;
    await this.chat.say(list.length
      ? `${standalone ? 'Here are your accounts' : 'Next, your vendor and third-party accounts. Here\'s what you have'}:${lines()}Want to add one, or change one?`
      : `${standalone ? 'You don\'t have any yet. Think of' : 'Next, your vendor and third-party accounts:'} your registry, where you list puppies, how families pay you (Zelle, PayPal, Stripe…), suppliers, labs. ${why} Want to set them up?`);
    for (;;) {
      const pick = await this.chat.choose([
        { label: list.length ? 'Add another' : 'Add one', value: 'add', primary: !list.length },
        ...(list.length ? [{ label: 'Change one', value: 'change' }] : []),
        { label: list.length ? 'That\'s all' : 'Not now', value: '', primary: !!list.length }
      ]);
      if (!pick) break;
      let account = null;
      if (pick === 'change') {
        await this.chat.say('Which one?', { typing: 200 });
        const id = await this.chat.choose([...list.map((a) => ({ label: a.name || 'Account', value: a.id })), { label: 'Never mind', value: '' }]);
        account = list.find((a) => a.id === id) || null;
        if (!account) continue;
      }
      const saved = await this.askAccount(accountRepo, account, chargeBack);
      if (!saved) continue;
      list = await load();
      if (!account && saved.account_type === 'payment_service' && /stripe/i.test(saved.name || '')) {
        const { offerStripe } = await import('./waitlistFeeStep.js');
        await offerStripe(this.chat, saved.id, true, 'Getting Started');
      }
      await this.chat.say(`Saved. Anything else?${lines()}`, { typing: 300 });
    }
    await this.chat.say(list.length
      ? 'They\'re all on your Accounts page, with room for logins and referral codes too.'
      : 'No problem. You can add them any time on your Accounts page.', { typing: 300 });
  }

  // One account, new (`a` null) or one she has. → the saved account, or null.
  async askAccount(accountRepo, a, chargeBack) {
    const type = a?.account_type || '';
    const typeOptions = `<option value="">— choose —</option>${ACCOUNT_TYPE.map((t) => `<option value="${esc(t.value)}"${t.value === type ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}`;
    const res = await this.chat.form({
      title: a ? `<strong>${esc(a.name || 'Account')}</strong>` : '<strong>A vendor or third-party account.</strong><span class="kels-lead">If one way to pay is free and another isn\'t (PayPal personal and business), add them as two.</span>',
      html: `${field('Its name', input('ks-ac-name', a?.name ?? '', { placeholder: 'e.g. AKC, Good Dog, PayPal (business)' }))}
        ${field('What it is', `<select id="ks-ac-type">${typeOptions}</select>`)}
        ${field('Website (optional)', input('ks-ac-site', a?.website ?? '', { type: 'url', inputmode: 'url', placeholder: 'https://…' }))}
        <div id="ks-ac-fee"${FEE_ACCOUNT_TYPES.includes(type) ? '' : ' hidden'}>
          <div class="ck-inline">
            ${field('Fee percentage', input('ks-ac-percent', a?.fee_percent ?? '', { type: 'number', min: 0, max: 99.99, step: 0.01, inputmode: 'decimal', placeholder: 'e.g. 3.49' }))}
            ${field('Fixed fee ($)', input('ks-ac-fixed', a?.fee_fixed ?? '', { type: 'number', min: 0, step: 0.01, inputmode: 'decimal', placeholder: 'e.g. 0.49' }))}
          </div>
          <p class="field-hint">What it keeps of each payment. Leave both blank if it's free.</p>
        </div>
        <div id="ks-ac-pay"${type === 'payment_service' ? '' : ' hidden'}>
          ${field('Its payment link (optional)', input('ks-ac-link', a?.payment_link ?? '', { type: 'url', inputmode: 'url', placeholder: 'https://…' }), 'A PayPal.me or Stripe link families can tap.')}
          ${chargeBack ? `<label class="check-inline"><input id="ks-ac-back" type="checkbox"${a?.fee_charge_back ? ' checked' : ''}> Only some families pay this way, and I charge them the fee</label>
            <p class="field-hint">When a deposit comes in this way, the sale offers to add the fee to their balance.</p>` : ''}
        </div>`,
      wire: (root) => {
        root.querySelector('#ks-ac-type').addEventListener('change', (e) => {
          root.querySelector('#ks-ac-fee').hidden = !FEE_ACCOUNT_TYPES.includes(e.target.value);
          root.querySelector('#ks-ac-pay').hidden = e.target.value !== 'payment_service';
        });
      },
      submitLabel: 'Save',
      cancelLabel: 'Never mind',
      submit: async (root) => {
        const q = (sel) => root.querySelector(sel);
        const num = (v) => (String(v).trim() === '' ? null : Number(v));
        const name = q('#ks-ac-name').value.trim();
        const account_type = q('#ks-ac-type').value;
        if (!name) return 'What\'s it called?';
        if (!account_type) return `What is ${name}? Pick the closest one.`;
        const changes = { name, account_type, website: q('#ks-ac-site').value.trim() };
        if (FEE_ACCOUNT_TYPES.includes(account_type)) {
          changes.fee_percent = num(q('#ks-ac-percent').value);
          changes.fee_fixed = num(q('#ks-ac-fixed').value);
          if (changes.fee_percent != null && !(changes.fee_percent >= 0 && changes.fee_percent < 100)) return 'The percentage should be under 100.';
          if (changes.fee_fixed != null && !(changes.fee_fixed >= 0)) return 'The fixed fee can\'t be below $0.';
        }
        if (account_type === 'payment_service') {
          const typed = q('#ks-ac-link').value.trim();
          const link = typed ? paymentLink(typed) : '';
          if (typed && !link) return 'That link doesn\'t look like a web address. Copy it from the service and paste it here.';
          changes.payment_link = link;
          if (q('#ks-ac-back')) changes.fee_charge_back = q('#ks-ac-back').checked;
        }
        return a ? accountRepo.update(a.id, changes) : accountRepo.create(changes);
      },
      reply: (saved) => accountLine(saved, { chargeBack })
    });
    return res.done ? res.result : null;
  }

  // --- 4. Another kennel (Pro, multi-kennel) -----------------------------------------
  async kennels() {
    const programs = editionFlags.waitlist ? ' (If it\'s just two breeds on one waitlist, a program for each breed may be all you need.)' : '';
    await this.chat.say(`Some breeders keep two sides of the business apart: two breeds with their own waitlists, say, or a pet-home side and a show side. Each kennel gets its own dogs, litters${editionFlags.waitlist ? ', waitlist' : ''}, money and reports, and you can switch between them, or see them all, from the kennel menu at the top.${programs} Do you need another kennel?`);
    let pick = await this.chat.choose([{ label: 'Yes, add another kennel', value: 'yes' }, { label: 'No, one is plenty', value: '', primary: true }]);
    while (pick === 'yes') {
      const added = await this.addKennel();
      if (!added) break;
      await this.chat.say('Need another one?', { typing: 300 });
      pick = await this.chat.choose([{ label: 'Add another kennel', value: 'yes' }, { label: 'That\'s all', value: '', primary: true }]);
    }
    if (!this.added.length) await this.chat.say(`Perfect, ${this.name} it is. You can add one any time from Kennels.`, { typing: 300 });
  }

  // One new own kennel, with this one's nudge and Puppy Record settings. → it, or null.
  async addKennel() {
    const all = await kennelRepo.getAll();
    const warned = new Set();
    const res = await this.chat.form({
      title: '<strong>What\'s the new kennel called?</strong>',
      html: `${kennelNameField('ks-k-name')}
        ${field('Kennel prefix (optional)', input('ks-k-prefix', '', { placeholder: 'For registered names' }))}
        ${field('Location (optional)', input('ks-k-location', ''))}`,
      submit: async (root) => {
        const name = val(root, 'ks-k-name');
        const problem = newKennelNameProblem(name, all);
        if (typeof problem === 'string') return problem;
        if (problem && !warned.has(problem.key)) { warned.add(problem.key); return problem.message; }
        return kennelRepo.create({
          kennel_name: name, prefix: val(root, 'ks-k-prefix') || null, location: val(root, 'ks-k-location') || null,
          is_own_kennel: true, ...settingsToCopy(this.kennel)
        });
      },
      reply: (k) => k.kennel_name,
      submitLabel: 'Add',
      cancelLabel: 'Never mind'
    });
    if (!res.done) return null;
    const k = res.result;
    this.added.push(k);
    await this.chat.say(`${esc(k.kennel_name)} is ready! It starts with ${esc(possessive(this.kennel.kennel_name))} nudge${editionFlags.puppyRecord ? ' and puppy record' : ''} settings; you can change them on its own page.`);
    if (logoUses(editionFlags).length) await this.newKennelLogo(k);
    return k;
  }

  async newKennelLogo(k) {
    await this.chat.say(`Does ${esc(k.kennel_name)} have its own logo?`, { typing: 300 });
    const pick = await this.chat.choose([
      { label: 'Upload its logo', value: 'own', primary: true },
      ...(this.kennel.logo_data_url ? [{ label: `Use ${possessive(this.kennel.kennel_name)}`, value: 'same' }] : []),
      { label: 'Not now', value: '' }
    ]);
    if (pick === 'own') return this.askLogo(k);
    if (pick === 'same') {
      await kennelRepo.update(k.id, { logo_data_url: this.kennel.logo_data_url });
      return this.chat.say('Done, they match.', { typing: 300 });
    }
  }

  // --- 5. Google Drive for Furever (Pro) ----------------------------------------------
  async furever() {
    await this.chat.say('When a pup goes home, Furever is their family\'s own app for them. You can send along your care guides and the pup\'s papers through your Google Drive, and KennelOS does the uploading. It can only ever see the files it makes there, nothing else. Want to connect Google Drive now?');
    const pick = await this.chat.choose([{ label: 'Connect Google Drive', value: 'yes', primary: true }, { label: 'Not now', value: '' }]);
    if (pick !== 'yes') return this.chat.say('No problem. Furever will ask when you publish your first files.', { typing: 300 });
    try {
      await loadGoogleSignIn();
    } catch (err) {
      return this.chat.say(`${esc(err.message)} Furever will ask again when you publish your first files.`);
    }
    // Google's window opens from this tap (connectDrive is called before any wait).
    const { connectDrive } = await import('../data/googleDrive.js');
    const res = await this.chat.form({
      title: 'Tap <strong>Connect</strong> and Google will ask you to sign in and allow it.',
      html: '<p class="field-hint">A Google window opens. If nothing appears, check whether your browser blocked a pop-up.</p>',
      submit: async () => {
        await connectDrive();
        setFureverSettings({ driveConnected: true });
        return true;
      },
      submitLabel: 'Connect',
      cancelLabel: 'Not now',
      reply: () => 'Connected!'
    });
    if (res.done) await this.chat.say('Google Drive is connected! Google may ask you to sign in again now and then; Furever\'s Publish will ask when it needs to.');
    else await this.chat.say('No problem. Furever will ask when you publish your first files.', { typing: 300 });
  }

  // --- 6. Dropbox for KennelAssistant (Pro) --------------------------------------------
  async assistant() {
    if (isDropboxConnected()) {
      return this.chat.say('KennelAssistant, the app for a helper\'s phone, works through your Dropbox, and it\'s already connected. Nice!', { typing: 400 });
    }
    await this.chat.say('Do you have help with the dogs? KennelAssistant is a little app for a helper\'s phone: they see your dogs, log feedings, weights and notes, and you bring their updates in. It works through your Dropbox (only a KennelOS folder, nothing else). Want to connect Dropbox?');
    const pick = await this.chat.choose([{ label: 'Connect Dropbox', value: 'yes', primary: true }, { label: 'Not now', value: '' }]);
    if (pick !== 'yes') return this.chat.say('No problem. It\'s under Sharing whenever you want it.', { typing: 300 });
    await this.chat.say('Dropbox connects on the KennelAssistant page, so I\'ll open it in a new tab. Tap <strong>Connect Dropbox</strong> there and sign in, then come back here. I\'ll be waiting!');
    if ((await this.chat.choose([{ label: 'Okay, open it', value: 'go', primary: true }, { label: 'Not now', value: '' }])) !== 'go') {
      return this.chat.say('No problem. It\'s under Sharing whenever you want it.', { typing: 300 });
    }
    const href = `${pagesPrefix()}assistant.html`;
    const tab = window.open(href, '_blank');
    if (!tab) await this.chat.say(`Your browser blocked the new tab. <a href="${esc(href)}" target="_blank" rel="noopener">Tap here to open KennelAssistant</a>.`);
    for (;;) {
      const back = await this.chat.choose([{ label: 'I\'m back, check it now', value: 'check', primary: true }, { label: 'Skip it for now', value: '' }]);
      if (!back) return this.chat.say('No problem. It\'s under Sharing whenever you want it.', { typing: 300 });
      if (isDropboxConnected()) return this.chat.say('Dropbox is connected! Send your helper the dogs from the KennelAssistant page whenever they\'re ready.');
      await this.chat.say('I don\'t see it connected yet. Did Dropbox finish? Give it another go in that tab, then tap below.', { typing: 400 });
    }
  }

  // --- 7. Backup -------------------------------------------------------------------
  async backup() {
    const cloud = isCloudAvailable();
    const lead = this.first ? 'Let\'s start with the most important one: backups.' : 'One more, and it\'s an important one: backups.';
    const why = 'Everything lives on this device, so if it\'s lost or broken, your records go with it.';
    if (cloud && (await cloudBackupOn())) return this.chat.say(`${this.first ? 'Your' : 'And your'} cloud backup is already on, so your records are safe. Smart move!`, { typing: 400 });
    if (cloud && await offerCloudBackup(this.chat, {
      line: `${lead} ${why} Cloud backup keeps a copy safe, and it backs up by itself after that. Want to turn it on? It only takes a minute.`
    })) return this.chat.say('Cloud backup is on. Your records are safe!', { typing: 400 });
    const last = getLastBackupDate();
    if (last && Date.now() - Date.parse(last) < EXPORT_MAX_DAYS * DAY) return;
    await this.chat.say(cloud
      ? 'Then let\'s at least save a backup file: you can bring everything back from it. Want to save one now? Keep it somewhere safe, like your email or a cloud drive.'
      : `${lead} ${why} A backup file brings them back. Want to save one now? Keep it somewhere safe, like your email or a cloud drive.`);
    const pick = await this.chat.choose([{ label: 'Download a backup now', value: 'yes', primary: true }, { label: 'Not now', value: '' }]);
    if (pick !== 'yes') return this.chat.say('No problem. It\'s on Import/Export whenever you\'re ready.', { typing: 300 });
    await downloadBackup();
    await this.chat.say('Saved! Do one now and then, after you\'ve added a lot.', { typing: 400 });
  }

  // --- Then: her dogs, or her people ------------------------------------------------
  async next() {
    await this.chat.say(`That's ${this.name} all set up, beautifully done! Want to start adding your dogs${editionFlags.contactsSection ? ' or your people' : ''} now?`, { typing: 700 });
    const pick = await this.chat.choose([
      { label: 'Add my dogs', value: 'add-dogs', primary: true },
      ...(editionFlags.contactsSection ? [{ label: 'Add my people', value: 'add-people' }] : []),
      { label: 'I\'m all set for now', value: '' }
    ]);
    if (pick && this.handoff) return this.handoff(pick);
    this.onExit('done');
  }
}
