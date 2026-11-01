// transportFee.js — the transport fee for a family's own meetup address, from the
// driving miles (docs/KennelOS_Family_Requests_Plan.md §5), and the Open in Maps
// link that checks a figure without any service. Pure: no db, no network.
//
// Her settings (Kennel.waitlist_config, defaults in waitlistRules):
//   mileage_rate        fee per mile (blank = no fee worked out)
//   mileage_basis       'one_way' | 'round_trip' (round trip doubles the miles)
//   mileage_free_under  a trip under this many miles is free; at or over it every
//                       mile is charged, from the first (compared after doubling)
//   transport_far_miles over this, "she'll be in touch" (transport options)

export const MILEAGE_BASIS = Object.freeze([
  { value: 'one_way', label: 'One way' },
  { value: 'round_trip', label: 'Round trip' }
]);

const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const money = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const miles = (n) => `${Math.round(n).toLocaleString('en-US')} mile${Math.round(n) === 1 ? '' : 's'}`;

// The fee for a trip of `oneWay` miles. → { charged_miles, fee (null = no rate),
// free, far, text } where `text` shows the working:
// "340 miles one way × 2 (round trip) = 680 × $1.50 = $1,020.00", or
// "18 miles: under your 25, no charge".
export function transportQuote(oneWay, config = {}) {
  // Whole miles, so the working always adds up ("196 × 2 = 392").
  const m = Math.round(Math.max(0, Number(oneWay) || 0));
  const round = config.mileage_basis !== 'one_way';
  const charged = round ? m * 2 : m;
  const rate = num(config.mileage_rate);
  const freeUnder = num(config.mileage_free_under) || 0;
  const far = num(config.transport_far_miles);
  const out = { charged_miles: Math.round(charged), fee: null, free: false, far: far != null && far > 0 && m > far, text: '' };
  const base = round ? `${miles(m)} one way × 2 (round trip) = ${Math.round(charged).toLocaleString('en-US')}` : `${miles(m)} one way`;
  if (freeUnder > 0 && charged < freeUnder) {
    return { ...out, fee: 0, free: true, text: `${round ? `${miles(m)} one way, ${miles(charged)} round trip` : miles(m)}: under your ${freeUnder}, no charge` };
  }
  if (rate == null || rate <= 0) return { ...out, text: `${base}. Set a fee per mile in Waitlist settings to work out the fee.` };
  const fee = Math.round(Math.round(charged) * rate * 100) / 100;
  return { ...out, fee, text: `${base} × ${money(rate)} = ${money(fee)}` };
}

// "about 340 miles" for a family and the transport options email.
export const aboutMiles = (m) => `about ${miles(m)}`;

// A directions link from one address to another (no API: it opens the person's own
// maps), to check a figure or to get there.
export function mapsLink(from, to) {
  const q = new URLSearchParams({ api: '1', ...(from ? { origin: String(from) } : {}), destination: String(to || '') });
  return `https://www.google.com/maps/dir/?${q.toString()}`;
}
