// sideSaleUI.js — side sales on the breeder's pages (Side Sale Spec): record one
// (from a family's page, or a litter's picks panel), the deposit, a cancel, and the
// warning before a second claim on a pup. Every write goes through
// waitlistActions; every decision through waitlistRules. Pro-only (proPages.js).
import { kennelRepo } from '../data/kennelRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { waitlistEntryRepo } from '../data/waitlistEntryRepo.js';
import { waitlistOfferRepo } from '../data/waitlistOfferRepo.js';
import { waitlistProgramRepo } from '../data/waitlistProgramRepo.js';
import * as actions from '../data/waitlistActions.js';
import {
  waitlistConfig, entryName, overallPositions, openTurns, sideSaleOf, sideSaleBlocker, sideSaleIssues,
  pupClaims, respondByDate, waitlistLitters
} from '../data/waitlistRules.js';
import { DISPOSITION, REGISTRATION_TYPE, SEX, WAITLIST_PREF_SEX, PLACEMENT_PURPOSE, registrationsForPurposes, cleanPurposes, descriptor } from '../data/vocab.js';
import { esc, fmtDate, todayYMD, alertModal, confirmModal } from './ui.js';
import { formModal } from './waitlistUI.js';

const label = (vocab, v) => descriptor(vocab, v)?.label || v || '—';

async function kennelData(kennelId) {
  const [kennel, entries, offers, litters, dogs, sales, contacts, programsById] = await Promise.all([
    kennelRepo.getById(kennelId), waitlistEntryRepo.getByKennel(kennelId), waitlistOfferRepo.getByKennel(kennelId),
    litterRepo.getAll(), dogRepo.getAll({ includeArchived: true }), saleRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true }), waitlistProgramRepo.getMapForKennel(kennelId)
  ]);
  const contactsById = new Map(contacts.map((c) => [c.id, c]));
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const kennelLitters = waitlistLitters(kennelId, litters);
  const litterLabel = (l) => (l ? (l.nickname || `${dogsById.get(l.dam_id)?.call_name || 'Unknown'} × ${dogsById.get(l.sire_id)?.call_name || 'Unknown'}`) : '');
  return {
    kennel, config: waitlistConfig(kennel), entries, offers, kennelLitters, dogs, dogsById, sales, contactsById, programsById,
    familyName: (e) => entryName(e, contactsById.get(e.contact_id)),
    litterLabel
  };
}

// Families who can have a side sale now: on the list, not holding the turn, no side
// sale already waiting. → [entry] in list order.
function eligibleFamilies(d) {
  const holders = new Set(openTurns(d.offers, d.kennel.id).map((t) => t.entry_id));
  const pos = overallPositions(d.entries, d.kennel.id, d.programsById, { sales: d.sales, dogs: d.dogsById });
  return d.entries.filter((e) => e.status === 'active' && !e.is_archived && !holders.has(e.id) && !sideSaleOf(e, d.sales))
    .sort((a, b) => (pos.get(a.id) || 0) - (pos.get(b.id) || 0))
    .map((e) => ({ entry: e, position: pos.get(e.id) }));
}

const FIELD_TEXT = {
  sex: (e, dog) => `They asked for ${label(WAITLIST_PREF_SEX, e.pref_sex || 'any').toLowerCase()}; ${dog.call_name} is ${label(SEX, dog.sex).toLowerCase()}.`,
  breed: (e, dog) => `They asked for ${e.pref_breed}; ${dog.call_name} is ${dog.breed || 'another breed'}.`,
  purposes: (e, dog) => `They're looking for ${cleanPurposes(e.pref_purposes).map((v) => label(PLACEMENT_PURPOSE, v).toLowerCase()).join(', ')}; ${dog.call_name} is planned for ${label(REGISTRATION_TYPE, dog.intended_registration).toLowerCase()} registration.`,
  colors: (e, dog) => `They listed colors that aren't in ${dog.call_name}'s color/markings.`
};

function claimText(c, d) {
  const who = (id) => { const e = d.entries.find((x) => x.id === id); return e ? d.familyName(e) : 'Another family'; };
  if (c.kind === 'side') return `${who(c.entry_id)} has a side sale on this pup waiting on its deposit.`;
  if (c.kind === 'pick') return `${who(c.entry_id)} picked this pup in their turn (deposit pending).`;
  return 'This pup already has a sale.';
}

