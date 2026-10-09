// breedingReports.js — the numbers behind the Breeding and Puppies reports (Reports
// plan, phase 2): Dam & Sire Production, Pairing Success, Puppy Growth. PURE: plain
// records in, report rows out (tests/breedingReports.test.js); pages load and scope.
// Nothing here is stored — every rate is computed for what's on screen.

const DAY = 86400000;
const ymdMs = (ymd) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
export const daysBetween = (a, b) => Math.round((ymdMs(b) - ymdMs(a)) / DAY);
const n = (v) => (v === '' || v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

// Months of age on a date (whole months, floor), or null without a birth date.
export function ageMonths(dob, onYMD) {
  if (!dob || !onYMD || onYMD < dob) return null;
  let m = (Number(onYMD.slice(0, 4)) - Number(dob.slice(0, 4))) * 12 + (Number(onYMD.slice(5, 7)) - Number(dob.slice(5, 7)));
  if (onYMD.slice(8, 10) < dob.slice(8, 10)) m -= 1;
  return m;
}

// --- Dam & Sire Production ------------------------------------------------------------

// Litters closer together than this (whelp to whelp) read as back-to-back: about the
// span of one heat cycle plus a pregnancy. A flag to look at, not a rule.
export const BACK_TO_BACK_DAYS = 240;
// A dam's lifetime litters at or past this are highlighted. Breed clubs' guidance
// varies; this is a prompt to look, not a limit the app enforces.
export const LIFETIME_LITTERS_FLAG = 6;

// One row per dog that parented a whelped litter in `litters`: litters, puppies
// born / alive, live %, average litter, the sex split of the puppies on record,
// first and last whelp, age at each litter, and the dam flags. `puppies` are Dog
// records with a litter_id (for the sex split).
export function productionRows({ dogs = [], litters = [], puppies = [] }) {
  const whelped = litters.filter((l) => l.whelp_date && l.status !== 'expected');
  const pupsByLitter = new Map();
  for (const p of puppies) if (p.litter_id) pupsByLitter.set(p.litter_id, [...(pupsByLitter.get(p.litter_id) || []), p]);
  const rows = [];
  for (const dog of dogs) {
    const role = dog.sex === 'female' ? 'dam' : dog.sex === 'male' ? 'sire' : null;
    if (!role) continue;
    const mine = whelped.filter((l) => (role === 'dam' ? l.dam_id : l.sire_id) === dog.id)
      .sort((a, b) => a.whelp_date.localeCompare(b.whelp_date));
    if (!mine.length) continue;
    const counted = mine.filter((l) => n(l.puppies_born_total) != null);
    const born = counted.reduce((t, l) => t + n(l.puppies_born_total), 0);
    const alive = counted.reduce((t, l) => t + (n(l.puppies_born_alive) ?? 0), 0);
    const pups = mine.flatMap((l) => pupsByLitter.get(l.id) || []);
    const ages = mine.map((l) => ageMonths(dog.date_of_birth, l.whelp_date)).filter((a) => a != null);
    const gaps = mine.slice(1).map((l, i) => daysBetween(mine[i].whelp_date, l.whelp_date));
    const backToBack = role === 'dam' ? gaps.filter((g) => g < BACK_TO_BACK_DAYS).length : 0;
    rows.push({
      dog,
      role,
      litters: mine.length,
      born,
      alive,
      livePct: born ? alive / born : null,
      avgLitter: counted.length ? born / counted.length : null,
      males: pups.filter((p) => p.sex === 'male').length,
      females: pups.filter((p) => p.sex === 'female').length,
      firstWhelp: mine[0].whelp_date,
      lastWhelp: mine[mine.length - 1].whelp_date,
      firstAge: ages.length ? Math.min(...ages) : null,
      lastAge: ages.length ? Math.max(...ages) : null,
      shortestGapDays: gaps.length ? Math.min(...gaps) : null,
      backToBack,
      lifetimeFlag: role === 'dam' && mine.length >= LIFETIME_LITTERS_FLAG,
      litterList: mine
    });
  }
  return rows.sort((a, b) => b.litters - a.litters || (a.dog.call_name || '').localeCompare(b.dog.call_name || ''));
}

// --- Pairing Success --------------------------------------------------------------------

// A pairing's outcome: 'success' (confirmed pregnant, whelped, or a litter points at
// it), 'failed' (not pregnant / failed), 'pending' (bred, waiting), or null for one
// that was never bred (still planned, or cancelled) — left out of every rate.
export function pairingOutcome(pairing, litteredPairingIds = new Set()) {
  if (litteredPairingIds.has(pairing.id)) return 'success';
  switch (pairing.status) {
    case 'confirmed_pregnant':
    case 'whelped': return 'success';
    case 'not_pregnant':
    case 'failed': return 'failed';
    case 'bred': return 'pending';
    default: return null;
  }
}

// The dam's progesterone reading nearest before the first breeding date (within
// `windowDays`), as { value, date } or null. `events` are the dam's events.
export function progesteroneAtBreeding(pairing, events, windowDays = 7) {
  const tie = pairing.planned_date;
  if (!tie) return null;
  const hits = events
    .filter((e) => e.subject_id === pairing.dam_id && e.event_type === 'progesterone_test' && e.event_date && e.event_date <= tie
      && daysBetween(e.event_date, tie) <= windowDays && n(e.details?.value) != null)
    .sort((a, b) => b.event_date.localeCompare(a.event_date));
  return hits.length ? { value: n(hits[0].details.value), date: hits[0].event_date } : null;
}

// One row per bred pairing: the pairing, its outcome, the litter it produced (if
// any) and the progesterone reading at breeding.
export function pairingRows({ pairings = [], litters = [], events = [] }) {
  const litterByPairing = new Map(litters.filter((l) => l.pairing_id).map((l) => [l.pairing_id, l]));
  const littered = new Set(litterByPairing.keys());
  return pairings
    .map((p) => ({ pairing: p, outcome: pairingOutcome(p, littered), litter: litterByPairing.get(p.id) || null, progesterone: progesteroneAtBreeding(p, events) }))
    .filter((r) => r.outcome)
    .sort((a, b) => (b.pairing.planned_date || '').localeCompare(a.pairing.planned_date || ''));
}

// Success rate over decided pairings (success + failed; pending left out), grouped
// by `key(row)`: [{ key, success, failed, pending, rate }] sorted by key order given.
export function successBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const k = key(r) || '';
    const acc = m.get(k) || { key: k, success: 0, failed: 0, pending: 0 };
    acc[r.outcome] += 1;
    m.set(k, acc);
  }
  return [...m.values()].map((a) => ({ ...a, rate: a.success + a.failed ? a.success / (a.success + a.failed) : null }));
}

