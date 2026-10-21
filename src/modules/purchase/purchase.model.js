import { DataTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { baseModelOptions, idColumn, money, quantity, tenantColumns } from '../../utils/model.js';

export const REQUISITION_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'ordered',
  'cancelled',
];
export const RFQ_STATUSES = ['draft', 'sent', 'awarded', 'cancelled'];
export const RFQ_SUPPLIER_STATUSES = ['invited', 'quoted', 'declined', 'awarded'];
export const PO_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'partially_received',
  'received',
  'billed',
  'closed',
  'cancelled',
];
export const RECEIPT_STATUSES = ['draft', 'posted', 'cancelled'];
export const LANDED_COST_TYPES = ['freight', 'duty', 'insurance', 'handling', 'other'];
export const BILL_STATUSES = ['draft', 'unpaid', 'partially_paid', 'paid', 'cancelled'];
export const PAYMENT_STATUSES = ['posted', 'void'];
export const RETURN_TYPES = ['return', 'debit_note'];
export const RETURN_STATUSES = ['draft', 'posted', 'cancelled'];

const id = (allowNull = true) => ({ type: DataTypes.BIGINT.UNSIGNED, allowNull });
const factor = { type: DataTypes.DECIMAL(18, 6), allowNull: false, defaultValue: '1' };
const percent = { type: DataTypes.DECIMAL(7, 4), allowNull: false, defaultValue: '0' };

/** JSON kept in a TEXT column (MariaDB has no native JSON type). */
const json = (field, fallback) => ({
  type: DataTypes.TEXT,
  get() {
    const raw = this.getDataValue(field);
    return raw ? JSON.parse(raw) : fallback;
  },
  set(value) {
    this.setDataValue(
      field,
      value == null || (Array.isArray(value) && !value.length) ? null : JSON.stringify(value),
    );
  },
});

const item = {
  productId: id(false),
  variantId: id(),
  unitId: id(),
  unitFactor: factor,
  quantity: quantity(),
  baseQuantity: quantity(),
};
const price = {
  unitPrice: money(),
  discountPercent: percent,
  taxGroupId: id(),
  taxAmount: money(),
  lineSubtotal: money(),
  lineTotal: money(),
};
const totals = { subtotal: money(), discountTotal: money(), taxTotal: money(), total: money() };
const lineMeta = {
  notes: DataTypes.STRING(500),
  sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
};
const lineOptions = (tableName) => ({ tableName, underscored: true, timestamps: true });
const doc = {
  ...idColumn,
  ...tenantColumns(),
  branchId: id(false),
  number: { type: DataTypes.STRING(60), allowNull: false },
  notes: DataTypes.TEXT,
};
const by = (...names) =>
  Object.fromEntries(
    names.flatMap((n) => [
      [`${n}By`, id()],
      [`${n}At`, DataTypes.DATE],
    ]),
  );

export const PurchaseRequisition = sequelize.define(
  'PurchaseRequisition',
  {
    ...doc,
    warehouseId: id(),
    requisitionDate: { type: DataTypes.DATEONLY, allowNull: false },
    requiredBy: DataTypes.DATEONLY,
    status: { type: DataTypes.ENUM(...REQUISITION_STATUSES), allowNull: false, defaultValue: 'draft' },
    ...by('submitted', 'approved', 'rejected', 'cancelled'),
    rejectionReason: DataTypes.STRING(500),
  },
  { ...baseModelOptions, tableName: 'purchase_requisitions' },
);

export const PurchaseRequisitionItem = sequelize.define(
  'PurchaseRequisitionItem',
  {
    ...idColumn,
    requisitionId: id(false),
    ...item,
    estimatedPrice: money({ allowNull: true, defaultValue: null }),
    ...lineMeta,
  },
  lineOptions('purchase_requisition_items'),
);

export const PurchaseRfq = sequelize.define(
  'PurchaseRfq',
  {
    ...doc,
    requisitionId: id(),
    rfqDate: { type: DataTypes.DATEONLY, allowNull: false },
    quoteDeadline: DataTypes.DATEONLY,
    status: { type: DataTypes.ENUM(...RFQ_STATUSES), allowNull: false, defaultValue: 'draft' },
    sentAt: DataTypes.DATE,
    ...by('awarded'),
  },
  { ...baseModelOptions, tableName: 'purchase_rfqs' },
);

