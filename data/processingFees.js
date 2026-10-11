// processingFees.js — the arithmetic of a sales channel's processing fee
// (Integrations plan §5): Good Dog, Stripe, Square… keep a percentage of what the
// buyer pays, plus a fixed amount per payment, and either part may be zero
// (a marketplace's 6.25% + $5, a card processor's 2.9% + $0.30, a flat $25
// listing fee).
//
// A rate is { percent, fixed }: `percent` as typed (6.25 = 6.25%), `fixed` in
// dollars. It lives on the channel's Account (fee_percent / fee_fixed); a Sale
// keeps the fee it actually paid as a stored snapshot (processing_fee_amount),
// so a later rate change never rewrites an old sale. Pure; no db.

const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
const cents = (n) => Math.round(n * 100) / 100;

// The rate an Account carries, or null when it has none (both parts blank or 0).
export function feeRate(account) {
  if (!account) return null;
  const percent = num(account.fee_percent);
  const fixed = num(account.fee_fixed);
  return percent || fixed ? { percent, fixed } : null;
}

// Is this a rate we can compute with? A percentage of 100 or more would keep the
// whole payment, so no price could ever net anything.
export function isUsableRate(rate) {
  return !!rate && Number.isFinite(rate.percent) && Number.isFinite(rate.fixed)
    && rate.percent >= 0 && rate.percent < 100 && rate.fixed >= 0 && (rate.percent > 0 || rate.fixed > 0);
}

// The fee kept on a payment of `amount`: amount × percent + fixed, to the cent.
// Null when there's no amount or no usable rate.
export function processingFee(amount, rate) {
  const a = num(amount);
  if (!(a > 0) || !isUsableRate(rate)) return null;
  return cents(a * rate.percent / 100 + rate.fixed);
}

// The price that leaves `net` after the fee: (net + fixed) ÷ (1 − percent).
// Adding the percentage on top is NOT enough, because the fee is taken from the
// larger price: to net $3,000 at 6.25% the price is $3,200, not $3,187.50 (which
// nets $2,988.28). Rounded UP to the cent, so the net never falls short.
export function priceToNet(net, rate) {
  const n = num(net);
  if (!(n > 0) || !isUsableRate(rate)) return null;
  const exact = (n + rate.fixed) / (1 - rate.percent / 100);
  // The epsilon keeps a price that is already whole cents (3200.0000000004) from
  // being bumped up a cent by floating-point noise.
  return Math.ceil(exact * 100 - 1e-6) / 100;
}

// What she keeps of `price` after `fee` (either may be blank).
export function netOf(price, fee) {
  return cents(num(price) - num(fee));
}

// "6.25% + $5.00", "2.9% + $0.30", "$25.00", "6.25%" — for a card or a hint.
export function rateLabel(rate) {
  if (!rate) return '';
  const pct = rate.percent ? `${Number(rate.percent.toFixed(4))}%` : '';
  const fixed = rate.fixed ? `$${rate.fixed.toFixed(2)}` : '';
  return [pct, fixed].filter(Boolean).join(' + ');
}
