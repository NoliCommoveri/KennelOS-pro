// applicationDuplicates.js — one family who applied twice to the same waitlist
// (docs/KennelOS_Duplicate_Applications_Plan.md; End-State guide §29, "Duplicate
// applications"). PURE: entries in, pairs, a suggested keep, a blocker and the
// kept entry's changes out; waitlistActions.mergeApplications writes them.
//
// Nothing merges by itself. A pair found here is only a suggestion ("These may
// be the same family"); she can also mark two as one family with nothing in
// common (a different spelling, a different email). She picks the one to keep;
// it keeps its own place in line, status, fee, link and requests, takes the other
// one's answers where she chooses them (blanks fill in), and the other is deleted.
// A fee the deleted one paid becomes a credit on the kept one (receivedCredits).
import { findContactMatches } from './contactSearch.js';
import { anchorDate } from './waitlistRules.js';
import { newCredit } from './receivedCredits.js';

// Open applications and families on the list: the places a family can hold twice by mistake.
export const LIVE_STATUSES = Object.freeze(['applied', 'approved', 'active']);
export const isLiveEntry = (e) => Boolean(e) && !e.is_archived && LIVE_STATUSES.includes(e.status);

export const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

// Where "Not the same" is remembered (nudge ledger): the Import/Export scan's key,
// Kels's tidy-up's and Today's, so none of them asks about the pair again.
export function duplicateDismissKeys(aId, bId) {
  const pk = pairKey(aId, bId);
  return [`dup:waitlist_entries:${pk}`, `tidy:dupapplication:${pk}`, `waitlist-duplicate:${pk}`];
}

const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && !v.length);
const sameValue = (a, b) => (typeof a === 'string' && typeof b === 'string' ? a.trim() === b.trim() : JSON.stringify(a) === JSON.stringify(b));

// Who an entry says they are: its contact's details and the application's (an
// approved family's email may differ from what they typed), each tried.
function identities(entry, contact) {
  const a = entry.application || {};
  const out = [{ name: a.name, email: a.email, phone: a.phone }];
  if (contact) out.unshift({ name: contact.name, email: contact.email, phone: contact.phone });
  return out.filter((x) => x.name || x.email || x.phone);
}

const STRENGTH = { certain: 0, possible: 1 };
const REASON = { contact: 0, email: 1, phone: 2, name: 3, 'similar name': 4 };

// How two entries' families agree: { strength: 'certain'|'possible', reason } or
// null. The same contact, email or phone is certain; the same or a near name is
// only possible (contactSearch's one rule).
export function entriesMatch(a, b, contactsById = new Map()) {
  if (a.contact_id && a.contact_id === b.contact_id) return { strength: 'certain', reason: 'contact' };
  let best = null;
  for (const x of identities(a, contactsById.get(a.contact_id))) {
    for (const y of identities(b, contactsById.get(b.contact_id))) {
      const m = findContactMatches(x, [{ id: 'other', ...y }])[0];
      if (!m) continue;
      const hit = { strength: m.strength, reason: m.reason };
      if (!best || STRENGTH[hit.strength] < STRENGTH[best.strength]
        || (hit.strength === best.strength && REASON[hit.reason] < REASON[best.reason])) best = hit;
    }
  }
  return best;
}

// What a reason reads as: "same phone", "a similar name".
export function matchReasonText(m) {
  if (!m) return '';
  return { contact: 'the same contact', email: 'the same email', phone: 'the same phone', name: 'the same name', 'similar name': 'a similar name' }[m.reason] || '';
}

// The other live entries on `entry`'s list that may be the same family, surest
// first: [{ entry, strength, reason }]. `dismissed(aId, bId)` → true leaves a pair out.
export function applicationMatches(entry, entries, { contactsById = new Map(), dismissed = () => false } = {}) {
  if (!isLiveEntry(entry)) return [];
  const out = [];
  for (const other of entries) {
    if (other.id === entry.id || other.kennel_id !== entry.kennel_id || !isLiveEntry(other) || dismissed(entry.id, other.id)) continue;
    const m = entriesMatch(entry, other, contactsById);
    if (m) out.push({ entry: other, ...m });
  }
  return out.sort((x, y) => STRENGTH[x.strength] - STRENGTH[y.strength] || REASON[x.reason] - REASON[y.reason]
    || String(x.entry.applied_date || '').localeCompare(String(y.entry.applied_date || '')));
}

