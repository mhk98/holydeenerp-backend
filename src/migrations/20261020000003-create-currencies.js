'use strict';

const { idColumn, tenantRefs, fk, auditColumns, tableOptions } = require('../utils/migration.cjs');

/** Currencies (one base per company) and dated exchange rates against the base. */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'currencies',
      {
        ...idColumn(Sequelize),
        ...tenantRefs(Sequelize),
        code: { type: Sequelize.CHAR(3), allowNull: false, comment: 'ISO 4217' },
        name: { type: Sequelize.STRING(100), allowNull: false },
        symbol: { type: Sequelize.STRING(10), allowNull: false },
        decimal_places: { type: Sequelize.TINYINT.UNSIGNED, allowNull: false, defaultValue: 2 },
        is_base: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        ...auditColumns(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('currencies', ['company_id', 'code'], {
      unique: true,
      name: 'currencies_company_code_unique',
    });

    await queryInterface.createTable(
      'exchange_rates',
      {
        ...idColumn(Sequelize),
        ...tenantRefs(Sequelize),
        currency_id: fk(Sequelize, 'currencies', { onDelete: 'CASCADE' }),
        rate: {
          type: Sequelize.DECIMAL(18, 6),
          allowNull: false,
          comment: '1 unit of this currency = rate × base currency',
        },
        effective_date: { type: Sequelize.DATEONLY, allowNull: false },
        ...auditColumns(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('exchange_rates', ['currency_id', 'effective_date']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('exchange_rates');
    await queryInterface.dropTable('currencies');
  },
};
