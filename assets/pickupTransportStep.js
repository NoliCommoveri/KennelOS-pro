// pickupTransportStep.js — Kels's pickup and transport screen (Pro, editionFlags.waitlist),
// a step of "Set up my waitlist" (assets/waitlistSetupUI.js): her standard pickup
// location (where every mileage figure starts) and the settings that work out a
// family's transport fee (data/transportFee.js) and decide who may suggest their own
// meetup place (Family Requests plan §4–§5). The Kennel page's Pickup places card
// edits the same things, with any other places she has. After saving, a worked
// example shows what her settings charge.
import { kennelRepo } from '../data/kennelRepo.js';
import { waitlistConfig, waitlistConfigProblem } from '../data/waitlistRules.js';
import { pickupLocations, standardLocation, locationsProblem } from '../data/pickupSlots.js';
import { transportQuote, MILEAGE_BASIS } from '../data/transportFee.js';
import { field } from './litterCheckinUI.js';
import { esc } from './ui.js';

const numOrNull = (v) => (String(v ?? '').trim() === '' ? null : Number(v));
const opt = (value, label, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
const numInput = (id, v, unit, attrs = '') => `<span style="display:inline-flex; align-items:center; gap:6px;"><input id="${id}" type="number" min="0" step="any" inputmode="decimal" value="${esc(v ?? '')}" style="width:7em;"${attrs}> ${esc(unit)}</span>`;

// What her settings charge at a few distances, in a sentence or two.
export function transportExample(config) {
  const c = config;
  const far = Number(c.transport_far_miles) > 0 ? Number(c.transport_far_miles) : null;
  const sample = far ? Math.max(10, Math.min(60, Math.round(far / 2))) : 60;
  const q = transportQuote(sample, c);
  const lines = [];
  if (q.fee != null) lines.push(`A family ${sample} miles away: ${q.text}.`);
  else lines.push('No fee per mile is set, so I won\'t suggest a transport fee. You can still type one when you approve a request.');
  if (far) lines.push(`A family more than ${far} miles away is told you'll be in touch about driving or a flight nanny.`);
  if (Number(c.transport_min_home_miles) > 0) lines.push(`Only families living at least ${c.transport_min_home_miles} miles away can suggest their own meetup place, so City / state becomes a required question on your application form.`);
  return lines.join(' ');
}

// The screen. → true when something was saved.
export async function askPickupTransport(chat, kennel) {
  const c = waitlistConfig(kennel);
  const places = pickupLocations(kennel);
  const std = standardLocation(kennel) || { id: '', label: '', address: '', notes: '', show_to_families: true };
  const others = places.filter((l) => !l.is_standard);
  const res = await chat.form({
    title: '<strong>Pickup and transport.</strong><span class="kels-lead">Where families pick up, and what you charge to bring a pup to them.</span>',
    html: `<fieldset class="ws-group"><legend>Your standard pickup location</legend>
        <p class="field-hint">Every mileage figure starts here. Use a public place near you, like a library or store parking lot, not your home address.${others.length ? ` Your ${others.length} other place${others.length === 1 ? '' : 's'} stay${others.length === 1 ? 's' : ''} as ${others.length === 1 ? 'it is' : 'they are'}; change them on your kennel's Pickup places.` : ''}</p>
        <div class="ck-inline">
          ${field('Name', `<input id="pt-label" type="text" value="${esc(std.label)}" placeholder="e.g. Library parking lot">`)}
          ${field('Address', `<input id="pt-address" type="text" value="${esc(std.address)}" placeholder="Street, city, state">`)}
        </div>
        ${field('Notes for families (optional)', `<input id="pt-notes" type="text" value="${esc(std.notes)}" placeholder="e.g. by the north entrance">`)}
        <label class="check-inline ws-check"><input type="checkbox" id="pt-show"${std.show_to_families !== false ? ' checked' : ''}> Show this place to families</label>
      </fieldset>
      <fieldset class="ws-group"><legend>Transport fee</legend>
        <p class="field-hint">For a family's own meetup address. KennelOS measures the driving miles from your standard location (signed in to cloud backup) and suggests the fee, which you can change before approving.</p>
        <div class="ck-inline">
          ${field('Fee per mile', numInput('pt-rate', c.mileage_rate, '$ a mile'), 'Blank: no fee worked out.')}
          ${field('Count the miles', `<select id="pt-basis">${MILEAGE_BASIS.map((b) => opt(b.value, b.label, b.value === c.mileage_basis)).join('')}</select>`, 'Round trip doubles them.')}
        </div>
        <div class="ck-inline">
          ${field('No charge under', numInput('pt-free', c.mileage_free_under || '', 'miles'), 'A shorter trip is free; at or over it, every mile counts.')}
          ${field('Families can suggest their own meetup place if they live at least', numInput('pt-home', c.transport_min_home_miles || '', 'miles away'), 'Blank or 0: any family can.')}
        </div>
        <div class="ck-inline">
          ${field('Farther than this, you\'ll be in touch', numInput('pt-far', c.transport_far_miles, 'miles'), 'About driving or a flight nanny.')}
          ${field('Families can change their pickup time until', numInput('pt-change', c.pickup_change_days, 'days before'))}
        </div>
        ${field('Standard boarding rate (optional)', numInput('pt-board', c.boarding_rate, '$ a day'), 'For a pickup date you mark "standard boarding applies" on a litter.')}
      </fieldset>`,
    submitLabel: 'Save',
    cancelLabel: 'Skip this',
    submit: async (root) => {
      const q = (s) => root.querySelector(s);
      const row = { id: std.id || crypto.randomUUID(), label: q('#pt-label').value.trim(), address: q('#pt-address').value.trim(), notes: q('#pt-notes').value.trim(), is_standard: true, show_to_families: q('#pt-show').checked };
      const placeProblem = locationsProblem([row]);
      if (placeProblem) return placeProblem;
      const fresh = await kennelRepo.getById(kennel.id);
      const config = {
        ...(fresh.waitlist_config || {}),
        mileage_rate: numOrNull(q('#pt-rate').value),
        mileage_basis: q('#pt-basis').value,
        mileage_free_under: numOrNull(q('#pt-free').value) || 0,
        transport_min_home_miles: numOrNull(q('#pt-home').value) || 0,
        transport_far_miles: numOrNull(q('#pt-far').value),
        pickup_change_days: numOrNull(q('#pt-change').value) ?? 2,
        boarding_rate: numOrNull(q('#pt-board').value)
      };
      const problem = waitlistConfigProblem(waitlistConfig({ waitlist_config: config }));
      if (problem) return problem;
      // Her standard place replaced (or added, when she typed one), the others kept.
      const rest = pickupLocations(fresh).filter((l) => !l.is_standard).map((l) => ({ ...l, is_standard: false }));
      const list = row.label ? [row, ...rest] : rest;
      await kennelRepo.update(kennel.id, { waitlist_config: config, pickup_locations: pickupLocations({ pickup_locations: list }) });
      return { config: waitlistConfig({ waitlist_config: config }), place: row.label ? row : null };
    },
    reply: (r) => (r.place ? `Pickup at ${r.place.label}` : 'Saved')
  });
  if (!res.done) return false;
  await chat.say(esc(transportExample(res.result.config)), { typing: 500 });
  return true;
}
