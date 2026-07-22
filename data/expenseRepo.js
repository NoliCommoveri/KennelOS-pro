// expenseRepo.js — all Dexie access for the Expense (Financials) ledger, the
// single home for money spent across the program. An Expense is polymorphic like
// an Event: subject_type ∈ {dog, litter, pairing, kennel} + subject_id say what
// the cost attaches to (kennel-wide overhead lives on subject_type='kennel').
//
// The event↔cost link is one-directional and canonical: a cost entered on the
// event form is written HERE carrying `event_id`; the event/timeline read it back
// via getByEvent (Event stores no `cost` field of its own). The reverse — "log an
// event from a ledger row" — is a UI deep-link, not a stored back-pointer.
//
// Expenses are leaf records (nothing points at an Expense), so hardDelete is
// always allowed; its own FKs (event_id, subject_id) are guarded on their targets
// via referenceRegistry.js.
import { db } from './db.js';
import { makeRepo } from './repoBase.js';
import { EXPENSE_REFERENCES } from './referenceRegistry.js';
import { EXPENSE_SUBJECT_TYPES, defaultExpenseCategoryFor } from './vocab.js';
import { getExpensesMigrated, markExpensesMigrated } from './settings.js';
import { fileRepo } from './fileRepo.js';

const base = makeRepo('expenses', EXPENSE_REFERENCES);

const SUBJECT_TYPES = EXPENSE_SUBJECT_TYPES.map((s) => s.value);

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// A mileage expense's dollar amount is DERIVED (miles × rate) — never entered
// directly. Exported so the add-expense form can show a live preview off the
// same rule the repo stores by. Returns null when it isn't a valid pair.
export function mileageAmount(miles, rate) {
  const m = numOrNull(miles);
  const r = numOrNull(rate);
  return (m != null && r != null) ? round2(m * r) : null;
}

function validateExpense(candidate) {
  if (!SUBJECT_TYPES.includes(candidate.subject_type)) {
    const labels = EXPENSE_SUBJECT_TYPES.map((s) => s.label).join(', ');
    throw new Error(`Attached-to type must be one of: ${labels}.`);
  }
  if (candidate.subject_id == null || candidate.subject_id === '') {
    throw new Error('Subject is required.');
  }
  if (!candidate.expense_date) {
    throw new Error('Date is required.');
  }
  // A mileage entry (miles set) needs a non-negative rate; its amount is derived
  // in normalize(), so the amount check below runs against the computed value.
  if (candidate.miles != null) {
    const m = Number(candidate.miles);
    if (!Number.isFinite(m) || m < 0) throw new Error('Miles must be a non-negative number.');
    const r = Number(candidate.mileage_rate);
    if (candidate.mileage_rate == null || !Number.isFinite(r) || r < 0) {
      throw new Error('A mileage entry needs a rate per mile.');
    }
  }
  const n = Number(candidate.amount);
  if (candidate.amount == null || candidate.amount === '' || !Number.isFinite(n)) {
    throw new Error('Amount must be a number.');
  }
  if (n < 0) throw new Error('Amount cannot be negative.');
}

// Normalize the money/category fields the same way on create and update, so a
// row is always stored with a real Number amount and a category (never blank).
// Mileage mode (miles present) makes `amount` DERIVED = miles × rate; a flat
// expense stores miles/mileage_rate as null and keeps the entered amount.
function normalize(data) {
  const miles = numOrNull(data.miles);
  const rate = numOrNull(data.mileage_rate);
  const isMileage = miles != null;
  return {
    ...data,
    miles: isMileage ? miles : null,
    mileage_rate: isMileage ? rate : null,
    amount: (isMileage && rate != null) ? round2(miles * rate) : Number(data.amount),
    category: data.category || 'other',
    event_id: data.event_id || null,
    // A human-facing receipt/invoice number (plain, unindexed) — the vendor's
    // own number printed on the receipt, not an id of anything in KennelOS.
    // Auto-filled by OCR off the attached receipt photo when found
    // (data/ocr.js), editable either way. Also csvImport.js's dedup key for
    // re-importing an expense CSV, when present. Trimmed to null when blank.
    receipt_number: (data.receipt_number == null ? '' : String(data.receipt_number)).trim() || null,
    // The stored receipt file (data/fileRepo.js), attached via the receipt
    // capture widget (assets/receiptCapture.js) — a photo/screenshot compressed
    // to PDF, or an uploaded PDF. Plain, unindexed: nothing queries an expense
    // by its receipt file, only fetches it by id when viewing/editing.
    receipt_file_id: data.receipt_file_id || null,
    // Reimbursable ledger fields (plain, unindexed — guide §4/§21). A foster-in
    // cost the dam's owner has agreed to pay back is flagged `reimbursable`; once
    // settled, `reimbursed_date` records when. A reimbursed-but-unflagged row is
    // coerced to reimbursable=true so the two can't contradict. Litter P&L nets a
    // reimbursed reimbursable out of your cost and lists a pending one as a
    // receivable (litterFinances.js). "Reimbursable to whom" is derived from the
    // litter's foster partner, so no per-expense contact FK is stored here.
    reimbursable: !!data.reimbursable || !!(data.reimbursed_date),
    reimbursed_date: data.reimbursed_date || null
  };
}

