import Decimal from 'decimal.js';
import { Op } from 'sequelize';
import {
  Branch,
  Company,
  Product,
  ProductUnit,
  ProductVariant,
  StockBalance,
  StockBatch,
  Unit,
  User,
  Warehouse,
} from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { getSettings } from '../settings/settings.service.js';
import { batchQuantity, D, fixed4, isLotTracked } from './stock.engine.js';

export const invalid = (field, message) => AppError.unprocessable(message, [{ field, message }]);

export const inventorySettings = (companyId, t) => getSettings(companyId, 'inventory', t);

/** Today's date (YYYY-MM-DD) in the company's timezone. */
export async function companyToday(companyId) {
  const company = await Company.findByPk(companyId, { attributes: ['timezone'] });
  return new Intl.DateTimeFormat('en-CA', { timeZone: company?.timezone ?? 'Asia/Dhaka' }).format(new Date());
}

/** Warehouses the request can see (its branches, narrowed by the branch switcher). */
export async function visibleWarehouseIds(ctx) {
  const rows = await Warehouse.findAll({
    where: {
      companyId: ctx.auth.companyId,
      branchId: { [Op.in]: ctx.branchIds.length ? ctx.branchIds : [0] },
    },
    attributes: ['id'],
    raw: true,
  });
  return rows.map((r) => String(r.id));
}

/**
 * A warehouse the user may post stock in: same company, active, and in one of the user's
 * branches (all of them — the branch switcher only narrows lists).
 */
export async function writableWarehouse(ctx, id, field, t, { requireAccess = true } = {}) {
  const warehouse = await Warehouse.findOne({
    where: { id, companyId: ctx.auth.companyId },
    include: [{ model: Branch, as: 'branch', attributes: ['id', 'name', 'code'] }],
    transaction: t,
  });
  if (!warehouse) throw invalid(field, 'Warehouse not found');
  if (!warehouse.isActive) throw invalid(field, `Warehouse ${warehouse.name} is inactive`);
  if (requireAccess) assertBranchAccess(ctx, warehouse.branchId);
  return warehouse;
}

export function assertBranchAccess(ctx, branchId) {
  const allowed = ctx.auth.isSuperAdmin || (ctx.auth.branchIds ?? []).map(String).includes(String(branchId));
  if (!allowed) throw AppError.forbidden('You do not have access to this branch');
}

/** Documents are visible when their branch is in scope. */
export const branchScopeWhere = (ctx, ...columns) => {
  const ids = ctx.branchIds.length ? ctx.branchIds : [0];
  return columns.length === 1
    ? { [columns[0]]: { [Op.in]: ids } }
    : { [Op.or]: columns.map((c) => ({ [c]: { [Op.in]: ids } })) };
};

const LINE_PRODUCT_ATTRS = [
  'id',
  'name',
  'sku',
  'type',
  'hasVariants',
  'trackBatch',
  'trackSerial',
  'trackExpiry',
  'purchasePrice',
  'baseUnitId',
  'isActive',
];

/**
 * Validate document lines and convert quantities to the base unit.
 * Returns the lines enriched with { product, variant, unitFactor, baseQuantity }.
 */
