// showPoints.js — the derived championship-points engine (Show Tracking Spec §4).
//
// Points, majors and title progress are DERIVED from a dog's `show` events, never
// stored (guide §4.2): there is no Dog.points / Dog.titles / "is major" field
// anywhere. Track rules are data (vocab.js TITLE_TRACKS) — nothing here hardcodes
// a number.
//
// Split the same way as scopePredicates.js: a db-free PURE core (trackProgress,
// showRecordFrom and their helpers — events in, numbers out, unit-tested in
// tests/showPoints.test.js) plus one thin loader (getShowRecord) that fetches a
// dog's events and hands them to the core. The module stays in shared/ (imported
// by dog.js today; Today and the nudges later) and every call site is behind
// `editionFlags.shows`.
//
// Track completion never writes anything — logging the title is the user's call
// (the "Log the title?" nudge, spec §5.4).
import { HistoryEvent } from './eventRepo.js';
import { TITLE_TRACKS } from './vocab.js';

// A show event's points as a number. The form saves a number, but a CSV
// `details_json` can carry "3" — coerce, and treat blank / non-numeric /
// negative as 0 (spec §2.4 "Number coercion").
export function eventPoints(ev) {
  const n = Number(ev?.details?.points);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Judges are free text; distinct-judge counts compare them trimmed, case-folded
// and with inner whitespace collapsed, so "Mrs. Jane  Doe" and "mrs. jane doe"
// are one judge. A blank judge is no judge — it never counts toward a distinct-
// judge requirement.
export function normalizeJudge(name) {
  return String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Does this event earn points toward `track`, ignoring the `since` cut-off?
// Shown, not archived, aimed at this track, more than 0 points.
function earnsToward(ev, track) {
  return ev?.event_type === 'show'
    && !ev.is_archived
    && ev.details?.entry_status === 'shown'
    && ev.details?.points_toward === track.value
    && eventPoints(ev) > 0;
}

const byDateAsc = (a, b) =>
  (a.event_date || '') < (b.event_date || '') ? -1
    : (a.event_date || '') > (b.event_date || '') ? 1
      : (a.created_at || '') < (b.created_at || '') ? -1 : (a.created_at || '') > (b.created_at || '') ? 1 : 0;

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// Tally a list of counting events against a track. Pure arithmetic — the event
// selection (and the `since` cut-off) already happened.
function tally(counting, track) {
  const perShowMax = track.perShowMax ?? Infinity;
  let points = 0, majors = 0, championDefeats = 0;
  const majorJudges = new Set();
  const judges = new Set();
  for (const ev of counting) {
    const pts = eventPoints(ev);
    points += Math.min(pts, perShowMax);
    const judge = normalizeJudge(ev.details?.judge);
    if (judge) judges.add(judge);
    if (pts >= track.majorMin) {
      majors += 1;
      if (judge) majorJudges.add(judge);
    }
    if (ev.details?.defeated_champion === 'Yes') championDefeats += 1;
  }
  return { points, majors, majorJudges: majorJudges.size, judges: judges.size, championDefeats };
}

// Human-readable gaps between a tally and the track's requirements. Empty when
// every numeric requirement is met.
function gaps(t, track) {
  const missing = [];
  const ptsShort = (track.points ?? 0) - t.points;
  if (ptsShort > 0) missing.push(`${plural(ptsShort, 'more point')}`);

  // A major only helps if it's under a judge not already among the majors, so the
  // shortfall is whichever is larger: majors still needed, or major judges still
  // needed. Two majors under one judge leave one more major (new judge) to go.
  const majorsShort = Math.max((track.majors ?? 0) - t.majors, (track.distinctMajorJudges ?? 0) - t.majorJudges);
  if (majorsShort > 0) {
    if (t.majorJudges === 0) {
      missing.push(majorsShort === 1 ? '1 major' : `${majorsShort} majors under ${majorsShort} different judges`);
    } else {
      missing.push(`${plural(majorsShort, 'more major')} under ${majorsShort === 1 ? 'a new judge' : 'new judges'}`);
    }
  }

  const judgesShort = (track.distinctJudges ?? 0) - t.judges;
  if (judgesShort > 0) missing.push(`points under ${plural(judgesShort, 'more judge')}`);

  const defeatsShort = (track.championDefeats ?? 0) - t.championDefeats;
  if (defeatsShort > 0) missing.push(`defeat a champion at ${plural(defeatsShort, 'more show')}`);
  return missing;
}

// Progress of one dog's show events toward one title track (spec §4.3).
//
//   events — that dog's events (any types; non-show / archived / other-track
//            events are ignored here, so callers needn't pre-filter).
//   since  — for a track with `requires` (GCH needs CH): the required title's
//            date. Only wins dated AFTER it count; the rest are reported in
//            `notCounted`. With no `since`, such a track shows its raw tally but
//            is never complete ("CH not yet earned").
//
// Returns { points, majors, majorJudges, judges, championDefeats, complete,
// completedOn, missing[], notCounted }. `completedOn` is the date of the win that
// first satisfied every requirement (null while incomplete) — the date a
// completed CH unlocks GCH from, and the date the title nudge prefills.
export function trackProgress(events, track, { since = null } = {}) {
  const earning = (events || []).filter((ev) => earnsToward(ev, track)).sort(byDateAsc);
  const gated = !!track.requires;
  const counting = gated && since ? earning.filter((ev) => (ev.event_date || '') > since) : earning;
  const notCounted = earning.length - counting.length;

  const t = tally(counting, track);
  const missing = gaps(t, track);
  const blockedByRequired = gated && !since;
  if (blockedByRequired) missing.unshift(`${requiredTitle(track)} not yet earned`);
  const complete = missing.length === 0;

  // The completing win: replay the counting wins in date order and stop at the
  // first prefix that satisfies the track.
  let completedOn = null;
  if (complete) {
    for (let i = 1; i <= counting.length; i++) {
      if (gaps(tally(counting.slice(0, i), track), track).length === 0) {
        completedOn = counting[i - 1].event_date || null;
        break;
      }
    }
  }
  return { ...t, complete, completedOn, missing, notCounted };
}

function requiredTitle(track) {
  return TITLE_TRACKS.find((t) => t.value === track.requires)?.title || track.requires;
}

// The earliest non-archived `title_earned` event whose title_abbreviation matches
// (case-insensitive, trimmed). Null when none.
export function titleEarnedEvent(events, title) {
  const want = String(title ?? '').trim().toLowerCase();
  if (!want) return null;
  return (events || [])
    .filter((ev) => ev.event_type === 'title_earned' && !ev.is_archived
      && String(ev.details?.title_abbreviation ?? '').trim().toLowerCase() === want)
    .sort(byDateAsc)[0] || null;
}

// The whole show record for one dog, from that dog's events (pure).
//
//   tracks  — one row per TITLE_TRACKS entry the dog has (non-archived) show
//             events aimed at, in TITLE_TRACKS order:
//             { track, progress, titleEvent, since }
//             `titleEvent` = a logged title_earned for this track's title (or
//             null); `since` = the required-title date used (or null).
//   history — the dog's non-archived show events, newest first.
//
// The required-title date for a `requires` track is the EARLIEST of the
// required title's title_earned event and the date its own track completed —
// so a dog that finished before the owner used KennelOS still unlocks GCH.
export function showRecordFrom(events, tracks = TITLE_TRACKS) {
  const shows = (events || []).filter((ev) => ev.event_type === 'show' && !ev.is_archived);
  const progressByTrack = new Map();

  const requiredDate = (track, seen = new Set()) => {
    if (!track.requires || seen.has(track.value)) return null;
    seen.add(track.value);
    const req = tracks.find((t) => t.value === track.requires);
    if (!req) return null;
    const dates = [];
    const logged = titleEarnedEvent(events, req.title);
    if (logged?.event_date) dates.push(logged.event_date);
    const reqProgress = progressFor(req, seen);
    if (reqProgress.completedOn) dates.push(reqProgress.completedOn);
    return dates.length ? dates.sort()[0] : null;
  };
  function progressFor(track, seen = new Set()) {
    if (progressByTrack.has(track.value)) return progressByTrack.get(track.value).progress;
    const since = requiredDate(track, seen);
    const progress = trackProgress(shows, track, { since });
    progressByTrack.set(track.value, { progress, since });
    return progress;
  }

  const rows = tracks
    .filter((track) => shows.some((ev) => ev.details?.points_toward === track.value))
    .map((track) => {
      const progress = progressFor(track);
      return { track, progress, since: progressByTrack.get(track.value).since, titleEvent: titleEarnedEvent(events, track.title) };
    });
  const history = [...shows].sort((a, b) => byDateAsc(b, a));
  return { tracks: rows, history };
}

// Loader: one compound-index probe for the dog's events (shows and its
// title_earned events both live there), then the pure core.
export async function getShowRecord(dogId) {
  const events = await HistoryEvent.getForSubject('dog', dogId);
  return showRecordFrom(events);
}
