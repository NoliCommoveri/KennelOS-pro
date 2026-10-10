// pedigreeParse.js — reads a pedigree chart's positioned text into a tree of dogs.
// Pure: no PDF library, no OCR, no DOM. The page (pages/pedigree-import.js) gets
// positioned words out of a PDF's text layer or out of OCR (data/pedigreeReader.js)
// and hands them here, so both routes share one layout reader and it's tested
// directly (tests/pedigreeParse.test.js).
//
// The layout it understands is the bracket chart every registry and pedigree
// program prints: the dog on the left, each generation a column to its right, and
// each ancestor's box vertically centred between the boxes of its own two parents
// (sire above, dam below). Built against AKC Research Pedigrees (text PDFs and
// images of them); other programs' charts are read best-effort. Nothing here is
// trusted blindly — the import page shows every dog for review before saving.
//
// Ancestors are addressed by PATH from the dog: '' is the dog, 's' its sire, 'd'
// its dam, 'sd' the sire's dam, and so on. A path's last letter is its sex.

// ---------------------------------------------------------------------------
// 1. Words → segments
// ---------------------------------------------------------------------------
// A segment is a run of words on one line that sit close together — narrower than
// a full line, so two columns side by side never merge into one line of text.
// words: [{ text, x, y, w, h, conf? }] — y is the TOP edge, page units, top-left origin.
export function wordsToSegments(words, { minConf = 0 } = {}) {
  const ws = words
    .filter((w) => String(w.text || '').trim() && (w.conf == null || w.conf >= minConf))
    .map((w) => ({ ...w, text: String(w.text).trim(), cy: w.y + w.h / 2 }))
    .sort((a, b) => a.cy - b.cy);
  // Lines first (by vertical centre), then each line read left to right and cut
  // wherever the gap is wider than a word space — so a wrapped name's second
  // line never interleaves with its first, and neighbouring columns stay apart.
  const lines = [];
  for (const w of ws) {
    const line = lines.find((l) => Math.abs(l.cy - w.cy) < Math.max(l.h, w.h) * 0.5);
    if (line) { line.words.push(w); line.h = Math.max(line.h, w.h); } else lines.push({ cy: w.cy, h: w.h, words: [w] });
  }
  const segs = [];
  for (const line of lines) {
    let seg = null;
    for (const w of line.words.sort((a, b) => a.x - b.x)) {
      const gap = seg ? w.x - (seg.x + seg.w) : Infinity;
      if (seg && gap < Math.max(seg.h, w.h) * 1.6) {
        seg.text += gap > seg.h * 0.12 ? ` ${w.text}` : w.text;
        seg.y = Math.min(seg.y, w.y);
        seg.h = Math.max(seg.h, w.h);
        seg.w = Math.max(seg.x + seg.w, w.x + w.w) - seg.x;
        seg.confs.push(w.conf ?? 100);
      } else {
        seg = { text: w.text, x: w.x, y: w.y, w: w.w, h: w.h, confs: [w.conf ?? 100] };
        segs.push(seg);
      }
    }
  }
  return segs.map(({ confs, ...s }) => ({ ...s, cy: s.y + s.h / 2, conf: confs.reduce((a, b) => a + b, 0) / confs.length }));
}

// ---------------------------------------------------------------------------
// 2. Classifying a line of text
// ---------------------------------------------------------------------------
// The digits allow OCR's usual letter-for-digit swaps (S/5, O/0, I/l/1, B/8, Z/2),
// mapped back by akcDigits — "NPS60004/04" is NP560004/04 misread.
const AKC_REG = /\b([A-Z]{2})\s?([0-9OSIlBZ]{6})\s?\/\s?([0-9OSIlBZ]{2})\b/;
// The "03-25" / "03/25" after an AKC number — not followed by more of a date.
const AKC_TAIL = /^\s*(\d{2}[-/]\d{2})(?![\d/-])/;
const akcDigits = (t) => t.replace(/O/g, '0').replace(/S/g, '5').replace(/[Il]/g, '1').replace(/B/g, '8').replace(/Z/g, '2');
const COLOR_WORDS = new Set(['white', 'black', 'brindle', 'seal', 'blue', 'fawn', 'red', 'brown', 'cream',
  'merle', 'liver', 'chocolate', 'lilac', 'isabella', 'tan', 'gray', 'grey', 'sable', 'pied', 'piebald',
  'champagne', 'gold', 'golden', 'yellow', 'apricot', 'silver', 'tricolor', 'tri', 'parti', 'wheaten',
  'mahogany', 'orange', 'lemon', 'buff', 'platinum', 'harlequin', 'mantle', 'roan', 'ticked', 'spotted',
  'markings', 'and', '&', 'with', 'w/', '/', ',']);
