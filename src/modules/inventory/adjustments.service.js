import { Op } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { Branch, StockAdjustment, StockAdjustmentItem, StockMovement } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { parseListQuery } from '../../utils/pagination.js';
import { retiredValue } from '../../utils/slug.js';
import { nextNumber } from '../sequences/sequences.service.js';
import {
  assertAvailable,
  assertBranchAccess,
  branchScopeWhere,
  companyToday,
  inventorySettings,
  invalid,
  itemPosition,
  lineIncludes,
  lockDocument,
  normalizeLines,
  sumTotals,
  userRef,
  warehouseRef,
  writableWarehouse,
} from './inventory.common.js';
import { D, fixed4, isLotTracked, postMovements, resolveBatch } from './stock.engine.js';

/**
 * Stock adjustments. One document type covers four kinds:
 *   opening     stock-in only, before any other movement of the item in that warehouse
 *   adjustment  stock-in or stock-out with a reason (found, lost, count correction, …)
 *   damage      stock-out; serials become "damaged"
 *   scrap       stock-out; serials become "scrapped"
 *
 * Workflow: draft → (submit) → pending_approval → (approve) → posted
 *                                               ↘ (reject) → rejected → (edit) → draft
 * When Settings → Inventory → "Require approval" is off, submit posts straight away.
 * Posted documents are final; correct them with a new adjustment.
 */

const LABEL = 'Stock adjustment';
const SERIES = {
  opening: 'opening_stock',
  adjustment: 'stock_adjustment',
  damage: 'stock_adjustment',
  scrap: 'stock_adjustment',
};
const OUT_KINDS = new Set(['damage', 'scrap']);
const MOVEMENT_TYPE = {
  opening: () => 'opening',
  adjustment: (dir) => (dir === 'in' ? 'adjustment_in' : 'adjustment_out'),
  damage: () => 'damage',
  scrap: () => 'scrap',
};
const SERIAL_STATUS = { adjustment: 'written_off', damage: 'damaged', scrap: 'scrapped' };
const DEFAULT_REASON = { opening: 'opening_balance', damage: 'damaged', scrap: 'scrap' };

const LIST_OPTIONS = {
  sortable: ['number', 'adjustmentDate', 'createdAt', 'totalValue'],
  searchable: ['number', 'notes'],
  filterable: ['kind', 'status', 'warehouseId'],
  defaultSort: '-createdAt',
};

const detailInclude = () => [
  warehouseRef('warehouse'),
  { model: Branch, as: 'branch', attributes: ['id', 'name', 'code'] },
  userRef('creator'),
  userRef('submitter'),
  userRef('approver'),
  userRef('rejecter'),
  userRef('canceller'),
  {
    model: StockAdjustmentItem,
    as: 'items',
    include: lineIncludes(),
    separate: true,
    order: [['sortOrder', 'ASC']],
  },
];

