// setPickupDialog.js — Set their pickup (Pro, editionFlags.waitlist): one of her pickup
// times or any day, time and place, with the transport fee and her drive checked
// (End-State guide §29 Pickup). Opened from a family's page and the litter's pickup
// calendar.
import * as actions from '../data/waitlistActions.js';
import { timeRange, driveClashes } from '../data/pickupSlots.js';
import { transportQuote, mapsLink, milesErrorText } from '../data/transportFee.js';
import { PLACEMENT_METHODS } from '../data/vocab.js';
import { esc, fmtDate, fmtMoney } from './ui.js';
import { formModal, driveWarningHtml } from './waitlistUI.js';

// Set a buyer's pickup (a family's Pickup card, by `entryId`; the litter's pickup
// calendar, by `saleId`, with the time she tapped as `slotId` or a `day` for another
// time or place): one of her times on their pup's litter from today on
// (theirs marked; one too close to another of her pickups for the drive says so), or
// any day and time at one of her places or an address, with how and the miles; and the
// transport fee, which starts with the sale's, else the place's fee or the miles'.
// Either replaces any pickup still to come and closes a pickup request still waiting.
// Her drive is checked (driveWarningHtml): a pickup booked too close → Save anyway; open
// times it leaves no drive to are removed when ticked. → the action's result, or null.
export async function setPickupDialog({ entryId = null, saleId = null, name = 'their', slotId = null, mode: wantMode = null, day = '' } = {}) {
  const ch = entryId ? await actions.pickupTimeChoices(entryId) : await actions.pickupChoicesForSale(saleId);
  const { slots, current, custom, from, places, busy, perMile, saleFee, openTimes, config, waiting } = ch;
  const chosen = slotId && slots.some((x) => x.id === slotId) ? slotId : current;
  const std = places.find((l) => l.is_standard);
  const stdAddress = std?.address || '';
  const placeById = new Map(places.map((l) => [l.id, l]));
  // Open times she leaves unticked stay; the rest are removed when she saves.
  const keepOpen = new Set();
  let toRemove = [];
  const label = (s) => `${fmtDate(s.date)}, ${timeRange(s)} at ${s.location.label}${s.id === current ? ' (their time now)' : ` (${s.left} left)`}${s.clash ? ' · drive clash' : ''}`;
  const cd = custom?.details || {};
  const startMode = !slots.length ? 'other' : wantMode || (slotId || !custom ? 'slot' : 'other');
  const opt = (v, t, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(t)}</option>`;
  const customPlace = cd.location_id && placeById.has(cd.location_id) ? cd.location_id : custom ? '__address' : (std?.id || '__address');
  let res = null;
  let mode = startMode;
  await formModal({
    title: `Set ${name}'s pickup`,
    confirmLabel: 'Save',
    bodyHtml: `${slots.length ? `<div role="radiogroup" aria-label="Pickup" style="display:flex; gap:14px; flex-wrap:wrap; margin-bottom:10px;">
        <label class="check-inline"><input type="radio" name="sp-mode" value="slot"${startMode === 'slot' ? ' checked' : ''}> One of your times</label>
        <label class="check-inline"><input type="radio" name="sp-mode" value="other"${startMode === 'other' ? ' checked' : ''}> Another time or place</label></div>` : ''}
      <div data-sp="slot"${startMode === 'slot' ? '' : ' hidden'}>
        <div class="field"><label for="bt-slot">Pickup time</label><select id="bt-slot">${slots.map((x) => opt(x.id, label(x), x.id === chosen)).join('')}</select></div>
      </div>
      <div data-sp="other"${startMode === 'other' ? '' : ' hidden'}>
        <div class="form-grid">
          <div class="field"><label for="sp-place">Where</label><select id="sp-place">${places.map((l) => opt(l.id, l.label, l.id === customPlace)).join('')}${opt('__address', 'Another address…', customPlace === '__address')}</select></div>
          <div class="field" data-sp-addr><label for="sp-address">Address</label><input id="sp-address" type="text" value="${esc(customPlace === '__address' ? (cd.location || '') : '')}" placeholder="Street, city, state"></div>
          <div class="field"><label for="sp-day">Day</label><input id="sp-day" type="date" value="${esc(day || custom?.event_date || '')}"></div>
          <div class="field"><label for="sp-from">From</label><input id="sp-from" type="time" value="${esc(cd.start_time || '')}"></div>
          <div class="field"><label for="sp-to">To</label><input id="sp-to" type="time" value="${esc(cd.end_time || '')}"></div>
          <div class="field"><label for="sp-method">How</label><select id="sp-method">${PLACEMENT_METHODS.map((m) => opt(m, m, m === (cd.dropoff_method || (customPlace === '__address' ? 'Ground transport' : 'Local pickup')))).join('')}</select></div>
          <div class="field" data-sp-addr><label for="sp-miles">Miles, one way</label><span style="display:inline-flex; gap:6px; align-items:center; flex-wrap:wrap;"><input id="sp-miles" type="number" min="0" step="0.1" value="${esc(Number.isFinite(cd.miles) && customPlace === '__address' ? cd.miles : '')}" style="width:7em;">${stdAddress ? '<button type="button" class="btn btn-sm" id="sp-measure">Get driving miles</button> <a id="sp-maps" target="_blank" rel="noopener noreferrer">Open in Maps</a>' : ''}</span></div>
        </div>
      </div>
      <div class="field"><label for="sp-fee">Transport fee</label>
        <span style="display:inline-flex; gap:6px; align-items:center; flex-wrap:wrap;"><input id="sp-fee" type="number" min="0" step="0.01" value="${saleFee ?? ''}" style="width:9em;"><button type="button" class="btn btn-sm" id="sp-use" hidden></button></span>
        <span class="field-hint">${saleFee != null ? `On the sale now: ${esc(fmtMoney(saleFee))}. Saving puts what's in the box on the sale; 0 takes it off.` : 'Blank leaves the sale without one.'}</span>
        <span class="field-hint" id="sp-working"></span></div>
      <div id="sp-clash"></div>
      ${from ? `<p class="field-hint">Their pup can go home from ${esc(fmtDate(from))}.</p>` : ''}
      <p class="field-hint">It goes on the pup's calendar as their pickup (any other pickup still to come is replaced).${waiting ? ' Their pickup request still waiting is closed.' : ''}</p>`,
    onConfirm: async (o) => {
      const fee = o.querySelector('#sp-fee').value;
      if (mode === 'slot') {
        const sid = o.querySelector('#bt-slot').value;
        res = entryId ? await actions.bookPickupTime(entryId, sid, { fee }) : await actions.bookPickupTimeForSale(saleId, sid, { fee });
        await actions.removeOpenPickupTimes(toRemove);
        return;
      }
      const pl = o.querySelector('#sp-place').value;
      const details = {
        day: o.querySelector('#sp-day').value, start_time: o.querySelector('#sp-from').value, end_time: o.querySelector('#sp-to').value,
        location_id: pl === '__address' ? null : pl, address: o.querySelector('#sp-address').value, method: o.querySelector('#sp-method').value,
        miles: o.querySelector('#sp-miles').value, fee
      };
      res = entryId ? await actions.setOwnPickup(entryId, details) : await actions.setOwnPickupForSale(saleId, details);
      await actions.removeOpenPickupTimes(toRemove);
    }
  }, (o) => {
    const q = (sel) => o.querySelector(sel);
    // The suggested fee: the chosen time's or place's, or the miles' to an address.
    const suggestion = () => {
      if (mode === 'slot') return placeById.get(slots.find((x) => x.id === q('#bt-slot').value)?.location.id)?.fee || null;
      const pl = q('#sp-place').value;
      if (pl !== '__address') return placeById.get(pl)?.fee || null;
      const m = q('#sp-miles').value;
      if (m === '') return null;
      const t = transportQuote(Number(m), config);
      return t.fee == null ? { fee: null, text: t.text } : { fee: t.fee, text: t.text };
    };
    const milesNow = () => {
      const pl = q('#sp-place').value;
      return pl === '__address' ? Number(q('#sp-miles').value) || 0 : (placeById.get(pl)?.miles_known ?? 0);
    };
    const refresh = (fill) => {
      const addr = q('#sp-place').value === '__address';
      o.querySelectorAll('[data-sp-addr]').forEach((x) => { x.hidden = !addr; });
      const maps = q('#sp-maps');
      if (maps) maps.href = mapsLink(stdAddress, q('#sp-address').value);
      const sug = suggestion();
      q('#sp-working').textContent = sug?.text || '';
      if (fill && saleFee == null && sug?.fee != null) q('#sp-fee').value = sug.fee > 0 ? sug.fee : '';
      const use = q('#sp-use');
      use.hidden = sug?.fee == null || (Number(q('#sp-fee').value) || 0) === sug.fee;
      if (sug?.fee != null) use.textContent = sug.fee > 0 ? `Use ${fmtMoney(sug.fee)}` : 'No charge';
      // Her drive: pickups already booked too close (a warning; she may have someone
      // covering one), and open times she couldn't get to (offered for removal).
      let time = null;
      if (mode === 'slot') {
        const x = slots.find((y) => y.id === q('#bt-slot').value);
        if (x) time = { id: x.id, date: x.date, start_time: x.start_time, end_time: x.end_time, place_id: x.location.id, miles: placeById.get(x.location.id)?.miles_known ?? 0 };
      } else if (q('#sp-method').value !== 'Flight nanny') {
        const pl = q('#sp-place').value;
        time = { date: q('#sp-day').value, start_time: q('#sp-from').value, end_time: q('#sp-to').value, place_id: pl === '__address' ? null : pl, miles: milesNow() };
      }
      const booked = time ? driveClashes(time, busy, perMile) : [];
      const open = time ? driveClashes(time, openTimes.filter((x) => x.id !== time.id && x.id !== current), perMile) : [];
      toRemove = open.filter((x) => !keepOpen.has(x.id)).map((x) => x.id);
      const box = q('#sp-clash');
      box.innerHTML = driveWarningHtml({ booked, open, perMile, miles: time?.miles || 0, keep: keepOpen });
      box.querySelectorAll('[data-drive-open]').forEach((c) => c.addEventListener('change', () => {
        if (c.checked) keepOpen.delete(c.dataset.driveOpen); else keepOpen.add(c.dataset.driveOpen);
        toRemove = open.filter((x) => !keepOpen.has(x.id)).map((x) => x.id);
        saveLabel();
      }));
      const saveLabel = () => { o.querySelector('[data-fm-confirm]').textContent = booked.length ? 'Save anyway' : toRemove.length ? `Save and remove ${toRemove.length}` : 'Save'; };
      saveLabel();
    };
    o.querySelectorAll('input[name="sp-mode"]').forEach((r) => r.addEventListener('change', () => {
      mode = r.value;
      o.querySelectorAll('[data-sp]').forEach((x) => { x.hidden = x.dataset.sp !== mode; });
      refresh(true);
    }));
    q('#sp-use').addEventListener('click', () => { const sug = suggestion(); if (sug?.fee != null) q('#sp-fee').value = sug.fee > 0 ? sug.fee : 0; refresh(false); });
    q('#sp-fee').addEventListener('input', () => refresh(false));
    q('#sp-place').addEventListener('change', () => {
      q('#sp-method').value = q('#sp-place').value === '__address' ? 'Ground transport' : 'Local pickup';
      refresh(true);
    });
    ['#bt-slot', '#sp-miles', '#sp-address'].forEach((sel) => q(sel)?.addEventListener('change', () => refresh(true)));
    ['#sp-day', '#sp-from', '#sp-to', '#sp-method'].forEach((sel) => q(sel).addEventListener('change', () => refresh(false)));
    q('#sp-measure')?.addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      try {
        const { drivingMiles } = await import('../data/cloud/cloudWaitlist.js');
        const d = await drivingMiles(stdAddress, q('#sp-address').value);
        q('#sp-miles').value = d.miles;
        refresh(true);
      } catch (err) {
        q('#sp-working').textContent = `Couldn't measure. ${milesErrorText(err)} Use Open in Maps and type the miles.`;
      }
      ev.target.disabled = false;
    });
    refresh(true);
  });
  return res;
}
