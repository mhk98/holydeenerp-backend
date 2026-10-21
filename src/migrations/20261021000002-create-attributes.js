'use strict';

const { idColumn, tenantRefs, fk, auditColumns, tableOptions } = require('../utils/migration.cjs');

/** Variant attributes (Size, Color…) and their values (S, M, L…). */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'product_attributes',
      {
        ...idColumn(Sequelize),
        ...tenantRefs(Sequelize),
        name: { type: Sequelize.STRING(60), allowNull: false },
        sort_order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        ...auditColumns(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('product_attributes', ['company_id', 'name']);

    await queryInterface.createTable(
      'product_attribute_values',
      {
        ...idColumn(Sequelize),
        attribute_id: fk(Sequelize, 'product_attributes', { onDelete: 'CASCADE' }),
        value: { type: Sequelize.STRING(60), allowNull: false },
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
      },
      tableOptions,
    );
    await queryInterface.addIndex('product_attribute_values', ['attribute_id', 'value'], {
      unique: true,
      name: 'product_attribute_values_unique',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('product_attribute_values');
    await queryInterface.dropTable('product_attributes');
  },
};
