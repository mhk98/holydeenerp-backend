import { Op } from 'sequelize';
import { sequelize } from '../../config/db.js';
import {
  Company,
  GoodsReceipt,
  Party,
  PartyAddress,
  Product,
  PurchaseOrder,
  PurchaseOrderItem,
  PurchaseRequisition,
  PurchaseRfq,
  SupplierBill,
} from '../../models.js';
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
import { sendCompanyMail } from '../settings/mail.service.js';
import { resolveTemplate } from '../settings/print-templates.service.js';
import {
  D,
  approvalHistory,
  approvalPlanFor,
  assertCanApproveLevel,
  branchRef,
  dateRange,
  findSupplier,
  fixed,
  inScope,
  invalid,
  lockDoc,
  priceLines,
  purchaseLineIncludes,
  purchaseSettings,
  recordApproval,
  supplierRef,
  userRef,
  warehouseRef,
} from './purchase.common.js';
import { refreshRequisitionStatus } from './requisitions.service.js';

/**
 * Purchase orders.
 *
 *   draft ─submit─▶ pending_approval ─approve (each level)─▶ approved ─GRN─▶ partially_received ─▶ received ─bills─▶ billed
 *     ▲                 │ reject                                                     └─────── close ───────┴──▶ closed
 *     └─────────────────┘                        draft / pending / approved ─cancel─▶ cancelled
 *
 * Approval levels come from Settings → Purchase (by order total) and are snapshotted when the
 * order is submitted. Received and billed quantities are kept per line (in base units) by the
 * goods-receipt and bill services, which then call refreshOrderStatus().
 */

const LABEL = 'Purchase order';
const DOC_TYPE = 'purchase_order';
const OPEN_FOR_RECEIVING = ['approved', 'partially_received'];

const LIST_OPTIONS = {
  sortable: ['number', 'orderDate', 'expectedDate', 'total', 'createdAt'],
  searchable: ['number', 'supplierReference', 'notes'],
  filterable: ['status', 'supplierId', 'warehouseId'],
  defaultSort: '-createdAt',
};

export async function listOrders(ctx, query) {
  const q = parseListQuery(query, LIST_OPTIONS);
  const { rows, count } = await PurchaseOrder.findAndCountAll({
    where: { ...q.where, companyId: ctx.auth.companyId, ...inScope(ctx), ...dateRange('orderDate', query) },
    include: [supplierRef(), warehouseRef(), userRef('creator')],
    attributes: {
      include: [
        [
          sequelize.literal(
            '(SELECT COALESCE(SUM(i.base_quantity), 0) FROM purchase_order_items i WHERE i.order_id = PurchaseOrder.id)',
          ),
          'orderedQuantity',
        ],
        [
          sequelize.literal(
            '(SELECT COALESCE(SUM(LEAST(i.received_base_quantity, i.base_quantity)), 0) FROM purchase_order_items i WHERE i.order_id = PurchaseOrder.id)',
          ),
          'receivedQuantity',
        ],
      ],
      exclude: ['approvalPlan'],
    },
    order: q.order,
    limit: q.limit,
    offset: q.offset,
    distinct: true,
  });
  return {
    rows: rows.map((r) => {
      const json = r.toJSON();
      const ordered = D(json.orderedQuantity);
      return {
        ...json,
        receivedPercent: ordered.gt(0)
          ? D(json.receivedQuantity).dividedBy(ordered).times(100).toFixed(1)
          : '0.0',
      };
    }),
    count,
    page: q.page,
    limit: q.limit,
  };
}

const nonNegative = (d) => (d.lt(0) ? D(0) : d);

