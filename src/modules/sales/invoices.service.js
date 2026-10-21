import QRCode from 'qrcode';
import { Op } from 'sequelize';
import { sequelize } from '../../config/db.js';
import {
  Company,
  CreditOverride,
  DeliveryChallan,
  DeliveryChallanItem,
  PartyAddress,
  PaymentReminder,
  ReceivableAllocation,
  SalesInvoice,
  SalesInvoiceItem,
  SalesOrder,
  SalesOrderItem,
  SalesQuotation,
  SalesReturn,
  User,
  Warehouse,
} from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { amountInWords } from '../../utils/amount-words.js';
import { parseListQuery } from '../../utils/pagination.js';
import { retiredValue } from '../../utils/slug.js';
import {
  assertBranchAccess,
  companyToday,
  normalizeLines,
  writableWarehouse,
} from '../inventory/inventory.common.js';
import { isLotTracked, postMovements } from '../inventory/stock.engine.js';
import { by, postSource, unpostSource } from '../accounting/posting.service.js';
import { nextNumber } from '../sequences/sequences.service.js';
import { sendCompanyMail } from '../settings/mail.service.js';
import { resolveTemplate } from '../settings/print-templates.service.js';
import {
  D,
  addDays,
  assertCreditLimit,
  branchRef,
  convertLine,
  currentBranch,
  customerRef,
  dateRange,
  findCustomer,
  fixed,
  inScope,
  invalid,
  lockDoc,
  prepareLines,
  pricedColumns,
  resolvePrices,
  salesLineIncludes,
  salesSettings,
  totalsColumns,
  userRef,
  warehouseRef,
} from './sales.common.js';
import { lockOpenOrder, refreshOrderStatus } from './orders.service.js';
import { takeQuotation } from './quotations.service.js';
import { sendInvoiceReminder } from './reminders.service.js';

/**
 * Sales invoices.
 *   draft ─post (credit check)─▶ unpaid ─receipts / credit notes─▶ partially_paid ─▶ paid
 * A line either bills goods already delivered by a challan (challanItemId — no stock movement) or
 * delivers directly: posting takes it out of the invoice's warehouse (movement "sale").
 * Cancel: drafts, or unpaid invoices with nothing applied that moved no stock (else issue a credit note).
 */

const LABEL = 'Invoice';

const LIST_OPTIONS = {
  sortable: ['number', 'invoiceDate', 'dueDate', 'total', 'createdAt'],
  searchable: ['number', 'customerReference', 'notes'],
  filterable: ['status', 'customerId', 'orderId'],
  defaultSort: '-createdAt',
};

const balanceOf = (inv) => fixed(D(inv.total).minus(inv.paidAmount));

export async function listInvoices(ctx, query) {
  const q = parseListQuery(query, LIST_OPTIONS);
  const where = {
    ...q.where,
    companyId: ctx.auth.companyId,
    ...inScope(ctx),
    ...dateRange('invoiceDate', query),
  };
  if (query.overdue === 'true') {
    where.dueDate = { [Op.lt]: await companyToday(ctx.auth.companyId) };
    where.status = { [Op.in]: ['unpaid', 'partially_paid'] };
  }
  const { rows, count } = await SalesInvoice.findAndCountAll({
    where,
    include: [
      customerRef(),
      userRef('creator'),
      { model: SalesOrder, as: 'order', attributes: ['id', 'number'] },
    ],
    order: q.order,
    limit: q.limit,
    offset: q.offset,
    distinct: true,
  });
  return {
    rows: rows.map((r) => ({ ...r.toJSON(), balance: balanceOf(r) })),
    count,
    page: q.page,
    limit: q.limit,
  };
}

