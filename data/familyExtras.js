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
import { isOpenSale } from './vocab.js';
import { addDaysToYMD } from './dateUtils.js';

export const EXTRA_REQUESTS_KEPT = 50;
export const EXTRA_REQUEST_SHOWN_DAYS = 30; // a decided request stays on their page this long

// The sale a family's extras go on: the newest open sale to the entry's contact
// in the entry's kennel (by sale date, then when it was made). null = none.
export function familySale(entry, sales) {
  if (!entry || !entry.contact_id) return null;
  const open = (sales || []).filter((s) => s && !s.is_archived && s.buyer_contact_id === entry.contact_id && isOpenSale(s)
    && (!entry.kennel_id || !s.kennel_id || s.kennel_id === entry.kennel_id));
  open.sort((a, b) => String(b.sale_date || b.created_at || '').localeCompare(String(a.sale_date || a.created_at || '')));
  return open[0] || null;
}

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
