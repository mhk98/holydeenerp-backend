import { Op, QueryTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { Branch, ProductCategory, StockCount, StockCountItem } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { parseListQuery } from '../../utils/pagination.js';
import { retiredValue } from '../../utils/slug.js';
import { descendantIds } from '../categories/categories.service.js';
import { nextNumber } from '../sequences/sequences.service.js';
import {
  assertBranchAccess,
  branchScopeWhere,
  companyToday,
  inventorySettings,
  invalid,
  itemPosition,
  lineIncludes,
  lockDocument,
  sumTotals,
  userRef,
  warehouseRef,
  writableWarehouse,
} from './inventory.common.js';
import { D, fixed4, postMovements } from './stock.engine.js';

/**
 * Physical inventory. Creating a count generates the count sheet: one line per item in stock
 * (per batch for batch-tracked items) with the system quantity at that moment. Counters enter
 * counted quantities; submitting (and approving, when approval is required) posts the variance
 * as count_gain / count_loss movements. Variance is measured against the quantity at posting
 * time, so stock moved during the count is not double-counted.
 *
 * Serial-tracked products are left off count sheets — count them with a stock adjustment,
 * which names the serials that are missing or found.
 */

const LABEL = 'Stock count';

const LIST_OPTIONS = {
  sortable: ['number', 'countDate', 'createdAt', 'varianceValue'],
  searchable: ['number', 'notes'],
  filterable: ['status', 'warehouseId'],
  defaultSort: '-createdAt',
};

export async function listCounts(ctx, query) {
  const q = parseListQuery(query, LIST_OPTIONS);
  const { rows, count } = await StockCount.findAndCountAll({
    where: { ...q.where, companyId: ctx.auth.companyId, ...branchScopeWhere(ctx, 'branchId') },
    include: [
      warehouseRef('warehouse'),
      userRef('creator'),
      { model: ProductCategory, as: 'category', attributes: ['id', 'name'] },
    ],
    attributes: {
      include: [
        [
          sequelize.literal('(SELECT COUNT(*) FROM stock_count_items i WHERE i.count_id = StockCount.id)'),
          'itemsCount',
        ],
        [
          sequelize.literal(
            '(SELECT COUNT(*) FROM stock_count_items i WHERE i.count_id = StockCount.id AND i.counted_quantity IS NOT NULL)',
          ),
          'countedCount',
        ],
      ],
    },
    order: q.order,
    limit: q.limit,
    offset: q.offset,
    distinct: true,
  });
  return { rows: rows.map((r) => r.toJSON()), count, page: q.page, limit: q.limit };
}

export async function getCount(ctx, id) {
  const doc = await StockCount.findOne({
    where: { id, companyId: ctx.auth.companyId, ...branchScopeWhere(ctx, 'branchId') },
    include: [
      warehouseRef('warehouse'),
      { model: Branch, as: 'branch', attributes: ['id', 'name', 'code'] },
      { model: ProductCategory, as: 'category', attributes: ['id', 'name'] },
      userRef('creator'),
      userRef('submitter'),
      userRef('approver'),
      userRef('rejecter'),
      userRef('canceller'),
      {
        model: StockCountItem,
        as: 'items',
        include: lineIncludes({ unit: false }),
        separate: true,
        order: [['id', 'ASC']],
      },
    ],
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  const json = doc.toJSON();
  json.items.sort(
    (a, b) =>
      a.product.name.localeCompare(b.product.name) ||
      (a.variant?.name ?? '').localeCompare(b.variant?.name ?? ''),
  );
  return json;
}

/** Count sheet lines: stocked items of the warehouse (+ zero-stock items when asked). */
async function sheetLines(ctx, warehouseId, { categoryId, includeZero }, t) {
  const categories = categoryId ? await descendantIds(ctx.auth.companyId, categoryId) : null;
  const replacements = { companyId: ctx.auth.companyId, warehouseId, categories: categories ?? [0] };
  const categoryFilter = categories ? 'AND p.category_id IN (:categories)' : '';

  // Batch lines from open layers; plain items from balances.
  const batchRows = await sequelize.query(
    `SELECT l.product_id AS productId, l.variant_id AS variantId, l.batch_id AS batchId,
            SUM(l.remaining) AS quantity, b.avg_cost AS avgCost
       FROM stock_layers l
       JOIN products p ON p.id = l.product_id
       LEFT JOIN stock_balances b ON b.warehouse_id = l.warehouse_id AND b.product_id = l.product_id
            AND b.variant_key = IFNULL(l.variant_id, 0)
      WHERE l.warehouse_id = :warehouseId AND l.batch_id IS NOT NULL AND l.remaining > 0
        AND p.track_serial = 0 AND p.deleted_at IS NULL ${categoryFilter}
      GROUP BY l.product_id, l.variant_id, l.batch_id, b.avg_cost`,
    { replacements, type: QueryTypes.SELECT, transaction: t },
  );
  const plainRows = await sequelize.query(
    `SELECT p.id AS productId, v.id AS variantId, NULL AS batchId,
            COALESCE(b.quantity, 0) AS quantity, COALESCE(NULLIF(b.avg_cost, 0), p.purchase_price) AS avgCost
       FROM products p
       LEFT JOIN product_variants v ON v.product_id = p.id AND p.has_variants = 1 AND v.deleted_at IS NULL AND v.is_active = 1
       LEFT JOIN stock_balances b ON b.warehouse_id = :warehouseId AND b.product_id = p.id AND b.variant_key = IFNULL(v.id, 0)
      WHERE p.company_id = :companyId AND p.deleted_at IS NULL AND p.type <> 'service'
        AND p.track_serial = 0 AND p.track_batch = 0 AND p.track_expiry = 0
        AND (p.has_variants = 0 OR v.id IS NOT NULL)
        ${includeZero ? 'AND p.is_active = 1' : 'AND b.quantity <> 0'} ${categoryFilter}`,
    { replacements, type: QueryTypes.SELECT, transaction: t },
  );
  return [...batchRows, ...plainRows];
}

export async function createCount(ctx, input) {
  const id = await sequelize.transaction(async (t) => {
    const warehouse = await writableWarehouse(ctx, input.warehouseId, 'warehouseId', t);
    if (input.categoryId) {
      const exists = await ProductCategory.count({
        where: { id: input.categoryId, companyId: ctx.auth.companyId },
        transaction: t,
      });
      if (!exists) throw invalid('categoryId', 'Category not found');
    }
    const open = await StockCount.count({
      where: { warehouseId: warehouse.id, status: { [Op.in]: ['counting', 'pending_approval', 'rejected'] } },
      transaction: t,
    });
    if (open)
      throw AppError.conflict(`${warehouse.name} already has an open stock count; finish or cancel it first`);

    const lines = await sheetLines(ctx, warehouse.id, input, t);
    if (!lines.length) throw invalid('warehouseId', 'Nothing to count: no stocked items match');
    const number = await nextNumber({
      companyId: ctx.auth.companyId,
      docType: 'stock_count',
      branchId: warehouse.branchId,
      transaction: t,
    });
    const doc = await StockCount.create(
      {
        companyId: ctx.auth.companyId,
        branchId: warehouse.branchId,
        warehouseId: warehouse.id,
        number,
        countDate: input.countDate ?? (await companyToday(ctx.auth.companyId)),
        categoryId: input.categoryId ?? null,
        includeZero: Boolean(input.includeZero),
        notes: input.notes ?? null,
        status: 'counting',
        createdBy: ctx.auth.userId,
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
    await StockCountItem.bulkCreate(
      lines.map((l) => ({
        countId: doc.id,
        productId: l.productId,
        variantId: l.variantId,
        batchId: l.batchId,
        systemQuantity: fixed4(l.quantity),
        unitCost: fixed4(l.avgCost ?? 0),
      })),
      { transaction: t },
    );
    return doc.id;
  });
  return getCount(ctx, id);
}

/** Save counted quantities (blank = not counted yet). */
export async function saveCountEntries(ctx, id, entries) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDocument(StockCount, ctx, id, t, {
      label: LABEL,
      allowed: ['counting', 'rejected'],
    });
    assertBranchAccess(ctx, doc.branchId);
    const items = await StockCountItem.findAll({ where: { countId: doc.id }, transaction: t });
    const itemOf = new Map(items.map((i) => [String(i.id), i]));
    for (const [i, entry] of entries.entries()) {
      const item = itemOf.get(String(entry.id));
      if (!item) throw invalid(`items.${i}.id`, 'Line not found on this count sheet');
      const counted = entry.countedQuantity == null ? null : fixed4(entry.countedQuantity);
      const variance = counted == null ? '0.0000' : fixed4(D(counted).minus(item.systemQuantity));
      await item.update(
        {
          countedQuantity: counted,
          varianceQuantity: variance,
          varianceValue: fixed4(D(variance).times(item.unitCost)),
          ...(entry.notes !== undefined && { notes: entry.notes }),
        },
        { transaction: t },
      );
    }
    await doc.update({ status: 'counting', updatedBy: ctx.auth.userId }, { transaction: t });
  });
  return getCount(ctx, id);
}

async function post(ctx, doc, t) {
  const items = await StockCountItem.findAll({
    where: { countId: doc.id, countedQuantity: { [Op.ne]: null } },
    order: [['id', 'ASC']],
    transaction: t,
  });
  const entries = [];
  const posted = [];
  for (const item of items) {
    const { quantity, avgCost } = await itemPosition(
      {
        warehouseId: doc.warehouseId,
        productId: item.productId,
        variantId: item.variantId,
        batchId: item.batchId,
      },
      t,
    );
    const variance = D(item.countedQuantity).minus(quantity);
    await item.update(
      { systemQuantity: fixed4(quantity), varianceQuantity: fixed4(variance) },
      { transaction: t },
    );
    if (variance.isZero()) {
      await item.update({ varianceValue: '0.0000' }, { transaction: t });
      continue;
    }
    posted.push(item);
    entries.push({
      warehouseId: doc.warehouseId,
      productId: item.productId,
      variantId: item.variantId,
      batchId: item.batchId,
      quantity: variance.toFixed(),
      unitCost: (avgCost.gt(0) ? avgCost : D(item.unitCost)).toFixed(),
      type: variance.gt(0) ? 'count_gain' : 'count_loss',
      referenceItemId: item.id,
      notes: item.notes,
    });
  }
  const movements = await postMovements({
    companyId: ctx.auth.companyId,
    userId: ctx.auth.userId,
    date: doc.countDate,
    reference: { type: 'stock_count', id: doc.id, no: doc.number },
    entries,
    transaction: t,
  });
  for (const [i, m] of movements.entries()) {
    await posted[i].update({ unitCost: m.unitCost, varianceValue: m.totalCost }, { transaction: t });
  }
  return movements.length ? sumTotals(movements) : '0.0000';
}

export async function submitCount(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDocument(StockCount, ctx, id, t, { label: LABEL, allowed: ['counting'] });
    assertBranchAccess(ctx, doc.branchId);
    const counted = await StockCountItem.count({
      where: { countId: doc.id, countedQuantity: { [Op.ne]: null } },
      transaction: t,
    });
    if (!counted) throw invalid('items', 'Enter at least one counted quantity');
    const { requireApproval } = await inventorySettings(ctx.auth.companyId, t);
    const now = new Date();
    const submitted = { submittedBy: ctx.auth.userId, submittedAt: now, updatedBy: ctx.auth.userId };
    if (requireApproval) {
      await doc.update({ ...submitted, status: 'pending_approval' }, { transaction: t });
      return;
    }
    const varianceValue = await post(ctx, doc, t);
    await doc.update(
      { ...submitted, status: 'posted', approvedBy: ctx.auth.userId, approvedAt: now, varianceValue },
      { transaction: t },
    );
  });
  return getCount(ctx, id);
}

