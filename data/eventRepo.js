// eventRepo.js — all Dexie access for the single polymorphic Event table
// (vaccinations, heat cycles, surgeries, titles, notes… — one dated occurrence
// attached to a dog / pairing / litter via subject_type + subject_id).
//
// NOTE the module/variable naming: we use `eventRepo` / `HistoryEvent`, never a
// bare `Event`, which would collide with the DOM global (CLAUDE.md).
//
// Events were leaf records until the Financials ledger: now an Expense can point
// at an event via expenses.event_id (the one canonical event↔cost link). So
// hardDelete is guarded by EVENT_REFERENCES — an event with a linked expense
// can't be destroyed out from under its cost (archive it, or clear the cost).
import { db } from './db.js';
import { makeRepo } from './repoBase.js';
import { EVENT_REFERENCES } from './referenceRegistry.js';
import { EVENT_TYPES, descriptor } from './vocab.js';
import { todayYMD } from './dateUtils.js';

const base = makeRepo('events', EVENT_REFERENCES);

const REQUIRED_FIELDS = ['subject_type', 'subject_id', 'event_type', 'event_date', 'title'];
const SUBJECT_TYPES = ['dog', 'pairing', 'litter'];

// Test-bearing event types (Test Planning Addendum §3). Grain differs across
// the three: panel_name/test_name each name one test outright; ofa_pennhip
// splits joint+method across two fields, so neither alone names "the test" —
// they're combined into one token ("OFA Hips"). This is also why matching can
// legitimately miss (§6.2) — it's advisory, not exact.
const TEST_EVENT_TYPES = ['genetic_test', 'breed_specific_test', 'ofa_pennhip'];

// Pure derivation: this event's test-name token(s), or [] if it isn't a
// test-bearing type or carries no test-name data yet.
export function testTokensOf(e) {
  const d = e.details || {};
  if (e.event_type === 'genetic_test') return d.panel_name ? [String(d.panel_name).trim()].filter(Boolean) : [];
  if (e.event_type === 'breed_specific_test') return d.test_name ? [String(d.test_name).trim()].filter(Boolean) : [];
  if (e.event_type === 'ofa_pennhip') {
    const combined = [d.method, d.joint].filter(Boolean).join(' ').trim();
    return combined ? [combined] : [];
  }
  return [];
}

function validateEvent(candidate) {
  for (const f of REQUIRED_FIELDS) {
    if (candidate[f] == null || candidate[f] === '') {
      throw new Error(`Event: "${f}" is required.`);
    }
  }
  if (!SUBJECT_TYPES.includes(candidate.subject_type)) {
    throw new Error(`Event: subject_type must be one of ${SUBJECT_TYPES.join(', ')}.`);
  }
  // event_date MAY be in the future (e.g. a scheduled surgery) — not blocked.
  // reminder_date < event_date is a soft warning owned by the Stage 2 UI.
  // event_end_date (Stage 4.5 Addendum §C1) is an ordinary nullable field — null
  // for instants, the end date for spans (boarding, heat_cycle, medication).
  // It rides through create/update like any other field; a non-null value on an
  // `instant`-duration type is a soft warning owned by the CSV importer, not a
  // hard block here.
}

