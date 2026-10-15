// guidedLitterUI.js — Kels's "Record a new litter" task: the questions she asks,
// one at a time, in the chat on pages/kels.html (assets/kelsChat.js draws the
// chat). Each question is a "screen" (below): Kels's line, then her answer panel
// with big buttons and Back; her answer is left in the chat as her reply, and
// at the end Kels shows the plan ("I think I got it all. Here's what I'll
// create:") for her to approve before anything is written. The steps, checks,
// review lines and the save itself live in data/guidedLitter.js; this module
// only draws them and keeps the draft.
//
// Her answers, and the chat so far, are kept after every step (settings.js
// guidedLitterDraft), so closing the window loses nothing and Kels offers to
// finish it next time. After the save, Pro shows "Let families know"
// (assets/guidedShareUI.js, Pro-only, imported only when this edition has the
// waitlist or Companion). Reads go through the repos; writes only through
// guidedLitter.saveGuidedLitter.
import { dogRepo } from '../data/dogRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { pairingRepo } from '../data/pairingRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { studServiceRepo } from '../data/studServiceRepo.js';
import { ownKennels, resolveKennelIdForWrite } from '../data/kennelScope.js';
import { editionFlags } from '../data/editionConfig.js';
import { CapExceededError } from '../data/repoBase.js';
import { getGuidedLitterDraft, setGuidedLitterDraft, clearGuidedLitterDraft } from '../data/settings.js';
import {
  DISPOSITION, REGISTRATION_TYPE, PAIRING_METHOD, FEE_STRUCTURE, STUD_SERVICE_TYPE, LITTER_STATUS, PAIRING_STATUS, descriptor
} from '../data/vocab.js';
import { addDaysToYMD } from '../data/dateUtils.js';
import * as G from '../data/guidedLitter.js';
import { findDogMatches, matchReason, breedChoices } from '../data/dogSearch.js';
import { esc, todayYMD } from './ui.js';
import { renderUpgradeNudge } from './upgradeNudge.js';
import { StepConversation, tile, field, input, options, stepper, val, plural, pagesPrefix, kennelPicker, wireKennelPicker, readKennelPicker, contactFields, readContactFields, breedPicker, wireBreedPicker, readBreedPicker } from './kelsSteps.js';

// --- The data the screens read --------------------------------------------------

async function loadData() {
  const [dogs, litters, pairings, kennels, contacts, breedPool] = await Promise.all([
    // Pedigree-only dogs too: a mom or dad typed in may be one (brought into
    // use); they never show among the dogs to pick (damChoices / sireChoices).
    dogRepo.getAll({ includeArchived: false, includePedigreeOnly: true }),
    litterRepo.getAll({ includeArchived: false }),
    pairingRepo.getAll({ includeArchived: false }),
    kennelRepo.getAll({ includeArchived: false }),
    editionFlags.externalOwnership ? contactRepo.getAll({ includeArchived: false }) : Promise.resolve([]),
    kennelRepo.getBreedVocabulary()
  ]);
  return {
    dogs,
    // Her breeds, as the Dog page offers them, for a new mom or dad's breed.
    breeds: breedChoices({ dogs, pool: breedPool }),
    litters,
    pairings,
    kennels,
    contacts: contacts.sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    dogsById: new Map(dogs.map((d) => [d.id, d])),
    littersById: new Map(litters.map((l) => [l.id, l])),
    pairingsById: new Map(pairings.map((p) => [p.id, p])),
    kennelsById: new Map(kennels.map((k) => [k.id, k])),
    contactsById: new Map(contacts.map((c) => [c.id, c])),
    own: await ownKennels()
  };
}

// Facts the step list depends on, worked out from the live records.
async function stepCtx(draft, data) {
  const litter = draft.litterId ? data.littersById.get(draft.litterId) : null;
  const linkedPairing = litter?.pairing_id ? data.pairingsById.get(litter.pairing_id) || null : null;
  const chosenPairing = draft.pairingChoice && draft.pairingChoice !== 'none' ? data.pairingsById.get(draft.pairingChoice) || null : null;
  const pairing = linkedPairing || chosenPairing;
  const dam = draft.newDam ? null : (data.dogsById.get(litter?.dam_id || draft.damId) || null);
  const sire = draft.newSire ? null : (data.dogsById.get(litter?.sire_id || draft.sireId) || null);
  // Existing records are only looked for when both parents are dogs on file.
  const parents = { damId: dam?.id, sireId: sire?.id };
  const litterOptions = draft.lockedSource ? [] : G.litterCandidates({ litters: data.litters, dogs: data.dogs, ...parents });
  const pairingOptions = linkedPairing ? [] : G.pairingCandidates({ pairings: data.pairings, litters: data.litters, ...parents });
  if (litter) draft.autoKennelId = litter.kennel_id;
  else draft.autoKennelId = await resolveKennelIdForWrite({ inheritFrom: [dam, sire, pairing].filter(Boolean) });
  const services = pairing && editionFlags.studServices ? await studServiceRepo.getByPairing(pairing.id) : [];
  return {
    litter, pairing, linkedPairing, dam, sire, litterOptions, pairingOptions,
    needsKennel: !litter && !draft.autoKennelId,
    canOutsideDog: Boolean(editionFlags.externalOwnership),
    contacts: data.contacts,
    breeds: data.breeds,
    outsideKennels: data.kennels.filter((k) => !k.is_own_kennel),
    canStudService: Boolean(editionFlags.studServices),
    sireIsOutside: G.isOutsideDog(sire),
    hasStudService: services.some((x) => !x.is_archived)
  };
}