export async function getInvoice(ctx, id) {
  const doc = await SalesInvoice.findOne({
    where: { id, companyId: ctx.auth.companyId, ...inScope(ctx) },
    include: [
      customerRef(),
      warehouseRef(),
      branchRef(),
      userRef('creator'),
      userRef('poster'),
      { model: SalesOrder, as: 'order', attributes: ['id', 'number', 'status'] },
      { model: DeliveryChallan, as: 'challan', attributes: ['id', 'number', 'status'] },
      { model: SalesQuotation, as: 'quotation', attributes: ['id', 'number', 'status'] },
      {
        model: SalesInvoiceItem,
        as: 'items',
        include: salesLineIncludes({ batch: true }),
        separate: true,
        order: [['sortOrder', 'ASC']],
      },
    ],
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  const [allocations, overrides, reminders, returns] = await Promise.all([
    sequelize.query(
      `SELECT a.id, a.source_type AS sourceType, a.source_id AS sourceId, a.amount, a.created_at AS createdAt,
              COALESCE(r.number, s.number) AS sourceNumber, COALESCE(r.receipt_date, s.return_date) AS sourceDate
         FROM receivable_allocations a
         LEFT JOIN customer_receipts r ON a.source_type = 'receipt' AND r.id = a.source_id
         LEFT JOIN sales_returns s ON a.source_type = 'credit_note' AND s.id = a.source_id
        WHERE a.invoice_id = ? ORDER BY a.id`,
      { replacements: [doc.id], type: 'SELECT' },
    ),
    CreditOverride.findAll({
      where: { documentType: 'sales_invoice', documentId: doc.id },
      include: [{ model: User, as: 'user', attributes: ['id', 'name'] }],
    }),
    PaymentReminder.findAll({ where: { invoiceId: doc.id }, order: [['id', 'DESC']], limit: 20 }),
    SalesReturn.findAll({
      where: { invoiceId: doc.id },
      attributes: ['id', 'number', 'type', 'status', 'total'],
    }),
  ]);
  return {
    ...doc.toJSON(),
    balance: balanceOf(doc),
    allocations,
    creditOverrides: overrides.map((o) => o.toJSON()),
    reminders: reminders.map((r) => r.toJSON()),
    returns: returns.map((r) => r.toJSON()),
  };
}

async function writeDraft(ctx, doc, input, t) {
  const customer = await findCustomer(ctx, input.customerId, t);
  const settings = await salesSettings(ctx.auth.companyId, t);
  let warehouse = null;
  if (input.warehouseId) warehouse = await writableWarehouse(ctx, input.warehouseId, 'warehouseId', t);
  let order = null;
  if (input.orderId) {
    order = await SalesOrder.findOne({
      where: { id: input.orderId, companyId: ctx.auth.companyId },
      transaction: t,
    });
    if (!order || String(order.customerId) !== String(customer.id))
      throw invalid('orderId', 'Sales order not found for this customer');
  }
  const date = input.invoiceDate ?? doc.invoiceDate;
  const { lines, totals } = await prepareLines(
    ctx,
    { customerId: customer.id, date, items: input.items, header: input },
    t,
  );

  for (const l of lines) {
    if (l.orderItemId) {
      const oi = await SalesOrderItem.findOne({
        where: { id: l.orderItemId, ...(order && { orderId: order.id }) },
        transaction: t,
      });
      if (!oi || !order) throw invalid(`${l.field}.orderItemId`, 'This line is not on the sales order');
    }
    if (l.challanItemId) {
      const ci = await DeliveryChallanItem.findOne({
        where: { id: l.challanItemId },
        include: [
          {
            model: DeliveryChallan,
            as: 'challan',
            attributes: [],
            where: { companyId: ctx.auth.companyId, customerId: customer.id, status: 'posted' },
            required: true,
          },
        ],
        transaction: t,
      });
      if (!ci || String(ci.productId) !== String(l.productId))
        throw invalid(`${l.field}.challanItemId`, 'This line is not on a posted challan of this customer');
    }
  }
  const terms = order?.paymentTermsDays ?? (customer.paymentTermsDays || settings.defaultPaymentTermsDays);
  await doc.update(
    {
      customerId: customer.id,
      warehouseId: warehouse?.id ?? order?.warehouseId ?? null,
      ...(warehouse && { branchId: warehouse.branchId }),
      orderId: order?.id ?? null,
      challanId: input.challanId ?? null,
      invoiceDate: date,
      dueDate: input.dueDate ?? addDays(date, terms),
      customerReference: input.customerReference ?? order?.customerReference ?? null,
      notes: input.notes ?? null,
      terms: input.terms ?? (doc.terms || settings.defaultTerms || null),
      ...totalsColumns(totals),
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  await SalesInvoiceItem.destroy({ where: { invoiceId: doc.id }, transaction: t });
  await SalesInvoiceItem.bulkCreate(
    lines.map((l, i) => ({
      invoiceId: doc.id,
      orderItemId: l.orderItemId ?? null,
      challanItemId: l.challanItemId ?? null,
      productId: l.productId,
      variantId: l.variantId,
      unitId: l.unitId,
      unitFactor: l.unitFactor,
      quantity: fixed(l.quantity),
      baseQuantity: l.baseQuantity,
      ...pricedColumns(l),
      batchId: l.challanItemId ? null : l.batchId,
      serialNumbers: l.challanItemId ? [] : l.serialNumbers,
      notes: l.notes ?? null,
      sortOrder: i,
    })),
    { transaction: t },
  );
}

/** Create a draft invoice inside a transaction (also used by conversions and recurring invoices). */
export async function createInvoiceDraft(ctx, input, t, links = {}) {
  let branchId = currentBranch(ctx);
  if (input.warehouseId)
    branchId = (await writableWarehouse(ctx, input.warehouseId, 'warehouseId', t)).branchId;
  assertBranchAccess(ctx, branchId);
  const number = await nextNumber({
    companyId: ctx.auth.companyId,
    docType: links.docType ?? 'sales_invoice',
    branchId,
    transaction: t,
  });
  const doc = await SalesInvoice.create(
    {
      companyId: ctx.auth.companyId,
      branchId,
      customerId: input.customerId,
      quotationId: links.quotationId ?? null,
      recurringId: links.recurringId ?? null,
      number,
      invoiceDate: input.invoiceDate ?? (await companyToday(ctx.auth.companyId)),
      dueDate: input.invoiceDate ?? (await companyToday(ctx.auth.companyId)),
      status: 'draft',
      createdBy: ctx.auth.userId,
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  await writeDraft(ctx, doc, input, t);
  return doc;
}

export async function createInvoice(ctx, input) {
  const doc = await sequelize.transaction((t) => createInvoiceDraft(ctx, input, t));
  return getInvoice(ctx, doc.id);
}

export async function updateInvoice(ctx, id, input) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(SalesInvoice, ctx, id, t, { label: LABEL, allowed: ['draft'] });
    assertBranchAccess(ctx, doc.branchId);
    await writeDraft(ctx, doc, input, t);
  });
  return getInvoice(ctx, id);
}

export async function deleteInvoice(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(SalesInvoice, ctx, id, t, { label: LABEL, allowed: ['draft', 'cancelled'] });
    assertBranchAccess(ctx, doc.branchId);
    await doc.update({ number: retiredValue(doc.number, doc.id, 60) }, { transaction: t });
    await doc.destroy({ transaction: t });
  });
}

/** Add (sign 1) or remove (−1) the invoice's quantities on challan and order lines. */
async function applyInvoicedQuantities(items, sign, t) {
  for (const [i, item] of items.entries()) {
    const qty = D(item.baseQuantity).times(sign);
    if (item.challanItemId) {
      const ci = await DeliveryChallanItem.findByPk(item.challanItemId, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      const after = D(ci.invoicedBaseQuantity).plus(qty);
      if (sign > 0 && after.gt(D(ci.baseQuantity).minus(ci.returnedBaseQuantity))) {
        throw invalid(
          `items.${i}.quantity`,
          `Only ${D(ci.baseQuantity).minus(ci.invoicedBaseQuantity).toFixed()} of this challan line is still to invoice`,
        );
      }
      await ci.update({ invoicedBaseQuantity: fixed(after) }, { transaction: t });
    }
    if (item.orderItemId) {
      const oi = await SalesOrderItem.findByPk(item.orderItemId, { transaction: t, lock: t.LOCK.UPDATE });
      const invoiced = D(oi.invoicedBaseQuantity).plus(qty);
      if (sign > 0 && invoiced.gt(oi.baseQuantity)) {
        throw invalid(
          `items.${i}.quantity`,
          `More than ordered: ${D(oi.baseQuantity).toFixed()} ordered, ${D(oi.invoicedBaseQuantity).toFixed()} already invoiced`,
        );
      }
      const patch = { invoicedBaseQuantity: fixed(invoiced) };
      // Delivered by this invoice (no challan): it counts as delivered too.
      if (!item.challanItemId) {
        const delivered = D(oi.deliveredBaseQuantity).plus(qty);
        if (sign > 0 && delivered.gt(oi.baseQuantity)) {
          throw invalid(
            `items.${i}.quantity`,
            'This order line is already delivered — invoice its challan instead',
          );
        }
        patch.deliveredBaseQuantity = fixed(delivered);
      }
      await oi.update(patch, { transaction: t });
    }
  }
}

/**
 * Post a locked draft inside a transaction: credit check, quantities, stock out for lines delivered by
 * the invoice. `opts.creditAmount` is what the customer will owe (POS: total minus what is paid now);
 * `opts.allowNegative` lets a synced offline sale take stock below zero.
 */
export async function postInvoiceDoc(ctx, doc, body, t, opts = {}) {
  assertBranchAccess(ctx, doc.branchId);
  const items = await SalesInvoiceItem.findAll({
    where: { invoiceId: doc.id },
    order: [['sortOrder', 'ASC']],
    transaction: t,
  });
  if (!items.length) throw invalid('items', 'Add at least one item');
  if (doc.orderId) await lockOpenOrder(ctx, doc.orderId, t);
  const customer = await findCustomer(ctx, doc.customerId, t);
  await assertCreditLimit(
    ctx,
    {
      customer,
      amount: opts.creditAmount != null ? D(opts.creditAmount) : D(doc.total),
      documentType: 'sales_invoice',
      documentId: doc.id,
      override: body.creditOverride,
    },
    t,
  );
  await applyInvoicedQuantities(items, 1, t);

  const direct = items.filter((i) => !i.challanItemId);
  let cost = D(0);
  let negative = false;
  if (direct.length) {
    if (!doc.warehouseId) throw invalid('warehouseId', 'Choose the warehouse the goods are delivered from');
    await writableWarehouse(ctx, doc.warehouseId, 'warehouseId', t);
    const lines = await normalizeLines(
      ctx,
      direct.map((i) => i.toJSON()),
      t,
    );
    lines.forEach((line, k) => {
      const idx = items.indexOf(direct[k]);
      if (isLotTracked(line.product) && !line.batchId)
        throw invalid(`items.${idx}.batchId`, `Choose the batch of ${line.product.name}`);
      if (line.product.trackSerial && line.serialNumbers.length !== Number(line.baseQuantity)) {
        throw invalid(
          `items.${idx}.serialNumbers`,
          `Enter ${Number(line.baseQuantity)} serial number(s) for ${line.product.name}`,
        );
      }
    });
    const movements = await postMovements({
      companyId: ctx.auth.companyId,
      userId: ctx.auth.userId,
      date: doc.invoiceDate,
      reference: { type: 'sales_invoice', id: doc.id, no: doc.number },
      entries: direct.map((item) => ({
        warehouseId: doc.warehouseId,
        productId: item.productId,
        variantId: item.variantId,
        batchId: item.batchId,
        quantity: D(item.baseQuantity).neg().toFixed(),
        type: 'sale',
        referenceItemId: item.id,
        serialNumbers: item.serialNumbers,
        serialStatus: 'issued',
        field: `items.${items.indexOf(item)}`,
      })),
      transaction: t,
      allowNegative: opts.allowNegative,
    });
    negative = movements.some((m) => D(m.balanceQuantity).lt(0));
    for (const [k, m] of movements.entries()) {
      await direct[k].update({ unitCost: m.unitCost }, { transaction: t });
      cost = cost.plus(D(m.totalCost).abs());
    }
  }
  // Lines billed from challans carry the challan's stock cost.
  for (const item of items.filter((i) => i.challanItemId)) {
    const ci = await DeliveryChallanItem.findByPk(item.challanItemId, { transaction: t });
    await item.update({ unitCost: ci.unitCost }, { transaction: t });
    cost = cost.plus(D(ci.unitCost).times(item.baseQuantity));
  }

  await doc.update(
    {
      status: 'unpaid',
      costTotal: fixed(cost),
      postedBy: ctx.auth.userId,
      postedAt: new Date(),
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  await postSource('sales_invoice', doc.id, by(ctx, t));
  await refreshOrderStatus(doc.orderId, t);
  return { negative };
}

/** Post: credit check, quantities, stock out for lines delivered by the invoice. */
export async function postInvoice(ctx, id, body = {}) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(SalesInvoice, ctx, id, t, { label: LABEL, allowed: ['draft'] });
    await postInvoiceDoc(ctx, doc, body, t);
  });
  return getInvoice(ctx, id);
}

export async function cancelInvoice(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(SalesInvoice, ctx, id, t, { label: LABEL, allowed: ['draft', 'unpaid'] });
    assertBranchAccess(ctx, doc.branchId);
    if (doc.status === 'unpaid') {
      if (await ReceivableAllocation.count({ where: { invoiceId: doc.id }, transaction: t })) {
        throw AppError.conflict('Receipts or credit notes are applied to this invoice');
      }
      const items = await SalesInvoiceItem.findAll({ where: { invoiceId: doc.id }, transaction: t });
      if (items.some((i) => !i.challanItemId)) {
        throw AppError.conflict(
          'This invoice delivered goods from stock; issue a sales return / credit note instead',
        );
      }
      await applyInvoicedQuantities(items, -1, t);
      await unpostSource('sales_invoice', doc.id, by(ctx, t));
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
    await refreshOrderStatus(doc.orderId, t);
  });
  return getInvoice(ctx, id);
}

