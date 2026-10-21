import Decimal from 'decimal.js';
import { Op } from 'sequelize';
import { sequelize } from '../../config/db.js';
import {
  Product,
  ProductVariant,
  StockBalance,
  StockBatch,
  StockLayer,
  StockMovement,
  StockMovementSerial,
  StockSerial,
  Warehouse,
} from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { getSettings } from '../settings/settings.service.js';
import { postStockJournal } from '../accounting/posting.service.js';

/**
 * The stock engine — the ONLY code that writes stock_movements, stock_balances, stock_layers
 * and serial locations. Every document (adjustment, transfer, count, and later purchase/sales)
 * calls postMovements() inside its own transaction.
 *
 * Invariants:
 *  - stock_movements is append-only; corrections are new, opposite movements.
 *  - Each touched stock_balances row is locked (SELECT … FOR UPDATE) before anything is read or
 *    written for that item, in a fixed key order so concurrent postings cannot deadlock.
 *    Layers and serials of an item are only touched while its balance row is locked.
 *  - balance.total_value always equals the sum of the item's movement total_cost.
 *  - Cost layers are kept under both costing methods (they also hold batch quantities), so the
 *    method can be switched at any time: FIFO issues at layer cost, weighted average at the
 *    balance's average cost. An issue that empties an item takes its remaining value exactly.
 *  - Batch- and serial-tracked items can never go negative.
 */

export const D = (v) => new Decimal(v ?? 0);
const round4 = (d) => d.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
/** Decimal → DECIMAL(18,4) string. */
export const fixed4 = (v) => round4(D(v)).toFixed(4);

/** Out movements that are not consumption (they don't reset the slow-moving clock). */
const NON_CONSUMPTION = new Set(['transfer_out', 'count_loss', 'damage', 'scrap', 'purchase_return']);

/** Products whose stock is held in batches (expiry needs a batch to live on). */
export const isLotTracked = (p) => Boolean(p.trackBatch || p.trackExpiry);

const PRODUCT_ATTRS = [
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
];

const invalid = (field, message) => AppError.unprocessable(message, field ? [{ field, message }] : undefined);
const itemKey = (e) =>
  `${String(e.warehouseId).padStart(20, '0')}:${String(e.productId).padStart(20, '0')}:${String(e.variantId ?? 0).padStart(20, '0')}`;

function itemLabel(product, variant) {
  return variant ? `${product.name} (${variant.name})` : product.name;
}

