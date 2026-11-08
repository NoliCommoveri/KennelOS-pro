// picksPreviewModal.js — the picks preview (Picks Preview Spec; End-State guide
// §29): what opening picks on a litter will do, across every litter with open
// picks. Shown before every Open picks (the Litter page's Waitlist picks panel and
// the Waitlist page's litter rows), and as "Who's in line…" once picks are open.
// The decisions come from data/picksPreview.js (pure, the same rules openPicks
// runs); this module draws them, and lets her fix what drives them: her turn
// settings (saved here), a pup's disposition / intended registration / sex (saved
// here), and a family's application (a link to their entry; the preview reopens
// when she comes back, via ?preview=<litter id>). Pro-only (proPages.js).
import { kennelRepo } from '../data/kennelRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { waitlistEntryRepo } from '../data/waitlistEntryRepo.js';
import { waitlistOfferRepo } from '../data/waitlistOfferRepo.js';
import { waitlistProgramRepo } from '../data/waitlistProgramRepo.js';
import * as actions from '../data/waitlistActions.js';
import { previewPicks } from '../data/picksPreview.js';
import { entryName, waitlistConfigProblem, openDays, closedDates, liveClosedDates } from '../data/waitlistRules.js';
import { SEX, DISPOSITION, REGISTRATION_TYPE, SALE_STATUS, WAITLIST_PREF_SEX, WAITLIST_AUTO_OFFER_TRIGGER, PLACEMENT_PURPOSE, cleanPurposes, descriptor } from '../data/vocab.js';
import { isDemo } from '../data/demoMode.js';
import { esc, fmtDate, todayYMD } from './ui.js';

const PARAM = 'preview';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const label = (vocab, v) => descriptor(vocab, v)?.label || v || '—';

// Everything the preview reads, for one kennel.
async function loadData(kennelId) {
  const [kennel, entries, offers, litters, dogs, sales, programsById, contacts] = await Promise.all([
    kennelRepo.getById(kennelId),
    waitlistEntryRepo.getByKennel(kennelId),
    waitlistOfferRepo.getByKennel(kennelId),
    litterRepo.getAll({ includeArchived: true }),
    dogRepo.getAll({ includeArchived: true }),
    saleRepo.getAll({ includeArchived: true }),
    waitlistProgramRepo.getMapForKennel(kennelId),
    contactRepo.getAll({ includeArchived: true })
  ]);
  return { kennel, entries, offers, litters, dogs, sales, programsById, contacts };
}

// The preview's litter id from the address (?preview=<id>), or null. The pages
// call this on load to reopen the preview after she went to fix something.
export function previewParam() {
  try { return new URLSearchParams(location.search).get(PARAM); } catch { return null; }
}
function setParam(litterId) {
  try {
    const url = new URL(location.href);
    if (litterId) url.searchParams.set(PARAM, litterId); else url.searchParams.delete(PARAM);
    history.replaceState(history.state, '', url);
  } catch { /* the preview works without it */ }
}

