'use strict';

const { idColumn, tenantRefs, fk, auditColumns, money, tableOptions } = require('../utils/migration.cjs');

const user = (Sequelize) => fk(Sequelize, 'users', { allowNull: true, onDelete: 'SET NULL' });
const at = (Sequelize) => ({ type: Sequelize.DATE, allowNull: true });

/**
 * Point of sale: registers (counters), cashier sessions (shifts) with cash in/out and closing count,
 * held carts. A POS sale is a posted sales invoice (channel "pos") with its money receipts; returns
 * are sales returns that can refund money from the drawer.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const create = (name, columns) => queryInterface.createTable(name, columns, tableOptions);

    await create('pos_registers', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize, { branch: true, branchRequired: true }),
      warehouse_id: fk(Sequelize, 'warehouses'),
      name: { type: Sequelize.STRING(100), allowNull: false },
      code: { type: Sequelize.STRING(30), allowNull: false },
      default_customer_id: fk(Sequelize, 'parties', { allowNull: true, onDelete: 'SET NULL' }),
      receipt_paper: {
        type: Sequelize.ENUM('thermal_80', 'a4'),
        allowNull: false,
        defaultValue: 'thermal_80',
      },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      notes: { type: Sequelize.STRING(500), allowNull: true },
      ...auditColumns(Sequelize),
    });
    await queryInterface.addIndex('pos_registers', ['company_id', 'code'], {
      unique: true,
      name: 'pos_registers_code_unique',
    });

    await create('pos_sessions', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize, { branch: true, branchRequired: true }),
      register_id: fk(Sequelize, 'pos_registers'),
      number: { type: Sequelize.STRING(60), allowNull: false, comment: 'Z report number' },
      status: { type: Sequelize.ENUM('open', 'closed'), allowNull: false, defaultValue: 'open' },
      opened_by: user(Sequelize),
      opened_at: { type: Sequelize.DATE, allowNull: false },
      opening_cash: money(Sequelize),
      opening_notes: { type: Sequelize.STRING(500), allowNull: true },
      closed_by: user(Sequelize),
      closed_at: at(Sequelize),
      expected_cash: money(Sequelize),
      counted_cash: money(Sequelize),
      variance: money(Sequelize, { comment: 'counted − expected' }),
      denominations: { type: Sequelize.TEXT, allowNull: true, comment: 'JSON { "1000": 3, … }' },
      closing_notes: { type: Sequelize.STRING(500), allowNull: true },
      summary: { type: Sequelize.TEXT('medium'), allowNull: true, comment: 'JSON Z report snapshot' },
      ...auditColumns(Sequelize),
    });
    await queryInterface.addIndex('pos_sessions', ['company_id', 'number'], {
      unique: true,
      name: 'pos_sessions_number_unique',
    });
    await queryInterface.addIndex('pos_sessions', ['register_id', 'status']);

    await create('pos_cash_movements', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize),
      session_id: fk(Sequelize, 'pos_sessions', { onDelete: 'CASCADE' }),
      type: { type: Sequelize.ENUM('in', 'out'), allowNull: false },
      amount: money(Sequelize),
      reason: { type: Sequelize.STRING(255), allowNull: false },
      ...auditColumns(Sequelize),
    });
    await queryInterface.addIndex('pos_cash_movements', ['session_id']);

    await create('pos_held_orders', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize, { branch: true, branchRequired: true }),
      register_id: fk(Sequelize, 'pos_registers'),
      label: { type: Sequelize.STRING(100), allowNull: false },
      customer_id: fk(Sequelize, 'parties', { allowNull: true, onDelete: 'SET NULL' }),
      cart: { type: Sequelize.TEXT('medium'), allowNull: false, comment: 'JSON cart' },
      total: money(Sequelize),
      ...auditColumns(Sequelize),
    });
    await queryInterface.addIndex('pos_held_orders', ['branch_id']);

    // POS columns on sales documents.
    const session = () => fk(Sequelize, 'pos_sessions', { allowNull: true, onDelete: 'SET NULL' });
    await queryInterface.addColumn('sales_invoices', 'channel', {
      type: Sequelize.ENUM('backoffice', 'pos'),
      allowNull: false,
      defaultValue: 'backoffice',
    });
    await queryInterface.addColumn('sales_invoices', 'pos_session_id', session());
    await queryInterface.addColumn('sales_invoices', 'client_uuid', {
      type: Sequelize.STRING(36),
      allowNull: true,
      comment: 'Idempotency key of a POS sale (offline sync)',
    });
    await queryInterface.addColumn('sales_invoices', 'offline_number', {
      type: Sequelize.STRING(40),
      allowNull: true,
      comment: 'Receipt number printed while offline',
    });
    await queryInterface.addColumn('sales_invoices', 'tendered', money(Sequelize));
    await queryInterface.addColumn('sales_invoices', 'change_amount', money(Sequelize));
    await queryInterface.addColumn('sales_invoices', 'stock_warning', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'Synced offline sale that took stock below zero',
    });
    await queryInterface.addIndex('sales_invoices', ['company_id', 'client_uuid'], {
      unique: true,
      name: 'sales_invoices_client_uuid_unique',
    });
    await queryInterface.addIndex('sales_invoices', ['pos_session_id']);
    await queryInterface.addColumn('customer_receipts', 'pos_session_id', session());
    await queryInterface.addIndex('customer_receipts', ['pos_session_id']);
    await queryInterface.addColumn('sales_returns', 'pos_session_id', session());
    await queryInterface.addColumn('sales_returns', 'refunded_amount', money(Sequelize));
    await queryInterface.addColumn(
      'sales_returns',
      'refund_method_id',
      fk(Sequelize, 'payment_methods', { allowNull: true, onDelete: 'SET NULL' }),
    );
    await queryInterface.addIndex('sales_returns', ['pos_session_id']);
  },

  async down(queryInterface) {
    // Foreign keys must go before their columns.
    const dropColumn = async (table, column) => {
      const [fks] = await queryInterface.sequelize.query(
        `SELECT CONSTRAINT_NAME AS name FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
        { replacements: [table, column] },
      );
      for (const fkRow of fks) await queryInterface.removeConstraint(table, fkRow.name);
      await queryInterface.removeColumn(table, column);
    };
    for (const [table, column] of [
      ['sales_returns', 'refund_method_id'],
      ['sales_returns', 'refunded_amount'],
      ['sales_returns', 'pos_session_id'],
      ['customer_receipts', 'pos_session_id'],
    ]) {
      await dropColumn(table, column);
    }
    await queryInterface.removeIndex('sales_invoices', 'sales_invoices_client_uuid_unique');
    for (const column of [
      'stock_warning',
      'change_amount',
      'tendered',
      'offline_number',
      'client_uuid',
      'pos_session_id',
      'channel',
    ]) {
      await dropColumn('sales_invoices', column);
    }
    for (const table of ['pos_held_orders', 'pos_cash_movements', 'pos_sessions', 'pos_registers']) {
      await queryInterface.dropTable(table);
    }
  },
};
