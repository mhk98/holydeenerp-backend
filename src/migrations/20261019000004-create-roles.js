'use strict';

const { idColumn, auditColumns, tableOptions } = require('../utils/migration.cjs');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'roles',
      {
        ...idColumn(Sequelize),
        company_id: {
          type: Sequelize.BIGINT.UNSIGNED,
          allowNull: false,
          references: { model: 'companies', key: 'id' },
          onDelete: 'RESTRICT',
        },
        name: { type: Sequelize.STRING(100), allowNull: false },
        slug: { type: Sequelize.STRING(100), allowNull: false },
        description: { type: Sequelize.STRING(255), allowNull: true },
        is_system: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        ...auditColumns(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('roles', ['company_id', 'slug'], {
      unique: true,
      name: 'roles_company_slug_unique',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('roles');
  },
};
