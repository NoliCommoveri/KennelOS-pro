// guidedDogsUI.js — Kels's "Add dogs" task: the screens, drawn by the shared
// step engine (assets/kelsSteps.js) in the chat on pages/kels.html. Several dogs
// at once: a roster of names first (one question for all of them, as the
// litter's puppies), what they have in common, then each dog's details and
// parents, and one review she approves. The steps, checks, review lines and the
// save live in data/guidedDogs.js; this module draws them and keeps the draft
// (settings.js guidedDogsDraft), so closing the window loses nothing.
//
// After the save, Pro (editionFlags.documents) offers to file each dog's papers
// in the chat: the Documents page's own save (assets/documentModal.js, Pro-only,
// imported only then). In Lite, the cap stops the save with the upgrade notice.
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { ownKennels, getActiveKennelId } from '../data/kennelScope.js';
import { editionFlags, dogCapStatus } from '../data/editionConfig.js';
import { CapExceededError } from '../data/repoBase.js';
import { getGuidedDogsDraft, setGuidedDogsDraft, clearGuidedDogsDraft } from '../data/settings.js';
import { DOG_STATUS, OWNERSHIP_TYPE, DOC_TYPES, VACCINE_CHECKLIST, VACCINE_GOOD_FOR, documentFieldsFor, descriptor } from '../data/vocab.js';
import { SCOPED_OWNERSHIP } from '../data/kennelScope.js';
import * as G from '../data/guidedDogs.js';
import { findDogMatches, matchReason, breedChoices } from '../data/dogSearch.js';
import { fmt } from '../data/guidedLitter.js';
import { esc, todayYMD } from './ui.js';
import { renderUpgradeNudge } from './upgradeNudge.js';
import { StepConversation, tile, field, input, options, val, plural, pagesPrefix, kennelPicker, wireKennelPicker, readKennelPicker, contactFields, readContactFields, breedPicker, wireBreedPicker, readBreedPicker } from './kelsSteps.js';

// --- The data the screens read ----------------------------------------------------

async function loadData() {
  // Pedigree-only dogs too: a name she types may be one (brought into use), and
  // they're parents to pick.
  const [dogs, contacts, kennels, own, capStatus, breedPool] = await Promise.all([
    dogRepo.getAll({ includeArchived: false, includePedigreeOnly: true }),
    (editionFlags.externalOwnership || editionFlags.contactsSection) ? contactRepo.getAll({ includeArchived: false }) : Promise.resolve([]),
    kennelRepo.getAll({ includeArchived: false }),
    ownKennels(),
    dogCapStatus(),
    kennelRepo.getBreedVocabulary()
  ]);
  const name = (d) => d.call_name || d.registered_name || '';
  return {
    dogs: dogs.sort((a, b) => name(a).localeCompare(name(b))),
    contacts: contacts.sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    dogsById: new Map(dogs.map((d) => [d.id, d])),
    contactsById: new Map(contacts.map((c) => [c.id, c])),
    kennelsById: new Map(kennels.map((k) => [k.id, k])),
    own: own.filter((k) => !k.is_archived),
    // Other breeders' kennels and the breeders themselves (Pro: contacts).
    outsideBreeders: Boolean(editionFlags.contactsSection),
    outsideKennels: kennels.filter((k) => !k.is_own_kennel).sort((a, b) => (a.kennel_name || '').localeCompare(b.kennel_name || '')),
    // Lite's cap: { current, cap }, null where dogs aren't capped. The roster
    // never has more rows than she has room for.
    capStatus,
    maxDogs: G.maxDogs(capStatus),
    // Her breeds, as the Dog page offers them (dogs' breeds + her kennel's list).
    breeds: breedChoices({ dogs, pool: breedPool })
  };
}

const dogName = (d) => (d && (d.call_name || d.registered_name)) || '';
const her = (sex) => (sex === 'female' ? 'her' : 'his');
const herHim = (sex) => (sex === 'female' ? 'her' : 'him');
const sheHe = (sex) => (sex === 'female' ? 'she' : 'he');

// --- Screens ------------------------------------------------------------------------

