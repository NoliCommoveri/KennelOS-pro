// duplicateScanUI.js — the Import/Export page's "Duplicates" card: Scan for
// duplicates finds records entered twice on this device (data/duplicateScan.js,
// a file Merge's rules plus the tidy-up's), lists each pair with what they have
// in common, and merges a pair she confirms (data/recordMerge.js mergeDuplicate):
// she picks the record to keep and, where they disagree, which value wins;
// everything that pointed at the other one (its history included) moves to it,
// and the other is deleted. "Not the same" is remembered on this device (nudge ledger, `dup:`;
// for dogs and contacts the tidy-up's key too). Nothing changes until she merges.
import { esc, fmtDate } from './ui.js';
import { editionFlags } from '../data/editionConfig.js';
import { scanTables, RECORD_WORDS, dismissKeys } from '../data/duplicateScan.js';
import { scanForDuplicates, mergeDuplicate, duplicateConflicts, duplicateBlocker, suggestKeep } from '../data/recordMerge.js';
import { describeRecord } from '../data/restoreMatch.js';
import { isDismissed, dismiss } from '../data/nudgeState.js';

const plural = (n, [one, many]) => `${n} ${n === 1 ? one : many}`;
const listWords = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const pretty = (s) => { const t = String(s).replace(/_/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); };
const isDismissedPair = (f) => dismissKeys(f).some((k) => isDismissed(k));

// What the card says it looks through, from the tables this edition has.
export function duplicatesBlurb(flags = editionFlags) {
  const kinds = scanTables(flags).map((t) => RECORD_WORDS[t][1]);
  return `Finds records entered twice: ${listWords(kinds)}. You decide on each pair, and nothing changes until you merge it.`;
}

// Names for the ids a record holds, from every scanned row.
function namer(rows) {
  const byId = new Map();
  for (const [table, list] of Object.entries(rows)) for (const r of list || []) byId.set(r.id, { table, r });
  const nameOf = (table, id) => {
    const hit = id && byId.get(id);
    if (!hit) return '';
    const r = hit.r;
    switch (hit.table) {
      case 'dogs': return r.call_name || r.registered_name || '';
      case 'contacts': return r.name || '';
      case 'kennels': return r.kennel_name || '';
      case 'litters': case 'pairings': return [nameOf('dogs', r.dam_id), nameOf('dogs', r.sire_id)].filter(Boolean).join(' × ');
      case 'waitlist_entries': return nameOf('contacts', r.contact_id);
      default: return r.name || r.title || '';
    }
  };
  return { byId, nameOf };
}