export async function normalizeLines(ctx, lines, t, { allowNewBatch = false } = {}) {
  const companyId = ctx.auth.companyId;
  if (!lines.length) throw invalid('items', 'Add at least one item');
  const productIds = [...new Set(lines.map((l) => String(l.productId)))];
  const products = await Product.findAll({
    where: { id: productIds, companyId },
    attributes: LINE_PRODUCT_ATTRS,
    include: [{ model: ProductUnit, as: 'units', attributes: ['unitId', 'factor'] }],
    transaction: t,
  });
  const productOf = new Map(products.map((p) => [String(p.id), p]));
  const variantIds = lines.filter((l) => l.variantId).map((l) => l.variantId);
  const variants = variantIds.length
    ? await ProductVariant.findAll({
        where: { id: variantIds, companyId },
        attributes: ['id', 'productId', 'name', 'sku'],
        transaction: t,
      })
    : [];
  const variantOf = new Map(variants.map((v) => [String(v.id), v]));
  const batchIds = lines.filter((l) => l.batchId).map((l) => l.batchId);
  const batches = batchIds.length
    ? await StockBatch.findAll({ where: { id: batchIds, companyId }, transaction: t })
    : [];
  const batchOf = new Map(batches.map((b) => [String(b.id), b]));

  return lines.map((line, i) => {
    const field = `items.${i}`;
    const product = productOf.get(String(line.productId));
    if (!product) throw invalid(`${field}.productId`, 'Product not found');
    if (product.type === 'service')
      throw invalid(`${field}.productId`, `${product.name} is a service and is not stocked`);
    const variant = line.variantId ? variantOf.get(String(line.variantId)) : null;
    if (product.hasVariants && (!variant || String(variant.productId) !== String(product.id))) {
      throw invalid(`${field}.variantId`, `Choose a variant of ${product.name}`);
    }
    if (!product.hasVariants && line.variantId)
      throw invalid(`${field}.variantId`, `${product.name} has no variants`);

    let unitFactor = '1';
    if (line.unitId && String(line.unitId) !== String(product.baseUnitId)) {
      const pack = product.units.find((u) => String(u.unitId) === String(line.unitId));
      if (!pack) throw invalid(`${field}.unitId`, `This unit is not set up for ${product.name}`);
      unitFactor = pack.factor;
    }
    const baseQuantity = D(line.quantity).times(unitFactor);
    if (product.trackSerial && !baseQuantity.isInteger()) {
      throw invalid(`${field}.quantity`, `${product.name} is serial-tracked; use whole units`);
    }
    const serialNumbers = [...new Set((line.serialNumbers ?? []).map((s) => s.trim()).filter(Boolean))];
    if (product.trackSerial && serialNumbers.length && serialNumbers.length !== baseQuantity.toNumber()) {
      throw invalid(
        `${field}.serialNumbers`,
        `Enter ${baseQuantity.toNumber()} serial number(s) for ${product.name}`,
      );
    }
    if (!product.trackSerial && serialNumbers.length)
      throw invalid(`${field}.serialNumbers`, `${product.name} is not serial-tracked`);

    const lot = isLotTracked(product);
    const batch = line.batchId ? batchOf.get(String(line.batchId)) : null;
    if (line.batchId) {
      if (!lot) throw invalid(`${field}.batchId`, `${product.name} is not batch-tracked`);
      if (
        !batch ||
        String(batch.productId) !== String(product.id) ||
        String(batch.variantId ?? '') !== String(line.variantId ?? '')
      ) {
        throw invalid(`${field}.batchId`, 'Batch not found');
      }
    }
    if (!lot && line.batchNo) throw invalid(`${field}.batchNo`, `${product.name} is not batch-tracked`);
    if (line.batchNo && !allowNewBatch) throw invalid(`${field}.batchNo`, 'Choose an existing batch');

    return {
      ...line,
      variantId: line.variantId ?? null,
      batchId: line.batchId ?? null,
      batchNo: line.batchId ? null : (line.batchNo ?? null),
      unitId: line.unitId ?? product.baseUnitId,
      serialNumbers,
      product,
      variant,
      batch,
      unitFactor,
      baseQuantity: fixed4(baseQuantity),
      field,
    };
  });
}

/** Current quantity and average cost of one warehouse item (or one of its batches). */
export async function itemPosition({ warehouseId, productId, variantId, batchId }, t) {
  const balance = await StockBalance.findOne({
    where: { warehouseId, productId, variantId: variantId ?? null },
    transaction: t,
  });
  const quantity = batchId
    ? await batchQuantity({ warehouseId, productId, variantId, batchId }, t)
    : D(balance?.quantity);
  return { quantity, avgCost: D(balance?.avgCost), balance };
}

/**
 * Stock-out pre-check used when a document is submitted (posting re-checks under lock).
 * Lines must already be normalized.
 */
export async function assertAvailable(ctx, warehouse, lines, t) {
  const settings = await inventorySettings(ctx.auth.companyId, t);
  const need = new Map();
  for (const l of lines) {
    const key = `${l.productId}:${l.variantId ?? 0}:${l.batchId ?? 0}`;
    need.set(key, { line: l, qty: (need.get(key)?.qty ?? D(0)).plus(l.baseQuantity) });
  }
  for (const { line, qty } of need.values()) {
    const lot = isLotTracked(line.product);
    if (!lot && !line.product.trackSerial && settings.allowNegativeStock) continue;
    if (lot && !line.batchId)
      throw invalid(`${line.field}.batchId`, `Choose a batch for ${line.product.name}`);
    const { quantity } = await itemPosition({ warehouseId: warehouse.id, ...line }, t);
    if (qty.gt(quantity)) {
      const label = line.variant ? `${line.product.name} (${line.variant.name})` : line.product.name;
      throw invalid(
        `${line.field}.quantity`,
        `Not enough stock of ${label} in ${warehouse.name}: ${quantity.toFixed()} available, ${qty.toFixed()} required`,
      );
    }
  }
}

/** Common includes for document lines. */
export const lineIncludes = ({ unit = true } = {}) => [
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
  { model: StockBatch, as: 'batch', attributes: ['id', 'batchNo', 'expiryDate', 'mfgDate'] },
  ...(unit ? [{ model: Unit, as: 'unit', attributes: ['id', 'code', 'name'] }] : []),
];

export const userRef = (as) => ({ model: User, as, attributes: ['id', 'name'] });

export const warehouseRef = (as) => ({
  model: Warehouse,
  as,
  attributes: ['id', 'name', 'code', 'branchId'],
  paranoid: false,
});

/** Lock a document row for a state change and check its status. */
export async function lockDocument(model, ctx, id, t, { label, allowed }) {
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

export const sumTotals = (movements) =>
  fixed4(movements.reduce((sum, m) => sum.plus(m.totalCost), new Decimal(0)));
