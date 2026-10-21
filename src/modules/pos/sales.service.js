import { Op } from 'sequelize';
import { sequelize } from '../../config/db.js';
import {
  Company,
  CustomerReceipt,
  PaymentMethod,
  PosSession,
  ReceivableAllocation,
  SalesInvoice,
  SalesInvoiceItem,
  SalesReturn,
  User,
} from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { amountInWords } from '../../utils/amount-words.js';
import { companyToday } from '../inventory/inventory.common.js';
import { by, postSource } from '../accounting/posting.service.js';
import { createInvoiceDraft, postInvoiceDoc } from '../sales/invoices.service.js';
import { allocateToInvoices, createReceiptDoc } from '../sales/receipts.service.js';
import { createReturnDraft, invoiceReturnLines, postReturnDoc } from '../sales/returns.service.js';
import { customerRef, resolvePrices, salesLineIncludes } from '../sales/sales.common.js';
import { D, can, findRegister, fixed, invalid, posSettings } from './pos.common.js';
import { assignBatches } from './catalog.service.js';
import { lockOpenSession, sessionReport } from './sessions.service.js';

/**
 * A POS sale is one transaction: a posted sales invoice (channel "pos", numbered from the POS
 * series) that takes the stock out, one money receipt per payment method (cash net of change), and
 * optionally credit from a return applied to it (exchange). `clientUuid` makes it idempotent, so a
 * sale queued offline is created once however often it is synced.
 */

const sumOf = (rows, key = 'amount') => rows.reduce((s, r) => s.plus(r[key] ?? 0), D(0));

/** Prices and discounts within what a cashier may do (skipped for synced offline sales). */
async function checkCashierLimits(ctx, input, customerId, date, t) {
  if (can(ctx, 'pos.update')) return;
  const settings = await posSettings(ctx.auth.companyId, t);
  const cap = D(settings.maxDiscountPercent);
  const over = (type, value, base) =>
    type === 'percent' ? D(value).gt(cap) : base.gt(0) && D(value).gt(base.times(cap).dividedBy(100));
  const standard = settings.allowPriceEdit
    ? null
    : await resolvePrices(
        ctx,
        {
          customerId,
          date,
          items: input.items.map((i) => ({
            productId: i.productId,
            variantId: i.variantId,
            unitId: i.unitId,
            quantity: i.quantity,
          })),
        },
        t,
      );
  let gross = D(0);
  input.items.forEach((item, i) => {
    const lineGross = D(item.quantity).times(item.unitPrice ?? 0);
    gross = gross.plus(lineGross);
    if (standard && item.unitPrice != null && !D(item.unitPrice).eq(standard[i].unitPrice))
      throw invalid(`items.${i}.unitPrice`, 'Changing the price needs the pos.update permission');
    if (item.discountValue && over(item.discountType ?? 'percent', item.discountValue, lineGross))
      throw invalid(
        `items.${i}.discountValue`,
        `Discounts above ${cap.toFixed()}% need the pos.update permission`,
      );
  });
  if (input.discountValue && over(input.discountType ?? 'percent', input.discountValue, gross))
    throw invalid('discountValue', `Discounts above ${cap.toFixed()}% need the pos.update permission`);
}

