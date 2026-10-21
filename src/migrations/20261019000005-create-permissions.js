'use strict';

const { idColumn, tableOptions } = require('../utils/migration.cjs');

/** Global permission catalogue (not tenant data), so no company_id / soft delete. */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'permissions',
      {
        ...idColumn(Sequelize),
        module: { type: Sequelize.STRING(50), allowNull: false },
        action: { type: Sequelize.STRING(20), allowNull: false },
        key: { type: Sequelize.STRING(80), allowNull: false, unique: true },
        description: { type: Sequelize.STRING(255), allowNull: true },
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
    await queryInterface.dropTable('permissions');
  },
};
