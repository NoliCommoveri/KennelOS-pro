// stayPickupUI.js — "Put the stay on the calendar?" (owner, 2026-11-15): after a stay
// extra (a training package: boarding_days) or boarding goes on a sale, offer the stay,
// the boarding and the pickup the day after it all, in one dialog, every date editable.
// The plan is goHome.stayPickupPlan; a pickup on the calendar before the stay ends is
// moved, not doubled. Shared (the Sale page is in every edition); the waitlist family
// page's request approval and Add charges use it too.
//
//   offerStayAndPickup({ sale, chargeIds, boarding }) → true when something was saved.
import { dogRepo } from '../data/dogRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { eventRepo } from '../data/eventRepo.js';
import { stayPickupPlan, pickupEvent } from '../data/goHome.js';
import { addDaysToYMD, todayYMD } from '../data/dateUtils.js';
import { esc, fmtDate } from './ui.js';

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const daysOf = (ev) => Math.round((Date.parse(ev.event_end_date) - Date.parse(ev.event_date)) / 86_400_000) + 1;

export async function offerStayAndPickup({ sale, chargeIds = null, boarding = false } = {}) {
  if (!sale?.dog_id) return false;
  const pup = await dogRepo.getById(sale.dog_id);
  if (!pup) return false;
  const litter = pup.litter_id ? await litterRepo.getById(pup.litter_id) : null;
  const events = await eventRepo.getForSubject('dog', pup.id);
  const plan = stayPickupPlan({ sale, pup, litter, events, today: todayYMD(), chargeIds, boarding });
  if (!plan) return false;
  return dialog(pup, sale, plan);
}