/** Recompute paid amount and status from allocations (call inside a transaction). */
export async function refreshInvoicePayment(invoiceId, t) {
  const inv = await SalesInvoice.findByPk(invoiceId, { transaction: t, lock: t.LOCK.UPDATE });
  if (!inv || ['draft', 'cancelled'].includes(inv.status)) return inv;
  const paid = D(await ReceivableAllocation.sum('amount', { where: { invoiceId }, transaction: t }));
  const status = paid.gte(inv.total) ? 'paid' : paid.gt(0) ? 'partially_paid' : 'unpaid';
  await inv.update({ paidAmount: fixed(paid), status }, { transaction: t });
  return inv;
}

// ── Conversions ────────────────────────────────────────────────────────────

/**
 * Draft invoice for an order: uninvoiced lines of its posted challans (no stock movement) plus
 * whatever is still undelivered (delivered directly by the invoice).
 */
export async function invoiceFromOrder(ctx, orderId) {
  const doc = await sequelize.transaction(async (t) => {
    const order = await lockOpenOrder(ctx, orderId, t);
    const items = await SalesOrderItem.findAll({
      where: { orderId: order.id },
      order: [['sortOrder', 'ASC']],
      transaction: t,
    });
    const challanItems = await DeliveryChallanItem.findAll({
      where: { orderItemId: items.map((i) => i.id) },
      include: [
        {
          model: DeliveryChallan,
          as: 'challan',
          attributes: [],
          where: { status: 'posted' },
          required: true,
        },
      ],
      transaction: t,
    });
    const lines = [];
    for (const item of items) {
      for (const ci of challanItems.filter((c) => String(c.orderItemId) === String(item.id))) {
        const left = D(ci.baseQuantity).minus(ci.invoicedBaseQuantity).minus(ci.returnedBaseQuantity);
        if (left.gt(0))
          lines.push(convertLine(item, left, { orderItemId: String(item.id), challanItemId: String(ci.id) }));
      }
      const undelivered = D(item.baseQuantity).minus(item.deliveredBaseQuantity);
      if (undelivered.gt(0)) lines.push(convertLine(item, undelivered, { orderItemId: String(item.id) }));
    }
    if (!lines.length) throw AppError.conflict('Everything on this order has been invoiced');
    return createInvoiceDraft(
      ctx,
      {
        customerId: order.customerId,
        warehouseId: order.warehouseId,
        orderId: order.id,
        discountType: order.discountType,
        discountValue: order.discountType === 'percent' ? order.discountValue : '0',
        customerReference: order.customerReference,
        terms: order.terms,
        items: lines,
      },
      t,
    );
  });
  return getInvoice(ctx, doc.id);
}