// --- Puppy Growth -----------------------------------------------------------------------

// A weight_check event's weight in pounds (lbs + oz/16), or null.
export function weightLbs(ev) {
  const lbs = n(ev.details?.weight_lbs);
  const oz = n(ev.details?.weight_oz);
  if (lbs == null && oz == null) return null;
  return (lbs || 0) + (oz || 0) / 16;
}

// Each pup's weigh-ins as { x: age in days, y: lbs }, oldest first. A pup with no
// birth date takes the litter's whelp date. Weigh-ins before birth are dropped.
export function growthSeries(pups, events, litter = null) {
  return pups.map((p) => {
    const born = p.date_of_birth || litter?.whelp_date || null;
    const points = events
      .filter((e) => e.subject_id === p.id && e.event_type === 'weight_check' && e.event_date)
      .map((e) => ({ date: e.event_date, y: weightLbs(e) }))
      .filter((w) => w.y != null && born && w.date >= born)
      .map((w) => ({ x: daysBetween(born, w.date), y: Math.round(w.y * 10000) / 10000, date: w.date }))
      .sort((a, b) => a.x - b.x || a.date.localeCompare(b.date));
    return { pup: p, points };
  });
}

// Flag a pup falling behind: at its latest weigh-in, under `ratio` of the median
// of its littermates' weights on the nearest weigh-in day (±2 days). Needs at least
// two other pups weighed then. → Map(pupId → { weight, median, ratio })
export function growthFlags(series, ratio = 0.85) {
  const out = new Map();
  for (const s of series) {
    const last = s.points[s.points.length - 1];
    if (!last) continue;
    const peers = series.filter((o) => o !== s)
      .map((o) => o.points.filter((pt) => Math.abs(pt.x - last.x) <= 2).sort((a, b) => Math.abs(a.x - last.x) - Math.abs(b.x - last.x))[0])
      .filter(Boolean).map((pt) => pt.y).sort((a, b) => a - b);
    if (peers.length < 2) continue;
    const mid = peers.length % 2 ? peers[(peers.length - 1) / 2] : (peers[peers.length / 2 - 1] + peers[peers.length / 2]) / 2;
    if (mid > 0 && last.y < mid * ratio) out.set(s.pup.id, { weight: last.y, median: mid, ratio: last.y / mid });
  }
  return out;
}