function screens(draft, data) {
  const statuses = G.statusChoices(editionFlags);
  const ownerships = G.ownershipChoices(editionFlags);
  const multiKennel = data.own.length > 1;

  // Whose dog, its owner (someone else's) and kennel (hers, with several kennels):
  // the same block on "in common" and on each dog. `o` holds the answers.
  function ownershipHtml(o, prefix, { allowBlank = false } = {}) {
    const external = G.OWNER_REQUIRED.includes(o.ownership_type);
    const scoped = SCOPED_OWNERSHIP.has(o.ownership_type);
    return `${field('Whose dog?', `<select id="${prefix}-own">${options(ownerships, o.ownership_type, allowBlank ? 'Different for each' : null)}</select>`)}
      ${editionFlags.externalOwnership ? `<div id="${prefix}-owner"${external ? '' : ' hidden'}>
        ${data.contacts.length ? field('Owner', `<select id="${prefix}-owner-pick"><option value="">Someone new…</option>${data.contacts.map((c) => `<option value="${esc(c.id)}"${o.ownerId === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`) : ''}
        <div id="${prefix}-owner-new"${o.ownerId ? ' hidden' : ''}>${field('Owner\'s name', input(`${prefix}-owner-name`, o.ownerName, { placeholder: 'e.g. Pat Smith' }))}</div>
      </div>` : ''}
      ${multiKennel ? `<div id="${prefix}-kennel"${scoped ? '' : ' hidden'}>${field('Which of your kennels?', `<select id="${prefix}-kennel-pick">${options(data.own.map((k) => ({ value: k.id, label: k.kennel_name })), o.kennelId || '', allowBlank ? 'Different for each' : 'Pick a kennel…')}</select>`)}</div>` : ''}`;
  }
  function wireOwnership(root, prefix) {
    const sync = () => {
      const v = val(root, `${prefix}-own`);
      const owner = root.querySelector(`#${prefix}-owner`);
      if (owner) owner.hidden = !G.OWNER_REQUIRED.includes(v);
      const kennel = root.querySelector(`#${prefix}-kennel`);
      if (kennel) kennel.hidden = !SCOPED_OWNERSHIP.has(v);
    };
    root.querySelector(`#${prefix}-own`)?.addEventListener('change', sync);
    root.querySelector(`#${prefix}-owner-pick`)?.addEventListener('change', (e) => {
      root.querySelector(`#${prefix}-owner-new`).hidden = Boolean(e.target.value);
    });
  }
  function readOwnership(root, prefix, o) {
    o.ownership_type = val(root, `${prefix}-own`);
    const external = G.OWNER_REQUIRED.includes(o.ownership_type);
    o.ownerId = external ? (val(root, `${prefix}-owner-pick`) || null) : null;
    o.ownerName = external && !o.ownerId ? val(root, `${prefix}-owner-name`) : '';
    if (multiKennel) o.kennelId = SCOPED_OWNERSHIP.has(o.ownership_type) ? (val(root, `${prefix}-kennel-pick`) || null) : null;
  }

  // A parent picker: the dogs being added, dogs on file of that sex (same breed
  // first), or a name typed in.
  function parentPicker(d, role) {
    const sex = role === 'dam' ? 'female' : 'male';
    const p = d[role];
    const batch = G.dogsToAdd(draft).filter((x) => x.key !== d.key && x.sex === sex);
    const breed = (d.breed || '').trim().toLowerCase();
    // A dog on file that one of the dogs we're adding is, is listed once, with them.
    const bringing = new Set(draft.dogs.filter((x) => x.match && x.match !== 'none').map((x) => x.match));
    const onFile = data.dogs
      .filter((x) => !bringing.has(x.id) && (x.sex === sex || !x.sex || x.sex === 'unknown'))
      .sort((a, b) => ((b.breed || '').trim().toLowerCase() === breed) - ((a.breed || '').trim().toLowerCase() === breed));
    const opt = (value, text) => `<option value="${esc(value)}"${p.pick === value ? ' selected' : ''}>${esc(text)}</option>`;
    const w = role === 'dam' ? 'Mom' : 'Dad';
    return `${field(w, `<select id="gd-${role}">
        ${opt('', 'Not known')}
        ${batch.length ? `<optgroup label="Dogs we're adding">${batch.map((x) => opt(`batch:${x.key}`, G.dogLabel(x))).join('')}</optgroup>` : ''}
        ${onFile.length ? `<optgroup label="In KennelOS">${onFile.map((x) => opt(`dog:${x.id}`, `${dogName(x)}${x.registered_name && x.call_name ? ` (${x.registered_name})` : ''}${x.breed && x.breed.trim().toLowerCase() !== breed ? ` · ${x.breed}` : ''}`)).join('')}</optgroup>` : ''}
        ${opt('new', 'Not in KennelOS: I\'ll type the name')}
      </select>`)}
      <div id="gd-${role}-new"${p.pick === 'new' ? '' : ' hidden'}>
        ${field(`${w}'s registered name`, input(`gd-${role}-name`, p.name, { placeholder: 'As it reads on the pedigree' }), 'Added just for the pedigree.')}
        ${field('Registration number (optional)', input(`gd-${role}-regnum`, p.regNum))}
        ${field('Call name (optional)', input(`gd-${role}-call`, p.callName))}
      </div>`;
  }

  return {
    roster: () => ({
      title: 'Who are we adding?',
      html: `<p class="gl-lead">Type each dog's name and tap boy or girl. Tap <strong>+ Another dog</strong> for the next one.</p>
        <div class="gd-roster">
          ${draft.dogs.map((d, i) => `<div class="gd-row">
            ${input(`gd-name-${d.key}`, d.call_name, { placeholder: i ? 'Name' : 'e.g. Daisy', label: `Dog ${i + 1}'s name` })}
            ${tile('sex', `${d.key}|male`, '♂ Boy', { selected: d.sex === 'male' })}
            ${tile('sex', `${d.key}|female`, '♀ Girl', { selected: d.sex === 'female' })}
            ${draft.dogs.length > 1 ? `<button type="button" class="btn gd-remove" data-act="remove" data-key="${esc(d.key)}" aria-label="Take ${esc(d.call_name || 'this row')} off">✕</button>` : '<span></span>'}
          </div>`).join('')}
        </div>
        ${draft.dogs.length < data.maxDogs ? '<button type="button" class="btn gl-more" data-act="add">+ Another dog</button>' : ''}
        ${data.capStatus ? `<p class="muted gl-note">${draft.dogs.length < data.maxDogs ? `You have room for ${plural(data.maxDogs, 'more dog', 'more dogs')}.` : 'That\'s all the room you have left.'}</p>` : ''}`,
      read: (root) => {
        for (const d of draft.dogs) {
          const el = root.querySelector(`#gd-name-${d.key}`);
          if (el) d.call_name = el.value.trim();
        }
      },
      onTile: (value) => {
        const [k, sex] = value.split('|');
        const d = draft.dogs.find((x) => x.key === k);
        if (d) d.sex = sex;
        return 'redraw';
      },
      onAct: (act, root, btn) => {
        if (act === 'add') { draft.dogs.push(G.newDog()); return 'redraw'; }
        if (act === 'remove') {
          // Read first: the redraw reads again, by key, so the others keep theirs.
          for (const d of draft.dogs) d.call_name = root.querySelector(`#gd-name-${d.key}`)?.value.trim() ?? d.call_name;
          draft.dogs = draft.dogs.filter((d) => d.key !== btn.dataset.key);
          return 'redraw';
        }
        return null;
      },
      wire: (root) => {
        // A new row's name box gets the cursor.
        const empty = [...root.querySelectorAll('.gd-row input')].find((el) => !el.value);
        empty?.focus({ preventScroll: true });
      },
      after: () => {
        G.afterRoster(draft);
        G.fillFromCommon(draft);
      }
    }),

    match: (i) => {
      const d = draft.dogs[i];
      // The same search that found them, for what she's shown about each.
      const typed = { callName: d.call_name, registeredName: d.registered_name, registrationNumber: d.registration_number, breed: d.breed, dateOfBirth: d.date_of_birth, sex: d.sex };
      const byId = new Map(findDogMatches(data.dogs, typed).map((m) => [m.dog.id, m]));
      const found = d.matchIds.map((id) => byId.get(id) || { dog: data.dogsById.get(id), strength: 'possible', agrees: [], differs: [] }).filter((m) => m.dog);
      const one = found.length === 1;
      const sure = found[0]?.strength === 'certain';
      const describe = (m) => {
        const x = m.dog;
        return [
          matchReason(m),
          [x.breed, x.date_of_birth ? `born ${fmt(x.date_of_birth)}` : '', x.registration_number].filter(Boolean).join(', '),
          x.pedigree_only ? `From a pedigree: I'll bring ${herHim(d.sex)} into your dogs` : 'In KennelOS: I\'ll fill in what\'s missing on it'
        ].filter(Boolean).join(' · ');
      };
      const nameHtml = (x) => `${esc(dogName(x))}${x.registered_name && x.call_name ? ` <span class="faint">${esc(x.registered_name)}</span>` : ''}`;
      return {
        title: sure ? `That registration number is ${esc(dogName(found[0].dog))}'s. Is this ${esc(d.call_name)}?`
          : one ? `We found ${esc(dogName(found[0].dog))}. Is this the ${esc(d.call_name)} you're adding?`
            : `We found dogs like ${esc(d.call_name)}. Is one of them ${herHim(d.sex)}?`,
        html: `<p class="gl-lead">Using the one on file keeps ${her(d.sex)} records in one place.</p>
          <div class="gl-tiles">
            ${found.map((m) => tile('match', m.dog.id, `${one ? `Yes, that's ${herHim(d.sex)}: ` : ''}${nameHtml(m.dog)}`, { selected: d.match === m.dog.id, sub: describe(m) })).join('')}
            ${tile('match', 'none', `No, ${esc(d.call_name)} is a different dog`, { selected: d.match === 'none', sub: 'Add as a new dog' })}
          </div>`,
        onTile: (value) => {
          if (d.id && d.id === d.match) d.id = null; // the dog an earlier answer pointed at
          d.match = value;
          const x = value === 'none' ? null : data.dogsById.get(value);
          d.bringIn = Boolean(x?.pedigree_only);
          if (x) {
            // Its parents and breeder on file, as the starting answers.
            if (x.breeder_kennel_id && !d.breeder?.bredBy) {
              d.breeder = data.own.some((k) => k.id === x.breeder_kennel_id)
                ? { ...G.noBreeder(), bredBy: 'me' }
                : { ...G.noBreeder(), bredBy: 'other', kennelId: x.breeder_kennel_id };
              d.breederSeen = true;
            }
            const pick = (id) => (id && data.dogsById.has(id) ? `dog:${id}` : '');
            if (!d.dam.pick && pick(x.dam_id)) d.dam = { pick: pick(x.dam_id), name: '', regNum: '', callName: '' };
            if (!d.sire.pick && pick(x.sire_id)) d.sire = { pick: pick(x.sire_id), name: '', regNum: '', callName: '' };
          }
          return true;
        }
      };
    },

    common: () => {
      const c = draft.common;
      return {
        title: 'What do they have in common?',
        html: `<p class="gl-lead">I'll fill these in on each dog, and you can change any of them there. Leave a box blank if it's different for each.</p>
          ${breedPicker('gd-c-breed', c.breed, data.breeds, { allowBlank: true })}
          ${field('Status', `<select id="gd-c-status">${options(statuses, c.status, 'Different for each')}</select>`)}
          ${ownershipHtml(c, 'gd-c', { allowBlank: true })}`,
        wire: (root) => { wireOwnership(root, 'gd-c'); wireBreedPicker(root, 'gd-c-breed'); },
        read: (root) => {
          c.breed = readBreedPicker(root, 'gd-c-breed');
          c.status = val(root, 'gd-c-status');
          readOwnership(root, 'gd-c', c);
        },
        after: () => G.fillFromCommon(draft)
      };
    },

    dog: (i) => {
      const d = draft.dogs[i];
      const adding = G.dogsToAdd(draft);
      const n = adding.indexOf(d) + 1;
      return {
        title: `Tell me about ${esc(d.call_name)}${adding.length > 1 ? ` (${n} of ${adding.length})` : ''}`,
        html: `<p class="gl-lead">Fill in what you have. Anything you skip can go on ${her(d.sex)} page later.</p>
          ${breedPicker('gd-breed', d.breed, data.breeds)}
          ${field('Date of birth (optional)', input('gd-dob', d.date_of_birth, { type: 'date', max: todayYMD() }))}
          ${field('Registered name (optional)', input('gd-reg', d.registered_name))}
          ${field('Registration number (optional)', input('gd-regnum', d.registration_number))}
          ${field('Color and markings (optional)', input('gd-color', d.color_markings, { placeholder: 'e.g. red with white chest' }))}
          ${field('Microchip number (optional)', input('gd-chip', d.microchip_id, { inputmode: 'numeric' }))}
          ${field('Status', `<select id="gd-status">${options(statuses, d.status, 'Pick one…')}</select>`)}
          ${ownershipHtml(d, 'gd-d')}`,
        wire: (root) => { wireOwnership(root, 'gd-d'); wireBreedPicker(root, 'gd-breed'); },
        read: (root) => {
          d.breed = readBreedPicker(root, 'gd-breed');
          d.date_of_birth = val(root, 'gd-dob');
          d.registered_name = val(root, 'gd-reg');
          d.registration_number = val(root, 'gd-regnum');
          d.color_markings = val(root, 'gd-color');
          d.microchip_id = val(root, 'gd-chip');
          d.status = val(root, 'gd-status');
          readOwnership(root, 'gd-d', d);
        },
        // Now that Kels knows its names, number, breed and birthday: is it on file?
        after: () => G.findMatchesFor(d, data.dogs, draft)
      };
    },

    parents: (i) => {
      const d = draft.dogs[i];
      return {
        title: `Who are ${esc(d.call_name)}'s parents?`,
        html: `<p class="gl-lead">Optional. If you don't know yet, leave them as Not known; you can add them on ${her(d.sex)} page any time.</p>
          ${parentPicker(d, 'dam')}
          ${parentPicker(d, 'sire')}`,
        wire: (root) => {
          for (const role of ['dam', 'sire']) {
            root.querySelector(`#gd-${role}`).addEventListener('change', (e) => {
              root.querySelector(`#gd-${role}-new`).hidden = e.target.value !== 'new';
            });
          }
        },
        read: (root) => {
          for (const role of ['dam', 'sire']) {
            const pick = val(root, `gd-${role}`);
            d[role] = pick === 'new'
              ? { pick, name: val(root, `gd-${role}-name`), regNum: val(root, `gd-${role}-regnum`), callName: val(root, `gd-${role}-call`) }
              : { pick, name: '', regNum: '', callName: '' };
          }
          G.resolveTypedParents(d, data.dogs);
        }
      };
    },

    breeder: (i) => {
      const d = draft.dogs[i];
      // The dog before's answer to start with (dogs from one breeder: one tap each).
      if (!d.breederSeen) { d.breeder = d.breeder?.bredBy ? d.breeder : G.breederDefault(draft, i); d.breederSeen = true; }
      const b = d.breeder || (d.breeder = G.noBreeder());
      const other = b.bredBy === 'other' && data.outsideBreeders;
      const rank = (c) => ((c.contact_type || []).includes('breeder') ? 0 : 1);
      const people = [...data.contacts].sort((a, c) => rank(a) - rank(c) || (a.name || '').localeCompare(c.name || ''));
      return {
        title: `Who bred ${esc(d.call_name)}?`,
        html: `<div class="gl-tiles gl-tiles-small">
            ${tile('bred', 'me', 'I did', { selected: b.bredBy === 'me' })}
            ${tile('bred', 'other', data.outsideBreeders ? 'Another breeder' : 'Someone else', { selected: b.bredBy === 'other' })}
            ${tile('bred', 'unsure', 'Not sure', { selected: false })}
          </div>
          ${other ? `<p class="gl-q">Their kennel</p>
            ${kennelPicker('gd-bk', b, data.outsideKennels, { pickLabel: 'A kennel you have' })}
            <p class="gl-q">The breeder (optional)</p>
            ${people.length ? field('Someone in your contacts', `<select id="gd-bc-pick"><option value="">Someone new…</option>${people.map((c) => `<option value="${esc(c.id)}" data-kennel="${esc(c.kennel_id || '')}"${b.contactId === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`) : ''}
            <div id="gd-bc-new"${b.contactId ? ' hidden' : ''}>${contactFields('gd-bc', { name: b.contactName, phone: b.contactPhone, email: b.contactEmail })}</div>` : ''}`,
        onTile: (value) => {
          if (value === 'unsure') { d.breeder = G.noBreeder(); return true; }
          b.bredBy = value;
          return value === 'other' && data.outsideBreeders ? 'redraw' : true;
        },
        wire: (root) => {
          wireKennelPicker(root, 'gd-bk');
          const kPick = root.querySelector('#gd-bk-pick');
          root.querySelector('#gd-bc-pick')?.addEventListener('change', (e) => {
            root.querySelector('#gd-bc-new').hidden = Boolean(e.target.value);
            // Someone with a kennel names the kennel too.
            const kid = e.target.selectedOptions[0]?.dataset.kennel;
            if (kid && kPick && [...kPick.options].some((o) => o.value === kid)) { kPick.value = kid; root.querySelector('#gd-bk-new').hidden = true; }
          });
        },
        read: (root) => {
          if (!(b.bredBy === 'other' && data.outsideBreeders)) return;
          Object.assign(b, readKennelPicker(root, 'gd-bk'));
          b.contactId = val(root, 'gd-bc-pick') || null;
          const typed = b.contactId ? { name: '', phone: '', email: '' } : readContactFields(root, 'gd-bc');
          Object.assign(b, { contactName: typed.name, contactPhone: typed.phone, contactEmail: typed.email });
        }
      };
    },

    review: () => {
      const sections = G.reviewSections(draft, {
        dog: (id) => dogName(data.dogsById.get(id)),
        contact: (id) => data.contactsById.get(id)?.name,
        kennel: (id) => data.kennelsById.get(id)?.kennel_name
      }, { kennelNames: multiKennel });
      const adding = G.dogsToAdd(draft).length;
      return {
        title: 'I think I got it all. Here\'s what I\'ll create:',
        html: `<p class="gl-lead">Look it over. Tap <strong>Change</strong> to fix anything, or <strong>Yes, build it</strong> when it's right.</p>
          ${sections.map((s) => `<section class="gl-review-section">
            <div class="row-between"><h3>${esc(s.title)}</h3>
              <span class="pill-row">${s.steps.parents ? `<button type="button" class="btn btn-sm" data-goto="${esc(s.steps.parents)}">Parents</button>` : ''}${s.steps.breeder ? `<button type="button" class="btn btn-sm" data-goto="${esc(s.steps.breeder)}">Breeder</button>` : ''}<button type="button" class="btn btn-sm" data-goto="${esc(s.steps.details)}">Change</button></span></div>
            <ul>${s.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></section>`).join('')}
          <button type="button" class="btn btn-sm" data-goto="roster">${adding ? 'Add or take off a dog' : 'Add a different dog'}</button>`,
        isReview: true
      };
    }
  };
}

// --- Her answers, as she'd have said them -------------------------------------------

function answerFor(stepId, draft, data) {
  const c = draft.common;
  const lbl = (vocab, v) => (v ? descriptor(vocab, v).label : '');
  const ownerText = (o) => (G.OWNER_REQUIRED.includes(o.ownership_type)
    ? (o.ownerId ? data.contactsById.get(o.ownerId)?.name : o.ownerName) : '');
  const kennelText = (o) => (data.own.length > 1 && o.kennelId ? data.kennelsById.get(o.kennelId)?.kennel_name : '');
  if (stepId === 'roster') {
    return draft.dogs.map((d) => `${d.call_name} (${d.sex === 'female' ? 'girl' : 'boy'})`).join(', ');
  }
  if (stepId === 'common') {
    return [c.breed, lbl(DOG_STATUS, c.status), lbl(OWNERSHIP_TYPE, c.ownership_type), ownerText(c), kennelText(c)].filter(Boolean).join(' · ') || 'Different for each';
  }
  if (stepId === 'review') return '';
  const d = draft.dogs[G.stepIndex(stepId)];
  if (!d) return '';
  if (stepId.startsWith('match:')) {
    if (d.match === 'none') return `No, ${d.call_name} is a different dog`;
    return `Yes, that's ${herHim(d.sex)}: ${dogName(data.dogsById.get(d.match))}`;
  }
  if (stepId.startsWith('dog:')) {
    return [d.breed, d.date_of_birth ? `born ${fmt(d.date_of_birth)}` : '', d.registered_name, lbl(DOG_STATUS, d.status), lbl(OWNERSHIP_TYPE, d.ownership_type), ownerText(d), kennelText(d)]
      .filter(Boolean).join(' · ');
  }
  if (stepId.startsWith('breeder:')) {
    const b = d.breeder || {};
    if (!b.bredBy) return 'Not sure';
    if (b.bredBy === 'me') return 'I did';
    const text = G.breederText(b, { kennel: (id) => data.kennelsById.get(id)?.kennel_name, contact: (id) => data.contactsById.get(id)?.name });
    return data.outsideBreeders ? text.replace(/ \(a new (kennel|contact)\)/g, '') : 'Someone else';
  }
  if (stepId.startsWith('parents:')) {
    const names = { dog: (id) => dogName(data.dogsById.get(id)) };
    const dam = G.parentText(d.dam, draft, names);
    const sire = G.parentText(d.sire, draft, names);
    return [dam ? `Mom: ${dam}` : '', sire ? `Dad: ${sire}` : ''].filter(Boolean).join(' · ') || 'Not known';
  }
  return '';
}

// --- The conversation -----------------------------------------------------------------

// An unfinished draft, if there is one (Kels offers to finish it).
export function pendingDogsDraft() {
  const draft = getGuidedDogsDraft();
  if (!draft) return null;
  if (draft.v !== G.DRAFT_VERSION) { clearGuidedDogsDraft(); return null; }
  return draft.done ? null : draft;
}

export function discardGuidedDogsDraft() {
  clearGuidedDogsDraft();
}

// The draft's name on the menu: "Daisy, Duke and Rosie".
export function draftLabel(draft) {
  const names = (draft?.dogs || []).map((d) => d.call_name).filter(Boolean);
  if (!names.length) return '';
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// Run "Add dogs" in `chat` (assets/kelsChat.js). `resume`: carry on the
// unfinished draft. `onExit(reason)` hands the chat back to Kels's menu;
// `onSaved()` runs once the records are built.
export async function runDogsTask(chat, { resume = false, onExit = () => {}, onSaved = () => {} } = {}) {
  const data = await loadData();
  let draft = resume ? pendingDogsDraft() : null;
  if (!draft) {
    // Lite with no room left: the usual upgrade notice, before any questions.
    if (data.capStatus && !data.maxDogs) {
      renderUpgradeNudge(await chat.say(''), new CapExceededError('dogs', data.capStatus.current, data.capStatus.cap));
      onExit('done');
      return;
    }
    draft = G.emptyDraft();
    // With several kennels, the one she's working in is the suggestion.
    const active = getActiveKennelId();
    if (data.own.length > 1 && data.own.some((k) => k.id === active)) draft.common.kennelId = active;
    if (!(await chat.intro('Wonderful, let\'s get your dogs added!'))) { onExit('nevermind'); return; }
  } else {
    await chat.say(`Welcome back! Here's what we have so far for ${esc(draftLabel(draft) || 'your dogs')}:`, { typing: 500 });
    await StepConversation.replay(chat, draft.history);
    await chat.say('Let\'s pick up where we left off.', { typing: 500 });
  }
  return new DogsConversation(chat, draft, data, onExit, onSaved).start();
}

class DogsConversation extends StepConversation {
  constructor(chat, draft, data, onExit, onSaved) {
    super(chat, draft);
    Object.assign(this, { data, onExit, onSaved });
  }

  persist() {
    const d = this.draft;
    d.updatedAt = new Date().toISOString();
    d.label = draftLabel(d);
    if (!d.done) setGuidedDogsDraft(d);
  }

  // An answer changed after a save that stopped partway: write each dog again on
  // the retry (records already made are kept, by id).
  answerChanged() {
    this.draft.dogs.forEach((d) => { d.saved = false; });
    if (this.draft.saved) this.draft.saved.linked = {};
  }

  async loadSteps() { return G.stepsFor(this.draft); }

  screenFor(stepId) {
    const all = screens(this.draft, this.data);
    const [kind, i] = stepId.split(':');
    return i == null ? all[kind]() : all[kind](Number(i));
  }

  problem(stepId) {
    return G.stepProblem(stepId, this.draft, {
      dogs: this.data.dogs, multiKennel: this.data.own.length > 1, ownKennelIds: this.data.own.map((k) => k.id), maxDogs: this.data.maxDogs,
      outsideBreeders: this.data.outsideBreeders, contacts: this.data.contacts, outsideKennels: this.data.outsideKennels, breeds: this.data.breeds
    });
  }

  answerText(stepId) { return answerFor(stepId, this.draft, this.data); }

  async save() {
    if (this.busy) return;
    this.busy = true;
    const btn = this.panel.querySelector('[data-k="save"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Building…'; }
    this.showError('');
    try {
      const result = await G.saveGuidedDogs(this.draft, { onProgress: () => setGuidedDogsDraft(this.draft) });
      clearGuidedDogsDraft();
      this.onSaved();
      this.panel.closest('.kels-row').remove();
      this.chat.you('Yes, build it');
      await this.afterSave(result);
    } catch (e) {
      setGuidedDogsDraft(this.draft);
      if (btn) { btn.disabled = false; btn.textContent = 'Try again'; }
      this.showError(`Hmm, that didn't save: ${e.message || String(e)} Your answers are kept, so you can fix it and try again.`);
    } finally {
      this.busy = false;
    }
  }

  async afterSave({ made, capError }) {
    const dogs = (await Promise.all(made.map((id) => dogRepo.getById(id)))).filter(Boolean);
    const names = draftLabel({ dogs: dogs.map((d) => ({ call_name: dogName(d) })) });
    if (capError) {
      // Lite's cap: what was added, then the app's usual upgrade notice. Nothing else.
      const bubble = await this.chat.say(dogs.length ? `I added ${esc(names)}, and that's as many as I can add here.` : '', { typing: 900 });
      renderUpgradeNudge(bubble, capError);
    } else {
      await this.chat.say(`Done! ✓ I added ${esc(names)}. Your program's looking great.`, { typing: 1100 });
    }
    const bought = dogs.filter((d) => G.canBeBought(d, this.data.own.map((k) => k.id)));
    if (bought.length) await this.acquisitions(bought);
    if (bought.length) await this.shots(bought);
    if (dogs.length && editionFlags.documents) await this.documents(dogs);
    await this.finish(dogs);
  }

  // "Did you buy any of them?": when and who from, and the price, in one form.
  async acquisitions(dogs) {
    const one = dogs.length === 1 ? dogs[0] : null;
    await this.chat.say(`${one ? `Did you buy ${esc(dogName(one))}?` : 'Did you buy any of them?'} I can add when you got ${one ? herHim(one.sex) : 'them'} and who from. A rough date is fine if it's hard to remember.`);
    const go = await this.chat.choose([
      { label: 'Yes, let\'s add that', value: 'yes', primary: true },
      { label: one ? 'No' : 'No, none of them', value: 'no' }
    ]);
    if (go !== 'yes') return;
    const today = todayYMD();
    // "Bought from" starts as the breeder's kennel, when she named one.
    const kennelNames = new Map(await Promise.all(dogs.map(async (d) => [d.id, d.breeder_kennel_id ? (await kennelRepo.getById(d.breeder_kennel_id))?.kennel_name || '' : ''])));
    const res = await this.chat.form({
      title: `<strong>When did you get ${one ? esc(dogName(one)) : 'them'}?</strong><span class="kels-lead">${one ? '' : 'Untick any you didn\'t buy. '}The price goes in Financials as a dog purchase.</span>`,
      html: dogs.map((d) => `<div class="gl-extra-row" data-dog="${esc(d.id)}">
          ${one ? `<strong>${esc(dogName(d))}</strong>` : `<label class="ck-check"><input type="checkbox" data-k="bought" checked> <strong>${esc(dogName(d))}</strong></label>`}
          <div class="ck-inline">
            ${field('Date (rough is fine)', `<input type="date" data-k="date" max="${today}" aria-label="When you got ${esc(dogName(d))}">`)}
            ${field('Bought from (optional)', `<input type="text" data-k="source" value="${esc(kennelNames.get(d.id) || '')}" placeholder="Breeder or kennel" aria-label="Who ${esc(dogName(d))} came from">`)}
            ${field('Price (optional)', `<input type="number" data-k="price" min="0" step="0.01" inputmode="decimal" aria-label="What you paid for ${esc(dogName(d))}">`)}
          </div>
        </div>`).join(''),
      wire: (root) => {
        root.querySelectorAll('input[data-k="bought"]').forEach((box) => box.addEventListener('change', () => {
          box.closest('[data-dog]').querySelector('.ck-inline').style.display = box.checked ? '' : 'none'; // .ck-inline's grid outranks [hidden]
        }));
      },
      submitLabel: 'Save',
      cancelLabel: 'Skip',
      submit: async (root) => {
        const rows = [...root.querySelectorAll('[data-dog]')]
          .filter((el) => el.querySelector('input[data-k="bought"]')?.checked ?? true)
          .map((el) => {
            const v = (k) => el.querySelector(`input[data-k="${k}"]`).value.trim();
            const d = dogs.find((x) => x.id === el.dataset.dog);
            return { dogId: d.id, name: dogName(d), date: v('date'), source: v('source'), price: v('price') };
          });
        const problem = G.acquisitionProblem(rows, today);
        if (problem) return problem;
        await G.saveAcquisitions(rows);
        return rows;
      },
      reply: (rows) => rows.map((r) => [`${one ? '' : `${r.name}: `}${fmt(r.date)}`, r.source ? `from ${r.source}` : '', r.price ? `$${r.price}` : ''].filter(Boolean).join(' ')).join(' · ')
    });
    if (res.done) await this.chat.say(`Added to ${one ? `${esc(dogName(one))}'s timeline` : 'their timelines'}. ✓`, { typing: 500 });
  }

  // "Do you have their shots on record?": the fixed checklist, one dog at a time,
  // each with how long it's good for and a reminder on Today when it's due.
  async shots(dogs) {
    const one = dogs.length === 1 ? dogs[0] : null;
    await this.chat.say(`Do you have ${one ? `${esc(dogName(one))}'s` : 'their'} shots on record? I'll ask about ${VACCINE_CHECKLIST.join(', ').replace(/, ([^,]*)$/, ' and $1')}, and can remind you on Today when ${one ? 'they\'re' : 'each one\'s'} due.`);
    const go = await this.chat.choose([
      { label: 'Yes, let\'s add them', value: 'yes', primary: true },
      { label: 'Not now', value: 'no' }
    ]);
    if (go !== 'yes') return;
    const today = todayYMD();
    for (const dog of dogs) {
      const res = await this.chat.form({
        title: `<strong>${esc(dogName(dog))}'s shots</strong><span class="kels-lead">Fill in the ones ${sheHe(dog.sex)}'s had, and leave the rest blank. A rough date is fine.</span>`,
        html: `${VACCINE_CHECKLIST.map((v) => `<div class="gl-extra-row" data-vaccine="${esc(v)}">
            <strong>${esc(v)}</strong>
            <div class="ck-inline">
              ${field('Date given', `<input type="date" data-k="date" max="${today}" aria-label="${esc(v)} date for ${esc(dogName(dog))}">`)}
              ${field('Good for', `<select data-k="goodFor" aria-label="How long ${esc(v)} is good for">${options(VACCINE_GOOD_FOR, '1')}</select>`)}
            </div>
          </div>`).join('')}
          <label class="ck-check" style="margin-top:12px;"><input type="checkbox" id="gd-shot-remind" checked> Remind me on Today when they're due</label>`,
        submitLabel: 'Save',
        cancelLabel: one ? 'Skip' : `Skip ${dogName(dog)}`,
        submit: async (root) => {
          const rows = [...root.querySelectorAll('[data-vaccine]')].map((el) => ({
            vaccine: el.dataset.vaccine,
            date: el.querySelector('[data-k="date"]').value,
            goodFor: el.querySelector('[data-k="goodFor"]').value
          }));
          const problem = G.shotsProblem(rows, today);
          if (problem) return problem;
          const remind = root.querySelector('#gd-shot-remind').checked;
          const made = await G.saveShots(dog.id, rows, { remind });
          return { made, remind };
        },
        reply: ({ made, remind }) => `${made.map((e) => `${e.title} ${fmt(e.event_date)}`).join(' · ')}${remind && made.some((e) => e.reminder_date) ? ' · remind me' : ''}`
      });
      if (res.done) {
        const due = res.result.made.filter((e) => e.reminder_date).sort((a, b) => a.reminder_date.localeCompare(b.reminder_date))[0];
        await this.chat.say(due
          ? `Saved. ✓ The next one due is ${esc(due.details.vaccine)}, ${esc(fmt(due.reminder_date))}; it'll be on Today's Reminders.`
          : 'Saved. ✓', { typing: 500 });
      }
    }
  }

  // Pro: their papers, filed on each dog as the Documents page files them.
  async documents(dogs) {
    await this.chat.say(`Do you have any papers to file for ${dogs.length === 1 ? esc(dogName(dogs[0])) : 'them'}? Registration, pedigree, health tests… I'll keep them on ${dogs.length === 1 ? her(dogs[0].sex) : 'each dog\'s'} page.`);
    const go = await this.chat.choose([
      { label: 'Yes, let\'s file them', value: 'yes', primary: true },
      { label: 'Not now', value: 'no' }
    ]);
    if (go !== 'yes') return;
    const { storeDocumentFile, createDocument } = await import('./documentModal.js');
    let dog = dogs.length === 1 ? dogs[0] : null;
    for (;;) {
      if (!dog) {
        await this.chat.say('<strong>Which dog is this one for?</strong>', { typing: 400 });
        const id = await this.chat.choose([
          ...dogs.map((d) => ({ label: dogName(d), value: d.id })),
          { label: 'That\'s all for now', value: '' }
        ]);
        if (!id) return;
        dog = dogs.find((d) => d.id === id);
      }
      const filed = await this.documentForm(dog, { storeDocumentFile, createDocument });
      if (filed) await this.chat.say(`Filed on ${esc(dogName(dog))}'s page. ✓`, { typing: 500 });
      const next = await this.chat.choose([
        { label: `Another for ${dogName(dog)}`, value: 'same', primary: true },
        ...(dogs.length > 1 ? [{ label: 'One for another dog', value: 'other' }] : []),
        { label: 'That\'s all for now', value: 'done' }
      ]);
      if (next === 'done') return;
      if (next === 'other') dog = null;
    }
  }

  async documentForm(dog, { storeDocumentFile, createDocument }) {
    let pending = null;
    const extraField = { issuer_or_lab: 'Registry, vet or lab', result: 'Result', registry: 'Registry', registration_number: 'Registration number' };
    const extrasHtml = (type) => documentFieldsFor(type).map((f) => field(`${extraField[f]} (optional)`, input(`gd-doc-${f}`, f === 'registration_number' && type === 'registration' ? dog.registration_number : ''))).join('');
    const res = await this.chat.form({
      title: `<strong>What are you filing for ${esc(dogName(dog))}?</strong><span class="kels-lead">A PDF, or photos of the pages (I'll turn them into one PDF).</span>`,
      html: `${field('What is it?', `<select id="gd-doc-type">${options(DOC_TYPES, 'registration')}</select>`)}
        <div class="field gl-field"><label>The file</label>
          <div class="pill-row">
            <label class="btn">📄 Choose a PDF<input type="file" id="gd-doc-pdf" accept="application/pdf" hidden></label>
            <label class="btn">📷 Take photos<input type="file" id="gd-doc-camera" accept="image/*" capture="environment" multiple hidden></label>
            <label class="btn">🖼 Choose photos<input type="file" id="gd-doc-photos" accept="image/*" multiple hidden></label>
          </div>
          <span class="field-hint" id="gd-doc-picked">Nothing chosen yet.</span>
        </div>
        ${field('Title (optional)', input('gd-doc-title', '', { placeholder: `e.g. ${dogName(dog)}'s registration` }))}
        ${field('Date (optional)', input('gd-doc-date', '', { type: 'date' }))}
        <div id="gd-doc-extras">${extrasHtml('registration')}</div>`,
      wire: (root) => {
        const picked = root.querySelector('#gd-doc-picked');
        const take = (kind, el) => {
          pending = el.files.length ? { kind, files: [...el.files].slice(0, kind === 'pdf' ? 1 : undefined) } : null;
          picked.textContent = !pending ? 'Nothing chosen yet.'
            : kind === 'pdf' ? `📎 ${pending.files[0].name}` : `🖼 ${plural(pending.files.length, 'photo', 'photos')}`;
        };
        root.querySelector('#gd-doc-pdf').addEventListener('change', (e) => take('pdf', e.target));
        root.querySelector('#gd-doc-camera').addEventListener('change', (e) => take('photo', e.target));
        root.querySelector('#gd-doc-photos').addEventListener('change', (e) => take('photo', e.target));
        root.querySelector('#gd-doc-type').addEventListener('change', (e) => {
          root.querySelector('#gd-doc-extras').innerHTML = extrasHtml(e.target.value);
        });
      },
      submitLabel: 'File it',
      cancelLabel: 'Skip this one',
      submit: async (root) => {
        if (!pending) return 'Choose a PDF or photos first.';
        const docType = val(root, 'gd-doc-type');
        const title = val(root, 'gd-doc-title');
        const extras = Object.fromEntries(documentFieldsFor(docType).map((f) => [f, val(root, `gd-doc-${f}`)]));
        const fileId = await storeDocumentFile(pending, { title: title || docType });
        await createDocument({ dog_id: dog.id, doc_type: docType, title, doc_date: val(root, 'gd-doc-date'), notes: '', file_id: fileId, ...extras });
        return { docType, title };
      },
      reply: (r) => `${descriptor(DOC_TYPES, r.docType).label}${r.title ? `: ${r.title}` : ''}`
    });
    return res.done;
  }

  async finish(dogs) {
    const one = dogs.length === 1 ? dogs[0] : null;
    const href = one ? `${pagesPrefix()}dog.html?id=${encodeURIComponent(one.id)}` : `${pagesPrefix()}dogs.html`;
    await this.chat.say(dogs.length ? 'All set. Anything else I can do for you?' : 'Anything else I can do for you?');
    const where = await this.chat.choose([
      ...(dogs.length ? [{ label: one ? `See ${dogName(one)}` : 'See my dogs', value: 'dogs', primary: true }] : []),
      { label: 'Help me with something else', value: 'menu' },
      { label: 'Back to Today', value: 'today' }
    ]);
    if (where === 'dogs') location.href = href;
    else if (where === 'today') location.href = `${pagesPrefix()}today.html`;
    else this.onExit('done');
  }
}
