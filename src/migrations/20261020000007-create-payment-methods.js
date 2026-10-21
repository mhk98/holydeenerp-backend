'use strict';

const { idColumn, tenantRefs, auditColumns, tableOptions } = require('../utils/migration.cjs');

/** How customers pay / how we pay suppliers (cash, card, bKash, Nagad, bank, cheque…). */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'payment_methods',
      {
        ...idColumn(Sequelize),
        ...tenantRefs(Sequelize),
        name: { type: Sequelize.STRING(100), allowNull: false },
        code: { type: Sequelize.STRING(30), allowNull: false },
        type: {
          type: Sequelize.ENUM('cash', 'card', 'mobile_wallet', 'bank_transfer', 'cheque', 'other'),
          allowNull: false,
        },
        provider: { type: Sequelize.STRING(60), allowNull: true, comment: 'bKash, Nagad, Visa, DBBL…' },
        account_number: { type: Sequelize.STRING(60), allowNull: true, comment: 'Merchant / bank account' },
        requires_reference: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        sort_order: { type: Sequelize.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        ...auditColumns(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('payment_methods', ['company_id', 'code'], {
      unique: true,
      name: 'payment_methods_company_code_unique',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('payment_methods');
  },
};
