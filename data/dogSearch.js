// dogSearch.js — the one way Kels looks for a dog that's already on file, before
// she makes a new one (Add dogs, the litter task's new mom or dad, the tidy-up's
// parents, a typed ancestor), and the forgiving name match she uses for kennels
// and contacts too. Pure (tests/dogSearch.test.js).
//
// Written for people, not forms: names get misspelled, run together, typed in
// the wrong box, and numbers get typed every which way. So:
// 1. Names, both ways, forgiving: every name she typed (call name, registered
//    name) against both names of every dog. Titles in front ("GCH CH …"), case,
//    spacing and punctuation are ignored; a name hits when it's the same, run
//    together the same ("MaryLou" / "Mary Lou"), or when every word of the
//    shorter one is in the longer one, each word the same or nearly: a slip or
//    two (a swapped pair counts as one; two for words of 7+ letters), the start
//    of the other ("Zoe" / "Zoey"), or sounding the same ("Zoie" / "Zoey",
//    "Khloe" / "Chloe").
// 2. Numbers wherever they were typed: the registration number, and anything
//    number-like in a name box, on both sides; spaces, slashes, dashes and an
//    "AKC" in front never count. The same number is that dog
//    (`certain`); one slip off is "nearly the same number" (likely); a clearly
//    different one is a reason to doubt, never a reason to hide it.
// 3. Then the other facts: a different breed (not just spelled differently) or a
//    sex that doesn't fit is a different dog, never offered (unknown fits
//    either), unless the number is the same; the same breed or birthday (the
//    same, a few days off, or day and month swapped) makes a name `likely`; a
//    name alone, or with a different number or birthday, is `possible`.
// A number is compared without spaces, punctuation or an "AKC" in front, and
// nothing here changes what's stored: everything is kept as she typed it.
import { splitTitles } from './pedigreeParse.js';