// Open the preview for `litterId`. With picks not open yet it ends with "Open
// picks now": resolves { opened: true, turn } (openPicks' result) once she opens
// them, or null when she closes it. With picks already open it's "Who's in line"
// and resolves null.
export async function openPicksPreview({ litterId }) {
  const litter = await litterRepo.getById(litterId);
  if (!litter) throw new Error('That litter no longer exists.');
  const today = todayYMD();
  const state = { view: 'combined', eitherAs: 'stated', draft: null, editPup: null, notice: '', error: '' };
  let data = await loadData(litter.kennel_id);
  let p = null;

  setParam(litterId);
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = '<div class="modal modal-wide" role="dialog" aria-modal="true"></div>';
    document.body.appendChild(overlay);
    const modal = overlay.querySelector('.modal');
    const done = (val) => { overlay.remove(); setParam(null); resolve(val); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });

    const draw = () => {
      try {
        p = previewPicks(data, { litterId, today, view: state.view, eitherAs: state.eitherAs, configDraft: state.draft });
      } catch (e) {
        modal.innerHTML = `<h2 style="margin-top:0;">Picks preview</h2><div class="inline-error">${esc(e.message || String(e))}</div><div class="form-actions"><button class="btn" data-pp="close">Close</button></div>`;
        modal.querySelector('[data-pp="close"]').addEventListener('click', () => done(null));
        return;
      }
      modal.innerHTML = render(p, data, state);
      wire();
    };

    const reload = async () => { data = await loadData(litter.kennel_id); draw(); };

    const wire = () => {
      const q = (s) => modal.querySelector(s);
      modal.querySelectorAll('[data-pp-view]').forEach((b) => b.addEventListener('click', () => { state.view = b.dataset.ppView; draw(); }));
      modal.querySelectorAll('[data-pp-either]').forEach((b) => b.addEventListener('click', () => { state.eitherAs = b.dataset.ppEither; draw(); }));
      q('[data-pp="close"]')?.addEventListener('click', () => done(null));
      // Settings: every change previews at once (unsaved) until she saves.
      const form = q('[data-pp-settings]');
      if (form) {
        const readDraft = () => {
          const num = (sel) => { const v = form.querySelector(sel).value.trim(); return v === '' ? null : Number(v); };
          const days = [...form.querySelectorAll('[data-pp-open]')].filter((b) => b.checked).map((b) => Number(b.dataset.ppOpen));
          return {
            respond_days: num('[data-pp-set="respond_days"]'),
            max_passes: num('[data-pp-set="max_passes"]'),
            no_response_counts_as_pass: form.querySelector('[data-pp-set="no_response"]').checked,
            color_matching: form.querySelector('[data-pp-set="colors"]').checked,
            auto_offer_on: [...form.querySelectorAll('[data-pp-auto]:checked')].map((b) => b.dataset.ppAuto),
            open_days: days.length === 7 ? null : days,
            closed_dates: [...form.querySelectorAll('[data-pp-closed]')].map((x) => x.dataset.ppClosed)
          };
        };
        const changed = () => {
          const draft = readDraft();
          const problem = waitlistConfigProblem(draft);
          state.error = problem;
          if (!problem) state.draft = draft;
          draw();
        };
        form.querySelectorAll('input').forEach((el) => {
          if (el.dataset.ppClosedNew !== undefined) return;
          el.addEventListener('change', changed);
        });
        form.querySelectorAll('[data-pp-closed-remove]').forEach((b) => b.addEventListener('click', () => {
          b.closest('[data-pp-closed]').remove();
          changed();
        }));
        form.querySelector('[data-pp="closed-add"]')?.addEventListener('click', () => {
          const v = form.querySelector('[data-pp-closed-new]').value;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
          const draft = readDraft();
          draft.closed_dates = [...new Set([...draft.closed_dates, v])].sort();
          state.draft = draft;
          state.error = '';
          draw();
        });
        form.querySelector('[data-pp="discard"]')?.addEventListener('click', () => { state.draft = null; state.error = ''; draw(); });
        form.querySelector('[data-pp="save"]')?.addEventListener('click', async () => {
          const stored = data.kennel.waitlist_config || {};
          const next = { ...stored, ...state.draft, closed_dates: liveClosedDates(state.draft.closed_dates || [], today) };
          const problem = waitlistConfigProblem(next);
          if (problem) { state.error = problem; draw(); return; }
          try {
            await kennelRepo.update(data.kennel.id, { waitlist_config: next });
            state.draft = null;
            state.notice = 'Settings saved.';
            await reload();
          } catch (e) { state.error = e.message || String(e); draw(); }
        });
      }
      // Pups: a small inline edit for what decides who's offered a pup.
      modal.querySelectorAll('[data-pp-edit-pup]').forEach((b) => b.addEventListener('click', () => { state.editPup = b.dataset.ppEditPup; draw(); }));
      q('[data-pp="pup-cancel"]')?.addEventListener('click', () => { state.editPup = null; draw(); });
      q('[data-pp="pup-save"]')?.addEventListener('click', async () => {
        const row = q('[data-pp-pup-form]');
        try {
          await dogRepo.update(state.editPup, {
            disposition: row.querySelector('[data-pp-pup="disposition"]').value,
            intended_registration: row.querySelector('[data-pp-pup="registration"]').value || null,
            sex: row.querySelector('[data-pp-pup="sex"]').value
          });
          state.editPup = null;
          state.notice = 'Pup saved.';
          await reload();
        } catch (e) { state.error = e.message || String(e); draw(); }
      });
      // Open picks now: rerun the preview on fresh records first, and open only if
      // what will happen is still what she was shown.
      q('[data-pp="open"]')?.addEventListener('click', async (ev) => {
        ev.currentTarget.disabled = true;
        const shown = JSON.stringify(previewPicks(data, { litterId, today }).action);
        data = await loadData(litter.kennel_id);
        const fresh = previewPicks(data, { litterId, today });
        if (JSON.stringify(fresh.action) !== shown) {
          state.notice = 'Something changed since this opened (another device, or another tab). Check the updated preview, then open picks.';
          draw();
          return;
        }
        try {
          const turn = await actions.openPicks(litterId, { date: today });
          done({ opened: true, turn });
        } catch (e) { state.error = e.message || String(e); draw(); }
      });
    };

    draw();
  });
}

