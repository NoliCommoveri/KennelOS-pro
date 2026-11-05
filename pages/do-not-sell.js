// do-not-sell.js — her do-not-sell list (End-State guide §29; rules in
// data/doNotSell.js). A tab of Contacts: people she won't sell to, added by hand,
// moved from a contact (who then leaves the Contacts list), or from a waitlist
// application (the family's page). Each row says which open applications match
// it. Taking someone off archives the row. Pro-only page (proPages.js).
import { doNotSellRepo } from '../data/doNotSellRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { waitlistEntryRepo } from '../data/waitlistEntryRepo.js';
import { entryDoNotSellMatches, doNotSellReason, listedContactIds } from '../data/doNotSell.js';
import { entryName } from '../data/waitlistRules.js';
import { editionFlags } from '../data/editionConfig.js';
import { esc, fmtDate, confirmModal } from '../assets/ui.js';
import { formModal } from '../assets/waitlistUI.js';

const els = {
  body: document.getElementById('dns-body'),
  error: document.getElementById('page-error'),
  add: document.getElementById('dns-add'),
  addContact: document.getElementById('dns-add-contact')
};
const ctx = { listings: [], contacts: [], entries: [], search: '' };
const OPEN = ['applied', 'approved', 'active'];
const showError = (msg) => { els.error.innerHTML = `<div class="inline-error">${esc(msg)}</div>`; };
const fail = (err) => showError(err.message || String(err));

async function load() {
  const [listings, contacts, entries] = await Promise.all([
    doNotSellRepo.getAll(),
    contactRepo.getAll({ includeArchived: true }),
    editionFlags.waitlist ? waitlistEntryRepo.getAll() : []
  ]);
  Object.assign(ctx, { listings, contacts, entries: entries.filter((e) => OPEN.includes(e.status)) });
}

// The open applications (and families on the list) that match one listing.
function matchesFor(listing) {
  return ctx.entries
    .map((e) => ({ e, m: entryDoNotSellMatches(e, [listing])[0] }))
    .filter((x) => x.m);
}

function listingHtml(l) {
  const contact = l.contact_id ? ctx.contacts.find((c) => c.id === l.contact_id) : null;
  const hits = matchesFor(l);
  const contactsById = new Map(ctx.contacts.map((c) => [c.id, c]));
  const facts = [l.email, l.phone].filter(Boolean).map(esc).join(' · ');
  return `<section class="card" data-id="${esc(l.id)}">
      <div class="row-between" style="align-items:flex-start;gap:8px;">
        <div>
          <strong>${esc(l.name || l.email || l.phone)}</strong>
          ${facts ? `<div class="muted">${facts}</div>` : ''}
          ${l.reason ? `<p style="margin:6px 0 0;">${esc(l.reason).replace(/\n/g, '<br>')}</p>` : ''}
          <div class="faint" style="margin-top:4px;">Added ${esc(fmtDate(l.added_date))}${contact ? ` · from contact <a href="contact.html?id=${encodeURIComponent(contact.id)}">${esc(contact.name)}</a>` : ''}${l.source_entry_id ? ` · from <a href="waitlist-entry.html?id=${encodeURIComponent(l.source_entry_id)}">their application</a>` : ''}</div>
          ${hits.length ? `<div class="row-flags">${hits.map(({ e, m }) => `<a class="badge badge-red" href="waitlist-entry.html?id=${encodeURIComponent(e.id)}">${esc(entryName(e, contactsById.get(e.contact_id)))} · ${esc(doNotSellReason(m).toLowerCase())}</a>`).join('')}</div>` : ''}
        </div>
        <div class="pill-row" style="flex:0 0 auto;">
          <button class="btn btn-sm" data-edit="${esc(l.id)}">Edit</button>
          <button class="btn btn-sm" data-off="${esc(l.id)}">Take off…</button>
        </div>
      </div>
    </section>`;
}

