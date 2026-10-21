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

const createdAt = (Sequelize) => ({
  created_at: {
    type: Sequelize.DATE,
    allowNull: false,
    defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
  },
});
const timestamps = (Sequelize) => ({
  ...createdAt(Sequelize),
  updated_at: {
    type: Sequelize.DATE,
    allowNull: false,
    defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'),
  },
});
// Generated keys let a UNIQUE index treat "no variant" / "no batch" as one value (NULLs never collide).
const variantKey = { type: 'BIGINT UNSIGNED AS (IFNULL(variant_id, 0)) STORED' };
// RESTRICT: MariaDB forbids FK actions on columns used by generated columns.
const variantFk = (Sequelize) => fk(Sequelize, 'product_variants', { allowNull: true });

const workflow = (Sequelize) => ({
  submitted_by: fk(Sequelize, 'users', { allowNull: true, onDelete: 'SET NULL' }),
  submitted_at: { type: Sequelize.DATE, allowNull: true },
  approved_by: fk(Sequelize, 'users', { allowNull: true, onDelete: 'SET NULL' }),
  approved_at: { type: Sequelize.DATE, allowNull: true },
  rejected_by: fk(Sequelize, 'users', { allowNull: true, onDelete: 'SET NULL' }),
  rejected_at: { type: Sequelize.DATE, allowNull: true },
  rejection_reason: { type: Sequelize.STRING(500), allowNull: true },
  cancelled_by: fk(Sequelize, 'users', { allowNull: true, onDelete: 'SET NULL' }),
  cancelled_at: { type: Sequelize.DATE, allowNull: true },
});

