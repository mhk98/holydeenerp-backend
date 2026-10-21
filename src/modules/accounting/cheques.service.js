import { Op } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { BankAccount, Cheque, CustomerReceipt, Party, PaymentMethod, SupplierPayment } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { parseListQuery } from '../../utils/pagination.js';
import { assertBranchAccess, companyToday, invalid } from '../inventory/inventory.common.js';
import { voidPaymentDoc } from '../purchase/payments.service.js';
import { voidReceiptDoc } from '../sales/receipts.service.js';
import { dateRange, inScope } from '../sales/sales.common.js';
import { findBankAccount } from './bank-accounts.service.js';
import { by, postSource, unpostSource } from './posting.service.js';

/**
 * Cheque register, filled automatically: a money receipt or supplier payment through a payment
 * method of type "cheque" adds a cheque (its reference is the cheque number).
 *   received: in_hand ─deposit─▶ deposited ─clear─▶ cleared      (clearing: Dr bank, Cr cheques in hand)
 *   issued:   issued ─clear─▶ cleared                              (the bank was credited on payment)
 *   bounce (either way): the receipt / payment is voided, so the customer owes the money again
 *   (or the supplier is owed again); a cleared received cheque also has its clearing reversed.
 * Voiding the receipt / payment by hand cancels a cheque that has not cleared.
 */

const SOURCES = {
  customer_receipt: {
    model: CustomerReceipt,
    direction: 'received',
    status: 'in_hand',
    party: 'customerId',
    date: 'receiptDate',
  },
  supplier_payment: {
    model: SupplierPayment,
    direction: 'issued',
    status: 'issued',
    party: 'supplierId',
    date: 'paymentDate',
  },
};
const OPEN = ['in_hand', 'deposited', 'issued'];

/** After a receipt / payment is posted: register its cheque (once). */
export async function registerCheque(sourceType, sourceId, { companyId, userId, transaction: t }) {
  const src = SOURCES[sourceType];
  const doc = await src.model.findByPk(sourceId, { transaction: t });
  const method =
    doc && (await PaymentMethod.findByPk(doc.paymentMethodId, { paranoid: false, transaction: t }));
  if (!method || method.type !== 'cheque') return null;
  const existing = await Cheque.findOne({ where: { companyId, sourceType, sourceId }, transaction: t });
  if (existing) return existing;
  return Cheque.create(
    {
      companyId,
      branchId: doc.branchId,
      direction: src.direction,
      chequeNo: doc.reference || doc.number,
      chequeDate: doc[src.date],
      amount: doc.amount,
      partyId: doc[src.party],
      status: src.status,
      sourceType,
      sourceId,
      sourceNo: doc.number,
      createdBy: userId,
      updatedBy: userId,
    },
    { transaction: t },
  );
}

/** After a receipt / payment is voided: an open cheque is cancelled (a bounced one stays bounced). */
export async function chequeSourceVoided(sourceType, sourceId, { companyId, userId, transaction: t }) {
  await Cheque.update(
    { status: 'cancelled', updatedBy: userId },
    { where: { companyId, sourceType, sourceId, status: { [Op.in]: OPEN } }, transaction: t },
  );
}

// ── Register ──────────────────────────────────────────────────────────────

const LIST_OPTIONS = {
  sortable: ['chequeDate', 'amount', 'createdAt'],
  searchable: ['chequeNo', 'bankName', 'sourceNo'],
  filterable: ['direction', 'status', 'partyId'],
  defaultSort: '-chequeDate',
};
const include = () => [
  { model: Party, as: 'party', attributes: ['id', 'code', 'name'], paranoid: false },
  { model: BankAccount, as: 'depositBankAccount', attributes: ['id', 'name', 'kind'], paranoid: false },
];

export async function listCheques(ctx, query) {
  const q = parseListQuery(query, LIST_OPTIONS);
  const { rows, count } = await Cheque.findAndCountAll({
    where: { ...q.where, companyId: ctx.auth.companyId, ...inScope(ctx), ...dateRange('chequeDate', query) },
    include: include(),
    order: [...q.order, ['id', 'DESC']],
    limit: q.limit,
    offset: q.offset,
    distinct: true,
  });
  return { rows: rows.map((r) => r.toJSON()), count, page: q.page, limit: q.limit };
}

