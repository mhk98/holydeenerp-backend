import { sequelize } from '../../config/db.js';
import { Account, BankAccount, Branch, User, Voucher, VoucherLine } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { parseListQuery } from '../../utils/pagination.js';
import { retiredValue } from '../../utils/slug.js';
import { assertBranchAccess, companyToday, invalid } from '../inventory/inventory.common.js';
import { currentBranch, dateRange, inScope } from '../sales/sales.common.js';
import { findBankAccount } from './bank-accounts.service.js';
import { D, fixed } from './ledger.service.js';
import { by, postSource, unpostSource } from './posting.service.js';
import { nextAccountingNumber } from './series.js';

/**
 * Cash / bank vouchers for money that is not a customer receipt or supplier payment:
 *   receipt  money in   Dr cash / bank   Cr the lines (other income, loans, capital …)
 *   payment  money out  Dr the lines     Cr cash / bank
 *   contra   transfer   Dr to-account    Cr from-account (cash deposit, withdrawal, bank to bank)
 * draft ─post─▶ posted ─void─▶ void (reversing entry). Customer and supplier money goes through
 * Sales receipts and Purchase payments, so receivable / payable accounts are not allowed on lines.
 */

const LABEL = 'Voucher';
const DOC_TYPE = { receipt: 'bank_receipt', payment: 'bank_payment', contra: 'contra_voucher' };
const LIST_OPTIONS = {
  sortable: ['number', 'voucherDate', 'amount', 'createdAt'],
  searchable: ['number', 'reference', 'narration', 'partyName'],
  filterable: ['voucherType', 'status', 'bankAccountId'],
  defaultSort: '-voucherDate',
};

const moneyRef = (as) => ({
  model: BankAccount,
  as,
  attributes: ['id', 'name', 'kind', 'accountId'],
  paranoid: false,
});
const userRef = (as) => ({ model: User, as, attributes: ['id', 'name'] });

export async function listVouchers(ctx, query) {
  const q = parseListQuery(query, LIST_OPTIONS);
  const { rows, count } = await Voucher.findAndCountAll({
    where: { ...q.where, companyId: ctx.auth.companyId, ...inScope(ctx), ...dateRange('voucherDate', query) },
    include: [moneyRef('bankAccount'), moneyRef('toBankAccount'), userRef('creator')],
    order: [...q.order, ['id', 'DESC']],
    limit: q.limit,
    offset: q.offset,
    distinct: true,
  });
  return { rows: rows.map((r) => r.toJSON()), count, page: q.page, limit: q.limit };
}

