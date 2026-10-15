// guidedLitter.js — the guided "Record a new litter" flow's data half (the screens
// are assets/guidedLitterUI.js). One question per screen for a breeder who finds
// the full forms hard. The order:
//   1. Who is the mom? 2. Who is the dad? Each can be "a dog that isn't in
//      KennelOS yet": she types the name, and any dog already on file with that
//      name (outside and pedigree-only dogs included) is offered first ("We found
//      Nell. Is this the mom?"), so a dog is never entered twice. A truly new
//      dog gets the fewest answers that make a record: name, breed, and (Pro)
//      whether she's someone else's, with the owner and their kennel.
//   3. A litter of those two parents with no puppies yet? "Is this the litter?"
//   4. Otherwise (or when that litter has no breeding linked) a breeding of those
//      two? "Is this the breeding?" Failing both, the new-breeding questions.
//   5. The stud service (Pro) for an outside stud, the birth, each puppy, the
//      plans and prices that make them ready to sell, then one review she
//      approves before anything is written.
//
// Three parts, all here so they can be tested without a browser:
//   - the DRAFT: a plain object of her answers (kept after every step by the UI
//     through settings.js, so closing the window loses nothing);
//   - pure helpers: which steps apply, what each step checks, the choices and
//     matches it offers, and the review summary;
//   - saveGuidedLitter(): the writes, every one through the repos (no db here),
//     so each record lands exactly as the normal pages would make it. It is
//     RESUMABLE: each record's id goes back on the draft the moment it's made,
//     so a save that stops halfway picks up where it got to and never makes
//     anything twice.
import { dogRepo } from './dogRepo.js';
import { litterRepo } from './litterRepo.js';
import { pairingRepo } from './pairingRepo.js';
import { contactRepo } from './contactRepo.js';
import { kennelRepo } from './kennelRepo.js';
import { studServiceRepo } from './studServiceRepo.js';
import { eventRepo } from './eventRepo.js';
import { baseFromLitter } from './puppyDefaults.js';
import { addDaysToYMD, todayYMD } from './dateUtils.js';
import {
  SEX, DISPOSITION, REGISTRATION_TYPE, PAIRING_METHOD, FEE_STRUCTURE, STUD_SERVICE_TYPE, descriptor
} from './vocab.js';

// 2: the parents-first order (a version-1 draft from the earlier order is dropped).
export const DRAFT_VERSION = 2;
export const MAX_PUPS = 20;
// The same defaults the Litter and Pairing pages prefill.
export const READY_DAYS_AFTER_WHELP = 56;
export const DUE_DAYS_AFTER_BREEDING = 63;

// Newborns usually wear a colored collar before they have names, so each new pup
// starts named for one; she types over it.
export const COLLAR_COLORS = [
  'Red', 'Blue', 'Green', 'Yellow', 'Purple', 'Orange', 'Pink', 'Black', 'White', 'Brown',
  'Teal', 'Lime', 'Navy', 'Gray', 'Gold', 'Silver', 'Maroon', 'Lavender', 'Mint', 'Coral'
];

// A breeding that's over without a litter isn't one she's recording a birth of.
const DEAD_PAIRING_STATUSES = ['not_pregnant', 'failed', 'cancelled'];
// Dogs offered as the mom or dad: alive and in use.
const usable = (d) => !d.is_archived && !d.pedigree_only && d.status !== 'deceased' && d.status !== 'puppy';
const isMine = (d) => ['owned', 'co_owned', 'leased_in'].includes(d.ownership_type);
// A dog somebody else owns: an outside stud is the case a stud service records.
export const isOutsideDog = (d) => Boolean(d) && ['external', 'leased_in'].includes(d.ownership_type);

const blank = (v) => v == null || String(v).trim() === '';
const trimmed = (v) => (blank(v) ? '' : String(v).trim());
const whole = (v) => Number.isInteger(Number(v)) && Number(v) >= 0 && !blank(v);
const money = (v) => blank(v) || (Number.isFinite(Number(v)) && Number(v) >= 0);
const num = (v) => (blank(v) ? null : Number(v));
const key = () => (globalThis.crypto?.randomUUID?.() || `k${Math.random().toString(36).slice(2)}`);
const norm = (s) => trimmed(s).toLowerCase().replace(/\s+/g, ' ');

// The two parents, by role: which draft fields hold each.
export const ROLES = {
  dam: { idKey: 'damId', newKey: 'newDam', sex: 'female', word: 'mom', pronoun: 'she', possessive: 'her' },
  sire: { idKey: 'sireId', newKey: 'newSire', sex: 'male', word: 'dad', pronoun: 'he', possessive: 'his' }
};