export const expenseRepo = {
  ...base,

  async create(data) {
    // Normalize first so a mileage entry's derived amount exists before we
    // validate it (mileage mode never enters `amount` directly).
    const norm = normalize(data);
    validateExpense(norm);
    return base.create(norm);
  },

  async update(id, changes) {
    const existing = await db.expenses.get(id);
    if (!existing) throw new Error(`expenses: no record with id ${id}`);
    const merged = normalize({ ...existing, ...changes });
    validateExpense(merged);
    return base.update(id, merged);
  },

  // Every expense attached to one subject (a dog / litter / pairing / kennel),
  // newest first. Uses the [subject_type+subject_id] compound index.
  async getForSubject(subjectType, subjectId, { includeArchived = false } = {}) {
    const rows = await db.expenses
      .where('[subject_type+subject_id]')
      .equals([subjectType, subjectId])
      .toArray();
    const visible = includeArchived ? rows : rows.filter((r) => !r.is_archived);
    return visible.sort((a, b) => {
      if (a.expense_date !== b.expense_date) return a.expense_date < b.expense_date ? 1 : -1;
      return (a.created_at ?? '') < (b.created_at ?? '') ? 1 : -1;
    });
  },

  // The cost(s) captured from a given event — the reverse of the canonical
  // expenses.event_id link. Normally 0 or 1; returns an array either way.
  async getByEvent(eventId, { includeArchived = false } = {}) {
    const rows = await db.expenses.where('event_id').equals(eventId).toArray();
    return includeArchived ? rows : rows.filter((r) => !r.is_archived);
  },

  // Convenience for the event form: the single active linked expense, or null.
  async getOneByEvent(eventId) {
    const rows = await expenseRepo.getByEvent(eventId);
    return rows[0] || null;
  },

  // Sum of a set of expenses' amounts (active rows only unless includeArchived
  // was used to load them). A tiny pure helper the panels/report reuse.
  total(rows) {
    return rows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  },

  // One-time migration: fold every legacy Event.cost value into the ledger as a
  // linked Expense, then clear the field. Idempotent and guarded by a settings
  // flag, so it runs at most once and is a no-op after Reset App (no event has a
  // cost then). Safe to call on every boot.
  async migrateEventCosts() {
    if (getExpensesMigrated()) return;
    const events = await db.events.toArray();
    for (const ev of events) {
      if (ev.cost == null || ev.cost === '') continue;
      const amount = Number(ev.cost);
      // Skip if a linked expense already exists (double-run protection) or the
      // stored value isn't a real number.
      if (!Number.isFinite(amount)) { await db.events.update(ev.id, { cost: null }); continue; }
      const already = await db.expenses.where('event_id').equals(ev.id).count();
      if (already === 0) {
        await base.create({
          event_id: ev.id,
          subject_type: ev.subject_type,
          subject_id: ev.subject_id,
          amount,
          category: defaultExpenseCategoryFor(ev.event_type),
          expense_date: ev.event_date,
          vendor: '',
          notes: ''
        });
      }
      await db.events.update(ev.id, { cost: null });
    }
    markExpensesMigrated();
  },

  // Hard delete also removes the linked receipt file — a file is owned by
  // exactly one expense, so it doesn't get its own referenceRegistry guard
  // (same posture as documentRepo.hardDelete for a filed document's file).
  async hardDelete(id) {
    const existing = await db.expenses.get(id);
    await base.hardDelete(id);
    if (existing?.receipt_file_id) await fileRepo.remove(existing.receipt_file_id);
  }
};

export { ReferenceBlockedError } from './repoBase.js';
