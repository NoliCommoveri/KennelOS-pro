// prefillSamples.js — the Field guide's Sample sales (pure): a few made-up sales set up
// different ways (with and without a payment plan; transport, boarding, a package;
// money already in, a credited application fee, money carried over from a lost pup),
// each shown as its Sale page shows it, beside a sample contract's price section with
// the detail to place on each line, the value it fills and how that's worked out.
// Every value is contractForms.prefillValues on facts gathered the way
// contractSend.gatherContractFacts gathers them, so it's what a real send would fill.
//
//   SAMPLE_SALES        [{ id, title, blurb }] in order.
//   sampleSale(id)      → { id, title, blurb, saleRows: [{ key, label, value }],
//                           sections: [{ title, note?, lines: [{ text, field, label,
//                           value, why?, math, sources: [row key] }], check? }] }
//                         A line's `sources` are the saleRows it's worked out from (the
//                         guide outlines them); `why`: why a line is blank on this sale.
//   saleFacts(sample)   the facts a send of that sale would carry (prefillGuide's
//                       examples use it too).
import { prefillValues, FIRMA_LABELS } from './contractForms.js';
import { addOnFacts } from './contractAddOns.js';
import { paymentStatement, coversText } from './paymentSchedule.js';
import { priceTable, incomeLineItems, paidOnSale, familyCredit, feeCreditSplit } from './incomeView.js';
import { creditsOf, feeCharge, CREDIT_USE_VALUES } from './receivedCredits.js';

const TODAY = '2026-10-20';
const BIRTH = '2026-09-01';
const LITTER = { whelp_date: BIRTH, estimated_ready_date: '2026-10-27' };
const r2 = (n) => Math.round(n * 100) / 100;
const usd = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const f2 = (n) => Number(n || 0).toFixed(2);
const final = { id: 'final', due: 'at_pickup', covers: ['all'], percent: 100, basis: 'total' };
const pickupOn = (date, location = '') => ({ subject_type: 'dog', subject_id: 'pup', event_type: 'placement', event_date: date, related_contact_id: 'buyer', details: location ? { location } : {} });
const base = (o) => ({ dog_id: 'pup', buyer_contact_id: 'buyer', registration_type: 'limited', status: 'deposit_paid', deposit_amount: 500, deposit_date: '2026-09-25', ...o });

const SAMPLES = [
  {
    id: 'simple', title: 'Deposit paid, the rest at pickup',
    blurb: 'The plainest sale: a price, a deposit that\'s in, nothing added and no payment plan.',
    sale: base({ id: 'sample-simple', price: 2500 }),
    events: [pickupOn('2026-10-30')]
  },
  {
    id: 'fee', title: 'Deposit not in yet; application fee counted toward it',
    blurb: 'Sent at the pick, before the deposit arrives. The $50 waitlist fee is credited toward the deposit.',
    sale: base({ id: 'sample-fee', price: 2800, status: 'deposit_pending', deposit_date: null }),
    fee: { amount: 50, toward: 'deposit', date: '2026-08-15' },
    events: [pickupOn('2026-10-30')]
  },
  {
    id: 'transport', title: 'Transported pup, a payment already in',
    blurb: 'Deposit in, $1,000 paid since, and $450 transport. No payment plan: the balance is due by 7 weeks.',
    sale: base({ id: 'sample-transport', price: 3200, transport_fee: 450, balance_due_date: '2026-10-20', payments: [{ id: 'p1', amount: 1000, date: '2026-10-01', method: 'Zelle' }] }),
    events: [pickupOn('2026-10-30', 'ATL airport')]
  },
  {
    id: 'carried', title: 'Money carried over from a lost pup',
    blurb: 'The family had $800 in from a pup they lost. It pays this deposit first, then part of the price.',
    sale: base({ id: 'sample-carried', price: 3000, status: 'deposit_pending', deposit_date: null }),
    entry: { id: 'family', received_credits: [{ id: 'cr1', amount: 800, date: '2026-07-10', applies_to: [...CREDIT_USE_VALUES], note: 'Carried from a lost pup' }] },
    events: [pickupOn('2026-10-30')]
  },
  {
    id: 'package', title: 'Payment plan with a 12-week package',
    blurb: 'A $1,200 extended-stay package on top of the price. The plan asks for 50% of the price and package by 8 weeks, the rest at pickup.',
    sale: base({
      id: 'sample-package', price: 3000,
      extra_charges: [{ id: 'x1', list_id: 'pkg12', label: '12-week homegoing package', amount: 1200 }],
      payment_schedule: [{ id: 'w8', due: 'at_weeks', n: 8, covers: ['price', 'extras'], percent: 50, basis: 'total' }, final],
      payments: [{ id: 'p1', amount: 400, date: '2026-10-05', method: 'Zelle' }]
    }),
    extraListId: 'pkg12',
    events: [pickupOn('2026-11-24')]
  },
  {
    id: 'boarding', title: 'Delayed pickup boarding, two payments before pickup',
    blurb: 'Boarding at $25 a day for 14 days. The plan asks $1,000 at 7 weeks, the rest of the price by 9 weeks, and the boarding at pickup.',
    sale: base({
      id: 'sample-boarding', price: 2500,
      deferred_boarding_amount: 25, deferred_boarding_frequency: 'Day', deferred_boarding_duration_days: '14',
      payment_schedule: [
        { id: 'w7', due: 'at_weeks', n: 7, covers: ['price'], amount: 1000, prior_funds: 'dont_count' },
        { id: 'w9', due: 'at_weeks', n: 9, covers: ['price'], percent: 100, basis: 'total' },
        final
      ],
      payments: [{ id: 'p1', amount: 1000, date: '2026-10-12', method: 'Cash' }]
    }),
    events: [pickupOn('2026-11-17')]
  }
];

