// familyExtras.js — extras a family asks for (and cancels) on their waitlist
// status page (docs/KennelOS_Family_Requests_Plan.md §3): which of her extras they
// may ask for today, the ones already on their sale they may still cancel, and
// their requests as their page shows them. Pure: no db; callers pass the records.
//
// Every request waits for her (plan D2). A request lives on the waitlist entry,
// `extra_requests` = [{ id, kind: 'add' | 'cancel', list_id, charge_id?, name,
// note, requested_date, decided?, decided_date? }], newest last; approving it
// (waitlistActions.approveExtraRequest) changes the sale.
import { kennelChargeList, kennelChargeGroups, requestWindow, chargeRules, saleExtraCharges, WINDOW_FIELDS } from './extraCharges.js';
import { isOpenSale, RELEASED_SALE_STATUSES } from './vocab.js';
import { addDaysToYMD } from './dateUtils.js';

export const EXTRA_REQUESTS_KEPT = 50;
export const EXTRA_REQUEST_SHOWN_DAYS = 30; // a decided request stays on their page this long

// The sale this waitlist record's family requests act on (extras, pickup, backing
// out, the Companion link): the record's OWN pup, never another run's. A family
// back on the list for a second pup has two records; each handles its own sale.
//  1. the sale the record was placed with (`placed_sale_id`), while it's open;
//  2. else the pick on one of its open offers (a sale awaiting the deposit);
//  3. else an open sale to its contact in its kennel that no record of theirs
//     claims (made on the Sale page, not through an offer, or a record placed
//     before placements were linked), newest first. It goes to ONE of their
//     records: the one with no claim of its own that's open (applied / approved /
//     active), else the newest. With one record, that's the record.
// `offers`: the kennel's offers (or at least this family's); `entries`: the
// kennel's records (or at least this family's). null = none.
// `keep` picks the sales that can count (open ones; a family's credit also counts
// a delivered sale: creditSale below).
export function familySale(entry, sales, offers = [], entries = [], keep = isOpenSale) {
  if (!entry) return null;
  const list = (sales || []).filter((s) => s && !s.is_archived && keep(s));
  const newest = (xs) => xs.sort((a, b) => String(b.sale_date || b.created_at || '').localeCompare(String(a.sale_date || a.created_at || '')))[0] || null;
  const claims = (e) => new Set([
    ...(e.placed_sale_id ? [e.placed_sale_id] : []),
    ...(offers || []).filter((o) => o && o.entry_id === e.id && o.outcome === 'open' && o.sale_id && !o.is_archived).map((o) => o.sale_id)
  ]);
  if (entry.placed_sale_id) return list.find((s) => s.id === entry.placed_sale_id) || null;
  const own = claims(entry);
  if (own.size) return newest(list.filter((s) => own.has(s.id)));
  if (!entry.contact_id) return null;
  const family = [entry, ...(entries || []).filter((e) => e && e.id !== entry.id && !e.is_archived && e.contact_id === entry.contact_id && e.kennel_id === entry.kennel_id)];
  const claimed = new Set(family.flatMap((e) => [...claims(e)]));
  const unclaimed = family.filter((e) => !claims(e).size);
  const OPEN = ['applied', 'approved', 'active'];
  const when = (e) => String(e.applied_date || e.created_at || '');
  const owner = unclaimed.sort((a, b) => (OPEN.includes(b.status) - OPEN.includes(a.status)) || when(b).localeCompare(when(a)) || String(b.id).localeCompare(String(a.id)))[0];
  if (owner?.id !== entry.id) return null;
  return newest(list.filter((s) => s.buyer_contact_id === entry.contact_id && !claimed.has(s.id)
    && (!entry.kennel_id || !s.kennel_id || s.kennel_id === entry.kennel_id)));
}

