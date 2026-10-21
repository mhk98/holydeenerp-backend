import Decimal from 'decimal.js';
import { Op } from 'sequelize';
import {
  Branch,
  Party,
  Product,
  ProductVariant,
  PurchaseApproval,
  StockBatch,
  TaxGroup,
  Unit,
  User,
  Warehouse,
} from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { getSettings } from '../settings/settings.service.js';
import { loadGroupRates } from '../taxes/taxes.service.js';
import { calculateTax } from '../taxes/tax.calculator.js';
import { invalid } from '../inventory/inventory.common.js';

export const D = (v) => new Decimal(v ?? 0);
export const fixed = (v, dp = 4) => D(v).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toFixed(dp);

export const purchaseSettings = (companyId, t) => getSettings(companyId, 'purchase', t);

/** Add days to a YYYY-MM-DD date. */
export function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

export async function findSupplier(ctx, supplierId, t, field = 'supplierId') {
  const supplier = await Party.findOne({
    where: { id: supplierId, companyId: ctx.auth.companyId, isSupplier: true },
    transaction: t,
  });
  if (!supplier) throw invalid(field, 'Supplier not found');
  if (!supplier.isActive) throw invalid(field, `${supplier.name} is inactive`);
  return supplier;
}

/**
 * Price document lines: subtotal = quantity × price × (1 − discount%), tax from the line's tax
 * group (prices exclude tax), all rounded to the company's amount precision.
 * Returns { lines (with lineSubtotal, taxAmount, lineTotal, taxes[]), totals }.
 */
export async function priceLines(companyId, lines, t) {
  const { amountDecimals } = await getSettings(companyId, 'financial', t);
  const round = (d) => d.toDecimalPlaces(amountDecimals, Decimal.ROUND_HALF_UP);
  const groupIds = [
    ...new Set(
      lines
        .map((l) => l.taxGroupId)
        .filter(Boolean)
        .map(String),
    ),
  ];
  const rates = new Map();
  for (const id of groupIds) rates.set(id, await loadGroupRates(companyId, id, t));

  let subtotal = D(0);
  let discountTotal = D(0);
  let taxTotal = D(0);
  const taxSummary = new Map();
  const priced = lines.map((l, i) => {
    const discount = D(l.discountPercent ?? 0);
    if (discount.lt(0) || discount.gt(100))
      throw invalid(`items.${i}.discountPercent`, 'Discount must be 0–100%');
    const gross = D(l.quantity).times(l.unitPrice ?? 0);
    const lineDiscount = round(gross.times(discount).dividedBy(100));
    const lineSubtotal = round(gross).minus(lineDiscount);
    const tax = l.taxGroupId
      ? calculateTax({
          amount: lineSubtotal.toFixed(),
          decimals: amountDecimals,
          rates: rates.get(String(l.taxGroupId)),
        })
      : { totalTax: '0', taxes: [] };
    for (const x of tax.taxes) {
      const key = x.name ?? x.id;
      taxSummary.set(key, D(taxSummary.get(key)).plus(x.amount));
    }
    subtotal = subtotal.plus(round(gross));
    discountTotal = discountTotal.plus(lineDiscount);
    taxTotal = taxTotal.plus(tax.totalTax);
    return {
      ...l,
      discountPercent: fixed(discount),
      lineSubtotal: fixed(lineSubtotal),
      taxAmount: fixed(tax.totalTax),
      lineTotal: fixed(lineSubtotal.plus(tax.totalTax)),
    };
  });
  return {
    lines: priced,
    totals: {
      subtotal: fixed(subtotal),
      discountTotal: fixed(discountTotal),
      taxTotal: fixed(taxTotal),
      total: fixed(subtotal.minus(discountTotal).plus(taxTotal)),
      taxes: [...taxSummary.entries()].map(([name, amount]) => ({
        name,
        amount: fixed(amount, amountDecimals),
      })),
    },
  };
}

