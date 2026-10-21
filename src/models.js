/**
 * Model registry: every model is imported once and all associations are
 * declared here. Services import models from this file.
 */
import { Company } from './modules/companies/company.model.js';
import { Branch } from './modules/branches/branch.model.js';
import { User, UserRole, UserBranch } from './modules/users/user.model.js';
import { Role, Permission, RolePermission } from './modules/roles/role.model.js';
import { RefreshToken, LoginHistory } from './modules/auth/auth.model.js';
import { Warehouse } from './modules/warehouses/warehouse.model.js';
import { Currency, ExchangeRate } from './modules/currencies/currency.model.js';
import { TaxRate, TaxGroup, TaxGroupRate } from './modules/taxes/tax.model.js';
import { DocumentSequence } from './modules/sequences/sequence.model.js';
import { Unit, UnitConversion } from './modules/units/unit.model.js';
import { PaymentMethod } from './modules/payment-methods/payment-method.model.js';
import { Setting, PrintTemplate } from './modules/settings/setting.model.js';
import { Backup } from './modules/backups/backup.model.js';
import { ProductCategory } from './modules/categories/category.model.js';
import { Brand } from './modules/brands/brand.model.js';
import { ProductAttribute, ProductAttributeValue } from './modules/attributes/attribute.model.js';
import {
  Product,
  ProductUnit,
  ProductVariant,
  ProductVariantValue,
  ProductImage,
} from './modules/products/product.model.js';
import { Party, PartyGroup, PartyAddress } from './modules/parties/party.model.js';
import {
  StockAdjustment,
  StockAdjustmentItem,
  StockBalance,
  StockBatch,
  StockCount,
  StockCountItem,
  StockLayer,
  StockMovement,
  StockMovementSerial,
  StockSerial,
  StockTransfer,
  StockTransferItem,
} from './modules/inventory/inventory.model.js';
import {
  GoodsReceipt,
  GoodsReceiptCost,
  GoodsReceiptItem,
  PayableAllocation,
  PurchaseApproval,
  PurchaseOrder,
  PurchaseOrderItem,
  PurchaseRequisition,
  PurchaseRequisitionItem,
  PurchaseReturn,
  PurchaseReturnItem,
  PurchaseRfq,
  PurchaseRfqItem,
  PurchaseRfqQuote,
  PurchaseRfqSupplier,
  SupplierBill,
  SupplierBillItem,
  SupplierPayment,
} from './modules/purchase/purchase.model.js';
import {
  CreditOverride,
  CustomerReceipt,
  DeliveryChallan,
  DeliveryChallanItem,
  PaymentReminder,
  PriceList,
  PriceListItem,
  ReceivableAllocation,
  RecurringInvoice,
  SalesInvoice,
  SalesInvoiceItem,
  SalesOrder,
  SalesOrderItem,
  SalesQuotation,
  SalesQuotationItem,
  SalesReturn,
  SalesReturnItem,
} from './modules/sales/sales.model.js';
import { PosCashMovement, PosHeldOrder, PosRegister, PosSession } from './modules/pos/pos.model.js';
import {
  Account,
  FiscalPeriod,
  FiscalYear,
  JournalEntry,
  JournalLine,
} from './modules/accounting/accounting.model.js';
import {
  Attachment,
  BankAccount,
  BankReconciliation,
  BankStatementLine,
  Cheque,
  Expense,
  ExpenseCategory,
  Voucher,
  VoucherLine,
} from './modules/accounting/banking.model.js';
import {
  Bom,
  BomByproduct,
  BomComponent,
  BomOperation,
  BomQualityCheck,
  ManufacturingOrder,
  MoMaterial,
  MoOperation,
  MoOutput,
  MoScrap,
  QualityCheck,
  WorkCenter,
} from './modules/manufacturing/manufacturing.model.js';

// ── Auth & access ──────────────────────────────────────────────────────────
Company.hasMany(Branch, { foreignKey: 'companyId', as: 'branches' });
Branch.belongsTo(Company, { foreignKey: 'companyId', as: 'company' });