// --- Drawing ------------------------------------------------------------------

function render(p, data, state) {
  const n = names(data);
  const target = data.litters.find((l) => l.id === p.litter_id);
  const draftMark = state.draft ? ' <span class="badge badge-amber">Unsaved settings</span>' : '';
  const btn = (attr, val, cur, text) => `<button type="button" class="btn btn-sm${val === cur ? ' btn-primary' : ''}" ${attr}="${esc(val)}">${esc(text)}</button>`;
  const demo = isDemo();
  return `
    <h2 style="margin-top:0;">${p.already_open ? 'Who\'s in line' : 'Before you open picks'}: ${esc(n.litter(target))}${draftMark}</h2>
    ${state.notice ? `<div class="inline-notice" style="margin:0 0 8px;">${esc(state.notice)}</div>` : ''}
    ${state.error ? `<div class="inline-error" style="margin:0 0 8px;">${esc(state.error)}</div>` : ''}
    <section class="card" style="margin:0 0 12px;">
      <h3 style="margin:0 0 6px;font-size:15px;">${p.already_open ? 'What happens next' : 'When you open picks'}</h3>
      ${actionHtml(p, n)}
    </section>
    <div class="pill-row" style="margin:0 0 6px;align-items:center;">
      <span class="muted">Show:</span>
      ${btn('data-pp-view', 'combined', p.view, p.other_open_litter_ids.length ? 'With your open litters' : 'This litter')}
      ${p.other_open_litter_ids.length ? btn('data-pp-view', 'alone', p.view, 'If earlier litters finish first') : ''}
    </div>
    <div class="pill-row" style="margin:0 0 12px;align-items:center;">
      <span class="muted">"Either" families:</span>
      ${btn('data-pp-either', 'stated', p.either_as, 'As they said')}
      ${btn('data-pp-either', 'female', p.either_as, 'Take females')}
      ${btn('data-pp-either', 'male', p.either_as, 'Take males')}
    </div>
    ${p.view === 'combined' && p.other_open_litter_ids.length ? `<p class="field-hint" style="margin:-4px 0 12px;">One family holds a turn at a time across all your open litters, and each turn shows every pup they match in every open litter. Litters aren't offered separately.</p>` : ''}
    ${p.view === 'alone' ? '<p class="field-hint" style="margin:-4px 0 12px;">This litter on its own, as if your other open litters were finished. Families marked "also in line" may be placed from another litter first.</p>' : ''}
    ${turnOrderHtml(p, data, n)}
    ${pupsHtml(p, data, n, state)}
    ${excludedHtml(p, data, n)}
    ${checksHtml(p, data, n)}
    ${settingsHtml(p, data, state)}
    <div class="form-actions">
      ${p.already_open ? '<button class="btn btn-primary" data-pp="close">Close</button>'
        : `<button class="btn btn-primary" data-pp="open"${demo || state.draft ? ' disabled' : ''}${state.draft ? ' title="Save or discard your settings changes first."' : ''}>Open picks now</button>
           <button class="btn" data-pp="close">Cancel</button>`}
    </div>
    ${!p.already_open && state.draft ? '<p class="field-hint">Save or discard your settings changes before opening picks.</p>' : ''}
    ${demo ? '<p class="field-hint">This is the demo: nothing can be saved or opened.</p>' : ''}`;
}

// Names and labels from the loaded records.
function names(data) {
  const contacts = new Map(data.contacts.map((c) => [c.id, c]));
  const entries = new Map(data.entries.map((e) => [e.id, e]));
  const dogs = new Map(data.dogs.map((d) => [d.id, d]));
  const litters = new Map(data.litters.map((l) => [l.id, l]));
  const entry = (id) => entries.get(id);
  const family = (id) => { const e = entries.get(id); return e ? entryName(e, contacts.get(e.contact_id)) : 'A family'; };
  const litter = (l) => (l ? (l.nickname || `${dogs.get(l.dam_id)?.call_name || 'Unknown'} × ${dogs.get(l.sire_id)?.call_name || 'Unknown'}`) : 'a litter');
  return {
    entry, family, dogs, litters,
    familyLink: (id) => `<a href="waitlist-entry.html?id=${encodeURIComponent(id)}">${esc(family(id))}</a>`,
    litter,
    litterName: (id) => litter(litters.get(id)),
    pup: (id) => dogs.get(id)?.call_name || 'a pup',
    pupLink: (id) => `<a href="dog.html?id=${encodeURIComponent(id)}">${esc(dogs.get(id)?.call_name || 'a pup')}</a>`,
    pups: (ids) => ids.map((id) => dogs.get(id)?.call_name || 'a pup').join(', ')
  };
}

function actionHtml(p, n) {
  const a = p.action;
  const lines = [];
  for (const x of a.auto_passed || []) {
    const counted = x.counted ? `a pass is recorded (pass ${x.used} of ${x.max})` : 'a pass is recorded (it doesn\'t count)';
    lines.push(`<span class="badge badge-amber">Not this litter</span> ${n.familyLink(x.entry_id)} said "Not this litter" to ${esc(x.litter_ids.map(n.litterName).join(', '))}, so ${counted}${x.removed ? ' and they\'re removed from the list (you can undo it for 7 days)' : ''}, and the list moves on.`);
  }
  const littersWithPups = (ls) => ls.map((x) => `${esc(n.litterName(x.litter_id))} (${esc(n.pups(x.dog_ids))})`).join(' and ');
  const nextAfterHolder = () => {
    const next = p.turnOrder.filter((t) => !t.holds_turn).slice(0, 3);
    if (!next.length) return ' When it ends, nobody else is in line.';
    return ` When it ends, next in line: ${next.map((t) => `#${esc(t.position)} ${n.familyLink(t.entry_id)} (${esc(t.litters.map((x) => n.litterName(x.litter_id)).join(', '))}${t.litters.length === 1 && p.shown_litter_ids.length > 1 ? ' only' : ''})`).join(', then ')}.`;
  };
  switch (a.kind) {
    case 'offer':
      lines.push(`${n.familyLink(a.entry_id)} ${p.already_open ? 'is next for a turn' : 'gets the next turn'}: ${littersWithPups(a.litters)}. Pick and pay by <strong>${esc(fmtDate(a.respond_by))}</strong>.${a.prepassed.length ? ` They said "Not this litter" to ${esc(a.prepassed.map(n.litterName).join(', '))}, so that's recorded as passed when their turn comes.` : ''}${p.already_open ? ' Use "Offer to them" when you\'re ready.' : ''}`);
      break;
    case 'join':
      lines.push(`This litter joins ${n.familyLink(a.entry_id)}'s turn: they're the top family for it (${esc(n.pups(a.dog_ids))}). ${a.was_respond_by === a.respond_by ? `Their deadline stays <strong>${esc(fmtDate(a.respond_by))}</strong>.` : `Their deadline restarts for the whole turn: ${esc(fmtDate(a.was_respond_by))} → <strong>${esc(fmtDate(a.respond_by))}</strong>.`}`);
      break;
    case 'wait':
      lines.push(`This litter waits. ${n.familyLink(a.holder_id)} holds the turn (${esc(a.holder_litter_ids.map(n.litterName).join(', '))}) until ${esc(fmtDate(a.respond_by))}${a.prepass_blocked ? ', and said "Not this litter" to this one' : ', and isn\'t the top family for this litter'}.${nextAfterHolder()}`);
      break;
    case 'held':
      lines.push(`${n.familyLink(a.holder_id)} holds the turn (${esc(a.holder_litter_ids.map(n.litterName).join(', '))}) until ${esc(fmtDate(a.respond_by))}.${nextAfterHolder()}`);
      break;
    default:
      lines.push('Nobody on the list qualifies for any available pup in your open litters. "Left out" below says why.');
  }
  return lines.map((l) => `<p style="margin:0 0 6px;">${l}</p>`).join('');
}

function turnOrderHtml(p, data, n) {
  if (!p.turnOrder.length) return '';
  const rows = p.turnOrder.map((t) => {
    const e = n.entry(t.entry_id);
    const program = e && data.programsById.get(e.waitlist_program_id);
    const bits = [];
    if (t.holds_turn) bits.push(`<span class="badge badge-purple">Holds the turn</span> ${esc(t.holds_litter_ids.map(n.litterName).join(', '))}`);
    for (const x of t.litters) bits.push(`<strong>${esc(n.litterName(x.litter_id))}:</strong> ${esc(n.pups(x.dog_ids))}`);
    for (const id of t.prepassed) bits.push(`<span class="badge badge-amber">Not this litter</span> ${esc(n.litterName(id))}`);
    for (const id of t.had_turn) bits.push(`<span class="faint">Had their turn on ${esc(n.litterName(id))}</span>`);
    for (const x of t.not_for) bits.push(`<span class="faint">Not for ${esc(n.litterName(x.litter_id))}: ${esc(x.reasons.map((r) => reasonText(r, e, data, n)).join('; '))}</span>`);
    for (const id of t.also_in) bits.push(`<span class="badge badge-gray">Also in line for ${esc(n.litterName(id))}</span>`);
    const passes = t.passes.used ? ` <span class="faint">${t.passes.used} of ${t.passes.max} passes used${t.passes.used + 1 >= t.passes.max && t.passes.counted ? '; their next pass removes them' : ''}</span>` : '';
    const either = t.either_as ? ` <span class="badge badge-gray">Either, as ${esc(t.either_as)}</span>` : '';
    return `<tr><td>#${esc(t.position)}</td><td>${n.familyLink(t.entry_id)}${t.ahead && program ? ` <span class="badge badge-blue">${esc(program.name || 'Ahead')}</span>` : ''}${either}${passes}</td><td>${bits.join('<br>')}</td></tr>`;
  }).join('');
  return `<h3 style="margin:12px 0 4px;font-size:15px;">Turn order</h3>
    <p class="field-hint" style="margin:0 0 6px;">In list order, with the pups each family qualifies for as things are now. Pups come off as earlier families choose; nobody can say who'll take which.</p>
    <table class="data"><thead><tr><th>Place</th><th>Family</th><th>Qualifies for</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const PUP_FLAG = {
  no_registration: 'No intended registration: matches every family, whatever they\'re looking for.',
  no_color: 'No color/markings: with color matching on, every family who named colors is ruled out.',
  no_sex: 'No sex recorded: only "Either" families match.'
};

function blockerText(b, n) {
  switch (b.code) {
    case 'disposition': return `Disposition: ${label(DISPOSITION, b.disposition)}`;
    case 'deceased': return 'Deceased';
    case 'gone_home': return 'Gone home';
    case 'external': return 'An outside dog now';
    case 'archived': return 'Archived';
    case 'side_sale': return `Side sale to ${n.family(b.entry_id)}, held for them${b.due ? ` (deposit due ${fmtDate(b.due)})` : ''}`;
    case 'sale': return b.picked ? `Picked by ${n.family(b.entry_id)} in their turn (deposit pending)` : `Has a sale (${label(SALE_STATUS, b.sale_status)})`;
    default: return b.code;
  }
}

function pupsHtml(p, data, n, state) {
  const demo = isDemo();
  return p.pupsByLitter.map((L) => {
    const sexLine = (sex, text) => {
      const s = L.by_sex[sex];
      if (!s.pups && !s.families) return '';
      const reach = s.within_reach.length ? `; within reach: ${s.within_reach.map((id) => esc(n.family(id))).join(', ')}` : '';
      return `<div>${text}: ${s.pups} offered, ${s.families} famil${s.families === 1 ? 'y' : 'ies'} in line${reach}</div>`;
    };
    const rows = L.pups.map((r) => {
      const dog = n.dogs.get(r.dog_id);
      const status = r.offered
        ? `<span class="badge badge-green">Offered</span>${r.holder_id ? ` <span class="faint">in ${esc(n.family(r.holder_id))}'s turn</span>` : ''}`
        : `<span class="badge badge-gray">Not offered</span> ${esc(r.blockers.map((b) => blockerText(b, n)).join('; '))}`;
      const conflict = r.conflict ? ' <span class="badge badge-red">Two sales on this pup</span>' : '';
      const side = (r.side || []).map((x) => `<div class="field-hint" style="margin:2px 0 0;">Side sale pending: ${n.familyLink(x.entry_id)}${x.due ? `, deposit due ${esc(fmtDate(x.due))}` : ''}</div>`).join('');
      const flags = r.flags.map((f) => `<div class="field-hint" style="margin:2px 0 0;">⚠ ${esc(PUP_FLAG[f] || f)}</div>`).join('');
      const fams = r.offered
        ? (r.families.length ? r.families.map((f, i) => `${i + 1}. ${n.familyLink(f.entry_id)}${f.holds_turn ? ' <span class="badge badge-purple">Holds the turn</span>' : ''}${f.prepassed ? ' <span class="faint">(Not this litter)</span>' : ''}`).join('<br>') : '<span class="faint">Nobody qualifies</span>')
        : '';
      const facts = `${esc(label(SEX, dog?.sex))} · ${esc(dog?.intended_registration ? label(REGISTRATION_TYPE, dog.intended_registration) : 'no registration')}`;
      const editing = state.editPup === r.dog_id;
      const edit = editing ? pupForm(dog) : (demo ? '' : ` <button type="button" class="btn btn-sm" data-pp-edit-pup="${esc(r.dog_id)}">Edit</button>`);
      return `<tr><td>${n.pupLink(r.dog_id)}<div class="faint">${facts}</div>${edit}</td><td>${status}${conflict}${side}${flags}</td><td>${fams}</td></tr>`;
    }).join('');
    return `<h3 style="margin:16px 0 4px;font-size:15px;">${esc(n.litterName(L.litter_id))}${L.is_target ? (p.already_open ? '' : ' <span class="badge badge-blue">Opening now</span>') : ' <span class="badge badge-gray">Picks open</span>'}</h3>
      <div class="field-hint" style="margin:0 0 6px;">${sexLine('female', 'Females')}${sexLine('male', 'Males')}</div>
      ${rows ? `<table class="data"><thead><tr><th>Pup</th><th>Offered?</th><th>Who qualifies, in order</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">No pups recorded in this litter yet.</p>'}`;
  }).join('');
}