function dialog(pup, sale, plan) {
  const name = pup.call_name || 'The pup';
  // Every stay in order (the training stays, then boarding), each its own length.
  const rows = [...plan.stays.map((ev) => ({ ev, days: daysOf(ev), kind: 'stay' })), ...(plan.boarding ? [{ ev: plan.boarding, days: plan.boarding.event_end_date ? daysOf(plan.boarding) : 0, kind: 'boarding' }] : [])];
  const rowHtml = (r, i) => `<div class="field" style="margin-bottom:8px;">
      <label style="display:flex; gap:6px; align-items:center;"><input type="checkbox" class="sp-on" data-i="${i}" checked> <strong>${esc(r.ev.title)}</strong>${r.days ? ` <span class="faint">(${r.days} day${r.days === 1 ? '' : 's'})</span>` : ''}</label>
      <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-top:4px;">
        <input type="date" class="sp-start" style="width:auto;" data-i="${i}" value="${esc(r.ev.event_date)}" aria-label="${esc(r.ev.title)} starts">
        <span>to</span>
        <input type="date" class="sp-end" style="width:auto;" data-i="${i}" value="${esc(r.ev.event_end_date || '')}" aria-label="${esc(r.ev.title)} ends">
      </div></div>`;
  const moving = plan.pickup?.event;
  const pickupHtml = plan.pickup ? `<div class="field" style="margin-top:12px;">
      <label style="display:flex; gap:6px; align-items:center;"><input type="checkbox" id="sp-pickup-on" checked> <strong>${moving ? 'Move the pickup' : 'Pickup'}</strong></label>
      ${moving ? `<span class="field-hint">${esc(moving.title || 'The pickup')} on the calendar is ${esc(fmtDate(moving.event_date))}, before the stay ends. Saving moves it.</span>` : ''}
      <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-top:4px;">
        <input type="date" id="sp-pickup" style="width:auto;" value="${esc(plan.pickup.date || '')}" aria-label="Pickup date">
        <input type="time" id="sp-time" style="width:auto;" value="${esc(moving?.details?.placement_time || '')}" aria-label="Pickup time (optional)">
      </div>
      <span class="field-hint">The day after the last stay ends. It moves with the dates above until you change it.</span></div>` : '';
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="sp-title">
        <h2 id="sp-title" style="margin-top:0;">Put ${esc(name)}'s stay on the calendar?</h2>
        <p class="field-hint" style="margin-top:0;">${esc(name)} stays with you after going-home age for this. Log it, and ${plan.pickup ? (moving ? 'move the pickup to' : 'set the pickup for') : 'keep the pickup on'} the day after. Change any date first if you need to.</p>
        <div data-sp-error></div>
        ${rows.map(rowHtml).join('')}
        ${pickupHtml}
        <div class="form-actions">
          <button class="btn btn-primary" data-sp-save>Put it on the calendar</button>
          <button class="btn" data-sp-cancel>Not now</button>
        </div></div>`;
    document.body.appendChild(overlay);
    const q = (s) => overlay.querySelector(s);
    const all = (s) => [...overlay.querySelectorAll(s)];
    let pickupTouched = false;
    // Each stay's end follows its start (its length); the next starts the day after; the
    // pickup follows the last end until she changes it.
    const reflow = (fromIndex) => {
      for (let i = fromIndex; i < rows.length; i++) {
        const start = q(`.sp-start[data-i="${i}"]`);
        const end = q(`.sp-end[data-i="${i}"]`);
        if (i > fromIndex) {
          const prev = [...Array(i).keys()].reverse().find((j) => q(`.sp-on[data-i="${j}"]`).checked);
          const prevEnd = prev != null ? q(`.sp-end[data-i="${prev}"]`).value : '';
          if (YMD.test(prevEnd)) start.value = addDaysToYMD(prevEnd, 1);
        }
        if (rows[i].days && YMD.test(start.value)) end.value = addDaysToYMD(start.value, rows[i].days - 1);
      }
      if (!pickupTouched && q('#sp-pickup')) {
        const ends = rows.map((_, i) => (q(`.sp-on[data-i="${i}"]`).checked ? q(`.sp-end[data-i="${i}"]`).value : '')).filter((d) => YMD.test(d)).sort();
        if (ends.length) q('#sp-pickup').value = addDaysToYMD(ends[ends.length - 1], 1);
      }
    };
    all('.sp-start').forEach((el) => el.addEventListener('change', () => reflow(Number(el.dataset.i))));
    all('.sp-end').forEach((el) => el.addEventListener('change', () => { rows[Number(el.dataset.i)].days = 0; reflow(Number(el.dataset.i) + 1); }));
    all('.sp-on').forEach((el) => el.addEventListener('change', () => reflow(0)));
    q('#sp-pickup')?.addEventListener('change', () => { pickupTouched = true; });
    const done = (v) => { overlay.remove(); resolve(v); };
    q('[data-sp-cancel]').addEventListener('click', () => done(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
    q('[data-sp-save]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const fail = (msg) => { q('[data-sp-error]').innerHTML = `<div class="inline-error">${esc(msg)}</div>`; btn.disabled = false; };
      btn.disabled = true;
      const picked = rows.map((r, i) => ({ r, on: q(`.sp-on[data-i="${i}"]`).checked, start: q(`.sp-start[data-i="${i}"]`).value, end: q(`.sp-end[data-i="${i}"]`).value })).filter((x) => x.on);
      for (const x of picked) {
        if (!YMD.test(x.start)) return fail(`Give ${x.r.ev.title} a start date.`);
        if (x.end && x.end < x.start) return fail(`${x.r.ev.title} can't end before it starts.`);
      }
      const pickupOn = q('#sp-pickup-on')?.checked;
      const date = q('#sp-pickup')?.value || '';
      if (pickupOn && !YMD.test(date)) return fail('Give the pickup a date, or untick it.');
      try {
        for (const x of picked) {
          const ev = { ...x.r.ev, event_date: x.start };
          if (x.end) ev.event_end_date = x.end; else delete ev.event_end_date;
          await eventRepo.create(ev);
        }
        if (pickupOn) {
          const time = q('#sp-time')?.value || '';
          if (moving) await eventRepo.update(moving.id, { event_date: date, details: { ...(moving.details || {}), ...(time ? { placement_time: time } : {}) } });
          else await eventRepo.create(pickupEvent(pup, sale, date, time));
        }
        done(picked.length > 0 || !!pickupOn);
      } catch (err) { fail(err.message || String(err)); }
    });
  });
}