Company.hasMany(User, { foreignKey: 'companyId', as: 'users' });
User.belongsTo(Company, { foreignKey: 'companyId', as: 'company' });

User.belongsToMany(Role, { through: UserRole, foreignKey: 'userId', otherKey: 'roleId', as: 'roles' });
Role.belongsToMany(User, { through: UserRole, foreignKey: 'roleId', otherKey: 'userId', as: 'users' });

User.belongsToMany(Branch, {
  through: UserBranch,
  foreignKey: 'userId',
  otherKey: 'branchId',
  as: 'branches',
});
Branch.belongsToMany(User, { through: UserBranch, foreignKey: 'branchId', otherKey: 'userId', as: 'users' });

Role.belongsToMany(Permission, {
  through: RolePermission,
  foreignKey: 'roleId',
  otherKey: 'permissionId',
  as: 'permissions',
});
Permission.belongsToMany(Role, {
  through: RolePermission,
  foreignKey: 'permissionId',
  otherKey: 'roleId',
  as: 'roles',
});

User.hasMany(RefreshToken, { foreignKey: 'userId', as: 'refreshTokens' });
RefreshToken.belongsTo(User, { foreignKey: 'userId', as: 'user' });
User.hasMany(LoginHistory, { foreignKey: 'userId', as: 'loginHistory' });

// ── Settings ───────────────────────────────────────────────────────────────
Branch.hasMany(Warehouse, { foreignKey: 'branchId', as: 'warehouses' });
Warehouse.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });

Currency.hasMany(ExchangeRate, { foreignKey: 'currencyId', as: 'rates' });
ExchangeRate.belongsTo(Currency, { foreignKey: 'currencyId', as: 'currency' });

TaxGroup.belongsToMany(TaxRate, {
  through: TaxGroupRate,
  foreignKey: 'taxGroupId',
  otherKey: 'taxRateId',
  as: 'rates',
});
TaxRate.belongsToMany(TaxGroup, {
  through: TaxGroupRate,
  foreignKey: 'taxRateId',
  otherKey: 'taxGroupId',
  as: 'groups',
});

DocumentSequence.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });

UnitConversion.belongsTo(Unit, { foreignKey: 'fromUnitId', as: 'fromUnit' });
UnitConversion.belongsTo(Unit, { foreignKey: 'toUnitId', as: 'toUnit' });

Backup.belongsTo(User, { foreignKey: 'createdBy', as: 'creator' });

// ── Master data ────────────────────────────────────────────────────────────
ProductCategory.belongsTo(ProductCategory, { foreignKey: 'parentId', as: 'parent' });
ProductCategory.hasMany(ProductCategory, { foreignKey: 'parentId', as: 'children' });

ProductAttribute.hasMany(ProductAttributeValue, { foreignKey: 'attributeId', as: 'values' });
ProductAttributeValue.belongsTo(ProductAttribute, { foreignKey: 'attributeId', as: 'attribute' });

Product.belongsTo(ProductCategory, { foreignKey: 'categoryId', as: 'category' });
Product.belongsTo(Brand, { foreignKey: 'brandId', as: 'brand' });
Product.belongsTo(Unit, { foreignKey: 'baseUnitId', as: 'baseUnit' });
Product.belongsTo(TaxGroup, { foreignKey: 'taxGroupId', as: 'taxGroup' });
Product.hasMany(ProductUnit, { foreignKey: 'productId', as: 'units' });
Product.hasMany(ProductVariant, { foreignKey: 'productId', as: 'variants' });
Product.hasMany(ProductImage, { foreignKey: 'productId', as: 'images' });
ProductUnit.belongsTo(Unit, { foreignKey: 'unitId', as: 'unit' });
ProductUnit.belongsTo(Product, { foreignKey: 'productId', as: 'product' });
ProductVariant.belongsTo(Product, { foreignKey: 'productId', as: 'product' });
ProductVariant.belongsToMany(ProductAttributeValue, {
  through: ProductVariantValue,
  foreignKey: 'variantId',
  otherKey: 'attributeValueId',
  as: 'values',
});

