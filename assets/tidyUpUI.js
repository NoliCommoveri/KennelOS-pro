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
import { dogMatches } from '../data/guidedLitter.js';
import * as T from '../data/tidyRules.js';
import { mergeConflicts, suggestKeep, mergeRecords } from '../data/recordMerge.js';
import { CapExceededError } from '../data/repoBase.js';
import { esc, fmtDate, todayYMD } from './ui.js';
import { renderUpgradeNudge } from './upgradeNudge.js';
import { FindingsTask, plural } from './kelsFindings.js';

const pagesPrefix = () => (location.pathname.includes('/pages/') ? '' : 'pages/');
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
      ...(f.more ? [] : [{ label: 'Open the litter to add puppies', value: 'open', primary: true }])
    ]);
    if (pick === 'count') {
      await litterRepo.update(f.litter.id, T.countFix(f.litter, f.actual));
      return this.done(`Done. ${name} now says ${plural(f.actual, 'puppy', 'puppies')} born alive.`);
    }
    if (pick === 'open') { location.href = `${pagesPrefix()}litter.html?id=${encodeURIComponent(f.litter.id)}`; return 'left'; }
    return pick;
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
    if (pick === 'external') {
      await dogRepo.update(d.id, { ownership_type: 'external', owner_contact_id: f.sale.buyer_contact_id, status: 'external_reference', status_date: this.today });
      return this.done(`Done. ${name} is now ${esc(buyer)}'s dog. You'll still see ${name} in pedigrees.`);
    }
    if (pick === 'co') {
      const co = [...new Set([...(d.co_owner_contact_ids || []), f.sale.buyer_contact_id])];
      await dogRepo.update(d.id, { ownership_type: 'co_owned', co_owner_contact_ids: co });
      return this.done(`Done. ${name} is co-owned with ${esc(buyer)}.`);
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
      submit: async (root) => root.querySelector('#td-parent').value || 'Pick a dog.',
      reply: (id) => this.dog(id)
    });
    return res.done ? res.result : null;
  }

  async newParent(dog, R) {
    const statuses = ['active_breeding', 'retired_breeding', ...(editionFlags.fullDogStatuses ? ['pet_home'] : []), 'deceased'];
    const res = await this.chat.form({
      title: `<strong>Tell me about the ${R.word}.</strong><span class="kels-lead">Is it your dog, or somebody else's? Somebody else's goes in just for the pedigree (no owner needed).</span>`,
      html: `${field('Call name', '<input id="td-call" type="text" autocomplete="off">')}
        ${field('Registered name (optional)', '<input id="td-reg" type="text" autocomplete="off">')}
        ${field('Registration number (optional)', '<input id="td-num" type="text" autocomplete="off">')}
        <div class="field gl-field"><label>Whose dog?</label>
          <label class="td-radio"><input type="radio" name="td-whose" value="mine" checked> Mine</label>
          <label class="td-radio"><input type="radio" name="td-whose" value="pedigree"> Somebody else's (just for the pedigree)</label>
        </div>
        <div id="td-status-wrap">${field('Status', `<select id="td-status">${statuses.map((s) => `<option value="${s}">${esc(label(DOG_STATUS, s))}</option>`).join('')}</select>`)}</div>`,
      wire: (root) => {
        const sync = () => { root.querySelector('#td-status-wrap').hidden = root.querySelector('input[name="td-whose"]:checked').value !== 'mine'; };
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
        if (!v.call && !(v.reg && !v.mine)) return v.mine ? 'What\'s the dog\'s call name?' : 'Type a call name or a registered name.';
        return v;
      },
      reply: (v) => v.call || v.reg
    });
    if (!res.done) return null;
    const v = res.result;
    // Somebody already on file by that name? Offer them first, so nobody is entered twice.
    const matches = dogMatches(this.allDogs, { name: v.call || v.reg, registeredName: v.reg, sex: R.sex }).filter((d) => d.id !== dog.id);
    if (matches.length) {
      await this.chat.say(`I already have ${matches.length === 1 ? 'a dog' : 'dogs'} by that name. Is it one of these?`);
      const id = await this.chat.choose([
        ...matches.slice(0, 6).map((d) => ({ label: dogName(d), sub: [d.registered_name, d.breed].filter(Boolean).join(' · '), value: d.id })),
        { label: 'No, add a new dog', value: '' }
      ]);
      if (id) return id;
    }
    const base = { call_name: v.call, registered_name: v.reg, registration_number: v.num, sex: R.sex, breed: dog.breed };
    try {
      const made = v.mine
        ? await dogRepo.create({ ...base, ownership_type: 'owned', status: v.status,
          kennel_id: ['owned', 'co_owned'].includes(dog.ownership_type) ? dog.kennel_id : await resolveKennelIdForWrite() })
        : await dogRepo.create({ ...base, ownership_type: 'external', status: 'external_reference', pedigree_only: true });
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
    if (pick === 'new') { location.href = `${pagesPrefix()}pairing.html?new=1&stud_service=${encodeURIComponent(s.id)}`; return 'left'; }
    return pick;
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
        submit: async (root) => root.querySelector('#td-kennel').value || 'Pick a kennel.',
        reply: (id) => this.kennel(id)
      });
      if (res.done) kennelId = res.result;
    } else if (pick === 'new') {
      kennelId = await this.newKennel();
    } else return pick;
    if (!kennelId) return null;
    await contactRepo.update(c.id, { kennel_id: kennelId });
    return this.done(`Done. ${esc(c.name)} is with ${this.b(this.kennel(kennelId))}.`);
  }

  async newKennel() {
    const res = await this.chat.form({
      title: '',
      html: field('Kennel name', '<input id="td-kname" type="text" autocomplete="off">'),
      submitLabel: 'Add', cancelLabel: 'Skip',
      submit: async (root) => {
        const name = root.querySelector('#td-kname').value.trim();
        if (!name) return 'What\'s the kennel called?';
        const k = await kennelRepo.create({ kennel_name: name, is_own_kennel: false });
        this.kennelsById.set(k.id, k);
        return k.id;
      },
      reply: (id) => this.kennel(id)
    });
    return res.done ? res.result : null;
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
        submit: async (root) => root.querySelector('#td-contact').value || 'Pick a contact.',
        reply: (id) => this.contact(id)
      });
      if (res.done) {
        contactId = res.result;
        await contactRepo.update(contactId, { kennel_id: k.id });
        await contactRepo.ensureType(contactId, 'breeder');
      }
    } else if (pick === 'new') {
      const res = await this.chat.form({
        title: '',
        html: `${field('Name', '<input id="td-cname" type="text" autocomplete="off">')}
          ${field('Email (optional)', '<input id="td-cemail" type="email" autocomplete="off">')}
          ${field('Phone (optional)', '<input id="td-cphone" type="tel" autocomplete="off">')}`,
        submitLabel: 'Add', cancelLabel: 'Skip',
        submit: async (root) => {
          const name = root.querySelector('#td-cname').value.trim();
          if (!name) return 'What\'s their name?';
          const c = await contactRepo.create({ name, email: root.querySelector('#td-cemail').value.trim(), phone: root.querySelector('#td-cphone').value.trim(), contact_type: ['breeder'], kennel_id: k.id });
          this.contactsById.set(c.id, c);
          return c.id;
        },
        reply: (id) => this.contact(id)
      });
      if (res.done) contactId = res.result;
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

function field(labelText, inputHtml, hint = '') {
  return `<div class="field gl-field"><label>${esc(labelText)}</label>${inputHtml}${hint ? `<span class="field-hint">${esc(hint)}</span>` : ''}</div>`;
}

