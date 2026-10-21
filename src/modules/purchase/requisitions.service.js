import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { PurchaseRequisition, PurchaseRequisitionItem } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { parseListQuery } from '../../utils/pagination.js';
import { retiredValue } from '../../utils/slug.js';
import {
  assertBranchAccess,
  companyToday,
  normalizeLines,
  writableWarehouse,
} from '../inventory/inventory.common.js';
import { nextNumber } from '../sequences/sequences.service.js';
import {
  D,
  branchRef,
  dateRange,
  fixed,
  inScope,
  lockDoc,
  purchaseLineIncludes,
  purchaseSettings,
  userRef,
  warehouseRef,
} from './purchase.common.js';

/**
 * Purchase requisitions: an internal request to buy. draft → (submit) → pending_approval →
 * approved → ordered (every line is on a purchase order). With "Requisition approval" off in
 * Settings → Purchase, submitting approves straight away. Approved requisitions convert into
 * an RFQ or a purchase order without re-entering lines.
 */

const LABEL = 'Requisition';

const LIST_OPTIONS = {
  sortable: ['number', 'requisitionDate', 'requiredBy', 'createdAt'],
  searchable: ['number', 'notes'],
  filterable: ['status', 'warehouseId'],
  defaultSort: '-createdAt',
};

/** Ordered base quantity per requisition line (from purchase orders that aren't cancelled). */
export async function orderedQuantities(requisitionId, t) {
  const rows = await sequelize.query(
    `SELECT poi.requisition_item_id AS id, SUM(poi.base_quantity) AS qty
       FROM purchase_order_items poi
       JOIN purchase_orders po ON po.id = poi.order_id
      WHERE po.requisition_id = :requisitionId AND po.status <> 'cancelled' AND po.deleted_at IS NULL
        AND poi.requisition_item_id IS NOT NULL
      GROUP BY poi.requisition_item_id`,
    { replacements: { requisitionId }, type: QueryTypes.SELECT, transaction: t },
  );
  return new Map(rows.map((r) => [String(r.id), D(r.qty)]));
}

/** approved ⇄ ordered depending on whether every line is on an order. */
export async function refreshRequisitionStatus(requisitionId, t) {
  if (!requisitionId) return;
  const doc = await PurchaseRequisition.findByPk(requisitionId, { transaction: t, lock: t.LOCK.UPDATE });
  if (!doc || !['approved', 'ordered'].includes(doc.status)) return;
  const items = await PurchaseRequisitionItem.findAll({ where: { requisitionId }, transaction: t });
  const ordered = await orderedQuantities(requisitionId, t);
  const done = items.every((i) => (ordered.get(String(i.id)) ?? D(0)).gte(i.baseQuantity));
  const status = done ? 'ordered' : 'approved';
  if (doc.status !== status) await doc.update({ status }, { transaction: t });
}

