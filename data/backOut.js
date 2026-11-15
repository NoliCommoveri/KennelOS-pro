// backOut.js — a family backing out of their pup (docs/KennelOS_Family_Requests_Plan.md
// §7): her reasons, her policy (reason × the pup's age → keep what they paid, or put
// them back in line with a credit for some of it), and what she ticks to remove when
// she approves. Nothing is refunded on a back-out (Waitlist Fixes plan D9). Pure.
import { cleanSteps } from './extraCharges.js';
//
// Kennel.waitlist_config:
//   back_out_reasons      [{ id, label }] (blank = BACK_OUT_REASONS_DEFAULT; "Something
//                         else" (`other`, a few words) is always offered)
//   back_out_policy       [{ reason_id ('any' or a reason), from_weeks?, until_weeks?,
//                         outcome: 'keep' | 'move' }]: the first row that fits suggests
//   back_out_policy_text  what every family reads before sending (blank = the default;
//                         [Kennel Name] filled in). Her policy rows are hers alone: they
//                         only suggest an outcome to her and never reach a family.
// Their request on the entry: `back_out_request` = { requested_date, reason: { id,
// label, text }, note, decided?, decided_date?, outcome? }.

export const BACK_OUT_REASONS_DEFAULT = Object.freeze([
  { id: 'changed_mind', label: 'We changed our mind' },
  { id: 'circumstances', label: 'Family or money circumstances' },
  { id: 'pup', label: 'The puppy\'s health or temperament' },
  { id: 'timing', label: 'The timing' }
]);
export const BACK_OUT_OTHER = Object.freeze({ id: 'other', label: 'Something else' });
export const BACK_OUT_OUTCOMES = Object.freeze([
  { value: 'keep', label: 'Keep what they paid' },
  { value: 'move', label: 'Put them back in line' }
]);
// The owner's wording (2026-11-01).
export const BACK_OUT_POLICY_TEXT_DEFAULT = 'Please note that all paid deposits are non-refundable and by backing out, you are forfeiting your deposit. We do understand that sometimes, life happens; [Kennel Name] will review your reason for backing out and will reach out if we determine you are eligible to apply any portion of your paid deposit to a future litter. If not eligible, you will be required to re-apply and place a new deposit should you decide to purchase one of our pups in the future.';

const text = (v) => String(v ?? '').trim();
const count = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Math.round(Number(v)));

// Her reasons, then "Something else".
export function backOutReasons(config) {
  const mine = Array.isArray(config?.back_out_reasons) ? config.back_out_reasons : [];
  const clean = mine.map((r) => ({ id: text(r?.id), label: text(r?.label).slice(0, 80) })).filter((r) => r.id && r.label && r.id !== 'other');
  return [...(clean.length ? clean : BACK_OUT_REASONS_DEFAULT), BACK_OUT_OTHER];
}

export function backOutPolicy(config) {
  const rows = Array.isArray(config?.back_out_policy) ? config.back_out_policy : [];
  return rows.filter((r) => r && ['keep', 'move'].includes(r.outcome)).map((r) => ({
    reason_id: text(r.reason_id) || 'any', from_weeks: count(r.from_weeks), until_weeks: count(r.until_weeks), outcome: r.outcome
  }));
}

// What families read: her text, else the default, with [Kennel Name] filled in.
export const backOutPolicyText = (config, kennelName = '') =>
  (text(config?.back_out_policy_text) || BACK_OUT_POLICY_TEXT_DEFAULT).replace(/\[kennel name\]/gi, text(kennelName) || 'We');

// The pup's age in whole weeks on `date`, or null without a birth date.
export function ageWeeks(birthDate, date) {
  if (!birthDate || !date) return null;
  const ms = (ymd) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
  return Math.floor((ms(date) - ms(birthDate)) / (7 * 86400000));
}

// What her policy suggests for this reason and age: the first row that fits
// ("until N weeks" = younger than N; "from N weeks" = N or older). No row fits, or
// a row needs an age that isn't known: keep. → { outcome, row }
export function suggestOutcome(config, reasonId, weeks) {
  for (const row of backOutPolicy(config)) {
    if (row.reason_id !== 'any' && row.reason_id !== reasonId) continue;
    if ((row.from_weeks != null || row.until_weeks != null) && weeks == null) continue;
    if (row.from_weeks != null && weeks < row.from_weeks) continue;
    if (row.until_weeks != null && weeks >= row.until_weeks) continue;
    return { outcome: row.outcome, row };
  }
  return { outcome: 'keep', row: null };
}

