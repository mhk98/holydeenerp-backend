import { DataTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { baseModelOptions, idColumn, money, tenantColumns } from '../../utils/model.js';

/**
 * Cash & bank: money accounts (each with its own ledger account), vouchers, the cheque register,
 * bank reconciliation, expenses and file attachments.
 */

export const MONEY_KINDS = ['cash', 'bank', 'mobile_wallet'];
export const VOUCHER_TYPES = ['receipt', 'payment', 'contra'];
export const DOC_STATUSES = ['draft', 'posted', 'void'];
export const CHEQUE_STATUSES = ['in_hand', 'deposited', 'issued', 'cleared', 'bounced', 'cancelled'];

const id = (allowNull = true) => ({ type: DataTypes.BIGINT.UNSIGNED, allowNull });
const by = (...names) =>
  Object.fromEntries(
    names.flatMap((n) => [
      [`${n}By`, id()],
      [`${n}At`, DataTypes.DATE],
    ]),
  );

/** JSON kept in a TEXT column (MariaDB has no native JSON type). */
const json = (field, fallback) => ({
  type: DataTypes.TEXT,
  get() {
    const raw = this.getDataValue(field);
    return raw ? JSON.parse(raw) : fallback;
  },
  set(value) {
    this.setDataValue(field, value == null ? null : JSON.stringify(value));
  },
});

export const BankAccount = sequelize.define(
  'BankAccount',
  {
    ...idColumn,
    ...tenantColumns(),
    accountId: id(false),
    kind: { type: DataTypes.ENUM(...MONEY_KINDS), allowNull: false },
    name: { type: DataTypes.STRING(150), allowNull: false },
    bankName: DataTypes.STRING(150),
    branchName: DataTypes.STRING(150),
    accountNumber: DataTypes.STRING(60),
    routingNumber: DataTypes.STRING(30),
    /** Column mapping of this bank's statement files (remembered from the last import). */
    statementMapping: json('statementMapping', null),
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    notes: DataTypes.STRING(500),
  },
  { ...baseModelOptions, tableName: 'bank_accounts' },
);

export const Voucher = sequelize.define(
  'Voucher',
  {
    ...idColumn,
    ...tenantColumns(),
    branchId: id(false),
    number: { type: DataTypes.STRING(60), allowNull: false },
    voucherType: { type: DataTypes.ENUM(...VOUCHER_TYPES), allowNull: false },
    voucherDate: { type: DataTypes.DATEONLY, allowNull: false },
    /** Money side: received into (receipt), paid from (payment), moved from (contra). */
    bankAccountId: id(false),
    /** Contra only: moved to. */
    toBankAccountId: id(),
    partyName: DataTypes.STRING(150),
    reference: DataTypes.STRING(100),
    narration: DataTypes.STRING(500),
    amount: money(),
    status: { type: DataTypes.ENUM(...DOC_STATUSES), allowNull: false, defaultValue: 'draft' },
    ...by('posted', 'voided'),
    voidReason: DataTypes.STRING(500),
  },
  { ...baseModelOptions, tableName: 'vouchers' },
);

export const VoucherLine = sequelize.define(
  'VoucherLine',
  {
    ...idColumn,
    voucherId: id(false),
    accountId: id(false),
    description: DataTypes.STRING(255),
    amount: money(),
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  { tableName: 'voucher_lines', underscored: true, timestamps: true },
);

export const Cheque = sequelize.define(
  'Cheque',
  {
    ...idColumn,
    ...tenantColumns(),
    direction: { type: DataTypes.ENUM('received', 'issued'), allowNull: false },
    chequeNo: { type: DataTypes.STRING(60), allowNull: false },
    bankName: DataTypes.STRING(150),
    chequeDate: DataTypes.DATEONLY,
    amount: money(),
    partyId: id(),
    status: { type: DataTypes.ENUM(...CHEQUE_STATUSES), allowNull: false },
    sourceType: { type: DataTypes.STRING(40), allowNull: false },
    sourceId: id(false),
    sourceNo: DataTypes.STRING(60),
    depositBankAccountId: id(),
    depositedAt: DataTypes.DATEONLY,
    clearedAt: DataTypes.DATEONLY,
    bouncedAt: DataTypes.DATEONLY,
    bounceReason: DataTypes.STRING(500),
    notes: DataTypes.STRING(500),
  },
  { ...baseModelOptions, tableName: 'cheques' },
);

export const BankReconciliation = sequelize.define(
  'BankReconciliation',
  {
    ...idColumn,
    ...tenantColumns({ branch: false }),
    bankAccountId: id(false),
    statementDate: { type: DataTypes.DATEONLY, allowNull: false },
    statementBalance: money(),
    /** Statement balance of the previous completed reconciliation (where this one starts). */
    openingBalance: money(),
    status: {
      type: DataTypes.ENUM('in_progress', 'completed'),
      allowNull: false,
      defaultValue: 'in_progress',
    },
    ...by('completed'),
    notes: DataTypes.STRING(500),
  },
  { ...baseModelOptions, tableName: 'bank_reconciliations' },
);

export const BankStatementLine = sequelize.define(
  'BankStatementLine',
  {
    ...idColumn,
    reconciliationId: id(false),
    lineDate: { type: DataTypes.DATEONLY, allowNull: false },
    description: DataTypes.STRING(255),
    reference: DataTypes.STRING(100),
    /** Signed: + money in (deposit), − money out (withdrawal). */
    amount: money(),
    journalLineId: id(),
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  { tableName: 'bank_statement_lines', underscored: true, timestamps: true },
);

export const ExpenseCategory = sequelize.define(
  'ExpenseCategory',
  {
    ...idColumn,
    ...tenantColumns({ branch: false }),
    name: { type: DataTypes.STRING(150), allowNull: false },
    code: { type: DataTypes.STRING(30), allowNull: false },
    accountId: id(false),
    description: DataTypes.STRING(500),
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { ...baseModelOptions, tableName: 'expense_categories' },
);

export const Expense = sequelize.define(
  'Expense',
  {
    ...idColumn,
    ...tenantColumns(),
    branchId: id(false),
    number: { type: DataTypes.STRING(60), allowNull: false },
    expenseDate: { type: DataTypes.DATEONLY, allowNull: false },
    categoryId: id(false),
    /** Paid from. */
    bankAccountId: id(false),
    payee: DataTypes.STRING(150),
    reference: DataTypes.STRING(100),
    description: DataTypes.STRING(500),
    amount: money(),
    /** VAT input (rebate) on the bill. */
    taxAmount: money(),
    total: money(),
    status: { type: DataTypes.ENUM(...DOC_STATUSES), allowNull: false, defaultValue: 'draft' },
    ...by('posted', 'voided'),
    voidReason: DataTypes.STRING(500),
  },
  { ...baseModelOptions, tableName: 'expenses' },
);

export const Attachment = sequelize.define(
  'Attachment',
  {
    ...idColumn,
    ...tenantColumns({ branch: false }),
    entityType: { type: DataTypes.STRING(40), allowNull: false },
    entityId: id(false),
    originalName: { type: DataTypes.STRING(255), allowNull: false },
    storedName: { type: DataTypes.STRING(120), allowNull: false },
    mimeType: { type: DataTypes.STRING(100), allowNull: false },
    size: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  },
  { ...baseModelOptions, tableName: 'attachments' },
);
