// kennelCard.js — the Kennel Card: a small, self-contained payload one breeder
// hands another so both copies of the same real-world kennel point at ONE
// identity (End-State guide §28).
//
// WHY THIS EXISTS. Every cross-kennel reference in the app is otherwise a
// privately-typed string. When you record a stud service with an outside dog, or
// set `dogs.breeder_kennel_id` to the kennel that produced a dog you bought, you
// create a Kennel row that lives only in YOUR database. If the breeder on the
// other side also runs KennelOS, they have their own unrelated row for the same
// kennel, and nothing will ever reconcile the two. A card closes that: the
// receiving app stores the sender's `public_id` (kennelRepo), so from then on
// both databases name the same kennel by the same identifier. Discovery is a
// separate problem and is deliberately NOT solved here — this is peer-to-peer,
// with no server, no directory, and no lookup.
//
// THE ALLOW-LIST INVARIANT, same posture as companionExport.js (see that file's
// header for the full reasoning): `buildKennelCard` names every field it copies
// and copies nothing else, then `assertOnlyKeys` runs a POSITIVE check before the
// card can leave. A new Kennel field does NOT ride along until someone adds it
// here by name. That matters more here than almost anywhere: the Kennel record
// also carries the kennel's PROGRAM (preferred tests, breed pool, lifecycle
// thresholds) and its logo data URL, none of which is identity and none of which
// is anyone else's business.
//
// THE LOAD-BEARING RULE ON THE RECEIVING SIDE: a received card can never set
// `is_own_kennel`. A card names somebody else's kennel by definition, and an
// imported kennel that landed in your own-kennel set would enter your scope
// switcher, your portfolio, your shared test vocabulary, and (in Lite) your cap
// accounting. Import forces `is_own_kennel: false` on create and never touches
// the flag on update.
//
// Transport mirrors the two mechanisms already in the repo: lz-string-compressed
// JSON, carried either in a URL hash (like Furever's seed link — furever/data/
// seedLink.js) or copied as a bare code. Both are offline; nothing here makes a
// network call.
import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from '../vendor/lz-string.min.mjs';
import { kennelRepo, isPublicId } from './kennelRepo.js';

// Bumped only on a breaking shape change; adding an optional field is additive
// and does not need a bump (same rule as COMPANION_BUNDLE_VERSION).
export const KENNEL_CARD_VERSION = 1;

// The hash param a card link carries: `kennels.html#kennelcard=<payload>`.
// Deliberately distinct from Furever's `seed=` and Companion's bare hash so a
// link pasted into the wrong app is inert rather than half-understood.
export const CARD_PARAM = 'kennelcard';

export class KennelCardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KennelCardError';
  }
}

const BAD_CARD_MESSAGE = 'This kennel card could not be read. Ask for a fresh one — it may have been cut short when it was copied.';

// The positive allow-list. Every key a card may carry, and nothing else.
const CARD_KEYS = ['cardVersion', 'publicId', 'kennelName', 'prefix', 'location', 'website', 'issuedAt'];

// The record fields a card can write on the receiving side, paired with the card
// key each comes from. This is the ONLY mapping — `is_own_kennel`, the program
// config (preferred_tests / preferred_breeds / preferred_test_breeds /
// promote_*), `logo_data_url`, `is_archived`, the row `id`, and the timestamps
// are all absent on purpose and are listed in the header above.
export const CARD_FIELDS = [
  { card: 'kennelName', field: 'kennel_name', label: 'Name' },
  { card: 'prefix', field: 'prefix', label: 'Prefix' },
  { card: 'location', field: 'location', label: 'Location' },
  { card: 'website', field: 'website', label: 'Website' }
];

function assertOnlyKeys(obj, allowed, ctx) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) {
      throw new Error(`Kennel card (${ctx}) has unexpected key "${k}" — not shared.`);
    }
  }
  return obj;
}

const text = (v) => String(v ?? '').trim();

// --- Building (sender side) -------------------------------------------------

// Build the card for one of YOUR OWN kennels. Named copy only, no record spread.
// Refuses an outside kennel outright: handing out a card for a kennel you don't
// own would be issuing an identity on somebody else's behalf, which is the exact
// thing the whole design exists to prevent.
export function buildKennelCard(kennel) {
  if (!kennel) throw new KennelCardError('No kennel to share.');
  if (!kennel.is_own_kennel) {
    throw new KennelCardError('Only your own kennels have a card to share. This one belongs to another breeder — ask them for theirs.');
  }
  if (!kennel.public_id) {
    throw new KennelCardError('This kennel has no public ID yet. Open it once to have one issued, then share the card.');
  }
  const card = {
    cardVersion: KENNEL_CARD_VERSION,
    publicId: kennel.public_id,
    kennelName: text(kennel.kennel_name),
    prefix: text(kennel.prefix),
    location: text(kennel.location),
    website: text(kennel.website),
    issuedAt: new Date().toISOString()
  };
  return assertOnlyKeys(card, CARD_KEYS, 'build');
}

export function encodeKennelCard(card) {
  return compressToEncodedURIComponent(JSON.stringify(card));
}

// The link form. `baseUrl` is the sender's own Kennels page, which is the right
// target only when both breeders are on the same origin — which is the common
// case, since every Pro user shares one (pro.kennelos.app). The copyable CODE
// below is the universal path: it works no matter where the recipient's app
// lives, and it's the one to hand someone whose install you don't know.
export function kennelCardLink(card, baseUrl) {
  return `${baseUrl}#${CARD_PARAM}=${encodeKennelCard(card)}`;
}

// --- Reading (receiving side) ----------------------------------------------

