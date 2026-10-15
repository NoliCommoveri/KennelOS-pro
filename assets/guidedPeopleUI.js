// guidedPeopleUI.js — Kels's "Add people" task (Pro: editionFlags.contactsSection):
// the screens, drawn by the shared step engine (assets/kelsSteps.js) in the chat on
// pages/kels.html. Several people at once: a roster of names and what each is to
// her, her vet if she has none, how she met them, each person's details (and
// "Is this them?" for someone already in her contacts), each breeder's kennel, the
// breeders on file with no kennel, and one review she approves. The steps, checks,
// review lines and the save live in data/guidedPeople.js; this module draws them
// and keeps the draft (settings.js guidedPeopleDraft).
//
// After the save: her dogs with no breeder kennel, to link to a kennel ("Do you
// want to link any kennels to dogs you own as the kennel who bred it?"); then,
// with the waitlist (editionFlags.waitlist, a list set up), a buyer put on it in
// the chat (assets/kelsApplicant.js, imported only then), linked to their contact.
// Pro-only (proPages.js); pages/kels.js imports it on start.
import { contactRepo } from '../data/contactRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { ownKennels } from '../data/kennelScope.js';
import { editionFlags } from '../data/editionConfig.js';
import { waitlistIsSetUp } from '../data/waitlistRules.js';
import { getGuidedPeopleDraft, setGuidedPeopleDraft, clearGuidedPeopleDraft } from '../data/settings.js';
import { CONTACT_TYPE, descriptor } from '../data/vocab.js';
import * as G from '../data/guidedPeople.js';
import { esc } from './ui.js';
import {
  StepConversation, tile, field, input, options, val, pagesPrefix,
  kennelPicker, wireKennelPicker, readKennelPicker, VET_WHY, VET_NAME_HINT
} from './kelsSteps.js';

// --- The data the screens read ----------------------------------------------------

async function loadData() {
  const [contacts, kennels, own, sources] = await Promise.all([
    contactRepo.getAll({ includeArchived: false }),
    kennelRepo.getAll({ includeArchived: false }),
    ownKennels(),
    contactRepo.getFirstContactSources()
  ]);
  return {
    contacts: contacts.sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    contactsById: new Map(contacts.map((c) => [c.id, c])),
    kennels,
    kennelsById: new Map(kennels.map((k) => [k.id, k])),
    own: own.filter((k) => !k.is_archived),
    outsideKennels: kennels.filter((k) => !k.is_own_kennel),
    sources
  };
}

const typeText = (types) => (types || []).map((t) => descriptor(CONTACT_TYPE, t).label).join(', ');

// --- Screens ------------------------------------------------------------------------

