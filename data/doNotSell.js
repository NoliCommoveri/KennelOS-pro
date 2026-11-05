// doNotSell.js — her do-not-sell list's rules (End-State guide §29, "Do-not-sell
// list"). PURE: no Dexie, no DOM; tests/doNotSell.test.js.
//
// A listing is { name, email, phone, reason, added_date, contact_id?,
// source_entry_id? }. It is matched against a waitlist application (or anyone
// typed in) by the one contact rule (contactSearch.findContactMatches): the same
// email or phone is 'certain', the same or a near name only 'possible'. A
// listing made from a contact also matches anything linked to that contact. A
// match only warns; nothing is declined or blocked by it.
import { findContactMatches, normEmail, normPhone } from './contactSearch.js';

const clean = (v) => String(v ?? '').trim();

// What a listing needs: a name, an email or a phone (something to match on).
export function listingProblem(row = {}) {
  if (!clean(row.name) && !clean(row.email) && !clean(row.phone)) return 'Add a name, an email or a phone, so new applications can be matched against it.';
  return '';
}

// A listing's fields, trimmed; reason kept as typed.
export function cleanListing(row = {}) {
  return {
    name: clean(row.name), email: clean(row.email), phone: clean(row.phone),
    reason: clean(row.reason), added_date: row.added_date || null,
    contact_id: row.contact_id || null, source_entry_id: row.source_entry_id || null
  };
}

// The listings this person may be, surest first:
// [{ listing, strength: 'certain'|'possible', reason: 'contact'|'email'|'phone'|'name'|'similar name' }].
// `person`: { name, email, phone }; `contactId`: the contact they're linked to, if any.
// Archived listings (taken off the list) never match.
export function doNotSellMatches(person = {}, listings = [], { contactId = null } = {}) {
  const live = listings.filter((l) => l && !l.is_archived);
  const out = [];
  const seen = new Set();
  if (contactId) {
    for (const l of live) {
      if (l.contact_id === contactId) { out.push({ listing: l, strength: 'certain', reason: 'contact' }); seen.add(l.id); }
    }
  }
  for (const m of findContactMatches(person, live.filter((l) => !seen.has(l.id)))) {
    out.push({ listing: m.contact, strength: m.strength, reason: m.reason });
  }
  return out;
}

// A waitlist entry's matches: its application's name, email and phone, and its contact.
export function entryDoNotSellMatches(entry, listings = []) {
  const a = (entry && entry.application) || {};
  return doNotSellMatches({ name: a.name, email: a.email, phone: a.phone }, listings, { contactId: entry?.contact_id || null });
}

// Why it matched, in her words.
export const doNotSellReason = (m) => ({ contact: 'Same contact', email: 'Same email', phone: 'Same phone', name: 'Same name', 'similar name': 'Similar name' }[m.reason] || '');

// The warning line for a set of matches: one sentence, the surest match first.
// '' when none. "On your do-not-sell list: Jane Doe (same email). Reason: …"
// A name-only match says "may be".
export function doNotSellWarning(matches = []) {
  if (!matches.length) return '';
  const top = matches[0];
  const who = top.listing.name || top.listing.email || top.listing.phone;
  const lead = top.strength === 'certain' ? 'On your do-not-sell list' : 'May be on your do-not-sell list';
  const more = matches.length > 1 ? ` (and ${matches.length - 1} more listing${matches.length === 2 ? '' : 's'})` : '';
  return `${lead}: ${who} (${doNotSellReason(top).toLowerCase()})${more}.${top.listing.reason ? ` Reason: ${top.listing.reason}` : ''}`;
}

// The contacts the Contacts list leaves out: those on the list (not taken off).
export function listedContactIds(listings = []) {
  return new Set(listings.filter((l) => l && !l.is_archived && l.contact_id).map((l) => l.contact_id));
}

// Is this person already listed (the same contact, email or phone)? Adding them
// again is refused with the listing found.
export function alreadyListed(row = {}, listings = []) {
  const email = normEmail(row.email);
  const phone = normPhone(row.phone);
  return listings.find((l) => !l.is_archived && ((row.contact_id && l.contact_id === row.contact_id)
    || (email && normEmail(l.email) === email) || (phone && normPhone(l.phone) === phone))) || null;
}
