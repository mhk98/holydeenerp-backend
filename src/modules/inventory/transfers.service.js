import { Op } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { Branch, StockTransfer, StockTransferItem } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { parseListQuery } from '../../utils/pagination.js';
import { retiredValue } from '../../utils/slug.js';
import { nextNumber } from '../sequences/sequences.service.js';
import {
  assertAvailable,
  assertBranchAccess,
  companyToday,
  invalid,
  lineIncludes,
  lockDocument,
  normalizeLines,
  sumTotals,
  userRef,
  warehouseRef,
  writableWarehouse,
} from './inventory.common.js';
import { D, fixed4, isLotTracked, postMovements } from './stock.engine.js';

/**
 * Stock transfers between warehouses (same or different branch).
 *
 *   draft ── dispatch ──▶ in_transit ── receive ──▶ received
 *     └── cancel ─▶ cancelled ◀── cancel (stock returns to the source) ──┘
 *
 * Dispatch takes stock out of the source warehouse at its cost (FIFO layers or average) and
 * fixes that cost on the lines; receiving puts the same quantity, batch, serials and cost into
 * the destination. Users of the source branch dispatch and cancel; users of the destination
 * branch receive.
 */

const LABEL = 'Stock transfer';

const LIST_OPTIONS = {
  sortable: ['number', 'transferDate', 'createdAt', 'totalValue'],
  searchable: ['number', 'notes'],
  filterable: ['status', 'fromWarehouseId', 'toWarehouseId'],
  defaultSort: '-createdAt',
};

const scopeIds = (ctx) => (ctx.branchIds.length ? ctx.branchIds : [0]);

const visibleWhere = (ctx, direction) => {
  if (direction === 'outgoing') return { branchId: { [Op.in]: scopeIds(ctx) } };
  if (direction === 'incoming') return { toBranchId: { [Op.in]: scopeIds(ctx) } };
  return { [Op.or]: [{ branchId: { [Op.in]: scopeIds(ctx) } }, { toBranchId: { [Op.in]: scopeIds(ctx) } }] };
};

const detailInclude = () => [
  warehouseRef('fromWarehouse'),
  warehouseRef('toWarehouse'),
  { model: Branch, as: 'fromBranch', attributes: ['id', 'name', 'code'] },
  { model: Branch, as: 'toBranch', attributes: ['id', 'name', 'code'] },
  userRef('creator'),
  userRef('dispatcher'),
  userRef('receiver'),
  userRef('canceller'),
  {
    model: StockTransferItem,
    as: 'items',
    include: lineIncludes(),
    separate: true,
    order: [['sortOrder', 'ASC']],
  },
];