// "We changed our mind, under 6 weeks → put them back in line".
export function policyRowText(row, reasons) {
  const reason = row.reason_id === 'any' ? 'Any reason' : (reasons.find((r) => r.id === row.reason_id)?.label || 'A reason');
  const age = row.from_weeks != null && row.until_weeks != null ? `, ${row.from_weeks} to ${row.until_weeks} weeks`
    : row.until_weeks != null ? `, under ${row.until_weeks} weeks` : row.from_weeks != null ? `, ${row.from_weeks} weeks or older` : '';
  return `${reason}${age} → ${BACK_OUT_OUTCOMES.find((o) => o.value === row.outcome).label.toLowerCase()}`;
}

// What approving can take off with the sale, each with whether it starts ticked to
// remove (plan §7.2): an extra with nothing paid and not done (ticked) or paid / done
// (kept: she's owed it); a stay not started (ticked) or under way (kept); a pickup
// still to come (ticked). → [{ kind: 'charge' | 'stay' | 'pickup', id, label, detail, remove }]
export function backOutItems({ sale, events, today }) {
  const out = [];
  for (const c of Array.isArray(sale?.extra_charges) ? sale.extra_charges : []) {
    if (!c || !c.id || c.fee_for) continue;
    const amount = Number(c.amount) || 0;
    const paid = (cleanSteps(c.payments, amount) || []).filter((st) => st.paid_date);
    const done = Boolean(c.completed_date);
    const paidAmount = paid.reduce((t, st) => t + st.amount, 0);
    const percent = amount > 0 ? Math.round((paidAmount / amount) * 100) : 0;
    const full = paid.length > 0 && paidAmount >= amount - 0.005;
    const detail = [done ? 'done' : '', paid.length ? (full ? 'paid' : `${percent}% paid`) : (done ? '' : 'nothing paid')].filter(Boolean).join(', ');
    // `owed`: kept on the sale, some of it is still to pay (K8-13).
    out.push({ kind: 'charge', id: c.id, label: c.label, detail, owed: !full, remove: !paid.length && !done });
  }
  for (const e of events.filter((x) => !x.is_archived && x.subject_id === sale?.dog_id)) {
    if (e.event_type === 'boarding' && e.details?.sale_id === sale.id) {
      const started = e.event_date <= today;
      out.push({ kind: 'stay', id: e.id, label: e.title || 'Boarding', detail: `${e.event_date}${e.event_end_date ? ` to ${e.event_end_date}` : ''}${started ? ', under way' : ''}`, remove: !started });
    } else if (e.event_type === 'placement' && e.event_date >= today && (!e.related_contact_id || e.related_contact_id === sale.buyer_contact_id)) {
      out.push({ kind: 'pickup', id: e.id, label: e.title || 'Pickup', detail: e.event_date, remove: true });
    }
  }
  return out;
}

// "They've paid $3,200 on this sale: deposit $500, balance $2,500, transport $200."
// `parts` from incomeView.paidOnSaleByPart (K8-2).
export function backOutPaidText(parts, money = (n) => `$${n}`) {
  const total = Math.round((parts || []).reduce((t, p) => t + p.amount, 0) * 100) / 100;
  if (!(total > 0)) return 'Nothing has been paid on this sale yet: no deposit was received.';
  return `They've paid ${money(total)} on this sale: ${parts.map((p) => `${String(p.label).toLowerCase()} ${money(p.amount)}`).join(', ')}.`;
}

// The one line the confirm ends with. `paid`: what they paid beyond their credits;
// `credit`: what she's crediting toward their next pup (move). Nothing is refunded.
export function backOutSummary(outcome, { paid = 0, credit = 0, items = [], money = (n) => `$${n}` }) {
  const rest = Math.round((paid - credit) * 100) / 100;
  const first = outcome === 'move'
    ? `Cancel the sale and put them back at the end of the line ${credit > 0 ? `with a ${money(credit)} credit toward their next pup` : 'with no credit'}${paid > 0 && rest > 0 ? `; the ${credit > 0 ? 'other ' : ''}${money(rest)} they paid is kept` : ''}`
    : `Cancel the sale${paid > 0 ? ` and keep the ${money(paid)} they paid` : ''}`;
  const extras = items.filter((i) => !i.remove && i.kind === 'charge').map((i) => `keep ${i.label} (${i.owed === false ? 'paid' : 'still owed'})`);
  const gone = items.filter((i) => i.remove).map((i) => `remove ${i.label}${i.kind === 'pickup' || i.kind === 'stay' ? ` on ${i.detail.split(' ')[0]}` : ''}`);
  return [first, ...extras, ...gone].join(', ');
}