/** Lock (creating if needed) the balance row of one warehouse item. */
async function lockBalance({ companyId, branchId, warehouseId, productId, variantId }, t) {
  await sequelize.query(
    `INSERT INTO stock_balances (company_id, branch_id, warehouse_id, product_id, variant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE id = id`,
    { replacements: [companyId, branchId, warehouseId, productId, variantId ?? null], transaction: t },
  );
  return StockBalance.findOne({
    where: { warehouseId, productId, variantId: variantId ?? null },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
}

/** Quantity of a batch held in a warehouse (sum of its open layers). */
export async function batchQuantity({ warehouseId, productId, variantId, batchId }, t) {
  const sum = await StockLayer.sum('remaining', {
    where: { warehouseId, productId, variantId: variantId ?? null, batchId },
    transaction: t,
  });
  return D(sum);
}

/** Take `need` from the item's open layers, oldest first. Returns { taken, cost }. */
async function consumeLayers({ warehouseId, productId, variantId, batchId, need }, t) {
  const layers = await StockLayer.findAll({
    where: {
      warehouseId,
      productId,
      variantId: variantId ?? null,
      ...(batchId && { batchId }),
      remaining: { [Op.gt]: 0 },
    },
    order: [
      ['receivedAt', 'ASC'],
      ['id', 'ASC'],
    ],
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  let left = need;
  let cost = D(0);
  for (const layer of layers) {
    if (left.lte(0)) break;
    const take = Decimal.min(left, D(layer.remaining));
    cost = cost.plus(take.times(layer.unitCost));
    left = left.minus(take);
    await layer.update({ remaining: fixed4(D(layer.remaining).minus(take)) }, { transaction: t });
  }
  return { taken: need.minus(left), cost };
}

async function moveSerialsIn({ companyId, product, entry, movement }, t) {
  for (const serialNo of entry.serialNumbers) {
    const existing = await StockSerial.findOne({
      where: { companyId, productId: product.id, serialNo },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (existing?.status === 'in_stock') {
      throw invalid(entry.field && `${entry.field}.serialNumbers`, `Serial ${serialNo} is already in stock`);
    }
    const values = {
      variantId: entry.variantId ?? null,
      batchId: entry.batchId ?? null,
      warehouseId: entry.warehouseId,
      status: 'in_stock',
      unitCost: movement.unitCost,
    };
    const serial = existing
      ? await existing.update(values, { transaction: t })
      : await StockSerial.create(
          { companyId, productId: product.id, serialNo, ...values },
          { transaction: t },
        );
    await StockMovementSerial.create({ movementId: movement.id, serialId: serial.id }, { transaction: t });
  }
}

async function moveSerialsOut({ companyId, product, entry, movement }, t) {
  for (const serialNo of entry.serialNumbers) {
    const serial = await StockSerial.findOne({
      where: {
        companyId,
        productId: product.id,
        serialNo,
        variantId: entry.variantId ?? null,
        warehouseId: entry.warehouseId,
        status: 'in_stock',
        ...(entry.batchId && { batchId: entry.batchId }),
      },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!serial) {
      throw invalid(
        entry.field && `${entry.field}.serialNumbers`,
        `Serial ${serialNo} is not in stock in this warehouse`,
      );
    }
    await serial.update({ status: entry.serialStatus ?? 'issued' }, { transaction: t });
    await StockMovementSerial.create({ movementId: movement.id, serialId: serial.id }, { transaction: t });
  }
}

/** Check product/variant/batch/serial rules for one entry. */
function checkEntry(entry, product, variant) {
  const f = entry.field;
  if (!product) throw invalid(f && `${f}.productId`, 'Product not found');
  if (product.type === 'service')
    throw invalid(f && `${f}.productId`, `${product.name} is a service and is not stocked`);
  if (product.hasVariants && !variant)
    throw invalid(f && `${f}.variantId`, `Choose a variant of ${product.name}`);
  if (!product.hasVariants && entry.variantId)
    throw invalid(f && `${f}.variantId`, `${product.name} has no variants`);
  if (variant && String(variant.productId) !== String(product.id))
    throw invalid(f && `${f}.variantId`, 'Variant not found');

  const label = itemLabel(product, variant);
  const qty = D(entry.quantity);
  if (qty.isZero()) throw invalid(f && `${f}.quantity`, 'Quantity must not be zero');
  if (isLotTracked(product) && !entry.batchId)
    throw invalid(f && `${f}.batchId`, `Choose a batch for ${label}`);
  if (!isLotTracked(product) && entry.batchId)
    throw invalid(f && `${f}.batchId`, `${label} is not batch-tracked`);

  const serials = entry.serialNumbers ?? [];
  if (product.trackSerial) {
    if (!qty.isInteger()) throw invalid(f && `${f}.quantity`, `${label} is serial-tracked; use whole units`);
    if (serials.length !== qty.abs().toNumber()) {
      throw invalid(f && `${f}.serialNumbers`, `Enter ${qty.abs().toNumber()} serial number(s) for ${label}`);
    }
    if (new Set(serials).size !== serials.length)
      throw invalid(f && `${f}.serialNumbers`, 'Serial numbers must be unique');
  } else if (serials.length) {
    throw invalid(f && `${f}.serialNumbers`, `${label} is not serial-tracked`);
  }
  return label;
}

/**
 * Post stock movements for one document. MUST run inside the caller's transaction.
 *
 * @param {object}   p
 * @param {string}   p.companyId
 * @param {string}   p.userId
 * @param {string}   p.date          Business date (YYYY-MM-DD) of the document
 * @param {{type: string, id: string, no?: string}} p.reference  Source document
 * @param {object[]} p.entries       { warehouseId, productId, variantId?, batchId?, quantity (signed,
 *                                   base unit), unitCost? / totalCost? (stock-in), type, referenceItemId?,
 *                                   serialNumbers?, serialStatus? (stock-out), notes?, field? (error path) }
 * @returns {Promise<object[]>} the created movements, in entry order
 */
export async function postMovements({
  companyId,
  userId,
  date,
  reference,
  entries,
  transaction: t,
  allowNegative = false,
}) {
  if (!t) throw new Error('postMovements() must run inside a transaction');
  if (!entries.length) return [];
  const settings = await getSettings(companyId, 'inventory', t);

  const productIds = [...new Set(entries.map((e) => String(e.productId)))];
  const variantIds = [...new Set(entries.filter((e) => e.variantId).map((e) => String(e.variantId)))];
  const warehouseIds = [...new Set(entries.map((e) => String(e.warehouseId)))];
  const [products, variants, warehouses] = await Promise.all([
    Product.findAll({ where: { id: productIds, companyId }, attributes: PRODUCT_ATTRS, transaction: t }),
    variantIds.length
      ? ProductVariant.findAll({
          where: { id: variantIds, companyId },
          attributes: ['id', 'productId', 'name'],
          transaction: t,
        })
      : [],
    Warehouse.findAll({
      where: { id: warehouseIds, companyId },
      attributes: ['id', 'branchId', 'name'],
      transaction: t,
    }),
  ]);
  const productOf = new Map(products.map((p) => [String(p.id), p]));
  const variantOf = new Map(variants.map((v) => [String(v.id), v]));
  const warehouseOf = new Map(warehouses.map((w) => [String(w.id), w]));

  const labels = entries.map((e) => {
    if (!warehouseOf.has(String(e.warehouseId)))
      throw invalid(e.field && `${e.field}.warehouseId`, 'Warehouse not found');
    return checkEntry(
      e,
      productOf.get(String(e.productId)),
      e.variantId ? variantOf.get(String(e.variantId)) : null,
    );
  });

  // Lock every touched item up front, in a fixed order.
  const balances = new Map();
  for (const key of [...new Set(entries.map(itemKey))].sort()) {
    const e = entries.find((x) => itemKey(x) === key);
    const warehouse = warehouseOf.get(String(e.warehouseId));
    balances.set(
      key,
      await lockBalance(
        {
          companyId,
          branchId: warehouse.branchId,
          warehouseId: e.warehouseId,
          productId: e.productId,
          variantId: e.variantId,
        },
        t,
      ),
    );
  }

  const now = new Date();
  const results = [];
  for (const [index, entry] of entries.entries()) {
    const product = productOf.get(String(entry.productId));
    const warehouse = warehouseOf.get(String(entry.warehouseId));
    const balance = balances.get(itemKey(entry));
    const label = labels[index];
    const qty = round4(D(entry.quantity));
    const beforeQty = D(balance.quantity);
    const beforeValue = D(balance.totalValue);
    const lot = isLotTracked(product);
    const item = {
      warehouseId: entry.warehouseId,
      productId: entry.productId,
      variantId: entry.variantId,
      batchId: entry.batchId,
    };

    let unitCost;
    let totalCost;
    if (qty.gt(0)) {
      unitCost = round4(D(entry.unitCost));
      if (unitCost.lt(0))
        throw invalid(entry.field && `${entry.field}.unitCost`, 'Unit cost cannot be negative');
      // An explicit total (e.g. a transfer receipt) carries value over exactly despite unit rounding.
      totalCost = entry.totalCost != null ? round4(D(entry.totalCost)) : round4(qty.times(unitCost));
    } else {
      const need = qty.neg();
      const available = lot ? await batchQuantity(item, t) : beforeQty;
      if (
        need.gt(available) &&
        (lot || product.trackSerial || !(settings.allowNegativeStock || allowNegative))
      ) {
        throw invalid(
          entry.field && `${entry.field}.quantity`,
          `Not enough stock of ${label} in ${warehouse.name}: ${available.toFixed()} available, ${need.toFixed()} required`,
        );
      }
      const { taken, cost: layerCost } = await consumeLayers({ ...item, need }, t);
      const average = beforeQty.gt(0)
        ? beforeValue.dividedBy(beforeQty)
        : D(balance.avgCost).gt(0)
          ? D(balance.avgCost)
          : D(product.purchasePrice);
      let cost =
        settings.costingMethod === 'fifo'
          ? layerCost.plus(need.minus(taken).times(average))
          : need.times(average);
      // Emptying the item takes exactly what is left, so no rounding residue stays behind.
      if (beforeQty.minus(need).isZero()) cost = beforeValue;
      totalCost = round4(cost).neg();
      unitCost = round4(cost.dividedBy(need));
    }

    const afterQty = beforeQty.plus(qty);
    const afterValue = beforeValue.plus(totalCost);
    const avgCost = afterQty.gt(0)
      ? afterValue.dividedBy(afterQty)
      : qty.gt(0)
        ? unitCost
        : D(balance.avgCost);

    const movement = await StockMovement.create(
      {
        companyId,
        branchId: warehouse.branchId,
        warehouseId: entry.warehouseId,
        productId: entry.productId,
        variantId: entry.variantId ?? null,
        batchId: entry.batchId ?? null,
        movementType: entry.type,
        movementDate: date,
        referenceType: reference.type,
        referenceId: reference.id,
        referenceNo: reference.no ?? null,
        referenceItemId: entry.referenceItemId ?? null,
        quantity: fixed4(qty),
        unitCost: fixed4(unitCost),
        totalCost: fixed4(totalCost),
        balanceQuantity: fixed4(afterQty),
        balanceValue: fixed4(afterValue),
        notes: entry.notes ?? null,
        createdBy: userId ?? null,
      },
      { transaction: t },
    );

    if (qty.gt(0)) {
      // A receipt first covers any negative quantity; only the rest is a new layer.
      const deficit = beforeQty.lt(0) ? Decimal.min(beforeQty.neg(), qty) : D(0);
      const remaining = qty.minus(deficit);
      if (remaining.gt(0)) {
        await StockLayer.create(
          {
            companyId,
            ...item,
            variantId: entry.variantId ?? null,
            batchId: entry.batchId ?? null,
            movementId: movement.id,
            receivedAt: now,
            quantity: fixed4(qty),
            remaining: fixed4(remaining),
            unitCost: fixed4(unitCost),
          },
          { transaction: t },
        );
      }
    }
    if (entry.serialNumbers?.length) {
      const move = qty.gt(0) ? moveSerialsIn : moveSerialsOut;
      await move({ companyId, product, entry, movement }, t);
    }

    await balance.update(
      {
        quantity: fixed4(afterQty),
        totalValue: fixed4(afterValue),
        avgCost: fixed4(avgCost),
        lastMovementAt: now,
        ...(qty.lt(0) && !NON_CONSUMPTION.has(entry.type) && { lastIssueAt: now }),
      },
      { transaction: t },
    );
    results.push(movement);
  }
  // Perpetual inventory: value the movements in the general ledger in the same transaction.
  await postStockJournal({ companyId, userId, date, reference, movements: results, transaction: t });
  return results;
}

/**
 * Find a batch, or create it for a stock-in. An existing batch keeps its dates; a conflicting
 * expiry is rejected so one batch number never means two different lots.
 */
export async function resolveBatch(
  { companyId, product, variantId, batchNo, expiryDate, mfgDate, userId, field },
  t,
) {
  const where = { companyId, productId: product.id, variantId: variantId ?? null, batchNo };
  const existing = await StockBatch.findOne({ where, transaction: t });
  if (existing) {
    if (expiryDate && existing.expiryDate && existing.expiryDate !== expiryDate) {
      throw invalid(
        field && `${field}.expiryDate`,
        `Batch ${batchNo} already exists with expiry ${existing.expiryDate}`,
      );
    }
    if (expiryDate && !existing.expiryDate) await existing.update({ expiryDate }, { transaction: t });
    return existing;
  }
  if (product.trackExpiry && !expiryDate) {
    throw invalid(field && `${field}.expiryDate`, `Enter the expiry date of batch ${batchNo}`);
  }
  return StockBatch.create(
    { ...where, expiryDate: expiryDate ?? null, mfgDate: mfgDate ?? null, createdBy: userId },
    { transaction: t },
  );
}
