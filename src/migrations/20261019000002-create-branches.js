'use strict';

const { idColumn, auditColumns, tableOptions } = require('../utils/migration.cjs');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'branches',
      {
        ...idColumn(Sequelize),
        company_id: {
          type: Sequelize.BIGINT.UNSIGNED,
          allowNull: false,
          references: { model: 'companies', key: 'id' },
          onDelete: 'RESTRICT',
        },
        name: { type: Sequelize.STRING(150), allowNull: false },
        code: { type: Sequelize.STRING(30), allowNull: false },
        email: { type: Sequelize.STRING(191), allowNull: true },
        phone: { type: Sequelize.STRING(30), allowNull: true },
        address: { type: Sequelize.TEXT, allowNull: true },
        is_head_office: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        ...auditColumns(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('branches', ['company_id', 'code'], {
      unique: true,
      name: 'branches_company_code_unique',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('branches');
  },
};