export const SAMPLE_SALES = Object.freeze(SAMPLES.map(({ id, title, blurb }) => ({ id, title, blurb })));

// The facts a send of the sample would carry, gathered as contractSend gathers them.
export function saleFacts(sample, { priceList = [], kennel = null, breeder = null, contract = null, puppy = null, buyer = null, sire = null, dam = null } = {}) {
  const s = sample.sale;
  const fee = sample.fee || null;
  const entry = sample.entry || null;
  const feeCredit = fee || { amount: 0, toward: 'balance' };
  const credit = entry ? familyCredit(entry, s, feeCredit) : null;
  const addOns = addOnFacts({ sale: s, events: sample.events || [], litter: LITTER, priceList, today: TODAY });
  const statement = paymentStatement(s, {
    birthDate: BIRTH, pickupDate: addOns.pickupDate, today: TODAY,
    feeCredit: fee, credits: entry ? creditsOf(entry) : [], feeCharges: entry ? feeCharge(entry) : []
  });
  const total = incomeLineItems('sale', s, { feeCredit }).reduce((t, x) => t + x.amount, 0);
  return {
    contract, kennel, breeder, today: TODAY, sale: s, puppy, buyer, sire, dam,
    pickupDate: addOns.pickupDate,
    balanceDue: Math.max(0, total - paidOnSale(s, { feeCredit, received: credit?.received || null })),
    priceTable: priceTable(s, { feeCredit, received: credit?.received || null }),
    statement, addOns, feeCredit, credit
  };
}

// --- The sale as its page shows it ----------------------------------------------------

const RECEIVED_WORD = { fee: 'Application fee credited', credit: 'Credit', deposit: 'Deposit', step: 'Marked paid', payment: 'Payment', paid_in_full: 'Paid in full' };

function stepWords(d, charges) {
  if (d.isFinal) return 'Everything left';
  const what = coversText(d.step.covers, charges);
  return d.step.percent != null ? `${d.step.percent}% of ${what}` : `${usd(d.step.amount)} toward ${what}${d.step.prior_funds === 'dont_count' ? ', new payments only' : ''}`;
}
const whenWords = (step) => (step.due === 'at_weeks' ? `at ${step.n} weeks` : step.due === 'at_pickup' ? 'at pickup' : step.due === 'before_pickup' ? `${step.n} days before pickup` : 'on a date');

