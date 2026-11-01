// pickupTimesPanel.js — the Litter page's Pickup times (docs/KennelOS_Family_Requests_Plan.md
// §4; Pro, with the waitlist). Her times for this litter's pickups, at her pickup
// places (Kennel page, Pickup & transport): Add times makes a run of them in one go
// (a date, first and last time, how long each is, which places), each shows who's
// booked, and Copy to another litter. Families book one from their status page; her
// approval makes the pup's pickup event. Stored as Litter.pickup_slots.
import { litterRepo } from '../data/litterRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { eventRepo } from '../data/eventRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { waitlistEntryRepo } from '../data/waitlistEntryRepo.js';
import { pickupLocations, cleanSlots, makeSlots, timeRange, slotBookings, ruleFor, withDateRule } from '../data/pickupSlots.js';
import { kennelChargeList } from '../data/extraCharges.js';
import { waitlistConfig } from '../data/waitlistRules.js';
import { esc, fmtDate, todayYMD, confirmModal } from './ui.js';

export async function renderPickupTimesPanel({ mount, litter, onChange = async () => {} }) {
  if (!mount) return;
  const kennel = await kennelRepo.getById(litter.kennel_id);
  const places = pickupLocations(kennel);
  const slots = cleanSlots(litter.pickup_slots);
  const pups = (await dogRepo.getAll()).filter((d) => d.litter_id === litter.id);
  const events = (await Promise.all(pups.map((p) => eventRepo.getForSubject('dog', p.id)))).flat();
  const entries = await waitlistEntryRepo.getByKennel(litter.kennel_id);
  const booked = slotBookings(events, entries);
  const pupName = new Map(pups.map((p) => [p.id, p.call_name || 'a pup']));
  const whoBooked = (slotId) => events.filter((e) => !e.is_archived && e.event_type === 'placement' && e.details?.pickup_slot_id === slotId).map((e) => pupName.get(e.subject_id));
  const placeName = (id) => places.find((l) => l.id === id)?.label || 'a place that\'s gone';
  const today = todayYMD();
  const upcoming = slots.filter((s) => s.date >= today);

  const byDate = new Map();
  for (const s of upcoming) { if (!byDate.has(s.date)) byDate.set(s.date, []); byDate.get(s.date).push(s); }
  // Each date's rule: one of her packages needed first, or her standard boarding.
  const extras = kennelChargeList(kennel);
  const rate = Number(waitlistConfig(kennel).boarding_rate) || 0;
  const ruleSelect = (date) => {
    const r = ruleFor(litter, date);
    const value = r?.requires_list_id ? `x:${r.requires_list_id}` : r?.boarding ? 'boarding' : '';
    return `<select class="pt-rule" data-date="${esc(date)}" aria-label="Rule for ${esc(fmtDate(date))}" style="width:auto; max-width:100%;">
      <option value="">Nothing extra</option>
      <option value="boarding"${value === 'boarding' ? ' selected' : ''}>Standard boarding applies${rate ? '' : ' (set your rate)'}</option>
      ${extras.map((x) => `<option value="x:${esc(x.id)}"${value === `x:${x.id}` ? ' selected' : ''}>Requires: ${esc(x.label)}${x.family_can_request ? '' : ' (families can\'t ask for it)'}</option>`).join('')}
    </select>`;
  };
  const list = [...byDate.entries()].map(([date, items]) => `<div style="margin-top:8px;"><div class="row-between" style="gap:8px; flex-wrap:wrap;"><strong>${esc(fmtDate(date))}</strong>${ruleSelect(date)}</div>
      ${items.map((s) => {
        const n = booked.get(s.id) || 0;
        const who = whoBooked(s.id);
        return `<div class="row-between" style="gap:8px; padding:4px 0; border-top:1px solid var(--border);">
          <span>${esc(timeRange(s))} · ${esc(placeName(s.location_id))}${s.capacity > 1 ? ` <span class="faint">(${n} of ${s.capacity})</span>` : ''}
            ${who.length ? ` <span class="badge badge-green">${esc(who.join(', '))}</span>` : n ? ' <span class="badge badge-amber">Requested</span>' : ''}</span>
          ${n ? '' : `<button type="button" class="btn btn-sm" data-pt-remove="${esc(s.id)}" aria-label="Remove">✕</button>`}
        </div>`;
      }).join('')}</div>`).join('');

  const shown = places.filter((l) => l.show_to_families);
  mount.innerHTML = `<section class="card">
    <h2 style="margin-top:0;">Pickup times</h2>
    ${!places.length ? '<p class="field-hint">Add your pickup places first: Kennel page, <strong>Pickup &amp; transport</strong>.</p>' : `
    <p class="field-hint">Families whose pup is picked choose one of these on their status page; you approve it, and it goes on the pup's calendar. For each date you can require one of your packages (families need it on their sale before they can choose that day) or apply your standard boarding (charged and logged when you approve).</p>
    ${list || '<p class="faint">No times yet.</p>'}
    <details style="margin-top:10px;"><summary><strong>Add times</strong></summary>
      <div class="form-grid" style="margin-top:6px;">
        <div class="field"><label for="pt-date">Date</label><input id="pt-date" type="date" min="${esc(today)}"></div>
        <div class="field"><label for="pt-from">First time</label><input id="pt-from" type="time" value="10:00"></div>
        <div class="field"><label for="pt-to">Last one ends</label><input id="pt-to" type="time" value="14:00"></div>
        <div class="field"><label for="pt-len">Each lasts</label><span style="display:inline-flex; gap:6px; align-items:center;"><input id="pt-len" type="number" min="5" step="5" value="30" style="width:6em;"> minutes</span></div>
        <div class="field"><label for="pt-cap">Families each</label><input id="pt-cap" type="number" min="1" step="1" value="1" style="width:6em;"></div>
        <div class="field field-wide"><label>Where</label>${(shown.length ? shown : places).map((l, i) => `<label class="check-inline" style="display:block;"><input type="checkbox" class="pt-place" value="${esc(l.id)}"${i === 0 ? ' checked' : ''}> ${esc(l.label)}${l.show_to_families ? '' : ' <span class="faint">(hidden from families)</span>'}</label>`).join('')}</div>
      </div>
      <div class="form-actions"><button type="button" class="btn btn-primary btn-sm" data-pt="add">Add these times</button><span class="field-hint" id="pt-msg" role="status"></span></div>
    </details>
    ${upcoming.length ? '<div class="form-actions"><button type="button" class="btn btn-sm" data-pt="copy">Copy to another litter…</button></div>' : ''}`}
  </section>`;

  const save = async (next) => { await litterRepo.update(litter.id, { pickup_slots: cleanSlots(next) }); await onChange(); };
  mount.querySelectorAll('.pt-rule').forEach((sel) => sel.addEventListener('change', async () => {
    const v = sel.value;
    const rule = v === 'boarding' ? { boarding: true } : v.startsWith('x:') ? { requires_list_id: v.slice(2) } : null;
    await litterRepo.update(litter.id, { pickup_date_rules: withDateRule(litter, sel.dataset.date, rule) });
    await onChange();
  }));
  mount.querySelectorAll('[data-pt-remove]').forEach((b) => b.addEventListener('click', () => save(slots.filter((s) => s.id !== b.dataset.ptRemove))));
  mount.querySelector('[data-pt="add"]')?.addEventListener('click', async () => {
    const v = (id) => mount.querySelector(id).value;
    const { slots: made, error } = makeSlots({
      date: v('#pt-date'), from: v('#pt-from'), to: v('#pt-to'), length: v('#pt-len'), capacity: v('#pt-cap'),
      locationIds: [...mount.querySelectorAll('.pt-place:checked')].map((c) => c.value)
    });
    if (error) { mount.querySelector('#pt-msg').innerHTML = `<span class="inline-error">${esc(error)}</span>`; return; }
    await save([...slots, ...made]);
  });
  mount.querySelector('[data-pt="copy"]')?.addEventListener('click', async () => {
    const others = (await litterRepo.getAll()).filter((l) => l.id !== litter.id && l.kennel_id === litter.kennel_id && !['closed'].includes(l.status));
    if (!others.length) { await confirmModal({ title: 'No other litter', message: 'There\'s no other open litter in this kennel to copy them to.', confirmLabel: 'OK' }); return; }
    const pick = await chooseLitter(others);
    if (!pick) return;
    const fresh = upcoming.map((s) => ({ ...s, id: crypto.randomUUID() }));
    await litterRepo.update(pick.id, { pickup_slots: cleanSlots([...(pick.pickup_slots || []), ...fresh]) });
    await confirmModal({ title: 'Copied', message: `${fresh.length} time${fresh.length === 1 ? '' : 's'} copied to ${pick.nickname || 'that litter'}.`, confirmLabel: 'OK' });
  });
}

// A small chooser for Copy to another litter.
function chooseLitter(litters) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><h2 style="margin-top:0;">Copy the times to…</h2>
      <select id="pt-to-litter" style="width:100%;">${litters.map((l) => `<option value="${esc(l.id)}">${esc(l.nickname || `Litter ${fmtDate(l.whelp_date || l.created_at?.slice(0, 10) || '')}`)}</option>`).join('')}</select>
      <div class="form-actions"><button class="btn btn-primary" id="pt-go">Copy</button><button class="btn" id="pt-cancel">Cancel</button></div></div>`;
    document.body.appendChild(overlay);
    const done = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelector('#pt-go').addEventListener('click', () => done(litters.find((l) => l.id === overlay.querySelector('#pt-to-litter').value)));
    overlay.querySelector('#pt-cancel').addEventListener('click', () => done(null));
  });
}