function screens(draft, data) {
  const sourceList = `<datalist id="gp-sources">${data.sources.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>`;
  const rosterRows = () => draft.people.filter((p) => !p.fromVet);

  return {
    roster: () => ({
      title: 'Who are we adding?',
      html: `<p class="gl-lead">Type each person's name and what they are to you. Tap <strong>+ Another person</strong> for the next one.</p>
        <div class="gd-roster">
          ${rosterRows().map((p, i) => `<div class="gd-row gp-row">
            ${input(`gp-name-${p.key}`, p.name, { placeholder: i ? 'Name' : 'e.g. Pat Smith', label: `Person ${i + 1}'s name` })}
            <select id="gp-type-${p.key}" aria-label="What ${esc(p.name || 'they are')} to you">${options(G.ROSTER_TYPES, p.type, 'What are they to you?')}</select>
            ${rosterRows().length > 1 ? `<button type="button" class="btn gd-remove" data-act="remove" data-key="${esc(p.key)}" aria-label="Take ${esc(p.name || 'this row')} off">✕</button>` : '<span></span>'}
          </div>`).join('')}
        </div>
        ${rosterRows().length < G.MAX_PEOPLE ? '<button type="button" class="btn gl-more" data-act="add">+ Another person</button>' : ''}`,
      read: (root) => {
        for (const p of rosterRows()) {
          const n = root.querySelector(`#gp-name-${p.key}`);
          if (n) p.name = n.value.trim();
          const t = root.querySelector(`#gp-type-${p.key}`);
          if (t) p.type = t.value;
        }
      },
      onAct: (act, root, btn) => {
        if (act === 'add') { draft.people.push(G.newPerson()); return 'read-redraw'; }
        if (act === 'remove') {
          draft.people = draft.people.filter((p) => p.key !== btn.dataset.key);
          return 'redraw';
        }
        return null;
      },
      wire: (root) => {
        const empty = [...root.querySelectorAll('.gp-row input')].find((el) => !el.value);
        empty?.focus({ preventScroll: true });
      },
      after: () => G.afterRoster(draft)
    }),

    vet: () => {
      const v = draft.vet;
      return {
        title: 'Do you have a vet you\'d like to add?',
        html: `<p class="gl-lead">${esc(VET_WHY)}</p>
          <div class="gl-tiles gl-tiles-small">
            ${tile('vet', 'add', 'Yes, add my vet', { selected: v.answer === 'add' })}
            ${data.contacts.length ? tile('vet', 'onfile', 'They\'re in my contacts', { selected: v.answer === 'onfile' }) : ''}
            ${tile('vet', 'no', 'Not now', { selected: v.answer === 'no' })}
          </div>
          ${v.answer === 'add' ? field('Your vet', input('gp-vet-name', v.name, { placeholder: 'e.g. Lakeside Animal Clinic' }), VET_NAME_HINT) : ''}
          ${v.answer === 'onfile' ? field('Your vet', `<select id="gp-vet-pick"><option value="">Pick them…</option>${data.contacts.map((c) => `<option value="${esc(c.id)}"${v.contactId === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`) : ''}`,
        onTile: (value) => {
          v.answer = value;
          return value === 'no' ? true : 'redraw';
        },
        read: (root) => {
          if (v.answer === 'add') v.name = val(root, 'gp-vet-name');
          if (v.answer === 'onfile') v.contactId = val(root, 'gp-vet-pick') || null;
        },
        wire: (root) => root.querySelector('#gp-vet-name')?.focus({ preventScroll: true }),
        after: () => G.afterVet(draft)
      };
    },

    common: () => ({
      title: 'How did you meet them?',
      html: `<p class="gl-lead">Optional. I'll fill it in on each person, and you can change it there.</p>
        ${field('Met through', input('gp-c-source', draft.common.first_contact_source, { list: 'gp-sources', placeholder: 'e.g. Facebook, a show, a referral' }))}${sourceList}`,
      read: (root) => { draft.common.first_contact_source = val(root, 'gp-c-source'); },
      after: () => G.fillFromCommon(draft)
    }),

    person: (i) => {
      const p = draft.people[i];
      const n = i + 1;
      const many = draft.people.length > 1;
      return {
        title: `Tell me about ${esc(p.name)}${many ? ` (${n} of ${draft.people.length})` : ''}`,
        html: `<p class="gl-lead">Fill in what you have. Anything you skip can go on their page later.</p>
          <div class="field gl-field"><label>What are they to you?</label>
            <div class="ck-checks">${G.ROSTER_TYPES.map((t) => `<label class="ck-check"><input type="checkbox" data-type="${esc(t.value)}"${(p.types || []).includes(t.value) ? ' checked' : ''}> <span>${esc(t.label)}</span></label>`).join('')}</div>
          </div>
          ${field('Phone (optional)', input('gp-phone', p.phone, { type: 'tel' }))}
          ${field('Email (optional)', input('gp-email', p.email, { type: 'email' }))}
          <div class="field gl-field"><label>Address (optional)</label><textarea id="gp-address" rows="2">${esc(p.address)}</textarea></div>
          ${field('Facebook (optional)', input('gp-fb', p.facebook_profile, { placeholder: 'https://facebook.com/…' }))}
          ${field('Met through (optional)', input('gp-source', p.first_contact_source, { list: 'gp-sources' }))}${sourceList}
          <div class="field gl-field"><label>Notes (optional)</label><textarea id="gp-notes" rows="2">${esc(p.notes)}</textarea></div>`,
        read: (root) => {
          p.types = [...root.querySelectorAll('input[data-type]')].filter((x) => x.checked).map((x) => x.dataset.type);
          p.phone = val(root, 'gp-phone');
          p.email = val(root, 'gp-email');
          p.address = root.querySelector('#gp-address').value.trim();
          p.facebook_profile = val(root, 'gp-fb');
          p.first_contact_source = val(root, 'gp-source');
          p.notes = root.querySelector('#gp-notes').value.trim();
          if (!G.isBreeder(p)) p.kennel = G.noKennel();
        },
        // Now that Kels knows their email and phone: are they in her contacts?
        after: () => G.findMatchesFor(p, data.contacts, draft)
      };
    },

    match: (i) => {
      const p = draft.people[i];
      const found = G.findMatchesForShow(p, data.contacts);
      const one = found.length === 1;
      const describe = (m) => [G.contactMatchReason(m), typeText(m.contact.contact_type), [m.contact.phone, m.contact.email].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
      return {
        title: one ? `${esc(found[0].contact.name)} is already in your contacts. Is this the ${esc(p.name)} you're adding?`
          : `There are people like ${esc(p.name)} in your contacts. Is one of them?`,
        html: `<p class="gl-lead">Using the one you have keeps everything about them in one place. I'll only fill in what's missing.</p>
          <div class="gl-tiles">
            ${found.map((m) => tile('match', m.contact.id, `${one ? 'Yes, that\'s them: ' : ''}${esc(m.contact.name)}`, { selected: p.match === m.contact.id, sub: describe(m) })).join('')}
            ${tile('match', 'none', `No, ${esc(p.name)} is someone new`, { selected: p.match === 'none', sub: 'Add them as a new contact' })}
          </div>`,
        onTile: (value) => {
          p.match = value;
          // Their kennel on file is their kennel.
          const on = data.contactsById.get(value);
          if (on?.kennel_id) p.kennel = { has: 'yes', kennelId: on.kennel_id, kennelName: '' };
          return true;
        }
      };
    },

    kennel: (i) => {
      const p = draft.people[i];
      const k = p.kennel;
      return {
        title: `Does ${esc(p.name)} have a kennel?`,
        html: `<p class="gl-lead">I'll link them to it, so their dogs and litters can name it.</p>
          <div class="gl-tiles gl-tiles-small">
            ${tile('has', 'yes', 'Yes', { selected: k.has === 'yes' })}
            ${tile('has', 'no', 'No, or not sure', { selected: k.has === 'no' })}
          </div>
          ${k.has === 'yes' ? kennelPicker('gp-k', k, data.outsideKennels) : ''}`,
        onTile: (value) => {
          k.has = value;
          if (value === 'no') { k.kennelId = null; k.kennelName = ''; return true; }
          return 'redraw';
        },
        wire: (root) => wireKennelPicker(root, 'gp-k'),
        read: (root) => { if (k.has === 'yes') Object.assign(k, readKennelPicker(root, 'gp-k')); }
      };
    },

    breeders: () => {
      const list = G.breedersWithoutKennel(draft, data.contacts);
      return {
        title: list.length === 1 ? `${esc(list[0].name)}, a breeder in your contacts, doesn't have a kennel yet. Do you know theirs?`
          : 'A few breeders in your contacts don\'t have a kennel yet. Do you know theirs?',
        html: `<p class="gl-lead">Optional. Leave any you don't know, and tap Next.</p>
          ${list.map((c) => `<div class="gl-extra-row"><strong>${esc(c.name)}</strong>
            ${kennelPicker(`gp-x-${c.id}`, draft.existing[c.id] || {}, data.outsideKennels, { pickLabel: 'Their kennel', newLabel: 'None, or a new one…' })}</div>`).join('')}`,
        wire: (root) => list.forEach((c) => wireKennelPicker(root, `gp-x-${c.id}`)),
        read: (root) => {
          draft.existing = {};
          for (const c of list) {
            const k = readKennelPicker(root, `gp-x-${c.id}`);
            if (k.kennelId || k.kennelName) draft.existing[c.id] = k;
          }
        }
      };
    },

    review: () => {
      const sections = G.reviewSections(draft, {
        contact: (id) => data.contactsById.get(id)?.name,
        kennel: (id) => data.kennelsById.get(id)?.kennel_name
      });
      return {
        title: 'I think I got it all. Here\'s what I\'ll save:',
        html: `<p class="gl-lead">Look it over. Tap <strong>Change</strong> to fix anything, or <strong>Yes, build it</strong> when it's right.</p>
          ${sections.map((s) => `<section class="gl-review-section">
            <div class="row-between"><h3>${esc(s.title)}</h3>
              <span class="pill-row">${s.steps.kennel ? `<button type="button" class="btn btn-sm" data-goto="${esc(s.steps.kennel)}">Kennel</button>` : ''}<button type="button" class="btn btn-sm" data-goto="${esc(s.steps.details)}">Change</button></span></div>
            <ul>${s.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></section>`).join('')}
          <button type="button" class="btn btn-sm" data-goto="roster">Add or take off someone</button>`,
        isReview: true
      };
    }
  };
}

// --- Her answers, as she'd have said them -------------------------------------------

function answerFor(stepId, draft, data) {
  if (stepId === 'roster') return draft.people.filter((p) => !p.fromVet).map((p) => `${p.name} (${descriptor(CONTACT_TYPE, p.type).label.toLowerCase()})`).join(', ');
  if (stepId === 'vet') {
    const v = draft.vet;
    if (v.answer === 'add') return `My vet is ${v.name}`;
    if (v.answer === 'onfile') return `My vet is ${data.contactsById.get(v.contactId)?.name || 'in my contacts'}`;
    return 'Not now';
  }
  if (stepId === 'common') return draft.common.first_contact_source || 'Different for each';
  if (stepId === 'breeders') {
    const n = Object.keys(draft.existing).length;
    return n ? `${n === 1 ? 'One kennel' : `${n} kennels`} to link` : 'Not now';
  }
  if (stepId === 'review') return '';
  const p = draft.people[G.stepIndex(stepId)];
  if (!p) return '';
  if (stepId.startsWith('match:')) return p.match === 'none' ? `No, ${p.name} is someone new` : `Yes, that's ${data.contactsById.get(p.match)?.name || 'them'}`;
  if (stepId.startsWith('person:')) return [typeText(p.types), p.phone, p.email].filter(Boolean).join(' · ');
  if (stepId.startsWith('kennel:')) {
    if (p.kennel.has !== 'yes') return 'No, or not sure';
    return G.kennelText(p.kennel, { kennel: (id) => data.kennelsById.get(id)?.kennel_name }).replace(' (a new kennel)', '');
  }
  return '';
}

// --- The conversation -----------------------------------------------------------------

// Run "Add people" in `chat` (assets/kelsChat.js). `resume`: carry on the
// unfinished draft. `onExit(reason)` hands the chat back to Kels's menu;
// `onSaved()` runs once the records are built.
export async function runPeopleTask(chat, { resume = false, onExit = () => {}, onSaved = () => {} } = {}) {
  const data = await loadData();
  let draft = resume ? G.pendingPeopleDraft(getGuidedPeopleDraft()) : null;
  if (!draft) {
    draft = G.emptyDraft();
    if (!(await chat.intro('Of course! Let\'s get your people added.'))) { onExit('nevermind'); return; }
  } else {
    await chat.say(`Welcome back! Here's what we have so far for ${esc(G.draftLabel(draft) || 'your people')}:`, { typing: 500 });
    await StepConversation.replay(chat, draft.history);
    await chat.say('Let\'s pick up where we left off.', { typing: 500 });
  }
  return new PeopleConversation(chat, draft, data, onExit, onSaved).start();
}

class PeopleConversation extends StepConversation {
  constructor(chat, draft, data, onExit, onSaved) {
    super(chat, draft);
    Object.assign(this, { data, onExit, onSaved });
  }

  persist() {
    const d = this.draft;
    d.updatedAt = new Date().toISOString();
    d.label = G.draftLabel(d);
    if (!d.done) setGuidedPeopleDraft(d);
  }

  // An answer changed after a save that stopped partway: write each person again
  // on the retry (records already made are kept, by id).
  answerChanged() {
    this.draft.people.forEach((p) => { p.saved = false; });
    if (this.draft.saved) this.draft.saved.existing = {};
  }

  async loadSteps() { return G.stepsFor(this.draft, { contacts: this.data.contacts }); }

  screenFor(stepId) {
    const all = screens(this.draft, this.data);
    const [kind, i] = stepId.split(':');
    return i == null ? all[kind]() : all[kind](Number(i));
  }

  problem(stepId) {
    return G.stepProblem(stepId, this.draft, { contacts: this.data.contacts, outsideKennels: this.data.outsideKennels });
  }

  answerText(stepId) { return answerFor(stepId, this.draft, this.data); }

  async save() {
    if (this.busy) return;
    this.busy = true;
    const btn = this.panel.querySelector('[data-k="save"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Building…'; }
    this.showError('');
    try {
      const result = await G.saveGuidedPeople(this.draft, { onProgress: () => setGuidedPeopleDraft(this.draft) });
      clearGuidedPeopleDraft();
      this.onSaved();
      this.panel.closest('.kels-row').remove();
      this.chat.you('Yes, build it');
      await this.afterSave(result);
    } catch (e) {
      setGuidedPeopleDraft(this.draft);
      if (btn) { btn.disabled = false; btn.textContent = 'Try again'; }
      this.showError(`Hmm, that didn't save: ${e.message || String(e)} Your answers are kept, so you can fix it and try again.`);
    } finally {
      this.busy = false;
    }
  }

  async afterSave({ people, kennelIds }) {
    const saved = (await Promise.all(people.map((id) => contactRepo.getById(id)))).filter(Boolean);
    await this.chat.say(`Done! ✓ I added ${esc(G.draftLabel({ people: saved }))}. Your contacts are looking great.`, { typing: 1100 });
    if (kennelIds.length) await this.bredBy(kennelIds);
    if (editionFlags.waitlist) await this.waitlist(saved);
    await this.finish(saved);
  }

  // "Do you want to link any kennels to dogs you own as the kennel who bred it?"
  // Her dogs with no breeder kennel, each with a kennel to pick: this run's first.
  async bredBy(kennelIds) {
    const [dogs, kennels] = await Promise.all([dogRepo.getAll(), kennelRepo.getAll({ includeArchived: false })]);
    const open = G.dogsWithoutBreeder(dogs).sort((a, b) => (a.call_name || '').localeCompare(b.call_name || ''));
    if (!open.length) return;
    await this.chat.say(`Do you want to link any kennels to dogs you own as the kennel who bred it? ${open.length === 1 ? `${esc(open[0].call_name || open[0].registered_name)} doesn't` : `${open.length} of your dogs don't`} have one yet.`);
    const go = await this.chat.choose([
      { label: 'Yes, let\'s link them', value: 'yes', primary: true },
      { label: 'Not now', value: 'no' }
    ]);
    if (go !== 'yes') return;
    const choices = G.breederKennelChoices(kennels, kennelIds);
    const run = choices.filter((c) => c.fromRun);
    const rest = choices.filter((c) => !c.fromRun);
    const opt = (c) => `<option value="${esc(c.kennel.id)}">${esc(c.kennel.kennel_name)}</option>`;
    const select = (d) => `<select data-dog="${esc(d.id)}" aria-label="Who bred ${esc(d.call_name || d.registered_name)}"><option value="">Not this one</option>
      ${run.length ? `<optgroup label="Just added">${run.map(opt).join('')}</optgroup>` : ''}
      ${rest.length ? `<optgroup label="Your other kennels on file">${rest.map(opt).join('')}</optgroup>` : ''}</select>`;
    const res = await this.chat.form({
      title: '<strong>Who bred each of them?</strong><span class="kels-lead">Leave a dog on "Not this one" to skip it.</span>',
      html: open.map((d) => field(`${d.call_name || d.registered_name}${d.breed ? ` (${d.breed})` : ''}`, select(d))).join(''),
      submitLabel: 'Save', cancelLabel: 'Skip',
      submit: async (root) => {
        const picks = Object.fromEntries([...root.querySelectorAll('select[data-dog]')].map((el) => [el.dataset.dog, el.value]));
        const links = G.breederLinks(picks, dogs, kennels);
        if (!links.length) return 'Pick a kennel for at least one dog, or tap Skip.';
        for (const l of links) await dogRepo.update(l.dogId, { breeder_kennel_id: l.kennelId });
        return links;
      },
      reply: (links) => links.map((l) => `${open.find((d) => d.id === l.dogId)?.call_name}: ${kennels.find((k) => k.id === l.kennelId)?.kennel_name}`).join(' · ')
    });
    if (res.done) await this.chat.say(`Linked. ✓ ${res.result.length === 1 ? 'Its page shows' : 'Their pages show'} who bred ${res.result.length === 1 ? 'it' : 'them'} now.`, { typing: 500 });
  }

  // With a waitlist set up: put a buyer she just added on it, in the chat.
  async waitlist(saved) {
    const buyers = saved.filter((c) => (c.contact_type || []).includes('buyer'));
    if (!buyers.length) return;
    const kennels = (await ownKennels()).filter((k) => !k.is_archived && waitlistIsSetUp(k));
    if (!kennels.length) return;
    const one = buyers.length === 1 ? buyers[0] : null;
    await this.chat.say(`Would you like to put ${one ? esc(one.name) : 'any of them'} on your waitlist? I'll ask your application's questions, and they'll be in your applications, ready for you to approve.`);
    const { askApplicant } = await import('./kelsApplicant.js');
    let left = [...buyers];
    for (;;) {
      const pick = await this.chat.choose([
        ...left.map((c) => ({ label: one ? 'Yes, add them' : c.name, value: c.id, primary: Boolean(one) })),
        { label: one ? 'Not now' : 'That\'s all for now', value: '' }
      ]);
      if (!pick) return;
      const contact = left.find((c) => c.id === pick);
      let kennel = kennels[0];
      if (kennels.length > 1) {
        await this.chat.say(`<strong>Which kennel's waitlist?</strong>`, { typing: 400 });
        const kid = await this.chat.choose(kennels.map((k) => ({ label: k.kennel_name, value: k.id })));
        kennel = kennels.find((k) => k.id === kid);
      }
      const entry = await askApplicant(this.chat, {
        kennel, contact,
        title: `<strong>Tell me about ${esc(contact.name)}'s application.</strong><span class="kels-lead">Your application's questions, so it matches what families fill in online.</span>`
      });
      if (entry) {
        await this.chat.say(`Added! ${esc(contact.name)} is in your applications, ready for you to approve.`, { typing: 500 });
        left = left.filter((c) => c !== contact);
      }
      if (!left.length || one) return;
      await this.chat.say('Anyone else?', { typing: 300 });
    }
  }

  async finish(saved) {
    const one = saved.length === 1 ? saved[0] : null;
    await this.chat.say('All set. Anything else I can do for you?');
    const where = await this.chat.choose([
      ...(saved.length ? [{ label: one ? `See ${one.name}` : 'See my contacts', value: 'see', primary: true }] : []),
      { label: 'Help me with something else', value: 'menu' },
      { label: 'Back to Today', value: 'today' }
    ]);
    if (where === 'see') location.href = one ? `${pagesPrefix()}contact.html?id=${encodeURIComponent(one.id)}` : `${pagesPrefix()}contacts.html`;
    else if (where === 'today') location.href = `${pagesPrefix()}today.html`;
    else this.onExit('done');
  }
}
