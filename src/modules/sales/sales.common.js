import Decimal from 'decimal.js';
import { Op, QueryTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import {
  CreditOverride,
  Party,
  PriceList,
  PriceListItem,
  Product,
  ProductUnit,
  ProductVariant,
  StockBatch,
  TaxGroup,
  Unit,
} from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { normalizeLines } from '../inventory/inventory.common.js';
import { OPENING_ATTRIBUTES, roleOpening } from '../parties/party-balance.js';
import { getSettings } from '../settings/settings.service.js';
import { loadGroupRates } from '../taxes/taxes.service.js';
import { calculateTax } from '../taxes/tax.calculator.js';
import { D, fixed, invalid } from '../purchase/purchase.common.js';

export { D, fixed, invalid };
export {
  addDays,
  branchRef,
  dateRange,
  inScope,
  lockDoc,
  userRef,
  warehouseRef,
} from '../purchase/purchase.common.js';

export const salesSettings = (companyId, t) => getSettings(companyId, 'sales', t);

export const customerRef = () => ({
  model: Party,
  as: 'customer',
  attributes: ['id', 'code', 'name', 'email', 'phone', 'paymentTermsDays', 'creditLimit', 'binNo'],
  paranoid: false,
});

/** Includes for sales document lines; `batch` for challan, invoice and return lines. */
export const salesLineIncludes = ({ batch = false, tax = true } = {}) => [
  {
    model: Product,
    as: 'product',
    attributes: [
      'id',
      'name',
      'sku',
      'barcode',
      'hasVariants',
      'trackBatch',
      'trackSerial',
      'trackExpiry',
      'baseUnitId',
    ],
    include: [{ model: Unit, as: 'baseUnit', attributes: ['id', 'code', 'name'] }],
    paranoid: false,
  },
  { model: ProductVariant, as: 'variant', attributes: ['id', 'name', 'sku'], paranoid: false },
  { model: Unit, as: 'unit', attributes: ['id', 'code', 'name'] },
  ...(tax ? [{ model: TaxGroup, as: 'taxGroup', attributes: ['id', 'name', 'code'] }] : []),
  ...(batch ? [{ model: StockBatch, as: 'batch', attributes: ['id', 'batchNo', 'expiryDate'] }] : []),
];

export async function findCustomer(ctx, customerId, t, field = 'customerId') {
  const customer = await Party.findOne({
    where: { id: customerId, companyId: ctx.auth.companyId, isCustomer: true },
    transaction: t,
  });
  if (!customer) throw invalid(field, 'Customer not found');
  if (!customer.isActive) throw invalid(field, `${customer.name} is inactive`);
  return customer;
}

/** Round a total to the configured step ("1" = whole taka) in the configured direction. */
function roundTotal(total, { roundTo, roundingMode }) {
  if (roundTo === 'none') return total;
  const step = D(roundTo);
  const units = total.dividedBy(step);
  const rounded =
    roundingMode === 'up'
      ? units.ceil()
      : roundingMode === 'down'
        ? units.floor()
        : units.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return rounded.times(step);
}

/**
 * Price a sales document.
 *   line:     gross = qty × price; line discount = % of gross or a fixed amount (≤ gross)
 *   document: discount = % of the discounted lines or a fixed amount, spread over the lines by value
 *   tax:      per line from its tax group on the discounted amount; inclusive lines back the tax out
 *   total:    Σ line totals, rounded per Settings → Sales (the difference is the round-off)
 * All amounts are rounded to the company's amount precision.
 */
export async function priceSalesDocument(companyId, lines, header = {}, t) {
  const [{ amountDecimals }, settings] = await Promise.all([
    getSettings(companyId, 'financial', t),
    salesSettings(companyId, t),
  ]);
  const round = (d) => d.toDecimalPlaces(amountDecimals, Decimal.ROUND_HALF_UP);
  const rates = new Map();
  for (const gid of [
    ...new Set(
      lines
        .map((l) => l.taxGroupId)
        .filter(Boolean)
        .map(String),
    ),
  ]) {
    rates.set(gid, await loadGroupRates(companyId, gid, t));
  }

  const staged = lines.map((l, i) => {
    const gross = round(D(l.quantity).times(l.unitPrice ?? 0));
    const type = l.discountType ?? 'percent';
    const value = D(l.discountValue ?? 0);
    if (value.lt(0)) throw invalid(`items.${i}.discountValue`, 'Discount cannot be negative');
    if (type === 'percent' && value.gt(100))
      throw invalid(`items.${i}.discountValue`, 'Discount must be 0–100%');
    const discount =
      type === 'percent' ? round(gross.times(value).dividedBy(100)) : Decimal.min(round(value), gross);
    return { line: l, gross, discount, net: gross.minus(discount), type, value };
  });

  const netSum = staged.reduce((s, x) => s.plus(x.net), D(0));
  const docType = header.discountType ?? 'percent';
  const docValue = D(header.discountValue ?? 0);
  if (docValue.lt(0)) throw invalid('discountValue', 'Discount cannot be negative');
  if (docType === 'percent' && docValue.gt(100)) throw invalid('discountValue', 'Discount must be 0–100%');
  const docDiscount =
    docType === 'percent'
      ? round(netSum.times(docValue).dividedBy(100))
      : Decimal.min(round(docValue), netSum);

  let given = D(0);
  const taxSummary = new Map();
  const priced = staged.map((x, i) => {
    const share =
      i === staged.length - 1
        ? docDiscount.minus(given)
        : netSum.gt(0)
          ? round(docDiscount.times(x.net).dividedBy(netSum))
          : D(0);
    given = given.plus(share);
    const taxable = x.net.minus(share);
    const inclusive = Boolean(x.line.priceIncludesTax);
    const tax = x.line.taxGroupId
      ? calculateTax({
          amount: taxable.toFixed(),
          inclusive,
          decimals: amountDecimals,
          rates: rates.get(String(x.line.taxGroupId)),
        })
      : { netAmount: taxable.toFixed(), totalTax: '0', total: taxable.toFixed(), taxes: [] };
    for (const r of tax.taxes) taxSummary.set(r.name, D(taxSummary.get(r.name)).plus(r.amount));
    return {
      ...x.line,
      discountType: x.type,
      discountValue: fixed(x.value),
      discountAmount: fixed(x.discount),
      documentDiscount: fixed(share),
      priceIncludesTax: inclusive,
      taxAmount: fixed(tax.totalTax),
      lineSubtotal: fixed(tax.netAmount),
      lineTotal: fixed(tax.total),
      gross: x.gross,
    };
  });

  const beforeRounding = priced.reduce((s, l) => s.plus(l.lineTotal), D(0));
  const total = roundTotal(beforeRounding, settings);
  return {
    lines: priced,
    totals: {
      discountType: docType,
      discountValue: fixed(docValue),
      subtotal: fixed(staged.reduce((s, x) => s.plus(x.gross), D(0))),
      discountTotal: fixed(staged.reduce((s, x) => s.plus(x.discount), D(0)).plus(docDiscount)),
      taxTotal: fixed(priced.reduce((s, l) => s.plus(l.taxAmount), D(0))),
      roundOff: fixed(total.minus(beforeRounding)),
      total: fixed(total),
      taxes: [...taxSummary.entries()].map(([name, amount]) => ({
        name,
        amount: fixed(amount, amountDecimals),
      })),
      pricesIncludeTax: priced.some((l) => l.priceIncludesTax),
    },
  };
}

/** Columns a priced line stores. */
export const pricedColumns = (l) => ({
  unitPrice: fixed(l.unitPrice ?? 0),
  discountType: l.discountType,
  discountValue: l.discountValue,
  discountAmount: l.discountAmount,
  documentDiscount: l.documentDiscount,
  taxGroupId: l.taxGroupId ?? null,
  priceIncludesTax: l.priceIncludesTax,
  taxAmount: l.taxAmount,
  lineSubtotal: l.lineSubtotal,
  lineTotal: l.lineTotal,
});

export const totalsColumns = (totals) => ({
  discountType: totals.discountType,
  discountValue: totals.discountValue,
  subtotal: totals.subtotal,
  discountTotal: totals.discountTotal,
  taxTotal: totals.taxTotal,
  roundOff: totals.roundOff,
  total: totals.total,
});

/**
 * Selling price of items for a customer: the best active price list of the customer's group
 * (highest priority; a matching unit beats a base-unit row, which is scaled by the unit factor),
 * else the standard sale price (pack price → variant price → product price × factor).
 * Also returns the product's tax group and whether its price includes tax.
 */
export async function resolvePrices(ctx, { customerId, date, items }, t) {
  const companyId = ctx.auth.companyId;
  const customer = customerId
    ? await Party.findOne({
        where: { id: customerId, companyId },
        attributes: ['id', 'customerGroupId'],
        transaction: t,
      })
    : null;
  const productIds = [...new Set(items.map((i) => String(i.productId)))];
  const [products, lists] = await Promise.all([
    Product.findAll({
      where: { id: productIds, companyId },
      attributes: ['id', 'salePrice', 'baseUnitId', 'taxGroupId', 'priceIncludesTax'],
      include: [
        { model: ProductUnit, as: 'units', attributes: ['unitId', 'factor', 'salePrice'] },
        { model: ProductVariant, as: 'variants', attributes: ['id', 'salePrice'] },
      ],
      transaction: t,
    }),
    customer?.customerGroupId
      ? PriceList.findAll({
          where: {
            companyId,
            customerGroupId: customer.customerGroupId,
            isActive: true,
            [Op.and]: [
              { [Op.or]: [{ validFrom: null }, { validFrom: { [Op.lte]: date } }] },
              { [Op.or]: [{ validTo: null }, { validTo: { [Op.gte]: date } }] },
            ],
          },
          include: [{ model: PriceListItem, as: 'items', where: { productId: productIds }, required: false }],
          order: [
            ['priority', 'DESC'],
            ['id', 'ASC'],
          ],
          transaction: t,
        })
      : [],
  ]);
  const productOf = new Map(products.map((p) => [String(p.id), p]));

  return items.map((it) => {
    const p = productOf.get(String(it.productId));
    if (!p) return null;
    const unitId = String(it.unitId ?? p.baseUnitId);
    const pack = p.units.find((u) => String(u.unitId) === unitId);
    const factor = D(pack?.factor ?? 1);
    const variant = it.variantId ? p.variants.find((v) => String(v.id) === String(it.variantId)) : null;
    const baseSale = D(variant?.salePrice ?? p.salePrice);
    const standard = pack?.salePrice != null ? D(pack.salePrice) : baseSale.times(factor);
    const qty = D(it.quantity ?? 1).times(factor);

    let price = standard;
    let source = { type: 'standard' };
    for (const list of lists) {
      const rows = list.items.filter(
        (r) =>
          String(r.productId) === String(it.productId) &&
          String(r.variantId ?? '') === String(it.variantId ?? '') &&
          D(r.minQuantity).lte(qty),
      );
      const exact = rows.find((r) => String(r.unitId ?? p.baseUnitId) === unitId);
      const base = rows.find((r) => !r.unitId || String(r.unitId) === String(p.baseUnitId));
      const row = exact ?? base;
      if (!row) continue;
      const scale = exact ? D(1) : factor;
      price =
        row.price != null
          ? D(row.price).times(scale)
          : standard.times(D(100).minus(row.discountPercent ?? 0)).dividedBy(100);
      source = { type: 'price_list', id: String(list.id), name: list.name };
      break;
    }
    return {
      productId: String(it.productId),
      variantId: it.variantId ? String(it.variantId) : null,
      unitId,
      unitPrice: fixed(price),
      standardPrice: fixed(standard),
      taxGroupId: p.taxGroupId ? String(p.taxGroupId) : null,
      priceIncludesTax: Boolean(p.priceIncludesTax),
      source,
    };
  });
}

/** What the customer owes: opening (debit) + posted invoices − receipts − credit notes/returns. */
export async function customerOutstanding(companyId, customerId, t) {
  const [row] = await sequelize.query(
    `SELECT
       (SELECT COALESCE(SUM(total), 0) FROM sales_invoices
         WHERE company_id = :companyId AND customer_id = :customerId AND status IN ('unpaid', 'partially_paid', 'paid') AND deleted_at IS NULL)
     - (SELECT COALESCE(SUM(amount), 0) FROM customer_receipts
         WHERE company_id = :companyId AND customer_id = :customerId AND status = 'posted' AND deleted_at IS NULL)
     - (SELECT COALESCE(SUM(total - refunded_amount), 0) FROM sales_returns
         WHERE company_id = :companyId AND customer_id = :customerId AND status = 'posted' AND deleted_at IS NULL) AS balance`,
    { replacements: { companyId, customerId }, type: QueryTypes.SELECT, transaction: t },
  );
  const party = await Party.findByPk(customerId, { attributes: OPENING_ATTRIBUTES, transaction: t });
  return roleOpening(party, 'customer').plus(row.balance);
}

/**
 * Credit limit check for a new order/invoice amount. Above the limit the document is refused,
 * unless `override.reason` is given by a user with sales.approve — then the override is logged.
 */
export async function assertCreditLimit(ctx, { customer, amount, documentType, documentId, override }, t) {
  const { creditCheck } = await salesSettings(ctx.auth.companyId, t);
  const limit = D(customer.creditLimit);
  // Nothing left on account (e.g. a POS sale paid in full): no check.
  if (!creditCheck || limit.lte(0) || D(amount).lte(0)) return null;
  const outstanding = await customerOutstanding(ctx.auth.companyId, customer.id, t);
  const after = outstanding.plus(amount);
  if (after.lte(limit)) return null;

  const canOverride = ctx.auth.permissions.includes('*') || ctx.auth.permissions.includes('sales.approve');
  const message = `${customer.name} would owe ${after.toFixed(2)}, above the credit limit of ${limit.toFixed(2)} (outstanding ${outstanding.toFixed(2)})`;
  if (!override?.reason) {
    throw new AppError(message, 422, [
      {
        field: 'creditOverride',
        message: canOverride ? 'Give a reason to override the credit limit' : 'Credit limit exceeded',
      },
    ]);
  }
  if (!canOverride)
    throw AppError.forbidden('Overriding the credit limit needs the sales.approve permission');
  return CreditOverride.create(
    {
      companyId: ctx.auth.companyId,
      customerId: customer.id,
      documentType,
      documentId,
      creditLimit: fixed(limit),
      outstanding: fixed(outstanding),
      documentAmount: fixed(amount),
      reason: override.reason,
      userId: ctx.auth.userId,
    },
    { transaction: t },
  );
}

/** The branch a new document belongs to when it has no warehouse: the selected or default branch. */
export function currentBranch(ctx) {
  const id = ctx.branchId ?? ctx.auth.branches?.find((b) => b.isDefault)?.id ?? ctx.auth.branchIds?.[0];
  if (!id) throw AppError.forbidden('You have no branch to record this for');
  return id;
}

/** Fill unit price / tax group of lines that don't have them from resolvePrices(). */
export async function withPrices(ctx, customerId, date, lines, t) {
  const missing = lines.filter((l) => l.unitPrice == null || l.unitPrice === '');
  if (!missing.length && lines.every((l) => l.taxGroupId !== undefined && l.priceIncludesTax !== undefined))
    return lines;
  const prices = await resolvePrices(ctx, { customerId, date, items: lines }, t);
  return lines.map((l, i) => ({
    ...l,
    unitPrice: l.unitPrice == null || l.unitPrice === '' ? (prices[i]?.unitPrice ?? '0') : l.unitPrice,
    taxGroupId: l.taxGroupId !== undefined ? l.taxGroupId : (prices[i]?.taxGroupId ?? null),
    priceIncludesTax:
      l.priceIncludesTax !== undefined ? l.priceIncludesTax : (prices[i]?.priceIncludesTax ?? false),
  }));
}

/**
 * Validate lines (product, variant, unit → base quantity), fill missing prices from the price
 * lists, and price the document. Returns { lines, totals } ready to store.
 */
export async function prepareLines(
  ctx,
  { customerId, date, items, header },
  t,
  { allowNewBatch = false } = {},
) {
  const normalized = await normalizeLines(ctx, items, t, { allowNewBatch });
  const withP = await withPrices(ctx, customerId, date, normalized, t);
  return priceSalesDocument(ctx.auth.companyId, withP, header, t);
}

/**
 * A new line for `leftBase` base units of a source line (conversion to the next document).
 * Keeps the source unit when the quantity is a whole number of it, else uses the base unit;
 * the price and a fixed-amount discount are scaled to match.
 */
export function convertLine(item, leftBase, extra = {}) {
  const left = D(leftBase);
  const factor = D(item.unitFactor);
  const inUnit = left.dividedBy(factor);
  const sameUnit = inUnit.isInteger() || factor.eq(1);
  const share = D(item.baseQuantity).gt(0) ? left.dividedBy(item.baseQuantity) : D(1);
  return {
    productId: String(item.productId),
    variantId: item.variantId ? String(item.variantId) : null,
    unitId: sameUnit ? item.unitId : null,
    quantity: sameUnit ? inUnit.toFixed() : left.toFixed(),
    unitPrice: sameUnit ? item.unitPrice : D(item.unitPrice).dividedBy(factor).toFixed(4),
    discountType: item.discountType,
    discountValue:
      item.discountType === 'amount' ? fixed(D(item.discountValue).times(share)) : item.discountValue,
    taxGroupId: item.taxGroupId ? String(item.taxGroupId) : null,
    priceIncludesTax: item.priceIncludesTax,
    notes: item.notes ?? null,
    ...extra,
  };
}