function pupForm(dog) {
  const opts = (vocab, cur, blank = '') => (blank ? `<option value="">${esc(blank)}</option>` : '')
    + vocab.map((v) => `<option value="${esc(v.value)}"${v.value === cur ? ' selected' : ''}>${esc(v.label)}</option>`).join('');
  return `<div data-pp-pup-form style="margin-top:6px;display:grid;gap:4px;">
      <label class="faint">Disposition <select data-pp-pup="disposition">${opts(DISPOSITION, dog.disposition || 'undecided')}</select></label>
      <label class="faint">Intended registration <select data-pp-pup="registration">${opts(REGISTRATION_TYPE, dog.intended_registration || '', 'Not set')}</select></label>
      <label class="faint">Sex <select data-pp-pup="sex">${opts(SEX, dog.sex || 'unknown')}</select></label>
      <div class="pill-row"><button type="button" class="btn btn-sm btn-primary" data-pp="pup-save">Save pup</button><button type="button" class="btn btn-sm" data-pp="pup-cancel">Cancel</button></div>
    </div>`;
}

const FIELD_WORDS = {
  sex: (e) => `sex (wants ${label(WAITLIST_PREF_SEX, e.pref_sex || 'any')})`,
  breed: (e) => `breed (wants ${e.pref_breed})`,
  purposes: (e) => `looking for (${cleanPurposes(e.pref_purposes).map((v) => label(PLACEMENT_PURPOSE, v)).join(', ')})`,
  colors: () => 'colors'
};