export async function listTransfers(ctx, query) {
  const q = parseListQuery(query, LIST_OPTIONS);
  const where = {
    [Op.and]: [{ ...q.where, companyId: ctx.auth.companyId }, visibleWhere(ctx, query.direction)],
  };
  if (query.from || query.to) {
    where[Op.and].push({
      transferDate: { ...(query.from && { [Op.gte]: query.from }), ...(query.to && { [Op.lte]: query.to }) },
    });
  }
  const { rows, count } = await StockTransfer.findAndCountAll({
    where,
    include: [warehouseRef('fromWarehouse'), warehouseRef('toWarehouse'), userRef('creator')],
    attributes: {
      include: [
        [
          sequelize.literal(
            '(SELECT COUNT(*) FROM stock_transfer_items i WHERE i.transfer_id = StockTransfer.id)',
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

export async function getTransfer(ctx, id) {
  const doc = await StockTransfer.findOne({
    where: { [Op.and]: [{ id, companyId: ctx.auth.companyId }, visibleWhere(ctx)] },
    include: detailInclude(),
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  return doc.toJSON();
}

async function writeDraft(ctx, doc, input, t) {
  const from = await writableWarehouse(ctx, input.fromWarehouseId, 'fromWarehouseId', t);
  const to = await writableWarehouse(ctx, input.toWarehouseId, 'toWarehouseId', t, { requireAccess: false });
  if (String(from.id) === String(to.id))
    throw invalid('toWarehouseId', 'Choose a different destination warehouse');
  const lines = await normalizeLines(ctx, input.items, t);
  lines.forEach((l) => {
    if (isLotTracked(l.product) && !l.batchId) throw invalid(`${l.field}.batchId`, 'Choose a batch');
  });
  await doc.update(
    {
      branchId: from.branchId,
      fromWarehouseId: from.id,
      toBranchId: to.branchId,
      toWarehouseId: to.id,
      transferDate: input.transferDate ?? doc.transferDate ?? (await companyToday(ctx.auth.companyId)),
      notes: input.notes ?? null,
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  await StockTransferItem.destroy({ where: { transferId: doc.id }, transaction: t });
  await StockTransferItem.bulkCreate(
    lines.map((l, i) => ({
      transferId: doc.id,
      productId: l.productId,
      variantId: l.variantId,
      batchId: l.batchId,
      unitId: l.unitId,
      unitFactor: l.unitFactor,
      quantity: fixed4(l.quantity),
      baseQuantity: l.baseQuantity,
      serialNumbers: l.serialNumbers,
      notes: l.notes ?? null,
      sortOrder: i,
    })),
    { transaction: t },
  );
}

export async function createTransfer(ctx, input) {
  const id = await sequelize.transaction(async (t) => {
    const from = await writableWarehouse(ctx, input.fromWarehouseId, 'fromWarehouseId', t);
    const number = await nextNumber({
      companyId: ctx.auth.companyId,
      docType: 'stock_transfer',
      branchId: from.branchId,
      transaction: t,
    });
    const doc = await StockTransfer.create(
      {
        companyId: ctx.auth.companyId,
        branchId: from.branchId,
        fromWarehouseId: from.id,
        toBranchId: from.branchId,
        toWarehouseId: input.toWarehouseId,
        number,
        transferDate: input.transferDate ?? (await companyToday(ctx.auth.companyId)),
        status: 'draft',
        createdBy: ctx.auth.userId,
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
    await writeDraft(ctx, doc, input, t);
    return doc.id;
  });
  return getTransfer(ctx, id);
}

export async function updateTransfer(ctx, id, input) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDocument(StockTransfer, ctx, id, t, { label: LABEL, allowed: ['draft'] });
    assertBranchAccess(ctx, doc.branchId);
    await writeDraft(ctx, doc, input, t);
  });
  return getTransfer(ctx, id);
}

export async function deleteTransfer(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDocument(StockTransfer, ctx, id, t, {
      label: LABEL,
      allowed: ['draft', 'cancelled'],
    });
    assertBranchAccess(ctx, doc.branchId);
    await doc.update(
      { number: retiredValue(doc.number, doc.id, 60), updatedBy: ctx.auth.userId },
      { transaction: t },
    );
    await doc.destroy({ transaction: t });
  });
}

async function loadLines(ctx, doc, t) {
  const items = await StockTransferItem.findAll({
    where: { transferId: doc.id },
    order: [['sortOrder', 'ASC']],
    transaction: t,
  });
  if (!items.length) throw invalid('items', 'Add at least one item');
  const lines = await normalizeLines(
    ctx,
    items.map((i) => i.toJSON()),
    t,
  );
  return { items, lines };
}

export async function dispatchTransfer(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDocument(StockTransfer, ctx, id, t, { label: LABEL, allowed: ['draft'] });
    const from = await writableWarehouse(ctx, doc.fromWarehouseId, 'fromWarehouseId', t);
    await writableWarehouse(ctx, doc.toWarehouseId, 'toWarehouseId', t, { requireAccess: false });
    const { items, lines } = await loadLines(ctx, doc, t);
    lines.forEach((l) => {
      if (l.product.trackSerial && l.serialNumbers.length !== Number(l.baseQuantity)) {
        throw invalid(
          `${l.field}.serialNumbers`,
          `Enter ${Number(l.baseQuantity)} serial number(s) for ${l.product.name}`,
        );
      }
    });
    await assertAvailable(ctx, from, lines, t);

    const movements = await postMovements({
      companyId: ctx.auth.companyId,
      userId: ctx.auth.userId,
      date: doc.transferDate,
      reference: { type: 'stock_transfer', id: doc.id, no: doc.number },
      entries: lines.map((l, i) => ({
        warehouseId: doc.fromWarehouseId,
        productId: l.productId,
        variantId: l.variantId,
        batchId: l.batchId,
        quantity: D(l.baseQuantity).neg().toFixed(),
        type: 'transfer_out',
        referenceItemId: items[i].id,
        serialNumbers: l.serialNumbers,
        serialStatus: 'in_transit',
        field: l.field,
      })),
      transaction: t,
    });
    for (const [i, m] of movements.entries()) {
      await items[i].update(
        { unitCost: m.unitCost, totalCost: fixed4(D(m.totalCost).abs()) },
        { transaction: t },
      );
    }
    await doc.update(
      {
        status: 'in_transit',
        totalValue: fixed4(D(sumTotals(movements)).abs()),
        dispatchedBy: ctx.auth.userId,
        dispatchedAt: new Date(),
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
  });
  return getTransfer(ctx, id);
}

/** Put the in-transit lines into a warehouse at their dispatch cost. */
async function bringIn(ctx, doc, warehouseId, type, t) {
  const items = await StockTransferItem.findAll({
    where: { transferId: doc.id },
    order: [['sortOrder', 'ASC']],
    transaction: t,
  });
  await postMovements({
    companyId: ctx.auth.companyId,
    userId: ctx.auth.userId,
    date: await companyToday(ctx.auth.companyId),
    reference: { type: 'stock_transfer', id: doc.id, no: doc.number },
    entries: items.map((item, i) => ({
      warehouseId,
      productId: item.productId,
      variantId: item.variantId,
      batchId: item.batchId,
      quantity: item.baseQuantity,
      unitCost: item.unitCost,
      // The dispatch total, so the destination receives exactly the value that left the source.
      totalCost: item.totalCost,
      type,
      referenceItemId: item.id,
      serialNumbers: item.serialNumbers,
      field: `items.${i}`,
    })),
    transaction: t,
  });
}

export async function receiveTransfer(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDocument(StockTransfer, ctx, id, t, { label: LABEL, allowed: ['in_transit'] });
    const to = await writableWarehouse(ctx, doc.toWarehouseId, 'toWarehouseId', t, { requireAccess: false });
    assertBranchAccess(ctx, to.branchId);
    await bringIn(ctx, doc, doc.toWarehouseId, 'transfer_in', t);
    await doc.update(
      { status: 'received', receivedBy: ctx.auth.userId, receivedAt: new Date(), updatedBy: ctx.auth.userId },
      { transaction: t },
    );
  });
  return getTransfer(ctx, id);
}

export async function cancelTransfer(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDocument(StockTransfer, ctx, id, t, {
      label: LABEL,
      allowed: ['draft', 'in_transit'],
    });
    assertBranchAccess(ctx, doc.branchId);
    if (doc.status === 'in_transit') {
      if (!(ctx.auth.permissions.includes('*') || ctx.auth.permissions.includes('inventory.approve'))) {
        throw AppError.forbidden('Cancelling a dispatched transfer needs the inventory.approve permission');
      }
      await bringIn(ctx, doc, doc.fromWarehouseId, 'transfer_return', t);
    }
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
  return getTransfer(ctx, id);
}
