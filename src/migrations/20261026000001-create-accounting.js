'use strict';

const { idColumn, tenantRefs, fk, auditColumns, money, tableOptions } = require('../utils/migration.cjs');

const user = (Sequelize) => fk(Sequelize, 'users', { allowNull: true, onDelete: 'SET NULL' });
const at = (Sequelize) => ({ type: Sequelize.DATE, allowNull: true });

/**
 * Accounting (double entry): chart of accounts, fiscal years with lockable periods, journal entries
 * and their lines. Business documents post balanced journals automatically (source_type/source_id);
 * payment methods point at the cash / bank account they move money through.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const create = (name, columns) => queryInterface.createTable(name, columns, tableOptions);

    await create('accounts', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize),
      parent_id: fk(Sequelize, 'accounts', { allowNull: true }),
      code: { type: Sequelize.STRING(20), allowNull: false },
      name: { type: Sequelize.STRING(150), allowNull: false },
      name_bn: { type: Sequelize.STRING(150), allowNull: true },
      type: {
        type: Sequelize.ENUM('asset', 'liability', 'equity', 'income', 'expense'),
        allowNull: false,
      },
      subtype: { type: Sequelize.STRING(30), allowNull: false },
      is_group: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      system_key: {
        type: Sequelize.STRING(40),
        allowNull: true,
        comment: 'Default account for an automatic posting (ar, sales, cogs, …)',
      },
      is_system: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      description: { type: Sequelize.STRING(500), allowNull: true },
      ...auditColumns(Sequelize),
    });
    await queryInterface.addIndex('accounts', ['company_id', 'code'], {
      unique: true,
      name: 'accounts_code_unique',
    });
    await queryInterface.addIndex('accounts', ['company_id', 'system_key'], {
      unique: true,
      name: 'accounts_system_key_unique',
    });
    await queryInterface.addIndex('accounts', ['parent_id']);

    await create('fiscal_years', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize),
      name: { type: Sequelize.STRING(60), allowNull: false },
      start_date: { type: Sequelize.DATEONLY, allowNull: false },
      end_date: { type: Sequelize.DATEONLY, allowNull: false },
      status: { type: Sequelize.ENUM('open', 'closed'), allowNull: false, defaultValue: 'open' },
      closing_journal_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: true },
      closed_by: user(Sequelize),
      closed_at: at(Sequelize),
      ...auditColumns(Sequelize),
    });
    await queryInterface.addIndex('fiscal_years', ['company_id', 'start_date']);

    await create('fiscal_periods', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize),
      fiscal_year_id: fk(Sequelize, 'fiscal_years', { onDelete: 'CASCADE' }),
      name: { type: Sequelize.STRING(40), allowNull: false },
      start_date: { type: Sequelize.DATEONLY, allowNull: false },
      end_date: { type: Sequelize.DATEONLY, allowNull: false },
      status: { type: Sequelize.ENUM('open', 'locked'), allowNull: false, defaultValue: 'open' },
      locked_by: user(Sequelize),
      locked_at: at(Sequelize),
      ...auditColumns(Sequelize),
    });
    await queryInterface.addIndex('fiscal_periods', ['company_id', 'start_date', 'end_date']);
    await queryInterface.addIndex('fiscal_periods', ['fiscal_year_id']);

    await create('journal_entries', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize, { branch: true }),
      number: { type: Sequelize.STRING(60), allowNull: false },
      entry_date: { type: Sequelize.DATEONLY, allowNull: false },
      entry_type: {
        type: Sequelize.ENUM('manual', 'auto', 'opening', 'closing', 'reversal'),
        allowNull: false,
        defaultValue: 'manual',
      },
      status: { type: Sequelize.ENUM('draft', 'posted'), allowNull: false, defaultValue: 'draft' },
      source_type: {
        type: Sequelize.STRING(40),
        allowNull: true,
        comment: 'sales_invoice, goods_receipt, …',
      },
      source_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: true },
      source_no: { type: Sequelize.STRING(60), allowNull: true },
      event: { type: Sequelize.STRING(40), allowNull: true, comment: 'post, refund, stock:sale, …' },
      reference: { type: Sequelize.STRING(100), allowNull: true },
      narration: { type: Sequelize.STRING(500), allowNull: true },
      total_debit: money(Sequelize),
      total_credit: money(Sequelize),
      reversal_of_id: fk(Sequelize, 'journal_entries', { allowNull: true, onDelete: 'SET NULL' }),
      reversed_by_id: fk(Sequelize, 'journal_entries', { allowNull: true, onDelete: 'SET NULL' }),
      posted_by: user(Sequelize),
      posted_at: at(Sequelize),
      ...auditColumns(Sequelize),
    });
    await queryInterface.addIndex('journal_entries', ['company_id', 'number'], {
      unique: true,
      name: 'journal_entries_number_unique',
    });
    await queryInterface.addIndex('journal_entries', ['company_id', 'entry_date']);
    await queryInterface.addIndex('journal_entries', ['company_id', 'source_type', 'source_id']);
    await queryInterface.addIndex('journal_entries', ['company_id', 'status']);

    await create('journal_lines', {
      ...idColumn(Sequelize),
      company_id: fk(Sequelize, 'companies'),
      journal_id: fk(Sequelize, 'journal_entries', { onDelete: 'CASCADE' }),
      branch_id: fk(Sequelize, 'branches', { allowNull: true, onDelete: 'SET NULL' }),
      account_id: fk(Sequelize, 'accounts'),
      party_id: fk(Sequelize, 'parties', { allowNull: true, onDelete: 'SET NULL' }),
      debit: money(Sequelize),
      credit: money(Sequelize),
      description: { type: Sequelize.STRING(255), allowNull: true },
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
    await queryInterface.addIndex('journal_lines', ['journal_id']);
    await queryInterface.addIndex('journal_lines', ['company_id', 'account_id']);
    await queryInterface.addIndex('journal_lines', ['party_id']);

    await queryInterface.addColumn(
      'payment_methods',
      'account_id',
      fk(Sequelize, 'accounts', { allowNull: true, onDelete: 'SET NULL' }),
    );
  },

  async down(queryInterface) {
    const [fks] = await queryInterface.sequelize.query(
      `SELECT CONSTRAINT_NAME AS name FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_methods' AND COLUMN_NAME = 'account_id'
          AND REFERENCED_TABLE_NAME IS NOT NULL`,
    );
    for (const row of fks) await queryInterface.removeConstraint('payment_methods', row.name);
    await queryInterface.removeColumn('payment_methods', 'account_id');
    for (const table of ['journal_lines', 'journal_entries', 'fiscal_periods', 'fiscal_years', 'accounts']) {
      await queryInterface.dropTable(table);
    }
  },
};
