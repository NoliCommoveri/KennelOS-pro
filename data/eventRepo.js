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

// The names a planned test can match on (Dog.planned_tests → "logged"): the
// test-name token(s) above plus the event's title, so a result filed as
// "OFA Patella" moves its planned test out of Planned even when Joint says just
// "Patella". Matching only — getTestTokens' vocabulary stays testTokensOf.
export function testMatchTokensOf(e) {
  const tokens = testTokensOf(e);
  if (!TEST_EVENT_TYPES.includes(e.event_type)) return tokens;
  const title = String(e.title ?? '').trim();
  if (title && !tokens.some((t) => t.toLowerCase() === title.toLowerCase())) tokens.push(title);
  return tokens;
}

// Is this a one-day (instant) event? Only these are to-dos: spans (boarding,
// heat cycles, medication) run on the board, not on Upcoming/Overdue.
function isInstant(e) {
  return descriptor(EVENT_TYPES, e.event_type).duration === 'instant';
}

// Where an instant event stands (EVENT_DUE_STATES), or null for a done event,
// a span, or a past event logged before completion existed. `is_done` is
// tri-state on purpose: true = done, false = still to do, absent = an older
// event. Only an explicit false goes overdue, so years of history never flood
// Overdue; an older event dated today or later still shows as due/upcoming.
export function eventDueState(e, today = todayYMD()) {
  if (!e || e.is_archived || e.is_done === true || !isInstant(e)) return null;
  if (e.event_date > today) return 'upcoming';
  if (e.event_date === today) return 'due';
  return e.is_done === false && !descriptor(EVENT_TYPES, e.event_type).noOverdue ? 'overdue' : null;
}

// Marking an event done clears its pending reminder when that reminder was a
// heads-up for the event (dated on or before it). A reminder set after the
// event — a booster due next year on today's vaccination — is a follow-up and stays.
export function doneReminderChanges(e) {
  if (!e?.reminder_date || e.reminder_dismissed) return {};
  return e.reminder_date <= e.event_date ? { reminder_dismissed: true } : {};
}

// A new instant event's is_done when the caller set none: dated today or earlier
// is done (she's recording what happened), ahead is a to-do. Spans carry none.
// Every way a new event comes in uses it: create() and the helper-app import.
export function withDefaultDone(data) {
  if (data.is_done != null || !isInstant(data)) return data;
  return { ...data, is_done: String(data.event_date || '') <= todayYMD() };
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

  // A new event's is_done follows its date (withDefaultDone) unless the caller
  // passes one (the event form's Done box).
  async create(data) {
    validateEvent(data);
    return base.create(withDefaultDone(data));
  },

  // Mark a to-do done: it leaves Upcoming/Overdue, and its heads-up reminder
  // goes with it (dismissed, so it can be restored from Reminders).
  async markDone(id) {
    const existing = await db.events.get(id);
    return HistoryEvent.update(id, { is_done: true, ...doneReminderChanges(existing) });
  },

  // Back to a to-do (the event form's toggle, or an undo).
  markToDo(id) {
    return HistoryEvent.update(id, { is_done: false });
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
  // surgeries, …) at or after today and not yet done, across every subject type.
  // This never fuses with getBoardRows — that's the load-bearing distinction (§C4/§D2).
  async getUpcoming() {
    const today = todayYMD();
    const rows = await db.events
      .where('event_date').aboveOrEqual(today)
      .and((e) => !e.is_archived && e.is_done !== true && isInstant(e))
      .toArray();
    return rows.sort((a, b) => (a.event_date < b.event_date ? -1 : a.event_date > b.event_date ? 1 : 0));
  },

  // Overdue — instant events dated before today still marked to do (is_done
  // explicitly false; see eventDueState). Sibling of getUpcoming, oldest first.
  async getOverdue() {
    const today = todayYMD();
    const rows = await db.events
      .where('event_date').below(today)
      .and((e) => eventDueState(e, today) === 'overdue')
      .toArray();
    return rows.sort((a, b) => (a.event_date < b.event_date ? -1 : a.event_date > b.event_date ? 1 : 0));
  },

  // Calendar page — every non-archived event whose dates touch [from, to] (both
  // YYYY-MM-DD, inclusive): it starts on or before `to` and starts or ends on or
  // after `from`, so a span that began last month still shows. Past and future
  // alike; the page decides how an open-ended span is drawn (calendarMath.eventSpan).
  async getInRange(from, to) {
    const rows = await db.events
      .where('event_date').belowOrEqual(to)
      .and((e) => !e.is_archived)
      .and((e) => e.event_date >= from || (e.event_end_date != null && e.event_end_date >= from))
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
      .and((e) => !e.is_archived && e.is_done !== true)
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
  },

  // Every event of one type across all subjects, by date (oldest first) — the
  // Shows page's single `event_type` index probe (Show Tracking Spec §5.2).
  // Archived rows are left out unless asked for.
  async getByType(eventType, { includeArchived = false } = {}) {
    const rows = await db.events.where('event_type').equals(eventType).toArray();
    const visible = includeArchived ? rows : rows.filter((r) => !r.is_archived);
    return visible.sort((a, b) =>
      (a.event_date || '') < (b.event_date || '') ? -1 : (a.event_date || '') > (b.event_date || '') ? 1
        : (a.created_at ?? '') < (b.created_at ?? '') ? -1 : 1);
  },

  // Distinct non-blank values of one `details` key across every event of a
  // type — suggestions for a free-text combobox (e.g. a show's club or judge,
  // Show Tracking Spec §2.2). Deduped case-insensitively + trimmed; the first
  // spelling seen wins. Suggestions only, never a validated vocab.
  async getDetailValues(eventType, key) {
    const rows = await db.events.where('event_type').equals(eventType).toArray();
    const seen = new Set();
    const out = [];
    for (const e of rows) {
      const v = String(e.details?.[key] ?? '').trim();
      const k = v.toLowerCase();
      if (!v || seen.has(k)) continue;
      seen.add(k);
      out.push(v);
    }
    return out.sort((a, b) => a.localeCompare(b));
  },

  // Every result she's typed on a test event, whichever type: genetic_test /
  // breed_specific_test `result` and ofa_pennhip `rating` (healthTestLog
  // TEST_TYPE_FIELDS). Feed to healthTestLog.testResultSuggestions.
  async getTestResultValues() {
    const lists = await Promise.all([['genetic_test', 'result'], ['breed_specific_test', 'result'], ['ofa_pennhip', 'rating']]
      .map(([type, key]) => this.getDetailValues(type, key)));
    return lists.flat();
  }
};

// Alias so pages that prefer the generic name can import either.
export { HistoryEvent as eventRepo };
