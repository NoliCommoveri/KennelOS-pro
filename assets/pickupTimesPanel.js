// pickupTimesPanel.js — the Litter page's Pickup times (docs/KennelOS_Family_Requests_Plan.md
// §4; Pro, with the waitlist): a month calendar of her times for this litter's pickups,
// at her pickup places (Kennel page, Pickup & transport). Each day shows its times as
// booked (green), requested by a family (amber) and open (gray), and a date rule
// (a package it needs, or standard boarding). Tapping a day opens it: its rule, each
// time with who's booked, Book… for one of the litter's buyers (one of her times, or a
// new one made right there), ✕ to remove an unbooked time, and Add times (one time, or
// a run split into times). Copy to another litter. Families book one from their status
// page; her approval makes the pup's pickup event. Stored as Litter.pickup_slots.
import { litterRepo } from '../data/litterRepo.js';
import { kennelRepo } from '../data/kennelRepo.js';
import { eventRepo } from '../data/eventRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { waitlistEntryRepo } from '../data/waitlistEntryRepo.js';
import { waitlistOfferRepo } from '../data/waitlistOfferRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import { familySale } from '../data/familyExtras.js';
import { pickupLocations, cleanSlots, makeSlots, timeRange, slotBookings, ruleFor, withDateRule, copyDateRules, slotConflicts } from '../data/pickupSlots.js';
import { monthOf, shiftMonth, monthGridDates, weekdayHeads } from '../data/calendarMath.js';
import { kennelChargeList } from '../data/extraCharges.js';
import { waitlistConfig } from '../data/waitlistRules.js';
import { editPickupTime } from '../data/waitlistActions.js';
import { kennelToday } from '../data/dateUtils.js';
import { esc, fmtDate, confirmModal, alertModal } from './ui.js';
import { afterPickupApproval } from './waitlistUI.js';
import { setPickupDialog } from './setPickupDialog.js';

// The month she's looking at, per litter, kept while she stays on the page.
const shownMonth = new Map();

const minutes = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

