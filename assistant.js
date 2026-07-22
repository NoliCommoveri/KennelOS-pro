// assistant.js — the whole KennelAssistant app (see assistant.html). Three
// verbs: sync dogs in from the Dropbox feed, log events locally, send them
// back as the outbox. All storage goes through data/assistantStore.js (its own
// tiny database); Dropbox goes through the same data/dropbox.js client and
// connection the main app uses, so on the owner's own phone the two share one
// sign-in.
import { esc, confirmModal } from './assets/ui.js';
import { EVENT_TYPES, ASSISTANT_EVENT_TYPES, DOG_STATUS, SEX, descriptor, eventTypesFor } from './data/vocab.js';
import { todayYMD } from './data/dateUtils.js';
import {
  completeDropboxAuth, beginDropboxAuth, isDropboxConnected,
  dropboxUploadJson, dropboxDownloadJson,
  DROPBOX_PATHS
} from './data/dropbox.js';
import {
  syncFromFeed, getDogs, getTimeline, createPendingEvent,
  getPendingEvents, deletePendingEvent, buildOutbox,
  weightTotalOz, fmtWeight, weighKey, getPriorWeighIn
} from './data/assistantStore.js';
import { getAssistantLastSync } from './data/settings.js';

// Same service worker + scope as the main app (registered from app root), so
// the assistant loads fast on its own too.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(new URL('./sw.js', import.meta.url), { scope: new URL('./', import.meta.url) });
}

