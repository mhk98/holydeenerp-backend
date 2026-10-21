'use strict';

const {
  idColumn,
  tenantRefs,
  fk,
  auditColumns,
  money,
  quantity,
  tableOptions,
} = require('../utils/migration.cjs');

const timestamps = (Sequelize) => ({
  created_at: {
    type: Sequelize.DATE,
    allowNull: false,
    defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
  },
  updated_at: {
    type: Sequelize.DATE,
    allowNull: false,
    defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'),
  },
});
const user = (Sequelize) => fk(Sequelize, 'users', { allowNull: true, onDelete: 'SET NULL' });
const at = (Sequelize) => ({ type: Sequelize.DATE, allowNull: true });
const factor = (Sequelize) => ({ type: Sequelize.DECIMAL(18, 6), allowNull: false, defaultValue: 1 });

/** Item columns shared by every purchase document line (quantity in the entered unit + base unit). */
const itemColumns = (Sequelize, { productRequired = true } = {}) => ({
  product_id: fk(Sequelize, 'products', { allowNull: !productRequired }),
  variant_id: fk(Sequelize, 'product_variants', { allowNull: true }),
  unit_id: fk(Sequelize, 'units', { allowNull: true }),
  unit_factor: factor(Sequelize),
  quantity: quantity(Sequelize),
  base_quantity: quantity(Sequelize),
});
/** Price columns: unit price per entered unit, discount %, tax group and computed amounts. */
const priceColumns = (Sequelize) => ({
  unit_price: money(Sequelize),
  discount_percent: { type: Sequelize.DECIMAL(7, 4), allowNull: false, defaultValue: 0 },
  tax_group_id: fk(Sequelize, 'tax_groups', { allowNull: true }),
  tax_amount: money(Sequelize),
  line_subtotal: money(Sequelize, { comment: 'Quantity × price − discount, excluding tax' }),
  line_total: money(Sequelize),
});
const totals = (Sequelize) => ({
  subtotal: money(Sequelize),
  discount_total: money(Sequelize),
  tax_total: money(Sequelize),
  total: money(Sequelize),
});
const lineMeta = (Sequelize) => ({
  notes: { type: Sequelize.STRING(500), allowNull: true },
  sort_order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
  ...timestamps(Sequelize),
});