Party.belongsTo(PartyGroup, { foreignKey: 'customerGroupId', as: 'customerGroup' });
Party.belongsTo(PartyGroup, { foreignKey: 'supplierGroupId', as: 'supplierGroup' });
Party.hasMany(PartyAddress, { foreignKey: 'partyId', as: 'addresses' });

// ── Inventory ──────────────────────────────────────────────────────────────
const itemRefs = (model) => {
  model.belongsTo(Product, { foreignKey: 'productId', as: 'product' });
  model.belongsTo(ProductVariant, { foreignKey: 'variantId', as: 'variant' });
};
for (const model of [
  StockBatch,
  StockBalance,
  StockMovement,
  StockLayer,
  StockSerial,
  StockAdjustmentItem,
  StockTransferItem,
  StockCountItem,
]) {
  itemRefs(model);
}
for (const model of [
  StockMovement,
  StockLayer,
  StockSerial,
  StockAdjustmentItem,
  StockTransferItem,
  StockCountItem,
]) {
  model.belongsTo(StockBatch, { foreignKey: 'batchId', as: 'batch' });
}
for (const model of [StockBalance, StockMovement, StockLayer, StockSerial, StockAdjustment, StockCount]) {
  model.belongsTo(Warehouse, { foreignKey: 'warehouseId', as: 'warehouse' });
}
StockMovement.belongsTo(User, { foreignKey: 'createdBy', as: 'creator' });
StockMovement.belongsToMany(StockSerial, {
  through: StockMovementSerial,
  foreignKey: 'movementId',
  otherKey: 'serialId',
  as: 'serials',
});
for (const model of [StockBalance, StockAdjustment, StockCount]) {
  model.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });
}
Product.hasMany(StockBalance, { foreignKey: 'productId', as: 'balances' });

StockAdjustment.hasMany(StockAdjustmentItem, { foreignKey: 'adjustmentId', as: 'items' });
StockAdjustmentItem.belongsTo(Unit, { foreignKey: 'unitId', as: 'unit' });
StockTransfer.hasMany(StockTransferItem, { foreignKey: 'transferId', as: 'items' });
StockTransferItem.belongsTo(Unit, { foreignKey: 'unitId', as: 'unit' });
StockTransfer.belongsTo(Warehouse, { foreignKey: 'fromWarehouseId', as: 'fromWarehouse' });
StockTransfer.belongsTo(Warehouse, { foreignKey: 'toWarehouseId', as: 'toWarehouse' });
StockTransfer.belongsTo(Branch, { foreignKey: 'branchId', as: 'fromBranch' });
StockTransfer.belongsTo(Branch, { foreignKey: 'toBranchId', as: 'toBranch' });
StockCount.hasMany(StockCountItem, { foreignKey: 'countId', as: 'items' });
StockCount.belongsTo(ProductCategory, { foreignKey: 'categoryId', as: 'category' });

// ── Purchase ───────────────────────────────────────────────────────────────
const lineItem = (model) => {
  model.belongsTo(Product, { foreignKey: 'productId', as: 'product' });
  model.belongsTo(ProductVariant, { foreignKey: 'variantId', as: 'variant' });
  model.belongsTo(Unit, { foreignKey: 'unitId', as: 'unit' });
};
for (const model of [
  PurchaseRequisitionItem,
  PurchaseRfqItem,
  PurchaseOrderItem,
  GoodsReceiptItem,
  SupplierBillItem,
  PurchaseReturnItem,
]) {
  lineItem(model);
}
for (const model of [
  PurchaseOrderItem,
  GoodsReceiptItem,
  SupplierBillItem,
  PurchaseReturnItem,
  PurchaseRfqQuote,
]) {
  model.belongsTo(TaxGroup, { foreignKey: 'taxGroupId', as: 'taxGroup' });
}
for (const model of [GoodsReceiptItem, PurchaseReturnItem]) {
  model.belongsTo(StockBatch, { foreignKey: 'batchId', as: 'batch' });
}
for (const model of [PurchaseOrder, GoodsReceipt, SupplierBill, SupplierPayment, PurchaseReturn]) {
  model.belongsTo(Party, { foreignKey: 'supplierId', as: 'supplier' });
}
for (const model of [
  PurchaseRequisition,
  PurchaseRfq,
  PurchaseOrder,
  GoodsReceipt,
  SupplierBill,
  SupplierPayment,
  PurchaseReturn,
]) {
  model.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });
  model.belongsTo(User, { foreignKey: 'createdBy', as: 'creator' });
}
for (const model of [PurchaseRequisition, PurchaseOrder, GoodsReceipt, PurchaseReturn]) {
  model.belongsTo(Warehouse, { foreignKey: 'warehouseId', as: 'warehouse' });
}
PurchaseRequisition.hasMany(PurchaseRequisitionItem, { foreignKey: 'requisitionId', as: 'items' });
for (const [key, as] of [
  ['submittedBy', 'submitter'],
  ['approvedBy', 'approver'],
  ['rejectedBy', 'rejecter'],
  ['cancelledBy', 'canceller'],
]) {
  PurchaseRequisition.belongsTo(User, { foreignKey: key, as });
}