export async function getOrder(ctx, id) {
  const doc = await PurchaseOrder.findOne({
    where: { id, companyId: ctx.auth.companyId, ...inScope(ctx) },
    include: [
      supplierRef(),
      warehouseRef(),
      branchRef(),
      userRef('creator'),
      userRef('submitter'),
      userRef('rejecter'),
      userRef('closer'),
      userRef('canceller'),
      { model: PurchaseRequisition, as: 'requisition', attributes: ['id', 'number'] },
      { model: PurchaseRfq, as: 'rfq', attributes: ['id', 'number'] },
      {
        model: PurchaseOrderItem,
        as: 'items',
        include: purchaseLineIncludes(),
        separate: true,
        order: [['sortOrder', 'ASC']],
      },
    ],
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  const [approvals, receipts, bills] = await Promise.all([
    approvalHistory(DOC_TYPE, doc.id),
    GoodsReceipt.findAll({
      where: { orderId: doc.id },
      attributes: ['id', 'number', 'receiptDate', 'status', 'totalCost'],
      order: [['id', 'ASC']],
    }),
    SupplierBill.findAll({
      where: { orderId: doc.id },
      attributes: ['id', 'number', 'billDate', 'status', 'total', 'paidAmount'],
      order: [['id', 'ASC']],
    }),
  ]);
  const json = doc.toJSON();
  const plan = json.approvalPlan ?? [];
  return {
    ...json,
    approvals,
    receipts: receipts.map((r) => r.toJSON()),
    bills: bills.map((b) => b.toJSON()),
    nextApprovalLevel: json.status === 'pending_approval' ? (plan[json.approvalLevel] ?? null) : null,
    items: json.items.map((i) => ({
      ...i,
      remainingBaseQuantity: fixed(nonNegative(D(i.baseQuantity).minus(i.receivedBaseQuantity))),
      unbilledBaseQuantity: fixed(nonNegative(D(i.receivedBaseQuantity).minus(i.billedBaseQuantity))),
    })),
  };
}

// ── Drafts ─────────────────────────────────────────────────────────────────

/** Validate, price and save the header and lines of a draft order. */
async function writeDraft(ctx, doc, input, t) {
  const warehouse = await writableWarehouse(ctx, input.warehouseId, 'warehouseId', t);
  const supplier = await findSupplier(ctx, input.supplierId, t);
  const settings = await purchaseSettings(ctx.auth.companyId, t);
  const lines = await normalizeLines(ctx, input.items, t);

  if (lines.some((l) => l.requisitionItemId) && !doc.requisitionId) {
    throw invalid('items', 'Lines can only refer to the requisition this order was created from');
  }
  if (doc.requisitionId) {
    const ids = lines.filter((l) => l.requisitionItemId).map((l) => l.requisitionItemId);
    const valid = await sequelize.query(
      'SELECT id FROM purchase_requisition_items WHERE requisition_id = ? AND id IN (?)',
      { replacements: [doc.requisitionId, ids.length ? ids : [0]], type: 'SELECT', transaction: t },
    );
    if (valid.length !== new Set(ids).size) throw invalid('items', 'A line refers to another requisition');
  }

  const { lines: priced, totals } = await priceLines(ctx.auth.companyId, lines, t);
  await doc.update(
    {
      branchId: warehouse.branchId,
      warehouseId: warehouse.id,
      supplierId: supplier.id,
      orderDate: input.orderDate ?? doc.orderDate,
      expectedDate: input.expectedDate ?? null,
      paymentTermsDays:
        input.paymentTermsDays ?? (supplier.paymentTermsDays || settings.defaultPaymentTermsDays),
      supplierReference: input.supplierReference ?? null,
      notes: input.notes ?? null,
      terms: input.terms ?? (doc.terms || settings.defaultTerms || null),
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      taxTotal: totals.taxTotal,
      total: totals.total,
      status: 'draft',
      approvalPlan: [],
      approvalLevel: 0,
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  await PurchaseOrderItem.destroy({ where: { orderId: doc.id }, transaction: t });
  await PurchaseOrderItem.bulkCreate(
    priced.map((l, i) => ({
      orderId: doc.id,
      requisitionItemId: l.requisitionItemId ?? null,
      productId: l.productId,
      variantId: l.variantId,
      unitId: l.unitId,
      unitFactor: l.unitFactor,
      quantity: fixed(l.quantity),
      baseQuantity: l.baseQuantity,
      unitPrice: fixed(l.unitPrice),
      discountPercent: l.discountPercent,
      taxGroupId: l.taxGroupId ?? null,
      taxAmount: l.taxAmount,
      lineSubtotal: l.lineSubtotal,
      lineTotal: l.lineTotal,
      notes: l.notes ?? null,
      sortOrder: i,
    })),
    { transaction: t },
  );
  await refreshRequisitionStatus(doc.requisitionId, t);
}

/** Create a draft order inside a transaction (also used by requisition and RFQ conversions). */
export async function createOrderDraft(ctx, input, t, { requisitionId = null, rfqId = null } = {}) {
  const warehouse = await writableWarehouse(ctx, input.warehouseId, 'warehouseId', t);
  const number = await nextNumber({
    companyId: ctx.auth.companyId,
    docType: 'purchase_order',
    branchId: warehouse.branchId,
    transaction: t,
  });
  const doc = await PurchaseOrder.create(
    {
      companyId: ctx.auth.companyId,
      branchId: warehouse.branchId,
      warehouseId: warehouse.id,
      supplierId: input.supplierId,
      requisitionId,
      rfqId,
      number,
      orderDate: input.orderDate ?? (await companyToday(ctx.auth.companyId)),
      status: 'draft',
      createdBy: ctx.auth.userId,
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  await writeDraft(ctx, doc, input, t);
  return doc;
}

/** Default price and tax for new lines: the product's purchase price × unit factor and its tax group. */
export async function withProductDefaults(ctx, lines, t) {
  const products = await Product.findAll({
    where: { id: [...new Set(lines.map((l) => l.productId))], companyId: ctx.auth.companyId },
    attributes: ['id', 'purchasePrice', 'taxGroupId'],
    transaction: t,
  });
  const byId = new Map(products.map((p) => [String(p.id), p]));
  const normalized = await normalizeLines(ctx, lines, t);
  return lines.map((l, i) => {
    const p = byId.get(String(l.productId));
    return {
      ...l,
      unitPrice:
        l.unitPrice ?? l.estimatedPrice ?? fixed(D(p?.purchasePrice).times(normalized[i].unitFactor)),
      taxGroupId: l.taxGroupId !== undefined ? l.taxGroupId : (p?.taxGroupId ?? null),
    };
  });
}

export async function createOrder(ctx, input) {
  const doc = await sequelize.transaction((t) => createOrderDraft(ctx, input, t));
  return getOrder(ctx, doc.id);
}

export async function updateOrder(ctx, id, input) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(PurchaseOrder, ctx, id, t, { label: LABEL, allowed: ['draft'] });
    assertBranchAccess(ctx, doc.branchId);
    await writeDraft(ctx, doc, input, t);
  });
  return getOrder(ctx, id);
}

export async function deleteOrder(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(PurchaseOrder, ctx, id, t, { label: LABEL, allowed: ['draft', 'cancelled'] });
    assertBranchAccess(ctx, doc.branchId);
    if (await GoodsReceipt.count({ where: { orderId: doc.id }, transaction: t })) {
      throw AppError.conflict('This order has goods receipts; cancel it instead');
    }
    await doc.update({ number: retiredValue(doc.number, doc.id, 60) }, { transaction: t });
    await doc.destroy({ transaction: t });
    await refreshRequisitionStatus(doc.requisitionId, t);
  });
}

// ── Approval ───────────────────────────────────────────────────────────────

export async function submitOrder(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(PurchaseOrder, ctx, id, t, { label: LABEL, allowed: ['draft'] });
    assertBranchAccess(ctx, doc.branchId);
    if (!(await PurchaseOrderItem.count({ where: { orderId: doc.id }, transaction: t })))
      throw invalid('items', 'Add at least one item');
    const plan = await approvalPlanFor(ctx.auth.companyId, doc.total, t);
    const now = new Date();
    await doc.update(
      {
        submittedBy: ctx.auth.userId,
        submittedAt: now,
        rejectedBy: null,
        rejectedAt: null,
        rejectionReason: null,
        approvalPlan: plan,
        approvalLevel: 0,
        status: plan.length ? 'pending_approval' : 'approved',
        ...(!plan.length && { approvedAt: now }),
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
  });
  return getOrder(ctx, id);
}

/** Approve the next level; the last level approves the order. */
export async function approveOrder(ctx, id, note) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(PurchaseOrder, ctx, id, t, { label: LABEL, allowed: ['pending_approval'] });
    assertBranchAccess(ctx, doc.branchId);
    const plan = doc.approvalPlan;
    const level = plan[doc.approvalLevel];
    if (!level) throw AppError.conflict('Nothing left to approve');
    await assertCanApproveLevel(
      ctx,
      { documentType: DOC_TYPE, documentId: doc.id, level, since: doc.submittedAt },
      t,
    );
    await recordApproval(
      ctx,
      {
        documentType: DOC_TYPE,
        documentId: doc.id,
        level: level.level,
        levelName: level.name,
        action: 'approved',
        note,
      },
      t,
    );
    const reached = doc.approvalLevel + 1;
    const done = reached >= plan.length;
    await doc.update(
      {
        approvalLevel: reached,
        ...(done && { status: 'approved', approvedAt: new Date() }),
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
  });
  return getOrder(ctx, id);
}

