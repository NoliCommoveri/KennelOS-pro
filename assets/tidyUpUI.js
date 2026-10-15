// tidyUpUI.js — Kels's "Tidy up my records" task, as a chat on pages/kels.html
// (assets/kelsChat.js draws it). She looks through the records for places two
// of them disagree (data/tidyRules.js), says how many she found, then brings
// them up one at a time with the fixes that fit. Each fix is saved as soon as
// she approves it, through the repos (a duplicate through data/recordMerge.js),
// and she looks again after every one, so a fix that settles another finding
// takes it off the list.
//
// Every finding offers "Not now" (skipped this visit) and an answer that she
// remembers on this device (nudgeState, `tidy:<key>`): "Don't ask again", "Not
// the same dog", "Parents unknown"… Edition: the contact, kennel and stud
// service checks need editionFlags.contactsSection / studServices (tidyRules).
import { dogRepo, dogName } from '../data/dogRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { pairingRepo } from '../data/pairingRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import { studServiceRepo } from '../data/studServiceRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { inScopeOnly, dogsInScope, resolveKennelIdForWrite } from '../data/kennelScope.js';
import { editionFlags } from '../data/editionConfig.js';
import { DISPOSITION, OWNERSHIP_TYPE, DOG_STATUS, SALE_STATUS, PAIRING_STATUS, descriptor } from '../data/vocab.js';
import { litterLabel } from '../data/litterCheckin.js';
import { findDogMatches, matchReason, similarNamed } from '../data/dogSearch.js';
import { baseFromLitter } from '../data/puppyDefaults.js';
import { deliveredOwnershipChanges } from '../data/goHome.js';
import { studParents, ourRole } from '../data/studRules.js';
import * as T from '../data/tidyRules.js';
import { mergeConflicts, suggestKeep, mergeRecords } from '../data/recordMerge.js';
import { CapExceededError } from '../data/repoBase.js';
import { esc, fmtDate, todayYMD } from './ui.js';
import { addDaysToYMD } from '../data/dateUtils.js';
import { renderUpgradeNudge } from './upgradeNudge.js';
import { FindingsTask, plural } from './kelsFindings.js';
import { field, kennelNameField, contactFields, readContactFields } from './kelsSteps.js';

const ROLE = { sire: { field: 'sire_id', sex: 'male', word: 'sire' }, dam: { field: 'dam_id', sex: 'female', word: 'dam' } };
const label = (vocab, v) => descriptor(vocab, v).label;

// What each kind is called in her opening count.
const KIND_WORDS = {
  'litter-count': ['litter count', 'litter counts'],
  'pup-placed': ['puppy plan', 'puppy plans'],
  'delivered-owned': ['dog that went home', 'dogs that went home'],
  'litter-pairing-parents': ['litter and its breeding', 'litters and their breedings'],
  'pup-litter-parents': ['litter\'s puppy parents', 'litters\' puppy parents'],
  'dog-no-parents': ['dog without parents', 'dogs without parents'],
  'stud-unlinked': ['stud service', 'stud services'],
  'breeder-no-kennel': ['breeder without a kennel', 'breeders without a kennel'],
  'kennel-no-contact': ['kennel without a contact', 'kennels without a contact'],
  'duplicate-dogs': ['possible duplicate dog', 'possible duplicate dogs'],
  'duplicate-contacts': ['possible duplicate contact', 'possible duplicate contacts']
};

export async function runTidyTask(chat, { onExit = () => {} } = {}) {
  if (!(await chat.intro('Love it, let\'s get your records tidy!'))) return onExit('nevermind');
  return new Tidy(chat, onExit).start();
}

// The look-ask-fix loop is kelsFindings.js's; this is the tidy-up's checks and fixes.
class Tidy extends FindingsTask {
  constructor(chat, onExit) {
    super(chat, onExit, 'tidy');
    this.today = todayYMD();
  }

  async load() {
    const flags = editionFlags;
    const [litters, pairings, sales, allDogs, studServices, contacts, kennels] = await Promise.all([
      litterRepo.getAll(), pairingRepo.getAll(), saleRepo.getAll(),
      dogRepo.getAll({ includeArchived: true, includePedigreeOnly: true }),
      flags.studServices ? studServiceRepo.getAll() : [],
      contactRepo.getAll({ includeArchived: true }),
      kennelRepo.getAll({ includeArchived: true })
    ]);
    this.dogsById = new Map(allDogs.map((d) => [d.id, d]));
    this.littersById = new Map(litters.map((l) => [l.id, l]));
    this.pairingsById = new Map(pairings.map((p) => [p.id, p]));
    this.contactsById = new Map(contacts.map((c) => [c.id, c]));
    this.kennelsById = new Map(kennels.map((k) => [k.id, k]));
    this.allDogs = allDogs;
    this.contacts = contacts.filter((c) => !c.is_archived);
    this.kennels = kennels.filter((k) => !k.is_archived);
    this.findings = T.tidyFindings({
      litters: inScopeOnly(litters), pairings, sales: inScopeOnly(sales),
      studServices: inScopeOnly(studServices),
      dogs: dogsInScope(allDogs.filter((d) => !d.is_archived && !d.pedigree_only)),
      allDogs, contacts: this.contacts, kennels: this.kennels,
      flags: { contactsSection: flags.contactsSection, studServices: flags.studServices },
      today: this.today
    });
    this.findings = this.notDismissed(this.findings);
  }