PurchaseRfq.hasMany(PurchaseRfqItem, { foreignKey: 'rfqId', as: 'items' });
PurchaseRfq.hasMany(PurchaseRfqSupplier, { foreignKey: 'rfqId', as: 'suppliers' });
PurchaseRfq.belongsTo(PurchaseRequisition, { foreignKey: 'requisitionId', as: 'requisition' });
PurchaseRfq.belongsTo(User, { foreignKey: 'awardedBy', as: 'awarder' });
PurchaseRfqSupplier.belongsTo(Party, { foreignKey: 'supplierId', as: 'supplier' });
PurchaseRfqSupplier.hasMany(PurchaseRfqQuote, { foreignKey: 'rfqSupplierId', as: 'quotes' });

PurchaseOrder.hasMany(PurchaseOrderItem, { foreignKey: 'orderId', as: 'items' });
PurchaseOrder.belongsTo(PurchaseRequisition, { foreignKey: 'requisitionId', as: 'requisition' });
PurchaseOrder.belongsTo(PurchaseRfq, { foreignKey: 'rfqId', as: 'rfq' });
for (const [key, as] of [
  ['submittedBy', 'submitter'],
  ['rejectedBy', 'rejecter'],
  ['closedBy', 'closer'],
  ['cancelledBy', 'canceller'],
]) {
  PurchaseOrder.belongsTo(User, { foreignKey: key, as });
}
PurchaseApproval.belongsTo(User, { foreignKey: 'userId', as: 'user' });

GoodsReceipt.hasMany(GoodsReceiptItem, { foreignKey: 'receiptId', as: 'items' });
GoodsReceipt.hasMany(GoodsReceiptCost, { foreignKey: 'receiptId', as: 'costs' });
GoodsReceipt.belongsTo(PurchaseOrder, { foreignKey: 'orderId', as: 'order' });
GoodsReceipt.belongsTo(User, { foreignKey: 'postedBy', as: 'poster' });
GoodsReceiptItem.belongsTo(PurchaseOrderItem, { foreignKey: 'orderItemId', as: 'orderItem' });

SupplierBill.hasMany(SupplierBillItem, { foreignKey: 'billId', as: 'items' });
SupplierBill.belongsTo(PurchaseOrder, { foreignKey: 'orderId', as: 'order' });
SupplierBill.belongsTo(GoodsReceipt, { foreignKey: 'receiptId', as: 'receipt' });
SupplierBill.belongsTo(User, { foreignKey: 'postedBy', as: 'poster' });
SupplierBill.hasMany(PayableAllocation, { foreignKey: 'billId', as: 'allocations' });
PayableAllocation.belongsTo(SupplierBill, { foreignKey: 'billId', as: 'bill' });

SupplierPayment.belongsTo(PaymentMethod, { foreignKey: 'paymentMethodId', as: 'paymentMethod' });
SupplierPayment.belongsTo(User, { foreignKey: 'voidedBy', as: 'voider' });