export function emptyDraft({ litterId = null } = {}) {
  const now = new Date().toISOString();
  return {
    v: DRAFT_VERSION,
    startedAt: now,
    updatedAt: now,
    step: null,
    label: '',
    // 'new' until she picks an existing litter ('litter') or breeding ('pairing').
    source: litterId ? 'litter' : 'new',
    // Opened from an Expected litter's page: the parents and litter are known.
    lockedSource: Boolean(litterId),
    litterId,
    pairingId: null,
    damId: null,
    sireId: null,
    showAllDams: false,
    showAllSires: false,
    // A parent who isn't in KennelOS yet: see newDogSpec.
    newDam: null,
    newSire: null,
    // Her answer to "Is this the litter?" / "Is this the breeding?": null = not
    // asked yet, 'none' = no, else the record's id.
    litterChoice: litterId || null,
    pairingChoice: null,
    bredDate: '',
    lastBredDate: '',
    method: '',
    // An outside stud's service (Pro): null = not asked yet.
    stud: null, // { record: bool, fee_structure, fee_amount, type }
    whelpDate: '',
    alive: '',
    deceased: '0',
    abnormalities: '',
    kennelId: null,     // chosen on the kennel step (only asked when it can't be worked out)
    autoKennelId: null, // worked out from the parents / breeding / active kennel
    pups: [],
    prices: {
      expected_price_male: '', expected_deposit_male: '', full_reg_surcharge_male: '',
      expected_price_female: '', expected_deposit_female: '', full_reg_surcharge_female: ''
    },
    pricesFilled: false,
    acceptDepositsDate: '',
    readyDate: '',
    nickname: '',
    // Ids of what the save has made so far (see saveGuidedLitter).
    saved: {},
    done: false
  };
}

// A parent who isn't in KennelOS yet. `mine` false = somebody else's dog (Pro),
// which needs an owner. `matchIds` are dogs already on file by that name, offered
// before a new one is made; `matchesFor` is the name they were looked up for.
export function newDogSpec(breed = '') {
  return {
    call_name: '', registered_name: '', breed, mine: true,
    ownerId: null, owner: { name: '', phone: '', email: '' }, kennelId: null, kennelName: '',
    matchIds: [], matchesFor: null, matchDeclined: false
  };
}

// Dogs already on file that the typed name may mean: same sex (or unknown),
// call or registered name equal, or one containing the other. Every dog that
// isn't archived counts, outside and pedigree-only dogs included.
export function dogMatches(dogs, { name, registeredName = '', sex }) {
  const wanted = [norm(name), norm(registeredName)].filter((n) => n.length >= 2);
  if (!wanted.length) return [];
  const hit = (a, b) => a && b && (a === b || (Math.min(a.length, b.length) >= 3 && (a.includes(b) || b.includes(a))));
  return dogs
    .filter((d) => !d.is_archived && (d.sex === sex || d.sex === 'unknown' || !d.sex))
    .filter((d) => wanted.some((w) => hit(norm(d.call_name), w) || hit(norm(d.registered_name), w)))
    .sort((a, b) => (a.call_name || a.registered_name || '').localeCompare(b.call_name || b.registered_name || ''));
}

export function newPup(existingNames = []) {
  const taken = new Set(existingNames.map((n) => String(n || '').trim().toLowerCase()));
  const color = COLLAR_COLORS.find((c) => !taken.has(`${c} collar`.toLowerCase()));
  return {
    key: key(),
    id: null,
    call_name: color ? `${color} collar` : `Puppy ${existingNames.length + 1}`,
    sex: '',
    color_markings: '',
    birth_oz: '',
    disposition: 'undecided',
    intended_registration: '',
    microchip_id: '',
    url: '',
    weightSaved: false
  };
}

// A puppy record already on the chosen litter, as a draft pup (updated, not made).
export function pupFromDog(d) {
  return {
    key: d.id,
    id: d.id,
    call_name: d.call_name || '',
    sex: d.sex === 'unknown' ? '' : (d.sex || ''),
    color_markings: d.color_markings || '',
    birth_oz: '',
    disposition: d.disposition || 'undecided',
    intended_registration: d.intended_registration || '',
    microchip_id: d.microchip_id || '',
    url: d.url || '',
    weightSaved: false
  };
}