  start() {
    return this.loop({
      looking: 'Let me look through your records for anything that doesn\'t line up…',
      none: 'Everything lines up. Nice work keeping your records tidy!',
      found: (findings) => {
        const counts = new Map();
        for (const f of findings) counts.set(f.kind, (counts.get(f.kind) || 0) + 1);
        const parts = [...counts].map(([k, n]) => `${n} ${KIND_WORDS[k][n === 1 ? 0 : 1]}`);
        return `I found ${plural(findings.length, 'thing')} to look at: ${esc(parts.join(', '))}. Let's go through them one at a time.`;
      },
      allDone: (n) => `That's everything. I fixed ${plural(n, 'thing')} with you. Your records line up!`,
      nothingDone: 'That\'s everything I found for now.',
      stopped: () => 'Okay, we\'ll stop here. Everything we fixed is saved.',
      stoppedEmpty: 'Okay. Ask me any time.'
    });
  }

  // --- Names ---------------------------------------------------------------------

  dog(id) { const d = this.dogsById.get(id); return d ? dogName(d) || 'Unnamed dog' : 'a dog that\'s gone'; }
  contact(id) { return this.contactsById.get(id)?.name || 'someone'; }
  kennel(id) { return this.kennelsById.get(id)?.kennel_name || 'a kennel'; }
  litter(l) { return litterLabel(l, this.dogsById); }
  b(text) { return `<strong>${esc(text)}</strong>`; }

  async handle(f) {
    switch (f.kind) {
      case 'litter-count': return this.litterCount(f);
      case 'pup-placed': return this.pupPlaced(f);
      case 'delivered-owned': return this.deliveredOwned(f);
      case 'litter-pairing-parents': return this.litterPairing(f);
      case 'pup-litter-parents': return this.pupParents(f);
      case 'dog-no-parents': return this.dogParents(f);
      case 'stud-unlinked': return this.stud(f);
      case 'breeder-no-kennel': return this.breederKennel(f);
      case 'kennel-no-contact': return this.kennelContact(f);
      case 'duplicate-dogs': return this.duplicate(f, 'dog');
      case 'duplicate-contacts': return this.duplicate(f, 'contact');
      default: return null;
    }
  }

  // --- Litters -------------------------------------------------------------------

  async litterCount(f) {
    const name = this.b(this.litter(f.litter));
    const said = f.more
      ? `${name} says ${plural(f.recorded, 'puppy was', 'puppies were')} born alive, but I have ${plural(f.actual, 'puppy record')} for it.`
      : `${name} says ${plural(f.recorded, 'puppy was', 'puppies were')} born alive, but I only have ${plural(f.actual, 'puppy record')}.`;
    const pick = await this.ask(f, said, [
      { label: `Change the count to ${f.actual}`, value: 'count', primary: f.more },
      ...(f.more ? [] : [{ label: f.recorded - f.actual === 1 ? 'Add the missing puppy' : 'Add the missing puppies', value: 'add', primary: true }])
    ]);
    if (pick === 'count') {
      await litterRepo.update(f.litter.id, T.countFix(f.litter, f.actual));
      return this.done(`Done. ${name} now says ${plural(f.actual, 'puppy', 'puppies')} born alive.`);
    }
    if (pick === 'add') return this.addPups(f);
    return pick;
  }