PurchaseReturn.hasMany(PurchaseReturnItem, { foreignKey: 'returnId', as: 'items' });
PurchaseReturn.belongsTo(GoodsReceipt, { foreignKey: 'receiptId', as: 'receipt' });
PurchaseReturn.belongsTo(SupplierBill, { foreignKey: 'billId', as: 'bill' });
PurchaseReturn.belongsTo(User, { foreignKey: 'postedBy', as: 'poster' });

// ── Sales ──────────────────────────────────────────────────────────────────
for (const model of [
  SalesQuotationItem,
  SalesOrderItem,
  DeliveryChallanItem,
  SalesInvoiceItem,
  SalesReturnItem,
  PriceListItem,
]) {
  model.belongsTo(Product, { foreignKey: 'productId', as: 'product' });
  model.belongsTo(ProductVariant, { foreignKey: 'variantId', as: 'variant' });
  model.belongsTo(Unit, { foreignKey: 'unitId', as: 'unit' });
}
for (const model of [SalesQuotationItem, SalesOrderItem, SalesInvoiceItem, SalesReturnItem]) {
  model.belongsTo(TaxGroup, { foreignKey: 'taxGroupId', as: 'taxGroup' });
}
for (const model of [DeliveryChallanItem, SalesInvoiceItem, SalesReturnItem]) {
  model.belongsTo(StockBatch, { foreignKey: 'batchId', as: 'batch' });
}
for (const model of [
  SalesQuotation,
  SalesOrder,
  DeliveryChallan,
  SalesInvoice,
  CustomerReceipt,
  SalesReturn,
  RecurringInvoice,
]) {
  model.belongsTo(Party, { foreignKey: 'customerId', as: 'customer' });
  model.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });
  model.belongsTo(User, { foreignKey: 'createdBy', as: 'creator' });
}
for (const model of [SalesOrder, DeliveryChallan, SalesInvoice, SalesReturn]) {
  model.belongsTo(Warehouse, { foreignKey: 'warehouseId', as: 'warehouse' });
}
PriceList.hasMany(PriceListItem, { foreignKey: 'priceListId', as: 'items' });
PriceList.belongsTo(PartyGroup, { foreignKey: 'customerGroupId', as: 'customerGroup' });
SalesQuotation.hasMany(SalesQuotationItem, { foreignKey: 'quotationId', as: 'items' });
SalesOrder.hasMany(SalesOrderItem, { foreignKey: 'orderId', as: 'items' });
SalesOrder.belongsTo(SalesQuotation, { foreignKey: 'quotationId', as: 'quotation' });
SalesOrder.belongsTo(User, { foreignKey: 'confirmedBy', as: 'confirmer' });
SalesOrder.belongsTo(User, { foreignKey: 'closedBy', as: 'closer' });
SalesOrder.belongsTo(User, { foreignKey: 'cancelledBy', as: 'canceller' });
DeliveryChallan.hasMany(DeliveryChallanItem, { foreignKey: 'challanId', as: 'items' });
DeliveryChallan.belongsTo(SalesOrder, { foreignKey: 'orderId', as: 'order' });
DeliveryChallan.belongsTo(User, { foreignKey: 'postedBy', as: 'poster' });
DeliveryChallanItem.belongsTo(SalesOrderItem, { foreignKey: 'orderItemId', as: 'orderItem' });
DeliveryChallanItem.belongsTo(DeliveryChallan, { foreignKey: 'challanId', as: 'challan' });
SalesInvoice.hasMany(SalesInvoiceItem, { foreignKey: 'invoiceId', as: 'items' });
SalesInvoice.belongsTo(SalesOrder, { foreignKey: 'orderId', as: 'order' });
SalesInvoice.belongsTo(DeliveryChallan, { foreignKey: 'challanId', as: 'challan' });
SalesInvoice.belongsTo(SalesQuotation, { foreignKey: 'quotationId', as: 'quotation' });
SalesInvoice.belongsTo(RecurringInvoice, { foreignKey: 'recurringId', as: 'recurring' });
SalesInvoice.belongsTo(User, { foreignKey: 'postedBy', as: 'poster' });
SalesInvoice.hasMany(ReceivableAllocation, { foreignKey: 'invoiceId', as: 'allocations' });
ReceivableAllocation.belongsTo(SalesInvoice, { foreignKey: 'invoiceId', as: 'invoice' });
CustomerReceipt.belongsTo(PaymentMethod, { foreignKey: 'paymentMethodId', as: 'paymentMethod' });
CustomerReceipt.belongsTo(User, { foreignKey: 'voidedBy', as: 'voider' });
SalesReturn.hasMany(SalesReturnItem, { foreignKey: 'returnId', as: 'items' });
SalesReturn.belongsTo(SalesInvoice, { foreignKey: 'invoiceId', as: 'invoice' });
SalesReturn.belongsTo(User, { foreignKey: 'postedBy', as: 'poster' });
CreditOverride.belongsTo(User, { foreignKey: 'userId', as: 'user' });
PaymentReminder.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// ── Point of sale ──────────────────────────────────────────────────────────
PosRegister.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });
PosRegister.belongsTo(Warehouse, { foreignKey: 'warehouseId', as: 'warehouse' });
PosRegister.belongsTo(Party, { foreignKey: 'defaultCustomerId', as: 'defaultCustomer' });
PosSession.belongsTo(PosRegister, { foreignKey: 'registerId', as: 'register' });
PosSession.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });
PosSession.belongsTo(User, { foreignKey: 'openedBy', as: 'opener' });
PosSession.belongsTo(User, { foreignKey: 'closedBy', as: 'closer' });
PosSession.hasMany(PosCashMovement, { foreignKey: 'sessionId', as: 'cashMovements' });
PosCashMovement.belongsTo(User, { foreignKey: 'createdBy', as: 'creator' });
PosHeldOrder.belongsTo(Party, { foreignKey: 'customerId', as: 'customer' });
PosHeldOrder.belongsTo(User, { foreignKey: 'createdBy', as: 'creator' });
SalesInvoice.belongsTo(PosSession, { foreignKey: 'posSessionId', as: 'posSession' });
SalesReturn.belongsTo(PaymentMethod, { foreignKey: 'refundMethodId', as: 'refundMethod' });