export const PurchaseRfqItem = sequelize.define(
  'PurchaseRfqItem',
  { ...idColumn, rfqId: id(false), requisitionItemId: id(), ...item, ...lineMeta },
  lineOptions('purchase_rfq_items'),
);

export const PurchaseRfqSupplier = sequelize.define(
  'PurchaseRfqSupplier',
  {
    ...idColumn,
    rfqId: id(false),
    supplierId: id(false),
    status: { type: DataTypes.ENUM(...RFQ_SUPPLIER_STATUSES), allowNull: false, defaultValue: 'invited' },
    quoteDate: DataTypes.DATEONLY,
    validUntil: DataTypes.DATEONLY,
    deliveryDays: DataTypes.SMALLINT.UNSIGNED,
    total: money(),
    notes: DataTypes.STRING(500),
  },
  lineOptions('purchase_rfq_suppliers'),
);

export const PurchaseRfqQuote = sequelize.define(
  'PurchaseRfqQuote',
  {
    ...idColumn,
    rfqSupplierId: id(false),
    rfqItemId: id(false),
    unitPrice: money(),
    discountPercent: percent,
    taxGroupId: id(),
    notes: DataTypes.STRING(255),
  },
  lineOptions('purchase_rfq_quotes'),
);

export const PurchaseOrder = sequelize.define(
  'PurchaseOrder',
  {
    ...doc,
    warehouseId: id(false),
    supplierId: id(false),
    requisitionId: id(),
    rfqId: id(),
    orderDate: { type: DataTypes.DATEONLY, allowNull: false },
    expectedDate: DataTypes.DATEONLY,
    paymentTermsDays: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    supplierReference: DataTypes.STRING(100),
    status: { type: DataTypes.ENUM(...PO_STATUSES), allowNull: false, defaultValue: 'draft' },
    /** Approval levels required when the order was submitted: [{ level, name, minAmount, roleId }]. */
    approvalPlan: json('approvalPlan', []),
    approvalLevel: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    ...totals,
    terms: DataTypes.TEXT,
    ...by('submitted', 'rejected', 'closed', 'cancelled'),
    approvedAt: DataTypes.DATE,
    rejectionReason: DataTypes.STRING(500),
    emailedAt: DataTypes.DATE,
  },
  { ...baseModelOptions, tableName: 'purchase_orders' },
);

export const PurchaseOrderItem = sequelize.define(
  'PurchaseOrderItem',
  {
    ...idColumn,
    orderId: id(false),
    requisitionItemId: id(),
    ...item,
    ...price,
    receivedBaseQuantity: quantity(),
    billedBaseQuantity: quantity(),
    ...lineMeta,
  },
  lineOptions('purchase_order_items'),
);

export const PurchaseApproval = sequelize.define(
  'PurchaseApproval',
  {
    ...idColumn,
    companyId: id(false),
    documentType: { type: DataTypes.STRING(30), allowNull: false },
    documentId: id(false),
    level: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
    levelName: DataTypes.STRING(100),
    action: { type: DataTypes.ENUM('approved', 'rejected'), allowNull: false },
    userId: id(),
    note: DataTypes.STRING(500),
  },
  { tableName: 'purchase_approvals', underscored: true, timestamps: true, updatedAt: false },
);

export const GoodsReceipt = sequelize.define(
  'GoodsReceipt',
  {
    ...doc,
    warehouseId: id(false),
    supplierId: id(false),
    orderId: id(),
    receiptDate: { type: DataTypes.DATEONLY, allowNull: false },
    supplierReference: DataTypes.STRING(100),
    status: { type: DataTypes.ENUM(...RECEIPT_STATUSES), allowNull: false, defaultValue: 'draft' },
    goodsValue: money(),
    landedCostTotal: money(),
    totalCost: money(),
    ...by('posted', 'cancelled'),
  },
  { ...baseModelOptions, tableName: 'goods_receipts' },
);

