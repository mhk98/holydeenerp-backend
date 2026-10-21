'use strict';

const { idColumn, tenantRefs, fk, auditColumns, tableOptions } = require('../utils/migration.cjs');

/** Product categories (nested tree via parent_id) and brands. */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'product_categories',
      {
        ...idColumn(Sequelize),
        ...tenantRefs(Sequelize),
        parent_id: fk(Sequelize, 'product_categories', { allowNull: true }),
        name: { type: Sequelize.STRING(150), allowNull: false },
        code: { type: Sequelize.STRING(30), allowNull: false },
        description: { type: Sequelize.STRING(500), allowNull: true },
        sort_order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        ...auditColumns(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('product_categories', ['company_id', 'code'], {
      unique: true,
      name: 'product_categories_company_code_unique',
    });
    await queryInterface.addIndex('product_categories', ['company_id', 'parent_id', 'sort_order']);

    await queryInterface.createTable(
      'brands',
      {
        ...idColumn(Sequelize),
        ...tenantRefs(Sequelize),
        name: { type: Sequelize.STRING(150), allowNull: false },
        code: { type: Sequelize.STRING(30), allowNull: false },
        description: { type: Sequelize.STRING(500), allowNull: true },
        logo_url: { type: Sequelize.STRING(500), allowNull: true },
        is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        ...auditColumns(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('brands', ['company_id', 'code'], {
      unique: true,
      name: 'brands_company_code_unique',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('brands');
    await queryInterface.dropTable('product_categories');
  },
};