function saleRows(sample, facts) {
  const s = sample.sale;
  const st = facts.statement;
  const rows = [{ key: 'price', label: 'Price', value: `${usd(s.price)} · Limited registration` }];
  rows.push({ key: 'deposit', label: 'Deposit amount', value: `${usd(s.deposit_amount)} · ${s.deposit_date ? `received ${s.deposit_date}` : 'not received yet'}` });
  if (sample.fee) rows.push({ key: 'feeCredit', label: 'Application fee credited', value: `${usd(sample.fee.amount)} toward the ${sample.fee.toward === 'deposit' ? 'deposit' : 'balance'} (from the waitlist)` });
  for (const c of sample.entry?.received_credits || []) rows.push({ key: 'credit', label: 'Credit for funds received', value: `${usd(c.amount)}${c.note ? ` · ${c.note.toLowerCase()}` : ''}` });
  for (const p of s.payments || []) rows.push({ key: 'payments', label: 'Payment recorded', value: `${usd(p.amount)} · ${p.date}${p.method ? ` · ${p.method}` : ''}` });
  if (Number(s.transport_fee) > 0) rows.push({ key: 'transport', label: 'Transport fee', value: usd(s.transport_fee) });
  if (Number(s.deferred_boarding_amount) > 0) {
    const n = Number(s.deferred_boarding_duration_days);
    rows.push({ key: 'boarding', label: 'Deferred pickup boarding', value: `${usd(s.deferred_boarding_amount)} a day × ${n} days = ${usd(s.deferred_boarding_amount * n)}` });
  }
  for (const x of s.extra_charges || []) rows.push({ key: 'extra', label: 'Extra charge', value: `${x.label} · ${usd(x.amount)}` });
  if (st.hasSchedule) {
    for (const d of st.dueDates) rows.push({ key: `due:${d.id}`, label: `Schedule: ${d.label}`, value: `${stepWords(d, st.charges)} · ${whenWords(d.step)}${d.date ? ` (${d.date})` : ''}` });
  } else {
    rows.push({ key: 'due:none', label: 'Payment schedule', value: `None: the rest is due at once, ${s.balance_due_date ? `by ${s.balance_due_date}` : 'at pickup'}` });
  }
  if (facts.addOns.pickupDate) {
    const loc = (sample.events || []).find((e) => e.event_date === facts.addOns.pickupDate)?.details?.location;
    rows.push({ key: 'pickup', label: 'Pickup on the calendar', value: `${facts.addOns.pickupDate}${loc ? ` · ${loc}` : ''}` });
  }
  return rows;
}

// --- The sample contract's lines -------------------------------------------------------

const join = (parts) => parts.filter((p) => p[1] > 0).map(([w, n]) => `${w} ${f2(n)}`).join(' + ');

// What money went where on the statement: [kind word, amount] for pays matching `keep`.
function receivedParts(st, keep) {
  const by = new Map();
  for (const r of st.received) {
    const amount = r2(r.pays.filter((p) => keep(p.key)).reduce((t, p) => t + p.amount, 0));
    if (amount > 0) by.set(RECEIVED_WORD[r.kind] || r.kind, r2((by.get(RECEIVED_WORD[r.kind] || r.kind) || 0) + amount));
  }
  return [...by];
}

const MONEY_ROWS = ['deposit', 'feeCredit', 'credit', 'payments'];