  // The puppies the litter's count says are missing, added in the chat: a name and
  // sex each, everything else from the litter (puppyDefaults.baseFromLitter, as the
  // Litter page's Add puppies does).
  async addPups(f) {
    const base = baseFromLitter(f.litter, this.dogsById.get(f.litter.dam_id));
    const name = this.b(this.litter(f.litter));
    if (!base.breed) {
      await this.chat.say(`${name}'s mom has no breed recorded, so her puppies can't take one from her. Add her breed first, then I can add them.`);
      return null;
    }
    const n = Math.min(f.recorded - f.actual, 20);
    const sexOpts = (v) => ['male', 'female'].map((x) => `<option value="${x}"${x === v ? ' selected' : ''}>${x === 'male' ? 'Boy' : 'Girl'}</option>`).join('');
    const res = await this.chat.form({
      title: `<strong>Tell me about the ${n === 1 ? 'missing puppy' : `${n} missing puppies`}.</strong><span class="kels-lead">A name and boy or girl for each. You can fill in the rest on each puppy later.</span>`,
      html: Array.from({ length: n }, (_, i) => `<div class="gl-plan-row">
        <input id="tp-name-${i}" type="text" autocomplete="off" placeholder="Puppy ${f.actual + i + 1}" aria-label="Puppy ${i + 1}: name">
        <select id="tp-sex-${i}" aria-label="Puppy ${i + 1}: boy or girl">${sexOpts(i % 2 ? 'female' : 'male')}</select></div>`).join(''),
      submitLabel: n === 1 ? 'Add the puppy' : 'Add the puppies',
      cancelLabel: 'Not now',
      submit: async (root) => {
        const made = [];
        for (let i = 0; i < n; i++) {
          const call = root.querySelector(`#tp-name-${i}`).value.trim() || `Puppy ${f.actual + i + 1}`;
          made.push(await dogRepo.create({ ...base, call_name: call, sex: root.querySelector(`#tp-sex-${i}`).value, disposition: 'undecided' }));
        }
        return { made };
      },
      reply: (out) => `Add ${plural(out.made.length, 'puppy', 'puppies')}`
    });
    if (!res.done) return null;
    return this.done(`Added! ${name} has all ${plural(f.recorded, 'puppy', 'puppies')} now.`);
  }

  async litterPairing(f) {
    const l = f.litter;
    const p = f.pairing;
    const diff = [f.sire && `the litter's sire is ${this.b(this.dog(l.sire_id))} but the breeding's is ${this.b(this.dog(p.sire_id))}`,
      f.dam && `the litter's dam is ${this.b(this.dog(l.dam_id))} but the breeding's is ${this.b(this.dog(p.dam_id))}`].filter(Boolean);
    const pick = await this.ask(f, `${this.b(this.litter(l))} and the breeding it came from don't agree: ${diff.join(', and ')}. Which is right?`, [
      { label: 'The litter (fix the breeding)', value: 'litter', primary: true },
      { label: 'The breeding (fix the litter)', value: 'pairing' }
    ]);
    if (pick === 'litter') {
      await pairingRepo.update(p.id, { sire_id: l.sire_id, dam_id: l.dam_id });
      return this.done('Done. The breeding now matches the litter.');
    }
    if (pick === 'pairing') {
      await litterRepo.update(l.id, { sire_id: p.sire_id, dam_id: p.dam_id });
      return this.done('Done. The litter now matches the breeding. I\'ll check its puppies next.');
    }
    return pick;
  }

  async pupParents(f) {
    const l = f.litter;
    const parents = `${this.b(this.dog(l.sire_id))} × ${this.b(this.dog(l.dam_id))}`;
    const names = (list) => esc(list.map((p) => dogName(p)).join(', '));
    if (f.fill.length) {
      const pick = await this.ask(f, `${plural(f.fill.length, 'puppy', 'puppies')} in ${this.b(this.litter(l))} ${f.fill.length === 1 ? 'is' : 'are'} missing a parent: ${names(f.fill)}. Fill in the litter's parents (${parents})?`, [
        { label: 'Yes, fill them in', value: 'fill', primary: true }
      ]);
      if (pick !== 'fill') return pick;
      for (const p of f.fill) await dogRepo.update(p.id, T.pupParentFix(p, l));
      await this.done(`Done. ${f.fill.length === 1 ? 'Their' : 'Each one\'s'} parents are on file.`);
    }
    if (f.conflict.length) {
      const pick = await this.ask(f, `${names(f.conflict)} ${f.conflict.length === 1 ? 'has' : 'have'} a different sire or dam than ${this.b(this.litter(l))} (${parents}). Use the litter's parents?`, [
        { label: 'Yes, use the litter\'s', value: 'fix', primary: true }
      ], { never: 'They\'re right, don\'t ask again' });
      if (pick !== 'fix') return pick;
      for (const p of f.conflict) await dogRepo.update(p.id, T.pupParentFix(p, l));
      await this.done('Done. They match their litter now.');
    }
    return null;
  }

  // --- Sales ---------------------------------------------------------------------

  async pupPlaced(f) {
    const d = f.dog;
    const pick = await this.ask(f, `${this.b(dogName(d))} has a sale to ${this.b(this.contact(f.sale?.buyer_contact_id))} (${esc(label(SALE_STATUS, f.sale?.status))}), but their plan says ${esc(label(DISPOSITION, d.disposition || 'undecided'))}. Mark them Placed?`, [
      { label: 'Yes, mark Placed', value: 'yes', primary: true }
    ]);
    if (pick !== 'yes') return pick;
    await dogRepo.update(d.id, { disposition: 'placed' });
    return this.done(`Done. ${esc(dogName(d))} is Placed.`);
  }