// Make draft.pups match the "born alive" count: new pups are added at the end,
// extra NEW ones come off the end. A pup already saved as a record is never
// dropped (the count step says so).
export function syncPups(draft) {
  const want = Math.min(MAX_PUPS, Math.max(0, Number(draft.alive) || 0));
  const pups = [...draft.pups];
  while (pups.length < want) pups.push(newPup(pups.map((p) => p.call_name)));
  while (pups.length > want && !pups[pups.length - 1].id) pups.pop();
  draft.pups = pups;
  return draft;
}

export const recordedPupCount = (draft) => draft.pups.filter((p) => p.id).length;

// --- Choices ------------------------------------------------------------------

const byName = (a, b) => (a.call_name || '').localeCompare(b.call_name || '', undefined, { numeric: true });

// Moms: her own girls first; "show all" adds every other usable girl.
export function damChoices(dogs, { showAll = false } = {}) {
  return dogs.filter((d) => usable(d) && d.sex === 'female' && (showAll || isMine(d))).sort(byName);
}

// Dads: her own boys, or with showAll every usable boy (an outside stud included).
export function sireChoices(dogs, { showAll = false, excludeId = null } = {}) {
  return dogs.filter((d) => usable(d) && d.sex === 'male' && d.id !== excludeId && (showAll || isMine(d))).sort(byName);
}

// Litters of these two parents with no puppies yet: "Is this the litter?"
export function litterCandidates({ litters, dogs, damId, sireId }) {
  if (!damId || !sireId) return [];
  const withPups = new Set(dogs.filter((d) => d.litter_id).map((d) => d.litter_id));
  return litters
    .filter((l) => !l.is_archived && l.dam_id === damId && l.sire_id === sireId && !withPups.has(l.id))
    .sort((a, b) => (b.whelp_date || b.created_at || '').localeCompare(a.whelp_date || a.created_at || ''));
}

// Breedings of these two parents that are still open and have no litter yet:
// "Is this the breeding?"
export function pairingCandidates({ pairings, litters, damId, sireId }) {
  if (!damId || !sireId) return [];
  const linked = new Set(litters.filter((l) => l.pairing_id).map((l) => l.pairing_id));
  return pairings
    .filter((p) => !p.is_archived && p.dam_id === damId && p.sire_id === sireId && !linked.has(p.id) && !DEAD_PAIRING_STATUSES.includes(p.status))
    .sort((a, b) => (b.planned_date || b.created_at || '').localeCompare(a.planned_date || a.created_at || ''));
}

// The newest litter of this breed that has a price list: its prices are the
// suggested starting point (she changes them).
export function suggestedPrices({ litters, dogsById, breed, excludeLitterId = null }) {
  const target = norm(breed);
  if (!target) return null;
  const keys = Object.keys(emptyDraft().prices);
  const priced = litters
    .filter((l) => l.id !== excludeLitterId && keys.some((k) => !blank(l[k])))
    .filter((l) => norm(dogsById.get(l.dam_id)?.breed) === target)
    .sort((a, b) => (b.whelp_date || b.created_at || '').localeCompare(a.whelp_date || a.created_at || ''));
  if (!priced.length) return null;
  return Object.fromEntries(keys.map((k) => [k, blank(priced[0][k]) ? '' : String(priced[0][k])]));
}

// --- Steps --------------------------------------------------------------------

// The steps for one parent: pick, or the new-dog questions (with "we found…").
function parentSteps(draft, role, ctx) {
  const r = ROLES[role];
  const steps = [role];
  const spec = draft[r.newKey];
  if (spec) {
    steps.push(`${role}-new`);
    if (spec.matchIds?.length) steps.push(`${role}-match`);
    if (ctx.canOutsideDog && !spec.mine) steps.push(`${role}-owner`, `${role}-kennel`);
  }
  return steps;
}