// ── Accounting ─────────────────────────────────────────────────────────────
Account.belongsTo(Account, { foreignKey: 'parentId', as: 'parent' });
Account.hasMany(Account, { foreignKey: 'parentId', as: 'children' });
PaymentMethod.belongsTo(Account, { foreignKey: 'accountId', as: 'account' });
FiscalYear.hasMany(FiscalPeriod, { foreignKey: 'fiscalYearId', as: 'periods' });
FiscalPeriod.belongsTo(FiscalYear, { foreignKey: 'fiscalYearId', as: 'fiscalYear' });
FiscalYear.belongsTo(User, { foreignKey: 'closedBy', as: 'closer' });
FiscalPeriod.belongsTo(User, { foreignKey: 'lockedBy', as: 'locker' });
JournalEntry.hasMany(JournalLine, { foreignKey: 'journalId', as: 'lines' });
JournalLine.belongsTo(JournalEntry, { foreignKey: 'journalId', as: 'journal' });
JournalLine.belongsTo(Account, { foreignKey: 'accountId', as: 'account' });
JournalLine.belongsTo(Party, { foreignKey: 'partyId', as: 'party' });
JournalLine.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });
JournalEntry.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });
JournalEntry.belongsTo(User, { foreignKey: 'createdBy', as: 'creator' });
JournalEntry.belongsTo(User, { foreignKey: 'postedBy', as: 'poster' });
JournalEntry.belongsTo(JournalEntry, { foreignKey: 'reversalOfId', as: 'reversalOf' });
JournalEntry.belongsTo(JournalEntry, { foreignKey: 'reversedById', as: 'reversedBy' });

