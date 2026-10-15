// waitlistApplicationForm.js — a waitlist application as form fields: her questions
// (Spec §15.1), in her order and wording, the preference fields, and the public-list
// notice with "list privately". Shared by the Waitlist entry page (a new application,
// and editing one) and Kels's "Set up my waitlist" (adding a family she already has,
// in the chat), so a family typed in either place is asked and read the same way.
// Pro-only (proPages.js), like both callers.
//
// Answers carry data-answer="<question id>" (checkboxes data-answer-cb) so reading
// never depends on element ids built from her question ids; the preference fields
// keep fixed ids (f-pref_*), since their answers live on the entry's pref_* fields.
// Every read is scoped to the `root` element the fields were rendered into.
import { resolveBreed } from '../data/waitlistRules.js';
import { answerText, isAnswerQuestion, matchingPrefKeys, MATCHING_NOTICE, READY_TIMING_LABEL } from '../data/waitlistForm.js';
import { WAITLIST_PREF_SEX, WAITLIST_READY_TIMING, PLACEMENT_PURPOSE, cleanPurposes } from '../data/vocab.js';
import { esc } from './ui.js';

const options = (vocab, current, blankLabel) =>
  (blankLabel != null ? `<option value="">${esc(blankLabel)}</option>` : '') +
  vocab.map((o) => `<option value="${esc(o.value)}"${o.value === current ? ' selected' : ''}>${esc(o.label)}</option>`).join('');

// One application answer as a form field, by her question's answer type.
export function answerField(q, value) {
  const req = q.key === 'name' ? ' <span class="req">*</span>' : '';
  const help = q.help ? `<span class="field-hint">${esc(q.help)}</span>` : '';
  const attr = `data-answer="${esc(q.id)}" aria-label="${esc(q.label)}"`;
  const v = value ?? '';
  let input;
  let wide = false;
  if (q.type === 'long_text') {
    input = `<textarea ${attr}>${esc(v)}</textarea>`;
    wide = true;
  } else if (q.type === 'single_choice') {
    const opts = [...(q.options || [])];
    if (v && !opts.includes(v)) opts.push(v);
    input = `<select ${attr}><option value="">—</option>${opts.map((o) => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  } else if (q.type === 'checkboxes') {
    const picked = Array.isArray(v) ? v : String(v).split(',').map((x) => x.trim()).filter(Boolean);
    const opts = [...(q.options || [])];
    for (const x of picked) if (!opts.includes(x)) opts.push(x);
    input = `<div class="check-group">${opts.map((o) => `<label class="check-inline"><input type="checkbox" data-answer-cb="${esc(q.id)}" value="${esc(o)}"${picked.includes(o) ? ' checked' : ''}> ${esc(o)}</label>`).join('') || '<span class="faint">No options yet.</span>'}</div>`;
    wide = true;
  } else if (q.type === 'yes_no') {
    const cur = answerText(q, v);
    input = `<select ${attr}><option value="">—</option><option value="yes"${cur === 'Yes' ? ' selected' : ''}>Yes</option><option value="no"${cur === 'No' ? ' selected' : ''}>No</option></select>`;
  } else {
    const type = { number: 'number', date: 'date', email: 'email' }[q.type] || 'text';
    input = `<input ${attr} type="${type}" value="${esc(v)}">`;
  }
  return `<div class="field${wide ? ' field-wide' : ''}"><label>${esc(q.label)}${req}</label>${input}${help}</div>`;
}

// The preference fields. `label` is her wording on the application; `breeds` the
// kennel's breeds (waitlistRules.kennelBreeds); `config` its waitlist config.
export function prefField(key, e, { label, breeds = [], config = {} } = {}) {
  // A stored breed that isn't one of the kennel's (typed before this was a
  // dropdown, or imported) stays selectable, flagged, so saving never clears it.
  const current = e.pref_breed || '';
  const known = resolveBreed(current, breeds);
  const breedOpts = `<option value="">Any breed</option>`
    + breeds.map((b) => `<option value="${esc(b)}"${known && b === known ? ' selected' : ''}>${esc(b)}</option>`).join('')
    + (current && known === null ? `<option value="${esc(current)}" selected>${esc(current)} (not one of your breeds)</option>` : '');
  switch (key) {
    case 'pref_sex':
      return `<div class="field"><label>${esc(label || 'Sex')}</label><select id="f-pref_sex">${options(WAITLIST_PREF_SEX, e.pref_sex || 'any')}</select></div>`;
    case 'pref_breed':
      return `<div class="field"><label>${esc(label || 'Breed')}</label><select id="f-pref_breed">${breedOpts}</select>
        <span class="field-hint">${breeds.length ? 'Only pups of this breed are offered to them.' : 'No breeds yet: give this kennel\'s dogs a breed, or add preferred breeds on the kennel page.'}${current && known === null ? ' <strong>Their current breed doesn\'t match any of your dogs\' breeds, so no pup will match it. Pick the right one.</strong>' : ''}</span></div>`;
    case 'pref_purposes': {
      const picked = cleanPurposes(e.pref_purposes);
      return `<div class="field field-wide"><label>${esc(label || 'Looking for')}</label>
        <div>${PLACEMENT_PURPOSE.map((p) => `<label class="check-inline"><input type="checkbox" data-purpose="${esc(p.value)}"${picked.includes(p.value) ? ' checked' : ''}> ${esc(p.label)}</label>`).join(' ')}</div>
        <span class="field-hint">Only pups whose intended registration fits are offered to them (pet and performance → Limited or None, show → Full, breeding → Full or None, co-own → Co-own). None ticked: any registration.</span></div>`;
    }
    case 'ready_timing':
      return `<div class="field"><label>${esc(label || READY_TIMING_LABEL)} <span class="req">*</span></label><select id="f-ready_timing">${options(WAITLIST_READY_TIMING, e.ready_timing || '', '— Choose —')}</select>
        <span class="field-hint">Anything but ASAP puts them on hold: no offers (so no passes used) until that many months after their fee is received, or approval if there's no fee (6+ months → 6).</span></div>`;
    case 'pref_colors':
      return `<div class="field"><label>${esc(label || 'Colors')}</label><input id="f-pref_colors" type="text" value="${esc((e.pref_colors || []).join(', '))}" placeholder="e.g. brindle, seal">
        <span class="field-hint">${config.color_matching ? 'Color matching is on: only pups with one of these colors are offered.' : 'Notes only. Color matching is off in your waitlist settings.'}</span></div>`;
    default: return '';
  }
}

