// litterFinances.js — the per-litter P&L for the litter-finances report. Fully
// derived (no table, no stored aggregate), same posture as incomeView.js: it
// joins income and expenses onto each litter and returns one row per litter.
//
// Income comes from incomeView's per-sale rows (already classified earned vs
// anticipated), grouped by the puppy's `litter_id`. Cost is the FULL litter cost
// (owner decision, "option b"): the litter's own `subject_type='litter'` expenses
// PLUS every puppy's own `subject_type='dog'` expenses. (The litter *detail* page
// deliberately shows neither the earned/anticipated split nor this rolled-up
// cost — that simplicity is intentional; the whole P&L lives here.)
import { getIncomeRows } from './incomeView.js';
import { expenseRepo } from './expenseRepo.js';
import { litterRepo } from './litterRepo.js';
import { dogRepo } from './dogRepo.js';

// One row per non-archived litter: income (earned/anticipated) from its puppy
// sales, its full cost (litter + puppy expenses), and net (earned − cost).
export async function getLitterFinances() {
  const [rows, expenses, litters, dogs] = await Promise.all([
    getIncomeRows({ includeArchived: false }),
    expenseRepo.getAll({ includeArchived: false }),
    litterRepo.getAll({ includeArchived: false }),
    dogRepo.getAll({ includeArchived: true })
  ]);
  const dogById = new Map(dogs.map((d) => [d.id, d]));

  const acc = new Map(); // litterId -> accumulator
  const get = (id) => {
    if (!acc.has(id)) acc.set(id, { earned: 0, anticipated: 0, litterExpenses: 0, puppyExpenses: 0, reimbursedOffset: 0, reimbursablePending: 0, puppiesSold: 0 });
    return acc.get(id);
  };

  // Income: only sale rows carry a litter_id (stud income is never litter-scoped).
  // For a foster litter, the puppy sales are still ours (whoever holds the pups
  // books the gross Sales); the other party's income split is recorded as a
  // `foster_split` litter-subject Expense below, so it flows into cost naturally
  // and needs no special income handling here.
  for (const r of rows) {
    if (r.source_type !== 'sale' || !r.litter_id) continue;
    const a = get(r.litter_id);
    a.earned += r.earned;
    a.anticipated += r.anticipated;
    a.puppiesSold += 1;
  }

  // Cost (option b): litter-subject expenses + each puppy's dog-subject expenses.
  // Reimbursable handling (guide §21): a reimbursed reimbursable cost washes out
  // (someone paid you back), so it is EXCLUDED from your cost; a still-pending
  // reimbursable stays in cost (you are out that cash today) but is also tallied
  // as an outstanding receivable so the report can flag "$X still owed to you".
  for (const e of expenses) {
    const amt = Number(e.amount) || 0;
    let litterId = null;
    if (e.subject_type === 'litter') litterId = e.subject_id;
    else if (e.subject_type === 'dog') litterId = dogById.get(e.subject_id)?.litter_id || null;
    if (!litterId) continue;
    const a = get(litterId);
    const reimbursed = e.reimbursable && e.reimbursed_date;
    if (reimbursed) { a.reimbursedOffset += amt; continue; } // washes out — not your cost
    if (e.subject_type === 'litter') a.litterExpenses += amt;
    else a.puppyExpenses += amt;
    if (e.reimbursable && !e.reimbursed_date) a.reimbursablePending += amt;
  }

  return litters.map((l) => {
    const a = acc.get(l.id) || { earned: 0, anticipated: 0, litterExpenses: 0, puppyExpenses: 0, reimbursedOffset: 0, reimbursablePending: 0, puppiesSold: 0 };
    const totalExpenses = a.litterExpenses + a.puppyExpenses;
    return {
      litter: l,
      fosterDirection: l.foster_direction || null,
      earned: a.earned,
      anticipated: a.anticipated,
      litterExpenses: a.litterExpenses,
      puppyExpenses: a.puppyExpenses,
      totalExpenses,
      // Money already paid back to you on reimbursed costs (excluded from cost).
      reimbursedOffset: a.reimbursedOffset,
      // Reimbursable costs you've fronted but not yet been paid back for — a
      // receivable, still counted in totalExpenses/net until settled.
      reimbursablePending: a.reimbursablePending,
      net: a.earned - totalExpenses,
      puppiesSold: a.puppiesSold
    };
  });
}