const msg = document.getElementById('page-msg');
function flash(text, kind = 'ok') {
  msg.innerHTML = `<div class="${kind === 'ok' ? 'inline-warn' : 'inline-error'}" style="${kind === 'ok' ? 'color:var(--accent-dark);background:var(--accent-soft);border-color:#bfe0cd;' : ''}">${esc(text)}</div>`;
  msg.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function show(id, visible) {
  document.getElementById(id).style.display = visible ? '' : 'none';
}

async function renderAll() {
  const connected = isDropboxConnected();
  show('connect-card', !connected);
  show('sync-card', connected);
  show('dogs-card', connected);
  if (!connected) {
    show('pending-card', false);
    return;
  }
  await Promise.all([renderSyncStatus(), renderPending(), renderDogs()]);
}

async function renderSyncStatus() {
  const last = getAssistantLastSync();
  const pending = await getPendingEvents();
  document.getElementById('sync-status').textContent = last
    ? `Dogs last synced ${new Date(last).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.`
    : 'No dogs yet — tap "Get latest dogs" to pull them in.';
  const sendBtn = document.getElementById('btn-send');
  sendBtn.style.display = pending.length ? '' : 'none';
  sendBtn.textContent = `⬆ Send my updates (${pending.length})`;
}

// "Sire × Dam" (whichever halves the feed could resolve), or '' if neither.
function parentsLabel(d) {
  if (!d.sire_name && !d.dam_name) return '';
  return `${d.sire_name || '?'} × ${d.dam_name || '?'}`;
}

function dogRowHtml(d) {
  const status = descriptor(DOG_STATUS, d.status);
  const sex = descriptor(SEX, d.sex);
  return `
    <div class="dog-row" data-id="${esc(d.id)}" role="button" tabindex="0"
         style="display:flex;align-items:center;gap:10px;padding:10px 2px;border-top:1px solid var(--border,#e2e6ec);cursor:pointer;">
      <div style="flex:1;min-width:0;">
        <strong>${esc(d.call_name || '(unnamed)')}</strong>
        ${d.registered_name ? `<span class="faint"> — ${esc(d.registered_name)}</span>` : ''}
        <div class="muted" style="font-size:13px;">${esc([d.breed, sex.label].filter(Boolean).join(' • '))}</div>
      </div>
      <span class="badge ${esc(status.badge)}">${esc(status.label)}</span>
    </div>`;
}

// Dogs grouped by litter (nickname + parents on the group header, with a
// litter-wide weigh-in button), then everyone else.
async function renderDogs() {
  const dogs = await getDogs();
  const list = document.getElementById('dog-list');
  if (!dogs.length) {
    list.innerHTML = '<p class="faint">No dogs synced yet.</p>';
    return;
  }
  const litters = new Map();
  const others = [];
  for (const d of dogs) {
    if (!d.litter_id) { others.push(d); continue; }
    if (!litters.has(d.litter_id)) litters.set(d.litter_id, []);
    litters.get(d.litter_id).push(d);
  }
  const groups = [...litters.entries()]
    .map(([id, pups]) => ({ id, pups, nickname: pups[0].litter_nickname, parents: parentsLabel(pups[0]) }))
    .sort((a, b) => String(a.nickname || '').localeCompare(String(b.nickname || ''), undefined, { sensitivity: 'base' }));

  list.innerHTML = groups.map((g) => `
    <div style="margin-top:14px;">
      <div style="display:flex;align-items:center;gap:10px;">
        <div style="flex:1;min-width:0;">
          <strong>${esc(g.nickname || 'Litter')}</strong>
          ${g.parents ? `<div class="muted" style="font-size:13px;">${esc(g.parents)}</div>` : ''}
        </div>
        <button class="btn" data-weigh="${esc(g.id)}">⚖ Weigh litter</button>
      </div>
      ${g.pups.map(dogRowHtml).join('')}
    </div>`).join('')
    + (others.length ? `
    <div style="margin-top:14px;">
      ${groups.length ? '<strong>Other dogs</strong>' : ''}
      ${others.map((d) => {
        const parents = parentsLabel(d);
        return dogRowHtml(d).replace('</strong>',
          `</strong>${parents ? `<span class="faint"> · ${esc(parents)}</span>` : ''}`);
      }).join('')}
    </div>` : '');

  for (const row of list.querySelectorAll('.dog-row')) {
    const open = () => {
      const dog = dogs.find((d) => d.id === row.dataset.id);
      if (dog) openLogModal(dog);
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  }
  for (const btn of list.querySelectorAll('[data-weigh]')) {
    btn.addEventListener('click', () => {
      const g = groups.find((x) => x.id === btn.dataset.weigh);
      if (g) openWeighLitterModal(g);
    });
  }
}

async function renderPending() {
  const pending = await getPendingEvents();
  show('pending-card', pending.length > 0);
  if (!pending.length) return;
  const list = document.getElementById('pending-list');
  list.innerHTML = pending.map(({ event, dogName, typeLabel }) => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 2px;border-top:1px solid var(--border,#e2e6ec);">
      <div style="flex:1;min-width:0;">
        <strong>${esc(dogName)}</strong> — ${esc(typeLabel)}
        <span class="muted">${esc(event.event_date)}</span>
      </div>
      <button class="btn" data-del="${esc(event.id)}" title="Remove before sending">✕</button>
    </div>`).join('');
  for (const btn of list.querySelectorAll('[data-del]')) {
    btn.addEventListener('click', async () => {
      try {
        await deletePendingEvent(btn.dataset.del);
        await Promise.all([renderPending(), renderSyncStatus()]);
      } catch (e) {
        flash(e.message || String(e), 'err');
      }
    });
  }
}

// --- Log-event modal --------------------------------------------------------

// Renders one details input per vocab field. `combobox` renders as plain text
// (suggest lists live in the main app); `select` options may be plain strings.
function detailFieldsHtml(typeDef) {
  if (!typeDef.fields.length) return '<p class="faint" style="margin:0;">Nothing extra for this type — the title says it all.</p>';
  return typeDef.fields.map((f) => {
    let input;
    if (f.type === 'textarea') {
      input = `<textarea data-detail="${esc(f.key)}" rows="2"></textarea>`;
    } else if (f.type === 'select') {
      const opts = (f.options || []).map((o) => {
        const value = o.value ?? o;
        const label = o.label ?? o;
        return `<option value="${esc(value)}">${esc(label)}</option>`;
      }).join('');
      input = `<select data-detail="${esc(f.key)}"><option value=""></option>${opts}</select>`;
    } else if (f.type === 'number') {
      input = `<input data-detail="${esc(f.key)}" type="number" ${f.step ? `step="${esc(f.step)}"` : ''}>`;
    } else if (f.type === 'date') {
      input = `<input data-detail="${esc(f.key)}" type="date">`;
    } else {
      input = `<input data-detail="${esc(f.key)}" type="text">`;
    }
    return `<div class="field"><label>${esc(f.label)}</label>${input}</div>`;
  }).join('');
}

async function openLogModal(dog) {
  const types = eventTypesFor('dog').filter((t) => ASSISTANT_EVENT_TYPES.includes(t.value));
  const defaultType = 'weight_check';
  const recent = (await getTimeline(dog.id)).slice(0, 5);
  const context = [dog.litter_nickname, parentsLabel(dog)].filter(Boolean).join(' — ');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="max-width:440px;">
      <h2 style="margin-top:0;">Log for ${esc(dog.call_name || '(unnamed)')}</h2>
      ${context ? `<p class="muted" style="margin-top:-8px;">${esc(context)}</p>` : ''}
      <div class="field field-wide">
        <label>What happened?</label>
        <select id="log-type">${types.map((t) => `<option value="${esc(t.value)}" ${t.value === defaultType ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Date</label><input id="log-date" type="date" value="${esc(todayYMD())}"></div>
      <div class="field" id="log-end-wrap" style="display:none;"><label>End date (optional)</label><input id="log-end" type="date"></div>
      <div class="field field-wide"><label>Title</label><input id="log-title" type="text"></div>
      <div id="log-details"></div>
      <div id="log-error"></div>
      <div class="form-actions">
        <button class="btn btn-primary" id="log-save">Save</button>
        <button class="btn" data-act="cancel">Cancel</button>
      </div>
      ${recent.length ? `
        <h2 style="font-size:15px;">Recent</h2>
        ${recent.map((e) => `<div class="muted" style="font-size:13px;padding:2px 0;">${esc(e.event_date)} — ${esc(descriptor(EVENT_TYPES, e.event_type).label)}: ${esc(e.title || '')}${e.pending ? ' <em>(not sent yet)</em>' : ''}</div>`).join('')}` : ''}
    </div>`;
  document.body.appendChild(overlay);

  const typeSel = overlay.querySelector('#log-type');
  const titleInput = overlay.querySelector('#log-title');
  const detailsBox = overlay.querySelector('#log-details');
  const applyType = () => {
    const typeDef = descriptor(EVENT_TYPES, typeSel.value);
    // Auto-fill the title with the type label unless the kid typed their own.
    if (!titleInput.value || titleInput.value === titleInput.dataset.auto) {
      titleInput.value = typeDef.label;
    }
    titleInput.dataset.auto = typeDef.label;
    detailsBox.innerHTML = detailFieldsHtml(typeDef);
    overlay.querySelector('#log-end-wrap').style.display = typeDef.duration === 'span' ? '' : 'none';
  };
  applyType();
  typeSel.addEventListener('change', applyType);

  overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#log-save').addEventListener('click', async () => {
    const details = {};
    for (const el of detailsBox.querySelectorAll('[data-detail]')) {
      const val = el.value.trim();
      if (val !== '') details[el.dataset.detail] = el.type === 'number' ? Number(val) : val;
    }
    const eventDate = overlay.querySelector('#log-date').value;
    try {
      // Same soft warning as the main app's event form: a weigh-in below the
      // previous one deserves a second look, never a hard block.
      if (typeSel.value === 'weight_check') {
        const drop = await weightDropWarning(dog, { event_date: eventDate, details });
        if (drop && !(await confirmModal({
          title: 'Weight decreased',
          message: `${drop}\n\nSave anyway?`,
          confirmLabel: 'Save anyway'
        }))) return;
      }
      await createPendingEvent({
        subject_id: dog.id,
        event_type: typeSel.value,
        event_date: eventDate,
        event_end_date: overlay.querySelector('#log-end').value || null,
        title: titleInput.value.trim(),
        details
      });
      overlay.remove();
      flash(`Saved — waiting to send.`);
      await Promise.all([renderPending(), renderSyncStatus()]);
    } catch (e) {
      overlay.querySelector('#log-error').innerHTML = `<div class="inline-error">${esc(e.message || String(e))}</div>`;
    }
  });
}

// One dog's would-be weigh-in vs its true preceding entry (synced + pending).
// Returns a human-readable drop line, or null when the weight didn't decrease.
async function weightDropWarning(dog, { event_date, details }) {
  const newOz = weightTotalOz(details);
  if (newOz == null) return null;
  const newKey = weighKey({ event_date, details, created_at: new Date().toISOString() });
  const prior = await getPriorWeighIn(dog.id, newKey);
  if (!prior || newOz >= weightTotalOz(prior.details)) return null;
  return `• ${dog.call_name || '(unnamed)'}: ${fmtWeight(details)} — down from ${fmtWeight(prior.details)}${prior.event_date ? ` on ${prior.event_date}` : ''}`;
}

// --- Litter weigh-in --------------------------------------------------------
// The whole litter on one screen: date + AM/PM once, a lbs/oz row per pup, one
// save. Mirrors the main app's cascade weight entry, including the collected
// weight-drop prompt before anything is written.
function openWeighLitterModal(group) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="max-width:480px;">
      <h2 style="margin-top:0;">Weigh ${esc(group.nickname || 'litter')}</h2>
      ${group.parents ? `<p class="muted" style="margin-top:-8px;">${esc(group.parents)}</p>` : ''}
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <div class="field"><label>Date</label><input id="wl-date" type="date" value="${esc(todayYMD())}"></div>
        <div class="field"><label>AM/PM</label>
          <select id="wl-time"><option value=""></option><option>AM</option><option>PM</option></select></div>
      </div>
      <table class="data" style="width:100%;">
        <thead><tr><th>Pup</th><th style="width:80px;">lbs</th><th style="width:80px;">oz</th></tr></thead>
        <tbody>
          ${group.pups.map((d) => `
            <tr>
              <td>${esc(d.call_name || '(unnamed)')}</td>
              <td><input data-lbs="${esc(d.id)}" type="number" inputmode="decimal" style="width:70px;"></td>
              <td><input data-oz="${esc(d.id)}" type="number" step="0.1" inputmode="decimal" style="width:70px;"></td>
            </tr>`).join('')}
        </tbody>
      </table>
      <div id="wl-error"></div>
      <div class="form-actions">
        <button class="btn btn-primary" id="wl-save">Save all</button>
        <button class="btn" data-act="cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => overlay.remove());

  overlay.querySelector('#wl-save').addEventListener('click', async () => {
    const event_date = overlay.querySelector('#wl-date').value;
    const time_of_day = overlay.querySelector('#wl-time').value;
    const entries = [];
    for (const dog of group.pups) {
      const lbs = overlay.querySelector(`[data-lbs="${CSS.escape(dog.id)}"]`).value.trim();
      const oz = overlay.querySelector(`[data-oz="${CSS.escape(dog.id)}"]`).value.trim();
      const details = {};
      if (lbs !== '') details.weight_lbs = Number(lbs);
      if (oz !== '') details.weight_oz = Number(oz);
      if (time_of_day) details.time_of_day = time_of_day;
      if (weightTotalOz(details) == null) continue; // blank row = not weighed today
      entries.push({ dog, details });
    }
    const errBox = overlay.querySelector('#wl-error');
    if (!entries.length) {
      errBox.innerHTML = '<div class="inline-error">Enter at least one weight.</div>';
      return;
    }
    if (!event_date) {
      errBox.innerHTML = '<div class="inline-error">Date is required.</div>';
      return;
    }
    try {
      const drops = [];
      for (const { dog, details } of entries) {
        const drop = await weightDropWarning(dog, { event_date, details });
        if (drop) drops.push(drop);
      }
      if (drops.length && !(await confirmModal({
        title: `Weight decreased${drops.length > 1 ? ` (${drops.length} pups)` : ''}`,
        message: `${drops.join('\n')}\n\nSave anyway?`,
        confirmLabel: 'Save anyway'
      }))) return;
      for (const { dog, details } of entries) {
        await createPendingEvent({
          subject_id: dog.id,
          event_type: 'weight_check',
          event_date,
          event_end_date: null,
          title: 'Weight check',
          details
        });
      }
      overlay.remove();
      flash(`Logged weights for ${entries.length} pup(s) — waiting to send.`);
      await Promise.all([renderPending(), renderSyncStatus()]);
    } catch (e) {
      errBox.innerHTML = `<div class="inline-error">${esc(e.message || String(e))}</div>`;
    }
  });
}

// --- Buttons ----------------------------------------------------------------

document.getElementById('dbx-connect').addEventListener('click', async () => {
  try {
    await beginDropboxAuth();
  } catch (e) {
    flash(e.message || String(e), 'err');
  }
});

async function withBusy(buttonId, action) {
  const btn = document.getElementById(buttonId);
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Working…';
  try {
    await action();
  } catch (e) {
    flash(e.message || String(e), 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

document.getElementById('btn-sync').addEventListener('click', () => withBusy('btn-sync', async () => {
  const feed = await dropboxDownloadJson(DROPBOX_PATHS.feed);
  if (!feed) {
    flash('No dogs in Dropbox yet — ask the owner to "Push to Dropbox" first.', 'err');
    return;
  }
  const result = await syncFromFeed(feed);
  flash(`Synced ${result.dogs} dog(s) and ${result.events} event(s).`);
  await renderAll();
}));

document.getElementById('btn-send').addEventListener('click', () => withBusy('btn-send', async () => {
  const outbox = await buildOutbox();
  if (!outbox.events.length) {
    flash('Nothing to send.');
    return;
  }
  await dropboxUploadJson(DROPBOX_PATHS.outbox, outbox);
  flash(`Sent ${outbox.events.length} update(s). They stay listed until the owner imports them and pushes a fresh feed.`);
}));

// --- Boot -------------------------------------------------------------------

completeDropboxAuth()
  .then((handled) => { if (handled) flash('Dropbox connected.'); })
  .catch((e) => flash(e.message || String(e), 'err'))
  .finally(renderAll);