  async deliveredOwned(f) {
    const d = f.dog;
    const buyer = this.contact(f.sale.buyer_contact_id);
    const name = esc(dogName(d));
    const said = `${this.b(dogName(d))}'s sale to ${this.b(buyer)} is Delivered, but ${name} is still on your roster as your dog.`;
    if (!editionFlags.externalOwnership) {
      const pick = await this.ask(f, `${said} Remove ${name} from your program? This can't be undone here, but ${name} stays in your dogs' pedigrees and on the sale.`, [
        { label: 'Remove from my roster', value: 'depart', primary: true }
      ], { never: 'Keep them, don\'t ask again' });
      if (pick !== 'depart') return pick;
      await dogRepo.archive(d.id);
      return this.done(`Done. ${name} has left your roster.`);
    }
    const pick = await this.ask(f, `${said} Who owns ${name} now?`, [
      { label: `${buyer} does`, value: 'external', primary: true },
      { label: `I co-own ${d.sex === 'female' ? 'her' : d.sex === 'male' ? 'him' : 'them'} with ${buyer}`, value: 'co' }
    ], { never: 'I still own them, don\'t ask again' });
    // The same changes the Sale page's Delivered save makes (goHome.deliveredOwnershipChanges).
    if (pick === 'external' || pick === 'co') {
      const choice = pick === 'co' ? 'co_owned' : 'external';
      await dogRepo.update(d.id, deliveredOwnershipChanges(d, choice, { ownerId: f.sale.buyer_contact_id, buyerId: f.sale.buyer_contact_id, today: this.today }));
      return this.done(choice === 'external' ? `Done. ${name} is now ${esc(buyer)}'s dog. You'll still see ${name} in pedigrees.` : `Done. ${name} is co-owned with ${esc(buyer)}.`);
    }
    return pick;
  }

  // --- A dog's parents -----------------------------------------------------------

  async dogParents(f) {
    const d = f.dog;
    const words = f.missing.map((r) => ROLE[r].word).join(' or ');
    const pick = await this.ask(f, `${this.b(dogName(d))} doesn't have a ${esc(words)} on file. Do you know who ${f.missing.length > 1 ? 'they are' : 'it is'}?`, [
      { label: 'Yes, let\'s add them', value: 'yes', primary: true }
    ], { never: 'Unknown, don\'t ask again' });
    if (pick !== 'yes') return pick;
    for (const role of f.missing) {
      const r = await this.setParent(d, role);
      if (r === 'stop') return 'stop';
    }
    return null;
  }

  async setParent(dog, role) {
    const R = ROLE[role];
    await this.chat.say(`<strong>Who is ${esc(dogName(dog))}'s ${R.word}?</strong>`, { typing: 500 });
    const pick = await this.chat.choose([
      { label: 'A dog already in KennelOS', value: 'pick', primary: true },
      { label: 'A dog that isn\'t in KennelOS yet', value: 'new' },
      { label: `Skip the ${R.word}`, value: 'skip' }
    ]);
    if (pick === 'skip') return null;
    const parentId = pick === 'pick' ? await this.pickParent(dog, R) : await this.newParent(dog, R);
    if (!parentId) return null;
    await dogRepo.update(dog.id, { [R.field]: parentId });
    return this.done(`Done. ${this.b(this.dog(parentId))} is ${esc(dogName(dog))}'s ${R.word}.`);
  }

  // Dogs of the right sex, same breed first; never the dog itself.
  async pickParent(dog, R) {
    const breed = T.normName(dog.breed);
    const options = this.allDogs
      .filter((d) => !d.is_archived && d.id !== dog.id && (d.sex === R.sex || !d.sex || d.sex === 'unknown'))
      .sort((a, b) => (T.normName(b.breed) === breed) - (T.normName(a.breed) === breed) || dogName(a).localeCompare(dogName(b)));
    if (!options.length) {
      await this.chat.say(`You don't have any ${R.sex === 'male' ? 'males' : 'females'} in KennelOS yet. Let's add the ${R.word}.`);
      return this.newParent(dog, R);
    }
    const res = await this.chat.form({
      title: '',
      html: field(`${cap(R.word)}`, `<select id="td-parent">${options.map((d) => `<option value="${esc(d.id)}">${esc(dogName(d))}${d.registered_name && d.call_name ? ` (${esc(d.registered_name)})` : ''}${T.normName(d.breed) !== breed ? ` · ${esc(d.breed || '')}` : ''}</option>`).join('')}</select>`),
      submitLabel: 'Use this dog',
      cancelLabel: 'Skip',
      // form() shows a returned string as a problem, so the pick goes back as { id }.
      submit: async (root) => { const id = root.querySelector('#td-parent').value; return id ? { id } : 'Pick a dog.'; },
      reply: (r) => this.dog(r.id)
    });
    return res.done ? res.result.id : null;
  }