export function mountDuplicateScan(root, { flash = () => {} } = {}) {
  root.querySelector('[data-dup="blurb"]').textContent = duplicatesBlurb();
  const btn = root.querySelector('[data-dup="scan"]');
  const out = root.querySelector('[data-dup="results"]');
  let names = namer({});
  let rows = {};
  let findings = [];

  const describe = (table, r) => {
    const text = describeRecord(table, r, names.nameOf) || 'No details';
    return r.created_at ? `${text} · entered ${fmtDate(String(r.created_at).slice(0, 10))}` : text;
  };

  function show(c, v) {
    if (c.group) return Object.values(v).filter((x) => x != null && x !== '' && typeof x !== 'boolean').map((x) => show({}, x)).join(' · ') || '—';
    if (Array.isArray(v)) return v.map((x) => show({}, x)).join(', ');
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (v && typeof v === 'object') {
      return Object.entries(v).filter(([, x]) => x != null && x !== '').map(([k, x]) => `${pretty(k)}: ${show({}, x)}`).join(' · ');
    }
    const s = String(v);
    if (names.byId.has(s)) return names.nameOf(names.byId.get(s).table, s) || 'another record';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return fmtDate(s);
    if (/^[a-z]+(_[a-z]+)*$/.test(s)) return pretty(s);
    return s;
  }

  async function scan() {
    btn.disabled = true;
    btn.textContent = 'Scanning…';
    try {
      const res = await scanForDuplicates({ flags: editionFlags, dismissed: isDismissedPair });
      rows = res.rows;
      names = namer(rows);
      findings = res.findings;
      render();
    } catch (e) {
      flash(e.message || String(e), 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Scan again';
    }
  }

  function render() {
    if (!findings.length) {
      out.innerHTML = '<p class="muted">No duplicates found. Your records are nice and tidy.</p>';
      return;
    }
    const counts = new Map();
    for (const f of findings) counts.set(f.table, (counts.get(f.table) || 0) + 1);
    const summary = listWords([...counts].map(([t, n]) => plural(n, RECORD_WORDS[t])));
    out.innerHTML = `<p><strong>${plural(findings.length, ['possible duplicate', 'possible duplicates'])}</strong>: ${esc(summary)}.</p>
      ${findings.map((f, i) => {
        const word = RECORD_WORDS[f.table][0];
        const why = f.shared.length ? ` They have the same ${esc(listWords(f.shared))}.` : '';
        return `<div class="dup-item" style="border-top:1px solid var(--border); padding:10px 0;">
          <div>${f.strength === 'certain' ? `These look like the same ${esc(word)}.` : `These might be the same ${esc(word)}.`}${why}</div>
          <ul style="margin:6px 0 8px; padding-left:20px;">
            <li>${esc(describe(f.table, f.a))}</li>
            <li>${esc(describe(f.table, f.b))}</li>
          </ul>
          <button class="btn btn-primary" type="button" data-merge="${i}">Merge…</button>
          <button class="btn" type="button" data-notsame="${i}">Not the same</button>
        </div>`;
      }).join('')}`;
  }

  out.addEventListener('click', async (e) => {
    const m = e.target.closest('[data-merge]');
    const n = e.target.closest('[data-notsame]');
    if (n) {
      const f = findings[Number(n.dataset.notsame)];
      dismissKeys(f).forEach((k) => dismiss(k));
      findings = findings.filter((x) => x !== f);
      render();
      flash(`Got it. I won't raise those two ${RECORD_WORDS[f.table][1]} again.`);
      return;
    }
    if (!m) return;
    const f = findings[Number(m.dataset.merge)];
    const picked = await mergeModal(f);
    if (!picked) return;
    try {
      const { moved } = await mergeDuplicate(f.table, picked.keep.id, picked.drop.id, picked.choices);
      const word = RECORD_WORDS[f.table][0];
      flash(`Merged into one ${word}${moved ? `. ${plural(moved, ['record that pointed', 'records that pointed'])} at the other one now ${moved === 1 ? 'points' : 'point'} at it` : ''}.`);
      await scan();
    } catch (err) {
      flash(`I couldn't merge them: ${err.message || String(err)}`, 'err');
    }
  });

  // Which record to keep, and which value wins where they disagree.
  // → { keep, drop, choices } | null.
  function mergeModal(f) {
    const word = RECORD_WORDS[f.table][0];
    const suggested = suggestKeep(f.a, f.b);
    const conflicts = duplicateConflicts(f.table, f.a, f.b);
    const radio = (name, value, text, checked) => `<label class="check-inline" style="display:flex; gap:6px; margin:4px 0;">
      <input type="radio" name="${name}" value="${value}"${checked ? ' checked' : ''}> <span>${text}</span></label>`;
    const defaultSide = suggested === f.a ? 'a' : 'b';
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true" style="max-width:560px;">
        <h2 style="margin-top:0;">Merge these ${esc(RECORD_WORDS[f.table][1])}?</h2>
        <p class="muted">Everything that points at the other ${esc(word)} and all its history move to the one you keep, and the other is deleted. Blank details fill in from the other one, and notes are kept from both.</p>
        <div class="field"><label>Keep this ${esc(word)}</label>
          ${radio('dup-keep', 'a', esc(describe(f.table, f.a)), defaultSide === 'a')}
          ${radio('dup-keep', 'b', esc(describe(f.table, f.b)), defaultSide === 'b')}
        </div>
        ${conflicts.length ? `<p style="margin-bottom:4px;"><strong>They disagree on ${conflicts.length === 1 ? 'one thing' : 'a few things'}. Which should I keep?</strong></p>
          ${conflicts.map((c, i) => `<div class="field"><label>${esc(c.label)}</label>
            ${radio(`dup-c${i}`, 'a', esc(show(c, c.keep)), defaultSide === 'a')}
            ${radio(`dup-c${i}`, 'b', esc(show(c, c.drop)), defaultSide === 'b')}
          </div>`).join('')}` : ''}
        ${f.table === 'kennels' && f.a.is_own_kennel ? '<p class="muted">Only the kept kennel’s KennelOS ID carries on. Kennel Cards and links made with the other one’s ID stop finding it.</p>' : ''}
        <div class="fm-error"></div>
        <div class="form-actions">
          <button class="btn btn-primary" data-act="ok">Merge</button>
          <button class="btn" data-act="cancel">Cancel</button>
        </div>
      </div>`;
      document.body.appendChild(overlay);
      const done = (v) => { overlay.remove(); resolve(v); };
      // Switching the kept record moves the value choices with it (she can still change each).
      overlay.querySelectorAll('input[name="dup-keep"]').forEach((el) => el.addEventListener('change', () => {
        conflicts.forEach((c, i) => { overlay.querySelector(`input[name="dup-c${i}"][value="${el.value}"]`).checked = true; });
      }));
      overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => done(null));
      overlay.querySelector('[data-act="ok"]').addEventListener('click', () => {
        const side = overlay.querySelector('input[name="dup-keep"]:checked').value;
        const [keep, drop] = side === 'a' ? [f.a, f.b] : [f.b, f.a];
        const blocker = duplicateBlocker(f.table, keep, drop, {
          dogsById: new Map((rows.dogs || []).map((d) => [d.id, d])), waitlistEntries: rows.waitlist_entries || []
        });
        if (blocker) {
          overlay.querySelector('.fm-error').innerHTML = `<div class="inline-error">${esc(blocker)}</div>`;
          return;
        }
        const choices = {};
        conflicts.forEach((c, i) => {
          choices[c.key] = overlay.querySelector(`input[name="dup-c${i}"]:checked`).value === side ? 'keep' : 'drop';
        });
        done({ keep, drop, choices });
      });
    });
  }

  btn.addEventListener('click', scan);
}
