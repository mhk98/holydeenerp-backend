'use strict';

const { idColumn, tenantRefs, fk, auditColumns, money, tableOptions } = require('../utils/migration.cjs');

const user = (Sequelize) => fk(Sequelize, 'users', { allowNull: true, onDelete: 'SET NULL' });
const at = (Sequelize) => ({ type: Sequelize.DATE, allowNull: true });
const workflow = (Sequelize, ...names) =>
  Object.fromEntries(
    names.flatMap((n) => [
      [`${n}_by`, user(Sequelize)],
      [`${n}_at`, at(Sequelize)],
    ]),
  );

/**
 * Cash & bank: money accounts (each backed by a ledger account), receipt / payment / contra vouchers,
 * the cheque register, bank reconciliations with imported statement lines, expenses with categories,
 * and file attachments. Journal lines remember the reconciliation that cleared them.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const create = (name, columns) => queryInterface.createTable(name, columns, tableOptions);
    const status = (values, defaultValue) => ({
      type: Sequelize.ENUM(...values),
      allowNull: false,
      defaultValue,
    });

    await create('bank_accounts', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize, { branch: true }),
      account_id: fk(Sequelize, 'accounts'),
      kind: { type: Sequelize.ENUM('cash', 'bank', 'mobile_wallet'), allowNull: false },
      name: { type: Sequelize.STRING(150), allowNull: false },
      bank_name: { type: Sequelize.STRING(150), allowNull: true },
      branch_name: { type: Sequelize.STRING(150), allowNull: true },
      account_number: { type: Sequelize.STRING(60), allowNull: true },
      routing_number: { type: Sequelize.STRING(30), allowNull: true },
      statement_mapping: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: 'JSON column mapping of statement files',
      },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      notes: { type: Sequelize.STRING(500), allowNull: true },
      ...auditColumns(Sequelize),
    });
    await queryInterface.addIndex('bank_accounts', ['company_id', 'account_id'], {
      unique: true,
      name: 'bank_accounts_account_unique',
    });

    await create('vouchers', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize, { branch: true, branchRequired: true }),
      number: { type: Sequelize.STRING(60), allowNull: false },
      voucher_type: { type: Sequelize.ENUM('receipt', 'payment', 'contra'), allowNull: false },
      voucher_date: { type: Sequelize.DATEONLY, allowNull: false },
      bank_account_id: fk(Sequelize, 'bank_accounts'),
      to_bank_account_id: fk(Sequelize, 'bank_accounts', { allowNull: true }),
      party_name: { type: Sequelize.STRING(150), allowNull: true },
      reference: { type: Sequelize.STRING(100), allowNull: true },
      narration: { type: Sequelize.STRING(500), allowNull: true },
      amount: money(Sequelize),
      status: status(['draft', 'posted', 'void'], 'draft'),
      ...workflow(Sequelize, 'posted', 'voided'),
      void_reason: { type: Sequelize.STRING(500), allowNull: true },
      ...auditColumns(Sequelize),
    });
    await queryInterface.addIndex('vouchers', ['company_id', 'number'], {
      unique: true,
      name: 'vouchers_number_unique',
    });
    await queryInterface.addIndex('vouchers', ['company_id', 'voucher_date']);

    await create('voucher_lines', {
      ...idColumn(Sequelize),
      voucher_id: fk(Sequelize, 'vouchers', { onDelete: 'CASCADE' }),
      account_id: fk(Sequelize, 'accounts'),
      description: { type: Sequelize.STRING(255), allowNull: true },
      amount: money(Sequelize),
      sort_order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
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
    await queryInterface.addIndex('voucher_lines', ['voucher_id']);

    await create('cheques', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize, { branch: true }),
      direction: { type: Sequelize.ENUM('received', 'issued'), allowNull: false },
      cheque_no: { type: Sequelize.STRING(60), allowNull: false },
      bank_name: { type: Sequelize.STRING(150), allowNull: true },
      cheque_date: { type: Sequelize.DATEONLY, allowNull: true },
      amount: money(Sequelize),
      party_id: fk(Sequelize, 'parties', { allowNull: true, onDelete: 'SET NULL' }),
      status: {
        type: Sequelize.ENUM('in_hand', 'deposited', 'issued', 'cleared', 'bounced', 'cancelled'),
        allowNull: false,
      },
      source_type: { type: Sequelize.STRING(40), allowNull: false },
      source_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false },
      source_no: { type: Sequelize.STRING(60), allowNull: true },
      deposit_bank_account_id: fk(Sequelize, 'bank_accounts', { allowNull: true, onDelete: 'SET NULL' }),
      deposited_at: { type: Sequelize.DATEONLY, allowNull: true },
      cleared_at: { type: Sequelize.DATEONLY, allowNull: true },
      bounced_at: { type: Sequelize.DATEONLY, allowNull: true },
      bounce_reason: { type: Sequelize.STRING(500), allowNull: true },
      notes: { type: Sequelize.STRING(500), allowNull: true },
      ...auditColumns(Sequelize),
    });
    await queryInterface.addIndex('cheques', ['company_id', 'source_type', 'source_id'], {
      unique: true,
      name: 'cheques_source_unique',
    });
    await queryInterface.addIndex('cheques', ['company_id', 'status']);

    await create('bank_reconciliations', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize),
      bank_account_id: fk(Sequelize, 'bank_accounts'),
      statement_date: { type: Sequelize.DATEONLY, allowNull: false },
      statement_balance: money(Sequelize),
      opening_balance: money(Sequelize, {
        comment: 'Statement balance of the previous completed reconciliation',
      }),
      status: status(['in_progress', 'completed'], 'in_progress'),
      ...workflow(Sequelize, 'completed'),
      notes: { type: Sequelize.STRING(500), allowNull: true },
      ...auditColumns(Sequelize),
    });
    await queryInterface.addIndex('bank_reconciliations', ['bank_account_id', 'statement_date']);

    await create('bank_statement_lines', {
      ...idColumn(Sequelize),
      reconciliation_id: fk(Sequelize, 'bank_reconciliations', { onDelete: 'CASCADE' }),
      line_date: { type: Sequelize.DATEONLY, allowNull: false },
      description: { type: Sequelize.STRING(255), allowNull: true },
      reference: { type: Sequelize.STRING(100), allowNull: true },
      amount: money(Sequelize, { comment: '+ deposit, − withdrawal' }),
      journal_line_id: fk(Sequelize, 'journal_lines', { allowNull: true, onDelete: 'SET NULL' }),
      sort_order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
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
    await queryInterface.addIndex('bank_statement_lines', ['reconciliation_id']);

    await queryInterface.addColumn(
      'journal_lines',
      'reconciliation_id',
      fk(Sequelize, 'bank_reconciliations', { allowNull: true, onDelete: 'SET NULL' }),
    );
    await queryInterface.addColumn('journal_lines', 'cleared_date', {
      type: Sequelize.DATEONLY,
      allowNull: true,
    });

    await create('expense_categories', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize),
      name: { type: Sequelize.STRING(150), allowNull: false },
      code: { type: Sequelize.STRING(30), allowNull: false },
      account_id: fk(Sequelize, 'accounts'),
      description: { type: Sequelize.STRING(500), allowNull: true },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      ...auditColumns(Sequelize),
    });
    await queryInterface.addIndex('expense_categories', ['company_id', 'code'], {
      unique: true,
      name: 'expense_categories_code_unique',
    });

    await create('expenses', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize, { branch: true, branchRequired: true }),
      number: { type: Sequelize.STRING(60), allowNull: false },
      expense_date: { type: Sequelize.DATEONLY, allowNull: false },
      category_id: fk(Sequelize, 'expense_categories'),
      bank_account_id: fk(Sequelize, 'bank_accounts'),
      payee: { type: Sequelize.STRING(150), allowNull: true },
      reference: { type: Sequelize.STRING(100), allowNull: true },
      description: { type: Sequelize.STRING(500), allowNull: true },
      amount: money(Sequelize),
      tax_amount: money(Sequelize),
      total: money(Sequelize),
      status: status(['draft', 'posted', 'void'], 'draft'),
      ...workflow(Sequelize, 'posted', 'voided'),
      void_reason: { type: Sequelize.STRING(500), allowNull: true },
      ...auditColumns(Sequelize),
    });
    await queryInterface.addIndex('expenses', ['company_id', 'number'], {
      unique: true,
      name: 'expenses_number_unique',
    });
    await queryInterface.addIndex('expenses', ['company_id', 'expense_date']);

    await create('attachments', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize),
      entity_type: { type: Sequelize.STRING(40), allowNull: false },
      entity_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false },
      original_name: { type: Sequelize.STRING(255), allowNull: false },
      stored_name: { type: Sequelize.STRING(120), allowNull: false },
      mime_type: { type: Sequelize.STRING(100), allowNull: false },
      size: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      ...auditColumns(Sequelize),
    });
    await queryInterface.addIndex('attachments', ['company_id', 'entity_type', 'entity_id']);
  },

  async down(queryInterface) {
    const [fks] = await queryInterface.sequelize.query(
      `SELECT CONSTRAINT_NAME AS name FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'journal_lines' AND COLUMN_NAME = 'reconciliation_id'
          AND REFERENCED_TABLE_NAME IS NOT NULL`,
    );
    for (const row of fks) await queryInterface.removeConstraint('journal_lines', row.name);
    await queryInterface.removeColumn('journal_lines', 'reconciliation_id');
    await queryInterface.removeColumn('journal_lines', 'cleared_date');
    for (const table of [
      'attachments',
      'expenses',
      'expense_categories',
      'bank_statement_lines',
      'bank_reconciliations',
      'cheques',
      'voucher_lines',
      'vouchers',
      'bank_accounts',
    ]) {
      await queryInterface.dropTable(table);
    }
  },
};
