// dog-cards.js — Sharing → Dog cards (Shared Dogs Plan §3; End-State guide §36).
// Two halves: SEND (tick dogs, get a link, a code or a file) and RECEIVE (paste or
// open one, see exactly what it would do, then add or update). The rules are all in
// data/dogCard.js; this page only asks and shows. Reached also from a dog's page
// (Send a dog card → ?dog=<id>, that dog ticked and its card made) and from the Dogs
// page (Add dogs from a card → #receive). A card link opens here (#dogcard=…).
//
// Every value shown came from her records or from another breeder's card, so all
// hand-built HTML goes through esc().
import {
  buildDogCard, encodeDogCard, dogCardLink, dogCardFileName, decodeDogCard, previewDogCard,
  applyDogCard, extractDogCardPayload, sendableDogs, DogCardError, DOG_FIELDS, ANCESTOR_GENERATIONS
} from '../data/dogCard.js';
import { dogName } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { ownKennels, getActiveKennelId } from '../data/kennelScope.js';
import { editionFlags } from '../data/editionConfig.js';
import { esc, param } from '../assets/ui.js';
import { descriptor, DOG_STATUS, OWNERSHIP_TYPE, SEX } from '../data/vocab.js';

const sendEl = document.getElementById('send-body');
const receiveEl = document.getElementById('receive-body');
const errEl = document.getElementById('page-error');
const PAGE_URL = new URL('./dog-cards.html', import.meta.url).href;

const showError = (el, msg) => { el.innerHTML = `<div class="inline-error">${esc(msg)}</div>`; };
const label = (vocab, v) => descriptor(vocab, v)?.label || v || '';

async function copyValue(value, inputEl, btn) {
  const was = btn.textContent;
  try { await navigator.clipboard.writeText(value); btn.textContent = 'Copied ✓'; } catch { inputEl.select(); btn.textContent = 'Press ⌘/Ctrl+C'; }
  setTimeout(() => { btn.textContent = was; }, 2000);
}

// --- Send ----------------------------------------------------------------------

const send = { dogs: [], kennels: [], contacts: new Map(), picked: new Set(), filter: '' };