export const GoodsReceiptItem = sequelize.define(
  'GoodsReceiptItem',
  {
    ...idColumn,
    receiptId: id(false),
    orderItemId: id(),
    ...item,
    unitPrice: money(),
    taxGroupId: id(),
    lineValue: money(),
    landedCost: money(),
    unitCost: money(),
    batchId: id(),
    batchNo: DataTypes.STRING(60),
    mfgDate: DataTypes.DATEONLY,
    expiryDate: DataTypes.DATEONLY,
    serialNumbers: json('serialNumbers', []),
    billedBaseQuantity: quantity(),
    returnedBaseQuantity: quantity(),
    ...lineMeta,
  },
  lineOptions('goods_receipt_items'),
);

export const GoodsReceiptCost = sequelize.define(
  'GoodsReceiptCost',
  {
    ...idColumn,
    receiptId: id(false),
    costType: { type: DataTypes.ENUM(...LANDED_COST_TYPES), allowNull: false },
    description: DataTypes.STRING(255),
    amount: money(),
    allocation: { type: DataTypes.ENUM('value', 'quantity'), allowNull: false, defaultValue: 'value' },
  },
  lineOptions('goods_receipt_costs'),
);

export const SupplierBill = sequelize.define(
  'SupplierBill',
  {
    ...doc,
    supplierId: id(false),
    orderId: id(),
    receiptId: id(),
    supplierInvoiceNo: DataTypes.STRING(100),
    billDate: { type: DataTypes.DATEONLY, allowNull: false },
    dueDate: { type: DataTypes.DATEONLY, allowNull: false },
    status: { type: DataTypes.ENUM(...BILL_STATUSES), allowNull: false, defaultValue: 'draft' },
    ...totals,
    paidAmount: money(),
    ...by('posted', 'cancelled'),
  },
  { ...baseModelOptions, tableName: 'supplier_bills' },
);

export const SupplierBillItem = sequelize.define(
  'SupplierBillItem',
  { ...idColumn, billId: id(false), orderItemId: id(), receiptItemId: id(), ...item, ...price, ...lineMeta },
  lineOptions('supplier_bill_items'),
);

export const SupplierPayment = sequelize.define(
  'SupplierPayment',
  {
    ...doc,
    supplierId: id(false),
    paymentMethodId: id(false),
    paymentDate: { type: DataTypes.DATEONLY, allowNull: false },
    amount: money(),
    allocatedAmount: money(),
    reference: DataTypes.STRING(100),
    status: { type: DataTypes.ENUM(...PAYMENT_STATUSES), allowNull: false, defaultValue: 'posted' },
    ...by('voided'),
    voidReason: DataTypes.STRING(500),
  },
  { ...baseModelOptions, tableName: 'supplier_payments' },
);

export const PurchaseReturn = sequelize.define(
  'PurchaseReturn',
  {
    ...doc,
    warehouseId: id(),
    supplierId: id(false),
    receiptId: id(),
    billId: id(),
    returnDate: { type: DataTypes.DATEONLY, allowNull: false },
    type: { type: DataTypes.ENUM(...RETURN_TYPES), allowNull: false },
    reason: DataTypes.STRING(255),
    status: { type: DataTypes.ENUM(...RETURN_STATUSES), allowNull: false, defaultValue: 'draft' },
    ...totals,
    appliedAmount: money(),
    ...by('posted', 'cancelled'),
  },
  { ...baseModelOptions, tableName: 'purchase_returns' },
);

export const PurchaseReturnItem = sequelize.define(
  'PurchaseReturnItem',
  {
    ...idColumn,
    returnId: id(false),
    receiptItemId: id(),
    billItemId: id(),
    ...item,
    batchId: id(),
    serialNumbers: json('serialNumbers', []),
    ...price,
    stockCost: money(),
    ...lineMeta,
  },
  lineOptions('purchase_return_items'),
);

export const PayableAllocation = sequelize.define(
  'PayableAllocation',
  {
    ...idColumn,
    companyId: id(false),
    billId: id(false),
    sourceType: { type: DataTypes.ENUM('payment', 'debit_note'), allowNull: false },
    sourceId: id(false),
    amount: money(),
    createdBy: id(),
  },
  { tableName: 'payable_allocations', underscored: true, timestamps: true, updatedAt: false },
);
