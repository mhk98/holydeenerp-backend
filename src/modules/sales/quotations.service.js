import { sequelize } from '../../config/db.js';
import { SalesInvoice, SalesOrder, SalesQuotation, SalesQuotationItem } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { parseListQuery } from '../../utils/pagination.js';
import { retiredValue } from '../../utils/slug.js';
import { assertBranchAccess, companyToday } from '../inventory/inventory.common.js';
import { nextNumber } from '../sequences/sequences.service.js';
import {
  addDays,
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
  salesLineIncludes,
  salesSettings,
  totalsColumns,
  userRef,
} from './sales.common.js';

/**
 * Quotations: draft → sent → accepted / declined; accepted (or sent) quotations convert into a
 * sales order or straight into an invoice (status "converted"). Prices come from the customer's
 * price list unless typed in.
 */

const LABEL = 'Quotation';

const LIST_OPTIONS = {
  sortable: ['number', 'quotationDate', 'validUntil', 'total', 'createdAt'],
  searchable: ['number', 'customerReference', 'notes'],
  filterable: ['status', 'customerId'],
  defaultSort: '-createdAt',
};

export async function listQuotations(ctx, query) {
  const q = parseListQuery(query, LIST_OPTIONS);
  const { rows, count } = await SalesQuotation.findAndCountAll({
    where: {
      ...q.where,
      companyId: ctx.auth.companyId,
      ...inScope(ctx),
      ...dateRange('quotationDate', query),
    },
    include: [customerRef(), userRef('creator')],
    order: q.order,
    limit: q.limit,
    offset: q.offset,
    distinct: true,
  });
  return { rows: rows.map((r) => r.toJSON()), count, page: q.page, limit: q.limit };
}

export async function getQuotation(ctx, id) {
  const doc = await SalesQuotation.findOne({
    where: { id, companyId: ctx.auth.companyId, ...inScope(ctx) },
    include: [
      customerRef(),
      branchRef(),
      userRef('creator'),
      {
        model: SalesQuotationItem,
        as: 'items',
        include: salesLineIncludes(),
        separate: true,
        order: [['sortOrder', 'ASC']],
      },
    ],
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  const [orders, invoices] = await Promise.all([
    SalesOrder.findAll({ where: { quotationId: doc.id }, attributes: ['id', 'number', 'status'] }),
    SalesInvoice.findAll({ where: { quotationId: doc.id }, attributes: ['id', 'number', 'status'] }),
  ]);
  return {
    ...doc.toJSON(),
    orders: orders.map((o) => o.toJSON()),
    invoices: invoices.map((i) => i.toJSON()),
  };
}

async function writeDraft(ctx, doc, input, t) {
  const customer = await findCustomer(ctx, input.customerId, t);
  const settings = await salesSettings(ctx.auth.companyId, t);
  const date = input.quotationDate ?? doc.quotationDate;
  const { lines, totals } = await prepareLines(
    ctx,
    { customerId: customer.id, date, items: input.items, header: input },
    t,
  );
  await doc.update(
    {
      customerId: customer.id,
      quotationDate: date,
      validUntil: input.validUntil ?? addDays(date, settings.quotationValidityDays),
      customerReference: input.customerReference ?? null,
      notes: input.notes ?? null,
      terms: input.terms ?? (doc.terms || settings.defaultTerms || null),
      ...totalsColumns(totals),
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  await SalesQuotationItem.destroy({ where: { quotationId: doc.id }, transaction: t });
  await SalesQuotationItem.bulkCreate(
    lines.map((l, i) => ({
      quotationId: doc.id,
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

export async function createQuotation(ctx, input) {
  const id = await sequelize.transaction(async (t) => {
    const branchId = currentBranch(ctx);
    assertBranchAccess(ctx, branchId);
    const number = await nextNumber({
      companyId: ctx.auth.companyId,
      docType: 'quotation',
      branchId,
      transaction: t,
    });
    const doc = await SalesQuotation.create(
      {
        companyId: ctx.auth.companyId,
        branchId,
        customerId: input.customerId,
        number,
        quotationDate: input.quotationDate ?? (await companyToday(ctx.auth.companyId)),
        status: 'draft',
        createdBy: ctx.auth.userId,
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
    await writeDraft(ctx, doc, input, t);
    return doc.id;
  });
  return getQuotation(ctx, id);
}

export async function updateQuotation(ctx, id, input) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(SalesQuotation, ctx, id, t, { label: LABEL, allowed: ['draft', 'sent'] });
    assertBranchAccess(ctx, doc.branchId);
    await writeDraft(ctx, doc, input, t);
  });
  return getQuotation(ctx, id);
}

export async function deleteQuotation(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(SalesQuotation, ctx, id, t, {
      label: LABEL,
      allowed: ['draft', 'cancelled', 'declined'],
    });
    assertBranchAccess(ctx, doc.branchId);
    await doc.update({ number: retiredValue(doc.number, doc.id, 60) }, { transaction: t });
    await doc.destroy({ transaction: t });
  });
}

const transition =
  (from, to, extra = {}) =>
  async (ctx, id) => {
    await sequelize.transaction(async (t) => {
      const doc = await lockDoc(SalesQuotation, ctx, id, t, { label: LABEL, allowed: from });
      assertBranchAccess(ctx, doc.branchId);
      await doc.update({ status: to, ...extra, updatedBy: ctx.auth.userId }, { transaction: t });
    });
    return getQuotation(ctx, id);
  };

export const sendQuotation = (ctx, id) => transition(['draft'], 'sent', { sentAt: new Date() })(ctx, id);
export const acceptQuotation = transition(['draft', 'sent'], 'accepted');
export const declineQuotation = transition(['draft', 'sent'], 'declined');
export const cancelQuotation = transition(['draft', 'sent', 'accepted'], 'cancelled');

/** Lines of a quotation as input for the next document; marks the quotation converted. */
export async function takeQuotation(ctx, id, t) {
  const doc = await lockDoc(SalesQuotation, ctx, id, t, {
    label: LABEL,
    allowed: ['draft', 'sent', 'accepted'],
  });
  assertBranchAccess(ctx, doc.branchId);
  const items = await SalesQuotationItem.findAll({
    where: { quotationId: doc.id },
    order: [['sortOrder', 'ASC']],
    transaction: t,
  });
  if (!items.length) throw invalid('items', 'The quotation has no items');
  await doc.update({ status: 'converted', updatedBy: ctx.auth.userId }, { transaction: t });
  return {
    doc,
    header: {
      customerId: String(doc.customerId),
      customerReference: doc.customerReference,
      discountType: doc.discountType,
      discountValue: doc.discountValue,
      notes: doc.notes,
      terms: doc.terms,
    },
    lines: items.map((i) => convertLine(i, i.baseQuantity)),
  };
}