export async function approveCount(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDocument(StockCount, ctx, id, t, { label: LABEL, allowed: ['pending_approval'] });
    assertBranchAccess(ctx, doc.branchId);
    const varianceValue = await post(ctx, doc, t);
    await doc.update(
      {
        status: 'posted',
        approvedBy: ctx.auth.userId,
        approvedAt: new Date(),
        varianceValue,
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
  });
  return getCount(ctx, id);
}

export async function rejectCount(ctx, id, reason) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDocument(StockCount, ctx, id, t, { label: LABEL, allowed: ['pending_approval'] });
    assertBranchAccess(ctx, doc.branchId);
    await doc.update(
      {
        status: 'rejected',
        rejectedBy: ctx.auth.userId,
        rejectedAt: new Date(),
        rejectionReason: reason,
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
  });
  return getCount(ctx, id);
}

export async function cancelCount(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDocument(StockCount, ctx, id, t, {
      label: LABEL,
      allowed: ['counting', 'pending_approval', 'rejected'],
    });
    assertBranchAccess(ctx, doc.branchId);
    await doc.update(
      {
        status: 'cancelled',
        cancelledBy: ctx.auth.userId,
        cancelledAt: new Date(),
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
  });
  return getCount(ctx, id);
}

export async function deleteCount(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDocument(StockCount, ctx, id, t, {
      label: LABEL,
      allowed: ['counting', 'cancelled'],
    });
    assertBranchAccess(ctx, doc.branchId);
    await doc.update(
      { number: retiredValue(doc.number, doc.id, 60), updatedBy: ctx.auth.userId },
      { transaction: t },
    );
    await doc.destroy({ transaction: t });
  });
}