// A registration number's key: upper-cased, an "AKC" in front dropped, and only
// letters and digits kept — "NP165114/01", "np 165114-01", "AKC NP16511401" are
// one number however they were typed.
// An AKC number is two letters and eight digits; the four digits printed after it
// ("NP888072/07 03-25") are kept on the record but left out of the key, so the
// number matches whether or not they were typed.
export const normReg = (r) => {
  const k = String(r || '').toUpperCase().replace(/^\s*AKC\b[\s#:.-]*/, '').replace(/[^A-Z0-9]/g, '');
  return /^[A-Z]{2}\d{8}(\d{4})?$/.test(k) ? k.slice(0, 10) : k;
};

const STRENGTH_ORDER = { certain: 0, likely: 1, possible: 2 };

// Number-like: 5+ letters/digits with at least 4 digits ("SR12345601", "WS-7102").
const isNumberish = (t) => /^[a-z0-9]{5,}$/i.test(t) && (t.match(/\d/g) || []).length >= 4;

// A name's words, lowercase, without titles, punctuation or number-like bits.
// "GCH CH Thornfield Zoey-Mae SR123456" → "thornfield zoey mae".
export function nameKey(name) {
  const raw = String(name || '');
  const plain = splitTitles(raw).name || raw;
  return plain.toLowerCase().replace(/[’‘`´']/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter((w) => w && !isNumberish(w) && !/^\d+$/.test(w)).join(' ');
}

// The number-like bits of any text: "SR 123456/01" and "AKC sr12345601" both
// give "SR12345601"; a name with a number typed into it gives that number.
function numbersIn(text) {
  const s = String(text || '');
  const out = new Set();
  // The whole thing, when it has no words in it ("SR 123456/01", "AKC sr-12345601").
  // A number typed with spaces or slashes is one number: spaces, "/", "-" and
  // the rest never count ("SR 123456/01" = "SR12345601").
  const words = s.split(/[^a-z]+/i).filter((w) => w.length >= 3 && w.toLowerCase() !== 'akc');
  if (!words.length) { const whole = normReg(s); if (isNumberish(whole)) out.add(whole); return [...out]; }
  // Or a number-like piece of a name ("Zoey SR12345601").
  for (const t of s.split(/\s+/)) { const k = normReg(t); if (isNumberish(k)) out.add(k); }
  return [...out];
}

// Edit distance where a swapped pair of letters is one slip.
export function slips(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// How a word sounds, roughly: "zoey" / "zoie" / "zoee" → "zoi", "khloe" /
// "chloe" → "klo", "phoebe" → "fobe".
function sound(w) {
  return w.replace(/^(ch|kh)/, 'k').replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/q/g, 'k')
    .replace(/(.)\1+/g, '$1').replace(/(ie|ey|ee|y|i)$/, 'i').replace(/([^aeiou])e$/, '$1')
    .replace(/oe$/, 'o');
}

const allowed = (len) => (len >= 7 ? 2 : len >= 4 ? 1 : 0);

// The same word, or near enough for a person's typing.
function wordHit(x, y) {
  if (x === y) return true;
  const short = Math.min(x.length, y.length);
  if (short >= 3 && (x.startsWith(y) || y.startsWith(x)) && Math.abs(x.length - y.length) <= 2) return true;
  if (short >= 3 && sound(x) === sound(y)) return true;
  return slips(x, y) <= allowed(short);
}

// 'exact' | 'close' (the same words, misspelled) | 'partial' (one name's words
// all in the other) | null, for two name keys.
export function nameHit(a, b) {
  if (!a || !b) return null;
  if (a === b) return 'exact';
  const ja = a.replace(/ /g, '');
  const jb = b.replace(/ /g, '');
  if (ja === jb) return 'exact';
  const aw = a.split(' ');
  const bw = b.split(' ');
  if (aw.length !== bw.length && Math.min(ja.length, jb.length) >= 4 && slips(ja, jb) <= allowed(Math.min(ja.length, jb.length))) return 'partial';
  if (aw.length === bw.length && aw.every((w, i) => wordHit(w, bw[i]))) return 'close';
  const [shorter, longer] = aw.length <= bw.length ? [aw, bw] : [bw, aw];
  return shorter.every((w) => longer.some((v) => wordHit(w, v))) ? 'partial' : null;
}

// Two dates she may mean as one: the same, a few days apart, or day and month
// swapped (03-04 / 04-03).
function sameDay(a, b) {
  if (!a || !b) return null;
  if (a === b) return true;
  const [ya, ma, da] = a.split('-');
  const [yb, mb, db] = b.split('-');
  if (ya === yb && ma === db && da === mb) return true;
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) <= 3 * 86400000;
}

const sexFits = (want, d) => !want || want === 'unknown' || !d.sex || d.sex === 'unknown' || d.sex === want;

// Dogs on file that may be the one she's typing, surest first:
// [{ dog, strength: 'certain'|'likely'|'possible', exact (a name the same),
//    close (the same name, maybe misspelled),
//    agrees: ['registration number'|'nearly the same registration number'|'breed'|'birthday'],
//    differs: ['registration number'|'breed'|'birthday'] }].
// A same-number dog of another sex or breed is shown (`possible`, saying why),
// never `certain`, so nothing takes it without her say.
// typed: { callName, registeredName, registrationNumber, breed, dateOfBirth, sex };
// `excludeIds`: dogs not to offer (the dog itself).
export function findDogMatches(dogs, typed = {}, { excludeIds = [] } = {}) {
  const typedNames = [typed.callName, typed.registeredName].map(nameKey).filter((k) => k.length >= 2);
  const typedNums = [...new Set([typed.registrationNumber, typed.callName, typed.registeredName].flatMap(numbersIn))];
  const breedKey = nameKey(typed.breed);
  const out = [];
  for (const d of dogs) {
    if (!d || d.is_archived || excludeIds.includes(d.id)) continue;
    const dogNums = [...new Set([d.registration_number, d.call_name, d.registered_name].flatMap(numbersIn))];
    const sameNumber = typedNums.some((n) => dogNums.includes(n));
    const nearNumber = !sameNumber && typedNums.some((n) => dogNums.some((m) => Math.min(n.length, m.length) >= 6 && slips(n, m) <= 1));
    const sexOk = sexFits(typed.sex, d);
    if (!sameNumber && !sexOk) continue;
    const RANK = { exact: 3, close: 2, partial: 1 };
    let hit = null;
    for (const t of typedNames) {
      for (const n of [d.call_name, d.registered_name].map(nameKey).filter(Boolean)) {
        const h = nameHit(t, n);
        if (h && (!hit || RANK[h] > RANK[hit])) hit = h;
      }
    }
    if (!sameNumber && !nearNumber && !hit) continue;
    const agrees = [];
    const differs = [];
    if (sameNumber) agrees.push('registration number');
    else if (nearNumber) agrees.push('nearly the same registration number');
    else if (typedNums.length && dogNums.length) differs.push('registration number');
    // A different breed is a different dog (spelled near enough is the same one);
    // only the same registration number still shows it, to say so.
    const dBreed = nameKey(d.breed);
    if (breedKey && dBreed) {
      if (nameHit(breedKey, dBreed)) agrees.push('breed');
      else if (sameNumber) differs.push('breed');
      else continue;
    }
    const day = sameDay(typed.dateOfBirth, d.date_of_birth);
    if (day != null) (day ? agrees : differs).push('birthday');
    // The same number with the wrong sex or breed is shown, to say so, but never
    // taken as that dog without her say (a mom is never filled in with a male).
    if (!sexOk) differs.unshift('sex');
    const strength = sameNumber && !differs.some((x) => x === 'sex' || x === 'breed') ? 'certain'
      : agrees.length && !differs.length ? 'likely'
        : 'possible';
    // `exact`: a name the same; `close`: the same name, misspelled.
    out.push({ dog: d, strength, exact: hit === 'exact', close: hit === 'exact' || hit === 'close', agrees, differs });
  }
  const label = (m) => m.dog.call_name || m.dog.registered_name || '';
  return out.sort((a, b) => STRENGTH_ORDER[a.strength] - STRENGTH_ORDER[b.strength]
    || (b.close - a.close) || (b.exact - a.exact) || (a.differs.length - b.differs.length) || label(a).localeCompare(label(b)));
}

// What she'll be shown about a match: "Same breed and birthday" / "Different
// breed". '' when nothing but the name.
export function matchReason(m) {
  const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0]);
  const same = m.agrees.filter((x) => !x.startsWith('nearly'));
  const near = m.agrees.filter((x) => x.startsWith('nearly'));
  return [
    same.length ? `Same ${list(same)}` : '',
    near.length ? near.map((x) => x[0].toUpperCase() + x.slice(1)).join(', ') : '',
    m.differs.length ? `Different ${list(m.differs)}` : ''
  ].filter(Boolean).join('; ');
}

// A kennel or contact she's about to add that looks like one on file (the same
// forgiving name match): the closest one, or null. `nameOf(item)` gives its name.
export function similarNamed(items, typed, nameOf) {
  const key = nameKey(typed);
  if (key.length < 2) return null;
  let best = null;
  for (const it of items) {
    const h = nameHit(key, nameKey(nameOf(it)));
    if (h === 'exact') return it;
    if (h && !best) best = it;
  }
  return best;
}

// Does this look like a registration number rather than a name?
export const looksLikeNumber = (text) => {
  const t = String(text || '').trim();
  const words = t.split(/[^a-z]+/i).filter((w) => w.length >= 3 && w.toLowerCase() !== 'akc');
  return !words.length && numbersIn(t).length > 0;
};

// The breeds to offer, wherever a breed is typed (the Dog page's suggestions,
// Kels's breed picker): the breeds on her dogs, then her kennels' breed list
// (`preferred_breeds`: the breeds picked at first-run setup or a kennel tests
// import, so they're there before her first dog), one per breed however it's
// spelled: case and spacing ignored, the spelling her dogs use most winning.
// dogs: records with `breed`; pool: kennelRepo.getBreedVocabulary(). Pure.
export function breedChoices({ dogs = [], pool = [] } = {}) {
  const key = (b) => String(b || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const counts = new Map(); // key → Map(spelling → count)
  for (const d of dogs) {
    const spelled = String(d?.breed || '').trim().replace(/\s+/g, ' ');
    if (!spelled) continue;
    const k = key(spelled);
    const m = counts.get(k) || counts.set(k, new Map()).get(k);
    m.set(spelled, (m.get(spelled) || 0) + 1);
  }
  const out = new Map();
  for (const [k, m] of counts) out.set(k, [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]);
  for (const b of pool) {
    const spelled = String(b || '').trim().replace(/\s+/g, ' ');
    if (spelled && !out.has(key(spelled))) out.set(key(spelled), spelled);
  }
  return [...out.values()].sort((a, b) => a.localeCompare(b));
}