export async function getCheque(ctx, id) {
  const row = await Cheque.findOne({
    where: { id, companyId: ctx.auth.companyId, ...inScope(ctx) },
    include: include(),
  });
  if (!row) throw AppError.notFound('Cheque not found');
  return row.toJSON();
}

async function lockCheque(ctx, id, t, allowed) {
  const row = await Cheque.findOne({
    where: { id, companyId: ctx.auth.companyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!row) throw AppError.notFound('Cheque not found');
  assertBranchAccess(ctx, row.branchId);
  if (allowed && !allowed.includes(row.status))
    throw AppError.conflict(
      `Cheque ${row.chequeNo} is ${row.status.replaceAll('_', ' ')}; this action is not allowed`,
    );
  return row;
}

/** Bank name, cheque date / number and notes (while the cheque is open). */
export async function updateCheque(ctx, id, input) {
  await sequelize.transaction(async (t) => {
    const row = await lockCheque(ctx, id, t, OPEN);
    await row.update({ ...input, updatedBy: ctx.auth.userId }, { transaction: t });
  });
  return getCheque(ctx, id);
}

export async function depositCheque(ctx, id, { bankAccountId, date }) {
  await sequelize.transaction(async (t) => {
    const row = await lockCheque(ctx, id, t, ['in_hand']);
    const bank = await findBankAccount(ctx, bankAccountId, 'bankAccountId', t);
    await row.update(
      {
        status: 'deposited',
        depositBankAccountId: bank.id,
        depositedAt: date ?? (await companyToday(ctx.auth.companyId)),
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
  });
  return getCheque(ctx, id);
}

/** Cleared by the bank: a received cheque moves from cheques in hand to the bank account. */
export async function clearCheque(ctx, id, { bankAccountId, date }) {
  await sequelize.transaction(async (t) => {
    const row = await lockCheque(ctx, id, t, ['in_hand', 'deposited', 'issued']);
    const patch = {
      status: 'cleared',
      clearedAt: date ?? (await companyToday(ctx.auth.companyId)),
      updatedBy: ctx.auth.userId,
    };
    if (row.direction === 'received') {
      const bankId = bankAccountId ?? row.depositBankAccountId;
      if (!bankId) throw invalid('bankAccountId', 'Choose the account the cheque was paid into');
      const bank = await findBankAccount(ctx, bankId, 'bankAccountId', t);
      patch.depositBankAccountId = bank.id;
      patch.depositedAt = row.depositedAt ?? patch.clearedAt;
    }
    await row.update(patch, { transaction: t });
    if (row.direction === 'received') await postSource('cheque', row.id, by(ctx, t, { event: 'clear' }));
  });
  return getCheque(ctx, id);
}

/** Bounced: reverse a clearing and void the receipt / payment, so the balance is owed again. */
export async function bounceCheque(ctx, id, { date, reason }) {
  await sequelize.transaction(async (t) => {
    const row = await lockCheque(ctx, id, t, ['in_hand', 'deposited', 'issued', 'cleared']);
    if (row.status === 'cleared' && row.direction === 'received')
      await unpostSource('cheque', row.id, by(ctx, t, { events: ['clear'] }));
    await row.update(
      {
        status: 'bounced',
        bouncedAt: date ?? (await companyToday(ctx.auth.companyId)),
        bounceReason: reason,
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
    const why = `Cheque ${row.chequeNo} bounced: ${reason}`;
    if (row.sourceType === 'customer_receipt') {
      const receipt = await CustomerReceipt.findByPk(row.sourceId, { transaction: t, lock: t.LOCK.UPDATE });
      if (receipt?.status === 'posted') await voidReceiptDoc(ctx, receipt, why, t);
    } else {
      const payment = await SupplierPayment.findByPk(row.sourceId, { transaction: t, lock: t.LOCK.UPDATE });
      if (payment?.status === 'posted') await voidPaymentDoc(ctx, payment, why, t);
    }
  });
  return getCheque(ctx, id);
}
