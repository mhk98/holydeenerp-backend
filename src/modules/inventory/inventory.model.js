import { DataTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { baseModelOptions, idColumn, money, quantity, tenantColumns } from '../../utils/model.js';

export const SERIAL_STATUSES = ['in_stock', 'in_transit', 'issued', 'damaged', 'scrapped', 'written_off'];
export const ADJUSTMENT_KINDS = ['opening', 'adjustment', 'damage', 'scrap'];
export const ADJUSTMENT_STATUSES = ['draft', 'pending_approval', 'posted', 'rejected', 'cancelled'];
export const TRANSFER_STATUSES = ['draft', 'in_transit', 'received', 'cancelled'];
export const COUNT_STATUSES = ['counting', 'pending_approval', 'posted', 'rejected', 'cancelled'];
export const ADJUSTMENT_REASONS = [
  'opening_balance',
  'found',
  'lost',
  'theft',
  'damaged',
  'expired',
  'scrap',
  'count_correction',
  'data_entry_error',
  'internal_use',
  'sample',
  'other',
];

/**
 * Movement types written to the ledger. Stored as text so later modules (purchase, sales,
 * production) can add their own without a migration.
 */
export const MOVEMENT_TYPES = [
  'opening',
  'adjustment_in',
  'adjustment_out',
  'damage',
  'scrap',
  'transfer_out',
  'transfer_in',
  'transfer_return',
  'count_gain',
  'count_loss',
  'purchase_receipt',
  'purchase_return',
  'sale',
  'sales_return',
  'production_issue',
  'production_return',
  'production_receipt',
  'production_byproduct',
];

/** JSON array kept in a TEXT column (MariaDB has no native JSON type). */
const jsonArray = (field) => ({
  type: DataTypes.TEXT,
  get() {
    const raw = this.getDataValue(field);
    return raw ? JSON.parse(raw) : [];
  },
  set(value) {
    this.setDataValue(field, value?.length ? JSON.stringify(value) : null);
  },
});

const workflowColumns = {
  submittedBy: DataTypes.BIGINT.UNSIGNED,
  submittedAt: DataTypes.DATE,
  approvedBy: DataTypes.BIGINT.UNSIGNED,
  approvedAt: DataTypes.DATE,
  rejectedBy: DataTypes.BIGINT.UNSIGNED,
  rejectedAt: DataTypes.DATE,
  rejectionReason: DataTypes.STRING(500),
  cancelledBy: DataTypes.BIGINT.UNSIGNED,
  cancelledAt: DataTypes.DATE,
};

export const StockBatch = sequelize.define(
  'StockBatch',
  {
    ...idColumn,
    companyId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    productId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    variantId: DataTypes.BIGINT.UNSIGNED,
    batchNo: { type: DataTypes.STRING(60), allowNull: false },
    mfgDate: DataTypes.DATEONLY,
    expiryDate: DataTypes.DATEONLY,
    createdBy: DataTypes.BIGINT.UNSIGNED,
  },
  { tableName: 'stock_batches', underscored: true, timestamps: true },
);

const immutable = () => {
  throw new Error('Stock movements are immutable; post a reversing movement instead');
};

/** The stock ledger. Rows are only ever inserted — corrections are new, opposite movements. */
export const StockMovement = sequelize.define(
  'StockMovement',
  {
    ...idColumn,
    companyId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    branchId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    warehouseId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    productId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    variantId: DataTypes.BIGINT.UNSIGNED,
    batchId: DataTypes.BIGINT.UNSIGNED,
    movementType: { type: DataTypes.STRING(30), allowNull: false },
    movementDate: { type: DataTypes.DATEONLY, allowNull: false },
    referenceType: { type: DataTypes.STRING(40), allowNull: false },
    referenceId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    referenceNo: DataTypes.STRING(60),
    referenceItemId: DataTypes.BIGINT.UNSIGNED,
    quantity: quantity(),
    unitCost: money(),
    totalCost: money(),
    balanceQuantity: quantity(),
    balanceValue: money(),
    notes: DataTypes.STRING(500),
    createdBy: DataTypes.BIGINT.UNSIGNED,
  },
  {
    tableName: 'stock_movements',
    underscored: true,
    timestamps: true,
    updatedAt: false,
    hooks: {
      beforeUpdate: immutable,
      beforeBulkUpdate: immutable,
      beforeDestroy: immutable,
      beforeBulkDestroy: immutable,
    },
  },
);

/** Current quantity and value of one item in one warehouse (derived from the ledger). */
export const StockBalance = sequelize.define(
  'StockBalance',
  {
    ...idColumn,
    companyId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    branchId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    warehouseId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    productId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    variantId: DataTypes.BIGINT.UNSIGNED,
    quantity: quantity(),
    avgCost: money(),
    totalValue: money(),
    lastMovementAt: DataTypes.DATE,
    lastIssueAt: DataTypes.DATE,
  },
  { tableName: 'stock_balances', underscored: true, timestamps: true },
);

/** A receipt still (partly) on hand: FIFO cost layer and batch quantity holder. */
export const StockLayer = sequelize.define(
  'StockLayer',
  {
    ...idColumn,
    companyId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    warehouseId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    productId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    variantId: DataTypes.BIGINT.UNSIGNED,
    batchId: DataTypes.BIGINT.UNSIGNED,
    movementId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    receivedAt: { type: DataTypes.DATE, allowNull: false },
    quantity: quantity(),
    remaining: quantity(),
    unitCost: money(),
  },
  { tableName: 'stock_layers', underscored: true, timestamps: true },
);

export const StockSerial = sequelize.define(
  'StockSerial',
  {
    ...idColumn,
    companyId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    productId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    variantId: DataTypes.BIGINT.UNSIGNED,
    batchId: DataTypes.BIGINT.UNSIGNED,
    warehouseId: DataTypes.BIGINT.UNSIGNED,
    serialNo: { type: DataTypes.STRING(100), allowNull: false },
    status: { type: DataTypes.ENUM(...SERIAL_STATUSES), allowNull: false, defaultValue: 'in_stock' },
    unitCost: money(),
  },
  { tableName: 'stock_serials', underscored: true, timestamps: true },
);

export const StockMovementSerial = sequelize.define(
  'StockMovementSerial',
  {
    movementId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    serialId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
  },
  { tableName: 'stock_movement_serials', underscored: true, timestamps: false },
);

export const StockAdjustment = sequelize.define(
  'StockAdjustment',
  {
    ...idColumn,
    ...tenantColumns(),
    branchId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    warehouseId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    number: { type: DataTypes.STRING(60), allowNull: false },
    kind: { type: DataTypes.ENUM(...ADJUSTMENT_KINDS), allowNull: false },
    adjustmentDate: { type: DataTypes.DATEONLY, allowNull: false },
    reason: DataTypes.STRING(40),
    status: { type: DataTypes.ENUM(...ADJUSTMENT_STATUSES), allowNull: false, defaultValue: 'draft' },
    notes: DataTypes.TEXT,
    totalValue: money(),
    ...workflowColumns,
  },
  { ...baseModelOptions, tableName: 'stock_adjustments' },
);

export const StockAdjustmentItem = sequelize.define(
  'StockAdjustmentItem',
  {
    ...idColumn,
    adjustmentId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    productId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    variantId: DataTypes.BIGINT.UNSIGNED,
    direction: { type: DataTypes.ENUM('in', 'out'), allowNull: false },
    batchId: DataTypes.BIGINT.UNSIGNED,
    batchNo: DataTypes.STRING(60),
    mfgDate: DataTypes.DATEONLY,
    expiryDate: DataTypes.DATEONLY,
    unitId: DataTypes.BIGINT.UNSIGNED,
    unitFactor: { type: DataTypes.DECIMAL(18, 6), allowNull: false, defaultValue: '1' },
    quantity: quantity(),
    baseQuantity: quantity(),
    unitCost: money(),
    totalCost: money(),
    reason: DataTypes.STRING(40),
    serialNumbers: jsonArray('serialNumbers'),
    notes: DataTypes.STRING(500),
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  { tableName: 'stock_adjustment_items', underscored: true, timestamps: true },
);

export const StockTransfer = sequelize.define(
  'StockTransfer',
  {
    ...idColumn,
    ...tenantColumns(),
    branchId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    number: { type: DataTypes.STRING(60), allowNull: false },
    transferDate: { type: DataTypes.DATEONLY, allowNull: false },
    fromWarehouseId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    toBranchId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    toWarehouseId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    status: { type: DataTypes.ENUM(...TRANSFER_STATUSES), allowNull: false, defaultValue: 'draft' },
    notes: DataTypes.TEXT,
    totalValue: money(),
    dispatchedBy: DataTypes.BIGINT.UNSIGNED,
    dispatchedAt: DataTypes.DATE,
    receivedBy: DataTypes.BIGINT.UNSIGNED,
    receivedAt: DataTypes.DATE,
    cancelledBy: DataTypes.BIGINT.UNSIGNED,
    cancelledAt: DataTypes.DATE,
  },
  { ...baseModelOptions, tableName: 'stock_transfers' },
);

export const StockTransferItem = sequelize.define(
  'StockTransferItem',
  {
    ...idColumn,
    transferId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    productId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    variantId: DataTypes.BIGINT.UNSIGNED,
    batchId: DataTypes.BIGINT.UNSIGNED,
    unitId: DataTypes.BIGINT.UNSIGNED,
    unitFactor: { type: DataTypes.DECIMAL(18, 6), allowNull: false, defaultValue: '1' },
    quantity: quantity(),
    baseQuantity: quantity(),
    unitCost: money(),
    totalCost: money(),
    serialNumbers: jsonArray('serialNumbers'),
    notes: DataTypes.STRING(500),
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  { tableName: 'stock_transfer_items', underscored: true, timestamps: true },
);

export const StockCount = sequelize.define(
  'StockCount',
  {
    ...idColumn,
    ...tenantColumns(),
    branchId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    warehouseId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    number: { type: DataTypes.STRING(60), allowNull: false },
    countDate: { type: DataTypes.DATEONLY, allowNull: false },
    categoryId: DataTypes.BIGINT.UNSIGNED,
    includeZero: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    status: { type: DataTypes.ENUM(...COUNT_STATUSES), allowNull: false, defaultValue: 'counting' },
    notes: DataTypes.TEXT,
    varianceValue: money(),
    ...workflowColumns,
  },
  { ...baseModelOptions, tableName: 'stock_counts' },
);

export const StockCountItem = sequelize.define(
  'StockCountItem',
  {
    ...idColumn,
    countId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    productId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    variantId: DataTypes.BIGINT.UNSIGNED,
    batchId: DataTypes.BIGINT.UNSIGNED,
    systemQuantity: quantity(),
    countedQuantity: quantity({ allowNull: true, defaultValue: null }),
    varianceQuantity: quantity(),
    unitCost: money(),
    varianceValue: money(),
    notes: DataTypes.STRING(500),
  },
  { tableName: 'stock_count_items', underscored: true, timestamps: true },
);
