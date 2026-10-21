import { DataTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { baseModelOptions, idColumn, money, tenantColumns } from '../../utils/model.js';

export const SESSION_STATUSES = ['open', 'closed'];
export const RECEIPT_PAPERS = ['thermal_80', 'a4'];

const id = (allowNull = true) => ({ type: DataTypes.BIGINT.UNSIGNED, allowNull });

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

/** A counter / till: sells from one warehouse of one branch. */
export const PosRegister = sequelize.define(
  'PosRegister',
  {
    ...idColumn,
    ...tenantColumns(),
    branchId: id(false),
    warehouseId: id(false),
    name: { type: DataTypes.STRING(100), allowNull: false },
    code: { type: DataTypes.STRING(30), allowNull: false },
    defaultCustomerId: id(),
    receiptPaper: { type: DataTypes.ENUM(...RECEIPT_PAPERS), allowNull: false, defaultValue: 'thermal_80' },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    notes: DataTypes.STRING(500),
  },
  { ...baseModelOptions, tableName: 'pos_registers' },
);

/** A cashier's shift on a register: opening float → sales, cash in/out → counted close (Z report). */
export const PosSession = sequelize.define(
  'PosSession',
  {
    ...idColumn,
    ...tenantColumns(),
    branchId: id(false),
    registerId: id(false),
    number: { type: DataTypes.STRING(60), allowNull: false },
    status: { type: DataTypes.ENUM(...SESSION_STATUSES), allowNull: false, defaultValue: 'open' },
    openedBy: id(),
    openedAt: { type: DataTypes.DATE, allowNull: false },
    openingCash: money(),
    openingNotes: DataTypes.STRING(500),
    closedBy: id(),
    closedAt: DataTypes.DATE,
    expectedCash: money(),
    countedCash: money(),
    variance: money(),
    denominations: json('denominations', null),
    closingNotes: DataTypes.STRING(500),
    summary: json('summary', null),
  },
  { ...baseModelOptions, tableName: 'pos_sessions' },
);

export const PosCashMovement = sequelize.define(
  'PosCashMovement',
  {
    ...idColumn,
    ...tenantColumns({ branch: false }),
    sessionId: id(false),
    type: { type: DataTypes.ENUM('in', 'out'), allowNull: false },
    amount: money(),
    reason: { type: DataTypes.STRING(255), allowNull: false },
  },
  { ...baseModelOptions, tableName: 'pos_cash_movements' },
);

/** A parked cart, recalled later on any register of the branch. */
export const PosHeldOrder = sequelize.define(
  'PosHeldOrder',
  {
    ...idColumn,
    ...tenantColumns(),
    branchId: id(false),
    registerId: id(false),
    label: { type: DataTypes.STRING(100), allowNull: false },
    customerId: id(),
    cart: json('cart', null),
    total: money(),
  },
  { ...baseModelOptions, tableName: 'pos_held_orders' },
);
