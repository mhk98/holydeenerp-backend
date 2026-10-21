import { DataTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { baseModelOptions, idColumn, money, quantity, tenantColumns } from '../../utils/model.js';

export const DISCOUNT_TYPES = ['percent', 'amount'];
export const QUOTATION_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'converted', 'cancelled'];
export const ORDER_STATUSES = [
  'draft',
  'confirmed',
  'partially_delivered',
  'delivered',
  'invoiced',
  'closed',
  'cancelled',
];
export const CHALLAN_STATUSES = ['draft', 'posted', 'cancelled'];
export const INVOICE_STATUSES = ['draft', 'unpaid', 'partially_paid', 'paid', 'cancelled'];
export const RECEIPT_STATUSES = ['posted', 'void'];
export const RETURN_TYPES = ['return', 'credit_note'];
export const RETURN_STATUSES = ['draft', 'posted', 'cancelled'];
export const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'];

const id = (allowNull = true) => ({ type: DataTypes.BIGINT.UNSIGNED, allowNull });
const discountType = { type: DataTypes.ENUM(...DISCOUNT_TYPES), allowNull: false, defaultValue: 'percent' };

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
  unitFactor: { type: DataTypes.DECIMAL(18, 6), allowNull: false, defaultValue: '1' },
  quantity: quantity(),
  baseQuantity: quantity(),
};
const price = {
  unitPrice: money(),
  discountType,
  discountValue: money(),
  discountAmount: money(),
  documentDiscount: money(),
  taxGroupId: id(),
  priceIncludesTax: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  taxAmount: money(),
  lineSubtotal: money(),
  lineTotal: money(),
};
const totals = {
  discountType,
  discountValue: money(),
  subtotal: money(),
  discountTotal: money(),
  taxTotal: money(),
  roundOff: money(),
  total: money(),
};
const lineMeta = {
  notes: DataTypes.STRING(500),
  sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
};
const lineOptions = (tableName) => ({ tableName, underscored: true, timestamps: true });
const doc = {
  ...idColumn,
  ...tenantColumns(),
  branchId: id(false),
  customerId: id(false),
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

export const PriceList = sequelize.define(
  'PriceList',
  {
    ...idColumn,
    ...tenantColumns({ branch: false }),
    name: { type: DataTypes.STRING(150), allowNull: false },
    code: { type: DataTypes.STRING(30), allowNull: false },
    customerGroupId: id(),
    validFrom: DataTypes.DATEONLY,
    validTo: DataTypes.DATEONLY,
    priority: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    notes: DataTypes.STRING(500),
  },
  { ...baseModelOptions, tableName: 'price_lists' },
);

export const PriceListItem = sequelize.define(
  'PriceListItem',
  {
    ...idColumn,
    priceListId: id(false),
    productId: id(false),
    variantId: id(),
    unitId: id(),
    price: money({ allowNull: true, defaultValue: null }),
    discountPercent: { type: DataTypes.DECIMAL(7, 4), allowNull: true },
    minQuantity: quantity(),
  },
  lineOptions('price_list_items'),
);

export const SalesQuotation = sequelize.define(
  'SalesQuotation',
  {
    ...doc,
    quotationDate: { type: DataTypes.DATEONLY, allowNull: false },
    validUntil: DataTypes.DATEONLY,
    status: { type: DataTypes.ENUM(...QUOTATION_STATUSES), allowNull: false, defaultValue: 'draft' },
    customerReference: DataTypes.STRING(100),
    ...totals,
    terms: DataTypes.TEXT,
    sentAt: DataTypes.DATE,
  },
  { ...baseModelOptions, tableName: 'sales_quotations' },
);

export const SalesQuotationItem = sequelize.define(
  'SalesQuotationItem',
  { ...idColumn, quotationId: id(false), ...item, ...price, ...lineMeta },
  lineOptions('sales_quotation_items'),
);

export const SalesOrder = sequelize.define(
  'SalesOrder',
  {
    ...doc,
    warehouseId: id(false),
    quotationId: id(),
    orderDate: { type: DataTypes.DATEONLY, allowNull: false },
    deliveryDate: DataTypes.DATEONLY,
    paymentTermsDays: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    customerReference: DataTypes.STRING(100),
    shippingAddress: DataTypes.STRING(500),
    status: { type: DataTypes.ENUM(...ORDER_STATUSES), allowNull: false, defaultValue: 'draft' },
    ...totals,
    terms: DataTypes.TEXT,
    ...by('confirmed', 'closed', 'cancelled'),
  },
  { ...baseModelOptions, tableName: 'sales_orders' },
);

export const SalesOrderItem = sequelize.define(
  'SalesOrderItem',
  {
    ...idColumn,
    orderId: id(false),
    ...item,
    ...price,
    deliveredBaseQuantity: quantity(),
    invoicedBaseQuantity: quantity(),
    ...lineMeta,
  },
  lineOptions('sales_order_items'),
);

export const DeliveryChallan = sequelize.define(
  'DeliveryChallan',
  {
    ...doc,
    warehouseId: id(false),
    orderId: id(),
    challanDate: { type: DataTypes.DATEONLY, allowNull: false },
    shippingAddress: DataTypes.STRING(500),
    vehicleNo: DataTypes.STRING(50),
    driverName: DataTypes.STRING(100),
    status: { type: DataTypes.ENUM(...CHALLAN_STATUSES), allowNull: false, defaultValue: 'draft' },
    costTotal: money(),
    ...by('posted', 'cancelled'),
  },
  { ...baseModelOptions, tableName: 'delivery_challans' },
);

export const DeliveryChallanItem = sequelize.define(
  'DeliveryChallanItem',
  {
    ...idColumn,
    challanId: id(false),
    orderItemId: id(),
    ...item,
    batchId: id(),
    serialNumbers: json('serialNumbers', []),
    unitCost: money(),
    invoicedBaseQuantity: quantity(),
    returnedBaseQuantity: quantity(),
    ...lineMeta,
  },
  lineOptions('delivery_challan_items'),
);

export const SalesInvoice = sequelize.define(
  'SalesInvoice',
  {
    ...doc,
    warehouseId: id(),
    orderId: id(),
    challanId: id(),
    quotationId: id(),
    recurringId: id(),
    invoiceDate: { type: DataTypes.DATEONLY, allowNull: false },
    dueDate: { type: DataTypes.DATEONLY, allowNull: false },
    customerReference: DataTypes.STRING(100),
    status: { type: DataTypes.ENUM(...INVOICE_STATUSES), allowNull: false, defaultValue: 'draft' },
    ...totals,
    paidAmount: money(),
    costTotal: money(),
    terms: DataTypes.TEXT,
    ...by('posted', 'cancelled'),
    emailedAt: DataTypes.DATE,
    lastReminderAt: DataTypes.DATE,
    // Point of sale
    channel: { type: DataTypes.ENUM('backoffice', 'pos'), allowNull: false, defaultValue: 'backoffice' },
    posSessionId: id(),
    clientUuid: DataTypes.STRING(36),
    offlineNumber: DataTypes.STRING(40),
    tendered: money(),
    changeAmount: money(),
    stockWarning: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  { ...baseModelOptions, tableName: 'sales_invoices' },
);

export const SalesInvoiceItem = sequelize.define(
  'SalesInvoiceItem',
  {
    ...idColumn,
    invoiceId: id(false),
    orderItemId: id(),
    challanItemId: id(),
    ...item,
    ...price,
    batchId: id(),
    serialNumbers: json('serialNumbers', []),
    unitCost: money(),
    returnedBaseQuantity: quantity(),
    ...lineMeta,
  },
  lineOptions('sales_invoice_items'),
);

export const CustomerReceipt = sequelize.define(
  'CustomerReceipt',
  {
    ...doc,
    paymentMethodId: id(false),
    receiptDate: { type: DataTypes.DATEONLY, allowNull: false },
    amount: money(),
    allocatedAmount: money(),
    reference: DataTypes.STRING(100),
    status: { type: DataTypes.ENUM(...RECEIPT_STATUSES), allowNull: false, defaultValue: 'posted' },
    ...by('voided'),
    voidReason: DataTypes.STRING(500),
    posSessionId: id(),
  },
  { ...baseModelOptions, tableName: 'customer_receipts' },
);

export const SalesReturn = sequelize.define(
  'SalesReturn',
  {
    ...doc,
    warehouseId: id(),
    invoiceId: id(),
    returnDate: { type: DataTypes.DATEONLY, allowNull: false },
    type: { type: DataTypes.ENUM(...RETURN_TYPES), allowNull: false },
    reason: DataTypes.STRING(255),
    status: { type: DataTypes.ENUM(...RETURN_STATUSES), allowNull: false, defaultValue: 'draft' },
    ...totals,
    appliedAmount: money(),
    ...by('posted', 'cancelled'),
    posSessionId: id(),
    /** Paid back to the customer (POS refund); the rest of the credit stays on account. */
    refundedAmount: money(),
    refundMethodId: id(),
  },
  { ...baseModelOptions, tableName: 'sales_returns' },
);

export const SalesReturnItem = sequelize.define(
  'SalesReturnItem',
  {
    ...idColumn,
    returnId: id(false),
    invoiceItemId: id(),
    ...item,
    ...price,
    batchId: id(),
    serialNumbers: json('serialNumbers', []),
    unitCost: money(),
    ...lineMeta,
  },
  lineOptions('sales_return_items'),
);

export const ReceivableAllocation = sequelize.define(
  'ReceivableAllocation',
  {
    ...idColumn,
    companyId: id(false),
    invoiceId: id(false),
    sourceType: { type: DataTypes.ENUM('receipt', 'credit_note'), allowNull: false },
    sourceId: id(false),
    amount: money(),
    createdBy: id(),
  },
  { tableName: 'receivable_allocations', underscored: true, timestamps: true, updatedAt: false },
);

export const CreditOverride = sequelize.define(
  'CreditOverride',
  {
    ...idColumn,
    companyId: id(false),
    customerId: id(false),
    documentType: { type: DataTypes.STRING(30), allowNull: false },
    documentId: id(false),
    creditLimit: money(),
    outstanding: money(),
    documentAmount: money(),
    reason: { type: DataTypes.STRING(500), allowNull: false },
    userId: id(),
  },
  { tableName: 'credit_overrides', underscored: true, timestamps: true, updatedAt: false },
);

export const RecurringInvoice = sequelize.define(
  'RecurringInvoice',
  {
    ...idColumn,
    ...tenantColumns(),
    branchId: id(false),
    customerId: id(false),
    name: { type: DataTypes.STRING(150), allowNull: false },
    sourceInvoiceId: id(),
    /** The invoice payload (lines, discount, terms) each run creates. */
    template: json('template', null),
    frequency: { type: DataTypes.ENUM(...FREQUENCIES), allowNull: false },
    intervalCount: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 1 },
    nextRunDate: { type: DataTypes.DATEONLY, allowNull: false },
    endDate: DataTypes.DATEONLY,
    autoPost: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    autoEmail: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    lastRunAt: DataTypes.DATE,
    lastInvoiceId: id(),
    runsCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    lastError: DataTypes.STRING(500),
  },
  { ...baseModelOptions, tableName: 'recurring_invoices' },
);

export const PaymentReminder = sequelize.define(
  'PaymentReminder',
  {
    ...idColumn,
    companyId: id(false),
    invoiceId: id(false),
    kind: { type: DataTypes.ENUM('manual', 'before_due', 'after_due'), allowNull: false },
    offsetDays: DataTypes.SMALLINT,
    sentTo: { type: DataTypes.STRING(500), allowNull: false },
    status: { type: DataTypes.ENUM('sent', 'failed'), allowNull: false },
    error: DataTypes.STRING(500),
    userId: id(),
  },
  { tableName: 'payment_reminders', underscored: true, timestamps: true, updatedAt: false },
);