// Every likely pair, per kennel: [{ key, a, b, strength, reason }], the older
// application as `a`, certain first. For Today, Kels and the Import/Export scan.
export function duplicateApplicationPairs(entries, { contactsById = new Map(), dismissed = () => false } = {}) {
  const byKennel = new Map();
  for (const e of entries) {
    if (!isLiveEntry(e)) continue;
    if (!byKennel.has(e.kennel_id)) byKennel.set(e.kennel_id, []);
    byKennel.get(e.kennel_id).push(e);
  }
  const out = [];
  for (const list of byKennel.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [x, y] = [list[i], list[j]];
        if (dismissed(x.id, y.id)) continue;
        const m = entriesMatch(x, y, contactsById);
        if (!m) continue;
        const [a, b] = older(x, y);
        out.push({ key: pairKey(a.id, b.id), a, b, ...m });
      }
    }
  }
  return out.sort((p, q) => STRENGTH[p.strength] - STRENGTH[q.strength]);
}

const older = (x, y) => (String(x.applied_date || x.created_at || '') <= String(y.applied_date || y.created_at || '') ? [x, y] : [y, x]);

const STATUS_RANK = { active: 3, approved: 2, applied: 1 };
const hasOpenOffer = (e, offers) => offers.some((o) => o.entry_id === e.id && !o.is_archived && o.outcome === 'open');
const answerCount = (e) => Object.values(e.application || {}).filter((v) => !blank(v)).length;

// Which of two to keep by default: the one further along (on the list, then
// approved), then one with a turn open, then the earlier place in line (or
// application), then the one with more answers, then the older. Never just the
// newer one, which is usually the duplicate.
export function suggestKeepEntry(a, b, offers = []) {
  const cmp = [
    (STATUS_RANK[b.status] || 0) - (STATUS_RANK[a.status] || 0),
    Number(hasOpenOffer(b, offers)) - Number(hasOpenOffer(a, offers)),
    String(anchorDate(a) || a.applied_date || '9999').localeCompare(String(anchorDate(b) || b.applied_date || '9999')),
    answerCount(b) - answerCount(a),
    String(a.created_at || '').localeCompare(String(b.created_at || ''))
  ].find((x) => x !== 0);
  return cmp > 0 ? b : a;
}

// Why these two can't be merged (a sentence), or null. `offers`: both entries'.
export function applicationMergeBlocker(keep, drop, offers = []) {
  if (!keep || !drop || keep.id === drop.id) return 'Pick two different applications.';
  if (keep.kennel_id !== drop.kennel_id) return 'They\'re on two different waitlists, so they\'re two places on purpose.';
  if (!isLiveEntry(keep) || !isLiveEntry(drop)) {
    return 'Only open applications and families on the list can be merged. A closed one stays in their history.';
  }
  if (hasOpenOffer(keep, offers) && hasOpenOffer(drop, offers)) {
    return 'Both of them have a turn open. Record the outcome of one of those turns first, then merge them.';
  }
  const dropOffered = offers.some((o) => o.entry_id === drop.id && !o.is_archived);
  if (dropOffered && keep.status !== 'active') {
    return 'The one you\'d delete has been offered litters and the one you\'d keep isn\'t on the list yet. Keep the one that\'s on the list.';
  }
  return null;
}

// Fields she chooses between where both have a value and they differ (beside
// every application answer), blanks filled from the other. Everything else that
// makes their place in line stays the kept one's own: status and its dates, fee,
// program, status link, requests, listen-only, pauses.
export const CHOOSE_FIELDS = Object.freeze([
  { key: 'pref_sex', label: 'Sex wanted' },
  { key: 'pref_breed', label: 'Breed wanted' },
  { key: 'pref_purposes', label: 'Looking for' },
  { key: 'pref_colors', label: 'Colors wanted' },
  { key: 'ready_timing', label: 'Ready for a puppy' }
]);
// 'any' is the default of a sex preference: the other's answer fills it.
const prefBlank = (key, v) => blank(v) || (key === 'pref_sex' && v === 'any');

// Where the two disagree: [{ key, label, keep, drop, answer? }]. An application
// answer's key is `application.<question id>`; `labelOf(id)` names its question.
export function applicationConflicts(keep, drop, { labelOf = (id) => id } = {}) {
  const out = [];
  const ka = keep.application || {};
  const da = drop.application || {};
  for (const id of new Set([...Object.keys(ka), ...Object.keys(da)])) {
    if (blank(ka[id]) || blank(da[id]) || sameValue(ka[id], da[id])) continue;
    out.push({ key: `application.${id}`, label: labelOf(id), keep: ka[id], drop: da[id], answer: id });
  }
  for (const f of CHOOSE_FIELDS) {
    if (prefBlank(f.key, keep[f.key]) || prefBlank(f.key, drop[f.key]) || sameValue(keep[f.key], drop[f.key])) continue;
    out.push({ ...f, keep: keep[f.key], drop: drop[f.key] });
  }
  return out;
}

const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;