/** Send the order back to draft with a reason (the approvals so far are kept in the history). */
export async function rejectOrder(ctx, id, reason) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(PurchaseOrder, ctx, id, t, { label: LABEL, allowed: ['pending_approval'] });
    assertBranchAccess(ctx, doc.branchId);
    const level = doc.approvalPlan[doc.approvalLevel];
    await recordApproval(
      ctx,
      {
        documentType: DOC_TYPE,
        documentId: doc.id,
        level: level?.level ?? 0,
        levelName: level?.name,
        action: 'rejected',
        note: reason,
      },
      t,
    );
    await doc.update(
      {
        status: 'draft',
        approvalLevel: 0,
        rejectedBy: ctx.auth.userId,
        rejectedAt: new Date(),
        rejectionReason: reason,
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
  });
  return getOrder(ctx, id);
}

export async function cancelOrder(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(PurchaseOrder, ctx, id, t, {
      label: LABEL,
      allowed: ['draft', 'pending_approval', 'approved'],
    });
    assertBranchAccess(ctx, doc.branchId);
    const open = await GoodsReceipt.count({
      where: { orderId: doc.id, status: { [Op.ne]: 'cancelled' } },
      transaction: t,
    });
    if (open) throw AppError.conflict('Goods have been received against this order; close it instead');
    await doc.update(
      {
        status: 'cancelled',
        cancelledBy: ctx.auth.userId,
        cancelledAt: new Date(),
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
    await refreshRequisitionStatus(doc.requisitionId, t);
  });
  return getOrder(ctx, id);
}

