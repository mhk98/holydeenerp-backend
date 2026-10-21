import { Op } from 'sequelize';
import { sequelize } from '../../config/db.js';
import {
  Bom,
  BomByproduct,
  BomComponent,
  BomOperation,
  BomQualityCheck,
  ManufacturingOrder,
  MoMaterial,
  MoOperation,
  MoOutput,
  MoScrap,
  Product,
  ProductVariant,
  QualityCheck,
  SalesOrder,
  SalesOrderItem,
  StockBatch,
  User,
  Warehouse,
  WorkCenter,
} from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { parseListQuery } from '../../utils/pagination.js';
import { retiredValue } from '../../utils/slug.js';
import { by, postSource, unpostSource } from '../accounting/posting.service.js';
import { nextAccountingNumber } from '../accounting/series.js';
import {
  assertBranchAccess,
  companyToday,
  invalid,
  writableWarehouse,
} from '../inventory/inventory.common.js';
import { isLotTracked, postMovements, resolveBatch } from '../inventory/stock.engine.js';
import { assignBatches } from '../pos/catalog.service.js';
import { D, addDays, dateRange, fixed, inScope } from '../purchase/purchase.common.js';
import { bomFor, defaultBoms, standardCost } from './bom.service.js';

/**
 * Manufacturing orders.
 *   draft ─confirm─▶ confirmed ─issue─▶ material_issued ─start─▶ in_progress ─submit─▶ quality_check
 *     ─complete─▶ completed ─close─▶ closed            (rework sends quality_check back to in_progress)
 * Stock and ledger move with each step (the stock engine values movements; WIP is the contra):
 *   issue / return materials   Dr WIP ↔ Cr Inventory            (movement production_issue / _return)
 *   finish an operation        Dr WIP  Cr Labour & overhead applied   (minutes × work-center rates; event op:<id>)
 *   complete                   Dr Inventory (finished goods, by-products)  Cr WIP — at actual cost
 *   close                      whatever is left in WIP (scrap, rounding) → production variance
 * Finished goods carry the actual cost; the BOM's standard cost is kept for comparison.
 */

const LABEL = 'Manufacturing order';
const ACTIVE = ['confirmed', 'material_issued', 'in_progress', 'quality_check'];
const LIST_OPTIONS = {
  sortable: ['number', 'plannedStart', 'plannedEnd', 'quantity', 'createdAt'],
  searchable: ['number', 'notes'],
  filterable: ['status', 'productId', 'priority', 'salesOrderId', 'bomId'],
  defaultSort: '-createdAt',
};

const productRef = () => ({
  model: Product,
  as: 'product',
  attributes: ['id', 'name', 'sku', 'baseUnitId', 'trackBatch', 'trackExpiry'],
  paranoid: false,
});
const variantRef = () => ({
  model: ProductVariant,
  as: 'variant',
  attributes: ['id', 'name', 'sku'],
  paranoid: false,
});
const warehouseRef = (as) => ({ model: Warehouse, as, attributes: ['id', 'code', 'name', 'branchId'] });
const userRef = (as) => ({ model: User, as, attributes: ['id', 'name'] });

export async function listOrders(ctx, query) {
  const q = parseListQuery(query, LIST_OPTIONS);
  const where = {
    ...q.where,
    companyId: ctx.auth.companyId,
    ...inScope(ctx),
    ...dateRange('plannedStart', query),
  };
  if (query.active === 'true') where.status = { [Op.in]: ACTIVE };
  const { rows, count } = await ManufacturingOrder.findAndCountAll({
    where,
    include: [
      productRef(),
      variantRef(),
      { model: Bom, as: 'bom', attributes: ['id', 'code', 'version'], paranoid: false },
      { model: SalesOrder, as: 'salesOrder', attributes: ['id', 'number'], paranoid: false },
    ],
    order: [...q.order, ['id', 'DESC']],
    limit: q.limit,
    offset: q.offset,
    distinct: true,
  });
  return { rows: rows.map((r) => r.toJSON()), count, page: q.page, limit: q.limit };
}