  async newParent(dog, R) {
    const statuses = ['active_breeding', 'retired_breeding', ...(editionFlags.fullDogStatuses ? ['pet_home'] : []), 'deceased'];
    const res = await this.chat.form({
      title: `<strong>Tell me about the ${R.word}.</strong><span class="kels-lead">Is it your dog, or somebody else's? Somebody else's goes in just for the pedigree, by its registered name (no owner needed).</span>`,
      html: `<div class="field gl-field"><label>Whose dog?</label>
          <label class="td-radio"><input type="radio" name="td-whose" value="mine" checked> Mine</label>
          <label class="td-radio"><input type="radio" name="td-whose" value="pedigree"> Somebody else's (just for the pedigree)</label>
        </div>
        <div id="td-call-wrap">${field('Call name', '<input id="td-call" type="text" autocomplete="off">')}</div>
        ${field('Registered name', '<input id="td-reg" type="text" autocomplete="off">', 'As it reads on the pedigree')}
        ${field('Registration number (optional)', '<input id="td-num" type="text" autocomplete="off">')}
        <div id="td-status-wrap">${field('Status', `<select id="td-status">${statuses.map((s) => `<option value="${s}">${esc(label(DOG_STATUS, s))}</option>`).join('')}</select>`)}</div>`,
      wire: (root) => {
        // A pedigree names a dog by its registered name: that's what's asked for
        // somebody else's dog; a call name only for hers.
        const sync = () => {
          const mine = root.querySelector('input[name="td-whose"]:checked').value === 'mine';
          root.querySelector('#td-status-wrap').hidden = !mine;
          root.querySelector('#td-call-wrap').hidden = !mine;
          root.querySelector('#td-reg').closest('.field').querySelector('label').textContent = mine ? 'Registered name (optional)' : 'Registered name';
        };
        sync();
        root.querySelectorAll('input[name="td-whose"]').forEach((r) => r.addEventListener('change', sync));
      },
      submitLabel: 'Next',
      cancelLabel: 'Skip',
      submit: async (root) => {
        const v = {
          call: root.querySelector('#td-call').value.trim(), reg: root.querySelector('#td-reg').value.trim(),
          num: root.querySelector('#td-num').value.trim(),
          mine: root.querySelector('input[name="td-whose"]:checked').value === 'mine',
          status: root.querySelector('#td-status').value
        };
        if (!v.mine) v.call = '';
        if (v.mine ? !v.call : !v.reg) return v.mine ? 'What\'s the dog\'s call name?' : 'What\'s the registered name? It\'s how a pedigree names the dog.';
        return v;
      },
      reply: (v) => v.call || v.reg
    });
    if (!res.done) return null;
    const v = res.result;
    // Somebody already on file? dogSearch: both names, both ways, then the
    // number, breed and sex. The same number is that dog (she says so and uses
    // it); the rest are offered first, so nobody is entered twice.
    const found = findDogMatches(this.allDogs, { callName: v.call, registeredName: v.reg, registrationNumber: v.num, breed: dog.breed, sex: R.sex }, { excludeIds: [dog.id] });
    if (found[0]?.strength === 'certain') {
      await this.chat.say(`That number is ${this.b(dogName(found[0].dog))}, already in KennelOS, so I'll use ${R.sex === 'female' ? 'her' : 'him'}.`);
      return found[0].dog.id;
    }
    const matches = found.map((m) => m.dog);
    const why = new Map(found.map((m) => [m.dog.id, matchReason(m)]));
    if (matches.length) {
      await this.chat.say(`I already have ${matches.length === 1 ? 'a dog' : 'dogs'} like that. Is it one of these?`);
      const id = await this.chat.choose([
        ...matches.slice(0, 6).map((d) => ({ label: dogName(d), sub: [why.get(d.id), d.registered_name, d.breed].filter(Boolean).join(' · '), value: d.id })),
        { label: 'No, add a new dog', value: '' }
      ]);
      if (id) return id;
    }
    const base = { call_name: v.call, registered_name: v.reg, registration_number: v.num, sex: R.sex, breed: dog.breed };
    try {
      const made = v.mine
        ? await dogRepo.create({ ...base, ownership_type: 'owned', status: v.status,
          kennel_id: ['owned', 'co_owned'].includes(dog.ownership_type) ? dog.kennel_id : await resolveKennelIdForWrite() })
        : await dogRepo.createPedigreeOnly(base);
      this.dogsById.set(made.id, made);
      return made.id;
    } catch (e) {
      // Lite's cap: the app's usual upgrade notice, in her bubble. Nothing else.
      if (e instanceof CapExceededError) {
        renderUpgradeNudge(await this.chat.say(''), e);
        return null;
      }
      await this.chat.say(`I couldn't add that dog: ${esc(e?.message || String(e))}`);
      return null;
    }
  }