export async function renderPickupTimesPanel({ mount, litter, onChange = async () => {} }) {
  if (!mount) return;
  const kennel = await kennelRepo.getById(litter.kennel_id);
  const places = pickupLocations(kennel);
  const slots = cleanSlots(litter.pickup_slots);
  const pups = (await dogRepo.getAll()).filter((d) => d.litter_id === litter.id);
  const events = (await Promise.all(pups.map((p) => eventRepo.getForSubject('dog', p.id)))).flat();
  const [entries, offers, sales] = await Promise.all([
    waitlistEntryRepo.getByKennel(litter.kennel_id), waitlistOfferRepo.getByKennel(litter.kennel_id), saleRepo.getAll()
  ]);
  // A family who backed out holds no time (K8-8).
  const booked = slotBookings(events, entries, { live: (en) => Boolean(familySale(en, sales, offers, entries)) });
  const pupName = new Map(pups.map((p) => [p.id, p.call_name || 'a pup']));
  const today = kennelToday(kennel);

  // The litter's buyers she can book: each open sale of one of its pups.
  const pupIds = new Set(pups.map((p) => p.id));
  const buyerSales = sales.filter((x) => saleRepo.isOpenSale(x) && pupIds.has(x.dog_id));
  const contacts = new Map((await Promise.all([...new Set([...buyerSales.map((x) => x.buyer_contact_id), ...entries.map((e) => e.contact_id)].filter(Boolean))]
    .map((id) => contactRepo.getById(id)))).filter(Boolean).map((c) => [c.id, c]));
  const buyerLabel = (sale) => `${pupName.get(sale.dog_id)} — ${contacts.get(sale.buyer_contact_id)?.name || 'their buyer'}`;
  const pickupOf = (saleId) => {
    const sale = buyerSales.find((x) => x.id === saleId);
    return events.find((e) => !e.is_archived && e.event_type === 'placement' && e.subject_id === sale?.dog_id && e.event_date >= today) || null;
  };
  // Who holds each time: its confirmed pickups, by pup and buyer.
  const whoBooked = (slotId) => events.filter((e) => !e.is_archived && e.event_type === 'placement' && e.details?.pickup_slot_id === slotId)
    .map((e) => { const sale = buyerSales.find((x) => x.dog_id === e.subject_id); return sale ? buyerLabel(sale) : pupName.get(e.subject_id) || 'a pup'; });
  const placeName = (id) => places.find((l) => l.id === id)?.label || 'a place that\'s gone';

  // Every pickup and drop-off of the litter's pups, not only those at her times (her own
  // pickups set on the pup, a family's own address she approved), so the calendar is
  // the one view of the litter's pickups.
  const slotIds = new Set(slots.map((s) => s.id));
  const saleOfPup = (dogId) => buyerSales.find((x) => x.dog_id === dogId) || null;
  const pickupLabel = (e) => { const sale = saleOfPup(e.subject_id); return sale ? buyerLabel(sale) : pupName.get(e.subject_id) || 'a pup'; };
  const otherPickups = events.filter((e) => !e.is_archived && e.event_type === 'placement' && pupIds.has(e.subject_id) && !slotIds.has(e.details?.pickup_slot_id));
  // Families' requests waiting for her: a time of hers (by slot), or their own address on a day.
  const familyName = (en) => contacts.get(en.contact_id)?.name || [en.application?.first_name, en.application?.last_name].filter(Boolean).join(' ') || 'A family';
  const requestsBySlot = new Map();
  const addressRequests = [];
  for (const en of entries) {
    if (en.is_archived) continue;
    const sale = familySale(en, sales, offers, entries);
    if (!sale || !pupIds.has(sale.dog_id)) continue;
    for (const r of en.pickup_requests || []) {
      if (!r || r.decided) continue;
      const who = { entry: en, label: `${pupName.get(sale.dog_id)} — ${familyName(en)}`, request: r };
      if (r.kind === 'slot') { if (!requestsBySlot.has(r.slot_id)) requestsBySlot.set(r.slot_id, []); requestsBySlot.get(r.slot_id).push(who); }
      else if (r.kind === 'address' && r.date) addressRequests.push({ ...who, date: r.date });
    }
  }
  const familyHref = (en) => `waitlist-entry.html?id=${encodeURIComponent(en.id)}`;

  const byDate = new Map();
  for (const s of slots) { if (!byDate.has(s.date)) byDate.set(s.date, []); byDate.get(s.date).push(s); }
  for (const list of byDate.values()) list.sort((a, b) => a.start_time.localeCompare(b.start_time));
  // A day's counts: booked (confirmed places), requested (families waiting), open places.
  const dayCounts = (date) => {
    let confirmed = 0; let requested = 0; let open = 0;
    for (const s of byDate.get(date) || []) {
      const c = whoBooked(s.id).length;
      const n = booked.get(s.id) || 0;
      confirmed += c; requested += Math.max(0, n - c); open += Math.max(0, s.capacity - n);
    }
    confirmed += otherPickups.filter((e) => e.event_date === date).length;
    requested += addressRequests.filter((x) => x.date === date).length;
    return { confirmed, requested, open };
  };
  const hasAny = (date) => byDate.has(date) || otherPickups.some((e) => e.event_date === date) || addressRequests.some((x) => x.date === date);

  const firstUpcoming = [...slots.map((s) => s.date), ...otherPickups.map((e) => e.event_date)].filter((d) => d >= today).sort()[0];
  let month = shownMonth.get(litter.id) || monthOf(firstUpcoming || today);
  const extras = kennelChargeList(kennel);
  const rate = Number(waitlistConfig(kennel).boarding_rate) || 0;
  // A day's chip: its words on a wide screen, a short count or letter on a phone.
  const chip = (color, title, long, short) => `<span class="badge badge-${color} cal-chip" title="${esc(title)}"><span class="pt-long">${esc(long)}</span><span class="pt-short">${esc(short)}</span></span>`;
  const ruleChip = (date) => {
    const r = ruleFor(litter, date);
    if (r?.boarding) return chip('blue', 'Standard boarding applies', 'Boarding', 'B');
    if (r?.requires_list_id) return chip('purple', `Requires: ${extras.find((x) => x.id === r.requires_list_id)?.label || 'a package'}`, 'Needs pkg', 'P');
    return '';
  };

  const cellHtml = (date) => {
    if (!date) return '<div class="cal-cell cal-blank"></div>';
    const past = date < today;
    const cls = `cal-cell${date === today ? ' cal-today' : ''}${past ? ' cal-past' : ''}`;
    const num = `<span class="cal-date">${Number(date.slice(8))}</span>`;
    const has = hasAny(date);
    if (past && !has) return `<div class="${cls}">${num}</div>`;
    const { confirmed, requested, open } = dayCounts(date);
    const chips = [
      confirmed ? chip('green', `${confirmed} booked`, `${confirmed} booked`, String(confirmed)) : '',
      requested ? chip('amber', `${requested} asked for, waiting for you`, `${requested} asked`, String(requested)) : '',
      open ? chip('neutral', `${open} open`, `${open} open`, String(open)) : '',
      ruleChip(date)
    ].join('');
    const words = has ? `${confirmed} booked, ${requested} requested, ${open} open` : 'no times';
    return `<button type="button" class="${cls}" data-pt-day="${date}" aria-label="${esc(fmtDate(date))}: ${words}">${num}<span class="cal-chips">${chips}</span></button>`;
  };

  // Her times from today on, by day, above the Add times form so she sees what's there.
  const existingHtml = () => {
    if (!upcoming.length) return '<p class="faint" style="margin:6px 0 0;">No times added yet.</p>';
    const days = [...new Set(upcoming.map((s) => s.date))].sort();
    return `<div style="margin-top:6px;"><p class="field-hint" style="margin:0;">Your times already added:</p>
      <ul class="cal-day-list" style="max-height:220px;">${days.map((d) => `<li class="cal-day-item"><strong>${esc(fmtDate(d))}</strong>
        <span class="small">${(byDate.get(d) || []).map((s) => {
          const n = booked.get(s.id) || 0;
          return `${esc(timeRange(s))} · ${esc(placeName(s.location_id))}${n ? ` <span class="badge ${whoBooked(s.id).length ? 'badge-green' : 'badge-amber'}">${n >= s.capacity ? 'full' : `${n} of ${s.capacity}`}</span>` : ''}`;
        }).join('<br>')}</span></li>`).join('')}</ul></div>`;
  };
  // New times that overlap ones she has that day: say which, and add them only if she says so.
  const okToAdd = async (made, skipId = null) => {
    const clash = slotConflicts(slots.filter((x) => x.id !== skipId), made);
    if (!clash.length) return true;
    const lines = clash.slice(0, 6).map((c) => `${fmtDate(c.made.date)}: ${skipId ? '' : 'new '}${timeRange(c.made)} at ${placeName(c.made.location_id)} overlaps ${timeRange(c.existing)} at ${placeName(c.existing.location_id)}`);
    const more = clash.length > 6 ? ` …and ${clash.length - 6} more.` : '';
    return confirmModal({
      title: 'These overlap times you already have',
      message: `${lines.join('. ')}.${more} ${skipId ? 'Save it anyway?' : 'Add them anyway?'}`,
      confirmLabel: skipId ? 'Save anyway' : 'Add anyway', cancelLabel: 'Go back'
    });
  };
  const familyPlaces = places.filter((l) => l.show_to_families);
  const placeBoxes = (cls) => (familyPlaces.length ? familyPlaces : places).map((l, i) => `<label class="check-inline" style="display:block;"><input type="checkbox" class="${cls}" value="${esc(l.id)}"${i === 0 ? ' checked' : ''}> ${esc(l.label)}${l.show_to_families ? '' : ' <span class="faint">(hidden from families)</span>'}</label>`).join('');
  const monthLabel = new Date(`${month}-01T12:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const upcoming = slots.filter((s) => s.date >= today);
  mount.innerHTML = `<section class="card">
    <h2 style="margin-top:0;">Pickup times</h2>
    ${!places.length ? '<p class="field-hint">Add your pickup places first: Kennel page, <strong>Pickup &amp; transport</strong>.</p>' : `
    <p class="field-hint">Every pickup and drop-off for this litter shows here. Families whose pup is picked choose one of your times on their status page; once you approve it, it shows as booked. Tap a day to add a time (even last minute), book one for a family, or set the day's rule (a package it needs, or your standard boarding).</p>
    <div class="cal-toolbar">
      <button type="button" class="btn btn-sm" data-pt-month="-1" aria-label="Previous month">‹</button>
      <h3 class="cal-month-label" style="font-size:17px;">${esc(monthLabel)}</h3>
      <button type="button" class="btn btn-sm" data-pt-month="1" aria-label="Next month">›</button>
    </div>
    <div class="cal-grid pt-cal">
      ${weekdayHeads().map((h) => `<div class="cal-head">${esc(h)}</div>`).join('')}
      ${monthGridDates(month).map(cellHtml).join('')}
    </div>
    <div class="cal-key"><span class="badge badge-green cal-chip">Booked</span><span class="badge badge-amber cal-chip">Asked for, waiting for you</span><span class="badge badge-neutral cal-chip">Open</span><span class="badge badge-blue cal-chip">Boarding</span><span class="badge badge-purple cal-chip">Needs a package</span></div>
    ${upcoming.length ? '' : '<p class="faint" style="margin-top:8px;">No times yet. Add a day\'s times below, or tap a day.</p>'}
    <details style="margin-top:10px;"><summary><strong>Add times</strong></summary>
      ${existingHtml()}
      <div class="form-grid" style="margin-top:6px;">
        <div class="field"><label for="ptb-date">Date</label><input id="ptb-date" type="date" min="${esc(today)}"></div>
        <div class="field"><label for="ptb-from">First time</label><input id="ptb-from" type="time" value="10:00"></div>
        <div class="field"><label for="ptb-to">Last one ends</label><input id="ptb-to" type="time" value="14:00"></div>
        <div class="field"><label for="ptb-len">Each lasts</label><span style="display:inline-flex; gap:6px; align-items:center;"><input id="ptb-len" type="number" min="5" step="5" value="30" style="width:6em;"> minutes</span></div>
        <div class="field"><label for="ptb-cap">Families each</label><input id="ptb-cap" type="number" min="1" step="1" value="1" style="width:6em;"></div>
        <div class="field field-wide"><label>Where</label>${placeBoxes('ptb-place')}</div>
      </div>
      <div class="form-actions"><button type="button" class="btn btn-primary btn-sm" data-pt="add">Add these times</button><span class="field-hint" id="ptb-msg" role="status"></span></div>
    </details>
    ${upcoming.length ? '<div class="form-actions"><button type="button" class="btn btn-sm" data-pt="copy">Copy to another litter…</button></div>' : ''}`}
  </section>`;

  const refresh = async () => { await onChange(); };
  const saveSlots = async (next) => { await litterRepo.update(litter.id, { pickup_slots: cleanSlots(next) }); };
  mount.querySelectorAll('[data-pt-month]').forEach((b) => b.addEventListener('click', () => {
    shownMonth.set(litter.id, shiftMonth(month, Number(b.dataset.ptMonth)));
    renderPickupTimesPanel({ mount, litter, onChange });
  }));
  mount.querySelector('[data-pt="add"]')?.addEventListener('click', async () => {
    const v = (id) => mount.querySelector(id).value;
    const { slots: made, error } = makeSlots({
      date: v('#ptb-date'), from: v('#ptb-from'), to: v('#ptb-to'), length: v('#ptb-len'), capacity: v('#ptb-cap'),
      locationIds: [...mount.querySelectorAll('.ptb-place:checked')].map((c) => c.value)
    });
    if (error) { mount.querySelector('#ptb-msg').innerHTML = `<span class="inline-error">${esc(error)}</span>`; return; }
    if (!(await okToAdd(made))) return;
    shownMonth.set(litter.id, monthOf(made[0].date));
    await saveSlots([...slots, ...made]);
    await refresh();
  });
  mount.querySelectorAll('[data-pt-day]').forEach((b) => b.addEventListener('click', () => {
    shownMonth.set(litter.id, month);
    openDay(b.dataset.ptDay).catch((err) => alertModal({ title: 'Something went wrong', message: err.message || String(err) }));
  }));

  // --- One day: its rule, its times, booking, adding ------------------------------
  async function openDay(date) {
    const past = date < today;
    const items = byDate.get(date) || [];
    const r = ruleFor(litter, date);
    const ruleValue = r?.requires_list_id ? `x:${r.requires_list_id}` : r?.boarding ? 'boarding' : '';
    // Buyers with no pickup yet first (the usual one to book), then by pup name.
    const ordered = [...buyerSales].sort((a, b) => (pickupOf(a.id) ? 1 : 0) - (pickupOf(b.id) ? 1 : 0) || buyerLabel(a).localeCompare(buyerLabel(b)));
    const buyerOptions = (keepId = '') => ordered.map((x) => {
      const p = pickupOf(x.id);
      return `<option value="${esc(x.id)}"${x.id === keepId ? ' selected' : ''}>${esc(buyerLabel(x))}${p ? ` (has a pickup ${esc(fmtDate(p.event_date))}: this moves it)` : ''}</option>`;
    }).join('');
    // Requests waiting for her, each with a link to the family's page to approve it there.
    const askedHtml = (list, n) => (list.length
      ? list.map((x) => ` <span class="badge badge-amber">Asked: ${esc(x.label)}</span> <a class="small" href="${esc(familyHref(x.entry))}">Approve or decline</a>`).join('')
      : n ? ` <span class="badge badge-amber">${n} asked for it, waiting for you</span>` : '');
    const dayOthers = otherPickups.filter((e) => e.event_date === date);
    const dayAddresses = addressRequests.filter((x) => x.date === date);
    const otherRow = (e) => `<li class="cal-day-item"><span><strong>${esc(e.details?.placement_time || 'No time set')}</strong> · ${esc(e.details?.dropoff_method || 'Pickup')}${e.details?.location ? ` · ${esc(e.details.location)}` : ''}</span>
        <div><span class="badge badge-green">${esc(pickupLabel(e))}</span> <a class="small" href="dog.html?id=${encodeURIComponent(e.subject_id)}">Open the pup</a></div></li>`;
    const addressRow = (x) => `<li class="cal-day-item"><span><strong>${esc(x.request.start_time ? timeRange({ start_time: x.request.start_time }) : 'Any time')}</strong> · Their own place: ${esc(x.request.address || '')}</span>
        <div><span class="badge badge-amber">Asked: ${esc(x.label)}</span> <a class="small" href="${esc(familyHref(x.entry))}">Approve or decline</a></div></li>`;
    const timeRow = (s) => {
      const n = booked.get(s.id) || 0;
      const who = whoBooked(s.id);
      const waiting = Math.max(0, n - who.length);
      const room = s.capacity - n > 0;
      return `<li class="cal-day-item">
        <div class="row-between" style="gap:8px; flex-wrap:wrap;">
          <span><strong>${esc(timeRange(s))}</strong> · ${esc(placeName(s.location_id))}${s.capacity > 1 ? ` <span class="faint">(${n} of ${s.capacity})</span>` : ''}</span>
          <span class="pill-row">${!past && room && buyerSales.length ? `<button type="button" class="btn btn-sm" data-book="${esc(s.id)}">Book…</button>` : ''}${past ? '' : `<button type="button" class="btn btn-sm" data-edit="${esc(s.id)}">Change…</button>`}${n ? '' : `<button type="button" class="btn btn-sm" data-remove="${esc(s.id)}" aria-label="Remove this time">✕</button>`}</span>
        </div>
        <div>${who.map((w) => `<span class="badge badge-green">${esc(w)}</span>`).join(' ')}${askedHtml(requestsBySlot.get(s.id) || [], waiting)}${!who.length && !waiting ? '<span class="faint">Open</span>' : ''}</div>
        <div class="pt-edit" data-edit-for="${esc(s.id)}" hidden style="margin-top:6px;">
          <div class="form-grid">
            <div class="field"><label for="pte-date-${esc(s.id)}">Date</label><input id="pte-date-${esc(s.id)}" type="date" value="${esc(s.date)}" min="${esc(today)}"></div>
            <div class="field"><label for="pte-from-${esc(s.id)}">Starts</label><input id="pte-from-${esc(s.id)}" type="time" value="${esc(s.start_time)}"></div>
            <div class="field"><label for="pte-to-${esc(s.id)}">Ends</label><input id="pte-to-${esc(s.id)}" type="time" value="${esc(s.end_time)}"></div>
            <div class="field"><label for="pte-place-${esc(s.id)}">Where</label><select id="pte-place-${esc(s.id)}">${places.map((l) => `<option value="${esc(l.id)}"${l.id === s.location_id ? ' selected' : ''}>${esc(l.label)}${l.show_to_families ? '' : ' (hidden from families)'}</option>`).join('')}</select></div>
            <div class="field"><label for="pte-cap-${esc(s.id)}">Families</label><input id="pte-cap-${esc(s.id)}" type="number" min="${Math.max(1, n)}" step="1" value="${esc(s.capacity)}" style="width:6em;"></div>
          </div>
          ${n ? `<p class="field-hint">${who.length ? `${esc(who.join(', '))} ${who.length === 1 ? 'is' : 'are'} booked here: their pickup moves with it, and their status page shows the new time.` : ''}${waiting ? ` ${waiting === 1 ? 'A family\'s request' : `${waiting} requests`} for it will show the new time too.` : ''}</p>` : ''}
          <div class="form-actions" style="margin-top:6px;"><button type="button" class="btn btn-primary btn-sm" data-edit-go="${esc(s.id)}">Save the change</button></div>
        </div>
        <div class="pt-book" data-book-for="${esc(s.id)}" hidden style="margin-top:6px;">
          <div class="field" style="margin:0;"><label for="pt-who-${esc(s.id)}">Book it for</label><select id="pt-who-${esc(s.id)}">${buyerOptions()}</select></div>
          <div class="form-actions" style="margin-top:6px;"><button type="button" class="btn btn-primary btn-sm" data-book-go="${esc(s.id)}">Book this time</button></div>
        </div>
      </li>`;
    };
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="pt-day-title" style="max-width:560px;">
      <h2 id="pt-day-title" style="margin-top:0;">${esc(fmtDate(date))}</h2>
      ${past ? '' : `<div class="field"><label for="pt-rule">This day</label><select id="pt-rule">
        <option value="">Nothing extra</option>
        <option value="boarding"${ruleValue === 'boarding' ? ' selected' : ''}>Standard boarding applies${rate ? '' : ' (set your rate)'}</option>
        ${extras.map((x) => `<option value="x:${esc(x.id)}"${ruleValue === `x:${x.id}` ? ' selected' : ''}>Requires: ${esc(x.label)}${x.family_can_request ? '' : ' (families can\'t ask for it)'}</option>`).join('')}
      </select></div>`}
      ${items.length ? `<ul class="cal-day-list">${items.map(timeRow).join('')}</ul>` : '<p class="faint">No times of yours on this day yet.</p>'}
      ${!past && buyerSales.length ? `<div class="field" style="margin-top:10px;"><label for="pt-elsewho">Another time or place this day for</label>
        <span style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;"><select id="pt-elsewho" style="flex:1; min-width:0;">${buyerOptions()}</select><button type="button" class="btn btn-sm" id="pt-else">Set pickup…</button></span>
        <span class="field-hint">One of your places or any address, with the transport fee.</span></div>` : ''}
      ${dayOthers.length || dayAddresses.length ? `<h3 style="margin:12px 0 0; font-size:15px;">Other pickups and drop-offs</h3><ul class="cal-day-list">${dayOthers.map(otherRow).join('')}${dayAddresses.map(addressRow).join('')}</ul>` : ''}
      ${past ? '' : `<details style="margin-top:10px;"${items.length ? '' : ' open'}><summary><strong>Add a time</strong></summary>
        <div class="form-grid" style="margin-top:6px;">
          <div class="field"><label for="pt-from">Starts</label><input id="pt-from" type="time" value="10:00"></div>
          <div class="field"><label for="pt-to">Ends</label><input id="pt-to" type="time" value="10:30"></div>
          <div class="field"><label for="pt-split">Split into times of</label><span style="display:inline-flex; gap:6px; align-items:center;"><input id="pt-split" type="number" min="5" step="5" placeholder="—" style="width:6em;"> minutes</span><span class="field-hint">Leave empty for one time.</span></div>
          <div class="field"><label for="pt-cap">Families each</label><input id="pt-cap" type="number" min="1" step="1" value="1" style="width:6em;"></div>
          <div class="field field-wide"><label>Where</label>${placeBoxes('pt-place')}</div>
          ${buyerSales.length ? `<div class="field field-wide"><label for="pt-addwho">Book it for</label><select id="pt-addwho"><option value="">Nobody yet: leave it open</option>${buyerOptions()}</select><span class="field-hint">To book it, make one time at one place.</span></div>` : ''}
        </div>
        <div class="form-actions"><button type="button" class="btn btn-primary btn-sm" id="pt-add">Add</button></div>
      </details>`}
      <p class="inline-error" id="pt-err" role="alert" hidden></p>
      <div class="form-actions"><button type="button" class="btn" id="pt-close">Close</button></div>
    </div>`;
    document.body.appendChild(overlay);
    let changed = false;
    const close = async () => { overlay.remove(); if (changed) await refresh(); };
    const fail = (err) => { const el = overlay.querySelector('#pt-err'); el.textContent = err.message || String(err); el.hidden = false; };
    // Booking: the pup's pickup at that time, then her say on any charge it would replace.
    // Booking opens Set their pickup (the family page's dialog): the time she tapped,
    // or another time or place on this day; the fee; her drive checked. Then her say on
    // any charge it would replace.
    const book = async (saleId, slotId, mode = null) => {
      const sale = buyerSales.find((x) => x.id === saleId);
      const res = await setPickupDialog({ saleId, name: contacts.get(sale?.buyer_contact_id)?.name || pupName.get(sale?.dog_id) || 'their', slotId, mode, day: date });
      if (!res) {
        if (changed) await close();
        return;
      }
      changed = true;
      overlay.remove();
      await afterPickupApproval(res);
      await refresh();
    };
    overlay.querySelector('#pt-close').addEventListener('click', () => close());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#pt-rule')?.addEventListener('change', async (e) => {
      const v = e.target.value;
      const rule = v === 'boarding' ? { boarding: true } : v.startsWith('x:') ? { requires_list_id: v.slice(2) } : null;
      try { await litterRepo.update(litter.id, { pickup_date_rules: withDateRule(litter, date, rule) }); changed = true; } catch (err) { fail(err); }
    });
    overlay.querySelectorAll('[data-book]').forEach((b) => b.addEventListener('click', () => {
      const box = overlay.querySelector(`[data-book-for="${CSS.escape(b.dataset.book)}"]`);
      box.hidden = !box.hidden;
    }));
    overlay.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const box = overlay.querySelector(`[data-edit-for="${CSS.escape(b.dataset.edit)}"]`);
      box.hidden = !box.hidden;
    }));
    // Changing a time: everyone on it moves with it (editPickupTime), after the overlap check.
    overlay.querySelectorAll('[data-edit-go]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.editGo;
      const v = (k) => overlay.querySelector(`#pte-${k}-${CSS.escape(id)}`).value;
      const next = { date: v('date'), start_time: v('from'), end_time: v('to'), location_id: v('place'), capacity: v('cap') };
      try {
        const old = slots.find((x) => x.id === id);
        if (old && next.start_time < next.end_time && !(await okToAdd([{ ...old, ...next }], id))) return;
        const res = await editPickupTime(litter.id, id, next);
        changed = true;
        shownMonth.set(litter.id, monthOf(res.slot.date));
        overlay.remove();
        for (const m of res.moved) if ((m.boardingKept || m.fee?.offer) && m.sale) await afterPickupApproval({ sale: m.sale, boardingKept: m.boardingKept, fee: m.fee });
        await refresh();
      } catch (err) { fail(err); }
    }));
    overlay.querySelector('#pt-else')?.addEventListener('click', () => book(overlay.querySelector('#pt-elsewho').value, null, 'other').catch(fail));
    overlay.querySelectorAll('[data-book-go]').forEach((b) => b.addEventListener('click', () => {
      const slotId = b.dataset.bookGo;
      book(overlay.querySelector(`#pt-who-${CSS.escape(slotId)}`).value, slotId).catch(fail);
    }));
    overlay.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
      try {
        await saveSlots(slots.filter((s) => s.id !== b.dataset.remove));
        changed = true;
        await close();
      } catch (err) { fail(err); }
    }));
    overlay.querySelector('#pt-add')?.addEventListener('click', async () => {
      const v = (id) => overlay.querySelector(id).value;
      const from = v('#pt-from');
      const to = v('#pt-to');
      const split = v('#pt-split');
      const whole = /^\d\d:\d\d$/.test(from) && /^\d\d:\d\d$/.test(to) ? minutes(to) - minutes(from) : 0;
      const { slots: made, error } = makeSlots({
        date, from, to, length: split || whole, capacity: v('#pt-cap'),
        locationIds: [...overlay.querySelectorAll('.pt-place:checked')].map((c) => c.value)
      });
      if (error) return fail(new Error(error));
      const who = overlay.querySelector('#pt-addwho')?.value || '';
      if (who && made.length !== 1) return fail(new Error('To book it for a family, make one time: one place, and leave "Split into" empty.'));
      if (!(await okToAdd(made))) return;
      try {
        await saveSlots([...slots, ...made]);
        changed = true;
        if (who) await book(who, made[0].id);
        else await close();
      } catch (err) { fail(err); }
    });
    (overlay.querySelector('[data-book]') || overlay.querySelector('#pt-close')).focus();
  }

  mount.querySelector('[data-pt="copy"]')?.addEventListener('click', async () => {
    const others = (await litterRepo.getAll()).filter((l) => l.id !== litter.id && l.kennel_id === litter.kennel_id && !['closed'].includes(l.status));
    if (!others.length) { await confirmModal({ title: 'No other litter', message: 'There\'s no other open litter in this kennel to copy them to.', confirmLabel: 'OK' }); return; }
    const pick = await chooseLitter(others);
    if (!pick) return;
    const fresh = upcoming.map((s) => ({ ...s, id: crypto.randomUUID() }));
    // Each date's rule (an extra it needs, or boarding) goes with its times.
    const { rules, copied, kept } = copyDateRules(litter, pick, fresh.map((s) => s.date));
    await litterRepo.update(pick.id, { pickup_slots: cleanSlots([...(pick.pickup_slots || []), ...fresh]), pickup_date_rules: rules });
    const name = pick.nickname || 'that litter';
    const ruleWords = [copied ? `${copied} date rule${copied === 1 ? '' : 's'} went with them` : '',
      kept ? `${kept} date${kept === 1 ? '' : 's'} there already had a rule of ${kept === 1 ? 'its' : 'their'} own, kept as it was` : ''].filter(Boolean).join('; ');
    await confirmModal({ title: 'Copied', message: `${fresh.length} time${fresh.length === 1 ? '' : 's'} copied to ${name}.${ruleWords ? ` ${ruleWords[0].toUpperCase()}${ruleWords.slice(1)}.` : ''}`, confirmLabel: 'OK' });
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