/** Draft invoice for the uninvoiced lines of a posted challan. */
export async function invoiceFromChallan(ctx, challanId) {
  const doc = await sequelize.transaction(async (t) => {
    const challan = await lockDoc(DeliveryChallan, ctx, challanId, t, {
      label: 'Delivery challan',
      allowed: ['posted'],
    });
    assertBranchAccess(ctx, challan.branchId);
    const items = await DeliveryChallanItem.findAll({
      where: { challanId: challan.id },
      order: [['sortOrder', 'ASC']],
      transaction: t,
    });
    const orderItems = await SalesOrderItem.findAll({
      where: { id: items.map((i) => i.orderItemId).filter(Boolean) },
      transaction: t,
    });
    const orderItemOf = new Map(orderItems.map((o) => [String(o.id), o]));
    const date = await companyToday(ctx.auth.companyId);
    const loose = items.filter((i) => !i.orderItemId);
    const prices = loose.length
      ? await resolvePrices(
          ctx,
          { customerId: challan.customerId, date, items: loose.map((i) => i.toJSON()) },
          t,
        )
      : [];
    const lines = items
      .map((ci) => {
        const left = D(ci.baseQuantity).minus(ci.invoicedBaseQuantity).minus(ci.returnedBaseQuantity);
        if (left.lte(0)) return null;
        const oi = ci.orderItemId ? orderItemOf.get(String(ci.orderItemId)) : null;
        if (oi) return convertLine(oi, left, { orderItemId: String(oi.id), challanItemId: String(ci.id) });
        const p = prices[loose.indexOf(ci)];
        return convertLine(
          {
            ...ci.toJSON(),
            unitPrice: p.unitPrice,
            discountType: 'percent',
            discountValue: '0',
            taxGroupId: p.taxGroupId,
            priceIncludesTax: p.priceIncludesTax,
          },
          left,
          {
            challanItemId: String(ci.id),
          },
        );
      })
      .filter(Boolean);
    if (!lines.length) throw AppError.conflict('Every line of this challan is already invoiced');
    return createInvoiceDraft(
      ctx,
      {
        customerId: challan.customerId,
        warehouseId: challan.warehouseId,
        orderId: challan.orderId,
        challanId: challan.id,
        items: lines,
      },
      t,
    );
  });
  return getInvoice(ctx, doc.id);
}