function render() {
  const q = ctx.search.trim().toLowerCase();
  const shown = ctx.listings
    .filter((l) => !q || `${l.name} ${l.email} ${l.phone} ${l.reason}`.toLowerCase().includes(q))
    .sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email)));
  els.body.innerHTML = `
    <div class="list-toolbar" style="margin-bottom:12px;"><input type="search" id="dns-search" placeholder="Search name, email, phone, reason…" value="${esc(ctx.search)}" aria-label="Search the list"></div>
    ${shown.length ? shown.map(listingHtml).join('') : `<div class="empty-state">${ctx.listings.length ? 'Nobody on the list matches that.' : 'Nobody on your do-not-sell list.'}</div>`}`;
  const search = els.body.querySelector('#dns-search');
  search.addEventListener('input', () => { ctx.search = search.value; const at = search.selectionStart; render(); const s = els.body.querySelector('#dns-search'); s.focus(); s.setSelectionRange(at, at); });
  els.body.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editListing(ctx.listings.find((l) => l.id === b.dataset.edit)).catch(fail)));
  els.body.querySelectorAll('[data-off]').forEach((b) => b.addEventListener('click', () => takeOff(ctx.listings.find((l) => l.id === b.dataset.off)).catch(fail)));
}

const val = (o, id) => o.querySelector(id).value;

// Add by hand, or edit: name, email, phone, reason.
async function editListing(l = null) {
  const v = l || { name: '', email: '', phone: '', reason: '' };
  const ok = await formModal({
    title: l ? `Edit ${l.name || 'this listing'}` : 'Add someone to your do-not-sell list',
    confirmLabel: l ? 'Save' : 'Add to the list',
    bodyHtml: `<div class="form-grid">
        <div class="field"><label>Name</label><input id="dns-name" type="text" value="${esc(v.name)}"></div>
        <div class="field"><label>Email</label><input id="dns-email" type="email" value="${esc(v.email)}"></div>
        <div class="field"><label>Phone</label><input id="dns-phone" type="tel" value="${esc(v.phone)}"></div>
        <div class="field field-wide"><label>Reason <span class="faint">(only you see it)</span></label><textarea id="dns-reason">${esc(v.reason)}</textarea></div>
      </div>
      <p class="field-hint">Applications are matched on any of these: the same email or phone is a sure match, the same or a close name a "maybe".</p>`,
    onConfirm: async (o) => {
      const data = { name: val(o, '#dns-name'), email: val(o, '#dns-email'), phone: val(o, '#dns-phone'), reason: val(o, '#dns-reason') };
      if (l) await doNotSellRepo.update(l.id, data);
      else await doNotSellRepo.create(data);
    }
  });
  if (ok) { await load(); render(); }
}

async function addFromContact() {
  const listed = listedContactIds(ctx.listings);
  const choices = ctx.contacts.filter((c) => !c.is_archived && !listed.has(c.id)).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (!choices.length) { showError('Every contact you have is already on the list.'); return; }
  const ok = await formModal({
    title: 'Move a contact to your do-not-sell list',
    confirmLabel: 'Move to the list',
    danger: true,
    bodyHtml: `<div class="form-grid">
        <div class="field field-wide"><label>Contact</label><select id="dns-contact"><option value="">Choose…</option>${choices.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}${c.email ? ` (${esc(c.email)})` : ''}</option>`).join('')}</select></div>
        <div class="field field-wide"><label>Reason <span class="faint">(only you see it)</span></label><textarea id="dns-reason"></textarea></div>
      </div>
      <p class="field-hint">They leave your Contacts list while they're here. Their sales and history stay as they are.</p>`,
    onConfirm: async (o) => {
      const c = choices.find((x) => x.id === val(o, '#dns-contact'));
      if (!c) throw new Error('Choose a contact.');
      await doNotSellRepo.addContact(c, { reason: val(o, '#dns-reason') });
    }
  });
  if (ok) { await load(); render(); }
}

async function takeOff(l) {
  const ok = await confirmModal({
    title: `Take ${l.name || 'them'} off your do-not-sell list?`,
    message: `New applications from them are no longer flagged.${l.contact_id ? ' Their contact shows in your Contacts list again.' : ''}`,
    confirmLabel: 'Take them off'
  });
  if (!ok) return;
  await doNotSellRepo.archive(l.id);
  await load();
  render();
}

async function main() {
  if (!editionFlags.waitlist) document.getElementById('people-hub-tabs')?.remove();
  els.add.addEventListener('click', () => editListing().catch(fail));
  els.addContact.addEventListener('click', () => addFromContact().catch(fail));
  await load();
  render();
}

main().catch(fail);