async function renderSend() {
  send.dogs = (await sendableDogs()).sort((a, b) => dogName(a).localeCompare(dogName(b)));
  send.kennels = await ownKennels();
  for (const c of await contactRepo.getAll({ includeArchived: true })) send.contacts.set(c.id, c);
  const preset = param('dog');
  if (preset && send.dogs.some((d) => d.id === preset)) send.picked.add(preset);

  if (!send.kennels.length) {
    sendEl.innerHTML = '<p class="muted">Set up your kennel first: a card is sent from one of your own kennels.</p>';
    return;
  }
  if (!send.dogs.length) {
    sendEl.innerHTML = '<p class="muted">No dogs to send yet.</p>';
    return;
  }
  const coOwners = [...new Set(send.dogs.flatMap((d) => d.co_owner_contact_ids || []))]
    .map((id) => send.contacts.get(id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  const active = getActiveKennelId();
  sendEl.innerHTML = `
    <p class="field-hint" style="margin-top:0;">Tick the dogs to send. Each goes with up to ${ANCESTOR_GENERATIONS} generations of its ancestors, and its health tests and titles.</p>
    <div class="form-grid">
      ${send.kennels.length > 1 ? `<div class="field"><label>Send from</label><select id="s-kennel">${send.kennels.map((k) => `<option value="${esc(k.id)}"${k.id === active ? ' selected' : ''}>${esc(k.kennel_name)}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label>Show</label><select id="s-filter">
        <option value="">All my dogs</option>
        ${coOwners.map((c) => `<option value="${esc(c.id)}">Co-owned with ${esc(c.name)}</option>`).join('')}
      </select></div>
    </div>
    <div class="form-actions" style="margin-top:6px;">
      <button class="btn btn-sm" type="button" id="s-all">Tick all shown</button>
      <button class="btn btn-sm" type="button" id="s-none">Untick all</button>
    </div>
    <div id="s-list"></div>
    <div class="form-actions">
      <button class="btn btn-primary" type="button" id="s-make">Make the card</button>
      <span class="muted" id="s-count"></span>
    </div>
    <div id="s-error"></div>
    <div id="s-out"></div>`;

  sendEl.querySelector('#s-filter').addEventListener('change', (e) => { send.filter = e.target.value; renderSendList(); });
  sendEl.querySelector('#s-all').addEventListener('click', () => { for (const d of shownDogs()) send.picked.add(d.id); renderSendList(); });
  sendEl.querySelector('#s-none').addEventListener('click', () => { send.picked.clear(); renderSendList(); });
  sendEl.querySelector('#s-make').addEventListener('click', makeCard);
  renderSendList();
  if (preset && send.picked.size) makeCard();
}

const shownDogs = () => (send.filter ? send.dogs.filter((d) => (d.co_owner_contact_ids || []).includes(send.filter)) : send.dogs);

function renderSendList() {
  const rows = shownDogs();
  sendEl.querySelector('#s-list').innerHTML = rows.length ? `<div class="table-scroll"><table class="data">
    <thead><tr><th></th><th>Dog</th><th>Sex</th><th>Status</th><th>Ownership</th></tr></thead>
    <tbody>${rows.map((d) => `<tr>
      <td><input type="checkbox" data-dog="${esc(d.id)}"${send.picked.has(d.id) ? ' checked' : ''} aria-label="Send ${esc(dogName(d))}"></td>
      <td><strong>${esc(dogName(d))}</strong>${d.registered_name && d.call_name ? `<br><span class="faint">${esc(d.registered_name)}</span>` : ''}</td>
      <td>${esc(label(SEX, d.sex))}</td><td>${esc(label(DOG_STATUS, d.status))}</td><td>${esc(label(OWNERSHIP_TYPE, d.ownership_type))}</td>
    </tr>`).join('')}</tbody></table></div>` : '<p class="muted">No dogs match.</p>';
  for (const box of sendEl.querySelectorAll('input[data-dog]')) {
    box.addEventListener('change', () => { if (box.checked) send.picked.add(box.dataset.dog); else send.picked.delete(box.dataset.dog); countPicked(); });
  }
  countPicked();
}

function countPicked() {
  const n = send.picked.size;
  sendEl.querySelector('#s-count').textContent = n ? `${n} dog${n === 1 ? '' : 's'} ticked` : '';
}

async function makeCard() {
  const errBox = sendEl.querySelector('#s-error');
  const out = sendEl.querySelector('#s-out');
  errBox.innerHTML = '';
  out.innerHTML = '';
  let card;
  try {
    card = await buildDogCard({ fromKennelId: sendEl.querySelector('#s-kennel')?.value || send.kennels[0].id, dogIds: [...send.picked] });
  } catch (e) {
    showError(errBox, e instanceof DogCardError ? e.message : (e.message || String(e)));
    return;
  }
  const code = encodeDogCard(card);
  const link = dogCardLink(card, PAGE_URL);
  const sent = card.dogs.filter((d) => d.sent);
  const ancestors = card.dogs.length - sent.length;
  const tests = sent.reduce((n, d) => n + d.events.length, 0);
  const long = link.length > 6000;
  out.innerHTML = `
    <div class="card" style="margin-top:12px;">
      <p style="margin-top:0;"><strong>${sent.length} dog${sent.length === 1 ? '' : 's'}</strong>, ${ancestors} ancestor${ancestors === 1 ? '' : 's'} and ${tests} test${tests === 1 ? '' : 's'} and title${tests === 1 ? '' : 's'}.</p>
      ${long ? '<p class="field-hint"><strong>This card is long:</strong> a message app may cut the link short. Save it as a file and send the file instead.</p>' : ''}
      <div class="field"><label>Card link <span class="faint" style="font-weight:normal;">for a breeder on the same KennelOS edition</span></label>
        <input id="s-link" type="text" readonly value="${esc(link)}" onclick="this.select()"></div>
      <div class="field" style="margin-top:10px;"><label>Card code <span class="faint" style="font-weight:normal;">works with any KennelOS install</span></label>
        <textarea id="s-code" readonly rows="3" onclick="this.select()">${esc(code)}</textarea>
        <span class="field-hint">She pastes it into <strong>Sharing → Dog cards → Add dogs from a card</strong>, or opens the file there.</span></div>
      <div class="form-actions">
        <button class="btn btn-primary btn-sm" type="button" data-act="file">Save as a file</button>
        <button class="btn btn-sm" type="button" data-act="link">Copy link</button>
        <button class="btn btn-sm" type="button" data-act="code">Copy code</button>
      </div>
      <details style="margin-top:10px;">
        <summary class="muted" style="cursor:pointer;">What's on the card</summary>
        <p class="field-hint" style="margin-top:8px;">For each dog: ${esc(DOG_FIELDS.map((f) => f.label.toLowerCase()).join(', '))}, its status, sire, dam and breeder kennel, and its genetic tests, OFA / PennHIP, breed-specific tests and titles (no notes). Its ancestors go with the same details and no tests. Your kennel's name, prefix, location and website. <strong>Never:</strong> notes, contacts, sales, prices, litters, heats, vaccinations, documents, planned tests or website and waitlist settings.</p>
        <p class="field-hint">${sent.map((d) => esc(d.callName || d.registeredName)).join(', ')}</p>
      </details>
    </div>`;
  out.querySelector('[data-act="link"]').addEventListener('click', (e) => copyValue(link, out.querySelector('#s-link'), e.currentTarget));
  out.querySelector('[data-act="code"]').addEventListener('click', (e) => copyValue(code, out.querySelector('#s-code'), e.currentTarget));
  out.querySelector('[data-act="file"]').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([code], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = dogCardFileName(card);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

// --- Receive -------------------------------------------------------------------

function renderPaste(prefill = '') {
  receiveEl.innerHTML = `
    <p class="field-hint" style="margin-top:0;">Paste the card link or code another breeder sent you, or open the file. Nothing is saved until you've seen exactly what it would do.</p>
    <div class="field"><label>Card link or code</label>
      <textarea id="r-input" rows="4" placeholder="Paste the link or code here…">${esc(prefill)}</textarea></div>
    <div class="field" style="margin-top:8px;"><label>Or open a card file</label>
      <input id="r-file" type="file" accept=".kosdogs,.txt,text/plain"></div>
    <div id="r-error"></div>
    <div class="form-actions"><button class="btn btn-primary btn-sm" type="button" id="r-preview">Preview</button></div>`;
  receiveEl.querySelector('#r-preview').addEventListener('click', () => preview(receiveEl.querySelector('#r-input').value));
  receiveEl.querySelector('#r-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (file) preview(await file.text());
  });
  if (prefill) preview(prefill);
}

const ACTION_TEXT = { create: 'New', update: 'Update', unchanged: 'Up to date', adopt: 'In your pedigrees: becomes one of your dogs' };

async function preview(raw) {
  const errBox = receiveEl.querySelector('#r-error');
  if (errBox) errBox.innerHTML = '';
  let card, p;
  try {
    card = decodeDogCard(raw);
    p = await previewDogCard(card);
  } catch (e) {
    showError(errBox || errEl, e instanceof DogCardError ? e.message : (e.message || String(e)));
    return;
  }
  const from = card.kennels.find((k) => k.ref === card.from);

  if (p.from.action === 'own') {
    receiveEl.innerHTML = `<div class="card"><p><strong>${esc(from.kennelName)}</strong> is one of your own kennels, so there is nothing to add. To set up another device of yours, restore a backup or turn on cloud sync instead.</p></div>
      <div class="form-actions"><button class="btn btn-sm" type="button" id="r-again">Done</button></div>`;
    receiveEl.querySelector('#r-again').addEventListener('click', () => renderPaste());
    return;
  }

  const kennels = await ownKennels();
  const contacts = (await contactRepo.getAll()).sort((a, b) => a.name.localeCompare(b.name));
  const fromKennelId = p.from.existing?.id || null;
  const ofKennel = fromKennelId ? contacts.filter((c) => c.kennel_id === fromKennelId) : [];
  const anyNew = p.dogs.some((d) => d.action === 'create' || d.action === 'adopt');
  const active = getActiveKennelId();

  const kennelLine = p.from.action === 'create'
    ? `<p>From <strong>${esc(from.kennelName)}</strong>, added as an outside kennel${from.location ? ` <span class="faint">(${esc(from.location)})</span>` : ''}.</p>
       ${p.from.candidates.length ? `<p class="field-hint">You may already have this kennel, typed in by hand:</p>
         <label class="check-inline" style="display:block;"><input type="radio" name="r-kennel-link" value="" checked> Add it as a new kennel</label>
         ${p.from.candidates.map((k) => `<label class="check-inline" style="display:block;"><input type="radio" name="r-kennel-link" value="${esc(k.id)}"> Use my “${esc(k.kennel_name)}”</label>`).join('')}` : ''}`
    : `<p>From <strong>${esc(from.kennelName)}</strong>${p.from.action === 'update' ? ', whose details on your device will be updated' : ''}.</p>`;

  const holdingHtml = anyNew ? `
    <div class="card" style="margin-top:10px;">
      <p style="margin-top:0;"><strong>How do you hold the new dogs?</strong></p>
      <label class="check-inline" style="display:block;"><input type="radio" name="r-holding" value="co_owned" checked> Co-owned with</label>
      <label class="check-inline" style="display:block;"><input type="radio" name="r-holding" value="external"> Owned by them: outside dogs I refer to</label>
      <div class="form-grid" style="margin-top:8px;">
        <div class="field"><label id="r-contact-label">Co-owned with</label><select id="r-contact">
          <option value="">New contact…</option>
          ${[...ofKennel, ...contacts.filter((c) => !ofKennel.includes(c))].map((c, i) => `<option value="${esc(c.id)}"${i === 0 && ofKennel.length ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select></div>
        <div class="field" id="r-newname-field"${ofKennel.length ? ' hidden' : ''}><label>New contact's name</label><input id="r-newname" type="text" value="${esc(from.kennelName)}"></div>
        ${kennels.length > 1 ? `<div class="field" id="r-kennel-field"><label>In my kennel</label><select id="r-kennel">${kennels.map((k) => `<option value="${esc(k.id)}"${k.id === active ? ' selected' : ''}>${esc(k.kennel_name)}</option>`).join('')}</select></div>` : ''}
      </div>
    </div>` : '';

  const changeText = (d) => {
    if (d.action === 'update') {
      const parts = d.changes.map((c) => c.label);
      if (d.events.added) parts.push(d.events.added === 1 ? '1 new test or title' : `${d.events.added} new tests and titles`);
      if (d.events.changed) parts.push(`${d.events.changed} changed`);
      return parts.join(', ');
    }
    if (d.action === 'create' && d.events.added) return d.events.added === 1 ? 'with 1 test or title' : `with ${d.events.added} tests and titles`;
    return '';
  };
  const rowChoice = (d) => {
    if (d.action !== 'create' && d.action !== 'adopt') return '';
    const pid = esc(d.cardDog.publicId);
    return `<select data-pick="${pid}">
        <option value="">Add as new</option>
        ${d.candidates.map((c) => `<option value="link:${esc(c.id)}">Same as my ${esc(dogName(c))}</option>`).join('')}
        <option value="skip">Leave out</option>
      </select>
      <select data-lives="${pid}" class="r-lives"><option value="them">Lives with them</option><option value="me">Lives with me</option></select>`;
  };

  receiveEl.innerHTML = `
    <div class="card">${kennelLine}</div>
    ${holdingHtml}
    <div class="table-scroll" style="margin-top:10px;"><table class="data">
      <thead><tr><th>Dog</th><th>What happens</th><th></th></tr></thead>
      <tbody>${p.dogs.map((d) => `<tr>
        <td><strong>${esc(d.cardDog.callName || d.cardDog.registeredName)}</strong>${d.cardDog.registeredName && d.cardDog.callName ? `<br><span class="faint">${esc(d.cardDog.registeredName)}</span>` : ''}<br><span class="faint">${esc([label(SEX, d.cardDog.sex), d.cardDog.breed].filter(Boolean).join(' · '))}</span></td>
        <td>${esc(ACTION_TEXT[d.action])}${changeText(d) ? `<br><span class="faint">${esc(changeText(d))}</span>` : ''}${d.candidates.length ? '<br><span class="faint">You may already have this dog: pick it to link them.</span>' : ''}</td>
        <td>${rowChoice(d)}</td>
      </tr>`).join('')}</tbody></table></div>
    <p class="field-hint">${p.ancestors.total ? `${p.ancestors.total} ancestor${p.ancestors.total === 1 ? '' : 's'}: ${p.ancestors.added} added for pedigrees, ${p.ancestors.matched} you already have.` : 'No ancestors on this card.'} Your own notes, plans and ownership of dogs you already have are never changed.</p>
    <div id="r-error"></div>
    <div class="form-actions">
      <button class="btn btn-primary" type="button" id="r-apply">${anyNew ? 'Add the dogs' : 'Update the dogs'}</button>
      <button class="btn" type="button" id="r-cancel">Cancel</button>
    </div>`;

  const contactSel = receiveEl.querySelector('#r-contact');
  const syncHolding = () => {
    const holding = receiveEl.querySelector('input[name="r-holding"]:checked')?.value;
    if (!holding) return;
    receiveEl.querySelector('#r-contact-label').textContent = holding === 'external' ? 'Owned by' : 'Co-owned with';
    const kf = receiveEl.querySelector('#r-kennel-field');
    if (kf) kf.hidden = holding === 'external';
    for (const s of receiveEl.querySelectorAll('.r-lives')) s.hidden = holding === 'external';
  };
  for (const r of receiveEl.querySelectorAll('input[name="r-holding"]')) r.addEventListener('change', syncHolding);
  contactSel?.addEventListener('change', () => { receiveEl.querySelector('#r-newname-field').hidden = Boolean(contactSel.value); });
  syncHolding();
  receiveEl.querySelector('#r-cancel').addEventListener('click', () => renderPaste());
  receiveEl.querySelector('#r-apply').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;
    const dogs = {};
    for (const s of receiveEl.querySelectorAll('select[data-pick]')) {
      const v = s.value;
      const pid = s.dataset.pick;
      dogs[pid] = {
        skip: v === 'skip',
        linkToId: v.startsWith('link:') ? v.slice(5) : null,
        livesWith: receiveEl.querySelector(`select[data-lives="${CSS.escape(pid)}"]`)?.value || 'them'
      };
    }
    try {
      const r = await applyDogCard(card, {
        fromLinkToId: receiveEl.querySelector('input[name="r-kennel-link"]:checked')?.value || null,
        holding: receiveEl.querySelector('input[name="r-holding"]:checked')?.value || 'co_owned',
        contactId: contactSel?.value || null,
        newContactName: receiveEl.querySelector('#r-newname')?.value || '',
        kennelId: receiveEl.querySelector('#r-kennel')?.value || kennels[0]?.id || null,
        dogs
      });
      const parts = [
        r.created && `${r.created} added`, r.linked && `${r.linked} linked to yours`, r.updated && `${r.updated} updated`,
        r.unchanged && `${r.unchanged} already up to date`, r.ancestorsAdded && `${r.ancestorsAdded} ancestor${r.ancestorsAdded === 1 ? '' : 's'} added`,
        (r.eventsAdded || r.eventsUpdated) && `${r.eventsAdded + r.eventsUpdated} tests and titles`
      ].filter(Boolean);
      receiveEl.innerHTML = `<div class="card"><p style="margin-top:0;"><strong>Done.</strong> From ${esc(r.kennel.kennel_name)}: ${esc(parts.join(', ') || 'nothing to change')}.</p>
        <p class="field-hint">When ${esc(r.kennel.kennel_name)} sends a card again, open it here the same way: the same dogs update.</p></div>
        <div class="form-actions"><a class="btn btn-primary btn-sm" href="dogs.html">Open Dogs</a><button class="btn btn-sm" type="button" id="r-again">Add another card</button></div>`;
      receiveEl.querySelector('#r-again').addEventListener('click', () => renderPaste());
    } catch (err) {
      btn.disabled = false;
      showError(receiveEl.querySelector('#r-error'), err instanceof DogCardError ? err.message : (err.message || String(err)));
    }
  });
}

// --- Start -----------------------------------------------------------------------

function openFromHash() {
  if (location.hash === '#receive') {
    history.replaceState(null, '', location.pathname + location.search);
    renderPaste();
    document.getElementById('receive').scrollIntoView({ block: 'start' });
    return true;
  }
  const payload = extractDogCardPayload(location.hash);
  if (!payload) return false;
  history.replaceState(null, '', location.pathname + location.search);
  renderPaste(payload);
  document.getElementById('receive').scrollIntoView({ block: 'start' });
  return true;
}

if (!editionFlags.dogCards) {
  sendEl.innerHTML = '<p class="muted">Dog cards are part of KennelOS Pro.</p>';
  receiveEl.innerHTML = '';
} else {
  renderSend().catch((e) => showError(errEl, e.message || String(e)));
  if (!openFromHash()) renderPaste();
  window.addEventListener('hashchange', openFromHash);
}