const TITLES = new Set(['CH', 'GCH', 'GCHB', 'GCHS', 'GCHG', 'GCHP', 'INT', 'MBIS', 'MBISS', 'BIS', 'BISS',
  'RBIS', 'NBISS', 'UCH', 'GRCH', 'DC', 'FC', 'AFC', 'OTCH', 'MACH', 'PACH', 'CT', 'TC', 'BPIS', 'MBPIS']);
const HEADER = /^(name|akc\s*#|birth\s*date|date of birth|breed|sex|colou?rs?\b|breeder|report date|registration|owner|dob|whelped)\b|(american kennel club|research pedigree|\bgeneration\b|recreated|copyright|©|all rights|reserved|accuracy|warranty)/i;
// A column heading is the whole line ("Dog", "Gr-Gr-", "Great-Grandparents"),
// never just its first word — a dog may well be named "Dog Gone It".
const GEN_LABEL = /^(dog|parents?|grand-?parents|great-?|gr-?|gr-gr-?|gr-gr-gr-?|great-?grand-?parents|gr-?great-?grand-?parents)$/i;
const isGenLabel = (t) => GEN_LABEL.test(t.replace(/[^A-Za-z-]/g, ''));

export function isAkcReg(text) { const m = text.match(AKC_REG); return !!m && /\d/.test(m[2]); }

// A foreign or non-AKC registration: an uppercase registry code, then something
// with a digit, and no ordinary lowercase words ("MET BOST.T.915/19",
// "PKR IX-75080", "KCSB 3847CY", "ACR A 394-22/140").
export function isOtherReg(text) {
  const t = text.trim();
  if (!/^[A-Z]{2,5}\.?\s/.test(t) || !/\d/.test(t)) return false;
  return !/\b(?!bost\b|bst\b)[a-z]{3,}\b/.test(t.replace(/^[A-Z]{2,5}/, ''));
}

export function isColorOnly(text) {
  const tokens = text.toLowerCase().replace(/([,/&])/g, ' $1 ').split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.some((t) => COLOR_WORDS.has(t) && !['and', '&', 'with', 'w/', '/', ','].includes(t))
    && tokens.every((t) => COLOR_WORDS.has(t));
}

export function isDetail(text) {
  const t = text.trim();
  return isAkcReg(t) || isOtherReg(t) || isColorOnly(t) || /\bDNA\b/i.test(t) || /^CHIC\s?#?\d/i.test(t)
    || /[()]/.test(t)
    // A wrapped tail of a detail line ("V10117423", "08-23", "#V10032399"): a
    // digit and no lowercase letters.
    || (/\d/.test(t) && !/[a-z]/.test(t));
}

// Pull a registration, color and notes out of an entry's detail lines.
export function parseDetails(lines) {
  const out = { registration_number: '', registry: '', color_markings: '', notes: [] };
  for (const raw of lines) {
    let t = raw.trim();
    const akc = t.match(AKC_REG);
    if (akc && /\d/.test(akc[2]) && !out.registration_number) {
      out.registration_number = `${akc[1]}${akcDigits(akc[2])}/${akcDigits(akc[3])}`;
      out.registry = 'AKC';
      t = t.replace(akc[0], '');
      // The four digits AKC prints after the number ("NP888072/07 03-25") are
      // part of it as breeders record it, so they're kept, as printed.
      const tail = t.match(AKC_TAIL);
      if (tail) { out.registration_number += ` ${tail[1]}`; t = t.replace(tail[0], ''); }
    } else if (!out.registration_number && isOtherReg(t)) {
      const m = t.match(/^([A-Z]{2,5})\.?\s+(.*)$/);
      out.registry = m[1];
      // Peel a trailing color phrase off ("NP… Black & White" on one line).
      const colorTail = m[2].match(/\s((?:[A-Za-z]+\s*(?:&|and)?\s*)+)$/);
      if (colorTail && isColorOnly(colorTail[1])) {
        out.registration_number = `${m[1]} ${m[2].slice(0, -colorTail[0].length)}`.trim();
        if (!out.color_markings) out.color_markings = colorTail[1].trim();
      } else {
        out.registration_number = `${m[1]} ${m[2]}`.trim();
      }
      continue;
    }
    const country = t.match(/\(([^)]+)\)/);
    if (country) { out.notes.push(`Registered in ${country[1].trim()}`); t = t.replace(country[0], ''); }
    t = t.trim();
    if (!t) continue;
    if (/\bDNA\b/i.test(t)) out.notes.push(t.replace(/\s+/g, ' '));
    else if (/^CHIC/i.test(t)) out.notes.push(t);
    else if (isColorOnly(t)) { if (!out.color_markings) out.color_markings = t.replace(/\s+/g, ' '); }
    else out.notes.push(t);
  }
  return out;
}