  // --- Stud services (Pro) -------------------------------------------------------

  async stud(f) {
    const s = f.stud;
    const what = `${this.b(this.dog(s.our_dog_id))} × ${this.b(this.dog(s.partner_dog_id))}`;
    const when = s.sent_date ? ` (${esc(fmtDate(s.sent_date))})` : '';
    const said = f.candidates.length
      ? `Your stud service ${what}${when} isn't linked to its breeding. I found ${f.candidates.length === 1 ? 'one' : 'some'} that could be it.`
      : `Your stud service ${what}${when} is past its date, and there's no breeding for it.`;
    const pick = await this.ask(f, said, [
      ...f.candidates.map((p, i) => ({
        label: `Link the ${p.planned_date ? fmtDate(p.planned_date) : 'undated'} breeding`,
        sub: label(PAIRING_STATUS, p.status), value: `link:${p.id}`, primary: i === 0
      })),
      { label: 'Record the breeding', value: 'new', primary: !f.candidates.length }
    ]);
    if (pick?.startsWith('link:')) {
      await studServiceRepo.update(s.id, { pairing_id: pick.slice(5) });
      return this.done('Done. They\'re linked.');
    }
    if (pick === 'new') return this.recordBreeding(s, what);
    return pick;
  }

  // The stud service's breeding, recorded in the chat: its parents come from the
  // stud service (ours is the sire or the dam by its sex, studRules.studParents,
  // as the Pairing page's stud_service link fills them), she gives the first date
  // and how it went, and the stud service is linked to it (StudService owns
  // pairing_id).
  async recordBreeding(s, what) {
    const { sireId: sire, damId: dam } = studParents(s, this.dogsById) || {};
    if (!sire || !dam) {
      await this.chat.say('I can\'t tell which dog is the stud: neither dog on this stud service has a sex on file. Add it to one of them first.');
      return null;
    }
    const statuses = PAIRING_STATUS.filter((t) => t.value !== 'planned');
    const res = await this.chat.form({
      title: `<strong>Tell me about the breeding.</strong><span class="kels-lead">${what}</span>`,
      html: `${field('First breeding date', `<input id="tb-date" type="date" value="${esc(s.sent_date || '')}">`)}
        ${field('How did it go?', `<select id="tb-status">${statuses.map((t) => `<option value="${esc(t.value)}"${t.value === 'bred' ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}</select>`)}`,
      submitLabel: 'Save the breeding',
      cancelLabel: 'Not now',
      submit: async (root) => {
        const date = root.querySelector('#tb-date').value;
        if (!date) return 'Pick the date of the first breeding.';
        const status = root.querySelector('#tb-status').value;
        const pairing = await pairingRepo.create({
          sire_id: sire, dam_id: dam, pairing_type: 'actual', status, planned_date: date,
          expected_due_date: addDaysToYMD(date, 63),
          kennel_id: await resolveKennelIdForWrite({ inheritFrom: [this.dogsById.get(dam), this.dogsById.get(sire)] })
        });
        await studServiceRepo.update(s.id, { pairing_id: pairing.id });
        return { pairing };
      },
      reply: (out) => `${label(PAIRING_STATUS, out.pairing.status)}, ${fmtDate(out.pairing.planned_date)}`
    });
    if (!res.done) return null;
    // Our stud's outside breeding: her litter isn't ours to record.
    return this.done(res.result.pairing.status === 'whelped' && ourRole(s, this.dogsById) !== 'stud'
      ? 'Saved and linked. When we\'re done here, pick <strong>Record a new litter</strong> and I\'ll walk you through the puppies.'
      : 'Saved, and the stud service is linked to it.');
  }

  // --- Breeders & kennels (Pro) --------------------------------------------------

  async breederKennel(f) {
    const c = f.contact;
    const pick = await this.ask(f, `${this.b(c.name)} is a breeder, but isn't linked to a kennel.`, [
      ...(this.kennels.length ? [{ label: 'Pick their kennel', value: 'pick', primary: true }] : []),
      { label: 'Add their kennel', value: 'new', primary: !this.kennels.length }
    ]);
    let kennelId = null;
    if (pick === 'pick') {
      const opts = [...this.kennels].sort((a, b) => a.kennel_name.localeCompare(b.kennel_name));
      const res = await this.chat.form({
        title: '',
        html: field('Kennel', `<select id="td-kennel">${opts.map((k) => `<option value="${esc(k.id)}">${esc(k.kennel_name)}${k.is_own_kennel ? ' (yours)' : ''}</option>`).join('')}</select>`),
        submitLabel: 'Link', cancelLabel: 'Skip',
        submit: async (root) => { const id = root.querySelector('#td-kennel').value; return id ? { id } : 'Pick a kennel.'; },
        reply: (r) => this.kennel(r.id)
      });
      if (res.done) kennelId = res.result.id;
    } else if (pick === 'new') {
      kennelId = await this.newKennel();
    } else return pick;
    if (!kennelId) return null;
    await contactRepo.update(c.id, { kennel_id: kennelId });
    return this.done(`Done. ${esc(c.name)} is with ${this.b(this.kennel(kennelId))}.`);
  }