// The sale a family's credits for funds received go toward (receivedCredits.js):
// their sale as familySale finds it, a delivered one included; never a sale that
// was returned, cancelled or voided (its credit is theirs again).
export const creditSale = (entry, sales, offers = [], entries = []) =>
  familySale(entry, sales, offers, entries, (s) => !!s.status && !RELEASED_SALE_STATUSES.includes(s.status));

// The pup's birth date: its own, else its litter's.
export const pupBirthDate = (dog, litter) => dog?.date_of_birth || litter?.whelp_date || litter?.birth_date || null;

export const pendingExtraRequests = (entry) => (Array.isArray(entry?.extra_requests) ? entry.extra_requests : []).filter((r) => r && !r.decided);

// Can the family still cancel this charge themselves? Only an extra they could
// ask for, nothing paid on it, and not past its cancel age. → { until } or null.
export function familyCancel(charge, item, groups, birthDate, today) {
  if (!item || !item.family_can_request) return null;
  if ((charge.payments || []).some((st) => st.paid_date)) return null;
  const rules = chargeRules(item, groups);
  if (rules.cancel_until_weeks != null && !birthDate) return null;
  const until = requestWindow(item, groups, birthDate)?.cancel_until ?? null;
  if (until && until < today) return null;
  return { until };
}

// What a family's status page shows of their extras. `kennel` is the sale's kennel
// (its price list), `birthDate` the pup's. → null when there's nothing to show, else
// { available: [{ id, name, group, description, open_from, open_until }],
//   current: [{ id, list_id, name, group, can_cancel, cancel_until }],
//   requests: [{ id, kind, list_id, charge_id, name, requested_date, decided, decided_date }] }
// No prices or amounts, ever (plan D1).
export function familyExtrasView({ entry, sale, kennel, birthDate = null, today }) {
  if (!sale || !isOpenSale(sale)) return null;
  const list = kennelChargeList(kennel);
  const groups = kennelChargeGroups(kennel);
  const byId = new Map(list.map((x) => [x.id, x]));
  const charges = saleExtraCharges(sale);
  const onSale = new Set(charges.map((c) => c.list_id).filter(Boolean));
  const available = [];
  for (const x of list) {
    if (!x.family_can_request || onSale.has(x.id)) continue;
    const rules = chargeRules(x, groups);
    const windowed = WINDOW_FIELDS.slice(0, 2).some((k) => rules[k] != null);
    if (windowed && !birthDate) continue; // an age rule with no birth date to count from: not offered
    const w = requestWindow(x, groups, birthDate) || { open_from: null, open_until: null };
    if (w.open_until && w.open_until < today) continue;
    available.push({ id: x.id, name: x.label, group: x.group || '', description: x.description || '', open_from: w.open_from, open_until: w.open_until });
  }
  const current = charges.filter((c) => c.list_id && byId.get(c.list_id)?.family_can_request).map((c) => {
    const cancel = familyCancel(c, byId.get(c.list_id), groups, birthDate, today);
    return { id: c.id, list_id: c.list_id, name: c.label, group: c.group || byId.get(c.list_id).group || '', can_cancel: Boolean(cancel), cancel_until: cancel?.until ?? null };
  });
  const requests = (Array.isArray(entry?.extra_requests) ? entry.extra_requests : [])
    .filter((r) => r && r.requested_date && (!r.decided || (r.decided_date && addDaysToYMD(r.decided_date, EXTRA_REQUEST_SHOWN_DAYS) >= today)))
    .map((r) => ({ id: r.id, kind: r.kind, list_id: r.list_id || null, charge_id: r.charge_id || null, name: r.name || '', requested_date: r.requested_date, decided: r.decided || null, decided_date: r.decided_date || null }));
  if (!available.length && !current.length && !requests.length) return null;
  return { available, current, requests };
}

// A request added to the entry's list (once per id), oldest dropped past the cap.
export function withExtraRequest(entry, request) {
  const list = Array.isArray(entry?.extra_requests) ? entry.extra_requests : [];
  if (list.some((r) => r.id === request.id)) return null;
  return [...list, request].slice(-EXTRA_REQUESTS_KEPT);
}