const dogLabel = (d) => `${esc(d.call_name)}${d.registered_name ? ` <span class="faint">${esc(d.registered_name)}</span>` : ''}`;

// --- Screens --------------------------------------------------------------------------
// Each returns { title, html, read?(root), wire?(root, go) }. read() copies the
// screen's inputs into the draft; tiles write to the draft directly when tapped.

function screens(draft, data, ctx) {
  const nameOf = (role) => {
    const r = G.ROLES[role];
    return draft[r.newKey]?.call_name || ctx[role]?.call_name || ctx[role]?.registered_name || `the ${r.word}`;
  };
  const damName = nameOf('dam');
  const sireName = nameOf('sire');
  const otherId = (role) => (role === 'dam' ? draft.sireId : draft.damId);

  // "Who is the mom/dad?": her dogs as tiles, "show all", and a new dog.
  function parentPick(role) {
    const r = G.ROLES[role];
    const showKey = role === 'dam' ? 'showAllDams' : 'showAllSires';
    const list = role === 'dam'
      ? G.damChoices(data.dogs, { showAll: draft[showKey] }).filter((d) => d.id !== draft.sireId)
      : G.sireChoices(data.dogs, { showAll: draft[showKey], excludeId: draft.damId });
    const word = role === 'dam' ? 'girls' : 'boys';
    return {
      title: `Who is the ${r.word}?`,
      html: `<div class="gl-tiles">
          ${list.map((d) => tile(role, d.id, dogLabel(d), { selected: !draft[r.newKey] && draft[r.idKey] === d.id, sub: G.isOutsideDog(d) ? 'Outside dog' : (d.breed || '') })).join('')}
          ${tile(role, '__new', `➕ A dog that isn't in KennelOS yet`, { selected: Boolean(draft[r.newKey]), sub: `I'll ask for ${r.possessive} name` })}
        </div>
        <button type="button" class="btn gl-more" data-act="toggle">${draft[showKey] ? `Show only my ${word}` : `Show all ${word}, outside dogs too`}</button>`,
      onTile: (value) => {
        if (value === '__new') {
          draft[r.idKey] = null;
          draft[r.newKey] = draft[r.newKey] || G.newDogSpec(role === 'sire' ? (ctx.dam?.breed || draft.newDam?.breed || '') : '');
        } else {
          draft[r.idKey] = value;
          draft[r.newKey] = null;
        }
        resetMatches();
        return true;
      },
      onAct: (act) => { if (act === 'toggle') { draft[showKey] = !draft[showKey]; return 'redraw'; } return null; }
    };
  }

  // Changing a parent means the litter / breeding found for the old pair is moot.
  function resetMatches() {
    draft.litterChoice = null;
    draft.pairingChoice = null;
    draft.litterId = null;
    draft.pairingId = null;
    draft.source = 'new';
    draft.stud = null;
  }

  function parentNew(role) {
    const r = G.ROLES[role];
    const spec = draft[r.newKey];
    return {
      title: `Tell me about the ${r.word}`,
      html: `<p class="gl-lead">Just the basics. You can add more on ${r.possessive} page later.</p>
        ${field(`${role === 'dam' ? 'Her' : 'His'} name`, input('gl-nd-name', spec.call_name, { placeholder: role === 'dam' ? 'e.g. Daisy' : 'e.g. Duke' }))}
        ${breedPicker('gl-nd-breed', spec.breed, data.breeds)}
        ${field('Registered name (if you know it)', input('gl-nd-reg', spec.registered_name))}
        ${ctx.canOutsideDog ? `<p class="gl-q">Whose dog is ${r.pronoun}?</p>
        <div class="gl-tiles gl-tiles-small">
          ${tile('mine', 'yes', 'Mine', { selected: spec.mine })}
          ${tile('mine', 'no', 'Someone else\'s', { selected: !spec.mine })}
        </div>` : ''}`,
      onTile: (value) => { spec.mine = value === 'yes'; return 'redraw'; },
      wire: (root) => wireBreedPicker(root, 'gl-nd-breed'),
      read: (root) => {
        spec.call_name = val(root, 'gl-nd-name');
        spec.breed = readBreedPicker(root, 'gl-nd-breed');
        spec.registered_name = val(root, 'gl-nd-reg');
      },
      // Look for the dog on file before making a new one (dogSearch: both names,
      // both ways, then the breed).
      after: () => {
        const asked = `${spec.call_name}|${spec.registered_name}|${spec.breed}`.toLowerCase();
        if (spec.matchesFor === asked) return;
        spec.matchesFor = asked;
        spec.matchDeclined = false;
        spec.bringInId = null;
        spec.matchIds = findDogMatches(data.dogs, { callName: spec.call_name, registeredName: spec.registered_name, breed: spec.breed, sex: r.sex },
          { excludeIds: [otherId(role)] }).slice(0, 6).map((m) => m.dog.id);
      }
    };
  }

  function parentMatch(role) {
    const r = G.ROLES[role];
    const spec = draft[r.newKey];
    const found = spec.matchIds.map((id) => data.dogsById.get(id)).filter(Boolean);
    const reasons = new Map(findDogMatches(data.dogs, { callName: spec.call_name, registeredName: spec.registered_name, breed: spec.breed, sex: r.sex })
      .map((m) => [m.dog.id, matchReason(m)]));
    const describe = (d) => [
      reasons.get(d.id),
      d.breed,
      d.pedigree_only ? 'From a pedigree' : G.isOutsideDog(d) ? 'Outside dog' : 'Your dog',
      d.date_of_birth ? `born ${G.fmt(d.date_of_birth)}` : ''
    ].filter(Boolean).join(' · ');
    const one = found.length === 1;
    return {
      title: one ? `We found ${esc(found[0].call_name || found[0].registered_name)}. Is this the ${r.word}?` : `We found dogs with that name. Is one of them the ${r.word}?`,
      html: `<p class="gl-lead">${one ? 'This dog is already in KennelOS.' : 'These dogs are already in KennelOS.'} Using ${one ? 'it' : 'one'} keeps ${r.possessive} records in one place.</p>
        <div class="gl-tiles">
          ${found.map((d) => tile('match', d.id, `${one ? `Yes, that's ${r.pronoun === 'she' ? 'her' : 'him'}: ` : ''}${dogLabel(d)}`, { selected: spec.bringInId === d.id, sub: describe(d) })).join('')}
          ${tile('match', 'none', `No, ${r.pronoun}'s a different dog`, { selected: spec.matchDeclined, sub: `Add ${spec.call_name ? esc(spec.call_name) : `the ${r.word}`} as a new dog` })}
        </div>`,
      onTile: (value) => {
        spec.bringInId = null;
        if (value === 'none') { spec.matchDeclined = true; return true; }
        // A dog only on a pedigree: brought into use with her answers (and,
        // someone else's, its owner), instead of a second one.
        if (data.dogsById.get(value)?.pedigree_only) { spec.bringInId = value; spec.matchDeclined = false; return true; }
        draft[r.idKey] = value;
        draft[r.newKey] = null;
        resetMatches();
        return true;
      }
    };
  }

  function parentOwner(role) {
    const r = G.ROLES[role];
    const s = draft[r.newKey];
    const owner = s.owner || (s.owner = { name: '', phone: '', email: '' });
    return {
      title: `Who owns ${esc(s.call_name || (r.pronoun === 'she' ? 'her' : 'him'))}?`,
      html: `${data.contacts.length ? field('Someone already in your contacts', `<select id="gl-so-pick"><option value="">Someone new…</option>${data.contacts.map((c) => `<option value="${esc(c.id)}"${s.ownerId === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`) : ''}
        <div id="gl-so-new"${s.ownerId ? ' hidden' : ''}>
          ${contactFields('gl-so', owner, { nameLabel: 'Owner\'s name' })}
        </div>`,
      wire: (root) => {
        root.querySelector('#gl-so-pick')?.addEventListener('change', (e) => { root.querySelector('#gl-so-new').hidden = Boolean(e.target.value); });
      },
      read: (root) => {
        s.ownerId = val(root, 'gl-so-pick') || null;
        Object.assign(owner, readContactFields(root, 'gl-so'));
        // A picked owner with a kennel names the dog's kennel too.
        const picked = s.ownerId ? data.contactsById.get(s.ownerId) : null;
        if (picked?.kennel_id && !s.kennelId && !s.kennelName) s.kennelId = picked.kennel_id;
      }
    };
  }

  function parentKennel(role) {
    const r = G.ROLES[role];
    const s = draft[r.newKey];
    return {
      title: 'Does the owner have a kennel name?',
      html: `<p class="gl-lead">Optional. Tap Next to skip.</p>
        ${kennelPicker('gl-sk', s, data.kennels.filter((k) => !k.is_own_kennel), { newLabel: 'None, or a new one…' })}`,
      wire: (root) => wireKennelPicker(root, 'gl-sk'),
      read: (root) => Object.assign(s, readKennelPicker(root, 'gl-sk'))
    };
  }

  return {
    dam: () => parentPick('dam'),
    sire: () => parentPick('sire'),
    'dam-new': () => parentNew('dam'),
    'sire-new': () => parentNew('sire'),
    'dam-match': () => parentMatch('dam'),
    'sire-match': () => parentMatch('sire'),
    'dam-owner': () => parentOwner('dam'),
    'sire-owner': () => parentOwner('sire'),
    'dam-kennel': () => parentKennel('dam'),
    'sire-kennel': () => parentKennel('sire'),

    'match-litter': () => ({
      title: 'Is this the litter?',
      html: `<p class="gl-lead">You already have ${ctx.litterOptions.length === 1 ? 'a litter' : 'litters'} for ${esc(damName)} and ${esc(sireName)} with no puppies entered yet.</p>
        <div class="gl-tiles">
          ${ctx.litterOptions.map((l) => tile('litter', l.id, esc(l.nickname || `${damName} × ${sireName}`), {
            selected: draft.litterChoice === l.id,
            sub: [descriptor(LITTER_STATUS, l.status).label, l.whelp_date ? `due ${G.fmt(l.whelp_date)}` : '', `entered ${G.fmt((l.created_at || '').slice(0, 10))}`].filter(Boolean).join(' · ')
          })).join('')}
          ${tile('litter', 'none', 'No, this is a new litter', { selected: draft.litterChoice === 'none' })}
        </div>`,
      onTile: (value) => {
        G.applyLitterChoice(draft, value === 'none' ? null : data.littersById.get(value), data.dogs);
        return true;
      }
    }),

    'match-pairing': () => ({
      title: 'Is this the breeding?',
      html: `<p class="gl-lead">${ctx.litter ? 'This litter has no breeding linked to it. ' : ''}You have ${ctx.pairingOptions.length === 1 ? 'a breeding' : 'breedings'} of ${esc(damName)} and ${esc(sireName)} on file.</p>
        <div class="gl-tiles">
          ${ctx.pairingOptions.map((p) => tile('pairing', p.id, esc(`${damName} × ${sireName}`), {
            selected: draft.pairingChoice === p.id,
            sub: [descriptor(PAIRING_STATUS, p.status).label, p.planned_date ? `bred ${G.fmt(p.planned_date)}` : '', p.expected_due_date ? `due ${G.fmt(p.expected_due_date)}` : ''].filter(Boolean).join(' · ')
          })).join('')}
          ${tile('pairing', 'none', 'No, a different breeding', { selected: draft.pairingChoice === 'none', sub: 'I\'ll ask when she was bred' })}
        </div>`,
      onTile: (value) => {
        G.applyPairingChoice(draft, value === 'none' ? null : data.pairingsById.get(value));
        return true;
      }
    }),

    bred: () => ({
      title: `When was ${esc(damName)} bred?`,
      html: `<p class="gl-lead">Leave a date blank if you don't know it.</p>
        ${field('First breeding date', input('gl-bred', draft.bredDate, { type: 'date' }))}
        ${field('Last breeding date (if bred more than once)', input('gl-bred-last', draft.lastBredDate, { type: 'date' }))}
        <p class="gl-q">How was she bred?</p>
        <div class="gl-tiles gl-tiles-small">${PAIRING_METHOD.map((m) => tile('method', m.value, esc(m.label), { selected: draft.method === m.value })).join('')}</div>`,
      onTile: (value) => { draft.method = draft.method === value ? '' : value; return 'redraw'; },
      read: (root) => { draft.bredDate = val(root, 'gl-bred'); draft.lastBredDate = val(root, 'gl-bred-last'); }
    }),

    'stud-service': () => {
      const st = draft.stud || (draft.stud = { record: null, fee_structure: '', fee_amount: '', type: G.methodType(draft.method) || '' });
      return {
        title: `Record the stud service for ${esc(sireName)}?`,
        html: `<p class="gl-lead">This keeps track of what you agreed with his owner, like the stud fee or a pick puppy.</p>
          <div class="gl-tiles gl-tiles-small">
            ${tile('stud', 'yes', 'Yes', { selected: st.record === true })}
            ${tile('stud', 'no', 'No, skip it', { selected: st.record === false })}
          </div>
          <div id="gl-ss-more"${st.record ? '' : ' hidden'}>
            ${field('What was agreed?', `<select id="gl-ss-fee">${options(FEE_STRUCTURE, st.fee_structure, 'Not sure')}</select>`)}
            ${field('Stud fee in dollars (if any)', input('gl-ss-amount', st.fee_amount, { type: 'number', min: 0, step: '0.01', inputmode: 'decimal' }))}
            ${field('Did she visit him, or was it shipped?', `<select id="gl-ss-type">${options(STUD_SERVICE_TYPE, st.type, 'Not sure')}</select>`)}
          </div>`,
        onTile: (value) => { st.record = value === 'yes'; return value === 'yes' ? 'redraw' : true; },
        read: (root) => {
          if (!st.record) return;
          st.fee_structure = val(root, 'gl-ss-fee');
          st.fee_amount = val(root, 'gl-ss-amount');
          st.type = val(root, 'gl-ss-type');
        }
      };
    },

    born: () => {
      const today = todayYMD();
      const yesterday = addDaysToYMD(today, -1);
      return {
        title: 'When were the puppies born?',
        html: `<div class="gl-tiles gl-tiles-small">
            ${tile('born', today, 'Today', { selected: draft.whelpDate === today })}
            ${tile('born', yesterday, 'Yesterday', { selected: draft.whelpDate === yesterday })}
          </div>
          ${field('Or pick the date', input('gl-born', draft.whelpDate, { type: 'date' }))}`,
        onTile: (value) => { draft.whelpDate = value; return 'redraw'; },
        read: (root) => { draft.whelpDate = val(root, 'gl-born'); }
      };
    },

    count: () => ({
      title: 'How many puppies?',
      html: `${stepper('gl-alive', draft.alive, 'Born alive')}
        ${stepper('gl-dead', draft.deceased, 'Born not alive')}
        ${stepper('gl-abn', draft.abnormalities, 'With abnormalities (optional)')}
        ${G.recordedPupCount(draft) ? `<p class="muted gl-note">${G.recordedPupCount(draft)} already entered on this litter. Next you'll go through each one.</p>` : ''}`,
      read: (root) => {
        draft.alive = val(root, 'gl-alive');
        draft.deceased = val(root, 'gl-dead') || '0';
        draft.abnormalities = val(root, 'gl-abn');
      },
      after: () => {
        G.syncPups(draft);
        if (!draft.readyDate && draft.whelpDate) draft.readyDate = G.defaultReadyDate(draft.whelpDate);
      }
    }),

    kennel: () => ({
      title: 'Which kennel is this litter under?',
      html: `<div class="gl-tiles">${data.own.map((k) => tile('kennel', k.id, esc(k.kennel_name), { selected: draft.kennelId === k.id })).join('')}</div>`,
      onTile: (value) => { draft.kennelId = value; return true; }
    }),

    plans: () => ({
      title: 'What are your plans for each puppy?',
      html: `<p class="gl-lead"><strong>Available</strong> puppies are the ones offered to families. You can change this any time.</p>
        <div class="gl-setall">
          <span>Set all to:</span>
          <select id="gl-all-disp" aria-label="Plan for every puppy">${options(DISPOSITION, '', 'Plan…')}</select>
          <select id="gl-all-reg" aria-label="Registration for every puppy"><option value="">Registration…</option><option value="__none">Registration not decided</option>${REGISTRATION_TYPE.map((r) => `<option value="${esc(r.value)}">${esc(r.label)}</option>`).join('')}</select>
          <button type="button" class="btn btn-sm" data-act="apply-all">Apply to all</button>
        </div>
        <div class="gl-plan-list">
          ${draft.pups.map((p, i) => `<div class="gl-plan-row">
            <strong>${esc(p.call_name)}</strong> <span class="faint">${p.sex === 'female' ? 'Girl' : 'Boy'}</span>
            <select data-pup="${i}" data-k="disposition" aria-label="Plan for ${esc(p.call_name)}">${options(DISPOSITION, p.disposition)}</select>
            <select data-pup="${i}" data-k="intended_registration" aria-label="Registration for ${esc(p.call_name)}">${options(REGISTRATION_TYPE, p.intended_registration, 'Registration not decided')}</select>
          </div>`).join('')}
        </div>`,
      read: (root) => {
        root.querySelectorAll('select[data-pup]').forEach((sel) => { draft.pups[Number(sel.dataset.pup)][sel.dataset.k] = sel.value; });
      },
      onAct: (act, root) => {
        if (act !== 'apply-all') return null;
        const disp = val(root, 'gl-all-disp');
        const reg = val(root, 'gl-all-reg');
        root.querySelectorAll('select[data-k="disposition"]').forEach((s) => { if (disp) s.value = disp; });
        root.querySelectorAll('select[data-k="intended_registration"]').forEach((s) => { if (reg) s.value = reg === '__none' ? '' : reg; });
        return 'read-redraw';
      }
    }),

    prices: () => {
      const p = draft.prices;
      const moneyInput = (k) => input(`gl-pr-${k}`, p[k], { type: 'number', min: 0, step: '0.01', inputmode: 'decimal' });
      const available = draft.pups.filter((x) => x.disposition === 'available');
      return {
        title: 'What are you asking for them?',
        html: `<p class="gl-lead">${draft.pricesFilled ? 'Filled in from your last litter of this breed. Change anything that\'s different.' : 'Leave blank anything you haven\'t decided.'}</p>
          <div class="gl-price-grid">
            <div><h3>Boys</h3>${field('Price', moneyInput('expected_price_male'))}${field('Deposit', moneyInput('expected_deposit_male'))}${field('Extra for Full registration', moneyInput('full_reg_surcharge_male'))}</div>
            <div><h3>Girls</h3>${field('Price', moneyInput('expected_price_female'))}${field('Deposit', moneyInput('expected_deposit_female'))}${field('Extra for Full registration', moneyInput('full_reg_surcharge_female'))}</div>
          </div>
          ${available.length ? `<div class="gl-preview"><p class="gl-q">How families will see the available puppies:</p><ul id="gl-price-preview">${previewItems(available, p)}</ul></div>` : ''}`,
        wire: (root) => {
          root.querySelectorAll('input[id^="gl-pr-"]').forEach((el) => el.addEventListener('input', () => {
            for (const k of Object.keys(p)) p[k] = val(root, `gl-pr-${k}`);
            const list = root.querySelector('#gl-price-preview');
            if (list) list.innerHTML = previewItems(available, p);
          }));
        },
        read: (root) => { for (const k of Object.keys(p)) p[k] = val(root, `gl-pr-${k}`); }
      };
    },

    dates: () => ({
      title: 'Important dates',
      html: `${field('When can families start putting down deposits? (optional)', input('gl-dep', draft.acceptDepositsDate, { type: 'date' }))}
        ${field('When will they be ready to go home?', input('gl-ready', draft.readyDate, { type: 'date' }), 'Starts at 8 weeks after birth.')}`,
      read: (root) => { draft.acceptDepositsDate = val(root, 'gl-dep'); draft.readyDate = val(root, 'gl-ready'); }
    }),

    extras: () => ({
      title: 'A few extras (optional)',
      html: `<p class="gl-lead">Fill in anything you have now, or tap Next to skip. You can add these later on each puppy's page.</p>
        ${field('Litter nickname', input('gl-nick', draft.nickname, { placeholder: 'e.g. The Flower litter' }))}
        ${draft.pups.map((p, i) => `<div class="gl-extra-row"><strong>${esc(p.call_name)}</strong>
          ${field('Microchip number', input(`gl-chip-${i}`, p.microchip_id, { inputmode: 'numeric' }))}
          ${field('Link to photos', input(`gl-url-${i}`, p.url, { type: 'url', placeholder: 'https://' }))}</div>`).join('')}`,
      read: (root) => {
        draft.nickname = val(root, 'gl-nick');
        draft.pups.forEach((p, i) => { p.microchip_id = val(root, `gl-chip-${i}`); p.url = val(root, `gl-url-${i}`); });
      }
    }),

    review: () => {
      const kennel = data.kennelsById.get(draft.kennelId || draft.autoKennelId);
      const namesFor = (spec) => (spec ? {
        owner: spec.ownerId ? data.contactsById.get(spec.ownerId)?.name : '',
        kennel: spec.kennelId ? data.kennelsById.get(spec.kennelId)?.kennel_name : (spec.kennelName || '')
      } : {});
      const sections = G.reviewSections(draft, {
        dam: ctx.dam, sire: ctx.sire, pairing: ctx.pairing, litter: ctx.litter,
        kennelName: data.own.length > 1 ? kennel?.kennel_name : '',
        names: { dam: namesFor(draft.newDam), sire: namesFor(draft.newSire) }
      });
      return {
        title: 'I think I got it all. Here\'s what I\'ll create:',
        html: `<p class="gl-lead">Look it over. Tap <strong>Change</strong> to fix anything, or <strong>Yes, build it</strong> when it's right.</p>
          ${sections.map((s) => `<section class="gl-review-section">
            <div class="row-between"><h3>${esc(s.title)}</h3><button type="button" class="btn btn-sm" data-goto="${esc(s.step)}">Change</button></div>
            <ul>${s.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></section>`).join('')}`,
        isReview: true
      };
    },

    pup: (i) => {
      const p = draft.pups[i];
      return {
        title: `Puppy ${i + 1} of ${draft.pups.length}`,
        html: `${field('Name', input('gl-pup-name', p.call_name), 'A collar color is fine for now.')}
          <p class="gl-q">Boy or girl?</p>
          <div class="gl-tiles gl-tiles-small">
            ${tile('sex', 'male', '♂ Boy', { selected: p.sex === 'male' })}
            ${tile('sex', 'female', '♀ Girl', { selected: p.sex === 'female' })}
          </div>
          ${field('Color and markings (optional)', input('gl-pup-color', p.color_markings, { placeholder: 'e.g. black with white chest' }))}
          ${field('Birth weight in ounces (optional)', input('gl-pup-oz', p.birth_oz, { type: 'number', min: 0, step: '0.1', inputmode: 'decimal' }))}`,
        onTile: (value, root) => { p.call_name = val(root, 'gl-pup-name'); p.sex = value; return 'redraw'; },
        read: (root) => {
          p.call_name = val(root, 'gl-pup-name');
          p.color_markings = val(root, 'gl-pup-color');
          p.birth_oz = val(root, 'gl-pup-oz');
        }
      };
    }
  };
}

function previewItems(pups, prices) {
  return pups.map((p) => {
    const text = G.pupPriceText(p, prices);
    const reg = REGISTRATION_TYPE.find((r) => r.value === p.intended_registration)?.label;
    return `<li><strong>${esc(p.call_name)}</strong>, ${p.sex === 'female' ? 'girl' : 'boy'}${reg ? `, ${esc(reg)}` : ''}: ${text ? esc(text) : '<span class="faint">no price yet</span>'}</li>`;
  }).join('');
}


// --- Her answers, as she'd have said them -------------------------------------------


// The reply bubble left in the chat once a step is answered: plain text.
function answerFor(stepId, draft, data) {
  const dogName = (id) => { const d = data.dogsById.get(id); return d ? (d.call_name || d.registered_name) : ''; };
  const [role, part] = stepId.split('-');
  if (G.ROLES[role]) {
    const r = G.ROLES[role];
    const spec = draft[r.newKey];
    if (!part) return spec ? 'A dog that isn\'t in KennelOS yet' : dogName(draft[r.idKey]);
    if (!spec) return part === 'match' ? `Yes, that's ${r.pronoun === 'she' ? 'her' : 'him'}: ${dogName(draft[r.idKey])}` : '';
    if (part === 'new') return [spec.call_name, spec.registered_name, spec.breed, spec.mine ? 'mine' : 'someone else\'s'].filter(Boolean).join(' · ');
    if (part === 'match') return spec.bringInId ? `Yes, that's ${r.pronoun === 'she' ? 'her' : 'him'}: ${dogName(spec.bringInId)} (from a pedigree)` : `No, ${r.pronoun}'s a different dog`;
    if (part === 'owner') return spec.ownerId ? (data.contactsById.get(spec.ownerId)?.name || 'Someone in my contacts') : [spec.owner.name, spec.owner.phone, spec.owner.email].filter(Boolean).join(' · ');
    if (part === 'kennel') return spec.kennelId ? (data.kennelsById.get(spec.kennelId)?.kennel_name || '') : (spec.kennelName || 'Skip');
  }
  if (stepId.startsWith('pup:')) {
    const p = draft.pups[Number(stepId.slice(4))];
    return [p.call_name, p.sex === 'female' ? 'Girl' : 'Boy', p.color_markings, p.birth_oz ? `${p.birth_oz} oz` : ''].filter(Boolean).join(' · ');
  }
  switch (stepId) {
    case 'match-litter': return draft.litterChoice === 'none' ? 'No, this is a new litter' : 'Yes, that one';
    case 'match-pairing': return draft.pairingChoice === 'none' ? 'No, a different breeding' : 'Yes, that one';
    case 'bred': return [draft.bredDate ? G.fmt(draft.bredDate) : 'Not sure of the date', draft.lastBredDate ? `and ${G.fmt(draft.lastBredDate)}` : '', draft.method ? descriptor(PAIRING_METHOD, draft.method).label : ''].filter(Boolean).join(' · ');
    case 'stud-service': {
      const st = draft.stud || {};
      if (!st.record) return 'No, skip it';
      return ['Yes', st.fee_structure ? descriptor(FEE_STRUCTURE, st.fee_structure).label : '', st.fee_amount ? `$${st.fee_amount}` : ''].filter(Boolean).join(' · ');
    }
    case 'born': return G.fmt(draft.whelpDate);
    case 'count': return [`${draft.alive} born alive`, Number(draft.deceased) ? `${draft.deceased} not alive` : '', Number(draft.abnormalities) ? `${draft.abnormalities} with abnormalities` : ''].filter(Boolean).join(' · ');
    case 'kennel': return data.kennelsById.get(draft.kennelId)?.kennel_name || '';
    case 'plans': {
      const n = (v) => draft.pups.filter((p) => p.disposition === v).length;
      return DISPOSITION.map((d) => (n(d.value) ? `${n(d.value)} ${d.label.toLowerCase()}` : '')).filter(Boolean).join(' · ');
    }
    case 'prices': {
      const p = draft.prices;
      const bit = (who, k) => (p[`expected_price_${k}`] ? `${who} $${p[`expected_price_${k}`]}` : '');
      return [bit('Boys', 'male'), bit('Girls', 'female')].filter(Boolean).join(' · ') || 'Not decided yet';
    }
    case 'dates': return [draft.acceptDepositsDate ? `Deposits from ${G.fmt(draft.acceptDepositsDate)}` : '', draft.readyDate ? `Home ${G.fmt(draft.readyDate)}` : ''].filter(Boolean).join(' · ') || 'Skip';
    case 'extras': {
      const chips = draft.pups.filter((p) => p.microchip_id).length;
      return [draft.nickname ? `Nickname: ${draft.nickname}` : '', chips ? plural(chips, 'microchip', 'microchips') : ''].filter(Boolean).join(' · ') || 'Skip for now';
    }
    default: return '';
  }
}

// --- The conversation -----------------------------------------------------------------

// An unfinished draft, if there is one (Kels offers to finish it).
export function pendingLitterDraft() {
  const draft = getGuidedLitterDraft();
  if (!draft) return null;
  if (draft.v !== G.DRAFT_VERSION) { clearGuidedLitterDraft(); return null; }
  return draft.done ? null : draft;
}

export function discardGuidedLitterDraft() {
  clearGuidedLitterDraft();
}

// Run "Record a new litter" in `chat` (assets/kelsChat.js). `litterId`: started
// from an Expected litter's page. `resume`: carry on the unfinished draft.
// `onExit(reason)` hands the chat back to Kels's menu ('nevermind' | 'later' | 'done').
// `onSaved()` runs once the records are built (nothing is left to save for later).
export async function runLitterTask(chat, { litterId = null, resume = false, onExit = () => {}, onSaved = () => {} } = {}) {
  const data = await loadData();
  let draft = resume ? pendingLitterDraft() : null;
  if (!draft) {
    draft = G.emptyDraft({ litterId });
    draft.history = [];
    if (litterId) {
      const litter = data.littersById.get(litterId);
      if (litter) {
        draft.damId = litter.dam_id;
        draft.sireId = litter.sire_id;
        G.applyLitterChoice(draft, litter, data.dogs);
      }
    }
    if (!(await chat.intro('Absolutely, let\'s get those puppies added!'))) { onExit('nevermind'); return; }
  } else {
    draft.history = draft.history || [];
    await chat.say(`Welcome back! Here's what we have so far for ${esc(draft.label || 'your litter')}:`, { typing: 500 });
    await StepConversation.replay(chat, draft.history);
    await chat.say('Let\'s pick up where we left off.', { typing: 500 });
  }
  return new LitterConversation(chat, draft, data, onExit, onSaved).start();
}

class LitterConversation extends StepConversation {
  constructor(chat, draft, data, onExit, onSaved) {
    super(chat, draft);
    Object.assign(this, { data, onExit, onSaved, ctx: null });
  }

  persist() {
    const d = this.draft;
    d.updatedAt = new Date().toISOString();
    const damName = d.newDam?.call_name || this.data.dogsById.get(d.damId)?.call_name;
    d.label = damName ? `${damName}'s litter` : '';
    if (!d.done) setGuidedLitterDraft(d);
  }

  // An answer changed after a save that stopped partway: write the litter's and
  // pups' fields again on the retry (records already made are kept, by id).
  answerChanged() {
    if (!this.draft.saved) return;
    this.draft.saved.litterUpdated = false;
    this.draft.pups.forEach((p) => { p.saved = false; });
  }

  async loadSteps() {
    this.ctx = await stepCtx(this.draft, this.data);
    return G.stepsFor(this.draft, this.ctx);
  }

  screenFor(stepId) {
    const all = screens(this.draft, this.data, this.ctx);
    if (stepId.startsWith('pup:')) return all.pup(Number(stepId.slice(4)));
    return all[stepId]();
  }

  problem(stepId) { return G.stepProblem(stepId, this.draft, this.ctx); }
  answerText(stepId) { return answerFor(stepId, this.draft, this.data); }

  // Once the mom's breed is known, her last priced litter of that breed fills the prices.
  onAnswered() {
    if (this.draft.pricesFilled) return;
    const breed = this.ctx.dam?.breed || this.draft.newDam?.breed;
    const suggested = breed ? G.suggestedPrices({ litters: this.data.litters, dogsById: this.data.dogsById, breed, excludeLitterId: this.draft.litterId }) : null;
    if (suggested && Object.values(this.draft.prices).every((v) => v === '')) { this.draft.prices = suggested; this.draft.pricesFilled = true; }
  }

  async save() {
    if (this.busy) return;
    this.busy = true;
    const btn = this.panel.querySelector('[data-k="save"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Building…'; }
    this.showError('');
    try {
      await G.saveGuidedLitter(this.draft, { onProgress: () => setGuidedLitterDraft(this.draft) });
      clearGuidedLitterDraft();
      this.onSaved();
      this.panel.closest('.kels-row').remove();
      this.chat.you('Yes, build it');
      await this.afterSave();
    } catch (e) {
      setGuidedLitterDraft(this.draft);
      if (btn) { btn.disabled = false; btn.textContent = 'Try again'; }
      if (e instanceof CapExceededError) {
        renderUpgradeNudge(this.panel.querySelector('.gl-error'), e);
      } else {
        this.showError(`Hmm, that didn't save: ${e.message || String(e)} Your answers are kept, so you can fix it and try again.`);
      }
    } finally {
      this.busy = false;
    }
  }

  async afterSave() {
    const litter = await litterRepo.getById(this.draft.savedLitterId);
    const pups = (await dogRepo.getByLitter(litter.id)).filter((d) => !d.is_archived);
    const name = this.draft.label || 'The litter';
    const litterHref = `${pagesPrefix()}litter.html?id=${encodeURIComponent(litter.id)}`;
    await this.chat.say(`Done! ✓ I built ${esc(name)}${pups.length ? ` with ${plural(pups.length, 'puppy', 'puppies')}` : ''}.`, { typing: 1100 });

    const finish = async () => {
      await this.chat.say(`All set. When you're ready to offer pups to families on your waitlist, use <strong>Open picks</strong> on <a href="${esc(litterHref)}">the litter's page</a>.`);
      const where = await this.chat.choose([
        { label: 'See the litter', value: 'litter', primary: true },
        { label: 'Help me with something else', value: 'menu' },
        { label: 'Back to Today', value: 'today' }
      ]);
      if (where === 'litter') location.href = litterHref;
      else if (where === 'today') location.href = `${pagesPrefix()}today.html`;
      else this.onExit('done');
    };

    const canShare = (editionFlags.waitlist || editionFlags.companion) && pups.some((p) => p.disposition === 'available');
    if (!canShare) { await finish(); return; }
    try {
      const { renderShareStep } = await import('./guidedShareUI.js');
      await this.chat.say('<strong>Want to tell people about the new pups?</strong>');
      const panel = this.chat.panel('<div class="gl-body"></div><div class="kels-panel-foot"></div>');
      await renderShareStep({
        mount: panel.querySelector('.gl-body'),
        foot: panel.querySelector('.kels-panel-foot'),
        litter, pups,
        onDone: (reply) => { panel.closest('.kels-row').remove(); if (reply) this.chat.you(reply); finish(); }
      });
      this.chat.scroll();
    } catch {
      await finish();
    }
  }
}