/** Quotation straight to a draft invoice (direct delivery from `warehouseId`). */
export async function invoiceFromQuotation(ctx, quotationId, { warehouseId }) {
  const doc = await sequelize.transaction(async (t) => {
    const { doc: quotation, header, lines } = await takeQuotation(ctx, quotationId, t);
    return createInvoiceDraft(ctx, { ...header, warehouseId, items: lines }, t, {
      quotationId: quotation.id,
    });
  });
  return getInvoice(ctx, doc.id);
}

// ── Print, email, reminders ────────────────────────────────────────────────

/** Everything needed to render the invoice: branding, words, QR code. */
export async function invoicePrintData(ctx, id) {
  const invoice = await getInvoice(ctx, id);
  const [company, template, address, warehouse] = await Promise.all([
    Company.findByPk(ctx.auth.companyId),
    resolveTemplate(ctx.auth.companyId, 'invoice', 'a4'),
    PartyAddress.findOne({
      where: { partyId: invoice.customerId },
      order: [
        ['isDefault', 'DESC'],
        ['id', 'ASC'],
      ],
    }),
    invoice.warehouseId ? Warehouse.findByPk(invoice.warehouseId, { attributes: ['name'] }) : null,
  ]);
  const c = company.toJSON();
  // Compact, human-readable payload any QR scanner shows as text (verifies the invoice at a glance).
  const qrText = [
    `INV:${invoice.number}`,
    `DATE:${invoice.invoiceDate}`,
    `TOTAL:${D(invoice.total).toFixed(2)}`,
    c.binNo && `BIN:${c.binNo}`,
    `SELLER:${c.name}`,
    `BUYER:${invoice.customer.name}`,
  ]
    .filter(Boolean)
    .join('|');
  return {
    invoice,
    company: {
      name: c.name,
      address: c.address ?? null,
      phone: c.phone ?? null,
      email: c.email ?? null,
      website: c.website ?? null,
      binNo: c.binNo ?? null,
      vatRegNo: c.vatRegNo ?? null,
      logoUrl: c.logoUrl ?? null,
    },
    customerAddress: address
      ? [address.addressLine, address.city, address.district, address.postalCode].filter(Boolean).join(', ')
      : null,
    warehouseName: warehouse?.name ?? null,
    template,
    amountInWords: { en: amountInWords(invoice.total, 'en'), bn: amountInWords(invoice.total, 'bn') },
    qrCode: await QRCode.toDataURL(qrText, { margin: 1, width: 240, errorCorrectionLevel: 'M' }),
    qrText,
  };
}

export async function emailInvoice(ctx, id, input) {
  const inv = await SalesInvoice.findOne({ where: { id, companyId: ctx.auth.companyId, ...inScope(ctx) } });
  if (!inv) throw AppError.notFound(`${LABEL} not found`);
  if (['draft', 'cancelled'].includes(inv.status))
    throw AppError.conflict('Only posted invoices can be emailed');
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
  await inv.update({ emailedAt: new Date() });
  return getInvoice(ctx, id);
}

/** Send a payment reminder now (to the customer's email unless `to` is given). */
export async function remindInvoice(ctx, id, input = {}) {
  const inv = await SalesInvoice.findOne({ where: { id, companyId: ctx.auth.companyId, ...inScope(ctx) } });
  if (!inv) throw AppError.notFound(`${LABEL} not found`);
  if (!['unpaid', 'partially_paid'].includes(inv.status))
    throw AppError.conflict('Only open invoices get reminders');
  const result = await sendInvoiceReminder(inv, {
    kind: 'manual',
    to: input.to,
    message: input.message,
    userId: ctx.auth.userId,
  });
  if (result.status === 'failed')
    throw AppError.unprocessable(`The reminder could not be sent: ${result.error}`);
  return getInvoice(ctx, id);
}