// ctx (worked out by the UI from the live records):
//   litterOptions / pairingOptions — litterCandidates / pairingCandidates for
//                    the chosen parents
//   linkedPairing  — the chosen litter already has a breeding linked
//   needsKennel    — no kennel could be worked out, so she's asked
//   canOutsideDog  — this edition records somebody else's dogs (externalOwnership)
//   canStudService — this edition has stud services
//   sireIsOutside  — the dad she picked is somebody else's dog
//   hasStudService — a stud service is already recorded for the breeding
export function stepsFor(draft, ctx = {}) {
  const steps = [];
  if (!draft.lockedSource) {
    steps.push(...parentSteps(draft, 'dam', ctx), ...parentSteps(draft, 'sire', ctx));
    if (ctx.litterOptions?.length) steps.push('match-litter');
  }
  const hasBreeding = Boolean(ctx.linkedPairing) || (draft.pairingChoice && draft.pairingChoice !== 'none');
  if (!ctx.linkedPairing && ctx.pairingOptions?.length) steps.push('match-pairing');
  if (!hasBreeding) steps.push('bred');
  const outside = (draft.newSire && !draft.newSire.mine) || ctx.sireIsOutside;
  if (ctx.canStudService && outside && !ctx.hasStudService) steps.push('stud-service');
  steps.push('born', 'count');
  if (ctx.needsKennel) steps.push('kennel');
  draft.pups.forEach((_, i) => steps.push(`pup:${i}`));
  if (draft.pups.length) steps.push('plans', 'prices', 'dates', 'extras');
  else steps.push('dates');
  steps.push('review');
  return steps;
}

// One plain-language problem with the step's answers, or null when it's fine.
export function stepProblem(step, draft, ctx = {}) {
  const today = todayYMD();
  const [role, part] = step.split('-');
  if (ROLES[role]) {
    const r = ROLES[role];
    const spec = draft[r.newKey];
    if (!part) {
      if (!draft[r.idKey] && !spec) return `Tap the ${r.word}.`;
      if (role === 'sire' && draft.sireId && draft.sireId === draft.damId) return 'The dad can\'t be the same dog as the mom.';
      if (role === 'dam' && ctx.dam && blank(ctx.dam.breed)) return `${ctx.dam.call_name} has no breed recorded, so ${r.possessive} puppies can't get one. Add ${r.possessive} breed on ${r.possessive} page, then come back: your answers are saved.`;
      return null;
    }
    // She picked a dog on file instead: the new-dog questions no longer apply.
    if (!spec) return null;
    if (part === 'new') {
      if (blank(spec?.call_name)) return `Type the ${r.word}'s name.`;
      if (blank(spec?.breed)) return `Type ${r.possessive} breed.`;
      return null;
    }
    // "We found Nell. Is this the mom?": a found dog clears the new-dog answers;
    // "No, a different dog" sets matchDeclined.
    if (part === 'match') return spec?.matchDeclined ? null : 'Tap one of the choices.';
    if (part === 'owner') {
      if (!spec?.ownerId && blank(spec?.owner?.name)) return `Pick ${r.possessive} owner, or type the owner's name.`;
      return null;
    }
    return null; // -kennel is optional
  }
  switch (step) {
    case 'match-litter':
      return draft.litterChoice ? null : 'Tap one of the choices.';
    case 'match-pairing':
      return draft.pairingChoice ? null : 'Tap one of the choices.';
    case 'bred':
      if (!blank(draft.bredDate) && draft.bredDate > today) return 'The breeding date can\'t be in the future.';
      if (!blank(draft.lastBredDate) && !blank(draft.bredDate) && draft.lastBredDate < draft.bredDate) return 'The last breeding date can\'t be before the first one.';
      return null;
    case 'stud-service': {
      const st = draft.stud;
      if (!st || st.record == null) return 'Choose yes or no.';
      if (st.record && !money(st.fee_amount)) return 'The fee must be a number, like 1500.';
      return null;
    }
    case 'born':
      if (blank(draft.whelpDate)) return 'Pick the day they were born.';
      if (draft.whelpDate > today) return 'The birth date can\'t be in the future.';
      if (!blank(draft.bredDate) && draft.whelpDate < draft.bredDate) return 'The birth date can\'t be before the breeding date.';
      return null;
    case 'count': {
      if (!whole(draft.alive) || !whole(draft.deceased || 0)) return 'Use whole numbers.';
      if (!blank(draft.abnormalities) && !whole(draft.abnormalities)) return 'Use whole numbers.';
      if (Number(draft.alive) + Number(draft.deceased || 0) < 1) return 'Add at least one puppy.';
      if (Number(draft.alive) > MAX_PUPS) return `This guide handles up to ${MAX_PUPS} puppies at a time.`;
      if (Number(draft.alive) < recordedPupCount(draft)) return `${recordedPupCount(draft)} puppies are already entered on this litter, so born alive can't be fewer.`;
      return null;
    }
    case 'kennel':
      return draft.kennelId ? null : 'Pick the kennel this litter belongs to.';
    case 'prices':
      return Object.values(draft.prices).every(money) ? null : 'Prices must be numbers, like 2500.';
    case 'dates':
      if (!blank(draft.readyDate) && !blank(draft.whelpDate) && draft.readyDate < draft.whelpDate) return 'Going-home day can\'t be before they were born.';
      return null;
    default:
      if (step.startsWith('pup:')) {
        const p = draft.pups[Number(step.slice(4))];
        if (!p) return null;
        if (blank(p.call_name)) return 'Give this puppy a name. A collar color is fine.';
        if (!['male', 'female'].includes(p.sex)) return 'Tap Boy or Girl.';
        if (!blank(p.birth_oz) && !(Number(p.birth_oz) > 0)) return 'Birth weight must be a number of ounces, like 12.';
        const dup = draft.pups.findIndex((q) => q !== p && trimmed(q.call_name).toLowerCase() === trimmed(p.call_name).toLowerCase());
        if (dup !== -1) return `Puppy ${dup + 1} already has that name.`;
      }
      return null;
  }
}