export async function listRequisitions(ctx, query) {
  const q = parseListQuery(query, LIST_OPTIONS);
  const { rows, count } = await PurchaseRequisition.findAndCountAll({
    where: {
      ...q.where,
      companyId: ctx.auth.companyId,
      ...inScope(ctx),
      ...dateRange('requisitionDate', query),
    },
    include: [warehouseRef(), userRef('creator')],
    attributes: {
      include: [
        [
          sequelize.literal(
            '(SELECT COUNT(*) FROM purchase_requisition_items i WHERE i.requisition_id = PurchaseRequisition.id)',
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

const nonNegative = (d) => (d.lt(0) ? D(0) : d);

export async function getRequisition(ctx, id, t) {
  const doc = await PurchaseRequisition.findOne({
    where: { id, companyId: ctx.auth.companyId, ...inScope(ctx) },
    include: [
      warehouseRef(),
      branchRef(),
      userRef('creator'),
      userRef('submitter'),
      userRef('approver'),
      userRef('rejecter'),
      userRef('canceller'),
      {
        model: PurchaseRequisitionItem,
        as: 'items',
        include: purchaseLineIncludes({ tax: false }),
        separate: true,
        order: [['sortOrder', 'ASC']],
      },
    ],
    transaction: t,
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  const json = doc.toJSON();
  const ordered = await orderedQuantities(doc.id, t);
  json.items = json.items.map((i) => {
    const done = ordered.get(String(i.id)) ?? D(0);
    return {
      ...i,
      orderedBaseQuantity: fixed(done),
      remainingBaseQuantity: fixed(nonNegative(D(i.baseQuantity).minus(done))),
    };
  });
  return json;
}

async function writeDraft(ctx, doc, input, t) {
  let warehouse = null;
  if (input.warehouseId) warehouse = await writableWarehouse(ctx, input.warehouseId, 'warehouseId', t);
  const lines = await normalizeLines(ctx, input.items, t);
  await doc.update(
    {
      warehouseId: warehouse?.id ?? null,
      ...(warehouse && { branchId: warehouse.branchId }),
      requisitionDate: input.requisitionDate ?? doc.requisitionDate,
      requiredBy: input.requiredBy ?? null,
      notes: input.notes ?? null,
      status: 'draft',
      rejectedBy: null,
      rejectedAt: null,
      rejectionReason: null,
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  await PurchaseRequisitionItem.destroy({ where: { requisitionId: doc.id }, transaction: t });
  await PurchaseRequisitionItem.bulkCreate(
    lines.map((l, i) => ({
      requisitionId: doc.id,
      productId: l.productId,
      variantId: l.variantId,
      unitId: l.unitId,
      unitFactor: l.unitFactor,
      quantity: fixed(l.quantity),
      baseQuantity: l.baseQuantity,
      estimatedPrice: l.estimatedPrice ?? null,
      notes: l.notes ?? null,
      sortOrder: i,
    })),
    { transaction: t },
  );
}

/** Branch of a requisition: its warehouse's, else the selected / default branch of the user. */
function defaultBranch(ctx) {
  const id = ctx.branchId ?? ctx.auth.branches?.find((b) => b.isDefault)?.id ?? ctx.auth.branchIds?.[0];
  if (!id) throw AppError.forbidden('You have no branch to raise requisitions for');
  return id;
}

export async function createRequisition(ctx, input) {
  const id = await sequelize.transaction(async (t) => {
    const branchId = input.warehouseId
      ? (await writableWarehouse(ctx, input.warehouseId, 'warehouseId', t)).branchId
      : defaultBranch(ctx);
    const number = await nextNumber({
      companyId: ctx.auth.companyId,
      docType: 'purchase_requisition',
      branchId,
      transaction: t,
    });
    const doc = await PurchaseRequisition.create(
      {
        companyId: ctx.auth.companyId,
        branchId,
        number,
        requisitionDate: input.requisitionDate ?? (await companyToday(ctx.auth.companyId)),
        status: 'draft',
        createdBy: ctx.auth.userId,
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
    await writeDraft(ctx, doc, input, t);
    return doc.id;
  });
  return getRequisition(ctx, id);
}

export async function updateRequisition(ctx, id, input) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(PurchaseRequisition, ctx, id, t, {
      label: LABEL,
      allowed: ['draft', 'rejected'],
    });
    assertBranchAccess(ctx, doc.branchId);
    await writeDraft(ctx, doc, input, t);
  });
  return getRequisition(ctx, id);
}

export async function deleteRequisition(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(PurchaseRequisition, ctx, id, t, {
      label: LABEL,
      allowed: ['draft', 'rejected', 'cancelled'],
    });
    assertBranchAccess(ctx, doc.branchId);
    await doc.update({ number: retiredValue(doc.number, doc.id, 60) }, { transaction: t });
    await doc.destroy({ transaction: t });
  });
}

export async function submitRequisition(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(PurchaseRequisition, ctx, id, t, { label: LABEL, allowed: ['draft'] });
    assertBranchAccess(ctx, doc.branchId);
    const { requisitionApproval } = await purchaseSettings(ctx.auth.companyId, t);
    const now = new Date();
    await doc.update(
      {
        submittedBy: ctx.auth.userId,
        submittedAt: now,
        status: requisitionApproval ? 'pending_approval' : 'approved',
        ...(!requisitionApproval && { approvedBy: ctx.auth.userId, approvedAt: now }),
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
  });
  return getRequisition(ctx, id);
}

export async function approveRequisition(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(PurchaseRequisition, ctx, id, t, {
      label: LABEL,
      allowed: ['pending_approval'],
    });
    assertBranchAccess(ctx, doc.branchId);
    await doc.update(
      { status: 'approved', approvedBy: ctx.auth.userId, approvedAt: new Date(), updatedBy: ctx.auth.userId },
      { transaction: t },
    );
  });
  return getRequisition(ctx, id);
}

export async function rejectRequisition(ctx, id, reason) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(PurchaseRequisition, ctx, id, t, {
      label: LABEL,
      allowed: ['pending_approval'],
    });
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
  return getRequisition(ctx, id);
}

export async function cancelRequisition(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(PurchaseRequisition, ctx, id, t, {
      label: LABEL,
      allowed: ['draft', 'pending_approval', 'rejected', 'approved'],
    });
    assertBranchAccess(ctx, doc.branchId);
    const ordered = await orderedQuantities(doc.id, t);
    if (ordered.size) throw AppError.conflict('Lines of this requisition are already on purchase orders');
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
  return getRequisition(ctx, id);
}

/** Lines still to be ordered (for converting to an RFQ or a PO). */
export async function remainingLines(ctx, id, t) {
  const doc = await PurchaseRequisition.findOne({
    where: { id, companyId: ctx.auth.companyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  if (doc.status !== 'approved')
    throw AppError.conflict('Only approved requisitions with lines left to order can be converted');
  assertBranchAccess(ctx, doc.branchId);
  const items = await PurchaseRequisitionItem.findAll({
    where: { requisitionId: id },
    order: [['sortOrder', 'ASC']],
    transaction: t,
  });
  const ordered = await orderedQuantities(id, t);
  const lines = items
    .map((i) => {
      const left = D(i.baseQuantity).minus(ordered.get(String(i.id)) ?? 0);
      if (left.lte(0)) return null;
      // Keep the requested unit when the remainder is a whole number of it.
      const inUnit = left.dividedBy(i.unitFactor);
      const sameUnit = inUnit.isInteger() || D(i.unitFactor).eq(1);
      return {
        requisitionItemId: String(i.id),
        productId: String(i.productId),
        variantId: i.variantId ? String(i.variantId) : null,
        unitId: sameUnit ? i.unitId : null,
        quantity: sameUnit ? inUnit.toFixed() : left.toFixed(),
        estimatedPrice: i.estimatedPrice,
        notes: i.notes,
      };
    })
    .filter(Boolean);
  if (!lines.length) throw AppError.conflict('Every line of this requisition is already ordered');
  return { doc, lines };
}
