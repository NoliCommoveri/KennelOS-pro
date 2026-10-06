// saleDefaults.js — the expected price/deposit a new Sale prefills from the pup's
// litter (Litter.expected_price_male/_female, expected_deposit_male/_female, by
// the pup's sex). One implementation shared by the Sale page (sale.js) and the
// waitlist's accept-an-offer flow (waitlistActions.js, Waitlist Spec §6.5), so
// the two can never prefill differently. Pure; returns nulls when unknown.
export function expectedPricing(dog, litter) {
  if (!dog || !litter) return { price: null, deposit_amount: null };
  const bySex = (male, female) => (dog.sex === 'male' ? male : dog.sex === 'female' ? female : null);
  const clean = (v) => (v === '' || v === undefined ? null : v);
  return {
    price: clean(bySex(litter.expected_price_male, litter.expected_price_female)),
    deposit_amount: clean(bySex(litter.expected_deposit_male, litter.expected_deposit_female))
  };
}
