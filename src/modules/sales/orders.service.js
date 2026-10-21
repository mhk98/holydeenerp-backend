import { Op } from 'sequelize';
import { sequelize } from '../../config/db.js';
import {
  CreditOverride,
  DeliveryChallan,
  SalesInvoice,
  SalesOrder,
  SalesOrderItem,
  SalesQuotation,
} from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { parseListQuery } from '../../utils/pagination.js';
import { retiredValue } from '../../utils/slug.js';
import { assertBranchAccess, companyToday, writableWarehouse } from '../inventory/inventory.common.js';
import { nextNumber } from '../sequences/sequences.service.js';
import {
  D,
  assertCreditLimit,
  branchRef,
  customerRef,
  dateRange,
  findCustomer,
  fixed,
  inScope,
  invalid,
  lockDoc,
  prepareLines,
  pricedColumns,
  salesLineIncludes,
  salesSettings,
  totalsColumns,
  userRef,
  warehouseRef,
} from './sales.common.js';
import { takeQuotation } from './quotations.service.js';

/**
 * Sales orders.
 *   draft ─confirm (credit check)─▶ confirmed ─challans─▶ partially_delivered ─▶ delivered ─invoices─▶ invoiced
 *   close (short-close) from confirmed / partially_delivered / delivered; cancel while nothing is delivered.
 * Delivered and invoiced quantities are kept per line (base units) by the challan and invoice services.
 */

const LABEL = 'Sales order';

const LIST_OPTIONS = {
  sortable: ['number', 'orderDate', 'deliveryDate', 'total', 'createdAt'],
  searchable: ['number', 'customerReference', 'notes'],
  filterable: ['status', 'customerId', 'warehouseId'],
  defaultSort: '-createdAt',
};

const nonNegative = (d) => (d.lt(0) ? D(0) : d);

export async function listOrders(ctx, query) {
  const q = parseListQuery(query, LIST_OPTIONS);
  const { rows, count } = await SalesOrder.findAndCountAll({
    where: { ...q.where, companyId: ctx.auth.companyId, ...inScope(ctx), ...dateRange('orderDate', query) },
    include: [customerRef(), warehouseRef(), userRef('creator')],
    attributes: {
      include: [
        [
          sequelize.literal(
            '(SELECT COALESCE(SUM(i.base_quantity), 0) FROM sales_order_items i WHERE i.order_id = SalesOrder.id)',
          ),
          'orderedQuantity',
        ],
        [
          sequelize.literal(
            '(SELECT COALESCE(SUM(LEAST(i.delivered_base_quantity, i.base_quantity)), 0) FROM sales_order_items i WHERE i.order_id = SalesOrder.id)',
          ),
          'deliveredQuantity',
        ],
      ],
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
        deliveredPercent: ordered.gt(0)
          ? D(json.deliveredQuantity).dividedBy(ordered).times(100).toFixed(1)
          : '0.0',
      };
    }),
    count,
    page: q.page,
    limit: q.limit,
  };
}

