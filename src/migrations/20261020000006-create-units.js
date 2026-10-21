'use strict';

const { idColumn, tenantRefs, fk, auditColumns, tableOptions } = require('../utils/migration.cjs');

/** Units of measure and company-wide conversions (1 from_unit = factor × to_unit). */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'units',
      {
        ...idColumn(Sequelize),
        ...tenantRefs(Sequelize),
        name: { type: Sequelize.STRING(60), allowNull: false },
        code: { type: Sequelize.STRING(20), allowNull: false },
        category: {
          type: Sequelize.ENUM('count', 'weight', 'volume', 'length', 'area', 'time', 'other'),
          allowNull: false,
          defaultValue: 'count',
        },
        allow_decimal: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        ...auditColumns(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('units', ['company_id', 'code'], {
      unique: true,
      name: 'units_company_code_unique',
    });

    await queryInterface.createTable(
      'unit_conversions',
      {
        ...idColumn(Sequelize),
        ...tenantRefs(Sequelize),
        from_unit_id: fk(Sequelize, 'units', { onDelete: 'CASCADE' }),
        to_unit_id: fk(Sequelize, 'units', { onDelete: 'CASCADE' }),
        factor: { type: Sequelize.DECIMAL(18, 6), allowNull: false },
        ...auditColumns(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('unit_conversions', ['from_unit_id', 'to_unit_id'], {
      unique: true,
      name: 'unit_conversions_pair_unique',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('unit_conversions');
    await queryInterface.dropTable('units');
  },
};