// What the deleted application paid toward its fee, as a credit for the kept
// one, or null. A fee she marked received (less any part a credit paid, since
// those credits move too), else a fee paid online before approval. Waived pays nothing.
export function paidFeeCredit(drop) {
  let amount = 0;
  let date = '';
  let method = '';
  if (drop.fee_received_date && drop.fee_payment_method !== 'Waived') {
    amount = num(drop.fee_amount) - num(drop.fee_credit_amount);
    date = drop.fee_received_date;
    method = drop.fee_payment_method || '';
  } else if (drop.fee_paid_online && drop.fee_paid_online.date) {
    const p = drop.fee_paid_online;
    amount = typeof p.amount === 'number' ? p.amount : num(drop.fee_amount);
    date = p.date;
    method = p.method || 'Credit/debit card';
  }
  if (!(amount > 0) || !date) return null;
  return { amount: Math.round(amount * 100) / 100, date, method };
}

const joinById = (a = [], b = []) => {
  const seen = new Set(a.map((x) => x && x.id));
  return [...a, ...b.filter((x) => x && x.id && !seen.has(x.id))];
};
const joinPlain = (a = [], b = []) => [...new Set([...a, ...b])];
const joinRows = (a = [], b = []) => {
  const seen = new Set(a.map((x) => JSON.stringify(x)));
  return [...a, ...b.filter((x) => !seen.has(JSON.stringify(x)))];
};

// The changes to write on the kept entry. `choices[key] === 'drop'` takes the
// other's value for a conflict. `today` dates the merge line in their history;
// `dropName` is the deleted application's name, as it read.
export function applicationMergeChanges(keep, drop, choices = {}, { today, dropName = '' } = {}) {
  const changes = {};
  // Their answers: hers per conflict, blanks filled in.
  const ka = keep.application || {};
  const da = drop.application || {};
  const app = { ...ka };
  for (const [id, v] of Object.entries(da)) {
    if (blank(v)) continue;
    if (blank(ka[id]) || choices[`application.${id}`] === 'drop') app[id] = v;
  }
  if (JSON.stringify(app) !== JSON.stringify(ka)) changes.application = app;
  // The other's question wording, so its answers keep their labels.
  if (Array.isArray(drop.application_questions)) {
    const snap = joinById(Array.isArray(keep.application_questions) ? keep.application_questions : [], drop.application_questions);
    if (snap.length !== (keep.application_questions || []).length) changes.application_questions = snap;
  }
  for (const f of CHOOSE_FIELDS) {
    const k = keep[f.key];
    const d = drop[f.key];
    if (prefBlank(f.key, d)) continue;
    if (prefBlank(f.key, k) || (choices[f.key] === 'drop' && !sameValue(k, d))) changes[f.key] = d;
  }
  // Who they are: the kept one's contact, else the other's.
  if (!keep.contact_id && drop.contact_id) changes.contact_id = drop.contact_id;
  // Where they live (pickup distance), when the kept one doesn't know.
  for (const key of ['home_place', 'home_miles', 'home_measured_date']) {
    if (blank(keep[key]) && !blank(drop[key]) && blank(keep.home_place)) changes[key] = drop[key];
  }
  // Their history and money, from both.
  const lists = {
    messages: joinById(keep.messages, drop.messages).sort((x, y) => String(x.at || '').localeCompare(String(y.at || ''))),
    pref_change_log: joinRows(keep.pref_change_log, drop.pref_change_log).sort((x, y) => String(x.date || '').localeCompare(String(y.date || ''))),
    program_suggestions_declined: joinPlain(keep.program_suggestions_declined, drop.program_suggestions_declined),
    soon_notified_litter_ids: joinPlain(keep.soon_notified_litter_ids, drop.soon_notified_litter_ids)
  };
  for (const [key, joined] of Object.entries(lists)) if (joined.length !== (keep[key] || []).length) changes[key] = joined;
  let credits = joinById(keep.received_credits, drop.received_credits);
  const fee = paidFeeCredit(drop);
  if (fee) {
    credits = [...credits, newCredit({
      amount: fee.amount, date: fee.date, method: fee.method,
      note: `Application fee paid on their duplicate application${drop.applied_date ? ` (applied ${drop.applied_date})` : ''}`
    })];
  }
  if (credits.length !== (keep.received_credits || []).length) changes.received_credits = credits;
  const kn = String(keep.notes || '').trim();
  const dn = String(drop.notes || '').trim();
  if (dn && dn !== kn && !kn.includes(dn)) changes.notes = kn ? `${kn}\n\n${dn}` : dn;
  // A line in their timeline, so it says what happened after the other is gone.
  changes.merged_applications = [...(keep.merged_applications || []), ...(drop.merged_applications || []), {
    date: today, name: String(dropName || da.name || '').trim(), applied_date: drop.applied_date || null,
    status: drop.status, ...(fee ? { fee_credit: fee.amount } : {})
  }];
  return changes;
}
