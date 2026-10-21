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
const createdAt = (Sequelize) => ({
  created_at: {
    type: Sequelize.DATE,
    allowNull: false,
    defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
  },
});
const user = (Sequelize) => fk(Sequelize, 'users', { allowNull: true, onDelete: 'SET NULL' });
const at = (Sequelize) => ({ type: Sequelize.DATE, allowNull: true });
const discountType = (Sequelize) => ({
  type: Sequelize.ENUM('percent', 'amount'),
  allowNull: false,
  defaultValue: 'percent',
});

/** Item columns of every sales document line (entered unit + base unit). */
const item = (Sequelize) => ({
  product_id: fk(Sequelize, 'products'),
  variant_id: fk(Sequelize, 'product_variants', { allowNull: true }),
  unit_id: fk(Sequelize, 'units', { allowNull: true }),
  unit_factor: { type: Sequelize.DECIMAL(18, 6), allowNull: false, defaultValue: 1 },
  quantity: quantity(Sequelize),
  base_quantity: quantity(Sequelize),
});
/**
 * Pricing: unit price per entered unit, line discount (% or fixed amount for the line), share of the
 * document discount, tax group (price inclusive or exclusive of tax), and the resulting amounts.
 */
const price = (Sequelize) => ({
  unit_price: money(Sequelize),
  discount_type: discountType(Sequelize),
  discount_value: money(Sequelize),
  discount_amount: money(Sequelize, { comment: 'Line discount in money' }),
  document_discount: money(Sequelize, { comment: 'Share of the document-level discount' }),
  tax_group_id: fk(Sequelize, 'tax_groups', { allowNull: true }),
  price_includes_tax: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
  tax_amount: money(Sequelize),
  line_subtotal: money(Sequelize, { comment: 'After all discounts, excluding tax' }),
  line_total: money(Sequelize),
});
const totals = (Sequelize) => ({
  discount_type: discountType(Sequelize),
  discount_value: money(Sequelize, { comment: 'Document-level discount as entered' }),
  subtotal: money(Sequelize, { comment: 'Gross: quantity × price' }),
  discount_total: money(Sequelize, { comment: 'Line + document discounts' }),
  tax_total: money(Sequelize),
  round_off: money(Sequelize, { comment: 'Signed rounding adjustment' }),
  total: money(Sequelize),
});
const lineMeta = (Sequelize) => ({
  notes: { type: Sequelize.STRING(500), allowNull: true },
  sort_order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
  ...timestamps(Sequelize),
});

