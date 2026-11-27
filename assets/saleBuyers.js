// saleBuyers.js — the Sale page's buyer list and a family's checks (Unified Sale plan
// Phase 2, §2.1 and §2.3), Pro with the waitlist: one list of everyone she has, the
// families on her list first with where they stand ("Their turn", "#2 on the list",
// "Fee due", "Applied", "Client"), and, for a buyer with a place on the list, what
// doesn't fit their answers and the deposit due date their answer window gives.
// Saving goes through waitlistActions.recordSale. Pro-only (proPages.js); the Sale
// page imports it only when editionFlags.waitlist.
import { waitlistEntryRepo } from '../data/waitlistEntryRepo.js';
import { waitlistOfferRepo } from '../data/waitlistOfferRepo.js';
import { waitlistProgramRepo } from '../data/waitlistProgramRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import {
  waitlistConfig, overallPositions, saleBuyerPath, sideSaleIssues, respondByDate, entryName
} from '../data/waitlistRules.js';
import { REGISTRATION_TYPE, SEX, WAITLIST_PREF_SEX, PLACEMENT_PURPOSE, RELEASED_SALE_STATUSES, cleanPurposes, descriptor } from '../data/vocab.js';

const label = (vocab, v) => descriptor(vocab, v)?.label || v || '—';
const PATH_ORDER = { turn: 0, list: 1, applied: 2 };

// Everything the list and the checks read, loaded once per form. `contacts` and
// `sales` are the page's own. → the buyer list's context.
export async function loadSaleBuyers({ contacts = [], sales = [], dogs = [] } = {}) {
  const [entries, offers, kennels] = await Promise.all([
    waitlistEntryRepo.getAll({ includeArchived: false }), waitlistOfferRepo.getAll(), kennelRepo.getAll()
  ]);
  const kennelsById = new Map(kennels.map((k) => [k.id, k]));
  const kennelIds = [...new Set(entries.map((e) => e.kennel_id).filter(Boolean))];
  const programs = new Map();
  const positions = new Map();
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  for (const id of kennelIds) {
    const map = await waitlistProgramRepo.getMapForKennel(id);
    for (const [k, v] of map) programs.set(k, v);
    for (const [k, v] of overallPositions(entries.filter((e) => e.kennel_id === id), id, map, { sales, dogs: dogsById })) positions.set(k, v);
  }
  const live = offers.filter((o) => !o.is_archived);
  // Each family's record she'd sell to: the one with a path, the turn first.
  const withPath = entries
    .map((e) => ({ entry: e, path: saleBuyerPath(e, live) }))
    .filter((x) => x.path)
    .sort((a, b) => PATH_ORDER[a.path] - PATH_ORDER[b.path] || (positions.get(a.entry.id) || 9999) - (positions.get(b.entry.id) || 9999));
  const byContact = new Map();
  for (const x of withPath) if (x.entry.contact_id && !byContact.has(x.entry.contact_id)) byContact.set(x.entry.contact_id, x);
  const bought = new Set(sales.filter((s) => !s.is_archived && !RELEASED_SALE_STATUSES.includes(s.status)).map((s) => s.buyer_contact_id));
  return { entries: withPath, byContact, positions, programs, offers: live, sales, kennelsById, contactsById: new Map(contacts.map((c) => [c.id, c])), bought };
}

// Where a family stands, as the list's badge.
export function standingText(x, refs) {
  if (x.path === 'turn') return 'Their turn';
  if (x.path === 'list') return refs.positions.get(x.entry.id) ? `#${refs.positions.get(x.entry.id)} on the list` : 'On the list';
  return x.entry.status === 'approved' ? 'Fee due' : 'Applied';
}

// The buyer <option>s: families with a place first (by where they stand), then every
// other contact by name ("Client" when they're buying or bought from her). An
// applicant with no contact yet is `entry:<id>`. `current`: the selected value.
export function buyerOptionsHtml(refs, contacts, { current = '', includeArchived = false, esc }) {
  const opt = (value, text) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(text)}</option>`;
  const families = refs.entries.map((x) => {
    const c = x.entry.contact_id ? refs.contactsById.get(x.entry.contact_id) : null;
    if (x.entry.contact_id && refs.byContact.get(x.entry.contact_id) !== x) return '';
    return opt(c ? c.id : `entry:${x.entry.id}`, `${entryName(x.entry, c)} · ${standingText(x, refs)}`);
  }).join('');
  const others = contacts
    .filter((c) => !refs.byContact.has(c.id) && (includeArchived || !c.is_archived || c.id === current))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    .map((c) => opt(c.id, `${c.name}${refs.bought.has(c.id) ? ' · Client' : ''}${c.is_archived ? ' (archived)' : ''}`))
    .join('');
  return `<option value="">— select —</option>${families}${others}`;
}

// The family a buyer value stands for: { entry, path } or null.
export function familyFor(refs, value) {
  if (!value) return null;
  if (value.startsWith('entry:')) return refs.entries.find((x) => x.entry.id === value.slice(6)) || null;
  return refs.byContact.get(value) || null;
}

const FIELD_TEXT = {
  sex: (e, dog) => `They asked for ${label(WAITLIST_PREF_SEX, e.pref_sex || 'any').toLowerCase()}; ${dog.call_name} is ${label(SEX, dog.sex).toLowerCase()}.`,
  breed: (e, dog) => `They asked for ${e.pref_breed}; ${dog.call_name} is ${dog.breed || 'another breed'}.`,
  purposes: (e, dog) => `They're looking for ${cleanPurposes(e.pref_purposes).map((v) => label(PLACEMENT_PURPOSE, v).toLowerCase()).join(', ')}; ${dog.call_name} is planned for ${label(REGISTRATION_TYPE, dog.intended_registration).toLowerCase()} registration.`,
  colors: (e, dog) => `They listed colors that aren't in ${dog.call_name}'s color/markings.`
};

// What doesn't fit the family's answers, for the form (§2.3): each a plain line,
// none blocking. The pup's own checks and other claims are the Sale page's (every
// buyer). → { lines, fields } (`fields`: what "Update their answers to match" writes).
export function familyFitLines(x, dog, litter, refs, today) {
  if (!x || !dog) return { lines: [], fields: [] };
  const config = waitlistConfig(refs.kennelsById.get(x.entry.kennel_id) || null);
  const issues = sideSaleIssues(x.entry, dog, litter, { sales: refs.sales, offers: refs.offers, today, config });
  const lines = issues.fields.map((f) => FIELD_TEXT[f](x.entry, dog));
  if (issues.paused) lines.push('They\'re paused right now.');
  if (issues.listening) lines.push('They\'re listening only for litters from other parents.');
  return { lines, fields: issues.fields };
}

// What saving does for them, in one line under the buyer.
export function pathLine(x, refs) {
  if (!x) return '';
  if (x.path === 'turn') return 'This is their pick in their turn. Their deposit is due by the turn\'s deadline.';
  if (x.path === 'list') return 'Their place on the list stays as it is until the deposit is in; they see this pup on their status page.';
  return `Their application is closed as placed with this sale.${x.entry.status === 'approved' ? ' A fee they pay later is still theirs to credit.' : ''}`;
}

// The deposit due date a family on the list starts with: her answer window, the
// program's own when it has one. Null for the turn (its deadline) and anyone not on
// the list yet (U3: blank until Pricing has a Deposit due rule).
export function familyDepositDue(x, refs, today) {
  if (!x || x.path !== 'list') return null;
  const config = waitlistConfig(refs.kennelsById.get(x.entry.kennel_id) || null);
  return respondByDate(today, config, refs.programs.get(x.entry.waitlist_program_id) || null);
}
