import { sequelize } from '../../config/db.js';
import { Account, Attachment, BankAccount, Branch, Expense, ExpenseCategory, User } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { createCrudService } from '../../utils/crud.js';
import { parseListQuery } from '../../utils/pagination.js';
import { retiredValue } from '../../utils/slug.js';
import { assertUnused } from '../../utils/usage.js';
import { assertBranchAccess, companyToday, invalid } from '../inventory/inventory.common.js';
import { currentBranch, dateRange, inScope } from '../sales/sales.common.js';
import { findBankAccount } from './bank-accounts.service.js';
import { D, fixed } from './ledger.service.js';
import { by, postSource, unpostSource } from './posting.service.js';
import { nextAccountingNumber } from './series.js';

/**
 * Expenses paid straight from a cash / bank account (bills on credit go through Purchase → bills).
 *   Dr the category's expense account (net) · Dr VAT input (rebate)   Cr cash / bank (total)
 * draft ─post─▶ posted ─void─▶ void (reversing entry). Receipts / bills are attached as files.
 */

const LABEL = 'Expense';

// ── Categories ────────────────────────────────────────────────────────────

export const expenseCategories = createCrudService({
  model: ExpenseCategory,
  label: 'Expense category',
  uniqueFields: ['code'],
  listOptions: {
    sortable: ['name', 'code', 'createdAt'],
    searchable: ['name', 'code'],
    filterable: ['isActive'],
    defaultSort: 'name',
  },
  include: () => [
    { model: Account, as: 'account', attributes: ['id', 'code', 'name', 'nameBn'], paranoid: false },
  ],
  async beforeSave(ctx, data, existing, t) {
    if (data.code) data.code = data.code.toUpperCase();
    if (data.accountId) {
      const a = await Account.findOne({
        where: { id: data.accountId, companyId: ctx.auth.companyId },
        transaction: t,
      });
      if (!a || a.isGroup || a.type !== 'expense')
        throw invalid('accountId', 'Choose an expense ledger account');
    }
    return data;
  },
  beforeDelete: (ctx, category, t) =>
    assertUnused(
      category.id,
      [{ table: 'expenses', column: 'category_id', label: 'expense', paranoid: true }],
      {
        what: `Category ${category.name}`,
        transaction: t,
      },
    ),
});

// ── Expenses ──────────────────────────────────────────────────────────────

const LIST_OPTIONS = {
  sortable: ['number', 'expenseDate', 'total', 'createdAt'],
  searchable: ['number', 'payee', 'reference', 'description'],
  filterable: ['status', 'categoryId', 'bankAccountId'],
  defaultSort: '-expenseDate',
};
const userRef = (as) => ({ model: User, as, attributes: ['id', 'name'] });
const refs = () => [
  { model: ExpenseCategory, as: 'category', attributes: ['id', 'name', 'code'], paranoid: false },
  { model: BankAccount, as: 'bankAccount', attributes: ['id', 'name', 'kind'], paranoid: false },
];

export async function listExpenses(ctx, query) {
  const q = parseListQuery(query, LIST_OPTIONS);
  const { rows, count } = await Expense.findAndCountAll({
    where: { ...q.where, companyId: ctx.auth.companyId, ...inScope(ctx), ...dateRange('expenseDate', query) },
    include: [...refs(), userRef('creator')],
    order: [...q.order, ['id', 'DESC']],
    limit: q.limit,
    offset: q.offset,
    distinct: true,
  });
  return { rows: rows.map((r) => r.toJSON()), count, page: q.page, limit: q.limit };
}

export async function getExpense(ctx, id) {
  const doc = await Expense.findOne({
    where: { id, companyId: ctx.auth.companyId, ...inScope(ctx) },
    include: [
      ...refs(),
      { model: Branch, as: 'branch', attributes: ['id', 'name', 'code'] },
      userRef('creator'),
      userRef('poster'),
      userRef('voider'),
    ],
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  const attachments = await Attachment.findAll({
    where: { companyId: ctx.auth.companyId, entityType: 'expense', entityId: doc.id },
    order: [['id', 'ASC']],
  });
  return { ...doc.toJSON(), attachments: attachments.map((a) => a.toJSON()) };
}

async function lockExpense(ctx, id, t, allowed) {
  const doc = await Expense.findOne({
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

async function writeDraft(ctx, doc, input, t) {
  const category = await ExpenseCategory.findOne({
    where: { id: input.categoryId, companyId: ctx.auth.companyId, isActive: true },
    transaction: t,
  });
  if (!category) throw invalid('categoryId', 'Expense category not found');
  const bank = await findBankAccount(ctx, input.bankAccountId, 'bankAccountId', t);
  const amount = D(input.amount);
  const tax = D(input.taxAmount ?? 0);
  if (amount.lte(0)) throw invalid('amount', 'Enter the amount');
  await doc.update(
    {
      expenseDate: input.expenseDate,
      categoryId: category.id,
      bankAccountId: bank.id,
      payee: input.payee ?? null,
      reference: input.reference ?? null,
      description: input.description ?? null,
      amount: fixed(amount),
      taxAmount: fixed(tax),
      total: fixed(amount.plus(tax)),
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
}

async function postDoc(ctx, doc, t) {
  await doc.update(
    { status: 'posted', postedBy: ctx.auth.userId, postedAt: new Date(), updatedBy: ctx.auth.userId },
    { transaction: t },
  );
  await postSource('expense', doc.id, by(ctx, t));
}

export async function createExpense(ctx, input) {
  const id = await sequelize.transaction(async (t) => {
    const branchId = input.branchId ?? currentBranch(ctx);
    assertBranchAccess(ctx, branchId);
    const doc = await Expense.create(
      {
        companyId: ctx.auth.companyId,
        branchId,
        number: await nextAccountingNumber({
          companyId: ctx.auth.companyId,
          docType: 'expense',
          branchId,
          userId: ctx.auth.userId,
          transaction: t,
        }),
        expenseDate: input.expenseDate ?? (await companyToday(ctx.auth.companyId)),
        categoryId: input.categoryId,
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
  return getExpense(ctx, id);
}

export async function updateExpense(ctx, id, input) {
  await sequelize.transaction(async (t) => {
    const doc = await lockExpense(ctx, id, t, ['draft']);
    await writeDraft(ctx, doc, input, t);
    if (input.post) await postDoc(ctx, doc, t);
  });
  return getExpense(ctx, id);
}

export async function postExpense(ctx, id) {
  await sequelize.transaction(async (t) => postDoc(ctx, await lockExpense(ctx, id, t, ['draft']), t));
  return getExpense(ctx, id);
}

export async function deleteExpense(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockExpense(ctx, id, t, ['draft']);
    await doc.update({ number: retiredValue(doc.number, doc.id, 60) }, { transaction: t });
    await doc.destroy({ transaction: t });
  });
}

export async function voidExpense(ctx, id, reason) {
  await sequelize.transaction(async (t) => {
    const doc = await lockExpense(ctx, id, t, ['posted']);
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
    await unpostSource('expense', doc.id, by(ctx, t));
  });
  return getExpense(ctx, id);
}