export const HistoryEvent = {
  ...base,

  async create(data) {
    validateEvent(data);
    return base.create(data);
  },

  async update(id, changes) {
    const existing = await db.events.get(id);
    if (!existing) throw new Error(`events: no record with id ${id}`);
    validateEvent({ ...existing, ...changes });
    return base.update(id, changes);
  },

  // Timeline for one subject, newest first — the core read this table exists for.
  // Uses the [subject_type+subject_id] compound index.
  async getForSubject(subjectType, subjectId, { includeArchived = false } = {}) {
    const rows = await db.events
      .where('[subject_type+subject_id]')
      .equals([subjectType, subjectId])
      .toArray();
    const visible = includeArchived ? rows : rows.filter((r) => !r.is_archived);
    // Sort by event_date desc (YYYY-MM-DD lexicographic), then created_at desc as
    // a stable tiebreak for same-day events.
    return visible.sort((a, b) => {
      if (a.event_date !== b.event_date) return a.event_date < b.event_date ? 1 : -1;
      return (a.created_at ?? '') < (b.created_at ?? '') ? 1 : -1;
    });
  },

  // Location/Status Board (Stage4.5 Addendum §C4) — dogs currently away from
  // home. Filters on event_type ∈ {boarding} — deliberately NOT on `duration`,
  // since medication/heat_cycle are spans too but aren't whereabouts. Past
  // stays fall off automatically and stay visible on the dog's own timeline.
  async getBoardRows() {
    const today = todayYMD();
    const rows = await db.events
      .where('event_type').equals('boarding')
      .and((e) => !e.is_archived)
      .and((e) => e.event_end_date == null || e.event_end_date >= today)
      .toArray();
    // Soonest return first; open-ended ("ongoing") stays sort last.
    return rows.sort((a, b) => {
      if (!a.event_end_date && !b.event_end_date) return 0;
      if (!a.event_end_date) return 1;
      if (!b.event_end_date) return -1;
      return a.event_end_date < b.event_end_date ? -1 : 1;
    });
  },

  // Upcoming Deliverables (Stage4.5 Addendum §D2) — a SEPARATE read from the
  // board: instant-duration events (drop-offs, scheduled vet visits, scheduled
  // surgeries, …) at or after today, across every subject type. This never
  // fuses with getBoardRows — that's the load-bearing distinction (§C4/§D2).
  async getUpcoming() {
    const today = todayYMD();
    const rows = await db.events
      .where('event_date').aboveOrEqual(today)
      .and((e) => !e.is_archived)
      .and((e) => descriptor(EVENT_TYPES, e.event_type).duration === 'instant')
      .toArray();
    return rows.sort((a, b) => (a.event_date < b.event_date ? -1 : a.event_date > b.event_date ? 1 : 0));
  },

  // Scheduled Placements report (Stage4.5 Addendum §D3) — future-dated
  // `placement` events only. A sibling read, not a filter over getUpcoming()'s
  // result, so it stays a one-line, obviously-correct query on its own.
  async getScheduledPlacements() {
    const today = todayYMD();
    const rows = await db.events
      .where('event_type').equals('placement')
      .and((e) => !e.is_archived)
      .and((e) => e.event_date >= today)
      .toArray();
    return rows.sort((a, b) => (a.event_date < b.event_date ? -1 : a.event_date > b.event_date ? 1 : 0));
  },

  // Reminder engine read (Stage 5, Build Brief §3.3) — a SIBLING to
  // getBoardRows/getUpcoming, deliberately never fused with them. A "reminder"
  // is any event carrying a non-null reminder_date that is neither archived nor
  // dismissed; it is not tied to event type or duration. reminder_date is the
  // single future-dated mechanism in the app.
  //
  // The overdue/due-soon/upcoming split is a DISPLAY concern computed from these
  // rows (Build Brief §3.3), not baked in here — this read just returns every
  // pending reminder sorted soonest-first. Uses the reminder_date index range
  // probe (aboveOrEqual('') selects all rows that HAVE a reminder_date, since a
  // null/absent reminder_date carries no index entry).
  async getReminders() {
    const rows = await db.events
      .where('reminder_date').aboveOrEqual('')
      .and((e) => !e.is_archived)
      .and((e) => !e.reminder_dismissed)
      .toArray();
    return rows.sort((a, b) => (a.reminder_date < b.reminder_date ? -1 : a.reminder_date > b.reminder_date ? 1 : 0));
  },

  // Dismissed reminders (Build Brief §3.5) — the "reveal dismissed" toggle on
  // the reminder view. Same index probe as getReminders, but the complement:
  // non-null reminder_date, not archived, dismissed. Kept a separate read so
  // getReminders stays exactly "what's pending" and pages never touch db.
  async getDismissedReminders() {
    const rows = await db.events
      .where('reminder_date').aboveOrEqual('')
      .and((e) => !e.is_archived)
      .and((e) => !!e.reminder_dismissed)
      .toArray();
    return rows.sort((a, b) => (a.reminder_date < b.reminder_date ? -1 : a.reminder_date > b.reminder_date ? 1 : 0));
  },

  // Dismiss a reminder (Build Brief §3.4): the event stays on its timeline and
  // in every other read — only its reminder drops off getReminders(). Dismissal
  // is NOT archiving and NOT a status change (archive ≠ status discipline).
  dismissReminder(id) {
    return HistoryEvent.update(id, { reminder_dismissed: true });
  },

  // Un-dismiss — restores a previously dismissed reminder to the pending view.
  undismissReminder(id) {
    return HistoryEvent.update(id, { reminder_dismissed: false });
  },

  // Snooze (Build Brief §3.4): reuse the one reminder_date, pushed to a later
  // day. There is deliberately no separate snooze field — snooze IS a date edit.
  snoozeReminder(id, newDate) {
    return HistoryEvent.update(id, { reminder_date: newDate });
  },

  // Distinct test-name tokens already logged, across all dogs (Test Planning
  // Addendum §3) — the append-only "seen in events" half of the shared
  // vocabulary union. Nothing here is ever purged, even if a kennel panel
  // later drops the same token.
  async getTestTokens() {
    const rows = await db.events.where('event_type').anyOf(TEST_EVENT_TYPES).toArray();
    const seen = new Set();
    const out = [];
    for (const e of rows) {
      for (const t of testTokensOf(e)) {
        const key = t.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
      }
    }
    return out;
  }
};

// Alias so pages that prefer the generic name can import either.
export { HistoryEvent as eventRepo };