// "CH Crazy Crys Key To Smitten's Heart" → { name, titles: ['CH'] }.
export function splitTitles(name) {
  const tokens = name.trim().split(/\s+/);
  const titles = [];
  while (tokens.length > 1 && TITLES.has(tokens[0].replace(/\.$/, '').toUpperCase())) titles.push(tokens.shift().replace(/\.$/, '').toUpperCase());
  return { name: tokens.join(' '), titles };
}

// ---------------------------------------------------------------------------
// 3. Header fields
// ---------------------------------------------------------------------------
const MALE = /\bsex:?\s*(male|dog)\b/i;
const FEMALE = /\bsex:?\s*(female|bitch)\b/i;

function afterLabel(segs, re) {
  for (const s of segs) {
    const m = s.text.match(re);
    if (m) return m[1].split('|')[0].trim();
  }
  return '';
}

export function parseHeader(segs) {
  const all = segs.map((s) => s.text).join('\n');
  const h = {};
  h.name = afterLabel(segs, /\bName:\s*(.+)$/i).replace(/\s{2,}.*$/, '').replace(/[.,;:]+(?=\s|$)/g, '').trim();
  const breed = afterLabel(segs, /\bBreed(?:\s*\/\s*Variety)?:\s*(.+)$/i);
  h.breed = breed.replace(/\b(Grandparents|Parents|Dog|Sex:.*|Birth.*)$/i, '').trim();
  h.sex = FEMALE.test(all) ? 'female' : MALE.test(all) ? 'male' : '';
  const dob = all.match(/Birth\s*Date:?\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/i);
  h.date_of_birth = dob ? `${dob[3]}-${dob[1].padStart(2, '0')}-${dob[2].padStart(2, '0')}` : '';
  h.color_markings = afterLabel(segs, /Colou?rs?\s*\/\s*Markings:\s*(.+)$/i);
  h.breeder = afterLabel(segs, /Breeder\(?s?\)?:\s*(.+)$/i).replace(/\s*\/\s*$/, '').replace(/\s*Report Date.*$/i, '').trim();
  const reg = all.match(/AKC\s*#:?\s*([A-Z]{2})\s?(\d{6})\s?\/\s?(\d{2})(?:[ \t]+(\d{2}[-/]\d{2})(?![\d/-]))?/i);
  h.registration_number = reg ? `${reg[1].toUpperCase()}${reg[2]}/${reg[3]}${reg[4] ? ` ${reg[4]}` : ''}` : '';
  h.registry = /american kennel club|\bAKC\b/i.test(all) ? 'AKC' : '';
  return h;
}

// ---------------------------------------------------------------------------
// 4. The chart
// ---------------------------------------------------------------------------
// segs: from wordsToSegments. page: { width, height }.
// Returns { header, dogs: Map(path → dog), generations, warnings }.
export function parsePedigree(segs, page) {
  const warnings = [];
  const header = parseHeader(segs);

  // The chart starts at the generation-label row ("Parents", "Grandparents"…);
  // the header block may sit above it or beside the far columns, so header lines
  // are dropped by what they say, not where they are.
  const labelTops = segs.filter((s) => /\b(grand-?parents|parents)\b/i.test(s.text)).map((s) => s.y);
  const top = labelTops.length ? Math.min(...labelTops) : 0;
  const body = segs.filter((s) => s.y > top + 0.5
    && !HEADER.test(s.text.trim()) && !isGenLabel(s.text.trim())
    && !/\b(grand-?parents)\b/i.test(s.text)
    && (s.text.match(/[A-Za-z0-9]/g) || []).length >= 3
    // Page-wide prose (a disclaimer, a footer) is wider than any one column, and
    // OCR's low-confidence fragments are usually ornament, not text.
    && s.w <= page.width * 0.24 && (s.conf ?? 100) >= 50);

  // Columns: cluster left edges; a real column holds at least one registration,
  // which keeps decorations and OCR noise from posing as a generation.
  const tol = page.width * 0.035;
  const clusters = [];
  for (const s of [...body].sort((a, b) => a.x - b.x)) {
    const c = clusters.find((k) => Math.abs(k.x - s.x) <= tol);
    if (c) { c.segs.push(s); c.x = c.segs.reduce((a, b) => a + b.x, 0) / c.segs.length; } else clusters.push({ x: s.x, segs: [s] });
  }
  let cols = clusters.filter((c) => c.segs.some((s) => isAkcReg(s.text) || isOtherReg(s.text))).sort((a, b) => a.x - b.x);
  if (!cols.length) return { header, dogs: new Map(), generations: 0, warnings: ['No pedigree chart was found on this page.'] };
  // Everything else joins its nearest real column when it's close enough.
  for (const c of clusters) {
    if (cols.includes(c)) continue;
    const near = cols.reduce((a, b) => (Math.abs(b.x - c.x) < Math.abs(a.x - c.x) ? b : a));
    if (Math.abs(near.x - c.x) <= tol * 2) near.segs.push(...c.segs);
  }

  // Entries within each column: a name line (or a wrapped pair) and its details.
  const gens = cols.map((c) => {
    const entries = [];
    let cur = null;
    let prev = null;
    for (const s of [...c.segs].sort((a, b) => a.y - b.y)) {
      if (isDetail(s.text)) {
        if (cur) { cur.details.push(s.text); cur.bottom = Math.max(cur.bottom, s.y + s.h); }
      } else if (cur && prev && !isDetail(prev.text) && s.y - (prev.y + prev.h) < prev.h * 0.9) {
        cur.name += ` ${s.text}`;
        cur.bottom = Math.max(cur.bottom, s.y + s.h);
      } else {
        cur = { name: s.text, details: [], top: s.y, bottom: s.y + s.h };
        entries.push(cur);
      }
      prev = s;
    }
    for (const e of entries) e.cy = (e.top + e.bottom) / 2;
    return entries;
  });

  const dogs = new Map();
  const toDog = (e, path) => {
    const { name, titles } = splitTitles(e.name.replace(/\s+/g, ' ').replace(/[|_]+/g, '').trim());
    const det = parseDetails(e.details);
    const notes = [...(titles.length ? [`Titles: ${titles.join(' ')}`] : []), ...det.notes];
    return {
      path, registered_name: name, registration_number: det.registration_number, registry: det.registry,
      color_markings: det.color_markings, notes, sex: path ? (path.endsWith('s') ? 'male' : 'female') : '', cy: e.cy
    };
  };

  // Generation 0: the dog. When the leftmost column holding a registration has
  // two or more boxes it's the parents — the dog's own box went unread (common on
  // an image) — so the dog comes from the header, centred between those parents.
  let root;
  if (gens[0].length >= 2) {
    const left = clusters.filter((c) => !cols.includes(c) && c.x < cols[0].x - tol)
      .flatMap((c) => c.segs).filter((s) => !isDetail(s.text)).sort((a, b) => a.y - b.y);
    root = { name: left.map((s) => s.text).join(' '), details: [], cy: (gens[0][0].cy + gens[0][gens[0].length - 1].cy) / 2 };
    gens.unshift([root]);
  } else {
    root = gens[0][0];
  }
  const subject = toDog(root, '');
  if (header.name) subject.registered_name = splitTitles(header.name).name;
  if (header.registration_number) { subject.registration_number = header.registration_number; subject.registry = 'AKC'; }
  if (!subject.color_markings && header.color_markings) subject.color_markings = header.color_markings;
  subject.sex = header.sex || 'unknown';
  subject.date_of_birth = header.date_of_birth;
  if (header.breeder) subject.notes.push(`Breeder: ${header.breeder}`);
  dogs.set('', subject);
  if (!subject.registered_name) warnings.push('The dog’s own name could not be read; type it in on the review screen.');

  // Each later generation: an entry's child is the nearest entry one column to
  // its left, and it's the sire when it sits above that child, the dam below.
  let prevGen = [subject];
  const unplaced = [];
  const overfull = [];
  for (let g = 1; g < gens.length; g++) {
    const placed = [];
    for (const e of gens[g]) {
      if (!prevGen.length) break;
      const child = prevGen.reduce((a, b) => (Math.abs(b.cy - e.cy) < Math.abs(a.cy - e.cy) ? b : a));
      const path = child.path + (e.cy < child.cy ? 's' : 'd');
      const dog = toDog(e, path);
      if (dogs.has(path)) { unplaced.push(dog.registered_name); continue; }
      dogs.set(path, dog);
      placed.push(dog);
    }
    if (gens[g].length > 2 ** g) overfull.push(`generation ${g} has ${gens[g].length} (at most ${2 ** g})`);
    prevGen = placed;
  }
  if (overfull.length) warnings.push(`More boxes than a pedigree chart holds — ${overfull.join('; ')}. Some dogs may be misplaced.`);
  if (unplaced.length) {
    warnings.push(`${unplaced.length} box${unplaced.length === 1 ? '' : 'es'} couldn’t be placed in the tree and ${unplaced.length === 1 ? 'was' : 'were'} left out: ${unplaced.slice(0, 6).map((n) => `“${n}”`).join(', ')}${unplaced.length > 6 ? '…' : ''}. The chart may not follow the usual layout.`);
  }
  for (const d of dogs.values()) delete d.cy;
  return { header, dogs, generations: gens.length - 1, warnings };
}
