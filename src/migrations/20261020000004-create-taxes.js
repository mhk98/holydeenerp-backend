'use strict';

const { idColumn, tenantRefs, fk, auditColumns, tableOptions } = require('../utils/migration.cjs');

/**
 * Tax rates (VAT, supplementary duty, …) and tax groups that combine them in order.
 * A compound rate is applied on the amount plus the taxes before it
 * (in Bangladesh VAT is charged on the SD-inclusive value).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'tax_rates',
      {
        ...idColumn(Sequelize),
        ...tenantRefs(Sequelize),
        name: { type: Sequelize.STRING(100), allowNull: false },
        code: { type: Sequelize.STRING(30), allowNull: false },
        type: { type: Sequelize.ENUM('vat', 'sd', 'ait', 'other'), allowNull: false, defaultValue: 'vat' },
        rate: { type: Sequelize.DECIMAL(9, 4), allowNull: false, comment: 'Percentage, e.g. 15.0000' },
        description: { type: Sequelize.STRING(255), allowNull: true },
        is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        ...auditColumns(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('tax_rates', ['company_id', 'code'], {
      unique: true,
      name: 'tax_rates_company_code_unique',
    });

    await queryInterface.createTable(
      'tax_groups',
      {
        ...idColumn(Sequelize),
        ...tenantRefs(Sequelize),
        name: { type: Sequelize.STRING(100), allowNull: false },
        code: { type: Sequelize.STRING(30), allowNull: false },
        description: { type: Sequelize.STRING(255), allowNull: true },
        is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        ...auditColumns(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('tax_groups', ['company_id', 'code'], {
      unique: true,
      name: 'tax_groups_company_code_unique',
    });

    await queryInterface.createTable(
      'tax_group_rates',
      {
        tax_group_id: { ...fk(Sequelize, 'tax_groups', { onDelete: 'CASCADE' }), primaryKey: true },
        tax_rate_id: { ...fk(Sequelize, 'tax_rates'), primaryKey: true },
        sequence: { type: Sequelize.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 1 },
        is_compound: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        created_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
      },
      tableOptions,
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('tax_group_rates');
    await queryInterface.dropTable('tax_groups');
    await queryInterface.dropTable('tax_rates');
  },
};