function lines(sample, facts, v) {
  const s = sample.sale;
  const st = facts.statement;
  const pt = facts.priceTable;
  const L = (field, text, { math = '', sources = [], why = '' } = {}) => ({ field, text, label: FIRMA_LABELS[field] || field, value: v[field] || '', math, sources, ...(v[field] ? {} : { why }) });
  const split = feeCreditSplit(s, facts.feeCredit);
  const creditOnDeposit = facts.credit?.received?.byKey?.deposit || 0;
  const depositIn = Boolean(s.deposit_date) || ['deposit_paid', 'paid_in_full', 'delivered'].includes(s.status);
  const otherParts = receivedParts(st, (k) => k === 'balance');
  const purchase = {
    title: 'The puppy\'s price',
    note: 'For a contract that lists the purchase price on its own. The deposit, what\'s been received beyond it and the balance add up to the price.',
    lines: [
      L('price', 'Total purchase price', { math: 'The sale\'s Price.', sources: ['price'] }),
      L('depositAmount', 'Deposit', { math: 'The sale\'s Deposit amount: the whole deposit.', sources: ['deposit'] }),
      L('depositDue', 'Deposit due now (less credits)', {
        math: depositIn ? 'The deposit is in, so 0.00.' : `${f2(s.deposit_amount)}${split.deposit > 0 ? ` − ${f2(split.deposit)} fee credited` : ''}${creditOnDeposit > 0 ? ` − ${f2(creditOnDeposit)} credit` : ''} = ${f2(pt.depositDue)}`,
        sources: ['deposit', 'feeCredit', 'credit']
      }),
      L('otherPaymentsReceived', 'Payments already received (beyond the deposit)', {
        math: otherParts.length ? `${join(otherParts)} = ${f2(pt.otherPaid)}` : 'Nothing in beyond the deposit yet: 0.00.',
        sources: ['payments', 'credit', 'feeCredit'], why: 'Nothing in beyond the deposit yet.'
      }),
      L('purchaseBalanceDue', 'Balance of the price due', {
        math: `${f2(s.price)} price − ${f2(s.deposit_amount)} deposit − ${f2(pt.otherPaid)} already received = ${f2(pt.balanceDue)}`,
        sources: ['price', 'deposit', 'payments', 'credit', 'feeCredit']
      })
    ],
    check: `${f2(s.deposit_amount)} + ${f2(pt.otherPaid)} + ${f2(pt.balanceDue)} = ${f2(r2(Number(s.deposit_amount) + pt.otherPaid + pt.balanceDue))}, the price.`
  };
  const boardingN = Number(s.deferred_boarding_duration_days) || 0;
  const extra = (s.extra_charges || [])[0];
  const addOns = {
    title: 'What\'s added to the price',
    note: 'Each fills on any contract on the sale when the sale has it. The package lines fill on that package\'s Extra agreement.',
    lines: [
      L('transportFee', 'Transport fee', { math: 'The sale\'s Transport fee.', sources: ['transport'], why: 'No transport fee on this sale.' }),
      L('boardingTotal', 'Boarding total', { math: boardingN ? `${f2(s.deferred_boarding_amount)} × ${boardingN} days = ${v.boardingTotal}` : '', sources: ['boarding'], why: 'No boarding on this sale.' }),
      L('extraPrice', 'Package fee', { math: 'The extra\'s amount on the sale.', sources: ['extra'], why: 'No extra on this sale.' }),
      L('priceWithExtra', 'Price plus package (combined total)', { math: extra ? `${f2(s.price)} + ${f2(extra.amount)} = ${v.priceWithExtra}` : '', sources: ['price', 'extra'], why: 'No extra on this sale.' })
    ]
  };
  const chargeParts = [['Price', Number(s.price)], ['Transport', Number(s.transport_fee) || 0], ['Boarding', boardingN * (Number(s.deferred_boarding_amount) || 0)], ...(s.extra_charges || []).map((x) => [x.label, x.amount])];
  const paidParts = receivedParts(st, () => true);
  const whole = {
    title: 'Everything on the sale',
    note: 'For a contract that lists one total with transport, boarding and extras in it.',
    lines: [
      L('totalCharges', 'Total of everything', { math: `${join(chargeParts)} = ${v.totalCharges}`, sources: ['price', 'transport', 'boarding', 'extra'] }),
      L('paidToDate', 'Paid so far', { math: paidParts.length ? `${join(paidParts)} = ${f2(st.paid)}` : 'Nothing in yet: 0.00.', sources: MONEY_ROWS, why: 'Nothing in yet.' }),
      L('balanceDue', 'Balance still due', { math: `${v.totalCharges} − ${f2(st.paid)} paid = ${v.balanceDue}`, sources: ['price', 'transport', 'boarding', 'extra', ...MONEY_ROWS] })
    ],
    check: `${f2(st.paid)} + ${v.balanceDue} = ${v.totalCharges}, the total.`
  };
  const earlier = st.dueDates.filter((d) => !d.isFinal);
  const last = st.dueDates.at(-1);
  // How a due date's amount comes out: what it asks (a percent of what it covers, counted
  // with the money before it; a set amount; or everything left), less what's in toward it.
  const dueMath = (d) => {
    if (!d) return '';
    const inToward = `${f2(r2(d.ask - d.owed))} of that is already in, so ${f2(d.owed)}.`;
    if (d.isFinal) return `Everything left on the sale: ${f2(d.ask)}. ${inToward}`;
    if (d.step.percent != null && d.step.basis !== 'remaining') {
      const before = r2(d.threshold - d.ask);
      return `${d.step.percent}% of ${f2(d.coveredTotal)} (${coversText(d.step.covers, st.charges)}) = ${f2(d.threshold)} paid in all by then${before > 0 ? `; ${f2(before)} was asked before it (the deposit${earlier.indexOf(d) > 0 ? ' and earlier payments' : ''}), so it asks ${f2(d.ask)}` : ''}. ${inToward}`;
    }
    return `${stepWords(d, st.charges)}: asks ${f2(d.ask)}. ${inToward}`;
  };
  const dueSrc = (d) => (d ? [`due:${d.id}`, 'price', ...(d.isFinal ? ['transport', 'boarding', 'extra'] : []), ...MONEY_ROWS] : []);
  const noPlan = 'No payment plan on this sale.';
  const plan = {
    title: 'The payment plan',
    note: 'From the sale\'s payment schedule. Each amount is what\'s still owed by that date, after the money already in.',
    lines: [
      L('payment1Amount', '1st payment', { math: dueMath(earlier[0]), sources: dueSrc(earlier[0]), why: st.hasSchedule ? 'The plan has no payment before the final one.' : noPlan }),
      L('payment1Due', '1st payment due', { math: earlier[0] ? `${whenWords(earlier[0].step)}: ${earlier[0].date}` : '', sources: earlier[0] ? [`due:${earlier[0].id}`] : [], why: st.hasSchedule ? 'The plan has no payment before the final one.' : noPlan }),
      L('payment2Amount', '2nd payment', { math: dueMath(earlier[1]), sources: dueSrc(earlier[1]), why: st.hasSchedule ? 'The plan has no second payment before the final one.' : noPlan }),
      L('payment2Due', '2nd payment due', { math: earlier[1] ? `${whenWords(earlier[1].step)}: ${earlier[1].date}` : '', sources: earlier[1] ? [`due:${earlier[1].id}`] : [], why: st.hasSchedule ? 'The plan has no second payment before the final one.' : noPlan }),
      L('finalPaymentAmount', 'Final payment', { math: st.hasSchedule ? dueMath(last) : `With no plan, everything left after the deposit: ${f2(last?.owed)}.`, sources: st.hasSchedule ? dueSrc(last) : ['due:none', 'price', 'transport', 'boarding', 'extra', ...MONEY_ROWS] }),
      L('finalPaymentDue', 'Final payment due', { math: st.hasSchedule ? `At pickup: ${last?.date}` : s.balance_due_date ? `The sale's balance due date: ${s.balance_due_date}` : `At pickup: ${last?.date}`, sources: st.hasSchedule ? [`due:${last?.id}`, 'pickup'] : ['due:none', 'pickup'] })
    ]
  };
  const owedDeposit = st.deposit?.owed || 0;
  const planSum = r2(st.paid + owedDeposit + earlier.slice(0, 2).reduce((t, d) => t + d.owed, 0) + (last?.owed || 0));
  plan.check = `${f2(st.paid)} paid${owedDeposit > 0 ? ` + ${f2(owedDeposit)} deposit still due` : ''}${earlier.slice(0, 2).map((d) => ` + ${f2(d.owed)}`).join('')} + ${f2(last?.owed)} final = ${f2(planSum)}, the total.`;
  return [purchase, addOns, whole, plan];
}

export function sampleSale(id) {
  const sample = SAMPLES.find((x) => x.id === id) || SAMPLES[0];
  const facts = saleFacts(sample, { priceList: [] });
  const form = sample.extraListId ? { form_type: 'extra', extra_list_id: sample.extraListId } : { form_type: 'pet_home' };
  const v = Object.fromEntries(prefillValues(form, facts));
  return { id: sample.id, title: sample.title, blurb: sample.blurb, saleRows: saleRows(sample, facts), sections: lines(sample, facts, v) };
}