export async function getOrder(ctx, id) {
  const doc = await SalesOrder.findOne({
    where: { id, companyId: ctx.auth.companyId, ...inScope(ctx) },
    include: [
      customerRef(),
      warehouseRef(),
      branchRef(),
      userRef('creator'),
      userRef('confirmer'),
      userRef('closer'),
      userRef('canceller'),
      { model: SalesQuotation, as: 'quotation', attributes: ['id', 'number', 'status'] },
      {
        model: SalesOrderItem,
        as: 'items',
        include: salesLineIncludes(),
        separate: true,
        order: [['sortOrder', 'ASC']],
      },
    ],
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  const [challans, invoices, overrides] = await Promise.all([
    DeliveryChallan.findAll({
      where: { orderId: doc.id },
      attributes: ['id', 'number', 'challanDate', 'status'],
      order: [['id', 'ASC']],
    }),
    SalesInvoice.findAll({
      where: { orderId: doc.id },
      attributes: ['id', 'number', 'invoiceDate', 'status', 'total'],
      order: [['id', 'ASC']],
    }),
    CreditOverride.findAll({
      where: { documentType: 'sales_order', documentId: doc.id },
      include: [userRef('user')],
    }),
  ]);
  const json = doc.toJSON();
  const ordered = json.items.reduce((sum, i) => sum.plus(i.baseQuantity), D(0));
  const delivered = json.items.reduce((sum, i) => sum.plus(i.deliveredBaseQuantity), D(0));
  return {
    ...json,
    deliveredPercent: ordered.gt(0) ? delivered.dividedBy(ordered).times(100).toFixed(1) : '0.0',
    challans: challans.map((c) => c.toJSON()),
    invoices: invoices.map((i) => i.toJSON()),
    creditOverrides: overrides.map((o) => o.toJSON()),
    items: json.items.map((i) => ({
      ...i,
      undeliveredBaseQuantity: fixed(nonNegative(D(i.baseQuantity).minus(i.deliveredBaseQuantity))),
      uninvoicedBaseQuantity: fixed(nonNegative(D(i.baseQuantity).minus(i.invoicedBaseQuantity))),
    })),
  };
}

async function writeDraft(ctx, doc, input, t) {
  const warehouse = await writableWarehouse(ctx, input.warehouseId, 'warehouseId', t);
  const customer = await findCustomer(ctx, input.customerId, t);
  const settings = await salesSettings(ctx.auth.companyId, t);
  const date = input.orderDate ?? doc.orderDate;
  const { lines, totals } = await prepareLines(
    ctx,
    { customerId: customer.id, date, items: input.items, header: input },
    t,
  );
  await doc.update(
    {
      branchId: warehouse.branchId,
      warehouseId: warehouse.id,
      customerId: customer.id,
      orderDate: date,
      deliveryDate: input.deliveryDate ?? null,
      paymentTermsDays:
        input.paymentTermsDays ?? (customer.paymentTermsDays || settings.defaultPaymentTermsDays),
      customerReference: input.customerReference ?? null,
      shippingAddress: input.shippingAddress ?? null,
      notes: input.notes ?? null,
      terms: input.terms ?? (doc.terms || settings.defaultTerms || null),
      ...totalsColumns(totals),
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  await SalesOrderItem.destroy({ where: { orderId: doc.id }, transaction: t });
  await SalesOrderItem.bulkCreate(
    lines.map((l, i) => ({
      orderId: doc.id,
      productId: l.productId,
      variantId: l.variantId,
      unitId: l.unitId,
      unitFactor: l.unitFactor,
      quantity: fixed(l.quantity),
      baseQuantity: l.baseQuantity,
      ...pricedColumns(l),
      notes: l.notes ?? null,
      sortOrder: i,
    })),
    { transaction: t },
  );
}

export async function createOrderDraft(ctx, input, t, { quotationId = null } = {}) {
  const warehouse = await writableWarehouse(ctx, input.warehouseId, 'warehouseId', t);
  const number = await nextNumber({
    companyId: ctx.auth.companyId,
    docType: 'sales_order',
    branchId: warehouse.branchId,
    transaction: t,
  });
  const doc = await SalesOrder.create(
    {
      companyId: ctx.auth.companyId,
      branchId: warehouse.branchId,
      warehouseId: warehouse.id,
      customerId: input.customerId,
      quotationId,
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

export async function createOrder(ctx, input) {
  const doc = await sequelize.transaction((t) => createOrderDraft(ctx, input, t));
  return getOrder(ctx, doc.id);
}

export async function updateOrder(ctx, id, input) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(SalesOrder, ctx, id, t, { label: LABEL, allowed: ['draft'] });
    assertBranchAccess(ctx, doc.branchId);
    await writeDraft(ctx, doc, input, t);
  });
  return getOrder(ctx, id);
}

export async function deleteOrder(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(SalesOrder, ctx, id, t, { label: LABEL, allowed: ['draft', 'cancelled'] });
    assertBranchAccess(ctx, doc.branchId);
    if (await DeliveryChallan.count({ where: { orderId: doc.id }, transaction: t })) {
      throw AppError.conflict('This order has delivery challans; cancel it instead');
    }
    await doc.update({ number: retiredValue(doc.number, doc.id, 60) }, { transaction: t });
    await doc.destroy({ transaction: t });
  });
}

/** Confirm: checks the customer's credit limit (override with a reason needs sales.approve). */
export async function confirmOrder(ctx, id, body = {}) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(SalesOrder, ctx, id, t, { label: LABEL, allowed: ['draft'] });
    assertBranchAccess(ctx, doc.branchId);
    if (!(await SalesOrderItem.count({ where: { orderId: doc.id }, transaction: t })))
      throw invalid('items', 'Add at least one item');
    const customer = await findCustomer(ctx, doc.customerId, t);
    await assertCreditLimit(
      ctx,
      {
        customer,
        amount: D(doc.total),
        documentType: 'sales_order',
        documentId: doc.id,
        override: body.creditOverride,
      },
      t,
    );
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
    const doc = await lockDoc(SalesOrder, ctx, id, t, { label: LABEL, allowed: ['draft', 'confirmed'] });
    assertBranchAccess(ctx, doc.branchId);
    const used =
      (await DeliveryChallan.count({
        where: { orderId: doc.id, status: { [Op.ne]: 'cancelled' } },
        transaction: t,
      })) +
      (await SalesInvoice.count({
        where: { orderId: doc.id, status: { [Op.ne]: 'cancelled' } },
        transaction: t,
      }));
    if (used) throw AppError.conflict('This order has challans or invoices; close it instead');
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

export async function closeOrder(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(SalesOrder, ctx, id, t, {
      label: LABEL,
      allowed: ['confirmed', 'partially_delivered', 'delivered', 'invoiced'],
    });
    assertBranchAccess(ctx, doc.branchId);
    if (await DeliveryChallan.count({ where: { orderId: doc.id, status: 'draft' }, transaction: t })) {
      throw AppError.conflict('Post or cancel the draft challans of this order first');
    }
    await doc.update(
      { status: 'closed', closedBy: ctx.auth.userId, closedAt: new Date(), updatedBy: ctx.auth.userId },
      { transaction: t },
    );
  });
  return getOrder(ctx, id);
}

