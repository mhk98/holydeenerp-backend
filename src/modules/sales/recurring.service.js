import { Op } from 'sequelize';
import { logger } from '../../config/logger.js';
import { sequelize } from '../../config/db.js';
import { Branch, RecurringInvoice, SalesInvoice, SalesInvoiceItem, User } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { parseListQuery } from '../../utils/pagination.js';
import { assertBranchAccess } from '../inventory/inventory.common.js';
import { customerRef, inScope, userRef } from './sales.common.js';
import { createInvoiceDraft, postInvoice } from './invoices.service.js';
import { sendInvoiceReminder } from './reminders.service.js';

/**
 * Recurring invoices: a saved invoice payload that creates a new invoice every week / month /
 * quarter / year. Runs daily (01:00 Asia/Dhaka) for schedules whose next date has come; the new
 * invoice is a draft, or posted when autoPost is on (a failure — e.g. the credit limit — leaves the
 * draft and is shown as lastError). autoEmail sends the customer an email with the invoice details.
 */

const LABEL = 'Recurring invoice';

/** Next date after `date` for a frequency (month-end safe: 31 Jan + 1 month = 28/29 Feb). */
export function nextDate(date, frequency, count = 1) {
  const d = new Date(`${date}T00:00:00Z`);
  if (frequency === 'weekly') {
    d.setUTCDate(d.getUTCDate() + 7 * count);
    return d.toISOString().slice(0, 10);
  }
  const months = { monthly: 1, quarterly: 3, yearly: 12 }[frequency] * count;
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

export async function listRecurring(ctx, query) {
  const q = parseListQuery(query, {
    sortable: ['name', 'nextRunDate', 'createdAt'],
    searchable: ['name'],
    filterable: ['customerId', 'isActive', 'frequency'],
    defaultSort: 'nextRunDate',
  });
  const { rows, count } = await RecurringInvoice.findAndCountAll({
    where: { ...q.where, companyId: ctx.auth.companyId, ...inScope(ctx) },
    include: [customerRef(), userRef('creator')],
    order: q.order,
    limit: q.limit,
    offset: q.offset,
  });
  return { rows: rows.map((r) => summary(r)), count, page: q.page, limit: q.limit };
}

function summary(r) {
  const json = r.toJSON();
  return {
    ...json,
    total: json.template?.estimatedTotal ?? null,
    itemsCount: json.template?.items?.length ?? 0,
  };
}

export async function getRecurring(ctx, id) {
  const doc = await RecurringInvoice.findOne({
    where: { id, companyId: ctx.auth.companyId, ...inScope(ctx) },
    include: [customerRef(), userRef('creator')],
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  const invoices = await SalesInvoice.findAll({
    where: { recurringId: doc.id },
    attributes: ['id', 'number', 'invoiceDate', 'status', 'total'],
    order: [['id', 'DESC']],
    limit: 24,
  });
  return { ...summary(doc), invoices: invoices.map((i) => i.toJSON()) };
}

/** Start a schedule from an existing invoice (its customer, lines, prices, discount and terms). */
export async function makeRecurring(ctx, invoiceId, input) {
  const invoice = await SalesInvoice.findOne({
    where: { id: invoiceId, companyId: ctx.auth.companyId, ...inScope(ctx) },
    include: [{ model: SalesInvoiceItem, as: 'items', separate: true, order: [['sortOrder', 'ASC']] }],
  });
  if (!invoice) throw AppError.notFound('Invoice not found');
  assertBranchAccess(ctx, invoice.branchId);
  const template = {
    customerId: String(invoice.customerId),
    warehouseId: invoice.warehouseId ? String(invoice.warehouseId) : null,
    discountType: invoice.discountType,
    discountValue: invoice.discountValue,
    customerReference: invoice.customerReference,
    notes: invoice.notes,
    terms: invoice.terms,
    estimatedTotal: invoice.total,
    items: invoice.items.map((i) => ({
      productId: String(i.productId),
      variantId: i.variantId ? String(i.variantId) : null,
      unitId: i.unitId ? String(i.unitId) : null,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      discountType: i.discountType,
      discountValue: i.discountValue,
      taxGroupId: i.taxGroupId ? String(i.taxGroupId) : null,
      priceIncludesTax: i.priceIncludesTax,
      notes: i.notes,
    })),
  };
  const doc = await RecurringInvoice.create({
    companyId: ctx.auth.companyId,
    branchId: invoice.branchId,
    customerId: invoice.customerId,
    name: input.name ?? `${invoice.number} (${input.frequency})`,
    sourceInvoiceId: invoice.id,
    template,
    frequency: input.frequency,
    intervalCount: input.intervalCount ?? 1,
    nextRunDate: input.startDate ?? nextDate(invoice.invoiceDate, input.frequency, input.intervalCount ?? 1),
    endDate: input.endDate ?? null,
    autoPost: Boolean(input.autoPost),
    autoEmail: Boolean(input.autoEmail),
    isActive: true,
    createdBy: ctx.auth.userId,
    updatedBy: ctx.auth.userId,
  });
  return getRecurring(ctx, doc.id);
}

export async function updateRecurring(ctx, id, input) {
  const doc = await RecurringInvoice.findOne({
    where: { id, companyId: ctx.auth.companyId, ...inScope(ctx) },
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  await doc.update({ ...input, updatedBy: ctx.auth.userId });
  return getRecurring(ctx, id);
}

export async function deleteRecurring(ctx, id) {
  const doc = await RecurringInvoice.findOne({
    where: { id, companyId: ctx.auth.companyId, ...inScope(ctx) },
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  await doc.destroy();
}

/** A request-like context for the schedule's creator (used when running unattended). */
async function scheduleContext(doc) {
  const user = await User.findByPk(doc.createdBy, { attributes: ['id'] });
  const branches = await Branch.findAll({ where: { companyId: doc.companyId }, attributes: ['id'] });
  const branchIds = branches.map((b) => String(b.id));
  return {
    auth: {
      companyId: doc.companyId,
      userId: user?.id ?? null,
      permissions: ['*'],
      isSuperAdmin: true,
      branchIds,
      branches: [],
    },
    branchId: String(doc.branchId),
    branchIds,
  };
}

/** Create the invoice of one run and move the schedule on. Returns the invoice id. */
export async function runSchedule(doc) {
  const ctx = await scheduleContext(doc);
  const runDate = doc.nextRunDate;
  let invoiceId = null;
  let error = null;
  try {
    const created = await sequelize.transaction((t) =>
      createInvoiceDraft(ctx, { ...doc.template, invoiceDate: runDate, items: doc.template.items }, t, {
        recurringId: doc.id,
      }),
    );
    invoiceId = created.id;
    if (doc.autoPost) {
      try {
        await postInvoice(ctx, invoiceId);
        if (doc.autoEmail) {
          const invoice = await SalesInvoice.findByPk(invoiceId);
          await sendInvoiceReminder(invoice, {
            kind: 'manual',
            message: `Dear customer,\n\nPlease find the details of your invoice ${invoice.number} below. Payment is due by ${invoice.dueDate}.`,
          });
        }
      } catch (err) {
        error = `Created as draft: ${err.message}`;
      }
    }
  } catch (err) {
    error = err.message;
  }
  const next = nextDate(runDate, doc.frequency, doc.intervalCount);
  // YYYY-MM-DD strings compare in date order.
  const ended = Boolean(doc.endDate && next > doc.endDate);
  await doc.update({
    lastRunAt: new Date(),
    lastInvoiceId: invoiceId ?? doc.lastInvoiceId,
    runsCount: doc.runsCount + (invoiceId ? 1 : 0),
    lastError: error ? error.slice(0, 500) : null,
    nextRunDate: next,
    isActive: !ended,
  });
  if (error) logger.warn(`Recurring invoice ${doc.id}: ${error}`);
  return invoiceId;
}

/** Run every active schedule that is due on or before `today` (catches up missed days one run at a time). */
export async function runDueSchedules(today) {
  const due = await RecurringInvoice.findAll({ where: { isActive: true, nextRunDate: { [Op.lte]: today } } });
  const created = [];
  for (const doc of due) {
    const id = await runSchedule(doc);
    if (id) created.push(id);
  }
  return created;
}

/** Run a schedule now (from the UI). */
export async function runNow(ctx, id) {
  const doc = await RecurringInvoice.findOne({
    where: { id, companyId: ctx.auth.companyId, ...inScope(ctx) },
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  if (!doc.isActive) throw AppError.conflict('This schedule is paused');
  const invoiceId = await runSchedule(doc);
  return { invoiceId: invoiceId ? String(invoiceId) : null, schedule: await getRecurring(ctx, id) };
}
