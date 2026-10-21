'use strict';

const { idColumn, tenantRefs, fk, auditColumns, money, tableOptions } = require('../utils/migration.cjs');

/**
 * Customers and suppliers share one table ("parties"): a business that both buys from and
 * sells to us is one record with both flags set. Groups and addresses hang off it.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'party_groups',
      {
        ...idColumn(Sequelize),
        ...tenantRefs(Sequelize),
        type: { type: Sequelize.ENUM('customer', 'supplier'), allowNull: false },
        name: { type: Sequelize.STRING(100), allowNull: false },
        code: { type: Sequelize.STRING(30), allowNull: false },
        description: { type: Sequelize.STRING(255), allowNull: true },
        is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        ...auditColumns(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('party_groups', ['company_id', 'type', 'code'], {
      unique: true,
      name: 'party_groups_company_type_code_unique',
    });

    await queryInterface.createTable(
      'parties',
      {
        ...idColumn(Sequelize),
        ...tenantRefs(Sequelize),
        code: { type: Sequelize.STRING(30), allowNull: false },
        name: { type: Sequelize.STRING(200), allowNull: false },
        contact_person: { type: Sequelize.STRING(150), allowNull: true },
        phone: { type: Sequelize.STRING(30), allowNull: true },
        email: { type: Sequelize.STRING(191), allowNull: true },
        bin_no: { type: Sequelize.STRING(50), allowNull: true },
        tin_no: { type: Sequelize.STRING(50), allowNull: true },
        is_customer: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        is_supplier: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        customer_group_id: fk(Sequelize, 'party_groups', { allowNull: true }),
        supplier_group_id: fk(Sequelize, 'party_groups', { allowNull: true }),
        credit_limit: money(Sequelize, { comment: '0 = no limit' }),
        payment_terms_days: { type: Sequelize.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        opening_balance: money(Sequelize),
        opening_balance_type: {
          type: Sequelize.ENUM('debit', 'credit'),
          allowNull: false,
          defaultValue: 'debit',
        },
        notes: { type: Sequelize.TEXT, allowNull: true },
        is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        ...auditColumns(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('parties', ['company_id', 'code'], {
      unique: true,
      name: 'parties_company_code_unique',
    });
    await queryInterface.addIndex('parties', ['company_id', 'is_customer']);
    await queryInterface.addIndex('parties', ['company_id', 'is_supplier']);
    await queryInterface.addIndex('parties', ['company_id', 'phone']);

    await queryInterface.createTable(
      'party_addresses',
      {
        ...idColumn(Sequelize),
        party_id: fk(Sequelize, 'parties', { onDelete: 'CASCADE' }),
        type: {
          type: Sequelize.ENUM('billing', 'shipping', 'other'),
          allowNull: false,
          defaultValue: 'billing',
        },
        label: { type: Sequelize.STRING(60), allowNull: true },
        address_line: { type: Sequelize.STRING(500), allowNull: false },
        city: { type: Sequelize.STRING(100), allowNull: true },
        district: { type: Sequelize.STRING(100), allowNull: true },
        postal_code: { type: Sequelize.STRING(20), allowNull: true },
        country: { type: Sequelize.STRING(60), allowNull: false, defaultValue: 'Bangladesh' },
        phone: { type: Sequelize.STRING(30), allowNull: true },
        is_default: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
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
      },
      tableOptions,
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('party_addresses');
    await queryInterface.dropTable('parties');
    await queryInterface.dropTable('party_groups');
  },
};