// Picking an existing litter or breeding: what it fills in. `litter` / `pairing`
// are the records (null = she said no). Pups already on the litter are kept.
export function applyLitterChoice(draft, litter, dogs = []) {
  draft.litterChoice = litter ? litter.id : 'none';
  draft.litterId = litter ? litter.id : null;
  draft.source = litter ? 'litter' : (draft.pairingChoice && draft.pairingChoice !== 'none' ? 'pairing' : 'new');
  if (!litter) return draft;
  if (litter.whelp_date && litter.whelp_date <= todayYMD()) draft.whelpDate = litter.whelp_date;
  for (const k of Object.keys(draft.prices)) if (!blank(litter[k])) draft.prices[k] = String(litter[k]);
  draft.pricesFilled = Object.values(draft.prices).some((v) => v !== '');
  draft.acceptDepositsDate = litter.accept_deposits_date || draft.acceptDepositsDate;
  draft.readyDate = litter.estimated_ready_date || draft.readyDate;
  draft.nickname = litter.nickname || draft.nickname;
  const pups = dogs.filter((d) => d.litter_id === litter.id && d.status === 'puppy' && !d.is_archived);
  if (pups.length) { draft.pups = pups.map(pupFromDog); draft.alive = String(pups.length); }
  return draft;
}

export function applyPairingChoice(draft, pairing) {
  draft.pairingChoice = pairing ? pairing.id : 'none';
  draft.pairingId = pairing ? pairing.id : null;
  if (draft.source !== 'litter') draft.source = pairing ? 'pairing' : 'new';
  if (pairing) {
    draft.bredDate = pairing.planned_date || '';
    draft.lastBredDate = pairing.last_observed_date || '';
    draft.method = pairing.method || '';
  }
  return draft;
}

// --- Review -------------------------------------------------------------------