/**
 * Sales: price lists, quotation → sales order → delivery challan → invoice → money receipt, sales
 * returns / credit notes, recurring invoices and payment-reminder log. Challans (and invoices that
 * deliver directly) take stock out through the inventory ledger.
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
      await queryInterface.addIndex(table, ['customer_id']);
    };

    // ── Price lists ────────────────────────────────────────────────────────
    await create('price_lists', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize),
      name: { type: Sequelize.STRING(150), allowNull: false },
      code: { type: Sequelize.STRING(30), allowNull: false },
      customer_group_id: fk(Sequelize, 'party_groups', { allowNull: true, onDelete: 'SET NULL' }),
      valid_from: { type: Sequelize.DATEONLY, allowNull: true },
      valid_to: { type: Sequelize.DATEONLY, allowNull: true },
      priority: { type: Sequelize.SMALLINT, allowNull: false, defaultValue: 0 },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      notes: { type: Sequelize.STRING(500), allowNull: true },
      ...auditColumns(Sequelize),
    });
    await queryInterface.addIndex('price_lists', ['company_id', 'code'], {
      unique: true,
      name: 'price_lists_code_unique',
    });
    await queryInterface.addIndex('price_lists', ['customer_group_id']);
    await create('price_list_items', {
      ...idColumn(Sequelize),
      price_list_id: fk(Sequelize, 'price_lists', { onDelete: 'CASCADE' }),
      product_id: fk(Sequelize, 'products', { onDelete: 'CASCADE' }),
      variant_id: fk(Sequelize, 'product_variants', { allowNull: true, onDelete: 'CASCADE' }),
      unit_id: fk(Sequelize, 'units', { allowNull: true }),
      price: money(Sequelize, { allowNull: true, defaultValue: null, comment: 'Fixed price per unit' }),
      discount_percent: {
        type: Sequelize.DECIMAL(7, 4),
        allowNull: true,
        comment: 'Or % off the standard price',
      },
      min_quantity: quantity(Sequelize),
      ...timestamps(Sequelize),
    });
    await queryInterface.addIndex('price_list_items', ['price_list_id', 'product_id']);

    // ── Quotations ─────────────────────────────────────────────────────────
    await create('sales_quotations', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize, { branch: true, branchRequired: true }),
      customer_id: fk(Sequelize, 'parties'),
      number: { type: Sequelize.STRING(60), allowNull: false },
      quotation_date: { type: Sequelize.DATEONLY, allowNull: false },
      valid_until: { type: Sequelize.DATEONLY, allowNull: true },
      status: {
        type: Sequelize.ENUM('draft', 'sent', 'accepted', 'declined', 'converted', 'cancelled'),
        allowNull: false,
        defaultValue: 'draft',
      },
      customer_reference: { type: Sequelize.STRING(100), allowNull: true },
      ...totals(Sequelize),
      notes: { type: Sequelize.TEXT, allowNull: true },
      terms: { type: Sequelize.TEXT, allowNull: true },
      sent_at: at(Sequelize),
      ...auditColumns(Sequelize),
    });
    await numbered('sales_quotations');
    await create('sales_quotation_items', {
      ...idColumn(Sequelize),
      quotation_id: fk(Sequelize, 'sales_quotations', { onDelete: 'CASCADE' }),
      ...item(Sequelize),
      ...price(Sequelize),
      ...lineMeta(Sequelize),
    });

    // ── Sales orders ───────────────────────────────────────────────────────
    await create('sales_orders', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize, { branch: true, branchRequired: true }),
      warehouse_id: fk(Sequelize, 'warehouses'),
      customer_id: fk(Sequelize, 'parties'),
      quotation_id: fk(Sequelize, 'sales_quotations', { allowNull: true, onDelete: 'SET NULL' }),
      number: { type: Sequelize.STRING(60), allowNull: false },
      order_date: { type: Sequelize.DATEONLY, allowNull: false },
      delivery_date: { type: Sequelize.DATEONLY, allowNull: true },
      payment_terms_days: { type: Sequelize.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
      customer_reference: { type: Sequelize.STRING(100), allowNull: true },
      shipping_address: { type: Sequelize.STRING(500), allowNull: true },
      status: {
        type: Sequelize.ENUM(
          'draft',
          'confirmed',
          'partially_delivered',
          'delivered',
          'invoiced',
          'closed',
          'cancelled',
        ),
        allowNull: false,
        defaultValue: 'draft',
      },
      ...totals(Sequelize),
      notes: { type: Sequelize.TEXT, allowNull: true },
      terms: { type: Sequelize.TEXT, allowNull: true },
      confirmed_by: user(Sequelize),
      confirmed_at: at(Sequelize),
      closed_by: user(Sequelize),
      closed_at: at(Sequelize),
      cancelled_by: user(Sequelize),
      cancelled_at: at(Sequelize),
      ...auditColumns(Sequelize),
    });
    await numbered('sales_orders');
    await create('sales_order_items', {
      ...idColumn(Sequelize),
      order_id: fk(Sequelize, 'sales_orders', { onDelete: 'CASCADE' }),
      ...item(Sequelize),
      ...price(Sequelize),
      delivered_base_quantity: quantity(Sequelize),
      invoiced_base_quantity: quantity(Sequelize),
      ...lineMeta(Sequelize),
    });

    // ── Delivery challans ──────────────────────────────────────────────────
    await create('delivery_challans', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize, { branch: true, branchRequired: true }),
      warehouse_id: fk(Sequelize, 'warehouses'),
      customer_id: fk(Sequelize, 'parties'),
      order_id: fk(Sequelize, 'sales_orders', { allowNull: true }),
      number: { type: Sequelize.STRING(60), allowNull: false },
      challan_date: { type: Sequelize.DATEONLY, allowNull: false },
      shipping_address: { type: Sequelize.STRING(500), allowNull: true },
      vehicle_no: { type: Sequelize.STRING(50), allowNull: true },
      driver_name: { type: Sequelize.STRING(100), allowNull: true },
      status: {
        type: Sequelize.ENUM('draft', 'posted', 'cancelled'),
        allowNull: false,
        defaultValue: 'draft',
      },
      cost_total: money(Sequelize, { comment: 'Stock value delivered' }),
      notes: { type: Sequelize.TEXT, allowNull: true },
      posted_by: user(Sequelize),
      posted_at: at(Sequelize),
      cancelled_by: user(Sequelize),
      cancelled_at: at(Sequelize),
      ...auditColumns(Sequelize),
    });
    await numbered('delivery_challans');
    await create('delivery_challan_items', {
      ...idColumn(Sequelize),
      challan_id: fk(Sequelize, 'delivery_challans', { onDelete: 'CASCADE' }),
      order_item_id: fk(Sequelize, 'sales_order_items', { allowNull: true }),
      ...item(Sequelize),
      batch_id: fk(Sequelize, 'stock_batches', { allowNull: true }),
      serial_numbers: { type: Sequelize.TEXT, allowNull: true, comment: 'JSON array' },
      unit_cost: money(Sequelize, { comment: 'Stock cost per base unit when posted' }),
      invoiced_base_quantity: quantity(Sequelize),
      returned_base_quantity: quantity(Sequelize),
      ...lineMeta(Sequelize),
    });

    // ── Invoices ───────────────────────────────────────────────────────────
    await create('sales_invoices', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize, { branch: true, branchRequired: true }),
      warehouse_id: fk(Sequelize, 'warehouses', {
        allowNull: true,
        comment: 'Stock source for lines not delivered by challan',
      }),
      customer_id: fk(Sequelize, 'parties'),
      order_id: fk(Sequelize, 'sales_orders', { allowNull: true }),
      challan_id: fk(Sequelize, 'delivery_challans', { allowNull: true }),
      quotation_id: fk(Sequelize, 'sales_quotations', { allowNull: true, onDelete: 'SET NULL' }),
      recurring_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: true },
      number: { type: Sequelize.STRING(60), allowNull: false },
      invoice_date: { type: Sequelize.DATEONLY, allowNull: false },
      due_date: { type: Sequelize.DATEONLY, allowNull: false },
      customer_reference: { type: Sequelize.STRING(100), allowNull: true },
      status: {
        type: Sequelize.ENUM('draft', 'unpaid', 'partially_paid', 'paid', 'cancelled'),
        allowNull: false,
        defaultValue: 'draft',
      },
      ...totals(Sequelize),
      paid_amount: money(Sequelize, { comment: 'Receipts and credit notes applied' }),
      cost_total: money(Sequelize, { comment: 'Stock value delivered by this invoice' }),
      notes: { type: Sequelize.TEXT, allowNull: true },
      terms: { type: Sequelize.TEXT, allowNull: true },
      posted_by: user(Sequelize),
      posted_at: at(Sequelize),
      cancelled_by: user(Sequelize),
      cancelled_at: at(Sequelize),
      emailed_at: at(Sequelize),
      last_reminder_at: at(Sequelize),
      ...auditColumns(Sequelize),
    });
    await numbered('sales_invoices');
    await queryInterface.addIndex('sales_invoices', ['company_id', 'due_date']);
    await create('sales_invoice_items', {
      ...idColumn(Sequelize),
      invoice_id: fk(Sequelize, 'sales_invoices', { onDelete: 'CASCADE' }),
      order_item_id: fk(Sequelize, 'sales_order_items', { allowNull: true }),
      challan_item_id: fk(Sequelize, 'delivery_challan_items', { allowNull: true }),
      ...item(Sequelize),
      ...price(Sequelize),
      batch_id: fk(Sequelize, 'stock_batches', { allowNull: true }),
      serial_numbers: { type: Sequelize.TEXT, allowNull: true, comment: 'JSON array' },
      unit_cost: money(Sequelize, { comment: 'Stock cost per base unit when delivered by the invoice' }),
      returned_base_quantity: quantity(Sequelize),
      ...lineMeta(Sequelize),
    });

    // ── Money receipts ─────────────────────────────────────────────────────
    await create('customer_receipts', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize, { branch: true, branchRequired: true }),
      customer_id: fk(Sequelize, 'parties'),
      payment_method_id: fk(Sequelize, 'payment_methods'),
      number: { type: Sequelize.STRING(60), allowNull: false },
      receipt_date: { type: Sequelize.DATEONLY, allowNull: false },
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
    await numbered('customer_receipts');

    // ── Returns / credit notes ─────────────────────────────────────────────
    await create('sales_returns', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize, { branch: true, branchRequired: true }),
      warehouse_id: fk(Sequelize, 'warehouses', { allowNull: true }),
      customer_id: fk(Sequelize, 'parties'),
      invoice_id: fk(Sequelize, 'sales_invoices', { allowNull: true }),
      number: { type: Sequelize.STRING(60), allowNull: false },
      return_date: { type: Sequelize.DATEONLY, allowNull: false },
      type: { type: Sequelize.ENUM('return', 'credit_note'), allowNull: false },
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
    await numbered('sales_returns');
    await create('sales_return_items', {
      ...idColumn(Sequelize),
      return_id: fk(Sequelize, 'sales_returns', { onDelete: 'CASCADE' }),
      invoice_item_id: fk(Sequelize, 'sales_invoice_items', { allowNull: true }),
      ...item(Sequelize),
      ...price(Sequelize),
      batch_id: fk(Sequelize, 'stock_batches', { allowNull: true }),
      serial_numbers: { type: Sequelize.TEXT, allowNull: true, comment: 'JSON array' },
      unit_cost: money(Sequelize, { comment: 'Stock cost per base unit put back' }),
      ...lineMeta(Sequelize),
    });

    /** Receipts and credit notes applied to invoices. */
    await create('receivable_allocations', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize),
      invoice_id: fk(Sequelize, 'sales_invoices'),
      source_type: { type: Sequelize.ENUM('receipt', 'credit_note'), allowNull: false },
      source_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false },
      amount: money(Sequelize),
      created_by: user(Sequelize),
      ...createdAt(Sequelize),
    });
    await queryInterface.addIndex('receivable_allocations', ['invoice_id']);
    await queryInterface.addIndex('receivable_allocations', ['source_type', 'source_id']);

    /** Who let a document through above the customer's credit limit, and why. */
    await create('credit_overrides', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize),
      customer_id: fk(Sequelize, 'parties'),
      document_type: { type: Sequelize.STRING(30), allowNull: false },
      document_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false },
      credit_limit: money(Sequelize),
      outstanding: money(Sequelize),
      document_amount: money(Sequelize),
      reason: { type: Sequelize.STRING(500), allowNull: false },
      user_id: user(Sequelize),
      ...createdAt(Sequelize),
    });
    await queryInterface.addIndex('credit_overrides', ['document_type', 'document_id']);

    // ── Recurring invoices ─────────────────────────────────────────────────
    await create('recurring_invoices', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize, { branch: true, branchRequired: true }),
      customer_id: fk(Sequelize, 'parties'),
      name: { type: Sequelize.STRING(150), allowNull: false },
      source_invoice_id: fk(Sequelize, 'sales_invoices', { allowNull: true, onDelete: 'SET NULL' }),
      template: { type: Sequelize.TEXT('medium'), allowNull: false, comment: 'JSON invoice payload' },
      frequency: { type: Sequelize.ENUM('weekly', 'monthly', 'quarterly', 'yearly'), allowNull: false },
      interval_count: { type: Sequelize.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 1 },
      next_run_date: { type: Sequelize.DATEONLY, allowNull: false },
      end_date: { type: Sequelize.DATEONLY, allowNull: true },
      auto_post: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      auto_email: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      last_run_at: at(Sequelize),
      last_invoice_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: true },
      runs_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      last_error: { type: Sequelize.STRING(500), allowNull: true },
      ...auditColumns(Sequelize),
    });
    await queryInterface.addIndex('recurring_invoices', ['is_active', 'next_run_date']);
    // Invoices were created before this table, so link them now.
    await queryInterface.addConstraint('sales_invoices', {
      fields: ['recurring_id'],
      type: 'foreign key',
      name: 'sales_invoices_recurring_fk',
      references: { table: 'recurring_invoices', field: 'id' },
      onDelete: 'SET NULL',
    });

    /** Reminder emails sent for invoices (manual and scheduled). */
    await create('payment_reminders', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize),
      invoice_id: fk(Sequelize, 'sales_invoices', { onDelete: 'CASCADE' }),
      kind: { type: Sequelize.ENUM('manual', 'before_due', 'after_due'), allowNull: false },
      offset_days: { type: Sequelize.SMALLINT, allowNull: true },
      sent_to: { type: Sequelize.STRING(500), allowNull: false },
      status: { type: Sequelize.ENUM('sent', 'failed'), allowNull: false },
      error: { type: Sequelize.STRING(500), allowNull: true },
      user_id: user(Sequelize),
      ...createdAt(Sequelize),
    });
    await queryInterface.addIndex('payment_reminders', ['invoice_id', 'kind', 'offset_days']);
  },

  async down(queryInterface) {
    await queryInterface.removeConstraint('sales_invoices', 'sales_invoices_recurring_fk');
    for (const table of [
      'payment_reminders',
      'recurring_invoices',
      'credit_overrides',
      'receivable_allocations',
      'sales_return_items',
      'sales_returns',
      'customer_receipts',
      'sales_invoice_items',
      'sales_invoices',
      'delivery_challan_items',
      'delivery_challans',
      'sales_order_items',
      'sales_orders',
      'sales_quotation_items',
      'sales_quotations',
      'price_list_items',
      'price_lists',
    ]) {
      await queryInterface.dropTable(table);
    }
  },
};
