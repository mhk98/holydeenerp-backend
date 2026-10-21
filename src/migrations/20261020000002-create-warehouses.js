'use strict';

const { idColumn, tenantRefs, auditColumns, tableOptions } = require('../utils/migration.cjs');

/** Stock locations; every warehouse belongs to one branch. */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'warehouses',
      {
        ...idColumn(Sequelize),
        ...tenantRefs(Sequelize, { branch: true, branchRequired: true }),
        name: { type: Sequelize.STRING(150), allowNull: false },
        code: { type: Sequelize.STRING(30), allowNull: false },
        phone: { type: Sequelize.STRING(30), allowNull: true },
        address: { type: Sequelize.TEXT, allowNull: true },
        is_default: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        ...auditColumns(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('warehouses', ['company_id', 'code'], {
      unique: true,
      name: 'warehouses_company_code_unique',
    });
    await queryInterface.addIndex('warehouses', ['branch_id']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('warehouses');
  },
};
