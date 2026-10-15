// contactSearch.js — "is this person already in her contacts?", one rule for every
// place that asks it: Kels's Add people, the waitlist's approval (an applicant ↔
// a contact, waitlistRules.contactMatches), and the tidy-up's duplicate check
// (tidyRules, which shares the normalizers). Pure: no Dexie.
//
// The rule (Kels Roadmap §4): the same email or phone is the same person
// ('certain'); the same name, or a near one (a slip, dogSearch's word match), is
// only a "maybe this is them" ('possible'), never assumed. A match is always
// offered, never applied by itself.
import { nameKey, nameHit } from './dogSearch.js';

// Name keys: case, spacing and punctuation don't count ("Mary-Ann  Smith." = "mary ann smith").
export const normName = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
export const normEmail = (s) => String(s ?? '').trim().toLowerCase();
// Phone: digits only, and the last 10 so "+1 (555) 123-4567" = "555.123.4567".
export const normPhone = (s) => {
  const d = String(s ?? '').replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-10) : '';
};

const STRENGTH = { certain: 0, possible: 1 };
const REASON = { email: 0, phone: 1, name: 2, 'similar name': 3 };

// How a typed name and a contact's name agree: 'name' (the same), 'similar name'
// (a slip, or one name's words all in the other when both have two or more), or null.
function nameAgreement(typed, onFile) {
  if (!normName(typed) || !normName(onFile)) return null;
  if (normName(typed) === normName(onFile)) return 'name';
  const a = nameKey(typed);
  const b = nameKey(onFile);
  const h = nameHit(a, b);
  if (h === 'exact') return 'name';
  if (h === 'close') return 'similar name';
  if (h === 'partial' && a.split(' ').length >= 2 && b.split(' ').length >= 2) return 'similar name';
  return null;
}

// The contacts that may be the person typed (`typed`: { name, email, phone }),
// surest first: [{ contact, strength: 'certain'|'possible', reason: 'email'|
// 'phone'|'name'|'similar name' }]. Archived contacts and `excludeIds` are left out.
export function findContactMatches(typed = {}, contacts = [], { excludeIds = [] } = {}) {
  const email = normEmail(typed.email);
  const phone = normPhone(typed.phone);
  const skip = new Set(excludeIds);
  const out = [];
  for (const c of contacts) {
    if (c.is_archived || skip.has(c.id)) continue;
    let reason = null;
    if (email && normEmail(c.email) === email) reason = 'email';
    else if (phone && normPhone(c.phone) === phone) reason = 'phone';
    else reason = nameAgreement(typed.name, c.name);
    if (!reason) continue;
    out.push({ contact: c, strength: reason === 'email' || reason === 'phone' ? 'certain' : 'possible', reason });
  }
  return out.sort((a, b) => STRENGTH[a.strength] - STRENGTH[b.strength] || REASON[a.reason] - REASON[b.reason]
    || String(a.contact.name || '').localeCompare(String(b.contact.name || '')));
}

// A vet among her contacts: the tidy-up's "no vet" finding and Add people's
// "Do you have a vet you'd like to add?" both ask this.
export const isVet = (c) => (c?.contact_type || []).includes('vet');
export const hasVet = (contacts = []) => contacts.some((c) => !c.is_archived && isVet(c));

// Why she's shown it, in her words: "Same email", "Similar name".
export const contactMatchReason = (m) => ({ email: 'Same email', phone: 'Same phone', name: 'Same name', 'similar name': 'Similar name' }[m.reason] || '');
