// contractAddOns.js — the facts a sale's separate agreements fill (Integrations plan
// §2.1a): transport, delayed pickup (boarding), and one agreement per extra (each
// of her price-list extras, e.g. a training package, has its own form, tied to it by
// `extra_list_id` on the form's row). Pure: the caller (contractSend.js) reads the
// records.
//
//   addOnFacts({ sale, events, litter, priceList, today }) →
//     { transport, boarding, extras: [{ charge, row, stay }], pickupDate, pickupFrom }
//   extraFor(addOns, listId)  the sale's extra a form is for, or null
//   pickupToSet(form, addOns) the date to offer when the agreement needs a pickup
//                             on the calendar and there is none
//
// A training package (an extra with `boarding_days`) is boarded in place of standard
// boarding: its stay is a boarding event linked to the sale and the extra
// (goHome.trainingStaysFor). Not logged yet, the stay is the one Today's nudge would
// log (from the ready date, or today once that has passed), marked `logged: false`.
// The pup can go home from the later of its ready date and the day after the last
// stay (familyPickup.pickupFrom's rule, `pickupFrom`), and standard boarding runs
// from then to the day before its pickup. A boarding agreement and a training
// package's agreement are dated by that pickup (the sale's `pickupDate` field), so
// sending one with no pickup on the calendar asks for it first (pickupToSet).
import { readyDateOf, pickupFor, defaultStart, boardingEnd, hasDeferredBoarding, trainingStaysFor, trainingStayEvent } from './goHome.js';
import { saleExtraCharges, stepDueDate } from './extraCharges.js';
import { addDaysToYMD } from './dateUtils.js';

const text = (v) => String(v ?? '').trim();
const lower = (v) => text(v).toLowerCase();

// The pickup (or drop-off) for this sale: the next one on the calendar, else the latest.
function pickupEventOf(sale, events, today) {
  const list = (events || []).filter((e) => e.subject_id === sale.dog_id && pickupFor(sale)(e))
    .sort((a, b) => a.event_date.localeCompare(b.event_date));
  return list.find((e) => e.event_date >= today) || list[list.length - 1] || null;
}

// One extra's stay: the logged one(s), else the projected one. null = it has no stay.
function stayOf(sale, charge, events, start) {
  if (!charge.boarding_days) return null;
  const logged = trainingStaysFor(sale, charge, events || []);
  if (logged.length) {
    return {
      start: logged.map((e) => e.event_date).sort()[0],
      end: logged.map((e) => e.event_end_date || e.event_date).sort().pop(),
      logged: true
    };
  }
  if (!start) return null;
  const e = trainingStayEvent({ id: sale.dog_id }, sale, charge, start);
  return { start: e.event_date, end: e.event_end_date, logged: false };
}

export function addOnFacts({ sale, events = [], litter = null, priceList = [], today }) {
  if (!sale) return null;
  const ready = readyDateOf(litter);
  const pickup = pickupEventOf(sale, events, today);
  const rows = new Map((priceList || []).map((r) => [r.id, r]));
  const extras = saleExtraCharges(sale).filter((c) => !c.fee_for).map((charge) => {
    const row = (charge.list_id && rows.get(charge.list_id))
      || (priceList || []).find((r) => lower(r.label) === lower(charge.label)) || null;
    return { charge, row, stay: stayOf(sale, charge, events, defaultStart(ready, today)) };
  });
  const lastStay = extras.map((x) => x.stay?.end).filter(Boolean).sort().pop() || null;
  const pickupFrom = [ready, lastStay ? addDaysToYMD(lastStay, 1) : null].filter(Boolean).sort().pop() || '';

  const transport = {
    fee: Number(sale.transport_fee) > 0 ? Number(sale.transport_fee) : null,
    date: pickup?.event_date || '',
    place: text(pickup?.details?.location),
    due: text(sale.balance_due_date)
  };

  let boarding = null;
  if (hasDeferredBoarding(sale)) {
    const n = parseInt(sale.deferred_boarding_duration_days, 10);
    const count = Number.isFinite(n) && n > 0 ? n : 1;
    const per = text(sale.deferred_boarding_frequency) || 'Day';
    const start = pickupFrom;
    const end = pickup && start && pickup.event_date > start ? addDaysToYMD(pickup.event_date, -1) : boardingEnd(sale, start);
    boarding = {
      rate: Number(sale.deferred_boarding_amount), per,
      length: `${count} ${per.toLowerCase()}${count === 1 ? '' : 's'}`,
      total: Math.round(Number(sale.deferred_boarding_amount) * count * 100) / 100,
      start, end
    };
  }
  return { transport, boarding, extras, pickupFrom, pickupDate: pickup?.event_date || '' };
}