export async function getVoucher(ctx, id) {
  const doc = await Voucher.findOne({
    where: { id, companyId: ctx.auth.companyId, ...inScope(ctx) },
    include: [
      moneyRef('bankAccount'),
      moneyRef('toBankAccount'),
      { model: Branch, as: 'branch', attributes: ['id', 'name', 'code'] },
      userRef('creator'),
      userRef('poster'),
      userRef('voider'),
      {
        model: VoucherLine,
        as: 'lines',
        separate: true,
        order: [['sortOrder', 'ASC']],
        include: [
          { model: Account, as: 'account', attributes: ['id', 'code', 'name', 'nameBn'], paranoid: false },
        ],
      },
    ],
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  return doc.toJSON();
}

async function lockVoucher(ctx, id, t, allowed) {
  const doc = await Voucher.findOne({
    where: { id, companyId: ctx.auth.companyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  assertBranchAccess(ctx, doc.branchId);
  if (!allowed.includes(doc.status))
    throw AppError.conflict(`${LABEL} ${doc.number} is ${doc.status}; this action is not allowed`);
  return doc;
}

/** Validate and store the header and lines of a draft. */
async function writeDraft(ctx, doc, input, t) {
  const type = doc.voucherType;
  const bank = await findBankAccount(ctx, input.bankAccountId, 'bankAccountId', t);
  let amount;
  let lines = [];
  if (type === 'contra') {
    if (!input.toBankAccountId) throw invalid('toBankAccountId', 'Choose the account the money goes to');
    if (String(input.toBankAccountId) === String(bank.id))
      throw invalid('toBankAccountId', 'Choose a different account');
    await findBankAccount(ctx, input.toBankAccountId, 'toBankAccountId', t);
    amount = D(input.amount ?? 0);
    if (amount.lte(0)) throw invalid('amount', 'Enter the amount');
  } else {
    lines = input.lines ?? [];
    if (!lines.length) throw invalid('lines', 'Add at least one line');
    const accounts = await Account.findAll({
      where: { id: lines.map((l) => l.accountId), companyId: ctx.auth.companyId },
      transaction: t,
    });
    const accountOf = new Map(accounts.map((a) => [String(a.id), a]));
    lines.forEach((l, i) => {
      const a = accountOf.get(String(l.accountId));
      if (!a) throw invalid(`lines.${i}.accountId`, 'Account not found');
      if (a.isGroup)
        throw invalid(`lines.${i}.accountId`, `${a.name} is a group; choose an account under it`);
      if (!a.isActive) throw invalid(`lines.${i}.accountId`, `${a.name} is inactive`);
      if (['receivable', 'payable'].includes(a.subtype))
        throw invalid(
          `lines.${i}.accountId`,
          'Customer and supplier money goes through money receipts and supplier payments',
        );
      if (String(a.id) === String(bank.accountId))
        throw invalid(`lines.${i}.accountId`, 'A line cannot use the voucher’s own cash / bank account');
    });
    amount = lines.reduce((s, l) => s.plus(l.amount), D(0));
  }
  await doc.update(
    {
      voucherDate: input.voucherDate,
      bankAccountId: bank.id,
      toBankAccountId: type === 'contra' ? input.toBankAccountId : null,
      partyName: input.partyName ?? null,
      reference: input.reference ?? null,
      narration: input.narration ?? null,
      amount: fixed(amount),
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  await VoucherLine.destroy({ where: { voucherId: doc.id }, transaction: t });
  await VoucherLine.bulkCreate(
    lines.map((l, i) => ({
      voucherId: doc.id,
      accountId: l.accountId,
      description: l.description ?? null,
      amount: fixed(l.amount),
      sortOrder: i,
    })),
    { transaction: t },
  );
}

async function postDoc(ctx, doc, t) {
  await doc.update(
    { status: 'posted', postedBy: ctx.auth.userId, postedAt: new Date(), updatedBy: ctx.auth.userId },
    { transaction: t },
  );
  await postSource('voucher', doc.id, by(ctx, t));
}

export async function createVoucher(ctx, input) {
  const id = await sequelize.transaction(async (t) => {
    const branchId = input.branchId ?? currentBranch(ctx);
    assertBranchAccess(ctx, branchId);
    const doc = await Voucher.create(
      {
        companyId: ctx.auth.companyId,
        branchId,
        number: await nextAccountingNumber({
          companyId: ctx.auth.companyId,
          docType: DOC_TYPE[input.voucherType],
          branchId,
          userId: ctx.auth.userId,
          transaction: t,
        }),
        voucherType: input.voucherType,
        voucherDate: input.voucherDate ?? (await companyToday(ctx.auth.companyId)),
        bankAccountId: input.bankAccountId,
        status: 'draft',
        createdBy: ctx.auth.userId,
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
    await writeDraft(ctx, doc, input, t);
    if (input.post) await postDoc(ctx, doc, t);
    return doc.id;
  });
  return getVoucher(ctx, id);
}

export async function updateVoucher(ctx, id, input) {
  await sequelize.transaction(async (t) => {
    const doc = await lockVoucher(ctx, id, t, ['draft']);
    await writeDraft(ctx, doc, input, t);
    if (input.post) await postDoc(ctx, doc, t);
  });
  return getVoucher(ctx, id);
}

export async function postVoucher(ctx, id) {
  await sequelize.transaction(async (t) => postDoc(ctx, await lockVoucher(ctx, id, t, ['draft']), t));
  return getVoucher(ctx, id);
}

export async function deleteVoucher(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockVoucher(ctx, id, t, ['draft']);
    await doc.update({ number: retiredValue(doc.number, doc.id, 60) }, { transaction: t });
    await doc.destroy({ transaction: t });
  });
}

/** Void a posted voucher: its journal is reversed (dated today). */
export async function voidVoucher(ctx, id, reason) {
  await sequelize.transaction(async (t) => {
    const doc = await lockVoucher(ctx, id, t, ['posted']);
    if (await isReconciled(doc.id, t))
      throw AppError.conflict('This voucher is matched in a bank reconciliation; unmatch it first');
    await doc.update(
      {
        status: 'void',
        voidedBy: ctx.auth.userId,
        voidedAt: new Date(),
        voidReason: reason,
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
    await unpostSource('voucher', doc.id, by(ctx, t));
  });
  return getVoucher(ctx, id);
}

/** True when a journal line of the voucher is cleared in a reconciliation. */
async function isReconciled(voucherId, t) {
  const [row] = await sequelize.query(
    `SELECT COUNT(*) AS n FROM journal_lines l JOIN journal_entries j ON j.id = l.journal_id
      WHERE j.source_type = 'voucher' AND j.source_id = :voucherId AND l.reconciliation_id IS NOT NULL`,
    { replacements: { voucherId }, type: 'SELECT', transaction: t },
  );
  return Number(row.n) > 0;
}