/**
 * Purchase: requisition → RFQ → purchase order → goods receipt (GRN) → supplier bill → payment,
 * and purchase returns / debit notes. GRNs and returns post stock through the inventory ledger;
 * bills, payments and debit notes make up the supplier ledger.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const create = (name, columns) => queryInterface.createTable(name, columns, tableOptions);
    const numbered = async (table) => {
      await queryInterface.addIndex(table, ['company_id', 'number'], {
        unique: true,
        name: `${table}_number_unique`,
      });
      await queryInterface.addIndex(table, ['company_id', 'status']);
    };

    // ── Requisitions ───────────────────────────────────────────────────────
    await create('purchase_requisitions', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize, { branch: true, branchRequired: true }),
      warehouse_id: fk(Sequelize, 'warehouses', { allowNull: true }),
      number: { type: Sequelize.STRING(60), allowNull: false },
      requisition_date: { type: Sequelize.DATEONLY, allowNull: false },
      required_by: { type: Sequelize.DATEONLY, allowNull: true },
      status: {
        type: Sequelize.ENUM('draft', 'pending_approval', 'approved', 'rejected', 'ordered', 'cancelled'),
        allowNull: false,
        defaultValue: 'draft',
      },
      notes: { type: Sequelize.TEXT, allowNull: true },
      submitted_by: user(Sequelize),
      submitted_at: at(Sequelize),
      approved_by: user(Sequelize),
      approved_at: at(Sequelize),
      rejected_by: user(Sequelize),
      rejected_at: at(Sequelize),
      rejection_reason: { type: Sequelize.STRING(500), allowNull: true },
      cancelled_by: user(Sequelize),
      cancelled_at: at(Sequelize),
      ...auditColumns(Sequelize),
    });
    await numbered('purchase_requisitions');
    await create('purchase_requisition_items', {
      ...idColumn(Sequelize),
      requisition_id: fk(Sequelize, 'purchase_requisitions', { onDelete: 'CASCADE' }),
      ...itemColumns(Sequelize),
      estimated_price: money(Sequelize, { allowNull: true, defaultValue: null }),
      ...lineMeta(Sequelize),
    });

    // ── RFQs ───────────────────────────────────────────────────────────────
    await create('purchase_rfqs', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize, { branch: true, branchRequired: true }),
      requisition_id: fk(Sequelize, 'purchase_requisitions', { allowNull: true, onDelete: 'SET NULL' }),
      number: { type: Sequelize.STRING(60), allowNull: false },
      rfq_date: { type: Sequelize.DATEONLY, allowNull: false },
      quote_deadline: { type: Sequelize.DATEONLY, allowNull: true },
      status: {
        type: Sequelize.ENUM('draft', 'sent', 'awarded', 'cancelled'),
        allowNull: false,
        defaultValue: 'draft',
      },
      notes: { type: Sequelize.TEXT, allowNull: true },
      sent_at: at(Sequelize),
      awarded_at: at(Sequelize),
      awarded_by: user(Sequelize),
      ...auditColumns(Sequelize),
    });
    await numbered('purchase_rfqs');
    await create('purchase_rfq_items', {
      ...idColumn(Sequelize),
      rfq_id: fk(Sequelize, 'purchase_rfqs', { onDelete: 'CASCADE' }),
      requisition_item_id: fk(Sequelize, 'purchase_requisition_items', {
        allowNull: true,
        onDelete: 'SET NULL',
      }),
      ...itemColumns(Sequelize),
      ...lineMeta(Sequelize),
    });
    await create('purchase_rfq_suppliers', {
      ...idColumn(Sequelize),
      rfq_id: fk(Sequelize, 'purchase_rfqs', { onDelete: 'CASCADE' }),
      supplier_id: fk(Sequelize, 'parties'),
      status: {
        type: Sequelize.ENUM('invited', 'quoted', 'declined', 'awarded'),
        allowNull: false,
        defaultValue: 'invited',
      },
      quote_date: { type: Sequelize.DATEONLY, allowNull: true },
      valid_until: { type: Sequelize.DATEONLY, allowNull: true },
      delivery_days: { type: Sequelize.SMALLINT.UNSIGNED, allowNull: true },
      total: money(Sequelize),
      notes: { type: Sequelize.STRING(500), allowNull: true },
      ...timestamps(Sequelize),
    });
    await queryInterface.addIndex('purchase_rfq_suppliers', ['rfq_id', 'supplier_id'], {
      unique: true,
      name: 'purchase_rfq_suppliers_unique',
    });
    await create('purchase_rfq_quotes', {
      ...idColumn(Sequelize),
      rfq_supplier_id: fk(Sequelize, 'purchase_rfq_suppliers', { onDelete: 'CASCADE' }),
      rfq_item_id: fk(Sequelize, 'purchase_rfq_items', { onDelete: 'CASCADE' }),
      unit_price: money(Sequelize),
      discount_percent: { type: Sequelize.DECIMAL(7, 4), allowNull: false, defaultValue: 0 },
      tax_group_id: fk(Sequelize, 'tax_groups', { allowNull: true }),
      notes: { type: Sequelize.STRING(255), allowNull: true },
      ...timestamps(Sequelize),
    });
    await queryInterface.addIndex('purchase_rfq_quotes', ['rfq_supplier_id', 'rfq_item_id'], {
      unique: true,
      name: 'purchase_rfq_quotes_unique',
    });

    // ── Purchase orders ────────────────────────────────────────────────────
    await create('purchase_orders', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize, { branch: true, branchRequired: true }),
      warehouse_id: fk(Sequelize, 'warehouses'),
      supplier_id: fk(Sequelize, 'parties'),
      requisition_id: fk(Sequelize, 'purchase_requisitions', { allowNull: true, onDelete: 'SET NULL' }),
      rfq_id: fk(Sequelize, 'purchase_rfqs', { allowNull: true, onDelete: 'SET NULL' }),
      number: { type: Sequelize.STRING(60), allowNull: false },
      order_date: { type: Sequelize.DATEONLY, allowNull: false },
      expected_date: { type: Sequelize.DATEONLY, allowNull: true },
      payment_terms_days: { type: Sequelize.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
      supplier_reference: { type: Sequelize.STRING(100), allowNull: true },
      status: {
        type: Sequelize.ENUM(
          'draft',
          'pending_approval',
          'approved',
          'partially_received',
          'received',
          'billed',
          'closed',
          'cancelled',
        ),
        allowNull: false,
        defaultValue: 'draft',
      },
      approval_plan: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: 'JSON: levels required when submitted',
      },
      approval_level: { type: Sequelize.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
      ...totals(Sequelize),
      notes: { type: Sequelize.TEXT, allowNull: true },
      terms: { type: Sequelize.TEXT, allowNull: true },
      submitted_by: user(Sequelize),
      submitted_at: at(Sequelize),
      approved_at: at(Sequelize),
      rejected_by: user(Sequelize),
      rejected_at: at(Sequelize),
      rejection_reason: { type: Sequelize.STRING(500), allowNull: true },
      closed_by: user(Sequelize),
      closed_at: at(Sequelize),
      cancelled_by: user(Sequelize),
      cancelled_at: at(Sequelize),
      emailed_at: at(Sequelize),
      ...auditColumns(Sequelize),
    });
    await numbered('purchase_orders');
    await queryInterface.addIndex('purchase_orders', ['supplier_id']);
    await create('purchase_order_items', {
      ...idColumn(Sequelize),
      order_id: fk(Sequelize, 'purchase_orders', { onDelete: 'CASCADE' }),
      requisition_item_id: fk(Sequelize, 'purchase_requisition_items', {
        allowNull: true,
        onDelete: 'SET NULL',
      }),
      ...itemColumns(Sequelize),
      ...priceColumns(Sequelize),
      received_base_quantity: quantity(Sequelize),
      billed_base_quantity: quantity(Sequelize),
      ...lineMeta(Sequelize),
    });

    /** One row per approval step taken on a document (audit trail). */
    await create('purchase_approvals', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize),
      document_type: { type: Sequelize.STRING(30), allowNull: false },
      document_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false },
      level: { type: Sequelize.TINYINT.UNSIGNED, allowNull: false },
      level_name: { type: Sequelize.STRING(100), allowNull: true },
      action: { type: Sequelize.ENUM('approved', 'rejected'), allowNull: false },
      user_id: user(Sequelize),
      note: { type: Sequelize.STRING(500), allowNull: true },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });
    await queryInterface.addIndex('purchase_approvals', ['document_type', 'document_id']);

    // ── Goods receipts ─────────────────────────────────────────────────────
    await create('goods_receipts', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize, { branch: true, branchRequired: true }),
      warehouse_id: fk(Sequelize, 'warehouses'),
      supplier_id: fk(Sequelize, 'parties'),
      order_id: fk(Sequelize, 'purchase_orders', { allowNull: true }),
      number: { type: Sequelize.STRING(60), allowNull: false },
      receipt_date: { type: Sequelize.DATEONLY, allowNull: false },
      supplier_reference: {
        type: Sequelize.STRING(100),
        allowNull: true,
        comment: 'Challan / delivery note no.',
      },
      status: {
        type: Sequelize.ENUM('draft', 'posted', 'cancelled'),
        allowNull: false,
        defaultValue: 'draft',
      },
      goods_value: money(Sequelize),
      landed_cost_total: money(Sequelize),
      total_cost: money(Sequelize),
      notes: { type: Sequelize.TEXT, allowNull: true },
      posted_by: user(Sequelize),
      posted_at: at(Sequelize),
      cancelled_by: user(Sequelize),
      cancelled_at: at(Sequelize),
      ...auditColumns(Sequelize),
    });
    await numbered('goods_receipts');
    await create('goods_receipt_items', {
      ...idColumn(Sequelize),
      receipt_id: fk(Sequelize, 'goods_receipts', { onDelete: 'CASCADE' }),
      order_item_id: fk(Sequelize, 'purchase_order_items', { allowNull: true }),
      ...itemColumns(Sequelize),
      unit_price: money(Sequelize, { comment: 'Per entered unit, after discount, excluding tax' }),
      tax_group_id: fk(Sequelize, 'tax_groups', { allowNull: true }),
      line_value: money(Sequelize),
      landed_cost: money(Sequelize, { comment: 'Share of the receipt’s landed costs' }),
      unit_cost: money(Sequelize, { comment: 'Per base unit incl. landed cost — the stock cost' }),
      batch_id: fk(Sequelize, 'stock_batches', { allowNull: true }),
      batch_no: { type: Sequelize.STRING(60), allowNull: true },
      mfg_date: { type: Sequelize.DATEONLY, allowNull: true },
      expiry_date: { type: Sequelize.DATEONLY, allowNull: true },
      serial_numbers: { type: Sequelize.TEXT, allowNull: true, comment: 'JSON array' },
      billed_base_quantity: quantity(Sequelize),
      returned_base_quantity: quantity(Sequelize),
      ...lineMeta(Sequelize),
    });
    await create('goods_receipt_costs', {
      ...idColumn(Sequelize),
      receipt_id: fk(Sequelize, 'goods_receipts', { onDelete: 'CASCADE' }),
      cost_type: {
        type: Sequelize.ENUM('freight', 'duty', 'insurance', 'handling', 'other'),
        allowNull: false,
      },
      description: { type: Sequelize.STRING(255), allowNull: true },
      amount: money(Sequelize),
      allocation: { type: Sequelize.ENUM('value', 'quantity'), allowNull: false, defaultValue: 'value' },
      ...timestamps(Sequelize),
    });

    // ── Supplier bills ─────────────────────────────────────────────────────
    await create('supplier_bills', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize, { branch: true, branchRequired: true }),
      supplier_id: fk(Sequelize, 'parties'),
      order_id: fk(Sequelize, 'purchase_orders', { allowNull: true }),
      receipt_id: fk(Sequelize, 'goods_receipts', { allowNull: true }),
      number: { type: Sequelize.STRING(60), allowNull: false },
      supplier_invoice_no: { type: Sequelize.STRING(100), allowNull: true },
      bill_date: { type: Sequelize.DATEONLY, allowNull: false },
      due_date: { type: Sequelize.DATEONLY, allowNull: false },
      status: {
        type: Sequelize.ENUM('draft', 'unpaid', 'partially_paid', 'paid', 'cancelled'),
        allowNull: false,
        defaultValue: 'draft',
      },
      ...totals(Sequelize),
      paid_amount: money(Sequelize, { comment: 'Payments and debit notes applied' }),
      notes: { type: Sequelize.TEXT, allowNull: true },
      posted_by: user(Sequelize),
      posted_at: at(Sequelize),
      cancelled_by: user(Sequelize),
      cancelled_at: at(Sequelize),
      ...auditColumns(Sequelize),
    });
    await numbered('supplier_bills');
    await queryInterface.addIndex('supplier_bills', ['supplier_id', 'status']);
    await create('supplier_bill_items', {
      ...idColumn(Sequelize),
      bill_id: fk(Sequelize, 'supplier_bills', { onDelete: 'CASCADE' }),
      order_item_id: fk(Sequelize, 'purchase_order_items', { allowNull: true }),
      receipt_item_id: fk(Sequelize, 'goods_receipt_items', { allowNull: true }),
      ...itemColumns(Sequelize),
      ...priceColumns(Sequelize),
      ...lineMeta(Sequelize),
    });

    // ── Payments ───────────────────────────────────────────────────────────
    await create('supplier_payments', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize, { branch: true, branchRequired: true }),
      supplier_id: fk(Sequelize, 'parties'),
      payment_method_id: fk(Sequelize, 'payment_methods'),
      number: { type: Sequelize.STRING(60), allowNull: false },
      payment_date: { type: Sequelize.DATEONLY, allowNull: false },
      amount: money(Sequelize),
      allocated_amount: money(Sequelize),
      reference: { type: Sequelize.STRING(100), allowNull: true },
      status: { type: Sequelize.ENUM('posted', 'void'), allowNull: false, defaultValue: 'posted' },
      notes: { type: Sequelize.TEXT, allowNull: true },
      voided_by: user(Sequelize),
      voided_at: at(Sequelize),
      void_reason: { type: Sequelize.STRING(500), allowNull: true },
      ...auditColumns(Sequelize),
    });
    await numbered('supplier_payments');
    await queryInterface.addIndex('supplier_payments', ['supplier_id']);

    // ── Returns / debit notes ──────────────────────────────────────────────
    await create('purchase_returns', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize, { branch: true, branchRequired: true }),
      warehouse_id: fk(Sequelize, 'warehouses', { allowNull: true }),
      supplier_id: fk(Sequelize, 'parties'),
      receipt_id: fk(Sequelize, 'goods_receipts', { allowNull: true }),
      bill_id: fk(Sequelize, 'supplier_bills', { allowNull: true }),
      number: { type: Sequelize.STRING(60), allowNull: false },
      return_date: { type: Sequelize.DATEONLY, allowNull: false },
      type: {
        type: Sequelize.ENUM('return', 'debit_note'),
        allowNull: false,
        comment: 'return: goods go back (stock out); debit_note: price/quantity claim without stock',
      },
      reason: { type: Sequelize.STRING(255), allowNull: true },
      status: {
        type: Sequelize.ENUM('draft', 'posted', 'cancelled'),
        allowNull: false,
        defaultValue: 'draft',
      },
      ...totals(Sequelize),
      applied_amount: money(Sequelize),
      notes: { type: Sequelize.TEXT, allowNull: true },
      posted_by: user(Sequelize),
      posted_at: at(Sequelize),
      cancelled_by: user(Sequelize),
      cancelled_at: at(Sequelize),
      ...auditColumns(Sequelize),
    });
    await numbered('purchase_returns');
    await queryInterface.addIndex('purchase_returns', ['supplier_id']);
    await create('purchase_return_items', {
      ...idColumn(Sequelize),
      return_id: fk(Sequelize, 'purchase_returns', { onDelete: 'CASCADE' }),
      receipt_item_id: fk(Sequelize, 'goods_receipt_items', { allowNull: true }),
      bill_item_id: fk(Sequelize, 'supplier_bill_items', { allowNull: true }),
      ...itemColumns(Sequelize),
      batch_id: fk(Sequelize, 'stock_batches', { allowNull: true }),
      serial_numbers: { type: Sequelize.TEXT, allowNull: true, comment: 'JSON array' },
      ...priceColumns(Sequelize),
      stock_cost: money(Sequelize, { comment: 'Value taken out of stock when posted' }),
      ...lineMeta(Sequelize),
    });

    /** Payments and debit notes applied to bills. */
    await create('payable_allocations', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize),
      bill_id: fk(Sequelize, 'supplier_bills'),
      source_type: { type: Sequelize.ENUM('payment', 'debit_note'), allowNull: false },
      source_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false },
      amount: money(Sequelize),
      created_by: user(Sequelize),
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });
    await queryInterface.addIndex('payable_allocations', ['bill_id']);
    await queryInterface.addIndex('payable_allocations', ['source_type', 'source_id']);
  },

  async down(queryInterface) {
    for (const table of [
      'payable_allocations',
      'purchase_return_items',
      'purchase_returns',
      'supplier_payments',
      'supplier_bill_items',
      'supplier_bills',
      'goods_receipt_costs',
      'goods_receipt_items',
      'goods_receipts',
      'purchase_approvals',
      'purchase_order_items',
      'purchase_orders',
      'purchase_rfq_quotes',
      'purchase_rfq_suppliers',
      'purchase_rfq_items',
      'purchase_rfqs',
      'purchase_requisition_items',
      'purchase_requisitions',
    ]) {
      await queryInterface.dropTable(table);
    }
  },
};