  async newKennel() {
    let asked = null; // a near name is asked about once; Add again keeps hers
    const res = await this.chat.form({
      title: '',
      html: kennelNameField('td-kname'),
      submitLabel: 'Add', cancelLabel: 'Skip',
      submit: async (root) => {
        const name = root.querySelector('#td-kname').value.trim();
        if (!name) return 'What\'s the kennel called?';
        const like = similarNamed(this.kennels.filter((k) => !k.is_own_kennel), name, (k) => k.kennel_name);
        if (like && like.kennel_name.trim().toLowerCase() !== name.toLowerCase() && asked !== name) {
          asked = name;
          return `Is that ${like.kennel_name}, already in your kennels? Tap Skip and pick it instead, or Add again to add it as you typed it.`;
        }
        const { kennel: k } = await kennelRepo.findOrCreateOutside(name);
        this.kennelsById.set(k.id, k);
        return { id: k.id };
      },
      reply: (r) => this.kennel(r.id)
    });
    return res.done ? res.result.id : null;
  }

  async kennelContact(f) {
    const k = f.kennel;
    const pick = await this.ask(f, `${this.b(k.kennel_name)} isn't linked to anyone in your contacts${f.used ? '' : ', and none of your dogs name it either'}.`, [
      ...(this.contacts.length ? [{ label: 'Pick their contact', value: 'pick', primary: true }] : []),
      { label: 'Add a contact', value: 'new', primary: !this.contacts.length },
      ...(f.used ? [] : [{ label: 'Archive the kennel', value: 'archive' }])
    ], { never: 'No contact for them, don\'t ask again' });
    if (pick === 'archive') {
      await kennelRepo.archive(k.id);
      return this.done(`Done. ${esc(k.kennel_name)} is archived.`);
    }
    let contactId = null;
    if (pick === 'pick') {
      // Breeders and people with no kennel first; the note says who'd move.
      const rank = (c) => (c.kennel_id ? 2 : 0) + ((c.contact_type || []).includes('breeder') ? 0 : 1);
      const opts = [...this.contacts].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
      const res = await this.chat.form({
        title: '',
        html: field('Contact', `<select id="td-contact">${opts.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}${c.kennel_id ? ` (now with ${esc(this.kennel(c.kennel_id))})` : ''}</option>`).join('')}</select>`),
        submitLabel: 'Link', cancelLabel: 'Skip',
        submit: async (root) => { const id = root.querySelector('#td-contact').value; return id ? { id } : 'Pick a contact.'; },
        reply: (r) => this.contact(r.id)
      });
      if (res.done) {
        contactId = res.result.id;
        await contactRepo.update(contactId, { kennel_id: k.id });
        await contactRepo.ensureType(contactId, 'breeder');
      }
    } else if (pick === 'new') {
      let asked = null; // a near name is asked about once; Add again keeps hers
      const res = await this.chat.form({
        title: '',
        html: contactFields('td-c'),
        submitLabel: 'Add', cancelLabel: 'Skip',
        submit: async (root) => {
          const { name, email, phone } = readContactFields(root, 'td-c');
          if (!name) return 'What\'s their name?';
          const like = similarNamed(this.contacts, name, (x) => x.name);
          if (like && asked !== name) {
            asked = name;
            return `Is that ${like.name}, already in your contacts? Tap Skip and pick them instead, or Add again to add them as you typed it.`;
          }
          const c = await contactRepo.create({ name, email, phone, contact_type: ['breeder'], kennel_id: k.id });
          this.contactsById.set(c.id, c);
          return { id: c.id };
        },
        reply: (r) => this.contact(r.id)
      });
      if (res.done) contactId = res.result.id;
    } else return pick;
    if (!contactId) return null;
    return this.done(`Done. ${this.b(this.contact(contactId))} is with ${esc(k.kennel_name)}.`);
  }

  // --- Duplicates ----------------------------------------------------------------

  // One record as a line of plain text, to tell two apart (callers esc() it).
  describe(kind, r) {
    if (kind === 'contact') {
      return [r.email, r.phone, r.address, r.kennel_id && this.kennel(r.kennel_id)].filter(Boolean).join(' · ') || 'No other details';
    }
    return [r.registered_name, r.registration_number && `#${r.registration_number}`, r.date_of_birth && `born ${fmtDate(r.date_of_birth)}`,
      r.pedigree_only ? 'pedigree only' : label(OWNERSHIP_TYPE, r.ownership_type),
      r.owner_contact_id && `owner ${this.contact(r.owner_contact_id)}`].filter(Boolean).join(' · ') || 'No other details';
  }

  async duplicate(f, kind) {
    const nameOf = (r) => (kind === 'dog' ? dogName(r) : r.name) || 'Unnamed';
    const why = kind === 'contact'
      ? `They have the same name and the same ${esc(f.shared.join(' and '))}.`
      : f.strength === 'certain'
        ? `They have the same ${esc(f.reasons.join(' and '))}.`
        : `They have the same name, breed and sex${f.matches.length ? `, and the same ${esc(f.matches.join(', '))}` : ''}.${f.unknown.length ? ` I can't tell more: one of them has no ${esc(f.unknown.slice(0, 3).join(', '))}.` : ''}`;
    const word = kind === 'dog' ? 'dog' : 'person';
    const pick = await this.ask(f, `These two ${kind === 'dog' ? 'dog records' : 'contacts'} might be the same ${word}. ${why}
      <ul class="kels-list"><li>${this.b(nameOf(f.a))}: ${esc(this.describe(kind, f.a))}</li><li>${this.b(nameOf(f.b))}: ${esc(this.describe(kind, f.b))}</li></ul>`, [
      { label: 'Yes, merge them', value: 'merge', primary: f.strength === 'certain' || kind === 'contact' }
    ], { never: `Not the same ${word}` });
    if (pick !== 'merge') return pick;

    const suggested = suggestKeep(f.a, f.b);
    await this.chat.say('<strong>Which record should I keep?</strong><span class="kels-lead">Everything that points at the other one moves to it, and the other one is archived.</span>', { typing: 500 });
    const keepId = await this.chat.choose([f.a, f.b].map((r) => ({
      label: nameOf(r), sub: this.describe(kind, r), value: r.id, primary: r.id === suggested.id
    })).concat([{ label: 'Never mind', value: '' }]));
    if (!keepId) return null;
    const keep = keepId === f.a.id ? f.a : f.b;
    const drop = keepId === f.a.id ? f.b : f.a;

    const choices = {};
    const conflicts = mergeConflicts(kind, keep, drop);
    if (conflicts.length) {
      const show = (c, v) => {
        if (c.group) return esc([v.pedigree_only ? 'Pedigree only' : label(OWNERSHIP_TYPE, v.ownership_type), label(DOG_STATUS, v.status), v.owner_contact_id && this.contact(v.owner_contact_id)].filter(Boolean).join(' · '));
        if (c.ref === 'dog') return esc(this.dog(v));
        if (c.ref === 'kennel') return esc(this.kennel(v));
        if (c.ref === 'litter') return esc(this.littersById.get(v) ? this.litter(this.littersById.get(v)) : 'a litter');
        if (c.date) return esc(fmtDate(v));
        return esc(v);
      };
      const res = await this.chat.form({
        title: '<strong>They disagree on a few things. Which should I keep?</strong>',
        html: conflicts.map((c, i) => `<div class="field gl-field"><label>${esc(c.label)}</label>
          <label class="td-radio"><input type="radio" name="td-m${i}" value="keep" checked> ${show(c, c.keep)}</label>
          <label class="td-radio"><input type="radio" name="td-m${i}" value="drop"> ${show(c, c.drop)}</label></div>`).join(''),
        submitLabel: 'Merge', cancelLabel: 'Never mind',
        submit: async (root) => {
          conflicts.forEach((c, i) => { choices[c.key] = root.querySelector(`input[name="td-m${i}"]:checked`).value; });
          return true;
        },
        reply: () => 'Merge them'
      });
      if (!res.done) return null;
    }
    try {
      const { moved } = await mergeRecords(kind, keep.id, drop.id, choices);
      return this.done(`Merged. ${this.b(nameOf(keep))} is the one record now${moved ? `, and the ${plural(moved, 'record')} that pointed at the other one ${moved === 1 ? 'points' : 'point'} at it` : ''}.`);
    } catch (e) {
      await this.chat.say(`I couldn't merge them: ${esc(e?.message || String(e))}`);
      return null;
    }
  }
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);