// Cash & bank
BankAccount.belongsTo(Account, { foreignKey: 'accountId', as: 'account' });
BankAccount.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });
Voucher.belongsTo(BankAccount, { foreignKey: 'bankAccountId', as: 'bankAccount' });
Voucher.belongsTo(BankAccount, { foreignKey: 'toBankAccountId', as: 'toBankAccount' });
Voucher.hasMany(VoucherLine, { foreignKey: 'voucherId', as: 'lines' });
VoucherLine.belongsTo(Account, { foreignKey: 'accountId', as: 'account' });
Cheque.belongsTo(Party, { foreignKey: 'partyId', as: 'party' });
Cheque.belongsTo(BankAccount, { foreignKey: 'depositBankAccountId', as: 'depositBankAccount' });
BankReconciliation.belongsTo(BankAccount, { foreignKey: 'bankAccountId', as: 'bankAccount' });
BankReconciliation.belongsTo(User, { foreignKey: 'completedBy', as: 'completer' });
BankReconciliation.hasMany(BankStatementLine, { foreignKey: 'reconciliationId', as: 'statementLines' });
ExpenseCategory.belongsTo(Account, { foreignKey: 'accountId', as: 'account' });
Expense.belongsTo(ExpenseCategory, { foreignKey: 'categoryId', as: 'category' });
Expense.belongsTo(BankAccount, { foreignKey: 'bankAccountId', as: 'bankAccount' });
for (const model of [Voucher, Expense]) {
  model.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });
  model.belongsTo(User, { foreignKey: 'createdBy', as: 'creator' });
  model.belongsTo(User, { foreignKey: 'postedBy', as: 'poster' });
  model.belongsTo(User, { foreignKey: 'voidedBy', as: 'voider' });
}

// Manufacturing
WorkCenter.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });
Bom.belongsTo(Product, { foreignKey: 'productId', as: 'product' });
Bom.belongsTo(ProductVariant, { foreignKey: 'variantId', as: 'variant' });
Bom.belongsTo(User, { foreignKey: 'activatedBy', as: 'activator' });
Bom.hasMany(BomComponent, { foreignKey: 'bomId', as: 'components' });
Bom.hasMany(BomByproduct, { foreignKey: 'bomId', as: 'byproducts' });
Bom.hasMany(BomOperation, { foreignKey: 'bomId', as: 'operations' });
Bom.hasMany(BomQualityCheck, { foreignKey: 'bomId', as: 'qualityChecks' });
for (const model of [BomComponent, BomByproduct, MoMaterial, MoOutput, MoScrap]) {
  model.belongsTo(Product, { foreignKey: 'productId', as: 'product' });
  model.belongsTo(ProductVariant, { foreignKey: 'variantId', as: 'variant' });
}
BomComponent.belongsTo(Unit, { foreignKey: 'unitId', as: 'unit' });
BomOperation.belongsTo(WorkCenter, { foreignKey: 'workCenterId', as: 'workCenter' });
MoOperation.belongsTo(WorkCenter, { foreignKey: 'workCenterId', as: 'workCenter' });
MoOperation.belongsTo(ManufacturingOrder, { foreignKey: 'orderId', as: 'order' });
MoOutput.belongsTo(StockBatch, { foreignKey: 'batchId', as: 'batch' });
QualityCheck.belongsTo(User, { foreignKey: 'checkedBy', as: 'checker' });
ManufacturingOrder.belongsTo(Product, { foreignKey: 'productId', as: 'product' });
ManufacturingOrder.belongsTo(ProductVariant, { foreignKey: 'variantId', as: 'variant' });
ManufacturingOrder.belongsTo(Bom, { foreignKey: 'bomId', as: 'bom' });
ManufacturingOrder.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });
ManufacturingOrder.belongsTo(SalesOrder, { foreignKey: 'salesOrderId', as: 'salesOrder' });
ManufacturingOrder.belongsTo(ManufacturingOrder, { foreignKey: 'parentId', as: 'parent' });
ManufacturingOrder.belongsTo(Warehouse, { foreignKey: 'rawWarehouseId', as: 'rawWarehouse' });
ManufacturingOrder.belongsTo(Warehouse, { foreignKey: 'finishedWarehouseId', as: 'finishedWarehouse' });
ManufacturingOrder.hasMany(MoMaterial, { foreignKey: 'orderId', as: 'materials' });
ManufacturingOrder.hasMany(MoOperation, { foreignKey: 'orderId', as: 'operations' });
ManufacturingOrder.hasMany(MoOutput, { foreignKey: 'orderId', as: 'outputs' });
ManufacturingOrder.hasMany(MoScrap, { foreignKey: 'orderId', as: 'scrap' });
ManufacturingOrder.hasMany(QualityCheck, { foreignKey: 'orderId', as: 'qualityChecks' });
for (const [key, as] of [
  ['createdBy', 'creator'],
  ['confirmedBy', 'confirmer'],
  ['completedBy', 'completer'],
  ['closedBy', 'closer'],
  ['cancelledBy', 'canceller'],
]) {
  ManufacturingOrder.belongsTo(User, { foreignKey: key, as });
}