// --- Heat cycles (Reports plan, phase 3) ---------------------------------------------------

// Per female with heat_cycle events: heats on record, the last one's start, the
// average days between starts, and a predicted next start (last + average, needs
// two heats). `status`: 'due_soon' (within `soonDays`), 'overdue' (predicted date
// passed with no new heat logged), 'ok', or null without a prediction. PURE.
export function heatRows(females, events, today, soonDays = 30) {
  const out = [];
  for (const dog of females) {
    const starts = [...new Set(events.filter((e) => e.subject_id === dog.id && e.event_type === 'heat_cycle' && e.event_date).map((e) => e.event_date))].sort();
    if (!starts.length) continue;
    const gaps = starts.slice(1).map((d, i) => daysBetween(starts[i], d));
    const avg = gaps.length ? Math.round(gaps.reduce((t, g) => t + g, 0) / gaps.length) : null;
    const last = starts[starts.length - 1];
    let next = null;
    if (avg) {
      const t = ymdMs(last) + avg * DAY;
      const d = new Date(t);
      next = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    }
    const until = next ? daysBetween(today, next) : null;
    out.push({
      dog, heats: starts.length, first: starts[0], last, avgInterval: avg,
      shortest: gaps.length ? Math.min(...gaps) : null, longest: gaps.length ? Math.max(...gaps) : null,
      next, until,
      status: until == null ? null : until < 0 ? 'overdue' : until <= soonDays ? 'due_soon' : 'ok'
    });
  }
  return out.sort((a, b) => (a.next || '9999').localeCompare(b.next || '9999'));
}

// --- Health-testing gaps -----------------------------------------------------------------

// Per dog: its planned tests (Dog.planned_tests) split into logged and missing,
// matched the way the dog page matches them — each test event's name token(s)
// (eventRepo.testTokensOf), case-insensitive and trimmed. Advisory, like that page:
// a name typed differently reads as missing. `tokensOf(event)` is injected. PURE.
export function testGapRows(dogs, events, tokensOf) {
  const logged = new Map();
  for (const e of events) {
    if (e.subject_type !== 'dog') continue;
    for (const t of tokensOf(e)) {
      const set = logged.get(e.subject_id) || new Set();
      set.add(String(t).trim().toLowerCase());
      logged.set(e.subject_id, set);
    }
  }
  return dogs.map((dog) => {
    const planned = (dog.planned_tests || []).map((t) => String(t).trim()).filter(Boolean);
    const have = logged.get(dog.id) || new Set();
    const done = planned.filter((t) => have.has(t.toLowerCase()));
    const missing = planned.filter((t) => !have.has(t.toLowerCase()));
    return { dog, planned, done, missing, extra: have.size - done.length };
  });
}

// --- Stud results --------------------------------------------------------------------------

// Per stud service: the litter it produced (a litter whose pairing_id is the
// service's pairing), and its puppies born. PURE.
export function studResultRows(services, litters) {
  const byPairing = new Map(litters.filter((l) => l.pairing_id).map((l) => [l.pairing_id, l]));
  return services.map((s) => {
    const litter = s.pairing_id ? byPairing.get(s.pairing_id) || null : null;
    return { service: s, litter, born: litter && n(litter.puppies_born_total) != null ? n(litter.puppies_born_total) : null };
  });
}