// The sale's extra a form is for (its `extra_list_id`: a price-list row's id). The
// sale's charge copied from that row, else one named the same (a charge typed by
// hand). → { charge, row, stay } | null.
export function extraFor(addOns, listId) {
  if (!addOns || !listId) return null;
  return addOns.extras.find((x) => x.charge.list_id === listId)
    || addOns.extras.find((x) => !x.charge.list_id && x.row?.id === listId) || null;
}

// A boarding agreement, and the agreement for an extra the pup stays for (a training
// package), are dated by the pup's pickup. With none on the calendar: the date to
// offer for it (the day after the boarding or the last stay ends; '' = none to
// suggest). null = the form doesn't need one, or the pickup is already there.
export function pickupToSet(form, addOns) {
  if (!addOns || addOns.pickupDate) return null;
  const boarding = form?.form_type === 'boarding' && addOns.boarding;
  const stay = form?.form_type === 'extra' && extraFor(addOns, form.extra_list_id)?.stay;
  if (!boarding && !stay) return null;
  return boarding && boarding.end ? addDaysToYMD(boarding.end, 1) : addOns.pickupFrom;
}

// A charge's payment plan as dated steps: [{ percent, amount, due }] ('' = not
// known yet; 'with the balance' for one paid with it). No plan = one step, all of
// it, with the balance.
export function extraPayments(charge, sale, pickupDate = '') {
  if (!Array.isArray(charge?.payments) || !charge.payments.length) {
    return [{ percent: 100, amount: charge?.amount ?? 0, due: text(sale?.balance_due_date) || 'with the balance' }];
  }
  return charge.payments.map((st) => ({
    percent: st.percent, amount: st.amount,
    due: stepDueDate(st, { sale, pickupDate }) || (st.due === 'with_balance' ? 'with the balance' : '')
  }));
}

// Her extras an Extra agreement can be for: every own kennel's price list, each
// row once. → [{ id, label, kennelName }] (kennelName only with two or more own
// kennels). Pure.
export function extraChoices(kennels, chargeList) {
  const own = (kennels || []).filter((k) => k && k.is_own_kennel && !k.is_archived);
  const out = [];
  for (const k of own) {
    for (const r of chargeList(k)) {
      if (out.some((x) => x.id === r.id)) continue;
      out.push({ id: r.id, label: r.label, kennelName: own.length > 1 ? text(k.kennel_name) : '' });
    }
  }
  return out;
}

// One pick for what kind of contract a form is: her contract types (`types`:
// vocab.CONTRACT_FORM_TYPE), and in place of the bare Extra agreement type, each
// of her extras by name. A value is the type, or `extra:<price-list row id>`
// (readFormKind). The current one is selected; an extra no longer on her lists
// stays, marked so. `esc` from the caller. → <option>s (no blank one).
export function formKindOptionsHtml(types, choices, { formType = '', extraListId = '' } = {}, esc) {
  const current = formType === 'extra' ? `extra:${extraListId}` : formType;
  const opt = (value, label) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;
  const extraType = types.find((t) => t.addOn === 'extra');
  const groups = new Map();
  for (const c of extraType ? choices : []) {
    const g = [`${extraType.label}s`, c.kennelName].filter(Boolean).join(' · ');
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  const gone = formType === 'extra' && !choices.some((c) => c.id === extraListId)
    ? opt(current, extraListId ? 'Agreement: (no longer on your price list)' : 'Agreement: pick the extra') : '';
  return `${types.filter((t) => t.addOn !== 'extra').map((t) => opt(t.value, t.label)).join('')}${gone}${[...groups]
    .map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((c) => opt(`extra:${c.id}`, `Agreement: ${c.label}`)).join('')}</optgroup>`).join('')}`;
}

// A picked kind back as the row's fields. → { formType, extraListId }
export function readFormKind(value) {
  const v = text(value);
  return v.startsWith('extra:') ? { formType: 'extra', extraListId: v.slice(6) } : { formType: v, extraListId: '' };
}