// Who did what on workflow documents.
for (const model of [StockAdjustment, StockCount]) {
  for (const [key, as] of [
    ['createdBy', 'creator'],
    ['submittedBy', 'submitter'],
    ['approvedBy', 'approver'],
    ['rejectedBy', 'rejecter'],
    ['cancelledBy', 'canceller'],
  ]) {
    model.belongsTo(User, { foreignKey: key, as });
  }
}
for (const [key, as] of [
  ['createdBy', 'creator'],
  ['dispatchedBy', 'dispatcher'],
  ['receivedBy', 'receiver'],
  ['cancelledBy', 'canceller'],
]) {
  StockTransfer.belongsTo(User, { foreignKey: key, as });
}

export {
  Company,
  Branch,
  User,
  UserRole,
  UserBranch,
  Role,
  Permission,
  RolePermission,
  RefreshToken,
  LoginHistory,
  Warehouse,
  Currency,
  ExchangeRate,
  TaxRate,
  TaxGroup,
  TaxGroupRate,
  DocumentSequence,
  Unit,
  UnitConversion,
  PaymentMethod,
  Setting,
  PrintTemplate,
  Backup,
  ProductCategory,
  Brand,
  ProductAttribute,
  ProductAttributeValue,
  Product,
  ProductUnit,
  ProductVariant,
  ProductVariantValue,
  ProductImage,
  Party,
  PartyGroup,
  PartyAddress,
  StockBatch,
  StockMovement,
  StockBalance,
  StockLayer,
  StockSerial,
  StockMovementSerial,
  StockAdjustment,
  StockAdjustmentItem,
  StockTransfer,
  StockTransferItem,
  StockCount,
  StockCountItem,
  PurchaseRequisition,
  PurchaseRequisitionItem,
  PurchaseRfq,
  PurchaseRfqItem,
  PurchaseRfqSupplier,
  PurchaseRfqQuote,
  PurchaseOrder,
  PurchaseOrderItem,
  PurchaseApproval,
  GoodsReceipt,
  GoodsReceiptItem,
  GoodsReceiptCost,
  SupplierBill,
  SupplierBillItem,
  SupplierPayment,
  PurchaseReturn,
  PurchaseReturnItem,
  PayableAllocation,
  PriceList,
  PriceListItem,
  SalesQuotation,
  SalesQuotationItem,
  SalesOrder,
  SalesOrderItem,
  DeliveryChallan,
  DeliveryChallanItem,
  SalesInvoice,
  SalesInvoiceItem,
  CustomerReceipt,
  SalesReturn,
  SalesReturnItem,
  ReceivableAllocation,
  CreditOverride,
  RecurringInvoice,
  PaymentReminder,
  PosRegister,
  PosSession,
  PosCashMovement,
  PosHeldOrder,
  Account,
  FiscalYear,
  FiscalPeriod,
  JournalEntry,
  JournalLine,
  BankAccount,
  Voucher,
  VoucherLine,
  Cheque,
  BankReconciliation,
  BankStatementLine,
  ExpenseCategory,
  Expense,
  Attachment,
  WorkCenter,
  Bom,
  BomComponent,
  BomByproduct,
  BomOperation,
  BomQualityCheck,
  ManufacturingOrder,
  MoMaterial,
  MoOperation,
  MoOutput,
  MoScrap,
  QualityCheck,
};