/** Short-close: nothing more will be received or billed. */
export async function closeOrder(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(PurchaseOrder, ctx, id, t, {
      label: LABEL,
      allowed: ['approved', 'partially_received', 'received', 'billed'],
    });
    assertBranchAccess(ctx, doc.branchId);
    const drafts = await GoodsReceipt.count({ where: { orderId: doc.id, status: 'draft' }, transaction: t });
    if (drafts) throw AppError.conflict('Post or cancel the draft goods receipts of this order first');
    await doc.update(
      { status: 'closed', closedBy: ctx.auth.userId, closedAt: new Date(), updatedBy: ctx.auth.userId },
      { transaction: t },
    );
  });
  return getOrder(ctx, id);
}

/**
 * Recompute an order's status from its lines after a receipt or bill is posted/cancelled.
 * Draft, pending, closed and cancelled orders keep their status.
 */
export async function refreshOrderStatus(orderId, t) {
  if (!orderId) return;
  const doc = await PurchaseOrder.findByPk(orderId, { transaction: t, lock: t.LOCK.UPDATE });
  if (!doc || !['approved', 'partially_received', 'received', 'billed'].includes(doc.status)) return;
  const items = await PurchaseOrderItem.findAll({ where: { orderId }, transaction: t });
  const allReceived = items.every((i) => D(i.receivedBaseQuantity).gte(i.baseQuantity));
  const anyReceived = items.some((i) => D(i.receivedBaseQuantity).gt(0));
  const allBilled = items.every((i) => D(i.billedBaseQuantity).gte(i.baseQuantity));
  const status =
    allReceived && allBilled
      ? 'billed'
      : allReceived
        ? 'received'
        : anyReceived
          ? 'partially_received'
          : 'approved';
  if (status !== doc.status) await doc.update({ status }, { transaction: t });
}