async function createSaleInTx(ctx, input, t) {
  const existing = await SalesInvoice.findOne({
    where: { companyId: ctx.auth.companyId, clientUuid: input.clientUuid },
    transaction: t,
  });
  if (existing) return { invoiceId: existing.id, duplicate: true };

  const offline = Boolean(input.offline);
  const register = await findRegister(ctx, input.registerId, t);
  const session = await lockOpenSessionOrSynced(ctx, input.sessionId, register, offline, t);
  const customerId = input.customerId ?? register.defaultCustomerId;
  if (!customerId) throw invalid('customerId', 'Choose a customer (this register has no walk-in customer)');
  const walkIn = String(customerId) === String(register.defaultCustomerId);
  const date =
    offline && input.offline.soldAt
      ? input.offline.soldAt.slice(0, 10)
      : await companyToday(ctx.auth.companyId);
  if (!offline) await checkCashierLimits(ctx, input, customerId, date, t);

  const doc = await createInvoiceDraft(
    ctx,
    {
      customerId,
      warehouseId: register.warehouseId,
      invoiceDate: date,
      dueDate: date,
      notes: input.notes ?? null,
      discountType: input.discountType,
      discountValue: input.discountValue,
      items: await assignBatches(ctx, input.items, register.warehouseId, t),
    },
    t,
    { docType: 'pos_sale' },
  );
  await doc.reload({ transaction: t });
  const total = D(doc.total);

  // Payments: card / wallet / credits can't exceed the bill; only cash gives change.
  const methods = await PaymentMethod.findAll({
    where: {
      id: input.payments.map((p) => p.paymentMethodId),
      companyId: ctx.auth.companyId,
      isActive: true,
    },
    transaction: t,
  });
  const methodOf = new Map(methods.map((m) => [String(m.id), m]));
  input.payments.forEach((p, i) => {
    const m = methodOf.get(String(p.paymentMethodId));
    if (!m) throw invalid(`payments.${i}.paymentMethodId`, 'Payment method not found');
    if (m.requiresReference && !p.reference && !offline)
      throw invalid(`payments.${i}.reference`, `${m.name} needs a reference (transaction / approval no.)`);
  });
  const isCash = (p) => methodOf.get(String(p.paymentMethodId)).type === 'cash';
  const cashPaid = sumOf(input.payments.filter(isCash));
  const otherPaid = sumOf(input.payments.filter((p) => !isCash(p))).plus(sumOf(input.credits ?? []));
  if (otherPaid.gt(total))
    throw invalid('payments', 'Card, wallet and credit payments are more than the bill — reduce them');
  const tendered = cashPaid.plus(otherPaid);
  const change = tendered.gt(total) ? tendered.minus(total) : D(0);
  const due = total.minus(tendered.minus(change));
  if (due.gt(0) && walkIn && !offline)
    throw invalid('payments', `Walk-in sales must be paid in full (${due.toFixed(2)} short)`);

  await doc.update(
    {
      channel: 'pos',
      posSessionId: session.id,
      clientUuid: input.clientUuid,
      offlineNumber: input.offline?.number ?? null,
      tendered: fixed(tendered),
      changeAmount: fixed(change),
    },
    { transaction: t },
  );
  const { negative } = await postInvoiceDoc(ctx, doc, { creditOverride: input.creditOverride }, t, {
    creditAmount: due,
    allowNegative: offline,
  });
  if (negative) await doc.update({ stockWarning: true }, { transaction: t });

  // Credit from a return first (exchange), then each payment; change comes out of the cash.
  for (const [i, c] of (input.credits ?? []).entries()) {
    const ret = await SalesReturn.findOne({
      where: { id: c.returnId, companyId: ctx.auth.companyId, status: 'posted' },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!ret || String(ret.customerId) !== String(customerId))
      throw invalid(`credits.${i}.returnId`, 'Return not found for this customer');
    const available = D(ret.total).minus(ret.appliedAmount).minus(ret.refundedAmount);
    const applied = await allocateToInvoices(
      ctx,
      {
        sourceType: 'credit_note',
        sourceId: ret.id,
        customerId,
        available,
        allocations: [{ invoiceId: doc.id, amount: fixed(c.amount) }],
      },
      t,
    );
    await ret.update({ appliedAmount: fixed(D(ret.appliedAmount).plus(applied)) }, { transaction: t });
  }
  let changeLeft = change;
  for (const p of input.payments) {
    let amount = D(p.amount);
    if (isCash(p) && changeLeft.gt(0)) {
      const take = amount.lt(changeLeft) ? amount : changeLeft;
      amount = amount.minus(take);
      changeLeft = changeLeft.minus(take);
    }
    if (amount.lte(0)) continue;
    await createReceiptDoc(
      ctx,
      {
        customerId,
        paymentMethodId: p.paymentMethodId,
        receiptDate: date,
        amount: fixed(amount),
        reference: p.reference ?? null,
        notes: `POS ${doc.number}`,
        allocations: [{ invoiceId: doc.id, amount: fixed(amount) }],
      },
      t,
      { branchId: register.branchId, posSessionId: session.id },
    );
  }
  return { invoiceId: doc.id, duplicate: false };
}

/**
 * Online sales need the open session. A synced offline sale keeps the session it was made in, even
 * if that session has been closed meanwhile (its goods have already left).
 */
async function lockOpenSessionOrSynced(ctx, sessionId, register, offline, t) {
  if (!offline) {
    const session = await lockOpenSession(ctx, sessionId, t);
    if (String(session.registerId) !== String(register.id))
      throw invalid('sessionId', 'The session belongs to another register');
    return session;
  }
  const session = await PosSession.findOne({
    where: { id: sessionId, companyId: ctx.auth.companyId, registerId: register.id },
    transaction: t,
  });
  if (!session) throw invalid('sessionId', 'Register session not found');
  return session;
}

export async function createSale(ctx, input) {
  const { invoiceId } = await sequelize.transaction((t) => createSaleInTx(ctx, input, t));
  return receiptData(ctx, invoiceId);
}

/** Sync sales queued offline: each in its own transaction; one failure doesn't stop the rest. */
export async function syncSales(ctx, { sales }) {
  const results = [];
  for (const sale of sales) {
    try {
      const { invoiceId, duplicate } = await sequelize.transaction((t) =>
        createSaleInTx(ctx, { ...sale, offline: sale.offline ?? { number: null } }, t),
      );
      const inv = await SalesInvoice.findByPk(invoiceId, {
        attributes: ['id', 'number', 'total', 'stockWarning'],
      });
      results.push({ clientUuid: sale.clientUuid, ok: true, duplicate, invoice: inv.toJSON() });
    } catch (err) {
      results.push({
        clientUuid: sale.clientUuid,
        ok: false,
        error: err.message,
        errors: err.errors,
        // Retrying a validation error won't help; a lost connection or deadlock will.
        retry: !(err instanceof AppError) || err.statusCode >= 500,
      });
    }
  }
  return { results, synced: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

/** Everything a receipt (80 mm or A4) shows. */
export async function receiptData(ctx, invoiceId) {
  const inv = await SalesInvoice.findOne({
    where: { id: invoiceId, companyId: ctx.auth.companyId },
    include: [
      customerRef(),
      { model: User, as: 'poster', attributes: ['id', 'name'] },
      { model: PosSession, as: 'posSession', attributes: ['id', 'number', 'registerId'] },
      {
        model: SalesInvoiceItem,
        as: 'items',
        include: salesLineIncludes({ batch: true }),
        separate: true,
        order: [['sortOrder', 'ASC']],
      },
    ],
  });
  if (!inv) throw AppError.notFound('Sale not found');
  if (!(ctx.auth.branchIds ?? []).map(String).includes(String(inv.branchId)) && !ctx.auth.isSuperAdmin)
    throw AppError.forbidden('You do not have access to this branch');
  const [receipts, credits, company, settings] = await Promise.all([
    ReceivableAllocation.findAll({
      where: { invoiceId: inv.id, sourceType: 'receipt' },
      attributes: ['sourceId'],
    }).then((rows) =>
      CustomerReceipt.findAll({
        where: { status: 'posted', id: rows.length ? rows.map((r) => r.sourceId) : [0] },
        include: [{ model: PaymentMethod, as: 'paymentMethod', attributes: ['id', 'name', 'type'] }],
        order: [['id', 'ASC']],
      }),
    ),
    sequelize.query(
      `SELECT s.number, a.amount FROM receivable_allocations a JOIN sales_returns s ON s.id = a.source_id
        WHERE a.source_type = 'credit_note' AND a.invoice_id = ?`,
      { replacements: [inv.id], type: 'SELECT' },
    ),
    Company.findByPk(ctx.auth.companyId),
    posSettings(ctx.auth.companyId),
  ]);
  const json = inv.toJSON();
  const cashGiven = receipts.reduce((s, r) => s.plus(r.amount), D(0));
  return {
    invoice: json,
    payments: [
      ...receipts.map((r) => ({
        method: r.paymentMethod?.name,
        type: r.paymentMethod?.type,
        amount: fixed(r.amount),
        reference: r.reference,
      })),
      ...credits.map((c) => ({
        method: `Credit ${c.number}`,
        type: 'credit',
        amount: fixed(c.amount),
        reference: null,
      })),
    ],
    paid: fixed(cashGiven.plus(credits.reduce((s, c) => s.plus(c.amount), D(0)))),
    company: {
      name: company.name,
      address: company.address ?? null,
      phone: company.phone ?? null,
      email: company.email ?? null,
      binNo: company.binNo ?? null,
      logoUrl: company.logoUrl ?? null,
    },
    amountInWords: { en: amountInWords(inv.total, 'en'), bn: amountInWords(inv.total, 'bn') },
    footer: settings.receiptFooter,
  };
}

/** Find a sale by its receipt number (or the number printed offline), with what can still be returned. */
export async function lookupSale(ctx, { number }) {
  const inv = await SalesInvoice.findOne({
    where: {
      companyId: ctx.auth.companyId,
      branchId: ctx.branchIds.length ? ctx.branchIds : [0],
      status: { [Op.in]: ['unpaid', 'partially_paid', 'paid'] },
      [Op.or]: [{ number: number.trim() }, { offlineNumber: number.trim() }],
    },
  });
  if (!inv) throw AppError.notFound('No sale with that receipt number');
  const data = await receiptData(ctx, inv.id);
  return {
    ...data,
    returnable: data.invoice.items.map((i) => ({
      invoiceItemId: String(i.id),
      returnableBaseQuantity: fixed(D(i.baseQuantity).minus(i.returnedBaseQuantity)),
      unitRefund: D(i.lineTotal).dividedBy(i.baseQuantity).toFixed(4),
    })),
  };
}

/**
 * Return goods from a POS sale into the register's warehouse. The credit pays the sale back if it is
 * still open; `refund` pays (part of) the rest out of the drawer, and anything left stays as credit
 * for an exchange (`credits` on the next sale).
 */
export async function createPosReturn(ctx, invoiceId, input) {
  const returnId = await sequelize.transaction(async (t) => {
    const register = await findRegister(ctx, input.registerId, t);
    const session = await lockOpenSession(ctx, input.sessionId, t);
    if (String(session.registerId) !== String(register.id))
      throw invalid('sessionId', 'The session belongs to another register');
    const invoice = await SalesInvoice.findOne({
      where: {
        id: invoiceId,
        companyId: ctx.auth.companyId,
        status: { [Op.in]: ['unpaid', 'partially_paid', 'paid'] },
      },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!invoice) throw AppError.notFound('Sale not found');
    const quantities = new Map(input.items.map((i) => [String(i.invoiceItemId), i.quantity]));
    const lines = await invoiceReturnLines(invoice, 'return', t, quantities);
    if (!lines.length) throw invalid('items', 'Choose at least one item to return');
    const doc = await createReturnDraft(
      ctx,
      {
        type: 'return',
        customerId: invoice.customerId,
        invoiceId: invoice.id,
        warehouseId: register.warehouseId,
        reason: input.reason ?? null,
        items: lines,
      },
      t,
    );
    await doc.update({ posSessionId: session.id }, { transaction: t });
    await postReturnDoc(ctx, doc, t);
    await doc.reload({ transaction: t });

    if (input.refund) {
      const method = await PaymentMethod.findOne({
        where: { id: input.refund.paymentMethodId, companyId: ctx.auth.companyId, isActive: true },
        transaction: t,
      });
      if (!method) throw invalid('refund.paymentMethodId', 'Payment method not found');
      const available = D(doc.total).minus(doc.appliedAmount);
      const amount = input.refund.amount != null ? D(input.refund.amount) : available;
      if (amount.gt(available))
        throw invalid('refund.amount', `Only ${available.toFixed(2)} can be refunded`);
      if (method.type === 'cash') {
        const { cash } = await sessionReport(session, t);
        if (amount.gt(cash.expected))
          throw invalid('refund.amount', `Only ${D(cash.expected).toFixed(2)} should be in the drawer`);
      }
      await doc.update({ refundedAmount: fixed(amount), refundMethodId: method.id }, { transaction: t });
      await postSource('sales_return', doc.id, by(ctx, t, { event: 'refund' }));
    }
    return doc.id;
  });
  const ret = await SalesReturn.findByPk(returnId, {
    include: [{ model: PaymentMethod, as: 'refundMethod', attributes: ['id', 'name', 'type'] }],
  });
  return {
    ...ret.toJSON(),
    credit: fixed(D(ret.total).minus(ret.appliedAmount).minus(ret.refundedAmount)),
  };
}

/** Latest sales of a session (for reprints). */
export async function sessionSales(ctx, sessionId, { limit = 20 } = {}) {
  const rows = await SalesInvoice.findAll({
    where: {
      companyId: ctx.auth.companyId,
      posSessionId: sessionId,
      branchId: ctx.branchIds.length ? ctx.branchIds : [0],
    },
    attributes: ['id', 'number', 'offlineNumber', 'total', 'status', 'postedAt', 'stockWarning'],
    include: [customerRef()],
    order: [['id', 'DESC']],
    limit,
  });
  return rows.map((r) => r.toJSON());
}