/** Recompute status from line quantities after a challan or invoice is posted / cancelled. */
export async function refreshOrderStatus(orderId, t) {
  if (!orderId) return;
  const doc = await SalesOrder.findByPk(orderId, { transaction: t, lock: t.LOCK.UPDATE });
  if (!doc || !['confirmed', 'partially_delivered', 'delivered', 'invoiced'].includes(doc.status)) return;
  const items = await SalesOrderItem.findAll({ where: { orderId }, transaction: t });
  const allDelivered = items.every((i) => D(i.deliveredBaseQuantity).gte(i.baseQuantity));
  const anyDelivered = items.some((i) => D(i.deliveredBaseQuantity).gt(0));
  const allInvoiced = items.every((i) => D(i.invoicedBaseQuantity).gte(i.baseQuantity));
  const status =
    allDelivered && allInvoiced
      ? 'invoiced'
      : allDelivered
        ? 'delivered'
        : anyDelivered
          ? 'partially_delivered'
          : 'confirmed';
  if (status !== doc.status) await doc.update({ status }, { transaction: t });
}

/** Lock an order that can still be delivered / invoiced against. */
export async function lockOpenOrder(ctx, orderId, t) {
  const doc = await lockDoc(SalesOrder, ctx, orderId, t, { label: LABEL });
  if (!['confirmed', 'partially_delivered', 'delivered'].includes(doc.status)) {
    throw AppError.conflict(
      `Only confirmed orders can be delivered or invoiced (this one is ${doc.status.replaceAll('_', ' ')})`,
    );
  }
  assertBranchAccess(ctx, doc.branchId);
  return doc;
}

/** Quotation → draft order (warehouse: the one given, else the user's default). */
export async function orderFromQuotation(ctx, quotationId, { warehouseId }) {
  const doc = await sequelize.transaction(async (t) => {
    const { doc: quotation, header, lines } = await takeQuotation(ctx, quotationId, t);
    return createOrderDraft(ctx, { ...header, warehouseId, items: lines }, t, { quotationId: quotation.id });
  });
  return getOrder(ctx, doc.id);
}
