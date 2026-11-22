// saleDefaults.js — the expected price/deposit a new Sale prefills from the pup's
// litter (Litter.expected_price_male/_female, expected_deposit_male/_female, by
// the pup's sex), plus the litter's Full-registration surcharge for that sex
// (Litter.full_reg_surcharge_male/_female) when the registration is `full`, and the
// Full deposit surcharge (Litter.full_reg_deposit_surcharge_male/_female) on the
// deposit the same way. One
// implementation shared by the Sale page (sale.js) and the waitlist's
// accept-an-offer flow (waitlistActions.js, Waitlist Spec §6.5), so the two can
// never prefill differently. Pure; returns nulls when unknown.
//
// `registration` is the sale's registration type; it defaults to the pup's
// intended one (Dog.intended_registration).
export function expectedPricing(dog, litter, registration = dog?.intended_registration) {
  if (!dog || !litter) return { price: null, deposit_amount: null };
  const bySex = (male, female) => (dog.sex === 'male' ? male : dog.sex === 'female' ? female : null);
  const clean = (v) => (v === '' || v === undefined ? null : v);
  let price = clean(bySex(litter.expected_price_male, litter.expected_price_female));
  const surcharge = clean(bySex(litter.full_reg_surcharge_male, litter.full_reg_surcharge_female));
  if (registration === 'full' && price != null && surcharge != null) price = Number(price) + Number(surcharge);
  let deposit = clean(bySex(litter.expected_deposit_male, litter.expected_deposit_female));
  const depositSurcharge = clean(bySex(litter.full_reg_deposit_surcharge_male, litter.full_reg_deposit_surcharge_female));
  if (registration === 'full' && deposit != null && depositSurcharge != null) deposit = Number(deposit) + Number(depositSurcharge);
  return { price, deposit_amount: deposit };
}

// The deposit a sale moves to when its registration changes: the litter's expected
// deposit for the new registration, but only while the sale's deposit is still the
// expected one for the old (she hasn't typed her own) and not yet received. → the new
// deposit, or null to leave it.
export function depositForRegistrationChange(dog, litter, sale, fromReg, toReg) {
  if (!sale || sale.status !== 'deposit_pending') return null;
  const before = expectedPricing(dog, litter, fromReg).deposit_amount;
  const after = expectedPricing(dog, litter, toReg).deposit_amount;
  if (before == null || after == null || Number(before) === Number(after)) return null;
  const now = sale.deposit_amount === '' || sale.deposit_amount == null ? null : Number(sale.deposit_amount);
  return now == null || now === Number(before) ? Number(after) : null;
}

// A reservation agreement's deposit, from its litter's expected deposits
// (contract.html, Reservation): the one for the preferred sex; for Either, the
// two when they agree, else the one that's set, else null (she types it). → number | null.
export function reservationDeposit(litter, prefSex) {
  if (!litter) return null;
  const clean = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const m = clean(litter.expected_deposit_male);
  const f = clean(litter.expected_deposit_female);
  if (prefSex === 'male') return m;
  if (prefSex === 'female') return f;
  if (m != null && f != null) return m === f ? m : null;
  return m ?? f;
}

// The price a sale moves to when its registration changes (decided 2026-10-11):
// the difference between the litter's expected prices for the two registrations
// (the Full surcharge coming or going), applied to the sale's current price so any
// discount she gave stays. `price` is the sale's current price (null/'' = none
// yet: it takes the new expected price). Returns { from, to, delta }, or null when
// the litter's prices don't change between the two (or aren't known).
export function priceForRegistrationChange(dog, litter, price, fromReg, toReg) {
  const before = expectedPricing(dog, litter, fromReg).price;
  const after = expectedPricing(dog, litter, toReg).price;
  if (before == null || after == null) return null;
  const delta = Number(after) - Number(before);
  if (!delta) return null;
  const from = price === '' || price == null ? null : Number(price);
  return { from, to: from == null ? Number(after) : Math.max(0, from + delta), delta };
}
