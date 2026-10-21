import { DataTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { baseModelOptions, idColumn, money, tenantColumns } from '../../utils/model.js';

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'];

/** Subtypes per type — they drive report grouping (cash flow, balance sheet sections). */
export const ACCOUNT_SUBTYPES = {
  asset: ['cash', 'bank', 'receivable', 'inventory', 'tax', 'current_asset', 'fixed_asset', 'contra_asset'],
  liability: ['payable', 'tax', 'current_liability', 'long_term_liability'],
  equity: ['equity', 'retained_earnings'],
  income: ['revenue', 'contra_revenue', 'other_income'],
  expense: ['cogs', 'expense', 'other_expense'],
};

/** Debit-normal types; the rest are credit-normal. */
export const DEBIT_NORMAL = new Set(['asset', 'expense']);

export const ENTRY_TYPES = ['manual', 'auto', 'opening', 'closing', 'reversal'];
export const JOURNAL_STATUSES = ['draft', 'posted'];

const id = (allowNull = true) => ({ type: DataTypes.BIGINT.UNSIGNED, allowNull });

export const Account = sequelize.define(
  'Account',
  {
    ...idColumn,
    ...tenantColumns({ branch: false }),
    parentId: id(),
    code: { type: DataTypes.STRING(20), allowNull: false },
    name: { type: DataTypes.STRING(150), allowNull: false },
    nameBn: DataTypes.STRING(150),
    type: { type: DataTypes.ENUM(...ACCOUNT_TYPES), allowNull: false },
    subtype: { type: DataTypes.STRING(30), allowNull: false },
    isGroup: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    systemKey: DataTypes.STRING(40),
    isSystem: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    description: DataTypes.STRING(500),
  },
  { ...baseModelOptions, tableName: 'accounts' },
);

export const FiscalYear = sequelize.define(
  'FiscalYear',
  {
    ...idColumn,
    ...tenantColumns({ branch: false }),
    name: { type: DataTypes.STRING(60), allowNull: false },
    startDate: { type: DataTypes.DATEONLY, allowNull: false },
    endDate: { type: DataTypes.DATEONLY, allowNull: false },
    status: { type: DataTypes.ENUM('open', 'closed'), allowNull: false, defaultValue: 'open' },
    closingJournalId: id(),
    closedBy: id(),
    closedAt: DataTypes.DATE,
  },
  { ...baseModelOptions, tableName: 'fiscal_years' },
);

export const FiscalPeriod = sequelize.define(
  'FiscalPeriod',
  {
    ...idColumn,
    ...tenantColumns({ branch: false }),
    fiscalYearId: id(false),
    name: { type: DataTypes.STRING(40), allowNull: false },
    startDate: { type: DataTypes.DATEONLY, allowNull: false },
    endDate: { type: DataTypes.DATEONLY, allowNull: false },
    status: { type: DataTypes.ENUM('open', 'locked'), allowNull: false, defaultValue: 'open' },
    lockedBy: id(),
    lockedAt: DataTypes.DATE,
  },
  { ...baseModelOptions, tableName: 'fiscal_periods' },
);

export const JournalEntry = sequelize.define(
  'JournalEntry',
  {
    ...idColumn,
    ...tenantColumns(),
    number: { type: DataTypes.STRING(60), allowNull: false },
    entryDate: { type: DataTypes.DATEONLY, allowNull: false },
    entryType: { type: DataTypes.ENUM(...ENTRY_TYPES), allowNull: false, defaultValue: 'manual' },
    status: { type: DataTypes.ENUM(...JOURNAL_STATUSES), allowNull: false, defaultValue: 'draft' },
    sourceType: DataTypes.STRING(40),
    sourceId: id(),
    sourceNo: DataTypes.STRING(60),
    event: DataTypes.STRING(40),
    reference: DataTypes.STRING(100),
    narration: DataTypes.STRING(500),
    totalDebit: money(),
    totalCredit: money(),
    reversalOfId: id(),
    reversedById: id(),
    postedBy: id(),
    postedAt: DataTypes.DATE,
  },
  { ...baseModelOptions, tableName: 'journal_entries' },
);

export const JournalLine = sequelize.define(
  'JournalLine',
  {
    ...idColumn,
    companyId: id(false),
    journalId: id(false),
    branchId: id(),
    accountId: id(false),
    partyId: id(),
    debit: money(),
    credit: money(),
    description: DataTypes.STRING(255),
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    /** Bank reconciliation that cleared this line (cash / bank accounts only). */
    reconciliationId: id(),
    clearedDate: DataTypes.DATEONLY,
  },
  { tableName: 'journal_lines', underscored: true, timestamps: true },
);