// The issues as plain lines for the dialog. Every one is allowed.
function issueLines(issues, entry, dog, d) {
  const out = [];
  const them = dog.sex === 'male' ? 'him' : dog.sex === 'female' ? 'her' : 'the pup';
  if (issues.disposition) out.push(`${dog.call_name} is ${label(DISPOSITION, issues.disposition).toLowerCase()}. Recording this sets ${them} Available and holds ${them} for this family until the deposit, or puts ${them} back if it's cancelled.`);
  for (const f of issues.fields) out.push(FIELD_TEXT[f](entry, dog));
  if (issues.paused) out.push('They\'re paused right now.');
  if (issues.listening) out.push('They\'re listening only for litters from other parents.');
  for (const c of issues.claims) out.push(`Two sales on one pup: ${claimText(c, d)} You'll be asked what to do with the other when a deposit arrives.`);
  return out;
}

// Record a side sale. Give `entryId` (from a family's page: she picks the pup) or
// `dogId` (from a pup: she picks the family), or both. Resolves the result of
// recordSideSale ({ sale, issues, depositDone }) plus { entry, dog }, or null.
export async function sideSaleDialog({ kennelId, entryId = null, dogId = null, litterId = null }) {
  const d = await kennelData(kennelId);
  const today = todayYMD();
  const families = eligibleFamilies(d);
  const fixedEntry = entryId ? d.entries.find((e) => e.id === entryId) : null;
  if (entryId && !fixedEntry) throw new Error('That family no longer exists.');
  const pups = d.dogs.filter((x) => d.kennelLitters.some((l) => l.id === x.litter_id) && (!litterId || x.litter_id === litterId) && !sideSaleBlocker(x))
    .sort((a, b) => d.litterLabel(d.kennelLitters.find((l) => l.id === a.litter_id)).localeCompare(d.litterLabel(d.kennelLitters.find((l) => l.id === b.litter_id))) || (a.call_name || '').localeCompare(b.call_name || ''));
  if (!pups.length) { await alertModal({ title: 'No pups to sell', message: 'There are no pups in your current litters that can be sold (placed, gone and archived pups can\'t).' }); return null; }
  if (!fixedEntry && !families.length) { await alertModal({ title: 'Nobody to sell to', message: 'Side sales are for families on your list who don\'t hold the turn and aren\'t already buying a pup.' }); return null; }
  let out = null;

  const famSelect = fixedEntry ? '' : `<div class="field"><label>Family</label><select id="ss-entry">${families.map((f) => `<option value="${esc(f.entry.id)}">#${esc(f.position)} ${esc(d.familyName(f.entry))}</option>`).join('')}</select></div>`;
  const pupSelect = `<div class="field"><label>Pup</label><select id="ss-dog">${pups.map((p) => `<option value="${esc(p.id)}"${p.id === dogId ? ' selected' : ''}>${esc(p.call_name)} (${esc(label(SEX, p.sex))}) · ${esc(d.litterLabel(d.kennelLitters.find((l) => l.id === p.litter_id)))} · ${esc(label(DISPOSITION, p.disposition || 'undecided'))}</option>`).join('')}</select></div>`;
  const regOptions = REGISTRATION_TYPE.map((r) => `<option value="${esc(r.value)}">${esc(r.label)}</option>`).join('');

  const ok = await formModal({
    title: fixedEntry ? `Side sale to ${d.familyName(fixedEntry)}` : 'Sell to a waitlist family',
    confirmLabel: 'Record the sale',
    bodyHtml: `${famSelect}${pupSelect}
      <div class="field"><label>Selling at</label><select id="ss-reg">${regOptions}</select></div>
      <div class="field"><label>Deposit due</label><input id="ss-due" type="date" min="${esc(today)}"></div>
      <div id="ss-issues"></div>
      <p class="field-hint">Outside the turn order: nobody's turn changes and it never counts as a pass. To the family it looks just like picking a pup on their turn, with the deposit due by this date. Creates a sale (deposit pending, price and deposit from the litter's expected amounts).</p>`,
    onConfirm: async (o) => {
      const entry = fixedEntry || d.entries.find((e) => e.id === o.querySelector('#ss-entry').value);
      const dog = d.dogsById.get(o.querySelector('#ss-dog').value);
      const res = await actions.recordSideSale(entry.id, {
        dogId: dog.id,
        registration: o.querySelector('#ss-reg').value,
        depositDue: o.querySelector('#ss-due').value || null,
        updateAnswers: Boolean(o.querySelector('#ss-fit')?.checked),
        updateRegistration: Boolean(o.querySelector('#ss-setreg')?.checked),
        date: today
      });
      out = { ...res, entry, dog };
    }
  }, (o) => {
    const refresh = () => {
      const entry = fixedEntry || d.entries.find((e) => e.id === o.querySelector('#ss-entry').value);
      const dog = d.dogsById.get(o.querySelector('#ss-dog').value);
      if (!entry || !dog) return;
      const litter = d.kennelLitters.find((l) => l.id === dog.litter_id) || null;
      const issues = sideSaleIssues(entry, dog, litter, { sales: d.sales, offers: d.offers, today, config: d.config });
      const reg = o.querySelector('#ss-reg');
      if (!reg.dataset.touched) reg.value = dog.intended_registration || (registrationsForPurposes(entry.pref_purposes) || [])[0] || 'limited';
      const due = o.querySelector('#ss-due');
      if (!due.dataset.touched) due.value = respondByDate(today, d.config, d.programsById.get(entry.waitlist_program_id) || null);
      const lines = issueLines(issues, entry, dog, d);
      const setReg = reg.value !== (dog.intended_registration || '');
      o.querySelector('#ss-issues').innerHTML = `${lines.length ? `<div class="inline-warn" style="margin:4px 0 8px;"><strong>What doesn't fit</strong> (you can still record it)<ul style="margin:4px 0 0;padding-left:18px;">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>` : ''}
        ${issues.fields.length ? '<label class="check-inline" style="display:block;margin:4px 0;"><input id="ss-fit" type="checkbox"> Also update their answers to match</label>' : ''}
        ${setReg ? `<label class="check-inline" style="display:block;margin:4px 0;"><input id="ss-setreg" type="checkbox"> Also set ${esc(dog.call_name)}'s intended registration to ${esc(label(REGISTRATION_TYPE, reg.value))}</label>` : ''}`;
    };
    o.querySelector('#ss-entry')?.addEventListener('change', refresh);
    o.querySelector('#ss-dog').addEventListener('change', () => { delete o.querySelector('#ss-reg').dataset.touched; refresh(); });
    o.querySelector('#ss-reg').addEventListener('change', (ev) => { ev.target.dataset.touched = '1'; refresh(); });
    o.querySelector('#ss-due').addEventListener('change', (ev) => { ev.target.dataset.touched = '1'; });
    refresh();
  });
  return ok ? out : null;
}

// The deposit for a side sale arrived. Warns first when another claim on the pup will
// be ended. Resolves confirmSideDeposit's result, or null.
export async function sideDepositDialog({ sale, name, pupName }) {
  const [sales, offers] = await Promise.all([saleRepo.getByDog(sale.dog_id), waitlistOfferRepo.getAll()]);
  const others = pupClaims(sale.dog_id, { sales, offers }).filter((c) => c.sale_id !== sale.id);
  let res = null;
  const ok = await formModal({
    title: `Deposit from ${name}`,
    confirmLabel: 'Record the deposit',
    bodyHtml: `<div class="form-grid">
        <div class="field"><label>Deposit received</label><input id="sd-date" type="date" value="${esc(todayYMD())}"></div>
        <div class="field"><label>Amount</label><input id="sd-amount" type="number" min="0" step="0.01" value="${sale.deposit_amount != null ? esc(sale.deposit_amount) : ''}"></div>
      </div>
      ${others.length ? `<div class="inline-warn">${others.length === 1 ? 'Another family also has a claim' : 'Other families also have claims'} on ${esc(pupName)}. Recording this deposit ends ${others.length === 1 ? 'it' : 'them'}: a side sale is cancelled (they keep their place), a turn pick is let go (their turn stays open on the pups left).</div>` : ''}
      <p class="field-hint">${esc(pupName)} becomes theirs and ${esc(name)} is placed. No turn moves on.</p>`,
    onConfirm: async (o) => {
      const date = o.querySelector('#sd-date').value || todayYMD();
      res = await actions.confirmSideDeposit(sale.id, { date, paidDate: date, amount: o.querySelector('#sd-amount').value });
    }
  });
  return ok ? res : null;
}

// Cancel a side sale. Resolves cancelSideSale's result, or null.
export async function cancelSideSaleDialog({ sale, name, pupName }) {
  const restore = sale.side_holds_pup && sale.side_prior_disposition && sale.side_prior_disposition !== 'available';
  const ok = await confirmModal({
    title: 'Cancel the side sale?',
    message: `${pupName}'s sale to ${name} is cancelled. ${name} keeps their place on the list, and it never counts as a pass.${restore ? ` ${pupName} goes back to ${label(DISPOSITION, sale.side_prior_disposition)}.` : ''}`,
    confirmLabel: 'Cancel the sale', cancelLabel: 'Keep it', danger: true
  });
  return ok ? actions.cancelSideSale(sale.id, { date: todayYMD() }) : null;
}

// The warning before a second claim on a pup lives in waitlistUI (the turn-pick
// dialogs use it too).
export { confirmSecondClaim } from './waitlistUI.js';