export async function listAdjustments(ctx, query) {
  const q = parseListQuery(query, LIST_OPTIONS);
  const where = { ...q.where, companyId: ctx.auth.companyId, ...branchScopeWhere(ctx, 'branchId') };
  if (query.from || query.to) {
    where.adjustmentDate = {
      ...(query.from && { [Op.gte]: query.from }),
      ...(query.to && { [Op.lte]: query.to }),
    };
  }
  const { rows, count } = await StockAdjustment.findAndCountAll({
    where,
    include: [warehouseRef('warehouse'), userRef('creator')],
    attributes: {
      include: [
        [
          sequelize.literal(
            '(SELECT COUNT(*) FROM stock_adjustment_items i WHERE i.adjustment_id = StockAdjustment.id)',
          ),
          'itemsCount',
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

export async function getAdjustment(ctx, id, t) {
  const doc = await StockAdjustment.findOne({
    where: { id, companyId: ctx.auth.companyId, ...branchScopeWhere(ctx, 'branchId') },
    include: detailInclude(),
    transaction: t,
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  return doc.toJSON();
}

/** Validate and shape the lines of a draft (no stock is touched). */
async function prepareLines(ctx, kind, header, items, t) {
  const lines = await normalizeLines(ctx, items, t, { allowNewBatch: true });
  return lines.map((l, i) => {
    const direction = kind === 'opening' ? 'in' : OUT_KINDS.has(kind) ? 'out' : l.direction;
    if (!direction) throw invalid(`items.${i}.direction`, 'Choose stock in or stock out');
    if (direction === 'out' && l.batchNo)
      throw invalid(`items.${i}.batchNo`, 'Stock-out lines take an existing batch');
    if (isLotTracked(l.product) && !l.batchId && !l.batchNo) {
      throw invalid(`items.${i}.batchId`, direction === 'in' ? 'Enter a batch number' : 'Choose a batch');
    }
    if (direction === 'in' && l.product.trackExpiry && !l.batchId && l.batchNo && !l.expiryDate) {
      throw invalid(`items.${i}.expiryDate`, 'Enter the expiry date');
    }
    return {
      productId: l.productId,
      variantId: l.variantId,
      direction,
      batchId: l.batchId,
      batchNo: l.batchNo,
      mfgDate: direction === 'in' ? (l.mfgDate ?? null) : null,
      expiryDate: direction === 'in' ? (l.expiryDate ?? null) : null,
      unitId: l.unitId,
      unitFactor: l.unitFactor,
      quantity: fixed4(l.quantity),
      baseQuantity: l.baseQuantity,
      unitCost: direction === 'in' && l.unitCost != null ? fixed4(l.unitCost) : '0.0000',
      totalCost:
        direction === 'in' && l.unitCost != null ? fixed4(D(l.unitCost).times(l.baseQuantity)) : '0.0000',
      reason: l.reason ?? header.reason ?? DEFAULT_REASON[kind] ?? null,
      serialNumbers: l.serialNumbers,
      notes: l.notes ?? null,
      sortOrder: i,
    };
  });
}

async function writeDraft(ctx, doc, input, t) {
  const warehouse = await writableWarehouse(ctx, input.warehouseId, 'warehouseId', t);
  const lines = await prepareLines(ctx, input.kind, input, input.items, t);
  await doc.update(
    {
      warehouseId: warehouse.id,
      branchId: warehouse.branchId,
      adjustmentDate: input.adjustmentDate ?? doc.adjustmentDate ?? (await companyToday(ctx.auth.companyId)),
      reason: input.reason ?? DEFAULT_REASON[input.kind] ?? null,
      notes: input.notes ?? null,
      status: 'draft',
      rejectedBy: null,
      rejectedAt: null,
      rejectionReason: null,
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  await StockAdjustmentItem.destroy({ where: { adjustmentId: doc.id }, transaction: t });
  await StockAdjustmentItem.bulkCreate(
    lines.map((l) => ({ ...l, adjustmentId: doc.id })),
    { transaction: t },
  );
}

export async function createAdjustment(ctx, input) {
  const id = await sequelize.transaction(async (t) => {
    const warehouse = await writableWarehouse(ctx, input.warehouseId, 'warehouseId', t);
    const number = await nextNumber({
      companyId: ctx.auth.companyId,
      docType: SERIES[input.kind],
      branchId: warehouse.branchId,
      transaction: t,
    });
    const doc = await StockAdjustment.create(
      {
        companyId: ctx.auth.companyId,
        branchId: warehouse.branchId,
        warehouseId: warehouse.id,
        number,
        kind: input.kind,
        adjustmentDate: input.adjustmentDate ?? (await companyToday(ctx.auth.companyId)),
        status: 'draft',
        createdBy: ctx.auth.userId,
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
    await writeDraft(ctx, doc, input, t);
    return doc.id;
  });
  return getAdjustment(ctx, id);
}

export async function updateAdjustment(ctx, id, input) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDocument(StockAdjustment, ctx, id, t, {
      label: LABEL,
      allowed: ['draft', 'rejected'],
    });
    if (doc.kind !== input.kind) throw invalid('kind', 'The kind of an adjustment cannot be changed');
    await writeDraft(ctx, doc, input, t);
  });
  return getAdjustment(ctx, id);
}

export async function deleteAdjustment(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDocument(StockAdjustment, ctx, id, t, {
      label: LABEL,
      allowed: ['draft', 'rejected', 'cancelled'],
    });
    assertBranchAccess(ctx, doc.branchId);
    await doc.update(
      { number: retiredValue(doc.number, doc.id, 60), updatedBy: ctx.auth.userId },
      { transaction: t },
    );
    await doc.destroy({ transaction: t });
  });
}

/** Post the document's lines to the ledger (status must already be checked and locked). */
async function post(ctx, doc, t) {
  const warehouse = await writableWarehouse(ctx, doc.warehouseId, 'warehouseId', t, { requireAccess: false });
  const items = await StockAdjustmentItem.findAll({
    where: { adjustmentId: doc.id },
    order: [['sortOrder', 'ASC']],
    transaction: t,
  });
  if (!items.length) throw invalid('items', 'Add at least one item');
  const lines = await normalizeLines(
    ctx,
    items.map((i) => ({ ...i.toJSON(), quantity: i.quantity })),
    t,
    { allowNewBatch: true },
  );

  if (doc.kind === 'opening') {
    for (const line of lines) {
      const prior = await StockMovement.count({
        where: {
          warehouseId: doc.warehouseId,
          productId: line.productId,
          variantId: line.variantId ?? null,
          [Op.not]: { referenceType: 'stock_adjustment', referenceId: doc.id },
        },
        transaction: t,
      });
      if (prior) {
        throw invalid(
          `${line.field}.productId`,
          `${line.product.name} already has stock movements in ${warehouse.name}; use a stock adjustment instead`,
        );
      }
    }
  }

  const entries = [];
  for (const [i, line] of lines.entries()) {
    const item = items[i];
    let batchId = line.batchId;
    if (line.direction === 'in' && !batchId && line.batchNo) {
      const batch = await resolveBatch(
        {
          companyId: ctx.auth.companyId,
          product: line.product,
          variantId: line.variantId,
          batchNo: line.batchNo,
          expiryDate: line.expiryDate,
          mfgDate: line.mfgDate,
          userId: ctx.auth.userId,
          field: line.field,
        },
        t,
      );
      batchId = batch.id;
      await item.update({ batchId }, { transaction: t });
    }
    let unitCost;
    if (line.direction === 'in') {
      unitCost = D(item.unitCost);
      if (unitCost.isZero()) {
        // Blank cost: current average, else the product's purchase price.
        const { avgCost } = await itemPosition(
          { warehouseId: doc.warehouseId, productId: line.productId, variantId: line.variantId },
          t,
        );
        unitCost = avgCost.gt(0) ? avgCost : D(line.product.purchasePrice);
      }
    }
    entries.push({
      warehouseId: doc.warehouseId,
      productId: line.productId,
      variantId: line.variantId,
      batchId,
      quantity: line.direction === 'in' ? line.baseQuantity : D(line.baseQuantity).neg().toFixed(),
      unitCost: unitCost?.toFixed(),
      type: MOVEMENT_TYPE[doc.kind](line.direction),
      referenceItemId: item.id,
      serialNumbers: line.serialNumbers,
      serialStatus: SERIAL_STATUS[doc.kind],
      notes: item.reason ? `Reason: ${item.reason}` : null,
      field: line.field,
    });
  }

  const movements = await postMovements({
    companyId: ctx.auth.companyId,
    userId: ctx.auth.userId,
    date: doc.adjustmentDate,
    reference: { type: 'stock_adjustment', id: doc.id, no: doc.number },
    entries,
    transaction: t,
  });
  for (const [i, m] of movements.entries()) {
    await items[i].update(
      { unitCost: m.unitCost, totalCost: fixed4(D(m.totalCost).abs()) },
      { transaction: t },
    );
  }
  return sumTotals(movements);
}

export async function submitAdjustment(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDocument(StockAdjustment, ctx, id, t, { label: LABEL, allowed: ['draft'] });
    const warehouse = await writableWarehouse(ctx, doc.warehouseId, 'warehouseId', t);
    const items = await StockAdjustmentItem.findAll({ where: { adjustmentId: doc.id }, transaction: t });
    if (!items.length) throw invalid('items', 'Add at least one item');
    const lines = await normalizeLines(
      ctx,
      items.map((i) => i.toJSON()),
      t,
      { allowNewBatch: true },
    );
    for (const line of lines) {
      if (line.product.trackSerial && line.serialNumbers.length !== Number(line.baseQuantity)) {
        throw invalid(
          `${line.field}.serialNumbers`,
          `Enter ${Number(line.baseQuantity)} serial number(s) for ${line.product.name}`,
        );
      }
    }
    await assertAvailable(
      ctx,
      warehouse,
      lines.filter((l) => l.direction === 'out'),
      t,
    );

    const { requireApproval } = await inventorySettings(ctx.auth.companyId, t);
    const now = new Date();
    const submitted = { submittedBy: ctx.auth.userId, submittedAt: now, updatedBy: ctx.auth.userId };
    if (requireApproval) {
      await doc.update({ ...submitted, status: 'pending_approval' }, { transaction: t });
      return;
    }
    const totalValue = await post(ctx, doc, t);
    await doc.update(
      { ...submitted, status: 'posted', approvedBy: ctx.auth.userId, approvedAt: now, totalValue },
      { transaction: t },
    );
  });
  return getAdjustment(ctx, id);
}

export async function approveAdjustment(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDocument(StockAdjustment, ctx, id, t, {
      label: LABEL,
      allowed: ['pending_approval'],
    });
    await writableWarehouse(ctx, doc.warehouseId, 'warehouseId', t);
    const totalValue = await post(ctx, doc, t);
    await doc.update(
      {
        status: 'posted',
        approvedBy: ctx.auth.userId,
        approvedAt: new Date(),
        totalValue,
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
  });
  return getAdjustment(ctx, id);
}

export async function rejectAdjustment(ctx, id, reason) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDocument(StockAdjustment, ctx, id, t, {
      label: LABEL,
      allowed: ['pending_approval'],
    });
    await writableWarehouse(ctx, doc.warehouseId, 'warehouseId', t);
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
  return getAdjustment(ctx, id);
}

export async function cancelAdjustment(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDocument(StockAdjustment, ctx, id, t, {
      label: LABEL,
      allowed: ['draft', 'pending_approval', 'rejected'],
    });
    await writableWarehouse(ctx, doc.warehouseId, 'warehouseId', t);
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
  return getAdjustment(ctx, id);
}