function reasonText(r, entry, data, n) {
  switch (r.code) {
    case 'side_sale': return `Buying ${n.pup(r.dog_id)} (side sale${r.due ? `, deposit due ${fmtDate(r.due)}` : ''}), so not offered turns meanwhile`;
    case 'paused': return `Paused by you until ${fmtDate(r.until)}`;
    case 'ready_hold': return r.until ? `Not ready to buy until ${fmtDate(r.until)}` : 'Waiting on their "Ready now?" answer';
    case 'listening': return r.mode === 'except' ? 'Asked to skip litters from this sire or dam' : 'Only listening for litters from other sires or dams';
    case 'had_turn': return { passed: 'Passed on this litter', no_response: 'Didn\'t respond on this litter', accepted: 'Already chose a pup from this litter', backed_out: 'Backed out of their pup from this litter' }[r.outcome] || 'Already had their turn on this litter';
    case 'holds_turn': return 'Holds the turn now';
    case 'no_pups': return 'No pups available in this litter';
    case 'no_match': {
      const byField = new Map();
      for (const x of r.pups) for (const f of x.fields) byField.set(f, [...(byField.get(f) || []), x.dog_id]);
      const parts = [...byField.entries()].map(([f, ids]) => `${FIELD_WORDS[f] ? FIELD_WORDS[f](entry) : f} rules out ${n.pups(ids)}`);
      return `No pup matches: ${parts.join('; ') || 'their answers together rule out every pup'}`;
    }
    default: return r.code;
  }
}