const label = (vocab, v, fallback = 'Not decided') => (blank(v) ? fallback : descriptor(vocab, v).label);
const usd = (v) => (blank(v) ? '' : `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);

// The pup's asking price as a buyer would see it: the litter's price for its sex,
// plus the Full surcharge when it's planned for Full (saleDefaults' rule).
export function pupPriceText(pup, prices) {
  const sex = pup.sex === 'female' ? 'female' : 'male';
  const base = num(prices[`expected_price_${sex}`]);
  if (base == null) return '';
  const extra = pup.intended_registration === 'full' ? (num(prices[`full_reg_surcharge_${sex}`]) || 0) : 0;
  const dep = num(prices[`expected_deposit_${sex}`]);
  return `${usd(base + extra)}${dep != null ? `, ${usd(dep)} deposit` : ''}`;
}

function newDogLines(spec, role, names) {
  const s = spec;
  const reg = blank(s.registered_name) ? '' : ` (${trimmed(s.registered_name)})`;
  if (s.mine) return [`A new dog of yours: ${trimmed(s.call_name)}${reg}, ${trimmed(s.breed)}.`];
  const lines = [`A new outside dog: ${trimmed(s.call_name)}${reg}, ${trimmed(s.breed)}, owned by ${names.owner || trimmed(s.owner?.name)}${names.kennel ? `, ${names.kennel}` : ''}.`];
  if (!s.ownerId) lines.push(`A new contact for ${trimmed(s.owner?.name)}.`);
  if (!s.kennelId && !blank(s.kennelName)) lines.push(`A new outside kennel, ${trimmed(s.kennelName)}.`);
  return lines;
}

// Sections of plain lines for the "Here's what I'll save" screen. Each section
// names the step its [Change] link goes back to. ctx: { dam, sire, pairing (the
// breeding being used, if any), litter, kennelName, names: { dam: { owner,
// kennel }, sire: { owner, kennel } } }.
export function reviewSections(draft, ctx = {}) {
  const sections = [];
  const damName = draft.newDam ? trimmed(draft.newDam.call_name) : (ctx.dam?.call_name || ctx.dam?.registered_name || 'the mom');
  const sireName = draft.newSire ? trimmed(draft.newSire.call_name) : (ctx.sire?.call_name || ctx.sire?.registered_name || 'the dad');
  const names = ctx.names || {};

  const breeding = [];
  if (draft.newDam) breeding.push(...newDogLines(draft.newDam, 'dam', names.dam || {}));
  if (draft.newSire) breeding.push(...newDogLines(draft.newSire, 'sire', names.sire || {}));
  if (!ctx.pairing) {
    breeding.push(`A breeding of ${damName} and ${sireName}${blank(draft.bredDate) ? '' : ` on ${fmt(draft.bredDate)}`}${blank(draft.method) ? '' : ` (${descriptor(PAIRING_METHOD, draft.method).label})`}, marked Whelped.`);
  } else {
    breeding.push(`The breeding of ${damName} and ${sireName}${ctx.pairing.planned_date ? ` (${fmt(ctx.pairing.planned_date)})` : ''}${ctx.pairing.status === 'whelped' ? '' : ' is marked Whelped'}${ctx.litter && !ctx.litter.pairing_id ? ' and linked to the litter' : ''}.`);
  }
  if (draft.stud?.record) {
    const fee = draft.stud.fee_structure ? descriptor(FEE_STRUCTURE, draft.stud.fee_structure).label : '';
    breeding.push(`A stud service for ${sireName}${fee ? `: ${fee}` : ''}${blank(draft.stud.fee_amount) ? '' : `, ${usd(draft.stud.fee_amount)}`}.`);
  }
  sections.push({ title: 'The parents & breeding', step: draft.lockedSource ? (ctx.pairing ? 'born' : 'bred') : 'dam', lines: breeding });

  const alive = Number(draft.alive) || 0;
  const deceased = Number(draft.deceased) || 0;
  const birth = [
    `${ctx.litter ? 'The litter you entered before' : 'A new litter'} for ${damName} × ${sireName}, born ${fmt(draft.whelpDate)}.`,
    `${alive} born alive${deceased ? `, ${deceased} not alive` : ''}${blank(draft.abnormalities) || Number(draft.abnormalities) === 0 ? '' : `, ${draft.abnormalities} with abnormalities`}.`
  ];
  if (ctx.kennelName) birth.push(`Kennel: ${ctx.kennelName}.`);
  if (!blank(draft.nickname)) birth.push(`Nickname: ${trimmed(draft.nickname)}.`);
  sections.push({ title: 'The birth', step: 'born', lines: birth });

  if (draft.pups.length) {
    sections.push({
      title: 'The puppies',
      step: 'pup:0',
      lines: draft.pups.map((p) => {
        const bits = [label(SEX, p.sex, '?')];
        if (!blank(p.color_markings)) bits.push(trimmed(p.color_markings));
        if (!blank(p.birth_oz)) bits.push(`${p.birth_oz} oz at birth`);
        return `${trimmed(p.call_name)}: ${bits.join(', ')}${p.id ? ' (already entered, updated)' : ''}`;
      })
    });
    sections.push({
      title: 'Plans & prices',
      step: 'plans',
      lines: draft.pups.map((p) => {
        const price = p.disposition === 'available' ? pupPriceText(p, draft.prices) : '';
        return `${trimmed(p.call_name)}: ${label(DISPOSITION, p.disposition)}, ${label(REGISTRATION_TYPE, p.intended_registration)} registration${price ? `, ${price}` : ''}`;
      })
    });
  }

  const dates = [];
  if (!blank(draft.acceptDepositsDate)) dates.push(`Deposits accepted from ${fmt(draft.acceptDepositsDate)}.`);
  if (!blank(draft.readyDate)) dates.push(`Ready to go home ${fmt(draft.readyDate)}.`);
  const chips = draft.pups.filter((p) => !blank(p.microchip_id)).length;
  const photos = draft.pups.filter((p) => !blank(p.url)).length;
  if (chips) dates.push(`Microchip numbers for ${chips} ${chips === 1 ? 'puppy' : 'puppies'}.`);
  if (photos) dates.push(`Photo links for ${photos} ${photos === 1 ? 'puppy' : 'puppies'}.`);
  if (dates.length) sections.push({ title: 'Dates & extras', step: 'dates', lines: dates });
  return sections;
}

// "Oct 12, 2026" from YYYY-MM-DD, without a time zone shift.
export function fmt(ymd) {
  if (blank(ymd)) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// --- Saving -------------------------------------------------------------------

function litterFieldsFromDraft(draft) {
  const alive = Number(draft.alive) || 0;
  const deceased = Number(draft.deceased) || 0;
  const fields = {
    status: 'whelped',
    whelp_date: draft.whelpDate,
    puppies_born_total: alive + deceased,
    puppies_born_alive: alive,
    puppies_born_deceased: deceased
  };
  if (!blank(draft.abnormalities)) fields.puppies_born_abnormalities = Number(draft.abnormalities);
  for (const [k, v] of Object.entries(draft.prices)) if (!blank(v)) fields[k] = Number(v);
  if (!blank(draft.acceptDepositsDate)) fields.accept_deposits_date = draft.acceptDepositsDate;
  if (!blank(draft.readyDate)) fields.estimated_ready_date = draft.readyDate;
  if (!blank(draft.nickname)) fields.nickname = trimmed(draft.nickname);
  return fields;
}

function pupFields(pup) {
  const fields = {
    call_name: trimmed(pup.call_name),
    sex: pup.sex,
    disposition: pup.disposition || 'undecided',
    intended_registration: pup.intended_registration || null
  };
  for (const k of ['color_markings', 'microchip_id', 'url']) if (!blank(pup[k])) fields[k] = trimmed(pup[k]);
  return fields;
}

export const methodType = (method) => (blank(method) ? null : method === 'natural' ? 'in_person' : 'ai');

// Make a parent who isn't in KennelOS yet: her own dog (in the litter's kennel),
// or somebody else's with the owner and their kennel. Ids land on `s` as made.
async function createParent(spec, role, s, ownKennelId, step) {
  const r = ROLES[role];
  const made = s[role] || (s[role] = {});
  if (made.dogId) return made.dogId;
  const base = {
    call_name: trimmed(spec.call_name), registered_name: trimmed(spec.registered_name), breed: trimmed(spec.breed),
    sex: r.sex, status: 'active_breeding'
  };
  if (spec.mine) {
    const dog = await dogRepo.create({ ...base, ownership_type: 'owned', kennel_id: ownKennelId });
    made.dogId = dog.id;
    await step();
    return dog.id;
  }
  let kennelId = spec.kennelId || made.kennelId || null;
  if (!kennelId && !blank(spec.kennelName)) {
    const k = await kennelRepo.create({ kennel_name: trimmed(spec.kennelName), is_own_kennel: false });
    kennelId = made.kennelId = k.id;
    await step();
  }
  let ownerId = spec.ownerId || made.ownerId || null;
  if (!ownerId) {
    const c = await contactRepo.create({
      name: trimmed(spec.owner?.name), email: trimmed(spec.owner?.email), phone: trimmed(spec.owner?.phone),
      contact_type: ['breeder'], kennel_id: kennelId
    });
    ownerId = made.ownerId = c.id;
    await step();
  }
  const dog = await dogRepo.create({ ...base, ownership_type: 'external', owner_contact_id: ownerId, kennel_id: kennelId });
  made.dogId = dog.id;
  await step();
  return dog.id;
}

// Write everything the review listed. Where a refusal is possible (Lite's litter
// cap) the litter comes before the breeding, so it refuses before that's made.
// `onProgress(draft)` runs after every write so the UI keeps the draft (and its
// saved ids) current. Returns { litterId }.
export async function saveGuidedLitter(draft, { onProgress = () => {} } = {}) {
  const s = draft.saved || (draft.saved = {});
  const step = async () => { draft.updatedAt = new Date().toISOString(); await onProgress(draft); };
  const existingLitter = draft.litterId ? await litterRepo.getById(draft.litterId) : null;
  const kennelId = existingLitter?.kennel_id || draft.kennelId || draft.autoKennelId;

  // 1. Parents who weren't in KennelOS yet.
  const damId = existingLitter?.dam_id || (draft.newDam ? await createParent(draft.newDam, 'dam', s, kennelId, step) : draft.damId);
  const sireId = existingLitter?.sire_id || (draft.newSire ? await createParent(draft.newSire, 'sire', s, kennelId, step) : draft.sireId);
  const dam = await dogRepo.getById(damId);

  // 2. The litter: the one she picked, or a new one. `litterUpdated` is cleared by
  // the UI when she changes an answer after a save that stopped partway.
  const chosenPairingId = draft.pairingChoice && draft.pairingChoice !== 'none' ? draft.pairingChoice : null;
  let litterId = existingLitter?.id || s.litterId || null;
  if (!litterId) {
    const created = await litterRepo.create({
      ...litterFieldsFromDraft(draft), dam_id: damId, sire_id: sireId, kennel_id: kennelId, pairing_id: chosenPairingId
    });
    litterId = s.litterId = created.id;
    s.litterUpdated = true;
    await step();
  } else if (!s.litterUpdated) {
    await litterRepo.update(litterId, litterFieldsFromDraft(draft));
    s.litterUpdated = true;
    await step();
  }

  // 3. The breeding: the litter's own, the one she picked (linked to the litter),
  // or a new one, marked Whelped either way.
  let pairingId = existingLitter?.pairing_id || chosenPairingId || s.pairingId || null;
  if (!pairingId) {
    const p = await pairingRepo.create({
      dam_id: damId, sire_id: sireId, pairing_type: 'actual', status: 'whelped',
      method: draft.method || null,
      planned_date: draft.bredDate || null,
      last_observed_date: draft.lastBredDate || null,
      expected_due_date: draft.bredDate ? addDaysToYMD(draft.bredDate, DUE_DAYS_AFTER_BREEDING) : null,
      kennel_id: kennelId
    });
    pairingId = s.pairingId = p.id;
    await step();
  } else if (!s.pairingWhelped) {
    const p = await pairingRepo.getById(pairingId);
    if (p && p.status !== 'whelped') await pairingRepo.update(pairingId, { status: 'whelped' });
    s.pairingWhelped = true;
    await step();
  }
  if (!s.litterLinked) {
    const l = await litterRepo.getById(litterId);
    if (l.pairing_id !== pairingId) await litterRepo.update(litterId, { pairing_id: pairingId });
    s.litterLinked = true;
    await step();
  }

  // 4. The stud service (Pro), for an outside stud.
  if (draft.stud?.record && !s.studServiceId) {
    const sire = await dogRepo.getById(sireId);
    const fee = draft.stud.fee_structure || null;
    const ss = await studServiceRepo.create({
      // Who travelled isn't asked here: shipped for AI, else our dam went to him.
      direction: (draft.stud.type || methodType(draft.method)) === 'ai' ? 'shipped' : 'to_partner',
      our_dog_id: damId, partner_dog_id: sireId,
      partner_contact_id: sire?.owner_contact_id || null,
      status: 'completed', kennel_id: kennelId, pairing_id: pairingId,
      type: draft.stud.type || methodType(draft.method),
      fee_structure: fee,
      fee_amount: num(draft.stud.fee_amount),
      pick_status: ['pick_of_litter', 'flat_plus_pick'].includes(fee) ? 'pending' : null
    });
    s.studServiceId = ss.id;
    await step();
  }

  // 5. The puppies, each inheriting from the litter exactly as Add Puppies does.
  const litter = await litterRepo.getById(litterId);
  const base = baseFromLitter(litter, dam);
  for (const pup of draft.pups) {
    if (!pup.id) {
      const made = await dogRepo.create({ ...base, ...pupFields(pup) });
      pup.id = made.id;
      pup.saved = true;
      await step();
    } else if (!pup.saved) {
      const current = await dogRepo.getById(pup.id);
      const changes = pupFields(pup);
      if (current && !current.date_of_birth && base.date_of_birth) changes.date_of_birth = base.date_of_birth;
      await dogRepo.update(pup.id, changes);
      pup.saved = true;
      await step();
    }
    if (!blank(pup.birth_oz) && !pup.weightSaved) {
      const oz = Number(pup.birth_oz);
      await eventRepo.create({
        subject_type: 'dog', subject_id: pup.id, event_type: 'weight_check',
        event_date: draft.whelpDate, title: 'Birth weight',
        details: { weight_lbs: Math.floor(oz / 16), weight_oz: Math.round((oz % 16) * 10) / 10 }
      });
      pup.weightSaved = true;
      await step();
    }
  }

  draft.done = true;
  draft.savedLitterId = litterId;
  await step();
  return { litterId };
}

// Default "ready to go home" date for a birth date.
export const defaultReadyDate = (whelpDate) => (blank(whelpDate) ? '' : addDaysToYMD(whelpDate, READY_DAYS_AFTER_WHELP));
export { STUD_SERVICE_TYPE };