// "List privately" (Spec §15.3): their name shows as "A***** K" on the public list.
// Online, they ask on the application and she approves; here she sets it herself.
export function privateField(e) {
  return `<div class="field field-wide"><label class="check-inline"><input id="f-private_listing" type="checkbox"${e.private_listing ? ' checked' : ''}> Show their name privately on the public list</label>
    <span class="field-hint">Their first name shows as its first letter and an asterisk for each letter after it, then their last initial (Andrea Kim → A***** K). Their place in line is the same.</span></div>`;
}

// A new application's questions, in her order and wording, so typing one in matches
// what families see online. Her matching notice heads the first preference question
// that filters offers; the public-list notice is shown so she can tell the family.
// `form`: waitlistForm.formQuestions(config); `entry`: the draft (its application).
export function applicationFields({ form, config, breeds, entry = {} }) {
  const app = entry.application || {};
  const matchKeys = matchingPrefKeys(config);
  const firstMatch = form.find((q) => matchKeys.includes(q.key));
  const matchNotice = `<div class="field field-wide"><div class="card" style="margin:0;padding:10px 12px;">
      <strong>Matching you with a pup</strong><p style="margin:6px 0 0;">${esc(MATCHING_NOTICE)}</p></div></div>`;
  return form.map((q) => {
    if (q.type === 'preference') return (q === firstMatch ? matchNotice : '') + prefField(q.key, entry, { label: q.label, breeds, config });
    if (q.type === 'notice') {
      return `<div class="field field-wide"><div class="card" style="margin:0;padding:10px 12px;background:var(--surface-2, transparent);">
        <strong>${esc(q.label)}</strong><p style="margin:6px 0 0;white-space:pre-line;">${esc(q.help)}</p>
        <span class="field-hint">Every applicant is told this. Make sure this family has heard it.</span></div></div>${privateField(entry)}`;
    }
    return answerField(q, app[q.id]);
  }).join('');
}

// The answers typed into `root` for `questions` (only answer questions are read),
// over `application` (what was there before).
export function readAnswers(root, questions, application = {}) {
  const out = { ...application };
  for (const q of questions) {
    if (!isAnswerQuestion(q)) continue;
    if (q.type === 'checkboxes') {
      out[q.id] = [...root.querySelectorAll('input[data-answer-cb]')]
        .filter((el) => el.dataset.answerCb === q.id && el.checked).map((el) => el.value);
      continue;
    }
    const el = [...root.querySelectorAll('[data-answer]')].find((x) => x.dataset.answer === q.id);
    if (!el) continue;
    out[q.id] = q.type === 'long_text' ? el.value : el.value.trim();
  }
  return out;
}

// The preference fields and "list privately" typed into `root`. Only fields that
// are there are read (private_listing is left out when its box isn't shown).
export function readPrefs(root) {
  const val = (id) => root.querySelector(`#${id}`)?.value ?? '';
  const out = {
    pref_sex: val('f-pref_sex') || 'any',
    pref_breed: val('f-pref_breed').trim(),
    pref_purposes: [...root.querySelectorAll('[data-purpose]')].filter((x) => x.checked).map((x) => x.dataset.purpose),
    pref_colors: val('f-pref_colors').split(',').map((s) => s.trim()).filter(Boolean),
    ready_timing: val('f-ready_timing') || null
  };
  const priv = root.querySelector('#f-private_listing');
  if (priv) out.private_listing = priv.checked;
  return out;
}
