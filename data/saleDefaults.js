// saleDefaults.js — the expected price/deposit a new Sale prefills from the pup's
// litter (Litter.expected_price_male/_female, expected_deposit_male/_female, by
// the pup's sex), plus the litter's Full-registration surcharge for that sex
// (Litter.full_reg_surcharge_male/_female) when the registration is `full`. One
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
  return {
    price,
    deposit_amount: clean(bySex(litter.expected_deposit_male, litter.expected_deposit_female))
  };
}
