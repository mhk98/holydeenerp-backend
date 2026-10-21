import Decimal from 'decimal.js';

/**
 * Tax calculation for a tax group. Pure function — no database access, so every
 * module (sales, purchase, POS) computes taxes identically.
 *
 * Rates apply in `sequence` order. A non-compound rate is charged on the net amount;
 * a compound rate on net + all taxes before it (Bangladesh: VAT on the SD-inclusive value).
 *
 *   exclusive: amount is the net price → taxes are added on top
 *   inclusive: amount already contains the taxes → net is backed out
 *
 * Each tax is rounded to `decimals`; with inclusive pricing the net absorbs the rounding
 * so that net + taxes always equals the original amount exactly.
 *
 * @param {{ amount: string|number, inclusive?: boolean, decimals?: number,
 *           rates: { id?: string, name?: string, rate: string|number, isCompound?: boolean, sequence?: number }[] }} input
 */
export function calculateTax({ amount, inclusive = false, decimals = 2, rates }) {
  const ordered = [...rates].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const round = (d) => d.toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);

  /** Taxes for a given net, unrounded. */
  const taxesFor = (net) => {
    let running = net;
    return ordered.map((r) => {
      const taxable = r.isCompound ? running : net;
      const tax = taxable.times(r.rate).dividedBy(100);
      running = running.plus(tax);
      return { taxable, tax };
    });
  };

  const gross = new Decimal(amount);
  let net;
  if (inclusive) {
    // total(net) is linear in net: total = net × factor, where factor = total(1).
    const factor = taxesFor(new Decimal(1)).reduce((sum, t) => sum.plus(t.tax), new Decimal(1));
    net = gross.dividedBy(factor);
  } else {
    net = gross;
  }

  const raw = taxesFor(net);
  const taxes = ordered.map((r, i) => ({
    id: r.id ?? null,
    name: r.name ?? null,
    rate: new Decimal(r.rate).toFixed(4),
    isCompound: Boolean(r.isCompound),
    taxableAmount: round(raw[i].taxable).toFixed(decimals),
    amount: round(raw[i].tax).toFixed(decimals),
  }));
  const totalTax = taxes.reduce((sum, t) => sum.plus(t.amount), new Decimal(0));

  const netAmount = inclusive ? gross.minus(totalTax) : round(net);
  const total = inclusive ? gross : netAmount.plus(totalTax);

  return {
    inclusive,
    netAmount: round(netAmount).toFixed(decimals),
    totalTax: totalTax.toFixed(decimals),
    total: round(total).toFixed(decimals),
    /** Effective combined rate in percent (e.g. SD 20% + VAT 15% compound = 38%). */
    effectiveRate: taxesFor(new Decimal(100))
      .reduce((s, t) => s.plus(t.tax), new Decimal(0))
      .toFixed(4),
    taxes,
  };
}