export async function getOrder(ctx, id) {
  const doc = await ManufacturingOrder.findOne({
    where: { id, companyId: ctx.auth.companyId, ...inScope(ctx) },
    include: [
      productRef(),
      variantRef(),
      { model: Bom, as: 'bom', attributes: ['id', 'code', 'version', 'quantity'], paranoid: false },
      { model: SalesOrder, as: 'salesOrder', attributes: ['id', 'number'], paranoid: false },
      { model: ManufacturingOrder, as: 'parent', attributes: ['id', 'number'] },
      warehouseRef('rawWarehouse'),
      warehouseRef('finishedWarehouse'),
      ...['creator', 'confirmer', 'completer', 'closer', 'canceller'].map(userRef),
      {
        model: MoMaterial,
        as: 'materials',
        separate: true,
        order: [['sortOrder', 'ASC']],
        include: [productRef(), variantRef()],
      },
      {
        model: MoOperation,
        as: 'operations',
        separate: true,
        order: [['sequence', 'ASC']],
        include: [
          { model: WorkCenter, as: 'workCenter', attributes: ['id', 'code', 'name'], paranoid: false },
        ],
      },
      {
        model: MoOutput,
        as: 'outputs',
        separate: true,
        include: [
          productRef(),
          variantRef(),
          { model: StockBatch, as: 'batch', attributes: ['id', 'batchNo'] },
        ],
      },
      { model: MoScrap, as: 'scrap', separate: true, include: [productRef(), variantRef()] },
      {
        model: QualityCheck,
        as: 'qualityChecks',
        separate: true,
        order: [['checkedAt', 'ASC']],
        include: [userRef('checker')],
      },
    ],
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  const checkpoints = await BomQualityCheck.findAll({
    where: { bomId: doc.bomId },
    order: [['sequence', 'ASC']],
  });
  const children = await ManufacturingOrder.findAll({
    where: { parentId: doc.id, companyId: ctx.auth.companyId },
    attributes: ['id', 'number', 'status', 'quantity', 'productId'],
  });
  return {
    ...doc.toJSON(),
    checkpoints: checkpoints.map((c) => c.toJSON()),
    children: children.map((c) => c.toJSON()),
  };
}

async function lockOrder(ctx, id, t, allowed) {
  const doc = await ManufacturingOrder.findOne({
    where: { id, companyId: ctx.auth.companyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  assertBranchAccess(ctx, doc.branchId);
  if (allowed && !allowed.includes(doc.status))
    throw AppError.conflict(
      `${LABEL} ${doc.number} is ${doc.status.replaceAll('_', ' ')}; this action is not allowed`,
    );
  return doc;
}

/** BOM to use: the one asked for (active, of this product) or the product's default. */
async function pickBom(ctx, input, t) {
  if (input.bomId) {
    const bom = await Bom.findOne({
      where: { id: input.bomId, companyId: ctx.auth.companyId, status: 'active' },
      transaction: t,
    });
    if (!bom || String(bom.productId) !== String(input.productId))
      throw invalid('bomId', 'Active BOM not found for this product');
    return bom;
  }
  const bom = bomFor(await defaultBoms(ctx.auth.companyId, t), input.productId, input.variantId);
  if (!bom) throw invalid('productId', 'This product has no active bill of materials');
  return bom;
}

/** Snapshot BOM lines, routing and standard cost onto an order for `quantity`. */
async function plan(ctx, doc, bom, t) {
  const factor = D(doc.quantity).dividedBy(bom.quantity);
  const components = await BomComponent.findAll({
    where: { bomId: bom.id },
    order: [['sortOrder', 'ASC']],
    transaction: t,
  });
  const operations = await BomOperation.findAll({
    where: { bomId: bom.id },
    include: [{ model: WorkCenter, as: 'workCenter', paranoid: false }],
    order: [['sequence', 'ASC']],
    transaction: t,
  });
  await MoMaterial.destroy({ where: { orderId: doc.id }, transaction: t });
  await MoOperation.destroy({ where: { orderId: doc.id }, transaction: t });
  await MoMaterial.bulkCreate(
    components.map((c, i) => ({
      orderId: doc.id,
      productId: c.productId,
      variantId: c.variantId,
      requiredQuantity: fixed(
        D(c.baseQuantity)
          .times(D(1).plus(D(c.wastagePercent).dividedBy(100)))
          .times(factor),
      ),
      sortOrder: i,
    })),
    { transaction: t },
  );
  await MoOperation.bulkCreate(
    operations.map((o) => ({
      orderId: doc.id,
      sequence: o.sequence,
      name: o.name,
      workCenterId: o.workCenterId,
      plannedMinutes: fixed(D(o.setupMinutes).plus(D(o.runMinutes).times(factor)), 2),
    })),
    { transaction: t },
  );
  const cost = await standardCost(ctx.auth.companyId, bom, doc.quantity, t);
  await doc.update(
    { stdMaterialCost: cost.material, stdLabourCost: cost.labour, stdOverheadCost: cost.overhead },
    { transaction: t },
  );
}

async function writeOrder(ctx, doc, input, t) {
  const raw = await writableWarehouse(ctx, input.rawWarehouseId, 'rawWarehouseId', t);
  const finished = await writableWarehouse(
    ctx,
    input.finishedWarehouseId ?? input.rawWarehouseId,
    'finishedWarehouseId',
    t,
  );
  const bom = await pickBom(ctx, input, t);
  if (input.salesOrderItemId) {
    const item = await SalesOrderItem.findOne({
      where: { id: input.salesOrderItemId },
      include: [
        { model: SalesOrder, as: 'order', where: { companyId: ctx.auth.companyId }, attributes: ['id'] },
      ],
      transaction: t,
    });
    if (!item || String(item.productId) !== String(input.productId))
      throw invalid('salesOrderItemId', 'This sales order line is not for this product');
    input.salesOrderId = item.orderId;
  }
  const plannedStart = input.plannedStart ?? (await companyToday(ctx.auth.companyId));
  await doc.update(
    {
      branchId: raw.branchId,
      productId: input.productId,
      variantId: input.variantId ?? null,
      bomId: bom.id,
      quantity: fixed(input.quantity),
      rawWarehouseId: raw.id,
      finishedWarehouseId: finished.id,
      priority: input.priority ?? 'normal',
      plannedStart,
      plannedEnd: input.plannedEnd ?? plannedStart,
      salesOrderId: input.salesOrderId ?? null,
      salesOrderItemId: input.salesOrderItemId ?? null,
      parentId: input.parentId ?? null,
      notes: input.notes ?? null,
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  if (doc.plannedEnd < doc.plannedStart) throw invalid('plannedEnd', 'The end is before the start');
  await plan(ctx, doc, bom, t);
  // Default end: the routing's minutes over an 8-hour day (at least the start day).
  if (!input.plannedEnd) {
    const minutes = await MoOperation.sum('plannedMinutes', { where: { orderId: doc.id }, transaction: t });
    const days = Math.max(0, Math.ceil(Number(minutes || 0) / 480) - 1);
    await doc.update({ plannedEnd: addDays(plannedStart, days) }, { transaction: t });
  }
}

/** Create a draft order inside a transaction (also used from sales orders and MRP). */
export async function createOrderDraft(ctx, input, t) {
  const raw = await writableWarehouse(ctx, input.rawWarehouseId, 'rawWarehouseId', t);
  const bom = await pickBom(ctx, input, t);
  const doc = await ManufacturingOrder.create(
    {
      companyId: ctx.auth.companyId,
      branchId: raw.branchId,
      number: await nextAccountingNumber({
        companyId: ctx.auth.companyId,
        docType: 'production_order',
        branchId: raw.branchId,
        userId: ctx.auth.userId,
        transaction: t,
      }),
      productId: input.productId,
      bomId: bom.id,
      quantity: fixed(input.quantity),
      rawWarehouseId: input.rawWarehouseId,
      finishedWarehouseId: input.finishedWarehouseId ?? input.rawWarehouseId,
      plannedStart: input.plannedStart ?? (await companyToday(ctx.auth.companyId)),
      plannedEnd: input.plannedEnd ?? input.plannedStart ?? (await companyToday(ctx.auth.companyId)),
      status: 'draft',
      createdBy: ctx.auth.userId,
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  await writeOrder(ctx, doc, { ...input, bomId: bom.id }, t);
  return doc;
}

export async function createOrder(ctx, input) {
  const doc = await sequelize.transaction((t) => createOrderDraft(ctx, input, t));
  return getOrder(ctx, doc.id);
}

export async function updateOrder(ctx, id, input) {
  await sequelize.transaction(async (t) => {
    const doc = await lockOrder(ctx, id, t, ['draft']);
    await writeOrder(ctx, doc, input, t);
  });
  return getOrder(ctx, id);
}

export async function deleteOrder(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockOrder(ctx, id, t, ['draft', 'cancelled']);
    await doc.update({ number: retiredValue(doc.number, doc.id, 60) }, { transaction: t });
    await doc.destroy({ transaction: t });
  });
}

/** Planning tweaks allowed until production starts (also used by the schedule / Kanban). */
export async function rescheduleOrder(ctx, id, { plannedStart, plannedEnd, priority }) {
  await sequelize.transaction(async (t) => {
    const doc = await lockOrder(ctx, id, t, ['draft', 'confirmed', 'material_issued', 'in_progress']);
    const start = plannedStart ?? doc.plannedStart;
    const end = plannedEnd ?? doc.plannedEnd;
    if (end < start) throw invalid('plannedEnd', 'The end is before the start');
    await doc.update(
      { plannedStart: start, plannedEnd: end, ...(priority && { priority }), updatedBy: ctx.auth.userId },
      { transaction: t },
    );
  });
  return getOrder(ctx, id);
}

export async function confirmOrder(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockOrder(ctx, id, t, ['draft']);
    if (!(await MoMaterial.count({ where: { orderId: doc.id }, transaction: t })))
      throw AppError.unprocessable('The order has no materials');
    await doc.update(
      {
        status: 'confirmed',
        confirmedBy: ctx.auth.userId,
        confirmedAt: new Date(),
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
  });
  return getOrder(ctx, id);
}

export async function cancelOrder(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockOrder(ctx, id, t, ['draft', 'confirmed', 'material_issued']);
    const issued = await MoMaterial.findAll({ where: { orderId: doc.id }, transaction: t });
    if (issued.some((m) => D(m.issuedQuantity).minus(m.returnedQuantity).gt(0)))
      throw AppError.conflict('Return the issued materials before cancelling');
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
  return getOrder(ctx, id);
}

const reference = (doc) => ({ type: 'manufacturing_order', id: doc.id, no: doc.number });

/**
 * Issue materials from the raw-material warehouse. `lines` [{ materialId, quantity, batchId? }];
 * without lines, everything still to issue. Lot-tracked materials are picked FEFO when no batch is given.
 */
export async function issueMaterials(ctx, id, { lines, date } = {}) {
  await sequelize.transaction(async (t) => {
    const doc = await lockOrder(ctx, id, t, ['confirmed', 'material_issued', 'in_progress']);
    await writableWarehouse(ctx, doc.rawWarehouseId, 'rawWarehouseId', t);
    const materials = await MoMaterial.findAll({
      where: { orderId: doc.id },
      order: [['sortOrder', 'ASC']],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    const byId = new Map(materials.map((m) => [String(m.id), m]));
    const wanted = lines?.length
      ? lines.map((l, i) => {
          const m = byId.get(String(l.materialId));
          if (!m) throw invalid(`lines.${i}.materialId`, 'Material not found on this order');
          return { material: m, quantity: D(l.quantity), batchId: l.batchId ?? null, field: `lines.${i}` };
        })
      : materials
          .map((m) => ({
            material: m,
            quantity: D(m.requiredQuantity).minus(D(m.issuedQuantity).minus(m.returnedQuantity)),
            batchId: null,
          }))
          .filter((l) => l.quantity.gt(0));
    if (!wanted.length) throw AppError.conflict('Everything has been issued already');
    // FEFO batches for lot-tracked materials (may split one line into several batches).
    const picked = await assignBatches(
      ctx,
      wanted.map((w) => ({
        productId: w.material.productId,
        variantId: w.material.variantId,
        quantity: w.quantity.toFixed(),
        batchId: w.batchId,
        ref: w,
      })),
      doc.rawWarehouseId,
      t,
    );
    const entries = picked.map((p, i) => ({
      warehouseId: doc.rawWarehouseId,
      productId: p.productId,
      variantId: p.variantId,
      batchId: p.batchId ?? null,
      quantity: D(p.quantity).neg().toFixed(),
      type: 'production_issue',
      referenceItemId: p.ref.material.id,
      field: p.ref.field ?? `lines.${i}`,
    }));
    const movements = await postMovements({
      companyId: ctx.auth.companyId,
      userId: ctx.auth.userId,
      date: date ?? (await companyToday(ctx.auth.companyId)),
      reference: reference(doc),
      entries,
      transaction: t,
    });
    let total = D(0);
    for (const [i, m] of movements.entries()) {
      const material = picked[i].ref.material;
      const cost = D(m.totalCost).abs();
      total = total.plus(cost);
      await material.update(
        {
          issuedQuantity: fixed(D(material.issuedQuantity).plus(picked[i].quantity)),
          cost: fixed(D(material.cost).plus(cost)),
        },
        { transaction: t },
      );
    }
    await doc.update(
      {
        materialCost: fixed(D(doc.materialCost).plus(total)),
        ...(doc.status === 'confirmed' && { status: 'material_issued' }),
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
  });
  return getOrder(ctx, id);
}

/** Return unused materials to the raw-material warehouse at the cost they were issued at. */
export async function returnMaterials(ctx, id, { lines, date }) {
  await sequelize.transaction(async (t) => {
    const doc = await lockOrder(ctx, id, t, ['material_issued', 'in_progress', 'quality_check', 'completed']);
    await writableWarehouse(ctx, doc.rawWarehouseId, 'rawWarehouseId', t);
    const entries = [];
    const updates = [];
    for (const [i, l] of lines.entries()) {
      const m = await MoMaterial.findOne({
        where: { id: l.materialId, orderId: doc.id },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!m) throw invalid(`lines.${i}.materialId`, 'Material not found on this order');
      const net = D(m.issuedQuantity).minus(m.returnedQuantity);
      if (D(l.quantity).gt(net))
        throw invalid(`lines.${i}.quantity`, `Only ${net.toFixed()} is out on this order`);
      const unitCost = net.gt(0) ? D(m.cost).dividedBy(net) : D(0);
      const cost = unitCost.times(l.quantity);
      const product = await Product.findByPk(m.productId, { transaction: t });
      if (isLotTracked(product) && !l.batchId)
        throw invalid(`lines.${i}.batchId`, `Choose the batch of ${product.name}`);
      entries.push({
        warehouseId: doc.rawWarehouseId,
        productId: m.productId,
        variantId: m.variantId,
        batchId: l.batchId ?? null,
        quantity: D(l.quantity).toFixed(),
        unitCost: unitCost.toFixed(),
        totalCost: fixed(cost),
        type: 'production_return',
        referenceItemId: m.id,
        field: `lines.${i}`,
      });
      updates.push([m, D(l.quantity), cost]);
    }
    await postMovements({
      companyId: ctx.auth.companyId,
      userId: ctx.auth.userId,
      date: date ?? (await companyToday(ctx.auth.companyId)),
      reference: reference(doc),
      entries,
      transaction: t,
    });
    let total = D(0);
    for (const [m, qty, cost] of updates) {
      total = total.plus(cost);
      await m.update(
        { returnedQuantity: fixed(D(m.returnedQuantity).plus(qty)), cost: fixed(D(m.cost).minus(cost)) },
        { transaction: t },
      );
    }
    await doc.update(
      { materialCost: fixed(D(doc.materialCost).minus(total)), updatedBy: ctx.auth.userId },
      { transaction: t },
    );
  });
  return getOrder(ctx, id);
}

export async function startOrder(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockOrder(ctx, id, t, ['confirmed', 'material_issued']);
    await doc.update(
      { status: 'in_progress', actualStart: new Date(), updatedBy: ctx.auth.userId },
      { transaction: t },
    );
  });
  return getOrder(ctx, id);
}

async function lockOperation(ctx, id, opId, t) {
  const doc = await lockOrder(ctx, id, t, ['in_progress']);
  const op = await MoOperation.findOne({
    where: { id: opId, orderId: doc.id },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!op) throw AppError.notFound('Operation not found');
  return { doc, op };
}

export async function startOperation(ctx, id, opId) {
  await sequelize.transaction(async (t) => {
    const { op } = await lockOperation(ctx, id, opId, t);
    if (op.status !== 'pending')
      throw AppError.conflict(`Operation ${op.name} is ${op.status.replace('_', ' ')}`);
    await op.update({ status: 'in_progress', startedAt: new Date() }, { transaction: t });
  });
  return getOrder(ctx, id);
}

/** Finish an operation with the minutes it took: labour and overhead go to WIP. */
export async function finishOperation(ctx, id, opId, { actualMinutes }) {
  await sequelize.transaction(async (t) => {
    const { doc, op } = await lockOperation(ctx, id, opId, t);
    if (op.status === 'done') throw AppError.conflict(`Operation ${op.name} is already done`);
    const wc = await WorkCenter.findByPk(op.workCenterId, { paranoid: false, transaction: t });
    const hours = D(actualMinutes).dividedBy(60);
    const labour = hours.times(wc.labourCostPerHour);
    const overhead = hours.times(wc.overheadCostPerHour);
    await op.update(
      {
        status: 'done',
        startedAt: op.startedAt ?? new Date(),
        finishedAt: new Date(),
        actualMinutes: fixed(actualMinutes, 2),
        labourCost: fixed(labour),
        overheadCost: fixed(overhead),
      },
      { transaction: t },
    );
    await doc.update(
      {
        labourCost: fixed(D(doc.labourCost).plus(labour)),
        overheadCost: fixed(D(doc.overheadCost).plus(overhead)),
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
    await postSource('manufacturing_order', doc.id, by(ctx, t, { event: `op:${op.id}` }));
  });
  return getOrder(ctx, id);
}

/** Production done: record how much was made and hand it to quality control. */
export async function submitForQuality(ctx, id, { producedQuantity }) {
  await sequelize.transaction(async (t) => {
    const doc = await lockOrder(ctx, id, t, ['in_progress']);
    const open = await MoOperation.count({
      where: { orderId: doc.id, status: { [Op.ne]: 'done' } },
      transaction: t,
    });
    if (open) throw AppError.conflict(`Finish the ${open} open operation(s) first`);
    if (D(producedQuantity).lte(0)) throw invalid('producedQuantity', 'Enter the quantity produced');
    await doc.update(
      {
        status: 'quality_check',
        producedQuantity: fixed(producedQuantity),
        actualEnd: new Date(),
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
  });
  return getOrder(ctx, id);
}

/**
 * Record a quality checkpoint. Failed units are scrapped (they never reach stock; their cost ends up
 * in the production variance) or sent back for rework (the order returns to in progress).
 */
export async function recordQuality(ctx, id, input) {
  await sequelize.transaction(async (t) => {
    const doc = await lockOrder(ctx, id, t, ['quality_check']);
    const failed = D(input.failedQuantity ?? 0);
    const remaining = D(doc.producedQuantity).minus(doc.scrappedQuantity);
    if (failed.gt(remaining))
      throw invalid('failedQuantity', `Only ${remaining.toFixed()} units are left to check`);
    if (input.result === 'fail' && failed.lte(0))
      throw invalid('failedQuantity', 'Enter how many units failed');
    const action = input.result === 'pass' ? 'accept' : input.action;
    await QualityCheck.create(
      {
        orderId: doc.id,
        name: input.name,
        result: input.result,
        passedQuantity: fixed(remaining.minus(failed)),
        failedQuantity: fixed(failed),
        action,
        reason: input.reason ?? null,
        checkedBy: ctx.auth.userId,
        checkedAt: new Date(),
      },
      { transaction: t },
    );
    if (action === 'scrap') {
      await doc.update(
        { scrappedQuantity: fixed(D(doc.scrappedQuantity).plus(failed)), updatedBy: ctx.auth.userId },
        { transaction: t },
      );
    } else if (action === 'rework') {
      // The failed units go back to production; the rest stays made.
      await doc.update(
        {
          status: 'in_progress',
          producedQuantity: fixed(D(doc.producedQuantity).minus(failed)),
          updatedBy: ctx.auth.userId,
        },
        { transaction: t },
      );
    }
  });
  return getOrder(ctx, id);
}

/** Record material or product wasted during production (for the wastage report). */
export async function recordScrap(ctx, id, input) {
  await sequelize.transaction(async (t) => {
    const doc = await lockOrder(ctx, id, t, ['material_issued', 'in_progress', 'quality_check']);
    const material = await MoMaterial.findOne({
      where: { orderId: doc.id, productId: input.productId, variantId: input.variantId ?? null },
      transaction: t,
    });
    const isProduct = String(input.productId) === String(doc.productId);
    if (!material && !isProduct) throw invalid('productId', 'Choose a material of this order or its product');
    let unit;
    if (material) {
      const net = D(material.issuedQuantity).minus(material.returnedQuantity);
      unit = net.gt(0) ? D(material.cost).dividedBy(net) : D(0);
    } else {
      unit = D(doc.stdMaterialCost).plus(doc.stdLabourCost).plus(doc.stdOverheadCost).dividedBy(doc.quantity);
    }
    await MoScrap.create(
      {
        orderId: doc.id,
        productId: input.productId,
        variantId: input.variantId ?? null,
        quantity: fixed(input.quantity),
        cost: fixed(unit.times(input.quantity)),
        reason: input.reason,
        recordedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
  });
  return getOrder(ctx, id);
}

/**
 * Complete: receive the good units (and by-products) into stock at actual cost. Every quality
 * checkpoint of the BOM must have been recorded. Scrapped units' share of the cost stays in WIP.
 */
export async function completeOrder(ctx, id, input = {}) {
  await sequelize.transaction(async (t) => {
    const doc = await lockOrder(ctx, id, t, ['quality_check']);
    const checkpoints = await BomQualityCheck.findAll({ where: { bomId: doc.bomId }, transaction: t });
    const done = new Set(
      (await QualityCheck.findAll({ where: { orderId: doc.id }, transaction: t })).map((q) => q.name),
    );
    const missing = checkpoints.filter((c) => !done.has(c.name));
    if (missing.length)
      throw AppError.conflict(`Record the quality check(s): ${missing.map((c) => c.name).join(', ')}`);
    await writableWarehouse(ctx, doc.finishedWarehouseId, 'finishedWarehouseId', t);

    const produced = D(doc.producedQuantity);
    const good = produced.minus(doc.scrappedQuantity);
    const total = D(doc.materialCost).plus(doc.labourCost).plus(doc.overheadCost);
    const bom = await Bom.findByPk(doc.bomId, { paranoid: false, transaction: t });
    const byproducts = await BomByproduct.findAll({ where: { bomId: doc.bomId }, transaction: t });
    const date = input.outputDate ?? (await companyToday(ctx.auth.companyId));
    const entries = [];
    const outputs = [];
    let byproductCost = D(0);
    for (const b of byproducts) {
      const qty = D(b.quantity).times(produced).dividedBy(bom.quantity);
      const cost = total.times(b.costSharePercent).dividedBy(100);
      if (qty.lte(0)) continue;
      byproductCost = byproductCost.plus(cost);
      outputs.push({
        kind: 'byproduct',
        productId: b.productId,
        variantId: b.variantId,
        quantity: qty,
        cost,
      });
    }
    // Scrapped units carry their share of the cost; it stays in WIP and becomes the variance.
    const mainCost = total.minus(byproductCost);
    const goodCost = produced.gt(0) ? mainCost.times(good).dividedBy(produced) : D(0);
    if (good.gt(0))
      outputs.unshift({
        kind: 'product',
        productId: doc.productId,
        variantId: doc.variantId,
        quantity: good,
        cost: goodCost,
      });

    for (const [i, o] of outputs.entries()) {
      const product = await Product.findByPk(o.productId, { transaction: t });
      let batchId = null;
      if (isLotTracked(product)) {
        if (product.trackExpiry && !input.expiryDate && o.kind === 'product')
          throw invalid('expiryDate', `Enter the expiry date of ${product.name}`);
        const batch = await resolveBatch(
          {
            companyId: ctx.auth.companyId,
            product,
            variantId: o.variantId,
            batchNo: (o.kind === 'product' ? input.batchNo : null) || doc.number,
            expiryDate: input.expiryDate ?? null,
            mfgDate: date,
            userId: ctx.auth.userId,
            field: `outputs.${i}`,
          },
          t,
        );
        batchId = batch.id;
      }
      o.batchId = batchId;
      entries.push({
        warehouseId: doc.finishedWarehouseId,
        productId: o.productId,
        variantId: o.variantId,
        batchId,
        quantity: o.quantity.toFixed(),
        unitCost: o.cost.dividedBy(o.quantity).toFixed(),
        totalCost: fixed(o.cost),
        type: o.kind === 'product' ? 'production_receipt' : 'production_byproduct',
        field: `outputs.${i}`,
      });
    }
    if (entries.length) {
      await postMovements({
        companyId: ctx.auth.companyId,
        userId: ctx.auth.userId,
        date,
        reference: reference(doc),
        entries,
        transaction: t,
      });
    }
    await MoOutput.bulkCreate(
      outputs.map((o) => ({
        orderId: doc.id,
        kind: o.kind,
        productId: o.productId,
        variantId: o.variantId,
        warehouseId: doc.finishedWarehouseId,
        batchId: o.batchId,
        quantity: fixed(o.quantity),
        unitCost: fixed(o.cost.dividedBy(o.quantity)),
        totalCost: fixed(o.cost),
        outputDate: date,
      })),
      { transaction: t },
    );
    const outputCost = outputs.reduce((s, o) => s.plus(fixed(o.cost)), D(0));
    await doc.update(
      {
        status: 'completed',
        goodQuantity: fixed(good),
        outputCost: fixed(outputCost),
        unitCost: fixed(good.gt(0) ? goodCost.dividedBy(good) : 0),
        completedBy: ctx.auth.userId,
        completedAt: new Date(),
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
  });
  return getOrder(ctx, id);
}

/** Close: what is left in WIP for this order (scrap, rounding) is posted as production variance. */
export async function closeOrder(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockOrder(ctx, id, t, ['completed']);
    const left = D(doc.materialCost).plus(doc.labourCost).plus(doc.overheadCost).minus(doc.outputCost);
    await doc.update(
      {
        status: 'closed',
        varianceCost: fixed(left),
        closedBy: ctx.auth.userId,
        closedAt: new Date(),
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
    await postSource('manufacturing_order', doc.id, by(ctx, t, { event: 'close' }));
  });
  return getOrder(ctx, id);
}

/** Reopen a closed order (reverses the variance entry), e.g. to return leftover material. */
export async function reopenOrder(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockOrder(ctx, id, t, ['closed']);
    await unpostSource('manufacturing_order', doc.id, by(ctx, t, { events: ['close'] }));
    await doc.update(
      { status: 'completed', varianceCost: '0', closedBy: null, closedAt: null, updatedBy: ctx.auth.userId },
      { transaction: t },
    );
  });
  return getOrder(ctx, id);
}

/** Draft orders for the lines of a sales order whose products have a BOM (what is still undelivered). */
export async function ordersFromSalesOrder(
  ctx,
  salesOrderId,
  { rawWarehouseId, finishedWarehouseId, plannedStart },
) {
  const ids = await sequelize.transaction(async (t) => {
    const so = await SalesOrder.findOne({
      where: { id: salesOrderId, companyId: ctx.auth.companyId },
      transaction: t,
    });
    if (!so) throw AppError.notFound('Sales order not found');
    if (!['confirmed', 'partially_delivered'].includes(so.status))
      throw AppError.conflict(`Sales order ${so.number} is ${so.status.replaceAll('_', ' ')}`);
    const boms = await defaultBoms(ctx.auth.companyId, t);
    const items = await SalesOrderItem.findAll({
      where: { orderId: so.id },
      order: [['sortOrder', 'ASC']],
      transaction: t,
    });
    const created = [];
    for (const item of items) {
      const open = D(item.baseQuantity).minus(item.deliveredBaseQuantity);
      const bom = bomFor(boms, item.productId, item.variantId);
      if (!bom || open.lte(0)) continue;
      const already = await ManufacturingOrder.sum('quantity', {
        where: { salesOrderItemId: item.id, status: { [Op.ne]: 'cancelled' } },
        transaction: t,
      });
      const qty = open.minus(already ?? 0);
      if (qty.lte(0)) continue;
      const doc = await createOrderDraft(
        ctx,
        {
          productId: item.productId,
          variantId: item.variantId,
          bomId: bom.id,
          quantity: qty.toFixed(),
          rawWarehouseId: rawWarehouseId ?? so.warehouseId,
          finishedWarehouseId: finishedWarehouseId ?? so.warehouseId,
          plannedStart,
          plannedEnd: undefined,
          salesOrderItemId: item.id,
          priority: 'high',
          notes: `For sales order ${so.number}`,
        },
        t,
      );
      created.push(doc.id);
    }
    if (!created.length) throw AppError.conflict('Nothing on this sales order needs manufacturing');
    return created;
  });
  return Promise.all(ids.map((id) => getOrder(ctx, id)));
}

/** Orders whose planned window overlaps [from, to] (not cancelled), with their operations — for the schedule. */
export async function scheduleOrders(ctx, { from, to, workCenterId }) {
  const rows = await ManufacturingOrder.findAll({
    where: {
      companyId: ctx.auth.companyId,
      ...inScope(ctx),
      status: { [Op.ne]: 'cancelled' },
      plannedStart: { [Op.lte]: to },
      plannedEnd: { [Op.gte]: from },
    },
    include: [
      productRef(),
      variantRef(),
      {
        model: MoOperation,
        as: 'operations',
        separate: true,
        order: [['sequence', 'ASC']],
        include: [
          { model: WorkCenter, as: 'workCenter', attributes: ['id', 'code', 'name'], paranoid: false },
        ],
      },
    ],
    order: [
      ['plannedStart', 'ASC'],
      ['id', 'ASC'],
    ],
    limit: 500,
  });
  const out = rows.map((r) => r.toJSON());
  return workCenterId
    ? out.filter((o) => o.operations.some((op) => String(op.workCenterId) === String(workCenterId)))
    : out;
}