/** Lock an order that goods can be received against. */
export async function lockReceivableOrder(ctx, orderId, t) {
  const doc = await lockDoc(PurchaseOrder, ctx, orderId, t, { label: LABEL });
  if (!OPEN_FOR_RECEIVING.includes(doc.status)) {
    throw AppError.conflict(
      `Goods can only be received against approved orders (this one is ${doc.status.replaceAll('_', ' ')})`,
    );
  }
  return doc;
}

// ── Print & email ──────────────────────────────────────────────────────────

/** Everything the web app needs to print or render a PDF of the order. */
export async function orderPrintData(ctx, id) {
  const order = await getOrder(ctx, id);
  const [company, template, address] = await Promise.all([
    Company.findByPk(ctx.auth.companyId),
    resolveTemplate(ctx.auth.companyId, 'purchase_order', 'a4'),
    PartyAddress.findOne({
      where: { partyId: order.supplierId },
      order: [
        ['isDefault', 'DESC'],
        ['id', 'ASC'],
      ],
    }),
  ]);
  const c = company.toJSON();
  return {
    order,
    supplierAddress: address
      ? [address.addressLine, address.city, address.district, address.postalCode].filter(Boolean).join(', ')
      : null,
    company: {
      name: c.name,
      address: c.address ?? null,
      phone: c.phone ?? null,
      email: c.email ?? null,
      binNo: c.binNo ?? null,
      vatRegNo: c.vatRegNo ?? null,
      logoUrl: c.logoUrl ?? null,
    },
    template: {
      ...template,
      options: { ...template.options, title: template.id ? template.options.title : 'Purchase Order' },
    },
  };
}

export async function emailOrder(ctx, id, input) {
  const order = await PurchaseOrder.findOne({
    where: { id, companyId: ctx.auth.companyId, ...inScope(ctx) },
  });
  if (!order) throw AppError.notFound(`${LABEL} not found`);
  if (['draft', 'pending_approval', 'cancelled'].includes(order.status)) {
    throw AppError.conflict('Only approved orders can be sent to the supplier');
  }
  const content = Buffer.from(input.pdfBase64, 'base64');
  if (content.subarray(0, 4).toString() !== '%PDF') throw invalid('pdfBase64', 'The attachment is not a PDF');
  const escape = (s) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  try {
    await sendCompanyMail(ctx.auth.companyId, {
      to: input.to,
      cc: input.cc.length ? input.cc : undefined,
      subject: input.subject,
      text: input.message,
      html: `<div style="font-family:sans-serif;white-space:pre-wrap">${escape(input.message)}</div>`,
      attachments: [{ filename: input.filename, content, contentType: 'application/pdf' }],
    });
  } catch (err) {
    throw AppError.unprocessable(`The email could not be sent: ${err.message}`);
  }
  await order.update({ emailedAt: new Date() });
  return getOrder(ctx, id);
}

/** Suppliers' default email for the "Send" dialog. */
export async function supplierContact(ctx, supplierId) {
  const s = await Party.findOne({
    where: { id: supplierId, companyId: ctx.auth.companyId },
    attributes: ['email', 'name', 'contactPerson'],
  });
  return s?.toJSON() ?? null;
}