function excludedHtml(p, data, n) {
  const multi = p.shown_litter_ids.length > 1;
  const rows = p.excluded.map((x) => {
    const e = n.entry(x.entry_id);
    const why = x.litters.map((l) => `${multi ? `<strong>${esc(n.litterName(l.litter_id))}:</strong> ` : ''}${esc(l.reasons.map((r) => reasonText(r, e, data, n)).join('; '))}`).join('<br>');
    return `<tr><td>#${esc(x.position)}</td><td>${n.familyLink(x.entry_id)}${x.either_as ? ` <span class="badge badge-gray">Either, as ${esc(x.either_as)}</span>` : ''}</td><td>${why}</td></tr>`;
  }).join('');
  const notOn = p.notOnList.map((x) => `<li>${n.familyLink(x.entry_id)}: ${x.status === 'applied' ? 'applied, not approved yet' : 'approved, fee not recorded'}</li>`).join('');
  return `<h3 style="margin:16px 0 4px;font-size:15px;">Left out</h3>
    ${rows ? `<table class="data"><thead><tr><th>Place</th><th>Family</th><th>Why</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted" style="margin:0;">Everyone on the list is in line.</p>'}
    ${notOn ? `<p style="margin:8px 0 2px;"><strong>Not on the list yet</strong> <span class="faint">(they can't be offered until they are)</span></p><ul style="margin:0;">${notOn}</ul>` : ''}`;
}

const CHECK_TEXT = {
  any_registration: 'Looking for left blank: they match any registration.',
  breed_unknown: 'Their breed isn\'t one of your breeds, so no pup matches it.',
  no_email: 'No email: they can\'t be emailed their turn.',
  no_fee_date: 'No fee date: their place falls back to their approval date.'
};

function checksHtml(p, data, n) {
  if (!p.checks.length) return '';
  const items = p.checks.map((c) => {
    const e = n.entry(c.entry_id);
    return `<li>${n.familyLink(c.entry_id)}: ${c.codes.map((code) => esc(code === 'breed_unknown' ? `Breed "${e?.pref_breed}" isn't one of your breeds, so no pup matches it.` : CHECK_TEXT[code] || code)).join(' ')}</li>`;
  }).join('');
  return `<h3 style="margin:16px 0 4px;font-size:15px;">Worth checking</h3>
    <p class="field-hint" style="margin:0 0 4px;">Things that are often typed by mistake on hand-entered applications. Tap a family to fix theirs.</p>
    <ul style="margin:0;">${items}</ul>`;
}

function settingsHtml(p, data, state) {
  const c = p.config;
  const demo = isDemo();
  const dis = demo ? ' disabled' : '';
  const programs = [...data.programsById.values()].filter((x) => !x.is_archived);
  const programLines = programs.filter((x) => x.priority === 'ahead' || x.passes_count === false || (x.respond_days_override != null && x.respond_days_override !== ''))
    .map((x) => `<li>${esc(x.name || 'A program')}: ${[x.priority === 'ahead' ? 'goes ahead in line' : '', x.respond_days_override != null && x.respond_days_override !== '' ? `${esc(x.respond_days_override)} days to pick and pay` : '', x.passes_count === false ? 'passes don\'t count' : ''].filter(Boolean).join(', ')}</li>`).join('');
  const closed = liveClosedDates(closedDates(c), todayYMD());
  const kennelId = data.kennel.id;
  return `<h3 style="margin:16px 0 4px;font-size:15px;">Settings that decide this</h3>
    <div class="card" data-pp-settings style="margin:0;">
      <p class="field-hint" style="margin:0 0 8px;">Offered today, a family has until <strong>${esc(fmtDate(p.respond_by_today))}</strong> to pick a pup and send the deposit. Changes show in the preview at once; save to keep them.</p>
      <div class="form-grid">
        <div class="field"><label>Days to pick and pay the deposit</label><input type="number" min="1" step="1" data-pp-set="respond_days" value="${esc(c.respond_days)}"${dis}></div>
        <div class="field"><label>Passes before removal</label><input type="number" min="1" step="1" data-pp-set="max_passes" value="${esc(c.max_passes)}"${dis}></div>
        <div class="field field-wide">
          <label class="check-inline"><input type="checkbox" data-pp-set="no_response"${c.no_response_counts_as_pass ? ' checked' : ''}${dis}> No response by the deadline counts as a pass</label>
          <label class="check-inline"><input type="checkbox" data-pp-set="colors"${c.color_matching ? ' checked' : ''}${dis}> Match on color (only offer pups in a color the family listed)</label>
        </div>
        <div class="field field-wide"><label>Days you do business</label>
          <div class="pill-row">${WEEKDAYS.map((d, i) => `<label class="check-inline"><input type="checkbox" data-pp-open="${i}"${openDays(c).includes(i) ? ' checked' : ''}${dis}> ${d}</label>`).join('')}</div></div>
        <div class="field field-wide"><label>Closed dates</label>
          <div class="pill-row">${closed.map((d) => `<span class="badge badge-neutral" data-pp-closed="${esc(d)}" style="margin:2px 4px 2px 0;">${esc(fmtDate(d))}${demo ? '' : ` <button type="button" class="btn btn-sm" data-pp-closed-remove aria-label="Remove ${esc(fmtDate(d))}" style="padding:0 6px;margin-left:4px;">✕</button>`}</span>`).join('') || '<span class="faint">None</span>'}</div>
          ${demo ? '' : '<div class="pill-row" style="margin-top:6px;align-items:center;"><input type="date" data-pp-closed-new style="width:auto;"><button type="button" class="btn btn-sm" data-pp="closed-add">Add date</button></div>'}</div>
        <div class="field field-wide"><label>Offer the next family automatically when…</label>
          ${WAITLIST_AUTO_OFFER_TRIGGER.map((t) => `<label class="check-inline"><input type="checkbox" data-pp-auto="${esc(t.value)}"${c.auto_offer_on.includes(t.value) ? ' checked' : ''}${dis}> ${esc(t.label)}</label>`).join('')}</div>
      </div>
      ${programLines ? `<p style="margin:8px 0 2px;"><strong>Programs</strong> <a href="waitlist-programs.html">change on the Programs page →</a></p><ul style="margin:0;">${programLines}</ul>` : ''}
      <p class="field-hint" style="margin:8px 0 0;">Your list online, reminder emails and everything else: <a href="kennel.html?id=${encodeURIComponent(kennelId)}">Waitlist settings →</a></p>
      ${state.draft && !demo ? '<div class="pill-row" style="margin-top:10px;"><button type="button" class="btn btn-sm btn-primary" data-pp="save">Save settings</button><button type="button" class="btn btn-sm" data-pp="discard">Discard changes</button></div>' : ''}
    </div>`;
}