/**
 * Inventory: an append-only stock ledger (stock_movements) is the source of truth.
 * stock_balances (current quantity/value per warehouse item) and stock_layers (FIFO cost layers,
 * which also hold batch quantities) are derived state, updated in the same transaction as the
 * movement while the balance row is locked. Documents (adjustments, transfers, counts) post
 * movements; they never edit stock directly.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    // ── Batches / lots ─────────────────────────────────────────────────────
    await queryInterface.createTable(
      'stock_batches',
      {
        ...idColumn(Sequelize),
        ...tenantRefs(Sequelize),
        product_id: fk(Sequelize, 'products'),
        variant_id: variantFk(Sequelize),
        variant_key: variantKey,
        batch_no: { type: Sequelize.STRING(60), allowNull: false },
        mfg_date: { type: Sequelize.DATEONLY, allowNull: true },
        expiry_date: { type: Sequelize.DATEONLY, allowNull: true },
        created_by: fk(Sequelize, 'users', { allowNull: true, onDelete: 'SET NULL' }),
        ...timestamps(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('stock_batches', ['company_id', 'product_id', 'variant_key', 'batch_no'], {
      unique: true,
      name: 'stock_batches_item_batch_unique',
    });
    await queryInterface.addIndex('stock_batches', ['company_id', 'expiry_date']);

    // ── Ledger (immutable) ─────────────────────────────────────────────────
    await queryInterface.createTable(
      'stock_movements',
      {
        ...idColumn(Sequelize),
        ...tenantRefs(Sequelize, { branch: true, branchRequired: true }),
        warehouse_id: fk(Sequelize, 'warehouses'),
        product_id: fk(Sequelize, 'products'),
        variant_id: fk(Sequelize, 'product_variants', { allowNull: true }),
        batch_id: fk(Sequelize, 'stock_batches', { allowNull: true }),
        movement_type: { type: Sequelize.STRING(30), allowNull: false },
        movement_date: { type: Sequelize.DATEONLY, allowNull: false },
        reference_type: { type: Sequelize.STRING(40), allowNull: false },
        reference_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false },
        reference_no: { type: Sequelize.STRING(60), allowNull: true },
        reference_item_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: true },
        quantity: quantity(Sequelize, { comment: 'Signed, base unit: + in, − out' }),
        unit_cost: money(Sequelize),
        total_cost: money(Sequelize, { comment: 'Signed value of the movement' }),
        balance_quantity: quantity(Sequelize, { comment: 'Warehouse item quantity after this movement' }),
        balance_value: money(Sequelize, { comment: 'Warehouse item value after this movement' }),
        notes: { type: Sequelize.STRING(500), allowNull: true },
        created_by: fk(Sequelize, 'users', { allowNull: true, onDelete: 'SET NULL' }),
        ...createdAt(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex(
      'stock_movements',
      ['company_id', 'product_id', 'variant_id', 'warehouse_id', 'id'],
      {
        name: 'stock_movements_item_idx',
      },
    );
    await queryInterface.addIndex('stock_movements', ['reference_type', 'reference_id']);
    await queryInterface.addIndex('stock_movements', ['company_id', 'movement_date']);
    await queryInterface.addIndex('stock_movements', ['warehouse_id', 'movement_type', 'movement_date']);

    // ── Current state ──────────────────────────────────────────────────────
    await queryInterface.createTable(
      'stock_balances',
      {
        ...idColumn(Sequelize),
        ...tenantRefs(Sequelize, { branch: true, branchRequired: true }),
        warehouse_id: fk(Sequelize, 'warehouses'),
        product_id: fk(Sequelize, 'products'),
        variant_id: variantFk(Sequelize),
        variant_key: variantKey,
        quantity: quantity(Sequelize),
        avg_cost: money(Sequelize),
        total_value: money(Sequelize),
        last_movement_at: { type: Sequelize.DATE, allowNull: true },
        last_issue_at: { type: Sequelize.DATE, allowNull: true },
        ...timestamps(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('stock_balances', ['warehouse_id', 'product_id', 'variant_key'], {
      unique: true,
      name: 'stock_balances_item_unique',
    });
    await queryInterface.addIndex('stock_balances', ['company_id', 'product_id']);

    await queryInterface.createTable(
      'stock_layers',
      {
        ...idColumn(Sequelize),
        ...tenantRefs(Sequelize),
        warehouse_id: fk(Sequelize, 'warehouses'),
        product_id: fk(Sequelize, 'products'),
        variant_id: fk(Sequelize, 'product_variants', { allowNull: true }),
        batch_id: fk(Sequelize, 'stock_batches', { allowNull: true }),
        movement_id: fk(Sequelize, 'stock_movements'),
        received_at: { type: Sequelize.DATE, allowNull: false },
        quantity: quantity(Sequelize),
        remaining: quantity(Sequelize),
        unit_cost: money(Sequelize),
        ...timestamps(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('stock_layers', ['warehouse_id', 'product_id', 'variant_id', 'remaining'], {
      name: 'stock_layers_item_idx',
    });
    await queryInterface.addIndex('stock_layers', ['batch_id', 'warehouse_id']);

    await queryInterface.createTable(
      'stock_serials',
      {
        ...idColumn(Sequelize),
        ...tenantRefs(Sequelize),
        product_id: fk(Sequelize, 'products'),
        variant_id: fk(Sequelize, 'product_variants', { allowNull: true }),
        batch_id: fk(Sequelize, 'stock_batches', { allowNull: true }),
        warehouse_id: fk(Sequelize, 'warehouses', { allowNull: true }),
        serial_no: { type: Sequelize.STRING(100), allowNull: false },
        status: {
          type: Sequelize.ENUM('in_stock', 'in_transit', 'issued', 'damaged', 'scrapped', 'written_off'),
          allowNull: false,
          defaultValue: 'in_stock',
        },
        unit_cost: money(Sequelize),
        ...timestamps(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('stock_serials', ['company_id', 'product_id', 'serial_no'], {
      unique: true,
      name: 'stock_serials_product_serial_unique',
    });
    await queryInterface.addIndex('stock_serials', ['warehouse_id', 'status']);

    await queryInterface.createTable(
      'stock_movement_serials',
      {
        movement_id: { ...fk(Sequelize, 'stock_movements'), primaryKey: true },
        serial_id: { ...fk(Sequelize, 'stock_serials'), primaryKey: true },
      },
      tableOptions,
    );

    // ── Adjustments (also opening stock, damage and scrap) ─────────────────
    await queryInterface.createTable(
      'stock_adjustments',
      {
        ...idColumn(Sequelize),
        ...tenantRefs(Sequelize, { branch: true, branchRequired: true }),
        warehouse_id: fk(Sequelize, 'warehouses'),
        number: { type: Sequelize.STRING(60), allowNull: false },
        kind: { type: Sequelize.ENUM('opening', 'adjustment', 'damage', 'scrap'), allowNull: false },
        adjustment_date: { type: Sequelize.DATEONLY, allowNull: false },
        reason: { type: Sequelize.STRING(40), allowNull: true },
        status: {
          type: Sequelize.ENUM('draft', 'pending_approval', 'posted', 'rejected', 'cancelled'),
          allowNull: false,
          defaultValue: 'draft',
        },
        notes: { type: Sequelize.TEXT, allowNull: true },
        total_value: money(Sequelize, { comment: 'Signed value posted to stock' }),
        ...workflow(Sequelize),
        ...auditColumns(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('stock_adjustments', ['company_id', 'number'], {
      unique: true,
      name: 'stock_adjustments_number_unique',
    });
    await queryInterface.addIndex('stock_adjustments', ['company_id', 'kind', 'status']);

    await queryInterface.createTable(
      'stock_adjustment_items',
      {
        ...idColumn(Sequelize),
        adjustment_id: fk(Sequelize, 'stock_adjustments', { onDelete: 'CASCADE' }),
        product_id: fk(Sequelize, 'products'),
        variant_id: fk(Sequelize, 'product_variants', { allowNull: true }),
        direction: { type: Sequelize.ENUM('in', 'out'), allowNull: false },
        batch_id: fk(Sequelize, 'stock_batches', { allowNull: true }),
        batch_no: { type: Sequelize.STRING(60), allowNull: true, comment: 'New batch for stock-in lines' },
        mfg_date: { type: Sequelize.DATEONLY, allowNull: true },
        expiry_date: { type: Sequelize.DATEONLY, allowNull: true },
        unit_id: fk(Sequelize, 'units', { allowNull: true }),
        unit_factor: { type: Sequelize.DECIMAL(18, 6), allowNull: false, defaultValue: 1 },
        quantity: quantity(Sequelize),
        base_quantity: quantity(Sequelize),
        unit_cost: money(Sequelize, { comment: 'Per base unit; computed for stock-out lines when posted' }),
        total_cost: money(Sequelize),
        reason: { type: Sequelize.STRING(40), allowNull: true },
        serial_numbers: { type: Sequelize.TEXT, allowNull: true, comment: 'JSON array' },
        notes: { type: Sequelize.STRING(500), allowNull: true },
        sort_order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        ...timestamps(Sequelize),
      },
      tableOptions,
    );

    // ── Transfers ──────────────────────────────────────────────────────────
    await queryInterface.createTable(
      'stock_transfers',
      {
        ...idColumn(Sequelize),
        ...tenantRefs(Sequelize, { branch: true, branchRequired: true }),
        number: { type: Sequelize.STRING(60), allowNull: false },
        transfer_date: { type: Sequelize.DATEONLY, allowNull: false },
        from_warehouse_id: fk(Sequelize, 'warehouses'),
        to_branch_id: fk(Sequelize, 'branches'),
        to_warehouse_id: fk(Sequelize, 'warehouses'),
        status: {
          type: Sequelize.ENUM('draft', 'in_transit', 'received', 'cancelled'),
          allowNull: false,
          defaultValue: 'draft',
        },
        notes: { type: Sequelize.TEXT, allowNull: true },
        total_value: money(Sequelize),
        dispatched_by: fk(Sequelize, 'users', { allowNull: true, onDelete: 'SET NULL' }),
        dispatched_at: { type: Sequelize.DATE, allowNull: true },
        received_by: fk(Sequelize, 'users', { allowNull: true, onDelete: 'SET NULL' }),
        received_at: { type: Sequelize.DATE, allowNull: true },
        cancelled_by: fk(Sequelize, 'users', { allowNull: true, onDelete: 'SET NULL' }),
        cancelled_at: { type: Sequelize.DATE, allowNull: true },
        ...auditColumns(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('stock_transfers', ['company_id', 'number'], {
      unique: true,
      name: 'stock_transfers_number_unique',
    });
    await queryInterface.addIndex('stock_transfers', ['company_id', 'status']);
    await queryInterface.addIndex('stock_transfers', ['to_branch_id']);

    await queryInterface.createTable(
      'stock_transfer_items',
      {
        ...idColumn(Sequelize),
        transfer_id: fk(Sequelize, 'stock_transfers', { onDelete: 'CASCADE' }),
        product_id: fk(Sequelize, 'products'),
        variant_id: fk(Sequelize, 'product_variants', { allowNull: true }),
        batch_id: fk(Sequelize, 'stock_batches', { allowNull: true }),
        unit_id: fk(Sequelize, 'units', { allowNull: true }),
        unit_factor: { type: Sequelize.DECIMAL(18, 6), allowNull: false, defaultValue: 1 },
        quantity: quantity(Sequelize),
        base_quantity: quantity(Sequelize),
        unit_cost: money(Sequelize, { comment: 'Per base unit, fixed when dispatched' }),
        total_cost: money(Sequelize),
        serial_numbers: { type: Sequelize.TEXT, allowNull: true, comment: 'JSON array' },
        notes: { type: Sequelize.STRING(500), allowNull: true },
        sort_order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        ...timestamps(Sequelize),
      },
      tableOptions,
    );

    // ── Physical counts ────────────────────────────────────────────────────
    await queryInterface.createTable(
      'stock_counts',
      {
        ...idColumn(Sequelize),
        ...tenantRefs(Sequelize, { branch: true, branchRequired: true }),
        warehouse_id: fk(Sequelize, 'warehouses'),
        number: { type: Sequelize.STRING(60), allowNull: false },
        count_date: { type: Sequelize.DATEONLY, allowNull: false },
        category_id: fk(Sequelize, 'product_categories', { allowNull: true, onDelete: 'SET NULL' }),
        include_zero: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        status: {
          type: Sequelize.ENUM('counting', 'pending_approval', 'posted', 'rejected', 'cancelled'),
          allowNull: false,
          defaultValue: 'counting',
        },
        notes: { type: Sequelize.TEXT, allowNull: true },
        variance_value: money(Sequelize),
        ...workflow(Sequelize),
        ...auditColumns(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('stock_counts', ['company_id', 'number'], {
      unique: true,
      name: 'stock_counts_number_unique',
    });
    await queryInterface.addIndex('stock_counts', ['warehouse_id', 'status']);

    await queryInterface.createTable(
      'stock_count_items',
      {
        ...idColumn(Sequelize),
        count_id: fk(Sequelize, 'stock_counts', { onDelete: 'CASCADE' }),
        product_id: fk(Sequelize, 'products'),
        variant_id: fk(Sequelize, 'product_variants', { allowNull: true }),
        batch_id: fk(Sequelize, 'stock_batches', { allowNull: true }),
        system_quantity: quantity(Sequelize, { comment: 'Snapshot; refreshed when posted' }),
        counted_quantity: quantity(Sequelize, { allowNull: true, defaultValue: null }),
        variance_quantity: quantity(Sequelize),
        unit_cost: money(Sequelize),
        variance_value: money(Sequelize),
        notes: { type: Sequelize.STRING(500), allowNull: true },
        ...timestamps(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('stock_count_items', ['count_id', 'product_id']);
  },

  async down(queryInterface) {
    for (const table of [
      'stock_count_items',
      'stock_counts',
      'stock_transfer_items',
      'stock_transfers',
      'stock_adjustment_items',
      'stock_adjustments',
      'stock_movement_serials',
      'stock_serials',
      'stock_layers',
      'stock_balances',
      'stock_movements',
      'stock_batches',
    ]) {
      await queryInterface.dropTable(table);
    }
  },
};