/** Approval levels an order of `total` needs, from Settings → Purchase (snapshotted on submit). */
export async function approvalPlanFor(companyId, total, t) {
  const { approvalLevels } = await purchaseSettings(companyId, t);
  return approvalLevels
    .filter((l) => D(l.minAmount).lte(total))
    .map((l, i) => ({ level: i + 1, name: l.name, minAmount: l.minAmount, roleId: l.roleId ?? null }));
}

/**
 * May this user approve this level? Needs the level's role (if any), and a user approves only one
 * level per submission (approvals from before a rejection don't count).
 */
export async function assertCanApproveLevel(ctx, { documentType, documentId, level, since }, t) {
  if (ctx.auth.isSuperAdmin) return;
  if (level.roleId) {
    const roles = (ctx.auth.ctx?.user?.roles ?? []).map((r) => String(r.id));
    if (!roles.includes(String(level.roleId))) {
      throw AppError.forbidden(`Level "${level.name}" must be approved by another role`);
    }
  }
  const already = await PurchaseApproval.count({
    where: {
      documentType,
      documentId,
      userId: ctx.auth.userId,
      action: 'approved',
      ...(since && { createdAt: { [Op.gte]: since } }),
    },
    transaction: t,
  });
  if (already)
    throw AppError.forbidden('You already approved a level of this document; another approver is needed');
}

export async function recordApproval(ctx, { documentType, documentId, level, levelName, action, note }, t) {
  await PurchaseApproval.create(
    {
      companyId: ctx.auth.companyId,
      documentType,
      documentId,
      level,
      levelName: levelName ?? null,
      action,
      userId: ctx.auth.userId,
      note: note ?? null,
    },
    { transaction: t },
  );
}

export async function approvalHistory(documentType, documentId) {
  const rows = await PurchaseApproval.findAll({
    where: { documentType, documentId },
    include: [{ model: User, as: 'user', attributes: ['id', 'name'] }],
    order: [['id', 'ASC']],
  });
  return rows.map((r) => r.toJSON());
}

export const userRef = (as) => ({ model: User, as, attributes: ['id', 'name'] });
export const supplierRef = () => ({
  model: Party,
  as: 'supplier',
  attributes: ['id', 'code', 'name', 'email', 'phone', 'paymentTermsDays'],
  paranoid: false,
});
export const warehouseRef = () => ({
  model: Warehouse,
  as: 'warehouse',
  attributes: ['id', 'name', 'code', 'branchId'],
  paranoid: false,
});
export const branchRef = () => ({ model: Branch, as: 'branch', attributes: ['id', 'name', 'code'] });
/** Includes for purchase document lines; `batch` only for GRN and return lines. */
export const purchaseLineIncludes = ({ batch = false, tax = true } = {}) => [
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
  ...(batch
    ? [{ model: StockBatch, as: 'batch', attributes: ['id', 'batchNo', 'expiryDate', 'mfgDate'] }]
    : []),
];

/** Branch scope for documents (the switcher narrows lists). */
export const inScope = (ctx) => ({ branchId: { [Op.in]: ctx.branchIds.length ? ctx.branchIds : [0] } });

/** Lock a document for a state change and check its status. */
export async function lockDoc(model, ctx, id, t, { label, allowed }) {
  const doc = await model.findOne({
    where: { id, companyId: ctx.auth.companyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!doc) throw AppError.notFound(`${label} not found`);
  if (allowed && !allowed.includes(doc.status)) {
    throw AppError.conflict(`${label} is ${doc.status.replaceAll('_', ' ')}; this action is not allowed`);
  }
  return doc;
}

/** Date range filter for list queries. */
export function dateRange(field, query) {
  if (!query.from && !query.to) return {};
  return {
    [field]: { ...(query.from && { [Op.gte]: query.from }), ...(query.to && { [Op.lte]: query.to }) },
  };
}

export { invalid };