// Pull a payload out of a URL hash. Deliberately NOT run through URLSearchParams
// or decodeURIComponent, for the reason furever/data/seedLink.js documents:
// lz-string's encoded-URI-component charset is fragment-safe as-is, and
// form-decoding's "+" → space rule would corrupt the payload.
export function extractCardPayload(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  const prefix = `${CARD_PARAM}=`;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : null;
}

// Accept either a bare payload or a whole pasted link — people paste what they
// were sent, and the difference is not their problem.
export function normalizeCardInput(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  const hashAt = raw.indexOf(`#${CARD_PARAM}=`);
  if (hashAt !== -1) return raw.slice(hashAt + CARD_PARAM.length + 2);
  return raw;
}

// Decompress → parse → validate. Throws KennelCardError (a message meant for a
// breeder, not a stack trace) on anything malformed, rather than letting a
// truncated paste half-apply. Unknown extra keys are dropped rather than
// rejected, so a card issued by a LATER version still imports its v1 identity.
export function decodeKennelCard(input) {
  const payload = normalizeCardInput(input);
  if (!payload) throw new KennelCardError(BAD_CARD_MESSAGE);

  let json = null;
  try {
    json = decompressFromEncodedURIComponent(payload);
  } catch {
    json = null;
  }
  if (!json) throw new KennelCardError(BAD_CARD_MESSAGE);

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new KennelCardError(BAD_CARD_MESSAGE);
  }
  if (!parsed || typeof parsed !== 'object') throw new KennelCardError(BAD_CARD_MESSAGE);

  const publicId = text(parsed.publicId);
  if (!publicId) throw new KennelCardError(BAD_CARD_MESSAGE);
  if (!isPublicId(publicId)) {
    throw new KennelCardError('That code isn’t a KennelOS kennel card — it may be a Furever seed link or a Companion link instead.');
  }
  const kennelName = text(parsed.kennelName);
  if (!kennelName) throw new KennelCardError('That kennel card has no kennel name on it.');

  const card = {
    cardVersion: Number(parsed.cardVersion) || 1,
    publicId,
    kennelName,
    prefix: text(parsed.prefix),
    location: text(parsed.location),
    website: text(parsed.website),
    issuedAt: text(parsed.issuedAt)
  };
  return assertOnlyKeys(card, CARD_KEYS, 'decode');
}

// The fields this card would change on an existing record — the diff the preview
// shows. A card only ever carries the four identity fields, and a blank one on
// the card is "not supplied", never "clear the value I already have".
export function cardChanges(card, existing) {
  const changes = [];
  for (const { card: cardKey, field, label } of CARD_FIELDS) {
    const to = text(card[cardKey]);
    if (!to) continue;
    const from = text(existing[field]);
    if (from !== to) changes.push({ field, label, from, to });
  }
  return changes;
}

// --- Preview / apply --------------------------------------------------------
// Every import in this app is a dry-run preview before a commit (CLAUDE.md), and
// a payload that arrived from another person is the last place to make an
// exception. `previewKennelCard` writes NOTHING; the UI renders what it returns
// and only then calls `applyKennelCard`.
//
// Outcomes:
//   'create'    — no local kennel carries this identity. Offers `candidates`:
//                 unlinked outside kennels whose NAME matches, so an existing
//                 hand-typed record can be linked instead of duplicated. Offered,
//                 never applied automatically — a name is not a key.
//   'update'    — a linked outside kennel exists; `changes` is the diff.
//   'unchanged' — linked, and the card says nothing new.
//   'own'       — the identity is one of YOUR kennels. Nothing is written; a card
//                 from outside must never edit your own kennel's name.
export async function previewKennelCard(card) {
  const existing = await kennelRepo.getByPublicId(card.publicId);
  if (existing && existing.is_own_kennel) {
    return { action: 'own', card, existing, changes: [], candidates: [] };
  }
  if (existing) {
    const changes = cardChanges(card, existing);
    return { action: changes.length ? 'update' : 'unchanged', card, existing, changes, candidates: [] };
  }
  const candidates = await kennelRepo.findUnlinkedByName(card.kennelName);
  return { action: 'create', card, existing: null, changes: [], candidates };
}

// Commit a previewed card.
//   linkToId — optional id of an existing UNLINKED kennel to attach this identity
//              to (the user picked one of the preview's `candidates`), instead of
//              creating a second record for a kennel they already typed in.
// Returns { kennel, action } with the action actually taken.
export async function applyKennelCard(card, { linkToId = null } = {}) {
  const patch = {};
  for (const { card: cardKey, field } of CARD_FIELDS) {
    const value = text(card[cardKey]);
    if (value) patch[field] = value;
  }

  const existing = await kennelRepo.getByPublicId(card.publicId);
  if (existing) {
    // Never let an incoming card rewrite one of the user's own kennels.
    if (existing.is_own_kennel) return { kennel: existing, action: 'own' };
    const changes = cardChanges(card, existing);
    if (!changes.length) return { kennel: existing, action: 'unchanged' };
    return { kennel: await kennelRepo.update(existing.id, patch), action: 'update' };
  }

  if (linkToId) {
    const target = await kennelRepo.getById(linkToId);
    if (!target) throw new KennelCardError('That kennel is no longer on this device.');
    if (target.is_own_kennel) throw new KennelCardError('That is one of your own kennels — it already has its own identity.');
    if (target.public_id) throw new KennelCardError('That kennel is already linked to a different card.');
    return {
      kennel: await kennelRepo.update(linkToId, { ...patch, public_id: card.publicId }),
      action: 'linked'
    };
  }

  // A kennel that arrived from its owner is, definitionally, not one of ours.
  const kennel = await kennelRepo.create({
    ...patch,
    public_id: card.publicId,
    is_own_kennel: false
  });
  return { kennel, action: 'created' };
}
